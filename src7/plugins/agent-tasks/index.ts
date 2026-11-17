/**
 * 外部 AI 任务通道：grokbots、DSH 这类外部 AI 自己来打招呼、领活、下载附件、交回结果；jmbots 不去操控它们（照 0.4）。
 * 工具 agent_task（work 会话）：list 看接上了谁、send 把一件活放进某个外部 AI 的队列、status 看一件到哪了。
 * 交回时结果写成一句话送回派活的会话（sessions.open → add → run），会话回话照常经渠道发给用户。任务和登记存库。
 * 照 0.4 src/capabilities/AgentTasks.ts、src/capabilities/tools/Tools.ts:1574-1645。设计：docs/src7插件设计/agent-tasks.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import { registerRoutes } from './Routes.ts';


/** 插件名。 */
export const name = 'agent-tasks';

/** 用到的服务：resources 存表和文件夹；tools 登记工具；sessions 把结果送回会话；http 开接口。 */
export const inject = ['resources', 'tools', 'sessions', 'http'];


/** 任务的四种状态。 */
export const STATUSES = ['new', 'taken', 'done', 'failed'] as const;
export type TaskStatus = typeof STATUSES[number];

/** 外部 AI 的名字规则（照 0.4）。 */
export const NAME = /^[A-Za-z0-9_-]{1,40}$/u;

/** 一个外部 AI 的登记。 */
export interface AgentInfo { name: string; description: string; hello: number; seen: number }

/** 一件活（JSON 形状照 0.4，id 写成字符串）。 */
export interface Task {
  id: string;
  agent: string;
  bot: string;
  sessionId: string;
  title: string;
  text: string;
  files: string[];
  status: TaskStatus;
  createdAt: number;
  takenAt?: number;
  doneAt?: number;
  result?: { text: string; files: string[] };
}

/** 带 HTTP 状态码的错：路由照它回。 */
export class TaskError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}


/** 列任务最多几件。 */
const LIST_MAX = 50;
/** list 每个外部 AI 带几件。 */
const LIST_PER_AGENT = 5;
/** 上传号：20 位数字。 */
const UPLOAD_ID = /^\d{20}$/u;
/** 状态的中文。 */
const STATUS_WORDS: Record<TaskStatus, string> = { new: '等它来领', taken: '它在做', done: '做完了', failed: '没做成' };


/** 任务通道。 */
export class AgentTasks {
  /**
   * 建两张表、登记工具 agent_task。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS agent_tasks_agents (name TEXT PRIMARY KEY, description TEXT NOT NULL, hello INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)');
    db.exec('CREATE TABLE IF NOT EXISTS agent_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, bot TEXT NOT NULL, session TEXT NOT NULL,'
      + ' title TEXT NOT NULL, text TEXT NOT NULL, files TEXT NOT NULL, status TEXT NOT NULL, result_text TEXT, result_files TEXT,'
      + ' created_at INTEGER NOT NULL, taken_at INTEGER, done_at INTEGER)');

    //M tools.register：登记给 work 会话；模型调它时骨架调 run(参数, 会话)，交回的文字就是工具结果。
    ctx.tools.register({
      definition: {
        name: 'agent_task',
        description: '把一件活交给别的 AI（比如会生图、生视频的外部 AI）去做，它做完会把结果作为一条消息送回这个会话。'
          + 'list：看接上了哪些 AI、各自会做什么、最近的任务；send：交一件活（agent、title、text 必写，files 是附件 @路径）；status：看一件任务到哪了（agent、id）。'
          + '交出去以后不用等，先做别的或者先结束，结果到了会接着做。',
        parameters: piAi.Type.Object({
          action: piAi.Type.Union([piAi.Type.Literal('list'), piAi.Type.Literal('send'), piAi.Type.Literal('status')]),
          agent: piAi.Type.Optional(piAi.Type.String({ description: '交给谁（send、status）' })),
          title: piAi.Type.Optional(piAi.Type.String({ description: '一句话标题（send）' })),
          text: piAi.Type.Optional(piAi.Type.String({ description: '要做什么、要交回什么（send）' })),
          files: piAi.Type.Optional(piAi.Type.Array(piAi.Type.String(), { description: '附件，@路径，相对工作区（send）' })),
          id: piAi.Type.Optional(piAi.Type.String({ description: '任务号（status）' })),
        }),
      },
      kinds: ['work'],
      run: (args, session) => this.run(args, session),
    });
  }

  /** 打招呼：说明空就留旧的，seen 留旧的。 */
  hello(agent: string, description: string): AgentInfo {
    const words = description.trim();
    this.ctx.resources.db.query('INSERT INTO agent_tasks_agents (name, description, hello, seen) VALUES (?, ?, ?, 0)'
      + " ON CONFLICT(name) DO UPDATE SET hello = excluded.hello, description = CASE WHEN excluded.description = '' THEN description ELSE excluded.description END")
      .run(agent, words, Date.now());
    return this.agents().find((item) => item.name === agent)!;
  }

