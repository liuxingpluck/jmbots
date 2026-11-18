/** voice v0.1 的离线协议测试，以及有 WebSocket 插件时的真实升级测试。 */

import * as events from 'node:events';
import { afterEach, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as requests from '../../utils/RequestEvent.ts';
import * as asrModule from './Asr.ts';
import type * as taskModule from './Tasks.ts';
import type * as channel from '../../Channels.ts';
import * as plugin from './index.ts';

type Wire = Buffer | ArrayBuffer | Buffer[];
type Frames = Record<string, unknown>[];

class Socket extends events.EventEmitter<{ message: [Wire, boolean]; close: []; error: [] }> {
  readyState = 1;
  code?: number;
  readonly frames: Frames = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    this.code = code;
    this.readyState = 3;
    this.emit('close');
  }

  write(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }

  pcm(bytes: Buffer): void {
    this.emit('message', bytes, true);
  }
}

class FakeAsr implements asrModule.Asr {
  onPartial = (_text: string): void => {};
  onFinal = (_text: string): void => {};
  onSpeechStart = (): void => {};
  readonly input: number[][] = [];
  closed = false;

  accept(pcm: Int16Array): void {
    this.input.push([...pcm]);
    this.onPartial(' 你好 ');
  }

  close(): void {
    this.closed = true;
  }
}

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function getVoice(settings?: taskModule.TaskSettings) {
  const ctx = new cordis.Context();
  const streams: FakeAsr[] = [];
  const voice = new plugin.Voice(ctx, '默认机器人', () => {
    const asr = new FakeAsr();
    streams.push(asr);
    return asr;
  }, 'fake', settings);
  cleanups.push(() => ctx.fiber.dispose());
  cleanups.push(() => voice.dispose());
  return { ctx, voice, streams };
}

test('首帧非 start 或首帧是 PCM 时返回错误并关闭 4400', () => {
  const { voice, streams } = getVoice();
  const first = new Socket();
  voice.attach(first);
  first.write({ type: 'ping' });
  expect(first.frames[0]).toMatchObject({ type: 'error', code: 'invalid-frame' });
  expect(first.code).toBe(4400);

  const second = new Socket();
  voice.attach(second);
  second.pcm(Buffer.from([1, 0]));
  expect(second.frames[0]).toMatchObject({ type: 'error', code: 'invalid-frame' });
  expect(second.code).toBe(4400);
  expect(streams).toHaveLength(0);
});

test('新连接取代旧连接并停止旧流，字幕只发给当前连接', () => {
  const { voice, streams } = getVoice();
  const first = new Socket();
  voice.attach(first);
  first.write({ type: 'start' });
  const old = streams[0]!;
  const second = new Socket();
  voice.attach(second);
  expect(first.code).toBe(4001);
  expect(old.closed).toBe(true);

  second.write({ type: 'start', bot: '当前助手', lang: 'zh' });
  second.pcm(Buffer.from([1, 0]));
  old.onFinal('过期的字幕');
  expect(first.frames.some((frame) => frame['type'] === 'final')).toBe(false);
  expect(second.frames.some((frame) => frame['text'] === '过期的字幕')).toBe(false);
  expect(second.frames[0]).toMatchObject({ type: 'ready', asr: 'fake', sampleRate: 16000, bot: '当前助手' });
  expect(voice.counts).toEqual({ clients: 1, listening: true });
});

