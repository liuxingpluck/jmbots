//! 数据库（SQLite，一个文件）：索引的全部内容都在这里。
//!
//!   files       文件：路径、语言、种类（code、doc、config）、内容哈希（增量摄取靠它）、AI 摘要
//!   symbols     声明（代码的函数、类……，文档的标题）
//!   refs        引用原样（调用、回调），graph/build.rs 解析成边
//!   imports     导入原样
//!   mentions    文字里提到的文件、代码名、链接
//!   chunks      正文块；chunks_fts 是它的全文索引（FTS5，rowid 就是块 ID，正文先经 text::to_fts 处理）
//!   tags        AI 给的标签（原样）；tag_alias 是 AI 整合后的“别名 → 标准名”
//!   edges       关系图谱：每次摄取完从上面几张表重新算（graph/build.rs）
//!   meta        库自己的信息（键值）：root 是被索引的目录（摄取时写，多库搜索时拼绝对路径用）
//!   chunk_vectors  每块正文的向量（配了嵌入模型才有；model 记着是哪个模型算的，f32 小端字节）；块删了跟着删
//!
//! 节点 ID 的写法：file:路径、sym:路径#全名、tag:标签、pkg:包名。
//!
//! 规矩（2026-11-04 框架设计第 8 节第 1 步）：SQL 只写在这个文件里。graph、search、ingest 要什么数据，
//! 就在这里加一个按用途起名的函数；连接 conn 不对外，表结构只在一个地方。

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
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  vector BLOB NOT NULL
);
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

/// 打开的数据库。连接不对外：要什么数据就调下面按用途起名的函数。
pub struct Store {
    conn: Connection,
}

/// 一个声明（算边用）。
#[derive(Debug, Clone)]
pub struct SymbolRow {
    pub file_id: i64,
    pub name: String,
    pub qname: String,
    pub kind: String,
}

/// 一条导入原样（算边用）。
#[derive(Debug, Clone)]
pub struct ImportRow {
    pub file_id: i64,
    pub spec: String,
    pub line: i64,
}

/// 一条引用原样（算边用）。
#[derive(Debug, Clone)]
pub struct RefRow {
    pub file_id: i64,
    /// 在哪个声明里引用的；文件顶层是 None。
    pub from: Option<String>,
    pub name: String,
    pub kind: String,
    pub line: i64,
}

/// 一条提及原样（算边用）。
#[derive(Debug, Clone)]
pub struct MentionRow {
    pub file_id: i64,
    pub kind: String,
    pub target: String,
    pub line: i64,
}

/// 一条边：写库和读库都用它。lines 是逗号隔开的行号。
#[derive(Debug, Clone)]
pub struct EdgeRow {
    pub src: String,
    pub dst: String,
    pub kind: String,
    pub weight: f64,
    pub count: i64,
    pub lines: String,
}

/// 搜索要的文件信息。
#[derive(Debug, Clone)]
pub struct FileMeta {
    pub path: String,
    pub lang: String,
    pub kind: String,
    pub summary: Option<String>,
}

/// 一块正文。
#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub start_line: i64,
    pub end_line: i64,
    pub title: String,
    pub text: String,
}

