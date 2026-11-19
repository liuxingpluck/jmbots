/**
 * 起停 jmbots 第 6 版服务进程的共用做法：换版本（Swap_Serve）、看门狗（Guard）、发版验证（Build_Release）都用这里，
 * 免得同一件事各写一份（照 0.4 scripts/Serve_Process.ts；0.4 冻结，这套独立维护）。
 *
 * 这里只管进程和端口，不碰数据库、不决定什么时候该起什么时候该停；config.yaml 只取 server.port 一项。
 * 关键约束（都是 0.4 在本机实测踩出来的）：
 *   - Windows 上一律用 PowerShell 的 Start-Process 起新进程：直接 spawn 会继承父进程监听端口的句柄，
 *     旧服务停掉后端口仍被占着（11-03 凌晨飞书两小时没人接就是这个原因）；
 *   - 要写输出文件时，Start-Process 外面再套一层 cmd.exe 做重定向：这台机器环境里同时有 http_proxy 和
 *     HTTP_PROXY，Start-Process -RedirectStandardOutput 会直接失败；
 *   - 一律 -WindowStyle Hidden / windowsHide：用户在用电脑时不能有窗口弹到主屏。
 * 看门狗不导入 src6 下的任何东西：它是最后一道防线，不能因为被看守的代码改坏就跟着起不来。
 */
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';


/** jmbots 代码目录（本文件在 scripts6/ 下）。 */
export const ROOT = path.resolve(import.meta.dir, '..');

/** 停了旧服务后，最多等端口空出来多少秒。 */
export const PORT_FREE_SECONDS = 60;

/** 等服务起来最多等多久，毫秒。 */
export const HEALTH_TIMEOUT_MS = 90_000;

/** 换版本的锁多久内算有效，毫秒（检查加换版本一般 1 分多钟）。 */
export const SWAP_LOCK_MS = 180_000;

/** 查一次健康检查最多等多久，毫秒。等太久不如算它不健康——服务卡死时 fetch 可能一直不返回。 */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000;

/**
 * 运行时目录的默认值：程序旁边的 jmbotsData/（和 src6/utils/Checks.ts 的编译版默认值一样）。
 * 这里故意再写一遍而不是从那边导入：看门狗是最后一道防线，不能因为 src6 下某个文件被改坏就起不来。
 * 两边的值要一起改。
 */
export const DEFAULT_RUNTIME_DIR = path.join(ROOT, 'jmbotsData');

/**
 * 飞书发件箱在运行时目录下的位置（和 0.4 一样，为了让看门狗不依赖 src6）。
 * 往这里放一个 .md，服务在跑时就会发给用户。
 */
export const OUTBOX_DIR = path.join('integrations', 'feishu', 'outbox');


/**
 * 取命令行上的 --名字 值。
 * @param name 参数名。
 * @param fallback 没给时的值。
 * @param args 命令行参数，默认进程参数去掉前两项。
 * @returns 参数值。
 * @throws --名字 后面缺值时抛错。
 */
export function option(
  name: string,
  fallback: string,
  args: string[] = process.argv.slice(2),
): string {
  /** 看门狗保持独立，不导入后端；参数合同与 Checks.readArgs 相同。 */
  const flag = '--' + name;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === flag) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(flag + ' 后面需要参数值');
      }
      return value;
    }
    if (argument?.startsWith(flag + '=')) {
      return argument.slice(flag.length + 1);
    }
  }
  return fallback;
}


/**
 * 脚本入口校验监听端口；内部起进程只接收确定的数字。
 * @param name 命令行参数名。
 * @param fallback 缺省端口。
 * @returns 1–65535 的整数端口。
 * @throws 显式端口不合法或缺值时抛错。
 */
export function portOption(name: string, fallback: number): number {
  /** 端口原文。 */
  const rawPort = option(name, String(fallback));
  /** 数字。 */
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--' + name + ' 需要 1–65535 的整数，收到：' + rawPort);
  }
  return port;
}


/**
 * 这次该用哪个运行时目录：命令行 --runtime 优先，然后环境变量 JMBOTS_RUNTIME，最后默认值。
 * 只给路径，不建目录。
 * @returns 运行时目录的绝对路径。
 */
export function runtimeDir(): string {
  /** 命令行或环境变量给的。 */
  const configured = option('runtime', process.env.JMBOTS_RUNTIME ?? '');
  /** 选中的。 */
  const selected = configured.trim() || DEFAULT_RUNTIME_DIR;
  return path.resolve(selected);
}


