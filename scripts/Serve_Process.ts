/**
 * 起停 jmbots 服务进程的共用做法：换版本（Swap_Serve）、双击启动（Start_Serve）、看门狗（Guard）都用这里，
 * 免得同一件事各写一份（11-03 凌晨那次事故就出在起进程的方式上）。
 *
 * 这里只管进程和端口，不碰数据库、不读 config.yaml，也不决定什么时候该起什么时候该停。
 * 关键约束（都是本机实测踩出来的）：
 *   - Windows 上一律用 PowerShell 的 Start-Process 起新进程：直接 spawn 会继承父进程监听 30086 的句柄，
 *     旧服务停掉后端口仍被占着（11-03 凌晨飞书两小时没人接就是这个原因）；
 *   - 要写输出文件时，Start-Process 外面再套一层 cmd.exe 做重定向：这台机器环境里同时有 http_proxy 和
 *     HTTP_PROXY，Start-Process -RedirectStandardOutput 会直接失败；
 *   - 一律 -WindowStyle Hidden / windowsHide：用户在用电脑时不能有窗口弹到主屏。
 */
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';


/** jmbots 代码目录（本文件在 scripts/ 下）。 */
export const ROOT = path.resolve(import.meta.dir, '..');

/** 停了旧服务后，最多等端口空出来多少秒。 */
export const PORT_FREE_SECONDS = 60;

/** 等服务起来最多等多久，毫秒。 */
export const HEALTH_TIMEOUT_MS = 90_000;

/** 换版本的锁多久内算有效，毫秒（检查加换版本一般 1 分多钟）。 */
export const SWAP_LOCK_MS = 180_000;

/** 开发模式默认按住多久（分钟）：到点自动失效，免得忘了关，服务就一直没人守。 */
export const DEV_HOLD_DEFAULT_MINUTES = 120;

/**
 * 运行时目录的默认值，和 src/resources/Resources.ts 的 DEFAULT_RUNTIME_DIR 一样。
 * 这里故意再写一遍而不是从那边导入：看门狗是最后一道防线，不能因为 src 下某个文件被改坏就起不来。
 * 两边的值要一起改。
 */
export const DEFAULT_RUNTIME_DIR = 'F:/aidata/AIJMBots';

/**
 * 飞书发件箱在运行时目录下的位置，和 src/channels/Feishu.ts 的 OUTBOX_DIR 一样
 * （同样是为了不让看门狗依赖 src；两边要一起改）。往这里放一个 .md，服务在跑时就会发给用户。
 */
export const OUTBOX_DIR = path.join('integrations', 'feishu', 'outbox');


/**
 * 取命令行上的 --名字 值。
 * @param name 参数名。
 * @param fallback 没给时的值。
 */
export function option(name: string, fallback: string): string {
  /** 参数位置。 */
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}


/**
 * 这次该用哪个运行时目录：命令行 --runtime 优先，然后环境变量 JMBOTS_RUNTIME，最后默认值。
 * 只给路径，不读 config.yaml、不建目录。
 */
export function runtimeDir(): string {
  return option('runtime', process.env.JMBOTS_RUNTIME ?? DEFAULT_RUNTIME_DIR);
}


/**
 * 北京时间的 20 位 ID：17 位 `yyyyMMddHHmmssSSS` 加 3 位随机数字（和 utils.createSessionId 同一套写法）。
 * 用在日志文件名和快照目录名上。
 */
