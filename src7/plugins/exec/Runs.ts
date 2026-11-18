/**
 * 命令窗口（由原 runs 并入 exec）：外面的 AI 或网页不经过模型，直接 POST /api/run 跑一条命令。
 * 先发 approval/request（action: review）请审核插件审（规则 → decision → 审核小会话 → 问用户），放行才交给 exec.run 跑；
 * 没挂 approval、超时一律拒绝（requestReview）。写了 ask_user: true 的，放不了行就去问用户，同意了再跑；没写的直接拒绝（照 0.4）。
 * 跑的时候输出攒在内存，查一条能看结尾；跑完整段输出存进表 runs。程序重启时没跑完的记成失败。
 * 照 0.4 src/executors/Runs.ts、src/channels/Http.ts:646-716。设计见同目录 说明.md 的「设计要点」一节（runs）。
 */
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import { stampId } from '../../utils/Names.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import type { Exec } from './index.ts';


/** 一件待确认：照 approval 声明的 approval/decided 事件取，不 import approval 目录。 */
export type Pending = requestEventModule.EventArg<'approval/decided'>;

/** 发给审核的一条命令：照 approval 声明的 approval/request（action: review）取。 */
export type ReviewInput = Extract<requestEventModule.EventArg<'approval/request'>, { action: 'review' }>['input'];

/** approval/result 回执：照 approval 声明的事件取。 */
type ApprovalReply = requestEventModule.EventArg<'approval/result'>;

/** 审的结论：放行、拒绝，或已经去问用户了（带待确认的号）。 */
export type ReviewVerdict = NonNullable<ApprovalReply['verdict']>;


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
/** 审一条命令最多等多久：审核小会话要跑一阵（契约 3.1：review 65 秒）。 */
const REVIEW_WAIT_MS = 65_000;
/** 结尾留几行、几个字节。 */
const TAIL_LINES = 200;
const TAIL_BYTES = 20_000;


/** 输入不对：处理函数回 400。 */
class BadInput extends Error {}


/**
 * 请审核插件审一条命令：发请求事件 approval/request（action: review，契约 3.2 第 1 条），等 approval/result。工具 exec、命令窗口都用它。
 * 没挂 approval、超过 65 秒、提问的会话喊停、approval 出错，一律当拒绝（契约 3.1：安全把关类，没有审核就不让跑命令）。
 * @param ctx exec 插件的 ctx。
 * @param input 命令、目录、机器人、会话、提的人、payload、问不问用户、停止信号（透传给审核，审核小会话跟着停）。
 * @returns 放行、拒绝，或已经去问用户了。
 */
export async function requestReview(ctx: cordis.Context, input: ReviewInput): Promise<ReviewVerdict> {
  const request = { action: 'review', input } as const;
  const options = {
    prefix: 'apr',
    timeoutMs: REVIEW_WAIT_MS,
    signal: input.signal,
    onFallback: getRejected,
  };

  //M 发 approval/request 等审核结论；提问的会话喊停，这次等待跟着结束（退回拒绝）。
  const result = await requestEventModule.requestEvent(ctx, 'approval/request', 'approval/result', request, options);

  //G 审核接了单但没给结论（办的时候出错，只回了 error）：也当拒绝。
  if (result.verdict === undefined) return { result: 'reject', by: 'rule', reason: `审核出错：${result.error ?? '没给结论'}` };

  return result.verdict;
}


/**
 * 审核没回（没挂 approval、超时、停了、出错）时的退回：拒绝，requestId 留空。
 * 写明返回类型，verdict 里的 'reject'、'rule' 才是字面量；交给 requestEvent 的 onFallback。
 * @param reason requestEvent 给的退回原因。
 * @param detail 出错时的原话。
 */
function getRejected(reason: requestEventModule.FallbackReason, detail?: string): ApprovalReply {
  let text = `审核未就绪或超时（${reason}），没有审核就不跑命令`;
  if (detail !== undefined) {
    text = `审核出错：${detail}，没有审核就不跑命令`;
  }
  return { requestId: '', verdict: { result: 'reject', by: 'rule', reason: text } };
}


