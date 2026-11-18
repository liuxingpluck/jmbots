//! 讲解浮窗与显示器坐标。原生样式和排除录屏均在显示前验证。

use std::mem::size_of;
use std::ptr::null_mut;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONULL, MONITORINFO,
    MONITORINFOEXW, MonitorFromPoint,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowDisplayAffinity, GetWindowLongPtrW, HWND_TOPMOST, MONITORINFOF_PRIMARY,
    SWP_NOACTIVATE, SWP_SHOWWINDOW, SetWindowDisplayAffinity, SetWindowLongPtrW, SetWindowPos,
    WDA_EXCLUDEFROMCAPTURE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::privacy::Rect;
use super::transport::Point;

const LABEL: &str = "screen-explanation";
const PAGE: &str = "screen-overlay.html";

/// 物理显示范围、工作区和 DPI，用于网页外框定位及上传坐标。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Display {
    pub id: String,
    pub rect: Rect,
    pub work: Rect,
    pub dpi_x: u32,
    pub dpi_y: u32,
}

impl Display {
    pub fn at(point: Point) -> Option<Self> {
        let position = POINT { x: point.x, y: point.y };
        let monitor = unsafe { MonitorFromPoint(position, MONITOR_DEFAULTTONULL) };
        Self::read(monitor)
    }

    fn read(monitor: HMONITOR) -> Option<Self> {
        if monitor.is_null() { return None; }
        let info = monitor_info(monitor)?;
        let mut dpi_x = 0;
        let mut dpi_y = 0;
        let found = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
        if found < 0 || dpi_x == 0 || dpi_y == 0 { return None; }

        let name = info.szDevice.split(|letter| *letter == 0).next()?;
        let id = String::from_utf16(name).ok()?;
        if id.is_empty() { return None; }
        Some(Self {
            id,
            rect: Rect::from(info.monitorInfo.rcMonitor),
            work: Rect::from(info.monitorInfo.rcWork),
            dpi_x,
            dpi_y,
        })
    }
}

fn monitor_info(monitor: HMONITOR) -> Option<MONITORINFOEXW> {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let base: *mut MONITORINFO = &mut info.monitorInfo;
    let found = unsafe { GetMonitorInfoW(monitor, base) };
    (found != 0).then_some(info)
}

/// 只用于本地演示，无法确认副屏时保持隐藏。
fn secondary_display() -> Option<Display> {
    unsafe extern "system" fn select(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> i32 {
        let Some(info) = monitor_info(monitor) else { return 1; };
        if info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0 { return 1; }
        // SAFETY: EnumDisplayMonitors 同步调用，变量在整个枚举中有效。
        unsafe { *(data as *mut HMONITOR) = monitor };
        0
    }

    let mut monitor: HMONITOR = null_mut();
    let data = (&mut monitor as *mut HMONITOR) as LPARAM;
    unsafe { EnumDisplayMonitors(null_mut(), null_mut(), Some(select), data) };
    Display::read(monitor)
}

/// 所有窗口操作提交到 Tauri 主线程，同一时间只保留最新一次显示。
#[derive(Clone)]
pub struct Overlay {
    app: AppHandle,
    state: Arc<OverlayState>,
}

struct OverlayState {
    generation: AtomicU64,
    until: Mutex<Option<Instant>>,
}

impl Overlay {
    pub fn new(app: AppHandle) -> Self {
        let state = OverlayState { generation: AtomicU64::new(0), until: Mutex::new(None) };
        Self { app, state: Arc::new(state) }
    }

    pub(super) fn show<F>(
        &self, text: String, display: Display, clicked: Option<Point>, duration: Duration, current: F,
    ) where F: Fn() -> bool + Send + Sync + 'static {
        let Ok(mut until) = self.state.until.lock() else { return; };
        let generation = self.state.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let deadline = Instant::now() + duration;
        *until = Some(deadline);
        drop(until);

        let app = self.app.clone();
        let state = self.state.clone();
        let still_valid = Arc::new(move || {
            state.generation.load(Ordering::Acquire) == generation && Instant::now() < deadline && current()
        });
        let _ = self.app.run_on_main_thread(move || {
            if !still_valid() { return; }
            let result = present(&app, &text, &display, clicked, still_valid);
            if result.is_err() {
                //G 排除录屏或窗口创建失败时保持隐藏，不回显解释内容。
                if let Some(window) = app.get_webview_window(LABEL) {
                    let _ = window.hide();
                }
                eprintln!("讲解浮窗不可用（overlay_capture_unsupported）");
            }
        });
    }

    pub fn hide(&self) {
        let Ok(mut until) = self.state.until.lock() else { return; };
        let generation = self.state.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *until = None;
        drop(until);
        self.hide_generation(generation);
    }

    fn hide_generation(&self, generation: u64) {
        let app = self.app.clone();
        let state = self.state.clone();
        let _ = self.app.run_on_main_thread(move || {
            if state.generation.load(Ordering::Acquire) != generation { return; }
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.hide();
                let _ = window.eval("document.getElementById('explanation')?.replaceChildren()");
            }
        });
    }

    pub(super) fn tick(&self) {
        let Ok(mut until) = self.state.until.lock() else { return; };
        if !until.is_some_and(|time| Instant::now() >= time) { return; }
        let generation = self.state.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *until = None;
        drop(until);
        self.hide_generation(generation);
    }

    /// 后端未挂载时的本地演示，默认落在副屏。
    pub fn demo_secondary(&self, duration: Duration) -> bool {
        let Some(display) = secondary_display() else { return false; };
        let text = "模拟讲解：点到的控件会在这里显示一两句说明。".to_owned();
        self.show(text, display, None, duration, || true);
        true
    }
}

