/**
 * 记忆关系图（由原 memory-graph 并入 memory）：
 *   GET /graph/、/graph                          独立关系图页面（web 打包产物 graph.html）
 *   GET /api/memory-graph/customers              有图的客户、知识库
 *   GET /api/memory-graph/status                 记忆服务、vgr 的健康和计数
 *   GET /api/memory-graph/graph                  整张关系图
 *   GET /api/memory-graph/search                 混合检索 + 命中子图 + 原文出处
 *   GET /api/memory-graph/passage/:id、/entity/:id、/edge/:id
 *   session/request                              用到记忆时提示模型在末尾附 [查看关系图](/graph/?...)
 */
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Sessions.ts';
import * as embedded from '../../utils/Embedded.ts';
import { GraphStore } from './GraphStore.ts';
import { Sources, type CitedHit } from './GraphSources.ts';


/** memory 插件 config.graph 配置项（可不写，也可设为 false 关闭关系图）。 */
export interface GraphSettings {
  /** 是否开启关系图路由与链接提示（config.graph: false 关闭）。 */
  enabled: boolean;
  /** jmbots-memory SQLite 库文件路径。 */
  db: string;
  /** 默认检索模式（hybrid | graph）。 */
  mode: string;
  /** 回复用到记忆时是否在系统提示词附加关系图链接要求。 */
  link: boolean;
}

/** 关系图向 MemoryService 取托管地址、探活与检索所需的最小接口。 */
export interface MemoryGateway {
  url(service?: string): string;
  health(service?: string): Promise<Record<string, unknown>>;
  search(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: unknown }>;
}

type Query = { Querystring: Record<string, string | undefined> };
type Id = { Params: { id: string } };
type FastifyApp = cordis.Context['http']['app'];


/**
 * 校验并读取 `plugins[memory].config.graph`。
 * @param root 运行时根目录（resources.root）。
 * @param raw `config.graph` 原始值；未传默认开启，传 `false` 关闭。
 * @throws 类型不合法时抛错。
 */
export function readGraphSettings(root: string, raw: unknown): GraphSettings {
  const defaultDb = path.resolve(root, 'data/memory/memory.db');
  if (raw === false) return { enabled: false, db: defaultDb, mode: 'hybrid', link: true };

  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error('memory.graph 要是 false 或对象');
  }
  const own = (raw ?? {}) as Record<string, unknown>;
  if (own['db'] !== undefined && typeof own['db'] !== 'string') {
    throw new Error('memory.graph.db 要是字符串');
  }
  if (own['mode'] !== undefined && typeof own['mode'] !== 'string') {
    throw new Error('memory.graph.mode 要是字符串');
  }
  if (own['link'] !== undefined && typeof own['link'] !== 'boolean') {
    throw new Error('memory.graph.link 要是 true 或 false');
  }
  let db = 'data/memory/memory.db';
  if (typeof own['db'] === 'string' && own['db'] !== '') {
    db = own['db'];
  }
  let mode = 'hybrid';
  if (typeof own['mode'] === 'string') {
    mode = own['mode'];
  }
  return {
    enabled: true,
    db: path.resolve(root, db),
    mode,
    link: own['link'] !== false,
  };
}


/**
 * 只读会话上的客户号：先看记录上的 row.customer，再看地址里渠道写的 address.customer。不再自己推。
 * @param row 会话记录。
 * @returns 都没有是 ''。
 */
function graphCustomer(row: { customer?: string; address?: unknown }): string {
  if (typeof row.customer === 'string' && row.customer !== '') return row.customer;

  let where: Record<string, unknown> = {};
  if (typeof row.address === 'object' && row.address !== null && !Array.isArray(row.address)) {
    where = row.address as Record<string, unknown>;
  }
  if (typeof where['customer'] === 'string') return where['customer'];

  return '';
}


