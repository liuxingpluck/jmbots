/** 离线验证设置路由的模型、机器人登记、探活、HTTP 关闭和基地重启事件。 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { registerHttpErrorHandler } from '../http/index.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as settings from './index.ts';


const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});


/** 挂真实设置路由和内存事件总线，配置与记忆全部写测试的临时目录。 */
async function setup(withBotReply = true, extraConfig: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-settings-test-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.yaml'), [
    'providers:',
    '  mock:',
    '    base_url: http://127.0.0.1:9',
    'default_model: mock/listed',
    'bots: []',
    ...extraConfig,
    '',
  ].join('\n'));

  const ctx = new cordis.Context();
  const app = fastify.default();
  //M 使用生产 HTTP 的统一错误响应。
  registerHttpErrorHandler(app);
  cleanups.push(() => app.close(), () => ctx.fiber.dispose());

  const bots = new Map<string, { memory: string }>();
  const known: Array<{ name: string }> = [];
  ctx.provide('resources', {
    root,
    raw: { bots: known },
    config: { providers: { mock: {} } },
    ensureRuntimeDir: (...segments: string[]) => {
      const target = path.join(root, ...segments);
      fs.mkdirSync(target, { recursive: true });
      return target;
    },
  });
  ctx.provide('http', { app });
  if (withBotReply) {
    //M 模拟机器人登记并返回新建的记忆目录，测试不调用机器人服务的方法。
    events.onRequestEvent(ctx, 'bot/request', 'bot/result', (request) => {
      if (request.action !== 'add') return { ok: false };

      const { name } = request.config;
      const memory = fs.mkdtempSync(path.join(root, 'bot-memory-'));
      const bot = { name, memory, workspace: root };
      bots.set(name, bot);
      known.push(request.config);
      return { ok: true, bot };
    });
  }
  await ctx.plugin(settings);
  return { ctx, app, bots, root };
}

test('设置页按插件名只读写五个已开放的插件字段', async () => {
  const { app, root } = await setup(true, [
    'plugins:',
    '  - name: programs',
    '    config: { private_note: do-not-show }',
    '  - name: image-gen',
    '    config:',
    '  - name: model-catalog',
    '    config:',
    '      fallback:',
    '        chain: [mock/listed] # 保留这行注释',
    '        cooldown_minutes: 41',
    '  - name: base-bridge',
    '    config: { index_url: "http://127.0.0.1:9", notify: true }',
  ]);

  const initial = await app.inject('/api/settings');
  expect(initial.json().config.plugins).toEqual({
    'base-bridge': { config: { index_url: 'http://127.0.0.1:9' } },
    'image-gen': { config: {} },
    'model-catalog': { config: { fallback: { chain: ['mock/listed'] } } },
  });
  const fallback = ['plugins', 'model-catalog', 'config', 'fallback'];
  const changes = [
    { path: ['plugins', 'base-bridge', 'config', 'index_url'], value: 'http://127.0.0.1:7' },
    { path: ['plugins', 'image-gen', 'config', 'image_model'], value: 'mock/image' },
    { path: [...fallback, 'chain'], value: ['mock/backup', 'mock/listed'] },
    { path: [...fallback, 'max_tries'], value: 0 },
    { path: [...fallback, 'include_siblings'], value: false },
  ];
  const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: changes });
  expect(saved.json()).toMatchObject({ ok: true });
  expect(saved.statusCode).toBe(200);
  const readBack = await app.inject('/api/settings');
  expect(readBack.json().config.plugins).toEqual({
    'base-bridge': { config: { index_url: 'http://127.0.0.1:7' } },
    'image-gen': { config: { image_model: 'mock/image' } },
    'model-catalog': { config: { fallback: {
      chain: ['mock/backup', 'mock/listed'],
      max_tries: 0,
      include_siblings: false,
    } } },
  });
  expect(readBack.json().config.engine).toBeUndefined();

  const file = path.join(root, 'config.yaml');
  const written = fs.readFileSync(file, 'utf8');
  expect(written).toContain('保留这行注释');
  expect(written).toContain('cooldown_minutes: 41');
  expect(written).toContain('private_note: do-not-show');
  for (const path of [
    ['plugins', 'programs', 'config', 'private_note'],
    [...fallback, 'cooldown_minutes'],
    ['plugins', 1, 'config', 'image_model'],
    [...fallback, 'chain', 0],
  ]) {
    const payload = [
      { path: [...fallback, 'max_tries'], value: 7 },
      { path, value: '未开放' },
    ];
    const denied = await app.inject({ method: 'PUT', url: '/api/settings', payload });
    expect(denied.statusCode).toBe(400);
    expect(denied.json<{ error: string }>().error).toContain('该插件字段不能从设置页修改');
  }
  expect(fs.readFileSync(file, 'utf8')).toBe(written);
});


