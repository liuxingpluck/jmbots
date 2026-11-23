# src7：jmbots 第 7 版骨架

新人从这里读起。本目录的代码和这份说明不一样时，以代码为准。

- **先读**：`docs/组块阅读/00_总览.md`，骨架拆成 7 块，每块 4～5 个概念，读完一块再读下一块；
- **查词**：`docs/词汇表.md`（会话字段、“基地”的叫法、新人易卡的词）；
- **查插件**：`docs/插件地图.md`（每个插件干什么、用了谁、听和发哪些事件）；
- **逐行看骨架**：教程页 `/tutorial/` 的“骨架逐行”，数据在 `docs/骨架逐行/`；
- **规矩**：根目录 `CLAUDE.md`，规矩只留那一份。

## 一条规矩：骨架少之又少

- 骨架是本目录里 `plugins/` 以外的文件：`Main.ts`、`Resources.ts`、`Sessions.ts`、`Tools.ts` 四个，加 `utils/`。**只管一件事：一场会话怎么跑**，要一眼读得懂。
- 机器人、渠道、前台、分派、工作区这些业务都在插件里。`utils/` 里的 `Bots.ts`、`Workspace.ts` 只是从配置和会话记录里读值的纯函数，给好几个插件共用，不收事件、不管流程。
- 渠道协议在 `plugins/channels/`：一个**不挂服务的协议插件**，只放事件声明、标准数据结构和无状态小函数，渠道和 `bots` 直接 import 它。它不进 `plugins/Index.ts` 的 `BUILT_IN`，`config.yaml` 的 `plugins` 段也不写它。
- **主线全是直接调用**，按 F12 能一路跳到实现；**事件只留给插件接进来**。
- 各种业务功能都做成插件，以后也是往 `plugins/` 里加。给骨架加函数、加事件之前，先想能不能做成插件；真要加，只加最少的，并写清为什么插件做不了。
- 外面进来的东西只校验一次：命令行参数、`config.yaml` 在 `utils/Checks.ts`；模型给工具的参数在 `Tools.execute`；插件的配置在插件自己的 `apply`。别处不再查。

## 文件

```text
src7/
  Main.ts            入口：挂骨架 → 照 config.yaml 的 plugins 挂插件 → 发 ready → 接着跑没跑完的会话
  Resources.ts       资源：config.yaml、数据库、pi 的供应商、运行时目录下的文件夹
  Sessions.ts        会话：一份记录 + 一个循环，加上用 pi 发一次模型请求的 chat()。最重要的一个文件
  Tools.ts           工具：登记、报清单、执行
  utils/             通用的纯函数，和业务无关、几处共用
    Checks.ts        校验：命令行参数、config.yaml
    Bots.ts          从资源快照读机器人名单、每个机器人的配置和目录
    Workspace.ts     工作区路径（相对路径落成绝对路径，不许出工作区）、这一轮用哪个工作区、授权目录；说话的是谁由 plugins/channels/Message.ts 判
    index.ts         对象、数组的遍历和取字段（eachEntry、getField 这类）
    Text.ts          把抛出来的错收成一句话、格式化时间
    Trace.ts         跟踪点长什么样
    Trail.ts         跟踪行和轨迹的形状（journal、tutorial 共用）
    RequestEvent.ts  请求-回执事件：发一个请求事件，等对应的回执事件
    Mime.ts          按扩展名认文件类型
    Cut.ts           长文字截断：从头留、从尾留（最多 2000 行、50KB），按字数截
    Names.ts         安全文件名、20 位时刻号
    Card.ts          卡片数据：审批卡片、长跑提醒卡片共用（网页、飞书照同一份画）
    Files.ts         确保目录存在、原子写入文本
    Image.ts         从用户的话里找出 @图片路径
    Failure.ts       带状态码的错误，HTTP 接口里抛它
    BackendLog.ts    后端控制台错误加本机时间和源码来源
    Embedded.ts      编译进单个程序里的文件（网页、出厂提示词）
    SessionHelpers.ts  会话用的纯数据小工具：拼模型请求、拼存库的行，只给 Sessions.ts 用
    SourceDir.ts     源码根目录名
    Versions.ts      版本表（Versions.json）：程序跑 version 时打印
  plugins/
    Index.ts         插件的约定，和自带插件的名单 BUILT_IN
    channels/        渠道协议（不挂服务，见上）
    <名字>/          其余每个插件一个文件夹，index.ts 加同目录的 说明.md
```

