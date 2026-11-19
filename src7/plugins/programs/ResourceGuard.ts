/** programs内部资源守卫：状态迟滞、事件准入、GPU短期预留与自有托管程序的有限恢复。 */
import type * as cordis from 'cordis';
import * as requestModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as probeModule from './ResourceProbe.ts';
import * as noticesModule from './GuardNotices.ts';
import type { Host } from './Host.ts';
import type { GuardSettings } from './Spec.ts';

/** 最新准入事件，不复用旧设计尚未实现的need/mb协议。 */
export interface ResourceRequest extends requestModule.RequestEnvelope {
  /** 当前仅支持开工前询问。 */
  action: 'can-start';
  /** 调用方名称；voice适用自己的8GiB预算。 */
  who?: string;
  /** 是否为CPU重活，缺省为true。 */
  heavy?: boolean;
  /** 预计新增显存，MiB；缺席表示CPU任务。 */
  vram_mb?: number;
  /** 调用方已驻留显存，MiB，voice用来核对自身总预算。 */
  owned_vram_mb?: number;
  /** 目标物理显卡索引，缺省0，不跨卡拼接空间。 */
  gpu?: number;
}

/** 配对回执；请求异常也返回明确拒绝，不使调用者空等。 */
export interface ResourceResult extends requestModule.ResultEnvelope {
  /** 只是当前准入，不承诺未来机器永不超限。 */
  ok: boolean;
  /** 可展示的中文理由，拒绝加载会带已用量、需求和上限。 */
  reason: string;
}

/** 档位变化时广播；原始读数也供后续消费者判断未知状态。 */
export interface ResourcePressure {
  /** 高线优先于CPU忙碌。 */
  level: 'ok' | 'busy' | 'high';
  /** 当前原因，不把未知读数写成空闲。 */
  reason: string;
  /** CPU迟滞状态。 */
  cpuBusy: boolean;
  /** 内存迟滞状态，60GiB进入、严格低于55GiB解除。 */
  memoryHigh: boolean;
  /** 逐卡显存迟滞合并状态。 */
  vramHigh: boolean;
  /** 本次系统读数，所有容量单位为字节。 */
  sample: probeModule.ResourceSample;
}

/** 测试只替换读数、时钟和入队出口，不触发真实探针或外发。 */
export interface GuardDependencies {
  /** 生产实现在ResourceProbe.read，测试提供有界的假读数函数。 */
  read?: (signal: AbortSignal) => Promise<probeModule.ResourceSample>;
  /** 生产实现在GuardNotices.send；true表示成功入队，测试只收集正文。 */
  notify?: (key: string, text: string, at: number) => boolean;
  /** 生产使用Date.now，测试控制经过时间而不等待真实30秒。 */
  now?: () => number;
}

/** 仅暴露本插件Host的守卫所需方法，测试可提供同形假宿主。 */
export type GuardHost = Pick<Host, 'spec' | 'status' | 'pause' | 'stop' | 'start'>;

/** 一条尚未反映在驱动采样中的短期预留，不代表永久的模型配额。 */
interface Reservation {
  /** 目标显卡索引。 */
  gpu: number;
  /** 调用方。 */
  who: string;
  /** 本次预留字节数。 */
  bytes: number;
  /** 过期Unix毫秒。 */
  until: number;
}

declare module 'cordis' {
  interface Events {
    /**
     * 资源档位变更，后续插件自行接线，不直接调用别的插件。
     * 谁发：src7/plugins/programs/ResourceGuard.ts 的 ResourceGuard.updatePressure
     * 谁接：src7/plugins/memory/ChannelBackfill.ts 的 ChannelBackfill.constructor
     */
    'resource/pressure'(pressure: ResourcePressure): void;
    /**
     * 开重活/加载模型前询问，监听器同步标handled。
     * 谁发：src7/plugins/memory/ChannelBackfill.ts 的 ChannelBackfill.backfill；src7/plugins/voice/Routes.ts 的 allowLocal
     * 谁接：src7/plugins/programs/ResourceGuard.ts 的 ResourceGuard.constructor
     */
    'resource/request'(request: ResourceRequest): void | Promise<void>;
    /**
     * 使用同一requestId返回明确准入或拒绝。
     * 谁发：src7/plugins/programs/ResourceGuard.ts 的 ResourceGuard.constructor
     * 谁接：src7/plugins/memory/ChannelBackfill.ts 的 ChannelBackfill.backfill；src7/plugins/voice/Routes.ts 的 allowLocal
     */
    'resource/result'(result: ResourceResult): void;
  }
}

