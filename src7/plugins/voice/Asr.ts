/** 以 Sherpa 在线识别字幕，使用端点规则切句，并保留离线模拟入口。 */

import * as fs from 'node:fs';
import * as modules from 'node:module';
import * as path from 'node:path';
import type * as routes from './Routes.ts';

export const SAMPLE_RATE = 16_000;

/** 一次录音的转写流，accept 同步接收单声道 Int16 PCM。 */
export interface Asr {
  /** 收一帧，只在调用期间使用样本。 */
  accept(pcm: Int16Array): void;
  /** 目前一句的全文，可能继续变化。 */
  onPartial: (text: string) => void;
  /** 一句话结束时的最终结果。 */
  onFinal: (text: string, endSamples?: number) => void;
  /** 开始说话，用于以后的语音打断。 */
  onSpeechStart: () => void;
  /** 异步线路在上游授权并接受音频后才调用。 */
  onReady?: () => void;
  /** 线路实际切换或不可恢复故障的回调，仅自动线路使用。 */
  onProvider?: routes.Report;
  /** 当前临时字幕已作废，音频将交给备用线路重识别。 */
  onReset?: () => void;
  /** 主备线路均失败。 */
  onError?: (reason: string) => void;
  /** 主动停止时解完已经收到的尾音。 */
  finish?(): void | Promise<void>;
  /** 确认当前句完成后交出尾音，再开始下一句。 */
  cut?(): void;
  /** 释放本次转写，不再触发回调。 */
  close(): void;
}

/** 构造一个新连接的转写流。 */
export type AsrFactory = () => Asr;

/** 本地识别实现所需的位置和端点规则。 */
export interface SherpaOptions {
  /** 数据目录下原生运行库的绝对目录。 */
  nativeDir: string;
  /** 数据目录下模型文件的绝对目录。 */
  modelsDir: string;
  /** 句尾静音最长时间。 */
  silenceMs: number;
  /** 单句话最长时间。 */
  maxUtteranceMs: number;
}

/** 由外置包创建的一路在线解码流。 */
interface OnlineStream {
  /** 输入采样率与当前批次的归一化样本。 */
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  /** 通知识别器排空已经收到的音频。 */
  inputFinished(): void;
}

/** 本插件使用的 Sherpa 在线识别方法。 */
interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  getResult(stream: OnlineStream): { text: string };
  isEndpoint(stream: OnlineStream): boolean;
  reset(stream: OnlineStream): void;
}

/** 只用于开口通知的每连接 Silero 实例。 */
interface SpeechDetector {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  pop(): void;
}

/** 加载外置 JS 与本地模型，每个连接分配独立的解码流和 VAD。 */
export async function loadSherpa(options: SherpaOptions): Promise<AsrFactory | undefined> {
  //M 模型检查与构造共用部署目录中的同一组文件。
  const files = getSherpaFiles(options);
  const { entry, encoder, decoder, joiner, tokens, vadModel } = files;
  const required = Object.values(files);

  //G 缺文件时让 Voice 原有的状态接口告知用户。
  const missing = required.some((file) => !fs.existsSync(file));
  if (missing) return undefined;

  //M 全部必需文件齐全后才启用原生识别器。
  return createSherpa(options, entry, encoder, decoder, joiner, tokens, vadModel);
}

/** 只做文件检查，状态查询不加载 CPU 模型。 */
export function hasSherpa(options: SherpaOptions): boolean {
  //M 就绪接口只探查同一组文件，不启动模型。
  const files = getSherpaFiles(options);
  const required = Object.values(files);
  return required.every((file) => fs.existsSync(file));
}

/** 本地模型和状态查询使用同一组路径。 */
function getSherpaFiles(options: SherpaOptions) {
  const entry = path.join(options.nativeDir, 'sherpa-onnx-node', 'sherpa-onnx.js');
  const folder = path.join(options.modelsDir, 'asr', 'streaming-zipformer-bilingual-zh-en');
  const encoder = path.join(folder, 'encoder-epoch-99-avg-1.int8.onnx');
  const decoder = path.join(folder, 'decoder-epoch-99-avg-1.onnx');
  const joiner = path.join(folder, 'joiner-epoch-99-avg-1.int8.onnx');
  const tokens = path.join(folder, 'tokens.txt');
  const vadModel = path.join(options.modelsDir, 'vad', 'silero_vad.onnx');
  return { entry, encoder, decoder, joiner, tokens, vadModel };
}

/** 产出可复用的本地识别器。调用方已经检查本地资源和文件。 */
function createSherpa(
  options: SherpaOptions,
  entry: string,
  encoder: string,
  decoder: string,
  joiner: string,
  tokens: string,
  vadModel: string,
): AsrFactory | undefined {
  const seconds = options.silenceMs / 1000;
  const config = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: 2,
      provider: 'cpu',
    },
    enableEndpoint: true,
    rule1MinTrailingSilence: seconds,
    rule2MinTrailingSilence: seconds,
    rule3MinUtteranceLength: options.maxUtteranceMs / 1000,
  };
  const vadConfig = {
    sileroVad: { model: vadModel, minSilenceDuration: 0.25, minSpeechDuration: 0.25 },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
  };
  try {
    //M 保留外置包的磁盘位置，保证它按原布局加载原生库与 DLL。
    const load = modules.createRequire(process.execPath);
    const sherpa = load(entry) as {
      OnlineRecognizer: new (input: typeof config) => OnlineRecognizer;
      Vad: new (input: typeof vadConfig, seconds: number) => SpeechDetector;
    };
    const recognizer = new sherpa.OnlineRecognizer(config);
    return () => {
      //M 共享只读识别模型，每个连接保有自己的可变流。
      const detector = new sherpa.Vad(vadConfig, 30);
      return new SherpaAsr(recognizer, detector);
    };
  } catch {
    return undefined;
  }
}

