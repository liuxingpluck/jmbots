/**
 * 记忆库索引跟着文件走（src/capabilities/Context.ts 的 folderStamp、IndexRefresher）的离线测试
 * （docs/界面/任务书/发0.3.1_DSH.md 第 1 步）：
 * 文件增删改让指纹变化，依赖和隐藏目录不算；IndexRefresher 第一轮刷全部，改了哪个库只刷哪个，
 * gapMs 之内不马上刷，root 没记着或文件太多不扫，没配不发请求，停下以后不再发。
 * 全部用本机假基地和临时目录，不读真实配置。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as contextModule from '../src/capabilities/Context.ts';
import type * as resourcesModule from '../src/resources/Resources.ts';


/** 假基地收到的一次请求。 */
interface Recorded {
  /** 方法。 */
  method: string;
  /** 路径。 */
  path: string;
  /** 请求体。 */
  body?: unknown;
}


/** 假基地。 */
interface FakeBase {
  /** Bun 服务。 */
  server: ReturnType<typeof Bun.serve>;
  /** 地址。 */
  url: string;
  /** 请求记录。 */
  requests: Recorded[];
}


/**
 * 起一个假基地。
 * @param handler 处理函数。
 */
function startFakeBase(handler: (request: Request, url: URL, body: unknown) => Response | Promise<Response>): FakeBase {
  /** 请求记录。 */
  const requests: Recorded[] = [];
  /** 服务。 */
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      /** 地址。 */
      const url = new URL(request.url);
      /** 请求体。 */
      const body = request.method === 'POST' ? ((await request.json().catch(() => undefined)) as unknown) : undefined;
      requests.push({ method: request.method, path: url.pathname, body });
      return handler(request, url, body);
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, requests };
}


/**
 * 假资源：只实现 getSetting，够 IndexRefresher 用。
 * @param indexUrl 基地地址。
 * @param memoryLibs 库名。
 */
function resourcesOf(indexUrl?: string, memoryLibs?: string): resourcesModule.Resources {
  /**
   * 一项设置。
   * @param name 设置名。
   */
  const getSetting = (name: string): string | undefined => {
    if (name === 'indexUrl') {
      return indexUrl;
    }
    if (name === 'memoryLibs') {
      return memoryLibs;
    }
    return undefined;
  };
  return { getSetting } as unknown as resourcesModule.Resources;
}


/**
 * 等到条件成立（最多 3 秒）。
 * @param condition 条件。
 * @param what 等什么。
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`等不到：${what}`);
}


/**
 * 给一个库的假基地写好 /health、/ingest、/rag/index 的处理，并记录请求。
 * @param roots 库名 → 根目录和文件数。
 */
function startLibBase(roots: Record<string, { root?: string; files: number }>): FakeBase {
  return startFakeBase((request, url) => {
    if (url.pathname === '/health') {
      return Response.json({ libs: Object.entries(roots).map(([name, item]) => ({ name, root: item.root, totals: { files: item.files } })) });
    }
    if (url.pathname === '/ingest' && request.method === 'POST') {
      return Response.json({ ok: true });
    }
    if (url.pathname === '/ingest') {
      return Response.json({ job: { running: false } });
    }
    return Response.json({ ok: true });
  });
}


