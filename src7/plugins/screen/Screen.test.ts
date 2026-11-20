/** 内存 Fastify 和假模型验证 screen v1，不用真实运行目录、截图或供应商。 */

import { afterEach, expect, spyOn, test } from 'bun:test';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as requests from '../../utils/RequestEvent.ts';
import * as plugin from './index.ts';

const STATUS = '/api/screen/status?clientId=base-one';
const STATE = '/api/screen/state';
const CLICK = '/api/screen/click';
const OBSERVE = '/api/screen/observe';
const PRESENTED = '/api/screen/presented';
const TEXT = '你点的是保存按钮，它通常用于保存当前文档。';
const rect = { x: -100, y: 0, width: 100, height: 100 };
const identity = { protocolVersion: 1, clientId: 'base-one', sessionId: 'screen-one', epoch: 1 };
const start = { ...identity, active: true, reasonCode: 'user_start' };

//M 只含用于校验的 JPEG 标记与尺寸，用于假模型验证图块传递。
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 1, 0, 1, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
]).toString('base64');
const image = {
  mimeType: 'image/jpeg',
  data: jpeg,
  capturedAtMs: 1900,
  ageBeforeClickMs: 100,
  sourceRect: rect,
  width: 1,
  height: 1,
};

//M Context 是模型输入，含 systemPrompt、messages 和 tools。
//M SimpleStreamOptions 是请求选项，含 signal、timeoutMs 和 reasoning。
//M AssistantMessage 是模型回答，content 存内容块，usage 记用量，stopReason 说明结束原因。
type Complete = (context: piAi.Context, options: piAi.SimpleStreamOptions) =>
  piAi.AssistantMessage | Promise<piAi.AssistantMessage>;
//M AssistantMessageEventStream 可异步读取增量事件，result() 返回最终回答，测试用 push() 写入事件。
type Stream = () => piAi.AssistantMessageEventStream;
const answer = (): piAi.AssistantMessage => {
  const json = JSON.stringify({ text: TEXT, uncertain: false });
  return piAi.fauxAssistantMessage(json);
};

const closers: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

/** 使用可注入的假资源，记录传给模型的上下文和模型参数。 */
async function setup(
  config: Record<string, unknown> = {},
  complete: Complete = answer,
  input = ['text', 'image'],
  stream?: Stream,
) {
  const ctx = new cordis.Context();
  const app = fastify.default({ logger: false });
  const calls: { context: piAi.Context; options: piAi.SimpleStreamOptions }[] = [];
  const modelNames: string[] = [];
  class FakeResources extends cordis.Service {
    readonly raw = { screen: { enabled: true, model: 'fake/vision', ...config } };
    readonly models = {
      completeSimple: (_model: unknown, context: piAi.Context, options: piAi.SimpleStreamOptions) => {
        calls.push({ context, options });
        return complete(context, options);
      },
      streamSimple: (_model: unknown, context: piAi.Context, options: piAi.SimpleStreamOptions) => {
        calls.push({ context, options });
        return stream?.();
      },
    };
    constructor(local: cordis.Context) {
      super(local, 'resources');
    }
    getModel(name: string) {
      modelNames.push(name);
      return { input };
    }
  }
  class FakeHttp extends cordis.Service {
    readonly app = app;
    constructor(local: cordis.Context) {
      super(local, 'http');
    }
  }

  //M 和实际插件相同的 Cordis 注入；HTTP 通过 app.inject 进入真实路由。
  closers.push(() => app.close());
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources);
  await ctx.plugin(FakeHttp);
  await ctx.plugin(plugin);
  await app.ready();
  return { ctx, app, calls, modelNames };
}

/** 构造一个非敏感预点击裁图和控件信息。 */
function getClick(seq = 1, changes: Record<string, unknown> = {}) {
  return {
    ...identity,
    clickId: 'click-' + seq,
    seq,
    clickedAtMs: 2000,
    ageAtSendMs: 25,
    button: 'left',
    position: { x: -30, y: 15 },
    monitor: { id: 'monitor-test', rect, dpiX: 120, dpiY: 120 },
    window: {
      pid: 21, processName: 'notepad.exe', processStartedAtMs: 1000, windowId: 'handle-test',
      title: '测试文档', rect, observedAtMs: 2010,
    },
    control: {
      name: '保存', type: '按钮', automationId: 'control-test',
      rect: null, observedAtMs: 2011, isPassword: false, privacyChecked: true,
    },
    image,
    ...changes,
  };
}

