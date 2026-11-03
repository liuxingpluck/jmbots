//go:build windows

// 本文件只为真实用户手动菜单点击提供ShellExecute适配；自动化测试必须替换Open，禁止调用这里。
package tray

import (
 "fmt"
 "net/url"
 "path/filepath"
 "strings"
 "syscall"
 "unsafe"
)

// OpenTarget 由用户手动选择菜单才调用，输入只能为回环HTTP地址或绝对日志目录。
// 本次交付过程未执行该函数，没有打开浏览器或资源管理器。
func OpenTarget(target string)error {
 if strings.ContainsAny(target,"\x00\r\n"){return fmt.Errorf("打开目标含无效字符")}
 if strings.HasPrefix(target,"http") {
  u,err:=url.Parse(target);if err!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"||u.User!=nil||u.RawQuery!=""||u.Fragment!=""{return fmt.Errorf("只允许打开本机服务地址")}
 }else if !filepath.IsAbs(target)||filepath.Base(target)!="logs"{return fmt.Errorf("只允许绝对日志目录")}
 operation,_:=syscall.UTF16PtrFromString("open");path,err:=syscall.UTF16PtrFromString(target);if err!=nil{return err}
 shellExecute:=syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
 result,_,_:=shellExecute.Call(0,uintptr(unsafe.Pointer(operation)),uintptr(unsafe.Pointer(path)),0,0,1)
 if result<=32{return fmt.Errorf("Windows打开目标失败，代码%d",result)}
 return nil
}