/**
 * 回答用到记忆时让模型附的链接提示：开场先搜带了引用，或这一轮 memory 工具查到了东西，才有。
 * @param request 这一步的请求（从 session.row 取机器人、客户号和消息）。
 * @returns 提示文字（链接带客户号、机器人、用户最后一句话）；没用到记忆或不是前台、干活的会话是 undefined。
 */
export function buildLinkHint(request: ChatRequest): string | undefined {
  const row = request.session.row;
  if (row.kind !== 'work' && row.kind !== 'front') return undefined;

  const messages = row.messages;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return undefined;

  const recalled = typeof row.recall === 'string' && row.recall.includes('可能相关的聊天记录和知识库');
  const searched = messages.slice(lastUser).some((m) => m.role === 'toolResult' && m.toolName === 'memory' && piAi.contentText(m.content).startsWith('找到 '));
  if (!recalled && !searched) return undefined;

  const asked = [...piAi.contentText(messages[lastUser]!.content).replace(/^【[^】]*】/u, '').trim()].slice(0, 120).join('');

  //M 链接里带上客户号（只读会话记录，不自己推）、机器人和用户最后一句话，关系图页面打开就能照这个查。
  const params = new URLSearchParams({ customer: graphCustomer(row), bot: row.bot, q: asked });
  return `# 关系图链接\n回答如果用到了上面的聊天记录、知识库引用，在回答最后另起一行原样写这个链接（不要改动、不要解释）：\n[🔗 查看本次记忆的关系图](/graph/?${params.toString()})`;
}


/** 将查询串数值夹在 [1, max] 区间内。 */
function clampNumber(value: string | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Number(value) || fallback));
}


/**
 * 关系图路由与对话链接提示器。
 */
export class GraphRoutes {
  private readonly store: GraphStore;
  private readonly sources: Sources;

  /**
   * @param ctx memory 插件 ctx（用于挂 session/request 提示）。
   * @param root 运行时根目录（Sources 定位磁盘文件用）。
   * @param memoryService 同插件构造好的 MemoryService。
   * @param settings `readGraphSettings` 校验后的配置。
   */
  constructor(
    ctx: cordis.Context,
    root: string,
    private readonly memoryService: MemoryGateway,
    private readonly settings: GraphSettings,
  ) {
    //M 只读打开 jmbots-memory 的 SQLite 库（GraphStore），关系图的数据都从它读。
    this.store = new GraphStore(settings.db);
    //M 命中带上出处（原文件完整路径 + Sheet 行 / 转换后行号），/memory/ 页面显示、可复制。
    this.sources = new Sources(root, (id) => String(((this.store.passage(id) as { passage?: { text?: unknown } }).passage?.text) ?? ''));
    //M 必须在 Memory 之后注册：先等 Memory.onRequest 把开场检索结果写进 row.recall，再用到了才附链接。
    if (settings.enabled && settings.link) {
      ctx.on('session/request', (request) => {
        //M 这一步用没用到记忆：用到了才有提示，加进系统提示词，让模型回答末尾附关系图链接。
        const hint = buildLinkHint(request);
        if (hint !== undefined) {
          request.system.push(hint);
        }
      });
    }
  }

