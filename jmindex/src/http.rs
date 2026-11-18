//! HTTP 服务（很精简，都是 JSON）：
//!   GET  /health                         活着吗，索引里有多少东西
//!   POST /ingest   {"ai": true}          摄取（增量更新），返回统计；ai 写 false 就不打标签
//!   GET  /search?q=词&limit=10           搜索
//!   GET  /graph?q=名字&depth=1           关系图谱：从名字（文件、声明、标签、节点 ID）出发走 depth 步；不写 q 是整张图
//!
//! 一次处理一个请求（摄取时搜索会等着），够 jmbots 和 AI 用。

use crate::config::Config;
use crate::store::Store;
use crate::{graph, ingest, search};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// 起服务，一直跑。
pub fn serve(root: PathBuf, db: PathBuf, config: Config, host: &str, port: u16) -> Result<()> {
    let server = tiny_http::Server::http((host, port)).map_err(|error| anyhow!("监听 {host}:{port} 失败：{error}"))?;
    let mut store = Store::open(&db)?;
    eprintln!("jmindex HTTP 服务：http://{host}:{port}（索引 {}）", root.display());
    for mut request in server.incoming_requests() {
        let (status, body) = match handle(&mut request, &mut store, &root, &config) {
            Ok(value) => (200, value),
            Err((status, message)) => (status, json!({ "error": message })),
        };
        let response = tiny_http::Response::from_string(serde_json::to_string_pretty(&body).unwrap_or_default())
            .with_status_code(status)
            .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8").expect("固定的头"))
            .with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").expect("固定的头"));
        let _ = request.respond(response);
    }
    Ok(())
}

/// 处理一个请求。出错时返回（状态码, 原因）。
fn handle(request: &mut tiny_http::Request, store: &mut Store, root: &Path, config: &Config) -> Result<Value, (u16, String)> {
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let params = parse_query(query);
    let get = |name: &str| params.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
    let internal = |error: anyhow::Error| (500, format!("{error:#}"));
    match (request.method(), path) {
        (tiny_http::Method::Get, "/health") => {
            Ok(json!({ "ok": true, "root": root.display().to_string(), "totals": store.counts().map_err(internal)? }))
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
            let stats = ingest::ingest(store, root, config, ingest::Options { ai }, &|_| {}).map_err(internal)?;
            Ok(serde_json::to_value(stats).unwrap_or_default())
        }
        (tiny_http::Method::Get, "/search") => {
            let text = get("q").filter(|text| !text.trim().is_empty()).ok_or((400, "要写 q（搜什么）".to_string()))?;
            let limit = get("limit").and_then(|value| value.parse().ok()).unwrap_or(10usize).clamp(1, 100);
            Ok(serde_json::to_value(search::search(store, text, limit).map_err(internal)?).unwrap_or_default())
        }
        (tiny_http::Method::Get, "/graph") => {
            let depth = get("depth").and_then(|value| value.parse().ok()).unwrap_or(1usize).clamp(1, 4);
            Ok(serde_json::to_value(graph::query(store, get("q"), depth).map_err(internal)?).unwrap_or_default())
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
