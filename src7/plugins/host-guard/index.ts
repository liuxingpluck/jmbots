/**
 * 宿主机守卫（host-guard）：只盯宿主机两条硬线（用户 #442/#443）——物理内存不超过 60 GB、显存不超过 15.5 GB，不管 CPU。
 * 纯观测 + 告警 + 只读诊断，绝不杀进程：
 *   1. 每 interval_sec 秒采样一次；每条线各记一个状态（ok / warn / exceeded / unknown）；
 *   2. 超线且离上次同线告警过了 cooldown_sec 才发一次告警，顺带拉一次占用前 5 的进程；
 *   3. 告警后连续 2 次 ok 才发“已回落安全线”，免得在线附近抖动刷屏；
 *   4. 告警发事件 host-guard/alert，配了 notify_feishu 再写一份进飞书发件箱；最近 50 条留在内存里；
 *   5. GET /api/host-guard/status 看快照，POST /api/host-guard/check 立刻采一次（要核验）；
 *   6. 模型工具 host_guard_status 只给本人用，外人（飞书外群、客户）拒答。
 * 和 programs 插件资源守卫的分工：programs 管自己托管的程序（准入、暂停、关停），本插件只看宿主机整机、只报不动手。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import * as channels from '../channels/index.ts';
import * as probeModule from './Probe.ts';
import type * as types from './Types.ts';

export type * from './Types.ts';


/** 插件名。 */
export const name = 'host-guard';

//M 1.0.0：内存 60GB / 显存 15.5GB 两条硬线采样、冷却防刷屏、连续 2 次回落才解警、状态与手动采样接口、本人专用工具。
/** 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。 */
export const version = '1.0.0';

/** 用到的服务：resources 找飞书发件箱；http 挂接口；tools 登记工具。 */
export const inject = ['resources', 'http', 'tools'];


declare module 'cordis' {
  interface Events {
    /**
     * 宿主机某条线超线或回落；只是通知。
     * 谁发：src7/plugins/host-guard/index.ts 的 HostGuard.deliver
     * 谁接：暂无
     */
    'host-guard/alert'(alert: types.HostAlert): void;
  }
}


/** 1 GB（GiB）的字节数；和 programs 资源守卫同口径。 */
const GIB = 1024 ** 3;

/** 告警后连续几次 ok 才算回落。 */
const RECOVER_SAMPLES = 2;

/** 内存里最多留几条告警。 */
const MAX_ALERTS = 50;

/** 两条线的中文名，拼告警和工具回答用。 */
const LINE_TITLES: Record<types.LineName, string> = { ram: '内存', vram: '显存' };


/** 一条线在守卫里的状态。 */
interface LineState {
  /** 最近一次读数；读不到是 null。 */
  usage: types.Usage | null;
  /** 最近一次的档位。 */
  level: types.LineLevel;
  /** 发过超线告警、还没确认回落。 */
  alerting: boolean;
  /** 告警中连续 ok 了几次。 */
  okStreak: number;
  /** 上次发超线告警的时刻，Unix 毫秒；没发过是 null。 */
  lastExceededAt: number | null;
}


/**
 * 解析 config.yaml 里 host-guard 这一段（入口校验一次，补齐默认值）。
 * @param raw 插件配置原样；没写或写 true 用全部默认值。
 * @returns 校验过的配置。
 * @throws 类型不对、超范围、预警线不低于红线时抛错，插件挂不上。
 */
