/**
 * 运行时变量全量原样（2026-11-17，用户 #52：调试插件不打码、不截断）：造一份带假密钥、假路径、假会话内容、假用户号、假微信资料的服务表，
 * 断言 /api/flow/state（自动遍历的“现在”）和 /api/flow/snapshot（启动、运行时拍的快照）交回的里面这些原值都原样在，
 * 数组项全在、深层全展开；只有循环写 [循环]、函数写 ƒ 名字、外部资源对象写 [类名]；点中一步能标出变了的。
 * 跑法：bun test ./src7/plugins/flow/State.test.ts。不起整个服务：假的 ctx（服务表照 Cordis 的 reflect.store 的样子），接口用真的 fastify inject 调。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as cordis from 'cordis';
import fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as snapshotModule from '../../utils/Snapshot.ts';
import * as flowModule from './index.ts';
import type { TrailLine } from './Trail.ts';


/** 微信 openid 的样子：o 开头 28 位。 */
const WX_OPENID = `o${'W'.repeat(27)}`;

/** 这些原值都要原样出现在接口返回里（插件登记的 REG-TOKEN、登记来的私密话只在“现在”里有，快照里另算）。 */
const RAW = [
  'sk-FAKE-KEY-123456',
  'HOOKTOKEN',
  'HEADER-SECRET',
  'ou_owner12345678',
  'ou_customer12345678',
  'oc_chat12345678',
  '这是机器人回的私密话',
  '用户说的私密话',
  'BOT-KEY-999',
  '/home/someone',
  'F:\\aidata\\private',
  'C:\\Users\\leon',
  'REG-TOKEN',
  '登记来的私密话',
  WX_OPENID,
  '微信昵称私密',
];


/** 测完要关的。 */
const apps: ReturnType<typeof fastify>[] = [];
const db = new Database(':memory:');
afterAll(async () => {
  for (const app of apps) await app.close();
  db.close();
});


/** 一场假会话：带聊天内容、用户号、回话地址，正在转。 */
const session = {
  id: '20261117093000123456',
  row: {
    id: '20261117093000123456',
    bot: '助手',
    kind: 'front',
    model: 'fake/echo',
    thinking: 'low',
    state: 'running',
    reply: '这是机器人回的私密话',
    customer: 'ou_customer12345678',
    address: { chatId: 'oc_chat12345678' },
    messages: [
      { role: 'user', content: '用户说的私密话' },
      { role: 'assistant', content: [{ type: 'text', text: '这是机器人回的私密话' }] },
    ],
    updatedAt: 1000,
  },
  inbox: [{ role: 'user', content: '用户说的私密话' }],
  aborter: new AbortController(),
};


/** 假 resources：配置里带密钥、webhook、用户号、本机路径。 */
const relayConfig = {
  helpers: [{ name: 'A', webhook_url: 'http://hook.example/x?token=HOOKTOKEN', webhook_header: 'Authorization: Bearer HEADER-SECRET' }],
  owner_open_ids: ['ou_owner12345678'],
  workdir: 'F:\\aidata\\private\\jm',
  note: '见 http://hook.example/doc?api_key=REG-TOKEN',
};
const resources = {
  root: '/home/someone/secret-place/jmbotsData',
  db,
  raw: { providers: { fake: { api_key: 'sk-FAKE-KEY-123456' } }, plugins: [{ name: 'relay', config: relayConfig }] },
  config: {
    defaultModel: 'fake/echo',
    maxSteps: 20,
    providers: {
      fake: { baseUrl: 'http://10.9.9.9/v1', apiKey: 'sk-FAKE-KEY-123456', api: 'openai-completions', models: { echo: { maxTokens: 4096 } } },
    },
    plugins: [{ name: 'relay', config: relayConfig }],
  },
  pluginStatus: [
    { name: 'relay', mounted: true, started: true, missing: [], error: '', inject: [] },
    { name: 'broken', mounted: false, started: false, missing: [], error: '读不到 C:\\Users\\leon\\x.yaml', inject: [] },
  ],
};


