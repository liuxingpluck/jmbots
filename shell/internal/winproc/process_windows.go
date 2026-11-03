//go:build windows

// 本文件管理挂起创建、标准句柄白名单、Job 生命周期，以及显式接管。
package winproc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Options 描述直接创建的可执行文件；不拼接 shell 命令，不继承监听或管道句柄。
type Options struct {
	// Exe 是可执行文件路径；不支持 .cmd/.bat 脚本。
	Exe string
	// Args 不含 argv[0]，每项按 Windows 参数规则分别转义。
	Args []string
	// Dir 是工作目录；为空时继承当前目录。
	Dir string
	// Env 为 nil 时继承环境；非 nil 时作为完整环境。
	Env []string
	// Stdout 是调用方拥有的直接文件句柄；nil 使用 NUL。
	Stdout *os.File
	// Stderr 是调用方拥有的直接文件句柄；nil 使用 NUL。
	Stderr *os.File
}

// Process 持有根进程及专属 Job；Close 只释放本地句柄，不结束进程。
type Process struct {
	mu       sync.Mutex
	identity Identity
	process  syscall.Handle
	job      syscall.Handle
	assigned bool
	closed   bool
}

type startupInfoEx struct {
	syscall.StartupInfo
	Attributes unsafe.Pointer
}

// Start 先挂起创建，再加入未设置 kill-close 的 Job，最后恢复主线程。
func Start(options Options) (_ *Process, resultErr error) {
	exe, err := filepath.Abs(options.Exe)
	if err != nil || options.Exe == "" {
		return nil, fmt.Errorf("可执行文件路径无效")
	}
	if !strings.EqualFold(filepath.Ext(exe), ".exe") {
		return nil, fmt.Errorf("必须直接启动 .exe，禁止经 .cmd/.bat 或 shell 中转")
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return nil, fmt.Errorf("解析可执行文件实路径: %w", err)
	}
	application, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return nil, fmt.Errorf("可执行文件路径含无效字符: %w", err)
	}
	arguments := make([]string, 0, len(options.Args)+1)
	arguments = append(arguments, syscall.EscapeArg(exe))
	for _, argument := range options.Args {
		arguments = append(arguments, syscall.EscapeArg(argument))
	}
	command, err := syscall.UTF16FromString(strings.Join(arguments, " "))
	if err != nil {
		return nil, fmt.Errorf("进程参数含无效字符: %w", err)
	}
	if len(command) > 32767 {
		return nil, fmt.Errorf("进程参数超出 Windows 长度限制")
	}
	var directory *uint16
	if options.Dir != "" {
		absolute, err := filepath.Abs(options.Dir)
		if err != nil {
			return nil, fmt.Errorf("解析工作目录: %w", err)
		}
		directory, err = syscall.UTF16PtrFromString(absolute)
		if err != nil {
			return nil, fmt.Errorf("工作目录含无效字符: %w", err)
		}
	}
	environment, err := environmentBlock(options.Env)
	if err != nil {
		return nil, err
	}
	job, err := newJob()
	if err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, closeHandle(job))
		}
	}()

	//G 与 Go 标准启动路径共用 ForkLock，缩短临时可继承句柄的暴露窗口。
	syscall.ForkLock.Lock()
	defer syscall.ForkLock.Unlock()
	handles, cleanup, err := standardHandles(options.Stdout, options.Stderr)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	attributes, err := handleAttributes(handles)
	if err != nil {
		return nil, err
	}
	defer func() {
		deleteAttribute.Call(uintptr(unsafe.Pointer(&attributes[0])))
		runtime.KeepAlive(attributes)
	}()
	startup := startupInfoEx{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = startUseStdHandles
	startup.StdInput, startup.StdOutput, startup.StdErr = handles[0], handles[1], handles[2]
	startup.Attributes = unsafe.Pointer(&attributes[0])
	var information syscall.ProcessInformation
	flags := uintptr(createSuspended | createNoWindow | createUnicodeEnv | extendedStartupInfo)
	ok, _, callErr := createProcessW.Call(
		uintptr(unsafe.Pointer(application)), uintptr(unsafe.Pointer(&command[0])), 0, 0, 1, flags,
		uintptr(unsafe.Pointer(&environment[0])), uintptr(unsafe.Pointer(directory)),
		uintptr(unsafe.Pointer(&startup)), uintptr(unsafe.Pointer(&information)),
	)
	runtime.KeepAlive(application)
	runtime.KeepAlive(command)
	runtime.KeepAlive(environment)
	runtime.KeepAlive(directory)
	runtime.KeepAlive(attributes)
	runtime.KeepAlive(handles)
	if ok == 0 {
		return nil, nativeError("挂起创建进程", callErr)
	}
	defer closeHandle(information.Thread)
	//G 失败清理由 CreateProcess 直接返回的句柄定位，挂起期间不按 PID 再打开。
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, syscall.TerminateProcess(information.Process, 1))
			_, waitErr := syscall.WaitForSingleObject(information.Process, 5000)
			resultErr = errors.Join(resultErr, waitErr, closeHandle(information.Process))
		}
	}()
	identity, err := inspectHandle(information.Process)
	if err != nil {
		return nil, err
	}
	if identity.PID != information.ProcessId || !strings.EqualFold(normalizeImagePath(identity.Path), normalizeImagePath(exe)) {
		return nil, ErrIdentity
	}
	if err := assignJob(job, information.Process); err != nil {
		return nil, err
	}
	owned, err := inJob(information.Process, job)
	if err != nil || !owned {
		return nil, errors.Join(ErrUnowned, err)
	}
	previous, _, callErr := resumeThread.Call(uintptr(information.Thread))
	if uint32(previous) == ^uint32(0) {
		return nil, nativeError("恢复进程主线程", callErr)
	}
	return &Process{identity: identity, process: information.Process, job: job, assigned: true}, nil
}

