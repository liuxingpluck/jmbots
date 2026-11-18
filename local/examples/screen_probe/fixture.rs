//! 副屏原生测试窗口，只包含一枚保存按钮和可按需显示的空密码框。

use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use jmbots_local::config::Settings;
use jmbots_local::screen::{Denial, Overlay, ScreenConfig, ScreenController, ScreenStart};
use tauri::{AppHandle, Manager};
use uiautomation::UIAutomation;
use uiautomation::patterns::UIInvokePattern;
use uiautomation::types::Handle;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{COLOR_WINDOW, GetSysColorBrush};
use windows_sys::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{GetThreadTimes, OpenThread, THREAD_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, ES_PASSWORD, GetDlgItem, GetWindowRect,
    HWND_TOPMOST, RegisterClassW, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SetTimer,
    SetWindowPos, SetWindowTextW, ShowWindow, WM_COMMAND, WM_TIMER, WNDCLASSW, WS_CAPTION,
    WS_CHILD, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_VISIBLE,
};

const TITLE: &str = "积木AI 录屏探针（模拟记事本）";
const SAVE: usize = 101;
const STATUS: usize = 102;
const PASSWORD: usize = 103;
const WINDOW_WIDTH: i32 = 600;
const WINDOW_HEIGHT: i32 = 360;
static SAVED: AtomicU32 = AtomicU32::new(0);
static REPAINTS: AtomicU32 = AtomicU32::new(0);

/// Win32 句柄由消息线程创建和销毁，后台线程只调用 UIA 和查询几何。
pub(super) struct Fixture {
    root: usize,
    save: usize,
    password: usize,
}

impl Fixture {
    /// 在首个非主显示器的工作区创建窗口，并以非激活方式显示。
    pub(super) fn open(app: &AppHandle) -> Result<Self> {
        let primary = app.primary_monitor()?.context("找不到主显示器")?;
        let displays = app.available_monitors()?;
        let display = displays.iter().find(|display| display.position() != primary.position());
        let display = display.context("找不到副显示器")?;
        let area = display.work_area();
        ensure!(area.size.width > WINDOW_WIDTH as u32 + 64, "副屏工作区宽度不足");
        ensure!(area.size.height > WINDOW_HEIGHT as u32 + 64, "副屏工作区高度不足");

        //M 夹具使用自己的 Win32 窗口类和系统控件，避免打开用户的记事本。
        let module = unsafe { GetModuleHandleW(null()) };
        let class_name = wide("JmbotsScreenProbe");
        let class = WNDCLASSW {
            lpfnWndProc: Some(messages),
            hInstance: module,
            hbrBackground: unsafe { GetSysColorBrush(COLOR_WINDOW) },
            lpszClassName: class_name.as_ptr(),
            ..Default::default()
        };
        ensure!(unsafe { RegisterClassW(&class) } != 0, "不能注册探针窗口类");
        let title = wide(TITLE);
        let x = area.position.x + 48;
        let y = area.position.y + 48;
        let style = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let root = unsafe {
            CreateWindowExW(
                style, class_name.as_ptr(), title.as_ptr(), WS_CAPTION,
                x, y, WINDOW_WIDTH, WINDOW_HEIGHT, null_mut(), null_mut(), module, null(),
            )
        };
        ensure!(!root.is_null(), "不能创建探针窗口");

        //M 空密码控件先保持隐藏，放行测试后才把它加入 UIA 视图。
        let save = child(root, "BUTTON", "保存", WS_VISIBLE, 70, SAVE);
        let status = child(root, "STATIC", "此处仅有测试内容", WS_VISIBLE, 22, STATUS);
        let password = child(root, "EDIT", "", ES_PASSWORD as u32, 124, PASSWORD);
        let timer = unsafe { SetTimer(root, 1, 200, None) };
        let flags = SWP_NOACTIVATE | SWP_SHOWWINDOW;
        let visible = unsafe { SetWindowPos(root, HWND_TOPMOST, x, y, WINDOW_WIDTH, WINDOW_HEIGHT, flags) };
        if save.is_null() || status.is_null() || password.is_null() || timer == 0 || visible == 0 {
            unsafe { DestroyWindow(root) };
            bail!("不能初始化副屏测试控件");
        }
        println!("副屏测试窗口 x={x} y={y} width={WINDOW_WIDTH} height={WINDOW_HEIGHT}");
        Ok(Self { root: root as usize, save: save as usize, password: password as usize })
    }

