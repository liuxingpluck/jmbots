/** 按配置托管外部程序，提供状态、启停、HTTP 转发和界面入口 /programs/<名字>/；资源守卫没有程序时也照样采样。 */
import * as stream from 'node:stream';
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as textModule from '../../utils/Text.ts';
import * as hostModule from './Host.ts';
import * as specModule from './Spec.ts';
import * as guardModule from './ResourceGuard.ts';

/** 插件名和版本。 */
export const name = 'programs';
export const version = '1.3.0';
/** 数据目录由 resources 提供，HTTP 接口按需挂载。 */
export const inject = ['resources'];

/** 对外业务状态事件，不是用户安全授权或进程控制命令。 */
export interface ProgramState {
  /** 配置中唯一的程序名。 */
  name: string;
  /** 用户设置的显示名。 */
  title: string;
  /** 程序运行状态，paused仍可回答前台查询。 */
  state: hostModule.ProgramPhase;
  /** 程序自报授权；未知明确标unknown。 */
  license: string;
  /** 中文状态，不代表jmbots用户批准执行。 */
  licenseLabel: string;
  /** 只有已核实就绪且声明UI时才给同源地址。 */
  ui: string | null;
}

declare module 'cordis' {
  interface Events {
    /** 名字、运行状态、程序自报授权与同源界面；只在业务字段变化时广播。 */
    'program/state'(state: ProgramState): void;
  }
  interface Context {
    /** 外部程序的状态和已就绪地址。 */
    programs: Programs;
  }
}

/** 转发时丢掉当前连接专用的头，由上下游各自处理。 */
const HOP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
]);

/** 暴露托管状态及就绪地址，其他插件可以就近查询。 */
class Programs extends cordis.Service {
  /** 按配置顺序存放进程宿主。 */
  private readonly hosts = new Map<string, hostModule.Host>();
  /** 主程序开始关闭后拒绝新的启动。 */
  private closing = false;
  /** 同插件资源守卫，HTTP启停和自动重试共用准入。 */
  private readonly guard: guardModule.ResourceGuard;

  /** 建立宿主管理表，等主程序 ready 才启动。 */
  constructor(
    ctx: cordis.Context,
    specs: specModule.ProgramSpec[],
    settings: specModule.GuardSettings,
    dependencies: guardModule.GuardDependencies,
  ) {
    super(ctx, 'programs');
    const root = ctx.resources.root;
    for (const spec of specs) {
      //M 每个程序只管理自己的进程与重启计数。
      const host = new hostModule.Host(spec, root, {}, ctx);
      this.hosts.set(spec.name, host);
    }
    const hosts = Array.from(this.hosts.values());
    //M 守卫只拿本插件刚创建的Host表，不发现或控制系统其他程序。
    this.guard = new guardModule.ResourceGuard(ctx, settings, hosts, dependencies);
    for (const host of hosts) {
      host.setGuard(this.guard);
    }
  }

  /** 返回资源最新副本，数值单位与resource/pressure相同。 */
  resources() {
    //M 向查询方返回独立快照，不能修改守卫内部状态。
    return this.guard.resources();
  }

  /** 按配置顺序交回程序状态。 */
  status() {
    const hosts = this.hosts.values();

    //M 取每个宿主的公开状态，避免把进程句柄带给查询方。
    return Array.from(hosts, (host) => host.status());
  }

  /** 返回程序的内部地址，程序不可用时为空。 */
  url(name: string): string | undefined {
    //M 从负责该程序的宿主取已就绪地址。
    const host = this.hosts.get(name);
    return host?.getUrl();
  }

  /** 主程序就绪后启动所有自动启动项。 */
  startConfigured(): void {
    if (this.closing) return;

    for (const host of this.hosts.values()) {
      //M 标成手动启动的程序留在停止状态，仍能从状态页查到。
      if (host.spec.autostart) host.start();
    }
  }

