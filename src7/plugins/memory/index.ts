/**
 * 记忆：工具 memory（列、搜、读、写、删机器人自己的记忆和公共记忆），干活的会话第一次调模型前先替模型搜一次。
 * 开场先搜只搜技能目录和基地的记忆库：两个记忆目录 prompt 插件每一步已经整篇拼进系统提示词了，不重复。
 * 配了基地（engine.index_url + engine.memory_libs）就后台跟着文件改动刷新记忆库索引（Libs.ts）。
 * 客服用的记忆库（Store.ts、Backend.ts）：聊天记录按客户、会话、机器人收，知识库文件按段收；工具 memory 的 history、knowledge，
 *   开场先搜也带上“这个客户以前说过的”和知识库；结果带编号、来源、片段，回答时能引用。检索后端可换（本地 SQLite，或外部服务 backend_url）。
 *   HTTP：GET /api/memory/recall、POST /api/memory/knowledge、GET /api/memory/backend。
 * 托管服务（Services.ts）：插件挂上时隐藏拉起 jmbots-memory、vgr，挂在主端口 /memory/、/memory/vgr/ 下；配置 services，见 Services.ts。
 * 设计：docs/src7插件设计/memory.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { ChatRequest } from '../../Chat.ts';
import type { Session } from '../../Sessions.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as backendModule from './Backend.ts';
import * as graphPolicy from './GraphPolicy.ts';
import * as libsModule from './Libs.ts';
import * as recall from './Recall.ts';
import * as servicesModule from './Services.ts';
import * as storeModule from './Store.ts';


/** 插件名。 */
export const name = 'memory';

/** 用到的服务：resources 拿目录和配置；tools 登记工具；bots 找机器人的记忆目录和语言。 */
export const inject = ['resources', 'tools', 'bots'];


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 开场先搜到的那一段；'' 是搜过没搜到；没有这一项是还没搜。 */
    recall?: string;
  }
}


/** memory search 时本地最多给几个文件、记忆库最多几条。 */
const SEARCH_HITS = 8;

/** 切不出字组时按词找，最多几行。 */
const WORD_LINES = 40;

/** 记忆库片段最多几个字。 */
const SNIPPET_CHARS = 300;

/** history、knowledge 默认给几条。 */
const CITE_HITS = 8;


/** 插件配置（plugins 里 memory 的 config），都可以不写。 */
interface Settings {
  /** 收不收聊天记录，默认收。 */
  history: boolean;
  /** 开场先搜给几条这个客户以前的话、几条知识库；0 不给。 */
  recallHistory: number;
  recallKnowledge: number;
}


