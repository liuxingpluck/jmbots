/**
 * 渠道与机器人解耦的事件与回执协议（接口 A，骨架级通用协议）。
 * 这里只定义跨插件共用的事件、标准数据结构与无状态纯工具函数，不挂服务、不管机器人认领与前台队列：
 *   - channel/message(message, control)：渠道收到原始消息并落盘后发出；approval 消息级指令先消费一次，bots 按 targetBots 逐个独立认领；
 *   - channel/reply(request) ↔ channel/replied(event)：回复工具或系统提醒发回复请求，匹配的渠道发完回发回执；
 *   - channel/settled(event)：一轮 channel_tool 收尾后发出通知；
 *   - channel/history(request) ↔ channel/history-result(event)：历史工具按绑定来源快照请求本聊天历史，渠道回传授权范围内的结果；
 *   - channel/recall(event)：渠道收到本人或原发送人撤回消息后发出，bots 停掉该消息正在跑或排队的任务与派出的后台会话。
 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as textModule from './utils/Text.ts';
import * as workspaceModule from './utils/Workspace.ts';


/** 渠道标准角色档位；身份证明缺失时一律回退 guest。 */
export type ChannelRole = 'owner' | 'guest' | 'builder';

/** 聊天种类。 */
export type ChannelChatType = 'p2p' | 'group' | 'local';

/** 回复轮里的回复类别。 */
export type ReplyKind = 'progress' | 'final';

/** v2 渠道发送回执状态；与 acceptResult 的 queued / duplicate 严格区分。 */
export type ReplyStatus = 'queued' | 'sent' | 'draft' | 'partial' | 'uncertain' | 'rejected';

/** 历史查询模式。 */
export type ChannelHistoryMode = 'current' | 'mentions' | 'visible';


/** 消息里的 @ 提及。 */
export interface ChannelMention {
  /** 原始文本占位符（例如 @_user_1）。 */
  token?: string;
  /** 平台原始被 @ 用户 ID。 */
  id: string;
  /** 平台或配置解析出来的名字。 */
  name?: string;
  /** 经可信配置映射到的目标机器人名列表。 */
  botNames: string[];
}


/** 渠道收到的原始附件描述（落在渠道目录，不直接指向任意本机路径）。 */
export interface ChannelAttachment {
  /** 附件稳定标识。 */
  id: string;
  /** 原始或清洗前的展示文件名。 */
  name: string;
  /** MIME 类型（可用时）。 */
  mime?: string;
  /** 字节大小（可用时）。 */
  size?: number;
  /** 渠道侧落盘引用路径（内部物化使用，历史工具不对外暴露本机路径）。 */
  sourceRef: string;
  /** 渠道下载是否成功。 */
  state: 'available' | 'unavailable';
  /** 下载失败原因。 */
  reason?: string;
}


/** 原始引用消息指向。 */
export interface ChannelReplyTo {
  /** 标准 messageId（可用时）。 */
  messageId?: string;
  /** 平台原始消息 ID。 */
  nativeId?: string;
}


/** 不可变的来源兼容地址。 */
export interface ChannelOrigin {
  /** 渠道名（feishu / wechat / http / cli）。 */
  channel: string;
  /** 深拷贝的原渠道地址对象。 */
  address: Record<string, unknown>;
}


/** 来源可见域与授权范围。 */
export interface ChannelVisibility {
  /** 作用域字符串描述。 */
  scope: string;
  /** 是否受信任作用域（如私聊或 trusted 群）。 */
  trusted: boolean;
  /** 显式配置的公共源白名单。 */
  publicSourceIds: string[];
}


/** 单机器人路由附带信息。 */
export interface BotRoutingHint {
  /** 该机器人在这条消息上是否仅监听当背景。 */
  listenOnly: boolean;
  /** 是否由决策模型判断是否接话。 */
  judge?: boolean;
}


/** 渠道路由建议。 */
export interface ChannelRouting {
  /** 默认是否仅监听当背景。 */
  listenOnly: boolean;
  /** 默认是否由决策模型判断。 */
  judge?: boolean;
  /** 服务端校验过的指定会话号：bots 只投给这场会话的机器人、进这场会话（网页“发给哪个会话”、引用别的渠道的消息）。 */
  sessionId?: string;
  /** 引用别的渠道的消息时，被引那条的原渠道、原机器人、原会话（入口校验过）；只作记录，回话照旧回本条来源。 */
  replyOrigin?: { source: string; bot: string; sessionId: string };
  /** 一轮一次 channel_reply 都没调时，把最后的话当 final 直接发出去（一对一的渠道：网页、命令行、微信）；不写走修复轮。 */
  autoFinal?: boolean;
  /** 多机器人场景下每个机器人各自的监听/判断覆盖项。 */
  byBot?: Record<string, BotRoutingHint>;
}


/** 网页发话时附带的当前查看上下文（供 131 接入 POST /api/message 的 view 后填入）。 */
export interface ChannelView {
  /** 网页当前正在查看的渠道名（feishu / wechat / http / cli）。 */
  channel: string;
  /** 网页当前正在查看的聊天标识；看的是整个渠道时是 ''。 */
  chat: string;
  /** 给人看的名字（web-api 照 /api/channels 的清单填）：“飞书·群·测试群”“飞书·全部聊天”；前台这一轮的提示里用它。 */
  label?: string;
}


