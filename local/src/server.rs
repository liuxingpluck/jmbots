//! 壳子的 HTTP 接口（docs/界面/01_界面设计.md 第 4.3 节）：监听 0.0.0.0:local.port。2026-11-14 起基地只承载：
//!   GET  /update、POST /update/apply   主后端的版本更新（supervisor.rs）
//!   POST /restart[?service=名]          重启主后端；带 service 重启那个托管服务（services.rs）
//!   GET  /services                      每个托管服务的端口、程序在不在、健康
//!   GET/POST /autostart                 开机自启
//!   POST /notify                        本机弹 Windows 右下角通知（{title, body, level?, url?}）
//!   GET  /version                       壳子自己的版本和编译时刻（给网页左下角显示）
//!   别的路径（/health /search /ingest /graph /rag/* /v1/*……）原样转给记忆服务（local.memory_url，默认托管的 jmbots-memory）：
//!   记忆库、RAG 已经搬出壳子，后端的 engine.index_url 不用改；记忆服务没开时回 503 和一句原因（不是 404）。
//! 壳子起接口不依赖任何记忆库：记忆服务挂了，更新、重启照常可用。
//! 请求一个一个处理（tiny_http）；转发有超时。

use crate::config::Settings;
use crate::services::Services;
use crate::supervisor::Supervisor;
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

/// 转发给记忆服务最多等多久（入库是后台跑的，搜索是毫秒级，这个够用）。
const FORWARD_TIMEOUT: Duration = Duration::from_secs(60);

/// 回一个 JSON。
fn json_reply(status: u16, value: &Value) -> (u16, Vec<u8>, String) {
    (status, serde_json::to_string_pretty(value).unwrap_or_default().into_bytes(), "application/json; charset=utf-8".to_string())
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

/// 从查询串里取一项。
fn query_value(url: &str, name: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| value.to_string())
    })
}

/// 处理守护的接口：/update（版本更新）、/restart（重启主后端或某个托管服务）、/services。没有守护（serve 不带 --supervise）时说清楚。
fn host_respond(request: &tiny_http::Request, supervisor: Option<&Arc<Supervisor>>, services: Option<&Arc<Services>>) -> Result<Value, (u16, String)> {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("");
    if path == "/services" {
        return Ok(services.map_or_else(|| json!({ "managed": false, "services": [] }), |services| services.status()));
    }
    if path == "/restart" {
        if let Some(name) = query_value(&url, "service").filter(|name| !name.is_empty() && name != "backend") {
            let services = services.ok_or((409, "没有守护，基地管不了托管服务".to_string()))?;
            return services.restart(&name).map(|()| json!({ "ok": true, "service": name })).map_err(|reason| (409, reason));
        }
    }
    let Some(supervisor) = supervisor else {
        return Ok(json!({ "managed": false }));
    };
    match (request.method(), path) {
        (tiny_http::Method::Get, "/update") => Ok(supervisor.status()),
        (tiny_http::Method::Post, "/update/apply") => supervisor.apply().map(|()| json!({ "ok": true })).map_err(|reason| (409, reason)),
        (tiny_http::Method::Post, "/restart") => supervisor.restart().map(|()| json!({ "ok": true })).map_err(|reason| (409, reason)),
        _ => Err((404, format!("没有这个接口：{} {url}", request.method()))),
    }
}

/// 把请求原样转给记忆服务，回它的状态码、正文、类型；连不上回 503。
fn forward(request: &mut tiny_http::Request, memory_url: &str) -> (u16, Vec<u8>, String) {
    let target = format!("{memory_url}{}", request.url());
    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);
    let content_type = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Content-Type"))
        .map_or_else(|| "application/json".to_string(), |header| header.value.as_str().to_string());
    let agent = crate::backend::agent(FORWARD_TIMEOUT);
    let sent = match request.method() {
        tiny_http::Method::Get => agent.get(&target).call(),
        tiny_http::Method::Delete => agent.delete(&target).call(),
        tiny_http::Method::Post => agent.post(&target).header("Content-Type", &content_type).send(&body[..]),
        tiny_http::Method::Put => agent.put(&target).header("Content-Type", &content_type).send(&body[..]),
        other => return json_reply(405, &json!({ "error": format!("记忆服务转发不支持 {other}") })),
    };
    match sent {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let kind = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("application/json; charset=utf-8").to_string();
            let bytes = response.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec().unwrap_or_default();
            (status, bytes, kind)
        }
        Err(error) => json_reply(503, &json!({ "error": format!("记忆服务没开或连不上（{memory_url}）：{error}；记忆、RAG 已搬到 jmbots-memory，基地托管它（GET /services 看状态）") })),
    }
}

