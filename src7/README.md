# src7：jmbots 第 7 版骨架

进度、还没验证的地方，见 `docs/src6开发/骨架和插件_进度.md`。本目录的代码和这份说明不一样时，以代码为准。

词汇表（会话字段、“基地”的叫法、新人易卡的词）见 `docs/词汇表.md`。

## 一条规矩：骨架少之又少

- 骨架是本目录里 `plugins/` 以外的文件，**只管一件事：一场会话怎么跑**，要一眼读得懂。
- 骨架里没有机器人、渠道、前台、分派、工作区这些词，它们全在插件里。
- **主线全是直接调用**，按 F12 能一路跳到实现；**事件只留给插件接进来**。
- 各种业务功能都做成插件，以后也是往 `plugins/` 里加。给骨架加函数、加事件之前，先想能不能做成插件。
- 外面进来的东西只校验一次：命令行参数、`config.yaml` 在 `utils/Checks.ts`；模型给工具的参数在 `Tools.execute`；插件的配置在插件自己的 `apply`。别处不再查。

## 文件

```text
src7/
  Main.ts            入口：挂骨架 → 照 config.yaml 的 plugins 挂插件 → 发 ready → 接着跑没跑完的会话
  Resources.ts       资源：config.yaml、数据库、pi 的供应商、运行时目录下的文件夹
  Sessions.ts        会话：一份记录 + 一个循环，加上用 pi 发一次模型请求的 chat()。最重要的一个文件
  Tools.ts           工具：登记、报清单、执行
  Channels.ts        渠道协议：channel/message、reply、history、recall 等事件的类型和各渠道共用的小工具（用户 #147 从 bots 挪进骨架）
  utils/
    Checks.ts        校验：命令行参数、config.yaml
    Text.ts          小工具：把抛出来的错收成一句话
    Trace.ts         跟踪点长什么样
    Mime.ts          按扩展名认文件类型（网页、文件接口共用）
    Cut.ts           长文字截断：从头留、从尾留（最多 2000 行、50KB），按字数截
    Workspace.ts     工作区里的相对路径换成绝对路径，出了工作区就报错
    Names.ts         安全文件名、20 位时刻号（生图、留言、命令窗口共用）
    Card.ts          卡片数据：审批卡片、长跑提醒卡片共用（网页、飞书照同一份画）
  plugins/
    Index.ts         插件的约定，和自带插件的名单（分类和每个插件提供什么、用了谁见 docs/插件地图.md）
    —— 骨架配套 ——
    workspaces/      工作区：一个机器人可以有好几个工作区，各有唯一 ID；服务 ctx.workspaces，前台工具 workspace；后台会话按 ID 绑工作区。要写在 bots 前面
    bots/            机器人：名单、收消息（channel/message 认领、bot/receive 问一圈），渠道用 ctx.bots.channel 登记发送函数；
                     前台 FrontDesk.ts（没人认领的消息进这个机器人对这个客户的前台对话，简单的自己答）、派后台 Dispatch.ts（复杂的转给后台会话，结果回前台整理再发回）、
                     系统提示词 Prompt.ts（底座、功能声明、会话种类提示词、人设、记忆）、reply 工具 ReplyTool.ts（后台会话做到一半先回用户一句）、渠道工具 ChannelTools.ts
    fake-model/      假模型：不发请求，离线跑通链路用
    —— HTTP 底座和网页 ——
    http/            HTTP 服务（Fastify）：端口读 server.port，本机免令牌，外部要令牌
    web/             网页：把 dist/web 的页面发给浏览器
    —— 渠道 ——
    cli/             命令行渠道
    web-api/         网页要的接口：机器人、会话、发话、停止、换模型、追溯
    feishu/          飞书渠道：收发消息、图片文件、卡片（待确认、进度）、飞书文档、发件箱，内部分子文件夹
    wechat/          微信渠道（对外名 wechat-kefu，积木客服改写）：只读引擎轮询监听会话的新消息，每个客户一场前台会话（wechat:<会话>）；回话自动发或经待确认卡片发；客服页 /wechat-kefu/
    —— 分派 ——
    relay/           外部助手的交办都在这里，三样：
                     转话：bots 里写 relay: direct 的机器人不调模型，把话写进收件箱交给外部助手（jm开发），回信再送回原渠道
                     外部 AI 任务通道：agent_task 工具，外部 AI 来领活、交结果的 7 个接口（/api/agents*）
                     给外部助手留言：用 agent_task 的 send 指定执行端并写 reply: false，领取即送达
    —— 给模型的工具 ——
    file-tools/      文件工具：time、read、list_dir、write、edit（按原文替换，引号空白宽松匹配）、find（按名字、内容找）；用户话里 @ 的图片接给看图模型
    exec/            exec 工具：跑 shell 命令，先审核；点停止会把整棵进程树结束
                     命令窗口（Runs.ts）：POST /api/run 不经模型直接跑命令（先审），列、查、看输出、停下
    web-search/      web_search 工具：按顶层 search 段一家一家试，点停止就断开请求
    image-gen/       image_generate 工具：调生图接口，图存进工作区，点停止就断开
    assist/          助手体验：react、ask、todo 三个工具，加一段回话规范；/api/assist
    —— 审核和流程 ——
    approval/        待确认：命令审核（规则 → decision → 审核小会话 → 问用户），GET/POST /api/approvals，认“同意 N / 拒绝 N”
    decision/        决策模型：一个或几个模型同时打分，合成放行 / 拒绝 / 拿不准（approval、progress 可选地用）
    progress/        进度和限时：到点问 decision 延不延、收尾、超时记 overtime.jsonl；GET/POST /api/progress
                     复盘（Review.ts）：空闲时挑一场超时的会话写复盘，经待确认，同意了存进 memory/复盘/
    —— 模型与上下文 ——
    model-catalog/   模型目录：从供应商拉模型清单、价格，网页换模型用
                     换模型（Fallback.ts）：在 session/request 最后自己调模型，限流、超长时换着试，按模型、供应商排队。所以写在 plugins 段最后
                     模型介绍和评价（Notes.ts，原 model-notes）：页面 /model-notes/，前台派活时经事件 model-catalog/request（prompt）参考
    context-fit/     上下文：干活的会话做完一轮写一句总结（Summary.ts）；太长时开小会话把前面的压成摘要（Compress.ts）；发给模型前超过上下文窗口就只留最近几段
    —— 记忆和知识 ——
    memory/          memory 工具（自己的、公共的记忆）；后台会话开头先搜一遍记忆和技能；配了基地就定时让它更新库的索引
                     客服记忆库（Store.ts、Backend.ts）：聊天记录按客户/会话/机器人、知识库按段，结果带来源引用；检索后端可换（本地 SQLite / 外部服务）
                     记忆关系图（GraphRoutes.ts、GraphStore.ts）：页面 /graph/（React），接口 /api/memory-graph/*
    skills/          技能：清单放进后台会话的系统提示词，skill 工具只读技能文件
    —— 管理接口 ——
    settings/        设置页：GET/PUT /api/settings（密钥遮住）、POST /api/bots 新建机器人、立即重启
    files-api/       文件接口：上传、看文件、列目录
    base-bridge/     基地转发：/api/update、/api/autostart、/api/memory/*、/api/rag/* 转给 engine.index_url；
                     两样默认关、配置打开：通知（config.notify：待确认、长任务结束转到基地 toast，notify_user 工具）、
                     更新监听（config.update_watch：盯基地的新版本，登记待确认，同意了叫基地去换，下一次报结果）
    desktop/         窗口操控：/api/desktop/status、/api/desktop/action，调 AOBW 能力程序
    —— 记录和调试 ——
    tutorial/        教程和调试页 /tutorial/（/flow/ 跳过去）：录这次启动走过的路、最近消息的泳道图和每步快照、每个插件的说明/状态/代码；
                     打开 trace_console 时控制台打印一条消息走过哪些模块、哪些函数、哪些事件。写在 plugins 段第一个
    journal/         流水：跟踪行和事件记进 journal_lines 表，GET /api/events 查；
                     会话镜像（FilesMirror.ts，服务 ctx.filesMirror）：bots/<机器人>/sessions/<会话>/对话.md 和 session.json
    usage/           用量：每次模型请求记进 model_usage 表，GET /api/usage 按天、按模型汇总
```

