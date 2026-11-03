// 本文件定义假后端的编译期测试档案与显式参数；不读取配置文件、环境秘密或真实运行时。
package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"time"
)

// profile 可通过 go build -ldflags "-X main.profile=official-crash" 冻结进单个发布 exe。
var profile = "normal"

// serveOptions 保存经过边界检查的实验启动参数。
type serveOptions struct {
	// port 只允许 30091 至 30097，且要求调用方显式指定。
	port int
	// host 只允许回环地址，不把实验服务暴露到局域网。
	host string
	// mode 区分正式与候选进程，默认 official。
	mode string
	// behavior 是解析完成后本进程实际采用的行为。
	behavior string
	// healthyAfter 是监听后开始返回健康的延迟。
	healthyAfter time.Duration
	// crashAfter 为正时在监听后定时退出，零表示不定时退出。
	crashAfter time.Duration
	// candidateBehavior 覆盖候选行为，空值表示使用通用行为。
	candidateBehavior string
	// officialBehavior 覆盖正式行为，空值表示使用通用行为。
	officialBehavior string
	// ignoreTerminate 只忽略可捕获信号，不可能阻止 TerminateJobObject。
	ignoreTerminate bool
	// childPort 为非零时启动同 exe 孙进程，孙进程不会继续派生。
	childPort int
}

// profileOptions 给发布夹仅含 exe 与 manifest 的场景提供稳定行为。
func profileOptions(name string) (serveOptions, error) {
	options := serveOptions{host: "127.0.0.1", mode: "official", behavior: "normal"}
	switch name {
	case "normal":
	case "official-crash":
		options.officialBehavior = "crash"
	case "candidate-crash":
		options.candidateBehavior = "crash"
	case "crash":
		options.behavior = "crash"
	case "delayed":
		options.healthyAfter = 2 * time.Second
	case "crash-later":
		options.crashAfter = 2 * time.Second
	default:
		return serveOptions{}, fmt.Errorf("未知假后端 profile: %s", name)
	}
	return options, nil
}

// parseServe 只解析并校验，不打开文件、端口或进程；显式参数优先于编译期档案。
func parseServe(args []string, name string) (serveOptions, error) {
	options, err := profileOptions(name)
	if err != nil {
		return serveOptions{}, err
	}
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.IntVar(&options.port, "port", 0, "实验端口，必须为 30091 至 30097")
	flags.StringVar(&options.host, "host", options.host, "回环监听地址")
	flags.StringVar(&options.mode, "mode", options.mode, "official 或 candidate")
	flags.StringVar(&options.behavior, "behavior", options.behavior, "normal、crash、unhealthy 或 hold")
	flags.DurationVar(&options.healthyAfter, "healthy-after", options.healthyAfter, "健康延迟，例如 200ms")
	flags.DurationVar(&options.crashAfter, "crash-after", options.crashAfter, "定时崩溃延迟，0 禁用")
	flags.StringVar(&options.candidateBehavior, "candidate-behavior", options.candidateBehavior, "候选行为覆盖")
	flags.StringVar(&options.officialBehavior, "official-behavior", options.officialBehavior, "正式行为覆盖")
	flags.BoolVar(&options.ignoreTerminate, "ignore-terminate", false, "忽略可捕获终止信号，不能抵抗 Job 强制终止")
	flags.IntVar(&options.childPort, "child-port", 0, "同 exe 孙进程实验端口，0 禁用")
	if err := flags.Parse(args); err != nil {
		return serveOptions{}, err
	}
	if flags.NArg() != 0 {
		return serveOptions{}, fmt.Errorf("serve 不接受位置参数")
	}
	//M 显式通用行为覆盖档案里的模式差异，显式模式行为则拥有最高优先级。
	visited := make(map[string]bool)
	flags.Visit(func(f *flag.Flag) { visited[f.Name] = true })
	if visited["behavior"] {
		if !visited["candidate-behavior"] {
			options.candidateBehavior = ""
		}
		if !visited["official-behavior"] {
			options.officialBehavior = ""
		}
	}
	if err := validateServe(&options); err != nil {
		return serveOptions{}, err
	}
	if options.mode == "candidate" && options.candidateBehavior != "" {
		options.behavior = options.candidateBehavior
	}
	if options.mode == "official" && options.officialBehavior != "" {
		options.behavior = options.officialBehavior
	}
	return options, nil
}

// validateServe 在任何监听动作之前拒绝真实端口、非回环地址和非法行为。
func validateServe(options *serveOptions) error {
	if !testPort(options.port) {
		return fmt.Errorf("假后端只允许监听 30091 至 30097，且必须显式指定 --port")
	}
	if options.childPort != 0 && (!testPort(options.childPort) || options.childPort == options.port) {
		return fmt.Errorf("孙进程端口必须在 30091 至 30097 且不同于父进程")
	}
	if options.host == "localhost" {
		options.host = "127.0.0.1"
	}
	if ip := net.ParseIP(options.host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("假后端只允许回环 IP，不进行 DNS 查询")
	}
	if options.mode != "official" && options.mode != "candidate" {
		return fmt.Errorf("模式只允许 official 或 candidate")
	}
	if options.healthyAfter < 0 || options.crashAfter < 0 {
		return fmt.Errorf("健康和崩溃延迟不能为负数")
	}
	for _, behavior := range []string{options.behavior, options.candidateBehavior, options.officialBehavior} {
		if behavior != "" && behavior != "normal" && behavior != "crash" && behavior != "unhealthy" && behavior != "hold" {
			return fmt.Errorf("未知行为: %s", behavior)
		}
	}
	if options.behavior == "" {
		return fmt.Errorf("通用行为不能为空")
	}
	return nil
}

func testPort(port int) bool {
	return port >= 30091 && port <= 30097
}

// checkOptions 是无网络 gate/smoke 命令参数。
type checkOptions struct {
	// exit 是最终退出码，限制到跨平台可用的 0 至 255。
	exit int
	// delay 是返回退出码前的延迟。
	delay time.Duration
}

func parseCheck(args []string) (checkOptions, error) {
	var options checkOptions
	flags := flag.NewFlagSet("check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.IntVar(&options.exit, "exit", 0, "退出码")
	flags.DurationVar(&options.delay, "delay", 0, "返回前延迟")
	if err := flags.Parse(args); err != nil {
		return checkOptions{}, err
	}
	if flags.NArg() != 0 || options.exit < 0 || options.exit > 255 || options.delay < 0 {
		return checkOptions{}, fmt.Errorf("check 只接受 --exit 0..255 和非负 --delay duration")
	}
	return options, nil
}
