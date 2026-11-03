//! 整条流程的测试：本机起一个假的模型服务（同时会说 OpenAI、Anthropic、Gemini 三种格式），
//! 在临时目录里摄取代码和文档、打标签、整合标签、搜索、查图谱、增量更新。不连外网、不花钱。

use jmindex::config::{Config, ModelConfig};
use jmindex::store::Store;
use jmindex::{ai, graph, ingest, search};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 收到的请求：(路径, 认证头, 请求体)。
type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;

/// 起假模型服务，返回地址和收到的请求。
fn mock_model() -> (String, Seen) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let seen: Seen = Arc::default();
    let record = seen.clone();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let auth = request
                .headers()
                .iter()
                .find(|header| ["authorization", "x-api-key", "x-goog-api-key"].iter().any(|name| header.field.equiv(name)))
                .map(|header| format!("{}={}", header.field, header.value))
                .unwrap_or_default();
            let url = request.url().to_string();
            record.lock().unwrap().push((url.clone(), auth, body.clone()));

            //M 按请求内容决定回什么：整合标签、给文件打标签。
            let all = body.to_string();
            let answer = if all.contains("合并成一组") {
                json!({ "groups": [{ "canonical": "飞书", "aliases": ["feishu", "飞书渠道"] }] }).to_string()
            } else if all.contains("bot.ts") {
                json!({ "summary": "飞书机器人收消息", "tags": ["feishu", "消息"] }).to_string()
            } else if all.contains("channel.ts") {
                json!({ "summary": "飞书渠道的发送", "tags": ["飞书渠道", "消息"] }).to_string()
            } else if all.contains("记忆.md") {
                json!({ "summary": "长期记忆的设计", "tags": ["长期记忆", "飞书"] }).to_string()
            } else {
                json!({ "summary": "其他", "tags": ["杂项"] }).to_string()
            };
            let reply = if url.contains("/v1/messages") {
                json!({ "content": [{ "type": "text", "text": answer }] })
            } else if url.contains(":generateContent") {
                json!({ "candidates": [{ "content": { "parts": [{ "text": answer }] } }] })
            } else {
                json!({ "choices": [{ "message": { "content": format!("```json\n{answer}\n```") } }] })
            };
            let response = tiny_http::Response::from_string(reply.to_string())
                .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap());
            let _ = request.respond(response);
        }
    });
    (format!("http://127.0.0.1:{port}"), seen)
}

fn model(format: &str, base: &str) -> ModelConfig {
    let base_url = match format {
        "openai" => format!("{base}/v1"),
        "gemini" => format!("{base}/v1beta"),
        _ => base.to_string(),
    };
    ModelConfig { format: format.into(), base_url, api_key: "k".into(), model: "m1".into(), concurrency: 2, ..Default::default() }
}

/// 临时目录：测试结束删掉。
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("jmindex-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn write(&self, path: &str, text: &str) {
        let file = self.0.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn three_formats_send_the_right_requests() {
    let (base, seen) = mock_model();
    for format in ["openai", "anthropic", "gemini"] {
        let tagging = ai::tag_file(&model(format, &base), "src/bot.ts", "export function onMessage() {}", &[], &[]).unwrap();
        assert_eq!(tagging.tags, ["feishu", "消息"], "{format}");
    }
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].0, "/v1/chat/completions");
    assert_eq!(seen[0].1, "authorization=Bearer k");
    assert_eq!(seen[0].2["messages"][0]["role"], "system");
    assert_eq!(seen[1].0, "/v1/messages");
    assert_eq!(seen[1].1, "x-api-key=k");
    assert!(seen[1].2["system"].as_str().unwrap().contains("知识图谱"));
    assert_eq!(seen[2].0, "/v1beta/models/m1:generateContent");
    assert_eq!(seen[2].1, "x-goog-api-key=k");
    assert!(seen[2].2["systemInstruction"]["parts"][0]["text"].is_string());
}

