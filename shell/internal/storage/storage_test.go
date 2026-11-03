// 本文件用临时目录验证状态断写恢复、损坏保留、无效拒绝和原子替换边界。
package storage

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testState 模拟需要整体提交的壳子状态，避免测试依赖真实配置或秘密。
type testState struct {
	// Version 标记已提交发布物。
	Version string `json:"version"`
	// PID 模拟已核验子进程身份的一部分。
	PID int `json:"pid"`
}

func TestReadJSONRecoversInterruptedWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	first := testState{Version: "first", PID: 101}
	if err := WriteJSON(path, first); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(path, testState{Version: "second", PID: 202}); err != nil {
		t.Fatal(err)
	}
	//M 模拟主文件被外部旧写入器截断，已知有效备份必须保持可读。
	broken := []byte(`{"version":"interrupted",`)
	mustWrite(t, path, broken)
	var got testState
	recovered, err := ReadJSON(path, &got)
	if err != nil || !recovered || got != first {
		t.Fatalf("备份恢复不符合预期: recovered=%v got=%+v err=%v", recovered, got, err)
	}
	if string(mustRead(t, path)) != string(broken) {
		t.Fatal("读取恢复不应隐式修复或覆盖磁盘")
	}
}

func TestWriteJSONKeepsGoodBackupWhenMainIsBroken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := WriteJSON(path, testState{Version: "known-good"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(path, testState{Version: "next"}); err != nil {
		t.Fatal(err)
	}
	backup := string(mustRead(t, path+".bak"))
	broken := []byte(`{"version":`)
	mustWrite(t, path, broken)
	if err := WriteJSON(path, testState{Version: "repaired"}); err != nil {
		t.Fatal(err)
	}
	if string(mustRead(t, path+".bak")) != backup {
		t.Fatal("坏主文件不允许覆盖已知有效备份")
	}
	if string(mustRead(t, path+".bad")) != string(broken) {
		t.Fatal("没有原样保留坏主文件")
	}
	var got testState
	if recovered, err := ReadJSON(path, &got); err != nil || recovered || got.Version != "repaired" {
		t.Fatalf("修复后的主文件读取失败: %+v %v %v", got, recovered, err)
	}
}

func TestReadJSONRejectsInvalidWithoutChangingOutput(t *testing.T) {
	cases := []struct {
		// name 说明损坏形态。
		name string
		// main 与 backup 分别模拟主、备文件，空字符串表示不存在。
		main string
		backup string
	}{
		{name: "半写且无备份", main: `{"version":`},
		{name: "主备均坏", main: `no-json`, backup: `{"pid":`},
		{name: "主缺失备份坏", backup: `broken`},
		{name: "null拒绝", main: `null`},
		{name: "类型不符", main: `{"version":"partial","pid":"bad"}`},
		{name: "多值拒绝", main: `{} {}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.json")
			if tc.main != "" {
				mustWrite(t, path, []byte(tc.main))
			}
			if tc.backup != "" {
				mustWrite(t, path+".bak", []byte(tc.backup))
			}
			original := testState{Version: "unchanged", PID: 777}
			got := original
			recovered, err := ReadJSON(path, &got)
			if err == nil || errors.Is(err, os.ErrNotExist) || recovered || got != original {
				t.Fatalf("无效输入不得降级为空状态: %+v %v %v", got, recovered, err)
			}
		})
	}
}

func TestReadJSONMissingAndInvalidDestination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.json")
	got := testState{Version: "keep"}
	if recovered, err := ReadJSON(path, &got); recovered || !errors.Is(err, os.ErrNotExist) || got.Version != "keep" {
		t.Fatalf("主备均缺失应返回 ErrNotExist 且不修改输出: %+v %v %v", got, recovered, err)
	}
	for _, out := range []any{nil, testState{}, (*testState)(nil)} {
		if _, err := ReadJSON(path, out); err == nil {
			t.Fatal("无效输出参数应拒绝")
		}
	}
}

func TestWriteJSONRejectsInvalidBeforeTouchingFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := WriteJSON(path, testState{Version: "original"}); err != nil {
		t.Fatal(err)
	}
	before := string(mustRead(t, path))
	for _, value := range []any{nil, json.RawMessage(`null`), json.RawMessage(`{"half":`), make(chan int)} {
		if err := WriteJSON(path, value); err == nil {
			t.Fatal("无效新状态应被拒绝")
		}
		if string(mustRead(t, path)) != before {
			t.Fatal("拒绝新状态时改动了主文件")
		}
	}
	if _, err := os.Stat(path+".bak"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("无效写入不应创建备份: %v", err)
	}
}

func TestAtomicWriteReplacesAndCleansTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	mustWrite(t, path, []byte("old"))
	if err := AtomicWrite(path, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if string(mustRead(t, path)) != "new" {
		t.Fatal("目标没有替换")
	}
	//G 目标是目录时改名失败，不允许删除目录或遗留临时文件。
	blocked := filepath.Join(dir, "blocked")
	if err := os.Mkdir(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(blocked, []byte("reject"), 0600); err == nil {
		t.Fatal("目录目标应拒绝")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Fatalf("遗留临时文件: %s", entry.Name())
		}
	}
}

func TestRenameRetriesAreBounded(t *testing.T) {
	busy := errors.New("模拟共享占用")
	attempts := 0
	var delays []time.Duration
	err := retryRename(func() error {
		attempts++
		return busy
	}, func(error) bool { return true }, func(delay time.Duration) { delays = append(delays, delay) })
	if !errors.Is(err, busy) || attempts != 6 || len(delays) != 5 {
		t.Fatalf("重试未按上界退出: attempts=%d delays=%v err=%v", attempts, delays, err)
	}
	total := time.Duration(0)
	for _, delay := range delays {
		total += delay
	}
	if total != 310*time.Millisecond {
		t.Fatalf("退避总时长不符: %v", total)
	}
	attempts = 0
	err = retryRename(func() error {
		attempts++
		return busy
	}, func(error) bool { return false }, func(time.Duration) { t.Fatal("永久错误不应等待") })
	if attempts != 1 || !errors.Is(err, busy) {
		t.Fatal("永久错误不应重试")
	}
	attempts = 0
	err = retryRename(func() error {
		attempts++
		if attempts < 3 {
			return busy
		}
		return nil
	}, func(error) bool { return true }, func(time.Duration) {})
	if err != nil || attempts != 3 {
		t.Fatal("占用解除后应立即成功")
	}
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
