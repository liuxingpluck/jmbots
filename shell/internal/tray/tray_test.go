// 托盘测试只运行纯图标/状态模型与替身动作，不启动GUI、不打开浏览器或日志目录。
package tray

import (
 "bytes"
 "encoding/binary"
 "image/png"
 "os"
 "path/filepath"
 "strings"
 "testing"

 core "jmbots-shell/internal/shell"
 "jmbots-shell/internal/winproc"
)

func TestTrayStatesColorsAndMenuAvailability(t *testing.T) {
 id:=&winproc.Identity{PID:123,Created:456,Path:`F:\fake\jmbots.exe`}
 cases:=[]struct{state core.State;color string;can bool}{{core.State{Mode:"idle"},"yellow",true},{core.State{Mode:"managed",Official:id,Current:"v1"},"green",true},{core.State{Mode:"managed",Official:id,Candidate:id},"yellow",true},{core.State{Mode:"observer"},"yellow",false},{core.State{Mode:"quiet"},"red",true},{core.State{Mode:"error"},"red",false},{core.State{Mode:"managed",Official:id,Failures:1},"red",true}}
 for _,item:=range cases{view:=Describe(item.state);if view.Color!=item.color||view.CanChange!=item.can{t.Fatalf("状态映射不符：%+v",view)};if !strings.Contains(view.Title,"正式：")||!strings.Contains(view.Title,"候选：")||!strings.Contains(view.Title,"版本："){t.Fatal(view.Title)}}
}

func TestTrayActionsUseFakesOnlyAndExitNeverStops(t *testing.T) {
 config:=core.Defaults(`F:\aidata\cache\jmshell_exp\tray-unit`);config.Ports.Official=30092
 var calls []string
 actions:=Actions{Begin:func(kind string)error{calls=append(calls,"begin:"+kind);return nil},Open:func(target string)error{calls=append(calls,"fake-open:"+target);return nil},Exit:func(){calls=append(calls,"exit-only")}}
 for _,action:=range []string{"open","restart","rollback","logs","exit"}{if err:=Dispatch(action,config,actions);err!=nil{t.Fatal(err)}}
 if len(calls)!=5||calls[0]!="fake-open:http://127.0.0.1:30092"||calls[1]!="begin:restart"||calls[2]!="begin:rollback"||calls[4]!="exit-only"{t.Fatal(calls)}
 if err:=Dispatch("stop-service",config,actions);err==nil{t.Fatal("不存在的托盘停止命令被接受")}
 t.Log("所有菜单动作仅调用替身；未执行ShellExecute，不打开浏览器或界面；退出只取消壳子")
}

func TestIconsAreWrittenUnderExplicitHomeOnly(t *testing.T) {
 root:=os.Getenv("JMSHELL_TEST_ROOT");if !strings.HasPrefix(strings.ToLower(filepath.ToSlash(root)),"f:/aidata/cache/jmshell_exp/"){t.Fatal("必须在F盘实验目录验证")}
 home,err:=os.MkdirTemp(root,"tray-icons-");if err!=nil{t.Fatal(err)}
 icons,err:=PrepareIcons(home);if err!=nil{t.Fatal(err)}
 for name,path:=range icons {
  if filepath.Dir(path)!=filepath.Join(home,"tmp"){t.Fatal("图标写出home/tmp")}
  b,err:=os.ReadFile(path);if err!=nil{t.Fatal(err)}
  if len(b)<22||binary.LittleEndian.Uint16(b[2:4])!=1||binary.LittleEndian.Uint32(b[18:22])!=22{t.Fatal("ICO结构错误")}
  img,err:=png.Decode(bytes.NewReader(b[22:]));if err!=nil{t.Fatal(err)}
  r,g,blue,_:=img.At(16,16).RGBA();if name=="green"&&g<=r||name=="red"&&r<=g||name=="yellow"&&blue>=g{t.Fatal("颜色不符",name)}
  t.Logf("%s图标路径=%s 字节=%d；只解析图片，不启动Windows托盘",name,path,len(b))
 }
}
