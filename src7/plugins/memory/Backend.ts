/**
 * 检索后端：客服要用的“按客户、会话、机器人找历史”“知识库检索”“结果带来源和片段能引用”都走这一层。
 * 一个接口 MemoryBackend，两种实现：
 * - LocalBackend：本机 SQLite（ctx.resources.db 的 memory_chunks 表），按字组打分（Recall.ts 同一套），不要模型、不要外部服务，完全能用。
 * - HttpBackend：外部检索服务（计划是 vector-graph-rag 或它的 Rust 重写版，由基地壳子托管成独立 HTTP 服务）。
 *   协议写在 docs/src7插件设计/memory.md 第 11 节；向量、图检索都在那边做，这里只是照协议发请求。
 *   外部连不上就退回本地搜（本地一直同步写一份），结果上写明用的是哪个。
 * 设计：docs/src7插件设计/memory.md 第 11 节。
 */
import type { Database } from 'bun:sqlite';
import * as recall from './Recall.ts';
import * as textModule from '../../utils/Text.ts';


/** 范围：history 是聊天记录，knowledge 是知识库。 */
export type MemoryScope = 'history' | 'knowledge';

/** 入库的一段。 */
export interface MemoryDoc {
  /** 来源：会话的“session:<会话号>”，知识库文件的绝对路径。删、重建按它。 */
  source: string;
  scope: MemoryScope;
  /** 哪个机器人；公共知识库是 ''。 */
  bot: string;
  /** 客户：渠道:用户（feishu:ou_xxx、http:本机）；知识库是 ''。 */
  customer: string;
  /** 会话号；知识库是 ''。 */
  session: string;
  /** 一句标题：“用户说”“机器人答”、文件名。 */
  title: string;
  /** 正文。 */
  text: string;
  /** 时刻，毫秒。 */
  at: number;
  /** 在来源里的位置：第几行到第几行；聊天记录是第几条消息。 */
  start: number;
  end: number;
  /** false：只收进记忆（照样能搜），不抽关系图（聊天记录按 memory.history_graph / no_graph_customers）。不写 = 抽。 */
  graph?: boolean;
}

/** 要找什么。bot、customer、session 给了就只找对得上的；不给不限。 */
export interface MemoryQuery {
  query: string;
  scope: MemoryScope | 'all';
  bot?: string;
  customer?: string;
  session?: string;
  /** 不要这场会话的（开场先搜：找这个客户以前的，不找这一场）。 */
  notSession?: string;
  limit: number;
}

/** 搜到的一条：能直接引用。 */
export interface Citation {
  scope: MemoryScope;
  source: string;
  bot: string;
  customer: string;
  session: string;
  title: string;
  /** 命中的片段（不是整篇）。 */
  snippet: string;
  /** 0 到 1，越大越像。 */
  score: number;
  at: number;
  start: number;
  end: number;
}

/** 检索后端。 */
export interface MemoryBackend {
  /** 名字：local、http。 */
  readonly name: string;
  /** 入库（同一来源的老片段由调用的先 remove）。 */
  ingest(docs: MemoryDoc[]): Promise<void>;
  /** 删掉一个来源的全部片段。 */
  remove(source: string): Promise<void>;
  /** 搜。 */
  search(query: MemoryQuery): Promise<Citation[]>;
  /** 状态：几条、通不通。 */
  health(): Promise<Record<string, unknown>>;
}


/** 本地搜：先用 LIKE 粗筛的最多几行。 */
const CANDIDATES = 5000;
/** 片段最多几个字。 */
const SNIPPET_CHARS = 240;
/** 外部服务默认等几毫秒。 */
const HTTP_TIMEOUT_MS = 8000;


/** 本机 SQLite 后端。 */
export class LocalBackend implements MemoryBackend {
  readonly name = 'local';