// Identity 返回创建或接管时从同一内核句柄取得的身份副本。
func (process *Process) Identity() Identity {
	if process == nil {
		return Identity{}
	}
	return process.identity
}

// Alive 检查根进程是否仍在运行；根退出不代表 Job 内没有后代。
func (process *Process) Alive() (bool, error) {
	if process == nil {
		return false, ErrClosed
	}
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.closed {
		return false, ErrClosed
	}
	exited, err := processExited(process.process)
	return !exited && err == nil, err
}

// Wait 等待根进程并返回退出码；取消等待不终止进程，Close 可中断等待。
func (process *Process) Wait(ctx context.Context) (uint32, error) {
	if ctx == nil {
		return 0, fmt.Errorf("等待上下文不可为空")
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if process == nil {
			return 0, ErrClosed
		}
		process.mu.Lock()
		if process.closed {
			process.mu.Unlock()
			return 0, ErrClosed
		}
		exited, err := processExited(process.process)
		var code uint32
		if err == nil && exited {
			err = syscall.GetExitCodeProcess(process.process, &code)
		}
		process.mu.Unlock()
		if err != nil || exited {
			return code, err
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-ticker.C:
		}
	}
}

// Stop 核验根身份与 Job 后终止整个 Job，并在 timeout 内等待活跃成员归零。
// 根已退出时仍使用原始根句柄和原始 Job，不重新打开可能复用的 PID。
func (process *Process) Stop(timeout time.Duration) error {
	if process == nil {
		return ErrClosed
	}
	if timeout < 0 {
		return fmt.Errorf("停止超时不可为负数")
	}
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.closed {
		return ErrClosed
	}
	if !process.assigned || process.job == 0 {
		return ErrUnowned
	}
	exited, err := processExited(process.process)
	if err != nil {
		return err
	}
	if !exited {
		if err := validateHandle(process.process, process.identity); err != nil {
			//G 查询映像路径期间根可能刚退出；仅允许在原句柄已 signaled 时走退出校验。
			exited, waitErr := processExited(process.process)
			if waitErr != nil || !exited {
				return errors.Join(err, waitErr)
			}
			if err := validateExitedHandle(process.process, process.identity); err != nil {
				return err
			}
		} else {
			owned, err := inJob(process.process, process.job)
			if err != nil || !owned {
				//G 只有退出竞态可复用本对象持有的、已确认归属的原始 Job。
				exited, waitErr := processExited(process.process)
				if waitErr != nil || !exited {
					return errors.Join(ErrUnowned, err, waitErr)
				}
				if err := validateExitedHandle(process.process, process.identity); err != nil {
					return err
				}
			}
		}
	} else if err := validateExitedHandle(process.process, process.identity); err != nil {
		return err
	}
	//M 根退出会从 Job 活跃列表消失；assigned 仅在同一内核句柄核验成功后设置。
	if _, err := activeJobProcesses(process.job); err != nil {
		return err
	}
	ok, _, callErr := terminateJobObject.Call(uintptr(process.job), 1)
	if ok == 0 {
		return nativeError("终止已核验 Job", callErr)
	}
	deadline := time.Now().Add(timeout)
	for {
		count, err := activeJobProcesses(process.job)
		if err != nil {
			return err
		}
		rootExited, err := processExited(process.process)
		if err != nil {
			return err
		}
		if count == 0 && rootExited {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("等待 Job 清空超时，活跃成员=%d，根已退出=%t", count, rootExited)
		}
		if remaining > 20*time.Millisecond {
			remaining = 20 * time.Millisecond
		}
		time.Sleep(remaining)
	}
}

