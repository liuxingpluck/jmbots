/**
 * 定时更新监听单元测试（原 update-watch/UpdateWatch.test.ts 迁入）：
 * 通过可选基地服务工作，不调用真实模型、基地或更新接口；并验证默认关闭与卸载清定时器。
 * 跑法：bun test ./src7/plugins/base-bridge/UpdateWatch.test.ts
 */
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as bridge from './index.ts';
import type { Base } from './index.ts';
import { mountUpdateWatch, readUpdateWatchSettings } from './UpdateWatch.ts';


test('没挂基地照常启动，后来挂上但断连时静默，恢复后才询问更新', async () => {
  //M 临时目录只用于隔离更新状态；本测试不会批准或安装更新。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-update-watch-'));
  const handlers = new Map<string, () => void>();
  const cleanups: (() => void)[] = [];
  const pending: Record<string, unknown>[] = [];
  let service: Pick<Base, 'getJson' | 'postJson'> | undefined;
  let calls = 0;
  let online = false;
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const ctx = {
    resources: { dir: () => root },
    get: () => service,
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    effect: (start: () => () => void) => cleanups.push(start()),
    emit: () => {},
    bots: { list: () => [{ name: '测试机器人' }] },
    approval: {
      list: () => pending,
      ask: (item: Record<string, unknown>) => {
        const result = { ...item, id: '待确认' };
        pending.push(result);
        return result;
      },
    },
  } as unknown as cordis.Context;

  try {
    //M 先挂 watch，再出现 base，证明没有把缺失的服务固定在启动时。
    mountUpdateWatch(ctx, readUpdateWatchSettings({ first_ms: 0, every_ms: 5 }));
    handlers.get('ready')?.();
    await Bun.sleep(20);
    expect(pending).toEqual([]);
    service = {
      getJson: async () => {
        calls += 1;
        if (!online) throw new Error('基地没响应');

        return { status: 200, body: { managed: true, current: { version: '1' }, available: { version: '2' } } };
      },
      postJson: async () => { throw new Error('本测试不能请求安装更新'); },
    };
    for (let count = 0; calls === 0 && count < 100; count += 1) {
      await Bun.sleep(5);
    }
    expect(calls).toBeGreaterThan(0);
    expect(pending).toEqual([]);
    expect(errors).not.toHaveBeenCalled();

    //M 网络恢复以后继续正常发现新版本，不把断连永久记成已处理。
    online = true;
    for (let count = 0; pending.length === 0 && count < 100; count += 1) {
      await Bun.sleep(5);
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]?.['kind']).toBe('update');
    expect(errors).not.toHaveBeenCalled();
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
    errors.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('notify 与 update_watch 默认关闭；开启 update_watch 后卸载会停掉定时器', async () => {
  expect(readUpdateWatchSettings(undefined).enabled).toBe(false);
  expect(readUpdateWatchSettings(false).enabled).toBe(false);
  expect(readUpdateWatchSettings(true).enabled).toBe(true);
  expect(() => readUpdateWatchSettings({ every_ms: 0 })).toThrow();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-base-watch-dispose-'));
  try {
    let baseCalls = 0;
    const remote = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        baseCalls += 1;
        return Response.json({ managed: false });
      },
    });
    const ctx = new cordis.Context();
    class FakeResources extends cordis.Service {
      readonly raw = { engine: { index_url: `http://127.0.0.1:${String(remote.port)}` } };
      dir(): string { return root; }
      constructor(c: cordis.Context) { super(c, 'resources'); }
    }
    let toolCount = 0;
    class FakeTools extends cordis.Service {
      register(): void { toolCount += 1; }
      constructor(c: cordis.Context) { super(c, 'tools'); }
    }
    class FakeBots extends cordis.Service {
      list(): { name: string }[] { return [{ name: '测试' }]; }
      constructor(c: cordis.Context) { super(c, 'bots'); }
    }
    class FakeApproval extends cordis.Service {
      list(): unknown[] { return []; }
      constructor(c: cordis.Context) { super(c, 'approval'); }
    }
    class FakeSessions extends cordis.Service {
      constructor(c: cordis.Context) { super(c, 'sessions'); }
    }

    await ctx.plugin(FakeResources);
    await ctx.plugin(FakeTools);
    await ctx.plugin(FakeBots);
    await ctx.plugin(FakeApproval);
    await ctx.plugin(FakeSessions);
    //M 默认不写 notify 与 update_watch 时两者都不开。
    await ctx.plugin(bridge, {});
    expect(toolCount).toBe(0);
    await ctx.fiber.dispose();

    //M 显式开启 update_watch 后触发定时扫基地；卸载后停止继续请求。
    const ctx2 = new cordis.Context();
    await ctx2.plugin(FakeResources);
    await ctx2.plugin(FakeBots);
    await ctx2.plugin(FakeApproval);
    await ctx2.plugin(FakeSessions);
    await ctx2.plugin(bridge, { update_watch: { first_ms: 5, every_ms: 15 } });
    ctx2.emit('ready', []);
    for (let i = 0; baseCalls === 0 && i < 60; i += 1) {
      await Bun.sleep(10);
    }
    expect(baseCalls).toBeGreaterThan(0);
    await ctx2.fiber.dispose();
    const afterDispose = baseCalls;
    await Bun.sleep(50);
    expect(baseCalls).toBe(afterDispose);
    void remote.stop(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
