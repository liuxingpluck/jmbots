//! 摄取（增量）：扫一遍目录，内容变了的文件重新解析，删掉了的从索引里去掉，没变的不动；
//! 配了模型就给“还没打过标签或内容变了”的文件打标签，有新标签时再整合一次；最后重算关系图谱。
//! 第一次跑就是全量，之后每次跑就是更新（用户 11-03：“摄取去更新一下”）。
//!
//! 打标签按 model.concurrency 并发；每打完一个就写进数据库，中途停掉下次接着打剩下的。

use crate::ai;
use crate::config::Config;
use crate::doc;
use crate::graph;
use crate::parse::{self, Lang};
use crate::store::{FileData, Store};
use anyhow::Result;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::time::Instant;

/// 超过这么大的文件不收。
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 这些目录总是跳过。
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".git", ".memorycli", "__pycache__", ".venv", "vendor"];

/// 摄取的选项。
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// 要不要打 AI 标签（配了模型才有用）。
    pub ai: bool,
}

/// 摄取的结果。
#[derive(Debug, Default, Serialize)]
pub struct Stats {
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub tagged: usize,
    pub tag_failed: usize,
    pub tag_errors: Vec<String>,
    pub aliases_added: usize,
    /// 这次新算了向量的正文块。
    pub embedded: usize,
    pub edges: usize,
    pub ms: u128,
    pub totals: serde_json::Value,
}

/// 按扩展名定语言和种类；不收的返回 None。
fn classify(path: &str) -> Option<(String, &'static str)> {
    if let Some(lang) = Lang::from_path(path) {
        return Some((lang.name().to_string(), "code"));
    }
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" => Some(("markdown".into(), "doc")),
        "txt" | "rst" => Some(("text".into(), "doc")),
        "yaml" | "yml" | "toml" | "json" => Some((ext, "config")),
        _ => None,
    }
}

/// 解析一个文件，得到要写进数据库的全部东西。
pub fn build_file(path: &str, lang: &str, kind: &str, content: &str, hash: String) -> FileData {
    let mut data = FileData {
        path: path.to_string(),
        lang: lang.to_string(),
        kind: kind.to_string(),
        hash,
        size: content.len() as i64,
        lines: content.lines().count() as i64,
        ..Default::default()
    };
    if let Some(code_lang) = Lang::from_path(path) {
        let parsed = parse::parse(code_lang, content);
        let titles: Vec<(i64, String)> = parsed.symbols.iter().map(|symbol| (symbol.line, symbol.qname.clone())).collect();
        data.chunks = doc::window_chunks(content, &titles);
        data.symbols = parsed.symbols;
        data.refs = parsed.refs;
        data.imports = parsed.imports;
        data.mentions = doc::path_mentions(content);
    } else if lang == "markdown" {
        let (headings, chunks, mut mentions) = doc::markdown(content);
        mentions.extend(doc::path_mentions(content));
        data.symbols = headings;
        data.chunks = chunks;
        data.mentions = mentions;
    } else {
        data.chunks = doc::window_chunks(content, &[]);
        data.mentions = doc::path_mentions(content);
    }
    data
}

/// 列出要收的文件：(相对路径, 绝对路径)。遵守 .gitignore，跳过隐藏文件和常见的产物目录。
fn walk(root: &Path, config: &Config) -> Vec<(String, std::path::PathBuf)> {
    let excludes = config.exclude.clone();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !(entry.file_type().is_some_and(|kind| kind.is_dir()) && SKIP_DIRS.contains(&name.as_ref()))
        })
        .build();
    let mut files = Vec::new();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else { continue };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if excludes.iter().any(|pattern| !pattern.is_empty() && relative.contains(pattern.as_str())) {
            continue;
        }
        files.push((relative, entry.path().to_path_buf()));
    }
    files.sort();
    files
}

