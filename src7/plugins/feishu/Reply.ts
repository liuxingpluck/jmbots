/**
 * 飞书回话：响应标准事件 channel/reply（会话的回复，按 replyRequestKey 去重，带 target 时跨聊天认目标）
 * 和 channel/send（Outbound 已批准的主动发件，原样直发）。发出去的写进聊天日志（History.ts）。
 * 回复去重记录存 channels/feishu/replies/<应用>.jsonl。
 * 会话一轮结束的旧路发送（bots.channel 登记的 send）、别的插件调的 sendText 还在 index.ts 的 Feishu 上。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as namesModule from '../../utils/Names.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as protocol from '../../Channels.ts';
import * as approvedSend from '../approval/Outbound.ts';
import type { ProviderReceipt } from '../programs/ChannelSend.ts';
import * as api from './Api.ts';
import type { FeishuChatLogEntry } from './History.ts';
import { feishuCustomer } from './index.ts';
import type { Feishu, FeishuAddress } from './index.ts';
import * as media from './Media.ts';


/** 跨聊天发话认出的目标聊天（FeishuReply.getChatCandidates 的候选带着它，findChatByIdOrName 认中后交回）。 */
interface FeishuChatFound {
  /** 应用号；群名缓存和配置群认出的不带，是空串。 */
  appId: string;
  /** 聊天号。 */
  chatId: string;
  /** p2p 私聊、group 群聊。 */
  chatType: string;
  /** 群名；私聊、没有是空串。 */
  chatName: string;
}


/** 飞书发送幂等记录（存于 channels/feishu/replies/<appId>.jsonl）。 */
interface FeishuReplyRecord {
  /** 回复请求幂等键。 */
  replyRequestKey: string;
  /** 正文载荷摘要。 */
  payloadHash: string;
  /** 保存下来的回执。 */
  receipt: protocol.ReplyReceipt;
}


/** 飞书回话：Feishu 构造时建一个，挂在 feishu.reply 上。 */
export class FeishuReply {
  /** 渠道名。 */
  readonly name = 'feishu';

  /** 回复幂等键缓存（replyRequestKey → 记录）。 */
  private readonly replyCache = new Map<string, FeishuReplyRecord>();

  /** 已从磁盘加载过回复幂等文件的应用集合。 */
  private readonly loadedReplyApps = new Set<string>();

  /**
   * 登记 channel/reply、channel/send 监听。构造时不碰运行时目录。
   * @param ctx 飞书插件的 Cordis 上下文（随插件卸载自动注销监听）。
   * @param feishu 飞书渠道：应用、群名缓存、配置、聊天日志、来往流水、撤回登记，@ 人和撤表情。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly feishu: Feishu,
  ) {
    //M 统一渠道回复出口（接口 A）：监听 channel/reply，只发送纯文字并返回 channel/replied 回执。
    this.ctx.on('channel/reply', (request) => this.onChannelReply(request));

    //M 主动发送只接本渠道的已批准意图，回执交回 Outbound。
    const channelSendOptions = {
      filter: (request: { call: approvedSend.ApprovedChannelSend }) => request.call.channel === this.name,
    };
    //M 登记主动发送的请求和回执，处理过的结果交给申请方记账。
    requestEventModule.onRequestEvent(
      this.ctx,
      'channel/send',
      'channel/sent',
      async (request) => {
        const receipt = await this.sendApprovedText(request.call);
        return { receipt };
      },
      channelSendOptions,
    );
  }

  /** 按批准载荷原样直发，返回运输状态。成功后写一条聊天历史。 */
  private async sendApprovedText(call: approvedSend.ApprovedChannelSend): Promise<ProviderReceipt> {
    //G 渠道只消费 Outbound 已经持久批准的原对象。
    const approved = approvedSend.takeChannelSendApproval(call);
    if (!approved) return { status: 'failed', reason: '主动发件缺少有效批准' };

    const { account, chat, sendId, text } = call;
    //G 按批准时绑定的账号取应用，找不到就返回明确的失败回执。
    const app = this.feishu.apps.get(account);
    if (app === undefined) return { status: 'failed', reason: '批准指定的飞书应用未配置' };

    let providerId: string;
    try {
      //M 发送已批准的原文。用飞书 chat_id 直发，保留正文中的 @路径 等普通文字。
      const content = { text };
      const uuid = call.intentId;
      providerId = await media.message(this.feishu, account, chat, 'text', content, undefined, uuid);
    } catch (error) {
      //G 只有飞书明确拒收时才记发送失败。传输异常留给本人从原意图查询。
      const reason = textModule.getErrorMessage(error);
      if (error instanceof api.NotSent) return { status: 'failed', reason };

      return { status: 'uncertain', reason };
    }

    //M 飞书已受理。历史落盘故障只写诊断日志，保留供应方的发送结果。
    const messageId = JSON.stringify([this.name, account, providerId || sendId]);
    const entry: FeishuChatLogEntry = {
      messageId,
      nativeId: providerId || null,
      appId: account,
      chatId: chat,
      direction: 'bot',
      createdAt: Date.now(),
      sender: { id: app.botOpenId ?? app.config.bot, name: app.config.bot },
      text,
      mentions: [],
      attachments: [],
    };
    try {
      this.feishu.history.appendChatLog(account, chat, entry);
    } catch (error) {
      const reason = textModule.getErrorMessage(error);
      console.error(`飞书主动消息 ${sendId} 已发送，聊天历史写入失败：${reason}`);
    }
    return { status: 'sent' };
  }