  /**
   * 将 `/graph`、`/graph/` 和 `/api/memory-graph/*` 挂到 HTTP 服务上。
   * @param app Fastify 实例。
   */
  mountRoutes(app: FastifyApp): void {
    if (!this.settings.enabled) return;

    const getSpaces = (q: Record<string, string | undefined>) => {
      //M 查询串里的客户、机器人、要不要知识库，换成库里的“空间”列表：图和检索只在这些空间里取。
      return this.store.spaces(q['customer'] ?? '', q['bot'] || undefined, q['knowledge'] === '1');
    };

    app.get('/graph', (_request, reply) => reply.redirect('/graph/'));
    //M 页面是 web 打包出来的 graph.html（和 web 插件一样走 utils/Embedded.readAsset，编译版读内嵌的）。
    app.get('/graph/', async (_request, reply) => {
      const page = await embedded.readAsset('graph.html');
      if (page === undefined) return reply.code(404).type('text/plain; charset=utf-8').send('图谱页还没打包：在代码目录跑 bun run build:web');

      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(page);
    });

    //M /memory/ 页面看服务状态：记忆服务 /health + vgr /health，谁不通只在对应项写 error，不整体报错。
    app.get('/api/memory-graph/status', async () => {
      const [memoryHealth, vgrHealth] = await Promise.all([this.memoryService.health('memory'), this.memoryService.health('vgr')]);
      return { memory: memoryHealth, vgr: vgrHealth, mode: this.settings.mode };
    });

    //M 客户列表：库名、记忆服务地址、有图的客户和知识库（this.store.customers），给页面的下拉用。
    app.get('/api/memory-graph/customers', () => ({
      db: path.basename(this.settings.db),
      backend: this.memoryService.url(),
      list: this.store.customers(),
    }));

    //M 整张关系图：限制节点数（最多 1000）和展开深度（最多 3），可从 focus 那个实体展开。
    app.get<Query>('/api/memory-graph/graph', (request) => {
      const q = request.query;
      return this.store.graph(getSpaces(q), clampNumber(q['limit'], 150, 1000), q['focus'] || undefined, clampNumber(q['depth'], 1, 3));
    });

    app.get<Query>('/api/memory-graph/search', async (request, reply) => {
      const q = request.query;
      const text = (q['q'] ?? '').trim();
      if (text === '') return reply.code(400).send({ error: '要给 q' });

      const body: Record<string, unknown> = { query: text, scope: 'knowledge', limit: 8, mode: q['mode'] || this.settings.mode };
      //G 隔离：没选客户只搜公共知识库（记忆服务也拒绝不带客户号搜聊天记录）。
      if (q['customer']) {
        body['scope'] = 'all';
        body['customer'] = q['customer'];
      }
      if (q['bot']) {
        body['bot'] = q['bot'];
      }

      //M 把检索转给记忆服务（混合检索，可能慢）；它挂了或不通就回 502 并带原因。
      const started = Date.now();
      const response = await this.memoryService.search(body);
      if (!response.ok) return reply.code(502).send({ error: `记忆服务 ${String(response.status)}：${JSON.stringify(response.json ?? '')}` });

      const found = (response.json ?? {}) as {
        hits?: { relations?: string[] }[];
        relations?: string[];
        queryEntities?: string[];
        mode?: string;
        ms?: unknown;
        warnings?: string[];
      };
      let texts = found.relations ?? [];
      if (texts.length === 0) {
        texts = (found.hits ?? []).flatMap((hit) => hit.relations ?? []);
      }

      //M 命中子图要在这个客户、机器人加知识库的空间里取。
      const spaces = this.store.spaces(q['customer'] ?? '', q['bot'] || undefined, true);
      if ((found.warnings ?? []).some((line) => /connect|refused|Connection|连接|dns|timed out/iu.test(line))) {
        found.warnings = ['模型网关（Magpie）连不上，这次没用大模型抽实体/重排，只按向量和字面实体检索；开好 Magpie 再搜一次', ...(found.warnings ?? [])];
      }

      //M 每条命中补上原文出处（Sources.describe），再取命中的子图（hitGraph，可多带 extra 个相邻节点），一起交回给页面。
      const hits = (found.hits ?? []).map((hit) => ({ ...hit, ...this.sources.describe(hit as CitedHit) }));
      return { ...found, hits, total_ms: Date.now() - started, graph: this.store.hitGraph(spaces, texts, clampNumber(q['extra'], 24, 200)) };
    });


    //M 点图上的段落、实体、关系边时，按编号取详情（原文、相邻关系）。
    app.get<Id>('/api/memory-graph/passage/:id',(request) => this.store.passage(Number(request.params.id)));
    app.get<Id>('/api/memory-graph/entity/:id', (request) => this.store.entity(Number(request.params.id)));
    app.get<Id>('/api/memory-graph/edge/:id', (request) => this.store.edge(Number(request.params.id)));
  }
}
