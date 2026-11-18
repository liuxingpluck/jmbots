//! 低级鼠标钩子与前台变化通知。专用线程只泵消息，回调只复制元数据和尝试入队。

use std::cell::RefCell;
use std::ptr::null_mut;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::thread::{self, JoinHandle};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, EVENT_SYSTEM_DESKTOPSWITCH, EVENT_SYSTEM_FOREGROUND, GetMessageW,
    LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
    SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT,
    WM_LBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
};

/// 点击类型。只监听两个按下消息。
#[derive(Clone, Copy, Debug)]
pub enum Button {
    Left,
    Right,
}

#[derive(Clone, Copy)]
pub(super) struct ClickPoint {
    pub x: i32,
    pub y: i32,
    pub tick: u32,
    pub observed_tick: u64,
    pub seq: u64,
    pub epoch: u64,
    pub button: Button,
}

#[derive(Default)]
pub(super) struct InputState {
    pub seq: AtomicU64,
    pub epoch: AtomicU64,
    pub dropped: AtomicU64,
}

struct MouseContext {
    output: SyncSender<ClickPoint>,
    state: Arc<InputState>,
}

thread_local! {
    static CONTEXT: RefCell<Option<MouseContext>> = const { RefCell::new(None) };
}

/// 负责钩子消息线程的启动与关闭。
pub(super) struct MouseHook {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl MouseHook {
    pub fn start(output: SyncSender<ClickPoint>, state: Arc<InputState>) -> anyhow::Result<Self> {
        let (ready, status) = sync_channel(0);
        let work = move || run_hook(MouseContext { output, state }, ready);
        let thread = thread::Builder::new().name("screen-mouse".into()).spawn(work)?;
        let Ok(Some(thread_id)) = status.recv() else {
            let _ = thread.join();
            anyhow::bail!("无法安装鼠标钩子或窗口切换通知");
        };
        Ok(Self { thread_id, thread: Some(thread) })
    }
}

impl Drop for MouseHook {
    fn drop(&mut self) {
        //M 先让消息泵退出，线程自己撤销钩子，再回收线程。
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 在消息泵所属线程安装与撤销三个用户态钩子。
fn run_hook(context: MouseContext, ready: SyncSender<Option<u32>>) {
    CONTEXT.with(|slot| slot.replace(Some(context)));
    let mut message = MSG::default();
    unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE) };

    let module = unsafe { GetModuleHandleW(std::ptr::null()) };
    let mouse = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0) };
    let foreground = watch(EVENT_SYSTEM_FOREGROUND);
    let desktop = watch(EVENT_SYSTEM_DESKTOPSWITCH);
    let installed = !mouse.is_null() && !foreground.is_null() && !desktop.is_null();
    let thread_id = installed.then(|| unsafe { GetCurrentThreadId() });
    let confirmed = ready.send(thread_id).is_ok();
    if installed && confirmed {
        while unsafe { GetMessageW(&mut message, null_mut(), 0, 0) } > 0 {
            unsafe { DispatchMessageW(&message) };
        }
    }

    //M 即使三件中有一件没挂上，也撤掉已经挂上的部分。
    if !desktop.is_null() { unsafe { UnhookWinEvent(desktop) }; }
    if !foreground.is_null() { unsafe { UnhookWinEvent(foreground) }; }
    if !mouse.is_null() { unsafe { UnhookWindowsHookEx(mouse) }; }
}

fn watch(event: u32) -> HWINEVENTHOOK {
    unsafe { SetWinEventHook(event, event, null_mut(), Some(window_changed), 0, 0, WINEVENT_OUTOFCONTEXT) }
}

unsafe extern "system" fn window_changed(
    _hook: HWINEVENTHOOK, _event: u32, _hwnd: HWND, _object: i32, _child: i32, _thread: u32, _time: u32,
) {
    //M 立即废弃前一前台窗口的帧资格，采集线程会清掉对应像素。
    CONTEXT.with_borrow(|context| {
        if let Some(context) = context {
            context.state.epoch.fetch_add(1, Ordering::AcqRel);
        }
    });
}

unsafe extern "system" fn mouse_proc(code: i32, message: WPARAM, param: LPARAM) -> LRESULT {
    if code >= 0 && param != 0 {
        let button = match message as u32 {
            WM_LBUTTONDOWN => Some(Button::Left),
            WM_RBUTTONDOWN => Some(Button::Right),
            _ => None,
        };
        if let Some(button) = button {
            // SAFETY: Windows 只在有效低级鼠标消息中提供这块数据。
            let data = unsafe { &*(param as *const MSLLHOOKSTRUCT) };
            if data.flags & LLMHF_INJECTED == 0 {
                queue_click(data, button);
            }
        }
    }
    unsafe { CallNextHookEx(null_mut(), code, message, param) }
}

fn queue_click(data: &MSLLHOOKSTRUCT, button: Button) {
    let observed_tick = unsafe { GetTickCount64() };
    CONTEXT.with_borrow(|context| {
        let Some(context) = context else { return; };

        //M 队列满也推进序号，让进行中的旧点击结果失效。
        let seq = context.state.seq.fetch_add(1, Ordering::AcqRel) + 1;
        let epoch = context.state.epoch.load(Ordering::Acquire);
        let click = ClickPoint { x: data.pt.x, y: data.pt.y, tick: data.time, observed_tick, seq, epoch, button };
        if context.output.try_send(click).is_err() {
            context.state.dropped.fetch_add(1, Ordering::Relaxed);
        }
    });
}
