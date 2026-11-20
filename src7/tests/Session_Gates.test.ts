/**
 * 会话的四个关口（src7/Sessions.ts、src7/Tools.ts）：session/before-model、session/after-model、session/before-tool、
 * session/after-tool 上写 stop 就停下；after-tool 能改结果；不按步数限制，工具连着要几十轮也走到底；
 * 步数 row.steps 跨 run 累计；打开过的会话表有上限，超了挪出闲着的。
 * 真实 Cordis + 骨架 Sessions、Tools；模型是假回答（session/before-model 里填 answer），库是内存库。
 * 另从 Main.ts 启动独立进程，验证插件挂载超时、apply 抛错时记下的状态，以及 /api/health 的 problems 照这些状态报。
 * 跑法：bun test ./src7/tests/Session_Gates.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as httpModule from '../plugins/http/index.ts';
import * as resourcesModule from '../Resources.ts';
import * as sessionsModule from '../Sessions.ts';
import * as toolsModule from '../Tools.ts';
import * as utils from '../utils/index.ts';
import * as textModule from '../utils/Text.ts';


//M 每个用例收拾自己的 Cordis。
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


//M 假资源：会话只用到内存库和 config 里的默认模型、思考档。
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly config = {
    defaultModel: 'fake/fake',
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
    sessionCacheMax: 500,
  };

  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
}


/** world() 交回的东西。 */
interface World {
  /** 挂好骨架的 Cordis。 */
  ctx: cordis.Context;
  /** 一场新会话，已经说了一句“开始”，还没 run。 */
  session: sessionsModule.Session;
  /** 工具 echo 真正执行了几次。 */
  ran: { count: number };
  /** 每次 session/change 时的状态，照先后。 */
  states: string[];
}


/**
 * 挂上骨架，登记工具 echo（会话种类 t 能用），挂上假模型。
 * 假模型：对话里的工具结果不到 rounds × calls 条，就再要 calls 个 echo；够了就回“做完了”。
 * @param rounds 要几轮工具。
 * @param calls 每轮一次要几个 echo。
 */
async function world(rounds: number, calls: number): Promise<World> {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);

  //M 工具 echo：回 ok，执行一次记一次。
  const ran = { count: 0 };
  ctx.tools.register({
    definition: { name: 'echo', description: '回 ok', parameters: piAi.Type.Object({}) },
    sessionKinds: ['t'],
    run: () => {
      ran.count += 1;
      return 'ok';
    },
  });

  //M 假模型。
  ctx.on('session/before-model', (request) => {
    const results = request.messages.filter((item) => item.role === 'toolResult');
    if (results.length >= rounds * calls) {
      request.answer = piAi.fauxAssistantMessage('做完了');
      return;
    }

    const blocks = Array.from({ length: calls }, () => piAi.fauxToolCall('echo', {}));
    request.answer = piAi.fauxAssistantMessage(blocks, { stopReason: 'toolUse' });
  });

  //M 记下每次状态变化，看停下的通知只发一次。
  const states: string[] = [];
  ctx.on('session/change', (session) => {
    states.push(session.row.state);
  });

  const session = ctx.sessions.create({ kind: 't', bot: '测试' });
  session.queueUserMessage('开始');
  return { ctx, session, ran, states };
}


/**
 * 对话里每条的角色，照先后。
 * @param session 哪场会话。
 */
function getRoles(session: sessionsModule.Session): string[] {
  return session.row.messages.map((item) => item.role);
}


/**
 * 对话里每条工具结果的文字，照先后。
 * @param session 哪场会话。
 */
function getResultTexts(session: sessionsModule.Session): string[] {
  const results = session.row.messages.filter((item): item is piAi.ToolResultMessage => {
    return item.role === 'toolResult';
  });
  return results.map((item) => piAi.contentText(item.content));
}


