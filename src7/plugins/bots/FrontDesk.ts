/**
 * 机器人的前台：每个机器人对每个客户一场固定的“前台对话”（会话种类 front），渠道来的消息没被别的插件认领的，都先到它这儿。
 * 简单的话它自己答；不是一句话能答的，它调 hand_session 工具，转给一场后台会话去干，后台干完结果先交回前台，前台整理后回原渠道。
 * 派活的三个工具和结果队列在 Dispatch.ts（服务 ctx.frontDesk）。这个文件做四件事：
 *   - 定“这条消息进哪场会话”（onReceive：Bot.receive 问完 bot/receive 没人认领时，经 Dispatch.receive 调它）：
 *     按客户号（渠道:用户）进这个机器人的前台对话，没有就开一场；
 *     只听的话（channel/listen 来的，bots 在地址副本上标 listenOnly：飞书群里没 @ 机器人的话）只记进前台对话当背景，不调模型、不回；
 *     飞书 listen: judge 的群要不要接话不在这里判断：DispatchClaim 交给群攒批（GroupBatch.ts）攒一批再问决策模型；
 *   - 往来记录：用户每说一句、机器人每回一句（含会话中途先说的 bot/say）各记一条；查历史只查本客户这场和它交办的后台；
 *   - 前台对话每一步的上下文 = 最近 N 条往来（一条 system 消息，动态拼上去，不进系统提示词）+ 这一轮的消息；
 * 前台自己答一般技术解释、资料查询和简单问题，答不够交办后台，绝对不自己干重活。
 * 用户发了图片而前台模型不收图片：提醒前台把图转给后台；hand_session 这时新开的后台会话用看图模型（vision_model）。
 * 2026-11-17 由插件 bot-front-desk 并进 bots（用户 #114、#115）：只挪了位置，逻辑没改。
 * 记忆库由 memory 读写，前台通过 memory/request 取近期往来供模型参考。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as namesModule from '../../utils/Names.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as utils from '../../utils/index.ts';
import * as frontArchive from '../memory/FrontArchive.ts';
import type { FrontEntry as BotLogEntry, FrontMessage, FrontQuery } from '../memory/FrontArchive.ts';
import * as memoryKeyModule from '../memory/MemoryKey.ts';
import type { ReceiveEvent } from './index.ts';
import * as protocol from '../channels/index.ts';


/** 归档读取失败时给模型的提示，和查询成功但没有匹配项区分。 */
const HISTORY_UNAVAILABLE = '前台往来暂时读不到（记忆插件未返回记录），请以本轮消息为准。';

/** 提醒前台如何翻这场往来和取全文。 */
const HISTORY_HINT = '用 memory_search 的 front=true 翻看本场及已交办会话的往来，可按 who、时间或编号筛选。'
  + '带 #编号的往来可把该编号作为 ref 交给 memory_get 取全文。'
  + '需要通读或总结大量历史时用 hand_session 交给后台会话。';

/** 前台的配置：config.yaml 的 plugins 段里 bots 的 config.front，bots 的 apply 校验过。 */
export interface FrontDeskConfig {
  /** 前台对话每一步带上最近多少条往来。不写是 50。 */
  recent: number;
  /** 有图片要转后台时，新开的后台会话用哪个模型；不写就挑 config.yaml 里第一个写了 vision: true 的。 */
  vision_model?: string | undefined;
}


/** 机器人的前台。 */
export class FrontDesk {
  /** 正在转的会话暂存只听不回的 Message，role 为 user，content 存正文，timestamp 记时间。本轮结束后入对话。 */
  private readonly heard = new Map<string, piAi.Message[]>();
  /**
   * 监听 session/before-model、session/new-message、session/change、bot/say、channel/replied。
   * @param ctx Cordis 给的 ctx。
   * @param config 带多少条往来。
   */
  constructor(private readonly ctx: cordis.Context, private readonly config: FrontDeskConfig) {
    //M list_sessions、hand_session、stop_session 在 Dispatch.ts（前台派后台和结果队列），bots 的 apply 里接着挂。

    //M 收消息不听 bot/receive：Bot.receive 问完 bot/receive 没人认领，才经 Dispatch.receive 调 onReceive。
    //M 前台会话每一步调模型前：onRequest 把最近往来拼成一条 system 消息，加上查历史的提示。
    this.ctx.on('session/before-model', (request) => this.onRequest(request));

    //M 会话里每进一条消息：onMessage 看它是不是用户说的话，是的话记一条往来。
    this.ctx.on('session/new-message', (session, message) => {
      this.onMessage(session, message);
    });

    //M 会话状态变了：onChange 在一轮结束时记机器人这一句、存排着的只听的话。
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

    //M 渠道回报发出去了（channel/replied，带着请求正文）：onReplied 把发成功的那句话记成机器人往来，发失败的不记。
    this.ctx.on('channel/replied', (event) => {
      this.onReplied(event);
    });
  }

