/**
 * 用量：模型每调用一次记一行（表 model_usage，列照 0.4），给网页的用量页按时间段、分组合计（GET /api/usage），
 * 也给 web-api 的回话追溯按会话、时间窗取（服务 usage.list）。
 * 成功的听 session/message（接进对话的模型回答）；失败的听骨架的 model/failed（重试的每一次都算）。
 * 钱：挂了 model-catalog 就按它给的价格算（美元每百万 token），没挂就是 0。
 * 设计：docs/src7插件设计/usage.md。
 */
import * as cordis from 'cordis';
import type * as piAi from '@earendil-works/pi-ai';
import type { Session } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'usage';

/** 用到的服务：resources 拿数据库。http、modelCatalog 是可选的（见 apply、add）。 */
export const inject = ['resources'];


declare module 'cordis' {
  interface Context {
    /** 用量服务，实现在 src7/plugins/usage/index.ts。别的插件当可选依赖，用 ctx.get('usage') 现取。 */
    usage: Usage;
  }
}


/** 一次调用，形状照网页的 TraceUsage（web/src/Types.ts:223-254）。 */
export interface UsageRecord {
  at: number;
  provider: string;
  model: string;
  kind: string;
  purpose: string;
  bot?: string;
  sessionId?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  ms: number;
  ok: boolean;
  error?: string;
}


/** model-catalog 里用到的（总览第 3 节待补约定第 7 条）：按“供应商/模型 ID”找，价格美元每百万 token。 */
interface CatalogLike {
  find(id: string): { price?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined;
}


/** 时间段 → SQLite strftime 的格式（同 0.4：src/capabilities/Store.ts:353-367）。 */
const FORMATS: Record<string, string> = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' };

/** 分组 → 列（只许这几个，免得拼 SQL 出事）。 */
const GROUPS: Record<string, string> = { provider: 'provider', model: 'model', purpose: 'purpose', bot: "COALESCE(bot, '')" };

/** 会话种类 → 用途（网页用量页认的名字，web/src/Panel/Usage.tsx:165-177）；别的原样。 */
const PURPOSES: Record<string, string> = { work: 'session', front: 'dispatch', compress: 'compact' };

/** 不给 from 时看最近几天。 */
const DEFAULT_DAYS = 7;

/** 错误最多留几个字。 */
const ERROR_MAX_CHARS = 300;

/** 合计的那几列。 */
const SUMS = 'COUNT(*) AS calls, COALESCE(SUM(1 - ok), 0) AS failures, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, '
  + 'COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(ms), 0) AS ms';


/** 一格合计。 */
interface Bucket {
  calls: number;
  failures: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  ms: number;
}


/** 用量服务。 */
export class Usage extends cordis.Service {
  /**
   * 登记 usage 插件：把 Usage 作为服务挂到 Cordis 上（以后用 ctx.usage 取）；再建表，听回答和失败。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'usage');
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS model_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,'
      + ' provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, purpose TEXT NOT NULL, bot TEXT, session_id TEXT,'
      + ' input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,'
      + ' cost REAL NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT)');
    db.exec('CREATE INDEX IF NOT EXISTS model_usage_at ON model_usage (at)');
    db.exec('CREATE INDEX IF NOT EXISTS model_usage_session ON model_usage (session_id, at)');

    //M 接进对话的是模型的回答 → 记一行成功的。假模型（插件直接给的回答）也记，token 是 0。
    ctx.on('session/message', (session, message) => {
      if (message.role !== 'assistant') return;

      this.add(session, `${message.provider}/${message.model}`, message.usage, message.durationMs ?? 0, undefined);
    });

    //M 一次没成的调用 → 记一行失败的；重试的每一次都会来一次。
    ctx.on('model/failed', (info) => {
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as piAi.Usage;
      this.add(info.session, info.model, zero, info.ms, info.error.slice(0, ERROR_MAX_CHARS));
    });
  }

  /**
   * 记一行：补上供应商、用途、钱。
   * @param session 哪场会话。
   * @param model 供应商/模型 ID。
   * @param usage pi 给的用量。
   * @param ms 用时。
   * @param error 失败的原因；成功是 undefined。
   * 副作用：写库。
   */
  private add(session: Session, model: string, usage: piAi.Usage, ms: number, error: string | undefined): void {
    //M 价格：model-catalog 是可选的服务，ctx.get 现取，没挂就是 undefined，钱记 0。
    const catalog = this.ctx.get('modelCatalog') as CatalogLike | undefined;
    const price = catalog?.find(model)?.price;
    const cost = price === undefined ? 0 : ((usage.input * (price.input ?? 0)) + (usage.output * (price.output ?? 0))
      + (usage.cacheRead * (price.cacheRead ?? 0)) + (usage.cacheWrite * (price.cacheWrite ?? 0))) / 1e6;
    const row = session.row;
    const sql = 'INSERT INTO model_usage (at, provider, model, kind, purpose, bot, session_id, input, output, cache_read, cache_write,'
      + ' cost, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [Date.now(), model.slice(0, model.indexOf('/')), model, 'chat', PURPOSES[row.kind] ?? row.kind, row.bot, session.id,
      usage.input, usage.output, usage.cacheRead, usage.cacheWrite, cost, ms, error === undefined ? 1 : 0, error ?? null];
    this.ctx.resources.db.query(sql).run(...values);
  }

