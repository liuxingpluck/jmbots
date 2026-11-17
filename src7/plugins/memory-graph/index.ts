/**
 * 记忆关系图：独立页面 /graph/（React + cytoscape，源码 web/src/Graph/，入口 web/graph.html，和主网页一起由 web/Build.ts 打包成 dist/web/graph.html；
 *   不改聊天页），看一个客户的整张关系网、一次检索命中的路径。
 *   旧版是 Page.ts 里手写 canvas 的 HTML 字符串，用户要求自己实现的页面一律用 React，2026-11-14 换掉（备份 cache/src7备份/*-图谱React/）。
 * 数据：jmbots-memory 的库（只读，Graph.ts）+ 检索走 ctx.memory.search（记忆服务 POST /search，命中的关系原句 → 高亮边）。
 * 聊天里只多一行链接：回答用到了记忆时，提示模型在末尾原样附 [查看关系图](/graph/?customer=…&q=…)，网页的 Markdown 本来就新标签页打开链接。
 *   GET /graph/                                  页面（?customer=&bot=&q=&mode=）
 *   GET /api/memory-graph/customers              有图的客户、知识库
 *   GET /api/memory-graph/status                 记忆服务、vgr 的健康和计数（/memory/ 页面用，2026-11-14）
 *   GET /api/memory-graph/graph?customer=&bot=&knowledge=1&limit=&focus=&depth=
 *   GET /api/memory-graph/search?q=&customer=&bot=&mode=hybrid|graph&knowledge=1
 *   GET /api/memory-graph/passage/:id、/entity/:id、/edge/:id
 * 配置（都可不写）：db（库文件，相对数据目录，默认 data/memory/memory.db）、mode（默认 hybrid）、link（默认 true）。
 *   2026-11-17 jm开发：记忆服务、vgr 的地址、探活、检索都问 ctx.memory（url / health / search），不再自己拼地址、写死 30086；backend_url、vgr_url 两项不再读。
 */
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Chat.ts';
import * as embedded from '../../utils/Embedded.ts';
import { GraphStore } from './Graph.ts';
import { Sources, type CitedHit } from './Sources.ts';


export const name = 'memory-graph';

export const inject = ['resources', 'http', 'memory'];


interface Settings { db: string; mode: string; link: boolean }

type Query = { Querystring: Record<string, string | undefined> };
type Id = { Params: { id: string } };


/** 读配置。 */
function settingsOf(ctx: cordis.Context, config: unknown): Settings {
  const own = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
  const db = typeof own['db'] === 'string' && own['db'] !== '' ? own['db'] : 'data/memory/memory.db';
  return {
    db: path.resolve(ctx.resources.root, db),
    mode: typeof own['mode'] === 'string' ? own['mode'] : 'hybrid',
    link: own['link'] !== false,
  };
}


/**
 * 只读会话上的客户号：先看记录上的 row.customer，再看地址里渠道写的 address.customer。不再自己推。
 * @param row 会话记录。
 * @returns 都没有是 ''。
 */
function customerOf(row: { customer?: string; address?: unknown }): string {
  if (typeof row.customer === 'string' && row.customer !== '') return row.customer;
  const where = (typeof row.address === 'object' && row.address !== null && !Array.isArray(row.address) ? row.address : {}) as Record<string, unknown>;
  return typeof where['customer'] === 'string' ? where['customer'] : '';
}


/** 回答用到记忆时让模型附的链接。 */
function linkHint(request: ChatRequest): string | undefined {
  const row = request.session.row;
  if (row.kind !== 'work' && row.kind !== 'front') return undefined;
  const messages = row.messages;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') { lastUser = i; break; }
  if (lastUser < 0) return undefined;
  const recalled = typeof row.recall === 'string' && row.recall.includes('可能相关的聊天记录和知识库');
  const searched = messages.slice(lastUser).some((m) => m.role === 'toolResult' && m.toolName === 'memory' && piAi.contentText(m.content).startsWith('找到 '));
  if (!recalled && !searched) return undefined;
  const asked = [...piAi.contentText(messages[lastUser]!.content).replace(/^【[^】]*】/u, '').trim()].slice(0, 120).join('');
  const params = new URLSearchParams({ customer: customerOf(row), bot: row.bot, q: asked });
  return `# 关系图链接\n回答如果用到了上面的聊天记录、知识库引用，在回答最后另起一行原样写这个链接（不要改动、不要解释）：\n[🔗 查看本次记忆的关系图](/graph/?${params.toString()})`;
}