/**
 * 校验并读取 `plugins[exec].config.runs`（默认开启；写 `false` 关闭命令窗口 HTTP 接口）。
 * @param raw 原始配置。
 * @throws 类型不合法时抛错。
 */
export function readRunsEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === true) return true;

  if (raw === false) return false;

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return true;

  throw new Error('exec.runs 要是 true、false 或对象');
}


/** 命令窗口：负责 runs 表持久化、审核后调度 exec.run、内存实时输出以及停止控制。 */
export class Runs {
  /** 正在跑的：开关、攒着的输出。 */
  private readonly live = new Map<string, { stop: AbortController; chunks: string[] }>();

  /**
   * 建表，收拾上次没跑完的，听 approval/decided。
   * @param ctx Cordis 给 exec 插件的 ctx。
   * @param exec 同插件内初始化完成的 Exec 执行器。
   */
  constructor(private readonly ctx: cordis.Context, private readonly exec: { run: Exec['run'] }) {
    //M 建 runs 表（已有就不动），一行一条命令记录。
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT NOT NULL, why TEXT NOT NULL, source TEXT NOT NULL,'
      + ' timeout_sec INTEGER NOT NULL, status TEXT NOT NULL, review TEXT NOT NULL, approval_id INTEGER, created_at INTEGER NOT NULL,'
      + ' started_at INTEGER, ended_at INTEGER, code INTEGER, timed_out INTEGER, error TEXT, output TEXT)');

    //M 上次没跑完的（在跑的、审核到一半的）记失败；在等用户的留着（待确认在库里，重启后还能同意）。
    const now = Date.now();
    db.query("UPDATE runs SET status = 'failed', error = '程序重启了，没跑完', ended_at = ? WHERE status = 'running' OR (status = 'pending' AND approval_id IS NULL)").run(now);