export function parseConfig(raw: unknown): types.HostGuardConfig {
  //M 没写配置就当空对象，下面逐项补默认值。
  let record: Record<string, unknown> = {};
  if (raw !== undefined && raw !== true) {
    record = checksModule.checkRecord(raw, 'plugins.host-guard');
  }

  //M 容量线都要是正数；预警线默认比红线低一截。
  const key = 'plugins.host-guard';
  const positive = { above: 0 };
  const maxRamGb = checksModule.checkNumber(record['max_ram_gb'] ?? 60, `${key}.max_ram_gb`, positive);
  const warnRamGb = checksModule.checkNumber(record['warn_ram_gb'] ?? 54, `${key}.warn_ram_gb`, positive);
  const maxVramGb = checksModule.checkNumber(record['max_vram_gb'] ?? 15.5, `${key}.max_vram_gb`, positive);
  const warnVramGb = checksModule.checkNumber(record['warn_vram_gb'] ?? 14, `${key}.warn_vram_gb`, positive);

  //G 预警线要比红线低，不然 warn 档永远到不了。
  if (warnRamGb >= maxRamGb) throw new Error('plugins.host-guard.warn_ram_gb 要比 max_ram_gb 小');
  if (warnVramGb >= maxVramGb) throw new Error('plugins.host-guard.warn_vram_gb 要比 max_vram_gb 小');

  //M 采样间隔 5～600 秒的整数；冷却不小于 0 的整数秒。
  const intervalRule = { integer: true, min: 5, max: 600 };
  const intervalSec = checksModule.checkNumber(record['interval_sec'] ?? 30, `${key}.interval_sec`, intervalRule);
  const cooldownRule = { integer: true, min: 0 };
  const cooldownSec = checksModule.checkNumber(record['cooldown_sec'] ?? 300, `${key}.cooldown_sec`, cooldownRule);

  //M 飞书开关和 nvidia-smi 的命令名。
  const notifyFeishu = checksModule.checkFlag(record['notify_feishu'] ?? false, `${key}.notify_feishu`);
  const nvidiaSmi = checksModule.checkNonEmptyText(record['nvidia_smi'] ?? 'nvidia-smi', `${key}.nvidia_smi`);

  return { maxRamGb, warnRamGb, maxVramGb, warnVramGb, intervalSec, cooldownSec, notifyFeishu, nvidiaSmi };
}


/**
 * 字节换成 GB，保留一位小数。
 * @param bytes 字节数。
 * @returns GB。
 */
function getGb(bytes: number): number {
  return Math.round((bytes / GIB) * 10) / 10;
}


/**
 * 按红线、预警线定档位。
 * @param usage 读数；null 是读不到。
 * @param maxGb 红线。
 * @param warnGb 预警线。
 * @returns 档位。
 */
export function getLevel(usage: types.Usage | null, maxGb: number, warnGb: number): types.LineLevel {
  if (usage === null) return 'unknown';

  const usedGb = usage.used / GIB;
  if (usedGb >= maxGb) return 'exceeded';
  if (usedGb >= warnGb) return 'warn';

  return 'ok';
}


/** 守卫本体：采样、状态机、告警、快照。 */
export class HostGuard {
  /** 内存线和显存线的状态。 */
  private readonly lines: Record<types.LineName, LineState> = {
    ram: { usage: null, level: 'unknown', alerting: false, okStreak: 0, lastExceededAt: null },
    vram: { usage: null, level: 'unknown', alerting: false, okStreak: 0, lastExceededAt: null },
  };

  /** 最近最多 50 条告警。 */
  private readonly alerts: types.HostAlert[] = [];

  /** 最近一次超线告警时拉的占用前 5。 */
  private readonly top: Record<types.LineName, types.TopProcess[]> = { ram: [], vram: [] };

  /** 最近一次采样时刻；没采过是 null。 */
  private sampledAt: number | null = null;

  /** 正在进行的采样；定时器、接口、工具同时要时共用这一次。 */
  private running: Promise<types.HostSnapshot> | null = null;

