// 本文件在不关闭子进程追加句柄的情况下轮转原始输出；复制量有界，但不是无损协议。
package logging

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// RotateChild 在当前文件达到 maxBytes 时保存最多最后 maxBytes 字节，然后原地截断。
// keep 含 current；零值默认 5 MiB/5 份；调用方定时调用，且不能与 Writer 共用路径。
//
// 此方案保证子进程不依赖壳子管道且持有的追加句柄仍可用，不保证完全无损：
// 1. 调用前若已超过 maxBytes，快照只保留最后 maxBytes 字节，丢弃更早的超量前缀。
// 2. 从记录快照长度到 Truncate 之间的并发追加可能丢失；正在写入的一行可能被切开。
// 3. 壳子退出或轮询延迟时 current 可临时无限增长，因此 5 MiB 是轮询触发阈值而非硬上限。
// 4. 快照先 Sync、归档后才截断；中途失败可能留下重复快照，但不会为失败的复制截断 current。
// 不支持多个独立轮转器；精确无损与严格大小上限需后端自身轮转或独立持久日志服务。
func RotateChild(path string, maxBytes int64, keep int) error {
	maxBytes, keep, err := limits(maxBytes, keep)
	if err != nil {
		return err
	}
	if path == "" {
		return fmt.Errorf("子进程日志路径不能为空")
	}
	rotationMu.Lock()
	defer rotationMu.Unlock()
	file, err := openChildControl(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("子进程日志必须是普通文件")
	}
	if info.Size() < maxBytes {
		return nil
	}
	if keep > 1 {
		//M 以调用时的 EOF 为边界复制最多一份日志，持续输出不会导致复制追赶不完。
		tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".rotate-")
		if err != nil {
			return err
		}
		tmpName := tmp.Name()
		defer os.Remove(tmpName)
		start := info.Size() - maxBytes
		_, copyErr := io.CopyN(tmp, io.NewSectionReader(file, start, maxBytes), maxBytes)
		var syncErr error
		if copyErr == nil {
			syncErr = tmp.Sync()
		}
		closeErr := tmp.Close()
		if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
			return fmt.Errorf("复制子进程日志快照: %w", err)
		}
		if err := shiftArchives(path, keep); err != nil {
			return err
		}
		if err := renameLog(tmpName, archivePath(path, 1)); err != nil {
			return err
		}
	}
	//G 此处保留文件身份，不改名或关闭子进程持有的句柄；追加访问保证后续写入新 EOF。
	if err := file.Truncate(0); err != nil {
		return err
	}
	return file.Sync()
}
