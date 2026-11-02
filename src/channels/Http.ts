/**
 * HTTP 服务（Fastify）：jmbots 首先是一个 Web 服务，飞书只是外接的一个渠道（用户 11-02 的定位）。
 *
 * 接口（都是 JSON）：
 *   GET  /api/health                    活着吗
 *   GET  /api/models                    可用模型（无状态）
 *   GET  /api/agents                    智能体（无状态）
 *   GET  /api/bots                      机器人（有状态、有记忆）
 *   GET  /api/workspaces                工作区（只是登记）
 *   GET  /api/sessions?bot=&agent=&workspace=&source=&status=&limit=   会话列表
 *   GET  /api/sessions/:id              一个会话：基本信息、每次执行、每一步
 *   GET  /api/sessions/:id/full         白盒子：一个会话的全部原始记录（事件、模型请求和回复、工具调用、待确认命令）
 *   GET  /api/sessions/:id/stream       长连接（SSE）：这个会话每次执行结束就推一条
 *   POST /api/run                       提交任务 { text, sessionId?, bot?, agent?, model?, workspace?, source?, wait? }；wait 为 true 时等做完再回；
 *                                       source 是来源（如“Claude（HTTP）”，不写是 HTTP）
 *   GET  /api/approvals                 待确认的命令
 *   POST /api/approvals/:id             确认 { decision: "approved" | "rejected", note? }
 * 其他路径交给网页托管（dist/web）。
 *
 * 认证（用户 11-02 定：这个阶段不考虑安全，全部能访问就行）：
 *   本机和局域网（10.x、172.16-31.x、192.168.x、169.254.x、IPv6 的 fc/fd/fe80）来的请求不查 token；
 *   别的地址来的请求，配了 token（config.yaml 的 http.token 或环境变量 JMBOTS_TOKEN）才查：
 *   网址后面加 ?token=xxx，或请求头 Authorization: Bearer xxx；没配 token 就也放行。
 */
import * as fastify from 'fastify';
import * as crypto from 'node:crypto';
import * as checks from '../utils/Checks.ts';
import * as webPage from './WebPage.ts';
import type * as engineModule from '../core/Engine.ts';
import type * as modelModule from '../core/Model.ts';
import type * as runtimeModule from '../core/Runtime.ts';
import type * as eventsModule from '../store/Events.ts';


/** 建 HTTP 服务要给的东西。 */
export interface HttpOptions {
  /** 运行时。 */
  runtime: runtimeModule.Runtime;

  /** 数据库（查会话、步骤）。 */
  store: eventsModule.EventStore;

  /** 引擎（提交任务、确认命令）。 */
  engine: engineModule.Engine;

  /** 模型（列模型）。 */
  ai: modelModule.Ai;

  /** 访问 token：只查本机、局域网以外来的请求；不配就都不查。 */
  token?: string;

  /** 网页打包目录；不给就不托管网页。 */
  webDir?: string;
}


/**
 * 是不是本机或局域网地址。
 * @param ip 请求方地址（IPv4 可能写成 ::ffff:192.168.1.2）。
 */
function isLocalAddress(ip: string): boolean {
  /** 去掉 IPv6 包着的 IPv4 前缀。 */
  const address = ip.replace(/^::ffff:/i, '').toLowerCase();
  if (address === '::1' || address.startsWith('127.') || address.startsWith('10.') || address.startsWith('192.168.') || address.startsWith('169.254.')) {
    return true;
  }
  //M 172.16.0.0 到 172.31.255.255。
  /** 172 段的第二节。 */
  const second = /^172\.(\d+)\./.exec(address)?.[1];
  if (second && Number(second) >= 16 && Number(second) <= 31) {
    return true;
  }
  //M IPv6 的局域网地址：fc00::/7、fe80::/10。
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(address);
}


/**
 * 比较两段文字是否相同（用固定时间比较，长度不同直接不同）。
 * @param actual 请求带的。
 * @param expected 应该是的。
 */
function sameText(actual: string, expected: string): boolean {
  /** 两边的字节。 */
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}


/**
 * 建 HTTP 服务（不监听端口，调用方 listen）。
 * @param options 运行时、数据库、引擎、模型、地址、token。
 */
