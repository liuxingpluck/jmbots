//! HTTP 服务（很精简，大多回 JSON）。可以挂一个库，也可以挂好几个（serve --libs 目录）：
//!   GET  /health                           活着吗；挂了哪些库、各有多少东西
//!   POST /ingest   {"ai": true, "lib": 名}  开始摄取（增量更新），马上返回，不等做完；ai 写 false 就不打标签；只挂一个库时 lib 可以不写
//!   GET  /ingest?lib=名                    这个库的摄取在不在跑、什么时候开始的、做完的统计或出错原因
//!   GET  /search?q=词&limit=10&lib=a,b     搜索；lib 不写就搜全部库。每条命中带库名（lib）和绝对路径（abs_path）
//!   GET  /graph?q=名字&depth=1&lib=名       关系图谱：从名字（文件、声明、标签、节点 ID）出发走 depth 步；不写 q 是整张图；
//!                                          lib 不写用第一个库。加 &format=html 返回能拖、缩放、点节点的单文件网页
//!
//! 请求一个一个处理；摄取放在后台线程、用自己的数据库连接（框架设计第 8 节第 5 步），
//! 大库摄取几十分钟时搜索照常回（SQLite WAL：一边写一边读）。

use crate::config::Config;
use crate::libs::{self, Lib};
use crate::store::Store;
use crate::{graph, ingest};
use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 一个库的摄取任务（后台线程跑）。
#[derive(Debug, Clone, Serialize)]
pub struct Job {
    /// 还在跑。
    running: bool,
    /// 什么时候开始的（Unix 秒）。
    started_at: u64,
    /// 做完多久了（秒）；还在跑时没有。
    seconds: Option<u64>,
    /// 做完的统计。
    stats: Option<Value>,
    /// 出错的原因。
    error: Option<String>,
}

/// 各库的摄取任务：库名 → 最近一次。
pub type Jobs = Arc<Mutex<HashMap<String, Job>>>;

/// 一张空的摄取任务表（自己起 HTTP 服务、又想复用这里的接口时用，如 jmbots 的本地壳子 local/）。
pub fn new_jobs() -> Jobs {
    Arc::new(Mutex::new(HashMap::new()))
}

/// 现在是 Unix 第几秒。
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

/// 起服务，一直跑。
pub fn serve(libs: Vec<Lib>, config: Config, host: &str, port: u16) -> Result<()> {
    let server = tiny_http::Server::http((host, port)).map_err(|error| anyhow!("监听 {host}:{port} 失败：{error}"))?;
    let names: Vec<&str> = libs.iter().map(|lib| lib.name.as_str()).collect();
    eprintln!("memorycli HTTP 服务：http://{host}:{port}（{} 个库：{}）", libs.len(), names.join("、"));
    let jobs: Jobs = new_jobs();
    for mut request in server.incoming_requests() {
        let (status, body, content_type) = respond(&mut request, &libs, &config, &jobs);
        let response = tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(tiny_http::Header::from_bytes("Content-Type", content_type).expect("固定的头"))
            .with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").expect("固定的头"));
        let _ = request.respond(response);
    }
    Ok(())
}

/// 处理一个请求，给出（状态码、正文、Content-Type），还没回给对方。serve 用它；自己起 HTTP 服务的程序（jmbots 的本地壳子）
/// 把不归自己管的路径交给它，接口和这里完全一样。
pub fn respond(request: &mut tiny_http::Request, libs: &[Lib], config: &Config, jobs: &Jobs) -> (u16, String, &'static str) {
    match handle(request, libs, config, jobs) {
        Ok(Reply::Json(value)) => (200, serde_json::to_string_pretty(&value).unwrap_or_default(), "application/json; charset=utf-8"),
        Ok(Reply::Html(page)) => (200, page, "text/html; charset=utf-8"),
        Err((status, message)) => (status, serde_json::to_string_pretty(&json!({ "error": message })).unwrap_or_default(), "application/json; charset=utf-8"),
    }
}

/// 一个请求的回复：大多是 JSON，/graph?format=html 是网页。
enum Reply {
    /// JSON。
    Json(Value),
    /// 单文件网页。
    Html(String),
}

/// 按名字找一个库的下标；不写名字时，只挂一个库就是它，挂了好几个就用第一个（first_if_many）或报错。
fn lib_index(libs: &[Lib], name: Option<&str>, first_if_many: bool) -> Result<usize, (u16, String)> {
    let all = || libs.iter().map(|lib| lib.name.as_str()).collect::<Vec<_>>().join("、");
    match name.filter(|name| !name.trim().is_empty()) {
        Some(name) => libs.iter().position(|lib| lib.name == name).ok_or((400, format!("没有叫 {name} 的库；有：{}", all()))),
        None if libs.len() == 1 || first_if_many => Ok(0),
        None => Err((400, format!("挂了好几个库，要写 lib；有：{}", all()))),
    }
}

