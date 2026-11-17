/**
 * 插件和事件预览图。页面 /flow/ 由 web 插件按约定托管（dist/web/flow.html，源码 web/src/Flow/，和主网页一起由 web/Build.ts 打包）；本插件只登记接口。
 * 默认按插件聚合：CLI → 骨架（入口 main 和三服务）→ 各插件；点开一个插件才看它的事件。
 * 点和边都从运行时取（graphOf）：挂载结果（Main.ts 写在 resources.pluginStatus 上）、boot-trail 记的服务和工具、Cordis 上的监听、
 * 本插件从 internal/dispatch 认的“谁发了哪个事件”；Catalog.ts 只给分类和说明。本插件只读，不改行为。
 *   GET /api/flow/graph                总览图的点和边、各插件状态，加快照关键词、源码根目录（「在 VS Code 里打开」用）
 *   GET /api/plugins/status            挂载结果和 health 同款 problems
 *   GET /api/flow/requests?limit=      最近几条真实请求（收件表收下的消息）：消息号、机器人、渠道、用户那句话、步数、耗时、出没出错
 *   GET /api/flow/trail?message=&session=   一条请求的轨迹：按先后经过哪些插件、每步干什么、耗时、代码位置（Trail.ts）；只给 session 时取该会话最近一条
 *   GET /api/flow/detail?message=      一条请求的「变量 / 详情」：挑出的跟踪行（变量全量原样）、这场会话的对话.md（files-mirror 的）、用量
 *   GET /api/flow/boot                 这次启动的轨迹（boot-trail 插件记的）：和 trail 同一个格式，每步多带 docs（代码自己的注释）
 *   GET /api/flow/source?file=&line=   右栏“看实现”：这一行所在函数的完整源码、起止行号、里面调到的能找到定义的函数、谁调它（callers：每处调用和上方的 //M）（boot-trail 的 SourceDocs.sourceOf）
 *   POST /api/flow/probe {bot}        发一条固定的测试话（后面带快照关键词）给某个机器人（走 POST /api/message，和网页发消息同一条路），回消息号
 *   GET /api/flow/state                运行时变量“现在”：骨架三个服务和每个插件提供的服务对象全量读出，加插件登记的，按组原样给（utils/Snapshot.ts）
 *   GET /api/flow/snapshot?message=&step=   点中轨迹一步时那一刻的运行时变量，和上一步比变了哪些（message=0 是启动，boot-trail 每步拍的；请求轨迹是 State.ts 给带 snapshot_keyword 的消息每个事件拍的）
 * 快照还写成文件（Files.ts）：启动完（boot-trail/done）写 <运行时目录>/data/flow/boot.json，带关键词的消息停拍后写 <消息号>.json，消息文件只留最近 snapshot_files 个。
 * 提供服务 flow：别的插件用 ctx.flow.state(名字, 取值函数) 露自己的运行时变量；不走 bot/receive 的路用 ctx.flow.mark 认快照关键词。是可选依赖，接法见 FlowState。
 */
import type * as cordis from 'cordis';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pluginProblems, type PluginStatus } from '../../Resources.ts';
import type { SessionMeta } from '../../Sessions.ts';
import { CATALOG, QUIET_EVENTS, SKELETON, catalogOf, type CatalogPlugin } from './Catalog.ts';
import * as snapshotModule from '../../utils/Snapshot.ts';
import * as textModule from '../../utils/Text.ts';
import * as traceUtils from '../../utils/Trace.ts';
import { FlowFiles, stepShot, type BootTrailLike, type JournalLike, type Taken } from './Files.ts';
import { SHOTS_MAX, Shots } from './State.ts';
import { TRAIL_MAX_LINES, bootTrailOf, nodeOf, pick, stepsOf, trailOf, type Trail, type TrailLine } from './Trail.ts';


declare module 'cordis' {
  interface Context {
    /** flow 插件给别的插件露运行时变量的口子，实现在 src7/plugins/flow/index.ts 的 apply。可选依赖，用 ctx.inject(['flow'], …) 接。 */
    flow: FlowState;
  }
}


/**
 * ctx.flow：插件登记自己的运行时变量，/flow/ 右栏「运行时变量」每次刷新现调。
 * 接法（flow 没挂时什么都不发生）：
 *   void ctx.inject(['flow'], (sub) => { sub.effect(() => sub.flow.state('名字', () => 对象)); });
 */
