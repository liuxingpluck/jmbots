/** 统一检索与原文读取。网页、内部事件和模型共用检索，模型的范围由会话来源决定。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import type { Session } from '../../Sessions.ts';
import type { ToolResult } from '../../Tools.ts';
import * as text from '../../utils/Text.ts';
import * as workspace from '../../utils/Workspace.ts';
import * as channel from './ChannelIndex.ts';
import type { GraphRoutes } from './GraphRoutes.ts';
import type { GraphStore } from './GraphStore.ts';
import type { HistoryToolRequest } from './HistoryTools.ts';
import type { MemoryService } from './index.ts';
import * as recall from './Recall.ts';
import * as store from './Store.ts';

const SOURCES = ['history', 'channel', 'knowledge', 'card'] as const;
const MODES = ['keyword', 'semantic', 'hybrid', 'graph'] as const;
const SEARCH_LIMIT = 50;
const HISTORY_CALLS = 3;
const SEARCH_ROUTE = '/api/memory/search';
const PASSAGE_ROUTE = '/api/memory-graph/passage/';
const CHANNEL_ROUTE = '/api/memory/channel';

type Source = (typeof SOURCES)[number];
type Mode = (typeof MODES)[number];

/** 检索项。ref 是原文定位，模型拿到 ref 后仍需按本轮授权重新读。 */
export interface SearchHit {
  /** 哪一路命中。 */
  source: Source;
  /** 该来源内的稳定编号。 */
  id: string;
  /** 片段标题。 */
  title: string;
  /** 命中片段。 */
  snippet: string;
  /** 跨来源按 RRF 折算到 0–1 的分数。 */
  score: number;
  /** 毫秒时间戳。 */
  at: number;
  /** 原文位置。 */
  ref: string;
  /** 命中通路。 */
  via: string[];
  /** 客户号。 */
  customer: string;
  /** 关联机器人。 */
  bot: string;
  /** 原文件位置，供网页跳转。 */
  file?: string;
  /** 文件行号等出处说明。 */
  where?: string;
  /** 原文件不可直接打开时的可读出处。 */
  origin?: string;
  /** Rust 的段落起点。 */
  start?: number;
  /** Rust 的段落终点。 */
  end?: number;
  /** 原段落上命中的关系。 */
  relations?: string[];
}

/** Rust 返回的段落和证据。 */
interface Passage {
  id: number;
  scope: 'history' | 'knowledge';
  source: string;
  title: string;
  customer: string;
  bot: string;
  session: string;
  at: number;
  start: number;
  end: number;
}

interface Lane {
  hits: SearchHit[];
  relations?: string[];
  queryEntities?: string[];
  warnings?: string[];
}

/** 统一检索的回执，unavailable 用于显示未能响应的来源。 */
export interface SearchResult extends Lane {
  /** 本次实际使用的模式。 */
  mode: Mode;
  /** 查询失败或未启用的来源。 */
  unavailable: Source[];
  /** 策略或查询范围排除的来源。 */
  skipped: Source[];
  /** 整次查询的毫秒耗时。 */
  total_ms: number;
}

interface SearchQuery {
  q: string;
  sources: Source[];
  mode: Mode;
  bot: string;
  customer: string;
  session: string;
  notSession: string;
  channel: channel.ChannelQuery;
  limit: number;
  skipped: Source[];
}

const TIME_FILTER = piAi.Type.Union([piAi.Type.String(), piAi.Type.Integer()], { description: '日期或毫秒数' });
const PAGE_CURSOR = piAi.Type.String({ description: '上一页返回的 nextCursor' });
const FILTERS = {
  channel: piAi.Type.Optional(piAi.Type.String()),
  chat: piAi.Type.Optional(piAi.Type.String()),
  since: piAi.Type.Optional(TIME_FILTER),
  until: piAi.Type.Optional(TIME_FILTER),
  limit: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1 })),
};

