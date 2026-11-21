/** 资源守卫只用假读数、假Host和假通知；不制造压力、不碰实际进程或真实发件箱。 */
import * as cordis from 'cordis';
import { afterEach, expect, test } from 'bun:test';
import * as guardModule from './ResourceGuard.ts';
import * as specModule from './Spec.ts';
import * as probeModule from './ResourceProbe.ts';
import * as programsModule from './index.ts';
import type { Host } from './Host.ts';

/** 测试容量统一用二进制GiB。 */
const GIB = 1024 ** 3;
/** 本文件创建的上下文，逐例卸载事件监听。 */
const contexts: cordis.Context[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose();
  }
});

/** 无操作系统进程的Host替身，所有动作只记在数组。 */
class FakeHost implements guardModule.GuardHost {
  /** 已经通过真实Spec入口的配置。 */
  readonly spec: specModule.ProgramSpec;
  /** 仅供断言的动作记录。 */
  readonly actions: string[] = [];
  /** 当前模拟状态。 */
  state: ReturnType<Host['status']>['state'] = 'ready';
  /** 数字仅为替身标志，不传给任何OS接口。 */
  pid: number | null = 123;
  /** 模拟管理代次。 */
  generation = 0;
  /** 模拟后台暂停状态。 */
  paused = false;
  /** 模拟显式pause能力。 */
  canPause = true;
  /** 模拟自报MiB；undefined表示不可排行。 */
  rssMb: number | undefined = 100;
  /** 模拟健康读数过期。 */
  stale = false;
  /** 模拟连崩放弃标志。 */
  gaveUp = false;
  /** 模拟授权状态。 */
  license: string | undefined;

  /** 只解析配置，不创建进程或目录。 */
  constructor(name: string, closable: boolean, private readonly now: () => number) {
    const config = { programs: [{ name, file: 'never-executed', closable, heavy: true }] };
    this.spec = specModule.readPrograms(config)[0]!;
  }

  /** 交回与真实Host同形的公开状态。 */
  status(): ReturnType<Host['status']> {
    let rssAt = this.now();
    if (this.stale) {
      rssAt = -1_000_000;
    }
    return {
      name: this.spec.name, title: this.spec.title, state: this.state, note: '假宿主',
      port: 1, pid: this.pid, version: 'test', restarts: 0,
      generation: this.generation, paused: this.paused, canPause: this.canPause,
      rssMb: this.rssMb, rssAt, license: this.license, gaveUp: this.gaveUp,
      licenseLabel: '未知', ui: null,
    };
  }

  /** 后台暂停只改替身字段，明确返回确认。 */
  async pause(paused: boolean): Promise<boolean> {
    let action = 'resume';
    if (paused) {
      action = 'pause';
    }
    this.actions.push(action);
    this.paused = paused;
    return true;
  }

  /** 模拟正常停止和代次变化，不传递真实PID。 */
  async stop(): Promise<void> {
    this.actions.push('stop');
    this.generation += 1;
    this.state = 'stopped';
    this.pid = null;
    this.paused = false;
  }

  /** 模拟重新拉起，不创建任何真实子进程。 */
  start(): void {
    this.actions.push('start');
    this.generation += 1;
    this.state = 'ready';
    this.pid = 124;
  }
}

/** 建立纯假守卫；env可控制时钟、读数、失败与等待。 */
function getHarness() {
  const ctx = new cordis.Context();
  contexts.push(ctx);
  const hosts: FakeHost[] = [];
  const notices: { key: string; text: string; at: number }[] = [];
  const env = {
    now: 0,
    sample: {
      cpu: 10 as number | null,
      memory: 10 * GIB as number | null,
      totalMemory: 64 * GIB as number | null,
      gpus: [{ index: 0, used: GIB, total: 16 * GIB }] as probeModule.GpuSample[] | null,
    },
    read: undefined as ((signal: AbortSignal) => Promise<probeModule.ResourceSample>) | undefined,
  };
  const dependencies = {
    now: () => env.now,
    read: async (signal: AbortSignal) => {
      if (env.read !== undefined) return env.read(signal);
      return { at: env.now, ...env.sample };
    },
    notify: (key: string, text: string, at: number) => {
      notices.push({ key, text, at });
      return true;
    },
  };
  const settings = specModule.readGuard(undefined);
  const guard = new guardModule.ResourceGuard(ctx, settings, hosts, dependencies);
  const host = (name: string, closable = false) => {
    const fake = new FakeHost(name, closable, () => env.now);
    hosts.push(fake);
    return fake;
  };
  return { ctx, hosts, notices, env, guard, host };
}

