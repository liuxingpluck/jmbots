/**
 * 机器人的前台：每个机器人对每个客户一场固定的“前台对话”（会话种类 front），渠道来的消息没被别的插件认领的，都先到它这儿。
 * 简单的话它自己答；不是一句话能答的，它调 hand_session 工具，转给一场后台会话去干，后台干完结果先交回前台，前台整理后回原渠道。
 * 派活的三个工具和结果队列在 Dispatch.ts（服务 ctx.frontDesk）。这个文件做四件事：
 *   - 定“这条消息进哪场会话”（onReceive：Bot.receive 问完 bot/receive 没人认领时，经 Dispatch.receive 调它）：
 *     按客户号（渠道:用户）进这个机器人的前台对话，没有就开一场；
 *     渠道标了只听（地址里 listenOnly，飞书群里没 @ 机器人的话）的，只记进前台对话当背景，不调模型、不回；
 *     只听的话地址里还带 judge（飞书 listen: judge 的群）：先问决策模型“该不该接话”，allow 才交给前台会话跑，deny、unsure 只记不回；
 *   - 往来记录：用户每说一句、机器人每回一句（含会话中途先说的 bot/say）各记一条；查历史只查本客户这场和它交办的后台；
 *   - 前台对话每一步的上下文 = 最近 N 条往来（一条 system 消息，动态拼上去，不进系统提示词）+ 这一轮的消息；
 *   - 三个只给前台对话用的查历史工具：history、history_search、history_get。
 *     查历史用 history_search / history_get（只查这场前台对话和它交办的后台会话；每轮一共最多 3 次）。
 * 前台只回答简单的问题和分派，绝对不自己干活。
 * 用户发了图片而前台模型不收图片：提醒前台把图转给后台；hand_session 这时新开的后台会话用看图模型（vision_model）。
 * 2026-11-17 由插件 bot-front-desk 并进 bots（用户 #114、#115）：只挪了位置，逻辑没改。
 * 记忆库只由 memory 读写，前台通过 ctx.memory 调，有就用（bots 的 apply 里 ctx.inject）：没挂 memory 时不记历史向量、搜历史没有语义结果，前台照常答话。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as namesModule from '../../utils/Names.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import type * as decisionPlugin from '../decision/index.ts';
import type * as memoryPlugin from '../memory/index.ts';
import type { ReceiveEvent } from './index.ts';
import * as protocol from '../../Channels.ts';


/** 查历史时每条截短到这么多字；全文用 history_get。 */
const HISTORY_CLIP = 240;

/** history_search / history_get 每次最多交回几条。 */
const HISTORY_PAGE = 20;

/** 这两个工具每轮一共最多调用几次。 */
const HISTORY_MAX_CALLS = 3;

/** 告诉前台怎么查历史、什么时候该交后台。 */
// 2026-11-14 17:45：“先调 memory 工具”那句只在挂了 memory 时加（MEMORY_HINT），没挂 memory 就没有这个工具，别让模型去调（Claude 17:34 第 6 节）。
const MEMORY_HINT = '分清两类问题：客户问事实、业务知识（合同、产品、售后负责人、联系方式、组织关系、价格和规则等），'
  + '先调 memory 工具查记忆（action: history 查这个客户的资料和以前的记录，action: knowledge 查知识库），查到就直接带 [编号] 和出处回答，查不到或要多步核实再 hand_session；'
  + '只有问“我们之前（在这场对话里）聊过什么、说过什么”才用 history_search / history_get。';
const HISTORY_HINT = ''
  + '你有只读工具 history_search、history_get，用来查找这场对话更早的往来（上面背景里已带最近若干条）。'
  + 'history_search 可按关键词、时间范围、发送人搜，也可从最早一条往后或从某个编号前后翻页；每次最多 20 条，每条截短并带编号和时间。'
  + '关键词按字匹配，同时做语义检索，说法不同也能对上（比如用「晚饭选项」能找到「今晚候选」）。'
  + 'history_get 按编号取一条全文。这两个工具每轮一共最多调用 3 次。'
  + '若需要通读或总结大量历史，不要自己反复翻，请用 hand_session 交给后台会话去办，你只负责把结论回给用户。';


/** 前台的配置：config.yaml 的 plugins 段里 bots 的 config.front，bots 的 apply 校验过。 */
export interface FrontDeskConfig {
  /** 前台对话每一步带上最近多少条往来。不写是 50。 */
  recent: number;
  /** 有图片要转后台时，新开的后台会话用哪个模型；不写就挑 config.yaml 里第一个写了 vision: true 的。 */
  vision_model?: string | undefined;
}


/** 问决策模型要不要接话时，带最近多少句群聊。 */
const JUDGE_LINES = 10;

/** 只听的话要不要接：题目。 */
const JUDGE_QUESTION = {
  instructions: '你是群里的助手。看最近的群聊，最后这句话需要你回复吗？有人在问你能回答的问题、在找你、或者明显需要帮忙时才回；闲聊、别人之间的对话、已经有人答了的，不回。',
  yes: '最后这句话需要你回复',
  no: '最后这句话不需要你回复（闲聊、别人之间的对话、已经有人答了）',
};


  /** 会话正在转时排着、等这一轮结束再判断要不要接话的那一句：前台会话号 → 最后一句的渠道、地址、话（以及可选的标准消息快照）。 */
  interface JudgeLater {
    channel: string;
    address: unknown;
    text: string;
    message?: protocol.ChannelMessage;
    botOrigin?: { channel: string; address: Record<string, unknown> };
    claimKey?: string;
  }


/** 往来记录里的一条：用户说的，或者机器人回的。库表 bot_log 的列和它一一对应。 */
interface BotLogEntry {
  /** 往来编号，库表 bot_log 的 id。 */
  id: number;
  /** 哪个机器人。 */
  bot: string;
  /** 哪个渠道。 */
  channel: string;
  /** 谁说的：user 用户；bot 机器人。 */
  who: 'user' | 'bot';
  /** 是哪场会话里的。 */
  sessionId: string;
  /** 说了什么。 */
  text: string;
  /** 毫秒时间戳。 */
  time: number;
}


