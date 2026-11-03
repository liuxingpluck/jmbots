// 本文件实现唯一健康路由；处理器可直接单元测试，不需要打开监听端口。
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// healthReply 是假后端健康响应，便于壳子同时核对健康、PID 与启动模式。
type healthReply struct {
	// OK 只有正常且达到延迟时才为 true。
	OK bool `json:"ok"`
	// PID 是当前处理健康请求的进程号，不代表单独通过了 Job 归属验证。
	PID int `json:"pid"`
	// Mode 表明 official 或 candidate。
	Mode string `json:"mode"`
}

func newHealthHandler(options serveOptions, started time.Time, pid int, now func() time.Time) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		//G 不注册 /health、根页、管理入口等替代路由，避免误将未知接口当作健康。
		if request.URL.Path != "/api/health" {
			http.NotFound(writer, request)
			return
		}
		if request.Method != http.MethodGet {
			writer.Header().Set("Allow", http.MethodGet)
			http.Error(writer, "只允许 GET", http.StatusMethodNotAllowed)
			return
		}
		healthy := options.behavior == "normal" && now().Sub(started) >= options.healthyAfter
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		if !healthy {
			writer.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(writer).Encode(healthReply{OK: healthy, PID: pid, Mode: options.mode})
	})
}
