/**
 * 数据库：两张表（docs/10 第 4 节、6.3）。数据库是唯一的真相：先写这里，再照这里整份重写文件。
 *   messages  收件：渠道送来的每句话。状态 new 新到 → dispatching 分派中 → queued 已分派 → taken 已进会话
 *   sessions  会话：一件事从头到尾的对话。状态 idle 空闲 / running 运行中 / error 出错
 *
 * 打断 = 会话行写 interrupt；插话 = 消息行 status=queued 且 session_id 是这个会话。不另开表。
 * 改状态的地方都在一个同步事务里做（中间不 await）：机器人循环和会话循环同时动也不会把一条话漏掉——
 * endRun 和 queueMessages 各自一个事务，要么 endRun 看到排队的话、不结束，要么会话已经空闲、机器人循环再把它跑起来。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as sqlite from 'bun:sqlite';
import * as orm from 'drizzle-orm';
import * as drizzleSqlite from 'drizzle-orm/bun-sqlite';
import * as core from 'drizzle-orm/sqlite-core';
import * as utils from '../utils/Utils.ts';


/** 消息的四种状态。 */
export type MessageStatus = 'new' | 'dispatching' | 'queued' | 'taken' | 'held';

/** 会话的三种状态。 */
export type SessionStatus = 'idle' | 'running' | 'error';

/** 一次运行的四种结局：做完、被打断、到上限、出错（程序重启切断也算出错）。 */
export type RunEnding = 'done' | 'interrupted' | 'limit' | 'error';


/** 发出去的一条回复。 */
export interface Reply {
  /** 发出的时间，毫秒。 */
  at: number;
  /** 哪个会话回的：ID、标题、会话 md 的路径（消息文件的“结果”里带 @路径）。 */
  session: { id: string; title: string; file: string };
  /** 回了什么。 */
  text: string;
  /** 新回复的观察关联；历史回复没有，不能据此推断完整事件链。 */
  trace?: ReplyTrace;
  /** 这句文本本身的生成依据；历史没有时由只读恢复器保守读取。 */
  generation?: ReplyGeneration;
  /** 生成这句回复时固定的输入关联，不拿后来加入会话的消息倒推。 */
  association?: ReplyAssociation;
}


/** 每句回复的生成元信息；档位表示设置，不是质量或供应商实际执行的推断。 */
export interface ReplyGeneration {
  /** 直接模型文本、程序包装模型文字、程序通知或无法确认。 */
  kind: 'model' | 'model-wrapped' | 'program' | 'unknown';
  /** 成功生成调用的实际模型路由；程序或无依据时为空。 */
  model: string | null;
  /** 调用方要求的思考设置；历史未保存时为空。 */
  thinkingRequested: string | null;
  /** 本地 SDK 归一化后发送的思考设置，不代表供应商实际执行档位。 */
  thinkingSent: string | null;
  /** 供应商明确报告的实际档位；现有协议没有，保持为空。 */
  thinkingReported: string | null;
  /** 新快照、保存的助手消息、明确事件或无法确认。 */
  source: 'snapshot' | 'stored-assistant' | 'recorded-event' | 'unknown';
  /** 生成用途；未知为空，审核/分派不能冒充 session。 */
  purpose: string | null;
  /** 生成时所在运行；没有可靠记录时为空。 */
  run: number | null;
  /** 生成时所在步骤；没有可靠记录时为空。 */
  step: number | null;
  /** 助手消息自身的时间，Unix 毫秒；程序文字或未记录时为空。 */
  assistantAt: number | null;
  /** 生成此 reply 工具参数的调用号；最终文本或未记录时为空。 */
  callId: string | null;
}


/** 一句回复明确关联的收件号及可证明范围，与模型是否已知独立。 */
export interface ReplyAssociation {
  /** 只包含明确的来源收件号，不高亮整个会话的所有消息。 */
  messageIds: number[];
  /** turn 是新观察轮，旧资料按运行、分派批次或仅回复目标降级。 */
  scope: 'turn' | 'run' | 'batch' | 'target';
  /** 简短的关联依据，供界面显示范围限制，不是模型推理。 */
  source: string;
}


/** 一句成功回复产生时的边界；只记录关联，不参与执行。 */
export interface ReplyTrace {
  /** 会话的第几次运行，来自 SessionRun。 */
  run: number;
  /** 生成回复时走到的模型步数。 */
  step: number;
  /** 这次运行截至回复时实际收走的来源消息号。 */
  messageIds: number[];
  /** 本次 run.started 的持久事件号；写事件失败时没有。 */
  runEventId?: number;
  /** 最近一次真正送模型的 context.built 事件号。 */
  contextEventId?: number;
  /** 此回复成功发送的 reply.sent 事件号；链条只读到此处。 */
  eventId?: number;
  /** 新输入观察轮起点；仅影响只读显示范围，历史没有。 */
  turnEventId?: number;
}


/** 回复追踪只读查询；精确运行关联和消息关联取并集。 */
export interface TraceEventQuery {
  /** 机器人归属，避免其他机器人事件混入。 */
  bot: string;
  /** 明确关联的来源消息号。 */
  messageIds: number[];
  /** 由上述明确事件发现的上游外部任务号；不按时间猜任务关系。 */
  taskIds?: string[];
  /** 精确关联时的会话。 */
  sessionId?: string;
  /** 精确关联时第几次运行。 */
  run?: number;
  /** 精确运行的起始事件号，包含。 */
  firstEventId?: number;
  /** 运行 parent 链的真实根；新观察轮的显示起点可以晚于它。 */
  rootEventId?: number;
  /** 回复回执的事件号上界，包含。 */
  lastEventId?: number;
  /** 只有历史关联时使用的时间上界，毫秒；不能视作因果证据。 */
  beforeAt?: number;
  /** 最多取多少条；调用方多取一条判断截断。 */
  limit: number;
}


