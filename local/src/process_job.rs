//! Windows Job：壳子进入作业以后所有后代自动继承；最后一个句柄关闭时整棵树一起退出。
//! 不允许 BREAKAWAY，不继承 Job 句柄；强杀壳子也不会留下子进程。
#[cfg(windows)]
pub struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessJob {
    pub fn new() -> anyhow::Result<Self> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::{JobObjects::*, Threading::GetCurrentProcess}};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            anyhow::ensure!(!handle.is_null(), "CreateJobObjectW: {}", std::io::Error::last_os_error());
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0
                || AssignProcessToJobObject(handle, GetCurrentProcess()) == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                anyhow::bail!("无法启用 Job 子进程保护：{error}");
            }
            Ok(Self(handle))
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } } }
#[cfg(not(windows))]
pub struct ProcessJob;
#[cfg(not(windows))]
impl ProcessJob { pub fn new() -> anyhow::Result<Self> { Ok(Self) } }
