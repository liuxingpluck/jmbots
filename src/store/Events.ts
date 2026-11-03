/**
 * 数据库（SQLite + Drizzle）：jmbots 的正式记录都在这里，日志文件从这里生成（用户 11-02 选的方案 A）。
 *
 * 六张表：
 *   jmbot_sessions       会话：归哪个机器人、智能体或模型，放在哪个工作区，从哪来（命令行、HTTP、飞书），现在什么状态
 *   jmbot_events         事件：一条输入就是一个 execution 事件，事件循环取 pending 的来执行；
 *                        分派、每步判断、exec 审核的结论也记成事件（直接是 completed，不进队列）
 *   jmbot_model_requests 每一步模型调用：实际发给模型的请求、模型的回复（每步一行，step 从 1 数）
 *   jmbot_tool_results   工具调用：执行前先记 in_progress，执行完写结果；程序中途死掉时留下 in_progress，表示“结果未知”
 *   jmbot_exec_approvals 等人确认的 exec 命令
 *   jmbot_inbox          收件表：渠道收到的每句话先记在这里（new 未分派），事件循环领去分派（routing），分派完记下结果（done）。
 *                        用户 11-03：“投递过来没有被消费……被消费了”；重启不丢话，界面能看到哪些话还在排队。
 *
 * 用户 11-02 的要求：工具执行不当成事件（防止重复执行），执行完写进对应的列；结果缺失时让 AI 自己决定要不要重做。
 *
 * TODO（记在 docs/03_进度与待办.md）：建表语句现在是手写的 CREATE TABLE IF NOT EXISTS，以后换成 drizzle-kit 生成的迁移。
 */
import * as sqlite from 'bun:sqlite';
import * as orm from 'drizzle-orm';
import * as drizzleSqlite from 'drizzle-orm/bun-sqlite';
import * as core from 'drizzle-orm/sqlite-core';
import * as utils from '../utils/Utils.ts';


/** 会话表。 */
const sessions = core.sqliteTable('jmbot_sessions', {
  /** 20 位纯数字：年月日时分秒毫秒 + 3 位随机数字。主键保证不重复。 */
  id: core.text('id').primaryKey(),
  /** 标题：分派时 AI 起的，没经过分派的是第一条输入的开头；日志文件夹名是“会话ID_标题”，定了就不改。 */
  title: core.text('title').notNull(),
  /** task 执行对话；route 分派对话（机器人决定一句话交给哪个会话，标题以“分派_”开头）。 */
  kind: core.text('kind').$type<'task' | 'route'>().notNull(),
  /** 归哪个机器人；没有时是 null，会话日志放在 logs/常规 下面。 */
  bot: core.text('bot'),
  /** 用哪个智能体；没有时是 null。 */
  agent: core.text('agent'),
  /** 只给模型时是那个模型；交给机器人、智能体时是分派指定的模型（覆盖角色自己的）；没有时是 null。 */
  model: core.text('model'),
  /** 分派指定的思考强度（覆盖角色自己的）；没有时是 null。 */
  thinking: core.text('thinking'),
  /** 工作区名字。 */
  workspace: core.text('workspace').notNull(),
  /** 从哪来：命令行、HTTP、飞书私聊 oc_xxx、AI（taskdbinsert）……同一来源接着最近的会话聊。 */
  source: core.text('source').notNull(),
  /** 空闲（可以接着说）、执行中、等待确认、出错。 */
  status: core.text('status').notNull(),
  /** 最近一次执行结束时回给用户的话。 */
  lastReply: core.text('last_reply'),
  /** 创建时间，毫秒。 */
  createdAt: core.integer('created_at').notNull(),
  /** 最近活动时间，毫秒。 */
  updatedAt: core.integer('updated_at').notNull(),
});