/** 机器人的前台。 */
export class FrontDesk {
  /** memory 插件的服务；没挂 memory 时是 undefined（apply 里 ctx.inject 填）。 */
  memory: memoryPlugin.MemoryService | undefined;
  /** 这一轮已调用 history_search / history_get 的次数：前台会话号 → 次数。 */
  private readonly historyCalls = new Map<string, number>();
  /** 会话正在转时来的只听的话：前台会话号 → 排着的用户话；这一轮结束再存进对话（listen、session/change）。 */
  private readonly heard = new Map<string, piAi.Message[]>();
  /** 会话正在转时来的、要判断的话：前台会话号 → 最后一句；这一轮结束记完排着的话，再对它问一次决策模型（session/change）。 */
  private readonly judgeLater = new Map<string, JudgeLater>();
  /**
   * 建往来记录的表，登记三个查历史工具，挂四个监听（session/request、session/message、session/change、bot/say）。
   * @param ctx Cordis 给的 ctx。
   * @param config 带多少条往来。
   */
  constructor(private readonly ctx: cordis.Context, private readonly config: FrontDeskConfig) {
    this.ctx.resources.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot TEXT NOT NULL,
        channel TEXT NOT NULL,
        who TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        text TEXT NOT NULL,
        time INTEGER NOT NULL
      )
    `);
    this.ctx.resources.db.exec('CREATE INDEX IF NOT EXISTS bot_log_bot_time ON bot_log (bot, time)');
    this.ctx.resources.db.exec('CREATE INDEX IF NOT EXISTS bot_log_bot_session ON bot_log (bot, sessionId, id)');
    this.ctx.resources.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_log_vec (
        id INTEGER PRIMARY KEY,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL
      )
    `);

    //M history：往前翻这个机器人的往来记录。
    this.ctx.tools.register({
      definition: {
        name: 'history',
        description: '往前翻这个客户的往来记录（本场前台和它交办的后台），跨渠道。',
        parameters: piAi.Type.Object({
          count: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, description: '要几条，默认 20' })),
          before: piAi.Type.Optional(piAi.Type.Number({ description: '从哪个毫秒时间戳往前；不写就是从现在' })),
        }),
      },
      kinds: ['front'],
      run: (args, session) => {
        const count = (args['count'] as number | undefined) ?? 20;
        const entries = this.recent(session.row.bot, count, args['before'] as number | undefined, this.scopeIds(session));
        return entries.length === 0 ? '没有更早的往来。' : entries.map((entry) => formatEntry(entry)).join('\n');
      },
    });

    //M history_search：按关键词、时间、发送人搜这场对话的全部历史，或从最早一条/某个编号前后翻页。
    this.ctx.tools.register({
      definition: {
        name: 'history_search',
        description: '查找这场对话的全部历史往来（不限最近 N 条），只查当前这场前台对话和它交办出去的后台会话。'
          + '只用来回答“我们之前聊过什么”；问事实、业务知识（合同、负责人、联系方式等）先用 memory 的 history / knowledge 查记忆。'
          + '可按关键词、时间范围、发送人筛选，也可从最早一条往后、或从某个编号前后翻页。每次最多 20 条，每条截短并带编号和时间；要看全文用 history_get。'
          + '有关键词时同时做语义检索，说法不同也能对上（比如用「晚饭选项」能找到「今晚候选」）。'
          + '若需要通读或总结大量历史，不要反复调用本工具，请用 hand_session 交给后台会话。',
        parameters: piAi.Type.Object({
          keyword: piAi.Type.Optional(piAi.Type.String({ description: '要找的内容；按字匹配，同时做语义检索（说法不同也能对上）。不写就不按内容筛' })),
          from: piAi.Type.Optional(piAi.Type.Number({ description: '起始毫秒时间戳，含；不写就不限' })),
          to: piAi.Type.Optional(piAi.Type.Number({ description: '截止毫秒时间戳，含；不写就不限' })),
          who: piAi.Type.Optional(piAi.Type.String({ description: "只看谁说的：user 用户，bot 机器人；不写就都要" })),
          from_earliest: piAi.Type.Optional(piAi.Type.Boolean({ description: 'true：从最早一条往后翻；默认是从最近往前' })),
          after: piAi.Type.Optional(piAi.Type.Integer({ description: '从编号大于它的往来往后（更晚）翻' })),
          before: piAi.Type.Optional(piAi.Type.Integer({ description: '从编号小于它的往来往前（更早）翻' })),
          count: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, description: '要几条，默认 20，最多 20' })),
        }),
      },
      kinds: ['front'],
      run: (args, session) => this.searchHistory(session, args),
    });

    //M history_get：按编号取一条全文。
    this.ctx.tools.register({
      definition: {
        name: 'history_get',
        description: '按编号取一条往来的全文。编号来自 history_search 或最近往来背景里的 #号。',
        parameters: piAi.Type.Object({
          id: piAi.Type.Integer({ minimum: 1, description: '往来编号' }),
        }),
      },
      kinds: ['front'],
      run: (args, session) => this.getHistory(session, args['id'] as number),
    });

    //M list_sessions、hand_session、stop_session 在 Dispatch.ts（前台派后台和结果队列），bots 的 apply 里接着挂。

    //M 收消息不听 bot/receive：Bot.receive 问完 bot/receive 没人认领，才经 Dispatch.receive 调 onReceive。
    this.ctx.on('session/request', (request) => {
      this.onRequest(request);
    });
    this.ctx.on('session/message', (session, message) => {
      this.onMessage(session, message);
    });
    this.ctx.on('session/change', (session) => {
      //G 还在转 → 这一轮没结束，不记。
      if (session.row.state === 'running') return;

      //M channel_tool 轮只在收到 channel/replied 成功回执时记往来，不在 session/change 误把草稿写进 bot_log。
      const activeChannelTool = session.row.activeSourceSnapshot !== undefined
        || (session.row.resultQueue ?? []).some((item) => item.key === session.row.activeKey && item.deliveryMode === 'channel_tool');

      //M 前台派的后台（Dispatch.ts）和 channel_tool 轮的草稿不在这里直记，真正经渠道发完的才记。
      if (session.row.frontTask === undefined && !activeChannelTool) {
        this.logBot(session, session.row.reply);
      }
      if (session.row.kind === 'front') this.historyCalls.delete(session.row.id);

      //M 转的时候排着的只听的话，这一轮结束了存进对话。
      const waiting = this.heard.get(session.id);
      if (waiting !== undefined) {
        this.heard.delete(session.id);
        this.record(session, waiting);
      }

      //M 排着要判断的那句：这一轮的话都记完了，对最后一句问一次决策模型，要不要接着回。
      const later = this.judgeLater.get(session.id);
      if (later !== undefined) {
        this.judgeLater.delete(session.id);
        void this.followUp(session, later);
      }
    });
    this.ctx.on('bot/say', (session, text) => {
      //G channel_tool 会话的 bot/say 经 channel/reply 发，实际发出会在 channel/replied 记进 bot_log。
      if (session.row.activeSourceSnapshot !== undefined) return;

      this.logBot(session, text);
    });
    this.ctx.on('channel/replied', (event) => {
      const receipt = event.receipt;
      if (receipt.status !== 'sent' && receipt.status !== 'partial') return;

      const sentTexts = this.sentReplyTexts.get(receipt.replyRequestKey);
      this.sentReplyTexts.delete(receipt.replyRequestKey);
      if (sentTexts === undefined) return;

      //M 发送回执未绑定来源会话时从缓存目标找；已绑定会话的 channel_reply / bot/say 照此写进 bot_log。
      const front = this.findSessionByRoundKey(event.replyRoundKey);
      if (front === undefined) return;

      const row = front.row;
      this.log({
        bot: row.bot,
        channel: row.channel ?? '',
        who: 'bot',
        sessionId: row.id,
        text: sentTexts.text,
        time: Date.now(),
      });
    });
    this.ctx.on('channel/reply', (request) => {
      if (request.mode !== 'text') return;

      const text = request.parts.map((part) => part.text ?? '').filter((one) => one !== '').join('\n');
      if (text === '') return;

      this.sentReplyTexts.set(request.replyRequestKey, { text });
    });
  }

  /** 发出的 channel/reply 正文暂存（replyRequestKey → text），等 channel/replied 确认已发才写 bot_log。 */
  private readonly sentReplyTexts = new Map<string, { text: string }>();

  /** 延迟判断结果确认需要补入 channel_tool 队列时的回调（由 Dispatch 注入，避免循环引用）。 */
  onChannelJudgeAllow?: (
    botName: string,
    message: protocol.ChannelMessage,
    botOrigin: { channel: string; address: Record<string, unknown> },
    claimKey: string,
  ) => void;

  /**
   * 按来源作用域查找或新建这个机器人的前台对话（同 bot + sourceScope 优先，其次兼容同客户旧前态并补写 scope）。
   * @param bot 机器人名。
   * @param scope 来源域（渠道、账号、聊天）。
   * @param customer 兼容客户号（feishu:<openId> 或 feishu:group:<chatId>）。
   * @returns 前台会话对象。
   */
  findOrCreateFrontByScope(
    bot: string,
    scope: { channel: string; accountId: string; chatId: string },
    customer: string,
  ): Session {
    const fronts = this.ctx.sessions.find({ bot, kind: 'front' });
    const exact = fronts.find((row) => {
      const s = row.sourceScope;
      return s !== undefined && s.channel === scope.channel && s.accountId === scope.accountId && s.chatId === scope.chatId;
    });
    if (exact !== undefined) return this.ctx.sessions.open(exact.id);

    //M 未绑定其他账号的同客户旧前台：补写 sourceScope 沿用；不同 appId 的旧前台不混用。
    const compatible = customer === '' ? undefined : fronts.find((row) => {
      if (row.customer !== customer) return false;
      const existingApp = textModule.getText(row.address, 'appId');
      return row.sourceScope === undefined && (existingApp === '' || existingApp === scope.accountId);
    });
    if (compatible !== undefined) {
      const session = this.ctx.sessions.open(compatible.id);
      session.row.sourceScope = scope;
      session.save();
      return session;
    }

    const input: { bot: string; kind: string; sourceScope: { channel: string; accountId: string; chatId: string }; customer?: string } = {
      bot,
      kind: 'front',
      sourceScope: scope,
    };
    if (customer !== '') {
      input.customer = customer;
    }
    const session = this.ctx.sessions.create(input);
    return session;
  }

  /**
   * 标准 channel/message 下处理只听（listenOnly / judge）话：每个机器人独立存背景或问决策模型。
   * @param front 这个机器人的前台对话。
   * @param message 标准消息。
   * @param botOrigin 该机器人独立的兼容地址快照。
   * @param botText 规范化正文（已物化附件）。
   * @param claimKey 去重键。
   * @returns 处理结论与可选 judge 文案。
   */
  async handleChannelListen(
    front: Session,
    message: protocol.ChannelMessage,
    botOrigin: { channel: string; address: Record<string, unknown> },
    botText: string,
    claimKey: string,
  ): Promise<{ reply: boolean; text: string; outcome?: string }> {
    const sender = getSpeaker(botOrigin.address);
    const line = `${sender}：${botText}`;
    const needJudge = textModule.getField(botOrigin.address, 'judge') === true;

    if (!needJudge) {
      this.listen(front, botText, botOrigin.address);
      return { reply: false, text: botText };
    }

    if (front.row.state === 'running') {
      this.listen(front, botText, botOrigin.address);
      this.judgeLater.set(front.id, {
        channel: message.channel,
        address: botOrigin.address,
        text: botText,
        message,
        botOrigin,
        claimKey,
      });
      return { reply: false, text: botText, outcome: '只记' };
    }

    const judged = await this.judgeReply(front, botOrigin.address, line);
    this.markJudged(botOrigin.address, judged.outcome);
    if (!judged.reply) {
      this.listen(front, botText, botOrigin.address);
      return { reply: false, text: botText, outcome: judged.outcome };
    }

    delete botOrigin.address['listenOnly'];
    return { reply: true, text: line, outcome: judged.outcome };
  }

  /**
   * 按回复轮键找回关联的前台会话（用于 channel/replied 补记发送记录）。
   * @param roundKey 回复轮键。
   */
  private findSessionByRoundKey(roundKey: string): Session | undefined {
    for (const meta of this.ctx.sessions.find({ kind: 'front' })) {
      const matched = meta.activeSourceSnapshot?.replyRoundKey === roundKey
        || (meta.resultQueue ?? []).some((item) => item.replyControl?.roundKey === roundKey);
      if (matched) return this.ctx.sessions.open(meta.id);
    }
    for (const meta of this.ctx.sessions.find({ kind: 'work' })) {
      if (meta.activeSourceSnapshot?.replyRoundKey === roundKey) return this.ctx.sessions.open(meta.id);
    }
    return undefined;
  }

  /**
   * 定这条消息进哪场会话：进这个客户的前台对话。每个客户一场，没有就开。Bot.receive 问完 bot/receive 后经 Dispatch.receive 调。
   * 客户号只读渠道写在回话地址里的 address.customer。别的插件在 bot/receive 里已经定了去向（微信按客户、relay 转外部助手）的，这里不会再改。
   * @param event 哪个机器人、哪条消息；把会话填进 event.session。
   */
  async onReceive(event: ReceiveEvent): Promise<void> {
    //G 排在前面的插件已经定了去向、或者已经把这条处理掉了（handled）→ 不管。
    if (event.session !== undefined || event.handled === true) return;

    const bot = event.bot.name;
    const address = event.message.address;
    const customer = textModule.getText(address, 'customer');
    const found = this.ctx.sessions.find({ bot, kind: 'front', ...(customer === '' ? {} : { customer }) })[0];
    const session = found === undefined
      ? this.ctx.sessions.create({ bot, kind: 'front', ...(customer === '' ? {} : { customer }) })
      : this.ctx.sessions.open(found.id);

    //M 渠道标了只听（飞书登记了 listen: all 的群里没 @ 机器人的话）：记进这场前台对话当背景，不推它往下走、不回；这条就算处理掉了。
    if (textModule.getField(address, 'listenOnly') === true) {
      //M 要判断的群（listen: judge）：先问决策模型，allow 就当 @ 了机器人，照下面交给这场前台对话跑。
      if (textModule.getField(address, 'judge') === true && await this.judgeFirst(session, event)) {
        event.session = session;
        return;
      }
      this.listen(session, event.message.text, address);
      event.handled = true;
      return;
    }
    event.session = session;
  }

  /**
   * 只听的话要不要接：会话在转，话排着、这一轮结束再判断；不在转，马上问决策模型。
   * allow 时把话改成“说话人：话”（和只听记的一样）、去掉只听的标记，交回 true，由 onReceive 照 @ 机器人的路径交给会话；
   * 别的情况话记进对话（listen），结果写进地址的 judged（飞书记进来往流水），交回 false。
   * @param session 这个群的前台对话。
   * @param event 收到的话；allow 时改它的 message.text 和地址。
   * @returns 要不要接话。
   */
  private async judgeFirst(session: Session, event: ReceiveEvent): Promise<boolean> {
    const address = event.message.address;
    const sender = getSpeaker(address);
    const line = `${sender}：${event.message.text}`;

    //M 会话正在转：先排着，这一轮结束（session/change）再判断，这里只记下最后一句。
    if (session.row.state === 'running') {
      this.judgeLater.set(session.id, { channel: event.message.channel, address, text: event.message.text });
      return false;
    }

    const judged = await this.judgeReply(session, address, line);
    this.markJudged(address, judged.outcome);
    if (!judged.reply) return false;

    //M 接话：话带上说话人，去掉只听的标记（回话、relay、前台都不再当只听的）。
    event.message.text = line;
    const where = address as Record<string, unknown>;
    delete where['listenOnly'];
    return true;
  }

  /**
   * 问一次决策模型：这句话机器人该不该接。题目中文，现状给最近 JUDGE_LINES 句（谁说的：话）和最后这句。
   * 没挂决策模型、问出错：不接。deny、unsure 都不接。
   * @param session 这个群的前台对话。
   * @param address 回话地址：读 judgeThreshold。
   * @param last 最后这句（“说话人：话”）；还没记进对话时它排在最近几句后面，已经记了就传 undefined。
   * @returns reply 接不接；outcome 写进流水的结果（judge:回 / judge:不回(0.32)）。
   */
  private async judgeReply(session: Session, address: unknown, last: string): Promise<{ reply: boolean; outcome: string }> {
    const decision = this.ctx.get('decision') as decisionPlugin.Decision | undefined;
    if (decision === undefined) return { reply: false, outcome: 'judge:不回(没有决策模型)' };

    //M 最近 JUDGE_LINES 句：对话里的，加上还没记进去的最后一句。
    const lines = session.row.messages.map((message) => getLine(message, session.row.bot)).filter((one) => one !== '');
    const recent = [...lines, last].filter((one) => one !== '').slice(-JUDGE_LINES);
    const threshold = textModule.getField(address, 'judgeThreshold');
    const input: decisionPlugin.JudgeInput = {
      kind: 'group-listen',
      bot: session.row.bot,
      question: { ...JUDGE_QUESTION, instructions: `你是群里的助手 ${session.row.bot}。${JUDGE_QUESTION.instructions.slice('你是群里的助手。'.length)}` },
      state: { 最后一句: recent.at(-1) ?? '', 最近群聊: recent },
      ...(typeof threshold === 'number' ? { allowAt: threshold } : {}),
    };

    //T 跟踪：问决策模型要不要接话。
    const vars = { 会话: session.id, 几句: recent.length };
    this.ctx.emit('trace', 'FrontDesk.judge', '群里没 @ 机器人的话，问决策模型要不要接话', 'decision.judge(question)', vars);
    const verdict = await decision.judge(input);
    if (verdict.verdict === 'allow') return { reply: true, outcome: 'judge:回' };
    const score = verdict.score === undefined ? '' : `(${verdict.score.toFixed(2)})`;
    return { reply: false, outcome: `judge:不回${score}` };
  }

  /**
   * 把判断结果写在回话地址上（judged）：飞书 onMessage 收尾时读它，写进来往流水那一行。
   * @param address 回话地址。
   * @param outcome 结果。
   */
  private markJudged(address: unknown, outcome: string): void {
    (address as Record<string, unknown>)['judged'] = outcome;
  }

  /**
   * 这一轮结束后对排着的最后一句判断：allow 就把这句交给前台对话接着跑（照 bot.deliver：记渠道和地址、话进对话、推它往下走）。
   * 判断的结果补报一条 bot/judged（会话在转时那行流水已经写了“只记”，渠道补记一行）。
   * @param session 这个群的前台对话（排着的话已经记完）。
   * @param later 排着的最后一句。
   */
  private async followUp(session: Session, later: JudgeLater): Promise<void> {
    //M 这句话已经记在对话里了，不再往后加一次。
    const judged = await this.judgeReply(session, later.address, '');
    this.ctx.emit('bot/judged', later.address, later.text, judged.outcome);
    if (!judged.reply) return;

    //M 接话：channel_tool 路径经队列重新触发，旧路径沿 bots.route + session.run。
    delete (later.address as Record<string, unknown>)['listenOnly'];
    if (later.message !== undefined && later.botOrigin !== undefined && later.claimKey !== undefined && this.onChannelJudgeAllow !== undefined) {
      this.onChannelJudgeAllow(session.row.bot, later.message, later.botOrigin, later.claimKey);
      return;
    }

    this.ctx.bots.route(session, { channel: later.channel, address: later.address });
    await session.run();
  }

  /**
   * 只听的一句记进前台对话：前面带说话人（飞书查到的名字，没查到用 open_id 后 6 位），当成一句用户话存进对话，不调模型。
   * 下次有人 @ 机器人，这一轮从上次回答之后算起（onRequest 的 thisRound），模型就看得到这几句群聊。
   * 会话正在转就先排在 heard 里，这一轮结束（session/change）再记：免得插进工具调用和结果中间，也免得又引出一轮回答。
   * @param session 这个群的前台对话。
   * @param text 说的话。
   * @param address 回话地址：读 senderName、openId。
   * 副作用：改对话并存库、记一条往来；或者排进 heard。
   */
  private listen(session: Session, text: string, address: unknown): void {
    const openId = textModule.getText(address, 'openId');
    const sender = textModule.getText(address, 'senderName') || openId.slice(-6) || '有人';
    const message: piAi.Message = { role: 'user', content: `${sender}：${text}`, timestamp: Date.now() };

    if (session.row.state === 'running') {
      this.heard.set(session.id, [...(this.heard.get(session.id) ?? []), message]);
      return;
    }
    this.record(session, [message]);
  }

  /**
   * 只听的话存进对话（不走 session.add：那是要它往下走的话，下一步就会调模型），再各记一条往来。
   * @param session 前台对话。
   * @param messages 要存的用户话。
   * 副作用：改对话并存库；写往来记录。
   */
  private record(session: Session, messages: piAi.Message[]): void {
    session.row.messages.push(...messages);
    session.save();
    for (const message of messages) {
      this.onMessage(session, message);
    }

    //T 跟踪：只听的话记进前台对话。
    const vars = { 会话: session.id, 几句: messages.length };
    this.ctx.emit('trace', 'FrontDesk.record', '群里没 @ 机器人的话记进前台对话当背景，不回', 'session.row.messages.push(...)', vars);
  }

  /**
   * 响应 session/request：给前台对话拼上下文。
   * @param request 这一步的请求；改它的 messages。
   */
  private onRequest(request: ChatRequest): void {
    const row = request.session.row;

    //G 不是前台对话 → 不管。
    if (row.kind !== 'front') return;

    //M 这一轮的消息：channel_tool 活动项优先按记录的 startMessageIndex 取本轮起点（防止零次回复修复轮被 lastDone 截空）；
    //M   否则按上一次无 toolCall 回答之后取本轮。
    const active = (row.resultQueue ?? []).find((item) => item.key === row.activeKey);
    const fixedStart = active?.replyControl?.startMessageIndex;
    const lastDone = row.messages.findLastIndex((item) => {
      return item.role === 'assistant' && !item.content.some((block) => block.type === 'toolCall');
    });
    let thisRound = row.messages.slice(lastDone + 1);
    if (fixedStart !== undefined) {
      thisRound = row.messages.slice(fixedStart);
    }

    //M 零次回复兜底修复轮：只追加精确提示原文（不进会话消息列表、不进 bot_log），仅当还未调过回复工具时注入。
    const control = active?.replyControl;
    if (control !== undefined && control.reminder === 'running' && control.calledIds.length === 0) {
      request.system.push('你还没调用回复工具');
    }

    //M 最近往来：这一轮开始之前的最近 N 条，可能来自不同的渠道、不同的会话。
    const entries = this.recent(row.bot, this.config.recent, thisRound[0]?.timestamp, this.scopeIds(request.session));
    // 挂了 memory 才提 memory 工具。
    //M 非本人那一轮没有 memory 工具（approval 收了），不提；不受信的群里也不提（群里大家都看得到回复）。
    if (this.memory !== undefined && workspaceModule.privateAllowed(row.address)) request.system.push(MEMORY_HINT);
    request.system.push(HISTORY_HINT);

    //T 跟踪：拼最近往来。
    const vars = { 会话: row.id, 带了几条往来: entries.length, 这一轮几条: thisRound.length };
    this.ctx.emit('trace', 'FrontDesk.onRequest', '给前台对话拼上最近往来', 'request.messages = …', vars);
    request.messages = thisRound;
    if (entries.length === 0) {
      this.imageHint(request);
      return;
    }

    //M 拼成一条背景消息放在最前面，角色是 system：它是动态的上下文，不放进系统提示词。
    const lines = [
      '下面是你最近和用户的往来，按时间从早到晚，只是背景，不是用户这次说的话。',
      ...entries.map(formatEntry),
    ];
    const background: piAi.Message = { role: 'system', content: lines.join('\n'), timestamp: Date.now() };
    request.messages = [background, ...thisRound];
    //G 已有前台工具提示且非纯零次回复修复轮时按常规加提示，确保修复轮也能正常调用回复工具。
    this.imageHint(request);
  }

  /**
   * 这一轮用户发了图片 → 在最后加一句 system 提醒：前台能看图就自己答，不能看就转给后台看图，别说自己看不了。
   * @param request 这一步的请求。
   */
  private imageHint(request: ChatRequest): void {
    //G 整理后台结果的那一轮（Dispatch.ts）：结果里的图是交回的文件，不是用户发的。
    const active = (request.session.row.resultQueue ?? []).find((item) => item.key === request.session.row.activeKey);
    if (active !== undefined && active.kind === 'result') return;

    if (request.session.row.activeKey !== undefined && active === undefined) return;

    if (this.roundImages(request.session).length === 0) return;
    const hint = this.sees(request.model)
      ? '用户这一轮发了图片，图片已经直接发给你了，你能看到。只是看图、描述图、回答图里的问题，就自己直接回答，不要转后台、不要写脚本。'
      : '用户这一轮发了图片，你这个前台模型看不到图片。请直接调 hand_session，把用户的原话连同图片路径（@路径）原样交给后台，后台会用看图模型来看；不要回答说自己看不了。';
    request.messages = [...request.messages, { role: 'system', content: hint, timestamp: Date.now() }];
  }

  /**
   * 前台对话这一轮用户的话里 @ 的图片路径。Dispatch.ts 的 hand_session 也用。
   * @param session 前台对话。
   */
  roundImages(session: Session): string[] {
    const messages = session.row.messages;
    const lastDone = messages.findLastIndex((item) => item.role === 'assistant' && !item.content.some((block) => block.type === 'toolCall'));
    return messages.slice(lastDone + 1).flatMap((item) => (item.role === 'user' ? imageModule.getImagePaths(piAi.contentText(item.content)) : []));
  }

  /**
   * 这个模型收不收图片（config.yaml 里写了 vision: true）。Dispatch.ts 的 hand_session 也用。
   * @param model 供应商名/模型 ID。
   */
  sees(model: string): boolean {
    return this.ctx.resources.getModel(model).input.includes('image');
  }

  /** 看图模型：配置写的 vision_model；没写就挑第一个写了 vision: true 的；都没有是 undefined。Dispatch.ts 的 hand_session 也用。 */
  visionModel(): string | undefined {
    if (this.config.vision_model !== undefined) return this.config.vision_model;
    for (const [provider, item] of Object.entries(this.ctx.resources.config.providers)) {
      const id = Object.entries(item.models).find(([, model]) => model.input.includes('image'))?.[0];
      if (id !== undefined) return `${provider}/${id}`;
    }
    return undefined;
  }

  /**
   * 响应 session/message：用户说的话记一条往来。
   * @param session 哪场会话。
   * @param message 刚接进对话的那一条。
   */
  private onMessage(session: Session, message: piAi.Message): void {
    const row = session.row;

    //M 追踪本轮前台助手对渠道回复工具的调用（含参数错误、门禁拦截、仅 progress 或渠道发送失败，均计入已调用，不触发零次兜底）。
    if (row.kind === 'front' && row.activeKey !== undefined && message.role === 'assistant') {
      const active = (row.resultQueue ?? []).find((item) => item.key === row.activeKey);
      const replyControl = active?.replyControl;
      if (replyControl !== undefined && replyControl.policy === 'channel_tool') {
        const calls = message.content.filter((block): block is piAi.ToolCall => block.type === 'toolCall');
        let changed = false;
        for (const call of calls) {
          if (call.name !== 'channel_reply' && call.name !== 'channel_send_attachment') continue;
          if (replyControl.calledIds.some((recorded) => recorded.id === call.id)) continue;

          let replyKind: protocol.ReplyKind = 'final';
          if (call.arguments['kind'] === 'progress') {
            replyKind = 'progress';
          }
          replyControl.calledIds.push({ id: call.id, name: call.name, kind: replyKind });
          if (replyControl.reminder === 'running') {
            replyControl.outcome = 'attempted';
          }
          changed = true;
        }
        if (changed) {
          session.save();
        }
      }
    }

    //G 只记前台对话和干活的会话里用户说的；小会话（压缩、总结）里的不记。
    //G   干活的会话里的也记，这样前台的“最近往来”看得到交办出去的事。
    if (message.role !== 'user' || (row.kind !== 'front' && row.kind !== 'work')) return;

    if (row.kind === 'front') this.historyCalls.delete(row.id);

    this.log({
      bot: row.bot,
      channel: row.channel ?? '',
      who: 'user',
      sessionId: row.id,
      text: piAi.contentText(message.content),
      time: message.timestamp,
    });
  }

  /**
   * 机器人对用户说的话记一条往来：这一轮结束时的回话（session/change），或者会话中途先说的一句（bot/say）。
   * @param session 哪场会话。
   * @param text 说的话。
   */
  private logBot(session: Session, text: string): void {
    const row = session.row;

    //G 没有渠道（小会话）、没有话 → 不记。
    if (row.channel === undefined || text === '') return;

    this.log({
      bot: row.bot,
      channel: row.channel,
      who: 'bot',
      sessionId: row.id,
      text,
      time: Date.now(),
    });
  }

  /**
   * 这一轮再调一次历史工具的话，是不是已经满 3 次了。
   * @param session 前台对话。
   * @returns 满了就是拒绝的提示；没满就记下并返回 undefined。
   */
  private touchHistory(session: Session): string | undefined {
    const used = this.historyCalls.get(session.row.id) ?? 0;
    if (used >= HISTORY_MAX_CALLS) {
      return `本轮 history_search / history_get 已调用 ${String(HISTORY_MAX_CALLS)} 次，不能再查。若需要通读或总结大量历史，请用 hand_session 交给后台会话。`;
    }
    this.historyCalls.set(session.row.id, used + 1);
    return undefined;
  }

  /**
   * 当前前台对话能查的往来：这场前台自己的，再加上它交办出去的后台会话的。
   * 前台按客户分会话之后，自然只查本客户。Dispatch.ts 的 list_sessions 也用。
   * @param session 前台对话。
   */
  scopeIds(session: Session): string[] {
    //M 和 assist 一样：后台会话的 parent 是交出它的前台对话。
    const root = session.row.parent ?? session.row.id;
    const kids = this.ctx.sessions.find({ parent: root }).map((row) => row.id);
    const ids = new Set<string>([root, session.row.id, ...kids]);
    //M 还没记下 parent 的旧后台：只有一场前台时也算进来，免得分会话落地前查不到交办记录。
    //M   非本人（builder、guest）说的那一轮不算：旧后台不知道是谁的，可能是用户自己的活。
    if (workspaceModule.isOther(session.row.address)) return [...ids];
    if (session.row.kind === 'front' && this.ctx.sessions.find({ bot: session.row.bot, kind: 'front' }).length <= 1) {
      for (const work of this.ctx.sessions.find({ bot: session.row.bot, kind: 'work' })) {
        if (work.parent === undefined) ids.add(work.id);
      }
    }
    return [...ids];
  }

  /**
   * history_search：按条件翻一页，最多 20 条。有关键词时先按字匹配，再叠加语义检索，合并排序。
   * @param session 前台对话。
   * @param args 工具参数。
   */
  private async searchHistory(session: Session, args: Record<string, unknown>): Promise<string> {
    const denied = this.touchHistory(session);
    if (denied !== undefined) return denied;

    const ids = this.scopeIds(session);
    if (ids.length === 0) return '没有往来。';

    const take = Math.min(HISTORY_PAGE, Math.max(1, (args['count'] as number | undefined) ?? HISTORY_PAGE));
    const keyword = typeof args['keyword'] === 'string' ? args['keyword'].trim() : '';
    const who = args['who'] === 'user' || args['who'] === 'bot' ? args['who'] : undefined;
    const from = typeof args['from'] === 'number' ? args['from'] : undefined;
    const to = typeof args['to'] === 'number' ? args['to'] : undefined;
    const after = typeof args['after'] === 'number' ? args['after'] : undefined;
    const before = typeof args['before'] === 'number' ? args['before'] : undefined;
    const fromEarliest = args['from_earliest'] === true || after !== undefined;

    const filter = this.historyFilter(session.row.bot, ids, { who, from, to, after, before });
    const semantic = keyword === '' ? [] : await this.semanticHits(session, filter, keyword);
    const ranked = semantic.length > 0;
    const keywordRows = this.selectHistory(filter, keyword === '' ? undefined : keyword, fromEarliest, ranked ? 2000 : take);
    const union = uniqueById(keywordRows, semantic.map((hit) => hit.entry));
    const shown = ranked ? mergeHistoryHits(keywordRows, semantic, take) : keywordRows;
    if (shown.length === 0) return '没有符合条件的往来。';

    const total = union.length;
    const orderNote = ranked ? '按相关程度' : '按时间从早到晚';
    const head = `共 ${String(total)} 条，这页 ${String(shown.length)} 条（编号 ${String(shown[0]?.id)}–${String(shown[shown.length - 1]?.id)}，${orderNote}）。`
      + (total > shown.length ? '还有更多时，用 after 往后翻或 before 往前翻。' : '');
    return [head, ...shown.map((entry) => formatEntry(entry, HISTORY_CLIP))].join('\n');
  }

  /**
   * 历史筛选条件（不含关键词，给关键词路和语义路共用）。
   * @param bot 机器人名。
   * @param ids 这场对话范围内的会话号。
   * @param extra 发送人、时间、编号范围。
   */
  private historyFilter(bot: string, ids: string[], extra: { who?: 'user' | 'bot'; from?: number; to?: number; after?: number; before?: number }): { where: string; values: (string | number)[] } {
    const where: string[] = ['bot = ?', `sessionId IN (${ids.map(() => '?').join(', ')})`];
    const values: (string | number)[] = [bot, ...ids];
    if (extra.who !== undefined) {
      where.push('who = ?');
      values.push(extra.who);
    }
    if (extra.from !== undefined) {
      where.push('time >= ?');
      values.push(extra.from);
    }
    if (extra.to !== undefined) {
      where.push('time <= ?');
      values.push(extra.to);
    }
    if (extra.after !== undefined) {
      where.push('id > ?');
      values.push(extra.after);
    }
    if (extra.before !== undefined) {
      where.push('id < ?');
      values.push(extra.before);
    }
    return { where: where.join(' AND '), values };
  }

  /**
   * 按条件取出往来；keyword 有就再按字匹配。
   * @param filter 共用筛选。
   * @param keyword 要包含的字；不写就不按字筛。
   * @param fromEarliest 从早到晚（否则先取最近再翻成从早到晚）。
   * @param take 最多几条。
   */
  private selectHistory(filter: { where: string; values: (string | number)[] }, keyword: string | undefined, fromEarliest: boolean, take: number): BotLogEntry[] {
    const where = keyword === undefined || keyword === '' ? filter.where : `${filter.where} AND instr(text, ?) > 0`;
    const values = keyword === undefined || keyword === '' ? filter.values : [...filter.values, keyword];
    const order = fromEarliest ? 'id ASC' : 'id DESC';
    const sql = `SELECT id, bot, channel, who, sessionId, text, time FROM bot_log WHERE ${where} ORDER BY ${order} LIMIT ?`;
    const rows = this.ctx.resources.db.query(sql).all(...values, take) as BotLogEntry[];
    return fromEarliest ? rows : rows.reverse();
  }

  /**
   * 用记忆服务的本地嵌入给当前会话历史做语义检索；服务不可用就交回空数组，由调用方只保留关键词命中。
   * 优先 POST /embed（增量写入 bot_log_vec，本地余弦排序）；没有 /embed 再试 POST /ingest + /search（hybrid，不调大模型）。
   * @param session 前台对话。
   * @param filter 共用筛选。
   * @param keyword 查询句。
   */
  private async semanticHits(session: Session, filter: { where: string; values: (string | number)[] }, keyword: string): Promise<Array<{ entry: BotLogEntry; score: number }>> {
    //M 2026-11-14：记忆服务由 memory 插件托管，地址只有它知道；这里只调 ctx.memory。
    try {
      const byEmbed = await this.semanticByEmbed(filter, keyword);
      if (byEmbed !== undefined) return byEmbed;
      return await this.semanticBySearch(session, filter, keyword);
    } catch {
      return [];
    }
  }

  /**
   * 调 /embed：把还没向量的往来增量嵌入，和查询句算余弦，达到门槛的交回。
   * @param filter 共用筛选。
   * @param keyword 查询句。
   * @returns 服务没有 /embed 或模型没就绪时交回 undefined，好改走 /search。
   */
  private async semanticByEmbed(filter: { where: string; values: (string | number)[] }, keyword: string): Promise<Array<{ entry: BotLogEntry; score: number }> | undefined> {
    const queryVec = await this.embedTexts([keyword]);
    if (queryVec === undefined) return undefined;
    const q = queryVec[0];
    if (q === undefined) return [];

    const candidates = this.ctx.resources.db.query(
      `SELECT id, bot, channel, who, sessionId, text, time FROM bot_log WHERE ${filter.where} ORDER BY id DESC LIMIT 2000`,
    ).all(...filter.values) as BotLogEntry[];
    if (candidates.length === 0) return [];

    const missing = candidates.filter((entry) => this.getVec(entry.id) === undefined);
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const vectors = await this.embedTexts(batch.map((entry) => entry.text));
      if (vectors === undefined) return undefined;
      this.saveVecs(batch, vectors);
    }

    const hits: Array<{ entry: BotLogEntry; score: number }> = [];
    for (const entry of candidates) {
      const vec = this.getVec(entry.id);
      if (vec === undefined) continue;
      const score = cosine(q, vec);
      if (score >= SEMANTIC_MIN) hits.push({ entry, score });
    }
    hits.sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
    return hits.slice(0, HISTORY_PAGE);
  }

  /**
   * 调 /ingest + /search（hybrid，不调大模型）。嵌入由服务后台补，短等后再搜；仍没有命中就交回空。
   * @param session 前台对话。
   * @param filter 共用筛选。
   * @param keyword 查询句。
   */
  private async semanticBySearch(session: Session, filter: { where: string; values: (string | number)[] }, keyword: string): Promise<Array<{ entry: BotLogEntry; score: number }>> {
    const entries = this.ctx.resources.db.query(
      `SELECT id, bot, channel, who, sessionId, text, time FROM bot_log WHERE ${filter.where} ORDER BY id DESC LIMIT 2000`,
    ).all(...filter.values) as BotLogEntry[];
    if (entries.length === 0) return [];
    await this.syncLogs(session, entries);
    for (let i = 0; i < 8; i++) {
      if (i > 0) await Bun.sleep(400);
      const hits = await this.searchRemote(session, keyword);
      if (hits.length > 0) return hits;
    }
    return [];
  }

  /**
   * 把还没同步过的往来增量写入记忆服务（source 为 bot-log:会话号，start/end 为 bot_log 编号，方便对回原文）。
   * @param session 前台对话。
   * @param entries 范围内的往来。
   */
  private async syncLogs(session: Session, entries: BotLogEntry[]): Promise<void> {
    //G 隔离：没有客户号就不往记忆服务写（写进去会成为“没有客户”的聊天记录）。
    const customer = typeof session.row.customer === 'string' ? session.row.customer : '';
    if (customer === '') return;
    const groups = new Map<string, BotLogEntry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.sessionId) ?? [];
      list.push(entry);
      groups.set(entry.sessionId, list);
    }
    for (const [sessionId, list] of groups) {
      const source = `bot-log:${sessionId}`;
      //M 往来也是聊天记录：进不进关系图由 memory 插件定（history_graph / no_graph_customers），这里不管。
      const docs: memoryPlugin.HistoryDoc[] = list.map((entry) => ({
        source,
        scope: 'history',
        bot: entry.bot,
        customer,
        session: sessionId,
        title: entry.who === 'user' ? '用户' : '机器人',
        text: entry.text,
        at: entry.time,
        start: entry.id,
        end: entry.id,
      }));
      await this.memory?.recordHistory(source, docs);
    }
  }

  /**
   * 向记忆服务发 hybrid 检索（不走 graph，避免调大模型），把命中对回 bot_log。
   * @param session 前台对话。
   * @param keyword 查询句。
   */
  private async searchRemote(session: Session, keyword: string): Promise<Array<{ entry: BotLogEntry; score: number }>> {
    //G 隔离：检索必须带客户号，没有就不搜。
    const customer = typeof session.row.customer === 'string' ? session.row.customer : '';
    if (customer === '') return [];
    const hits = (await this.memory?.searchHistory({ query: keyword, bot: session.row.bot, customer, limit: HISTORY_PAGE })) ?? [];
    const out: Array<{ entry: BotLogEntry; score: number }> = [];
    const seen = new Set<number>();
    for (const hit of hits) {
      if (hit === null || typeof hit !== 'object') continue;
      const rec = hit as { start?: unknown; score?: unknown; text?: unknown };
      const id = typeof rec.start === 'number' ? rec.start : undefined;
      if (id === undefined || seen.has(id)) continue;
      const row = this.ctx.resources.db.query(
        'SELECT id, bot, channel, who, sessionId, text, time FROM bot_log WHERE id = ? AND bot = ?',
      ).get(id, session.row.bot) as BotLogEntry | null;
      if (row === null || !this.scopeIds(session).includes(row.sessionId)) continue;
      seen.add(id);
      const score = typeof rec.score === 'number' ? rec.score : 0;
      out.push({ entry: row, score });
    }
    return out;
  }

  /**
   * 调记忆服务 POST /embed。404、模型没就绪或网络失败交回 undefined。
   * @param texts 要嵌入的文字。
   */
  private async embedTexts(texts: string[]): Promise<number[][] | undefined> {
    return this.memory?.embed(texts);
  }

  /**
   * 读一条已缓存的向量。
   * @param id bot_log 编号。
   */
  private getVec(id: number): number[] | undefined {
    const row = this.ctx.resources.db.query('SELECT vec FROM bot_log_vec WHERE id = ?').get(id) as { vec: Uint8Array | Buffer } | null;
    if (row === null) return undefined;
    return unpackVec(row.vec);
  }

  /**
   * 把一批向量写入 bot_log_vec。
   * @param entries 对应的往来。
   * @param vectors 向量，和下标一一对应。
   */
  private saveVecs(entries: BotLogEntry[], vectors: number[][]): void {
    const query = this.ctx.resources.db.query('INSERT OR REPLACE INTO bot_log_vec (id, dim, vec) VALUES (?, ?, ?)');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const vec = vectors[i];
      if (entry === undefined || vec === undefined) continue;
      query.run(entry.id, vec.length, packVec(vec));
    }
  }

  /**
   * history_get：取一条全文，只给这场对话范围内的。
   * @param session 前台对话。
   * @param id 往来编号。
   */
  private getHistory(session: Session, id: number): string {
    const denied = this.touchHistory(session);
    if (denied !== undefined) return denied;

    const row = this.ctx.resources.db.query(
      'SELECT id, bot, channel, who, sessionId, text, time FROM bot_log WHERE id = ? AND bot = ?',
    ).get(id, session.row.bot) as BotLogEntry | null;
    if (row === null || !this.scopeIds(session).includes(row.sessionId)) return `没有编号 ${String(id)} 的往来，或不属于这场对话。`;
    return formatEntry(row);
  }

  /**
   * 一个机器人最近的往来；可以限定在若干场会话里（前台对话加它交办的后台）。
   * @param bot 机器人名。
   * @param count 要几条。
   * @param before 从哪个时间往前数（不含）；不给就是从现在。
   * @param sessionIds 只看这些会话；不给就这个机器人全部。
   * @returns 照时间从早到晚。
   */
  private recent(bot: string, count: number, before?: number, sessionIds?: string[]): BotLogEntry[] {
    const until = before ?? Date.now() + 1;
    if (sessionIds !== undefined && sessionIds.length === 0) return [];
    let sql = 'SELECT id, bot, channel, who, sessionId, text, time FROM bot_log WHERE bot = ? AND time < ?';
    const values: (string | number)[] = [bot, until];
    if (sessionIds !== undefined) {
      sql += ` AND sessionId IN (${sessionIds.map(() => '?').join(', ')})`;
      values.push(...sessionIds);
    }
    sql += ' ORDER BY time DESC, id DESC LIMIT ?';
    values.push(count);
    const rows = this.ctx.resources.db.query(sql).all(...values) as BotLogEntry[];
    return rows.reverse();
  }

  /**
   * 记一条往来。
   * @param entry 谁说的、哪个渠道、哪场会话、说了什么。
   * 副作用：写库。
   */
  private log(entry: Omit<BotLogEntry, 'id'>): void {
    const query = this.ctx.resources.db.query(
      'INSERT INTO bot_log (bot, channel, who, sessionId, text, time) VALUES (?, ?, ?, ?, ?, ?)',
    );
    query.run(entry.bot, entry.channel, entry.who, entry.sessionId, entry.text, entry.time);
  }

  /**
   * 撤回消息时清掉排在 judgeLater 里还没问决策模型的同源消息，避免当前轮结束后又去判断接话。
   * @param event 渠道撤回事件。
   */
  cancelRecall(event: protocol.ChannelRecallEvent): void {
    for (const [sessionId, later] of this.judgeLater.entries()) {
      const msg = later.message;
      if (msg === undefined || msg.messageId !== event.messageId) continue;

      let allowed = event.recalledBy.isOwner;
      if (!allowed && event.recalledBy.kind === 'sender') {
        allowed = event.recalledBy.id === '' || event.recalledBy.id === msg.sender.id;
      }
      if (!allowed) continue;

      this.judgeLater.delete(sessionId);
    }
  }
}


