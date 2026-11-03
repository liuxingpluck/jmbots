// 本文件补充 M1 边界：回退成功、接管、守护后崩、占用不释放和忽略软终止。
package shell

import (
 "context"
 "fmt"
 "os"
 "path/filepath"
 "testing"
 "time"

 "jmbots-shell/internal/logging"
 "jmbots-shell/internal/winproc"
)

func TestGuardianRollbackToHealthyVersion(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home))
 bad,err:=FreezeRelease(home,makeRelease(t,home,"broken","crash"));if err!=nil{t.Fatal(err)}
 good,err:=FreezeRelease(home,makeRelease(t,home,"stable","normal"));if err!=nil{t.Fatal(err)}
 if err=m.mutate(func(s *State){s.Current=bad.Manifest.ID;s.LastGood=good.Manifest.ID});err!=nil{t.Fatal(err)}
 now:=time.Now();for i:=0;i<3;i++{e:=m.Tick(now.Add(time.Duration(i)*time.Minute));t.Logf("第%d轮：%v",i+1,e)}
 s:=m.Snapshot();if s.Current!="stable"||s.Previous!="broken"||s.Mode!="managed"||!m.health(m.Config.Ports.Official){t.Fatalf("未回退到已知健康：%+v",s)}
 t.Log("连续三次启动失败后，已知健康版本真正恢复服务")
}

func TestExplicitAdoptFakeJmbotsAndRestart(t *testing.T) {
 home:=experiment(t);c:=testConfig(home);dir:=makeRelease(t,home,"external","normal")
 external:=startForeign(t,home,dir,c.Ports.Official)
 m,err:=NewManager(c,testTiming());if err!=nil{t.Fatal(err)};defer m.Close()
 id,err:=m.Begin("adopt",Request{},true);if err!=nil{t.Fatal(err)}
 if op:=waitOperation(t,m,id);op.Status!="succeeded"{t.Fatal(op.Error)}
 if m.Snapshot().Mode!="managed"||m.Snapshot().Official.PID!=external.Identity().PID{t.Fatal("显式接管后身份不符")}
 if err=m.stop(m.official,c.Ports.Official);err!=nil{t.Fatal(err)};m.official=nil
 t.Log("仅针对自建 jmbots.exe：confirm=yes、命令行、PID/路径/创建时间与监听Job均通过后接管")
}

func TestRestartRollbackAndSmoke(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home))
 deployOK(t,m,makeRelease(t,home,"v1","normal"));deployOK(t,m,makeRelease(t,home,"v2","normal"))
 id,err:=m.Begin("rollback",Request{},false);if err!=nil{t.Fatal(err)};if op:=waitOperation(t,m,id);op.Status!="succeeded"{t.Fatal(op.Error)}
 if m.Snapshot().Current!="v1"||m.Snapshot().Previous!="v2"{t.Fatal("手动回退错误")}
 before:=m.Snapshot().Official.PID
 id,err=m.Begin("restart",Request{},false);if err!=nil{t.Fatal(err)};if op:=waitOperation(t,m,id);op.Status!="succeeded"{t.Fatal(op.Error)}
 if m.Snapshot().Current!="v1"||m.Snapshot().Official.PID==before{t.Fatal("重启没有更换进程")}
 m.Config.SmokeCmds=[]Command{{Exe:filepath.Join(os.Getenv("JMSHELL_FIXTURES"),"normal.exe"),Args:[]string{"check","--exit","3"},Dir:home,TimeoutSeconds:2}}
 before=m.Snapshot().Official.PID
 if op:=deploy(t,m,makeRelease(t,home,"v3","normal"));op.Status!="failed"||m.Snapshot().Official.PID!=before{t.Fatal("冒烟失败未保留旧版")}
 t.Log("手动回退、重启通过；冒烟失败保留旧版")
}

func TestCrashAfterHealthyDetected(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"crashes-later","crash-later"))
 p:=m.official;ctx,cancel:=context.WithTimeout(context.Background(),15*time.Second);defer cancel()
 if _,err:=p.Wait(ctx);err!=nil{t.Fatal(err)}
 if err:=m.Tick(time.Now());err!=nil{t.Fatal(err)}
 if m.official.Identity().PID==p.Identity().PID||!m.health(m.Config.Ports.Official){t.Fatal("健康后崩溃未被守护恢复")}
 t.Log("自建假后端健康后退出，守护复查后使用同一冻结版本重启")
}

func TestJobStopsIgnoringSignalAndGrandchild(t *testing.T) {
 home:=experiment(t);fixture:=filepath.Join(os.Getenv("JMSHELL_FIXTURES"),"normal.exe")
 for _,port:=range []int{30095,30096}{ids,err:=winproc.Listeners(port);if err!=nil||len(ids)>0{t.Fatal("测试端口不空闲",port,ids,err)}}
 output,err:=logging.OpenChild(filepath.Join(home,"tree.log"));if err!=nil{t.Fatal(err)}
 p,err:=winproc.Start(winproc.Options{Exe:fixture,Args:[]string{"serve","--port","30095","--host","127.0.0.1","--ignore-terminate","--child-port","30096"},Dir:home,Env:childEnv(filepath.Join(home,"runtime")),Stdout:output,Stderr:output});output.Close();if err!=nil{t.Fatal(err)}
 defer p.Close();defer p.Stop(3*time.Second)
 until:=time.Now().Add(5*time.Second)
 for time.Now().Before(until){a,_:=p.OwnsListener(30095);b,_:=p.OwnsListener(30096);if a&&b{break};time.Sleep(50*time.Millisecond)}
 for _,port:=range []int{30095,30096}{ok,e:=p.OwnsListener(port);if e!=nil||!ok{t.Fatal("后代未加入同一Job",port,ok,e)}}
 identity:=p.Identity();t.Logf("停止前：PID=%d 创建=%d 路径=%s，两个监听者都属同Job",identity.PID,identity.Created,identity.Path)
 if err=p.Stop(5*time.Second);err!=nil{t.Fatal(err)}
 waitPortsFree(t,30095,30096)
 t.Log("忽略软终止的根进程和自建后代均被已核验Job终止")
}

func TestUnknownPortHolderIsNeverStopped(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"old","normal"))
 out,err:=logging.OpenChild(filepath.Join(home,"hold.log"));if err!=nil{t.Fatal(err)}
 holder,err:=winproc.Start(winproc.Options{Exe:filepath.Join(os.Getenv("JMSHELL_FIXTURES"),"normal.exe"),Args:[]string{"serve","--port",fmt.Sprint(m.Config.Ports.Candidate),"--host","127.0.0.1","--behavior","hold"},Dir:home,Env:childEnv(filepath.Join(home,"runtime")),Stdout:out,Stderr:out});out.Close();if err!=nil{t.Fatal(err)}
 defer holder.Close();defer holder.Stop(3*time.Second)
 until:=time.Now().Add(5*time.Second);for time.Now().Before(until){ids,_:=winproc.Listeners(m.Config.Ports.Candidate);if len(ids)>0{break};time.Sleep(30*time.Millisecond)}
 if op:=deploy(t,m,makeRelease(t,home,"new","normal"));op.Status!="failed"{t.Fatal("占用不健康端口仍被当作候选")}
 if alive,e:=holder.Alive();e!=nil||!alive{t.Fatal("陌生占用者被动了",alive,e)}
 if err=holder.Stop(3*time.Second);err!=nil{t.Fatal(err)}
 t.Log("始终不健康且占住端口的外来假进程未被壳子停止；仅测试创建者收尾")
}
