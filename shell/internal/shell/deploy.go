// 本文件编排冻结版本、检查、候选、正式切换与回退；换版存在数秒中断，不是零停机。
package shell

import (
 "bytes"
 "context"
 "encoding/json"
 "errors"
 "fmt"
 "net/http"
 "os"
 "path/filepath"
 "strings"
 "time"

 "jmbots-shell/internal/logging"
 "jmbots-shell/internal/winproc"
)

type progress func(stage,text string)

func (m *Manager) execute(kind string,req Request,log progress)error {
 if kind=="adopt" {return m.adopt(log)}
 if err:=m.canManage();err!=nil{return err}
 switch kind {
 case "deploy":
  source:=req.ReleaseDir
  if m.Config.BuildCmd!=nil {
   log("build","运行配置的构建命令")
   output,err:=m.runCommand(*m.Config.BuildCmd,"build",log);if err!=nil{return err}
   lines:=strings.Split(strings.TrimSpace(output),"\n");source=strings.TrimSpace(lines[len(lines)-1])
  }
  if !filepath.IsAbs(source){return fmt.Errorf("必须提供绝对 release_dir；构建命令输出末行也必须是绝对目录")}
  release,err:=FreezeRelease(m.Config.Home,source);if err!=nil{return err}
  log("frozen","冻结并校验版本 "+release.Manifest.ID)
  for _,cmd:=range m.Config.GateCmds {if _,err=m.runCommand(cmd,"gate",log);err!=nil{return err}}
  return m.switchRelease(release,log)
 case "rollback":
  previous:=m.Snapshot().Previous;if previous==""{return fmt.Errorf("没有上一版本")}
  release,err:=frozenRelease(m.Config.Home,previous);if err!=nil{return err}
  return m.switchRelease(release,log)
 case "restart":
  current:=m.Snapshot().Current;if current==""{return fmt.Errorf("没有当前版本")}
  release,err:=frozenRelease(m.Config.Home,current);if err!=nil{return err}
  return m.switchRelease(release,log)
 }
 return fmt.Errorf("未知操作")
}

func (m *Manager) switchRelease(release Release,log progress)(result error) {
 old:=m.Snapshot().Current
 if pending:=m.Snapshot().Candidate;pending!=nil&&m.candidate==nil{if err:=winproc.Validate(*pending);err==nil{return fmt.Errorf("上一实例候选仍存在：PID=%d 创建时间=%d 路径=%s；未自动接管，请按完整身份人工处理",pending.PID,pending.Created,pending.Path)}}
 log("candidate","在候选端口启动冻结发布物")
 p,err:=m.startRelease(release,m.Config.Ports.Candidate,true);m.candidate=p
 //M 任何失败都收尾自己的候选 Job；无法释放端口必须把错误传给操作结果。
 defer func(){
  if m.candidate!=nil {
   stopErr:=m.stop(m.candidate,m.Config.Ports.Candidate)
   if stopErr==nil {m.candidate=nil;stopErr=m.mutate(func(s *State){s.Candidate=nil})}
   result=errors.Join(result,stopErr)
  }
 }()
 if err!=nil{return err}
 if err=m.waitHealthy(p,m.Config.Ports.Candidate);err!=nil{return fmt.Errorf("候选失败，旧版未动：%w",err)}
 for _,cmd:=range m.Config.SmokeCmds {if _,err=m.runCommand(cmd,"smoke",log);err!=nil{return fmt.Errorf("冒烟失败，旧版未动：%w",err)}}
 //G 冒烟检查可能耗时；切正式前重新确认候选仍健康且归属一致。
 if ok,e:=m.healthyOwned(m.candidate,m.Config.Ports.Candidate);e!=nil||!ok{return errors.Join(fmt.Errorf("候选在检查后不再健康，旧版未动"),e)}
 //G 再次核验正式归属，避免候选检查期间出现陌生监听者。
 if err=m.canManage();err!=nil{return err}
 log("stop-official","候选通过；停止本实例正式 Job，接下来有短暂中断")
 if m.official!=nil {if err=m.stop(m.official,m.Config.Ports.Official);err!=nil{return err};m.official=nil}
 if err=m.mutate(func(s *State){s.Official=nil;s.HealthySince=time.Time{}});err!=nil{return errors.Join(err,m.restoreOld(old,log))}
 log("start-official","用同一个冻结发布包在正式端口启动")
 m.official,err=m.startRelease(release,m.Config.Ports.Official,false)
 if err==nil {err=m.waitHealthy(m.official,m.Config.Ports.Official)}
 if err!=nil {
  failure:=err;log("rollback","新版正式启动失败，立即恢复上一版")
  if m.official!=nil {if stopErr:=m.stop(m.official,m.Config.Ports.Official);stopErr!=nil{return errors.Join(failure,stopErr)};m.official=nil}
  rollbackErr:=m.restoreOld(old,log)
  m.notify("换版失败",fmt.Sprintf("版本 %s 失败：%v；回退结果：%v",release.Manifest.ID,failure,rollbackErr))
  if rollbackErr!=nil {return errors.Join(fmt.Errorf("正式启动失败：%w",failure),fmt.Errorf("回退失败：%w",rollbackErr))}
  return fmt.Errorf("正式启动失败，已恢复上一版：%w",failure)
 }
 if err=m.mutate(func(s *State){if old!=release.Manifest.ID{s.Previous=old};s.Current=release.Manifest.ID;s.Mode="managed";s.Failures=0;s.QuietUntil=time.Time{};s.HealthySince=time.Now();s.LastError=""});err!=nil{return err}
 log("healthy","新版正式健康且监听者属于本 Job；关闭候选")
 return nil
}