test('PCM 原样交给 ASR，partial/final 同序号，stop 强制收尾且不再接帧', () => {
  const { ctx, voice, streams } = getVoice();
  const state: string[] = [];
  const transcripts: unknown[] = [];
  ctx.on('voice/transcript', (event) => { transcripts.push(event); });
  ctx.on('voice/state', (event) => { state.push(event.state); });
  const socket = new Socket();
  voice.attach(socket);
  socket.write({ type: 'start' });
  expect(socket.frames[0]).toMatchObject({ type: 'ready', bot: '默认机器人' });

  const frame = Buffer.from([0xff, 0x7f, 0, 0x80, 0x34, 0x12, 0, 0]);
  socket.pcm(frame);
  const asr = streams[0]!;
  expect(asr.input).toEqual([[32767, -32768, 4660, 0]]);
  expect(socket.frames.at(-1)).toMatchObject({ type: 'partial', seq: 1, text: '你好' });
  asr.onFinal('你好朋友');
  expect(socket.frames.at(-1)).toMatchObject({ type: 'final', seq: 1, text: '你好朋友' });
  socket.pcm(frame);
  socket.write({ type: 'stop' });
  expect(socket.frames.at(-2)).toMatchObject({ type: 'final', seq: 2, text: '你好' });
  expect(socket.frames.at(-1)).toMatchObject({ type: 'state', state: 'idle' });
  expect(asr.closed).toBe(true);

  socket.pcm(frame);
  expect(asr.input).toHaveLength(2);
  socket.write({ type: 'ping' });
  expect(socket.frames.at(-1)).toMatchObject({ type: 'pong' });
  expect(state).toEqual(['listening', 'idle']);
  expect(transcripts).toEqual([
    { seq: 1, text: '你好', final: false, at: expect.any(Number) },
    { seq: 1, text: '你好朋友', final: true, at: expect.any(Number) },
    { seq: 2, text: '你好', final: false, at: expect.any(Number) },
    { seq: 2, text: '你好', final: true, at: expect.any(Number) },
  ]);
});

test('模拟转写按静音或单句上限切段', () => {
  const asr = new asrModule.FakeAsr(100, 300);
  const outputs: string[] = [];
  asr.onPartial = (text) => { outputs.push('partial:' + text); };
  asr.onFinal = (text) => { outputs.push('final:' + text); };
  const talking = Int16Array.from({ length: 1600 }, () => 1);
  const silence = new Int16Array(1600);
  asr.accept(talking);
  asr.accept(silence);
  expect(outputs).toEqual(['partial:模拟听写', 'final:模拟听写']);
  asr.accept(talking);
  asr.accept(talking);
  asr.accept(talking);
  expect(outputs.slice(2)).toEqual(['partial:模拟听写', 'final:模拟听写']);
});

interface JudgeRequest extends requests.EventArg<'decision/judge'> {}

type Verdict = 'allow' | 'deny' | 'unsure';

const DEFAULT_TASKS: taskModule.TaskSettings = {
  minChars: 6,
  stepChars: 12,
  stepMs: 1000,
  allowAt: 0.8,
  denyAt: 0.3,
  timeoutMs: 400,
  maxPerMinute: 30,
  mergeWindowMs: 30_000,
};
const WEATHER = '请帮我查一下明天北京的天气';
const DESKTOP = '请把我桌面所有截图按日期整理';

function getTaskWorld(
  decide?: (req: JudgeRequest) => Verdict | Promise<Verdict>,
  options: Partial<taskModule.TaskSettings> = {},
) {
  const settings = { ...DEFAULT_TASKS, ...options };
  const { ctx, voice, streams } = getVoice(settings);
  const judged: JudgeRequest[] = [];
  const messages: channel.ChannelMessage[] = [];
  const tasks: taskModule.VoiceTask[] = [];
  const socket = new Socket();

  //M 假决策和假机器人走同一生产事件入口；按请求里的 sessionId 模拟续接。
  if (decide !== undefined) {
    requests.onRequestEvent(ctx, 'decision/judge', 'decision/judge-result', async (req) => {
      judged.push(req);
      const verdict = await decide(req);
      return { verdict, reason: '测试回执' };
    });
  }
  ctx.on('channel/message', (message, control) => {
    messages.push(message);
    const sessionId = message.routing.sessionId ?? 'work-' + messages.length;
    control?.claims.push({ bot: '默认机器人', claimKey: '测试认领', status: 'claimed', sessionId });
  });
  ctx.on('voice/task', (task) => { tasks.push(task); });

  voice.attach(socket);
  socket.write({ type: 'start' });
  return { ctx, voice, socket, asr: streams[0]!, judged, messages, tasks };
}

