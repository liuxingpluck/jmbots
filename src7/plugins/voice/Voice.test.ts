/** voice v0.1 的离线协议测试，以及有 WebSocket 插件时的真实升级测试。 */

import * as events from 'node:events';
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as requests from '../../utils/RequestEvent.ts';
import * as asrModule from './Asr.ts';
import * as cloud from './CloudAsr.ts';
import * as models from './Models.ts';
import * as replyModule from './Replies.ts';
import * as routedAsr from './RoutedAsr.ts';
import * as routes from './Routes.ts';
import type * as taskModule from './Tasks.ts';
import * as ttsModule from './Tts.ts';
import * as turnModule from './Turn.ts';
import * as turnModel from './TurnModel.ts';
import * as channel from '../../Channels.ts';
import type { Session } from '../../Sessions.ts';
import * as memoryIndex from '../memory/ChannelIndex.ts';
import * as webApi from '../web-api/index.ts';
import * as plugin from './index.ts';

type Wire = Buffer | ArrayBuffer | Buffer[];
type Frames = Record<string, unknown>[];

class Socket extends events.EventEmitter<{ message: [Wire, boolean]; close: []; error: [] }> {
  readyState = 1;
  code?: number;
  readonly frames: Frames = [];

  send(data: string | Buffer): void {
    if (Buffer.isBuffer(data)) {
      this.frames.push({ type: 'binary', data: [...data] });
      return;
    }
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
  onError?: (reason: string) => void;
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

test('转写线路切换只重放未确认音频，并等待备选线路最后的字幕', async () => {
  const cloud = new FakeAsr();
  const local = new FakeAsr();
  const ready = Promise.withResolvers<asrModule.Asr>();
  const routes: routedAsr.AsrRoute[] = [
    { place: 'cloud', open: () => cloud },
    { place: 'local', open: () => ready.promise },
  ];
  const asr = new routedAsr.RoutedAsr(routes, 12);
  cleanups.push(() => asr.close());
  const providers: string[] = [];
  const finals: string[] = [];
  asr.onProvider = (place, reason) => { providers.push(place + (reason ?? '')); };
  asr.onFinal = (text) => { finals.push(text); };
  const first = new Int16Array([11, 12, 21, 22]);
  asr.accept(first);
  await Bun.sleep(0);
  const final = cloud.onFinal as asrModule.Asr['onFinal'];
  final('已确认', 2);
  cloud.onError?.('云端额度不足');
  final('过期回执', 4);
  asr.accept(new Int16Array([23, 24]));
  const finished = asr.finish();
  ready.resolve(local);
  await finished;
  expect(cloud.closed).toBe(true);
  expect(providers).toEqual(['cloud', 'local云端额度不足']);
  expect(local.input).toEqual([[21, 22], [23, 24]]);
  expect(finals).toEqual(['已确认']);
});

test('百炼转写使用配对的握手、PCM 与收尾事件', async () => {
  let authorized = false;
  let run: Record<string, unknown> | undefined;
  let fed = Buffer.alloc(0);
  class ProviderSocket extends EventTarget {
    readonly bufferedAmount = 0;
    private taskId = '';

    constructor(_url: URL, options: { headers: Record<string, string> }) {
      super();
      authorized = options.headers['Authorization'] === 'Bearer offline-test';
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    send(raw: string | Buffer): void {
      if (Buffer.isBuffer(raw)) {
        fed = Buffer.from(raw);
        this.respond('result-generated', { output: { sentence: { text: '测试转写' } } });
        return;
      }
      const data = JSON.parse(raw) as {
        header: { action: string; task_id: string }; payload: Record<string, unknown>;
      };
      if (data.header.action === 'run-task') {
        this.taskId = data.header.task_id;
        run = data.payload;
        this.respond('task-started');
        return;
      }
      expect(data.header).toMatchObject({ action: 'finish-task', task_id: this.taskId });
      const sentence = { text: '测试转写成功', sentence_end: true, end_time: 100 };
      this.respond('result-generated', { output: { sentence } });
      this.respond('task-finished');
    }

    close(): void {
      this.dispatchEvent(new Event('close'));
    }

    private respond(event: string, payload: Record<string, unknown> = {}): void {
      const header = { event, task_id: this.taskId };
      const data = JSON.stringify({ header, payload });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
  }
  const original = globalThis.WebSocket;
  cleanups.push(() => { globalThis.WebSocket = original; });
  globalThis.WebSocket = ProviderSocket as unknown as typeof WebSocket;
  const url = new URL('wss://example.test/asr');
  const asr = new cloud.BailianAsr({
    url, apiKey: 'offline-test', model: 'fun-asr-realtime', silenceMs: 1200, maxSamples: 16_000,
  });
  cleanups.push(() => asr.close());
  const received: unknown[] = [];
  asr.onPartial = (text) => { received.push(text); };
  asr.onFinal = (...args) => { received.push(args); };
  asr.accept(new Int16Array(1600).fill(123));
  await within(asr.finish(), '百炼测试收尾');
  expect(authorized).toBe(true);
  expect(run).toMatchObject({ model: 'fun-asr-realtime', parameters: { sample_rate: 16000, format: 'pcm' } });
  expect(fed.length).toBe(3200);
  expect(fed.readInt16LE(0)).toBe(123);
  expect(received).toEqual(['测试转写', ['测试转写成功', 1600]]);
});

test('同采样率主备合成也会停止旧段，trace 保留切换原因', async () => {
  const chunk = { pcm: Buffer.from([1, 0]), sampleRate: 24_000 };
  const lines: ttsModule.SynthesisRoute[] = [
    { place: 'cloud', produce: async (_text, _signal, emit) => {
      emit(chunk);
      throw new routes.RouteFailure('云端断开');
    } },
    { place: 'local', produce: async (_text, _signal, emit) => { emit(chunk); } },
  ];
  const speak = ttsModule.createSpeaker(lines);
  const { ctx, voice } = getVoice(undefined, speak);
  const traces: Record<string, unknown>[] = [];
  ctx.on('trace', (_where, _text, _code, vars) => { traces.push(vars); });
  const socket = new Socket();
  voice.attach(socket);
  socket.write({ type: 'start' });
  expect(voice.speak('同采样率的合成')).toBe(true);
  await Bun.sleep(0);
  const relevant = socket.frames.map((frame) => frame['type']).slice(2);
  expect(relevant).toEqual([
    'voice-route', 'audio-start', 'binary', 'stop-audio', 'voice-route', 'audio-start', 'binary', 'audio-end',
  ]);
  expect(traces).toEqual([{ stage: 'tts', place: 'local', reason: '云端断开' }]);
});

test('继续说话和字幕改写会使正在判断的断句回执作废', async () => {
  const replies: { resolve(value: boolean): void }[] = [];
  const predict: models.Predict = () => {
    const reply = Promise.withResolvers<boolean>();
    replies.push(reply);
    return reply.promise;
  };
  const detector = new turnModule.Turn(predict, 100, 10, () => {});
  const silence = new Int16Array(1600);
  const speech = new Int16Array(1600).fill(400);
  let cuts = 0;
  const cut = (): void => { cuts += 1; };
  detector.update('能帮忙查一下我的排班');
  detector.accept(silence, cut);
  detector.accept(speech, cut);
  replies[0]!.resolve(true);
  await Bun.sleep(0);
  expect(cuts).toBe(0);

  detector.update('能帮忙查一下我的排班和');
  detector.accept(silence, cut);
  detector.update('能帮忙查一下我的排班和报表');
  detector.accept(silence, cut);
  replies[1]!.resolve(true);
  replies[2]!.resolve(true);
  await Bun.sleep(0);
  expect(cuts).toBe(1);
});

test('内置断句模型在中英混读的文件名后等待下一段', () => {
  const model = new turnModel.TurnModel();
  expect(model.isComplete('READ ME 文件')).toBe(false);
  expect(model.isComplete('PDF 文件')).toBe(false);
  expect(model.isComplete('READ ME 文件发给我')).toBe(true);
  expect(model.isComplete('帮我查一下明天的天气')).toBe(true);
});

test('没有资源回执时断句模型拒绝本地加载并改走配置的云端', async () => {
  const ctx = new cordis.Context();
  cleanups.push(() => ctx.fiber.dispose());
  const calls: string[] = [];
  ctx.provide('resources', {
    getModel: (name: string) => name,
    models: {
      completeSimple: async (name: string) => {
        calls.push(name);
        return { stopReason: 'stop', content: [{ type: 'text', text: 'YES' }] };
      },
    },
  } as unknown as cordis.Context['resources']);
  const config: models.ModelSettings = {
    local: 'builtin:zh-tail-v1',
    cloud: 'fake/small',
    prefer: 'local',
    timeoutMs: 250,
  };
  const signal = new AbortController().signal;
  const judge = new models.Models(ctx, config, signal);
  const reported: unknown[][] = [];
  const report = (...args: unknown[]): void => { reported.push(args); };
  expect(await judge.predict('已说完？', '请重新打开列表', signal, report)).toBe(true);
  expect(calls).toEqual(['fake/small']);
  expect(reported).toEqual([['cloud', '资源守卫未放行']]);
});

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function getVoice(
  settings?: taskModule.TaskSettings,
  speak?: ttsModule.Speak,
  bargeIn?: plugin.BargeIn,
) {
  const ctx = new cordis.Context();
  const streams: FakeAsr[] = [];
  const voice = new plugin.Voice(ctx, '默认机器人', () => {
    const asr = new FakeAsr();
    streams.push(asr);
    return asr;
  }, 'fake', settings, speak, undefined, bargeIn);
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
  speak?: ttsModule.Speak,
  device?: string,
  bargeIn?: plugin.BargeIn,
) {
  const settings = { ...DEFAULT_TASKS, ...options };
  const { ctx, voice, streams } = getVoice(settings, speak, bargeIn);
  const judged: JudgeRequest[] = [];
  const messages: channel.ChannelMessage[] = [];
  const dispatched: channel.ChannelMessage[] = [];
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
  const claim = (message: channel.ChannelMessage, control?: channel.ChannelMessageControl): void => {
    dispatched.push(message);
    const sessionId = message.routing.sessionId ?? 'work-' + dispatched.length;
    control?.claims.push({ bot: '默认机器人', claimKey: '测试认领', status: 'claimed', sessionId });
  };
  ctx.on('voice/dispatch', async (message, control) => claim(message, control));
  ctx.on('channel/message', (message, control) => {
    messages.push(message);
    if (control?.approvalHandled === true) return;

    claim(message, control);
  });
  ctx.on('voice/task', (task) => { tasks.push(task); });

  voice.attach(socket);
  socket.write({ type: 'start', device });
  return { ctx, voice, socket, asr: streams[0]!, judged, messages, dispatched, tasks };
}

test('本连接的最终答复以音频元数据、二进制 PCM 和结束帧送出', async () => {
  const speak: ttsModule.Speak = async (_text, _signal, emit) => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    emit({ pcm, sampleRate: 24_000 });
  };
  const world = getTaskWorld(undefined, {}, speak);
  world.asr.onFinal(WEATHER);
  await waitForCount(world.tasks, 1);
  const messageId = world.messages[0]!.messageId;
  const request = {
    sourceSnapshot: { messageId, channel: 'voice' }, kind: 'final', replyRequestKey: 'test-playback',
  } as channel.ChannelReplyRequest;

  //M 原连接确认一个音频块播过后，标准回复记录为已播。
  const played = world.voice.playReply('好的，我来查。', request);
  const end = await waitForFrame(world.socket.frames, 'audio-end');
  const parts = world.socket.frames.slice(-4);
  expect(parts).toEqual([
    { type: 'reply', kind: 'final', text: '好的，我来查。' },
    { type: 'audio-start', utterId: end['utterId'], format: 'pcm_s16le', sampleRate: 24_000 },
    { type: 'binary', data: [1, 0, 2, 0] },
    { type: 'audio-end', utterId: expect.any(String) },
  ]);
  world.socket.write({ type: 'audio-played', utterId: end['utterId'] });
  expect(await played).toBe(true);
});

test('停止屏幕播报组会清掉该组，但保留随后到来的普通回复', async () => {
  const spoken: string[] = [];
  const speak: ttsModule.Speak = async (text, _signal, emit) => {
    spoken.push(text);
    const pcm = Buffer.alloc(24_000);
    emit({ pcm, sampleRate: 24_000 });
  };
  const world = getTaskWorld(undefined, {}, speak);
  world.asr.onFinal(WEATHER);
  await waitForCount(world.tasks, 1);
  const messageId = world.messages[0]!.messageId;
  expect(world.voice.speak('屏幕讲解', 'screen-1', true)).toBe(true);
  await waitForFrame(world.socket.frames, 'audio-end');
  expect(world.voice.speak('待取消的讲解', 'screen-1', false)).toBe(true);
  expect(world.voice.sendReply('普通回复', messageId, 'final')).toBe(true);
  world.voice.stopSpeech('screen-2');
  expect(world.socket.frames.some((frame) => frame['type'] === 'stop-audio')).toBe(false);
  world.voice.stopSpeech('screen-1');
  await waitForCount(spoken, 2);
  expect(spoken).toEqual(['屏幕讲解', '普通回复']);
  world.voice.stopSpeech('screen-1');
  expect(world.socket.frames.filter((frame) => frame['type'] === 'stop-audio')).toHaveLength(1);
});

test('双工在音频发送结束后仍过滤回声，插话停播并用最终原话发起任务', async () => {
  const spoken: string[] = [];
  const speak: ttsModule.Speak = async (text, _signal, emit) => {
    spoken.push(text);
    const pcm = Buffer.alloc(48_000);
    emit({ pcm, sampleRate: 24_000 });
  };
  const bargeIn = { minChars: 3, echoSimilarity: 0.75 };
  const world = getTaskWorld(undefined, {}, speak, undefined, bargeIn);
  //M 用同一连接送有声 PCM，手动控制识别器的部分字幕和句尾。
  world.asr.accept = (pcm) => { world.asr.input.push([...pcm]); };
  expect(world.socket.frames[0]).toMatchObject({ type: 'ready', bargeIn: true });
  const reply = '请稍等，我正在整理桌面的截图。';
  expect(world.voice.speak(reply)).toBe(true);
  await waitForFrame(world.socket.frames, 'audio-end');
  expect(world.voice.speak('这条排队播报也应取消')).toBe(true);

  const quiet = Buffer.alloc(3200);
  world.socket.pcm(quiet);
  world.asr.onPartial('我正');
  world.asr.onPartial('正在整理桌面的截土');
  world.asr.onFinal('正在整理，桌面的截土。');
  const pcm = Buffer.alloc(3200, 4);
  const echoFrames = world.socket.frames.filter((frame) => {
    const type = frame['type'];
    return type === 'partial' || type === 'final' || type === 'stop-audio';
  });
  expect(echoFrames).toEqual([]);
  expect(world.messages).toEqual([]);

  world.socket.pcm(pcm);
  world.asr.onPartial('先暂停');
  const interruption = world.socket.frames.slice(-2);
  expect(interruption).toEqual([{ type: 'stop-audio' }, { type: 'partial', seq: 1, text: '先暂停' }]);

  const said = '先暂停，帮我打开设置页面';
  world.socket.pcm(pcm);
  world.asr.onFinal(said);
  //M 连续送进 ASR 的插话最终沿用普通语音渠道，新句只产生一次任务。
  expect(world.asr.input).toHaveLength(3);
  expect(world.socket.frames.at(-1)).toMatchObject({ type: 'final', seq: 1, text: said });
  await waitForCount(world.tasks, 1);
  expect(world.messages.map((message) => message.text)).toEqual([said]);
  expect(spoken).toEqual([reply]);
});

test('音频停播后仍过滤迟到的回声 final，下一句重复同一文本可正常提交', async () => {
  const speak: ttsModule.Speak = async (_text, _signal, emit) => {
    const pcm = Buffer.alloc(24_000);
    emit({ pcm, sampleRate: 24_000 });
  };
  const bargeIn = { minChars: 3, echoSimilarity: 0.75 };
  const world = getTaskWorld(undefined, {}, speak, undefined, bargeIn);
  world.asr.accept = (pcm) => { world.asr.input.push([...pcm]); };
  const text = '请稍等一下让我打开设置页面';
  expect(world.voice.speak(text)).toBe(true);
  await waitForFrame(world.socket.frames, 'audio-end');
  const pcm = Buffer.alloc(3200, 4);
  world.socket.pcm(pcm);

  //M 模拟整句 ASR 迟到的回执，已经超过播放和回声尾音窗口。
  world.voice.stopSpeech();
  await Bun.sleep(200);
  world.asr.onFinal(text);
  expect(world.socket.frames.some((frame) => frame['type'] === 'final')).toBe(false);

  world.socket.pcm(pcm);
  world.asr.onFinal(text);
  await waitForCount(world.tasks, 1);
  expect(world.messages.map((message) => message.text)).toEqual([text]);
});

test('关闭双工后 ready 保持半双工，收到的字幕不会触发停播', async () => {
  const speak: ttsModule.Speak = async (_text, _signal, emit) => {
    const pcm = Buffer.alloc(24_000);
    emit({ pcm, sampleRate: 24_000 });
  };
  const world = getTaskWorld(undefined, {}, speak);
  expect(world.socket.frames[0]).toMatchObject({ type: 'ready', bargeIn: false });
  expect(world.voice.speak('正在播放语音回复')).toBe(true);
  await waitForFrame(world.socket.frames, 'audio-end');
  const pcm = Buffer.alloc(3200, 4);
  world.socket.pcm(pcm);
  world.asr.onFinal('先暂停一下，我有别的问题');
  expect(world.socket.frames.some((frame) => frame['type'] === 'stop-audio')).toBe(false);
});

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
  expect(messages[1]?.rawText).toBe(DESKTOP);
  expect(messages[1]?.routing).toMatchObject({ recordOnly: true });
  expect(messages[2]?.rawText).toBe(next);
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
  expect(messages[1]?.text).toBe(DESKTOP);
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
    text: WEATHER,
    attachments: [],
    createdAt: expect.any(Number),
    receivedAt: expect.any(Number),
    timeSource: 'received',
    replyTo: null,
    origin: { channel: 'voice', address: { customer: 'voice:本机', owner: true, voiceMessageId: message.messageId } },
    visibility: { scope: 'voice:本机', trusted: true, publicSourceIds: [] },
    routing: { listenOnly: false, autoFinal: true },
  });
  expect(message.createdAt).toBeGreaterThanOrEqual(started);
  expect(message.receivedAt).toBeGreaterThanOrEqual(message.createdAt);
  const frame = await waitForFrame(socket.frames, 'task');
  expect(frame).toEqual({ type: 'task', ...task });
});

