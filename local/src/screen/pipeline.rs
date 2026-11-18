//! 录屏讲解的独立加工、点击 I/O 和续租线程。采集只交出共享的原始帧。

use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::accessibility::ControlInfo;
use super::capture::{Sample, qpc_ms};
use super::mouse::{Button, InputState};
use super::overlay::{Display, Overlay};
use super::privacy::{self, WindowInfo, WindowKey};
use super::process::{CropSettings, Latest, make_image};
use super::transport::{
    self, Action, CLICK_TIMEOUT, ClickBody, ClickId, ControlBody, HEARTBEAT, Identity,
    MAX_SEND_AGE, MonitorBody, Point, Transport, WindowBody, WireRect,
};
use super::{ProbeJob, ProbeTarget, ScreenConfig, probe_request};

const POLL: Duration = Duration::from_millis(40);
const RETRY: Duration = Duration::from_secs(1);
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Owner {
    pub key: WindowKey,
    pub focus_epoch: u64,
    title_hash: u64,
}

impl Owner {
    pub fn of(window: &WindowInfo, focus_epoch: u64) -> Self {
        let mut hasher = DefaultHasher::new();
        window.title.hash(&mut hasher);
        let title_hash = hasher.finish();
        Self { key: window.key, focus_epoch, title_hash }
    }
}

struct Local {
    owner: Option<Owner>,
    revision: u64,
    sequence: u64,
    lease: Option<(Identity, Instant)>,
}

impl Local {
    fn matches(&self, stamp: &Stamp, now: Instant) -> bool {
        self.owner == Some(stamp.owner) && self.revision == stamp.revision
            && self.sequence == stamp.sequence && self.lease.as_ref().is_some_and(|(identity, until)| {
                *identity == stamp.identity && now < *until
            })
    }
}

#[derive(Clone)]
struct Stamp {
    owner: Owner,
    revision: u64,
    sequence: u64,
    clicked_mono: u64,
    identity: Identity,
}

pub(super) struct PendingClick {
    pub owner: Owner,
    pub sequence: u64,
    pub clicked_at: u64,
    pub clicked_mono: u64,
    pub point: Point,
    pub button: Button,
    pub window: WindowInfo,
    pub control: ControlInfo,
    pub frame: Option<Arc<Sample>>,
    pub probe: SyncSender<ProbeJob>,
}

struct Job {
    stamp: Stamp,
    click: PendingClick,
}

struct Prepared {
    stamp: Stamp,
    body: ClickBody,
    display: Display,
    window: WindowInfo,
    control: ControlInfo,
    probe: SyncSender<ProbeJob>,
}

pub(super) struct Connection {
    pub transport: Transport,
    pub identity: Identity,
    pub expires: Instant,
    pub crop: CropSettings,
    pub config: ScreenConfig,
    pub overlay: Overlay,
}

struct Shared {
    local: Mutex<Local>,
    stopped: Arc<AtomicBool>,
    input: Arc<InputState>,
    images: Latest<Job>,
    outgoing: Latest<Prepared>,
    config: ScreenConfig,
    overlay: Overlay,
}

pub(super) struct Pipeline {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

impl Pipeline {
    pub fn start(connection: Connection, input: Arc<InputState>, stopped: Arc<AtomicBool>) -> anyhow::Result<Self> {
        let local = Local { owner: None, revision: 0, sequence: 0, lease: None };
        let shared = Arc::new(Shared {
            local: Mutex::new(local), stopped, input,
            images: Latest::default(), outgoing: Latest::default(),
            config: connection.config, overlay: connection.overlay,
        });
        let mut pipeline = Self { shared: shared.clone(), threads: Vec::new() };
        let transport = connection.transport.clone();
        let leases = shared.clone();
        let work = move || lease_loop(leases, transport, connection.identity, connection.expires);
        pipeline.threads.push(thread::Builder::new().name("screen-lease".into()).spawn(work)?);

        let images = shared.clone();
        let work = move || process_loop(images, connection.crop);
        pipeline.threads.push(thread::Builder::new().name("screen-process".into()).spawn(work)?);

        let work = move || click_loop(shared, connection.transport);
        pipeline.threads.push(thread::Builder::new().name("screen-http".into()).spawn(work)?);
        Ok(pipeline)
    }

    /// 原生焦点或隐私状态变化时立即清除本地旧结果，网络取消另由租约线程处理。
    pub fn observe(&self, owner: Option<Owner>, sequence: u64) {
        let Ok(mut local) = self.shared.local.lock() else { return; };
        let window_changed = local.owner != owner;
        let click_changed = local.sequence != sequence;
        if window_changed {
            local.owner = owner;
            local.revision += 1;
            local.lease = None;
        }
        local.sequence = sequence;
        drop(local);
        if window_changed || click_changed {
            self.shared.discard();
        }
        self.shared.overlay.tick();
    }

    pub fn capture_allowed(&self, owner: Owner) -> bool {
        self.shared.local.lock().ok().is_some_and(|local| {
            local.owner == Some(owner) && local.lease.as_ref().is_some_and(|(_, until)| Instant::now() < *until)
        })
    }

