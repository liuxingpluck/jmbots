/**
 * 教程页「糖葫芦 + 列间事件菱形」插件架构画布静态拓扑与 9 步飞书消息旅程数据。
 * 所有插件名、Cordis 事件名、TypeScript 载荷字段与源码路径均严格对齐 src7 真实代码。
 */

/** 链路快捷筛选类别。 */
export type TanghuluFilterKey = 'all' | 'inbound' | 'gates' | 'memory' | 'outbound';

/** 糖葫芦纵列样式键。 */
export type TanghuluColKey = 'col-ch' | 'col-bot' | 'col-sk' | 'col-mem';

/** 菱形事件颜色主题键。 */
export type DiamondColorKey = 'ev-amber' | 'ev-emerald' | 'ev-rose' | 'ev-violet' | 'ev-cyan';

/** 载荷源码高亮片段的一行或一段 token。 */
export interface SchemaToken {
  /** token 类别：普通文本、关键字、类型名、属性名、注释。 */
  kind: 'plain' | 'kw' | 'type' | 'prop' | 'cmt';
  /** 显示文本。 */
  text: string;
}

/** 画布中单个节点（糖葫芦职责节点或列间事件菱形）的完整定义。 */
export interface TanghuluNodeSpec {
  /** 节点唯一 ID。 */
  id: string;
  /** 节点几何类型：糖葫芦圆角模块 或 列间事件菱形。 */
  type: 'tanghulu' | 'diamond';
  /** 糖葫芦所属列（仅 tanghulu 节点使用）。 */
  col?: TanghuluColKey;
  /** 糖葫芦山楂球序号（1~5，仅 tanghulu 节点使用）。 */
  num?: string;
  /** 菱形配色类别（仅 diamond 节点使用）。 */
  color?: DiamondColorKey;
  /** 舞台 X 坐标（diamond 节点显式指定，tanghulu 节点由所属列决定）。 */
  x?: number;
  /** 舞台 Y 坐标。 */
  y: number;
  /** 菱形顶部方向胶囊文案（仅 diamond 节点使用）。 */
  dirText?: string;
  /** 节点主标题（中文不截断标题或 ◇ 事件名）。 */
  title: string;
  /** 菱形内部副标题（真实斜杠事件名简写）。 */
  sub?: string;
  /** 糖葫芦底部首枚源码文件胶囊标签。 */
  fileTag?: string;
  /** 糖葫芦卡片两行职责简介。 */
  desc?: string;
  /** 糖葫芦卡片底部附加胶囊。 */
  chips?: readonly string[];
  /** 底部白话讲透面板顶栏显示的分类标签。 */
  kindLabel: string;
  /** 一句话人话讲透说明。 */
  human: string;
  /** 真实 Cordis 事件名清单。 */
  realEvents: string;
  /** 事件派发机制说明（ctx.serial / ctx.emit / requestEvent 等）。 */
  dispatchMode: string;
  /** 谁发出该事件或调用该模块。 */
  senders: string;
  /** 谁监听该事件或接收输出。 */
  listeners: string;
  /** 真实 TypeScript 接口或类型名。 */
  typeName: string;
  /** 真实 TypeScript 字段结构代码文本。 */
  schemaText: string;
  /** 对应 src7 真实源码目录与行号。 */
  sourceDir: string;
  /** 核心导出或内部函数清单。 */
  keyFunctions: string;
  /** 登记的模型工具或 HTTP 路由。 */
  toolsOrRoutes: string;
}

/** 节点之间的有向事件连线定义。 */
export interface TanghuluEdgeSpec {
  /** 连线唯一 ID。 */
  id: string;
  /** 起点节点 ID。 */
  from: string;
  /** 终点节点 ID。 */
  to: string;
  /** 连线颜色。 */
  color: string;
  /** SVG 箭头 marker ID。 */
  marker: 'th-arrow-amber' | 'th-arrow-emerald' | 'th-arrow-rose' | 'th-arrow-violet' | 'th-arrow-cyan';
  /** 起止坐标 [x1, y1, x2, y2]。 */
  pts: readonly [number, number, number, number];
  /** 所属快捷滤镜分类列表。 */
  tags: readonly Exclude<TanghuluFilterKey, 'all'>[];
  /** 跨第 3 列走廊 Y 坐标（避免穿过第 3 列卡片文字）。 */
  viaCorridor?: number;
}

/** 「一条飞书消息的完整旅程」单步剧本定义。 */
export interface TanghuluJourneyStep {
  /** 步骤序号 1~9。 */
  step: number;
  /** 顶部步骤条短标题。 */
  label: string;
  /** 当前步主聚焦节点 ID（同步更新底部白话讲透面板）。 */
  focusNode: string;
  /** 当前步点亮的节点 ID 列表。 */
  activeNodes: readonly string[];
  /** 当前步点亮的连线 ID 列表。 */
  activeEdges: readonly string[];
  /** 当前步实时消息与事件流转字幕。 */
  liveMsg: string;
}

