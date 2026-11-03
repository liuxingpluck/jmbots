// 本文件只使用指定实验目录中的假后端与 30091–30097，逐场景留下状态和原始测试证据。
package shell

import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "net/http"
 "net/http/httptest"
 "os"
 "path/filepath"
 "strings"
 "sync"
 "testing"
 "time"

 "jmbots-shell/internal/logging"
 "jmbots-shell/internal/storage"
 "jmbots-shell/internal/winproc"
)

func experiment(t *testing.T)string {
 t.Helper();root:=os.Getenv("JMSHELL_TEST_ROOT")
 if root==""||!strings.HasPrefix(strings.ToLower(filepath.ToSlash(root)),"f:/aidata/cache/jmshell_exp/"){t.Fatal("测试必须设置实验根 JMSHELL_TEST_ROOT，拒绝默认运行时")}
 if err:=os.MkdirAll(root,0700);err!=nil{t.Fatal(err)}
 dir,err:=os.MkdirTemp(root,t.Name()+"-");if err!=nil{t.Fatal(err)};t.Log("证据目录：",dir);return dir
}

func waitPortsFree(t *testing.T,ports ...int) {
 t.Helper();until:=time.Now().Add(5*time.Second)
 for time.Now().Before(until){free:=true;for _,port:=range ports{ids,err:=winproc.Listeners(port);if err!=nil||len(ids)>0{free=false}};if free{return};time.Sleep(30*time.Millisecond)}
 for _,port:=range ports{ids,err:=winproc.Listeners(port);if err!=nil||len(ids)>0{t.Errorf("有界等待后实验端口仍未释放 %d：%v %v；未终止陌生进程",port,ids,err)}}
}

func testConfig(home string)Config {
 c:=Defaults(home);c.RuntimeDir=filepath.Join(home,"runtime");c.Ports=Ports{30091,30092,30093};c.NotifyDirs=[]string{filepath.Join(home,"notifications")};return c
}
func testTiming()Timing {return Timing{3*time.Second,40*time.Millisecond,300*time.Millisecond,30*time.Second,30*time.Millisecond,5*time.Minute,10*time.Minute,3*time.Second}}

func newTestManager(t *testing.T,c Config)*Manager {
 t.Helper()
 for _,port:=range []int{c.Ports.Control,c.Ports.Official,c.Ports.Candidate}{listeners,err:=winproc.Listeners(port);if err!=nil||len(listeners)>0{t.Fatalf("测试前端口 %d 不可用：%v %v；未终止任何占用者",port,listeners,err)}}
 if err:=os.MkdirAll(c.RuntimeDir,0700);err!=nil{t.Fatal(err)}
 m,err:=NewManager(c,testTiming());if err!=nil{t.Fatal(err)}
 t.Cleanup(func(){
  m.cancel();m.wg.Wait()
  for _,item:=range []struct{p *winproc.Process;port int}{{m.candidate,c.Ports.Candidate},{m.official,c.Ports.Official}} {if item.p!=nil{if err:=m.stop(item.p,item.port);err!=nil{t.Errorf("清理自建假进程失败：%v",err)}}}
  m.candidate=nil;m.official=nil
  if err:=m.Close();err!=nil{t.Error(err)}
  for _,port:=range []int{c.Ports.Official,c.Ports.Candidate}{listeners,e:=winproc.Listeners(port);if e!=nil||len(listeners)>0{t.Errorf("清理后端口 %d 仍占用：%v %v",port,listeners,e)}}
 })
 return m
}

func makeRelease(t *testing.T,home,id,profile string)string {
 t.Helper();fixture:=filepath.Join(os.Getenv("JMSHELL_FIXTURES"),profile+".exe")
 b,err:=os.ReadFile(fixture);if err!=nil{t.Fatal("假后端 fixture 不存在：",err)}
 dir:=filepath.Join(home,"input",id);if err=os.MkdirAll(dir,0700);err!=nil{t.Fatal(err)}
 if err=os.WriteFile(filepath.Join(dir,"jmbots.exe"),b,0700);err!=nil{t.Fatal(err)}
 sum:=sha256.Sum256(b);manifest:=Manifest{ID:id,BuiltAt:time.Now().UTC().Format(time.RFC3339),GitCommit:"fake-only",Dirty:false,SHA256:hex.EncodeToString(sum[:]),Size:int64(len(b))}
 if err=os.WriteFile(filepath.Join(dir,"manifest.json"),mustJSON(manifest),0600);err!=nil{t.Fatal(err)};return dir
}

