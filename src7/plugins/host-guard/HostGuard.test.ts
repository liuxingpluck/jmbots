/**
 * host-guard 单测：假探针拨读数和时钟，不起真进程。
 * 覆盖默认阈值与配置校验、ok/warn/exceeded 跃迁、冷却防刷屏、连续 2 次回落才解警、显卡读不到降级、
 * 飞书发件箱开关、两条接口 403/200、工具本人可用外人被拒、三种进程清单解析。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type * as cordis from 'cordis';
import * as fastify from 'fastify';
import type { Session } from '../../Sessions.ts';
import { registerHttpErrorHandler } from '../http/index.ts';
import * as hostGuard from './index.ts';
import * as probeModule from './Probe.ts';


const GIB = 1024 ** 3;

/** 测试结束要删的临时目录。 */
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});


/** 工具的 run：只留测试要调的形状。 */
type ToolRun = (args: Record<string, unknown>, session: Session) => Promise<string>;


/**
 * 搭一套假 ctx + 假探针 + 真 Fastify。
 * @param config 插件配置。
 * @param gpu 有没有显卡。
 */
async function setup(config: unknown = undefined, gpu = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-guard-'));
  tempDirs.push(root);

  //M 可拨的读数和时钟；top 记被拉了几次。
  const dial = { ramGb: 30, vramGb: 4, now: 1_000_000, topCalls: 0, verified: true };
  const probes: hostGuard.HostProbes = {
    probeRam: async () => ({ used: dial.ramGb * GIB, total: 64 * GIB }),
    probeVram: async () => {
      if (!gpu) return null;
      return { used: dial.vramGb * GIB, total: 16 * GIB };
    },
    probeTop: async () => {
      dial.topCalls += 1;
      return [{ pid: 42, name: 'big.exe', mb: 9000 }];
    },
    now: () => dial.now,
  };

  //M 假 ctx：记事件、记工具、真 Fastify 挂接口；effect 不起定时器。
  const emitted: hostGuard.HostAlert[] = [];
  const tools = new Map<string, ToolRun>();
  const app = fastify.default({ logger: false });
  registerHttpErrorHandler(app);
  const ctx = {
    resources: { root },
    emit: (_event: string, alert: hostGuard.HostAlert) => emitted.push(alert),
    effect: () => undefined,
    http: { app, isVerified: () => dial.verified },
    tools: {
      register: (tool: { definition: { name: string }; run: ToolRun }) => {
        tools.set(tool.definition.name, tool.run);
      },
    },
  } as unknown as cordis.Context;
  hostGuard.apply(ctx, config, probes);
  await app.ready();

  //M 手动采一次走 POST 接口（本机默认已核验）。
  const check = async (): Promise<hostGuard.HostSnapshot> => {
    const res = await app.inject({ method: 'POST', url: '/api/host-guard/check' });
    return res.json() as hostGuard.HostSnapshot;
  };
  return { root, dial, emitted, tools, app, check };
}


describe('配置', () => {
  test('默认 60GB / 15.5GB，预警 54 / 14，30 秒，冷却 300 秒，不发飞书', () => {
    const config = hostGuard.parseConfig(undefined);
    expect(config).toEqual({
      maxRamGb: 60,
      warnRamGb: 54,
      maxVramGb: 15.5,
      warnVramGb: 14,
      intervalSec: 30,
      cooldownSec: 300,
      notifyFeishu: false,
      nvidiaSmi: 'nvidia-smi',
    });
  });

  test('入口拒绝非法配置', () => {
    expect(() => hostGuard.parseConfig({ interval_sec: 4 })).toThrow('interval_sec');
    expect(() => hostGuard.parseConfig({ interval_sec: 601 })).toThrow('interval_sec');
    expect(() => hostGuard.parseConfig({ max_ram_gb: 50, warn_ram_gb: 50 })).toThrow('warn_ram_gb');
    expect(() => hostGuard.parseConfig({ max_vram_gb: -1 })).toThrow('max_vram_gb');
    expect(() => hostGuard.parseConfig({ notify_feishu: 'yes' })).toThrow('notify_feishu');
    expect(() => hostGuard.parseConfig('x')).toThrow('plugins.host-guard');
  });
});


