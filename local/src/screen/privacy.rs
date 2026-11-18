//! 录屏隐私门：先检查本机桌面、窗口和进程，再允许 UIA 查控件。所有未知状态均拒绝采集。

use std::ffi::c_void;
use std::mem::{size_of, size_of_val};
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, GetLastError, HWND, POINT, RECT, SetLastError};
use windows_sys::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows_sys::Win32::System::RemoteDesktop::{
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_UNLOCK, WTSActive, WTSFreeMemory,
    WTSINFOEXW, WTSQuerySessionInformationW, WTSSessionInfoEx,
};
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetThreadDpiAwarenessContext,
};
use windows_sys::Win32::UI::Shell::{
    QUNS_NOT_PRESENT, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GA_ROOT, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, WindowFromPhysicalPoint,
};

/// 屏幕坐标使用虚拟桌面的物理像素，左、顶可为负。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl From<RECT> for Rect {
    fn from(rect: RECT) -> Self {
        Self { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }
}

impl Rect {
    /// 判断一个物理像素是否在矩形内，右、下边界不包含。
    pub fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

/// 采集来源的身份与坐标。进程启动时间可区分回收重用的 HWND/PID。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct WindowKey {
    pub hwnd: usize,
    pub pid: u32,
    pub started: u64,
    pub rect: Rect,
    pub dpi: u32,
}

#[derive(Clone)]
pub(super) struct WindowInfo {
    pub key: WindowKey,
    pub process: String,
    pub title: String,
    pub observed_at_ms: u64,
}

/// 固定原因可放心打印，避免把异常、标题或控件文字带到演示输出中。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denial {
    UnavailableDesktop,
    LockedSession,
    UnknownWindow,
    UnknownProcess,
    BlockedProcess,
    BlockedTitle,
    Fullscreen,
    WindowChanged,
    Password,
    AccessibilityUnavailable,
    AccessibilityBudget,
    CaptureUnavailable,
}

impl Denial {
    pub fn reason(self) -> &'static str {
        match self {
            Self::UnavailableDesktop => "桌面不可访问或处于安全桌面",
            Self::LockedSession => "会话锁定、断开或无法确认状态",
            Self::UnknownWindow => "无法确认前台窗口",
            Self::UnknownProcess => "无法确认进程身份",
            Self::BlockedProcess => "进程在隐私黑名单",
            Self::BlockedTitle => "标题命中隐私黑名单",
            Self::Fullscreen => "全屏或演示模式",
            Self::WindowChanged => "点击目标或前台窗口已变化",
            Self::Password => "窗口包含密码控件",
            Self::AccessibilityUnavailable => "无法确认控件安全",
            Self::AccessibilityBudget => "控件检查超出时间或节点上限",
            Self::CaptureUnavailable => "窗口采集不可用",
        }
    }
}

pub(super) struct Rejected {
    pub reason: Denial,
    pub process: Option<String>,
}

impl From<Denial> for Rejected {
    fn from(reason: Denial) -> Self {
        Self { reason, process: None }
    }
}

const PRIVATE_PROCESSES: &[&str] = &[
    "wechat.exe", "weixin.exe", "wechatappex.exe", "keepass.exe", "keepassxc.exe",
    "1password.exe", "bitwarden.exe", "consent.exe", "logonui.exe", "credentialuibroker.exe",
];

const PRIVATE_TITLES: &[&str] = &[
    "微信", "wechat", "weixin", "密码", "password", "验证码", "verification code",
];

/// 可独立测试的窗口策略。标题只用于本机判定。
fn check_window(process: &str, title: &str, fullscreen: bool) -> Result<(), Denial> {
    if process.is_empty() { return Err(Denial::UnknownProcess); }

    if PRIVATE_PROCESSES.iter().any(|name| process.eq_ignore_ascii_case(name)) {
        return Err(Denial::BlockedProcess);
    }

    let lower = title.to_lowercase();
    if PRIVATE_TITLES.iter().any(|word| lower.contains(word)) {
        return Err(Denial::BlockedTitle);
    }

    if fullscreen { return Err(Denial::Fullscreen); }
    Ok(())
}

/// 只有明确返回非密码，且控件归属已证实时，才继续读取其他属性。
pub(super) fn check_element(password: Option<bool>, pid: u32, expected_pid: u32) -> Result<(), Denial> {
    if pid == 0 || pid != expected_pid { return Err(Denial::AccessibilityUnavailable); }
    if password == Some(true) { return Err(Denial::Password); }
    if password != Some(false) { return Err(Denial::AccessibilityUnavailable); }
    Ok(())
}

/// 在当前工作线程启用物理坐标语义，失败时由调用方关闭采集。
pub(super) fn use_physical_coordinates() -> bool {
    //G 线程退出时由 Windows 回收上下文，避免修改整个基地进程的 DPI 设置。
    !unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }.is_null()
}

