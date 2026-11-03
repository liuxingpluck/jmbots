# jmshell：Windows 独立守护壳子

M1 已具备独立配置、冻结发布物、候选验证、失败回退、Job监督、认证控制口和控制台客户端；M2已实现托盘和自启适配，零CGO构建及纯逻辑测试通过。没有实际安装自启或进行托盘视觉验收。不导入jmbots源码，不读取其配置。目标Windows/amd64，模块 `jmbots-shell`，Go语言版本1.24。

完整配置、状态机、接口、风险与逐项证据见[壳子实现说明](<../docs/Go壳子/04_壳子实现说明.md>)。

## 开发验证边界

- 不接触现网30085/30086/30087或真实运行时。默认配置仅作产品默认值；本次实验只能用30091–30097。
- 构建、测试、缓存和临时文件全在 `F:/aidata/cache/jmshell_exp/`，不在仓库运行写文件或起服务命令。
- 编译前将本目录源码复制到实验副本，设置进程级Go缓存/TEMP，使用 `D:/dev/go1.27.0.windows-amd64/bin/go.exe`。
- 不读取、打印或复制业务配置、环境密钥或令牌文件。客户端只在内部消费控制凭据，不提供显示令牌命令。
- 界面查看、测试和截图只能通过AOBB；不得自行启动浏览器或触发托盘的浏览器打开动作。
- 不安装自启、不改注册表和系统设置，不提交Git。

## 已保存的可复现脚本

[隔离环境](<F:/aidata/cache/jmshell_exp/shell-env.sh>)、[复制源码](<F:/aidata/cache/jmshell_exp/prepare-shell.sh>)、[构建与验证](<F:/aidata/cache/jmshell_exp/verify-shell.sh>)。

从实验目录依次执行：

```bash
bash F:/aidata/cache/jmshell_exp/prepare-shell.sh
bash F:/aidata/cache/jmshell_exp/verify-shell.sh build
bash F:/aidata/cache/jmshell_exp/verify-shell.sh tests
bash F:/aidata/cache/jmshell_exp/verify-shell.sh vet
bash F:/aidata/cache/jmshell_exp/verify-shell.sh e2e
```

假后端只接受实验端口，支持normal/delayed/crash/crash-later/candidate-crash/official-crash，并可模拟占口、忽略软终止和派生后代。演示自动生成实验配置和发布清单，使用真实shell/ctl二进制部署并自行清理，不需要验收人补跑服务。

## 操作入口

```text
jmshell.exe --home <独立壳子目录> --headless
jmshellctl.exe --home <独立壳子目录> status
jmshellctl.exe --home <独立壳子目录> --release-dir <发布目录> --wait deploy
jmshellctl.exe --home <独立壳子目录> --wait rollback
jmshellctl.exe --home <独立壳子目录> --wait restart
jmshellctl.exe --home <独立壳子目录> --confirm --wait adopt
jmshellctl.exe --home <独立壳子目录> ops <操作ID>
jmshellctl.exe --home <独立壳子目录> logs
```

有旗标必须放在子命令之前。换版本有短暂中断，不是零停机；退出壳子不停止服务；重启壳子对已有监听者只旁观。实际生产部署需用户另外决定，不属于本次实验执行。