export function createHttp(options: HttpOptions) {
  const { runtime, store, engine, ai } = options;
  /** Fastify 实例。 */
  const app = fastify.default({ logger: false });

  //G 每个请求先认证：本机、局域网直接放行；外面来的、配了 token 时要带对 token。
  app.addHook('onRequest', async (request, reply) => {
    if (!options.token || isLocalAddress(request.ip)) {
      return;
    }
    /** 网址里的 token。 */
    const queryToken = (request.query as { token?: unknown } | undefined)?.token;
    /** 请求头里的 token。 */
    const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!sameText(typeof queryToken === 'string' ? queryToken : '', options.token) && !sameText(headerToken ?? '', options.token)) {
      return reply.code(401).send({ error: '需要 token：网址后面加 ?token=xxx' });
    }
  });

  // ───────── 资源（无状态） ─────────
  app.get('/api/health', () => ({ ok: true, problems: runtime.problems() }));
  app.get('/api/models', () => ({ defaultModel: runtime.defaultModel, models: ai.listModels() }));
  app.get('/api/agents', () => runtime.agents.map((role) => ({ name: role.name, description: role.description, model: role.model ?? runtime.defaultModel })));
  app.get('/api/bots', () => runtime.bots.map((role) => ({ name: role.name, description: role.description, model: role.model ?? runtime.defaultModel })));
  app.get('/api/workspaces', () => runtime.listWorkspaces());

  // ───────── 会话 ─────────
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/sessions', (request) => {
    const query = request.query;
    return store.listSessions({
      bot: query.bot,
      agent: query.agent,
      workspace: query.workspace,
      source: query.source,
      status: query.status,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', (request, reply) => {
    /** 会话。 */
    const session = store.getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: '没有这个会话' });
    }
    //M 每次执行附上每一步的摘要（完整内容看日志文件或数据库）。
    return {
      session,
      events: store.listEvents(session.id).map((event) => ({
        ...event,
        steps:
          event.type === 'execution'
            ? store.listModelRequests(event.id).map((step) => ({
                step: step.step,
                actor: step.actor,
                status: step.status,
                text: (step.response as { text?: string } | null)?.text ?? '',
              }))
            : undefined,
      })),
    };
  });

  //M 白盒子：一个会话的全部原始记录（事件、每一步发给模型的请求和回复、工具调用、待确认命令），网页的“事件”页面用。
  app.get<{ Params: { id: string } }>('/api/sessions/:id/full', (request, reply) => {
    /** 会话。 */
    const session = store.getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: '没有这个会话' });
    }
    /** 全部事件。 */
    const events = store.listEvents(session.id);
    /** 每次执行的模型请求和工具调用。 */
    const executions = events
      .filter((event) => event.type === 'execution')
      .map((event) => ({ eventId: event.id, steps: store.listModelRequests(event.id), tools: store.listToolResults(event.id) }));
    return { session, events, executions, approvals: store.listApprovals(session.id), sessionDir: runtime.sessionDir(session) };
  });

  //M 长连接（SSE）：这个会话每次执行结束推一条 finished；每 15 秒发一次心跳，免得被中间的代理断开。
  app.get<{ Params: { id: string } }>('/api/sessions/:id/stream', (request, reply) => {
    if (!store.getSession(request.params.id)) {
      return reply.code(404).send({ error: '没有这个会话' });
    }
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId: request.params.id })}\n\n`);
    /** 撤销通知登记的函数。 */
    const off = engine.onFinished((finished) => {
      if (finished.sessionId === request.params.id) {
        reply.raw.write(`event: finished\ndata: ${JSON.stringify(finished)}\n\n`);
      }
    });
    /** 心跳。 */
    const timer = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.on('close', () => {
      off();
      clearInterval(timer);
    });
  });

  // ───────── 执行 ─────────
  app.post('/api/run', async (request, reply) => {
    /** 请求体。 */
    const body = checks.asRecord(request.body, '请求体');
    try {
      /** 提交结果。 */
      const submitted = engine.submit({
        input: checks.requireString(body.text, 'text'),
        source: checks.optionalString(body.source, 'source') ?? 'HTTP',
        sessionId: checks.optionalString(body.sessionId, 'sessionId'),
        bot: checks.optionalString(body.bot, 'bot'),
        agent: checks.optionalString(body.agent, 'agent'),
        model: checks.optionalString(body.model, 'model'),
        workspace: checks.optionalString(body.workspace, 'workspace'),
      });
      if (body.wait !== true) {
        return reply.code(202).send(submitted);
      }
      /** 做完后的会话。 */
      const session = await engine.waitIdle(submitted.sessionId);
      return { ...submitted, status: session.status, reply: session.lastReply };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/approvals', () => store.listPendingApprovals());

  app.post<{ Params: { id: string } }>('/api/approvals/:id', (request, reply) => {
    /** 请求体。 */
    const body = checks.asRecord(request.body, '请求体');
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return reply.code(400).send({ error: 'decision 只能是 approved 或 rejected' });
    }
    try {
      return engine.decide(Number(request.params.id), body.decision, checks.optionalString(body.note, 'note'), '网页按钮（HTTP 接口）');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ───────── 网页 ─────────
  if (options.webDir) {
    webPage.registerWebPage(app, { webDir: options.webDir });
  }
  return app;
}
