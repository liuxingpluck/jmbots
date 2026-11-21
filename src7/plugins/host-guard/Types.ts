/**
 * 宿主机守卫（host-guard）的类型：配置、一条红线的读数和状态、一次快照、一条告警、可注入的探针。
 * 只放类型，没有逻辑；index.ts 和 Probe.ts、测试共用。
 */


/** 插件配置（入口 index.ts 的 parseConfig 校验一次、补齐默认值后交进来）。容量单位 GB 都按 GiB（1024³ 字节）算。 */
export interface HostGuardConfig {
  /** 内存红线，默认 60。 */
  maxRamGb: number;
  /** 内存预警线，默认 54，要比红线低。 */
  warnRamGb: number;
  /** 显存红线（任何一张卡），默认 15.5。 */
  maxVramGb: number;
  /** 显存预警线，默认 14，要比红线低。 */
  warnVramGb: number;
  /** 采样间隔秒数，默认 30，5～600 的整数。 */
  intervalSec: number;
  /** 同一条线两次超线告警至少隔几秒，默认 300。 */
  cooldownSec: number;
  /** 告警要不要同时写进飞书发件箱，默认 false（programs 的资源守卫已在 60G 发飞书，免得一件事发两条）。 */
  notifyFeishu: boolean;
  /** nvidia-smi 的命令名或路径，默认 nvidia-smi。 */
  nvidiaSmi: string;
}


/** 一条线的档位：ok 安全，warn 过了预警线，exceeded 过了红线，unknown 读不到（没有显卡或 nvidia-smi 失败）。 */
export type LineLevel = 'ok' | 'warn' | 'exceeded' | 'unknown';


/** 哪条线：ram 内存，vram 显存。 */
export type LineName = 'ram' | 'vram';


/** 一次读数，字节；读不到的整条是 null。 */
export interface Usage {
  /** 已用，字节。 */
  used: number;
  /** 总量，字节。 */
  total: number;
}


/** 一条线的当前状态（放进快照给接口和工具看）。 */
export interface LineStatus {
  /** 已用 GB，保留一位小数；读不到是 null。 */
  usedGb: number | null;
  /** 总量 GB，保留一位小数；读不到是 null。 */
  totalGb: number | null;
  /** 红线 GB。 */
  maxGb: number;
  /** 预警线 GB。 */
  warnGb: number;
  /** 本次采样的档位。 */
  level: LineLevel;
  /** 发过超线告警、还没确认回落：true。连续 2 次 ok 才回到 false。 */
  alerting: boolean;
}


/** 占用排前的一个进程。 */
export interface TopProcess {
  /** 进程号。 */
  pid: number;
  /** 进程名。 */
  name: string;
  /** 占用，MB（内存是工作集或 RSS，显存是 nvidia-smi 报的用量）。 */
  mb: number;
}


/** 一条告警：超线或回落。 */
export interface HostAlert {
  /** 发出时刻，Unix 毫秒。 */
  at: number;
  /** 哪条线。 */
  line: LineName;
  /** exceeded 超线，recovered 回落到安全线。 */
  kind: 'exceeded' | 'recovered';
  /** 当时已用 GB。 */
  usedGb: number;
  /** 红线 GB。 */
  maxGb: number;
  /** 超线时顺带拉的占用前 5 进程；回落或拉取失败是空数组。 */
  top: TopProcess[];
  /** 给人看的一句话（飞书正文也是它）。 */
  text: string;
}


/** 一次快照：GET /api/host-guard/status、POST /api/host-guard/check 和工具 host_guard_status 都回它。 */
export interface HostSnapshot {
  /** 最近一次采样时刻，Unix 毫秒；还没采过是 null。 */
  sampledAt: number | null;
  /** 内存线。 */
  ram: LineStatus;
  /** 显存线（多卡取用得最多的那张）。 */
  vram: LineStatus;
  /** 能不能读到显存。 */
  gpuAvailable: boolean;
  /** 有没有哪条线正在超线。 */
  exceeded: boolean;
  /** 最近最多 50 条告警，新的在后面。 */
  alerts: HostAlert[];
  /** 最近一次超线告警时拉的占用前 5 进程。 */
  top: { ram: TopProcess[]; vram: TopProcess[] };
}


/** 可注入的探针：正式用 Probe.ts 的 createProbes，测试传假的。都不许抛错，读不到就交回 null 或空数组。 */
export interface HostProbes {
  /** 读宿主机物理内存。 */
  probeRam(): Promise<Usage | null>;
  /** 读显存（用得最多的那张卡）；没有显卡或 nvidia-smi 失败交回 null。 */
  probeVram(): Promise<Usage | null>;
  /** 拉占用前 5 的进程；line 说要内存的还是显存的，失败交回空数组。 */
  probeTop(line: LineName): Promise<TopProcess[]>;
  /** 当前时刻，Unix 毫秒；测试拿它拨表。 */
  now(): number;
}