func waitOperation(t *testing.T,m *Manager,id string)Operation {
 t.Helper();until:=time.Now().Add(30*time.Second)
 for time.Now().Before(until){op,err:=m.GetOperation(id);if err!=nil{t.Fatal(err)};if op.Status!="running"{m.action.Lock();m.action.Unlock();t.Logf("操作=%s 类型=%s 结果=%s 错误=%s",id,op.Kind,op.Status,op.Error);return op};time.Sleep(30*time.Millisecond)}
 t.Fatal("操作未在测试期限内完成");return Operation{}
}
func deploy(t *testing.T,m *Manager,dir string)Operation {t.Helper();id,err:=m.Begin("deploy",Request{ReleaseDir:dir},false);if err!=nil{t.Fatal(err)};return waitOperation(t,m,id)}
func deployOK(t *testing.T,m *Manager,dir string) {t.Helper();if op:=deploy(t,m,dir);op.Status!="succeeded"{t.Fatal(op.Error)}}

func TestDeployNormalSuccess(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home))
 deployOK(t,m,makeRelease(t,home,"v1","normal"));first:=*m.Snapshot().Official
 deployOK(t,m,makeRelease(t,home,"v2","normal"));s:=m.Snapshot()
 if s.Current!="v2"||s.Previous!="v1"||s.Candidate!=nil||s.Official.PID==first.PID{t.Fatalf("换版状态错误：%+v",s)}
 if ok,err:=m.healthyOwned(m.official,m.Config.Ports.Official);err!=nil||!ok{t.Fatal(ok,err)}
 if err:=m.Tick(s.HealthySince.Add(5*time.Minute));err!=nil{t.Fatal(err)}
 if m.Snapshot().LastGood!="v2"{t.Fatal("稳定五分钟未标记已知健康版本")}
 t.Log("正常换版通过；同一冻结版本在候选和正式使用；旧版本记录和稳定标记正确")
}

func TestGateFailureLeavesOldUntouched(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"old","normal"));before:=*m.Snapshot().Official
 m.Config.GateCmds=[]Command{{Exe:filepath.Join(os.Getenv("JMSHELL_FIXTURES"),"normal.exe"),Args:[]string{"check","--exit","7"},Dir:home,TimeoutSeconds:3}}
 op:=deploy(t,m,makeRelease(t,home,"new","normal"));after:=m.Snapshot()
 if op.Status!="failed"||after.Current!="old"||*after.Official!=before{t.Fatalf("gate失败影响旧版：%+v %s",after,op.Error)}
 if err:=winproc.Validate(before);err!=nil{t.Fatal(err)}
 t.Log("gate 返回7，原 PID/路径/创建时间均保持且健康")
}

func TestCandidateFailureLeavesOldUntouched(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"old","normal"));before:=*m.Snapshot().Official
 op:=deploy(t,m,makeRelease(t,home,"bad-candidate","candidate-crash"))
 if op.Status!="failed"||m.Snapshot().Current!="old"||*m.Snapshot().Official!=before{t.Fatal("候选失败却修改旧版")}
 if !m.health(m.Config.Ports.Official){t.Fatal("旧版不健康")}
 t.Log("候选崩溃已拒绝，旧版未停止")
}

func TestOfficialFailureImmediatelyRollsBack(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"old","normal"))
 op:=deploy(t,m,makeRelease(t,home,"bad-official","official-crash"));s:=m.Snapshot()
 if op.Status!="failed"||s.Current!="old"||!m.health(m.Config.Ports.Official)||s.Candidate!=nil{t.Fatalf("正式失败未恢复：%+v %s",s,op.Error)}
 t.Log("候选正常而正式崩溃，操作失败并立即恢复旧包")
}

