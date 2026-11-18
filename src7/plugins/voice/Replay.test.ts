/** 可选的无声回放。用真实 Sherpa 和断句模型量到标准语音回复帧。 */

import * as events from 'node:events';
import * as path from 'node:path';
import * as cordis from 'cordis';
import { expect, test } from 'bun:test';
import * as yaml from 'yaml';
import * as guardModule from '../programs/ResourceGuard.ts';
import * as spec from '../programs/Spec.ts';
import * as requests from '../../utils/RequestEvent.ts';
import * as asr from './Asr.ts';
import * as cloud from './CloudAsr.ts';
import * as models from './Models.ts';
import * as routes from './Routes.ts';
import * as tts from './Tts.ts';
import * as turnModel from './TurnModel.ts';
import * as plugin from './index.ts';

const replayDir = process.env['VOICE_REPLAY_DIR'];
const dataDir = process.env['VOICE_REPLAY_DATA'];
const checkXiaomi = process.env['VOICE_CHECK_XIAOMI'] === '1';
const FRAME_MS = 100;
const FRAME_BYTES = asr.SAMPLE_RATE * FRAME_MS / 1000 * 2;

class ReplaySocket extends events.EventEmitter<{
  message: [Buffer, boolean];
  close: [];
  error: [];
}> implements plugin.VoiceSocket {
  readyState = 1;
  replyAt?: number;
  final?: string;

  send(data: Buffer | string): void {
    if (typeof data !== 'string') return;

    const frame = JSON.parse(data) as { type?: string; text?: string };
    if (frame.type === 'reply' && this.replyAt === undefined) {
      this.replyAt = performance.now();
    }
    if (frame.type === 'final' && this.final === undefined) {
      this.final = frame.text;
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

async function getPcm(root: string, file: string): Promise<Buffer> {
  const source = path.join(root, file);
  const bytes = await Bun.file(source).arrayBuffer();
  const wav = Buffer.from(bytes);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(asr.SAMPLE_RATE);
  expect(wav.readUInt16LE(34)).toBe(16);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      return wav.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + size % 2;
  }
  throw new Error('回放 WAV 缺少 PCM 数据段');
}

function getEndMs(pcm: Buffer): number {
  for (let offset = pcm.length - 2; offset >= 0; offset -= 2) {
    if (Math.abs(pcm.readInt16LE(offset)) >= 160) {
      return (offset + 2) * 500 / asr.SAMPLE_RATE;
    }
  }
  throw new Error('回放没有可识别的有声样本');
}

test.skipIf(replayDir === undefined || dataDir === undefined)('静音回放五轮对照及十次句中停顿', async () => {
  const ctx = new cordis.Context();
  let activeVoice: plugin.Voice | undefined;
  try {
    const configGuard = spec.readGuard(undefined);
    const tools = { notify: () => false };
    const guard = new guardModule.ResourceGuard(ctx, configGuard, [], tools);
    await guard.tick();
    await Bun.sleep(1000);
    await routes.allowLocal(ctx);

    const root = dataDir!;
    const options = {
      nativeDir: path.join(root, 'program', 'sherpa-onnx'),
      modelsDir: path.join(root, 'program', 'voice-models'),
      silenceMs: 1200,
      maxUtteranceMs: 60_000,
    };
    const createAsr = await asr.loadSherpa(options);
    expect(createAsr).toBeDefined();
    const modelSignal = new AbortController().signal;
    const config: models.ModelSettings = {
      local: turnModel.LOCAL_TURN_MODEL, prefer: 'local', timeoutMs: 400,
    };
    const model = new models.Models(ctx, config, modelSignal);
    const warm = await model.predict('', '现在方便说话吗', modelSignal, () => {});
    expect(warm).toBe(true);

    // 维持同一条标准派发回路，使用固定回复隔离模型思考与播报。
    requests.onRequestEvent(ctx, 'decision/judge', 'decision/judge-result', () => {
      return { verdict: 'unsure' as const, reason: '回放只量确认句尾后开始回复' };
    });
    ctx.on('channel/message', (message, control) => {
      control?.claims.push({ bot: '回放机器人', sessionId: 'replay', claimKey: 'replay', status: 'claimed' });
      activeVoice?.sendReply('收到', message.messageId, 'final');
    });

    let modelCalls = 0;
    let modelText: string | undefined;
    const judge: models.Predict = async (instructions, text, signal, report) => {
      modelCalls += 1;
      const complete = await model.predict(instructions, text, signal, report);
      if (complete === true) {
        modelText = text;
      }
      return complete;
    };
    const boundary = { turn: { predict: judge, pauseMs: 300, maxPerMinute: 30 } };
    const tasks = {
      minChars: 6, stepChars: 12, stepMs: 1000, allowAt: 0.8, denyAt: 0.3,
      timeoutMs: 400, maxPerMinute: 30, mergeWindowMs: 30_000,
    };

    const replay = async (clip: Buffer, early: boolean) => {
      const calls = modelCalls;
      modelText = undefined;
      const socket = new ReplaySocket();
      let judging: typeof boundary | undefined;
      if (early) {
        judging = boundary;
      }
      const voice = new plugin.Voice(
        ctx, '回放机器人', createAsr, 'sherpa', tasks, undefined, judging,
      );
      activeVoice = voice;
      voice.attach(socket);
      socket.emit('message', Buffer.from('{"type":"start"}'), false);

      const tail = Buffer.alloc(20 * FRAME_BYTES);
      const padded = Buffer.concat([clip, tail]);
      const endMs = getEndMs(clip);
      const start = performance.now();
      try {
        for (let offset = 0; offset + FRAME_BYTES <= padded.length; offset += FRAME_BYTES) {
          const sendAt = start + (offset + FRAME_BYTES) * 500 / asr.SAMPLE_RATE;
          await Bun.sleep(Math.max(0, sendAt - performance.now()));
          const frame = padded.subarray(offset, offset + FRAME_BYTES);
          socket.emit('message', frame, true);
          if (socket.replyAt !== undefined) break;
        }
        expect(socket.replyAt).toBeDefined();
        const ms = Math.round(socket.replyAt! - start - endMs);
        return { ms, text: socket.final, calls: modelCalls - calls, modelText };
      } finally {
        voice.dispose();
      }
    };

    const chinese = await getPcm(replayDir!, 'zh.wav');
    const mixed = await getPcm(replayDir!, 'mixed.wav');
    const baseline: number[] = [];
    const improved: number[] = [];
    for (const clip of [chinese, mixed, chinese, mixed, chinese]) {
      const old = await replay(clip, false);
      baseline.push(old.ms);
      const current = await replay(clip, true);
      improved.push(current.ms);
      expect(current.text).toBe(old.text);
    }

    const paused = [];
    const pauses = [
      { clip: chinese, cuts: [1300, 1400, 1500, 1600, 1700] },
      { clip: mixed, cuts: [3100, 3200, 3300, 3400, 3500] },
    ];
    for (const { clip, cuts } of pauses) {
      for (const ms of cuts) {
        const at = ms * asr.SAMPLE_RATE / 500;
        const pause = Buffer.alloc(440 * asr.SAMPLE_RATE / 500);
        const interrupted = Buffer.concat([clip.subarray(0, at), pause, clip.subarray(at)]);
        const result = await replay(interrupted, true);
        paused.push({
          pauseAt: ms,
          replyDelay: result.ms,
          calls: result.calls,
          cut: result.ms < 0,
          text: result.text,
          modelText: result.modelText,
        });
      }
    }

    const sort = (a: number, b: number): number => a - b;
    const before = baseline.slice().sort(sort)[2]!;
    const after = improved.slice().sort(sort)[2]!;
    const mistakes = paused.filter((result) => result.cut).length;
    console.info(JSON.stringify({ baseline, improved, before, after, paused, mistakes }));
    expect(after).toBeLessThan(600);
    expect(after).toBeLessThan(before / 2);
    expect(mistakes).toBeLessThanOrEqual(1);
  } finally {
    activeVoice?.dispose();
    await ctx.fiber.dispose();
  }
}, 140_000);

test.skipIf(!checkXiaomi || replayDir === undefined || dataDir === undefined)('小米云实际整句转写与静音合成各一次', async () => {
  const source = path.join(dataDir!, 'config.yaml');
  let raw: { providers?: { xiaomi?: { api_key?: unknown; base_url?: unknown } } };
  try {
    raw = yaml.parse(await Bun.file(source).text()) as typeof raw;
  } catch {
    throw new Error('读取云端测试配置失败');
  }
  const provider = raw.providers?.xiaomi;
  if (typeof provider?.api_key !== 'string' || typeof provider.base_url !== 'string') {
    throw new Error('未配置小米测试用地址或凭据');
  }
  const apiKey = provider.api_key;
  const url = new URL(provider.base_url);
  const official = ['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com'];
  if (url.protocol !== 'https:' || !official.includes(url.hostname)) {
    throw new Error('小米自测只调用已知官方地址');
  }
  url.pathname = url.pathname.replace(/\/$/u, '') + '/chat/completions';
  const pcm = await getPcm(replayDir!, 'zh.wav');
  if (pcm.length > FRAME_BYTES * 40) throw new Error('小米转写限四秒样本');

  const engine = new cloud.XiaomiAsr({ url, apiKey, model: 'mimo-v2.5-asr', silenceMs: 1200, maxSamples: 64_000 });
  let text = '';
  let failure: string | undefined;
  engine.onFinal = (found) => { text = found; };
  engine.onError = (reason) => { failure = reason; };
  const started = performance.now();
  try {
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    engine.accept(samples);
    await engine.finish();
    expect(failure).toBeUndefined();
    expect(text).toContain('天气');
  } finally {
    engine.close();
  }
  const asrMs = Math.round(performance.now() - started);

  const cloudRoute = tts.getXiaomiRoute({ url, apiKey, voice: 'mimo_default' });
  const speak = tts.createSpeaker([cloudRoute]);
  let bytes = 0;
  let firstMs: number | undefined;
  const ready = performance.now();
  const signal = new AbortController().signal;
  await speak('好的，我来查。', signal, (audio) => {
    firstMs ??= Math.round(performance.now() - ready);
    expect(audio.sampleRate).toBe(24_000);
    bytes += audio.pcm.length;
  }, () => {});
  expect(bytes).toBeGreaterThan(0);
  console.info(JSON.stringify({ asrMs, synthesisFirstMs: firstMs, synthesisBytes: bytes, cloudCalls: 2 }));
}, 24_000);
