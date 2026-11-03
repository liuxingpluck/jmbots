//go:build windows

// 本文件包含由 lead 统一串行执行的进程测试；不监听端口，只操作实验目录内自建测试进程。
package winproc

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func processExperiment(t *testing.T) (string, string) {
	t.Helper()
	home := experimentHome(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal("查询实验测试程序路径失败", err)
	}
	if !inExperiment(exe) {
		t.Fatal("进程测试仅允许执行 F 盘实验目录内的测试程序")
	}
	return home, exe
}

func inExperiment(path string) bool {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(`F:\aidata\cache\jmshell_exp`, absolute)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, `..\`) && !filepath.IsAbs(relative)
}

func helperOptions(home, exe, role string, output *os.File) Options {
	//G helper 还会经 os.StartProcess 创建后代，必须先移除旧角色，防止重复环境项递归派生。
	var environment []string
	for _, value := range os.Environ() {
		upper := strings.ToUpper(value)
		if strings.HasPrefix(upper, "JMBOTS_WINPROC_HELPER_ROLE=") || strings.HasPrefix(upper, "JMBOTS_WINPROC_HELPER_HOME=") {
			continue
		}
		environment = append(environment, value)
	}
	environment = append(environment, "JMBOTS_WINPROC_HELPER_ROLE="+role, "JMBOTS_WINPROC_HELPER_HOME="+home)
	return Options{
		Exe: exe,
		Args: []string{"-test.run=^TestWinprocHelperProcess$", "--", "jmbots-winproc-experiment"},
		Dir: home,
		Env: environment,
		Stdout: output,
		Stderr: output,
	}
}

func cleanupExperimentProcess(t *testing.T, process *Process) {
	t.Helper()
	t.Cleanup(func() {
		if err := process.Stop(3 * time.Second); err != nil && !errors.Is(err, ErrClosed) {
			t.Error("清理自建实验 Job 失败", err)
		}
		if err := process.Close(); err != nil {
			t.Error("关闭自建实验进程句柄失败", err)
		}
	})
}

func TestProcess等待取消与身份篡改拒绝(t *testing.T) {
	home, exe := processExperiment(t)
	file, err := os.OpenFile(filepath.Join(home, "stdout.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal("创建实验直接日志文件失败", err)
	}
	defer file.Close()
	process, err := Start(helperOptions(home, exe, "sleep", file))
	if err != nil {
		t.Fatal("启动自建实验进程失败", err)
	}
	cleanupExperimentProcess(t, process)
	if alive, err := process.Alive(); err != nil || !alive {
		t.Fatal("新建进程应存活", err)
	}
	if err := Validate(process.Identity()); err != nil {
		t.Fatal("自建进程完整身份应可复核", err)
	}
	changed := process.Identity()
	changed.Created++
	if err := KillOwned(changed); !errors.Is(err, ErrIdentity) {
		t.Error("创建时间不符必须拒绝强杀", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := process.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Error("等待超时必须返回上下文错误", err)
	}
	if alive, err := process.Alive(); err != nil || !alive {
		t.Error("取消等待不得终止进程", err)
	}
	if err := process.Stop(3 * time.Second); err != nil {
		t.Fatal("终止自建 Job 失败", err)
	}
	if alive, err := process.Alive(); err != nil || alive {
		t.Error("Stop 后根进程应退出", err)
	}
}

func TestProcessClose不杀且可精确强杀自建壳(t *testing.T) {
	home, exe := processExperiment(t)
	process, err := Start(helperOptions(home, exe, "sleep", nil))
	if err != nil {
		t.Fatal("启动实验进程失败", err)
	}
	identity := process.Identity()
	t.Logf("自建实验根身份: PID=%d Created=%d Path=%s", identity.PID, identity.Created, identity.Path)
	cleanupExperimentProcess(t, process)
	handle, err := openIdentityProcess(identity.PID, processQueryLimited|synchronize)
	if err != nil {
		t.Fatal("固定实验进程句柄失败", err)
	}
	t.Cleanup(func() {
		if exited, _ := processExited(handle); !exited {
			if err := KillOwned(identity); err != nil {
				t.Error("清理 Close 后的自建实验进程失败", err)
			}
		}
		_ = closeHandle(handle)
	})
	if err := process.Close(); err != nil {
		t.Fatal("Close 失败", err)
	}
	if err := process.Close(); err != nil {
		t.Fatal("重复 Close 应幂等", err)
	}
	if exited, err := processExited(handle); err != nil || exited {
		t.Fatal("关闭无 kill-close Job 不应终止根进程", err)
	}
	if err := KillOwned(identity); err != nil {
		t.Fatal("精确强杀当前测试直接创建的进程失败", err)
	}
	status, err := syscall.WaitForSingleObject(handle, 3000)
	if err != nil || status != waitObject0 {
		t.Fatal("等待精确强杀生效失败", err)
	}
}

func TestProcess根退出后仍能清理Job后代(t *testing.T) {
	home, exe := processExperiment(t)
	process, err := Start(helperOptions(home, exe, "spawn-child", nil))
	if err != nil {
		t.Fatal("启动实验父进程失败", err)
	}
	cleanupExperimentProcess(t, process)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if code, err := process.Wait(ctx); err != nil || code != 0 {
		t.Fatal("实验根进程应在创建后代后自行退出", code, err)
	}
	data, err := os.ReadFile(filepath.Join(home, "child-identity.json"))
	if err != nil {
		t.Fatal("读取自建测试后代身份失败", err)
	}
	var child Identity
	if err := json.Unmarshal(data, &child); err != nil || !inExperiment(child.Path) {
		t.Fatal("测试后代身份格式或路径无效", err)
	}
	handle, err := openIdentityProcess(child.PID, processQueryLimited|synchronize)
	if err != nil {
		t.Fatal("固定测试后代句柄失败", err)
	}
	defer closeHandle(handle)
	if err := validateHandle(handle, child); err != nil {
		t.Fatal("测试后代身份不匹配", err)
	}
	root := process.Identity()
	t.Logf("已退出实验根身份: PID=%d Created=%d Path=%s", root.PID, root.Created, root.Path)
	t.Logf("仍存活实验后代身份: PID=%d Created=%d Path=%s", child.PID, child.Created, child.Path)
	if exited, err := processExited(handle); err != nil || exited {
		t.Fatal("根退出后测试后代应仍存活", err)
	}
	if err := process.Stop(3 * time.Second); err != nil {
		t.Fatal("根已退出后应仍能核验并终止原 Job", err)
	}
	status, err := syscall.WaitForSingleObject(handle, 3000)
	if err != nil || status != waitObject0 {
		t.Fatal("原 Job 的测试后代必须被清理", err)
	}
}

func TestProcessAdopt只允许显式身份与匹配命令行(t *testing.T) {
	home, exe := processExperiment(t)
	process, err := Start(helperOptions(home, exe, "sleep", nil))
	if err != nil {
		t.Fatal("启动实验接管对象失败", err)
	}
	cleanupExperimentProcess(t, process)
	changed := process.Identity()
	changed.Created++
	if adopted, err := Adopt(changed); err == nil {
		_ = adopted.Close()
		t.Fatal("身份变化不得接管")
	}
	adopted, err := Adopt(process.Identity())
	if err != nil {
		t.Fatal("包含 jmbots 的自建测试命令行应可加入兼容嵌套 Job", err)
	}
	cleanupExperimentProcess(t, adopted)
	if err := adopted.Stop(3 * time.Second); err != nil {
		t.Fatal("已接管的实验 Job 应可停止", err)
	}
	//G 第二个自建目标故意不带 jmbots 参数；不得只凭映像身份就接管。
	options := helperOptions(home, exe, "sleep", nil)
	options.Args = []string{"-test.run=^TestWinprocHelperProcess$"}
	unmarked, err := Start(options)
	if err != nil {
		t.Fatal("启动不匹配命令行的实验对象失败", err)
	}
	cleanupExperimentProcess(t, unmarked)
	if unexpected, err := Adopt(unmarked.Identity()); err == nil {
		_ = unexpected.Close()
		t.Fatal("命令行不含 jmbots 时必须拒绝接管")
	}
}

// TestWinprocHelperProcess 仅由上述实验测试启动，不接受仓库或真实运行时目录。
func TestWinprocHelperProcess(t *testing.T) {
	role := os.Getenv("JMBOTS_WINPROC_HELPER_ROLE")
	if role == "" {
		return
	}
	home := os.Getenv("JMBOTS_WINPROC_HELPER_HOME")
	exe, err := os.Executable()
	if err != nil || !inExperiment(home) || !inExperiment(exe) {
		os.Exit(80)
	}
	if role == "sleep" {
		//G 即使测试宿主异常退出，实验后代也在十五秒内自行退出。
		time.Sleep(15 * time.Second)
		os.Exit(0)
	}
	if role != "spawn-child" {
		os.Exit(81)
	}
	options := helperOptions(home, exe, "sleep", nil)
	child, err := os.StartProcess(exe, append([]string{exe}, options.Args...), &os.ProcAttr{
		Dir: home,
		Env: options.Env,
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
		Sys: &syscall.SysProcAttr{CreationFlags: createNoWindow},
	})
	if err != nil {
		os.Exit(82)
	}
	identity, err := Inspect(uint32(child.Pid))
	if err != nil {
		//G 无法取得完整身份时不终止未知 PID；由测试持有的外层 Job 清理。
		_ = child.Release()
		os.Exit(83)
	}
	data, err := json.Marshal(identity)
	if err == nil {
		err = os.WriteFile(filepath.Join(home, "child-identity.json"), data, 0600)
	}
	if err != nil {
		_ = KillOwned(identity)
		_, _ = child.Wait()
		os.Exit(84)
	}
	_ = child.Release()
	os.Exit(0)
}
