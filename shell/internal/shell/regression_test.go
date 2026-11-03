// 本文件保留审查发现的故障回归：退出关键区、语义坏状态、重解析目录及遗留候选。
package shell

import (
 "os"
 "path/filepath"
 "testing"
 "time"

 "jmbots-shell/internal/storage"
 "jmbots-shell/internal/winproc"
)

func TestSemanticBrokenStateRecoversAndPreservesBackup(t *testing.T) {
 home:=experiment(t);path:=filepath.Join(home,"state.json")
 if err:=storage.WriteJSON(path,State{Current:"v1",Mode:"idle"});err!=nil{t.Fatal(err)}
 if err:=storage.WriteJSON(path,State{Current:"v2",Mode:"idle"});err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(path,[]byte("{}"),0600);err!=nil{t.Fatal(err)}
 m:=newTestManager(t,testConfig(home));if m.Snapshot().Current!="v1"{t.Fatal("语义坏主状态未恢复")}
 var backup State;if _,err:=storage.ReadJSON(path+".bak",&backup);err!=nil||backup.Current!="v1"{t.Fatal("恢复写回破坏了健康bak",backup,err)}
 t.Log("合法JSON但缺字段的{}被拒绝，bak恢复且再次写回保留健康备份")
}

func TestCloseDuringOfficialStartupPreservesService(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"old","normal"))
 id,err:=m.Begin("deploy",Request{ReleaseDir:makeRelease(t,home,"new-delayed","delayed")},false);if err!=nil{t.Fatal(err)}
 until:=time.Now().Add(8*time.Second);started:=false
 for time.Now().Before(until){state:=m.Snapshot();if state.Official!=nil&&filepath.Base(filepath.Dir(state.Official.Path))=="new-delayed"{started=true;break};time.Sleep(20*time.Millisecond)}
 if !started{t.Fatal("未观察到新正式启动关键区")}
 m.Close()
 state:=m.Snapshot();if state.Current!="new-delayed"||m.official==nil{t.Fatal("退出关键区未完成有界切换")}
 identity:=m.official.Identity()
 //M Close只释放句柄；用独立身份检查证明服务仍活，随后仅接管本测试的假服务收尾。
 if err=winproc.Validate(identity);err!=nil{t.Fatal("退出导致正式进程停止",err)}
 cleanup,err:=winproc.Adopt(identity);if err!=nil{t.Fatal(err)}
 if ok,e:=cleanup.OwnsListener(m.Config.Ports.Official);e!=nil||!ok{t.Fatal("退出后服务未继续监听",ok,e)}
 if err=cleanup.Stop(3*time.Second);err!=nil{t.Fatal(err)};cleanup.Close();m.official=nil;m.candidate=nil;waitPortsFree(t,m.Config.Ports.Official,m.Config.Ports.Candidate)
 op,err:=m.GetOperation(id);if err!=nil||op.Status!="succeeded"{t.Fatal(op,err)}
 t.Log("正式启动关键期退出：先完成有界切换，再仅关句柄，假服务仍健康存活")
}

func TestPersistedCandidateIsShownAndNotKilled(t *testing.T) {
 home:=experiment(t);c:=testConfig(home)
 p:=startForeign(t,home,makeRelease(t,home,"orphan-candidate","normal"),c.Ports.Candidate);identity:=p.Identity()
 if err:=storage.WriteJSON(filepath.Join(home,"state.json"),State{Mode:"idle",Candidate:&identity});err!=nil{t.Fatal(err)}
 m,err:=NewManager(c,testTiming());if err!=nil{t.Fatal(err)};defer m.Close()
 if m.Snapshot().Candidate==nil||m.Snapshot().Candidate.PID!=identity.PID{t.Fatal("遗留候选身份被静默抹去")}
 op:=deploy(t,m,makeRelease(t,home,"next","normal"));if op.Status!="failed"{t.Fatal("遗留候选不应被自动替换")}
 if err=winproc.Validate(identity);err!=nil{t.Fatal("遗留候选被错误终止",err)}
 t.Log("新壳保留遗留候选身份并给出人工处理提示；不按端口杀、不擅自接管")
}

func TestRejectLinkedOutputDirectoryBeforeWrites(t *testing.T) {
 home:=experiment(t);outside:=filepath.Join(home,"outside");if err:=os.MkdirAll(outside,0700);err!=nil{t.Fatal(err)}
 if err:=os.Symlink(outside,filepath.Join(home,"logs"));err!=nil{t.Skip("本机不允许创建实验符号链接：",err)}
 if m,err:=NewManager(testConfig(home),testTiming());err==nil{m.Close();t.Fatal("输出链接目录未拒绝")}
 files,err:=os.ReadDir(outside);if err!=nil||len(files)>0{t.Fatal("链接目标被写入",files,err)}
}

func TestExplicitIPv6OfficialHealth(t *testing.T) {
 home:=experiment(t);c:=testConfig(home);c.Host="::1"
 m:=newTestManager(t,c);deployOK(t,m,makeRelease(t,home,"ipv6","normal"))
 if ok,err:=m.healthyOwned(m.official,c.Ports.Official);err!=nil||!ok{t.Fatal("IPv6正式健康探测失败",ok,err)}
 t.Log("IPv6正式监听用::1探测；候选仍用IPv4回环，双方归属都核验")
}
