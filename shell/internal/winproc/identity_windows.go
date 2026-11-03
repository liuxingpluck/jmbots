//go:build windows

// 本文件以持有的内核进程句柄核验 PID、映像路径和创建时间，拒绝仅凭 PID 动手。
package winproc

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// Identity 是可持久化的进程身份；Created 为 Windows FILETIME 的原始 100ns 计数。
type Identity struct {
	// PID 是进程标识，不能单独作为终止依据。
	PID uint32 `json:"pid"`
	// Created 是创建时间，用于防止 PID 复用。
	Created uint64 `json:"created"`
	// Path 是 Windows 报告的绝对映像路径。
	Path string `json:"path"`
}

// Inspect 只查询指定 PID，不枚举进程，也不读取命令行。
func Inspect(pid uint32) (Identity, error) {
	handle, err := openIdentityProcess(pid, processQueryLimited)
	if err != nil {
		return Identity{}, err
	}
	defer closeHandle(handle)
	return inspectHandle(handle)
}

// Validate 重新打开并比较完整身份，不终止或接管进程。
func Validate(identity Identity) error {
	handle, err := openIdentityProcess(identity.PID, processQueryLimited)
	if err != nil {
		return err
	}
	defer closeHandle(handle)
	return validateHandle(handle, identity)
}

func openIdentityProcess(pid uint32, access uint32) (syscall.Handle, error) {
	//G 系统/空 PID 不是本包允许管理的目标。
	if pid == 0 || pid == 4 {
		return 0, fmt.Errorf("%w: 拒绝系统或空 PID", ErrIdentity)
	}
	handle, err := syscall.OpenProcess(access, false, pid)
	if err != nil {
		return 0, fmt.Errorf("打开指定进程 %d: %w", pid, err)
	}
	return handle, nil
}

func inspectHandle(handle syscall.Handle) (Identity, error) {
	pid, _, err := getProcessID.Call(uintptr(handle))
	if pid == 0 {
		return Identity{}, nativeError("查询进程 PID", err)
	}
	var created, exited, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return Identity{}, fmt.Errorf("查询进程创建时间: %w", err)
	}
	//M Windows 完整路径有界读取；不调用命令解释器、不扫描其他进程。
	path := make([]uint16, 32768)
	length := uint32(len(path))
	ok, _, err := queryProcessImage.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&path[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		return Identity{}, nativeError("查询进程映像路径", err)
	}
	if length == 0 || length >= uint32(len(path)) {
		return Identity{}, fmt.Errorf("进程映像路径长度无效")
	}
	return Identity{
		PID:     uint32(pid),
		Created: uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime),
		Path:    filepath.Clean(syscall.UTF16ToString(path[:length])),
	}, nil
}

func validateHandle(handle syscall.Handle, expected Identity) error {
	if expected.PID == 0 || expected.Created == 0 || !filepath.IsAbs(expected.Path) {
		return fmt.Errorf("%w: 缺少完整身份", ErrIdentity)
	}
	actual, err := inspectHandle(handle)
	if err != nil {
		return err
	}
	if !sameIdentity(actual, expected) {
		return ErrIdentity
	}
	return nil
}

// validateExitedHandle 仅由已持有原始句柄的 Process.Stop 使用。
// 已退出进程在部分 Windows 版本上无法再查询映像路径，但句柄仍固定同一内核对象。
// 路径必须沿用 Start/Adopt 在存活时已完整核验的不可变身份，不能用于重新打开的 PID。
func validateExitedHandle(handle syscall.Handle, expected Identity) error {
	if expected.PID == 0 || expected.Created == 0 || !filepath.IsAbs(expected.Path) {
		return fmt.Errorf("%w: 缺少原始完整身份", ErrIdentity)
	}
	exited, err := processExited(handle)
	if err != nil || !exited {
		return fmt.Errorf("%w: 已退出根句柄状态无法确认", ErrIdentity)
	}
	pid, _, callErr := getProcessID.Call(uintptr(handle))
	if pid == 0 {
		return nativeError("核验已退出根进程 PID", callErr)
	}
	var created, exitTime, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(handle, &created, &exitTime, &kernel, &user); err != nil {
		return fmt.Errorf("核验已退出根进程创建时间: %w", err)
	}
	creation := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	if uint32(pid) != expected.PID || creation != expected.Created {
		return ErrIdentity
	}
	return nil
}