/** 给待处理请求一个等待取消的假模型回答。 */
function stopWithSignal(signal: AbortSignal): Promise<piAi.AssistantMessage> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(answer()), { once: true });
  });
}

test('功能关闭及空模型的状态可查询，点击不会调用模型', async () => {
  const off = await setup({ enabled: false, model: '' });
  const status = await off.app.inject(STATUS);
  expect(status.json()).toMatchObject({
    protocolVersion: 1, available: false, enabled: false, active: false, reasonCode: 'disabled',
  });
  const rejected = await off.app.inject({ method: 'POST', url: CLICK, payload: getClick() });
  expect(rejected.statusCode).toBe(403);
  expect(rejected.json()).toMatchObject({ ok: false, errorCode: 'disabled', clickId: 'click-1' });
  expect(off.modelNames).toEqual([]);

  const missing = await setup({ model: '  ' });
  const unavailable = await missing.app.inject(STATUS);
  expect(unavailable.json()).toMatchObject({
    available: false, enabled: true, active: false, reasonCode: 'model_not_configured', effective: { model: '' },
  });
  expect(missing.modelNames).toEqual([]);
});

test('后台观察先送安全文字线索，拒绝时跳过看图，点击仍可直接解释', async () => {
  const { ctx, app, calls } = await setup();
  const seen: unknown[] = [];
  requests.onRequestEvent(ctx, 'decision/judge', 'decision/judge-result', (request) => {
    seen.push(request.state);
    return { verdict: 'deny' as const, reason: '无需细看' };
  });
  await app.inject({ method: 'POST', url: STATE, payload: start });
  const payload = getClick(1);
  const observation = await app.inject({ method: 'POST', url: OBSERVE, payload });
  expect(observation.statusCode).toBe(200);
  expect(observation.json()).toMatchObject({ verdict: 'deny', inspected: false });
  expect(JSON.stringify(seen)).not.toContain(jpeg);
  expect(JSON.stringify(seen)).not.toContain('测试文档');
  expect(calls).toHaveLength(0);

  const click = await app.inject({ method: 'POST', url: CLICK, payload });
  expect(click.statusCode).toBe(200);
  expect(calls).toHaveLength(1);
});

test('后台观察放行才看图，同一回执短期重放且不请求播报', async () => {
  const { ctx, app, calls } = await setup({ speak: true });
  requests.onRequestEvent(ctx, 'decision/judge', 'decision/judge-result', () => {
    return { verdict: 'allow' as const, reason: '值得细看' };
  });
  await app.inject({ method: 'POST', url: STATE, payload: start });
  const payload = getClick(1);
  const first = await app.inject({ method: 'POST', url: OBSERVE, payload });
  expect(first.json()).toMatchObject({
    activity: '读文档', verdict: 'allow', inspected: true, explanation: { text: TEXT },
  });
  expect(calls[0]?.context.messages[0]).toMatchObject({
    content: [{ type: 'text' }, { type: 'image', data: jpeg, mimeType: 'image/jpeg' }],
  });
  const duplicate = await app.inject({ method: 'POST', url: OBSERVE, payload });
  expect(duplicate.json()).toEqual(first.json());
  expect(calls).toHaveLength(1);
  const presented = await app.inject({
    method: 'POST', url: '/api/screen/presented', payload: { ...identity, clickId: payload.clickId },
  });
  expect(presented.json()).toMatchObject({ ok: false, errorCode: 'stale_click' });
});

test('默认模型随可选目录发现图片能力，无须在运行时手写一次', async () => {
  const { ctx, app, modelNames } = await setup({ model: undefined }, answer, ['text']);
  const first = await app.inject(STATUS);
  expect(first.json()).toMatchObject({ available: false, reasonCode: 'model_not_multimodal' });
  class Catalog extends cordis.Service {
    constructor(local: cordis.Context) {
      super(local, 'modelCatalog');
    }
    find() {
      return { vision: true, thinking: ['off'], contextWindow: 8000, maxOutputTokens: 400 };
    }
  }
  await ctx.plugin(Catalog);
  const discovered = await app.inject(STATUS);
  expect(discovered.json()).toMatchObject({ available: true, effective: { model: 'magpie/xiaomi/mimo-v2.6-flash' } });
  expect(modelNames).toContain('magpie/xiaomi/mimo-v2.6-flash');
});

