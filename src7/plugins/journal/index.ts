/**
 * 流水：把和 trace 插件同一种“跟踪行”记进库 journal_lines，给网页的回话追溯、“查看事件”、外面的程序查（GET /api/events）。
 * 两种行（和控制台上 trace 打的一样，拼法在 utils/Trace.ts，两边共用）：
 *   函数行：骨架和插件发的跟踪点 trace（模块.函数、人话、代码、变量），带“文件:行号”；
 *   事件行：Cordis 每发一个事件先发 internal/dispatch，这里听它：事件名、挨个问还是通知、听的人、会话、文件:行号。
 * 0.4 的“run.started / step.after / tool.after……”那套事件名不再用：插件模式下事件就是 Cordis 的事件本身，谁发、谁听一目了然。
 * 另外会同步挂上完整会话文件镜像 FilesMirror（原 files-mirror 已并入 ./FilesMirror.ts，保留 ctx.filesMirror）；
 * 若关闭 mirror: false，才回退由 Markdown.ts 写简版 对话.md。另提供流水与镜像路径的查询事件。
 * 按消息或关联会话查询流水。教程轨迹由 Trail.ts 收成步骤，回话追溯直接返回截止到该句的行。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as checks from '../../utils/Checks.ts';
import * as cut from '../../utils/Cut.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as traceUtils from '../../utils/Trace.ts';
import type * as trailTypes from '../../utils/Trail.ts';
import { FilesMirror } from './FilesMirror.ts';
import * as markdown from './Markdown.ts';
import * as traceModule from './Trace.ts';
import * as trailModule from './Trail.ts';

export { FilesMirror } from './FilesMirror.ts';


/** 插件名。 */
export const name = 'journal';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.0：并入原 files-mirror（统一提供 ctx.journal 与 ctx.filesMirror，完整镜像优先写 对话.md 与 session.json）。
//M 1.2.0：“跟踪行 → 步骤”只留一份，从 tutorial/Trail.ts 挪进 Trail.ts；
//M   journal/request 的 message-lines 换成 trail（教程页）、reply-lines（聊天页追溯）。
//M 1.3.0：Trail 只走 journal/request（新增 boot-trail），tutorial 不再 import Trail.ts；
//M   web-api/Trace.ts 里流水行换网页事件那段并进 Trace.ts，reply-lines 直接回网页事件 events。
//M 1.2.2：journal_lines 加 source_id 列（标准消息号，渠道发来的 JSON.stringify([渠道, 账号, 平台原消息号])）；
//M   trail、reply-lines 按它把渠道那几行（飞书 WebSocket 收到、去重、认 @、channel/message）串在收件行前面，
//M   轨迹第一格不再是“收件表记下”；/api/events 加 source 参数。
export const version = '1.3.0';

/** 用到的服务：resources 拿数据库、运行时目录。http 是可选的，有就开接口（见 apply）。 */
export const inject = ['resources'];


declare module 'cordis' {
  interface Context {
    /** 流水服务，实现在 src7/plugins/journal/index.ts。别的插件当可选依赖，用 ctx.get('journal') 现取。 */
    journal: Journal;
  }
  interface Events {
    /**
     * 查消息轨迹、流水或会话镜像路径。
     * 谁发：
     *   src7/plugins/progress/Review.ts 的 Review.check
     *   src7/plugins/tutorial/Files.ts 的 FlowFiles.getMessageTrail、FlowFiles.getBootTrail
     *   src7/plugins/tutorial/index.ts 的 Tutorial.getRecentMessages
     *   src7/plugins/web-api/Trace.ts 的 trace
     * 谁接：src7/plugins/journal/index.ts 的 apply
     */
    'journal/request'(request: JournalRequest): void | Promise<void>;
    /**
     * 返回对应查询结果。
     * 谁发：src7/plugins/journal/index.ts 的 apply
     * 谁接：
     *   src7/plugins/progress/Review.ts 的 Review.check
     *   src7/plugins/tutorial/Files.ts 的 FlowFiles.getMessageTrail、FlowFiles.getBootTrail
     *   src7/plugins/tutorial/index.ts 的 Tutorial.getRecentMessages
     *   src7/plugins/web-api/Trace.ts 的 trace
     */
    'journal/result'(result: JournalResult): void;
  }
}
//M model/fallback（换了备选模型）声明在 src7/plugins/model-catalog/Fallback.ts。

