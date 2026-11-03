# CLAUDE.md

给 Claude Code 读的项目说明。2026-11-03 瘦身：旧代码时期的长篇架构、命令、网页和 zbots 说明，整份存档在 `docs/05_旧版CLAUDE说明_20261103.md`，要查旧写法去那里；本文件只留现行约定。

**所有回复一律用中文**（VSCode 对话、收件箱回信、交给用户看的任何总结都一样），不要回英文。2026-10-29 用户要求：“我要看中文……别给我回覆英文了”。

## 云端网页版须知（在 claude.ai/code 的沙箱里跑时先看这一节）

2026-11-03 起，仓库 `liuxingpluck/jmbots` 关联了网页版 Claude Code。沙箱里没有 `F:\` 盘，也没有记忆库和 `docs/`（它们不进 git），下面“开工先读”“和 jmbots 一起干活”“在哪里跑”里涉及 Windows、DSH、记忆库、`192.168.200.1` 的内容都跟你无关，跳过。

- 能做：`bun install --no-save --ignore-scripts` 后跑 `bun run typecheck`、`bun run lint`、`bun run test`（离线测试），修不依赖本机环境的 bug、补测试。
- 不做：真实模型调用（`tests/Live_*.ts`、`eval:models`）、打开或编造 `config.yaml`、启停或换版本服务（`swap`、`serve`、`guard`、`autostart`）、碰 `shell/` 的 Windows 自启逻辑的真实效果（只能看代码和跑它自带的离线测试）。
- 工作方式：从最新 `main` 切 `claude/<主题>` 分支，小步提交，推分支并开 PR；**不直接推 `main`**，不强推。PR 描述写清改了什么、跑了哪些命令、结果如何（通过和没验证分开写）。本机在 Windows 上审阅后合并。
- 说“通过”时只说真跑过的：沙箱里 typecheck、lint、离线测试通过，不等于 Windows 真实运行验收。
- 回复一律中文，代码约定见下面“代码约定”一节。

## 开工先读

- **记忆库** `F:\aidata\AI_Memory`（虚拟机里 `~/project/faidata/AI_Memory`）：只读 `Index.md` 和 `00_常驻摘要.md`，不通读。其余按摘要里的“遇到什么读哪里”只读相关小节；想查用户定过的规则、纠正、决定，用 `node 06_Cards/卡片工具.mjs search "问题"`；`01_User/Background_And_Goals.md` 只在涉及用户背景或目标时读；`05_History/` 只在追溯时读。纯解释或诊断类问题直接回答，不先检索记忆。
- 只在三种情况写记忆：用户说“记住”或给出明确纠正和新规则；重要决定或验收结果；可复用的做法或踩坑。写之前先搜有没有同类条目，有就更新；不做每轮留存判断。长期记忆只写记忆库，不写本机的 `~/.claude`。
- **记忆库是 Claude、Codex、DSH 以及将来更多 AI 共用的**（用户 2026-11-03 强调）：优化或写入时不要写死某一个 AI 的机制或名字，内容和工具都要对任何 AI 通用。
- **项目**：先读 `docs/03_进度与待办.md`（文件表、写死的默认值、待办）；需求理解 `docs/02_需求理解.md`；设计和现状对照 `docs/04_项目梳理与目标设计.md`。

## jmbots 是什么

多机器人后端，Web HTTP 服务为主，飞书是外接渠道。2026-10-29 从零重写，11-02 改名 jmbots；项目真身是 `F:\aidata\source\jmbots`（旧名目录 `F:\aidata\source\jmai` 是空目录）。旧代码在 git 标签 `backup-20261029-before-rewrite`（提交 `53fe39a`）和 `bak/` 里，只作参考。

- 入口 `src/Main.ts`：`run`、`approve`、`reject`、`list`、`logs`、`serve`。
- 分层：`core/`（Runtime、Model、Dispatcher、Judge、Engine）、`store/`（Events 数据库、Log）、`tools/`（默认 12 个工具；read、edit、exec 的做法从 Pi 精简抄来；`codegraph` 用 TypeScript 语言服务查代码关系，代替 graphify）、`channels/`（Http、Feishu、WebPage）、`utils/`。
- 运行时目录 `F:\aidata\AIJMBots`：`bots/`、`agents/`、`workspaces/`、`知识库/` 只放配置和最终结果；会话日志在 `logs/bots/<机器人>/<会话ID>_<标题>/` 和 `logs/常规/`；数据库和服务输出日志在 `data/`。**`config.yaml` 有密钥，不要打开、打印或复制**（模板是根目录 `config.example.yaml`）。编译、下载用的缓存放 `F:\aidata\cache\`，不放 C 盘。
- 网页：`web/`（React + antd，界面库只用 antd），`src/channels/WebPage.ts` 托管 `dist/web`，构建用 `bun run build:web`。
- zbots（`zbots/`）11-02 晚起停用，飞书改由 jmbots 接；说明在 `zbots/docs/`。飞书 SDK 暂时借用 `zbots/node_modules`。

## 和 jmbots 一起干活

- Claude 在虚拟机里用 HTTP 把活交给周小灵：`http://192.168.200.1:30086`，`POST /api/run {text, bot, wait}`，`GET /api/sessions/:id/full` 看每步和思考。她给 Claude 的留言在运行时 `integrations/claude/给Claude/`；给用户发飞书放 `integrations/feishu/发件箱/`。
- jmbots 改自己的代码后用 `bun scripts/Swap_Serve.ts`（`bun run swap`）换版本。
- DSH 只跑已确认的命令（启动、重启 jmbots）。选 DSH 模型前先查记忆里的“订阅额度使用边界”：不得用按量付费的 `deepseek-official/*`，试验对比用 `magpie/workbuddy/*`。控制工具见 `ztools/dsh-control/README.md`。

