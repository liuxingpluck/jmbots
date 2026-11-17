"""补齐目录迁移后的启动入口和文档；只更新源码、合成测试及当前说明。"""
from pathlib import Path
import re

ROOT = Path('F:/aidata/AIJMBots/jmbotsData/program/jimukefu')


def replace(relative, before, after):
    """在明确的项目内文本中替换已核对的内容。"""
    file = ROOT / relative
    text = file.read_text(encoding='utf-8')
    if before not in text:
        raise ValueError(f'目标内容已变化：{relative}')
    file.write_text(text.replace(before, after), encoding='utf-8')


replace('src/dev/Dev_Server.ts', "path.join(ROOT, 'scripts', 'dev', 'Run_Server.cmd')", "path.join(ROOT, 'src', 'dev', 'Run_Server.cmd')")
replace('src/utils/WebBuild.ts', '<root>/web/dist', '<root>/var/web')
replace('src/services/Paths.ts', '运行时数据（缓存等）统一用 state() 取，目前在 var/data/，以后搬到 var/ 只改这里的默认值。', '账号状态统一用 state() 取，默认落在 var/data/；其他项目内路径用 managed()。')
replace('src/services/Paths.ts', '不填用 data。', '不填用 var/data。')
replace('src/services/Paths.ts', '<根>/data/acc/cache/emoji', '<根>/var/data/acc/cache/emoji')

# 等待真实队尾完成，避免固定 60ms 在 Windows 上偶发早于第二个会话完成。
replace('tests/Web.test.ts', '  await Bun.sleep(60);\n  /** 群里的事件。 */', '  await current.app.history.queue(async () => undefined);\n  /** 群里的事件。 */')

directory_section = '''## 目录

项目根目录按职责保留六个主要目录，完整对照见 [docs/目录结构.md](docs/目录结构.md)。

- `src/`：Cordis 插件、工具、入口；`src/web/` 是 React 前端，`src/prompts/` 是提示词，`src/dev/` 是开发脚本和探针。
- `python/`：`wechat_cli/` 只读引擎、`pyproject.toml` 和 Python 依赖锁文件。
- `tests/`：TypeScript 和 Python 离线测试。
- `docs/`：方案、规则、交接、进度与参考；`docs/备课/` 保留旧实现。
- `third_party/`：`runtimes/` 便携运行时、`sources/` 第三方源码、`licenses/` 许可证、`downloads/` 上游下载归档。
- `var/`：`data/` 账号与消息状态、`cache/` 缓存、`logs/` 日志、`tmp/` 临时文件、`web/` 前端产物、`backups/` 迁移备份。不随客户包分发。

`node_modules/`、`.qoder/` 是依赖与工具元数据。根目录保留 Node 包配置、锁文件、TypeScript 配置、总览、总许可证和启动入口。

'''
readme_file = ROOT / 'README.md'
readme = readme_file.read_text(encoding='utf-8')
readme = re.sub(r'## 目录\n[\s\S]*?(?=## 不能破的规矩)', lambda _: directory_section, readme)
readme = readme.replace('bun node_modules/typescript/bin/tsc -p tsconfig.check.json', 'third_party\\runtimes\\bun\\bun.exe node_modules\\typescript\\bin\\tsc -p tsconfig.check.json')
readme = readme.replace('bun test ./tests', 'third_party\\runtimes\\bun\\bun.exe test ./tests')
readme = readme.replace('不带本机的 `data`、`cache`、`tmp`、`logs`。', '不带本机的 `var/`。')
readme_file.write_text(readme, encoding='utf-8')

planning_file = ROOT / 'docs/微信操控规划.md'
planning = planning_file.read_text(encoding='utf-8')
planning = re.sub(r'## 1\. 目录[\s\S]*?(?=## 2\.)', '## 1. 目录（2026-11-11 迁移后）\n\n当前按 `src / python / tests / docs / third_party / var` 分组，完整目录、旧新路径和启动命令见 [目录结构](目录结构.md)。\n\n', planning)
planning_file.write_text(planning, encoding='utf-8')