/// 读文本文件：太大、二进制、不是 UTF-8 的返回 None。
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// 摄取（增量）。log 打印进度（命令行打到 stderr，HTTP 不打）。
pub fn ingest(store: &mut Store, root: &Path, config: &Config, options: Options, log: &dyn Fn(&str)) -> Result<Stats> {
    let started = Instant::now();
    let mut stats = Stats::default();
    //M 0. 记下这个库索引的是哪个目录：多库搜索时靠它把相对路径拼成绝对路径。
    store.set_meta("root", &root.display().to_string())?;

    //M 1. 扫目录，按哈希比对；变了的文件多线程解析，解析结果在主线程写数据库（SQLite 连接只能一个线程用）。
    let existing: HashMap<String, (i64, String)> = store.files()?.into_iter().map(|file| (file.path, (file.id, file.hash))).collect();
    let mut seen: HashSet<String> = HashSet::new();
    // 要重新解析的：(相对路径, 语言, 种类, 内容, 哈希)。
    let mut todo: Vec<(String, String, &'static str, String, String)> = Vec::new();
    for (relative, absolute) in walk(root, config) {
        let Some((lang, kind)) = classify(&relative) else { continue };
        stats.scanned += 1;
        let Some(content) = read_text(&absolute) else {
            stats.skipped += 1;
            continue;
        };
        seen.insert(relative.clone());
        let hash = blake3::hash(content.as_bytes()).to_hex().to_string();
        match existing.get(&relative) {
            Some((_, old)) if *old == hash => {
                stats.unchanged += 1;
                continue;
            }
            Some(_) => stats.updated += 1,
            None => stats.added += 1,
        }
        todo.push((relative, lang, kind, content, hash));
    }
    let workers = std::thread::available_parallelism().map(|count| count.get()).unwrap_or(4).min(16);
    let queue = Mutex::new(todo.into_iter());
    let (sender, receiver) = mpsc::sync_channel::<FileData>(64);
    std::thread::scope(|scope| -> Result<()> {
        for _ in 0..workers {
            let sender = sender.clone();
            let queue = &queue;
            scope.spawn(move || {
                loop {
                    let job = queue.lock().expect("摄取任务队列锁中毒").next();
                    let Some((relative, lang, kind, content, hash)) = job else { break };
                    if sender.send(build_file(&relative, &lang, kind, &content, hash)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(sender);
        for data in receiver {
            store.replace_file(&data)?;
        }
        Ok(())
    })?;
    for (path, (id, _)) in &existing {
        if !seen.contains(path) {
            store.remove_file(*id)?;
            stats.removed += 1;
        }
    }
    log(&format!(
        "扫描完：新增 {}，更新 {}，删除 {}，没变 {}（{} ms）",
        stats.added,
        stats.updated,
        stats.removed,
        stats.unchanged,
        started.elapsed().as_millis()
    ));

    //M 2. AI 标签。
    if let Some(model) = config.model.as_ref().filter(|_| options.ai) {
        let pending: Vec<_> =
            store.files()?.into_iter().filter(|file| file.kind != "config" && file.tagged_hash.as_deref() != Some(file.hash.as_str())).collect();
        if !pending.is_empty() {
            log(&format!("给 {} 个文件打标签（{}，{} 个并发）……", pending.len(), model.model, model.concurrency));
            let vocabulary: Vec<String> = store.tag_vocabulary(150)?.into_iter().map(|(tag, _)| tag).collect();
            let before: HashSet<String> = vocabulary.iter().cloned().collect();
            let mut jobs = Vec::new();
            for file in pending {
                let Some(content) = read_text(&root.join(&file.path)) else { continue };
                let symbols = store.symbol_names(file.id, 60)?;
                jobs.push((file, content, symbols));
            }
            let total = jobs.len();
            let queue = Mutex::new(jobs.into_iter());
            let (sender, receiver) = mpsc::channel();
            let mut new_tags = false;
            std::thread::scope(|scope| -> Result<()> {
                for _ in 0..model.concurrency {
                    let sender = sender.clone();
                    let queue = &queue;
                    let vocabulary = &vocabulary;
                    scope.spawn(move || {
                        loop {
                            let job = queue.lock().expect("摄取任务队列锁中毒").next();
                            let Some((file, content, symbols)) = job else { break };
                            let result = ai::tag_file(model, &file.path, &content, &symbols, vocabulary);
                            if sender.send((file, result)).is_err() {
                                break;
                            }
                        }
                    });
                }
                drop(sender);
                for (done, (file, result)) in receiver.into_iter().enumerate() {
                    match result {
                        Ok(tagging) => {
                            new_tags |= tagging.tags.iter().any(|tag| !before.contains(tag));
                            store.set_ai(file.id, &tagging.summary, &tagging.tags, &file.hash)?;
                            stats.tagged += 1;
                            log(&format!("  [{}/{}] {}：{}", done + 1, total, file.path, tagging.tags.join("、")));
                        }
                        Err(error) => {
                            stats.tag_failed += 1;
                            if stats.tag_errors.len() < 5 {
                                stats.tag_errors.push(format!("{}：{error:#}", file.path));
                            }
                            log(&format!("  [{}/{}] {} 失败：{error:#}", done + 1, total, file.path));
                        }
                    }
                }
                Ok(())
            })?;

            //M 3. 有新标签就整合一次。
            if new_tags {
                let vocabulary = store.tag_vocabulary(400)?;
                match ai::merge_tags(model, &vocabulary) {
                    Ok(groups) => {
                        stats.aliases_added = store.set_aliases(&groups)?;
                        log(&format!("整合标签：并了 {} 个别名", stats.aliases_added));
                    }
                    Err(error) => {
                        stats.tag_errors.push(format!("整合标签失败：{error:#}"));
                        log(&format!("整合标签失败：{error:#}"));
                    }
                }
            }
        }
    }

    //M 3.5 向量：配了嵌入模型就给还没有向量的正文块补算（一批 16 块）。出错只记下来，不挡摄取。
    if let Some(embedding) = config.embedding.as_ref().filter(|_| options.ai) {
        let limit = embedding.max_chars;
        'outer: loop {
            let pending = store.chunks_needing_vectors(&embedding.model, 256)?;
            if pending.is_empty() {
                break;
            }
            log(&format!("算向量：还有 {} 块以上（{}）……", pending.len(), embedding.model));
            for batch in pending.chunks(16) {
                let inputs: Vec<String> = batch.iter().map(|(_, body)| body.chars().take(limit).collect()).collect();
                match ai::embed(embedding, &inputs) {
                    Ok(vectors) => {
                        let items: Vec<(i64, Vec<f32>)> = batch.iter().map(|(id, _)| *id).zip(vectors).collect();
                        store.set_vectors(&embedding.model, &items)?;
                        stats.embedded += items.len();
                    }
                    Err(error) => {
                        stats.tag_errors.push(format!("算向量失败：{error:#}"));
                        log(&format!("算向量失败，这次先不算了：{error:#}"));
                        break 'outer;
                    }
                }
            }
        }
        log(&format!("向量：这次算了 {} 块", stats.embedded));
    }

    //M 4. 重算图谱：文件、标签都没变（而且图已经算过）就不用重算，大项目里这一步要十几秒。
    let changed = stats.added + stats.updated + stats.removed + stats.tagged + stats.aliases_added > 0;
    let edge_count = store.edge_count()?;
    stats.edges = if changed || edge_count == 0 { graph::rebuild(store, root)? } else { edge_count as usize };
    stats.totals = store.counts()?;
    stats.ms = started.elapsed().as_millis();
    log(&format!("图谱：{} 条边，用时 {} ms", stats.edges, stats.ms));
    Ok(stats)
}
