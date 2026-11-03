//go:build windows

// 本文件只用 fake Registry 与 F 盘实验临时文件；不构造或调用真实注册表适配，也不访问真实 Startup。
package autostart

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

type fakeRegistry struct {
	values    map[string]string
	calls     []string
	getErr    error
	setErr    error
	deleteErr error
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{values: make(map[string]string)}
}

func (reg *fakeRegistry) Get(name string) (string, error) {
	reg.calls = append(reg.calls, "get:"+name)
	if reg.getErr != nil {
		return "", reg.getErr
	}
	value, ok := reg.values[name]
	if !ok {
		return "", ErrNotExist
	}
	return value, nil
}

func (reg *fakeRegistry) Set(name, value string) error {
	reg.calls = append(reg.calls, "set:"+name)
	if reg.setErr != nil {
		return reg.setErr
	}
	reg.values[name] = value
	return nil
}

func (reg *fakeRegistry) Delete(name string) error {
	reg.calls = append(reg.calls, "delete:"+name)
	if reg.deleteErr != nil {
		return reg.deleteErr
	}
	if _, ok := reg.values[name]; !ok {
		return ErrNotExist
	}
	delete(reg.values, name)
	return nil
}

func fakeOptions(t *testing.T) Options {
	t.Helper()
	temporary, err := filepath.Abs(os.TempDir())
	if err != nil {
		t.Fatal("无法解析实验临时目录", err)
	}
	relative, err := filepath.Rel(`F:\aidata\cache\jmshell_exp`, temporary)
	if err != nil || relative == ".." || strings.HasPrefix(relative, `..\`) || filepath.IsAbs(relative) {
		t.Fatal("自启测试仅可在 F 盘实验 TEMP 中执行")
	}
	base := t.TempDir()
	home := filepath.Join(base, "带 空格 home")
	startup := filepath.Join(base, "fake-startup")
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal("创建实验壳子目录失败", err)
	}
	if err := os.Mkdir(startup, 0700); err != nil {
		t.Fatal("创建替身启动目录失败", err)
	}
	return Options{Exe: filepath.Join(base, "程序 目录", "jmshell.exe"), Home: home, StartupDir: startup}
}

func TestRun安装查看卸载仅操作当前Home(t *testing.T) {
	opts := fakeOptions(t)
	reg := newFakeRegistry()
	reg.values["unrelated-application"] = "keep"
	result, err := Run(reg, opts)
	if err != nil || !result.Installed {
		t.Fatal("替身安装应成功", err)
	}
	command := `"` + filepath.Clean(opts.Exe) + `" --home "` + filepath.Clean(opts.Home) + `"`
	if result.Command != command || !strings.Contains(result.Warning, "StartupApproved") {
		t.Error("安装结果必须正确引用路径并说明未改变任务管理器禁用标记")
	}
	name, err := nameForHome(opts.Home)
	if err != nil || !validValueName(name) || reg.values[name] != command {
		t.Fatal("必须使用 home 哈希隔离 Run 值", err)
	}
	if len(reg.calls) != 2 || reg.calls[0] != "get:"+name || reg.calls[1] != "set:"+name {
		t.Error("安装只应查询和写入本 home 值")
	}
	reg.calls = nil
	if _, err := Run(reg, opts); err != nil || !reflect.DeepEqual(reg.calls, []string{"get:" + name}) {
		t.Error("相同命令重复安装不应再次写入", err)
	}
	reg.calls = nil
	opts.Show = true
	shown, err := Run(reg, opts)
	if err != nil || !shown.Installed || shown.Command != command || !reflect.DeepEqual(reg.calls, []string{"get:" + name}) {
		t.Error("查看必须只读当前值", err)
	}
	opts.Show, opts.Remove = false, true
	//G 卸载故意不提供 StartupDir/Exe，证明不必访问旧 VBS 或真实系统目录。
	opts.StartupDir, opts.Exe = "", ""
	reg.calls = nil
	removed, err := Run(reg, opts)
	if err != nil || removed.Installed || removed.Command != "" || !reflect.DeepEqual(reg.calls, []string{"delete:" + name}) {
		t.Error("卸载必须只删除当前 home 的 Run 值", err)
	}
	if reg.values["unrelated-application"] != "keep" {
		t.Error("不得改动其他应用自启值")
	}
	if _, err := Run(reg, opts); err != nil {
		t.Error("缺失值的卸载必须幂等", err)
	}
}

func TestRun旧VBS存在时拒绝安装查看警告卸载不碰(t *testing.T) {
	opts := fakeOptions(t)
	guard := filepath.Join(opts.StartupDir, "jmbots_Guard.vbs")
	if err := os.WriteFile(guard, nil, 0600); err != nil {
		t.Fatal("创建替身空 VBS 失败", err)
	}
	reg := newFakeRegistry()
	result, err := Run(reg, opts)
	if err == nil || result.Warning == "" || len(reg.calls) != 0 {
		t.Error("旧 VBS 存在时必须在注册表访问前拒绝安装")
	}
	opts.Show = true
	result, err = Run(reg, opts)
	if err != nil || !strings.Contains(result.Warning, "jmbots_Guard.vbs") || result.Installed {
		t.Error("查看缺失 Run 值时仍应提示旧 VBS", err)
	}
	opts.Show, opts.Remove = false, true
	reg.calls = nil
	if _, err := Run(reg, opts); err != nil || len(reg.calls) != 1 || !strings.HasPrefix(reg.calls[0], "delete:") {
		t.Error("旧 VBS 不应阻止只删除本名字的卸载", err)
	}
	if _, err := os.Lstat(guard); err != nil {
		t.Error("卸载不得删除旧 VBS", err)
	}
}

func TestRun同名目录和悬空链接也阻止安装(t *testing.T) {
	t.Run("同名目录", func(t *testing.T) {
		opts := fakeOptions(t)
		if err := os.Mkdir(filepath.Join(opts.StartupDir, "jmbots_Guard.vbs"), 0700); err != nil {
			t.Fatal("创建实验同名目录失败", err)
		}
		reg := newFakeRegistry()
		if result, err := Run(reg, opts); err == nil || result.Warning == "" || len(reg.calls) != 0 {
			t.Error("同名目录也必须阻止安装")
		}
	})
	t.Run("悬空链接", func(t *testing.T) {
		opts := fakeOptions(t)
		if err := os.Symlink(filepath.Join(opts.StartupDir, "missing-target.vbs"), filepath.Join(opts.StartupDir, "jmbots_Guard.vbs")); err != nil {
			t.Skip("系统不允许创建替身符号链接，未验证悬空链接分支", err)
		}
		reg := newFakeRegistry()
		if result, err := Run(reg, opts); err == nil || result.Warning == "" || len(reg.calls) != 0 {
			t.Error("Lstat 必须识别悬空链接，不能当成旧 VBS 不存在")
		}
	})
}

func TestRun参数注入在访问注册表前拒绝(t *testing.T) {
	base := fakeOptions(t)
	cases := []struct {
		name   string
		change func(*Options)
	}{
		{"空目录", func(opts *Options) { opts.Home = "" }},
		{"相对目录", func(opts *Options) { opts.Home = `relative\home` }},
		{"引号注入", func(opts *Options) { opts.Exe += `" --other` }},
		{"NUL注入", func(opts *Options) { opts.Exe += "\x00" }},
		{"换行注入", func(opts *Options) { opts.Home += "\ncommand" }},
		{"回车注入", func(opts *Options) { opts.StartupDir += "\r" }},
		{"Unicode换行", func(opts *Options) { opts.Exe += "\u2028" }},
		{"脚本中转", func(opts *Options) { opts.Exe = filepath.Join(filepath.Dir(opts.Exe), "start.cmd") }},
		{"ADS路径", func(opts *Options) { opts.Exe += ":other.exe" }},
		{"设备路径", func(opts *Options) { opts.Exe = `\\.\pipe\fake.exe` }},
		{"缺少启动目录", func(opts *Options) { opts.StartupDir = "" }},
		{"互斥选项", func(opts *Options) { opts.Show, opts.Remove = true, true }},
		{"命令过长", func(opts *Options) { opts.Exe = filepath.Join(filepath.Dir(opts.Exe), strings.Repeat("a", 261)+".exe") }},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			opts := base
			item.change(&opts)
			reg := newFakeRegistry()
			if _, err := Run(reg, opts); err == nil || len(reg.calls) != 0 {
				t.Error("无效参数必须在任何注册表访问前拒绝")
			}
		})
	}
	if _, err := Run(nil, base); err == nil {
		t.Error("空注册表接口必须拒绝")
	}
}

