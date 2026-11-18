//! 指定前台窗口的 WGC 采集与内存帧环。只有取得短期隐私检查许可才读取像素。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

use super::mouse::InputState;
use super::privacy::{self, Denial, Rect, WindowKey};

const MAX_AGE_MS: u64 = 3_000;
const MATCH_AGE_MS: u64 = 1_000;
const MAX_FRAMES: usize = 6;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const PERMIT_MS: u64 = 150;
const MAX_PRESENT_LEAD_MS: u64 = 30;
pub(super) const FRAME_INTERVAL_MS: u64 = 500;

/// 只存自有 RGBA 和允许窗口的几何。单调时间与 WGC 的 QPC 同源。
pub(super) struct Sample {
    pub captured_mono_ms: u64,
    pub _captured_at_ms: u64,
    pub epoch: u64,
    pub window: WindowKey,
    pub width: u32,
    pub height: u32,
    pixels: Vec<u8>,
}

#[derive(Default)]
pub(super) struct FrameRing {
    frames: VecDeque<Arc<Sample>>,
    bytes: usize,
}

impl FrameRing {
    pub fn clear(&mut self) {
        self.frames.clear();
        self.bytes = 0;
    }

    pub fn stats(&self) -> (usize, usize) {
        (self.frames.len(), self.bytes)
    }

    pub fn prune(&mut self, now: u64) {
        while self.frames.front().is_some_and(|frame| now.saturating_sub(frame.captured_mono_ms) > MAX_AGE_MS) {
            self.evict();
        }
    }

    pub fn push(&mut self, frame: Sample, now: u64) {
        self.prune(now);
        let size = frame.pixels.capacity();
        if size > MAX_BYTES || frame.captured_mono_ms > now || now - frame.captured_mono_ms > MAX_AGE_MS {
            return;
        }

        if let Some(newest) = self.frames.back() {
            if newest.window != frame.window || newest.epoch != frame.epoch {
                self.clear();
            }
        }

        //M 同一环中始终按采集时间递增，选点击前最后一帧时可以反向扫描。
        if self.frames.back().is_some_and(|newest| newest.captured_mono_ms >= frame.captured_mono_ms) {
            return;
        }
        while self.frames.len() >= MAX_FRAMES || self.bytes + size > MAX_BYTES {
            self.evict();
        }
        self.bytes += size;
        self.frames.push_back(Arc::new(frame));
    }

    /// 只返回点击之前且足够接近的同一窗口帧，并验证点击确实映射到帧内。
    pub fn before(&self, window: WindowKey, epoch: u64, click_ms: u64, x: i32, y: i32) -> Option<&Arc<Sample>> {
        self.frames.iter().rev().find(|frame| {
            frame.epoch == epoch && frame.window == window && frame.captured_mono_ms <= click_ms
                && click_ms - frame.captured_mono_ms <= MATCH_AGE_MS
                && physical_to_frame(window.rect, frame.width, frame.height, x, y).is_some()
        })
    }

    fn evict(&mut self) {
        if let Some(frame) = self.frames.pop_front() {
            self.bytes -= frame.pixels.capacity();
        }
    }
}

impl Sample {
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }
}

/// 从虚拟桌面物理像素转入帧坐标，窗口左上角可能位于坐标原点左侧。
fn physical_to_frame(rect: Rect, width: u32, height: u32, x: i32, y: i32) -> Option<(u32, u32)> {
    if !rect.contains(x, y) || width == 0 || height == 0 { return None; }

    //M 窗口边界和输入均是物理像素，比例在此只应用一次。
    let offset_x = i64::from(x) - i64::from(rect.left);
    let offset_y = i64::from(y) - i64::from(rect.top);
    let span_x = i64::from(rect.right) - i64::from(rect.left);
    let span_y = i64::from(rect.bottom) - i64::from(rect.top);
    let px = u64::try_from(offset_x).ok()? * u64::from(width) / u64::try_from(span_x).ok()?;
    let py = u64::try_from(offset_y).ok()? * u64::from(height) / u64::try_from(span_y).ok()?;
    Some((px as u32, py as u32))
}

/// Windows Graphics Capture 的 SystemRelativeTime 是同机 QPC 的 100ns 表示。
pub(super) fn qpc_ms() -> Option<u64> {
    let mut freq = 0;
    let mut counter = 0;
    let ok = unsafe { QueryPerformanceFrequency(&mut freq) != 0 && QueryPerformanceCounter(&mut counter) != 0 };
    if !ok || freq <= 0 || counter < 0 { return None; }

    Some((i128::from(counter) * 1000 / i128::from(freq)) as u64)
}

/// 合成器可能为画面标注紧接着的呈现时刻。保留原时间，
/// 用超前界限排除早于许可的候选以及时钟域异常的结果。
fn allowed_frame_time(from: u64, reported: u64, now: u64) -> bool {
    if now < from || now - from > PERMIT_MS { return false; }
    let earliest = reported.saturating_sub(MAX_PRESENT_LEAD_MS);
    earliest > from && reported <= now.saturating_add(MAX_PRESENT_LEAD_MS)
}

