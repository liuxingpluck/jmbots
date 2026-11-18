/**
 * memory 插件托管的本机服务（记忆服务 jmbots-memory、vgr 适配器）：插件挂上时隐藏拉起、守护、拔掉时停；
 * 对外只走主服务端口下的路径（/memory/ → jmbots-memory，/memory/vgr/ → vgr），内部端口只开 127.0.0.1。
 * 2026-11-14 用户定“插件思想”：壳子只是启动者（Job Object 保证子孙一起退出），业务服务归插件，配置写在 plugins 里 memory 的 services 下。
 *   端口：不写就按主端口顺延（第 1 个 +1、第 2 个 +2……）。端口上已有服务时先问 /health：报的服务名、数据目录都是自己的就复用，不重开；
 *   识别不了（别的服务、不答 /health 却占着端口）才顺延到下一个端口，最多往后 PORT_SCAN 个（Claude 15:31 意见；不用 PID 文件）。
 *   参数里的占位：{runtime}（数据目录）、{data}（数据目录/data）、{host}、{port}。程序路径相对数据目录，Windows 自动补 .exe。
 *   日志：data/logs/<服务名>.log。
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as process from 'node:process';


/** 一个托管服务的配置。 */
export interface ServiceSpec {
  name: string;
  file: string;
  args: string[];
  host: string;
  /** 0 表示按主端口顺延。 */
  port: number;
  health: string;
  /** 挂在主服务的哪个路径下，如 /memory、/memory/vgr。 */
  path: string;
  env: Record<string, string>;
  /** 启动后最多等多久才算卡死（毫秒）：vgr 加载模型慢。 */
  startupMs: number;
  /** /health 里报的 service 名（认是不是自己的那个）。 */
  service: string;
  /** /health 里报的数据目录要在哪个目录下（相对数据目录；'' 就是数据目录本身）。 */
  dataDir: string;
}

