// 本文件只按文本形态脱敏，不读取配置、环境变量或任何实际凭据。
package logging

import "regexp"

// bearerPattern 覆盖通用 Authorization Bearer 及直接打印的 Bearer 值。
var bearerPattern = regexp.MustCompile(`(?i)\bBearer[ \t]+[A-Za-z0-9._~+/=-]+`)

// headerPattern 整行遮蔽认证和 Cookie 头，避免 Basic 及多段 Cookie 只遮蔽首个词。
var headerPattern = regexp.MustCompile(`(?im)(\b(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]+`)

// secretPattern 保守遮蔽 JSON、键值日志和查询串中的常见秘密键及其值。
var secretPattern = regexp.MustCompile(`(?i)(["']?\b[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|authorization|cookie)[A-Za-z0-9_.-]*["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)`)

// Redact 遮蔽完整文本中的 Bearer 和常见秘密键；不会推测未标记的随机字符串。
// 这是防御性输出过滤，不是绝对泄密检测；跨 Write 拆开的秘密须在调用前拼成完整记录。
func Redact(text string) string {
	text = headerPattern.ReplaceAllString(text, `${1}"[REDACTED]"`)
	text = bearerPattern.ReplaceAllString(text, "Bearer [REDACTED]")
	return secretPattern.ReplaceAllString(text, `${1}"[REDACTED]"`)
}
