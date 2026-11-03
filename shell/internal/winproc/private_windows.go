//go:build windows

// 本文件以当前用户专属、禁止继承的 DACL 创建或保护文件；不读取也不回显文件内容。
package winproc

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

type privateDescriptor struct {
	value unsafe.Pointer
	acl   unsafe.Pointer
}

// CreatePrivateFile 以 CREATE_NEW 和当前用户专属安全描述符一次性创建文件。
// 路径或任一父目录为 reparse point 时拒绝；已有文件不覆盖，首次写入前即无宽权限窗口。
func CreatePrivateFile(path string) (*os.File, error) {
	absolute, parents, err := guardPrivatePath(path)
	if err != nil {
		return nil, err
	}
	defer closeParents(parents)
	descriptor, err := currentPrivateDescriptor()
	if err != nil {
		return nil, err
	}
	defer descriptor.close()
	security := syscall.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(syscall.SecurityAttributes{})),
		SecurityDescriptor: uintptr(descriptor.value),
		InheritHandle:      0,
	}
	encoded, err := syscall.UTF16PtrFromString(absolute)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(encoded, syscall.GENERIC_READ|syscall.GENERIC_WRITE|readControl,
		syscall.FILE_SHARE_READ, &security, syscall.CREATE_NEW, syscall.FILE_ATTRIBUTE_NORMAL|fileFlagOpenReparse, 0)
	if err != nil {
		return nil, fmt.Errorf("安全创建私有文件: %w", err)
	}
	if err := verifyRegularHandle(handle); err != nil {
		closeHandle(handle)
		return nil, err
	}
	if err := verifyPrivateDACL(handle, descriptor.acl); err != nil {
		closeHandle(handle)
		//G 不删除可能被替换的路径；留下未写内容的受保护空文件供调用方报告。
		return nil, err
	}
	file := os.NewFile(uintptr(handle), absolute)
	if file == nil {
		closeHandle(handle)
		return nil, fmt.Errorf("无法封装私有文件句柄")
	}
	return file, nil
}

// ProtectFile 通过已打开且禁止跟随 reparse 的句柄替换 DACL，仅允许当前用户。
// 本函数用于已有文件；新令牌必须先用 CreatePrivateFile，再写入内容。
func ProtectFile(path string) error {
	absolute, parents, err := guardPrivatePath(path)
	if err != nil {
		return err
	}
	defer closeParents(parents)
	descriptor, err := currentPrivateDescriptor()
	if err != nil {
		return err
	}
	defer descriptor.close()
	encoded, err := syscall.UTF16PtrFromString(absolute)
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(encoded, fileReadAttributes|readControl|writeDAC,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING,
		fileFlagOpenReparse|fileFlagBackupSemantics, 0)
	if err != nil {
		return fmt.Errorf("打开待保护文件: %w", err)
	}
	defer closeHandle(handle)
	if err := verifyRegularHandle(handle); err != nil {
		return err
	}
	status, _, _ := setSecurityInfo.Call(uintptr(handle), 1, daclSecurityInfo|protectedDACL, 0, 0, uintptr(descriptor.acl), 0)
	if status != 0 {
		return fmt.Errorf("设置私有文件 DACL: %w", syscall.Errno(status))
	}
	return verifyPrivateDACL(handle, descriptor.acl)
}