test('半句先开工，修订后的整句只发一次标准档案并带回任务号', async () => {
  const device = 'a1b2c3d4-0000-4000-8000-000000000001';
  const world = getTaskWorld(() => 'allow', {}, undefined, device);
  world.asr.onPartial(DESKTOP);
  await waitForCount(world.tasks, 1);
  expect(world.dispatched).toHaveLength(1);
  expect(world.messages).toHaveLength(0);

  const task = world.tasks[0]!;
  const corrected = '请把我桌面的所有截图按日期整理好';
  world.asr.onPartial(corrected);
  world.asr.onFinal(corrected);
  await waitForCount(world.messages, 1);
  expect(world.messages).toHaveLength(1);
  expect(world.dispatched).toHaveLength(1);
  const message = world.messages[0]!;
  expect(message.messageId).toBe(world.dispatched[0]!.messageId);
  expect(message.text).toBe(corrected);
  expect(message.chatId).toBe(device);
  expect(message.origin.address).toMatchObject({ chatId: device, customer: 'voice:' + device, owner: true });
  expect(message.routing).toMatchObject({ recordOnly: true, taskId: task.taskId });
});

test('最终语音与未播报的回复各入档一次，网页和渠道可按设备查回', async () => {
  const device = 'a1b2c3d4-0000-4000-8000-000000000002';
  const world = getTaskWorld(() => 'allow', {}, undefined, device);
  const { ctx } = world;
  const db = new Database(':memory:');
  const app = fastify.default();
  const bot = { name: '默认机器人', config: {} };
  //M 内存数据库和 Fastify 注入覆盖真实投影，假后台和静音播放器隔离外部服务。
  cleanups.push(() => db.close());
  cleanups.push(() => app.close());
  ctx.provide('resources', { db });
  ctx.provide('http', { app });
  ctx.provide('bots', { channel: () => () => undefined, channelNames: () => ['voice', 'http'], list: () => [bot], get: () => bot });
  ctx.provide('sessions', { open: () => undefined, find: () => [] });
  webApi.apply(ctx);
  await app.ready();

  const index = new memoryIndex.ChannelIndex(db);
  //M 用 memory 的标准消息转换和去重写入，核对入站和回复都归本人。
  ctx.on('channel/message', (message) => {
    const row = memoryIndex.getMessageRow(message);
    if (row !== undefined) index.add(row);
  });
  let source: channel.SourceSnapshot | undefined;
  ctx.on('channel/reply', (request) => {
    source = request.sourceSnapshot;
    const row = memoryIndex.getReplyRow(request);
    if (row !== undefined) index.add(row);
  });
  let plays = 0;
  const unplayed = async (): Promise<boolean> => {
    plays += 1;
    return false;
  };
  const replies = new replyModule.VoiceReplies(ctx, unplayed);

  //M 半句已开工，后台可以先结束，回话须等最终字幕入档。
  world.asr.onPartial(DESKTOP);
  await waitForCount(world.tasks, 1);
  const task = world.tasks[0]!;
  const message = world.dispatched[0]!;
  const address = message.origin.address;
  const session = { id: task.sessionId, row: { bot: bot.name, address, state: 'done' } } as Session;
  const text = '已按日期整理。';
  const first = replies.fromWork(text, session);
  expect(plays).toBe(0);
  const pending = await app.inject('/api/messages');
  expect(pending.json()).toMatchObject({ messages: [] });
  expect(plays).toBe(0);

  const corrected = '请把我桌面的所有截图按日期整理好';
  world.asr.onFinal(corrected);
  expect(await within(first, '整句入档后发送回复')).toMatchObject({ status: 'accepted' });
  expect(await replies.fromWork(text, session)).toMatchObject({ status: 'accepted' });
  ctx.emit('voice/record', world.messages[0]!, task.sessionId);
  expect(plays).toBe(1);

  //M 网页重新查询和按设备筛选时都读到同一条入站及其唯一回复。
  const all = await app.inject('/api/messages');
  expect(all.statusCode).toBe(200);
  expect(all.json()).toMatchObject({
    messages: [{
      channel: 'voice', chat: device, text: corrected, sessionId: task.sessionId, createdAt: message.createdAt,
      replies: [{ text, spoken: false }],
    }],
  });
  const filteredUrl = '/api/messages?channel=voice&chat=' + device;
  const filtered = await app.inject(filteredUrl);
  expect(filtered.json()).toEqual(all.json());
  const other = await app.inject('/api/messages?channel=voice&chat=other-device');
  expect(other.json()).toMatchObject({ messages: [] });

  //M 历史事件和记忆索引使用同一个设备号，且没有半句或重复回复。
  let history: channel.ChannelHistoryResultEvent | undefined;
  ctx.on('channel/history-result', (result) => { history = result; });
  const request: channel.ChannelHistoryRequest = {
    requestId: 'voice-history', channel: 'voice', mode: 'current', limit: 10, sourceSnapshot: source!,
  };
  ctx.emit('channel/history', request);
  expect(history).toMatchObject({ ok: true, items: [{ direction: 'user', text: corrected }, { direction: 'bot', text }] });
  const query = { channel: 'voice', chat: device, words: [], limit: 10 };
  const indexed = index.search(query);
  expect(indexed).toHaveLength(2);
  expect(indexed).toEqual(expect.arrayContaining([
    expect.objectContaining({ direction: 'user', text: corrected, memoryKey: 'owner' }),
    expect.objectContaining({ direction: 'bot', text, memoryKey: 'owner' }),
  ]));
});