export interface FlowState {
  /**
   * 登记一组。
   * @param name 组名，一般写插件名。
   * @param read 交回这一刻的状态；键用英文（代码里的名字），交给网页前过 utils/Snapshot.ts 的 walkState 全量读出（不打码）。
   * @param notes 键的中文解释：英文键 → 解释；网页在那一行后面灰字显示。
   * @returns 撤掉登记的函数：放进 ctx.effect，插件被拔掉时自动撤。
   */
  state(name: string, read: () => unknown, notes?: Record<string, string>): () => void;

  /**
   * 话交给一场已有会话之前（不走 bot/receive 的路，比如 web-api 接着某场会话发）认快照关键词。
   * 实现在 State.ts 的 Shots.mark，和 bot/receive 那处共用一个判断（Shots.strip）。
   * @param text 用户的话。
   * @param sessionId 交给哪一场。
   * @returns 去掉关键词的话（带了就记下这场会话要拍）；不带原样交回。
   */
  mark(text: string, sessionId: string): string;
}


/** 插件名。 */
export const name = 'flow';

/** 用到的服务。journal、bootTrail、usage、filesMirror 是可选的，用到时现取；运行时变量从 Cordis 的服务表里自动读，不用 inject。 */
export const inject = ['resources', 'sessions', 'http'];


/** 试跑按钮发的话：固定的测试文本，不碰任何人的真实对话。 */
export const PROBE_TEXT = '测试请求：请用一句话介绍你自己，再告诉我现在几点。';


type Query = { Querystring: Record<string, string | undefined> };


/**
 * 图上一个点的状态：ok 已挂且已开工，failed 没挂上，waiting 挂了但缺服务没开工，idle 配置里没挂。
 */
export type NodeState = 'ok' | 'failed' | 'waiting' | 'idle';


/** 总览图上的一个点。 */
export interface GraphNode {
  id: string;
  kind: 'cli' | 'skeleton' | 'plugin';
  category: string;
  summary: string;
  state: NodeState;
  error: string;
  missing: string[];
  configured: boolean;
  /** 要用的服务（挂载结果里的 inject）；配置里没挂的是空的。 */
  inject: string[];
  /** 这次运行它发过的事件（apply 里从 internal/dispatch 认的）。 */
  emits: string[];
  /** Cordis 上它现在登记着的监听。 */
  listens: string[];
  http: string;
  /** 挂上时多出的服务（boot-trail 记的；骨架就是自己）。 */
  provides: string[];
  /** 挂上时多登记的工具（boot-trail 记的）。 */
  tools: string[];
}


/** graphOf 要的运行时数据，apply 每次现取。 */
export interface GraphInput {
  /** 这次启动实际尝试挂过的插件（resources.pluginStatus）：挂没挂上、要用的服务。 */
  status: PluginStatus[];
  /** 配置里要挂的名字。 */
  configured: string[];
  /** boot-trail 记的每个插件多出的服务、工具；没挂 boot-trail 是 undefined，这时只有到骨架三服务的“要用”边。 */
  provided: { name: string; services: string[]; tools: string[] }[] | undefined;
  /** Cordis 上现在的监听：插件名 → 它听的事件（listensOf）。 */
  listens: Map<string, string[]>;
  /** 这次运行发过的事件 → 发它的点。还没发过的事件画不出“监听”边。 */
  emitters: Map<string, string>;
}


/** 总览图上的一条边。 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: 'inject' | 'listen';
  label: string;
}



/**
 * 拼总览图：点是骨架加 Catalog 和挂载结果里的插件，边全从运行时取（见 GraphInput）。
 * @param input 挂载结果、配置里的名字、boot-trail 记的服务和工具、Cordis 上的监听、谁发了哪个事件。
 */