/** 20 个糖葫芦纵列节点 + 8 个列间事件菱形 = 28 个交互节点。 */
export const TANGHULU_NODES: Readonly<Record<string, TanghuluNodeSpec>> = {
  // -------------------- COLUMN 1: CHANNELS (抽象渠道层) --------------------
  'ch-1': {
    id: 'ch-1',
    type: 'tanghulu',
    col: 'col-ch',
    num: '1',
    y: 78,
    title: '实体渠道接入层',
    fileTag: 'feishu / wechat',
    desc: '飞书长连接 im.message.receive_v1、微信本地库轮询、网页 POST /api/message、CLI 与语音流接入，按消息号去重并落盘原件。',
    chips: ['FeishuInbound', 'Wechat.store'],
    kindLabel: 'Channels 糖葫芦 ① · 实体渠道接入',
    human: '【人话讲透】不管是飞书群里 @周小灵、微信客服收到客户消息、还是你在网页聊天框发话，第一站都由具体渠道插件接住：先查去重表防止平台重推，把图片/语音附件下载到渠道目录，写好原始聊天日志。',
    realEvents: '飞书 SDK: im.message.receive_v1 / im.message.recalled_v1 | 内部登记: ctx.bots.channel(name)',
    dispatchMode: '平台长连接 / 轮询 / Fastify HTTP 入口',
    senders: '飞书 WSClient / 微信 Reader.syncBatch / 网页 POST /api/message / CLI submitLine',
    listeners: '交给本渠道内部 Inbound.handleInboundMessage 归一化，随后调 channels.emitInbound',
    typeName: 'FeishuEvent / RawMessage',
    schemaText: `// 飞书/微信/网页收到的原始入站事实
interface InboundFacts {
  appId: string;          // 飞书应用号 / 微信账号 / 'local'
  nativeId: string;       // 平台原消息号 (feishu_seen 去重)
  chatId: string;         // 群或私聊 ID
  chatType: 'p2p' | 'group' | 'local';
  rawText: string;        // 平台原始文本
  resources: Resource[];  // 待下载的图片/文件/语音附件
}`,
    sourceDir: 'src7/plugins/feishu/Inbound.ts:160 · src7/plugins/wechat/index.ts:384',
    keyFunctions: 'Feishu.start(), FeishuInbound.onMessage(), Wechat.poll(), WebApi.accept(), Cli.submitLine()',
    toolsOrRoutes: 'POST /api/message · POST /api/feishu/history · GET /api/wechat-kefu/messages',
  },

  'ch-2': {
    id: 'ch-2',
    type: 'tanghulu',
    col: 'col-ch',
    num: '2',
    y: 168,
    title: '消息格式归一化',
    fileTag: 'channels/Message.ts',
    desc: '剥除平台专属占位符（如 @_user_1），统一封装为标准 ChannelMessage v1，并由 isOwnerTurn 唯一核定说话人身份。',
    chips: ['ChannelMessage v1', 'isOwnerTurn'],
    kindLabel: 'Channels 糖葫芦 ② · 标准协议归一化',
    human: '【人话讲透】不同渠道的消息长相千奇百怪，抽象渠道层（plugins/channels）定了一套全系统通用的「普通话」ChannelMessage v1：算出唯一 messageId，剥掉对本机器人的 @名字，更重要的是在这唯一一处判定「说话的是不是老板本人（owner）还是外人（guest）」。',
    realEvents: '无单独事件（同步纯函数归一，准备发往 emitInbound）',
    dispatchMode: "协议插件纯函数直接调用 (import * as protocol from '../channels/index.ts')",
    senders: 'feishu / wechat / web-api / cli / voice / programs',
    listeners: '输出标准 ChannelMessage v1 交给 ch-3 emitInbound',
    typeName: 'ChannelMessage (v: 1)',
    schemaText: `export interface ChannelMessage {
  v: 1;
  messageId: string;      // JSON.stringify([channel, accountId, nativeId])
  channel: string;        // 'feishu' | 'wechat' | 'http' | 'cli' | 'voice'
  chatType: 'p2p' | 'group' | 'local';
  role: 'owner' | 'builder' | 'guest'; // 缺证明一律 guest
  targetBots: string[];   // 映射到要接话的目标机器人名单
  text: string;           // 面向模型的清洗后正文
  origin: ChannelOrigin;  // 不可变深拷贝原渠道地址
  visibility: { scope: string; trusted: boolean };
}`,
    sourceDir: 'src7/plugins/channels/Message.ts:107-260',
    keyFunctions: 'makeChannelMessageId(), isOwnerTurn(), getSpeakerRole(), isGroup()',
    toolsOrRoutes: '协议纯函数（供 approval、bots、memory、knowledge、workspaces 共用身份判断）',
  },

  'ch-3': {
    id: 'ch-3',
    type: 'tanghulu',
    col: 'col-ch',
    num: '3',
    y: 258,
    title: '入站事件分流派发',
    fileTag: 'emitInbound()',
    desc: '由 getInboundEvent(chatType, called) 唯一分流，经 ctx.serial 发出 channel/direct、channel/mention 或 channel/listen。',
    chips: ['getInboundEvent', 'ChannelMessageControl'],
    kindLabel: 'Channels 糖葫芦 ③ · 入站派发出口',
    human: '【人话讲透】归一化后的消息在这里正式迈出 Channels 列！getInboundEvent 只看两件事：是不是群、叫没叫机器人——私聊发 channel/direct，群里 @或引用了机器人发 channel/mention，群里没叫机器人发 channel/listen（互斥，一条话只发一个！）。',
    realEvents: 'channel/direct · channel/mention · channel/listen (统称 channel.message 入站事件族)',
    dispatchMode: 'ctx.serial 挨个问（等 approval、bots、memory 依次处理完）',
    senders: 'src7/plugins/channels/Message.ts 的 emitInbound()',
    listeners: '1. approval (prepend 抢先看批复) → 2. bots (按 targetBots 认领) → 3. memory & ArchiveListen → 4. web-api',
    typeName: 'InboundEvent + ChannelMessageControl',
    schemaText: `export type InboundEvent =
  | 'channel/direct'   // 私聊（含语音半句 routing.partial）
  | 'channel/mention'  // 群里 @ 了机器人或引用机器人的话
  | 'channel/listen';  // 群里没叫机器人（记背景或 judge 判断）

export interface ChannelMessageControl {
  approvalHandled?: boolean; // “同意 3”已被审批消费则不再进机器人
  claims: ChannelClaimRecord[]; // 各机器人认领状态记录
}`,
    sourceDir: 'src7/plugins/channels/Message.ts:263-305',
    keyFunctions: 'getInboundEvent(chatType, called), emitInbound(ctx, message, called, control)',
    toolsOrRoutes: '入站唯一总线出口（各渠道代码里绝不直接手写 emit 事件名）',
  },

  'ch-4': {
    id: 'ch-4',
    type: 'tanghulu',
    col: 'col-ch',
    num: '4',
    y: 348,
    title: '出站回复路由与幂等',
    fileTag: 'channels/Reply.ts',
    desc: '承接 channel/reply 请求，按 replyRequestKey 与 payloadHash 幂等校验，支持原快照回话或 target.address 跨聊天投递。',
    chips: ['requestChannelReply', 'registerTextReply'],
    kindLabel: 'Channels 糖葫芦 ④ · 出站协议路由',
    human: '【人话讲透】机器人要往外说话时，从右往左经 ◇ channel.reply 回到 Channels 列！这里负责核对这条回复属于哪个渠道（feishu/wechat/http/cli），用 replyRequestKey 防止同一句回复发两遍，并支持本人跨聊天发话（canReplyAcrossChats）。',
    realEvents: '听 channel/reply → 准备触发渠道投递并配对 channel/replied',
    dispatchMode: "requestEvent 请求-回执配对 (prefix: 'rep', 30s 报警不掐表)",
    senders: 'requestChannelReply() / requestTextReply() (由 bots、relay、approval、work-decision 调用)',
    listeners: 'FeishuReply.onChannelReply / VoiceReplies / TextReply.registerTextReply (cli、web-api、wechat、programs)',
    typeName: 'ChannelReplyRequest',
    schemaText: `export interface ChannelReplyRequest {
  requestId: string;        // 请求-回执配对号
  channel: string;          // 目标渠道名
  bot: string;              // 发言机器人名
  replyRequestKey: string;  // 幂等键 [replyRoundKey, callId]
  kind: 'progress' | 'final';
  sourceSnapshot?: SourceSnapshot; // 回原消息时带不可变快照
  target?: ChannelReplyTarget;     // 按地址发或跨聊天目标
  parts: ReplyPartInput[];  // 文字或附件片段
}`,
    sourceDir: 'src7/plugins/channels/Reply.ts:80-255 · TextReply.ts:1-120',
    keyFunctions: 'requestChannelReply(), requestTextReply(), registerTextReply(), canReplyAcrossChats()',
    toolsOrRoutes: '所有外发消息（channel_reply 工具、自动回话、Relay回信、审批直回）唯一协议入口',
  },

  'ch-5': {
    id: 'ch-5',
    type: 'tanghulu',
    col: 'col-ch',
    num: '5',
    y: 438,
    title: '实体投递回执与归档',
    fileTag: 'emitReplied',
    desc: '飞书/微信/网页执行真实发送（撤敲键盘表情、待确认草稿），经 emitReplied 发回 ReplyReceipt v2，并按天分卷归档 Markdown。',
    chips: ['ReplyReceipt v2', 'applyChatArchive'],
    kindLabel: 'Channels 糖葫芦 ⑤ · 实体投递与 Markdown 归档',
    human: '【人话讲透】最后一颗糖葫芦把话真正发到飞书群或微信客服发件箱！飞书收到 final 回复会顺手撤掉“敲键盘”表情，然后通过 emitReplied 发出 channel/replied 回执（带着整份原请求）；同时 ArchiveListen 把用户原话和机器人回复按天写进 channels/ 下的 Markdown 档案。',
    realEvents: '发出 channel/replied (携带 ReplyReceipt v2 + ChannelReplyRequest)',
    dispatchMode: 'ctx.emit 广播回执（requestChannelReply 按 requestId 配对收货）',
    senders: 'src7/plugins/channels/Reply.ts 的 emitReplied()（由 feishu、wechat、web-api、cli 调）',
    listeners: 'requestChannelReply (配对返回) · bots FrontDesk.onReplied · memory applyChannelIndex · applyChatArchive · web-api',
    typeName: 'ChannelRepliedEvent & ReplyReceipt (v: 2)',
    schemaText: `export interface ReplyReceipt {
  v: 2;
  ok: boolean;              // sent | queued | draft 为 true
  status: 'sent' | 'queued' | 'draft' | 'partial' | 'uncertain' | 'rejected';
  replyRequestKey: string;
  messageIds?: string[];    // 平台返回的消息号（供撤回定位）
  at: number;
}`,
    sourceDir: 'src7/plugins/feishu/Reply.ts:74 · src7/plugins/channels/ArchiveListen.ts:19',
    keyFunctions: 'emitReplied(), FeishuReply.onChannelReply(), Wechat.deliver(), applyChatArchive()',
    toolsOrRoutes: '归档路径: <runtime>/channels/<渠道>/<账号>/<私聊或群>/<名字_ID>/<日期>_<卷>.md',
  },

  // -------------------- INTER-COLUMN ZONE A: CHANNELS <-> BOTS DIAMONDS --------------------
  'ev-ch-msg': {
    id: 'ev-ch-msg',
    type: 'diamond',
    color: 'ev-amber',
    x: 258,
    y: 164,
    dirText: '向右入站 ━━▶',
    title: '◇ channel.message',
    sub: 'direct · mention · listen',
    kindLabel: '列间核心事件菱形 A1 · Channels ━━▶ Bots',
    human: '【人话讲透】这是 Channels 列指向 Bots 列的核心入站事件菱形！老板构想中的「◇ channel.message」在 src7 代码里精细拆成了三个互斥事件：私聊发 channel/direct、群里 @了机器人发 channel/mention、群里没叫机器人发 channel/listen。Cordis 按挂载顺序挨个问：审批插件先看是不是“同意 3”，然后交给 Bots 认领！',
    realEvents: 'channel/direct · channel/mention · channel/listen (声明于 src7/plugins/channels/index.ts:58-92)',
    dispatchMode: 'ctx.serial 挨个问（prepend 的 approval 最先，接着 bots → memory → web-api）',
    senders: 'src7/plugins/channels/Message.ts:280 的 emitInbound(ctx, message, called, control)',
    listeners: '1. Approval.onChannelMessage → 2. Bots.onChannelMessage → 3. applyChatArchive → 4. Memory.applyChannelIndex → 5. WebApi',
    typeName: '(message: ChannelMessage, control?: ChannelMessageControl)',
    schemaText: `// declare module 'cordis' (src7/plugins/channels/index.ts)
interface Events {
  'channel/direct'(msg: ChannelMessage, ctrl?: ChannelMessageControl): Promise<void>;
  'channel/mention'(msg: ChannelMessage, ctrl?: ChannelMessageControl): Promise<void>;
  'channel/listen'(msg: ChannelMessage, ctrl?: ChannelMessageControl): Promise<void>;
}`,
    sourceDir: 'src7/plugins/channels/index.ts:45-92 · Message.ts:263-305',
    keyFunctions: 'emitInbound(), Approval.onChannelMessage(), Bots.onChannelMessage()',
    toolsOrRoutes: '入站总枢纽：连接抽象渠道层与机器人调度层、记忆索引层',
  },

  'ev-ch-recall': {
    id: 'ev-ch-recall',
    type: 'diamond',
    color: 'ev-rose',
    x: 258,
    y: 281,
    dirText: '撤回/历史 ━━▶',
    title: '◇ channel/recall',
    sub: 'recall撤回 · history群历史',
    kindLabel: '列间事件菱形 A2 · Channels ━━▶ Bots & Memory',
    human: '【人话讲透】除了正常发话，渠道还有两类特殊入站事件：① 用户在飞书撤回了刚发的话，发出 channel/recall，Bots 立刻把排队里没跑的原话删掉，或者通知正在跑的会话让模型重新判断；② 机器人刚进群拉取历史消息，发出 channel/history，不惊动机器人，直接塞给 Memory 后台回填！',
    realEvents: 'channel/recall · channel/history (声明于 src7/plugins/channels/index.ts:101-133)',
    dispatchMode: 'ctx.serial 挨个问',
    senders: 'FeishuInbound.onRecall (撤回) · FeishuHistoryPull.pull (拉群历史)',
    listeners: 'channel/recall: Bots DispatchRecall.onChannelRecall + Memory + ArchiveListen | channel/history: Memory + ArchiveListen',
    typeName: 'ChannelRecallEvent / ChannelMessage[]',
    schemaText: `export interface ChannelRecallEvent {
  channel: string;
  accountId: string;
  chatId: string;
  messageId: string;     // 被撤回的原消息标准 ID
  recalledAt: number;    // 撤回毫秒时刻
  originalText: string;  // 原话内容
  recalledBy: { id: string; kind: 'sender' | 'owner'; isOwner: boolean };
}`,
    sourceDir: 'src7/plugins/channels/index.ts:94-133 · bots/DispatchRecall.ts',
    keyFunctions: 'FeishuInbound.onRecall(), DispatchRecall.onChannelRecall(), FeishuHistoryPull.pull()',
    toolsOrRoutes: '配套工具: feishu_recall (机器人撤回自己发出的消息)',
  },

  'ev-ch-reply': {
    id: 'ev-ch-reply',
    type: 'diamond',
    color: 'ev-emerald',
    x: 258,
    y: 401,
    dirText: '◀━━ 向左回指',
    title: '◇ channel.reply',
    sub: 'reply 请求 ↔ replied 回执',
    kindLabel: '列间核心事件菱形 A3 · Bots ━━▶ Channels (向左回指)',
    human: '【人话讲透】这是从中间 Bots 列向左回指左侧 Channels 列的出站大动脉！所有发出去的话（不管是模型调 channel_reply 工具、一轮结束自动回话、外部助手 Relay 回信、还是审批直回）统统发出 channel/reply，目标渠道投递完成后回传 channel/replied 回执！',
    realEvents: 'channel/reply (请求) ↔ channel/replied (回执) (声明于 src7/plugins/channels/index.ts:111-123)',
    dispatchMode: 'requestEvent 请求-回执配对 (ctx.serial 发 channel/reply，ctx.emit 回 channel/replied)',
    senders: 'requestChannelReply() (由 ChannelTools.runReply / Bots.send / Relay.sendTo / Approval 发起)',
    listeners: 'channel/reply: FeishuReply / VoiceReplies / registerTextReply | channel/replied: FrontDesk / Memory / ArchiveListen / WebApi',
    typeName: 'ChannelReplyRequest ↔ ChannelRepliedEvent',
    schemaText: `export interface ChannelRepliedEvent {
  requestId: string;            // 配对 requestChannelReply
  replyRoundKey: string;        // [messageId, botName, roundId]
  receipt: ReplyReceipt;        // v2 回执 (sent/queued/draft/rejected/uncertain)
  request: ChannelReplyRequest; // 随回执带回整份原请求，供记忆与归档直接落盘
}`,
    sourceDir: 'src7/plugins/channels/Reply.ts:111-202 · bots/ChannelTools.ts:172',
    keyFunctions: 'requestChannelReply(), requestTextReply(), emitReplied(), FeishuReply.onChannelReply()',
    toolsOrRoutes: "模型工具: channel_reply(text, kind: 'progress'|'final', channel?, chat?)",
  },

  // -------------------- COLUMN 2: BOTS (机器人调度层) --------------------
  'bot-1': {
    id: 'bot-1',
    type: 'tanghulu',
    col: 'col-bot',
    num: '1',
    y: 78,
    title: '审批拦截与机器人路由',
    fileTag: 'bots/index.ts',
    desc: 'Approval 抢先识别“同意 N”批复指令；普通消息由 Bots 按 targetBots 路由到具体机器人（如周小灵），物化附件并发 bot/receive。',
    chips: ['Approval抢先', '周小灵路由'],
    kindLabel: 'Bots 糖葫芦 ① · 审批把关与机器人路由',
    human: '【人话讲透】消息跨过 ◇ channel.message 来到 Bots 列第一站：先由排在最前面的 Approval 插件看一眼是不是老板发的“同意 3”（是的话直接执行审批并回话，不再进机器人会话）；普通消息则按 targetBots 找到点名的机器人（比如「周小灵」），把附件拷进机器人收件箱。',
    realEvents: '收 channel/direct · channel/mention · channel/listen → 逐个目标机器人发 bot/receive',
    dispatchMode: 'Cordis 监听链 (Approval prepend:true 排第一，Bots 紧随其后)',
    senders: 'Channels emitInbound → Bots.onChannelMessage',
    listeners: '发出 bot/receive 问 relay 等分派插件是否认领',
    typeName: 'ReceiveEvent (bot/receive)',
    schemaText: `export interface ReceiveEvent {
  bot: Bot;                     // 目标机器人实例（如「周小灵」）
  message: string;              // 含附件本机路径的组装文本
  origin: ChannelOrigin;        // 渠道名与地址副本
  session?: Session;            // 插件认领时填入指定会话
  handled?: boolean;            // 已消费则前台不再接手
  fromChannelEvent?: boolean;
}`,
    sourceDir: 'src7/plugins/bots/index.ts:590-660 · src7/plugins/approval/index.ts:1173',
    keyFunctions: 'Approval.onChannelMessage(), Bots.onChannelMessage(), materializeAttachments()',
    toolsOrRoutes: 'GET /api/bots · POST /api/approvals/:id',
  },

  'bot-2': {
    id: 'bot-2',
    type: 'tanghulu',
    col: 'col-bot',
    num: '2',
    y: 168,
    title: '角色权限与工作区分流',
    fileTag: 'workspaces/relay',
    desc: '调用 isOwnerTurn 识别本人与外人权限，通过 workspaces 绑定安全沙箱目录；若命中 cc/哈基米 前缀则由 relay 转交外部 AI。',
    chips: ['isOwnerTurn', 'Relay转话'],
    kindLabel: 'Bots 糖葫芦 ② · 角色权限与工作区/Relay 分流',
    human: '【人话讲透】第二颗糖葫芦负责「认人、定地盘、分内外」：① 调 channels.isOwnerTurn 看是不是老板本人（外人在群里不带私人记忆、只给只读工具）；② workspaces 插件定下这轮能读写哪个工作区目录；③ 如果开头带了 `cc` 或配了外部助手，Relay 插件在 bot/receive 上直接领走转给 Claude！',
    realEvents: '听 bot/receive · 查 workspaces.getAccess / resolve',
    dispatchMode: 'bot/receive 关口认领 + 服务调用 (ctx.workspaces)',
    senders: 'Bots.onChannelMessage 发出 bot/receive',
    listeners: 'Relay.onReceive (匹配前缀转外部助手) · Approval (按说话人筛工具清单)',
    typeName: 'WorkspaceAccess & RelayMatch',
    schemaText: `// 说话人身份决定工具白名单、工作区与私人记忆可见性
interface TurnSecurityContext {
  isOwner: boolean;         // channels.isOwnerTurn(channel, address)
  speakerRole: 'owner' | 'builder' | 'guest';
  workspaceId: string;      // workspaces.resolve 核定的沙箱工作区
  relayHelper?: string;     // 命中 cc / 哈基米 等外部助手前缀
  readOnlyToolsOnly: boolean; // 非本人轮次仅保留 READ_ONLY_TOOLS
}`,
    sourceDir: 'src7/plugins/workspaces/index.ts · src7/plugins/relay/Receive.ts · approval/Rules.ts',
    keyFunctions: 'workspaces.getAccess(), workspaces.resolve(), Relay.onReceive(), pickReceiveSessionKind()',
    toolsOrRoutes: '模型工具: workspace · relay_send · agent_task',
  },

  'bot-3': {
    id: 'bot-3',
    type: 'tanghulu',
    col: 'col-bot',
    num: '3',
    y: 258,
    title: '前台认领去重与会话排队',
    fileTag: 'FrontDesk.ts',
    desc: '按 sourceScope 定位或创建 front 前台会话，用 claimKey 严格幂等去重，生成不可变 SourceSnapshot 排入统一 resultQueue。',
    chips: ['DispatchClaim', 'resultQueue'],
    kindLabel: 'Bots 糖葫芦 ③ · 前台会话定位与排队',
    human: '【人话讲透】没被外部助手领走的普通消息，正式进入机器人的「前台接待处（FrontDesk）」！按 {渠道, 账号, 聊天号} 找到属于这个聊天的那场 front 会话，给这条消息拍一张不可篡改的「来源快照 SourceSnapshot」，排进 resultQueue 队列——哪怕会话正忙着，新消息也会乖乖排队不插队！',
    realEvents: '群只听 listen:judge 攒批到期时发 decision/judge ↔ decision/judge-result',
    dispatchMode: 'DispatchClaim.claimChannelMessage 事务落盘 + 队列推进',
    senders: 'Bots.onChannelMessage → DispatchClaim.claimChannelMessage',
    listeners: 'DispatchResults.startQueuedUser 调用 Session.queueUserMessage & Session.run()',
    typeName: 'SourceSnapshot & ResultQueueItem',
    schemaText: `export interface SourceSnapshot {
  messageId: string;
  channel: string;
  accountId: string;
  chatId: string;
  role: 'owner' | 'builder' | 'guest';
  botName: string;        // 当前认领执行的机器人
  claimKey: string;       // JSON.stringify([messageId, botName])
  replyRoundKey: string;  // JSON.stringify([messageId, botName, roundId])
}`,
    sourceDir: 'src7/plugins/bots/FrontDesk.ts:154 · DispatchClaim.ts:94 · GroupBatch.ts',
    keyFunctions: 'findOrCreateFrontByScope(), claimChannelMessage(), getSourceSnapshot(), startQueuedUser()',
    toolsOrRoutes: '会话扩展字段: session.row.sourceScope, sourceClaims, activeSourceSnapshot, resultQueue',
  },

  'bot-4': {
    id: 'bot-4',
    type: 'tanghulu',
    col: 'col-bot',
    num: '4',
    y: 348,
    title: '上下文与系统提示词组装',
    fileTag: 'Prompt.ts',
    desc: '在 session/before-model 关口拼装前台近期往来、00_base_dsh 底座、机器人 persona.md、模型评价，并注入派活与回复工具。',
    chips: ['persona.md', 'hand_session'],
    kindLabel: 'Bots 糖葫芦 ④ · 提示词与上下文组装',
    human: '【人话讲透】会话开跑后，每一步调大模型前都会经过关口一（session/before-model）：Bots 里的四个子模块依次出手——FrontDesk 拼上近期聊天往来，DispatchTools 注入派后台工具（hand_session）和模型能力表，ChannelTools 挂载 channel_reply，Prompt 拼好底座提示词和周小灵的 persona.md 人设！',
    realEvents: '听 session/before-model → 发 memory/request (front-history) & model-catalog/request (prompt)',
    dispatchMode: '关口一 ctx.serial 挨个修改 ChatRequest (system, messages, tools)',
    senders: 'Sessions.ts (Session.getStepAnswer 发 session/before-model)',
    listeners: '1. FrontDesk.onRequest → 2. DispatchTools.onRequest → 3. ChannelTools → 4. Prompt.onRequest',
    typeName: 'ChatRequest.system & tools',
    schemaText: `// Prompt.ts 与 FrontDesk.ts 在 session/before-model 组装顺序：
request.system = [
  'prompts/00_base_dsh.md',        // unshift 底座原则
  'prompts/10_jmbots.zh.md',       // unshift 积木功能声明
  'prompts/front.zh.md',           // 会话种类提示词 (front / work)
  'bots/周小灵/persona.md',        // 机器人专属人设与私人记忆文件
  '[派活说明 + 模型目录评价 + 开场召回记忆]'
];`,
    sourceDir: 'src7/plugins/bots/Prompt.ts · DispatchTools.ts · FrontDesk.ts:304',
    keyFunctions: 'FrontDesk.onRequest(), DispatchTools.onRequest(), ChannelTools.onRequest(), Prompt.onRequest()',
    toolsOrRoutes: '挂载工具: hand_session · list_sessions · stop_session · channel_reply',
  },

  'bot-5': {
    id: 'bot-5',
    type: 'tanghulu',
    col: 'col-bot',
    num: '5',
    y: 438,
    title: '驱动回复生成与轮次收尾',
    fileTag: 'ChannelTools.ts',
    desc: '模型调 channel_reply 或触发零次回复兜底/autoFinal，经 requestChannelReply 发回渠道；收尾发出 bot/settled 并推进下一条队列。',
    chips: ['channel_reply', 'bot/settled'],
    kindLabel: 'Bots 糖葫芦 ⑤ · 回复发出与队列收尾',
    human: '【人话讲透】模型想好回答后，调用 channel_reply 工具（或者在网页/微信由 autoFinal 自动兜底，飞书零次调工具则自动加跑一轮提醒），通过 ◇ channel.reply 发回左侧 Channels 列！如果是后台 work 会话做完了，结果经 acceptResult 排回原前台汇报，整轮结束发出 bot/settled 并处理队列下一件事。',
    realEvents: '发 channel/reply ↔ 等 channel/replied · 听 session/change · 发 bot/settled & memory/front-message',
    dispatchMode: '工具执行 (ChannelTools.runReply) + 状态监听 (DispatchResults.onChange)',
    senders: 'ChannelTools.runReply / DispatchResults.finishChannelFront / Bots.send',
    listeners: 'Channels (requestChannelReply) · cli / voice / web-api (听 bot/settled)',
    typeName: 'ChannelSettledEvent (bot/settled)',
    schemaText: `export interface ChannelSettledEvent {
  sourceSnapshot: SourceSnapshot; // 对应哪条入站消息的快照
  stage: 'sent' | 'partial' | 'uncertain' | 'rejected' | 'sending';
  note: string;                   // 收尾说明或失败原因
}`,
    sourceDir: 'src7/plugins/bots/ChannelTools.ts:172 · DispatchResults.ts:380-755',
    keyFunctions: 'ChannelTools.runReply(), finishChannelFront(), acceptResult(), settle(), emitSettled()',
    toolsOrRoutes: '支持 progress（中途汇报）与 final（最终答复，同轮幂等唯一）',
  },

  // -------------------- INTER-COLUMN ZONE B: BOTS <-> SKELETON / MEMORY DIAMONDS --------------------
  'ev-bot-rec': {
    id: 'ev-bot-rec',
    type: 'diamond',
    color: 'ev-amber',
    x: 715,
    y: 74,
    dirText: '⇄ 认领与交办',
    title: '◇ bot/receive',
    sub: 'bot/request ↔ result',
    kindLabel: '列间事件菱形 B1 · Bots ⇄ 分派插件 / 后台会话',
    human: '【人话讲透】Bots 插件对外提供两组核心协调事件：① `bot/receive` 在每个目标机器人认领消息前挨个问，让 Relay（外部助手）、Approval、WebApi 优先接管或打标；② `bot/request` ↔ `bot/result` 处理跨插件派活（action: "hand"）和外部任务/工作决策结果入队（action: "accept-result"）！',
    realEvents: 'bot/receive (serial) · bot/request ↔ bot/result (requestEvent) · bot/say · bot/judged',
    dispatchMode: 'ctx.serial (bot/receive) & requestEvent (bot/request ↔ bot/result)',
    senders: 'Bots.onChannelMessage (发 bot/receive) | Relay / Progress / WorkDecision / Settings (发 bot/request)',
    listeners: 'bot/receive: tutorial, approval, relay, voice, web-api | bot/request: Bots.onRequest',
    typeName: 'ReceiveEvent / BotRequestEvent',
    schemaText: `// bot/request 支持的 4 种标准动作 (src7/plugins/bots/index.ts)
type BotRequestAction =
  | { action: 'hand'; bot: string; text: string; origin?: unknown; replyTo?: unknown }
  | { action: 'accept-result'; input: ResultInput } // 外部任务/决策结果入前台队列
  | { action: 'save-file'; bot: string; name: string; data: Uint8Array }
  | { action: 'add'; config: Record<string, unknown> };`,
    sourceDir: 'src7/plugins/bots/index.ts:129, 647 · Dispatch.ts',
    keyFunctions: 'Bots.onChannelMessage(), Bots.onRequest(), ctx.frontDesk.acceptResult()',
    toolsOrRoutes: '跨插件解耦通信桥梁（无需直接引用 Bots 内部实现）',
  },

  'ev-sess-turn': {
    id: 'ev-sess-turn',
    type: 'diamond',
    color: 'ev-violet',
    x: 715,
    y: 167,
    dirText: '⇄ 关口一/二',
    title: '◇ session.turn',
    sub: 'before / after-model',
    kindLabel: '列间核心事件菱形 B2 · 骨架 Sessions ⇄ Bots / Memory',
    human: '【人话讲透】老板概念里的「◇ session.turn」对应骨架 Sessions.ts 每一步调大模型前后的两大关口！关口一 `session/before-model` 挨个问所有插件：Bots 拼上下文和人设、Memory 塞入召回记忆、Approval 过滤外人禁用的工具、Context-Fit 压缩超长历史；模型回答回来后过关口二 `session/after-model`，谁写 `request.stop` 就能随时喊停！',
    realEvents: 'session/before-model (关口一) · session/after-model (关口二) · session/model-failed',
    dispatchMode: 'ctx.serial 挨个问（严格按 config.yaml 的 plugins 挂载先后顺序 await）',
    senders: 'src7/Sessions.ts 的 Session.getStepAnswer (L697 & L719)',
    listeners: 'FrontDesk → DispatchTools → ChannelTools → Prompt → Relay → Memory → FileTools → Approval → Progress → ContextFit → ModelCatalog',
    typeName: 'ChatRequest & AnsweredRequest (extends SessionGate)',
    schemaText: `export interface ChatRequest extends SessionGate {
  session: Session;
  model: string;            // 供应商/模型 ID
  thinking: Thinking;       // off | minimal | low | medium | high | xhigh | max
  system: string[];         // 各插件往里 push/unshift 系统提示词段落
  tools: piAi.Tool[];       // 本步可见工具清单（插件可增删过滤）
  messages: piAi.Message[]; // 发送给模型的对话副本
  answer?: piAi.AssistantMessage; // 填了它就不调真模型 (fake-model/relay)
  stop?: string;            // 写上理由则当场停下本轮会话
}`,
    sourceDir: 'src7/Sessions.ts:59-67, 160-210, 697-725',
    keyFunctions: 'Session.getStepAnswer(), Sessions.chat()',
    toolsOrRoutes: '会话循环前两道核心关口（所有提示词注入与上下文裁剪都挂在这里）',
  },

  'ev-tool-call': {
    id: 'ev-tool-call',
    type: 'diamond',
    color: 'ev-cyan',
    x: 715,
    y: 260,
    dirText: '⇄ 关口三/四',
    title: '◇ tool.call',
    sub: 'before / after-tool',
    kindLabel: '列间核心事件菱形 B3 · 骨架 Tools ⇄ Approval / 各工具插件',
    human: '【人话讲透】老板概念里的「◇ tool.call」对应工具执行前后的关口三与关口四！模型要求调任何工具（比如 kb_search、channel_reply、exec），先过关口三 `session/before-tool`：Approval 复核当前说话人有没有权限，没权限就写 `gate.deny` 拦下这一个工具（理由返给模型看，会话继续）；执行完再过关口四 `session/after-tool` 把结果接进对话！',
    realEvents: 'session/before-tool (关口三，Tools.ts:187) · session/after-tool (关口四，Sessions.ts:672)',
    dispatchMode: 'ctx.serial 挨个问（支持 gate.deny 单次拒绝 或 gate.stop 整轮停止）',
    senders: '关口三: src7/Tools.ts 的 Tools.execute | 关口四: src7/Sessions.ts 的 Session.loop',
    listeners: 'Approval.constructor (权限把关) · Bots ChannelTools (幂等 callId 记录与渠道工具约束) · Progress GroupDaily',
    typeName: 'ToolGate & ToolDone (extends SessionGate)',
    schemaText: `export interface ToolGate extends SessionGate {
  session: Session;
  call: piAi.ToolCall;  // { id, name, arguments }
  deny?: string;        // 只拦这一个工具（理由当工具结果给模型，会话继续）
  stop?: string;        // 整轮会话停下，后面工具都不执行
}
export type ToolDone = Omit<ToolGate, 'deny'> & { outcome: ToolOutcome };`,
    sourceDir: 'src7/Tools.ts:29, 89-110, 187 · src7/Sessions.ts:75, 672',
    keyFunctions: 'Tools.execute(), Session.loop()',
    toolsOrRoutes: '配套审批事件: exec 工具内部还会发 approval/request ↔ approval/result',
  },

  'ev-mem-recall': {
    id: 'ev-mem-recall',
    type: 'diamond',
    color: 'ev-emerald',
    x: 715,
    y: 353,
    dirText: '⇄ 记忆召回',
    title: '◇ memory.recall',
    sub: 'memory/request ↔ result',
    kindLabel: '列间核心事件菱形 B4 · Bots / Knowledge ⇄ Memory',
    human: '【人话讲透】老板概念里的「◇ memory.recall」是连接 Bots、Knowledge 与 Memory 的记忆数据桥！包含三股实时流：① 开场在 session/before-model 上由 Memory.recall 自动检索相关记忆（发 trace: Memory.recall）；② FrontDesk 和 Knowledge 发 `memory/request` 请求 `memory/result` 查前台往来或四路混合检索；③ 前后台每产生一句对话发 `memory/front-message` 归档！',
    realEvents: 'memory/request ↔ memory/result (requestEvent) · memory/front-message (emit) · trace(Memory.recall)',
    dispatchMode: 'requestEvent 请求-回执配对 + ctx.emit 实时归档',
    senders: 'Bots FrontDesk.readFront / FrontDesk.log · Knowledge Routes.ts (4s AbortSignal.timeout 桥接)',
    listeners: 'MemoryService.onRequest (src7/plugins/memory/index.ts)',
    typeName: 'MemoryRequest & MemoryResult',
    schemaText: `// memory/request 支持的核心检索与归档动作
type MemoryRequestPayload =
  | { action: 'front-history'; query: FrontHistoryQuery } // Bots 前台查近期往来
  | { action: 'search'; query: MemorySearchQuery }        // Knowledge 混合检索桥接
  | { action: 'record-history' | 'search-history' | 'embed' };
// 回执 memory/result: { requestId, ok, hits?, search?, frontEntries?, vectors? }`,
    sourceDir: 'src7/plugins/memory/index.ts:272-292 · bots/FrontDesk.ts · knowledge/Routes.ts',
    keyFunctions: 'Memory.recall(), MemoryService.onRequest(), FrontDesk.readFront(), FrontDesk.log()',
    toolsOrRoutes: 'GET /api/memory/search · GET /api/memory/recall · GET /api/knowledge/search',
  },

  'ev-sess-state': {
    id: 'ev-sess-state',
    type: 'diamond',
    color: 'ev-rose',
    x: 715,
    y: 446,
    dirText: '◀━━ 状态收尾',
    title: '◇ session/change',
    sub: 'new-message · bot/settled',
    kindLabel: '列间核心事件菱形 B5 · 骨架 Sessions ━━▶ Bots / Memory / Journal',
    human: '【人话讲透】会话运行中和结束时的广播喇叭！每当对话里新接进一条消息（用户话、模型回答、工具结果），骨架发出 `session/new-message`，让 FrontDesk、Memory、Journal 实时记账；当整轮循环跑完（不再调工具）或被喊停，骨架发出 `session/change`，驱动 Bots 的 DispatchResults 完成回复收尾、写一句话总结并推进队列！',
    realEvents: 'session/new-message · session/change (声明于 src7/Sessions.ts:95, 112)',
    dispatchMode: 'ctx.emit 广播通知（不阻塞主线，监听者各自异步收尾或落盘）',
    senders: 'Session.append (发 session/new-message) · Session.change (发 session/change)',
    listeners: 'Bots (FrontDesk / DispatchResults / GroupBatch) · Memory · ContextFit (Summary) · Journal · Progress · Relay · Voice',
    typeName: '(session: Session, message / stateBefore)',
    schemaText: `// 会话四种状态流转 (src7/Sessions.ts)
export type SessionState = 'running' | 'done' | 'stopped' | 'failed';

interface Events {
  'session/new-message'(session: Session, message: piAi.Message): void;
  'session/change'(session: Session, stateBefore?: SessionState): void;
}`,
    sourceDir: 'src7/Sessions.ts:76-113, 782-795 · bots/DispatchResults.ts:380',
    keyFunctions: 'Session.append(), Session.change(), DispatchResults.onChange(), Summary.onChange()',
    toolsOrRoutes: '驱动收尾链: session/change → DispatchResults.onChange → channel/reply → bot/settled',
  },

  // -------------------- COLUMN 3: SKELETON (骨架核心 Sessions / Tools) --------------------
  'sk-1': {
    id: 'sk-1',
    type: 'tanghulu',
    col: 'col-sk',
    num: '1',
    y: 78,
    title: '骨架入口与资源底座',
    fileTag: 'Main & Resources',
    desc: '骨架仅留四模块！Main 按序挂载骨架与 config.yaml 插件并发出 ready；Resources 管理配置、SQLite 主库与 PI 供应商。',
    chips: ['Main.ts', 'ready 事件'],
    kindLabel: '骨架核心 糖葫芦 ① · Main 与 Resources',
    human: '【人话讲透】积木 AI 的铁律是「骨架代码少之又少，只留让一条消息走通的最少代码」！Main.ts 启动时先挂好 Resources（读 config.yaml、开 jmbots7.db、配好 PI 模型供应商）、Tools 和 Sessions，再按配置顺序挂载各业务插件，全部就绪后发出一声 `ready` 并自动恢复上次没跑完的会话。',
    realEvents: '发出 ready 通知 · 发出 trace 跟踪点',
    dispatchMode: "主线直接调用 + 生命周期通知 (ctx.emit('ready'))",
    senders: 'src7/Main.ts 启动完成时发出 ready',
    listeners: 'feishu (连长连接) · wechat (启轮询) · memory (同步知识库) · bots (恢复队列) · tutorial (写 boot.json)',
    typeName: 'Resources & PluginStatus',
    schemaText: `// 骨架四模块依赖链：Resources ← Tools ← Sessions ← Main
export class Resources extends cordis.Service {
  root: string;             // 运行时数据目录 (jmbotsData/)
  db: Database;             // SQLite 主库 (data/jmbots7.db)
  raw: Record<string, unknown>; // config.yaml 原始配置
  pluginStatus: Map<string, { state: 'ok' | 'error' | 'disabled' }>;
}`,
    sourceDir: 'src7/Main.ts:1-120 · src7/Resources.ts:1-180',
    keyFunctions: 'main(), new Resources(ctx), new Tools(ctx), new Sessions(ctx), loadPlugin()',
    toolsOrRoutes: 'CLI 入口: bun src7/Main.ts [--data 运行时目录]',
  },

  'sk-2': {
    id: 'sk-2',
    type: 'tanghulu',
    col: 'col-sk',
    num: '2',
    y: 168,
    title: '会话持久化与状态机',
    fileTag: 'Sessions.ts',
    desc: '管理 sessions 表（id / meta / messages），支持插件 declare module 扩展业务字段，提供 create / open / find / ask。',
    chips: ['SessionRow', 'sessions.ask()'],
    kindLabel: '骨架核心 糖葫芦 ② · 会话存储与扩展机制',
    human: '【人话讲透】一场会话就是内存里的 `session.row` 加数据库 `sessions` 表里的一行！骨架自己的记录只管 id、kind（front/work）、model、state、messages；插件想往会话上记自己的东西（比如 bots 记属于哪个机器人、回话地址、结果队列），直接用 TS 的 `declare module` 声明即可，存库时自动一起存进 meta JSON！',
    realEvents: '配合 Session.save() 持久化，状态变化触发 session/change',
    dispatchMode: '服务方法直接调用 (ctx.sessions.create / open / find / ask)',
    senders: 'Bots (建 front/work 会话) · Decision / Approval / ContextFit (调 sessions.ask 开小会话)',
    listeners: '落盘至 SQLite sessions 表 (id TEXT PRIMARY KEY, meta TEXT, messages TEXT)',
    typeName: 'SessionRow (src7/Sessions.ts)',
    schemaText: `export interface SessionRow {
  id: string;               // 20位本地时刻+随机数主键
  kind: string;             // 'front' | 'work' | 'relay' | 'compress' | 'summary'
  parent?: string;          // 子会话嵌在哪场父会话里
  model: string;            // 当前模型
  thinking: Thinking;       // 思考档位
  state: 'running' | 'done' | 'stopped' | 'failed';
  reply: string;            // 本轮最终回答或停止/失败原因
  messages: piAi.Message[]; // 完整对话数组
  // + 插件扩展项: bot, channel, address, customer, sourceScope, resultQueue...
}`,
    sourceDir: 'src7/Sessions.ts:129-155, 220-460',
    keyFunctions: 'Sessions.create(), Sessions.open(), Sessions.find(), Sessions.ask(), Session.save()',
    toolsOrRoutes: 'SQLite 表: sessions (id, meta, messages)',
  },

  'sk-3': {
    id: 'sk-3',
    type: 'tanghulu',
    col: 'col-sk',
    num: '3',
    y: 258,
    title: '会话主循环与模型请求',
    fileTag: 'Session.loop',
    desc: '驱动「关口一 before-model → Sessions.chat 调 PI 模型 → 关口二 after-model → 工具循环」核心主线，不按步数死限。',
    chips: ['Sessions.chat()', 'PI Agent SDK'],
    kindLabel: '骨架核心 糖葫芦 ③ · 会话主循环与 PI 模型调用',
    human: '【人话讲透】这是整个 jmbots 最心脏的循环 `Session.loop`！它做的事情极其纯粹：① 把排队的用户话接进对话；② 发关口一 `session/before-model` 让插件改请求；③ 调 `Sessions.chat()` 通过 PI Agent SDK 请求大模型（失败自动重试并发 `session/model-failed`）；④ 发关口二 `session/after-model`；⑤ 如果模型要调工具就去执行工具再循环下一步，直到模型不再调工具为止！',
    realEvents: '发 session/before-model → 发 session/after-model · session/model-failed · session/new-message · session/change',
    dispatchMode: 'Session.run() 异步状态机主循环',
    senders: 'DispatchResults.startQueuedUser / Bot.hand / Sessions.ask 调用 session.run()',
    listeners: '通过四个关口事件与所有业务插件协同',
    typeName: 'Session.loop & Sessions.chat',
    schemaText: `// src7/Sessions.ts 核心一步循环伪代码：
async getStepAnswer(): Promise<piAi.AssistantMessage | undefined> {
  await ctx.serial('session/before-model', request); // 关口一
  if (request.stop) return this.stop(request.stop);
  if (!request.answer) request.answer = await sessions.chat(request);
  await ctx.serial('session/after-model', request);  // 关口二
  return request.answer;
}`,
    sourceDir: 'src7/Sessions.ts:477-795',
    keyFunctions: 'Session.run(), Session.loop(), Session.getStepAnswer(), Sessions.chat(), Session.stop()',
    toolsOrRoutes: '依赖: @earendil-works/pi-ai (PI Agent SDK)',
  },

  'sk-4': {
    id: 'sk-4',
    type: 'tanghulu',
    col: 'col-sk',
    num: '4',
    y: 348,
    title: '工具登记表与关口执行',
    fileTag: 'src7/Tools.ts',
    desc: '维护全系统 ToolSpec 登记表（随插件卸载自动撤销），执行前过关口三 session/before-tool，校验 TypeBox 参数并运行。',
    chips: ['Tools.register', 'Tools.execute'],
    kindLabel: '骨架核心 糖葫芦 ④ · 工具服务与执行器',
    human: '【人话讲透】`Tools.ts` 自己不带任何具体工具，只管一张登记表！各插件挂载时调 `ctx.tools.register` 把工具登记进来（插件拔掉时自动撤掉）。当模型要求执行工具时，`Tools.execute` 先过关口三 `session/before-tool` 请把关插件审核，放行后用 TypeBox 校验参数、传入停止信号 `AbortSignal` 执行 `spec.run`，结果再过关口四 `session/after-tool`！',
    realEvents: '发 session/before-tool (关口三，Tools.ts:187) → 配合 Session.loop 发 session/after-tool (关口四)',
    dispatchMode: 'ctx.tools.register() 登记 + ctx.tools.execute() 执行',
    senders: 'Session.loop 遍历模型返回的 toolCalls 逐个调用 Tools.execute',
    listeners: '关口三: Approval (权限拦截) · ChannelTools (幂等与来源校验) → 执行目标插件的 spec.run()',
    typeName: 'ToolSpec & ToolOutcome',
    schemaText: `export interface ToolSpec {
  definition: piAi.Tool;   // { name, description, parameters (TypeBox) }
  sessionKinds: string[];  // 允许使用的会话种类，如 ['front', 'work']
  run(
    args: Record<string, unknown>,
    session: Session,
    signal: AbortSignal,
    callId: string,
  ): Promise<ToolResult> | ToolResult;
}`,
    sourceDir: 'src7/Tools.ts:1-245',
    keyFunctions: 'Tools.register(), Tools.listToolsForSessionKind(), Tools.execute()',
    toolsOrRoutes: '统一管理全系统 30+ 模型工具的生命周期与参数边界校验',
  },

  'sk-5': {
    id: 'sk-5',
    type: 'tanghulu',
    col: 'col-sk',
    num: '5',
    y: 438,
    title: '插件工具生态与审批',
    fileTag: 'file-tools / exec',
    desc: '各业务插件注入丰富工具：文件读写与技能(file-tools)、命令执行(exec 联动 approval/request 审批)、联网搜索与生图。',
    chips: ['read/write/skill', 'exec 审批卡'],
    kindLabel: '骨架核心 糖葫芦 ⑤ · 工具生态与安全审批闭环',
    human: '【人话讲透】有了 Tools 底座，各种能力都以插件形式挂上来：`file-tools` 提供工作区内的读写编辑和 `skill` 技能加载；`exec` 提供命令执行——遇到高危命令时发出 `approval/request`，在飞书私聊或网页弹出审批卡片等老板点“同意”后才真正跑命令！',
    realEvents: 'exec 发 approval/request ↔ 等 approval/result · approval 发 approval/asked & approval/decided',
    dispatchMode: 'Tools.execute 调用插件 run() → requestEvent 审批闭环',
    senders: 'Exec.onTool / Assist / Feishu Cards.onAction',
    listeners: 'Approval 插件核对 Rules.ts (isProjectCheck 自动放行项目检查，其余转待确认)',
    typeName: 'ApprovalRequest & ToolList',
    schemaText: `// 各核心插件向 ctx.tools.register 登记的工具矩阵：
bots:       channel_reply, hand_session, list_sessions, stop_session
file-tools: read, write, edit, find, list_dir, skill, time
exec:       exec (经 approval/request 审命令)
memory:     memory_search, memory_get, memory
knowledge:  kb_search, kb_disambiguate, kb_save
feishu:     feishu_doc, feishu_send_file, feishu_recall`,
    sourceDir: 'src7/plugins/file-tools/ · src7/plugins/exec/ · src7/plugins/approval/',
    keyFunctions: 'BaseTools.register(), applySkills(), Exec.onTool(), requestReview()',
    toolsOrRoutes: 'POST /api/run · GET /api/approvals · POST /api/approvals/:id',
  },

  // -------------------- COLUMN 4: KNOWLEDGE + MEMORY (记忆与知识图谱层) --------------------
  'mem-1': {
    id: 'mem-1',
    type: 'tanghulu',
    col: 'col-mem',
    num: '1',
    y: 78,
    title: '渠道全量索引与归档',
    fileTag: 'ChannelIndex.ts',
    desc: '监听全部渠道入站/回执/撤回/历史事件与 memory/front-message，按 MemoryKey 身份归属隔离写入 SQLite 渠道索引。',
    chips: ['MemoryKey 归属', 'FrontArchive'],
    kindLabel: 'Knowledge+Memory 糖葫芦 ① · 渠道索引与隐私归属隔离',
    human: '【人话讲透】Memory 插件的第一颗糖葫芦像一台全天候录音机：它同时听着 `channel/direct·mention·listen·replied·history·recall` 和 `memory/front-message`，把每一句用户话和机器人回复都记进 `memory_channel_messages` 表，并用 `MemoryKey` 打上严格的归属烙印（本人 owner / 某客户 person / 某群 group），绝不让外人串看老板的私人记忆！',
    realEvents: '听 channel/direct · mention · listen · replied · history · recall · memory/front-message · session/new-message',
    dispatchMode: '事件驱动自动落库 (SQLite INSERT OR IGNORE 幂等去重 + 实时入 Rust 队列)',
    senders: 'Channels emitInbound / emitReplied · FeishuHistoryPull · Bots FrontDesk.log',
    listeners: 'Memory applyChannelIndex (ChannelIndex.ts) & FrontArchive.ts',
    typeName: 'MemoryChannelMessageRow & MemoryAccess',
    schemaText: `// SQLite 表 memory_channel_messages 核心结构
interface ChannelIndexRow {
  msg_key: string;          // 唯一幂等键
  channel: string;          // feishu | wechat | http | cli
  chat: string;             // 聊天 ID
  direction: 'user' | 'bot';
  memory_key: string;       // 'owner' | 'person:...' | 'group:...' (隐私隔离键)
  text: string;
  attachments: string[];    // 归档附件相对路径
  recalled_at?: number;     // 撤回时刻（撤回后保留原话但标出）
  rust_state: 0 | 1 | 2;    // 0历史待入 | 1实时待入 | 2已同步至Rust
}`,
    sourceDir: 'src7/plugins/memory/ChannelIndex.ts · MemoryKey.ts · FrontArchive.ts',
    keyFunctions: 'applyChannelIndex(), getMemoryAccess(), canReadAll(), canQueryChannel()',
    toolsOrRoutes: 'GET /api/memory/channel · GET /api/memory/owners',
  },

  'mem-2': {
    id: 'mem-2',
    type: 'tanghulu',
    col: 'col-mem',
    num: '2',
    y: 168,
    title: '开场召回与四路检索',
    fileTag: 'Search.ts',
    desc: '在 session/before-model 开场自动召回记忆；Search.find 融合 Rust 往来、Rust 知识库、SQLite 渠道索引与本地卡片四路结果。',
    chips: ['Memory.recall', 'hybrid / graph'],
    kindLabel: 'Knowledge+Memory 糖葫芦 ② · 自动召回与四路 RRF 检索',
    human: '【人话讲透】第二颗糖葫芦负责「把记下的东西在最需要的时候找出来」：① 每次会话开场调模型前（session/before-model），按当前说话人权限自动召回相关历史塞进提示词；② 统一搜索引擎 `Search.find` 同时查 4 个地方（Rust 聊天往来、Rust 知识库、SQLite 渠道索引、本地记忆卡片），用排名倒数（RRF）融合打分！',
    realEvents: '听 session/before-model (开场召回) · 响应 memory/request (回 memory/result)',
    dispatchMode: '关口一自动注入 + requestEvent 服务响应',
    senders: 'Sessions (session/before-model) · Bots FrontDesk · Knowledge Routes',
    listeners: 'Memory.onBeforeModel (Recall) & Search.find()',
    typeName: 'MemorySearchResult',
    schemaText: `// Search.find 四路混合检索返回结构 (GET /api/memory/search)
export interface MemorySearchResponse {
  mode: 'keyword' | 'semantic' | 'hybrid' | 'graph';
  hits: Array<{
    source: 'history' | 'knowledge' | 'channel' | 'card';
    id: string | number;
    snippet: string;
    score: number;
    via: ('keyword' | 'vector' | 'graph')[]; // 命中途径
    customer?: string;
  }>;
  relations: GraphRelation[];
  unavailable: string[]; // 离线来源优雅降级不报错
}`,
    sourceDir: 'src7/plugins/memory/Search.ts · index.ts:272-350',
    keyFunctions: 'Memory.recall(), Search.find(), mergeHistoryHits()',
    toolsOrRoutes: 'GET /api/memory/search · GET /api/memory/recall',
  },

  'mem-3': {
    id: 'mem-3',
    type: 'tanghulu',
    col: 'col-mem',
    num: '3',
    y: 258,
    title: 'Rust 记忆与 VGR 图谱',
    fileTag: 'jmbots-memory',
    desc: '由 programs 托管守护独立 Rust 服务 jmbots-memory (30087)，提供向量 RAG、实体关系图谱抽取与受资源守卫管控的后台回填。',
    chips: [':30087 VGR', 'resource-request'],
    kindLabel: 'Knowledge+Memory 糖葫芦 ③ · Rust 向量与 VGR 图谱引擎',
    human: '【人话讲透】为什么检索既能按字面搜、又能按语义向量和人物关系图谱搜？因为底层挂着由 `programs` 插件守护的独立 Rust 高性能记忆服务 `jmbots-memory`（端口 30087）！它负责把聊天和知识切成段落算向量、抽取出人物/项目实体关系图（/graph/），而且后台历史回填每发一批都会先发 `programs/resource-request` 问资源守卫 CPU/内存够不够，绝不卡死老板电脑！',
    realEvents: '发 programs/resource-request ↔ 等 programs/resource-result · 听 programs/pressure',
    dispatchMode: 'Backend.fetchMemory HTTP (:30087) + 资源守卫事件握手',
    senders: 'Memory Backend.ts / ChannelBackfill.ts',
    listeners: 'programs 插件资源守卫 (CPU<80%, 内存<60G, 显存<15.9G 才放行 heavy 回填)',
    typeName: 'MemoryGraph & BackfillStatus',
    schemaText: `// 历史回填向 programs 资源守卫申请准入载荷
interface ResourceRequest {
  action: 'can-start';
  who: 'memory-backfill';
  heavy: true;
}
// Rust 记忆服务核心端点 (127.0.0.1:30087):
// POST /ingest · POST /search · POST /embed · GET /api/memory-graph/graph`,
    sourceDir: 'src7/plugins/memory/Backend.ts · ChannelBackfill.ts · GraphRoutes.ts',
    keyFunctions: 'fetchMemory(), ChannelBackfill.tick(), GraphRoutes.register()',
    toolsOrRoutes: 'GET /graph/ · GET /api/memory-graph/graph · GET/POST /api/memory/backfill',
  },

  'mem-4': {
    id: 'mem-4',
    type: 'tanghulu',
    col: 'col-mem',
    num: '4',
    y: 348,
    title: '积木知识库与 [[双链]]',
    fileTag: 'knowledge v1.2',
    desc: '管理虚拟目录树、多标签、Obsidian 式 [[双链]] (kb_links)、实体别名消歧、硬性系统规则保护、磁盘镜像与本地目录只读同步。',
    chips: ['kb_links', 'aliases消歧'],
    kindLabel: 'Knowledge+Memory 糖葫芦 ④ · 积木结构化知识库',
    human: '【人话讲透】除了零散的聊天记忆，重要的架构决策、中控铁律和组块文档都沉淀在 `knowledge`（积木知识库 v1.2.0）里！它支持 Obsidian 风格的 `[[双链]]` 自动解析正反向链接画知识图谱、支持给文档配实体别名（`aliases`，如“ProfileDock”指向《AOBB多开舱》）、支持保护「硬性系统规则」（AI 只读不可改），还能通过 `memory/request` 一键联查记忆库！',
    realEvents: "发 memory/request (action: 'search', 4s AbortSignal.timeout) ↔ 收 memory/result",
    dispatchMode: 'SQLite 事务 + DiskMirror 磁盘镜像 + memory/request 混合检索桥接',
    senders: 'Knowledge Routes.ts (GET /api/knowledge/search 附查记忆)',
    listeners: 'MemoryService.onRequest 返回 memoryHits 合并展示',
    typeName: 'KnowledgeDoc & WikiLink (kb_docs / kb_links)',
    schemaText: `export interface KnowledgeDoc {
  id: string;               // AtomId (如 '20261122181626300mny')
  dirId: string | null;     // 虚拟目录 ID
  title: string;            // 文档标题（参与 [[双链]] 精确匹配）
  aliases: string[];        // v1.2.0 实体别名数组（参与双链与消歧）
  tags: string[];           // 多标签 (#架构 #老板决策)
  isSystemRule: boolean;    // 硬性系统规则（仅本人网页可改，kb_save 禁改）
  content: string;          // Markdown 正文（含 [[标题|别名]] 双链）
}`,
    sourceDir: 'src7/plugins/knowledge/Store.ts · Links.ts · FolderSync.ts · DiskMirror.ts',
    keyFunctions: 'KnowledgeStore.createDoc/updateDoc(), KnowledgeLinks.refreshDoc/getGraph(), FolderSync.sync()',
    toolsOrRoutes: 'GET /api/knowledge/graph · GET /api/knowledge/disambiguate · POST /api/knowledge/sync-folders',
  },

  'mem-5': {
    id: 'mem-5',
    type: 'tanghulu',
    col: 'col-mem',
    num: '5',
    y: 438,
    title: '记忆与知识工具反哺',
    fileTag: 'memory_* / kb_*',
    desc: '向 front / work 会话提供 memory_search、memory_get、kb_search、kb_disambiguate、kb_save 工具，实现「边聊边查、边做边沉淀」。',
    chips: ['memory_search', 'kb_search/save'],
    kindLabel: 'Knowledge+Memory 糖葫芦 ⑤ · 模型工具读写闭环',
    human: '【人话讲透】最后一颗糖葫芦把记忆和知识库变成大模型手里的 5 把利器：模型在会话中随时调 `memory_search` / `memory_get` 翻查历史对话原文，调 `kb_search` / `kb_disambiguate` 精确查找双链知识文档，做完任务还能调 `kb_save` 把新总结自动写成带 `[[双链]]` 和标签的知识库文章，形成完整的认知进化闭环！',
    realEvents: '经 Tools.execute 关口三 session/before-tool 验权后执行，关口四 session/after-tool 返回',
    dispatchMode: "ctx.tools.register 挂载于 ['front', 'work'] 会话",
    senders: '骨架 Tools.execute 调用工具 run()',
    listeners: 'Memory (memory_search / memory_get) & Knowledge (kb_search / kb_disambiguate / kb_save)',
    typeName: 'Knowledge & Memory Model Tools',
    schemaText: `// 登记在 Tools.ts 上的 5 个核心记忆/知识工具：
1. memory_search({ q, range, front, mentions, channel, chat, since, until })
2. memory_get({ ref: '#编号 | bot-log:编号', channel, chat, before })
3. kb_search({ query, docId, dirId, topicId, tag }) // 查总览/摘要/单篇全文
4. kb_disambiguate({ query })                       // 按标题与别名精确消歧
5. kb_save({ docId?, title, content, tags, aliases, mode: 'append'|'replace' })`,
    sourceDir: 'src7/plugins/memory/index.ts · src7/plugins/knowledge/Tools.ts',
    keyFunctions: 'registerMemoryTools(), registerKnowledgeTools()',
    toolsOrRoutes: '权限护栏: kb_save 仅限 isOwnerTurn 本人可用，且拒绝修改 isSystemRule 文档',
  },
};

