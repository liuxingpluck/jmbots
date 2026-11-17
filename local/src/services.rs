//! 另外托管的服务（2026-11-14 起壳子不再托管业务服务：记忆服务、vgr 归 memory 插件，这里的表恒为空，接口 /services 保留兼容）。
//! 原说明：另外托管的服务（local.services，默认是记忆服务 jmbots-memory）：基地只承载——拉起、守护、重启、记日志，不碰业务。
//! 主后端 jmbots-server 有更新流程，在 supervisor.rs；这里的服务没有更新流程（以后要的话照 supervisor 加）。
//!   守护：每隔几秒看健康路径；进程退出了或者一直不答就重启，连续起不来越等越久；端口上已经有人答（别人起的）就不抢。
//!   程序文件不在：只记一次日志，等它出现（用户把 jmbots-memory.exe 放进运行时就自动拉起）。
//!   日志：<运行时>/data/logs/<服务名>.log。

use crate::config::{LOCAL_HOST, ServiceSpec, Settings, under};
use crate::{backend, log, supervisor};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 多久看一眼。
const WATCH_EVERY: Duration = Duration::from_secs(3);
/// 连续多少次不答算卡死。
const UNHEALTHY_LIMIT: u32 = 20;
/// 重启之间最多隔多久。
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// 看健康最多等多久。
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);

/// 一个托管服务的运行情况。
struct Hosted {
    /// 配置里的这一项。
    spec: ServiceSpec,
    /// 基地拉起的进程；别人起的、还没起的是 None。
    child: Mutex<Option<Child>>,
    /// 最近一句状态（给 /services 看）。
    note: Mutex<String>,
}

/// 全部托管服务。
pub struct Services {
    /// 配置。
    settings: Settings,
    /// 每个服务一项。
    items: Vec<Arc<Hosted>>,
    /// 要停了（从托盘退出）。
    stopping: Arc<AtomicBool>,
}

/// 服务程序在哪：写绝对路径就用它，否则在运行时目录下；Windows 补 .exe。
pub fn service_file(settings: &Settings, spec: &ServiceSpec) -> PathBuf {
    let name = if spec.file.ends_with(std::env::consts::EXE_SUFFIX) { spec.file.clone() } else { format!("{}{}", spec.file, std::env::consts::EXE_SUFFIX) };
    under(&settings.runtime, &name)
}

/// 服务的地址（本机）。
fn base_of(spec: &ServiceSpec) -> String {
    format!("http://{LOCAL_HOST}:{}", spec.port)
}

/// 服务答话吗。
fn healthy(spec: &ServiceSpec) -> bool {
    backend::health_at(&backend::agent(HEALTH_TIMEOUT), &base_of(spec), &spec.health).is_ok()
}

impl Services {
    /// 开始守护全部服务。
    ///
    /// 输入：配置。输出：服务表。副作用：每个服务一个后台线程，可能拉起进程。
    pub fn start(settings: &Settings) -> Arc<Self> {
        let services = Arc::new(Self::new(settings));
        for item in &services.items {
            let (item, settings, stopping) = (Arc::clone(item), settings.clone(), Arc::clone(&services.stopping));
            std::thread::spawn(move || watch(&settings, &item, &stopping));
        }
        services
    }

    /// 只建表、不开线程（serve 不带 --supervise、测试用）。
    pub fn new(settings: &Settings) -> Self {
        let items = settings.services.iter().map(|spec| Arc::new(Hosted { spec: spec.clone(), child: Mutex::new(None), note: Mutex::new(String::new()) })).collect();
        Self { settings: settings.clone(), items, stopping: Arc::new(AtomicBool::new(false)) }
    }

    /// GET /services：每个服务的名字、端口、程序在不在、健康不健康、最近一句状态。
    pub fn status(&self) -> Value {
        let list: Vec<Value> = self
            .items
            .iter()
            .map(|item| {
                let file = service_file(&self.settings, &item.spec);
                json!({
                    "name": item.spec.name,
                    "url": base_of(&item.spec),
                    "health": item.spec.health,
                    "file": file,
                    "installed": file.is_file(),
                    "healthy": healthy(&item.spec),
                    "managed": item.child.lock().map(|child| child.is_some()).unwrap_or(false),
                    "note": item.note.lock().map(|note| note.clone()).unwrap_or_default(),
                })
            })
            .collect();
        json!({ "services": list })
    }

    /// 有没有这个服务。
    pub fn has(&self, name: &str) -> bool {
        self.items.iter().any(|item| item.spec.name == name)
    }

    /// POST /restart?service=名：停掉它，守护线程看到它不在了马上重新拉起。
    ///
    /// 输出：开始了没有；没有这个服务、程序不在时说原因。
    pub fn restart(&self, name: &str) -> Result<(), String> {
        let item = self.items.iter().find(|item| item.spec.name == name).ok_or_else(|| format!("没有叫 {name} 的托管服务"))?;
        if !service_file(&self.settings, &item.spec).is_file() {
            return Err(format!("运行时里没有 {}，停了就拉不起来", item.spec.file));
        }
        if let Some(mut running) = item.child.lock().map_err(|_| "锁坏了".to_string())?.take() {
            let _ = running.kill();
            let _ = running.wait();
            log::line(&self.settings, &format!("重启服务 {name}：已停掉，守护马上重新拉起"));
            return Ok(());
        }
        Err(format!("{name} 不是基地拉起的（别人起的），基地不停它"))
    }

