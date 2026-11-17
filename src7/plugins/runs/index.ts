/**
 * 命令窗口：外面的 AI 或网页不经过模型，直接 POST /api/run 跑一条命令。先交给 approval 审（规则 → decision → 审核小会话 → 问用户），
 * 放行才交给 exec 跑；写了 ask_user: true 的，放不了行就去问用户，同意了再跑；没写的直接拒绝（照 0.4）。
 * 跑的时候输出攒在内存，查一条能看结尾；跑完整段输出存进表 runs。能列、查（可以等它跑完）、看全部输出、停下。程序重启时没跑完的记成失败。
 * 照 0.4 src/executors/Runs.ts、src/channels/Http.ts:646-716。设计：docs/src7插件设计/runs.md。
 */
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import type { Pending } from '../approval/index.ts';
import { stampId } from '../../utils/Names.ts';


/** 插件名。 */
export const name = 'runs';

/** 用到的服务：resources 存表；http 开接口；approval 审；exec 跑。 */
export const inject = ['resources', 'http', 'approval', 'exec'];


/** 一条命令的记录（形状照 0.4 RunRecord，少了 log）。 */
export interface RunRecord {
  id: string;
  command: string;
  cwd: string;
  why: string;
  from: string;
  timeoutSec: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'stopped';
  review: { by: string; reason: string; ms: number };
  approvalId?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  code?: number;
  timedOut?: boolean;
  error?: string;
}

/** 表里的一行。 */
interface Row extends RunRecord {
  output?: string;
}


/** 默认最多跑几秒。 */
const DEFAULT_TIMEOUT_SEC = 600;
/** 最多能给几秒。 */
const MAX_TIMEOUT_SEC = 3600;
/** 列表默认几条、最多几条。 */
const LIST_DEFAULT = 20;
const LIST_MAX = 200;
/** wait 最多等几秒。 */
const WAIT_MAX_SEC = 120;
/** 表里留最近几条已结束的。 */
const KEEP = 300;
/** 结尾留几行、几个字节。 */
const TAIL_LINES = 200;
const TAIL_BYTES = 20_000;


/** 输入不对：处理函数回 400。 */
class BadInput extends Error {}


/** 命令窗口。 */
class Runs {
  /** 正在跑的：开关、攒着的输出。 */
  private readonly live = new Map<string, { stop: AbortController; chunks: string[] }>();

  /**
   * 建表，收拾上次没跑完的，听 approval/decided。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT NOT NULL, why TEXT NOT NULL, source TEXT NOT NULL,'
      + ' timeout_sec INTEGER NOT NULL, status TEXT NOT NULL, review TEXT NOT NULL, approval_id INTEGER, created_at INTEGER NOT NULL,'
      + ' started_at INTEGER, ended_at INTEGER, code INTEGER, timed_out INTEGER, error TEXT, output TEXT)');

    //M 上次没跑完的（在跑的、审核到一半的）记失败；在等用户的留着（待确认在库里，重启后还能同意）。
    const now = Date.now();
    db.query("UPDATE runs SET status = 'failed', error = '程序重启了，没跑完', ended_at = ? WHERE status = 'running' OR (status = 'pending' AND approval_id IS NULL)").run(now);

    //M approval/decided（通知）：只管自己放的（kind 是 run，payload 是 { runId }）。
    ctx.on('approval/decided', (pending: Pending) => this.onDecided(pending));
  }

  /**
   * POST /api/run：校验、记一行、审、按结论拒绝 / 等用户 / 跑。
   * @param body 请求体。
   * @returns 审完那一刻的记录。
   * @throws BadInput：输入不对。
   */
  async start(body: unknown): Promise<RunRecord> {
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const command = input['command'];
    if (typeof command !== 'string' || command.trim() === '') throw new BadInput('command 要是非空字符串');
    const text = (key: string, fallback: string): string => {
      const value = input[key] ?? fallback;
      if (typeof value !== 'string') throw new BadInput(`${key} 要是字符串`);
      return value;
    };
    const timeout = input['timeout'] ?? DEFAULT_TIMEOUT_SEC;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) throw new BadInput('timeout 是秒，要是正数');
    const askUser = input['ask_user'] ?? false;
    if (typeof askUser !== 'boolean') throw new BadInput('ask_user 要是 true 或 false');