test('CPU不限流（用户 #442）：CPU 99%或读不到都放行重活，不发CPU告警，档位仍是ok', async () => {
  const h = getHarness();
  const events: guardModule.ResourcePressure[] = [];
  h.ctx.on('programs/pressure', (event) => { events.push(event); });
  const request = { action: 'can-start' as const };
  h.env.sample.cpu = 99;
  expect((await h.guard.request(request)).ok).toBe(true);
  h.env.now = 120_000;
  await h.guard.tick();
  h.env.sample.cpu = null;
  expect((await h.guard.request(request)).ok).toBe(true);
  await h.guard.tick();
  expect(h.notices.filter((n) => n.key.startsWith('cpu'))).toHaveLength(0);
  expect(events.every((event) => event.level === 'ok')).toBe(true);

  //M CPU再高，内存到60GiB照样拦。
  h.env.sample.cpu = 99;
  h.env.sample.memory = 60 * GIB;
  expect((await h.guard.request(request)).ok).toBe(false);
});

test('60GiB暂停所有有能力的在办项，30秒只停一个可关最大RSS，严格低于55恢复', async () => {
  const h = getHarness();
  const locked = h.host('not-closable');
  locked.rssMb = 9000;
  const small = h.host('small', true);
  small.rssMb = 1000;
  const largest = h.host('largest', true);
  largest.rssMb = 3000;
  const inactive = h.host('inactive', true);
  inactive.state = 'stopped';
  inactive.pid = null;
  h.env.sample.memory = 60 * GIB;
  await h.guard.tick();
  expect(locked.actions).toEqual(['pause']);
  expect(largest.actions).toEqual(['pause']);
  expect(inactive.actions).toEqual([]);
  h.env.now = 29_999;
  await h.guard.tick();
  expect(largest.actions).not.toContain('stop');
  h.env.now = 30_000;
  await h.guard.tick();
  expect(largest.actions).toEqual(['pause', 'stop']);
  expect(small.actions).not.toContain('stop');
  expect(locked.actions).not.toContain('stop');
  h.env.now = 90_000;
  await h.guard.tick();
  expect(small.actions).not.toContain('stop');
  h.env.sample.memory = 55 * GIB;
  await h.guard.tick();
  expect(largest.actions).not.toContain('start');
  h.env.sample.memory = 54.9 * GIB;
  await h.guard.tick();
  expect(largest.actions).toEqual(['pause', 'stop', 'start']);
  expect(small.actions).toEqual(['pause', 'resume']);
  expect(inactive.actions).toEqual([]);
  expect(h.notices.filter((n) => n.key === 'memory-recovered')).toHaveLength(1);

  //M 正文写清暂停了谁、关了谁、恢复了谁。
  const high = h.notices.find((n) => n.key === 'memory-high');
  expect(high?.text).toContain('已让 not-closable、small、largest 暂停后台');
  const shed = h.notices.find((n) => n.key === 'memory-shed');
  expect(shed?.text).toContain('正常关闭了 largest（它自报占 3000 MiB）');
  const recovered = h.notices.find((n) => n.key === 'memory-recovered');
  expect(recovered?.text).toContain('已恢复 not-closable、small、largest');
});

test('一个程序都没有也通知：内存超线、显存超线，正文写清现在多少和该做什么', async () => {
  const h = getHarness();
  h.env.sample.memory = 61 * GIB;
  //M 16GiB减50MiB正好是15.951171875GiB，两位小数显示15.95，不受浮点误差影响。
  h.env.sample.gpus = [{ index: 0, used: 16 * GIB - 50 * 1024 ** 2, total: 16 * GIB }];
  await h.guard.tick();
  const memory = h.notices.find((n) => n.key === 'memory-high');
  expect(memory?.text).toContain('已用 61.00GiB / 共 64.00GiB（线 60.00GiB）；降到 55.00GiB 以下算恢复');
  expect(memory?.text).toContain('jmbots 没有拉起能暂停的程序');
  expect(memory?.text).toContain('任务管理器');
  const vram = h.notices.find((n) => n.key === 'vram-high:0');
  expect(vram?.text).toContain('卡0 已用 15.95GiB / 共 16.00GiB（线 15.50GiB）');
  expect(vram?.text).toContain('你可以：');
});

