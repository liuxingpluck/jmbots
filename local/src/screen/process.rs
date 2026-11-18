//! 独立加工线程所用的裁图与压缩。输入是点击前已通过隐私门的原始 RGBA。

use std::sync::{Condvar, Mutex};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, Rgb, RgbImage};

use super::capture::Sample;
use super::privacy::Rect;
use super::transport::{ImageBody, Point, WireRect};

const DOT_RADIUS: i32 = 6;
pub(super) const MAX_JPEG: usize = 256 * 1024;

/// 单槽队列。放入新工作即释放尚未开始的旧工作。
pub(super) struct Latest<T> {
    item: Mutex<Option<T>>,
    ready: Condvar,
}

impl<T> Default for Latest<T> {
    fn default() -> Self {
        Self { item: Mutex::new(None), ready: Condvar::new() }
    }
}

impl<T> Latest<T> {
    pub fn put(&self, value: T) {
        if let Ok(mut item) = self.item.lock() {
            *item = Some(value);
            self.ready.notify_one();
        }
    }

    pub fn take(&self, wait: Duration) -> Option<T> {
        let item = self.item.lock().ok()?;
        let (mut item, _) = self.ready.wait_timeout_while(item, wait, |item| item.is_none()).ok()?;
        item.take()
    }

    pub fn clear(&self) {
        if let Ok(mut item) = self.item.lock() {
            *item = None;
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct CropSettings {
    pub width: u32,
    pub height: u32,
    pub max_width: u32,
    pub max_height: u32,
    pub quality: u8,
    pub limit: usize,
    pub max_age: u64,
}

/// 以点击为中心，从目标窗口与显示器的交集中裁取物理坐标。
fn crop_area(window: Rect, monitor: Rect, click: Point, width: u32, height: u32) -> Option<Rect> {
    if !window.contains(click.x, click.y) || !monitor.contains(click.x, click.y) { return None; }
    let left = click.x.saturating_sub((width / 2) as i32);
    let top = click.y.saturating_sub((height / 2) as i32);
    let right = left.saturating_add(width as i32);
    let bottom = top.saturating_add(height as i32);
    let crop = Rect {
        left: left.max(window.left).max(monitor.left),
        top: top.max(window.top).max(monitor.top),
        right: right.min(window.right).min(monitor.right),
        bottom: bottom.min(window.bottom).min(monitor.bottom),
    };
    crop.contains(click.x, click.y).then_some(crop)
}

/// 原始环帧是一比一物理像素。直接取裁图里的 RGB，原帧仍由环所有。
fn crop_rgb(frame: &Sample, area: Rect) -> Option<RgbImage> {
    let rect = frame.window.rect;
    let width = u32::try_from(area.right - area.left).ok()?;
    let height = u32::try_from(area.bottom - area.top).ok()?;
    let x = usize::try_from(area.left - rect.left).ok()?;
    let y = usize::try_from(area.top - rect.top).ok()?;
    let stride = frame.width as usize * 4;
    let pixels = frame.pixels();
    if width == 0 || height == 0 || x + width as usize > frame.width as usize
        || y + height as usize > frame.height as usize || pixels.len() != stride * frame.height as usize
    {
        return None;
    }

    let rgb = RgbImage::from_fn(width, height, |col, row| {
        let offset = (y + row as usize) * stride + (x + col as usize) * 4;
        Rgb([pixels[offset], pixels[offset + 1], pixels[offset + 2]])
    });
    Some(rgb)
}

fn mark_click(image: &mut RgbImage, x: i32, y: i32) {
    let left = (x - DOT_RADIUS).max(0);
    let top = (y - DOT_RADIUS).max(0);
    let right = (x + DOT_RADIUS).min(image.width() as i32 - 1);
    let bottom = (y + DOT_RADIUS).min(image.height() as i32 - 1);
    for py in top..=bottom {
        for px in left..=right {
            let dx = px - x;
            let dy = py - y;
            if dx * dx + dy * dy <= DOT_RADIUS * DOT_RADIUS {
                image.put_pixel(px as u32, py as u32, Rgb([255, 0, 0]));
            }
        }
    }
}

/// 首次用配置质量。体积过大时逐步降质量，始终维持原裁图和点击坐标。
fn encode(image: &RgbImage, mut quality: u8, limit: usize) -> Option<(Vec<u8>, u8)> {
    let mut bytes = Vec::new();
    loop {
        let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
        encoder.encode(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgb8).ok()?;
        if bytes.len() <= limit { return Some((bytes, quality)); }
        if quality == 1 { return None; }
        bytes.clear();
        quality = quality.saturating_sub(15).max(1);
    }
}

/// 返回协议图像，或者固定的可省略原因。隐私问题在调用前拦截。
pub(super) fn make_image(
    frame: Option<&Sample>, clicked_at: u64, click_mono: u64, click: Point, monitor: Rect,
    crop: CropSettings,
) -> Result<ImageBody, &'static str> {
    let frame = frame.ok_or("no_preclick_frame")?;
    let age = click_mono.checked_sub(frame.captured_mono_ms).ok_or("stale_frame")?;
    if age > crop.max_age || frame._captured_at_ms > clicked_at { return Err("stale_frame"); }

    let area = crop_area(frame.window.rect, monitor, click, crop.width, crop.height)
        .ok_or("no_preclick_frame")?;
    let source = crop_rgb(frame, area).ok_or("no_preclick_frame")?;
    let (source_width, source_height) = source.dimensions();
    let mut image = output_size(source, crop.max_width, crop.max_height);
    let x = i64::from(click.x - area.left) * i64::from(image.width()) / i64::from(source_width);
    let y = i64::from(click.y - area.top) * i64::from(image.height()) / i64::from(source_height);
    mark_click(&mut image, x as i32, y as i32);
    let (bytes, _) = encode(&image, crop.quality, crop.limit).ok_or("too_large")?;
    let data = STANDARD.encode(bytes);
    Ok(ImageBody {
        mime_type: "image/jpeg",
        data,
        captured_at_ms: frame._captured_at_ms,
        age_before_click_ms: age,
        source_rect: WireRect::from_rect(area).ok_or("no_preclick_frame")?,
        width: image.width(),
        height: image.height(),
    })
}

/// 输出尺寸超限时等比缩小裁图，保持请求中的物理范围。
fn output_size(source: RgbImage, width: u32, height: u32) -> RgbImage {
    if source.width() <= width && source.height() <= height { return source; }
    let scale = (f64::from(width) / f64::from(source.width()))
        .min(f64::from(height) / f64::from(source.height()));
    let target_width = ((f64::from(source.width()) * scale) as u32).max(1);
    let target_height = ((f64::from(source.height()) * scale) as u32).max(1);
    image::imageops::resize(&source, target_width, target_height, image::imageops::FilterType::Triangle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_at_window_and_negative_monitor_corner() {
        let screen = Rect { left: -1_920, top: 0, right: 0, bottom: 1_080 };
        let window = Rect { left: -2_000, top: -20, right: 100, bottom: 500 };
        let point = Point { x: -1_920, y: 0 };
        let got = crop_area(window, screen, point, 480, 320).unwrap();
        assert_eq!(got, Rect { left: -1_920, top: 0, right: -1_680, bottom: 160 });
        assert!(crop_area(window, screen, Point { x: 0, y: 0 }, 480, 320).is_none());
    }

    #[test]
    fn paints_red_at_click_even_at_corner() {
        let mut bitmap = RgbImage::new(20, 20);
        mark_click(&mut bitmap, 0, 19);
        assert_eq!(bitmap.get_pixel(0, 19), &Rgb([255, 0, 0]));
        assert_eq!(bitmap.get_pixel(6, 19), &Rgb([255, 0, 0]));
        assert_eq!(bitmap.get_pixel(6, 18), &Rgb([0, 0, 0]));
        assert_eq!(bitmap.get_pixel(19, 19), &Rgb([0, 0, 0]));
    }

    #[test]
    fn retries_jpeg_at_lower_quality_under_byte_limit() {
        let mut state = 71u32;
        let picture = RgbImage::from_fn(192, 128, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            Rgb([(state >> 24) as u8, (state >> 16) as u8, (state >> 8) as u8])
        });
        let (original, original_quality) = encode(&picture, 75, MAX_JPEG).unwrap();
        let limit = original.len() - 1;
        let (smaller, quality) = encode(&picture, 75, limit).unwrap();
        assert_eq!(original_quality, 75);
        assert!(quality < 75 && smaller.len() <= limit);
        assert!(encode(&picture, 75, 1).is_none());
    }

    #[test]
    fn queue_only_keeps_the_latest_pending_item() {
        let latest = Latest::default();
        latest.put(11);
        latest.put(12);
        latest.put(13);
        assert_eq!(latest.take(Duration::ZERO), Some(13));
        assert_eq!(latest.take(Duration::ZERO), None);
    }
}
