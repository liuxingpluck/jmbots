/**
 * HTTP 渠道（docs/10 6.14）：一律监听 0.0.0.0。9 个接口：
 *   POST /api/message         {text, bot?, from?, images?, session?} → {id}
 *                             bot 不写给第一个机器人；from 是来源（合批用）
 *   GET  /api/messages/:id    这条消息的状态、进了哪个会话、分派记录、回复
 *   GET  /api/sessions        ?bot=&workspace= 会话列表（带模型、已用 / 最大上下文）
 *   GET  /api/sessions/:id    一个会话：信息 + 给人看的 md
 *   GET  /api/bots            机器人：名字、语言、合批等多久
 *   PUT  /api/bots/:name      {merge_ms} 改这个机器人的合批等待，写进 机器人.yaml，马上生效
 *   GET  /api/approvals       还在等确认的命令
 *   POST /api/approvals/:id   {approve: true/false} 同意或拒绝一条待确认
 *   GET  /api/health          健康检查（看门狗、换版本用）
 * 外部 AI 的任务通道（capabilities/AgentTasks.ts，docs/界面/05_外部AI任务通道.md）：
 *   GET  /api/agents/guide                     接入说明（Markdown，给外部 AI 看）
 *   GET  /api/agents                           登记过的外部 AI
 *   POST /api/agents/:name/hello               {description} 打招呼、登记会做什么
 *   GET  /api/agents/:name/tasks?status=new    它的任务（附件带下载地址）；顺便记下它来过
 *   POST /api/agents/:name/tasks/:id/take      认领；已经被领了回 409
 *   GET  /api/agents/:name/tasks/:id/files/*   下载附件
 *   POST /api/agents/:name/tasks/:id/result    {ok, text, uploads} 交回结果，作为一条消息送回派活的会话
 * 访问令牌（capabilities/Tokens.ts，docs/界面/05_外部AI任务通道.md 第 3 节），只许本机管：
 *   GET /api/tokens、POST /api/tokens {name, minutes?}、POST /api/tokens/:id/refresh、DELETE /api/tokens/:id
 * 网页要的接口和网页托管在 HttpUi.ts（docs/界面/01_界面设计.md 第 12 节），HttpApp.build 最后注册。
 * 认证：只有本机来的不查（用户 11-06 原话第 66 节；0.3.5 起局域网也要带）；
 * 别的地址来的，有令牌（Tokens.ts 的，加上 config 的 http.token、环境变量 JMBOTS_TOKEN）时要带一个有效的：
 * 网址后面加 ?token=xxx，或请求头 Authorization: Bearer xxx。
 * 健康检查、接入说明、网页本身不用带。
 * HTTP 不会主动推消息：回复记在收件的 replies 里，来问 /api/messages/:id 就看得到。
 */
import * as fastify from 'fastify';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as agentTasks from '../capabilities/AgentTasks.ts';
import * as tokensModule from '../capabilities/Tokens.ts';
import * as tools from '../capabilities/tools/Tools.ts';
import * as runsModule from '../executors/Runs.ts';
import * as checks from '../utils/Checks.ts';
import * as debug from '../utils/Debug.ts';
import * as utils from '../utils/Utils.ts';
import type * as botLoopModule from '../bots/BotLoop.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import type * as depsModule from '../capabilities/Deps.ts';
import type * as eventsModule from '../capabilities/Events.ts';
import type * as filesModule from '../capabilities/Files.ts';
import type * as model from '../capabilities/Model.ts';
import type * as progressModule from '../capabilities/Progress.ts';
import type * as secretsModule from '../capabilities/Secrets.ts';
import type * as storeModule from '../capabilities/Store.ts';
import type * as resourcesModule from '../resources/Resources.ts';
import type * as channelModule from './Channel.ts';
import * as httpLearn from './HttpLearn.ts';
import * as httpDesktop from './HttpDesktop.ts';
import * as httpUi from './HttpUi.ts';


/** GET /api/runs 默认列几条。 */
const RUNS_LIST_DEFAULT = 20;

/** GET /api/runs 最多列几条。 */
const RUNS_LIST_MAX = 200;

/** GET /api/runs/:id?wait= 最多等几秒（再长了中间的代理、客户端容易断）。 */
const RUN_WAIT_MAX_SEC = 120;

/** GET /api/usage 不给 from 时看最近几天。 */
const USAGE_DEFAULT_DAYS = 7;

/** GET /api/events 默认取几条。 */
const EVENTS_LIST_DEFAULT = 200;

/** GET /api/events 最多取几条。 */
const EVENTS_LIST_MAX = 1000;

/** 合批等待能设的最大值，毫秒。 */
const MAX_MERGE_MS = 60_000;


/**
 * HTTP 这一层要用的对象：入口 src/entries/App.ts 建好，经 ChannelHub.start 交给 HttpChannel，
 * 再交给 HttpApp、UiRoutes、LearnRoutes；测试用 tests/Builders.ts 的 httpPartsOf 建。
 * 一个接口一个私有方法，各方法用到的不一样，合成这一包；只放 HTTP 真用到的。
 */
