/**
 * web-api 的会话和机器人接口：会话列表、正在跑的、详情、步骤、换模型、喊停，机器人列表和详情，回话追溯。
 * 都是网页来查、来点的：读会话表、机器人配置和收件表，换模型、喊停直接改那场会话；渠道收发不在这里（在 index.ts 的 WebApi）。
 * WebApi 的构造函数建它，在同一个 Fastify 作用域里调 routes 登记接口。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import type { Session, SessionMeta, Thinking } from '../../Sessions.ts';
import * as botUtils from '../../utils/Bots.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as timelineModule from './Timeline.ts';
import * as traceModule from './Trace.ts';


/** 步骤默认几步、最多几步。 */
const STEPS_DEFAULT = 100;
const STEPS_MAX = 500;


/** 会话和机器人接口。 */
export class Views {
  /**
   * @param ctx web-api 插件的 ctx：查会话表、机器人配置，发请求事件。
   * @param timeline WebApi 建好的收件表：认机器人、取消息、查关联。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly timeline: timelineModule.Timeline,
  ) {}

  /**
   * 登记会话、机器人、追溯这些接口。WebApi 的构造函数在 Fastify 作用域里和 WebApi.routes 一起调。
   * @param scope WebApi 开的 Fastify 作用域。
   */
  routes(scope: fastify.FastifyInstance): void {
    type Query = { Querystring: Record<string, string | undefined> };
    type Id = { Params: { id: string } };

    //M 让网页按消息号和回话下标查询回复的生成过程。
    scope.get<Id & Query>('/api/messages/:id/trace', async (request) => {
      return this.trace(request.params.id, request.query['reply']);
    });

    //M 给网页提供会话选择列表、正在运行清单、指定会话的详情和步骤。
    scope.get<Query>('/api/sessions', async (request) => this.sessionList(request.query));
    scope.get<Query>('/api/ui/sessions', async (request) => this.sessionList(request.query));
    scope.get<Query>('/api/ui/running', async (request) => this.runningList(request.query));
    scope.get<Id>('/api/sessions/:id', async (request) => this.sessionDetail(request.params.id));
    scope.get<Id & Query>('/api/sessions/:id/steps', async (request) => this.steps(request.params.id, request.query));

    //M 将网页的模型切换和停止请求交给对应的会话控制入口。
    scope.post<Id & { Body: unknown }>('/api/sessions/:id/model', async (request) => {
      return this.setModel(request.params.id, request.body);
    });
    scope.post<Id & { Body: unknown }>('/api/sessions/:id/stop', async (request) => {
      return this.stop(request.params.id, request.body);
    });

    //M 为机器人选择器和详情页提供概要与目录信息。
    scope.get('/api/bots', async () => this.botList());
    scope.get<{ Params: { name: string } }>('/api/ui/bots/:name', async (request) => this.botInfo(request.params.name));
  }

  /**
   * 会话简要：列表、详情、搜索共用（web/src/Api.ts:335-352 的 SessionBrief）。
   * @param meta 会话记录。
   */
  private brief(meta: SessionMeta): Record<string, unknown> {
    //M 从会话记录取显示用的客户名称，缺少时留空。
    const customer = utils.getStringField(meta, 'customer');

    //M 将会话标题、状态和文件地址组装成网页列表与详情共用的摘要。
    return {
      id: meta.id,
      bot: meta.bot,
      kind: meta.kind,
      parent: meta.parent,
      customer,
      workspace: 'workspace',
      title: timelineModule.title(meta),
      summary: meta.summary ?? '',
      model: meta.model,
      status: timelineModule.getStatus(meta.state),
      updatedAt: meta.updatedAt,
      files: { ...timelineModule.sessionFiles(this.ctx.resources.root, meta), compact: '' },
    };
  }