/** 收件表的一行（docs/10 4.1）。 */
export interface MessageRow {
  /** 消息号，自增。 */
  id: number;
  /** 哪个机器人的。 */
  bot: string;
  /** 渠道：http，或 feishu:<应用 ID>。 */
  channel: string;
  /** 来源，合批用：飞书 = 应用 + 聊天 + 发送人；HTTP = 请求里的 from。 */
  source: string;
  /** 回复地址：飞书是 chat_id、message_id 等；HTTP 是 {}。 */
  address: Record<string, unknown>;
  /** 消息文件的绝对路径。 */
  file: string;
  /** 原话（图片已换成 @路径）。 */
  text: string;
  /** 状态。 */
  status: MessageStatus;
  /** 进了哪个会话（分派完才有）。 */
  sessionId: string | null;
  /** 分派记录（Dispatch.ts 的 DispatchRecord）：结论 + 全过程；分派完才有。 */
  dispatch: unknown;
  /** 发出去的回复。 */
  replies: Reply[];
  /** 收到的时间，毫秒。 */
  createdAt: number;
  /** 最后改动的时间，毫秒。 */
  updatedAt: number;
}


/** 会话里存的一条消息（docs/10 4.2）。 */
export interface StoredMessage {
  /** Pi 格式的消息：用户、助手、工具结果（助手消息里本来就记着模型和用量）。 */
  message: piAi.Message;
  /** 第几次运行。 */
  run: number;
  /** 用户消息对应的消息号。 */
  messageIds?: number[];
  /** true 表示这条是压缩摘要：拼上下文从最后一条摘要开始。 */
  summary?: boolean;
  /** 工具读到的图片路径：调模型时才转成 base64，文件里只写路径。 */
  images?: string[];
  /** 助手消息：这一步实际用的思考强度。 */
  effort?: string;
  /** 常规助手调用的生成快照；压缩、审核不写到这里。 */
  generation?: ReplyGeneration;
  /** 该次助手生成时固定的本轮输入，多个 reply 工具共享。 */
  association?: ReplyAssociation;
}


/** 一次运行。 */
export interface RunInfo {
  /** 第几次，从 1 数。 */
  n: number;
  /** 开始时间，毫秒。 */
  startedAt: number;
  /** 结束时间，毫秒；还在跑时没有。 */
  endedAt?: number;
  /** 结局；还在跑时没有。 */
  ending?: RunEnding;
  /** 走了几步（调了几次模型）。 */
  steps: number;
}


/** 会话表的一行（docs/10 4.2）。 */
export interface SessionRow {
  /** 17 位时间 + 3 位随机。 */
  id: string;
  /** 哪个机器人的。 */
  bot: string;
  /** 工作区名。 */
  workspace: string;
  /** 标题。 */
  title: string;
  /** summary 工具写的摘要。 */
  summary: string;
  /** 现在用的模型（分派定；换过就是新的）。 */
  model: string;
  /** 思考档；null = 这个模型的最高档。 */
  thinking: string | null;
  /** 状态。 */
  status: SessionStatus;
  /** 全部对话（不含系统提示词）。 */
  messages: StoredMessage[];
  /** 上一次调模型时上下文有多长（token）。 */
  tokens: number;
  /** 要求打断它的那条消息号；没有是 null。 */
  interrupt: number | null;
  /** 回复发给哪条消息（最近一条进会话的）。 */
  replyTo: number | null;
  /** 每次运行一项。 */
  runs: RunInfo[];
  /** 感应点：自动感应上次看到哪个时间，毫秒；新开时就是开会话的时间。 */
  sensedAt: number;
  /** 创建时间，毫秒。 */
  createdAt: number;
  /** 最后改动的时间，毫秒。 */
  updatedAt: number;
}


/** updateSession 能改的字段。 */
export type SessionPatch = Partial<Pick<SessionRow, 'title' | 'summary' | 'model' | 'thinking' | 'status' | 'messages' | 'tokens' | 'interrupt' | 'replyTo' | 'runs' | 'sensedAt'>>;


/** 搜会话时给的一个会话：不带对话全文（messages 很大）。 */
export type SessionBrief = Pick<SessionRow, 'id' | 'bot' | 'workspace' | 'title' | 'summary' | 'updatedAt'>;


/** 事件表的一行（docs/11 第 4.1 节）：只是记录，不驱动任何流程。 */
export interface EventRow {
  /** 号：自增，进程重启也不重置，按它排就是先后。 */
  id: number;
  /** 类型，点分层，如 tool.after。 */
  type: string;
  /** 时间，毫秒。 */
  at: number;
  /** 谁发的：BotLoop、Dispatch、AgentLoop、Tools、EventWatch…… */
  source: string;
  /** 哪个机器人的。 */
  bot: string | null;
  /** 哪个会话的。 */
  sessionId: string | null;
  /** 哪条消息的（一批时是最后一条）。 */
  messageId: number | null;
  /** 去重的键（例程用；会话里的事件不带）。 */
  key: string | null;
  /** 数据：过了密钥替身、截过的。 */
  data: Record<string, unknown>;
  /** 引出它的事件。 */
  parent: number | null;
  /** 事件链第几层：自己发起的是 0。 */
  depth: number;
}


/** 查事件的条件。 */
export interface EventQuery {
  /** 只要这个类型的；结尾写 .* 是这一层下面都要（如 tool.*）。 */
  type?: string;
  /** 只要这个会话的。 */
  sessionId?: string;
  /** 只要这个时间（毫秒）以后的。 */
  since?: number;
  /** 最多几条（取最新的这么多条）。 */
  limit: number;
}


/** 用量表的一行（和 src/capabilities/Model.ts 的 UsageRecord 一样；这里不 import 模型库）。 */
export interface UsageRow {
  /** 时间，毫秒。 */
  at: number;
  /** 供应商。 */
  provider: string;
  /** 模型 ID。 */
  model: string;
  /** chat 或 decide。 */
  kind: string;
  /** 谁调的。 */
  purpose: string;
  /** 哪个机器人。 */
  bot?: string;
  /** 哪个会话。 */
  sessionId?: string;
  /** 输入 token。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** 缓存读 token。 */
  cacheRead: number;
  /** 缓存写 token。 */
  cacheWrite: number;
  /** 钱，美元。 */
  cost: number;
  /** 用时，毫秒。 */
  ms: number;
  /** 成没成。 */
  ok: boolean;
  /** 出错原因。 */
  error?: string;
}


/** 统计用量的条件（docs/15 第 3 节）。 */
export interface UsageQuery {
  /** 按什么时间段合计：每小时、每天、每周、每月（服务器本地时间）。 */
  by: 'hour' | 'day' | 'week' | 'month';
  /** 按什么分组：供应商、模型、谁调的、机器人。 */
  group: 'provider' | 'model' | 'purpose' | 'bot';
  /** 从什么时候（毫秒，含）。 */
  from: number;
  /** 到什么时候（毫秒，不含）。 */
  to: number;
}


