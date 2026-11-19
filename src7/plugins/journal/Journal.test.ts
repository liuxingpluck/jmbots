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
import type { Session, SessionRow } from '../../Sessions.ts';
import * as requestEvents from '../../utils/RequestEvent.ts';
import * as journalModule from './index.ts';


const closers: Array<() => Promise<unknown> | void> = [];
const eventOptions = {
  timeoutMs: 1000,
  onFallback: (reason: requestEvents.FallbackReason) => ({ requestId: reason }),
};
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

  dir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
}


/** 构造内存 Session 对象。 */
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
  await ctx.plugin(journalModule, config);
  return { ctx, root };
}


describe('journal（含 FilesMirror 并入）', () => {
  test('默认同时提供 ctx.journal 和 ctx.filesMirror，配置校验生效', async () => {
    expect(journalModule.version).toBe('1.2.1');
    const { ctx } = await setup();

    expect(ctx.get('journal')).toBeDefined();
    expect(ctx.get('filesMirror')).toBeDefined();

    //M 非法配置应当抛出明确中文错误。
    const badMirror = new cordis.Context();
    closers.push(() => badMirror.fiber.dispose());
    const rootBad = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-journal-bad-'));
    closers.push(() => fs.rmSync(rootBad, { recursive: true, force: true }));
    await badMirror.plugin(FakeResources, { root: rootBad });
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

  test('记录 trace 和 internal/dispatch 到 journal_lines，支持 query 筛选、400 校验与 request 取消息轨迹', async () => {
    const { ctx } = await setup();

    //M 发出模拟 web-api 收消息和会话事件。
    ctx.emit('trace', 'WebApi.accept', '收件表记下', 'insert()', { 消息号: 42, 会话: 's_req_1', 机器人: '小记' });
    await ctx.serial('session/message', makeSession('s_req_1', 'running', []), {
      role: 'user',
      content: '早上好',
      timestamp: Date.now(),
    } as piAi.Message);
    ctx.emit('trace', 'Bots.send', '发回用户', 'send()', { 会话: 's_req_1', 机器人: '小记' });

    const allEvents = ctx.journal.query({});
    expect(allEvents.some((e) => e.kind === '函数' && e.name === 'WebApi.accept')).toBe(true);
    expect(allEvents.some((e) => e.kind === '事件' && e.name === 'session/message')).toBe(true);

    const sessionEvents = ctx.journal.query({ name: 'session/*', kind: '事件', limit: '5' });
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]?.name).toBe('session/message');

    const bySession = ctx.journal.query({ session: 's_req_1' });
    expect(bySession.length).toBeGreaterThanOrEqual(2);

    const byMsg = ctx.journal.query({ message: '42' });
    expect(byMsg.some((e) => e.name === 'WebApi.accept')).toBe(true);

    //M 从收件行关联到已认领的会话，其他消息和会话的行不占名额。
    expect(ctx.journal.request(9999, 10)).toBeUndefined();
    const received = { id: 77, bot: '小记', channel: 'http', source: 'http', text: '开始', at: Date.now() };
    ctx.emit('web-api/received', received);
    ctx.emit('trace', 'Other.session', '其他会话', 'z', { 会话: 's_other' });
    ctx.emit('trace', 'Other.message', '同会话的其他消息', 'z', { 消息号: 78, 会话: 's_req_1' });
    ctx.emit('trace', 'Timeline.bindSession', '绑定会话', 'bind()', { 消息号: 77, 会话: 's_req_1' });
    ctx.emit('trace', 'After.step', '后续', 'y', { 会话: 's_req_1' });
    const trail = ctx.journal.request(77, 3);
    expect(trail?.map((line) => line.name)).toEqual(['web-api/received', 'Timeline.bindSession', 'After.step']);

    //M 两种轨迹查询以及用量查询都不写入流水。
    const before = ctx.journal.query({}).length;
    const payload = { action: 'trail', message: 77, maxLines: 3 } as const;
    const result = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', payload, eventOptions);
    expect(result.trail?.message).toBe(77);
    expect(result.trail?.session).toBe('s_req_1');
    expect(result.picked?.map((line) => line.name)).toContain('After.step');
    const to = trail?.[2]?.at ?? 0;
    const replyQuery = { action: 'reply-lines' as const, message: 77, maxLines: 3, sessions: ['s_req_1'], to };
    const replied = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', replyQuery, eventOptions);
    expect(replied.lines).toEqual(trail);
    expect(replied.cut).toBe(false);

    const shortQuery = { ...replyQuery, maxLines: 2 };
    const short = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', shortQuery, eventOptions);
    expect(short.lines).toEqual(trail?.slice(0, 2));
    expect(short.cut).toBe(true);

    const usageQuery = { sessions: ['s_req_1'], from: 0, to, limit: 10 };
    await ctx.serial('usage/list', usageQuery);
    const usageResult = { requestId: 'usage-test', rows: [], truncated: false };
    ctx.emit('usage/list-result', usageResult);
    expect(ctx.journal.query({})).toHaveLength(before);

    const missing = { action: 'trail', message: 9999, maxLines: 10 } as const;
    const none = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', missing, eventOptions);
    expect(none.trail).toBeUndefined();

    expect(() => ctx.journal.query({ limit: 'abc' })).toThrow('非负整数');
    expect(() => ctx.journal.query({ kind: '无效' })).toThrow('kind');
  });

  test('流水事件回传筛选结果、错误及会话镜像目录', async () => {
    const { ctx, root } = await setup();
    ctx.emit('trace', '测试查询', '写一行', 'emit()', {});

    const query = { action: 'query', params: { name: '测试查询' } } as const;
    const queried = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', query, eventOptions);
    expect(queried.ok).toBe(true);
    expect(queried.lines?.map((line) => line.name)).toEqual(['测试查询']);

    const invalid = { action: 'query', params: { limit: '坏值' } } as const;
    const rejected = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', invalid, eventOptions);
    expect(rejected).toMatchObject({ ok: false, lines: [], error: expect.stringContaining('非负整数') });

    const mirror = { action: 'mirror-dir', bot: '小记', sessionId: 's_event' } as const;
    const mirrored = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', mirror, eventOptions);
    expect(mirrored.dir).toBe(path.join(root, 'bots', '小记', 'sessions', 's_event'));

    const disabled = await setup({ mirror: false });
    const noMirror = await requestEvents.requestEvent(disabled.ctx, 'journal/request', 'journal/result', mirror, eventOptions);
    expect(noMirror.requestId).toStartWith('req_');
    expect(noMirror.dir).toBeUndefined();
  });

  test('流水插件未挂载时使用无人接单退路', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    const query = { action: 'query', params: {} } as const;
    const result = await requestEvents.requestEvent(ctx, 'journal/request', 'journal/result', query, eventOptions);
    expect(result).toEqual({ requestId: 'unhandled', fallback: 'unhandled' });
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
    ctx.emit('session/message', session, userMsg);

    session.row.messages.push(assistantMsg);
    ctx.emit('session/message', session, assistantMsg);

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
    ctx.emit('session/message', childSession, userMsg);
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

  test('mirror: false 时不挂 ctx.filesMirror，回退由 Markdown.ts 写简版 对话.md', async () => {
    const { ctx } = await setup({ mirror: false });
    expect(ctx.get('filesMirror')).toBeUndefined();

    const userMsg: piAi.Message = { role: 'user', content: '简版测试', timestamp: Date.now() };
    const session = makeSession('s_lite_1', 'done', [userMsg]);

    ctx.emit('session/message', session, userMsg);
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
