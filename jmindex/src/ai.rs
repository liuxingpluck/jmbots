//! 调模型：三种接口格式（OpenAI、Anthropic、Gemini），以及用模型做的两件事。
//!
//! 用户 11-03：“为什么要引入 AI 呢？就是让 AI 去提供对应的标签，进行整合……一个文档可能不涉及什么事情，
//! 但是 AI 可以为它进行整合，然后得到这么一个关系图谱。”
//!   tag_file    给一个文件写一句摘要、打 3～8 个标签。提示词里带上已有的标签，让模型能用就用，
//!               这样不同文件会落到同一个标签上，标签就成了把文件串起来的节点
//!   merge_tags  把意思一样的标签合并（如“飞书”“Feishu”“飞书渠道”），写成别名，图谱和搜索都按标准名走

use crate::config::ModelConfig;
use crate::text;
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::time::Duration;

/// 发一次请求，返回模型回复的文字。429 和 5xx 会重试两次。
pub fn complete(model: &ModelConfig, system: &str, user: &str) -> Result<String> {
    let base = model.base();
    let key = model.key();
    let (url, body, headers): (String, Value, Vec<(&str, String)>) = match model.format.as_str() {
        "anthropic" => {
            let url = if base.ends_with("/v1") { format!("{base}/messages") } else { format!("{base}/v1/messages") };
            let body = json!({
                "model": model.model,
                "max_tokens": model.max_tokens,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
            });
            (url, body, vec![("x-api-key", key), ("anthropic-version", "2023-06-01".into())])
        }
        "gemini" => {
            let url = format!("{base}/models/{}:generateContent", model.model);
            let body = json!({
                "systemInstruction": { "parts": [{ "text": system }] },
                "contents": [{ "role": "user", "parts": [{ "text": user }] }],
                "generationConfig": { "temperature": 0.2, "maxOutputTokens": model.max_tokens, "responseMimeType": "application/json" },
            });
            (url, body, vec![("x-goog-api-key", key)])
        }
        _ => {
            let url = format!("{base}/chat/completions");
            let body = json!({
                "model": model.model,
                "max_tokens": model.max_tokens,
                "temperature": 0.2,
                "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
            });
            (url, body, vec![("authorization", format!("Bearer {key}"))])
        }
    };

    //M 本机地址不走代理（系统代理一般连不到本机的 magpie）。
    let local = ["://127.0.0.1", "://localhost", "://[::1]", "://0.0.0.0"].iter().any(|host| base.contains(host));
    let mut builder = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(model.timeout_secs))).http_status_as_error(false);
    if local {
        builder = builder.proxy(None);
    }
    let agent: ureq::Agent = builder.build().into();

    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
        }
        let mut request = agent.post(&url).header("content-type", "application/json");
        for (name, value) in &headers {
            if !value.is_empty() {
                request = request.header(*name, value);
            }
        }
        let mut response = match request.send_json(&body) {
            Ok(response) => response,
            Err(error) => {
                last_error = format!("连不上 {url}：{error}");
                continue;
            }
        };
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        if status == 429 || status >= 500 {
            last_error = format!("HTTP {status}：{}", text::head_chars(&text, 300));
            continue;
        }
        if status >= 400 {
            bail!("模型接口报错 HTTP {status}：{}", text::head_chars(&text, 500));
        }
        let value: Value = serde_json::from_str(&text).with_context(|| format!("模型回复不是 JSON：{}", text::head_chars(&text, 300)))?;
        return reply_text(&model.format, &value);
    }
    Err(anyhow!("调模型失败（重试了 3 次）：{last_error}"))
}

/// 从各家的回复里取出文字。
fn reply_text(format: &str, value: &Value) -> Result<String> {
    let text = match format {
        "anthropic" => value["content"]
            .as_array()
            .map(|parts| parts.iter().filter(|part| part["type"] == "text").filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("")),
        "gemini" => value["candidates"][0]["content"]["parts"]
            .as_array()
            .map(|parts| parts.iter().filter(|part| part["thought"] != true).filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("")),
        _ => {
            let message = &value["choices"][0]["message"];
            // 有的思考模型把正文放在 reasoning_content，content 是空的。
            message["content"].as_str().filter(|text| !text.trim().is_empty()).or_else(|| message["reasoning_content"].as_str()).map(str::to_string)
        }
    };
    text.filter(|text| !text.trim().is_empty()).ok_or_else(|| anyhow!("模型回复里没有文字：{}", text::head_chars(&value.to_string(), 300)))
}

/// 从回复里取出第一个 JSON 对象（模型有时会包一层 ```json 或者前后带话）。
pub fn extract_json(text: &str) -> Result<Value> {
    let start = text.find('{').ok_or_else(|| anyhow!("回复里没有 JSON：{}", text::head_chars(text, 200)))?;
    let end = text.rfind('}').ok_or_else(|| anyhow!("回复里的 JSON 不完整：{}", text::head_chars(text, 200)))?;
    if end < start {
        bail!("回复里的 JSON 不完整");
    }
    serde_json::from_str(&text[start..=end]).with_context(|| format!("回复里的 JSON 读不出来：{}", text::head_chars(&text[start..=end], 200)))
}

/// 一个文件的 AI 结果。
#[derive(Debug, Clone)]
pub struct Tagging {
    pub summary: String,
    pub tags: Vec<String>,
}

