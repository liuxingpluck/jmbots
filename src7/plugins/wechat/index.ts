/**
 * 微信渠道：读本机微信消息、起草回复、后台发送，带客服页。
 * 渠道收发在本文件，读消息在 read/，后台发送在 send/，客服页和接口在 page/。
 *
 * 收：每隔 interval_ms 读一次最近会话列表（chat_limit，默认 5000 个），最后消息时间变了的会话（一轮最多 SYNC_BATCH 个）跑只读引擎 sync-batch，
 *     新消息全部存表，页面上都能看。第一次同步拉的是存量，只存不交。勾了“监听”的会话会再把更早的消息全部补进库（不交机器人）。
 *     客户号是 wechat:<会话 username>，每个客户一场前台会话（memory 按客户号检索）。
 * 起草：只有勾了“监听”的会话（wechat_watch 里有）才交给机器人：对方私聊说的、群里 @我 的；没勾的会话只存不交，不调模型。公众号、系统会话不交。
 *     客服页可对当前已监听会话立即起草建议，在右栏复制草稿。
 * 发：只听不发。send 开关（config 里 wechat-kefu.send）默认 false：机器人的回复一律进发件表当草稿（state=draft），不问 approval，
 *     deliver 调用也只落成草稿。send: true 时才发：会话开了“自动发”就发，没开就登记待确认、没挂 approval 就留草稿；
 *     只发到监听名单里的会话，发送失败不重发。
 * 上下文：最近 50 条拼进 system，更早的消息交给 memory_get 按当前微信会话翻页。
 * 事件：不加新事件。跟踪点照 utils/Trace.ts（ctx.emit('trace', …)）；
 * 听 approval/decided、web-api/status、channel/reply（registerTextReply）。
 * 回话：前台一轮里 channel_reply 几次进几条发件，一次没调就把最后的话进发件（routing.autoFinal）。
 * Cordis 大白话：apply 是插件的 main()，ctx 是它拿到的遥控器；ctx.on 听的事件、ctx.effect 登记的收尾，插件拔掉时自动撤。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import type { Approval, Pending } from '../approval/index.ts';
import * as protocol from '../channels/index.ts';
import * as page from './page/Routes.ts';
import { Reader } from './read/Reader.ts';
import type { ChatItem, RawMessage } from './read/Reader.ts';
import * as voiceModule from './read/Voice.ts';
import * as storeModule from './read/Store.ts';
export { describe } from './read/Store.ts';
import { Sender } from './send/Sender.ts';
import { Window } from './send/Window.ts';
import * as checksModule from '../../utils/Checks.ts';


/** 插件名。 */
export const name = 'wechat-kefu';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.3：改成 channel_tool：一轮里 channel_reply 几次进几条发件（模型的话照旧要点头才发），零次回复把最后的话进发件；
//M   不再在 bot/receive 里按客户认领前台（bots 按来源范围找，同客户的旧前台沿用）。
//M 1.1.4：registerTextReply 接入 getTargetAddress 从微信自有会话表认聊天，承接跨渠道 channel/reply，不加微信新功能。
//M 1.1.6：getRoundId 从骨架 Channels.ts 挪进本文件，只有微信用。
//M 1.2.4：跨聊天发话认目标时，拆目标串（去“微信·”、拆“账号:聊天”）改用骨架的 parseChatTarget；查表规则不变。
//M 1.2.11：旧路自动回话也经 channel/reply 来（target 带会话记的地址、带会话号），删渠道自己的 send；带会话号的只发做完的一轮。
//M 1.2.12：channel/message 拆了，交给机器人的经 emitInbound 发：私聊 channel/direct、群里 @我 channel/mention。
//M 1.2.13：标准消息的 role 直接写 guest（微信一律外人，删 resolveLegacyRole）；SessionRow.customer 不再在这里声明（bots 一处）。
//M 1.2.14：客服页 GET /api/wechat-kefu/messages 支持轻量 version 快速路径（空闲轮免每 3 秒查传千条正文），Store.save 同步支持撤回原地刷新。
export const version = '1.2.14';

/** 用到的服务。approval 有就用，在 apply 里 ctx.inject。 */
export const inject = ['resources', 'bots', 'sessions', 'http'];

/** 一轮最多同步几个会话（第一次全量时 500 个会话分几轮做完，免得一个引擎进程跑太久）。 */
const SYNC_BATCH = 60;
/** 会话页的轮询间隔也是可复用后台读取结果的最长时间。 */
const PAGE_CHATS_MAX_AGE_MS = 8_000;
/** 拼进上下文的最近几条（用户 11-14：最少 50 条进上下文，更早的模型自己用工具读）。 */
const CONTEXT_MESSAGES = 50;
/** 微信自带的系统会话和公众号：只存不交给机器人。 */
const SKIP_REPLY = new RegExp(
  '^(gh_|filehelper$|weixin$|notifymessage$|fmessage$|floatbottle$|medianote$|newsapp$|qqmail$'
  + '|brandsessionholder$|brandservicesessionholder$|qmessage$|tmessage$|qqsync$|@)',
  'u',
);


/**
 * 从回复轮键取出轮名（getReplyRoundKey 的第三项）：receive 用户这一轮、approval 审批直回、judge_followup 判断后接话。
 * 微信用它分开“模型的回话”（要本人点头才发）和“审批直回”（不再套娃问）。
 * @param replyRoundKey 回复轮键。
 * @returns 轮名；不是这种写法的键是 ''。
 */
export function getRoundId(replyRoundKey: string): string {
  try {
    const parts = JSON.parse(replyRoundKey) as unknown;
    if (!Array.isArray(parts)) return '';

    const roundId: unknown = parts[2];
    if (typeof roundId !== 'string') return '';

    return roundId;
  } catch {
    return '';
  }
}