  /**
   * 服务方法：同会话、同时间窗的调用，给回话追溯用（0.4 的 listUsage）。调用方是插件，可信。
   * @param query 会话、时间窗（两头都含）、最多几条。
   * @returns 按时间先后；多于 limit 条时 truncated 是 true。
   */
  list(query: { sessions: string[]; from: number; to: number; limit: number }): { rows: UsageRecord[]; truncated: boolean } {
    if (query.sessions.length === 0) return { rows: [], truncated: false };

    const marks = query.sessions.map(() => '?').join(', ');
    const sql = `SELECT * FROM model_usage WHERE session_id IN (${marks}) AND at BETWEEN ? AND ? ORDER BY at, id LIMIT ?`;
    const found = this.ctx.resources.db.query(sql).all(...query.sessions, query.from, query.to, query.limit + 1) as Record<string, unknown>[];
    const rows = found.slice(0, query.limit).map((item): UsageRecord => {
      const record: UsageRecord = {
        at: item['at'] as number, provider: item['provider'] as string, model: item['model'] as string, kind: item['kind'] as string,
        purpose: item['purpose'] as string, input: item['input'] as number, output: item['output'] as number,
        cacheRead: item['cache_read'] as number, cacheWrite: item['cache_write'] as number, cost: item['cost'] as number,
        ms: item['ms'] as number, ok: item['ok'] === 1,
      };
      if (item['bot'] !== null) record.bot = item['bot'] as string;
      if (item['session_id'] !== null) record.sessionId = item['session_id'] as string;
      if (item['error'] !== null) record.error = item['error'] as string;
      return record;
    });
    return { rows, truncated: found.length > query.limit };
  }

  /**
   * GET /api/usage：按时间段、分组合计（时间段按服务器本地时间切），每行另算命中率，另给合计。
   * @param params 网址参数：by、group、from、to。
   * @returns { by, group, from, to, rows, totals }；by、group 不对是 undefined（回 400）。
   */
  report(params: Record<string, string | undefined>): Record<string, unknown> | undefined {
    const by = params['by'] ?? 'day';
    const group = params['group'] ?? 'model';
    const format = FORMATS[by];
    const column = GROUPS[group];
    if (format === undefined || column === undefined) return undefined;

    const to = Number(params['to']) || Date.now();
    const from = Number(params['from']) || to - DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    const db = this.ctx.resources.db;
    const sql = `SELECT strftime('${format}', at / 1000, 'unixepoch', 'localtime') AS period, ${column} AS key, ${SUMS}`
      + ' FROM model_usage WHERE at >= ? AND at < ? GROUP BY period, key ORDER BY period, key';
    const rows = (db.query(sql).all(from, to) as (Bucket & { period: string; key: string })[]).map(withHitRate);
    const totals = withHitRate(db.query(`SELECT ${SUMS} FROM model_usage WHERE at >= ? AND at < ?`).get(from, to) as Bucket);
    return { by, group, from, to, rows, totals };
  }
}


/**
 * 给一格合计加上命中率：缓存读 / (输入 + 缓存读)，分母 0 给 0。
 * @param bucket 一格合计。
 */
function withHitRate<T extends Bucket>(bucket: T): T & { hitRate: number } {
  const base = bucket.input + bucket.cacheRead;
  return { ...bucket, hitRate: base === 0 ? 0 : bucket.cacheRead / base };
}


/**
 * 挂上用量。
 * apply 是 Cordis 插件的入口：inject 里的 resources 就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  const usage = new Usage(ctx);

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口。
  void ctx.inject(['http'], (sub) => {
    sub.http.app.get<{ Querystring: Record<string, string | undefined> }>('/api/usage', async (request, reply) => {
      const report = usage.report(request.query);
      if (report === undefined) {
        return reply.code(400).send({ error: 'by 要是 hour、day、week、month；group 要是 provider、model、purpose、bot' });
      }
      return report;
    });
  });
}
