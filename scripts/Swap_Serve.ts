/**
 * 换版本：jmbots 改了自己的代码后，自己检查、试运行新版本，再把正在服务的旧版本换掉（用户 11-02 的设想）。
 * 用户原话：“它先自己改自己，包括代码检查之类的，然后可以去开一个新端口去启动新的服务，例如 30087，
 * 然后它自己去测 30087 是不是做好了，之后通知……把 30086 关了重启成新版本，最后又去关 30087。”
 *
 * 用法（在 jmbots 目录，AI 用 exec 跑；超时给 300 秒）：
 *   bun scripts/Swap_Serve.ts [--port 30086] [--host 0.0.0.0] [--candidate_port 30087] [--skip_checks yes] [--force yes]
 *   --host 是新正式版本监听的地址，默认 0.0.0.0（用户 11-02 定：开发阶段全开）；试运行只听 127.0.0.1。
 * 分两段：
 *   前台  跑 typecheck、lint、tests，有一个不过就停下、打印出错的输出（exec 能看到），旧版本不动；
 *         都过了，把后台那段用独立进程启动，马上返回（不等它做完：它会停掉调用它的这个服务）。
 *   后台  1. 用新代码在 candidate_port 起一个试运行的服务（--mode candidate：不接飞书、不跑事件循环），查 /api/health；
 *         2. 试运行没问题：停掉 port 上的旧服务（按 data\serve_<端口>.pid），用新代码在 port 起正式服务，查 /api/health；
 *         3. 停掉试运行的服务；
 *         4. 环境变量 JMBOTS_SESSION_ID（exec 会带上）指明是哪个会话要换的：往那个会话插一条话，报告换成没换成。
 *   全程记在运行时 data\swap_<时间>.log；任何一步失败都会尽量让正式端口上有服务在跑，并在报告里说清楚。
 *
 * 起停进程那套（PowerShell Start-Process、按 pid 停、等健康检查）在 scripts/Serve_Process.ts，
 * 双击启动的 Start_Serve 和看门狗 Guard 用的是同一份——11-03 凌晨那次事故就出在起进程的方式上，
 * 不能再各写一份。换版本期间 data\swap.lock 有效，看门狗看到它就让开，不会插进来抢着起服务。
 * 换上去的新版本在正式端口稳稳跑够 5 分钟后，由看门狗存成快照（bak/versions/），当作下次能回退的版本。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child from 'node:child_process';
import * as serveProcess from './Serve_Process.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as utils from '../src/utils/Utils.ts';


/**
 * 跑一条检查命令，返回过没过和输出。
 * @param args bun 的参数。
 */
