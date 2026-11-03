//go:build windows

// 本文件仅分类 Windows 改名时可短暂恢复的访问及共享占用错误。
package storage

import (
	"errors"
	"syscall"
)

// transientRenameError 保留系统错误链，仅对拒绝访问、共享冲突和锁冲突有界重试。
func transientRenameError(err error) bool {
	return errors.Is(err, syscall.Errno(5)) || errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33))
}
