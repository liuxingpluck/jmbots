//go:build windows

// winproc 封装 Windows 原生进程、Job、监听归属与私有文件权限；不经命令解释器。
package winproc

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

var (
	// ErrClosed 表示进程或互斥量的本地句柄已关闭。
	ErrClosed = errors.New("Windows 对象句柄已关闭")
	// ErrLocked 表示同名互斥量仍有持有者。
	ErrLocked = errors.New("同名互斥量已被占用")
	// ErrIdentity 表示 PID、创建时间或映像路径不匹配。
	ErrIdentity = errors.New("进程身份不匹配")
	// ErrUnowned 表示无法证明目标属于本对象持有的 Job。
	ErrUnowned = errors.New("无法确认进程归属")
)

const (
	processTerminate        = 0x0001
	processSetQuota         = 0x0100
	processQueryInformation = 0x0400
	processQueryLimited     = 0x1000
	synchronize             = 0x00100000
	createSuspended         = 0x00000004
	createUnicodeEnv        = 0x00000400
	extendedStartupInfo     = 0x00080000
	createNoWindow          = 0x08000000
	startUseStdHandles      = 0x00000100
	attributeHandleList     = 0x00020002
	duplicateSameAccess     = 0x00000002
	waitObject0             = 0
	waitTimeout             = 258
	fileTypeDisk            = 1
	fileTypeChar            = 2
	fileReadAttributes      = 0x00000080
	readControl             = 0x00020000
	writeDAC                = 0x00040000
	fileFlagOpenReparse     = 0x00200000
	fileFlagBackupSemantics = 0x02000000
	fileAttributeReparse    = 0x00000400
	fileAttributeDirectory  = 0x00000010
	protectedDACL           = 0x80000000
	daclSecurityInfo        = 0x00000004
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")
	ntdll    = syscall.NewLazyDLL("ntdll.dll")
	iphlpapi = syscall.NewLazyDLL("iphlpapi.dll")

	createProcessW         = kernel32.NewProc("CreateProcessW")
	createJobObjectW       = kernel32.NewProc("CreateJobObjectW")
	assignProcessToJob     = kernel32.NewProc("AssignProcessToJobObject")
	isProcessInJobProc     = kernel32.NewProc("IsProcessInJob")
	terminateJobObject     = kernel32.NewProc("TerminateJobObject")
	queryInformationJob    = kernel32.NewProc("QueryInformationJobObject")
	resumeThread           = kernel32.NewProc("ResumeThread")
	getProcessID           = kernel32.NewProc("GetProcessId")
	queryProcessImage      = kernel32.NewProc("QueryFullProcessImageNameW")
	initializeAttribute    = kernel32.NewProc("InitializeProcThreadAttributeList")
	updateAttribute        = kernel32.NewProc("UpdateProcThreadAttribute")
	deleteAttribute        = kernel32.NewProc("DeleteProcThreadAttributeList")
	createMutexW           = kernel32.NewProc("CreateMutexW")
	getExtendedTCPTable    = iphlpapi.NewProc("GetExtendedTcpTable")
	ntQueryInformationProc = ntdll.NewProc("NtQueryInformationProcess")
	localFree              = kernel32.NewProc("LocalFree")
	openProcessToken       = advapi32.NewProc("OpenProcessToken")
	getTokenInformation    = advapi32.NewProc("GetTokenInformation")
	convertSIDToString     = advapi32.NewProc("ConvertSidToStringSidW")
	convertSDDL            = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	getDescriptorDACL      = advapi32.NewProc("GetSecurityDescriptorDacl")
	getDescriptorControl   = advapi32.NewProc("GetSecurityDescriptorControl")
	getSecurityInfo        = advapi32.NewProc("GetSecurityInfo")
	setSecurityInfo        = advapi32.NewProc("SetSecurityInfo")
	isValidACL             = advapi32.NewProc("IsValidAcl")
)

// nativeError 为返回零但未提供错误码的 Win32 调用保留失败语义。
func nativeError(operation string, err error) error {
	if err == nil || err == syscall.Errno(0) {
		err = syscall.EINVAL
	}
	return fmt.Errorf("%s失败: %w", operation, err)
}

func closeHandle(handle syscall.Handle) error {
	if handle == 0 || handle == syscall.InvalidHandle {
		return nil
	}
	return syscall.CloseHandle(handle)
}

func currentProcessHandle() syscall.Handle {
	return syscall.Handle(^uintptr(0))
}

func inJob(process, job syscall.Handle) (bool, error) {
	var inside int32
	ok, _, err := isProcessInJobProc.Call(uintptr(process), uintptr(job), uintptr(unsafe.Pointer(&inside)))
	if ok == 0 {
		return false, nativeError("核验 Job 成员", err)
	}
	return inside != 0, nil
}

func newJob() (syscall.Handle, error) {
	//G 新建匿名 Job，不设置任何限制标志，特别是不设置 KILL_ON_JOB_CLOSE。
	handle, _, err := createJobObjectW.Call(0, 0)
	if handle == 0 {
		return 0, nativeError("创建 Job", err)
	}
	return syscall.Handle(handle), nil
}

func assignJob(job, process syscall.Handle) error {
	ok, _, err := assignProcessToJob.Call(uintptr(job), uintptr(process))
	if ok == 0 {
		return nativeError("加入 Job（现有 Job 可能不兼容）", err)
	}
	return nil
}

func processExited(handle syscall.Handle) (bool, error) {
	status, err := syscall.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, fmt.Errorf("检查进程退出状态: %w", err)
	}
	switch status {
	case waitObject0:
		return true, nil
	case waitTimeout:
		return false, nil
	default:
		return false, fmt.Errorf("未知进程等待状态: %d", status)
	}
}
