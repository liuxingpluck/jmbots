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
 *   - 给 memory_search 和 memory_get 提供前台归档，范围是这场前台及它交办的后台会话。
 * 前台只回答简单的问题和分派，绝对不自己干活。
 * 用户发了图片而前台模型不收图片：提醒前台把图转给后台；hand_session 这时新开的后台会话用看图模型（vision_model）。
 * 2026-11-17 由插件 bot-front-desk 并进 bots（用户 #114、#115）：只挪了位置，逻辑没改。
 * 记忆库只由 memory 读写，前台发请求事件 memory/request 请它办（askMemory，2026-11-18 起不再 inject memory）：
 *   没挂 memory 时不记历史向量、搜历史没有语义结果，前台照常答话；“先查记忆”的提示由 memory 自己在 session/request 里加。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as namesModule from '../../utils/Names.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import type * as decisionPlugin from '../decision/index.ts';
import * as historyTools from '../memory/HistoryTools.ts';
import type { FrontEntry as BotLogEntry, FrontMessage, FrontQuery } from '../memory/FrontArchive.ts';
import * as memoryKeyModule from '../memory/MemoryKey.ts';
import type { ReceiveEvent } from './index.ts';
import * as protocol from '../../Channels.ts';


/** 查历史时每条截短到这么多字；全文用 history_get。 */
const HISTORY_CLIP = 240;

/** history_search / history_get 每次最多交回几条。 */
const HISTORY_PAGE = 20;

/** 这两个工具每轮一共最多调用几次。 */
const HISTORY_MAX_CALLS = 3;

/** 提醒前台如何翻这场往来和取全文。 */
const HISTORY_HINT = '用 memory_search 的 front=true 翻看本场及已交办会话的往来，可按 who、时间或编号筛选。'
  + '带 #编号的往来可把该编号作为 ref 交给 memory_get 取全文。'
  + '需要通读或总结大量历史时用 hand_session 交给后台会话。';

/** 工具 history 给模型看的：往前翻这个客户的往来（旧名，经 memory 的统一归档入口转发）。 */
const HISTORY_TOOL: piAi.Tool = {
  name: 'history',
  description: '往前翻这个客户的往来记录（本场前台和它交办的后台），跨渠道。',
  parameters: piAi.Type.Object({
    count: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, description: '要几条，默认 20' })),
    before: piAi.Type.Optional(piAi.Type.Number({ description: '从哪个毫秒时间戳往前；不写就是从现在' })),
  }),
};

/** 工具 history_search 给模型看的：按关键词、时间、发送人、编号翻这场对话的全部往来。 */
const HISTORY_SEARCH_TOOL: piAi.Tool = {
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
};

/** 工具 history_get 给模型看的：按编号取一条往来的全文。 */
const HISTORY_GET_TOOL: piAi.Tool = {
  name: 'history_get',
  description: '按编号取一条往来的全文。编号来自 history_search 或最近往来背景里的 #号。',
  parameters: piAi.Type.Object({
    id: piAi.Type.Integer({ minimum: 1, description: '往来编号' }),
  }),
};


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


/** 历史查询的附加条件，未提供的字段不参与筛选。 */
interface HistoryRange {
  /** 只取这一类发送人。 */
  who?: 'user' | 'bot';
  /** 最早时间，含。 */
  from?: number;
  /** 最晚时间，含。 */
  to?: number;
  /** 只取此编号之后的往来。 */
  after?: number;
  /** 只取此编号之前的往来。 */
  before?: number;
}

