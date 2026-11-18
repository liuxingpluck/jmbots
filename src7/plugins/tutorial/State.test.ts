/**
 * tutorial 的接口（2026-11-17 用户 #52：调试插件不打码、不截断；11-17 由 flow 的测试搬过来）：
 * 造一份带假密钥、假路径、假会话内容、假用户号、假微信资料的服务表，断言
 *   /api/tutorial/state（插件现在的运行时变量）、/api/tutorial/snapshot（启动、带 #调试 的消息拍的快照）交回的这些原值都原样在，
 *   数组项全在、深层全展开；只有循环写 [循环]、函数写 ƒ 名字、外部资源对象写 [类名]；点中一步能标出变了的；
 *   快照写成文件，左栏「画布」列出来，点开交回轨迹和泳道图；/flow/ 跳到 /tutorial/。
 * 跑法：bun test ./src7/plugins/tutorial。不起整个服务：假的 ctx（服务表照 Cordis 的 reflect.store 的样子），接口用真的 fastify inject 调。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as cordis from 'cordis';
import fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as requestEvents from '../../utils/RequestEvent.ts';
import * as snapshotModule from '../../utils/Snapshot.ts';
import * as tutorialModule from './index.ts';
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
const buses: cordis.Context[] = [];
const db = new Database(':memory:');
afterAll(async () => {
  for (const app of apps) await app.close();
  for (const bus of buses) await bus.fiber.dispose();
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
    thinking: 'low',
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
  let runtime: object | null = {};
  if (plugin === '') {
    runtime = null;
  }
  return { name, value, ctx: { fiber: { name: plugin, runtime } } };
}


/**
 * 挂上 tutorial：交回 fastify、它提供的 ctx.flow、它挂的监听。
 * @param journal 假的 journal；不给当没挂。
 * @param config tutorial 的配置。
 */
async function serve(journal?: ReturnType<typeof getJournal>, config: tutorialModule.TutorialConfig = {}): Promise<{
  app: ReturnType<typeof fastify>;
  flow: tutorialModule.FlowState;
  handlers: Record<string, (...args: unknown[]) => void>;
}> {
  const app = fastify();
  apps.push(app);
  const bus = new cordis.Context();
  buses.push(bus);
  if (journal !== undefined) {
    requestEvents.onRequestEvent(bus, 'journal/request', 'journal/result', (request) => {
      if (request.action === 'query') return { ok: true, lines: journal.query(request.params) };
      if (request.action === 'message-lines') return { lines: journal.request(request.message, request.limit) };

      return {};
    });
  }
  const provided: { flow?: tutorialModule.FlowState } = {};
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

  //M 录启动要的 fiber：父亲是根 fiber（相当于 config.yaml 里写的插件）。
  const root = { name: 'root' };
  const fake: Record<string, unknown> = {
    http: { app },
    resources,
    sessions: { find: () => [] },
    reflect: { store },
    events: { _hooks: {} },
    fiber: { uid: 1, name: 'tutorial', parent: { fiber: root } },
    get: () => undefined,
    serial: bus.serial.bind(bus),
    provide: (_name: string, value: tutorialModule.FlowState) => {
      provided.flow = value;
      return () => undefined;
    },
    //M 同一个事件可以有几个监听（trace 有录启动和拍快照两个），照登记先后都调。
    on: (name: string, handler: (...args: unknown[]) => void) => {
      if (name === 'journal/result') return bus.on(name, handler);

      const before = handlers[name];
      handlers[name] = handler;
      if (before !== undefined) {
        handlers[name] = (...args: unknown[]) => {
          before(...args);
          handler(...args);
        };
      }
      return () => undefined;
    },
  };
  //M http 已经在：等 http 的回调当场调。
  fake['inject'] = (_deps: string[], callback: (sub: unknown) => void) => {
    callback(fake);
    return Promise.resolve();
  };
  tutorialModule.apply(fake as unknown as cordis.Context, config);
  await app.ready();
  return { app, flow: provided.flow!, handlers };
}


/**
 * 原值里哪些没出现（JSON 里反斜杠会转义，按转义后的样子找）。
 * @param body 接口返回的原文。
 * @param skip 这次不该有的（快照里没有插件登记的那组）。
 */
function getMissing(body: string, skip: string[] = []): string[] {
  return RAW.filter((raw) => !skip.includes(raw) && !body.includes(JSON.stringify(raw).slice(1, -1)));
}

/** 只在插件登记的那组里有的原值。 */
const REGISTERED_ONLY = ['REG-TOKEN', '登记来的私密话'];