test('入口拒绝缺字段、长文本、负 DPI、未知版本和错误 JPEG 尺寸', async () => {
  const { app, calls } = await setup();
  const valid = getClick();
  const cases = [
    { body: getClick(1, { clickId: undefined }), code: 'invalid_request' },
    { body: getClick(1, { button: undefined }), code: 'invalid_request' },
    { body: getClick(1, { window: { ...valid.window, title: '好'.repeat(161) } }), code: 'invalid_request' },
    { body: getClick(1, { monitor: { ...valid.monitor, dpiX: -1 } }), code: 'invalid_request' },
    { body: getClick(1, { protocolVersion: 2 }), code: 'unsupported_version' },
    { body: getClick(1, { image: { ...image, width: 2 } }), code: 'invalid_request' },
    { body: getClick(1, { image: null }), code: 'invalid_request' },
  ];
  for (const { body, code } of cases) {
    const res = await app.inject({ method: 'POST', url: CLICK, payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, errorCode: code });
  }
  expect(calls).toHaveLength(0);
});

test('拒绝黑名单进程、标题、密码控件和两种超限请求', async () => {
  const { app, calls } = await setup();
  const valid = getClick();
  const blocked = [
    getClick(1, { window: { ...valid.window, processName: 'WECHAT.exe' } }),
    getClick(1, { window: { ...valid.window, title: '这里有 Verification Code' } }),
    getClick(1, { control: { ...valid.control, isPassword: true } }),
  ];
  for (const payload of blocked) {
    const res = await app.inject({ method: 'POST', url: CLICK, payload });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ errorCode: 'privacy_blocked', clickId: 'click-1' });
    expect(res.body).not.toContain('WECHAT.exe');
    expect(res.body).not.toContain('Verification Code');
  }

  const bigImage = Buffer.alloc(256 * 1024 + 1).toString('base64');
  const imagePayload = getClick(1, { image: { ...image, data: bigImage } });
  const bytes = await app.inject({ method: 'POST', url: CLICK, payload: imagePayload });
  expect(bytes.statusCode).toBe(413);
  expect(bytes.json()).toMatchObject({ errorCode: 'payload_too_large' });

  const bigBody = getClick(1, { ignored: 'x'.repeat(512 * 1024) });
  const request = await app.inject({ method: 'POST', url: CLICK, payload: bigBody });
  expect(request.statusCode).toBe(413);
  expect(request.json()).toMatchObject({ errorCode: 'payload_too_large' });
  expect(calls).toHaveLength(0);
});

test('成功回执含完整身份，私有模型只收到必要字段，十秒内重复点击复用回执', async () => {
  const now = spyOn(performance, 'now');
  now.mockReturnValue(100);
  closers.push(() => now.mockRestore());
  const { ctx, app, calls } = await setup({ speak: true, thinking: 'low' });
  const broadcasts: string[] = [];
  ctx.on('internal/dispatch', (_mode, event) => {
    const name = String(event);
    if (name.startsWith('screen/') || name.startsWith('session/')) {
      broadcasts.push(name);
    }
  });
  const enabled = await app.inject({ method: 'POST', url: STATE, payload: start });
  expect(enabled.statusCode).toBe(200);
  expect(enabled.json<{ ok: boolean }>()).toMatchObject({ ok: true, sessionId: identity.sessionId, epoch: 1, active: true, leaseMs: 10000 });

  const request = { method: 'POST', url: CLICK, payload: getClick() } as const;
  const res = await app.inject(request);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    ...identity, clickId: 'click-1', seq: 1, ok: true, text: TEXT,
    uncertain: false, elapsedMs: 0, displayForMs: 6000, speakEligible: false,
  });
  const repeat = await app.inject(request);
  expect(repeat.body).toBe(res.body);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.options).toMatchObject({ reasoning: 'low', maxTokens: 160, maxRetries: 0, timeoutMs: 8000 });
  expect(calls[0]?.context).toMatchObject({
    tools: [],
    messages: [{ role: 'user', content: [
      { type: 'text', text: expect.stringContaining('保存') },
      { type: 'image', mimeType: 'image/jpeg', data: jpeg },
    ] }],
  });
  const context = JSON.stringify(calls[0]?.context);
  expect(context).not.toContain('handle-test');
  expect(context).not.toContain('monitor-test');
  expect(context).not.toContain('control-test');
  expect(broadcasts).toEqual([]);

  //M 语音启用但缺席时，确认呈现照常成功并返回 unavailable。
  const presented = { method: 'POST', url: PRESENTED, payload: { ...identity, clickId: 'click-1' } } as const;
  const speech = await app.inject(presented);
  expect(speech.json()).toMatchObject({ ok: true, speech: 'unavailable' });

  //M 心跳延长 lease，但不延长已经生成的讲解缓存。
  now.mockReturnValue(5100);
  const heartbeat = { ...start, reasonCode: 'heartbeat' };
  const renewed = await app.inject({ method: 'POST', url: STATE, payload: heartbeat });
  expect(renewed.statusCode).toBe(200);
  now.mockReturnValue(10101);
  const expired = await app.inject(request);
  expect(expired.statusCode).toBe(409);
  expect(expired.json()).toMatchObject({ errorCode: 'stale_click' });
  expect(calls).toHaveLength(1);
});