/**
 * 取 config.yaml 的 http.port（没有 http 才取 server.port，和正式基地一致）；不打印、不返回其余内容。
 * @param runtime 运行时目录。
 * @returns 端口；没写、读不了、不合法是 undefined。
 */
export function readServerPort(runtime: string): number | undefined {
  try {
    /** 原文（只在内存里，不打印）。 */
    const text = fs.readFileSync(path.join(runtime, 'config.yaml'), 'utf8');
    /** 解析出的配置。 */
    const config = yaml.parse(text.replace(/^\uFEFF/u, '')) as Record<string, unknown> | null;
    //G 空的、坏了的：当没写。
    if (config === null || typeof config !== 'object') {
      return undefined;
    }
    /** http 段优先（和正式基地一致），没有才用 server 段。 */
    const section = (config.http ?? config.server) as Record<string, unknown> | undefined;
    /** 端口原值。 */
    const port = section?.port;
    //G 只认 1–65535 的整数。
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return undefined;
    }
    return port;
  } catch {
    //G 读不了配置：用调用方的缺省端口。
    return undefined;
  }
}


/**
 * 北京时间的 20 位 ID：17 位 `yyyyMMddHHmmssSSS` 加 3 位随机数字（和 utils/Time.ts 的 sessionId 同一套写法）。
 * 用在日志文件名和快照目录名上。
 * @returns 20 位数字串。
 */
export function timeId(): string {
  /** 现在。 */
  const now = new Date();
  /** 北京时间的 `yyyy-MM-dd HH:mm:ss`，只取数字。 */
  const digits = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/\D/g, '');
  /** 毫秒和随机后缀分别补足三位。 */
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  /** 随机后缀。 */
  const randomSuffix = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${digits}${milliseconds}${randomSuffix}`;
}


/**
 * 北京时间的可读写法 `yyyy-MM-dd HH:mm:ss`，写日志用。
 * @returns 时间文字。
 */
export function timeText(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}


/**
 * 把异常变成一行能看的字。
 * @param error 捕到的东西。
 * @returns 错误说明。
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/** 起一个独立进程要的东西。 */
export interface DetachedOptions {
  /** 给 bun 的参数，第一个一般是脚本路径；exe 模式不用。 */
  args: string[];
  /** 在哪个目录下跑；默认项目根。快照目录也可以当这个用。 */
  cwd?: string;
  /** 输出（stdout 和 stderr）追加写到哪；不给就丢掉。 */
  logFile?: string;
  /** 直接跑这个程序（编译好的 exe），不给就用 bun 跑 args。 */
  exe?: string;
}


/**
 * 起一个和当前进程无关的独立进程。
 * @param options 参数、目录、输出文件、可选的 exe。
 * @returns 进程号（Windows 上是 cmd.exe 或 bun 的）；拿不到时是 undefined。
 * 副作用：起子进程。
 */
export function spawnDetached(options: DetachedOptions): number | undefined {
  /** 在哪个目录下跑。 */
  const cwd = options.cwd ?? ROOT;
  /** 跑的程序：给了 exe 用它，不然用 bun。 */
  const program = options.exe ?? process.execPath;
  if (process.platform === 'win32') {
    /**
     * 包成 PowerShell 的单引号字符串。
     * @param text 原文。
     * @returns 包好的。
     */
    const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;
    /** 有输出文件时给 cmd /c 的整行（外面再包一层引号，cmd 会剥掉它）。 */
    const quotedArgs = options.args.map((arg) => `"${arg}"`).join(' ');
    /** 输出文件。 */
    const outputFile = options.logFile ?? '';
    /** cmd /c 的整行。 */
    const cmdLine = `""${program}" ${quotedArgs} >> "${outputFile}" 2>&1"`;
    /** 要跑的命令。 */
    const target = options.logFile
      ? `-FilePath cmd.exe -ArgumentList ${['/d', '/c', cmdLine].map(quote).join(',')}`
      : `-FilePath ${quote(program)} -ArgumentList ${options.args.map(quote).join(',')}`;
    /** PowerShell 的输出：新进程号。 */
    const quotedCwd = quote(cwd);
    /** 整条 PowerShell 命令。 */
    const command = `(Start-Process ${target} -WorkingDirectory ${quotedCwd} -WindowStyle Hidden -PassThru).Id`;
    /** PowerShell 的参数。 */
    const shellArgs = ['-NoProfile', '-Command', command];
    /** 子进程选项。 */
    const spawnOptions: child.SpawnSyncOptionsWithStringEncoding = {
      encoding: 'utf8',
      windowsHide: true,
    };
    /** 结果。 */
    const result = child.spawnSync('powershell.exe', shellArgs, spawnOptions);
    /** 输出。 */
    const output = result.stdout ?? '';
    return Number(output.trim()) || undefined;
  }
  /** 输出文件句柄。 */
  const out = options.logFile ? fs.openSync(options.logFile, 'a') : 'ignore';
  /** 新进程。 */
  const spawnOptions: child.SpawnOptions = {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  };
  /** 起好的进程。 */
  const started = child.spawn(program, options.args, spawnOptions);
  started.unref();
  return started.pid;
}


/**
 * 查一次某个端口上的服务活着没有。
 * @param port 端口。
 * @returns /api/health 回 ok 就是 true；超过 HEALTH_CHECK_TIMEOUT_MS 没回话也算不健康。
 */
export async function isHealthy(port: number): Promise<boolean> {
  try {
    /** 回应。 */
    const url = `http://127.0.0.1:${String(port)}/api/health`;
    /** 请求设置。 */
    const options = {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    };
    /** 回答。 */
    const response = await fetch(url, options);
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
  /** netstat 的参数。 */
  const args = ['-ano', '-p', 'tcp'];
  /** 子进程选项。 */
  const options: child.SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    windowsHide: true,
  };
  /** 结果。 */
  const result = child.spawnSync('netstat', args, options);
  /** 输出。 */
  const output = result.stdout ?? '';
  for (const line of output.split(/\r?\n/)) {
    /** 各列：协议、本地地址、远程地址、状态、进程号。 */
    const columns = line.trim().split(/\s+/);
    if (columns.length >= 5 && columns[1]?.endsWith(`:${String(port)}`) && columns[3] === 'LISTENING') {
      return Number(columns[4]);
    }
  }
  return undefined;
}


