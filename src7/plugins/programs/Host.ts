/** 托管单个外部程序的进程、就绪状态、健康与关停；每次拉起发一把一次性密钥，渠道回调靠它认身份。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as cordis from 'cordis';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as stream from 'node:stream';
import * as timers from 'node:timers/promises';
import * as textModule from '../../utils/Text.ts';
import * as protocolModule from './Protocol.ts';
import * as specModule from './Spec.ts';
import type { ChannelBridge } from './ChannelBridge.ts';
import type { ResourceGuard } from './ResourceGuard.ts';

/** 第一阶段使用的进程状态。 */
type ProgramState = 'stopped' | 'starting' | 'ready' | 'unhealthy' | 'failed' | 'blocked';

/** 对外状态不泄漏协议阻断细节；后台暂停仍保留查询服务。 */
export type ProgramPhase = Exclude<ProgramState, 'blocked'> | 'paused';

/** 监督中使用的计时参数。测试可缩短等待，线上使用约定值。 */
interface Timing {
  /** 健康探测间隔。 */
  watchMs: number;
  /** 单次健康请求的时限。 */
  healthMs: number;
  /** 连续几次健康异常后重启。 */
  healthMisses: number;
  /** 第一次重启等待时间。 */
  retryMs: number;
  /** 退避等待上限。 */
  retryMaxMs: number;
  /** 最近几毫秒内的失败计入上限。 */
  crashWindowMs: number;
  /** 文件尚未放到指定位置时的重查间隔。 */
  missingMs: number;
}

/** 生产配置使用的监督间隔。 */
const TIMING: Timing = {
  watchMs: 3000, healthMs: 2500, healthMisses: 5,
  retryMs: 3000, retryMaxMs: 60_000, crashWindowMs: 600_000, missingMs: 30_000,
};

/** 强制结束后再给进程退出通知的时间。 */
const FORCE_WAIT_MS = 2000;
/** 在窗口期内累计到五次崩溃后停止自动重试。 */
const MAX_CRASHES = 5;
/** 外部程序输出管道由宿主读取。 */
type Child = Bun.Subprocess<'ignore', 'pipe', number>;

/** 一个程序只持有自己启动的进程句柄。 */
export class Host {
  /** 解析后的进程参数。 */
  private readonly launch: ReturnType<typeof specModule.getLaunch>;
  /** 健康和重试时限。 */
  private readonly timing: Timing;
  /** 输出日志位置。 */
  private readonly logPath: string;
  /** 启动到退出的单个监督任务。 */
  private supervisor?: Promise<void>;
  /** 让重试等待和监督循环一起停止。 */
  private control?: AbortController;
  /** 本实例创建且尚未退出的子进程。 */
  private child?: Child;
  /** 通过就绪与身份检查的地址。 */
  private url?: string;
  /** 当前子进程的就绪行。 */
  private ready?: protocolModule.ReadyLine;
  /** 当前生命周期阶段。 */
  private state: ProgramState = 'stopped';
  /** 对阶段或失败原因的补充。 */
  private note = '未启动';
  /** 本轮监督实际安排过的重启次数。 */
  private restarts = 0;
  /** 手动启停递增，守卫只能恢复自己所记录的同一代状态。 */
  private generation = 0;
  /** 程序显式声明的后台暂停能力。 */
  private canPause = false;
  /** 只有pause接口明确确认后才为真。 */
  private paused = false;
  /** 最近有效健康回执的常驻内存，MiB。 */
  private rssMb?: number;
  /** RSS读数的Unix毫秒时刻，缺席为0。 */
  private rssAt = 0;
  /** 最近有效授权状态，读取失败为未知。 */
  private license?: string;
  /** 是否因窗口内连续崩溃达到上限而放弃。 */
  private gaveUp = false;
  /** 只影响本Host新建进程，不操作其他插件或系统进程。 */
  private guard?: ResourceGuard;
  /** info已核实的程序内部UI路径，退出时清空。 */
  private uiPath: string | null = null;
  /** 只按业务状态签名发事件，不因健康读数或计时刷新。 */
  private lastState = '';
  /** 当前子进程的一次性密钥：拉起前生成，只放进它的环境变量；进程退出就清掉。 */
  private key?: string;
  /** 同插件的渠道回调，算回调地址用；不接时子进程只拿密钥。 */
  private bridge?: ChannelBridge;