/// 对外只暴露受控采集会话。停止时先撤回许可，随后停止并回收 WGC 线程。
pub(super) struct Capture {
    control: Option<CaptureControl<CaptureHandler, Denial>>,
    permit: Arc<Mutex<Option<u64>>>,
    frames: Receiver<Sample>,
}

struct CaptureHandler {
    key: WindowKey,
    epoch: u64,
    input: Arc<InputState>,
    stopped: Arc<AtomicBool>,
    permit: Arc<Mutex<Option<u64>>>,
    frames: SyncSender<Sample>,
}

impl Capture {
    pub fn start(
        key: WindowKey, epoch: u64, input: Arc<InputState>, stopped: Arc<AtomicBool>, allowed_at: u64,
    ) -> Result<Self, Denial> {
        let (sender, frames) = sync_channel(1);
        let permit = Arc::new(Mutex::new(Some(allowed_at)));
        let handler = CaptureHandler { key, epoch, input, stopped, permit: permit.clone(), frames: sender };

        //G 只用 HWND 窗口源，显式禁止捕获二级窗口，不回落到显示器采集。
        let item = Window::from_raw_hwnd(key.hwnd as *mut std::ffi::c_void);
        let settings = Settings::new(
            item, CursorCaptureSettings::WithoutCursor, DrawBorderSettings::Default,
            SecondaryWindowSettings::Exclude, MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default, ColorFormat::Rgba8, handler,
        );
        let control = CaptureHandler::start_free_threaded(settings).map_err(|_| Denial::CaptureUnavailable)?;
        Ok(Self { control: Some(control), permit, frames })
    }

    pub fn renew(&self, now: u64) {
        if let Ok(mut permit) = self.permit.lock() {
            *permit = Some(now);
        }
    }

    pub fn frame(&self) -> Option<Sample> {
        self.frames.try_recv().ok()
    }

    pub fn finished(&self) -> bool {
        self.control.as_ref().is_none_or(CaptureControl::is_finished)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Ok(mut allowed) = self.permit.lock() {
            *allowed = None;
        }
        if let Some(control) = self.control.take() {
            let _ = control.stop();
        }
    }
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = Self;
    type Error = Denial;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        if !privacy::use_physical_coordinates() { return Err(Denial::CaptureUnavailable); }
        Ok(ctx.flags)
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        if self.stopped.load(Ordering::Acquire) || self.input.epoch.load(Ordering::Acquire) != self.epoch {
            control.stop();
            return Ok(());
        }

        let Some(now) = qpc_ms() else { return Ok(()); };
        let timestamp = frame.timestamp().map_err(|_| Denial::CaptureUnavailable)?;
        let Ok(frame_ms) = u64::try_from(timestamp.Duration / 10_000) else { return Ok(()); };

        //G 只接受隐私核对完成以后的新帧，每份许可至多取一张。
        let Ok(mut permit) = self.permit.lock() else { return Ok(()); };
        let Some(from) = *permit else { return Ok(()); };
        if !allowed_frame_time(from, frame_ms, now) { return Ok(()); }
        *permit = None;
        drop(permit);

        let current = privacy::foreground();
        if !current.is_ok_and(|info| info.key == self.key) {
            control.stop();
            return Ok(());
        }

        let Some(sample) = self.copy_frame(frame, frame_ms, now)? else { return Ok(()); };
        if self.input.epoch.load(Ordering::Acquire) == self.epoch && !self.stopped.load(Ordering::Acquire) {
            let _ = self.frames.try_send(sample);
        }
        Ok(())
    }
}

impl CaptureHandler {
    /// 保存原尺寸 RGBA，仅去掉行尾对齐填充。图像加工不占用 WGC 线程。
    fn copy_frame(&self, frame: &mut Frame, frame_ms: u64, now: u64) -> Result<Option<Sample>, Denial> {
        let source_w = frame.width() as usize;
        let source_h = frame.height() as usize;
        let rect = self.key.rect;
        let window_w = i64::from(rect.right) - i64::from(rect.left);
        let window_h = i64::from(rect.bottom) - i64::from(rect.top);

        //G WGC 源尺寸与当前窗口边界对不上时不能信任像素位置。
        if source_w == 0 || source_h == 0 || source_w as i64 != window_w || source_h as i64 != window_h {
            return Ok(None);
        }
        let row_bytes = source_w * 4;
        let Some(bytes) = row_bytes.checked_mul(source_h) else { return Ok(None); };
        if bytes > MAX_BYTES { return Ok(None); }
        let mut mapped = frame.buffer().map_err(|_| Denial::CaptureUnavailable)?;
        let pitch = mapped.row_pitch() as usize;
        let raw = mapped.as_raw_buffer();
        let Some(pixels) = copy_rgba_rows(raw, pitch, row_bytes, source_h) else { return Ok(None); };
        let unix_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let captured_at_ms = unix_ms
            .saturating_sub(now.saturating_sub(frame_ms))
            .saturating_add(frame_ms.saturating_sub(now));
        let sample = Sample {
            captured_mono_ms: frame_ms, _captured_at_ms: captured_at_ms,
            epoch: self.epoch, window: self.key, width: source_w as u32, height: source_h as u32, pixels,
        };
        Ok(Some(sample))
    }
}