/** 渠道发出的标准消息（v: 1）。 */
export interface ChannelMessage {
  /** 协议版本。 */
  v: 1;
  /** 渠道范围稳定 ID：推荐 JSON.stringify([channel, accountId, nativeId])。 */
  messageId: string;
  /** 平台原始消息 ID；无原生 ID 时首次生成 UUID 持久复用。 */
  nativeId: string | null;
  /** 渠道名：feishu / wechat / http / cli。 */
  channel: string;
  /** 平台账号 ID：飞书 appId、微信 account 等。 */
  accountId: string;
  /** 聊天稳定 ID。 */
  chatId: string;
  /** 聊天种类。 */
  chatType: ChannelChatType;
  /** 发送者渠道原始 ID 和展示名。 */
  sender: { id: string; name?: string };
  /** 身份档位：由平台可信配置算得，缺证明时为 guest。 */
  role: ChannelRole;
  /** 经可信配置和 @ 映射规范化去重后的目标机器人名单。 */
  targetBots: string[];
  /** @ 提及列表。 */
  mentions: ChannelMention[];
  /** 保留原始可读文本。 */
  rawText: string;
  /** 面向模型的规范化文本（不再用 @本机路径 触发外发附件）。 */
  text: string;
  /** 渠道保存的附件列表。 */
  attachments: ChannelAttachment[];
  /** 平台原始创建时间（UTC 毫秒）；缺失时用 receivedAt。 */
  createdAt: number;
  /** 本机收到时间（UTC 毫秒）。 */
  receivedAt: number;
  /** createdAt 的来源。 */
  timeSource: 'provider' | 'received';
  /** 引用原消息（没有为 null）。 */
  replyTo: ChannelReplyTo | null;
  /** 不可变深拷贝的原渠道兼容地址。 */
  origin: ChannelOrigin;
  /** 渠道与权限插件计算出的授权范围。 */
  visibility: ChannelVisibility;
  /** 群监听与路由线索。 */
  routing: ChannelRouting;
  /** 网页当前正在查看的渠道与聊天上下文（可选，131 接入后填入，本人查历史未传参时默认取它）。 */
  view?: ChannelView;
}


/** 单机器人在 channel/message 里的认领记录（供渠道流水与测试核对，不混用全局 handled）。 */
export interface ChannelClaimRecord {
  /** 机器人名。 */
  bot: string;
  /** 认领幂等键 JSON.stringify([messageId, bot])。 */
  claimKey: string;
  /** 认领结论。 */
  status: 'claimed' | 'duplicate' | 'listen' | 'handled' | 'relay';
  /** 接入的会话种类（可用时）。 */
  sessionKind?: string;
  /** 接入的会话号（可用时）。 */
  sessionId?: string;
  /** judge 结论（如 judge:回 / judge:不回）。 */
  judged?: string;
}


/** 随 channel/message 传递的可变协调对象。 */
export interface ChannelMessageControl {
  /** approval 消息级命令（如“同意 3”）已消费整条消息，不再进任何机器人会话。 */
  approvalHandled?: boolean;
  /** 每个机器人独立认领写入的结果列表。 */
  claims: ChannelClaimRecord[];
}


/** 不可变的每轮来源绑定快照。 */
export interface SourceSnapshot {
  /** 标准消息 ID。 */
  messageId: string;
  /** 平台原始消息 ID。 */
  nativeId: string | null;
  /** 渠道名。 */
  channel: string;
  /** 账号 ID。 */
  accountId: string;
  /** 聊天 ID。 */
  chatId: string;
  /** 聊天种类。 */
  chatType: ChannelChatType;
  /** 发送者原始 ID。 */
  senderId: string;
  /** 发送者名字（可用时）。 */
  senderName?: string;
  /** 身份档位。 */
  role: ChannelRole;
  /** 原消息的目标机器人清单。 */
  targetBots: string[];
  /** 原消息的 @ 提及清单。 */
  mentions: ChannelMention[];
  /** 不可变深拷贝原渠道地址快照。 */
  origin: ChannelOrigin;
  /** 来源可见域快照。 */
  visibility: ChannelVisibility;
  /** 当前认领并执行这轮的机器人名。 */
  botName: string;
  /** 认领键 JSON.stringify([messageId, botName])。 */
  claimKey: string;
  /** 当前轮回复键 JSON.stringify([messageId, botName, roundId])。 */
  replyRoundKey: string;
  /** 网页当前正在查看的渠道与聊天上下文（可选，131 接入后填入，本人查历史未传参时默认取它）。 */
  view?: ChannelView;
}


/** 回复内容片段。 */
export interface ReplyPartInput {
  /** 片段 ID。 */
  partId: string;
  /** 片段种类。 */
  kind: 'text' | 'attachment';
  /** 纯文本正文。 */
  text?: string;
  /** 已授权附件 ID。 */
  artifactId?: string;
}


/** 回复回执里单个片段的发送状态。 */
export interface ReplyReceiptPart {
  /** 片段 ID。 */
  partId: string;
  /** 片段种类。 */
  kind: 'text' | 'attachment';
  /** 片段回执状态。 */
  status: ReplyStatus;
  /** 平台返回的消息号。 */
  providerId?: string;
  /** 失败或说明原因。 */
  reason?: string;
}