func TestGuardianThreeFailuresRollbackAndCooldown(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home))
 current,err:=FreezeRelease(home,makeRelease(t,home,"bad-current","crash"));if err!=nil{t.Fatal(err)}
 good,err:=FreezeRelease(home,makeRelease(t,home,"bad-lastgood","crash"));if err!=nil{t.Fatal(err)}
 if err=m.mutate(func(s *State){s.Current=current.Manifest.ID;s.LastGood=good.Manifest.ID});err!=nil{t.Fatal(err)}
 now:=time.Now()
 for i:=0;i<3;i++{err=m.Tick(now.Add(time.Duration(i)*time.Minute));t.Logf("第%d次启动失败：%v",i+1,err)}
 s:=m.Snapshot();if s.Mode!="quiet"||s.QuietUntil.Before(now.Add(2*time.Minute).Add(10*time.Minute))||s.QuietUntil.After(now.Add(13*time.Minute)){t.Fatalf("未准确进入十分钟停手：%+v",s)}
 before:=s.UpdatedAt;if err=m.Tick(now.Add(3*time.Minute));err!=nil{t.Fatal(err)}
 if !m.Snapshot().UpdatedAt.Equal(before){t.Fatal("停手期仍有状态/启动动作")}
 files,_:=filepath.Glob(filepath.Join(home,"notifications","*.md"));if len(files)<2{t.Fatal("缺少回退/停手通知")}
 t.Log("连续三次失败，回退版本也失败，十分钟冷却内无重启动作")
}

func startForeign(t *testing.T,home,dir string,port int)*winproc.Process {
 t.Helper();out,err:=logging.OpenChild(filepath.Join(home,fmt.Sprintf("foreign-%d.log",port)));if err!=nil{t.Fatal(err)}
 p,err:=winproc.Start(winproc.Options{Exe:filepath.Join(dir,"jmbots.exe"),Args:[]string{"serve","--port",fmt.Sprint(port),"--host","127.0.0.1"},Dir:dir,Env:childEnv(filepath.Join(home,"runtime")),Stdout:out,Stderr:out});out.Close();if err!=nil{t.Fatal(err)}
 t.Cleanup(func(){if err:=p.Stop(3*time.Second);err!=nil{t.Error("外来假后端清理失败：",err)};p.Close();waitPortsFree(t,port)})
 until:=time.Now().Add(5*time.Second);client:=localClient(300*time.Millisecond)
 for time.Now().Before(until){r,e:=client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health",port));if e==nil{r.Body.Close();if r.StatusCode==200{return p}};time.Sleep(30*time.Millisecond)}
 t.Fatal("外来假后端未健康");return p
}

func TestForeignHealthyOwnerRejectedAndObserved(t *testing.T) {
 home:=experiment(t);c:=testConfig(home)
 p:=startForeign(t,home,makeRelease(t,home,"foreign","normal"),c.Ports.Official);identity:=p.Identity()
 m,err:=NewManager(c,testTiming());if err!=nil{t.Fatal(err)};defer m.Close()
 if m.Snapshot().Mode!="observer"{t.Fatal("未进入旁观")}
 for _,kind:=range []string{"deploy","restart","rollback"}{if _,err=m.Begin(kind,Request{},false);err!=ErrObserver{t.Fatal(kind,err)}}
 if err=m.Tick(time.Now());err!=nil{t.Fatal(err)}
 if err=winproc.Validate(identity);err!=nil{t.Fatal("旁观者影响外来进程：",err)}
 if _,err=m.Begin("adopt",Request{},false);err==nil{t.Fatal("未确认也允许接管")}
 t.Log("健康响应不能替代归属；旁观/部署/重启/回退均未终止外来假后端")
}

func TestCandidatePortImpersonationRejected(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"old","normal"))
 foreign:=startForeign(t,home,makeRelease(t,home,"foreign","normal"),m.Config.Ports.Candidate)
 op:=deploy(t,m,makeRelease(t,home,"new","normal"));if op.Status!="failed"{t.Fatal("错误接受了他人候选健康")}
 if err:=winproc.Validate(foreign.Identity());err!=nil{t.Fatal(err)}
 //M 提前停止本测试明确创建的外来假后端，供统一清理检查端口。
 if err:=foreign.Stop(3*time.Second);err!=nil{t.Fatal(err)}
 t.Log("候选端口被他人冒用时拒绝换版，不终止该占用者")
}

