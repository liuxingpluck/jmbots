// 本文件负责独立壳子配置的读取与校验，不读取被守护程序的任何配置。
package shell

import (
 "bytes"
 "encoding/json"
 "fmt"
 "io"
 "net"
 "net/url"
 "os"
 "path/filepath"
 "strings"
)

// Ports 是三个互不重叠的监听端口。
type Ports struct {
 Control int `json:"control"` // 控制口固定监听回环地址。
 Official int `json:"official"` // 被守护服务的正式端口。
 Candidate int `json:"candidate"` // 候选试运行端口。
}

// Command 以可执行文件及参数数组描述检查，不通过命令解释器拼接。
type Command struct {
 Exe string `json:"exe"` // 可执行文件绝对路径，拒绝隐式 cmd/bat 解释。
 Args []string `json:"args,omitempty"` // 原样传给可执行文件的参数。
 Dir string `json:"dir"` // 显式工作目录。
 TimeoutSeconds int `json:"timeout_seconds"` // 每条命令的有界超时。
}

// Config 是 shell.json 的公开格式；Home 来自命令行，不由文件覆盖。
type Config struct {
 RuntimeDir string `json:"runtime_dir"` // 子进程的 JMBOTS_RUNTIME，不在此处读取其内容。
 Ports Ports `json:"ports"` // 三个端口。
 Host string `json:"host"` // 正式服务绑定的 IP。
 HealthPath string `json:"health_path"` // 只允许站内绝对路径。
 BuildCmd *Command `json:"build_cmd,omitempty"` // 输出末行须为发布目录的绝对路径。
 GateCmds []Command `json:"gate_cmds"` // 候选启动前的检查。
 SmokeCmds []Command `json:"smoke_cmds"` // 候选健康后的冒烟检查。
 NotifyDirs []string `json:"notify_dirs"` // 故障通知文件的目标目录。
 ReportURL string `json:"report_url"` // 可选的 /api/run 地址。
 Home string `json:"-"` // 此实例的状态、发布和日志目录。
}

// ResolveHome 根据显式 home、runtime 或环境返回绝对路径；不创建、不读取运行时。
func ResolveHome(home, runtimeDir string) (string,error) {
 if home != "" { return filepath.Abs(home) }
 if runtimeDir == "" { runtimeDir = os.Getenv("JMBOTS_RUNTIME") }
 if runtimeDir == "" { runtimeDir = "F:/aidata/AIJMBots" }
 return filepath.Abs(filepath.Join(runtimeDir,"shell"))
}

// Defaults 返回默认值而不产生文件或网络副作用。
func Defaults(home string) Config {
 return Config{Home:home,RuntimeDir:filepath.Dir(home), Ports:Ports{30085,30086,30087}, Host:"127.0.0.1", HealthPath:"/api/health", GateCmds:[]Command{}, SmokeCmds:[]Command{}, NotifyDirs:[]string{}}
}

// LoadConfig 只读取 home/shell.json；错误时不自动创建默认配置、不启动服务。
func LoadConfig(home string) (Config,error) {
 absolute,err:=filepath.Abs(home); if err!=nil { return Config{},err }
 c:=Defaults(absolute)
 f,err:=os.Open(filepath.Join(absolute,"shell.json")); if err!=nil { return c,err }; defer f.Close()
 data,err:=io.ReadAll(io.LimitReader(f,(1<<20)+1));if err!=nil{return c,err}
 if len(data)>1<<20||len(bytes.TrimSpace(data))==0||bytes.TrimSpace(data)[0]!='{'{return c,fmt.Errorf("配置必须为有界JSON对象")}
 var fields map[string]json.RawMessage;if err=json.Unmarshal(data,&fields);err!=nil{return c,err}
 if value,ok:=fields["runtime_dir"];!ok||bytes.Equal(bytes.TrimSpace(value),[]byte("null")){return c,fmt.Errorf("配置必须显式提供 runtime_dir")}
 decoder:=json.NewDecoder(bytes.NewReader(data)); decoder.DisallowUnknownFields()
 if err=decoder.Decode(&c); err!=nil { return c,fmt.Errorf("壳子配置无效：%w",err) }
 if err=decoder.Decode(new(any)); err!=io.EOF { return c,fmt.Errorf("配置必须只有一个 JSON 对象") }
 return c,c.Validate()
}

// Validate 校验配置中的路径、端口和命令；不执行命令、不探测服务。
func (c Config) Validate() error {
 if !filepath.IsAbs(c.Home)||!filepath.IsAbs(c.RuntimeDir) { return fmt.Errorf("home 与 runtime_dir 必须为绝对路径") }
 used:=map[int]bool{}
 for _,p:=range []int{c.Ports.Control,c.Ports.Official,c.Ports.Candidate} {
  if p<1||p>65535||used[p] { return fmt.Errorf("端口必须有效且互不重复") }; used[p]=true
 }
 if net.ParseIP(c.Host)==nil { return fmt.Errorf("host 必须为 IP 地址，不解析外部域名") }
 u,err:=url.Parse(c.HealthPath)
 if err!=nil||u.IsAbs()||u.Host!=""||!strings.HasPrefix(c.HealthPath,"/")||strings.HasPrefix(c.HealthPath,"//") { return fmt.Errorf("health_path 必须为站内路径") }
 for _,dir:=range c.NotifyDirs { if !filepath.IsAbs(dir) { return fmt.Errorf("notify_dirs 必须为绝对路径") } }
 if c.ReportURL!="" {
  u,err=url.Parse(c.ReportURL)
  if err!=nil||(u.Scheme!="http"&&u.Scheme!="https")||u.Host==""||u.User!=nil||u.Path!="/api/run" { return fmt.Errorf("report_url 必须是不含凭据的 HTTP(S) /api/run 地址") }
 }
 commands:=append(append([]Command{},c.GateCmds...),c.SmokeCmds...)
 if c.BuildCmd!=nil { commands=append(commands,*c.BuildCmd) }
 for _,cmd:=range commands {
  if !filepath.IsAbs(cmd.Exe)||!filepath.IsAbs(cmd.Dir)||cmd.TimeoutSeconds<1||cmd.TimeoutSeconds>3600 { return fmt.Errorf("命令需要绝对 exe/dir 与 1–3600 秒超时") }
  ext:=strings.ToLower(filepath.Ext(cmd.Exe)); if ext==".cmd"||ext==".bat" { return fmt.Errorf("请配置实际 exe，而非 cmd/bat 包装器") }
 }
 return nil
}