依赖：骨架是 `resources` ← `tools` ← `sessions`；插件里 `workspaces` 用骨架，`bots`（含前台、系统提示词）用骨架和 `workspaces`，渠道、自带工具用 `bots`。自带插件共 30 个文件夹，名单以 `plugins/Index.ts` 的 `BUILT_IN` 为准。

骨架和 utils 的行数会随提交变，不在这里写死；要看就数 wc -l src7/*.ts src7/utils/*.ts。插件清单看 docs/插件地图.md，那里的表由 bun ztools/plugin-map/Gen_Plugin_Map.ts 生成。

## 一条消息怎么走

以飞书群里一条 @ 了机器人的普通消息为例。

1. **收到群消息。** `Feishu.start` 监听飞书的 `im.message.receive_v1`，交给 `FeishuInbound.onMessage` 按消息号去重。 [`Feishu.start` · `im.message.receive_v1` · src7/plugins/feishu/index.ts:594](plugins/feishu/index.ts#L594) · [`FeishuInbound.onMessage` · src7/plugins/feishu/Inbound.ts:159](plugins/feishu/Inbound.ts#L159)
2. **存好再分发。** `FeishuInbound.handleInboundMessage` 识别 @ 和群设置、准备附件并存聊天日志，再由 `FeishuInbound.deliver` 发 `channel/message`。 [`FeishuInbound.handleInboundMessage` · src7/plugins/feishu/Inbound.ts:212](plugins/feishu/Inbound.ts#L212) · [`FeishuInbound.deliver` · `channel/message` · src7/plugins/feishu/Inbound.ts:736](plugins/feishu/Inbound.ts#L736)
3. **审批先看是不是批复。** `Approval.onChannelMessage` 抢在机器人前读取 `channel/message`，有权处理的“同意 3”之类指令只消费一次并直回，普通消息继续分派。 [`Approval.constructor` · `channel/message` · src7/plugins/approval/index.ts:379](plugins/approval/index.ts#L379) · [`Approval.onChannelMessage` · src7/plugins/approval/index.ts:953](plugins/approval/index.ts#L953)
4. **逐个机器人找会话。** `Bots.onChannelMessage` 给每个目标机器人准备附件并发 `bot/receive`，让 relay 等插件先认领，其余普通消息交前台。 [`Bots.onChannelMessage` · src7/plugins/bots/index.ts:469](plugins/bots/index.ts#L469) · [`Bots.onChannelMessage` · `bot/receive` · src7/plugins/bots/index.ts:537](plugins/bots/index.ts#L537)
5. **把话排进前台。** `DispatchClaim.claimChannelMessage` 按渠道、账号、聊天找这台机器人的前台，去重后保存消息和原回话地址，由 `DispatchResults.startQueuedUser` 在轮到它时调用 `Session.add` 和 `Session.run`。 [`DispatchClaim.claimChannelMessage` · src7/plugins/bots/DispatchClaim.ts:39](plugins/bots/DispatchClaim.ts#L39) · [`DispatchResults.startQueuedUser` · src7/plugins/bots/DispatchResults.ts:881](plugins/bots/DispatchResults.ts#L881)
6. **调模型前。** `Session.loop` 发 `session/request`，让插件调整提示词和工具清单，`approval` 按说话人筛工具，随后由 `Sessions.chat` 发出请求（插件已经给出回答或要求停下时跳过）。 [`Session.loop` · `session/request` · src7/Sessions.ts:552](Sessions.ts#L552) · [`Approval.constructor` · `session/request` · src7/plugins/approval/index.ts:389](plugins/approval/index.ts#L389) · [`Sessions.chat` · src7/Sessions.ts:404](Sessions.ts#L404)
7. **模型回答后。** `Session.loop` 发 `session/after-model`，插件可以改回答或停止这一轮，放行的回答接进对话时由 `Session.append` 发 `session/message`。 [`Session.loop` · `session/after-model` · src7/Sessions.ts:584](Sessions.ts#L584) · [`Session.append` · `session/message` · src7/Sessions.ts:689](Sessions.ts#L689)
8. **执行工具前。** `Tools.execute` 发 `session/before-tool`，`approval` 按当前说话人复核工具权限并可用 `gate.deny` 拦下单次调用，放行后才校验参数并执行。 [`Tools.execute` · `session/before-tool` · src7/Tools.ts:147](Tools.ts#L147) · [`Approval.constructor` · `session/before-tool` · src7/plugins/approval/index.ts:409](plugins/approval/index.ts#L409)
9. **回复发回飞书。** 模型调用 `channel_reply` 时，`ChannelTools.runReply` 经 `requestChannelReply` 发 `channel/reply`，`FeishuReply.onChannelReply` 向原群发纯文字并交回 `channel/replied` 回执。 [`ChannelTools.runReply` · src7/plugins/bots/ChannelTools.ts:270](plugins/bots/ChannelTools.ts#L270) · [`requestChannelReply` · src7/Channels.ts:801](Channels.ts#L801) · [`FeishuReply.onChannelReply` · src7/plugins/feishu/Reply.ts:140](plugins/feishu/Reply.ts#L140)
10. **工具交回结果后。** `Session.loop` 发 `session/after-tool` 让插件看结果并存进对话，继续执行这一批工具，轮次还在运行时再回第 6 步。 [`Session.loop` · `session/after-tool` · src7/Sessions.ts:614](Sessions.ts#L614)
11. **这一轮收尾。** 模型没再要工具时，`Session.change` 存好结果并发 `session/change`，`DispatchResults.onChange` 接手，按回复回执收尾后发 `channel/settled` 并推进队列。 [`Session.change` · src7/Sessions.ts:697](Sessions.ts#L697) · [`DispatchResults.onChange` · src7/plugins/bots/DispatchResults.ts:365](plugins/bots/DispatchResults.ts#L365) · [`DispatchResults.emitSettled` · src7/plugins/bots/DispatchResults.ts:705](plugins/bots/DispatchResults.ts#L705)

群里没 @ 到机器人时，按群设置只存日志、记作背景或交给决策模型判断要不要接话。 [`FeishuInbound.getTargets` · src7/plugins/feishu/Inbound.ts:417](plugins/feishu/Inbound.ts#L417) · [`FrontDesk.handleChannelListen` · src7/plugins/bots/FrontDesk.ts:432](plugins/bots/FrontDesk.ts#L432)

`exec` 工具多一道命令审批。`Exec.onTool` 发 `approval/request` 并等 `approval/result`，放行后才执行命令，需要用户点头时转待确认。 [`Exec.onTool` · src7/plugins/exec/index.ts:261](plugins/exec/index.ts#L261) · [`requestReview` · `approval/request` · src7/plugins/exec/Runs.ts:93](plugins/exec/Runs.ts#L93)

飞书前台一轮正常结束且零次调用回复工具时，`DispatchResults.finishChannelFront` 只加跑一轮，提醒模型调用 `channel_reply`。 [`DispatchResults.finishChannelFront` · src7/plugins/bots/DispatchResults.ts:544](plugins/bots/DispatchResults.ts#L544) · [`FrontDesk.onRequest` · src7/plugins/bots/FrontDesk.ts:711](plugins/bots/FrontDesk.ts#L711)

### 网页、微信和命令行从哪里进

- **网页**的 `POST /api/message` 由 `WebApi.accept` 存入时间线并发 `channel/message`，指定或引用会话时带已校验的会话号。回话由 `WebApi.replyDirect` 追加到原网页消息。 [`WebApi.accept` · src7/plugins/web-api/index.ts:382](plugins/web-api/index.ts#L382) · [`WebApi.emitChannelMessage` · `channel/message` · src7/plugins/web-api/index.ts:592](plugins/web-api/index.ts#L592) · [`WebApi.replyDirect` · src7/plugins/web-api/index.ts:645](plugins/web-api/index.ts#L645)
- **微信**的 `Wechat.store` 存好监听到的新消息后，把需要回复的消息发成 `channel/message`。`Wechat.deliverOrDraft` 把回话放进发件表，按设置直发、待确认或留草稿。 [`Wechat.store` · src7/plugins/wechat/index.ts:378](plugins/wechat/index.ts#L378) · [`Wechat.store` · `channel/message` · src7/plugins/wechat/index.ts:472](plugins/wechat/index.ts#L472) · [`Wechat.deliverOrDraft` · src7/plugins/wechat/index.ts:732](plugins/wechat/index.ts#L732)
- **命令行**的 `Cli.submitLine` 存好原始输入后发 `channel/message`，回话逐条打印。 [`Cli.submitLine` · src7/plugins/cli/index.ts:143](plugins/cli/index.ts#L143) · [`Cli.constructor` · src7/plugins/cli/index.ts:79](plugins/cli/index.ts#L79)

这三个渠道的普通前台消息都用 `channel_tool`，并设置 `routing.autoFinal`，一轮正常结束且零次调用回复工具时，由 `DispatchResults.sendLastWords` 把 `row.reply` 经 `channel/reply` 发出。 [`WebApi.accept` · src7/plugins/web-api/index.ts:382](plugins/web-api/index.ts#L382) · [`Wechat.store` · src7/plugins/wechat/index.ts:378](plugins/wechat/index.ts#L378) · [`Cli.submitLine` · src7/plugins/cli/index.ts:143](plugins/cli/index.ts#L143) · [`DispatchResults.sendLastWords` · src7/plugins/bots/DispatchResults.ts:655](plugins/bots/DispatchResults.ts#L655)

### legacy_auto 还在哪里用

`legacy_auto` 是兼容的自动回话方式。旧式会话结束时，若该轮有渠道且允许自动回话，`Bots` 的 `session/change` 监听器把 `row.reply` 交给渠道登记的发送函数；后台结果队列走这种方式时，由 `DispatchResults.finishFront` 发回原渠道。 [`Bots.constructor` · `session/change` · src7/plugins/bots/index.ts:342](plugins/bots/index.ts#L342) · [`DispatchResults.finishFront` · src7/plugins/bots/DispatchResults.ts:453](plugins/bots/DispatchResults.ts#L453)

旧入口 `ctx.bots.receive` 仍可用，微信客服页点“让 AI 回复”起草时还走它。网页直投非前台会话、relay 直接认领会话也可走兼容自动回话；后台派活或结果没有继承到 `channel_tool` 来源时默认用 `legacy_auto`。 [`Wechat.draftReply` · src7/plugins/wechat/index.ts:843](plugins/wechat/index.ts#L843) · [`Bots.onChannelMessage` · src7/plugins/bots/index.ts:469](plugins/bots/index.ts#L469) · [`DispatchTools.getPlan` · src7/plugins/bots/DispatchTools.ts:179](plugins/bots/DispatchTools.ts#L179) · [`DispatchResults.getResultItem` · src7/plugins/bots/DispatchResults.ts:270](plugins/bots/DispatchResults.ts#L270)


## 事件

骨架发的：

| 事件 | 怎么发 | 什么时候 | 响应的人干什么 |
|---|---|---|---|
| `session/request` | 挨个问 | 关口一：每一步调模型之前 | 改这一步的请求：往 `system` 里加提示词；换掉 `messages`（压缩、检索、拼最近往来）；改 `tools`、`model`、`thinking`；直接填 `answer`（假模型）；在 `request.stop` 写理由：不调模型，这一轮停下 |
| `session/after-model` | 挨个问 | 关口二：模型回来之后、回答接进对话之前 | 看、改、换 `request.answer`（接进对话的是最后这一份）；在 `request.stop` 写理由：这次回答不要了，里面要的工具也不执行，这一轮停下 |
| `session/before-tool` | 挨个问 | 关口三：每个工具执行之前 | 把关：只拦这一个，在 `gate.deny` 里写上理由（给模型看，会话接着走）；在 `gate.stop` 写理由：这个和这一批后面的工具都不执行，这一轮停下 |
| `session/after-tool` | 挨个问 | 关口四：每个工具执行完、结果接进对话之前（没执行、被 deny 拦下的也走） | 改 `done.outcome`（文字、图片、是否出错）；在 `done.stop` 写理由：结果照样接进对话（要和工具调用配对），这一批后面的工具不执行，这一轮停下 |
| `session/message` | 通知 | 对话里新接了一条 | 记往来；将来的界面、流水 |
| `session/change` | 通知 | 状态变了 | 渠道回话；记往来；写总结 |
| `ready` | 通知 | 骨架和插件都挂完了 | 命令行渠道这时候才把命令行里带的那句话发出去 |
| `trace` | 通知 | 骨架和插件走到关键的地方 | journal 记进流水；tutorial 开了 `trace_console` 就打印一行 |

插件 `bots` 发的（不是骨架的事件）：

| 事件 | 怎么发 | 什么时候 | 响应的人干什么 |
|---|---|---|---|
| `bot/receive` | 挨个问 | 每个目标机器人认领前 | 分派插件可填 `event.session` 指定会话，或设 `handled` 表示已经处理；其余进机器人前台 |

- **关口**：上面四个挨个问的事件是会话每一步的关口。数据都带 `SessionGate { session; stop? }`（`Sessions.ts`）：`session/request`、`session/after-model` 用 `ChatRequest`（after-model 是带上 `answer` 的 `AnsweredRequest`），两个工具关口用 `Tools.ts` 的 `ToolGate`、`ToolDone`。谁在 `stop` 里写了理由，会话就 `session.stop(理由)` 停下，不往下走。
- **挨个问**：照插件挂上去的先后一个个 `await`，每个插件都会被问到，后面的看得到前面改的。实现用 `ctx.serial`，所以监听的函数不许有返回值；有了返回值，Cordis 就不再问后面的人了。
- **通知**：`ctx.emit`，只是告诉大家，不等，谁也不许靠它改流程。

## 会话

- 一场会话的记录是 `session.row`（`SessionRow`），在内存里；每次接消息、改状态都存进库里的一行。
- 骨架的记录里只有循环要用的几项：会话号、种类、嵌在哪场里、模型、思考档、状态、回话、对话、存库时间。
- **插件要往会话上记自己的东西，自己声明**：在插件文件里用 `declare module '../../Sessions.ts'` 给 `SessionRow` 加项，不用改骨架，存库时一起存。现在 `bots` 加了 `bot`（属于哪个机器人）、`channel`（回话往哪个渠道送）等，`context-fit` 加了 `summary`（一句总结）。
- 找会话用 `sessions.find({ … })`：给的几项都相等的那些，插件加的项也能用，比如 `find({ bot: '助手', kind: 'work' })`。它交回的记录不带对话；要对话就 `sessions.open(会话号)`。
- 开一场小会话问一次用 `sessions.ask({ bot, kind, parent, model, thinking, text, signal })` → `{ ok, reply }`：create → add → run 连起来，`signal` 断了小会话也停。审批、压缩、总结、复盘、进度收尾、判断都用它。
- 状态四种：`running` 正在转；`done` 做完了；`stopped` 停下了（有人喊停，或者某个关口上有插件写了 `stop`）；`failed` 出错了。
- 一轮结束时，`row.reply` 存模型最后一句或停止、失败的原因。实际怎么回给用户，见 [一条消息怎么走](#一条消息怎么走)。
- 种类 `row.kind`：骨架不解释它，只拿它去对工具登记时写的 `kinds`。现在有 `front`（前台对话）、`work`（后台干活的会话）、`compress` 和 `summary`（嵌在别的会话里的小会话）。小会话没有渠道，所以没人给它回话。
- 正在转的时候又来一句话：先排着，循环下一步开头接进对话（不会插在模型的回答和工具结果中间）。来得太晚、这一轮已经收尾了，就紧接着再转一轮。
- 喊停 `session.stop(谁)`：状态改成 `stopped`，正在等的模型请求马上掐断；正在跑的那个工具拿到同一个停止信号，慢的马上断开、记成“已停止”（不算出错，做了的不回滚），快的照常做完；后面的记“未执行：停下来了”。reply 是“已停止（谁）”。已经停下了再喊不会再停一次（不再发 `session/change`）。
- 喊停后慢工具还在收尾时又来一句话：先排着，这一轮收尾后紧接着转，不用等下一句话。
- 模型请求出错：`Sessions.chat()` 里照 `engine.retry` 重试，试够了还不成，这一轮就是 `failed`。工具出错不算会话出错，原因当成工具结果给模型看。
- 重启：入口把库里还是 `running` 的会话各调一次 `run()`，从存下来的对话接着走。

### 库里的表 `sessions`

`sessions` 存所有会话（前台、后台、小会话）；一行是一场会话，记录拆两块存：对话一块，别的项一块。

| 列名 | 类型 | 能不能空 | 意思 | 谁写、什么时候写 |
|---|---|---|---|---|
| `id` | TEXT PRIMARY KEY | 否（主键） | 会话号：本地时刻 17 位 + 3 位随机，共 20 位数字（旧的 8 位十六进制号照样能开） | `Session.save`，`Sessions.create` 新开时先查重再存 |
| `meta` | TEXT NOT NULL | 否 | 记录去掉 `messages` 后的 JSON：骨架的 id、kind、parent、model、thinking、state、reply、updatedAt，加插件声明的项（如 bot、channel、address、customer、summary、frontTask、resultQueue 等）；`sessions.find` 照它里面的项找 | `Session.save`：新开（`create`）、接进一条消息（`append`）、改状态（`change`）时，以及插件改完 `row` 自己调 `save()` 时；每次整行 INSERT OR REPLACE，`updatedAt` 改成当时 |
| `messages` | TEXT NOT NULL | 否 | 整场对话 JSON（pi 的 Message 数组） | 同上 |

依据：建表 `src7/Sessions.ts:208-210`；写 `:603-614`（`save`，由 `create` `:251`、`append` `:622`、`change` `:634` 调）。

## 插件

### 约定：导出三样

自带的、别人写的都一样。一个插件的 `index.ts` 导出：

```ts
/** 插件名：日志和跟踪里按它显示。 */
export const name = 'weather';

