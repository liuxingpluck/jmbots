// 本文件提供仅回环的认证控制口和本地凭据加载；凭据永不出现在响应或日志里。
package shell

import (
 "crypto/rand"
 "crypto/subtle"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "strconv"
 "strings"
 "time"

 "jmbots-shell/internal/logging"
 "jmbots-shell/internal/winproc"
)

// LoadToken 仅供壳子/控制客户端内部消费凭据；create 允许首次随机生成，返回值禁止打印。
func LoadToken(home string,create bool)(string,error) {
 path:=filepath.Join(home,"token")
 if _,err:=os.Lstat(path);os.IsNotExist(err)&&create {
  f,e:=winproc.CreatePrivateFile(path);if e!=nil{return "",e}
  var b [32]byte;_,e=rand.Read(b[:])
  value:=hex.EncodeToString(b[:])
  if e==nil{_,e=f.WriteString(value)};if e==nil{e=f.Sync()};closeErr:=f.Close()
  if e!=nil{return "",fmt.Errorf("凭据创建失败")};if closeErr!=nil{return "",closeErr};return value,nil
 }
 if err:=checkPlainPath(path);err!=nil{return "",fmt.Errorf("凭据路径不安全或不存在")}
 //G 读取前修正仅当前用户权限；失败即拒绝启动，不能回落到宽权限。
 if err:=winproc.ProtectFile(path);err!=nil{return "",fmt.Errorf("凭据权限设置失败：%w",err)}
 f,err:=os.Open(path);if err!=nil{return "",fmt.Errorf("无法读取本地控制凭据")};defer f.Close()
 b,err:=io.ReadAll(io.LimitReader(f,65));if err!=nil||len(b)!=64{return "",fmt.Errorf("本地控制凭据格式无效")}
 if _,err=hex.DecodeString(string(b));err!=nil{return "",fmt.Errorf("本地控制凭据格式无效")}
 return string(b),nil
}

// Handler 构造认证路由，输入令牌只驻留内存，所有路由包含未知路由均先认证。
func (m *Manager) Handler(token string)http.Handler {
 return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  w.Header().Set("Content-Type","application/json; charset=utf-8");w.Header().Set("Cache-Control","no-store");w.Header().Set("X-Content-Type-Options","nosniff")
  //G 即使 Origin 值为空，只要头出现就拒绝浏览器跨站路径。
  for key:=range r.Header {if strings.EqualFold(key,"Origin"){controlError(w,http.StatusForbidden,"拒绝带 Origin 的请求");return}}
  expected:="Bearer "+token
  if len(token)<32||subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")),[]byte(expected))!=1 {controlError(w,http.StatusUnauthorized,"需要有效控制凭据");return}
  switch {
  case r.URL.Path=="/status":
   if !method(w,r,"GET"){return};json.NewEncoder(w).Encode(m.Snapshot())
  case r.URL.Path=="/logs":
   if !method(w,r,"GET"){return};tail:=200
   if value:=r.URL.Query().Get("tail");value!="" {n,err:=strconv.Atoi(value);if err!=nil||n<1||n>2000{controlError(w,400,"tail 应为 1–2000");return};tail=n}
   text,err:=logging.Tail(filepath.Join(m.Config.Home,"logs","shell.log"),tail);if err!=nil{controlError(w,500,"日志不可读");return};json.NewEncoder(w).Encode(map[string]string{"text":logging.Redact(text)})
  case strings.HasPrefix(r.URL.Path,"/ops/"):
   if !method(w,r,"GET"){return};op,err:=m.GetOperation(strings.TrimPrefix(r.URL.Path,"/ops/"));if err!=nil{controlError(w,404,"操作不存在");return};json.NewEncoder(w).Encode(op)
  case r.URL.Path=="/deploy"||r.URL.Path=="/rollback"||r.URL.Path=="/restart"||r.URL.Path=="/adopt":
   if !method(w,r,"POST"){return}
   var input Request
   r.Body=http.MaxBytesReader(w,r.Body,65536)
   decoder:=json.NewDecoder(r.Body);decoder.DisallowUnknownFields()
   err:=decoder.Decode(&input)
   if err!=nil&&err!=io.EOF{controlError(w,400,"请求 JSON 无效");return}
   if err==nil&&decoder.Decode(new(any))!=io.EOF {controlError(w,400,"只允许一个 JSON 对象");return}
   kind:=strings.TrimPrefix(r.URL.Path,"/")
   id,err:=m.Begin(kind,input,r.URL.Query().Get("confirm")=="yes")
   if err!=nil {code:=400;if errors.Is(err,ErrBusy)||errors.Is(err,ErrObserver){code=409};controlError(w,code,err.Error());return}
   w.WriteHeader(http.StatusAccepted);json.NewEncoder(w).Encode(map[string]string{"op_id":id})
  default:controlError(w,404,"接口不存在")
  }
 })
}
func method(w http.ResponseWriter,r *http.Request,want string)bool {if r.Method==want{return true};w.Header().Set("Allow",want);controlError(w,405,"不支持的方法");return false}
func controlError(w http.ResponseWriter,code int,text string){w.WriteHeader(code);json.NewEncoder(w).Encode(map[string]string{"error":logging.Redact(text)})}

// ListenControl 创建只绑定 127.0.0.1 的监听器；返回服务器由调用方显式关闭。
func (m *Manager) ListenControl(token string)(*http.Server,net.Listener,error) {
 listener,err:=net.Listen("tcp4",net.JoinHostPort("127.0.0.1",strconv.Itoa(m.Config.Ports.Control)));if err!=nil{return nil,nil,err}
 server:=&http.Server{Handler:m.Handler(token),ReadHeaderTimeout:3*time.Second,ReadTimeout:10*time.Second,WriteTimeout:10*time.Second,IdleTimeout:15*time.Second,MaxHeaderBytes:16<<10}
 return server,listener,nil
}