func activeJobProcesses(job syscall.Handle) (uint32, error) {
	var accounting struct {
		TotalUserTime             int64
		TotalKernelTime           int64
		ThisPeriodTotalUserTime   int64
		ThisPeriodTotalKernelTime int64
		TotalPageFaultCount       uint32
		TotalProcesses            uint32
		ActiveProcesses           uint32
		TotalTerminatedProcesses  uint32
	}
	ok, _, err := queryInformationJob.Call(uintptr(job), 1, uintptr(unsafe.Pointer(&accounting)), unsafe.Sizeof(accounting), 0)
	if ok == 0 {
		return 0, nativeError("查询 Job 活跃成员", err)
	}
	return accounting.ActiveProcesses, nil
}

// Close 幂等关闭本对象持有的句柄；不会终止根进程或后代，也不关闭调用方日志文件。
func (process *Process) Close() error {
	if process == nil {
		return nil
	}
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.closed {
		return nil
	}
	process.closed = true
	err := errors.Join(closeHandle(process.process), closeHandle(process.job))
	process.process, process.job = 0, 0
	return err
}

// Adopt 在调用方已核验 confirm=yes 后接管指定身份；本函数仍独立核验命令行与完整身份。
// 不追溯接管前已有子孙，现有 Job 不兼容或命令行无法核实时直接拒绝。
func Adopt(identity Identity) (_ *Process, resultErr error) {
	handle, err := openIdentityProcess(identity.PID, processQueryLimited|processQueryInformation|processSetQuota|processTerminate|synchronize)
	if err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, closeHandle(handle))
		}
	}()
	if err := validateHandle(handle, identity); err != nil {
		return nil, err
	}
	command, err := processCommandLine(handle)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(strings.ToLower(command), "jmbots") {
		return nil, fmt.Errorf("拒绝接管：命令行不包含 jmbots")
	}
	exited, err := processExited(handle)
	if err != nil || exited {
		return nil, errors.Join(fmt.Errorf("拒绝接管：进程已退出或状态不可验证"), err)
	}
	job, err := newJob()
	if err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, closeHandle(job))
		}
	}()
	//G 同一句柄再次确认三元身份后才产生接管副作用。
	if err := validateHandle(handle, identity); err != nil {
		return nil, err
	}
	if err := assignJob(job, handle); err != nil {
		return nil, err
	}
	owned, err := inJob(handle, job)
	if err != nil || !owned {
		return nil, errors.Join(ErrUnowned, err)
	}
	return &Process{identity: identity, process: handle, job: job, assigned: true}, nil
}

// KillOwned 仅供测试强杀本进程直接创建的壳子；不按端口或名称定位目标。
// 除完整身份外，还核验直接父 PID 和父子创建时间，拒绝终止任意外部身份。
func KillOwned(identity Identity) error {
	handle, err := openIdentityProcess(identity.PID, processQueryLimited|processQueryInformation|processTerminate|synchronize)
	if err != nil {
		return err
	}
	defer closeHandle(handle)
	if err := validateHandle(handle, identity); err != nil {
		return err
	}
	parent, err := parentPID(handle)
	if err != nil {
		return err
	}
	self, err := inspectHandle(currentProcessHandle())
	if err != nil {
		return err
	}
	if parent != self.PID || identity.PID == self.PID || identity.Created < self.Created {
		return fmt.Errorf("%w: 测试强杀仅允许本进程直接创建的目标", ErrUnowned)
	}
	if err := validateHandle(handle, identity); err != nil {
		return err
	}
	return syscall.TerminateProcess(handle, 1)
}

