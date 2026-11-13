//! 壳子的 HTTP 接口（docs/界面/01_界面设计.md 第 4.3 节）：监听 0.0.0.0:local.port，取代独立的 memorycli 服务（路径一样，后端不用改）。
//!   POST /rag/index {lib?}     建 RAG 索引（增量，后台跑，马上返回）；不写 lib 是全部库
//!   GET  /rag/index?lib=名     这个库最近一次建索引：在不在跑、用了几秒、统计或出错原因
//!   GET  /rag/search?q=&limit=&lib=a,b   RAG 检索：片段 + BM25 分数
//!   POST /restart              重启后端（网页设置“重连”里的“重启服务”）：停掉它，守护马上拉起来；没有守护时回 {managed: false}
//!   别的（/health、/ingest、/search、/graph）交给 memorycli::http::respond，和原来的 memorycli 服务完全一样。
//! 请求一个一个处理；建索引放在后台线程、自己开数据库连接，搜索不用等。

use crate::config::Settings;
use crate::supervisor::Supervisor;
use crate::{memory, rag};
use anyhow::{Result, anyhow};
use memorycli::libs::Lib;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 一个库最近一次建 RAG 索引。
#[derive(Debug, Clone, Serialize)]
struct RagJob {
    /// 还在跑。
    running: bool,
    /// 什么时候开始的（Unix 秒）。
    started_at: u64,
    /// 用了几秒；还在跑时没有。
    seconds: Option<u64>,
    /// 做完的统计。
    stats: Option<rag::IndexStats>,
    /// 出错的原因。
    error: Option<String>,
}

/// 各库建索引的情况：库名 → 最近一次。
type RagJobs = Arc<Mutex<HashMap<String, RagJob>>>;

/// 现在是 Unix 第几秒。
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

/// 回一个 JSON。
fn json_reply(status: u16, value: &Value) -> (u16, String, &'static str) {
    (status, serde_json::to_string_pretty(value).unwrap_or_default(), "application/json; charset=utf-8")
}

/// 挑库：names 为空就是全部；有不认识的名字就报错。
fn pick<'a>(libs: &'a [Lib], names: &[String]) -> Result<Vec<&'a Lib>, (u16, String)> {
    memorycli::libs::pick(libs, names).map_err(|error| (400, format!("{error:#}")))
}

/// 处理一个 /rag/ 开头的请求。
fn rag_respond(request: &mut tiny_http::Request, settings: &Settings, libs: &[Lib], jobs: &RagJobs) -> Result<Value, (u16, String)> {
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let params = memorycli::http::parse_query(query);
    let get = |name: &str| params.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
    match (request.method(), path) {
        (tiny_http::Method::Post, "/rag/index") => {
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            let input: Value = if body.trim().is_empty() { json!({}) } else { serde_json::from_str(&body).map_err(|error| (400, format!("请求体不是 JSON：{error}")))? };
            let names = memorycli::libs::parse_names(input.get("lib").and_then(Value::as_str));
            let mut started = Vec::new();
            let mut running = Vec::new();
            for lib in pick(libs, &names)? {
                let mut table = jobs.lock().map_err(|_| (500, "任务表坏了".to_string()))?;
                if table.get(&lib.name).is_some_and(|job| job.running) {
                    running.push(lib.name.clone());
                    continue;
                }
                table.insert(lib.name.clone(), RagJob { running: true, started_at: now(), seconds: None, stats: None, error: None });
                drop(table);
                let (rag_dir, name, db, jobs) = (settings.rag_dir.clone(), lib.name.clone(), lib.db.clone(), Arc::clone(jobs));
                std::thread::spawn(move || {
                    let result = rag::index_lib(&rag_dir, &name, &db, &|_| ());
                    if let Ok(mut table) = jobs.lock() {
                        let started_at = table.get(&name).map(|job| job.started_at).unwrap_or_else(now);
                        let (stats, error) = match result {
                            Ok(stats) => (Some(stats), None),
                            Err(error) => (None, Some(format!("{error:#}"))),
                        };
                        table.insert(name, RagJob { running: false, started_at, seconds: Some(now().saturating_sub(started_at)), stats, error });
                    }
                });
                started.push(lib.name.clone());
            }
            Ok(json!({ "started": started, "already_running": running }))
        }
        (tiny_http::Method::Get, "/rag/index") => {
            let name = get("lib").ok_or((400, "要写 lib".to_string()))?;
            let table = jobs.lock().map_err(|_| (500, "任务表坏了".to_string()))?;
            Ok(json!({ "lib": name, "job": table.get(name) }))
        }
        (tiny_http::Method::Get, "/rag/search") => {
            let text = get("q").filter(|text| !text.trim().is_empty()).ok_or((400, "要写 q（搜什么）".to_string()))?;
            let limit = get("limit").and_then(|value| value.parse::<usize>().ok()).unwrap_or(10).clamp(1, 100);
            let chosen: Vec<(String, Option<std::path::PathBuf>)> = pick(libs, &memorycli::libs::parse_names(get("lib")))?.iter().map(|lib| (lib.name.clone(), lib.root.clone())).collect();
            let out = rag::search(&settings.rag_dir, &chosen, text, limit).map_err(|error| (500, format!("{error:#}")))?;
            serde_json::to_value(out).map_err(|error| (500, error.to_string()))
        }
        _ => Err((404, format!("没有这个接口：{} {path}；RAG 有 POST /rag/index、GET /rag/index?lib=、GET /rag/search?q=", request.method()))),
    }
}