test('插件一个程序都不配也挂守卫：ready后采样，发programs/pressure和内存通知', async () => {
  const ctx = new cordis.Context();
  contexts.push(ctx);
  ctx.provide('resources', { root: 'never-written', config: { plugins: [] } });
  const events: guardModule.ResourcePressure[] = [];
  ctx.on('programs/pressure', (event) => { events.push(event); });
  const keys: string[] = [];
  const dependencies = {
    read: async () => ({ at: Date.now(), cpu: 10, memory: 61 * GIB, totalMemory: 64 * GIB, gpus: null }),
    notify: (key: string) => {
      keys.push(key);
      return true;
    },
  };
  const plugin = {
    inject: programsModule.inject,
    apply: (sub: cordis.Context) => programsModule.apply(sub, undefined, dependencies),
  };
  await ctx.plugin(plugin);
  ctx.emit('ready', []);
  const end = performance.now() + 2000;
  while (keys.length === 0 && performance.now() < end) {
    await Bun.sleep(10);
  }
  expect(ctx.programs.status()).toEqual([]);
  expect(events[0]?.level).toBe('high');
  expect(keys).toEqual(['memory-high']);
});

test('未连续30秒在60线上不关闭；未知或过期RSS不参与选择', async () => {
  const h = getHarness();
  const valid = h.host('valid', true);
  const stale = h.host('stale', true);
  stale.stale = true;
  stale.rssMb = 50_000;
  const missing = h.host('missing', true);
  missing.rssMb = undefined;
  h.env.sample.memory = 60 * GIB;
  await h.guard.tick();
  h.env.now = 15_000;
  h.env.sample.memory = 58 * GIB;
  await h.guard.tick();
  h.env.now = 40_000;
  h.env.sample.memory = 60 * GIB;
  await h.guard.tick();
  h.env.now = 69_999;
  await h.guard.tick();
  expect(valid.actions).not.toContain('stop');
  h.env.now = 70_000;
  await h.guard.tick();
  expect(valid.actions).toContain('stop');
  expect(stale.actions).not.toContain('stop');
  expect(missing.actions).not.toContain('stop');
});

test('用户并发手停使恢复凭据失效，原先暂停的宿主不被恢复或关闭', async () => {
  const h = getHarness();
  const owned = h.host('owned', true);
  const manual = h.host('already-paused', true);
  manual.paused = true;
  manual.rssMb = 5000;
  h.env.sample.memory = 61 * GIB;
  await h.guard.tick();
  h.env.now = 30_000;
  await h.guard.tick();
  //M 这是替身stop，只模拟用户改变代次，不操作实际进程。
  await owned.stop();
  h.env.sample.memory = 54 * GIB;
  await h.guard.tick();
  expect(owned.actions).not.toContain('start');
  expect(manual.actions).toEqual([]);
});

test('无可暂停程序也通知高线和恢复，同类10分钟去重且到期可再通知', async () => {
  const h = getHarness();
  h.env.sample.memory = 61 * GIB;
  await h.guard.tick();
  h.env.now = 599_999;
  await h.guard.tick();
  expect(h.notices.filter((n) => n.key === 'memory-high')).toHaveLength(1);
  h.env.now = 600_000;
  await h.guard.tick();
  expect(h.notices.filter((n) => n.key === 'memory-high')).toHaveLength(2);
  h.env.sample.memory = 54 * GIB;
  await h.guard.tick();
  expect(h.notices.filter((n) => n.key === 'memory-recovered')).toHaveLength(1);
});