export function timeId(): string {
  /** 现在。 */
  const now = new Date();
  /** 北京时间的 `yyyy-MM-dd HH:mm:ss`，只取数字。 */
  const digits = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/\D/g, '');
  return `${digits}${String(now.getMilliseconds()).padStart(3, '0')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
}


/**
 * 北京时间的可读写法 `yyyy-MM-dd HH:mm:ss`，写日志用。
 */
export function timeText(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}


/**
 * 把异常变成一行能看的字。
 * @param error 捕到的东西。
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/** 起一个独立进程要的东西。 */
export interface DetachedOptions {
  /** 给 bun 的参数，第一个一般是脚本路径。 */
  args: string[];
  /** 在哪个目录下跑；默认项目根。快照目录也可以当这个用。 */
  cwd?: string;
  /** 输出（stdout 和 stderr）追加写到哪；不给就丢掉。 */
  logFile?: string;
}


/**
 * 起一个和当前进程无关的独立进程。
 * @param options 参数、目录、输出文件。
 * @returns 进程号（Windows 上是 cmd.exe 或 bun 的）；拿不到时是 undefined。
 */
export function spawnDetached(options: DetachedOptions): number | undefined {
  /** 在哪个目录下跑。 */
  const cwd = options.cwd ?? ROOT;
  if (process.platform === 'win32') {
    /**
     * 包成 PowerShell 的单引号字符串。
     * @param text 原文。
     */
    const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;
    /** 有输出文件时给 cmd /c 的整行（外面再包一层引号，cmd 会剥掉它）。 */
    const cmdLine = `""${process.execPath}" ${options.args.map((arg) => `"${arg}"`).join(' ')} >> "${options.logFile ?? ''}" 2>&1"`;
    /** 要跑的命令。 */
    const target = options.logFile
      ? `-FilePath cmd.exe -ArgumentList ${['/d', '/c', cmdLine].map(quote).join(',')}`
      : `-FilePath ${quote(process.execPath)} -ArgumentList ${options.args.map(quote).join(',')}`;
    /** PowerShell 的输出：新进程号。 */
    const output = child.spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Start-Process ${target} -WorkingDirectory ${quote(cwd)} -WindowStyle Hidden -PassThru).Id`], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    return Number(output.trim()) || undefined;
  }
  /** 输出文件句柄。 */
  const out = options.logFile ? fs.openSync(options.logFile, 'a') : 'ignore';
  /** 新进程。 */
  const started = child.spawn(process.execPath, options.args, { cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  started.unref();
  return started.pid;
}


/** 起一个服务要的东西。 */
export interface StartServeOptions {
  /** 运行时目录（日志和 pid 文件写在它的 data 下）。 */
  runtimeDir: string;
  /** 端口。 */
  port: number;
  /** 用哪份代码起；默认项目根。看门狗回退时传快照目录。 */
  root?: string;
  /** 是不是试运行（--mode candidate：只起 HTTP，不接飞书、不跑事件循环、不改执行状态）。 */
  candidate?: boolean;
  /** 正式服务监听哪个地址；默认 0.0.0.0（用户 11-02 定：开发阶段全开）。试运行一律只听 127.0.0.1。 */
  host?: string;
}


/**
 * 用某份代码在某个端口起服务（独立进程，输出写到运行时 data\serve_<端口>_<时间>.log）。
 * @param options 运行时目录、端口、代码目录、是否试运行、监听地址。
 * @param logName 日志文件名里的时间部分，调用方给（各脚本的 ID 规则一致）。
 * @returns 进程号；拿不到时是 undefined。
 */
export function startServe(options: StartServeOptions, logName: string): number | undefined {
  /** 用哪份代码。 */
  const root = options.root ?? ROOT;
  /** 输出文件。 */
  const logFile = path.join(options.runtimeDir, 'data', `serve_${options.port}_${logName}.log`);
  /** 给 bun 的参数。 */
  const args = [
    path.join(root, 'src', 'entries', 'Main.ts'),
    'serve',
    '--port', String(options.port),
    ...(options.candidate ? ['--host', '127.0.0.1', '--mode', 'candidate'] : ['--host', options.host ?? '0.0.0.0']),
  ];
  return spawnDetached({ args, cwd: root, logFile });
}


/** 查一次健康检查最多等多久，毫秒。等太久不如算它不健康——服务卡死时 fetch 可能一直不返回。 */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000;


/**
 * 查一次某个端口上的服务活着没有。
 * @param port 端口。
 * @returns /api/health 回 ok 就是 true；超过 HEALTH_CHECK_TIMEOUT_MS 没回话也算不健康。
 */
export async function isHealthy(port: number): Promise<boolean> {
  try {
    /** 回应。 */
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
    /** 内容。 */
    const body = (await response.json()) as { ok?: boolean };
    return response.ok && body.ok === true;
  } catch {
    //G 服务没起来、正在起、或者端口被别的程序占着，都算不健康。
    return false;
  }
}


/**
 * 等某个端口上的服务健康。
 * @param port 端口。
 * @param timeoutMs 最多等多久；默认 HEALTH_TIMEOUT_MS。
 * @returns 健康了没有。
 */
export async function waitHealthy(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  /** 截止时间。 */
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(port)) {
      return true;
    }
    await Bun.sleep(1000);
  }
  return false;
}


