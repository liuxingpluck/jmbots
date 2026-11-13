//! 基地守护后端、自动更新（docs/界面/02_一个程序跑起来的规划.md 第 5、6 步）。
//!
//! 后端是编译好的单文件 <运行时>/jmbots-server.exe，正在跑的是它，源码随便改都影响不到（用户 11-05：jmbots 要能自己改自己）。
//!   守护：基地起来就拉起它（后台、不弹窗），每隔几秒看一眼，退出了或者一直没响应就重启；从托盘退出时连它一起停。
//!         已经有后端在跑（看门狗起的、上次留下的）就不抢，只看着。后端配在别的机器上时不管。
//!   更新：scripts/Build_Release.ts 把新版本放进 <运行时>/updates/。基地定时扫，对新文件跑 version 和现在的比；
//!         有新的就在接口里说（网页左下角提醒，列出每个版本做了什么），用户点了才换：
//!         新版本先复制成固定名字 jmbots-server-new 在试运行端口起来 → 健康了才停旧的、换文件、起正式的 → 起不来就退回旧版本，说明原因。
//!         上一个版本留一份 jmbots-server-old。名字固定，Windows 防火墙信任一次就不再弹（用户 11-06）。
//!         运行时里还没有后端、也没有后端在跑时，直接用 updates/ 里最新的（第一次装）。
//!   重启：网页设置“重连”里的“重启服务”经后端转到 POST /restart，这里停掉后端，守护线程看到它不在了马上重新拉起。

use crate::config::Settings;
use crate::{backend, log};
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 多久看一眼后端。
const WATCH_EVERY: Duration = Duration::from_secs(3);
/// 连续多少次没响应算卡死（启动慢的后端也够用）。
const UNHEALTHY_LIMIT: u32 = 40;
/// 重启之间最多隔多久（连续起不来时越等越久）。
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// 多久扫一次 updates/。
const SCAN_EVERY: Duration = Duration::from_secs(30);
/// 新版本要在这么久内健康。
const HEALTH_WAIT: Duration = Duration::from_secs(90);
/// 打印版本最多等多久。
const VERSION_WAIT: Duration = Duration::from_secs(30);
/// 重启服务时先等多久再停后端：让后端先把这次请求答完（它在等基地的回答）。
const RESTART_DELAY: Duration = Duration::from_secs(1);
/// 新版本在 updates/ 里的文件名开头（和 scripts/Build_Release.ts 一样）。
const RELEASE_PREFIX: &str = "jmbots-server-";

/// 这个平台上后端的文件名。
fn server_name() -> String {
    format!("jmbots-server{}", std::env::consts::EXE_SUFFIX)
}

/// 试运行用的固定文件名：updates/ 里的文件名每次不同，Windows 防火墙按程序路径记规则会每次都问，
/// 先复制成这个固定名字再试运行，信任一次就不再问（用户 11-06：“试运行确实要改用固定文件名”）。
fn new_server_name() -> String {
    format!("jmbots-server-new{}", std::env::consts::EXE_SUFFIX)
}

/// 上一个版本的固定文件名，退回时用。
fn old_server_name() -> String {
    format!("jmbots-server-old{}", std::env::consts::EXE_SUFFIX)
}

/// 新版本文件名末尾的时间戳（jmbots-server-<版本>-<时间>.exe）；没有就是空的。
///
/// 输入：文件路径。输出：时间戳字符串，位数一样，按字符串比就是按时间比。
pub fn release_stamp(file: &Path) -> String {
    file.file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| stem.rsplit('-').next())
        .filter(|stamp| stamp.len() >= 14 && stamp.chars().all(|char| char.is_ascii_digit()))
        .unwrap_or("")
        .to_string()
}

/// version 子进程输出在读取边界校验后形成的明确版本信息。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VersionInfo {
    /// 当前版本标识，不能为空。
    version: String,
    /// 构建时间，由后端以毫秒时间戳提供。
    #[serde(rename = "builtAt")]
    built_at: u64,
    /// 后端完整版本说明，缺失属于协议错误。
    versions: Vec<VersionChange>,
}

/// 一条版本说明；保留后端提供的其余说明字段。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VersionChange {
    /// 版本标识，不能为空。
    version: String,
    /// 日期、改动说明等展示内容，不参与版本比较。
    #[serde(flatten)]
    details: serde_json::Map<String, Value>,
}

/// 外部输出只在这里校验；内部比较不再用 0 或空串代替缺字段。
fn parse_version(bytes: &[u8]) -> Result<VersionInfo> {
    let version: VersionInfo = serde_json::from_slice(bytes)
        .context("version 输出缺少必要字段或类型错误")?;
    if version.version.trim().is_empty()
        || version.versions.iter()
            .any(|change| change.version.trim().is_empty())
    {
        bail!("version 输出包含空版本号");
    }
    Ok(version)
}

