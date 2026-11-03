// autostart 将每个壳子目录的登录自启配置与可替换注册表接口分离；不操作任务管理器禁用标记。
package autostart

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf16"
)

// ErrNotExist 表示指定自启值或 Run 键不存在，不表示访问拒绝。
var ErrNotExist = errors.New("自启注册表值不存在")

// Registry 仅操作当前用户 Run 键的具名字符串值，测试使用内存替身。
type Registry interface {
	// Get 查询单个值；不存在时返回 ErrNotExist。
	Get(name string) (string, error)
	// Set 设置单个值，不应改动其他值或 StartupApproved。
	Set(name, value string) error
	// Delete 删除单个值；不存在时返回 ErrNotExist 或 nil。
	Delete(name string) error
}

// Options 指定自启命令及操作模式；默认安装，Remove 和 Show 互斥。
type Options struct {
	// Exe 是待启动的绝对 .exe 路径，仅安装时必填。
	Exe string
	// Home 是壳子目录绝对路径，用于命令参数及隔离自启值名。
	Home string
	// StartupDir 是调用方明确给出的启动目录；安装和查看必填，不自动探测真实系统目录。
	StartupDir string
	// Remove 仅删除当前 Home 的 Run 值，不检查或删除旧 VBS。
	Remove bool
	// Show 只查询状态并提示旧 VBS，不写注册表。
	Show bool
}

// Result 描述本 Home 的 Run 值，不把 Run 值存在等同于任务管理器允许启动。
type Result struct {
	// Installed 仅表示本 Home 的 Run 值存在或本次设置成功。
	Installed bool
	// Command 是实际 Run 命令；卸载成功或不存在时为空。
	Command string
	// Warning 提示旧守护脚本、检查失败或用户禁用状态未被修改。
	Warning string
}

const valuePrefix = "jmbots-shell-"

const approvalWarning = "仅管理当前用户 Run 值；不读取或修改 StartupApproved。若用户已在任务管理器禁用，请由用户自行启用。"

// Run 通过 reg 安装、卸载或查询自启；不启动进程，不读 VBS 内容，也不探测真实 Startup 路径。
// 安装遇到旧 jmbots_Guard.vbs（含链接、目录等同名对象）或检查失败时拒绝写入。
func Run(reg Registry, opts Options) (Result, error) {
	if reg == nil {
		return Result{}, fmt.Errorf("必须提供注册表接口")
	}
	if opts.Remove && opts.Show {
		return Result{}, fmt.Errorf("卸载和查看选项不能同时使用")
	}
	home, err := normalizePath(opts.Home, "壳子目录")
	if err != nil {
		return Result{}, err
	}
	name, err := nameForHome(home)
	if err != nil {
		return Result{}, err
	}
	if opts.Remove {
		//M 卸载不探测 Startup、不读取 VBS、不清除 StartupApproved，只删除本 Home 值。
		if err := reg.Delete(name); err != nil && !errors.Is(err, ErrNotExist) {
			return Result{}, fmt.Errorf("删除当前壳子的自启值失败: %w", err)
		}
		return Result{}, nil
	}
	startup, err := normalizePath(opts.StartupDir, "启动目录")
	if err != nil {
		return Result{}, err
	}
	warning, guardErr := legacyGuard(startup)
	if opts.Show {
		result := Result{Warning: joinWarning(warning, approvalWarning)}
		command, err := reg.Get(name)
		if err == nil {
			result.Installed, result.Command = true, command
		} else if !errors.Is(err, ErrNotExist) {
			return result, errors.Join(guardErr, fmt.Errorf("查询当前壳子的自启值失败: %w", err))
		}
		return result, guardErr
	}
	if guardErr != nil {
		return Result{Warning: warning}, guardErr
	}
	if warning != "" {
		return Result{Warning: warning}, fmt.Errorf("拒绝安装自启：检测到旧 jmbots_Guard.vbs，请先由用户确认停用旧守护脚本")
	}
	exe, err := normalizePath(opts.Exe, "可执行文件")
	if err != nil {
		return Result{}, err
	}
	if !strings.EqualFold(filepath.Ext(exe), ".exe") {
		return Result{}, fmt.Errorf("自启必须直接调用 .exe，不经过脚本或命令解释器")
	}
	command := quotePath(exe) + " --home " + quotePath(home)
	if err := validateCommand(command); err != nil {
		return Result{}, err
	}
	result := Result{Command: command, Warning: approvalWarning}
	existing, err := reg.Get(name)
	if err != nil && !errors.Is(err, ErrNotExist) {
		return result, fmt.Errorf("读取原有自启值失败，未覆盖: %w", err)
	}
	if err == nil && existing == command {
		result.Installed = true
		return result, nil
	}
	if err := reg.Set(name, command); err != nil {
		return result, fmt.Errorf("写入当前壳子的自启值失败: %w", err)
	}
	result.Installed = true
	return result, nil
}

