// 本文件验证应用层自定义 JSON 校验可阻止语义损坏的主状态覆盖健康备份。
package storage

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

// checkedState 模拟必须包含非空版本和合法模式的应用状态。
type checkedState struct {
	// Version 是应用要求始终存在的版本。
	Version string `json:"version"`
	// Mode 只允许 managed，用来验证语法正常但语义非法的 JSON。
	Mode string `json:"mode"`
}

// UnmarshalJSON 先解码到独立别名再做语义检查；失败不改变接收者。
func (state *checkedState) UnmarshalJSON(data []byte) error {
	type plain checkedState
	var next plain
	if err := json.Unmarshal(data, &next); err != nil {
		return err
	}
	if next.Version == "" || next.Mode != "managed" {
		return fmt.Errorf("版本或模式缺失/非法")
	}
	*state = checkedState(next)
	return nil
}

func TestWriteJSONSemanticBadMainPreservesBackup(t *testing.T) {
	cases := []struct {
		// name 说明本次要保护的语义损坏情形。
		name string
		// broken 是合法 JSON，但不符合 checkedState 约束。
		broken string
		// pointer 验证 value 传值和传指针都能触发自定义校验。
		pointer bool
	}{
		{name: "空对象值参数", broken: `{}`},
		{name: "无效模式指针参数", broken: `{"version":"bad","mode":"unknown"}`, pointer: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.json")
			good := checkedState{Version: "known-good", Mode: "managed"}
			if err := WriteJSON(path, good); err != nil {
				t.Fatal(err)
			}
			if err := WriteJSON(path, checkedState{Version: "next", Mode: "managed"}); err != nil {
				t.Fatal(err)
			}
			backup := string(mustRead(t, path+".bak"))
			mustWrite(t, path, []byte(tc.broken))
			//M 读取主文件的自定义解码失败，应转用有效备份，而不是接受空状态。
			var recoveredState checkedState
			recovered, err := ReadJSON(path, &recoveredState)
			if err != nil || !recovered || recoveredState != good {
				t.Fatalf("语义校验失败后没有恢复备份: state=%+v recovered=%v err=%v", recoveredState, recovered, err)
			}
			replacement := checkedState{Version: "repaired", Mode: "managed"}
			var value any = replacement
			if tc.pointer {
				value = &replacement
			}
			if err := WriteJSON(path, value); err != nil {
				t.Fatal(err)
			}
			if got := string(mustRead(t, path+".bak")); got != backup {
				t.Fatal("语义损坏的主状态覆盖了健康备份")
			}
			if got := string(mustRead(t, path+".bad")); got != tc.broken {
				t.Fatal("语义损坏的主状态没有原样保留为 bad")
			}
			if recovered, err := ReadJSON(path, &recoveredState); err != nil || recovered || recoveredState != replacement {
				t.Fatalf("新主状态错误: state=%+v recovered=%v err=%v", recoveredState, recovered, err)
			}
		})
	}
}
