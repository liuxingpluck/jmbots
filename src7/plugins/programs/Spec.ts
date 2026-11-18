/** 外部程序配置入口，校验后交给托管逻辑使用。 */
import * as net from 'node:net';
import * as path from 'node:path';
import * as textModule from '../../utils/Text.ts';

/** 程序登记的一个渠道：程序只能用这些渠道名入站，主程序也只把这些渠道的回复和历史转给它。 */
export interface ProgramChannel {
  /** 渠道名，就是 channel/message 的 channel。 */
  name: string;
  /** 这个渠道来的消息交给哪个机器人。 */
  bot: string;
}

/** 已校验的单个程序配置。 */
export interface ProgramSpec {
  /** 唯一的程序名，也是就绪行和健康回执的身份。 */
  name: string;
  /** 网页显示名称。 */
  title: string;
  /** 程序文件，相对数据目录或绝对路径。 */
  file: string;
  /** 直接传给程序的参数。 */
  args: string[];
  /** 工作目录，默认数据目录。 */
  cwd: string;
  /** 仅为子进程补充的环境变量。 */
  env: Record<string, string>;
  /** 主程序就绪时是否自动启动。 */
  autostart: boolean;
  /** 程序用来监听的地址。 */
  host: string;
  /** 指定程序端口，0 由程序创建。 */
  port: number;
  /** 主服务的 HTTP 转发前缀。 */
  mount: string;
  /** 标明是否属于重型程序，供后续资源守卫使用。 */
  heavy: boolean;
  /** 内存持续超限时是否允许正常关闭，默认不允许。 */
  closable: boolean;
  /** 等候 stdout 就绪行的毫秒数。 */
  startupMs: number;
  /** 收到退出请求后给程序的收尾时间。 */
  exitWaitMs: number;
  /** 程序负责的外部渠道，默认没有；有才给它回调地址。 */
  channels: ProgramChannel[];
}

/**
 * 读取 plugins.programs.config 的程序列表，填入默认值。
 * @param config 插件的原始配置。
 * @returns 可以直接用于启动的配置。
 * @throws 配置格式、字段值或唯一性不符合约定时抛错。
 */
export function readPrograms(config: unknown): ProgramSpec[] {
  if (config === undefined) return [];

  //G 插件入口只接受对象及可选的 programs 列表。
  if (!isObject(config)) throw new Error('programs.config 要是对象');

  const written = config['programs'];
  if (written === undefined) return [];
  if (!Array.isArray(written)) throw new Error('programs.config.programs 要是列表');

  const names = new Set<string>();
  const mounts = new Set<string>();
  /** 所有程序已登记的渠道名：一个渠道只能交给一个程序。 */
  const channelNames = new Set<string>();
  return written.map((item: unknown, index) => {
    const at = `programs 第 ${String(index + 1)} 项`;

    //G 解析命名字段前先校验这一项的形状。
    if (!isObject(item)) throw new Error(`${at} 要是对象`);

    const name = item['name'];
    if (typeof name !== 'string' || !/^[a-z0-9-]+$/u.test(name)) {
      throw new Error(`${at} 的 name 要由小写字母、数字和横线组成`);
    }
    if (names.has(name)) throw new Error(`${at} 的 name ${name} 重复`);

    //M 按程序名组织错误消息，在入口统一校验类型与默认值。
    const key = `programs.${name}`;
    const file = getText(item, 'file', key);
    const title = getText(item, 'title', key, name);
    const cwd = getText(item, 'cwd', key, '{runtime}');
    const host = getText(item, 'host', key, '127.0.0.1');
    if (host !== 'localhost' && net.isIP(host) === 0) throw new Error(`${key}.host 要是 IP 地址或 localhost`);

    //M 归一化挂载路径，避免同一路由因尾部斜线被重复登记。
    const mountText = getText(item, 'mount', key, `/api/ext/${name}`);
    const mount = mountText.replace(/\/+$/u, '');
    if (!/^(?:\/[a-zA-Z0-9._~-]+)+$/u.test(mount) || /\/\.{1,2}(?:\/|$)/u.test(mount)) {
      throw new Error(`${key}.mount 要是以 / 开头的分段路径`);
    }
    if (mount === '/api/programs' || mount.startsWith('/api/programs/')) {
      throw new Error(`${key}.mount 与程序管理接口冲突`);
    }

    //G /programs/<名字>/ 留给界面入口按名字自动挂；mount 写在下面会和界面入口重复，或占掉别的程序的界面。
    if (mount === '/programs' || mount.startsWith('/programs/')) {
      const hint = `界面入口 /programs/${name}/ 自动提供，mount 不写就是 /api/ext/${name}`;
      throw new Error(`${key}.mount 不能写在 /programs 下：${hint}`);
    }
    if (mounts.has(mount)) throw new Error(`${key}.mount ${mount} 重复`);

    //G 参数和环境变量直接交给子进程，所有输入都须是字符串。
    const args = item['args'] ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      throw new Error(`${key}.args 要是文字列表`);
    }
    const env = item['env'] ?? {};

    //G 环境只允许字符串键值对，避免启动时把对象隐式转换成字符串。
    if (!isObject(env) || !Object.values(env).every((value) => typeof value === 'string')) {
      throw new Error(`${key}.env 要是字符串值组成的对象`);
    }

    const autostart = item['autostart'] ?? true;
    if (typeof autostart !== 'boolean') throw new Error(`${key}.autostart 要是布尔值`);
    let closable = item['closable'];
    if (closable === undefined) {
      closable = false;
    }
    if (typeof closable !== 'boolean') {
      throw new Error(`${key}.closable 要是布尔值`);
    }
    const heavy = item['heavy'] ?? false;
    if (typeof heavy !== 'boolean') throw new Error(`${key}.heavy 要是布尔值`);

    //M 将端口和等待时间限制在网络和定时器可用的范围内。
    const port = getInteger(item, 'port', key, 0, 0, 65535);
    const startupMs = getInteger(item, 'startup_ms', key, 120_000, 1, 2_147_483_647);
    const exitWaitMs = getInteger(item, 'exit_wait_ms', key, 5000, 1, 2_147_483_647);

    //M 程序登记的渠道：入站只认这些名字，回复和历史也只把这些渠道转给它。
    const channels = getChannels(item, key, channelNames);

    //M 记下已校验的标识，阻止后续项占用同名或同一挂载路径。
    names.add(name);
    mounts.add(mount);
    return {
      name, title, file, args, cwd, env: env as Record<string, string>,
      autostart, host, port, mount, heavy, closable, startupMs, exitWaitMs, channels,
    };
  });
}