/** 记忆插件。 */
class Memory {
  /**
   * 登记工具，挂开场先搜。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param base 基地和库；没配是 undefined。
   */
  constructor(private readonly ctx: cordis.Context, private readonly base: recall.Base | undefined, readonly store: storeModule.Store, private readonly settings: Settings) {
    //M 工具说明照 0.4 原文（src/capabilities/tools/Tools.ts:539-562）。前台也给，但只许 list、search、read（run 里查）。
    ctx.tools.register({
      definition: {
        name: 'memory',
        description: '记忆：你自己的 memory/，加所有机器人共用的公共记忆。scope 默认 own 是你自己的，'
          + 'shared 是公共的；写公共记忆必须明确写 shared。action：list 列出文件；'
          + 'search 找相关的（整句或几个词都行；你的记忆、公共记忆、技能一起搜，配了记忆库也用 RAG 一起搜，'
          + '不用给 scope，每条给文件和命中片段）；read 读一个文件；write 写（覆盖）；delete 删。'
          + 'path 是相对记忆文件夹的路径。索引.md 是记忆概要：增删改记忆时同步改它。'
          + 'history 找这个客户的资料和以前的聊天记录（range：customer 这个客户跟你的所有会话，默认；session 只这一场；只能查当前这个客户的，查不到别的客户）；'
          + 'knowledge 找知识库。这两个每条带编号、来源、片段：回答用到了就写上 [编号] 和来源，没找到就说没找到，不要编。'
          + '客户问事实、业务知识（合同、产品、负责人、联系方式、组织关系、规则等）先用 history 和 knowledge 查。',
        parameters: piAi.Type.Object({
          action: piAi.Type.Union(['list', 'search', 'read', 'write', 'delete', 'history', 'knowledge'].map((value) => piAi.Type.Literal(value)), { description: '做什么' }),
          range: piAi.Type.Optional(piAi.Type.Union(['customer', 'session'].map((value) => piAi.Type.Literal(value)),
            { description: 'history 时：customer 这个客户（默认）、session 这一场' })),
          limit: piAi.Type.Optional(piAi.Type.Number({ description: 'history、knowledge 时最多几条，默认 8' })),
          scope: piAi.Type.Optional(piAi.Type.Union(['own', 'shared'].map((value) => piAi.Type.Literal(value)),
            { description: 'list、read、write、delete 时：own 自己的（默认），shared 公共的' })),
          query: piAi.Type.Optional(piAi.Type.String({ description: 'search、history、knowledge 时：要找什么，整句或几个词' })),
          path: piAi.Type.Optional(piAi.Type.String({ description: 'read、write、delete 时：相对记忆文件夹的路径' })),
          content: piAi.Type.Optional(piAi.Type.String({ description: 'write 时：文件内容' })),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => this.run(args, session),
    });

    //M 听 session/request：每一步调模型前骨架挨个问插件（ctx.serial），这里往 system 里加开场搜到的那段。
    ctx.on('session/request', (request) => this.onRequest(request));

    //M 听 session/message（通知）：用户看得到的会话（有渠道、没有 parent）每接一条就收进聊天记录。收不成只打日志，不挡会话。
    if (settings.history) {
      ctx.on('session/message', (session, message) => {
        if (message.role !== 'user' && message.role !== 'assistant') return;
        void store.ingestSession(session.row).then((count) => {
          if (count > 0) session.save();
        }).catch((error: unknown) => console.error(`记忆库收聊天记录出错：${error instanceof Error ? error.message : String(error)}`));
      });
    }
  }

  /**
   * 开场先搜：干活的会话第一次调模型前搜一次，结果记在 row.recall，以后每一步带同一段。
   * @param request 这一步的请求。
   */
  private async onRequest(request: ChatRequest): Promise<void> {
    const session = request.session;
    const row = session.row;
    if (row.kind !== 'work') return;
    //G 非本人（builder、guest）、不受信的群里不搜、不带开场先搜的：搜的是用户的记忆库、知识库和以前的聊天。
    if (!workspaceModule.privateAllowed(row.address)) return;

    if (row.recall === undefined) {
      const said = row.messages.filter((message) => message.role === 'user').map((message) => piAi.contentText(message.content)).join('\n');
      const started = Date.now();
      //G 搜不成（基地挂了之类）不挡会话：当没搜到。
      const hits = await Promise.all([recall.local(this.skillRoots(row.bot), said), recall.libs(this.base, said)])
        .then(([own, libs]) => [...own, ...libs]).catch(() => []);
      const cited = await this.openingCitations(row, said).catch(() => []);
      const citedText = cited.length === 0 ? '' : `# 可能相关的聊天记录和知识库（程序先搜的；回答用到了写上 [编号] 和来源）\n${storeModule.citeText(cited)}`;
      row.recall = [recall.describe(hits, this.language(row.bot)), citedText].filter((part) => part !== '').join('\n\n');
      session.save();

      //T 跟踪：开场先搜完了。
      const vars = { 会话: session.id, 几条: hits.length, 引用: cited.length, 后端: this.store.backend.name, 用时毫秒: Date.now() - started };
      this.ctx.emit('trace', 'Memory.recall', '开场先搜完了', 'recall.local(技能目录) + recall.libs(记忆库) + store.search(聊天记录、知识库)', vars);
    }
    if (row.recall !== '') request.system.push(row.recall);
  }

  /**
   * 开场先搜的引用：这个客户以前的（不含这一场）几条，知识库几条。
   * @param row 干活的会话。
   * @param said 用户说过的话。
   */
  private async openingCitations(row: Session['row'], said: string): Promise<backendModule.Citation[]> {
    const query = [...said].slice(0, 300).join('');
    const customer = storeModule.customerOf(row);
    const history = this.settings.recallHistory > 0 && customer !== ''
      ? await this.store.search({ query, scope: 'history', bot: row.bot, customer, notSession: row.id, limit: this.settings.recallHistory + 2 })
      : [];
    //M 前台那场也记了这一轮的原话：片段就是这次说的话的，不算“以前说过的”。
    const older = history.filter((hit) => !said.includes(hit.snippet.replace(/^…|…$/gu, ''))).slice(0, this.settings.recallHistory);
    const knowledge = this.settings.recallKnowledge > 0 ? await this.store.search({ query, scope: 'knowledge', bot: row.bot, limit: this.settings.recallKnowledge }) : [];
    return [...older, ...knowledge];
  }

  /**
   * history、knowledge：照范围搜，写成带编号的引用。
   * @param action history 或 knowledge。
   */
  private async cite(action: 'history' | 'knowledge', args: Record<string, unknown>, session: Session): Promise<string> {
    const query = required(args, 'query');
    const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.min(30, Math.floor(args['limit'])) : CITE_HITS;
    const row = session.row;
    const wanted: backendModule.MemoryQuery = { query, scope: action, bot: row.bot, limit };
    if (action === 'history') {
      const range = args['range'] ?? 'customer';
      //G 隔离：聊天记录每次都只搜这个客户的（session 也再加上客户号）；不再有“跟所有人的”（原来的 range: bot 会搜到别的客户，演示隔离题就是这么串的）。
      if (range !== 'customer' && range !== 'session') throw new Error(`range 只能是 customer 或 session，不能是 ${String(range)}：只能查当前这个客户的记录`);
      const customer = storeModule.customerOf(row);
      if (customer === '') throw new Error(storeModule.NO_CUSTOMER);
      wanted.customer = customer;
      if (range === 'session') wanted.session = row.id;
    }
    const hits = await this.store.search(wanted);
    //T 跟踪：history、knowledge 搜完了。
    this.ctx.emit('trace', 'Memory.cite', `memory ${action} 搜完了`, 'store.search(query)', { 会话: session.id, 条数: hits.length, 后端: this.store.backend.name, 范围: args['range'] ?? '' });
    if (hits.length === 0) return `没找到「${query}」相关的${action === 'history' ? '聊天记录' : '知识库内容'}`;
    return `找到 ${String(hits.length)} 条（回答用到了写上 [编号] 和来源）：\n${storeModule.citeText(hits)}`;
  }

  /**
   * 工具本体。
   * @param args 模型给的参数（Tools.ts 照定义校验过）。
   * @param session 哪场会话。
   * @returns 给模型看的话。
   * @throws 参数缺了、越界、前台要写都抛错，原因给模型看。
   */
  private async run(args: Record<string, unknown>, session: Session): Promise<string> {
    const action = args['action'] as string;
    const bot = this.ctx.bots.get(session.row.bot);
    if (bot === undefined) throw new Error(`没有这个机器人：${session.row.bot}`);

    const shared = this.ctx.resources.dir('memory');
    const dir = args['scope'] === 'shared' ? shared : bot.memory;
    if (session.row.kind === 'front' && (action === 'write' || action === 'delete')) throw new Error('前台只能 list、search、read');

    if (action === 'list') {
      const names = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true })).catch(() => [] as string[]);
      return names.length === 0 ? '（记忆文件夹是空的）' : names.map((item) => item.replace(/\\/gu, '/')).sort().join('\n');
    }
    if (action === 'search') return this.search(required(args, 'query'), [bot.memory, shared, ...this.skillRoots(bot.name)], session);
    if (action === 'history' || action === 'knowledge') return this.cite(action, args, session);

    const file = memoryFile(dir, required(args, 'path'));
    if (action === 'read') {
      if (!fs.existsSync(file)) throw new Error(`没有这个记忆文件：${file}`);
      return fs.readFileSync(file, 'utf8');
    }
    if (action === 'write') {
      const content = required(args, 'content', true);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return `已写入记忆 ${file}（${size(Buffer.byteLength(content, 'utf8'))}）`;
    }
    fs.rmSync(file);
    return `已删除记忆 ${file}`;
  }

