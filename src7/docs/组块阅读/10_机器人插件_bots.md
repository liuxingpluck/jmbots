# 第十块：机器人插件 bots

读完这一块，你能讲清楚 5 件事：

1. 一个机器人怎么从 `config.yaml` 里的一行变成能收消息的对象；好几个机器人为什么不串台。
2. 一条消息为什么不会被同一个机器人回两遍。
3. 飞书群的三种模式 `mention`、`all`、`judge` 各是什么效果；`judge` 怎么攒一批再问要不要接；`judge_helper` 怎么把这一批悄悄转给外部助手（中控）。
4. 前台怎么派后台、后台的结果怎么回到前台、用户喊停以后怎么收场。
5. 在 bots 里本人和外人差在哪：记忆、派活、工作区、往别处发话。

要先读第二块（消息进来、认领、回执）和第三块（前台、后台、喊停）。第四块的“一问一答”读过更好：bots 里的 `bot/request`、`decision/judge`、`memory/request` 用的都是那一套。

> **bots 是什么**：骨架只管“一场会话怎么跑”。会话属于哪个机器人、话从哪个渠道来、回话往哪送，全是 bots 记在会话上的（`bots/index.ts:1` 文件头）。它是全仓库最大的插件，前台、派后台、群攒批、渠道工具、系统提示词都并在它里面。

## 一图看懂：一条消息在 bots 里走一圈

手机竖着看，从上往下读。

```
config.yaml 的 bots 段
   │ apply 校验一次
   ▼
Bots.add → new Bot
 建 workspace/、memory/
 登记工作区
   │
═══════ 跑起来以后 ═══════
渠道 emitInbound 发三种：
 ├ channel/direct  私聊
 ├ channel/mention 群里叫了
 └ channel/listen  群里没叫
   │
   ▼
Bots.onChannelMessage
 审批已经吃掉？→ 不管
 对 targetBots 每个机器人：
 ① 去重键 claimKey
 ② 只听的：标 listenOnly
 ③ 附件拷进 inbox
 ④ 挨个问 bot/receive
   ├ handled → 完
   ├ 填了 session（relay）
   │  查重 → deliver 交过去
   └ 没人管 ↓
 ⑤ claimChannelMessage
   ├ 找前台（渠道+账号+聊天）
   ├ 查重：重了 → duplicate
   ├ listenOnly：
   │  judge 群 → 群攒批
   │  别的群   → 记背景
   └ 排进前台队列 → 开跑
   │
   ▼
前台模型这一轮
 ├ 自己答 → channel_reply
 └ hand_session → 开 work
    后台跑完（session/change）
    returnWork 排回前台
    前台整理 → channel_reply
   │
   ▼
channel/reply → 渠道发出
→ channel/replied 回执
```

图里每一格下面都会讲到。①②④⑤ 在第二块里见过一面，这里讲透。

## 机制一：机器人怎么配出来、几个机器人怎么不串台

**一句话**：`config.yaml` 顶层的 `bots` 是一张名单，一项一个机器人；一个都不写，就是一个叫“助手”的（`utils/Bots.ts:12`）。启动时 `apply` 把配置校验一次，然后按固定的先后挂上四样东西：机器人服务、前台、派后台、渠道工具。

```ts
// src7/plugins/bots/index.ts
1214	  new Bots(ctx, { bots: [...written], thinking: config.thinking ?? 'medium' });
1215	  const desk = new FrontDesk(ctx, { recent, vision_model: vision });
1216	  new Dispatch(ctx, desk, batchConfig);
1217	  new ChannelTools(ctx);
```

**每个机器人建出来时做三件事**（`Bot` 的构造函数）：

```ts
// src7/plugins/bots/index.ts
1009	    //M 工作区和记忆目录放在运行时目录 bots/<机器人>/ 下，resources.ensureRuntimeDir 没有就建，返回绝对路径。
1010	    const workspace = botUtils.getBotDir(this.ctx.resources, this.name, 'workspace');
1011	    const memory = botUtils.getBotDir(this.ctx.resources, this.name, 'memory');
1012	    //M 建立配置机器人的默认工作区与记忆目录。
1013	    this.workspace = filesModule.ensureDir(workspace);
1014	    this.memory = filesModule.ensureDir(memory);
1015
1016	    //M 工作区原地登记，不搬不删：默认的 bots/<机器人>/workspace/。登记过的按目录认，重启不重登。
1017	    const workspaces = this.ctx.workspaces;
1018	    workspaces.ensureDefault(this.name);
```