  /**
   * GET /api/sessions、/api/ui/sessions：一个机器人的会话（只给没有 parent 的，小会话不给网页看），最近动过的在前。
   * @param query bot（不写是第一个）、status（idle、running、error）。
   */
  private sessionList(query: Record<string, string | undefined>): Record<string, unknown>[] {
    //G 先确定会话列表的目标机器人，没有可用机器人时返回空列表。
    const bot = this.timeline.getBot(query['bot']);
    if (bot === undefined) return [];

    //G 拒绝网页不支持的状态筛选词。
    const status = query['status'];
    if (status !== undefined && status !== '' && !['idle', 'running', 'error'].includes(status)) {
      throw new failureModule.Failure(400, 'status 要是 idle、running 或 error');
    }

    //M 按机器人与页面状态筛出独立会话，生成网页需要的会话摘要。
    return this.ctx.sessions.find({ bot })
      .filter((meta) => meta.parent === undefined)
      .filter((meta) => status === undefined || status === '' || timelineModule.getStatus(meta.state) === status)
      .map((meta) => this.brief(meta));
  }

  /**
   * GET /api/ui/running：当前机器人正在跑的前台和后台会话（含有 parent 的子会话），给右栏「正在运行」。
   * 每条带标题、客户/渠道标签、本轮开始时间和最新进度（progress、assist 待办、对话里最近的工具调用）。
   * @param query bot（不写是第一个）。
   */
  private async runningList(query: Record<string, string | undefined>): Promise<Record<string, unknown>[]> {
    //G 只查已确定机器人的运行会话，没有可用机器人时返回空列表。
    const bot = this.timeline.getBot(query['bot']);
    if (bot === undefined) return [];

    const request = { action: 'list', bot } as const;
    //M 向进度插件取生效的卡片，无应答时从会话本身恢复展示。
    const progress = await requestEventModule.requestEvent(
      this.ctx,
      'progress/request',
      'progress/result',
      request,
    );
    const cards = progress.reply?.items ?? [];

    //M 给每个运行会话匹配仍生效的进度卡并读出会话详情。
    return this.ctx.sessions.find({ bot, state: 'running' }).map((meta) => {
      const card = cards.find((item) => item.sessionId === meta.id && item.endedAt === undefined);
      const session = this.ctx.sessions.open(meta.id);
      const customer = utils.getStringField(meta, 'customer');

      //M 优先采用进度卡，缺失时从待办和对话补出开始时刻及当前动作。
      const startedAt = card?.startedAt ?? runStartedAt(session, meta.updatedAt);
      const action = card?.action
        || assistDoing(this.ctx.resources.db, meta.id)
        || latestAction(session, meta.kind);

      //M 给网页运行卡片提供可读的会话标题和来源标签。
      return {
        id: meta.id,
        kind: meta.kind,
        parent: meta.parent,
        title: runningTitle(meta),
        customer,
        customerLabel: customerLabel(customer),
        status: 'running',
        startedAt,
        updatedAt: meta.updatedAt,
        action,
      };
    });
  }

  /**
   * 打开一场会话。
   * @param id 会话号。
   * @throws Failure(404)：没有这场。
   */
  private open(id: string): Session {
    //G 在打开前确认编号存在，让接口对缺失会话回 404。
    if (this.ctx.sessions.find({ id }).length === 0) throw new failureModule.Failure(404, `没有这场会话：${id}`);

    //M 已确认存在后打开会话，供详情或操作接口使用。
    return this.ctx.sessions.open(id);
  }

  /**
   * GET /api/sessions/:id：会话详情（web/src/Types.ts:566-595 的 SessionDetail）。
   * @param id 会话号。
   */
  private sessionDetail(id: string): Record<string, unknown> {
    //M 读取会话后组装列表摘要和镜像文件位置，供详情页展示。
    const row = this.open(id).row;
    const brief = this.brief(row);
    const files = timelineModule.sessionFiles(this.ctx.resources.root, row);
    //M 上一次调模型时的上下文：最后一条模型回答的输入加缓存读。
    const last = row.messages.findLast((item) => item.role === 'assistant');
    let tokens = 0;
    if (last?.role === 'assistant') {
      tokens = last.usage.input + last.usage.cacheRead;
    }

    //M 已生成的镜像正文直接提供给网页详情。
    let md = '';
    if (files.md !== '') {
      md = fs.readFileSync(files.md, 'utf8');
    }
    return {
      ...brief,
      thinking: row.thinking,
      tokens,
      runs: [],
      createdAt: row.messages[0]?.timestamp ?? row.updatedAt,
      files,
      md,
    };
  }

