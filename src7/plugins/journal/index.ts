/**
 * 流水：把和 trace 插件同一种“跟踪行”记进库 journal_lines，给网页的回话追溯、“查看事件”、外面的程序查（GET /api/events）。
 * 两种行（和控制台上 trace 打的一样，拼法在 utils/Trace.ts，两边共用）：
 *   函数行：骨架和插件发的跟踪点 trace（模块.函数、人话、代码、变量），带“文件:行号”；
 *   事件行：Cordis 每发一个事件先发 internal/dispatch，这里听它：事件名、挨个问还是通知、听的人、会话、文件:行号。
 * 0.4 的“run.started / step.after / tool.after……”那套事件名不再用：插件模式下事件就是 Cordis 的事件本身，谁发、谁听一目了然。
 * 另外没挂 files-mirror 时，把每场会话照对话的先后写成一份 对话.md（Markdown.ts）。不改任何东西：不拦、不问、不回话。
 * 设计：docs/src7插件设计/journal.md（第 12 节是 11-14 改成跟踪行的说明）。
 */
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as cut from '../../utils/Cut.ts';
import * as traceUtils from '../../utils/Trace.ts';
import * as markdown from './Markdown.ts';


/** 插件名。 */
export const name = 'journal';

/** 用到的服务：resources 拿数据库、运行时目录。http 是可选的，有就开接口（见 apply）。 */
export const inject = ['resources'];


declare module 'cordis' {
  interface Context {
    /** 流水服务，实现在 src7/plugins/journal/index.ts。别的插件当可选依赖，用 ctx.get('journal') 现取。 */
    journal: Journal;
  }
}
//M model/fallback（换了备选模型）声明在 src7/plugins/model-fallback/index.ts。


/** 一条跟踪行。 */
export interface JournalEvent {
  /** 号，按它排就是先后。 */
  id: number;
  /** 毫秒时间戳。 */
  at: number;
  /** 函数（跟踪点）还是事件（Cordis 发的事件）。 */
  kind: '函数' | '事件';
  /** 函数行是“模块.函数”，如 Bot.receive；事件行是事件名，如 session/message。 */
  name: string;
  /** 事件行：挨个问、通知；函数行是空的。 */
  mode: string;
  /** 事件行：听的人（插件名）；函数行是空的。 */
  listeners: string[];
  /** 函数行：一句人话；事件行是空的。 */
  text: string;
  /** 函数行：对应的那句代码；事件行是空的。 */
  code: string;
  /** 哪一行代码发的：“文件:行号”。 */
  site: string;
  /** 哪个机器人。 */
  bot: string | null;
  /** 哪场会话。 */
  sessionId: string | null;
  /** web-api 收件表的消息号。 */
  messageId: number | null;
  /** 截短过的关键变量。 */
  vars: Record<string, unknown>;
}


/** 一个字符串最多留多少字。 */
const TEXT_MAX_CHARS = 2000;

/** 整条变量 JSON 最多多少字。 */
const DATA_MAX_CHARS = 16000;

/** 事件行里一个值最多几个字（和 trace 默认一样）。 */
const VAR_MAX = 200;

/** 一天多少毫秒：一天删一次过期的。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** /api/events 默认几条、最多几条。 */
const LIST_DEFAULT = 200;
const LIST_MAX = 1000;


/** 流水服务。 */
export class Journal extends cordis.Service {
  /** 上次删过期事件的时刻；0 表示这次启动还没删过，第一条事件进来时删一次。 */
  private prunedAt = 0;