/**
 * 读一个程序的 channels 列表，每项写渠道名和机器人名。
 * @param item 这个程序的原始配置。
 * @param key 报错用的前缀，如 programs.wechat。
 * @param taken 前面的程序已登记的渠道名；读到的新名字加进去。
 * @returns 已校验的渠道列表，没写是空列表。
 * @throws 不是列表、缺字段、名字不合法或已被别的程序登记。
 */
function getChannels(item: Record<string, unknown>, key: string, taken: Set<string>): ProgramChannel[] {
  const written = item['channels'] ?? [];
  if (!Array.isArray(written)) throw new Error(`${key}.channels 要是列表`);

  return written.map((entry: unknown, index) => {
    const at = `${key}.channels 第 ${String(index + 1)} 项`;

    //G 每一项都要是对象，写清渠道名和交给哪个机器人。
    if (!isObject(entry)) throw new Error(`${at} 要是对象`);

    //G 渠道名进入协议路由，只接受约定的标识字符。
    const name = getText(entry, 'name', at);
    if (!/^[a-z0-9-]+$/u.test(name)) throw new Error(`${at} 的 name 要由小写字母、数字和横线组成`);

    //G 同一个渠道交给两个程序，回复和历史就不知道该转给谁。
    if (taken.has(name)) throw new Error(`${at} 的渠道 ${name} 已经登记给别的程序`);

    //G 每个渠道必须明确指定接单机器人。
    const bot = getText(entry, 'bot', at);
    taken.add(name);
    return { name, bot };
  });
}

/** 判断配置是对象，供读取前缩小类型。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从配置读取非空文本，缺省时使用给定值。 */
function getText(item: Record<string, unknown>, field: string, key: string, fallback?: string): string {
  const value = item[field] ?? fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key}.${field} 要是非空字符串`);

  return value.trim();
}

/** 从配置读取指定范围内的整数。 */
function getInteger(
  item: Record<string, unknown>, field: string, key: string, fallback: number, min: number, max: number,
): number {
  const value = item[field] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key}.${field} 要是 ${String(min)} 至 ${String(max)} 的整数`);
  }
  return value;
}

/**
 * 解析实际执行文件、参数、工作目录与子进程环境。
 * @param root 数据目录。
 * @param spec 已校验的程序配置。
 * @returns 启动参数，不修改当前进程环境。
 */
export function getLaunch(root: string, spec: ProgramSpec) {
  const data = path.join(root, 'data');
  const slots: Record<string, string> = { runtime: root, data, host: spec.host, port: String(spec.port) };
  const placeholder = /\{(runtime|data|host|port)\}/gu;
  const fill = (value: string): string => value.replace(placeholder, (_whole, key: string) => slots[key]!);

  //M 用数据目录和程序配置换掉命令里的占位符。
  let file = fill(spec.file);

  //M 配置路径兼容同一可执行文件名在 Windows 下的 .exe 后缀。
  if (process.platform === 'win32' && !file.toLowerCase().endsWith('.exe')) file += '.exe';

  const command = path.resolve(root, file);
  const args = spec.args.map(fill);

  //M 相对工作目录以运行时目录为根，允许占位符设到指定子目录。
  const workDir = fill(spec.cwd);
  const cwd = path.resolve(root, workDir);
  const env = { ...process.env };

  //M 配置值覆盖本次子进程继承的环境变量。
  textModule.eachEntry(spec.env, (key, value) => { env[key] = fill(value); });
  return { command, args, cwd, env };
}