  /**
   * GET /api/sessions/:id/steps：一场会话的步骤，按 after、limit 分页。
   * @param id 会话号。
   * @param query after（从第几步之后）、limit（最多几步）。
   * @throws Failure(404)：没有这场。
   */
  private steps(id: string, query: Record<string, string | undefined>): traceModule.SessionStep[] {
    //M 先打开指定会话，为步骤页取得完整对话记录。
    const row = this.open(id).row;

    //M 网址里的 after、limit：写错按默认，超上限按上限。
    const after = textModule.parseBoundedInt(query['after'], 0, 0, Infinity);
    const limit = textModule.parseBoundedInt(query['limit'], STEPS_DEFAULT, 0, STEPS_MAX);
    return traceModule.steps(row, after, limit);
  }

  /**
   * POST /api/sessions/:id/model：换会话的模型和思考档，在转的会话下一步就用新的（骨架每一步现读 row.model、row.thinking）。
   * @param id 会话号。
   * @param raw { model, thinking }：thinking 是 null 取这个模型支持的最高一档。
   * @returns 会话当前的模型、思考档和状态。
   * @throws Failure：没有这场会话时返回 404，模型不可用或思考档不支持时返回 400。
   * 副作用：保存会话模型和思考档，并发出变更通知。
   */
  private async setModel(id: string, raw: unknown): Promise<Record<string, unknown>> {
    //G 先确认会话存在，并校验请求带了可查询的模型名。
    const session = this.open(id);
    const model = utils.getField(raw, 'model');
    if (typeof model !== 'string' || model === '') throw new failureModule.Failure(400, 'model 要是非空字符串');

    const request = { action: 'find', model } as const;
    //G 允许模型目录确认过的聊天模型，无应答时按未知模型处理。
    const result = await requestEventModule.requestEvent(
      this.ctx,
      'model-catalog/request',
      'model-catalog/result',
      request,
    );
    const info = result.reply?.info;
    if (info === undefined || info.kind !== 'chat') throw new failureModule.Failure(400, `模型不可用：${model}`);

    //G 显式思考档必须受该模型支持，省略时使用最高档。
    const requested = utils.getField(raw, 'thinking');
    let thinking = info.thinking.at(-1) ?? 'off';
    if (requested !== null && requested !== undefined) {
      if (typeof requested !== 'string' || !info.thinking.includes(requested)) {
        throw new failureModule.Failure(400, `思考档 ${String(requested)} 这个模型不支持，支持：${info.thinking.join('、')}`);
      }
      thinking = requested;
    }

    //M 持久化模型和思考档，供会话后续步骤读取并保留变更前后值。
    const row = session.row;
    const change = {
      session,
      from: row.model,
      to: model,
      thinkingFrom: row.thinking,
      thinkingTo: thinking,
      by: 'HTTP' as const,
    };
    row.model = model;
    row.thinking = thinking as Thinking;
    session.save();

    //T 跟踪：换了模型。
    const vars = {
      session: id,
      previous: `${change.from} ${change.thinkingFrom}`,
      next: `${change.to} ${change.thinkingTo}`,
    };
    this.ctx.emit('trace', 'Views.setModel', 'trace.webApi.setModel', 'row.model = model; session.save()', vars);
    this.ctx.emit('web-api/model', change);
    return { id, model: row.model, thinking: row.thinking, status: timelineModule.getStatus(row.state) };
  }

  /**
   * POST /api/sessions/:id/stop：喊停。正在等的模型请求马上掐掉；骨架加了停止信号以后，慢的工具也跟着断开。
   * @param id 会话号。
   * @param raw { reason? }：不写是“HTTP”。
   */
  private stop(id: string, raw: unknown): Record<string, unknown> {
    //M 读取目标会话与请求原因，为停止动作准备参数。
    const session = this.open(id);
    const reason = utils.getStringField(raw, 'reason') || 'HTTP';
    if (session.row.state !== 'running') {
      //G 已经不在运行的会话只交回当前状态，无需触发停止。
      return { id, stopped: false, status: timelineModule.getStatus(session.row.state), reason: '会话没在跑' };
    }

    //M 以请求中的原因停止正在运行的会话。
    session.stop(reason);
    //M stop() 里改了状态；TypeScript 以为上面查过就还是 running，这里按普通字符串再看一次。
    const stopped = (session.row.state as string) === 'stopped';
    const result = { id, stopped, status: timelineModule.getStatus(session.row.state) };

    //G 记录上是在转，这个进程里却没有在转的循环（上次没跑完、重启后还没接着跑）→ 没停下，说清楚。
    if (stopped) return result;

    return { ...result, reason: '会话记录是在转，但这个进程里没有在跑的循环' };
  }