/// 点击点必须落在同一个前台顶层窗口，归属不明的菜单和弹窗直接拒绝。
pub(super) fn window_at(x: i32, y: i32) -> usize {
    let point = POINT { x, y };
    let child = unsafe { WindowFromPhysicalPoint(point) };
    if child.is_null() { return 0; }
    unsafe { GetAncestor(child, GA_ROOT) as usize }
}

/// 认证没有独立编辑语义的原生容器。仍须扫描它的子树。
pub(super) fn native_container(handle: usize, window: WindowKey) -> bool {
    if handle == 0 { return false; }
    let hwnd = handle as HWND;
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let mut pid = 0;
    let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if thread == 0 || pid != window.pid || root as usize != window.hwnd { return false; }

    let mut class = [0u16; 128];
    let count = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    if count <= 0 || count as usize >= class.len() - 1 { return false; }
    let name = String::from_utf16_lossy(&class[..count as usize]);
    is_known_wrapper(&name)
}

fn is_known_wrapper(class: &str) -> bool {
    matches!(
        class,
        "Notepad" | "NotepadTextBox" | "Microsoft.UI.Content.DesktopChildSiteBridge" | "InputSiteWindowClass"
    )
}

fn session_unlocked(state: i32, flags: i32) -> bool {
    state == WTSActive && flags == WTS_SESSIONSTATE_UNLOCK as i32
}

fn desktop_allowed(name: &str) -> bool {
    name.eq_ignore_ascii_case("Default")
}

/// 检查当前交互会话和输入桌面；锁屏、UAC 安全桌面及状态未知均返回固定原因。
fn check_desktop() -> Result<(), Denial> {
    let mut buffer = null_mut();
    let mut length = 0;
    //G 定期检查会话标志，可覆盖一些未收到的窗口切换通知。
    let queried = unsafe {
        WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buffer, &mut length,
        )
    };

    if queried == 0 || buffer.is_null() { return Err(Denial::LockedSession); }
    let mut unlocked = false;
    if length as usize >= size_of::<WTSINFOEXW>() {
        // SAFETY: API 返回的缓冲区至少包含一个 WTSINFOEXW。
        let info = unsafe { &*buffer.cast::<WTSINFOEXW>() };
        if info.Level == 1 {
            let state = unsafe { info.Data.WTSInfoExLevel1 };
            unlocked = session_unlocked(state.SessionState, state.SessionFlags);
        }
    }
    unsafe { WTSFreeMemory(buffer.cast()) };
    if !unlocked { return Err(Denial::LockedSession); }

    //G 安全桌面经常拒绝访问，即便能查询也只放行标准 Default 桌面。
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() { return Err(Denial::UnavailableDesktop); }

    let mut name = [0u16; 64];
    let mut needed = 0;
    let ok = unsafe {
        GetUserObjectInformationW(desktop, UOI_NAME, name.as_mut_ptr().cast(), size_of_val(&name) as u32, &mut needed)
    };
    unsafe { CloseDesktop(desktop) };
    let name = String::from_utf16_lossy(name.split(|value| *value == 0).next().unwrap_or_default());
    if ok == 0 || !desktop_allowed(&name) { return Err(Denial::UnavailableDesktop); }
    Ok(())
}

/// 查询进程基名与启动时间，打开的句柄在本次检查内关闭。
fn read_process(pid: u32) -> Result<(String, u64), Denial> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() { return Err(Denial::UnknownProcess); }

    let mut path = [0u16; 1024];
    let mut count = path.len() as u32;
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let image_ok = unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut count) };
    let times_ok = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if image_ok == 0 || times_ok == 0 || count == 0 { return Err(Denial::UnknownProcess); }

    //M 只保留可执行文件名供规则和探针使用，完整路径不出函数。
    let path = String::from_utf16_lossy(&path[..count as usize]);
    let process = path.rsplit(['\\', '/']).next().unwrap_or_default().to_owned();
    let started = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Ok((process, started))
}