test('shell 段能读能改：密钥遮住，改 shell.port 保留注释、BOM 和别的键', async () => {
  const { app, root } = await setup();
  const file = path.join(root, 'config.yaml');
  fs.writeFileSync(file, '﻿' + [
    'providers:',
    '  mock:',
    '    base_url: http://127.0.0.1:9',
    'default_model: mock/listed',
    'bots: []',
    'shell:',
    '  port: 30085 # 基地端口注释',
    '  token: SHELL_SECRET_TOKEN',
    '  libs: data/index/libs',
    '',
  ].join('\n'));

  const initial = await app.inject('/api/settings');
  expect(initial.body).not.toContain('SHELL_SECRET_TOKEN');
  const shell = initial.json().config.shell;
  expect(shell.port).toBe(30085);
  expect(shell.libs).toBe('data/index/libs');
  expect(shell.token).toMatch(/^‹已设置:[0-9a-f]{8}›$/u);

  const payload = [{ path: ['shell', 'port'], value: 30095 }];
  const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload });
  expect(saved.statusCode).toBe(200);
  const written = fs.readFileSync(file, 'utf8');
  expect(written.startsWith('﻿')).toBe(true);
  expect(written).toContain('port: 30095 # 基地端口注释');
  expect(written).toContain('token: SHELL_SECRET_TOKEN');
  expect(written).toContain('libs: data/index/libs');
});


/** relay、approval、memory、frpc 新开放字段用的插件段。 */
const PHASE2_PLUGINS = [
  'plugins:',
  '  - name: relay',
  '    config:',
  '      remind_minutes: 5 # 催促注释',
  '      helpers:',
  '        - name: Claude',
  '          prefixes: [cc]',
  '          webhook_header: "Bearer RELAY_SECRET_HEADER"',
  '        - name: Grok',
  '          prefixes: [gk]',
  '      owner_p2p_direct:',
  '        - { bot: 周小灵, helper: Claude }',
  '  - name: approval',
  '    config: { model: mock/listed }',
  '  - name: memory',
  '    config:',
  '      backend_token: MEMORY_SECRET_TOKEN',
  '      recall_history: 3',
  '      backfill:',
  '        enabled: false # 回填注释',
  '  - name: frpc',
];


