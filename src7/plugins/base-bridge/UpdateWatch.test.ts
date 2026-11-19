/**
 * 定时更新监听单元测试（原 update-watch/UpdateWatch.test.ts 迁入）：
 * 通过可选基地服务工作，不调用真实模型、基地或更新接口；并验证默认关闭与卸载清定时器。
 * 待确认走事件 approval/request（list、ask）：这里挂一个假的听方，不挂真的 approval。
 * 跑法：bun test ./src7/plugins/base-bridge/UpdateWatch.test.ts
 */
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as requestEvents from '../../utils/RequestEvent.ts';
import * as bridge from './index.ts';
import { mountUpdateWatch, readUpdateWatchSettings } from './UpdateWatch.ts';


/** 一件待确认：照 approval/decided 事件的参数取。 */
type Pending = requestEvents.EventArg<'approval/decided'>;

/** 假审核的回执正文。 */
type ApprovalAnswer = requestEvents.StripResultId<requestEvents.EventArg<'approval/result'>>;


test('没挂基地照常启动，后来挂上但断连时静默，恢复后才询问更新', async () => {
  //M 临时目录只用于隔离更新状态；本测试不会批准或安装更新。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-update-watch-'));
  const pending: Pending[] = [];
  let calls = 0;
  let online = false;
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const ctx = new cordis.Context();

  class FakeResources extends cordis.Service {
    dir(): string { return root; }
    constructor(c: cordis.Context) { super(c, 'resources'); }
  }
  class FakeBots extends cordis.Service {
    list(): { name: string }[] { return [{ name: '测试机器人' }]; }
    constructor(c: cordis.Context) { super(c, 'bots'); }
  }
  //M 假基地：后挂上；online 之前一律断连。
  class FakeBase extends cordis.Service {
    async getJson(): Promise<{ status: number; body: unknown }> {
      calls += 1;
      if (!online) throw new Error('基地没响应');

      return { status: 200, body: { managed: true, current: { version: '1' }, available: { version: '2' } } };
    }
    async postJson(): Promise<never> { throw new Error('本测试不能请求安装更新'); }
    constructor(c: cordis.Context) { super(c, 'base'); }
  }

  //M 假审核：list 交回登记过的，ask 登记一条。写明返回类型。
  const answer = (request: requestEvents.EventArg<'approval/request'>): ApprovalAnswer => {
    if (request.action === 'list') return { items: pending };

    if (request.action !== 'ask') return {};

    const item = { ...request.input, id: pending.length + 1, state: 'waiting', askedAt: 0 } as unknown as Pending;
    pending.push(item);
    return { pending: item };
  };

  try {
    await ctx.plugin(FakeResources);
    await ctx.plugin(FakeBots);
    requestEvents.onRequestEvent(ctx, 'approval/request', 'approval/result', answer);

    //M 先挂 watch，再出现 base，证明没有把缺失的服务固定在启动时。
    mountUpdateWatch(ctx, readUpdateWatchSettings({ first_ms: 0, every_ms: 5 }));
    ctx.emit('ready', []);
    await Bun.sleep(20);
    expect(pending).toEqual([]);
    await ctx.plugin(FakeBase);
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
    expect(pending[0]?.kind).toBe('update');
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await ctx.fiber.dispose();
    errors.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('没挂 approval：当没有在等的，新版本登记不上就记一行，下一轮再试', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-update-watch-noapr-'));
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const ctx = new cordis.Context();

  class FakeResources extends cordis.Service {
    dir(): string { return root; }
    constructor(c: cordis.Context) { super(c, 'resources'); }
  }
  class FakeBots extends cordis.Service {
    list(): { name: string }[] { return [{ name: '测试机器人' }]; }
    constructor(c: cordis.Context) { super(c, 'bots'); }
  }
  class FakeBase extends cordis.Service {
    async getJson(): Promise<{ status: number; body: unknown }> {
      return { status: 200, body: { managed: true, current: { version: '1' }, available: { version: '2' } } };
    }
    constructor(c: cordis.Context) { super(c, 'base'); }
  }

  try {
    await ctx.plugin(FakeResources);
    await ctx.plugin(FakeBots);
    await ctx.plugin(FakeBase);
    const watch = new bridge.UpdateWatch(ctx, 60_000);

    //M 直接问一轮：list、ask 都没人答，当场退回，不卡 3 秒、5 秒。
    const began = Date.now();
    await watch.check();
    expect(Date.now() - began).toBeLessThan(1000);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain('没登记上待确认');
  } finally {
    await ctx.fiber.dispose();
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
    const indexUrl = `http://127.0.0.1:${String(remote.port)}`;
    const config = { index_url: indexUrl, update_watch: { first_ms: 5, every_ms: 15 } };
    await ctx2.plugin(bridge, config);
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
