//! 本地录屏会话的启动、停止和协调。明确启动且配置允许后，才会安装钩子。

mod accessibility;
mod capture;
mod mouse;
mod overlay;
mod pipeline;
mod privacy;
mod process;
mod transport;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use windows_sys::Win32::System::SystemInformation::GetTickCount64;

use self::accessibility::ControlProbe;
use self::capture::{Capture, FRAME_INTERVAL_MS, FrameRing, qpc_ms};
use self::mouse::{ClickPoint, InputState, MouseHook};
use self::pipeline::{Connection, Owner, PendingClick, Pipeline};
use self::privacy::{WindowInfo, WindowKey};
use self::process::{CropSettings, MAX_JPEG};
use self::transport::{Action, Identity, Point, Transport};
pub use self::accessibility::ControlInfo;
pub use self::mouse::Button;
pub use self::overlay::Overlay;
pub use self::privacy::Denial;

const POLL_INTERVAL: Duration = Duration::from_millis(35);
const CHECK_TIMEOUT: Duration = Duration::from_millis(155);

/// 本机录屏开关和裁图设置，缺项使用设计默认值。
#[derive(Clone, Deserialize)]
#[serde(default)]
pub struct ScreenConfig {
    enabled: bool,
    crop_width: u32,
    crop_height: u32,
    frame_max_width: u32,
    frame_max_height: u32,
    jpeg_quality: u8,
    image_max_bytes: usize,
    max_frame_age_ms: u64,
    overlay_seconds: u64,
    blacklist: Blacklist,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Blacklist {
    processes: Vec<String>,
    title_contains: Vec<String>,
}

impl Default for ScreenConfig {
    fn default() -> Self {
        Self {
            enabled: false, crop_width: 480, crop_height: 320,
            frame_max_width: 1280, frame_max_height: 720,
            jpeg_quality: 75, image_max_bytes: MAX_JPEG,
            max_frame_age_ms: 1_000, overlay_seconds: 6,
            blacklist: Blacklist::default(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ConfigFile {
    screen: ScreenConfig,
}

impl ScreenConfig {
    /// 与基地同样从 config.yaml 读 YAML，容忍 UTF‑8 BOM。文件缺失时保持关闭。
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let input = std::fs::read_to_string(path);
        match input {
            Ok(yaml) => Self::parse(&yaml),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => anyhow::bail!("无法读取录屏配置"),
        }
    }

    /// 供探针通过标准输入提供一份临时配置，无需改本机配置文件。
    pub fn parse(yaml: &str) -> anyhow::Result<Self> {
        let yaml = yaml.trim_start_matches('\u{feff}');
        if yaml.trim().is_empty() { return Ok(Self::default()); }
        let mut settings: ConfigFile = serde_yaml::from_str(yaml).map_err(|_| anyhow::anyhow!("录屏配置格式无效"))?;
        let screen = &mut settings.screen;
        if !(64..=1280).contains(&screen.crop_width) || !(64..=720).contains(&screen.crop_height)
            || !(1..=1280).contains(&screen.frame_max_width) || !(1..=720).contains(&screen.frame_max_height)
            || !(1..=95).contains(&screen.jpeg_quality) || !(1..=MAX_JPEG).contains(&screen.image_max_bytes)
            || !(1..=1000).contains(&screen.max_frame_age_ms) || !(1..=10).contains(&screen.overlay_seconds)
        {
            anyhow::bail!("录屏配置超出允许范围");
        }
        screen.blacklist.processes = normalize_words(&screen.blacklist.processes);
        screen.blacklist.title_contains = normalize_words(&screen.blacklist.title_contains);
        Ok(settings.screen)
    }

    pub fn overlay_duration(&self) -> Duration {
        Duration::from_secs(self.overlay_seconds)
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    fn blocks(&self, window: &WindowInfo) -> bool {
        self.block_reason(window).is_some()
    }

    fn block_reason(&self, window: &WindowInfo) -> Option<Denial> {
        let process = window.process.to_lowercase();
        if self.blacklist.processes.contains(&process) { return Some(Denial::BlockedProcess); }
        let title = window.title.to_lowercase();
        if self.blacklist.title_contains.iter().any(|word| title.contains(word)) {
            return Some(Denial::BlockedTitle);
        }
        None
    }
}

fn normalize_words(items: &[String]) -> Vec<String> {
    items.iter().map(|value| value.trim().to_lowercase()).filter(|value| !value.is_empty()).collect()
}

/// 通过隐私门的本地点击记录。控件标签只留在内存，探针只显示类型。
pub struct ClickReport {
    pub unix_ms: u64,
    pub x: i32,
    pub y: i32,
    pub button: Button,
    pub process: Option<String>,
    pub control: Option<ControlInfo>,
    pub denial: Option<Denial>,
    pub has_preclick_frame: bool,
    pub frames: usize,
    pub bytes: usize,
}

/// 当前状态只含计数和固定暂停原因，可用于基地的状态显示。
#[derive(Clone, Copy, Default)]
pub struct ScreenStatus {
    pub frames: usize,
    pub bytes: usize,
    pub dropped_clicks: u64,
    pub paused: Option<Denial>,
    pub capture_thread_id: u32,
}

/// 管理采集工作线程、鼠标钩子与有限大小的点击输出队列。
pub struct ScreenController {
    stopped: Arc<AtomicBool>,
    hook: Option<MouseHook>,
    thread: Option<JoinHandle<()>>,
    reports: Receiver<ClickReport>,
    status: Arc<Mutex<ScreenStatus>>,
    fixture_input: Option<(Arc<InputState>, SyncSender<ClickPoint>)>,
}

/// 后端可用并成功取得租约才进入联网讲解。
pub enum ScreenStart {
    Disabled,
    BackendUnavailable,
    Active(ScreenController),
}

impl ScreenController {
    /// 执行显式开启。如果配置关闭，直接返回而不安装钩子或启动线程。
    pub fn start(config: &ScreenConfig) -> anyhow::Result<Option<Self>> {
        if !config.enabled { return Ok(None); }
        Self::start_with(config.clone(), None, 0).map(Some)
    }

    /// 只读查询，供探针检查后端部署状态，不申请租约。
    pub fn explanation_available(settings: &crate::config::Settings) -> bool {
        Transport::connect(&settings.server).is_some()
    }

    /// 查询设置里的后端并申请 v1 租约。调用方在后台执行以保持界面响应。
    pub fn start_explaining(
        config: &ScreenConfig, settings: &crate::config::Settings, overlay: Overlay,
    ) -> anyhow::Result<ScreenStart> {
        Self::start_explaining_for(config, settings, overlay, 0)
    }

    /// 独立探针夹具只允许本进程创建的副屏窗口，不安装全局鼠标钩子。
    pub fn start_fixture(
        config: &ScreenConfig, settings: &crate::config::Settings, overlay: Overlay, window: usize,
    ) -> anyhow::Result<ScreenStart> {
        if window == 0 || privacy::probe_window(window).is_err() {
            anyhow::bail!("找不到本进程的副屏录屏测试窗口");
        }
        Self::start_explaining_for(config, settings, overlay, window)
    }

    fn start_explaining_for(
        config: &ScreenConfig, settings: &crate::config::Settings, overlay: Overlay, fixture: usize,
    ) -> anyhow::Result<ScreenStart> {
        if !config.enabled { return Ok(ScreenStart::Disabled); }
        let Some((transport, effective)) = Transport::connect(&settings.server) else {
            return Ok(ScreenStart::BackendUnavailable);
        };
        let identity = Identity::new().ok_or_else(|| anyhow::anyhow!("无法生成录屏会话标识"))?;
        let Some(expires) = transport.state(&identity, true, Action::UserStart) else {
            return Ok(ScreenStart::BackendUnavailable);
        };
        let crop = CropSettings {
            width: config.crop_width.min(effective.crop_width),
            height: config.crop_height.min(effective.crop_height),
            max_width: config.frame_max_width,
            max_height: config.frame_max_height,
            quality: config.jpeg_quality,
            limit: config.image_max_bytes,
            max_age: config.max_frame_age_ms,
        };
        let connection = Connection { transport, identity, expires, crop, config: config.clone(), overlay };
        Self::start_with(config.clone(), Some(connection), fixture).map(ScreenStart::Active)
    }

    fn start_with(config: ScreenConfig, connection: Option<Connection>, fixture: usize) -> anyhow::Result<Self> {
        let stopped = Arc::new(AtomicBool::new(false));
        let input = Arc::new(InputState { probe_window: fixture, ..InputState::default() });
        let pipeline = connection.map(|connection| Pipeline::start(connection, input.clone(), stopped.clone())).transpose()?;
        let (click_tx, clicks) = sync_channel(8);
        let (report_tx, reports) = sync_channel(8);
        let (hook, fixture_input) = match input.is_probe() {
            true => (None, Some((input.clone(), click_tx))),
            false => (Some(MouseHook::start(click_tx, input.clone())?), None),
        };

        let task_stopped = stopped.clone();
        let status = Arc::new(Mutex::new(ScreenStatus::default()));
        let task_status = status.clone();
        let work = move || run(task_stopped, input, clicks, report_tx, task_status, config, pipeline);
        let thread = thread::Builder::new().name("screen-control".into()).spawn(work)?;
        let controller = Self { stopped, hook, thread: Some(thread), reports, status, fixture_input };
        Ok(controller)
    }

    /// 把测试夹具已调用的控件事件交给与实际鼠标共用的有限队列。
    pub fn fixture_click(&self, x: i32, y: i32) -> bool {
        let Some((input, sender)) = &self.fixture_input else { return false; };
        if privacy::window_at(x, y) != input.probe_window { return false; }

        let observed_tick = unsafe { GetTickCount64() };
        let seq = input.seq.fetch_add(1, Ordering::AcqRel) + 1;
        let epoch = input.epoch.load(Ordering::Acquire);
        let click = ClickPoint { x, y, observed_tick, tick: observed_tick as u32, seq, epoch, button: Button::Left };
        sender.try_send(click).is_ok()
    }

    /// 等待一条仅含元数据的点击摘要，超时或停止时返回 None。
    pub fn next_report(&self, timeout: Duration) -> Option<ClickReport> {
        self.reports.recv_timeout(timeout).ok()
    }

    pub fn status(&self) -> ScreenStatus {
        self.status.lock().map(|status| *status).unwrap_or_default()
    }

    /// 消费本次启动的控制器，等待钩子和捕获线程撤销。
    pub fn stop(self) {
        drop(self);
    }
}

impl Drop for ScreenController {
    fn drop(&mut self) {
        //M 撤回帧资格、卸钩，然后等控制线程释放帧环和 WGC。
        self.stopped.store(true, Ordering::Release);
        drop(self.hook.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum ProbeTarget {
    Window(WindowKey),
    Click(WindowKey, i32, i32, bool),
}

struct ProbeJob {
    target: ProbeTarget,
    response: SyncSender<Result<Option<ControlInfo>, Denial>>,
    expires: Instant,
}

/// UIA 独占 COM 线程。只留一个待检查位置，允许采集与发送复核短暂错开。
struct ProbeWorker {
    jobs: SyncSender<ProbeJob>,
    thread: JoinHandle<()>,
}

impl ProbeWorker {
    fn start() -> anyhow::Result<Self> {
        let (jobs, inputs) = sync_channel::<ProbeJob>(1);
        let work = move || {
            if !privacy::use_physical_coordinates() { return; }
            let probe = ControlProbe::new();
            let Ok(probe) = probe else { return; };
            while let Ok(job) = inputs.recv() {
                if Instant::now() >= job.expires { continue; }
                let result = match job.target {
                    ProbeTarget::Window(key) => probe.check_window(key).map(|()| None),
                    ProbeTarget::Click(key, x, y, focus) => probe.inspect(key, x, y, focus).map(Some),
                };
                let _ = job.response.try_send(result);
            }
        };
        let thread = thread::Builder::new().name("screen-uia".into()).spawn(work)?;
        Ok(Self { jobs, thread })
    }

    fn check(&self, target: ProbeTarget) -> Result<Option<ControlInfo>, Denial> {
        probe_request(&self.jobs, target)
    }

    fn stop(self) {
        drop(self.jobs);
        //G COM provider 可能在系统调用中阻塞。收到停止后禁止新工作，控制线程无需等它恢复。
        let deadline = Instant::now() + CHECK_TIMEOUT;
        while !self.thread.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        if self.thread.is_finished() {
            let _ = self.thread.join();
        }
    }
}

fn probe_request(sender: &SyncSender<ProbeJob>, target: ProbeTarget) -> Result<Option<ControlInfo>, Denial> {
    let (response, received) = sync_channel(1);
    let expires = Instant::now() + CHECK_TIMEOUT;
    sender.try_send(ProbeJob { target, response, expires }).map_err(|_| Denial::AccessibilityUnavailable)?;
    received.recv_timeout(CHECK_TIMEOUT).map_err(|_| Denial::AccessibilityBudget)?
}

#[derive(Default)]
struct FrameState {
    ring: FrameRing,
    capture: Option<Capture>,
    owner: Option<(WindowKey, u64)>,
    last_check: Option<u64>,
    paused: Option<Denial>,
}

impl FrameState {
    fn clear(&mut self) {
        self.ring.clear();
        self.capture = None;
        self.owner = None;
        self.last_check = None;
        self.paused = None;
    }

    fn pause(&mut self, reason: Denial) {
        self.ring.clear();
        self.capture = None;
        self.paused = Some(reason);
    }

    fn update(
        &mut self, window: &WindowInfo, epoch: u64, input: &Arc<InputState>,
        stopped: &Arc<AtomicBool>, probe: &ProbeWorker, may_capture: bool,
    ) -> Result<(), Denial> {
        let identity = (window.key, epoch);
        if self.owner != Some(identity) {
            self.clear();
            self.owner = Some(identity);
        }
        let now = qpc_ms().ok_or(Denial::CaptureUnavailable)?;
        self.ring.prune(now);
        if !may_capture {
            self.ring.clear();
            self.capture = None;
        }

        //G 复制后的帧只有通过第二次隐私检查才放入帧环。
        if let Some(frame) = self.capture.as_ref().and_then(Capture::frame) {
            probe.check(ProbeTarget::Window(window.key))?;
            require_current(window.key, epoch, input)?;
            let verified_at = qpc_ms().ok_or(Denial::CaptureUnavailable)?;
            self.ring.push(frame, verified_at);
        }

        if self.last_check.is_some_and(|previous| now.saturating_sub(previous) < FRAME_INTERVAL_MS) {
            return self.paused.map_or(Ok(()), Err);
        }

        //G 先完成 UIA 隐私检查和前台复核，再允许 WGC 读取一张新帧。
        self.last_check = Some(now);
        probe.check(ProbeTarget::Window(window.key))?;
        require_current(window.key, epoch, input)?;
        let allowed_at = qpc_ms().ok_or(Denial::CaptureUnavailable)?;
        self.last_check = Some(allowed_at);
        self.paused = None;
        if !may_capture || stopped.load(Ordering::Acquire) { return Ok(()); }
        if self.capture.as_ref().is_some_and(Capture::finished) {
            self.capture = None;
        }

        if let Some(capture) = &self.capture {
            capture.renew(allowed_at);
            return Ok(());
        }

        let capture = Capture::start(window.key, epoch, input.clone(), stopped.clone(), allowed_at)?;
        self.capture = Some(capture);
        Ok(())
    }
}

fn require_current(key: WindowKey, epoch: u64, input: &InputState) -> Result<(), Denial> {
    if input.epoch.load(Ordering::Acquire) != epoch { return Err(Denial::WindowChanged); }
    let current = input.window().map_err(|rejected| rejected.reason)?;
    if current.key != key { return Err(Denial::WindowChanged); }
    Ok(())
}

fn run(
    stopped: Arc<AtomicBool>, input: Arc<InputState>, clicks: Receiver<ClickPoint>,
    reports: SyncSender<ClickReport>, status: Arc<Mutex<ScreenStatus>>,
    config: ScreenConfig, pipeline: Option<Pipeline>,
) {
    let dpi = privacy::use_physical_coordinates();
    let worker = ProbeWorker::start().ok();
    let mut frames = FrameState::default();
    while !stopped.load(Ordering::Acquire) {
        //M 有界队列中仅处理最新点击，避免排队时控件已经变化。
        let mut click = clicks.recv_timeout(POLL_INTERVAL).ok();
        while let Ok(next) = clicks.try_recv() {
            click = Some(next);
        }
        if stopped.load(Ordering::Acquire) { break; }

        let active = input.window().and_then(|window| {
            if let Some(reason) = config.block_reason(&window) {
                return Err(privacy::Rejected { reason, process: Some(window.process) });
            }
            Ok(window)
        });
        let epoch = input.epoch.load(Ordering::Acquire);
        let mut report = click.map(new_report);
        let mut pending = None;
        if let (Some(click), Some(report)) = (click, report.as_mut()) {
            pending = classify_click(click, report, &active, &frames, worker.as_ref(), &input, pipeline.is_some());
            if let Some(reason) = report.denial {
                frames.pause(reason);
            }
        }

        //M 拒绝时立即释放环与 WGC，允许时继续维持窗口内的短帧环。
        match (dpi, &active, worker.as_ref()) {
            (true, Ok(window), Some(probe)) => {
                let owner = Owner::of(window, epoch);
                let may_capture = pipeline.as_ref().is_none_or(|pipeline| pipeline.capture_allowed(owner));
                if let Err(reason) = frames.update(window, epoch, &input, &stopped, probe, may_capture) {
                    frames.pause(reason);
                }
            }
            (_, Err(rejected), _) => {
                frames.clear();
                frames.pause(rejected.reason);
            }
            _ => frames.pause(Denial::AccessibilityUnavailable),
        }
        if let Some(pipeline) = &pipeline {
            let owner = active.as_ref().ok().filter(|_| frames.paused.is_none())
                .map(|window| Owner::of(window, epoch));
            let latest = input.seq.load(Ordering::Acquire);
            pipeline.observe(owner, latest);
            if let Some(pending) = pending { pipeline.submit(pending); }
        }
        let (count, bytes) = frames.ring.stats();
        if let Ok(mut status) = status.lock() {
            let dropped_clicks = input.dropped.load(Ordering::Relaxed);
            let capture_thread_id = input.capture_thread_id.load(Ordering::Relaxed);
            *status = ScreenStatus { frames: count, bytes, dropped_clicks, paused: frames.paused, capture_thread_id };
        }

        if let (Some(click), Some(mut report)) = (click, report) {
            let latest = input.seq.load(Ordering::Acquire);
            if latest != click.seq { continue; }
            let still_current = input.epoch.load(Ordering::Acquire) == click.epoch;
            if !still_current && report.denial.is_none() {
                report.denial = Some(Denial::WindowChanged);
                report.control = None;
                report.has_preclick_frame = false;
            }
            (report.frames, report.bytes) = (count, bytes);
            let _ = reports.try_send(report);
        }
    }
    frames.clear();
    drop(pipeline);
    if let Some(worker) = worker { worker.stop(); }
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn new_report(click: ClickPoint) -> ClickReport {
    let age = click_age(click.tick, click.observed_tick).unwrap_or_default();
    let current_tick = unsafe { GetTickCount64() };
    let elapsed = current_tick.saturating_sub(click.observed_tick).saturating_add(age);
    let now = unix_ms();
    ClickReport {
        unix_ms: now.saturating_sub(elapsed), x: click.x, y: click.y, button: click.button,
        process: None, control: None, denial: None, has_preclick_frame: false, frames: 0, bytes: 0,
    }
}

fn classify_click(
    click: ClickPoint, report: &mut ClickReport, active: &Result<WindowInfo, privacy::Rejected>,
    frames: &FrameState, probe: Option<&ProbeWorker>, input: &InputState, explaining: bool,
) -> Option<PendingClick> {
    let result = inspect_click(click, active, frames.owner, probe, input);
    match result {
        Ok((window, control, when)) => {
            report.process = Some(window.process.clone());
            let frame = frames.ring.before(window.key, click.epoch, when, click.x, click.y);
            report.has_preclick_frame = frame.is_some();
            report.control = Some(control.clone());
            if !explaining { return None; }
            let owner = Owner::of(window, click.epoch);
            let point = Point { x: click.x, y: click.y };
            Some(PendingClick {
                owner, sequence: click.seq, clicked_at: report.unix_ms, clicked_mono: when,
                point, button: click.button, window: window.clone(), control, frame: frame.cloned(),
                probe: probe?.jobs.clone(),
            })
        }
        Err((denial, process)) => {
            report.denial = Some(denial);
            report.process = process;
            None
        }
    }
}

fn inspect_click<'a>(
    click: ClickPoint, active: &'a Result<WindowInfo, privacy::Rejected>, owner: Option<(WindowKey, u64)>,
    probe: Option<&ProbeWorker>, input: &InputState,
) -> Result<(&'a WindowInfo, ControlInfo, u64), (Denial, Option<String>)> {
    let window = active.as_ref().map_err(|rejected| (rejected.reason, rejected.process.clone()))?;
    let denied = |reason| (reason, Some(window.process.clone()));
    if click.epoch != input.epoch.load(Ordering::Acquire) { return Err(denied(Denial::WindowChanged)); }
    if owner != Some((window.key, click.epoch)) { return Err(denied(Denial::WindowChanged)); }
    let when = click_qpc(click).ok_or_else(|| denied(Denial::WindowChanged))?;
    let probe = probe.ok_or_else(|| denied(Denial::AccessibilityUnavailable))?;
    let target = ProbeTarget::Click(window.key, click.x, click.y, !input.is_probe());
    let control = probe.check(target).map_err(denied)?
        .ok_or_else(|| denied(Denial::AccessibilityUnavailable))?;
    require_current(window.key, click.epoch, input).map_err(denied)?;
    Ok((window, control, when))
}

/// 展开 32 位消息时间仅需从同次回调的 64 位时钟倒推，跨回绕也不会误读成未来。
fn click_age(tick: u32, observed: u64) -> Option<u64> {
    let age = u64::from((observed as u32).wrapping_sub(tick));
    if age > 1_000 { return None; }
    Some(age)
}

/// 在同机取样 QPC 与 tick。减去 tick 粒度的余量，避免后发帧被选成点击前帧。
fn click_qpc(click: ClickPoint) -> Option<u64> {
    let now = qpc_ms()?;
    let tick = unsafe { GetTickCount64() };
    let delayed = tick.checked_sub(click.observed_tick)?;
    let age = delayed.checked_add(click_age(click.tick, click.observed_tick)?)?;
    if age > 500 { return None; }

    now.checked_sub(age + 20)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_false_leave_the_controller_off() {
        for yaml in ["", "other: true", "screen: {}", "screen: { enabled: false }"] {
            let config = ScreenConfig::parse(yaml).unwrap();
            assert!(ScreenController::start(&config).unwrap().is_none());
        }
        assert!(ScreenConfig::parse("screen: { enabled: 'true' }").is_err());
        assert!(ScreenConfig::parse("\u{feff}screen: { enabled: true }").unwrap().enabled);
    }

    #[test]
    fn unwraps_mouse_tick_across_32_bit_rollover() {
        let observed = (1u64 << 32) + 5;
        assert_eq!(click_age(u32::MAX - 3, observed), Some(9));
        assert_eq!(click_age(5, observed), Some(0));
        assert_eq!(click_age(6, observed), None);
    }
}
