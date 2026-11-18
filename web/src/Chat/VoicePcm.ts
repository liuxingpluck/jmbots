/** AudioWorklet 源码：将浏览器实际采样率转换成 16 kHz、每帧 1600 个小端 PCM 样本。 */

export const WORKLET_NAME = 'jmbots-voice-pcm';
export const SAMPLE_RATE = 16_000;

export const WORKLET_SOURCE = `
class VoicePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.remaining = this.ratio;
    this.sum = 0;
    this.frame = new DataView(new ArrayBuffer(3200));
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;

    // 对输入样本区间求平均，跨音频块保留余量，支持 44.1 kHz 或 48 kHz。
    for (const sample of channel) {
      let available = 1;
      while (available > 1e-9) {
        const part = Math.min(available, this.remaining);
        this.sum += part * sample;
        available -= part;
        this.remaining -= part;
        if (this.remaining < 1e-9) {
          this.push(this.sum / this.ratio);
          this.remaining = this.ratio;
          this.sum = 0;
        }
      }
    }
    return true;
  }

  push(sample) {
    const clipped = Math.max(-1, Math.min(1, sample));
    let scale = 32767;
    if (clipped < 0) scale = 32768;
    const int = Math.round(clipped * scale);
    this.frame.setInt16(this.offset, int, true);
    this.offset += 2;
    if (this.offset !== 3200) return;

    const buffer = this.frame.buffer;
    this.port.postMessage(buffer, [buffer]);
    this.frame = new DataView(new ArrayBuffer(3200));
    this.offset = 0;
  }
}
registerProcessor('jmbots-voice-pcm', VoicePcm);
`;