    /// 等待真实帧后调用保存按钮，随后验证空密码框和模拟微信窗口。
    pub(super) fn run(
        &self, config: &ScreenConfig, settings: &Settings, overlay: &Overlay, app: &AppHandle,
    ) -> Result<()> {
        let started = ScreenController::start_fixture(config, settings, overlay.clone(), self.root)?;
        let ScreenStart::Active(probe) = started else { bail!("隔离录屏后端未取得租约"); };
        let ready = Instant::now() + Duration::from_secs(6);
        let mut status = probe.status();
        while status.frames == 0 && Instant::now() < ready {
            thread::sleep(Duration::from_millis(100));
            status = probe.status();
        }
        let reason = status.paused.map(|denial| denial.reason());
        ensure!(status.frames > 0, "WGC 未收到帧，隐私门状态 {reason:?}");

        //M 用同一个真实 WGC 线程的用户态和内核态时间测两秒窗口。
        let thread_id = status.capture_thread_id;
        let before = cpu_time(thread_id)?;
        let start = Instant::now();
        thread::sleep(Duration::from_secs(2));
        let after = cpu_time(thread_id)?;
        let elapsed = start.elapsed();
        let cpu = (after - before) as f64 / elapsed.as_secs_f64() / 100_000.0;
        println!("WGC 线程 id={thread_id} elapsed_ms={} cpu_percent={cpu:.3}", elapsed.as_millis());

        //G 在任何测试点击之前确认空白预热浮窗已存在且保持隐藏。
        let window = app.get_webview_window("screen-explanation").context("浮窗尚未预热")?;
        ensure!(!window.is_visible()?, "首次点击前浮窗已经可见");
        println!("预热浮窗已创建，首次点击前保持隐藏");

        //M 通过系统按钮的 InvokePattern 触发保存，只将坐标送入探针自身的输入队列。
        invoke(self.save)?;
        let saved_by = Instant::now() + Duration::from_secs(1);
        while SAVED.load(Ordering::Acquire) == 0 && Instant::now() < saved_by {
            thread::sleep(Duration::from_millis(10));
        }
        ensure!(SAVED.load(Ordering::Acquire) == 1, "UIA 未触发一次保存按钮");
        let save = click(&probe, self.save, "保存")?;
        ensure!(save.denial.is_none() && save.has_preclick_frame, "保存点击缺少隐私放行或点击前帧");

        //M 等足够时间观察讲解和语音，避免下一次点击让当前讲解失效。
        thread::sleep(Duration::from_secs(18));
        unsafe { ShowWindow(self.password as HWND, SW_SHOWNOACTIVATE) };
        thread::sleep(Duration::from_millis(550));
        let password = click(&probe, self.password, "密码框")?;
        ensure!(password.denial == Some(Denial::Password) && password.frames == 0, "密码框拒绝检查失败");

        //M 用合成标题触发同一套微信规则，窗口内容仍是夹具。
        let blocked = wide("积木AI 录屏探针（模拟微信窗口）");
        let changed = unsafe { SetWindowTextW(self.root as HWND, blocked.as_ptr()) };
        ensure!(changed != 0, "不能设置微信模拟标题");
        thread::sleep(Duration::from_millis(550));
        let wechat = click(&probe, self.save, "微信标题")?;
        ensure!(wechat.denial == Some(Denial::BlockedTitle) && wechat.frames == 0, "微信标题拒绝检查失败");
        probe.stop();
        overlay.hide();
        Ok(())
    }

    /// 回到窗口线程释放夹具和其子控件。
    pub(super) fn close(&self) {
        unsafe { DestroyWindow(self.root as HWND) };
    }
}

fn child(root: HWND, kind: &str, label: &str, style: u32, y: i32, id: usize) -> HWND {
    let class = wide(kind);
    let text = wide(label);
    //M 使用系统按钮、标签和编辑框提供实际 UI Automation 属性。
    unsafe {
        CreateWindowExW(
            0, class.as_ptr(), text.as_ptr(), WS_CHILD | style, 32, y, 260, 34,
            root, id as _, null_mut(), null(),
        )
    }
}

unsafe extern "system" fn messages(window: HWND, message: u32, word: WPARAM, param: LPARAM) -> LRESULT {
    if message == WM_COMMAND && word == SAVE {
        SAVED.fetch_add(1, Ordering::Release);
        return 0;
    }
    if message == WM_TIMER {
        //M 只更新夹具的状态行，让 WGC 持续收到真实的合成画面。
        let count = REPAINTS.fetch_add(1, Ordering::Relaxed);
        let status = wide(&format!("空白记事本测试 · 帧 {count}"));
        let label = unsafe { GetDlgItem(window, STATUS as i32) };
        unsafe { SetWindowTextW(label, status.as_ptr()) };
        return 0;
    }
    unsafe { DefWindowProcW(window, message, word, param) }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn invoke(button: usize) -> Result<()> {
    let initialized = unsafe { CoInitializeEx(null_mut(), COINIT_MULTITHREADED as u32) };
    ensure!(initialized >= 0, "不能初始化测试线程的 COM");
    let result = (|| -> Result<()> {
        let automation = UIAutomation::new_direct()?;
        let handle = Handle::from(button as isize);
        let element = automation.element_from_handle(handle)?;
        let pattern = element.get_pattern::<UIInvokePattern>()?;
        pattern.invoke()?;
        Ok(())
    })();
    unsafe { CoUninitialize() };
    result
}

fn click(probe: &ScreenController, control: usize, label: &str) -> Result<jmbots_local::screen::ClickReport> {
    let mut bounds = RECT::default();
    let read = unsafe { GetWindowRect(control as HWND, &mut bounds) };
    ensure!(read != 0, "不能读取夹具控件坐标");
    let x = (bounds.left + bounds.right) / 2;
    let y = (bounds.top + bounds.bottom) / 2;
    ensure!(probe.fixture_click(x, y), "夹具点击未入队");
    let timeout = Duration::from_secs(2);
    let report = probe.next_report(timeout).context("夹具点击没有本地回执")?;
    let verdict = report.denial.map(|denial| denial.reason()).unwrap_or("放行");
    println!(
        "探针点击 {label} 状态={verdict} 帧数={} 字节={} 点击前帧={}",
        report.frames, report.bytes, report.has_preclick_frame,
    );
    Ok(report)
}

fn cpu_time(id: u32) -> Result<u64> {
    let thread = unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, id) };
    ensure!(!thread.is_null(), "不能读取 WGC 线程时间");
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    //M FILETIME 的两个 32 位字段共同表示 100 ns 单位的时间。
    let read = unsafe { GetThreadTimes(thread, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe { CloseHandle(thread) };
    ensure!(read != 0, "读取 WGC 线程时间失败");
    let ticks = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    Ok(ticks(kernel) + ticks(user))
}