func normalizePath(value, field string) (string, error) {
	if value == "" || !filepath.IsAbs(value) {
		return "", fmt.Errorf("%s必须是显式绝对路径", field)
	}
	for _, character := range value {
		if character == '"' || unicode.IsControl(character) || character == '\u2028' || character == '\u2029' {
			return "", fmt.Errorf("%s含引号、换行或控制字符，拒绝写入命令", field)
		}
	}
	path := filepath.Clean(value)
	//G 拒绝设备路径和备用数据流；普通本地或 UNC 绝对路径可用于登录命令。
	if strings.HasPrefix(path, `\\.\`) || strings.HasPrefix(path, `\\?\`) ||
		strings.Contains(path[len(filepath.VolumeName(path)):], ":") {
		return "", fmt.Errorf("%s不能是设备路径或备用数据流", field)
	}
	return path, nil
}

func nameForHome(home string) (string, error) {
	canonical := home
	if real, err := filepath.EvalSymlinks(home); err == nil {
		canonical = real
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("无法核验壳子目录实路径: %w", err)
	}
	canonical = strings.ToLower(filepath.Clean(canonical))
	digest := sha256.Sum256([]byte(canonical))
	return fmt.Sprintf("%s%x", valuePrefix, digest[:]), nil
}

func legacyGuard(startup string) (string, error) {
	//G 只取元信息；Lstat 不跟随链接，更不会打开或读取脚本内容。
	_, err := os.Lstat(filepath.Join(startup, "jmbots_Guard.vbs"))
	if err == nil {
		return "启动目录存在旧 jmbots_Guard.vbs；请先确认停用旧守护脚本，避免两套守护同时启动。", nil
	}
	if os.IsNotExist(err) {
		return "", nil
	}
	warning := "无法核验启动目录的旧 jmbots_Guard.vbs；未确认安全前不会安装新自启。"
	return warning, fmt.Errorf("检查旧守护脚本失败: %w", err)
}

func quotePath(path string) string {
	//M 输入已拒绝引号；结尾反斜线在闭合引号前必须翻倍，根目录 F:\ 也能正确传参。
	trailing := len(path) - len(strings.TrimRight(path, `\`))
	return `"` + path + strings.Repeat(`\`, trailing) + `"`
}

func validateCommand(command string) error {
	if command == "" || strings.ContainsAny(command, "\x00\r\n") {
		return fmt.Errorf("自启命令为空或含无效控制字符")
	}
	//G Windows Run 的命令行约定上限为 260 字符，提前拒绝不可可靠启动的值。
	if len(utf16.Encode([]rune(command))) > 260 {
		return fmt.Errorf("自启命令超过 Windows Run 的 260 字符限制")
	}
	return nil
}

func joinWarning(first, second string) string {
	if first == "" {
		return second
	}
	return first + " " + second
}

func validValueName(name string) bool {
	if !strings.HasPrefix(name, valuePrefix) || len(name) != len(valuePrefix)+64 {
		return false
	}
	for _, character := range name[len(valuePrefix):] {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}
