// 本文件生成三个小型ICO状态图标，图标仅写到显式home/tmp，不调用库的系统临时图标接口。
package tray

import (
 "bytes"
 "encoding/binary"
 "fmt"
 "image"
 "image/color"
 "image/png"
 "os"
 "path/filepath"

 "jmbots-shell/internal/storage"
)

// Icon 编码指定颜色的32像素ICO，内嵌PNG；纯函数，不触发Windows图形API。
func Icon(name string)([]byte,error) {
 colors:=map[string]color.RGBA{"green":{40,180,90,255},"yellow":{235,175,35,255},"red":{225,65,65,255}}
 fill,ok:=colors[name];if !ok{return nil,fmt.Errorf("未知图标颜色")}
 img:=image.NewNRGBA(image.Rect(0,0,32,32))
 for y:=0;y<32;y++{for x:=0;x<32;x++{dx,dy:=x-16,y-16;if dx*dx+dy*dy<=14*14{img.Set(x,y,fill)}}}
 var payload bytes.Buffer;if err:=png.Encode(&payload,img);err!=nil{return nil,err}
 result:=make([]byte,22+payload.Len())
 binary.LittleEndian.PutUint16(result[2:4],1);binary.LittleEndian.PutUint16(result[4:6],1)
 result[6]=32;result[7]=32;binary.LittleEndian.PutUint16(result[10:12],1);binary.LittleEndian.PutUint16(result[12:14],32)
 binary.LittleEndian.PutUint32(result[14:18],uint32(payload.Len()));binary.LittleEndian.PutUint32(result[18:22],22);copy(result[22:],payload.Bytes())
 return result,nil
}

// PrepareIcons 在调用方指定的home/tmp写三个ICO，返回绝对路径，不用os.TempDir。
func PrepareIcons(home string)(map[string]string,error) {
 if !filepath.IsAbs(home){return nil,fmt.Errorf("图标目录必须由绝对home决定")}
 dir:=filepath.Join(home,"tmp");if err:=os.MkdirAll(dir,0700);err!=nil{return nil,err}
 result:=make(map[string]string)
 for _,name:=range []string{"green","yellow","red"}{data,err:=Icon(name);if err!=nil{return nil,err};path:=filepath.Join(dir,"tray_"+name+".ico");if err=storage.AtomicWrite(path,data,0600);err!=nil{return nil,err};result[name]=path}
 return result,nil
}