/** 标准渠道回复回执（v: 2）。 */
export interface ReplyReceipt {
  /** 协议版本。 */
  v: 2;
  /** 是否整体成功（sent / queued 且请求无冲突时 true；draft/rejected/uncertain/partial 时看具体语义，sent/queued 为 true）。 */
  ok: boolean;
  /** 细粒度回执状态。 */
  status: ReplyStatus;
  /** 回复请求幂等键 JSON.stringify([replyRoundKey, callId])。 */
  replyRequestKey: string;
  /** 所属轮回复键。 */
  replyRoundKey: string;
  /** 本轮从 0 起的回复序号；同键重试不递增。 */
  replyIndex: number;
  /** 中途进度还是最终答复。 */
  kind: ReplyKind;
  /** 各片段状态明细。 */
  parts: ReplyReceiptPart[];
  /** 平台消息号列表（sent 时返回）。 */
  messageIds?: string[];
  /** 渠道侧排队凭证（queued 时返回）。 */
  receiptId?: string;
  /** 说明或失败原因。 */
  reason?: string;
  /** 完成时间戳（UTC 毫秒）。 */
  at: number;
}


/** 跨渠道或跨聊天发话时附带的目标描述（由目标渠道自行识别聊天）。 */
export interface ChannelReplyTarget {
  /** 规范化后的目标渠道名（feishu / wechat / http / cli）。 */
  channel: string;
  /** 调用方给出的原始聊天标识或名称（如群号、群名、本机等），由目标渠道自己认。 */
  chat: string;
}


/** 事件 channel/reply 请求载荷。 */
export interface ChannelReplyRequest {
  /** 单次事件往返局部关联 ID。 */
  requestId: string;
  /** 渠道名（feishu / wechat / http / cli）。 */
  channel: string;
  /** 当前机器人名。 */
  bot: string;
  /** 回复请求幂等键。 */
  replyRequestKey: string;
  /** 回复轮键。 */
  replyRoundKey: string;
  /** 本轮内序号。 */
  replyIndex: number;
  /** 回复类别：progress | final。 */
  kind: ReplyKind;
  /** 发送模式：纯文字或附件。 */
  mode: 'text' | 'attachment';
  /** 不可变来源快照。 */
  sourceSnapshot: SourceSnapshot;
  /** 请求正文摘要，用于同键冲突校验。 */
  payloadHash: string;
  /** 发送片段列表。 */
  parts: ReplyPartInput[];
  /** 跨渠道或跨聊天发送目标；未指定别处时为 undefined，沿用 sourceSnapshot。 */
  target?: ChannelReplyTarget;
  /** 负责处理的渠道插件置 true，区分“无人监听该渠道”。 */
  handled?: boolean;
}


/** 事件 channel/replied 响应载荷。 */
export interface ChannelRepliedEvent {
  /** 对应请求的 requestId。 */
  requestId: string;
  /** 对应回复轮键。 */
  replyRoundKey: string;
  /** 发送回执。 */
  receipt: ReplyReceipt;
}


/** 渠道历史查询摘要项（不暴露未授权本机源路径）。 */
export interface ChannelHistoryItem {
  /** 标准消息 ID。 */
  messageId: string;
  /** 平台原始消息 ID。 */
  nativeId: string | null;
  /** 消息方向：user 入站 / bot 出站。 */
  direction: 'user' | 'bot';
  /** 毫秒时间戳。 */
  createdAt: number;
  /** 发送者原始 ID 与名字。 */
  sender: { id: string; name?: string };
  /** 可见文本内容。 */
  text: string;
  /** @ 提及列表。 */
  mentions: ChannelMention[];
  /** 脱敏后的附件元数据（不含源文件系统路径）。 */
  attachments: Array<{ id: string; name: string; mime?: string; size?: number; state: 'available' | 'unavailable' }>;
}


/** 渠道历史错误对象。 */
export interface ChannelHistoryError {
  /** 错误码（例如 invalid_cursor / identity_unresolved / forbidden / channel_unavailable）。 */
  code: string;
  /** 中文错误说明。 */
  message: string;
}


/** 渠道历史工具返回与事件结果。 */
export interface ChannelHistoryResult {
  /** 是否成功。 */
  ok: boolean;
  /** 消息摘要数组（时间升序，较早在前）。 */
  items: ChannelHistoryItem[];
  /** 下一页游标（绑定聊天/模式/发送人条件，无更早消息为 null）。 */
  nextCursor: string | null;
  /** 实际生效查询范围说明。 */
  scope: string;
  /** 完整性标示。 */
  completeness: 'complete' | 'local_only' | 'unsupported';
  /** 失败详情。 */
  error?: ChannelHistoryError;
}


/** 事件 channel/history 请求载荷。 */
export interface ChannelHistoryRequest {
  /** 单次事件往返局部关联 ID。 */
  requestId: string;
  /** 渠道名。 */
  channel: string;
  /** 不可变来源快照。 */
  sourceSnapshot: SourceSnapshot;
  /** 查询模式。 */
  mode: ChannelHistoryMode;
  /** 可选指定聊天（需在授权范围内）。 */
  chatId?: string;
  /** 可选过滤发送者原始 ID（visible 模式必填）。 */
  senderId?: string;
  /** 返回条数上限（已校验 1..200）。 */
  limit: number;
  /** 可选不透明翻页游标。 */
  before?: string;
  /** 渠道插件接单后置 true。 */
  handled?: boolean;
}