    pub fn submit(&self, click: PendingClick) {
        let Ok(local) = self.shared.local.lock() else { return; };
        let Some((identity, until)) = &local.lease else { return; };
        if local.owner != Some(click.owner) || local.sequence != click.sequence || Instant::now() >= *until {
            return;
        }
        let stamp = Stamp {
            owner: click.owner, revision: local.revision, sequence: click.sequence,
            clicked_mono: click.clicked_mono, identity: identity.clone(),
        };
        drop(local);
        self.shared.images.put(Job { stamp, click });
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::Release);
        self.shared.discard();
        for worker in self.threads.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Shared {
    fn alive(&self) -> bool {
        !self.stopped.load(Ordering::Acquire)
    }

    fn current(&self, stamp: &Stamp) -> bool {
        if !self.alive() || self.input.seq.load(Ordering::Acquire) != stamp.sequence
            || self.input.epoch.load(Ordering::Acquire) != stamp.owner.focus_epoch
        {
            return false;
        }
        let now = Instant::now();
        self.local.lock().ok().is_some_and(|local| local.matches(stamp, now))
    }

    fn discard(&self) {
        self.images.clear();
        self.outgoing.clear();
        self.overlay.hide();
    }

    fn view(&self) -> Option<(Option<Owner>, u64)> {
        let local = self.local.lock().ok()?;
        Some((local.owner, local.revision))
    }

    fn set_lease(&self, revision: u64, lease: Option<(Identity, Instant)>) {
        let Ok(mut local) = self.local.lock() else { return; };
        if local.revision != revision { return; }
        let lost = lease.is_none() && local.lease.is_some();
        local.lease = lease;
        drop(local);
        if lost { self.discard(); }
    }
}

struct Remote {
    identity: Identity,
    active: bool,
    revision: Option<u64>,
    until: Instant,
    heartbeat_at: Instant,
}

impl Remote {
    fn sync(&mut self, transport: &Transport, owner: Option<Owner>, revision: u64) -> Option<()> {
        let now = Instant::now();
        if now >= self.until { return None; }

        //M 即使短暂暂停被本地合并，换代也先撤销旧结果与旧服务器请求。
        if self.active && (owner.is_none() || self.revision.is_some_and(|seen| seen != revision)) {
            self.change(transport, false, Action::PrivacyPause)?;
        }
        if !self.active && owner.is_some() {
            self.change(transport, true, Action::Resume)?;
        }
        if now >= self.heartbeat_at {
            self.until = transport.state(&self.identity, self.active, Action::Heartbeat)?;
            self.heartbeat_at = now + HEARTBEAT;
        }
        self.revision = Some(revision);
        Some(())
    }