- 运行时目录下 `bots/<机器人>/workspace/` 是它的工作区，`bots/<机器人>/memory/` 是它的记忆；
- 配置里 `workspaces` 登记的目录（比如源码仓库）也登记成工作区，只给本人用（`bots/index.ts:1029`）；
- 人设放 `bots/<机器人>/persona.md`，每一轮由系统提示词带上（`bots/Prompt.ts:139`）。

名字在 `Bots.add` 里校验：要非空、不能重名（`bots/index.ts:905`）。设置页运行中新建机器人，走的也是这个 `add`，所以加完马上能收消息。

**几个机器人为什么不串台**：有三把锁。

1. **认领按机器人一个个来**：一条消息的 `targetBots` 里有几个机器人，就各认领一次，各进各的会话。
2. **前台按“机器人 + 渠道 + 账号 + 聊天”找**：先只列这个机器人自己的前台，三样全对上才算同一场。

```ts
// src7/plugins/bots/FrontDesk.ts
159	    //M 先列出这个机器人所有的前台对话，下面按来源域逐个比对。
160	    const fronts = this.ctx.sessions.find({ bot, kind: 'front' });
161	    const exact = fronts.find((row) => {
162	      const s = row.sourceScope;
163	      if (s === undefined) return false;
164
165	      return s.channel === scope.channel && s.accountId === scope.accountId && s.chatId === scope.chatId;
166	    });
```

   老前台没有记来源范围、要按客户号沿用时，还要求飞书应用号一致（`FrontDesk.ts:178`），不会串到别的飞书应用。
3. **后台只认自己的**：前台要碰一场后台（停它、接着做），先过 `getDenied`（`DispatchTools.ts:479`）：要是本机器人的、本客户的；不是本人的话，还得是他自己派的。

**类比**：一家医院几位门诊医生。每人有自己的诊室（工作区）、自己的病历柜（记忆）、自己的胸牌和说话风格（人设）。病人按“哪位医生 + 哪个窗口 + 哪个号”分诊，不会被叫进别人的诊室。

## 机制二：认领与去重——同一条为什么不会回两遍

**一句话**：每个机器人收每条消息，都先算一把去重键 `claimKey`，就是 `[消息号, 机器人名]` 拼成的字符串（`channels/Message.ts:311`）。这把键记在认领它的那场会话上（`sourceClaims`）。渠道把同一条重发一次，键已经在了，就记成 `duplicate`，不再排队。

**代码里**：查重只有一个函数 `isClaimed`：`sourceClaims` 里记过，或者队列里已经排着，都算认领过。

```ts
// src7/plugins/bots/DispatchClaim.ts
14	/**
15	 * 这场会话是不是已经认领过这条消息（已记在 sourceClaims 或已在 resultQueue 里）。
16	 * @param session 目标会话（前台或别的插件认领的会话）。
17	 * @param claimKey 去重认领键（普通消息是 claimKey，群攒批接话是 `${claimKey}:batch`）。
18	 * @returns 已经认领过是 true。
19	 */
20	export function isClaimed(session: Session, claimKey: string): boolean {
21	  const claimedList = session.row.sourceClaims ?? [];
22	  if (claimedList.includes(claimKey)) return true;
23
24	  const queue = session.row.resultQueue ?? [];
25	  return queue.some((item) => item.claimKey === claimKey || item.key === claimKey);
```

前台认领时这样用：

```ts
// src7/plugins/bots/DispatchClaim.ts
115	    //G 同一条消息对该机器人已经认领过（sourceClaims 或 resultQueue 已记）→ 返回 duplicate，不再重复入队。
116	    if (isClaimed(front, claimKey)) {
117	      pushClaim(control, bot.name, claimKey, 'duplicate', front);
118	      return;
119	    }
```