/// 处理 /autostart：GET 看开机自启开着没有，POST {"enabled": true|false} 改。
fn autostart_respond(request: &mut tiny_http::Request) -> Result<Value, (u16, String)> {
    if *request.method() == tiny_http::Method::Post {
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);
        let input: Value = serde_json::from_str(&body).map_err(|error| (400, format!("请求体不是 JSON：{error}")))?;
        let on = input.get("enabled").and_then(Value::as_bool).ok_or((400, "要写 enabled：true 或 false".to_string()))?;
        crate::autostart::set(on).map_err(|error| (500, format!("{error:#}")))?;
    }
    Ok(json!({ "enabled": crate::autostart::enabled() }))
}

/// 处理守护的接口：/update（版本更新）、/restart（重启后端）。没有守护（serve 命令）时说清楚。
fn update_respond(request: &tiny_http::Request, supervisor: Option<&Arc<Supervisor>>) -> Result<Value, (u16, String)> {
    let Some(supervisor) = supervisor else {
        return Ok(json!({ "managed": false }));
    };
    match (request.method(), request.url()) {
        (tiny_http::Method::Get, "/update") => Ok(supervisor.status()),
        (tiny_http::Method::Post, "/update/apply") => supervisor.apply().map(|()| json!({ "ok": true })).map_err(|reason| (409, reason)),
        (tiny_http::Method::Post, "/restart") => supervisor.restart().map(|()| json!({ "ok": true })).map_err(|reason| (409, reason)),
        _ => Err((404, format!("没有这个接口：{} {}", request.method(), request.url()))),
    }
}

/// 起接口，一直跑（serve 命令用它，没有守护）。
///
/// 输入：算好的配置。输出：监听不上时报错（比如老的 memorycli 服务还占着端口）；正常不返回。
/// 副作用：打开记忆库（库目录不存在时建出来）；监听端口；建 RAG 索引时写 RAG 目录。
pub fn serve(settings: &Settings) -> Result<()> {
    serve_with(settings, None)
}

