/**
 * 换版本（scripts/Swap_Serve.ts）和更新监视（src/capabilities/UpdateWatch.ts）的离线测试。
 * A) Swap_Serve 的基地保护：只起假 HTTP 接口、用临时 JMBOTS_RUNTIME，绝不对 30086 或真实服务跑；
 *    基地守护（managed:true 且有 current）时拒绝（退出码 1、输出“不能用 Swap_Serve 换”），连不上、managed:false、--force yes 不拒绝。
 * B) UpdateWatch.checkUpdate：假基地接口（/update、/update/apply）加假 deps（临时运行时、内存数据库、假渠道）；
 *    覆盖同一版本只发一张卡片、放行后调 apply、拒绝后记下不再问、旧卡作废、换完/没换成报结果、apply 失败清记录、基地连不上不做事。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as serveProcess from '../scripts/Serve_Process.ts';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import type * as model from '../src/capabilities/Model.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as versions from '../src/Versions.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 单个测试的超时，毫秒：A 要起子进程，B 要等异步回调。 */
const TEST_TIMEOUT_MS = 60_000;

/** 测试里起的假接口，每个测试结束统一关掉。 */
const servers: { stop(force?: boolean): void | Promise<void> }[] = [];


bunTest.afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop(true);
  }
});


/**
 * 在 15000 以上找一个能监听的空闲端口（按项目习惯避开带 4 的）。
 * @returns 端口。
 */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    /** 候选端口。 */
    const port = 15_000 + Math.floor(Math.random() * 50_000);
    if (String(port).includes('4')) {
      continue;
    }
    try {
      /** 试一下能不能监听。 */
      const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') });
      await probe.stop(true);
      return port;
    } catch {
      //G 被别的程序占了：换一个。
    }
  }
  throw new Error('找不到空闲端口');
}


/** 临时运行时的锁文件状态。 */
type LockKind = 'none' | 'file' | 'dir';


/**
 * 建临时运行时目录：写最小 config.yaml，按需要放一个有效或坏掉的 swap.lock。
 * @param lock none 不放；file 放一个刚写的锁（提前返回用）；dir 把锁路径做成目录（提前失败用）。
 * @returns 运行时目录。
 */
function makeSwapRuntime(lock: LockKind = 'none'): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-swap-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\nbots:\n  - name: 小测\n    language: zh\n');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  /** 锁文件。 */
  const lockFile = path.join(dir, 'data', 'swap.lock');
  if (lock === 'file') {
    fs.writeFileSync(lockFile, String(Date.now()));
  }
  if (lock === 'dir') {
    fs.mkdirSync(lockFile);
  }
  return dir;
}


/**
 * 跑一次 Swap_Serve 子进程（限时）。
 * @param args 命令行参数。
 * @param runtimeDir 临时运行时目录。
 * @returns 退出码和 stdout+stderr。
 */
async function runSwap(args: string[], runtimeDir: string): Promise<{ code: number; output: string }> {
  /** 子进程。 */
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(serveProcess.ROOT, 'scripts', 'Swap_Serve.ts'), ...args],
    cwd: serveProcess.ROOT,
    env: { ...process.env, JMBOTS_RUNTIME: runtimeDir, JMBOTS_SESSION_ID: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  /** 输出（先开始读，免得管道满了卡住）。 */
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  /** 有没有超时。 */
  let timedOut = false;
  /** 计时器。 */
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 30_000);
  /** 退出码。 */
  const code = await child.exited;
  clearTimeout(timer);
  /** 拼起来的输出。 */
  const output = `${await stdout}${await stderr}`;
  if (timedOut) {
    throw new Error(`Swap_Serve 子进程超时：${output}`);
  }
  return { code, output };
}


/** 假基地的 /api/update。 */
interface ManagedApi {
  /** 端口。 */
  port: number;
  /** 被问了几次。 */
  hits: () => number;
}


/**
 * 起一个假基地，回 /api/update 的 managed 状态。
 * @param managed 是不是基地守护的二进制。
 * @returns 端口和访问计数。
 */
async function startManagedApi(managed: boolean): Promise<ManagedApi> {
  /** 端口。 */
  const port = await freePort();
  /** 问了几次。 */
  let count = 0;
  /** 假接口。 */
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: () => {
      count += 1;
      return Response.json({ managed, current: managed ? { version: '0.2.0' } : null });
    },
  });
  servers.push(server);
  return { port, hits: () => count };
}