/** 处理一路 PCM，按原生端点事件输出最终文本并复用连接。 */
class SherpaAsr implements Asr {
  onPartial: Asr['onPartial'] = () => {};
  onFinal: Asr['onFinal'] = () => {};
  onSpeechStart: Asr['onSpeechStart'] = () => {};

  private stream?: OnlineStream;
  private detected = false;
  private previous = '';

  /** 建立连接专属流，共用已预载的只读识别模型。 */
  constructor(
    private readonly recognizer: OnlineRecognizer,
    private readonly detector: SpeechDetector,
  ) {
    //M 一条 WebSocket 对应一个解码句流。
    this.stream = recognizer.createStream();
  }

  /** 送入一小帧 PCM，输出变化后的文字或最终文字。 */
  accept(pcm: Int16Array): void {
    const stream = this.stream;
    if (stream === undefined) return;

    //M Node-API 接受归一化的单声道 Float32 采样。
    const samples = Float32Array.from(pcm, (sample) => sample / 32_768);
    this.detector.acceptWaveform(samples);
    const detected = this.detector.isDetected();
    if (detected && !this.detected) {
      this.onSpeechStart();
    }
    this.detected = detected;
    while (!this.detector.isEmpty()) {
      //M VAD 在这里仅判断开口，语音段交由在线识别的端点处理。
      this.detector.pop();
    }

    const waveform = { samples, sampleRate: SAMPLE_RATE };
    stream.acceptWaveform(waveform);
    //M 输出当前可解码的内容，端点出现时用全文收尾。
    const text = this.decode(stream);
    if (this.recognizer.isEndpoint(stream)) {
      if (text !== '') {
        //M 有内容的端点才送最终字幕。
        this.onFinal(text);
      }
      //M 断句后复用连接，把下一句的解码状态清空。
      this.recognizer.reset(stream);
      this.previous = '';
      return;
    }
    if (text !== '' && text !== this.previous) {
      this.previous = text;
      this.onPartial(text);
    }
  }

  /** 用户点停止时补足模型需要的末尾上下文，再交出剩余文本。 */
  finish(): void {
    const stream = this.stream;
    if (stream === undefined) return;

    const samples = new Float32Array(SAMPLE_RATE * 0.4);
    const tail = { samples, sampleRate: SAMPLE_RATE };
    //M 给最后的解码块补 400 ms 静音并显式结束输入。
    stream.acceptWaveform(tail);
    stream.inputFinished();
    const text = this.decode(stream);
    if (text !== '') {
      this.onFinal(text);
    }
  }

  /** 断句判断通过时解完尾音，复用模型并给下一句新的原生流。 */
  cut(): void {
    //M 沿用停止时的尾音处理路径，保持最终字幕的完整性。
    this.finish();
    this.previous = '';
    this.stream = this.recognizer.createStream();
  }

  /** 丢弃连接持有的原生流，关闭后不再输出字幕。 */
  close(): void {
    this.stream = undefined;
  }

  /** 解完当前能处理的所有帧，返回同一句的全文。 */
  private decode(stream: OnlineStream): string {
    while (this.recognizer.isReady(stream)) {
      //M 底层每次只解一个模型步长。
      this.recognizer.decode(stream);
    }
    //M 取出当前识别流累积的文字。
    const result = this.recognizer.getResult(stream);
    return result.text.trim();
  }
}

/** 用固定字幕走通收帧、静音切句和长句上限，仅在明确选择 fake 时使用。 */
export class FakeAsr implements Asr {
  onPartial: Asr['onPartial'] = () => {};
  onFinal: Asr['onFinal'] = () => {};
  onSpeechStart: Asr['onSpeechStart'] = () => {};

  private spoken = 0;
  private quiet = 0;
  private closed = false;
  private readonly silenceSamples: number;
  private readonly maxSamples: number;

  /** 将配置的静音阈值与单句最长时长换算成样本数。 */
  constructor(silenceMs: number, maxUtteranceMs: number) {
    this.silenceSamples = silenceMs * SAMPLE_RATE / 1000;
    this.maxSamples = maxUtteranceMs * SAMPLE_RATE / 1000;
  }

  /** 只根据样本是否为零生成固定字幕，不保留 PCM，也不做真实识别。 */
  accept(pcm: Int16Array): void {
    if (this.closed) return;

    //M 模拟开口时得到中间字幕。样本仅用于区分静音。
    const speaks = pcm.some((sample) => sample !== 0);
    if (speaks) {
      if (this.spoken === 0) {
        this.onSpeechStart();
        this.onPartial('模拟听写');
      }
      this.quiet = 0;
    }
    if (this.spoken === 0 && !speaks) return;

    this.spoken += pcm.length;
    if (!speaks) {
      this.quiet += pcm.length;
    }

    //M 达到句尾或时长上限时交出模拟结果并开始下一句。
    if (this.quiet >= this.silenceSamples || this.spoken >= this.maxSamples) {
      this.spoken = 0;
      this.quiet = 0;
      this.onFinal('模拟听写');
    }
  }

  /** 结束流。主动停止时由连接用最后一条中间字幕补 final。 */
  close(): void {
    this.closed = true;
  }
}
