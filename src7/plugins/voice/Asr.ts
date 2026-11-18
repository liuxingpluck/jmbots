/** 第一阶段的流式转写接口与离线模拟实现。 */

export const SAMPLE_RATE = 16_000;

/** 一次录音的转写流，accept 同步接收单声道 Int16 PCM。 */
export interface Asr {
  /** 收一帧，只在调用期间使用样本。 */
  accept(pcm: Int16Array): void;
  /** 目前一句的全文，可能继续变化。 */
  onPartial: (text: string) => void;
  /** 一句话结束时的最终结果。 */
  onFinal: (text: string) => void;
  /** 开始说话，用于以后的语音打断。 */
  onSpeechStart: () => void;
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

/**
 * 本地识别的接入点。后续实现按绝对路径加载已验证的运行库和模型，返回每连接的工厂。
 * @param _options 绝对目录和端点规则。
 * @returns 当前实现未部署时返回 undefined。
 */
export async function loadSherpa(_options: SherpaOptions): Promise<AsrFactory | undefined> {
  return undefined;
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
