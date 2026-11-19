/** 渠道消息的前台认领与延迟判断接话。 */
import type * as cordis from 'cordis';
import type { Session, SessionMeta } from '../../Sessions.ts';
import * as protocol from '../../Channels.ts';
import * as utils from '../../utils/index.ts';
import type { DispatchResults, QueueItem, ReplyControl } from './DispatchResults.ts';
import type { FrontDesk } from './FrontDesk.ts';
import type { Bot } from './index.ts';

/** 定下前台会话，保存来源快照，然后交给现有队列处理。 */
export class DispatchClaim {
  /** 接住前台的延迟接话决定，和普通认领共用结果队列。 */
  constructor(
    private readonly home: cordis.Context,
    private readonly desk: FrontDesk,
    private readonly queue: DispatchResults,
  ) {
    //M 前台对延迟的只听话判断 allow 之后，要把它补进 channel_tool 队列：队列归本类管，前台不知道队列，所以挂这个回调给它调。
    this.desk.onChannelJudgeAllow = (botName, message, botOrigin, claimKey) => {
      //M 按名字找机器人对象，名单里没有（配置改过）就算了。
      const bot = this.home.bots.get(botName);
      if (bot === undefined) return;

      //M 把这条话当用户的话排进前台的单队列，等前台空闲了处理。
      this.enqueueJudgeFollowUp(bot, message, botOrigin, claimKey);
    };
  }

  /**
   * 认领一条标准消息、排进前台单队列（channel_tool），前台空着就开始跑。
   * @param bot 目标机器人。
   * @param message 标准消息。
   * @param botOrigin 该机器人独立的兼容地址快照。
   * @param botText 规范化文本（含本机器人工作区物化后的附件提示）。
   * @param claimKey 去重认领键。
   * @param control 可选协调对象。
   * @param target 指定的前台（消息带 routing.sessionId、bots 已核对过是这个机器人的前台）；不给按来源范围找。
   */
  async claimChannelMessage(
    bot: Bot,
    message: protocol.ChannelMessage,
    botOrigin: { channel: string; address: Record<string, unknown> },
    botText: string,
    claimKey: string,
    control?: protocol.ChannelMessageControl,
    target?: Session,
  ): Promise<void> {
    //M 来源域（渠道、账号、聊天）决定进哪场前台；客户号读地址里的 customer，没有旧前台可兼容时用它新开。
    const scope = { channel: message.channel, accountId: message.accountId, chatId: message.chatId };
    const customer = utils.getStringField(botOrigin.address, 'customer');

    //M 进哪场前台：指定了就是它；没指定按来源范围（渠道、账号、聊天）找，没有就开。
    let picked = target;
    if (picked === undefined) {
      picked = this.desk.findOrCreateFrontByScope(bot.name, scope, customer);
    }
    const front = picked;
    const explicit = target !== undefined;

    //G 同一条消息对该机器人已经认领过（front 或 sourceClaims 已记）→ 返回 duplicate，不再重复入队。
    const claimedList = front.row.sourceClaims ?? [];
    const queue = front.row.resultQueue ?? [];
    const queuedSame = queue.some((item) => item.claimKey === claimKey || item.key === claimKey);
    if (claimedList.includes(claimKey) || queuedSame) {
      control?.claims.push({
        bot: bot.name,
        claimKey,
        status: 'duplicate',
        sessionKind: 'front',
        sessionId: front.id,
      });
      return;
    }

    //M 群里只听的话：先按本机器人独立配置存背景或问决策模型，只有 judge=allow 才继续入队跑一轮。
    let inputText = botText;
    if (utils.getField(botOrigin.address, 'listenOnly') === true) {
      const listened = await this.desk.handleChannelListen(front, message, botOrigin, botText, claimKey);
      if (!listened.reply) {
        front.row.sourceClaims = [...(front.row.sourceClaims ?? []), claimKey].slice(-200);
        front.save();
        const record: protocol.ChannelClaimRecord = {
          bot: bot.name,
          claimKey,
          status: 'listen',
          sessionKind: 'front',
          sessionId: front.id,
        };
        if (listened.outcome !== undefined) {
          record.judged = listened.outcome;
        }
        //M 原渠道收到只听的认领记录，可以把判断结论写进来往流水。
        control?.claims.push(record);
        return;
      }
      inputText = listened.text;
    }

    //M 先固定来源快照和回复轮，再一起持久保存认领键和排队项。
    const item = this.getClaimItem(front, bot, message, botOrigin, inputText, claimKey);
    this.persistClaim(front, item, scope, explicit);

    //M 把认领结果与可选的判断结论交给原渠道。
    const claimRecord = this.getClaimRecord(bot.name, claimKey, front.id, botOrigin.address);
    control?.claims.push(claimRecord);

    //M channel_tool 首条输入也经同一个 drain 设置 activeKey 与快照后才启动 Session.run。
    if (front.row.state !== 'running' && front.row.activeKey === undefined) {
      this.queue.drain(front);
    }
  }

