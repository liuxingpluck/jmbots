// 本文件校验配置、构建命令输出、检查超时与结果报告契约；接口监听只使用实验端口。
package shell

import (
 "encoding/json"
 "fmt"
 "io"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "strings"
 "testing"
 "time"
)

func TestConfigDefaultsAndStrictLoading(t *testing.T) {
 home:=experiment(t);defaults:=Defaults(home)
 if defaults.Ports!=(Ports{30085,30086,30087})||defaults.Host!="127.0.0.1"{t.Fatal("默认值不符；本测试未监听默认端口")}
 c:=testConfig(home);path:=filepath.Join(home,"shell.json")
 if err:=os.WriteFile(path,mustJSON(c),0600);err!=nil{t.Fatal(err)}
 loaded,err:=LoadConfig(home);if err!=nil||loaded.Ports!=c.Ports{t.Fatal(loaded,err)}
 if err=os.WriteFile(path,[]byte(`{"unexpected":true}`),0600);err!=nil{t.Fatal(err)}
 if _,err=LoadConfig(home);err==nil{t.Fatal("配置未知字段未拒绝")}
 bad:=c;bad.Ports.Candidate=bad.Ports.Official;if bad.Validate()==nil{t.Fatal("重复端口未拒绝")}
 bad=c;bad.HealthPath="http://foreign.invalid/";if bad.Validate()==nil{t.Fatal("外部健康地址未拒绝")}
 bad=c;bad.GateCmds=[]Command{{Exe:`F:\bad.cmd`,Dir:home,TimeoutSeconds:1}};if bad.Validate()==nil{t.Fatal("cmd包装器未拒绝")}
}

func TestBuildOutputProcess(t *testing.T) {
 target:=os.Getenv("JMSHELL_TEST_BUILD_OUTPUT")
 if target==""{return}
 if !strings.HasPrefix(strings.ToLower(filepath.ToSlash(target)),"f:/aidata/cache/jmshell_exp/"){os.Exit(80)}
 fmt.Println(target);os.Exit(0)
}

func TestBuildGateSmokeAndReport(t *testing.T) {
 home:=experiment(t);dir:=makeRelease(t,home,"built","normal");t.Setenv("JMSHELL_TEST_BUILD_OUTPUT",dir)
 c:=testConfig(home);exe,err:=os.Executable();if err!=nil{t.Fatal(err)}
 c.BuildCmd=&Command{Exe:exe,Args:[]string{"-test.run=^TestBuildOutputProcess$"},Dir:home,TimeoutSeconds:3}
 check:=Command{Exe:filepath.Join(os.Getenv("JMSHELL_FIXTURES"),"normal.exe"),Args:[]string{"check","--exit","0"},Dir:home,TimeoutSeconds:3}
 c.GateCmds=[]Command{check};c.SmokeCmds=[]Command{check};c.ReportURL="http://127.0.0.1:30097/api/run"
 listener,err:=net.Listen("tcp4","127.0.0.1:30097");if err!=nil{t.Fatal(err)}
 reported:=make(chan map[string]any,1)
 server:=&http.Server{ReadHeaderTimeout:time.Second,Handler:http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){var body map[string]any;if r.Method!="POST"||r.URL.Path!="/api/run"{http.Error(w,"不接受",400);return};if err:=json.NewDecoder(io.LimitReader(r.Body,65536)).Decode(&body);err!=nil{http.Error(w,"无效",400);return};reported<-body;w.WriteHeader(200)})}
 go server.Serve(listener);defer server.Close()
 m:=newTestManager(t,c);id,err:=m.Begin("deploy",Request{SessionID:"fake-session"},false);if err!=nil{t.Fatal(err)}
 if op:=waitOperation(t,m,id);op.Status!="succeeded"{t.Fatal(op.Error)}
 select{case body:=<-reported:if body["sessionId"]!="fake-session"||body["wait"]!=false{t.Fatal("报告格式错误")};t.Log("构建输出目录、gate和smoke通过，报告POST /api/run格式正确");case<-time.After(time.Second):t.Fatal("未收到结果报告")}
}

func TestGateTimeoutLeavesOldAndReportFailureNonfatal(t *testing.T) {
 home:=experiment(t);c:=testConfig(home);c.ReportURL="http://127.0.0.1:30097/api/run"
 m:=newTestManager(t,c);deployOK(t,m,makeRelease(t,home,"old","normal"))
 before:=*m.Snapshot().Official
 m.Config.GateCmds=[]Command{{Exe:filepath.Join(os.Getenv("JMSHELL_FIXTURES"),"normal.exe"),Args:[]string{"check","--delay","4s"},Dir:home,TimeoutSeconds:1}}
 op:=deploy(t,m,makeRelease(t,home,"new","normal"));if op.Status!="failed"||*m.Snapshot().Official!=before{t.Fatal("超时检查影响旧版")}
 t.Log("gate超时有界终止自己的Job；报告端口不通不撤销部署或改变旧版")
}
