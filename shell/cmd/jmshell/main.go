// jmshell 入口负责装配独立守护器；退出壳子不停止服务，默认不读取业务配置。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"jmbots-shell/internal/autostart"
	"jmbots-shell/internal/logging"
	core "jmbots-shell/internal/shell"
	"jmbots-shell/internal/tray"
)

func main() {
	if err := run(); err != nil {
		//G GUI 构建没有可见控制台；仅在显式 home 内留启动失败记录，不猜测正式运行时。
		home := ""
		for i, arg := range os.Args {
			if arg == "--home" && i+1 < len(os.Args) {
				home = os.Args[i+1]
			}
		}
		if home != "" {
			errorPath := filepath.Join(home, "startup-error.log")
			if file, e := os.OpenFile(errorPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); e == nil {
				fmt.Fprintf(file, "%s %v\n", time.Now().Format(time.RFC3339), err)
				file.Close()
			}
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) > 1 && os.Args[1] == "install-autostart" {
		return runAutostart(os.Args[2:])
	}
	flags := flag.NewFlagSet("jmshell", flag.ContinueOnError)
	home := flags.String("home", "", "壳子目录；测试必须显式指定")
	runtimeDir := flags.String("runtime", "", "未指定 home 时的运行时目录")
	headless := flags.Bool("headless", false, "不启动托盘，仅运行守护与控制口")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("不接受位置参数；请使用 --home，子命令只有 install-autostart")
	}
	resolved, err := core.ResolveHome(*home, *runtimeDir)
	if err != nil {
		return err
	}
	config, err := core.LoadConfig(resolved)
	if err != nil {
		return err
	}
	timing := core.DefaultTiming()
	manager, err := core.NewManager(config, timing)
	if err != nil {
		return err
	}
	defer manager.Close()
	token, err := core.LoadToken(resolved, true)
	if err != nil {
		return err
	}
	server, listener, err := manager.ListenControl(token)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	served := make(chan error, 1)
	go func() {
		served <- server.Serve(listener)
	}()
	manager.StartGuard()
	if *headless {
		select {
		case <-ctx.Done():
		case err = <-served:
			if err != http.ErrServerClosed {
				return err
			}
		}
	} else {
		trayLog, e := logging.New(filepath.Join(resolved, "logs", "tray.log"), 5<<20, 5)
		if e != nil {
			server.Close()
			return e
		}
		defer trayLog.Close()
		previousLog := log.Writer()
		log.SetOutput(trayLog)
		defer log.SetOutput(previousLog)
		ended := make(chan struct{})
		defer close(ended)
		go func() {
			select {
			case <-ended:
				return
			case <-served:
				cancel()
			}
		}()
		actions := tray.Actions{
			Begin: func(kind string) error {
				_, e := manager.Begin(kind, core.Request{}, false)
				return e
			},
			Open: tray.OpenTarget,
			Exit: cancel,
		}
		err = tray.Run(ctx, config, manager.Snapshot, actions, func(text string) { fmt.Fprintln(trayLog, text) })
	}
	shutdown, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	closeErr := server.Shutdown(shutdown)
	if err != nil {
		return err
	}
	return closeErr
}

// runAutostart 只在用户显式调用子命令时访问注册表；本次验收不执行此入口。
func runAutostart(args []string) error {
	flags := flag.NewFlagSet("install-autostart", flag.ContinueOnError)
	home := flags.String("home", "", "壳子目录")
	remove := flags.Bool("remove", false, "卸载本home的Run项")
	show := flags.Bool("show", false, "仅显示本home的Run项与旧看门狗提示")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("自启子命令不接受位置参数")
	}
	resolved, err := core.ResolveHome(*home, "")
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return fmt.Errorf("APPDATA不可用，拒绝猜测启动目录")
	}
	//M 自启参数在命令行入口组装，内部只使用确定的目录和开关。
	startupDir := filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
	options := autostart.Options{
		Exe:        exe,
		Home:       resolved,
		StartupDir: startupDir,
		Remove:     *remove,
		Show:       *show,
	}
	registry := autostart.NewWindowsRegistry()

	result, err := autostart.Run(registry, options)
	message := fmt.Sprintf("Run项存在=%t；命令=%s；提示=%s", result.Installed, result.Command, result.Warning)
	fmt.Println(message)
	//M windowsgui无控制台，显式命令结果同时落到本home，不写默认业务日志。
	resultPath := filepath.Join(resolved, "autostart-result.log")
	if file, e := os.OpenFile(resultPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); e == nil {
		fmt.Fprintf(file, "%s %s 错误=%v\n", time.Now().Format(time.RFC3339), message, err)
		file.Close()
	}
	return err
}
