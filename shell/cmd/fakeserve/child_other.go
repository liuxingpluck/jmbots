//go:build !windows

// 本文件保留非 Windows 纯逻辑测试兼容性，不变更子进程信号或进程组。
package main

import "os/exec"

func configureChild(command *exec.Cmd) {}