  /**
   * 响应 channel/reply（接口 A）：仅接受本渠道且 mode === 'text' 的纯文字发送（绝不把 @/abs/path 解释为附件）。
   * 支持按 replyRequestKey 幂等与同键冲突拒绝；发送完写入渠道回执日志、聊天历史并 emit channel/replied。
   * @param request 回复请求。
   */
  private async onChannelReply(request: protocol.ChannelReplyRequest): Promise<void> {
    if (request.channel !== this.name || request.handled === true) return;

    request.handled = true;

    if (request.mode !== 'text') {
      //M 当前统一回复口仅实现纯文字模式，拒绝非文本请求并回报不支持状态。
      const reason = 'capability_unsupported：飞书 channel/reply 当前只支持纯文字';
      const rejected = protocol.getReceipt(request, 'rejected', reason);
      protocol.emitReplied(this.ctx, request, rejected);
      return;
    }

    //M 默认沿用当前轮绑定的来源地址；若请求附带 target，只在飞书自有群/私聊/流水数据中认出目标聊天。
    let appId = request.sourceSnapshot.accountId;
    let chatId = request.sourceSnapshot.chatId;
    let address: FeishuAddress = {
      ...(request.sourceSnapshot.origin.address as unknown as FeishuAddress),
      appId,
      chatId,
      messageId: request.sourceSnapshot.nativeId ?? '',
    };
    if (request.target !== undefined) {
      //M 按目标渠道自带的认聊天逻辑解析目标应用与地址，认不出即回 rejected。
      const targetResolved = this.getReplyTargetAddress(request.bot, request.target.chat);
      if (typeof targetResolved === 'string') {
        const rejected = protocol.getReceipt(request, 'rejected', targetResolved);
        protocol.emitReplied(this.ctx, request, rejected);
        return;
      }
      appId = targetResolved.appId;
      chatId = targetResolved.chatId;
      address = targetResolved;
    }

    //M 按应用号和幂等键查历史发信回执，保证同一条回复重发不重复投递。
    const existing = this.getReplyRecord(appId, request.replyRequestKey);
    if (existing !== undefined) {
      if (existing.payloadHash === request.payloadHash) {
        //M 同键同载荷命中幂等记录，直接复播原有回执。
        protocol.emitReplied(this.ctx, request, existing.receipt);
        return;
      }
      //M 同键不同载荷说明重放冲突，拒绝发送并告知上游拒绝回执。
      const reason = 'reply_conflict：同一 replyRequestKey 的发送内容不一致';
      const rejected = protocol.getReceipt(request, 'rejected', reason);
      protocol.emitReplied(this.ctx, request, rejected);
      return;
    }

    //M 校验请求指向的飞书应用与会话 chatId 有效，缺失则直接拒发。
    const app = this.feishu.apps.get(appId);
    if (app === undefined || chatId === '') {
      //M 反馈目标应用或会话无效的拒绝回执。
      const reason = '飞书应用或聊天号无效';
      const rejected = protocol.getReceipt(request, 'rejected', reason);
      protocol.emitReplied(this.ctx, request, rejected);
      return;
    }
    const rawText = request.parts.map((part) => part.text ?? '').filter((part) => part !== '').join('\n');
    //M 补齐群聊 @ 发信人前缀并将文内 @昵称 替换为飞书 <at> 标签。
    const body = this.feishu.mentioned(address, this.feishu.withAt(address, rawText));

    let receipt: protocol.ReplyReceipt;
    try {
      let providerId = '';
      if (body.trim() !== '') {
        //M 非空白正文经统一发信方法发出（按原消息号回复，必要时退回直发）。
        const messageBody = { text: body };
        const replyTo = address.messageId || undefined;
        providerId = await media.message(this.feishu, appId, chatId, 'text', messageBody, replyTo);
      }
      //M 飞书把各段合成一条消息，平台编号随首段和整张回执交回。
      receipt = protocol.getReceipt(request, 'sent');
      if (providerId !== '') {
        receipt.messageIds = [providerId];
        const first = receipt.parts[0];
        if (first !== undefined) {
          first.providerId = providerId;
        }
      }
      let nativeOutId: string | null = null;
      if (providerId !== '') {
        nativeOutId = providerId;
      }
      //M 将机器人发出回复同步写入本地聊天历史以便 channel/history 查询回溯。
      this.feishu.history.appendChatLog(appId, chatId, {
        messageId: JSON.stringify([this.name, appId, providerId || `out_${request.requestId}`]),
        nativeId: nativeOutId,
        appId,
        chatId,
        direction: 'bot',
        createdAt: receipt.at,
        sender: { id: app.botOpenId ?? request.bot, name: request.bot },
        text: rawText,
        mentions: [],
        attachments: [],
      });
      if (request.kind === 'final' && address.typingReaction !== undefined) {
        //M 最终回复发出后立即撤销之前挂上的“敲键盘”表态。
        await this.feishu.untype(address);
      }
    } catch (error) {
      //M 发信失败时解析错误说明，按 Api.NotSent 区分明确拒收与超时未知状态。
      const reason = textModule.getErrorMessage(error);
      let status: protocol.ReplyStatus = 'uncertain';
      if (error instanceof api.NotSent) {
        status = 'rejected';
      }
      //M 为每一段保留飞书返回的失败状态和原因。
      receipt = protocol.getReceipt(request, status, reason);
    }

    //M 落盘回复幂等记录，保存每次发送回执的哈希与状态。
    this.saveReplyRecord(appId, {
      replyRequestKey: request.replyRequestKey,
      payloadHash: request.payloadHash,
      receipt,
    });
    //M 对外推送 channel/replied 标准化回执事件通知上游发信方。
    protocol.emitReplied(this.ctx, request, receipt);
  }

