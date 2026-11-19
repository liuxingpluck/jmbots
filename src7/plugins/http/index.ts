/**
 * HTTP 服务：整个程序只起这一个 Fastify，监听 0.0.0.0。自己不带页面，只有健康检查和管令牌的接口。
 * 别的插件（网页、接口）在自己挂上的时候往 ctx.http.app 上登记路径；等事件 ready（全部插件挂完）才开始监听，
 * 因为 Fastify 开始监听以后就不能再加路径了。
 * 令牌只在这里查一次：本机来的不查；别的机器来的 /api/、/files/、/programs/ 要带令牌。令牌表在同一个文件夹的 Tokens.ts。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as failureModule from '../../utils/Failure.ts';
import * as routesModule from './Routes.ts';
import * as tokensModule from './Tokens.ts';
import { getPluginProblems } from '../../Resources.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';


/** 插件名。 */
export const name = 'http';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.2.0';

/** 用到的服务。 */
export const inject = ['resources'];


declare module 'cordis' {
  interface Context {
    /** HTTP 服务，实现在 src7/plugins/http/index.ts。 */
    http: Http;
  }
  interface Events {
    /**
     * 关闭 HTTP 服务或在 Fastify 内部发起请求。
     * 谁发：src7/plugins/settings/index.ts 的 Settings.closeHttp、Settings.startedAt
     * 谁接：src7/plugins/http/index.ts 的 Http.constructor
     */
    'http/request'(request: HttpRequest): void | Promise<void>;
    /**
     * 返回关闭结果或注入请求的响应。
     * 谁发：src7/plugins/http/index.ts 的 Http.constructor
     * 谁接：src7/plugins/settings/index.ts 的 Settings.closeHttp、Settings.startedAt
     */
    'http/result'(result: HttpResult): void;
  }
}

/** HTTP 服务接受的两种内部请求。 */
type HttpRequest = requestEventModule.RequestEnvelope & ({
  /** 关闭 Fastify。 */
  action: 'close';
  /** 最多等多久（毫秒），不传就等 Fastify 完成。 */
  waitMs?: number;
} | {
  /** 在 Fastify 内模拟一次请求。 */
  action: 'inject';
  /** HTTP 方法。 */
  method: 'GET' | 'POST';
  /** Fastify 内部路径。 */
  url: string;
});

/** HTTP 请求回执。 */
interface HttpResult extends requestEventModule.ResultEnvelope {
  /** 是否完成关闭或拿到注入响应。 */
  ok: boolean;
  /** 注入响应的 HTTP 状态码。 */
  statusCode?: number;
  /** 注入响应的原始正文。 */
  body?: string;
  /** 操作失败原因。 */
  error?: string;
}

/** apply 校验好以后给 Http 的东西。 */
export interface HttpConfig {
  /** 监听的端口（server.port）；ready 带来的命令行参数里有 --port N 时用 N。 */
  port: number;
  /** 固定的主令牌（server.token）；空串表示没有。 */
  token: string;
  /** 监听的地址（server.host），默认 0.0.0.0。2026-11-14：测试用的临时 exe 写 127.0.0.1，免得 Windows 防火墙弹窗。 */
  host: string;
  /**
   * 免令牌的来源地址（server.trusted_ips），默认 127.0.0.1、::1；127.x 和 ::ffff: 包着的写法也算。
   * 2026-11-14 23:50 EST 用户要求网关 192.168.200.1 也免，写在 config 里。
   */
  trustedIps: string[];
}


/**
 * 这个来源地址免不免令牌（2026-11-14 23:50 EST）。只看 socket 的真实地址（Fastify 没开 trustProxy，request.ip 就是它），不信 X-Forwarded-For。
 * @param ip request.ip。
 * @param trusted server.trusted_ips。
 * @returns 来源地址在本机环回或白名单内时为 true。
 */
export function trustedIp(ip: string, trusted: string[]): boolean {
  const address = ip.replace(/^::ffff:/iu, '');
  return address === '::1' || address.startsWith('127.') || trusted.includes(address);
}


/** 别的机器访问要带令牌的路径前缀；/programs/ 是 programs 插件转发外部程序界面的（2026-11-18）。 */
const GUARDED_PREFIXES = ['/api/', '/files/', '/programs/'];


/**
 * 路径或路由模式是否落在要令牌的前缀下。
 * @param route 不带查询参数的路径，或 Fastify 的路由模式。
 * @returns 在前缀下是 true。
 */
function hasGuardedPrefix(route: string): boolean {
  return GUARDED_PREFIXES.some((prefix) => route.startsWith(prefix));
}