/** 默认的两个服务（用户 11-14：记忆服务 30087、vgr 30088，跟着主端口 30086 顺延）。 */
// 为什么 host 默认 127.0.0.1（Claude 11-14 15:42 定，用户同意，别改回 0.0.0.0）：
// 内部端口只听本机，外面一律从主端口 30086 的 /memory/、/memory/vgr/ 转发进来。
// 一是听 0.0.0.0 的新程序会触发 Windows 防火墙弹窗；二是记忆库里有客户聊天记录，不该直接暴露到局域网。
// 主服务 30086 才听 0.0.0.0（server.host）。确实要外部直连，就在 config 里给这个服务写 host。
export const DEFAULT_SERVICES: ServiceSpec[] = [
  {
    name: 'memory', file: 'program/jmbots-memory/jmbots-memory', host: '127.0.0.1', port: 0, health: '/health', path: '/memory', env: {}, startupMs: 120_000, service: 'jmbots-memory', dataDir: '',
    args: ['serve', '--host', '{host}', '--port', '{port}', '--runtime', '{runtime}'],
  },
  {
    name: 'vgr', file: 'program/python/vgr-venv/Scripts/python', host: '127.0.0.1', port: 0, health: '/health', path: '/memory/vgr', startupMs: 240_000, service: 'vgr', dataDir: 'vgr-memory',
    args: ['{runtime}/program/vector-graph-rag/adapter/vgr_adapter.py', '--data', '{runtime}/vgr-memory', '--host', '{host}', '--port', '{port}',
      '--llm-model', 'minimax-code/MiniMax-M3.1-Flash', '--query-model', 'workbuddy/deepseek-v4.1-flash', '--rerank-model', 'workbuddy/deepseek-v4.1-flash'],
    env: { PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', VGRAG_HOME: '{runtime}/program/models/vgr' },
  },
];

/** 多久看一眼健康。 */
const WATCH_MS = 3000;
/** 健康检查最多等多久。 */
const HEALTH_TIMEOUT_MS = 2500;
/** 启动期过后连续几次不答 /health 才算卡死、重启（2026-11-14 23:10 EST：原来 1 次就杀，记忆服务在跑大查询时 /health 等锁超过 2.5 秒，
 *  被当成卡死杀掉，正在转发的 /search 连接被掐断，页面报“memory 没开或连不上：socket closed”）。3 秒一轮，5 次约 15～25 秒。 */
const MISSES_BEFORE_RESTART = 5;
/** 识别不了时最多往后顺延几个端口。 */
const PORT_SCAN = 20;
/** 重启时 kill 后最多等旧进程自己退多久，超时就强杀（2026-11-15 00:17 EST Claude：原来 kill 完马上 launch，
 *  旧进程还占着端口，被当成“别人占着”顺延，22:53 漂到 30089，和壳子试跑端口撞）。 */
const KILL_WAIT_MS = 5000;
/** 强杀后再等多久。 */
const FORCE_WAIT_MS = 2000;
/** 旧进程退了以后，最多再等多久让系统把端口放出来（Windows 上会慢一点）。 */
const PORT_RELEASE_MS = 3000;


/**
 * 读 services 配置：不写用默认；写成 [] 就不托管；写了某一项按名字覆盖默认（只写要改的键），新名字要写全 file。
 * @throws 写错了抛错。
 */
export function readServices(raw: unknown): ServiceSpec[] {
  if (raw === undefined || raw === null) return DEFAULT_SERVICES.map((spec) => ({ ...spec }));
  if (!Array.isArray(raw)) throw new Error('memory.services 要是列表');
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`memory.services 第 ${String(index + 1)} 项要是对象`);
    const own = item as Record<string, unknown>;
    const name = typeof own['name'] === 'string' ? own['name'].trim() : '';
    if (name === '') throw new Error(`memory.services 第 ${String(index + 1)} 项要有 name`);
    const base = DEFAULT_SERVICES.find((spec) => spec.name === name);
    const text = (key: string, fallback: string | undefined): string => {
      const value = own[key] ?? fallback;
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`memory.services.${name}.${key} 要是字符串`);
      return value.trim();
    };
    const port = own['port'] ?? base?.port ?? 0;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`memory.services.${name}.port 要是 0～65535 的整数（0 是按主端口顺延）`);
    const args = own['args'] ?? base?.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error(`memory.services.${name}.args 要是文字列表`);
    const env = own['env'] ?? base?.env ?? {};
    if (typeof env !== 'object' || env === null) throw new Error(`memory.services.${name}.env 要是对象`);
    const startup = own['startup_ms'] ?? base?.startupMs ?? 120_000;
    return {
      name, file: text('file', base?.file), host: text('host', base?.host ?? '127.0.0.1'), port, health: text('health', base?.health ?? '/health'),
      path: text('path', base?.path ?? `/memory/${name}`).replace(/\/+$/u, ''), args: args as string[],
      env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
      startupMs: typeof startup === 'number' && startup > 0 ? startup : 120_000,
      service: typeof own['service'] === 'string' ? own['service'] : base?.service ?? name,
      dataDir: typeof own['data_dir'] === 'string' ? own['data_dir'] : base?.dataDir ?? '',
    };
  });
}


/** 端口能不能占（在这个地址上试着听一下马上关）。 */
function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}


/** 等子进程退出，最多 ms 毫秒；退了返回 true。 */
async function waitExit(child: ReturnType<typeof Bun.spawn>, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([child.exited.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}


/** 端口在 ms 毫秒内放出来就返回 true（每 200 毫秒试一次）。 */
async function waitPortFree(host: string, port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await portFree(host, port)) return true;
    if (Date.now() >= until) return false;
    await Bun.sleep(200);
  }
}


/** 一个服务的运行情况。 */
class Hosted {
  child: ReturnType<typeof Bun.spawn> | undefined;
  port: number;
  readonly firstPort: number;
  healthy = false;
  note = '还没开始';
  startedAt = 0;
  failures = 0;
  nextTryAt = 0;
  /** 启动期过后连续几次没答 /health。 */
  misses = 0;

  constructor(readonly spec: ServiceSpec, defaultPort: number) {
    this.port = spec.port > 0 ? spec.port : defaultPort;
    this.firstPort = this.port;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }
}


