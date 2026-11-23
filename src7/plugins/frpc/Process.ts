/**
 * Windows 外网隧道进程探测、无窗启停控制与开机自启管理。
 * 读取 tray-status.json（容错 UTF-8 BOM）并结合真实进程存活核验，杜绝僵尸状态文件误报；
 * 启停全程 windowsHide 无黑框，停止时只精准终止当前目录下的 frpc.exe，保留托盘图标常驻。
 * Windows 上托盘和 frpc.exe 经 WMI 拉起，不在 jmbots-server 的 Job 里，后端热更、退出时隧道不掉线。
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import * as tomlModule from './Toml.ts';


//==========================================================
// 实时状态与执行器接口
//==========================================================

/** 托盘与 frpc.exe 核验后的实时运行态。 */
export interface LiveFrpcState {
  /** frpc.exe 是否存活。 */
  running: boolean;
  /** 是否已成功注册上线（结合托盘状态与 frpc.log 尾部判断）。 */
  connected: boolean;
  /** 当前目录 frpc.exe 的进程号（未运行为 0）。 */
  pid: number;
  /** 托盘脚本进程是否存活。 */
  trayRunning: boolean;
  /** 托盘脚本进程号（未运行为 0）。 */
  trayPid: number;
  /** 简短状态说明（如「在线」「重连中」「已停止」）。 */
  detail: string;
  /** 状态采样时间（YYYY-MM-DD HH:mm:ss）。 */
  updatedAt: string;
}

/** 控制动作枚举。 */
export type FrpcControlAction = 'start' | 'stop' | 'restart';

/** 可注入的进程与自启适配器（方便单测离线模拟，不碰宿主机真实隧道）。 */
export interface FrpcRunner {
  /** 读取并核对当前真实运行状态。 */
  readLiveState(dir: string): Promise<LiveFrpcState>;
  /** 执行启动、停止或平滑重启并返回收敛后的状态。 */
  control(dir: string, action: FrpcControlAction): Promise<LiveFrpcState>;
  /** 检查 Windows Startup 目录下是否存在自启脚本。 */
  readAutoStart(): boolean;
  /** 开启或关闭 Windows 登录开机自启。 */
  writeAutoStart(dir: string, enabled: boolean): boolean;
}

/**
 * 无窗拉起外部进程（托盘 wscript.exe 或 frpc.exe）的函数。
 * 默认实现是本文件的 launchOutsideJob；单测经 createDefaultRunner 第二个参数注入假的，记下启动参数。
 * @returns 新进程 PID；拿不到时为 0。
 */
export type DetachedLauncher = (command: string, args: string[], cwd: string) => Promise<number>;

/** tray-status.json 解析出的原始快照。 */
interface TrayFileSnapshot {
  trayPid: number;
  frpcPid: number;
  frpcRunning: boolean;
  frpcConnected: boolean;
  detail: string;
  updatedAt: string;
  fresh: boolean;
}


/** tray-status.json 被视为新鲜的最大文件年龄（托盘每 3 秒刷新一次，放宽到 15 秒）。 */
const TRAY_FRESH_MS = 15_000;

/** 模块级控制串行互斥队列，防止双击或并发请求同时拉起两个 frpc.exe。 */
let controlQueue: Promise<unknown> = Promise.resolve();


//==========================================================
// 基础系统探测工具
//==========================================================

/**
 * 拼出 Windows 当前用户 Startup 目录下的 LeonFRPS-Tray.vbs 路径。
 * @param appdataDir APPDATA 目录；为空时回空串。
 * @returns 启动脚本绝对路径或空串。
 */
export function getStartupVbsPath(appdataDir = process.env['APPDATA'] ?? ''): string {
  const root = appdataDir.trim();
  if (root === '') return '';

  return path.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'LeonFRPS-Tray.vbs');
}


/**
 * 构造 2 行无黑框 VBScript 开机自启脚本内容，转发调用客户端目录下的 start-tray.vbs。
 * @param startTrayVbs 客户端目录内 start-tray.vbs 的绝对路径。
 * @returns CRLF 结尾的 2 行 VBScript 文本。
 */
