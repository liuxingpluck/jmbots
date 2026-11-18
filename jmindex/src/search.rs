//! 搜索：给一个词（或几个词），返回相关的文件，以及每个文件里有什么（摘要、标签、命中的声明、正文片段、相关文件）。
//!
//! 用户 11-03：“我去搜……发了某一个关键词，然后他就去……返回对应的文件里包含了哪些内容。”
//!
//! 四路一起找，再用 RRF（倒数排名融合：每一路按排名给 1/(60+名次)，加起来）合成一个排名：
//!   正文  全文检索（FTS5 + BM25），也搜 AI 摘要块
//!   声明  函数、类、标题的名字等于或包含这个词
//!   标签  AI 标签（按整合后的标准名）包含这个词
//!   路径  文件路径包含这个词
//! 几路都命中的文件排在前面；返回时说明是哪几路命中的（matched）。

use crate::graph;
use crate::store::{AI_CHUNK_TITLE, Store};
use crate::text;
use anyhow::Result;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;

/// RRF 的常数（原论文用 60）。
const RRF_K: f64 = 60.0;

/// 一个命中的声明。
#[derive(Debug, Serialize)]
pub struct SymbolHit {
    pub qname: String,
    pub kind: String,
    pub line: i64,
}

/// 一段正文片段。
#[derive(Debug, Serialize)]
pub struct Snippet {
    pub start_line: i64,
    pub end_line: i64,
    pub title: String,
    pub text: String,
}

/// 一个相关的节点。
#[derive(Debug, Serialize)]
pub struct Related {
    pub id: String,
    /// 关系：imports、uses、mentions、links、被 xx 引用（in_ 开头），或 shared_tags（同标签）。
    pub relation: String,
    pub weight: f64,
}

/// 一个命中的文件。
#[derive(Debug, Serialize)]
pub struct Hit {
    pub path: String,
    pub lang: String,
    pub kind: String,
    pub score: f64,
    /// 哪几路命中：text、symbol、tag、path。
    pub matched: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub tags: Vec<String>,
    pub symbols: Vec<SymbolHit>,
    pub snippets: Vec<Snippet>,
    pub related: Vec<Related>,
}

/// 搜索结果。
#[derive(Debug, Serialize)]
pub struct SearchOut {
    pub query: String,
    pub hits: Vec<Hit>,
}

/// 每个文件累计的分数和证据。
#[derive(Default)]
struct Acc {
    score: f64,
    matched: Vec<&'static str>,
    chunks: Vec<i64>,
    symbols: Vec<SymbolHit>,
}

impl Acc {
    fn add(&mut self, signal: &'static str, rank: usize, weight: f64) {
        self.score += weight / (RRF_K + rank as f64 + 1.0);
        if !self.matched.contains(&signal) {
            self.matched.push(signal);
        }
    }
}