bunTest.describe('Swap_Serve 基地保护', () => {
  bunTest.test(
    '基地守护（managed:true 且有 current）时拒绝',
    async () => {
      /** 假基地。 */
      const api = await startManagedApi(true);
      /** 临时运行时。 */
      const runtime = makeSwapRuntime();
      /** 试运行端口（不会用到，防意外）。 */
      const candidatePort = await freePort();
      /** 子进程结果。 */
      const result = await runSwap(['--port', String(api.port), '--candidate_port', String(candidatePort), '--skip_checks', 'yes'], runtime);
      bunTest.expect(result.output).toContain('不能用 Swap_Serve 换');
      bunTest.expect(result.code).toBe(1);
      bunTest.expect(api.hits()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '连不上基地时不拒绝，走锁提前返回',
    async () => {
      /** 没有服务的端口。 */
      const deadPort = await freePort();
      /** 临时运行时：刚写的锁让它提前返回。 */
      const runtime = makeSwapRuntime('file');
      /** 试运行端口（不会用到，防意外）。 */
      const candidatePort = await freePort();
      /** 子进程结果。 */
      const result = await runSwap(['--port', String(deadPort), '--candidate_port', String(candidatePort), '--skip_checks', 'yes'], runtime);
      bunTest.expect(result.output).not.toContain('不能用 Swap_Serve 换');
      bunTest.expect(result.output).toContain('已经有人开始换版本');
      bunTest.expect(result.code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    'managed:false 时不拒绝，走锁提前返回',
    async () => {
      /** 假基地：不是基地守护的。 */
      const api = await startManagedApi(false);
      /** 临时运行时：刚写的锁让它提前返回。 */
      const runtime = makeSwapRuntime('file');
      /** 试运行端口（不会用到，防意外）。 */
      const candidatePort = await freePort();
      /** 子进程结果。 */
      const result = await runSwap(['--port', String(api.port), '--candidate_port', String(candidatePort), '--skip_checks', 'yes'], runtime);
      bunTest.expect(result.output).not.toContain('不能用 Swap_Serve 换');
      bunTest.expect(result.output).toContain('已经有人开始换版本');
      bunTest.expect(result.code).toBe(0);
      bunTest.expect(api.hits()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '--force yes 时 managed:true 也不拒绝',
    async () => {
      /** 假基地：managed:true，不加 --force 就会被拒绝。 */
      const api = await startManagedApi(true);
      /** 临时运行时：把锁路径做成目录，让它写完锁之前就出错，绝不进后台换版本。 */
      const runtime = makeSwapRuntime('dir');
      /** 试运行端口（不会用到，防意外）。 */
      const candidatePort = await freePort();
      /** 子进程结果。 */
      const result = await runSwap(['--force', 'yes', '--port', String(api.port), '--candidate_port', String(candidatePort)], runtime);
      bunTest.expect(result.output).not.toContain('不能用 Swap_Serve 换');
      bunTest.expect(result.output).not.toContain('已在后台开始换版本');
      bunTest.expect(result.code).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});


/** 基地 /update 回的状态。 */
interface FakeUpdateStatus {
  /** 正在跑的版本。 */
  current: { version: string } | null;
  /** 能换的新版本。 */
  available: { version: string; changes: { version: string; changes: string[] }[] } | null;
  /** 正在换吗。 */
  applying: boolean;
  /** 上一次换的结果。 */
  message: string;
}


/** 假基地收到的一次请求。 */
interface FakeRequest {
  /** 方法。 */
  method: string;
  /** 路径。 */
  path: string;
  /** 请求体。 */
  body: string;
}


/** 假基地。 */
interface FakeBase {
  /** 地址。 */
  url: string;
  /** /update 回的状态，测试里可以改。 */
  status: FakeUpdateStatus;
  /** /update/apply 回的成功或失败。 */
  apply: { ok: boolean; body: string };
  /** 收到的请求。 */
  requests: FakeRequest[];
}


/**
 * 起一个假基地：/update 回状态，/update/apply 回成功或错误，并记录每次请求。
 * @param status 初始状态。
 * @returns 假基地。
 */
async function startFakeBase(status: FakeUpdateStatus): Promise<FakeBase> {
  /** 端口。 */
  const port = await freePort();
  /** 假基地。 */
  const fake: FakeBase = { url: `http://127.0.0.1:${port}`, status, apply: { ok: true, body: '{}' }, requests: [] };
  /** 假接口。 */
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: async (request) => {
      /** 请求地址。 */
      const url = new URL(request.url);
      fake.requests.push({ method: request.method, path: url.pathname, body: request.method === 'POST' ? await request.text() : '' });
      if (url.pathname === '/update') {
        return Response.json(fake.status);
      }
      if (url.pathname === '/update/apply' && request.method === 'POST') {
        return new Response(fake.apply.body, { status: fake.apply.ok ? 200 : 500 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return fake;
}


/** 发出去的一条话。 */
interface Sent {
  /** 渠道。 */
  channel: string;
  /** 回复地址。 */
  address: Record<string, unknown>;
  /** 文字。 */
  text: string;
}


/** UpdateWatch 测试用的一套东西。 */
interface WatchHarness {
  /** 依赖。 */
  deps: builders.TestDeps;
  /** 发出去的话。 */
  sent: Sent[];
  /** 发出去的卡片。 */
  cards: approvalsModule.PendingApproval[];
  /** 运行时目录。 */
  dir: string;
}


/**
 * 建 UpdateWatch 的假 deps：临时运行时（engine.index_url 指向假基地）、内存数据库、假渠道。
 * @param baseUrl 假基地地址。
 * @returns 依赖和记录。
 */
async function setupWatch(baseUrl: string): Promise<WatchHarness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-watch-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), `providers: {}\nbots:\n  - name: 小测\n    language: zh\nengine:\n  index_url: ${baseUrl}\n`);
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot('小测');
  /** 发出去的话。 */
  const sent: Sent[] = [];
  /** 发出去的卡片。 */
  const cards: approvalsModule.PendingApproval[] = [];
  /** 假渠道：记录发话和发卡片。 */
  const out: depsModule.Outlet = {
    send: (channel, address, text) => {
      sent.push({ channel, address, text });
      return Promise.resolve();
    },
    sendApproval: (_channel, _address, pending) => {
      cards.push(pending);
      return Promise.resolve(['http']);
    },
    publishDoc: () => Promise.reject(new Error('测试里不发文档')),
    deleteDoc: () => Promise.reject(new Error('测试里不删文档')),
  };
  /** 依赖；更新监视不调模型，ai 给个空壳。 */
  const deps: builders.TestDeps = {
    resources,
    store: new storeModule.Store(':memory:'),
    files,
    ai: {} as unknown as model.Ai,
    secrets: new secretsModule.Secrets([]),
    approvals: new approvalsModule.Approvals(),
    out,
  };
  return { deps, sent, cards, dir };
}


/**
 * 写 data/update_watch.json。
 * @param dir 运行时目录。
 * @param saved 要记的。
 */
function writeWatchState(dir: string, saved: { declined?: string; swapping?: { version: string; channels: string[] } }): void {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'update_watch.json'), JSON.stringify(saved), 'utf8');
}


/**
 * 读 data/update_watch.json。
 * @param dir 运行时目录。
 * @returns 记着的；没有或坏了是 undefined。
 */
function readWatchState(dir: string): { declined?: string; swapping?: { version: string; channels: string[] } } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'update_watch.json'), 'utf8')) as { declined?: string; swapping?: { version: string; channels: string[] } };
  } catch {
    return undefined;
  }
}


/**
 * 等到条件成立（最多 10 秒）；等不到就报错。
 * @param condition 条件。
 * @param what 在等什么。
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 1000; index += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`等不到${what}`);
}


/** 一个普通的“有新版本”状态。 */
function statusWith(version: string, currentVersion = '0.1.0'): FakeUpdateStatus {
  return {
    current: { version: currentVersion },
    available: { version, changes: [{ version, changes: [`${version} 的改动`] }] },
    applying: false,
    message: '',
  };
}


bunTest.describe('UpdateWatch.checkUpdate', () => {
  bunTest.test(
    '同一版本只发一张卡片',
    async () => {
      /** 假基地。 */
      const base = await startFakeBase(statusWith('0.2.0'));
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      /** 这个进程记着的。 */
      const watch = builders.updateWatchOf(harness.deps);
      await watch.check();
      await watch.check();
      bunTest.expect(harness.deps.approvals.list().length).toBe(1);
      bunTest.expect(harness.cards.length).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '放行后调 /update/apply',
    async () => {
      /** 假基地。 */
      const base = await startFakeBase(statusWith('0.2.0'));
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      /** 这个进程记着的。 */
      const watch = builders.updateWatchOf(harness.deps);
      await watch.check();
      /** 卡片。 */
      const card = harness.deps.approvals.list()[0]!;
      harness.deps.approvals.decide(card.id, true, '测试');
      await until(() => watch.applied === true, '基地完成 apply');
      bunTest.expect(base.requests.some((item) => item.method === 'POST' && item.path === '/update/apply')).toBe(true);
      bunTest.expect(readWatchState(harness.dir)?.swapping).toEqual({ version: '0.2.0', channels: ['http'] });
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '拒绝后写 update_watch.json，新 memo 不再问',
    async () => {
      /** 假基地。 */
      const base = await startFakeBase(statusWith('0.2.0'));
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      /** 这个进程记着的。 */
      const watch = builders.updateWatchOf(harness.deps);
      await watch.check();
      /** 卡片。 */
      const card = harness.deps.approvals.list()[0]!;
      harness.deps.approvals.decide(card.id, false, '测试');
      await until(() => readWatchState(harness.dir)?.declined === '0.2.0', '记下拒绝的版本');
      /** 重启以后新进程的监视。 */
      const nextWatch = builders.updateWatchOf(harness.deps);
      await nextWatch.check();
      bunTest.expect(harness.cards.length).toBe(1);
      bunTest.expect(harness.deps.approvals.list().length).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '来了更新的版本：旧卡作废、不算拒绝、发新卡',
    async () => {
      /** 假基地。 */
      const base = await startFakeBase(statusWith('0.2.0'));
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      /** 这个进程记着的。 */
      const watch = builders.updateWatchOf(harness.deps);
      await watch.check();
      /** 旧卡片。 */
      const oldCard = harness.deps.approvals.list()[0]!;
      base.status = statusWith('0.3.0');
      await watch.check();
      /** 现在还在等的卡片。 */
      const pending = harness.deps.approvals.list();
      bunTest.expect(pending.length).toBe(1);
      bunTest.expect(pending[0]!.id).not.toBe(oldCard.id);
      bunTest.expect(pending[0]!.title).toBe('有新版本 0.3.0');
      bunTest.expect(harness.cards.length).toBe(2);
      //M 旧卡的拒绝是“有更新的版本了”，不能记成用户拒绝。
      await Bun.sleep(20);
      bunTest.expect(readWatchState(harness.dir)?.declined).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '换完在新进程里报“已更新到”（看程序自己的版本）',
    async () => {
      /** 程序自己的版本号：报结果的就是正在跑的这个进程。 */
      const own = versions.VERSIONS[0]!.version;
      /** 假基地：已经是新版本。 */
      const base = await startFakeBase({ current: { version: own }, available: null, applying: false, message: '' });
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      writeWatchState(harness.dir, { swapping: { version: own, channels: ['飞书'] } });
      await builders.updateWatchOf(harness.deps).check();
      bunTest.expect(harness.sent.map((item) => item.text)).toEqual([`已更新到 ${own}。`]);
      bunTest.expect(readWatchState(harness.dir)?.swapping).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '基地 current 还没刷新、自己已是新版本：仍报“已更新到”（11-06 飞书误报）',
    async () => {
      /** 程序自己的版本号。 */
      const own = versions.VERSIONS[0]!.version;
      /** 假基地：30 秒才扫一次，手里还是旧版本号，message 已经说换好了。 */
      const base = await startFakeBase({ current: { version: '0.1.0' }, available: null, applying: false, message: '换好了' });
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      writeWatchState(harness.dir, { swapping: { version: own, channels: ['http'] } });
      await builders.updateWatchOf(harness.deps).check();
      bunTest.expect(harness.sent.map((item) => item.text)).toEqual([`已更新到 ${own}。`]);
      bunTest.expect(readWatchState(harness.dir)?.swapping).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '版本没变报“没更新到”和基地 message',
    async () => {
      /** 假基地：版本没变，基地说了原因。 */
      const base = await startFakeBase({ current: { version: '0.1.0' }, available: null, applying: false, message: '安装包损坏' });
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      writeWatchState(harness.dir, { swapping: { version: '0.2.0', channels: ['http'] } });
      await builders.updateWatchOf(harness.deps).check();
      bunTest.expect(harness.sent.map((item) => item.text)).toEqual(['没更新到 0.2.0：安装包损坏']);
      bunTest.expect(readWatchState(harness.dir)?.swapping).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    'apply 回错误时发话并清掉记录',
    async () => {
      /** 假基地：apply 回错误。 */
      const base = await startFakeBase(statusWith('0.2.0'));
      base.apply = { ok: false, body: '基地拒绝这次更新' };
      /** 依赖。 */
      const harness = await setupWatch(base.url);
      /** 这个进程记着的。 */
      const watch = builders.updateWatchOf(harness.deps);
      await watch.check();
      /** 卡片。 */
      const card = harness.deps.approvals.list()[0]!;
      harness.deps.approvals.decide(card.id, true, '测试');
      await until(() => harness.sent.length > 0, '发失败提示');
      bunTest.expect(harness.sent[0]!.text).toContain('没开始更新到 0.2.0');
      bunTest.expect(harness.sent[0]!.text).toContain('基地拒绝这次更新');
      bunTest.expect(readWatchState(harness.dir)?.swapping).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '基地连不上什么也不做',
    async () => {
      /** 没有服务的端口。 */
      const deadPort = await freePort();
      /** 依赖。 */
      const harness = await setupWatch(`http://127.0.0.1:${deadPort}`);
      await builders.updateWatchOf(harness.deps).check();
      bunTest.expect(harness.deps.approvals.list().length).toBe(0);
      bunTest.expect(harness.cards.length).toBe(0);
      bunTest.expect(harness.sent.length).toBe(0);
      bunTest.expect(fs.existsSync(path.join(harness.dir, 'data', 'update_watch.json'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
