//go:build windows

// 本文件仅提供当前用户 Run 键的延迟注册表适配；构造无系统访问，不涉及 StartupApproved。
package autostart

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const (
	runKeyPath  = `Software\Microsoft\Windows\CurrentVersion\Run`
	queryValue  = 0x0001
	setValue    = 0x0002
	registrySZ  = 1
	moreData    = 234
	maxValueLen = 64 * 1024
)

type windowsRegistry struct{}

// NewWindowsRegistry 仅构造适配对象，不加载 DLL，不打开键，也不读写注册表。
// 只有调用返回对象的 Get/Set/Delete 时才会访问当前用户 Run 键。
func NewWindowsRegistry() Registry {
	return windowsRegistry{}
}

type registryAPI struct {
	open   *syscall.LazyProc
	create *syscall.LazyProc
	query  *syscall.LazyProc
	set    *syscall.LazyProc
	delete *syscall.LazyProc
	close  *syscall.LazyProc
}

func lazyRegistryAPI() registryAPI {
	library := syscall.NewLazyDLL("advapi32.dll")
	return registryAPI{
		open:   library.NewProc("RegOpenKeyExW"),
		create: library.NewProc("RegCreateKeyExW"),
		query:  library.NewProc("RegQueryValueExW"),
		set:    library.NewProc("RegSetValueExW"),
		delete: library.NewProc("RegDeleteValueW"),
		close:  library.NewProc("RegCloseKey"),
	}
}

func (windowsRegistry) Get(name string) (result string, resultErr error) {
	encoded, err := checkedValueName(name)
	if err != nil {
		return "", err
	}
	api := lazyRegistryAPI()
	key, err := api.openRun(queryValue, false)
	if err != nil {
		return "", err
	}
	defer func() { resultErr = errors.Join(resultErr, api.closeKey(key)) }()
	var kind, size uint32
	status, _, _ := api.query.Call(uintptr(key), uintptr(unsafe.Pointer(encoded)), 0, uintptr(unsafe.Pointer(&kind)), 0, uintptr(unsafe.Pointer(&size)))
	if status != 0 && status != moreData {
		return "", registryError("查询自启值长度", status)
	}
	for attempt := 0; attempt < 4; attempt++ {
		if kind != registrySZ || size < 2 || size%2 != 0 || size > maxValueLen {
			return "", fmt.Errorf("自启值不是有效的有界 REG_SZ 字符串")
		}
		buffer := make([]uint16, size/2)
		status, _, _ = api.query.Call(uintptr(key), uintptr(unsafe.Pointer(encoded)), 0, uintptr(unsafe.Pointer(&kind)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
		if status == moreData {
			continue
		}
		if status != 0 {
			return "", registryError("读取自启值", status)
		}
		if kind != registrySZ || size < 2 || size%2 != 0 || size > uint32(len(buffer))*2 {
			return "", fmt.Errorf("自启值在读取过程中改变类型或长度")
		}
		characters := buffer[:size/2]
		if characters[len(characters)-1] != 0 {
			return "", fmt.Errorf("自启值没有完整字符串终止符")
		}
		for _, character := range characters[:len(characters)-1] {
			if character == 0 {
				return "", fmt.Errorf("自启值包含嵌入空字符")
			}
		}
		return syscall.UTF16ToString(characters), nil
	}
	return "", fmt.Errorf("自启值持续变化，拒绝不完整查询结果")
}

func (windowsRegistry) Set(name, value string) (resultErr error) {
	encoded, err := checkedValueName(name)
	if err != nil {
		return err
	}
	if err := validateCommand(value); err != nil {
		return err
	}
	data, err := syscall.UTF16FromString(value)
	if err != nil {
		return fmt.Errorf("自启命令编码失败: %w", err)
	}
	api := lazyRegistryAPI()
	key, err := api.openRun(setValue, true)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, api.closeKey(key)) }()
	status, _, _ := api.set.Call(uintptr(key), uintptr(unsafe.Pointer(encoded)), 0, registrySZ, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	runtime.KeepAlive(data)
	return registryError("写入当前壳子自启值", status)
}

func (windowsRegistry) Delete(name string) (resultErr error) {
	encoded, err := checkedValueName(name)
	if err != nil {
		return err
	}
	api := lazyRegistryAPI()
	//G 删除仅打开既有 Run 键；键不存在时绝不为卸载操作创建新键。
	key, err := api.openRun(setValue, false)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, api.closeKey(key)) }()
	status, _, _ := api.delete.Call(uintptr(key), uintptr(unsafe.Pointer(encoded)))
	return registryError("删除当前壳子自启值", status)
}

func checkedValueName(name string) (*uint16, error) {
	if !validValueName(name) {
		return nil, fmt.Errorf("注册表适配只允许当前壳子命名规则的自启值")
	}
	return syscall.UTF16PtrFromString(name)
}

func (api registryAPI) openRun(access uint32, create bool) (syscall.Handle, error) {
	path, _ := syscall.UTF16PtrFromString(runKeyPath)
	var key syscall.Handle
	//M 预定义 HKEY 的宏按有符号 LONG 转指针，64 位下必须符号扩展。
	currentUser := int32(-2147483647)
	root := uintptr(int64(currentUser))
	var status uintptr
	if create {
		status, _, _ = api.create.Call(root, uintptr(unsafe.Pointer(path)), 0, 0, 0, uintptr(access), 0, uintptr(unsafe.Pointer(&key)), 0)
	} else {
		status, _, _ = api.open.Call(root, uintptr(unsafe.Pointer(path)), 0, uintptr(access), uintptr(unsafe.Pointer(&key)))
	}
	if status != 0 {
		return 0, registryError("打开当前用户 Run 键", status)
	}
	if key == 0 {
		return 0, fmt.Errorf("当前用户 Run 键返回无效句柄")
	}
	return key, nil
}

func (api registryAPI) closeKey(key syscall.Handle) error {
	status, _, _ := api.close.Call(uintptr(key))
	return registryError("关闭 Run 键句柄", status)
}

func registryError(operation string, status uintptr) error {
	if status == 0 {
		return nil
	}
	if status == 2 || status == 3 {
		return fmt.Errorf("%s: %w", operation, ErrNotExist)
	}
	//G 不带注册表字符串值，避免意外把原有命令参数写入错误日志。
	return fmt.Errorf("%s: %w", strings.TrimSpace(operation), syscall.Errno(status))
}