  /** GET /api/bots：机器人列表，状态按“等确认 → 干活 → 闲着”；queued 固定为 0。 */
  private async botList(): Promise<Record<string, unknown>[]> {
    const request = { action: 'list' } as const;
    //M 查待确认列表算机器人状态，查询不可用时仍返回机器人和运行数。
    const listed = await requestEventModule.requestEvent(
      this.ctx, 'approval/request', 'approval/result', request,
    );
    const pending = listed.reply?.items ?? [];

    //M 为每个机器人汇总审核项与运行会话，计算网页显示的状态。
    const bots = botUtils.getBotConfigs(this.ctx.resources.raw);
    return bots.map((bot) => {
      //M 干活中的后台子会话也算（有 parent，不出现在会话下拉里，但机器人应显示在干活）。
      const running = this.ctx.sessions.find({ bot: bot.name, state: 'running' }).length;
      const waiting = pending.filter((item) => (
        item.bot === bot.name && item.session !== undefined && item.session !== ''
      ));
      const approvals = waiting.length;
      let status = 'idle';
      if (running > 0) {
        status = 'working';
      }
      if (approvals > 0) {
        status = 'waiting';
      }

      //M 在机器人没有设置语言时给网页默认语言。
      const language = botUtils.getBotLanguage(this.ctx.resources.raw, bot.name);
      return { name: bot.name, language, status, running, queued: 0, approvals };
    });
  }

  /**
   * GET /api/ui/bots/:name：一个机器人的目录、工作区、记忆概要（web/src/Api.ts:438-449 的 BotInfo）。
   * @param botName 机器人名。
   * @throws Failure(404)：没有这个机器人。
   */
  private botInfo(botName: string): Record<string, unknown> {
    //G 机器人不存在时用 404 结束详情查询。
    const bot = botUtils.getBotConfig(this.ctx.resources.raw, botName);
    if (bot === undefined) throw new failureModule.Failure(404, `没有这个机器人：${botName}`);

    const memory = botUtils.getBotDir(this.ctx.resources, botName, 'memory');
    const workspace = botUtils.getBotDir(this.ctx.resources, botName, 'workspace');
    const index = ['索引.md', 'index.md'].map((file) => path.join(memory, file)).find((file) => fs.existsSync(file));
    let memoryIndex = '';
    if (index !== undefined) {
      memoryIndex = fs.readFileSync(index, 'utf8');
    }

    //M 为详情页提供机器人的语言、目录和记忆入口。
    const language = botUtils.getBotLanguage(this.ctx.resources.raw, bot.name);
    return {
      name: bot.name,
      language,
      paths: {
        botDir: path.join(this.ctx.resources.root, 'bots', bot.name),
        messageDir: path.join(workspace, 'inbox'),
        workspaceRoot: workspace,
        memoryDir: memory,
      },
      workspaces: [{ name: 'workspace', description: '机器人的工作区：工具在这里读写文件，收到的附件在 inbox/ 下', dir: workspace }],
      memoryIndex,
    };
  }

  /**
   * GET /api/messages/:id/trace?reply=N：一句回话的追溯。
   * @param id 消息号。
   * @param reply 回话下标，从 0 起。
   * @throws Failure：reply 不是非负整数 400；消息不在、下标越界 404。
   */
  private async trace(id: string, reply: string | undefined): Promise<Record<string, unknown>> {
    //G 回话下标必须是非负整数，才能定位要追溯的回话。
    if (reply === undefined || !/^\d+$/u.test(reply)) throw new failureModule.Failure(400, 'reply 要是非负整数（回话下标，从 0 起）');

    //G 先找相应的收件记录，消息不存在时返回 404。
    const message = this.timeline.get(Number(id));
    if (message === undefined) throw new failureModule.Failure(404, `没有这条消息：${id}`);

    //M 取目标回复所关联会话的标题，合并收件关联信息生成追溯结果。
    const replyIndex = Number(reply);
    const sessionId = message.replies[replyIndex]?.sessionId;
    let sessionTitle: string | null = null;
    if (sessionId !== undefined) {
      const meta = this.ctx.sessions.find({ id: sessionId })[0];
      if (meta !== undefined) {
        sessionTitle = timelineModule.title(meta);
      }
    }

    //M 保留回复与原消息的关联，等流水和用量补齐追溯结果。
    const association = this.timeline.association(message.id);
    const input = { message, replyIndex, sessionTitle, association };
    return traceModule.trace(this.ctx, input);
  }
}