  /**
   * 收 session/change：一轮结束时记机器人这一句、存转的时候排着的只听的话。
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

    //M 转的时候排着的只听的话，这一轮结束了存进对话。
    const waiting = this.heard.get(session.id);
    if (waiting !== undefined) {
      this.heard.delete(session.id);
      this.record(session, waiting);
    }
  }

  /**
   * 收 channel/replied：发成功（sent、partial）的文字回复，才把回执带的请求正文记成这个客户的机器人往来。
   * @param event 渠道回执（带请求本身）。
   */
  private onReplied(event: protocol.ChannelRepliedEvent): void {
    const receipt = event.receipt;
    if (receipt.status !== 'sent' && receipt.status !== 'partial') return;

    //M 正文从回执带的请求里取：只记文字回复，没有文字的不记。
    const request = event.request;
    if (request.mode !== 'text') return;

    const text = request.parts.map((part) => part.text ?? '').filter((one) => one !== '').join('\n');
    if (text === '') return;

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
      text,
      time: Date.now(),
      sourceKey: receipt.replyRequestKey,
    });
  }

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
        const existingApp = utils.getStringField(row.address, 'appId');
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
    const customer = utils.getStringField(address, 'customer');
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

    //M 标了只听（channel/listen 来的，飞书群里没 @ 机器人的话）：记进这场前台对话当背景，不推它往下走、不回；这条就算处理掉了。
    //M   要不要接话不在这条旧路上判断：群攒批只接渠道事件那条路（DispatchClaim.ts → GroupBatch.ts）。
    if (utils.getField(address, 'listenOnly') === true) {
      this.listen(session, event.message.text, address);
      event.handled = true;
      return;
    }
    event.session = session;
  }

  /**
   * 只听的一句记进前台对话：前面带说话人（飞书查到的名字，没查到用 open_id 后 6 位），当成一句用户话存进对话，不调模型。
   * 记下的往来进记忆的前台归档，前台下一轮“最近往来”的背景里看得到（本人的前台）。
   * 会话正在转就先排在 heard 里，这一轮结束（session/change）再记：免得插进工具调用和结果中间，也免得又引出一轮回答。
   * DispatchClaim（只听的话、没开群攒批）、GroupBatch（一批判完不接、今天看满了）、onReceive（旧路）调。
   * @param session 这个群的前台对话。
   * @param text 说的话。
   * @param address 回话地址：读 senderName、openId。
   * 副作用：改对话并存库、记一条往来；或者排进 heard。
   */
  listen(session: Session, text: string, address: unknown): void {
    //M 从回话地址取说话人的名字（没有名字用 open_id 后 6 位），拼成“说话人：话”存进对话。
    const sender = getSpeaker(address);
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
   * 只听的话存进对话（不走 session.queueUserMessage：那是要它往下走的话，下一步就会调模型），再各记一条往来。
   * @param session 前台对话。
   * @param messages 要存的用户话。
   * 副作用：改对话并存库；写往来记录。
   */
  private record(session: Session, messages: piAi.Message[]): void {
    //M 直接放进对话的消息列表（不走 session.queueUserMessage，免得推它调模型），存库。
    session.row.messages.push(...messages);
    session.save();

    //M 每句照普通用户消息发出通知，由 onMessage 交给记忆插件归档。
    for (const message of messages) {
      this.onMessage(session, message);
    }

    //T 跟踪：只听的话记进前台对话。
    const vars = { session: session.id, messageCount: messages.length };
    this.ctx.emit('trace', 'FrontDesk.record', 'trace.bots.recordGroupContext', 'session.row.messages.push(...)', vars);
  }

  /**
   * 响应 session/before-model：给前台对话拼上下文。
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
    let entries: BotLogEntry[] | undefined = [];
    if (access.full) {
      const ids = this.scopeIds(request.session);
      const time = thisRound[0]?.timestamp;
      entries = await this.recent(request.session, this.config.recent, time, ids);
    }
    //M 归档请求没成功时明说原因，本轮消息仍交给模型处理。
    if (entries === undefined) {
      request.system.push(HISTORY_UNAVAILABLE);
    }
    //M 前台有两个统一工具时才提醒用它们查归档。
    const hasMemory = request.tools.some((tool) => tool.name === 'memory_search');
    if (hasMemory && access.full) {
      request.system.push(HISTORY_HINT);
    }

    //T 跟踪：拼最近往来。
    const vars = { session: row.id, contextMessages: entries?.length ?? 0, turnMessages: thisRound.length };
    this.ctx.emit('trace', 'FrontDesk.onRequest', 'trace.bots.addRecentContext', 'request.messages = …', vars);
    request.messages = thisRound;

    //M 没有更早的往来：不拼背景，只看这一轮有没有图片要提醒，然后就这样发给模型。
    if (entries === undefined || entries.length === 0) {
      this.imageHint(request);
      return;
    }

    //M 拼成一条背景消息放在最前面，角色是 system：它是动态的上下文，不放进系统提示词。
    const lines = [
      '下面是你最近和用户的往来，按时间从早到晚，只是背景，不是用户这次说的话。',
      ...entries.map((entry) => frontArchive.formatFrontEntry(entry)),
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
   * 响应 session/new-message：用户说的话记一条往来。
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
        //M ToolCall 是模型要求执行的工具，id 对应结果，name 指工具，arguments 带参数。
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
   * 当前前台对话能查的往来：这场前台自己的，再加上它交办出去的后台会话的。
   * 前台按客户分会话之后，自然只查本客户。Dispatch.ts 的 list_sessions 也用。
   * @param session 前台对话。
   */
  scopeIds(session: Session): string[] {
    return frontArchive.getFrontSessionIds(this.ctx.sessions, session);
  }

  /** 记忆索引按权限和分页条件取前台归档，读失败返回 undefined。 */
  private async readFront(session: Session, query: FrontQuery): Promise<BotLogEntry[] | undefined> {
    //G 兼容工具也要校验本轮身份，不能仅凭编号读取前台专用记录。
    const access = memoryKeyModule.getMemoryAccess(session.row);
    if (!access.full) return [];

    const request = { action: 'front-history' as const, query };
    //M 向记忆插件查询，保留查询失败和成功但无记录的区别。
    const result = await this.askMemory(request, 1500);
    if (!result.ok) return undefined;

    return result.frontEntries ?? [];
  }

  /**
   * 发请求事件 memory/request 请 memory 插件办一件事（契约 3.2 第 6 条），等 memory/result。
   * @param payload 要查询的前台归档条件。
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

  /** 读取本轮前的近期归档，再按时间从早到晚交给模型。 */
  private async recent(
    session: Session,
    count: number,
    before: number | undefined,
    sessionIds: string[],
  ): Promise<BotLogEntry[] | undefined> {
    const query: FrontQuery = {
      bot: session.row.bot,
      sessionIds,
      order: 'time',
      limit: count,
      beforeTime: before ?? Date.now() + 1,
    };
    //M 按会话范围取最近一页，拼入模型上下文时恢复时间正序。
    const entries = await this.readFront(session, query);
    return entries?.reverse();
  }


  /**
   * 记一条往来。
   * @param entry 谁说的、哪个渠道、哪场会话、说了什么。
   * 副作用：通知 memory 保存往来。
   */
  private log(entry: FrontMessage): void {
    //M 与渠道索引共用正文，前台仍按会话保存自己的往来关系。
    this.ctx.emit('memory/front-message', entry);
  }
}


/**
 * 只听的话的说话人：飞书查到的名字，没查到用 open_id 后 6 位。FrontDesk.listen、GroupBatch 拼“说话人：话”用。
 * @param address 回话地址。
 * @returns 说话人。
 */
export function getSpeaker(address: unknown): string {
  //M 先用地址里的 senderName，没有就用 open_id 后 6 位，再没有就叫“有人”。
  return utils.getStringField(address, 'senderName') || utils.getStringField(address, 'openId').slice(-6) || '有人';
}