  /** 禁止新的启停动作，并行等待所有托管进程收尾。 */
  async shutdown(): Promise<void> {
    this.closing = true;
    //M 先取消守卫，避免关闭Host时又被恢复逻辑拉起。
    await this.guard.dispose();
    const hosts = this.hosts.values();

    //M 一个慢退出的程序不挡其他程序同时收尾。
    const stopping = Array.from(hosts, (host) => host.stop());
    await Promise.all(stopping);
  }

  /** 退出事件无法等待网络，直接回收尚存的子进程。 */
  killOnExit(): void {
    for (const host of this.hosts.values()) {
      //M 清理每个宿主仍持有的进程句柄。
      host.killOnExit();
    }
  }

  /** 登记状态、启停与代理，沿用 HTTP 插件的鉴权钩子。 */
  mount(app: fastify.FastifyInstance): void {
    //M 主界面通过同一个只读接口列出已配置的程序。
    app.get('/api/programs', () => ({ programs: this.status() }));
    app.post<{ Params: { name: string; action: string } }>('/api/programs/:name/:action', async (request, reply) => {
      const { name, action } = request.params;

      //G 只能控制当前配置里的程序。
      const host = this.hosts.get(name);
      if (host === undefined) return reply.code(404).send({ error: `没有程序 ${name}` });

      //G 路由入口仅接收第一阶段支持的三个动作。
      if (action !== 'start' && action !== 'stop' && action !== 'restart') {
        return reply.code(404).send({ error: `不支持程序操作 ${action}` });
      }

      //G 主服务关停后不能从 HTTP 路由重新拉起进程。
      if (this.closing) return reply.code(503).send({ error: '外部程序正在关停' });

      //M 重启等旧实例退出再启动，防止同一个程序同时拉起两份。
      if (action === 'stop' || action === 'restart') await host.stop();
      if (!this.closing && (action === 'start' || action === 'restart')) {
        const permissionRequest = { action: 'can-start' as const, heavy: host.spec.heavy, who: host.spec.name };
        //M HTTP手动启动也过同一准入；启动后的自动重试仍由Host再检查。
        const permission = await this.guard.request(permissionRequest);
        if (!permission.ok) return reply.code(503).send({ error: permission.reason });
        if (this.closing) return reply.code(503).send({ error: '外部程序正在关停' });
        host.start();
      }
      //M HTTP响应读取动作完成后的真实宿主状态。
      const program = host.status();
      if (program.state === 'failed' && program.pid !== null) {
        return reply.code(503).send({ error: program.note, program });
      }
      return { program };
    });

    //M 仅代理作用域用原始请求体，其他插件仍用各自的 Fastify 解析规则。
    void app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
      for (const host of this.hosts.values()) {
        const mount = host.spec.mount;
        const proxy = (request: fastify.FastifyRequest, reply: fastify.FastifyReply) => {
          return forward(host, mount, request, reply);
        };
        scope.all(mount, proxy);
        scope.all(`${mount}/*`, proxy);
      }

      //M 界面入口按名字找宿主；http 插件对 /programs/ 前缀查令牌，这里只管转给谁。
      const openUi = (request: UiRequest, reply: fastify.FastifyReply) => this.openUi(request, reply);
      scope.all<UiRoute>('/programs/:name', openUi);
      scope.all<UiRoute>('/programs/:name/*', openUi);
    });
  }

  /**
   * /programs/<名字>/ 的入口：把程序整个地址空间挂在这个前缀下，界面的相对资源和接口都能用。
   * @param request 主服务收到的请求，name 是路径里的程序名。
   * @param reply Fastify 负责写回的响应。
   * @returns 上游响应；没有这个程序、没就绪或没报界面时 404。
   */
  private openUi(request: UiRequest, reply: fastify.FastifyReply) {
    //M 按路径里的名字找本插件自己的宿主。
    const name = request.params.name;
    const host = this.hosts.get(name);

    //G 只转发本插件拉起、已就绪且 info 自报了界面的程序，不按请求开放任意端口。
    if (host === undefined || host.getUiPath() === null) {
      return reply.code(404).send({ error: `程序 ${name} 没有可打开的界面` });
    }

    //M 没带尾斜线时补上再跳，界面里的相对路径才落在本程序前缀下；查询参数（含令牌）原样带过去。
    const prefix = `/programs/${name}`;
    if (request.url === prefix || request.url.startsWith(`${prefix}?`)) {
      const query = request.url.slice(prefix.length);
      return reply.redirect(`${prefix}/${query}`);
    }

    //M 带尾斜线的才交给程序，和 mount 走同一套转发规则。
    return forward(host, prefix, request, reply);
  }
}