/** 全部托管服务。 */
export class Services {
  private readonly items: Hosted[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private stopped = false;

  /**
   * @param root 数据目录。
   * @param mainPort 主服务端口（顺延的起点）。
   * @param specs 服务表。
   */
  constructor(private readonly root: string, mainPort: number, specs: ServiceSpec[]) {
    this.items = specs.map((spec, index) => new Hosted(spec, mainPort + index + 1));
  }

  /** 开始守护（马上看一次）。 */
  start(): void {
    if (this.items.length === 0) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), WATCH_MS);
  }

  /** 停：只停自己拉起的进程。 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const item of this.items) {
      try {
        item.child?.kill();
      } catch {
        // 已经退了
      }
      item.child = undefined;
    }
  }

  /** 按挂载路径找服务：最长的前缀优先（/memory/vgr 先于 /memory）。 */
  route(url: string): { item: Hosted; rest: string } | undefined {
    const sorted = [...this.items].sort((a, b) => b.spec.path.length - a.spec.path.length);
    for (const item of sorted) {
      const prefix = item.spec.path;
      if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
        const rest = url.slice(prefix.length);
        return { item, rest: rest === '' || rest.startsWith('?') ? `/${rest}` : rest };
      }
    }
    return undefined;
  }

  /** 挂载路径（给 http 登记路由用）。 */
  paths(): string[] {
    return this.items.map((item) => item.spec.path);
  }

  /** 状态（GET /api/memory/services）。 */
  status(): unknown[] {
    return this.items.map((item) => ({
      name: item.spec.name, path: `${item.spec.path}/`, port: item.port, healthy: item.healthy,
      managed: item.child !== undefined, pid: item.child?.pid ?? null, note: item.note,
    }));
  }

  /** 内部地址（同进程别处要直连时用）。 */
  getUrl(name: string): string | undefined {
    return this.items.find((item) => item.spec.name === name)?.url;
  }

  /** 问 /health：'mine' 自己的（服务名、数据目录对得上；旧版不报这两项也算）、'other' 别人的、'none' 没应答。 */
  private async getHealth(item: Hosted): Promise<'mine' | 'other' | 'none'> {
    try {
      const response = await fetch(`${item.url}${item.spec.health}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!response.ok) return 'none';
      const body = await response.json().catch(() => ({})) as { service?: unknown; runtime?: unknown; data?: unknown };
      if (typeof body.service === 'string' && body.service !== item.spec.service) return 'other';
      const dir = typeof body.runtime === 'string' ? body.runtime : typeof body.data === 'string' ? body.data : undefined;
      if (dir === undefined) return 'mine';
      const norm = (value: string) => path.resolve(value).replace(/\\/gu, '/').toLowerCase();
      return norm(dir) === norm(path.join(this.root, item.spec.dataDir)) ? 'mine' : 'other';
    } catch {
      return 'none';
    }
  }


  /** 顺延一个端口（不超过起点 + PORT_SCAN）。 */
  private shift(item: Hosted, why: string): void {
    if (item.port >= item.firstPort + PORT_SCAN) {
      item.note = `从 ${String(item.firstPort)} 往后 ${String(PORT_SCAN)} 个端口都用不了（${why}）`;
      item.nextTryAt = Date.now() + 30_000;
      return;
    }
    item.note = `端口 ${String(item.port)} ${why}，换到 ${String(item.port + 1)}`;
    console.log(`memory 插件：${item.spec.name} ${item.note}`);
    item.port += 1;
  }

  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const item of this.items) await this.watch(item);
    } finally {
      this.busy = false;
    }
  }

  /** 看一个服务：健康就算了；自己的进程还在启动期就等；不在了就（退避后）拉起。 */
  private async watch(item: Hosted): Promise<void> {
    const who = await this.getHealth(item);
    item.healthy = who === 'mine';
    if (who === 'other') {
      //M 端口上是别的服务（或别的数据目录的同名服务）：自己没进程在跑就顺延到下一个端口，下一轮再起。
      if (item.child === undefined) this.shift(item, '上面是别的服务');
      return;
    }
    if (item.healthy) {
      item.misses = 0;
      item.failures = 0;
      item.note = item.child === undefined ? '在跑（复用已有进程）' : '在跑';
      return;
    }
    const alive = item.child !== undefined && item.child.exitCode === null && !item.child.killed;
    if (alive && Date.now() - item.startedAt < item.spec.startupMs) {
      item.note = '启动中';
      return;
    }
    //M 进程还在、只是一时不答（忙着跑大查询）：连续 MISSES_BEFORE_RESTART 次才重启，不然会掐断正在转发的请求。
    if (alive && ++item.misses < MISSES_BEFORE_RESTART) {
      item.note = `一时不答 /health（第 ${String(item.misses)} 次），先等等`;
      return;
    }
    if (alive) {
      item.misses = 0;
      item.note = '一直不答，重启';
      console.log(`memory 插件：${item.spec.name} 连续 ${String(MISSES_BEFORE_RESTART)} 次不答 /health，重启（pid ${String(item.child?.pid)}）`);
      await this.killAndWait(item);
    }
    item.child = undefined;
    if (Date.now() < item.nextTryAt || this.stopped) return;
    await this.launch(item);
  }

  /**
   * 重启前停掉自己的旧进程：先 kill，等它真退（最多 KILL_WAIT_MS），不退就强杀再等 FORCE_WAIT_MS；
   * 退了再等端口放出来（最多 PORT_RELEASE_MS）。这样 launch 还在原端口起，不会把自己的旧进程当成“别人占着”顺延。
   */
  private async killAndWait(item: Hosted): Promise<void> {
    const child = item.child;
    if (child === undefined) return;
    try {
      child.kill();
    } catch {
      // 已经退了
    }
    //M 先等它自己退；超时再强杀（SIGKILL，Windows 上本来就是直接结束），再等一会。
    if (!(await waitExit(child, KILL_WAIT_MS))) {
      console.log(`memory 插件：${item.spec.name} 旧进程 ${String(KILL_WAIT_MS / 1000)} 秒没退，强杀（pid ${String(child.pid)}）`);
      try {
        child.kill('SIGKILL');
      } catch {
        // 已经退了
      }
      if (!(await waitExit(child, FORCE_WAIT_MS))) item.note = `旧进程强杀后还没退（pid ${String(child.pid)}）`;
    }
    //M 进程退了端口也可能晚一点才放出来；等不到就交给 launch 照旧判断（真是别人占着才顺延）。
    await waitPortFree(item.spec.host, item.port, PORT_RELEASE_MS);
  }

  private async launch(item: Hosted): Promise<void> {
    const suffix = process.platform === 'win32' && !item.spec.file.toLowerCase().endsWith('.exe') ? '.exe' : '';
    const file = path.resolve(this.root, item.spec.file + suffix);
    if (!fs.existsSync(file)) {
      item.note = `程序不在：${item.spec.file}${suffix}`;
      item.nextTryAt = Date.now() + 30_000;
      return;
    }
    //M 端口被占着又不答 /health（识别不了）：顺延到下一个端口，下一轮再起。
    const port = item.port;
    if (!(await portFree(item.spec.host, port))) {
      this.shift(item, '被占着、不答 /health');
      return;
    }
    const fill = (value: string): string => value
      .replaceAll('{runtime}', this.root).replaceAll('{data}', path.join(this.root, 'data'))
      .replaceAll('{host}', item.spec.host).replaceAll('{port}', String(port));
    const logs = path.join(this.root, 'data', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const log = fs.openSync(path.join(logs, `${item.spec.name}.log`), 'a');
    const env: Record<string, string> = { ...(process.env as Record<string, string>), JMBOTS_SUPERVISED: '1' };
    for (const [key, value] of Object.entries(item.spec.env)) env[key] = fill(value);
    try {
      item.child = Bun.spawn([file, ...item.spec.args.map(fill)], { cwd: this.root, env, stdin: 'ignore', stdout: log, stderr: log, windowsHide: true });
      item.startedAt = Date.now();
      item.note = `刚拉起（端口 ${String(port)}）`;
      item.failures += 1;
      //M 连续起不来越等越久，最多 60 秒。
      item.nextTryAt = Date.now() + Math.min(60_000, WATCH_MS * 2 ** Math.min(item.failures, 5));
      console.log(`memory 插件拉起 ${item.spec.name}：127.0.0.1:${String(port)}，pid ${String(item.child.pid)}`);
    } catch (error) {
      item.note = `拉不起来：${error instanceof Error ? error.message : String(error)}`;
      item.nextTryAt = Date.now() + 30_000;
    } finally {
      fs.closeSync(log);
    }
  }
}