  /**
   * 准备进程参数，不启动程序。
   * @param spec 已校验的进程配置。
   * @param root 数据目录。
   * @param timing 测试时可缩短监督与重试间隔。
   * @param ctx 同插件事件总线，省略时仅托管进程而不广播。
   */
  constructor(
    readonly spec: specModule.ProgramSpec,
    root: string,
    timing: Partial<Timing> = {},
    private readonly ctx?: cordis.Context,
  ) {
    //M 提前解析内置占位符，之后每次重启沿用同一份参数。
    this.launch = specModule.getLaunch(root, spec);
    this.timing = { ...TIMING, ...timing };
    this.logPath = path.join(root, 'data', 'logs', `${spec.name}.log`);
  }

  /** 返回网页状态所需字段，隐藏内部的进程对象和配置。 */
  status() {
    //M 公开快照先从程序自报授权生成标签，再核对当前实例是否仍有可用UI。
    const licenseLabel = protocolModule.getLicenseLabel(this.license);
    const ui = this.getUiUrl();
    return {
      name: this.spec.name, title: this.spec.title, state: this.state, note: this.note,
      port: this.ready?.port ?? null, pid: this.child?.pid ?? null,
      version: this.ready?.version ?? null, restarts: this.restarts,
      generation: this.generation, paused: this.paused, canPause: this.canPause,
      rssMb: this.rssMb, rssAt: this.rssAt, license: this.license, gaveUp: this.gaveUp,
      licenseLabel,
      ui,
    };
  }

  /** 返回内部可连的地址，启动中或退出时为空。 */
  getUrl(): string | undefined {
    if (this.state !== 'ready' || this.control?.signal.aborted === true) return undefined;

    return this.url;
  }

  /** 只给仍在运行且info声明了界面的自有实例生成主站地址：/programs/<名字> 接程序自报的界面路径。 */
  getUiUrl(): string | null {
    //G 地址只能来自当前已核实就绪且尚未停止的自有子进程。
    const url = this.getUrl();
    if (url === undefined || this.uiPath === null) return null;

    //M 转发把程序整个地址空间挂在 /programs/<名字> 下，界面路径原样接在后面。
    const name = encodeURIComponent(this.spec.name);
    return `/programs/${name}${this.uiPath}`;
  }

  /** 转发方只读取已验证的内部路径，不拿请求参数决定目标地址或端口。 */
  getUiPath(): string | null {
    //G 即使之前报过UI，停机与健康异常也不能再发放旧入口。
    const url = this.getUrl();
    if (url === undefined) return null;
    return this.uiPath;
  }

  /** 将原始Host状态映射为公开事件，只有业务字段变更才广播。 */
  private publishState(): void {
    if (this.ctx === undefined) return;

    //M 只取快照的业务字段形成签名，不把PID、RSS或计时变化当上下线。
    const status = this.status();
    let state: ProgramPhase = 'failed';
    if (status.state !== 'blocked') {
      state = status.state;
    }
    if (status.state === 'ready' && status.paused) {
      state = 'paused';
    }
    const event = {
      name: status.name,
      title: status.title,
      state,
      license: status.license ?? 'unknown',
      licenseLabel: status.licenseLabel,
      ui: status.ui,
    };
    const signature = JSON.stringify(event);
    //G 从未启动的Host原本就是stopped，关闭空实例不是一次状态变化。
    if (this.lastState === '' && state === 'stopped') {
      this.lastState = signature;
      return;
    }
    if (signature === this.lastState) return;

    this.lastState = signature;
    try {
      //M 其它插件订阅业务事件，不调用programs服务或依赖Host内部对象。
      this.ctx.emit('program/state', event);
    } catch (error) {
      //G 订阅方错误不能把本来健康的自有程序变成一次崩溃重启。
      const detail = textModule.getMessage(error);
      console.error(`program/state订阅方失败：${detail}`);
    }
  }

  /** 开始监督。用户再次启动时重新计数，已有进程时只保留一个监督。 */
  start(): void {
    if (this.supervisor !== undefined || this.child !== undefined) return;

    this.generation += 1;
    this.gaveUp = false;

    this.state = 'starting';
    this.note = '正在启动';
    this.restarts = 0;
    this.control = new AbortController();
    //M 监督任务有且只有一个，完成后释放用户再次启动的入口。
    this.supervisor = this.supervise(this.control.signal).finally(() => {
      this.supervisor = undefined;
      this.control = undefined;
    });
    //M 持有监督任务后才公告starting，避免同步订阅方重入时重复拉起。
    this.publishState();
  }