/** 机器人的前台。 */
export class FrontDesk {
  /** 这一轮已调用 history_search / history_get 的次数：前台会话号 → 次数。 */
  private readonly historyCalls = new Map<string, number>();
  /** 会话正在转时来的只听的话：前台会话号 → 排着的用户话；这一轮结束再存进对话（listen、session/change）。 */
  private readonly heard = new Map<string, piAi.Message[]>();
  /** 会话正在转时来的、要判断的话：前台会话号 → 最后一句；这一轮结束记完排着的话，再对它问一次决策模型（session/change）。 */
  private readonly judgeLater = new Map<string, JudgeLater>();
  /**
   * 建往来记录的表，登记三个查历史工具。
   * 监听 session/request、session/message、session/change、bot/say、channel/replied、channel/reply。
   * @param ctx Cordis 给的 ctx。
   * @param config 带多少条往来。
   */
  constructor(private readonly ctx: cordis.Context, private readonly config: FrontDeskConfig) {
    //M history：把往前翻页的旧名交给统一归档入口，交 getRecentHistory 取往前 count 条。
    historyTools.registerHistoryAlias(this.ctx, 'front-recent', {
      definition: HISTORY_TOOL,
      kinds: ['front'],
      run: (args, session) => this.getRecentHistory(session, args),
    });

    //M history_search：旧关键词、发送人和编号翻页参数走与 memory_search 相同的归档入口，交 searchHistory 搜（受每轮次数限制）。
    historyTools.registerHistoryAlias(this.ctx, 'front-search', {
      definition: HISTORY_SEARCH_TOOL,
      kinds: ['front'],
      run: (args, session) => this.searchHistory(session, args),
    });

    //M history_get：旧数字编号与 memory_get 的带前缀编号共用同一份往来记录，交 getHistory 取全文（受每轮次数限制）。
    historyTools.registerHistoryAlias(this.ctx, 'front-get', {
      definition: HISTORY_GET_TOOL,
      kinds: ['front'],
      run: (args, session) => this.getHistory(session, args['id'] as number),
    });

    //M list_sessions、hand_session、stop_session 在 Dispatch.ts（前台派后台和结果队列），bots 的 apply 里接着挂。

    //M 收消息不听 bot/receive：Bot.receive 问完 bot/receive 没人认领，才经 Dispatch.receive 调 onReceive。
    //M 前台会话每一步调模型前：onRequest 把最近往来拼成一条 system 消息，加上查历史的提示。
    this.ctx.on('session/request', (request) => this.onRequest(request));

    //M 会话里每进一条消息：onMessage 看它是不是用户说的话，是的话记一条往来。
    this.ctx.on('session/message', (session, message) => {
      this.onMessage(session, message);
    });

    //M 会话状态变了：onChange 在一轮结束时记机器人这一句、清查历史次数、存排着的话、对排着要判断的那句问决策模型。
    this.ctx.on('session/change', (session) => {
      this.onChange(session);
    });

    //M 会话中途先说的一句（bot/say）：也记成机器人说的一条往来。
    this.ctx.on('bot/say', (session, text) => {
      //G channel_tool 会话的 bot/say 经 channel/reply 发，成功回执统一做前台归档。
      if (session.row.activeSourceSnapshot !== undefined) return;

      //M 旧会话的中途一句：直接记一条机器人往来。
      this.logBot(session, text);
    });

    //M 渠道回报发出去了（channel/replied）：onReplied 把发成功的那句话记成机器人往来，发失败的不记。
    this.ctx.on('channel/replied', (event) => {
      this.onReplied(event);
    });

    //M 渠道要发一条文字回复（channel/reply）：onReply 先把正文暂存，等 channel/replied 确认发出去了再记往来。
    this.ctx.on('channel/reply', (request) => {
      this.onReply(request);
    });
  }

  /** 暂存发送请求正文，等 channel/replied 确认后才归档实际回复。 */
  private readonly sentReplyTexts = new Map<string, { text: string }>();

  /**
   * 工具 history 的执行：取这个客户（本场前台和它交办的后台，跨渠道）往前 count 条往来，一行一条。
   * @param session 调工具的前台会话。
   * @param args 模型给的参数（count、before），已照 HISTORY_TOOL 校验过。
   * @returns 给模型看的文字；没有就说没有更早的往来。
   */
  private async getRecentHistory(session: Session, args: Record<string, unknown>): Promise<string> {
    const count = (args['count'] as number | undefined) ?? 20;

    //M 取这个客户往前 count 条往来。
    const ids = this.scopeIds(session);
    const before = args['before'] as number | undefined;
    const entries = await this.recent(session, count, before, ids);
    if (entries.length === 0) return '没有更早的往来。';

    //M 旧名仍返回原有的一行一条格式，每条用 formatEntry 排成一行。
    return entries.map((entry) => formatEntry(entry)).join('\n');
  }

  /**
   * 收 session/change：一轮结束时记机器人这一句、清查历史次数、存转的时候排着的话，再对排着要判断的那句问一次决策模型。
   * @param session 状态变了的会话。
   */
  private onChange(session: Session): void {
    //G 还在转 → 这一轮没结束，不记。
    if (session.row.state === 'running') return;

    //M channel_tool 轮只凭成功回执归档，session/change 的正文仅是草稿。
    const queue = session.row.resultQueue ?? [];
    const activeKey = session.row.activeKey;
    const activeChannelTool = session.row.activeSourceSnapshot !== undefined
      || queue.some((item) => item.key === activeKey && item.deliveryMode === 'channel_tool');

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
  }

