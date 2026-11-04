/**
 * 看门狗：让 jmbots 服务一直有人管，这样它才能自己改自己（用户 11-03 定）。
 *
 * 常驻一个很小的进程，每 30 秒查一次 `/api/health`：
 *   1. 通，而且这一版已经稳稳跑了 5 分钟 —— 把这份源码存成快照（`bak/versions/`），当作“已知能跑的版本”；
 *   2. 不通，但正在换版本（`data\swap.lock` 还有效）—— 让开，换版本中间本来就会断一下；
 *   3. 不通 —— 用当前代码起一次，连着 3 轮都起不来，就拿最近一份快照顶上，并通知用户和 Claude；
 *   4. 连快照都起不来 —— 停手，每 10 分钟再试一次，不无限重启（用户的要求：持续失败要有界止损）。
 *
 * 两条刻意的边界：
 *   - **不碰工作区的代码**。回退就是换个目录起服务；git 那边由用户自己管（他 11-03 明确说了）。
 *     快照的说明文件里记着对应的 git 提交号，要用 git 回退时按它找。
 *   - **不导入 src 下的任何东西**。看门狗是最后一道防线，不能因为被它看守的代码被改坏就跟着起不来。
 *
 * 用法：
 *   bun scripts/Guard.ts [--port 30086] [--host 0.0.0.0] [--runtime F:\aidata\AIJMBots]
 * 日志在运行时 `data\guard_<日期>.log`；心跳在 `data\guard.heartbeat`（Start_Serve 据此判断它还在不在）。
 * 一般不用手敲：双击 `scripts\Start_Serve.cmd`，或者开机自动起（见 scripts/Install_Autostart.ts）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as serveProcess from './Serve_Process.ts';
import * as snapshot from './Snapshot.ts';


/** 多久查一次，毫秒。 */
const CHECK_INTERVAL_MS = 30_000;

/** 连着几轮起不来才回退到快照。 */
const FAILS_BEFORE_ROLLBACK = 3;

/** 健康跑够多久才把这份源码存成快照，毫秒。 */
const SNAPSHOT_AFTER_HEALTHY_MS = 5 * 60_000;

/** 停手之后隔多久再试一次，毫秒。 */
const QUIET_RETRY_MS = 10 * 60_000;

/** 心跳多久没更新就算这只看门狗已经没了，毫秒。 */
export const HEARTBEAT_STALE_MS = 2 * 60_000;


/**
 * 心跳文件的位置。
 * @param runtimeDir 运行时目录。
 */
export function heartbeatFile(runtimeDir: string): string {
  return path.join(runtimeDir, 'data', 'guard.heartbeat');
}


/**
 * 现在有没有一只活着的看门狗（给 Start_Serve 和看门狗自己开工时判断用）。
 * @param runtimeDir 运行时目录。
 * @returns 心跳还新鲜就是 true。
 */
export function isGuardRunning(runtimeDir: string): boolean {
  /** 心跳文件。 */
  const file = heartbeatFile(runtimeDir);
  if (!fs.existsSync(file)) {
    return false;
  }
  return Date.now() - fs.statSync(file).mtimeMs < HEARTBEAT_STALE_MS;
}


/** 看门狗这一轮记着的事。 */
interface State {
  /** 连着几轮不健康了。 */
  fails: number;
  /** 这一段连续健康是从什么时候开始的，毫秒；不健康时是 undefined。 */
  healthySince: number | undefined;
  /** 这一段健康期有没有存过快照（一段只存一次）。 */
  saved: boolean;
  /** 现在跑的是哪份快照；undefined 表示跑的是工作区的代码。 */
  rolledBackTo: string | undefined;
  /** 已经试过、起不来的快照 ID，不再重复试。 */
  skipIds: string[];
  /** 已经停手：都起不来，只每 QUIET_RETRY_MS 再试一次。 */
  quietUntil: number | undefined;
}


/**
 * 通知用户和 Claude：往运行时的飞书发件箱放一份（服务在跑时会发给用户），
 * 同时往 给Claude 目录留一份（Claude 下次接手时能看到）。
 * 发件箱要有服务在跑才发得出去；彻底起不来的那种情况，就只有留言和日志了。
 * @param runtimeDir 运行时目录。
 * @param title 标题。
 * @param body 正文。
 */
