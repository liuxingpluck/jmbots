// 本文件从当前日志及相邻归档逆向读取尾部，限制内存与读取字节数并在返回前脱敏。
package logging

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// tailMaxBytes 防止单行超大日志导致控制口分配无界内存。
const tailMaxBytes = 8 * 1024 * 1024

// Tail 返回最近 lines 行，跨 current、.1 等归档补齐，并执行 Redact。
// 最多读取 8 MiB、10000 行和 128 份文件；超界直接报错，绝不返回可能截断秘密的半行。
// 当前文件缺失会返回错误；轮转并发时只保证尽力快照，不保证跨文件一致性。
func Tail(path string, lines int) (string, error) {
	if lines < 0 || lines > 10000 {
		return "", fmt.Errorf("日志尾部行数必须介于 0 和 10000")
	}
	if lines == 0 {
		return "", nil
	}
	rotationMu.Lock()
	defer rotationMu.Unlock()

	// chunks 按从新到旧记录读取片段，最后反转拼接以保留跨文件断行。
	var chunks [][]byte
	totalBytes, newlines := 0, 0
	exhausted := false
	for archive := 0; archive < 128 && newlines <= lines; archive++ {
		name := path
		if archive > 0 {
			name = archivePath(path, archive)
		}
		file, err := openSharedRead(name)
		if err != nil {
			if archive > 0 && errors.Is(err, os.ErrNotExist) {
				exhausted = true
				break
			}
			return "", err
		}
		info, err := file.Stat()
		if err != nil {
			_ = file.Close()
			return "", err
		}
		if !info.Mode().IsRegular() {
			_ = file.Close()
			return "", fmt.Errorf("日志尾部只能读取普通文件")
		}
		for offset := info.Size(); offset > 0 && newlines <= lines; {
			count := int64(32 * 1024)
			if offset < count {
				count = offset
			}
			if totalBytes+int(count) > tailMaxBytes {
				_ = file.Close()
				return "", fmt.Errorf("日志尾部超过 8 MiB 读取上限")
			}
			offset -= count
			chunk := make([]byte, int(count))
			n, readErr := file.ReadAt(chunk, offset)
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				_ = file.Close()
				return "", readErr
			}
			chunk = chunk[:n]
			chunks = append(chunks, chunk)
			totalBytes += n
			newlines += bytes.Count(chunk, []byte{'\n'})
		}
		if err := file.Close(); err != nil {
			return "", err
		}
	}
	if !exhausted && newlines <= lines {
		return "", fmt.Errorf("日志归档超过 128 份读取上限")
	}
	var text strings.Builder
	text.Grow(totalBytes)
	for index := len(chunks) - 1; index >= 0; index-- {
		text.Write(chunks[index])
	}
	data := text.String()
	//M 末尾换行只终止最后一行，不额外算一条空日志。
	end := len(data)
	if end > 0 && data[end-1] == '\n' {
		end--
	}
	start := 0
	for remaining, index := lines, end-1; index >= 0; index-- {
		if data[index] == '\n' {
			remaining--
			if remaining == 0 {
				start = index + 1
				break
			}
		}
	}
	return Redact(data[start:]), nil
}