async function waitForCount(data: readonly unknown[], count: number) {
  for (let index = 0; index < 100; index += 1) {
    if (data.length >= count) return;

    await Bun.sleep(5);
  }
  throw new Error('等待事件失败：预期 ' + count + ' 条，收到 ' + data.length);
}

test('满 12 个新字立刻判断，句尾等同一在途回执并且不重复开任务', async () => {
  const gate = Promise.withResolvers<Verdict>();
  const { asr, judged, messages, tasks, socket } = getTaskWorld(() => gate.promise);
  asr.onPartial(WEATHER);
  await waitForCount(judged, 1);
  expect(judged[0]?.kind).toBe('voice');
  expect(judged[0]?.state).toMatchObject({ 这段话: WEATHER, 是否一句话已说完: false });

  asr.onFinal(WEATHER);
  await Bun.sleep(10);
  expect(judged).toHaveLength(1);
  expect(messages).toHaveLength(0);

  gate.resolve('allow');
  await waitForCount(tasks, 1);
  const frame = await waitForFrame(socket.frames, 'task');
  expect(frame).toMatchObject({ text: WEATHER, merged: false, sessionId: 'work-1' });
  expect(judged).toHaveLength(1);
  expect(messages).toHaveLength(1);
});

test('有新字但不足 12 个时，达到时间阈值后也判断', async () => {
  const { asr, judged } = getTaskWorld(() => 'unsure', { stepMs: 30 });
  asr.onPartial('请帮我查天气');
  expect(judged).toHaveLength(0);
  await waitForCount(judged, 1);
  expect(judged[0]?.kind).toBe('voice');
});

test('unsure 仅在句尾放行，句尾 deny 不进入下一次判断', async () => {
  const { asr, judged, messages, tasks } = getTaskWorld((req) => {
    if (req.state['这段话'] === DESKTOP) return 'deny';

    return 'unsure';
  });
  asr.onPartial(WEATHER);
  await waitForCount(judged, 1);
  expect(messages).toHaveLength(0);

  asr.onFinal(WEATHER);
  await waitForCount(tasks, 1);
  expect(judged.map((item) => item.kind)).toEqual(['voice', 'voice-final']);

  asr.onFinal(DESKTOP);
  await waitForCount(judged, 3);
  await Bun.sleep(10);
  expect(tasks).toHaveLength(1);

  const next = '请给我列出明天的待办';
  asr.onFinal(next);
  await waitForCount(tasks, 2);
  expect(judged[3]?.state['这段话']).toBe(next);
  expect(messages[1]?.rawText).toBe(next);
});

test('缺 decision 时停麦强制完成当前一句，先发任务帧再发 idle', async () => {
  const { socket, asr, tasks } = getTaskWorld();
  asr.onPartial('请帮我查天气');
  expect(tasks).toHaveLength(0);
  socket.write({ type: 'stop' });

  const task = await waitForFrame(socket.frames, 'task');
  expect(task).toMatchObject({ text: '请帮我查天气', bot: '默认机器人' });
  const index = socket.frames.indexOf(task);
  expect(socket.frames[index - 1]).toMatchObject({ type: 'final' });
  expect(socket.frames[index + 1]).toMatchObject({ type: 'state', state: 'idle' });
});

test('运行中 30 秒内补充进上一会话，有收尾后另开', async () => {
  const { asr, voice, messages, tasks } = getTaskWorld(() => 'allow');
  asr.onFinal(WEATHER);
  await waitForCount(tasks, 1);

  asr.onFinal(DESKTOP);
  await waitForCount(tasks, 2);
  expect(messages[1]?.routing).toEqual({ listenOnly: false, autoFinal: true, sessionId: 'work-1' });
  expect(messages[1]?.text).toBe('【补充】' + DESKTOP);
  expect(tasks[1]).toMatchObject({ merged: true, sessionId: 'work-1' });
  voice.settle(messages[1]!.messageId);

  asr.onFinal('请把整理结果写成表格');
  await waitForCount(tasks, 3);
  expect(messages[2]?.routing).toEqual({ listenOnly: false, autoFinal: true });
  expect(tasks[2]).toMatchObject({ merged: false, sessionId: 'work-3' });
});