function runCheck(args: string[]): { ok: boolean; output: string } {
  /** 结果。 */
  const result = child.spawnSync(process.execPath, args, { cwd: serveProcess.ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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
  serveProcess.startServe({ runtimeDir, port: candidatePort, candidate: true }, serveProcess.timeId());
  if (!(await serveProcess.waitHealthy(candidatePort))) {
    await serveProcess.stopServe(runtimeDir, candidatePort);
    return `新版本在 ${candidatePort} 试运行没起来（${serveProcess.HEALTH_TIMEOUT_MS / 1000} 秒内 /api/health 不通），旧版本没动。看 ${runtimeDir}\\data 里最新的 serve_${candidatePort}_*.log。`;
  }
  log('试运行正常');

  //M 2. 换正式：停旧的，用新代码起。
  /** 停掉的旧进程。 */
  const oldPid = await serveProcess.stopServe(runtimeDir, port);
  log(`已停旧版本（进程 ${oldPid ?? '没找到'}）`);
  /** 端口还被谁占着（旧服务停了，但可能有继承了句柄的子进程）。 */
  const holder = serveProcess.pidOnPort(port);
  if (holder !== undefined) {
    log(`${serveProcess.PORT_FREE_SECONDS} 秒后 ${port} 还被进程 ${holder} 占着，照样试着起新版本`);
  }
  serveProcess.startServe({ runtimeDir, port, host: serveProcess.option('host', '0.0.0.0') }, serveProcess.timeId());
  /** 新版本起来了没有。 */
  const healthy = await serveProcess.waitHealthy(port);
  log(healthy ? `新版本已在 ${port} 运行` : `新版本在 ${port} 没起来`);

  //M 3. 停试运行。
  await serveProcess.stopServe(runtimeDir, candidatePort);
  log('已停试运行');
  if (!healthy) {
    return `试运行正常，但新版本在 ${port} 没起来${holder !== undefined ? `（端口一直被进程 ${holder} 占着）` : ''}（${serveProcess.HEALTH_TIMEOUT_MS / 1000} 秒内 /api/health 不通）；看门狗会接着试，再不行它会退回上一个能跑的快照。日志在 ${runtimeDir}\\data 里最新的 serve_${port}_*.log 和 guard_*.log。`;
  }
  return `换好了：检查都过了，新版本在 ${candidatePort} 试运行正常，已换到 ${port}（旧进程 ${oldPid ?? '未知'} 已停，试运行已关）。`;
}


/**
 * 入口：前台检查后把后台那段交给独立进程；后台进程（带 --background）做换版本。
 */
async function main(): Promise<void> {
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(process.env.JMBOTS_RUNTIME);
  /** 正式端口。 */
  const port = Number(serveProcess.option('port', '30086'));
  /** 试运行端口。 */
  const candidatePort = Number(serveProcess.option('candidate_port', '30087'));
  /** 锁文件：最近一次开始换版本的时间。看门狗也读它，在换版本期间让开。 */
  const lockFile = path.join(resources.dir, 'data', 'swap.lock');

  if (!process.argv.includes('--background')) {
    //G 3 分钟内已经有人开始换版本（周小灵和 Claude 经 DSH 撞过两次，后一次把前一次刚接着做的活又打断了），就不再换。
    if (serveProcess.isSwapping(resources.dir) && serveProcess.option('force', 'no') !== 'yes') {
      /** 上次开始换的时间，毫秒。 */
      const lockedAt = Number(fs.readFileSync(lockFile, 'utf8').trim());
      console.log(`${Math.round((Date.now() - lockedAt) / 1000)} 秒前已经有人开始换版本了，这次不换（要强行换加 --force yes）。看 ${path.join(resources.dir, 'data')} 里最新的 swap_*.log。`);
      return;
    }
    fs.writeFileSync(lockFile, String(Date.now()));
    //M 前台：检查。
    if (serveProcess.option('skip_checks', 'no') !== 'yes') {
      for (const [name, args] of [
        ['typecheck', ['run', 'typecheck']],
        ['lint', ['run', 'lint']],
        ['tests', ['test', './tests']],
      ] as const) {
        /** 结果。 */
        const result = runCheck([...args]);
        if (!result.ok) {
          console.log(`${name} 没过，不换版本（旧版本照常运行）。输出的结尾：\n${result.output.slice(-6000)}`);
          fs.rmSync(lockFile, { force: true });
          process.exit(1);
        }
        console.log(`${name} 通过`);
      }
    }
    //M 把后台那段交给独立进程（它会停掉调用它的服务，所以不能等它）。
    /** 后台进程。 */
    const backgroundPid = serveProcess.spawnDetached({
      args: [
        path.join(serveProcess.ROOT, 'scripts', 'Swap_Serve.ts'),
        '--background', 'yes',
        '--port', String(port),
        '--host', serveProcess.option('host', '0.0.0.0'),
        '--candidate_port', String(candidatePort),
        ...(process.env.JMBOTS_SESSION_ID ? ['--session_id', process.env.JMBOTS_SESSION_ID] : []),
      ],
    });
    console.log(`已在后台开始换版本（进程 ${backgroundPid ?? '?'}），过程记在 ${path.join(resources.dir, 'data')} 里最新的 swap_*.log；换完会往发起的会话插一条话报告结果。`);
    return;
  }

  //M 后台：换版本，记日志，最后报告给发起的会话。
  //G 前台段写锁到这里可能已经过了一分多钟（检查要时间），重写一次，免得换到一半锁过期、看门狗插进来抢着起服务。
  fs.writeFileSync(lockFile, String(Date.now()));
  /** 日志文件。 */
  const logFile = path.join(resources.dir, 'data', `swap_${utils.createSessionId()}.log`);
  /**
   * 写一行日志。
   * @param text 内容。
   */
  const log = (text: string): void => fs.appendFileSync(logFile, `${utils.formatTime()} ${text}\n`);
  /** 结论。 */
  let summary: string;
  try {
    summary = await swap(resources.dir, port, candidatePort, log);
  } catch (error) {
    summary = `换版本出错：${utils.errorText(error)}`;
  }
  log(summary);
  /** 发起的会话。 */
  const sessionId = serveProcess.option('session_id', '') || process.env.JMBOTS_SESSION_ID;
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
