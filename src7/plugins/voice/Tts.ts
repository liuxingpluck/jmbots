/** 用小米 SSE 输出 PCM，失败时交给已预热的本地同步合成 Worker。 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as threads from 'node:worker_threads';
import * as routes from './Routes.ts';

/** 当前一句的 PCM 音频块。 */
export interface AudioChunk {
  /** 有符号 16 位小端、单声道 PCM。 */
  pcm: Buffer;
  /** 当前音频的原始采样率。 */
  sampleRate: number;
}

/** 按合成顺序输出音频，连接取消时停止发帧。 */
export type Speak = (
  text: string,
  signal: AbortSignal,
  emit: (audio: AudioChunk) => void,
  report: routes.Report,
) => Promise<void>;

/** 由配置入口一次取定的小米合成参数。 */
export interface Xiaomi {
  /** 已配置的 OpenAI 兼容 chat/completions 地址。 */
  url: URL;
  /** 只在请求头中使用的密钥。 */
  apiKey: string;
  /** 小米预置音色。 */
  voice: string;
}

/** 小米 PCM 帧没有文件头，按同一模型实测的 WAV 采样率播放。 */
const XIAOMI_RATE = 24_000;
const XIAOMI_MODEL = 'mimo-v2.5-tts';

/** 消费 SSE 中的音频，不等待整条回复。 */
async function speakXiaomi(
  settings: Xiaomi,
  text: string,
  signal: AbortSignal,
  emit: (audio: AudioChunk) => void,
): Promise<void> {
  const body = JSON.stringify({
    model: XIAOMI_MODEL,
    messages: [{ role: 'assistant', content: text }],
    audio: { format: 'pcm16', voice: settings.voice },
    stream: true,
  });
  const headers = { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' };
  const timeout = AbortSignal.timeout(12_000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const options: RequestInit = { method: 'POST', headers, body, redirect: 'error', signal: requestSignal };

  //M 每个 SSE 音频事件到达就给同一个 WebSocket。
  const response = await fetch(settings.url, options);
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || response.body === null || !contentType.includes('text/event-stream')) {
    await response.body?.cancel();
    if (!response.ok) throw routes.getHttpFailure(response.status);
    throw new routes.RouteFailure('小米语音响应格式无效');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let received = false;
  try {
    for (;;) {
      //M 逐批读取底层 HTTP 字节，拼好一行才解码。
      const chunk = await reader.read();
      if (chunk.done) break;

      pending += decoder.decode(chunk.value, { stream: true });
      let end = pending.indexOf('\n');
      while (end >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        end = pending.indexOf('\n');
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          if (received) return;
          throw new Error('小米语音未返回音频');
        }
        const event = JSON.parse(data) as {
          choices?: Array<{ delta?: { audio?: { data?: string } } }>;
        };
        const encoded = event.choices?.[0]?.delta?.audio?.data;
        if (!encoded) continue;

        const pcm = Buffer.from(encoded, 'base64');
        if (pcm.length === 0 || pcm.length % 2 !== 0) {
          throw new Error('小米语音音频块不完整');
        }
        received = true;
        emit({ pcm, sampleRate: XIAOMI_RATE });
      }
    }
    throw new Error('小米语音流提前结束');
  } finally {
    //M 主动结束、超时或出错时都释放 HTTP 流。
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Worker 源码与服务入口一起打包，不依赖发布目录有独立的脚本。 */
const WORKER_SOURCE = String.raw`
const { createRequire } = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
//M Worker 启动就加载模型，首句回复复用这个同步合成器。
const load = createRequire(process.execPath);
const sherpa = load(workerData.entry);
const voice = new sherpa.OfflineTts(workerData.config);
parentPort.on('message', ({ text, port }) => {
  try {
    //M 同步路径留在 Worker，主线程继续收麦克风和发送字幕。
    const result = voice.generate({ text, sid: 0, speed: 1, enableExternalBuffer: false });
    const pcm = new Uint8Array(result.samples.length * 2);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < result.samples.length; index += 1) {
      const sample = Math.max(-32768, Math.min(32767, Math.round(result.samples[index] * 32768)));
      view.setInt16(index * 2, sample, true);
    }
    port.postMessage({ pcm, sampleRate: result.sampleRate }, [pcm.buffer]);
  } catch {
    port.postMessage(undefined);
  } finally {
    //M 任务结束后释放它独享的回执通道。
    port.close();
  }
});
`;

/** 维护一个预热的本地合成器，不让原生同步调用占用主线程。 */
export class LocalTts {
  private worker?: threads.Worker;

  /** 模型齐全时预热 Worker。缺模型只让本地备选不可用。 */
  constructor(nativeDir: string, modelsDir: string) {
    const entry = path.join(nativeDir, 'sherpa-onnx-node', 'sherpa-onnx.js');
    const modelDir = path.join(modelsDir, 'tts', 'vits-melo-tts-zh_en');
    const model = path.join(modelDir, 'model.onnx');
    const lexicon = path.join(modelDir, 'lexicon.txt');
    const tokens = path.join(modelDir, 'tokens.txt');
    const rules = ['date.fst', 'number.fst'].map((name) => path.join(modelDir, name));
    const required = [entry, model, lexicon, tokens, ...rules];

    //G 未安装本地模型时不启动 Worker。
    if (required.some((file) => !fs.existsSync(file))) return;

    const config = {
      model: { vits: { model, lexicon, tokens }, provider: 'cpu', numThreads: 2 },
      ruleFsts: rules.join(','),
    };
    const options = { eval: true, workerData: { entry, config } };
    //M 用已验证的同步合成路径预热整套模型。
    const worker = new threads.Worker(WORKER_SOURCE, options);
    this.worker = worker;
    const unavailable = (): void => {
      this.worker = undefined;
    };
    //M Worker 加载失败时让后续请求明确走不可用状态。
    worker.on('error', unavailable);
    //M Worker 退出后也停止接收新请求。
    worker.on('exit', unavailable);
    worker.unref();
  }

  /** 用独立 MessagePort 把结果还给提交它的请求。 */
  async generate(text: string, signal: AbortSignal): Promise<AudioChunk> {
    signal.throwIfAborted();
    const worker = this.worker;
    if (worker === undefined) {
      throw new Error('本地合成不可用');
    }

    const { port1, port2 } = new threads.MessageChannel();
    const result = Promise.withResolvers<{ pcm: Uint8Array; sampleRate: number } | undefined>();
    const cancel = (): void => result.reject(new Error('本地合成已取消'));
    const exit = (): void => result.reject(new Error('本地合成 Worker 已退出'));
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('exit', exit);
    port1.once('message', result.resolve);
    try {
      //M 给这一句一条独立的回执通道，关闭旧连接不会串到新句。
      worker.postMessage({ text, port: port2 }, [port2]);
      const audio = await result.promise;
      if (!audio?.pcm.length) {
        throw new Error('本地合成未返回音频');
      }
      const pcm = Buffer.from(audio.pcm);
      return { pcm, sampleRate: audio.sampleRate };
    } finally {
      signal.removeEventListener('abort', cancel);
      worker.off('exit', exit);
      //M 无论成功还是取消都释放结果监听端。
      port1.close();
      //M postMessage 抛错时未转移的发送端也要释放。
      port2.close();
    }
  }

  /** 随语音插件卸载关闭 Worker 和本地模型。 */
  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    //M 先断开新调用，等待中的请求由退出事件释放。
    void worker?.terminate();
  }
}

/** 一条合成线路；lines 由主选和可用的备选按配置顺序组成。 */
export interface SynthesisRoute {
  /** 该线路的音频实际在哪里生成。 */
  place: routes.Place;
  /** 接受这一句、取消信号和 PCM 回调。 */
  produce: (
    text: string,
    signal: AbortSignal,
    emit: (audio: AudioChunk) => void,
  ) => Promise<void>;
}

/** 把小米 HTTP 合成交给可在两条线路间切换的入口。 */
export function getXiaomiRoute(settings?: Xiaomi): SynthesisRoute {
  const produce: SynthesisRoute['produce'] = async (text, signal, emit) => {
    //G 没配置时由统一线路逻辑择用已启用的备用合成器。
    if (settings === undefined) throw new routes.RouteFailure('没有配置小米语音合成地址或密钥');

    //M 按 PCM 流交付当前句，不等待供应商整句合成结束。
    await speakXiaomi(settings, text, signal, emit);
  };
  return { place: 'cloud', produce };
}

/** 按配置选择合成线路，未完成时用备选重合成当前句。 */
export function createSpeaker(
  lines: SynthesisRoute[],
): Speak {
  return async (text, signal, emit, report) => {
    let reason: string | undefined;
    for (const line of lines) {
      signal.throwIfAborted();
      let hasAudio = false;
      const publish = (audio: AudioChunk): void => {
        if (signal.aborted) return;

        if (!hasAudio) {
          hasAudio = true;
          //M 首个音频块证明该线路已经实际在生成。
          report(line.place, reason);
        }
        emit(audio);
      };
      try {
        //M 保留原有流式发送与整句本地生成形态。
        await line.produce(text, signal, publish);
        return;
      } catch (error) {
        //G 被取代的连接不会继续启动备用线路。
        signal.throwIfAborted();
        reason = routes.getFailure(error, '语音合成线路失败');
      }
    }
    //G 两条线路都用尽时只回固定的最终失败原因。
    throw new routes.RouteFailure(reason ?? '没有可用的语音合成线路');
  };
}