/** 微信的回话地址，记在会话的 row.address 上。customer 给 memory 认客户。 */
export interface WechatAddress {
  account: string;
  chat: string;
  name: string;
  customer: string;
  /**
   * 固定 false：微信里会交给机器人的话都是联系人、客户说的，不是用户本人（自己发的消息收进来时就跳过了）。
   * 写明它，工具关口（approval）、记忆、历史三处才一致按外人算，不把微信当本机渠道不限工具。
   */
  owner: false;
}


/**
 * 造微信的回话地址。收消息、按聊天找地址、客服页起草三处共用。
 * @param account 本机微信账号。
 * @param chat 聊天号。
 * @param name 聊天显示名。
 * @returns 带 owner: false 的地址，customer 是 wechat:<chat>。
 */
function getWechatAddress(account: string, chat: string, name: string): WechatAddress {
  //M owner: false 让工具关口（approval）、记忆、历史三处都按外人算。
  const address: WechatAddress = {
    account,
    chat,
    name,
    customer: `wechat:${chat}`,
    owner: false,
  };
  return address;
}

/** 校验后的配置。 */
export interface WechatConfig {
  /** 消息交给哪个机器人。 */
  bot: string;
  /** 引擎目录：python/、runtime/ 都在里面。默认 运行时目录/program/wechat。 */
  root: string;
  /** 跑 wechat_cli 的 python.exe。默认 root/runtime/env/python/python.exe。 */
  python: string;
  /** 跑发送 worker（带 OCR）的 python.exe。默认 root/runtime/env/ocr/python/python.exe。 */
  ocrPython: string;
  /** AOBW 地址。默认 http://127.0.0.1:30010。 */
  aobwUrl: string;
  /** 绑定锁文件，和积木客服共用。默认往上找 cache/jmk/wx-bind.lock。 */
  lockFile: string;
  /** 多久查一次新消息，毫秒；0 是不查。默认 3000。 */
  intervalMs: number;
  /** 群里推断“@我”的额外昵称，逗号分隔。 */
  atNames: string;
  /** 后台读最近会话的条数（默认 5000，覆盖一千多个会话）。 */
  chatLimit: number;
  /** 真的发微信。默认 false：只听不发，回复只当草稿。 */
  send: boolean;
}

/** 发件表的一行。 */
export interface OutItem {
  id: number;
  account: string;
  chat: string;
  name: string;
  text: string;
  /** draft 草稿、waiting 等确认、sending 发送中、sent 已确认发出、unconfirmed 按了 Enter 没回读到、failed、rejected。 */
  state: string;
  note: string;
  at: number;
}


/** 微信渠道。 */
export class Wechat {
  /** 渠道名。 */
  readonly name = 'wechat';

  /** 读消息。 */
  readonly reader: Reader;

  /** 本地微信消息。 */
  private readonly messageStore: storeModule.Store;

  /** 发消息。 */
  readonly sender: Sender;

  /** approval 服务；挂着时有。 */
  approval: Approval | undefined;

  /** 轮询状态：给页面和网页左下角的小圆点。 */
  readonly status = { rounds: 0, lastRunAt: 0, lastError: '', busy: false, chats: 0, synced: 0, pending: 0 };

  /** 正在补全历史的监听会话，避免同一会话并发补两遍。 */
  private readonly filling = new Set<string>();

  /** 各微信账号最近一次成功读取的会话，键由后台账号或客服页请求提供。 */
  private readonly pageChats = new Map<string, { at: number; rows: ChatItem[] }>();

  /** 避免后台同步与客服页为同一账号同时启动两次微信读取。 */
  private readonly chatsInFlight = new Map<string, Promise<ChatItem[]>>();

  /**
   * 建表；ready 时开始轮询；被拔掉时停轮询、关 worker。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验过的配置。
   */
  constructor(private readonly ctx: cordis.Context, readonly config: WechatConfig) {
    //M 向 bots 登记渠道名（网页的渠道清单用），拔除插件时随生命周期撤销。
    this.ctx.effect(() => this.ctx.bots.channel(this.name));

    //M 读端运行只读引擎，供会话轮询、历史和媒体查询使用。
    this.reader = new Reader(config.root, config.python, config.atNames);

    //M 发端使用独立的 OCR 运行时与窗口定位实例。
    this.sender = new Sender(config.root, config.ocrPython, new Window(config.aobwUrl, config.lockFile));
    const db = this.ctx.resources.db;

    //M 与独立程序共用相同的微信表和消息写入格式。
    this.messageStore = new storeModule.Store(db);

    //M 微信来的话：每个客户一场前台会话。不再在 bot/receive 里自己认领：bots 按来源范围（微信、账号、会话）找前台，
    //M   同客户的旧前台会补写范围沿用（FrontDesk.findOrCreateFrontByScope）；起草（draftReply 走 bots.receive）由前台按客户找，是同一场。


    //M 微信来的会话：最近 50 条（自己的、对方的都算）拼进 system，和现在会话把最近对话给模型看是一个意思。
    this.ctx.on('session/before-model', (request) => this.onRequest(request));
    //M 让 memory_get 按偏移读取当前微信会话，缺页时由微信读取器补录。

    //M 把最近轮询错误或累计轮数填进网页的渠道状态。
    this.ctx.on('web-api/status', (list) => {
      let detail = `出错：${this.status.lastError}`;
      if (this.status.lastError === '') {
        detail = `已查 ${String(this.status.rounds)} 轮`;
      }
      //M 将微信轮询结果加入当前的渠道状态清单。
      list.push({ name: 'wechat', bot: config.bot, connected: this.status.lastError === '', detail });
    });

    //M 统一渠道回执出口：模型一轮里每调一次 channel_reply、零次兜底、审批直回、旧路自动回话，都经 channel/reply 到这里，逐条进发件表。
    //M   模型的话照旧要本人点头才发（没开自动发时）；审批直回（轮名 approval）不再套娃问。
    protocol.registerTextReply(this.ctx, {
      channel: this.name,
      getTargetAddress: (chat) => this.getReplyTargetAddress(chat),
      sendDirectText: (text, request, targetAddress) => {
        //G 旧路（带会话号）只发做完的一轮：出错、停下的原因和转着时的中途一句不发给客户（原来渠道 send 的规矩）。
        const refused = this.refuseUnfinished(request);
        if (refused !== undefined) return refused;

        const raw = targetAddress ?? request.sourceSnapshot?.origin.address;
        const account = utils.getStringField(raw, 'account');
        const chat = utils.getStringField(raw, 'chat');
        const chatName = utils.getStringField(raw, 'name');
        const customer = utils.getStringField(raw, 'customer');
        if (account === '' || chat === '' || text.trim() === '') return;

        let displayName = chat;
        if (chatName !== '') {
          displayName = chatName;
        }
        let customerKey = `wechat:${chat}`;
        if (customer !== '') {
          customerKey = customer;
        }
        //M 回话目标沿用来源地址上的客户号（customerKey），其余照统一的写法。
        const target = getWechatAddress(account, chat, displayName);
        target.customer = customerKey;
        //M 从回复轮次判定是否需要再次审批，再按发送设置处理这条回复。
        const askApproval = getRoundId(request.replyRoundKey) !== 'approval';
        this.deliverOrDraft(target, request.bot, text, askApproval);
      },
    });

    //M 等 Main 把插件都挂完（事件 ready）才开始定时查，拔掉插件时清定时器、关发送 worker。
    this.ctx.on('ready', () => {
      if (config.intervalMs <= 0) return;

      //M 按配置周期拉取会话增量，供本地记录和监听逻辑处理。
      const timer = setInterval(() => void this.poll(), config.intervalMs);
      this.ctx.effect(() => () => clearInterval(timer));
    });

    //M 拔掉插件时关闭后台发送 worker，避免遗留进程。
    this.ctx.effect(() => () => this.sender.close());
  }