test('relay、approval、memory、frpc 开放字段：读只给白名单，helpers 只给名字，改了保留注释和凭据', async () => {
  const { app, root } = await setup(true, PHASE2_PLUGINS);

  //M 读：凭据不出现，登记了没写字段的插件也给空视图。
  const initial = await app.inject('/api/settings');
  expect(initial.body).not.toContain('RELAY_SECRET_HEADER');
  expect(initial.body).not.toContain('MEMORY_SECRET_TOKEN');
  expect(initial.json().config.plugins).toEqual({
    relay: {
      config: { remind_minutes: 5, owner_p2p_direct: [{ bot: '周小灵', helper: 'Claude' }] },
      helpers: ['Claude', 'Grok'],
    },
    approval: { config: {} },
    memory: { config: { recall_history: 3, backfill: { enabled: false } } },
    frpc: { config: {} },
  });

  //M 改：每个新开放字段都写一次。
  const trustedDir = path.join(root, 'trusted');
  const frpcDir = path.join(root, 'frp-clients');
  const memory = ['plugins', 'memory', 'config'];
  const relay = ['plugins', 'relay', 'config'];
  const changes = [
    { path: [...relay, 'remind_minutes'], value: 0 },
    { path: [...relay, 'expire_minutes'], value: 30 },
    { path: [...relay, 'owner_p2p_direct'], value: [{ bot: '周小灵', helper: 'Grok' }] },
    { path: [...relay, 'owner_group_direct'], value: [{ chat_id: 'oc_1', bot: '周小灵', helper: 'Claude' }] },
    { path: [...relay, 'exclusive_bots'], value: [{ bot: '韩信', helper: 'Claude' }] },
    { path: ['plugins', 'approval', 'config', 'trusted_dirs'], value: [trustedDir] },
    { path: [...memory, 'history'], value: false },
    { path: [...memory, 'recall_knowledge'], value: 5 },
    { path: [...memory, 'service_url'], value: 'http://127.0.0.1:30087' },
    { path: [...memory, 'backend_timeout_ms'], value: 9000 },
    { path: [...memory, 'backfill', 'batch_size'], value: 50 },
    { path: [...memory, 'backfill', 'interval_ms'], value: 3000 },
    { path: ['plugins', 'frpc', 'config', 'dir'], value: frpcDir },
  ];
  const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: changes });
  expect(saved.statusCode).toBe(200);

  const readBack = await app.inject('/api/settings');
  expect(readBack.json().config.plugins).toEqual({
    relay: {
      config: {
        remind_minutes: 0,
        expire_minutes: 30,
        owner_p2p_direct: [{ bot: '周小灵', helper: 'Grok' }],
        owner_group_direct: [{ chat_id: 'oc_1', bot: '周小灵', helper: 'Claude' }],
        exclusive_bots: [{ bot: '韩信', helper: 'Claude' }],
      },
      helpers: ['Claude', 'Grok'],
    },
    approval: { config: { trusted_dirs: [trustedDir] } },
    memory: { config: {
      history: false,
      recall_history: 3,
      recall_knowledge: 5,
      service_url: 'http://127.0.0.1:30087',
      backend_timeout_ms: 9000,
      backfill: { enabled: false, batch_size: 50, interval_ms: 3000 },
    } },
    frpc: { config: { dir: frpcDir } },
  });

  //M 文件里：注释、凭据、没开放的键都还在。
  const written = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8');
  expect(written).toContain('催促注释');
  expect(written).toContain('回填注释');
  expect(written).toContain('Bearer RELAY_SECRET_HEADER');
  expect(written).toContain('backend_token: MEMORY_SECRET_TOKEN');
  expect(written).toContain('model: mock/listed');
});


