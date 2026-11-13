//! 不开窗口的自检（docs/界面/01_界面设计.md 第 4.1、14 节）：读配置、连后端、开记忆库，打印一份 JSON 后退出。
//! DSH 在 Windows 上靠它看真数据（机器人和状态）；只读，不改任何东西，不打印 config.yaml 的内容（只打壳子用的几项）。

use crate::backend;
use crate::config::Settings;
use serde_json::{Value, json};

/// 机器人的几项（GET /api/bots 每项里挑出来的）。
fn bot_brief(bot: &Value) -> Value {
    json!({
        "name": bot.get("name"),
        "status": bot.get("status"),
        "running": bot.get("running"),
        "queued": bot.get("queued"),
        "approvals": bot.get("approvals"),
    })
}

/// 连后端：健康检查和机器人。
fn backend_report(settings: &Settings) -> Value {
    let agent = backend::agent(backend::TIMEOUT);
    match backend::health(&agent, &settings.server).and_then(|health| Ok((health, backend::bots(&agent, &settings.server)?))) {
        Ok((health, bots)) => json!({
            "ok": true,
            "health": health,
            "bots": bots.as_array().map(|items| items.iter().map(bot_brief).collect::<Vec<_>>()).unwrap_or_default(),
        }),
        Err(error) => json!({ "ok": false, "error": format!("{error:#}") }),
    }
}

/// 开记忆库：库名、根目录、RAG 建过索引没有；开不了写原因。
fn memory_report(settings: &Settings) -> Value {
    match crate::memory::open_libs(settings) {
        Ok(libs) => json!({
            "ok": true,
            "dir": settings.libs_dir,
            "ai_tags": settings.memory_model.as_ref().map(|model| model.id.clone()),
            "libs": libs
                .iter()
                .map(|lib| json!({ "name": lib.name, "root": lib.root, "rag_indexed": settings.rag_dir.join(&lib.name).join("meta.json").is_file() }))
                .collect::<Vec<_>>(),
        }),
        Err(error) => json!({ "ok": false, "dir": settings.libs_dir, "error": format!("{error:#}") }),
    }
}

/// 自检。
///
/// 输入：算好的配置。输出：一份 JSON 报告和“后端连上没有”。
/// 副作用：发两个 HTTP 请求；只读地打开记忆库。
pub fn report(settings: &Settings) -> (Value, bool) {
    let backend = backend_report(settings);
    let ok = backend["ok"].as_bool().unwrap_or(false);
    let value = json!({
        "runtime": settings.runtime,
        "config": { "file": settings.config_file, "found": settings.config_found, "problems": settings.problems },
        "server": settings.server,
        "listen": format!("{}:{}", settings.listen_host, settings.listen_port),
        "rag_dir": settings.rag_dir,
        "backend": backend,
        "memory": memory_report(settings),
    });
    (value, ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Overrides, resolve};
    use crate::test_support::temp_dir;

    /// 起一个假后端：/api/health 和 /api/bots 各回一份固定的 JSON。返回地址。
    fn fake_backend() -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("起假后端");
        let address = format!("http://{}", server.server_addr().to_ip().expect("地址"));
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let body = match request.url() {
                    "/api/health" => r#"{"ok":true,"problems":[]}"#,
                    "/api/bots" => r#"[{"name":"小测","language":"zh","status":"working","running":1,"queued":0,"approvals":0,"mergeMs":null}]"#,
                    _ => r#"{"error":"没有"}"#,
                };
                let header = tiny_http::Header::from_bytes("Content-Type", "application/json").expect("头");
                let _ = request.respond(tiny_http::Response::from_string(body).with_header(header));
            }
        });
        address
    }

    #[test]
    fn report_has_bots_and_status() {
        let dir = temp_dir("check-ok");
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), server: Some(fake_backend()), ..Overrides::default() }, &|_| None, &dir);
        let (value, ok) = report(&settings);
        assert!(ok, "{value}");
        assert_eq!(value["backend"]["bots"][0]["name"], "小测");
        assert_eq!(value["backend"]["bots"][0]["status"], "working");
        // 记忆库目录还没有：建一个空的，没有库也不算错。
        assert_eq!(value["memory"]["ok"], true);
        assert_eq!(value["memory"]["libs"].as_array().map(Vec::len), Some(0));
        assert_eq!(value["config"]["found"], false);
    }

    #[test]
    fn report_when_backend_is_down() {
        let dir = temp_dir("check-down");
        // 起一个服务拿到空闲端口，再关掉：这个端口上没人听。
        let address = {
            let server = tiny_http::Server::http("127.0.0.1:0").expect("占端口");
            format!("http://{}", server.server_addr().to_ip().expect("地址"))
        };
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), server: Some(address), ..Overrides::default() }, &|_| None, &dir);
        let (value, ok) = report(&settings);
        assert!(!ok);
        assert_eq!(value["backend"]["ok"], false);
        assert!(value["backend"]["error"].as_str().unwrap_or("").contains("连不上"), "{value}");
    }
}