  /**
   * 读账号的最近会话。页面定时刷新可复用缓存，后台同步与手动扫描要求重新读取。
   * @param account 微信账号 ID。
   * @param fresh 是否跳过缓存读取。
   * @returns 微信引擎返回的会话，成功时更新本账号的缓存。
   */
  async getPageChats(account: string, fresh: boolean): Promise<ChatItem[]> {
    //G 页面只复用一个刷新周期内成功读取的会话。
    const cached = this.pageChats.get(account);
    if (!fresh && cached && Date.now() - cached.at < PAGE_CHATS_MAX_AGE_MS) return cached.rows;

    //G 同账号正在扫描时共享该次读取，失败由每个调用者按原路径处理。
    const pending = this.chatsInFlight.get(account);
    if (pending !== undefined) return pending;

    //M 取得最新结果，供后台同步和页面轮询共用。
    const limit = this.config.chatLimit;
    const read = this.reader.sessions(account, limit);
    this.chatsInFlight.set(account, read);
    try {
      const rows = await read;
      const entry = { at: Date.now(), rows };
      this.pageChats.set(account, entry);
      return rows;
    } finally {
      this.chatsInFlight.delete(account);
    }
  }

  /** 查一轮：每个已连接账号先读最近会话列表，时间变了的（最多 SYNC_BATCH 个）跑一次 sync-batch。上一轮没跑完就跳过。 */
  //M 原来只同步“重点监听”的会话（2026-11-14 23:15 EST 前）；现在照原版积木客服，后台把全部会话都听上。
  async poll(): Promise<void> {
    if (this.status.busy) return;

    this.status.busy = true;
    try {
      const db = this.ctx.resources.db;
      let total = 0, pending = 0;
      //M 枚举微信账号，对每个账号读取当前的最近会话。
      for (const account of this.reader.accounts().map((item) => item.id)) {
        const fresh = true;
        const chats = await this.getPageChats(account, fresh);
        total += chats.length;

        //M 用已同步时间找出尚未同步或收到新消息的会话。
        const known = new Map((db
          .query('SELECT chat, last_time FROM wechat_sync WHERE account = ?')
          .all(account) as { chat: string; last_time: number | null }[])
          .map((row) => [row.chat, row.last_time]));
        const todo = chats.filter(
          (chat) => !known.has(chat.username) || chat.timestamp > (known.get(chat.username) ?? 0),
        );
        pending += Math.max(0, todo.length - SYNC_BATCH);
        //G since 是 0（以前没读到过消息）也按第一次算：只存不交，不会把存量当新消息交给机器人。
        const batch = todo.slice(0, SYNC_BATCH);
        if (batch.length > 0) {
          await this.syncChats(account, batch.map((chat) => ({
            chat: chat.username, name: chat.chat, since: known.get(chat.username) || null, at: chat.timestamp,
          })));
        }
        //M 勾了监听的会话：后台把更早的消息也全部补进库（不阻塞这一轮太久，每轮每个账号最多开 3 个补历史）。
        const watched = db
          .query('SELECT w.chat FROM wechat_watch w JOIN wechat_sync s ON s.account = w.account AND s.chat = w.chat'
            + ' WHERE w.account = ? AND IFNULL(s.full, 0) != 1')
          .all(account) as { chat: string }[];
        for (const row of watched.slice(0, 3)) void this.backfillAll(account, row.chat);
      }
      this.status.chats = total;
      this.status.pending = pending;
      //M 汇总已有同步记录的会话数，更新客服页的进度。
      this.status.synced = (db.query('SELECT COUNT(*) AS n FROM wechat_sync').get() as { n: number }).n;
      this.status.lastError = '';
    } catch (error) {
      //G 记录这轮轮询错误，让状态页能说明失败原因。
      this.status.lastError = textModule.getErrorMessage(error);
    } finally {
      this.status.busy = false;
      this.status.rounds += 1;
      this.status.lastRunAt = Date.now();
    }
  }

