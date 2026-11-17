/**
 * 微信：一个插件管微信的全部——渠道收发（这个文件）、读消息（read/）、后台发送（send/）、客服页面和接口（page/）。
 * 由积木客服（和 jmbots 同级的 source/jimukefu）改写，调研和对照见 docs/src7插件设计/调研_积木客服.md。
 *
 * 收：每隔 interval_ms 读一次最近会话列表（chat_limit，默认 5000 个），最后消息时间变了的会话（一轮最多 SYNC_BATCH 个）跑只读引擎 sync-batch，
 *     新消息全部存表，页面上都能看。第一次同步拉的是存量，只存不交。勾了“监听”的会话会再把更早的消息全部补进库（不交机器人）。
 *     客户号是 wechat:<会话 username>，每个客户一场前台会话（memory 按客户号检索）。
 * 起草：只有勾了“监听”的会话（wechat_watch 里有）才交给机器人：对方私聊说的、群里 @我 的；没勾的会话只存不交，不调模型。公众号、系统会话不交。
 *     页面上的“让 AI 回复”可对当前已监听会话立即起草一条（只存草稿，不发送）。
 * 发：只听不发。send 开关（config 里 wechat-kefu.send）默认 false：机器人的回复一律进发件表当草稿（state=draft），不问 approval，
 *     deliver 和页面上的“发送”按钮也只落成草稿。send: true 时才发：会话开了“自动发”就发，没开就登记待确认、没挂 approval 就留草稿；
 *     只发到监听名单里的会话，发送失败不重发。
 * 上下文：最近 50 条（自己说的、对方说的都算）拼进 system；更早的模型用工具 wechat_history 自己决定读多少。
 * 事件：不加新事件。跟踪点照 utils/Trace.ts（ctx.emit('trace', …)）；听 approval/decided、web-api/status、bot/receive（排最前）。
 * Cordis 大白话：apply 是插件的 main()，ctx 是它拿到的遥控器；ctx.on 听的事件、ctx.effect 登记的收尾，插件拔掉时自动撤。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import type { ChatRequest } from '../../Chat.ts';
import type { Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import type { Approval, Pending } from '../approval/index.ts';
import * as page from './page/Routes.ts';
import { Reader } from './read/Reader.ts';
import type { RawMessage } from './read/Reader.ts';
import { Sender } from './send/Sender.ts';
import { Window } from './send/Window.ts';


/** 插件名。 */
export const name = 'wechat-kefu';

/** 用到的服务。approval 有就用，在 apply 里 ctx.inject。 */
export const inject = ['resources', 'bots', 'sessions', 'http', 'tools'];

/** 一轮最多同步几个会话（第一次全量时 500 个会话分几轮做完，免得一个引擎进程跑太久）。 */
const SYNC_BATCH = 60;
/** 拼进上下文的最近几条（用户 11-14：最少 50 条进上下文，更早的模型自己用工具读）。 */
const CONTEXT_MESSAGES = 50;
/** 微信自带的系统会话和公众号：只存不交给机器人。 */
const SKIP_REPLY = /^(gh_|filehelper$|weixin$|notifymessage$|fmessage$|floatbottle$|medianote$|newsapp$|qqmail$|brandsessionholder$|brandservicesessionholder$|qmessage$|tmessage$|qqsync$|@)/u;


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 客户号：渠道:渠道内用户号（wechat:wxid_xxx）。memory 按它分客户检索。 */
    customer?: string;
  }
}


/** 微信的回话地址，记在会话的 row.address 上。customer 给 memory 认客户。 */
export interface WechatAddress {
  account: string;
  chat: string;
  name: string;
  customer: string;
}

/**
 * 一条消息给人、给模型看的文字（2026-11-14 23:30 EST：原来非文字消息只剩空串，页面显示 [image]、模型也看不到）。
 * 照 jimukefu msgview 的种类：图片、语音、视频、链接/公众号文章、文件、引用、位置、名片、转账……
 */