/** 要用到哪些服务；不用别的服务就不写。 */
export const inject = ['tools'];

/** 挂上时调一次：在这里听事件、登记工具、起渠道。 */
export function apply(ctx: Context, config: unknown): void {
  // ctx.on('session/request', (request) => { request.system.push('……'); });
  // ctx.tools.register({ definition, kinds: ['work'], run: (args, session, signal) => '……' });
}
```

- 这和 Cordis、DSH 的插件约定是同一套。拔掉插件时不用自己收拾：通过 `ctx` 登记的监听和工具会自动撤掉。
- 业务代码照旧写成 class，`apply` 里 `new` 出来就行，看 `plugins/cli/index.ts`。
- 工具的停止信号：`run(args, session, signal)` 的第三个参数是 `AbortSignal`，网页、飞书点停止时触发。要等很久的工具（搜索、生图、`exec`、子任务）把它交给 `fetch(url, { signal })`、`spawn(cmd, { signal })`，或者 `signal.addEventListener('abort', …)` 自己断开并抛错；骨架把这时抛的错记成“已停止”。写文件、替换文字这类快工具不用管它，老工具不写第三个参数也行。
- 插件能做的事：听上面的事件；调 `ctx.tools.register()` 登记工具；做一个新渠道（向 `ctx.bots.channel(name, send)` 登记发送函数，收话调 `ctx.bots.receive`）；开一场小会话再问一次模型（看 `plugins/context-fit/Summary.ts`）；给会话的记录加自己的项；自己提供一个服务给别的插件用（看 `plugins/bots/index.ts`）。
- 插件要读 `config.yaml` 里不在 `plugins` 段的东西（`bots`、`channels`、`server`……），从 `ctx.resources.raw` 拿整份配置，自己校验一次。里面有密钥，不许打印。

### 加一个自带的

1. 在 `plugins/` 下新建一个文件夹，里面写 `index.ts`。
2. 在 `plugins/Index.ts` 的名单里加一行。
3. 在 `config.yaml` 的 `plugins` 段写上它的名字。

### 接一个别人写的

不用改 jmbots 的代码：把插件文件夹（里面有 `index.ts` 或编译好的 `index.js`）放到运行时目录的 `plugins/` 下，在 `config.yaml` 的 `plugins` 段加一项，`name` 写文件夹路径。

写插件的人要知道：

- 只用传进来的 `ctx`，**不要自己 `import 'cordis'`**，要类型就用 `import type`。发版以后 jmbots 是单文件程序，插件自己装的 cordis 和程序里的不是同一份。
- 要用别的 npm 包，自己先用 `bun build` 打成一个 `index.js`。
- 外部的渠道插件向 `ctx.bots.channel(渠道名, send)` 登记发送函数，收话调 `ctx.bots.receive`，附件调 `ctx.bots.saveFile`。
- **还没验证**：编译成单文件的 jmbots 能不能在运行时 `import()` 磁盘上的 `index.ts`。

### config.yaml 怎么写

```yaml
plugins:
  - name: tutorial               # 教程和调试页 /tutorial/（/flow/ 跳过去）：要录启动，一定写在第一个
    config: { trace_console: false }   # true：控制台打印一条消息走过的路
  - name: workspaces             # 机器人的工作区，要写在 bots 前面
  - name: bots                   # 机器人（含前台、派后台、系统提示词）。要写在用它的插件前面
    config: { thinking: medium, front: { recent: 50 }, prompt: true, reply_tool: false } # 后台会话的思考档；front 是前台的配置（recent 带最近几条往来）；prompt 系统提示词，reply_tool 工具 reply
  - name: cli
  - name: file-tools             # time、read、list_dir、write、edit、find 工具
  - name: fake-model             # 假模型：只管模型名以 fake/ 开头的会话，别的会话照常发给真模型
  - name: http                   # HTTP 服务：端口写在顶层 server.port，不写就报错
  - name: web                    # 网页，要写在 http 后面
  - name: web-api                # 网页要的接口
  - name: files-api              # 文件接口
  - name: relay                  # 转话给外部助手、外部 AI 任务与留言：写在 http、fake-model 后面
    config: { remind_minutes: 15, expire_minutes: 120 }
  - name: feishu                 # 飞书渠道：应用号、密钥写在顶层 feishu 段
  - name: journal                # 流水和会话镜像：保留天数读顶层 events.keep_days（默认 30）；mirror: false 只写简版 对话.md
  - name: approval               # 待确认、命令审核；网页轮询 /api/approvals，挂 web-api 的就要挂它
    config: { model: magpie/某模型, thinking: low, decision_pass: 0.2 }   # model 不写用 default_model
  - name: exec                   # exec 工具和命令窗口 /api/run，要写在 approval 后面；读顶层 paths 段（runtimes、program）；runs: false 不开命令窗口
  - name: web-search             # web_search 工具：搜索供应商写在顶层 search 段
  - name: usage                  # 用量，GET /api/usage
  - name: settings               # 设置页接口，要写在 http 后面
  - name: memory                 # memory 工具、开头先搜记忆和技能、关系图 /graph/；读 engine.index_url、engine.memory_libs
  - name: skills                 # 技能清单、skill 工具
  - name: context-fit            # 总结、压缩、按上下文窗口裁剪
    config: { keep: 6, ratio: 0.9, summary: true, compress: { at: 200000, keep: 6 } }
  - name: progress               # 进度和限时、超时复盘：写在 bots 后面；读 engine.limit_* 几项；review: false 不写复盘
  - name: decision               # 决策模型：配置在顶层 decision 段（models、combine、allow_at、deny_at、timeout_ms）
  - name: image-gen              # 生图：读 engine.image_model
  - name: assist                 # react、ask、todo 工具
  - name: base-bridge            # 基地转发：读 engine.index_url
    config: { notify: false, update_watch: false }   # 基地通知、盯基地新版本，默认都关
  - name: desktop                # 窗口操控
  - name: wechat-kefu            # 微信渠道和客服页 /wechat-kefu/
    config: { bot: 助手 }
  - name: model-catalog          # 模型目录和换模型、排队：在 session/request 最后自己调模型，写在所有改请求的插件和 fake-model 后面，放最后
    config: { notes: { dir: models } }   # 模型介绍和评价（原 model-notes），/model-notes/；notes 可不写
  - name: ./plugins/weather      # 别人写的：文件夹路径，相对路径从运行时目录算
    config: { city: 上海 }