    //M approval/decided（通知）：只管自己放的（kind 是 run，payload 是 { runId }）。
    ctx.on('approval/decided', (pending) => this.onDecided(pending));
  }

  /**
   * POST /api/run：校验、记一行、审、按结论拒绝 / 等用户 / 跑。
   * @param body 请求体。
   * @returns 审完那一刻的记录。
   * @throws BadInput：输入不对。
   */
  async start(body: unknown): Promise<RunRecord> {
    let input: Record<string, unknown> = {};
    if (typeof body === 'object' && body !== null) {
      input = body as Record<string, unknown>;
    }

    //G 入口校验：command 要是非空字符串。
    const command = input['command'];
    if (typeof command !== 'string' || command.trim() === '') throw new BadInput('command 要是非空字符串');

    const text = (key: string, fallback: string): string => {
      //G 取字符串参数：没给用默认值，给了不是字符串就拒绝。
      const value = input[key] ?? fallback;
      if (typeof value !== 'string') throw new BadInput(`${key} 要是字符串`);

      return value;
    };

    //G timeout 是秒，要是正数，没给用默认值。
    const timeout = input['timeout'] ?? DEFAULT_TIMEOUT_SEC;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) throw new BadInput('timeout 是秒，要是正数');

    //G ask_user 要是布尔，没给就是 false（放不了行直接拒绝，不去问用户）。
    const askUser = input['ask_user'] ?? false;
    if (typeof askUser !== 'boolean') throw new BadInput('ask_user 要是 true 或 false');

    //M 记一行新命令：号用时间戳，其余字段取上面校验过的值。
    const row: Row = {
      id: stampId(),
      command,
      cwd: text('cwd', this.ctx.resources.root),
      why: text('why', ''),
      from: text('from', 'api'),
      timeoutSec: Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.round(timeout))),
      status: 'pending',
      review: { by: 'rule', reason: '审核中', ms: 0 },
      createdAt: Date.now(),
    };

    //M 先存一行 pending，审核期间别人也能查到；新建时顺手清掉太旧的。
    this.save(row, true);

    const began = Date.now();
    const reviewInput: ReviewInput = {
      command,
      cwd: row.cwd,
      kind: 'run',
      payload: { runId: row.id },
      ask: askUser,
    };

    //M 发 approval/request 请审核插件审；没挂、超时都是拒绝。
    const verdict = await requestReview(this.ctx, reviewInput);

    //M 审核期间别人可能停过它：重新读最新的一行，读不到就用手里这行。
    const now = this.read(row.id) ?? row;
    let reviewBy = 'user';
    if (verdict.result !== 'asked') {
      reviewBy = verdict.by;
    }
    now.review = { by: reviewBy, reason: verdict.reason, ms: Date.now() - began };

    //G 审核期间被停下了：去问了用户的那条也作废。
    if (now.status !== 'pending') {
      if (verdict.result === 'asked') {
        this.dismiss(verdict.id);
      }
      //M 状态保持被停下的样子，只把审核结论补进去存表。
      this.save(now);
      return now;
    }
    if (verdict.result === 'reject') {
      //M 审核拒绝：记成 rejected 和结束时间，存表返回。
      now.status = 'rejected';
      now.endedAt = Date.now();
      this.save(now);
      return now;
    }
    if (verdict.result === 'asked') {
      //M 去问用户了：记下待确认的号，等用户定了由 onDecided 接着办。
      now.approvalId = verdict.id;
      this.save(now);
      return now;
    }

    //M 放行了：开跑（输出边跑边攒，跑完整段存表）。
    this.launch(now);
    return now;
  }

  /** 跑一条：exec.run，输出边跑边攒，跑完整段存表。 */
  private launch(row: Row): void {
    //M 先记成在跑并存表，再登记停止开关和输出缓存，最后交给 exec.run 起子进程。
    row.status = 'running';
    row.startedAt = Date.now();
    this.save(row);
    const entry = { stop: new AbortController(), chunks: [] as string[] };
    this.live.set(row.id, entry);
    void this.exec.run({
      command: row.command,
      cwd: row.cwd,
      timeoutMs: row.timeoutSec * 1000,
      signal: entry.stop.signal,
      onOutput: (chunk) => entry.chunks.push(chunk),
    }).then((result) => {
      //M 跑完了：撤掉实时输出，重读最新一行（可能已被停下），把结果和整段输出写回表。
      this.live.delete(row.id);
      const now = this.read(row.id) ?? row;
      now.output = result.output;
      if (result.code !== null) {
        now.code = result.code;
      }
      now.timedOut = result.timedOut;
      //G 先被停下（stopped）的不改状态，只补输出。
      if (now.status === 'running') {
        now.status = 'failed';
        if (result.code === 0 && !result.timedOut && result.error === undefined) {
          now.status = 'done';
        }
        let error = result.error;
        if (error === undefined && result.timedOut) {
          error = `超过 ${String(row.timeoutSec)} 秒，已结束`;
        }
        if (error !== undefined) {
          now.error = error;
        }
      }
      //M 记下结束时间，存表，再打一行日志。
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
    if (typeof runId !== 'string') return;

    //G 读出那条记录；不在了或已经不是等待中（比如被停下了）就不管。
    const row = this.read(runId);
    if (row === undefined || row.status !== 'pending') return;

    if (pending.state === 'approved') {
      //M 用户同意：记下谁同意的，接着开跑。
      row.review = { by: 'user', reason: `用户同意（${pending.by ?? ''}）`, ms: row.review.ms };
      this.launch(row);
      return;
    }

    //M 用户拒绝：记成 rejected，写明谁拒绝的，存表。
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
    //G 没有这条、或已经结束了的，原样交回，不用停。
    const row = this.read(id);
    if (row === undefined || !['pending', 'running'].includes(row.status)) return row;

    const wasRunning = row.status === 'running';
    row.status = 'stopped';
    row.error = '被停下了';
    if (!wasRunning) {
      row.endedAt = Date.now();
    }

    //M 存表：别的回调（跑完、用户定了）读到 stopped 就不会再改状态。
    this.save(row);
    if (wasRunning) {
      //M 还在跑的：喊停，exec.run 会把整棵子进程杀掉；交回最新记录。
      this.live.get(id)?.stop.abort();
      return this.read(id);
    }
    if (row.approvalId !== undefined) {
      //M 在等用户的：把去问用户的那条待确认拒掉。
      this.dismiss(row.approvalId);
    }

    //M 交回停下以后最新的记录。
    return this.read(id);
  }

  /**
   * 作废去问用户的那条待确认（发命令的停下了）：发 approval/request（action: decide，拒绝）。
   * 不带 requestId，发完就走（契约 3.1：清理类不等回执）；审核插件没挂或出错都不管，那条在库里照旧是在等。
   * @param id 待确认的号。
   */
  private dismiss(id: number): void {
    const request = { action: 'decide', id, approve: false, by: '命令窗口：发命令的停下了' } as const;

    //M 发完不等；出错吞掉，免得没人接的拒绝变成未处理的 Promise 错误。
    void this.ctx.serial('approval/request', request).catch(() => undefined);
  }

  /** 每 500 毫秒读一次，结束了或到点就交回。 */
  async wait(id: string, ms: number): Promise<Row | undefined> {
    //M 先读一次；还在等或在跑就每 500 毫秒再读，结束了或到点就交回。
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
    //M 在跑的输出还攒在内存里，优先取内存。
    const live = this.live.get(id);
    if (live !== undefined) return live.chunks.join('');

    //M 不在内存了：取表里存的整段。
    return this.read(id)?.output;
  }

  /** 结尾：最后 200 行、20000 字节；截过开头加一句。 */
  tail(id: string): string {
    //M 取整段输出，先按行只留最后 200 行。
    const all = this.output(id) ?? '';
    let lines = all.split('\n');
    let cut = false;
    if (lines.length > TAIL_LINES) {
      lines = lines.slice(-TAIL_LINES);
      cut = true;
    }

    //M 再按字节只留最后 20000 字节，截断处可能切坏半个字，开头的乱码字符去掉。
    let text = lines.join('\n');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > TAIL_BYTES) {
      text = bytes.subarray(bytes.length - TAIL_BYTES).toString('utf8').replace(/^\uFFFD+/u, '');
      cut = true;
    }
    if (cut) return `[只留了最后一段，全部输出用 /api/runs/${id}/log 看]\n${text}`;

    return text;
  }

  /** 最近的，新的在前。 */
  list(limit: number): RunRecord[] {
    //M 取最近 limit 条（新的在前），列表里不带整段输出。
    const rows = this.ctx.resources.db.query('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((item) => {
      const { output, ...record } = getRecord(item);
      void output;
      return record;
    });
  }

  /** 读一条。 */
  read(id: string): Row | undefined {
    //M 按号查表，没有这一行就是 undefined。
    const item = this.ctx.resources.db.query('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | null;
    if (item === null) return undefined;

    //M 表里的一行转成记录。
    return getRecord(item);
  }

  /** 写一行；新建时顺手删掉最近 300 条以外的已结束的。 */
  private save(row: Row, fresh = false): void {
    const db = this.ctx.resources.db;
    let timedOutFlag: number | null = null;
    if (row.timedOut !== undefined) {
      timedOutFlag = 0;
      if (row.timedOut) {
        timedOutFlag = 1;
      }
    }

    //M 整行覆盖写入（表里没有就新建）。
    db.query('INSERT OR REPLACE INTO runs (id, command, cwd, why, source, timeout_sec, status, review, approval_id, created_at, started_at, ended_at,'
      + ' code, timed_out, error, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id, row.command, row.cwd, row.why, row.from, row.timeoutSec, row.status, JSON.stringify(row.review), row.approvalId ?? null,
      row.createdAt, row.startedAt ?? null, row.endedAt ?? null, row.code ?? null, timedOutFlag,
      row.error ?? null, row.output ?? null);
    if (fresh) {
      //M 新建时顺手删掉最近 300 条以外的已结束的，表不会越长越大。
      db.query("DELETE FROM runs WHERE status NOT IN ('pending', 'running') AND id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)").run(KEEP);
    }
  }
}


