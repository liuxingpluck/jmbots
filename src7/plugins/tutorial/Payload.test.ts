/**
 * tutorial/Payload.ts 与 GET /api/tutorial/payload 离线单元测试：
 * 核对 Cordis internal/dispatch 真实活引用前后深拷贝、逐路径 diff（add/change/remove <= 500 + 顶层 same）、
 * 图片 base64 占位、凭据键隐藏、256KB 单份截断、单消息上限、15 类事件串联、轨迹 step 对齐及 .payload.json 原子轮转。
 * 跑法：bun test ./src7/plugins/tutorial/Payload.test.ts
 */
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as requestEvents from '../../utils/RequestEvent.ts';
import type { TrailLine } from '../../utils/Trail.ts';
import { getBootTrail, getTrail, pick } from '../journal/Trail.ts';
import * as filesModule from './Files.ts';
import * as payloadModule from './Payload.ts';
import * as tutorialModule from './index.ts';


const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 创建测试用临时运行时目录并在测试结束后清理。 */
function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-payload-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}


/** 构造挂在真实 Cordis Context 上的最小 tutorial 测试底座（不监听任何网卡端口，仅用 fastify.inject）。 */
async function setupTutorial(
  lines: TrailLine[],
  config: tutorialModule.TutorialConfig = {},
): Promise<{
  ctx: cordis.Context;
  app: ReturnType<typeof fastify>;
  root: string;
}> {
  const root = makeTempRoot();
  const app = fastify();
  closers.push(() => app.close());

  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  //M 提供 tutorial 依赖的最小骨架服务与 http 实例。
  class FakeBase extends cordis.Service {
    constructor(sub: cordis.Context) {
      super(sub, 'resources');
    }
  }
  const fakeResources = {
    root,
    raw: {},
    config: { providers: {}, plugins: [] },
    pluginStatus: [],
  };
  const fakeSessions = {
    find: () => [],
    openedSessions: new Map<string, unknown>(),
  };
  ctx.provide('resources', fakeResources);
  ctx.provide('sessions', fakeSessions);
  ctx.provide('http', { app });
  void FakeBase;

  //M 挂假 journal：按真实 Trail.ts 收整步骤供 GET /api/tutorial/payload 与落盘对齐 step。
  requestEvents.onRequestEvent(ctx, 'journal/request', 'journal/result', (request) => {
    if (request.action === 'boot-trail') {
      return { trail: getBootTrail(request.lines, request.notes) };
    }
    if (request.action === 'query') {
      return { ok: true, lines: [] };
    }
    if (request.action === 'trail') {
      const hasStart = lines.some((line) => line.name === 'web-api/received' && line.messageId === request.message);
      if (!hasStart) return {};

      return {
        trail: getTrail(request.message, lines),
        picked: pick(request.message, lines).picked,
      };
    }
    return {};
  });

  tutorialModule.apply(ctx, config);
  await app.ready();
  return { ctx, app, root };
}


