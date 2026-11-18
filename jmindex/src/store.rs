//! 数据库（SQLite，一个文件）：索引的全部内容都在这里。
//!
//!   files       文件：路径、语言、种类（code、doc、config）、内容哈希（增量摄取靠它）、AI 摘要
//!   symbols     声明（代码的函数、类……，文档的标题）
//!   refs        引用原样（调用、回调），graph.rs 解析成边
//!   imports     导入原样
//!   mentions    文字里提到的文件、代码名、链接
//!   chunks      正文块；chunks_fts 是它的全文索引（FTS5，rowid 就是块 ID，正文先经 text::to_fts 处理）
//!   tags        AI 给的标签（原样）；tag_alias 是 AI 整合后的“别名 → 标准名”
//!   edges       关系图谱：每次摄取完从上面几张表重新算（graph.rs）
//!
//! 节点 ID 的写法：file:路径、sym:路径#全名、tag:标签、pkg:包名。

use crate::doc::{Chunk, Mention};
use crate::parse::{Import, Ref, Symbol};
use crate::text;
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::collections::HashMap;
use std::path::Path;

/// 建表语句。
const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  summary TEXT,
  tagged_hash TEXT
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qname TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE TABLE IF NOT EXISTS refs (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  from_qname TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_file ON refs(file_id);
CREATE TABLE IF NOT EXISTS imports (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  spec TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mentions (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(body, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS tags (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS tag_alias (
  alias TEXT PRIMARY KEY,
  canonical TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL,
  count INTEGER NOT NULL,
  lines TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
"#;

/// AI 摘要块的标题（chunks 里 start_line = 0 的那一块）。
pub const AI_CHUNK_TITLE: &str = "AI 摘要";

/// 摄取一个文件要写的全部东西。
#[derive(Debug, Default)]
pub struct FileData {
    pub path: String,
    pub lang: String,
    pub kind: String,
    pub hash: String,
    pub size: i64,
    pub lines: i64,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Ref>,
    pub imports: Vec<Import>,
    pub mentions: Vec<Mention>,
    pub chunks: Vec<Chunk>,
}

/// 一个文件的基本信息。
#[derive(Debug, Clone)]
pub struct FileRow {
    pub id: i64,
    pub path: String,
    pub lang: String,
    pub kind: String,
    pub hash: String,
    pub summary: Option<String>,
    pub tagged_hash: Option<String>,
}

/// 打开的数据库。
pub struct Store {
    pub conn: Connection,
}

impl Store {
    /// 打开（没有就建）。
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("建目录 {} 失败", dir.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("打开数据库 {} 失败", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.execute_batch(SCHEMA).context("建表失败")?;
        Ok(Store { conn })
    }

    /// 全部文件。
    pub fn files(&self) -> Result<Vec<FileRow>> {
        let mut statement = self.conn.prepare("SELECT id, path, lang, kind, hash, summary, tagged_hash FROM files ORDER BY path")?;
        let rows = statement.query_map([], |row| {
            Ok(FileRow {
                id: row.get(0)?,
                path: row.get(1)?,
                lang: row.get(2)?,
                kind: row.get(3)?,
                hash: row.get(4)?,
                summary: row.get(5)?,
                tagged_hash: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 按路径找文件。
    pub fn file_by_path(&self, path: &str) -> Result<Option<FileRow>> {
        Ok(self.files()?.into_iter().find(|file| file.path == path))
    }

    /// 写入（或替换）一个文件：文件行留着 AI 摘要和标签，其余全部换新。
    pub fn replace_file(&mut self, data: &FileData) -> Result<i64> {
        let tx = self.conn.transaction()?;
        let existing: Option<i64> = tx.query_row("SELECT id FROM files WHERE path = ?1", [&data.path], |row| row.get(0)).optional()?;
        let file_id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE files SET lang = ?2, kind = ?3, hash = ?4, size = ?5, lines = ?6 WHERE id = ?1",
                    params![id, data.lang, data.kind, data.hash, data.size, data.lines],
                )?;
                clear_children(&tx, id)?;
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO files (path, lang, kind, hash, size, lines) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![data.path, data.lang, data.kind, data.hash, data.size, data.lines],
                )?;
                tx.last_insert_rowid()
            }
        };
        {
            let mut insert = tx.prepare_cached("INSERT INTO symbols (file_id, name, qname, kind, line, end_line) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
            for symbol in &data.symbols {
                insert.execute(params![file_id, symbol.name, symbol.qname, symbol.kind, symbol.line, symbol.end_line])?;
            }
            let mut insert = tx.prepare_cached("INSERT INTO refs (file_id, from_qname, name, kind, line) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for reference in &data.refs {
                insert.execute(params![file_id, reference.from, reference.name, reference.kind, reference.line])?;
            }
            let mut insert = tx.prepare_cached("INSERT INTO imports (file_id, spec, line) VALUES (?1, ?2, ?3)")?;
            for import in &data.imports {
                insert.execute(params![file_id, import.spec, import.line])?;
            }
            let mut insert = tx.prepare_cached("INSERT INTO mentions (file_id, kind, target, line) VALUES (?1, ?2, ?3, ?4)")?;
            for mention in &data.mentions {
                insert.execute(params![file_id, mention.kind, mention.target, mention.line])?;
            }
            for chunk in &data.chunks {
                insert_chunk(&tx, file_id, chunk, &data.path)?;
            }
        }
        refresh_ai_chunk(&tx, file_id)?;
        tx.commit()?;
        Ok(file_id)
    }

    /// 删掉一个文件和它的全部内容。
    pub fn remove_file(&mut self, file_id: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        clear_children(&tx, file_id)?;
        tx.execute("DELETE FROM tags WHERE file_id = ?1", [file_id])?;
        tx.execute("DELETE FROM files WHERE id = ?1", [file_id])?;
        tx.commit()?;
        Ok(())
    }

    /// 写 AI 的摘要和标签，记下是按哪个版本（哈希）打的。
    pub fn set_ai(&mut self, file_id: i64, summary: &str, tags: &[String], hash: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("UPDATE files SET summary = ?2, tagged_hash = ?3 WHERE id = ?1", params![file_id, summary, hash])?;
        tx.execute("DELETE FROM tags WHERE file_id = ?1", [file_id])?;
        for tag in tags {
            tx.execute("INSERT OR IGNORE INTO tags (file_id, tag) VALUES (?1, ?2)", params![file_id, tag])?;
        }
        refresh_ai_chunk(&tx, file_id)?;
        tx.commit()?;
        Ok(())
    }

    /// 一个文件的标签（换成标准名，去重）。
    pub fn tags_of(&self, file_id: i64, aliases: &HashMap<String, String>) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare_cached("SELECT tag FROM tags WHERE file_id = ?1 ORDER BY rowid")?;
        let raw: Vec<String> = statement.query_map([file_id], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        let mut result: Vec<String> = Vec::new();
        for tag in raw {
            let canonical = aliases.get(&tag).cloned().unwrap_or(tag);
            if !result.contains(&canonical) {
                result.push(canonical);
            }
        }
        Ok(result)
    }

    /// 别名表：别名 → 标准名。
    pub fn aliases(&self) -> Result<HashMap<String, String>> {
        let mut statement = self.conn.prepare("SELECT alias, canonical FROM tag_alias")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 标签词表：标准名和用到它的文件数，多的在前。
    pub fn tag_vocabulary(&self, limit: usize) -> Result<Vec<(String, i64)>> {
        let aliases = self.aliases()?;
        let mut statement = self.conn.prepare("SELECT tag, COUNT(*) FROM tags GROUP BY tag")?;
        let rows: Vec<(String, i64)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut counts: HashMap<String, i64> = HashMap::new();
        for (tag, count) in rows {
            let canonical = aliases.get(&tag).cloned().unwrap_or(tag);
            *counts.entry(canonical).or_default() += count;
        }
        let mut list: Vec<(String, i64)> = counts.into_iter().collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        list.truncate(limit);
        Ok(list)
    }

    /// 写整合结果：标准名 → 别名们。返回新写了几条别名。
    pub fn set_aliases(&mut self, groups: &[(String, Vec<String>)]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut written = 0;
        for (canonical, aliases) in groups {
            // 标准名自己如果原来是别人的别名，先去掉，免得绕圈。
            tx.execute("DELETE FROM tag_alias WHERE alias = ?1", [canonical])?;
            for alias in aliases {
                if alias == canonical {
                    continue;
                }
                tx.execute("INSERT OR REPLACE INTO tag_alias (alias, canonical) VALUES (?1, ?2)", params![alias, canonical])?;
                tx.execute("UPDATE tag_alias SET canonical = ?2 WHERE canonical = ?1", params![alias, canonical])?;
                written += 1;
            }
        }
        // 每个文件的 AI 块里的标签换成新的标准名。
        let ids: Vec<i64> = tx.prepare("SELECT DISTINCT file_id FROM tags")?.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        for id in ids {
            refresh_ai_chunk(&tx, id)?;
        }
        tx.commit()?;
        Ok(written)
    }

    /// 一个文件的声明名（给 AI 看）。
    pub fn symbol_names(&self, file_id: i64, limit: usize) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare_cached("SELECT qname FROM symbols WHERE file_id = ?1 ORDER BY line LIMIT ?2")?;
        let rows = statement.query_map(params![file_id, limit as i64], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 文件、声明、边、标签各有多少。
    pub fn counts(&self) -> Result<serde_json::Value> {
        let count = |sql: &str| -> Result<i64> { Ok(self.conn.query_row(sql, [], |row| row.get(0))?) };
        Ok(serde_json::json!({
            "files": count("SELECT COUNT(*) FROM files")?,
            "symbols": count("SELECT COUNT(*) FROM symbols")?,
            "chunks": count("SELECT COUNT(*) FROM chunks")?,
            "edges": count("SELECT COUNT(*) FROM edges")?,
            "tags": count("SELECT COUNT(DISTINCT tag) FROM tags")?,
            "tagged_files": count("SELECT COUNT(*) FROM files WHERE tagged_hash IS NOT NULL")?,
        }))
    }
}

/// 删掉一个文件的声明、引用、导入、提及、正文块（含全文索引）。
fn clear_children(tx: &Transaction, file_id: i64) -> Result<()> {
    tx.execute("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?1)", [file_id])?;
    for table in ["chunks", "symbols", "refs", "imports", "mentions"] {
        tx.execute(&format!("DELETE FROM {table} WHERE file_id = ?1"), [file_id])?;
    }
    Ok(())
}

/// 写一块正文和它的全文索引。路径和标题也进索引，搜文件名、标题也能命中。
fn insert_chunk(tx: &Transaction, file_id: i64, chunk: &Chunk, path: &str) -> Result<()> {
    tx.prepare_cached("INSERT INTO chunks (file_id, start_line, end_line, title, text) VALUES (?1, ?2, ?3, ?4, ?5)")?.execute(params![
        file_id,
        chunk.start_line,
        chunk.end_line,
        chunk.title,
        chunk.text
    ])?;
    let id = tx.last_insert_rowid();
    let body = text::to_fts(&format!("{path}\n{}\n{}", chunk.title, chunk.text));
    tx.prepare_cached("INSERT INTO chunks_fts (rowid, body) VALUES (?1, ?2)")?.execute(params![id, body])?;
    Ok(())
}

/// 重写一个文件的 AI 摘要块：摘要和标签（标准名）进全文索引。
fn refresh_ai_chunk(tx: &Transaction, file_id: i64) -> Result<()> {
    tx.execute(
        "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?1 AND start_line = 0 AND title = ?2)",
        params![file_id, AI_CHUNK_TITLE],
    )?;
    tx.execute("DELETE FROM chunks WHERE file_id = ?1 AND start_line = 0 AND title = ?2", params![file_id, AI_CHUNK_TITLE])?;
    let (path, summary): (String, Option<String>) =
        tx.query_row("SELECT path, summary FROM files WHERE id = ?1", [file_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let tags: Vec<String> = tx
        .prepare_cached("SELECT COALESCE(a.canonical, t.tag) FROM tags t LEFT JOIN tag_alias a ON a.alias = t.tag WHERE t.file_id = ?1")?
        .query_map([file_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let summary = summary.unwrap_or_default();
    if summary.is_empty() && tags.is_empty() {
        return Ok(());
    }
    let text = format!("{summary}\n标签：{}", tags.join("、"));
    insert_chunk(tx, file_id, &Chunk { start_line: 0, end_line: 0, title: AI_CHUNK_TITLE.into(), text }, &path)
}
