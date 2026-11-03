/**
 * 双击启动：确保 jmbots 服务在跑，而且有看门狗守着。
 *
 * 做三件事：
 *   1. 服务已经在跑就什么都不动，只补上看门狗（如果它不在）；
 *   2. 网页还没打包过（没有 dist/web）就先打包一次；
 *   3. 起看门狗。服务由看门狗去起——这样"谁负责起服务"只有一个答案，不会两边抢。
 *
 * 入口是 `scripts\Start_Serve.cmd`（双击那个）。开机自动启动走的是另一条路：
 * 启动文件夹里的 .vbs 直接起看门狗，全程没有窗口（见 scripts/Install_Autostart.ts）。
 *
 * 用法：bun scripts/Start_Serve.ts [--port 30086] [--host 0.0.0.0] [--runtime F:\aidata\AIJMBots]
 */
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as guard from './Guard.ts';
import * as serveProcess from './Serve_Process.ts';


/** 等服务起来最多等多久，毫秒（看门狗起服务本身还要等健康检查，这里给宽一点）。 */
const WAIT_MS = 120_000;


/**
 * 起看门狗（独立进程，输出进它自己的日志），并等它写出第一次心跳。
 * @param runtimeDir 运行时目录。
 * @returns 起来了没有。
 */
async function startGuard(runtimeDir: string): Promise<boolean> {
  /** 看门狗的输出文件。 */
  const logFile = path.join(runtimeDir, 'data', `guard_start_${serveProcess.timeId()}.log`);
  serveProcess.spawnDetached({
    args: [
      path.join(serveProcess.ROOT, 'scripts', 'Guard.ts'),
      '--port', serveProcess.option('port', '30086'),
      '--host', serveProcess.option('host', '0.0.0.0'),
      '--runtime', runtimeDir,
    ],
    logFile,
  });
  for (let waited = 0; waited < 20; waited += 1) {
    await Bun.sleep(500);
    if (guard.isGuardRunning(runtimeDir)) {
      return true;
    }
  }
  console.log(`看门狗没起来，看 ${logFile}`);
  return false;
}


/**
 * 入口。
 */
async function main(): Promise<void> {
  /** 运行时目录。 */
  const runtimeDir = serveProcess.runtimeDir();
  /** 正式端口。 */
  const port = Number(serveProcess.option('port', '30086'));
  fs.mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });
  console.log(`jmbots 启动：端口 ${port}，运行时 ${runtimeDir}`);

  //M 1. 已经在跑就只补看门狗。
  if (await serveProcess.isHealthy(port)) {
    console.log(`服务已经在跑：http://127.0.0.1:${port}`);
    if (guard.isGuardRunning(runtimeDir)) {
      console.log('看门狗也在，什么都不用做。');
      return;
    }
    console.log('看门狗不在，补起来。');
    await startGuard(runtimeDir);
    return;
  }

  //M 2. 网页没打包过就先打包（第一次用，或者清过 dist）。
  if (!fs.existsSync(path.join(serveProcess.ROOT, 'dist', 'web'))) {
    console.log('还没打包过网页，先打包（要一会儿）……');
    /** 打包结果。 */
    const built = child.spawnSync(process.execPath, ['run', 'build:web'], { cwd: serveProcess.ROOT, encoding: 'utf8', windowsHide: true });
    if (built.status !== 0) {
      //G 网页打包失败不挡住服务：接口和飞书照样能用，只是网页打不开。
      console.log(`网页打包没成（接口和飞书不受影响）：\n${`${built.stdout ?? ''}${built.stderr ?? ''}`.slice(-2000)}`);
    } else {
      console.log('网页打包好了。');
    }
  }

  //M 3. 起看门狗，服务由它去起。
  if (guard.isGuardRunning(runtimeDir)) {
    console.log('看门狗已经在跑，等它把服务起起来……');
  } else if (!(await startGuard(runtimeDir))) {
    return;
  }
  console.log('等服务起来……');
  if (await serveProcess.waitHealthy(port, WAIT_MS)) {
    console.log(`好了：http://127.0.0.1:${port}（网页 http://127.0.0.1:${port}/ ，事件白盒子 /#/events）`);
    return;
  }
  console.log(`${WAIT_MS / 1000} 秒内没起来。看这两个日志：\n  ${path.join(runtimeDir, 'data')} 里最新的 serve_${port}_*.log\n  ${path.join(runtimeDir, 'data')} 里最新的 guard_*.log`);
}


await main();
