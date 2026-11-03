//! 配置：索引目录下的 .jmindex/config.yaml（也可以用 --config 指定）。
//! 没有时第一次运行会写一份模板；不配模型也能用，只是不打 AI 标签。
//!
//! 模型支持三种接口格式（用户 11-03：常规 OpenAI 格式、Anthropic 格式、Gemini 格式都要支持）：
//!   openai     POST {base_url}/chat/completions       （OpenAI 以及兼容它的 magpie、DeepSeek、OpenRouter……）
//!   anthropic  POST {base_url}/v1/messages             （base_url 已经以 /v1 结尾时是 {base_url}/messages）
//!   gemini     POST {base_url}/models/{model}:generateContent

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// 第一次运行时写的模板。
pub const TEMPLATE: &str = r#"# jmindex 配置。相对路径以被索引的目录为准。
# 不写 model 也能用：照样建全文检索和代码关系，只是不打 AI 标签、不写摘要。

# 给文件打标签、写摘要用的模型。format：openai、anthropic、gemini。
# model:
#   format: openai
#   base_url: http://127.0.0.1:3425/v1      # magpie；OpenAI 官方是 https://api.openai.com/v1
#   api_key: magpie-jmindex                 # 或者 api_key_env: OPENAI_API_KEY（从环境变量读）
#   model: workbuddy/deepseek-v4.1-flash
#   concurrency: 4                          # 同时打几个文件
#   max_chars: 6000                         # 每个文件最多给模型看多少字
#
# model:
#   format: anthropic
#   base_url: https://api.anthropic.com
#   api_key_env: ANTHROPIC_API_KEY
#   model: claude-haiku-5-5
#
# model:
#   format: gemini
#   base_url: https://generativelanguage.googleapis.com/v1beta
#   api_key_env: GEMINI_API_KEY
#   model: gemini-2.5-flash

# 额外不收的路径：路径里含这些字就跳过（node_modules、target、dist、.git 本来就不收，.gitignore 里的也不收）。
exclude: []

# HTTP 服务（serve）。命令行 --host、--port 优先。
http:
  host: 127.0.0.1
  port: 30090
"#;

/// 整个配置。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 打标签用的模型；没写就不打。
    pub model: Option<ModelConfig>,

    /// 额外不收的路径片段。
    pub exclude: Vec<String>,

    /// HTTP 服务。
    pub http: HttpConfig,
}

/// HTTP 服务的地址和端口。
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct HttpConfig {
    /// 监听地址。
    pub host: String,

    /// 端口。
    pub port: u16,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 30090 }
    }
}

/// 一个模型。
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ModelConfig {
    /// 接口格式：openai、anthropic、gemini。
    pub format: String,

    /// 接口地址；不写用官方地址。
    pub base_url: String,

    /// 密钥，直接写。
    pub api_key: String,

    /// 密钥从哪个环境变量读（api_key 没写时用）。
    pub api_key_env: String,

    /// 模型 ID。
    pub model: String,

    /// 同时打几个文件。
    pub concurrency: usize,

    /// 每个文件最多给模型看多少字。
    pub max_chars: usize,

    /// 一次请求最多等几秒。
    pub timeout_secs: u64,

    /// 模型最多回多少 token。
    pub max_tokens: u32,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            format: "openai".into(),
            base_url: String::new(),
            api_key: String::new(),
            api_key_env: String::new(),
            model: String::new(),
            concurrency: 4,
            max_chars: 6000,
            timeout_secs: 120,
            max_tokens: 1024,
        }
    }
}

impl ModelConfig {
    /// 密钥：api_key，其次 api_key_env 指的环境变量；都没有是空字符串。
    pub fn key(&self) -> String {
        if !self.api_key.is_empty() {
            return self.api_key.clone();
        }
        if !self.api_key_env.is_empty() {
            return std::env::var(&self.api_key_env).unwrap_or_default();
        }
        String::new()
    }

    /// 接口地址（去掉末尾斜杠）；没写时用各家官方地址。
    pub fn base(&self) -> String {
        let base = if self.base_url.is_empty() {
            match self.format.as_str() {
                "anthropic" => "https://api.anthropic.com",
                "gemini" => "https://generativelanguage.googleapis.com/v1beta",
                _ => "https://api.openai.com/v1",
            }
        } else {
            self.base_url.as_str()
        };
        base.trim_end_matches('/').to_string()
    }
}

/// 默认的配置文件位置：<索引目录>/.jmindex/config.yaml。
pub fn default_path(root: &Path) -> PathBuf {
    root.join(".jmindex").join("config.yaml")
}

/// 读配置。指定了文件就必须存在；没指定时用默认位置，不存在就写一份模板再按模板（不配模型）走。
pub fn load(root: &Path, explicit: Option<&Path>) -> Result<Config> {
    let file = match explicit {
        Some(file) => file.to_path_buf(),
        None => default_path(root),
    };
    if !file.exists() {
        if explicit.is_some() {
            bail!("配置文件 {} 不存在", file.display());
        }
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("建目录 {} 失败", dir.display()))?;
        }
        std::fs::write(&file, TEMPLATE).with_context(|| format!("写配置模板 {} 失败", file.display()))?;
    }
    let text = std::fs::read_to_string(&file).with_context(|| format!("读配置 {} 失败", file.display()))?;
    let mut config: Config = if text.trim().is_empty() {
        Config::default()
    } else {
        serde_yaml::from_str(&text).with_context(|| format!("配置 {} 不是合法的 YAML", file.display()))?
    };
    if let Some(model) = &config.model {
        if model.model.is_empty() {
            config.model = None;
        } else if !matches!(model.format.as_str(), "openai" | "anthropic" | "gemini") {
            bail!("model.format 只能是 openai、anthropic、gemini，现在是 {:?}", model.format);
        }
    }
    Ok(config)
}
