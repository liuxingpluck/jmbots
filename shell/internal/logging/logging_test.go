// 本文件用 t.TempDir 验证真实 5 MiB 轮转、并发写入、尾部读取和文本脱敏；不启动网络或子进程。
package logging

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestWriterRotatesActualFiveMiBAndKeepsFiveFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shell.log")
	writer, err := New(path, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	//M 每块恰好 5 MiB；末次大 Write 还包含尾部行，必须跨文件分块。
	block := bytes.Repeat([]byte("ordinary log record\n"), int(DefaultMaxBytes)/20+1)
	block = block[:int(DefaultMaxBytes)]
	for number := 0; number < 6; number++ {
		if n, err := writer.Write(block); err != nil || n != len(block) {
			t.Fatalf("第 %d 块写入失败: n=%d err=%v", number, n, err)
		}
	}
	last := append(append([]byte(nil), block...), []byte("\none\ntwo\nthree\n")...)
	if n, err := writer.Write(last); err != nil || n != len(last) {
		t.Fatalf("大 Write 失败: %d %v", n, err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != DefaultKeep {
		t.Fatalf("应仅保留 current 加四份归档，实际 %d", len(entries))
	}
	for number := 0; number < DefaultKeep; number++ {
		name := path
		if number > 0 {
			name = archivePath(path, number)
		}
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() > DefaultMaxBytes || (number > 0 && info.Size() != DefaultMaxBytes) {
			t.Fatalf("轮转文件大小错误: number=%d size=%d", number, info.Size())
		}
	}
	got, err := Tail(path, 2)
	if err != nil || got != "two\nthree\n" {
		t.Fatalf("轮转后 Tail 错误: %q %v", got, err)
	}
}

func TestWriterConcurrentWritesRemainComplete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "concurrent.log")
	writer, err := New(path, 512, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	// workers 在同一 Writer 上并发追加完整记录，轮转后跨文件拼接不得丢行或串行。
	const workers, records = 8, 30
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func(worker int) {
			defer group.Done()
			for record := 0; record < records; record++ {
				line := fmt.Sprintf("worker-%02d-record-%03d\n", worker, record)
				if n, err := writer.Write([]byte(line)); err != nil || n != len(line) {
					t.Errorf("并发写入失败: %d %v", n, err)
					return
				}
			}
		}(worker)
	}
	group.Wait()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	text, err := Tail(path, 1000)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		if seen[line] {
			t.Fatalf("重复记录: %q", line)
		}
		seen[line] = true
	}
	if len(seen) != workers*records {
		t.Fatalf("行数错误: %d", len(seen))
	}
	for worker := 0; worker < workers; worker++ {
		for record := 0; record < records; record++ {
			if !seen[fmt.Sprintf("worker-%02d-record-%03d", worker, record)] {
				t.Fatalf("记录缺失: worker=%d record=%d", worker, record)
			}
		}
	}
}

func TestTailJoinsLinesAcrossArchivesAndRedacts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "child.log")
	//M 模拟轮转恰好拆开凭据值；Tail 必须先拼接再脱敏，不只过滤单个文件。
	writeLogTestFile(t, path+".2", "old\naccess_token=pretend-")
	writeLogTestFile(t, path+".1", "private\nsecond\n")
	writeLogTestFile(t, path, "third\nlast")
	got, err := Tail(path, 4)
	if err != nil || strings.Contains(got, "pretend-private") || !strings.Contains(got, "[REDACTED]") || !strings.HasSuffix(got, "second\nthird\nlast") {
		t.Fatalf("跨归档读取脱敏错误: %q %v", got, err)
	}
	got, err = Tail(path, 1)
	if err != nil || got != "last" {
		t.Fatalf("无末尾换行的最后一行错误: %q %v", got, err)
	}
}

func TestTailLimitsMissingAndBlankLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tail.log")
	if _, err := Tail(path, 2); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("缺失日志应返回原始错误: %v", err)
	}
	if got, err := Tail(path, 0); got != "" || err != nil {
		t.Fatalf("零行应直接返回空文本: %q %v", got, err)
	}
	for _, lines := range []int{-1, 10001} {
		if _, err := Tail(path, lines); err == nil {
			t.Fatalf("非法行数没有拒绝: %d", lines)
		}
	}
	writeLogTestFile(t, path, "first\n\nlast\n")
	if got, err := Tail(path, 2); err != nil || got != "\nlast\n" {
		t.Fatalf("空行计数错误: %q %v", got, err)
	}
	writeLogTestFile(t, path, strings.Repeat("x", tailMaxBytes+1))
	if got, err := Tail(path, 2); err == nil || got != "" {
		t.Fatal("超长单行应报错，不能返回半行")
	}
}