func standardHandles(stdout, stderr *os.File) ([]syscall.Handle, func(), error) {
	var handles []syscall.Handle
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			for _, handle := range handles {
				closeHandle(handle)
			}
		})
	}
	files := []*os.File{nil, stdout, stderr}
	for index, file := range files {
		var source syscall.Handle
		if file == nil {
			access := uint32(syscall.GENERIC_WRITE)
			if index == 0 {
				access = syscall.GENERIC_READ
			}
			name, _ := syscall.UTF16PtrFromString("NUL")
			var err error
			source, err = syscall.CreateFile(name, access, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
			if err != nil {
				cleanup()
				return nil, nil, fmt.Errorf("打开标准句柄 NUL: %w", err)
			}
		} else {
			source = syscall.Handle(file.Fd())
			kind, err := syscall.GetFileType(source)
			if err != nil || (kind != fileTypeDisk && kind != fileTypeChar) {
				cleanup()
				return nil, nil, errors.Join(fmt.Errorf("标准输出必须是直接文件句柄，禁止管道"), err)
			}
		}
		var duplicate syscall.Handle
		err := syscall.DuplicateHandle(currentProcessHandle(), source, currentProcessHandle(), &duplicate, 0, true, duplicateSameAccess)
		runtime.KeepAlive(file)
		if file == nil {
			closeHandle(source)
		}
		if err != nil {
			cleanup()
			return nil, nil, fmt.Errorf("复制标准句柄: %w", err)
		}
		handles = append(handles, duplicate)
	}
	return handles, cleanup, nil
}

func handleAttributes(handles []syscall.Handle) ([]uintptr, error) {
	var size uintptr
	ok, _, callErr := initializeAttribute.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if ok != 0 || callErr != syscall.ERROR_INSUFFICIENT_BUFFER || size == 0 || size > 1024*1024 {
		return nil, nativeError("计算标准句柄白名单长度", callErr)
	}
	words := make([]uintptr, (size+unsafe.Sizeof(uintptr(0))-1)/unsafe.Sizeof(uintptr(0)))
	pointer := unsafe.Pointer(&words[0])
	ok, _, callErr = initializeAttribute.Call(uintptr(pointer), 1, 0, uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return nil, nativeError("初始化标准句柄白名单", callErr)
	}
	ok, _, callErr = updateAttribute.Call(uintptr(pointer), 0, attributeHandleList, uintptr(unsafe.Pointer(&handles[0])), uintptr(len(handles))*unsafe.Sizeof(handles[0]), 0, 0)
	if ok == 0 {
		deleteAttribute.Call(uintptr(pointer))
		return nil, nativeError("设置仅继承标准句柄", callErr)
	}
	runtime.KeepAlive(handles)
	runtime.KeepAlive(words)
	return words, nil
}

func environmentBlock(values []string) ([]uint16, error) {
	if values == nil {
		values = os.Environ()
	}
	//M Windows 环境名不区分大小写；重复项以最后一项为准。
	unique := make(map[string]string, len(values))
	for _, value := range values {
		index := strings.IndexByte(value, '=')
		if index == 0 {
			// Windows 可携带 =C:=... 一类驱动器当前目录变量。
			index = strings.IndexByte(value[1:], '=')
			if index >= 0 {
				index++
			}
		}
		if index <= 0 || strings.IndexByte(value, 0) >= 0 {
			return nil, fmt.Errorf("环境变量格式无效（不回显内容）")
		}
		unique[strings.ToUpper(value[:index])] = value
	}
	keys := make([]string, 0, len(unique))
	for key := range unique {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var block []uint16
	for _, key := range keys {
		encoded, err := syscall.UTF16FromString(unique[key])
		if err != nil {
			return nil, fmt.Errorf("环境变量编码失败（不回显内容）")
		}
		block = append(block, encoded...)
	}
	block = append(block, 0)
	if len(block) == 1 {
		block = append(block, 0)
	}
	return block, nil
}
