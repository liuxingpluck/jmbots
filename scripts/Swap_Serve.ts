/**
 * 换版本：jmbots 改了自己的代码后，自己检查、试运行新版本，再把正在服务的旧版本换掉（用户 11-02 的设想）。
 * 用户原话：“它先自己改自己，包括代码检查之类的，然后可以去开一个新端口去启动新的服务，例如 30087，
 * 然后它自己去测 30087 是不是做好了，之后通知……把 30086 关了重启成新版本，最后又去关 30087。”
 *
 * 用法（在 jmai 目录，AI 用 exec 跑；超时给 300 秒）：
 *   bun scripts/Swap_Serve.ts [--port 30086] [--host 0.0.0.0] [--candidate_port 30087] [--skip_checks yes]
 *   --host 是新正式版本监听的地址，默认 0.0.0.0（用户 11-02 定：开发阶段全开）；试运行只听 127.0.0.1。
 * 分两段：
 *   前台  跑 typecheck、lint、tests，有一个不过就停下、打印出错的输出（exec 能看到），旧版本不动；
 *         都过了，把后台那段用独立进程启动，马上返回（不等它做完：它会停掉调用它的这个服务）。
 *   后台  1. 用新代码在 candidate_port 起一个试运行的服务（--mode candidate：不接飞书、不跑事件循环），查 /api/health；
 *         2. 试运行没问题：停掉 port 上的旧服务（按 data\serve_<端口>.pid），用新代码在 port 起正式服务，查 /api/health；
 *         3. 停掉试运行的服务；
 *         4. 环境变量 JMBOTS_SESSION_ID（exec 会带上）指明是哪个会话要换的：往那个会话插一条话，报告换成没换成。
 *   全程记在运行时 data\swap_<时间>.log；任何一步失败都会尽量让正式端口上有服务在跑，并在报告里说清楚。
 */
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as runtimeModule from '../src/core/Runtime.ts';
import * as utils from '../src/utils/Utils.ts';


/** jmai 代码目录。 */
const ROOT = path.resolve(import.meta.dir, '..');

/** 等服务起来最多等多久，毫秒。 */
const HEALTH_TIMEOUT_MS = 90_000;


/**
 * 取 --名字 值。
 * @param name 参数名。
 * @param fallback 没给时的值。
 */
function option(name: string, fallback: string): string {
  /** 位置。 */
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}


/**
 * 跑一条检查命令，返回过没过和输出。
 * @param args bun 的参数。
 */
function runCheck(args: string[]): { ok: boolean; output: string } {
  /** 结果。 */
  const result = child.spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}


/**
 * 等某个端口上的服务健康（/api/health 回 ok）。
 * @param port 端口。
 * @returns 健康了没有。
 */
async function waitHealthy(port: number): Promise<boolean> {
  /** 截止时间。 */
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      /** 回应。 */
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      /** 内容。 */
      const body = (await response.json()) as { ok?: boolean };
      if (response.ok && body.ok === true) {
        return true;
      }
    } catch {
      // 还没起来，接着等。
    }
    await Bun.sleep(1000);
  }
  return false;
}


/**
 * 用当前代码在某个端口起服务（独立进程，输出写到运行时 data\serve_<端口>_<时间>.log）。
 * @param runtimeDir 运行时目录。
 * @param port 端口。
 * @param candidate 是不是试运行。
 */
function startServe(runtimeDir: string, port: number, candidate: boolean): number | undefined {
  /** 输出文件。 */
  const logFile = path.join(runtimeDir, 'data', `serve_${port}_${utils.createSessionId()}.log`);
  /** 输出文件句柄。 */
  const out = fs.openSync(logFile, 'a');
  /** 参数。 */
  const args = ['src/Main.ts', 'serve', '--port', String(port), ...(candidate ? ['--host', '127.0.0.1', '--mode', 'candidate'] : ['--host', option('host', '0.0.0.0')])];
  /** 新进程。 */
  const started = child.spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  started.unref();
  return started.pid;
}


/**
 * 用 netstat 找在某个端口上监听的进程（没有 pid 文件时用，比如旧版本还不会写 pid 文件）。
 * @param port 端口。
 * @returns 进程号；没找到时是 undefined。
 */
function pidOnPort(port: number): number | undefined {
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
 * 停掉某个端口上的服务（按 data\serve_<端口>.pid，没有就用 netstat 找；只停那一个进程，不连带它启动的命令），
 * 再等到端口空出来（最多 15 秒）。
 * @param runtimeDir 运行时目录。
 * @param port 端口。
 * @returns 停了哪个进程；没找到时是 undefined。
 */
async function stopServe(runtimeDir: string, port: number): Promise<number | undefined> {
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
    // 进程已经没了。
  }
  for (let waited = 0; waited < 15 && pidOnPort(port) !== undefined; waited += 1) {
    await Bun.sleep(1000);
  }
  return pid;
}