/** 一个插件的服务：大件、函数、循环、很深的、很长的、按微信号存的。 */
const demo: Record<string, unknown> = {
  ctx: new cordis.Context(),
  run: function runIt(): void {
    // 只看名字。
  },
  deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
  config: relayConfig,
  list: Array.from({ length: 40 }, (_item, index) => index),
  users: new Map([[WX_OPENID, { nickname: '微信昵称私密', 进来过: 3 }]]),
};
demo['self'] = demo;


/**
 * 服务表里的一项，照 Cordis 的 Impl 的样子。
 * @param name 服务名。
 * @param plugin 哪个插件提供的；空串当 Cordis 自带的（runtime 是 null）。
 * @param value 服务对象。
 */
function impl(name: string, plugin: string, value: unknown): unknown {
  return { name, value, ctx: { fiber: { name: plugin, runtime: plugin === '' ? null : {} } } };
}


/** 挂上 flow：交回 fastify、它提供的 ctx.flow、它挂的监听。 */
async function serve(journal?: unknown, config: flowModule.FlowConfig = {}): Promise<{
  app: ReturnType<typeof fastify>;
  flow: flowModule.FlowState;
  handlers: Record<string, (...args: unknown[]) => void>;
}> {
  const app = fastify();
  apps.push(app);
  const provided: { flow?: flowModule.FlowState } = {};
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const bots = {
    sends: new Map([['feishu', () => undefined]]),
    bots: new Map([['助手', { config: { name: '助手', api_key: 'BOT-KEY-999', workspace: '/home/someone/ws' } }]]),
  };
  const store = {
    [Symbol('logger')]: impl('logger', '', { secret: '自带的不看' }),
    [Symbol('resources')]: impl('resources', 'Resources', resources),
    [Symbol('tools')]: impl('tools', 'Tools', { specs: new Map([['read', { definition: { name: 'read' }, kinds: ['work'] }]]) }),
    [Symbol('sessions')]: impl('sessions', 'Sessions', { live: new Map([[session.id, session]]) }),
    [Symbol('bots')]: impl('bots', 'bots', bots),
    [Symbol('http')]: impl('http', 'http', { app }),
    [Symbol('demo')]: impl('demo', 'demo', demo),
  };
  const fake = {
    http: { app },
    resources,
    reflect: { store },
    events: { _hooks: {} },
    get: (name: string) => ({ bootTrail: boot, journal } as Record<string, unknown>)[name],
    provide: (_name: string, value: flowModule.FlowState) => {
      provided.flow = value;
      return () => undefined;
    },
    //M 同一个事件可以有几个监听（flow 听 internal/dispatch 的有 Shots 和认“谁发的”那个），照登记先后都调。
    on: (name: string, handler: (...args: unknown[]) => void) => {
      const before = handlers[name];
      handlers[name] = before === undefined ? handler : (...args: unknown[]) => {
        before(...args);
        handler(...args);
      };
      return () => undefined;
    },
  };
  //M 启动时拍的：照 boot-trail 的样子，第 1 行那一步拍的就是这个假 ctx 的一份。
  const boot = {
    lines: () => Promise.resolve([{ id: 1, at: 0, kind: '函数', name: 'base-tools', node: 'base-tools', listeners: [], text: '', site: '', sessionId: null, messageId: null, vars: {}, facts: {} }]),
    snapshot: (id: number) => (id === 1 ? { at: 0, groups: snapshotModule.snapshotOf(fake as unknown as cordis.Context) } : undefined),
  };
  flowModule.apply(fake as unknown as cordis.Context, config);
  await app.ready();
  return { app, flow: provided.flow!, handlers };
}


/**
 * 原值里哪些没出现（JSON 里反斜杠会转义，按转义后的样子找）。
 * @param body 接口返回的原文。
 * @param skip 这次不该有的（快照里没有插件登记的那组）。
 */
function missing(body: string, skip: string[] = []): string[] {
  return RAW.filter((raw) => !skip.includes(raw) && !body.includes(JSON.stringify(raw).slice(1, -1)));
}

/** 只在插件登记的那组里有的原值。 */
const REGISTERED_ONLY = ['REG-TOKEN', '登记来的私密话'];