/// 捕获前的原生窗口快照。任何未知坐标或状态均拒绝，标题保留在本函数内。
pub(super) fn foreground() -> Result<WindowInfo, Rejected> {
    check_desktop()?;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() { return Err(Denial::UnknownWindow.into()); }
    let visible = unsafe { IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 };
    if !visible { return Err(Denial::UnknownWindow.into()); }

    let mut pid = 0;
    if unsafe { GetWindowThreadProcessId(hwnd, &mut pid) } == 0 || pid == 0 {
        return Err(Denial::UnknownProcess.into());
    }
    let (process, started) = read_process(pid)?;
    let with_process = |reason| Rejected { reason, process: Some(process.clone()) };

    //G 黑名单检查先于任何标题、UIA 或 WGC 读取。
    check_window(&process, "", false).map_err(with_process)?;
    let (rect, fullscreen) = geometry(hwnd).map_err(with_process)?;
    unsafe { SetLastError(0) };
    let count = unsafe { GetWindowTextLengthW(hwnd) };
    if count == 0 && unsafe { GetLastError() } != 0 {
        return Err(with_process(Denial::UnknownWindow));
    }
    let cap = count.saturating_add(2);
    if cap > 8192 { return Err(with_process(Denial::UnknownWindow)); }
    let mut title = vec![0u16; cap as usize];
    unsafe { SetLastError(0) };
    let got = unsafe { GetWindowTextW(hwnd, title.as_mut_ptr(), cap) };
    if got == 0 && unsafe { GetLastError() } != 0 {
        return Err(with_process(Denial::UnknownWindow));
    }
    if got < count || got == cap - 1 { return Err(with_process(Denial::UnknownWindow)); }
    let title = String::from_utf16_lossy(&title[..got as usize]);
    check_window(&process, &title, fullscreen).map_err(with_process)?;

    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 || unsafe { GetForegroundWindow() } != hwnd {
        return Err(with_process(Denial::WindowChanged));
    }

    let key = WindowKey { hwnd: hwnd as usize, pid, started, rect, dpi };
    let observed_at_ms = super::unix_ms();
    Ok(WindowInfo { key, process, title, observed_at_ms })
}

/// DWM 边界为物理像素，比较所在显示器的完整矩形和系统全屏状态。
fn geometry(hwnd: HWND) -> Result<(Rect, bool), Denial> {
    let mut physical = RECT::default();
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, (&mut physical as *mut RECT).cast::<c_void>(),
            size_of::<RECT>() as u32,
        )
    };
    if result < 0 || physical.right <= physical.left || physical.bottom <= physical.top {
        return Err(Denial::UnknownWindow);
    }

    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    if monitor.is_null() || unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return Err(Denial::UnknownWindow);
    }
    let display = info.rcMonitor;
    let covers = physical.left <= display.left && physical.top <= display.top
        && physical.right >= display.right && physical.bottom >= display.bottom;

    let mut state = 0;
    let status = unsafe { SHQueryUserNotificationState(&mut state) };
    if status < 0 || state == QUNS_NOT_PRESENT { return Err(Denial::UnavailableDesktop); }
    let fullscreen = covers || state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE;
    Ok((Rect::from(physical), fullscreen))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_rules_refuse_unknown_blacklist_titles_and_fullscreen() {
        assert_eq!(check_window("", "记事本", false), Err(Denial::UnknownProcess));
        for name in PRIVATE_PROCESSES {
            let upper = name.to_uppercase();
            assert_eq!(check_window(&upper, "普通标题", false), Err(Denial::BlockedProcess));
        }
        for title in PRIVATE_TITLES {
            let window = format!("示例 · {}", title.to_uppercase());
            assert_eq!(check_window("demo.exe", &window, false), Err(Denial::BlockedTitle));
        }
        assert_eq!(check_window("demo.exe", "", true), Err(Denial::Fullscreen));
        assert_eq!(check_window("demo-wechat.exe", "安全窗口", false), Ok(()));
    }

    #[test]
    fn password_and_uncertain_properties_fail_closed() {
        assert_eq!(check_element(Some(true), 10, 10), Err(Denial::Password));
        assert_eq!(check_element(None, 10, 10), Err(Denial::AccessibilityUnavailable));
        assert_eq!(check_element(Some(false), 11, 10), Err(Denial::AccessibilityUnavailable));
        assert_eq!(check_element(Some(false), 10, 10), Ok(()));
    }

    #[test]
    fn only_unlocked_active_default_desktop_can_capture() {
        use windows_sys::Win32::System::RemoteDesktop::{
            WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNKNOWN, WTSDisconnected,
        };

        assert!(session_unlocked(WTSActive, WTS_SESSIONSTATE_UNLOCK as i32));
        assert!(!session_unlocked(WTSActive, WTS_SESSIONSTATE_LOCK as i32));
        assert!(!session_unlocked(WTSActive, WTS_SESSIONSTATE_UNKNOWN as i32));
        assert!(!session_unlocked(WTSDisconnected, WTS_SESSIONSTATE_UNLOCK as i32));
        assert!(desktop_allowed("default"));
        assert!(!desktop_allowed("Winlogon"));
        assert!(!desktop_allowed(""));
    }

    #[test]
    fn native_wrapper_classes_are_explicit() {
        assert!(is_known_wrapper("Microsoft.UI.Content.DesktopChildSiteBridge"));
        assert!(is_known_wrapper("NotepadTextBox"));
        assert!(!is_known_wrapper("Edit"));
        assert!(!is_known_wrapper("UnknownPane"));
    }
}
