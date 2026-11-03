// Package logging 提供壳子日志轮转、读取脱敏和不依赖壳子常驻的子进程文件输出。
package logging

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// DefaultMaxBytes 是单个壳子日志文件的默认上限：5 MiB。
const DefaultMaxBytes int64 = 5 * 1024 * 1024

// DefaultKeep 是默认保留文件总数，包含 current 和四份归档。
const DefaultKeep = 5

// rotationMu 串行化本进程归档操作；跨进程由壳子单实例锁负责。
var rotationMu sync.Mutex

// Writer 是并发安全的轮转写入器，实现 io.WriteCloser；一个路径只能由一个 Writer 拥有。
// 与 OpenChild 不可混用同一路径；Write 对本次完整文本脱敏，不能识别跨 Write 拆开的秘密。
type Writer struct {
	// mu 保护文件句柄、大小和关闭状态。
	mu sync.Mutex
	// path 是当前日志的固定路径。
	path string
	// maxBytes 是每份文件的字节上限。
	maxBytes int64
	// keep 是包含当前文件的保留份数。
	keep int
	// file 是仅供壳子自身使用的追加句柄。
	file *os.File
	// size 是当前句柄已经写入的字节数。
	size int64
	// closed 禁止关闭后重开或写入。
	closed bool
}

var _ io.WriteCloser = (*Writer)(nil)

// New 打开 path 并创建缺失父目录；maxBytes、keep 为零时使用 5 MiB、5 份默认值。
// 负数参数被拒绝；不会打开、扫描或读取任何秘密文件。
func New(path string, maxBytes int64, keep int) (*Writer, error) {
	maxBytes, keep, err := limits(maxBytes, keep)
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, fmt.Errorf("日志路径不能为空")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	w := &Writer{path: path, maxBytes: maxBytes, keep: keep}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

// Write 对本次 p 脱敏，再按 maxBytes 分块轮转；成功返回输入长度，失败返回错误。
// 脱敏可能改变输出长度，发生部分磁盘写入错误时返回 0，调用方不得盲目重试整段日志。
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, os.ErrClosed
	}
	if len(p) == 0 {
		return 0, nil
	}
	if w.file == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	data := []byte(Redact(string(p)))
	for len(data) > 0 {
		if w.size >= w.maxBytes {
			if err := w.rotate(); err != nil {
				return 0, err
			}
		}
		//M 每次只写本文件剩余容量，大 Write 不能绕过轮转大小限制。
		chunk := int64(len(data))
		if room := w.maxBytes - w.size; chunk > room {
			chunk = room
		}
		n, err := w.file.Write(data[:int(chunk)])
		w.size += int64(n)
		if err != nil {
			return 0, err
		}
		if int64(n) != chunk {
			return 0, io.ErrShortWrite
		}
		data = data[n:]
	}
	return len(p), nil
}

// Close 同步并关闭当前文件；多次调用无副作用，关闭后 Write 返回 os.ErrClosed。
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.file == nil {
		return nil
	}
	return errors.Join(w.file.Sync(), w.file.Close())
}

func (w *Writer) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return fmt.Errorf("日志目标必须是普通文件")
	}
	w.file = file
	w.size = info.Size()
	return nil
}

func (w *Writer) rotate() error {
	rotationMu.Lock()
	defer rotationMu.Unlock()
	if err := w.file.Sync(); err != nil {
		return err
	}
	closeErr := w.file.Close()
	w.file = nil
	if closeErr != nil {
		return closeErr
	}
	if err := shiftArchives(w.path, w.keep); err != nil {
		return err
	}
	if w.keep == 1 {
		if err := os.Remove(w.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else if err := renameLog(w.path, archivePath(w.path, 1)); err != nil {
		return err
	}
	return w.open()
}

// limits 统一默认值和参数守卫，防止负容量造成无进展轮转。
func limits(maxBytes int64, keep int) (int64, int, error) {
	if maxBytes < 0 || keep < 0 {
		return 0, 0, fmt.Errorf("日志大小和保留份数不能为负数")
	}
	if maxBytes == 0 {
		maxBytes = DefaultMaxBytes
	}
	if keep == 0 {
		keep = DefaultKeep
	}
	return maxBytes, keep, nil
}

func archivePath(path string, number int) string {
	return path + "." + strconv.Itoa(number)
}

// shiftArchives 为 .1 腾出位置，只操作明确的归档文件名，不扫描其他路径。
func shiftArchives(path string, keep int) error {
	if keep <= 1 {
		return nil
	}
	if err := os.Remove(archivePath(path, keep-1)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for number := keep - 2; number >= 1; number-- {
		if err := renameLog(archivePath(path, number), archivePath(path, number+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
