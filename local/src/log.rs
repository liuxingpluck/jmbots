//! 壳子自己的日志：窗口模式没有控制台，出了错（接口起不来、窗口开不出来）写进运行时 data/local.log，同时也打到 stderr。
//! 只记壳子自己的事，不记配置内容和密钥。

use crate::config::Settings;
use std::io::Write;

/// 记一行。
///
/// 输入：配置（日志放在它的运行时目录下）、要记的话。副作用：往 <运行时>/data/local.log 末尾加一行（目录不在就建）；写不进去就算了。
pub fn line(settings: &Settings, text: &str) {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
    eprintln!("{text}");
    let dir = settings.runtime.join("data").join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("local.log")) {
        let _ = writeln!(file, "[{stamp}] {text}");
    }
}