/** 流水服务支持的查询。 */
type JournalRequest = requestEventModule.RequestEnvelope & ({
  /** 教程页：按消息号收成一步一步的轨迹。 */
  action: 'trail';
  /** 收件表的消息号。 */
  message: number;
  /** 筛完消息和相关会话后最多取几行。 */
  maxLines: number;
} | {
  /** 教程页：把 tutorial 录下的启动行收成启动轨迹（消息号 0）。 */
  action: 'boot-trail';
  /** tutorial/Boot.ts 的 getLines()。 */
  lines: trailTypes.TrailLine[];
  /** tutorial/Boot.ts 的关键变量说明表（BootTrail.notes）。 */
  notes: Record<string, string>;
} | {
  /** 聊天页回话追溯：按消息号挑出到这句回话为止的行。 */
  action: 'reply-lines';
  /** 收件表的消息号。 */
  message: number;
  /** 筛完消息和相关会话后最多取几行。 */
  maxLines: number;
  /** 这条消息从第一句到这一句回话出现过的会话号。 */
  sessions: string[];
  /** 这句回话的时刻，毫秒。 */
  to: number;
} | {
  /** 按筛选条件查流水。 */
  action: 'query';
  /** 与 GET /api/events 一致的查询参数。 */
  params: Record<string, string | undefined>;
} | {
  /** 查会话镜像目录。 */
  action: 'mirror-dir';
  /** 机器人名。 */
  bot: string;
  /** 会话号。 */
  sessionId: string;
});

/** 流水查询的回执。 */
interface JournalResult extends requestEventModule.ResultEnvelope {
  /** query 是否成功。 */
  ok?: boolean;
  /** query 的流水。 */
  lines?: JournalEvent[];
  /** reply-lines：截至这句回话的匹配行，已换成网页追溯的事件外壳；没有这条消息时不给。 */
  events?: traceModule.TraceEvent[];
  /** trail、boot-trail：收好的轨迹；trail 在跟踪行里没有这条消息时不给。 */
  trail?: trailTypes.Trail;
  /** trail：挑出属于这条请求的行（tutorial 拿去对内存里的快照）。 */
  picked?: trailTypes.TrailLine[];
  /** reply-lines：这句回话之前还有匹配行未返回。 */
  cut?: boolean;
  /** query 校验失败的原因。 */
  error?: string;
  /** mirror-dir 的镜像目录，关闭文件镜像时为空。 */
  dir?: string;
}

/** 一条跟踪行。 */
export interface JournalEvent {
  /** 号，按它排就是先后。 */
  id: number;
  /** 毫秒时间戳。 */
  at: number;
  /** 函数（跟踪点）还是事件（Cordis 发的事件）。 */
  kind: '函数' | '事件';
  /** 函数行是“模块.函数”，如 Bot.receive；事件行是事件名，如 session/new-message。 */
  name: string;
  /** 事件行的 Cordis 发法，旧记录可能是显示文字。函数行为空。 */
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
  /** 标准消息号：渠道发来的 JSON.stringify([渠道, 账号, 平台原消息号])；没带的行是 null。查库交出的行一定有这项，测试里手拼的行可以省。 */
  sourceId?: string | null;
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

/** 只取数的事件。混合读写的请求和回执继续记入流水。 */
const READ_EVENTS = ['journal/request', 'journal/result', 'usage/list', 'usage/list-result'] as const;
const READ_EVENT_NAMES: ReadonlySet<string> = new Set(READ_EVENTS);


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
    db.exec('CREATE TABLE IF NOT EXISTS journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,'
      + ' kind TEXT NOT NULL,'
      + ' name TEXT NOT NULL, mode TEXT NOT NULL, listeners TEXT NOT NULL, text TEXT NOT NULL, code TEXT NOT NULL,'
      + ' site TEXT NOT NULL,'
      + ' bot TEXT, session_id TEXT, message_id INTEGER, source_id TEXT, vars TEXT NOT NULL)');
    //M 1.3.0 以前建的表没有 source_id 列：补一列（旧行是空）。
    const columns = db.query('PRAGMA table_info(journal_lines)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'source_id')) {
      db.exec('ALTER TABLE journal_lines ADD COLUMN source_id TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS journal_lines_name ON journal_lines (name, at)');
    db.exec('CREATE INDEX IF NOT EXISTS journal_lines_session ON journal_lines (session_id, at)');
    db.exec('CREATE INDEX IF NOT EXISTS journal_lines_message ON journal_lines (message_id)');
    db.exec('CREATE INDEX IF NOT EXISTS journal_lines_source ON journal_lines (source_id)');
    //M 0.4 格式的旧表（第一批时建的）不再写，也不再读，留着不删。
    this.listen();
  }