/// 名字对上了的一个声明（搜索用）。
#[derive(Debug, Clone)]
pub struct SymbolMatch {
    pub file_id: i64,
    pub qname: String,
    pub kind: String,
    pub line: i64,
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
        Ok(self
            .conn
            .query_row("SELECT id, path, lang, kind, hash, summary, tagged_hash FROM files WHERE path = ?1", [path], |row| {
                Ok(FileRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    lang: row.get(2)?,
                    kind: row.get(3)?,
                    hash: row.get(4)?,
                    summary: row.get(5)?,
                    tagged_hash: row.get(6)?,
                })
            })
            .optional()?)
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

    // ───────── 库自己的信息（meta 表）─────────

    /// 写一项库信息。
    pub fn set_meta(&mut self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, value])?;
        Ok(())
    }

    /// 读一项库信息；没写过是 None。
    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0)).optional()?)
    }

    // ───────── 算边要的原始记录（graph::rebuild）─────────

    /// 全部声明。
    pub fn all_symbols(&self) -> Result<Vec<SymbolRow>> {
        let mut statement = self.conn.prepare("SELECT file_id, name, qname, kind FROM symbols")?;
        let rows = statement.query_map([], |row| Ok(SymbolRow { file_id: row.get(0)?, name: row.get(1)?, qname: row.get(2)?, kind: row.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 全部导入原样。
    pub fn all_imports(&self) -> Result<Vec<ImportRow>> {
        let mut statement = self.conn.prepare("SELECT file_id, spec, line FROM imports")?;
        let rows = statement.query_map([], |row| Ok(ImportRow { file_id: row.get(0)?, spec: row.get(1)?, line: row.get(2)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 全部引用原样。
    pub fn all_refs(&self) -> Result<Vec<RefRow>> {
        let mut statement = self.conn.prepare("SELECT file_id, from_qname, name, kind, line FROM refs")?;
        let rows = statement.query_map([], |row| {
            Ok(RefRow { file_id: row.get(0)?, from: row.get(1)?, name: row.get(2)?, kind: row.get(3)?, line: row.get(4)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 全部提及原样。
    pub fn all_mentions(&self) -> Result<Vec<MentionRow>> {
        let mut statement = self.conn.prepare("SELECT file_id, kind, target, line FROM mentions")?;
        let rows = statement.query_map([], |row| Ok(MentionRow { file_id: row.get(0)?, kind: row.get(1)?, target: row.get(2)?, line: row.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 全部标签原样：(文件 ID, 标签)。
    pub fn all_tags(&self) -> Result<Vec<(i64, String)>> {
        let mut statement = self.conn.prepare("SELECT file_id, tag FROM tags")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 整张图换成新的边。几十万条边时，先删索引、写完再建，比边写边维护索引快好几倍。
    pub fn replace_edges(&mut self, edges: &[EdgeRow]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("DROP INDEX IF EXISTS edges_src; DROP INDEX IF EXISTS edges_dst; DELETE FROM edges;")?;
        {
            let mut insert = tx.prepare("INSERT INTO edges (src, dst, kind, weight, count, lines) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
            for edge in edges {
                insert.execute(params![edge.src, edge.dst, edge.kind, edge.weight, edge.count, edge.lines])?;
            }
        }
        tx.execute_batch("CREATE INDEX edges_src ON edges(src); CREATE INDEX edges_dst ON edges(dst);")?;
        tx.commit()?;
        Ok(())
    }

    /// 全部边（导出整张图、测试核对用）。
    pub fn all_edges(&self) -> Result<Vec<EdgeRow>> {
        let mut statement = self.conn.prepare("SELECT src, dst, kind, weight, count, lines FROM edges")?;
        let rows = statement.query_map([], |row| {
            Ok(EdgeRow { src: row.get(0)?, dst: row.get(1)?, kind: row.get(2)?, weight: row.get(3)?, count: row.get(4)?, lines: row.get(5)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 一共多少条边。
    pub fn edge_count(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))?)
    }

    // ───────── 查图要的（graph::query、find_start、describe）─────────

    /// 有多少条边指向这个节点（判断一个标签、外部包在不在图里）。
    pub fn count_edges_to(&self, dst: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM edges WHERE dst = ?1", [dst], |row| row.get(0))?)
    }

    /// 路径等于它、或以“/它”结尾的文件，最多 20 个。
    pub fn paths_matching(&self, path: &str) -> Result<Vec<String>> {
        let like = format!("%/{}", path.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut statement = self.conn.prepare("SELECT path FROM files WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\' LIMIT 20")?;
        let rows = statement.query_map(params![path, like], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 全名或名字等于它的声明：(路径, 全名)，全名对上的在前，最多 20 个。
    pub fn symbols_named(&self, name: &str) -> Result<Vec<(String, String)>> {
        let mut statement = self.conn.prepare(
            "SELECT f.path, s.qname FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qname = ?1 OR s.name = ?1 ORDER BY (s.qname = ?1) DESC, f.path LIMIT 20",
        )?;
        let rows = statement.query_map([name], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 一个节点的邻居（两个方向）：先出边的终点、再入边的起点，各按权重和次数排。
    pub fn neighbors(&self, node: &str) -> Result<Vec<String>> {
        let mut result: Vec<String> = self
            .conn
            .prepare_cached("SELECT dst FROM edges WHERE src = ?1 ORDER BY weight DESC, count DESC")?
            .query_map([node], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let incoming: Vec<String> = self
            .conn
            .prepare_cached("SELECT src FROM edges WHERE dst = ?1 ORDER BY weight DESC, count DESC")?
            .query_map([node], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        result.extend(incoming);
        Ok(result)
    }

    /// 文件这一层的整张图：从文件出发、终点不是声明的边，只要两端。
    pub fn file_level_pairs(&self) -> Result<Vec<(String, String)>> {
        let mut statement = self.conn.prepare("SELECT src, dst FROM edges WHERE src LIKE 'file:%' AND dst NOT LIKE 'sym:%'")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 从一个节点出发的全部边。
    pub fn edges_from(&self, src: &str) -> Result<Vec<EdgeRow>> {
        let mut statement = self.conn.prepare_cached("SELECT dst, kind, weight, count, lines FROM edges WHERE src = ?1")?;
        let rows = statement.query_map([src], |row| {
            Ok(EdgeRow { src: src.to_string(), dst: row.get(0)?, kind: row.get(1)?, weight: row.get(2)?, count: row.get(3)?, lines: row.get(4)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 按路径取文件的语言和 AI 摘要；没有这个文件是 None。
    pub fn file_lang_summary(&self, path: &str) -> Result<Option<(String, Option<String>)>> {
        Ok(self
            .conn
            .prepare_cached("SELECT lang, summary FROM files WHERE path = ?1")?
            .query_row([path], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?)
    }

    /// 一个声明的种类和行号；没有是 None。
    pub fn symbol_kind_line(&self, path: &str, qname: &str) -> Result<Option<(String, i64)>> {
        Ok(self
            .conn
            .prepare_cached("SELECT s.kind, s.line FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?1 AND s.qname = ?2 LIMIT 1")?
            .query_row(params![path, qname], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?)
    }

    // ───────── 搜索要的（search::search、related）─────────

    /// 全文检索：(块 ID, 文件 ID)，按 BM25 排好，最多 limit 块。
    pub fn fts_chunks(&self, fts: &str, limit: usize) -> Result<Vec<(i64, i64)>> {
        let mut statement = self.conn.prepare(
            "SELECT c.id, c.file_id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?1 ORDER BY bm25(chunks_fts) LIMIT ?2",
        )?;
        let rows = statement.query_map(params![fts, limit as i64], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 还没有这个模型算的向量的正文块：(块 ID, 标题 + 正文)，最多 limit 块。
    pub fn chunks_needing_vectors(&self, model: &str, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT c.id, c.title || char(10) || c.text FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = ?1 WHERE v.chunk_id IS NULL ORDER BY c.id LIMIT ?2",
        )?;
        let rows = statement.query_map(params![model, limit as i64], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 存一批向量（同一块已有就换掉）。
    pub fn set_vectors(&mut self, model: &str, items: &[(i64, Vec<f32>)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for (chunk_id, vector) in items {
            let bytes: Vec<u8> = vector.iter().flat_map(|number| number.to_le_bytes()).collect();
            tx.prepare_cached("INSERT OR REPLACE INTO chunk_vectors (chunk_id, model, vector) VALUES (?1, ?2, ?3)")?.execute(params![chunk_id, model, bytes])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 这个模型算的全部向量：(块 ID, 文件 ID, 向量)。
    pub fn vectors(&self, model: &str) -> Result<Vec<(i64, i64, Vec<f32>)>> {
        let mut statement = self.conn.prepare_cached("SELECT v.chunk_id, c.file_id, v.vector FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id WHERE v.model = ?1")?;
        let rows = statement.query_map([model], |row| {
            let bytes: Vec<u8> = row.get(2)?;
            let vector = bytes.chunks_exact(4).map(|part| f32::from_le_bytes([part[0], part[1], part[2], part[3]])).collect();
            Ok((row.get(0)?, row.get(1)?, vector))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 名字对上的声明：名字（小写）完全相同的在前，包含的其次，最多 200 个。lower 是小写的词，like 是转义好的 %词%。
    pub fn symbols_like(&self, lower: &str, like: &str) -> Result<Vec<SymbolMatch>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT file_id, qname, kind, line, lower(name) = ?1 AS exact FROM symbols WHERE lower(name) LIKE ?2 ESCAPE '\\' OR lower(qname) = ?1 ORDER BY exact DESC, length(name) LIMIT 200",
        )?;
        let rows = statement.query_map(params![lower, like], |row| {
            Ok(SymbolMatch { file_id: row.get(0)?, qname: row.get(1)?, kind: row.get(2)?, line: row.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 路径（小写）匹配 like 的文件 ID，短路径在前，最多 100 个。
    pub fn file_ids_with_path_like(&self, like: &str) -> Result<Vec<i64>> {
        let mut statement = self.conn.prepare_cached("SELECT id FROM files WHERE lower(path) LIKE ?1 ESCAPE '\\' ORDER BY length(path) LIMIT 100")?;
        let rows = statement.query_map([like], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 一个文件的路径、语言、种类、AI 摘要。
    pub fn file_meta(&self, file_id: i64) -> Result<FileMeta> {
        Ok(self.conn.query_row("SELECT path, lang, kind, summary FROM files WHERE id = ?1", [file_id], |row| {
            Ok(FileMeta { path: row.get(0)?, lang: row.get(1)?, kind: row.get(2)?, summary: row.get(3)? })
        })?)
    }

    /// 一个文件的路径。
    pub fn path_of(&self, file_id: i64) -> Result<String> {
        Ok(self.conn.query_row("SELECT path FROM files WHERE id = ?1", [file_id], |row| row.get(0))?)
    }

    /// 一块正文。
    /// 一个文件的全部正文块：(块 ID, 块)，按开始的行号排。jmbots 的本地壳子（local/）建 RAG 索引用：索引的就是这里切好的块。
    pub fn chunks_of(&self, file_id: i64) -> Result<Vec<(i64, ChunkRow)>> {
        let mut statement = self.conn.prepare("SELECT id, start_line, end_line, title, text FROM chunks WHERE file_id = ?1 ORDER BY start_line, id")?;
        let rows = statement.query_map([file_id], |row| Ok((row.get(0)?, ChunkRow { start_line: row.get(1)?, end_line: row.get(2)?, title: row.get(3)?, text: row.get(4)? })))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn chunk(&self, chunk_id: i64) -> Result<ChunkRow> {
        Ok(self.conn.query_row("SELECT start_line, end_line, title, text FROM chunks WHERE id = ?1", [chunk_id], |row| {
            Ok(ChunkRow { start_line: row.get(0)?, end_line: row.get(1)?, title: row.get(2)?, text: row.get(3)? })
        })?)
    }

    /// 文件和文件之间的直接关系（导入、调用汇总、提及、链接），一个方向，最多 limit 条：(另一头, 关系, 权重)。
    /// outgoing 为真是这个节点指出去的，否则是指向它的。
    pub fn file_relations(&self, node: &str, outgoing: bool, limit: usize) -> Result<Vec<(String, String, f64)>> {
        let sql = if outgoing {
            "SELECT dst, kind, weight FROM edges WHERE src = ?1 AND kind IN ('imports', 'uses', 'mentions', 'links') AND dst LIKE 'file:%' ORDER BY weight DESC, count DESC LIMIT ?2"
        } else {
            "SELECT src, kind, weight FROM edges WHERE dst = ?1 AND kind IN ('imports', 'uses', 'mentions', 'links') AND src LIKE 'file:%' ORDER BY weight DESC, count DESC LIMIT ?2"
        };
        let mut statement = self.conn.prepare_cached(sql)?;
        let rows = statement.query_map(params![node, limit as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 别的文件的标签原样：(文件 ID, 标签)。
    pub fn tags_except(&self, file_id: i64) -> Result<Vec<(i64, String)>> {
        let mut statement = self.conn.prepare_cached("SELECT file_id, tag FROM tags WHERE file_id != ?1")?;
        let rows = statement.query_map([file_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// 删掉一个文件的声明、引用、导入、提及、正文块（含全文索引）。
fn clear_children(tx: &Transaction, file_id: i64) -> Result<()> {
    tx.execute("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?1)", [file_id])?;
    tx.execute("DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?1)", [file_id])?;
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
    tx.execute(
        "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?1 AND start_line = 0 AND title = ?2)",
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