test('relay、approval、memory、frpc 开放字段：值不对、越界、凭据字段一律 400，文件不变', async () => {
  const { app, root } = await setup(true, PHASE2_PLUGINS);
  const file = path.join(root, 'config.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const relay = ['plugins', 'relay', 'config'];
  const memory = ['plugins', 'memory', 'config'];
  const cases: [(string | number)[], unknown, string][] = [
    [[...relay, 'remind_minutes'], -1, '值类型不对'],
    [[...relay, 'expire_minutes'], 1.5, '值类型不对'],
    [[...relay, 'owner_p2p_direct'], [{ bot: '', helper: 'Claude' }], '值类型不对'],
    [[...relay, 'owner_p2p_direct'], [{ bot: ' 周小灵', helper: 'Claude' }], '值类型不对'],
    [[...relay, 'owner_p2p_direct'], [{ bot: '周小灵', helper: 'Nobody' }], '不在 relay 的 helpers 里'],
    [[...relay, 'exclusive_bots'], [{ bot: '韩信', helper: 'Claude' }, { bot: '韩信', helper: 'Grok' }], '写了两次'],
    [[...relay, 'owner_group_direct'], [{ bot: '周小灵', helper: 'Claude' }], '值类型不对'],
    [[...relay, 'helpers'], [], '该插件字段不能从设置页修改'],
    [[...relay, 'helpers', 0, 'webhook_header'], 'x', '该插件字段不能从设置页修改'],
    [['plugins', 'approval', 'config', 'trusted_dirs'], ['relative/dir'], '值类型不对'],
    [[...memory, 'backfill', 'batch_size'], 0, '值类型不对'],
    [[...memory, 'backfill', 'batch_size'], 101, '值类型不对'],
    [[...memory, 'backfill', 'interval_ms'], 0, '值类型不对'],
    [[...memory, 'service_url'], 'ftp://127.0.0.1', '值类型不对'],
    [[...memory, 'history'], 'yes', '值类型不对'],
    [[...memory, 'backend_token'], 'x', '该插件字段不能从设置页修改'],
    [['plugins', 'frpc', 'config', 'dir'], '  ', '值类型不对'],
    [['plugins', 'feishu', 'config', 'groups', 'oc_1', 'listen'], 'all', '请先在 config.yaml 登记插件 feishu'],
  ];
  for (const [stepPath, value, reason] of cases) {
    const payload = [{ path: stepPath, value }];
    const denied = await app.inject({ method: 'PUT', url: '/api/settings', payload });
    expect(denied.statusCode).toBe(400);
    expect(denied.json<{ error: string }>().error).toContain(reason);
  }
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});


test('飞书群策略：按 chat_id 只改 listen、trusted，同群其他字段和注释留着，app_secret 不回显', async () => {
  const { app, root } = await setup(true, [
    'channels:',
    '  feishu:',
    '    - app_id: cli_test',
    '      app_secret: FEISHU_APP_SECRET',
    'plugins:',
    '  - name: feishu',
    '    config:',
    '      groups:',
    '        - chat_id: oc_daily',
    '          name: 日报群',
    '          relay: model # 转话注释',
    '          judge_threshold: 0.7',
    '          daily: { hour: 9, minute: 0, bot: 周小灵, prompt: 写日报 }',
    '        - { chat_id: oc_plain, listen: judge, trusted: true }',
  ]);

  //M 读：listen 没写的照默认算（有 daily 是 all），密钥换成代号。
  const initial = await app.inject('/api/settings');
  expect(initial.body).not.toContain('FEISHU_APP_SECRET');
  expect(initial.json().config.plugins.feishu.config.groups).toEqual({
    oc_daily: { name: '日报群', listen: 'all', trusted: false },
    oc_plain: { name: '', listen: 'judge', trusted: true },
  });

  //M 改：日报群改 judge 并受信，另一个群删掉 listen 回默认。
  const groups = ['plugins', 'feishu', 'config', 'groups'];
  const changes = [
    { path: [...groups, 'oc_daily', 'listen'], value: 'judge' },
    { path: [...groups, 'oc_daily', 'trusted'], value: true },
    { path: [...groups, 'oc_plain', 'listen'], delete: true },
  ];
  const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: changes });
  expect(saved.statusCode).toBe(200);
  const readBack = await app.inject('/api/settings');
  expect(readBack.json().config.plugins.feishu.config.groups).toEqual({
    oc_daily: { name: '日报群', listen: 'judge', trusted: true },
    oc_plain: { name: '', listen: 'mention', trusted: true },
  });

  //M 文件里：同群的 relay、judge_threshold、daily 和注释都在，app_secret 原样。
  const file = path.join(root, 'config.yaml');
  const written = fs.readFileSync(file, 'utf8');
  expect(written).toContain('relay: model # 转话注释');
  expect(written).toContain('judge_threshold: 0.7');
  expect(written).toContain('prompt: 写日报');
  expect(written).toContain('app_secret: FEISHU_APP_SECRET');

  //M 不对的：值不对、群没登记、别的键、按下标改，一律 400，文件不变。
  const cases: [(string | number)[], unknown, string][] = [
    [[...groups, 'oc_daily', 'listen'], 'loud', 'listen 只能是'],
    [[...groups, 'oc_daily', 'trusted'], 'yes', '值类型不对'],
    [[...groups, 'oc_missing', 'listen'], 'all', '没在 feishu 插件的 groups 里登记'],
    [[...groups, 'oc_daily', 'relay'], 'direct', '该插件字段不能从设置页修改'],
    [[...groups, 0, 'listen'], 'all', '该插件字段不能从设置页修改'],
    [groups, [], '该插件字段不能从设置页修改'],
  ];
  for (const [stepPath, value, reason] of cases) {
    const payload = [{ path: stepPath, value }];
    const denied = await app.inject({ method: 'PUT', url: '/api/settings', payload });
    expect(denied.statusCode).toBe(400);
    expect(denied.json<{ error: string }>().error).toContain(reason);
  }
  expect(fs.readFileSync(file, 'utf8')).toBe(written);
});