/** 表里一行转成记录。 */
function getRecord(item: Record<string, unknown>): Row {
  const row: Row = {
    id: item['id'] as string,
    command: item['command'] as string,
    cwd: item['cwd'] as string,
    why: item['why'] as string,
    from: item['source'] as string,
    timeoutSec: item['timeout_sec'] as number,
    status: item['status'] as Row['status'],
    review: JSON.parse(item['review'] as string) as Row['review'],
    createdAt: item['created_at'] as number,
  };
  if (item['approval_id'] !== null) {
    row.approvalId = item['approval_id'] as number;
  }
  if (item['started_at'] !== null) {
    row.startedAt = item['started_at'] as number;
  }
  if (item['ended_at'] !== null) {
    row.endedAt = item['ended_at'] as number;
  }
  if (item['code'] !== null) {
    row.code = item['code'] as number;
  }
  if (item['timed_out'] !== null) {
    row.timedOut = item['timed_out'] === 1;
  }
  if (item['error'] !== null) {
    row.error = item['error'] as string;
  }
  if (item['output'] !== null) {
    row.output = item['output'] as string;
  }
  return row;
}


/**
 * 登记五条命令窗口 HTTP 接口（路由与协议保持与原 runs 插件完全一致）。
 * @param app http 的 Fastify 实例。
 * @param runs 命令窗口实例。
 */