func (m *Manager) restoreOld(old string,log progress)error {
 if old=="" {
  return errors.Join(fmt.Errorf("首次部署没有上一版可回退"),m.mutate(func(s *State){s.Official=nil;s.Mode="idle";s.LastError="首次部署失败，无上一版本"}))
 }
 release,err:=frozenRelease(m.Config.Home,old)
 if err==nil {m.official,err=m.startRelease(release,m.Config.Ports.Official,false)}
 if err==nil {err=m.waitHealthy(m.official,m.Config.Ports.Official)}
 if err!=nil {
  if m.official!=nil {stopErr:=m.stop(m.official,m.Config.Ports.Official);err=errors.Join(err,stopErr);if stopErr==nil{m.official=nil}}
  saveErr:=m.mutate(func(s *State){s.Official=nil;s.Mode="quiet";s.QuietUntil=time.Now().Add(m.timing.Quiet);s.LastError=err.Error()})
  return errors.Join(err,saveErr)
 }
 log("rollback-ok","上一版已恢复："+old)
 return m.mutate(func(s *State){s.Current=old;s.Mode="managed";s.Failures=0;s.HealthySince=time.Now();s.LastError=""})
}

func (m *Manager) runCommand(cmd Command,kind string,log progress)(string,error) {
 path:=filepath.Join(m.Config.Home,"logs",kind+"_"+uniqueID()+".log")
 f,err:=logging.OpenChild(path);if err!=nil{return "",err}
 env:=append(childEnv(m.Config.RuntimeDir),fmt.Sprintf("JMSHELL_CANDIDATE_URL=http://127.0.0.1:%d",m.Config.Ports.Candidate))
 p,err:=winproc.Start(winproc.Options{Exe:cmd.Exe,Args:cmd.Args,Dir:cmd.Dir,Env:env,Stdout:f,Stderr:f});f.Close();if err!=nil{return "",err}
 ctx,cancel:=context.WithTimeout(m.ctx,time.Duration(cmd.TimeoutSeconds)*time.Second);defer cancel()
 exit,waitErr:=p.Wait(ctx)
 //M 检查命令即使根退出也收掉自己 Job 内的后台子孙，防止泄漏检查进程。
 stopErr:=p.Stop(m.timing.Stop)
 if stopErr==nil{p.Close()}else{m.pendingJobs=append(m.pendingJobs,p);m.log("检查Job停止失败，保留归属句柄待重试："+stopErr.Error())}
 if err=logging.RotateChild(path,5<<20,5);err!=nil{log(kind,"检查日志轮转失败："+err.Error())}
 tail,readErr:=logging.Tail(path,100)
 if readErr!=nil{return "",errors.Join(readErr,waitErr,stopErr)}
 exitText:=fmt.Sprint(exit);if waitErr!=nil{exitText="未取得（等待失败或超时）"}
 log(kind,fmt.Sprintf("命令退出码=%s；输出结尾：\n%s",exitText,tail))
 if waitErr!=nil||stopErr!=nil||exit!=0{return tail,errors.Join(fmt.Errorf("%s 检查未通过，退出码 %s",kind,exitText),waitErr,stopErr)}
 return tail,nil
}

