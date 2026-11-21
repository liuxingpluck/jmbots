/** 只读系统资源探针：物理内存字节、跨采样CPU均值、逐卡显存；不可用指标为null。 */
import * as os from 'node:os';

/** 一张显卡的读数，不把多卡显存相加冒充一张卡。 */
export interface GpuSample {
  /** nvidia-smi的物理卡索引。 */
  index: number;
  /** 已用显存，字节。 */
  used: number;
  /** 物理显存总量，字节。 */
  total: number;
}

/** 一次系统快照；null表示不可用，不当作零占用。 */
export interface ResourceSample {
  /** 采样完成时刻，Unix毫秒。 */
  at: number;
  /** 最近最多三次有效区间的CPU忙碌百分比。 */
  cpu: number | null;
  /** 已用物理内存，字节。 */
  memory: number | null;
  /** 物理内存总量，字节。 */
  totalMemory: number | null;
  /** 逐卡显存，命令不可用或输出不合法时为null。 */
  gpus: GpuSample[] | null;
}

/** 只在采样时执行nvidia-smi，生命周期由守卫的AbortSignal控制。 */
export class ResourceProbe {
  /** 前一次各核累计时钟之和。 */
  private previous?: { total: number; idle: number; cores: number };
  /** 最近三个有效区间，避免单个尖峰来回抖动。 */
  private readonly percentages: number[] = [];

  /** 保存可执行文件名，不创建进程。 */
  constructor(private readonly nvidiaSmi: string) {}

  /** 返回一次读数；CPU首次未形成区间为null，GPU失败不影响CPU和内存。 */
  async read(signal: AbortSignal): Promise<ResourceSample> {
    //M CPU使用本实例前后时钟区间，不拿开机以来平均值当当前负载。
    const cpu = this.getCpu();
    let memory: number | null = null;
    let totalMemory: number | null = null;
    try {
      //M Windows下freemem是可用物理内存，差值不把整个文件缓存重复计入。
      const total = os.totalmem();
      const free = os.freemem();
      if (Number.isFinite(total) && total > 0 && free >= 0 && free <= total) {
        totalMemory = total;
        memory = total - free;
      }
    } catch {
      // 指标不可用保留null，不伪造空闲。
    }
    //M GPU单独失败降级，不抹掉本轮有效的CPU和内存。
    const gpus = await this.getGpus(signal);
    return { at: Date.now(), cpu, memory, totalMemory, gpus };
  }

  /** 累计所有逻辑核时钟，按区间增量计算CPU占用；只读给页面看，守卫不拿它限流。 */
  private getCpu(): number | null {
    try {
      const cpus = os.cpus();
      const { total, idle } = sumCpuTimes(cpus, process.platform);
      const previous = this.previous;
      this.previous = { total, idle, cores: cpus.length };
      if (previous === undefined || previous.cores !== cpus.length || cpus.length === 0) {
        this.percentages.length = 0;
        return null;
      }

      const elapsed = total - previous.total;
      const idleElapsed = idle - previous.idle;
      if (elapsed <= 0 || idleElapsed < 0 || idleElapsed > elapsed) return null;

      //M 保留三个实际有效区间，不把无变化的时钟当0%加入均值。
      const percentage = 100 * (elapsed - idleElapsed) / elapsed;
      this.percentages.push(percentage);
      if (this.percentages.length > 3) {
        this.percentages.shift();
      }

      let sum = 0;
      for (const percentage of this.percentages) {
        sum += percentage;
      }
      return sum / this.percentages.length;
    } catch {
      return null;
    }
  }

  /** 只启动本探针自己的短命令；两秒超时、隐藏窗口、退出失败静默降级。 */
  private async getGpus(signal: AbortSignal): Promise<GpuSample[] | null> {
    const query = '--query-gpu=index,memory.used,memory.total';
    const command = [this.nvidiaSmi, query, '--format=csv,noheader,nounits'];
    const timeout = AbortSignal.timeout(2000);
    const until = AbortSignal.any([signal, timeout]);
    const options = {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', windowsHide: true, signal: until,
    } as const;
    try {
      //M 按卡读取MiB，避免WDDM按进程N/A和多个卡剩余空间相加的问题。
      const child = Bun.spawn(command, options);
      const output = new Response(child.stdout).text();
      const [code, text] = await Promise.all([child.exited, output]);
      if (code !== 0) return null;

      //M 在跨进程文本边界一次校验单位、索引及有限数。
      return parseGpus(text);
    } catch {
      return null;
    }
  }
}

/**
 * 把各核累计时钟加成总时长和空闲时长，毫秒。
 * Windows上libuv的sys已是“内核时间减空闲”，irq（中断时间）本来就在内核时间里，再加一遍会重复计入；
 * Linux的irq是单独一栏，要加。11-21在宿主机实测：20核2秒，user+sys+idle正好等于墙钟乘核数，再加irq多出约1%。
 * @param cpus os.cpus()的结果。
 * @param platform process.platform，测试可传别的平台。
 * @returns 总时长和其中的空闲时长。
 */
export function sumCpuTimes(cpus: os.CpuInfo[], platform: string): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    total += times.user + times.nice + times.sys + times.idle;
    idle += times.idle;
    //M 只有非Windows的irq是单独记的，才加进总时长。
    if (platform !== 'win32') {
      total += times.irq;
    }
  }
  return { total, idle };
}

/** 在nvidia-smi文本边界核对有限数和唯一索引，把MiB转换为字节。 */
export function parseGpus(text: string): GpuSample[] | null {
  const rows = text.trim().split(/\r?\n/u);
  const result: GpuSample[] = [];
  const indices = new Set<number>();
  for (const row of rows) {
    const fields = row.split(',');
    if (fields.length !== 3 || fields.some((field) => field.trim() === '')) return null;

    const [index, used, total] = fields.map(Number);
    if (index === undefined || used === undefined || total === undefined) return null;
    if (!Number.isInteger(index) || index < 0 || indices.has(index)) return null;
    if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0 || used > total) return null;

    //M nvidia-smi的nounits仍是MiB，不是十进制MB。
    indices.add(index);
    result.push({ index, used: used * 1024 ** 2, total: total * 1024 ** 2 });
  }
  return result;
}
