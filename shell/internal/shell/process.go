// 本文件把进程原语接到健康检查和守护状态机，所有停止都基于本实例持有的 Job。
package shell

import (
 "context"
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

func (m *Manager) health(port int)bool {
 ctx,cancel:=context.WithTimeout(m.ctx,m.timing.Health);defer cancel()
 host:="127.0.0.1"
 if port==m.Config.Ports.Official{host=m.Config.Host;ip:=net.ParseIP(host);if ip.IsUnspecified(){if ip.To4()!=nil{host="127.0.0.1"}else{host="::1"}}}
 req,err:=http.NewRequestWithContext(ctx,http.MethodGet,"http://"+net.JoinHostPort(host,strconv.Itoa(port))+m.Config.HealthPath,nil); if err!=nil { return false }
 res,err:=m.client.Do(req);if err!=nil { return false };defer res.Body.Close()
 if res.StatusCode!=http.StatusOK { return false }
 var body struct{OK bool `json:"ok"`}
 return json.NewDecoder(io.LimitReader(res.Body,65536)).Decode(&body)==nil&&body.OK
}

func (m *Manager) healthyOwned(p *winproc.Process,port int)(bool,error) {
 if p==nil { return false,nil }
 if !m.health(port) { return false,nil }
 owned,err:=p.OwnsListener(port); if err!=nil { return false,err }
 if !owned { return false,fmt.Errorf("健康服务监听 PID 不属于本 Job，拒绝信任") }
 return true,nil
}

func (m *Manager) waitHealthy(p *winproc.Process,port int)error {
 until:=time.Now().Add(m.timing.Startup)
 for time.Now().Before(until) {
  ok,err:=m.healthyOwned(p,port);if err!=nil { return err };if ok { return nil }
  alive,err:=p.Alive(); if err!=nil { return err };if !alive { return fmt.Errorf("服务在健康前退出") }
  if err=delay(m.ctx,m.timing.Poll);err!=nil { return err }
 }
 return fmt.Errorf("等待端口 %d 健康超时",port)
}

func delay(ctx context.Context,d time.Duration)error { timer:=time.NewTimer(d);defer timer.Stop();select{case<-ctx.Done():return ctx.Err();case<-timer.C:return nil} }

func childEnv(runtimeDir string)[]string {
 //M 继承当前进程环境，定点覆盖运行时；同名大小写去重，避免 Windows 环境歧义。
 vars:=make(map[string]string)
 for _,pair:=range os.Environ() { key,_,ok:=strings.Cut(pair,"=");if ok&&key!="" { vars[strings.ToUpper(key)]=pair } }
 vars["JMBOTS_RUNTIME"]="JMBOTS_RUNTIME="+runtimeDir
 result:=make([]string,0,len(vars));for _,v:=range vars {result=append(result,v)};return result
}

func (m *Manager) startRelease(release Release,port int,candidate bool)(*winproc.Process,error) {
 listeners,err:=winproc.Listeners(port);if err!=nil { return nil,err };if len(listeners)>0 { return nil,fmt.Errorf("端口 %d 已被占用；不启动、不杀占用者",port) }
 //M 每次启动前再核对冻结副本，防止失败恢复期间磁盘内容发生漂移。
 checked,err:=frozenRelease(m.Config.Home,release.Manifest.ID);if err!=nil { return nil,err }
 logPath:=filepath.Join(m.Config.Home,"logs",fmt.Sprintf("serve_%d_%s.log",port,uniqueID()))
 file,err:=logging.OpenChild(logPath);if err!=nil { return nil,err };defer file.Close()
 host:=m.Config.Host;if candidate {host="127.0.0.1"}
 args:=[]string{"serve","--port",strconv.Itoa(port),"--host",host}
 if candidate {args=append(args,"--mode","candidate")}
 p,err:=winproc.Start(winproc.Options{Exe:filepath.Join(checked.Dir,"jmbots.exe"),Args:args,Dir:checked.Dir,Env:childEnv(m.Config.RuntimeDir),Stdout:file,Stderr:file})
 if err!=nil { return nil,err }
 id:=p.Identity()
 err=m.mutate(func(s *State){if candidate{s.Candidate=&id}else{s.Official=&id}})
 if err!=nil {
  if candidate{return p,err}
  //G 正式进程已启动且句柄归属明确；磁盘故障不能成为停止可用服务的理由。
  // 后续仍必须验证健康，最终状态保存失败会向操作返回错误并保持该服务。
  m.log("正式身份持久化失败，保留已持有Job以继续健康核验："+err.Error())
 }
 m.log(fmt.Sprintf("启动 %d：PID=%d 创建时间=%d 路径=%s",port,id.PID,id.Created,id.Path))
 return p,nil
}

func (m *Manager) stop(p *winproc.Process,port int)error {
 if p==nil { return nil }
 //G Stop 自己核验根句柄、路径、创建时间和 Job；此处不会用端口选择待杀进程。
 if err:=p.Stop(m.timing.Stop);err!=nil { return err }
 until:=time.Now().Add(m.timing.Stop)
 for time.Now().Before(until) {
  listeners,err:=winproc.Listeners(port);if err!=nil{return err};if len(listeners)==0 {return p.Close()}
  time.Sleep(m.timing.Poll)
 }
 return fmt.Errorf("本 Job 已停止但端口 %d 未释放，不终止陌生占用者",port)
}

func (m *Manager) canManage()error {
 if m.Snapshot().Mode=="observer" {return ErrObserver}
 listeners,err:=winproc.Listeners(m.Config.Ports.Official);if err!=nil{return err}
 if len(listeners)==0{return nil}
 if m.official!=nil {owned,e:=m.official.OwnsListener(m.Config.Ports.Official);if e!=nil{return e};if owned{return nil}}
 if e:=m.mutate(func(s *State){s.Mode="observer";s.LastError="正式端口出现陌生监听者"});e!=nil{return e}
 return ErrObserver
}

// Tick 执行一轮守护；now 可注入，仅控制稳定期及冷却期，不绕过实际健康与归属检查。
func (m *Manager) Tick(now time.Time)error {
 started:=time.Now();observedNow:=func()time.Time{return now.Add(time.Since(started))}
 lock,err:=m.lockAction();if err!=nil{return err};defer m.unlockAction(lock)
 if m.ctx.Err()!=nil{return m.ctx.Err()}
 remaining:=m.pendingJobs[:0]
 for _,p:=range m.pendingJobs{if e:=p.Stop(m.timing.Stop);e!=nil{remaining=append(remaining,p);m.log("检查Job仍未停止："+e.Error())}else{p.Close()}}
 m.pendingJobs=remaining
 m.rotateChildren()
 s:=m.Snapshot()
 if s.Mode=="observer" {m.log(fmt.Sprintf("旁观：正式健康=%t，不改变进程",m.health(m.Config.Ports.Official)));return nil}
 if s.Mode=="error" {return fmt.Errorf("状态持久化错误，等待人工处理")}
 if !s.QuietUntil.IsZero()&&now.Before(s.QuietUntil){return nil}
 if err=m.canManage();err!=nil{return err}
 if s.Current==""&&m.official==nil{return nil}
 healthy,err:=m.healthyOwned(m.official,m.Config.Ports.Official);if err!=nil{return err}
 if healthy {
  return m.mutate(func(s *State){s.Mode="managed";s.Failures=0;s.QuietUntil=time.Time{};s.LastError="";if s.HealthySince.IsZero(){s.HealthySince=observedNow()};if observedNow().Sub(s.HealthySince)>=m.timing.Stable{s.LastGood=s.Current}})
 }
 if err=delay(m.ctx,m.timing.Recheck);err!=nil{return err}
 healthy,err=m.healthyOwned(m.official,m.Config.Ports.Official);if err!=nil{return err};if healthy{return nil}
 if s.Current=="" {return nil}
 if err=m.mutate(func(s *State){s.HealthySince=time.Time{}});err!=nil{return err}
 if m.official!=nil {if err=m.stop(m.official,m.Config.Ports.Official);err!=nil{return err};m.official=nil}
 release,err:=frozenRelease(m.Config.Home,s.Current)
 if err==nil {m.official,err=m.startRelease(release,m.Config.Ports.Official,false)}
 if err==nil {err=m.waitHealthy(m.official,m.Config.Ports.Official)}
 if err==nil {return m.mutate(func(s *State){s.Mode="managed";s.Failures=0;s.QuietUntil=time.Time{};s.HealthySince=observedNow();s.LastError=""})}
 if m.official!=nil {stopErr:=m.stop(m.official,m.Config.Ports.Official);if stopErr!=nil{return errors.Join(err,stopErr)};m.official=nil}
 failure:=err
 if err=m.mutate(func(s *State){s.Failures++;s.Official=nil;s.LastError=failure.Error()});err!=nil{return err}
 if m.Snapshot().Failures<3{return failure}
 m.notify("连续启动失败",fmt.Sprintf("当前版本 %s 连续三次起不来，尝试已知健康版本 %s。",s.Current,s.LastGood))
 if s.LastGood!=""&&s.LastGood!=s.Current {
  rollback,e:=frozenRelease(m.Config.Home,s.LastGood)
  if e==nil {m.official,e=m.startRelease(rollback,m.Config.Ports.Official,false)}
  if e==nil {e=m.waitHealthy(m.official,m.Config.Ports.Official)}
  if e==nil {m.notify("已自动回退",s.LastGood);return m.mutate(func(s *State){s.Previous=s.Current;s.Current=s.LastGood;s.Mode="managed";s.Failures=0;s.HealthySince=observedNow();s.QuietUntil=time.Time{};s.LastError=""})}
  failure=errors.Join(failure,e)
  if m.official!=nil {stopErr:=m.stop(m.official,m.Config.Ports.Official);if stopErr!=nil{return errors.Join(failure,stopErr)};m.official=nil}
 }
 m.notify("看门狗停手", "当前与已知健康版本均不可用，停手十分钟；原始错误："+failure.Error())
 return m.mutate(func(s *State){s.Mode="quiet";s.Official=nil;s.QuietUntil=observedNow().Add(m.timing.Quiet);s.Failures=0;s.LastError=failure.Error()})
}

func (m *Manager) rotateChildren() {
 matches,_:=filepath.Glob(filepath.Join(m.Config.Home,"logs","serve_*.log"))
 for _,path:=range matches {if err:=logging.RotateChild(path,5<<20,5);err!=nil{m.log("子日志轮转失败："+err.Error())}}
}
