//! 壳子的配置（docs/界面/01_界面设计.md 第 2、4.2 节）：和 Bun 后端读同一个运行时目录、同一份 config.yaml、同一套键名。
//!
//! 运行时目录：命令行 --runtime > 环境变量 JMBOTS_RUNTIME > 可执行文件旁边的 jmbotsData/（发布给别人时运行时目录就在程序旁边）。
//! 壳子读的几项：server.port（后端端口；0.4 的 http.port 回落，过渡期用）、shell.port、shell.server、
//! shell.backend（主后端的参数、健康路径）。旧名 local: 过渡期照读（shell 优先）。
//! 记忆服务与 vgr 归主后端的 memory 插件托管。
//! 2026-11-14 用户定“基地只承载”：记忆库、RAG、AI 标签整个挪进独立的记忆服务 jmbots-memory，壳子不再读 local.libs/rag/memory_model。
//! 后端地址：命令行 --server > 环境变量 JMBOTS_SERVER > config.yaml 的 local.server > 本机的 server.port。
//! 能配置的都不写死；默认值都在这个文件开头一处。config.yaml 没有时不报错，全用默认值（Bun 第一次启动会写出模板）。
//! 只读不写 config.yaml；也不把它的内容打出去（只取上面这几项）。
//! 基地在本机，调后端接口、开网页都不带令牌（用户 11-11：本机来的请求不查令牌）。

use std::path::{Path, PathBuf};

/// Bun 后端默认的端口（config.yaml 没写 server.port 也没写 http.port 时用）。
pub const DEFAULT_BACKEND_PORT: u16 = 30086;
/// 壳子管理接口默认端口，与后端的 engine.index_url 对应。
pub const DEFAULT_LOCAL_PORT: u16 = 30085;
/// 壳子的接口听哪个地址：一律 0.0.0.0（CLAUDE.md 的规矩）。
pub const LISTEN_HOST: &str = "0.0.0.0";
/// 窗口默认打开本机的后端。
pub const LOCAL_HOST: &str = "127.0.0.1";
/// 记忆服务的内部端口（主端口顺延：30086 + 1）。2026-11-14 起由 memory 插件托管，壳子只留这个常量给说明和兼容。
pub const DEFAULT_MEMORY_PORT: u16 = 30087;
/// 主后端默认的启动参数；{runtime} 换成运行时目录、{port} 换成后端端口。
pub const DEFAULT_BACKEND_ARGS: [&str; 3] = ["serve", "--runtime", "{runtime}"];
/// 主后端默认的健康路径。
pub const DEFAULT_BACKEND_HEALTH: &str = "/api/health";
/// 停写窗口等待主站退出的默认秒数。
const DEFAULT_STOP_TIMEOUT_SECS: u64 = 30;
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
    /// 换版本试运行用的端口（shell.trial_port）；不写是 None：从主端口加一往后找第一个空的。
    pub trial_port: Option<u16>,
    /// 壳子的接口听哪个地址。
    pub listen_host: String,
    /// 壳子的接口听哪个端口。
    pub listen_port: u16,
    /// 主后端（jmbots-server，有更新流程）怎么起、怎么看健康。
    pub backend: BackendSpec,
    /// 另外要托管的服务（记忆服务等）：只守护、重启、记日志，不走更新流程。
    pub services: Vec<ServiceSpec>,
    /// 界面语言（ui.language）；没写是 None。托盘菜单跟着它，重启基地生效。
    pub language: Option<String>,
    /// config.yaml 里写得不对的地方（读不了、类型不对……），用默认值顶上了；check 时报出来。
    pub problems: Vec<String>,
}

/// 主后端怎么起（local.backend）：文件名固定 jmbots-server（换版本、防火墙靠固定名字），参数和健康路径可配。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackendSpec {
    /// 启动参数；{runtime}、{port} 会被换掉。
    pub args: Vec<String>,
    /// 健康路径，如 /api/health。
    pub health: String,
    /// 停写窗口等待主站正常退出的秒数。
    pub stop_timeout_secs: u64,
}