/// 复制每个像素字节。连续帧直接整段复制，带 D3D 行对齐的帧逐行去掉填充。
fn copy_rgba_rows(raw: &[u8], pitch: usize, row_bytes: usize, height: usize) -> Option<Vec<u8>> {
    if row_bytes == 0 || height == 0 || pitch < row_bytes { return None; }
    let raw_bytes = pitch.checked_mul(height)?;
    let source = raw.get(..raw_bytes)?;
    if pitch == row_bytes { return Some(source.to_vec()); }

    let bytes = row_bytes * height;
    let mut pixels = Vec::with_capacity(bytes);
    for row in source.chunks_exact(pitch) {
        pixels.extend_from_slice(&row[..row_bytes]);
    }
    Some(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: Rect = Rect { left: -1200, top: -300, right: 0, bottom: 600 };
    const WINDOW: WindowKey = WindowKey { hwnd: 1, pid: 2, started: 3, rect: RECT, dpi: 144 };

    fn sample(time: u64, bytes: usize) -> Sample {
        Sample {
            captured_mono_ms: time, _captured_at_ms: time, epoch: 4, window: WINDOW,
            width: 600, height: 450, pixels: vec![0; bytes],
        }
    }

    #[test]
    fn evicts_on_count_time_and_bytes() {
        let mut ring = FrameRing::default();
        for i in 0..7 {
            ring.push(sample(i * 100, 16), i * 100);
        }
        assert_eq!(ring.stats(), (6, 96));
        assert_eq!(ring.frames.front().unwrap().captured_mono_ms, 100);
        ring.prune(3_500);
        assert_eq!(ring.stats(), (2, 32));

        ring.push(sample(4_000, MAX_BYTES / 2), 4_000);
        ring.push(sample(4_500, MAX_BYTES / 2), 4_500);
        assert_eq!(ring.stats(), (2, MAX_BYTES));
        ring.push(sample(5_000, 16), 5_000);
        assert_eq!(ring.stats(), (2, MAX_BYTES / 2 + 16));
    }

    #[test]
    fn matches_only_recent_earlier_frames_from_same_window_epoch() {
        let mut ring = FrameRing::default();
        for time in [100, 500, 1_400] {
            ring.push(sample(time, 8), time);
        }
        let matched = ring.before(WINDOW, 4, 550, -10, -10).unwrap();
        assert_eq!(matched.captured_mono_ms, 500);
        assert!(ring.before(WINDOW, 4, 99, -10, -10).is_none());
        assert!(ring.before(WINDOW, 4, 2_401, -10, -10).is_none());
        assert!(ring.before(WINDOW, 5, 550, -10, -10).is_none());
        let moved = WindowKey { dpi: 96, ..WINDOW };
        assert!(ring.before(moved, 4, 550, -10, -10).is_none());
        let mut changed = sample(1_500, 8);
        changed.window = moved;
        ring.push(changed, 1_500);
        assert_eq!(ring.stats(), (1, 8));
    }

    #[test]
    fn maps_physical_pixels_at_negative_origin_and_mixed_dpi() {
        // 150% DPI 下 800×600 逻辑单位的窗口是 1200×900 个物理像素。
        assert_eq!(physical_to_frame(RECT, 600, 450, -1_200, -300), Some((0, 0)));
        assert_eq!(physical_to_frame(RECT, 600, 450, -600, 150), Some((300, 225)));
        assert_eq!(physical_to_frame(RECT, 600, 450, -1, 599), Some((599, 449)));
        assert!(physical_to_frame(RECT, 600, 450, 0, 150).is_none());
        let primary = Rect { left: 0, top: 0, right: 800, bottom: 600 };
        assert_eq!(physical_to_frame(primary, 800, 600, 400, 300), Some((400, 300)));
    }

    #[test]
    fn allows_bounded_compositor_lead_after_the_privacy_check() {
        assert!(allowed_frame_time(1_000, 1_074, 1_060));
        assert!(allowed_frame_time(1_000, 1_060, 1_060));
        assert!(!allowed_frame_time(1_000, 1_030, 1_030));
        assert!(!allowed_frame_time(1_000, 1_091, 1_060));
        assert!(!allowed_frame_time(1_000, 1_165, 1_151));
    }

    #[test]
    fn keeps_every_original_rgba_byte_and_only_removes_row_padding() {
        let padded = [1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0];
        let pixels = [1, 2, 3, 4, 5, 6, 7, 8];
        assert_eq!(copy_rgba_rows(&padded, 8, 4, 2).unwrap(), pixels);
        assert_eq!(copy_rgba_rows(&pixels, 4, 4, 2).unwrap(), pixels);
        assert!(copy_rgba_rows(&padded[..15], 8, 4, 2).is_none());
    }
}
