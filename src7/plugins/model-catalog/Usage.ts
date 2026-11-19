/**
 * 用量：模型每调用一次记一行（表 model_usage，列照 0.4），给网页的用量页按时间段、分组合计（GET /api/usage），
 * 也给回话追溯按会话、时间窗取（事件 usage/list，兼容服务 usage.list）。
 * 成功的听 session/new-message（接进对话的模型回答）；失败的听骨架的 model/failed（重试的每一次都算）。
 * 钱：按模型清单事件给的价格算（美元每百万 token），查询未响应或没价格时记 0。
 * model-catalog 内的用量子模块，保留 usage 服务名与原事件、统计接口。
 */
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import type * as piAi from '@earendil-works/pi-ai';
import type { Session } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';


declare module 'cordis' {
  interface Context {
    /** 用量服务，实现在 src7/plugins/model-catalog/Usage.ts。别的插件当可选依赖，用 ctx.get('usage') 现取。 */
    usage: Usage;
  }
  interface Events {
    /**
     * 按会话和时间窗取用量记录。
     * 谁发：src7/plugins/web-api/Trace.ts 的 trace
     * 谁接：src7/plugins/model-catalog/Usage.ts 的 Usage.constructor
     */
    'usage/list'(request: UsageQuery & requestEventModule.RequestEnvelope): void | Promise<void>;
    /**
     * 返回记录和截断标记。
     * 谁发：src7/plugins/model-catalog/Usage.ts 的 Usage.constructor
     * 谁接：src7/plugins/web-api/Trace.ts 的 trace
     */
    'usage/list-result'(result: UsageList & requestEventModule.ResultEnvelope): void;
  }
}

/** 用量查询条件。 */
interface UsageQuery {
  /** 要查的会话 ID。 */
  sessions: string[];
  /** 开始时刻（含），毫秒。 */
  from: number;
  /** 结束时刻（含），毫秒。 */
  to: number;
  /** 最多返回几条。 */
  limit: number;
}

/** 用量查询的结果。 */
interface UsageList {
  /** 按时间先后排列的调用记录。 */
  rows: UsageRecord[];
  /** 符合条件的记录超过 limit 时为真。 */
  truncated: boolean;
}

/** 一次调用，形状照网页的 TraceUsage（web/src/Types.ts:223-254）。 */
export interface UsageRecord {
  /** 调用时刻，毫秒。 */
  at: number;
  /** 供应商名。 */
  provider: string;
  /** 供应商与模型 ID。 */
  model: string;
  /** 调用类别。 */
  kind: string;
  /** 会话用途。 */
  purpose: string;
  /** 所属机器人名。 */
  bot?: string;
  /** 所属会话 ID。 */
  sessionId?: string;
  /** 输入 token 数。 */
  input: number;
  /** 输出 token 数。 */
  output: number;
  /** 缓存读取 token 数。 */
  cacheRead: number;
  /** 缓存写入 token 数。 */
  cacheWrite: number;
  /** 费用，美元。 */
  cost: number;
  /** 调用耗时，毫秒。 */
  ms: number;
  /** 调用是否成功。 */
  ok: boolean;
  /** 失败原因。 */
  error?: string;
}


/** 模型清单回执中计价用到的单价，美元每百万 token。 */
interface CatalogPrice {
  /** 输入单价，美元每百万 token。 */
  input: number;
  /** 输出单价，美元每百万 token。 */
  output: number;
  /** 缓存读取单价，美元每百万 token。 */
  cacheRead?: number;
  /** 缓存写入单价，美元每百万 token。 */
  cacheWrite?: number;
}

/** 模型目录查询最多等三秒。 */
const CATALOG_WAIT_MS = 3000;

/** 时间段 → SQLite strftime 的格式（同 0.4：src/capabilities/Store.ts:353-367）。 */
const FORMATS: Record<string, string> = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' };

/** 分组 → 列（只许这几个，免得拼 SQL 出事）。 */
const GROUPS: Record<string, string> = {
  /** 供应商名。 */
  provider: 'provider', model: 'model', purpose: 'purpose', bot: "COALESCE(bot, '')",
};

/** 会话种类 → 用途（网页用量页认的名字，web/src/Panel/Usage.tsx:165-177）；别的原样。 */
const PURPOSES: Record<string, string> = { work: 'session', front: 'dispatch', compress: 'compact' };

/** 不给 from 时看最近几天。 */
const DEFAULT_DAYS = 7;