  /**
   * 登记 journal 插件：把 Journal 作为服务挂到 Cordis 上（super(ctx, 'journal') 做的；以后用 ctx.journal 取）；
   * 再建表，挂上各个通知的监听。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param keepDays 事件留几天，apply 里校验过。
   */
  constructor(ctx: cordis.Context, private readonly keepDays: number) {
    super(ctx, 'journal');
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,'
      + ' name TEXT NOT NULL, mode TEXT NOT NULL, listeners TEXT NOT NULL, text TEXT NOT NULL, code TEXT NOT NULL, site TEXT NOT NULL,'
      + ' bot TEXT, session_id TEXT, message_id INTEGER, vars TEXT NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS journal_lines_name ON journal_lines (name, at)');
    db.exec('CREATE INDEX IF NOT EXISTS journal_lines_session ON journal_lines (session_id, at)');
    db.exec('CREATE INDEX IF NOT EXISTS journal_lines_message ON journal_lines (message_id)');
    //M 0.4 格式的旧表（第一批时建的）不再写，也不再读，留着不删。
    this.listen();
  }

  /**
   * 挂监听：跟踪点 trace、Cordis 的 internal/dispatch。ctx.on 登记的监听在插件被拔掉时 Cordis 自己撤掉。
   */
  private listen(): void {
    const ctx = this.ctx;
    ctx.on('trace', (where, text, code, vars) => {
      const session = vars['会话'] ?? vars['session'];
      const bot = vars['机器人'];
      //M 2026-11-16：跟踪点带着“消息号”的（Timeline.insert、WebApi.accept、Timeline.reply）也记进 message_id，/flow/ 按消息号收一条请求的轨迹要用。
      const messageId = vars['消息号'];
      this.record({
        kind: '函数', name: where, mode: '', listeners: [], text, code, site: traceUtils.callSite(['plugins/journal/']),
        bot: typeof bot === 'string' ? bot : null, sessionId: typeof session === 'string' ? session : null,
        messageId: typeof messageId === 'number' && Number.isSafeInteger(messageId) ? messageId : null, vars,
      });
    });

    //M Cordis 每发一个事件，都会先发一个 internal/dispatch：发法、事件名、带的参数。和 trace 插件拼法一样（utils/Trace.ts）。
    ctx.on('internal/dispatch', (mode, event, args) => {
      if (typeof event !== 'string' || event === 'trace' || event.startsWith('internal/')) return;
      const line = traceUtils.dispatchLine(ctx, mode, event, args, VAR_MAX);
      this.record({
        kind: '事件', name: line.name, mode: line.mode, listeners: line.listeners, text: '', code: '', site: traceUtils.callSite(['plugins/journal/']),
        bot: line.bot ?? null, sessionId: line.session ?? null, messageId: line.messageId ?? null, vars: line.vars,
      });
    });

    //M 简版 对话.md 只在没挂 files-mirror 时写：挂了它，它写那份完整的。files-mirror 是可选的服务，ctx.get 现取。
    const mirrorless = (): boolean => ctx.get('filesMirror') === undefined;
    ctx.on('session/message', (session, message) => {
      if (mirrorless()) markdown.append(ctx.resources, session, message);
    });
    ctx.on('session/change', (session) => {
      if (session.row.state !== 'running' && mirrorless()) markdown.ended(ctx.resources, session);
    });
    ctx.on('bot/say', (session, text) => {
      if (mirrorless()) markdown.said(ctx.resources, session, text);
    });
  }

  /**
   * 记一行：截短、写库；一天删一次过期的。
   * @param line 一行（还没有号、时间）。
   * 副作用：写库，可能删旧行。
   */
  private record(line: Omit<JournalEvent, 'id' | 'at'>): void {
    const now = Date.now();
    const sql = 'INSERT INTO journal_lines (at, kind, name, mode, listeners, text, code, site, bot, session_id, message_id, vars)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    this.ctx.resources.db.query(sql).run(now, line.kind, line.name, line.mode, JSON.stringify(line.listeners), cut.chars(line.text, TEXT_MAX_CHARS),
      cut.chars(line.code, TEXT_MAX_CHARS), line.site, line.bot, line.sessionId, line.messageId, shrink(line.vars));

    //G 一天之内删过了 → 不再删。
    if (now - this.prunedAt < DAY_MS) return;

    this.prunedAt = now;
    const gone = this.ctx.resources.db.query('DELETE FROM journal_lines WHERE at < ?').run(now - this.keepDays * DAY_MS);
    //T 跟踪：删过期的行。
    const vars = { 删了几条: gone.changes, 留几天: this.keepDays };
    this.ctx.emit('trace', 'Journal.record', '一天一次：删掉过期的跟踪行', 'DELETE FROM journal_lines WHERE at < ?', vars);
  }

  /**
   * 服务方法：一条请求的行。flow 的轨迹、详情和 web-api 的回话追溯都调它，调用方是插件，可信，不再校验。
   * 先找“收件表记下这条消息”（web-api/received）那一行，再从那一号起往后按先后取。
   * 还没挑过：同一时间别的消息的行也在里面，调用方按自己要的挑（flow 用 Trail.ts 的 pick，web-api 按会话和时间窗）。
   * @param message 收件表的消息号。
   * @param limit 最多几条（含 web-api/received 那行）。
   * @returns 按号从小到大；跟踪行里没有这条消息（过期删了、不是 web-api 收的）是 undefined。
   */
  request(message: number, limit: number): JournalEvent[] | undefined {
    const db = this.ctx.resources.db;

    //M 收件表记下这条消息的那一行：从它起算。
    const startSql = "SELECT id FROM journal_lines WHERE name = 'web-api/received' AND message_id = ? ORDER BY id LIMIT 1";
    const start = db.query(startSql).get(message) as { id: number } | null;
    if (start === null) return undefined;

    const rows = db.query('SELECT * FROM journal_lines WHERE id >= ? ORDER BY id LIMIT ?').all(start.id, limit) as Row[];
    return rows.map(eventOf);
  }

  /**
   * GET /api/events：校验参数（外面进来的），取最新的 limit 条，按号从小到大。
   * @param params 网址参数：name（全名，或写成 session/* 取一类；老写法 type 也认）、kind（函数 / 事件）、session、message、since、limit。
   * @returns 跟踪行。
   * @throws 400：message、since、limit 不是非负整数；kind 不对。
   */
  query(params: Record<string, string | undefined>): JournalEvent[] {
    const message = count(params['message'], 'message');
    const since = count(params['since'], 'since');
    const limit = Math.min(count(params['limit'], 'limit') ?? LIST_DEFAULT, LIST_MAX);
    let sql = 'SELECT * FROM journal_lines WHERE 1 = 1';
    const values: (string | number)[] = [];

    //M name 写成 xxx* 就是这一类都要（LIKE 'xxx%'），否则要全名。
    const name = params['name'] ?? params['type'];
    if (name !== undefined && name !== '') {
      sql += name.endsWith('*') ? ' AND name LIKE ?' : ' AND name = ?';
      values.push(name.endsWith('*') ? `${name.slice(0, -1)}%` : name);
    }
    const kind = params['kind'];
    if (kind !== undefined && kind !== '') {
      if (kind !== '函数' && kind !== '事件') throw Object.assign(new Error('kind 只能是 函数 或 事件'), { statusCode: 400 });
      sql += ' AND kind = ?';
      values.push(kind);
    }
    if (params['session'] !== undefined && params['session'] !== '') {
      sql += ' AND session_id = ?';
      values.push(params['session']);
    }
    if (message !== undefined) {
      sql += ' AND message_id = ?';
      values.push(message);
    }
    if (since !== undefined) {
      sql += ' AND at >= ?';
      values.push(since);
    }

    //M 先倒着取最新的 limit 条，再翻回从小到大。
    sql += ' ORDER BY id DESC LIMIT ?';
    values.push(limit);
    const rows = this.ctx.resources.db.query(sql).all(...values) as Row[];
    return rows.reverse().map(eventOf);
  }
}


