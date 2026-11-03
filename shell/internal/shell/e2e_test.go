// 本文件用两个真实壳子实例和控制客户端演示完整换版、强杀存活与重启旁观；只运行自建假后端。
package shell

import (
 "context"
 "encoding/json"
 "fmt"
 "io"
 "os"
 "path/filepath"
 "testing"
 "time"

 "jmbots-shell/internal/logging"
 "jmbots-shell/internal/winproc"
)

func startShellBinary(t *testing.T,home,tag string)*winproc.Process {
 t.Helper();exe:=filepath.Join(os.Getenv("JMSHELL_BIN"),"jmshell.exe")
 output,err:=logging.OpenChild(filepath.Join(home,tag+"-process.log"));if err!=nil{t.Fatal(err)}
 p,err:=winproc.Start(winproc.Options{Exe:exe,Args:[]string{"--home",home,"--headless"},Dir:home,Env:childEnv(filepath.Join(home,"runtime")),Stdout:output,Stderr:output});output.Close();if err!=nil{t.Fatal(err)}
 id:=p.Identity();t.Logf("创建壳子 tag=%s PID=%d path=%s created=%d",tag,id.PID,id.Path,id.Created)
 t.Cleanup(func(){if err:=p.Stop(5*time.Second);err!=nil{t.Error("清理本测试壳子Job：",err)};p.Close()})
 return p
}

func ctl(t *testing.T,home string,args ...string)(string,error) {
 t.Helper();log:=filepath.Join(home,"ctl-"+uniqueID()+".log")
 out,err:=logging.OpenChild(log);if err!=nil{return "",err}
 all:=append([]string{"--home",home},args...)
 t.Logf("命令：jmshellctl --home %q %v（凭据由客户端内部消费，不打印）",home,args)
 p,err:=winproc.Start(winproc.Options{Exe:filepath.Join(os.Getenv("JMSHELL_BIN"),"jmshellctl.exe"),Args:all,Dir:home,Env:childEnv(filepath.Join(home,"runtime")),Stdout:out,Stderr:out});out.Close();if err!=nil{return "",err};defer p.Close()
 ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second);defer cancel();exit,err:=p.Wait(ctx);stopErr:=p.Stop(3*time.Second)
 text,readErr:=logging.Tail(log,100);if readErr!=nil{return "",readErr};t.Logf("客户端退出码=%d 输出=%s",exit,text)
 if err!=nil{return text,err};if stopErr!=nil{return text,stopErr};if exit!=0{return text,fmt.Errorf("控制客户端退出码 %d",exit)};return text,nil
}

func waitControl(t *testing.T,port int) {
 t.Helper();client:=localClient(200*time.Millisecond);until:=time.Now().Add(10*time.Second)
 for time.Now().Before(until){res,err:=client.Get(fmt.Sprintf("http://127.0.0.1:%d/status",port));if err==nil{res.Body.Close();if res.StatusCode==401{return}};time.Sleep(50*time.Millisecond)}
 t.Fatal("控制口未在期限内启动")
}

func TestE2EDeployShellCrashSurvivalAndObserver(t *testing.T) {
 home:=experiment(t);c:=testConfig(home)
 t.Cleanup(func(){waitPortsFree(t,c.Ports.Control,c.Ports.Official,c.Ports.Candidate)})
 for _,port:=range []int{30091,30092,30093}{list,err:=winproc.Listeners(port);if err!=nil||len(list)!=0{t.Fatalf("端口预检 %d：%v %v",port,list,err)}}
 if err:=os.MkdirAll(c.RuntimeDir,0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(home,"shell.json"),mustJSON(c),0600);err!=nil{t.Fatal(err)}
 //G 真实exe演示不载入真实后端；发布源全部由fake fixture制作。
 v1:=makeRelease(t,home,"e2e-v1","normal");v2:=makeRelease(t,home,"e2e-v2","normal")
 first:=startShellBinary(t,home,"first");waitControl(t,c.Ports.Control)
 if _,err:=ctl(t,home,"--release-dir",v1,"--wait","deploy");err!=nil{t.Fatal(err)}
 if _,err:=ctl(t,home,"--release-dir",v2,"--wait","deploy");err!=nil{t.Fatal(err)}
 data,err:=ctl(t,home,"status");if err!=nil{t.Fatal(err)}
 var before State;if err=json.Unmarshal([]byte(data),&before);err!=nil{t.Fatal(err)}
 if before.Current!="e2e-v2"||before.Previous!="e2e-v1"||before.Official==nil{t.Fatalf("端到端换版失败：%+v",before)}
 //M 强杀前再核验本测试直接创建的壳子身份；只终止壳子根，不终止其Job。
 identity:=first.Identity();if err=winproc.Validate(identity);err!=nil{t.Fatal(err)}
 t.Logf("强杀前核验：PID=%d 路径=%s 创建时间=%d",identity.PID,identity.Path,identity.Created)
 if err=winproc.KillOwned(identity);err!=nil{t.Fatal(err)}
 ctx,cancel:=context.WithTimeout(context.Background(),5*time.Second);defer cancel();if _,err=first.Wait(ctx);err!=nil{t.Fatal(err)}
 //M 监听句柄不能被子进程继承，因此壳控制口应释放，假后端仍健康。
 until:=time.Now().Add(5*time.Second)
 for time.Now().Before(until){list,e:=winproc.Listeners(c.Ports.Control);if e!=nil{t.Fatal(e)};if len(list)==0{break};time.Sleep(30*time.Millisecond)}
 list,err:=winproc.Listeners(c.Ports.Control);if err!=nil||len(list)!=0{t.Fatal("壳子控制监听句柄疑似被继承",list,err)}
 if err=winproc.Validate(*before.Official);err!=nil{t.Fatal("壳强杀后服务未存活：",err)}
 client:=localClient(time.Second);res,err:=client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health",c.Ports.Official));if err!=nil{t.Fatal(err)};body,err:=io.ReadAll(res.Body);res.Body.Close();if err!=nil||res.StatusCode!=200{t.Fatal(err,string(body))}
 t.Logf("强杀后假后端仍健康：PID=%d 创建时间=%d response=%s",before.Official.PID,before.Official.Created,body)
 second:=startShellBinary(t,home,"second");waitControl(t,c.Ports.Control)
 data,err=ctl(t,home,"status");if err!=nil{t.Fatal(err)}
 var after State;if err=json.Unmarshal([]byte(data),&after);err!=nil{t.Fatal(err)}
 if after.Mode!="observer"{t.Fatal("新壳子未旁观旧进程：",after.Mode)}
 if _,err=ctl(t,home,"restart");err==nil{t.Fatal("旁观模式竟允许重启")}
 if err=winproc.Validate(*before.Official);err!=nil{t.Fatal("旁观重启请求伤害了原假后端：",err)}
 //M 收尾顺序：先停第二壳子自己的Job，再停第一测试容器Job（含其遗留假后端）。
 if err=second.Stop(5*time.Second);err!=nil{t.Fatal(err)}
 if err=first.Stop(5*time.Second);err!=nil{t.Fatal(err)}
 waitPortsFree(t,c.Ports.Control,c.Ports.Official,c.Ports.Candidate)
 t.Log("端到端完整deploy、壳强杀后服务存活、控制句柄释放、新壳旁观、拒绝重启及清理全部通过")
}