## 在哪里跑

- 真实运行环境是 **Windows**。Claude Code 在 Linux 虚拟机里时，虚拟机通过共享文件夹看到同一份文件：不在虚拟机里装 npm 包、不启停 Windows 上的服务，这些交给 DSH。typecheck、lint、离线测试在虚拟机里跑过（见 `docs/03_进度与待办.md`）。
- Windows PowerShell 用 `bun.cmd` / `npm.cmd`（`.ps1` 被执行策略拦）。装依赖：`bun install --no-save --ignore-scripts`（DSH 里先设 `BUN_INSTALL_CACHE_DIR=$env:TEMP\bun-cache`）。
- 从 DSH 起后台进程：`Start-Process cmd.exe -ArgumentList '/d','/c','<命令> > <日志> 2>&1' -WindowStyle Hidden`（不用 `-RedirectStandardOutput`，环境里同时有 `http_proxy` 和 `HTTP_PROXY` 会失败）。启动脚本尽量后台静默，不弹窗口。
- 本机 TCP 临时端口范围是 1024–15000：在这个范围里监听可能报 `os error 10013`。监听端口选 15000 以上，用户的规则是“10000 以上且不含数字 4”。
- `.cmd` 只写 ASCII（cmd.exe 按本地代码页读 UTF-8，曾把中文注释当命令执行），逻辑和中文放进 `.ts`。

## 命令

```bash
bun run typecheck   # 类型检查
bun run lint        # eslint，--max-warnings 0
bun run test        # 即 bun test ./tests ./zbots/tests，离线测试
bun run build:web   # 打包网页到 dist/web
bun run start       # 构建网页后启动服务
bun run swap        # 换版本：先检查，再试运行，再替换正式服务
```

- `tests/Live_*.ts` 和 `bun run eval:models` 会**真实调用模型、产生费用**，用户批准真实调用后才跑。
- 类型检查、测试、构建通过不等于真实验收，要分开报告证据级别。

## 代码约定（细则见 `bak/docs_bak/TypeScript书写规范.md`，旧 JMAI 时期写的，jmbots 仍沿用）

- 注释用 `//M`（主线）和 `//G`（守卫）；检查函数放 `utils/Checks.ts`，调用处只留主线。
- 本地导入写真实的 `.ts`/`.tsx` 扩展名；Node、第三方、跨文件模块用命名空间导入（`import * as path from 'node:path'`）；只导入类型用 `import type`。
- `if/else/for/while` 都加大括号；不嵌套三元；优先卫语句。
- 中文注释：文件头写职责；导出的函数写输入、输出、副作用；接口和类型每个属性一行 JSDoc；关键局部变量说明来源和用途。
- 可读性优先于排版统一：不批量格式化、不加转发层、保留用户起的名字；小步（约 100 行）改，中间验证。
- 新文档用中文文件名（可夹英文词）；文档入口 `docs/00_文档索引.md`。
