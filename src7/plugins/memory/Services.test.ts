/**
 * memory 插件托管服务（Services.ts）的离线测试：配置默认值、路径转发选哪个服务、端口上已有服务时认不认得出“自己的”、
 * 看守重启子服务后端口不漂。
 * 跑法：bun test src7/plugins/memory/Services.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readServices, Services } from './Services.ts';

describe('memory 托管服务', () => {
  test('不写用默认两个服务，端口按主端口顺延', () => {
    const specs = readServices(undefined);
    expect(specs.map((spec) => spec.name)).toEqual(['memory', 'vgr']);
    const hosted = new Services(os.tmpdir(), 31086, specs);
    expect(hosted.getUrl('memory')).toBe('http://127.0.0.1:31087');
    expect(hosted.getUrl('vgr')).toBe('http://127.0.0.1:31088');
  });

  test('写成 [] 就不托管；只写名字就按默认补全', () => {
    expect(readServices([])).toEqual([]);
    const [vgr] = readServices([{ name: 'vgr', port: 32000 }]);
    expect(vgr?.port).toBe(32000);
    expect(vgr?.path).toBe('/memory/vgr');
    expect(() => readServices([{ name: 'x' }])).toThrow();
  });

  test('转发按最长前缀：/memory/vgr/… 给 vgr，其余 /memory/… 给记忆服务', () => {
    const hosted = new Services(os.tmpdir(), 31086, readServices(undefined));
    expect(hosted.route('/memory/vgr/health')?.item.spec.name).toBe('vgr');
    expect(hosted.route('/memory/vgr/health')?.rest).toBe('/health');
    expect(hosted.route('/memory/search')?.item.spec.name).toBe('memory');
    expect(hosted.route('/memory/v1/health?x=1')?.rest).toBe('/v1/health?x=1');
    expect(hosted.route('/other')).toBeUndefined();
  });

  test('端口上是同名同数据目录的服务就复用（不另起），别的数据目录就顺延端口', async () => {
    const root = path.join(os.tmpdir(), 'jmbots-services-test');
    let runtime = root;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true, service: 'jmbots-memory', runtime }) });
    const port = server.port ?? 0;
    const specs = readServices([{ name: 'memory', port, file: 'nope/not-there' }]);
    const hosted = new Services(root, port - 1, specs);
    await (hosted as unknown as { tick(): Promise<void> }).tick();
    expect(hosted.status()[0]).toMatchObject({ healthy: true, managed: false, port });
    runtime = path.join(os.tmpdir(), '别的目录');
    await (hosted as unknown as { tick(): Promise<void> }).tick();
    expect(hosted.status()[0]).toMatchObject({ healthy: false, port: port + 1 });
    hosted.stop();
    void server.stop(true);
  });

  //M 2026-11-15 00:17 EST Claude：重启时旧进程退得慢，原来 kill 完马上 launch，端口还被旧进程占着就顺延了（22:53 漂到 30089）。
  //M 假子进程：用 bun 跑一个小脚本，占着端口、/health 一直答 503（算“不答”），收到 SIGTERM 后拖 0.8 秒才退。
  test('看守重启后端口不变（旧进程退得慢也等它退完再在原端口起）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-restart-test-'));
    const script = path.join(root, 'fake.ts');
    fs.writeFileSync(script, [
      'const port = Number(process.argv[2]);',
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('busy', { status: 503 }) });",
      "process.on('SIGTERM', () => { setTimeout(() => { void server.stop(true); process.exit(0); }, 800); });",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = probe.port ?? 0;
    void probe.stop(true);
    const specs = readServices([{ name: 'fake', file: process.execPath, args: [script, '{port}'], port, startup_ms: 1, path: '/fake' }]);
    const hosted = new Services(root, port - 1, specs);
    const inner = hosted as unknown as { tick(): Promise<void>; items: { port: number; nextTryAt: number; child?: { pid: number } }[] };
    const item = inner.items[0];
    if (item === undefined) throw new Error('没有服务');
    try {
      await inner.tick();
      const firstPid = item.child?.pid;
      expect(firstPid).toBeNumber();
      //M 等假子进程真的听上端口。
      for (let i = 0; i < 50; i += 1) {
        const up = await fetch(`http://127.0.0.1:${String(port)}/health`).then(() => true, () => false);
        if (up) break;
        await Bun.sleep(100);
      }
      //M 连续不答 /health 到 MISSES_BEFORE_RESTART（5）次就重启；退避时间清零让它同一轮马上重新拉起。
      for (let i = 0; i < 5; i += 1) {
        item.nextTryAt = 0;
        await inner.tick();
      }
      expect(item.child?.pid).toBeNumber();
      expect(item.child?.pid).not.toBe(firstPid);
      expect(item.port).toBe(port);
      expect(hosted.status()[0]).toMatchObject({ port, managed: true });
    } finally {
      hosted.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