/** 请求体上限：50MB，和 0.4 一样。 */
const BODY_LIMIT = 50 * 1024 * 1024;

/** 端口被占着时最多等多久，毫秒：换版本时旧进程可能还拿着端口，基地给新版本 90 秒（和 0.4 一样）。 */
const LISTEN_WAIT_MS = 80_000;

/** 端口被占着时隔多久再试，毫秒。 */
const LISTEN_RETRY_MS = 2000;


/** HTTP 服务。 */
export class Http extends cordis.Service {
  /** Fastify 的实例。别的插件在自己挂上的时候拿它登记路径；开始监听以后不能再加。 */
  readonly app: fastify.FastifyInstance;

  /** 实际登记过的路径和登记它的插件（Routes.ts）；教程页按它分出每个插件的接口。 */
  readonly routes: routesModule.RouteInfo[] = [];

  /** 不用令牌的路径（整条路径，不带查询参数）；allow 往里加。 */
  private readonly open = new Set(['/api/health']);

  /** 令牌表。 */
  private readonly tokens: tokensModule.Tokens;

  /** 仅保存钩子认过身份的请求对象，不保存令牌或客户端可提供的标记。 */
  private readonly verified = new WeakSet<fastify.FastifyRequest>();

  /** pid 文件；监听上以后才有。 */
  private pidFile = '';

  /** 已接受基地的停服请求。 */
  private windowStopping = false;

  /**
   * 登记 http 插件：把 Http 作为服务挂到 Cordis 上（以后用 ctx.http 取）；再建 Fastify，挂查令牌的钩子、健康检查、管令牌的接口；等 ready 才监听。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 端口、主令牌，apply 里校验过。
   * 副作用：读 data/tokens.json；被拔掉时关服务、删 pid 文件。
   */
  constructor(ctx: cordis.Context, private readonly config: HttpConfig) {
    super(ctx, 'http');

    //M forceCloseConnections：拔插件时连着的 keep-alive 连接一起关，不然 close 要等它们自己断。
    this.app = fastify.default({ logger: false, bodyLimit: BODY_LIMIT, forceCloseConnections: true });

    //M 接口共用错误正文，保留业务和 Fastify 的状态码，其他异常按 500 回。
    this.app.setErrorHandler((error, _request, reply) => {
      let status = 500;
      const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
        status = statusCode;
      }
      if (error instanceof failureModule.Failure) {
        status = error.status;
      }

      //M 客户端从 error 字段读实际错误信息。
      const message = textModule.getErrorMessage(error);
      const body = { error: message };
      reply.code(status);
      return reply.send(body);
    });

    //M 先挂登记簿的钩子，后面登记的每条路径（含下面的健康检查）都记下来。
    routesModule.watchRoutes(this.app, this.routes);

    //M 每个请求先查令牌。用 async 钩子：Bun 上同步钩子返回 undefined 会把请求卡住（src6 11-11 复现）。
    this.app.addHook('onRequest', (request, reply) => this.check(request, reply));
    //M 2026-11-16：problems 报插件没挂上/没开工；ok 仍表示 HTTP 服务本身活着（换版、看门狗只认 ok，插件问题不能把服务判死）。
    this.app.get('/api/health', () => ({ ok: true, problems: getPluginProblems(this.ctx.resources.pluginStatus) }));

    //M 让基地在 Windows 上请求正常退出，先把回执发完，再关闭 HTTP。
    this.app.post('/api/service/stop', {
      onResponse: async (_request, reply) => {
        if (reply.statusCode !== 202) return;

        //M 等程序宿主和数据库收尾。失败交给基地的超时兜底。
        void this.shutdownForWindow().catch((error: unknown) => {
          console.error('停写窗口关停失败', error);
        });
      },
    }, async (request, reply) => {
      //G 拒绝远端和网页请求，只有基地启动的实例接受本机运维指令。
      const local = this.isLocal(request);
      if (!local || request.headers.origin !== undefined || request.headers['x-jmbots-window'] !== '1') {
        return reply.code(403).send({ error: '停服只接受基地的本机请求' });
      }
      if (process.env['JMBOTS_SUPERVISED'] !== '1' || this.windowStopping) {
        return reply.code(409).send({ error: '主站不受基地守护或正在关停' });
      }
      if (request.headers['x-jmbots-expected-pid'] !== String(process.pid)) {
        return reply.code(409).send({ error: '主站进程号与基地记录不同' });
      }
      this.windowStopping = true;
      return reply.code(202).send({ ok: true, pid: process.pid });
    });