/// 一个要托管的服务（local.services 的一项）。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct ServiceSpec {
    /// 服务名（/restart?service=名、/services 里用）。
    pub name: String,
    /// 程序文件（相对运行时目录，惯例放 program/<服务名>/ 下，不带 .exe）；也可以写绝对路径。
    pub file: String,
    /// 启动参数；{runtime}、{port}、{data}（运行时 data 目录）会被换掉。
    pub args: Vec<String>,
    /// 听哪个端口（本机）。
    pub port: u16,
    /// 健康路径，如 /v1/health。
    pub health: String,
}

/// 默认托管的服务：记忆服务 jmbots-memory（程序不在时守护只记一句，不报错）。
/// 运行时（bun、node、python、模型、各服务程序）统一放 <运行时>/program/（用户 11-14 规划），所以程序在 program/jmbots-memory/ 下；
/// 记忆服务自己按 --runtime 找模型（program/models/bge-m3-onnx-int8）、ONNX Runtime（program/onnxruntime/）和数据（data/memory）。
fn default_services() -> Vec<ServiceSpec> {
    // 2026-11-14：记忆服务归 memory 插件；壳子不再默认托管任何业务服务。
    Vec::new()
}

/// 取一串文字（参数表）：没写是 None；不是文字数组记一条问题、当没写。
fn texts_at(root: &serde_yaml::Value, keys: &[&str], problems: &mut Vec<String>) -> Option<Vec<String>> {
    let value = pick(root, keys)?;
    if value.is_null() {
        return None;
    }
    let items = value.as_sequence().and_then(|items| items.iter().map(|item| item.as_str().map(str::to_string)).collect::<Option<Vec<_>>>());
    if items.is_none() {
        problems.push(format!("{} 要是文字列表，现在是 {value:?}，用默认值", keys.join(".")));
    }
    items
}

