//! 壳子的配置（docs/界面/01_界面设计.md 第 2、4.2 节）：和 Bun 后端读同一个运行时目录、同一份 config.yaml、同一套键名。
//!
//! 运行时目录：命令行 --runtime > 环境变量 JMBOTS_RUNTIME > 可执行文件旁边的 jmbotsData/（发布给别人时运行时目录就在程序旁边）。
//! 壳子读的几项：server.port（后端端口；0.4 的 http.port 回落，过渡期用）、local.port、local.server、local.libs、local.rag、local.memory_model
//! （记忆库打 AI 标签用的模型，写成“供应商/模型”，地址和密钥从同一份 config.yaml 的 providers 里取；没写就不打标签）。
//! 后端地址：命令行 --server > 环境变量 JMBOTS_SERVER > config.yaml 的 local.server > 本机的 server.port。
//! 能配置的都不写死；默认值都在这个文件开头一处。config.yaml 没有时不报错，全用默认值（Bun 第一次启动会写出模板）。
//! 只读不写 config.yaml；也不把它的内容打出去（只取上面这几项）。
//! 基地在本机，调后端接口、开网页都不带令牌（用户 11-11：本机来的请求不查令牌）。

use std::path::{Path, PathBuf};

/// Bun 后端默认的端口（config.yaml 没写 server.port 也没写 http.port 时用）。
pub const DEFAULT_BACKEND_PORT: u16 = 30086;
/// 壳子 HTTP 接口默认的端口：和原来 memorycli serve 的默认端口一样，后端的 engine.index_url 不用改。
pub const DEFAULT_LOCAL_PORT: u16 = 30090;
/// 壳子的接口听哪个地址：一律 0.0.0.0（CLAUDE.md 的规矩）。
pub const LISTEN_HOST: &str = "0.0.0.0";
/// 窗口默认打开本机的后端。
pub const LOCAL_HOST: &str = "127.0.0.1";
/// 记忆库目录默认的名字（相对运行时目录）。
pub const DEFAULT_LIBS_DIR: &str = "data/index/libs";
/// RAG 索引目录默认的名字（相对运行时目录）。
pub const DEFAULT_RAG_DIR: &str = "data/index/rag";
/// 运行时目录的文件夹名：程序旁边的这个文件夹，存在就读取，不存在就创建（用户 11-05）。
pub const RUNTIME_DIR_NAME: &str = "jmbotsData";
/// 运行时目录的环境变量（和 Bun 后端一样）。
pub const RUNTIME_ENV: &str = "JMBOTS_RUNTIME";
/// 后端地址的环境变量。
pub const SERVER_ENV: &str = "JMBOTS_SERVER";
/// 配置文件名。
pub const CONFIG_FILE: &str = "config.yaml";

/// 命令行给的覆盖项。
#[derive(Debug, Default, Clone)]
pub struct Overrides {
    /// --runtime：运行时目录。
    pub runtime: Option<PathBuf>,
    /// --server：后端地址。
    pub server: Option<String>,
    /// --port：壳子 HTTP 接口的端口。
    pub port: Option<u16>,
    /// --host：壳子 HTTP 接口听哪个地址（调试用，如 127.0.0.1 免得 Windows 防火墙弹窗）；不写是 0.0.0.0。
    pub host: Option<String>,
}

/// 算好的配置。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Settings {
    /// 运行时目录。
    pub runtime: PathBuf,
    /// config.yaml 的路径。
    pub config_file: PathBuf,
    /// config.yaml 在不在。
    pub config_found: bool,
    /// 后端地址（不带结尾的斜杠），窗口打开它、check 连它。
    pub server: String,
    /// 后端的端口（config.yaml 的 server.port，0.4 的 http.port 回落）：基地拉起后端、试运行新版本（它加一）时用。
    pub backend_port: u16,
    /// 壳子的接口听哪个地址。
    pub listen_host: String,
    /// 壳子的接口听哪个端口。
    pub listen_port: u16,
    /// 记忆库目录：下面每个子目录一个 index.db。
    pub libs_dir: PathBuf,
    /// RAG 索引目录。
    pub rag_dir: PathBuf,
    /// 记忆库打 AI 标签用的模型；没写就不打标签。
    pub memory_model: Option<MemoryModel>,
    /// 界面语言（ui.language）；没写是 None。托盘菜单跟着它，重启基地生效。
    pub language: Option<String>,
    /// config.yaml 里写得不对的地方（读不了、类型不对……），用默认值顶上了；check 时报出来。
    pub problems: Vec<String>,
}

