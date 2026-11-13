/**
 * 重启看门狗：先停掉正在跑的那只，再起一只新的。
 *
 * 为什么要有这个：看门狗是常驻进程，内存里跑的是它**启动那一刻**的代码。
 * 改了 scripts/Guard.ts（比如加了开发模式 dev:hold）之后，换版本只换服务，看门狗还是老的，
 * 新功能要等它重启一次才认。Start_Serve 发现已经有一只在跑就不会再起第二只，所以必须先停。
 *
 * 用法：bun scripts/Guard_Restart.ts（或 bun run guard:restart）
 * 只停"命令行里带 Guard.ts"的进程，不碰服务本身（服务也是 bun，但跑的是 src/entries/Main.ts）。
 */
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as guard from './Guard.ts';
import * as serveProcess from './Serve_Process.ts';


/** 停掉之后最多等多久确认它真的没了，毫秒。 */
const STOP_WAIT_MS = 10_000;

/** 起好之后最多等多久等到第一下心跳，毫秒。 */
const HEARTBEAT_WAIT_MS = 60_000;


/**
 * 找出并停掉正在跑的看门狗进程。
 * @returns 停掉的进程号；一个都没有就是空数组。
 * 副作用：真的结束那些进程。
 */
function stopGuards(): number[] {
  //G 只有 Windows 上需要按命令行匹配找（看门狗是 PowerShell Start-Process 起的后台进程）。
  if (process.platform !== 'win32') {
    console.log('不是 Windows，跳过查找；本机上看门狗是前台跑的，Ctrl+C 停掉再重跑即可。');
    return [];
  }
  /** 查出所有命令行里带 Guard.ts 的进程号，一行一个。 */
  const query = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*Guard.ts*' -and $_.CommandLine -notlike '*Guard_Restart.ts*' } | ForEach-Object { $_.ProcessId }";
  /** PowerShell 的输出。 */
  const output = child.spawnSync('powershell.exe', ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  /** 看门狗进程号。 */
  const pids = output.split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
  for (const pid of pids) {
    console.log(`停掉看门狗进程 ${pid}`);
    child.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  }
  return pids;
}


/**
 * 起一只新的看门狗（和 Start_Serve 用同一套参数）。
 * @param runtimeDir 运行时目录。
 * @returns 新进程号；起失败时没有。
 * 副作用：起一个后台进程，输出写进 data\guard_start_<时间>.log。
 */
function startGuard(runtimeDir: string): number | undefined {
  /** 启动输出写哪儿。 */
  const logFile = path.join(runtimeDir, 'data', `guard_start_${serveProcess.timeId()}.log`);
  return serveProcess.spawnDetached({
    args: [
      path.join(serveProcess.ROOT, 'scripts', 'Guard.ts'),
      '--port', serveProcess.option('port', '30086'),
      '--host', serveProcess.option('host', '0.0.0.0'),
      '--runtime', runtimeDir,
    ],
    logFile,
  });
}


/**
 * 停旧的、起新的、等它报第一下心跳。
 * @returns 无。
 * @throws 等不到心跳时抛错（这时服务没人守，要人看一眼）。
 */
async function main(): Promise<void> {
  /** 运行时目录。 */
  const runtimeDir = serveProcess.runtimeDir();
  /** 心跳文件。 */
  const beat = guard.heartbeatFile(runtimeDir);
  console.log(`重启看门狗：运行时 ${runtimeDir}`);

  //M 1. 停掉旧的。
  /** 停掉的进程号。 */
  const stopped = stopGuards();
  if (stopped.length === 0) {
    console.log('没找到正在跑的看门狗（可能本来就没起），直接起一只新的。');
  }
  for (let waited = 0; waited < STOP_WAIT_MS && guard.isGuardRunning(runtimeDir); waited += 500) {
    await Bun.sleep(500);
  }

  //M 2. 心跳文件留着会让新的那只以为"已经有一只在跑"，先删掉。
  fs.rmSync(beat, { force: true });

  //M 3. 起新的。
  /** 新进程号。 */
  const started = startGuard(runtimeDir);
  console.log(`已起新看门狗${started === undefined ? '' : `（进程 ${String(started)}）`}，等它报第一下心跳……`);

  //M 4. 等心跳：等到了才算真起来了。
  for (let waited = 0; waited < HEARTBEAT_WAIT_MS; waited += 1000) {
    if (fs.existsSync(beat)) {
      console.log(`好了，看门狗在守着（心跳 ${fs.readFileSync(beat, 'utf8').trim()}）。现在 bun run dev:hold 才真的管用。`);
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`起了新看门狗但 ${HEARTBEAT_WAIT_MS / 1000} 秒内没等到心跳，去看 ${path.join(runtimeDir, 'data')} 里最新的 guard_start_*.log`);
}


//G 只有直接跑才执行；别处 import 它不能真的去杀进程。
if (import.meta.main) {
  await main();
}