  /** @param db ctx.resources.db。 */
  constructor(private readonly db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS memory_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, scope TEXT NOT NULL,'
      + ' bot TEXT NOT NULL, customer TEXT NOT NULL, session TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,'
      + ' at INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_chunks_source ON memory_chunks (source)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_chunks_who ON memory_chunks (scope, bot, customer, session)');
  }

  /** 入库：一批一个事务，每段一行。 */
  async ingest(docs: MemoryDoc[]): Promise<void> {
    const insert = this.db.query('INSERT INTO memory_chunks (source, scope, bot, customer, session, title, text, at, start_at, end_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const doc of docs) insert.run(doc.source, doc.scope, doc.bot, doc.customer, doc.session, doc.title, doc.text, doc.at, doc.start, doc.end);
    })();
  }

  /** 删掉一个来源的全部片段。 */
  async remove(source: string): Promise<void> {
    this.db.query('DELETE FROM memory_chunks WHERE source = ?').run(source);
  }

  /**
   * 搜：照范围、机器人、客户、会话筛，字组 LIKE 粗筛（最近的 5000 行），再按字组打分；分数是“问的话里的字组对上了几成”，
   * 原话整段出现再加 0.2，封顶 1。对上不到三成的丢；同样的片段只留一条。
   */
  async search(query: MemoryQuery): Promise<Citation[]> {
    //M 问的话拆成字组；total 是“全对上”的满分，下面每行的得分除以它得到几成。
    const wanted = recall.grams(query.query);
    const total = recall.matchScore(wanted, query.query);
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (query.scope !== 'all') { where.push('scope = ?'); values.push(query.scope); }
    if (query.bot !== undefined) { where.push("(bot = ? OR (scope = 'knowledge' AND bot = ''))"); values.push(query.bot); }
    if (query.customer !== undefined) { where.push("(customer = ? OR scope = 'knowledge')"); values.push(query.customer); }
    if (query.session !== undefined) { where.push("(session = ? OR scope = 'knowledge')"); values.push(query.session); }
    if (query.notSession !== undefined) { where.push('session != ?'); values.push(query.notSession); }
    //M 粗筛：任意一个字组出现（最多拿 12 个）；切不出字组就整句 LIKE。
    const likes = (wanted.size > 0 ? [...wanted].slice(0, 12) : [query.query.trim()]).filter((part) => part !== '');
    if (likes.length === 0) return [];
    where.push(`(${likes.map(() => 'text LIKE ?').join(' OR ')})`);
    values.push(...likes.map((part) => `%${part.replace(/[%_]/gu, '')}%`));
    const sql = `SELECT * FROM memory_chunks WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ${String(CANDIDATES)}`;
    const rows = this.db.query(sql).all(...values) as ChunkRow[];

    //M 粗筛出来的行逐行打分：字组对上几成就是分数，原话整段出现再加 0.2；不到 0.3 的丢，按分数、时间排，同样的片段只留一条。
    const needle = query.query.trim().toLowerCase();
    const seen = new Set<string>();
    return rows
      .map((row) => {
        const hit = total > 0 ? recall.matchScore(wanted, row.text) / total : 0;
        const exact = needle !== '' && row.text.toLowerCase().includes(needle) ? 0.2 : 0;
        return { row, score: Math.min(1, (total > 0 ? hit : 0.8) + exact) };
      })
      .filter((entry) => entry.score >= 0.3)
      .sort((left, right) => right.score - left.score || right.row.at - left.row.at)
      .filter((entry) => {
        const key = entry.row.text.trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, query.limit)
      //M 取前 limit 条，每条用 getSnippet 截命中处前后 240 字当片段，分数留两位小数。
      .map(({ row, score }) => ({
        scope: row.scope, source: row.source, bot: row.bot, customer: row.customer, session: row.session, title: row.title,
        snippet: getSnippet(row.text, wanted, needle), score: Math.round(score * 100) / 100, at: row.at, start: row.start_at, end: row.end_at,
      }));
  }

  /** 状态：每个范围（history、knowledge）各存了几段。 */
  async health(): Promise<Record<string, unknown>> {
    const rows = this.db.query('SELECT scope, COUNT(*) AS n FROM memory_chunks GROUP BY scope').all() as { scope: string; n: number }[];
    return { backend: 'local', ok: true, chunks: Object.fromEntries(rows.map((row) => [row.scope, row.n])) };
  }
}


/**
 * 外部检索服务（vector-graph-rag 之类）。协议（memory.md 第 11 节）：
 * POST {url}/ingest {docs}；POST {url}/remove {source}；POST {url}/search {MemoryQuery} → {hits: Citation[]}；GET {url}/health。
 * 本地一直同步写一份；外部出错就用本地的结果，并在 lastError 记下原因（health 里看得到）。
 */
export class HttpBackend implements MemoryBackend {
  readonly name = 'http';
  /** 上一次出错的原因；好了清空。 */
  lastError = '';

  /**
   * @param url 外部服务地址（memory.backend_url）。
   * @param local 本地后端：同步写、出错时兜底。
   * @param timeoutMs 每个请求最多等多久。
   * @param token 有就带 Authorization: Bearer（memory.backend_token）。
   */
  constructor(private readonly url: string, private readonly local: LocalBackend, private readonly timeoutMs = HTTP_TIMEOUT_MS, private readonly token = '') {}

