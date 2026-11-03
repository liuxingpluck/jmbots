//! 关系图谱：摄取完从数据库的原始记录（声明、引用、导入、提及、标签）算出边，再按名字查邻居。
//!
//! 边的种类（weight 是置信度，0～1）：
//!   contains  文件 → 它的声明（1.0）
//!   imports   文件 → 文件，或文件 → pkg:外部包（1.0）
//!   calls     声明（或文件顶层）→ 被调用的声明；refs 是当值传出去（回调、{ handleMessage }）；types 是当类型用
//!   uses      文件 → 文件：calls/refs 汇总到文件这一层，看文件之间谁依赖谁
//!   mentions  文件 → 文件或声明：文字里提到了它（注释、文档、反引号）
//!   links     Markdown 链接 → 文件（1.0）
//!   tagged    文件 → tag:标签（AI 打的，按整合后的标准名）
//!
//! 调用怎么对上声明（只看语法，所以要猜，猜得越没把握权重越低）：
//!   同一个文件里有这个名字            0.9
//!   导入了的文件里有（Go：同一个包）   0.8
//!   全局只有 1～3 个同名的            0.4（ref 不走这一级，太乱）
//!   再多就不连（push、get、map 这种名字到处都是）
//!   同一级对上好几个（接口和实现同名的方法），权重按个数平分，最低 0.2

use crate::store::Store;
use anyhow::Result;
use rusqlite::params;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};

/// 一个文件（算边时用）。
struct FileInfo {
    id: i64,
    path: String,
    lang: String,
}