test('旧 epoch、旧 seq 和处理中重复请求返回 409，新点击中止旧模型', async () => {
  const firstStarted = Promise.withResolvers<AbortSignal>();
  let call = 0;
  const { app, calls } = await setup({}, (_context, options) => {
    call += 1;
    if (call !== 1) return answer();

    const signal = options.signal!;
    firstStarted.resolve(signal);
    return stopWithSignal(signal);
  });

  const current = { ...start, epoch: 2 };
  await app.inject({ method: 'POST', url: STATE, payload: current });
  const bad = await app.inject({ method: 'POST', url: CLICK, payload: getClick() });
  expect(bad.statusCode).toBe(409);
  expect(bad.json()).toMatchObject({ errorCode: 'stale_epoch' });

  const firstBody = getClick(2, { epoch: 2 });
  const firstRequest = { method: 'POST', url: CLICK, payload: firstBody } as const;
  const first = app.inject(firstRequest).then((res) => res);
  const signal = await firstStarted.promise;
  const repeated = await app.inject(firstRequest);
  expect(repeated.statusCode).toBe(409);
  expect(repeated.json()).toMatchObject({ errorCode: 'busy' });

  const old = await app.inject({ method: 'POST', url: CLICK, payload: getClick(1, { epoch: 2 }) });
  expect(old.statusCode).toBe(409);
  expect(old.json()).toMatchObject({ errorCode: 'stale_click' });

  const second = await app.inject({ method: 'POST', url: CLICK, payload: getClick(3, { epoch: 2 }) });
  expect(second.statusCode).toBe(200);
  expect(signal.aborted).toBe(true);
  const cancelled = await first;
  expect(cancelled.statusCode).toBe(409);
  expect(cancelled.json()).toMatchObject({ errorCode: 'cancelled', seq: 2 });
  expect(calls).toHaveLength(2);
});

test('失联不接受旧心跳，新一代主动开启才可继续', async () => {
  const now = spyOn(performance, 'now');
  now.mockReturnValue(100);
  closers.push(() => now.mockRestore());
  const { app } = await setup();
  await app.inject({ method: 'POST', url: STATE, payload: start });
  now.mockReturnValue(10100);
  const status = await app.inject(STATUS);
  expect(status.json()).toMatchObject({ active: false });
  const heartbeat = { ...start, reasonCode: 'heartbeat' };
  const invalid = await app.inject({ method: 'POST', url: STATE, payload: heartbeat });
  expect(invalid.statusCode).toBe(409);
  expect(invalid.json()).toMatchObject({ errorCode: 'inactive' });

  const next = { ...start, sessionId: 'screen-two', epoch: 2 };
  const reopened = await app.inject({ method: 'POST', url: STATE, payload: next });
  expect(reopened.json()).toMatchObject({ ok: true, active: true, sessionId: 'screen-two', epoch: 2 });
});

test('坏 JSON 和超长讲解返回 422', async () => {
  let output = '外层有额外文字 {"text":"好","uncertain":false}';
  const { app } = await setup({}, () => piAi.fauxAssistantMessage(output));
  await app.inject({ method: 'POST', url: STATE, payload: start });

  const malformed = await app.inject({ method: 'POST', url: CLICK, payload: getClick() });
  expect(malformed.statusCode).toBe(422);
  expect(malformed.json()).toMatchObject({ errorCode: 'invalid_model_output' });
  output = JSON.stringify({ text: '长'.repeat(161), uncertain: false });
  const tooLong = await app.inject({ method: 'POST', url: CLICK, payload: getClick(2) });
  expect(tooLong.statusCode).toBe(422);
  expect(tooLong.json()).toMatchObject({ errorCode: 'invalid_model_output' });
});

