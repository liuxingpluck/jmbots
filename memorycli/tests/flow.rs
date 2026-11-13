//! 整条流程的测试：本机起一个假的模型服务（同时会说 OpenAI、Anthropic、Gemini 三种格式），
//! 在临时目录里摄取代码和文档、打标签、整合标签、搜索、查图谱、增量更新。不连外网、不花钱。

use memorycli::config::{Config, ModelConfig};
use memorycli::store::Store;
use memorycli::{ai, graph, ingest, libs, search};
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

            //M 算向量：“飞书”和英文“lark”算成同一个方向，“天气”另一个方向（向量检索的测试用）。
            if url.ends_with("/embeddings") {
                let inputs: Vec<String> = body["input"].as_array().map(|items| items.iter().map(|item| item.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default();
                let data: Vec<Value> = inputs
                    .iter()
                    .enumerate()
                    .map(|(index, text)| {
                        let lark = if text.contains("飞书") || text.to_lowercase().contains("lark") { 1.0 } else { 0.0 };
                        let weather = if text.contains("天气") { 1.0 } else { 0.0 };
                        json!({ "index": index, "embedding": [lark, weather, 0.1] })
                    })
                    .collect();
                let response = tiny_http::Response::from_string(json!({ "data": data }).to_string())
                    .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap());
                let _ = request.respond(response);
                continue;
            }

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
        let dir = std::env::var_os("MEMORYCLI_TEST_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join(format!("memorycli-test-{name}-{}", std::process::id()));
        // 某些环境里临时目录不可写（或者在 OneDrive 里同步），删目录还会被拒；清不掉就换个新名字，别让测试挂掉。
        let dir = if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() { dir } else { pick_other(dir) };
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn write(&self, path: &str, text: &str) {
        let file = self.0.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
}

/// 原来那个临时目录删不掉（被占用或者不允许删），换一个没用过的名字。
fn pick_other(dir: PathBuf) -> PathBuf {
    for i in 1..100 {
        let candidate = dir.with_file_name(format!("{}-{i}", dir.file_name().unwrap().to_string_lossy()));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir
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
    let mut store = Store::open(&dir.0.join(".memorycli/index.db")).unwrap();

    //M 1. 第一次摄取：3 个文件（node_modules 不收），都打了标签，feishu、飞书渠道并进“飞书”。
    let stats = ingest::ingest(&mut store, &dir.0, &config, ingest::Options { ai: true }, &|_| {}).unwrap();
    assert_eq!((stats.added, stats.tagged, stats.tag_failed), (3, 3, 0), "{:?}", stats.tag_errors);
    assert_eq!(stats.aliases_added, 2);

    //M 2. 关系：调用、导入、文档提到代码、标签。
    let edges: Vec<(String, String, String)> = store.all_edges().unwrap().into_iter().map(|edge| (edge.src, edge.dst, edge.kind)).collect();
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
    let mut store = Store::open(&dir.0.join(".memorycli/index.db")).unwrap();
    let stats = ingest::ingest(&mut store, &dir.0, &Config::default(), ingest::Options { ai: true }, &|_| {}).unwrap();
    assert_eq!((stats.added, stats.tagged), (2, 0));
    let out = graph::query(&store, Some("run"), 1).unwrap();
    assert!(out.edges.iter().any(|edge| edge.src == "sym:a.rs#main" && edge.dst == "sym:b.rs#run" && edge.kind == "calls"));
}

#[test]
fn several_libraries_are_searched_together() {
    //M 两个目录各建一个库，库放在同一个“库目录”下（运行时 memorycli/ 就是这样摆的），不配模型。
    let memory = TempDir::new("lib-memory");
    memory.write("飞书发件箱.md", "# 飞书发件箱\n\nClaude 往发件箱放文件，机器人发给用户。\n");
    let code = TempDir::new("lib-code");
    code.write("outbox.ts", "export function startOutbox() {\n  // 飞书发件箱：每 5 秒看一次\n}\n");
    let libs_dir = TempDir::new("libs");
    for (name, dir) in [("memory", &memory), ("code", &code)] {
        let mut store = Store::open(&libs_dir.0.join(name).join("index.db")).unwrap();
        ingest::ingest(&mut store, &dir.0, &Config::default(), ingest::Options { ai: false }, &|_| {}).unwrap();
    }

    //G 子目录名就是库名，按名字排好。
    let all = libs::open_dir(&libs_dir.0).unwrap();
    assert_eq!(all.iter().map(|lib| lib.name.as_str()).collect::<Vec<_>>(), ["code", "memory"]);

    //M 一次搜两个库：两边的都在，每条带库名。
    let out = libs::search(&libs::pick(&all, &[]).unwrap(), "发件箱", 10, None).unwrap();
    let found: Vec<(Option<&str>, &str)> = out.hits.iter().map(|hit| (hit.lib.as_deref(), hit.path.as_str())).collect();
    assert!(found.contains(&(Some("memory"), "飞书发件箱.md")), "{found:?}");
    assert!(found.contains(&(Some("code"), "outbox.ts")), "{found:?}");

    //G 绝对路径 = 摄取时记下的根目录 + 相对路径，能直接打开。
    let hit = out.hits.iter().find(|hit| hit.lib.as_deref() == Some("memory")).unwrap();
    assert!(std::path::Path::new(hit.abs_path.as_deref().unwrap()).is_file(), "{:?}", hit.abs_path);

    //G 只挑一个库就只搜它；挑不存在的库报错。
    let only = libs::search(&libs::pick(&all, &["code".to_string()]).unwrap(), "发件箱", 10, None).unwrap();
    assert!(!only.hits.is_empty() && only.hits.iter().all(|hit| hit.lib.as_deref() == Some("code")));
    assert!(libs::pick(&all, &["没有这个库".to_string()]).is_err());
}

#[test]
fn vectors_find_by_meaning() {
    //M 配了嵌入模型：摄取时给每块正文算向量；英文 lark 在正文里一个字都没有，全文检索找不到，向量把它和“飞书”连上。
    let (base, _seen) = mock_model();
    let dir = TempDir::new("vectors");
    dir.write("飞书发件箱.md", "# 飞书发件箱\n\nClaude 往发件箱放文件，机器人发给用户。\n");
    dir.write("天气.md", "# 天气\n\n今天下雨。\n");
    let mut store = Store::open(&dir.0.join(".memorycli/index.db")).unwrap();
    let config = Config { embedding: Some(ModelConfig { base_url: format!("{base}/v1"), model: "e1".into(), ..Default::default() }), ..Default::default() };
    let stats = ingest::ingest(&mut store, &dir.0, &config, ingest::Options { ai: true }, &|_| {}).unwrap();
    assert!(stats.embedded >= 2, "{stats:?}");
    assert!(search::search(&store, "lark", 5).unwrap().hits.is_empty());
    let lib = libs::open_one(&dir.0.join(".memorycli/index.db"), Some(&dir.0)).unwrap();
    let out = libs::search(&[&lib], "lark", 5, config.embedding.as_ref()).unwrap();
    assert_eq!(out.hits.first().map(|hit| hit.path.as_str()), Some("飞书发件箱.md"), "{:?}", out.hits.iter().map(|hit| &hit.path).collect::<Vec<_>>());
    assert!(out.hits[0].matched.contains(&"vector".to_string()));

    //G 没配嵌入模型就只走四路：同样的词什么也搜不到，也不报错。
    assert!(libs::search(&[&lib], "lark", 5, None).unwrap().hits.is_empty());

    //G 文件改了：旧块和它的向量一起删掉，再摄取时只给新块补算。
    dir.write("天气.md", "# 天气\n\n明天晴。\n");
    let again = ingest::ingest(&mut store, &dir.0, &config, ingest::Options { ai: true }, &|_| {}).unwrap();
    assert!(again.embedded >= 1 && again.embedded < stats.embedded, "{again:?}");
}

#[test]
fn broken_libraries_are_skipped_and_all_broken_reports_each() {
    //M 一个能开的库 + 一个 index.db 是坏文件的库：坏的跳过，好的照开。
    let libs_dir = TempDir::new("libs-broken-one");
    Store::open(&libs_dir.0.join("good/index.db")).unwrap();
    std::fs::create_dir_all(libs_dir.0.join("bad")).unwrap();
    std::fs::write(libs_dir.0.join("bad/index.db"), "这不是 SQLite 数据库，只是一段文字").unwrap();
    let all = libs::open_dir(&libs_dir.0).unwrap();
    assert_eq!(all.iter().map(|lib| lib.name.as_str()).collect::<Vec<_>>(), ["good"]);

    //G 全都打不开：错误里要写明每个库和它的路径，不能只报一个。
    let broken_dir = TempDir::new("libs-broken-all");
    for name in ["甲库", "乙库"] {
        std::fs::create_dir_all(broken_dir.0.join(name)).unwrap();
        std::fs::write(broken_dir.0.join(name).join("index.db"), "坏文件").unwrap();
    }
    let error = match libs::open_dir(&broken_dir.0) {
        Ok(_) => panic!("全都坏的库目录不该打开成功"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("都打不开"), "{error}");
    assert!(error.contains("甲库") && error.contains("乙库"), "{error}");
    assert!(error.contains("index.db"), "{error}");
}