func sameIdentity(a, b Identity) bool {
	return a.PID == b.PID && a.Created != 0 && a.Created == b.Created &&
		strings.EqualFold(normalizeImagePath(a.Path), normalizeImagePath(b.Path))
}

func normalizeImagePath(path string) string {
	path = strings.ReplaceAll(path, "/", `\`)
	if strings.HasPrefix(strings.ToLower(path), `\\?\unc\`) {
		path = `\\` + path[8:]
	} else if strings.HasPrefix(path, `\\?\`) {
		path = path[4:]
	}
	return filepath.Clean(path)
}

// processCommandLine 仅用于显式接管；不回显命令行，失败时拒绝接管。
func processCommandLine(handle syscall.Handle) (string, error) {
	if err := ntQueryInformationProc.Find(); err != nil {
		return "", fmt.Errorf("系统不支持安全查询接管命令行: %w", err)
	}
	const commandLineInformation = 60
	const lengthMismatch = 0xc0000004
	const bufferTooSmall = 0xc0000023
	const bufferOverflow = 0x80000005
	var needed uint32
	status, _, _ := ntQueryInformationProc.Call(uintptr(handle), commandLineInformation, 0, 0, uintptr(unsafe.Pointer(&needed)))
	if uint32(status) != lengthMismatch && uint32(status) != bufferTooSmall && uint32(status) != bufferOverflow {
		return "", fmt.Errorf("查询接管命令行长度失败: NTSTATUS 0x%08x", uint32(status))
	}
	if needed < uint32(unsafe.Sizeof(unicodeString{})) || needed > 1024*1024 {
		return "", fmt.Errorf("接管命令行长度超出安全边界")
	}
	//M 用机器字切片保证 UNICODE_STRING 指针字段按本机位宽对齐。
	words := make([]uintptr, (int(needed)+int(unsafe.Sizeof(uintptr(0)))-1)/int(unsafe.Sizeof(uintptr(0))))
	base := unsafe.Pointer(&words[0])
	status, _, _ = ntQueryInformationProc.Call(uintptr(handle), commandLineInformation, uintptr(base), uintptr(needed), uintptr(unsafe.Pointer(&needed)))
	if uint32(status) != 0 {
		return "", fmt.Errorf("查询接管命令行失败: NTSTATUS 0x%08x", uint32(status))
	}
	value := (*unicodeString)(base)
	capacity := uintptr(len(words)) * unsafe.Sizeof(uintptr(0))
	start := uintptr(base)
	if value.Length == 0 || value.Length%2 != 0 || value.Length > value.MaximumLength ||
		value.Buffer < start || value.Buffer-start > capacity || uintptr(value.Length) > capacity-(value.Buffer-start) {
		return "", fmt.Errorf("接管命令行缓冲区无效")
	}
	//G 用已验证的偏移在 Go 缓冲区内取值，不追随外部地址。
	chars := unsafe.Slice((*uint16)(unsafe.Add(base, value.Buffer-start)), int(value.Length)/2)
	result := syscall.UTF16ToString(chars)
	runtime.KeepAlive(words)
	return result, nil
}

type unicodeString struct {
	Length        uint16
	MaximumLength uint16
	Buffer        uintptr
}

// parentPID 仅查询指定进程的基本信息，不遍历系统进程表。
func parentPID(handle syscall.Handle) (uint32, error) {
	var info struct {
		ExitStatus uintptr
		PEB        uintptr
		Affinity   uintptr
		Priority   uintptr
		PID        uintptr
		ParentPID  uintptr
	}
	var returned uint32
	status, _, _ := ntQueryInformationProc.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), uintptr(unsafe.Pointer(&returned)))
	if uint32(status) != 0 || returned < uint32(unsafe.Sizeof(info)) {
		return 0, fmt.Errorf("查询直接父进程失败: NTSTATUS 0x%08x", uint32(status))
	}
	return uint32(info.ParentPID), nil
}
