/**
 * 渠道协议：只发纯文字的渠道（命令行、网页、微信、programs 转出去的）接 channel/reply 的共用响应器。
 * 渠道调 registerTextReply 交一个适配器，这里管认领、同键重放、认目标聊天和回发回执。
 */
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import * as replyModule from './Reply.ts';
import * as targetModule from './Target.ts';


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
  getTargetAddress?: (chat: string, request: replyModule.ChannelReplyRequest) => Record<string, unknown> | undefined;
  /**
   * 把纯文字直接送回原渠道，不能再触发模型或重复回环。
   * targetAddress：请求带 target.address 时按这个地址发（如自动回话、relay 回信、本人批准的主动发件），
   * 只带 target.chat 时是 getTargetAddress 认出的地址，都没有时是 undefined（回来源快照的原聊天）。
   * 交回 TextReplyOutcome 时照它写回执；不交回算已发。
   */
  sendDirectText: (
    text: string,
    request: replyModule.ChannelReplyRequest,
    targetAddress?: Record<string, unknown>,
  ) => void | TextReplyOutcome | Promise<void | TextReplyOutcome>;
}


/**
 * 登记只发纯文字的渠道的 channel/reply 响应器：模型一轮里调几次 channel_reply 就发几条，零次兜底、approval 直回也走这里。
 * 带按 replyRequestKey 的幂等重放与同键冲突拦截，并回发标准 channel/replied 事件。
 * @param ctx 渠道插件的 Cordis 上下文（挂在上面的监听随插件卸载自动撤销）。
 * @param adapter 渠道直发回调与渠道名。
 */
export function registerTextReply(ctx: cordis.Context, adapter: TextReplyAdapter): void {
  const sent = new Map<string, { payloadHash: string; receipt: replyModule.ReplyReceipt }>();

  //M 挂载当前纯文字渠道的 channel/reply 响应监听器，随插件上下文生命周期自动撤销。
  ctx.on('channel/reply', async (request) => {
    //==========================================================
    //M 认领本渠道请求并核对重试与发送方式
    //==========================================================
    if (request.channel !== adapter.channel || request.handled === true) return;

    request.handled = true;

    //G 同一 replyRequestKey 重试：正文摘要一致重放旧回执，不一致则拒绝。
    const existing = sent.get(request.replyRequestKey);
    if (existing !== undefined) {
      if (existing.payloadHash === request.payloadHash) {
        //M 同键同摘要视为重放：原样回传上次已记录的回执。
        replyModule.emitReplied(ctx, request, existing.receipt);
        return;
      }
      //G 同键但正文摘要不同：拦截潜在串包或篡改，回发 rejected 回执。
      const reason = 'reply_conflict：同一 replyRequestKey 的发送内容不一致';
      const receipt = replyModule.getReceipt(request, 'rejected', reason);
      replyModule.emitReplied(ctx, request, receipt);
      return;
    }

    if (request.mode !== 'text') {
      //G 纯文字适配器不支持非 text 模式（如附件），明确拒收。
      const reason = `capability_unsupported：渠道 ${adapter.channel} 当前只支持纯文字直回`;
      const receipt = replyModule.getReceipt(request, 'rejected', reason);
      replyModule.emitReplied(ctx, request, receipt);
      return;
    }

    //==========================================================
    //M 解析指定聊天的发送地址
    //==========================================================
    //M 调用方已给出确切地址（如自动回话、relay 回信、本人批准的主动发件）：按地址发。
    let targetAddress = request.target?.address;

    //M 只给了聊天名或号的跨渠道/跨聊天目标：调用本渠道自带的“认聊天”回调核实目标地址。
    if (request.target !== undefined && targetAddress === undefined) {
      if (adapter.getTargetAddress === undefined) {
        //G 渠道未实现目标识别能力时明确拒绝，避免误发回原聊天。
        const reason = `capability_unsupported：渠道 ${adapter.channel} 不支持指定目标聊天`;
        const receipt = replyModule.getReceipt(request, 'rejected', reason);
        replyModule.emitReplied(ctx, request, receipt);
        return;
      }

      //M 调用渠道自带认聊天回调解析目标地址。
      targetAddress = adapter.getTargetAddress(request.target.chat, request);
      if (targetAddress === undefined) {
        //G 目标聊天不在本渠道自己的清单/会话表里时回传 rejected。
        const notFoundReason = targetModule.getChatNotFoundMessage(request.target.chat);
        const receipt = replyModule.getReceipt(request, 'rejected', notFoundReason);
        replyModule.emitReplied(ctx, request, receipt);
        return;
      }
    }

    //==========================================================
    //M 发送正文，保存可重放的回执并通知调用方
    //==========================================================
    const body = request.parts.map((part) => part.text ?? '').filter((part) => part !== '').join('\n');
    try {
      //M 将正文与可选跨渠道解析地址交由渠道适配器的直发逻辑写出；不交回结果的渠道照旧算已发。
      const returned = await adapter.sendDirectText(body, request, targetAddress);
      let outcome: TextReplyOutcome = { status: 'sent' };
      if (returned !== undefined) {
        outcome = returned;
      }
      //M 用渠道实际交回的状态为请求各段生成回执。
      const receipt = replyModule.getReceipt(request, outcome.status, outcome.reason);

      //G 只记已发、已存草稿的回执给同键重放；失败、不确定的，同键再来照样交给渠道再试。
      if (receipt.status === 'sent' || receipt.status === 'draft') {
        sent.set(request.replyRequestKey, { payloadHash: request.payloadHash, receipt });
      }
      //M 发出渠道交回的回执（不交回的就是 sent）。
      replyModule.emitReplied(ctx, request, receipt);
    } catch (error) {
      //G 直发过程抛出异常时，读取简洁错误说明并以 uncertain 状态回报。
      const reason = textModule.getErrorMessage(error);
      const receipt = replyModule.getReceipt(request, 'uncertain', reason);
      replyModule.emitReplied(ctx, request, receipt);
    }
  });
}