    const row: Row = {
      id: stampId(), command, cwd: text('cwd', this.ctx.resources.root), why: text('why', ''), from: text('from', 'api'),
      timeoutSec: Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.round(timeout))), status: 'pending',
      review: { by: 'rule', reason: '审核中', ms: 0 }, createdAt: Date.now(),
    };
    this.save(row, true);

    const began = Date.now();
    const verdict = await this.ctx.approval.review({ command, cwd: row.cwd, kind: 'run', payload: { runId: row.id }, ask: askUser });
    const now = this.read(row.id) ?? row;
    now.review = { by: verdict.result === 'asked' ? 'user' : verdict.by, reason: verdict.reason, ms: Date.now() - began };

    //G 审核期间被停下了：去问了用户的那条也作废。
    if (now.status !== 'pending') {
      if (verdict.result === 'asked') this.ctx.approval.decide(verdict.id, false, '命令窗口：发命令的停下了');
      this.save(now);
      return now;
    }
    if (verdict.result === 'reject') {
      now.status = 'rejected';
      now.endedAt = Date.now();
      this.save(now);
    } else if (verdict.result === 'asked') {
      now.approvalId = verdict.id;
      this.save(now);
    } else {
      this.launch(now);
    }
    return now;
  }

  /** 跑一条：exec.run，输出边跑边攒，跑完整段存表。 */
  private launch(row: Row): void {
    row.status = 'running';
    row.startedAt = Date.now();
    this.save(row);
    const entry = { stop: new AbortController(), chunks: [] as string[] };
    this.live.set(row.id, entry);
    void this.ctx.exec.run({
      command: row.command, cwd: row.cwd, timeoutMs: row.timeoutSec * 1000, signal: entry.stop.signal,
      onOutput: (chunk) => entry.chunks.push(chunk),
    }).then((result) => {
      this.live.delete(row.id);
      const now = this.read(row.id) ?? row;
      now.output = result.output;
      if (result.code !== null) now.code = result.code;
      now.timedOut = result.timedOut;
      //G 先被停下（stopped）的不改状态，只补输出。
      if (now.status === 'running') {
        now.status = result.code === 0 && !result.timedOut && result.error === undefined ? 'done' : 'failed';
        const error = result.error ?? (result.timedOut ? `超过 ${String(row.timeoutSec)} 秒，已结束` : undefined);
        if (error !== undefined) now.error = error;
      }
      now.endedAt = Date.now();
      this.save(now);
      const seconds = ((now.endedAt - (now.startedAt ?? now.endedAt)) / 1000).toFixed(1);
      console.log(`${new Date().toLocaleString('zh-CN', { hour12: false })} 命令窗口 #${row.id}（${row.from}）${now.status}，退出码 ${String(result.code)}，用时 ${seconds} 秒：${row.command.slice(0, 120)}`);
    });
  }

  /** 用户定了：还是 pending 才管；同意就跑，拒绝就记 rejected。 */
  private onDecided(pending: Pending): void {
    if (pending.kind !== 'run') return;
    const runId = (pending.payload as { runId?: unknown } | undefined)?.runId;
    const row = typeof runId === 'string' ? this.read(runId) : undefined;
    if (row === undefined || row.status !== 'pending') return;
    if (pending.state === 'approved') {
      row.review = { by: 'user', reason: `用户同意（${pending.by ?? ''}）`, ms: row.review.ms };
      this.launch(row);
      return;
    }
    row.status = 'rejected';
    row.error = `用户拒绝（${pending.by ?? ''}）`;
    row.endedAt = Date.now();
    this.save(row);
  }

  /**
   * 停下：先记 stopped（跑完、用户定了的回调看到就不改），在跑的 abort，在等用户的拒掉待确认。
   * @returns 停下以后的记录；没有这条是 undefined。
   */
  stop(id: string): RunRecord | undefined {
    const row = this.read(id);
    if (row === undefined || !['pending', 'running'].includes(row.status)) return row;
    const wasRunning = row.status === 'running';
    row.status = 'stopped';
    row.error = '被停下了';
    if (!wasRunning) row.endedAt = Date.now();
    this.save(row);
    if (wasRunning) this.live.get(id)?.stop.abort();
    else if (row.approvalId !== undefined) this.ctx.approval.decide(row.approvalId, false, '命令窗口：发命令的停下了');
    return this.read(id);
  }

  /** 每 500 毫秒读一次，结束了或到点就交回。 */
  async wait(id: string, ms: number): Promise<Row | undefined> {
    const end = Date.now() + ms;
    let row = this.read(id);
    while (row !== undefined && ['pending', 'running'].includes(row.status) && Date.now() < end) {
      await Bun.sleep(Math.min(500, end - Date.now()));
      row = this.read(id);
    }
    return row;
  }

  /** 整段输出：在跑的取内存，跑完的取表。 */
  output(id: string): string | undefined {
    const live = this.live.get(id);
    if (live !== undefined) return live.chunks.join('');
    return this.read(id)?.output;
  }

  /** 结尾：最后 200 行、20000 字节；截过开头加一句。 */
  tail(id: string): string {
    const all = this.output(id) ?? '';
    let lines = all.split('\n');
    let cut = false;
    if (lines.length > TAIL_LINES) { lines = lines.slice(-TAIL_LINES); cut = true; }
    let text = lines.join('\n');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > TAIL_BYTES) { text = bytes.subarray(bytes.length - TAIL_BYTES).toString('utf8').replace(/^\uFFFD+/u, ''); cut = true; }
    return cut ? `[只留了最后一段，全部输出用 /api/runs/${id}/log 看]\n${text}` : text;
  }

  /** 最近的，新的在前。 */
  list(limit: number): RunRecord[] {
    const rows = this.ctx.resources.db.query('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((item) => { const { output, ...record } = recordOf(item); void output; return record; });
  }

  /** 读一条。 */
  read(id: string): Row | undefined {
    const item = this.ctx.resources.db.query('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | null;
    return item === null ? undefined : recordOf(item);
  }

  /** 写一行；新建时顺手删掉最近 300 条以外的已结束的。 */
  private save(row: Row, fresh = false): void {
    const db = this.ctx.resources.db;
    db.query('INSERT OR REPLACE INTO runs (id, command, cwd, why, source, timeout_sec, status, review, approval_id, created_at, started_at, ended_at,'
      + ' code, timed_out, error, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id, row.command, row.cwd, row.why, row.from, row.timeoutSec, row.status, JSON.stringify(row.review), row.approvalId ?? null,
      row.createdAt, row.startedAt ?? null, row.endedAt ?? null, row.code ?? null, row.timedOut === undefined ? null : row.timedOut ? 1 : 0,
      row.error ?? null, row.output ?? null);
    if (fresh) {
      db.query("DELETE FROM runs WHERE status NOT IN ('pending', 'running') AND id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)").run(KEEP);
    }
  }
}


/** 表里一行转成记录。 */
function recordOf(item: Record<string, unknown>): Row {
  const row: Row = {
    id: item['id'] as string, command: item['command'] as string, cwd: item['cwd'] as string, why: item['why'] as string, from: item['source'] as string,
    timeoutSec: item['timeout_sec'] as number, status: item['status'] as Row['status'], review: JSON.parse(item['review'] as string) as Row['review'],
    createdAt: item['created_at'] as number,
  };
  if (item['approval_id'] !== null) row.approvalId = item['approval_id'] as number;
  if (item['started_at'] !== null) row.startedAt = item['started_at'] as number;
  if (item['ended_at'] !== null) row.endedAt = item['ended_at'] as number;
  if (item['code'] !== null) row.code = item['code'] as number;
  if (item['timed_out'] !== null) row.timedOut = item['timed_out'] === 1;
  if (item['error'] !== null) row.error = item['error'] as string;
  if (item['output'] !== null) row.output = item['output'] as string;
  return row;
}

/** 网址参数转正整数，夹在 [1, max]；不给或不对用 fallback。 */
function clamp(value: string | undefined, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback;
}


/**
 * 登记五条接口。
 * @param app http 的 Fastify 实例。
 * @param runs 命令窗口。
 */
function routes(app: fastify.FastifyInstance, runs: Runs): void {
  type Id = { Params: { id: string } };
  const missing = (id: string) => ({ error: `没有这条命令：${id}` });
  app.post<{ Body: unknown }>('/api/run', async (request, reply) => {
    try {
      return await runs.start(request.body);
    } catch (error) {
      if (error instanceof BadInput) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
  app.get<{ Querystring: { limit?: string } }>('/api/runs', async (request) => runs.list(clamp(request.query.limit, LIST_DEFAULT, LIST_MAX)));
  app.get<Id & { Querystring: { wait?: string } }>('/api/runs/:id', async (request, reply) => {
    const seconds = Number(request.query.wait);
    const row = Number.isFinite(seconds) && seconds > 0 ? await runs.wait(request.params.id, Math.min(WAIT_MAX_SEC, seconds) * 1000) : runs.read(request.params.id);
    if (row === undefined) return reply.code(404).send(missing(request.params.id));
    const { output, ...record } = row;
    void output;
    return { ...record, tail: runs.tail(row.id) };
  });
  app.get<Id>('/api/runs/:id/log', async (request, reply) => {
    const text = runs.output(request.params.id);
    if (text === undefined) return reply.code(404).send(missing(request.params.id));
    return reply.type('text/plain; charset=utf-8').send(text);
  });
  app.post<Id>('/api/runs/:id/stop', async (request, reply) => {
    const row = runs.stop(request.params.id);
    if (row === undefined) return reply.code(404).send(missing(request.params.id));
    const { output, ...record } = row as Row;
    void output;
    return record;
  });
}


/**
 * 挂上命令窗口。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  routes(ctx.http.app, new Runs(ctx));
}