  /**
   * 挂监听：跟踪点 trace、Cordis 的 internal/dispatch。ctx.on 登记的监听在插件被拔掉时 Cordis 自己撤掉。
   */
  private listen(): void {
    const ctx = this.ctx;
    ctx.on('trace', (where, text, code, vars) => {
      const session = vars['session'] ?? vars['会话'];
      const bot = vars['bot'] ?? vars['机器人'];
      let botValue: string | null = null;
      if (typeof bot === 'string') {
        botValue = bot;
      }
      let sessionValue: string | null = null;
      if (typeof session === 'string') {
        sessionValue = session;
      }
      //M 2026-11-16：跟踪点带着“消息号”的（Timeline.insert、WebApi.accept、Timeline.reply）也记进 message_id，/flow/ 按消息号收一条请求的轨迹要用。
      const messageId = vars['messageId'] ?? vars['消息号'];
      let messageIdValue: number | null = null;
      if (typeof messageId === 'number' && Number.isSafeInteger(messageId)) {
        messageIdValue = messageId;
      }

      //M 2026-11-19：渠道的跟踪点（飞书收到、去重、认 @）带标准消息号（messageId 写成标准号字符串，或单写 sourceId），记进 source_id。
      //M   Timeline.insert 同时带数字的收件号和 sourceId，journal.request 靠这一行把收件号和标准号接上。
      const sourceId = traceUtils.getSourceId(vars['sourceId']) ?? traceUtils.getSourceId(vars['messageId']) ?? null;

      //M 把跟踪点和消息号一同写入流水，供轨迹页按消息定位。
      this.record({
        kind: '函数', name: where, mode: '', listeners: [], text, code,
        site: traceUtils.getCallSite(['plugins/journal/']),
        bot: botValue, sessionId: sessionValue, messageId: messageIdValue, sourceId, vars,
      });
    });

    //M Cordis 每发一个事件，都会先发一个 internal/dispatch：发法、事件名、带的参数。和 trace 插件拼法一样（utils/Trace.ts）。
    ctx.on('internal/dispatch', (mode, event, args) => {
      if (typeof event !== 'string' || event === 'trace' || event.startsWith('internal/')) return;

      //G 查询流水或用量时不写流水，重复查看不会把查询本身记成运行步骤。
      if (READ_EVENT_NAMES.has(event)) return;

      const line = traceUtils.buildDispatchLine(ctx, mode, event, args, VAR_MAX);
      this.record({
        kind: '事件', name: line.name, mode: line.mode, listeners: line.listeners, text: '', code: '',
        site: traceUtils.getCallSite(['plugins/journal/']),
        bot: line.bot ?? null, sessionId: line.session ?? null, messageId: line.messageId ?? null,
        sourceId: line.sourceId ?? null, vars: line.vars,
      });
    });

    //M 简版 对话.md 只在没挂 filesMirror 时写：挂了它，它写那份完整的。filesMirror 是可选的服务，ctx.get 现取。
    const mirrorless = (): boolean => ctx.get('filesMirror') === undefined;
    ctx.on('session/new-message', (session, message) => {
      if (mirrorless()) {
        markdown.append(ctx.resources, session, message);
      }
    });
    ctx.on('session/change', (session) => {
      //G 一轮结束后只在没有完整镜像服务时向简版对话补结束标记。
      if (session.row.state !== 'running' && mirrorless()) {
        markdown.ended(ctx.resources, session);
      }
    });
    ctx.on('bot/say', (session, text) => {
      //G 没有完整镜像服务时，由流水保存助手中途说的话。
      if (mirrorless()) {
        markdown.said(ctx.resources, session, text);
      }
    });
  }