/** 事件表。 */
const events = core.sqliteTable('jmbot_events', {
  /** 自增 ID。 */
  id: core.integer('id').primaryKey({ autoIncrement: true }),
  /** 所属会话。 */
  sessionId: core.text('session_id').notNull().references(() => sessions.id),
  /** 上级事件：分派、判断、审核记录挂在它们所属的 execution 下面；execution 自己是 null。 */
  parentId: core.integer('parent_id'),
  /**
   * execution（要执行的输入）、dispatch（新会话交给谁）、judge（每步判断）、exec_review（exec 审核）、
   * route_result（分派对话的结论）、route（执行对话是哪个分派对话派来的）、approval_decided（待确认被谁用什么方式决定了）、
   * sent（渠道把这个会话的回复发出去了，payload 里有渠道的消息 ID，用户引用回复时按它找回会话）、
   * watchdog（看门狗发现这次执行很久没有新步骤）。
   */
  type: core.text('type').notNull(),
  /** 内容：execution 是 StartInput，其他是各自的结论。 */
  payload: core.text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  /** pending 等着执行、running 执行中、paused 等人确认、completed 完成、failed 失败。 */
  status: core.text('status', { enum: ['pending', 'running', 'paused', 'completed', 'failed'] }).notNull(),
  /** 失败原因。 */
  error: core.text('error'),
  /** 创建时间，毫秒。 */
  createdAt: core.integer('created_at').notNull(),
  /** 更新时间，毫秒。 */
  updatedAt: core.integer('updated_at').notNull(),
});


/** 每步模型调用表。 */
const modelRequests = core.sqliteTable('jmbot_model_requests', {
  /** 自增 ID。 */
  id: core.integer('id').primaryKey({ autoIncrement: true }),
  /** 所属会话。 */
  sessionId: core.text('session_id').notNull().references(() => sessions.id),
  /** 所属 execution 事件。 */
  rootEventId: core.integer('root_event_id').notNull().references(() => events.id),
  /** 第几步，从 1 数。 */
  step: core.integer('step').notNull(),
  /** 谁在执行这一步：机器人、智能体的名字，或者模型 ID。 */
  actor: core.text('actor').notNull(),
  /** 实际发给模型的请求（模型、思考强度、系统提示词、工具、上下文），不含密钥。 */
  request: core.text('request', { mode: 'json' }).$type<unknown>().notNull(),
  /** 模型的回复（文字、工具调用、Pi 的原始消息、用量）；没回来时是 null。 */
  response: core.text('response', { mode: 'json' }).$type<unknown>(),
  /** in_progress 调用中（程序死掉时就停在这，表示结果未知）、completed、failed。 */
  status: core.text('status', { enum: ['in_progress', 'completed', 'failed'] }).notNull(),
  /** 失败原因。 */
  error: core.text('error'),
  /** 开始时间，毫秒。 */
  createdAt: core.integer('created_at').notNull(),
  /** 结束时间，毫秒。 */
  updatedAt: core.integer('updated_at').notNull(),
});


/** 工具调用表。 */
const toolResults = core.sqliteTable('jmbot_tool_results', {
  /** 自增 ID。 */
  id: core.integer('id').primaryKey({ autoIncrement: true }),
  /** 所属 execution 事件。 */
  eventId: core.integer('event_id').notNull().references(() => events.id),
  /** 第几步调的（对应 jmbot_model_requests 的 step）。 */
  step: core.integer('step').notNull(),
  /** 模型给这次调用起的 ID。 */
  callId: core.text('call_id').notNull(),
  /** 工具名。 */
  toolName: core.text('tool_name').notNull(),
  /** 参数。 */
  input: core.text('input', { mode: 'json' }).$type<unknown>().notNull(),
  /** in_progress 执行中（程序死掉时停在这，表示结果未知）、completed、failed。 */
  status: core.text('status', { enum: ['in_progress', 'completed', 'failed'] }).notNull(),
  /** 结果。 */
  output: core.text('output', { mode: 'json' }).$type<unknown>(),
  /** 失败原因。 */
  error: core.text('error'),
  /** 开始时间，毫秒。 */
  createdAt: core.integer('created_at').notNull(),
  /** 结束时间，毫秒。 */
  updatedAt: core.integer('updated_at').notNull(),
});


/** 收件表：渠道收到的每句话。 */
const inbox = core.sqliteTable('jmbot_inbox', {
  /** 自增 ID。 */
  id: core.integer('id').primaryKey({ autoIncrement: true }),
  /** 来源，如“飞书私聊 oc_xxx”。同一来源一次只分派一批。 */
  source: core.text('source').notNull(),
  /** 新会话交给哪个机器人（渠道配置的）；没有写 null。 */
  bot: core.text('bot'),
  /** 用户的话。 */
  text: core.text('text').notNull(),
  /** 用户引用回复的那条消息在渠道里的 ID；没引用写 null。 */
  replyTo: core.text('reply_to'),
  /** 多久没说话的会话不再接着，小时。 */
  idleHours: core.real('idle_hours').notNull(),
  /** new 未分派、routing 分派中、done 已分派、failed 分派出错。 */
  status: core.text('status', { enum: ['new', 'routing', 'done', 'failed'] }).notNull(),
  /** 和哪几句合成一批分派的：这批第一句的 ID；还没分派时 null。 */
  batchId: core.integer('batch_id'),
  /** 分派结果：引出的执行对话、要直接问用户的话、理由。 */
  result: core.text('result', { mode: 'json' }).$type<InboxResult>(),
  /** 出错原因。 */
  error: core.text('error'),
  /** 收到的时间，毫秒。 */
  createdAt: core.integer('created_at').notNull(),
  /** 更新时间，毫秒。 */
  updatedAt: core.integer('updated_at').notNull(),
});