/** 事件 channel/history-result 响应载荷。 */
export interface ChannelHistoryResultEvent extends ChannelHistoryResult {
  /** 对应请求的 requestId。 */
  requestId: string;
}


/** 一轮 channel_tool 收尾的通知（channel/settled）。 */
export interface ChannelSettledEvent {
  /** 这一轮的来源快照：渠道照 channel、origin.address 认出是自己哪条消息。 */
  sourceSnapshot: SourceSnapshot;
  /** 收尾结果：sent 发完（或本来就不用发）；partial、uncertain、rejected 没发成；sending 渠道排队或草稿。 */
  stage: 'sent' | 'partial' | 'uncertain' | 'rejected' | 'sending';
  /** 原因；没有是空串。 */
  note: string;
}


/** 事件 channel/recall 载荷：渠道收到消息撤回通知后发出，bots 停掉该消息正在跑或排队的任务。 */
export interface ChannelRecallEvent {
  /** 渠道名（feishu / wechat / http / cli）。 */
  channel: string;
  /** 平台账号 ID（如飞书 appId）。 */
  accountId: string;
  /** 聊天稳定 ID。 */
  chatId: string;
  /** 被撤回的原消息标准 ID：makeChannelMessageId(channel, accountId, nativeId)。 */
  messageId: string;
  /** 平台原始消息 ID（可用时）。 */
  nativeId?: string;
  /** 谁撤回的：由渠道根据可信身份配置与本地聊天日志核定。 */
  recalledBy: {
    /** 撤回人渠道原始 ID（平台仅返回 message_owner 且本地尚未落盘时为空串）。 */
    id: string;
    /** 撤回身份类别：sender 原发消息人自撤，owner 本人撤回。 */
    kind: 'sender' | 'owner';
    /** 撤回人是否为系统登记的本人（owner）。 */
    isOwner: boolean;
  };
}


declare module 'cordis' {
  interface Events {
    /** 渠道收到消息并存下原件后发出：approval 消息级命令先看，随后 bots 按 targetBots 逐个独立认领。 */
    'channel/message'(message: ChannelMessage, control?: ChannelMessageControl): void | Promise<void>;
    /** 渠道回复工具或系统发话发出：匹配 channel 的渠道插件发完后回发 channel/replied。 */
    'channel/reply'(request: ChannelReplyRequest): void | Promise<void>;
    /** 渠道回复发完或确认失败后回传回执。 */
    'channel/replied'(event: ChannelRepliedEvent): void;
    /** 一轮 channel_tool 收尾了（只是通知，bots 的 Dispatch 发）：网页把那条标成回完，命令行出错时记退出码。 */
    'channel/settled'(event: ChannelSettledEvent): void;
    /** 渠道历史工具发出：匹配 channel 的渠道插件在授权范围内查询并回传 channel/history-result。 */
    'channel/history'(request: ChannelHistoryRequest): void | Promise<void>;
    /** 渠道历史查询结果回传。 */
    'channel/history-result'(event: ChannelHistoryResultEvent): void;
    /** 渠道收到本人或原发信人撤回消息后发出：bots 停掉该消息正在跑的会话、移除排队项并停掉其派出的后台会话。 */
    'channel/recall'(event: ChannelRecallEvent): void | Promise<void>;
  }
}


/** 默认游标签名密钥（同一进程周期内校验跨聊天/防篡改游标）。 */
const CURSOR_SECRET = crypto.randomBytes(32);


/**
 * 计算消息认领去重键。
 * @param messageId 标准消息 ID。
 * @param botName 机器人名。
 * @returns JSON 编码的去重键。
 */
export function getClaimKey(messageId: string, botName: string): string {
  return JSON.stringify([messageId, botName]);
}


/**
 * 计算某一轮回复键。
 * @param messageId 标准消息 ID。
 * @param botName 机器人名。
 * @param roundId 轮标识（初始用户输入为 'receive'，交回结果为结果键）。
 * @returns JSON 编码的回复轮键。
 */
export function getReplyRoundKey(messageId: string, botName: string, roundId: string): string {
  return JSON.stringify([messageId, botName, roundId]);
}


/**
 * 计算单次回复工具调用的幂等键。
 * @param replyRoundKey 回复轮键。
 * @param callId 工具调用 ID 或持久业务键。
 * @returns JSON 编码的回复请求幂等键。
 */
export function getReplyRequestKey(replyRoundKey: string, callId: string): string {
  return JSON.stringify([replyRoundKey, callId]);
}


/**
 * 计算发送请求正文摘要，用于同键防篡改/防冲突核对。
 * @param value 任意结构化载荷。
 * @returns 16 位十六进制 sha256 摘要。
 */
export function getPayloadHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}


/** 签名游标载荷：绑定边界防止跨聊天/跨条件篡改。 */
export interface HistoryCursorPayload {
  /** 本页最早一条的 createdAt。 */
  beforeAt: number;
  /** 本页最早一条的 messageId。 */
  beforeId: string;
  /** 绑定渠道。 */
  channel: string;
  /** 绑定账号。 */
  accountId: string;
  /** 绑定聊天。 */
  chatId: string;
  /** 绑定模式。 */
  mode: ChannelHistoryMode;
  /** 绑定发送者（visible 模式）。 */
  senderId: string;
  /** 绑定机器人。 */
  botName: string;
}