test('重复的标准回复只进入一次语音播放，回执保留实际播放状态', async () => {
  const ctx = new cordis.Context();
  cleanups.push(() => ctx.fiber.dispose());
  let calls = 0;
  const play = async (): Promise<boolean> => {
    calls += 1;
    return true;
  };
  new replyModule.VoiceReplies(ctx, play);
  const parts = [{ partId: 'text:0', kind: 'text' as const, text: '收到' }];
  const request = {
    channel: 'voice', bot: '默认机器人', replyRequestKey: 'single-reply', replyRoundKey: 'reply-round',
    replyIndex: 0, kind: 'final' as const, mode: 'text' as const, parts, payloadHash: 'same-text',
    sourceSnapshot: { channel: 'voice' } as channel.SourceSnapshot,
  };
  const first = await channel.requestChannelReply(ctx, request);
  const replayed = await channel.requestChannelReply(ctx, request);
  expect(first).toMatchObject({ ok: true, spoken: true });
  expect(replayed).toEqual(first);
  expect(calls).toBe(1);
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
    readonly config = { providers: {} };
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

test('状态报告默认关闭，sherpa 模型缺失时保持 HTTP 正常并报原因', async () => {
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
  expect(await waitForFrame(next.frames, 'ready')).toMatchObject({ bargeIn: true });
  next.socket.send(Uint8Array.of(1, 0));
  expect(await waitForFrame(next.frames, 'partial')).toMatchObject({ seq: 1, text: '模拟听写' });
  next.socket.send('{"type":"stop"}');
  expect(await waitForFrame(next.frames, 'final')).toMatchObject({ seq: 1, text: '模拟听写' });
  next.socket.send(Uint8Array.of(1, 0));
  next.socket.send('{"type":"ping"}');
  await waitForFrame(next.frames, 'pong');
  expect(next.frames.filter((frame) => frame['type'] === 'partial')).toHaveLength(1);
});

test('voice.barge_in 为 false 时，真实连接协商结果为半双工', async () => {
  const { app } = await setupHttp({ enabled: true, asr: { provider: 'fake' }, barge_in: false });
  const listen = app.listen({ host: '127.0.0.1', port: 0 });
  const address = await within(listen, 'Fastify 监听');
  const client = await connect(address);
  client.socket.send('{"type":"start"}');
  const ready = await waitForFrame(client.frames, 'ready');
  expect(ready).toMatchObject({ bargeIn: false });
});