/// 处理一个请求。出错时返回（状态码, 原因）。
fn handle(request: &mut tiny_http::Request, libs: &[Lib], config: &Config, jobs: &Jobs) -> Result<Reply, (u16, String)> {
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let params = parse_query(query);
    let get = |name: &str| params.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
    let internal = |error: anyhow::Error| (500, format!("{error:#}"));
    match (request.method(), path) {
        (tiny_http::Method::Get, "/health") => {
            let mut list = Vec::new();
            for lib in libs.iter() {
                let root = lib.root.as_ref().map(|root| root.display().to_string());
                list.push(json!({ "name": lib.name, "root": root, "totals": lib.store.counts().map_err(internal)? }));
            }
            //M 只挂一个库时顶层照旧给 root 和 totals（老调用方只认这两个）。
            let single = if list.len() == 1 { Some((list[0]["root"].clone(), list[0]["totals"].clone())) } else { None };
            let mut out = json!({ "ok": true, "libs": list });
            if let Some((root, totals)) = single {
                out["root"] = root;
                out["totals"] = totals;
            }
            Ok(Reply::Json(out))
        }
        (tiny_http::Method::Post, "/ingest") => {
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            let options: Value = if body.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&body).map_err(|error| (400, format!("请求体不是 JSON：{error}")))?
            };
            let ai = options["ai"].as_bool().unwrap_or(true);
            let index = lib_index(libs, options["lib"].as_str(), false)?;
            let lib = &libs[index];
            let root = lib.root.clone().ok_or((400, format!("库 {} 没记着它索引的是哪个目录，摄取不了；先用命令行 ingest --root 跑一次", lib.name)))?;
            //G 同一个库同时只摄取一份。
            let mut table = jobs.lock().map_err(|_| (500, "任务表坏了".to_string()))?;
            if table.get(&lib.name).is_some_and(|job| job.running) {
                return Err((409, format!("库 {} 正在摄取，用 GET /ingest?lib={} 看进度", lib.name, lib.name)));
            }
            let started_at = now();
            table.insert(lib.name.clone(), Job { running: true, started_at, seconds: None, stats: None, error: None });
            drop(table);
            //M 后台线程用自己的连接摄取，做完把结果记进任务表；这边马上回，搜索不用等。
            let (name, db, config, jobs) = (lib.name.clone(), lib.db.clone(), config.clone(), Arc::clone(jobs));
            std::thread::spawn(move || {
                let result = Store::open(&db).and_then(|mut store| ingest::ingest(&mut store, &root, &config, ingest::Options { ai }, &|_| {}));
                let (stats, error) = match result {
                    Ok(stats) => (serde_json::to_value(stats).ok(), None),
                    Err(error) => (None, Some(format!("{error:#}"))),
                };
                if let Ok(mut table) = jobs.lock() {
                    table.insert(name, Job { running: false, started_at, seconds: Some(now().saturating_sub(started_at)), stats, error });
                }
            });
            Ok(Reply::Json(json!({ "lib": lib.name, "started": true, "progress": format!("GET /ingest?lib={}", lib.name) })))
        }
        (tiny_http::Method::Get, "/ingest") => {
            let index = lib_index(libs, get("lib"), false)?;
            let name = &libs[index].name;
            let table = jobs.lock().map_err(|_| (500, "任务表坏了".to_string()))?;
            Ok(Reply::Json(match table.get(name) {
                Some(job) => json!({ "lib": name, "job": job }),
                None => json!({ "lib": name, "job": null }),
            }))
        }
        (tiny_http::Method::Get, "/search") => {
            let text = get("q").filter(|text| !text.trim().is_empty()).ok_or((400, "要写 q（搜什么）".to_string()))?;
            let limit = get("limit").and_then(|value| value.parse().ok()).unwrap_or(10usize).clamp(1, 100);
            let picked = libs::pick(libs, &libs::parse_names(get("lib"))).map_err(|error| (400, format!("{error:#}")))?;
            Ok(Reply::Json(serde_json::to_value(libs::search(&picked, text, limit, config.embedding.as_ref()).map_err(internal)?).unwrap_or_default()))
        }
        (tiny_http::Method::Get, "/graph") => {
            let depth = get("depth").and_then(|value| value.parse().ok()).unwrap_or(1usize).clamp(1, 4);
            let index = lib_index(libs, get("lib"), true)?;
            let lib = &libs[index];
            let out = graph::query(&lib.store, get("q"), depth).map_err(internal)?;
            //M 要网页就给 graph --html 那一份（能拖、缩放、点节点），不让调用方自己拼一张画不全的。
            if get("format") == Some("html") {
                return Ok(Reply::Html(graph::to_html(&out).map_err(internal)?));
            }
            Ok(Reply::Json(serde_json::to_value(out).unwrap_or_default()))
        }
        _ => Err((404, format!("没有这个接口：{} {path}；有 GET /health、POST /ingest、GET /search?q=、GET /graph?q=", request.method()))),
    }
}

/// 解析 ?a=1&b=中文（百分号编码、+ 当空格）。
pub fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(key), decode(value))
        })
        .collect()
}

/// 百分号解码。
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = |byte: u8| (byte as char).to_digit(16);
                match (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push((high * 16 + low) as u8);
                        index += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_decoding() {
        let params = parse_query("q=%E8%AE%B0%E5%BF%86+handle&limit=5&x=%zz");
        assert_eq!(params[0], ("q".to_string(), "记忆 handle".to_string()));
        assert_eq!(params[1].1, "5");
        assert_eq!(params[2].1, "%zz");
    }
}