describe('Payload 真实事件载荷采集与 Diff', () => {
  test('tutorial 版本升为 1.2.0 且默认白名单包含设计文档规定的 15 个事件', () => {
    expect(tutorialModule.version).toBe('1.2.0');
    expect(payloadModule.DEFAULT_PAYLOAD_EVENTS).toEqual([
      'channel/direct',
      'channel/mention',
      'channel/listen',
      'bot/receive',
      'session/new-message',
      'session/before-model',
      'session/after-model',
      'session/model-failed',
      'session/before-tool',
      'session/after-tool',
      'session/change',
      'channel/reply',
      'channel/replied',
      'bot/settled',
      'web-api/replied',
    ]);
  });

  test('假 ctx 依次发 before-model 与 after-model：活引用准确捕到监听改写，算出 add / change / remove 与顶层 same', async () => {
    const root = makeTempRoot();
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    ctx.provide('resources', { root });

    const files = new filesModule.FlowFiles(ctx, 5);
    const recorder = new payloadModule.PayloadRecorder(ctx, {
      recordMode: 'all',
      keyword: '#调试',
      maxItemBytes: 256 * 1024,
      maxMessageBytes: 8 * 1024 * 1024,
      maxMessages: 20,
      extraEvents: [],
    }, files);

    //M 模拟 memory 与 context-fit 两个监听插件在关口一原地修改 ChatRequest。
    ctx.on('session/before-model' as never, ((req: {
      system: string[];
      messages: { role: string; content: string }[];
    }) => {
      req.system.push('记忆：用户偏好中文直答');
      req.messages = [
        { role: 'user', content: '已裁剪早期工具结果' },
        req.messages[2]!,
      ];
    }) as never);

    const session = {
      id: 'ses-gate-1',
      row: { id: 'ses-gate-1', bot: '周小灵', kind: 'front', state: 'running', messages: [] },
    };
    const aborter = new AbortController();
    const chatRequest = {
      session,
      model: 'provider/opus',
      thinking: 'high',
      system: ['基础系统提示'],
      tools: [{ name: 'file_read' }],
      messages: [
        { role: 'user', content: '第一句很旧的话' },
        { role: 'assistant', content: '第一句回答' },
        { role: 'user', content: '最新问题' },
      ],
      signal: aborter.signal,
    };

    await (ctx as unknown as { serial(name: string, ...args: unknown[]): Promise<void> }).serial(
      'session/before-model',
      chatRequest,
    );
    const answered = {
      ...chatRequest,
      answer: {
        role: 'assistant',
        provider: 'provider',
        model: 'opus',
        stopReason: 'stop',
        usage: { input: 80, output: 48, totalTokens: 128 },
        content: [{ type: 'text', text: '这是最终回答' }],
      },
    };
    await (ctx as unknown as { serial(name: string, ...args: unknown[]): Promise<void> }).serial(
      'session/after-model',
      answered,
    );

    const trail = recorder.getBySession('ses-gate-1');
    expect(trail.items).toHaveLength(2);

    const first = trail.items[0]!;
    expect(first.event).toBe('session/before-model');
    expect(first.object).toBe('ChatRequest');
    expect(first.truncated).toBe(false);
    const beforeRec = first.before as { system: string[]; messages: unknown[]; signal: string };
    const afterRec = first.after as { system: string[]; messages: unknown[]; signal: string };
    expect(beforeRec.system).toEqual(['基础系统提示']);
    expect(afterRec.system).toEqual(['基础系统提示', '记忆：用户偏好中文直答']);
    expect(beforeRec.messages).toHaveLength(3);
    expect(afterRec.messages).toHaveLength(2);
    expect(beforeRec.signal).toBe('[AbortSignal]');

    //M diff 中应同时包含新增 system[1]、改写 messages[0/1]、删除 messages[2] 以及透传的 model/thinking。
    expect(first.diff).toContainEqual({
      path: 'system[1]',
      kind: 'add',
      after: '记忆：用户偏好中文直答',
    });
    expect(first.diff.some((d) => d.kind === 'change' && d.path === 'messages[0].content')).toBe(true);
    expect(first.diff.some((d) => d.kind === 'remove' && d.path === 'messages[2]')).toBe(true);
    expect(first.diff.some((d) => d.kind === 'same' && d.path === 'model')).toBe(true);
    expect(first.diff.some((d) => d.kind === 'same' && d.path === 'thinking')).toBe(true);

    //M totalTokens 是数值，不能被凭据正则误打码。
    const secondAfter = trail.items[1]?.after as { answer: { usage: { totalTokens: number } } };
    expect(secondAfter.answer.usage.totalTokens).toBe(128);
  });

  test('深拷贝规则：防循环、函数标名、凭据键隐藏、图片 base64 换 [图片 mime NKB]、超单份上限标 truncated 且 diff 超过 500 条封顶', () => {
    const rawPng = Buffer.alloc(12 * 1024, 7).toString('base64');
    const rawJpeg = Buffer.alloc(5 * 1024, 9).toString('base64');
    const cyclic: Record<string, unknown> = {
      apiKey: 'sk-SUPER-SECRET-1',
      api_key: 'sk-SUPER-SECRET-2',
      appSecret: 'sec-3',
      accessToken: 'tok-4',
      Authorization: 'Bearer tok-5',
      userPassword: 'pw-6',
      Cookie: 'sid=cookie-7',
      'Set-Cookie': 'sid=cookie-8; HttpOnly',
      'x-jmbots-key': 'jmbots-key-9',
      webhook_header: 'Authorization: Bearer hook-10',
      totalTokens: 512,
      maxTokens: 4096,
      fn: function demoHandler(): void {},
      imgBlock: { type: 'image', mimeType: 'image/png', data: rawPng },
      dataUrl: `data:image/jpeg;base64,${rawJpeg}`,
    };
    cyclic['self'] = cyclic;

    const cloned = payloadModule.clonePayload(cyclic, 256 * 1024);
    expect(cloned.truncated).toBe(false);
    const val = cloned.value as Record<string, unknown>;
    expect(val['apiKey']).toBe('[凭据 已隐藏]');
    expect(val['api_key']).toBe('[凭据 已隐藏]');
    expect(val['appSecret']).toBe('[凭据 已隐藏]');
    expect(val['accessToken']).toBe('[凭据 已隐藏]');
    expect(val['Authorization']).toBe('[凭据 已隐藏]');
    expect(val['userPassword']).toBe('[凭据 已隐藏]');
    expect(val['Cookie']).toBe('[凭据 已隐藏]');
    expect(val['Set-Cookie']).toBe('[凭据 已隐藏]');
    expect(val['x-jmbots-key']).toBe('[凭据 已隐藏]');
    expect(val['webhook_header']).toBe('[凭据 已隐藏]');
    expect(val['totalTokens']).toBe(512);
    expect(val['maxTokens']).toBe(4096);
    expect(val['fn']).toBe('ƒ demoHandler');
    expect(val['self']).toBe('[循环]');
    expect(val['imgBlock']).toEqual({ type: 'image', mimeType: 'image/png', data: '[图片 image/png 12KB]' });
    expect(val['dataUrl']).toBe('[图片 image/jpeg 5KB]');

    //M 超大数组、Set、对象按剩余预算边遍历边停（不提前整份展开后续元素）。
    const bigArr = Array.from({ length: 50_000 }, (_v, i) => `item-${String(i)}-padding-text`);
    const arrClone = payloadModule.clonePayload(bigArr, 512);
    expect(arrClone.truncated).toBe(true);
    expect((arrClone.value as unknown[]).length).toBeLessThan(50);

    const streamObj: Record<string, unknown> = {};
    for (let idx = 0; idx < 100; idx += 1) {
      streamObj[`field_${String(idx)}`] = `value-${String(idx)}-0123456789abcdef`;
    }
    let touchedTail = false;
    Object.defineProperty(streamObj, 'tailAfterBudget', {
      enumerable: true,
      get() {
        touchedTail = true;
        return 'never';
      },
    });
    const objClone = payloadModule.clonePayload(streamObj, 512);
    expect(objClone.truncated).toBe(true);
    expect(touchedTail).toBe(false);
    expect((objClone.value as Record<string, unknown>)['__truncated__']).toContain('已截断');

    //M 超过单份上限时标 truncated，仍保留可解析结构并支持算 diff。
    const hugeBefore = { keep: 'v1', blob: '中'.repeat(2000), tail: 1 };
    const hugeAfter = { keep: 'v2', blob: '中'.repeat(2000), tail: 2 };
    const smallBefore = payloadModule.clonePayload(hugeBefore, 1024);
    const smallAfter = payloadModule.clonePayload(hugeAfter, 1024);
    expect(smallBefore.truncated).toBe(true);
    expect(smallAfter.truncated).toBe(true);
    const partialDiff = payloadModule.computePayloadDiff(smallBefore.value, smallAfter.value);
    expect(partialDiff.some((d) => d.path === 'keep' && d.kind === 'change')).toBe(true);

    //M 超过 500 处改动时，add / change / remove 总数最多 500 条。
    const oldMany: Record<string, number> = { untouched: 99 };
    const newMany: Record<string, number> = { untouched: 99 };
    for (let idx = 0; idx < 620; idx += 1) {
      oldMany[`k${String(idx)}`] = idx;
      newMany[`k${String(idx)}`] = idx + 1;
    }
    const cappedDiff = payloadModule.computePayloadDiff(oldMany, newMany);
    const mutations = cappedDiff.filter((d) => d.kind !== 'same');
    const sames = cappedDiff.filter((d) => d.kind === 'same');
    expect(mutations).toHaveLength(500);
    expect(sames).toEqual([{ path: 'untouched', kind: 'same', before: '99', after: '99' }]);
  });

  test('全链路 HTTP 接口、轨迹 step 对齐、单消息上限与 data/flow/<消息号>.payload.json 原子轮转', async () => {
    const lines: TrailLine[] = [];
    const { ctx, app, root } = await setupTutorial(lines, {
      payload_messages: 2,
      payload_message_mb: 0.05,
    });
    const serial = (name: string, ...args: unknown[]) => {
      return (ctx as unknown as { serial(ev: string, ...evArgs: unknown[]): Promise<void> }).serial(name, ...args);
    };
    const emit = (name: string, ...args: unknown[]) => {
      (ctx as unknown as { emit(ev: string, ...evArgs: unknown[]): boolean }).emit(name, ...args);
    };

    //M 1. 参数校验、boot 空返回、未录消息返回带原因的空 items。
    expect((await app.inject({ method: 'GET', url: '/api/tutorial/payload?name=' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/tutorial/payload?name=../1' })).statusCode).toBe(400);
    const bootRes = (await app.inject({ method: 'GET', url: '/api/tutorial/payload?name=boot' })).json() as payloadModule.PayloadTrail;
    expect(bootRes).toEqual({ ok: true, message: 'boot', note: '', items: [] });

    const missingRes = (await app.inject({ method: 'GET', url: '/api/tutorial/payload?name=999' })).json() as payloadModule.PayloadTrail;
    expect(missingRes.ok).toBe(true);
    expect(missingRes.items).toEqual([]);
    expect(missingRes.note).toContain('最多留最近 2 条');

    //M 2. 完整模拟消息 101、102、103 走过渠道、认领、会话、回复、收尾并原子落盘轮转。
    const flowDir = path.join(root, 'data', 'flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, 'boot.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(flowDir, '101.json'), '{}', 'utf8');

    ctx.on('channel/direct' as never, ((msg: { messageId: string }, control: { claims: unknown[] }) => {
      control.claims.push({ bot: '周小灵', claimKey: msg.messageId, status: 'claimed', sessionId: `ses-${msg.messageId}` });
    }) as never);
    ctx.on('channel/reply' as never, ((req: { handled?: boolean }) => {
      req.handled = true;
    }) as never);

    for (const id of [101, 102, 103]) {
      const sourceId = JSON.stringify(['http', 'local', String(id)]);
      const sessionId = `ses-${sourceId}`;
      const now = Date.now();
      const session = {
        id: sessionId,
        row: {
          id: sessionId,
          bot: '周小灵',
          kind: 'front',
          state: 'running',
          address: { messageId: id },
          activeSourceSnapshot: { messageId: sourceId, botName: '周小灵' },
          messages: [],
        },
      };

      emit('web-api/received', { id, bot: '周小灵', channel: 'http', source: 'http', text: `测试消息 ${String(id)}`, at: now });
      lines.push({
        id: lines.length + 1, at: now, kind: '事件', name: 'web-api/received',
        listeners: [], text: '', site: 'src7/plugins/web-api/Timeline.ts:311',
        sessionId: null, messageId: id, sourceId, vars: {},
      });

      const chMsg = {
        v: 1,
        messageId: sourceId,
        channel: 'http',
        rawText: `测试消息 ${String(id)}`,
        text: `测试消息 ${String(id)}`,
        targetBots: ['周小灵'],
        origin: { channel: 'http', address: { messageId: id } },
      };
      const control = { claims: [] as unknown[] };
      await serial('channel/direct', chMsg, control);
      lines.push({
        id: lines.length + 1, at: Date.now(), kind: '事件', name: 'channel/direct',
        listeners: ['bots'], text: '', site: 'src7/plugins/channels/Message.ts:292',
        sessionId: null, messageId: null, sourceId, vars: {},
      });

      const gate = { session, call: { id: 'c1', name: 'channel_reply' }, args: { text: '好的' } };
      await serial('session/before-tool', gate);
      lines.push({
        id: lines.length + 1, at: Date.now(), kind: '事件', name: 'session/before-tool',
        listeners: ['approval'], text: '', site: 'src7/Tools.ts:187',
        sessionId, messageId: null, vars: { tool: 'channel_reply' },
      });

      const replyReq = {
        requestId: `req-${String(id)}`,
        channel: 'http',
        bot: '周小灵',
        sourceSnapshot: { messageId: sourceId, botName: '周小灵', origin: { channel: 'http', address: { messageId: id } } },
        parts: [{ partId: 'text:0', kind: 'text', text: '好的' }],
      };
      await serial('channel/reply', replyReq);
      emit('channel/replied', {
        requestId: `req-${String(id)}`,
        replyRoundKey: 'rk',
        receipt: { v: 2, ok: true, status: 'sent', parts: [] },
        request: replyReq,
      });

      session.row.state = 'done';
      emit('session/change', session, 'running');
      lines.push({
        id: lines.length + 1, at: Date.now(), kind: '事件', name: 'session/change',
        listeners: ['bots'], text: '', site: 'src7/Sessions.ts:880',
        sessionId, messageId: null, vars: { state: 'done' },
      });
      emit('bot/settled', {
        sourceSnapshot: { messageId: sourceId, botName: '周小灵', origin: { channel: 'http', address: { messageId: id } } },
        stage: 'sent',
        note: '',
      });
      emit('web-api/replied', { messageId: id, replyIndex: 0, session, text: '好的', at: Date.now() });
      lines.push({
        id: lines.length + 1, at: Date.now(), kind: '事件', name: 'web-api/replied',
        listeners: [], text: '', site: 'src7/plugins/web-api/Timeline.ts:441',
        sessionId, messageId: id, vars: {},
      });

      await Bun.sleep(40);
    }

    //M 3. 核对磁盘只留最近 2 份 .payload.json，且不误删 boot.json 与 101.json，无 .tmp 残留。
    const savedNames = fs.readdirSync(flowDir).sort();
    expect(savedNames).toEqual(['101.json', '102.payload.json', '103.payload.json', 'boot.json']);

    //M 4. 核对 GET /api/tutorial/payload?name=103 的 JSON 契约、claims diff、handled diff 与 step 对齐。
    const res103 = await app.inject({ method: 'GET', url: '/api/tutorial/payload?name=103' });
    expect(res103.statusCode).toBe(200);
    const body103 = res103.json() as payloadModule.PayloadTrail;
    expect(body103.ok).toBe(true);
    expect(body103.message).toBe('103');
    expect(body103.note).toBe('');
    expect(body103.items.map((item) => item.event)).toEqual([
      'channel/direct',
      'session/before-tool',
      'channel/reply',
      'channel/replied',
      'session/change',
      'bot/settled',
      'web-api/replied',
    ]);
    expect(body103.items.every((item) => item.step >= 1)).toBe(true);

    const directItem = body103.items.find((item) => item.event === 'channel/direct')!;
    expect(directItem.site).toBe('src7/plugins/channels/Message.ts:292');
    expect(directItem.diff.some((d) => d.path === 'control.claims[0]' && d.kind === 'add')).toBe(true);

    const replyItem = body103.items.find((item) => item.event === 'channel/reply')!;
    expect((replyItem.after as { handled?: boolean }).handled).toBe(true);
    expect(replyItem.diff.some((d) => d.path === 'handled' && d.kind === 'add')).toBe(true);
  });

  test('单消息字节上限拦截与配置校验、keyword 过滤模式生效', async () => {
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { payload_record: 'none' })).toThrow('payload_record');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { payload_item_kb: 0 })).toThrow('payload_item_kb');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { payload_message_mb: -1 })).toThrow('payload_message_mb');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { payload_messages: 0 })).toThrow('payload_messages');
    expect(() => tutorialModule.apply({} as unknown as cordis.Context, { payload_events: [''] })).toThrow('payload_events');

    //M keyword 模式：不带 #调试 的消息不录，带 #调试 的消息正常录；超单消息总上限后写进 note。
    const lines: TrailLine[] = [];
    const { ctx, app } = await setupTutorial(lines, {
      payload_record: 'keyword',
      payload_item_kb: 4,
      payload_message_mb: 0.002,
    });
    const emit = (name: string, ...args: unknown[]) => {
      (ctx as unknown as { emit(ev: string, ...evArgs: unknown[]): boolean }).emit(name, ...args);
    };

    emit('web-api/received', { id: 201, bot: '助手', channel: 'http', source: 'http', text: '普通消息无关键词', at: 1 });
    emit('web-api/replied', {
      messageId: 201,
      replyIndex: 0,
      session: { id: 's201', row: { state: 'running', messages: [] } },
      text: '回',
      at: 2,
    });
    const plainRes = (await app.inject({ method: 'GET', url: '/api/tutorial/payload?name=201' })).json() as payloadModule.PayloadTrail;
    expect(plainRes.items).toEqual([]);
    expect(plainRes.note).toContain('#调试');

    emit('web-api/received', { id: 202, bot: '助手', channel: 'http', source: 'http', text: '查一下 #调试', at: 3 });
    const s202 = { id: 's202', row: { state: 'running', address: { messageId: 202 }, messages: [] } };
    emit('session/new-message', s202, { role: 'user', content: '甲'.repeat(1200) });
    emit('session/new-message', s202, {
      role: 'assistant',
      provider: 'fake',
      model: 'echo',
      content: [{ type: 'text', text: '乙'.repeat(1200) }],
    });
    const kwRes = (await app.inject({ method: 'GET', url: '/api/tutorial/payload?name=202' })).json() as payloadModule.PayloadTrail;
    expect(kwRes.items).toHaveLength(1);
    expect(kwRes.note).toContain('上限');
  });
});
