/**
 * 收件表 web_messages 和网页的时间线：一条消息给网页的样子、时间线（分页、取变化）、按号补取、搜索。
 * HTTP 来的、别的渠道（飞书、命令行）来的消息都记在这张表里，一条消息一行，回话追加在它的 replies 里。
 * 设计：docs/src7插件设计/web-api.md 第 2 节“消息”、第 6 节“存什么”。
 */
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import type { Session, SessionMeta, SessionState } from '../../Sessions.ts';
import * as mime from '../../utils/Mime.ts';
import * as traceModule from './Trace.ts';


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
}


/** 记一行要给的东西。 */
export interface NewMessage {
  bot: string;
  channel: string;
  source: string;
  text: string;
  address: string | null;
  reply_to?: number;
}


/** 库里一行的原样（列名是下划线写法）。 */
interface RawRow {
  reply_to: number | null;
  id: number; bot: string; channel: string; source: string; address: string | null; text: string;
  session_id: string | null; status: 'taken' | 'replied'; replies: string; created_at: number; updated_at: number;
}


/** 时间线默认几条、最多几条（同 0.4：src/channels/HttpUi.ts:171）。 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 搜索每组默认几条、最多几条（同 0.4：HttpUi.ts:241-244）。 */
const SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

/** 搜索片段：命中处前后各几个字（同 0.4：HttpUi.ts:247）。 */
const SNIPPET_AROUND = 40;

/** 网页发的话 source 是它（web/src/Api.ts:325 的 from）。 */
const WEB_SOURCE = 'web';

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
function elapsedOf(session: Session, createdAt: number, now: number): { frontMs: number; workMs?: number } {
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
  return summary === '' ? `会话 ${meta.id}` : summary.slice(0, TITLE_MAX);
}


/**
 * 会话状态换成网页认的三种（同 src6/utils/Views.ts:46-51）：running → running，done/stopped → idle，failed → error。
 * @param state 骨架的状态。
 */
export function statusOf(state: SessionState): 'running' | 'idle' | 'error' {
  if (state === 'running') return 'running';

  return state === 'failed' ? 'error' : 'idle';
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
  return { md: fs.existsSync(md) ? md : '', json: fs.existsSync(json) ? json : '' };
}


/**
 * 网址里的可选非负整数（同 0.4 的 optionalCount，HttpUi.ts:516-527）。
 * @param value 网址里的值。
 * @param where 参数名，报错用。
 * @returns 没写是 undefined。
 * @throws Failure(400)：不是非负整数。
 */
export function count(value: string | undefined, where: string): number | undefined {
  if (value === undefined || value === '') return undefined;

  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new traceModule.Failure(400, `${where} 要是非负整数`);

  return number;
}


/**
 * 认出文字里的附件：@绝对路径（带空格时是 @"路径"），查大小（同 0.4：HttpUi.ts:336-349、:376-391）。
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
    return { path: file, name: path.basename(file.replace(/\\/gu, '/')), kind: mime.kindOf(file), size: stat?.size ?? null };
  }));
}


/**
 * 搜索结果的片段：命中处前后各 40 字，截掉的一头加“…”，换行压成空格；没命中给开头一段（同 0.4：HttpUi.ts:290-299）。
 * @param text 文字。
 * @param keyword 关键字。
 */