    //M 初始化令牌管理器，读取 data/tokens.json 并挂载本机专属的令牌管理接口。
    const file = path.join(this.ctx.resources.ensureRuntimeDir('data'), 'tokens.json');
    this.tokens = new tokensModule.Tokens(this, file, config.token);

    //M 都挂完了才监听：这时候别的插件的路径都登记好了。
    this.ctx.on('ready', (argv) => {
      void this.listen(argv);
    });

    const options = {
      onError: (error: unknown) => {
        //G Fastify 执行失败时把原因随回执交给调用方。
        const detail = textModule.getErrorMessage(error);
        return { ok: false, error: detail };
      },
    };

    //M 由 HTTP 插件自己操作 Fastify，调用方用回执拿到结果。
    requestEventModule.onRequestEvent(
      this.ctx,
      'http/request',
      'http/result',
      (request) => {
        //M 关闭和注入统一从这个事件进入。
        return this.onRequest(request);
      },
      options,
    );

    //M ctx.effect 登记“被拔掉时做什么”：Cordis 拔这个插件时调返回的函数。
    this.ctx.effect(() => {
      return async () => {
        //M 先卸退出钩子，再关服务、删 pid，避免关的过程中信号再进来各删一次。
        this.detachExitHooks();
        await this.app.close();
        this.removePid();
      };
    });
  }

  /** 停止接收请求，等托管程序退出后关闭主库，再结束进程。 */
  private async shutdownForWindow(): Promise<void> {
    //M 先挡掉新的 HTTP 写入，防止窗口打开时又接到任务。
    await this.app.close();

    //M 可选的 programs 插件复用宿主管理器的异步退出路径。
    const programs = this.ctx.get('programs');
    await programs?.shutdown();

    //M 托管服务和主库都收尾后，才用退出码 0 通知基地。
    this.ctx.resources.db.close();
    process.exit(0);
  }

  /**
   * 执行内部 HTTP 操作。关闭超时后 Fastify 继续关闭。
   * @param request 关闭的等待上限，或注入请求的方法和路径。
   * @returns 关闭是否完成，或注入响应的状态码和正文。
   */
  private async onRequest(request: HttpRequest): Promise<Omit<HttpResult, 'requestId'>> {
    if (request.action === 'close') {
      //M 启动关闭，带等待上限时到点回执未完成。
      const closing = this.app.close().then(() => true);
      const waitMs = request.waitMs;
      if (waitMs === undefined) {
        const ok = await closing;
        return { ok };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, waitMs, false);
      });
      try {
        const ok = await Promise.race([closing, deadline]);
        if (!ok) return { ok, error: '等待 HTTP 关闭超时' };

        return { ok };
      } finally {
        clearTimeout(timer);
      }
    }

    const input = { method: request.method, url: request.url };

    //M 复用 Fastify 注入，保留路由响应的状态码和正文。
    const response = await this.app.inject(input);
    return { ok: true, statusCode: response.statusCode, body: response.body };
  }

  /**
   * 这个请求是不是本机来的（127.x、::1，以及 IPv6 包着的 IPv4 写法）。只许本机做的事用它查。
   * @param request 请求。
   * @returns 本机是 true。
   */
  isLocal(request: fastify.FastifyRequest): boolean {
    const address = request.ip.replace(/^::ffff:/iu, '');
    return address === '::1' || address.startsWith('127.');
  }

  /**
   * 读取本次请求的身份核验结果，供 programs 界面代理使用。
   * @param request 经过本服务 onRequest 钩子的请求。
   * @returns 本机请求或已通过令牌校验的远程请求为 true。
   */
  isVerified(request: fastify.FastifyRequest): boolean {
    //M 只查询 HTTP 自己记下的结果，不再读取客户端头或重复校验令牌。
    return this.verified.has(request);
  }

  /**
   * 登记一条不用令牌的路径，比如 /api/agents/guide。
   * @param route 整条路径，不带查询参数。
   * 副作用：将该路径加入免令牌集合 `open`。
   */
  allow(route: string): void {
    //M 将该路由加入免校验集合，供 onRequest 钩子直接放行。
    this.open.add(route);
  }

  /**
   * 查令牌的钩子（onRequest）：本机、不在 /api/、/files/、/programs/ 下（路由模式和解码后的路径都看，见 isGuarded）、
   * 登记过不用令牌的、一个令牌都没有，都放行；
   * 别的要带一个有效的令牌（?token= 或 Authorization: Bearer），没带对回 401。
   * @param request 请求。
   * @param reply 回应。
   * @returns 放行是 undefined；拦下是 reply（Fastify 看到它就不往下跑路由）。
   */
  private async check(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply | undefined> {
    //M 本机来源直接标为已核验，保持免令牌放行。
    const local = this.isLocal(request);
    if (local) {
      this.verified.add(request);
      return undefined;
    }

    const route = request.url.split('?')[0] ?? '';
    //M 路由模式或解码后的路径在要令牌的前缀下，就要令牌（isGuarded 说了为什么两样都查）。
    const guarded = this.isGuarded(request, route);
    //G 免查路径或未配置任何令牌时照常放行，远程请求没有身份标记。
    if (!guarded || this.open.has(route) || this.tokens.none()) return undefined;

    const query = (request.query as { token?: unknown }).token;
    const header = (request.headers.authorization ?? '').replace(/^Bearer\s+/iu, '');
    let value = header;
    if (typeof query === 'string' && query !== '') {
      value = query;
    }
    //G 优先拿查询参数 token、其次拿 Bearer 请求头交由令牌表核验，有效即放行。
    if (this.tokens.check(value)) {
      this.verified.add(request);
      return undefined;
    }

    //M 受信网关仍可免令牌浏览；远程请求须自行提供有效令牌才算已核验。
    const trusted = trustedIp(request.ip, this.config.trustedIps);
    if (trusted) return undefined;

    //G 先 await 掉 send 再 return reply，Fastify 才停下（0.4 在 Windows 的 Bun 1.3.14 上实测，只 return 拦不住）。
    await reply.code(401).send({ error: '要带 token：网址后面加 ?token=…，或请求头 Authorization: Bearer …' });
    return reply;
  }

  /**
   * 这个请求要不要令牌：匹配上的路由模式、或解码后的路径，任一落在 /api/、/files/、/programs/ 下就要。
   * 2026-11-18 131：路由先把 %61 这类编码解开再匹配，原来只看原始地址，/%61pi/message 看着不在前缀下，
   * 却命中 /api/message，别的机器不带令牌就能调接口。
   * @param request 请求；onRequest 时路由已经匹配完，routeOptions.url 是匹配上的模式。
   * @param route 原始地址去掉查询参数。
   * @returns 要令牌是 true。
   */
  private isGuarded(request: fastify.FastifyRequest, route: string): boolean {
    //G 路由模式就是路由的真实决定，不受编码、大小写、重复斜线这些写法影响。
    const pattern = request.routeOptions.url ?? '';
    if (hasGuardedPrefix(pattern)) return true;

    //G 没对上的会落到网页的兜底 /*（或 404，模式是 undefined），模式不在前缀下；再按解码后的路径查，不让兜底放行。
    try {
      const decoded = decodeURI(route);
      return hasGuardedPrefix(decoded);
    } catch {
      //G 解不开的地址（坏的 %xx）按要令牌处理，不因为看不懂就放行。
      return true;
    }
  }

  /**
   * 响应 ready：定端口，开始监听（端口被占着时隔一会儿再试），写 pid 文件。
   * @param argv 命令行里剩下的参数；有 --port N 就用 N。
   * 副作用：占端口；写 data/serve_<端口>.pid；被拔掉、进程退出、收到 SIGTERM/SIGINT 时删它。监听不上打一行原因。
   */
  private async listen(argv: string[]): Promise<void> {
    //M 命令行是外面进来的：--port 在这里校验一次。
    const at = argv.indexOf('--port');
    let port = this.config.port;
    if (at >= 0) {
      port = Number(argv[at + 1]);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('--port 后面要写 1 到 65535 的整数');
      return;
    }

    //M 端口被占着（EADDRINUSE，Bun 的说法是 “Is port N in use?”）→ 等一会儿再试，到点还不行才放弃。
    const deadline = Date.now() + LISTEN_WAIT_MS;
    for (;;) {
      try {
        await this.app.listen({ host: this.config.host, port });
        break;
      } catch (error) {
        const text = textModule.getErrorMessage(error);
        const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' || /in use/iu.test(text);
        if (!inUse || Date.now() > deadline) {
          console.error(`HTTP 服务没起来：${text}`);
          return;
        }
        console.error(`端口 ${String(port)} 被占着，${String(LISTEN_RETRY_MS / 1000)} 秒后再试`);
        await Bun.sleep(LISTEN_RETRY_MS);
      }
    }

    //M 进程号写进 data/serve_<端口>.pid，基地换版本时按它停旧进程；被拔掉、进程退出、收到 SIGTERM/SIGINT 时删掉。
    this.pidFile = path.join(this.ctx.resources.ensureRuntimeDir('data'), `serve_${String(port)}.pid`);
    fs.writeFileSync(this.pidFile, String(process.pid));
    //M 'exit' 必须同步删；SIGTERM/SIGINT 在 Bun 里不一定会走到 'exit'，所以另外登记。
    process.once('exit', this.onExit);
    process.once('SIGTERM', this.onSignal);
    process.once('SIGINT', this.onSignal);

    //T 跟踪：HTTP 服务开始监听。
    const vars = { host: this.config.host, port: port, hasToken: !this.tokens.none() };
    this.ctx.emit('trace', 'Http.listen', 'trace.http.listen', "app.listen({ host, port })", vars);
    console.log(`HTTP 服务已开：http://<本机地址>:${String(port)}（本机请求不用令牌；别的机器要带令牌）`);
  }

  /** 删 pid 文件；还没写过就什么都不做。 */
  private removePid(): void {
    if (this.pidFile === '') return;

    fs.rmSync(this.pidFile, { force: true });
    this.pidFile = '';
  }

  /** 进程退出时删 pid（'exit' 回调必须是同步的）。 */
  private readonly onExit = (): void => {
    //M 进程同步退出时顺手清掉 pid 文件，避免残留无效进程号影响后续启动。
    this.removePid();
  };

  /**
   * SIGTERM/SIGINT 时先删 pid，再把同一信号发回去。
   * Node/Bun 一旦有信号监听器就不会按默认行为退出；卸掉监听再发回去，
   * 不在插件里 process.exit，以免覆盖全局退出（Main.ts 本身没有注册信号处理）。
   */
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    //M 收到终止信号时先删 pid 并摘掉退出监听，再把信号交还系统默认处理完成退出。
    this.removePid();
    this.detachExitHooks();
    process.kill(process.pid, signal);
  };

  /** 卸掉退出和信号上的回调，避免重复删或挡住退出。 */
  private detachExitHooks(): void {
    process.off('exit', this.onExit);
    process.off('SIGTERM', this.onSignal);
    process.off('SIGINT', this.onSignal);
  }
}