/// 起接口，一直跑（窗口模式的后台线程用它，带守护，多几个 /update 接口）。
///
/// 输入：算好的配置、守护。输出、副作用同 serve。
pub fn serve_with(settings: &Settings, supervisor: Option<Arc<Supervisor>>) -> Result<()> {
    let libs = memory::open_libs(settings)?;
    let config = memory::memorycli_config(settings)?;
    let jobs = memorycli::http::new_jobs();
    let rag_jobs: RagJobs = Arc::new(Mutex::new(HashMap::new()));
    let server = tiny_http::Server::http((settings.listen_host.as_str(), settings.listen_port))
        .map_err(|error| anyhow!("监听 {}:{} 失败（是不是老的 memorycli 服务还占着这个端口？）：{error}", settings.listen_host, settings.listen_port))?;
    eprintln!("jmbots 本地壳子的接口：http://{}:{}（{} 个记忆库）", settings.listen_host, settings.listen_port, libs.len());
    for mut request in server.incoming_requests() {
        let (status, body, content_type) = if request.url().starts_with("/autostart") {
            match autostart_respond(&mut request) {
                Ok(value) => json_reply(200, &value),
                Err((status, message)) => json_reply(status, &json!({ "error": message })),
            }
        } else if request.url().starts_with("/update") || request.url() == "/restart" {
            match update_respond(&request, supervisor.as_ref()) {
                Ok(value) => json_reply(200, &value),
                Err((status, message)) => json_reply(status, &json!({ "error": message })),
            }
        } else if request.url().starts_with("/rag/") {
            match rag_respond(&mut request, settings, &libs, &rag_jobs) {
                Ok(value) => json_reply(200, &value),
                Err((status, message)) => json_reply(status, &json!({ "error": message })),
            }
        } else {
            memorycli::http::respond(&mut request, &libs, &config, &jobs)
        };
        let response = tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(tiny_http::Header::from_bytes("Content-Type", content_type).expect("固定的头"))
            .with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").expect("固定的头"));
        let _ = request.respond(response);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Overrides, resolve};
    use crate::test_support::temp_dir;

    /// 找一个没人用的端口。
    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").and_then(|listener| listener.local_addr()).map(|address| address.port()).expect("拿端口")
    }

    #[test]
    fn serves_memorycli_routes_and_rag() {
        let runtime = temp_dir("server");
        let docs = runtime.join("资料");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("飞书发件箱.md"), "# 飞书发件箱\n\n往发件箱放一份 Markdown，服务每五秒取一次。\n").unwrap();
        let port = free_port();
        // 测试只听本机：听 0.0.0.0 时 Windows 防火墙可能弹窗问。
        let settings = resolve(&Overrides { runtime: Some(runtime.clone()), port: Some(port), host: Some("127.0.0.1".into()), ..Overrides::default() }, &|_| None, &runtime);
        memory::ingest(&settings, "资料库", Some(&docs), false, &|_| ()).expect("摄取");
        let serving = settings.clone();
        std::thread::spawn(move || serve(&serving).expect("起接口"));
        let agent = crate::backend::agent(std::time::Duration::from_secs(10));
        let base = format!("http://127.0.0.1:{port}");
        //M 等它起来。
        let mut health = None;
        for _ in 0..50 {
            if let Ok(value) = crate::backend::get_json(&agent, &format!("{base}/health")) {
                health = Some(value);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let health = health.expect("接口起来了");
        assert_eq!(health["libs"][0]["name"], "资料库");
        // memorycli 原来的搜索：每条带 RRF 分数。
        let found = crate::backend::get_json(&agent, &format!("{base}/search?q=%E5%8F%91%E4%BB%B6%E7%AE%B1")).expect("搜索");
        assert!(found["hits"][0]["score"].as_f64().unwrap_or(0.0) > 0.0, "{found}");
        // RAG：先建索引，等它做完，再搜。
        let index_url = format!("{base}/rag/index");
        let started = agent.post(index_url.as_str()).send("{}").expect("建索引").body_mut().read_to_string().expect("回答");
        assert!(started.contains("资料库"), "{started}");
        for _ in 0..100 {
            let job = crate::backend::get_json(&agent, &format!("{base}/rag/index?lib=%E8%B5%84%E6%96%99%E5%BA%93")).expect("进度");
            if job["job"]["running"] == false {
                assert!(job["job"]["error"].is_null(), "{job}");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let rag = crate::backend::get_json(&agent, &format!("{base}/rag/search?q=%E5%8F%91%E4%BB%B6%E7%AE%B1")).expect("RAG 检索");
        assert_eq!(rag["hits"][0]["path"], "飞书发件箱.md", "{rag}");
        assert!(rag["hits"][0]["score"].as_f64().unwrap_or(0.0) > 0.0);
        // 写错的接口回 404。
        assert!(crate::backend::get_json(&agent, &format!("{base}/rag/nope")).is_err());
    }
}