/**
 * 只听的话的说话人：飞书查到的名字，没查到用 open_id 后 6 位。
 * @param address 回话地址。
 */
function getSpeaker(address: unknown): string {
  return textModule.getText(address, 'senderName') || textModule.getText(address, 'openId').slice(-6) || '有人';
}


/**
 * 对话里的一句换成“谁说的：话”给决策模型看：用户话已经带说话人（只听记的），机器人的话前面加机器人名；别的（工具结果）不要。
 * @param message 一条消息。
 * @param bot 机器人名。
 * @returns 一行文字；没有文字是 ''。
 */
function getLine(message: piAi.Message, bot: string): string {
  if (message.role === 'toolResult') return '';
  const content: unknown = message.content;
  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content : []).map((part: unknown) => textModule.getText(part, 'text')).join('');
  if (text.trim() === '') return '';
  return message.role === 'assistant' ? `${bot}：${text.trim()}` : text.trim();
}


/**
 * 把一条往来写成一行：[时间 渠道 谁] 话。
 * @param entry 往来。
 */
function formatEntry(entry: BotLogEntry, clip?: number): string {
  const when = new Date(entry.time).toLocaleString('zh-CN', { hour12: false });
  const who = entry.who === 'user' ? '用户' : '机器人';
  let body = entry.text;
  let suffix = '';
  if (clip !== undefined && body.length > clip) {
    body = body.slice(0, clip);
    suffix = '…（全文用 history_get 取）';
  }
  return `#${String(entry.id)} [${when} ${entry.channel} ${who}] ${body}${suffix}`;
}


