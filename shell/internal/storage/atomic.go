// Package storage 提供壳子状态的同目录原子写入与备份恢复，不读取任何运行时秘密。
package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// renameAttempts 限制 Windows 文件占用重试次数，最长退避合计为 310 毫秒。
const renameAttempts = 6

// AtomicWrite 将 data 写入同目录临时文件，同步并关闭后替换 path；失败时不删除旧目标。
// 父目录必须已存在；mode 只用于新文件权限，不建立备份，也不保证跨进程写入串行。
func AtomicWrite(path string, data []byte, mode os.FileMode) error {
	if path == "" {
		return fmt.Errorf("原子写入路径不能为空")
	}

	//M 临时文件与目标同目录，避免跨卷改名及可见的半写目标。
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-")
	if err != nil {
		return fmt.Errorf("创建原子写入临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	closed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
	}()
	if err := tmp.Chmod(mode.Perm()); err != nil {
		return fmt.Errorf("设置临时文件权限: %w", err)
	}
	n, err := tmp.Write(data)
	if err != nil {
		return fmt.Errorf("写入临时文件: %w", err)
	}
	if n != len(data) {
		return fmt.Errorf("写入临时文件: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("同步临时文件: %w", err)
	}
	closeErr := tmp.Close()
	closed = true
	if closeErr != nil {
		return fmt.Errorf("关闭临时文件: %w", closeErr)
	}

	//G 仅重试系统明确可恢复的占用错误，绝不先删除旧目标再重试。
	if err := retryRename(func() error { return os.Rename(tmpName, path) }, transientRenameError, time.Sleep); err != nil {
		return fmt.Errorf("替换目标文件: %w", err)
	}
	return nil
}

// retryRename 将操作、错误分类和等待函数作为参数，便于无需占用真实文件的有界重试测试。
func retryRename(rename func() error, transient func(error) bool, sleep func(time.Duration)) error {
	for attempt := 0; ; attempt++ {
		err := rename()
		if err == nil || attempt+1 >= renameAttempts || !transient(err) {
			return err
		}
		sleep((10 * time.Millisecond) << attempt)
	}
}
