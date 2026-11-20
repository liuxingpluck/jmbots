/** 按配置托管外部程序，提供状态、启停、HTTP 转发和界面入口 /programs/<名字>/；资源守卫没有程序时也照样采样。 */
import * as stream from 'node:stream';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as bridgeModule from './ChannelBridge.ts';
import * as sendModule from './ChannelSend.ts';
import * as noticesModule from './GuardNotices.ts';
import * as hostModule from './Host.ts';
import * as protocolModule from './Protocol.ts';
import * as specModule from './Spec.ts';
import * as guardModule from './ResourceGuard.ts';

/** 插件名和版本。 */
export const name = 'programs';
export const version = '1.7.4';
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
    /**
     * 名字、运行状态、程序自报授权与同源界面；只在业务字段变化时广播。
     * 谁发：src7/plugins/programs/Host.ts 的 Host.publishState
     * 谁接：暂无
     */
    'programs/state'(state: ProgramState): void;
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
  /** 外部渠道登记、入站与回调。 */
  private readonly bridge: bridgeModule.ChannelBridge;
  /** 已提示的冲突程序；重复就绪或操作不再告警。 */
  private readonly reportedConflicts = new Set<string>();
  /** 与资源守卫公用的飞书发件箱出口。 */
  private readonly notify: NonNullable<guardModule.GuardDependencies['notify']>;
  /** 告警时刻，测试可使用固定时钟。 */
  private readonly now: () => number;

  /** 建立宿主管理表，等主程序 ready 才启动。 */
  constructor(
    ctx: cordis.Context,
    specs: specModule.ProgramSpec[],
    settings: specModule.GuardSettings,
    private readonly conflicts: ReadonlyMap<string, string>,
    dependencies: guardModule.GuardDependencies,
  ) {
    super(ctx, 'programs');
    const root = ctx.resources.root;
    const activeHosts = new Map<string, hostModule.Host>();
    for (const spec of specs) {
      //M 每个程序只管理自己的进程与重启计数。
      const host = new hostModule.Host(spec, root, {}, ctx);
      this.hosts.set(spec.name, host);
      if (!conflicts.has(spec.name)) {
        activeHosts.set(spec.name, host);
      }
    }
    //G 被拦的程序保留状态，但不登记入站、回复或历史。
    const db = ctx.resources.db;
    this.bridge = new bridgeModule.ChannelBridge(ctx, activeHosts, db);
    //M 批准发送和草稿读取只交给可启动的托管程序。
    sendModule.listenChannelSend(ctx, activeHosts);

    //M 冲突与资源告警沿用同一飞书发件箱；测试只注入收集出口。
    const notices = new noticesModule.GuardNotices(root);
    this.notify = dependencies.notify ?? ((key, text, at) => notices.send(key, text, at));
    this.now = dependencies.now ?? Date.now;

    const hosts = Array.from(activeHosts.values());
    const guardDependencies = { ...dependencies, notify: this.notify };
    //G 守卫只会恢复允许启动的程序。
    this.guard = new guardModule.ResourceGuard(ctx, settings, hosts, guardDependencies);
    for (const host of hosts) {
      host.setGuard(this.guard);
      host.setBridge(this.bridge);
    }
  }

  /** 返回资源最新副本，数值单位与programs/pressure相同。 */
  resources() {
    //M 向查询方返回独立快照，不能修改守卫内部状态。
    return this.guard.resources();
  }

  /** 按配置顺序交回程序状态。 */
  status() {
    const hosts = this.hosts.values();

    //M 取每个宿主的公开状态，避免把进程句柄带给查询方。
    return Array.from(hosts, (host) => this.getStatus(host));
  }

  /** 配置冲突沿用状态接口的 blocked，说明内置占用原因。 */
  private getStatus(host: hostModule.Host) {
    //M 先保留通用的程序身份和状态字段。
    const status = host.status();
    const channels = host.spec.channels.map((channel) => channel.name);
    //G 预先算出的占用冲突覆盖未启动状态，供管理界面显示。
    const reason = this.conflicts.get(status.name);
    if (reason === undefined) return { ...status, channels };

    return { ...status, channels, state: 'blocked' as const, note: reason };
  }

  /** 返回拒绝原因；同一程序首次被拦时写日志并入飞书发件箱。 */
  private getStartBlock(name: string): string | undefined {
    //G 自动和手动启动共用挂载时确定的冲突原因。
    const reason = this.conflicts.get(name);
    if (reason === undefined || this.reportedConflicts.has(name)) return reason;

    //M 本实例记一次，重复启动只交回原因。
    this.reportedConflicts.add(name);
    const message = `外部程序 ${name} 已阻止启动：${reason}。内置渠道继续运行。`;
    console.error(message);
    try {
      const key = `program-channel-conflict:${name}:${reason}`;
      //M 同一测试时钟也用于发件箱的持久化去重。
      const now = this.now();
      //M 通知交给现有发件箱，入队失败不解除启动阻止。
      this.notify(key, message, now);
    } catch (error) {
      const detail = textModule.getErrorMessage(error);
      console.error(`外部程序 ${name} 的渠道冲突通知入队失败：${detail}`);
    }
    return reason;
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
      //G 启动检查包含手动项，配置有冲突时会先告警。
      const blocked = this.getStartBlock(host.spec.name);
      if (blocked !== undefined) continue;

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
  mount(app: fastify.FastifyInstance, isVerified: (request: fastify.FastifyRequest) => boolean): void {
    //M 外部进程的入站走主站接口，密钥由桥接入口核对。
    this.bridge.mount(app);
    //M 界面确认在代理命名空间内由主站处理，外置只收已批准的内部发送请求。
    sendModule.mountOutbound(this.ctx, app, isVerified, this.hosts);

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

      if (action !== 'stop') {
        //G 启动和重启都在申请资源、停止进程之前核对渠道占用。
        const blocked = this.getStartBlock(name);
        if (blocked !== undefined) return reply.code(409).send({ error: blocked });
      }

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
      const program = this.getStatus(host);
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
          const ui = false;
          //M 通用接口代理保留原来的请求权限。
          return forward(host, mount, request, reply, ui);
        };
        scope.all(mount, proxy);
        scope.all(`${mount}/*`, proxy);
      }

      //M 界面入口按名字找宿主；http 插件对 /programs/ 前缀查令牌，这里只管转给谁。
      const openUi = (request: UiRequest, reply: fastify.FastifyReply) => {
        const verified = isVerified(request);
        return this.openUi(request, reply, verified);
      };
      scope.all<UiRoute>('/programs/:name', openUi);
      scope.all<UiRoute>('/programs/:name/*', openUi);
    });
  }

  /**
   * /programs/<名字>/ 的入口：把程序整个地址空间挂在这个前缀下，界面的相对资源和接口都能用。
   * @param request 主服务收到的请求，name 是路径里的程序名。
   * @param reply Fastify 负责写回的响应。
   * @param verified 请求是否已核验身份。
   * @returns 上游响应；没有这个程序、没就绪或没报界面时 404。
   */
  private openUi(request: UiRequest, reply: fastify.FastifyReply, verified: boolean) {
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

    //M 仅为已核验身份的界面请求附上当前进程密钥。
    return forward(host, prefix, request, reply, verified);
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
const PRIVATE_HEADERS = new Set(['authorization', 'cookie', 'referer', protocolModule.KEY_HEADER]);

/**
 * 把程序前缀下的请求转给已就绪的固定端口；配置的 mount 和界面入口 /programs/<名字> 共用。
 * @param host 请求所属的托管程序。
 * @param prefix 主站上的前缀，转发时去掉，剩下的路径原样交给程序。
 * @param request 主服务收到的请求。
 * @param reply Fastify 负责写回的响应。
 * @param ui 请求是否走受主站鉴权保护的程序界面入口。
 * @returns 上游响应；前缀被编码过、访问管理接口时 404，没就绪或连不上 503。
 */
async function forward(
  host: hostModule.Host,
  prefix: string,
  request: fastify.FastifyRequest,
  reply: fastify.FastifyReply,
  ui: boolean,
) {
  //G 路由会把 /%70rograms/ 解码成 /programs/ 再匹配，http 却按原始地址查令牌前缀；原始地址不以前缀开头就不转发。
  if (!request.url.startsWith(prefix)) return reply.code(404).send({ error: '地址里的程序前缀不能编码' });

  //G 转发只允许访问已就绪且通过身份检查的当前子程序。
  const base = host.getUrl();
  const programKey = host.getKey();
  if (base === undefined || programKey === undefined) {
    return reply.code(503).send({ error: `程序 ${host.spec.name} 还没就绪` });
  }

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
  const decodedPath = pathname.toLowerCase().replace(/\\/gu, '/');
  const managed = path.posix.normalize(decodedPath);

  //G 退出、暂停这些管理接口只给 jmbots 自己调；从主站转发会绕过启停接口和资源守卫的记录。
  if (managed === '/jmbots/v1' || managed.startsWith('/jmbots/v1/')) {
    return reply.code(404).send({ error: '程序管理接口不经主站转发' });
  }

  const endpoint = managed.replace(/\/+$/u, '');
  //G 外置客服转交的只能是本人双阶段操作；单步请求不能继续发送。
  const legacy = sendModule.isLegacySend(endpoint);
  let payload = request.body;
  if (legacy) {
    if (!ui) return reply.code(403).send({ error: '发送确认只允许本人操作' });

    const method = request.method;
    //G 只重建校验过的操作，外置渠道收到的操作里不带本地发件 id。
    const action = sendModule.getProxyApproval(endpoint, method, payload);
    if (action === undefined) return reply.code(409).send({ error: '发送请使用主站的草稿确认入口' });

    const json = JSON.stringify(action);
    payload = Buffer.from(json);
  }

  //M 地址里的 token 是主站令牌，转发前去掉，不交给外部程序。
  if (url.searchParams.has('token')) url.searchParams.delete('token');

  const headers = new Headers();
  const connection = request.headers.connection ?? '';
  const linked = connection.toLowerCase().split(',').map((key) => key.trim());

  //M 原始请求仍保留业务头，连接专用字段由客户端重新生成。
  utils.eachEntry(request.headers, (key, value) => {
    //G 鉴权由主 HTTP 服务处理，主站令牌、Cookie、Referer 不交给程序。
    if (HOP_HEADERS.has(key) || linked.includes(key) || PRIVATE_HEADERS.has(key)) return;
    if (typeof value === 'string') headers.set(key, value);
  });
  if (ui) {
    //G 客户端的同名头已丢弃，只用同一次读取就绪地址时取得的启动密钥。
    headers.set(protocolModule.KEY_HEADER, programKey);
  }
  if (legacy) {
    headers.set('content-type', 'application/json');
  }
  headers.set('accept-encoding', 'identity');
  const signal = AbortSignal.timeout(300_000);
  const options: RequestInit = { method: request.method, headers, signal, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD' && payload instanceof Uint8Array) {
    options.body = payload as BodyInit;
  }

  try {
    //M 使用已确认的程序地址和原路径转发。
    const response = await fetch(url, options);
    response.headers.forEach((value, key) => {
      //G 整个主站同源，程序设的 Cookie 会落到所有页面上，不回给浏览器；转发时也不带 Cookie 过去。
      if (HOP_HEADERS.has(key) || key === 'content-encoding' || key === 'set-cookie') return;
      if (key === protocolModule.KEY_HEADER) return;

      //G 上游可能回显请求，带密钥的自定义头和跳转也丢掉。
      if (value.includes(programKey) || key.includes(programKey.toLowerCase())) return;

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

    //M 保留流式转发，正文里的密钥以等长星号遮住。
    const filtered = redactProgramKey(readable, programKey);
    const outgoingBody = stream.Readable.from(filtered, { objectMode: false });
    return outgoing.send(outgoingBody);
  } catch {
    //G 转发异常只返回固定说明，底层错误可能包含上游请求细节。
    return reply.code(503).send({ error: `转发给 ${host.spec.name} 失败` });
  }
}

/**
 * 流式遮盖正文里的启动密钥，二进制响应也保持字节数。
 * @param source 上游返回的字节流。
 * @param key 当前进程的启动密钥，只在内存中比较。
 * @returns 可返回浏览器的字节流；只保留可能跨块的字节。
 */
async function* redactProgramKey(source: AsyncIterable<Buffer>, key: string): AsyncGenerator<Buffer> {
  const secret = Buffer.from(key);
  const mask = '*'.charCodeAt(0);
  let tail = Buffer.alloc(0);
  try {
    for await (const chunk of source) {
      //M 把上一块末尾接回去；密钥可能横跨两个上游数据块。
      const bytes = Buffer.concat([tail, chunk]);
      let end = Math.max(0, bytes.length - secret.length + 1);
      let found = bytes.indexOf(secret);
      while (found !== -1) {
        const after = found + secret.length;
        bytes.fill(mask, found, after);
        end = Math.max(end, after);
        found = bytes.indexOf(secret, after);
      }
      //M 只拷贝末尾尚不能确认的字节，无需缓存整个响应。
      tail = Buffer.from(bytes.subarray(end));
      if (end > 0) {
        yield bytes.subarray(0, end);
      }
    }
    if (tail.length > 0) {
      yield tail;
    }
  } catch {
    //G 网络流出错时也不把上游异常内容带给 Fastify。
    throw new Error('外部程序响应流中断');
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
  const aliasConfig = utils.getField(config, 'channel_aliases');
  const aliases = specModule.readChannelAliases(aliasConfig);
  const specs = specModule.readPrograms(config, aliases);
  const settings = specModule.readGuard(config);
  const plugins = ctx.resources.config.plugins;
  //G 在外部渠道登记和任何启动操作前确定冲突。
  const conflicts = specModule.getChannelConflicts(specs, plugins, aliases);
  const programs = new Programs(ctx, specs, settings, conflicts, dependencies);

  //M 主服务就绪后才启动程序，HTTP 晚挂时也能补登记路由。
  ctx.on('ready', () => programs.startConfigured());
  void ctx.inject(['http'], (sub) => {
    const isVerified = (request: fastify.FastifyRequest): boolean => sub.http.isVerified(request);
    //M 代理使用主 HTTP 提供的来访身份判断。
    programs.mount(sub.http.app, isVerified);
  });
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
