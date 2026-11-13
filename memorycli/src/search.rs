//! 搜索：给一个词（或几个词），返回相关的文件，以及每个文件里有什么（摘要、标签、命中的声明、正文片段、相关文件）。
//!
//! 用户 11-03：“我去搜……发了某一个关键词，然后他就去……返回对应的文件里包含了哪些内容。”
//!
//! 四路一起找，再用 RRF（倒数排名融合：每一路按排名给 1/(60+名次)，加起来）合成一个排名：
//!   正文  全文检索（FTS5 + BM25），也搜 AI 摘要块
//!   声明  函数、类、标题的名字等于或包含这个词
//!   标签  AI 标签（按整合后的标准名）包含这个词
//!   路径  文件路径包含这个词
//!   向量  配了嵌入模型时多这一路：问句的向量和每块正文的向量比余弦，按意思找（没写这几个字、讲的是这件事的也能找到）
//! 几路都命中的文件排在前面；返回时说明是哪几路命中的（matched）。

use crate::graph;
use crate::store::{AI_CHUNK_TITLE, ChunkRow, FileMeta, Store, SymbolMatch};
use crate::text;
use anyhow::Result;
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
    /// 哪个库（多库搜索时才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lib: Option<String>,
    /// 相对库的根目录的路径。
    pub path: String,
    /// 绝对路径（多库搜索、库里记着根目录时才有）：调用方拿它就能直接打开文件。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abs_path: Option<String>,
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
    search_with(store, query, limit, None)
}

/// 搜，带上问句的向量：vector 是 (嵌入模型名, 问句的向量)；没有就只走四路。
pub fn search_with(store: &Store, query: &str, limit: usize, vector: Option<(&str, &[f32])>) -> Result<SearchOut> {
    let terms = text::terms(query);
    let mut acc: HashMap<i64, Acc> = HashMap::new();

    //M 1. 正文：全文检索，按文件去重排名（每个文件留前 3 块当片段）。
    if let Some(fts) = text::fts_query(query) {
        let rows = store.fts_chunks(&fts, 300)?;
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
        let mut file_rank: HashMap<i64, usize> = HashMap::new();
        for term in &terms {
            let lower = term.to_lowercase();
            for SymbolMatch { file_id, qname, kind, line } in store.symbols_like(&lower, &like_pattern(term))? {
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
        let rows = store.all_tags()?;
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
        for term in &terms {
            let ids = store.file_ids_with_path_like(&like_pattern(term))?;
            for (rank, file_id) in ids.into_iter().enumerate() {
                acc.entry(file_id).or_default().add("path", rank, 0.6);
            }
        }
    }

    //M 4.5 向量：和问句最像的 300 块，按文件去重排名（每个文件留前 3 块当片段）。
    if let Some((model, query_vector)) = vector {
        let mut scored: Vec<(f32, i64, i64)> = store
            .vectors(model)?
            .into_iter()
            .map(|(chunk_id, file_id, chunk_vector)| (crate::ai::cosine(query_vector, &chunk_vector), chunk_id, file_id))
            .collect();
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut file_rank: HashMap<i64, usize> = HashMap::new();
        for (_, chunk_id, file_id) in scored.into_iter().take(300) {
            let next = file_rank.len();
            let rank = *file_rank.entry(file_id).or_insert(next);
            let entry = acc.entry(file_id).or_default();
            if !entry.matched.contains(&"vector") {
                entry.add("vector", rank, 1.0);
            }
            if entry.chunks.len() < 3 && !entry.chunks.contains(&chunk_id) {
                entry.chunks.push(chunk_id);
            }
        }
    }

    //M 5. 排序，补全每个文件的内容。
    let mut ranked: Vec<(i64, Acc)> = acc.into_iter().collect();
    ranked.sort_by(|a, b| b.1.score.total_cmp(&a.1.score));
    ranked.truncate(limit);
    let mut hits = Vec::new();
    for (file_id, found) in ranked {
        let FileMeta { path, lang, kind, summary } = store.file_meta(file_id)?;
        let mut snippets = Vec::new();
        for chunk_id in &found.chunks {
            let ChunkRow { start_line, end_line, title, text: body } = store.chunk(*chunk_id)?;
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
            lib: None,
            abs_path: None,
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
    for (id, relation, weight) in store.file_relations(&node, true, 6)? {
        result.push(Related { id, relation, weight });
    }
    for (id, relation, weight) in store.file_relations(&node, false, 6)? {
        result.push(Related { id, relation: format!("in_{relation}"), weight });
    }
    //M 同标签：共享的标准名标签越多越相关（至少 2 个）。
    let mine = store.tags_of(file_id, aliases)?;
    if mine.len() >= 2 {
        let mut shared: HashMap<i64, usize> = HashMap::new();
        for (other, tag) in store.tags_except(file_id)? {
            let canonical = aliases.get(&tag).cloned().unwrap_or(tag);
            if mine.contains(&canonical) {
                *shared.entry(other).or_default() += 1;
            }
        }
        let mut list: Vec<(i64, usize)> = shared.into_iter().filter(|(_, count)| *count >= 2).collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        for (other, count) in list.into_iter().take(4) {
            let other_path = store.path_of(other)?;
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