  /** 同步几个会话并存表。since 是 null 的是第一次（取最近 50 条存量，只存不交）。页面点开还没同步过的会话时也调它。 */
  //M at 是会话列表里的最后消息时间：这批没读到消息（读不了的会话、空会话）也记到它，免得每轮重读、更免得下次 since=0 把存量当新消息交出去。
  async syncChats(
    account: string,
    chats: { chat: string; name: string; since: number | null; at: number }[],
  ): Promise<void> {
    const results = await this.reader.syncBatch(account, chats.map((item) => ({ chat: item.chat, since: item.since })));
    for (const item of chats) {
      const result = results.find((one) => one.chat === item.chat);
      const failed = result === undefined || result.missing || result.error !== undefined;
      let messages: RawMessage[] = [];
      if (!failed && result !== undefined) {
        messages = result.messages ?? [];
      }

      //M 把本批读到的消息交给统一存储流程，同时更新会话同步位置。
      await this.store(
        account,
        { chat: item.chat, name: item.name, last_time: item.since, at: item.at },
        result?.is_group === true,
        messages,
      );
    }
  }

  /** 一个会话这批消息存表；以前同步过的，新进来的、要关注的交给机器人；记下同步到哪一秒。 */
  private async store(
    account: string,
    row: { chat: string; name: string; last_time: number | null; at?: number },
    group: boolean,
    messages: RawMessage[],
  ): Promise<void> {
    const db = this.ctx.resources.db;
    let last = row.last_time ?? 0;
    //M 缓存本会话的监听状态，用它判断哪些新消息要交给机器人。
    const watched = db.query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ?').get(account, row.chat);
    for (const msg of messages) {
      last = Math.max(last, msg.create_time);
      //M 生成可读正文供渠道事件使用，同时入库并记录是否为新增。
      const view = storeModule.getMessageView(msg);
      const text = storeModule.describe(view);
      const added = this.messageStore.save(account, row.chat, msg);

      //G 第一次同步（存量）、重复的、自己发的、群里没 @我 的、公众号和系统会话：只存不交。
      //M 没勾“监听”（wechat_watch 里没有）的会话只存不交，不调模型、不起草；勾了的，对方私聊、群里 @我 才交给机器人起草。
      if (!added || row.last_time === null || msg.from_self === true || (group && !msg.at_me) || text === ''
        || SKIP_REPLY.test(row.chat)) continue;
      if (watched === null) continue;

      const address = getWechatAddress(account, row.chat, row.name);
      let said = text;
      if (group && view.sender !== undefined && view.sender !== '') {
        said = `${view.sender}：${text}`;
      }

      const receivedAt = Date.now();
      let createdAt = receivedAt;
      let timeSource: 'provider' | 'received' = 'received';
      if (msg.create_time > 0) {
        createdAt = msg.create_time * 1000;
        timeSource = 'provider';
      }
      let chatType: protocol.ChannelChatType = 'p2p';
      if (group) {
        chatType = 'group';
      }
      const sender: { id: string; name?: string } = { id: view.sender || row.chat };
      if (view.sender !== undefined && view.sender !== '') {
        sender.name = view.sender;
      }
      const mentions: protocol.ChannelMention[] = [];
      if (group && msg.at_me === true) {
        //M 群聊消息点名本账号时，把对应机器人加入提及记录。
        mentions.push({ id: account, botNames: [this.config.bot] });
      }
      const nativeId = `${msg.source}:${String(msg.local_id)}`;
      //M 把微信原生消息标识转换成标准渠道消息号，供历史和事件关联。
      const messageId = protocol.makeChannelMessageId(this.name, account, nativeId);

      //T 跟踪：微信来了一条要回的，先存表，再经 emitInbound 发出（私聊 channel/direct，群里 @我 channel/mention）。
      const vars = { account: account, chat: row.name, customer: address.customer, length: said.length };
      const code = 'protocol.emitInbound(ctx, msg, true, control)';
      this.ctx.emit('trace', 'Wechat.store', 'trace.wechat.receiveMessage', code, vars);

      const channelMessage: protocol.ChannelMessage = {
        v: 1,
        messageId,
        nativeId,
        channel: this.name,
        accountId: account,
        chatId: row.chat,
        chatType,
        sender,
        //M 微信说话的一律是外人（地址 owner: false，channels 的 isOwnerTurn 也这么判）。
        role: 'guest',
        targetBots: [this.config.bot],
        mentions,
        rawText: text,
        text: said,
        attachments: [],
        createdAt,
        receivedAt,
        timeSource,
        replyTo: null,
        origin: {
          channel: this.name,
          address: { ...address },
        },
        visibility: {
          scope: `${this.name}:${account}:${row.chat}`,
          trusted: !group,
          publicSourceIds: [],
        },
        routing: {
          autoFinal: true,
        },
      };

      //M 交下来的都是叫了机器人的（私聊、群里 @我）：私聊发 channel/direct、群里发 channel/mention。
      //M   bots 按来源范围排进这个客户的前台；一轮里 channel_reply 几次进几条发件，一次没调就把最后的话进发件。
      const control: protocol.ChannelMessageControl = { claims: [] };
      await protocol.emitInbound(this.ctx, channelMessage, true, control);
    }
    if (messages.length === 0) last = Math.max(last, row.at ?? 0);

    //M 将监听名单的最后活动时间推进至本次读取位置。
    db.query('UPDATE wechat_watch SET last_time = ? WHERE account = ? AND chat = ?').run(last, account, row.chat);
    let isGroupFlag = 0;
    if (group) {
      isGroupFlag = 1;
    }

    //M 保存同步位置和会话信息，下次从该位置继续拉取增量。
    db.query('INSERT INTO wechat_sync (account, chat, name, is_group, last_time) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT (account, chat) DO UPDATE SET name = excluded.name, is_group = excluded.is_group,'
      + ' last_time = excluded.last_time')
      .run(account, row.chat, row.name, isGroupFlag, last);
  }