/// 两份已校验的版本按构建时间比较；同版本号重新构建也可更新。
pub fn is_newer(new: &VersionInfo, current: &VersionInfo) -> bool {
    new.built_at > current.built_at
}

/// 收集当前版本之前的说明；首次安装没有当前版本时返回全部。
pub fn changes_since(new: &VersionInfo, current_version: Option<&str>) -> Vec<VersionChange> {
    new.versions.iter()
        .take_while(|change| Some(change.version.as_str()) != current_version)
        .cloned()
        .collect()
}

/// 跑 `<程序> version`，读 JSON。
///
/// 输入：程序路径。输出：它打印的 JSON。副作用：跑一下这个程序。
fn read_version(file: &Path) -> Result<VersionInfo> {
    let mut command = Command::new(file);
    command.arg("version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut command);
    let mut child = command.spawn().with_context(|| format!("跑不起来 {}", file.display()))?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > VERSION_WAIT {
            let _ = child.kill();
            bail!("{} 打印版本超时", file.display());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!("{} 打印版本失败：{}", file.display(), output.status);
    }
    parse_version(&output.stdout).with_context(|| format!("{} 打印的版本无效", file.display()))
}

/// 开子进程时不弹黑框（别的系统什么也不做）。
pub(crate) fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// CREATE_NO_WINDOW：不给子进程开控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 现在的更新状态（GET /update 回这些）。
#[derive(Default)]
struct UpdateState {
    /// 现在跑的版本（version 的输出）。
    current: Option<VersionInfo>,
    /// 新版本的文件。
    available_file: Option<PathBuf>,
    /// 新版本（version 的输出）。
    available: Option<VersionInfo>,
    /// 正在换吗。
    applying: bool,
    /// 上一次换的结果（给用户看的一句话）。
    message: String,
}

/// 守护和更新。
pub struct Supervisor {
    /// 配置。
    settings: Settings,
    /// 基地拉起来的后端；别人起的是 None。
    child: Mutex<Option<Child>>,
    /// 更新状态。
    state: Mutex<UpdateState>,
    /// 要停了（从托盘退出）。
    stopping: AtomicBool,
    /// 正在换版本：这时候守护不插手。
    paused: AtomicBool,
}

impl Supervisor {
    /// 开始守护和扫描。
    ///
    /// 输入：配置。输出：守护对象。副作用：开两个后台线程；可能拉起后端。
    pub fn start(settings: &Settings) -> Arc<Self> {
        let supervisor = Arc::new(Self { settings: settings.clone(), child: Mutex::new(None), state: Mutex::new(UpdateState::default()), stopping: AtomicBool::new(false), paused: AtomicBool::new(false) });
        let watcher = Arc::clone(&supervisor);
        std::thread::spawn(move || watcher.watch());
        let scanner = Arc::clone(&supervisor);
        std::thread::spawn(move || scanner.scan_loop());
        supervisor
    }

    /// 后端程序在哪。
    fn server_file(&self) -> PathBuf {
        self.settings.runtime.join(server_name())
    }

    /// 新版本放在哪。
    fn updates_dir(&self) -> PathBuf {
        self.settings.runtime.join("updates")
    }

    /// 后端在这台机器上吗：local.server 指到别的机器时不守护。
    fn is_local(&self) -> bool {
        self.settings.server == format!("http://{}:{}", crate::config::LOCAL_HOST, self.settings.backend_port)
    }

    /// 后端答话吗。
    fn healthy(&self, base: &str) -> bool {
        backend::health(&backend::agent(backend::TIMEOUT), base).is_ok()
    }

    /// 拉起后端（普通模式），输出记到运行时 data/logs/backend.log。
    fn spawn_server(&self, file: &Path) -> Result<Child> {
        let dir = self.settings.runtime.join("data").join("logs");
        std::fs::create_dir_all(&dir)?;
        let log_file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("backend.log"))?;
        let mut command = Command::new(file);
        command
            .args(["serve", "--runtime"])
            .arg(&self.settings.runtime)
            .env("JMBOTS_SUPERVISED", "1")
            .stdin(Stdio::null())
            .stdout(log_file.try_clone()?)
            .stderr(log_file);
        hide_window(&mut command);
        command.spawn().with_context(|| format!("拉不起来 {}", file.display()))
    }

    /// 守护线程：退出了或者一直没响应就重启；连续起不来时越等越久。
    fn watch(self: Arc<Self>) {
        if !self.is_local() {
            return;
        }
        let mut unhealthy = 0u32;
        let mut backoff = WATCH_EVERY;
        while !self.stopping.load(Ordering::SeqCst) {
            std::thread::sleep(WATCH_EVERY);
            if self.paused.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) {
                continue;
            }
            if self.healthy(&self.settings.server) {
                unhealthy = 0;
                backoff = WATCH_EVERY;
                continue;
            }
            unhealthy += 1;
            let mut child = self.child.lock().expect("守护的锁");
            let exited = match child.as_mut() {
                Some(running) => running.try_wait().ok().flatten().is_some(),
                None => true,
            };
            //G 还在跑、只是还没响应：多等等，真卡死了才重启。
            if !exited && unhealthy < UNHEALTHY_LIMIT {
                continue;
            }
            if let Some(mut stuck) = child.take() {
                let _ = stuck.kill();
                let _ = stuck.wait();
            }
            let file = self.server_file();
            //M 第一次装：运行时里还没有后端，用 updates/ 里最新的。
            if !file.is_file() {
                if let Some(newest) = self.newest_release() {
                    if let Err(error) = std::fs::rename(&newest, &file) {
                        log::line(&self.settings, &format!("没能用上 {}：{error}", newest.display()));
                    }
                }
            }
            if !file.is_file() {
                continue;
            }
            match self.spawn_server(&file) {
                Ok(started) => {
                    log::line(&self.settings, "后端不在了，已经重新拉起");
                    *child = Some(started);
                    unhealthy = 0;
                }
                Err(error) => log::line(&self.settings, &format!("{error:#}")),
            }
            drop(child);
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    /// updates/ 里最新的文件（文件名带时间，按名字排）。
    fn newest_release(&self) -> Option<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(self.updates_dir())
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .filter(|file| file.is_file() && file.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(RELEASE_PREFIX) && !name.ends_with(".tmp")))
            .collect();
        //M 按文件名末尾的时间戳挑最新的，不按整个文件名：“0.2.10”按字母排在“0.2.9”前面（11-06 踩过）。
        files.sort_by_key(|file| release_stamp(file));
        files.pop()
    }

    /// 扫描线程：定时看 updates/ 有没有比现在新的。
    fn scan_loop(self: Arc<Self>) {
        let mut seen: Option<PathBuf> = None;
        while !self.stopping.load(Ordering::SeqCst) {
            self.scan_once(&mut seen);
            std::thread::sleep(SCAN_EVERY);
        }
    }

    /// 扫一次。
    fn scan_once(&self, seen: &mut Option<PathBuf>) {
        let server = self.server_file();
        let current = if server.is_file() {
            match read_version(&server) {
                Ok(version) => Some(version),
                Err(error) => {
                    let mut state = self.state.lock().expect("更新状态的锁");
                    if state.applying {
                        return;
                    }
                    state.current = None;
                    state.available = None;
                    state.available_file = None;
                    state.message = format!("当前后端版本读取失败：{error:#}");
                    //M 修复当前文件后重新比较候选，不能沿用失败前的扫描缓存。
                    *seen = None;
                    return;
                }
            }
        } else {
            None
        };
        let newest = self.newest_release();
        let mut state = self.state.lock().expect("更新状态的锁");
        state.current.clone_from(&current);
        if state.applying {
            return;
        }
        let Some(file) = newest else {
            state.available = None;
            state.available_file = None;
            *seen = None;
            return;
        };
        //G 同一个文件不用每次都跑一遍；现在的版本变了要重新比。
        if seen.as_ref() == Some(&file) && state.available.is_none() && current.is_some() {
            return;
        }
        drop(state);
        let release = read_version(&file);
        let mut state = self.state.lock().expect("更新状态的锁");
        *seen = Some(file.clone());
        match release {
            Ok(value) => {
                let newer = current.as_ref().is_none_or(|running| is_newer(&value, running));
                state.available = newer.then_some(value);
                state.available_file = newer.then_some(file);
            }
            Err(error) => {
                state.available = None;
                state.available_file = None;
                state.message = format!("{error:#}");
            }
        }
    }

    /// GET /update 的回答。
    pub fn status(&self) -> Value {
        let state = self.state.lock().expect("更新状态的锁");
        let current_version = state.current.as_ref().map(|value| value.version.as_str());
        //M 版本记录已在读取边界校验；这里只投影界面需要的字段。
        let current = state.current.as_ref().map(|value| {
            json!({
                "version": value.version,
                "builtAt": value.built_at,
            })
        });
        let available = state.available.as_ref().map(|value| {
            let changes = changes_since(value, current_version);
            json!({
                "version": value.version,
                "builtAt": value.built_at,
                "changes": changes,
            })
        });

        json!({
            "managed": true,
            "current": current,
            "available": available,
            "applying": state.applying,
            "message": state.message,
        })
    }

    /// POST /update/apply：后台开始换。
    ///
    /// 输出：开始了没有；没有新版本、已经在换时说原因。副作用：开后台线程换版本。
    pub fn apply(self: &Arc<Self>) -> Result<(), String> {
        let file = {
            let mut state = self.state.lock().expect("更新状态的锁");
            if state.applying {
                return Err("已经在换了".to_string());
            }
            let Some(file) = state.available_file.clone() else {
                return Err("没有新版本".to_string());
            };
            state.applying = true;
            state.message = "正在换版本：先试运行新版本……".to_string();
            file
        };
        let worker = Arc::clone(self);
        std::thread::spawn(move || {
            worker.paused.store(true, Ordering::SeqCst);
            let result = worker.swap_to(&file);
            let mut state = worker.state.lock().expect("更新状态的锁");
            state.applying = false;
            //M 换成功才清掉“有新版本”；没换成时新版本文件还在 updates/ 里，留着能马上再点一次（原来要重启基地才再提供）。
            if result.is_ok() {
                state.available = None;
                state.available_file = None;
            }
            state.message = match result {
                Ok(()) => "换好了".to_string(),
                Err(error) => format!("没换成，还在用旧版本：{error:#}"),
            };
            log::line(&worker.settings, &format!("换版本：{}", state.message));
            drop(state);
            worker.paused.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    /// POST /restart：重启后端（网页设置“重连”里的“重启服务”）。
    ///
    /// 输出：开始了没有；后端不在这台机器上、运行时里没有后端程序、正在换版本时说原因。
    /// 副作用：开后台线程，等 RESTART_DELAY 后停掉后端；守护线程（watch）看到它不在了就重新拉起。
    pub fn restart(self: &Arc<Self>) -> Result<(), String> {
        if !self.is_local() {
            return Err("后端不在这台机器上，基地管不了它".to_string());
        }
        if !self.server_file().is_file() {
            return Err(format!("运行时里没有 {}，停了就拉不起来", server_name()));
        }
        if self.state.lock().expect("更新状态的锁").applying {
            return Err("正在换版本，换完会自己起来".to_string());
        }
        let worker = Arc::clone(self);
        std::thread::spawn(move || {
            //M 后端还在等这次请求的回答，先让它答完再停。
            std::thread::sleep(RESTART_DELAY);
            log::line(&worker.settings, "网页上点了重启服务：停掉后端，守护马上重新拉起");
            if let Err(error) = worker.stop_server() {
                log::line(&worker.settings, &format!("重启服务：{error:#}"));
            }
        });
        Ok(())
    }

    /// 等一个地址健康。
    fn wait_healthy(&self, base: &str) -> bool {
        let started = Instant::now();
        while started.elapsed() < HEALTH_WAIT {
            if self.healthy(base) {
                return true;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        false
    }

    /// 停掉正在跑的后端：基地拉起的直接停；别人起的按它写的 pid 文件停。
    fn stop_server(&self) -> Result<()> {
        if let Some(mut running) = self.child.lock().expect("守护的锁").take() {
            let _ = running.kill();
            let _ = running.wait();
        } else {
            let pid_file = self.settings.runtime.join("data").join(format!("serve_{}.pid", self.settings.backend_port));
            if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                kill_pid(pid.trim());
            }
        }
        //M 等端口空出来。
        let started = Instant::now();
        while self.healthy(&self.settings.server) {
            if started.elapsed() > Duration::from_secs(20) {
                bail!("旧版本停不下来");
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        Ok(())
    }

    /// 换到新版本：先复制成固定文件名试运行，健康了才停旧的、换文件、起正式的；起不来就退回。
    ///
    /// 运行时目录里只用三个固定名字：jmbots-server（正式）、jmbots-server-new（试运行）、jmbots-server-old（上一个版本），
    /// 防火墙信任一次就不再弹。updates/ 里的新版本文件换成功才删，没换成留着能再点一次。
    fn swap_to(&self, file: &Path) -> Result<()> {
        //M 1. 复制成固定名字，试运行：端口是正式的加一，只开 HTTP。
        let next = self.settings.runtime.join(new_server_name());
        std::fs::copy(file, &next).with_context(|| format!("复制不了新版本到 {}", next.display()))?;
        let port = self.settings.backend_port + 1;
        let mut trial = {
            let mut command = Command::new(&next);
            command.args(["serve", "--mode", "candidate", "--port"]).arg(port.to_string()).arg("--runtime").arg(&self.settings.runtime).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            hide_window(&mut command);
            command.spawn().with_context(|| format!("新版本跑不起来：{}", next.display()))?
        };
        let passed = self.wait_healthy(&format!("http://{}:{port}", crate::config::LOCAL_HOST));
        let _ = trial.kill();
        let _ = trial.wait();
        if !passed {
            let _ = std::fs::remove_file(&next);
            bail!("新版本试运行时 {} 秒内没响应", HEALTH_WAIT.as_secs());
        }
        //M 2. 停旧的、换文件。看门狗还开着时写上换版本的锁，它看到就让开，不会抢着从源码起服务（scripts/Guard.ts）。
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0);
        let _ = std::fs::write(self.settings.runtime.join("data").join("swap.lock"), now.to_string());
        self.stop_server()?;
        let server = self.server_file();
        let old = self.settings.runtime.join(old_server_name());
        //G 老版本基地留下的 jmbots-server.old 不再用，顺手删掉。
        let _ = std::fs::remove_file(server.with_extension("old"));
        let had_old = server.is_file();
        if had_old {
            let _ = std::fs::remove_file(&old);
            std::fs::rename(&server, &old).with_context(|| format!("挪不开旧版本 {}", server.display()))?;
        }
        if let Err(error) = std::fs::rename(&next, &server) {
            if had_old {
                let _ = std::fs::rename(&old, &server);
                *self.child.lock().expect("守护的锁") = self.spawn_server(&server).ok();
            }
            return Err(anyhow!("换不了文件：{error}"));
        }
        //M 3. 起新的；起不来退回旧的。
        *self.child.lock().expect("守护的锁") = Some(self.spawn_server(&server)?);
        if self.wait_healthy(&self.settings.server) {
            let _ = std::fs::remove_file(file);
            return Ok(());
        }
        if !had_old {
            bail!("新版本起不来，也没有旧版本可退");
        }
        self.stop_server()?;
        let _ = std::fs::remove_file(&server);
        std::fs::rename(&old, &server).with_context(|| "退不回旧版本".to_string())?;
        *self.child.lock().expect("守护的锁") = Some(self.spawn_server(&server)?);
        bail!("新版本起不来，已退回旧版本");
    }

    /// 从托盘退出：连后端一起停（基地拉起的才停）。
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(mut running) = self.child.lock().expect("守护的锁").take() {
            let _ = running.kill();
            let _ = running.wait();
        }
    }
}

/// 按进程号停一个进程。
fn kill_pid(pid: &str) {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("taskkill");
        command.args(["/F", "/T", "/PID", pid]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("kill");
        command.arg(pid);
        command
    };
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut command);
    let _ = command.status();
}

#[cfg(test)]
mod tests {
    // 项目习惯用 /** */ 给局部变量写说明；rustc 会报 unused_doc_comments，测试模块里统一放行。
    #![allow(unused_doc_comments)]

    use super::*;
    use crate::config::{Overrides, resolve};
    use crate::test_support::temp_dir;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn compares_by_build_time_and_lists_changes() {
        let current = parse_version(br#"{"version":"0.1.0","builtAt":100,"versions":[]}"#).unwrap();
        let next_json = br#"{
            "version": "0.3.0",
            "builtAt": 200,
            "versions": [
                {"version": "0.3.0"},
                {"version": "0.2.0"},
                {"version": "0.1.0"}
            ]
        }"#;
        let new = parse_version(next_json).unwrap();
        assert!(is_newer(&new, &current));
        assert!(!is_newer(&current, &new));
        let changes = changes_since(&new, Some("0.1.0"));
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].version, "0.3.0");
        // 现在的版本号不在表里：全部都算。
        assert_eq!(changes_since(&new, Some("9.9.9")).len(), 3);
    }

    #[test]
    fn rejects_missing_or_invalid_version_fields_at_boundary() {
        for invalid in [
            r#"{"version":"v1","versions":[]}"#,
            r#"{"version":"v1","builtAt":100}"#,
            r#"{"version":"","builtAt":100,"versions":[]}"#,
            r#"{"version":"v1","builtAt":100,"versions":[{}]}"#
        ] {
            assert!(parse_version(invalid.as_bytes()).is_err());
        }
    }

    #[test]
    fn corrupt_current_backend_is_not_treated_as_first_install() {
        let runtime = temp_dir("corrupt-current");
        let sup = make_supervisor(&runtime, 1, 2);
        let server = sup.server_file();
        std::fs::write(&server, b"not an executable").unwrap();
        let release = runtime.join("candidate.exe");
        set_available(&sup, &release);
        let mut seen = Some(release);

        sup.scan_once(&mut seen);

        let status = sup.status();
        assert!(status["current"].is_null());
        assert!(status["available"].is_null());
        assert!(status["message"].as_str().unwrap().contains("当前后端版本读取失败"));
        assert!(seen.is_none());
        let _ = std::fs::remove_dir_all(&runtime);
    }

    /// 三个名字必须是固定的、互不相同的：Windows 防火墙按程序路径记规则，信任一次就够（用户 11-06）。
    #[test]
    fn swap_names_are_fixed_and_distinct() {
        let suffix = std::env::consts::EXE_SUFFIX;
        assert_eq!(server_name(), format!("jmbots-server{suffix}"));
        assert_eq!(new_server_name(), format!("jmbots-server-new{suffix}"));
        assert_eq!(old_server_name(), format!("jmbots-server-old{suffix}"));
        assert_ne!(server_name(), new_server_name());
        assert_ne!(server_name(), old_server_name());
        assert_ne!(new_server_name(), old_server_name());
        //M 固定名字里不能带版本号或时间戳，否则每次换版本都要重新信任。
        assert!(!new_server_name().contains(|char: char| char.is_ascii_digit()));
        assert!(!old_server_name().contains(|char: char| char.is_ascii_digit()));
    }

    /// 起一个假的 /api/health：always_ok 时一直回 200 {}；否则第一请求回 500（旧服务还在），之后回 200。
    /// 这样 stop_server 能立刻返回，而 step 3 的 wait_healthy 又能通过，不用真的起后端、不用等 HEALTH_WAIT。
    fn fake_health(always_ok: bool) -> (u16, std::thread::JoinHandle<()>) {
        /** 监听一个空闲端口。 */
        let listener = TcpListener::bind("127.0.0.1:0").expect("能监听本机");
        /** 端口。 */
        let port = listener.local_addr().expect("有地址").port();
        /** 收 HTTP 请求的线程（测试进程退出时自然结束）。 */
        let handle = std::thread::spawn(move || {
            /** 收到第几个请求。 */
            let mut count = 0usize;
            for stream in listener.incoming() {
                /** 连接。 */
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                /** 请求内容（不关心，读掉就行）。 */
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                count += 1;
                // always_ok 是试运行端口：晚一点回健康检查，让假后端进程先自己退出、
                // Windows 放开 -new.exe 的句柄，否则紧接着 rename 会报「另一个程序正在使用此文件」。
                if always_ok && count == 1 {
                    std::thread::sleep(Duration::from_millis(1500));
                }
                /** 状态行。 */
                let status = if always_ok || count > 1 { "200 OK" } else { "500 Internal Server Error" };
                /** 响应体。 */
                let body = "{}";
                /** 一段最短的 HTTP 回应。 */
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, handle)
    }

    /// 造一个基地：临时运行时、假健康检查端口，不起守护/扫描线程。
    fn make_supervisor(runtime: &Path, main_port: u16, backend_port: u16) -> Arc<Supervisor> {
        /** 命令行覆盖项。 */
        let overrides = Overrides { runtime: Some(runtime.to_path_buf()), server: Some(format!("http://127.0.0.1:{main_port}")), ..Overrides::default() };
        /** 配置。 */
        let mut settings = resolve(&overrides, &|_: &str| -> Option<String> { None }, Path::new("测试用不到"));
        settings.backend_port = backend_port;
        Arc::new(Supervisor { settings, child: Mutex::new(None), state: Mutex::new(UpdateState::default()), stopping: AtomicBool::new(false), paused: AtomicBool::new(false) })
    }

    /// 一个能被 CreateProcess 启动、但拿到 serve 参数会立刻退出的假后端（不连真实服务）。
    fn fake_exe() -> PathBuf {
        if cfg!(windows) {
            /** Windows 目录。 */
            let windir = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
            /** where.exe 给了不认识的参数会马上退出。 */
            let candidate = windir.join("System32").join("where.exe");
            if candidate.is_file() {
                return candidate;
            }
            return PathBuf::from(std::env::var_os("ComSpec").unwrap_or_else(|| "C:\\Windows\\System32\\cmd.exe".into()));
        }
        PathBuf::from("/bin/true")
    }

    /// 等后台换版本的线程收尾（applying 回到 false、paused 放开）。
    fn wait_for_apply(sup: &Arc<Supervisor>) {
        for _ in 0..2000 {
            /** 现在的状态。 */
            let done = !sup.status()["applying"].as_bool().unwrap_or(false) && !sup.paused.load(Ordering::SeqCst);
            if done { return; }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("等不到换版本线程收尾");
    }

    /// 把换版本记录成「有新版本可换」。
    fn set_available(sup: &Arc<Supervisor>, release: &Path) {
        /** 状态。 */
        let mut state = sup.state.lock().expect("状态锁");
        let current_json = br#"{
            "version": "0.3.5",
            "builtAt": 100,
            "versions": []
        }"#;
        let available_json = br#"{
            "version": "0.3.6",
            "builtAt": 200,
            "versions": [
                {"version": "0.3.6"},
                {"version": "0.3.5"}
            ]
        }"#;
        let current = parse_version(current_json).unwrap();
        let available = parse_version(available_json).unwrap();
        state.current = Some(current);
        state.available = Some(available);
        state.available_file = Some(release.to_path_buf());
    }

    #[test]
    fn newest_release_skips_tmp_and_sorts_by_stamp() {
        /** 临时运行时。 */
        let runtime = temp_dir("newest-release");
        /** updates 目录。 */
        let updates = runtime.join("updates");
        std::fs::create_dir_all(&updates).expect("建 updates");
        /** 基地。 */
        let sup = make_supervisor(&runtime, 1, 2);
        std::fs::write(updates.join("jmbots-server-0.2.9-20261106085354307274.exe"), b"old").expect("旧文件");
        std::fs::write(updates.join("jmbots-server-0.2.10-20261106090228856457.exe"), b"new").expect("新文件");
        std::fs::write(updates.join("jmbots-server-9.9.9-20261106120000000000.exe.tmp"), b"tmp").expect("临时文件");
        std::fs::write(updates.join("别的.txt"), b"x").expect("无关文件");
        /** 挑中的。 */
        let picked = sup.newest_release().expect("有候选");
        assert_eq!(picked.file_name().and_then(|name| name.to_str()), Some("jmbots-server-0.2.10-20261106090228856457.exe"));
        let _ = std::fs::remove_dir_all(&runtime);
    }

    #[test]
    fn status_reports_current_available_and_changes() {
        /** 临时运行时。 */
        let runtime = temp_dir("status");
        /** 基地。 */
        let sup = make_supervisor(&runtime, 1, 2);
        {
            /** 状态。 */
            let mut state = sup.state.lock().expect("状态锁");
            state.current = Some(serde_json::from_value(json!({ "version": "0.3.4", "builtAt": 100, "versions": [] })).unwrap());
            state.available = Some(serde_json::from_value(json!({ "version": "0.3.6", "builtAt": 200, "versions": [{ "version": "0.3.6" }, { "version": "0.3.5" }, { "version": "0.3.4" }] })).unwrap());
            state.message = "换好了".to_string();
        }
        /** 接口回答。 */
        let status = sup.status();
        assert_eq!(status["managed"], true);
        assert_eq!(status["current"]["version"], "0.3.4");
        assert_eq!(status["available"]["version"], "0.3.6");
        assert_eq!(status["available"]["changes"].as_array().map(|list| list.len()), Some(2));
        assert_eq!(status["applying"], false);
        assert_eq!(status["message"], "换好了");
        let _ = std::fs::remove_dir_all(&runtime);
    }

    /// 换失败（复制新版本就失败，不真起进程）：正式文件还是旧的、updates 里的还在、available 还在能再点。
    #[test]
    fn apply_failure_keeps_available_and_old_server() {
        /** 临时运行时。 */
        let runtime = temp_dir("swap-failure");
        std::fs::create_dir_all(runtime.join("updates")).expect("建 updates");
        std::fs::create_dir_all(runtime.join("data").join("logs")).expect("建 data/logs");
        std::fs::write(runtime.join(server_name()), b"OLD").expect("放旧后端");
        /** 用目录冒充新版本文件：std::fs::copy 立刻失败，不进试运行、不等 90 秒健康检查。 */
        let release = runtime.join("updates").join("jmbots-server-0.3.6-20261106180000000001.exe");
        std::fs::create_dir_all(&release).expect("放假新版本");
        /** 假健康检查端口。 */
        let (candidate_port, _c) = fake_health(true);
        let (main_port, _m) = fake_health(false);
        /** 基地。 */
        let sup = make_supervisor(&runtime, main_port, candidate_port - 1);
        set_available(&sup, &release);
        sup.apply().expect("能开始换");
        wait_for_apply(&sup);
        /** 接口回答。 */
        let status = sup.status();
        assert_eq!(status["applying"], false);
        assert_eq!(status["available"]["version"], "0.3.6", "没换成要留着，能再点：{status}");
        assert!(status["message"].as_str().unwrap_or("").contains("没换成"), "{status}");
        assert!(release.exists(), "updates 里那个文件要留着");
        assert_eq!(std::fs::read(runtime.join(server_name())).expect("正式后端"), b"OLD".to_vec(), "正式后端还是旧的");
        assert!(!runtime.join(old_server_name()).exists(), "不该动正式文件名");
        assert!(!runtime.join(new_server_name()).is_file(), "不该留下 -new.exe 文件");
        //M 没换成可以马上再点一次（原来要重启基地才会重新提供）。
        sup.apply().expect("失败后马上能再点");
        wait_for_apply(&sup);
        let _ = std::fs::remove_dir_all(&runtime);
    }

    /// 换成功：正式文件是新的、-old 是旧的、没有 -new、updates 里那个文件删了、available 清掉。
    #[test]
    fn apply_success_swaps_fixed_names_and_clears_available() {
        /** 临时运行时。 */
        let runtime = temp_dir("swap-success");
        std::fs::create_dir_all(runtime.join("updates")).expect("建 updates");
        std::fs::create_dir_all(runtime.join("data").join("logs")).expect("建 data/logs");
        /** 假后端程序（能被启动、拿到 serve 参数马上退出）。 */
        let exe = fake_exe();
        /** updates 里的新版本。 */
        let release = runtime.join("updates").join("jmbots-server-0.3.6-20261106180000000000.exe");
        std::fs::copy(&exe, &release).expect("放新版本");
        std::fs::write(runtime.join(server_name()), b"OLD").expect("放旧后端");
        /** 试运行端口（backend_port + 1）一直健康；正式端口第一次 500 让 stop_server 立刻返回。 */
        let (candidate_port, _c) = fake_health(true);
        let (main_port, _m) = fake_health(false);
        /** 基地。 */
        let sup = make_supervisor(&runtime, main_port, candidate_port - 1);
        set_available(&sup, &release);
        sup.apply().expect("能开始换");
        wait_for_apply(&sup);
        /** 基地拉起的假后端进程，放掉。 */
        if let Some(mut child) = sup.child.lock().expect("守护锁").take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        /** 接口回答。 */
        let status = sup.status();
        assert_eq!(status["message"], "换好了", "{status}");
        assert!(status["available"].is_null(), "换成功才清掉 available：{status}");
        assert_eq!(status["applying"], false);
        assert_eq!(std::fs::read(runtime.join(server_name())).expect("正式后端"), std::fs::read(&exe).expect("假 exe"), "正式文件是新的");
        assert_eq!(std::fs::read(runtime.join(old_server_name())).expect("上一个版本"), b"OLD".to_vec(), "-old 是旧的");
        assert!(!runtime.join(new_server_name()).exists(), "不该有 -new.exe");
        assert!(!release.exists(), "换成功才删 updates 里那个文件");
        let _ = std::fs::remove_dir_all(&runtime);
    }

    /// 重启服务：后端不在本机、运行时里没有后端程序、正在换版本时不动；
    /// 能重启时停掉后端（重新拉起是守护线程的事，测试里不开守护线程）。
    #[test]
    fn restart_stops_backend_unless_remote_missing_or_applying() {
        /** 临时运行时。 */
        let runtime = temp_dir("restart");
        std::fs::create_dir_all(runtime.join("data").join("logs")).expect("建 data/logs");
        /** 后端的健康检查：第一次回 500，stop_server 当它已经停了，立刻返回。 */
        let (port, _h) = fake_health(false);
        /** 后端在别的机器上（server 不是本机的 backend_port）。 */
        let remote = make_supervisor(&runtime, port, port.wrapping_add(1));
        assert!(remote.restart().is_err(), "后端不在本机时不重启");
        /** 本机的后端。 */
        let sup = make_supervisor(&runtime, port, port);
        assert!(sup.restart().is_err(), "运行时里没有后端程序时不重启");
        std::fs::write(runtime.join(server_name()), b"SERVER").expect("放后端");
        sup.state.lock().expect("状态锁").applying = true;
        assert!(sup.restart().is_err(), "正在换版本时不重启");
        sup.state.lock().expect("状态锁").applying = false;
        /** 基地拉起的后端（假的，拿到参数马上退出）。 */
        let child = Command::new(fake_exe())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("起假后端");
        *sup.child.lock().expect("守护锁") = Some(child);
        sup.restart().expect("能重启");
        for _ in 0..500 {
            if sup.child.lock().expect("守护锁").is_none() {
                let _ = std::fs::remove_dir_all(&runtime);
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("重启没停掉后端");
    }
}