#[test]
fn ingest_tags_merge_search_graph_and_update() {
    let (base, _) = mock_model();
    let dir = TempDir::new("flow");
    dir.write("src/bot.ts", "import { send } from './channel.ts';\nexport function onMessage(text: string) {\n  return send(text);\n}\n");
    dir.write("src/channel.ts", "export function send(text: string) {\n  return text;\n}\n");
    dir.write("docs/记忆.md", "# 长期记忆\n机器人把重要的事写进记忆文件。收消息在 `onMessage`，见 src/bot.ts。\n");
    dir.write("node_modules/x/index.js", "function ignored() {}\n");
    let config = Config { model: Some(model("anthropic", &base)), ..Default::default() };
    let mut store = Store::open(&dir.0.join(".jmindex/index.db")).unwrap();

    //M 1. 第一次摄取：3 个文件（node_modules 不收），都打了标签，feishu、飞书渠道并进“飞书”。
    let stats = ingest::ingest(&mut store, &dir.0, &config, ingest::Options { ai: true }, &|_| {}).unwrap();
    assert_eq!((stats.added, stats.tagged, stats.tag_failed), (3, 3, 0), "{:?}", stats.tag_errors);
    assert_eq!(stats.aliases_added, 2);

    //M 2. 关系：调用、导入、文档提到代码、标签。
    let edges: Vec<(String, String, String)> = store
        .conn
        .prepare("SELECT src, dst, kind FROM edges")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let has = |src: &str, dst: &str, kind: &str| edges.iter().any(|edge| edge.0 == src && edge.1 == dst && edge.2 == kind);
    assert!(has("sym:src/bot.ts#onMessage", "sym:src/channel.ts#send", "calls"));
    assert!(has("file:src/bot.ts", "file:src/channel.ts", "imports"));
    assert!(has("file:docs/记忆.md", "sym:src/bot.ts#onMessage", "mentions"));
    assert!(has("file:docs/记忆.md", "file:src/bot.ts", "mentions"));
    assert!(has("file:src/bot.ts", "tag:飞书", "tagged"));
    assert!(has("file:src/channel.ts", "tag:飞书", "tagged"));

    //M 3. 搜两个字的中文词、搜整合后的标签。
    let out = search::search(&store, "记忆", 5).unwrap();
    assert_eq!(out.hits[0].path, "docs/记忆.md");
    assert!(out.hits[0].snippets[0].text.contains("记忆文件"));
    let out = search::search(&store, "飞书", 5).unwrap();
    let paths: Vec<&str> = out.hits.iter().map(|hit| hit.path.as_str()).collect();
    assert!(paths.contains(&"src/bot.ts") && paths.contains(&"src/channel.ts") && paths.contains(&"docs/记忆.md"), "{paths:?}");
    let bot = out.hits.iter().find(|hit| hit.path == "src/bot.ts").unwrap();
    assert_eq!(bot.tags, ["飞书", "消息"]);
    assert!(bot.related.iter().any(|related| related.id == "file:src/channel.ts"));
    let out = search::search(&store, "onMessage", 5).unwrap();
    assert_eq!(out.hits[0].path, "src/bot.ts");
    assert_eq!(out.hits[0].symbols[0].qname, "onMessage");

    //M 4. 图谱：从标签出发能走到三个文件。
    let out = graph::query(&store, Some("飞书"), 1).unwrap();
    assert_eq!(out.start, ["tag:飞书"]);
    assert_eq!(out.nodes.iter().filter(|node| node.kind == "file").count(), 3);

    //M 5. 再摄取：什么都没变就不调模型；改一个、删一个后只处理它们。
    let stats = ingest::ingest(&mut store, &dir.0, &config, ingest::Options { ai: true }, &|_| {}).unwrap();
    assert_eq!((stats.unchanged, stats.tagged), (3, 0));
    dir.write("src/channel.ts", "export function send(text: string) {\n  return text.trim();\n}\n");
    std::fs::remove_file(dir.0.join("docs/记忆.md")).unwrap();
    let stats = ingest::ingest(&mut store, &dir.0, &config, ingest::Options { ai: true }, &|_| {}).unwrap();
    assert_eq!((stats.updated, stats.removed, stats.unchanged, stats.tagged), (1, 1, 1, 1));
    assert!(search::search(&store, "记忆", 5).unwrap().hits.is_empty());
}

#[test]
fn ingest_without_model_still_indexes() {
    let dir = TempDir::new("noai");
    dir.write("a.rs", "mod b;\nfn main() { b::run(); }\n");
    dir.write("b.rs", "pub fn run() {}\n");
    let mut store = Store::open(&dir.0.join(".jmindex/index.db")).unwrap();
    let stats = ingest::ingest(&mut store, &dir.0, &Config::default(), ingest::Options { ai: true }, &|_| {}).unwrap();
    assert_eq!((stats.added, stats.tagged), (2, 0));
    let out = graph::query(&store, Some("run"), 1).unwrap();
    assert!(out.edges.iter().any(|edge| edge.src == "sym:a.rs#main" && edge.dst == "sym:b.rs#run" && edge.kind == "calls"));
}