/** 29 条有向事件连线拓扑。 */
export const TANGHULU_EDGES: readonly TanghuluEdgeSpec[] = [
  // Channels internal skewer flow
  { id: 'e-ch1-ch2', from: 'ch-1', to: 'ch-2', color: '#0ea5e9', marker: 'th-arrow-cyan', pts: [132, 154, 132, 168], tags: ['inbound'] },
  { id: 'e-ch2-ch3', from: 'ch-2', to: 'ch-3', color: '#0ea5e9', marker: 'th-arrow-cyan', pts: [132, 244, 132, 258], tags: ['inbound'] },
  { id: 'e-ch4-ch5', from: 'ch-4', to: 'ch-5', color: '#10b981', marker: 'th-arrow-emerald', pts: [132, 424, 132, 438], tags: ['outbound'] },

  // Channels -> Diamond A1 (channel.message) -> Bots
  { id: 'e-ch3-evmsg', from: 'ch-3', to: 'ev-ch-msg', color: '#f59e0b', marker: 'th-arrow-amber', pts: [242, 286, 260, 206], tags: ['inbound'] },
  { id: 'e-ch2-evmsg', from: 'ch-2', to: 'ev-ch-msg', color: '#f59e0b', marker: 'th-arrow-amber', pts: [242, 206, 260, 206], tags: ['inbound'] },
  { id: 'e-evmsg-bot1', from: 'ev-ch-msg', to: 'bot-1', color: '#f59e0b', marker: 'th-arrow-amber', pts: [458, 206, 476, 116], tags: ['inbound'] },
  { id: 'e-evmsg-bot3', from: 'ev-ch-msg', to: 'bot-3', color: '#f59e0b', marker: 'th-arrow-amber', pts: [458, 206, 476, 285], tags: ['inbound'] },

  // Channels -> Diamond A2 (channel/recall & history) -> Bots & Memory
  { id: 'e-ch3-evrec', from: 'ch-3', to: 'ev-ch-recall', color: '#f43f5e', marker: 'th-arrow-rose', pts: [242, 308, 260, 323], tags: ['inbound', 'memory'] },
  { id: 'e-evrec-bot3', from: 'ev-ch-recall', to: 'bot-3', color: '#f43f5e', marker: 'th-arrow-rose', pts: [458, 323, 476, 305], tags: ['inbound'] },

  // Bots -> Diamond A3 (channel.reply) -> Channels (LEFTWARD RETURN ARROWS!)
  { id: 'e-bot5-evrep', from: 'bot-5', to: 'ev-ch-reply', color: '#10b981', marker: 'th-arrow-emerald', pts: [476, 476, 458, 443], tags: ['outbound'] },
  { id: 'e-evrep-ch4', from: 'ev-ch-reply', to: 'ch-4', color: '#10b981', marker: 'th-arrow-emerald', pts: [260, 443, 242, 386], tags: ['outbound'] },
  { id: 'e-evrep-ch5', from: 'ev-ch-reply', to: 'ch-5', color: '#10b981', marker: 'th-arrow-emerald', pts: [260, 443, 242, 476], tags: ['outbound'] },

  // Bots internal skewer flow
  { id: 'e-bot1-bot2', from: 'bot-1', to: 'bot-2', color: '#f97316', marker: 'th-arrow-amber', pts: [586, 154, 586, 168], tags: ['inbound'] },
  { id: 'e-bot2-bot3', from: 'bot-2', to: 'bot-3', color: '#f97316', marker: 'th-arrow-amber', pts: [586, 244, 586, 258], tags: ['inbound'] },
  { id: 'e-bot3-bot4', from: 'bot-3', to: 'bot-4', color: '#f97316', marker: 'th-arrow-amber', pts: [586, 334, 586, 348], tags: ['gates'] },
  { id: 'e-bot4-bot5', from: 'bot-4', to: 'bot-5', color: '#f97316', marker: 'th-arrow-amber', pts: [586, 424, 586, 438], tags: ['outbound'] },

  // Bots <-> Diamond Zone B <-> Skeleton & Memory
  // B1: bot/receive & bot/request
  { id: 'e-bot1-evbotrec', from: 'bot-1', to: 'ev-bot-rec', color: '#f59e0b', marker: 'th-arrow-amber', pts: [696, 116, 717, 116], tags: ['inbound'] },
  { id: 'e-evbotrec-bot2', from: 'ev-bot-rec', to: 'bot-2', color: '#f59e0b', marker: 'th-arrow-amber', pts: [717, 116, 696, 196], tags: ['inbound'] },
  { id: 'e-evbotrec-sk2', from: 'ev-bot-rec', to: 'sk-2', color: '#f59e0b', marker: 'th-arrow-amber', pts: [915, 116, 937, 196], tags: ['inbound'] },

  // B2: session.turn (before-model / after-model)
  { id: 'e-bot3-sk2', from: 'bot-3', to: 'ev-sess-turn', color: '#a855f7', marker: 'th-arrow-violet', pts: [696, 286, 717, 209], tags: ['inbound', 'gates'] },
  { id: 'e-sk3-evturn', from: 'sk-3', to: 'ev-sess-turn', color: '#a855f7', marker: 'th-arrow-violet', pts: [937, 284, 915, 209], tags: ['gates'] },
  { id: 'e-evturn-bot4', from: 'ev-sess-turn', to: 'bot-4', color: '#a855f7', marker: 'th-arrow-violet', pts: [717, 209, 696, 376], tags: ['gates'] },

  // B3: tool.call (before-tool / after-tool)
  { id: 'e-sk3-sk4', from: 'sk-3', to: 'sk-4', color: '#0ea5e9', marker: 'th-arrow-cyan', pts: [1041, 334, 1041, 348], tags: ['gates'] },
  { id: 'e-sk4-evtool', from: 'sk-4', to: 'ev-tool-call', color: '#0ea5e9', marker: 'th-arrow-cyan', pts: [937, 386, 915, 302], tags: ['gates'] },
  { id: 'e-evtool-bot5', from: 'ev-tool-call', to: 'bot-5', color: '#0ea5e9', marker: 'th-arrow-cyan', pts: [717, 302, 696, 456], tags: ['gates', 'outbound'] },
  { id: 'e-sk4-sk5', from: 'sk-4', to: 'sk-5', color: '#0ea5e9', marker: 'th-arrow-cyan', pts: [1041, 424, 1041, 438], tags: ['gates'] },

  // B4: memory.recall (memory/request & front-message)
  { id: 'e-bot4-evmem', from: 'bot-4', to: 'ev-mem-recall', color: '#10b981', marker: 'th-arrow-emerald', pts: [696, 395, 717, 395], tags: ['memory', 'gates'] },
  { id: 'e-evmem-mem2', from: 'ev-mem-recall', to: 'mem-2', color: '#10b981', marker: 'th-arrow-emerald', pts: [915, 395, 1171, 218], tags: ['memory', 'gates'], viaCorridor: 341 },
  { id: 'e-bot3-evmem', from: 'bot-3', to: 'ev-mem-recall', color: '#10b981', marker: 'th-arrow-emerald', pts: [696, 312, 717, 395], tags: ['memory'] },

  // B5: session/change & new-message
  { id: 'e-sk3-evstate', from: 'sk-3', to: 'ev-sess-state', color: '#f43f5e', marker: 'th-arrow-rose', pts: [937, 312, 915, 488], tags: ['outbound', 'gates'] },
  { id: 'e-evstate-bot5', from: 'ev-sess-state', to: 'bot-5', color: '#f43f5e', marker: 'th-arrow-rose', pts: [717, 488, 696, 488], tags: ['outbound'] },

  // Skeleton <-> Knowledge + Memory connections (Col 3 <-> Col 4)
  { id: 'e-sk1-sk2', from: 'sk-1', to: 'sk-2', color: '#6366f1', marker: 'th-arrow-violet', pts: [1041, 154, 1041, 168], tags: ['gates'] },
  { id: 'e-sk2-sk3', from: 'sk-2', to: 'sk-3', color: '#6366f1', marker: 'th-arrow-violet', pts: [1041, 244, 1041, 258], tags: ['gates'] },
  { id: 'e-sk2-mem1', from: 'sk-2', to: 'mem-1', color: '#10b981', marker: 'th-arrow-emerald', pts: [1145, 196, 1171, 126], tags: ['memory'] },
  { id: 'e-sk3-mem2', from: 'sk-3', to: 'mem-2', color: '#10b981', marker: 'th-arrow-emerald', pts: [1145, 282, 1171, 206], tags: ['memory', 'gates'] },
  { id: 'e-sk4-mem5', from: 'sk-4', to: 'mem-5', color: '#0ea5e9', marker: 'th-arrow-cyan', pts: [1145, 396, 1171, 476], tags: ['memory', 'gates'] },

  // Knowledge + Memory internal skewer flow
  { id: 'e-mem1-mem2', from: 'mem-1', to: 'mem-2', color: '#10b981', marker: 'th-arrow-emerald', pts: [1275, 154, 1275, 168], tags: ['memory'] },
  { id: 'e-mem2-mem3', from: 'mem-2', to: 'mem-3', color: '#10b981', marker: 'th-arrow-emerald', pts: [1275, 244, 1275, 258], tags: ['memory'] },
  { id: 'e-mem3-mem4', from: 'mem-3', to: 'mem-4', color: '#10b981', marker: 'th-arrow-emerald', pts: [1275, 334, 1275, 348], tags: ['memory'] },
  { id: 'e-mem4-mem5', from: 'mem-4', to: 'mem-5', color: '#10b981', marker: 'th-arrow-emerald', pts: [1275, 424, 1275, 438], tags: ['memory'] },
];

