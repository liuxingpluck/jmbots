/**
 * 收件表 web_messages 和网页的时间线：一条消息给网页的样子、时间线（分页、取变化）、按号补取、搜索。
 * HTTP 来的、别的渠道（飞书、命令行）来的消息都记在这张表里，一条消息一行，回话追加在它的 replies 里。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import type { Session, SessionMeta, SessionState } from '../../Sessions.ts';
import * as checks from '../../utils/Checks.ts';
import * as mime from '../../utils/Mime.ts';
import * as utils from '../../utils/index.ts';
import * as traceModule from './Trace.ts';
import * as failureModule from '../../utils/Failure.ts';


/** 回话清单里的一句（存进 replies 列的 JSON）。 */
export interface StoredReply {
  /** 追加的时刻，毫秒。 */
  at: number;
  /** 哪场会话说的。 */
  sessionId: string;
  /** 说了什么。 */
  text: string;
  /** 追加时算好的生成依据。 */
  generation: traceModule.Generation;
  /** 前台从收到消息到交出或自己说完，毫秒；旧回话可能没有。 */
  frontMs?: number;
  /** 后台从接手到这条回复，毫秒；没有后台或旧回话就没有。 */
  workMs?: number;
  /** 标准语音回复的幂等键，旧记录和其他渠道可省略。 */
  replyKey?: string;
  /** 语音回复是否得到浏览器实际播放的回执。 */
  spoken?: boolean;
}


/** 收件表的一行，读出来以后的样子。 */
export interface MessageRecord {
  id: number;
  bot: string;
  channel: string;
  source: string;
  /** 别的渠道的回话地址 JSON；HTTP 的是 null。 */
  address: string | null;
  text: string;
  /** 被回复的收件消息号。 */
  reply_to: number | null;
  /** 第一句回话的会话；还没回话是 null。 */
  sessionId: string | null;
  status: 'taken' | 'replied';
  replies: StoredReply[];
  createdAt: number;
  updatedAt: number;
  /** 属于哪个聊天（CHAT_SQL 算的）：飞书 chatId、微信 chat、命令行 cli:本机、网页 http:本机。 */
  chat: string;
}


/** 记一行要给的东西。 */
export interface NewMessage {
  bot: string;
  channel: string;
  source: string;
  text: string;
  address: string | null;
  reply_to?: number;
  /** 别的渠道的标准消息号（进来的渠道事件的 messageId）；网页自己的、直接经 bots.receive 入站的不写。 */
  source_id?: string;
  /** 语音首个字幕的时间，其他入口默认取写入时间。 */
  createdAt?: number;
}


/** GET /api/channels 的一个渠道（web/src/Chat/ChannelTabs.tsx 的 parseChannelsResponse 照它读）。 */
export interface ChannelSummary {
  /** 渠道名：http、feishu、wechat、cli…… */
  id: string;
  /** 显示名：网页、飞书、微信、命令行；没列的用渠道名。 */
  label: string;
  /** 这个机器人在这个渠道收过几条。 */
  count: number;
  /** 最近一条的时刻，毫秒；没有是 0。 */
  updatedAt: number;
  /** 聊天：新的在前。 */
  chats: { id: string; label: string; count: number; updatedAt: number }[];
}


/** 库里一行的原样（列名是下划线写法）。 */
interface RawRow {
  reply_to: number | null;
  id: number; bot: string; channel: string; source: string; address: string | null; text: string;
  session_id: string | null; status: 'taken' | 'replied'; replies: string; created_at: number; updated_at: number;
  /** ROW_SQL 带出来的聊天号。 */
  chat: string;
}


/** 时间线默认几条、最多几条。 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 搜索每组默认几条、最多几条。 */
const SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

/** 搜索片段：命中处前后各几个字。 */
const SNIPPET_AROUND = 40;

/** 网页发的话 source 是它（web/src/Api.ts:325 的 from）。 */
const WEB_SOURCE = 'web';

/**
 * 一行属于哪个聊天（SQL 表达式，筛选、分组、取行都用它，只写这一处）：
 * 飞书地址的 chatId、微信地址的 chat、命令行地址的 customer（cli:本机）；网页自己的（地址空）是 http:本机。
 * 旧地址损坏时视为缺少聊天号，避免 SQLite 中断整页读取。
 */
const CHAT_SQL = "COALESCE(CASE WHEN json_valid(address) THEN COALESCE(json_extract(address, '$.chatId'),"
  + " json_extract(address, '$.chat'), json_extract(address, '$.customer')) END,"
  + " CASE WHEN channel = 'http' THEN 'http:本机' END, '')";

/** 取整行，连同它属于哪个聊天（chat 列）。 */
const ROW_SQL = `SELECT *, ${CHAT_SQL} AS chat FROM web_messages`;