export function apply(ctx: cordis.Context, config: unknown): void {
  const settings = settingsOf(ctx, config);
  const store = new GraphStore(settings.db);
  //M 2026-11-14 23:15 EST：命中带上出处（原文件完整路径 + Sheet 行 / 转换后行号），/memory/ 页面显示、可复制。
  const sources = new Sources(ctx.resources.root, (id) => String(((store.passage(id) as { passage?: { text?: unknown } }).passage?.text) ?? ''));
  const app = ctx.http.app;
  const num = (value: string | undefined, fallback: number, max: number) => Math.min(max, Math.max(1, Number(value) || fallback));
  const spacesOf = (q: Record<string, string | undefined>) => store.spaces(q['customer'] ?? '', q['bot'] || undefined, q['knowledge'] === '1');

  app.get('/graph', (_request, reply) => reply.redirect('/graph/'));
  //M 页面是 web 打包出来的 graph.html（和 web 插件一样走 utils/Embedded.readAsset，编译版读内嵌的）。
  app.get('/graph/', async (_request, reply) => {
    const page = await embedded.readAsset('graph.html');
    if (page === undefined) return reply.code(404).type('text/plain; charset=utf-8').send('图谱页还没打包：在代码目录跑 bun run build:web');
    return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(page);
  });

  //M 2026-11-14 jm开发：/memory/ 页面（web/memory.html，web 插件托管）看服务状态：记忆服务 /health（段数、嵌入、抽取进度）+ vgr /health。
  //M   两个服务谁不通就在对应一项里写 error，不整体报错，页面照样能显示另一个。2026-11-17：探活改问 ctx.memory.health。
  app.get('/api/memory-graph/status', async () => {
    const [memory, vgr] = await Promise.all([ctx.memory.health('memory'), ctx.memory.health('vgr')]);
    return { memory, vgr, mode: settings.mode };
  });

  app.get('/api/memory-graph/customers', () => ({ db: path.basename(settings.db), backend: ctx.memory.url(), list: store.customers() }));

  app.get<Query>('/api/memory-graph/graph', (request) => {
    const q = request.query;
    return store.graph(spacesOf(q), num(q['limit'], 150, 1000), q['focus'] || undefined, num(q['depth'], 1, 3));
  });

  app.get<Query>('/api/memory-graph/search', async (request, reply) => {
    const q = request.query;
    const text = (q['q'] ?? '').trim();
    if (text === '') return reply.code(400).send({ error: '要给 q' });
    const body: Record<string, unknown> = { query: text, scope: 'all', limit: 8, mode: q['mode'] || settings.mode };
    if (q['customer']) body['customer'] = q['customer'];
    //G 隔离：没选客户只搜公共知识库（记忆服务也拒绝不带客户号搜聊天记录）。
    else body['scope'] = 'knowledge';
    if (q['bot']) body['bot'] = q['bot'];
    const started = Date.now();
    //M 2026-11-17：检索改问 ctx.memory.search（不自己 fetch）；服务回错或没开都交 502 带状态码和回话。
    const response = await ctx.memory.search(body);
    if (!response.ok) return reply.code(502).send({ error: `记忆服务 ${String(response.status)}：${JSON.stringify(response.json ?? '')}` });
    const found = (response.json ?? {}) as { hits?: { relations?: string[] }[]; relations?: string[]; queryEntities?: string[]; mode?: string; ms?: unknown; warnings?: string[] };
    const picked = found.relations ?? [];
    const texts = picked.length > 0 ? picked : (found.hits ?? []).flatMap((hit) => hit.relations ?? []);
    const spaces = store.spaces(q['customer'] ?? '', q['bot'] || undefined, true);
    //M 2026-11-14 23:10 EST：大模型调用连不上（多半是 Magpie 模型网关没开）时，在提示最前面说清楚，检索照样用向量和字面实体出结果。
    if ((found.warnings ?? []).some((line) => /connect|refused|Connection|连接|dns|timed out/iu.test(line))) {
      found.warnings = ['模型网关（Magpie）连不上，这次没用大模型抽实体/重排，只按向量和字面实体检索；开好 Magpie 再搜一次', ...(found.warnings ?? [])];
    }
    const hits = (found.hits ?? []).map((hit) => ({ ...hit, ...sources.describe(hit as CitedHit) }));
    return { ...found, hits, total_ms: Date.now() - started, graph: store.hitGraph(spaces, texts, num(q['extra'], 24, 200)) };
  });

  app.get<Id>('/api/memory-graph/passage/:id', (request) => store.passage(Number(request.params.id)));
  app.get<Id>('/api/memory-graph/entity/:id', (request) => store.entity(Number(request.params.id)));
  app.get<Id>('/api/memory-graph/edge/:id', (request) => store.edge(Number(request.params.id)));

  //M 听 session/request：memory 插件已把引用拼进 system（插件顺序在它后面），用到了就加一句附链接的要求。
  if (settings.link) {
    ctx.on('session/request', (request) => {
      const hint = linkHint(request);
      if (hint !== undefined) request.system.push(hint);
    });
  }
}
