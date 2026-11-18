/** 将语音后台和标准回话合并到同一个渠道出口，文字回执独立于浏览器播报。 */

import type * as cordis from 'cordis';
import * as channel from '../../Channels.ts';
import type * as sessions from '../../Sessions.ts';
import type * as bots from '../bots/index.ts';

/** 浏览器确认至少有一段语音实际经过播放。 */
interface VoiceReceipt extends channel.ReplyReceipt {
  spoken: boolean;
}

/** 路由统一后，提前开工的回话等最终字幕入档再交付。 */
export class VoiceReplies {
  private readonly unfinished = new Map<string, ReturnType<typeof Promise.withResolvers<boolean>>>();
  private readonly receipts = new Map<string, { hash: string; result: Promise<VoiceReceipt> }>();

  /** 绑定标准回复事件；播报可用时交给对应连接。 */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly play: (text: string, request: channel.ChannelReplyRequest) => Promise<boolean>,
  ) {
    //M 半句任务允许立即开始，回话等这句话有了最终记录再写。
    ctx.on('voice/dispatch', async (message) => {
      const gate = Promise.withResolvers<boolean>();
      this.unfinished.set(message.messageId, gate);
    }, { prepend: true });
    ctx.on('voice/record', (message) => {
      //M 时间线会在同一次同步事件里先保存用户的最终字幕。
      this.release(message.messageId, true);
    });
    ctx.on('voice/abandon', (messageId) => {
      //G 没有最终字幕的断开连接不提交悬空回复。
      this.release(messageId, false);
    });
    ctx.on('channel/reply', async (request) => {
      await this.onReply(request);
    });
  }

  /** 结束这一句的回话等待，后续回复可以直接走标准事件。 */
  private release(messageId: string, keep: boolean): void {
    //M 找回半句任务的等待句柄，释放攒下的回复。
    const gate = this.unfinished.get(messageId);
    this.unfinished.delete(messageId);
    gate?.resolve(keep);
  }

  /** bots.channel 注册的语音出口，将旧后台结果转换为唯一的标准回复。 */
  async fromWork(text: string, session: sessions.Session, origin?: bots.Origin): Promise<bots.SendReceipt> {
    const address = origin?.address ?? session.row.address;
    if (address === null || typeof address !== 'object' || !('voiceMessageId' in address)
      || typeof address.voiceMessageId !== 'string') {
      return { status: 'rejected', reason: '语音来源地址无效' };
    }

    const messageId = address.voiceMessageId;
    const running = session.row.state === 'running';
    //G 这条回复可能来得比最终字幕早。
    const gate = this.unfinished.get(messageId);
    if (gate !== undefined) {
      //G 提前结束的后台等待整句入档，取消听写时不会留一条孤立的回复。
      const committed = await gate.promise;
      if (!committed) return { status: 'rejected', reason: '语音未确认最终字幕' };
    }
    const botName = session.row.bot;
    let chatId = 'local';
    if ('chatId' in address && typeof address.chatId === 'string') {
      chatId = address.chatId;
    }
    let customer = 'voice:本机';
    if ('customer' in address && typeof address.customer === 'string') {
      customer = address.customer;
    }
    //M 让标准回执关联到既有的消息认领。
    const claimKey = channel.getClaimKey(messageId, botName);
    //M 按后台会话区分同一条消息的回复轮次。
    const replyRoundKey = channel.getReplyRoundKey(messageId, botName, session.id);
    const sourceSnapshot: channel.SourceSnapshot = {
      messageId,
      nativeId: null,
      channel: 'voice',
      accountId: 'local',
      chatId,
      chatType: 'local',
      senderId: 'owner',
      senderName: '语音',
      role: 'owner',
      targetBots: [botName],
      mentions: [],
      origin: { channel: 'voice', address: { ...address, voiceSessionId: session.id } },
      visibility: { scope: customer, trusted: true, publicSourceIds: [] },
      botName,
      claimKey,
      replyRoundKey,
    };
    let kind: channel.ReplyKind = 'final';
    let callId = 'voice-final';
    if (running) {
      kind = 'progress';
      callId = crypto.randomUUID();
    }
    //M 后台最终回话沿用固定调用号，多次转发仍可合并为一条。
    const replyRequestKey = channel.getReplyRequestKey(replyRoundKey, callId);
    const parts: channel.ReplyPartInput[] = [{ partId: 'text:0', kind: 'text', text }];
    //M 保存本次正文的摘要，检查同一请求重试时正文是否一致。
    const payloadHash = channel.getPayloadHash(parts);
    const request = {
      channel: 'voice', bot: botName, replyRequestKey, replyRoundKey, replyIndex: 0,
      kind, mode: 'text' as const, sourceSnapshot, payloadHash, parts,
    };
    //M 记忆、时间线和语音播放现在共同使用这一次标准回复。
    const receipt = await channel.requestChannelReply(this.ctx, request);
    if (receipt.ok) return { status: 'accepted', reason: '' };

    return { status: 'rejected', reason: receipt.reason ?? '语音回复未提交' };
  }

  /** 同一回复请求重放回执，不重复写入或播报。 */
  private async onReply(request: channel.ChannelReplyRequest): Promise<void> {
    if (request.channel !== 'voice' || request.handled === true) return;

    request.handled = true;
    const key = request.replyRequestKey;
    //G 复用同一请求已经开始或完成的播报。
    const existing = this.receipts.get(key);
    //M 统一生成首发或重试的回执。
    const result = this.getResult(request, existing);
    const receipt = await result;
    const event = { requestId: request.requestId, replyRoundKey: request.replyRoundKey, receipt };
    //M 回执携带实际播放状态，文字经过持久化仍可在断开后查看。
    this.ctx.emit('channel/replied', event);
  }

  /** 在播报前写入回执 Promise，重试和并发收到同一结果。 */
  private async getResult(
    request: channel.ChannelReplyRequest,
    existing?: { hash: string; result: Promise<VoiceReceipt> },
  ): Promise<VoiceReceipt> {
    if (existing !== undefined) {
      //G 同一个回复号不可换正文，冲突直接拒绝。
      const conflict = '同一回复号的语音正文不一致';
      if (existing.hash !== request.payloadHash) return this.getReceipt(request, false, conflict);
      return existing.result;
    }
    //M 首次看到该回复号时，开始尝试在原浏览器播报。
    const result = this.deliver(request);
    this.receipts.set(request.replyRequestKey, { hash: request.payloadHash, result });
    return result;
  }

  /** 验证回复形状，只有原聊天的文字可以进入这条语音回路。 */
  private async deliver(request: channel.ChannelReplyRequest): Promise<VoiceReceipt> {
    if (request.sourceSnapshot.channel !== 'voice' || request.target !== undefined || request.mode !== 'text') {
      const reason = '语音渠道只支持原聊天的文字回复';
      //G 这类回复没有可投递的原聊天文字。
      return this.getReceipt(request, false, reason);
    }

    const texts = request.parts.map((part) => part.text ?? '');
    const text = texts.filter((item) => item !== '').join('\n');
    const empty = '没有语音回复文字';
    //G 空白文字无需生成音频。
    if (text.trim() === '') return this.getReceipt(request, false, empty);

    //M 浏览器播报失败时仍确认文字，网页回到同一条已记录的用户消息。
    const spoken = await this.play(text, request).catch(() => false);
    return this.getReceipt(request, spoken);
  }

  /** 用标准回复形状返回文字交付和独立的播报结果。 */
  private getReceipt(request: channel.ChannelReplyRequest, spoken: boolean, reason?: string): VoiceReceipt {
    let status: 'sent' | 'rejected' = 'sent';
    if (reason !== undefined) {
      status = 'rejected';
    }
    const parts = request.parts.map((part) => ({ partId: part.partId, kind: part.kind, status, reason }));
    return {
      v: 2,
      ok: status === 'sent',
      status,
      kind: request.kind,
      replyRequestKey: request.replyRequestKey,
      replyRoundKey: request.replyRoundKey,
      replyIndex: request.replyIndex,
      parts,
      at: Date.now(),
      spoken,
      reason,
    };
  }
}