test('到每分钟上限之后仍放行句尾强制判断', async () => {
  const { asr, judged, tasks } = getTaskWorld(() => 'unsure', { maxPerMinute: 1, stepMs: 20 });
  asr.onPartial(WEATHER);
  await waitForCount(judged, 1);

  const longer = WEATHER + '另外也看看周末以及未来一周有没有下雨';
  asr.onPartial(longer);
  await Bun.sleep(30);
  expect(judged).toHaveLength(1);
  expect(tasks).toHaveLength(0);

  asr.onFinal(longer);
  await waitForCount(tasks, 1);
  expect(judged.map((request) => request.kind)).toEqual(['voice', 'voice-final']);
});

test('派发保留标准渠道所有字段，并以认领会话构造任务回执', async () => {
  const { asr, messages, tasks, socket } = getTaskWorld(() => 'allow');
  const started = Date.now();
  asr.onFinal(WEATHER);
  await waitForCount(tasks, 1);

  const task = tasks[0]!;
  const message = messages[0]!;
  expect(task.taskId).toMatch(/^voice_[0-9a-f-]{36}$/u);
  expect(message).toEqual({
    v: 1,
    messageId: JSON.stringify(['voice', 'local', task.taskId]),
    nativeId: task.taskId,
    channel: 'voice',
    accountId: 'local',
    chatId: 'local',
    chatType: 'local',
    sender: { id: 'owner', name: '语音' },
    role: 'owner',
    targetBots: ['默认机器人'],
    mentions: [],
    rawText: WEATHER,
    text: '【语音转写，可能有错字】' + WEATHER,
    attachments: [],
    createdAt: expect.any(Number),
    receivedAt: expect.any(Number),
    timeSource: 'received',
    replyTo: null,
    origin: { channel: 'voice', address: { customer: 'voice:本机', owner: true } },
    visibility: { scope: 'voice:本机', trusted: true, publicSourceIds: [] },
    routing: { listenOnly: false, autoFinal: true },
  });
  expect(message.createdAt).toBeGreaterThanOrEqual(started);
  expect(message.receivedAt).toBeGreaterThanOrEqual(message.createdAt);
  const frame = await waitForFrame(socket.frames, 'task');
  expect(frame).toEqual({ type: 'task', ...task });
});

test('替换连接取消旧判断的等待，迟到的 allow 不派发', async () => {
  const decision = Promise.withResolvers<Verdict>();
  const { voice, socket, asr, judged, tasks, messages } = getTaskWorld(() => decision.promise);
  asr.onFinal(WEATHER);
  await waitForCount(judged, 1);

  const next = new Socket();
  voice.attach(next);
  expect(socket.code).toBe(4001);
  decision.resolve('allow');
  await Bun.sleep(10);
  expect(tasks).toHaveLength(0);
  expect(messages).toHaveLength(0);
  expect(next.frames).toEqual([]);
});

async function setupHttp(config?: Record<string, unknown>) {
  const ctx = new cordis.Context();
  const app = fastify.default({ logger: false, forceCloseConnections: true });
  class Resources extends cordis.Service {
    readonly raw = { voice: config };
    readonly root = process.cwd();
    constructor(local: cordis.Context) {
      super(local, 'resources');
    }
  }
  class Http extends cordis.Service {
    readonly app = app;
    constructor(local: cordis.Context) {
      super(local, 'http');
    }
  }
  class Sessions extends cordis.Service {
    constructor(local: cordis.Context) {
      super(local, 'sessions');
    }
  }
  cleanups.push(() => within(app.close(), 'Fastify 退出'));
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Resources);
  await ctx.plugin(Http);
  await ctx.plugin(Sessions);
  await ctx.plugin(plugin);
  await app.ready();
  return { ctx, app };
}