插件清单、每个插件干什么、用了谁，看 `docs/插件地图.md`，那里的表由 `bun ztools/plugin-map/Gen_Plugin_Map.ts` 生成，这里不再抄一份。读“一条消息怎么走”要知道的几个：`bots`（机器人名单、认领消息、前台、派后台、系统提示词）、`workspaces`（工作区，写在 `bots` 前面）、渠道 `feishu`、`web-api`、`cli`、`wechat`。

依赖：骨架是 `resources` ← `tools` ← `sessions`；插件里 `workspaces` 用骨架，`bots` 用骨架和 `workspaces`，渠道、自带工具用 `bots`；渠道和 `bots` 直接 import `channels`。

骨架和 utils 的行数会随提交变，不在这里写死；要看就数 `wc -l src7/*.ts src7/utils/*.ts`。

## 一条消息怎么走

以飞书群里一条 @ 了机器人的普通消息为例。

1. **收到群消息。** `Feishu.start` 监听飞书的 `im.message.receive_v1`，交给 `FeishuInbound.onMessage` 按消息号去重。 [`Feishu.start` · `im.message.receive_v1` · src7/plugins/feishu/index.ts:649](plugins/feishu/index.ts#L649) · [`FeishuInbound.onMessage` · src7/plugins/feishu/Inbound.ts:163](plugins/feishu/Inbound.ts#L163)
2. **存好再分发。** `FeishuInbound.handleInboundMessage` 识别 @、引用和群设置，下载附件、存聊天日志，再由 `FeishuInbound.deliver` 发进来的事件。 [`FeishuInbound.handleInboundMessage` · src7/plugins/feishu/Inbound.ts:219](plugins/feishu/Inbound.ts#L219) · [`FeishuInbound.deliver` · src7/plugins/feishu/Inbound.ts:798](plugins/feishu/Inbound.ts#L798)
   - 进来的事件有三个，一条只发一个，由 `channels` 的 `emitInbound` 按 `getInboundEvent` 分：私聊 `channel/direct`，群里 @ 或引用了机器人 `channel/mention`（这一例），没叫机器人 `channel/listen`。 [`getInboundEvent` · src7/plugins/channels/Message.ts:263](plugins/channels/Message.ts#L263) · [`emitInbound` · src7/plugins/channels/Message.ts:280](plugins/channels/Message.ts#L280)
3. **审批先看是不是批复。** `Approval.onChannelMessage` 听 `channel/direct`、`channel/mention`，抢在机器人前读进来的消息，有权处理的“同意 3”之类指令只消费一次并直回，普通消息继续分派。 [`Approval.onChannelMessage` · src7/plugins/approval/index.ts:1173](plugins/approval/index.ts#L1173)
4. **逐个机器人找会话。** `Bots.onChannelMessage` 给每个目标机器人准备附件并发 `bot/receive`，让 relay 等插件先认领，其余普通消息交前台。 [`Bots.onChannelMessage` · src7/plugins/bots/index.ts:590](plugins/bots/index.ts#L590) · [`Bots.onChannelMessage` · `bot/receive` · src7/plugins/bots/index.ts:647](plugins/bots/index.ts#L647)
5. **把话排进前台。** `DispatchClaim.claimChannelMessage` 按渠道、账号、聊天找这台机器人的前台，去重后保存消息和原回话地址，由 `DispatchResults.startQueuedUser` 在轮到它时调用 `Session.queueUserMessage` 和 `Session.run`。 [`DispatchClaim.claimChannelMessage` · src7/plugins/bots/DispatchClaim.ts:94](plugins/bots/DispatchClaim.ts#L94) · [`DispatchResults.startQueuedUser` · src7/plugins/bots/DispatchResults.ts:920](plugins/bots/DispatchResults.ts#L920)
6. **调模型前。** `Session.getStepAnswer` 发 `session/before-model`，让插件调整提示词和工具清单，`approval` 按说话人筛工具，随后由 `Sessions.chat` 发出请求（插件已经给出回答或要求停下时跳过）。 [`Session.getStepAnswer` · `session/before-model` · src7/Sessions.ts:697](Sessions.ts#L697) · [`Approval.constructor` · `session/before-model` · src7/plugins/approval/index.ts:476](plugins/approval/index.ts#L476) · [`Sessions.chat` · src7/Sessions.ts:477](Sessions.ts#L477)
7. **模型回答后。** `Session.getStepAnswer` 发 `session/after-model`，插件可以改回答或停止这一轮，放行的回答接进对话时由 `Session.append` 发 `session/new-message`。 [`Session.getStepAnswer` · `session/after-model` · src7/Sessions.ts:719](Sessions.ts#L719) · [`Session.append` · `session/new-message` · src7/Sessions.ts:782](Sessions.ts#L782)
8. **执行工具前。** `Tools.execute` 发 `session/before-tool`，`approval` 按当前说话人复核工具权限并可用 `gate.deny` 拦下单次调用，放行后才校验参数并执行。 [`Tools.execute` · `session/before-tool` · src7/Tools.ts:187](Tools.ts#L187) · [`Approval.constructor` · `session/before-tool` · src7/plugins/approval/index.ts:481](plugins/approval/index.ts#L481)
9. **回复发回飞书。** 模型调用 `channel_reply` 时，`ChannelTools.runReply` 经 `requestChannelReply` 发 `channel/reply` 并等 `channel/replied`；`FeishuReply.onChannelReply` 按账号、聊天向原群发纯文字，交回带着原请求的 `channel/replied` 回执。 [`ChannelTools.runReply` · src7/plugins/bots/ChannelTools.ts:172](plugins/bots/ChannelTools.ts#L172) · [`requestChannelReply` · src7/plugins/channels/Reply.ts:196](plugins/channels/Reply.ts#L196) · [`FeishuReply.onChannelReply` · src7/plugins/feishu/Reply.ts:74](plugins/feishu/Reply.ts#L74)
10. **工具交回结果后。** `Session.loop` 发 `session/after-tool` 让插件看结果并存进对话，继续执行这一批工具，轮次还在运行时再回第 6 步。 [`Session.loop` · `session/after-tool` · src7/Sessions.ts:672](Sessions.ts#L672)
11. **这一轮收尾。** 模型没再要工具时，`Session.change` 存好结果并发 `session/change`，`DispatchResults.onChange` 接手，按回复回执收尾后发 `bot/settled` 并推进队列。 [`Session.change` · src7/Sessions.ts:790](Sessions.ts#L790) · [`DispatchResults.onChange` · src7/plugins/bots/DispatchResults.ts:380](plugins/bots/DispatchResults.ts#L380) · [`DispatchResults.emitSettled` · src7/plugins/bots/DispatchResults.ts:749](plugins/bots/DispatchResults.ts#L749)

群里没叫到机器人时发 `channel/listen`：登记了 `listen: all` 的群记作背景，`listen: judge` 的群交给决策模型判断要不要接话，没登记的群谁都不进、只给记忆等记录类插件记。 [`FeishuInbound.getTargets` · src7/plugins/feishu/Inbound.ts:516](plugins/feishu/Inbound.ts#L516) · [`FrontDesk.listen` · src7/plugins/bots/FrontDesk.ts:263](plugins/bots/FrontDesk.ts#L263)

**所有发出去的话一律走 `channel/reply` → `channel/replied`**：模型的 `channel_reply`、一轮结束的自动回话、后台结果、relay 回信、审批直回都一样。渠道只向 `bots` 登记自己的名字（`ctx.bots.channel(名字)`，给网页列渠道用），不登记发送函数；收话就发进来的事件。 [`Bots.channel` · src7/plugins/bots/index.ts:807](plugins/bots/index.ts#L807) · [`Bots.send` · src7/plugins/bots/index.ts:766](plugins/bots/index.ts#L766)

`exec` 工具多一道命令审批。`Exec.onTool` 发 `approval/request` 并等 `approval/result`，放行后才执行命令，需要用户点头时转待确认。 [`Exec.onTool` · src7/plugins/exec/index.ts:266](plugins/exec/index.ts#L266) · [`requestReview` · `approval/request` · src7/plugins/exec/Runs.ts:103](plugins/exec/Runs.ts#L103)

飞书前台一轮正常结束且零次调用回复工具时，`DispatchResults.finishChannelFront` 只加跑一轮，提醒模型调用 `channel_reply`。 [`DispatchResults.finishChannelFront` · src7/plugins/bots/DispatchResults.ts:578](plugins/bots/DispatchResults.ts#L578) · [`FrontDesk.onRequest` · src7/plugins/bots/FrontDesk.ts:304](plugins/bots/FrontDesk.ts#L304)

### 网页、微信和命令行从哪里进

这三个渠道都经 `emitInbound` 发进来的事件：网页、命令行是私聊，发 `channel/direct`；微信私聊发 `channel/direct`、群里 @我 发 `channel/mention`。

- **网页**的 `POST /api/message` 由 `WebApi.accept` 存入时间线并发 `channel/direct`，指定或引用会话时带已校验的会话号。回话由 `WebApi.replyDirect` 追加到原网页消息。 [`WebApi.accept` · src7/plugins/web-api/index.ts:387](plugins/web-api/index.ts#L387) · [`WebApi.emitChannelMessage` · `channel/direct` · src7/plugins/web-api/index.ts:182](plugins/web-api/index.ts#L182) · [`WebApi.replyDirect` · src7/plugins/web-api/index.ts:653](plugins/web-api/index.ts#L653)
- **微信**的 `Wechat.store` 存好监听到的新消息后，把需要回复的消息发成 `channel/direct` 或 `channel/mention`。`Wechat.deliverOrDraft` 把回话放进发件表，按设置直发、待确认或留草稿。 [`Wechat.store` · src7/plugins/wechat/index.ts:384](plugins/wechat/index.ts#L384) · [`Wechat.store` · `channel/direct` · src7/plugins/wechat/index.ts:475](plugins/wechat/index.ts#L475) · [`Wechat.deliverOrDraft` · src7/plugins/wechat/index.ts:700](plugins/wechat/index.ts#L700)
- **命令行**的 `Cli.submitLine` 存好原始输入后发 `channel/direct`，回话逐条打印。 [`Cli.submitLine` · src7/plugins/cli/index.ts:135](plugins/cli/index.ts#L135) · [`Cli.constructor` · src7/plugins/cli/index.ts:72](plugins/cli/index.ts#L72)

这三个渠道的普通前台消息都用 `channel_tool`，并设置 `routing.autoFinal`，一轮正常结束且零次调用回复工具时，由 `DispatchResults.sendLastWords` 把 `row.reply` 经 `channel/reply` 发出。 [`WebApi.accept` · src7/plugins/web-api/index.ts:387](plugins/web-api/index.ts#L387) · [`Wechat.store` · src7/plugins/wechat/index.ts:384](plugins/wechat/index.ts#L384) · [`Cli.submitLine` · src7/plugins/cli/index.ts:135](plugins/cli/index.ts#L135) · [`DispatchResults.sendLastWords` · src7/plugins/bots/DispatchResults.ts:704](plugins/bots/DispatchResults.ts#L704)

### legacy_auto 还在哪里用

`legacy_auto` 是兼容的自动回话方式：一轮结束时把 `row.reply` 发回原渠道，模型不用调 `channel_reply`。旧式会话结束时，`Bots` 的 `session/change` 监听器调 `Bots.send`，照会话记的渠道和地址发 `channel/reply`；后台结果队列走这种方式时，由 `DispatchResults.finishFront` 发回原渠道。 [`Bots.constructor` · `session/change` · src7/plugins/bots/index.ts:382](plugins/bots/index.ts#L382) · [`DispatchResults.finishFront` · src7/plugins/bots/DispatchResults.ts:501](plugins/bots/DispatchResults.ts#L501)

`ctx.bots.receive` 只剩微信客服页点“让 AI 回复”起草时在用。网页直投非前台会话、relay 直接认领会话也走兼容自动回话；后台派活或结果没有继承到 `channel_tool` 来源时默认用 `legacy_auto`。 [`Wechat.draftReply` · src7/plugins/wechat/index.ts:811](plugins/wechat/index.ts#L811) · [`DispatchTools.getPlan` · src7/plugins/bots/DispatchTools.ts:184](plugins/bots/DispatchTools.ts#L184) · [`DispatchResults.getResultItem` · src7/plugins/bots/DispatchResults.ts:282](plugins/bots/DispatchResults.ts#L282)

## 事件

骨架发的：

| 事件 | 怎么发 | 什么时候 | 响应的人干什么 |
|---|---|---|---|
| `session/before-model` | 挨个问 | 关口一：每一步调模型之前 | 改这一步的请求：往 `system` 里加提示词；换掉 `messages`（压缩、检索、拼最近往来）；改 `tools`、`model`、`thinking`；直接填 `answer`（假模型）；在 `request.stop` 写理由：不调模型，这一轮停下 |
| `session/after-model` | 挨个问 | 关口二：模型回来之后、回答接进对话之前 | 看、改、换 `request.answer`（接进对话的是最后这一份）；在 `request.stop` 写理由：这次回答不要了，里面要的工具也不执行，这一轮停下 |
| `session/before-tool` | 挨个问 | 关口三：每个工具执行之前 | 把关：只拦这一个，在 `gate.deny` 里写上理由（给模型看，会话接着走）；在 `gate.stop` 写理由：这个和这一批后面的工具都不执行，这一轮停下 |
| `session/after-tool` | 挨个问 | 关口四：每个工具执行完、结果接进对话之前（没执行、被 deny 拦下的也走） | 改 `done.outcome`（文字、图片、是否出错）；在 `done.stop` 写理由：结果照样接进对话（要和工具调用配对），这一批后面的工具不执行，这一轮停下 |
| `session/new-message` | 通知 | 对话里新接了一条 | 记往来；将来的界面、流水 |
| `session/change` | 通知 | 状态变了 | 渠道回话；记往来；写总结 |
| `session/model-failed` | 通知 | 模型请求失败了一次（重试的每一次都算） | model-catalog 记用量、限流时换模型；journal 记进流水 |
| `ready` | 通知 | 骨架已挂好，配置的插件已逐一尝试挂载 | 命令行渠道发出命令行里带的消息，bots 检查归档服务 |
| `trace` | 通知 | 骨架和插件走到关键的地方 | journal 记进流水；tutorial 开了 `trace_console` 就打印一行 |

插件 `bots` 发的（不是骨架的事件）：

| 事件 | 怎么发 | 什么时候 | 响应的人干什么 |
|---|---|---|---|
| `bot/receive` | 挨个问 | 每个目标机器人认领前 | 分派插件可填 `event.session` 指定会话，或设 `handled` 表示已经处理；其余进机器人前台 |

- **关口**：上面四个挨个问的事件是会话每一步的关口。数据都带 `SessionGate { session; stop? }`（`Sessions.ts`）：`session/before-model`、`session/after-model` 用 `ChatRequest`（after-model 是带上 `answer` 的 `AnsweredRequest`），两个工具关口用 `Tools.ts` 的 `ToolGate`、`ToolDone`。谁在 `stop` 里写了理由，会话就 `session.stop(理由)` 停下，不往下走。
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
- 模型请求出错：`Sessions.chat()` 里照 `models.retry` 重试，试够了还不成，这一轮就是 `failed`。工具出错不算会话出错，原因当成工具结果给模型看。
- 重启：入口把库里还是 `running` 的会话各调一次 `run()`，从存下来的对话接着走。

### 库里的表 `sessions`

`sessions` 存所有会话（前台、后台、小会话）；一行是一场会话，记录拆两块存：对话一块，别的项一块。

| 列名 | 类型 | 能不能空 | 意思 | 谁写、什么时候写 |
|---|---|---|---|---|
| `id` | TEXT PRIMARY KEY | 否（主键） | 会话号：本地时刻 17 位 + 3 位随机，共 20 位数字（旧的 8 位十六进制号照样能开） | `Session.save`，`Sessions.create` 新开时先查重再存 |
| `meta` | TEXT NOT NULL | 否 | 记录去掉 `messages` 后的 JSON：骨架的 id、kind、parent、model、thinking、state、reply、updatedAt，加插件声明的项（如 bot、channel、address、customer、summary、frontTask、resultQueue 等）；`sessions.find` 照它里面的项找 | `Session.save`：新开（`create`）、接进一条消息（`append`）、改状态（`change`）时，以及插件改完 `row` 自己调 `save()` 时；每次整行 INSERT OR REPLACE，`updatedAt` 改成当时 |
| `messages` | TEXT NOT NULL | 否 | 整场对话 JSON（pi 的 Message 数组） | 同上 |

依据：`Sessions.ts` 里建 `sessions` 表的那段；写在 `Session.save`（`create`、`append`、`change` 调它）。

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
  // ctx.on('session/before-model', (request) => { request.system.push('……'); });
  // ctx.tools.register({ definition, kinds: ['work'], run: (args, session, signal) => '……' });
}
```

- 这和 Cordis、DSH 的插件约定是同一套。拔掉插件时不用自己收拾：通过 `ctx` 登记的监听和工具会自动撤掉。
- 业务代码照旧写成 class，`apply` 里 `new` 出来就行，看 `plugins/cli/index.ts`。
- 工具的停止信号：`run(args, session, signal)` 的第三个参数是 `AbortSignal`，网页、飞书点停止时触发。要等很久的工具（搜索、生图、`exec`、子任务）把它交给 `fetch(url, { signal })`、`spawn(cmd, { signal })`，或者 `signal.addEventListener('abort', …)` 自己断开并抛错；骨架把这时抛的错记成“已停止”。写文件、替换文字这类快工具不用管它，老工具不写第三个参数也行。
- 插件能做的事：听上面的事件；调 `ctx.tools.register()` 登记工具；做一个新渠道（见下面“接一个别人写的”）；开一场小会话再问一次模型（看 `plugins/context-fit/Summary.ts`）；给会话的记录加自己的项；自己提供一个服务给别的插件用（看 `plugins/bots/index.ts`）。
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
- 外部的渠道插件：用 `ctx.bots.channel(渠道名)` 登记名字；收到话拼成 `plugins/channels/` 的标准消息，调 `emitInbound` 发进来的事件（私聊 `channel/direct`、群里叫了机器人 `channel/mention`、没叫 `channel/listen`）；听 `channel/reply`，认出是自己的就发出去，再回 `channel/replied`（纯文字渠道可直接用 `channels/TextReply.ts`）；附件调 `ctx.bots.saveFile`。
- **还没验证**：编译成单文件的 jmbots 能不能在运行时 `import()` 磁盘上的 `index.ts`。

### config.yaml 怎么写

完整样例在根目录 `config.example.yaml` 的 `plugins` 段，每个自带插件一项、带注释，这里不再抄一份。

- 照写的先后挂；这个先后也是 `session/before-model` 挨个问的先后。`tutorial` 写第一个（要录启动），`workspaces`、`bots` 写在用它们的插件前面，`model-catalog` 放最后。
- 不写 `plugins` 段时，挂 `workspaces`、`bots`、`cli`、`file-tools`、`context-fit` 五个（`utils/Checks.ts` 的 `DEFAULT_PLUGINS`）。
- `disabled: true` 是先不挂。找不到、起不来的插件打一行原因，不挡别的插件。
- 一个插件要用的服务没人提供（比如没挂 `bots`），它会一直等着不开工；入口挂完以后会打一行“插件 X 没开工：它要用的 Y 没人提供”。
- 前台在 `bots` 里：问完 `bot/receive` 没人认领的，前台总会定下会话或处理掉，不用另挂管分派的插件。想换一种分派办法，写一个插件听 `bot/receive` 把 `event.session` 填上，前台就不接这条。
- 别人写的插件：`name` 写文件夹路径，相对路径从运行时目录算。

骨架自己读的配置：`providers`、`default_model`、`plugins`，和 `models` 里的 `thinking`（新会话的思考档，默认 low）、`retry: { times, wait_ms, timeout_ms }`（默认 5、3000、120000）。会话不按步数限制，没有步数这一项。顶层的 `bots` 名单是插件 `bots` 读的，不写就是一个叫“助手”的机器人。

## 打印：看一条消息走过的路

挂上 `tutorial` 插件、配置写 `trace_console: true`，控制台上一步一行（`trace_file: true` 另写一份文件）。两种行，开头的字不一样，颜色也不一样：

- **函数**（青色）：代码一行行往下走到了哪。骨架和插件在关键的地方发一个跟踪点，这里打一行。
- **事件**（黄色）：发了哪个事件、现在有哪些插件在听。Cordis 每发一个事件都会自己报一声，不用谁去发。

```text
16:43:58.553 函数 Cli.submitLine │ 命令行收到一句话，发出 channel/direct │ protocol.emitInbound(ctx, msg, true, control) │ 机器人=助手 序号=1 字数=5 │ src7/plugins/cli/index.ts:158
16:43:58.555 事件 channel/direct（挨个问）听的人：approval、bots │ src7/plugins/channels/Message.ts:298
```

命令行先发跟踪点，再经 `emitInbound` 发 `channel/direct` 入站。时间和变量为示例，监听者随所挂插件变化。 [跟踪点 · `Cli.submitLine` · `trace` · src7/plugins/cli/index.ts:158](plugins/cli/index.ts#L158) · [入站事件 · `Cli.submitLine` · `emitInbound` · src7/plugins/cli/index.ts:195](plugins/cli/index.ts#L195)

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
- 类型检查（在仓库根目录）：`bun run typecheck:src7`，查后端和网页。

## 给写代码的 AI

规矩只留一份，在根目录 `CLAUDE.md`（编码原则、代码约定）。跟踪点用 `//T` 开头的注释标出来，写法见 `utils/Trace.ts`。