/** 统一检索的参数、权限和入口。Memory 插件在挂载时构造一次。 */
export class Search {
  private readonly quota = new WeakMap<Session, { turn: unknown; calls: number }>();

  constructor(
    private readonly ctx: cordis.Context,
    private readonly service: MemoryService,
    private readonly index?: channel.ChannelIndex,
    private readonly graphStore?: GraphStore,
    private readonly disk?: store.Store,
  ) {}

  /** HTTP、工具和可信内部事件共用的查询。会话缺省时按已验证的网页或内部调用者范围查。 */
  async find(
    args: Record<string, unknown>,
    session?: Session,
    options: { cardRoots?: string[]; notSession?: string } = {},
  ): Promise<SearchResult> {
    const started = Date.now();
    //G 参数和授权在这一步定好，下面各来源只用核准后的范围。
    const query = this.getQuery(args, session);
    query.notSession = options.notSession ?? '';
    //M 独立查每一路，某个来源失败也能交回其余命中。
    const jobs = query.sources.map((source) => this.findSource(source, query, options.cardRoots ?? []));
    const lanes = await Promise.allSettled(jobs);
    const unavailable: Source[] = [];
    const hits: SearchHit[] = [];
    const relations = new Set<string>();
    const queryEntities = new Set<string>();
    const warnings = new Set<string>();
    for (const [i, lane] of lanes.entries()) {
      if (lane.status === 'rejected') {
        unavailable.push(query.sources[i]!);
        //M 原因（如“记忆服务没在线”）放进 warnings：记忆页的“提示”和模型都看得到，不只剩一个来源名。
        warnings.add(text.getMessage(lane.reason));
        continue;
      }
      for (const [rank, hit] of lane.value.hits.entries()) {
        //M 四路没有同一标尺，按每路内的排名折算，首条归一化为 1。
        hits.push({ ...hit, score: 60 / (60 + rank) });
      }
      for (const relation of lane.value.relations ?? []) relations.add(relation);
      for (const entity of lane.value.queryEntities ?? []) queryEntities.add(entity);
      for (const warning of lane.value.warnings ?? []) warnings.add(warning);
    }
    //M 排名相同时把更新的记录放前面，最后才截总条数。
    hits.sort((left, right) => right.score - left.score || right.at - left.at);
    return {
      hits: hits.slice(0, query.limit), mode: query.mode, unavailable, skipped: query.skipped,
      relations: [...relations], queryEntities: [...queryEntities], warnings: [...warnings],
      total_ms: Date.now() - started,
    };
  }

  /** 挂统一检索接口，和模型共用同一份来源与排序。 */
  mount(app: cordis.Context['http']['app'], graph: Pick<GraphRoutes, 'decorateSearch'>): void {
    //M 兼容的 web 令牌检查由 Fastify 主应用继续统一处理。
    app.get<{ Querystring: Record<string, unknown> }>(SEARCH_ROUTE, async (request, reply) => {
      try {
        const result = await this.find(request.query);
        return graph.decorateSearch(result, request.query);
      } catch (error) {
        return reply.code(400).send({ error: text.getMessage(error) });
      }
    });
  }

