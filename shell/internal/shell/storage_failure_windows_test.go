//go:build windows

// 本文件用实验文件独占共享模拟状态写失败，验证旧版停止后恢复路径不因磁盘错误再杀服务。
package shell

import (
 "os"
 "path/filepath"
 "strings"
 "syscall"
 "testing"
 "time"
)

func TestStateWriteFailureAfterOldStoppedRestoresService(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"old","normal"))
 release,err:=FreezeRelease(home,makeRelease(t,home,"new","normal"));if err!=nil{t.Fatal(err)}
 path:=filepath.Join(home,"state.json");encoded,err:=syscall.UTF16PtrFromString(path);if err!=nil{t.Fatal(err)}
 var held syscall.Handle;defer func(){if held!=0{syscall.CloseHandle(held)}}()
 //M 在旧Job停止之前锁定当前状态文件；允许读取，禁止替换，严格限制在本测试home。
 err=m.switchRelease(release,func(stage,text string){if stage=="stop-official"{var e error;held,e=syscall.CreateFile(encoded,syscall.GENERIC_READ,syscall.FILE_SHARE_READ,nil,syscall.OPEN_EXISTING,0,0);if e!=nil{t.Fatal(e)}}})
 if err==nil{t.Fatal("应向操作者报告状态持久化失败")}
 if held!=0{syscall.CloseHandle(held);held=0}
 if m.official==nil{t.Fatal("磁盘失败后遗失恢复进程的归属句柄")}
 if ok,e:=m.healthyOwned(m.official,m.Config.Ports.Official);e!=nil||!ok{t.Fatal("状态写失败把旧版停止后未恢复服务",ok,e)}
 if m.Snapshot().Current!="old"{t.Fatal("恢复版本不符")}
 t.Log("状态文件被Windows独占阻止替换：操作报错，但已停止的旧版按冻结包恢复且继续健康")
}

func TestNullAndEmptyConfigNeverUseProductDefaults(t *testing.T) {
 home:=experiment(t)
 for _,body:=range []string{"null","{}","[]",`{"runtime_dir":null}`} {
  if err:=os.WriteFile(filepath.Join(home,"shell.json"),[]byte(body),0600);err!=nil{t.Fatal(err)}
  if _,err:=LoadConfig(home);err==nil{t.Fatalf("无效配置 %s 不得静默使用产品默认端口",body)}
 }
}

func TestQuietPeriodStartsAfterFailedAttempts(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home))
 release,err:=FreezeRelease(home,makeRelease(t,home,"bad","crash"));if err!=nil{t.Fatal(err)}
 if err=m.mutate(func(s *State){s.Current=release.Manifest.ID;s.Failures=2});err!=nil{t.Fatal(err)}
 start:=time.Now();if err=m.Tick(start);err!=nil{t.Fatal(err)}
 entered:=time.Now();s:=m.Snapshot()
 if s.Mode!="quiet"||s.QuietUntil.Before(entered.Add(10*time.Minute-time.Second)){t.Fatalf("冷却起点早于失败处理完成：%+v",s)}
 if !strings.Contains(s.LastError,"退出"){t.Fatal("未记录失败原因")}
}