/** 表里的一行。 */
interface Row {
  id: number;
  at: number;
  kind: '函数' | '事件';
  name: string;
  mode: string;
  listeners: string;
  text: string;
  code: string;
  site: string;
  bot: string | null;
  session_id: string | null;
  message_id: number | null;
  vars: string;
}


/**
 * 表里一行转成 JournalEvent。
 * @param row 表里的一行。
 */
function eventOf(row: Row): JournalEvent {
  const { session_id: sessionId, message_id: messageId, listeners, vars, ...rest } = row;
  return { ...rest, sessionId, messageId, listeners: JSON.parse(listeners) as string[], vars: JSON.parse(vars) as Record<string, unknown> };
}


/**
 * 截短再转成 JSON（照 0.4 的 src/capabilities/Events.ts:293-329）：每个字符串最多 TEXT_MAX_CHARS 字，整条最多 DATA_MAX_CHARS 字。
 * @param data 数据。
 * @returns 进库的 JSON。
 */
function shrink(data: Record<string, unknown>): string {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.length > TEXT_MAX_CHARS ? `${value.slice(0, TEXT_MAX_CHARS)}……（共 ${String(value.length)} 字）` : value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  const json = JSON.stringify(walk(data));

  //G 整条还是太长 → 只留开头一段，写明截了。
  if (json.length <= DATA_MAX_CHARS) return json;

  return JSON.stringify({ truncated: true, preview: cut.chars(json, DATA_MAX_CHARS) });
}


/**
 * 网址里的可选非负整数。
 * @param value 网址里的值。
 * @param key 参数名，报错用。
 * @returns 没写是 undefined。
 * @throws 带 statusCode 400 的错：不是非负整数。
 */
function count(value: string | undefined, key: string): number | undefined {
  if (value === undefined || value === '') return undefined;

  if (!/^\d+$/u.test(value)) {
    throw Object.assign(new Error(`${key} 要是非负整数`), { statusCode: 400 });
  }
  return Number(value);
}


/**
 * 挂上流水。
 * apply 是 Cordis 插件的入口：inject 里的 resources 就绪后 Cordis 调一次（详见 plugins/Index.ts 的 PluginModule）。
 * 配置读顶层 events 段（events.keep_days，默认 30），在这里校验一次。
 * @param ctx Cordis 给这个插件的 ctx。
 * @throws keep_days 不是正整数时抛错。
 */
export function apply(ctx: cordis.Context): void {
  const events = (ctx.resources.raw['events'] ?? {}) as Record<string, unknown>;
  const keepDays = events['keep_days'] ?? 30;
  if (typeof keepDays !== 'number' || !Number.isInteger(keepDays) || keepDays < 1) {
    throw new Error('events.keep_days 要是正整数（事件留几天）');
  }
  const journal = new Journal(ctx, keepDays);

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口；没挂 http 就不开。
  void ctx.inject(['http'], (sub) => {
    sub.http.app.get<{ Querystring: Record<string, string | undefined> }>('/api/events', async (request, reply: fastify.FastifyReply) => {
      try {
        return journal.query(request.query);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    });
  });
}
