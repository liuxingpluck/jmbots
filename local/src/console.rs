//! 控制台（docs/界面/01_界面设计.md 第 4.1 节）：jmbots.exe 按控制台程序编译——终端里跑 check、search 时 PowerShell 会等它结束、输出正常；
//! 双击打开时，清单里的 consoleAllocationPolicy=detached（Windows 11 24H2 起）让系统不开黑框。
//! 更早的系统不认那一项，双击时系统会替我们开一个黑框：图形模式下只有我们一个进程挂在上面时，就把它放掉（会闪一下）。

/// 图形模式时，把系统替我们新开的控制台放掉；从终端里开窗口（终端还挂着）、或者根本没有控制台时什么也不做。
///
/// 副作用：Windows 上可能调 FreeConsole。别的系统什么也不做。
pub fn release_if_alone() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleProcessList};
        let mut processes = [0u32; 2];
        // SAFETY: 缓冲区 2 个元素，长度如实传进去；只查控制台上挂着几个进程、必要时放掉，不碰别的内存。
        unsafe {
            if GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) == 1 {
                FreeConsole();
            }
        }
    }
}
