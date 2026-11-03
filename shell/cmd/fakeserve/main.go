// fakeserve 是仅供隔离验收的标准库假后端；只允许实验端口，不接触真实运行时。
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run 统一命令退出码；check 分支不调用网络和子进程逻辑。
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "用法: fakeserve serve --port P --host H [--mode candidate] | check --exit N --delay duration")
		return 2
	}
	switch args[0] {
	case "check":
		options, err := parseCheck(args[1:])
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
		return runCheck(options, stdout, time.Sleep)
	case "serve":
		options, err := parseServe(args[1:], profile)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
		return runServe(options, stdout, stderr)
	default:
		fmt.Fprintln(stderr, "未知命令；只允许 serve 或 check")
		return 2
	}
}

// runCheck 注入等待函数便于纯逻辑测试，不启动服务也不读取配置。
func runCheck(options checkOptions, stdout io.Writer, sleep func(time.Duration)) int {
	if options.delay > 0 {
		sleep(options.delay)
	}
	fmt.Fprintf(stdout, "假检查完成 exit=%d delay=%s\n", options.exit, options.delay)
	return options.exit
}

func runServe(options serveOptions, stdout, stderr io.Writer) int {
	//G 即崩行为在监听及派生子进程前退出，避免留下模糊归属的半启动状态。
	if options.behavior == "crash" {
		fmt.Fprintf(stderr, "假后端模拟启动崩溃 pid=%d mode=%s\n", os.Getpid(), options.mode)
		return 17
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(options.host, strconv.Itoa(options.port)))
	if err != nil {
		fmt.Fprintln(stderr, "假后端监听失败:", err)
		return 18
	}
	defer listener.Close()
	started := time.Now()
	server := &http.Server{
		Handler: newHealthHandler(options, started, os.Getpid(), time.Now),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout: 3 * time.Second,
		WriteTimeout: 3 * time.Second,
		IdleTimeout: 5 * time.Second,
		MaxHeaderBytes: 16 * 1024,
	}
	defer server.Close()

	//M 标准输出直接继承真实文件句柄，孙进程没有依赖本进程持续排空的管道。
	if options.childPort != 0 {
		exe, err := os.Executable()
		if err != nil {
			fmt.Fprintln(stderr, "定位假后端可执行文件失败:", err)
			return 19
		}
		child := childCommand(exe, options)
		if err := child.Start(); err != nil {
			fmt.Fprintln(stderr, "启动假后端孙进程失败:", err)
			return 19
		}
		fmt.Fprintf(stdout, "假后端孙进程 pid=%d port=%d\n", child.Process.Pid, options.childPort)
		//G 孙进程由外层已核验的 Job 统一清理；此处不按端口或单独 PID 杀进程。
		go func() { _ = child.Wait() }()
	}

	// signals 只承接可捕获的控制信号，绝不宣称可抵抗 TerminateJobObject。
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	fmt.Fprintf(stdout, "假后端监听 pid=%d mode=%s port=%d behavior=%s\n", os.Getpid(), options.mode, options.port, options.behavior)

	// crash 是可选的有界计时器通道；nil 通道禁用定时崩溃分支。
	var crash <-chan time.Time
	if options.crashAfter > 0 {
		timer := time.NewTimer(options.crashAfter)
		defer timer.Stop()
		crash = timer.C
	}
	for {
		select {
		case <-crash:
			fmt.Fprintf(stderr, "假后端模拟运行后崩溃 pid=%d mode=%s\n", os.Getpid(), options.mode)
			return 17
		case <-signals:
			if options.ignoreTerminate || options.behavior == "hold" {
				fmt.Fprintln(stdout, "假后端忽略可捕获终止信号，继续占用实验端口")
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_ = server.Shutdown(ctx)
			cancel()
			return 0
		case err := <-served:
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				fmt.Fprintln(stderr, "假后端 HTTP 退出:", err)
				return 18
			}
			return 0
		}
	}
}

// childCommand 只构造同 exe 启动信息，不启动进程；参数显式覆盖父 exe 的编译期故障档案。
// 父进程若被直接终止，孙进程仍可能存活，验收必须通过外层 Job 清理整棵树。
func childCommand(exe string, options serveOptions) *exec.Cmd {
	args := []string{
		"serve", "--port", strconv.Itoa(options.childPort), "--host", options.host,
		"--mode", options.mode, "--behavior", "normal", "--candidate-behavior", "normal",
		"--official-behavior", "normal", "--healthy-after", "0s", "--crash-after", "0s",
		"--child-port", "0",
	}
	if options.ignoreTerminate || options.behavior == "hold" {
		args = append(args, "--ignore-terminate")
	}
	command := exec.Command(exe, args...)
	configureChild(command)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command
}