/// 记忆库打 AI 标签用的模型（local.memory_model 指的那个，地址和密钥来自 providers）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryModel {
    /// 写在 config.yaml 里的“供应商/模型”。
    pub id: String,
    /// 模型 ID（去掉供应商那一段）。
    pub model: String,
    /// 供应商的地址。
    pub base_url: String,
    /// 供应商的协议（providers.<名>.api，没写是 openai-completions）。
    pub api: String,
    /// 密钥：只在内存里，不打出去。
    #[serde(skip_serializing)]
    pub api_key: String,
}

/// 找 local.memory_model 指的模型：拆出供应商，去 providers 里拿地址、密钥、协议。
fn memory_model_at(root: &serde_yaml::Value, problems: &mut Vec<String>) -> Option<MemoryModel> {
    let id = text_at(root, &["local", "memory_model"], problems)?;
    let Some((provider, model)) = id.split_once('/') else {
        problems.push(format!("local.memory_model 要写成“供应商/模型”，现在是 {id}，这次不打 AI 标签"));
        return None;
    };
    let Some(base_url) = text_at(root, &["providers", provider, "base_url"], problems) else {
        problems.push(format!("local.memory_model 的供应商 {provider} 在 providers 里没有 base_url，这次不打 AI 标签"));
        return None;
    };
    Some(MemoryModel {
        id: id.clone(),
        model: model.to_string(),
        base_url,
        api: text_at(root, &["providers", provider, "api"], problems).unwrap_or_else(|| "openai-completions".to_string()),
        api_key: text_at(root, &["providers", provider, "api_key"], problems).unwrap_or_default(),
    })
}

/// 从 YAML 里按路径取一个值。
fn pick<'a>(root: &'a serde_yaml::Value, keys: &[&str]) -> Option<&'a serde_yaml::Value> {
    let mut current = root;
    for key in keys {
        current = current.get(*key)?;
    }
    Some(current)
}

/// 取一个端口：没写是 None；写了但不是 1～65535 的整数，记一条问题、当没写。
fn port_at(root: &serde_yaml::Value, keys: &[&str], problems: &mut Vec<String>) -> Option<u16> {
    let value = pick(root, keys)?;
    if value.is_null() {
        return None;
    }
    match value.as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port > 0) {
        Some(port) => Some(port),
        None => {
            problems.push(format!("{} 要是 1～65535 的整数，现在是 {value:?}，用默认值", keys.join(".")));
            None
        }
    }
}

/// 取一段文字：没写或是空的是 None；写了但不是文字，记一条问题、当没写。
fn text_at(root: &serde_yaml::Value, keys: &[&str], problems: &mut Vec<String>) -> Option<String> {
    let value = pick(root, keys)?;
    if value.is_null() {
        return None;
    }
    match value.as_str() {
        Some(text) if text.trim().is_empty() => None,
        Some(text) => Some(text.trim().to_string()),
        None => {
            problems.push(format!("{} 要是文字，现在是 {value:?}，用默认值", keys.join(".")));
            None
        }
    }
}

/// 相对运行时目录的路径变成绝对的；本来就是绝对路径的原样用。
fn under(runtime: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() { path.to_path_buf() } else { runtime.join(path) }
}