/** 一句话的分派结果（收件表的 result 列）。 */
export interface InboxResult {
  /** 引出的执行对话 ID。 */
  sessionIds: string[];
  /** 要直接发给用户的话（只记在一批的第一句上，免得重复发）。 */
  replies: string[];
  /** 分派的理由。 */
  reason: string;
}


/** 等人确认的 exec 命令表。 */
const approvals = core.sqliteTable('jmbot_exec_approvals', {
  /** 自增 ID；告诉用户的“待确认 ID”就是它。 */
  id: core.integer('id').primaryKey({ autoIncrement: true }),
  /** 所属会话。 */
  sessionId: core.text('session_id').notNull().references(() => sessions.id),
  /** 所属 execution 事件。 */
  rootEventId: core.integer('root_event_id').notNull().references(() => events.id),
  /** 对应的工具调用记录。 */
  toolResultId: core.integer('tool_result_id').notNull().references(() => toolResults.id),
  /** 要执行的命令。 */
  command: core.text('command').notNull(),
  /** 在哪个目录执行。 */
  workDir: core.text('work_dir').notNull(),
  /** pending 等确认、approved 同意、rejected 拒绝。 */
  status: core.text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
  /** 用户确认时附的话（可空）。 */
  note: core.text('note'),
  /** 创建时间，毫秒。 */
  createdAt: core.integer('created_at').notNull(),
  /** 更新时间，毫秒。 */
  updatedAt: core.integer('updated_at').notNull(),
});