/// LIKE 用的转义。
fn like_pattern(term: &str) -> String {
    format!("%{}%", term.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// 搜。
pub fn search(store: &Store, query: &str, limit: usize) -> Result<SearchOut> {
    let terms = text::terms(query);
    let mut acc: HashMap<i64, Acc> = HashMap::new();

    //M 1. 正文：全文检索，按文件去重排名（每个文件留前 3 块当片段）。
    if let Some(fts) = text::fts_query(query) {
        let mut statement = store.conn.prepare(
            "SELECT c.id, c.file_id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?1 ORDER BY bm25(chunks_fts) LIMIT 300",
        )?;
        let rows: Vec<(i64, i64)> = statement.query_map([&fts], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut file_rank: HashMap<i64, usize> = HashMap::new();
        for (chunk_id, file_id) in rows {
            let next = file_rank.len();
            let rank = *file_rank.entry(file_id).or_insert(next);
            let entry = acc.entry(file_id).or_default();
            if entry.chunks.is_empty() {
                entry.add("text", rank, 1.0);
            }
            if entry.chunks.len() < 3 {
                entry.chunks.push(chunk_id);
            }
        }
    }

    //M 2. 声明名字：完全相同的排前面，包含的其次。
    {
        let mut statement = store.conn.prepare(
            "SELECT file_id, qname, kind, line, lower(name) = ?1 AS exact FROM symbols WHERE lower(name) LIKE ?2 ESCAPE '\\' OR lower(qname) = ?1 ORDER BY exact DESC, length(name) LIMIT 200",
        )?;
        let mut file_rank: HashMap<i64, usize> = HashMap::new();
        for term in &terms {
            let lower = term.to_lowercase();
            let rows: Vec<(i64, String, String, i64)> = statement
                .query_map(params![lower, like_pattern(term)], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (file_id, qname, kind, line) in rows {
                let next = file_rank.len();
                let rank = *file_rank.entry(file_id).or_insert(next);
                let entry = acc.entry(file_id).or_default();
                entry.add("symbol", rank, 1.0);
                if entry.symbols.len() < 8 && !entry.symbols.iter().any(|symbol| symbol.qname == qname) {
                    entry.symbols.push(SymbolHit { qname, kind, line });
                }
            }
        }
    }

    //M 3. 标签：标准名或别名包含这个词。
    let aliases = store.aliases()?;
    {
        let mut statement = store.conn.prepare("SELECT file_id, tag FROM tags")?;
        let rows: Vec<(i64, String)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut rank = 0;
        let mut seen = std::collections::HashSet::new();
        for (file_id, tag) in rows {
            let canonical = aliases.get(&tag).cloned().unwrap_or_else(|| tag.clone());
            let hit = terms.iter().any(|term| {
                let term = term.to_lowercase();
                tag.to_lowercase().contains(&term) || canonical.to_lowercase().contains(&term)
            });
            if hit && seen.insert(file_id) {
                acc.entry(file_id).or_default().add("tag", rank, 0.8);
                rank += 1;
            }
        }
    }

    //M 4. 路径。
    {
        let mut statement = store.conn.prepare("SELECT id FROM files WHERE lower(path) LIKE ?1 ESCAPE '\\' ORDER BY length(path) LIMIT 100")?;
        for term in &terms {
            let ids: Vec<i64> = statement.query_map([like_pattern(term)], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
            for (rank, file_id) in ids.into_iter().enumerate() {
                acc.entry(file_id).or_default().add("path", rank, 0.6);
            }
        }
    }

    //M 5. 排序，补全每个文件的内容。
    let mut ranked: Vec<(i64, Acc)> = acc.into_iter().collect();
    ranked.sort_by(|a, b| b.1.score.total_cmp(&a.1.score));
    ranked.truncate(limit);
    let mut hits = Vec::new();
    for (file_id, found) in ranked {
        let (path, lang, kind, summary): (String, String, String, Option<String>) =
            store.conn.query_row("SELECT path, lang, kind, summary FROM files WHERE id = ?1", [file_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
        let mut snippets = Vec::new();
        for chunk_id in &found.chunks {
            let (start_line, end_line, title, body): (i64, i64, String, String) =
                store.conn.query_row("SELECT start_line, end_line, title, text FROM chunks WHERE id = ?1", [chunk_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
            if title == AI_CHUNK_TITLE {
                continue; // 摘要和标签另外给了
            }
            let (offset, text) = focus(&body, &terms);
            snippets.push(Snippet {
                start_line: start_line + offset as i64,
                end_line: (start_line + offset as i64 + text.lines().count() as i64 - 1).min(end_line),
                title,
                text,
            });
        }
        hits.push(Hit {
            tags: store.tags_of(file_id, &aliases)?,
            related: related(store, &path, file_id, &aliases)?,
            path,
            lang,
            kind,
            score: (found.score * 10000.0).round() / 10000.0,
            matched: found.matched.iter().map(|signal| signal.to_string()).collect(),
            summary,
            symbols: found.symbols,
            snippets,
        });
    }
    Ok(SearchOut { query: query.to_string(), hits })
}

/// 片段：找到第一行含查询词的，前后各留几行；返回从块开头跳过了几行、片段正文。
fn focus(body: &str, terms: &[String]) -> (usize, String) {
    let lines: Vec<&str> = body.lines().collect();
    let lowered: Vec<String> = terms.iter().map(|term| term.to_lowercase()).collect();
    let hit = lines.iter().position(|line| {
        let line = line.to_lowercase();
        lowered.iter().any(|term| line.contains(term.as_str()))
    });
    let center = hit.unwrap_or(0);
    let start = center.saturating_sub(3);
    let end = (center + 6).min(lines.len());
    let text = lines[start..end].join("\n");
    (start, text::head_chars(&text, 1200).to_string())
}

/// 相关的文件和标签：图里直接连着的（导入、调用、提及、链接，两个方向），加上同标签最多的文件。
fn related(store: &Store, path: &str, file_id: i64, aliases: &HashMap<String, String>) -> Result<Vec<Related>> {
    let node = graph::file_node(path);
    let mut result: Vec<Related> = Vec::new();
    let mut statement = store.conn.prepare_cached(
        "SELECT dst, kind, weight FROM edges WHERE src = ?1 AND kind IN ('imports', 'uses', 'mentions', 'links') AND dst LIKE 'file:%' ORDER BY weight DESC, count DESC LIMIT 6",
    )?;
    for row in statement.query_map([&node], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?)))? {
        let (id, relation, weight) = row?;
        result.push(Related { id, relation, weight });
    }
    let mut statement = store.conn.prepare_cached(
        "SELECT src, kind, weight FROM edges WHERE dst = ?1 AND kind IN ('imports', 'uses', 'mentions', 'links') AND src LIKE 'file:%' ORDER BY weight DESC, count DESC LIMIT 6",
    )?;
    for row in statement.query_map([&node], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?)))? {
        let (id, relation, weight) = row?;
        result.push(Related { id, relation: format!("in_{relation}"), weight });
    }
    //M 同标签：共享的标准名标签越多越相关（至少 2 个）。
    let mine = store.tags_of(file_id, aliases)?;
    if mine.len() >= 2 {
        let mut shared: HashMap<i64, usize> = HashMap::new();
        let mut statement = store.conn.prepare_cached("SELECT file_id, tag FROM tags WHERE file_id != ?1")?;
        for row in statement.query_map([file_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))? {
            let (other, tag) = row?;
            let canonical = aliases.get(&tag).cloned().unwrap_or(tag);
            if mine.contains(&canonical) {
                *shared.entry(other).or_default() += 1;
            }
        }
        let mut list: Vec<(i64, usize)> = shared.into_iter().filter(|(_, count)| *count >= 2).collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        for (other, count) in list.into_iter().take(4) {
            let other_path: String = store.conn.query_row("SELECT path FROM files WHERE id = ?1", [other], |row| row.get(0))?;
            result.push(Related { id: graph::file_node(&other_path), relation: "shared_tags".into(), weight: count as f64 / mine.len() as f64 });
        }
    }
    //M 同一个文件有好几种关系（既导入又调用）时并成一条：关系用 + 连起来，权重取大的。
    let mut merged: Vec<Related> = Vec::new();
    for item in result {
        match merged.iter_mut().find(|existing| existing.id == item.id) {
            Some(existing) => {
                existing.relation = format!("{}+{}", existing.relation, item.relation);
                existing.weight = existing.weight.max(item.weight);
            }
            None => merged.push(item),
        }
    }
    Ok(merged)
}
