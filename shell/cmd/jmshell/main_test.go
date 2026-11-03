// 本文件只验证入口参数守卫，绝不运行服务、托盘或注册表入口。
package main

import (
 "os"
 "strings"
 "testing"
)

func TestRejectPositionalsBeforeResolvingRuntime(t *testing.T) {
 old:=os.Args;defer func(){os.Args=old}()
 os.Args=[]string{"jmshell.exe","serve","--home","F:/aidata/cache/jmshell_exp/must-not-run"}
 err:=run();if err==nil||!strings.Contains(err.Error(),"位置参数"){t.Fatal("不应因错误子命令静默丢弃home并使用默认运行时",err)}
}

func TestAutostartRejectsPositionalsBeforeRegistry(t *testing.T) {
 old:=os.Args;defer func(){os.Args=old}()
 os.Args=[]string{"jmshell.exe","install-autostart","unexpected","--home","F:/aidata/cache/jmshell_exp/must-not-run"}
 err:=run();if err==nil||!strings.Contains(err.Error(),"位置参数"){t.Fatal("参数错误必须先于注册表访问返回",err)}
}