export function snippet(text: string, keyword: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const at = flat.toLowerCase().indexOf(keyword.toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - SNIPPET_AROUND);
  const end = at < 0 ? Math.min(flat.length, SNIPPET_AROUND * 2) : Math.min(flat.length, at + keyword.length + SNIPPET_AROUND);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
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
   * 建表 web_messages 和三个索引（没有才建）。
   * @param ctx web-api 的 ctx：用 resources.db、sessions、bots，发通知。
   */
  constructor(private readonly ctx: cordis.Context) {
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS web_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + ' channel TEXT NOT NULL, source TEXT NOT NULL, address TEXT, text TEXT NOT NULL, session_id TEXT,'
      + " status TEXT NOT NULL, replies TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    const columns = db.query('PRAGMA table_info(web_messages)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'reply_to')) {
      db.exec('ALTER TABLE web_messages ADD COLUMN reply_to INTEGER');
    }
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
    const now = Date.now();
    const sql = 'INSERT INTO web_messages (bot, channel, source, address, text, session_id, status, replies, created_at, updated_at, reply_to)'
      + " VALUES (?, ?, ?, ?, ?, NULL, 'taken', '[]', ?, ?, ?)";
    const result = this.ctx.resources.db.query(sql).run(
      input.bot, input.channel, input.source, input.address, input.text, now, now, input.reply_to ?? null,
    );
    const id = Number(result.lastInsertRowid);

    //T 跟踪：收件表记下一条。
    const vars = { 消息号: id, 机器人: input.bot, 渠道: input.channel, 字数: input.text.length };
    this.ctx.emit('trace', 'Timeline.insert', '收件表记下一条消息', 'INSERT INTO web_messages', vars);
    this.ctx.emit('web-api/received', { id, bot: input.bot, channel: input.channel, source: input.source, text: input.text, at: now });
    return id;
  }

  /**
   * 删一行：推给机器人失败时，收下的那条不留。
   * @param id 消息号。
   */
  remove(id: number): void {
    this.ctx.resources.db.query('DELETE FROM web_messages WHERE id = ?').run(id);
  }

  /**
   * 取一条。
   * @param id 消息号。
   * @returns 没有是 undefined。
   */
  get(id: number): MessageRecord | undefined {
    const raw = this.ctx.resources.db.query('SELECT * FROM web_messages WHERE id = ?').get(id) as RawRow | null;
    return raw === null ? undefined : this.parse(raw);
  }

  /**
   * 按机器人、渠道、回话地址找最新的那一行：别的渠道的会话回话时用它找回原话。
   * @param bot 机器人。
   * @param channel 渠道名。
   * @param address 回话地址的 JSON。
   * @returns 消息号；找不到是 undefined（比如插件挂上之前收的话）。
   */
  findByAddress(bot: string, channel: string, address: string): number | undefined {
    const sql = 'SELECT id FROM web_messages WHERE channel = ? AND address = ? AND bot = ? ORDER BY id DESC LIMIT 1';
    const found = this.ctx.resources.db.query(sql).get(channel, address, bot) as { id: number } | null;
    return found?.id;
  }

  /**
   * 追加一句回话：算好生成依据一起存；第一句回话定下 sessionId；会话不在转了就算 replied。发通知 web-api/replied。
   * @param id 消息号。
   * @param session 哪场会话说的。
   * @param text 说了什么。
   * 副作用：写库。消息不在了（被删、地址是插件挂上前的）就什么也不做。
   */
  reply(id: number, session: Session, text: string): void {
    const record = this.get(id);
    if (record === undefined) return;

    const now = Date.now();
    //G 空话不追加气泡（比如点完表情后的空回答）；会话已结束仍把状态改成 replied。
    if (text === '') {
      if (session.row.state === 'running') return;
      const sql = 'UPDATE web_messages SET session_id = COALESCE(session_id, ?), status = ?, updated_at = ? WHERE id = ?';
      this.ctx.resources.db.query(sql).run(session.id, 'replied', now, id);
      record.status = 'replied';
      return;
    }
    record.replies.push({ at: now, sessionId: session.id, text, generation: traceModule.generationOf(session.row, text), ...elapsedOf(session, record.createdAt, now) });
    const status = session.row.state === 'running' ? record.status : 'replied';
    const sql = 'UPDATE web_messages SET replies = ?, session_id = COALESCE(session_id, ?), status = ?, updated_at = ? WHERE id = ?';
    this.ctx.resources.db.query(sql).run(JSON.stringify(record.replies), session.id, status, now, id);

    //T 跟踪：追加一句回话。
    const vars = { 消息号: id, 会话: session.id, 字数: text.length, 状态: status };
    this.ctx.emit('trace', 'Timeline.reply', '收件表追加一句回话', 'UPDATE web_messages SET replies', vars);
    this.ctx.emit('web-api/replied', { messageId: id, replyIndex: record.replies.length - 1, session, text, at: now });
  }

  /** 渠道和对方的展示标签，地址仍由各渠道维护。 */
  peer(record: MessageRecord): string {
    if (record.channel === 'http') return '网页';

    const address = JSON.parse(record.address ?? '{}') ?? {};
    if (record.channel === 'feishu') {
      const kind = address.chatType === 'group' ? '群' : '私聊';
      const who = address.name || address.chatName || address.userName || address.openId?.slice(-4);
      return `飞书·${kind}${who ? `·${who}` : ''}`;
    }
    if (record.channel === 'wechat') return `微信·${address.name || address.chat || ''}`;

    return record.channel;
  }

  /** 一条收件消息给网页的样子，引用内容独立于正文返回。 */
  async view(record: MessageRecord): Promise<Record<string, unknown>> {
    const quoted = record.reply_to === null ? undefined : this.get(record.reply_to);
    const replies = await Promise.all(record.replies.map(async (item) => {
      const meta = this.ctx.sessions.find({ id: item.sessionId })[0];
      return {
        at: item.at,
        session: {
          id: item.sessionId,
          title: meta === undefined ? `会话 ${item.sessionId}` : title(meta),
          file: meta === undefined ? '' : sessionFiles(this.ctx.resources.root, meta).md,
          kind: meta?.kind,
        },
        text: item.text,
        attachments: await attachments(item.text),
        generation: item.generation,
        association: this.association(record.id),
        frontMs: item.frontMs ?? (item.workMs === undefined ? Math.max(0, item.at - record.createdAt) : item.frontMs),
        workMs: item.workMs,
      };
    }));
    return {
      id: record.id,
      bot: record.bot,
      channel: record.channel,
      peer: this.peer(record),
      reply_to: record.reply_to,
      replyTo: quoted === undefined ? null : { id: quoted.id, peer: this.peer(quoted), text: quoted.text },
      source: record.source,
      text: record.text,
      status: record.status,
      sessionId: record.sessionId,
      file: '',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      attachments: await attachments(record.text),
      replies,
      dispatch: null,
    };
  }

  /**
   * 回话的来源：只有它追加在的这条消息（照 src6/channels/HttpMessageView.ts:160-171 的后一种）。
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
    scope.get<Query>('/api/messages', async (request) => this.list(request.query));
    scope.get<Query>('/api/messages/resolve', async (request) => this.resolve(request.query));
    scope.get<Query>('/api/search', async (request) => this.search(request.query));
    scope.get<{ Params: { id: string } }>('/api/messages/:id', async (request) => {
      const record = this.get(Number(request.params.id));
      if (record === undefined) throw new traceModule.Failure(404, `没有这条消息：${request.params.id}`);

      return this.view(record);
    });
  }

  /**
   * GET /api/messages：时间线。不写 after 是往前翻（before 之前的 limit 条，多取一条看还有没有更早的）；
   * 写了 after 是取变化（updatedAt 不早于它的全给）。同 0.4：HttpUi.ts:1014-1055。
   * @param query bot、before、after、limit、origin。
   */
  private async list(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const bot = this.botOf(query['bot']);
    if (bot === undefined) return { messages: [], hasMore: false, cursor: 0 };

    const before = count(query['before'], 'before');
    const after = count(query['after'], 'after');
    const limit = Math.min(count(query['limit'], 'limit') ?? DEFAULT_LIMIT, MAX_LIMIT);
    const origin = query['origin'];
    if (origin !== undefined && origin !== '' && origin !== 'web' && origin !== 'other') {
      throw new traceModule.Failure(400, 'origin 要是 web 或 other');
    }

    //M 拼条件：机器人；origin=web 只要网页发的，other 只要别的（右栏“消息”）。
    let where = 'bot = ?';
    const values: (string | number)[] = [bot];
    if (origin === 'web' || origin === 'other') {
      where += origin === 'web' ? ' AND source = ?' : ' AND source != ?';
      values.push(WEB_SOURCE);
    }
    const channel = query['channel'];
    if (channel !== undefined && channel !== '') {
      if (!['http', 'feishu', 'wechat'].includes(channel)) {
        throw new traceModule.Failure(400, 'channel 要是 http、feishu 或 wechat');
      }
      where += ' AND channel = ?';
      values.push(channel);
    }
    let rows: RawRow[];
    if (after === undefined) {
      if (before !== undefined) {
        where += ' AND id < ?';
        values.push(before);
      }
      const sql = `SELECT * FROM web_messages WHERE ${where} ORDER BY id DESC LIMIT ?`;
      rows = (this.ctx.resources.db.query(sql).all(...values, limit + 1) as RawRow[]).reverse();
    } else {
      const sql = `SELECT * FROM web_messages WHERE ${where} AND updated_at >= ? ORDER BY id`;
      rows = this.ctx.resources.db.query(sql).all(...values, after) as RawRow[];
    }
    const hasMore = after === undefined && rows.length > limit;
    const shown = (hasMore ? rows.slice(1) : rows).map((raw) => this.parse(raw));
    const messages = await Promise.all(shown.map((record) => this.view(record)));
    const cursor = Math.max(after ?? 0, ...shown.map((record) => record.updatedAt));
    return { messages, hasMore, cursor };
  }

  /**
   * GET /api/messages/resolve：按号补取（同 0.4：HttpUi.ts:1058-1092）。
   * @param query bot（必填）、ids（逗号分隔，最多 100 个正整数）。
   */
  private async resolve(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const bot = query['bot'];
    if (bot === undefined || bot === '') throw new traceModule.Failure(400, '补取原消息必须写 bot');
    if (this.ctx.bots.get(bot) === undefined) throw new traceModule.Failure(400, `没有这个机器人：${bot}`);

    const tokens = (query['ids'] ?? '').split(',');
    if (tokens.length > RESOLVE_MAX || tokens.some((id) => !/^[1-9]\d{0,15}$/u.test(id))) {
      throw new traceModule.Failure(400, 'ids 要是最多 100 个逗号分隔的正整数');
    }
    const records: MessageRecord[] = [];
    const missingIds: number[] = [];
    for (const id of new Set(tokens.map(Number))) {
      const record = this.get(id);
      if (record === undefined || record.bot !== bot) {
        missingIds.push(id);
      } else {
        records.push(record);
      }
    }
    return { messages: await Promise.all(records.map((record) => this.view(record))), missingIds };
  }

  /**
   * GET /api/search：搜消息原话和回话、会话标题和总结（同 0.4：HttpUi.ts:1100-1153）。
   * @param query q（必填）、bot（不写搜全部）、limit（每组几条）。
   */
  private search(query: Record<string, string | undefined>): Record<string, unknown> {
    const keyword = (query['q'] ?? '').trim();
    if (keyword === '') throw new traceModule.Failure(400, '要写搜什么：?q=关键字');

    const bot = query['bot'] === undefined || query['bot'] === '' ? undefined : query['bot'];
    if (bot !== undefined && this.ctx.bots.get(bot) === undefined) throw new traceModule.Failure(400, `没有这个机器人：${bot}`);

    const limit = Math.min(count(query['limit'], 'limit') ?? SEARCH_LIMIT, MAX_SEARCH_LIMIT);

    //M 消息：库里先用 LIKE 粗筛（replies 列是 JSON，可能误中生成依据里的字），再逐条看原话、回话原文，新的在前。
    const escaped = keyword.replace(/[\\%_]/gu, (char) => `\\${char}`);
    const like = `%${escaped}%`;
    const sql = "SELECT * FROM web_messages WHERE (text LIKE ? ESCAPE '\\' OR replies LIKE ? ESCAPE '\\')"
      + (bot === undefined ? '' : ' AND bot = ?') + ' ORDER BY id DESC LIMIT 1000';
    const values = bot === undefined ? [like, like] : [like, like, bot];
    const messages: Record<string, unknown>[] = [];
    for (const raw of this.ctx.resources.db.query(sql).all(...values) as RawRow[]) {
      if (messages.length >= limit) break;
      const record = this.parse(raw);
      const hitReply = includes(record.text, keyword) ? undefined : record.replies.find((item) => includes(item.text, keyword));
      if (!includes(record.text, keyword) && hitReply === undefined) continue;
      messages.push({
        id: record.id, bot: record.bot, channel: record.channel, source: record.source, createdAt: record.createdAt,
        file: '', sessionId: record.sessionId, hit: hitReply === undefined ? 'text' : 'reply',
        snippet: snippet(hitReply === undefined ? record.text : hitReply.text, keyword),
      });
    }

    //M 会话：没有 parent 的（小会话不给网页看），标题或总结命中的，最近动过的在前。
    const sessions = this.ctx.sessions.find(bot === undefined ? {} : { bot })
      .filter((meta) => meta.parent === undefined && (includes(title(meta), keyword) || includes(meta.summary ?? '', keyword)))
      .slice(0, limit)
      .map((meta) => ({
        id: meta.id, bot: meta.bot, workspace: 'workspace', title: title(meta), snippet: snippet(meta.summary ?? '', keyword),
        updatedAt: meta.updatedAt, file: sessionFiles(this.ctx.resources.root, meta).md,
      }));
    return { messages, sessions };
  }

  /**
   * 网址里的机器人：不写是名单第一个；写了没有这个机器人 400。
   * @param bot 网址里的值。
   * @returns 机器人名；一个机器人都没有是 undefined。
   */
  botOf(bot: string | undefined): string | undefined {
    if (bot === undefined || bot === '') return this.ctx.bots.list()[0]?.name;
    if (this.ctx.bots.get(bot) === undefined) throw new traceModule.Failure(400, `没有这个机器人：${bot}`);

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
    };
  }
}
