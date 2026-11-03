//go:build windows

// 本文件用 Local 命名互斥量的句柄生命周期实现互斥，避免 Windows 线程归属陷阱。
package winproc

import (
	"crypto/sha256"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// Name 按目录实路径、大小写与用途生成确定的 Local 名称，不暴露目录文本。
// 无法解析实路径时回退规范绝对路径；调用方应先建立 home 再获取锁。
func Name(home, kind string) string {
	absolute, err := filepath.Abs(home)
	if err != nil {
		absolute = filepath.Clean(home)
	}
	if real, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = real
	}
	canonical := strings.ToLower(normalizeImagePath(absolute))
	digest := sha256.Sum256([]byte(canonical + "\x00" + strings.ToLower(strings.TrimSpace(kind))))
	return fmt.Sprintf(`Local\jmbots-shell-%x`, digest[:])
}

// Lock 原子创建命名互斥量；ERROR_ALREADY_EXISTS 表示占用，Close 即释放。
// initialOwner=false，不调用 WaitForSingleObject/ReleaseMutex，不绑定任一 OS 线程。
func Lock(name string) (io.Closer, error) {
	if !strings.HasPrefix(name, `Local\`) || len(name) <= len(`Local\`) || len(name) > 240 ||
		strings.ContainsAny(name[len(`Local\`):], `\/`) {
		return nil, fmt.Errorf("互斥量名称必须是有效 Local 名称")
	}
	encoded, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return nil, fmt.Errorf("互斥量名称含无效字符: %w", err)
	}
	handle, _, callErr := createMutexW.Call(0, 0, uintptr(unsafe.Pointer(encoded)))
	if handle == 0 {
		return nil, nativeError("创建命名互斥量", callErr)
	}
	if callErr == syscall.ERROR_ALREADY_EXISTS {
		closeHandle(syscall.Handle(handle))
		return nil, ErrLocked
	}
	return &mutexLease{handle: syscall.Handle(handle)}, nil
}

type mutexLease struct {
	mu     sync.Mutex
	handle syscall.Handle
}

func (lease *mutexLease) Close() error {
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.handle == 0 {
		return nil
	}
	err := closeHandle(lease.handle)
	lease.handle = 0
	return err
}