/** /programs/:name 路由的路径参数。 */
interface UiRoute {
  /** name 是路径里的程序名，按配置名找宿主。 */
  Params: { name: string };
}

/** /programs/:name 路由收到的请求。 */
type UiRequest = fastify.FastifyRequest<UiRoute>;

/** 只属于主站的请求头：令牌、Cookie，以及带着主站地址和令牌的 Referer。 */
const PRIVATE_HEADERS = new Set(['authorization', 'cookie', 'referer']);

/**
 * 把程序前缀下的请求转给已就绪的固定端口；配置的 mount 和界面入口 /programs/<名字> 共用。
 * @param host 请求所属的托管程序。
 * @param prefix 主站上的前缀，转发时去掉，剩下的路径原样交给程序。
 * @param request 主服务收到的请求。
 * @param reply Fastify 负责写回的响应。
 * @returns 上游响应；前缀被编码过、访问管理接口时 404，没就绪或连不上 503。
 */
async function forward(
  host: hostModule.Host,
  prefix: string,
  request: fastify.FastifyRequest,
  reply: fastify.FastifyReply,
) {
  //G 路由会把 /%70rograms/ 解码成 /programs/ 再匹配，http 却按原始地址查令牌前缀；原始地址不以前缀开头就不转发。
  if (!request.url.startsWith(prefix)) return reply.code(404).send({ error: '地址里的程序前缀不能编码' });

  //G 转发只允许访问已就绪且通过身份检查的当前子程序。
  const base = host.getUrl();
  if (base === undefined) return reply.code(503).send({ error: `程序 ${host.spec.name} 还没就绪` });

  const rest = request.url.slice(prefix.length);
  let route = rest;
  if (rest === '' || rest.startsWith('?')) route = `/${rest}`;
  //M URL 会合并 ../ 这类路径段，下面按合并后的路径判断。
  const url = new URL(`${base}${route}`);

  //M 解码并合并重复斜线后再比，编码或多斜线的写法也认得出管理接口。
  let pathname = '';
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return reply.code(400).send({ error: '路径里有坏的百分号编码' });
  }
  const managed = pathname.toLowerCase().replace(/\/+/gu, '/');

  //G 退出、暂停这些管理接口只给 jmbots 自己调；从主站转发会绕过启停接口和资源守卫的记录。
  if (managed === '/jmbots/v1' || managed.startsWith('/jmbots/v1/')) {
    return reply.code(404).send({ error: '程序管理接口不经主站转发' });
  }

  //M 地址里的 token 是主站令牌，转发前去掉，不交给外部程序。
  if (url.searchParams.has('token')) url.searchParams.delete('token');

  const headers = new Headers();
  const connection = request.headers.connection ?? '';
  const linked = connection.toLowerCase().split(',').map((key) => key.trim());

  //M 原始请求仍保留业务头，连接专用字段由客户端重新生成。
  textModule.eachEntry(request.headers, (key, value) => {
    //G 鉴权由主 HTTP 服务处理，主站令牌、Cookie、Referer 不交给程序。
    if (HOP_HEADERS.has(key) || linked.includes(key) || PRIVATE_HEADERS.has(key)) return;
    if (typeof value === 'string') headers.set(key, value);
  });
  headers.set('accept-encoding', 'identity');
  const signal = AbortSignal.timeout(300_000);
  const options: RequestInit = { method: request.method, headers, signal, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body instanceof Uint8Array) {
    options.body = request.body as BodyInit;
  }

  try {
    //M 使用已确认的程序地址和原路径转发。
    const response = await fetch(url, options);
    response.headers.forEach((value, key) => {
      //G 整个主站同源，程序设的 Cookie 会落到所有页面上，不回给浏览器；转发时也不带 Cookie 过去。
      if (HOP_HEADERS.has(key) || key === 'content-encoding' || key === 'set-cookie') return;

      //M 程序跳回自己地址或根路径时，换成主站上的同一前缀，浏览器不会跳出转发。
      if (key === 'location') {
        const location = getLocation(value, base, prefix);
        reply.header(key, location);
        return;
      }
      //M 其余业务响应头原样回给浏览器。
      reply.header(key, value);
    });

    //M 保留上游状态码，无正文的响应直接返回。
    const outgoing = reply.code(response.status);
    if (response.body === null) return outgoing.send();

    const body = response.body as unknown as Parameters<typeof stream.Readable.fromWeb>[0];
    const readable = stream.Readable.fromWeb(body);

    //M 流式回送正文，避免把程序的大响应整块读进内存。
    return outgoing.send(readable);
  } catch (error) {
    //M 连接失败时把程序名与失败原因带回页面。
    const reason = textModule.getMessage(error);
    return reply.code(503).send({ error: `转发给 ${host.spec.name} 失败：${reason}` });
  }
}