/** 记录重启路径的进程操作，测试不拉起或退出实际进程。 */
function mockRestart(order: string[], supervised = false) {
  const original = process.env['JMBOTS_SUPERVISED'];
  delete process.env['JMBOTS_SUPERVISED'];
  if (supervised) {
    process.env['JMBOTS_SUPERVISED'] = '1';
  }
  const finished = Promise.withResolvers<void>();
  const exit = spyOn(process, 'exit').mockImplementation((() => {
    order.push('exit');
    finished.resolve();
  }) as typeof process.exit);
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => {
    order.push('spawn');
    return { pid: 123, unref: () => undefined };
  }) as unknown as typeof childProcess.spawn);
  cleanups.push(() => {
    exit.mockRestore();
    spawn.mockRestore();
    delete process.env['JMBOTS_SUPERVISED'];
    if (original !== undefined) {
      process.env['JMBOTS_SUPERVISED'] = original;
    }
  });
  return { spawn, exit, finished: finished.promise };
}


test('模型目录应答时校验模型，明确查不到则拒绝新建', async () => {
  const { ctx, app } = await setup();
  const models: string[] = [];
  events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (request) => {
    if (request.action !== 'find') return {};

    models.push(request.model);
    if (request.model !== 'mock/listed') return {};

    return {
      info: {
        id: request.model,
        name: '测试模型',
        kind: 'chat' as const,
        contextWindow: 128000,
        thinking: ['off'],
        price: { input: 0, output: 0 },
      },
    };
  });

  const listed = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: '在清单', model: 'mock/listed' } });
  expect(listed.statusCode).toBe(200);
  const missing = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: '缺型号', model: 'mock/missing' } });
  expect(missing.statusCode).toBe(400);
  expect(missing.json<{ error: string }>()).toEqual({ error: '模型清单里没有 mock/missing' });
  expect(models).toEqual(['mock/listed', 'mock/missing']);
});

test('没有模型目录应答时只校验供应商，两个并发新建保留各自记录', async () => {
  const { app } = await setup();
  const [first, second] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/bots', payload: { name: '机器人甲', model: 'mock/first' } }),
    app.inject({ method: 'POST', url: '/api/bots', payload: { name: '机器人乙', model: 'mock/second' } }),
  ]);
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);

  const response = await app.inject({ method: 'GET', url: '/api/settings' });
  expect(response.json().config.bots).toEqual(expect.arrayContaining([
    { name: '机器人甲', model: 'mock/first', language: 'zh' },
    { name: '机器人乙', model: 'mock/second', language: 'zh' },
  ]));

  const bad = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: '坏供应商', model: 'unknown/model' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json<{ error: string }>()).toEqual({ error: '模型 unknown/model 的供应商不在 providers 里' });
});

test('登记回执的记忆目录用于初始化索引', async () => {
  const { app, bots } = await setup();
  const payload = { name: '工作机器人', language: 'en', identity: '帮忙整理笔记' };
  const response = await app.inject({ method: 'POST', url: '/api/bots', payload });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, bot: { name: payload.name, language: payload.language } });

  const memory = bots.get(payload.name)?.memory;
  expect(memory).toBeDefined();
  const index = fs.readFileSync(path.join(memory!, 'index.md'), 'utf8');
  expect(index).toContain(payload.identity);
});

test('新建机器人无人应答时返回 503，并保留已保存的配置', async () => {
  const { app, bots } = await setup(false);
  const payload = { name: '待登记', language: 'zh' };
  const response = await app.inject({ method: 'POST', url: '/api/bots', payload });
  expect(response.statusCode).toBe(503);
  expect(response.json<{ error: string }>().error).toContain('配置已保存');
  expect(response.json<{ error: string }>().error).toContain('请重启后生效');
  expect(bots.has(payload.name)).toBe(false);

  const saved = await app.inject('/api/settings');
  expect(saved.json().config.bots).toEqual([payload]);
});

test('登记监听抛错时返回 504，并保留已保存的配置', async () => {
  const { ctx, app } = await setup(false);
  //M 模拟已接单但异常退出，路由应提示核对登记结果。
  events.onRequestEvent(ctx, 'bot/request', 'bot/result', () => {
    throw new Error('模拟登记中断');
  });
  const payload = { name: '登记待核对', language: 'zh' };
  const input = { method: 'POST', url: '/api/bots', payload } as const;
  //M 通过真实路由先写配置再请求登记。
  const response = await app.inject(input);
  expect(response.statusCode).toBe(504);
  expect(response.json().error).toContain('配置已保存，实时登记结果不确定');

  const url = '/api/settings';
  //G 写入的机器人配置仍可由设置接口读取。
  const saved = await app.inject(url);
  expect(saved.json().config.bots).toEqual([payload]);
});