  /** 一行消息给模型看的样子：时间 谁：内容。 */
  private line(row: { at: number; from_self: number; sender: string; kind: string; text: string }): string {
    const at = new Date(row.at * 1000).toLocaleString('zh-CN', { hour12: false });
    let who = '对方';
    if (row.sender !== '') {
      who = row.sender;
    }
    if (row.from_self === 1) {
      who = '我';
    }
    let body = `[${row.kind}]`;
    if (row.text !== '') {
      body = row.text;
    }
    return `${at} ${who}：${body}`;
  }

  /**
   * 识别跨渠道发往微信的目标聊天（仅查询微信自有 wechat_watch / wechat_sync / wechat_messages 表）；认不出返回 undefined。
   * @param rawChat 调用方传入的聊天标识、备注名或带账号/wechat 前缀的写法。
   */
  private getReplyTargetAddress(rawChat: string): Record<string, unknown> | undefined {
    //M 拆目标串：去掉网页展示的“微信·”前缀（剩下的按备注名认），拆出可选的“账号:聊天”“wechat:聊天”。
    const labelPrefixes = ['微信·'];
    const target = protocol.parseChatTarget(rawChat, labelPrefixes);
    if (target.exact === '') return undefined;

    //M 冒号右边是聊天号；左边不是 wechat 就当指定的微信账号。
    let targetChat = target.exact;
    if (target.chat !== '') {
      targetChat = target.chat;
    }
    let preferredAccount = '';
    if (target.prefix !== '' && target.prefix !== this.name) {
      preferredAccount = target.prefix;
    }

    //M 按监听名单、同步表、消息表顺序检索匹配的微信账号和聊天编号（微信的号和备注名在库里按索引查，不拼候选清单）。
    const tables: Array<'wechat_watch' | 'wechat_sync' | 'wechat_messages'> = [
      'wechat_watch', 'wechat_sync', 'wechat_messages',
    ];
    for (const table of tables) {
      if (!this.hasTable(table)) {
        continue;
      }
      //M 按当前表核对微信聊天或备注名称，未命中或字段不完整则顺延下一张表。
      const found = this.getChatRowFromTable(table, preferredAccount, target.exact, targetChat, target.label);
      if (found === undefined || found.account === '' || found.chat === '') {
        continue;
      }

      let name = found.chat;
      if (typeof found.name === 'string' && found.name !== '') {
        name = found.name;
      }
      //M 渠道协议要 Record<string, unknown>，接口类型不带索引签名，展开成普通对象再交出去。
      const address = getWechatAddress(found.account, found.chat, name);
      return { ...address };
    }
    return undefined;
  }

  /**
   * 检查运行时数据库是否存在指定表。
   * @param tableName 表名。
   */
  private hasTable(tableName: string): boolean {
    //M 查 sqlite_master 确认微信自有表是否已创建。
    const row = this.ctx.resources.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    return row !== null && row !== undefined;
  }

  /**
   * 按表名从微信自有表中取一条匹配的 (account, chat, name) 记录。
   * @param table 微信数据表名。
   * @param preferredAccount 可选指定账号。
   * @param exact 完整输入字符串。
   * @param targetChat 解析后的纯聊天编号。
   * @param labelTarget 去前缀展示名。
   */
  private getChatRowFromTable(
    table: 'wechat_watch' | 'wechat_sync' | 'wechat_messages',
    preferredAccount: string,
    exact: string,
    targetChat: string,
    labelTarget: string,
  ): { account: string; chat: string; name?: string } | undefined {
    const db = this.ctx.resources.db;
    if (table === 'wechat_messages') {
      if (preferredAccount !== '') {
        //M 按明确指定的账号和 chat 查消息表确认会话归属。
        const pair = db
          .query('SELECT account, chat FROM wechat_messages WHERE account = ? AND chat = ?'
            + ' ORDER BY at DESC LIMIT 1')
          .get(preferredAccount, targetChat) as { account: string; chat: string } | null;
        if (pair !== null) return pair;
      }
      //M 再依次按原始串和去前缀纯 chat 查最近一次记录对应的微信号。
      const byExact = db.query('SELECT account, chat FROM wechat_messages WHERE chat = ? ORDER BY at DESC LIMIT 1')
        .get(exact) as { account: string; chat: string } | null;
      if (byExact !== null) return byExact;

      //M 若入参带前缀，继续按纯聊天编号查询所属账号。
      const byPlain = db.query('SELECT account, chat FROM wechat_messages WHERE chat = ? ORDER BY at DESC LIMIT 1')
        .get(targetChat) as { account: string; chat: string } | null;
      if (byPlain !== null) return byPlain;

      return undefined;
    }

    if (preferredAccount !== '') {
      //M 按账号和纯 chat 精确匹配监听表或同步表。
      const pair = db.query(`SELECT account, chat, name FROM ${table} WHERE account = ? AND chat = ? LIMIT 1`)
        .get(preferredAccount, targetChat) as { account: string; chat: string; name: string } | null;
      if (pair !== null) return pair;
    }
    //M 按原始 chat、纯 chat 或备注名称查监听表或同步表。
    const byExact = db.query(`SELECT account, chat, name FROM ${table} WHERE chat = ? LIMIT 1`)
      .get(exact) as { account: string; chat: string; name: string } | null;
    if (byExact !== null) return byExact;

    //M 未命中原始串时按拆出的纯聊天号继续查。
    const byPlain = db.query(`SELECT account, chat, name FROM ${table} WHERE chat = ? LIMIT 1`)
      .get(targetChat) as { account: string; chat: string; name: string } | null;
    if (byPlain !== null) return byPlain;

    //M 仍未命中则按备注展示名匹配。
    const byName = db.query(`SELECT account, chat, name FROM ${table} WHERE name = ? LIMIT 1`)
      .get(labelTarget) as { account: string; chat: string; name: string } | null;
    if (byName !== null) return byName;

    return undefined;
  }

