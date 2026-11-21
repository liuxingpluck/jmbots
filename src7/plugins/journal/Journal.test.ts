/**
 * journal（含并入的 FilesMirror：完整 对话.md 与 session.json 镜像，兼容 mirror: false 简版）离线单元测试。
 * 跑法：bun test ./src7/plugins/journal/Journal.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { ChannelMessage } from '../channels/index.ts';
import type { Session, SessionRow } from '../../Sessions.ts';
import * as requestEvents from '../../utils/RequestEvent.ts';
import * as dbModule from '../db/index.ts';
import * as filesMirrorModule from './FilesMirror.ts';
import * as journalModule from './index.ts';
import { getTraceEvent } from './Trace.ts';


const closers: Array<() => Promise<unknown> | void> = [];


/**
 * 发 journal/request、等 journal/result；没拿到回执（没人接、出错）就让测试失败，原因写进报错。
 * 生产代码也是这样拿 reply 或 why。
 * @param ctx 发请求用的上下文。
 * @param payload 不带 requestId 的请求。
 * @returns journal/result 的回执。
 */
async function askJournal(
  ctx: cordis.Context,
  payload: requestEvents.StripEnvelope<requestEvents.EventArg<'journal/request'>>,
): Promise<requestEvents.EventArg<'journal/result'>> {
  const asked = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', payload);
  if (asked.why !== undefined) throw new Error(`没拿到 journal/result：${asked.why} ${asked.detail ?? ''}`);

  return asked.reply;
}
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源构造参数。 */
interface FakeResourceOptions {
  root: string;
  events?: Record<string, unknown>;
}


/** 假资源服务：提供内存数据库和临时根目录。 */
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly raw: Record<string, unknown>;
  readonly root: string;

  constructor(ctx: cordis.Context, options: FakeResourceOptions) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = {};
    if (options.events !== undefined) {
      this.raw = { events: options.events };
    }
  }

  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
}


/** 构造带对话的内存 Session。Message 用 role 区分种类，content 存内容，timestamp 记时间。 */
function makeSession(
  id: string,
  state: SessionRow['state'],
  messages: piAi.Message[],
  parent?: string,
): Session {
  const row: SessionRow = {
    id,
    bot: '小记',
    kind: 'front',
    model: 'fake/fake',
    thinking: 'low',
    state,
    reply: '这一轮好了',
    messages,
    steps: 1,
    updatedAt: Date.now(),
  };
  if (parent !== undefined) {
    row.parent = parent;
  }
  return { id, row } as unknown as Session;
}


/** 创建临时目录与挂好 FakeResources 的 ctx。 */
async function setup(config?: unknown, eventsConfig?: Record<string, unknown>): Promise<{ ctx: cordis.Context; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-journal-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, { root, events: eventsConfig });
  await ctx.plugin(dbModule);
  await ctx.plugin(journalModule, config);
  return { ctx, root };
}


/** 通过插件间使用的事件入口查流水。 */
async function queryJournal(ctx: cordis.Context, params: Record<string, string>) {
  const payload = { action: 'query', params } as const;

  //M 沿用生产查询的参数校验与筛选规则。
  return await askJournal(ctx, payload);
}