  /** 登记两件模型工具。 */
  registerTools(): void {
    //M 按问题找线索，交回带 ref 的摘要，全文由下一件工具取。
    this.ctx.tools.register({
      definition: {
        name: 'memory_search',
        description: '按问题搜往来、渠道、知识库和卡片。front 查这场的归档，mentions 查 @。要看原文用 memory_get。',
        parameters: piAi.Type.Object({
          q: piAi.Type.Optional(piAi.Type.String({ description: '检索词，翻看归档或 @ 时可省' })),
          sources: piAi.Type.Optional(piAi.Type.String({ description: '逗号分隔 history,channel,knowledge,card，默认全部' })),
          mode: piAi.Type.Optional(piAi.Type.Union(MODES.map((mode) => piAi.Type.Literal(mode)))),
          customer: piAi.Type.Optional(piAi.Type.String({ description: '当前客户号' })),
          bot: piAi.Type.Optional(piAi.Type.String({ description: '当前机器人' })),
          session: piAi.Type.Optional(piAi.Type.String({ description: '限定会话号' })),
          range: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('customer'), piAi.Type.Literal('session')])),
          mentions: piAi.Type.Optional(piAi.Type.Boolean({ description: '只查提到当前机器人的渠道消息' })),
          front: piAi.Type.Optional(piAi.Type.Boolean({ description: '查这场前台及它交办的往来归档' })),
          who: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('user'), piAi.Type.Literal('bot')])),
          after: piAi.Type.Optional(piAi.Type.Integer({ description: '前台往来编号，向后翻页' })),
          before: piAi.Type.Optional(piAi.Type.Union([PAGE_CURSOR, piAi.Type.Integer({ description: '前台往来编号' })])),
          from_earliest: piAi.Type.Optional(piAi.Type.Boolean({ description: '从最早一条往后翻' })),
          ...FILTERS,
        }),
      },
      kinds: ['front', 'work'],
      run: async (args, session, signal, callId) => {
        //G 前台先扣本轮额度，再按来源和权限检索。
        this.takeTurn(session);
        const request = { args, session, signal, callId };
        const archived = await this.searchArchive(request);
        if (archived !== undefined) return archived;

        //M 常规检索返回跨来源的结构化命中。
        const result = await this.find(args, session);
        return JSON.stringify(result);
      },
    });

    //M 用引用定位一段原文，或按聊天和时间取连续消息。
    this.ctx.tools.register({
      definition: {
        name: 'memory_get',
        description: '用 ref 取原文和上下文。省略 ref 翻渠道历史，可用 before 游标。微信用 wechat_skip 跳过最近消息。',
        parameters: piAi.Type.Object({
          ref: piAi.Type.Optional(piAi.Type.String({ description: '来源引用或 bot-log:往来编号' })),
          before: piAi.Type.Optional(PAGE_CURSOR),
          senderId: piAi.Type.Optional(piAi.Type.String({ description: '只看这位发言人的历史' })),
          wechat_skip: piAi.Type.Optional(piAi.Type.Integer({ minimum: 0 })),
          ...FILTERS,
        }),
      },
      kinds: ['front', 'work'],
      run: async (args, session, signal, callId) => {
        //G 两个新工具和旧前台分页共用同一份本轮额度。
        this.takeTurn(session);
        const request = { args, session, signal, callId };
        const archived = await this.getArchive(request);
        if (archived !== undefined) return archived;

        //M 索引引用和按时间截取的渠道消息走统一原文查找。
        const result = await this.get(args, session);
        return JSON.stringify(result);
      },
    });
  }

  /** 新工具和旧名均经这里读取原插件的归档，不改变提供方的安全范围或游标。 */
  async readHistory(request: HistoryToolRequest, compatibility = false): Promise<ToolResult | undefined> {
    const { route, session } = request;
    if (!compatibility && (route.startsWith('front-') || route === 'wechat-archive')) {
      //G 新工具放进只读名单后，只允许本人使用私人前台及微信归档。受限说话人查的是当前渠道记录。
      const access = channel.getAccess(session);
      if (!canReadPrivate(session, access) || (route.startsWith('front-') && session.row.kind !== 'front')) {
        throw new Error('这一轮只能查当前渠道聊天');
      }
    }
    if (compatibility && (route === 'front-search' || route === 'front-get')) {
      //G 旧前台分页和取全文也使用新工具的同一份额度，兼容名保留原提示和文本返回。
      try {
        this.takeTurn(session);
      } catch {
        return '本轮 history_search / history_get 已调用 3 次，不能再查。若需要通读或总结大量历史，请用 hand_session 交给后台会话。';
      }
    }
    //M 由拥有归档、签名游标和原权限检查的插件答复。
    await this.ctx.serial('memory/history-tool', request);
    return request.result;
  }

  /** 前台往来和不带关键词的 @ 归档按原来源分页。 */
  private async searchArchive(request: Omit<HistoryToolRequest, 'route'>): Promise<ToolResult | undefined> {
    const { args } = request;
    if (args['front'] === true) {
      //M 通用时间和条数参数换成前台归档的游标条件。
      const query = channel.getQuery(args, {});
      const params = {
        keyword: args['q'], count: args['limit'], from: query.since, to: query.until, who: args['who'],
        before: args['before'], after: args['after'], from_earliest: args['from_earliest'], use_memory_ref: true,
      };
      const routed = { ...request, route: 'front-search' as const, args: params };
      //M 前台插件负责旧记录的编号、翻页和发言人筛选。
      return this.readHistory(routed);
    }

    //M 无检索词时按渠道原始 @ 记录翻页，包括还没有收进索引的记录。
    const q = getText(args, 'q');
    if (args['mentions'] !== true || q !== '') return undefined;

    if (args['channel'] !== undefined || args['chat'] !== undefined) throw new Error('只可翻看当前聊天的 @ 记录');

    //M 原渠道使用结构化提及和它签发的游标翻页。
    const routed = { ...request, route: 'channel-mentions' as const };
    return this.readHistory(routed);
  }

  /** 用前台编号取往来，或从原渠道读连续页、微信归档。 */
  private async getArchive(request: Omit<HistoryToolRequest, 'route'>): Promise<ToolResult | undefined> {
    const { args } = request;
    //M 统一识别旧往来编号和索引引用，后者继续由 get 处理。
    const ref = getText(args, 'ref');
    const entry = /^(?:bot-log:|#)([1-9]\d*)$/u.exec(ref);
    if (entry !== null) {
      const id = Number(entry[1]);
      const routed = { ...request, route: 'front-get' as const, args: { id } };
      return this.readHistory(routed);
    }
    if (ref !== '') return undefined;

    if (args['wechat_skip'] !== undefined) {
      //M 微信按当前来源的会话和归档偏移读取，原有补录和排序由微信插件处理。
      const params = { skip: args['wechat_skip'], limit: args['limit'] };
      const routed = { ...request, route: 'wechat-archive' as const, args: params };
      return this.readHistory(routed);
    }
    if (args['since'] !== undefined || args['until'] !== undefined) return undefined;

    if (args['senderId'] !== undefined) {
      if (args['channel'] !== undefined) throw new Error('按发言人翻页只能查当前渠道');

      //M 原渠道模式按发送者权限和游标翻页，参数 chat 换成原模式的 chatId。
      const params = { ...args, chatId: args['chat'] };
      const routed = { ...request, route: 'channel-visible' as const, args: params };
      return this.readHistory(routed);
    }
    //M 默认走当前渠道读取，拥有者的跨聊天权限由该渠道按来源检查。
    const routed = { ...request, route: 'channel-current' as const };
    return this.readHistory(routed);
  }

  /** 旧 channel_search 的兼容入口，无关键词时仍能按时间列消息。 */
  findChannel(args: Record<string, unknown>, session: Session): {
    rows: channel.ChannelRow[]; query: channel.ChannelQuery;
  } {
    //M 旧工具沿用原日期和条数参数，按统一索引范围查询。
    const access = channel.getAccess(session);
    const scope = channel.getScope(args, access);
    const query = channel.getQuery(args, scope);
    const rows = this.searchChannel(query);
    return { rows, query };
  }

  /** 按 ref 读取原文。在查询数据前把聊天范围固定为本轮获准的范围。 */
  async get(args: Record<string, unknown>, session: Session): Promise<unknown> {
    //G 先确定引用类型和说话人的来源范围。
    const ref = getText(args, 'ref');
    const access = channel.getAccess(session);
    //M 渠道原文按稳定消息键定位，或按聊天和时间列一段完整消息。
    if (ref === '' || ref.startsWith(`${CHANNEL_ROUTE}?`)) {
      const params = new URLSearchParams(ref.slice(CHANNEL_ROUTE.length + 1));
      const chosen = { ...args };
      for (const key of ['channel', 'chat'] as const) {
        const value = params.get(key);
        if (value !== null) chosen[key] = value;
      }
      //G 引用可以定位聊天，但只能读取当前用户获准的范围。
      const scope = channel.getScope(chosen, access);
      if (scope.chat === undefined) throw new Error('请给 ref 或 chat');

      //G 有引用时必须明确给消息键；纯聊天查询才允许列最近消息。
      const id = params.get('id');
      if (id === null && ref !== '') throw new Error('引用缺少消息编号');

      //M 同一套时间、条数和聊天范围用于列表及锚点的前后文。
      if (id !== null) chosen['limit'] = getLimit(args['limit'], 3, 20);
      const query = channel.getQuery(chosen, scope);
      const index = this.index;
      if (index === undefined) throw new Error('渠道消息索引未开启');

      //M 没有锚点时直接返回这段时间内的消息。
      if (id === null) return { hits: index.search(query) };

      //M 有锚点时取这条原文和附近的消息。
      return index.context(id, query);
    }

    //G 渠道外人和群聊只允许通过上面的聊天范围取渠道原文。
    if (!canReadPrivate(session, access)) throw new Error('这一轮只能查当前聊天的消息');

    //M Rust 的段落号与网页出处一致。从服务读原文后重验段落的客户号和机器人。
    const passageRef = /^\/api\/memory-graph\/passage\/([1-9]\d*)$/u.exec(ref);
    if (passageRef !== null) {
      const limit = getLimit(args['limit'], 3, 20);
      return this.getPassage(passageRef[1]!, session, limit);
    }

    //G 卡片只允许读当前机器人和公共记忆目录里的 Markdown，按真实路径验证联接。
    const card = /^(.*\.(?:md|txt)):([1-9]\d*)$/iu.exec(ref);
    if (card === null || !path.isAbsolute(card[1]!)) throw new Error('ref 格式不对');

    const file = await fs.realpath(card[1]!);
    //G 允许读取能搜到的记忆和技能卡片，联接目标也须位于准许的目录。
    const cardRoots = this.cardRoots(session.row.bot);
    const roots = [...cardRoots.keys(), ...this.skillRoots(session.row.bot)];
    const realRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => '')));
    const existing = realRoots.filter(Boolean);
    if (!workspace.isUnder(existing, file)) throw new Error('引用超出记忆目录');

    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('记忆卡片不可读取');

    const text = await fs.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/u);
    const line = Number(card[2]);
    if (line > lines.length) throw new Error('引用行号超出记忆卡片');

    //M 以命中行为中心取指定行数的上下文。
    const limit = getLimit(args['limit'], 5, 20);
    const start = Math.max(1, line - limit);
    return { ref, line, start, text: lines.slice(start - 1, line + limit).join('\n') };
  }

  /** 核对 Rust 段落权限，并在本地库与服务一致时补前文和后文。 */
  private async getPassage(id: string, session: Session, limit: number): Promise<unknown> {
    const route = `/passages/${id}`;
    //M 拿到服务端记录上的范围和内容，再核对它是不是本轮可以看到的原文。
    const result = await this.service.readSearchData(route) as {
      passage?: Passage & { text: string }; relations?: string[];
    };
    const passage = result.passage;
    if (passage === undefined || passage.source?.startsWith(channel.CHANNEL_PARTITION)
      || (passage.scope !== 'history' && passage.scope !== 'knowledge')) {
      throw new Error('找不到原文');
    }

    const row = session.row;
    if (passage.scope === 'history') {
      //G 历史引用始终绑定本轮客户和机器人，包含 Rust 管理的同一客户旧账号。
      const customer = store.getCustomer(row).trim();
      if (customer === '' || passage.customer === '' || passage.bot !== row.bot) {
        throw new Error('找不到当前客户的原文');
      }
      if (passage.customer !== customer) {
        const customerRoute = `/customers/${encodeURIComponent(customer)}`;
        const same = await this.service.readSearchData(customerRoute) as { ids?: string[] };
        if (same.ids?.includes(passage.customer) !== true) throw new Error('找不到当前客户的原文');
      }
    }
    if (passage.scope === 'knowledge' && passage.bot !== '' && passage.bot !== row.bot) {
      throw new Error('找不到当前机器人的知识库原文');
    }

    try {
      //M 本地只读库和 Rust 原文的出处一致才会补邻段。
      const context = this.graphStore?.passageContext(passage, limit);
      if (context !== undefined) return { ...result, ...context };
    } catch {
      //G 本地库未挂载或不可读，原文仍然可以返回。
    }
    return { ...result, warnings: ['相邻段暂不可读'] };
  }

  /** 将输入装成四路共用的查询。显式指定的越权范围报错，默认范围跳过不可查询的来源。 */
  private getQuery(args: Record<string, unknown>, session?: Session): SearchQuery {
    //G 查询词是检索的必要条件。
    const q = getText(args, 'q');
    if (q === '') throw new Error('要给 q');

    //G 只接受已经定义的来源名。
    const requested = getText(args, 'sources') || getText(args, 'source');
    let sources: readonly string[] = SOURCES;
    if (requested !== '' && requested !== 'all') sources = requested.split(',').map((item) => item.trim());
    if (sources.some((source) => !SOURCES.includes(source as Source))) {
      throw new Error('sources 要写 history,channel,knowledge,card');
    }

    //G 模式默认为混合检索，非法值报错让调用者修正。
    const mode = getText(args, 'mode') || 'hybrid';
    if (!MODES.includes(mode as Mode)) throw new Error('mode 要写 keyword、semantic、hybrid 或 graph');

    //G 模型可以限定当前会话或当前客户。
    const range = getText(args, 'range');
    if (range !== '' && range !== 'customer' && range !== 'session') throw new Error('range 要写 customer 或 session');

    //M 网页和内部事件可以按参数限定，模型调用的实际范围再从会话取。
    let bot = getText(args, 'bot');
    let customer = getText(args, 'customer');
    let id = getText(args, 'session');
    let privateAllowed = true;
    let access: channel.ChannelAccess = { full: true };
    if (session !== undefined) {
      //G 模型提供的客户号和机器人只用于确认范围，不能切换身份。
      const row = session.row;
      access = channel.getAccess(session);
      privateAllowed = canReadPrivate(session, access);
      const current = store.getCustomer(row).trim();
      if (bot !== '' && bot !== row.bot) throw new Error('只能查当前机器人');

      if (customer !== '' && customer !== current) throw new Error('只能查当前客户');

      if (range === 'session' && id !== '' && id !== row.id) throw new Error('只能查当前会话');

      bot = row.bot;
      customer = current;
      if (range === 'session') id = row.id;
    }
    const explicit = requested !== '' && requested !== 'all';
    const allowed = new Set(sources as Source[]);
    const skipped: Source[] = [];
    for (const source of allowed) {
      if (source === 'channel' && !access.full && access.chat === undefined && !explicit) {
        //G 老会话缺来源快照时没有渠道授权，继续查询它能查的其他来源。
        allowed.delete(source);
        skipped.push(source);
        continue;
      }
      if (source === 'channel' || (privateAllowed && (source !== 'history' || customer !== ''))) continue;
      if (explicit && !privateAllowed) throw new Error('这一轮只能查当前聊天的消息');

      if (explicit) throw new Error(store.NO_CUSTOMER);

      //G 默认来源里不可查的项目要告诉调用者。
      allowed.delete(source);
      skipped.push(source);
    }
    if (args['mentions'] === true) {
      if (bot === '') throw new Error('mentions 要指定机器人');

      for (const source of allowed) {
        if (source === 'channel') continue;
        //M 只有渠道索引记录可信的提及信息。
        allowed.delete(source);
        skipped.push(source);
      }
    }
    //G 渠道查询必须使用来源快照授权的聊天和账号。
    let scope: channel.ChannelScope = {};
    if (allowed.has('channel')) scope = channel.getScope(args, access);

    //M 时间参数与渠道历史读取共用，条数夹到统一检索上限。
    const limit = getLimit(args['limit'], 10, SEARCH_LIMIT);
    const filters = { ...args, query: q, limit };
    const channelQuery = channel.getQuery(filters, scope);
    if (args['mentions'] === true) channelQuery.mentionedBot = bot;
    if (session === undefined && bot !== '') channelQuery.bot = bot;
    return {
      q, sources: [...allowed], mode: mode as Mode, bot, customer, session: id, notSession: '',
      channel: channelQuery, limit, skipped,
    };
  }

  /** 各来源独立查，交回统一格式。 */
  private async findSource(source: Source, query: SearchQuery, extraCardRoots: string[]): Promise<Lane> {
    if (source === 'channel') {
      //M 查授权聊天中的渠道消息，按消息键生成原文引用。
      const rows = this.searchChannel(query.channel);
      const hits = rows.map((row): SearchHit => {
        const params = new URLSearchParams({ channel: row.channel, chat: row.chat, id: row.key });
        return {
          source, id: row.key, title: row.senderName || row.senderId, snippet: row.text.slice(0, 300), score: 0,
          at: row.at, ref: `${CHANNEL_ROUTE}?${params.toString()}`, via: ['keyword'], customer: '', bot: row.bot,
        };
      });
      return { hits };
    }
    if (source === 'card') {
      //M 记忆卡片沿用现有字组检索，同时保留命中的原文行号和文件时间。
      const cardRoots = this.cardRoots(query.bot);
      for (const root of extraCardRoots) cardRoots.set(root, query.bot);
      const roots = [...cardRoots.keys()];
      const options = { maxFiles: query.limit, loose: true, literalFallback: true,
        since: query.channel.since, until: query.channel.until };
      const cards = await recall.local(roots, query.q, options);
      const hits: SearchHit[] = [];
      for (const card of cards) {
        const ref = `${card.file}:${String(card.line)}`;
        const bot = cardRoots.get(card.root) ?? '';
        hits.push({
          source, id: ref, title: path.basename(card.file), snippet: card.lines.join('\n'), score: 0,
          at: card.at, ref, via: ['keyword'], customer: '', bot,
          file: card.file, where: `第 ${String(card.line)} 行`,
        });
      }
      return { hits };
    }

    //M Rust 处理聊天和知识库的隔离及混合排序。时间筛选在 Rust 现有候选的范围内处理。
    let mode: string = query.mode;
    if (query.mode === 'keyword') mode = 'fast';
    let candidates = query.limit;
    if (query.channel.since !== undefined || query.channel.until !== undefined || mode === 'semantic') {
      candidates = SEARCH_LIMIT;
    }
    const body: Record<string, unknown> = { query: query.q, scope: source, bot: query.bot, mode, limit: candidates };
    if (source === 'history') {
      body['customer'] = query.customer;
      body['session'] = query.session;
      body['not_session'] = query.notSession;
    }
    if (source === 'knowledge') {
      //M 文件写入仍由 Store 增量同步，检索发往 Rust。同步失败时仍可搜已入库的知识。
      await this.disk?.syncKnowledge().catch(() => undefined);
    }
    if (mode !== 'graph') body['rerank'] = false;
    //M 按权限范围交给 Rust 检索，连接问题由上层汇总到 unavailable。
    let timeout = 15_000;
    if (mode === 'graph') timeout = 120_000;
    const response = await this.service.search(body, timeout);
    const lane = response.json as {
      hits?: (Passage & { snippet: string; via: string[]; relations?: string[] })[];
      relations?: string[]; queryEntities?: string[]; warnings?: string[];
    } | undefined;
    if (!response.ok || !Array.isArray(lane?.hits)) throw new Error('记忆服务未能响应');

    const hits: SearchHit[] = [];
    const semantic = query.mode === 'semantic';
    for (const hit of lane.hits) {
      //G 只收请求来源的候选并按指定时间裁剪，语义模式只收向量命中。
      if (hit.scope !== source || hit.source?.startsWith(channel.CHANNEL_PARTITION) || !inTime(hit.at, query.channel)) {
        continue;
      }
      if (semantic && !hit.via.includes('vector')) continue;
      const id = String(hit.id);
      //M 普通 Rust 段落按服务端编号生成出处，渠道原文走自己的引用。
      hits.push({
        source, id, title: hit.title, snippet: hit.snippet, score: 0, at: hit.at,
        ref: `${PASSAGE_ROUTE}${id}`, via: hit.via, customer: hit.customer, bot: hit.bot, origin: hit.source,
        start: hit.start, end: hit.end, relations: hit.relations,
      });
    }
    if (semantic) return { hits, warnings: lane.warnings };

    return { hits, relations: lane.relations, queryEntities: lane.queryEntities, warnings: lane.warnings };
  }

  /** 查询渠道索引，统一入口和兼容工具都查同一份数据。 */
  private searchChannel(query: channel.ChannelQuery): channel.ChannelRow[] {
    if (this.index === undefined) throw new Error('渠道消息索引未开启');

    //M 查索引前调用方已经锁定当前用户的渠道范围。
    return this.index.search(query);
  }

  /** 公共记忆一直查，指定机器人时只另查它的卡片。 */
  private cardRoots(bot: string): Map<string, string> {
    //M 根目录来自配置及机器人实例，避免把机器人参数当作文件路径。
    const shared = this.ctx.resources.dir('memory');
    const roots = new Map<string, string>([[shared, '']]);
    const bots = this.ctx.bots.list();
    for (const item of bots) {
      if (bot !== '' && item.name !== bot) continue;
      if (!roots.has(item.memory)) roots.set(item.memory, item.name);
    }
    return roots;
  }

  /** 保留兼容搜索之前可查的技能卡片目录。 */
  skillRoots(bot: string): string[] {
    //M 从资源目录定位机器人与全局技能卡片。
    const own = this.ctx.resources.dir('bots', bot, 'skills');
    const shared = this.ctx.resources.dir('skills');
    return [own, shared];
  }

  /** 前台三次历史工具配额，以最后一条用户消息区分轮次。 */
  private takeTurn(session: Session): void {
    if (session.row.kind !== 'front') return;

    //M 用户消息对象随轮次更换，旧轮为了释放会话可以由 WeakMap 回收。
    const turn = session.row.messages.findLast((message) => message.role === 'user');
    const previous = this.quota.get(session);
    let calls = 0;
    if (previous?.turn === turn) calls = previous?.calls ?? 0;
    if (calls >= HISTORY_CALLS) throw new Error('本轮记忆工具已调用 3 次。需要通读大量历史时请用 hand_session。');

    this.quota.set(session, { turn, calls: calls + 1 });
  }
}

/** 入口只收字符串参数。 */
function getText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (value === undefined) return '';

  if (typeof value !== 'string') throw new Error(`${key} 要写字符串`);

  return value.trim();
}

/** 条数默认值和夹范围只在入口处理。 */
function getLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;

  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('limit 要写整数');

  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error('limit 要写整数');

  return Math.min(max, Math.max(1, n));
}

/** 判断后端候选是否在调用者指定的时间范围内。 */
function inTime(at: number, query: channel.ChannelQuery): boolean {
  return at >= (query.since ?? 0) && at <= (query.until ?? Infinity);
}

/** 有来源快照就用其授权，无快照时沿用内部会话的地址规则。 */
function canReadPrivate(session: Session, access: channel.ChannelAccess): boolean {
  //G 显式群聊和外人不能看私人记忆，老会话没有快照时按地址角色判断。
  const address = session.row.address;
  const trusted = access.full || access.channel === undefined;
  return trusted && workspace.privateAllowed(address) && !workspace.isGroup(address);
}