export interface HttpParts {
  /** 资源：配置、机器人、提示词（只读）。 */
  resources: resourcesModule.Resources;
  /** 数据库：收件表和会话表。 */
  store: storeModule.Store;
  /** 文件库：机器人文件夹里的文件、技能。 */
  files: filesModule.Files;
  /** 模型库（设置页列模型、记忆页用）。 */
  ai: model.Ai;
  /** 密钥替身（学习界面回放时把密钥换成替身）。 */
  secrets: secretsModule.Secrets;
  /** 待确认（审核卡片）。 */
  approvals: approvalsModule.Approvals;
  /** 进度卡片（src/capabilities/Progress.ts）；测试里可以不给。 */
  progress?: progressModule.Progress;
  /** 往渠道发东西：渠道中心 ChannelHub（src/channels/index.ts）。 */
  out: depsModule.Outlet;
  /**
   * 机器人循环（src/bots/BotLoop.ts 的 BotLoop）：路由里直接调它的 receive，F12 能跳过去。
   * 用 Pick 只是为了测试能传假的。
   */
  botLoop: Pick<botLoopModule.BotLoop, 'receive' | 'start'>;
  /** 外部 AI 的任务通道（src/capabilities/AgentTasks.ts）：/api/agents/* 用。 */
  agentTaskChannel: agentTasks.AgentTaskChannel;
  /** 命令窗口（src/executors/Runs.ts）：/api/run* 用。 */
  runs: runsModule.Runs;
  /** 工具库（src/capabilities/tools/Tools.ts 的 ToolBox）：列会话用。 */
  toolBox: tools.ToolBox;
  /** 事件总线（src/capabilities/Events.ts 的 EventBus）：/api/events 查事件、取一整串；测试里可以不给。 */
  events?: eventsModule.EventBus;
}


/**
 * 是不是本机来的（127.x、::1）：只有本机不用带 token，也只有本机能管令牌。
 * @param ip 来源地址。
 */
function isLoopback(ip: string): boolean {
  /** 去掉 IPv6 包着的 IPv4 前缀。 */
  const address = ip.replace(/^::ffff:/i, '').toLowerCase();
  return address === '::1' || address.startsWith('127.');
}


/**
 * 不带 token 也能拿的：健康检查、接入说明、网页本身（没有密钥，外部 AI 接入前就得看到）。
 * 运行时文件 /files/ 和别的 /api/ 都要带。
 * @param url 请求的地址。
 */
function isOpenPath(url: string): boolean {
  /** 去掉查询参数的路径。 */
  const route = url.split('?')[0] ?? '';
  return (
    route === '/api/health' ||
    route === '/api/agents/guide' ||
    (!route.startsWith('/api/') && !route.startsWith('/files/'))
  );
}


/**
 * 一条收件给出去的样子。
 * @param row 收件。
 */
function messageView(row: storeModule.MessageRow): Record<string, unknown> {
  return {
    id: row.id,
    bot: row.bot,
    channel: row.channel,
    source: row.source,
    text: row.text,
    status: row.status,
    sessionId: row.sessionId,
    file: row.file,
    dispatch: row.dispatch,
    replies: row.replies,
    createdAt: row.createdAt,
  };
}


/** 只带 :id 路径参数的请求。 */
type IdRequest = fastify.FastifyRequest<{ Params: { id: string } }>;

/** 带 :name 路径参数的请求。 */
type NameRequest = fastify.FastifyRequest<{ Params: { name: string } }>;

/** 带 :name、:id 路径参数的请求（外部 AI 的任务）。 */
type TaskRequest = fastify.FastifyRequest<{ Params: { name: string; id: string } }>;


/**
 * HTTP 服务（不监听端口）：建 Fastify、挂认证钩子、注册所有路由。
 * 每个路由的处理函数是一个私有方法，调试时在方法里下断点，
 * 变量面板点开 this 能看到所有依赖；注册处写箭头函数包一层，F12 能跳到处理函数。
 * 建它的地方：HttpChannel.start（src/channels/Http.ts），测试直接 new。
 */
export class HttpApp {
  /** 访问令牌（config 的 http.token、环境变量 JMBOTS_TOKEN 当成永久的一起认）。 */
  private readonly tokens: tokensModule.TokenStore;

  /**
   * @param parts HTTP 要用的对象（见 HttpParts，入口 src/entries/App.ts 建的）。
   */
  constructor(private readonly parts: HttpParts) {
    //M 令牌表：config 的 token 和环境变量的当成永久令牌。
    this.tokens = new tokensModule.TokenStore(parts.resources.dir, [
      parts.resources.getHttp().token,
      process.env.JMBOTS_TOKEN ?? '',
    ]);
  }

