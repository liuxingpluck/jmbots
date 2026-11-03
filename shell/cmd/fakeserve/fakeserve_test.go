// 本文件只测试参数、健康处理器和无网络检查命令，不打开端口，不启动任何子进程。
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProfilesMatchFrozenReleaseContract(t *testing.T) {
	cases := []struct {
		// profile 是脚本通过 -X main.profile 冻结的档案名。
		profile string
		// official 与 candidate 分别为两种模式的预期行为。
		official string
		candidate string
		// healthyAfter 与 crashAfter 是档案内置延迟。
		healthyAfter time.Duration
		crashAfter time.Duration
	}{
		{profile: "normal", official: "normal", candidate: "normal"},
		{profile: "official-crash", official: "crash", candidate: "normal"},
		{profile: "candidate-crash", official: "normal", candidate: "crash"},
		{profile: "crash", official: "crash", candidate: "crash"},
		{profile: "delayed", official: "normal", candidate: "normal", healthyAfter: 2 * time.Second},
		{profile: "crash-later", official: "normal", candidate: "normal", crashAfter: 2 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.profile, func(t *testing.T) {
			for _, mode := range []string{"official", "candidate"} {
				options, err := parseServe([]string{"--port", "30091", "--host", "127.0.0.1", "--mode", mode}, tc.profile)
				if err != nil {
					t.Fatal(err)
				}
				want := tc.official
				if mode == "candidate" {
					want = tc.candidate
				}
				if options.behavior != want || options.healthyAfter != tc.healthyAfter || options.crashAfter != tc.crashAfter {
					t.Fatalf("冻结档案行为错误: %+v", options)
				}
			}
		})
	}
	if _, err := profileOptions("typo"); err == nil {
		t.Fatal("未知档案应拒绝")
	}
}

func TestServeFlagsOverrideProfileAndModeDefaults(t *testing.T) {
	options, err := parseServe([]string{"--port", "30092", "--behavior", "normal"}, "official-crash")
	if err != nil || options.behavior != "normal" {
		t.Fatalf("显式通用行为没有覆盖档案: %+v %v", options, err)
	}
	options, err = parseServe([]string{
		"--port", "30093", "--host", "localhost", "--mode", "candidate",
		"--behavior", "unhealthy", "--candidate-behavior", "hold", "--official-behavior", "crash",
		"--healthy-after", "12ms", "--crash-after", "34ms", "--ignore-terminate", "--child-port", "30097",
	}, "normal")
	if err != nil {
		t.Fatal(err)
	}
	if options.behavior != "hold" || options.host != "127.0.0.1" || options.healthyAfter != 12*time.Millisecond || options.crashAfter != 34*time.Millisecond || !options.ignoreTerminate || options.childPort != 30097 {
		t.Fatalf("参数覆盖错误: %+v", options)
	}
	options, err = parseServe([]string{"--port", "30094", "--healthy-after", "0s"}, "delayed")
	if err != nil || options.healthyAfter != 0 {
		t.Fatalf("显式零延迟未覆盖档案: %+v %v", options, err)
	}
}

func TestServeRejectsUnsafePortsAndInvalidInputsBeforeListening(t *testing.T) {
	cases := [][]string{
		{},
		{"--port", "0"},
		{"--port", "30085"},
		{"--port", "30086"},
		{"--port", "30087"},
		{"--port", "30090"},
		{"--port", "30098"},
		{"--port", "30091", "--child-port", "30086"},
		{"--port", "30091", "--child-port", "30091"},
		{"--port", "30091", "--host", "0.0.0.0"},
		{"--port", "30091", "--host", "example.invalid"},
		{"--port", "30091", "--mode", "typo"},
		{"--port", "30091", "--behavior", "typo"},
		{"--port", "30091", "--official-behavior", "typo"},
		{"--port", "30091", "--healthy-after", "-1s"},
		{"--port", "30091", "--crash-after", "-1s"},
		{"--port", "30091", "extra"},
	}
	for _, args := range cases {
		if _, err := parseServe(args, "normal"); err == nil {
			t.Fatalf("非法启动参数没有拒绝: %v", args)
		}
	}
	//M 边界端口只做参数解析，不监听；所有后续网络验收由 lead 串行安排。
	for _, port := range []string{"30091", "30092", "30093", "30094", "30095", "30096", "30097"} {
		if _, err := parseServe([]string{"--port", port, "--host", "::1"}, "normal"); err != nil {
			t.Fatalf("合法实验端口被拒绝: %s %v", port, err)
		}
	}
}