  /** 停止监督、取消退避，等待当前子进程按标准退出。 */
  async stop(): Promise<void> {
    this.generation += 1;
    //M 先中止本轮的等待，让监督任务进入退出清理。
    this.control?.abort();
    //M 停止等待期间立即移除UI，避免把仍显示ready的旧端口继续给网页。
    this.publishState();
    await this.supervisor;

    //G 强制退出仍未完成时保留失败状态和句柄，阻止重复拉起。
    if (this.child !== undefined) return;

    this.state = 'stopped';
    this.note = '已停止';
    //M 正常关闭完成后公告stopped，不伪造仍在线。
    this.publishState();
  }

  /** 宿主表建立后接入同插件守卫，不触发采样或启动。 */
  setGuard(guard: ResourceGuard): void {
    this.guard = guard;
  }

  /** 宿主表建立后接入同插件的渠道回调，拉起子进程时向它要回调地址。 */
  setBridge(bridge: ChannelBridge): void {
    this.bridge = bridge;
  }

  /** 当前子进程的密钥；渠道回调核对身份、主程序调程序的渠道接口时用。没有子进程是 undefined。 */
  getKey(): string | undefined {
    //G 子进程退出到监督任务收尾之间也不认旧密钥。
    const child = this.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return undefined;

    return this.key;
  }

  /** 只请求当前自有、已确认能力的进程，返回实际确认是否成功。 */
  async pause(paused: boolean): Promise<boolean> {
    //M 只从本Host已核实身份的就绪地址发暂停请求。
    const url = this.getUrl();
    const child = this.child;
    const signal = this.control?.signal;
    if (url === undefined || child === undefined || signal === undefined || !this.canPause) return false;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (this.paused === paused) return true;

    const generation = this.generation;
    //M 暂停只走协议，不用进程级挂起，查询等前台能力照常工作。
    const confirmed = await protocolModule.requestPause(url, paused, signal);
    if (!confirmed || signal.aborted || this.child !== child || generation !== this.generation) return false;

    this.paused = paused;
    //M 暂停只改后台状态，查询界面仍可使用，事件显示paused。
    this.publishState();
    return true;
  }

  /** 进程即刻退出时同步清理，直接使用自己持有的进程句柄。 */
  killOnExit(): void {
    const child = this.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;

    try {
      //M 同步退出阶段只允许直接结束自己的子进程。
      child.kill('SIGKILL');
    } catch {
      // 已退出时不需要处理。
    }
  }

  /** 等候重试，按过去十分钟内的失败次数退避或放弃。 */
  private async supervise(signal: AbortSignal): Promise<void> {
    let crashes: number[] = [];
    const wait = { signal };
    try {
      while (!signal.aborted) {
        if (this.guard !== undefined) {
          const request = { action: 'can-start' as const, heavy: this.spec.heavy, who: this.spec.name };
          //M 自动重试也必须过守卫，不能绕过CPU或内存门槛拉起新进程。
          const allowed = await this.guard.request(request);
          if (signal.aborted) return;
          if (!allowed.ok) {
            this.note = allowed.reason;
            await timers.setTimeout(this.timing.watchMs, undefined, wait);
            continue;
          }
        }

        //G 程序还未安装时定期再看，安装前的等待不计作崩溃。
        if (!fs.existsSync(this.launch.command)) {
          this.note = `程序不在：${this.launch.command}`;
          await timers.setTimeout(this.timing.missingMs, undefined, wait);
          continue;
        }

        //M 运行单个进程实例，直到它退出或需要重启。
        this.note = '正在等就绪行';
        await this.runChild(signal);
        if (signal.aborted || this.state === 'blocked' || this.child !== undefined) return;

        //M 只保留窗口内的失败，达到上限后等待用户重新启动。
        const now = Date.now();
        const threshold = now - this.timing.crashWindowMs;
        crashes = crashes.filter((at) => at >= threshold);
        crashes.push(now);
        if (crashes.length >= MAX_CRASHES) {
          this.state = 'failed';
          this.gaveUp = true;
          this.note = `10 分钟内连续失败 ${String(MAX_CRASHES)} 次，已放弃自动重启。最后一次：${this.note}`;
          //M 连崩放弃是failed状态，而非授权失败或用户停机。
          this.publishState();
          return;
        }

        const delay = Math.min(this.timing.retryMaxMs, this.timing.retryMs * 2 ** (crashes.length - 1));
        this.state = 'starting';
        this.note = `${this.note}，${String(delay / 1000)} 秒后重试`;
        //M 退避阶段仍属于starting，界面入口保持撤下。
        this.publishState();

        //M 重试等待可中止，用户关停后不会被定时器再次拉起。
        await timers.setTimeout(delay, undefined, wait);
        this.restarts += 1;
      }
    } catch (error) {
      //G 取消重试或退出属于正常停止，其他监督错误记下来供定位。
      if (signal.aborted) return;

      //M 留下没有进入正常启停路径的错误原因。
      this.state = 'failed';
      this.note = textModule.getMessage(error);
      //M 监督异常也有明确状态回执，不让界面停在ready。
      this.publishState();
    }
  }

