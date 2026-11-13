//! 开机自启（docs/界面/02_一个程序跑起来的规划.md 第 5 步）：Windows“启动”文件夹里放一个 jmbots.lnk，带 --tray，
//! 登录时只起托盘和后端、不开窗口。不建计划任务（用户 10-31）。开关在设置页，不写进 config.yaml：快捷方式在不在就是开没开。

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use std::process::Command;

/// 快捷方式的文件名。
const LINK_NAME: &str = "jmbots.lnk";

/// 快捷方式的路径（APPDATA 下的“启动”文件夹）。
///
/// 输出：路径；没有 APPDATA 环境变量时报错。
fn link_path() -> Result<PathBuf> {
    let app_data = std::env::var_os("APPDATA").context("没有 APPDATA 环境变量，不知道启动文件夹在哪")?;
    Ok(PathBuf::from(app_data).join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("Startup").join(LINK_NAME))
}

/// 开机自启开着没有。
pub fn enabled() -> bool {
    link_path().map(|link| link.is_file()).unwrap_or(false)
}

/// 打开或关掉开机自启。
///
/// 输入：true 打开，false 关掉。输出：做成没有。
/// 副作用：在启动文件夹建或删快捷方式；建的时候跑一次 PowerShell（路径走环境变量，中文和空格不用转义）。
pub fn set(on: bool) -> Result<()> {
    let link = link_path()?;
    if !on {
        if link.exists() {
            std::fs::remove_file(&link).with_context(|| format!("删不了 {}", link.display()))?;
        }
        return Ok(());
    }
    if let Some(dir) = link.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("建不了 {}", dir.display()))?;
    }
    let exe = std::env::current_exe().context("不知道程序自己在哪")?;
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:JMBOTS_LINK); $s.TargetPath = $env:JMBOTS_TARGET; $s.Arguments = '--tray'; $s.WorkingDirectory = $env:JMBOTS_WORKDIR; $s.Save()",
        ])
        .env("JMBOTS_LINK", &link)
        .env("JMBOTS_TARGET", &exe)
        .env("JMBOTS_WORKDIR", exe.parent().unwrap_or(&exe));
    crate::supervisor::hide_window(&mut command);
    let output = command.output().context("起不了 PowerShell")?;
    if !output.status.success() || !link.is_file() {
        bail!("快捷方式没建成：{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_dir;
    use std::ffi::OsString;

    /// 测试结束把 APPDATA 恢复原样。
    struct AppDataGuard(Option<OsString>);

    impl Drop for AppDataGuard {
        fn drop(&mut self) {
            // SAFETY: 测试临时改过 APPDATA，这里恢复原值；本仓库没有别的测试读它。
            unsafe {
                match &self.0 {
                    Some(value) => std::env::set_var("APPDATA", value),
                    None => std::env::remove_var("APPDATA"),
                }
            }
        }
    }

    #[test]
    fn set_creates_and_removes_shortcut() {
        // 临时 APPDATA。
        let app_data = temp_dir("autostart");
        // 原来的 APPDATA，测试结束由 guard 放回去。
        let old = std::env::var_os("APPDATA");
        let _guard = AppDataGuard(old);
        // SAFETY: 这一项测试独占 APPDATA 的读写，结束后 guard 恢复原值。
        unsafe {
            std::env::set_var("APPDATA", &app_data);
        }
        //M 快捷方式在 APPDATA 的“启动”文件夹里。
        // 快捷方式路径。
        let link = app_data.join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("Startup").join(LINK_NAME);
        assert!(!enabled());
        set(true).expect("建快捷方式");
        assert!(enabled());
        assert!(link.is_file());
        set(false).expect("删快捷方式");
        assert!(!enabled());
        assert!(!link.exists());
    }
}