  /**
   * 仅从飞书自有数据（群名缓存、groups 配置、feishu_p2p 表、来往流水与聊天日志）识别跨渠道/跨聊天发送目标。
   * 认不出时交回明确原因“没有叫 X 的聊天”；认出时交回干净的 FeishuAddress（不带原消息号与 openId，避免误 @ 路人）。
   * @param bot 当前机器人名。
   * @param rawChat 调用方给出的原始聊天串（群号、群名、私聊名或 appId:chatId）。
   */
  private getReplyTargetAddress(bot: string, rawChat: string): FeishuAddress | string {
    //M 各种查找分支共用同一条找不到目标的说明。
    const notFound = protocol.getChatNotFoundMessage(rawChat);

    //M 拆目标串：去掉网页展示的“飞书·群·”“飞书·私聊·”前缀（剩下的按群名、人名认），拆出“前缀:聊天”。
    const labelPrefixes = ['飞书·群·', '飞书·私聊·'];
    const target = protocol.parseChatTarget(rawChat, labelPrefixes);
    if (target.exact === '') return notFound;

    //M 查询绑定到该机器人的全部飞书应用号，校验或限定 appId 前缀。
    const allowedApps = this.feishu.getApps(bot);
    if (allowedApps.length === 0) return notFound;

    //G “应用号:聊天”的应用不归这个机器人，不替它发。
    const isChannelPrefix = target.prefix === this.name;
    const isAppPrefix = !isChannelPrefix && this.feishu.apps.has(target.prefix);
    if (isAppPrefix && !allowedApps.includes(target.prefix)) return notFound;

    //M “应用号:聊天”只在这个应用里找；“feishu:聊天”在这个机器人的全部应用里找。
    let candidateApps = allowedApps;
    if (isAppPrefix) {
      candidateApps = [target.prefix];
    }

    //M 这两种写法都按冒号右边认号和名字；别的前缀整串当聊天号。
    let lookupChat = target.exact;
    let labelTarget = target.label;
    if (isAppPrefix || isChannelPrefix) {
      lookupChat = target.chat;
      labelTarget = target.chat;
    }

    //M 按群名缓存、配置群、私聊表、来往流水、本地聊天日志的先后认聊天，认到就停。
    const candidates = this.getChatCandidates(candidateApps, lookupChat);
    const found = protocol.findChatByIdOrName(candidates, lookupChat, labelTarget);
    if (found === undefined) return notFound;

    //M 群名缓存和配置群认出的不带应用号：优先挑本地存着这个聊天日志的应用，否则取绑定列表第一个应用。
    let appId = found.appId;
    if (appId === '') {
      appId = this.feishu.history.getAppWithLog(candidateApps, found.chatId) ?? '';
    }
    if (appId === '') {
      appId = candidateApps[0] ?? '';
    }
    if (appId === '') return notFound;

    //M 返回干净的目标地址，openId 与 messageId 置空避免群里误 @ 路人或错挂回复。
    const isP2p = found.chatType === 'p2p';
    const address: FeishuAddress = {
      appId,
      chatId: found.chatId,
      messageId: '',
      openId: '',
      chatType: found.chatType,
      customer: feishuCustomer(found.chatType, found.chatId, '', isP2p),
    };
    if (found.chatName !== '') {
      address.chatName = found.chatName;
    }
    return address;
  }