/**
 * 挂上 HTTP 服务。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务（resources）
 * 都就绪，再调一次 apply(ctx, 配置)。这里 new 出来的 Http 继承 cordis.Service，构造时作为服务挂到 Cordis 上（以后用 ctx.http 取），
 * 别的插件在 inject 里写上 'http'，就会等到它登记好才开工。详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 * @throws server 段写得不对时抛错。
 * 副作用：向 `ctx` 注册 `http` 服务实例，并在 `ready` 后监听端口及维护 pid 文件。
 */
export function apply(ctx: cordis.Context): void {
  //M server 段是外面进来的（config.yaml 顶层，和基地共用），在这里校验一次；没有主令牌就当空串。
  const server = (ctx.resources.raw['server'] ?? {}) as {
    port?: unknown; token?: unknown; host?: unknown; trusted_ips?: unknown;
  };
  //M 不写 server.port 就报错，不再默认 30086（那是正式运行的端口，免得测试或新目录误占）。
  if (server.port === undefined) {
    throw new Error('配置里没有 server.port');
  }
  const port = server.port;
  const token = server.token ?? '';
  if (typeof server !== 'object' || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error('server.port 要写成 1 到 65535 的整数');
  }
  if (typeof token !== 'string') {
    throw new Error('server.token 要写成字符串，没有就写空串');
  }
  //M server.host 不写就是 0.0.0.0（别的机器也能连）；写 127.0.0.1 只给本机。
  const host = server.host ?? '0.0.0.0';
  if (typeof host !== 'string' || host === '') {
    throw new Error('server.host 要写成地址字符串，比如 127.0.0.1；不写是 0.0.0.0');
  }
  //M server.trusted_ips 不写就是本机（127.0.0.1、::1）；写了是地址字符串列表。
  const trusted = server.trusted_ips ?? ['127.0.0.1', '::1'];
  if (!Array.isArray(trusted) || !trusted.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error('server.trusted_ips 要写成地址字符串列表，比如 [127.0.0.1, ::1, 192.168.200.1]');
  }
  //M server 配置校验通过后，实例化 Http 并作为服务挂到 ctx 上供其他插件登记路由。
  new Http(ctx, { port: port as number, token, host, trustedIps: (trusted as string[]).map((item) => item.trim()) });
}