const wsAvailable = (await plugin.loadWebSocket()) !== undefined;

test('状态报告默认关闭，sherpa 尚未接入时保持 HTTP 正常并报原因', async () => {
  const disabled = await setupHttp();
  const off = await disabled.app.inject('/api/voice/status');
  expect(off.json()).toMatchObject({
    enabled: false, available: false, error: { code: 'voice-disabled' },
  });
  const unregistered = await disabled.app.inject('/api/voice/ws');
  expect(unregistered.statusCode).toBe(404);

  const { ctx, app } = await setupHttp({ enabled: true, ws_path: '/api/listen' });
  const missing = await app.inject('/api/voice/status');
  expect(missing.json()).toMatchObject({
    available: false, enabled: true, wsPath: '/api/listen',
    error: { code: 'asr-model-missing', message: '本地转写还没装好' },
  });
  const options = {
    timeoutMs: 500,
    onFallback: () => ({ requestId: '', ok: false, clients: 0, listening: false }),
  };
  const status = await requests.requestEvent(ctx, 'voice/request', 'voice/result', { action: 'status' }, options);
  expect(status).toMatchObject({ ok: false, clients: 0, listening: false, error: '本地转写还没装好' });
});

test('fake 开启时按实际 WebSocket 依赖报告就绪', async () => {
  const { app } = await setupHttp({ enabled: true, asr: { provider: 'fake' } });
  const res = await app.inject('/api/voice/status');
  expect(res.json()).toMatchObject({ enabled: true, available: wsAvailable });
  if (!wsAvailable) {
    expect(res.json()).toMatchObject({ error: { code: 'websocket-missing' } });
  }
});

async function within<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + '超时')), 1500);
  });
  try {
    return await Promise.race([pending, failure]);
  } finally {
    clearTimeout(timer);
  }
}

async function connect(address: string) {
  const url = new URL('/api/voice/ws', address);
  url.protocol = 'ws:';
  const socket = new WebSocket(url);
  const frames: Frames = [];
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true });
  });
  cleanups.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;

    socket.close();
    await within(closed, '客户端断开');
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      frames.push(JSON.parse(event.data) as Record<string, unknown>);
    }
  });
  const opening = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket 升级失败')), { once: true });
  });
  await within(opening, 'WebSocket 升级');
  return { socket, frames, closed };
}

async function waitForFrame(frames: Frames, type: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = frames.find((item) => item['type'] === type);
    if (frame !== undefined) return frame;

    await Bun.sleep(10);
  }
  throw new Error('没有收到 ' + type);
}

test('真 Fastify 升级后验证关码、PCM、字幕和 stop', async () => {
  const { app } = await setupHttp({ enabled: true, asr: { provider: 'fake' } });
  const address = await within(app.listen({ host: '127.0.0.1', port: 0 }), 'Fastify 监听');

  const bad = await connect(address);
  bad.socket.send('{"type":"ping"}');
  expect(await within(bad.closed, '等待无效首帧的关码')).toBe(4400);
  expect(bad.frames[0]).toMatchObject({ type: 'error', code: 'invalid-frame' });

  const old = await connect(address);
  old.socket.send('{"type":"start"}');
  await waitForFrame(old.frames, 'ready');
  const next = await connect(address);
  expect(await within(old.closed, '等待旧连接的关码')).toBe(4001);

  next.socket.send('{"type":"start"}');
  await waitForFrame(next.frames, 'ready');
  next.socket.send(Uint8Array.of(1, 0));
  expect(await waitForFrame(next.frames, 'partial')).toMatchObject({ seq: 1, text: '模拟听写' });
  next.socket.send('{"type":"stop"}');
  expect(await waitForFrame(next.frames, 'final')).toMatchObject({ seq: 1, text: '模拟听写' });
  next.socket.send(Uint8Array.of(1, 0));
  next.socket.send('{"type":"ping"}');
  await waitForFrame(next.frames, 'pong');
  expect(next.frames.filter((frame) => frame['type'] === 'partial')).toHaveLength(1);
});