test('不数步数：工具连着要 40 轮（原来默认 30 步就停）也走到做完', async () => {
  const { session, ran } = await world(40, 1);
  await session.run();

  expect(session.row.state).toBe('done');
  expect(session.row.reply).toBe('做完了');
  expect(ran.count).toBe(40);
});


test('关口一 session/before-model 写 stop：不调模型，停下，理由写进 reply', async () => {
  const { ctx, session, states } = await world(1, 1);
  ctx.on('session/before-model', (request) => {
    request.stop = '先别调';
  });
  await session.run();

  expect(session.row.state).toBe('stopped');
  expect(session.row.reply).toBe('已停止（先别调）');
  expect(getRoles(session)).toEqual(['user']);
  expect(states).toEqual(['running', 'stopped']);
});


test('关口二 session/after-model 能换回答；写 stop 这次回答不要了，工具也不执行', async () => {
  //M 换回答：把要工具的回答换成一句话，会话就做完了，工具没执行。
  const first = await world(1, 1);
  first.ctx.on('session/after-model', (request) => {
    request.answer = piAi.fauxAssistantMessage('换过的回答');
  });
  await first.session.run();
  expect(first.session.row.state).toBe('done');
  expect(first.session.row.reply).toBe('换过的回答');
  expect(first.ran.count).toBe(0);

  //M 喊停：回答不接进对话。
  const second = await world(1, 1);
  second.ctx.on('session/after-model', (request) => {
    request.stop = '回答不对';
  });
  await second.session.run();
  expect(second.session.row.state).toBe('stopped');
  expect(second.session.row.reply).toBe('已停止（回答不对）');
  expect(getRoles(second.session)).toEqual(['user']);
  expect(second.ran.count).toBe(0);
});


test('关口三 session/before-tool 写 stop：这个工具不执行，后面的也不执行，会话停下', async () => {
  const { ctx, session, ran, states } = await world(1, 2);
  ctx.on('session/before-tool', (gate) => {
    gate.stop = '不许再调';
  });
  await session.run();

  expect(session.row.state).toBe('stopped');
  expect(session.row.reply).toBe('已停止（不许再调）');
  expect(ran.count).toBe(0);
  expect(getResultTexts(session)).toEqual(['未执行：不许再调', '未执行：停下来了']);
  expect(states).toEqual(['running', 'stopped']);
});


test('关口四 session/after-tool 能改结果；写 stop 结果照样接进对话，后面的工具不执行，停下只通知一次', async () => {
  //M 改结果：接进对话的是改过的文字。
  const first = await world(1, 1);
  first.ctx.on('session/after-tool', (done) => {
    done.outcome = { text: `改过：${done.outcome.text}`, isError: false };
  });
  await first.session.run();
  expect(first.session.row.state).toBe('done');
  expect(getResultTexts(first.session)).toEqual(['改过：ok']);

  //M 喊停：一次要两个工具，第一个做完就喊停；第二个不执行，结果写“未执行”，它的 after-tool 再喊也不再停一次。
  const second = await world(1, 2);
  second.ctx.on('session/after-tool', (done) => {
    done.stop = '够了';
  });
  await second.session.run();
  expect(second.session.row.state).toBe('stopped');
  expect(second.session.row.reply).toBe('已停止（够了）');
  expect(second.ran.count).toBe(1);
  expect(getResultTexts(second.session)).toEqual(['ok', '未执行：停下来了']);
  expect(second.states).toEqual(['running', 'stopped']);
});