  /**
   * 记一行：截短、写库；一天删一次过期的。
   * @param line 一行（还没有号、时间）。
   * 副作用：写库，可能删旧行。
   */
  private record(line: Omit<JournalEvent, 'id' | 'at'>): void {
    const now = Date.now();
    const sql = 'INSERT INTO journal_lines'
      + ' (at, kind, name, mode, listeners, text, code, site, bot, session_id, message_id, source_id, vars)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    //M 把跟踪行连同截短后的内容和变量写入数据库，供轨迹查询。
    this.ctx.resources.db.query(sql).run(
      now, line.kind, line.name, line.mode, JSON.stringify(line.listeners), cut.clipTextWithLength(line.text, TEXT_MAX_CHARS),
      cut.clipTextWithLength(line.code, TEXT_MAX_CHARS), line.site, line.bot, line.sessionId, line.messageId,
      line.sourceId ?? null, shrink(line.vars));

    //G 一天之内删过了 → 不再删。
    if (now - this.prunedAt < DAY_MS) return;

    this.prunedAt = now;
    //M 按配置天数清理过期流水，变更行数用来记录本次清理。
    const gone = this.ctx.resources.db
      .query('DELETE FROM journal_lines WHERE at < ?')
      .run(now - this.keepDays * DAY_MS);
    //T 跟踪：删过期的行。
    const vars = { deletedCount: gone.changes, retentionDays: this.keepDays };
    this.ctx.emit('trace', 'Journal.record', 'trace.journal.prune', 'DELETE FROM journal_lines WHERE at < ?', vars);
  }

  /**
   * 从这条消息的第一行起按消息号、标准消息号或明确关联的会话取流水，上限只计算匹配行。
   * 渠道（飞书）的消息，收件行前面还有渠道那几行（收到、去重、认 @、channel/message）：它们只带标准消息号，
   * 靠 Timeline.insert 那一行同时带着收件号和标准号接上，从标准号第一次出现的那行起取。
   * @param message 收件表的消息号。
   * @param maxLines 最多几条（含 web-api/received 那行）。
   * @param sessions 调用方已知的相关会话号。
   * @param to 可选的截止时间，包含该毫秒内的匹配行。
   * @returns 按号从小到大。没有收件行时是 undefined。
   */
  request(message: number, maxLines: number, sessions: string[] = [], to = Number.MAX_SAFE_INTEGER): JournalEvent[] | undefined {
    const db = this.ctx.resources.db;

    //M 收件表记下这条消息的那一行：没有它就不是一条收下的消息。
    const startSql = "SELECT id FROM journal_lines WHERE name = 'web-api/received' AND message_id = ?"
      + ' ORDER BY id LIMIT 1';
    const start = db.query(startSql).get(message) as { id: number } | null;
    if (start === null) return undefined;

    //M 渠道来的消息：Timeline.insert 那行带着标准消息号，从这个标准号第一次出现的行起算；别的渠道、网页来的没有，从收件行起算。
    const bridge = db.query('SELECT source_id FROM journal_lines WHERE message_id = ? AND source_id IS NOT NULL ORDER BY id LIMIT 1')
      .get(message) as { source_id: string } | null;
    const sourceId = bridge?.source_id ?? null;
    let from = start.id;
    if (sourceId !== null) {
      const first = db.query('SELECT MIN(id) AS id FROM journal_lines WHERE source_id = ?').get(sourceId) as { id: number };
      from = Math.min(from, first.id);
    }

    //M 有其他消息号的行归那条消息（同一条群消息给几个机器人，各有各的收件号）。
    //M   无收件号、无会话、带这条标准号的行（渠道收到、channel/message）归这条；其余无收件号的行只认明确关联的会话。
    const sql = 'SELECT * FROM journal_lines WHERE id >= ? AND at <= ? AND name NOT IN (?, ?, ?, ?)'
      + ' AND (message_id = ? OR (message_id IS NULL AND session_id IS NULL AND source_id = ?) OR (message_id IS NULL AND session_id IN ('
      + ' SELECT session_id FROM journal_lines WHERE message_id = ? AND id >= ? AND at <= ? AND session_id IS NOT NULL'
      + ' UNION SELECT value FROM json_each(?)))) ORDER BY id LIMIT ?';
    const knownSessions = JSON.stringify(sessions);
    const rows = db.query(sql).all(from, to, ...READ_EVENTS, message, sourceId, message, from, to, knownSessions, maxLines) as Row[];
    return rows.map(getEvent);
  }

