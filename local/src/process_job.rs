//! Windows 作业管理后端进程树。基地持有外层作业，每次启动主站再持有一个专用作业。

use std::process::{Child, Command};

use anyhow::{Context, Result};

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::*;

#[cfg(windows)]
pub struct ProcessJob(OwnedHandle);

#[cfg(windows)]
impl ProcessJob {
    /// 基地在启动任何子进程之前进入外层作业。
    pub fn new() -> Result<Self> {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let job = Self::create()?;
        let process = unsafe { GetCurrentProcess() };
        job.assign(process).context("无法启用基地 Job 保护")?;
        Ok(job)
    }

    fn create() -> Result<Self> {
        //M 用非继承句柄。关闭作业时回收作业内的进程，后代也留在作业内。
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error()).context("创建 Job 失败");
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of_val(&limits) as u32;
        let ready = unsafe {
            SetInformationJobObject(job.0.as_raw_handle(), JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _, size)
        };
        if ready == 0 {
            return Err(std::io::Error::last_os_error()).context("设置 Job 回收规则失败");
        }
        Ok(job)
    }

    fn assign(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        let assigned = unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) };
        if assigned == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn terminate(&self) -> std::io::Result<()> {
        let requested = unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) };
        if requested == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn is_empty(&self) -> std::io::Result<bool> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as u32;
        let read = unsafe {
            QueryInformationJobObject(self.0.as_raw_handle(), JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _, size, std::ptr::null_mut())
        };
        if read == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(info.ActiveProcesses == 0)
    }
}

#[cfg(not(windows))]
pub struct ProcessJob;
#[cfg(not(windows))]
impl ProcessJob {
    pub fn new() -> Result<Self> { Ok(Self) }
}

/// 基地拉起的一个主站实例，根进程退出后仍能按作业回收其后代。
pub(crate) struct JobChild {
    pub(crate) child: Child,
    #[cfg(windows)]
    job: ProcessJob,
}

impl JobChild {
    pub(crate) fn spawn(command: &mut Command) -> Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

            let job = ProcessJob::create()?;
            //M 先挂起进程，等纳入自己的作业再启动，避免子进程抢在 Job 分配之前建立。
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            let mut child = command.spawn()?;
            let started = job.assign(child.as_raw_handle())
                .context("无法将后端分配到专用 Job")
                .and_then(|()| resume_initial_thread(child.id()));
            if let Err(error) = started {
                //G 启动未完成时回收仍挂起的实例，不留下悬挂进程或占用的可执行文件。
                let _ = job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            let child = command.spawn().context("启动后端进程失败")?;
            Ok(Self { child })
        }
    }

    pub(crate) fn terminate(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            self.job.terminate()
        }
        #[cfg(not(windows))]
        {
            if self.child.try_wait()?.is_some() {
                return Ok(());
            }
            self.child.kill()
        }
    }

    pub(crate) fn drained(&mut self) -> std::io::Result<bool> {
        if self.child.try_wait()?.is_none() {
            return Ok(false);
        }
        #[cfg(windows)]
        {
            self.job.is_empty()
        }
        #[cfg(not(windows))]
        {
            Ok(true)
        }
    }
}

/// 标准库保存进程句柄。挂起启动的后端只有一个初始线程，从快照找到它再恢复。
#[cfg(windows)]
fn resume_initial_thread(pid: u32) -> Result<()> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error()).context("读取后端初始线程列表失败");
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(std::io::Error::last_os_error()).context("打开后端初始线程失败");
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
            if previous == u32::MAX {
                return Err(std::io::Error::last_os_error()).context("恢复后端初始线程失败");
            }
            anyhow::ensure!(previous == 1, "后端初始线程的挂起次数异常：{previous}");
            return Ok(());
        }
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    anyhow::bail!("后端没有可恢复的初始线程，PID {pid}")
}