/** 守卫内部统一使用字节与毫秒，不重复读取原配置。 */
export interface GuardSettings {
  /** CPU进入忙碌的百分比。 */
  cpuPercent: number;
  /** CPU低于此百分比才解除忙碌。 */
  cpuResumePercent: number;
  /** 已用物理内存上限，字节。 */
  memoryBytes: number;
  /** 已用物理内存低于此字节数才恢复。 */
  resumeBytes: number;
  /** 每张卡的显存硬上限，字节。 */
  vramBytes: number;
  /** 每张卡低于此显存才解除告警，字节。 */
  vramResumeBytes: number;
  /** 采样间隔，毫秒。 */
  intervalMs: number;
  /** PATH命令名或用户配置的可执行文件路径。 */
  nvidiaSmi: string;
}

/** 在插件入口校验守卫配置；G统一为GiB，转换一次后内部使用字节。 */
export function readGuard(config: unknown): GuardSettings {
  let raw: Record<string, unknown> = {};
  if (config !== undefined) {
    //M 插件原始段必须是对象，避免从非法顶层形状继续读取。
    if (!isObject(config)) {
      throw new Error('programs.config 要是对象');
    }
    const written = config['guard'];
    if (written !== undefined) {
      //M 守卫段不是开关，数组和null不能伪装成默认配置。
      if (!isObject(written)) {
        throw new Error('programs.config.guard 要是对象');
      }
      raw = written;
    }
  }
  const fields = new Set([
    'cpu_percent', 'cpu_resume_percent', 'memory_gb', 'resume_gb',
    'vram_gb', 'vram_resume_gb', 'interval_ms', 'nvidia_smi',
  ]);
  //G 拼错字段不能静默沿用阈值。
  for (const field of Object.keys(raw)) {
    if (!fields.has(field)) {
      throw new Error(`programs.guard 不支持字段 ${field}`);
    }
    if (raw[field] === null) {
      throw new Error(`programs.guard.${field} 不能是null`);
    }
  }
  //M 统一在入口解析CPU进入线，内部不再读取原配置。
  const cpuPercent = getGuardNumber(raw, 'cpu_percent', 80, 1, 100);
  //M CPU恢复线与进入线分离，避免阈值附近反复抖动。
  const cpuResumePercent = getGuardNumber(raw, 'cpu_resume_percent', 70, 0, 100);
  //M 用户的G按GiB解释，容量只在本入口换算一次。
  const memoryGb = getGuardNumber(raw, 'memory_gb', 60, 0.001, 1_000_000);
  //M 读取用户已定的55GiB恢复线，而不是把60以下全部当恢复。
  const resumeGb = getGuardNumber(raw, 'resume_gb', 55, 0, 1_000_000);
  //M 逐卡显存硬线，不把多个卡容量合并。
  const vramGb = getGuardNumber(raw, 'vram_gb', 15.9, 0.001, 1_000_000);
  //M 显存退出线低于硬线，避免重复限流通知。
  const vramResumeGb = getGuardNumber(raw, 'vram_resume_gb', 15, 0, 1_000_000);
  if (cpuResumePercent >= cpuPercent) {
    throw new Error('cpu_resume_percent 要小于 cpu_percent');
  }
  if (resumeGb >= memoryGb) {
    throw new Error('resume_gb 要小于 memory_gb');
  }
  if (vramResumeGb >= vramGb) {
    throw new Error('vram_resume_gb 要小于 vram_gb');
  }
  //M 采样计时器必须是有界正整数，不能忙循环或溢出。
  const intervalMs = getInteger(raw, 'interval_ms', 'programs.guard', 5000, 100, 2_147_483_647);
  //M 只保存配置命令名或路径，不在配置入口启动探针。
  const nvidiaSmi = getText(raw, 'nvidia_smi', 'programs.guard', 'nvidia-smi');
  const gib = 1024 ** 3;
  return {
    cpuPercent,
    cpuResumePercent,
    memoryBytes: memoryGb * gib,
    resumeBytes: resumeGb * gib,
    vramBytes: vramGb * gib,
    vramResumeBytes: vramResumeGb * gib,
    intervalMs,
    nvidiaSmi,
  };
}

/** 从外部守卫段读取有界有限数；只在readGuard边界调用。 */
function getGuardNumber(
  raw: Record<string, unknown>, field: string, fallback: number, min: number, max: number,
): number {
  const value = raw[field] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`programs.guard.${field} 要是 ${String(min)} 至 ${String(max)} 的有限数`);
  }
  return value;
}