fn present(
    app: &AppHandle, text: &str, display: &Display, clicked: Option<Point>,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<()> {
    let value = serde_json::to_string(text)?;
    let script = format!(
        "(()=>{{const update=()=>{{const label=document.getElementById('explanation');if(label)label.textContent={value};}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',update,{{once:true}});else update();}})();"
    );
    let area = panel_area(display, clicked).ok_or_else(|| anyhow!("显示器工作区不可用"))?;
    if let Some(window) = app.get_webview_window(LABEL) {
        window.eval(&script)?;
        if !current() { return Ok(()); }
        return native_show(&window, area);
    }

    //M 首次等本地页面就绪再显示，避免空 WebView 闪到桌面。
    let page = WebviewUrl::App(PAGE.into());
    let window = WebviewWindowBuilder::new(app, LABEL, page)
        .title("录屏讲解")
        .visible(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .always_on_top(true)
        .initialization_script(script)
        .on_page_load(move |window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished || !current() { return; }
            if native_show(&window, area).is_err() {
                let _ = window.hide();
                eprintln!("讲解浮窗不可用（overlay_capture_unsupported）");
            }
        })
        .build()?;
    window.set_ignore_cursor_events(true)?;
    Ok(())
}

fn native_show(window: &WebviewWindow, area: Rect) -> Result<()> {
    let hwnd: HWND = window.hwnd()?.0.cast();
    let mask = (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize;
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | mask) };
    if unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & mask != mask {
        bail!("浮窗不能设置非激活样式");
    }

    let mut affinity = 0;
    let safe = unsafe {
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) != 0
            && GetWindowDisplayAffinity(hwnd, &mut affinity) != 0
            && affinity == WDA_EXCLUDEFROMCAPTURE
    };
    if !safe { bail!("浮窗无法排除录屏"); }

    let flags = SWP_NOACTIVATE | SWP_SHOWWINDOW;
    let width = area.right - area.left;
    let height = area.bottom - area.top;
    let visible = unsafe { SetWindowPos(hwnd, HWND_TOPMOST, area.left, area.top, width, height, flags) };
    if visible == 0 { bail!("浮窗无法显示"); }
    Ok(())
}

fn panel_area(display: &Display, clicked: Option<Point>) -> Option<Rect> {
    let work = display.work;
    let margin = 12;
    let width = (420 * display.dpi_x as i32 / 96).min(work.right - work.left - margin * 2);
    let height = (140 * display.dpi_y as i32 / 96).min(work.bottom - work.top - margin * 2);
    if width <= 0 || height <= 0 { return None; }

    let right = work.right - margin;
    let bottom = work.bottom - margin;
    let mut area = Rect { left: right - width, top: bottom - height, right, bottom };
    if clicked.is_some_and(|point| area.contains(point.x, point.y)) {
        area.top = work.top + margin;
        area.bottom = area.top + height;
    }
    Some(area)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_stays_on_secondary_work_area_and_avoids_click() {
        let rect = Rect { left: -1920, top: 0, right: 0, bottom: 1080 };
        let work = Rect { bottom: 1040, ..rect };
        let display = Display { id: "secondary".into(), rect, work, dpi_x: 144, dpi_y: 144 };
        let click = Point { x: -25, y: 980 };
        let area = panel_area(&display, Some(click)).unwrap();
        assert!(!area.contains(click.x, click.y));
        assert!(work.contains(area.left, area.top));
        assert!(work.contains(area.right - 1, area.bottom - 1));
    }
}