  /**
   * @param ctx 插件 ctx：发 host-guard/alert 事件、找运行时目录写飞书发件箱。
   * @param config parseConfig 校验过的配置。
   * @param probes 探针：正式是 Probe.ts 的 createProbes，测试传假的。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly config: types.HostGuardConfig,
    private readonly probes: types.HostProbes,
  ) {}

  /**
   * 采一次样并更新状态；同时有人在采就等那一次。
   * @returns 采完后的快照。
   */
  check(): Promise<types.HostSnapshot> {
    if (this.running !== null) return this.running;

    this.running = this.sample().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * 当前快照（不采样）。
   * @returns 两条线的状态、最近告警、最近一次的占用前 5。
   */
  getSnapshot(): types.HostSnapshot {
    const ram = this.getLineStatus('ram', this.config.maxRamGb, this.config.warnRamGb);
    const vram = this.getLineStatus('vram', this.config.maxVramGb, this.config.warnVramGb);
    return {
      sampledAt: this.sampledAt,
      ram,
      vram,
      gpuAvailable: this.lines.vram.usage !== null,
      exceeded: ram.level === 'exceeded' || vram.level === 'exceeded',
      alerts: [...this.alerts],
      top: { ram: [...this.top.ram], vram: [...this.top.vram] },
    };
  }

  /**
   * 真正的一次采样：两条线一起读，各自走状态机，有告警就发。
   * @returns 采完后的快照。
   */
  private async sample(): Promise<types.HostSnapshot> {
    //M 内存和显存一起读；探针自己保证不抛错。
    const [ram, vram] = await Promise.all([this.probes.probeRam(), this.probes.probeVram()]);
    const now = this.probes.now();
    this.sampledAt = now;

    //M 两条线各自推进状态机，出了告警就发。
    const ramAlert = await this.advance('ram', ram, now, this.config.maxRamGb, this.config.warnRamGb);
    const vramAlert = await this.advance('vram', vram, now, this.config.maxVramGb, this.config.warnVramGb);
    for (const alert of [ramAlert, vramAlert]) {
      if (alert === null) continue;
      this.deliver(alert);
    }
    return this.getSnapshot();
  }

  /**
   * 一条线的状态机。
   * @param line 哪条线。
   * @param usage 这次读数；null 是读不到。
   * @param now 采样时刻。
   * @param maxGb 红线。
   * @param warnGb 预警线。
   * @returns 要发的告警；不用发交回 null。
   */
  private async advance(
    line: types.LineName,
    usage: types.Usage | null,
    now: number,
    maxGb: number,
    warnGb: number,
  ): Promise<types.HostAlert | null> {
    const state = this.lines[line];
    state.usage = usage;
    state.level = getLevel(usage, maxGb, warnGb);

    //G 读不到：不告警，也不算回落，回落计数清零。
    if (usage === null) {
      state.okStreak = 0;
      return null;
    }

    //==========================================================
    //M 超线：离上次同线告警过了冷却才发，顺带拉一次占用前 5
    //==========================================================
    if (state.level === 'exceeded') {
      state.okStreak = 0;
      const last = state.lastExceededAt;
      const cooldownMs = this.config.cooldownSec * 1000;
      if (last !== null && now - last < cooldownMs) return null;

      state.lastExceededAt = now;
      state.alerting = true;
      //M 占用前 5 只在发告警时拉一次，探针自己限时 4 秒、失败给空数组。
      const top = await this.probes.probeTop(line);
      this.top[line] = top;
      return this.getAlert(line, 'exceeded', usage, top, now, maxGb);
    }

    //==========================================================
    //M 回落：告警中连续 2 次 ok 才发一次“已回落安全线”
    //==========================================================
    if (!state.alerting) return null;

    //G 预警档不算回落，计数清零。
    if (state.level !== 'ok') {
      state.okStreak = 0;
      return null;
    }
    state.okStreak += 1;
    if (state.okStreak < RECOVER_SAMPLES) return null;

    state.alerting = false;
    state.okStreak = 0;
    return this.getAlert(line, 'recovered', usage, [], now, maxGb);
  }

  /**
   * 拼一条告警。
   * @param line 哪条线。
   * @param kind 超线还是回落。
   * @param usage 当时读数。
   * @param top 占用前 5。
   * @param now 时刻。
   * @param maxGb 红线。
   * @returns 告警，text 是给人看的一句话。
   */
  private getAlert(
    line: types.LineName,
    kind: types.HostAlert['kind'],
    usage: types.Usage,
    top: types.TopProcess[],
    now: number,
    maxGb: number,
  ): types.HostAlert {
    const usedGb = getGb(usage.used);
    const totalGb = getGb(usage.total);
    const title = LINE_TITLES[line];

    //M 回落：一句话。
    if (kind === 'recovered') {
      const text = `宿主机${title}已回落安全线：已用 ${String(usedGb)} GB（红线 ${String(maxGb)} GB）。`;
      return { at: now, line, kind, usedGb, maxGb, top, text };
    }

    //M 超线：用量、红线、总量，再列占用前 5。
    let text = `⚠️ 宿主机${title}超线：已用 ${String(usedGb)} GB / 红线 ${String(maxGb)} GB（总 ${String(totalGb)} GB）。`;
    if (top.length > 0) {
      const names = top.map((item) => `${item.name}(${String(item.pid)}) ${String(item.mb)}MB`);
      text += `占用前 ${String(top.length)}：${names.join('、')}。`;
    }
    text += '守卫只报不杀进程，请自行处理。';
    return { at: now, line, kind, usedGb, maxGb, top, text };
  }

  /**
   * 发一条告警：记进历史、发事件，配了就写飞书发件箱。
   * @param alert 告警。
   * 副作用：emit host-guard/alert；notify_feishu 时在 <运行时>/integrations/feishu/outbox/ 原子写一个 .md。
   */
  private deliver(alert: types.HostAlert): void {
    //M 记进历史，只留最近 50 条。
    this.alerts.push(alert);
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts.splice(0, this.alerts.length - MAX_ALERTS);
    }

    //M 发事件，谁想接谁接。
    this.ctx.emit('host-guard/alert', alert);

    //M 飞书：先写 .tmp 再改名成 .md，发件箱扫描不会读到半份。
    if (!this.config.notifyFeishu) return;

    const outbox = path.join(this.ctx.resources.root, 'integrations', 'feishu', 'outbox');
    const basename = `${String(alert.at)}_host-guard_${crypto.randomUUID()}`;
    const pending = path.join(outbox, `${basename}.tmp`);
    filesModule.ensureDir(outbox);
    fs.writeFileSync(pending, alert.text, { flag: 'wx' });
    fs.renameSync(pending, path.join(outbox, `${basename}.md`));
  }