  /**
   * 收 channel/replied：发成功（sent、partial）的才把 onReply 暂存的那句话记成这个客户的机器人往来。
   * @param event 渠道回执。
   */
  private onReplied(event: protocol.ChannelRepliedEvent): void {
    const receipt = event.receipt;
    if (receipt.status !== 'sent' && receipt.status !== 'partial') return;

    //M 用回执的请求号对上此前暂存的正文，实发后才记进往来。
    const sentTexts = this.sentReplyTexts.get(receipt.replyRequestKey);
    this.sentReplyTexts.delete(receipt.replyRequestKey);
    if (sentTexts === undefined) return;

    //M 通过不可变回复轮键查到这条回复所属的前台。
    const front = this.findSessionByRoundKey(event.replyRoundKey);
    if (front === undefined) return;

    //M 发送成功才为前台关联这条回复的索引正文。
    const row = front.row;
    this.log({
      bot: row.bot,
      channel: row.channel ?? '',
      who: 'bot',
      sessionId: row.id,
      text: sentTexts.text,
      time: Date.now(),
      sourceKey: receipt.replyRequestKey,
    });
  }

  /**
   * 收 channel/reply：文字回复先把正文暂存进 sentReplyTexts，等 onReplied 确认发出去了再记往来。
   * @param request 渠道回复请求。
   */
  private onReply(request: protocol.ChannelReplyRequest): void {
    if (request.mode !== 'text') return;

    const text = request.parts.map((part) => part.text ?? '').filter((one) => one !== '').join('\n');
    if (text === '') return;

    this.sentReplyTexts.set(request.replyRequestKey, { text });
  }

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
    //M 先列出这个机器人所有的前台对话，下面按来源域逐个比对。
    const fronts = this.ctx.sessions.find({ bot, kind: 'front' });
    const exact = fronts.find((row) => {
      const s = row.sourceScope;
      if (s === undefined) return false;

      return s.channel === scope.channel && s.accountId === scope.accountId && s.chatId === scope.chatId;
    });

    //M 来源域完全一致的前台已经有了：直接打开它，不新建。
    if (exact !== undefined) return this.ctx.sessions.open(exact.id);

    //M 未绑定其他账号的同客户旧前台：补写 sourceScope 沿用；不同 appId 的旧前台不混用。
    if (customer !== '') {
      const compatible = fronts.find((row) => {
        if (row.customer !== customer) return false;

        //G 旧前台有账号时必须与当前账号一致，沿用时不会串到别的飞书应用。
        const existingApp = textModule.getText(row.address, 'appId');
        return row.sourceScope === undefined && (existingApp === '' || existingApp === scope.accountId);
      });
      if (compatible !== undefined) {
        //M 旧前台属于同一客户和账号时只补齐来源，保留它的往来。
        const session = this.ctx.sessions.open(compatible.id);
        session.row.sourceScope = scope;
        session.save();
        return session;
      }
    }

    const input: {
      bot: string;
      kind: string;
      sourceScope: typeof scope;
      customer?: string;
    } = {
      bot,
      kind: 'front',
      sourceScope: scope,
    };
    if (customer !== '') {
      input.customer = customer;
    }

    //M 找不到可用的前台：新开一场前台会话，记下来源域（有客户号一起记）。
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
    //M 从地址里取说话人，拼成“说话人：话”（和只听记的一样）；再看地址里有没有 judge 标记，决定要不要问决策模型。
    const sender = getSpeaker(botOrigin.address);
    const line = `${sender}：${botText}`;
    const needJudge = textModule.getField(botOrigin.address, 'judge') === true;

    //M 不用判断的只听话：记进前台对话当背景，不调模型、不回。
    if (!needJudge) {
      this.listen(front, botText, botOrigin.address);
      return { reply: false, text: botText };
    }

    //M 前台这一轮还在转：话先记进对话，最后一句排着，等这一轮结束（session/change）再判断。
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

    //M 前台没在转：马上问决策模型要不要接话，结论写在地址上（飞书记进来往流水）。
    const judged = await this.judgeReply(front, botOrigin.address, line);
    this.markJudged(botOrigin.address, judged.outcome);

    //M 决策模型说不接：话只记进前台对话当背景，不回。
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
    //M 先在前台会话里找：当前活动轮或结果队列里有这个回复轮键的，打开它。
    for (const meta of this.ctx.sessions.find({ kind: 'front' })) {
      const matched = meta.activeSourceSnapshot?.replyRoundKey === roundKey
        || (meta.resultQueue ?? []).some((item) => item.replyControl?.roundKey === roundKey);
      if (matched) return this.ctx.sessions.open(meta.id);
    }

    //M 前台里没有，再在后台会话里找（后台中途先说的话也要记到客户的往来里）。
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