function notify(runtimeDir: string, title: string, body: string): void {
  /** 文件名用的 ID。 */
  const id = serveProcess.timeId();
  /** 文件名里能用的标题。 */
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  /** 两处要写的内容。 */
  const text = `# ${title}\n\n- 来自：看门狗（scripts/Guard.ts）\n- 时间：${serveProcess.timeText()}\n\n${body}\n`;
  for (const dir of [path.join(runtimeDir, 'integrations', 'claude', 'inbox'), path.join(runtimeDir, serveProcess.OUTBOX_DIR)]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}_${safeTitle}.md`), text);
    } catch {
      //G 写不进去（目录没了、盘满了）也不能让看门狗自己停掉。
    }
  }
}


/**
 * 真的不健康吗：隔几秒再查一次，两次都不通才算。
 * 偶发一次查不通（服务正忙、刚好在 GC）不该把一个好服务杀掉重启。
 * @param port 端口。
 * @returns 两次都不通就是 true。
 */
async function confirmDown(port: number): Promise<boolean> {
  await Bun.sleep(3000);
  return !(await serveProcess.isHealthy(port));
}


/**
 * 起一次服务并等它健康。
 * @param runtimeDir 运行时目录。
 * @param port 端口。
 * @param root 用哪份代码；undefined 表示工作区。
 * @returns 起来了没有。
 */
async function startAndWait(runtimeDir: string, port: number, root: string | undefined): Promise<boolean> {
  //M 端口可能还被半死的旧进程占着，先按 pid 文件停一下再起。
  await serveProcess.stopServe(runtimeDir, port);
  serveProcess.startServe({ runtimeDir, port, root, host: serveProcess.option('host', '0.0.0.0') }, serveProcess.timeId());
  return serveProcess.waitHealthy(port);
}


/**
 * 服务不健康时这一轮该做什么：先用当前代码起，起够次数还不行就回退到快照，快照也不行就停手。
 * @param runtimeDir 运行时目录。
 * @param port 端口。
 * @param state 看门狗的状态，会被改。
 * @param log 写日志。
 */
async function handleDown(runtimeDir: string, port: number, state: State, log: (text: string) => void): Promise<void> {
  state.fails += 1;

  //M 前几次：就用现在跑着的那份代码再起一次。
  if (state.fails <= FAILS_BEFORE_ROLLBACK) {
    log(`服务不通（第 ${state.fails} 次），用${state.rolledBackTo ? `快照 ${state.rolledBackTo}` : '工作区代码'}起一次`);
    if (await startAndWait(runtimeDir, port, state.rolledBackTo ? path.join(snapshot.VERSIONS_DIR, state.rolledBackTo) : undefined)) {
      log('起来了');
      state.fails = 0;
    }
    return;
  }

  //M 起不来了：拿最近一份还没试过的快照顶上。
  /** 要回退到的快照。 */
  const version = snapshot.latest(state.skipIds);
  if (!version) {
    //G 没有可用快照（第一次用、或者都试过了）：停手，别无限重启。
    state.quietUntil = Date.now() + QUIET_RETRY_MS;
    log(`没有能用的快照了，停手 ${QUIET_RETRY_MS / 60_000} 分钟再试`);
    notify(
      runtimeDir,
      'jmbots 起不来了，看门狗停手等人',
      `连着 ${state.fails} 次起不来，${state.skipIds.length > 0 ? `${state.skipIds.length} 份快照也都试过了` : '还没有存下任何快照'}。\n\n看 ${runtimeDir}\\data 里最新的 serve_${port}_*.log 和 guard_*.log。每 ${QUIET_RETRY_MS / 60_000} 分钟我还会再试一次。`,
    );
    return;
  }
  log(`回退到快照 ${version.id}（存于 ${version.savedAt}，git ${version.commit || '未知'}${version.dirty ? ' + 未提交改动' : ''}）`);
  if (!(await startAndWait(runtimeDir, port, version.dir))) {
    //G 这份快照也起不来，记下别再试它，下一轮换更早的一份。
    state.skipIds.push(version.id);
    log(`快照 ${version.id} 也起不来，下一轮换更早的一份`);
    return;
  }
  state.rolledBackTo = version.id;
  state.fails = 0;
  log(`快照 ${version.id} 已在 ${port} 跑起来`);
  notify(
    runtimeDir,
    'jmbots 已自动退回上一个能跑的版本',
    `工作区那版连着 ${FAILS_BEFORE_ROLLBACK} 次起不来，现在跑的是快照 ${version.id}（存于 ${version.savedAt}，对应 git 提交 ${version.commit || '未知'}${version.dirty ? '，当时还有没提交的改动' : ''}）。\n\n工作区的代码一个字节都没动。修好之后跑 \`bun run swap\` 换回去就行。\n日志：${runtimeDir}\\data 里最新的 serve_${port}_*.log。`,
  );
}


/**
 * 服务健康时这一轮该做什么：跑够 5 分钟就把这份源码存成快照。
 * @param runtimeDir 运行时目录。
 * @param state 看门狗的状态，会被改。
 * @param log 写日志。
 */
