/** 渠道消息的前台认领；群里只听的话交给群攒批（GroupBatch.ts），判断要接的一批也从这里排进前台。 */
import type * as cordis from 'cordis';
import type { Session, SessionMeta } from '../../Sessions.ts';
import * as protocol from '../channels/index.ts';
import * as utils from '../../utils/index.ts';
import type { DispatchResults, QueueItem, ReplyControl } from './DispatchResults.ts';
import type { FrontDesk } from './FrontDesk.ts';
import * as groupBatchModule from './GroupBatch.ts';
import type { Bot, IncomingMessage, ReceiveEvent } from './index.ts';

/** 会话的 sourceClaims 最多保留最近多少个已认领去重键。 */
const CLAIM_HISTORY_MAX = 200;

/**
 * 这场会话是不是已经认领过这条消息（已记在 sourceClaims 或已在 resultQueue 里）。
 * @param session 目标会话（前台或别的插件认领的会话）。
 * @param claimKey 去重认领键（普通消息是 claimKey，群攒批接话是 `${claimKey}:batch`）。
 * @returns 已经认领过是 true。
 */
export function isClaimed(session: Session, claimKey: string): boolean {
  const claimedList = session.row.sourceClaims ?? [];
  if (claimedList.includes(claimKey)) return true;

  const queue = session.row.resultQueue ?? [];
  return queue.some((item) => item.claimKey === claimKey || item.key === claimKey);
}

/**
 * 把去重键追加到会话的已认领清单（只留最近 200 个，不改原数组）；落盘由调用方做（事务里和队列项一起存）。
 * @param session 认领这条消息的会话。
 * @param claimKey 去重认领键。
 */
export function rememberClaim(session: Session, claimKey: string): void {
  const existing = session.row.sourceClaims ?? [];
  session.row.sourceClaims = [...existing, claimKey].slice(-CLAIM_HISTORY_MAX);
}

/**
 * 往入站协调对象追加一条认领记录（control 没传就跳过）。
 * @param control 随渠道事件传进来的协调对象。
 * @param bot 机器人名。
 * @param claimKey 去重认领键。
 * @param status 认领结论。
 * @param session 认领进的会话；handled 时没有。
 */
export function pushClaim(
  control: protocol.ChannelMessageControl | undefined,
  bot: string,
  claimKey: string,
  status: protocol.ChannelClaimRecord['status'],
  session?: Session,
): void {
  if (control === undefined) return;

  const record: protocol.ChannelClaimRecord = { bot, claimKey, status };
  if (session !== undefined) {
    record.sessionKind = session.row.kind;
    record.sessionId = session.id;
  }
  control.claims.push(record);
}

/** 定下前台会话，保存来源快照，然后交给现有队列处理。 */
export class DispatchClaim {
  /** 群攒批：只听的话进它的缓冲；叫了机器人时拿走攒着的；撤回时 DispatchRecall 调它拿掉。 */
  readonly batch: groupBatchModule.GroupBatch;

  /**
   * 建群攒批；认领和接话的一批共用结果队列。
   * @param home bots 插件的 ctx。
   * @param desk 前台：找前台、只听的话记背景。
   * @param queue 结果队列：排进去、前台空着就开跑。
   * @param batchConfig 入口校验过的 bots 的 group_batch；undefined 是没开攒批。
   */
  constructor(
    private readonly home: cordis.Context,
    private readonly desk: FrontDesk,
    private readonly queue: DispatchResults,
    batchConfig: groupBatchModule.GroupBatchConfig | undefined,
  ) {
    this.batch = new groupBatchModule.GroupBatch(home, desk, this, batchConfig);
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

    //G 同一条消息对该机器人已经认领过（sourceClaims 或 resultQueue 已记）→ 返回 duplicate，不再重复入队。
    if (isClaimed(front, claimKey)) {
      pushClaim(control, bot.name, claimKey, 'duplicate', front);
      return;
    }

    //M 群里只听的话（channel/listen，bots 在地址副本上标了 listenOnly）：listen: judge 的群进群攒批，别的记进前台当背景；都不跑这一轮。
    if (utils.getField(botOrigin.address, 'listenOnly') === true) {
      this.claimListen(bot, front, { text: botText, message, botOrigin, claimKey }, control);
      return;
    }

    //M 叫了机器人的话：这个群攒着没判断的一批拿出来，拼在这句前面一起交给前台（缓冲清空）。
    let inputText = botText;
    const earlier = this.batch.take(front.id);
    if (earlier.length > 0) {
      inputText = ['群里在这之前没叫你的话：', ...earlier, '', '叫你的这句：', botText].join('\n');
    }

    //M 先固定来源快照和回复轮，再一起持久保存认领键和排队项。
    const item = this.getClaimItem(front, bot, message, botOrigin, inputText, claimKey);
    this.persistClaim(front, item, scope, explicit);

    //M 把认领结果交给原渠道（写进来往流水）。
    pushClaim(control, bot.name, claimKey, 'claimed', front);

    //M channel_tool 首条输入也经同一个 drain 设置 activeKey 与快照后才启动 Session.run。
    if (front.row.state !== 'running' && front.row.activeKey === undefined) {
      this.queue.drain(front);
    }
  }

