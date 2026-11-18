/** Windows 及其他系统均运行真实的假子程序，验证宿主和 HTTP 接线。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { afterEach, expect, test } from 'bun:test';
import * as hostModule from './Host.ts';
import * as specModule from './Spec.ts';
import * as programs from './index.ts';

/** 假程序使用与测试相同的 Bun，不经脚本包装器。 */
const SCRIPT = path.resolve(import.meta.dir, '..', '..', '..', 'ztools', 'fake-program', 'Fake_Program.ts');
/** 当前用例需要按相反顺序执行的清理。 */
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** 在获准的插件目录中生成独立的测试数据目录。 */
function getRoot(): string {
  const prefix = path.join(import.meta.dir, '.programs-test-');
  const root = fs.mkdtempSync(prefix);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 按通用协议组装假程序配置。 */
function getConfig(flags: string[] = [], autostart = true) {
  const args = [SCRIPT, '--name', 'fake', '--host', '{host}', '--port', '{port}', ...flags];
  return { programs: [{
    name: 'fake', file: process.execPath, args, autostart, startup_ms: 5000, exit_wait_ms: 150,
  }] };
}

/** 构造独立的宿主测试实例。 */
function getHost(
  flags: string[],
  timing?: ConstructorParameters<typeof hostModule.Host>[2],
  ctx?: cordis.Context,
) {
  const root = getRoot();
  const specs = specModule.readPrograms(getConfig(flags));
  const host = new hostModule.Host(specs[0]!, root, timing, ctx);
  cleanups.push(() => host.stop());
  const log = path.join(root, 'data', 'logs', 'fake.log');
  return { host, log };
}

/** 等候异步条件。超时附上当时的状态，便于定位子进程问题。 */
async function waitFor(state: () => ReturnType<hostModule.Host['status']>, wanted: string, previous?: number) {
  const end = performance.now() + 7000;
  while (performance.now() < end) {
    const current = state();
    if (current.state === wanted && current.pid !== previous) return current;

    await Bun.sleep(15);
  }
  const actual = JSON.stringify(state());
  throw new Error(`没等到 ${wanted}：${actual}`);
}

/** 挂上整个 programs 插件和独立 Fastify；读数与通知都是假的，不调用真实GPU探针或外发。 */
async function getPlugin() {
  const root = getRoot();
  const app = fastify.default();
  const ctx = new cordis.Context();
  cleanups.push(async () => { await app.close(); }, async () => { await ctx.fiber.dispose(); });
  ctx.provide('resources', { root });
  ctx.provide('http', { app });
  const dependencies = {
    read: async () => ({ at: Date.now(), cpu: 10, memory: 1024, totalMemory: 2048, gpus: null }),
    notify: () => true,
  };
  const plugin = {
    inject: programs.inject,
    apply: (sub: cordis.Context) => programs.apply(sub, getConfig(), dependencies),
  };
  await ctx.plugin(plugin);
  await app.ready();
  return { app, ctx, root };
}

test('主程序 ready 后启动，状态接口、代理及协议退出入口可用', async () => {
  const { app, ctx, root } = await getPlugin();

  const before = await app.inject('/api/programs');
  expect(before.json()).toMatchObject({ programs: [{ name: 'fake', state: 'stopped' }] });
  const offline = await app.inject('/api/ext/fake/');
  expect(offline.statusCode).toBe(503);
  ctx.emit('ready', []);
  const ready = await waitFor(() => ctx.programs.status()[0]!, 'ready');
  expect(ready.port).toBeGreaterThan(0);
  expect(ready.pid).toBeGreaterThan(0);
  expect(ctx.programs.url('fake')).toEndWith(String(ready.port));

  //M 管理接口只给 jmbots 自己调；大小写、多斜线、编码的写法经主站转发也一律 404，程序照常在跑。
  const health = await app.inject('/api/ext/fake/jmbots/v1/health');
  expect(health.statusCode).toBe(404);
  const exit = await app.inject({ method: 'POST', url: '/api/ext/fake//JMBOTS/v1/%65xit', payload: { graceMs: 1 } });
  expect(exit.statusCode).toBe(404);
  const running = ctx.programs.status()[0];
  expect(running).toMatchObject({ state: 'ready', pid: ready.pid, license: 'free', licenseLabel: '不需要' });

  //M 主站令牌、Cookie、Referer 和地址里的 token 都不交给程序，别的头和查询参数原样带过去。
  const headers = { authorization: 'Bearer secret', cookie: 'a=1', referer: 'http://host/?token=secret', 'x-demo': 'yes' };
  const echoRequest = { method: 'POST' as const, url: '/api/ext/fake/echo?token=secret&x=1', payload: { text: '一项测试' }, headers };
  const echo = await app.inject(echoRequest);
  const echoed = echo.json<{ received: unknown; url: string; headers: Record<string, string> }>();
  expect(echoed.received).toEqual({ text: '一项测试' });
  expect(echoed.url).toBe('/echo?x=1');
  expect(echoed.headers['x-demo']).toBe('yes');
  expect(echoed.headers).not.toHaveProperty('authorization');
  expect(echoed.headers).not.toHaveProperty('cookie');
  expect(echoed.headers).not.toHaveProperty('referer');

  const stopped = await app.inject({ method: 'POST', url: '/api/programs/fake/stop' });
  expect(stopped.statusCode).toBe(200);
  expect(stopped.json()).toMatchObject({ program: { state: 'stopped', pid: null, port: null } });
  const log = path.join(root, 'data', 'logs', 'fake.log');
  expect(fs.readFileSync(log, 'utf8')).toContain('假程序收到退出请求');

  const started = await app.inject({ method: 'POST', url: '/api/programs/fake/start' });
  expect(started.statusCode).toBe(200);
  const second = await waitFor(() => ctx.programs.status()[0]!, 'ready', ready.pid!);
  const restarted = await app.inject({ method: 'POST', url: '/api/programs/fake/restart' });
  expect(restarted.statusCode).toBe(200);
  const third = await waitFor(() => ctx.programs.status()[0]!, 'ready', second.pid!);
  expect(third.pid).not.toBe(second.pid);
}, 12_000);

test('界面入口 /programs/<名字>/ 只转已就绪且报了界面的自有程序，跳转换回前缀', async () => {
  const { app, ctx } = await getPlugin();
  const before = await app.inject('/programs/fake/');
  expect(before.statusCode).toBe(404);
  ctx.emit('ready', []);
  const ready = await waitFor(() => ctx.programs.status()[0]!, 'ready');
  expect(ready.ui).toBe('/programs/fake/');

  const page = await app.inject('/programs/fake/?token=secret');
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('<h1>fake</h1>');

  //M 不带尾斜线补上再跳，查询参数（含令牌）原样带过去，界面里的相对路径才落在前缀下。
  const bare = await app.inject('/programs/fake?token=secret');
  expect(bare.statusCode).toBe(302);
  expect(bare.headers.location).toBe('/programs/fake/?token=secret');

  //M 程序跳回自己的根路径时换成主站前缀，浏览器不会跳出转发。
  const go = await app.inject('/programs/fake/go');
  expect(go.statusCode).toBe(302);
  expect(go.headers.location).toBe('/programs/fake/');

  //M 界面里写相对的 echo 就落到 /programs/fake/echo，转给程序的 /echo。
  const echoRequest = { method: 'POST' as const, url: '/programs/fake/echo', payload: { text: '界面' } };
  const echo = await app.inject(echoRequest);
  expect(echo.json()).toMatchObject({ received: { text: '界面' }, url: '/echo' });

  //G 配置外的名字、编码过的前缀、管理接口都不转发。
  const other = await app.inject('/programs/other/');
  expect(other.statusCode).toBe(404);
  const encoded = await app.inject('/%70rograms/fake/');
  expect(encoded.statusCode).toBe(404);
  const encodedName = await app.inject('/programs/fak%65/');
  expect(encodedName.statusCode).toBe(404);
  const exit = await app.inject({ method: 'POST', url: '/programs/fake/jmbots/v1/exit', payload: { graceMs: 1 } });
  expect(exit.statusCode).toBe(404);
  expect(ctx.programs.status()[0]).toMatchObject({ state: 'ready', pid: ready.pid });

  //M 停了以后入口立刻没有。
  const stopped = await app.inject({ method: 'POST', url: '/api/programs/fake/stop' });
  expect(stopped.statusCode).toBe(200);
  const gone = await app.inject('/programs/fake/');
  expect(gone.statusCode).toBe(404);
}, 12_000);

test('自己拉起的子进程被结束后，按默认三秒退避拉起一个新进程', async () => {
  const { host } = getHost([]);
  host.start();
  const first = await waitFor(() => host.status(), 'ready');
  const pid = first.pid!;

  //M 只结束这个用例的宿主刚刚创建并在状态里报告的子进程。
  const killedAt = performance.now();
  process.kill(pid, 'SIGKILL');
  const second = await waitFor(() => host.status(), 'ready', pid);
  expect(second.pid).not.toBe(pid);
  expect(second.restarts).toBe(1);
  expect(performance.now() - killedAt).toBeGreaterThanOrEqual(2900);
}, 12_000);

test('连续五个假进程启动即崩时放弃自动重启', async () => {
  const timing = { retryMs: 15, retryMaxMs: 30 };
  const { host } = getHost(['--crash-on-start'], timing);
  host.start();
  const failed = await waitFor(() => host.status(), 'failed');

  expect(failed.pid).toBeNull();
  expect(failed.restarts).toBe(4);
  expect(failed.note).toContain('连续失败 5 次');
  await Bun.sleep(70);
  expect(host.status()).toEqual(failed);
}, 10_000);

test('连续健康失败后给程序退出机会并启动另一个实例', async () => {
  const timing = { retryMs: 30, watchMs: 35 };
  const { host, log } = getHost(['--fail-health'], timing);
  host.start();
  const first = await waitFor(() => host.status(), 'ready');
  const next = await waitFor(() => host.status(), 'ready', first.pid!);
  expect(next.restarts).toBe(1);
  expect(fs.readFileSync(log, 'utf8')).toContain('假程序收到退出请求');
});

test('假程序确认退出接口但继续运行时，超时后结束自己的 PID', async () => {
  const { host, log } = getHost(['--ignore-exit']);
  host.start();
  const first = await waitFor(() => host.status(), 'ready');
  const begin = performance.now();
  await host.stop();
  expect(performance.now() - begin).toBeGreaterThanOrEqual(120);
  expect(host.status()).toMatchObject({ state: 'stopped', pid: null });
  expect(fs.readFileSync(log, 'utf8')).toContain('假程序收到退出请求');
  expect(() => process.kill(first.pid!, 0)).toThrow();
}, 10_000);

test('只接受支持的协议版本，错版本的进程被回收并停止自动重试', async () => {
  const { host } = getHost(['--protocol', '2']);
  host.start();
  const blocked = await waitFor(() => host.status(), 'blocked');
  expect(blocked.note).toContain('协议版本不对');
  await waitFor(() => host.status(), 'blocked', blocked.pid ?? undefined);
  expect(host.status()).toMatchObject({ state: 'blocked', pid: null, restarts: 0 });
});


test('已核实的假程序才有UI；过期仍ready，健康刷新不重复广播，停止立即撤入口', async () => {
  const ctx = new cordis.Context();
  cleanups.push(async () => { await ctx.fiber.dispose(); });
  const events: programs.ProgramState[] = [];
  ctx.on('program/state', (event) => { events.push({ ...event }); });
  const timing = { watchMs: 30 };
  const { host } = getHost(['--license', 'expired'], timing, ctx);
  expect(host.status()).toMatchObject({ ui: null, licenseLabel: '未知' });
  host.start();
  expect(events[0]).toMatchObject({ state: 'starting', ui: null, license: 'unknown' });
  const ready = await waitFor(() => host.status(), 'ready');
  expect(ready).toMatchObject({ license: 'expired', licenseLabel: '过期', ui: '/programs/fake/' });
  expect(host.getUiPath()).toBe('/');

  //M 只访问本用例独立Fake端口，不运行真实UI或发送外部通知。
  const url = `${host.getUrl()!}/`;
  const response = await fetch(url);
  const html = await response.text();
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(html).toContain('<h1>fake</h1>');
  expect(html).toContain('expired');
  await Bun.sleep(120);
  const readyEvents = events.filter((event) => event.state === 'ready');
  expect(readyEvents).toHaveLength(1);
  const stopping = host.stop();
  expect(host.getUiUrl()).toBeNull();
  await stopping;
  expect(events.at(-1)).toMatchObject({ state: 'stopped', ui: null });
  const count = events.length;
  await host.stop();
  expect(events).toHaveLength(count);
});

test('没有info.ui的独立假程序正常ready但不发放入口', async () => {
  const { host } = getHost(['--no-ui']);
  host.start();
  const ready = await waitFor(() => host.status(), 'ready');
  expect(ready).toMatchObject({ state: 'ready', licenseLabel: '不需要', ui: null });
  expect(host.getUiPath()).toBeNull();
});


test('未启动实例本来就是stopped，反复停止不虚构状态变化事件', async () => {
  const ctx = new cordis.Context();
  cleanups.push(async () => { await ctx.fiber.dispose(); });
  const events: programs.ProgramState[] = [];
  ctx.on('program/state', (event) => { events.push(event); });
  const { host } = getHost([], undefined, ctx);
  await host.stop();
  await host.stop();
  expect(events).toHaveLength(0);
});