/** 建表语句：和上面的表定义一一对应。表已存在就跳过。 */
const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS jmbot_sessions (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, bot TEXT, agent TEXT, model TEXT, thinking TEXT,
  workspace TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, last_reply TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jmbot_sessions_source ON jmbot_sessions(source, updated_at);
CREATE TABLE IF NOT EXISTS jmbot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES jmbot_sessions(id),
  parent_id INTEGER REFERENCES jmbot_events(id), type TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jmbot_events_claim ON jmbot_events(status, type, id);
CREATE INDEX IF NOT EXISTS jmbot_events_session ON jmbot_events(session_id, id);
CREATE TABLE IF NOT EXISTS jmbot_model_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES jmbot_sessions(id),
  root_event_id INTEGER NOT NULL REFERENCES jmbot_events(id), step INTEGER NOT NULL, actor TEXT NOT NULL,
  request TEXT NOT NULL, response TEXT, status TEXT NOT NULL, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jmbot_model_requests_event ON jmbot_model_requests(root_event_id, step);
CREATE TABLE IF NOT EXISTS jmbot_tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES jmbot_events(id),
  step INTEGER NOT NULL, call_id TEXT NOT NULL, tool_name TEXT NOT NULL, input TEXT NOT NULL,
  status TEXT NOT NULL, output TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jmbot_tool_results_event ON jmbot_tool_results(event_id, step, id);
CREATE TABLE IF NOT EXISTS jmbot_exec_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES jmbot_sessions(id),
  root_event_id INTEGER NOT NULL REFERENCES jmbot_events(id),
  tool_result_id INTEGER NOT NULL UNIQUE REFERENCES jmbot_tool_results(id),
  command TEXT NOT NULL, work_dir TEXT NOT NULL, status TEXT NOT NULL, note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jmbot_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, bot TEXT, text TEXT NOT NULL, reply_to TEXT,
  idle_hours REAL NOT NULL, status TEXT NOT NULL, batch_id INTEGER, result TEXT, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jmbot_inbox_claim ON jmbot_inbox(status, source, id);
`;


/** 一行收件。 */
export type InboxRow = typeof inbox.$inferSelect;


/** 一行会话。 */
export type SessionRow = typeof sessions.$inferSelect;


/** 一行事件。 */
export type EventRow = typeof events.$inferSelect;


/** 一行模型调用。 */
export type ModelRequestRow = typeof modelRequests.$inferSelect;


/** 一行工具调用。 */
export type ToolResultRow = typeof toolResults.$inferSelect;


/** 一行待确认命令。 */
export type ApprovalRow = typeof approvals.$inferSelect;


/** 新建会话要给的东西。 */
export interface NewSession {
  /** 标题。 */
  title: string;
  /** task 执行对话，route 分派对话。 */
  kind: 'task' | 'route';
  /** 机器人；没有写 null。 */
  bot: string | null;
  /** 智能体；没有写 null。 */
  agent: string | null;
  /** 只给模型时的模型 ID；没有写 null。 */
  model: string | null;
  /** 工作区名字。 */
  workspace: string;
  /** 来源。 */
  source: string;
}


/** taskdbsearch 能按哪些条件查（都可选，写了几个就同时满足几个）。 */
export interface SessionFilter {
  /** 会话 ID。 */
  sessionId?: string;
  /** task 执行对话，route 分派对话。 */
  kind?: 'task' | 'route';
  /** 机器人。 */
  bot?: string;
  /** 智能体。 */
  agent?: string;
  /** 工作区。 */
  workspace?: string;
  /** 来源。 */
  source?: string;
  /** 会话状态。 */
  status?: string;
  /** 最多几条，默认 20。 */
  limit?: number;
}


/**
 * 打开数据库（没有就建），建表。调用方用完要 close。
 * @param dbFile 数据库文件路径（一般是运行时目录下的 jmbots.db）。
 * @returns 读写函数。
 */
export function openEventStore(dbFile: string) {
  /** SQLite 连接。 */
  const client = new sqlite.Database(dbFile, { create: true });

  //G Drizzle 的 Bun 驱动会 prepare 语句但不主动释放；记下来，关闭前统一释放，免得关闭时报“语句没释放”。
  /** prepare 过的语句。 */
  const statements: ReturnType<typeof client.prepare>[] = [];
  /** 原来的 prepare。 */
  const prepare = client.prepare.bind(client);
  client.prepare = ((...args: Parameters<typeof client.prepare>) => {
    /** 新语句。 */
    const statement = prepare(...args);
    statements.push(statement);
    return statement;
  }) as typeof client.prepare;

  /** 释放语句、关闭连接。 */
  function close(): void {
    for (const statement of statements) {
      statement.finalize();
    }
    client.close();
  }

  //M 外键、等锁 5 秒（命令行和服务同时开着时会抢锁）、WAL（读写不互相挡）、建表。
  client.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  client.exec(CREATE_TABLES);
  /** Drizzle 包装。 */
  const db = drizzleSqlite.drizzle(client);

  return {
    // ───────────── 会话 ─────────────

    /**
     * 新建会话：ID 撞了（同一毫秒、随机数也一样）就换一个再试。
     * @param input 标题、归属、工作区、来源。
     */
    createSession(input: NewSession): SessionRow {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        /** 现在的时间。 */
        const now = Date.now();
        /** 插入成功时是新行，撞了主键时是 undefined。 */
        const row = db
          .insert(sessions)
          .values({ ...input, id: utils.createSessionId(new Date(now)), status: '空闲', lastReply: null, createdAt: now, updatedAt: now })
          .onConflictDoNothing()
          .returning()
          .get();
        if (row) {
          return row;
        }
      }
      throw new Error('连续 100 次生成的会话 ID 都重复了');
    },

    /**
     * 读一个会话。
     * @param id 会话 ID。
     */
    getSession(id: string): SessionRow | undefined {
      return db.select().from(sessions).where(orm.eq(sessions.id, id)).get();
    },

    /**
     * 改会话的状态、最后回复、归属等，同时刷新最近活动时间。
     * @param id 会话 ID。
     * @param changes 要改的列。
     */
    updateSession(id: string, changes: Partial<Omit<SessionRow, 'id' | 'createdAt' | 'updatedAt'>>): void {
      db.update(sessions).set({ ...changes, updatedAt: Date.now() }).where(orm.eq(sessions.id, id)).run();
    },

    /**
     * 按条件列会话，最近活动的在前（taskdbsearch、HTTP、命令行 list 都用它）。
     * @param filter 条件。
     */
    listSessions(filter: SessionFilter = {}): SessionRow[] {
      /** 查询条件。 */
      const conditions: orm.SQL[] = [];
      if (filter.sessionId) {
        conditions.push(orm.eq(sessions.id, filter.sessionId));
      }
      if (filter.kind) {
        conditions.push(orm.eq(sessions.kind, filter.kind));
      }
      if (filter.bot) {
        conditions.push(orm.eq(sessions.bot, filter.bot));
      }
      if (filter.agent) {
        conditions.push(orm.eq(sessions.agent, filter.agent));
      }
      if (filter.workspace) {
        conditions.push(orm.eq(sessions.workspace, filter.workspace));
      }
      if (filter.source) {
        conditions.push(orm.eq(sessions.source, filter.source));
      }
      if (filter.status) {
        conditions.push(orm.eq(sessions.status, filter.status));
      }
      return db
        .select()
        .from(sessions)
        .where(orm.and(...conditions))
        .orderBy(orm.desc(sessions.updatedAt))
        .limit(filter.limit ?? 20)
        .all();
    },

    // ───────────── 事件 ─────────────

    /**
     * 加一个等着执行的事件（status = pending），事件循环会来取。
     * @param input 会话、类型、内容，可选上级事件。
     */
    createEvent(input: { sessionId: string; type: string; payload: unknown; parentId?: number }): EventRow {
      /** 现在的时间。 */
      const now = Date.now();
      return db
        .insert(events)
        .values({ ...input, parentId: input.parentId ?? null, status: 'pending', error: null, createdAt: now, updatedAt: now })
        .returning()
        .get();
    },

    /**
     * 按渠道消息 ID 找发出它的会话（sent 事件里记的 messageId）。
     * @param messageId 渠道里的消息 ID。
     * @returns 会话；没记过这条消息时是 undefined。
     */
    findSessionBySent(messageId: string): SessionRow | undefined {
      /** 最近一条对上的 sent 事件。 */
      const row = db
        .select({ sessionId: events.sessionId })
        .from(events)
        .where(orm.and(orm.eq(events.type, 'sent'), orm.sql`json_extract(${events.payload}, '$.messageId') = ${messageId}`))
        .orderBy(orm.desc(events.id))
        .get();
      return row ? db.select().from(sessions).where(orm.eq(sessions.id, row.sessionId)).get() : undefined;
    },

    /**
     * 记一条已经完成的历史事件（分派、判断、审核的结论），不进队列。
     * @param input 会话、上级事件、类型、内容。
     */
    recordEvent(input: { sessionId: string; parentId: number; type: string; payload: unknown }): EventRow {
      /** 现在的时间。 */
      const now = Date.now();
      return db
        .insert(events)
        .values({ ...input, status: 'completed', error: null, createdAt: now, updatedAt: now })
        .returning()
        .get();
    },

    /**
     * 领取一个等着执行的 execution 事件：pending → running。
     * 用一条 UPDATE ... RETURNING 完成，命令行和服务同时在跑也不会领到同一个。
     * @param sessionId 只领这个会话的；不写就领全部会话里最早的。
     */
    claimNextExecution(sessionId?: string): EventRow | undefined {
      /** 选哪一个：最早的 pending execution。 */
      // 同一会话一次只跑一个执行（有 running 的会话跳过），不同会话可以同时跑。
      /** 有执行在跑的会话。 */
      const busy = orm.sql`SELECT session_id FROM jmbot_events WHERE status = 'running' AND type = 'execution'`;
      const pick = sessionId
        ? orm.sql`SELECT id FROM jmbot_events WHERE status = 'pending' AND type = 'execution' AND session_id = ${sessionId} AND session_id NOT IN (${busy}) ORDER BY id LIMIT 1`
        : orm.sql`SELECT id FROM jmbot_events WHERE status = 'pending' AND type = 'execution' AND session_id NOT IN (${busy}) ORDER BY id LIMIT 1`;
      return db
        .update(events)
        .set({ status: 'running', updatedAt: Date.now() })
        .where(orm.and(orm.sql`${events.id} = (${pick})`, orm.eq(events.status, 'pending')))
        .returning()
        .get();
    },

    /**
     * 改事件状态。
     * @param id 事件 ID。
     * @param status 新状态。
     * @param error 失败原因（失败时写）。
     */
    setEventStatus(id: number, status: EventRow['status'], error?: string): void {
      db.update(events).set({ status, error: error ?? null, updatedAt: Date.now() }).where(orm.eq(events.id, id)).run();
    },

    /**
     * 读一个事件。
     * @param id 事件 ID。
     */
    getEvent(id: number): EventRow | undefined {
      return db.select().from(events).where(orm.eq(events.id, id)).get();
    },

    /**
     * 列一个会话的事件，按先后。
     * @param sessionId 会话 ID。
     * @param type 只要某种类型；不写全要。
     */
    listEvents(sessionId: string, type?: string): EventRow[] {
      /** 查询条件。 */
      const conditions = [orm.eq(events.sessionId, sessionId)];
      if (type) {
        conditions.push(orm.eq(events.type, type));
      }
      return db.select().from(events).where(orm.and(...conditions)).orderBy(events.id).all();
    },

    /**
     * 会话里还有没有没做完的 execution（pending 或 running）。
     * @param sessionId 会话 ID。
     */
    hasUnfinished(sessionId: string): boolean {
      /** 找到的一条。 */
      const row = db
        .select({ id: events.id })
        .from(events)
        .where(orm.and(orm.eq(events.sessionId, sessionId), orm.eq(events.type, 'execution'), orm.inArray(events.status, ['pending', 'running'])))
        .get();
      return row !== undefined;
    },

    /**
     * 服务启动时收拾上次没做完的（用户 11-03：“停下来了也该继续”；换版本老把正在干的活打断）：
     *   执行对话里 running 的执行改回 pending，记一条 interrupted 事件，事件循环会从数据库拼上下文接着做
     *   （没写完的工具结果留成“未知”，模型自己决定要不要重做）；同一个执行被打断第 3 次就不再接着，标成“程序中断”；
     *   分派对话里 running 的标成失败（它的收件会改回 new 重新分派）；
     *   收件表里 routing 的改回 new。
     * @returns 接着做的、标成失败的执行各几个，重新排队的收件几句。
     */
    recoverInterrupted(): { resumed: number; failed: number; inbox: number } {
      /** 现在的时间。 */
      const now = Date.now();
      db.update(modelRequests)
        .set({ status: 'failed', error: '程序中断', updatedAt: now })
        .where(orm.eq(modelRequests.status, 'in_progress'))
        .run();
      /** 被打断的执行。 */
      const running = db
        .select()
        .from(events)
        .where(orm.and(orm.eq(events.status, 'running'), orm.eq(events.type, 'execution')))
        .all();
      /** 结果计数。 */
      const counts = { resumed: 0, failed: 0, inbox: 0 };
      for (const event of running) {
        /** 所属会话。 */
        const session = db.select().from(sessions).where(orm.eq(sessions.id, event.sessionId)).get();
        /** 以前被打断过几次。 */
        const before = db
          .select()
          .from(events)
          .where(orm.and(orm.eq(events.parentId, event.id), orm.eq(events.type, 'interrupted')))
          .all().length;
        if (session?.kind === 'route' || before >= 2) {
          db.update(events).set({ status: 'failed', error: '程序中断', updatedAt: now }).where(orm.eq(events.id, event.id)).run();
          db.update(sessions).set({ status: '出错', lastReply: '程序中断，这次执行没做完。', updatedAt: now }).where(orm.eq(sessions.id, event.sessionId)).run();
          counts.failed += 1;
          continue;
        }
        db.update(events).set({ status: 'pending', updatedAt: now }).where(orm.eq(events.id, event.id)).run();
        db.insert(events)
          .values({ sessionId: event.sessionId, parentId: event.id, type: 'interrupted', payload: { times: before + 1 }, status: 'completed', error: null, createdAt: now, updatedAt: now })
          .run();
        db.update(sessions).set({ status: '排队', updatedAt: now }).where(orm.eq(sessions.id, event.sessionId)).run();
        counts.resumed += 1;
      }
      counts.inbox = db
        .update(inbox)
        .set({ status: 'new', batchId: null, updatedAt: now })
        .where(orm.eq(inbox.status, 'routing'))
        .returning()
        .all().length;
      return counts;
    },

    // ───────────── 收件 ─────────────

    /**
     * 记下渠道收到的一句话（new 未分派）；写明了交给谁、不用分派的，带 done 直接记成已分派。
     * @param input 来源、机器人、话、引用了哪条、多久算隔太久、已经定好的结果。
     */
    addInbox(input: { source: string; bot?: string; text: string; replyTo?: string; idleHours: number; done?: InboxResult }): InboxRow {
      /** 现在的时间。 */
      const now = Date.now();
      return db
        .insert(inbox)
        .values({
          source: input.source,
          bot: input.bot ?? null,
          text: input.text,
          replyTo: input.replyTo ?? null,
          idleHours: input.idleHours,
          status: input.done ? 'done' : 'new',
          batchId: null,
          result: input.done ?? null,
          error: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    },

    /**
     * 领一批要分派的话：最早一句未分派的话所在来源（这个来源没有正在分派的），把它所有未分派的话一起改成 routing。
     * 同一来源连着发的几句因此自然合成一批（用户 11-02：“我可能同时发 n 个消息”）。
     * @returns 这一批（按先后）；没有可领的时是空数组。
     */
    claimInboxBatch(): InboxRow[] {
      return db.transaction((tx) => {
        /** 正在分派的来源。 */
        const busy = orm.sql`SELECT source FROM jmbot_inbox WHERE status = 'routing'`;
        /** 最早一句可领的。 */
        const first = tx
          .select()
          .from(inbox)
          .where(orm.and(orm.eq(inbox.status, 'new'), orm.sql`${inbox.source} NOT IN (${busy})`))
          .orderBy(inbox.id)
          .limit(1)
          .get();
        if (!first) {
          return [];
        }
        return tx
          .update(inbox)
          .set({ status: 'routing', batchId: first.id, updatedAt: Date.now() })
          .where(orm.and(orm.eq(inbox.status, 'new'), orm.eq(inbox.source, first.source)))
          .returning()
          .all()
          .sort((a, b) => a.id - b.id);
      });
    },

    /**
     * 一批话分派完了：记结果或出错原因。
     * @param ids 这一批的 ID（第一句拿全部结果，其余的不带要问用户的话）。
     * @param outcome 结果，或出错原因。
     */
    finishInbox(ids: number[], outcome: { result: InboxResult } | { error: string }): void {
      /** 现在的时间。 */
      const now = Date.now();
      ids.forEach((id, index) => {
        if ('error' in outcome) {
          db.update(inbox).set({ status: 'failed', error: outcome.error, updatedAt: now }).where(orm.eq(inbox.id, id)).run();
          return;
        }
        /** 这句的结果。 */
        const result = index === 0 ? outcome.result : { ...outcome.result, replies: [] };
        db.update(inbox).set({ status: 'done', result, updatedAt: now }).where(orm.eq(inbox.id, id)).run();
      });
    },

    /**
     * 读一句收件。
     * @param id 收件 ID。
     */
    getInbox(id: number): InboxRow | undefined {
      return db.select().from(inbox).where(orm.eq(inbox.id, id)).get();
    },

    /**
     * 最近的收件（新的在前）。
     * @param options 只看某个状态、最多几条（默认 50）。
     */
    listInbox(options: { status?: InboxRow['status']; limit?: number } = {}): InboxRow[] {
      return db
        .select()
        .from(inbox)
        .where(options.status ? orm.eq(inbox.status, options.status) : undefined)
        .orderBy(orm.desc(inbox.id))
        .limit(options.limit ?? 50)
        .all();
    },


    // ───────────── 每步模型调用 ─────────────

    /**
     * 模型调用开始前记下请求（status = in_progress）。
     * @param input 会话、事件、第几步、谁在执行、请求。
     */
    startModelRequest(input: { sessionId: string; rootEventId: number; step: number; actor: string; request: unknown }): ModelRequestRow {
      /** 现在的时间。 */
      const now = Date.now();
      return db
        .insert(modelRequests)
        .values({ ...input, response: null, status: 'in_progress', error: null, createdAt: now, updatedAt: now })
        .returning()
        .get();
    },

    /**
     * 模型调用结束后写回复或失败原因。
     * @param id 记录 ID。
     * @param result 状态、回复、失败原因。
     */
    finishModelRequest(id: number, result: { status: 'completed' | 'failed'; request?: unknown; response?: unknown; error?: string }): void {
      db.update(modelRequests)
        .set({
          status: result.status,
          response: result.response ?? null,
          error: result.error ?? null,
          updatedAt: Date.now(),
          //M 给了完整请求就换掉开头记的简要请求（调用前还不知道实际用的思考档位等）。
          ...(result.request === undefined ? {} : { request: result.request }),
        })
        .where(orm.eq(modelRequests.id, id))
        .run();
    },

    /**
     * 列一个 execution 的全部步骤，按步数。
     * @param rootEventId execution 事件 ID。
     */
    listModelRequests(rootEventId: number): ModelRequestRow[] {
      return db.select().from(modelRequests).where(orm.eq(modelRequests.rootEventId, rootEventId)).orderBy(modelRequests.step).all();
    },

    // ───────────── 工具调用 ─────────────

    /**
     * 工具执行前记一行（status = in_progress）。
     * @param input 事件、第几步、调用 ID、工具名、参数。
     */
    startToolResult(input: { eventId: number; step: number; callId: string; toolName: string; input: unknown }): ToolResultRow {
      /** 现在的时间。 */
      const now = Date.now();
      return db
        .insert(toolResults)
        .values({ ...input, status: 'in_progress', output: null, error: null, createdAt: now, updatedAt: now })
        .returning()
        .get();
    },

    /**
     * 工具执行完写结果或失败原因。
     * @param id 记录 ID。
     * @param result 状态、结果、失败原因。
     */
    finishToolResult(id: number, result: { status: 'completed' | 'failed'; output?: unknown; error?: string }): void {
      db.update(toolResults)
        .set({ status: result.status, output: result.output ?? null, error: result.error ?? null, updatedAt: Date.now() })
        .where(orm.eq(toolResults.id, id))
        .run();
    },

    /**
     * 列一个 execution 的全部工具调用，按先后。
     * @param eventId execution 事件 ID。
     */
    listToolResults(eventId: number): ToolResultRow[] {
      return db.select().from(toolResults).where(orm.eq(toolResults.eventId, eventId)).orderBy(toolResults.id).all();
    },

    // ───────────── 待确认的命令 ─────────────

    /**
     * 记一条等人确认的命令。
     * @param input 会话、事件、工具调用记录、命令、目录。
     */
    createApproval(input: { sessionId: string; rootEventId: number; toolResultId: number; command: string; workDir: string }): ApprovalRow {
      /** 现在的时间。 */
      const now = Date.now();
      return db
        .insert(approvals)
        .values({ ...input, status: 'pending', note: null, createdAt: now, updatedAt: now })
        .returning()
        .get();
    },

    /**
     * 读一条待确认命令。
     * @param id 待确认 ID。
     */
    getApproval(id: number): ApprovalRow | undefined {
      return db.select().from(approvals).where(orm.eq(approvals.id, id)).get();
    },

    /**
     * 按工具调用记录找它的待确认（不管状态）。
     * @param toolResultId 工具调用记录 ID。
     */
    getApprovalByToolResult(toolResultId: number): ApprovalRow | undefined {
      return db.select().from(approvals).where(orm.eq(approvals.toolResultId, toolResultId)).get();
    },

    /**
     * 列待确认命令。
     * @param sessionId 只列这个会话的；不写全列。
     */
    listPendingApprovals(sessionId?: string): ApprovalRow[] {
      /** 查询条件。 */
      const conditions = [orm.eq(approvals.status, 'pending')];
      if (sessionId) {
        conditions.push(orm.eq(approvals.sessionId, sessionId));
      }
      return db.select().from(approvals).where(orm.and(...conditions)).orderBy(approvals.id).all();
    },

    /**
     * 列一个会话的全部待确认命令（含已经决定过的），给事件白盒子页面看。
     * @param sessionId 会话 ID。
     */
    listApprovals(sessionId: string): ApprovalRow[] {
      return db.select().from(approvals).where(orm.eq(approvals.sessionId, sessionId)).orderBy(approvals.id).all();
    },

    /**
     * 用户做决定：只有 pending 的能改，同一条不能决定两次。
     * @param id 待确认 ID。
     * @param decision 同意或拒绝。
     * @param note 用户附的话。
     * @returns 改成功时是新的一行；已经决定过时是 undefined。
     */
    decideApproval(id: number, decision: 'approved' | 'rejected', note?: string): ApprovalRow | undefined {
      return db
        .update(approvals)
        .set({ status: decision, note: note ?? null, updatedAt: Date.now() })
        .where(orm.and(orm.eq(approvals.id, id), orm.eq(approvals.status, 'pending')))
        .returning()
        .get();
    },

    /** 释放语句、关闭数据库。 */
    close,
  };
}


/** 数据库读写函数的类型。 */
export type EventStore = ReturnType<typeof openEventStore>;