  /** 全部登记，按名字排。 */
  agents(): AgentInfo[] {
    return this.ctx.resources.db.query('SELECT name, description, hello, seen FROM agent_tasks_agents ORDER BY name').all() as AgentInfo[];
  }

  /** 列一个外部 AI 的任务：touch 时先记它来过；最多 50 件，新的在前。 */
  list(agent: string, status?: TaskStatus, touch = false, limit = LIST_MAX): Task[] {
    const db = this.ctx.resources.db;
    if (touch) db.query('UPDATE agent_tasks_agents SET seen = ? WHERE name = ?').run(Date.now(), agent);
    const rows = status === undefined
      ? db.query('SELECT * FROM agent_tasks WHERE agent = ? ORDER BY id DESC LIMIT ?').all(agent, limit)
      : db.query('SELECT * FROM agent_tasks WHERE agent = ? AND status = ? ORDER BY id DESC LIMIT ?').all(agent, status, limit);
    return (rows as Record<string, unknown>[]).map(taskOf);
  }

  /** 一件。 */
  get(agent: string, id: number): Task | undefined {
    const row = this.ctx.resources.db.query('SELECT * FROM agent_tasks WHERE id = ? AND agent = ?').get(id, agent) as Record<string, unknown> | null;
    return row === null ? undefined : taskOf(row);
  }

  /** 任务文件夹：integrations/agents/<名字>/tasks/<号>/…（resources.dir 没有就建）。 */
  dir(agent: string, id: number | string, ...more: string[]): string {
    return this.ctx.resources.dir('integrations', 'agents', agent, 'tasks', String(id), ...more);
  }