test('步数跨 run 累计：喊停后再 run 接着加，不归零；从库读回不变，早先没有 steps 的补 0', async () => {
  //M 工具要 3 轮，第 2 步的工具执行完就喊停。
  const { ctx, session } = await world(3, 1);
  ctx.on('session/after-tool', (done) => {
    if (done.session.row.steps === 2) {
      done.stop = '先停一下';
    }
  });
  await session.run();
  expect(session.row.state).toBe('stopped');
  expect(session.row.steps).toBe(2);

  //M 再说一句接着跑：第 3 步要最后一个工具，第 4 步做完。
  session.queueUserMessage('接着做');
  await session.run();
  expect(session.row.state).toBe('done');
  expect(session.row.steps).toBe(4);

  //M 上限改成 1 再开一场，这场被挪出内存；再 open 从库读回，步数不变。
  ctx.resources.config.sessionCacheMax = 1;
  ctx.sessions.create({ kind: 't', bot: '测试' });
  const reopened = ctx.sessions.open(session.id);
  expect(reopened).not.toBe(session);
  expect(reopened.row.steps).toBe(4);
  const found = ctx.sessions.find({ id: session.id });
  expect(found[0]?.steps).toBe(4);

  //M 早先存的会话 meta 里没有 steps：读库那一处补 0。
  const oldMeta = {
    id: 'old',
    kind: 't',
    model: 'fake/fake',
    thinking: 'low',
    state: 'done',
    reply: '',
    updatedAt: 1,
  };
  const oldJson = JSON.stringify(oldMeta);
  const sql = 'INSERT INTO sessions (id, meta, messages) VALUES (?, ?, ?)';
  const insert = ctx.resources.db.query(sql);
  insert.run('old', oldJson, '[]');
  expect(ctx.sessions.open('old').row.steps).toBe(0);
});


test('打开过的会话有上限：超了挪出最久没用、闲着的，再 open 从库读回新对象；在转的不挪', async () => {
  //M 上限 2。world 开的那场先转起来，卡在关口一等放行。
  const { ctx, session: running } = await world(1, 1);
  ctx.resources.config.sessionCacheMax = 2;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  ctx.on('session/before-model', async () => {
    await gate;
  });
  const runningDone = running.run();

  //M 再开 3 场闲着的：每超一次挪出最旧的闲着那场，在转的那场一直跳过。
  const input = { kind: 't', bot: '测试' };
  const oldest = ctx.sessions.create(input);
  ctx.sessions.create(input);
  const newest = ctx.sessions.create(input);
  expect(ctx.sessions.open(running.id)).toBe(running);
  expect(ctx.sessions.open(newest.id)).toBe(newest);

  //M 最旧的那场被挪出过：再 open 从库读回，是新对象，记录一样。
  const reopened = ctx.sessions.open(oldest.id);
  expect(reopened).not.toBe(oldest);
  expect(reopened.row).toEqual(oldest.row);

  //M 放行，在转的那场照常跑完。
  release();
  await runningDone;
  expect(running.row.state).toBe('done');
});


/** 等测试插件原子写出的启动状态。 */
async function readMountStatuses(
  file: string,
  child: { readonly exitCode: number | null },
): Promise<resourcesModule.PluginStatus[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const snapshot = fs.readFileSync(file, 'utf8');
      return JSON.parse(snapshot) as resourcesModule.PluginStatus[];
    }
    if (child.exitCode !== null) {
      throw new Error(`测试进程提前退出，退出码 ${String(child.exitCode)}`);
    }
    await Bun.sleep(10);
  }
  throw new Error(`未收到挂载状态：${path.basename(file)}`);
}


/**
 * 照正常入口起一个 Main.ts 独立进程：在项目 cache 下建临时运行时目录，写好外部插件和 config.yaml，再交给 check 断言。
 * @param prefix 临时目录名的前缀。
 * @param plugins 外部插件：文件夹名 → index.js 的源码；照写的先后挂。
 * @param timeoutMs 单个插件挂载的等待上限（plugin_mount_timeout_ms）。
 * @param check 断言；拿到运行时目录和子进程。
 * @returns 子进程的标准错误，给调用方查日志。
 * 副作用：断言失败时连同标准错误一起抛出；最后关掉子进程、删掉临时目录。
 */
