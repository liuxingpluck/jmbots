//go:build !windows

// 本文件为非 Windows 纯逻辑验证提供 O_APPEND 版本，不承诺 Windows 句柄继承行为。
package logging

import (
	"fmt"
	"os"
	"path/filepath"
)

// OpenChild 打开 O_APPEND 原始日志，调用方负责关闭；不建立管道也不执行脱敏。
func OpenChild(path string) (*os.File, error) {
	if path == "" {
		return nil, fmt.Errorf("子进程日志路径不能为空")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
}

func openSharedRead(path string) (*os.File, error) {
	return os.Open(path)
}

func openChildControl(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDWR, 0600)
}