  /** 微信会话调模型前：最近 50 条拼进 system。 */
  private onRequest(request: ChatRequest): void {
    //M 背景和翻页使用同一个来源，绑定后按快照读当前账号和聊天。
    const address = this.getHistoryAddress(request.session);
    if (address === undefined) return;

    //M 取当前微信会话的最近消息，为模型补充回复所需的上下文。
    const rows = this.ctx.resources.db
      .query('SELECT at, from_self, sender, kind, text FROM wechat_messages WHERE account = ? AND chat = ?'
        + ' ORDER BY at DESC, local_id DESC LIMIT ?')
      .all(address.account, address.chat, CONTEXT_MESSAGES) as {
        at: number; from_self: number; sender: string; kind: string; text: string;
      }[];
    if (rows.length === 0) return;

    //M 将消息翻回时间正序并逐行渲染，作为这次请求的系统上下文。
    let archiveHint = '';
    const hasGet = request.tools.some((tool) => tool.name === 'memory_get');
    if (hasGet) archiveHint = '\n更早的用 memory_get 翻当前微信聊天，下一页传回执里的 nextCursor 给 before。';
    const context = `# 这个微信会话最近 ${String(rows.length)} 条聊天记录（旧的在前；“我”是这个微信号自己）\n`
      + rows.reverse().map((row) => this.line(row)).join('\n')
      + archiveHint
      + '\n你的回复只会存成草稿给人看，不会自动发出去。';
    request.system.push(context);
  }

  /** 绑定的来源优先，无快照时用旧微信会话的地址。 */
  private getHistoryAddress(session: Session): Pick<WechatAddress, 'account' | 'chat'> | undefined {
    const row = session.row;
    const snapshot = row.frontTask?.sourceSnapshot ?? row.activeSourceSnapshot;
    if (snapshot?.channel === 'wechat' && snapshot.accountId !== '' && snapshot.chatId !== '') {
      return { account: snapshot.accountId, chat: snapshot.chatId };
    }
    if (snapshot !== undefined) return undefined;

    const address = row.address as Partial<WechatAddress> | undefined;
    if (!address?.account || !address.chat) return undefined;

    //G 老会话没有快照时也要确认为微信来源，才允许读取它的记录。
    if (row.channel !== 'wechat' && row.channel !== 'wechat-kefu' && !address.customer?.startsWith('wechat:')) {
      return undefined;
    }
    return { account: address.account, chat: address.chat };
  }

  /**
   * 旧路的回话（带会话号）只发做完的一轮：出错、停下的原因和转着时的中途一句不发给客户。
   * @param request 回复请求；模型一轮里的回复不带会话号，不拦。
   * @returns 要拦下时的 rejected；放行是 undefined。
   */
  private refuseUnfinished(request: protocol.ChannelReplyRequest): protocol.TextReplyOutcome | undefined {
    const sessionId = request.sessionId;
    if (sessionId === undefined) return undefined;

    //M 照说话的会话现在的状态看：做完的才发。
    const session = this.ctx.sessions.open(sessionId);
    if (session.row.state === 'done') return undefined;

    return { status: 'rejected', reason: 'unfinished：这一轮没做完（出错、停下或还在转），不发给微信客户' };
  }

  /**
   * 落盘微信发件表并按开关发送、提交待确认或留为草稿。
   * @param address 微信地址。
   * @param bot 机器人名。
   * @param reply 回复正文。
   * @param askApproval 未开自动发且开了发送开关时，是否再向 approval 登记一次待确认（直回审批确认话不套娃再问）。
   */
  private deliverOrDraft(address: WechatAddress, bot: string, reply: string, askApproval: boolean): void {
    //G 只听不发（用户 11-14）：send 没开就只存草稿，不发、不问 approval。
    if (!this.config.send) {
      this.outbox(address, reply, 'draft');
      return;
    }

    //M 查目标会话的自动发送设置，用来决定初始发件状态。
    const watch = this.ctx.resources.db
      .query('SELECT auto FROM wechat_watch WHERE account = ? AND chat = ?')
      .get(address.account, address.chat) as
      { auto: number } | null;
    let state = 'draft';
    if (askApproval && this.approval !== undefined) {
      state = 'waiting';
    }
    if (watch?.auto === 1) {
      state = 'sending';
    }

    //M 先保存发件并取得编号，自动发送也用同一条记录跟踪。
    const id = this.outbox(address, reply, state);
    if (state === 'sending') void this.deliver(id);
    if (state !== 'waiting' || this.approval === undefined) return;

    //M 不带 session：approval 会对会话 say 一句“怎么回”，那句话会被发给微信客户。
    this.approval.ask({
      kind: 'wechat-send', title: `发微信给「${address.name}」`, detail: reply, payload: { outbox: id }, bot,
      card: {
        kind: 'approval', title: `发微信给「${address.name}」`, reason: '这个会话没开自动发，机器人的回复要你点头才发出去',
        items: [{ label: '会话', value: `${address.name}（${address.chat}）` }, { label: '内容', value: reply }],
        risk: { level: 'medium', text: '会真的发到微信，发出去撤不回' },
        buttons: [
          { action: 'approve', label: '发送', style: 'primary' },
          { action: 'reject', label: '不发', style: 'default' },
        ],
      },
    });
  }