  /**
   * 认领一句只听的话：listen: judge 的群（开了攒批）进群攒批的缓冲，别的记进前台对话当背景；都不跑这一轮。
   * 认领键记到前台上（渠道重发认得出来），认领记录写 listen（飞书流水写“只记”，判断的结果另由 bot/judged 补一行）。
   * @param bot 目标机器人。
   * @param front 这个机器人在这个群的前台。
   * @param heard 这一句：话、标准消息、地址副本、认领键。
   * @param control 可选协调对象。
   */
  private claimListen(
    bot: Bot,
    front: Session,
    heard: groupBatchModule.Heard,
    control: protocol.ChannelMessageControl | undefined,
  ): void {
    //M 进群攒批；没收（没开攒批、不是 judge 的群）就记成背景。
    const batched = this.batch.add(front, heard);
    if (!batched) {
      this.desk.listen(front, heard.text, heard.botOrigin.address);
    }

    //M 认领键记到前台上，只留最近 200 个；认领记录交给原渠道。
    rememberClaim(front, heard.claimKey);
    front.save();
    pushClaim(control, bot.name, heard.claimKey, 'listen', front);
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
    const snapshot = protocol.getSourceSnapshot(message, bot.name, botOrigin, claimKey, replyRoundKey);

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
      rememberClaim(front, claimKey);
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
   * 群攒批判断要接话：照这一批最后一句排进前台的单队列（channel_tool），这一批（几行“说话人：话”）当这一轮的话，回话回到这个群。
   * 和认领一句话走同一套：拼来源快照和回复轮、认领键和排队项一起存、前台空着就开跑。GroupBatch.look 调。
   * @param front 这个机器人在这个群的前台。
   * @param last 这一批最后一句。
   * @param text 这一批的话。
   */
  enqueueBatch(front: Session, last: groupBatchModule.Heard, text: string): void {
    //G 机器人名单里没有了（配置改过）：不排。
    const bot = this.home.bots.get(front.row.bot);
    if (bot === undefined) return;

    //G 这一批已经排过（键在队列里或认领过）：不再排。
    const batchKey = `${last.claimKey}:batch`;
    if (isClaimed(front, batchKey)) return;

    //M 地址副本去掉只听的标记：这一轮要回。
    const address = structuredClone(last.botOrigin.address);
    delete address['listenOnly'];
    const botOrigin = { channel: last.botOrigin.channel, address };

    //M 拼排队项，和认领键一起存进前台。
    const message = last.message;
    const item = this.getClaimItem(front, bot, message, botOrigin, text, batchKey);
    const scope = { channel: message.channel, accountId: message.accountId, chatId: message.chatId };
    this.persistClaim(front, item, scope, false);

    //M 前台空闲（没在转、没有正在处理的项）就开始处理队列。
    if (front.row.state !== 'running' && front.row.activeKey === undefined) {
      this.queue.drain(front);
    }
  }

  /**
   * 群攒批判断要接话、这个群登记了 judge_helper：这一批不排进前台自答，转给外部助手。
   * 照 bots 的认领关口发一次 bot/receive（地址副本去掉 listenOnly、写上 relayHelper）；
   * relay 认领了（填了 session）就把这一批交给那场会话，一轮结束回原渠道。
   * GroupBatch.look 调，调之前已把这一批记成前台背景。
   * @param front 这个机器人在这个群的前台。
   * @param last 这一批最后一句。
   * @param text 这一批的话。
   * @param helper 转给哪个外部助手（relay 的 helpers 里的名字）。
   */
  async relayBatch(front: Session, last: groupBatchModule.Heard, text: string, helper: string): Promise<void> {
    //G 机器人名单里没有了（配置改过）：不转。
    const bot = this.home.bots.get(front.row.bot);
    if (bot === undefined) return;

    //M 地址副本去掉只听的标记、写上转给谁：这一批要有人回，relay 读 relayHelper。
    const address = structuredClone(last.botOrigin.address);
    delete address['listenOnly'];
    address['relayHelper'] = helper;

    //M 照这一批最后一句拼一条收件，经认领关口问一遍。
    const message = last.message;
    const incoming: IncomingMessage = {
      channel: message.channel,
      bot: bot.name,
      text,
      time: message.createdAt,
      address,
      sourceId: message.messageId,
    };
    const receiveEvent: ReceiveEvent = { bot, message: incoming };
    await this.home.serial('bot/receive', receiveEvent);

    //G 没人认领（没挂 relay、它不认）或被处理掉了：不转，这一批已经是前台背景。
    const claimed = receiveEvent.session;
    if (receiveEvent.handled === true || claimed === undefined) return;

    //M 交给认领的那场会话（relay 的外部助手会话），记下回话往哪送。
    const origin = { channel: last.botOrigin.channel, address };
    bot.deliver(claimed, incoming.text, origin);
  }
}