export function buildStartupVbsContent(startTrayVbs: string): string {
  const escaped = startTrayVbs.replaceAll('"', '""');
  const line1 = 'Set ws = CreateObject("WScript.Shell")';
  const line2 = `ws.Run "wscript.exe //B //NoLogo """ & "${escaped}" & """", 0, False`;
  return `${line1}\r\n${line2}\r\n`;
}


/**
 * 用零子进程开销的 kill(pid, 0) 检测本机指定 PID 是否仍然存活。
 * @param pid 进程号。
 * @returns 进程存活返回 true。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'EPERM';
  }
}


/**
 * 读取并解析 tray-status.json，自动剥离 PowerShell Set-Content UTF8 写入的 BOM。
 * @param dir 客户端目录。
 * @returns 解析成功返回快照，缺失或损坏返回 undefined。
 */
export function readTrayStatusSnapshot(dir: string): TrayFileSnapshot | undefined {
  const filePath = path.join(dir, 'tray-status.json');
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) return undefined;

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '').trim();
    if (raw === '') return undefined;

    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const rec = parsed as Record<string, unknown>;
  let trayPid = 0;
  if (typeof rec['trayPid'] === 'number' && Number.isInteger(rec['trayPid']) && rec['trayPid'] > 0) {
    trayPid = rec['trayPid'];
  }
  let frpcPid = 0;
  if (typeof rec['frpcPid'] === 'number' && Number.isInteger(rec['frpcPid']) && rec['frpcPid'] > 0) {
    frpcPid = rec['frpcPid'];
  }
  let detail = '';
  if (typeof rec['detail'] === 'string') {
    detail = rec['detail'].trim();
  }
  let updatedAt = '';
  if (typeof rec['updatedAt'] === 'string') {
    updatedAt = rec['updatedAt'].trim();
  }
  const fresh = Math.abs(Date.now() - stat.mtimeMs) <= TRAY_FRESH_MS;
  return {
    trayPid,
    frpcPid,
    frpcRunning: rec['frpcRunning'] === true,
    frpcConnected: rec['frpcConnected'] === true,
    detail,
    updatedAt,
    fresh,
  };
}


/**
 * 从 frpc.log 最近 25 行推断连接是否已就绪。
 * @param dir 客户端目录。
 * @returns 连接布尔值与简短说明。
 */
export function inspectLogConnection(dir: string): { connected: boolean; detail: string } {
  const logFile = path.join(dir, 'frpc.log');
  const tail = tomlModule.readTailLines(logFile, 25);
  for (let i = tail.lines.length - 1; i >= 0; i -= 1) {
    const line = tail.lines[i] ?? '';
    if (/start proxy success|login to server success/iu.test(line)) {
      return { connected: true, detail: '在线' };
    }
    if (/connect to server error|try to reconnect|login to server failed/iu.test(line)) {
      return { connected: false, detail: '重连中' };
    }
  }
  return { connected: false, detail: '未知' };
}


//==========================================================
// Windows 进程无窗查询与启停实现
//==========================================================

/**
 * 异步无窗执行一段短小的 PowerShell 脚本并返回标准输出首行文本。
 * @param script PowerShell 脚本正文（路径经环境变量传入，彻底避免转义注入）。
 * @param extraEnv 附加环境变量。
 * @returns 去首尾空白的标准输出。
 */
function runHiddenPowerShell(script: string, extraEnv: Record<string, string>): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('');

  return new Promise<string>((resolve) => {
    const child = childProcess.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      {
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(stdout.trim()));
  });
}


/** 从 PowerShell 标准输出首行提取正整数 PID，无匹配时返回 0。 */
function readPid(out: string): number {
  const first = out.split(/\r?\n/u)[0]?.trim() ?? '';
  if (!/^\d+$/u.test(first)) return 0;

  return Number(first);
}


/**
 * 扫描并定位或终止可执行文件路径等于 <dir>\frpc.exe 的进程（不碰其他目录的 frpc 或托盘进程）。
 * @param dir 客户端目录。
 * @param action find 返回进程 PID；kill 强制停止匹配进程。
 */