要点：

- **键和队列项一起写**：`persistClaim`（`DispatchClaim.ts:223`）在一个数据库事务里同时写“已认领”和“排进队列”。中间出错就整个回滚，内存里也还原，再把错误抛给渠道。所以不会出现“记了已认领、却没排上队”，那样这条消息就丢了。
- **只留最近 200 把**：`rememberClaim`（`DispatchClaim.ts:33`），上限是 `CLAIM_HISTORY_MAX`（`DispatchClaim.ts:12`）。
- **认领结论写回给渠道**：每个机器人的结论（`claimed`、`duplicate`、`handled`、`listen`、`relay`）都由 `pushClaim`（`DispatchClaim.ts:46`）写进 `control.claims`，飞书照它记来往流水。
- **三处查重共用这一个函数**：前台认领（`DispatchClaim.ts:116`）、群攒批接话（`DispatchClaim.ts:271`）、relay 这类插件在 `bot/receive` 里认领走的会话（`bots/index.ts:668`），条件完全一样。

**两个机器人呢？** 键里带机器人名，所以两个机器人各回一遍，这是对的：群里 @ 了两个，两个都该答。“不回两遍”说的是同一个机器人。

**类比**：挂号单上印着“病人号 + 医生名”。同一张单子拿来第二次，窗口一看号已经挂过，就不再排；挂两位医生是两张单子，各看各的。

## 机制三：群聊模式——`mention`、`all`、`judge` 和攒批

**一句话**：飞书每个群在配置里写 `listen`，三选一，不写就是 `mention`（`feishu/Config.ts:271`）。叫没叫机器人、叫了哪个，由飞书算好；bots 只照它给的 `targetBots` 和事件名办事。

```ts
// src7/plugins/feishu/Inbound.ts
545	    //M 群里谁都没叫：登记了全量监听（all、judge）的群，本应用的机器人都记背景或判断要不要接。
546	    const canListen = registered?.listen === 'all' || registered?.listen === 'judge';
547	    if (canListen) return { targetBots: [...allowedBots], called: false };
548
549	    //M 没登记的群：谁都不投，照样发 channel/listen 给记录类插件记。
550	    return { targetBots: [], called: false };
```

| 模式 | 群里没叫机器人的话 | bots 收到后 |
|---|---|---|
| `mention` | `targetBots` 是空的 | 谁都不进（记录类插件照样记） |
| `all` | 本应用的机器人全收，走 `channel/listen` | 记进前台当背景，不回 |
| `judge` | 同上，地址上多标 `judge` | 进群攒批，攒一批问要不要接 |

叫了机器人（@ 它、引用它的话）的，三种模式都一样：走 `channel/mention`，正常回。

**只听的话在 bots 里怎么走**：`onChannelMessage` 在这个机器人的地址副本上标 `listenOnly`（`bots/index.ts:622`）。认领时看到这个标记就不跑这一轮（`DispatchClaim.ts:122`），交给 `claimListen`：先问群攒批收不收（`DispatchClaim.ts:162`），不收就记成前台背景。

**`judge` 群的攒批**（`GroupBatch.ts`）：每个“机器人 + 群”攒一批，两个触发满足一个就看一次：

```ts
// src7/plugins/bots/GroupBatch.ts
293	    //M 触发二：攒满 max_lines 句，马上看。
294	    if (batch.heard.length >= config.max_lines) {
295	      void this.look(front.id);
296	      return true;
297	    }
298
299	    //M 触发一：从这句起安静满 quiet_seconds 秒再看；再来一句就重新数。
300	    const waitMs = config.quiet_seconds * 1000;
301	    batch.timer = setTimeout(() => {
302	      void this.look(front.id);
303	    }, waitMs);
304	    return true;
```

- 到点时前台正在转，就等这一轮停下再看（`GroupBatch.ts:380`）；
- 每群每天最多看 `daily_limit` 次，看满了这一批只记背景（`GroupBatch.ts:396`）；
- “看”就是发请求事件 `decision/judge` 问决策模型（`GroupBatch.ts:550`）。没挂决策插件、出错，一律按不接（`GroupBatch.ts:559`）；
- 中途有人叫了机器人，攒着的这批会被拿走，拼在叫它的那句前面（`DispatchClaim.ts:129`），机器人能看到前情。