/** 渠道的显示名；没列的用渠道名本身。 */
const CHANNEL_LABELS: Record<string, string> = { http: '网页', feishu: '飞书', wechat: '微信', cli: '命令行' };

/** 会话标题取总结的前几个字。 */
const TITLE_MAX = 30;

/** 补取一次最多几个号。 */
const RESOLVE_MAX = 100;


/**
 * 算这一句回话的前台、后台耗时。
 * 后台会话以它本轮最近一条用户消息（交办进来的那句）为接手时刻。
 * @param session 说这句话的会话。
 * @param createdAt 原消息收到的时刻。
 * @param now 回话追加的时刻。
 */
function getElapsed(session: Session, createdAt: number, now: number): { frontMs: number; workMs?: number } {
  if (session.row.kind === 'work') {
    const lastUser = session.row.messages.findLast((message) => message.role === 'user');
    const start = lastUser?.timestamp ?? now;
    return { frontMs: Math.max(0, start - createdAt), workMs: Math.max(0, now - start) };
  }
  return { frontMs: Math.max(0, now - createdAt) };
}


/**
 * 会话标题：总结的前 30 字；还没总结写“会话 <号>”。
 * @param meta 会话记录。
 */
export function title(meta: SessionMeta): string {
  const summary = (meta.summary ?? '').trim();
  if (summary === '') return `会话 ${meta.id}`;

  return summary.slice(0, TITLE_MAX);
}


/**
 * 会话状态换成网页认的三种：running → running，done/stopped → idle，failed → error。
 * @param state 骨架的状态。
 */
export function getStatus(state: SessionState): 'running' | 'idle' | 'error' {
  if (state === 'running') return 'running';

  if (state === 'failed') return 'error';

  return 'idle';
}


/**
 * 会话的两个文件（files-mirror 写的，总览第 3 节待补约定第 2 条）：运行时目录 bots/<机器人>/sessions/<会话号>/对话.md、session.json。
 * 只拼路径、查在不在，在就给绝对路径，不在给 ''（没挂 files-mirror 或还没写）。
 * @param root 运行时目录。
 * @param meta 会话记录。
 */
export function sessionFiles(root: string, meta: SessionMeta): { md: string; json: string } {
  const dir = path.join(root, 'bots', meta.bot, 'sessions', meta.id);
  const md = path.join(dir, '对话.md');
  const json = path.join(dir, 'session.json');
  //M 文件已生成时才提供网页可以打开的路径。
  let mdFile = '';
  if (fs.existsSync(md)) {
    mdFile = md;
  }
  let jsonFile = '';
  if (fs.existsSync(json)) {
    jsonFile = json;
  }
  return { md: mdFile, json: jsonFile };
}


/**
 * 认出文字里的附件：@绝对路径（带空格时是 @"路径"），查大小。
 * @param text 原话或回话。
 * @returns 附件；文件不在了 size 是 null。同一个路径只算一次。
 */