/** 「一条飞书消息的完整旅程」 9 步交互剧本。 */
export const TANGHULU_JOURNEY: readonly TanghuluJourneyStep[] = [
  {
    step: 1,
    label: '① 飞书接入归一化',
    focusNode: 'ch-1',
    activeNodes: ['ch-1', 'ch-2'],
    activeEdges: ['e-ch1-ch2'],
    liveMsg: "📨 [1/9 飞书长连接] 收到 im.message.receive_v1 → 去重并组装 ChannelMessage v1 (role='owner', bot='周小灵')",
  },
  {
    step: 2,
    label: '② emitInbound派发',
    focusNode: 'ch-3',
    activeNodes: ['ch-2', 'ch-3', 'ev-ch-msg'],
    activeEdges: ['e-ch2-ch3', 'e-ch3-evmsg', 'e-ch2-evmsg'],
    liveMsg: "⚡ [2/9 抽象渠道层] emitInbound 调用 getInboundEvent('group', true) → 发出串行事件 channel/mention",
  },
  {
    step: 3,
    label: '③ ◇channel.message',
    focusNode: 'ev-ch-msg',
    activeNodes: ['ch-3', 'ev-ch-msg', 'bot-1', 'ev-bot-rec', 'bot-2'],
    activeEdges: ['e-ch3-evmsg', 'e-evmsg-bot1', 'e-bot1-evbotrec', 'e-evbotrec-bot2', 'e-bot1-bot2'],
    liveMsg: '◇ [3/9 列间事件 A1] Approval 放行非批复消息 → Bots 路由至「周小灵」并发 bot/receive → 核定 owner 工作区',
  },
  {
    step: 4,
    label: '④ 前台认领入队',
    focusNode: 'bot-3',
    activeNodes: ['bot-2', 'bot-3', 'ev-sess-turn', 'sk-2', 'sk-3'],
    activeEdges: ['e-bot2-bot3', 'e-bot3-sk2', 'e-sk2-sk3'],
    liveMsg: '🍡 [4/9 前台排队] FrontDesk 定位周小灵前台会话 → 生成不可变 SourceSnapshot 排入 resultQueue → 启动 Session.run()',
  },
  {
    step: 5,
    label: '⑤ ◇session.turn调模',
    focusNode: 'ev-sess-turn',
    activeNodes: ['sk-3', 'ev-sess-turn', 'bot-4', 'ev-mem-recall', 'mem-2', 'mem-3'],
    activeEdges: ['e-sk3-evturn', 'e-evturn-bot4', 'e-bot4-evmem', 'e-evmem-mem2', 'e-sk3-mem2', 'e-mem2-mem3'],
    liveMsg: '◇ [5/9 关口一 before-model] Prompt 拼 persona.md + FrontDesk 拼近期往来 + Memory 从 Rust :30087 召回记忆 → 调 PI 模型',
  },
  {
    step: 6,
    label: '⑥ ◇tool.call查知识库',
    focusNode: 'ev-tool-call',
    activeNodes: ['sk-3', 'sk-4', 'ev-tool-call', 'mem-5', 'mem-4', 'mem-2'],
    activeEdges: ['e-sk3-sk4', 'e-sk4-evtool', 'e-sk4-mem5', 'e-mem4-mem5', 'e-mem3-mem4'],
    liveMsg: "◇ [6/9 关口三 before-tool] Approval 放行工具调用 → 执行 kb_search({query:'语舱AI'}) 检索 [[双链]] 知识库与 VGR 图谱",
  },
  {
    step: 7,
    label: '⑦ 调 channel_reply',
    focusNode: 'bot-5',
    activeNodes: ['sk-4', 'ev-tool-call', 'bot-5', 'ev-ch-reply'],
    activeEdges: ['e-sk4-evtool', 'e-evtool-bot5', 'e-bot5-evrep'],
    liveMsg: "🤖 [7/9 生成回复] 模型拿到知识库结果后调用 channel_reply(kind:'final') → ChannelTools 调用 requestChannelReply",
  },
  {
    step: 8,
    label: '⑧ ◇channel.reply回指',
    focusNode: 'ev-ch-reply',
    activeNodes: ['bot-5', 'ev-ch-reply', 'ch-4', 'ch-5', 'mem-1'],
    activeEdges: ['e-bot5-evrep', 'e-evrep-ch4', 'e-ch4-ch5', 'e-evrep-ch5', 'e-sk2-mem1'],
    liveMsg: '◀ [8/9 列间事件 A3] ◇ channel.reply 向左回指 Channels → FeishuReply 发飞书群并撤敲键盘表情 → 回传 channel/replied',
  },
  {
    step: 9,
    label: '⑨ session/change收尾',
    focusNode: 'ev-sess-state',
    activeNodes: ['sk-3', 'ev-sess-state', 'bot-5', 'mem-1'],
    activeEdges: ['e-sk3-evstate', 'e-evstate-bot5', 'e-sk2-mem1'],
    liveMsg: '✅ [9/9 轮次收尾] Session.change 置为 done 并发出通知 → DispatchResults 核对回执发出 bot/settled，推进队列下一条！',
  },
];