/**
 * 假的 journal：按消息号找“收件表收下”那行，再从那一号往后取。
 * @param lines 记下的行，测试里往里推。
 */
function getJournal(lines: TrailLine[]) {
  const toJournalLine = (line: TrailLine) => ({
    ...line,
    kind: line.kind as '事件' | '函数',
    bot: null,
    code: '',
    mode: '',
  });
  return {
    query: (params: Record<string, string | undefined>) => {
      const name = params['name'];
      const limit = Number.parseInt(params['limit'] ?? '200', 10);
      let matched = lines;
      if (name !== undefined && name !== '') {
        matched = lines.filter((line) => line.name === name);
      }
      return matched.slice(-limit).map(toJournalLine);
    },
    request: (message: number, limit: number) => {
      const start = lines.find((line) => line.name === 'web-api/received' && line.messageId === message);
      if (start === undefined) return undefined;

      return lines.filter((line) => line.id >= start.id).slice(0, limit).map(toJournalLine);
    },
  };
}


describe('运行时变量', () => {
  test('/api/tutorial/state：全部，或只看一个插件；密钥、路径、聊天内容、用户号、微信资料都原样在，全展开', async () => {
    const { app, flow } = await serve();

    //M 插件登记的变量也一样原样给。
    const read = () => ({ pending: 2, token: 'REG-TOKEN', last: { text: '登记来的私密话' }, dir: 'F:\\aidata\\private\\x' });
    const remove = flow.state('relay', read, { pending: '待回几条', dir: '目录' });

    const response = await app.inject({ method: 'GET', url: '/api/tutorial/state?name=' });
    expect(response.statusCode).toBe(200);
    expect(getMissing(response.body)).toEqual([]);

    const groups = (response.json() as { groups: snapshotModule.StateGroup[] }).groups;
    const value = (name: string) => groups.find((item) => item.name === name)?.value as Record<string, unknown>;

    //M Cordis 自带的（logger）不看；顺序照服务表，插件登记的在最后。
    expect(groups.map((item) => item.name)).toEqual(['main', 'resources', 'tools', 'sessions', 'bots', 'http', 'demo', 'relay']);
    expect(value('main')).toMatchObject({ candidate: false, pid: process.pid });

    //M 手写的键是英文，中文解释在 notes 里；服务对象自己的字段不用解释。
    const notesOf = (name: string) => groups.find((item) => item.name === name)?.notes;
    expect(notesOf('relay')).toEqual({ pending: '待回几条', dir: '目录' });
    expect(notesOf('resources')).toEqual({});
    expect(value('resources')).toMatchObject({
      root: resources.root,
      db: '[Database]',
      config: { providers: { fake: { baseUrl: 'http://10.9.9.9/v1', apiKey: 'sk-FAKE-KEY-123456', models: { echo: { maxTokens: 4096 } } } } },
      pluginStatus: resources.pluginStatus,
    });

    //M 会话原样：row 里的聊天内容、用户号、回话地址都在；AbortController 没有自己的字段，写类名。
    expect(value('sessions')).toEqual({
      live: { [session.id]: { ...session, aborter: '[AbortController]' } },
    });
    expect(value('http')).toEqual({ app: '[Fastify]' });

    //M 外部资源写类名、函数写 ƒ 名字、绕回自己写 [循环]；多深都展开、40 项全在、Map 转成对象（键原样）、配置原样。
    const shown = value('demo');
    expect(shown).toMatchObject({ ctx: '[Context]', run: 'ƒ runIt', self: '[循环]', deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } });
    expect(shown['config']).toEqual(relayConfig);
    expect(shown['list']).toEqual(Array.from({ length: 40 }, (_item, index) => index));
    expect(shown['users']).toEqual({ [WX_OPENID]: { nickname: '微信昵称私密', 进来过: 3 } });
    expect(value('relay')).toEqual(read());

    //M 只看一个插件：demo 只有它提供的服务；relay 只有它登记的那组。
    const demoOnly = (await app.inject({ method: 'GET', url: '/api/tutorial/state?name=demo' })).json() as { groups: snapshotModule.StateGroup[] };
    expect(demoOnly.groups.map((item) => item.name)).toEqual(['demo']);
    const relayOnly = (await app.inject({ method: 'GET', url: '/api/tutorial/state?name=relay' })).json() as { groups: snapshotModule.StateGroup[] };
    expect(relayOnly.groups.map((item) => item.name)).toEqual(['relay']);

    //M 撤掉登记后就没有这组了。
    remove();
    const again = (await app.inject({ method: 'GET', url: '/api/tutorial/state?name=' })).json() as { groups: snapshotModule.StateGroup[] };
    expect(again.groups.some((item) => item.name === 'relay')).toBe(false);
  });

  test('flow/state 通知：带 read 登记一组（同 ctx.flow.state），不带 read 注销；注销没登记过的组不出错', async () => {
    const { app, handlers } = await serve();
    const notify = handlers['flow/state'];
    expect(notify).toBeDefined();

    //M 登记：「状态」标签按组名归到 relay 下面，值和解释原样。
    const read = () => ({ pending: 1, token: 'REG-TOKEN' });
    notify?.({ name: 'relay', read, notes: { pending: '待回几条' } });
    const url = '/api/tutorial/state?name=relay';
    const shown = (await app.inject({ method: 'GET', url })).json() as { groups: snapshotModule.StateGroup[] };
    expect(shown.groups.map((item) => item.name)).toEqual(['relay']);
    expect(shown.groups[0]?.value).toEqual(read());
    expect(shown.groups[0]?.notes).toEqual({ pending: '待回几条' });

    //M 注销没登记过的组：什么也不发生，relay 那组还在。
    notify?.({ name: 'no-such' });
    const kept = (await app.inject({ method: 'GET', url })).json() as { groups: snapshotModule.StateGroup[] };
    expect(kept.groups.map((item) => item.name)).toEqual(['relay']);

    //M 注销 relay：这组没了。
    notify?.({ name: 'relay' });
    const gone = (await app.inject({ method: 'GET', url })).json() as { groups: snapshotModule.StateGroup[] };
    expect(gone.groups).toEqual([]);
  });

  test('快照：带 #调试 的消息拍了、关键词被去掉；不带的没拍；点中一步交回那一刻的、标出比上一步变了的；启动的也有', async () => {
    const lines: TrailLine[] = [];
    const { app, handlers } = await serve(getJournal(lines));

    //M 消息 7 带关键词，照真实的先后：web-api 收下（发 web-api/received，认出关键词、拍一份），journal 记一行；
    //M   机器人收到（bot/receive，排最前、去掉关键词），管分派的插件填上会话；会话状态变了，再来一个跟踪点（认出会话、拍一份）。
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
      const none = await app.inject({ method: 'GET', url: `/api/tutorial/snapshot?name=8&step=${String(no)}` });
      expect(none.statusCode).toBe(404);
      expect((none.json() as { error: string }).error).toContain('没带 #调试');
    }

    //M 消息 7 第 2 步：那一刻的会话状态是 done，比第 1 步变了这一处。
    const second = await app.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=7&step=2' });
    expect(second.statusCode).toBe(200);
    expect(getMissing(second.body, REGISTERED_ONLY)).toEqual([]);
    const shot = second.json() as { no: number; node: string; groups: snapshotModule.StateGroup[]; changed: string[][] };
    expect(shot).toMatchObject({ no: 2, node: 'bots' });
    expect(shot.changed).toEqual([['sessions', 'live', session.id, 'row', 'state']]);

    //M 第 1 步前面没有可比的。
    const first = (await app.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=7&step=1' })).json() as { changed: unknown };
    expect(first.changed).toBeNull();

    //M 启动那份：录启动挂上时拍的，原值都在。
    const boot = await app.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=boot&step=1' });
    expect(boot.statusCode).toBe(200);
    expect(getMissing(boot.body, REGISTERED_ONLY)).toEqual([]);

    //M 没有的步、乱给的参数。
    expect((await app.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=7&step=9' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=x&step=1' })).statusCode).toBe(400);
    session.row.state = 'running';
  });

  test('配置：关键词不写是 #调试，写错的挂不上；接着已有会话发的 mark 同样去掉关键词；/flow/ 跳到 /tutorial/', async () => {
    const { app, flow } = await serve();
    const canvases = (await app.inject({ method: 'GET', url: '/api/tutorial/canvases' })).json() as { keyword: string };
    expect(canvases.keyword).toBe('#调试');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { snapshot_keyword: ' ' })).toThrow('snapshot_keyword');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { snapshot_max_mb: 0 })).toThrow('snapshot_max_mb');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { snapshot_files: 1.5 })).toThrow('snapshot_files');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { trace_console: 'yes' })).toThrow('trace_console');

    //M web-api 走 Bot.hand 那条路调 ctx.flow.mark：带关键词的去掉，不带的原样。
    expect(flow.mark('接着查 #调试', 'some-session')).toBe('接着查');
    expect(flow.mark('接着查', 'some-session')).toBe('接着查');

    //M 原来 /flow/ 的链接（主网页事件面板开的）带着查询参数跳过去。
    const moved = await app.inject({ method: 'GET', url: '/flow/?message=5&session=s1' });
    expect(moved.statusCode).toBe(302);
    expect(moved.headers['location']).toBe('/tutorial/?message=5&session=s1');

    //M 说明：没写的插件给空串；插件名不对 400。
    const readme = (await app.inject({ method: 'GET', url: '/api/tutorial/readme?name=no-such-plugin' })).json() as { text: string };
    expect(readme.text).toBe('');
    expect((await app.inject({ method: 'GET', url: '/api/tutorial/readme?name=../x' })).statusCode).toBe(400);
  });

  test('快照写成文件：消息停拍后写 <消息号>.json，超过 snapshot_files 删最旧的；HTTP 开始监听后写 boot.json；画布列出来、点开有泳道图', async () => {
    //M 运行时目录换成临时目录，测完还原、删掉。
    const realRoot = resources.root;
    resources.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-files-'));
    const dir = path.join(resources.root, 'data', 'flow');

    const lines: TrailLine[] = [];
    const { app, handlers } = await serve(getJournal(lines), { snapshot_files: 2 });

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
    expect(getMissing(JSON.stringify(saved), REGISTERED_ONLY)).toEqual([]);

    //M HTTP 开始监听（http 插件发的跟踪点）：录启动记完这步写 boot.json，不算在消息文件的个数里。
    handlers['trace']?.('Http.listen', 'HTTP 服务开始监听', 'app.listen()', { 地址: '0.0.0.0', 端口: 30086, 有令牌: true });
    await Bun.sleep(200);
    expect(fs.readdirSync(dir).sort()).toEqual(['22.json', '23.json', 'boot.json']);
    const bootSaved = JSON.parse(fs.readFileSync(path.join(dir, 'boot.json'), 'utf8')) as { message: number; snapshots: unknown[] };
    expect(bootSaved.message).toBe(0);
    expect(bootSaved.snapshots[0]).not.toBeNull();

    //M 左栏画布：启动在最前，消息新的在前。
    const canvases = (await app.inject({ method: 'GET', url: '/api/tutorial/canvases' })).json() as { list: { name: string }[] };
    expect(canvases.list.map((item) => item.name)).toEqual(['boot', '23', '22']);

    //M 点开一张：从文件读回轨迹（不带每步快照），摆成泳道图；点中一步的快照从文件里取。
    const canvas = (await app.inject({ method: 'GET', url: '/api/tutorial/canvas?name=23' })).json() as {
      trail: { message: number; snapshots?: unknown };
      lanes: { columns: string[] };
    };
    expect(canvas.trail.message).toBe(23);
    expect(canvas.trail.snapshots).toBeUndefined();
    expect(canvas.lanes.columns).toEqual(['存', '回复']);
    const fromFile = await app.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=23&step=1' });
    expect(fromFile.statusCode).toBe(200);

    //M 启动那张：骨架四步、tutorial 自己、HTTP 监听，摆进加载、服务就绪、开始监听。
    const bootCanvas = (await app.inject({ method: 'GET', url: '/api/tutorial/canvas?name=boot' })).json() as {
      lanes: { columns: string[]; lanes: string[] };
    };
    expect(bootCanvas.lanes.columns).toEqual(['加载（apply）', '服务就绪（inject）', '开始监听']);
    expect(bootCanvas.lanes.lanes).toEqual(['main', 'resources', 'tools', 'sessions', 'tutorial', 'http']);

    //M 流水没监听时仍能读到已有文件，新画布和步骤都按缺失处理。
    const { app: offline, handlers: offlineHandlers } = await serve();
    const fallback = (await offline.inject({ method: 'GET', url: '/api/tutorial/canvases' })).json() as {
      messages: { name: string }[];
    };
    expect(fallback.messages.map((item) => item.name)).toEqual(['23', '22']);
    expect((await offline.inject({ method: 'GET', url: '/api/tutorial/canvas?name=23' })).statusCode).toBe(200);
    expect((await offline.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=23&step=1' })).statusCode).toBe(200);
    expect((await offline.inject({ method: 'GET', url: '/api/tutorial/canvas?name=99' })).statusCode).toBe(404);
    expect((await offline.inject({ method: 'GET', url: '/api/tutorial/snapshot?name=99&step=1' })).statusCode).toBe(404);

    //M 无流水回执时无法写新快照，已有快照文件仍保留。
    offlineHandlers['internal/dispatch']?.('emit', 'web-api/received', [{ id: 99, text: '离线消息 #调试' }]);
    offlineHandlers['internal/dispatch']?.('emit', 'web-api/replied', [{ messageId: 99, session, text: '好' }]);
    await Bun.sleep(60);
    expect(fs.readdirSync(dir).sort()).toEqual(['22.json', '23.json', 'boot.json']);

    fs.rmSync(resources.root, { recursive: true, force: true });
    resources.root = realRoot;
  });

  test('会话画布不限 #调试：recent_messages 按消息号去重列最近消息并标快照，校验配置', async () => {
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { recent_messages: 0 })).toThrow('recent_messages');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { recent_messages: 1.5 })).toThrow('recent_messages');

    const realRoot = resources.root;
    resources.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-recent-'));
    const lines: TrailLine[] = [];
    const { app, handlers } = await serve(getJournal(lines), { recent_messages: 3 });

    //M 31 号普通消息重复两条 web-api/received，用来测去重和 recent_messages 截断。
    const baseAt = Date.now();
    lines.push({ id: 1, at: baseAt, kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 31, vars: {} });
    lines.push({ id: 2, at: baseAt + 1, kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 31, vars: {} });

    //M 32 号带 #调试（内存有快照），33、34 号普通消息不带 #调试；32 带上渠道与机器人名。
    handlers['internal/dispatch']?.('emit', 'web-api/received', [{ id: 32, text: '帮我查一下 #调试' }]);
    lines.push({ id: 3, at: baseAt + 10, kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 32, vars: {} });
    lines.push({ id: 4, at: baseAt + 11, kind: '函数', name: 'Bots.receive', listeners: [], text: '收到', site: 'src7/plugins/bots/index.ts:10', sessionId: 's32', messageId: 32, vars: { 渠道: 'feishu', 机器人: '周小灵' } });
    lines.push({ id: 5, at: baseAt + 12, kind: '事件', name: 'session/message', listeners: [], text: '', site: 'src7/Sessions.ts:10', sessionId: 's32', messageId: 32, vars: { 角色: 'user', 说了: '帮我查一下' } });

    lines.push({ id: 6, at: baseAt + 20, kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 33, vars: {} });
    lines.push({ id: 7, at: baseAt + 20, kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 33, vars: {} });
    lines.push({ id: 8, at: baseAt + 21, kind: '事件', name: 'session/message', listeners: [], text: '', site: 'src7/Sessions.ts:10', sessionId: 's33', messageId: 33, vars: { 角色: 'user', 说了: '普通消息三十三' } });

    lines.push({ id: 9, at: baseAt + 30, kind: '事件', name: 'web-api/received', listeners: [], text: '', site: 'src7/plugins/web-api/index.ts:10', sessionId: null, messageId: 34, vars: {} });
    lines.push({ id: 10, at: baseAt + 31, kind: '事件', name: 'session/message', listeners: [], text: '', site: 'src7/Sessions.ts:10', sessionId: 's34', messageId: 34, vars: { 角色: 'user', 说了: '普通消息三十四' } });

    const canvases = (await app.inject({ method: 'GET', url: '/api/tutorial/canvases' })).json() as {
      list: { name: string }[];
      messages: { name: string; preview: string; hasSnapshot: boolean; channel?: string; bot?: string }[];
    };
    expect(canvases.list.map((item) => item.name)).toEqual(['boot']);
    expect(canvases.messages.map((item) => ({
      name: item.name,
      preview: item.preview,
      hasSnapshot: item.hasSnapshot,
      channel: item.channel,
      bot: item.bot,
    }))).toEqual([
      { name: '34', preview: '普通消息三十四', hasSnapshot: false, channel: undefined, bot: undefined },
      { name: '33', preview: '普通消息三十三', hasSnapshot: false, channel: undefined, bot: undefined },
      { name: '32', preview: '帮我查一下', hasSnapshot: true, channel: 'feishu', bot: '周小灵' },
    ]);

    fs.rmSync(resources.root, { recursive: true, force: true });
    resources.root = realRoot;
  });

  test('遍历的几种记号、比差异', () => {
    const value = { url: 'https://x.example/a?token=abc', apiKey: 'k', set: new Set([1, 2]), gone: undefined, big: 10n };
    expect(snapshotModule.walkState(value)).toEqual({ url: 'https://x.example/a?token=abc', apiKey: 'k', set: [1, 2], gone: null, big: '10' });
    expect(snapshotModule.walkState(new AbortController())).toBe('[AbortController]');
    expect(snapshotModule.walkState({ get later() { return 1; } })).toEqual({ later: '[getter]' });
    expect(snapshotModule.getDiff({ a: 1, b: { c: 2 }, e: 0 }, { a: 1, b: { c: 3 }, d: 1 })).toEqual([['b', 'c'], ['e'], ['d']]);
  });
});