/// 读 local.services：没写用默认（记忆服务）；写成空列表就是不托管别的服务；某一项写错记问题、跳过这一项。
fn services_at(root: &serde_yaml::Value, problems: &mut Vec<String>) -> Vec<ServiceSpec> {
    // 旧 local.services 不再读取，避免壳子和插件重复启动同一业务服务。
    let _ = (root, problems);
    default_services()
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

/// 相对运行时目录的路径变成绝对的；本来就是绝对路径的原样用（托管服务的 file 写相对路径时用）。
pub fn under(runtime: &Path, path: &str) -> PathBuf {
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
    // 迁移期：shell 优先；旧 local 仅兼容壳子自身字段，不兼容 services。
    let mut root = root;
    if let Some(shell) = root.get("shell").cloned() {
        if let Some(map) = root.as_mapping_mut() { map.insert(serde_yaml::Value::from("local"), shell); }
    }
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
    let trial_port = port_at(&root, &["local", "trial_port"], &mut problems);
    let listen_port = overrides.port.or(port_at(&root, &["local", "port"], &mut problems)).unwrap_or(DEFAULT_LOCAL_PORT);
    let stop_timeout_secs = match pick(&root, &["local", "backend", "stop_timeout_secs"]) {
        None => DEFAULT_STOP_TIMEOUT_SECS,
        Some(value) => match value.as_u64() {
            Some(seconds @ 1..=300) => seconds,
            _ => {
                problems.push("shell.backend.stop_timeout_secs 要填 1 到 300 的整数".to_string());
                DEFAULT_STOP_TIMEOUT_SECS
            }
        },
    };
    let backend = BackendSpec {
        args: texts_at(&root, &["local", "backend", "args"], &mut problems).unwrap_or_else(|| DEFAULT_BACKEND_ARGS.iter().map(|arg| arg.to_string()).collect()),
        health: text_at(&root, &["local", "backend", "health"], &mut problems).unwrap_or_else(|| DEFAULT_BACKEND_HEALTH.to_string()),
        stop_timeout_secs,
    };
    let services = services_at(&root, &mut problems);
    let language = text_at(&root, &["ui", "language"], &mut problems);
    let server = overrides
        .server
        .clone()
        .or_else(|| env(SERVER_ENV).filter(|server| !server.trim().is_empty()))
        .or(configured_server)
        .unwrap_or_else(|| format!("http://{LOCAL_HOST}:{backend_port}"));
    Settings {
        backend,
        services,
        runtime,
        config_file,
        config_found,
        server: server.trim().trim_end_matches('/').to_string(),
        backend_port,
        trial_port,
        listen_host: overrides.host.clone().filter(|host| !host.trim().is_empty()).or_else(|| text_at(&root, &["local", "host"], &mut problems)).unwrap_or_else(|| LISTEN_HOST.to_string()),
        listen_port,
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
        //M 基地用默认的后端命令和健康检查路径。
        assert!(settings.services.is_empty());
        assert_eq!(settings.backend.args, vec!["serve", "--runtime", "{runtime}"]);
        assert_eq!(settings.backend.health, "/api/health");
        assert_eq!(settings.backend.stop_timeout_secs, 30);
        assert!(settings.problems.is_empty());
    }

    #[test]
    fn window_timeout_reads_shell_backend_setting() {
        let runtime = temp_dir("config-window");
        let config = runtime.join(CONFIG_FILE);
        let overrides = Overrides { runtime: Some(runtime.clone()), ..Overrides::default() };
        std::fs::write(&config, "shell:\n  backend:\n    stop_timeout_secs: 45\n").unwrap();
        let custom = resolve(&overrides, &no_env, &runtime);
        assert_eq!(custom.backend.stop_timeout_secs, 45);
        assert!(custom.problems.is_empty());

        std::fs::write(&config, "shell:\n  backend:\n    stop_timeout_secs: 0\n").unwrap();
        let invalid = resolve(&overrides, &no_env, &runtime);
        assert_eq!(invalid.backend.stop_timeout_secs, 30);
        assert!(invalid.problems.iter().any(|problem| problem.contains("stop_timeout_secs")));
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
        std::fs::write(dir.join(CONFIG_FILE), "providers:\n  x:\n    api_key: sk-fake\nhttp:\n  port: 31111\n  token: ''\nlocal:\n  port: 31122\n").unwrap();
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
    fn services_and_backend_are_configurable() {
        let dir = temp_dir("config-services");
        std::fs::write(
            dir.join(CONFIG_FILE),
            "local:\n  backend:\n    args: [serve, --runtime, '{runtime}', --quiet]\n    health: /api/ping\n  services:\n    - name: memory\n      file: jmbots-memory\n      args: [serve, --port, '{port}']\n      port: 15790\n      health: /v1/health\n    - name: 坏的\n      file: x\n",
        )
        .unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.backend.args, vec!["serve", "--runtime", "{runtime}", "--quiet"]);
        assert_eq!(settings.backend.health, "/api/ping");
        //M 2026-11-14：local.services 不再读（归 memory 插件），写了也是空表。
        assert!(settings.services.is_empty());
    }

    #[test]
    fn shell_section_wins_over_local() {
        let dir = temp_dir("config-shell");
        std::fs::write(dir.join(CONFIG_FILE), "server:\n  port: 31086\nlocal:\n  port: 30090\nshell:\n  port: 31085\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.listen_port, 31085);
        assert_eq!(settings.backend_port, 31086);
    }

    #[test]
    fn bad_values_fall_back_with_problems() {
        let dir = temp_dir("config-bad");
        std::fs::write(dir.join(CONFIG_FILE), "http:\n  port: 七万\nlocal:\n  port: 70000\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.server, format!("http://{LOCAL_HOST}:{DEFAULT_BACKEND_PORT}"));
        assert_eq!(settings.listen_port, DEFAULT_LOCAL_PORT);
        assert_eq!(settings.problems.len(), 2, "{:?}", settings.problems);
        std::fs::write(dir.join(CONFIG_FILE), "http: [坏的\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &no_env, Path::new("/没用到"));
        assert_eq!(settings.problems.len(), 1);
        assert_eq!(settings.listen_port, DEFAULT_LOCAL_PORT);
    }
}