test('GPU请求计入逐卡上限、安全余量和并发预留；60秒后过期', async () => {
  const h = getHarness();
  h.env.sample.gpus = [{ index: 0, used: 10 * GIB, total: 16 * GIB }];
  const request = { action: 'can-start' as const, vram_mb: 3 * 1024 };
  const [first, second] = await Promise.all([h.guard.request(request), h.guard.request(request)]);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(false);
  expect(second.reason).toContain('已用10.00GiB');
  expect(second.reason).toContain('要3.00GiB');
  expect(second.reason).toContain('上限15.50GiB');
  h.env.now = 60_000;
  expect((await h.guard.request(request)).ok).toBe(true);
});

test('不跨GPU凑空间，小卡按物理总量裁剪；voice已有量加需求不能超过8GiB', async () => {
  const h = getHarness();
  h.env.sample.gpus = [
    { index: 0, used: 15 * GIB, total: 16 * GIB },
    { index: 1, used: 0, total: 4 * GIB },
  ];
  const request = { action: 'can-start' as const, vram_mb: 1024 };
  expect((await h.guard.request(request)).ok).toBe(false);
  expect((await h.guard.request({ ...request, gpu: 1, vram_mb: 5 * 1024 })).ok).toBe(false);
  expect((await h.guard.request({ ...request, gpu: 1 })).ok).toBe(true);
  h.env.sample.gpus = [{ index: 0, used: 0, total: 16 * GIB }];
  const voice = { ...request, who: 'voice', owned_vram_mb: 7 * 1024, vram_mb: 2 * 1024 };
  const result = await h.guard.request(voice);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain('8GiB');
});

test('GPU不可用不阻断非显卡任务；内存未知或采样失败拒绝新工作', async () => {
  const h = getHarness();
  const request = { action: 'can-start' as const };
  h.env.sample.gpus = null;
  expect((await h.guard.request(request)).ok).toBe(true);
  expect((await h.guard.request({ ...request, vram_mb: 10 })).ok).toBe(false);
  h.env.sample.memory = null;
  expect((await h.guard.request(request)).ok).toBe(false);
  h.env.read = async () => { throw new Error('模拟读数失败'); };
  expect((await h.guard.request(request)).ok).toBe(false);
});

test('显存硬线与压力事件迟滞；连崩放弃和授权过期分别限频通知', async () => {
  const h = getHarness();
  const host = h.host('expired');
  host.gaveUp = true;
  host.license = 'expired';
  const events: guardModule.ResourcePressure[] = [];
  h.ctx.on('programs/pressure', (event) => { events.push(event); });
  h.env.sample.gpus = [{ index: 0, used: 15.5 * GIB, total: 16 * GIB }];
  await h.guard.tick();
  await h.guard.tick();
  expect(events).toHaveLength(1);
  expect(events[0]?.level).toBe('high');
  expect(h.notices.filter((n) => n.key.startsWith('vram-high'))).toHaveLength(1);
  expect(h.notices.filter((n) => n.key === 'crash:expired')).toHaveLength(1);
  expect(h.notices.filter((n) => n.key === 'license:expired')).toHaveLength(1);
  h.env.sample.gpus[0]!.used = 15 * GIB;
  await h.guard.tick();
  expect(events).toHaveLength(1);
  h.env.sample.gpus[0]!.used = 14.4 * GIB;
  await h.guard.tick();
  expect(events[1]?.level).toBe('ok');
});

test('请求同步接单并按requestId回执，非法参数也明确拒绝；dispose后拒开', async () => {
  const h = getHarness();
  const results: guardModule.ResourceResult[] = [];
  h.ctx.on('programs/resource-result', (result) => { results.push(result); });
  const request = { action: 'can-start' as const, requestId: 'valid' };
  const handled = h.ctx.serial('programs/resource-request', request);
  expect((request as guardModule.ResourceRequest).handled).toBe(true);
  await handled;
  expect(results[0]).toMatchObject({ requestId: 'valid', ok: true });
  const invalid = { action: 'can-start' as const, requestId: 'invalid', vram_mb: -1 };
  await h.ctx.serial('programs/resource-request', invalid);
  expect(results[1]).toMatchObject({ requestId: 'invalid', ok: false });
  await h.guard.dispose();
  expect((await h.guard.request(request)).ok).toBe(false);
});

