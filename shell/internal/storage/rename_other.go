//go:build !windows

// 本文件让非 Windows 的纯逻辑测试可编译，不把永久性改名错误当成占用。
package storage

func transientRenameError(err error) bool {
	return false
}