func guardPrivatePath(path string) (string, []syscall.Handle, error) {
	absolute, err := filepath.Abs(path)
	if err != nil || path == "" {
		return "", nil, fmt.Errorf("私有文件路径无效")
	}
	absolute = filepath.Clean(absolute)
	volume := filepath.VolumeName(absolute)
	//G 不允许设备路径、UNC、ADS 或含点/空格尾缀的别名；令牌仅允许本地普通文件。
	if len(volume) != 2 || volume[1] != ':' || strings.HasPrefix(absolute, `\\`) {
		return "", nil, fmt.Errorf("私有文件必须位于本地磁盘普通路径")
	}
	relative := strings.TrimLeft(absolute[len(volume):], `\/`)
	if relative == "" || strings.ContainsAny(relative, ":\x00") {
		return "", nil, fmt.Errorf("私有文件路径含无效组件或备用数据流")
	}
	for _, part := range strings.Split(relative, `\`) {
		if part == "" || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || reservedDeviceName(part) {
			return "", nil, fmt.Errorf("私有文件路径含 Windows 特殊名称")
		}
	}
	var paths []string
	for parent := filepath.Dir(absolute); ; parent = filepath.Dir(parent) {
		paths = append(paths, parent)
		if filepath.Dir(parent) == parent {
			break
		}
	}
	var handles []syscall.Handle
	//M 从卷根到直接父目录逐级打开，保持拒绝删除共享，避免校验后父目录被换成链接。
	for index := len(paths) - 1; index >= 0; index-- {
		encoded, err := syscall.UTF16PtrFromString(paths[index])
		if err != nil {
			closeParents(handles)
			return "", nil, err
		}
		handle, err := syscall.CreateFile(encoded, fileReadAttributes,
			syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING,
			fileFlagOpenReparse|fileFlagBackupSemantics, 0)
		if err != nil {
			closeParents(handles)
			return "", nil, fmt.Errorf("固定私有文件父目录: %w", err)
		}
		handles = append(handles, handle)
		var information syscall.ByHandleFileInformation
		if err := syscall.GetFileInformationByHandle(handle, &information); err != nil {
			closeParents(handles)
			return "", nil, fmt.Errorf("核验私有文件父目录: %w", err)
		}
		if information.FileAttributes&fileAttributeReparse != 0 || information.FileAttributes&fileAttributeDirectory == 0 {
			closeParents(handles)
			return "", nil, fmt.Errorf("拒绝 reparse 或非目录父路径")
		}
	}
	return absolute, handles, nil
}

func reservedDeviceName(part string) bool {
	base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9' {
		return true
	}
	return false
}

func closeParents(handles []syscall.Handle) {
	for index := len(handles) - 1; index >= 0; index-- {
		closeHandle(handles[index])
	}
}

func verifyRegularHandle(handle syscall.Handle) error {
	kind, err := syscall.GetFileType(handle)
	if err != nil || kind != fileTypeDisk {
		return errors.Join(fmt.Errorf("私有文件不是普通磁盘文件"), err)
	}
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &information); err != nil {
		return fmt.Errorf("核验私有文件句柄: %w", err)
	}
	if information.FileAttributes&(fileAttributeReparse|fileAttributeDirectory) != 0 {
		return fmt.Errorf("拒绝目录或 reparse 私有文件")
	}
	if information.NumberOfLinks != 1 {
		return fmt.Errorf("拒绝具有多个硬链接的私有文件")
	}
	return nil
}

func currentPrivateDescriptor() (privateDescriptor, error) {
	sid, err := currentUserSIDString()
	if err != nil {
		return privateDescriptor{}, err
	}
	//M 唯一 ACE 只授予当前用户完全访问；D:P 禁止从父目录继承授权。
	sddl, err := syscall.UTF16PtrFromString("O:" + sid + "D:P(A;;FA;;;" + sid + ")")
	if err != nil {
		return privateDescriptor{}, err
	}
	var descriptor privateDescriptor
	ok, _, callErr := convertSDDL.Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&descriptor.value)), 0)
	if ok == 0 {
		return privateDescriptor{}, nativeError("创建当前用户安全描述符", callErr)
	}
	var present, defaulted int32
	ok, _, callErr = getDescriptorDACL.Call(uintptr(descriptor.value), uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&descriptor.acl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || present == 0 || descriptor.acl == nil {
		descriptor.close()
		return privateDescriptor{}, nativeError("读取当前用户 DACL", callErr)
	}
	return descriptor, nil
}

func (descriptor privateDescriptor) close() {
	if descriptor.value != nil {
		localFree.Call(uintptr(descriptor.value))
	}
}

func currentUserSIDString() (string, error) {
	var token syscall.Handle
	ok, _, callErr := openProcessToken.Call(uintptr(currentProcessHandle()), 0x0008, uintptr(unsafe.Pointer(&token)))
	if ok == 0 {
		return "", nativeError("查询当前用户身份", callErr)
	}
	defer closeHandle(token)
	var size uint32
	ok, _, callErr = getTokenInformation.Call(uintptr(token), 1, 0, 0, uintptr(unsafe.Pointer(&size)))
	if ok != 0 || callErr != syscall.ERROR_INSUFFICIENT_BUFFER || size < uint32(unsafe.Sizeof(uintptr(0))) || size > 1024*1024 {
		return "", nativeError("计算当前用户身份长度", callErr)
	}
	words := make([]uintptr, (uintptr(size)+unsafe.Sizeof(uintptr(0))-1)/unsafe.Sizeof(uintptr(0)))
	ok, _, callErr = getTokenInformation.Call(uintptr(token), 1, uintptr(unsafe.Pointer(&words[0])), uintptr(size), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return "", nativeError("读取当前用户身份", callErr)
	}
	var text *uint16
	ok, _, callErr = convertSIDToString.Call(words[0], uintptr(unsafe.Pointer(&text)))
	if ok == 0 {
		return "", nativeError("转换当前用户身份", callErr)
	}
	defer localFree.Call(uintptr(unsafe.Pointer(text)))
	var characters []uint16
	for index := 0; index < 256; index++ {
		character := *(*uint16)(unsafe.Add(unsafe.Pointer(text), uintptr(index)*2))
		if character == 0 {
			runtime.KeepAlive(words)
			return syscall.UTF16ToString(characters), nil
		}
		characters = append(characters, character)
	}
	return "", fmt.Errorf("当前用户身份字符串过长")
}

func verifyPrivateDACL(handle syscall.Handle, expected unsafe.Pointer) error {
	var descriptor, actual unsafe.Pointer
	status, _, _ := getSecurityInfo.Call(uintptr(handle), 1, daclSecurityInfo, 0, 0, uintptr(unsafe.Pointer(&actual)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		return fmt.Errorf("读取私有文件 DACL: %w", syscall.Errno(status))
	}
	defer localFree.Call(uintptr(descriptor))
	if actual == nil || descriptor == nil {
		return fmt.Errorf("私有文件不得具有空 DACL")
	}
	var control uint16
	var revision uint32
	ok, _, callErr := getDescriptorControl.Call(uintptr(descriptor), uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 {
		return nativeError("核验私有文件继承状态", callErr)
	}
	if control&0x1000 == 0 {
		return fmt.Errorf("私有文件 DACL 未禁止继承")
	}
	actualBytes, err := aclBytes(actual)
	if err != nil {
		return err
	}
	expectedBytes, err := aclBytes(expected)
	if err != nil {
		return err
	}
	if !bytes.Equal(actualBytes, expectedBytes) {
		return fmt.Errorf("私有文件 DACL 不是仅当前用户权限")
	}
	return nil
}

func aclBytes(pointer unsafe.Pointer) ([]byte, error) {
	ok, _, _ := isValidACL.Call(uintptr(pointer))
	if ok == 0 {
		return nil, fmt.Errorf("私有文件 ACL 无效")
	}
	header := (*struct {
		Revision uint8
		Reserved uint8
		Size     uint16
		AceCount uint16
		Unused   uint16
	})(pointer)
	if header.Size < 8 || header.AceCount != 1 {
		return nil, fmt.Errorf("私有文件 ACL 必须且只能有当前用户一条授权")
	}
	return unsafe.Slice((*byte)(pointer), int(header.Size)), nil
}