**判定要接以后，分两条路**：

```ts
// src7/plugins/bots/GroupBatch.ts
437	    //M 群登记了 judge_helper：这一批记进前台当背景，再转给那个外部助手，不由机器人自答。
438	    const judgeHelper = utils.getStringField(source.botOrigin.address, 'judgeHelper').trim();
439	    if (judgeHelper !== '') {
440	      this.keep(front, batch.heard);
441	      await this.claims.relayBatch(front, source, replyText, judgeHelper);
442	      return;
443	    }
444
445	    //M 其余消息仍以整批排入前台。
446	    this.claims.enqueueBatch(front, source, replyText);
```

- 群没登记 `judge_helper`：`enqueueBatch`（`DispatchClaim.ts:264`）把这一批照最后一句排进前台，机器人自己答；
- 群登记了 `judge_helper`（飞书把它写进地址的 `judgeHelper`，`feishu/Inbound.ts:559`）：这一批先记成前台背景，再由 `relayBatch`（`DispatchClaim.ts:300`）拼一条带 `relayHelper` 的收件，发一次 `bot/receive`。relay 认出 `relayHelper`，直接进外部助手的会话（`relay/index.ts:614`），机器人自己不开口。这就是“静默转中控”。
- `judge_helper` 启动时就核对：写错了、没开 relay、relay 的 helpers 里找不到这个名字，都直接报错、不让启动，不会悄悄落回默认助手。核对的函数是 `checkJudgeHelpers`（`GroupBatch.ts:207`），启动时在 `bots/index.ts:1212` 调用。

**类比**：护士站。`mention`：只有点名叫护士才过来；`all`：护士坐在旁边听、记在本子上，但不插嘴；`judge`：护士听一阵子，攒几句就想一想“要不要过去”，要过去的，要么自己去（自答），要么悄悄叫主任来（`judge_helper`）。

## 机制四：前台派后台与收尾

**一句话**：前台觉得要慢慢干，就调 `hand_session`（只给前台用，`DispatchTools.ts:89`）。它开一场 `kind: 'work'` 的后台，挂在前台下面，标 `quiet`；后台每跑完一轮，结果先排回前台的队列，由前台整理后再回给用户。

**派出去**：

```ts
// src7/plugins/bots/DispatchTools.ts
246	    const work = this.home.sessions.create({
247	      kind: 'work',
248	      bot: bot.name,
249	      parent: front.id,
250	      customer: front.row.customer,
251	      model: picked.model,
252	      thinking: picked.thinking,
253	      frontTask,
254	      quiet: true,
255	      workspaceId: resolved.workspace.id,
256	    });
257
```

然后 `bot.hand` 把话交进去、推它跑，不等（`DispatchTools.ts:265`）。`Bot.deliver`（`bots/index.ts:1064`）就三步：记回话往哪送、话进会话、`run`。

`quiet: true` 让 `Bots.onChange` 不把后台这一轮的回答直接发给用户（`bots/index.ts:423`）。

**结果回来**：后台一轮结束发 `session/change`，`DispatchResults.onChange`（`DispatchResults.ts:380`）等下一拍调 `returnWork`（`DispatchResults.ts:423`）：

```ts
// src7/plugins/bots/DispatchResults.ts
426	    //G 暂停（stop_session）、转给了别的会话（progress）→ 不交回。轮数变了 → 这一轮交回过了。
427	    if (task.paused || task.handedTo !== undefined || task.round !== round) {
428	      this.later(work);
429	      return;
430	    }
```

- 暂停了、转交给别的会话了、这一轮已经交回过（轮数变了）：都不交回；
- 否则结果键记成 `work:<后台号>:<第几轮>`，正文前面加一句怎么结束的，比如“（做完了）”“（出错了）”（`STATE_WORDS`，`DispatchResults.ts:166`）；排进前台队列，同一个事务里轮数加一。