/**
 * 对历史翻页游标签名编码。
 * @param payload 游标载荷与绑定边界。
 * @returns 不透明签名游标字符串。
 */
export function encodeHistoryCursor(payload: HistoryCursorPayload): string {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', CURSOR_SECRET).update(raw).digest('base64url');
  return `${raw}.${sig}`;
}


/**
 * 解码并校验历史翻页游标，验证签名且边界与当前查询严格一致。
 * @param cursor 不透明游标。
 * @param expected 预期的绑定边界。
 * @returns 校验通过的载荷，失败返回 undefined。
 */
export function decodeHistoryCursor(
  cursor: string,
  expected: Omit<HistoryCursorPayload, 'beforeAt' | 'beforeId'>,
): HistoryCursorPayload | undefined {
  const dot = cursor.indexOf('.');
  if (dot <= 0) return undefined;

  const raw = cursor.slice(0, dot);
  const sig = cursor.slice(dot + 1);
  const actualSig = crypto.createHmac('sha256', CURSOR_SECRET).update(raw).digest('base64url');
  if (sig.length !== actualSig.length) return undefined;

  const validSig = crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(actualSig, 'utf8'));
  if (!validSig) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<HistoryCursorPayload>;
    if (typeof parsed.beforeAt !== 'number' || typeof parsed.beforeId !== 'string') return undefined;
    if (parsed.channel !== expected.channel || parsed.accountId !== expected.accountId) return undefined;
    if (parsed.chatId !== expected.chatId || parsed.mode !== expected.mode) return undefined;
    if (parsed.senderId !== expected.senderId || parsed.botName !== expected.botName) return undefined;
    return parsed as HistoryCursorPayload;
  } catch {
    return undefined;
  }
}


/** 共用渠道历史分页函数的入参。 */
export interface PaginateHistoryInput {
  /** 渠道历史查询请求。 */
  request: ChannelHistoryRequest;
  /** 实际命中的渠道名。 */
  channel: string;
  /** 实际命中的渠道账号 ID。 */
  accountId: string;
  /** 实际命中的聊天 ID。 */
  chatId: string;
  /** 已映射好的标准历史摘要项列表。 */
  entries: ChannelHistoryItem[];
}


/**
 * 统一判定当前来源快照是否拥有本人（owner）跨渠道、跨聊天查询历史的权限。
 * 外人（地址含 guest / builder 或 owner: false）一律拒绝；飞书 owner 放行；本机网页和命令行默认视为本人。
 * @param snapshot 不可变来源快照。
 * @returns 是本人返回 true，外人返回 false。
 */
export function isHistoryOwner(snapshot: SourceSnapshot): boolean {
  //G 回话地址显式标为非本人（guest、builder 或 owner: false）时一律禁止越界。
  if (workspaceModule.isOther(snapshot.origin.address)) return false;

  //G 群聊里本人说话也不跨：取到的别处历史会回到群里，群里的外人能看到（11-18 中控补）。
  if (snapshot.chatType === 'group') return false;

  //M 飞书等渠道已验证为 owner 档位时允许跨渠道、跨聊天查询。
  if (snapshot.role === 'owner') return true;

  //M 本机网页与命令行入口未标记为外人时默认视为本人操作。
  const isLocalChannel = snapshot.channel === 'http' || snapshot.channel === 'cli';
  if (isLocalChannel && snapshot.chatType === 'local' && snapshot.role !== 'builder') return true;

  return false;
}


/**
 * 按渠道标准协议校验翻页游标、按模式过滤、按 (createdAt, messageId) 升序稳定分页并生成下一页签名游标。
 * @param input 分页入参（请求、渠道、账号、聊天与候选摘要项）。
 * @returns 标准渠道历史结果。
 */
export function paginateChannelHistory(input: PaginateHistoryInput): ChannelHistoryResult {
  const snapshot = input.request.sourceSnapshot;
  /** 实际查询作用域描述，固定为 channel:accountId:chatId。 */
  const scope = `${input.channel}:${input.accountId}:${input.chatId}`;
  /** 预期发送者过滤键（非 visible 模式固定为空串）。 */
  const expectedSenderId = input.request.senderId ?? '';
  let decodedCursor: HistoryCursorPayload | undefined;

  //G 传入翻页游标时严格核验签名及绑定边界。
  if (input.request.before !== undefined && input.request.before !== '') {
    decodedCursor = decodeHistoryCursor(input.request.before, {
      channel: input.channel,
      accountId: input.accountId,
      chatId: input.chatId,
      mode: input.request.mode,
      senderId: expectedSenderId,
      botName: snapshot.botName,
    });
    if (decodedCursor === undefined) {
      return {
        ok: false,
        items: [],
        nextCursor: null,
        scope,
        completeness: 'local_only',
        error: { code: 'invalid_cursor', message: '历史翻页游标无效或与当前查询范围不匹配' },
      };
    }
  }

  //M 按查询模式筛选候选消息。
  let filtered = input.entries;
  if (input.request.mode === 'visible') {
    filtered = input.entries.filter((entry) => entry.sender.id === expectedSenderId);
  }

  //M 按 (createdAt, messageId) 稳定升序排列，再严格切取游标之前最近 limit 条。
  const sorted = [...filtered].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.messageId < b.messageId) return -1;
    if (a.messageId > b.messageId) return 1;
    return 0;
  });

  let bounded = sorted;
  if (decodedCursor !== undefined) {
    const cursorAt = decodedCursor.beforeAt;
    const cursorId = decodedCursor.beforeId;
    bounded = sorted.filter((entry) => {
      if (entry.createdAt < cursorAt) return true;

      return entry.createdAt === cursorAt && entry.messageId < cursorId;
    });
  }

  const page = bounded.slice(-input.request.limit);
  let nextCursor: string | null = null;
  const first = page[0];
  if (bounded.length > page.length && first !== undefined) {
    //M 还有更早的历史项时，以本页最早一条构造并签名下一页翻页游标。
    nextCursor = encodeHistoryCursor({
      beforeAt: first.createdAt,
      beforeId: first.messageId,
      channel: input.channel,
      accountId: input.accountId,
      chatId: input.chatId,
      mode: input.request.mode,
      senderId: expectedSenderId,
      botName: snapshot.botName,
    });
  }

  return {
    ok: true,
    items: page,
    nextCursor,
    scope,
    completeness: 'local_only',
  };
}