/** 错误最多留几个字。 */
const ERROR_MAX_CHARS = 300;

/** 合计的那几列。 */
const SUMS = 'COUNT(*) AS calls, COALESCE(SUM(1 - ok), 0) AS failures, '
  + 'COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, '
  + 'COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite, '
  + 'COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(ms), 0) AS ms';


/** 一格合计。 */
interface Bucket {
  /** 调用次数。 */
  calls: number;
  /** 失败次数。 */
  failures: number;
  /** 输入 token 数。 */
  input: number;
  /** 输出 token 数。 */
  output: number;
  /** 缓存读取 token 数。 */
  cacheRead: number;
  /** 缓存写入 token 数。 */
  cacheWrite: number;
  /** 费用，美元。 */
  cost: number;
  /** 调用耗时，毫秒。 */
  ms: number;
}


/** 用量服务。 */
export class Usage extends cordis.Service {
  /**
   * 登记用量子模块：把 Usage 作为服务挂到 Cordis 上（以后用 ctx.usage 取）；再建表，听回答和失败。
   * @param ctx Cordis 给这个插件的 ctx。
   * 副作用：建 model_usage 表和索引，把 Usage 挂到 ctx.usage，并监听用量查询、成功与失败事件。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'usage');
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS model_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,'
      + ' provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, purpose TEXT NOT NULL,'
      + ' bot TEXT, session_id TEXT,'
      + ' input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,'
      + ' cost REAL NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT)');
    db.exec('CREATE INDEX IF NOT EXISTS model_usage_at ON model_usage (at)');
    db.exec('CREATE INDEX IF NOT EXISTS model_usage_session ON model_usage (session_id, at)');

    //M 接进对话的是模型的回答 → 记一行成功的。假模型（插件直接给的回答）也记，token 是 0。
    ctx.on('session/new-message', (session, message) => {
      if (message.role !== 'assistant') return;

      const model = `${message.provider}/${message.model}`;
      const ms = message.durationMs ?? 0;

      //M 只记录模型产出的 assistant 回复，把用量和耗时写入 model_usage。
      void this.add(session, model, message.usage, ms, undefined);
    });

    //M 一次没成的调用 → 记一行失败的；重试的每一次都会来一次。
    ctx.on('model/failed', (info) => {
      //M Usage 是调用用量，input 和 output 记输入、输出 token，cacheRead 等字段单列缓存用量。
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as piAi.Usage;
      const error = info.error.slice(0, ERROR_MAX_CHARS);

      //M 每一次失败也记一行，保留失败原因和耗时。
      void this.add(info.session, info.model, zero, info.ms, error);
    });

    //M 供其他插件通过事件查询已入账的模型调用。
    requestEventModule.onRequestEvent(ctx, 'usage/list', 'usage/list-result', (request) => {
      //M 沿用 list 的排序和截断规则。
      return this.list(request);
    });
  }


  /**
   * 在父插件的可选 HTTP 作用域登记统计接口，路径与查询结果保持不变。
   * @param app HTTP 服务的 Fastify 实例。
   * 副作用：登记 GET /api/usage；不启动监听。
   */
  routes(app: fastify.FastifyInstance): void {
    //M 用量和模型管理共用父插件的 HTTP 注入，不额外创建一个插件入口。
    app.get<{ Querystring: Record<string, string | undefined> }>('/api/usage', async (request, reply) => {
      //M 沿用 by、group、from、to 的统计语义和非法分组的 400 回应。
      const report = this.report(request.query);
      if (report === undefined) {
        const error = 'by 要是 hour、day、week、month；group 要是 provider、model、purpose、bot';
        return reply.code(400).send({ error });
      }
      return report;
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
  private async add(
    session: Session,
    model: string,
    usage: piAi.Usage,
    ms: number,
    error: string | undefined,
  ): Promise<void> {
    //M 按入口收到通知的时刻和会话归属记账，等待价格不改变这两项。
    const at = Date.now();
    const row = session.row;
    const bot = row.bot;
    const purpose = PURPOSES[row.kind] ?? row.kind;
    const sessionId = session.id;
    const slash = model.indexOf('/');
    const provider = model.slice(0, slash);

    const lookup = { action: 'find', model } as const;
    const options = {
      timeoutMs: CATALOG_WAIT_MS,
      onFallback: () => ({ requestId: '' }),
    };

    //M 通过事件查价格，清单未响应或查无模型时按零计费。
    const result = await requestEventModule.requestEvent(
      this.ctx,
      'model-catalog/request',
      'model-catalog/result',
      lookup,
      options,
    );
    const price: CatalogPrice | undefined = result.info?.price;
    let cost = 0;
    if (price !== undefined) {
      cost = ((usage.input * price.input) + (usage.output * price.output)
        + (usage.cacheRead * (price.cacheRead ?? 0)) + (usage.cacheWrite * (price.cacheWrite ?? 0))) / 1e6;
    }
    let ok = 0;
    if (error === undefined) {
      ok = 1;
    }

    const sql = 'INSERT INTO model_usage (at, provider, model, kind, purpose, bot, session_id, input, output,'
      + ' cache_read, cache_write, cost, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [at, provider, model, 'chat', purpose, bot, sessionId,
      usage.input, usage.output, usage.cacheRead, usage.cacheWrite, cost, ms, ok, error ?? null];

    try {
      //M 价格查询结束后记一行，成功和失败使用同一张表。
      const insert = this.ctx.resources.db.query(sql);
      insert.run(...values);
    } catch (error) {
      //G 通知入口不等待写库，失败时记录原因供排查。
      const detail = textModule.getErrorMessage(error);
      console.error(`模型用量没记成：${detail}`);
    }
  }

  /**
   * 服务方法：同会话、同时间窗的调用，给回话追溯用（0.4 的 listUsage）。调用方是插件，可信。
   * @param query 会话、时间窗（两头都含）、最多几条。
   * @returns 按时间先后；多于 limit 条时 truncated 是 true。
   */
  list(query: UsageQuery): UsageList {
    if (query.sessions.length === 0) return { rows: [], truncated: false };

    //M 按会话列表与时间窗多查一条（limit + 1），用来判断是否截断并整理成 UsageRecord 返回。
    const marks = query.sessions.map(() => '?').join(', ');
    const sql = `SELECT * FROM model_usage WHERE session_id IN (${marks}) AND at BETWEEN ? AND ?`
      + ' ORDER BY at, id LIMIT ?';
    const found = this.ctx.resources.db
      .query(sql)
      .all(...query.sessions, query.from, query.to, query.limit + 1) as Record<string, unknown>[];
    const rows = found.slice(0, query.limit).map((item): UsageRecord => {
      const record: UsageRecord = {
        at: item['at'] as number,
        provider: item['provider'] as string,
        model: item['model'] as string,
        kind: item['kind'] as string,
        purpose: item['purpose'] as string,
        input: item['input'] as number,
        output: item['output'] as number,
        cacheRead: item['cache_read'] as number,
        cacheWrite: item['cache_write'] as number,
        cost: item['cost'] as number,
        ms: item['ms'] as number,
        ok: item['ok'] === 1,
      };
      if (item['bot'] !== null) {
        record.bot = item['bot'] as string;
      }
      if (item['session_id'] !== null) {
        record.sessionId = item['session_id'] as string;
      }
      if (item['error'] !== null) {
        record.error = item['error'] as string;
      }
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

    //M 补齐起止时间戳，按时间粒度和分组列统计汇总用量，并分别计算缓存命中率。
    const to = Number(params['to']) || Date.now();
    const from = Number(params['from']) || to - DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    const db = this.ctx.resources.db;
    const sql = `SELECT strftime('${format}', at / 1000, 'unixepoch', 'localtime') AS period, ${column} AS key, ${SUMS}`
      + ' FROM model_usage WHERE at >= ? AND at < ? GROUP BY period, key ORDER BY period, key';
    const rows = (db.query(sql).all(from, to) as (Bucket & { period: string; key: string })[]).map(withHitRate);
    const totals = withHitRate(
      db.query(`SELECT ${SUMS} FROM model_usage WHERE at >= ? AND at < ?`).get(from, to) as Bucket,
    );
    return { by, group, from, to, rows, totals };
  }
}


/**
 * 给一格合计加上命中率：缓存读 / (输入 + 缓存读)，分母 0 给 0。
 * @param bucket 一格合计。
 */
function withHitRate<T extends Bucket>(bucket: T): T & { hitRate: number } {
  const base = bucket.input + bucket.cacheRead;
  let hitRate = 0;
  if (base !== 0) {
    hitRate = bucket.cacheRead / base;
  }
  return { ...bucket, hitRate };
}