func TestConcurrentDeployOnlyOneAccepted(t *testing.T) {
 home:=experiment(t);c:=testConfig(home)
 c.GateCmds=[]Command{{Exe:filepath.Join(os.Getenv("JMSHELL_FIXTURES"),"normal.exe"),Args:[]string{"check","--delay","500ms"},Dir:home,TimeoutSeconds:3}}
 m:=newTestManager(t,c);dir:=makeRelease(t,home,"v1","normal")
 type result struct{id string;err error};results:=make(chan result,2);var wg sync.WaitGroup;start:=make(chan struct{})
 for i:=0;i<2;i++{wg.Add(1);go func(){defer wg.Done();<-start;id,err:=m.Begin("deploy",Request{ReleaseDir:dir},false);results<-result{id,err}}()};close(start);wg.Wait();close(results)
 accepted,busy:=0,0
 for r:=range results {if r.err==nil{accepted++;if op:=waitOperation(t,m,r.id);op.Status!="succeeded"{t.Fatal(op.Error)}}else if r.err==ErrBusy{busy++}else{t.Fatal(r.err)}}
 if accepted!=1||busy!=1{t.Fatal(accepted,busy)};t.Log("两个并发 deploy：一个202操作，一个409忙碌")
}

func TestControlAuthenticationAllRoutes(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));token:=strings.Repeat("a",64);handler:=m.Handler(token)
 for _,path:=range []string{"/status","/deploy","/rollback","/restart","/adopt?confirm=yes","/ops/missing","/logs?tail=200","/missing"}{
  for _,mode:=range []string{"none","wrong","origin","empty-origin"}{
   request:=httptest.NewRequest(http.MethodGet,path,nil)
   if mode=="wrong"{request.Header.Set("Authorization","Bearer wrong")}
   if mode=="origin"||mode=="empty-origin"{request.Header.Set("Authorization","Bearer "+token);request.Header["Origin"]=[]string{""};if mode=="origin"{request.Header.Set("Origin","http://foreign.invalid")}}
   response:=httptest.NewRecorder();handler.ServeHTTP(response,request);want:=401;if mode=="origin"||mode=="empty-origin"{want=403};if response.Code!=want{t.Fatalf("%s %s=%d",path,mode,response.Code)}
  }
 }
 request:=httptest.NewRequest(http.MethodGet,"/status",nil);request.Header.Set("Authorization","Bearer "+token);response:=httptest.NewRecorder();handler.ServeHTTP(response,request)
 if response.Code!=200||strings.Contains(response.Body.String(),token){t.Fatal("认证正常路径或令牌泄漏异常")}
 t.Log("全路由无令牌/错令牌401，含Origin（包括空值）403，正确凭据200且不回显")
}

func TestStateRecoveryBeforeManagerStart(t *testing.T) {
 home:=experiment(t);statePath:=filepath.Join(home,"state.json")
 if err:=storage.WriteJSON(statePath,State{Current:"v1",Mode:"idle"});err!=nil{t.Fatal(err)}
 if err:=storage.WriteJSON(statePath,State{Current:"v2",Mode:"idle"});err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(statePath,[]byte(`{"current":`),0600);err!=nil{t.Fatal(err)}
 m:=newTestManager(t,testConfig(home));if m.Snapshot().Current!="v1"{t.Fatal("未从bak恢复半写状态")}
 t.Log("注入半写state.json，启动恢复bak中的v1，未误清空状态")
}

func TestFrozenReleaseRejectsHashMismatchAndOverwrite(t *testing.T) {
 home:=experiment(t);dir:=makeRelease(t,home,"v1","normal")
 if _,err:=FreezeRelease(home,dir);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(dir,"jmbots.exe"),[]byte("corrupt"),0600);err!=nil{t.Fatal(err)}
 if _,err:=FreezeRelease(home,dir);err==nil{t.Fatal("接受损坏哈希")}
 var manifest Manifest;data,err:=os.ReadFile(filepath.Join(home,"releases","v1","manifest.json"));if err!=nil{t.Fatal(err)};if err=json.Unmarshal(data,&manifest);err!=nil{t.Fatal(err)}
 if !validID(manifest.ID)||validID("../escape")||validID("CON"){t.Fatal("版本ID检查错误")}
}

func TestDelayedHealthAndIgnoredTermination(t *testing.T) {
 home:=experiment(t);m:=newTestManager(t,testConfig(home));deployOK(t,m,makeRelease(t,home,"delayed","delayed"))
 p:=m.official;id:=p.Identity();if err:=m.stop(p,m.Config.Ports.Official);err!=nil{t.Fatal(err)};m.official=nil
 ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel();_,err:=p.Wait(ctx);_ = err
 if err=winproc.Validate(id);err==nil{t.Fatal("Job终止后进程仍存活")}
 t.Log("延迟健康通过；精确Job强制停止不依赖进程响应软终止")
}