test('模型忽略取消时，期限到达仍回 504', async () => {
  const upstream = Promise.withResolvers<piAi.AssistantMessage>();
  closers.push(() => upstream.resolve(answer()));
  const { app, calls } = await setup({ model_timeout_ms: 1000 }, () => upstream.promise);
  await app.inject({ method: 'POST', url: STATE, payload: start });
  const timed = await app.inject({ method: 'POST', url: CLICK, payload: getClick() });
  expect(timed.statusCode).toBe(504);
  expect(timed.json()).toMatchObject({ ok: false, errorCode: 'model_timeout', clickId: 'click-1' });
  expect(calls[0]?.options.signal?.aborted).toBe(true);
});

test('供应商异常只给固定 502 和错误码', async () => {
  const sensitive = '供应商异常可能回显测试文档和图像';
  const { app } = await setup({}, () => { throw new Error(sensitive); });
  await app.inject({ method: 'POST', url: STATE, payload: start });
  const failed = await app.inject({ method: 'POST', url: CLICK, payload: getClick() });
  expect(failed.statusCode).toBe(502);
  expect(failed.json()).toMatchObject({ ok: false, errorCode: 'model_failed' });
  expect(failed.body).not.toContain(sensitive);
});

test('语音只在呈现确认后按组请求一次，隐私暂停取消旧组', async () => {
  const { ctx, app } = await setup({ speak: true });
  const voices: { action: string; text?: string; group: string }[] = [];
  const off = ctx.events.on('voice/request', (request) => {
    request.handled = true;
    voices.push({ action: request.action, group: request.group, text: request.text });
    if (request.requestId) {
      ctx.events.emit('voice/result', { requestId: request.requestId, ok: true });
    }
  });
  closers.push(() => { off(); });
  await app.inject({ method: 'POST', url: STATE, payload: start });
  const result = await app.inject({ method: 'POST', url: CLICK, payload: getClick() });
  expect(result.json()).toMatchObject({ ok: true, speakEligible: true });
  expect(voices).toHaveLength(0);

  const request = { method: 'POST', url: PRESENTED, payload: { ...identity, clickId: 'click-1' } } as const;
  const speech = await app.inject(request);
  expect(speech.json()).toMatchObject({ ok: true, speech: 'accepted' });
  const same = await app.inject(request);
  expect(same.json()).toMatchObject({ ok: true, speech: 'already_requested' });

  const pause = { ...identity, epoch: 2, active: false, reasonCode: 'privacy_pause' };
  const inactive = await app.inject({ method: 'POST', url: STATE, payload: pause });
  expect(inactive.json()).toMatchObject({ ok: true, active: false, epoch: 2 });
  expect(voices).toEqual([
    { action: 'speak', group: 'screen-one_1', text: TEXT },
    { action: 'stop', group: 'screen-one_1', text: undefined },
  ]);
  const stale = await app.inject(request);
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ ok: false, errorCode: 'stale_epoch' });
});

test('语音无人接单时报告不可用，监听异常时保留播报片段序号', async () => {
  const { ctx, app } = await setup({ speak: true });
  let attempts = 0;
  //M 第一次不接单，第二次在进入语音处理后抛错。
  ctx.events.on('voice/request', (request) => {
    if (request.action !== 'speak') return;

    attempts += 1;
    if (attempts === 1) return;

    request.handled = true;
    throw new Error('模拟语音监听中断');
  });
  const activate = { method: 'POST', url: STATE, payload: start } as const;
  //M 先开启会话，点击后才能确认呈现讲解。
  await app.inject(activate);
  const first = getClick();
  const firstClick = { method: 'POST', url: CLICK, payload: first } as const;
  //M 第一条讲解生成成功后确认呈现。
  await app.inject(firstClick);
  const firstPresented = { method: 'POST', url: PRESENTED, payload: { ...identity, clickId: first.clickId } } as const;
  //G 监听存在但无人接单时按语音不可用处理。
  const unavailable = await app.inject(firstPresented);
  expect(unavailable.json()).toMatchObject({ ok: true, speech: 'unavailable' });

  const second = getClick(2);
  const secondClick = { method: 'POST', url: CLICK, payload: second } as const;
  //M 用新点击生成独立的一条讲解。
  await app.inject(secondClick);
  const secondPresented = { method: 'POST', url: PRESENTED, payload: { ...identity, clickId: second.clickId } } as const;
  //G 接单后异常时播报结果不确定，重复确认不再播报。
  const failed = await app.inject(secondPresented);
  expect(failed.json()).toMatchObject({ ok: true, speech: 'uncertain' });
  //G 原片段序号保留，重试只返回已请求状态。
  const duplicate = await app.inject(secondPresented);
  expect(duplicate.json()).toMatchObject({ ok: true, speech: 'already_requested' });
  expect(attempts).toBe(2);
});

