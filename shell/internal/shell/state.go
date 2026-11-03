// 本文件定义状态的语义解码，合法JSON但缺字段或非法版本同样触发备份恢复。
package shell

import (
 "encoding/json"
 "fmt"
)

// UnmarshalJSON 验证状态完整结构后才修改接收者；供storage主/备读取与备份校验共用。
func (state *State) UnmarshalJSON(data []byte)error {
 var fields map[string]json.RawMessage
 if err:=json.Unmarshal(data,&fields);err!=nil{return err}
 for _,name:=range []string{"current","previous","last_good","mode","failures","updated_at"}{if value,ok:=fields[name];!ok||string(value)=="null"{return fmt.Errorf("状态缺少必要字段：%s",name)}}
 type plain State
 var value plain;if err:=json.Unmarshal(data,&value);err!=nil{return err}
 switch value.Mode{case "idle","managed","observer","quiet","error":default:return fmt.Errorf("状态模式无效")}
 if value.Failures<0||value.Failures>3{return fmt.Errorf("状态失败计数无效")}
 for _,id:=range []string{value.Current,value.Previous,value.LastGood}{if id!=""&&!validID(id){return fmt.Errorf("状态版本ID无效")}}
 *state=State(value);return nil
}
