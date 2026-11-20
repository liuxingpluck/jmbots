/** 统一检索与原文读取。网页、内部事件和模型共用检索，模型的范围由会话来源决定。 */
import * as botUtils from '../../utils/Bots.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import type { Session } from '../../Sessions.ts';
import * as text from '../../utils/Text.ts';
import * as workspace from '../../utils/Workspace.ts';
import * as channel from './ChannelIndex.ts';
import type { GraphRoutes } from './GraphRoutes.ts';
import type { GraphStore } from './GraphStore.ts';
import * as frontArchive from './FrontArchive.ts';
import type { MemoryService } from './index.ts';
import * as memoryKeyModule from './MemoryKey.ts';
import * as recall from './Recall.ts';
import * as store from './Store.ts';

const SOURCES = ['history', 'channel', 'knowledge', 'card'] as const;
const MODES = ['keyword', 'semantic', 'hybrid', 'graph'] as const;
const SEARCH_LIMIT = 50;
const HISTORY_CALLS = 3;
const HISTORY_PARALLEL = 4;
const SEARCH_ROUTE = '/api/memory/search';
const OWNERS_ROUTE = '/api/memory/owners';
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
  /** 本人未指定客户或会话时，查询该机器人所有历史分区。 */
  allHistory: boolean;
  /** 受限会话的原始渠道消息必须走账号隔离的渠道索引。 */
  restricted: boolean;
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
    private readonly front?: frontArchive.FrontArchive,
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
        warnings.add(text.getErrorMessage(lane.reason));
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
        return reply.code(400).send({ error: text.getErrorMessage(error) });
      }
    });

    //M 与检索接口使用同一 HTTP 令牌校验。
    app.get(OWNERS_ROUTE, () => ({ owners: this.listOwners() }));
  }

  /** 给记忆页汇总可用的归属键、渠道显示名和段落数。 */
  private listOwners(): Array<{ key: string; kind: 'owner' | 'person' | 'group'; name: string; count: number }> {
    //M 两个来源里同一个归属合并为一项，已经同步的渠道消息只算一次。
    const indexed = this.index?.ownershipRows() ?? [];
    const fromChannel = new Map(indexed.map((item) => [item.key, item]));
    const stored = new Map<string, { count: number; channels: number }>();
    try {
      const rows = this.graphStore?.ownershipRows() ?? [];
      for (const row of rows) {
        stored.set(row.key, row);
      }
    } catch {
      //G Rust 库未挂载或暂时不可读，渠道索引仍能提供选择。
    }

    const keys = new Set([...fromChannel.keys(), ...stored.keys()]);
    const owners: Array<{ key: string; kind: 'owner' | 'person' | 'group'; name: string; count: number }> = [];
    for (const key of keys) {
      const messages = fromChannel.get(key);
      const passages = stored.get(key);
      let count = messages?.count ?? passages?.count ?? 0;
      if (messages !== undefined && passages !== undefined) {
        count += passages.count - passages.channels;
      }
      if (key === memoryKeyModule.OWNER_KEY) {
        //M 本机归属用固定显示名，和渠道身份分开。
        owners.push({ key, kind: 'owner', name: '本人', count });
        continue;
      }

      //M 聊天号和发话人 ID 可能有冒号，保留分隔符后的完整原值。
      const colon = key.indexOf(':');
      const delimiter = key.indexOf(':', colon + 1);
      const id = key.slice(delimiter + 1);
      if (memoryKeyModule.isMemoryKey('person', key)) {
        const source = key.slice(colon + 1, delimiter);
        //M 先用已打标消息的人名。只有 Rust 有归属时可从渠道的旧行补显示名。
        const name = messages?.name || this.index?.ownershipName(source, id) || id;
        owners.push({ key, kind: 'person', name, count });
        continue;
      }
      //G 老客户或不完整的键保留在原检索体系内。
      const group = memoryKeyModule.isMemoryKey('group', key);
      if (group) {
        owners.push({ key, kind: 'group', name: id, count });
      }
    }

    //M 固定名称和归属键排序，页面刷新时列表不会因写入计数而换位。
    return owners.sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  }

  /** 登记两件模型工具。 */
  registerTools(): void {
    //M 按问题找线索，交回带 ref 的摘要，全文由下一件工具取。
    this.ctx.tools.register({
      definition: {
        name: 'memory_search',
        description: '按问题搜往来、渠道、知识库和卡片。front 查这场的归档，mentions 查 @。要看原文用 memory_get。',
        parameters: piAi.Type.Object({
          q: piAi.Type.Optional(piAi.Type.String({ description: '检索词，单查渠道、归档或 @ 时可省' })),
          sources: piAi.Type.Optional(piAi.Type.String({ description: '逗号分隔 history,channel,knowledge,card，默认全部' })),
          mode: piAi.Type.Optional(piAi.Type.Union(MODES.map((mode) => piAi.Type.Literal(mode)))),
          customer: piAi.Type.Optional(piAi.Type.String({ description: '当前客户号' })),
          bot: piAi.Type.Optional(piAi.Type.String({ description: '当前机器人' })),
          session: piAi.Type.Optional(piAi.Type.String({ description: '限定会话号' })),
          range: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('customer'), piAi.Type.Literal('session')])),
          mentions: piAi.Type.Optional(piAi.Type.Boolean({ description: '只查提到当前机器人的渠道消息' })),
          front: piAi.Type.Optional(piAi.Type.Boolean({ description: '查这场前台及它交办的往来归档' })),
          who: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('user'), piAi.Type.Literal('bot')])),
          senderId: piAi.Type.Optional(piAi.Type.String({ description: '只查这位发言人的渠道消息' })),
          after: piAi.Type.Optional(piAi.Type.Integer({ description: '前台往来编号，向后翻页' })),
          before: piAi.Type.Optional(piAi.Type.Union([PAGE_CURSOR, piAi.Type.Integer({ description: '前台往来编号' })])),
          from_earliest: piAi.Type.Optional(piAi.Type.Boolean({ description: '从最早一条往后翻' })),
          ...FILTERS,
        }),
      },
      sessionKinds: ['front', 'work'],
      run: async (args, session) => {
        //G 前台先扣本轮额度，再按来源和权限检索。
        this.takeTurn(session);
        if (args['front'] === true) {
          frontArchive.checkFrontAccess(session);
          if (this.front === undefined) return frontArchive.HISTORY_UNAVAILABLE;

          return this.front.searchFront(this.ctx.sessions, this.service, session, args);
        }
        if (args['mentions'] === true && getText(args, 'q') === '') {
          //M 无关键词时按本聊天翻看 @，沿用原文翻页游标。
          const page = await this.get(args, session);
          return JSON.stringify(page);
        }

        //M 常规检索返回跨来源的结构化命中。
        const result = await this.find(args, session);
        return JSON.stringify(result);
      },
    });

    //M 用引用定位一段原文，或按聊天和时间取连续消息。
    this.ctx.tools.register({
      definition: {
        name: 'memory_get',
        description: '用 ref 取原文和上下文。省略 ref 读取本聊天最近几条，下一页给 before 游标。',
        parameters: piAi.Type.Object({
          ref: piAi.Type.Optional(piAi.Type.String({ description: '来源引用或 bot-log:往来编号' })),
          before: piAi.Type.Optional(PAGE_CURSOR),
          senderId: piAi.Type.Optional(piAi.Type.String({ description: '只看这位发言人的历史' })),
          mentions: piAi.Type.Optional(piAi.Type.Boolean({ description: '只看提及当前机器人的消息' })),
          ...FILTERS,
        }),
      },
      sessionKinds: ['front', 'work'],
      run: async (args, session) => {
        //G 检索与取原文共用同一份前台额度。
        this.takeTurn(session);
        const ref = getText(args, 'ref');
        const entry = /^(?:bot-log:|#)([1-9]\d*)$/u.exec(ref);
        if (entry !== null) {
          frontArchive.checkFrontAccess(session);
          if (this.front === undefined) return frontArchive.HISTORY_UNAVAILABLE;

          const id = Number(entry[1]);
          return this.front.getFront(this.ctx.sessions, session, id);
        }

        //M 索引引用和按时间截取的渠道消息走统一原文查找。
        const result = await this.get(args, session);
        return JSON.stringify(result);
      },
    });
  }

  /** 按 ref 读取原文。在查询数据前把聊天范围固定为本轮获准的范围。 */
  async get(args: Record<string, unknown>, session: Session): Promise<unknown> {
    //G 先确定引用类型和说话人的来源范围。
    const ref = getText(args, 'ref');
    const access = channel.getAccess(session);
    //M 渠道原文按稳定消息键定位，或按聊天和时间列一段完整消息。
    if (ref === '') {
      //M 省略引用时按本轮聊天翻页，两个账号的同名会话仍固定到当前账号。
      const scope = this.getChannelPageScope(args, access);
      const query = channel.getQuery(args, scope);
      if (args['mentions'] === true) query.mentionedBot = session.row.bot;
      const index = this.index;
      if (index === undefined) throw new Error('渠道消息索引未开启');

      const before = getText(args, 'before');
      return index.page(query, before);
    }
    if (ref.startsWith(`${CHANNEL_ROUTE}?`)) {
      const params = new URLSearchParams(ref.slice(CHANNEL_ROUTE.length + 1));
      const chosen = { ...args };
      for (const key of ['channel', 'chat'] as const) {
        const value = params.get(key);
        if (value !== null) chosen[key] = value;
      }
      //G 引用可以定位聊天，但只能读取当前用户获准的范围。
      const scope = channel.getScope(chosen, access);
      if (scope.chat === undefined) throw new Error('请给 ref 或 chat');

      //G 引用必须明确给出消息键。
      const id = params.get('id');
      if (id === null) throw new Error('引用缺少消息编号');

      //M 用索引定位这条消息和附近原文。
      chosen['limit'] = getLimit(args['limit'], 3, 20);
      const query = channel.getQuery(chosen, scope);
      const index = this.index;
      if (index === undefined) throw new Error('渠道消息索引未开启');

      //M 有锚点时取这条原文和附近的消息。
      return index.context(id, query);
    }

    //M Rust 的段落号与网页出处一致。从服务读原文后重验段落的客户号和机器人。
    const passageRef = /^\/api\/memory-graph\/passage\/([1-9]\d*)$/u.exec(ref);
    if (passageRef !== null) {
      const limit = getLimit(args['limit'], 3, 20);
      return this.getPassage(passageRef[1]!, session, limit, access);
    }

    //G 本人的卡片和私人文件始终只对本人开放。
    if (!access.full) throw new Error('这一轮只能看当前归属的聊天原文');

    //G 卡片只允许读当前机器人和公共记忆目录里的 Markdown，按真实路径验证联接。
    const card = /^(.*\.(?:md|txt)):([1-9]\d*)$/iu.exec(ref);
    if (card === null || !path.isAbsolute(card[1]!)) throw new Error('ref 格式不对');

    const file = await fs.realpath(card[1]!);
    //G 允许读取能搜到的记忆和技能卡片，联接目标也须位于准许的目录。
    const cardRoots = this.cardRoots(session.row.bot);
    const roots = [...cardRoots.keys(), ...this.skillRoots(session.row.bot)];
    const realRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => '')));
    const existing = realRoots.filter(Boolean);
    if (!workspace.isPathInDirectories(existing, file)) throw new Error('引用超出记忆目录');

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

  /** 默认本聊天。本人可以明确指定其他聊天，受限会话仍按来源授权。 */
  private getChannelPageScope(args: Record<string, unknown>, access: channel.ChannelAccess): channel.ChannelScope {
    const requestedChannel = getText(args, 'channel') || access.channel;
    let chat = getText(args, 'chat');
    if (chat === '' && requestedChannel === access.channel) {
      chat = access.chat ?? '';
    }
    const chosen = { channel: requestedChannel, chat };
    const scope = channel.getScope(chosen, access);
    if (scope.channel === undefined || scope.chat === undefined) {
      throw new Error('当前会话没有聊天来源，请给 ref 或指定 channel 和 chat');
    }
    if (scope.channel === access.channel && scope.chat === access.chat) {
      scope.account = access.account;
    }
    return scope;
  }

  /** 核对 Rust 段落权限，并在本地库与服务一致时补前文和后文。 */
  private async getPassage(
    id: string,
    session: Session,
    limit: number,
    access: channel.ChannelAccess,
  ): Promise<unknown> {
    if (!access.full && access.key === undefined) throw new Error('这一轮没有确定的记忆归属');

    const route = `/passages/${id}`;
    //M 拿到服务端记录上的范围和内容，再核对它是不是本轮可以看到的原文。
    const result = await this.service.readSearchData(route) as {
      passage?: Passage & { text: string }; relations?: string[];
    };
    const passage = result.passage;
    if (passage === undefined || (passage.scope !== 'history' && passage.scope !== 'knowledge')) {
      throw new Error('找不到原文');
    }

    const row = session.row;
    if (!access.full) {
      //G 授权范围来自消息本身。相似客户或别名也不能通过取原文扩大到其他归属。
      const channelCopy = passage.source?.startsWith(channel.CHANNEL_PARTITION) === true;
      if (channelCopy || passage.scope !== 'history' || passage.customer !== access.key || passage.bot !== row.bot) {
        throw new Error('找不到当前归属的原文');
      }
    }
    if (access.full && passage.scope === 'history' && passage.bot !== row.bot) {
      throw new Error('找不到当前机器人的原文');
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
    //G 空关键词只用于渠道检索或翻看 @，其他来源需要问题或关键词。
    const q = getText(args, 'q');
    const requested = getText(args, 'sources') || getText(args, 'source');
    if (q === '' && requested !== 'channel' && args['mentions'] !== true) throw new Error('要给 q');

    //G 只接受已经定义的来源名。
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
    //M 按人、按群查：归属键当 Rust 聊天往来的客户号，渠道索引按 memory_key 筛。
    let memoryKey = getKeyFilter(args, customer, session);
    if (memoryKey !== '') customer = memoryKey;

    let access: channel.ChannelAccess = { full: true };
    let allHistory = false;
    if (session !== undefined) {
      //G 模型提供的客户号和机器人只用于确认范围，不能切换身份。
      const row = session.row;
      access = channel.getAccess(session);
      let current = access.key ?? '';
      if (access.full) {
        current = store.getCustomer(row).trim();
      }
      if (bot !== '' && bot !== row.bot) throw new Error('只能查当前机器人');

      if (customer !== '' && customer !== current) throw new Error('只能查当前客户');

      if (range === 'session' && id !== '' && id !== row.id) throw new Error('只能查当前会话');

      //M 本人不按说话人过滤。显式会话或客户查询沿用旧范围。
      allHistory = access.full && customer === '' && id === '' && range === '';
      bot = row.bot;
      customer = current;
      memoryKey = access.key ?? '';
      if (range === 'session') id = row.id;
    }
    const explicit = requested !== '' && requested !== 'all';
    const allowed = new Set(sources as Source[]);
    const skipped: Source[] = [];
    for (const source of allowed) {
      if (source === 'channel' && !access.full && (!access.chat || !access.account || !access.key) && !explicit) {
        //G 老会话缺来源快照时没有渠道授权，继续查询它能查的其他来源。
        allowed.delete(source);
        skipped.push(source);
        continue;
      }
      //G 归属过滤只返回能确认属于该人或该群的内容。
      if (memoryKey !== '' && (source === 'knowledge' || source === 'card')) {
        allowed.delete(source);
        skipped.push(source);
        continue;
      }
      if (source === 'channel' || (source === 'history' && (customer !== '' || allHistory))) continue;
      if (source !== 'history' && access.full) continue;
      if (explicit && !access.full) throw new Error('这一轮只能查当前归属的消息');

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
    if (allowed.has('channel')) {
      scope = channel.getScope(args, access);
      if (q === '' && args['mentions'] === true && session !== undefined) {
        scope = this.getChannelPageScope(args, access);
      }
    }

    //M 只查渠道时继承原有的 200 条上限，跨来源仍限制在 50 条。
    let max = SEARCH_LIMIT;
    if (allowed.size === 1 && allowed.has('channel')) max = 200;
    const limit = getLimit(args['limit'], 10, max);
    const filters = { ...args, query: q, limit };
    const channelQuery = channel.getQuery(filters, scope);
    if (args['mentions'] === true) channelQuery.mentionedBot = bot;
    if (session === undefined && bot !== '') channelQuery.bot = bot;
    if (memoryKey !== '') channelQuery.memoryKey = memoryKey;
    return {
      q, sources: [...allowed], mode: mode as Mode, bot, customer, allHistory, restricted: !access.full,
      session: id, notSession: '',
      channel: channelQuery, limit, skipped,
    };
  }

  /** 各来源独立查，交回统一格式。 */
  private async findSource(source: Source, query: SearchQuery, extraCardRoots: string[]): Promise<Lane> {
    if (source === 'history' && query.allHistory) {
      //M 只有本人可以逐个查询历史分区。
      return this.findAllHistory(query);
    }
    if (source === 'channel') {
      //M 查授权聊天中的渠道消息，按消息键生成原文引用。
      const rows = this.searchChannel(query.channel);
      const hits = rows.map((row): SearchHit => {
        const params = new URLSearchParams({ channel: row.channel, chat: row.chat, id: row.key });
        const customer = row.memoryKey ?? '';
        //M 撤回不抹去出处，检索摘要显式标记并列出已归档附件。
        const text = channel.getChannelText(row);
        const snippet = text.slice(0, 300);
        return {
          source, id: row.key, title: row.senderName || row.senderId, snippet, score: 0,
          at: row.at, ref: `${CHANNEL_ROUTE}?${params.toString()}`, via: ['keyword'], customer, bot: row.bot,
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
    const memoryKey = query.channel.memoryKey;
    //G Rust 的渠道副本没有单独的账号字段，受限会话始终从能校验账号的渠道索引读它们。
    const dedupeChannels = query.restricted || memoryKey === undefined || query.sources.includes('channel');
    for (const hit of lane.hits) {
      //G 只收请求来源的候选并按指定时间裁剪，语义模式只收向量命中。
      if (hit.scope !== source || !inTime(hit.at, query.channel)) continue;

      //G 归属检索只认原键；渠道索引已一起查时，跳过 Rust 中的相同渠道消息。
      if (memoryKey !== undefined && hit.customer !== memoryKey) continue;

      if (dedupeChannels && hit.source?.startsWith(channel.CHANNEL_PARTITION)) continue;

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

    //M 按归属查时只公开本分区的命中所带关系，避免把相邻分区的匹配关系混进来。
    if (memoryKey !== undefined) {
      const relations = hits.flatMap((hit) => hit.relations ?? []);
      return { hits, relations, warnings: lane.warnings };
    }

    return { hits, relations: lane.relations, queryEntities: lane.queryEntities, warnings: lane.warnings };
  }

  /** Rust 每次只接一个客户，本人可从同机库列出分区后逐批查询。 */
  private async findAllHistory(query: SearchQuery): Promise<Lane> {
    const customers = new Set<string>();
    if (query.customer !== '') {
      customers.add(query.customer);
    }
    const warnings = new Set<string>();
    try {
      const catalog = this.graphStore?.historyCustomers(query.bot) ?? [];
      for (const customer of catalog) {
        customers.add(customer);
      }
    } catch {
      //G 非同机或库暂时不可读时仍搜当前客户，渠道索引仍按本人范围查询。
      warnings.add('历史分区目录暂不可读，Rust 只检索当前客户');
    }

    const ids = [...customers];
    const hits = new Map<string, SearchHit>();
    const relations = new Set<string>();
    const queryEntities = new Set<string>();
    let succeeded = 0;
    for (let offset = 0; offset < ids.length; offset += HISTORY_PARALLEL) {
      //M 控制同一时间发给记忆服务的子查询数量；各分区独立失败。
      const batch = ids.slice(offset, offset + HISTORY_PARALLEL);
      const requests = batch.map((customer) => {
        const scoped = { ...query, customer, allHistory: false };
        return this.findSource('history', scoped, []);
      });
      const outcomes = await Promise.allSettled(requests);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          warnings.add(text.getErrorMessage(outcome.reason));
          continue;
        }
        const one = outcome.value;
        succeeded += 1;
        for (const hit of one.hits) hits.set(hit.id, hit);
        for (const relation of one.relations ?? []) relations.add(relation);
        for (const item of one.queryEntities ?? []) queryEntities.add(item);
        for (const warning of one.warnings ?? []) warnings.add(warning);
      }
    }
    if (ids.length > 0 && succeeded === 0) {
      const cause = [...warnings].join('；');
      throw new Error(cause);
    }

    const ranked = [...hits.values()].sort((a, b) => b.at - a.at);
    return { hits: ranked, relations: [...relations], queryEntities: [...queryEntities], warnings: [...warnings] };
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
    const shared = this.ctx.resources.ensureRuntimeDir('memory');
    const roots = new Map<string, string>([[shared, '']]);
    const bots = botUtils.getBotConfigs(this.ctx.resources.raw);
    for (const item of bots) {
      if (bot !== '' && item.name !== bot) continue;
      const memory = botUtils.getBotDir(this.ctx.resources, item.name, 'memory');
      if (!roots.has(memory)) roots.set(memory, item.name);
    }
    return roots;
  }

  /** 保留兼容搜索之前可查的技能卡片目录。 */
  skillRoots(bot: string): string[] {
    //M 从资源目录定位机器人与全局技能卡片。
    const own = this.ctx.resources.ensureRuntimeDir('bots', bot, 'skills');
    const shared = this.ctx.resources.ensureRuntimeDir('skills');
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

/**
 * 入口读 person、group（按人分记忆）：只给一个，写成 MemoryKey.ts 算出来的那种键。
 * @param args 查询参数。
 * @param customer 调用方写的旧客户号，和归属键只能二选一。
 * @param session 模型调用时的会话；网页和内部请求没有。
 * @returns 归属键；两个都没给是空串，查询照旧。
 * @throws 写法不对、两个都给、和 customer 同给、模型调用时给。
 */
function getKeyFilter(args: Record<string, unknown>, customer: string, session?: Session): string {
  //M 在统一入口读取并去掉两头空白，后面只处理校验过的值。
  const person = getText(args, 'person');
  const group = getText(args, 'group');
  if (person === '' && group === '') return '';

  //G 模型的范围由会话定，不能换成别人的记忆。
  if (session !== undefined) {
    throw new Error('person、group 只给网页和内部请求用');
  }

  //G 一个键代表一个分区，避免同时传入互相冲突的归属条件。
  if (person !== '' && group !== '') {
    throw new Error('person 和 group 只能给一个');
  }

  if (customer !== '') {
    throw new Error('customer 和 person、group 只能给一个');
  }

  //G 群的键只认 group:<渠道>:<聊天号>。
  if (group !== '') {
    const valid = memoryKeyModule.isMemoryKey('group', group);
    if (!valid) {
      throw new Error('group 要写 group:<渠道>:<聊天号>');
    }
    return group;
  }

  //G 人的键只认 owner 或 person:<渠道>:<发话人ID>。
  const valid = memoryKeyModule.isMemoryKey('person', person);
  if (!valid) {
    throw new Error('person 要写 owner 或 person:<渠道>:<发话人ID>');
  }

  return person;
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