test('慢读数只执行一次，卸载后完成的旧采样不暂停/恢复/发通知', async () => {
  const h = getHarness();
  const host = h.host('never-touched', true);
  let reads = 0;
  const wait = Promise.withResolvers<probeModule.ResourceSample>();
  h.env.read = () => {
    reads += 1;
    return wait.promise;
  };
  const first = h.guard.tick();
  const second = h.guard.tick();
  expect(reads).toBe(1);
  const disposed = h.guard.dispose();
  wait.resolve({ at: 0, cpu: 90, memory: 61 * GIB, totalMemory: 64 * GIB, gpus: null });
  await Promise.all([first, second, disposed]);
  expect(host.actions).toEqual([]);
  expect(h.notices).toEqual([]);
});

test('旧低读数不能错误恢复高位，未知内存不会当作已降到55以下', async () => {
  const h = getHarness();
  const host = h.host('paused');
  h.env.sample.memory = 61 * GIB;
  await h.guard.tick();
  h.env.now = 100_000;
  h.env.read = async () => ({ at: 0, cpu: 10, memory: 0, totalMemory: 64 * GIB, gpus: null });
  await h.guard.tick();
  expect(host.actions).toEqual(['pause']);
  expect(h.guard.resources().memory).toBeNull();
});

test('nvidia-smi边界解析MiB、逐卡索引，N/A/重复/空/负数失败不伪造空卡', () => {
  expect(probeModule.parseGpus('0, 7419, 16311')).toEqual([
    { index: 0, used: 7419 * 1024 ** 2, total: 16311 * 1024 ** 2 },
  ]);
  for (const text of ['', '0,N/A,16311', '0,-1,16311', '0,1,16\n0,2,16', '0,17,16']) {
    expect(probeModule.parseGpus(text)).toBeNull();
  }
});


test('停前再次采样已经低于60线时不关闭，不拿暂停前读数当仍超限', async () => {
  const h = getHarness();
  const host = h.host('checked-before-stop', true);
  h.env.sample.memory = 61 * GIB;
  await h.guard.tick();
  h.env.now = 30_000;
  let reads = 0;
  h.env.read = async () => {
    reads += 1;
    let memory = 61 * GIB;
    if (reads > 1) {
      memory = 58 * GIB;
    }
    return { at: h.env.now, cpu: 10, memory, totalMemory: 64 * GIB, gpus: null };
  };
  await h.guard.tick();
  expect(reads).toBe(2);
  expect(host.actions).not.toContain('stop');
});


test('两轮tick间准入读到已降压会重新计算连续30秒，不能提前停程序', async () => {
  const h = getHarness();
  const host = h.host('continuous', true);
  h.env.sample.memory = 61 * GIB;
  await h.guard.tick();
  h.env.now = 20_000;
  h.env.sample.memory = 58 * GIB;
  await h.guard.request({ action: 'can-start' });
  h.env.now = 25_000;
  h.env.sample.memory = 61 * GIB;
  await h.guard.request({ action: 'can-start' });
  h.env.now = 30_000;
  await h.guard.tick();
  expect(host.actions).not.toContain('stop');
  h.env.now = 55_000;
  await h.guard.tick();
  expect(host.actions).toContain('stop');
});


test('恢复HTTP等待期间再次高位，立即重新暂停且不继续恢复', async () => {
  const h = getHarness();
  const host = h.host('recover-race');
  h.env.sample.memory = 61 * GIB;
  await h.guard.tick();
  const pause = host.pause.bind(host);
  host.pause = async (paused: boolean) => {
    if (!paused) {
      h.env.sample.memory = 61 * GIB;
      await h.guard.request({ action: 'can-start' });
    }
    return pause(paused);
  };
  h.env.sample.memory = 54 * GIB;
  await h.guard.tick();
  expect(host.actions).toEqual(['pause', 'resume', 'pause']);
  expect(host.paused).toBe(true);
  expect(h.notices.filter((notice) => notice.key === 'memory-recovered')).toHaveLength(0);
});

test('请求曾读到低线但下一轮读数变未知时不恢复程序', async () => {
  const h = getHarness();
  const host = h.host('unknown-before-restore');
  h.env.sample.memory = 61 * GIB;
  await h.guard.tick();
  h.env.sample.memory = 54 * GIB;
  await h.guard.request({ action: 'can-start' });
  h.env.sample.memory = null;
  await h.guard.tick();
  expect(host.actions).toEqual(['pause']);
});
