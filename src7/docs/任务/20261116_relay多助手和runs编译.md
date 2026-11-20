# 任务书：relay 接多个助手 + 打开 runs 编译通道

- 写的人：130 上的 Claude，2026-11-16 EST。做的人：jm开发。
- 用户 11-16 定了新分工：重要代码 Claude 写，jm开发 打下手，编译和 Windows 上的执行交给 jmbots（`POST /api/run`），DSH 兜底。这是按新分工派的第一件活。
- 目的：用户在飞书上对周小灵打 `cc …` 就能找到 Claude；Claude 不再经 DSH，直接让 jmbots 在 Windows 上编译。

## Claude 已经改好的代码（你审一眼，别回退）

- `src7/plugins/relay/index.ts`、`Routes.ts`：可以接多个外部助手。
  - 配置改成 `helpers` 名单，第一个是默认助手。
  - 每条收件多一栏 `helper`；回执“已转给 X”、回信前面的署名、推不推 webhook、超时提醒，都照这条收件的助手来。
  - `GET /api/relay/inbox` 多了 `helper=` 筛选；`POST /api/relay/reply` 用 `chat` 主动发时可以带 `helper`。
  - 旧库启动时自动补 `helper` 栏，旧收件都算默认助手的。
  - **代码里不写死任何助手名**（用户 11-16：将来要给别人用）。原来写死的默认值（helper `jm开发`、prefixes `jm `/`jm开发`、bots `leon 的dsh`）都去掉了，全靠配置。
- `src7/plugins/approval/Rules.ts`：白名单加上 `bun run typecheck:src7`、`bun run test:src7`、`bun scripts/Build_Src7.ts --out <目录>`（目录可以带中文）。新测试 `Rules.test.ts`。
- `package.json`：加 `typecheck:src7`（`tsc -p tsconfig.src7.json && tsc -p web/tsconfig.json`）。
- `config.example.yaml`：relay 段换成 helpers 的样例。
- 证据（只在 130 上）：`tsc -p tsconfig.src7.json` 退出码 0；`bun test ./src7/plugins/approval/Rules.test.ts` 2 pass。relay 还没有离线测试，下面第 2 步要你补。

## 你要做的（按顺序，每做完一步写进 `进度.md`）

> 14:58 EST 改：用户要先让 DSH 编译，第 5、6 步（编译、换版）改由 Claude 直接派 DSH 做。你只做第 1–4 步和第 7 步。
>
> 15:27 EST：第 5、6 步都做完了。DSH 编出 0.7.5，用户 15:22 EST 自己换上（配置和 exe 一起换）。换后 Claude 验过：health 正常，relay、runs 挂上，`cc` 收发通，经 `/api/run` 在 Windows 上跑 `typecheck:src7`、`Build_Src7.ts` 都过了。以后编译、跑测试直接用 `/api/run`。

1. **审代码**：看上面几个文件的改动。有不同意见写进 `jm开发_问Claude.md`，先别改。

2. **补 relay 的离线测试**，放进 `test:src7` 能跑到的地方，搭法照你熟的来。至少这几条：
   - 两个助手：A（前缀 `a `，配一个假 webhook 地址）、B（前缀 `b `，不配 webhook）。发 `b 你好`：
     - 回执是“已转给 B（#n），等回复。”；
     - `GET /api/relay/inbox?helper=B` 有这条，`helper=A` 没有；
     - 没往 A 的 webhook 推。
   - `POST /api/relay/reply {id, text: '收到'}` 以后，回给用户的话是“B：收到”。
   - 旧库的 `relay_items` 没有 `helper` 栏：启动后补上，旧收件都归第一个助手。
   - `helpers` 没写、名字重复、前缀有空串：`apply` 抛错。
   - 用 `chat` 加 `helper: 'B'` 主动发：挂在 B 的收件上，不挂到 A 的。

3. **把写死的示例改成泛称**：`src7/plugins/agent-tasks/Routes.ts:19`、`src7/plugins/agent-tasks/index.ts:81` 里的 “grokbots”。

4. **文档回写**：`docs/src7插件设计/relay.md`、`docs/src7插件设计/进度/relay_用法.md` 改成多助手的样子：helpers 名单、inbox 的 helper 筛选、reply 的 helper 参数、收件多了 helper 字段。顺带把已经过时的说法改掉，比如“只是设计”“不推送给外部助手”。

5. **Windows 上编译**（DSH）：`bun run typecheck:src7`、`bun run test:src7` 退出码都是 0，再 `bun scripts/Build_Src7.ts --out <你平常放测试包的目录>` 出包。

6. **在飞书上问用户能不能换版，他点头才换。** 配置和 exe 一起换：先备份正式 `jmbotsData\config.yaml`，改完配置立刻换 exe。只改配置、不换 exe 的话，上一版一重启就会把 webhook 丢掉。要退回换版前的程序时，配置也一起退回备份。
   - 配置改两处（内容别贴出来，token 不外露）：
     - relay 段：Claude 11-16 读过线上配置，现在写的是 `bots: ['leon 的dsh']`、`prefixes: ['jm ', 'jm开发']`、`webhook_url`、`webhook_header`、`owner_open_ids`，没写 `helper`（靠的是写死的默认值 jm开发）。改成：
       ```yaml
       - name: relay
         config:
           helpers:
             - name: jm开发                  # 原来靠默认值，现在写明
               prefixes: ['jm ', 'jm开发']
               webhook_url: <照抄原来的>
               webhook_header: <照抄原来的>
             - name: Claude
               prefixes: ['cc ', 'CC ']
           bots: ['leon 的dsh']
           owner_open_ids: <照抄原来的>
       ```
       不挪的话，新版 relay 启动就报“要在 helpers 里写至少一个外部助手”，`/api/health` 会报 relay 没挂上，你和用户的飞书来回就断了。
     - plugins 名单里加 `- name: runs`，写在 approval、exec 后面。
   - 换完核对：
     - `/api/health` ok，problems 是空的；`/api/plugins/status` 里 relay、runs 都挂上了；
     - `GET /api/runs?limit=1` 返回 200（现在是 404）；
     - 你自己在飞书上对周小灵发一句 `jm 测试`，确认 webhook 照常推到你那里，链路没断。

7. **回 Claude**：用 `/api/relay/reply` 回 Claude 发给你的那条消息（收件号就是 webhook 推给你的 id），写清做了哪几步、每步的证据，以及哪些只做了类型检查、哪些真跑过。

换版以后，Claude 自己验两件事，你不用管：从 130 发 `cc 测试` 走一遍收发；经 `/api/run` 在 Windows 上跑 `typecheck:src7` 和 `Build_Src7.ts`。

## 规矩

- 不改骨架；插件之间不互相 import；代码里不写死助手名、机器人名、路径。
- config.yaml 的内容不外露；改代码、改配置之前先备份。
- 换版等用户点头。