describe('运行时变量', () => {
  test('/api/flow/state 自动读每个服务：密钥、路径、聊天内容、用户号、微信资料都原样在，全展开', async () => {
    const { app, flow } = await serve();

    //M 插件登记的变量也一样原样给。
    const read = () => ({ pending: 2, token: 'REG-TOKEN', last: { text: '登记来的私密话' }, dir: 'F:\\aidata\\private\\x' });
    const remove = flow.state('relay', read, { pending: '待回几条', dir: '目录' });

    const response = await app.inject({ method: 'GET', url: '/api/flow/state' });
    expect(response.statusCode).toBe(200);
    expect(missing(response.body)).toEqual([]);

    const groups = (response.json() as { groups: snapshotModule.StateGroup[] }).groups;
    const value = (name: string) => groups.find((item) => item.name === name)?.value as Record<string, unknown>;

    //M Cordis 自带的（logger）不看；顺序照服务表。
    expect(groups.map((item) => item.name)).toEqual(['main', 'resources', 'tools', 'sessions', 'bots', 'http', 'demo', 'relay']);
    expect(value('main')).toMatchObject({ candidate: false, pid: process.pid });

    //M 手写的键是英文，中文解释在 notes 里；服务对象自己的字段不用解释。
    const notesOf = (name: string) => groups.find((item) => item.name === name)?.notes;
    expect(notesOf('main')).toMatchObject({ argv: expect.any(String), candidate: expect.any(String), pid: '进程号' });
    expect(notesOf('relay')).toEqual({ pending: '待回几条', dir: '目录' });
    expect(notesOf('resources')).toEqual({});
    expect(value('resources')).toMatchObject({
      root: resources.root,
      db: '[Database]',
      config: { providers: { fake: { baseUrl: 'http://10.9.9.9/v1', apiKey: 'sk-FAKE-KEY-123456', models: { echo: { maxTokens: 4096 } } } } },
      pluginStatus: resources.pluginStatus,
    });
    expect(value('tools')).toMatchObject({ specs: { read: { kinds: ['work'] } } });

    //M 会话原样：row 里的聊天内容、用户号、回话地址都在；AbortController 没有自己的字段，写类名。
    expect(value('sessions')).toEqual({
      live: { [session.id]: { ...session, aborter: '[AbortController]' } },
    });
    expect(value('bots')).toEqual({ sends: { feishu: 'ƒ （匿名）' }, bots: { 助手: { config: { name: '助手', api_key: 'BOT-KEY-999', workspace: '/home/someone/ws' } } } });
    expect(value('http')).toEqual({ app: '[Fastify]' });

    //M 外部资源写类名、函数写 ƒ 名字、绕回自己写 [循环]；多深都展开、40 项全在、Map 转成对象（键原样）、配置原样。
    const shown = value('demo');
    expect(shown).toMatchObject({ ctx: '[Context]', run: 'ƒ runIt', self: '[循环]', deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } });
    expect(shown['config']).toEqual(relayConfig);
    expect(shown['list']).toEqual(Array.from({ length: 40 }, (_item, index) => index));
    expect(shown['users']).toEqual({ [WX_OPENID]: { nickname: '微信昵称私密', 进来过: 3 } });

    expect(value('relay')).toEqual(read());

    //M 撤掉登记后就没有这组了。
    remove();
    const again = (await app.inject({ method: 'GET', url: '/api/flow/state' })).json() as { groups: snapshotModule.StateGroup[] };
    expect(again.groups.some((item) => item.name === 'relay')).toBe(false);
  });

  test('快照：带 #调试 的消息拍了、关键词被去掉；不带的没拍；点中一步交回那一刻的、标出比上一步变了的', async () => {
    //M journal 记下的行：按消息号找“收件表收下”那行，再从那一号往后取。
    const lines: TrailLine[] = [];
    const journal = {
      query: () => [],
      request: (message: number) => {
        const start = lines.find((line) => line.name === 'web-api/received' && line.messageId === message);
        return start === undefined ? undefined : lines.filter((line) => line.id >= start.id);
      },
    };
    const { app, handlers } = await serve(journal);

    //M 消息 7 带关键词，照真实的先后：web-api 收下（发 web-api/received，flow 认出关键词、拍一份），journal 记一行；
    //M   机器人收到（bot/receive，flow 排最前、去掉关键词），管分派的插件填上会话；会话状态变了，再来一个跟踪点（flow 认出会话、拍一份）。
    handlers['internal/dispatch']?.('emit', 'web-api/received', [{ id: 7, text: '你好 #调试' }]);
    lines.push({ id: 1, at: Date.now(), kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 7, vars: {} });
    const receive: { message: { text: string }; session?: { id: string } } = { message: { text: '你好 #调试' } };
    handlers['bot/receive']?.(receive);
    expect(receive.message.text).toBe('你好');
    receive.session = { id: session.id };
    session.row.state = 'done';
    handlers['trace']?.('Bots.receive', '交给会话', '', { 会话: session.id });
    lines.push({ id: 2, at: Date.now(), kind: '函数', name: 'Bots.receive', listeners: [], text: '交给会话', site: 'src7/plugins/bots/index.ts:5', sessionId: session.id, messageId: null, vars: { 会话: session.id } });

    //M 消息 8 不带关键词：一份都不拍，接口说没有快照。
    handlers['internal/dispatch']?.('emit', 'web-api/received', [{ id: 8, text: '普通的话' }]);
    lines.push({ id: 3, at: Date.now(), kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 8, vars: {} });
    const plain: { message: { text: string } } = { message: { text: '普通的话' } };
    handlers['bot/receive']?.(plain);
    expect(plain.message.text).toBe('普通的话');
    handlers['trace']?.('Bots.receive', '交给会话', '', { 会话: 'other-session' });
    lines.push({ id: 4, at: Date.now(), kind: '函数', name: 'Bots.receive', listeners: [], text: '交给会话', site: 'src7/plugins/bots/index.ts:5', sessionId: 'other-session', messageId: null, vars: { 会话: 'other-session' } });
    for (const no of [1, 2]) {
      const none = await app.inject({ method: 'GET', url: `/api/flow/snapshot?message=8&step=${String(no)}` });
      expect(none.statusCode).toBe(404);
      expect((none.json() as { error: string }).error).toContain('没带 #调试');
    }

    const second = await app.inject({ method: 'GET', url: '/api/flow/snapshot?message=7&step=2' });
    expect(second.statusCode).toBe(200);
    expect(missing(second.body, REGISTERED_ONLY)).toEqual([]);
    const shot = second.json() as { no: number; node: string; groups: snapshotModule.StateGroup[]; changed: string[][] };
    expect(shot).toMatchObject({ no: 2, node: 'bots' });
    expect(shot.changed).toEqual([['sessions', 'live', session.id, 'row', 'state']]);
    expect(shot.groups.find((item) => item.name === 'sessions')?.value).toMatchObject({ live: { [session.id]: { row: { state: 'done' } } } });

    //M 第 1 步前面没有可比的。
    const first = (await app.inject({ method: 'GET', url: '/api/flow/snapshot?message=7&step=1' })).json() as { changed: unknown };
    expect(first.changed).toBeNull();

    //M 启动那份（message=0）。
    const boot = await app.inject({ method: 'GET', url: '/api/flow/snapshot?message=0&step=1' });
    expect(boot.statusCode).toBe(200);
    expect(missing(boot.body, REGISTERED_ONLY)).toEqual([]);

    //M 没有的步、乱给的参数。
    expect((await app.inject({ method: 'GET', url: '/api/flow/snapshot?message=7&step=9' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/flow/snapshot?message=x&step=1' })).statusCode).toBe(400);
    session.row.state = 'running';
  });

  test('快照关键词：不写是 #调试（/api/flow/graph 交给网页），写了空串挂不上；接着已有会话发的 mark 同样去掉关键词', async () => {
    const { app, flow } = await serve();
    const graph = (await app.inject({ method: 'GET', url: '/api/flow/graph' })).json() as { snapshotKeyword: string };
    expect(graph.snapshotKeyword).toBe('#调试');
    expect(() => flowModule.apply({} as unknown as cordis.Context, { snapshot_keyword: ' ' })).toThrow('snapshot_keyword');
    expect(() => flowModule.apply({} as unknown as cordis.Context, { snapshot_max_mb: 0 })).toThrow('snapshot_max_mb');

    //M web-api 走 Bot.hand 那条路调 ctx.flow.mark：带关键词的去掉，不带的原样。
    expect(flow.mark('接着查 #调试', 'some-session')).toBe('接着查');
    expect(flow.mark('接着查', 'some-session')).toBe('接着查');
    expect(() => flowModule.apply({} as unknown as cordis.Context, { snapshot_files: 1.5 })).toThrow('snapshot_files');
  });

  test('快照写成文件：带 #调试 的消息停拍后写 data/flow/<消息号>.json（含每步快照），超过 snapshot_files 删最旧的；启动走完写 boot.json', async () => {
    //M 运行时目录换成临时目录，测完还原、删掉。
    const realRoot = resources.root;
    resources.root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-files-'));
    const dir = path.join(resources.root, 'data', 'flow');

    const lines: TrailLine[] = [];
    const journal = {
      query: () => [],
      request: (message: number) => {
        const start = lines.find((line) => line.name === 'web-api/received' && line.messageId === message);
        return start === undefined ? undefined : lines.filter((line) => line.id >= start.id);
      },
    };
    const { handlers } = await serve(journal, { snapshot_files: 2 });

    //M 三条带关键词的消息：收下、回话写回（web-api/replied 照真实的样子带着会话对象）就停拍，后台写文件。
    for (const id of [21, 22, 23]) {
      handlers['internal/dispatch']?.('emit', 'web-api/received', [{ id, text: '查一下 #调试' }]);
      const receivedLine = { id: lines.length + 1, at: Date.now(), kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: id, vars: {} };
      lines.push(receivedLine);

      handlers['internal/dispatch']?.('emit', 'web-api/replied', [{ messageId: id, session, text: '好' }]);
      const repliedLine = { id: lines.length + 1, at: Date.now(), kind: '事件', name: 'web-api/replied', listeners: [], text: '', site: 'src7/plugins/web-api/Timeline.ts:305', sessionId: session.id, messageId: id, vars: {} };
      lines.push(repliedLine);

      await Bun.sleep(60);
    }

    //M 只留最近 2 个，最旧的 21 删了。
    expect(fs.readdirSync(dir).sort()).toEqual(['22.json', '23.json']);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '23.json'), 'utf8')) as {
      message: number;
      steps: unknown[];
      notes: Record<string, string>;
      snapshots: ({ groups: snapshotModule.StateGroup[] } | null)[];
    };
    expect(saved.message).toBe(23);
    expect(saved.snapshots).toHaveLength(saved.steps.length);
    expect(saved.snapshots[0]?.groups.map((item) => item.name)).toContain('sessions');
    expect(Object.keys(saved.notes).length).toBeGreaterThan(0);
    expect(missing(JSON.stringify(saved), REGISTERED_ONLY)).toEqual([]);

    //M 启动走完（boot-trail 发 boot-trail/done）写 boot.json，不算在消息文件的个数里。
    handlers['boot-trail/done']?.();
    await Bun.sleep(60);
    expect(fs.readdirSync(dir).sort()).toEqual(['22.json', '23.json', 'boot.json']);
    const bootSaved = JSON.parse(fs.readFileSync(path.join(dir, 'boot.json'), 'utf8')) as { message: number; snapshots: unknown[] };
    expect(bootSaved.message).toBe(0);
    expect(bootSaved.snapshots[0]).not.toBeNull();

    fs.rmSync(resources.root, { recursive: true, force: true });
    resources.root = realRoot;
  });

  test('遍历的几种记号、比差异', () => {
    const value = { url: 'https://x.example/a?token=abc', apiKey: 'k', set: new Set([1, 2]), gone: undefined, big: 10n };
    expect(snapshotModule.walkState(value)).toEqual({ url: 'https://x.example/a?token=abc', apiKey: 'k', set: [1, 2], gone: null, big: '10' });
    expect(snapshotModule.walkState(new AbortController())).toBe('[AbortController]');
    expect(snapshotModule.walkState({ get later() { return 1; } })).toEqual({ later: '[getter]' });
    expect(snapshotModule.diffOf({ a: 1, b: { c: 2 }, e: 0 }, { a: 1, b: { c: 3 }, d: 1 })).toEqual([['b', 'c'], ['e'], ['d']]);
  });
});
