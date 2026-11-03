// 本文件管理状态 JSON 的已知有效备份、坏文件保留和无副作用读取恢复。
package storage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sync"
)

// jsonMu 串行化本进程内的备份与主文件事务；跨进程互斥由壳子单实例锁负责。
var jsonMu sync.Mutex

// WriteJSON 先校验新值，再保留旧有效 JSON 为 .bak 或坏内容为 .bad，最后原子写主文件。
// 旧主还须能解码为 value 的相同类型，包含该类型自定义 UnmarshalJSON 的语义检查。
// nil/null 状态被拒绝；读旧文件的权限或 I/O 错误会中止写入，不会当作空状态覆盖。
func WriteJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("编码状态 JSON: %w", err)
	}
	if err := validStateJSON(data); err != nil {
		return err
	}
	data = append(data, '\n')

	jsonMu.Lock()
	defer jsonMu.Unlock()
	//M 旧主须同时通过 JSON 语法和目标类型语义检查，才允许刷新健康备份。
	old, err := os.ReadFile(path)
	if err == nil {
		oldErr := validStateJSON(old)
		if oldErr == nil {
			previous := reflect.New(reflect.TypeOf(value))
			oldErr = json.Unmarshal(old, previous.Interface())
		}
		if oldErr == nil {
			if err := AtomicWrite(path+".bak", old, 0600); err != nil {
				return fmt.Errorf("保留有效状态备份: %w", err)
			}
		} else if err := AtomicWrite(path+".bad", old, 0600); err != nil {
			return fmt.Errorf("保留损坏状态: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("读取旧状态，拒绝覆盖: %w", err)
	}
	return AtomicWrite(path, data, 0600)
}

// ReadJSON 将主文件或 .bak 解码到 out；只有使用备份时 recovered 为 true，不修复磁盘。
// out 必须是非 nil 指针；失败不修改 out。两文件均不存在才返回 os.ErrNotExist。
func ReadJSON(path string, out any) (recovered bool, err error) {
	//G 在临时值中完成解码，避免半写 JSON 或类型错误部分修改调用方状态。
	target := reflect.ValueOf(out)
	if !target.IsValid() || target.Kind() != reflect.Pointer || target.IsNil() {
		return false, fmt.Errorf("状态输出必须是非 nil 指针")
	}
	jsonMu.Lock()
	defer jsonMu.Unlock()

	mainValue, mainErr := readJSONValue(path, target.Elem().Type())
	if mainErr == nil {
		target.Elem().Set(mainValue)
		return false, nil
	}
	backupValue, backupErr := readJSONValue(path+".bak", target.Elem().Type())
	if backupErr == nil {
		target.Elem().Set(backupValue)
		return true, nil
	}
	if errors.Is(mainErr, os.ErrNotExist) && errors.Is(backupErr, os.ErrNotExist) {
		return false, os.ErrNotExist
	}
	//G 故意不把单边的 ErrNotExist 包装进错误链，防止调用方误判为首次启动后空写覆盖。
	return false, fmt.Errorf("状态与备份均不可用；主文件: %v；备份: %v", mainErr, backupErr)
}

// validStateJSON 校验完整 JSON，并拒绝会把状态静默变为零值的 null。
func validStateJSON(data []byte) error {
	if !json.Valid(data) || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return fmt.Errorf("状态必须是完整且非 null 的 JSON")
	}
	return nil
}

func readJSONValue(path string, typ reflect.Type) (reflect.Value, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return reflect.Value{}, err
	}
	if err := validStateJSON(data); err != nil {
		return reflect.Value{}, err
	}
	value := reflect.New(typ)
	if err := json.Unmarshal(data, value.Interface()); err != nil {
		return reflect.Value{}, err
	}
	return value.Elem(), nil
}