async function runMain(
  prefix: string,
  plugins: Record<string, string>,
  timeoutMs: number,
  check: (runtime: string, child: { readonly exitCode: number | null }) => Promise<void>,
): Promise<string> {
  const project = fs.realpathSync(path.resolve(import.meta.dir, '../..'));
  const cache = path.join(project, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  if (fs.realpathSync(cache) !== cache) {
    throw new Error('测试缓存必须位于项目下');
  }
  const runtime = fs.mkdtempSync(path.join(cache, prefix));

  try {
    //M 每个外部插件一个文件夹、一个 index.js；config.yaml 照同样的先后挂它们。
    utils.eachEntry(plugins, (name, code) => {
      const dir = path.join(runtime, name);
      fs.mkdirSync(dir);
      const file = path.join(dir, 'index.js');
      fs.writeFileSync(file, code);
    });
    const names = Object.keys(plugins);
    const config = {
      default_model: 'fake/fake',
      providers: { fake: { base_url: 'http://127.0.0.1:9' } },
      plugin_mount_timeout_ms: timeoutMs,
      plugins: names.map((name) => ({ name })),
    };
    const configFile = path.join(runtime, 'config.yaml');
    const contents = JSON.stringify(config);
    fs.writeFileSync(configFile, contents);

    //M 通过正常入口启动，关闭测试进程时收齐标准错误。
    const main = path.join(project, 'src7', 'Main.ts');
    const cmd = [process.execPath, main, '--data', runtime];
    const child = Bun.spawn({ cmd, stdout: 'ignore', stderr: 'pipe' });
    const stderr = new Response(child.stderr).text();
    let failure: { cause: unknown } | undefined;
    try {
      await check(runtime, child);
    } catch (error) {
      //G 保留原断言和启动日志，区分启动慢与入口异常退出。
      failure = { cause: error };
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
      await child.exited;
    }

    const logs = await stderr;
    if (failure !== undefined) {
      const message = textModule.getErrorMessage(failure.cause);
      throw new Error(`${message}\n${logs}`, failure);
    }
    return logs;
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}


test('插件挂载超时后继续挂后面的插件并发 ready，慢插件起好后更新原状态', async () => {
  const slow = 'slow-fixture';
  const next = 'next-fixture';

  //M 慢插件一直等测试释放，再提供服务。后面的插件记录 ready 和服务可用时的状态。
  const slowCode = `
    import * as fs from 'node:fs';
    export async function apply(ctx) {
      const release = new URL('../release', import.meta.url);
      while (!fs.existsSync(release)) {
        await Bun.sleep(10);
      }
      ctx.provide('mount-test-ready', true);
    }
  `;
  const nextCode = `
    import * as fs from 'node:fs';
    export const inject = ['resources'];
    export function apply(ctx) {
      const save = (name) => {
        const temp = new URL('../' + name + '.tmp', import.meta.url);
        const dest = new URL('../' + name + '.json', import.meta.url);
        const status = JSON.stringify(ctx.resources.pluginStatus);
        fs.writeFileSync(temp, status);
        fs.renameSync(temp, dest);
      };
      ctx.on('ready', () => save('ready'));
      ctx.inject(['mount-test-ready'], () => save('settled'));
    }
  `;
  const plugins = { [slow]: slowCode, [next]: nextCode };

  const logs = await runMain('mount-timeout-', plugins, 60, async (runtime, child) => {
    const readyFile = path.join(runtime, 'ready.json');
    const ready = await readMountStatuses(readyFile, child);
    expect(ready).toHaveLength(2);
    expect(ready[0]).toMatchObject({ name: slow, state: 'mounting' });
    expect(ready[0]?.error).toContain('启动超过 0.06 秒');
    expect(ready[1]).toMatchObject({ name: next, state: 'ok', error: '' });

    //M 还在起的算没挂上，health 的 problems 里照样有它。
    const readyProblems = httpModule.getPluginProblems(ready);
    expect(readyProblems).toEqual([`插件 ${slow} 没挂上：${String(ready[0]?.error)}`]);

    //M ready 已发后才放行，证明慢插件没有被卸载，也没有阻塞后续。
    const release = path.join(runtime, 'release');
    fs.writeFileSync(release, '');
    const settledFile = path.join(runtime, 'settled.json');
    const settled = await readMountStatuses(settledFile, child);
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({ name: slow, state: 'ok', error: '' });
    expect(settled[1]).toEqual(ready[1]);

    //M 全挂上了，health 的 problems 为空。
    const settledProblems = httpModule.getPluginProblems(settled);
    expect(settledProblems).toEqual([]);
  });
  expect(logs).toContain('插件 slow-fixture 启动超过 0.06 秒，先挂后面的，它继续在后台起');
}, 35_000);


test('插件 apply 抛错：Cordis 发 FAILED，Main 记成 failed；等服务的插件服务来了才抛错也记得到', async () => {
  const probe = 'probe-fixture';
  const boom = 'boom-fixture';
  const late = 'late-fixture';

  //M 探针最先挂：每见一次 internal/status 带 FAILED（3），等 Main 记完再存一份挂载状态；ready 时存一份，再提供 late 等的服务。
  const probeCode = `
    import * as fs from 'node:fs';
    export const inject = ['resources'];
    export function apply(ctx) {
      const save = (name) => {
        const temp = new URL('../' + name + '.tmp', import.meta.url);
        const dest = new URL('../' + name + '.json', import.meta.url);
        const status = JSON.stringify(ctx.resources.pluginStatus);
        fs.writeFileSync(temp, status);
        fs.renameSync(temp, dest);
      };
      let failures = 0;
      ctx.on('internal/status', (fiber) => {
        if (fiber.state !== 3) return;
        failures += 1;
        const name = 'failed-' + failures;
        setTimeout(() => save(name), 0);
      });
      ctx.on('ready', () => {
        save('ready');
        ctx.provide('late-service', true);
      });
    }
  `;
  //M boom 一挂就抛错。late 等 late-service，服务来了 apply 才抛错：这时挂载循环那次等待早已返回，只有状态监听能记到。
  const boomCode = `export function apply() { throw new Error('开机就抛错'); }`;
  const lateCode = `
    export const inject = ['late-service'];
    export function apply() { throw new Error('服务来了才抛错'); }
  `;
  const plugins = { [probe]: probeCode, [boom]: boomCode, [late]: lateCode };

  const logs = await runMain('mount-failed-', plugins, 5000, async (runtime, child) => {
    //M ready 时：boom 已记成失败，late 在等服务。
    const readyFile = path.join(runtime, 'ready.json');
    const ready = await readMountStatuses(readyFile, child);
    expect(ready).toEqual([
      { name: probe, state: 'ok', error: '', inject: ['resources'] },
      { name: boom, state: 'failed', error: '开机就抛错', inject: [] },
      { name: late, state: 'waiting', error: '它要用的 late-service 没人提供', inject: ['late-service'] },
    ]);
    const readyProblems = httpModule.getPluginProblems(ready);
    expect(readyProblems).toEqual([
      `插件 ${boom} 没挂上：开机就抛错`,
      `插件 ${late} 没开工：它要用的 late-service 没人提供`,
    ]);

    //M 探针见到第二次 FAILED：Cordis 给 late 发了；Main 的状态监听把它记成 failed，health 照样报它。
    const failedFile = path.join(runtime, 'failed-2.json');
    const failed = await readMountStatuses(failedFile, child);
    expect(failed[2]).toEqual({ name: late, state: 'failed', error: '服务来了才抛错', inject: ['late-service'] });
    const failedProblems = httpModule.getPluginProblems(failed);
    expect(failedProblems).toEqual([
      `插件 ${boom} 没挂上：开机就抛错`,
      `插件 ${late} 没挂上：服务来了才抛错`,
    ]);
  });
  expect(logs).toContain(`插件 ${late} 没挂上：服务来了才抛错`);
}, 35_000);
