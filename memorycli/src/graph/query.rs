//! 查图：按名字找起点、沿边（两个方向）走几步，返回经过的节点和它们之间的边。

use super::{file_node, sym_node};
use crate::store::Store;
use anyhow::Result;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};

/// 图里的一个节点。
#[derive(Debug, Serialize)]
pub struct NodeOut {
    pub id: String,
    /// file、sym、tag、pkg。
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    /// 声明的种类（function、class……）或文件的语言。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// 图里的一条边。
#[derive(Debug, Serialize)]
pub struct EdgeOut {
    pub src: String,
    pub dst: String,
    pub kind: String,
    pub weight: f64,
    pub count: i64,
    /// 出现在起点文件的哪些行。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<i64>,
}

/// 数据库里的 "3,15,20" 读成行号列表。
pub fn parse_lines(text: &str) -> Vec<i64> {
    text.split(',').filter_map(|line| line.parse().ok()).collect()
}

/// 查询结果。
#[derive(Debug, Serialize)]
pub struct GraphOut {
    /// 按查询找到的起点。
    pub start: Vec<String>,
    pub nodes: Vec<NodeOut>,
    pub edges: Vec<EdgeOut>,
    /// 节点太多被截断时为 true。
    pub truncated: bool,
}

/// 最多返回多少个节点。
const MAX_NODES: usize = 400;

/// 按查询找起点：节点 ID、标签、文件路径（或结尾）、声明全名或名字。
pub fn find_start(store: &Store, query: &str) -> Result<Vec<String>> {
    let query = query.trim();
    if query.contains(':') && ["file:", "sym:", "tag:", "pkg:"].iter().any(|prefix| query.starts_with(prefix)) {
        return Ok(vec![query.to_string()]);
    }
    let mut start = Vec::new();
    //M 标签（标准名或别名）。
    let aliases = store.aliases()?;
    let canonical = aliases.get(query).cloned().unwrap_or_else(|| query.to_string());
    if store.count_edges_to(&format!("tag:{canonical}"))? > 0 {
        start.push(format!("tag:{canonical}"));
    }
    if store.count_edges_to(&format!("pkg:{query}"))? > 0 {
        start.push(format!("pkg:{query}"));
    }
    //M 文件：完整路径，或以 /查询 结尾。
    let normalized = query.replace('\\', "/");
    for path in store.paths_matching(&normalized)? {
        start.push(file_node(&path));
    }
    //M 声明：全名或名字。
    for (path, qname) in store.symbols_named(query)? {
        start.push(sym_node(&path, &qname));
    }
    Ok(start)
}

/// 从查询出发，沿边（两个方向）走 depth 步，返回经过的节点和它们之间的边。
/// query 为空时返回整张图（文件、标签、外部包和文件之间的边，不含声明，免得太大）。
pub fn query(store: &Store, query: Option<&str>, depth: usize) -> Result<GraphOut> {
    let mut visited: HashSet<String> = HashSet::new();
    let mut truncated = false;
    let start = match query.filter(|text| !text.trim().is_empty()) {
        Some(text) => find_start(store, text)?,
        None => Vec::new(),
    };
    if query.is_some_and(|text| !text.trim().is_empty()) {
        //M 广度优先。contains 往下走一层就够，不再从声明回到别的声明的文件（免得一下子铺满）。
        let mut queue: VecDeque<(String, usize)> = start.iter().map(|id| (id.clone(), 0)).collect();
        visited.extend(start.iter().cloned());
        while let Some((node, level)) = queue.pop_front() {
            if level >= depth {
                continue;
            }
            for neighbor in store.neighbors(&node)? {
                if visited.len() >= MAX_NODES {
                    truncated = true;
                    break;
                }
                if visited.insert(neighbor.clone()) {
                    queue.push_back((neighbor, level + 1));
                }
            }
        }
    } else {
        for (src, dst) in store.file_level_pairs()? {
            visited.insert(src);
            visited.insert(dst);
        }
    }

    //M 节点之间的边。
    let mut edges = Vec::new();
    for src in &visited {
        for edge in store.edges_from(src)? {
            if visited.contains(&edge.dst) {
                edges.push(EdgeOut { lines: parse_lines(&edge.lines), src: edge.src, dst: edge.dst, kind: edge.kind, weight: edge.weight, count: edge.count });
            }
        }
    }
    edges.sort_by(|a, b| (&a.src, &a.dst, &a.kind).cmp(&(&b.src, &b.dst, &b.kind)));
    let mut nodes: Vec<NodeOut> = visited.iter().map(|id| describe(store, id)).collect::<Result<_>>()?;
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(GraphOut { start, nodes, edges, truncated })
}

/// 补全一个节点的信息。
pub fn describe(store: &Store, id: &str) -> Result<NodeOut> {
    let (kind, rest) = id.split_once(':').unwrap_or(("", id));
    let mut node =
        NodeOut { id: id.to_string(), kind: kind.to_string(), label: rest.to_string(), file: None, line: None, detail: None, summary: None };
    match kind {
        "file" => {
            let row = store.file_lang_summary(rest)?;
            node.file = Some(rest.to_string());
            if let Some((lang, summary)) = row {
                node.detail = Some(lang);
                node.summary = summary;
            }
        }
        "sym" => {
            let (path, qname) = rest.split_once('#').unwrap_or((rest, ""));
            node.label = qname.to_string();
            node.file = Some(path.to_string());
            let row = store.symbol_kind_line(path, qname)?;
            if let Some((symbol_kind, line)) = row {
                node.detail = Some(symbol_kind);
                node.line = Some(line);
            }
        }
        _ => {}
    }
    Ok(node)
}
