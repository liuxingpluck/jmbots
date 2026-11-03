//go:build windows

// 本文件确保实验孙进程不弹控制台窗口，仍继承外层 Job，不设置 breakaway。
package main

import (
	"os/exec"
	"syscall"
)

func configureChild(command *exec.Cmd) {
	const createNoWindow = 0x08000000
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