  /**
   * memory search：四处按字组打分（短话也算），配了记忆库再用 RAG 搜，两段合起来。
   * @param query 搜什么。
   * @param roots 自己的记忆、公共记忆、两个技能目录。
   * @param session 哪场会话（跟踪用）。
   */
  private async search(query: string, roots: string[], session: Session): Promise<string> {
    const hits = await recall.local(roots, query, { maxFiles: SEARCH_HITS, loose: true });
    let local = hits.map((hit) => [`@${hit.file}`, ...hit.lines.map((line) => `  …${line}`)].join('\n')).join('\n');

    //G 切不出字组（比如只有两个字母）：退回按词逐行找，最多 40 行。
    if (hits.length === 0 && recall.grams(query).size === 0) local = wordLines(roots, query).join('\n');

    const found = this.base === undefined ? [] : await recall.searchLibs(this.base, query, SEARCH_HITS);
    const libText = found.map((item) => {
      const summary = item.summary === '' ? '' : `\n  ${item.summary}`;
      const snippet = item.snippet === '' ? '' : `\n  …${recall.short(item.snippet, SNIPPET_CHARS)}`;
      return `${item.path}${summary}${snippet}`;
    }).join('\n\n');

    const knowledge = await this.store.search({ query, scope: 'knowledge', bot: session.row.bot, limit: SEARCH_HITS }).catch(() => []);

    //T 跟踪：工具搜完了。
    const vars = { 会话: session.id, 本地: hits.length, 记忆库: found.length, 知识库: knowledge.length };
    this.ctx.emit('trace', 'Memory.search', 'memory 工具搜完了', 'recall.local + recall.searchLibs', vars);

    const parts = [
      local === '' ? '' : `# 你的记忆、公共记忆、技能\n${local}`,
      found.length === 0 ? '' : `# 记忆库 ${this.base?.libs ?? ''}\n${libText}`,
      knowledge.length === 0 ? '' : `# 知识库（回答用到了写上 [编号] 和来源）\n${storeModule.citeText(knowledge)}`,
    ].filter((part) => part !== '');
    return parts.length > 0 ? parts.join('\n\n') : `没找到「${query}」相关的记忆`;
  }