```

- 照写的先后挂；这个先后也是 `session/request` 挨个问的先后。
- 不写 `plugins` 段时，挂 `workspaces`、`bots`、`cli`、`file-tools`、`context-fit` 五个（前台和系统提示词在 `bots` 里；`utils/Checks.ts` 的 `DEFAULT_PLUGINS`）。
- `disabled: true` 是先不挂。找不到、起不来的插件打一行原因，不挡别的插件。
- 一个插件要用的服务没人提供（比如没挂 `bots`），它会一直等着不开工；入口挂完以后会打一行“插件 X 没开工：它要用的 Y 没人提供”。`bots` 写在用它的插件后面也能跑（试过），但先后会乱，还是写在最前面。
- 前台在 `bots` 里：问完 `bot/receive` 没人认领的，前台总会定下会话或处理掉，不用另挂管分派的插件。想换一种分派办法，写一个插件听 `bot/receive` 把 `event.session` 填上，前台就不接这条。

骨架自己读的配置：`providers`、`default_model`、`plugins`，和 `engine` 里的 `thinking`（新会话的思考档，默认 low）、`retry: { times, wait_ms, timeout_ms }`（默认 5、3000、120000）。会话不按步数限制，没有步数这一项。顶层的 `bots` 名单是插件 `bots` 读的，不写就是一个叫“助手”的机器人。

## 打印：看一条消息走过的路

挂上 `tutorial` 插件、配置写 `trace_console: true`，控制台上一步一行（`trace_file: true` 另写一份文件）。两种行，开头的字不一样，颜色也不一样：

- **函数**（青色）：代码一行行往下走到了哪。骨架和插件在关键的地方发一个跟踪点，这里打一行。
- **事件**（黄色）：发了哪个事件、现在有哪些插件在听。Cordis 每发一个事件都会自己报一声，不用谁去发。

```text
16:43:58.553 函数 Bots.receive │ 渠道收到一句话，存下来，推给机器人 │ bot.receive(message) │ 渠道=cli 机器人=助手 字数=5 │ src7/plugins/bots/index.ts:270
16:43:58.555 事件 bot/receive（挨个问）听的人： │ src7/plugins/bots/index.ts:419
16:43:58.559 函数 Bot.receive │ 消息交给这场会话，推它往下走 │ session.add(); session.run() │ 会话=2576b7eb 渠道=cli 字数=5 │ src7/plugins/bots/index.ts:440
16:43:58.562 事件 session/change（通知）听的人：bots、cli、context-fit │ 会话=2576b7eb 状态=running 回话= │ src7/Sessions.ts:635
16:43:58.569 事件 session/request（挨个问）听的人：bots、fake-model │ 会话=2576b7eb │ src7/Sessions.ts:490
16:43:58.571 函数 Session.loop │ 调模型 │ ctx.sessions.chat(request) │ 会话=2576b7eb 第几步=1 模型=… 对话几条=1 │ src7/Sessions.ts:266
```

- 函数那种行：模块.函数 │ 一句人话 │ 一句代码 │ 关键变量。一个跟踪点两行代码，`//T` 开头的注释标出来，写法见 `utils/Trace.ts`。
- 事件那种行：事件名（怎么发的）听的人，照挂上去的先后；会话的三个事件还顺带打出带着什么。“挨个问”“通知”就是上面「事件」一节说的两种发法。
- **每行最后是“文件:行号”**：哪一行代码发的这个跟踪点、这个事件。它是打印插件从调用栈里自动找的，发的人不用写。在 VS Code 的终端里按住 Ctrl 点它，能跳到那一行。
- 打印只看不改。拔掉 `tutorial` 或关掉 `trace_console`，骨架照常跑。