/**
 * 正在跑的会话标题：有总结用总结；没有就写成「前台 会话 <号>」或「后台 会话 <号>」。
 * @param meta 会话记录。
 */
function runningTitle(meta: SessionMeta): string {
  //M 先取得常规会话标题，只给无总结时的回退标题加前台或后台标识。
  const raw = timelineModule.title(meta);
  if (!raw.startsWith('会话 ')) return raw;
  if (meta.kind === 'front') return `前台 ${raw}`;

  return `后台 ${raw}`;
}


/**
 * 客户号写成短标签：网页、飞书、飞书群、微信，或渠道名。
 * @param customer 渠道:用户；没有是空串。
 */
function customerLabel(customer: string): string {
  if (customer === '') return '';
  if (customer.startsWith('http:')) return '网页';
  if (customer.startsWith('feishu:group:')) return '飞书群';
  if (customer.startsWith('feishu:')) return '飞书';
  if (customer.startsWith('wechat:')) return '微信';
  const cut = customer.indexOf(':');
  if (cut <= 0) return customer;

  return customer.slice(0, cut);
}


/**
 * 本轮开始时间：最近一条用户消息的时刻（后台就是这次交办的那句）；没有就用 updatedAt。
 * @param session 正在跑的会话（内存里就有）。
 * @param fallback 找不到用户消息时用。
 */
function runStartedAt(session: Session, fallback: number): number {
  const messages = session.row.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item !== undefined && item.role === 'user') {
      if (typeof item.timestamp === 'number') return item.timestamp;

      return fallback;
    }
  }
  return fallback;
}


/** assist 待办一行的外形。 */
interface TodoItem { text?: unknown; status?: unknown }

/**
 * 这场会话最新一份待办里，正在做的那一项；没有待办或表不存在就返回空。
 * @param db 运行时库。
 * @param sessionId 会话号。
 */
function assistDoing(db: unknown, sessionId: string): string {
  try {
    const sqlite = db as { query: (sql: string) => { get: (...values: string[]) => unknown } };
    //M 读取该会话最新一次保存的待办，供运行卡片推断当前动作。
    const sql = "SELECT data FROM assist_items WHERE kind = 'todo' AND session_id = ? ORDER BY id DESC LIMIT 1";
    const row = sqlite.query(sql).get(sessionId) as { data: string } | null;
    if (row === null || row === undefined) return '';
    const parsed = JSON.parse(row.data) as { items?: TodoItem[] };
    const items = parsed.items ?? [];
    //M 优先显示正在做的待办，没有时预览第一条待做事项。
    const hasText = (item: TodoItem): boolean => typeof item.text === 'string' && item.text.trim() !== '';
    const doing = items.find((item) => item.status === 'doing' && hasText(item));
    const todo = items.find((item) => item.status === 'todo' && hasText(item));
    const text = doing?.text ?? todo?.text;
    if (typeof text !== 'string') return '';

    return text.trim().slice(0, 80);
  } catch {
    return '';
  }
}


/**
 * 从对话里推最新进度：正在调哪个工具、在想下一步、在写回答；看不出来就写前台/后台处理中。
 * @param session 正在跑的会话。
 * @param kind front 或 work。
 */
function latestAction(session: Session, kind: string): string {
  const messages = session.row.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item === undefined) continue;
    if (item.role === 'toolResult') return '在想下一步';
    if (item.role === 'assistant' && Array.isArray(item.content)) {
      //M 从最新的模型消息中找工具调用，给运行列表显示工具名。
      const blocks = item.content as { type?: unknown; name?: unknown }[];
      const call = blocks.find((block) => block !== null && typeof block === 'object' && block.type === 'toolCall');
      if (typeof call?.name === 'string' && call.name !== '') return `正在调用 ${call.name}`;
      return '在写回答';
    }
  }
  if (kind === 'front') return '前台处理中';

  return '后台运行中';
}