/// 规整一个标签：去掉 #、空白，英文转小写，太长的不要。
pub fn normalize_tag(tag: &str) -> Option<String> {
    let tag = tag.trim().trim_start_matches('#').trim();
    if tag.is_empty() || tag.chars().count() > 24 {
        return None;
    }
    Some(tag.to_lowercase())
}

/// 打标签的系统提示词。
const TAG_SYSTEM: &str = "你在给一个项目的代码和文档建知识图谱。每次给你一个文件，你写一句摘要、打几个标签。
标签是把相关文件串起来用的：写这个文件涉及的主题、功能模块、概念、外部系统（如：飞书、模型调用、命令审核、长期记忆、全文检索），
不要写太泛的（代码、文件、函数、文档、typescript），也不要写只有这个文件才有的细节。
下面会给出已有的标签：意思对得上就直接用已有的写法，别造近义词；确实是新主题才起新标签。
只回一个 JSON 对象，不要别的文字：{\"summary\": \"一句话（不超过 60 字）说这个文件讲什么、做什么\", \"tags\": [\"3 到 8 个标签\"]}";

/// 给一个文件写摘要、打标签。
pub fn tag_file(model: &ModelConfig, path: &str, content: &str, symbols: &[String], vocabulary: &[String]) -> Result<Tagging> {
    let mut user = format!("文件：{path}\n");
    if !vocabulary.is_empty() {
        user.push_str(&format!("已有标签：{}\n", vocabulary.join("、")));
    }
    if !symbols.is_empty() {
        user.push_str(&format!("里面的声明：{}\n", symbols.join("、")));
    }
    user.push_str("内容：\n");
    user.push_str(text::head_chars(content, model.max_chars));
    let reply = complete(model, TAG_SYSTEM, &user)?;
    let value = extract_json(&reply)?;
    let summary = value["summary"].as_str().unwrap_or_default().trim().to_string();
    let mut tags: Vec<String> = Vec::new();
    for tag in value["tags"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if let Some(tag) = tag.as_str().and_then(normalize_tag)
            && !tags.contains(&tag)
            && tags.len() < 8
        {
            tags.push(tag);
        }
    }
    if summary.is_empty() && tags.is_empty() {
        bail!("模型没给摘要也没给标签：{}", text::head_chars(&reply, 200));
    }
    Ok(Tagging { summary, tags })
}

/// 整合标签的系统提示词。
const MERGE_SYSTEM: &str = "下面是一个知识库里的全部标签和各自用到的文件数。把意思相同或几乎相同的标签合并成一组
（中英文写法、简称全称、单复数、只差一个修饰词的，如“飞书”“feishu”“飞书渠道”），每组选一个最常用、最清楚的当标准名。
意思不同的不要合并（“模型调用”和“模型评测”是两回事）。只回一个 JSON 对象，不要别的文字：
{\"groups\": [{\"canonical\": \"标准名\", \"aliases\": [\"要并进来的标签\"]}]}；没有可合并的就回 {\"groups\": []}";

/// 整合标签：返回（标准名，别名们）；别名只会是给出的标签。
pub fn merge_tags(model: &ModelConfig, vocabulary: &[(String, i64)]) -> Result<Vec<(String, Vec<String>)>> {
    if vocabulary.len() < 2 {
        return Ok(Vec::new());
    }
    let listing: Vec<String> = vocabulary.iter().map(|(tag, count)| format!("{tag}（{count}）")).collect();
    let reply = complete(model, MERGE_SYSTEM, &listing.join("\n"))?;
    let value = extract_json(&reply)?;
    let known: std::collections::HashSet<&str> = vocabulary.iter().map(|(tag, _)| tag.as_str()).collect();
    let mut groups = Vec::new();
    for group in value["groups"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(canonical) = group["canonical"].as_str().and_then(normalize_tag) else { continue };
        let aliases: Vec<String> = group["aliases"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|alias| alias.as_str().and_then(normalize_tag))
            .filter(|alias| alias != &canonical && known.contains(alias.as_str()))
            .collect();
        if !aliases.is_empty() {
            groups.push((canonical, aliases));
        }
    }
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_from_fenced_reply() {
        let value = extract_json("好的：\n```json\n{\"summary\": \"x\", \"tags\": [\"A\"]}\n```").unwrap();
        assert_eq!(value["tags"][0], "A");
        assert!(extract_json("没有").is_err());
    }

    #[test]
    fn reply_text_for_each_format() {
        let openai = json!({"choices": [{"message": {"content": "hi"}}]});
        assert_eq!(reply_text("openai", &openai).unwrap(), "hi");
        let anthropic = json!({"content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": "hi"}]});
        assert_eq!(reply_text("anthropic", &anthropic).unwrap(), "hi");
        let gemini = json!({"candidates": [{"content": {"parts": [{"text": "想", "thought": true}, {"text": "hi"}]}}]});
        assert_eq!(reply_text("gemini", &gemini).unwrap(), "hi");
        assert!(reply_text("openai", &json!({"choices": []})).is_err());
    }

    #[test]
    fn normalize_tags() {
        assert_eq!(normalize_tag(" #Feishu ").as_deref(), Some("feishu"));
        assert_eq!(normalize_tag(""), None);
    }
}