export function graphOf(input: GraphInput): { nodes: GraphNode[]; edges: GraphEdge[]; problems: string[] } {
  const { status, emitters } = input;
  const tried = new Map(status.map((item) => [item.name, item]));
  const configuredSet = new Set(input.configured);
  const provided = new Map((input.provided ?? []).map((item) => [item.name, item]));
  const nodes: GraphNode[] = [];

  //M 某个点发过哪些事件：把 emitters 反过来查。
  const emitsOf = (id: string): string[] => {
    const out: string[] = [];
    for (const [event, source] of emitters) {
      if (source === id) out.push(event);
    }
    return out;
  };

  for (const item of SKELETON) {
    nodes.push({
      id: item.name,
      kind: 'skeleton',
      category: '骨架',
      summary: item.summary,
      state: 'ok',
      error: '',
      missing: [],
      configured: true,
      inject: [],
      emits: emitsOf(item.name),
      listens: [],
      http: '',
      provides: [item.name],
      tools: [],
    });
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of CATALOG) {
    names.push(item.name);
    seen.add(item.name);
    for (const alias of item.aliases ?? []) seen.add(alias);
  }
  for (const item of status) {
    if (!seen.has(item.name)) {
      names.push(item.name);
      seen.add(item.name);
    }
  }

  for (const name of names) {
    const info = catalogOf(name) ?? unknownPlugin(name);
    const id = info.name;
    if (nodes.some((node) => node.id === id)) continue;
    //M 挂载结果、boot-trail、Cordis 上记的名字可能是别名（wechat），连别名一起找。
    const aliases = [id, ...(info.aliases ?? [])];
    const row = aliases.map((alias) => tried.get(alias)).find((item) => item !== undefined);
    const mine = aliases.map((alias) => provided.get(alias)).find((item) => item !== undefined);
    const listens = [...new Set(aliases.flatMap((alias) => input.listens.get(alias) ?? []))];
    const inConfig = aliases.some((alias) => configuredSet.has(alias)) || row !== undefined;
    let state: NodeState = 'idle';
    let error = '';
    let missing: string[] = [];
    if (row !== undefined) {
      error = row.error;
      missing = row.missing;
      if (!row.mounted) state = 'failed';
      else if (!row.started) state = 'waiting';
      else state = 'ok';
    } else if (inConfig) {
      //G 配置里写了但 Main 没记下（不该发生），当没挂上。
      state = 'failed';
      error = '配置里写了，但这次启动没有挂载记录';
    }
    nodes.push({
      id,
      kind: id === 'cli' ? 'cli' : 'plugin',
      category: info.category,
      summary: info.summary,
      state,
      error,
      missing,
      configured: inConfig,
      inject: row?.inject ?? [],
      emits: emitsOf(id),
      listens,
      http: info.http,
      provides: mine?.services ?? [],
      tools: mine?.tools ?? [],
    });
  }

  //M 服务名 → 提供它的点：骨架三服务就是自己；插件的从 boot-trail 记的取（没挂 boot-trail 就只有骨架这几个）。
  const serviceNode = new Map<string, string>(SKELETON.map((item) => [item.name, item.name]));
  for (const item of input.provided ?? []) {
    const owner = catalogOf(item.name)?.name ?? item.name;
    for (const service of item.services) {
      serviceNode.set(service, owner);
    }
  }

  const known = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const add = (source: string, target: string, kind: GraphEdge['kind'], label: string) => {
    if (!known.has(source) || !known.has(target) || source === target) return;
    const key = `${kind}\0${source}\0${target}\0${label}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source, target, kind, label });
  };

  for (const node of nodes) {
    if (node.kind === 'skeleton') continue;
    for (const service of node.inject) {
      const target = serviceNode.get(service) ?? service;
      add(node.id, target, 'inject', service);
    }
    for (const event of node.listens) {
      if ((QUIET_EVENTS as readonly string[]).includes(event)) continue;
      const source = emitters.get(event);
      if (source === undefined) continue;
      add(source, node.id, 'listen', event);
    }
  }

  return { nodes, edges, problems: pluginProblems(status) };
}


/** 配置里有、Catalog 里没有的外来插件。 */
function unknownPlugin(name: string): CatalogPlugin {
  return {
    name,
    category: '其他',
    summary: '地图里还没有这条说明（可能是外部插件）。',
    http: '',
  };
}


/**
 * Cordis 上现在登记着的监听，按插件收：插件名（登记它的 fiber 的名字，和 journal 事件行的“听的人”同一种）→ 它听的事件。
 * @param ctx flow 的 ctx。
 */
function listensOf(ctx: cordis.Context): Map<string, string[]> {
  const out = new Map<string, string[]>();
  textModule.eachEntry(ctx.events._hooks, (event, hooks) => {
    for (const hook of hooks) {
      const plugin = hook.ctx.fiber.name;
      const list = out.get(plugin) ?? [];
      if (!list.includes(event)) list.push(event);
      out.set(plugin, list);
    }
  });
  return out;
}


/**
 * 找出源码根目录（「在 VS Code 里打开」拼路径用）：配置优先，否则从运行时目录往上找带 src7/Main.ts 的那一层。
 * @param configured 配置里写的路径，没写是空串。
 * @param start 开始往上找的目录（运行时目录）。
 * @returns 找不到是空串，页面就不显示那个按钮。
 */
function findWorkspace(configured: string, start: string): string {
  const has = (dir: string): boolean => fs.existsSync(path.join(dir, 'src7', 'Main.ts'));

  //M 配置里写了、确实是源码目录：用它。
  const trimmed = configured.trim();
  if (trimmed !== '' && has(trimmed)) return path.resolve(trimmed);

  //M 从运行时目录往上找几层。
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (has(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  //M 源码模式下当前目录就是源码目录。
  const cwd = path.resolve(process.cwd());
  if (has(cwd)) return cwd;

  //M 运行时目录常见在 aidata 下面某一层，源码在同级的 source/jmbots。不写死盘符。
  const candidates = [path.join(start, '..', '..', 'source', 'jmbots'), path.join(path.dirname(start), 'source', 'jmbots')];
  return candidates.map((candidate) => path.resolve(candidate)).find(has) ?? '';
}


/** flow 的配置：config.yaml plugins 段里它的 config。 */
export interface FlowConfig {
  /** 用户的话里带它才给这条消息拍运行时快照（拍完从话里去掉，模型看不到）。不写是 #调试，不能是空串。 */
  snapshot_keyword?: unknown;
  /** 运行时快照加起来最多占多少 MB（按 JSON 字节数估），超了从最旧的扔。不写是 200，要是正数。 */
  snapshot_max_mb?: unknown;
  /** data/flow/ 里消息快照文件留几个（boot.json 不算），多了删最旧的。不写是 20，要是正整数。 */
  snapshot_files?: unknown;
  /** 源码根目录，给「在 VS Code 里打开」拼路径用（原来 debug 插件的配置）。不写就从运行时目录往上找带 src7 的那一层，要是字符串。 */
  workspace?: unknown;
}

/** 用量服务 usage 这里用到的样子，不 import 它。 */
interface UsageLike {
  list(query: { sessions: string[]; from: number; to: number; limit: number }): { rows: unknown[]; truncated: boolean };
}

/** files-mirror 服务这里用到的样子，不 import 它。dirOf 只读 bot、id，所以 sessions.find 交回的 SessionMeta 就够。 */
interface FilesMirrorLike {
  dirOf(row: SessionMeta): string;
}

/** 不写 snapshot_keyword 时的关键词。 */
const DEFAULT_KEYWORD = '#调试';

/** 不写 snapshot_max_mb 时的上限，MB。 */
const DEFAULT_MAX_MB = 200;

/** 不写 snapshot_files 时留几个消息文件。 */
const DEFAULT_FILES = 20;


/**
 * 挂上接口。页面由 web 插件托管。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 FlowConfig；每一项都可以不写。
 * @throws snapshot_keyword 写了但不是非空字符串、snapshot_max_mb 写了但不是正数、snapshot_files 写了但不是正整数、workspace 写了但不是字符串时抛错。
 */
export function apply(ctx: cordis.Context, config: FlowConfig = {}): void {
  //M 配置是外面进来的，在这里校验一次。
  const keyword = config.snapshot_keyword ?? DEFAULT_KEYWORD;
  if (typeof keyword !== 'string' || keyword.trim() === '') throw new Error('flow 的 snapshot_keyword 要是非空字符串');
  const maxMb = config.snapshot_max_mb ?? DEFAULT_MAX_MB;
  if (typeof maxMb !== 'number' || !Number.isFinite(maxMb) || maxMb <= 0) throw new Error('flow 的 snapshot_max_mb 要是正数');
  const keep = config.snapshot_files ?? DEFAULT_FILES;
  if (typeof keep !== 'number' || !Number.isSafeInteger(keep) || keep <= 0) throw new Error('flow 的 snapshot_files 要是正整数');
  const configuredWorkspace = config.workspace ?? '';
  if (typeof configuredWorkspace !== 'string') throw new Error('flow 的 workspace 要是字符串');

  const app = ctx.http.app;
  const workspace = findWorkspace(configuredWorkspace, ctx.resources.root);

  //M 快照写成文件：带关键词的消息停拍后（Shots 交来），和启动走完（boot-trail 记完最后一步发 boot-trail/done）后。
  const files = new FlowFiles(ctx, keep);
  ctx.on('boot-trail/done', () => {
    files.boot();
  });

  //M 谁发了哪个事件（总览图“监听”边的起点）：每个事件头一回发时，从调用栈认出发它的那行代码，算到图上的点（Trail.ts 的 nodeOf）。
  //M   只认头一回，不每次取调用栈；同一个事件后来换了别的插件发，图上不多画那条边。
  const emitters = new Map<string, string>();
  ctx.on('internal/dispatch', (_mode, event) => {
    if (typeof event !== 'string' || event === 'trace' || event.startsWith('internal/')) return;
    if (emitters.has(event)) return;

    const site = traceUtils.callSite(['plugins/flow/']);
    if (site !== '位置不明') emitters.set(event, nodeOf(site));
  });

  //M 带关键词的消息，它的每个事件、每个跟踪点拍一份（State.ts），点中请求轨迹的一步时对回来。
  const shots = new Shots(ctx, keyword, maxMb * 1024 * 1024, files);

  //M 提供 ctx.flow：插件登记的取值函数放在这里，GET /api/flow/state 时现调；mark 给不走 bot/receive 的路认快照关键词。
  const registered = new Map<string, { read: () => unknown; notes: Record<string, string> }>();
  const flow: FlowState = {
    state: (name, read, notes = {}) => {
      registered.set(name, { read, notes });
      return () => {
        if (registered.get(name)?.read === read) registered.delete(name);
      };
    },
    mark: (text, sessionId) => shots.mark(text, sessionId),
  };
  ctx.provide('flow', flow);

  //M 页面不在这里登记：web 插件看到 config 里有 flow 且 dist/web/flow.html 在，就会把 /flow/ 托管上（和 /memory/ 一样）。再登记会和它抢路径，插件就挂不上。

  const statusOf = () => ({
    list: ctx.resources.pluginStatus,
    problems: pluginProblems(ctx.resources.pluginStatus),
  });

  app.get('/api/plugins/status', () => statusOf());

  app.get('/api/flow/graph', () => {
    const boot = ctx.get('bootTrail') as BootTrailLike | undefined;
    const graphInput: GraphInput = {
      status: ctx.resources.pluginStatus,
      configured: ctx.resources.config.plugins.map((entry) => entry.name),
      provided: boot?.provided?.(),
      listens: listensOf(ctx),
      emitters,
    };
    const graph = graphOf(graphInput);

    //M 网页从这里拿关键词（发测试请求的说明、没快照时的提示）和源码根目录（「在 VS Code 里打开」），网页不写死。
    return { ...graph, snapshotKeyword: keyword, workspace };
  });

  //M 一条请求的行（journal.request，web-api 的回话追溯也调它）交给 Trail.ts 挑和收。
  const trail = (journal: JournalLike, message: number): Trail | undefined => {
    const lines = journal.request(message, TRAIL_MAX_LINES);
    return lines === undefined ? undefined : trailOf(message, lines);
  };

  app.get<Query>('/api/flow/requests', (request, reply) => {
    const journal = ctx.get('journal') as JournalLike | undefined;
    if (journal === undefined) return reply.code(503).send({ error: '没挂 journal 插件，看不了请求轨迹' });

    const limit = textModule.numberOf(request.query['limit'], 12, 1, 30);
    const received = journal.query({ name: 'web-api/received', limit: String(limit) }).reverse();
    const list = received.flatMap((line) => {
      if (line.messageId === null) return [];
      const item = trail(journal, line.messageId);
      if (item === undefined) return [];
      //M 列表只给概要和用户那句话，每步的细节点开再取。
      const nodes = [...new Set(item.steps.map((step) => step.node))];
      return [{
        message: item.message,
        bot: item.bot,
        channel: item.channel,
        preview: item.preview,
        at: item.at,
        ms: item.ms,
        state: item.state,
        error: item.error,
        steps: item.steps.length,
        nodes,
      }];
    });
    return { list };
  });

  //M 一条请求的「变量 / 详情」（原来 debug 插件的）：挑出的跟踪行（变量全量原样），这场会话的对话.md，这段时间的用量。
  app.get<Query>('/api/flow/detail', (request, reply) => {
    const journal = ctx.get('journal') as JournalLike | undefined;
    if (journal === undefined) return reply.code(503).send({ error: '没挂 journal 插件，看不了请求详情' });

    const message = Number.parseInt(request.query['message'] ?? '', 10);
    if (!Number.isSafeInteger(message) || message <= 0) return reply.code(400).send({ error: '要给 message（消息号）' });

    const raw = journal.request(message, TRAIL_MAX_LINES);
    if (raw === undefined) return reply.code(404).send({ error: `跟踪行里没有消息 ${String(message)}（可能过期删了）` });

    const { picked, session } = pick(message, raw);
    const row = session === null ? undefined : ctx.sessions.find({ id: session })[0];

    //M 对话.md：files-mirror 写的那份，目录问它（dirOf）。没挂它、没有会话、还没写出来都是空串。
    const mirror = ctx.get('filesMirror') as FilesMirrorLike | undefined;
    const doc = row === undefined || mirror === undefined ? '' : path.join(mirror.dirOf(row), '对话.md');
    const conversation = doc !== '' && fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : '';

    //M 用量：这场会话从这条请求开始到最后一行；模型回完才记用量，终点往后放一分钟。
    const usage = ctx.get('usage') as UsageLike | undefined;
    let used: unknown[] = [];
    if (usage !== undefined && session !== null) {
      const from = picked[0]?.at ?? 0;
      const to = (picked.at(-1)?.at ?? from) + 60_000;
      used = usage.list({ sessions: [session], from, to, limit: 30 }).rows;
    }

    return { message, lines: picked, conversation, usage: used };
  });

  app.get<Query>('/api/flow/trail', (request, reply) => {
    const journal = ctx.get('journal') as JournalLike | undefined;
    if (journal === undefined) return reply.code(503).send({ error: '没挂 journal 插件，看不了请求轨迹' });
    let message = Number.parseInt(request.query['message'] ?? '', 10);
    const session = request.query['session'] ?? '';
    if ((!Number.isSafeInteger(message) || message <= 0) && session !== '') {
      //M 只给了会话：取这个会话最近一条收下的消息。query 默认新的在前。
      const latest = journal.query({ name: 'web-api/received', session, limit: '1' })[0];
      if (latest?.messageId !== null && latest?.messageId !== undefined) message = latest.messageId;
      else return reply.code(404).send({ error: '这个会话没有跟踪到的请求' });
    }
    if (!Number.isSafeInteger(message) || message <= 0) return reply.code(400).send({ error: '要给 message（消息号）或 session' });
    const item = trail(journal, message);
    if (item === undefined) return reply.code(404).send({ error: `跟踪行里没有消息 ${String(message)}（可能过期删了）` });
    return item;
  });

  //M 这次启动的轨迹：boot-trail 记的行，收成和请求轨迹一样的格式。
  app.get('/api/flow/boot', async (_request, reply) => {
    const boot = ctx.get('bootTrail') as BootTrailLike | undefined;
    if (boot === undefined) return reply.code(503).send({ error: '没挂 boot-trail 插件：把它写在 config.yaml plugins 段的第一个' });

    return bootTrailOf(await boot.lines(), boot.notes);
  });

  //M 右栏“看实现”：一个函数的完整源码，点开时才要（不塞进 /api/flow/boot）。源码由 boot-trail 读（编译版里是嵌进程序的那份）。
  app.get<Query>('/api/flow/source', async (request, reply) => {
    const boot = ctx.get('bootTrail') as BootTrailLike | undefined;
    if (boot?.source === undefined) return reply.code(503).send({ error: '没挂 boot-trail 插件（或版本太旧），取不到源码' });

    //G 外面进来的文件名：请求轨迹的位置可能带着前面的目录，从最后一个 src7/ 截起；只认 src7/ 下的 .ts，不许 ..。
    const raw = (request.query['file'] ?? '').replaceAll('\\', '/');
    const file = raw.slice(Math.max(raw.lastIndexOf('src7/'), 0));
    const line = Number.parseInt(request.query['line'] ?? '', 10);
    if (!/^src7\/[\w\-./]+\.ts$/u.test(file) || file.includes('..') || !Number.isSafeInteger(line) || line < 1) {
      return reply.code(400).send({ error: '要给 file（src7/ 下的 .ts）和 line（第几行，从 1 起）' });
    }

    const source = await boot.source.sourceOf(file, line);
    if (source === undefined) return reply.code(404).send({ error: `读不到 ${file} 第 ${String(line)} 行` });

    return source;
  });

  //M 运行时变量“现在”：自动读的各组，再加插件自己登记的，一样全量原样给。
  app.get('/api/flow/state', () => {
    const groups = snapshotModule.snapshotOf(ctx);
    for (const [name, item] of registered) {
      groups.push(snapshotModule.group(name, `插件 ${name} 自己露的运行时变量`, item.read, [], item.notes));
    }
    return { at: Date.now(), groups };
  });

  //M 点中一步时的运行时变量：这一步最后一行拍的那份，和上一步最后一行拍的那份比（Files.ts 的 stepShot，写文件也用它）。
  app.get<Query>('/api/flow/snapshot', async (request, reply) => {
    const message = Number.parseInt(request.query['message'] ?? '', 10);
    const no = Number.parseInt(request.query['step'] ?? '', 10);
    if (!Number.isSafeInteger(message) || message < 0 || !Number.isSafeInteger(no) || no < 1) {
      return reply.code(400).send({ error: '要给 message（消息号，0 是启动）和 step（第几步，从 1 起）' });
    }

    //M 行和每行的快照：启动问 boot-trail；请求轨迹从 journal 取行，在 State.ts 里对。
    let lines: TrailLine[];
    let taken: (Taken | undefined)[];
    if (message === 0) {
      const boot = ctx.get('bootTrail') as BootTrailLike | undefined;
      if (boot?.snapshot === undefined) return reply.code(503).send({ error: '没挂 boot-trail 插件（或版本太旧），没有启动时的快照' });

      lines = await boot.lines();
      taken = lines.map((line) => boot.snapshot?.(line.id));
    } else {
      const journal = ctx.get('journal') as JournalLike | undefined;
      if (journal === undefined) return reply.code(503).send({ error: '没挂 journal 插件，对不上请求轨迹' });

      const raw = journal.request(message, TRAIL_MAX_LINES);
      if (raw === undefined) return reply.code(404).send({ error: `跟踪行里没有消息 ${String(message)}` });

      lines = pick(message, raw).picked;
      taken = shots.match(lines);
    }

    const steps = stepsOf(lines).steps;
    if (steps[no - 1] === undefined) return reply.code(404).send({ error: `没有第 ${String(no)} 步` });

    const shot = stepShot(steps, taken, no);
    if (shot === undefined) {
      const why = `这条消息没带 ${keyword}，没拍快照（带了的话，也可能是被挤掉了：运行时只留最近 ${String(SHOTS_MAX)} 份）`;
      return reply.code(404).send({ error: `第 ${String(no)} 步没有快照：${why}` });
    }

    return shot;
  });

  //M 试跑：用 Fastify 自己的 inject 走 POST /api/message（web-api 的收话接口），等于网页上发了一句；不 import web-api。
  //M   话后面带上快照关键词：试跑的这条每一步都拍快照，关键词在 bot/receive 时被去掉，模型看不到。
  app.post<{ Body: unknown }>('/api/flow/probe', async (request, reply) => {
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as { bot?: unknown };
    const text = `${PROBE_TEXT} ${keyword}`;
    const payload: Record<string, unknown> = { text, from: 'flow-probe' };
    if (typeof body.bot === 'string' && body.bot !== '') payload['bot'] = body.bot;
    const sent = await app.inject({ method: 'POST', url: '/api/message', payload, remoteAddress: '127.0.0.1' });
    const result = sent.json() as { id?: number; error?: string };
    if (sent.statusCode >= 400 || typeof result.id !== 'number') return reply.code(sent.statusCode >= 400 ? sent.statusCode : 502).send({ error: result.error ?? '发不出去' });
    return { message: result.id, text };
  });
}