**前台整理时用户又说话**：先排着，不进这一轮（`hold`，`DispatchResults.ts:346`；`Dispatch.ts:115` 调它）。整理那一轮里，`hand_session`、`stop_session`、`agent_task` 都被拿掉（`NO_DISPATCH`，`DispatchTools.ts:24`），免得前台整理着又派新活。

**用户喊停**：前台调 `stop_session`，实际是 `pause`（`DispatchTools.ts:373`）：

```ts
// src7/plugins/bots/DispatchTools.ts
395	    //M 受管：先存库记暂停（没在跑也记，免得排着的外部结果把它推起来），再喊停。已经做了的不回滚。
396	    task.paused = true;
397	    target.save();
398	    if (running) {
399	      target.stop('前台暂停');
400	    }
```

先存库记暂停，再喊停。记暂停是为了堵住三个口子：

- 这一轮的结果不再交回（上面 `returnWork` 的守卫）；
- 队列不再推它（`DispatchResults.ts:857`）；
- 万一被别的东西推起来（重启、排着的外部结果），调模型之前直接停掉（`DispatchTools.ts:620`）。

想接着做，前台用 `hand_session` 的 `append`，把 `paused` 改回 `false`（`DispatchTools.ts:337`）。停的只是这一轮，已经做的不回滚；回执里的 `inFlightMayBeFinishing` 提醒正在执行的工具可能还在收尾。

**类比**：门诊开单转住院部，住院部做完把报告送回门诊，由门诊医生跟病人讲。门诊正在写报告时病人又问了一句，护士先记下，写完再答。叫停就是在病历上盖“暂停”章再喊停：章盖着，报告不送回，谁也推不动它，要继续得重新开单（`append`）。

## 机制五：本人和外人——安全边界

**一句话**：是不是本人，全仓库只问一个函数 `isOwnerTurn`（`channels/Message.ts:399`）。地址上写了身份的，只有 `owner` 算本人；什么都没写的，只有本机网页、命令行和内部会话算本人，别的渠道一律当外人，宁严勿松。

```ts
// src7/plugins/channels/Message.ts
399	export function isOwnerTurn(channel: string | undefined, address: unknown): boolean {
400	  //M 地址上明确写了档位：只有 owner 算本人（builder、guest 不算）。
401	  const role = getSpeakerRole(address);
402	  if (role !== '') return role === 'owner';
403
404	  //G 只写了 owner: true（没写 role）：本人。owner: false 已在 getSpeakerRole 里变成 guest。
405	  if (utils.getField(address, 'owner') === true) return true;
406
407	  //M 什么都没写：没有渠道的内部会话、本机网页、命令行默认本人，其他渠道不写 owner 就是外人。
408	  if (channel === undefined) return true;
409
410	  return LOCAL_CHANNELS.has(channel);
411	}
```

bots 里用到它的地方：

| 方面 | 本人 | 外人（builder、guest、没写身份） |
|---|---|---|
| 前台“最近往来” | 带上（`FrontDesk.ts:331`） | 不带；翻历史也挡（`FrontDesk.ts:534`） |
| 派活挑模型、思考档 | 可以 | 不行，用前台的（`DispatchTools.ts:151`） |
| 停、接后台 | 本客户的都行 | 只能碰自己派的（`DispatchTools.ts:489`） |
| 工作区 | 机器人的全部工作区 | 地址里写的他自己的目录（`utils/Workspace.ts:20`） |
| 配置里登记的目录 | 能用 | 不能（`DispatchTools.ts:524`） |
| 往别的聊天发话 | 只在非群聊时可以 | 不行（`ChannelTools.ts:344`） |

- **记忆隔离**：读不读得到私人记忆看 `getMemoryAccess`（`memory/MemoryKey.ts:203`）。前台按这一轮的来源快照算，后台按派活那一刻的快照算，所以群里外人派的后台也拿不到本人的记忆。
- **附件也隔离**：外人发来的附件拷进他自己的工作区（`bots/index.ts:707`），不进机器人的公共工作区。
- **插件交办的活按外人算**：比如群日报（`bot/request` 带 `replyTo`），`handReply` 拼的消息写死 `role: 'guest'`、不受信（`bots/index.ts:548`）。