/// 算配置。
///
/// 输入：命令行的覆盖项、取环境变量的函数（测试里传假的）、可执行文件所在的目录。
/// 输出：算好的配置；config.yaml 读不了或写得不对时，用默认值顶上，原因记在 problems。
/// 副作用：读 config.yaml（只读）。
pub fn resolve(overrides: &Overrides, env: &dyn Fn(&str) -> Option<String>, exe_dir: &Path) -> Settings {
    let runtime = overrides
        .runtime
        .clone()
        .or_else(|| env(RUNTIME_ENV).filter(|dir| !dir.trim().is_empty()).map(PathBuf::from))
        .unwrap_or_else(|| exe_dir.join(RUNTIME_DIR_NAME));
    let config_file = runtime.join(CONFIG_FILE);
    let mut problems = Vec::new();
    // 读 config.yaml：没有就是空的；坏了记一条，当空的。
    let config_found = config_file.is_file();
    let root = if config_found {
        //M 记事本这些工具存的 UTF-8 开头可能带 BOM，serde_yaml 不认，要去掉（11-05 实测：整份配置被当成读不了）。
        match std::fs::read_to_string(&config_file).map_err(anyhow::Error::from).and_then(|text| serde_yaml::from_str::<serde_yaml::Value>(text.trim_start_matches('\u{feff}')).map_err(anyhow::Error::from)) {
            Ok(value) => value,
            Err(error) => {
                problems.push(format!("{} 读不了：{error}，全用默认值", config_file.display()));
                serde_yaml::Value::Null
            }
        }
    } else {
        serde_yaml::Value::Null
    };
    //M 后端端口：0.6 用 server.port；还没迁移的 0.4 config 回落 http.port，记一条提示（H 批）。
    let backend_port = match port_at(&root, &["server", "port"], &mut problems) {
        Some(port) => port,
        None => {
            let legacy = port_at(&root, &["http", "port"], &mut problems);
            if legacy.is_some() {
                problems.push("config.yaml 用的是 0.4 的 http.port：0.6 用 server.port，后端启动时会自动迁移".to_string());
            }
            legacy.unwrap_or(DEFAULT_BACKEND_PORT)
        }
    };
    let configured_server = text_at(&root, &["local", "server"], &mut problems);
    let listen_port = overrides.port.or(port_at(&root, &["local", "port"], &mut problems)).unwrap_or(DEFAULT_LOCAL_PORT);
    let libs = text_at(&root, &["local", "libs"], &mut problems).unwrap_or_else(|| DEFAULT_LIBS_DIR.to_string());
    let rag = text_at(&root, &["local", "rag"], &mut problems).unwrap_or_else(|| DEFAULT_RAG_DIR.to_string());
    let memory_model = memory_model_at(&root, &mut problems);
    let language = text_at(&root, &["ui", "language"], &mut problems);
    let server = overrides
        .server
        .clone()
        .or_else(|| env(SERVER_ENV).filter(|server| !server.trim().is_empty()))
        .or(configured_server)
        .unwrap_or_else(|| format!("http://{LOCAL_HOST}:{backend_port}"));
    Settings {
        libs_dir: under(&runtime, &libs),
        rag_dir: under(&runtime, &rag),
        runtime,
        config_file,
        config_found,
        server: server.trim().trim_end_matches('/').to_string(),
        backend_port,
        listen_host: overrides.host.clone().filter(|host| !host.trim().is_empty()).unwrap_or_else(|| LISTEN_HOST.to_string()),
        listen_port,
        memory_model,
        language,
        problems,
    }
}