/**
 * 用 netstat 找在某个端口上监听的进程（没有 pid 文件时用，比如旧版本还不会写 pid 文件）。
 * @param port 端口。
 * @returns 进程号；没找到时是 undefined。
 */
export function pidOnPort(port: number): number | undefined {
  /** netstat 的输出。 */
  const output = child.spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  for (const line of output.split(/\r?\n/)) {
    /** 各列：协议、本地地址、远程地址、状态、进程号。 */
    const columns = line.trim().split(/\s+/);
    if (columns.length >= 5 && columns[1]?.endsWith(`:${port}`) && columns[3] === 'LISTENING') {
      return Number(columns[4]);
    }
  }
  return undefined;
}


/**
 * 停掉某个端口上的服务（按 data\serve_<端口>.pid，没有就用 netstat 找；只停那一个进程，
 * 不连带它启动的命令），再等到端口空出来（最多 PORT_FREE_SECONDS 秒）。
 * @param runtimeDir 运行时目录。
 * @param port 端口。
 * @returns 停了哪个进程；没找到时是 undefined。
 */
export async function stopServe(runtimeDir: string, port: number): Promise<number | undefined> {
  /** pid 文件。 */
  const pidFile = path.join(runtimeDir, 'data', `serve_${port}.pid`);
  /** 进程号。 */
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : pidOnPort(port);
  fs.rmSync(pidFile, { force: true });
  if (!pid) {
    return undefined;
  }
  try {
    process.kill(pid);
  } catch {
    //G 进程已经没了。
  }
  for (let waited = 0; waited < PORT_FREE_SECONDS && pidOnPort(port) !== undefined; waited += 1) {
    await Bun.sleep(1000);
  }
  return pid;
}


/**
 * 开发模式的锁文件。
 * @param runtimeDir 运行时目录。
 * @returns 文件路径。
 */
export function devHoldFile(runtimeDir: string): string {
  return path.join(runtimeDir, 'data', 'dev.lock');
}


/**
 * 现在是不是开发模式（看门狗据此只看不动手：不起服务、不回退、不存快照）。
 * @param runtimeDir 运行时目录。
 * @returns 还按着就返回到期时间（毫秒）；没按着或已过期返回 undefined。
 */
export function devHoldUntil(runtimeDir: string): number | undefined {
  /** 锁文件：按到什么时候。 */
  const file = devHoldFile(runtimeDir);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  /** 到期时间，毫秒。 */
  const until = Number(fs.readFileSync(file, 'utf8').trim());
  //G 文件内容坏了（不是数字）当没按住，别把看门狗永久停掉。
  if (!Number.isFinite(until) || Date.now() >= until) {
    return undefined;
  }
  return until;
}


/**
 * 按住看门狗。
 * @param runtimeDir 运行时目录。
 * @param minutes 按多少分钟。
 * @returns 到期时间（毫秒）。
 */
export function holdDev(runtimeDir: string, minutes: number): number {
  /** 到期时间。 */
  const until = Date.now() + minutes * 60_000;
  fs.mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });
  fs.writeFileSync(devHoldFile(runtimeDir), String(until));
  return until;
}


/**
 * 放开看门狗。
 * @param runtimeDir 运行时目录。
 * @returns 本来按着就是 true。
 */
export function releaseDev(runtimeDir: string): boolean {
  /** 锁文件。 */
  const file = devHoldFile(runtimeDir);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}


/**
 * 现在是不是正在换版本（看门狗据此让开：换版本中间服务本来就会断一下）。
 * @param runtimeDir 运行时目录。
 * @returns 锁还有效就是 true。
 */
export function isSwapping(runtimeDir: string): boolean {
  /** 锁文件：最近一次开始换版本的时间。 */
  const lockFile = path.join(runtimeDir, 'data', 'swap.lock');
  if (!fs.existsSync(lockFile)) {
    return false;
  }
  /** 上次开始换的时间，毫秒。 */
  const lockedAt = Number(fs.readFileSync(lockFile, 'utf8').trim());
  return Date.now() - lockedAt < SWAP_LOCK_MS;
}