**类比**：医院的家属和本人。本人能看全部病历、能挑主治医生；家属只能看自己陪诊这次的单子，不能替病人挑医生，也不能把病历寄到别处。

## 常见踩坑

1. **群里没 @ 的话 bots 根本收不到**：群没登记，或者写的是 `mention`，`targetBots` 是空的（`feishu/Inbound.ts:550`）。想让机器人旁听，要写 `all` 或 `judge`。
2. **写了 `judge` 却从来不判断**：`group_batch` 的三个数（`quiet_seconds`、`max_lines`、`daily_limit`）缺一个就不开攒批，只在启动日志打一行（`bots/index.ts:1218`），`judge` 群退化成“只记”。
3. **攒着的一批和每天的次数都只在内存**（`GroupBatch.ts:11`）：重启丢掉攒着没判断的话（话本身照旧在记忆的渠道索引里），当天次数清零。
4. **新接的外部渠道不写身份就是外人**：地址里不写 `role` 或 `owner`，`isOwnerTurn` 判外人（`channels/Message.ts:410`），没记忆、不能挑模型。
5. **喊停以后结果不会回来**：`stop_session` 记了暂停，不是出错；要接着做，用 `hand_session` 的 `append`。

## 原来列的 3 处可理顺点：已在 bots 1.6.10 收官

第一版这一块列了 3 处可理顺的地方，用户拍板后已在 bots 1.6.10 全部改完：

1. **收话入口合成一个，前台只剩一种找法**（已收官）。
   - `Bots.receive`（`bots/index.ts:832`）现在也拼成一份标准消息，交给同一个 `onChannelMessage`（`bots/index.ts:855`）；原来的 `Bot.receive` 删了。
   - `FrontDesk.onReceive` 也改成按来源范围找前台，调 `findOrCreateFrontByScope`（`FrontDesk.ts:241`）。
2. **查重合成一个 `isClaimed`**（已收官）：见机制二，三处都调它。
3. **两行不合代码约定的改掉了**（已收官）。
   - `Bots.route` 取客户号改成一句 `utils.getStringField`（`bots/index.ts:954`），没有三目了；
   - `apply` 校验 `vision_model` 先把供应商名算进 `providerName`（`bots/index.ts:1198`），不再挤在一行。

## 读完自测

1. 群里同时 @ 了两个机器人，飞书又把这条重发了一次。一共会回几遍？为什么？
2. 一个 `judge` 群，大家闲聊了十几句，中间没人叫机器人。机器人什么时候会“想一想要不要接”？想完决定接，接下来分哪两种情况？
3. 前台派了一场后台，用户说“先别弄了”。后台这一轮的结果还会回到用户那里吗？以后想接着做怎么办？
4. 群里一位外人让机器人派后台去干活，这场后台能读到本人的私人记忆吗？能挑贵的模型吗？

<details>
<summary>答案</summary>

1. 两遍，每个机器人一遍。去重键是“消息号 + 机器人名”，两个机器人的键不同，各自认领；重发的那条，两个机器人的键都已经记过，都记成 `duplicate`，不再排队（`DispatchClaim.ts:116` 调 `isClaimed`）。
2. 两个触发满足一个就看：攒满 `max_lines` 句马上看，或者最后一句之后安静满 `quiet_seconds` 秒（`GroupBatch.ts:293` 起）；前台正在转就等它停下，当天看满 `daily_limit` 次就不看了。决定接以后：群没登记 `judge_helper`，机器人自己把这一批排进前台答；登记了，就记成背景、转给那个外部助手，机器人不开口（`GroupBatch.ts:437` 起）。
3. 不会。前台调 `stop_session`，后台先记 `paused = true` 再停（`DispatchTools.ts:396`），`returnWork` 看到暂停就不交回。想接着做，用 `hand_session` 的 `append`，它把 `paused` 改回 `false`。
4. 都不能。后台的记忆权限按派活那一刻的来源快照算，外人的快照拿不到本人记忆（`memory/MemoryKey.ts:142`）；外人派活时写了模型或思考档会被拒，只能用前台的（`DispatchTools.ts:151`）。

</details>

下一块：待中控在总览登记后续编号。
