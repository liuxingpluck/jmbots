/** Windows 及其他系统均运行真实的假子程序，验证宿主和 HTTP 接线。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as httpModule from '../http/index.ts';
import * as hostModule from './Host.ts';
import * as protocolModule from './Protocol.ts';
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
async function getPlugin(config: unknown = getConfig(), pluginNames: string[] = [], mainToken?: string) {
  const root = getRoot();
  const ctx = new cordis.Context();
  const db = new sqlite.Database(':memory:');
  cleanups.push(() => db.close());
  const plugins = pluginNames.map((name) => ({ name, config: {} }));
  const raw = { server: { host: '127.0.0.1', port: 1, token: mainToken } };
  const dir = (name: string): string => path.join(root, name);
  ctx.provide('resources', { root, config: { plugins }, db, raw, dir, pluginStatus: [] });
  if (mainToken === undefined) {
    //M 与身份无关的回归继续用独立 Fastify；身份测试走真正的 HTTP 插件。
    const isolated = fastify.default();
    cleanups.push(async () => { await isolated.close(); });
    const isVerified = (request: fastify.FastifyRequest): boolean => request.ip === '127.0.0.1';
    ctx.provide('http', { app: isolated, isVerified });
  }
  cleanups.push(async () => { await ctx.fiber.dispose(); });
  if (mainToken !== undefined) {
    await ctx.plugin(httpModule);
  }
  const app = ctx.http.app;
  const notices: string[] = [];
  const dependencies = {
    read: async () => ({ at: Date.now(), cpu: 10, memory: 1024, totalMemory: 2048, gpus: null }),
    notify: (_key: string, text: string) => {
      notices.push(text);
      return true;
    },
  };
  const plugin = {
    inject: programs.inject,
    apply: (sub: cordis.Context) => programs.apply(sub, config, dependencies),
  };
  await ctx.plugin(plugin);
  await app.ready();
  return { app, ctx, root, db, notices };
}

test.each([
  { plugin: 'wechat', channel: 'wechat', aliases: [], autostart: true },
  { plugin: 'wechat-kefu', channel: 'wechat-external', aliases: [['wechat', 'wechat-external']], autostart: false },
])('启用 $plugin 时拦下 $channel，拒绝手动启动和重启并只提醒一次', async (fixture) => {
  const defaults = getConfig([], fixture.autostart);
  const channels = [{ name: fixture.channel, bot: '助手' }];
  const program = { ...defaults.programs[0], channels };
  const config = { programs: [program], channel_aliases: fixture.aliases };
  const { app, ctx, db, notices } = await getPlugin(config, [fixture.plugin]);

  //G 就绪前不会把被拦的程序登记为回复、历史或入站处理者。
  const table = "SELECT name FROM sqlite_master WHERE name = 'program_channel_receipts'";
  expect(db.query(table).get()).toBeNull();
  ctx.emit('ready', []);
  expect(ctx.programs.status()[0]).toMatchObject({ state: 'blocked', pid: null });
  expect(ctx.programs.status()[0]?.note).toContain(fixture.plugin);

  //G 无论手动启动还是重启，HTTP 都返回同一个配置冲突，告警仍只有一条。
  for (const action of ['start', 'restart']) {
    const request = { method: 'POST' as const, url: `/api/programs/fake/${action}` };
    const rejected = await app.inject(request);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toContain(fixture.channel);
  }
  const listing = await app.inject('/api/programs');
  expect(listing.json()).toMatchObject({
    programs: [{ name: 'fake', state: 'blocked', pid: null, channels: [fixture.channel] }],
  });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(fixture.plugin);
});

test('停用内置微信后，带渠道的外部程序正常登记并启动', async () => {
  const defaults = getConfig();
  const channels = [{ name: 'wechat', bot: '助手' }];
  const program = { ...defaults.programs[0], channels };
  const config = { programs: [program], channel_aliases: [['wechat', 'wechat-external']] };
  //M resources 的插件清单已过滤禁用微信，保留另一个启用的内置渠道。
  const { app, ctx, db, notices } = await getPlugin(config, ['feishu']);

  //M 假程序用本地随机端口接收主站回调前缀，测试不连接运行中的服务。
  const address = { host: '127.0.0.1', port: 0 };
  await app.listen(address);
  ctx.emit('ready', []);
  const ready = await waitFor(() => ctx.programs.status()[0]!, 'ready');
  expect(ready.pid).toBeGreaterThan(0);
  const table = "SELECT name FROM sqlite_master WHERE name = 'program_channel_receipts'";
  expect(db.query(table).get()).toEqual({ name: 'program_channel_receipts' });
  expect(notices).toEqual([]);
}, 12_000);

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
  const headers = {
    authorization: 'Bearer secret', cookie: 'a=1', referer: 'http://host/?token=secret',
    [protocolModule.KEY_HEADER]: 'forged-client-key', 'x-demo': 'yes',
  };
  const echoRequest = { method: 'POST' as const, url: '/api/ext/fake/echo?token=secret&x=1', payload: { text: '一项测试' }, headers };
  const echo = await app.inject(echoRequest);
  const echoed = echo.json<{ received: unknown; url: string; headers: Record<string, string> }>();
  expect(echoed.received).toEqual({ text: '一项测试' });
  expect(echoed.url).toBe('/echo?x=1');
  expect(echoed.headers['x-demo']).toBe('yes');
  expect(echoed.headers).not.toHaveProperty('authorization');
  expect(echoed.headers).not.toHaveProperty('cookie');
  expect(echoed.headers).not.toHaveProperty('referer');
  expect(echoed.headers).not.toHaveProperty(protocolModule.KEY_HEADER);

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

test('界面代理剥掉主站令牌与伪造密钥，实际转发的密钥遮住回显，管理接口不开放', async () => {
  const { app, ctx } = await getPlugin();
  ctx.emit('ready', []);
  const ready = await waitFor(() => ctx.programs.status()[0]!, 'ready');

  //G 客户端只传伪造头，假程序回显时会显示为当前真实密钥的等长掩码。
  const headers = {
    authorization: 'Bearer secret', cookie: 'a=1', referer: 'http://host/programs/fake/?token=secret',
    [protocolModule.KEY_HEADER]: 'secret-key', 'x-demo': 'yes',
  };
  const echoRequest = { method: 'POST' as const, url: '/programs/fake/echo?token=secret&x=1', payload: { text: '界面' }, headers };
  const echo = await app.inject(echoRequest);
  const echoed = echo.json<{ url: string; headers: Record<string, string> }>();
  expect(echoed.url).toBe('/echo?x=1');
  expect(echoed.headers['x-demo']).toBe('yes');
  for (const name of ['authorization', 'cookie', 'referer']) {
    expect(echoed.headers).not.toHaveProperty(name);
  }
  const masked = echoed.headers[protocolModule.KEY_HEADER] ?? '';
  expect(/^\*+$/u.test(masked)).toBe(true);

  //G 大小写、多斜线、编码、../ 合并后落到管理接口的写法也一律 404，程序照常在跑。
  const paths = [
    '/programs/fake/jmbots/v1/health', '/programs/fake/JMBOTS/V1/exit', '/programs/fake//jmbots/v1/%65xit',
    '/programs/fake/%6Dmbots/v1/exit', '/programs/fake/jmbots%2Fv1/exit', '/programs/fake/a/../jmbots/v1/exit',
  ];
  for (const url of paths) {
    const response = await app.inject({ method: 'POST', url, payload: { graceMs: 1 } });
    expect(response.statusCode).toBe(404);
  }
  //G 老客服确认路径不再转发，普通模型草稿链不经过新的批准入口。
  const old = { method: 'POST' as const, url: '/programs/fake/api/wechat-kefu/outbox/send', payload: { id: 1 } };
  expect((await app.inject(old)).statusCode).toBe(409);
  expect(ctx.programs.status()[0]).toMatchObject({ state: 'ready', pid: ready.pid });
}, 12_000);

test('界面代理重启后用新密钥，过滤分块正文、响应头和错误里的密钥', async () => {
  const { app, ctx, root } = await getPlugin(getConfig(), [], '');
  const request = { url: '/programs/fake/key-probe', headers: { [protocolModule.KEY_HEADER]: 'forged' } };
  const forwarded: string[] = [];
  const realFetch = globalThis.fetch;
  const probeFetch = async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
    const target = new URL(String(input));
    if (target.pathname !== '/key-probe' && target.pathname !== '/key-error') return realFetch(input, init);

    //M 只捕获合成探针的上游头，测试断言使用布尔值，不把密钥打印出来。
    const headers = new Headers(init?.headers);
    const key = headers.get(protocolModule.KEY_HEADER);
    if (key === null) return new Response('未收到主站密钥', { status: 401 });

    forwarded.push(key);
    if (target.pathname === '/key-error') throw new Error(key);

    const encoder = new TextEncoder();
    const split = Math.floor(key.length / 2);
    const first = encoder.encode(`前段${key.slice(0, split)}`);
    const last = encoder.encode(`${key.slice(split)}后段`);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(first);
        await Bun.sleep(5);
        controller.enqueue(last);
        controller.close();
      },
    });
    const responseHeaders = { [protocolModule.KEY_HEADER]: key, 'x-echo': key, location: `/echo?q=${key}` };
    return new Response(body, { headers: responseHeaders });
  };
  const spy = spyOn(globalThis, 'fetch').mockImplementation(probeFetch as typeof fetch);
  cleanups.push(() => { spy.mockRestore(); });

  //G 还没启动或已经停止时没有上游密钥，也不发出探针。
  const before = await app.inject(request);
  expect(before.statusCode).toBe(404);
  expect(forwarded).toHaveLength(0);
  ctx.programs.startConfigured();
  const first = await waitFor(() => ctx.programs.status()[0]!, 'ready');
  //G 主站放行未核验身份的远程浏览时，仍不能把进程密钥加进去。
  const anonymousRequest = { ...request, remoteAddress: '192.0.2.10' };
  const anonymous = await app.inject(anonymousRequest);
  expect(anonymous.statusCode).toBe(401);
  expect(forwarded).toHaveLength(0);

  const one = await app.inject(request);
  const initialKey = forwarded[0] ?? '';
  expect(initialKey !== '' && initialKey !== 'forged').toBe(true);
  expect(one.statusCode).toBe(200);
  expect(one.body === `前段${'*'.repeat(initialKey.length)}后段`).toBe(true);
  for (const name of [protocolModule.KEY_HEADER, 'x-echo', 'location']) {
    expect(Object.hasOwn(one.headers, name)).toBe(false);
  }
  const failure = await app.inject('/programs/fake/key-error');
  expect(failure.statusCode).toBe(503);
  expect(failure.json().error === '转发给 fake 失败').toBe(true);

  const restart = { method: 'POST' as const, url: '/api/programs/fake/restart' };
  const restarted = await app.inject(restart);
  expect(restarted.statusCode).toBe(200);
  await waitFor(() => ctx.programs.status()[0]!, 'ready', first.pid!);
  const two = await app.inject(request);
  const nextKey = forwarded[2] ?? '';
  expect(forwarded[1] === initialKey && nextKey !== '' && nextKey !== initialKey).toBe(true);
  expect(two.statusCode).toBe(200);
  expect(two.body === `前段${'*'.repeat(nextKey.length)}后段`).toBe(true);
  const log = path.join(root, 'data', 'logs', 'fake.log');
  const captured = fs.readFileSync(log, 'utf8');
  expect(captured.includes(initialKey) || captured.includes(nextKey)).toBe(false);

  const stop = { method: 'POST' as const, url: '/api/programs/fake/stop' };
  await app.inject(stop);
  const after = await app.inject(request);
  expect(after.statusCode).toBe(404);
  expect(forwarded).toHaveLength(3);
}, 12_000);

test('远程带有效主令牌才由界面代理注入密钥，伪造的头无法让远程通过', async () => {
  const token = 'fixture-main-token';
  const { app, ctx } = await getPlugin(getConfig(), [], token);
  ctx.programs.startConfigured();
  await waitFor(() => ctx.programs.status()[0]!, 'ready');

  const headers = { [protocolModule.KEY_HEADER]: 'forged' };
  const request = {
    method: 'POST' as const, url: '/programs/fake/echo', remoteAddress: '192.0.2.11',
    headers, payload: { text: '合成请求' },
  };
  //G 仅携带伪造程序头不能通过主站核验。
  const rejected = await app.inject(request);
  expect(rejected.statusCode).toBe(401);

  const authorizedHeaders = { ...headers, authorization: `Bearer ${token}` };
  const authorized = { ...request, headers: authorizedHeaders };
  const response = await app.inject(authorized);
  expect(response.statusCode).toBe(200);
  const echoed = response.json<{ headers: Record<string, string> }>();
  expect(Object.hasOwn(echoed.headers, 'authorization')).toBe(false);
  const publicKey = echoed.headers[protocolModule.KEY_HEADER] ?? '';
  //M 真正转到假程序的钥匙由代理过滤成星号，既验证发生注入也不输出实际值。
  expect(/^\*+$/u.test(publicKey)).toBe(true);
}, 12_000);

test('自己拉起的子进程被结束后，按默认三秒退避拉起一个新进程', async () => {
  const { host } = getHost([]);
  host.start();
  const first = await waitFor(() => host.status(), 'ready');
  const generation = host.getSendTarget()?.generation;
  const pid = first.pid!;

  //M 只结束这个用例的宿主刚刚创建并在状态里报告的子进程。
  const killedAt = performance.now();
  process.kill(pid, 'SIGKILL');
  const second = await waitFor(() => host.status(), 'ready', pid);
  expect(generation).toBeDefined();
  expect(host.getSendTarget()?.generation).not.toBe(generation);
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
