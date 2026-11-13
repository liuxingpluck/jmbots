//! 连 Bun 后端（docs/界面/01_界面设计.md 第 12 节）：只读，健康检查和机器人。
//! 不走代理：后端在本机或局域网，环境里的 http_proxy 不该管它。

use anyhow::{Context, Result, bail};
use std::time::Duration;

/// 连后端最多等多久。
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// 建一个连后端用的 HTTP 客户端：有超时、不走代理、4xx/5xx 不当成传输错误（自己看状态码）。
pub fn agent(timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).proxy(None).build();
    config.into()
}

/// GET 一个地址，读 JSON。
///
/// 输入：客户端、完整地址。输出：解析好的 JSON。状态码不是 2xx 时报错，带上后端给的说明。
pub fn get_json(agent: &ureq::Agent, url: &str) -> Result<serde_json::Value> {
    let mut response = agent.get(url).call().with_context(|| format!("连不上 {url}"))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().with_context(|| format!("{url} 的回答读不出来"))?;
    if !(200..300).contains(&status) {
        bail!("{url} 回了 {status}：{text}");
    }
    serde_json::from_str(&text).with_context(|| format!("{url} 回的不是 JSON：{text}"))
}

/// 后端的健康检查（GET /api/health）。
pub fn health(agent: &ureq::Agent, server: &str) -> Result<serde_json::Value> {
    get_json(agent, &format!("{server}/api/health"))
}

/// 后端的机器人和状态（GET /api/bots）。
pub fn bots(agent: &ureq::Agent, server: &str) -> Result<serde_json::Value> {
    get_json(agent, &format!("{server}/api/bots"))
}