  /**
   * 飞书认目标聊天的候选清单，按先后交出：群名缓存、配置群、私聊表、来往流水、本地聊天日志。
   * 边认边拼：findChatByIdOrName 认到就停，后面的来源（查私聊表、读流水、看日志文件）不再做。
   * @param candidateApps 这次能用的应用号（机器人绑定的，或“应用号:聊天”指定的那一个）。
   * @param lookupChat 要找的号；本地聊天日志只能按号认。
   */
  private *getChatCandidates(
    candidateApps: string[],
    lookupChat: string,
  ): Generator<protocol.ChatCandidate<FeishuChatFound>> {
    //M 1) 已缓存的飞书群（群号、群名），不带应用号。
    for (const [id, info] of this.feishu.chats) {
      const value = { appId: '', chatId: id, chatType: 'group', chatName: info.name };
      yield { ids: [id], names: [info.name], value };
    }

    //M 2) 配置 groups 里登记的群（群号、群名），不带应用号。
    for (const group of this.feishu.config.groups.values()) {
      const value = { appId: '', chatId: group.chatId, chatType: 'group', chatName: group.name };
      yield { ids: [group.chatId], names: [group.name], value };
    }

    //M 3) 飞书私聊表 feishu_p2p：按聊天号、open_id 或 people 里登记的人名认，只看能用的应用。
    const p2pSql = 'SELECT app_id, chat_id, open_id FROM feishu_p2p ORDER BY at DESC LIMIT 200';
    const p2pQuery = this.ctx.resources.db.query(p2pSql);
    const p2pRows = p2pQuery
      .all() as Array<{ app_id: string; chat_id: string; open_id: string }>;
    for (const row of p2pRows) {
      if (!candidateApps.includes(row.app_id)) {
        continue;
      }

      //M 私聊除了聊天号和人员号，也可以按人员配置中的名字匹配。
      const personName = this.feishu.config.people.get(row.open_id)?.name ?? '';
      const value = { appId: row.app_id, chatId: row.chat_id, chatType: 'p2p', chatName: '' };
      yield { ids: [row.chat_id, row.open_id], names: [personName], value };
    }

    //M 4) 来往流水 data/logs/feishu-contacts.jsonl（新的在前）：按聊天号、群名认，私聊还按对方的名字认。
    for (const contact of this.feishu.contacts.list(500)) {
      if (!candidateApps.includes(contact.app)) {
        continue;
      }

      const names = [contact.chatName];
      if (contact.chatType === 'p2p') {
        //M 私聊把对方的名字纳入匹配，群聊仍按群名认目标。
        names.push(contact.sender);
      }
      const value = {
        appId: contact.app,
        chatId: contact.chatId,
        chatType: contact.chatType || 'group',
        chatName: contact.chatName,
      };
      yield { ids: [contact.chatId], names, value };
    }

    //M 5) 最后看本地有没有这个号的聊天日志（只认号）；ou_ 开头的是私聊。
    const appWithLog = this.feishu.history.getAppWithLog(candidateApps, lookupChat);
    if (appWithLog === undefined) return;

    let chatType = 'group';
    if (lookupChat.startsWith('ou_')) {
      chatType = 'p2p';
    }
    const value = { appId: appWithLog, chatId: lookupChat, chatType, chatName: '' };
    yield { ids: [lookupChat], names: [], value };
  }