  /**
   * GET /api/events：校验参数（外面进来的），取最新的 limit 条，按号从小到大。
   * @param params 网址参数：name（全名，或写成 session/* 取一类；老写法 type 也认）、kind（函数 / 事件）、session、message、source（标准消息号）、since、limit。
   * @returns 跟踪行。
   * @throws 400：message、since、limit 不是非负整数；kind 不对。
   */
  query(params: Record<string, string | undefined>): JournalEvent[] {
    //M 三个整数参数在入口查一次（utils/Checks.ts 的 checkCount），写错了回 400；limit 没写按默认，超了按上限。
    const message = checks.checkCount(params['message'], 'message');
    const since = checks.checkCount(params['since'], 'since');
    const wantedLimit = checks.checkCount(params['limit'], 'limit') ?? LIST_DEFAULT;
    const limit = Math.min(wantedLimit, LIST_MAX);

    let sql = 'SELECT * FROM journal_lines WHERE 1 = 1';
    const values: (string | number)[] = [];

    //M name 写成 xxx* 就是这一类都要（LIKE 'xxx%'），否则要全名。
    const name = params['name'] ?? params['type'];
    if (name !== undefined && name !== '') {
      let op = ' = ?';
      let pattern = name;
      if (name.endsWith('*')) {
        op = ' LIKE ?';
        pattern = `${name.slice(0, -1)}%`;
      }
      sql += ` AND name${op}`;
      values.push(pattern);
    }
    const kind = params['kind'];
    if (kind !== undefined && kind !== '') {
      if (kind !== '函数' && kind !== '事件') {
        throw Object.assign(new Error('kind 只能是 函数 或 事件'), { statusCode: 400 });
      }
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
    if (params['source'] !== undefined && params['source'] !== '') {
      sql += ' AND source_id = ?';
      values.push(params['source']);
    }
    if (since !== undefined) {
      sql += ' AND at >= ?';
      values.push(since);
    }

    //M 先倒着取最新的 limit 条，再翻回从小到大。
    sql += ' ORDER BY id DESC LIMIT ?';
    values.push(limit);
    const rows = this.ctx.resources.db.query(sql).all(...values) as Row[];
    return rows.reverse().map(getEvent);
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
  source_id: string | null;
  vars: string;
}


/**
 * 表里一行转成 JournalEvent。
 * @param row 表里的一行。
 */
function getEvent(row: Row): JournalEvent {
  const { session_id: sessionId, message_id: messageId, source_id: sourceId, listeners, vars, ...rest } = row;
  return {
    ...rest, sessionId, messageId, sourceId,
    listeners: JSON.parse(listeners) as string[], vars: JSON.parse(vars) as Record<string, unknown>,
  };
}


/**
 * 截短再转成 JSON（照 0.4 的 src/capabilities/Events.ts:293-329）：每个字符串最多 TEXT_MAX_CHARS 字，整条最多 DATA_MAX_CHARS 字。
 * @param data 数据。
 * @returns 进库的 JSON。
 */
function shrink(data: Record<string, unknown>): string {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.length > TEXT_MAX_CHARS) return `${value.slice(0, TEXT_MAX_CHARS)}……（共 ${String(value.length)} 字）`;

      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      //M 保留变量对象的键，对子值沿用同样的递归截短规则。
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };

  //M 先将逐值截短后的变量序列化，再判断总长度是否超出上限。
  const json = JSON.stringify(walk(data));

  //G 整条还是太长 → 只留开头一段，写明截了。
  if (json.length <= DATA_MAX_CHARS) return json;