test('基地重启无人应答或拒绝时返回错误，收到成功回执才报告重启', async () => {
  const { ctx, app } = await setup();
  const order: string[] = [];
  const restart = mockRestart(order, true);
  const input = { method: 'POST', url: '/api/service/restart' } as const;
  events.onRequestEvent(ctx, 'http/request', 'http/result', () => ({
    ok: true, statusCode: 200, body: '{"startedAt":42}',
  }));

  //M 基地没有监听时明示失败，释放入口让下一次请求可以重试。
  const unavailable = await app.inject(input);
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json<{ error: string }>().error).toContain('基地重启未获回执');

  let allow = false;
  events.onRequestEvent(ctx, 'base/request', 'base/result', (request) => {
    expect(request).toMatchObject({ method: 'POST', route: '/restart', body: {}, timeoutMs: 15_000 });
    if (!allow) return { ok: true, status: 404, body: { error: '基地未提供重启接口' } };

    return { ok: true, status: 200, body: { ok: true } };
  });
  const refused = await app.inject(input);
  expect(refused.statusCode).toBe(409);
  expect(refused.json<{ error: string }>()).toEqual({ error: '基地未提供重启接口' });

  allow = true;
  const accepted = await app.inject(input);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toMatchObject({ ok: true, startedAt: 42 });
  expect(restart.spawn).not.toHaveBeenCalled();
  expect(restart.exit).not.toHaveBeenCalled();
});

test('探活事件无人应答时返回错误，释放重启入口', async () => {
  const { ctx, app } = await setup();
  const order: string[] = [];
  const restart = mockRestart(order);
  const input = { method: 'POST', url: '/api/settings/apply' } as const;
  const unavailable = await app.inject(input);
  const retries = await app.inject(input);
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json().error).toContain('读取服务启动时间失败');
  expect(retries.statusCode).toBe(503);

  events.onRequestEvent(ctx, 'http/request', 'http/result', () => ({ ok: false, error: '模拟探活失败' }));
  const failed = await app.inject(input);
  expect(failed.statusCode).toBe(503);
  expect(failed.json<{ error: string }>()).toEqual({ error: '模拟探活失败' });
  expect(restart.spawn).not.toHaveBeenCalled();
  expect(restart.exit).not.toHaveBeenCalled();
});

test.each([
  { closeResult: { ok: true }, wants: ['inject', 'close', 'close-result', 'spawn', 'exit'] },
  { closeResult: undefined, wants: ['inject', 'close'], stopped: '无人处理 HTTP 关闭请求' },
  { closeResult: { ok: false, error: '关闭监听失败' }, wants: ['inject', 'close', 'close-result'], stopped: '关闭监听失败' },
])('只在确认关闭 HTTP 后继续重启', async ({ closeResult, wants, stopped }) => {
  const { ctx, app } = await setup();
  const order: string[] = [];
  const restart = mockRestart(order);
  const stoppedTrace = Promise.withResolvers<string>();
  ctx.on('trace', (name, text, _code, vars) => {
    if (name !== 'Settings.restart' || text !== 'trace.settings.restartCancelled') return;

    stoppedTrace.resolve(String(vars['reason']));
  });
  ctx.on('http/request', (request) => { order.push(request.action); });
  events.onRequestEvent(ctx, 'http/request', 'http/result', (request) => {
    if (request.action === 'close') {
      order.push('close-result');
      return closeResult ?? { ok: false };
    }
    expect(request).toMatchObject({ method: 'GET', url: '/api/ui/info' });
    return { ok: true, statusCode: 200, body: '{"startedAt":42}' };
  }, {
    filter: (request) => request.action === 'inject' || closeResult !== undefined,
  });

  const input = { method: 'POST', url: '/api/settings/apply' } as const;
  const response = await app.inject(input);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, startedAt: 42 });
  const duplicate = await app.inject(input);
  expect(duplicate.statusCode).toBe(409);

  //M 等关闭请求完成，再检查有没有创建替代进程。
  if (stopped === undefined) await restart.finished;
  if (stopped !== undefined) expect(await stoppedTrace.promise).toContain(stopped);
  expect(order).toEqual([...wants]);
}, 12_000);