/**
 * 后台那段：试运行、换正式、停试运行、报告。
 * @param runtimeDir 运行时目录。
 * @param port 正式端口。
 * @param candidatePort 试运行端口。
 * @param log 写日志。
 */
async function swap(runtimeDir: string, port: number, candidatePort: number, log: (text: string) => void): Promise<string> {
  //M 1. 试运行新版本。
  log(`在 ${candidatePort} 试运行新版本`);
  startServe(runtimeDir, candidatePort, true);
  if (!(await waitHealthy(candidatePort))) {
    await stopServe(runtimeDir, candidatePort);
    return `新版本在 ${candidatePort} 试运行没起来（${HEALTH_TIMEOUT_MS / 1000} 秒内 /api/health 不通），旧版本没动。看 ${runtimeDir}\\data 里最新的 serve_${candidatePort}_*.log。`;
  }
  log('试运行正常');

  //M 2. 换正式：停旧的，用新代码起。
  /** 停掉的旧进程。 */
  const oldPid = await stopServe(runtimeDir, port);
  log(`已停旧版本（进程 ${oldPid ?? '没找到'}）`);
  if (pidOnPort(port) !== undefined) {
    await stopServe(runtimeDir, candidatePort);
    return `旧版本停不掉（${port} 端口 15 秒后还被占着），没换；试运行已关。`;
  }
  startServe(runtimeDir, port, false);
  /** 新版本起来了没有。 */
  const healthy = await waitHealthy(port);
  log(healthy ? `新版本已在 ${port} 运行` : `新版本在 ${port} 没起来`);

  //M 3. 停试运行。
  await stopServe(runtimeDir, candidatePort);
  log('已停试运行');
  if (!healthy) {
    return `试运行正常，但新版本在 ${port} 没起来（${HEALTH_TIMEOUT_MS / 1000} 秒内 /api/health 不通）；旧版本已经停了，要人看一下 ${runtimeDir}\\data 里最新的 serve_${port}_*.log。`;
  }
  return `换好了：检查都过了，新版本在 ${candidatePort} 试运行正常，已换到 ${port}（旧进程 ${oldPid ?? '未知'} 已停，试运行已关）。`;
}


/**
 * 入口：前台检查后把后台那段交给独立进程；后台进程（带 --background）做换版本。
 */
async function main(): Promise<void> {
  /** 运行时。 */
  const runtime = await runtimeModule.Runtime.load(process.env.JMBOTS_RUNTIME);
  /** 正式端口。 */
  const port = Number(option('port', '30086'));
  /** 试运行端口。 */
  const candidatePort = Number(option('candidate_port', '30087'));

  if (!process.argv.includes('--background')) {
    //M 前台：检查。
    if (option('skip_checks', 'no') !== 'yes') {
      for (const [name, args] of [
        ['typecheck', ['run', 'typecheck']],
        ['lint', ['run', 'lint']],
        ['tests', ['test', './tests']],
      ] as const) {
        /** 结果。 */
        const result = runCheck([...args]);
        if (!result.ok) {
          console.log(`${name} 没过，不换版本（旧版本照常运行）。输出的结尾：\n${result.output.slice(-6000)}`);
          process.exit(1);
        }
        console.log(`${name} 通过`);
      }
    }
    //M 把后台那段交给独立进程（它会停掉调用它的服务，所以不能等它）。
    /** 后台进程。 */
    const background = child.spawn(process.execPath, [path.join(ROOT, 'scripts', 'Swap_Serve.ts'), '--background', 'yes', '--port', String(port), '--host', option('host', '0.0.0.0'), '--candidate_port', String(candidatePort)], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    background.unref();
    console.log(`已在后台开始换版本（进程 ${background.pid ?? '?'}），过程记在 ${path.join(runtime.dir, 'data')} 里最新的 swap_*.log；换完会往发起的会话插一条话报告结果。`);
    return;
  }

  //M 后台：换版本，记日志，最后报告给发起的会话。
  /** 日志文件。 */
  const logFile = path.join(runtime.dir, 'data', `swap_${utils.createSessionId()}.log`);
  /**
   * 写一行日志。
   * @param text 内容。
   */
  const log = (text: string): void => fs.appendFileSync(logFile, `${utils.formatTime()} ${text}\n`);
  /** 结论。 */
  let summary: string;
  try {
    summary = await swap(runtime.dir, port, candidatePort, log);
  } catch (error) {
    summary = `换版本出错：${utils.errorText(error)}`;
  }
  log(summary);
  /** 发起的会话。 */
  const sessionId = process.env.JMBOTS_SESSION_ID;
  if (!sessionId) {
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text: `（系统）换版本的结果：${summary}日志：${logFile}`, wait: false }),
    });
    log(`已报告给会话 ${sessionId}`);
  } catch (error) {
    log(`报告给会话 ${sessionId} 没成：${utils.errorText(error)}`);
  }
}


await main();