  /** 两个技能目录：全局的、机器人自己的。 */
  private skillRoots(bot: string): string[] {
    return [this.ctx.resources.dir('bots', bot, 'skills'), this.ctx.resources.dir('skills')];
  }

  /** 机器人的语言，不写是 zh（和 prompt 同一个读法）。 */
  private language(bot: string): string {
    return String(this.ctx.bots.get(bot)?.config['language'] ?? 'zh');
  }
}


/**
 * 取一个必填的字符串参数。
 * @param allowEmpty 空串也算（write 的 content）。
 * @throws 没给时抛错。
 */
function required(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && value === '')) throw new Error(`这个 action 要给 ${key}`);
  return value;
}

/**
 * 记忆文件的绝对路径：开头的 @ 去掉，只能在记忆文件夹里，不能是文件夹本身。
 * @throws 越界时抛错。
 */
function memoryFile(dir: string, relative: string): string {
  const file = path.resolve(dir, relative.replace(/^@/u, ''));
  const back = path.relative(dir, file);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`memory 只能动 ${dir} 里的文件`);
  return file;
}

/** 字节数写成 12 B、3.4 KB、1.2 MB。 */
function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 按词逐行找（切不出字组时用）：几个目录下的 .md、.txt，每个词出现的行，不分大小写。
 * @returns “绝对路径:行号: 那一行”，去重，最多 40 行。
 */
function wordLines(roots: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/u).filter((word) => word !== '');
  const lines = new Set<string>();
  for (const root of roots) {
    for (const name of new Bun.Glob('**/*.{md,txt}').scanSync({ cwd: root, onlyFiles: true })) {
      const file = path.join(root, name);
      const text = fs.statSync(file).size > 256 * 1024 ? '' : fs.readFileSync(file, 'utf8');
      text.split(/\r?\n/u).forEach((line, index) => {
        if (words.some((word) => line.toLowerCase().includes(word))) lines.add(`${file}:${String(index + 1)}: ${recall.short(line.trim(), 160)}`);
      });
      if (lines.size >= WORD_LINES) return [...lines].slice(0, WORD_LINES);
    }
  }
  return [...lines];
}



/** 前台等别的插件往记忆库写、搜聊天记录时给的一段（客户号必带；进不进关系图由 memory 按 history_graph / no_graph_customers 定）。 */
export interface HistoryDoc {
  source: string; scope: 'history'; bot: string; customer: string; session: string; title: string; text: string; at: number; start: number; end: number;
}

declare module 'cordis' {
  interface Context {
    memory: MemoryService;
  }
}

/**
 * ctx.memory：记忆库只由本插件读写（2026-11-14 claude_指导意见 4.1）。别的插件在 inject 里写 memory 再调这几个方法，
 * 不用知道记忆服务的地址、不读本插件的配置。服务没开时：embed 交回 undefined、searchHistory 交回 []、recordHistory 抛错。
 */