/**
 * 计算某个节点在有向图中的 1~2 跳上游节点、下游节点与激活连线集合。
 * @param nodeId 目标节点 ID。
 */
export function getConnectedTanghuluChain(nodeId: string): {
  upstreamNodes: Set<string>;
  downstreamNodes: Set<string>;
  activeEdgeIds: Set<string>;
} {
  const upstreamNodes = new Set<string>();
  const downstreamNodes = new Set<string>();
  const activeEdgeIds = new Set<string>();

  for (const edge of TANGHULU_EDGES) {
    if (edge.to === nodeId) {
      upstreamNodes.add(edge.from);
      activeEdgeIds.add(edge.id);
    }
    if (edge.from === nodeId) {
      downstreamNodes.add(edge.to);
      activeEdgeIds.add(edge.id);
    }
  }

  for (const edge of TANGHULU_EDGES) {
    if (upstreamNodes.has(edge.to) && !downstreamNodes.has(edge.from) && edge.from !== nodeId) {
      upstreamNodes.add(edge.from);
      activeEdgeIds.add(edge.id);
    }
    if (downstreamNodes.has(edge.from) && !upstreamNodes.has(edge.to) && edge.to !== nodeId) {
      downstreamNodes.add(edge.to);
      activeEdgeIds.add(edge.id);
    }
  }

  return { upstreamNodes, downstreamNodes, activeEdgeIds };
}

