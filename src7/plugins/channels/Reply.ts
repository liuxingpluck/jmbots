/**
 * 渠道协议：回复（回复请求、回执、回执拼法、回复键）。
 * 所有发出去的话都走这里：模型的 channel_reply、零次兜底、审批直回、旧路自动回话、relay 回信、本人批准的主动发件。
 * requestChannelReply 发 channel/reply 并等 channel/replied；emitReplied 是渠道回发回执的唯一出口，回执带着请求本身。
 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as requestEvents from '../../utils/RequestEvent.ts';
import type * as messageModule from './Message.ts';
import type * as targetModule from './Target.ts';


/** 回复轮里的回复类别。 */
export type ReplyKind = 'progress' | 'final';

/** v2 渠道发送回执状态；与 acceptResult 的 queued / duplicate 严格区分。 */
export type ReplyStatus = 'queued' | 'sent' | 'draft' | 'partial' | 'uncertain' | 'rejected';


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
  /** 渠道已接收回复时为 true，对应 sent、queued、draft。 */
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
  /**
   * 不可变来源快照：回某条消息时有。
   * 没有的（旧路自动回话、relay 回信、本人批准的主动发件）一定带 target.address，照它发。
   */
  sourceSnapshot?: messageModule.SourceSnapshot;
  /** 请求正文摘要，用于同键冲突校验。 */
  payloadHash: string;
  /** 发送片段列表。 */
  parts: ReplyPartInput[];
  /** 跨渠道或跨聊天发送目标；未指定别处时为 undefined，沿用 sourceSnapshot。 */
  target?: targetModule.ChannelReplyTarget;
  /** 哪场会话说的：旧路自动回话、relay 回信带上，渠道照会话定细节（命令行出错标红，微信只发做完的一轮，网页挂回会话认领的那条）。 */
  sessionId?: string;
  /** 正文里的 @路径（存在的本机文件）当文件一起发：只有旧路自动回话、relay 回信开，模型的 channel_reply 不开；只有飞书认，别的渠道照纯文字发。 */
  atFiles?: boolean;
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
  /** 回执对应的请求本身（含正文、来源快照、目标）：记往来、记忆、网页挂回都照它，不用先在 channel/reply 暂存。 */
  request: ChannelReplyRequest;
}


/** 没有来源快照时以谁的名义、发到哪（旧路自动回话、relay 回信、本人批准的主动发件），给 requestTextReply。 */
export interface ReplyFrom {
  /** 机器人名。 */
  bot: string;
  /** 回复轮键：调用方自己定，同一轮的几条共用。 */
  replyRoundKey: string;
  /** 发到哪：目标渠道和确切地址（target.address）。 */
  target: targetModule.ChannelReplyTarget;
  /** 哪场会话说的；没有会话的（本人批准的主动发件）不写。 */
  sessionId?: string;
}


/** 一轮 channel_tool 收尾的通知（bot/settled）。 */
export interface ChannelSettledEvent {
  /** 这一轮的来源快照：渠道照 channel、origin.address 认出是自己哪条消息。 */
  sourceSnapshot: messageModule.SourceSnapshot;
  /** 收尾结果：sent 发完（或本来就不用发）；partial、uncertain、rejected 没发成；sending 渠道排队或草稿。 */
  stage: 'sent' | 'partial' | 'uncertain' | 'rejected' | 'sending';
  /** 原因；没有是空串。 */
  note: string;
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
  //M 没人接单能确认没发，超时或异常时无法确认投递。
  const onFallback = (cause: requestEvents.FallbackReason, detail?: string): ChannelRepliedEvent => {
    let status: ReplyStatus = 'uncertain';
    let reason = detail ?? '等待渠道发送回执超时';
    if (cause === 'unhandled') {
      status = 'rejected';
      reason = `channel_unavailable：渠道 ${req.channel} 没挂`;
    }
    const receipt = getReceipt(req, status, reason);
    const request = { ...req, requestId: '' };
    return { requestId: '', replyRoundKey: req.replyRoundKey, receipt, request };
  };

  const options = { prefix: 'rep', timeoutMs, keepAlive: true, onFallback };
  //M 交给公共请求工具配对回执，只向上层交回渠道处理结果。
  const result = await requestEvents.requestEvent(ctx, 'channel/reply', 'channel/replied', req, options);
  return result.receipt;
}


/** 单段文字回复的发送选项。 */
interface TextReplyOptions {
  /** 本次回复的幂等键。 */
  replyRequestKey: string;
  /** 按本轮队列号发送时由队列提供，通常沿用来源快照的轮键（没有来源快照时用 ReplyFrom 的）。 */
  replyRoundKey?: string;
  /** 本轮的发送序号。 */
  replyIndex: number;
  /** 中途说明或最终回复。 */
  kind: ReplyKind;
  /** 显式跨聊天时由目标渠道核对和识别（没有来源快照时用 ReplyFrom 的）。 */
  target?: targetModule.ChannelReplyTarget;
  /** 正文里的 @路径 当文件发（旧路自动回话、relay 回信）。 */
  atFiles?: boolean;
}