export async function attachments(text: string): Promise<{ path: string; name: string; kind: mime.FileKind; size: number | null }[]> {
  const found: string[] = [];
  for (const match of text.matchAll(/@"([^"]+)"|@([^\s，。、；：！？（）【】《》「」"'<>|]+)/gu)) {
    //M 引号里的原样取；没引号的到空白或中文标点为止，再去掉结尾的英文标点。只认绝对路径（盘符或 / 开头），别的 @ 是普通文字。
    const raw = match[1] ?? (match[2] ?? '').replace(/[.,;!?)\]>`]+$/u, '');
    if (/^([A-Za-z]:[\\/]|\/)/u.test(raw) && !found.includes(raw)) found.push(raw);
  }
  return Promise.all(found.map(async (file) => {
    const stat = await fsp.stat(file).catch(() => undefined);
    return { path: file, name: path.basename(file.replace(/\\/gu, '/')), kind: mime.getFileKind(file), size: stat?.size ?? null };
  }));
}


/**
 * 搜索结果的片段：命中处前后各 40 字，截掉的一头加“…”，换行压成空格；没命中给开头一段。
 * @param text 文字。
 * @param keyword 关键字。
 */
export function snippet(text: string, keyword: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const at = flat.toLowerCase().indexOf(keyword.toLowerCase());
  //M 默认预览开头，命中时截取命中位置前后的文字。
  let start = 0;
  let end = Math.min(flat.length, SNIPPET_AROUND * 2);
  if (at >= 0) {
    start = Math.max(0, at - SNIPPET_AROUND);
    end = Math.min(flat.length, at + keyword.length + SNIPPET_AROUND);
  }

  //M 只在内容被截去的那一端补省略号。
  let preview = flat.slice(start, end);
  if (start > 0) {
    preview = '…' + preview;
  }
  if (end < flat.length) {
    preview += '…';
  }
  return preview;
}


/**
 * 文字里有没有这个关键字（不分大小写）。
 * @param text 文字。
 * @param keyword 关键字。
 */
function includes(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}


/** 收件表和时间线。 */
export class Timeline {
  /**
   * 初始化收件表及索引，保留已有的数据。
   * @param ctx web-api 的 ctx：用 resources.db、sessions、bots，发通知。
   */
  constructor(private readonly ctx: cordis.Context) {
    const db = ctx.resources.db;
    //M 新装时一次建齐引用列和来源号，保存原始消息关联。
    const create = 'CREATE TABLE IF NOT EXISTS web_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + ' channel TEXT NOT NULL, source TEXT NOT NULL, address TEXT, text TEXT NOT NULL, session_id TEXT,'
      + " status TEXT NOT NULL, replies TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,"
      + ' updated_at INTEGER NOT NULL, reply_to INTEGER, source_id TEXT)';
    db.exec(create);

    //M 按来源匹配跨渠道回话，按机器人、更新时间和地址读取时间线。
    db.exec('CREATE INDEX IF NOT EXISTS web_messages_source ON web_messages (source_id, bot)');
    db.exec('CREATE INDEX IF NOT EXISTS web_messages_bot ON web_messages (bot, id)');
    db.exec('CREATE INDEX IF NOT EXISTS web_messages_updated ON web_messages (bot, updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS web_messages_address ON web_messages (channel, address)');
  }

  /**
   * 记一行，发通知 web-api/received（流水 journal 听它记 message.received）。
   * @param input 机器人、渠道、来源、话、回话地址。
   * @returns 消息号。
   */
  insert(input: NewMessage): number {
    //M 把入站原文和来源写入收件表，保留新编号供会话绑定与通知使用。
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const sql = 'INSERT INTO web_messages (bot, channel, source, address, text, session_id, status, replies,'
      + ' created_at, updated_at, reply_to, source_id)'
      + " VALUES (?, ?, ?, ?, ?, NULL, 'taken', '[]', ?, ?, ?, ?)";
    const row = [
      input.bot, input.channel, input.source, input.address, input.text,
      createdAt, now, input.reply_to ?? null, input.source_id ?? null,
    ];
    //M 保存可排序的原话时刻和用于增量轮询的写入时刻。
    const result = this.ctx.resources.db.query(sql).run(...row);
    const id = Number(result.lastInsertRowid);

    //T 跟踪：收件表记下一条。sourceId 是渠道的标准消息号（没有就不带），journal 靠它把收件号和渠道那几行接上。
    const vars = {
      messageId: id, sourceId: input.source_id, bot: input.bot, channel: input.channel,
      table: 'web_messages', status: 'taken', length: input.text.length,
    };
    this.ctx.emit('trace', 'Timeline.insert', 'trace.timeline.insert', 'INSERT INTO web_messages', vars);
    const { bot, channel, source, text } = input;
    const received = { id, bot, channel, source, text, at: createdAt };
    this.ctx.emit('web-api/received', received);
    return id;
  }

  /**
   * 删一行：推给机器人失败时，收下的那条不留。
   * @param id 消息号。
   */
  remove(id: number): void {
    //M 撤掉未能分派的收件记录，避免时间线留下未接收的消息。
    this.ctx.resources.db.query('DELETE FROM web_messages WHERE id = ?').run(id);
  }

  /**
   * 取一条。
   * @param id 消息号。
   * @returns 没有是 undefined。
   */
  get(id: number): MessageRecord | undefined {
    //M 按编号取一条消息，并把库中的行转为时间线内部记录。
    const raw = this.ctx.resources.db.query(`${ROW_SQL} WHERE id = ?`).get(id) as RawRow | null;
    if (raw === null) return undefined;

    //M 只把已查到的库行转换为内部记录。
    return this.parse(raw);
  }

  /**
   * 按标准消息号和机器人找那一行：别的渠道的回话照它精确挂回原话（同一条消息给几个机器人时各一行）。
   * @param bot 机器人。
   * @param sourceId 标准消息号（进来的渠道事件的 messageId）。
   * @returns 消息号；找不到是 undefined（插件挂上之前收的、直接入站而未记标准消息号的）。
   */
  findBySource(bot: string, sourceId: string): number | undefined {
    //M 用标准消息号和目标机器人反查收件编号，给跨渠道回话定位原件。
    const sql = 'SELECT id FROM web_messages WHERE source_id = ? AND bot = ? ORDER BY id DESC LIMIT 1';
    const found = this.ctx.resources.db.query(sql).get(sourceId, bot) as { id: number } | null;
    return found?.id;
  }

  /**
   * 把一条标成回完（这一轮收尾了，或审批直回这种没有模型轮的）。
   * @param id 消息号。
   * 副作用：写库。
   */
  markReplied(id: number): void {
    //M 将已收尾的消息标为回完，更新时间供网页增量轮询发现变化。
    const sql = 'UPDATE web_messages SET status = ?, updated_at = ? WHERE id = ?';
    this.ctx.resources.db.query(sql).run('replied', Date.now(), id);
  }

  /**
   * 记下这条进了哪场会话（还没记过才记）。
   * @param id 消息号。
   * @param sessionId 会话号。
   * 副作用：写库。
   */
  bindSession(id: number, sessionId: string): void {
    //M 记录第一次认领，同时把收件号和会话号交给流水，供回复之前查询轨迹。
    const sql = 'UPDATE web_messages SET session_id = ? WHERE id = ? AND session_id IS NULL';
    const updated = this.ctx.resources.db.query(sql).run(sessionId, id);
    if (updated.changes === 0) return;

    const vars = { messageId: id, session: sessionId, table: 'web_messages' };
    this.ctx.emit('trace', 'Timeline.bindSession', 'trace.timeline.bindSession', 'UPDATE web_messages SET session_id', vars);
  }

  /**
   * 追加一句回话与生成依据。标准语音回复同时保存去重键和播放结果。
   * @param id 消息号。
   * @param session 回复会话，审批等程序直回不一定有会话。
   * @param text 说了什么。
   * @param delivery 标准语音回复幂等键与实际播放状态。
   */
  reply(id: number, session: Session | undefined, text: string, delivery?: { key: string; spoken: boolean }): void {
    //G 原收件记录已不存在时直接结束，避免把回话加到其他消息。
    const record = this.get(id);
    if (record === undefined) return;

    //G 重放回执保留原来的文字、时刻和播放状态。
    if (delivery !== undefined && record.replies.some((reply) => reply.replyKey === delivery.key)) return;

    const now = Date.now();
    const sessionId = session?.id ?? record.sessionId;
    const ended = session?.row.state !== 'running';
    //G 空话不追加气泡，会话已结束仍把状态改成 replied。
    if (text === '') {
      if (!ended) return;

      const sql = 'UPDATE web_messages SET session_id = COALESCE(session_id, ?), status = ?, updated_at = ?'
        + ' WHERE id = ?';
      const status = 'replied';
      //M 结束时没有新正文，只标记该条收件已经回完。
      this.ctx.resources.db.query(sql).run(sessionId, status, now, id);
      record.status = 'replied';
      return;
    }

    //M 保存原会话的生成依据，程序直回的生成依据保留为程序。
    const generation = traceModule.getGeneration(session?.row, text);
    const reply: StoredReply = { at: now, sessionId: sessionId ?? '', text, generation };
    if (session !== undefined) {
      const elapsed = getElapsed(session, record.createdAt, now);
      Object.assign(reply, elapsed);
    }
    if (delivery !== undefined) {
      reply.replyKey = delivery.key;
      reply.spoken = delivery.spoken;
    }
    //M 追加通过幂等检查的回复，供下一次网页查询读取。
    record.replies.push(reply);
    let status = record.status;
    if (ended) {
      status = 'replied';
    }
    //M 写入整份回话清单与新状态，供轮询和追溯共同读取。
    const sql = 'UPDATE web_messages SET replies = ?, session_id = COALESCE(session_id, ?), status = ?, updated_at = ?'
      + ' WHERE id = ?';
    const replies = JSON.stringify(record.replies);
    this.ctx.resources.db.query(sql).run(replies, sessionId, status, now, id);

    //T 跟踪：追加一句回话。
    const vars = {
      messageId: id, session: sessionId, table: 'web_messages', status,
      replyCount: record.replies.length, replyLength: text.length, length: text.length, state: status,
    };
    this.ctx.emit('trace', 'Timeline.reply', 'trace.timeline.reply', 'UPDATE web_messages SET replies', vars);
    if (session !== undefined) {
      //M 依赖会话的订阅者只接收可以打开会话的回话通知。
      const event = { messageId: id, replyIndex: record.replies.length - 1, session, text, at: now };
      this.ctx.emit('web-api/replied', event);
    }
  }

  /** 渠道和对方的展示标签，地址仍由各渠道维护。 */
  peer(record: MessageRecord): string {
    if (record.channel === 'http') return formatHttpPeer(record);

    if (record.channel === 'voice') return '语音';

    if (record.channel !== 'feishu' && record.channel !== 'wechat') return record.channel;

    //G 时间线也要展示地址损坏的旧消息，无法解析时按没有地址处理。
    let address: unknown;
    if (record.address !== null) {
      try {
        address = JSON.parse(record.address);
      } catch {
        address = undefined;
      }
    }

    //M 两个渠道都优先显示地址里存的名称。
    const name = utils.getStringField(address, 'name');
    if (record.channel === 'wechat') {
      //M 微信里没存名称时显示聊天号。
      const chat = utils.getStringField(address, 'chat');
      const who = name || chat;
      return `微信·${who}`;
    }

    //M 飞书用聊天类型区分群和私聊，再从地址里取可显示的名称。
    const chatType = utils.getStringField(address, 'chatType');
    let kind = '私聊';
    if (chatType === 'group') {
      kind = '群';
    }

    const chatName = utils.getStringField(address, 'chatName');
    const userName = utils.getStringField(address, 'userName');
    const who = name || chatName || userName;
    if (who !== '') return `飞书·${kind}·${who}`;

    //M 没有名称时用用户编号的末四位，缺编号时只显示聊天类型。
    const openId = utils.getStringField(address, 'openId');
    if (openId === '') return `飞书·${kind}`;

    const suffix = openId.slice(-4);
    return `飞书·${kind}·${suffix}`;
  }

  /** 一条收件消息给网页的样子，引用内容独立于正文返回。 */
  async view(record: MessageRecord): Promise<Record<string, unknown>> {
    //M 按引用编号加载原消息，供网页单独显示引用内容。
    let quoted: MessageRecord | undefined;
    if (record.reply_to !== null) {
      quoted = this.get(record.reply_to);
    }

    //M 为每句回话查询会话摘要，给网页提供标题和对话文件入口。
    const replies = await Promise.all(record.replies.map(async (item) => {
      const meta = this.ctx.sessions.find({ id: item.sessionId })[0];
      let sessionTitle = `会话 ${item.sessionId}`;
      let file = '';
      if (meta !== undefined) {
        sessionTitle = title(meta);
        const files = sessionFiles(this.ctx.resources.root, meta);
        file = files.md;
      }

      //M 旧回话没有单独的后台耗时，显示从收件到回复的总时长。
      let frontMs = item.frontMs;
      if ((frontMs === undefined || frontMs === null) && item.workMs === undefined) {
        frontMs = Math.max(0, item.at - record.createdAt);
      }
      return {
        at: item.at,
        session: {
          id: item.sessionId,
          title: sessionTitle,
          file,
          kind: meta?.kind,
        },
        text: item.text,

        //M 提取回话中的附件供网页单独显示。
        attachments: await attachments(item.text),
        generation: item.generation,

        //M 用原收件编号标记这句回话的来源，供追溯定位。
        association: this.association(record.id),
        frontMs,
        workMs: item.workMs,
        spoken: item.spoken,
      };
    }));

    //M 引用原件存在时给网页单独的展示摘要。
    let replyTo: { id: number; peer: string; text: string } | null = null;
    if (quoted !== undefined) {
      const peer = this.peer(quoted);
      replyTo = { id: quoted.id, peer, text: quoted.text };
    }

    //M 对端名供两处展示共用，同一条地址只解析一次。
    const peer = this.peer(record);

    //M 组装网页时间线要显示的消息资料，包括各渠道的聊天名称和引用摘要。
    return {
      id: record.id,
      bot: record.bot,
      channel: record.channel,
      peer,
      chat: record.chat,
      chatLabel: peer,
      reply_to: record.reply_to,
      replyTo,
      source: record.source,
      text: record.text,
      status: record.status,
      sessionId: record.sessionId,
      file: '',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,

      //M 从原话提取附件，供网页独立展示文件。
      attachments: await attachments(record.text),
      replies,
      dispatch: null,
    };
  }

  /**
   * 回话的来源：只有它追加在的这条消息。
   * @param id 消息号。
   */
  association(id: number): { messageIds: number[]; scope: 'target'; source: string } {
    return { messageIds: [id], scope: 'target', source: '这句回话追加在这条消息上' };
  }

  /**
   * 在 Fastify 作用域里登记时间线、补取、搜索、取一条消息四个接口。
   * @param scope index.ts 开的作用域（出错统一回 { error }）。
   */
  routes(scope: fastify.FastifyInstance): void {
    type Query = { Querystring: Record<string, string | undefined> };
    //M 为网页登记收件列表、原消息补取和全文搜索入口。
    scope.get<Query>('/api/messages', async (request) => this.list(request.query));
    scope.get<Query>('/api/messages/resolve', async (request) => this.resolve(request.query));
    scope.get<Query>('/api/search', async (request) => this.search(request.query));

    //M 为渠道选择器列出指定机器人的聊天清单。
    scope.get<Query>('/api/channels', async (request) => {
      const bot = this.getBot(request.query['bot']);
      return { channels: this.getChannels(bot) };
    });

    //M 给网页单条消息入口接上按编号读取和展示逻辑。
    scope.get<{ Params: { id: string } }>('/api/messages/:id', async (request) => {
      //G 消息号找不到时交回 404，结束查询。
      const record = this.get(Number(request.params.id));
      if (record === undefined) throw new failureModule.Failure(404, `没有这条消息：${request.params.id}`);

      //M 把读到的记录展开成网页需要的完整消息。
      return this.view(record);
    });
  }

  /**
   * GET /api/messages：时间线。不写 after 是往前翻（before 之前的 limit 条，多取一条看还有没有更早的）；
   * 写了 after 是取变化（updatedAt 不早于它的全给）。
   * @param query bot、before、after、limit、origin。
   */
  private async list(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    //G 先确定查询的机器人，没有默认机器人时直接交回空页。
    const bot = this.getBot(query['bot']);
    if (bot === undefined) return { messages: [], hasMore: false, cursor: 0 };

    //M 整数参数在入口查一次（由 utils/Checks.ts 的 checkCount 校验），写错了回 400；limit 没写按默认，超了按上限。
    const before = checks.checkCount(query['before'], 'before');
    const after = checks.checkCount(query['after'], 'after');
    const wantedLimit = checks.checkCount(query['limit'], 'limit') ?? DEFAULT_LIMIT;
    const limit = Math.min(wantedLimit, MAX_LIMIT);

    //G 拒绝无法映射到消息来源筛选条件的参数。
    const origin = query['origin'];
    if (origin !== undefined && origin !== '' && origin !== 'web' && origin !== 'other') {
      throw new failureModule.Failure(400, 'origin 要是 web 或 other');
    }

    //M 拼条件：机器人；origin=web 只要网页发的，other 只要别的（右栏“消息”）。
    let where = 'bot = ?';
    const values: (string | number)[] = [bot];
    if (origin === 'web') {
      where += ' AND source = ?';
      values.push(WEB_SOURCE);
    }
    if (origin === 'other') {
      where += ' AND source != ?';
      values.push(WEB_SOURCE);
    }
    //M channel 只认认得的渠道（有显示名的、现在挂着的）；chat 是 /api/channels 给的聊天号，要和 channel 一起写。
    const channel = query['channel'];
    if (channel !== undefined && channel !== '') {
      const known = new Set([...Object.keys(CHANNEL_LABELS), ...this.ctx.bots.channelNames()]);
      if (!known.has(channel)) {
        throw new failureModule.Failure(400, `channel 要是这几个之一：${[...known].join('、')}`);
      }
      where += ' AND channel = ?';
      values.push(channel);
    }
    //G 聊天号依赖所属渠道，缺少渠道时拒绝含糊的筛选条件。
    const chat = query['chat'];
    if (chat !== undefined && chat !== '') {
      if (channel === undefined || channel === '') throw new failureModule.Failure(400, 'chat 要和 channel 一起写');

      where += ` AND ${CHAT_SQL} = ?`;
      values.push(chat);
    }
    //M 增量查询按更新时间筛选，结果按收件编号排序。
    let order = ' ORDER BY id';
    if (after !== undefined) {
      where += ' AND updated_at >= ?';
      values.push(after);
    }

    //M 往前翻页时倒序多取一条，检查是否还有更早消息。
    if (after === undefined) {
      if (before !== undefined) {
        where += ' AND id < ?';
        values.push(before);
      }
      order = ' ORDER BY id DESC LIMIT ?';
      values.push(limit + 1);
    }

    //M 执行选定的查询，倒序分页结果恢复成时间线顺序。
    const sql = `${ROW_SQL} WHERE ${where}${order}`;
    const rows = this.ctx.resources.db.query(sql).all(...values) as RawRow[];
    if (after === undefined) {
      rows.reverse();
    }

    //M 去掉探测下一页时多取的记录，把当前页展开成网页消息。
    const hasMore = after === undefined && rows.length > limit;
    if (hasMore) {
      rows.shift();
    }
    //M 按网页视图展开当前页的消息与回话。
    const shown = rows.map((raw) => this.parse(raw));
    const messages = await Promise.all(shown.map((record) => this.view(record)));
    const cursor = Math.max(after ?? 0, ...shown.map((record) => record.updatedAt));
    return { messages, hasMore, cursor };
  }

  /**
   * GET /api/messages/resolve：按号补取。
   * @param query bot（必填）、ids（逗号分隔，最多 100 个正整数）。
   */
  private async resolve(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    //G 按号补取必须锁定一个已注册的机器人。
    const bot = query['bot'];
    if (bot === undefined || bot === '') throw new failureModule.Failure(400, '补取原消息必须写 bot');
    if (botUtils.getBotConfig(this.ctx.resources.raw, bot) === undefined) throw new failureModule.Failure(400, `没有这个机器人：${bot}`);

    //G 检查编号清单和上限，再按编号补取记录。
    const tokens = (query['ids'] ?? '').split(',');
    if (tokens.length > RESOLVE_MAX || tokens.some((id) => !/^[1-9]\d{0,15}$/u.test(id))) {
      throw new failureModule.Failure(400, 'ids 要是最多 100 个逗号分隔的正整数');
    }
    const records: MessageRecord[] = [];
    const missingIds: number[] = [];
    for (const id of new Set(tokens.map(Number))) {
      //M 逐个补取去重后的编号，按机器人归属区分记录和缺失号。
      const record = this.get(id);
      if (record === undefined || record.bot !== bot) {
        missingIds.push(id);
        continue;
      }
      records.push(record);
    }

    //M 将查到的记录展开为完整消息，与缺失编号一起返回。
    return { messages: await Promise.all(records.map((record) => this.view(record))), missingIds };
  }

  /**
   * GET /api/search：搜消息原话和回话、会话标题和总结。
   * @param query q（必填）、bot（不写搜全部）、limit（每组几条）。
   */
  private search(query: Record<string, string | undefined>): Record<string, unknown> {
    //G 拒绝空关键字，避免无条件扫描收件和会话。
    const keyword = (query['q'] ?? '').trim();
    if (keyword === '') throw new failureModule.Failure(400, '要写搜什么：?q=关键字');

    //G 搜索指定机器人时先检查它存在，空参数则查全部。
    const bot = query['bot'] || undefined;
    if (bot !== undefined && botUtils.getBotConfig(this.ctx.resources.raw, bot) === undefined) throw new failureModule.Failure(400, `没有这个机器人：${bot}`);

    //M limit 在入口查一次（utils/Checks.ts 的 checkCount），没写按默认，超了按上限。
    const wantedLimit = checks.checkCount(query['limit'], 'limit') ?? SEARCH_LIMIT;
    const limit = Math.min(wantedLimit, MAX_SEARCH_LIMIT);

    //M 消息：库里先用 LIKE 粗筛（replies 列是 JSON，可能误中生成依据里的字），再逐条看原话、回话原文，新的在前。
    const escaped = keyword.replace(/[\\%_]/gu, (char) => `\\${char}`);
    const like = `%${escaped}%`;
    const sql = `${ROW_SQL} WHERE (text LIKE ? ESCAPE '\\' OR replies LIKE ? ESCAPE '\\')`;
    const values = [like, like];
    let filter = '';
    if (bot !== undefined) {
      filter = ' AND bot = ?';
      values.push(bot);
    }
    const querySql = sql + filter + ' ORDER BY id DESC LIMIT 1000';
    const messages: Record<string, unknown>[] = [];
    //M 对库里粗筛到的候选逐条核对，避免把回话元数据当成命中。
    for (const raw of this.ctx.resources.db.query(querySql).all(...values) as RawRow[]) {
      if (messages.length >= limit) break;
      const record = this.parse(raw);
      let hit = 'text';
      let matched = record.text;
      if (!includes(record.text, keyword)) {
        const hitReply = record.replies.find((item) => includes(item.text, keyword));
        if (hitReply === undefined) continue;

        hit = 'reply';
        matched = hitReply.text;
      }

      //M 用实际命中的文字生成结果预览。
      const preview = snippet(matched, keyword);
      messages.push({
        id: record.id, bot: record.bot, channel: record.channel, source: record.source, createdAt: record.createdAt,
        file: '', sessionId: record.sessionId, hit,
        snippet: preview,
      });
    }

    //M 会话：没有 parent 的（小会话不给网页看），标题或总结命中的，最近动过的在前。
    const filterSessions: { bot?: string } = {};
    if (bot !== undefined) {
      filterSessions.bot = bot;
    }

    //M 只交回标题或总结命中的主会话。
    const sessions = this.ctx.sessions.find(filterSessions)
      .filter((meta) => meta.parent === undefined && (includes(title(meta), keyword) || includes(meta.summary ?? '', keyword)))
      .slice(0, limit)
      .map((meta) => ({
        id: meta.id, bot: meta.bot, workspace: 'workspace', title: title(meta), snippet: snippet(meta.summary ?? '', keyword),
        updatedAt: meta.updatedAt, file: sessionFiles(this.ctx.resources.root, meta).md,
      }));
    return { messages, sessions };
  }

  /**
   * GET /api/channels：现在挂着的渠道，每个渠道下列出这个机器人收过消息的聊天（名字、最近一条的时间、条数），新的在前。
   * 网页自己（http）总有“网页”这一项，没说过话也列。只给本人：HTTP 统一查令牌（本机、免令牌地址、带对令牌的），进得来的就是本人，
   * 群里的外人（飞书 guest）没有 HTTP 入口；外人只能看自己聊天的限制在历史工具、记忆那边。
   * @param bot 机器人名；一个机器人都没有是 undefined（清单里聊天都是空的）。
   * @returns [{ id: 渠道名, label: 显示名, count, updatedAt, chats: [{ id: 聊天号, label: 聊天名, count, updatedAt }] }]。
   */
  getChannels(bot: string | undefined): ChannelSummary[] {
    //M 先按挂着的渠道建好空的一项。
    const channels: ChannelSummary[] = [];
    for (const name of this.ctx.bots.channelNames()) {
      channels.push({ id: name, label: CHANNEL_LABELS[name] ?? name, count: 0, updatedAt: 0, chats: [] });
    }
    if (bot === undefined) return channels;

    //M 按（渠道、聊天）分组数：条数、最近一条的时刻、最近一条的号（用它的地址取聊天名）。
    const sql = `SELECT channel, ${CHAT_SQL} AS chat, COUNT(*) AS count, MAX(created_at) AS last_at, MAX(id) AS last_id`
      + ' FROM web_messages WHERE bot = ? GROUP BY channel, chat ORDER BY last_at DESC';
    const groups = this.ctx.resources.db.query(sql).all(bot) as { channel: string; chat: string; count: number; last_at: number; last_id: number }[];
    for (const group of groups) {
      //G 没挂着的渠道（插件拔了）、认不出聊天号的旧行 → 不列。
      const owner = channels.find((item) => item.id === group.channel);
      if (owner === undefined || group.chat === '') continue;

      //G 找不到该组最近一条消息时，跳过缺少展示依据的聊天。
      const last = this.get(group.last_id);
      if (last === undefined) continue;

      //M 取最近消息的对端名展示聊天，同时汇总该渠道的计数和时间。
      owner.chats.push({ id: group.chat, label: this.peer(last), count: group.count, updatedAt: group.last_at });
      owner.count += group.count;
      owner.updatedAt = Math.max(owner.updatedAt, group.last_at);
    }

    //M 网页总有“网页”这一项：即使该机器人已收过外部访客 peer 聊天，本机网页入口也始终保留。
    const web = channels.find((item) => item.id === 'http');
    if (web !== undefined && !web.chats.some((item) => item.id === 'http:本机')) {
      web.chats.push({ id: 'http:本机', label: '网页', count: 0, updatedAt: 0 });
    }
    return channels;
  }

  /**
   * 网址里的机器人：不写是名单第一个；写了没有这个机器人 400。
   * @param bot 网址里的值。
   * @returns 机器人名；一个机器人都没有是 undefined。
   */
  getBot(bot: string | undefined): string | undefined {
    //M 没有指定机器人时使用名单中的第一个。
    if (bot === undefined || bot === '') return botUtils.getDefaultBot(this.ctx.resources.raw);

    //G 显式指定的机器人必须存在，避免把无效名称当成默认目标。
    if (botUtils.getBotConfig(this.ctx.resources.raw, bot) === undefined) throw new failureModule.Failure(400, `没有这个机器人：${bot}`);

    return bot;
  }

  /**
   * 库里的一行转成 MessageRecord。
   * @param raw 库里的原样。
   */
  private parse(raw: RawRow): MessageRecord {
    return {
      id: raw.id, bot: raw.bot, channel: raw.channel, source: raw.source, address: raw.address, text: raw.text,
      reply_to: raw.reply_to,
      sessionId: raw.session_id, status: raw.status, replies: JSON.parse(raw.replies) as StoredReply[],
      createdAt: raw.created_at, updatedAt: raw.updated_at,
      chat: raw.chat,
    };
  }
}


/**
 * 生成 `http` 渠道收件记录的对端展示标签：携带外部访客 `address` 时显示 `访客·<名字>`，本机网页显示 `网页`。
 */
function formatHttpPeer(record: MessageRecord): string {
  if (record.address !== null) {
    try {
      const parsed = JSON.parse(record.address) as unknown;
      const guestName = utils.getStringField(parsed, 'name') || utils.getStringField(parsed, 'peerId');
      if (guestName !== '') return `访客·${guestName}`;
    } catch {
      // 旧地址损坏时回退默认标签。
    }
  }
  return '网页';
}