/** 只管理构造时传入的本插件Host，绝不枚举或杀系统其他进程。 */
export class ResourceGuard {
  /** 系统读数依赖，生产只有此处创建探针。 */
  private readonly read: NonNullable<GuardDependencies['read']>;
  /** 通知入队依赖，生产只写小文件。 */
  private readonly deliver: NonNullable<GuardDependencies['notify']>;
  /** 经过时间与去重共用同一时钟。 */
  private readonly now: () => number;
  /** 取消当前探针，卸载后不再发通知或启动Host。 */
  private readonly control = new AbortController();
  /** 只允许一个定时执行任务。 */
  private ticking?: Promise<void>;
  /** 同时到来的请求共享一次正在执行的探针。 */
  private sampling?: Promise<probeModule.ResourceSample>;
  /** ready后开启的周期计时器。 */
  private timer?: ReturnType<typeof setInterval>;
  /** 最后成功或未知的资源快照。 */
  private current: probeModule.ResourceSample = { at: 0, cpu: null, memory: null, totalMemory: null, gpus: null };
  /** CPU忙碌迟滞。 */
  private cpuBusy = false;
  /** 这一段CPU忙从哪一刻开始；连续忙满一分钟才通知用户。 */
  private cpuSince?: number;
  /** 内存高位迟滞。 */
  private memoryHigh = false;
  /** 各显卡高位迟滞，失去读数不等于恢复。 */
  private readonly gpuHigh = new Map<number, boolean>();
  /** 上次广播的档位签名，数值更新不刷屏。 */
  private signature = '';
  /** 当前连续达到内存硬线的起点。 */
  private highSince?: number;
  /** 一个迟滞周期最多正常停止一个可关闭程序。 */
  private shed = false;
  /** 即使没有可暂停程序，跨恢复线也需要一条恢复通知。 */
  private recoveryPending = false;
  /** 守卫确实暂停成功的宿主及管理代次。 */
  private readonly paused = new Map<GuardHost, number>();
  /** 守卫正常停止的宿主及预期管理代次。 */
  private readonly stopped = new Map<GuardHost, number>();
  /** 成功入队的本实例去重缓存。 */
  private readonly notices = new Map<string, number>();
  /** GPU准入预留，防并发请求共享同一份空闲显存。 */
  private reservations: Reservation[] = [];