/**
 * 停掉某个端口上的服务（按 data\serve_<端口>.pid，没有就用 netstat 找；只停那一个进程，
 * 不连带它启动的命令），再等到端口空出来（最多 PORT_FREE_SECONDS 秒）。
 * @param runtime 运行时目录。
 * @param port 端口。
 * @returns 停了哪个进程；没找到时是 undefined。
 * 副作用：停进程、删 pid 文件。
 */
export async function stopServe(runtime: string, port: number): Promise<number | undefined> {
  /** pid 文件。 */
  const pidFile = path.join(runtime, 'data', `serve_${String(port)}.pid`);
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
 * @param runtime 运行时目录。
 * @returns 文件路径。
 */
export function devHoldFile(runtime: string): string {
  return path.join(runtime, 'data', 'dev.lock');
}


/**
 * 现在是不是开发模式（看门狗据此只看不动手：不起服务、不回退、不存快照）。
 * @param runtime 运行时目录。
 * @returns 还按着就返回到期时间（毫秒）；没按着或已过期返回 undefined。
 */
export function devHoldUntil(runtime: string): number | undefined {
  /** 锁文件：按到什么时候。 */
  const file = devHoldFile(runtime);
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
 * @param runtime 运行时目录。
 * @param minutes 按多少分钟。
 * @returns 到期时间（毫秒）。
 * 副作用：写锁文件。
 */
export function holdDev(runtime: string, minutes: number): number {
  /** 到期时间。 */
  const until = Date.now() + minutes * 60_000;
  fs.mkdirSync(path.join(runtime, 'data'), { recursive: true });
  fs.writeFileSync(devHoldFile(runtime), String(until));
  return until;
}


/**
 * 放开看门狗。
 * @param runtime 运行时目录。
 * @returns 本来按着就是 true。
 * 副作用：删锁文件。
 */
export function releaseDev(runtime: string): boolean {
  /** 锁文件。 */
  const file = devHoldFile(runtime);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}


/**
 * 现在是不是正在换版本（看门狗据此让开：换版本中间服务本来就会断一下）。
 * 基地换版本时也写这个锁（local/src/supervisor.rs），两边认同一个文件。
 * @param runtime 运行时目录。
 * @returns 锁还有效就是 true。
 */
export function isSwapping(runtime: string): boolean {
  /** 锁文件：最近一次开始换版本的时间。 */
  const lockFile = path.join(runtime, 'data', 'swap.lock');
  if (!fs.existsSync(lockFile)) {
    return false;
  }
  /** 上次开始换的时间，毫秒。 */
  const lockedAt = Number(fs.readFileSync(lockFile, 'utf8').trim());
  return Date.now() - lockedAt < SWAP_LOCK_MS;
}