## 怎么跑

```text
bun src7/Main.ts [--data 运行时目录] [--bot 机器人] 现在几点了
```

- 不写 `--data` 时，运行时目录是 `src7/jmbotsData/`（程序旁边）。里面要有 `config.yaml`。
- 命令行渠道只做一件事：把命令行里带的那句话发出去，所有会话都停下来就退出。它不从键盘读输入；要一问一答地聊，以后另写专门的插件。
- 用哪个模型只看 `default_model`（已经开了的会话看它自己记的 `model`）。写的是真模型，就发给真模型。
- 离线跑：`plugins` 段里挂上 `fake-model`，`providers` 里加一家叫 `fake` 的（`base_url` 随便写，不会去连），`default_model` 写成 `fake/fake`。假模型第一步要调用 `time` 工具，第二步回一句“现在是……”。模型名不是 `fake/` 开头的会话，它不管。
- 离线测交办：话写成“调用 工具名 {JSON 参数}”，假模型就去调那个工具。比如 `bun src7/Main.ts --data 目录 "调用 hand_session {\"text\":\"帮我看看现在几点\"}"`，能看到前台转给后台会话、后台回话、写总结。
- **表结构改过**：以前跑出来的 `data/jmbots7.db`（连同 `-wal`、`-shm`）要先删掉，不然会报 `no such column: meta`。
- 类型检查（在仓库根目录，共享目录上大约 3 分钟）：

```text
node node_modules/typescript/bin/tsc -p tsconfig.src7.json --pretty false --noEmit --incremental false
```

不要把 `src7/**/*.ts` 并进根目录的 `tsconfig.json`：src7 和 src6 都在扩充 cordis 的 `Context`、`Events`，合在一起会打架。

## 给写代码的 AI

- `//M` 是主线，`//G` 是守卫，`//T` 是跟踪点。
- 骨架里不加兜底、不加重复的校验、不加转发层。要加功能就写成插件。**给骨架加事件、加函数，必须先跟用户说清楚、等他明确点头**，不能自己拿主意。
- `if` 里只有一句 `return` 的写成一行、不加大括号，后面空一行；上下两段不同的事之间用空行隔开。
- 代码约定见根目录 `CLAUDE.md` 和 `docs/TypeScript书写规范.md`。
- 不照 `src/`、`src6/` 抄；它们只是参考。