/// 处理 POST /notify：只许本机，弹一条右下角通知。
fn notify_respond(request: &mut tiny_http::Request) -> Result<Value, (u16, String)> {
    if !crate::notify::is_loopback(request.remote_addr().copied()) {
        return Err((403, "通知接口只许本机调用".to_string()));
    }
    if *request.method() != tiny_http::Method::Post {
        return Err((405, "请用 POST /notify，体是 {title, body, level?, url?}".to_string()));
    }
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    let notice = crate::notify::from_json_str(&body).map_err(|error| (400, error.to_string()))?;
    crate::notify::show(&notice);
    Ok(json!({ "ok": true }))
}

/// 起接口，一直跑（serve 命令用它，没有守护）。
///
/// 输入：算好的配置。输出：监听不上时报错；正常不返回。副作用：监听端口。
pub fn serve(settings: &Settings) -> Result<()> {
    serve_with(settings, None, None)
}

/// 起接口，一直跑（窗口模式、serve --supervise 用它，带守护，多几个 /update /services 接口）。
///
/// 输入：算好的配置、主后端的守护、托管服务表。输出、副作用同 serve。不打开任何记忆库。
pub fn serve_with(settings: &Settings, supervisor: Option<Arc<Supervisor>>, services: Option<Arc<Services>>) -> Result<()> {
    let server = tiny_http::Server::http((settings.listen_host.as_str(), settings.listen_port))
        .map_err(|error| anyhow!("监听 {}:{} 失败（是不是老的 memorycli 服务或老基地还占着这个端口？）：{error}", settings.listen_host, settings.listen_port))?;
    eprintln!("jmbots 基地的接口：http://{}:{}（记忆接口转给 {}）", settings.listen_host, settings.listen_port, settings.memory_url);
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let path = url.split('?').next().unwrap_or("").to_string();
        let (status, body, content_type) = if path.starts_with("/autostart") {
            match autostart_respond(&mut request) {
                Ok(value) => json_reply(200, &value),
                Err((status, message)) => json_reply(status, &json!({ "error": message })),
            }
        } else if path.starts_with("/update") || path == "/restart" || path == "/services" {
            match host_respond(&request, supervisor.as_ref(), services.as_ref()) {
                Ok(value) => json_reply(200, &value),
                Err((status, message)) => json_reply(status, &json!({ "error": message })),
            }
        } else if path == "/notify" {
            match notify_respond(&mut request) {
                Ok(value) => json_reply(200, &value),
                Err((status, message)) => json_reply(status, &json!({ "error": message })),
            }
        } else if path == "/version" {
            // 壳子自己的版本和编译时刻，给网页左下角显示。
            json_reply(200, &json!({
                "version": env!("CARGO_PKG_VERSION"),
                "builtAt": option_env!("JMBOTS_BUILT_AT").and_then(|text| text.parse::<u64>().ok()).unwrap_or(0),
            }))
        } else {
            forward(&mut request, &settings.memory_url)
        };
        let response = tiny_http::Response::from_data(body)
            .with_status_code(status)
            .with_header(tiny_http::Header::from_bytes("Content-Type", content_type.as_bytes()).unwrap_or_else(|()| tiny_http::Header::from_bytes("Content-Type", "application/json").expect("固定的头")))
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

    /// 起一个假记忆服务：/search 回固定 JSON，POST /v1/search 回请求体（看转发带没带正文）。返回端口。
    fn fake_memory() -> u16 {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("起假记忆服务");
        let port = server.server_addr().to_ip().expect("地址").port();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let reply = if request.url().starts_with("/search") { r#"{"hits":[{"path":"飞书发件箱.md","score":1.0}]}"#.to_string() } else { body };
                let header = tiny_http::Header::from_bytes("Content-Type", "application/json").expect("头");
                let _ = request.respond(tiny_http::Response::from_string(reply).with_header(header));
            }
        });
        port
    }

    /// 等接口起来。
    fn wait_up(agent: &ureq::Agent, base: &str) {
        for _ in 0..50 {
            if crate::backend::get_json(agent, &format!("{base}/services")).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("接口没起来");
    }

    #[test]
    fn starts_without_memory_and_forwards_when_memory_is_up() {
        let runtime = temp_dir("server");
        //M 记忆库目录是个坏文件（原来会让整个接口起不来）：现在壳子根本不碰它。
        std::fs::create_dir_all(runtime.join("data").join("index")).unwrap();
        std::fs::write(runtime.join("data").join("index").join("libs"), "坏的").unwrap();
        let (port, dead) = (free_port(), free_port());
        let settings = resolve(&Overrides { runtime: Some(runtime.clone()), port: Some(port), host: Some("127.0.0.1".into()), ..Overrides::default() }, &|_| None, &runtime);
        let mut settings = settings;
        settings.memory_url = format!("http://127.0.0.1:{dead}");
        let serving = settings.clone();
        std::thread::spawn(move || serve(&serving).expect("起接口"));
        let agent = crate::backend::agent(std::time::Duration::from_secs(10));
        let base = format!("http://127.0.0.1:{port}");
        wait_up(&agent, &base);
        //M 记忆服务没开：更新接口照常（没有守护就说 managed false），记忆接口回 503 不是 404。
        assert_eq!(crate::backend::get_json(&agent, &format!("{base}/update")).expect("更新")["managed"], false);
        let mut response = agent.get(format!("{base}/search?q=x").as_str()).call().expect("请求");
        assert_eq!(response.status().as_u16(), 503);
        assert!(response.body_mut().read_to_string().unwrap().contains("jmbots-memory"));
        //M 记忆服务开着：原样转发，GET 带查询串，POST 带正文。
        let memory = fake_memory();
        let port2 = free_port();
        let mut settings2 = settings.clone();
        settings2.listen_port = port2;
        settings2.memory_url = format!("http://127.0.0.1:{memory}");
        std::thread::spawn(move || serve(&settings2).expect("起接口"));
        let base2 = format!("http://127.0.0.1:{port2}");
        wait_up(&agent, &base2);
        let found = crate::backend::get_json(&agent, &format!("{base2}/search?q=%E5%8F%91%E4%BB%B6%E7%AE%B1")).expect("搜索");
        assert_eq!(found["hits"][0]["path"], "飞书发件箱.md");
        let echoed = agent.post(format!("{base2}/v1/search").as_str()).header("Content-Type", "application/json").send(r#"{"query":"退货"}"#).expect("转发").body_mut().read_to_string().unwrap();
        assert!(echoed.contains("退货"), "{echoed}");
    }

    #[test]
    fn notify_accepts_local_post_and_rejects_bad_body() {
        let runtime = temp_dir("server-notify");
        //M 优先用 15763（>15000、不含数字 4），被占再退回系统分配的空闲端口。
        let port = std::net::TcpListener::bind("127.0.0.1:15763").ok()
            .and_then(|listener| { let port = listener.local_addr().ok()?.port(); drop(listener); Some(port) })
            .unwrap_or_else(free_port);
        let settings = resolve(&Overrides { runtime: Some(runtime.clone()), port: Some(port), host: Some("127.0.0.1".into()), ..Overrides::default() }, &|_| None, &runtime);
        let serving = settings.clone();
        std::thread::spawn(move || serve(&serving).expect("起接口"));
        let agent = crate::backend::agent(std::time::Duration::from_secs(10));
        let base = format!("http://127.0.0.1:{port}");
        wait_up(&agent, &base);
        let ok = agent.post(format!("{base}/notify").as_str()).header("Content-Type", "application/json").send(r#"{"title":"测试","body":"本机通知"}"#).expect("通知");
        assert_eq!(ok.status().as_u16(), 200);
        let mut bad = agent.post(format!("{base}/notify").as_str()).header("Content-Type", "application/json").send(r#"{"title":"测试"}"#).expect("缺字段");
        assert_eq!(bad.status().as_u16(), 400);
        assert!(bad.body_mut().read_to_string().unwrap().contains("body"));
        let mut get = agent.get(format!("{base}/notify").as_str()).call().expect("GET");
        assert_eq!(get.status().as_u16(), 405);
    }
}