/**
 * 从不可变 SourceSnapshot 或已知标准消息字段构建标准前缀请求，发出 channel/reply 并按 requestId 等待 channel/replied。
 * 没有渠道插件接单（handled !== true）时立即返回 rejected（channel_unavailable）；超时返回 uncertain，绝不伪造 sent。
 * @param ctx Cordis 上下文。
 * @param req 回复请求。
 * @param timeoutMs 最长等待毫秒数。
 * @returns v2 发送回执。
 */
export async function requestChannelReply(
  ctx: cordis.Context,
  req: Omit<ChannelReplyRequest, 'requestId'>,
  timeoutMs = 30_000,
): Promise<ReplyReceipt> {
  const requestId = `rep_${crypto.randomUUID()}`;
  const fullRequest: ChannelReplyRequest = { ...req, requestId };

  return await new Promise<ReplyReceipt>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispose: () => void = () => undefined;

    const finish = (receipt: ReplyReceipt): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      dispose();
      resolve(receipt);
    };

    //M 监听匹配本请求 requestId 的渠道回执事件，收到后第一时间收口并返回回执。
    dispose = ctx.on('channel/replied', (event) => {
      if (event.requestId !== requestId) return;
      //M 收到匹配的发送回执后立即结束等待。
      finish(event.receipt);
    });

    //G 超过约定等待时间仍未收到回执时，返回 uncertain 状态，绝不伪造成功回执。
    timer = setTimeout(() => {
      finish({
        v: 2,
        ok: false,
        status: 'uncertain',
        replyRequestKey: req.replyRequestKey,
        replyRoundKey: req.replyRoundKey,
        replyIndex: req.replyIndex,
        kind: req.kind,
        parts: req.parts.map((part) => ({ partId: part.partId, kind: part.kind, status: 'uncertain', reason: '等待渠道发送回执超时' })),
        reason: '等待渠道发送回执超时',
        at: Date.now(),
      });
    }, timeoutMs);

    //M 串行通知渠道插件投递回复；无人接单时立回 rejected，抛错时回 uncertain。
    void ctx.serial('channel/reply', fullRequest).then(() => {
      if (settled) return;
      if (fullRequest.handled === true) return;

      //G 没有任何渠道接单时直接回报明确原因，不伪造发送成功。
      const unhandledReason = `channel_unavailable：渠道 ${req.channel} 没挂`;
      finish({
        v: 2,
        ok: false,
        status: 'rejected',
        replyRequestKey: req.replyRequestKey,
        replyRoundKey: req.replyRoundKey,
        replyIndex: req.replyIndex,
        kind: req.kind,
        parts: req.parts.map((part) => ({ partId: part.partId, kind: part.kind, status: 'rejected', reason: unhandledReason })),
        reason: unhandledReason,
        at: Date.now(),
      });
    }).catch((error: unknown) => {
      let reason = String(error);
      if (error instanceof Error) {
        reason = error.message;
      }
      //M 派发异常无法确认对方是否收到，统一以 uncertain 状态收口。
      finish({
        v: 2,
        ok: false,
        status: 'uncertain',
        replyRequestKey: req.replyRequestKey,
        replyRoundKey: req.replyRoundKey,
        replyIndex: req.replyIndex,
        kind: req.kind,
        parts: req.parts.map((part) => ({ partId: part.partId, kind: part.kind, status: 'uncertain', reason })),
        reason,
        at: Date.now(),
      });
    });
  });
}


/** 渠道直发后交回的结果；不交回的（命令行、网页、内置微信）算已发。外部程序（programs 转过去的）会回草稿、失败或不确定。 */
export interface TextReplyOutcome {
  /** sent 已发、draft 已存草稿、rejected 明确没发、uncertain 不知道发没发到。 */
  status: 'sent' | 'draft' | 'rejected' | 'uncertain';
  /** 原因或说明；已发时可以没有。 */
  reason?: string;
}