  /**
   * 监听会话：把这个会话更早的消息全部补进库（只存不交，不调模型）。已经补完的跳过。
   * 引擎 backfill 每批最多 500 条；一轮最多 40 批（约 2 万条），没补完的下次再接着补。
   */
  async backfillAll(account: string, chat: string): Promise<void> {
    const key = `${account}\0${chat}`;
    if (this.filling.has(key)) return;

    //G 占住账号与会话的补录位置，避免多条触发路径同时拉取。
    this.filling.add(key);
    const db = this.ctx.resources.db;
    try {
      //G 已标记补全的会话无需重新运行历史引擎。
      const row = db
        .query('SELECT full FROM wechat_sync WHERE account = ? AND chat = ?')
        .get(account, chat) as { full: number | null } | null;
      if (row?.full === 1) return;

      const batch = 500;
      for (let i = 0; i < 40; i++) {
        //M 以本地最早消息的时间向前分页，每批从当前进度接着读。
        const oldest = db
          .query('SELECT MIN(at) AS at FROM wechat_messages WHERE account = ? AND chat = ?')
          .get(account, chat) as { at: number | null };
        const until = oldest.at ?? Math.floor(Date.now() / 1000) + 1;
        const more = await this.reader.backfill(account, chat, until, batch);
        const messages = more.messages ?? [];
        let added = 0;

        //M 逐条入库并统计新增，用于判断这批是否还能继续往前推进。
        for (const msg of messages) {
          if (this.messageStore.save(account, chat, msg)) added += 1;
        }
        if (messages.length < batch
          || (added === 0 && messages.length > 0 && Math.min(...messages.map((msg) => msg.create_time)) >= until)) {
          //M 批次不足或无法前进时标记该会话历史已补全。
          db.query('UPDATE wechat_sync SET full = 1 WHERE account = ? AND chat = ?').run(account, chat);
          return;
        }
        if (messages.length === 0) {
          //M 没有更旧的消息时关闭该会话后续的补录。
          db.query('UPDATE wechat_sync SET full = 1 WHERE account = ? AND chat = ?').run(account, chat);
          return;
        }
      }
    } finally {
      this.filling.delete(key);
    }
  }

  /**
   * 勾了监听之后调用：还没同步过就先拉最近一批，再把更早的消息全部补进库（只存不交）。
   */
  async fillWatched(account: string, chat: string, name: string): Promise<void> {
    //M 检查是否已经同步过，用来决定补录前是否先拉最近消息。
    const row = this.ctx.resources.db
      .query('SELECT full FROM wechat_sync WHERE account = ? AND chat = ?')
      .get(account, chat) as { full: number | null } | null;
    if (row === null) {
      //M 首次监听先入库最近一批历史，为向前补录建立起点。
      await this.syncChats(account, [{ chat, name, since: null, at: 0 }]);
    }

    //M 继续向前补录这个监听会话，已有完整历史的会话会直接略过。
    await this.backfillAll(account, chat);
  }

  /**
   * 人手点“让 AI 回复”：对已监听会话立刻让机器人根据最近聊天记录起草一条，只存草稿，不发送。
   * @throws 没勾监听时抛错。
   */
  async draftReply(account: string, chat: string): Promise<OutItem | null> {
    //G 起草仅面向已监听会话，并使用其中记录的会话名。
    const watch = this.ctx.resources.db
      .query('SELECT name FROM wechat_watch WHERE account = ? AND chat = ?')
      .get(account, chat) as { name: string } | null;
    if (watch === null) throw new Error('请先勾选监听，才能让 AI 起草回复');

    //M 记住发件表原有的末尾编号，以便随后找出这次调用之后的新记录。
    const before = Number((this.ctx.resources.db
      .query('SELECT IFNULL(MAX(id), 0) AS id FROM wechat_outbox WHERE account = ? AND chat = ?')
      .get(account, chat) as { id: number }).id);
    const address = getWechatAddress(account, chat, watch.name || chat);
    //M 借当前微信会话地址通知机器人生成回复草稿。
    await this.ctx.bots.receive(this.name, this.config.bot, '请根据这个会话的最近聊天记录，起草一条合适的回复。只起草，不要向对方发送。', address);

    //M 返回该会话在请求之后新增的最近发件，供客服页展示。
    return this.ctx.resources.db
      .query('SELECT * FROM wechat_outbox WHERE account = ? AND chat = ? AND id > ? ORDER BY id DESC LIMIT 1')
      .get(account, chat, before) as OutItem | null;
  }

  /** 记一条发件，交回号。 */
  outbox(address: Pick<WechatAddress, 'account' | 'chat' | 'name'>, text: string, state: string): number {
    const sql = 'INSERT INTO wechat_outbox (account, chat, name, text, state, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)';
    //M 写入发件内容和初始状态，用返回的行号跟踪这次发件。
    return Number(this.ctx.resources.db
      .query(sql).run(address.account, address.chat, address.name, text, state, '', Date.now()).lastInsertRowid);
  }

  /** 改发件的状态。 */
  mark(id: number, state: string, note = ''): void {
    //M 同步保存发件状态和原因，供客服页查看发送或审批结果。
    this.ctx.resources.db.query('UPDATE wechat_outbox SET state = ?, note = ? WHERE id = ?').run(state, note, id);
  }

  /** 发一条发件。只发监听名单里的会话；结果写回发件表。 */
  async deliver(id: number): Promise<void> {
    //M 以发件记录为发送目标和正文的来源，已不存在就直接结束。
    const item = this.ctx.resources.db.query('SELECT * FROM wechat_outbox WHERE id = ?').get(id) as OutItem | null;
    if (item === null) return;
    //G 只听不发：send 没开，任何路径（自动发、同意、页面按钮）都到不了下面的发送。
    if (!this.config.send) return this.mark(id, 'draft', '只听不发：没有发出去');

    //G 发送前核对目标仍在监听名单，取消监听后禁止送出。
    const watched = this.ctx.resources.db
      .query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ?')
      .get(item.account, item.chat);
    if (watched === null) return this.mark(id, 'failed', '会话不在监听名单，不发');

    //M 标记发送开始，并取账号昵称供发送端识别当前微信窗口。
    this.mark(id, 'sending');
    const nickname = this.reader.accounts().find((acc) => acc.id === item.account)?.nickname ?? item.account;
    try {
      //M 用发件号标识发送请求，随后用回执判断是否确认发送。
      const result = await this.sender.send(
        { account: item.account, chat: item.chat, name: item.name, nickname },
        item.text,
        `jmbots-wechat-${String(id)}`,
      );
      let outboxState: 'sent' | 'unconfirmed' = 'unconfirmed';
      if (result['confirmed'] === true) {
        outboxState = 'sent';
      }

      //M 将确认状态和引擎回执记回这条发件。
      this.mark(id, outboxState, String(result['status'] ?? ''));
    } catch (error) {
      //G 把发送失败的文字原因记回发件表，供客服处理。
      this.mark(id, 'failed', textModule.getErrorMessage(error));
    }

    //T 跟踪：发了一条微信。
    const after = this.ctx.resources.db
      .query('SELECT state, note FROM wechat_outbox WHERE id = ?')
      .get(id) as { state: string; note: string };
    const vars = { outboxId: id, chat: item.name, result: after.state, note: after.note.slice(0, 80) };
    this.ctx.emit('trace', 'Wechat.deliver', 'trace.wechat.deliver', 'sender.send(target, text, requestId)', vars);
  }