/**
 * 把程序回的跳转地址换回主站前缀。
 * @param location 上游 Location 头。
 * @param base 程序的内部地址，如 http://127.0.0.1:43121。
 * @param prefix 主站上的前缀。
 * @returns 指向程序自己的换成前缀下的路径；相对路径和别的站点原样返回。
 */
function getLocation(location: string, base: string, prefix: string): string {
  //M 程序写了自己的完整内部地址：去掉地址，接到前缀后面。
  const own = location === base || location.startsWith(`${base}/`) || location.startsWith(`${base}?`);
  if (own) return `${prefix}${location.slice(base.length)}`;

  //M 以单个 / 开头的是程序里的根路径；// 开头是别的站点，不动。
  if (location.startsWith('/') && !location.startsWith('//')) return `${prefix}${location}`;

  return location;
}

/**
 * 校验配置和挂载托管服务，控制生命周期与 HTTP 注册。
 * @param ctx 插件的 Cordis 上下文。
 * @param config 原始程序配置。
 * 副作用：注册就绪及关闭回调，可选注册管理路由和代理。
 */
export function apply(
  ctx: cordis.Context,
  config?: unknown,
  dependencies: guardModule.GuardDependencies = {},
): void {
  //M 外部配置只在入口校验一次，校验成功后建立托管服务。
  const specs = specModule.readPrograms(config);
  const settings = specModule.readGuard(config);
  const programs = new Programs(ctx, specs, settings, dependencies);

  //M 主服务就绪后才启动程序，HTTP 晚挂时也能补登记路由。
  ctx.on('ready', () => programs.startConfigured());
  void ctx.inject(['http'], (sub) => programs.mount(sub.http.app));
  if (specs.length === 0) return;

  ctx.effect(() => {
    const onExit = (): void => programs.killOnExit();
    let signaled = false;
    const closeOnSignal = (signal: NodeJS.Signals): void => {
      if (signaled) return;

      //M 先给子程序收尾机会，之后把信号交还给主程序的正常退出流程。
      signaled = true;
      void programs.shutdown().finally(() => {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
        process.kill(process.pid, signal);
      });
    };
    const onInterrupt = (): void => closeOnSignal('SIGINT');
    const onTerminate = (): void => closeOnSignal('SIGTERM');

    //M 进程直接结束时只能同步清理，通常关停走异步退出接口。
    process.once('exit', onExit);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    return async () => {
      //M 卸载插件时停止自己启动的程序，同时撤销全局退出回调。
      await programs.shutdown();
      process.off('exit', onExit);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
  });
}
