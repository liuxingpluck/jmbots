/**
 * exec 工具（src/capabilities/tools/Tools.ts）的离线测试（消息 #97，算进 0.3.6）：
 * 命令在后台留下一个子进程、自己先退出时，exec 不能一直等下去——命令进程一退出最多再等
 * EXEC_EXIT_GRACE_MS（2 秒）读完输出就返回（11-06 周小灵用 start /b 起了个预览服务，
 * 后台 node 拿着输出管道不放，整个会话卡了一个半小时）。
 * 后台子进程是短命的（十几秒后自己结束），不是常驻服务；测试因此给 exec 一个较短的 timeout，
 * 断言它几秒内就返回、退出码 0、输出里有「好了」。
 * 全部用临时运行时和假渠道，不读真实配置、不联网、不停任何服务。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as toolsModule from '../src/capabilities/tools/Tools.ts';
import * as builders from './Builders.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 测试机器人名。 */
const BOT = '小测';

/** exec 的 timeout，秒：修好前会一直等到它（或后台子进程结束），修好后几秒就返回。 */
const EXEC_TIMEOUT_SECONDS = 12;

/** 修好后必须在这个时间内返回，毫秒（命令进程退出 + 2 秒收尾宽限，再留点余量）。 */
const RETURN_WITHIN_MS = 8000;


/** 一套测试用的临时运行时和依赖。 */
interface Harness {
  /** 临时运行时目录。 */
  dir: string;
  /** 工作目录。 */
  workDir: string;
  /** 标记文件（UTF-8 写的「好了」）；Windows cmd 直接 echo 中文会按 GBK 输出，用 type 原样输出才不会乱。 */
  marker: string;
  /** 依赖（工具库用它建）。 */
  deps: builders.TestDeps;
  /** 工具执行环境。 */
  context: toolsModule.ToolContext;
}


/**
 * 建一套依赖：临时运行时里写最小 config.yaml，真的资源、文件库、内存数据库，假的模型和渠道。
 * @returns 临时目录和工具执行环境。
 */
async function setup(): Promise<Harness> {
  /** 临时运行时目录（Windows 跑测试前先 set JMBOTS_TEST_TMP）。 */
  const dir = fs.mkdtempSync(path.join(process.env.JMBOTS_TEST_TMP ?? os.tmpdir(), 'jmbots-exec-'));
  /** 工作目录。 */
  const workDir = path.join(dir, 'workspace');
  fs.mkdirSync(workDir, { recursive: true });
  /** 标记文件：UTF-8 的「好了」，由 shell 用 type/cat 原样打到输出里。 */
  const marker = path.join(workDir, 'marker.txt');
  fs.writeFileSync(marker, '好了', 'utf8');
  fs.writeFileSync(path.join(dir, 'config.yaml'), `providers: {}\nbots:\n  - name: ${BOT}\n    language: zh\n`);
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot(BOT);
  /** 假模型：exec 用不到，被调到就说明测试写错了。 */
  const ai = builders.fakeAi({
    chat: () => Promise.reject(new Error('exec 测试不该调模型')),
    decide: () => Promise.reject(new Error('exec 测试不该调模型')),
    hasDecision: () => false,
    listModels: () => [],
  });
  /** 假渠道：exec 用不到。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  /** 依赖。 */
  const deps: builders.TestDeps = {
    resources,
    files,
    ai,
    store: new storeModule.Store(':memory:'),
    secrets: new secretsModule.Secrets([]),
    approvals: new approvalsModule.Approvals(),
    out,
  };
  return { dir, workDir, marker, deps, context: { bot: BOT, workDir, readOnly: false, vision: false } };
}


/**
 * 删掉临时目录；后台子进程可能还没退、暂时占着工作目录，删不掉就算了（临时目录在 cache/tmp 下）。
 * @param dir 临时运行时目录。
 */
function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    //G 后台 ping/sleep 还没退出，目录这轮删不掉，不影响测试结论。
  }
}


bunTest.describe('exec 后台子进程', () => {
  bunTest.test('留下后台子进程的命令：几秒内返回、退出码 0、输出里有「好了」', async () => {
    /** 临时运行时和执行环境。 */
    const harness = await setup();
    try {
      /**
       * Windows：start /b 起一个同一控制台的后台 cmd，它继承输出管道并活十几秒；
       * 外层 cmd 用 type 把 UTF-8 的「好了」原样打出来后马上退出，管道却还被子进程拿着。
       * 其他系统：sh 里 sleep 放后台，同样拿着管道；用 cat 原样输出标记文件。
       */
      const command = process.platform === 'win32'
        ? `start "" /b cmd /c "ping -n 14 127.0.0.1 >nul" & type "${harness.marker}"`
        : `sleep 14 & cat "${harness.marker}"`;
      /** 开始时间。 */
      const startedAt = Date.now();
      /** 结果。 */
      const result = await builders
        .toolBoxOf(harness.deps)
        .run('exec', { command, timeout: EXEC_TIMEOUT_SECONDS }, harness.context);
      /** 用时。 */
      const elapsedMs = Date.now() - startedAt;
      bunTest.expect(result.isError).toBe(false);
      bunTest.expect(result.text).toContain('好了');
      bunTest.expect(result.text).toContain('退出码 0');
      bunTest.expect(elapsedMs).toBeLessThan(RETURN_WITHIN_MS);
    } finally {
      cleanup(harness.dir);
    }
  }, 30_000);

  bunTest.test('普通命令照常返回（对照组）', async () => {
    /** 临时运行时和执行环境。 */
    const harness = await setup();
    try {
      /** 读标记文件的命令。 */
      const command =
        process.platform === 'win32' ? `type "${harness.marker}"` : `cat "${harness.marker}"`;
      const toolBox = builders.toolBoxOf(harness.deps);
      /** 结果。 */
      const result = await toolBox.run('exec', { command }, harness.context);
      bunTest.expect(result.isError).toBe(false);
      bunTest.expect(result.text).toContain('好了');
      bunTest.expect(result.text).toContain('退出码 0');
    } finally {
      cleanup(harness.dir);
    }
  }, 30_000);
});
