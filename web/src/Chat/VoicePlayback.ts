/** 在一个 AudioContext 排队播放语音回复，播放期间和尾音时暂停麦克风上传。 */

const PLAY_AHEAD_SECONDS = 0.02;
const ECHO_TAIL_SECONDS = 0.15;

/** 将服务器 PCM 帧排到浏览器音频时钟上。 */
export class VoicePlayback {
  private receiving?: { id: string; rate: number };
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private muteUntil = 0;

  /** 复用由用户点击开麦时激活的音频上下文。 */
  constructor(private readonly audio: AudioContext) {}

  /** 收音上传从音频开始帧暂停，等实际播放完和尾音消散。 */
  get blocksMicrophone(): boolean {
    return this.receiving !== undefined || this.sources.size > 0 || this.audio.currentTime < this.muteUntil;
  }

  /** 记住这一段的采样率，后面的二进制帧都按这项解释。 */
  begin(id: string, rate: number): void {
    this.receiving = { id, rate };
  }

  /** 把小端 PCM 归一化为 Float32，然后按积累时长顺接播放。 */
  accept(bytes: ArrayBuffer): void {
    const stream = this.receiving;
    if (stream === undefined || bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return;

    const count = bytes.byteLength / 2;
    const values = new DataView(bytes);
    const buffer = this.audio.createBuffer(1, count, stream.rate);
    const plane = buffer.getChannelData(0);
    for (let offset = 0; offset < plane.length; offset += 1) {
      plane[offset] = values.getInt16(offset * 2, true) / 32_768;
    }

    //M 端到端按音频时钟安排，不等整句下载完。
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audio.destination);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      this.muteUntil = this.audio.currentTime + ECHO_TAIL_SECONDS;
    };
    //M 播毕前保留节点，给麦克风上传守卫判断。
    this.sources.add(source);
    const at = Math.max(this.nextTime, this.audio.currentTime + PLAY_AHEAD_SECONDS);
    //M 和上个音频块首尾相接，或在音频时钟领先一小段起播。
    source.start(at);
    this.nextTime = at + buffer.duration;
  }

  /** 结束接收后仍让已排队的声音播完。 */
  end(id: string): void {
    if (this.receiving?.id !== id) return;

    this.receiving = undefined;
  }

  /** 打断播放或离开页面时取消自己的排队音频。 */
  stop(): void {
    this.receiving = undefined;
    if (this.sources.size > 0) {
      this.muteUntil = this.audio.currentTime + ECHO_TAIL_SECONDS;
    }
    for (const source of this.sources) {
      //M 已经主动释放的节点不再触发播放结束回调。
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    //M 已释放的节点无需继续阻塞新播放段。
    this.sources.clear();
    this.nextTime = 0;
  }
}