  /** 待确认定了：同意就发，拒绝记下。 */
  onDecided(pending: Pending): void {
    if (pending.kind !== 'wechat-send') return;

    const id = (pending.payload as { outbox: number }).outbox;
    if (pending.state === 'approved') {
      //M 审批同意后按原发件编号启动发送，仍经过发送入口的检查。
      void this.deliver(id);
      return;
    }

    //M 记录拒绝状态与审批人，供客服看到未发送的原因。
    this.mark(id, 'rejected', pending.by ?? '');
  }
}


/** 往上找 cache/jmk 文件夹（和积木客服 WxLocate.ts:1000-1016 同一个锁）；找不到放引擎的 runtime/tmp。 */
function defaultLock(root: string): string {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'cache', 'jmk'))) return path.join(dir, 'cache', 'jmk', 'wx-bind.lock');

    if (path.dirname(dir) === dir) return path.join(root, 'runtime', 'tmp', 'wx-bind.lock');
  }
}

/**
 * 校验配置（外面进来的，只在这里查一次）。
 * @param ctx 提供机器人名单和运行时目录的 Cordis 上下文。
 * @param written 微信插件的原始配置。
 * @returns 用于挂载插件的配置与解析后的运行路径。
 * @throws bot 不在名单、interval_ms 不是非负整数时抛错。
 */
export function checkConfig(ctx: cordis.Context, written: unknown): WechatConfig {
  let own: Record<string, unknown> = {};
  if (typeof written === 'object' && written !== null) {
    own = written as Record<string, unknown>;
  }

  //G 未指定时用名单首项，并确认选定机器人确实已登记。
  const bot = own['bot'] ?? botUtils.getDefaultBot(ctx.resources.raw);
  const known = typeof bot === 'string' && botUtils.getBotConfig(ctx.resources.raw, bot) !== undefined;
  if (!known) throw new Error('wechat 插件的 bot 要写机器人名单里有的名字');

  const intervalWritten = own['interval_ms'] ?? 3000;
  const intervalMs = checksModule.checkNumber(intervalWritten, 'wechat.interval_ms', { integer: true, min: 0 });

  let rawRoot = 'program/wechat';
  if (typeof own['root'] === 'string') {
    rawRoot = own['root'];
  }
  const root = path.resolve(ctx.resources.root, rawRoot);
  const pick = (key: string, fallback: string): string => {
    const val = own[key];
    if (typeof val === 'string') return path.resolve(root, val);

    return fallback;
  };
  let aobwUrl = 'http://127.0.0.1:30010';
  if (typeof own['aobw_url'] === 'string') {
    aobwUrl = own['aobw_url'].replace(/\/+$/u, '');
  }
  let atNames = '';
  if (Array.isArray(own['at_names'])) {
    atNames = own['at_names'].map(String).join(',');
  }
  let chatLimit = 5000;
  const rawLimit = own['chat_limit'];
  if (Number.isInteger(rawLimit) && (rawLimit as number) > 0) {
    chatLimit = rawLimit as number;
  }
  return {
    bot, root, intervalMs: intervalMs as number,
    //M 解析读取与 OCR 的 Python 路径，未配置时取各自的运行时环境。
    python: pick('python', path.join(root, 'runtime', 'env', 'python', 'python.exe')),
    ocrPython: pick('ocr_python', path.join(root, 'runtime', 'env', 'ocr', 'python', 'python.exe')),
    aobwUrl,
    //M 默认与同机微信操作共享窗口锁，亦可由插件配置指定。
    lockFile: pick('lock_file', defaultLock(root)),
    atNames,
    chatLimit,
    send: own['send'] === true,
  };
}


/**
 * 挂上微信：建渠道、登记页面和接口；approval 来了才接卡片。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins 段里写给它的：
 *   { bot, root?, python?, ocr_python?, aobw_url?, lock_file?, interval_ms?, at_names?, chat_limit?, send? }。
 * 副作用：启动微信渠道，登记客服接口并接入审批结果。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  //M 先校验外部配置，再用同一个微信实例挂渠道和客服路由。
  const wechat = new Wechat(ctx, checkConfig(ctx, config));

  //M 播放时把核实过的语音留在这个机器人的消息目录。
  const messages = ctx.resources.ensureRuntimeDir('bots', wechat.config.bot, 'message');
  const voice = new voiceModule.VoiceAudio(wechat.reader, messages);
  page.routes(ctx.http, ctx.resources.db, wechat, voice);
  void ctx.inject(['approval'], (sub) => {
    wechat.approval = sub.approval;
    //M 监听审批结果，按发件编号更新状态或触发发送。
    sub.on('approval/decided', (pending) => wechat.onDecided(pending as Pending)); // feishu 那边把事件声明成了 PendingLike
    sub.effect(() => () => {
      wechat.approval = undefined;
    });
  });
}