  //M 持久化定长预览与截断标志，让读取方知道原有数据未全部保留。
  return JSON.stringify({ truncated: true, preview: cut.clipTextWithLength(json, DATA_MAX_CHARS) });
}


/** journal 插件的可选配置。 */
export interface JournalConfig {
  /** 是否挂载完整会话文件镜像 ctx.filesMirror（生成完整 对话.md 和 session.json）；不写默认 true。 */
  mirror?: boolean;
}


/**
 * 挂上流水与完整会话文件镜像。
 * apply 是 Cordis 插件的入口：inject 里的 resources 就绪后 Cordis 调一次（详见 plugins/Index.ts 的 PluginModule）。
 * 配置读顶层 events 段（events.keep_days，默认 30）与插件自身可选 config.mirror（默认 true），在这里校验一次。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 插件配置（可选 mirror: boolean）。
 * @throws keep_days 不是正整数或 mirror 不是布尔时抛错。
 */
export function apply(ctx: cordis.Context, config?: unknown): void {
  const events = (ctx.resources.raw['events'] ?? {}) as Record<string, unknown>;
  const keepDays = events['keep_days'] ?? 30;
  if (typeof keepDays !== 'number' || !Number.isInteger(keepDays) || keepDays < 1) {
    throw new Error('events.keep_days 要是正整数（事件留几天）');
  }
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new Error('journal 插件的 config 要写成对象');
  }
  const own = (config ?? {}) as Record<string, unknown>;
  const mirror = own['mirror'] ?? true;
  if (typeof mirror !== 'boolean') {
    throw new Error('journal 的 mirror 要写成 true 或 false');
  }

  let filesMirror: FilesMirror | undefined;
  if (mirror) {
    //M 先挂镜像服务，避免 Journal 把第一轮对话也写入简版。
    filesMirror = new FilesMirror(ctx);
  }

  //M 建流水表并开始记录跟踪行。
  const journal = new Journal(ctx, keepDays);

  //M 用同一监听按 action 分派五种查询，复用原服务方法。
  requestEventModule.onRequestEvent(ctx, 'journal/request', 'journal/result', (request) => {
    if (request.action === 'trail') {
      //M 教程页：只取与入站消息和关联会话有关的流水。
      const raw = journal.request(request.message, request.maxLines);
      if (raw === undefined) return {};

      //M 挑出这条请求的行（tutorial 对快照用），再收成一步一步。
      const picked = trailModule.pick(request.message, raw).picked;
      const trail = trailModule.getTrail(request.message, raw);
      return { trail, picked };
    }
    if (request.action === 'boot-trail') {
      //M 启动行是 tutorial 自己录的，不在流水里；这里只负责收成步骤。
      const trail = trailModule.getBootTrail(request.lines, request.notes);
      return { trail };
    }
    if (request.action === 'reply-lines') {
      //M 只取截至这句回话的匹配行，多读一行判断截断。
      const probeLimit = request.maxLines + 1;
      const raw = journal.request(request.message, probeLimit, request.sessions, request.to);
      if (raw === undefined) return {};

      //M 流水行换成网页追溯的事件外壳（原来在 web-api/Trace.ts 里做）。
      const lines = raw.slice(0, request.maxLines);
      const events = lines.map(traceModule.getTraceEvent);
      return { events, cut: raw.length > request.maxLines };
    }
    if (request.action === 'query') {
      try {
        //M 沿用流水 HTTP 接口的参数校验和筛选规则。
        const lines = journal.query(request.params);
        return { ok: true, lines };
      } catch (error) {
        //G 查询失败时回空列表并说明原因。
        const detail = textModule.getErrorMessage(error);
        return { ok: false, lines: [], error: detail };
      }
    }
    if (filesMirror === undefined) return {};

    const row = { bot: request.bot, id: request.sessionId };

    //M 只用机器人名和会话号定位镜像目录。
    const dir = filesMirror.getDir(row);
    return { dir };
  });

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口；没挂 http 就不开。
  void ctx.inject(['http'], (sub) => {
    sub.http.app.get<{
      Querystring: Record<string, string | undefined>;
    }>('/api/events', async (request, reply: fastify.FastifyReply) => {
      try {
        return journal.query(request.query);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    });
  });
}