func TestHealthOnlyReturnsOKAfterDelay(t *testing.T) {
	started := time.Unix(1000, 0)
	current := started
	options := serveOptions{mode: "candidate", behavior: "normal", healthyAfter: time.Second}
	handler := newHealthHandler(options, started, 12345, func() time.Time { return current })
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:30091/api/health", nil)
	before := httptest.NewRecorder()
	handler.ServeHTTP(before, request)
	var reply healthReply
	if err := json.Unmarshal(before.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if before.Code != http.StatusServiceUnavailable || reply.OK || reply.PID != 12345 || reply.Mode != "candidate" {
		t.Fatalf("延迟前健康错误: code=%d reply=%+v", before.Code, reply)
	}
	current = started.Add(time.Second)
	after := httptest.NewRecorder()
	handler.ServeHTTP(after, request)
	if err := json.Unmarshal(after.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if after.Code != http.StatusOK || !reply.OK || reply.PID != 12345 || reply.Mode != "candidate" {
		t.Fatalf("延迟后健康错误: code=%d reply=%+v", after.Code, reply)
	}
}

func TestHealthRejectsOtherRoutesAndUnhealthyModes(t *testing.T) {
	for _, behavior := range []string{"unhealthy", "hold", "crash"} {
		handler := newHealthHandler(serveOptions{mode: "official", behavior: behavior}, time.Time{}, 1, time.Now)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:30091/api/health", nil))
		if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"ok":false`) {
			t.Fatalf("异常行为不应健康: %s %d %s", behavior, recorder.Code, recorder.Body.String())
		}
	}
	handler := newHealthHandler(serveOptions{mode: "official", behavior: "normal"}, time.Time{}, 1, time.Now)
	for _, path := range []string{"/", "/health", "/api/health/", "/api/status"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:30091"+path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("非健康路径应404: %s %d", path, recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "http://127.0.0.1:30091/api/health", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatal("健康路径只允许 GET")
	}
}

func TestCheckCommandHasNoNetworkAndPreservesExitCode(t *testing.T) {
	options, err := parseCheck([]string{"--exit", "9", "--delay", "125ms"})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	var waited time.Duration
	code := runCheck(options, &output, func(delay time.Duration) { waited += delay })
	if code != 9 || waited != 125*time.Millisecond || !strings.Contains(output.String(), "exit=9") {
		t.Fatalf("检查命令错误: code=%d waited=%s output=%q", code, waited, output.String())
	}
	for _, args := range [][]string{{"--exit", "-1"}, {"--exit", "256"}, {"--delay", "-1s"}, {"extra"}} {
		if _, err := parseCheck(args); err == nil {
			t.Fatalf("非法检查参数应拒绝: %v", args)
		}
	}
	var stderr bytes.Buffer
	if code := run([]string{"check", "--exit", "7", "--delay", "0s"}, &output, &stderr); code != 7 {
		t.Fatalf("命令路由未返回指定退出码: %d", code)
	}
	if code := run([]string{"unknown"}, &output, &stderr); code != 2 {
		t.Fatalf("未知命令应返回2: %d", code)
	}
}

func TestGrandchildCommandUsesOnlyExplicitFilesAndSafeArguments(t *testing.T) {
	//M 只构造命令，不创建临时 exe、不启动进程；可执行名使用虚构路径。
	command := childCommand("fake-fixture.exe", serveOptions{host: "127.0.0.1", mode: "candidate", childPort: 30097, behavior: "hold"})
	if command.Stdin != os.Stdin || command.Stdout != os.Stdout || command.Stderr != os.Stderr {
		t.Fatal("孙进程必须直连标准文件，不建立排空管道")
	}
	args := strings.Join(command.Args, " ")
	for _, fragment := range []string{"serve --port 30097", "--mode candidate", "--behavior normal", "--candidate-behavior normal", "--official-behavior normal", "--crash-after 0s", "--child-port 0", "--ignore-terminate"} {
		if !strings.Contains(args, fragment) {
			t.Fatalf("孙进程参数缺失: %s", fragment)
		}
	}
}