func TestRun注册表错误不伪装成功且保留其他值(t *testing.T) {
	opts := fakeOptions(t)
	denied := errors.New("替身拒绝访问")
	reg := newFakeRegistry()
	reg.getErr = denied
	if result, err := Run(reg, opts); !errors.Is(err, denied) || result.Installed || len(reg.calls) != 1 {
		t.Error("读取失败不能覆盖或报已安装", err)
	}
	reg = newFakeRegistry()
	reg.setErr = denied
	if result, err := Run(reg, opts); !errors.Is(err, denied) || result.Installed || len(reg.values) != 0 {
		t.Error("写入失败不能报已安装", err)
	}
	reg = newFakeRegistry()
	reg.deleteErr = denied
	opts.Remove = true
	if _, err := Run(reg, opts); !errors.Is(err, denied) {
		t.Error("卸载访问拒绝不能当作不存在", err)
	}
	reg = newFakeRegistry()
	reg.getErr = denied
	opts.Remove, opts.Show = false, true
	if _, err := Run(reg, opts); !errors.Is(err, denied) {
		t.Error("查看访问拒绝必须返回错误", err)
	}
}

func TestHome名称大小写规范化且实例隔离(t *testing.T) {
	opts := fakeOptions(t)
	first, err := nameForHome(opts.Home)
	if err != nil {
		t.Fatal("生成实验目录名字失败", err)
	}
	for _, alias := range []string{strings.ToUpper(opts.Home), opts.Home + `\.`, filepath.ToSlash(opts.Home)} {
		value, err := nameForHome(alias)
		if err != nil || value != first {
			t.Error("同目录不同写法应使用同一自启值", err)
		}
	}
	other, err := nameForHome(opts.Home + "-other")
	if err != nil || other == first {
		t.Error("不同 home 必须隔离自启值", err)
	}
	if !validValueName(first) || validValueName("other-app") || validValueName(valuePrefix+strings.Repeat("z", 64)) {
		t.Error("适配器必须严格限制本应用哈希名字")
	}
}

func Test路径引用兼容Windows参数规则(t *testing.T) {
	for _, path := range []string{`F:\`, `F:\path with spaces\`, `F:\中文 目录\shell.exe`, `F:\x & y\shell.exe`, `F:\百分号%USERPROFILE%\shell.exe`} {
		quoted := quotePath(path)
		if !strings.HasPrefix(quoted, `"`) || !strings.HasSuffix(quoted, `"`) {
			t.Error("路径必须总是完整带引号")
		}
		if strings.ContainsAny(path, " \t") && quoted != syscall.EscapeArg(path) {
			t.Errorf("带空格路径必须与Windows EscapeArg一致，路径=%q", path)
		}
	}
	if quotePath(`F:\`) != `"F:\\"` {
		t.Error("根目录末尾反斜线必须翻倍，否则会吞掉闭合引号")
	}
}
