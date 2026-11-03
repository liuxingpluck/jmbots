// jmshellctl 是控制台客户端，内部读取当前用户凭据但不打印，不负责启动被守护服务。
package main

import (
 "bytes"
 "encoding/json"
 "flag"
 "fmt"
 "io"
 "net/http"
 "os"
 "strings"
 "time"

 core "jmbots-shell/internal/shell"
)

func main(){if err:=run();err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}}

func run()error {
 flags:=flag.NewFlagSet("jmshellctl",flag.ContinueOnError)
 home:=flags.String("home","","壳子目录")
 release:=flags.String("release-dir","","发布包目录")
 session:=flags.String("session-id","","可选报告会话")
 confirm:=flags.Bool("confirm",false,"明确确认接管")
 wait:=flags.Bool("wait",false,"等待异步操作完成")
 if err:=flags.Parse(os.Args[1:]);err!=nil{return err}
 args:=flags.Args();if len(args)<1{return fmt.Errorf("用法：jmshellctl --home 目录 [--release-dir 包] [--wait] status|deploy|rollback|restart|adopt|ops ID|logs")}
 resolved,err:=core.ResolveHome(*home,"");if err!=nil{return err}
 config,err:=core.LoadConfig(resolved);if err!=nil{return err}
 token,err:=core.LoadToken(resolved,false);if err!=nil{return err}
 action:=args[0];path:="/"+action;method:="GET"
 switch action {
 case "status","logs":
 case "ops":if len(args)!=2{return fmt.Errorf("ops 需要操作标识")};path+="/"+args[1]
 case "deploy","rollback","restart","adopt":method="POST"
 default:return fmt.Errorf("未知命令")
 }
 if action=="adopt" {if !*confirm{return fmt.Errorf("接管需要 --confirm")};path+="?confirm=yes"}
 payload,_:=json.Marshal(core.Request{ReleaseDir:*release,SessionID:*session})
 client:=&http.Client{Timeout:15*time.Second,Transport:&http.Transport{Proxy:nil},CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
 base:=fmt.Sprintf("http://127.0.0.1:%d",config.Ports.Control)
 call:=func(method,path string,body []byte)([]byte,error){
  req,e:=http.NewRequest(method,base+path,bytes.NewReader(body));if e!=nil{return nil,e};req.Header.Set("Authorization","Bearer "+token);req.Header.Set("Content-Type","application/json")
  res,e:=client.Do(req);if e!=nil{return nil,e};defer res.Body.Close();b,e:=io.ReadAll(io.LimitReader(res.Body,2<<20));if e!=nil{return nil,e};if res.StatusCode<200||res.StatusCode>=300{return b,fmt.Errorf("控制口 HTTP %d：%s",res.StatusCode,b)};return b,nil
 }
 data,err:=call(method,path,payload);if err!=nil{return err};fmt.Println(string(data))
 if !*wait||method!="POST"{return nil}
 var accepted struct{ID string `json:"op_id"`};if err=json.Unmarshal(data,&accepted);err!=nil{return err}
 until:=time.Now().Add(2*time.Hour)
 for time.Now().Before(until) {
  data,err=call("GET","/ops/"+accepted.ID,nil);if err!=nil{return err}
  var op core.Operation;if err=json.Unmarshal(data,&op);err!=nil{return err}
  if op.Status!="running"{fmt.Println(strings.TrimSpace(string(data)));if op.Status!="succeeded"{return fmt.Errorf("操作未成功：%s",op.Error)};return nil}
  time.Sleep(250*time.Millisecond)
 }
 return fmt.Errorf("等待操作超时；操作可能仍在运行，请通过 ops 查看")
}