/**
 * 通过标准渠道请求发送一段纯文字并等待回执。
 * @param ctx 发起请求的 Cordis 上下文。
 * @param from 本轮的固定渠道来源；没有来源快照的给 ReplyFrom（机器人、轮键、确切地址、会话号）。
 * @param text 要发出的纯文字。
 * @param options 幂等键、回复类型和可选目标。
 * @returns 渠道返回的回执。
 */
export async function requestTextReply(
  ctx: cordis.Context,
  from: messageModule.SourceSnapshot | ReplyFrom,
  text: string,
  options: TextReplyOptions,
): Promise<ReplyReceipt> {
  const kind = options.kind;
  const mode = 'text';
  const parts: ReplyPartInput[] = [{ partId: 'text:0', kind: 'text', text }];

  //==========================================================
  //M 没有来源快照（旧路自动回话、relay 回信、本人批准的主动发件）：照调用方给的机器人、轮键和地址发
  //==========================================================
  if ('target' in from) {
    const fromTarget = from.target;
    const fromHashInput = { kind, mode, parts, target: fromTarget };
    const fromHash = getPayloadHash(fromHashInput);
    const direct: Omit<ChannelReplyRequest, 'requestId'> = {
      channel: fromTarget.channel,
      bot: from.bot,
      replyRequestKey: options.replyRequestKey,
      replyRoundKey: from.replyRoundKey,
      replyIndex: options.replyIndex,
      kind,
      mode,
      payloadHash: fromHash,
      parts,
      target: fromTarget,
    };
    if (from.sessionId !== undefined) {
      direct.sessionId = from.sessionId;
    }
    if (options.atFiles === true) {
      direct.atFiles = true;
    }

    //M 目标渠道照 target.address 发出并回执，调用方只提供正文和地址。
    return requestChannelReply(ctx, direct);
  }

  //==========================================================
  //M 有来源快照：渠道、机器人、轮键照快照，跨聊天时 options.target 指别处
  //==========================================================
  const snapshot = from;
  const target = options.target;
  //M 保留原有字段顺序和目标范围，已落盘的哈希在同键重试时仍可匹配。
  const hashInput = { kind, mode, parts, target };
  const payloadHash = getPayloadHash(hashInput);
  const reply: Omit<ChannelReplyRequest, 'requestId'> = {
    channel: target?.channel ?? snapshot.channel,
    bot: snapshot.botName,
    replyRequestKey: options.replyRequestKey,
    replyRoundKey: options.replyRoundKey ?? snapshot.replyRoundKey,
    replyIndex: options.replyIndex,
    kind,
    mode,
    sourceSnapshot: structuredClone(snapshot),
    payloadHash,
    parts,
  };
  if (target !== undefined) {
    reply.target = target;
  }
  //M 渠道识别目标并发回发送结果，调用方只提供正文和来源。
  return requestChannelReply(ctx, reply);
}


/** 生成回执只需要回复键、类别和每段的标识。 */
export type ReceiptSource = Pick<ChannelReplyRequest, 'replyRequestKey' | 'replyRoundKey' | 'replyIndex' | 'kind'> & {
  /** 原回复的段号和种类，按发送顺序排列。 */
  parts: ReadonlyArray<Pick<ReplyPartInput, 'partId' | 'kind'>>;
};


/**
 * 按请求和渠道结果生成回执，逐段带上状态和可选原因。
 * @param request 原请求的回复元数据。
 * @param status 渠道处理结果。
 * @param reason 处理结果的说明。
 * @returns 包含回复键、逐段状态和生成时间的回执。
 */
export function getReceipt(request: ReceiptSource, status: ReplyStatus, reason?: string): ReplyReceipt {
  //M 保留每段标识，发送方可以用段号对上原请求。
  const parts = request.parts.map((part) => {
    const result: ReplyReceiptPart = { partId: part.partId, kind: part.kind, status };
    if (reason !== undefined) {
      result.reason = reason;
    }
    return result;
  });

  const receipt: ReplyReceipt = {
    v: 2,
    ok: status === 'sent' || status === 'queued' || status === 'draft',
    status,
    replyRequestKey: request.replyRequestKey,
    replyRoundKey: request.replyRoundKey,
    replyIndex: request.replyIndex,
    kind: request.kind,
    parts,
    at: Date.now(),
  };
  if (reason !== undefined) {
    receipt.reason = reason;
  }
  return receipt;
}


/**
 * 把渠道回复回执交回发起请求的一方，回执带着请求本身。
 * @param ctx 发出回执事件的渠道上下文。
 * @param request 原请求：请求号和轮次关联等待方，正文、来源给记往来、记忆、网页挂回用。
 * @param receipt 渠道构造的标准回执。
 */
export function emitReplied(
  ctx: cordis.Context,
  request: ChannelReplyRequest,
  receipt: ReplyReceipt,
): void {
  const event: ChannelRepliedEvent = {
    requestId: request.requestId,
    replyRoundKey: request.replyRoundKey,
    receipt,
    request,
  };
  //M 用请求号通知等待本次渠道回复的调用方。
  ctx.emit('channel/replied', event);
}
