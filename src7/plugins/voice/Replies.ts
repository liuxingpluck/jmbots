/** 将语音后台和标准回话合并到同一个渠道出口，文字回执独立于浏览器播报。 */

import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as utils from '../../utils/index.ts';
import * as channel from '../channels/index.ts';
import * as common from './Common.ts';

/** 回话回执最多留几条：同一回复号重放时要命中，太早的删掉，语音长开内存不再一直涨。 */
export const RECEIPT_MAX = 500;

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
    //M 半句任务允许立即开始，回话等这句话有了最终记录再写：语音发的半句（channel/direct 带 routing.partial）先登记一个等待。
    ctx.on('channel/direct', (message) => {
      if (message.channel !== common.CHANNEL || message.routing.partial !== true) return;

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

  /**
   * 旧路的回话（会话一轮结束、前台送后台结果，没有来源快照，target.address 是会话记的语音地址）：
   * 补一份来源快照，换成按后台会话分轮的回复键，再和标准回复走同一条路（记忆、时间线、播报共用）。
   * 这条回复可能来得比最终字幕早：先等整句入档，取消听写时不留孤立的回复。
   * @param request 回复请求；补上后带来源快照、去掉 target，会话没做完的改成 progress。
   * @returns 补不上时的原因；补上了是 undefined。
   */
  private async adopt(request: channel.ChannelReplyRequest): Promise<string | undefined> {
    const address = utils.getRecord(request.target?.address);
    const messageId = utils.getStringField(address, 'voiceMessageId');
    if (messageId === '') return '语音来源地址无效';

    const sessionId = request.sessionId;
    if (sessionId === undefined) return '语音旧路回话没有会话号';

    //G 这条回复可能来得比最终字幕早。
    const gate = this.unfinished.get(messageId);
    if (gate !== undefined) {
      //G 提前结束的后台等待整句入档，取消听写时不会留一条孤立的回复。
      const committed = await gate.promise;
      if (!committed) return '语音未确认最终字幕';
    }

    const botName = request.bot;
    let chatId = utils.getStringField(address, 'chatId');
    if (chatId === '') {
      chatId = common.LOCAL;
    }
    let customer = utils.getStringField(address, 'customer');
    if (customer === '') {
      customer = common.CUSTOMER;
    }
    //M 让标准回执关联到既有的消息认领。
    const claimKey = channel.getClaimKey(messageId, botName);
    //M 按后台会话区分同一条消息的回复轮次。
    const replyRoundKey = channel.getReplyRoundKey(messageId, botName, sessionId);
    request.sourceSnapshot = {
      messageId,
      nativeId: null,
      channel: common.CHANNEL,
      accountId: common.LOCAL,
      chatId,
      chatType: common.LOCAL,
      senderId: 'owner',
      senderName: '语音',
      role: 'owner',
      targetBots: [botName],
      mentions: [],
      origin: { channel: common.CHANNEL, address: { ...address, voiceSessionId: sessionId } },
      visibility: { scope: customer, trusted: true, publicSourceIds: [] },
      botName,
      claimKey,
      replyRoundKey,
    };
    delete request.target;

    //M 会话做完了是最终回话，沿用固定调用号，多次转发仍可合并为一条；还在转的是中途一句，各用各的号。
    const running = this.ctx.sessions.open(sessionId).row.state === 'running';
    let callId = 'voice-final';
    request.kind = 'final';
    if (running) {
      callId = crypto.randomUUID();
      request.kind = 'progress';
    }
    request.replyRoundKey = replyRoundKey;
    request.replyRequestKey = channel.getReplyRequestKey(replyRoundKey, callId);
    return undefined;
  }

  /** 同一回复请求重放回执，不重复写入或播报。 */
  private async onReply(request: channel.ChannelReplyRequest): Promise<void> {
    if (request.channel !== common.CHANNEL || request.handled === true) return;

    request.handled = true;

    //M 旧路的回话没有来源快照：照会话记的语音地址补上，补不上就拒收。
    if (request.sourceSnapshot === undefined) {
      const failed = await this.adopt(request);
      if (failed !== undefined) {
        const rejected = this.getReceipt(request, false, failed);
        channel.emitReplied(this.ctx, request, rejected);
        return;
      }
    }

    const key = request.replyRequestKey;
    //G 复用同一请求已经开始或完成的播报。
    const existing = this.receipts.get(key);
    //M 统一生成首发或重试的回执。
    const result = this.getResult(request, existing);
    const receipt = await result;
    //M 回执携带实际播放状态，文字经过持久化仍可在断开后查看。
    channel.emitReplied(this.ctx, request, receipt);
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

    //G 只留最近 RECEIPT_MAX 条：Map 按放进去的先后排，超了就删最早的一条。
    if (this.receipts.size <= RECEIPT_MAX) return result;

    const oldest = this.receipts.keys().next().value;
    if (oldest !== undefined) {
      this.receipts.delete(oldest);
    }
    return result;
  }

  /** 验证回复形状，只有原聊天的文字可以进入这条语音回路。 */
  private async deliver(request: channel.ChannelReplyRequest): Promise<VoiceReceipt> {
    if (request.sourceSnapshot?.channel !== common.CHANNEL || request.target !== undefined || request.mode !== 'text') {
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
    //M 文字渠道状态和浏览器实际播报结果分别记录。
    const receipt = channel.getReceipt(request, status, reason);
    return { ...receipt, spoken };
  }
}