  /**
   * 一条线的对外状态。
   * @param line 哪条线。
   * @param maxGb 红线。
   * @param warnGb 预警线。
   * @returns LineStatus。
   */
  private getLineStatus(line: types.LineName, maxGb: number, warnGb: number): types.LineStatus {
    const state = this.lines[line];
    let usedGb: number | null = null;
    let totalGb: number | null = null;
    if (state.usage !== null) {
      usedGb = getGb(state.usage.used);
      totalGb = getGb(state.usage.total);
    }
    return { usedGb, totalGb, maxGb, warnGb, level: state.level, alerting: state.alerting };
  }
}


/**
 * 把快照说成给模型看的几行字。
 * @param snapshot 快照。
 * @returns 文字。
 */
export function describeSnapshot(snapshot: types.HostSnapshot): string {
  const lines: string[] = [];
  for (const line of ['ram', 'vram'] as const) {
    const status = snapshot[line];
    const title = LINE_TITLES[line];
    if (status.usedGb === null) {
      lines.push(`${title}：读不到（档位 unknown）。`);
      continue;
    }
    lines.push(`${title}：已用 ${String(status.usedGb)} GB / 总 ${String(status.totalGb)} GB，`
      + `红线 ${String(status.maxGb)} GB、预警 ${String(status.warnGb)} GB，档位 ${status.level}。`);
  }

  //M 有告警就带上最近一条。
  const latest = snapshot.alerts.at(-1);
  if (latest !== undefined) {
    lines.push(`最近告警（${textModule.formatLocalTime(latest.at, 'date')}）：${latest.text}`);
  }
  return lines.join('\n');
}


/**
 * 挂上守卫：解析配置、建守卫、挂两条接口、登记工具、起定时采样。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config config.yaml 里 host-guard 这一段。
 * @param probes 测试传假探针；正式不传，用 Probe.ts 的 createProbes。
 * 副作用：在 ctx.http.app 上登记两条接口；登记工具 host_guard_status；起一个定时器，插件拔掉时撤。
 */
export function apply(ctx: cordis.Context, config?: unknown, probes?: types.HostProbes): void {
  const settings = parseConfig(config);
  let usedProbes = probes;
  if (usedProbes === undefined) {
    usedProbes = probeModule.createProbes(settings.nvidiaSmi);
  }
  const guard = new HostGuard(ctx, settings, usedProbes);

  //==========================================================
  //M 接口：GET 看快照（只读），POST 立刻采一次（要核验）
  //==========================================================
  const app = ctx.http.app;
  app.get('/api/host-guard/status', async () => guard.getSnapshot());
  app.post('/api/host-guard/check', async (request) => {
    if (!ctx.http.isVerified(request)) throw new failureModule.Failure(403, '手动采样需要核验过的访问');

    return guard.check();
  });

  //==========================================================
  //M 工具：只给本人看宿主机内存和显存
  //==========================================================
  ctx.tools.register({
    definition: {
      name: 'host_guard_status',
      description: '查宿主机（跑 jmbots 的这台电脑）现在内存和显存各用了多少、离红线多远、最近有没有超线告警。只读，不改任何东西。',
      parameters: piAi.Type.Object({}),
    },
    sessionKinds: ['front', 'work'],
    run: async (_args, session: Session) => {
      //G 只给本人：外群、客户、访客问一律拒答。
      if (!channels.isOwnerTurn(session.row.channel, session.row.address)) {
        throw new Error('宿主机资源情况只回答本人，这一轮不是本人在问，请婉拒。');
      }
      const snapshot = await guard.check();
      return describeSnapshot(snapshot);
    },
  });

  //==========================================================
  //M 定时采样：挂上先采一次，之后每 interval_sec 秒一次；拔掉时撤
  //==========================================================
  ctx.effect(() => {
    const tick = (): void => {
      guard.check().catch((error: unknown) => {
        console.error(`host-guard 采样出错：${textModule.getErrorMessage(error)}`);
      });
    };
    tick();
    const timer = setInterval(tick, settings.intervalSec * 1000);
    return () => clearInterval(timer);
  });
}