/** 只发纯文字的渠道（命令行、网页、微信）接 channel/reply 用的适配器：模型的 channel_reply、零次兜底、approval 的直回都从这里出去。 */
export interface TextReplyAdapter {
  /** 渠道名（cli / wechat / http）。 */
  channel: string;
  /**
   * 可选的跨渠道/跨聊天“认聊天”回调：当 request.target 存在时调用。
   * 认出聊天时交回解析后的渠道地址对象；认不出时交回 undefined，由 registerTextReply 统一回 rejected（“没有叫 X 的聊天”）。
   */
  getTargetAddress?: (chat: string, request: ChannelReplyRequest) => Record<string, unknown> | undefined;
  /**
   * 把纯文字直接送回原渠道（跨渠道时 targetAddress 为 getTargetAddress 返回的目标地址），不能再通过 bots.route 自动触发模型或重复回环。
   * 交回 TextReplyOutcome 时照它写回执；不交回算已发。
   */
  sendDirectText: (
    text: string,
    request: ChannelReplyRequest,
    targetAddress?: Record<string, unknown>,
  ) => void | TextReplyOutcome | Promise<void | TextReplyOutcome>;
}


/** 渠道认跨渠道发话的目标聊天时，拆好的目标串（parseChatTarget 交回）。 */
export interface ChatTarget {
  /** trim 后的整串。 */
  exact: string;
  /** 去掉展示前缀（如“微信·”）的整串，按名字认聊天用；拆出“前缀:聊天”后要不要换成 chat 由渠道定。 */
  label: string;
  /** “前缀:聊天”写法冒号左边（trim 后）；不是这种写法是空串。前缀代表应用号、账号还是渠道名，由渠道自己认。 */
  prefix: string;
  /** “前缀:聊天”写法冒号右边（trim 后）；不是这种写法是空串。 */
  chat: string;
}


/** 一个候选聊天：渠道从自己的数据里拼出来，交给 pickChat 认。 */
export interface ChatCandidate<T> {
  /** 能认出它的号（群号、聊天号、open_id 等）。 */
  ids: string[];
  /** 能认出它的名字（群名、人名）；空串不参与比对。 */
  names: string[];
  /** 认中后交回的东西（渠道自己的地址片段）。 */
  value: T;
}


/**
 * 拆跨渠道发话的目标串：trim、去掉网页展示的渠道前缀、拆出“前缀:聊天”。
 * @param raw 调用方给的原始聊天串。
 * @param labelPrefixes 渠道的展示前缀（如“飞书·群·”“微信·”），命中第一个就去掉。
 * @returns 拆好的目标串。
 */
export function parseChatTarget(raw: string, labelPrefixes: string[]): ChatTarget {
  const exact = raw.trim();

  //M 去掉网页展示名前面带的渠道前缀，剩下的按名字认。
  let label = exact;
  const labelPrefix = labelPrefixes.find((one) => exact.startsWith(one));
  if (labelPrefix !== undefined) {
    label = exact.slice(labelPrefix.length);
  }

  //M “前缀:聊天”写法：冒号不在开头、两边去空白后都不空才算。
  const plain = { exact, label, prefix: '', chat: '' };
  const sep = exact.indexOf(':');
  if (sep <= 0) return plain;

  const prefix = exact.slice(0, sep).trim();
  const chat = exact.slice(sep + 1).trim();
  if (prefix === '' || chat === '') return plain;

  return { exact, label, prefix, chat };
}


/**
 * 在候选清单里认聊天：按先后看，号对上、或名字（不空）对上的第一个就是。
 * 候选可以边认边拼（生成器）：认到就停，排在后面的来源不再读。
 * @param candidates 渠道拼出的候选，排在前面的优先。
 * @param id 要找的号。
 * @param name 要找的名字。
 * @returns 认中的那个候选带的 value；都没对上是 undefined。
 */
export function pickChat<T>(candidates: Iterable<ChatCandidate<T>>, id: string, name: string): T | undefined {
  for (const candidate of candidates) {
    //M 号对上就是它。
    if (candidate.ids.includes(id)) return candidate.value;

    //M 名字对上也算；空名字不算，免得空串认错。
    const sameName = candidate.names.some((one) => one !== '' && one === name);
    if (sameName) return candidate.value;
  }
  return undefined;
}


/**
 * 认不出目标聊天时的原因文字（registerTextReply 和自己认聊天的飞书共用）。
 * @param chat 调用方给的原始聊天串。
 * @returns “chat_not_found：没有叫 X 的聊天”，X 是 trim 后的串，空串写成（空）。
 */
export function getChatNotFound(chat: string): string {
  let label = chat.trim();
  if (label === '') {
    label = '（空）';
  }
  return `chat_not_found：没有叫 ${label} 的聊天`;
}


/**
 * 生成跨插件统一的渠道消息 ID：JSON.stringify([channel, accountId, nativeId])。
 * @param channel 渠道名。
 * @param accountId 平台账号 ID（本地入口固定 'local'）。
 * @param nativeId 平台原始消息 ID 或本进程持久/递增序号。
 * @returns 标准 messageId 字符串。
 */
export function makeChannelMessageId(channel: string, accountId: string, nativeId: string): string {
  return JSON.stringify([channel, accountId, nativeId]);
}


/**
 * 按旧渠道地址里的 owner / role 推导标准渠道角色档位（绝不把 role 写回原兼容地址，以免改变 Workspace 权限）。
 * @param address 原渠道地址对象。
 * @returns 标准角色档位。
 */
export function resolveLegacyRole(address: Record<string, unknown>): ChannelRole {
  //M 先看地址里是否明确标了本人（owner: true 或 role === 'owner'）。
  if (textModule.getField(address, 'owner') === true || textModule.getText(address, 'role') === 'owner') {
    return 'owner';
  }
  //M 其次识别 builder 角色档位。
  if (textModule.getText(address, 'role') === 'builder') {
    return 'builder';
  }
  return 'guest';
}


