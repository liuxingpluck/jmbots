//go:build windows

// 本文件用临时文件真实模拟 Windows 禁止删除共享，验证占用失败不损坏旧状态。
package storage

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestAtomicWriteWindowsSharingViolationKeepsOldFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	mustWrite(t, path, []byte("old-valid-state"))
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	//M 不提供 FILE_SHARE_DELETE，让临时文件替换在该句柄关闭前确实遇到 Windows 占用。
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = syscall.CloseHandle(handle)
		}
	}()
	if err := AtomicWrite(path, []byte("new-state"), 0600); err == nil {
		t.Fatal("禁止删除共享时应在有界重试后失败")
	}
	if got := string(mustRead(t, path)); got != "old-valid-state" {
		t.Fatalf("占用失败后旧文件被破坏: %q", got)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("失败后临时文件未清理: count=%d err=%v", len(entries), err)
	}
	if err := syscall.CloseHandle(handle); err != nil {
		t.Fatal(err)
	}
	closed = true
	if err := AtomicWrite(path, []byte("new-state"), 0600); err != nil {
		t.Fatalf("占用解除后替换失败: %v", err)
	}
	if got := string(mustRead(t, path)); got != "new-state" {
		t.Fatalf("占用解除后目标错误: %q", got)
	}
}