test('首句在模型结束前可以显示和确认，尾句排在当前组后面', async () => {
  const source = piAi.createAssistantMessageEventStream();
  const first = '这是保存按钮。';
  const rest = '可以保存当前文档。';
  const message = piAi.fauxAssistantMessage(JSON.stringify({ text: first + rest, uncertain: false }));
  const stream = () => {
    const partial = piAi.fauxAssistantMessage('{"text":"' + first);
    source.push({ type: 'text_delta', contentIndex: 0, delta: '{"text":"' + first, partial });
    return source;
  };
  const { ctx, app } = await setup({ speak: true }, answer, ['text', 'image'], stream);
  const voices: unknown[] = [];
  const off = ctx.events.on('voice/request', (request) => {
    if (request.action !== 'speak') return;
    voices.push({ text: request.text, interrupt: request.interrupt });
    ctx.events.emit('voice/result', { requestId: request.requestId, ok: true });
  });
  closers.push(off);
  await app.inject({ method: 'POST', url: STATE, payload: start });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(base + CLICK + '/stream', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(getClick()),
    signal: AbortSignal.timeout(3000),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const readFrame = async () => {
    let buffered = '';
    while (!buffered.endsWith('\n')) {
      const found = await reader.read();
      if (found.done) throw new Error('流提前结束');
      buffered += decoder.decode(found.value, { stream: true });
    }
    return JSON.parse(buffered.trim());
  };
  try {
    expect(await readFrame()).toMatchObject({ phase: 'partial', text: first, segment: 1 });
    expect(voices).toEqual([]);

    const acknowledge = async (segment: number) => {
      const payload = { ...identity, clickId: 'click-1', segment };
      const result = await app.inject({ method: 'POST', url: '/api/screen/presented', payload });
      return result.json();
    };
    expect(await acknowledge(2)).toMatchObject({ ok: false, errorCode: 'stale_click' });
    expect(await acknowledge(1)).toMatchObject({ ok: true, speech: 'accepted' });
    expect(await acknowledge(1)).toMatchObject({ ok: true, speech: 'already_requested' });
    expect(voices).toEqual([{ text: first, interrupt: true }]);

    source.push({ type: 'done', message, reason: 'stop' });
    source.end(message);
    expect(await readFrame()).toMatchObject({
      phase: 'done', text: first + rest, segment: 2,
    });
    expect(await acknowledge(2)).toMatchObject({ ok: true, speech: 'accepted' });
    expect(voices).toEqual([{ text: first, interrupt: true }, { text: rest, interrupt: false }]);
  } finally {
    source.end(message);
    await reader.cancel();
  }
});

test('隐私暂停后上游首句到达，基地只收到取消帧', async () => {
  const source = piAi.createAssistantMessageEventStream();
  const started = Promise.withResolvers<void>();
  const first = '{"text":"这是保存按钮。';
  const stream = () => {
    started.resolve();
    return source;
  };
  const { app, calls } = await setup({}, answer, ['text', 'image'], stream);
  await app.inject({ method: 'POST', url: STATE, payload: start });
  const payload = getClick();
  const pending = app.inject({ method: 'POST', url: CLICK + '/stream', payload }).then((response) => response);
  try {
    await started.promise;
    const pause = { ...identity, epoch: 2, active: false, reasonCode: 'privacy_pause' };
    const paused = await app.inject({ method: 'POST', url: STATE, payload: pause });
    expect(paused.statusCode).toBe(200);
    expect(calls[0]?.options.signal?.aborted).toBe(true);

    const partial = piAi.fauxAssistantMessage(first);
    source.push({ type: 'text_delta', contentIndex: 0, delta: first, partial });
    const response = await pending;
    expect(JSON.parse(response.body)).toMatchObject({ phase: 'error', errorCode: 'cancelled' });
    expect(response.body).not.toContain('保存按钮');
  } finally {
    source.end(answer());
  }
});