  /** 飞书回复幂等记录文件（channels/feishu/replies/<app>.jsonl）。 */
  private replyLogFile(appId: string): string {
    //M 初始化存储各飞书应用已发回复幂等凭据的运行时目录。
    const dir = this.ctx.resources.ensureRuntimeDir('channels', 'feishu', 'replies');
    return path.join(dir, `${namesModule.getSafeName(appId, Infinity)}.jsonl`);
  }

  /** 确保把该应用历史回复幂等键读入内存缓存。 */
  private ensureReplyLoaded(appId: string): void {
    //G 同一应用的历史幂等记录只首次加载，后续查内存。
    if (this.loadedReplyApps.has(appId)) return;

    //M 首次访问该应用时标记已加载，并逐行把历史幂等记录装载进内存 Map。
    this.loadedReplyApps.add(appId);
    const file = this.replyLogFile(appId);
    if (!fs.existsSync(file)) return;

    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line) as FeishuReplyRecord;
        this.replyCache.set(rec.replyRequestKey, rec);
      } catch {
        continue;
      }
    }
  }

  /** 查同应用已保存的回复幂等记录。 */
  private getReplyRecord(appId: string, replyRequestKey: string): FeishuReplyRecord | undefined {
    //M 先懒加载历史回复日志，再从内存缓存检索对应请求幂等键。
    this.ensureReplyLoaded(appId);
    return this.replyCache.get(replyRequestKey);
  }

  /** 保存并持久化回复幂等记录。 */
  private saveReplyRecord(appId: string, record: FeishuReplyRecord): void {
    //M 先同步加载防覆盖旧键，再同时写入内存索引和磁盘 jsonl 追加日志。
    this.ensureReplyLoaded(appId);
    this.replyCache.set(record.replyRequestKey, record);
    fs.appendFileSync(this.replyLogFile(appId), `${JSON.stringify(record)}\n`, 'utf8');
  }
}