async function runFrpcScan(dir: string, action: 'find' | 'kill'): Promise<number> {
  const targetExe = path.join(dir, 'frpc.exe');
  let hit = 'Write-Output $p.Id; break';
  if (action === 'kill') {
    hit = 'Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue';
  }
  const script = [
    '$exe = $env:FRPC_TARGET_EXE',
    "$list = Get-Process -Name 'frpc' -ErrorAction SilentlyContinue",
    'foreach ($p in $list) {',
    '  try {',
    '    if ($p.Path -and [string]::Equals($p.Path, $exe, [System.StringComparison]::OrdinalIgnoreCase)) {',
    `      ${hit}`,
    '    }',
    '  } catch {}',
    '}',
  ].join('\n');
  const out = await runHiddenPowerShell(script, { FRPC_TARGET_EXE: targetExe });
  if (action === 'kill') return 0;

  return readPid(out);
}


/**
 * 在 Windows 上精准查找可执行文件路径等于 <dir>\frpc.exe 的进程 PID。
 * @param dir 客户端目录。
 * @returns 匹配的进程 PID；未运行回 0。
 */
async function findWindowsFrpcPid(dir: string): Promise<number> {
  return runFrpcScan(dir, 'find');
}


/**
 * 在 tray-status.json 过期时兜底查询运行着当前目录 frpc-tray.ps1 的托盘进程 PID。
 * @param dir 客户端目录。
 * @returns 托盘进程 PID；未运行回 0。
 */
async function findWindowsTrayPid(dir: string): Promise<number> {
  const targetScript = path.join(dir, 'frpc-tray.ps1');
  const script = [
    '$ps1 = $env:FRPC_TARGET_PS1',
    '$procs = Get-CimInstance Win32_Process -Filter "Name = \'powershell.exe\'" -ErrorAction SilentlyContinue',
    'foreach ($p in $procs) {',
    '  if ($p.CommandLine -and $p.CommandLine.IndexOf($ps1, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {',
    '    Write-Output $p.ProcessId; break',
    '  }',
    '}',
  ].join('\n');
  const out = await runHiddenPowerShell(script, { FRPC_TARGET_PS1: targetScript });
  return readPid(out);
}


/**
 * 精准停止可执行文件路径等于 <dir>\frpc.exe 的进程，只停当前目录的 frpc，不碰其他目录进程或托盘进程。
 * @param dir 客户端目录。
 */
async function killDirFrpcOnly(dir: string): Promise<void> {
  await runFrpcScan(dir, 'kill');
}


/**
 * 无窗后台分离拉起外部进程（wscript.exe 或 frpc.exe），不阻塞主服务退出。
 * Windows 上这样拉起的进程仍在基地给 jmbots-server 套的 Job 里，后端热更时会被一起结束，
 * 所以 Windows 只在 WMI 拉不起来时才用它兜底。
 * @param command 可执行文件。
 * @param args 参数数组。
 * @param cwd 工作目录。
 * @returns 新进程 PID；拿不到时为 0。
 */