/// 一条要写的边：(起点, 终点, 种类) → (权重, 次数, 出现在起点文件的哪些行)。
type EdgeMap = HashMap<(String, String, &'static str), (f64, i64, Vec<i64>)>;

/// 每条边最多记多少个行号。
const MAX_LINES: usize = 50;

fn add_edge(edges: &mut EdgeMap, src: String, dst: String, kind: &'static str, weight: f64, line: Option<i64>) {
    if src == dst {
        return;
    }
    let entry = edges.entry((src, dst, kind)).or_insert((weight, 0, Vec::new()));
    entry.0 = entry.0.max(weight);
    entry.1 += 1;
    if let Some(line) = line
        && entry.2.len() < MAX_LINES
        && !entry.2.contains(&line)
    {
        entry.2.push(line);
    }
}

/// 文件节点 ID。
pub fn file_node(path: &str) -> String {
    format!("file:{path}")
}

/// 声明节点 ID。
pub fn sym_node(path: &str, qname: &str) -> String {
    format!("sym:{path}#{qname}")
}

/// 所在目录（不含末尾斜杠；顶层是空字符串）。
fn dir_of(path: &str) -> &str {
    path.rfind('/').map(|index| &path[..index]).unwrap_or("")
}

/// 拼路径并化简 . 和 ..；跳出根目录时返回 None。
fn join_path(dir: &str, relative: &str) -> Option<String> {
    let mut parts: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// 按语言规则把一条导入找到文件；外部包返回 Err(包名)。
/// go_module：这个文件所属的 Go 模块（module 名，go.mod 所在目录），不是 Go 文件或找不到 go.mod 时是 None。
fn resolve_import(file: &FileInfo, spec: &str, paths: &HashSet<String>, go_module: Option<(&str, &str)>) -> Result<Vec<String>, String> {
    let dir = dir_of(&file.path);
    let exists = |candidate: &str| paths.contains(candidate);
    match file.lang.as_str() {
        "typescript" | "tsx" | "javascript" => {
            if !spec.starts_with('.') {
                // 外部包：@scope/name 或 name（去掉子路径）。
                let mut parts = spec.split('/');
                let first = parts.next().unwrap_or(spec);
                let name = if first.starts_with('@') { format!("{first}/{}", parts.next().unwrap_or("")) } else { first.to_string() };
                return Err(name);
            }
            let Some(base) = join_path(dir, spec) else { return Ok(Vec::new()) };
            let mut candidates = vec![base.clone()];
            // TS 的 ESM 写法：import './a.js' 实际是 a.ts。
            for (from, to) in [(".js", ".ts"), (".js", ".tsx"), (".jsx", ".tsx"), (".mjs", ".mts")] {
                if let Some(stem) = base.strip_suffix(from) {
                    candidates.push(format!("{stem}{to}"));
                }
            }
            for ext in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", "/index.ts", "/index.tsx", "/index.js"] {
                candidates.push(format!("{base}{ext}"));
            }
            Ok(candidates.into_iter().find(|candidate| exists(candidate)).into_iter().collect())
        }
        "rust" => {
            let file_name = file.path.rsplit('/').next().unwrap_or("");
            // 这个文件对应的模块目录：mod.rs、lib.rs、main.rs 就是所在目录，a.rs 是 a/。
            let module_dir = if matches!(file_name, "mod.rs" | "lib.rs" | "main.rs") {
                dir.to_string()
            } else {
                format!("{}{}", if dir.is_empty() { String::new() } else { format!("{dir}/") }, file_name.trim_end_matches(".rs"))
            };
            if let Some(name) = spec.strip_prefix("mod:") {
                let candidates = [format!("{module_dir}/{name}.rs"), format!("{module_dir}/{name}/mod.rs")];
                return Ok(candidates.into_iter().map(|c| c.trim_start_matches('/').to_string()).find(|c| exists(c)).into_iter().collect());
            }
            let path = spec.strip_prefix("use:").unwrap_or(spec);
            let segments: Vec<&str> = path.split("::").collect();
            let (base, rest): (String, &[&str]) = match segments.first().copied() {
                Some("crate") => {
                    // 包的根：路径里最后一个 src/ 之前。
                    let root = file.path.rfind("src/").map(|index| &file.path[..index + 3]).unwrap_or("src");
                    (root.to_string(), &segments[1..])
                }
                Some("super") => (dir_of(&module_dir).to_string(), &segments[1..]),
                Some("self") => (module_dir.clone(), &segments[1..]),
                Some(first) => return Err(first.to_string()),
                None => return Ok(Vec::new()),
            };
            // 从最长的路径往短了试：crate::a::b::C → src/a/b/C.rs、src/a/b.rs、src/a.rs……
            for length in (1..=rest.len()).rev() {
                let joined = rest[..length].join("/");
                for candidate in [format!("{base}/{joined}.rs"), format!("{base}/{joined}/mod.rs")] {
                    let candidate = candidate.trim_start_matches('/').to_string();
                    if exists(&candidate) {
                        return Ok(vec![candidate]);
                    }
                }
            }
            Ok(Vec::new())
        }
        "go" => {
            let Some((module, module_dir)) = go_module else { return Err(spec.to_string()) };
            let Some(relative) = spec.strip_prefix(module).filter(|rest| rest.is_empty() || rest.starts_with('/')) else {
                return Err(spec.to_string());
            };
            let package_dir =
                [module_dir, relative.trim_start_matches('/')].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join("/");
            let package_dir = package_dir.as_str();
            // Go 导入的是包（目录），连到目录里的每个非测试 .go 文件。
            Ok(paths.iter().filter(|path| dir_of(path) == package_dir && path.ends_with(".go") && !path.ends_with("_test.go")).cloned().collect())
        }
        "python" => {
            let (base, dotted) = if let Some(relative) = spec.strip_prefix("rel:") {
                let dots = relative.chars().take_while(|c| *c == '.').count();
                let mut base = dir.to_string();
                for _ in 1..dots {
                    base = dir_of(&base).to_string();
                }
                (base, relative[dots..].to_string())
            } else {
                (String::new(), spec.strip_prefix("abs:").unwrap_or(spec).to_string())
            };
            let joined = dotted.replace('.', "/");
            let prefix = if base.is_empty() { String::new() } else { format!("{base}/") };
            for candidate in [format!("{prefix}{joined}.py"), format!("{prefix}{joined}/__init__.py")] {
                if exists(&candidate) {
                    return Ok(vec![candidate]);
                }
            }
            if spec.starts_with("abs:") { Err(dotted.split('.').next().unwrap_or(&dotted).to_string()) } else { Ok(Vec::new()) }
        }
        _ => Ok(Vec::new()),
    }
}

/// 文字里提到的路径对上文件：先按相对路径，再按“路径以它结尾”；对上太多个就不连。
fn resolve_path_mention(from: &str, target: &str, paths: &HashSet<String>, by_suffix: &HashMap<String, Vec<String>>) -> Vec<(String, f64)> {
    if let Some(joined) = join_path(dir_of(from), target)
        && paths.contains(&joined)
    {
        return vec![(joined, 0.8)];
    }
    if paths.contains(target) {
        return vec![(target.to_string(), 0.8)];
    }
    // 前面粘着汉字的（如“放在bots/a.md”）去掉汉字再试。
    let trimmed = target.trim_start_matches(|c: char| crate::text::is_cjk(c));
    let file_name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let Some(candidates) = by_suffix.get(file_name) else { return Vec::new() };
    let matched: Vec<&String> = candidates.iter().filter(|path| *path == trimmed || path.ends_with(&format!("/{trimmed}"))).collect();
    match matched.len() {
        0 => Vec::new(),
        1 => vec![(matched[0].clone(), 0.6)],
        2..=3 => matched.into_iter().map(|path| (path.clone(), 0.3)).collect(),
        _ => Vec::new(),
    }
}

/// 一个 Go 文件所属的模块：从它所在目录往上找最近的 go.mod（项目里可以有好几个模块，如 jmbots 的 shell/go.mod）。
/// 返回（module 名，go.mod 所在目录的相对路径）；按目录缓存。
fn go_module(root: &std::path::Path, dir: &str, cache: &mut HashMap<String, Option<(String, String)>>) -> Option<(String, String)> {
    if let Some(found) = cache.get(dir) {
        return found.clone();
    }
    let found = std::fs::read_to_string(root.join(dir).join("go.mod"))
        .ok()
        .and_then(|text| text.lines().find_map(|line| line.strip_prefix("module ").map(|name| name.trim().to_string())))
        .map(|module| (module, dir.to_string()))
        .or_else(|| if dir.is_empty() { None } else { go_module(root, dir_of(dir), cache) });
    cache.insert(dir.to_string(), found.clone());
    found
}

/// 重新算全部的边。返回边数。
pub fn rebuild(store: &mut Store, root: &std::path::Path) -> Result<usize> {
    //M 1. 读文件和声明。
    let files: Vec<FileInfo> = store.files()?.into_iter().map(|file| FileInfo { id: file.id, path: file.path, lang: file.lang }).collect();
    let by_id: HashMap<i64, &FileInfo> = files.iter().map(|file| (file.id, file)).collect();
    let paths: HashSet<String> = files.iter().map(|file| file.path.clone()).collect();
    let mut by_suffix: HashMap<String, Vec<String>> = HashMap::new();
    for path in &paths {
        by_suffix.entry(path.rsplit('/').next().unwrap_or(path).to_string()).or_default().push(path.clone());
    }
    // 名字 → [(文件 ID, 全名)]；全名 → [(文件 ID, 全名)]。
    let mut by_name: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    let mut by_qname: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    let mut edges: EdgeMap = HashMap::new();
    {
        let mut statement = store.conn.prepare("SELECT file_id, name, qname, kind FROM symbols")?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))?;
        for row in rows {
            let (file_id, name, qname, kind) = row?;
            let Some(file) = by_id.get(&file_id) else { continue };
            add_edge(&mut edges, file_node(&file.path), sym_node(&file.path, &qname), "contains", 1.0, None);
            if kind == "heading" {
                continue; // 文档标题不当调用目标
            }
            by_name.entry(name).or_default().push((file_id, qname.clone()));
            by_qname.entry(qname.clone()).or_default().push((file_id, qname));
        }
    }

    //M 2. 导入。
    let mut go_modules: HashMap<String, Option<(String, String)>> = HashMap::new();
    let mut imported: HashMap<i64, HashSet<i64>> = HashMap::new();
    let path_to_id: HashMap<&str, i64> = files.iter().map(|file| (file.path.as_str(), file.id)).collect();
    {
        let mut statement = store.conn.prepare("SELECT file_id, spec, line FROM imports")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))?;
        for row in rows {
            let (file_id, spec, line) = row?;
            let Some(file) = by_id.get(&file_id) else { continue };
            let module = if file.lang == "go" { go_module(root, dir_of(&file.path), &mut go_modules) } else { None };
            match resolve_import(file, &spec, &paths, module.as_ref().map(|(name, dir)| (name.as_str(), dir.as_str()))) {
                Ok(targets) => {
                    for target in targets {
                        if let Some(&target_id) = path_to_id.get(target.as_str()) {
                            imported.entry(file_id).or_default().insert(target_id);
                        }
                        add_edge(&mut edges, file_node(&file.path), file_node(&target), "imports", 1.0, Some(line));
                    }
                }
                Err(package) if !package.is_empty() => {
                    add_edge(&mut edges, file_node(&file.path), format!("pkg:{package}"), "imports", 1.0, Some(line));
                }
                Err(_) => {}
            }
        }
    }
    // Go：同一个目录（包）里的文件互相看得见。
    for file in files.iter().filter(|file| file.lang == "go") {
        let siblings: Vec<i64> =
            files.iter().filter(|other| other.lang == "go" && dir_of(&other.path) == dir_of(&file.path)).map(|other| other.id).collect();
        imported.entry(file.id).or_default().extend(siblings);
    }

    //M 3. 调用和回调。
    {
        let mut statement = store.conn.prepare("SELECT file_id, from_qname, name, kind, line FROM refs")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?))
        })?;
        for row in rows {
            let (file_id, from, name, kind, line) = row?;
            let Some(file) = by_id.get(&file_id) else { continue };
            let Some(candidates) = by_name.get(&name) else { continue };
            let same: Vec<&(i64, String)> = candidates.iter().filter(|(id, _)| *id == file_id).collect();
            let imports = imported.get(&file_id);
            let via_import: Vec<&(i64, String)> = candidates.iter().filter(|(id, _)| imports.is_some_and(|set| set.contains(id))).collect();
            let is_call = kind == "call" || kind == "member";
            let (targets, weight): (Vec<&(i64, String)>, f64) = if kind == "member" && !(same.is_empty() && via_import.is_empty()) {
                // obj.f()：同文件的和导入了的文件里的一起算（f 多半是别处的方法）。
                let mut both = same.clone();
                both.extend(via_import.iter().copied());
                (both, if via_import.is_empty() { 0.7 } else { 0.8 })
            } else if !same.is_empty() {
                (same, 0.9)
            } else if !via_import.is_empty() {
                (via_import, 0.8)
            } else if is_call && candidates.len() <= 3 {
                (candidates.iter().collect(), 0.4)
            } else {
                continue;
            };
            // 同一级有几个同名的（如接口和实现的方法同名），分不清是哪个，置信度平分（最低 0.2）。
            let weight = if targets.len() > 1 { (weight / targets.len() as f64).max(0.2) } else { weight };
            let src = match &from {
                Some(qname) => sym_node(&file.path, qname),
                None => file_node(&file.path),
            };
            let edge_kind: &'static str = match kind.as_str() {
                "call" | "member" => "calls",
                "type" => "types",
                _ => "refs",
            };
            for (target_id, qname) in targets {
                // 自己调自己（递归）、声明里的简写属性指回自己的不连。
                if *target_id == file_id && from.as_deref() == Some(qname.as_str()) {
                    continue;
                }
                let Some(target) = by_id.get(target_id) else { continue };
                add_edge(&mut edges, src.clone(), sym_node(&target.path, qname), edge_kind, weight, Some(line));
                if *target_id != file_id {
                    add_edge(&mut edges, file_node(&file.path), file_node(&target.path), "uses", weight, Some(line));
                }
            }
        }
    }

    //M 4. 文字里的提及和链接。
    {
        let mut statement = store.conn.prepare("SELECT file_id, kind, target, line FROM mentions")?;
        let rows =
            statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))?;
        for row in rows {
            let (file_id, kind, target, line) = row?;
            let Some(file) = by_id.get(&file_id) else { continue };
            let src = file_node(&file.path);
            match kind.as_str() {
                "link" => {
                    if let Some(joined) = join_path(dir_of(&file.path), &target).filter(|joined| paths.contains(joined)) {
                        add_edge(&mut edges, src, file_node(&joined), "links", 1.0, Some(line));
                    } else {
                        for (path, weight) in resolve_path_mention(&file.path, &target, &paths, &by_suffix) {
                            add_edge(&mut edges, src.clone(), file_node(&path), "links", weight, Some(line));
                        }
                    }
                }
                "path" => {
                    for (path, weight) in resolve_path_mention(&file.path, &target, &paths, &by_suffix) {
                        if path != file.path {
                            add_edge(&mut edges, src.clone(), file_node(&path), "mentions", weight, Some(line));
                        }
                    }
                }
                "ident" => {
                    // 先按全名（a.b），再按最后一段名字；同名太多不连。
                    let last = target.rsplit('.').next().unwrap_or(&target).to_string();
                    let candidates = by_qname.get(&target).or_else(|| by_name.get(&last));
                    if let Some(candidates) = candidates.filter(|list| list.len() <= 3) {
                        let weight = if candidates.len() == 1 { 0.6 } else { 0.4 };
                        for (target_id, qname) in candidates {
                            if let Some(target_file) = by_id.get(target_id) {
                                add_edge(&mut edges, src.clone(), sym_node(&target_file.path, qname), "mentions", weight, Some(line));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    //M 5. AI 标签（按整合后的标准名）。
    {
        let aliases = store.aliases()?;
        let mut statement = store.conn.prepare("SELECT file_id, tag FROM tags")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
        for row in rows {
            let (file_id, tag) = row?;
            let Some(file) = by_id.get(&file_id) else { continue };
            let canonical = aliases.get(&tag).cloned().unwrap_or(tag);
            add_edge(&mut edges, file_node(&file.path), format!("tag:{canonical}"), "tagged", 1.0, None);
        }
    }

    //M 6. 写回数据库。几十万条边时，先删索引、写完再建，比边写边维护索引快好几倍。
    let tx = store.conn.transaction()?;
    tx.execute_batch("DROP INDEX IF EXISTS edges_src; DROP INDEX IF EXISTS edges_dst; DELETE FROM edges;")?;
    {
        let mut insert = tx.prepare("INSERT INTO edges (src, dst, kind, weight, count, lines) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        for ((src, dst, kind), (weight, count, lines)) in &edges {
            let mut lines = lines.clone();
            lines.sort_unstable();
            let lines = lines.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
            insert.execute(params![src, dst, kind, weight, count, lines])?;
        }
    }
    tx.execute_batch("CREATE INDEX edges_src ON edges(src); CREATE INDEX edges_dst ON edges(dst);")?;
    tx.commit()?;
    Ok(edges.len())
}

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
    let tagged: i64 = store.conn.query_row("SELECT COUNT(*) FROM edges WHERE dst = ?1", [format!("tag:{canonical}")], |row| row.get(0))?;
    if tagged > 0 {
        start.push(format!("tag:{canonical}"));
    }
    let package: i64 = store.conn.query_row("SELECT COUNT(*) FROM edges WHERE dst = ?1", [format!("pkg:{query}")], |row| row.get(0))?;
    if package > 0 {
        start.push(format!("pkg:{query}"));
    }
    //M 文件：完整路径，或以 /查询 结尾。
    let normalized = query.replace('\\', "/");
    let mut statement = store.conn.prepare("SELECT path FROM files WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\' LIMIT 20")?;
    let like = format!("%/{}", normalized.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    for path in statement.query_map(params![normalized, like], |row| row.get::<_, String>(0))? {
        start.push(file_node(&path?));
    }
    //M 声明：全名或名字。
    let mut statement = store.conn.prepare(
        "SELECT f.path, s.qname FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qname = ?1 OR s.name = ?1 ORDER BY (s.qname = ?1) DESC, f.path LIMIT 20",
    )?;
    for row in statement.query_map([query], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))? {
        let (path, qname) = row?;
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
        let mut out_statement = store.conn.prepare_cached("SELECT dst FROM edges WHERE src = ?1 ORDER BY weight DESC, count DESC")?;
        let mut in_statement = store.conn.prepare_cached("SELECT src FROM edges WHERE dst = ?1 ORDER BY weight DESC, count DESC")?;
        while let Some((node, level)) = queue.pop_front() {
            if level >= depth {
                continue;
            }
            let mut neighbors: Vec<String> = out_statement.query_map([&node], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
            neighbors.extend(in_statement.query_map([&node], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
            for neighbor in neighbors {
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
        let mut statement = store.conn.prepare("SELECT src, dst FROM edges WHERE src LIKE 'file:%' AND dst NOT LIKE 'sym:%'")?;
        for row in statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))? {
            let (src, dst) = row?;
            visited.insert(src);
            visited.insert(dst);
        }
    }

    //M 节点之间的边。
    let mut edges = Vec::new();
    {
        let mut statement = store.conn.prepare_cached("SELECT dst, kind, weight, count, lines FROM edges WHERE src = ?1")?;
        for src in &visited {
            let rows = statement.query_map([src], |row| {
                Ok(EdgeOut {
                    src: src.clone(),
                    dst: row.get(0)?,
                    kind: row.get(1)?,
                    weight: row.get(2)?,
                    count: row.get(3)?,
                    lines: parse_lines(&row.get::<_, String>(4)?),
                })
            })?;
            for edge in rows {
                let edge = edge?;
                if visited.contains(&edge.dst) {
                    edges.push(edge);
                }
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
            let row: Option<(String, Option<String>)> = store
                .conn
                .prepare_cached("SELECT lang, summary FROM files WHERE path = ?1")?
                .query_row([rest], |row| Ok((row.get(0)?, row.get(1)?)))
                .ok();
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
            let row: Option<(String, i64)> = store
                .conn
                .prepare_cached("SELECT s.kind, s.line FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?1 AND s.qname = ?2 LIMIT 1")?
                .query_row(params![path, qname], |row| Ok((row.get(0)?, row.get(1)?)))
                .ok();
            if let Some((symbol_kind, line)) = row {
                node.detail = Some(symbol_kind);
                node.line = Some(line);
            }
        }
        _ => {}
    }
    Ok(node)
}

/// 网页模板（graph_view.html，编进程序里）。
const VIEW_TEMPLATE: &str = include_str!("graph_view.html");

/// 把查询结果写成单文件网页：数据嵌在页面里，不联网也能看。
pub fn to_html(out: &GraphOut) -> Result<String> {
    // 嵌进 <script> 里：把 </ 转义，免得数据里的文字提前结束脚本。
    let json = serde_json::to_string(out)?.replace("</", "<\\/");
    Ok(VIEW_TEMPLATE.replace("/*GRAPH_JSON*/", &json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_and_resolve_paths() {
        assert_eq!(join_path("src/channels", "../core/Engine.ts").as_deref(), Some("src/core/Engine.ts"));
        assert_eq!(join_path("", "../x"), None);
        let paths: HashSet<String> =
            ["src/core/Engine.ts", "src/main.rs", "src/store.rs", "pkg/util/a.go", "app/models.py"].iter().map(|s| s.to_string()).collect();
        let ts = FileInfo { id: 1, path: "src/channels/Feishu.ts".into(), lang: "typescript".into() };
        assert_eq!(resolve_import(&ts, "../core/Engine.js", &paths, None), Ok(vec!["src/core/Engine.ts".to_string()]));
        assert_eq!(resolve_import(&ts, "@larksuiteoapi/node-sdk/x", &paths, None), Err("@larksuiteoapi/node-sdk".to_string()));
        let rs = FileInfo { id: 2, path: "src/main.rs".into(), lang: "rust".into() };
        assert_eq!(resolve_import(&rs, "mod:store", &paths, None), Ok(vec!["src/store.rs".to_string()]));
        assert_eq!(resolve_import(&rs, "use:crate::store::Store", &paths, None), Ok(vec!["src/store.rs".to_string()]));
        assert_eq!(resolve_import(&rs, "use:anyhow::Result", &paths, None), Err("anyhow".to_string()));
        let go = FileInfo { id: 3, path: "cmd/main.go".into(), lang: "go".into() };
        assert_eq!(resolve_import(&go, "example.com/m/pkg/util", &paths, Some(("example.com/m", ""))), Ok(vec!["pkg/util/a.go".to_string()]));
        // go.mod 在子目录里（如 shell/go.mod）。
        let nested: HashSet<String> = ["shell/internal/storage/atomic.go"].iter().map(|s| s.to_string()).collect();
        let go = FileInfo { id: 5, path: "shell/cmd/main.go".into(), lang: "go".into() };
        assert_eq!(
            resolve_import(&go, "jmshell/internal/storage", &nested, Some(("jmshell", "shell"))),
            Ok(vec!["shell/internal/storage/atomic.go".to_string()])
        );
        assert_eq!(resolve_import(&go, "jmshellx/a", &nested, Some(("jmshell", "shell"))), Err("jmshellx/a".to_string()));
        let py = FileInfo { id: 4, path: "app/views.py".into(), lang: "python".into() };
        assert_eq!(resolve_import(&py, "rel:.models", &paths, None), Ok(vec!["app/models.py".to_string()]));
    }
}