bunTest.describe('folderStamp', () => {
  bunTest.test('不变时一样；改内容、加文件、删文件都变；.git/node_modules 不算；maxFiles 和不存在是 undefined', async () => {
    /** 临时根。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-stamp-'));
    try {
      await fs.writeFile(path.join(root, 'a.md'), '一行');
      await fs.writeFile(path.join(root, 'b.md'), '两行');
      await fs.mkdir(path.join(root, '.git'), { recursive: true });
      await fs.writeFile(path.join(root, '.git', 'x'), 'git 内容');
      await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
      await fs.writeFile(path.join(root, 'node_modules', 'x', 'y'), '依赖内容');
      /** 第一次。 */
      const first = await contextModule.folderStamp(root);
      bunTest.expect(first).toBeDefined();
      bunTest.expect(await contextModule.folderStamp(root)).toBe(first);
      //M 改内容。
      await fs.writeFile(path.join(root, 'a.md'), '改过的内容更长');
      /** 改内容后。 */
      const changed = await contextModule.folderStamp(root);
      bunTest.expect(changed).not.toBe(first);
      //M 加文件。
      await fs.writeFile(path.join(root, 'c.md'), '新文件');
      /** 加文件后。 */
      const added = await contextModule.folderStamp(root);
      bunTest.expect(added).not.toBe(changed);
      //M 删文件。
      await fs.rm(path.join(root, 'c.md'));
      bunTest.expect(await contextModule.folderStamp(root)).not.toBe(added);
      //M .git 和 node_modules 里改了不影响（先记一份当前指纹）。
      /** 当前指纹。 */
      const beforeIgnored = await contextModule.folderStamp(root);
      await fs.writeFile(path.join(root, '.git', 'x'), 'git 改过，很长');
      await fs.writeFile(path.join(root, 'node_modules', 'x', 'y'), '依赖改过，很长');
      bunTest.expect(await contextModule.folderStamp(root)).toBe(beforeIgnored);
      //M maxFiles：2 个文件、上限 1 是 undefined；文件夹不存在也是 undefined。
      bunTest.expect(await contextModule.folderStamp(root, 1)).toBeUndefined();
      bunTest.expect(await contextModule.folderStamp(path.join(root, '不存在'))).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});


bunTest.describe('IndexRefresher', () => {
  bunTest.test('第一轮两个库都刷；改甲库只刷甲；gapMs 内再改不马上刷', async () => {
    /** 甲库根。 */
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-refresh-a-'));
    /** 乙库根。 */
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-refresh-b-'));
    /** 假基地。 */
    const fake = startLibBase({ 甲: { root: rootA, files: 2 }, 乙: { root: rootB, files: 2 } });
    /** 定时刷新。 */
    let refresher: contextModule.IndexRefresher | undefined;
    try {
      await fs.writeFile(path.join(rootA, 'a.md'), '甲先写一份');
      await fs.writeFile(path.join(rootA, 'b.md'), '甲再写一份');
      await fs.writeFile(path.join(rootB, 'a.md'), '乙写一份');
      await fs.writeFile(path.join(rootB, 'b.md'), '乙再写一份');
      refresher = new contextModule.IndexRefresher(resourcesOf(fake.url, '甲,乙'), { firstMs: 10, refreshMs: 60_000, scanMs: 100, gapMs: 300, pollMs: 10 });
      refresher.start();
      /** 第一轮：两个库各一次 /ingest 和 /rag/index。 */
      await until(() => fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').length >= 2 && fake.requests.filter((item) => item.path === '/rag/index').length >= 2, '第一轮两个库都刷');
      /** 第一轮的请求体。 */
      const firstBodies = fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').map((item) => item.body);
      bunTest.expect(firstBodies).toEqual([{ lib: '甲', ai: false }, { lib: '乙', ai: false }]);
      //M 改甲库一个文件：过一会儿只刷甲。
      await fs.writeFile(path.join(rootA, 'a.md'), '甲改过了，内容变长很多很多很多');
      await until(() => fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST' && (item.body as { lib?: string }).lib === '甲').length >= 2, '甲库单独刷新');
      //M 乙库没有多刷。
      bunTest.expect(fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST' && (item.body as { lib?: string }).lib === '乙')).toHaveLength(1);
      //M gapMs 之内再改不马上刷。
      /** 改之前的刷新次数。 */
      const before = fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').length;
      await fs.writeFile(path.join(rootA, 'a.md'), '甲又改了一点点内容');
      await Bun.sleep(120);
      bunTest.expect(fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').length).toBe(before);
    } finally {
      refresher?.stop();
      await fake.server.stop(true);
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  bunTest.test('root 是 null 或 files 超过 10000 的库不扫', async () => {
    /** 根。 */
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-refresh-c-'));
    /** 根。 */
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-refresh-d-'));
    /** 假基地：甲没根，乙文件太多。 */
    const fake = startLibBase({ 甲: { root: undefined, files: 2 }, 乙: { root: rootB, files: 10_001 } });
    /** 定时刷新。 */
    let refresher: contextModule.IndexRefresher | undefined;
    try {
      await fs.writeFile(path.join(rootA, 'a.md'), '甲');
      await fs.writeFile(path.join(rootB, 'a.md'), '乙');
      refresher = new contextModule.IndexRefresher(resourcesOf(fake.url, '甲,乙'), { firstMs: 10, refreshMs: 60_000, scanMs: 100, gapMs: 300, pollMs: 10 });
      refresher.start();
      await until(() => fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').length >= 2, '第一轮两个库都刷');
      /** 第一轮后。 */
      const before = fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').length;
      await fs.writeFile(path.join(rootA, 'a.md'), '甲改');
      await fs.writeFile(path.join(rootB, 'a.md'), '乙改');
      await Bun.sleep(500);
      bunTest.expect(fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').length).toBe(before);
    } finally {
      refresher?.stop();
      await fake.server.stop(true);
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  bunTest.test('没配 indexUrl 或 memoryLibs：一个请求也不发', async () => {
    /** 假基地。 */
    const fake = startLibBase({ 甲: { root: undefined, files: 1 } });
    /** 定时刷新。 */
    let refresher: contextModule.IndexRefresher | undefined;
    try {
      refresher = new contextModule.IndexRefresher(resourcesOf(undefined, undefined), { firstMs: 10, refreshMs: 60_000, scanMs: 100, gapMs: 300, pollMs: 10 });
      refresher.start();
      await Bun.sleep(200);
      bunTest.expect(fake.requests).toHaveLength(0);
    } finally {
      refresher?.stop();
      await fake.server.stop(true);
    }
  });

  bunTest.test('调了停下的函数以后不再发请求', async () => {
    /** 根。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-refresh-e-'));
    /** 假基地。 */
    const fake = startLibBase({ 甲: { root, files: 1 } });
    /** 定时刷新。 */
    let refresher: contextModule.IndexRefresher | undefined;
    try {
      await fs.writeFile(path.join(root, 'a.md'), '先写一份');
      refresher = new contextModule.IndexRefresher(resourcesOf(fake.url, '甲'), { firstMs: 10, refreshMs: 60_000, scanMs: 100, gapMs: 300, pollMs: 10 });
      refresher.start();
      await until(() => fake.requests.filter((item) => item.path === '/ingest' && item.method === 'POST').length >= 1 && fake.requests.filter((item) => item.path === '/rag/index').length >= 1, '第一轮刷新');
      await Bun.sleep(30);
      refresher.stop();
      refresher = undefined;
      /** 停下后的请求数。 */
      const before = fake.requests.length;
      await fs.writeFile(path.join(root, 'a.md'), '停下来以后改的');
      await Bun.sleep(500);
      bunTest.expect(fake.requests.length).toBe(before);
    } finally {
      refresher?.stop();
      await fake.server.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
