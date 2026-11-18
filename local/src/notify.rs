//! 系统通知：Windows 右下角 toast。POST /notify 和壳子自己的事件（服务挂掉、重启、换版本）都走这里。
//! 通知接口只许本机调用。非 Windows 只记一行，不弹窗。

use anyhow::{Result, bail};
use serde_json::Value;
use std::net::SocketAddr;

/// 标题最长。
const TITLE_MAX: usize = 120;
/// 正文最长。
const BODY_MAX: usize = 2000;
/// 托盘通知用的应用标识（和 tauri.conf.json 的 identifier 一致）。
pub const APP_ID: &str = "ai.jmbots.local";

/// 一条通知。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// 标题。
    pub title: String,
    /// 正文。
    pub body: String,
    /// 级别。
    pub level: Level,
    /// 可选链接，会附在正文后面。
    pub url: Option<String>,
}

/// 通知级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// 普通。
    Info,
    /// 提醒。
    Warn,
    /// 出错。
    Error,
}

impl Level {
    /// 解析级别；不写按 info。
    fn parse(raw: Option<&str>) -> Result<Self> {
        match raw.unwrap_or("info") {
            "info" => Ok(Self::Info),
            "warn" | "warning" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            other => bail!("level 只认 info、warn、error，不认 {other}"),
        }
    }
}

/// 是不是本机地址。
pub fn is_loopback(addr: Option<SocketAddr>) -> bool {
    addr.map(|item| item.ip().is_loopback()).unwrap_or(false)
}

/// 从 JSON 字符串解析一条通知。
pub fn from_json_str(text: &str) -> Result<Notice> {
    let value: Value = serde_json::from_str(text).map_err(|error| anyhow::anyhow!("请求体不是 JSON：{error}"))?;
    from_json(&value)
}

/// 从 JSON 对象解析一条通知。
pub fn from_json(value: &Value) -> Result<Notice> {
    let title = text_field(value, "title", TITLE_MAX)?;
    let body = text_field(value, "body", BODY_MAX)?;
    let level = Level::parse(value.get("level").and_then(Value::as_str))?;
    let url = match value.get("url") {
        None | Some(Value::Null) => None,
        Some(item) => {
            let text = item.as_str().ok_or_else(|| anyhow::anyhow!("url 要写成字符串"))?.trim();
            if text.is_empty() {
                None
            } else if !(text.starts_with("http://") || text.starts_with("https://")) {
                bail!("url 只许 http:// 或 https://");
            } else {
                Some(text.to_string())
            }
        }
    };
    Ok(Notice { title, body, level, url })
}

/// 取非空字符串字段，并限制长度。
fn text_field(value: &Value, name: &str, max: usize) -> Result<String> {
    let text = value.get(name).and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("{name} 要写成非空字符串"))?.trim();
    if text.is_empty() {
        bail!("{name} 要写成非空字符串");
    }
    if text.chars().count() > max {
        bail!("{name} 太长，最多 {max} 字");
    }
    Ok(text.to_string())
}

/// 弹一条普通通知。
pub fn info(title: &str, body: &str) {
    show(&Notice { title: title.to_string(), body: body.to_string(), level: Level::Info, url: None });
}

/// 弹一条出错通知。
pub fn error(title: &str, body: &str) {
    show(&Notice { title: title.to_string(), body: body.to_string(), level: Level::Error, url: None });
}

/// 弹出通知；非 Windows 或弹不出时只在标准错误打一行。
pub fn show(notice: &Notice) {
    let mut body = notice.body.clone();
    if let Some(url) = &notice.url {
        if !body.contains(url) {
            body = format!("{body}\n{url}");
        }
    }
    eprintln!("通知：{} — {body}", notice.title);
    //G 单元测试验证业务和 HTTP 回执，通知内容只写测试日志。
    if cfg!(test) { return; }

    if let Err(error) = show_toast(notice, &body) {
        eprintln!("通知没弹出：{error:#}");
    }
}

/// 真正弹窗的实现。
fn show_toast(notice: &Notice, body: &str) -> Result<()> {
    #[cfg(windows)]
    {
        show_windows(notice, body)
    }
    #[cfg(not(windows))]
    {
        let _ = (notice, body);
        Ok(())
    }
}

/// Windows 右下角通知：先给进程设应用标识再弹 toast；没有安装包标识时 WinRT 会失败，再退到托盘气泡（同样在右下角）。
#[cfg(windows)]
fn show_windows(notice: &Notice, body: &str) -> Result<()> {
    set_app_id();
    if let Err(error) = show_with(APP_ID, notice, body) {
        if let Err(fallback) = show_with(winrt_notification::Toast::POWERSHELL_APP_ID, notice, body) {
            show_balloon(&notice.title, body).map_err(|balloon| anyhow::anyhow!("自己的标识失败（{error}），PowerShell 标识也失败：{fallback}；气泡也失败：{balloon}"))?;
        }
    }
    Ok(())
}

/// 告诉系统这个进程叫什么：没安装包的程序要先设这一项，toast 才认得出。
#[cfg(windows)]
fn set_app_id() {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = std::ffi::OsStr::new(APP_ID).encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

/// 用指定应用标识弹一条 toast。
#[cfg(windows)]
fn show_with(app: &str, notice: &Notice, body: &str) -> std::result::Result<(), winrt_notification::Error> {
    let duration = match notice.level {
        Level::Error => winrt_notification::Duration::Long,
        _ => winrt_notification::Duration::Short,
    };
    winrt_notification::Toast::new(app)
        .title(&notice.title)
        .text1(body)
        .duration(duration)
        .show()
}

/// 没有安装包标识时的退路：托盘右下角气泡。标题和正文走环境变量，避免拼进命令。
#[cfg(windows)]
fn show_balloon(title: &str, body: &str) -> Result<()> {
    let script = "$title=$env:JMBOTS_NOTIFY_TITLE; $body=$env:JMBOTS_NOTIFY_BODY; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(8000,$title,$body,[System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 8; $n.Dispose()";
    //M 起了就返回：气泡自己显示几秒，不要卡住壳子的 HTTP（一次只处理一个请求）。
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("JMBOTS_NOTIFY_TITLE", title)
        .env("JMBOTS_NOTIFY_BODY", body)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| anyhow::anyhow!("起不来 PowerShell：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    #[test]
    fn parses_notice_and_rejects_bad_input() {
        let notice = from_json_str(r#"{"title":"待确认","body":"删一个文件","level":"warn","url":"http://127.0.0.1:15761/"}"#).unwrap();
        assert_eq!(notice.title, "待确认");
        assert_eq!(notice.level, Level::Warn);
        assert_eq!(notice.url.as_deref(), Some("http://127.0.0.1:15761/"));
        assert!(from_json_str(r#"{"title":"","body":"x"}"#).is_err());
        assert!(from_json_str(r#"{"title":"x"}"#).is_err());
        assert!(from_json_str(r#"{"title":"x","body":"y","level":"debug"}"#).is_err());
        assert!(from_json_str(r#"{"title":"x","body":"y","url":"ftp://example.invalid/a"}"#).is_err());
    }

    #[test]
    fn loopback_only() {
        let local = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 12345);
        let other = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 200, 9)), 12345);
        assert!(is_loopback(Some(local)));
        assert!(!is_loopback(Some(other)));
        assert!(!is_loopback(None));
    }
}
