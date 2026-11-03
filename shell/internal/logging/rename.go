// 本文件为日志归档提供有界占用重试，不在失败后删除当前日志。
package logging

import (
	"errors"
	"os"
	"runtime"
	"syscall"
	"time"
)

func renameLog(oldPath, newPath string) error {
	for attempt := 0; ; attempt++ {
		err := os.Rename(oldPath, newPath)
		transient := runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(5)) || errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33)))
		if err == nil || !transient || attempt >= 5 {
			return err
		}
		time.Sleep((10 * time.Millisecond) << attempt)
	}
}