  /**
   * 建 HTTP 服务（不监听端口）。
   * @returns Fastify 实例。
   */
  build(): fastify.FastifyInstance {
    //M 建 Fastify，先挂认证钩子，再按组注册路由。
    /** Fastify。 */
    const app = fastify.default({ logger: false, bodyLimit: 50 * 1024 * 1024 });
    this.registerAuth(app);
    this.registerTokens(app);
    this.registerHealth(app);
    this.registerAgents(app);
    this.registerRuns(app);
    this.registerEvents(app);
    app.get<{ Querystring: { by?: string; group?: string; from?: string; to?: string } }>(
      '/api/usage',
      (request, reply) => this.getUsage(request, reply),
    );
    this.registerMessages(app);
    this.registerBots(app);
    new httpLearn.LearnRoutes(this.parts).register(app);
    httpDesktop.DesktopRoutes.fromProgram(this.parts.resources.getPaths().program).register(app);
    new httpUi.UiRoutes(this.parts).register(app);
    return app;
  }


  /**
   * 每个请求先认证。
   * @param app Fastify 实例。
   */
  private registerAuth(app: fastify.FastifyInstance): void {
    //G 每个请求先认证：不用带的来源、不用带的路径放行；
    //G 一个令牌都没有时不查（和原来“配了 token 才查”一样）；别的要带一个有效的。
    app.addHook('onRequest', (request, reply) => this.authenticate(request, reply));
  }