  /** 保留该次认领和渠道流水需要的判断结果。 */
  private getClaimRecord(
    botName: string,
    claimKey: string,
    sessionId: string,
    address: Record<string, unknown>,
  ): protocol.ChannelClaimRecord {
    const claimRecord: protocol.ChannelClaimRecord = {
      bot: botName,
      claimKey,
      status: 'claimed',
      sessionKind: 'front',
      sessionId,
    };
    //M 地址里带决策模型的结论（judged）就记进认领回执，飞书把它写进来往流水。
    const judgedText = utils.getStringField(address, 'judged');
    if (judgedText !== '') {
      claimRecord.judged = judgedText;
    }
    return claimRecord;
  }

  /** 构造待运行的渠道项及该轮采用的回复策略。 */
  private getClaimItem(
    front: Session,
    bot: Bot,
    message: protocol.ChannelMessage,
    botOrigin: { channel: string; address: Record<string, unknown> },
    inputText: string,
    claimKey: string,
  ): QueueItem {
    //M 构造本轮不可变来源快照（深拷贝 origin，避免后续渠道地址覆盖）。
    const replyRoundKey = protocol.getReplyRoundKey(message.messageId, bot.name, 'receive');
    const snapshot: protocol.SourceSnapshot = {
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
      origin: { channel: botOrigin.channel, address: structuredClone(botOrigin.address) },
      visibility: structuredClone(message.visibility),
      botName: bot.name,
      claimKey,
      replyRoundKey,
    };
    if (message.sender.name !== undefined) {
      snapshot.senderName = message.sender.name;
    }

    //M 网页发话时带的“正在看哪儿”：跟着快照走，前台这一轮的提示（ChannelTools）和历史工具的默认目标都读它。
    if (message.view !== undefined) {
      snapshot.view = structuredClone(message.view);
    }

    const replyControl: ReplyControl = {
      roundKey: replyRoundKey,
      policy: 'channel_tool',
      startMessageIndex: front.row.messages.length,
      calledIds: [],
      nextReplyIndex: 0,
      reminder: 'none',
      receiptKeys: [],
    };

    //M 一对一的渠道（网页、命令行、微信）写了 autoFinal：零次回复时直接把最后的话发出去，不跑修复轮。
    if (message.routing.autoFinal === true) {
      replyControl.autoFinal = true;
    }

    return {
      key: claimKey,
      kind: 'user',
      hash: '',
      source: { type: 'user', id: message.channel },
      origin: { channel: botOrigin.channel, address: structuredClone(botOrigin.address) },
      payload: { text: inputText, files: [], sourceSnapshot: snapshot },
      stage: 'queued',
      note: '',
      at: Date.now(),
      deliveryMode: 'channel_tool',
      claimKey,
      replyControl,
    };
  }