  /** 建立事件与生命周期；没有ready或显式tick就不采样、不操作进程。 */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly settings: GuardSettings,
    private readonly hosts: readonly GuardHost[],
    dependencies: GuardDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    //M 构造只读探针，不在插件挂载时读取显卡或创建进程。
    const probe = new probeModule.ResourceProbe(settings.nvidiaSmi);
    //M 生产使用探针；测试提供假读数函数，不依赖机器负载。
    this.read = dependencies.read ?? ((signal) => probe.read(signal));
    let deliver = dependencies.notify;
    if (deliver === undefined) {
      //M 生产保存发件箱适配，构造时不创建运行时目录或发送消息。
      const notices = new noticesModule.GuardNotices(ctx.resources.root);
      deliver = (key, text, at) => notices.send(key, text, at);
    }
    this.deliver = deliver;
    const onRequest = (request: ResourceRequest) => this.request(request);
    const options = { onError: () => ({ ok: false, reason: '资源守卫暂时无法核实，未放行' }) };
    //M 配对回执工具先同步标handled；异常也明确拒绝，避免调用方一直等待。
    requestModule.onRequestEvent(ctx, 'resource/request', 'resource/result', onRequest, options);
    ctx.on('ready', () => this.start());
    ctx.effect(() => () => this.dispose());
  }

  /** 交回快照副本，调用方不能篡改守卫的原始读数。 */
  resources(): probeModule.ResourceSample {
    return structuredClone(this.current);
  }

  /** ready后的首次采样及周期采样；重复ready不创建第二个计时器。 */
  private start(): void {
    if (this.control.signal.aborted || this.timer !== undefined) return;

    //M 周期任务由tick防重入，慢探针和Host停止不会堆积多轮动作。
    this.timer = setInterval(() => { void this.tick(); }, this.settings.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** 卸载先取消读数和新动作，再等待已在进行的有界任务收尾，不自动恢复程序。 */
  async dispose(): Promise<void> {
    this.control.abort();
    clearInterval(this.timer);
    await Promise.allSettled([this.sampling, this.ticking]);
    this.reservations = [];
  }

  /** 完成一轮采样及守卫动作，多个调用合并成同一任务。 */
  tick(): Promise<void> {
    if (this.control.signal.aborted) return Promise.resolve();
    if (this.ticking !== undefined) return this.ticking;

    //M finally释放执行权，失败不让之后所有采样永久卡住。
    this.ticking = this.runTick().catch((error: unknown) => {
      if (this.control.signal.aborted) return;

      //M 将内部错误转为可读诊断，不影响后续采样或清理。
      const detail = textModule.getErrorMessage(error);
      console.error(`资源守卫本轮动作失败：${detail}`);
    }).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  /** 入口校验请求，获取新读数，再同步计算并登记预留，计算和记账之间不await。 */
  async request(request: ResourceRequest): Promise<Omit<ResourceResult, 'requestId'>> {
    //M 事件参数只在此准入边界校验一次。
    const invalid = this.checkRequest(request);
    if (invalid !== undefined) return { ok: false, reason: invalid };
    if (this.control.signal.aborted) return { ok: false, reason: '资源守卫已关闭，未放行' };

    //M 先等本轮读数完成，再做准入或守卫动作，不沿用旧的空闲判断。
    const sample = await this.refresh();
    if (this.control.signal.aborted) return { ok: false, reason: '资源守卫已关闭，未放行' };

    //M 准入、迟滞与通知使用同一可注入时钟，测试不用等待真实时间。
    const now = this.now();
    const maxAge = Math.max(10_000, this.settings.intervalMs * 3);
    if (now - sample.at > maxAge || sample.at > now + 1000) return { ok: false, reason: '资源读数已过期，未放行' };
    if (sample.memory === null) return { ok: false, reason: '取不到内存读数，未放行新工作' };
    if (this.memoryHigh) return { ok: false, reason: '内存达到上限，低于恢复线后才开新工作' };
    if (request.heavy !== false && sample.cpu === null) return { ok: false, reason: 'CPU采样尚未就绪，未放行重活' };
    if (request.heavy !== false && this.cpuBusy) return { ok: false, reason: 'CPU忙碌，先不开后台重活' };
    if (request.vram_mb === undefined) return { ok: true, reason: 'CPU和内存允许开工' };

    const gpuIndex = request.gpu ?? 0;
    const gpu = sample.gpus?.find((item) => item.index === gpuIndex);
    if (gpu === undefined) return { ok: false, reason: '取不到目标显卡读数，GPU模型先不加载' };

    const bytes = request.vram_mb * 1024 ** 2;
    const who = request.who ?? 'unknown';
    this.reservations = this.reservations.filter((item) => item.until > now);
    let reserved = 0;
    let ownedPending = 0;
    for (const reservation of this.reservations) {
      if (reservation.gpu !== gpuIndex) {
        continue;
      }
      reserved += reservation.bytes;
      if (reservation.who === who) {
        ownedPending += reservation.bytes;
      }
    }
    const ownedBytes = (request.owned_vram_mb ?? 0) * 1024 ** 2;
    if (who === 'voice' && ownedBytes + ownedPending + bytes > 8 * 1024 ** 3) {
      //M 语音预算失败也说明已驻留与本次需求，不只给一个模糊的不足结论。
      const owned = this.getGiB(ownedBytes);
      //M 未过期的语音预留仍计入它自己的预算。
      const pending = this.getGiB(ownedPending);
      //M 本次需求来自调用者估算，明确单位后供原样展示。
      const needed = this.getGiB(bytes);
      const reason = `语音显卡模型预算8GiB：已驻留${owned}，预留${pending}，要${needed}，本次不加载`;
      return { ok: false, reason };
    }
    const limit = Math.min(this.settings.vramBytes, gpu.total);
    const headroom = 512 * 1024 ** 2;
    //M 同时计算已用、未反映预留及安全余量，不能只看模型自身大小。
    if (this.gpuHigh.get(gpuIndex) === true || gpu.used + reserved + bytes + headroom > limit) {
      //M 把已用字节明确显示为GiB，不混用驱动MiB。
      const used = this.getGiB(gpu.used);
      //M 把本次预计新增显存写进拒绝理由。
      const need = this.getGiB(bytes);
      //M 解释并发准入已占的预留，避免误认剩余显存。
      const held = this.getGiB(reserved);
      //M 显示硬线与物理卡容量两者中更小的可用上限。
      const ceiling = this.getGiB(limit);
      const reason = `显存不够：卡${String(gpuIndex)}已用${used}，预留${held}，要${need}，上限${ceiling}（另留0.50GiB）`;
      //M 预计加载会越线也通知同类显存不足事件，十分钟内不刷屏。
      const notice = this.getNotice(
        `显存不够，${who} 的模型没加载`,
        reason,
        '这次加载没放行，已经加载的不动',
        '关掉不用的显卡程序（游戏、别的 AI 模型）后再试',
      );
      this.notify(`vram-high:${String(gpuIndex)}`, notice);
      return { ok: false, reason };
    }
    //M 从读数回来后到预留登记之间没有await，同一轮并发请求不能重复占用同一份空间。
    const reservation = {
      gpu: gpuIndex,
      who,
      bytes,
      until: now + 60_000,
    };
    //M 登记刚放行的需求，下一条并发请求立即能看到占用。
    this.reservations.push(reservation);
    return { ok: true, reason: '目标显卡允许加载，已保守预留60秒；含512MiB安全余量' };
  }

  /** 校验事件边界；非法请求也有配对拒绝回执。 */
  private checkRequest(request: ResourceRequest): string | undefined {
    if (typeof request !== 'object' || request === null || request.action !== 'can-start') return '不支持的资源请求';
    if (request.heavy !== undefined && typeof request.heavy !== 'boolean') return 'heavy要是布尔值';
    if (request.who !== undefined && (typeof request.who !== 'string' || request.who.trim() === '')) return 'who要是非空文字';
    const fields = [request.vram_mb, request.owned_vram_mb];
    for (const value of fields) {
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        return '显存估算要是非负有限MiB数';
      }
    }
    if (request.gpu !== undefined && (!Number.isInteger(request.gpu) || request.gpu < 0)) return 'gpu要是非负整数';
    return undefined;
  }

  /** 探针失败转换成未知；并发调用只消费一次同一快照。 */
  private refresh(): Promise<probeModule.ResourceSample> {
    if (this.sampling !== undefined) return this.sampling;

    //M 共享同一次正在执行的探针，失败保留未知而不是零占用。
    this.sampling = this.read(this.control.signal).catch(() => ({
      //M 未知快照使用本轮时刻，不延长旧读数的有效期。
      at: this.now(), cpu: null, memory: null, totalMemory: null, gpus: null,
    })).then((sample) => {
      if (this.control.signal.aborted) return sample;

      //M 准入、迟滞与通知使用同一可注入时钟，测试不用等待真实时间。
      const now = this.now();
      const maxAge = Math.max(10_000, this.settings.intervalMs * 3);
      if (!Number.isFinite(sample.at) || now - sample.at > maxAge || sample.at > now + 1000) {
        sample = { at: now, cpu: null, memory: null, totalMemory: null, gpus: null };
      }
      this.current = sample;
      //M 根据本轮有效读数推进迟滞并广播变更。
      this.updatePressure(sample);
      return sample;
    }).finally(() => { this.sampling = undefined; });
    return this.sampling;
  }

  /** 根据新鲜读数维护迟滞；未知内存不会错误地解除高位状态。 */
  private updatePressure(sample: probeModule.ResourceSample): void {
    if (sample.cpu !== null) {
      if (sample.cpu >= this.settings.cpuPercent) {
        this.cpuBusy = true;
      }
      if (sample.cpu < this.settings.cpuResumePercent) {
        this.cpuBusy = false;
      }
    }
    //M 记下这一段CPU忙的起点，编译这类几十秒的高峰不够一分钟就不打扰用户。
    if (!this.cpuBusy) {
      this.cpuSince = undefined;
    }
    if (this.cpuBusy && this.cpuSince === undefined) {
      this.cpuSince = this.now();
    }
    const wasMemoryHigh = this.memoryHigh;
    if (sample.memory !== null) {
      if (sample.memory >= this.settings.memoryBytes) {
        this.memoryHigh = true;
      }
      if (sample.memory < this.settings.resumeBytes) {
        this.memoryHigh = false;
      }
    }
    if (wasMemoryHigh && !this.memoryHigh) {
      this.recoveryPending = true;
      this.shed = false;
    }
    //M 每次请求采样也重置连续高线计时，不能漏掉两轮定时器之间已经降压的证据。
    if (sample.memory === null || sample.memory < this.settings.memoryBytes) {
      this.highSince = undefined;
    }
    if (sample.memory !== null && sample.memory >= this.settings.memoryBytes && this.highSince === undefined) {
      //M 用本次实际越线时刻起算连续30秒，不累加已降压区间。
      this.highSince = this.now();
    }
    for (const gpu of sample.gpus ?? []) {
      const limit = Math.min(this.settings.vramBytes, gpu.total);
      const resume = Math.min(this.settings.vramResumeBytes, limit * 0.95);
      if (gpu.used >= limit) {
        this.gpuHigh.set(gpu.index, true);
      }
      if (gpu.used < resume) {
        this.gpuHigh.set(gpu.index, false);
      }
    }
    const vramHigh = Array.from(this.gpuHigh.values()).includes(true);
    let level: ResourcePressure['level'] = 'ok';
    let reason = '资源允许';
    if (this.cpuBusy || sample.cpu === null || sample.memory === null) {
      level = 'busy';
      reason = 'CPU忙碌或资源读数未就绪';
    }
    if (this.memoryHigh || vramHigh) {
      level = 'high';
      reason = '内存或显存达到高线，尚未确认低于恢复线';
    }
    let gpuSignature = '';
    for (const [index, high] of this.gpuHigh) {
      gpuSignature += `${String(index)}:${String(high)};`;
    }
    const cpuAvailable = sample.cpu !== null;
    const memoryAvailable = sample.memory !== null;
    const gpuAvailable = sample.gpus !== null;
    const available = `${String(cpuAvailable)}:${String(memoryAvailable)}:${String(gpuAvailable)}`;
    const signature = `${level}:${String(this.cpuBusy)}:${String(this.memoryHigh)}:${gpuSignature}:${available}`;
    if (signature === this.signature) return;

    this.signature = signature;
    const pressure = { level, reason, cpuBusy: this.cpuBusy, memoryHigh: this.memoryHigh, vramHigh, sample };
    //M 只在档位变化时广播；具体数值仍随最新快照更新，不每五秒刷事件。
    this.ctx.emit('resource/pressure', structuredClone(pressure));
  }

  /** 一轮动作只处理本插件宿主，并在每个await后核对卸载状态。 */
  private async runTick(): Promise<void> {
    //M 先等本轮读数完成，再做准入或守卫动作，不沿用旧的空闲判断。
    const sample = await this.refresh();
    if (this.control.signal.aborted) return;

    for (const host of this.hosts) {
      //M 只读取本插件宿主公开状态，不枚举系统进程或其他插件。
      const state = host.status();
      const title = host.spec.title;
      //M 只有明确的连崩放弃标志才发此类通知。
      if (state.gaveUp) {
        //M Host的说明里已写了“10分钟内连续失败5次”和最后一次原因，原样给用户。
        const notice = this.getNotice(
          `外部程序 ${title} 起不来`,
          state.note,
          '不再自动重启它',
          `看运行时目录 data/logs/${host.spec.name}.log 找原因，修好后在 jmbots 里重新启动它`,
        );
        this.notify(`crash:${host.spec.name}`, notice);
      }
      //M 授权过期只通知，不关程序、不删数据。
      if (state.license === 'expired') {
        const notice = this.getNotice(
          `外部程序 ${title} 授权过期`,
          '程序自报授权已过期',
          '只提醒，没有停它，也没删数据',
          '到这个程序自己的界面续期',
        );
        this.notify(`license:${host.spec.name}`, notice);
      }
    }

    //M CPU连续忙满一分钟才通知；读不到数的那一轮不发，免得正文写不出现在多少。
    const now = this.now();
    if (this.cpuSince !== undefined && now - this.cpuSince >= 60_000 && sample.cpu !== null) {
      const cpu = String(Math.round(sample.cpu));
      const limit = String(this.settings.cpuPercent);
      const resume = String(this.settings.cpuResumePercent);
      const notice = this.getNotice(
        'CPU 忙',
        `CPU ${cpu}%（线 ${limit}%），已连续 1 分钟以上；降到 ${resume}% 以下算恢复`,
        '暂停开新的后台重活（建索引、回填、批量嵌入），已经在跑的不动',
        '电脑卡的话，打开任务管理器按“CPU”排序，看是哪个程序占着，不用的关掉',
      );
      this.notify('cpu-busy', notice);
    }
    for (const gpu of sample.gpus ?? []) {
      //M 只通知实际达到逐卡高线的设备，不把无显卡当超限。
      if (this.gpuHigh.get(gpu.index) !== true) {
        continue;
      }
      //M 把已用字节明确显示为GiB，不混用驱动MiB。
      const used = this.getGiB(gpu.used);
      const total = this.getGiB(gpu.total);
      //M 逐卡硬线取配置和这张卡总量的较小者，恢复线同updatePressure的算法。
      const limitBytes = Math.min(this.settings.vramBytes, gpu.total);
      const limit = this.getGiB(limitBytes);
      const resumeBytes = Math.min(this.settings.vramResumeBytes, limitBytes * 0.95);
      const resume = this.getGiB(resumeBytes);
      const notice = this.getNotice(
        '显存超线',
        `卡${String(gpu.index)} 已用 ${used} / 共 ${total}（线 ${limit}）；降到 ${resume} 以下算恢复`,
        '不再放行新的显卡模型加载，已经加载的不动',
        '关掉不用的显卡程序（游戏、别的 AI 模型、开着硬件加速的网页）',
      );
      //M 同一张卡的超限与加载不足共用限频键。
      this.notify(`vram-high:${String(gpu.index)}`, notice);
    }
    if (this.memoryHigh) {
      //M 暂停和有限关闭都只走当前Host表，不扩展控制范围；通知在暂停请求回来后发，名单才准。
      await this.limitMemory(sample);
      return;
    }
    if (sample.memory === null || sample.memory >= this.settings.resumeBytes) return;

    this.highSince = undefined;
    this.shed = false;
    //M 只恢复本守卫实际改过且代次仍相同的程序。
    const restored = await this.restore();
    //G 恢复等待期间可能又升高，只有当前仍满足低线才报告恢复。
    if (!this.getCanRestore()) return;
    if (!this.recoveryPending && restored.length === 0) return;

    //M 即使没有可控程序，跨过恢复线也向用户交代一次。
    let done = '后台活可以再开了；没有要恢复的程序';
    if (restored.length > 0) {
      done = `已恢复 ${restored.join('、')}（重新拉起的还要过 CPU 准入）；后台活可以再开了`;
    }
    //M 正文写这一轮的读数和恢复线，用户知道已经降到哪。
    const memoryUsed = this.getGiB(sample.memory);
    const memoryResume = this.getGiB(this.settings.resumeBytes);
    const reading = `已用 ${memoryUsed}，低于恢复线 ${memoryResume}`;
    const notice = this.getNotice('内存恢复', reading, done, '不用做什么');
    this.notify('memory-recovered', notice);
    this.recoveryPending = false;
  }

  /**
   * 拼通知正文，四行固定顺序，用户一眼看懂。
   * @param title 哪项超了。
   * @param now 现在多少、线是多少。
   * @param done jmbots做了什么。
   * @param advice 用户该做什么。
   * @returns 写进飞书发件箱的Markdown正文。
   */
  private getNotice(title: string, now: string, done: string, advice: string): string {
    return `【jmbots 资源提醒】${title}\n- 现在：${now}\n- jmbots 做了：${done}\n- 你可以：${advice}\n`;
  }

  /** 高位暂停有能力的程序；只有连续30秒实测仍在硬线上才允许关一个。 */
  private async limitMemory(sample: probeModule.ResourceSample): Promise<void> {
    //M 准入、迟滞与通知使用同一可注入时钟，测试不用等待真实时间。
    const now = this.now();
    if (sample.memory === null || sample.memory < this.settings.memoryBytes) {
      this.highSince = undefined;
    }
    if (sample.memory !== null && sample.memory >= this.settings.memoryBytes && this.highSince === undefined) {
      this.highSince = now;
    }
    for (const host of this.hosts) {
      if (this.control.signal.aborted) return;

      //M 只读取本插件宿主公开状态，不枚举系统进程或其他插件。
      const state = host.status();
      if (state.state !== 'ready' || !state.canPause || state.paused) {
        continue;
      }

      const generation = state.generation;
      //M 只有接口确认成功才登记恢复权，原本就暂停的任务不算守卫暂停。
      const confirmed = await host.pause(true);
      if (confirmed) {
        this.paused.set(host, generation);
      }
    }
    if (this.control.signal.aborted) return;

    //M 暂停请求都回来后再通知，名单只写确认暂停了的；没有可暂停的也要通知到用户。
    const limit = this.getGiB(this.settings.memoryBytes);
    const resume = this.getGiB(this.settings.resumeBytes);
    let reading = '这一轮读不到内存数，先按超线处理';
    if (sample.memory !== null) {
      reading = `已用 ${this.getGiB(sample.memory)}`;
    }
    if (sample.memory !== null && sample.totalMemory !== null) {
      reading = `${reading} / 共 ${this.getGiB(sample.totalMemory)}`;
    }
    reading = `${reading}（线 ${limit}）；降到 ${resume} 以下算恢复`;
    //M 名单取守卫确认暂停过的宿主，没确认的不写进去。
    const names = Array.from(this.paused.keys(), (host) => host.spec.title);
    let done = '不再开新的后台活；jmbots 没有拉起能暂停的程序';
    if (names.length > 0) {
      done = `不再开新的后台活；已让 ${names.join('、')} 暂停后台（都是 jmbots 拉起的）`;
    }
    //M 这次卡死时占资源的多半不是 jmbots 拉起的，建议里写清让用户自己去关。
    const advice = '打开任务管理器按“内存”排序，关掉不用的大程序。占内存的多半不是 jmbots 拉起的，jmbots 不会去关它们';
    const notice = this.getNotice('内存超线', reading, done, advice);
    this.notify('memory-high', notice);
    if (this.shed || this.highSince === undefined) return;
    if (now - this.highSince < 30_000) return;

    //G 暂停HTTP可能耗时，停进程前重新采样，不能拿暂停前的高读数当作“仍超限”。
    const latest = await this.refresh();
    if (this.control.signal.aborted) return;
    if (latest.memory === null || latest.memory < this.settings.memoryBytes) {
      this.highSince = undefined;
      return;
    }
    //M 停前复采后重新取时间，健康RSS的新鲜度不能按暂停前的时钟算。
    const checkedAt = this.now();
    if (this.highSince === undefined || checkedAt - this.highSince < 30_000) return;

    const maxAge = Math.max(10_000, this.settings.intervalMs * 3);
    const candidates = this.hosts.filter((host) => {
      //M 只读取本插件宿主公开状态，不枚举系统进程或其他插件。
      const state = host.status();
      if (!host.spec.closable || state.pid === null || state.rssMb === undefined) return false;
      if (state.paused && this.paused.get(host) !== state.generation) return false;
      if (state.state !== 'ready' && state.state !== 'unhealthy') return false;
      return checkedAt >= state.rssAt && checkedAt - state.rssAt <= maxAge;
    });
    //M 缺RSS或读数过期的程序不猜测排名，不根据名字或任意PID停系统程序。
    candidates.sort((a, b) => (b.status().rssMb ?? 0) - (a.status().rssMb ?? 0));
    const host = candidates[0];
    if (host === undefined) return;

    //M 在停前记录管理代次，用户并发手停会令恢复凭据失效。
    const beforeStop = host.status();
    const generation = beforeStop.generation + 1;
    this.shed = true;
    //M 复用Host正常退出流程；记录预期代次，用户并发手停会使恢复凭据失效。
    await host.stop();
    this.stopped.set(host, generation);

    //M 关程序是大动作，单独告诉用户关了谁、什么时候拉回来。
    const rss = String(beforeStop.rssMb ?? 0);
    const shedNotice = this.getNotice(
      '内存持续超线，关了一个程序',
      `已连续 30 秒在 ${limit} 线上`,
      `正常关闭了 ${host.spec.title}（它自报占 ${rss} MiB）；内存降到 ${resume} 以下会自动重新拉起`,
      '再关掉别的不用的大程序',
    );
    this.notify('memory-shed', shedNotice);
  }

  /**
   * 只恢复守卫改过且管理代次没被用户改变的状态；原先停止或暂停的保持原样。
   * @returns 这一轮确实恢复了的程序显示名，恢复通知用。
   */
  private async restore(): Promise<string[]> {
    const restored: string[] = [];
    for (const [host, generation] of this.paused) {
      //G 每个恢复动作前重查最新低读数，防并发准入读到再次高位。
      if (!this.getCanRestore()) return restored;
      if (this.stopped.has(host)) {
        continue;
      }

      //M 只读取本插件宿主公开状态，不枚举系统进程或其他插件。
      const state = host.status();
      if (state.generation !== generation || !state.paused) {
        this.paused.delete(host);
        continue;
      }
      //M 恢复只针对守卫实际暂停的同一代运行实例。
      const confirmed = await host.pause(false);
      if (this.control.signal.aborted) return restored;
      //G 恢复等待期间若读数失效或再次升高，就撤回本轮恢复。
      if (!this.getCanRestore()) {
        if (confirmed) {
          //M 恢复HTTP等待期间再次达到高线，立即撤回本轮恢复，不继续拉起其它程序。
          await host.pause(true);
        }
        return restored;
      }
      if (confirmed) {
        //M 恢复确认了才算恢复，记下名字给通知用。
        this.paused.delete(host);
        restored.push(host.spec.title);
      }
    }
    for (const [host, generation] of this.stopped) {
      //G 每个恢复动作前重查最新低读数，防并发准入读到再次高位。
      if (!this.getCanRestore()) return restored;

      //M 只读取本插件宿主公开状态，不枚举系统进程或其他插件。
      const state = host.status();
      if (state.generation !== generation) {
        this.stopped.delete(host);
        this.paused.delete(host);
        continue;
      }
      if (state.state !== 'stopped' || state.pid !== null) {
        continue;
      }

      //M 只拉起守卫关过的程序，CPU/内存仍由Host启动前再过守卫。
      host.start();
      this.stopped.delete(host);
      this.paused.delete(host);
      restored.push(host.spec.title);
    }
    return restored;
  }

  /** 恢复每一步都重新核对最新读数；未知或重新升高均不可继续恢复。 */
  private getCanRestore(): boolean {
    if (this.control.signal.aborted || this.memoryHigh || this.current.memory === null) return false;
    return this.current.memory < this.settings.resumeBytes;
  }

  /** 按同类滑动十分钟限频；写失败不影响资源拒绝或Host清理。 */
  private notify(key: string, text: string): void {
    if (this.control.signal.aborted) return;

    //M 准入、迟滞与通知使用同一可注入时钟，测试不用等待真实时间。
    const now = this.now();
    //M 先查本实例成功入队时刻，同类事件十分钟内不重复触发出口。
    const previous = this.notices.get(key);
    if (previous !== undefined && now - previous < 600_000) return;

    try {
      //M 注入出口在测试只收集字符串；生产由既有飞书发件箱稍后投递。
      const queued = this.deliver(key, text, now);
      if (queued) {
        this.notices.set(key, now);
      }
    } catch (error) {
      //M 将内部错误转为可读诊断，不影响后续采样或清理。
      const detail = textModule.getErrorMessage(error);
      console.error(`资源守卫通知入队失败：${detail}`);
    }
  }

  /** 字节转用户可读GiB，避免把MiB当GB造成显存硬线偏移。 */
  private getGiB(bytes: number): string {
    const gib = bytes / 1024 ** 3;
    return `${gib.toFixed(2)}GiB`;
  }
}
