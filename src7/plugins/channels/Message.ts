/**
 * 渠道协议：进来的一条消息（渠道消息、提及、附件、来源、可见性、路由、认领、撤回）。
 * 只放类型和无状态小函数：分法（发哪个事件）、消息号、认领键、来源快照、旧地址的身份档位。事件声明在同目录 index.ts。
 */
import type * as cordis from 'cordis';
import * as utils from '../../utils/index.ts';


/** 渠道标准角色档位；身份证明缺失时一律回退 guest。 */
export type ChannelRole = 'owner' | 'guest' | 'builder';

/** 聊天种类。 */
export type ChannelChatType = 'p2p' | 'group' | 'local';


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


/** 进来的一条话发哪个事件（三个互斥，一条只发一个），由 getInboundEvent 分。 */
export type InboundEvent = 'channel/direct' | 'channel/mention' | 'channel/listen';


/** 渠道路由建议。私聊、@、只听不在这里标，看发的是哪个事件。 */
export interface ChannelRouting {
  /** 服务端校验过的指定会话号：bots 只投给这场会话的机器人、进这场会话（网页“发给哪个会话”、引用别的渠道的消息）。 */
  sessionId?: string;
  /** 引用别的渠道的消息时，被引那条的原渠道、原机器人、原会话（入口校验过）；只作记录，回话照旧回本条来源。 */
  replyOrigin?: { source: string; bot: string; sessionId: string };
  /** 一轮一次 channel_reply 都没调时，把最后的话当 final 直接发出去（一对一的渠道：网页、命令行、微信）；不写走修复轮。 */
  autoFinal?: boolean;
  /** 半句：话还没说完就先交给机器人开工（语音）。只给机器人看，记录类插件（memory）不记，等同一消息号的整句再记。 */
  partial?: boolean;
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
  /**
   * 经可信配置和 @ 映射规范化去重后的目标机器人名单。
   * direct、mention：要回话的机器人；listen：要把这句记进前台当背景（或判断接不接）的机器人，
   * 飞书是登记了 listen: all / judge 的群里本应用的机器人，没登记的群、语音只入档的整句是空的（只给记录类插件记）。
   */
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


/** 单机器人在进来的三个事件（direct、mention、listen）里的认领记录（供渠道流水与测试核对，不混用全局 handled）。 */
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


/** 随进来的三个事件传递的可变协调对象。 */
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


/** 事件 channel/recall 载荷：渠道确认原消息被撤回后发出。 */
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
  /** 撤回时刻，Unix 毫秒。 */
  recalledAt: number;
  /** 渠道日志里的原话，日志未写入时为空。 */
  originalText: string;
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


/**
 * 进来的一条话该发哪个事件，各渠道共用这一个分法，一条只发一个：
 *   没叫机器人 → channel/listen（群里没 @、语音里只入档的整句）；
 *   叫了、在群里 → channel/mention（@ 了机器人，或引用了机器人的话）；
 *   叫了、不在群里 → channel/direct（私聊：飞书 p2p、微信、网页、命令行、语音）。
 * @param chatType 聊天种类。
 * @param called 叫了机器人没有：私聊、群里 @ 了、引用了机器人的话是 true。
 * @returns 事件名。
 */
export function getInboundEvent(chatType: ChannelChatType, called: boolean): InboundEvent {
  if (!called) return 'channel/listen';

  if (chatType === 'group') return 'channel/mention';

  return 'channel/direct';
}


/**
 * 渠道收下一条话、存好原件以后调：照 getInboundEvent 分好，发 channel/direct、channel/mention、channel/listen 之一（挨个问，等大家处理完）。
 * 各渠道（命令行、飞书、外部程序、语音、网页、微信）都经它发，事件只在这一处写。
 * @param ctx 渠道插件的 ctx。
 * @param message 标准消息。
 * @param called 叫了机器人没有（见 getInboundEvent）。
 * @param control 认领协调对象：approval、bots 往里写结果。
 */
export async function emitInbound(
  ctx: cordis.Context,
  message: ChannelMessage,
  called: boolean,
  control: ChannelMessageControl,
): Promise<void> {
  const event = getInboundEvent(message.chatType, called);

  //M 只听：没叫机器人的话，approval 不看，bots 只记背景或判断要不要接。
  if (event === 'channel/listen') {
    await ctx.serial('channel/listen', message, control);
    return;
  }

  //M 群里叫了机器人：approval 先看批复，bots 认领要回的机器人。
  if (event === 'channel/mention') {
    await ctx.serial('channel/mention', message, control);
    return;
  }

  //M 私聊：approval 先看批复，bots 认领。
  await ctx.serial('channel/direct', message, control);
}


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
 * 复制一条渠道消息的固定来源，供队列和回复定位当前轮。
 * @param message 渠道接入时规范化的消息。
 * @param botName 当前认领或回复的机器人。
 * @param origin 供当前机器人使用的渠道地址。
 * @param claimKey 此次消息认领键。
 * @param replyRoundKey 此次回复轮键。
 * @returns 隔离于原消息变更的来源快照。
 */
export function getSourceSnapshot(
  message: ChannelMessage,
  botName: string,
  origin: ChannelOrigin,
  claimKey: string,
  replyRoundKey: string,
): SourceSnapshot {
  //M 执行期间渠道可能更新地址及可见范围，快照保留本轮开始时的数据。
  const snapshot: SourceSnapshot = {
    messageId: message.messageId,
    nativeId: message.nativeId,
    channel: message.channel,
    accountId: message.accountId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.sender.id,
    role: message.role,
    targetBots: [...message.targetBots],
    mentions: structuredClone(message.mentions),
    origin: { channel: origin.channel, address: structuredClone(origin.address) },
    visibility: structuredClone(message.visibility),
    botName,
    claimKey,
    replyRoundKey,
  };
  if (message.sender.name !== undefined) {
    snapshot.senderName = message.sender.name;
  }
  return snapshot;
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
  if (utils.getField(address, 'owner') === true || utils.getStringField(address, 'role') === 'owner') {
    return 'owner';
  }
  //M 其次识别 builder 角色档位。
  if (utils.getStringField(address, 'role') === 'builder') {
    return 'builder';
  }
  return 'guest';
}