/**
 * 登记只发纯文字的渠道的 channel/reply 响应器：模型一轮里调几次 channel_reply 就发几条，零次兜底、approval 直回也走这里。
 * 带按 replyRequestKey 的幂等重放与同键冲突拦截，并回发标准 channel/replied 事件。
 * @param ctx 渠道插件的 Cordis 上下文（挂在上面的监听随插件卸载自动撤销）。
 * @param adapter 渠道直发回调与渠道名。
 */
export function registerTextReply(ctx: cordis.Context, adapter: TextReplyAdapter): void {
  const sent = new Map<string, { payloadHash: string; receipt: ReplyReceipt }>();

  const emitReplied = (request: ChannelReplyRequest, receipt: ReplyReceipt): void => {
    ctx.emit('channel/replied', {
      requestId: request.requestId,
      replyRoundKey: request.replyRoundKey,
      receipt,
    });
  };

  const buildFailure = (
    request: ChannelReplyRequest,
    status: 'rejected' | 'uncertain',
    reason: string,
  ): ReplyReceipt => ({
    v: 2,
    ok: false,
    status,
    replyRequestKey: request.replyRequestKey,
    replyRoundKey: request.replyRoundKey,
    replyIndex: request.replyIndex,
    kind: request.kind,
    parts: request.parts.map((part) => ({ partId: part.partId, kind: part.kind, status, reason })),
    reason,
    at: Date.now(),
  });

  //M 挂载当前纯文字渠道的 channel/reply 响应监听器，随插件上下文生命周期自动撤销。
  ctx.on('channel/reply', async (request) => {
    if (request.channel !== adapter.channel || request.handled === true) return;

    request.handled = true;

    //G 同一 replyRequestKey 重试：正文摘要一致重放旧回执，不一致则拒绝。
    const existing = sent.get(request.replyRequestKey);
    if (existing !== undefined) {
      if (existing.payloadHash === request.payloadHash) {
        //M 同键同摘要视为重放：原样回传上次已记录的回执。
        emitReplied(request, existing.receipt);
        return;
      }
      //G 同键但正文摘要不同：拦截潜在串包或篡改，回发 rejected 回执。
      emitReplied(request, buildFailure(request, 'rejected', 'reply_conflict：同一 replyRequestKey 的发送内容不一致'));
      return;
    }

    if (request.mode !== 'text') {
      //G 纯文字适配器不支持非 text 模式（如附件），明确拒收。
      emitReplied(request, buildFailure(request, 'rejected', `capability_unsupported：渠道 ${adapter.channel} 当前只支持纯文字直回`));
      return;
    }

    //M 若请求带有跨渠道/跨聊天目标，调用本渠道自带的“认聊天”回调核实目标地址。
    let targetAddress: Record<string, unknown> | undefined;
    if (request.target !== undefined) {
      if (adapter.getTargetAddress === undefined) {
        //G 渠道未实现目标识别能力时明确拒绝，避免误发回原聊天。
        emitReplied(request, buildFailure(request, 'rejected', `capability_unsupported：渠道 ${adapter.channel} 不支持指定目标聊天`));
        return;
      }

      //M 调用渠道自带认聊天回调解析目标地址。
      targetAddress = adapter.getTargetAddress(request.target.chat, request);
      if (targetAddress === undefined) {
        //G 目标聊天不在本渠道自己的清单/会话表里时回传 rejected。
        const notFoundReason = getChatNotFound(request.target.chat);
        emitReplied(request, buildFailure(request, 'rejected', notFoundReason));
        return;
      }
    }

    const body = request.parts.map((part) => part.text ?? '').filter((part) => part !== '').join('\n');
    try {
      //M 将正文与可选跨渠道解析地址交由渠道适配器的直发逻辑写出；不交回结果的渠道照旧算已发。
      const returned = await adapter.sendDirectText(body, request, targetAddress);
      let outcome: TextReplyOutcome = { status: 'sent' };
      if (returned !== undefined) {
        outcome = returned;
      }
      const ok = outcome.status === 'sent' || outcome.status === 'draft';
      const receipt: ReplyReceipt = {
        v: 2,
        ok,
        status: outcome.status,
        replyRequestKey: request.replyRequestKey,
        replyRoundKey: request.replyRoundKey,
        replyIndex: request.replyIndex,
        kind: request.kind,
        parts: [{ partId: request.parts[0]?.partId ?? 'text:0', kind: 'text', status: outcome.status }],
        at: Date.now(),
      };
      if (outcome.reason !== undefined) {
        receipt.reason = outcome.reason;
      }

      //G 只记已发、已存草稿的回执给同键重放；失败、不确定的，同键再来照样交给渠道再试。
      if (ok) {
        sent.set(request.replyRequestKey, { payloadHash: request.payloadHash, receipt });
      }
      //M 发出渠道交回的回执（不交回的就是 sent）。
      emitReplied(request, receipt);
    } catch (error) {
      //G 直发过程抛出异常时，读取简洁错误说明并以 uncertain 状态回报。
      emitReplied(request, buildFailure(request, 'uncertain', textModule.getMessage(error)));
    }
  });
}