    fn change(&mut self, transport: &Transport, active: bool, action: Action) -> Option<()> {
        self.identity.advance();
        let now = Instant::now();
        self.until = transport.state(&self.identity, active, action)?;
        self.active = active;
        self.heartbeat_at = now + HEARTBEAT;
        Some(())
    }
}

fn lease_loop(shared: Arc<Shared>, transport: Transport, identity: Identity, until: Instant) {
    let heartbeat_at = Instant::now() + HEARTBEAT;
    let mut remote = Remote { identity, active: true, revision: None, until, heartbeat_at };
    while shared.alive() {
        let Some((owner, revision)) = shared.view() else { break; };
        if remote.sync(&transport, owner, revision).is_some() {
            let lease = remote.active.then(|| (remote.identity.clone(), remote.until));
            shared.set_lease(revision, lease);
            thread::sleep(POLL);
            continue;
        }

        shared.set_lease(revision, None);
        //G 失联时不补发点击。只有本次明确开启的意图和本机安全窗口仍在才新建租约。
        while shared.alive() {
            thread::sleep(RETRY);
            if !shared.alive() || !shared.view().is_some_and(|(owner, _)| owner.is_some()) { continue; }
            let Some(identity) = Identity::new() else { continue; };
            let now = Instant::now();
            let Some(until) = transport.state(&identity, true, Action::UserStart) else { continue; };
            remote = Remote {
                identity, active: true, revision: None, until, heartbeat_at: now + HEARTBEAT,
            };
            break;
        }
    }

    remote.identity.advance();
    let _ = transport.state(&remote.identity, false, Action::UserStop);
}

fn process_loop(shared: Arc<Shared>, crop: CropSettings) {
    if !privacy::use_physical_coordinates() { return; }
    while shared.alive() {
        let Some(job) = shared.images.take(POLL) else { continue; };
        if !shared.current(&job.stamp) { continue; }
        let Some(prepared) = prepare(job, crop) else { continue; };
        if shared.current(&prepared.stamp) { shared.outgoing.put(prepared); }
    }
}

fn prepare(job: Job, crop: CropSettings) -> Option<Prepared> {
    let click = job.click;
    let display = Display::at(click.point)?;
    let monitor = MonitorBody::new(&display)?;
    let window_rect = WireRect::from_rect(click.window.key.rect)?;
    let result = make_image(
        click.frame.as_deref(), click.clicked_at, click.clicked_mono, click.point, display.rect, crop,
    );
    let (image, omitted) = match result {
        Ok(image) => (Some(image), None),
        Err(reason) => (None, Some(reason)),
    };

    let name = clean_text(click.control.name.as_deref().unwrap_or_default(), 160);
    if image.is_none() && name.is_empty() { return None; }
    let id = ClickId {
        identity: job.stamp.identity.clone(), click_id: transport::guid()?, seq: job.stamp.sequence,
    };
    let window = WindowBody {
        pid: click.window.key.pid,
        process_name: clean_text(&click.window.process, 128),
        process_started_at_ms: click.window.key.started.saturating_sub(FILETIME_UNIX_EPOCH) / 10_000,
        window_id: format!("{:x}", click.window.key.hwnd),
        title: clean_text(&click.window.title, 160),
        rect: window_rect,
        observed_at_ms: click.window.observed_at_ms,
    };
    let control = ControlBody {
        name,
        kind: format!("{:?}", click.control.kind),
        automation_id: clean_text(&click.control.automation_id, 128),
        rect: WireRect::from_rect(click.control.rect),
        observed_at_ms: click.control.observed_at_ms,
        is_password: false,
        privacy_checked: true,
    };
    let button = match click.button {
        Button::Left => "left",
        Button::Right => "right",
    };
    let body = ClickBody {
        id, clicked_at_ms: click.clicked_at, age_at_send_ms: 0, button,
        position: click.point, monitor, window, control, image, image_omitted_reason: omitted,
    };
    Some(Prepared {
        stamp: job.stamp, body, display, window: click.window, control: click.control, probe: click.probe,
    })
}

fn click_loop(shared: Arc<Shared>, transport: Transport) {
    if !privacy::use_physical_coordinates() { return; }
    while shared.alive() {
        let Some(mut request) = shared.outgoing.take(POLL) else { continue; };
        if !can_use(&shared, &request) { continue; }
        let Some(age) = age_ms(&request.stamp) else { continue; };
        if age > MAX_SEND_AGE { continue; }
        request.body.age_at_send_ms = age;
        let Some(reply) = transport.explain(&request.body) else { continue; };

        //G 结果回来时再次核对时间、点击、租约和窗口。迟到结果没有 UI 副作用。
        if !can_use(&shared, &request) { continue; }
        let Some(age) = age_ms(&request.stamp) else { continue; };
        if age > CLICK_TIMEOUT.as_millis() as u64 { continue; }
        let configured = shared.config.overlay_duration();
        let duration = Duration::from_millis(reply.display_for_ms).min(configured);
        let guard = shared.clone();
        let stamp = request.stamp;
        let still_current = move || guard.current(&stamp)
            && age_ms(&stamp).is_some_and(|age| age <= CLICK_TIMEOUT.as_millis() as u64);
        shared.overlay.show(reply.text, request.display, Some(request.body.position), duration, still_current);
    }
}

fn can_use(shared: &Shared, request: &Prepared) -> bool {
    if !shared.current(&request.stamp) { return false; }
    let point = request.body.position;
    let Ok(window) = privacy::foreground() else { return false; };
    if window.key != request.window.key || window.title != request.window.title
        || shared.config.blocks(&window) || Display::at(point).as_ref() != Some(&request.display)
    {
        return false;
    }
    let target = ProbeTarget::Click(window.key, point.x, point.y);
    let Ok(Some(control)) = probe_request(&request.probe, target) else { return false; };
    request.control.same_element(&control) && shared.current(&request.stamp)
}

fn age_ms(stamp: &Stamp) -> Option<u64> {
    qpc_ms()?.checked_sub(stamp.clicked_mono)
}

/// 按后端 JavaScript 的 UTF-16 字符上限截断，先去掉控制字符。
fn clean_text(value: &str, limit: usize) -> String {
    let mut output = String::new();
    let mut units = 0;
    for char in value.trim().chars() {
        let clean = match char.is_control() {
            true => ' ',
            false => char,
        };
        units += clean.len_utf16();
        if units > limit { break; }
        output.push(clean);
    }
    output.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::privacy::Rect;

    #[test]
    fn rejects_an_old_result_after_new_input_window_or_lease() {
        let key = WindowKey {
            hwnd: 1, pid: 2, started: 3,
            rect: Rect { left: 0, top: 0, right: 100, bottom: 100 },
            dpi: 96,
        };
        let owner = Owner { key, focus_epoch: 1, title_hash: 1 };
        let identity = Identity::new().unwrap();
        let now = Instant::now();
        let until = now + Duration::from_secs(10);
        let stamp = Stamp { owner, revision: 1, sequence: 4, clicked_mono: 42, identity: identity.clone() };
        let mut local = Local { owner: Some(owner), revision: 1, sequence: 4, lease: Some((identity, until)) };
        assert!(local.matches(&stamp, now));
        local.sequence += 1;
        assert!(!local.matches(&stamp, now));
        local.sequence = 4;
        local.revision += 1;
        assert!(!local.matches(&stamp, now));
        local.revision = 1;
        assert!(!local.matches(&stamp, until));
        local.owner = None;
        assert!(!local.matches(&stamp, now));
    }
}