  /** 入库：本地先写一份（出错兜底用），再发给外部服务；外部出错只记原因不抛。 */
  async ingest(docs: MemoryDoc[]): Promise<void> {
    //M 本地一直同步写一份；外部服务出错（this.fail）只记在 lastError，不挡会话。
    await this.local.ingest(docs);
    await this.call('POST', '/ingest', { docs }).catch((error: unknown) => this.fail(error));
  }

  /** 删一个来源：本地先删，再通知外部服务；外部出错只记原因不抛。 */
  async remove(source: string): Promise<void> {
    //M 本地同步删；外部服务出错（this.fail）只记在 lastError，不挡会话。
    await this.local.remove(source);
    await this.call('POST', '/remove', { source }).catch((error: unknown) => this.fail(error));
  }

  /** 搜：问外部服务，回的形状不对或出错就退回本地搜，lastError 里看得到原因。 */
  async search(query: MemoryQuery): Promise<Citation[]> {
    try {
      //M 问外部服务的 /search，回 {hits}；超时、非 2xx 都抛错，落到下面的 catch 退回本地。
      const body = await this.call('POST', '/search', query);
      const hits = (body as { hits?: unknown } | undefined)?.hits;
      if (!Array.isArray(hits)) throw new Error('外部检索服务回的不是 {hits: [...]}');
      this.lastError = '';
      return hits.filter(isCitation).slice(0, query.limit).map((hit) => ({
        scope: hit.scope === 'knowledge' ? 'knowledge' : 'history', source: hit.source, bot: hit.bot ?? '', customer: hit.customer ?? '', session: hit.session ?? '',
        title: hit.title ?? '', snippet: hit.snippet, score: typeof hit.score === 'number' ? hit.score : 0, at: hit.at ?? 0, start: hit.start ?? 0, end: hit.end ?? 0,
      }));
    } catch (error) {
      //G 外部服务出错不能挡会话：记下原因，退回本地搜（本地一直同步写着一份）。
      this.fail(error);
      return this.local.search(query);
    }
  }

  /** 状态：外部服务的 /health、本地的状态、上一次出错的原因，一起交回；外部连不上也不抛。 */
  async health(): Promise<Record<string, unknown>> {
    //M 本地后端的状态：几条、通不通。
    const local = await this.local.health();

    //M 问外部服务的 /health；连不上不抛，把原因写进 remote 交回。
    const remote = await this.call('GET', '/health').then((body) => body, (error: unknown) => ({ ok: false, error: textModule.getMessage(error) }));
    return { backend: 'http', url: this.url, remote, local, lastError: this.lastError };
  }

  /** 记下错（不抛：外部服务挂了不能挡会话）。 */
  private fail(error: unknown): void {
    //M 只把原因文字存进 lastError，health 里看得到；调用的人决定要不要退回本地。
    this.lastError = textModule.getMessage(error);
  }

  /** 发一个请求，交回 JSON；不是 2xx 抛错。 */
  private async call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token !== '') headers['authorization'] = `Bearer ${this.token}`;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${this.url}${route}`, init);
    if (!response.ok) throw new Error(`外部检索服务 ${route} 回了 ${String(response.status)}`);
    return response.json();
  }
}


/** 表里一行。 */
interface ChunkRow {
  source: string;
  scope: MemoryScope;
  bot: string;
  customer: string;
  session: string;
  title: string;
  text: string;
  at: number;
  start_at: number;
  end_at: number;
}

/**
 * 片段：对上字组最多的那一行（或原话出现的地方）前后截 240 字。
 * @param text 整段。
 * @param wanted 问的话的字组。
 * @param needle 原话（小写）。
 */
function getSnippet(text: string, wanted: Set<string>, needle: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if ([...flat].length <= SNIPPET_CHARS) return flat;
  let at = needle === '' ? -1 : flat.toLowerCase().indexOf(needle);
  if (at < 0) {
    const first = [...wanted].map((gram) => flat.toLowerCase().indexOf(gram)).filter((index) => index >= 0).sort((left, right) => left - right)[0];
    at = first ?? 0;
  }
  const from = Math.max(0, at - SNIPPET_CHARS / 3);
  const piece = flat.slice(from, from + SNIPPET_CHARS);
  return `${from > 0 ? '…' : ''}${piece}${from + SNIPPET_CHARS < flat.length ? '…' : ''}`;
}

/** 外部服务回的一条像不像 Citation（至少有 source、snippet）。 */
function isCitation(value: unknown): value is Partial<Citation> & { source: string; snippet: string } {
  const item = value as Partial<Citation> | null;
  return typeof item === 'object' && item !== null && typeof item.source === 'string' && typeof item.snippet === 'string';
}