/// 可执行文件所在的目录；拿不到时用当前目录。
pub fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_dir;

    /// 没有任何环境变量。
    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn defaults_without_config() {
        //M 不给 --runtime：运行时是可执行文件旁边的 jmbotsData/，libs、rag 都在它下面。
        let exe_dir = temp_dir("config-none");
        let runtime = exe_dir.join(RUNTIME_DIR_NAME);
        let settings = resolve(&Overrides::default(), &no_env, &exe_dir);
        assert_eq!(settings.runtime, runtime);
        assert_eq!(settings.config_file, runtime.join(CONFIG_FILE));
        assert!(!settings.config_found);
        assert_eq!(settings.server, format!("http://{LOCAL_HOST}:{DEFAULT_BACKEND_PORT}"));
        assert_eq!(settings.listen_port, DEFAULT_LOCAL_PORT);
        assert_eq!(settings.listen_host, "0.0.0.0");
        assert_eq!(settings.libs_dir, runtime.join(DEFAULT_LIBS_DIR));
        assert_eq!(settings.rag_dir, runtime.join(DEFAULT_RAG_DIR));
        assert!(settings.problems.is_empty());
    }

    #[test]
    fn reads_language_from_exe_dir_runtime() {
        //M 不传 --runtime、没有环境变量：config.yaml 从 exe 旁边的 jmbotsData/ 里读。
        let exe_dir = temp_dir("config-language");
        let runtime = exe_dir.join(RUNTIME_DIR_NAME);
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join(CONFIG_FILE), "ui:\n  language: en\n").unwrap();
        let settings = resolve(&Overrides::default(), &no_env, &exe_dir);
        assert_eq!(settings.runtime, runtime);
        assert!(settings.config_found);
        assert_eq!(settings.language.as_deref(), Some("en"));
    }

    #[test]
    fn reads_same_keys_as_bun() {
        let dir = temp_dir("config-keys");
        // 绝对路径要按这台机器的写法（Windows 带盘符），所以从临时目录拼出来。
        let absolute = dir.join("abs-rag");
        std::fs::write(dir.join(CONFIG_FILE), format!("providers:\n  x:\n    api_key: sk-fake\nhttp:\n  port: 31111\n  token: ''\nlocal:\n  port: 31122\n  libs: libs-here\n  rag: '{}'\n", absolute.display())).unwrap();
        let settings = resolve(&Overrides::default(), &no_env, Path::new("/没用到"));
        // 运行时目录没给时用 exe 所在目录：这里故意给一个不存在的，确认 config 是从 runtime 读的。
        assert!(!settings.config_found);
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert!(settings.config_found);
        //M 0.4 的 http.port 回落还能读对端口，但记一条迁移提示（H 批）。
        assert_eq!(settings.server, "http://127.0.0.1:31111");
        assert_eq!(settings.problems.len(), 1, "{:?}", settings.problems);
        assert!(settings.problems[0].contains("server.port"));
        assert_eq!(settings.listen_port, 31122);
        assert_eq!(settings.libs_dir, dir.join("libs-here"));
        assert_eq!(settings.rag_dir, absolute);
    }

    #[test]
    fn server_port_wins_over_http() {
        let dir = temp_dir("config-server-port");
        //M 0.6 的 server.port 优先；两个都在时不记迁移提示。
        std::fs::write(dir.join(CONFIG_FILE), "server:\n  port: 31113\nhttp:\n  port: 30086\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.backend_port, 31113);
        assert_eq!(settings.server, "http://127.0.0.1:31113");
        assert!(settings.problems.is_empty(), "{:?}", settings.problems);
        //M 只有 server.port 也一样。
        std::fs::write(dir.join(CONFIG_FILE), "server:\n  port: 31115\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.backend_port, 31115);
        assert!(settings.problems.is_empty(), "{:?}", settings.problems);
    }

    #[test]
    fn override_order() {
        let dir = temp_dir("config-order");
        std::fs::write(dir.join(CONFIG_FILE), "local:\n  server: http://10.0.0.2:30086/\n  port: 31000\n").unwrap();
        let env = |name: &str| match name {
            RUNTIME_ENV => Some(dir.to_string_lossy().to_string()),
            SERVER_ENV => Some("http://10.0.0.3:30086".to_string()),
            _ => None,
        };
        // 环境变量的运行时目录、环境变量的后端地址（比 config 的优先）。
        let settings = resolve(&Overrides::default(), &env, Path::new("/没用到"));
        assert_eq!(settings.runtime, dir);
        assert_eq!(settings.server, "http://10.0.0.3:30086");
        assert_eq!(settings.listen_port, 31000);
        // 命令行最优先。
        let settings = resolve(&Overrides { server: Some("http://10.0.0.4:1/".into()), port: Some(32000), ..Overrides::default() }, &env, Path::new("/没用到"));
        assert_eq!(settings.server, "http://10.0.0.4:1");
        assert_eq!(settings.listen_port, 32000);
        // 没有环境变量时用 config 的 local.server，去掉结尾的斜杠。
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.server, "http://10.0.0.2:30086");
    }

    #[test]
    fn memory_model_comes_from_providers() {
        let dir = temp_dir("config-memory-model");
        std::fs::write(dir.join(CONFIG_FILE), "providers:\n  magpie:\n    base_url: http://127.0.0.1:1/v1\n    api_key: fake-key-1234\nlocal:\n  memory_model: magpie/workbuddy/x\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        let model = settings.memory_model.clone().expect("有模型");
        assert_eq!(model.model, "workbuddy/x");
        assert_eq!(model.base_url, "http://127.0.0.1:1/v1");
        assert_eq!(model.api, "openai-completions");
        // 密钥不打出去。
        assert!(!serde_json::to_string(&settings).unwrap().contains("fake-key-1234"));
        std::fs::write(dir.join(CONFIG_FILE), "local:\n  memory_model: 没有斜杠\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert!(settings.memory_model.is_none());
        assert_eq!(settings.problems.len(), 1);
    }

    #[test]
    fn bad_values_fall_back_with_problems() {
        let dir = temp_dir("config-bad");
        std::fs::write(dir.join(CONFIG_FILE), "http:\n  port: 七万\nlocal:\n  port: 70000\n  libs: [1]\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.server, format!("http://{LOCAL_HOST}:{DEFAULT_BACKEND_PORT}"));
        assert_eq!(settings.listen_port, DEFAULT_LOCAL_PORT);
        assert_eq!(settings.libs_dir, dir.join(DEFAULT_LIBS_DIR));
        assert_eq!(settings.problems.len(), 3, "{:?}", settings.problems);
        std::fs::write(dir.join(CONFIG_FILE), "http: [坏的\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.problems.len(), 1);
        assert_eq!(settings.listen_port, DEFAULT_LOCAL_PORT);
    }
}