function spawnDetachedHidden(command: string, args: string[], cwd: string): number {
  const child = childProcess.spawn(command, args, {
    cwd,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
  return child.pid ?? 0;
}


/**
 * 经 WMI 的 Win32_Process.Create 无窗拉起进程的 PowerShell 脚本，成功时输出新进程 PID。
 * 新进程由 WMI 服务（WmiPrvSE.exe）创建，不在 jmbots-server 的进程树里，也不在基地给它套的 Job 里
 * （local/src/process_job.rs：KILL_ON_JOB_CLOSE、不许 breakaway），后端热更时 TerminateJobObject 带不走它。
 * 命令行和工作目录经环境变量 FRPC_LAUNCH_CMD、FRPC_LAUNCH_CWD 传入，路径含空格或特殊字符也不用转义。
 */
export const WMI_LAUNCH_SCRIPT = [
  "$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
  '$startup.ShowWindow = 0',
  "$result = ([wmiclass]'Win32_Process').Create($env:FRPC_LAUNCH_CMD, $env:FRPC_LAUNCH_CWD, $startup)",
  'if ($result.ReturnValue -eq 0) { Write-Output $result.ProcessId }',
].join('\n');


/**
 * 把可执行文件和参数拼成一条 Windows 命令行，带空白的部分用双引号包住（Windows 路径里不会有双引号）。
 * @param command 可执行文件。
 * @param args 参数数组。
 * @returns 交给 Win32_Process.Create 的命令行。
 */
export function buildWindowsCommandLine(command: string, args: string[]): string {
  const parts = [command, ...args];
  const quoted = parts.map((part) => {
    if (!/\s/u.test(part)) return part;

    return `"${part}"`;
  });
  return quoted.join(' ');
}


/**
 * 无窗拉起外部进程（托盘 wscript.exe 或 frpc.exe），让它活得比 jmbots-server 久。
 * Windows：经 WMI 创建（见 WMI_LAUNCH_SCRIPT），等 PowerShell 报回新进程 PID 再返回；
 * WMI 没拉起来时退回 spawnDetachedHidden，至少当场能起，只是后端热更时会被连带结束。
 * 其他平台没有基地的 Job，直接分离拉起。
 * @param command 可执行文件。
 * @param args 参数数组。
 * @param cwd 工作目录。
 * @returns 新进程 PID；拿不到时为 0。
 */
export async function launchOutsideJob(command: string, args: string[], cwd: string): Promise<number> {
  //M 非 Windows：直接分离拉起。
  if (process.platform !== 'win32') return spawnDetachedHidden(command, args, cwd);

  //M Windows：命令行和工作目录放进环境变量，交给 PowerShell 走 WMI 创建。
  const launchEnv = {
    FRPC_LAUNCH_CMD: buildWindowsCommandLine(command, args),
    FRPC_LAUNCH_CWD: cwd,
  };
  const out = await runHiddenPowerShell(WMI_LAUNCH_SCRIPT, launchEnv);
  const pid = readPid(out);
  if (pid > 0) return pid;

  //G WMI 没拉起来（服务被禁用等）→ 退回直接分离拉起。
  return spawnDetachedHidden(command, args, cwd);
}


/**
 * 把开机自启脚本写进 Windows Startup 目录：目录已在就不建，同目录写临时文件再改名，改名不成直接写。
 * Startup 是带系统属性的特殊目录，Windows 上的 Bun 对已存在的它跑 mkdirSync(recursive) 会抛 EEXIST，
 * 所以这里不走 Files.ts 的 writeTextAtomic（它总是先 ensureDir）。
 * @param file 目标脚本路径。
 * @param content 脚本正文。
 */
function writeStartupScript(file: string, content: string): void {
  //M 父目录真缺时（离线单测的临时 APPDATA）才建；已在的 Startup 目录不碰 mkdir。
  const parentDir = path.dirname(file);
  const parentStat = fs.statSync(parentDir, { throwIfNoEntry: false });
  if (parentStat?.isDirectory() !== true) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  //M 同目录写临时文件再改名盖过去，读的人要么看到旧的，要么看到新的。
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch {
    //G 改名没成（目标被占用等）→ 清掉临时文件，直接写目标。
    fs.rmSync(temp, { force: true });
    fs.writeFileSync(file, content, 'utf8');
  }
}


/** 短暂异步延时。 */
function delayMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}


/**
 * 创建默认的 Windows 外网隧道进程与开机自启执行器。
 * @param appdataOverride 可选 APPDATA 覆盖路径（默认取 process.env.APPDATA）。
 * @param launch 拉起托盘和 frpc.exe 的函数；默认本文件的 launchOutsideJob，单测注入假的。
 * @returns FrpcRunner 实例。
 */
export function createDefaultRunner(
  appdataOverride?: string,
  launch: DetachedLauncher = launchOutsideJob,
): FrpcRunner {
  const resolveAppdata = (): string => appdataOverride ?? process.env['APPDATA'] ?? '';

  const readLiveState = async (dir: string): Promise<LiveFrpcState> => {
    const snap = readTrayStatusSnapshot(dir);
    let trayPid = 0;
    if (snap !== undefined && snap.fresh && isPidAlive(snap.trayPid)) {
      trayPid = snap.trayPid;
    }
    if (trayPid === 0 && process.platform === 'win32') {
      trayPid = await findWindowsTrayPid(dir);
    }
    const trayRunning = trayPid > 0;

    //M 仅当托盘快照新鲜时才直接用 kill(pid, 0) 采信 frpcPid；快照过期时强制按真实可执行路径反查防 PID 复用误报。
    let pid = 0;
    if (snap !== undefined && snap.fresh && snap.frpcPid > 0 && isPidAlive(snap.frpcPid)) {
      pid = snap.frpcPid;
    }
    if (pid === 0 && process.platform === 'win32') {
      pid = await findWindowsFrpcPid(dir);
    }

    const nowStr = textModule.formatLocalTime(Date.now(), 'date');
    if (pid <= 0) {
      let updatedAt = nowStr;
      if (snap !== undefined && snap.updatedAt !== '') {
        updatedAt = snap.updatedAt;
      }
      return {
        running: false,
        connected: false,
        pid: 0,
        trayRunning,
        trayPid,
        detail: '已停止',
        updatedAt,
      };
    }

    //M 托盘状态新鲜且指向当前存活 PID 时直接采信，否则从 frpc.log 尾部实时判定连接态。
    if (snap !== undefined && snap.fresh && snap.frpcPid === pid && snap.detail !== '') {
      return {
        running: true,
        connected: snap.frpcConnected,
        pid,
        trayRunning,
        trayPid,
        detail: snap.detail,
        updatedAt: snap.updatedAt || nowStr,
      };
    }

    const logState = inspectLogConnection(dir);
    return {
      running: true,
      connected: logState.connected,
      pid,
      trayRunning,
      trayPid,
      detail: logState.detail,
      updatedAt: nowStr,
    };
  };

  const stopAction = async (dir: string): Promise<LiveFrpcState> => {
    await killDirFrpcOnly(dir);
    for (let i = 0; i < 8; i += 1) {
      const state = await readLiveState(dir);
      if (!state.running) return state;

      await delayMs(150);
    }
    return readLiveState(dir);
  };

  const startAction = async (dir: string): Promise<LiveFrpcState> => {
    const frpcExe = path.join(dir, 'frpc.exe');
    const frpcToml = path.join(dir, 'frpc.toml');
    if (!fs.existsSync(frpcExe) || !fs.existsSync(frpcToml)) {
      throw new failureModule.Failure(400, `客户端目录缺少 frpc.exe 或 frpc.toml：${dir}`);
    }

    const initial = await readLiveState(dir);
    const startTrayVbs = path.join(dir, 'start-tray.vbs');
    if (!initial.trayRunning && fs.existsSync(startTrayVbs)) {
      //M 托盘没在跑就拉起托盘；托盘起来后自己查重再带起 frpc.exe。
      await launch('wscript.exe', ['//B', '//NoLogo', startTrayVbs], dir);
      await delayMs(450);
    }

    //M 托盘没带起 frpc.exe（或没有托盘脚本）时直接拉起 frpc.exe。
    const mid = await readLiveState(dir);
    if (!mid.running) {
      await launch(frpcExe, ['-c', frpcToml], dir);
    }

    //M 最多轮询等待约 2.2 秒让新进程完成上线注册。
    let latest = await readLiveState(dir);
    for (let i = 0; i < 8; i += 1) {
      if (latest.running && latest.connected) return latest;

      await delayMs(260);
      latest = await readLiveState(dir);
    }
    return latest;
  };

  const control = (dir: string, action: FrpcControlAction): Promise<LiveFrpcState> => {
    const run = async (): Promise<LiveFrpcState> => {
      if (action === 'stop') return stopAction(dir);
      if (action === 'start') return startAction(dir);

      await stopAction(dir);
      return startAction(dir);
    };
    const next = controlQueue.then(run, run);
    controlQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  const readAutoStart = (): boolean => {
    const startupVbs = getStartupVbsPath(resolveAppdata());
    if (startupVbs === '') return false;

    return fs.existsSync(startupVbs);
  };

  const writeAutoStart = (dir: string, enabled: boolean): boolean => {
    const startupVbs = getStartupVbsPath(resolveAppdata());
    if (startupVbs === '') {
      throw new failureModule.Failure(500, '未找到 APPDATA 环境变量，无法定位 Windows 启动目录');
    }
    if (!enabled) {
      fs.rmSync(startupVbs, { force: true });
      return false;
    }

    const startTrayVbs = path.join(dir, 'start-tray.vbs');
    if (!fs.existsSync(startTrayVbs)) {
      throw new failureModule.Failure(400, `未找到托盘启动脚本：${startTrayVbs}`);
    }
    const content = buildStartupVbsContent(startTrayVbs);
    writeStartupScript(startupVbs, content);
    return true;
  };

  return { readLiveState, control, readAutoStart, writeAutoStart };
}