  /** 启动一个实例并监控，离开前回收该实例以及它的日志管道。 */
  private async runChild(signal: AbortSignal): Promise<void> {
    let fd: number | undefined;
    let reader: readline.Interface | undefined;
    let output: stream.Readable | undefined;
    let endpoint: string | undefined;
    try {
      //M 每次拉起换一把新密钥，只放进这个子进程的环境变量，不写日志、不进配置。
      const key = crypto.randomBytes(32).toString('base64url');
      const env: Record<string, string | undefined> = { ...this.launch.env, [protocolModule.KEY_ENV]: key };
      delete env[protocolModule.CALLBACK_ENV];

      //M 登记了渠道的程序还要知道往哪回调；主服务没开始监听前在这里等着，停止时随 signal 取消。
      const callback = await this.bridge?.getCallbackUrl(this.spec, signal);
      if (callback !== undefined) {
        env[protocolModule.CALLBACK_ENV] = callback;
      }
      this.key = key;

      const logDir = path.dirname(this.logPath);
      fs.mkdirSync(logDir, { recursive: true });
      fd = fs.openSync(this.logPath, 'a');
      const command = [this.launch.command, ...this.launch.args];
      const options = {
        cwd: this.launch.cwd, env,
        stdin: 'ignore', stdout: 'pipe', stderr: fd, windowsHide: true,
      } as const;

      //M 不套命令行外壳，读子进程的 stdout 并隐藏 Windows 控制台。
      const child: Child = Bun.spawn(command, options);
      this.child = child;
      const death = new AbortController();
      void child.exited.then(() => death.abort(), () => death.abort());
      const lifetime = AbortSignal.any([signal, death.signal]);

      //M 从同一 stdout 管道识别端口，继续读剩余行防止进程阻塞。
      const stdout = child.stdout as unknown as Parameters<typeof stream.Readable.fromWeb>[0];
      output = stream.Readable.fromWeb(stdout);
      reader = readline.createInterface({ input: output, crlfDelay: Infinity });
      reader.once('error', (error) => death.abort(error));
      const log = fd;
      reader.on('line', (line) => {
        try {
          fs.writeSync(log, `${line}\n`);
        } catch (error) {
          console.error(`外部程序 ${this.spec.name} 写启动日志失败：${textModule.getMessage(error)}`);
        }
      });

      //M 就绪行报端口，info 身份正确后才能向该程序转发或请求退出。
      const ready = await protocolModule.waitReady(reader, this.spec, lifetime);
      let host = this.spec.host;
      if (host.includes(':')) host = `[${host}]`;
      const url = `http://${host}:${String(ready.port)}`;
      const report = await protocolModule.readReport(url, this.spec.name, 'info', this.timing.healthMs, lifetime);
      lifetime.throwIfAborted();
      if (report === undefined) {
        throw new Error('程序 info 接口无有效身份回执');
      }
      this.canPause = report.pause;
      this.uiPath = report.ui;
      this.rssMb = report.rssMb;
      this.rssAt = Date.now();
      //M 身份核实后才读取授权；过期不杀程序，只供守卫通知。
      this.license = await protocolModule.readLicense(url, lifetime);
      lifetime.throwIfAborted();

      endpoint = url;
      this.ready = ready;
      this.url = endpoint;
      this.state = 'ready';
      this.note = '在运行';
      //M 身份、授权和info都已核对，现在才公告ready及同源UI地址。
      this.publishState();

      //M 程序托管期间只问快速健康接口，连续失败才重启。
      await this.watchHealth(endpoint, lifetime);
    } catch (error) {
      if (signal.aborted) return;

      if (error instanceof protocolModule.UnsupportedProtocol) {
        this.state = 'blocked';
        this.note = error.message;
        //M 协议不兼容保留内部blocked，事件对外报告failed。
        this.publishState();
        return;
      }
      const child = this.child;
      if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
        const code = child.exitCode ?? child.signalCode;
        this.note = `程序已退出（${String(code)}）`;
        return;
      }

      //M 留下启动超时、进程管道或健康接口的错误说明。
      this.note = textModule.getMessage(error);
    } finally {
      //M 子进程要退了，它的密钥立刻作废，之后带这把钥匙的回调一律拒。
      this.key = undefined;
      this.url = undefined;
      this.ready = undefined;
      this.paused = false;
      this.canPause = false;
      this.rssMb = undefined;
      this.rssAt = 0;
      this.license = undefined;
      this.uiPath = null;
      //M 退出/重试清理时先撤入口，不等整段正常停止流程结束。
      this.publishState();

      //M 正常退出和重启都只回收当前实例，先等退出接口再用强制手段。
      try {
        await this.releaseChild(endpoint);
      } finally {
        reader?.close();
        output?.destroy();
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  }

  /** 定期核对活着的程序，达连续失败阈值后交给监督任务重启。 */
  private async watchHealth(endpoint: string, signal: AbortSignal): Promise<void> {
    let misses = 0;
    let licenseAt = Date.now();
    const wait = { signal };
    while (!signal.aborted) {
      await timers.setTimeout(this.timing.watchMs, undefined, wait);

      //M 独立探测健康接口，连接失败与身份不符都算一次失败。
      const report = await protocolModule.readReport(
        endpoint, this.spec.name, 'health', this.timing.healthMs, signal,
      );
      signal.throwIfAborted();
      if (report !== undefined) {
        this.rssMb = report.rssMb;
        this.rssAt = Date.now();
        if (Date.now() - licenseAt >= 60_000) {
          //M 每分钟更新一次授权，缺接口或失败保持未知，不把未知当未授权。
          this.license = await protocolModule.readLicense(endpoint, signal);
          signal.throwIfAborted();
          licenseAt = Date.now();
          //M 授权状态变化单独广播，不把授权到期当停机。
          this.publishState();
        }
        misses = 0;
        this.note = '在运行';
        continue;
      }
      misses += 1;
      this.note = `健康检查连续失败 ${String(misses)} 次`;
      if (misses >= this.timing.healthMisses) {
        this.state = 'unhealthy';
        //M 健康异常不再提供ready入口，后续正常停止/重试由监督处理。
        this.publishState();
        return;
      }
    }
  }

  /** 先让程序退出，超时后仅结束所持句柄对应的进程。 */
  private async releaseChild(endpoint: string | undefined): Promise<void> {
    const child = this.child;
    if (child === undefined) return;

    if (endpoint !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        //M 已确认身份的程序可以自己收尾，等待它完成退出。
        await protocolModule.requestExit(endpoint, this.spec.exitWaitMs);
      } catch {
        // 退出请求失败时仍给进程一段收尾时间。
      }
      //M 退出请求回来后仍需等到进程退出，确保下次启动不冲突。
      const exited = await waitExit(child, this.spec.exitWaitMs);
      if (exited) {
        this.child = undefined;
        return;
      }
    }

    //M 未就绪或超时未退，用已保存的进程号结束它和子进程。
    if (child.exitCode === null && child.signalCode === null) await killTree(child);

    //M 强制命令返回后继续核对子进程的退出通知。
    const exited = await waitExit(child, FORCE_WAIT_MS);
    if (exited) {
      this.child = undefined;
      return;
    }
    this.state = 'failed';
    this.note = `进程 ${String(child.pid)} 强制结束后仍未退出`;
    //M 回收失败也要报告failed，不能遗留ready事件或再启动另一实例。
    this.publishState();
  }
}

/** 等子进程实际退出，提前结束时撤销定时器。 */
async function waitExit(child: Child, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  const timeout = new AbortController();
  const wait = { signal: timeout.signal };
  const expired = timers.setTimeout(ms, false, wait);
  const exited = child.exited.then(() => true, () => true);
  try {
    //M 用退出通知和上限时间竞争，保证关停有界。
    return await Promise.race([expired, exited]);
  } finally {
    timeout.abort();
  }
}

/** Windows 优先结束整棵树，其他平台按自己的进程句柄结束。 */
async function killTree(child: Child): Promise<void> {
  if (process.platform === 'win32') {
    const command = ['taskkill.exe', '/F', '/T', '/PID', String(child.pid)];
    const signal = AbortSignal.timeout(FORCE_WAIT_MS);
    const options = { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true, signal } as const;
    try {
      //M 用 taskkill 回收该子进程派生的程序，限制等待并隐藏窗口。
      const killer = Bun.spawn(command, options);
      if (await killer.exited === 0) return;
    } catch {
      // taskkill 不可用时仍可以使用当前子进程句柄。
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    //M 始终用原句柄作为强制退出的末级路径。
    child.kill('SIGKILL');
  } catch {
    // 进程可能已退出，以退出通知为准。
  }
}