describe('journal（含 FilesMirror 并入）', () => {
  test('默认只登记 ctx.filesMirror，流水走事件，配置校验生效', async () => {
    expect(journalModule.version).toBe('1.3.9');
    const { ctx } = await setup();

    expect(ctx.get('journal')).toBeUndefined();
    expect(ctx.get('filesMirror')).toBeDefined();

    //M 非法配置应当抛出明确中文错误。
    const badMirror = new cordis.Context();
    closers.push(() => badMirror.fiber.dispose());
    const rootBad = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-journal-bad-'));
    closers.push(() => fs.rmSync(rootBad, { recursive: true, force: true }));
    await badMirror.plugin(FakeResources, { root: rootBad });
    await badMirror.plugin(dbModule);
    let thrown = '';
    try {
      await badMirror.plugin(journalModule, { mirror: 'yes' });
    } catch (error) {
      if (error instanceof Error) {
        thrown = error.message;
      }
    }
    expect(thrown).toContain('mirror');
  });

  test('记录 trace 和 internal/dispatch，事件支持流水筛选、参数校验与消息轨迹', async () => {
    const { ctx } = await setup();

    //M 发出模拟 web-api 收消息和会话事件。
    ctx.emit('trace', 'WebApi.accept', '收件表记下', 'insert()', { 消息号: 42, 会话: 's_req_1', 机器人: '小记' });
    await ctx.serial('session/new-message', makeSession('s_req_1', 'running', []), {
      role: 'user',
      content: '早上好',
      timestamp: Date.now(),
    } as piAi.Message);
    ctx.emit('trace', 'Bots.send', '发回用户', 'send()', { 会话: 's_req_1', 机器人: '小记' });

    const allEvents = await queryJournal(ctx, {});
    expect(allEvents.lines?.some((e) => e.kind === '函数' && e.name === 'WebApi.accept')).toBe(true);
    expect(allEvents.lines?.some((e) => e.kind === '事件' && e.name === 'session/new-message')).toBe(true);

    const sessionParams = { name: 'session/*', kind: '事件', limit: '5' };
    const sessionEvents = await queryJournal(ctx, sessionParams);
    expect(sessionEvents.lines).toHaveLength(1);
    expect(sessionEvents.lines?.[0]?.name).toBe('session/new-message');

    const sessionFilter = { session: 's_req_1' };
    const bySession = await queryJournal(ctx, sessionFilter);
    expect(bySession.lines?.length).toBeGreaterThanOrEqual(2);

    const messageFilter = { message: '42' };
    const byMsg = await queryJournal(ctx, messageFilter);
    expect(byMsg.lines?.some((e) => e.name === 'WebApi.accept')).toBe(true);

    //M 从收件行关联到已认领的会话，其他消息和会话的行不占名额。
    const received = { id: 77, bot: '小记', channel: 'http', source: 'http', text: '开始', at: Date.now() };
    ctx.emit('web-api/received', received);
    ctx.emit('trace', 'Other.session', '其他会话', 'z', { 会话: 's_other' });
    ctx.emit('trace', 'Other.message', '同会话的其他消息', 'z', { 消息号: 78, 会话: 's_req_1' });
    ctx.emit('trace', 'Timeline.bindSession', '绑定会话', 'bind()', { 消息号: 77, 会话: 's_req_1' });
    ctx.emit('trace', 'After.step', '后续', 'y', { 会话: 's_req_1' });
    //M 从流水挑出预期三行，对照回话追溯的顺序和外壳。
    const before = await queryJournal(ctx, {});
    const expectedNames = ['web-api/received', 'Timeline.bindSession', 'After.step'];
    const trail = before.lines?.filter((line) => expectedNames.includes(line.name));
    expect(trail?.map((line) => line.name)).toEqual(expectedNames);

    //M 两种轨迹查询以及用量查询都不写入流水。
    const payload = { action: 'trail', message: 77, maxLines: 3 } as const;
    const result = await askJournal(ctx, payload);
    expect(result.trail?.message).toBe(77);
    expect(result.trail?.session).toBe('s_req_1');
    expect(result.picked?.map((line) => line.name)).toContain('After.step');
    const to = trail?.[2]?.at ?? 0;
    const replyQuery = { action: 'reply-lines' as const, message: 77, maxLines: 3, sessions: ['s_req_1'], to };
    const replied = await askJournal(ctx, replyQuery);
    expect(replied.events).toEqual(trail?.map(getTraceEvent));
    expect(replied.cut).toBe(false);

    const shortQuery = { ...replyQuery, maxLines: 2 };
    const short = await askJournal(ctx, shortQuery);
    expect(short.events).toEqual(trail?.slice(0, 2).map(getTraceEvent));
    expect(short.cut).toBe(true);

    const usageQuery = { sessions: ['s_req_1'], from: 0, to, limit: 10 };
    await ctx.serial('model-catalog/usage', usageQuery);
    const usageResult = { requestId: 'usage-test', rows: [], truncated: false };
    ctx.emit('model-catalog/usage-result', usageResult);
    const after = await queryJournal(ctx, {});
    expect(after.lines).toHaveLength(before.lines?.length ?? 0);

    const missing = { action: 'trail', message: 9999, maxLines: 10 } as const;
    const none = await askJournal(ctx, missing);
    expect(none.trail).toBeUndefined();

    const invalidLimit = { limit: 'abc' };
    const badLimit = await queryJournal(ctx, invalidLimit);
    expect(badLimit).toMatchObject({ ok: false, error: expect.stringContaining('非负整数') });

    const invalidKind = { kind: '无效' };
    const badKind = await queryJournal(ctx, invalidKind);
    expect(badKind).toMatchObject({ ok: false, error: expect.stringContaining('kind') });
  });

  test('轨迹按标准消息号串：飞书收到那几行排在收件行前面，别的机器人的行不混进来', async () => {
    const { ctx } = await setup();
    const sourceId = JSON.stringify(['feishu', 'cli_a', 'om_1']);

    //M 跟踪点与群聊 @ 事件都只带标准消息号，没有收件号。
    ctx.emit('trace', 'Feishu.start', 'trace.feishu.wsReceived', 'im.message.receive_v1', { appId: 'cli_a', messageId: sourceId });
    ctx.emit('trace', 'Feishu.onMessage', 'trace.feishu.receiveMessage', 'serial', { appId: 'cli_a', messageId: sourceId });
    const mention = { messageId: sourceId } as unknown as ChannelMessage;
    await ctx.serial('channel/mention', mention);
    //M 平台原消息号（om_ 开头）和提醒号不是标准号，不记。
    ctx.emit('trace', 'Feishu.onMessage', 'trace.feishu.duplicateMessage', 'x', { messageId: 'om_1' });

    //M 同一条群消息给两个机器人：各一行收件，Timeline.insert 同时带收件号和 sourceId。
    ctx.emit('trace', 'Timeline.insert', '收件表记下', 'insert', { messageId: 90, sourceId, bot: '甲' });
    ctx.emit('web-api/received', { id: 90, bot: '甲', channel: 'feishu', source: 'feishu', text: 'hi', at: Date.now() });
    ctx.emit('trace', 'Timeline.insert', '收件表记下', 'insert', { messageId: 91, sourceId, bot: '乙' });
    ctx.emit('web-api/received', { id: 91, bot: '乙', channel: 'feishu', source: 'feishu', text: 'hi', at: Date.now() });
    ctx.emit('trace', 'Bots.say', '交给会话', 'say', { 会话: 's_a', 消息号: 90 });

    const to = Date.now();
    const firstQuery = { action: 'reply-lines' as const, message: 90, maxLines: 20, sessions: [], to };
    const secondQuery = { ...firstQuery, message: 91 };

    //M 分别沿回话追溯入口取两个机器人的流水，核对共用渠道行和各自的收件行。
    const first = await askJournal(ctx, firstQuery);
    const second = await askJournal(ctx, secondQuery);
    const common = [
      'Feishu.start',
      'Feishu.onMessage',
      'channel/mention',
      'Timeline.insert',
      'web-api/received',
    ];
    expect(first.events?.map((line) => line.type)).toEqual([...common, 'Bots.say']);
    expect(second.events?.map((line) => line.type)).toEqual(common);

    //M 教程页用的 trail：第一格是飞书；按标准号查 /api/events 也行。
    const payload = { action: 'trail', message: 90, maxLines: 20 } as const;
    const result = await askJournal(ctx, payload);
    expect(result.trail?.steps[0]?.rows[0]?.name).toBe('Feishu.start');
    expect(result.picked?.map((line) => line.name)).toContain('Feishu.start');
    const sourceFilter = { source: sourceId };
    const bySource = await queryJournal(ctx, sourceFilter);
    const sourceNames = bySource.lines?.map((line) => line.name);
    expect(sourceNames).toContain('Feishu.start');
    expect(bySource.lines?.map((line) => line.sourceId)).not.toContain(null);
    expect(sourceNames).not.toContain('Bots.say');
  });

  test('1.2.2 以前建的 journal_lines 没有 source_id 列：经 db 迁移补上并记入账本，旧行照常读', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-journal-old-'));
    closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(FakeResources, { root });
    await ctx.plugin(dbModule);
    const db = ctx.resources.db;
    db.exec('CREATE TABLE journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,'
      + ' name TEXT NOT NULL, mode TEXT NOT NULL, listeners TEXT NOT NULL, text TEXT NOT NULL, code TEXT NOT NULL,'
      + ' site TEXT NOT NULL, bot TEXT, session_id TEXT, message_id INTEGER, vars TEXT NOT NULL)');
    //M 旧行的时刻写成现在：第一条新行进来会删过期的，写 1 会被删掉。
    const insert = "INSERT INTO journal_lines (at, kind, name, mode, listeners, text, code, site, vars) VALUES (?, '函数', '旧行', '', '[]', '', '', 'x', '{}')";
    db.query(insert).run(Date.now());

    await ctx.plugin(journalModule);
    ctx.emit('trace', '新行', '', '', { messageId: '["feishu","a","b"]' });

    //M 第一条新行进来时 journal 自己记一行清理（Journal.record），不算。
    const result = await queryJournal(ctx, {});
    const lines = result.lines?.filter((line) => line.name !== 'Journal.record');
    expect(lines?.map((line) => [line.name, line.sourceId])).toEqual([['旧行', null], ['新行', '["feishu","a","b"]']]);
    //M 改版前的旧行没有号（seq 是 null），新行带 utils/Trace.ts 发的号。
    expect(lines?.[0]?.seq).toBeNull();
    expect(typeof lines?.[1]?.seq).toBe('number');
    const versions = db.query("SELECT version FROM db_migrations WHERE plugin = 'journal' ORDER BY version").all() as { version: number }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  test('已有 source_id 列的旧库（尚未登记迁移账本）：adoptColumn 直接接管并补记版本', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-journal-adopted-'));
    closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(FakeResources, { root });
    const db = ctx.resources.db;
    db.exec('CREATE TABLE journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,'
      + ' name TEXT NOT NULL, mode TEXT NOT NULL, listeners TEXT NOT NULL, text TEXT NOT NULL, code TEXT NOT NULL,'
      + ' site TEXT NOT NULL, bot TEXT, session_id TEXT, message_id INTEGER, source_id TEXT, vars TEXT NOT NULL)');
    db.query("INSERT INTO journal_lines (at, kind, name, mode, listeners, text, code, site, source_id, vars) VALUES (?, '函数', '存量行', '', '[]', '', '', 'x', '[\"cli\",\"local\",\"1\"]', '{}')")
      .run(Date.now());

    await ctx.plugin(dbModule);
    await ctx.plugin(journalModule);

    const result = await queryJournal(ctx, { name: '存量行' });
    expect(result.lines?.map((line) => [line.name, line.sourceId])).toEqual([['存量行', '["cli","local","1"]']]);
    const versions = db.query("SELECT version FROM db_migrations WHERE plugin = 'journal' ORDER BY version").all() as { version: number }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  test('流水事件回传筛选结果、错误及会话镜像目录', async () => {
    const { ctx, root } = await setup();
    ctx.emit('trace', '测试查询', '写一行', 'emit()', {});

    const query = { action: 'query', params: { name: '测试查询' } } as const;
    const queried = await askJournal(ctx, query);
    expect(queried.ok).toBe(true);
    expect(queried.lines?.map((line) => line.name)).toEqual(['测试查询']);

    const invalid = { action: 'query', params: { limit: '坏值' } } as const;
    const rejected = await askJournal(ctx, invalid);
    expect(rejected).toMatchObject({ ok: false, lines: [], error: expect.stringContaining('非负整数') });

    const mirror = { action: 'mirror-dir', bot: '小记', sessionId: 's_event' } as const;
    const mirrored = await askJournal(ctx, mirror);
    expect(mirrored.dir).toBe(path.join(root, 'bots', '小记', 'sessions', 's_event'));

    const disabled = await setup({ mirror: false });
    const noMirror = await askJournal(disabled.ctx, mirror);
    expect(noMirror.requestId).toStartWith('req_');
    expect(noMirror.dir).toBeUndefined();
  });

  test('流水插件未挂载时使用无人接单退路', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    const query = { action: 'query', params: {} } as const;
    const asked = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', query);
    expect(asked).toEqual({ why: 'unhandled' });
  });

  test('默认写入完整 对话.md（不与简版双写）及防抖 session.json；子会话不镜像', async () => {
    const { ctx } = await setup();
    const userMsg: piAi.Message = { role: 'user', content: '查下日程', timestamp: Date.now() };
    const assistantMsg: piAi.Message = {
      role: 'assistant',
      content: [{ type: 'text', text: '马上查' }],
      api: 'openai-completions',
      provider: 'fake',
      model: 'fake',
      usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const session = makeSession('s_full_1', 'running', [userMsg]);

    ctx.emit('session/change', session);
    ctx.emit('session/new-message', session, userMsg);

    session.row.messages.push(assistantMsg);
    ctx.emit('session/new-message', session, assistantMsg);

    session.row.state = 'done';
    ctx.emit('session/change', session);

    const dir = ctx.filesMirror.getDir(session.row);
    const mdFile = path.join(dir, '对话.md');
    expect(fs.existsSync(mdFile)).toBe(true);
    const mdContent = fs.readFileSync(mdFile, 'utf8');

    //M 完整镜像格式：含 68 等号分隔、“【用户”、“【这一轮】做完了”，绝不含简版“## 用户 ·”或“*这一轮做完了”。
    expect(mdContent).toContain('='.repeat(68));
    expect(mdContent).toContain('【用户');
    expect(mdContent).toContain('【助手】马上查');
    expect(mdContent).toContain('【这一轮】做完了');
    expect(mdContent).not.toContain('## 用户 ·');
    expect(mdContent).not.toContain('*这一轮做完了');

    //M 子会话（parent !== undefined）跳过镜像目录生成。
    const childSession = makeSession('s_child_1', 'done', [userMsg], 's_full_1');
    ctx.emit('session/new-message', childSession, userMsg);
    ctx.emit('session/change', childSession);
    const childDir = path.join(ctx.resources.root, 'bots', '小记', 'sessions', 's_child_1');
    expect(fs.existsSync(path.join(childDir, '对话.md'))).toBe(false);

    //M 等待 1 秒防抖写入 session.json。
    await Bun.sleep(1150);
    const jsonFile = path.join(dir, 'session.json');
    expect(fs.existsSync(jsonFile)).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as { messages: number; file: string; state: string };
    expect(snapshot.messages).toBe(2);
    expect(snapshot.state).toBe('done');
    expect(snapshot.file).toBe(mdFile);
  });

  test('written 最多记 WRITTEN_MAX 场：满了丢最早那场，被丢的再来消息照库整份重写', async () => {
    const { ctx } = await setup();
    //M 直接看私有的 written：先塞满 WRITTEN_MAX 场假的，最早那场叫 s_old_0。
    const written = (ctx.filesMirror as unknown as { written: Map<string, { count: number; step: number }> }).written;
    for (let index = 0; index < filesMirrorModule.WRITTEN_MAX; index += 1) {
      written.set(`s_old_${String(index)}`, { count: 1, step: 0 });
    }

    //M 一场新会话来第一条消息：整份重写并记进 written，最早那场被挤掉，总数不涨。
    const userMsg: piAi.Message = { role: 'user', content: '新的一场', timestamp: Date.now() };
    const session = makeSession('s_new_1', 'running', [userMsg]);
    ctx.emit('session/new-message', session, userMsg);
    expect(written.size).toBe(filesMirrorModule.WRITTEN_MAX);
    expect(written.has('s_new_1')).toBe(true);
    expect(written.has('s_old_0')).toBe(false);
    expect(written.has('s_old_1')).toBe(true);

    //M 被挤掉的那场再来消息：照库整份重写，对话.md 照样写出来。
    const oldMsg: piAi.Message = { role: 'user', content: '老会话又说话了', timestamp: Date.now() };
    const old = makeSession('s_old_0', 'running', [oldMsg]);
    ctx.emit('session/new-message', old, oldMsg);
    const oldFile = path.join(ctx.filesMirror.getDir(old.row), '对话.md');
    expect(fs.readFileSync(oldFile, 'utf8')).toContain('老会话又说话了');
    expect(written.size).toBe(filesMirrorModule.WRITTEN_MAX);
  });

  test('mirror: false 时不挂 ctx.filesMirror，回退由 Markdown.ts 写简版 对话.md', async () => {
    const { ctx } = await setup({ mirror: false });
    expect(ctx.get('filesMirror')).toBeUndefined();

    const userMsg: piAi.Message = { role: 'user', content: '简版测试', timestamp: Date.now() };
    const session = makeSession('s_lite_1', 'done', [userMsg]);

    ctx.emit('session/new-message', session, userMsg);
    ctx.emit('bot/say', session, '先回一句');
    ctx.emit('session/change', session);

    const mdFile = path.join(ctx.resources.root, 'bots', '小记', 'sessions', 's_lite_1', '对话.md');
    expect(fs.existsSync(mdFile)).toBe(true);
    const mdContent = fs.readFileSync(mdFile, 'utf8');
    expect(mdContent).toContain('## 用户 ·');
    expect(mdContent).toContain('## 中途告诉用户 ·');
    expect(mdContent).toContain('先回一句');
    expect(mdContent).toContain('*这一轮做完了');
  });
});
