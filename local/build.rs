//! 编译前的准备：tauri-build 读 tauri.conf.json，把图标和清单写进 exe，把 ui/ 里的本地页面打包进程序。
//!
//! 清单 windows/app.manifest（只写 ASCII）：
//!   1. Common-Controls 6：和 Tauri 默认清单一样（系统对话框的样式）。
//!   2. consoleAllocationPolicy=detached：程序按控制台程序编译（终端里跑 check、search 时 PowerShell 会等它结束、输出正常），
//!      双击打开时系统不再给它开黑框。要 Windows 11 24H2（26100）起；更早的系统不认这一项，图形模式自己放掉黑框（console.rs）。
//!      说明：https://learn.microsoft.com/windows/console/console-allocation-policy
//!   注意：application 元素必须在 asm.v3 命名空间里（和 dpiAware 那些设置一样）。照微软那页的写法放在 asm.v1 里，
//!   Windows 报“应用程序的并行配置不正确”（14001），程序起不来（11-05 实测）。
fn main() {
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows/app.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build 没过（看上面的报错）");
}
