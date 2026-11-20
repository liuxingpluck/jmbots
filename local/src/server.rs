//! 壳子的 HTTP 接口（docs/界面/01_界面设计.md 第 4.3 节）：监听 0.0.0.0:local.port。2026-11-14 起基地只承载：
//!   GET  /update、POST /update/apply   主后端的版本更新（supervisor.rs）
//!   POST /restart[?service=名]          重启主后端；带 service 重启那个托管服务（services.rs）
//!   POST /server/stop、/server/start    本机停写窗口，暂停或恢复主站守护
//!   GET  /services                      每个托管服务的端口、程序在不在、健康
//!   GET/POST /autostart                 开机自启
//!   POST /notify                        本机弹 Windows 右下角通知（{title, body, level?, url?}）
//!   GET  /version                       壳子自己的版本和编译时刻（给网页左下角显示）
//!   其余路径交回 404。记忆与 RAG 由主后端提供统一入口。

use crate::config::Settings;
use crate::services::Services;
use crate::supervisor::Supervisor;
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::sync::Arc;

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

/// 只接受本机命令，阻止网页跨站触发停服或启动。
fn window_request_allowed(request: &tiny_http::Request) -> bool {
    crate::notify::is_loopback(request.remote_addr().copied())
        && request.headers().iter().any(|header| header.field.equiv("X-JMBots-Window") && header.value.as_str() == "1")
        && !request.headers().iter().any(|header| header.field.equiv("Origin"))
}

fn window_respond(request: &tiny_http::Request, path: &str, supervisor: Option<&Arc<Supervisor>>) -> Result<Value, (u16, String)> {
    if *request.method() != tiny_http::Method::Post {
        return Err((405, "停写窗口接口只接收 POST".to_string()));
    }
    if !window_request_allowed(request) {
        return Err((403, "停写窗口只接受本机运维命令".to_string()));
    }
    let supervisor = supervisor.ok_or((409, "基地没有启用主站守护".to_string()))?;
    if path == "/server/stop" {
        let outcome = supervisor.stop_for_window().map_err(|reason| (409, reason))?;
        return Ok(json!({ "ok": true, "windowState": "paused", "outcome": outcome }));
    }
    supervisor.start_for_window().map_err(|reason| (409, reason))?;
    Ok(json!({ "ok": true, "windowState": "running" }))
}

/// 根据请求路径交给本地管理接口，未知路径返回 JSON 404，不向后端发请求。
fn respond(
    request: &mut tiny_http::Request,
    supervisor: Option<&Arc<Supervisor>>,
    services: Option<&Arc<Services>>,
) -> Result<Value, (u16, String)> {
    let url = request.url();
    let path = url.split('?').next().unwrap_or("");
    if path == "/server/stop" || path == "/server/start" {
        return window_respond(request, path, supervisor);
    }
    if path.starts_with("/autostart") { return autostart_respond(request); }

    if path.starts_with("/update") || path == "/restart" || path == "/services" {
        //M 基地管理接口继续使用当前的守护和托管服务对象。
        return host_respond(request, supervisor, services);
    }

    if path == "/notify" { return notify_respond(request); }

    if path == "/version" {
        //M 网页左下角读取基地自己的版本和编译时刻。
        let built_at = option_env!("JMBOTS_BUILT_AT").and_then(|text| text.parse::<u64>().ok()).unwrap_or(0);
        return Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "builtAt": built_at }));
    }

    //G 未登记的路径在基地终止，旧搜索与 RAG 路径执行同样的 404。
    let method = request.method();
    Err((404, format!("没有这个接口：{method} {url}")))
}