func (m *Manager) adopt(log progress)error {
 if m.official!=nil{return fmt.Errorf("本实例已经管理正式服务")}
 if !m.health(m.Config.Ports.Official){return fmt.Errorf("只接管健康且明确确认的 jmbots 进程")}
 listeners,err:=winproc.Listeners(m.Config.Ports.Official);if err!=nil{return err}
 if len(listeners)!=1{return fmt.Errorf("接管要求唯一的监听进程")}
 p,err:=winproc.Adopt(listeners[0]);if err!=nil{return err}
 owned,err:=p.OwnsListener(m.Config.Ports.Official)
 if err!=nil||!owned {p.Close();return errors.Join(fmt.Errorf("接管后监听归属不一致；未停止进程"),err)}
 m.official=p;id:=p.Identity()
 //M 尝试把已验证的可执行路径对应到冻结目录；外部 jmbots 不假定其版本可回退。
 version:=""
 if release,e:=VerifyRelease(filepath.Dir(id.Path));e==nil {
  expected:=filepath.Join(m.Config.Home,"releases",release.Manifest.ID,"jmbots.exe")
  if strings.EqualFold(filepath.Clean(expected),filepath.Clean(id.Path)){version=release.Manifest.ID}
 }
 log("adopted",fmt.Sprintf("已确认命令行含 jmbots，接管 PID=%d 创建时间=%d",id.PID,id.Created))
 return m.mutate(func(s *State){s.Official=&id;s.Current=version;s.Mode="managed";s.Failures=0;s.HealthySince=time.Now();s.LastError=""})
}

func (m *Manager) notify(title,body string) {
 data:=[]byte("# "+title+"\n\n"+time.Now().Format(time.RFC3339)+"\n\n"+logging.Redact(body)+"\n")
 for _,dir:=range m.Config.NotifyDirs {
  if err:=os.MkdirAll(dir,0700);err!=nil{m.log("通知目录不可写："+err.Error());continue}
  if err:=checkPlainPath(dir);err!=nil{m.log("拒绝通知链接目录："+err.Error());continue}
  if err:=os.WriteFile(filepath.Join(dir,uniqueID()+".md"),data,0600);err!=nil{m.log("通知写入失败："+err.Error())}
 }
}

func (m *Manager) report(sessionID string,op Operation) {
 if m.Config.ReportURL=="" {return}
 body,_:=json.Marshal(map[string]any{"sessionId":sessionID,"text":"（系统）换版本的结果："+op.Status+" "+op.Error+" 日志："+op.LogPath,"wait":false})
 ctx,cancel:=context.WithTimeout(context.Background(),5*time.Second);defer cancel()
 req,err:=http.NewRequestWithContext(ctx,http.MethodPost,m.Config.ReportURL,bytes.NewReader(body));if err!=nil{m.log("报告请求无效");return};req.Header.Set("Content-Type","application/json")
 res,err:=m.client.Do(req);if err!=nil{m.log("报告失败："+err.Error());return};res.Body.Close()
 if res.StatusCode<200||res.StatusCode>=300{m.log(fmt.Sprintf("报告失败：HTTP %d",res.StatusCode))}
}
