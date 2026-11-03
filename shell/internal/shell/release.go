// 本文件负责发布物完整性校验与冻结，只复制清单和单一二进制，不读取运行时配置。
package shell

import (
 "crypto/rand"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "io"
 "os"
 "path/filepath"
 "regexp"
 "strings"
 "time"

 "jmbots-shell/internal/storage"
)

// Manifest 描述单文件发布包的来源与完整性，哈希不等同于发布者签名。
type Manifest struct {
 ID string `json:"id"` // 作为冻结目录名的安全版本标识。
 BuiltAt string `json:"builtAt"` // 发布工具记录的构建时间。
 GitCommit string `json:"gitCommit"` // 来源提交，可为空但必须显式提供字段。
 Dirty bool `json:"dirty"` // 构建时是否含未提交源码。
 SHA256 string `json:"sha256"` // 二进制的十六进制 SHA-256。
 Size int64 `json:"size"` // 二进制字节数。
}

// Release 是已经校验的发布包；Dir 仅指冻结副本。
type Release struct {
 Manifest Manifest `json:"manifest"` // 已核对的清单。
 Dir string `json:"dir"` // 冻结目录。
}

var safeID=regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func validID(id string) bool {
 if !safeID.MatchString(id) { return false }
 name:=strings.ToUpper(id)
 for _,reserved:=range []string{"CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"} { if name==reserved { return false } }
 return true
}

func uniqueID() string {
 var b [12]byte
 if _,err:=rand.Read(b[:]);err!=nil { panic("操作标识随机源不可用") }
 return time.Now().UTC().Format("20060102T150405.000000000")+"_"+hex.EncodeToString(b[:])
}

// checkPlainPath 拒绝路径中任何符号链接或重解析跳转，避免越界读写。
func checkPlainPath(path string) error {
 absolute,err:=filepath.Abs(path); if err!=nil { return err }
 resolved,err:=filepath.EvalSymlinks(absolute); if err!=nil { return err }
 if !strings.EqualFold(filepath.Clean(absolute),filepath.Clean(resolved)) { return fmt.Errorf("拒绝重解析路径：%s",path) }
 info,err:=os.Lstat(absolute); if err!=nil { return err }
 if info.Mode()&os.ModeSymlink!=0 { return fmt.Errorf("拒绝链接路径") }
 return nil
}

func readManifest(dir string) (Manifest,error) {
 var m Manifest
 path:=filepath.Join(dir,"manifest.json")
 if err:=checkPlainPath(path);err!=nil { return m,err }
 f,err:=os.Open(path); if err!=nil { return m,err }; defer f.Close()
 b,err:=io.ReadAll(io.LimitReader(f,65537)); if err!=nil||len(b)>65536 { return m,fmt.Errorf("清单过大或不可读") }
 var fields map[string]json.RawMessage
 if err=json.Unmarshal(b,&fields);err!=nil { return m,err }
 for _,field:=range []string{"id","builtAt","gitCommit","dirty","sha256","size"} { if _,ok:=fields[field];!ok { return m,fmt.Errorf("清单缺字段 %s",field) } }
 if err=json.Unmarshal(b,&m);err!=nil { return m,err }
 if !validID(m.ID)||m.Size<=0||len(m.SHA256)!=64 { return m,fmt.Errorf("清单版本、大小或哈希无效") }
 if _,err=hex.DecodeString(m.SHA256);err!=nil { return m,err }
 if _,err=time.Parse(time.RFC3339,m.BuiltAt);err!=nil { return m,fmt.Errorf("builtAt 必须为 RFC3339 时间") }
 return m,nil
}

func verifyBinary(path string,m Manifest) error {
 if err:=checkPlainPath(path);err!=nil { return err }
 f,err:=os.Open(path); if err!=nil { return err }; defer f.Close()
 stat,err:=f.Stat(); if err!=nil||!stat.Mode().IsRegular()||stat.Size()!=m.Size { return fmt.Errorf("二进制大小或类型不符") }
 digest:=sha256.New(); size,err:=io.Copy(digest,f); if err!=nil { return err }
 if size!=m.Size||!strings.EqualFold(hex.EncodeToString(digest.Sum(nil)),m.SHA256) { return fmt.Errorf("二进制 SHA-256 不符") }
 return nil
}

// VerifyRelease 验证发布目录内的两份固定文件；不启动发布程序。
func VerifyRelease(dir string) (Release,error) {
 absolute,err:=filepath.Abs(dir); if err!=nil { return Release{},err }
 if err=checkPlainPath(absolute);err!=nil { return Release{},err }
 m,err:=readManifest(absolute); if err!=nil { return Release{},err }
 if err=verifyBinary(filepath.Join(absolute,"jmbots.exe"),m);err!=nil { return Release{},err }
 return Release{Manifest:m,Dir:absolute},nil
}

// FreezeRelease 将校验后的单文件包复制到 home/releases/id；同 ID 不允许替换成别的内容。
func FreezeRelease(home,source string) (Release,error) {
 release,err:=VerifyRelease(source); if err!=nil { return Release{},err }
 root:=filepath.Join(home,"releases")
 if err=os.MkdirAll(root,0700);err!=nil { return Release{},err }
 if err=checkPlainPath(root);err!=nil { return Release{},err }
 dest:=filepath.Join(root,release.Manifest.ID)
 if _,err=os.Lstat(dest);err==nil {
  existing,e:=VerifyRelease(dest)
  if e!=nil||existing.Manifest!=release.Manifest { return Release{},fmt.Errorf("冻结版本同名冲突，拒绝覆盖") }
  return existing,nil
 } else if !os.IsNotExist(err) { return Release{},err }
 temp,err:=os.MkdirTemp(root,".freeze-"); if err!=nil { return Release{},err }
 //G 不删失败的实验/发布副本，保留供排障；未改名的临时目录不会被当作版本。
 in,err:=os.Open(filepath.Join(release.Dir,"jmbots.exe")); if err!=nil { return Release{},err }; defer in.Close()
 out,err:=os.OpenFile(filepath.Join(temp,"jmbots.exe"),os.O_CREATE|os.O_EXCL|os.O_WRONLY,0700); if err!=nil { return Release{},err }
 _,copyErr:=io.Copy(out,in); if copyErr==nil { copyErr=out.Sync() }; closeErr:=out.Close()
 if copyErr!=nil { return Release{},copyErr }; if closeErr!=nil { return Release{},closeErr }
 if err=verifyBinary(filepath.Join(temp,"jmbots.exe"),release.Manifest);err!=nil { return Release{},err }
 if err=storage.AtomicWrite(filepath.Join(temp,"manifest.json"),mustJSON(release.Manifest),0600);err!=nil { return Release{},err }
 for attempt:=0;attempt<20;attempt++ { err=os.Rename(temp,dest); if err==nil { break }; time.Sleep(25*time.Millisecond) }
 if err!=nil { return Release{},err }
 return VerifyRelease(dest)
}

func mustJSON(value any) []byte { b,err:=json.MarshalIndent(value,"","  "); if err!=nil { panic(err) }; return append(b,'\n') }

func frozenRelease(home,id string)(Release,error) {
 if !validID(id) { return Release{},fmt.Errorf("冻结版本标识无效") }
 release,err:=VerifyRelease(filepath.Join(home,"releases",id))
 if err==nil&&release.Manifest.ID!=id { err=fmt.Errorf("冻结目录与清单 ID 不一致") }
 return release,err
}