    /// 从托盘退出：停掉基地拉起的全部服务。
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        for item in &self.items {
            if let Ok(mut child) = item.child.lock() {
                if let Some(mut running) = child.take() {
                    let _ = running.kill();
                    let _ = running.wait();
                }
            }
        }
    }
}

/// 拉起一个服务，输出记到 data/logs/<名>.log。
fn spawn(settings: &Settings, spec: &ServiceSpec) -> Result<Child> {
    let dir = settings.runtime.join("data").join("logs");
    std::fs::create_dir_all(&dir)?;
    let log_file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{}.log", spec.name)))?;
    let file = service_file(settings, spec);
    let mut command = Command::new(&file);
    command
        .args(backend::fill_args(&spec.args, &settings.runtime, spec.port))
        .env("JMBOTS_SUPERVISED", "1")
        .stdin(Stdio::null())
        .stdout(log_file.try_clone()?)
        .stderr(log_file);
    supervisor::hide_window(&mut command);
    command.spawn().with_context(|| format!("拉不起来 {}", file.display()))
}

/// 守护一个服务，直到要停。
fn watch(settings: &Settings, item: &Hosted, stopping: &AtomicBool) {
    let mut unhealthy = 0u32;
    let mut backoff = WATCH_EVERY;
    let mut told_missing = false;
    let mut started_once = false;
    let set_note = |text: String| {
        if let Ok(mut note) = item.note.lock() {
            *note = text;
        }
    };
    //M 第一次不等：基地起来就拉。
    let mut first = true;
    while !stopping.load(Ordering::SeqCst) {
        if !first {
            std::thread::sleep(WATCH_EVERY);
        }
        first = false;
        if stopping.load(Ordering::SeqCst) {
            break;
        }
        if healthy(&item.spec) {
            unhealthy = 0;
            backoff = WATCH_EVERY;
            set_note("在跑".to_string());
            continue;
        }
        unhealthy += 1;
        let mut child = item.child.lock().expect("服务的锁");
        let exited = match child.as_mut() {
            Some(running) => running.try_wait().ok().flatten().is_some(),
            None => true,
        };
        //G 还在跑、只是还没答：多等等，真卡死了才重启。
        if !exited && unhealthy < UNHEALTHY_LIMIT {
            continue;
        }
        if let Some(mut stuck) = child.take() {
            let _ = stuck.kill();
            let _ = stuck.wait();
        }
        let file = service_file(settings, &item.spec);
        if !file.is_file() {
            if !told_missing {
                log::line(settings, &format!("托管服务 {} 的程序不在：{}（放进去就会自动拉起）", item.spec.name, file.display()));
                told_missing = true;
            }
            set_note(format!("程序不在：{}", file.display()));
            continue;
        }
        told_missing = false;
        match spawn(settings, &item.spec) {
            Ok(started) => {
                log::line(settings, &format!("托管服务 {} 不在了，已经拉起", item.spec.name));
                if started_once {
                    crate::notify::info("服务已重启", &format!("托管服务 {} 刚才不在了，已经重新拉起", item.spec.name));
                }
                started_once = true;
                set_note("刚拉起".to_string());
                *child = Some(started);
                unhealthy = 0;
            }
            Err(error) => {
                log::line(settings, &format!("{error:#}"));
                set_note(format!("{error:#}"));
                crate::notify::error("服务拉不起来", &format!("{}：{error:#}", item.spec.name));
            }
        }
        drop(child);
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Overrides, resolve};
    use crate::test_support::temp_dir;

    #[test]
    fn local_services_are_ignored_now() {
        //M 2026-11-14：local.services 归 memory 插件，壳子读到也不托管。
        let dir = temp_dir("services");
        std::fs::write(dir.join("config.yaml"), "local:\n  services:\n    - name: memory\n      file: jmbots-memory-test\n      port: 1\n      health: /v1/health\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(dir.clone()), ..Overrides::default() }, &|_| None, &dir);
        let services = Services::new(&settings);
        assert_eq!(services.status()["services"].as_array().map(Vec::len), Some(0));
        assert!(!services.has("memory"));
        assert!(services.restart("memory").unwrap_err().contains("没有叫"));
    }

    #[test]
    fn fill_args_replaces_placeholders() {
        let runtime = std::path::Path::new("R");
        let args = backend::fill_args(&["--port".into(), "{port}".into(), "--data".into(), "{data}/memory".into(), "{runtime}".into()], runtime, 15790);
        assert_eq!(args[1], "15790");
        assert!(args[3].ends_with("memory") && args[3].contains("data"));
        assert_eq!(args[4], "R");
    }
}