export class MemoryService extends cordis.Service {
  /**
   * @param ctx 本插件的 ctx。
   * @param addressOf 托管服务的内部地址：'memory' 是 jmbots-memory，'vgr' 是 vgr；'' 是没有。
   * @param graph 聊天记录进不进关系图。
   */
  constructor(ctx: cordis.Context, private readonly addressOf: (service: string) => string, private readonly graph: graphPolicy.GraphPolicy) {
    super(ctx, 'memory');
  }

  /** 2026-11-17 jm开发：托管服务的地址（默认 jmbots-memory，可问 'vgr'），memory-graph 用，不再自己拼。'' 是没有。 */
  url(service = 'memory'): string {
    return this.addressOf(service);
  }

  /** 2026-11-17 jm开发：问托管服务的 /health（默认 jmbots-memory，可问 'vgr'）。不通也不抛，交回 ok:false 和原因。 */
  async health(service = 'memory'): Promise<Record<string, unknown>> {
    const url = this.addressOf(service);
    const started = Date.now();
    //G 没有地址：服务没托管、也没配 service_url。
    if (url === '') return { url, ok: false, ms: 0, error: `没有 ${service} 服务的地址` };
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      return { url, ok: response.ok, ms: Date.now() - started, ...body };
    } catch (error) {
      return { url, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 2026-11-17 jm开发：原样转给记忆服务 POST /search（memory-graph 的检索页用，最多等 2 分钟）。连不上抛错，服务没开交回 503。 */
  search(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: unknown }> {
    return this.post('/search', body, 120_000);
  }

  private async post(route: string, body: unknown, ms: number): Promise<{ ok: boolean; status: number; json: unknown }> {
    const base = this.addressOf('memory');
    if (base === '') return { ok: false, status: 503, json: undefined };
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, json };
  }

  /** 用记忆服务的本地嵌入模型算向量；没有 /embed、模型没就绪、连不上交回 undefined。 */
  async embed(texts: string[]): Promise<number[][] | undefined> {
    if (texts.length === 0) return [];
    try {
      const res = await this.post('/embed', { texts }, 30000);
      const body = res.json as { ok?: unknown; vectors?: unknown } | undefined;
      if (!res.ok || body === undefined || body === null || body.ok === false || !Array.isArray(body.vectors)) return undefined;
      return body.vectors as number[][];
    } catch {
      return undefined;
    }
  }

  /** 记一段往来：同一 source 先删后收；按关系图规则打 graph:false。没有客户号的不收。 */
  async recordHistory(source: string, docs: HistoryDoc[]): Promise<void> {
    const kept = docs.filter((doc) => doc.customer !== '').map((doc) => graphPolicy.markGraph(this.graph, doc));
    if (kept.length === 0) return;
    if (!(await this.post('/remove', { source }, 8000)).ok) throw new Error('remove failed');
    if (!(await this.post('/ingest', { docs: kept }, 15000)).ok) throw new Error('ingest failed');
  }

  /** 搜这个客户的聊天记录（hybrid，不调大模型）；没有客户号不搜。交回命中原样（start 是来源里的编号）。 */
  async searchHistory(query: { query: string; bot: string; customer: string; limit: number }): Promise<Array<{ start?: unknown; score?: unknown; text?: unknown }>> {
    if (query.customer === '') return [];
    try {
      const res = await this.post('/search', { ...query, scope: 'history', mode: 'hybrid', rerank: false }, 8000);
      const hits = (res.json as { hits?: unknown } | undefined)?.hits;
      return res.ok && Array.isArray(hits) ? hits as Array<{ start?: unknown }> : [];
    } catch {
      return [];
    }
  }
}

/**
 * 挂上记忆。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后 Cordis 调一次。记忆库名读 engine.memory_libs，基地由 ctx.base 提供。
 * @param ctx Cordis 给这个插件的 ctx。
 * @throws memory_libs 不是字符串时抛错（插件不挂，打一行原因）。
 */
export function apply(ctx: cordis.Context, config?: Record<string, unknown>): void {
  //M 2026-11-14：记忆服务、vgr 归本插件托管（Services.ts）；backend_url 可写服务名（memory / vgr），走主端口下它的路径。
  const own = { ...(config ?? {}) };
  const mainPort = Number(((ctx.resources.raw['server'] ?? {}) as { port?: unknown }).port) || 30086;
  const hosted = new servicesModule.Services(ctx.resources.root, mainPort, servicesModule.readServices(own['services']));
  const named = typeof own['backend_url'] === 'string' ? hosted.route(`/memory/${own['backend_url']}`) ?? (own['backend_url'] === 'memory' ? hosted.route('/memory') : undefined) : undefined;
  if (named !== undefined) own['backend_url'] = `http://127.0.0.1:${String(mainPort)}${named.item.spec.path}`;
  const settings = readSettings(own);
  const local = new backendModule.LocalBackend(ctx.resources.db);
  const backend = settings.backendUrl === '' ? local : new backendModule.HttpBackend(settings.backendUrl, local, settings.timeoutMs, settings.token);
  const store = new storeModule.Store(backend, ctx.resources.root, ctx.resources.db, settings.graph);
  const engine = (ctx.resources.raw['engine'] ?? {}) as Record<string, unknown>;
  const libs = engine['memory_libs'];
  if (libs !== undefined && typeof libs !== 'string') throw new Error('engine.memory_libs 要是字符串，几个库用逗号连着写');

  //M 不缓存启动时可能还没挂上的基地；Recall 每次请求再从 ctx 取服务，本地记忆照常工作。
  const base = typeof libs === 'string' && libs.trim() !== ''
    ? { ctx, libs: libs.split(',').map((part) => part.trim()).filter((part) => part !== '').join(',') }
    : undefined;
  new Memory(ctx, base, store, settings);
  //M 记忆服务地址：配置 service_url 优先，否则本插件托管的 memory（内部地址，端口可能启动时才定，所以每次现取）；vgr 等别的服务只看托管的。
  const serviceUrl = typeof own['service_url'] === 'string' ? own['service_url'].replace(/\/+$/u, '') : '';
  new MemoryService(ctx, (service) => (service === 'memory' && serviceUrl !== '' ? serviceUrl : hosted.urlOf(service) ?? ''), settings.graph);
  routes(ctx, store, hosted);
  ctx.on('ready', () => hosted.start());
  ctx.effect(() => () => hosted.stop());
  //M 进程直接退出（不走拔插件）时也把自己拉起的停掉；壳子被强杀时靠壳子的 Job Object。
  process.once('exit', () => hosted.stop());
  //M Ctrl+C / SIGTERM（源码模式）：先停自己拉起的；http 插件收到信号后会把信号再发一次让进程退出。
  process.once('SIGINT', () => hosted.stop());
  process.once('SIGTERM', () => hosted.stop());
  //M 全部挂完先同步一次知识库（后台跑，不挡启动）。
  ctx.on('ready', () => void store.syncKnowledge(true).catch((error: unknown) => console.error(`知识库同步出错：${error instanceof Error ? error.message : String(error)}`)));
  if (base === undefined) return;

  //M 配了记忆库：等全部插件挂完（ready）再开始刷新；基地缺失或离线时 Libs 静默跳过。
  //M   ctx.effect：先执行一次，交回的函数在插件被拔掉时 Cordis 来调，这里停掉定时器。
  const libsWatch = new libsModule.Libs(ctx, base);
  ctx.on('ready', () => libsWatch.start());
  ctx.effect(() => () => libsWatch.stop());
}


/**
 * 读插件配置。都可以不写：
 * history（默认 true）收聊天记录；recall_history、recall_knowledge（默认 3、3）开场先搜给几条；
 * backend_url 外部检索服务（vector-graph-rag 之类，协议见 memory.md 第 11 节），不写就用本地；backend_token、backend_timeout_ms。
 * history_graph（默认 true）聊天记录抽不抽关系图；no_graph_customers 这些客户的聊天记录不抽（`demo:*` 按前缀），见 GraphPolicy.ts。
 * @throws 写错了抛错。
 */
function readSettings(raw: Record<string, unknown>): Settings & { backendUrl: string; token: string; timeoutMs: number; graph: graphPolicy.GraphPolicy } {
  const count = (key: string, fallback: number): number => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) throw new Error(`memory.${key} 要是不小于 0 的整数`);
    return value;
  };
  const text = (key: string): string => {
    const value = raw[key] ?? '';
    if (typeof value !== 'string') throw new Error(`memory.${key} 要是字符串`);
    return value.trim();
  };
  if (raw['history'] !== undefined && typeof raw['history'] !== 'boolean') throw new Error('memory.history 要是 true 或 false');
  const url = text('backend_url').replace(/\/+$/u, '');
  if (url !== '' && !/^https?:\/\//u.test(url)) throw new Error('memory.backend_url 要是 http:// 或 https:// 开头');
  return {
    history: raw['history'] !== false, recallHistory: count('recall_history', 3), recallKnowledge: count('recall_knowledge', 3),
    backendUrl: url, token: text('backend_token'), timeoutMs: count('backend_timeout_ms', 8000) || 8000,
    graph: graphPolicy.readGraphPolicy(raw),
  };
}


