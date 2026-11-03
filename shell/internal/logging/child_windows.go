//go:build windows

// 本文件用 Windows 共享追加句柄连接子进程标准输出，不建立依赖壳子存活的管道。
package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// OpenChild 创建或打开原始子进程日志，父目录缺失时创建，调用方负责关闭返回的句柄。
// 使用 FILE_SHARE_READ|WRITE|DELETE；仅授予 FILE_APPEND_DATA，截断后写入仍在新 EOF。
// 返回句柄默认不可继承，启动器必须只复制该标准句柄到明确的继承列表；此处不脱敏。
func OpenChild(path string) (*os.File, error) {
	if path == "" {
		return nil, fmt.Errorf("子进程日志路径不能为空")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	// appendOnly 避免 FILE_WRITE_DATA 允许子进程继续按截断前的陈旧文件偏移写入。
	const appendOnly uint32 = 0x00000004 | 0x00100000 // FILE_APPEND_DATA | SYNCHRONIZE
	return openShared(path, appendOnly, syscall.OPEN_ALWAYS)
}

func openSharedRead(path string) (*os.File, error) {
	return openShared(path, syscall.GENERIC_READ, syscall.OPEN_EXISTING)
}

func openChildControl(path string) (*os.File, error) {
	return openShared(path, syscall.GENERIC_READ|syscall.GENERIC_WRITE, syscall.OPEN_EXISTING)
}

func openShared(path string, access uint32, creation uint32) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	handle, err := syscall.CreateFile(name, access, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, creation, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(handle), path), nil
}