/** 一个时间段、一组的合计。 */
export interface UsageBucket {
  /** 时间段：2026-11-07 13:00、2026-11-07、2026-W45、2026-11。 */
  period: string;
  /** 分组的值：供应商、模型、谁调的、机器人。 */
  key: string;
  /** 调了几次。 */
  calls: number;
  /** 失败几次。 */
  failures: number;
  /** 输入 token。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** 缓存读 token。 */
  cacheRead: number;
  /** 缓存写 token。 */
  cacheWrite: number;
  /** 钱，美元。 */
  cost: number;
  /** 用时合计，毫秒。 */
  ms: number;
}


/** 时间段 → SQLite strftime 的格式。 */
const USAGE_PERIOD_FORMATS: Record<UsageQuery['by'], string> = {
  hour: '%Y-%m-%d %H:00',
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
};


/** 分组 → 列（只许这几个，免得拼 SQL 出事）。 */
const USAGE_GROUP_COLUMNS: Record<UsageQuery['group'], string> = {
  provider: 'provider',
  model: 'model',
  purpose: 'purpose',
  bot: "COALESCE(bot, '')",
};


/** 收件表。 */
const messages = core.sqliteTable('messages', {
  id: core.integer('id').primaryKey({ autoIncrement: true }),
  bot: core.text('bot').notNull(),
  channel: core.text('channel').notNull(),
  source: core.text('source').notNull(),
  address: core.text('address', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  file: core.text('file').notNull(),
  text: core.text('text').notNull(),
  status: core.text('status', { enum: ['new', 'dispatching', 'queued', 'taken', 'held'] }).notNull(),
  sessionId: core.text('session_id'),
  dispatch: core.text('dispatch', { mode: 'json' }).$type<unknown>(),
  replies: core.text('replies', { mode: 'json' }).$type<Reply[]>().notNull(),
  createdAt: core.integer('created_at').notNull(),
  updatedAt: core.integer('updated_at').notNull(),
});


/** 会话表。 */
const sessions = core.sqliteTable('sessions', {
  id: core.text('id').primaryKey(),
  bot: core.text('bot').notNull(),
  workspace: core.text('workspace').notNull(),
  title: core.text('title').notNull(),
  summary: core.text('summary').notNull(),
  model: core.text('model').notNull(),
  thinking: core.text('thinking'),
  status: core.text('status', { enum: ['idle', 'running', 'error'] }).notNull(),
  messages: core.text('messages', { mode: 'json' }).$type<StoredMessage[]>().notNull(),
  tokens: core.integer('tokens').notNull(),
  interrupt: core.integer('interrupt'),
  replyTo: core.integer('reply_to'),
  runs: core.text('runs', { mode: 'json' }).$type<RunInfo[]>().notNull(),
  sensedAt: core.integer('sensed_at').notNull(),
  createdAt: core.integer('created_at').notNull(),
  updatedAt: core.integer('updated_at').notNull(),
});


/** 事件表（docs/11 第 4.1 节）。 */
const events = core.sqliteTable('events', {
  id: core.integer('id').primaryKey({ autoIncrement: true }),
  type: core.text('type').notNull(),
  at: core.integer('at').notNull(),
  source: core.text('source').notNull(),
  bot: core.text('bot'),
  sessionId: core.text('session_id'),
  messageId: core.integer('message_id'),
  key: core.text('key'),
  data: core.text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  parent: core.integer('parent'),
  depth: core.integer('depth').notNull(),
});


/** 记过的键（docs/11 第 4.2 节）：同一个类型、同一个键第二次来就不算新事件；不随事件过期删。 */
const eventKeys = core.sqliteTable(
  'event_keys',
  {
    type: core.text('type').notNull(),
    key: core.text('key').notNull(),
    firstEvent: core.integer('first_event').notNull(),
    firstAt: core.integer('first_at').notNull(),
  },
  (table) => [core.primaryKey({ columns: [table.type, table.key] })],
);


/** 事件链最多往上找几层、一共取多少条（防事件链太长时一次取太多）。 */
const CHAIN_MAX_UP = 50;

/** 一条事件的整串最多取多少条。 */
const CHAIN_MAX_ROWS = 500;


/** 建表语句（手写，和上面的定义一一对应）。 */
const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL,
  address TEXT NOT NULL,
  file TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  dispatch TEXT,
  replies TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_bot_status ON messages (bot, status);
CREATE INDEX IF NOT EXISTS messages_session_status ON messages (session_id, status);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  status TEXT NOT NULL,
  messages TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  interrupt INTEGER,
  reply_to INTEGER,
  runs TEXT NOT NULL,
  sensed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_bot ON sessions (bot, updated_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  bot TEXT,
  session_id TEXT,
  message_id INTEGER,
  key TEXT,
  data TEXT NOT NULL,
  parent INTEGER,
  depth INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type ON events (type, at);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id, at);
CREATE INDEX IF NOT EXISTS events_parent ON events (parent);
CREATE INDEX IF NOT EXISTS events_message ON events (message_id, id);
CREATE TABLE IF NOT EXISTS model_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  purpose TEXT NOT NULL,
  bot TEXT,
  session_id TEXT,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost REAL NOT NULL,
  ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS model_usage_at ON model_usage (at);
CREATE TABLE IF NOT EXISTS event_keys (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  first_event INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (type, key)
);
`;


/** 合批时最早那条最多等多久，毫秒（docs/10 5.2：一直在来，最早那条最多等 10 秒）。 */
export const MAX_MERGE_WAIT_MS = 10_000;


/**
 * 建表（已有的不动）。
 * @param client SQLite 连接。
 * @returns 无。
 * 副作用：设 PRAGMA、建表和索引。
 */
function migrate(client: sqlite.Database): void {
  //M 等锁 5 秒（几个进程同时开着时会抢锁）、WAL（读写不互相挡）。
  client.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  client.exec(CREATE_TABLES);
}


/** 搜消息时 SQL 先多取几倍再核对：回复是 JSON 原文，LIKE 会误中键名（text、file 这些）。 */
const SEARCH_OVERFETCH = 4;


/**
 * LIKE 的样子：两边加 %，关键字里的 %、_、\ 转义（配 ESCAPE '\'）。
 * @param keyword 关键字。
 */
function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}


/**
 * 文字里有没有这个关键字（不分大小写）。
 * @param text 文字。
 * @param keyword 关键字。
 */
function includesFolded(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}


/**
 * 收件表的一行转成对象。
 * @param row drizzle 读出来的一行。
 * @returns 收件。
 */
function toMessage(row: typeof messages.$inferSelect): MessageRow {
  return { ...row, dispatch: row.dispatch ?? null };
}


/**
 * 会话表的一行转成对象。
 * @param row drizzle 读出来的一行。
 * @returns 会话。
 */
function toSession(row: typeof sessions.$inferSelect): SessionRow {
  return { ...row };
}


/** 只用来读的数据库或事务（hasQueued、mustSession 在事务里和事务外都要用）。 */
type DbReader = Pick<drizzleSqlite.BunSQLiteDatabase, 'select'>;


/** updateSession 以外 listMessages 用的筛选。 */
export interface MessageFilter {
  /** 只要号比它小的。 */
  before?: number;
  /** 只要 updatedAt 不早于它的。 */
  after?: number;
  /** 给了就只取其中最新的这么多条。 */
  limit?: number;
  /** 只要这些状态。 */
  statuses?: MessageStatus[];
  /** 只要这个来源的。 */
  source?: string;
  /** 不要这个来源的。 */
  notSource?: string;
}


/**
 * 数据库：两张表的读写。构造时打开数据库（没有就建）、建表；用 new Store(file) 创建。
 * 入口建一个，传给用到的对象。
 */
export class Store {
  /** SQLite 连接。 */
  private readonly client: sqlite.Database;
  /** drizzle，所有读写都走它。 */
  private readonly db: drizzleSqlite.BunSQLiteDatabase;

  /**
   * 打开数据库（没有就建），建表。
   * @param file 数据库文件路径；测试可以给 ':memory:'。
   * 副作用：建文件、建表。
   */
  constructor(file: string) {
    //M 开库、建表，再接上 drizzle。
    this.client = new sqlite.Database(file, { create: true });
    migrate(this.client);
    this.db = drizzleSqlite.drizzle(this.client);
  }

  /**
   * 这个会话还有没有排队的话。
   * @param tx 事务。
   * @param sessionId 会话 ID。
   */
  private hasQueued(tx: DbReader, sessionId: string): boolean {
    /** 这个会话排队中的条件。 */
    const queuedOfSession = orm.and(
      orm.eq(messages.sessionId, sessionId),
      orm.eq(messages.status, 'queued'),
    );
    /** 查到的（最多一条）。 */
    const found = tx.select({ id: messages.id }).from(messages).where(queuedOfSession).limit(1).all();
    return found.length > 0;
  }

  /**
   * 读一个会话（在事务里）。
   * @param tx 事务或数据库。
   * @param id 会话 ID。
   * @throws 没有这个会话时抛错。
   */
  private mustSession(tx: DbReader, id: string): SessionRow {
    /** 那一行。 */
    const row = tx.select().from(sessions).where(orm.eq(sessions.id, id)).get();
    if (!row) {
      throw new Error(`没有会话 ${id}`);
    }
    return toSession(row);
  }

  /** 记一条收件，状态 new。输入渠道收到的东西，输出新的一行；写库。 */
  addMessage(
    input: Pick<MessageRow, 'bot' | 'channel' | 'source' | 'address' | 'file' | 'text'>,
  ): MessageRow {
    //M 补上状态和时间，插入并取回那一行。
    /** 现在。 */
    const now = Date.now();
    /** 要插入的一行。 */
    const values = {
      ...input,
      status: 'new' as const,
      sessionId: null,
      dispatch: null,
      replies: [],
      createdAt: now,
      updatedAt: now,
    };
    return toMessage(this.db.insert(messages).values(values).returning().get());
  }

  /** 合批领消息：找一个“最后一条到了以后已经静了 mergeMs、或者最早那条已经等了 10 秒”的来源，把它所有 new 的改成 dispatching，按先后返回；没有就返回空。写库。 */
  takeNewBatch(bot: string, mergeMs: number, now = Date.now()): MessageRow[] {
    return this.db.transaction((tx) => {
      //M 1. 这个机器人所有新到的，按来源分组：每组最早、最晚一条的时间。
      /** 新到的条件。 */
      const isNew = orm.and(orm.eq(messages.bot, bot), orm.eq(messages.status, 'new'));
      /** 新到的。 */
      const fresh = tx.select().from(messages).where(isNew).orderBy(messages.id).all();
      /** 来源 → 最早、最晚。 */
      const groups = new Map<string, { first: number; last: number }>();
      for (const row of fresh) {
        /** 已有的组。 */
        const group = groups.get(row.source);
        groups.set(row.source, {
          first: group ? Math.min(group.first, row.createdAt) : row.createdAt,
          last: group ? Math.max(group.last, row.createdAt) : row.createdAt,
        });
      }
      //M 2. 静够了 mergeMs、或者最早那条等满 10 秒的来源里，挑最早来的那个。
      /** 选中的来源。 */
      let chosen: string | undefined;
      /** 选中来源最早一条的时间。 */
      let chosenFirst = Infinity;
      for (const [source, group] of groups) {
        /** 静够了，或者最早那条等满了。 */
        const ready = now - group.last >= mergeMs || now - group.first >= MAX_MERGE_WAIT_MS;
        if (ready && group.first < chosenFirst) {
          chosen = source;
          chosenFirst = group.first;
        }
      }
      if (chosen === undefined) {
        return [];
      }
      //M 3. 这个来源所有新到的一起领走。
      /** 领走的。 */
      const batch = fresh.filter((row) => row.source === chosen);
      /** 领走的消息号。 */
      const batchIds = batch.map((row) => row.id);
      tx.update(messages)
        .set({ status: 'dispatching', updatedAt: now })
        .where(orm.inArray(messages.id, batchIds))
        .run();
      return batch.map((row) => toMessage({ ...row, status: 'dispatching', updatedAt: now }));
    });
  }

  /** 读一条收件；没有是 undefined。 */
  getMessage(id: number): MessageRow | undefined {
    /** 那一行。 */
    const row = this.db.select().from(messages).where(orm.eq(messages.id, id)).get();
    return row ? toMessage(row) : undefined;
  }

  /** 网页用的只读列表（docs/界面/01_界面设计.md 第 12 节），按消息号从小到大：source 只要这个来源的，notSource 不要这个来源的，before 只要号比它小的，after 只要 updatedAt 不早于它的，statuses 只要这些状态；给了 limit 只取其中最新的 limit 条。 */
  listMessages(bot: string, filter: MessageFilter = {}): MessageRow[] {
    //M 1. 拼条件。
    /** 条件。 */
    const conditions = [orm.eq(messages.bot, bot)];
    if (filter.before !== undefined) {
      conditions.push(orm.lt(messages.id, filter.before));
    }
    if (filter.after !== undefined) {
      conditions.push(orm.gte(messages.updatedAt, filter.after));
    }
    if (filter.statuses?.length) {
      conditions.push(orm.inArray(messages.status, filter.statuses));
    }
    if (filter.source !== undefined) {
      conditions.push(orm.eq(messages.source, filter.source));
    }
    if (filter.notSource !== undefined) {
      conditions.push(orm.ne(messages.source, filter.notSource));
    }
    //M 2. 新的在前取 limit 条，再倒回从小到大。
    /** 查询。 */
    const query = this.db
      .select()
      .from(messages)
      .where(orm.and(...conditions))
      .orderBy(orm.desc(messages.id));
    /** 取出来的行（新的在前）。 */
    const rows = filter.limit === undefined ? query.all() : query.limit(filter.limit).all();
    return rows.reverse().map(toMessage);
  }

  /** 这条不进会话（用户在回答待确认）：直接收掉。写库。 */
  closeMessage(id: number): void {
    this.db
      .update(messages)
      .set({ status: 'taken', updatedAt: Date.now() })
      .where(orm.eq(messages.id, id))
      .run();
  }

  /** 这批要等一条待确认有结果才能做：改成 held，记下分派记录。写库。 */
  holdMessages(ids: number[], record: unknown): void {
    this.db
      .update(messages)
      .set({ status: 'held', dispatch: record, updatedAt: Date.now() })
      .where(orm.inArray(messages.id, ids))
      .run();
  }

  /** 等的那条待确认有结果了：这批改回新到，重新分派。写库。 */
  releaseMessages(ids: number[]): void {
    /** 只放这批里还在 held 的。 */
    const heldOfIds = orm.and(orm.inArray(messages.id, ids), orm.eq(messages.status, 'held'));
    this.db
      .update(messages)
      .set({ status: 'new', dispatch: null, updatedAt: Date.now() })
      .where(heldOfIds)
      .run();
  }

  /** 分好了：这批改成 queued，记下会话和分派记录。写库。 */
  queueMessages(ids: number[], sessionId: string, record: unknown): void {
    this.db
      .update(messages)
      .set({ status: 'queued', sessionId, dispatch: record, updatedAt: Date.now() })
      .where(orm.inArray(messages.id, ids))
      .run();
  }

  /** 会话收走排给它的话：queued → taken，按先后返回。写库。 */
  takeQueued(sessionId: string): MessageRow[] {
    return this.db.transaction((tx) => {
      //M 1. 排给它的。
      /** 排给它的条件。 */
      const queuedOfSession = orm.and(
        orm.eq(messages.sessionId, sessionId),
        orm.eq(messages.status, 'queued'),
      );
      /** 排给它的。 */
      const rows = tx.select().from(messages).where(queuedOfSession).orderBy(messages.id).all();
      if (rows.length === 0) {
        return [];
      }
      //M 2. 改成 taken。
      /** 现在。 */
      const now = Date.now();
      /** 收走的消息号。 */
      const rowIds = rows.map((row) => row.id);
      tx.update(messages)
        .set({ status: 'taken', updatedAt: now })
        .where(orm.inArray(messages.id, rowIds))
        .run();
      return rows.map((row) => toMessage({ ...row, status: 'taken', updatedAt: now }));
    });
  }

  /** 往这条消息的回复里加一条。写库。 */
  addReply(id: number, reply: Reply): void {
    this.db.transaction((tx) => {
      /** 那一行。 */
      const row = tx
        .select({ replies: messages.replies })
        .from(messages)
        .where(orm.eq(messages.id, id))
        .get();
      if (!row) {
        throw new Error(`没有消息 #${id}`);
      }
      tx.update(messages)
        .set({ replies: [...row.replies, reply], updatedAt: Date.now() })
        .where(orm.eq(messages.id, id))
        .run();
    });
  }

  /** 新开会话，状态空闲，感应点是现在。写库。 */
  createSession(
    input: Pick<SessionRow, 'bot' | 'workspace' | 'title' | 'model' | 'thinking'>,
  ): SessionRow {
    //M 会话 ID 同一毫秒撞上时换一个再试（主键拦下）。
    for (let attempt = 0; ; attempt += 1) {
      /** 现在。 */
      const now = Date.now();
      try {
        /** 要插入的一行。 */
        const values = {
          ...input,
          id: utils.createSessionId(),
          summary: '',
          status: 'idle' as const,
          messages: [],
          tokens: 0,
          interrupt: null,
          replyTo: null,
          runs: [],
          sensedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        return toSession(this.db.insert(sessions).values(values).returning().get());
      } catch (error) {
        if (attempt >= 5 || !/UNIQUE|PRIMARY/i.test(utils.errorText(error))) {
          throw error;
        }
      }
    }
  }

  /** 读一个会话；没有是 undefined。 */
  getSession(id: string): SessionRow | undefined {
    /** 那一行。 */
    const row = this.db.select().from(sessions).where(orm.eq(sessions.id, id)).get();
    return row ? toSession(row) : undefined;
  }

  /** 这个机器人的会话，最近的在前；keyword 搜标题和摘要。 */
  listSessions(
    bot: string,
    filter: { workspace?: string; status?: SessionStatus; keyword?: string } = {},
  ): SessionRow[] {
    /** 条件。 */
    const conditions = [orm.eq(sessions.bot, bot)];
    if (filter.workspace) {
      conditions.push(orm.eq(sessions.workspace, filter.workspace));
    }
    if (filter.status) {
      conditions.push(orm.eq(sessions.status, filter.status));
    }
    if (filter.keyword) {
      /** like 的样子。 */
      const like = `%${filter.keyword}%`;
      conditions.push(orm.or(orm.like(sessions.title, like), orm.like(sessions.summary, like))!);
    }
    return this.db
      .select()
      .from(sessions)
      .where(orm.and(...conditions))
      .orderBy(orm.desc(sessions.updatedAt))
      .all()
      .map(toSession);
  }

  /** 搜消息（docs/界面/01_界面设计.md 6.1）：原话或某条回复的文字里有这个关键字的（不分大小写，% _ \ 当普通字），号大的在前，最多 limit 条；不给 bot 搜所有机器人。只读。 */
  searchMessages(keyword: string, filter: { bot?: string; limit: number }): MessageRow[] {
    //M 1. 条件：原话或回复（JSON 原文）里有。
    /** LIKE 的样子。 */
    const pattern = likePattern(keyword);
    /** 原话里有。 */
    const inText = orm.sql`${messages.text} LIKE ${pattern} ESCAPE '\\'`;
    /** 回复里有。 */
    const inReplies = orm.sql`${messages.replies} LIKE ${pattern} ESCAPE '\\'`;
    /** 条件。 */
    const conditions = [orm.or(inText, inReplies)!];
    if (filter.bot) {
      conditions.push(orm.eq(messages.bot, filter.bot));
    }
    //M 2. SQL 粗筛多取几倍，再核对原话或某条回复的文字里真有（去掉只命中 JSON 键名的）。
    /** 粗筛出来的。 */
    const rows = this.db
      .select()
      .from(messages)
      .where(orm.and(...conditions))
      .orderBy(orm.desc(messages.id))
      .limit(filter.limit * SEARCH_OVERFETCH)
      .all()
      .map(toMessage);
    return rows
      .filter((row) => {
        return includesFolded(row.text, keyword)
          || row.replies.some((item) => includesFolded(item.text, keyword));
      })
      .slice(0, filter.limit);
  }

  /** 搜会话：标题或摘要里有这个关键字的，最近更新的在前，最多 limit 条；不给 bot 搜所有机器人；不带对话全文。只读。 */
  searchSessions(keyword: string, filter: { bot?: string; limit: number }): SessionBrief[] {
    //M 1. 条件：标题或摘要里有。
    /** LIKE 的样子。 */
    const pattern = likePattern(keyword);
    /** 标题里有。 */
    const inTitle = orm.sql`${sessions.title} LIKE ${pattern} ESCAPE '\\'`;
    /** 摘要里有。 */
    const inSummary = orm.sql`${sessions.summary} LIKE ${pattern} ESCAPE '\\'`;
    /** 条件。 */
    const conditions = [orm.or(inTitle, inSummary)!];
    if (filter.bot) {
      conditions.push(orm.eq(sessions.bot, filter.bot));
    }
    //M 2. 不带对话全文，只取简要几列。
    /** 要取的列。 */
    const columns = {
      id: sessions.id,
      bot: sessions.bot,
      workspace: sessions.workspace,
      title: sessions.title,
      summary: sessions.summary,
      updatedAt: sessions.updatedAt,
    };
    return this.db
      .select(columns)
      .from(sessions)
      .where(orm.and(...conditions))
      .orderBy(orm.desc(sessions.updatedAt))
      .limit(filter.limit)
      .all();
  }

  /** 改会话的字段，顺带更新 updated_at。写库。 */
  updateSession(id: string, patch: SessionPatch): SessionRow {
    return this.db.transaction((tx) => {
      this.mustSession(tx, id);
      tx.update(sessions)
        .set({ ...patch, updatedAt: Date.now() })
        .where(orm.eq(sessions.id, id))
        .run();
      return this.mustSession(tx, id);
    });
  }

  /** 开始一次运行：空闲或出错 → 运行中，runs 里加一项，返回 true；已在运行返回 false。写库。 */
  beginRun(id: string): boolean {
    return this.db.transaction((tx) => {
      /** 会话。 */
      const session = this.mustSession(tx, id);
      if (session.status === 'running') {
        return false;
      }
      /** 现在。 */
      const now = Date.now();
      /** 加上这一次的 runs。 */
      const runs = [...session.runs, { n: session.runs.length + 1, startedAt: now, steps: 0 }];
      //M 上次运行没来得及看的打断（分派写上时它正好在收尾）不带进这一次。
      tx.update(sessions)
        .set({ status: 'running', interrupt: null, runs, updatedAt: now })
        .where(orm.eq(sessions.id, id))
        .run();
      return true;
    });
  }

  /** 结束一次运行：还有排队的话就不结束、返回 false；否则记下结局，改回空闲（出错时改成出错），返回 true。写库。 */
  endRun(id: string, ending: RunEnding): boolean {
    return this.db.transaction((tx) => {
      //G 正好又排来了话：不结束，会话循环回去收它。
      if (this.hasQueued(tx, id)) {
        return false;
      }
      /** 会话。 */
      const session = this.mustSession(tx, id);
      /** 现在。 */
      const now = Date.now();
      /** 最后一次运行的位置。 */
      const lastIndex = session.runs.length - 1;
      /** 记上结局的 runs。 */
      const runs = session.runs.map((run, index) => {
        return index === lastIndex && run.endedAt === undefined
          ? { ...run, endedAt: now, ending }
          : run;
      });
      tx.update(sessions)
        .set({ status: ending === 'error' ? 'error' : 'idle', runs, updatedAt: now })
        .where(orm.eq(sessions.id, id))
        .run();
      return true;
    });
  }

  /** 读出“谁要打断我”并清空；没人打断是 null。写库。 */
  takeInterrupt(id: string): number | null {
    return this.db.transaction((tx) => {
      /** 会话。 */
      const session = this.mustSession(tx, id);
      if (session.interrupt === null) {
        return null;
      }
      tx.update(sessions).set({ interrupt: null }).where(orm.eq(sessions.id, id)).run();
      return session.interrupt;
    });
  }

  /** 重启收拾：dispatching 的消息改回 new；运行中的会话改回空闲，那次运行记成出错；返回运行过的、或有排队消息的会话 ID。写库。 */
  recover(): string[] {
    return this.db.transaction((tx) => {
      /** 现在。 */
      const now = Date.now();
      //M 1. 分派到一半的消息：结论还没落库，改回新到，重新分派。等审核的也一样：待确认只在内存里，重启就没了。
      tx.update(messages)
        .set({ status: 'new', updatedAt: now })
        .where(orm.inArray(messages.status, ['dispatching', 'held']))
        .run();
      //M 2. 运行中的会话：改回空闲，那次运行记成出错（程序重启）。
      /** 要接着跑的会话。 */
      const ids = new Set<string>();
      /** 运行中的会话行。 */
      const runningRows = tx.select().from(sessions).where(orm.eq(sessions.status, 'running')).all();
      for (const row of runningRows) {
        /** 最后一次运行的位置。 */
        const lastIndex = row.runs.length - 1;
        /** 记上结局的 runs。 */
        const runs = row.runs.map((run, index) => {
          return index === lastIndex && run.endedAt === undefined
            ? { ...run, endedAt: now, ending: 'error' as const }
            : run;
        });
        tx.update(sessions)
          .set({ status: 'idle', runs, updatedAt: now })
          .where(orm.eq(sessions.id, row.id))
          .run();
        ids.add(row.id);
      }
      //M 3. 有排队消息的会话也要跑起来。
      /** 还在排队的消息。 */
      const queuedRows = tx
        .select({ sessionId: messages.sessionId })
        .from(messages)
        .where(orm.eq(messages.status, 'queued'))
        .all();
      for (const row of queuedRows) {
        if (row.sessionId) {
          ids.add(row.sessionId);
        }
      }
      return [...ids];
    });
  }

  /**
   * 记一条事件（docs/11 第 4 节）。带键时在同一个事务里先查记过的键：记过就不记；没记过两张表一起写。
   * @param row 事件（号由数据库给）。
   * @returns 新事件的号；键记过时 undefined。
   * 副作用：写 events（和 event_keys）。
   */
  addEvent(row: Omit<EventRow, 'id'>): number | undefined {
    return this.db.transaction((tx) => {
      //G 带键、而且记过：不算新事件。
      if (row.key !== null) {
        /** 记过的那个键。 */
        const known = tx
          .select({ type: eventKeys.type })
          .from(eventKeys)
          .where(orm.and(orm.eq(eventKeys.type, row.type), orm.eq(eventKeys.key, row.key)))
          .get();
        if (known) {
          return undefined;
        }
      }
      /** 写进去的那一行。 */
      const inserted = tx.insert(events).values(row).returning({ id: events.id }).get();
      if (row.key !== null) {
        tx.insert(eventKeys).values({ type: row.type, key: row.key, firstEvent: inserted.id, firstAt: row.at }).run();
      }
      return inserted.id;
    });
  }

  /**
   * 读一条事件；没有是 undefined。
   * @param id 事件号。
   */
  getEvent(id: number): EventRow | undefined {
    return this.db.select().from(events).where(orm.eq(events.id, id)).get();
  }

  /**
   * 查事件：按类型（全名或 xxx.*）、会话、时间，取最新的 limit 条，再按号从小到大给出（重放的顺序）。
   * @param query 条件。
   * @returns 事件。
   */
  listEvents(query: EventQuery): EventRow[] {
    /** 条件。 */
    const conditions: orm.SQL[] = [];
    if (query.type?.endsWith('.*')) {
      conditions.push(orm.like(events.type, `${query.type.slice(0, -1)}%`));
    } else if (query.type) {
      conditions.push(orm.eq(events.type, query.type));
    }
    if (query.sessionId) {
      conditions.push(orm.eq(events.sessionId, query.sessionId));
    }
    if (query.since !== undefined) {
      conditions.push(orm.gte(events.at, query.since));
    }
    /** 最新的 limit 条。 */
    const rows = this.db
      .select()
      .from(events)
      .where(orm.and(...conditions))
      .orderBy(orm.desc(events.id))
      .limit(Math.max(1, query.limit))
      .all();
    return rows.reverse();
  }

  /**
   * 读取一条回复的已记录事件；不补造事件，不改变任何消息状态。
   * 消息号匹配单条和批次；精确关联额外包含同一次运行的事件。
   * @param query 来源、运行和回复边界。
   * @returns 最新 limit 条，按持久事件号升序；与墙钟先后无关。
   */
  traceEvents(query: TraceEventQuery): EventRow[] {
    /** 明确属于这些消息的事件，包含合批和分派携带的数组。 */
    const messageConditions: orm.SQL[] = [];
    for (const id of query.messageIds) {
      messageConditions.push(orm.eq(events.messageId, id));
      messageConditions.push(orm.sql`EXISTS (
        SELECT 1 FROM json_each(${events.data}, '$.messageIds') WHERE value = ${id}
      )`);
    }

    /** 会话事件只有在存在运行号与边界时才纳入。 */
    const relatedConditions: orm.SQL[] = [];
    const messageCondition = orm.or(...messageConditions);
    if (messageCondition) {
      //G 有精确运行边界时，消息号只扩展收件/分派/入队等前置事件。
      //G 会话执行事件还必须通过下面的 run 条件，不能混入同一消息的另一次运行。
      const preRunCondition = query.run === undefined ? messageCondition : orm.and(
        messageCondition,
        orm.or(
          orm.isNull(events.sessionId),
          orm.inArray(events.type, ['message.received', 'message.queued', 'agent.delivered']),
        ),
      );
      if (preRunCondition) {
        relatedConditions.push(preRunCondition);
      }
    }
    for (const taskId of query.taskIds ?? []) {
      relatedConditions.push(orm.sql`json_extract(${events.data}, '$.taskId') = ${taskId}`);
    }
    if (query.sessionId && query.run !== undefined && query.firstEventId !== undefined) {
      /** 限时/观察事件沿 parent 指向运行起点，不一定带 run 字段。 */
      const lastEventId = query.lastEventId ?? Number.MAX_SAFE_INTEGER;
      const descendantCondition = orm.sql`${events.id} IN (
        WITH RECURSIVE run_chain(id) AS (
          SELECT id FROM events WHERE id = ${query.rootEventId ?? query.firstEventId}
          UNION
          SELECT child.id FROM events AS child
          JOIN run_chain AS ancestor ON child.parent = ancestor.id
          WHERE child.id <= ${lastEventId}
        )
        SELECT id FROM run_chain
      )`;
      const runCondition = orm.and(
        orm.eq(events.sessionId, query.sessionId),
        orm.gte(events.id, query.firstEventId),
        orm.or(
          orm.sql`json_extract(${events.data}, '$.run') = ${query.run}`,
          descendantCondition,
        ),
      );
      if (runCondition) {
        relatedConditions.push(runCondition);
      }
    }
    if (relatedConditions.length === 0) {
      return [];
    }

    /** 归属与上界都在数据库中筛选，避免先取最近事件而漏掉源头。 */
    const conditions = [orm.eq(events.bot, query.bot), orm.or(...relatedConditions)!];
    if (query.lastEventId !== undefined) {
      conditions.push(orm.lte(events.id, query.lastEventId));
    }
    if (query.beforeAt !== undefined) {
      conditions.push(orm.lte(events.at, query.beforeAt));
    }
    const rows = this.db.select().from(events)
      .where(orm.and(...conditions))
      .orderBy(orm.desc(events.id))
      .limit(query.limit)
      .all();

    return rows.reverse();
  }

  /**
   * 一条事件的整串：先顺着 parent 往上找到第 0 层，再从那里往下把引出来的都取出来，按号从小到大。
   * @param id 事件号。
   * @returns 整串；没有这条是空数组。
   */
  eventChain(id: number): EventRow[] {
    //M 1. 往上找到第 0 层。
    /** 现在看的这条。 */
    let top = this.db.select().from(events).where(orm.eq(events.id, id)).get();
    for (let up = 0; top?.parent && up < CHAIN_MAX_UP; up++) {
      /** 上一层。 */
      const parent = this.db.select().from(events).where(orm.eq(events.id, top.parent)).get();
      if (!parent) {
        break;
      }
      top = parent;
    }
    if (!top) {
      return [];
    }
    //M 2. 一层层往下取，直到取完或到上限。
    /** 取到的。 */
    const found: EventRow[] = [top];
    /** 这一层的号。 */
    let layer = [top.id];
    while (layer.length > 0 && found.length < CHAIN_MAX_ROWS) {
      /** 下一层。 */
      const children = this.db
        .select()
        .from(events)
        .where(orm.inArray(events.parent, layer))
        .limit(CHAIN_MAX_ROWS - found.length)
        .all();
      found.push(...children);
      layer = children.map((row) => row.id);
    }
    return found.sort((left, right) => left.id - right.id);
  }

  /**
   * 这个键记过没有。
   * @param type 事件类型。
   * @param key 键。
   */
  hasEventKey(type: string, key: string): boolean {
    /** 记过的那个。 */
    const row = this.db
      .select({ type: eventKeys.type })
      .from(eventKeys)
      .where(orm.and(orm.eq(eventKeys.type, type), orm.eq(eventKeys.key, key)))
      .get();
    return row !== undefined;
  }

  /**
   * 删掉一个记过的键（要重新来一次时）。
   * @param type 事件类型。
   * @param key 键。
   * @returns 有没有删到。
   * 副作用：改 event_keys。
   */
  deleteEventKey(type: string, key: string): boolean {
    /** 删掉的。 */
    const removed = this.db
      .delete(eventKeys)
      .where(orm.and(orm.eq(eventKeys.type, type), orm.eq(eventKeys.key, key)))
      .returning({ type: eventKeys.type })
      .all();
    return removed.length > 0;
  }

  /**
   * 删掉这个时间以前的事件（记过的键不删）。
   * @param before 时间，毫秒。
   * @returns 删了几条。
   * 副作用：改 events。
   */
  pruneEvents(before: number): number {
    return this.client.prepare('DELETE FROM events WHERE at < ?').run(before).changes;
  }

  /**
   * 记一次调模型的用量（docs/15）。
   * @param row 用量（src/capabilities/Model.ts 的 UsageRecord）。
   * 副作用：写 model_usage。
   */
  addUsage(row: UsageRow): void {
    this.client
      .prepare(
        'INSERT INTO model_usage (at, provider, model, kind, purpose, bot, session_id, input, output, cache_read, cache_write, cost, ms, ok, error) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.at,
        row.provider,
        row.model,
        row.kind,
        row.purpose,
        row.bot ?? null,
        row.sessionId ?? null,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        row.cost,
        row.ms,
        row.ok ? 1 : 0,
        row.error ?? null,
      );
  }

  /**
   * 读同会话时间窗内的历史用量；表里没有回复号，不能宣称精确归属。
   * @param sessionId 会话号。
   * @param from 起始时间，毫秒，含。
   * @param to 结束时间，毫秒，含。
   * @returns 最新 101 条，按表的持久号升序；第 101 条供调用方识别截断。
   */
  listUsage(sessionId: string, from: number, to: number): UsageRow[] {
    const statement = this.client.prepare(
      'SELECT at, provider, model, kind, purpose, bot, session_id AS sessionId, '
      + 'input, output, cache_read AS cacheRead, cache_write AS cacheWrite, cost, ms, ok, error '
      + 'FROM model_usage WHERE session_id = ? AND at >= ? AND at <= ? ORDER BY id DESC LIMIT 101',
    );
    const rows = statement.all(sessionId, from, to) as (Omit<UsageRow, 'ok'> & { ok: number })[];

    return rows.reverse().map((row) => ({ ...row, ok: row.ok === 1 }));
  }

  /**
   * 按时间段和分组合计用量（docs/15 第 3 节），时间段按服务器本地时间切。
   * @param query 按什么时间段、按什么分组、从什么时候到什么时候。
   * @returns 每个时间段、每一组一行，按时间段、分组排。
   */
  usageReport(query: UsageQuery): UsageBucket[] {
    /** 时间段的格式。 */
    const format = USAGE_PERIOD_FORMATS[query.by];
    /** 分组的列。 */
    const column = USAGE_GROUP_COLUMNS[query.group];
    return this.client
      .prepare(
        `SELECT strftime('${format}', at / 1000, 'unixepoch', 'localtime') AS period, ${column} AS key, `
          + 'COUNT(*) AS calls, SUM(1 - ok) AS failures, SUM(input) AS input, SUM(output) AS output, '
          + 'SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cost) AS cost, SUM(ms) AS ms '
          + 'FROM model_usage WHERE at >= ? AND at < ? GROUP BY period, key ORDER BY period, key',
      )
      .all(query.from, query.to) as UsageBucket[];
  }
}