  /**
   * 认证钩子：本机、公开路径、没有令牌时放行；别的要带一个有效令牌，否则回 401。
   * @param request 请求。
   * @param reply 回应。
   * @returns 放行是 undefined；拦下是 reply。
   */
  private async authenticate(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply | undefined> {
    if (isLoopback(request.ip) || isOpenPath(request.url) || !this.tokens.hasAny()) {
      return undefined;
    }
    /** 网址里的 token。 */
    const queryToken = (request.query as { token?: unknown } | undefined)?.token;
    /** 请求头里的 token。 */
    const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    /** 网址里的 token 有效吗。 */
    const queryOk = this.tokens.check(typeof queryToken === 'string' ? queryToken : '');
    if (!queryOk && !this.tokens.check(headerToken)) {
      //G 先 await 掉 send、再 return reply，Fastify 才停下、不往下跑路由
      //G （不然没带对 token 的请求也会被处理）。
      //G 11-06 周小灵在 Windows（Bun 1.3.14）上实测：
      //G 只写 return reply.code(401).send(...) 拦不住；
      //G 虚拟机 Bun 1.4.4 上几种写法都拦得住，这种两边都行。
      await reply.code(401).send({
        error:
          '需要 token：网址后面加 ?token=xxx，或请求头 Authorization: Bearer xxx；' +
          'token 问用户要（设置页“访问令牌”里建）',
      });
      return reply;
    }
    return undefined;
  }


  /**
   * 令牌的四个接口，只许本机管：局域网带着令牌也不行，免得临时令牌给自己换出永久的。
   * @param app Fastify 实例。
   */
  private registerTokens(app: fastify.FastifyInstance): void {
    app.get('/api/tokens', (request, reply) => this.listTokens(request, reply));
    app.post('/api/tokens', (request, reply) => this.createToken(request, reply));
    app.post<{ Params: { id: string } }>(
      '/api/tokens/:id/refresh',
      (request, reply) => this.refreshToken(request, reply),
    );
    app.delete<{ Params: { id: string } }>(
      '/api/tokens/:id',
      (request, reply) => this.removeToken(request, reply),
    );
  }

  /**
   * 不是本机来的就回 403。
   * @param ip 来源。
   * @param reply 回应。
   * @returns 是本机就是 true。
   */
  private async localOnly(ip: string, reply: fastify.FastifyReply): Promise<boolean> {
    if (isLoopback(ip)) {
      return true;
    }
    await reply.code(403).send({ error: '令牌只能在本机的设置页管' });
    return false;
  }

  /** GET /api/tokens：列令牌。 */
  private async listTokens(request: fastify.FastifyRequest, reply: fastify.FastifyReply) {
    return (await this.localOnly(request.ip, reply)) ? this.tokens.list() : reply;
  }

  /** POST /api/tokens {name, minutes?}：建令牌。 */
  private async createToken(request: fastify.FastifyRequest, reply: fastify.FastifyReply) {
    if (!(await this.localOnly(request.ip, reply))) {
      return reply;
    }
    try {
      /** 请求体。 */
      const body = (request.body ?? {}) as { name?: unknown; minutes?: unknown };
      /** 令牌名字。 */
      const name = checks.requireString(body.name, 'name');
      /** 有效分钟数；不写、null、0 都是永久（undefined）。 */
      const minutes =
        body.minutes === undefined || body.minutes === null || body.minutes === 0
          ? undefined
          : Number(body.minutes);
      return this.tokens.create(name, minutes);
    } catch (error) {
      return reply.code(400).send({ error: utils.errorText(error) });
    }
  }

  /** POST /api/tokens/:id/refresh：刷新令牌有效期。 */
  private async refreshToken(request: IdRequest, reply: fastify.FastifyReply) {
    if (!(await this.localOnly(request.ip, reply))) {
      return reply;
    }
    try {
      return this.tokens.refresh(request.params.id);
    } catch (error) {
      return reply.code(404).send({ error: utils.errorText(error) });
    }
  }

  /** DELETE /api/tokens/:id：删令牌。 */
  private async removeToken(request: IdRequest, reply: fastify.FastifyReply) {
    if (!(await this.localOnly(request.ip, reply))) {
      return reply;
    }
    try {
      this.tokens.remove(request.params.id);
      return { ok: true };
    } catch (error) {
      return reply.code(404).send({ error: utils.errorText(error) });
    }
  }


  /**
   * 健康检查。
   * @param app Fastify 实例。
   */
  private registerHealth(app: fastify.FastifyInstance): void {
    app.get('/api/health', () => this.getHealth());
  }

  /** GET /api/health：健康检查（看门狗、换版本用）。 */
  private getHealth() {
    return { ok: true, problems: this.parts.resources.problems() };
  }


  /**
   * 外部 AI 的任务通道：外部 AI 自己来领活、交结果，
   * jmbots 不去操控它（用户 11-06 原话第 63 节）。
   * @param app Fastify 实例。
   */
  private registerAgents(app: fastify.FastifyInstance): void {
    app.get('/api/agents/guide', (_request, reply) => this.getAgentsGuide(reply));
    app.get('/api/agents', () => this.listAgents());
    app.post<{ Params: { name: string } }>(
      '/api/agents/:name/hello',
      (request, reply) => this.agentHello(request, reply),
    );
    app.get<{ Params: { name: string }; Querystring: { status?: string } }>(
      '/api/agents/:name/tasks',
      (request, reply) => this.listAgentTasks(request, reply),
    );
    app.post<{ Params: { name: string; id: string } }>(
      '/api/agents/:name/tasks/:id/take',
      (request, reply) => this.takeAgentTask(request, reply),
    );
    app.get<{ Params: { name: string; id: string; '*': string } }>(
      '/api/agents/:name/tasks/:id/files/*',
      (request, reply) => this.downloadAgentFile(request, reply),
    );
    app.post<{ Params: { name: string; id: string } }>(
      '/api/agents/:name/tasks/:id/result',
      (request, reply) => this.finishAgentTask(request, reply),
    );
  }

  /** GET /api/agents/guide：接入说明（Markdown，给外部 AI 看）。 */
  private getAgentsGuide(reply: fastify.FastifyReply) {
    return reply.type('text/markdown; charset=utf-8').send(agentTasks.GUIDE);
  }

  /** GET /api/agents：登记过的外部 AI。 */
  private listAgents() {
    return this.parts.agentTaskChannel.listAgents();
  }

  /** POST /api/agents/:name/hello {description}：打招呼、登记会做什么。 */
  private async agentHello(request: NameRequest, reply: fastify.FastifyReply) {
    try {
      /** 请求体。 */
      const body = (request.body ?? {}) as { description?: unknown };
      /** 它会做什么的说明。 */
      const description = checks.optionalString(body.description, 'description') ?? '';
      return await this.parts.agentTaskChannel.hello(request.params.name, description);
    } catch (error) {
      return reply.code(400).send({ error: utils.errorText(error) });
    }
  }

  /** GET /api/agents/:name/tasks?status=：它的任务（附件带下载地址）；顺便记下它来过。 */
  private async listAgentTasks(
    request: fastify.FastifyRequest<{
      Params: { name: string };
      Querystring: { status?: string };
    }>,
    reply: fastify.FastifyReply,
  ) {
    try {
      /** 只要哪种状态的。 */
      const status = request.query.status as agentTasks.AgentTaskStatus | undefined;
      /** 任务。 */
      const tasks = await this.parts.agentTaskChannel.listTasks(request.params.name, status, true);
      return tasks.map((task) => ({
        ...task,
        files: task.files.map((name) => ({
          name,
          url: `/api/agents/${encodeURIComponent(task.agent)}/tasks/${task.id}` +
            `/files/${encodeURIComponent(name)}`,
        })),
      }));
    } catch (error) {
      return reply.code(400).send({ error: utils.errorText(error) });
    }
  }

  /** POST /api/agents/:name/tasks/:id/take：认领；已经被领了回 409。 */
  private async takeAgentTask(request: TaskRequest, reply: fastify.FastifyReply) {
    try {
      return await this.parts.agentTaskChannel.takeTask(request.params.name, request.params.id);
    } catch (error) {
      /** 原因。 */
      const reason = utils.errorText(error);
      return reply.code(reason.includes('已经') ? 409 : 404).send({ error: reason });
    }
  }

  /** GET /api/agents/:name/tasks/:id/files/*：下载附件。 */
  private async downloadAgentFile(
    request: fastify.FastifyRequest<{
      Params: { name: string; id: string; '*': string };
    }>,
    reply: fastify.FastifyReply,
  ) {
    try {
      /** 文件。 */
      const file = this.parts.agentTaskChannel.taskFile(
        request.params.name,
        request.params.id,
        request.params['*'],
      );
      await fs.access(file);
      /** 下载时的文件名头。 */
      const disposition =
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
      return await reply
        .header('content-disposition', disposition)
        .type('application/octet-stream')
        .send(fsSync.createReadStream(file));
    } catch (error) {
      return reply.code(404).send({ error: utils.errorText(error) });
    }
  }

  /** POST /api/agents/:name/tasks/:id/result {ok, text, uploads}：交回结果，送回派活的会话。 */
  private async finishAgentTask(request: TaskRequest, reply: fastify.FastifyReply) {
    try {
      /** 请求体。 */
      const body = (request.body ?? {}) as { ok?: unknown; text?: unknown; uploads?: unknown };
      /** 交回的文件（先 PUT /api/uploads/:name 传上来的）。 */
      const files = await httpUi.takeUploads(this.parts, body.uploads);
      /** 交回的结果。 */
      const result = {
        ok: body.ok !== false,
        text: checks.optionalString(body.text, 'text') ?? '',
        files,
      };
      /** 交回以后的任务。 */
      const task = await this.parts.agentTaskChannel.finishTask(
        request.params.name,
        request.params.id,
        result,
      );
      //M 结果作为一条消息送回派活的会话（没有会话就给那个机器人），机器人接着干。
      /** 送回去的入参（交给 botLoop.receive，实现见 constructor 的 JSDoc）。 */
      const resultArgs = {
        bot: task.bot,
        channel: 'http',
        source: task.agent,
        address: {},
        text: agentTasks.resultMessage(task),
        images: files,
        ...(task.sessionId ? { session: task.sessionId } : {}),
      };
      /** 送回的消息。 */
      const row = await this.parts.botLoop.receive(resultArgs);
      this.parts.events?.emit('agent.delivered', {
        messageIds: [row.id],
        taskId: task.id,
        agent: task.agent,
        targetSession: task.sessionId ?? row.sessionId,
        queuedAt: task.createdAt,
        takenAt: task.takenAt ?? null,
        receivedAt: task.doneAt ?? null,
        deliveredAt: Date.now(),
        executionStartedAt: null,
        chars: task.result?.text.length ?? 0,
        files: task.result?.files.length ?? 0,
      }, {
        source: 'Http',
        bot: task.bot,
        sessionId: task.sessionId,
        messageId: row.id,
      });
      return { ok: true, task, message: row.id };
    } catch (error) {
      return reply.code(400).send({ error: utils.errorText(error) });
    }
  }


  /**
   * 事件（docs/11 第 6.7 节）：查事件、取一条事件的整串（回看一条消息、一次运行的全过程）。
   * @param app Fastify 实例。
   */
  private registerEvents(app: fastify.FastifyInstance): void {
    app.get<{ Querystring: { type?: string; session?: string; since?: string; limit?: string } }>(
      '/api/events',
      (request, reply) => this.listEvents(request, reply),
    );
    app.get<{ Params: { id: string } }>(
      '/api/events/:id/chain',
      (request, reply) => this.eventChain(request, reply),
    );
  }

  /**
   * GET /api/usage?by=hour|day|week|month&group=provider|model|purpose|bot&from=&to=（docs/15 第 3 节）：
   * 默认按天、按模型、最近 7 天；每行另算命中率 cacheRead / (input + cacheRead)，另给合计。
   */
  private getUsage(
    request: fastify.FastifyRequest<{ Querystring: { by?: string; group?: string; from?: string; to?: string } }>,
    reply: fastify.FastifyReply,
  ) {
    /** 按什么时间段。 */
    const by = request.query.by ?? 'day';
    /** 按什么分组。 */
    const group = request.query.group ?? 'model';
    if (!['hour', 'day', 'week', 'month'].includes(by) || !['provider', 'model', 'purpose', 'bot'].includes(group)) {
      return reply.code(400).send({ error: 'by 要是 hour、day、week、month；group 要是 provider、model、purpose、bot' });
    }
    /** 到什么时候。 */
    const to = Number(request.query.to) || Date.now();
    /** 从什么时候。 */
    const from = Number(request.query.from) || to - USAGE_DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    /** 查询条件。 */
    const query: storeModule.UsageQuery = {
      by: by as storeModule.UsageQuery['by'],
      group: group as storeModule.UsageQuery['group'],
      from,
      to,
    };
    /** 每个时间段、每个分组一行。 */
    const rows = this.parts.store.usageReport(query);
    /** 命中率。 */
    const hitRate = (row: { input: number; cacheRead: number }): number => {
      /** 分母。 */
      const total = row.input + row.cacheRead;
      return total > 0 ? row.cacheRead / total : 0;
    };
    /** 全部加起来。 */
    const totals = rows.reduce(
      (sum, row) => ({
        calls: sum.calls + row.calls,
        failures: sum.failures + row.failures,
        input: sum.input + row.input,
        output: sum.output + row.output,
        cacheRead: sum.cacheRead + row.cacheRead,
        cacheWrite: sum.cacheWrite + row.cacheWrite,
        cost: sum.cost + row.cost,
        ms: sum.ms + row.ms,
      }),
      { calls: 0, failures: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ms: 0 },
    );
    return {
      by,
      group,
      from,
      to,
      rows: rows.map((row) => ({ ...row, hitRate: hitRate(row) })),
      totals: { ...totals, hitRate: hitRate(totals) },
    };
  }

  /** GET /api/events?type=&session=&since=&limit=：最新的 limit 条（默认 200，最多 1000），按号从小到大。 */
  private listEvents(
    request: fastify.FastifyRequest<{ Querystring: { type?: string; session?: string; since?: string; limit?: string } }>,
    reply: fastify.FastifyReply,
  ) {
    if (!this.parts.events) {
      return reply.code(503).send({ error: '事件总线没开' });
    }
    /** 条件。 */
    const query = {
      type: request.query.type || undefined,
      sessionId: request.query.session || undefined,
      since: request.query.since ? Number(request.query.since) : undefined,
      limit: Math.min(Number(request.query.limit) || EVENTS_LIST_DEFAULT, EVENTS_LIST_MAX),
    };
    return this.parts.events.list(query);
  }

  /** GET /api/events/:id/chain：这条事件往上往下的整串。 */
  private eventChain(request: fastify.FastifyRequest<{ Params: { id: string } }>, reply: fastify.FastifyReply) {
    if (!this.parts.events) {
      return reply.code(503).send({ error: '事件总线没开' });
    }
    /** 整串。 */
    const chain = this.parts.events.chain(Number(request.params.id));
    return chain.length > 0 ? chain : reply.code(404).send({ error: `没有这条事件：${request.params.id}` });
  }

  /**
   * 命令窗口（docs/界面/08_命令窗口.md 第 1 节）：
   * 外面的 AI 直接让 jmbots 跑命令，不开会话、不经过大模型；审核在 Runs.start 里。
   * @param app Fastify 实例。
   */
  private registerRuns(app: fastify.FastifyInstance): void {
    app.post('/api/run', (request, reply) => this.startRun(request, reply));
    app.get<{ Querystring: { limit?: string } }>(
      '/api/runs',
      (request) => this.listRuns(request),
    );
    app.get<{ Params: { id: string }; Querystring: { wait?: string } }>(
      '/api/runs/:id',
      (request, reply) => this.getRun(request, reply),
    );
    app.get<{ Params: { id: string } }>(
      '/api/runs/:id/log',
      (request, reply) => this.getRunLog(request, reply),
    );
    app.post<{ Params: { id: string } }>(
      '/api/runs/:id/stop',
      (request, reply) => this.stopRun(request, reply),
    );
  }

  /** POST /api/run：跑一条命令（审核在 Runs.start 里）。 */
  private async startRun(request: fastify.FastifyRequest, reply: fastify.FastifyReply) {
    try {
      /** HTTP 输入在此一次完成校验和默认值处理。 */
      const input = checks.readRunInput(request.body, this.parts.resources.dir);
      return await this.parts.runs.start(input);
    } catch (error) {
      return reply.code(400).send({ error: utils.errorText(error) });
    }
  }

  /** GET /api/runs?limit=：最近的命令。 */
  private listRuns(request: fastify.FastifyRequest<{ Querystring: { limit?: string } }>) {
    /** 要列几条。 */
    const limit = Math.min(Number(request.query.limit) || RUNS_LIST_DEFAULT, RUNS_LIST_MAX);
    return this.parts.runs.list(limit);
  }

  /** GET /api/runs/:id?wait=：一条命令的状态，可以等它跑完。 */
  private async getRun(
    request: fastify.FastifyRequest<{ Params: { id: string }; Querystring: { wait?: string } }>,
    reply: fastify.FastifyReply,
  ) {
    /** 最多等几秒。 */
    const waitSec = Math.min(Math.max(Number(request.query.wait) || 0, 0), RUN_WAIT_MAX_SEC);
    /** 记录。 */
    const record = waitSec > 0
      ? await this.parts.runs.wait(request.params.id, waitSec * 1000)
      : this.parts.runs.get(request.params.id);
    if (!record) {
      return reply.code(404).send({ error: `没有这条命令：${request.params.id}` });
    }
    return { ...record, tail: this.parts.runs.tail(record.id) };
  }

  /** GET /api/runs/:id/log：一条命令的完整输出。 */
  private getRunLog(request: IdRequest, reply: fastify.FastifyReply) {
    /** 输出文件。 */
    const file = this.parts.runs.logFile(request.params.id);
    if (!file) {
      return reply.code(404).send({ error: `没有这条命令的输出：${request.params.id}` });
    }
    return reply.type('text/plain; charset=utf-8').send(fsSync.createReadStream(file));
  }

  /** POST /api/runs/:id/stop：停掉一条命令。 */
  private stopRun(request: IdRequest, reply: fastify.FastifyReply) {
    /** 停下以后的记录。 */
    const record = this.parts.runs.stop(request.params.id);
    return record ?? reply.code(404).send({ error: `没有这条命令：${request.params.id}` });
  }


  /**
   * 收消息、查消息、查会话。
   * @param app Fastify 实例。
   */
  private registerMessages(app: fastify.FastifyInstance): void {
    app.post('/api/message', (request, reply) => this.receiveMessage(request, reply));
    app.get<{ Params: { id: string } }>(
      '/api/messages/:id',
      (request, reply) => this.getMessage(request, reply),
    );
    app.get<{ Querystring: { bot?: string; workspace?: string } }>(
      '/api/sessions',
      (request) => this.listSessions(request),
    );
    app.get<{ Params: { id: string } }>(
      '/api/sessions/:id',
      (request, reply) => this.getSession(request, reply),
    );
  }

  /** POST /api/message {text, bot?, from?, images?, uploads?, session?} → {id, file}。 */
  private async receiveMessage(request: fastify.FastifyRequest, reply: fastify.FastifyReply) {
    try {
      /** 请求体。 */
      const body = checks.asRecord(request.body ?? {}, '请求体');
      /** 指定的会话。 */
      const session = checks.optionalString(body.session, 'session');
      /** 机器人：写了用写的；指定了会话用那个会话的；都没有给第一个机器人。 */
      const bot =
        checks.optionalString(body.bot, 'bot') ??
        (session ? this.parts.store.getSession(session)?.bot : undefined) ??
        this.parts.resources.listBots()[0]?.name;
      if (!bot) {
        throw new Error('尚未启用机器人；请先在 config.yaml 的 bots 列表中添加');
      }
      this.parts.resources.getBot(bot);
      /** 图片：[{name, data(base64)}]。 */
      const images = (Array.isArray(body.images) ? body.images : []).map((item, index) => {
        /** 一张。 */
        const image = checks.asRecord(item, `images[${index}]`);
        /** 文件名；不写叫 image序号.png。 */
        const name = checks.optionalString(image.name, `images[${index}].name`) ??
          `image${index + 1}.png`;
        /** 图片内容（base64 解开）。 */
        const data = Buffer.from(
          checks.requireString(image.data, `images[${index}].data`),
          'base64',
        );
        return { name, data };
      });
      await debug.point('① HTTP 收到 POST /api/message', () => ({
        text: checks.optionalString(body.text, 'text') ?? '',
        bot,
        from: checks.optionalString(body.from, 'from') ?? 'http',
        uploads: Array.isArray(body.uploads) ? body.uploads.length : 0,
      }));
      /** 收件。 */

      //M 图片后面接上网页先传好的附件（uploads: [上传号]，HttpUi.ts）。 
      // 当我去真实调试的，我发现了 你写代码也有个问题，太喜欢把代码 放在一行，太长了，导致我都看不过，而且由于 receive 函数 本身也是传入的参数，我都没法跟踪，
      // 所以 我改成了这样
      const receiveArgs = {
        bot, channel: 'http',
        source: checks.optionalString(body.from, 'from') ?? 'http',
        address: {},
        text: checks.optionalString(body.text, 'text') ?? '',
        images: [...images, ...(await httpUi.takeUploads(this.parts, body.uploads))],
        session
      };

      //M 现在直接调 botLoop.receive（BotLoop 类的方法），按 F12 就能跳过去。
      const row = await this.parts.botLoop.receive(receiveArgs);
      return { id: row.id, file: row.file };
    } catch (error) {
      return reply.code(400).send({ error: utils.errorText(error) });
    }
  }

  /** GET /api/messages/:id：这条消息的状态、进了哪个会话、分派记录、回复。 */
  private getMessage(request: IdRequest, reply: fastify.FastifyReply) {
    /** 收件。 */
    const row = this.parts.store.getMessage(Number(request.params.id));
    return row
      ? messageView(row)
      : reply.code(404).send({ error: `没有消息 #${request.params.id}` });
  }

  /** GET /api/sessions?bot=&workspace=：会话列表（带模型、已用 / 最大上下文）。 */
  private listSessions(
    request: fastify.FastifyRequest<{ Querystring: { bot?: string; workspace?: string } }>,
  ) {
    /** 机器人。 */
    const bot = request.query.bot ?? this.parts.resources.listBots()[0]?.name;
    if (!bot) {
      return [];
    }
    return this.parts.toolBox.listSessions(bot, { workspace: request.query.workspace });
  }

  /** GET /api/sessions/:id：一个会话：信息 + 给人看的 md。 */
  private async getSession(request: IdRequest, reply: fastify.FastifyReply) {
    /** 会话。 */
    const session = this.parts.store.getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: `没有会话 ${request.params.id}` });
    }
    /** 三个文件。 */
    const files = this.parts.files.sessionFiles(session);
    /** 给人看的 md 内容；读不到当空。 */
    const md = await fs.readFile(files.md, 'utf8').catch(() => '');
    return {
      id: session.id,
      bot: session.bot,
      workspace: session.workspace,
      title: session.title,
      summary: session.summary,
      model: session.model,
      thinking: session.thinking,
      status: session.status,
      tokens: session.tokens,
      runs: session.runs,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      files,
      md,
    };
  }


  /**
   * 机器人和待确认。
   * @param app Fastify 实例。
   */
  private registerBots(app: fastify.FastifyInstance): void {
    app.get('/api/bots', () => this.listBots());
    app.put<{ Params: { name: string } }>(
      '/api/bots/:name',
      (request, reply) => this.updateBot(request, reply),
    );
    app.get('/api/approvals', () => this.listApprovals());
    app.post<{ Params: { id: string } }>(
      '/api/approvals/:id',
      (request, reply) => this.decideApproval(request, reply),
    );
  }

  /** GET /api/bots：机器人：名字、语言、合批等多久、运行状态。 */
  private listBots() {
    return this.parts.resources.listBots().map((bot) => {
      /** 单独设的。 */
      const settings = this.parts.files.readBotSettings(bot.name);
      return {
        name: bot.name,
        language: bot.language,
        mergeMs: settings.mergeMs ?? null,
        effectiveMergeMs: settings.mergeMs ?? this.parts.resources.getSetting('mergeMs'),
        ...httpUi.botStatus(this.parts, bot.name),
      };
    });
  }

  /** PUT /api/bots/:name {merge_ms}：改这个机器人的合批等待，写进 机器人.yaml，马上生效。 */
  private async updateBot(request: NameRequest, reply: fastify.FastifyReply) {
    try {
      this.parts.resources.getBot(request.params.name);
      /** 请求体。 */
      const body = checks.asRecord(request.body ?? {}, '请求体');
      /** 合批等待；null 是删掉单独设的、用回 config 的。 */
      const raw = body.merge_ms;
      if (
        raw !== null &&
        (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_MERGE_MS)
      ) {
        return reply.code(400).send({
          error: `merge_ms 要是 0～${MAX_MERGE_MS} 的整数（毫秒），或者 null`,
        });
      }
      await this.parts.files.writeBotSettings(
        request.params.name,
        { ...this.parts.files.readBotSettings(request.params.name), mergeMs: raw ?? undefined },
      );
      return {
        ok: true,
        mergeMs: raw,
        effectiveMergeMs: raw ?? this.parts.resources.getSetting('mergeMs'),
      };
    } catch (error) {
      return reply.code(400).send({ error: utils.errorText(error) });
    }
  }

  /** GET /api/approvals：还在等确认的命令。 */
  private listApprovals() {
    return this.parts.approvals.list();
  }

  /** POST /api/approvals/:id {approve}：同意或拒绝一条待确认。 */
  private decideApproval(request: IdRequest, reply: fastify.FastifyReply) {
    /** 请求体。 */
    const body = checks.asRecord(request.body ?? {}, '请求体');
    if (typeof body.approve !== 'boolean') {
      return reply.code(400).send({ error: 'approve 要是 true 或 false' });
    }
    /** 那条待确认。 */
    const decided = this.parts.approvals.decide(Number(request.params.id), body.approve, 'HTTP');
    return decided
      ? { ok: true, approval: decided }
      : reply.code(404).send({ error: `待确认 #${request.params.id} 不存在，或者已经决定过了` });
  }
}