export function describe(view: RawMessage['view']): string {
  const v = view ?? {};
  const title = v.title ?? '', desc = v.desc ? ` — ${v.desc}` : '';
  switch (v.kind) {
    case 'text': case 'system': case 'call': case 'other': case undefined: return v.text ?? '';
    case 'image': return '[图片]';
    case 'emoji': return '[表情]';
    case 'voice': return `[语音 ${String(v.seconds ?? 0)} 秒]`;
    case 'video': return `[视频 ${String(v.seconds ?? 0)} 秒]`;
    case 'quote': return `${v.text ?? ''}${v.quote ? `（引用 ${v.quote.name ?? ''}：${v.quote.text ?? ''}）` : ''}`;
    case 'location': return `[位置] ${title}${desc}`;
    case 'card': return `[名片] ${title}`;
    case 'transfer': return `[${v.desc ?? '转账'}] ${v.amount ?? ''}`;
    case 'file': return `[文件] ${title}`;
    default: return `[${v.kind === 'link' ? '链接' : '文章/卡片'}] ${title}${desc}`;
  }
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

  /** 发消息。 */
  readonly sender: Sender;

  /** approval 服务；挂着时有。 */
  approval: Approval | undefined;

  /** 轮询状态：给页面和网页左下角的小圆点。 */
  readonly status = { rounds: 0, lastRunAt: 0, lastError: '', busy: false, chats: 0, synced: 0, pending: 0 };

  /** 正在补全历史的监听会话，避免同一会话并发补两遍。 */
  private readonly filling = new Set<string>();

  /**
   * 建表；ready 时开始轮询；被拔掉时停轮询、关 worker。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验过的配置。
   */
  constructor(private readonly ctx: cordis.Context, readonly config: WechatConfig) {
    this.ctx.effect(() => this.ctx.bots.channel(this.name, (reply, session) => this.send(reply, session)));
    this.reader = new Reader(config.root, config.python, config.atNames);
    this.sender = new Sender(config.root, config.ocrPython, new Window(config.aobwUrl, config.lockFile));
    const db = this.ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS wechat_watch (account TEXT, chat TEXT, name TEXT, auto INTEGER, last_time INTEGER, PRIMARY KEY (account, chat))');
    db.exec('CREATE TABLE IF NOT EXISTS wechat_messages (account TEXT, chat TEXT, source TEXT, local_id INTEGER, at INTEGER,'
      + ' from_self INTEGER, kind TEXT, sender TEXT, text TEXT, PRIMARY KEY (account, chat, source, local_id))');
    //M 2026-11-14 23:30 EST：存整条气泡视图（JSON），页面按种类画图片、语音条、卡片。老库补一列。
    if (!(db.query('PRAGMA table_info(wechat_messages)').all() as { name: string }[]).some((col) => col.name === 'view')) db.exec('ALTER TABLE wechat_messages ADD COLUMN view TEXT');
    //M 2026-11-14 23:15 EST：全部会话的同步进度（原来记在 wechat_watch.last_time，只有重点监听的有）。
    db.exec('CREATE TABLE IF NOT EXISTS wechat_sync (account TEXT, chat TEXT, name TEXT, is_group INTEGER, last_time INTEGER, PRIMARY KEY (account, chat))');
    //M 2026-11-15 00:17 EST：full=1 表示这个监听会话的历史已经全部补进库了（不只是最近一段）。
    if (!(db.query('PRAGMA table_info(wechat_sync)').all() as { name: string }[]).some((col) => col.name === 'full')) db.exec('ALTER TABLE wechat_sync ADD COLUMN full INTEGER');
    db.exec('CREATE TABLE IF NOT EXISTS wechat_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, chat TEXT, name TEXT,'
      + ' text TEXT, state TEXT, note TEXT, at INTEGER)');

    //M 微信来的话：每个客户一场前台会话。排在前面只为抢在前台“每个机器人一场”之前定下去向。
    //M 批准与否由 approval 自己核对说话人，不靠这边和 approval 谁先监听；已经 handled 的（如有权的“同意 N”）不再开会话。
    this.ctx.on('bot/receive', (event) => {
      if (event.message.channel !== this.name || event.session !== undefined || event.handled === true) return;

      const customer = (event.message.address as WechatAddress).customer;
      const found = this.ctx.sessions.find({ bot: event.bot.name, kind: 'front', customer })[0];
      event.session = found === undefined
        ? this.ctx.sessions.create({ bot: event.bot.name, kind: 'front', customer })
        : this.ctx.sessions.open(found.id);
    }, { prepend: true });


    //M 微信来的会话：最近 50 条（自己的、对方的都算）拼进 system，和现在会话把最近对话给模型看是一个意思。
    this.ctx.on('session/request', (request) => this.onRequest(request));
    this.ctx.tools.register({
      definition: {
        name: 'wechat_history',
        description: `读当前微信会话更早的聊天记录（只读）。最近 ${String(CONTEXT_MESSAGES)} 条已经在上下文里了；要更早的就用它，`
          + `skip 跳过最近几条（默认 ${String(CONTEXT_MESSAGES)}，也就是从上下文之前开始），limit 读几条（默认 50，最多 500）。你自己决定读多少。`,
        parameters: piAi.Type.Object({
          skip: piAi.Type.Optional(piAi.Type.Number({ description: `跳过最近几条，默认 ${String(CONTEXT_MESSAGES)}` })),
          limit: piAi.Type.Optional(piAi.Type.Number({ description: '读几条，默认 50，最多 500' })),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => this.history(session, args),
    });

    this.ctx.on('web-api/status', (list) => {
      const detail = this.status.lastError === '' ? `已查 ${String(this.status.rounds)} 轮` : `出错：${this.status.lastError}`;
      list.push({ name: 'wechat', bot: config.bot, connected: this.status.lastError === '', detail });
    });

    this.ctx.on('ready', () => {
      if (config.intervalMs <= 0) return;

      const timer = setInterval(() => void this.poll(), config.intervalMs);
      this.ctx.effect(() => () => clearInterval(timer));
    });
    this.ctx.effect(() => () => this.sender.close());
  }

  /** 查一轮：每个已连接账号先读最近会话列表，时间变了的（最多 SYNC_BATCH 个）跑一次 sync-batch。上一轮没跑完就跳过。 */
  //M 原来只同步“重点监听”的会话（2026-11-14 23:15 EST 前）；现在照原版积木客服，后台把全部会话都听上。
  async poll(): Promise<void> {
    if (this.status.busy) return;

    this.status.busy = true;
    try {
      const db = this.ctx.resources.db;
      let total = 0, pending = 0;
      for (const account of this.reader.accounts().map((item) => item.id)) {
        const chats = await this.reader.sessions(account, this.config.chatLimit);
        total += chats.length;
        const known = new Map((db.query('SELECT chat, last_time FROM wechat_sync WHERE account = ?').all(account) as { chat: string; last_time: number | null }[])
          .map((row) => [row.chat, row.last_time]));
        const todo = chats.filter((chat) => !known.has(chat.username) || chat.timestamp > (known.get(chat.username) ?? 0));
        pending += Math.max(0, todo.length - SYNC_BATCH);
        //G since 是 0（以前没读到过消息）也按第一次算：只存不交，不会把存量当新消息交给机器人。
        const batch = todo.slice(0, SYNC_BATCH);
        if (batch.length > 0) await this.syncChats(account, batch.map((chat) => ({ chat: chat.username, name: chat.chat, since: known.get(chat.username) || null, at: chat.timestamp })));
        //M 勾了监听的会话：后台把更早的消息也全部补进库（不阻塞这一轮太久，每轮每个账号最多开 3 个补历史）。
        const watched = db.query('SELECT w.chat FROM wechat_watch w JOIN wechat_sync s ON s.account = w.account AND s.chat = w.chat WHERE w.account = ? AND IFNULL(s.full, 0) != 1').all(account) as { chat: string }[];
        for (const row of watched.slice(0, 3)) void this.backfillAll(account, row.chat);
      }
      this.status.chats = total;
      this.status.pending = pending;
      this.status.synced = (db.query('SELECT COUNT(*) AS n FROM wechat_sync').get() as { n: number }).n;
      this.status.lastError = '';
    } catch (error) {
      this.status.lastError = textModule.messageOf(error);
    } finally {
      this.status.busy = false;
      this.status.rounds += 1;
      this.status.lastRunAt = Date.now();
    }
  }

  /** 同步几个会话并存表。since 是 null 的是第一次（取最近 50 条存量，只存不交）。页面点开还没同步过的会话时也调它。 */
  //M at 是会话列表里的最后消息时间：这批没读到消息（读不了的会话、空会话）也记到它，免得每轮重读、更免得下次 since=0 把存量当新消息交出去。
  async syncChats(account: string, chats: { chat: string; name: string; since: number | null; at: number }[]): Promise<void> {
    const results = await this.reader.syncBatch(account, chats.map((item) => ({ chat: item.chat, since: item.since })));
    for (const item of chats) {
      const result = results.find((one) => one.chat === item.chat);
      const failed = result === undefined || result.missing || result.error !== undefined;
      await this.store(account, { chat: item.chat, name: item.name, last_time: item.since, at: item.at }, result?.is_group === true, failed ? [] : result.messages ?? []);
    }
  }

  /** 一个会话这批消息存表；以前同步过的，新进来的、要关注的交给机器人；记下同步到哪一秒。 */
  private async store(account: string, row: { chat: string; name: string; last_time: number | null; at?: number }, group: boolean, messages: RawMessage[]): Promise<void> {
    const db = this.ctx.resources.db;
    let last = row.last_time ?? 0;
    const watched = db.query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ?').get(account, row.chat);
    for (const msg of messages) {
      last = Math.max(last, msg.create_time);
      const view = msg.view ?? {};
      const text = describe(view);
      const added = this.save(account, row.chat, msg);

      //G 第一次同步（存量）、重复的、自己发的、群里没 @我 的、公众号和系统会话：只存不交。
      //M 没勾“监听”（wechat_watch 里没有）的会话只存不交，不调模型、不起草；勾了的，对方私聊、群里 @我 才交给机器人起草。
      if (!added || row.last_time === null || msg.from_self === true || (group && !msg.at_me) || text === '' || SKIP_REPLY.test(row.chat)) continue;
      if (watched === null) continue;

      const address: WechatAddress = { account, chat: row.chat, name: row.name, customer: `wechat:${row.chat}` };
      const said = group && view.sender !== undefined && view.sender !== '' ? `${view.sender}：${text}` : text;

      //T 跟踪：微信来了一条要回的。
      const vars = { 账号: account, 会话: row.name, 客户: address.customer, 字数: said.length };
      this.ctx.emit('trace', 'Wechat.store', '微信新消息，交给机器人', 'this.ctx.bots.receive(this.name, bot, said, address)', vars);
      await this.ctx.bots.receive(this.name, this.config.bot, said, address);
    }
    if (messages.length === 0) last = Math.max(last, row.at ?? 0);
    db.query('UPDATE wechat_watch SET last_time = ? WHERE account = ? AND chat = ?').run(last, account, row.chat);
    db.query('INSERT INTO wechat_sync (account, chat, name, is_group, last_time) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT (account, chat) DO UPDATE SET name = excluded.name, is_group = excluded.is_group, last_time = excluded.last_time')
      .run(account, row.chat, row.name, group ? 1 : 0, last);
  }

  /**
   * 存一条微信消息进 wechat_messages；以前存过的（撞上表的唯一键）不重复存。同步、翻历史、补全量共用。
   * @param account 微信账号。
   * @param chat 哪个会话。
   * @param msg 读出来的一条消息。
   * @returns 这次新存进去是 true，以前存过是 false。
   * 副作用：写库。
   */
  private save(account: string, chat: string, msg: RawMessage): boolean {
    //M 消息里给人看的那块（类型、谁说的、内容）拆成表里的几列。
    const view = msg.view ?? {};
    const fromSelf = msg.from_self === true ? 1 : 0;
    const kind = view.kind ?? 'other';
    const sender = view.sender ?? '';
    const text = describe(view);

    //M INSERT OR IGNORE：撞上就不写，changes 是 0。
    const sql = 'INSERT OR IGNORE INTO wechat_messages'
      + ' (account, chat, source, local_id, at, from_self, kind, sender, text, view)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const insert = this.ctx.resources.db.query(sql);
    const result = insert.run(
      account,
      chat,
      msg.source,
      msg.local_id,
      msg.create_time,
      fromSelf,
      kind,
      sender,
      text,
      JSON.stringify(view),
    );
    return result.changes > 0;
  }

  /** 一行消息给模型看的样子：时间 谁：内容。 */
  private line(row: { at: number; from_self: number; sender: string; kind: string; text: string }): string {
    const at = new Date(row.at * 1000).toLocaleString('zh-CN', { hour12: false });
    const who = row.from_self === 1 ? '我' : row.sender !== '' ? row.sender : '对方';
    return `${at} ${who}：${row.text !== '' ? row.text : `[${row.kind}]`}`;
  }

  /** 微信会话调模型前：最近 50 条拼进 system。 */
  private onRequest(request: ChatRequest): void {
    const address = request.session.row.address as Partial<WechatAddress> | undefined;
    if (typeof address?.customer !== 'string' || !address.customer.startsWith('wechat:') || address.account === undefined || address.chat === undefined) return;

    const rows = this.ctx.resources.db.query('SELECT at, from_self, sender, kind, text FROM wechat_messages WHERE account = ? AND chat = ? ORDER BY at DESC, local_id DESC LIMIT ?')
      .all(address.account, address.chat, CONTEXT_MESSAGES) as { at: number; from_self: number; sender: string; kind: string; text: string }[];
    if (rows.length === 0) return;
    request.system.push(`# 这个微信会话最近 ${String(rows.length)} 条聊天记录（旧的在前；“我”是这个微信号自己）\n`
      + rows.reverse().map((row) => this.line(row)).join('\n')
      + `\n更早的用工具 wechat_history 读。你的回复只会存成草稿给人看，不会自动发出去。`);
  }

  /** 工具 wechat_history：库里不够就用 backfill 从微信里补再读。 */
  private async history(session: Session, args: Record<string, unknown>): Promise<string> {
    const address = session.row.address as Partial<WechatAddress> | undefined;
    if (address?.account === undefined || address.chat === undefined) return '这场会话不是微信来的，没有微信聊天记录';

    const skip = Math.max(0, Math.floor(Number(args['skip'] ?? CONTEXT_MESSAGES)) || 0);
    const limit = Math.min(500, Math.max(1, Math.floor(Number(args['limit'] ?? 50)) || 50));
    const db = this.ctx.resources.db;
    const read = () => db.query('SELECT at, from_self, sender, kind, text FROM wechat_messages WHERE account = ? AND chat = ? ORDER BY at DESC, local_id DESC LIMIT ? OFFSET ?')
      .all(address.account!, address.chat!, limit, skip) as { at: number; from_self: number; sender: string; kind: string; text: string }[];
    let rows = read();
    if (rows.length < limit) {
      const oldest = db.query('SELECT MIN(at) AS at FROM wechat_messages WHERE account = ? AND chat = ?').get(address.account, address.chat) as { at: number | null };
      const more = await this.reader.backfill(address.account, address.chat, oldest.at ?? Math.floor(Date.now() / 1000) + 1, limit - rows.length + 10);
      for (const msg of more.messages ?? []) {
        this.save(address.account, address.chat, msg);
      }
      rows = read();
    }
    if (rows.length === 0) return '没有更早的聊天记录了';
    return `从最近第 ${String(skip + 1)} 条往前读了 ${String(rows.length)} 条（旧的在前）：\n${rows.reverse().map((row) => this.line(row)).join('\n')}`;
  }

  /**
   * 回话：只有做完的一轮才发给客户（出错、停下的原因不发给客户）。
   * 自动发的直接发；别的问 approval（动态卡片），没有 approval 留草稿。
   */
  protected send(reply: string, session: Session): void {
    const address = session.row.address as WechatAddress | undefined;
    if (session.row.state !== 'done' || reply.trim() === '' || address === undefined) return;

    //G 只听不发（用户 11-14）：send 没开就只存草稿，不发、不问 approval。
    if (!this.config.send) {
      this.outbox(address, reply, 'draft');
      return;
    }

    const watch = this.ctx.resources.db.query('SELECT auto FROM wechat_watch WHERE account = ? AND chat = ?').get(address.account, address.chat) as
      { auto: number } | null;
    const state = watch?.auto === 1 ? 'sending' : this.approval === undefined ? 'draft' : 'waiting';
    const id = this.outbox(address, reply, state);
    if (state === 'sending') void this.deliver(id);
    if (state !== 'waiting' || this.approval === undefined) return;

    //M 不带 session：approval 会对会话 say 一句“怎么回”，那句话会被发给微信客户。
    this.approval.ask({
      kind: 'wechat-send', title: `发微信给「${address.name}」`, detail: reply, payload: { outbox: id }, bot: session.row.bot,
      card: {
        kind: 'approval', title: `发微信给「${address.name}」`, reason: '这个会话没开自动发，机器人的回复要你点头才发出去',
        items: [{ label: '会话', value: `${address.name}（${address.chat}）` }, { label: '内容', value: reply }],
        risk: { level: 'medium', text: '会真的发到微信，发出去撤不回' },
        buttons: [{ action: 'approve', label: '发送', style: 'primary' }, { action: 'reject', label: '不发', style: 'default' }],
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
    this.filling.add(key);
    const db = this.ctx.resources.db;
    try {
      const row = db.query('SELECT full FROM wechat_sync WHERE account = ? AND chat = ?').get(account, chat) as { full: number | null } | null;
      if (row?.full === 1) return;

      const batch = 500;
      for (let i = 0; i < 40; i++) {
        const oldest = db.query('SELECT MIN(at) AS at FROM wechat_messages WHERE account = ? AND chat = ?').get(account, chat) as { at: number | null };
        const until = oldest.at ?? Math.floor(Date.now() / 1000) + 1;
        const more = await this.reader.backfill(account, chat, until, batch);
        const messages = more.messages ?? [];
        let added = 0;
        for (const msg of messages) {
          if (this.save(account, chat, msg)) added += 1;
        }
        if (messages.length < batch || (added === 0 && messages.length > 0 && Math.min(...messages.map((msg) => msg.create_time)) >= until)) {
          db.query('UPDATE wechat_sync SET full = 1 WHERE account = ? AND chat = ?').run(account, chat);
          return;
        }
        if (messages.length === 0) {
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
    const row = this.ctx.resources.db.query('SELECT full FROM wechat_sync WHERE account = ? AND chat = ?').get(account, chat) as { full: number | null } | null;
    if (row === null) {
      await this.syncChats(account, [{ chat, name, since: null, at: 0 }]);
    }
    await this.backfillAll(account, chat);
  }

  /**
   * 人手点“让 AI 回复”：对已监听会话立刻让机器人根据最近聊天记录起草一条，只存草稿，不发送。
   * @throws 没勾监听时抛错。
   */
  async draftReply(account: string, chat: string): Promise<OutItem | null> {
    const watch = this.ctx.resources.db.query('SELECT name FROM wechat_watch WHERE account = ? AND chat = ?').get(account, chat) as { name: string } | null;
    if (watch === null) throw new Error('请先勾选监听，才能让 AI 起草回复');

    const before = Number((this.ctx.resources.db.query('SELECT IFNULL(MAX(id), 0) AS id FROM wechat_outbox WHERE account = ? AND chat = ?').get(account, chat) as { id: number }).id);
    const address: WechatAddress = { account, chat, name: watch.name || chat, customer: `wechat:${chat}` };
    await this.ctx.bots.receive(this.name, this.config.bot, '请根据这个会话的最近聊天记录，起草一条合适的回复。只起草，不要向对方发送。', address);
    return this.ctx.resources.db.query('SELECT * FROM wechat_outbox WHERE account = ? AND chat = ? AND id > ? ORDER BY id DESC LIMIT 1')
      .get(account, chat, before) as OutItem | null;
  }

  /** 记一条发件，交回号。 */
  outbox(address: Pick<WechatAddress, 'account' | 'chat' | 'name'>, text: string, state: string): number {
    const sql = 'INSERT INTO wechat_outbox (account, chat, name, text, state, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)';
    return Number(this.ctx.resources.db.query(sql).run(address.account, address.chat, address.name, text, state, '', Date.now()).lastInsertRowid);
  }

  /** 改发件的状态。 */
  mark(id: number, state: string, note = ''): void {
    this.ctx.resources.db.query('UPDATE wechat_outbox SET state = ?, note = ? WHERE id = ?').run(state, note, id);
  }

  /** 发一条发件。只发监听名单里的会话；结果写回发件表。 */
  async deliver(id: number): Promise<void> {
    const item = this.ctx.resources.db.query('SELECT * FROM wechat_outbox WHERE id = ?').get(id) as OutItem | null;
    if (item === null) return;
    //G 只听不发：send 没开，任何路径（自动发、同意、页面按钮）都到不了下面的发送。
    if (!this.config.send) return this.mark(id, 'draft', '只听不发：没有发出去');

    const watched = this.ctx.resources.db.query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ?').get(item.account, item.chat);
    if (watched === null) return this.mark(id, 'failed', '会话不在监听名单，不发');

    this.mark(id, 'sending');
    const nickname = this.reader.accounts().find((acc) => acc.id === item.account)?.nickname ?? item.account;
    try {
      const result = await this.sender.send({ account: item.account, chat: item.chat, name: item.name, nickname }, item.text, `jmbots-wechat-${String(id)}`);
      this.mark(id, result['confirmed'] === true ? 'sent' : 'unconfirmed', String(result['status'] ?? ''));
    } catch (error) {
      this.mark(id, 'failed', textModule.messageOf(error));
    }

    //T 跟踪：发了一条微信。
    const after = this.ctx.resources.db.query('SELECT state, note FROM wechat_outbox WHERE id = ?').get(id) as { state: string; note: string };
    const vars = { 发件号: id, 会话: item.name, 结果: after.state, 说明: after.note.slice(0, 80) };
    this.ctx.emit('trace', 'Wechat.deliver', '后台发一条微信，回读确认', 'sender.send(target, text, requestId)', vars);
  }

  /** 待确认定了：同意就发，拒绝记下。 */
  onDecided(pending: Pending): void {
    if (pending.kind !== 'wechat-send') return;

    const id = (pending.payload as { outbox: number }).outbox;
    if (pending.state === 'approved') void this.deliver(id);
    else this.mark(id, 'rejected', pending.by ?? '');
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
 * @throws bot 不在名单、interval_ms 不是非负整数时抛错。
 */
export function checkConfig(ctx: cordis.Context, written: unknown): WechatConfig {
  const own = (typeof written === 'object' && written !== null ? written : {}) as Record<string, unknown>;
  const bot = own['bot'] ?? ctx.bots.list()[0]?.name;
  if (typeof bot !== 'string' || ctx.bots.get(bot) === undefined) throw new Error('wechat 插件的 bot 要写机器人名单里有的名字');

  const intervalMs = own['interval_ms'] ?? 3000;
  if (!Number.isInteger(intervalMs) || (intervalMs as number) < 0) throw new Error('wechat 插件的 interval_ms 要写成非负整数');

  const root = path.resolve(ctx.resources.root, typeof own['root'] === 'string' ? own['root'] : 'program/wechat');
  const pick = (key: string, fallback: string): string => typeof own[key] === 'string' ? path.resolve(root, own[key]) : fallback;
  return {
    bot, root, intervalMs: intervalMs as number,
    python: pick('python', path.join(root, 'runtime', 'env', 'python', 'python.exe')),
    ocrPython: pick('ocr_python', path.join(root, 'runtime', 'env', 'ocr', 'python', 'python.exe')),
    aobwUrl: typeof own['aobw_url'] === 'string' ? own['aobw_url'].replace(/\/+$/u, '') : 'http://127.0.0.1:30010',
    lockFile: pick('lock_file', defaultLock(root)),
    atNames: Array.isArray(own['at_names']) ? own['at_names'].map(String).join(',') : '',
    chatLimit: Number.isInteger(own['chat_limit']) && (own['chat_limit'] as number) > 0 ? own['chat_limit'] as number : 5000,
    send: own['send'] === true,
  };
}


/**
 * 挂上微信：建渠道、登记页面和接口；approval 来了才接卡片。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins 段里写给它的：{ bot, root?, python?, ocr_python?, aobw_url?, lock_file?, interval_ms?, at_names?, chat_limit?, send? }。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  const wechat = new Wechat(ctx, checkConfig(ctx, config));
  page.routes(ctx.http, ctx.resources.db, wechat);
  void ctx.inject(['approval'], (sub) => {
    wechat.approval = sub.approval;
    sub.on('approval/decided', (pending) => wechat.onDecided(pending as Pending)); // feishu 那边把事件声明成了 PendingLike
    sub.effect(() => () => {
      wechat.approval = undefined;
    });
  });
}
