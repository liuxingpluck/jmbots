//go:build windows

// 本文件只覆盖自建临时文件、互斥量与纯解析逻辑；运行统一由 lead 在 F 盘实验副本执行。
package winproc

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"unicode/utf16"
)

func experimentHome(t *testing.T) string {
	t.Helper()
	//G 环境未正确隔离时直接失败，避免 t.TempDir 落到 C 盘或真实运行时。
	temporary, err := filepath.Abs(os.TempDir())
	if err != nil {
		t.Fatal("无法解析实验临时目录", err)
	}
	root := filepath.Clean(`F:\aidata\cache\jmshell_exp`)
	relative, err := filepath.Rel(root, temporary)
	if err != nil || relative == ".." || strings.HasPrefix(relative, `..\`) || filepath.IsAbs(relative) {
		t.Fatal("测试仅可使用 F 盘 jmshell_exp 实验临时目录")
	}
	return t.TempDir()
}

func TestName规范化及用途隔离(t *testing.T) {
	home := experimentHome(t)
	name := Name(home, "instance")
	aliases := []string{strings.ToUpper(home), filepath.ToSlash(home), home + `\.`}
	for _, alias := range aliases {
		if got := Name(alias, " INSTANCE "); got != name {
			t.Errorf("同一实路径的大小写/分隔符别名应共用互斥量")
		}
	}
	if Name(home, "deploy") == name || Name(home+"-other", "instance") == name {
		t.Error("不同用途或目录不应共享互斥量")
	}
	if !strings.HasPrefix(name, `Local\jmbots-shell-`) || strings.Contains(strings.ToLower(name), strings.ToLower(home)) {
		t.Error("互斥量必须使用 Local 哈希，不泄露目录")
	}
}

func TestName符号链接实路径(t *testing.T) {
	home := experimentHome(t)
	real := filepath.Join(home, "real-home")
	alias := filepath.Join(home, "alias-home")
	if err := os.Mkdir(real, 0700); err != nil {
		t.Fatal("创建实验目录失败", err)
	}
	if err := os.Symlink(real, alias); err != nil {
		t.Skip("当前权限不能创建实验符号链接，实路径别名行为未验证", err)
	}
	if Name(real, "instance") != Name(alias, "instance") {
		t.Error("符号链接与实目录必须共用互斥量")
	}
}

func TestLock句柄生命周期跨协程释放(t *testing.T) {
	name := Name(experimentHome(t), "test-lock")
	first, err := Lock(name)
	if err != nil {
		t.Fatal("首次获取互斥量失败", err)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := Lock(name)
	if second != nil {
		_ = second.Close()
		t.Error("同名互斥量重复获取不应成功")
	}
	if !errors.Is(err, ErrLocked) {
		t.Errorf("重复获取应返回 ErrLocked，实际为 %v", err)
	}
	closed := make(chan error, 1)
	go func() { closed <- first.Close() }()
	if err := <-closed; err != nil {
		t.Fatal("跨协程释放不应依赖 OS 线程归属", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal("重复关闭必须幂等", err)
	}
	third, err := Lock(name)
	if err != nil {
		t.Fatal("最后一个句柄关闭后应能重新获取", err)
	}
	if err := third.Close(); err != nil {
		t.Fatal("关闭重新获取的互斥量失败", err)
	}
	for _, invalid := range []string{"", `Global\unsafe`, `Local\`, `Local\nested\name`} {
		if lease, err := Lock(invalid); err == nil {
			_ = lease.Close()
			t.Error("非法互斥量名称必须拒绝")
		}
	}
}

func TestPrivateFile首次创建即私有且不覆盖(t *testing.T) {
	path := filepath.Join(experimentHome(t), "private-sample.bin")
	file, err := CreatePrivateFile(path)
	if err != nil {
		t.Fatal("创建实验私有文件失败", err)
	}
	t.Cleanup(func() { _ = file.Close() })
	descriptor, err := currentPrivateDescriptor()
	if err != nil {
		t.Fatal("构造当前用户安全描述符失败", err)
	}
	defer descriptor.close()
	//G 不先写再收紧；在首次写之前检查真实内核 DACL 及禁止继承标志。
	if err := verifyPrivateDACL(syscall.Handle(file.Fd()), descriptor.acl); err != nil {
		t.Fatal("首次写之前文件必须已仅授予当前用户", err)
	}
	if _, err := file.WriteString("非敏感实验样本"); err != nil {
		t.Fatal("写入自建实验文件失败", err)
	}
	if err := file.Sync(); err != nil {
		t.Fatal("同步实验文件失败", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal("关闭实验文件失败", err)
	}
	if duplicate, err := CreatePrivateFile(path); err == nil {
		_ = duplicate.Close()
		t.Fatal("已有文件必须拒绝覆盖")
	}
	if err := ProtectFile(path); err != nil {
		t.Fatal("重复保护实验文件应保持有效", err)
	}
}

func TestProtectFile拒绝目录硬链接与ADS(t *testing.T) {
	home := experimentHome(t)
	if err := ProtectFile(home); err == nil {
		t.Error("不得把目录当作私有文件修改权限")
	}
	if file, err := CreatePrivateFile(filepath.Join(home, "sample.bin:alternate")); err == nil {
		_ = file.Close()
		t.Error("备用数据流必须拒绝")
	}
	path := filepath.Join(home, "hardlink-source.bin")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal("创建非敏感实验文件失败", err)
	}
	alias := filepath.Join(home, "hardlink-alias.bin")
	if err := os.Link(path, alias); err != nil {
		t.Fatal("创建实验硬链接失败", err)
	}
	if err := ProtectFile(path); err == nil {
		t.Error("多硬链接文件不得被权限函数误改")
	}
}

func TestPrivateFile拒绝Reparse文件与父目录(t *testing.T) {
	home := experimentHome(t)
	real := filepath.Join(home, "real")
	if err := os.Mkdir(real, 0700); err != nil {
		t.Fatal("创建实验目录失败", err)
	}
	alias := filepath.Join(home, "linked")
	if err := os.Symlink(real, alias); err != nil {
		t.Skip("当前权限不能创建实验符号链接，reparse 实测未覆盖", err)
	}
	if file, err := CreatePrivateFile(filepath.Join(alias, "private-sample.bin")); err == nil {
		_ = file.Close()
		t.Error("reparse 父目录必须拒绝")
	}
	original := filepath.Join(real, "sample.bin")
	if err := os.WriteFile(original, nil, 0600); err != nil {
		t.Fatal("创建实验空文件失败", err)
	}
	linkedFile := filepath.Join(home, "linked-sample.bin")
	if err := os.Symlink(original, linkedFile); err != nil {
		t.Fatal("创建实验文件链接失败", err)
	}
	if err := ProtectFile(linkedFile); err == nil {
		t.Error("reparse 文件必须拒绝")
	}
}

func TestTCP表解析IPv4和IPv6及损坏数据(t *testing.T) {
	for _, family := range []uint32{2, 23} {
		rowSize, stateOffset, portOffset, pidOffset := 24, 0, 8, 20
		if family == 23 {
			rowSize, stateOffset, portOffset, pidOffset = 56, 48, 20, 52
		}
		table := make([]byte, 4+3*rowSize)
		binary.LittleEndian.PutUint32(table, 3)
		for index := 0; index < 3; index++ {
			row := table[4+index*rowSize:]
			binary.LittleEndian.PutUint32(row[stateOffset:], 2)
			binary.BigEndian.PutUint16(row[portOffset:], 30091)
			binary.LittleEndian.PutUint32(row[pidOffset:], uint32(100+index))
		}
		binary.BigEndian.PutUint16(table[4+rowSize+portOffset:], 30092)
		pids, err := parseTCPTable(table, family, 30091)
		if err != nil || !reflect.DeepEqual(pids, []uint32{100, 102}) {
			t.Errorf("地址族 %d 必须保留同端口全部监听者，结果 %v，错误 %v", family, pids, err)
		}
		binary.LittleEndian.PutUint32(table[4+2*rowSize+pidOffset:], 0)
		if _, err := parseTCPTable(table, family, 30091); err == nil {
			t.Error("监听者缺少 PID 时必须整体失败")
		}
		binary.LittleEndian.PutUint32(table, 4)
		if _, err := parseTCPTable(table, family, 30091); err == nil {
			t.Error("超长行计数必须拒绝")
		}
	}
	if _, err := parseTCPTable(nil, 2, 30091); err == nil {
		t.Error("缺失表头必须拒绝")
	}
	for _, port := range []int{-1, 0, 65536} {
		if _, err := listenerPIDs(port); err == nil {
			t.Error("无效端口必须在查询系统前拒绝")
		}
	}
}

func TestEnvironmentBlock排序去重双零结尾(t *testing.T) {
	block, err := environmentBlock([]string{"B=two", "a=old", "A=new", "=F:=F:\\experiment"})
	if err != nil {
		t.Fatal("构造非敏感实验环境失败", err)
	}
	decoded := string(utf16.Decode(block))
	if decoded != "=F:=F:\\experiment\x00A=new\x00B=two\x00\x00" {
		t.Error("环境块必须不区分大小写去重、排序并双零终止")
	}
	empty, err := environmentBlock([]string{})
	if err != nil || !reflect.DeepEqual(empty, []uint16{0, 0}) {
		t.Error("空环境必须是双零块")
	}
	for _, invalid := range []string{"without-equals", "=", "A=bad\x00value"} {
		if _, err := environmentBlock([]string{invalid}); err == nil {
			t.Error("无效环境项必须拒绝，且不回显原值")
		}
	}
}

func TestIdentity三元匹配防PID复用(t *testing.T) {
	identity := Identity{PID: 100, Created: 12345, Path: `F:\experiment\backend.exe`}
	alias := identity
	alias.Path = `\\?\F:\EXPERIMENT\backend.exe`
	if !sameIdentity(identity, alias) {
		t.Error("Windows 路径等价形式应匹配")
	}
	for _, changed := range []Identity{
		{PID: 101, Created: identity.Created, Path: identity.Path},
		{PID: identity.PID, Created: identity.Created + 1, Path: identity.Path},
		{PID: identity.PID, Created: identity.Created, Path: `F:\experiment\other.exe`},
	} {
		if sameIdentity(identity, changed) {
			t.Error("任一身份字段改变必须拒绝")
		}
	}
}