/**
 * 记忆库的接口（http 插件在才登记）：
 * GET /api/memory/recall?q=&scope=history|knowledge|all&bot=&customer=&session=&limit= → {backend, hits}（给网页、别的服务查）；
 * POST /api/memory/knowledge {bot?, name, content} 写一篇知识库文件并马上收进去；GET /api/memory/backend 后端状态。
 */
function routes(ctx: cordis.Context, store: storeModule.Store, hosted: servicesModule.Services): void {
  void ctx.inject(['http'], (sub) => {
    const app = sub.http.app;
    app.get<{ Querystring: Record<string, string | undefined> }>('/api/memory/recall', async (request, reply) => {
      const query = request.query;
      const q = (query['q'] ?? '').trim();
      if (q === '') return reply.code(400).send({ error: '要给 q' });
      const scope = query['scope'] === 'history' || query['scope'] === 'knowledge' ? query['scope'] : 'all';
      const wanted: backendModule.MemoryQuery = { query: q, scope, limit: Math.min(50, Math.max(1, Number(query['limit'] ?? 10) || 10)) };
      for (const key of ['bot', 'customer', 'session'] as const) {
        const value = query[key];
        if (value !== undefined && value !== '') wanted[key] = value;
      }
      //G 隔离：查聊天记录不带 customer 就 400（Store.search 也会拒）。
      if (scope !== 'knowledge' && wanted.customer === undefined) return reply.code(400).send({ error: storeModule.NO_CUSTOMER });
      return { backend: store.backend.name, hits: await store.search(wanted) };
    });
    app.post<{ Body: unknown }>('/api/memory/knowledge', async (request, reply) => {
      const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
      const bot = typeof body['bot'] === 'string' ? body['bot'] : '';
      if (typeof body['name'] !== 'string' || typeof body['content'] !== 'string') return reply.code(400).send({ error: '要给 name、content' });
      if (bot !== '' && ctx.bots.get(bot) === undefined) return reply.code(400).send({ error: `没有这个机器人：${bot}` });
      try {
        return { file: await store.writeKnowledge(bot, body['name'], body['content']) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    });
    app.get('/api/memory/backend', async () => store.health());
    app.get('/api/memory/services', () => ({ services: hosted.status() }));
    //M 托管服务的转发：/memory/vgr/* → vgr，/memory/* → jmbots-memory（最长前缀优先）。/memory/ 本身留给页面。
    const forward = async (request: { url: string; method: string; headers: Record<string, unknown>; body: unknown }, reply: { code(n: number): { send(v: unknown): unknown }; header(k: string, v: string): unknown; send(v: unknown): unknown }) => {
      const found = hosted.route(request.url);
      if (found === undefined) return reply.code(404).send({ error: '没有这个服务' });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(key.toLowerCase())) headers[key] = value;
      }
      const body = request.method === 'GET' || request.method === 'HEAD' || request.body === undefined ? undefined
        : typeof request.body === 'string' || request.body instanceof Uint8Array ? request.body : JSON.stringify(request.body);
      try {
        const response = await fetch(`${found.item.url}${found.rest}`, { method: request.method, headers, body: body as BodyInit | undefined, signal: AbortSignal.timeout(300_000) });
        const type = response.headers.get('content-type');
        if (type !== null) reply.header('content-type', type);
        return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        //M 2026-11-14 23:10 EST：报错写清是哪种：服务被重启/掐断，还是根本没开。
        const why = error instanceof Error ? error.message : String(error);
        const hint = /closed|reset|ECONNRESET/iu.test(why) ? '连接中途断了（服务可能正被重启，稍后再试）' : '没开或连不上';
        return reply.code(503).send({ error: `${found.item.spec.name} ${hint}：${why}` });
      }
    };
    //M 转发要原样带请求体：单独一层作用域收任意类型的体（不影响别的插件的解析）。
    void app.register(async (scope) => {
      scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
      for (const prefix of hosted.paths()) scope.all(`${prefix}/*`, forward as never);
    });
  });
}
