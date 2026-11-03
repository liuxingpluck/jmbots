// 本文件定义托盘展示与动作契约；纯逻辑不访问桌面、浏览器、注册表或真实服务。
package tray

import (
 "fmt"
 "path/filepath"

 core "jmbots-shell/internal/shell"
)

// View 是可以独立测试的托盘状态快照。
type View struct {
 Title string // 正式、候选与版本的状态行。
 Color string // green/yellow/red。
 CanChange bool // 旁观/错误状态不显示可用变更操作。
}

// Describe 将壳子状态转换为托盘文案，不执行健康请求。
func Describe(state core.State) View {
 version:=state.Current;if version==""{version="无"}
 official:="未运行";if state.Official!=nil{official=fmt.Sprintf("PID %d",state.Official.PID)}
 candidate:="无";if state.Candidate!=nil{candidate=fmt.Sprintf("PID %d",state.Candidate.PID)}
 color:="yellow"
 if state.Mode=="managed"&&state.Official!=nil&&state.Candidate==nil{color="green"}
 if state.Mode=="quiet"||state.Mode=="error"||state.Failures>0{color="red"}
 if state.Mode=="observer"{official="旁观"}
 return View{Title:fmt.Sprintf("正式：%s | 候选：%s | 版本：%s",official,candidate,version),Color:color,CanChange:state.Mode!="observer"&&state.Mode!="error"}
}

// Actions 是托盘动作依赖；测试必须传替身，不能调用真实浏览器或系统动作。
type Actions struct {
 Begin func(kind string)error // 交给Manager原子互斥，不直接起停进程。
 Open func(target string)error // 仅真实用户手动点击时打开URL或日志目录。
 Exit func() // 仅取消壳子，不停Job。
}

// Dispatch 将一个显式菜单动作传给依赖，不包含自动浏览器打开行为。
func Dispatch(action string,config core.Config,actions Actions)error {
 switch action {
 case "restart","rollback":if actions.Begin==nil{return fmt.Errorf("未提供控制动作")};return actions.Begin(action)
 case "open":if actions.Open==nil{return fmt.Errorf("未提供打开动作")};return actions.Open(fmt.Sprintf("http://127.0.0.1:%d",config.Ports.Official))
 case "logs":if actions.Open==nil{return fmt.Errorf("未提供打开动作")};return actions.Open(filepath.Join(config.Home,"logs"))
 case "exit":if actions.Exit==nil{return fmt.Errorf("未提供退出动作")};actions.Exit();return nil
 default:return fmt.Errorf("未知托盘动作")
 }
}