/**
 * 端口被占着时最多等多久，毫秒：换版本时旧后端的子进程（exec 跑的命令）可能还拿着端口；
 * 基地给新版本 90 秒，这里留余量（11-06 换 0.3.3 时就是这样没换成）。
 */
const LISTEN_WAIT_MS = 80_000;

/** 端口被占着时隔多久再试，毫秒。 */
const LISTEN_RETRY_MS = 2000;


/**
 * 监听；端口被占着时隔一会儿再试，等到 LISTEN_WAIT_MS 还不行才报错。
 * @param app 服务。
 * @param port 端口。
 * @throws 别的错误马上抛；端口一直被占着，到点抛最后一次的错误。
 */
async function listenWithRetry(app: fastify.FastifyInstance, port: number): Promise<void> {
  /** 最晚等到什么时候。 */
  const deadline = Date.now() + LISTEN_WAIT_MS;
  for (; ;) {
    try {
      await app.listen({ host: '0.0.0.0', port });
      return;
    } catch (error) {
      /** 是不是端口被占着（Bun 的说法是 “Is port N in use?”）。 */
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' || /in use/i.test(utils.errorText(error));
      if (!inUse || Date.now() > deadline) {
        throw error;
      }
      console.error(
        `${utils.formatTime()} 端口 ${String(port)} 被占着，${String(LISTEN_RETRY_MS / 1000)} 秒后再试`,
      );
      await Bun.sleep(LISTEN_RETRY_MS);
    }
  }
}


/**
 * HTTP 渠道：开始时监听 0.0.0.0（端口被占着时等一会儿再试）；
 * 发消息只是记录（回复已经写进收件的 replies）。
 * 建它的地方：src/channels/index.ts 的 ChannelHub.start。
 */
export class HttpChannel implements channelModule.Channel {
  /** 渠道名。 */
  readonly name = 'http';

  /**
   * @param parts HTTP 要用的对象（见 HttpParts），转给 HttpApp。
   * @param port 端口。
   */
  constructor(
    private readonly parts: HttpParts,
    private readonly port: number,
  ) {}

  /**
   * 开始监听；返回停下的函数。
   * start 的参数（收话回调）不用了：路由直接调 botLoop.receive，
   * 不经回调，调试时能一步跳进去。
   */
  async start(): Promise<() => Promise<void>> {
    //M 建服务，监听端口（被占着会等一会儿再试）。
    /** 服务。 */
    const httpApp = new HttpApp(this.parts);
    /** Fastify 实例。 */
    const app = httpApp.build();
    await listenWithRetry(app, this.port);
    return async () => {
      await app.close();
    };
  }

  /** 发消息只是记录：回复已经写进收件的 replies。 */
  send(): Promise<void> {
    return Promise.resolve();
  }
}