/// 统一写回管理接口 JSON。
fn respond_json(mut request: tiny_http::Request, supervisor: Option<&Arc<Supervisor>>, services: Option<&Arc<Services>>) {
    let result = respond(&mut request, supervisor, services);
    let (status, value) = match result {
        Ok(value) => (200, value),
        Err((status, message)) => (status, json!({ "error": message })),
    };
    let body = serde_json::to_vec_pretty(&value).unwrap_or_default();
    let content_type = tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8").expect("固定的头");
    let response = tiny_http::Response::from_data(body)
        .with_status_code(status)
        .with_header(content_type)
        .with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").expect("固定的头"));
    let _ = request.respond(response);
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
        .map_err(|error| anyhow!("监听 {}:{} 失败（是不是另一个基地还占着这个端口？）：{error}", settings.listen_host, settings.listen_port))?;
    eprintln!("jmbots 基地的接口：http://{}:{}", settings.listen_host, settings.listen_port);
    for request in server.incoming_requests() {
        //M 停服需要等待主站退出；背景处理使 /update 仍能看到守护状态。
        let path = request.url().split('?').next();
        if path == Some("/server/stop") && *request.method() == tiny_http::Method::Post && window_request_allowed(&request) {
            let guard = supervisor.clone();
            std::thread::spawn(move || respond_json(request, guard.as_ref(), None));
            continue;
        }
        respond_json(request, supervisor.as_ref(), services.as_ref());
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
    fn starts_without_memory_and_rejects_old_routes() {
        let runtime = temp_dir("server");
        //M 记忆库目录是个坏文件（原来会让整个接口起不来）：现在壳子根本不碰它。
        std::fs::create_dir_all(runtime.join("data").join("index")).unwrap();
        std::fs::write(runtime.join("data").join("index").join("libs"), "坏的").unwrap();
        let port = free_port();
        let settings = resolve(&Overrides { runtime: Some(runtime.clone()), port: Some(port), host: Some("127.0.0.1".into()), ..Overrides::default() }, &|_| None, &runtime);
        std::thread::spawn(move || serve(&settings).expect("起接口"));
        let agent = crate::backend::agent(std::time::Duration::from_secs(10));
        let base = format!("http://127.0.0.1:{port}");
        wait_up(&agent, &base);
        //M 管理接口照常响应，旧搜索和 RAG 地址走基地的 404。
        assert_eq!(crate::backend::get_json(&agent, &format!("{base}/update")).expect("更新")["managed"], false);
        for path in ["/search?q=x", "/rag", "/rag/search"] {
            let url = format!("{base}{path}");
            let response = agent.get(&url).call().expect("旧记忆 GET");
            assert_eq!(response.status().as_u16(), 404, "{path}");
        }
        let url = format!("{base}/rag/index");
        let response = agent.post(&url).send("{}").expect("旧 RAG POST");
        assert_eq!(response.status().as_u16(), 404);
    }

    #[test]
    fn window_routes_require_local_post_header_and_supervisor() {
        let runtime = temp_dir("server-window");
        let port = free_port();
        let settings = resolve(&Overrides { runtime: Some(runtime.clone()), port: Some(port), host: Some("127.0.0.1".into()), ..Overrides::default() }, &|_| None, &runtime);
        std::thread::spawn(move || serve(&settings).expect("起接口"));
        let agent = crate::backend::agent(std::time::Duration::from_secs(10));
        let base = format!("http://127.0.0.1:{port}");
        wait_up(&agent, &base);

        let stop = format!("{base}/server/stop");
        let start = format!("{base}/server/start");
        assert_eq!(agent.get(&stop).call().unwrap().status().as_u16(), 405);
        assert_eq!(agent.post(&stop).send_empty().unwrap().status().as_u16(), 403);
        let cross_site = agent.post(&start).header("X-JMBots-Window", "1").header("Origin", "http://localhost");
        assert_eq!(cross_site.send_empty().unwrap().status().as_u16(), 403);
        let local = agent.post(&stop).header("X-JMBots-Window", "1");
        assert_eq!(local.send_empty().unwrap().status().as_u16(), 409);
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
        let get = agent.get(format!("{base}/notify").as_str()).call().expect("GET");
        assert_eq!(get.status().as_u16(), 405);
    }
}