doc = r'''# 积木客服目录结构

2026-11-11 已完成根目录迁移。本文件描述当前实际位置；旧交接和进度中的历史路径不作为现行入口。

## 从哪里找代码

```text
jimukefu/
  src/
    Main.ts             Cordis 组装入口
    services/           各关注点的 Cordis 插件
    utils/              共享工具函数
    entries/            单次执行的命令入口
    web/                前端首页和 React 源码
    prompts/            客服提示词及会话覆盖
    dev/                后台服务管理、开发脚本和 ocr 探针
  python/
    wechat_cli/         微信数据库只读引擎
    pyproject.toml      Python 包与依赖声明
    requirements.lock.txt
  tests/                离线测试，全部使用合成数据
  docs/
    参考/               调研记录
    备课/               旧实现及已弃用组件，只读留存
    PROGRESS.md         原根目录的进度记录
  third_party/
    runtimes/           便携 Bun、Python 和 OCR 运行时
    sources/            上游参考源码，保留原许可证
    licenses/           第三方来源与许可证
    downloads/          上游安装包及源文件归档
  var/
    data/               账号清单、账号配置、消息库、草稿、监听配置
    cache/              解密缓存及缓存索引
    logs/               服务日志、任务书与结果
    tmp/                进程临时文件
    web/                生成的 main.js / main.css
    backups/            本次迁移的源码快照和清单
```

根目录额外保留 `package.json`、`bun.lock`、`.npmrc`、`tsconfig*.json`、`.gitignore`、`README.md`、`LICENSE` 和 `启动积木客服.cmd`。`node_modules/` 是现有依赖，`.qoder/` 是工具元数据。未创建没有实际调用者的 `native/` 目录。

网页内部保留原有组件布局，避免本次根目录迁移同时重构组件；因此部分前端路径超过三层。

## 微信列表定位在哪里

- 定位插件：[src/services/WxLocate.ts](../src/services/WxLocate.ts)。
- 点阵工具：[src/utils/DmDict.ts](../src/utils/DmDict.ts)。
- 发送插件：[src/services/Sender.ts](../src/services/Sender.ts)。
- 离线验证：[tests/WxLocate.test.ts](../tests/WxLocate.test.ts)。
- 真机探针：`src/dev/ocr/Probe_*.ts`。
- 单独的 `src/entries/Wx.ts` 命令入口尚未实现，目录迁移不代表定位或发送已真机验收。

`WxLocate` 作为自维护的 Cordis 插件继续放在 `src/services/`，其内部逻辑未因目录迁移重写。插件之间仍经 `ctx` 访问。

## 启动和检查

在项目根目录的 CMD 中执行：

```cmd
third_party\runtimes\bun\bun.exe src\dev\Dev_Server.ts start
third_party\runtimes\bun\bun.exe src\dev\Dev_Server.ts status
```

后台服务仍是 [http://127.0.0.1:30391/](http://127.0.0.1:30391/)，日志为 `var/logs/dev-server.log`。停止和重启将命令末尾换成 `stop` 或 `restart`。根目录 `启动积木客服.cmd` 也已更新路径，前台和后台两种入口不能同时运行。

```cmd
third_party\runtimes\bun\bun.exe node_modules\typescript\bin\tsc -p tsconfig.check.json
third_party\runtimes\bun\bun.exe test ./tests
third_party\runtimes\bun\bun.exe src\Main.ts --mode smoke
third_party\runtimes\bun\bun.exe src\Main.ts --mode build
```

Python 模块搜索根为 `python/`，由 `src/services/Python.ts` 为子进程显式设置。Python 包工具在 `python/` 下读取 `pyproject.toml`，无需重新安装依赖。Python 测试逐文件使用独立进程，防止 `db_cache_test.py` 的假 AES 模块污染其他测试。

网页仍通过 AOBB 的已有常用浏览器打开和检查。迁移不改变微信后台操作和消息内容访问规则。

## 迁移对照

- `wechat_cli/` → `python/wechat_cli/`；Python 包配置和依赖锁文件一并归入 `python/`。
- `web/` → `src/web/`，其中 `dist/` → `var/web/`。
- `prompts/` → `src/prompts/`；`scripts/dev/` → `src/dev/`。
- `zotherGit/` → `third_party/sources/`；`runtimes/` → `third_party/runtimes/`。
- `licenses/` → `third_party/licenses/`；`cache/downloads/` → `third_party/downloads/`。
- `备课/` → `docs/备课/`；`PROGRESS.md` → `docs/PROGRESS.md`。
- 原根目录 `data/`、`cache/`、`logs/`、`tmp/` 分别归入 `var/` 下同名目录。

运行数据按目录整体移动，账号配置、密钥和聊天文件内容未改写。已有账号配置和缓存索引中的项目内旧绝对路径由 Python 的 `managed()` 转为 `var/` 下的新位置；仍保留项目边界检查。微信原始数据库路径不变。

跨任务共用的微信绑定锁仍由原来的 `JIMUKEFU_WX_LOCK` 或共享缓存位置协调，本次不迁移项目外共享锁。`docs/备课/` 和第三方参考源码保留历史路径，不参与构建或执行。

## 备份和恢复

`var/backups/Layout_*/` 保留迁移前的程序源码、测试、当前文档及根配置；`Source_Hashes.json` 记录逐文件 SHA-256，`Moves.json` 记录实际搬迁。

备份不含账号配置、密钥和聊天数据。需要回退时先停止积木客服，按清单反向移回运行目录，再恢复对应源码；保留原运行数据，不用源码备份覆盖消息库。
'''
(ROOT / 'docs/目录结构.md').write_text(doc, encoding='utf-8')
print('启动路径、目录说明及测试等待条件已同步。')
