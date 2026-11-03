//go:build windows

// 本文件只查询 TCP 监听归属，不连接服务、不按端口终止进程；IPv4/IPv6 任一查询失败即拒绝。
package winproc

import (
	"encoding/binary"
	"fmt"
	"sort"
	"syscall"
	"unsafe"
)

// Listeners 查询端口在 IPv4/IPv6 上的全部监听者，返回去重并按 PID 排序的完整身份。
// 任一监听者身份不可读取，或任一地址族查询失败，都不返回部分成功结果。
func Listeners(port int) ([]Identity, error) {
	pids, err := listenerPIDs(port)
	if err != nil {
		return nil, err
	}
	identities := make([]Identity, 0, len(pids))
	for _, pid := range pids {
		identity, err := Inspect(pid)
		if err != nil {
			return nil, fmt.Errorf("监听者身份无法验证: %w", err)
		}
		identities = append(identities, identity)
	}
	return identities, nil
}

// OwnsListener 要求至少有一个监听者，且同端口的每个监听者都仍存活并属于本 Job。
// 返回 false 不代表可清理外部进程；网络表是瞬时快照，调用方应在健康检查后及时复核。
func (process *Process) OwnsListener(port int) (bool, error) {
	if process == nil {
		return false, ErrClosed
	}
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.closed {
		return false, ErrClosed
	}
	if !process.assigned || process.job == 0 {
		return false, ErrUnowned
	}
	identities, err := Listeners(port)
	if err != nil || len(identities) == 0 {
		return false, err
	}
	var handles []syscall.Handle
	defer func() {
		for _, handle := range handles {
			closeHandle(handle)
		}
	}()
	for _, identity := range identities {
		//G 同一句柄完成核验，并持有到最终表复查结束，避免 PID 释放后被复用。
		handle, err := openIdentityProcess(identity.PID, processQueryLimited|synchronize)
		if err != nil {
			return false, err
		}
		handles = append(handles, handle)
		owned, verifyErr := verifyListener(handle, identity, process.job)
		if verifyErr != nil {
			return false, verifyErr
		}
		if !owned {
			return false, nil
		}
	}
	//G 再读两种地址族；若期间 PID 集合变化，不把旧快照作为归属证明。
	pids, err := listenerPIDs(port)
	if err != nil {
		return false, err
	}
	if len(pids) != len(identities) {
		return false, nil
	}
	for index, pid := range pids {
		if identities[index].PID != pid {
			return false, nil
		}
		owned, err := verifyListener(handles[index], identities[index], process.job)
		if err != nil || !owned {
			return false, err
		}
	}
	return true, nil
}

func verifyListener(handle syscall.Handle, identity Identity, job syscall.Handle) (bool, error) {
	if err := validateHandle(handle, identity); err != nil {
		return false, err
	}
	exited, err := processExited(handle)
	if err != nil || exited {
		return false, err
	}
	return inJob(handle, job)
}

func listenerPIDs(port int) ([]uint32, error) {
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("监听端口必须位于 1–65535")
	}
	unique := make(map[uint32]struct{})
	for _, family := range []uint32{2, 23} {
		table, err := tcpTable(family)
		if err != nil {
			return nil, err
		}
		pids, err := parseTCPTable(table, family, port)
		if err != nil {
			return nil, err
		}
		for _, pid := range pids {
			unique[pid] = struct{}{}
		}
	}
	result := make([]uint32, 0, len(unique))
	for pid := range unique {
		result = append(result, pid)
	}
	sort.Slice(result, func(a, b int) bool { return result[a] < result[b] })
	return result, nil
}

func tcpTable(family uint32) ([]byte, error) {
	const ownerPIDListener = 3
	var size uint32
	status, _, _ := getExtendedTCPTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, uintptr(family), ownerPIDListener, 0)
	if status != 0 && status != uintptr(syscall.ERROR_INSUFFICIENT_BUFFER) {
		return nil, fmt.Errorf("查询 TCP 地址族 %d 失败: %w", family, syscall.Errno(status))
	}
	for attempt := 0; attempt < 5; attempt++ {
		if size < 4 || size > 64*1024*1024 {
			return nil, fmt.Errorf("TCP 监听表长度无效")
		}
		buffer := make([]byte, size)
		status, _, _ = getExtendedTCPTable.Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)), 0, uintptr(family), ownerPIDListener, 0)
		if status == uintptr(syscall.ERROR_INSUFFICIENT_BUFFER) {
			continue
		}
		if status != 0 {
			return nil, fmt.Errorf("读取 TCP 地址族 %d 失败: %w", family, syscall.Errno(status))
		}
		if size > uint32(len(buffer)) || size < 4 {
			return nil, fmt.Errorf("TCP 监听表返回长度无效")
		}
		return buffer[:size], nil
	}
	return nil, fmt.Errorf("TCP 监听表持续变化，拒绝不完整归属证明")
}

func parseTCPTable(table []byte, family uint32, port int) ([]uint32, error) {
	if len(table) < 4 {
		return nil, fmt.Errorf("TCP 监听表缺少表头")
	}
	rowSize, stateOffset, portOffset, pidOffset := 24, 0, 8, 20
	if family == 23 {
		rowSize, stateOffset, portOffset, pidOffset = 56, 48, 20, 52
	} else if family != 2 {
		return nil, fmt.Errorf("TCP 地址族不受支持")
	}
	count := uint64(binary.LittleEndian.Uint32(table[:4]))
	if count > uint64((len(table)-4)/rowSize) {
		return nil, fmt.Errorf("TCP 监听表行数越界")
	}
	result := make([]uint32, 0)
	for index := uint64(0); index < count; index++ {
		row := table[4+int(index)*rowSize : 4+(int(index)+1)*rowSize]
		state := binary.LittleEndian.Uint32(row[stateOffset : stateOffset+4])
		//M dwLocalPort 使用网络字节序，DWORD 中前两个字节即端口。
		localPort := int(binary.BigEndian.Uint16(row[portOffset : portOffset+2]))
		if state == 2 && localPort == port {
			pid := binary.LittleEndian.Uint32(row[pidOffset : pidOffset+4])
			if pid == 0 {
				return nil, fmt.Errorf("TCP 监听者缺少可验证 PID")
			}
			result = append(result, pid)
		}
	}
	return result, nil
}