describe('状态机', () => {
  test('ok → warn → exceeded 跃迁，超线才告警并拉一次占用前 5', async () => {
    const h = await setup();
    let snap = await h.check();
    expect(snap.ram.level).toBe('ok');
    expect(snap.ram.usedGb).toBe(30);
    expect(snap.ram.maxGb).toBe(60);
    expect(snap.vram.maxGb).toBe(15.5);

    h.dial.ramGb = 55;
    snap = await h.check();
    expect(snap.ram.level).toBe('warn');
    expect(h.emitted).toHaveLength(0);

    h.dial.ramGb = 61;
    snap = await h.check();
    expect(snap.ram.level).toBe('exceeded');
    expect(snap.exceeded).toBe(true);
    expect(snap.ram.alerting).toBe(true);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.kind).toBe('exceeded');
    expect(h.emitted[0]?.line).toBe('ram');
    expect(h.emitted[0]?.text).toContain('big.exe');
    expect(snap.top.ram).toHaveLength(1);
    expect(h.dial.topCalls).toBe(1);
  });

  test('显存按 15.5 GB 判超线', async () => {
    const h = await setup();
    h.dial.vramGb = 15.6;
    const snap = await h.check();
    expect(snap.vram.level).toBe('exceeded');
    expect(h.emitted[0]?.line).toBe('vram');
  });

  test('冷却期内不重复告警，过了冷却再提醒', async () => {
    const h = await setup();
    h.dial.ramGb = 62;
    await h.check();
    h.dial.now += 60_000;
    await h.check();
    h.dial.now += 200_000;
    await h.check();
    expect(h.emitted).toHaveLength(1);

    h.dial.now += 40_000;
    await h.check();
    expect(h.emitted).toHaveLength(2);
    expect(h.dial.topCalls).toBe(2);
  });

  test('连续 2 次 ok 才发回落，中间回到预警就重数', async () => {
    const h = await setup();
    h.dial.ramGb = 61;
    await h.check();

    h.dial.ramGb = 40;
    let snap = await h.check();
    expect(snap.ram.alerting).toBe(true);
    h.dial.ramGb = 56;
    await h.check();
    h.dial.ramGb = 40;
    await h.check();
    expect(h.emitted).toHaveLength(1);

    snap = await h.check();
    expect(snap.ram.alerting).toBe(false);
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1]?.kind).toBe('recovered');
    expect(snap.alerts).toHaveLength(2);

    //M 回落后不再发。
    await h.check();
    expect(h.emitted).toHaveLength(2);
  });

  test('读不到显卡温和降级：unknown、不告警、内存照常', async () => {
    const h = await setup(undefined, false);
    h.dial.ramGb = 61;
    const snap = await h.check();
    expect(snap.gpuAvailable).toBe(false);
    expect(snap.vram.level).toBe('unknown');
    expect(snap.vram.usedGb).toBeNull();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.line).toBe('ram');
  });

  test('notify_feishu 打开时原子写进飞书发件箱，默认不写', async () => {
    const off = await setup();
    off.dial.ramGb = 61;
    await off.check();
    expect(fs.existsSync(path.join(off.root, 'integrations', 'feishu', 'outbox'))).toBe(false);

    const on = await setup({ notify_feishu: true });
    on.dial.ramGb = 61;
    await on.check();
    const outbox = path.join(on.root, 'integrations', 'feishu', 'outbox');
    const files = fs.readdirSync(outbox);
    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith('.md');
    expect(fs.readFileSync(path.join(outbox, files[0] as string), 'utf8')).toContain('宿主机内存超线');
  });
});


describe('接口', () => {
  test('GET status 回快照；POST check 未核验 403、核验 200', async () => {
    const h = await setup();
    let res = await h.app.inject({ method: 'GET', url: '/api/host-guard/status' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as hostGuard.HostSnapshot).sampledAt).toBeNull();

    h.dial.verified = false;
    res = await h.app.inject({ method: 'POST', url: '/api/host-guard/check' });
    expect(res.statusCode).toBe(403);

    h.dial.verified = true;
    res = await h.app.inject({ method: 'POST', url: '/api/host-guard/check' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as hostGuard.HostSnapshot).sampledAt).toBe(1_000_000);
  });
});


describe('工具 host_guard_status', () => {
  test('本人能问到读数，飞书外人被拒', async () => {
    const h = await setup();
    const run = h.tools.get('host_guard_status');
    if (run === undefined) throw new Error('工具没登记');

    const owner = { row: { channel: 'web', address: {} } } as unknown as Session;
    const answer = await run({}, owner);
    expect(answer).toContain('内存：已用 30 GB');
    expect(answer).toContain('红线 15.5 GB');

    const guest = { row: { channel: 'feishu', address: { customer: 'feishu:group:x' } } } as unknown as Session;
    await expect(run({}, guest)).rejects.toThrow('只回答本人');
  });
});


describe('进程清单解析', () => {
  test('tasklist、ps、nvidia 三种格式都取前 5，N/A 跳过', () => {
    const tasklist = [
      '"chrome.exe","1200","Console","1","1,048,576 K"',
      '"bun.exe","300","Console","1","204,800 K"',
      '"坏行"',
    ].join('\r\n');
    expect(probeModule.parseTop(tasklist, 'tasklist')).toEqual([
      { pid: 1200, name: 'chrome.exe', mb: 1024 },
      { pid: 300, name: 'bun.exe', mb: 200 },
    ]);

    const ps = '  10 2048 bun\n  11 4096 my app\n';
    expect(probeModule.parseTop(ps, 'ps')[0]).toEqual({ pid: 11, name: 'my app', mb: 4 });

    const nvidia = '500, python.exe, 8000\n501, game.exe, [N/A]\n';
    expect(probeModule.parseTop(nvidia, 'nvidia')).toEqual([{ pid: 500, name: 'python.exe', mb: 8000 }]);

    const many = Array.from({ length: 8 }, (_v, i) => `${String(i + 1)} ${String((i + 1) * 1024)} p${String(i)}`);
    expect(probeModule.parseTop(many.join('\n'), 'ps')).toHaveLength(5);
  });

  test('多卡取用得最多的那张，没卡是 null', () => {
    const gpus = [{ index: 0, used: 2, total: 16 }, { index: 1, used: 9, total: 24 }];
    expect(probeModule.pickBusiestGpu(gpus)).toEqual({ used: 9, total: 24 });
    expect(probeModule.pickBusiestGpu(null)).toBeNull();
    expect(probeModule.pickBusiestGpu([])).toBeNull();
  });
});