export function mountRunsRoutes(app: fastify.FastifyInstance, runs: Runs): void {
  //M 五条路由：跑一条、列表、查一条、看整段输出、停下；处理函数都转给 runs 的同名方法。
  type Id = { Params: { id: string } };
  const missing = (id: string) => ({ error: `没有这条命令：${id}` });
  app.post<{ Body: unknown }>('/api/run', async (request, reply) => {
    try {
      //M 交给 runs.start 校验、审核、开跑，返回审完那一刻的记录。
      return await runs.start(request.body);
    } catch (error) {
      //G 输入不对（BadInput）回 400，别的错误往上抛。
      if (error instanceof BadInput) return reply.code(400).send({ error: error.message });

      throw error;
    }
  });

  //M GET /api/runs：最近几条命令的列表。
  app.get<{ Querystring: { limit?: string } }>('/api/runs', async (request) => {
    //M limit 夹在 [1, LIST_MAX]；没给、不是整数、比 1 小都按 LIST_DEFAULT（utils/Text.ts 的 getNumber）。
    const limit = textModule.getNumber(request.query.limit, LIST_DEFAULT, 1, LIST_MAX);
    return runs.list(limit);
  });

  //M GET /api/runs/:id：查一条；带 wait 就等它结束（最多 120 秒）。
  app.get<Id & { Querystring: { wait?: string } }>('/api/runs/:id', async (request, reply) => {
    const seconds = Number(request.query.wait);
    const loadRow = async (): Promise<Row | undefined> => {
      //M 带了 wait：等它结束或到点再交回。
      if (Number.isFinite(seconds) && seconds > 0) return runs.wait(request.params.id, Math.min(WAIT_MAX_SEC, seconds) * 1000);

      //M 没带 wait：现在是什么样就读什么样。
      return runs.read(request.params.id);
    };

    //M 读出来；没有这条就回 404。
    const row = await loadRow();
    if (row === undefined) return reply.code(404).send(missing(request.params.id));

    //M 返回时去掉整段输出，只带结尾那一段（tail）。
    const { output, ...record } = row;
    void output;
    return { ...record, tail: runs.tail(row.id) };
  });

  //M GET /api/runs/:id/log：整段输出，纯文本。
  app.get<Id>('/api/runs/:id/log', async (request, reply) => {
    const text = runs.output(request.params.id);
    if (text === undefined) return reply.code(404).send(missing(request.params.id));

    //M 整段输出当纯文本回。
    return reply.type('text/plain; charset=utf-8').send(text);
  });

  //M POST /api/runs/:id/stop：停下一条（在跑的杀掉，在等用户的作废），返回停下以后的记录。
  app.post<Id>('/api/runs/:id/stop', async (request, reply) => {
    const row = runs.stop(request.params.id);
    if (row === undefined) return reply.code(404).send(missing(request.params.id));

    const { output, ...record } = row as Row;
    void output;
    return record;
  });
}