/** 语义命中的最低余弦相似度（bge-m3 已 L2 归一化）。 */
const SEMANTIC_MIN = 0.22;


// 2026-11-14：resolveMemoryUrl / memoryPluginUrl 去掉——前台不再读 memory 插件的配置，记忆服务地址归 memory 插件（ctx.memory）。


/**
 * 把关键词命中和语义命中按编号合并，语义分数高的靠前；只要关键词命中也保留。
 * @param keywordRows 按字匹配到的往来。
 * @param semantic 语义命中。
 * @param take 最多留几条。
 */
function mergeHistoryHits(keywordRows: BotLogEntry[], semantic: Array<{ entry: BotLogEntry; score: number }>, take: number): BotLogEntry[] {
  const scores = new Map<number, { entry: BotLogEntry; score: number }>();
  for (const entry of keywordRows) {
    scores.set(entry.id, { entry, score: 1 });
  }
  for (const hit of semantic) {
    const prev = scores.get(hit.entry.id);
    if (prev === undefined) scores.set(hit.entry.id, hit);
    else if (hit.score + 1 > prev.score) scores.set(hit.entry.id, { entry: prev.entry, score: hit.score + 1 });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.entry.id - b.entry.id).slice(0, take).map((row) => row.entry);
}


/**
 * 按编号去重，先出现的留下。
 * @param groups 若干组往来。
 */
function uniqueById(...groups: BotLogEntry[][]): BotLogEntry[] {
  const seen = new Set<number>();
  const out: BotLogEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}


/**
 * 余弦相似度；长度不同或零向量交回 0。
 * @param a 向量 a。
 * @param b 向量 b。
 */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}


/**
 * 把浮点向量打成 blob 存库。
 * @param vec 向量。
 */
function packVec(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i] ?? 0, i * 4);
  return buf;
}


/**
 * 从库里的 blob 还原浮点向量。
 * @param raw SQLite 交回的二进制。
 */
function unpackVec(raw: Uint8Array | Buffer): number[] | undefined {
  const bytes = raw instanceof Buffer ? raw : Buffer.from(raw);
  if (bytes.length < 4 || bytes.length % 4 !== 0) return undefined;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) out.push(bytes.readFloatLE(i));
  return out;
}


// 2026-11-14：postJson 去掉——记忆服务的 HTTP 调用都在 memory 插件（ctx.memory）里。
// 2026-11-17：自己的 sleep 去掉，改用 Bun.sleep（http、memory、runs 也这么等）。
// 2026-11-17：并进 bots，apply 去掉：配置校验、建 FrontDesk 和 Dispatch、接 memory 都在 bots/index.ts 的 apply。