  /** 在同一个事务里保存认领、队列与按范围找到的前台。 */
  private persistClaim(
    front: Session,
    item: QueueItem,
    scope: NonNullable<SessionMeta['sourceScope']>,
    explicit: boolean,
  ): void {
    const claimKey = item.key;
    //M 认领键和队列项在一个数据库事务里一起写：排队、记已认领、存库，任何一步抛错整个回滚，内存里的值还原。
    const db = this.home.resources.db;
    const beforeClaims = front.row.sourceClaims;
    const beforeQueue = front.row.resultQueue;
    const commitClaim = db.transaction(() => {
      front.row.sourceClaims = [...(beforeClaims ?? []), claimKey].slice(-200);
      front.row.resultQueue = [...(beforeQueue ?? []), item];

      //M 按范围找到的前台记下范围；指定的前台可能是别的渠道的（网页接着飞书群的前台说），不改它的范围。
      if (!explicit) {
        front.row.sourceScope = scope;
      }

      //M 认领键、队列项、来源范围都改好了，存库（和上面同属一个事务）。
      front.save();
    });

    //M 执行事务；失败就把内存里的认领键和队列还原，再把错误抛给渠道。
    try {
      commitClaim();
    } catch (error) {
      front.row.sourceClaims = beforeClaims;
      front.row.resultQueue = beforeQueue;
      throw error;
    }
  }

  /**
   * 延迟 judge 决定接话（followUp）时把已写入 messages 的原话补入 channel_tool 队列并唤醒 drain。
   * @param bot 目标机器人。
   * @param message 标准消息。
   * @param botOrigin 已经去掉 listenOnly 的兼容地址快照。
   * @param claimKey 原认领键。
   */
  private enqueueJudgeFollowUp(
    bot: Bot,
    message: protocol.ChannelMessage,
    botOrigin: { channel: string; address: Record<string, unknown> },
    claimKey: string,
  ): void {
    //M 按来源域和客户号找到这场前台（延迟判断时会话已存在，没有才新开）。
    const scope = { channel: message.channel, accountId: message.accountId, chatId: message.chatId };
    const customer = utils.getStringField(botOrigin.address, 'customer');
    const front = this.desk.findOrCreateFrontByScope(bot.name, scope, customer);
    const followKey = `${claimKey}:followup`;

    //G 同一条已经补过队了（followKey 在队列里）→ 不再补。
    if ((front.row.resultQueue ?? []).some((item) => item.key === followKey)) return;

    //M 给这次延迟接话编一个回复轮键，写进来源快照，修复轮、回执都认它。
    const replyRoundKey = protocol.getReplyRoundKey(message.messageId, bot.name, 'judge_followup');
    const snapshot: protocol.SourceSnapshot = {
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
      origin: { channel: botOrigin.channel, address: structuredClone(botOrigin.address) },
      visibility: structuredClone(message.visibility),
      botName: bot.name,
      claimKey: followKey,
      replyRoundKey,
    };
    if (message.sender.name !== undefined) {
      snapshot.senderName = message.sender.name;
    }
    const startIndex = Math.max(0, front.row.messages.length - 1);
    const replyControl: ReplyControl = {
      roundKey: replyRoundKey,
      policy: 'channel_tool',
      startMessageIndex: startIndex,
      calledIds: [],
      nextReplyIndex: 0,
      reminder: 'none',
      receiptKeys: [],
    };
    const item: QueueItem = {
      key: followKey,
      kind: 'user',
      hash: '',
      source: { type: 'user', id: message.channel },
      origin: { channel: botOrigin.channel, address: structuredClone(botOrigin.address) },
      payload: { text: '', files: [], sourceSnapshot: snapshot },
      stage: 'queued',
      note: '',
      at: Date.now(),
      deliveryMode: 'channel_tool',
      claimKey: followKey,
      alreadyRecorded: true,
      replyControl,
    };

    //M 补进前台的队列（原话已经记在对话里了，处理时不再加一遍），存库。
    front.row.resultQueue = [...(front.row.resultQueue ?? []), item];
    front.save();

    //M 前台空闲（没在转、没有正在处理的项）就开始处理队列。
    if (front.row.state !== 'running' && front.row.activeKey === undefined) {
      this.queue.drain(front);
    }
  }
}
