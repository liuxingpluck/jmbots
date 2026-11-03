//go:build windows

// 本文件连接fyne独立托盘库；只在非headless启动且用户显式点击时执行菜单动作。
package tray

import (
 "context"
 "fmt"
 "time"

 "fyne.io/systray"
 core "jmbots-shell/internal/shell"
)

// Run 阻塞运行托盘事件循环；图标路径由调用者home确定，退出仅调用Actions.Exit。
// 本函数不供自动化验收直接运行，菜单和图标纯逻辑由替身测试覆盖。
func Run(ctx context.Context,config core.Config,snapshot func()core.State,actions Actions,log func(string))error {
 icons,err:=PrepareIcons(config.Home);if err!=nil{return err}
 done:=make(chan struct{});workerDone:=make(chan struct{})
 systray.Run(func(){
  status:=systray.AddMenuItem("状态加载中","正式/候选/版本");status.Disable()
  systray.AddSeparator()
  open:=systray.AddMenuItem("用浏览器打开服务","仅在用户手动点击后打开配置中的正式端口")
  restart:=systray.AddMenuItem("重启正式服务","候选验证后重启当前冻结包")
  rollback:=systray.AddMenuItem("回退上一版","回退前仍验证候选")
  logs:=systray.AddMenuItem("打开日志目录","查看本壳子日志")
  systray.AddSeparator()
  exit:=systray.AddMenuItem("退出壳子（不停服务）","仅退出壳子，正式服务继续运行")
  update:=func(){
   view:=Describe(snapshot());status.SetTitle(view.Title);systray.SetTooltip("jmshell："+view.Title)
   if err:=systray.SetIconFromFilePath(icons[view.Color]);err!=nil{log("设置托盘图标失败："+err.Error())}
   if view.CanChange{restart.Enable();rollback.Enable()}else{restart.Disable();rollback.Disable()}
  }
  update()
  go func(){defer close(workerDone);timer:=time.NewTicker(2*time.Second);defer timer.Stop()
   dispatch:=func(action string){if err:=Dispatch(action,config,actions);err!=nil{log(fmt.Sprintf("托盘动作%s失败：%v",action,err))}}
   for{select{
   case<-ctx.Done():systray.Quit();return
   case<-done:return
   case<-timer.C:update()
   case<-open.ClickedCh:dispatch("open")
   case<-restart.ClickedCh:dispatch("restart")
   case<-rollback.ClickedCh:dispatch("rollback")
   case<-logs.ClickedCh:dispatch("logs")
   case<-exit.ClickedCh:dispatch("exit");systray.Quit();return
   }}
  }()
 },func(){close(done)})
 <-workerDone
 return nil
}