  /** 派活：查登记 → 插一行拿号 → 附件复制进任务文件夹（重名加序号）→ 写回 files。 */
  send(session: Session, agent: string, title: string, text: string, files: string[]): Task {
    if (!this.agents().some((item) => item.name === agent)) throw new Error(`${agent} 还没来打过招呼（没接上通道），交不了；用 list 看有哪些`);
    //G 附件先都找到，再落库（找不到的不留半截任务）。
    const botDir = this.ctx.resources.dir('bots', session.row.bot);
    const workspace = path.join(botDir, 'workspace');
    const sources = files.map((file) => {
      const full = path.resolve(workspace, file.replace(/^@/u, ''));
      const back = path.relative(botDir, full);
      if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`附件只能在这个机器人的文件夹 ${botDir} 里：${file}`);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`附件不在：${file}`);
      return full;
    });
    const db = this.ctx.resources.db;
    const inserted = db.query("INSERT INTO agent_tasks (agent, bot, session, title, text, files, status, created_at) VALUES (?, ?, ?, ?, ?, '[]', 'new', ?)")
      .run(agent, session.row.bot, session.row.id, title, text, Date.now());
    const id = Number(inserted.lastInsertRowid);
    const folder = this.dir(agent, id);
    const names: string[] = [];
    for (const source of sources) {
      let base = path.basename(source);
      for (let index = 1; names.includes(base); index += 1) base = `${String(index)}_${path.basename(source)}`;
      fs.copyFileSync(source, path.join(folder, base));
      names.push(base);
    }
    db.query('UPDATE agent_tasks SET files = ? WHERE id = ?').run(JSON.stringify(names), id);
    //T 跟踪：派出一件。
    this.ctx.emit('trace', 'AgentTasks.send', `交给 ${agent}：#${String(id)}`, 'INSERT agent_tasks', { 任务: id, 外部AI: agent, 会话: session.row.id, 附件: names.length });
    return this.get(agent, id)!;
  }

  /** 认领：一条带条件的 UPDATE 定输赢，两个同时领只有一个成。 */
  take(agent: string, id: number): Task {
    const changes = this.ctx.resources.db.query("UPDATE agent_tasks SET status = 'taken', taken_at = ? WHERE id = ? AND agent = ? AND status = 'new'")
      .run(Date.now(), id, agent).changes;
    const task = this.get(agent, id);
    if (task === undefined) throw new TaskError(`没有任务 ${String(id)}`, 404);
    if (changes !== 1) throw new TaskError(`任务 ${String(id)} 已经是 ${task.status} 了`, 409);
    //T 跟踪：被领走。
    this.ctx.emit('trace', 'AgentTasks.take', `${agent} 领走 #${String(id)}`, 'UPDATE agent_tasks', { 任务: id, 外部AI: agent });
    return task;
  }

  /** 交回：上传号都找到了再挪进 result/；改状态；结果作为一句话送回派活的会话。 */
  finish(agent: string, id: number, ok: boolean, text: string, uploads: string[]): Task {
    const task = this.get(agent, id);
    if (task === undefined) throw new TaskError(`没有任务 ${String(id)}`, 400);
    if (task.status === 'done' || task.status === 'failed') throw new TaskError(`任务 ${String(id)} 已经交过了`, 400);
    const uploadDir = this.ctx.resources.dir('data', 'tmp', 'uploads');
    const present = fs.readdirSync(uploadDir);
    const found = uploads.map((upload) => {
      if (!UPLOAD_ID.test(upload)) throw new TaskError(`上传号不对：${upload}（是 PUT /api/uploads/<文件名> 回的 20 位 id）`, 400);
      const file = present.find((item) => item.startsWith(`${upload}_`));
      if (file === undefined) throw new TaskError(`没有这个上传：${upload}`, 400);
      return file;
    });
    const names: string[] = [];
    if (found.length > 0) {
      const resultDir = this.dir(agent, id, 'result');
      for (const file of found) {
        const base = path.basename(file.slice(file.indexOf('_') + 1));
        fs.renameSync(path.join(uploadDir, file), path.join(resultDir, base));
        names.push(base);
      }
    }
    this.ctx.resources.db.query('UPDATE agent_tasks SET status = ?, result_text = ?, result_files = ?, done_at = ? WHERE id = ?')
      .run(ok ? 'done' : 'failed', text, JSON.stringify(names), Date.now(), id);
    const done = this.get(agent, id)!;

    //M sessions.open 打开派活的会话；add 一句话；run 推它转（已经在转的，run 直接返回，话下一步带上）。
    try {
      const session = this.ctx.sessions.open(done.sessionId);
      session.add(this.resultText(done));
      void session.run();
    } catch (error) {
      console.error(`任务 #${String(id)} 的结果送不回会话 ${done.sessionId}：${error instanceof Error ? error.message : String(error)}`);
    }
    //T 跟踪：交回并送回会话。
    this.ctx.emit('trace', 'AgentTasks.finish', `${agent} 交回 #${String(id)}`, 'session.add + run', { 任务: id, 外部AI: agent, 会话: done.sessionId, 状态: done.status, 文件: names.length });
    return done;
  }

  /** 送回会话的那句话（照 0.4）；交回的文件写成 @绝对路径。 */
  private resultText(task: Task): string {
    const lines = [
      `【${task.agent} 交回任务 #${task.id}「${task.title}」：${task.status === 'done' ? '做完了' : '没做成'}】`,
      task.result?.text ?? '',
      '',
      `（任务文件夹：integrations/agents/${task.agent}/tasks/${task.id}/，交回的文件在 result/ 里）`,
      ...(task.result?.files ?? []).map((file) => `@${path.join(this.dir(task.agent, task.id, 'result'), file)}`),
    ];
    return lines.join('\n');
  }

  /** 一行：#N → 外部 AI「标题」状态（派于、交回于）。 */
  private describe(task: Task): string {
    const done = task.doneAt === undefined ? '' : `，交回于 ${time(task.doneAt)}`;
    return `#${task.id} → ${task.agent}「${task.title}」${STATUS_WORDS[task.status]}（派于 ${time(task.createdAt)}${done}）`;
  }

  /** 工具：三支。 */
  private run(args: Record<string, unknown>, session: Session): string {
    const text = (key: string): string | undefined => (typeof args[key] === 'string' && args[key] !== '' ? args[key] : undefined);
    switch (args['action']) {
      case 'list': {
        const agents = this.agents();
        if (agents.length === 0) return '还没有别的 AI 接上任务通道：它们照 GET /api/agents/guide 的说明来打过招呼才会出现在这里';
        return agents.map((agent) => [
          `- ${agent.name}：${agent.description || '（没说会做什么）'}；最近来领活：${agent.seen === 0 ? '还没来过' : time(agent.seen)}`,
          ...this.list(agent.name, undefined, false, LIST_PER_AGENT).map((task) => `  ${this.describe(task)}`),
        ].join('\n')).join('\n');
      }
      case 'send': {
        const agent = text('agent');
        const title = text('title');
        const body = text('text');
        if (agent === undefined || title === undefined || body === undefined) throw new Error('send 要写 agent、title、text');
        const files = Array.isArray(args['files']) ? (args['files'] as unknown[]).map(String) : [];
        const task = this.send(session, agent, title, body, files);
        return `已交给 ${agent}：任务 #${task.id}「${title}」，附件 ${String(task.files.length)} 个。它来领、做完会把结果作为一条消息送回这个会话；不用等，先做别的或先结束。`;
      }
      case 'status': {
        const agent = text('agent') ?? '';
        const id = Number(text('id'));
        const task = Number.isInteger(id) ? this.get(agent, id) : undefined;
        if (task === undefined) throw new Error(`${agent} 没有这件任务`);
        const lines = [this.describe(task)];
        if (task.result !== undefined) {
          lines.push(`交回的话：${task.result.text}`);
          if (task.result.files.length > 0) {
            lines.push(`交回的文件：${task.result.files.map((file) => `@${path.join(this.dir(task.agent, task.id, 'result'), file)}`).join(' ')}`);
          }
        }
        return lines.join('\n');
      }
      default:
        throw new Error('action 只能是 list、send、status');
    }
  }
}


/** 本地时间，到分钟。 */
function time(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false }).slice(0, -3);
}

/** 表里一行转成任务。 */
function taskOf(row: Record<string, unknown>): Task {
  const task: Task = {
    id: String(row['id']), agent: row['agent'] as string, bot: row['bot'] as string, sessionId: row['session'] as string,
    title: row['title'] as string, text: row['text'] as string, files: JSON.parse(row['files'] as string) as string[],
    status: row['status'] as TaskStatus, createdAt: row['created_at'] as number,
  };
  if (row['taken_at'] !== null) task.takenAt = row['taken_at'] as number;
  if (row['done_at'] !== null) task.doneAt = row['done_at'] as number;
  if (row['result_text'] !== null) task.result = { text: row['result_text'] as string, files: JSON.parse((row['result_files'] as string | null) ?? '[]') as string[] };
  return task;
}


/**
 * 挂上任务通道。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。没有配置。接口在 apply 里登记，http 等 ready 才监听，来得及。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  registerRoutes(ctx, new AgentTasks(ctx));
}