func TestRedactCommonShapesWithoutReadingSecrets(t *testing.T) {
	cases := []struct {
		// text 全部是虚构测试字符串，不来自环境或配置。
		text string
		// hidden 是不得出现在输出中的虚构值。
		hidden []string
	}{
		{text: "Bearer pretend.one-two", hidden: []string{"pretend.one-two"}},
		{text: "Authorization: Bearer pretend-bearer\nnext", hidden: []string{"pretend-bearer"}},
		{text: "authorization: Basic pretend-base64\n", hidden: []string{"pretend-base64"}},
		{text: "Cookie: a=pretend-one; b=pretend-two\n", hidden: []string{"pretend-one", "pretend-two"}},
		{text: `{"api_key":"pretend api value","clientSecret":"pretend-secret"}`, hidden: []string{"pretend api value", "pretend-secret"}},
		{text: `password='pretend password' access_token=pretend-token&safe=yes`, hidden: []string{"pretend password", "pretend-token"}},
		{text: `https://example.invalid/?refresh_token=pretend-refresh&x=1`, hidden: []string{"pretend-refresh"}},
	}
	for _, tc := range cases {
		got := Redact(tc.text)
		if !strings.Contains(got, "[REDACTED]") {
			t.Fatalf("未产生脱敏标记: %q", got)
		}
		for _, hidden := range tc.hidden {
			if strings.Contains(got, hidden) {
				t.Fatalf("虚构秘密未遮蔽: %q", got)
			}
		}
	}
	if got := Redact("pid=123 mode=candidate ok=true"); got != "pid=123 mode=candidate ok=true" {
		t.Fatalf("普通信息不应改变: %q", got)
	}
}

func TestWriterCloseDefaultsAndSingleFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "one.log")
	for _, args := range []struct {
		// maxBytes 与 keep 是需要被拒绝的参数组合。
		maxBytes int64
		keep int
	}{{-1, 1}, {1, -1}} {
		if _, err := New(path, args.maxBytes, args.keep); err == nil {
			t.Fatal("负参数必须拒绝")
		}
	}
	writer, err := New(path, 8, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err := writer.Write([]byte("12345678last")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("after")); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("关闭后应拒绝: %v", err)
	}
	if got := string(readLogTestFile(t, path)); got != "last" {
		t.Fatalf("单份轮转错误: %q", got)
	}
	if _, err := os.Stat(path+".1"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("keep=1 不应创建归档")
	}
}

func TestOpenChildCanRotateWhileHandleStaysOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "serve.log")
	file, err := OpenChild(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	before := bytes.Repeat([]byte("a"), int(DefaultMaxBytes)+17)
	if _, err := file.Write(before); err != nil {
		t.Fatal(err)
	}
	if err := RotateChild(path, 0, 0); err != nil {
		t.Fatal(err)
	}
	archive := readLogTestFile(t, path+".1")
	if int64(len(archive)) != DefaultMaxBytes || !bytes.Equal(archive, before[17:]) {
		t.Fatal("有界快照应只保留最后 5 MiB")
	}
	//G 截断之后继续用同一追加句柄，不应在旧偏移产生 5 MiB 的空洞。
	if _, err := file.Write([]byte("after\n")); err != nil {
		t.Fatal(err)
	}
	if got := readLogTestFile(t, path); string(got) != "after\n" {
		start := len(got) - 64
		if start < 0 {
			start = 0
		}
		t.Fatalf("活跃追加句柄截断后写入错误: len=%d tail=%q", len(got), got[start:])
	}
	if err := RotateChild(path, 0, 0); err != nil {
		t.Fatal(err)
	}
	//M 归档中的 a 没有换行，因此跨归档 Tail 的最后一行包含 a 前缀；上面已单独验证 current 无空洞。
	if got, err := Tail(path, 1); err != nil || len(got) != int(DefaultMaxBytes)+len("after\n") || !strings.HasSuffix(got, "after\n") {
		start := len(got) - 64
		if start < 0 {
			start = 0
		}
		t.Fatalf("活跃句柄下跨归档读取失败: len=%d tail=%q err=%v", len(got), got[start:], err)
	}
}

func TestRotateChildRetainsOnlyRequestedArchives(t *testing.T) {
	path := filepath.Join(t.TempDir(), "serve.log")
	file, err := OpenChild(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for number := 0; number < 7; number++ {
		if _, err := file.Write([]byte(fmt.Sprintf("%08d", number))); err != nil {
			t.Fatal(err)
		}
		if err := RotateChild(path, 8, 3); err != nil {
			t.Fatal(err)
		}
	}
	if got := string(readLogTestFile(t, path+".1")); got != "00000006" {
		t.Fatalf("最新快照错误: %q", got)
	}
	if got := string(readLogTestFile(t, path+".2")); got != "00000005" {
		t.Fatalf("上一快照错误: %q", got)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 3 {
		t.Fatalf("归档数量或临时文件清理错误: %d %v", len(entries), err)
	}
}

func writeLogTestFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func readLogTestFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