function handleUp(runtimeDir: string, state: State, log: (text: string) => void): void {
  if (state.fails > 0 || state.quietUntil !== undefined) {
    log('服务恢复正常');
  }
  state.fails = 0;
  state.quietUntil = undefined;
  state.healthySince ??= Date.now();

  //G 跑的是快照（已经回退过）时不存快照：那份源码本来就是从快照来的，存了只是复制一遍。
  if (state.saved || state.rolledBackTo !== undefined) {
    return;
  }
  /** 已经健康跑了多久，毫秒。 */
  const healthyMs = Date.now() - state.healthySince;
  if (healthyMs < SNAPSHOT_AFTER_HEALTHY_MS) {
    return;
  }
  try {
    /** 存好的快照。 */
    const version = snapshot.save(serveProcess.timeId(), Math.round(healthyMs / 1000));
    state.saved = true;
    log(`这一版稳定跑了 ${Math.round(healthyMs / 60_000)} 分钟，已存成快照 ${version.id}（git ${version.commit || '未知'}${version.dirty ? ' + 未提交改动' : ''}）`);
  } catch (error) {
    //G 存快照失败不影响服务，下一轮还会再试（saved 没置上）。
    log(`存快照没成：${serveProcess.errorText(error)}`);
  }
}


/**
 * 入口：先确认没有别的看门狗在跑，然后一直守着。
 */
async function main(): Promise<void> {
  /** 运行时目录。 */
  const runtimeDir = serveProcess.runtimeDir();
  /** 正式端口。 */
  const port = Number(serveProcess.option('port', '30086'));
  fs.mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });

  //G 已经有一只在跑就不再起第二只（两只会互相抢着起服务）。
  if (isGuardRunning(runtimeDir)) {
    console.log(`已经有一只看门狗在跑了（心跳 ${heartbeatFile(runtimeDir)}），这次不起。`);
    return;
  }

  /** 日志文件，按天一个。 */
  const logFile = path.join(runtimeDir, 'data', `guard_${serveProcess.timeId().slice(0, 8)}.log`);
  /**
   * 写一行日志，同时打印出来（双击启动时能在窗口里看到）。
   * @param text 内容。
   */
  const log = (text: string): void => {
    /** 带时间的一行。 */
    const line = `${serveProcess.timeText()} ${text}`;
    console.log(line);
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      //G 日志写不进去也要接着守。
    }
  };
  /** 这一轮记着的事。 */
  const state: State = { fails: 0, healthySince: undefined, saved: false, rolledBackTo: undefined, skipIds: [], quietUntil: undefined };
  /** 开发模式的提示只在刚按住、刚放开时各写一次，别每 30 秒刷一行。 */
  let devNoted = false;
  log(`看门狗开工：守着 ${port}，运行时 ${runtimeDir}，每 ${CHECK_INTERVAL_MS / 1000} 秒查一次`);

  while (true) {
    try {
      //M 心跳：让 Start_Serve 和下一只看门狗知道这里有人了。
      fs.writeFileSync(heartbeatFile(runtimeDir), serveProcess.timeText());

      /** 开发模式按到什么时候；没按住就是 undefined。 */
      const devUntil = serveProcess.devHoldUntil(runtimeDir);
      //G 开发模式：只看不动手。不起服务、不回退、不存快照——开发时服务本来就会被反复停掉和改坏。
      if (devUntil !== undefined) {
        if (!devNoted) {
          log(`开发模式按住了，只看不动手（到 ${new Date(devUntil).toLocaleTimeString('zh-CN', { hour12: false })} 自动放开）`);
          devNoted = true;
        }
        state.fails = 0;
        state.saved = false;
        state.healthySince = undefined;
        await Bun.sleep(CHECK_INTERVAL_MS);
        continue;
      }
      //G 刚从开发模式出来：说一声，下次再按住时还要提示。
      if (devNoted) {
        log('开发模式放开了，看门狗恢复正常');
        devNoted = false;
      }

      if (serveProcess.isSwapping(runtimeDir)) {
        //G 正在换版本：服务本来就会断一下，让开。换版本一定是用工作区代码起的，所以把回退状态清掉，给新代码机会。
        if (state.rolledBackTo !== undefined || state.skipIds.length > 0) {
          log('有人在换版本，清掉回退状态');
        }
        state.rolledBackTo = undefined;
        state.skipIds = [];
        state.fails = 0;
        state.saved = false;
        state.healthySince = undefined;
      } else if (state.quietUntil !== undefined && Date.now() < state.quietUntil) {
        //G 停手期间什么都不做，等时间到。
      } else if (await serveProcess.isHealthy(port)) {
        handleUp(runtimeDir, state, log);
      } else if (await confirmDown(port)) {
        state.healthySince = undefined;
        state.saved = false;
        await handleDown(runtimeDir, port, state, log);
      } else {
        //G 复查时又通了，只是刚才那一下没答上来，什么都不做。
        handleUp(runtimeDir, state, log);
      }
    } catch (error) {
      //G 一轮里出任何意外都不能让看门狗退出。
      log(`这一轮出错（接着守）：${serveProcess.errorText(error)}`);
    }
    await Bun.sleep(CHECK_INTERVAL_MS);
  }
}


//G 只有直接 bun scripts/Guard.ts 才真的开始守；别处 import 它（测试、Start_Serve 用 isGuardRunning）不能起进程。
if (import.meta.main) {
  await main();
}