/**
 * 生成单条连线的 SVG Path d 属性。
 * @param edge 连线规格。
 */
export function buildTanghuluEdgePath(edge: TanghuluEdgeSpec): string {
  const [x1, y1, x2, y2] = edge.pts;
  if (Math.abs(x1 - x2) < 3) {
    return `M ${String(x1)} ${String(y1)} L ${String(x2)} ${String(y2)}`;
  }
  if (edge.viaCorridor !== undefined) {
    const cy = edge.viaCorridor;
    return `M ${String(x1)} ${String(y1)} C ${String(x1 + 35)} ${String(y1)}, ${String(x1 + 25)} ${String(cy)}, ${String(x1 + 65)} ${String(cy)} L ${String(x2 - 45)} ${String(cy)} C ${String(x2 - 15)} ${String(cy)}, ${String(x2 - 25)} ${String(y2)}, ${String(x2)} ${String(y2)}`;
  }
  const dx = Math.abs(x2 - x1) * 0.52;
  let c1x = x1 - dx;
  let c2x = x2 + dx;
  if (x2 >= x1) {
    c1x = x1 + dx;
    c2x = x2 - dx;
  }
  return `M ${String(x1)} ${String(y1)} C ${String(c1x)} ${String(y1)}, ${String(c2x)} ${String(y2)}, ${String(x2)} ${String(y2)}`;
}