    //M 客户号只读渠道写在回话地址里的 address.customer；按机器人加客户号找前台对话，没有就开一场。
    const bot = event.bot.name;
    const address = event.message.address;
    const customer = textModule.getText(address, 'customer');
    const input: { bot: string; kind: string; customer?: string } = { bot, kind: 'front' };
    if (customer !== '') {
      input.customer = customer;
    }

    //M 旧入口按客户找已有前台，没有时用相同条件开一场。
    const found = this.ctx.sessions.find(input)[0];
    let session: Session | undefined;
    if (found !== undefined) {
      session = this.ctx.sessions.open(found.id);
    }
    if (session === undefined) {
      session = this.ctx.sessions.create(input);
    }

    //M 渠道标了只听（飞书登记了 listen: all 的群里没 @ 机器人的话）：记进这场前台对话当背景，不推它往下走、不回；这条就算处理掉了。
    if (textModule.getField(address, 'listenOnly') === true) {
      //M 要判断的群（listen: judge）：先问决策模型，allow 就当 @ 了机器人，照下面交给这场前台对话跑。
      if (textModule.getField(address, 'judge') === true && await this.judgeFirst(session, event)) {
        event.session = session;
        return;
      }

      //M 不接话（不用判断，或决策模型说不回）：话记进前台对话当背景，这条处理掉，不推会话往下走。
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
    //M 取说话人，拼成“说话人：话”：问决策模型、记进对话都用这个写法。
    const address = event.message.address;
    const sender = getSpeaker(address);
    const line = `${sender}：${event.message.text}`;

    //M 会话正在转：先排着，这一轮结束（session/change）再判断，这里只记下最后一句。
    if (session.row.state === 'running') {
      this.judgeLater.set(session.id, { channel: event.message.channel, address, text: event.message.text });
      return false;
    }

    //M 会话没在转：马上问决策模型要不要接话，结论写在地址上（飞书记进来往流水）；不接就交回 false，由 onReceive 记进对话。
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
  private async judgeReply(
    session: Session,
    address: unknown,
    last: string,
  ): Promise<{ reply: boolean; outcome: string }> {
    //G 决策模型是可选服务（不 inject）：没挂就不接话，不报错。
    const decision = this.ctx.get('decision') as decisionPlugin.Decision | undefined;
    if (decision === undefined) return { reply: false, outcome: 'judge:不回(没有决策模型)' };

    //M 最近 JUDGE_LINES 句：对话里的，加上还没记进去的最后一句。
    const lines = session.row.messages.map((message) => getLine(message, session.row.bot)).filter((one) => one !== '');
    const recent = [...lines, last].filter((one) => one !== '').slice(-JUDGE_LINES);
    const threshold = textModule.getField(address, 'judgeThreshold');
    const originalPrefix = '你是群里的助手。';
    const promptBody = JUDGE_QUESTION.instructions.slice(originalPrefix.length);
    const question = {
      ...JUDGE_QUESTION,
      instructions: `你是群里的助手 ${session.row.bot}。${promptBody}`,
    };
    const input: decisionPlugin.JudgeInput = {
      kind: 'group-listen',
      bot: session.row.bot,
      question,
      state: { 最后一句: recent.at(-1) ?? '', 最近群聊: recent },
    };
    if (typeof threshold === 'number') {
      input.allowAt = threshold;
    }

    //T 跟踪：问决策模型要不要接话。
    const vars = { 会话: session.id, 几句: recent.length };
    this.ctx.emit('trace', 'FrontDesk.judge', '群里没 @ 机器人的话，问决策模型要不要接话', 'decision.judge(question)', vars);

    //M 问决策模型：allow 才接话，deny、unsure 都不接；分数用来写进流水。
    const verdict = await decision.judge(input);
    if (verdict.verdict === 'allow') return { reply: true, outcome: 'judge:回' };
    let score = '';
    if (verdict.score !== undefined) {
      score = `(${verdict.score.toFixed(2)})`;
    }
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
    if (
      later.message !== undefined && later.botOrigin !== undefined
      && later.claimKey !== undefined && this.onChannelJudgeAllow !== undefined
    ) {
      this.onChannelJudgeAllow(session.row.bot, later.message, later.botOrigin, later.claimKey);
      return;
    }

    //M 旧路径（没有标准消息快照）：把回话地址换成排着那句的，再推前台会话往下跑，等这一轮跑完。
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
    //M 从回话地址取说话人的名字（没有名字用 open_id 后 6 位），拼成“说话人：话”存进对话。
    const openId = textModule.getText(address, 'openId');
    const sender = textModule.getText(address, 'senderName') || openId.slice(-6) || '有人';
    const message: piAi.Message = { role: 'user', content: `${sender}：${text}`, timestamp: Date.now() };

    if (session.row.state === 'running') {
      //M 会话还在转，先暂存这句只听的话，等这一轮结束再写入。
      const heard = this.heard.get(session.id) ?? [];
      this.heard.set(session.id, [...heard, message]);
      return;
    }

    //M 会话没在转：马上存进对话，并记往来。
    this.record(session, [message]);
  }

  /**
   * 只听的话存进对话（不走 session.add：那是要它往下走的话，下一步就会调模型），再各记一条往来。
   * @param session 前台对话。
   * @param messages 要存的用户话。
   * 副作用：改对话并存库；写往来记录。
   */
  private record(session: Session, messages: piAi.Message[]): void {
    //M 直接放进对话的消息列表（不走 session.add，免得推它调模型），存库。
    session.row.messages.push(...messages);
    session.save();

    //M 每句照普通用户消息发出通知，由 onMessage 交给记忆插件归档。
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
  private async onRequest(request: ChatRequest): Promise<void> {
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

    //M 零次回复修复只加系统提示，只有记录中尚无回复工具调用时才提示。
    const control = active?.replyControl;
    if (control !== undefined && control.reminder === 'running' && control.calledIds.length === 0) {
      request.system.push('你还没调用回复工具');
    }

    //G 原始往来没有归属字段，只在本人会话里加载；其他会话用已标的召回。
    const access = memoryKeyModule.getMemoryAccess(row);
    let entries: BotLogEntry[] = [];
    if (access.full) {
      const ids = this.scopeIds(request.session);
      const time = thisRound[0]?.timestamp;
      entries = await this.recent(request.session, this.config.recent, time, ids);
    }
    //M 前台有两个统一工具时才提醒用它们查归档。
    const hasMemory = request.tools.some((tool) => tool.name === 'memory_search');
    if (hasMemory && access.full) {
      request.system.push(HISTORY_HINT);
    }

    //T 跟踪：拼最近往来。
    const vars = { 会话: row.id, 带了几条往来: entries.length, 这一轮几条: thisRound.length };
    this.ctx.emit('trace', 'FrontDesk.onRequest', '给前台对话拼上最近往来', 'request.messages = …', vars);
    request.messages = thisRound;

    //M 没有更早的往来：不拼背景，只看这一轮有没有图片要提醒，然后就这样发给模型。
    if (entries.length === 0) {
      this.imageHint(request);
      return;
    }

    //M 拼成一条背景消息放在最前面，角色是 system：它是动态的上下文，不放进系统提示词。
    const lines = [
      '下面是你最近和用户的往来，按时间从早到晚，只是背景，不是用户这次说的话。',
      ...entries.map((entry) => formatEntry(entry)),
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

    //G 这一轮用户没发图片 → 不提醒。
    if (this.roundImages(request.session).length === 0) return;

    //M 前台模型能看图就告诉它图已经发给它了，看不了就提醒它把图转给后台（后台用看图模型）。
    let hint = '用户这一轮发了图片，你这个前台模型看不到图片。'
      + '请直接调 hand_session，把用户的原话连同图片路径（@路径）原样交给后台，后台会用看图模型来看；不要回答说自己看不了。';
    if (this.sees(request.model)) {
      hint = '用户这一轮发了图片，图片已经直接发给你了，你能看到。'
        + '只是看图、描述图、回答图里的问题，就自己直接回答，不要转后台、不要写脚本。';
    }
    request.messages = [...request.messages, { role: 'system', content: hint, timestamp: Date.now() }];
  }

  /**
   * 前台对话这一轮用户的话里 @ 的图片路径。Dispatch.ts 的 hand_session 也用。
   * @param session 前台对话。
   */
  roundImages(session: Session): string[] {
    //M 这一轮从上一次不调工具的回答之后算起；把这之后用户话里 @ 的图片路径逐条取出来（getImagePaths 认路径写法）。
    const messages = session.row.messages;
    const lastDone = messages.findLastIndex((item) => {
      if (item.role !== 'assistant') return false;

      return !item.content.some((block) => block.type === 'toolCall');
    });
    const round = messages.slice(lastDone + 1);
    return round.flatMap((item) => {
      if (item.role !== 'user') return [];

      //M 只从这轮用户发来的文本中找图片路径。
      const text = piAi.contentText(item.content);
      return imageModule.getImagePaths(text);
    });
  }

  /**
   * 这个模型收不收图片（config.yaml 里写了 vision: true）。Dispatch.ts 的 hand_session 也用。
   * @param model 供应商名/模型 ID。
   */
  sees(model: string): boolean {
    //M 按“供应商名/模型 ID”查配置里这个模型声明的输入类型，有 image 就是能看图。
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
          //M 保存这次调用，队列收尾用它判断是否需要补跑回复。
          replyControl.calledIds.push({ id: call.id, name: call.name, kind: replyKind });
          if (replyControl.reminder === 'running') {
            replyControl.outcome = 'attempted';
          }
          changed = true;
        }
        if (changed) {
          //M 记了新的回复工具调用：存库，免得重启后又当成这一轮一次都没调。
          session.save();
        }
      }
    }

    //G 只记前台对话和干活的会话里用户说的；小会话（压缩、总结）里的不记。
    //G   干活的会话里的也记，这样前台的“最近往来”看得到交办出去的事。
    if (message.role !== 'user' || (row.kind !== 'front' && row.kind !== 'work')) return;

    if (row.kind === 'front') this.historyCalls.delete(row.id);

    //M 当前活动轮首条用户话能对上不可变来源时，给归档带上标准消息号。
    const active = (row.resultQueue ?? []).find((item) => item.key === row.activeKey);
    let sourceKey: string | undefined;
    if (
      active?.kind === 'user' && active.alreadyRecorded !== true
      && active.replyControl?.startMessageIndex === row.messages.length - 1
    ) {
      sourceKey = active.payload.sourceSnapshot?.messageId;
    }
    const content = piAi.contentText(message.content);
    const entry: FrontMessage = {
      bot: row.bot,
      channel: row.channel ?? '',
      who: 'user',
      sessionId: row.id,
      text: content,
      time: message.timestamp,
      sourceKey,
    };
    //M 归档由记忆插件持有，已有渠道行时复用正文。
    this.log(entry);
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

    //M 这是一条没有标准渠道回执的旧式会话回复，照会话归档。
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
    //G 同一轮共用次数上限，先读已用次数再决定能否查询。
    const used = this.historyCalls.get(session.row.id) ?? 0;
    if (used >= HISTORY_MAX_CALLS) {
      return `本轮 history_search / history_get 已调用 ${String(HISTORY_MAX_CALLS)} 次，不能再查。`
        + '若需要通读或总结大量历史，请用 hand_session 交给后台会话。';
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
    const access = memoryKeyModule.getMemoryAccess(session.row);
    if (!access.full) return [...ids];
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
    //G 每轮 history_search、history_get 一共最多 3 次：满了直接把拒绝的提示回给模型，不查。
    const denied = this.touchHistory(session);
    if (denied !== undefined) return denied;

    //M 只查这场前台和它交办的后台会话（同一个客户），范围外的往来看不到。
    const ids = this.scopeIds(session);
    if (ids.length === 0) return '没有往来。';

    const requestedCount = (args['count'] as number | undefined) ?? HISTORY_PAGE;
    const take = Math.min(HISTORY_PAGE, Math.max(1, requestedCount));
    const rawKeyword = args['keyword'];
    let keyword: string | undefined;
    if (typeof rawKeyword === 'string') {
      keyword = rawKeyword.trim() || undefined;
    }

    //M 只把工具传来的有效筛选项交给两路检索共用。
    const range: HistoryRange = {};
    const who = args['who'];
    if (who === 'user' || who === 'bot') {
      range.who = who;
    }
    const numericKeys = ['from', 'to', 'after', 'before'] as const;
    for (const key of numericKeys) {
      const value = args[key];
      if (typeof value === 'number') {
        range[key] = value;
      }
    }
    const fromEarliest = args['from_earliest'] === true || range.after !== undefined;
    //M 同一份筛选条件约束关键词和语义两路，确保它们都只看当前会话范围。
    const filter = { bot: session.row.bot, sessionIds: ids, ...range };

    //M 有关键词才查语义。语义命中时再取更多关键词候选，合并后按相关程度排序。
    let semantic: Array<{ entry: BotLogEntry; score: number }> = [];
    if (keyword !== undefined) {
      semantic = await this.semanticHits(session, filter, keyword);
    }
    const ranked = semantic.length > 0;
    let candidateCount = take;
    if (ranked) {
      candidateCount = 2000;
    }

    //M 保留按字匹配和语义匹配的去重总数，用于提示翻页。
    let order: FrontQuery['order'] = 'last';
    if (fromEarliest) {
      order = 'first';
    }
    const query = { ...filter, keyword, order, limit: candidateCount };
    const keywordRows = await this.readFront(session, query);
    if (!fromEarliest) {
      keywordRows.reverse();
    }
    const semanticRows = semantic.map((hit) => hit.entry);
    const union = uniqueById(keywordRows, semanticRows);
    let shown = keywordRows;
    let orderNote = '按时间从早到晚';
    if (ranked) {
      shown = mergeHistoryHits(keywordRows, semantic, take);
      orderNote = '按相关程度';
    }
    if (shown.length === 0) return '没有符合条件的往来。';

    //M 开头一句说总数和这页范围、还有更多怎么翻；每条往来用 formatEntry 截短排成一行，回给模型。
    const total = union.length;
    const first = String(shown[0]?.id);
    const last = String(shown.at(-1)?.id);
    let head = `共 ${String(total)} 条，这页 ${String(shown.length)} 条（编号 ${first}–${last}，${orderNote}）。`;
    if (total > shown.length) {
      head += '还有更多时，用 after 往后翻或 before 往前翻。';
    }
    const useMemoryRef = args['use_memory_ref'] === true;
    //M 每条只放截短的正文和编号，模型需要全文时可用历史工具。
    const lines = shown.map((entry) => formatEntry(entry, HISTORY_CLIP, useMemoryRef));
    return [head, ...lines].join('\n');
  }

  /** 记忆的本地索引负责按同一权限、分页条件取前台归档。 */
  private async readFront(session: Session, query: FrontQuery): Promise<BotLogEntry[]> {
    //G 兼容工具也要校验本轮身份，不能仅凭编号读取前台专用记录。
    const access = memoryKeyModule.getMemoryAccess(session.row);
    if (!access.full) return [];

    const request = { action: 'front-history' as const, query };
    //M 请求同一记忆服务，没挂插件时没有归档，模型仍可以继续当前会话。
    const result = await this.askMemory(request, 1500);
    return result.frontEntries ?? [];
  }

  /** 语义检索只比较同一会话范围的候选，向量由记忆服务按需计算。 */
  private async semanticHits(
    session: Session,
    filter: Omit<FrontQuery, 'order' | 'limit'>,
    keyword: string,
  ): Promise<Array<{ entry: BotLogEntry; score: number }>> {
    const query: FrontQuery = { ...filter, order: 'last', limit: 2000 };
    //G 先按会话权限取候选，没有可查的往来就不向记忆模型请求向量。
    const candidates = await this.readFront(session, query);
    if (candidates.length === 0) return [];

    //M 记忆服务离线时仍保留字面检索。
    const queryVec = await this.embedTexts([keyword]);
    const vector = queryVec?.[0];
    if (vector === undefined) return [];

    const hits: Array<{ entry: BotLogEntry; score: number }> = [];
    for (let offset = 0; offset < candidates.length; offset += 32) {
      //M 按与原前台同样的批量大小编码，不再另建 SQLite 向量缓存。
      const batch = candidates.slice(offset, offset + 32);
      const texts = batch.map((entry) => entry.text);
      const vectors = await this.embedTexts(texts);
      if (vectors === undefined) break;

      for (const [index, entry] of batch.entries()) {
        const value = vectors[index];
        if (value === undefined) continue;

        //M 和查询向量同维且超过原门槛的才参与前台结果排序。
        const score = cosine(vector, value);
        if (score >= SEMANTIC_MIN) {
          hits.push({ entry, score });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
    return hits.slice(0, HISTORY_PAGE);
  }


  /**
   * 请 memory 算向量（它调记忆服务 POST /embed）。没挂 memory、404、模型没就绪或网络失败交回 undefined。
   * @param texts 要嵌入的文字。
   */
  private async embedTexts(texts: string[]): Promise<number[][] | undefined> {
    //M 发 memory/request（embed）请 memory 算向量；没挂 memory、超时、出错时回执里没有 vectors，交回 undefined。
    const embedded = await this.askMemory({ action: 'embed', texts }, 30_000);
    return embedded.vectors;
  }

  /**
   * 发请求事件 memory/request 请 memory 插件办一件事（契约 3.2 第 6 条），等 memory/result。
   * @param payload 查询前台归档（front-history）或按需计算向量（embed）。
   * @param timeoutMs 最多等多久：记往来 20 秒、搜 10 秒、算向量 30 秒。
   * @returns memory 的回执；没挂 memory、超时、出错都是 ok: false（不带 hits、vectors），不抛。
   */
  private askMemory(
    payload: requestEventModule.StripEnvelope<requestEventModule.EventArg<'memory/request'>>,
    timeoutMs: number,
  ): Promise<requestEventModule.EventArg<'memory/result'>> {
    const options = {
      prefix: 'mem',
      timeoutMs,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => {
        const error = detail ?? reason;
        return { requestId: '', ok: false, error };
      },
    };

    //M 发 memory/request 事件、等配对的 memory/result；等不到（没挂 memory、超时）由 onFallback 转成 ok: false 的回执。
    return requestEventModule.requestEvent(this.ctx, 'memory/request', 'memory/result', payload, options);
  }

  /**
   * history_get：取一条全文，只给这场对话范围内的。
   * @param session 前台对话。
   * @param id 往来编号。
   */
  private async getHistory(session: Session, id: number): Promise<string> {
    //G 每轮 history_search、history_get 一共最多 3 次：满了直接把拒绝的提示回给模型，不查。
    const denied = this.touchHistory(session);
    if (denied !== undefined) return denied;

    //G 同时按机器人、会话范围和编号查，越界时没有结果。
    const sessionIds = this.scopeIds(session);
    const query: FrontQuery = { bot: session.row.bot, sessionIds, id, order: 'last', limit: 1 };
    const entries = await this.readFront(session, query);
    const row = entries[0];
    if (row === undefined) return `没有编号 ${String(id)} 的往来，或不属于这场对话。`;

    //M 范围内的才排成一行（不截短）回给模型。
    return formatEntry(row);
  }

  /** 读取本轮前的近期归档，再按时间从早到晚交给模型。 */
  private async recent(
    session: Session,
    count: number,
    before: number | undefined,
    sessionIds: string[],
  ): Promise<BotLogEntry[]> {
    const query: FrontQuery = {
      bot: session.row.bot,
      sessionIds,
      order: 'time',
      limit: count,
      beforeTime: before ?? Date.now() + 1,
    };
    //M 按会话范围取最近一页，拼入模型上下文时恢复时间正序。
    const entries = await this.readFront(session, query);
    return entries.reverse();
  }


  /**
   * 记一条往来。
   * @param entry 谁说的、哪个渠道、哪场会话、说了什么。
   * 副作用：写库。
   */
  private log(entry: FrontMessage): void {
    //M 与渠道索引共用正文，前台仍按会话保存自己的往来关系。
    this.ctx.emit('memory/front-message', entry);
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
  //M 先用地址里的 senderName，没有就用 open_id 后 6 位，再没有就叫“有人”。
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

  //M 消息内容可能是字符串或分段数组：分段的逐段用 getText 取出 text 拼起来。
  const content: unknown = message.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  }
  if (Array.isArray(content)) {
    const pieces = content.map((part: unknown) => textModule.getText(part, 'text'));
    text = pieces.join('');
  }
  const line = text.trim();
  if (line === '') return '';

  if (message.role === 'assistant') return `${bot}：${line}`;

  return line;
}


/**
 * 把一条往来写成一行：[时间 渠道 谁] 话。
 * @param entry 往来。
 * @param clip 正文最多留几个字，不给就保留全文。
 * @param useMemoryRef 新工具回执用 memory_get 说明全文入口。
 */
function formatEntry(entry: BotLogEntry, clip?: number, useMemoryRef = false): string {
  const when = new Date(entry.time).toLocaleString('zh-CN', { hour12: false });
  let who = '机器人';
  if (entry.who === 'user') {
    who = '用户';
  }
  let body = entry.text;
  let suffix = '';
  if (clip !== undefined && body.length > clip) {
    body = body.slice(0, clip);
    suffix = '…（全文用 history_get 取）';
    if (useMemoryRef) suffix = '…（把 #编号交给 memory_get 取全文）';
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
function mergeHistoryHits(
  keywordRows: BotLogEntry[],
  semantic: Array<{ entry: BotLogEntry; score: number }>,
  take: number,
): BotLogEntry[] {
  const scores = new Map<number, { entry: BotLogEntry; score: number }>();
  for (const entry of keywordRows) {
    scores.set(entry.id, { entry, score: 1 });
  }
  for (const hit of semantic) {
    const prev = scores.get(hit.entry.id);
    if (prev === undefined) {
      scores.set(hit.entry.id, hit);
      continue;
    }

    //M 同一条同时命中关键词和语义时提高它的分数。
    const score = hit.score + 1;
    if (score > prev.score) {
      scores.set(hit.entry.id, { entry: prev.entry, score });
    }
  }

  //M 先按分数，再按编号稳定排序，只交回当前页的原文记录。
  const ranked = [...scores.values()];
  ranked.sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
  const shown = ranked.slice(0, take);
  return shown.map((row) => row.entry);
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
      //M 两路命中同一个编号时，只把第一次出现的那条留下。
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
  if (denom === 0) return 0;

  return dot / denom;
}
