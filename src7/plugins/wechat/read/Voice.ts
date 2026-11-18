/** 按微信消息定位音频，解码成 WAV 后留在机器人的消息目录。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as silk from 'silk-wasm';
import * as readerModule from './Reader.ts';

const SAMPLE_RATE = 24_000;
const BYTE_RATE = SAMPLE_RATE * 2;
const MAX_DURATION_MS = 120_000;
const MAX_PCM = BYTE_RATE * MAX_DURATION_MS / 1000;
const WAV_HEADER = 44;
const SILK_HEADER = '#!SILK_V3'.length;

/** 引擎会剥掉腾讯的 0x02 前缀，碰到无标准结束帧的流时补回。 */
function getDecoderInput(input: Uint8Array): Uint8Array {
  if (input[0] === 2) return input;

  //G 标准 SILK 在帧边界写 0xffff，保留原格式。
  for (let at = SILK_HEADER; at + 1 < input.length;) {
    const size = input[at]! + input[at + 1]! * 256;
    if (size === 0xffff) return input;

    at += 2 + size;
  }
  const tencent = new Uint8Array(input.length + 1);
  tencent[0] = 2;
  tencent.set(input, 1);
  return tencent;
}

/** 按解码后的 PCM 样本数与聊天里记录的时长核对，保留一秒取整余量。 */
function checkDuration(bytes: number, expectedSeconds?: number): void {
  if (expectedSeconds === undefined) return;

  const actualSeconds = bytes / BYTE_RATE;
  if (Math.abs(actualSeconds - expectedSeconds) > 1) {
    //G 超过取整余量的音频不作为当前消息播放。
    throw new readerModule.VoiceUnavailable('音频时长与聊天记录不符', 'duration_mismatch');
  }
}

/** 把 SILK 解码成浏览器可播放的单声道 WAV，核对有记录的时长。 */
export async function decodeVoice(input: Uint8Array, expectedSeconds?: number): Promise<Buffer> {
  //G 先验证语音格式和长度，避免把坏文件送给解码器。
  const isSilk = silk.isSilk(input);
  if (!isSilk) {
    throw new readerModule.VoiceUnavailable('原音频格式无法解码', 'not_silk');
  }
  const duration = silk.getDuration(input);
  if (duration <= 0 || duration > MAX_DURATION_MS) {
    throw new readerModule.VoiceUnavailable('原音频时长异常', 'invalid_duration');
  }

  //M 用标准单声道 PCM WAV 封装解码结果，网页直接交给浏览器播放。
  let pcm: Uint8Array;
  try {
    const encoded = getDecoderInput(input);
    const decoded = await silk.decode(encoded, SAMPLE_RATE);
    pcm = decoded.data;
  } catch {
    throw new readerModule.VoiceUnavailable('SILK 解码失败', 'silk_decode_failed');
  }
  if (pcm.length === 0 || pcm.length > MAX_PCM || pcm.length % 2 !== 0) {
    throw new readerModule.VoiceUnavailable('原音频解码后数据不完整', 'invalid_pcm');
  }

  //G 声音长度与聊天记录差得太多时，不生成可播放缓存。
  checkDuration(pcm.length, expectedSeconds);
  const wav = Buffer.alloc(WAV_HEADER + pcm.length);

  //M 写 WAV 文件头和 PCM 格式标记，保持长度和数据一致。
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);

  //M 标记 24 kHz、单声道、16 位 PCM 格式。
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(BYTE_RATE, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);

  //M 写入实际 PCM 字节数和样本。
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  wav.set(pcm, WAV_HEADER);
  return wav;
}

/** 分账号、会话和消息缓存 WAV，重复播放不会重新取音。 */
export class VoiceAudio {
  /** 合并播放请求，提取或解码失败后暂不重复读取。 */
  private readonly attempts = new readerModule.MediaAttempts<Buffer>('voice');

  /**
   * @param reader 微信插件现成的按账号排队读取器。
   * @param messages 对应机器人运行时 message 目录。
   */
  constructor(private readonly reader: readerModule.Reader, private readonly messages: string) {}

  /**
   * 读取消息音频，缓存缺席时经引擎提取并写入缓存。
   * @param message 已确认在本地消息库中的语音。
   * @param expectedSeconds 微信气泡记录的时长，旧记录未提供时省略。
   */
  get(message: readerModule.VoiceMessage, expectedSeconds?: number): Promise<Buffer> {
    //M 用四段消息键做同一性校验，目录名不暴露微信账号或聊天编号。
    const key = JSON.stringify([message.account, message.chat, message.source, message.localId]);
    const hash = crypto.createHash('sha256');
    const id = hash.update(key).digest('hex');
    const known = this.attempts.getCached(id);
    if (known !== undefined) return known;

    //M 同一条音频只取一次，成功写完后其他请求读同一份缓存。
    const attempt = this.load(message, id, expectedSeconds);
    return this.attempts.track(id, attempt);
  }

  /** 读取缓存或先写临时文件再改名，免得播放器拿到半份语音。 */
  private async load(message: readerModule.VoiceMessage, id: string, expectedSeconds?: number): Promise<Buffer> {
    const dir = path.join(this.messages, `wechat_voice_${id}`);
    const file = path.join(dir, 'voice.wav');
    const cached = Bun.file(file);
    const bytes = cached.size;
    if (bytes > WAV_HEADER && bytes <= WAV_HEADER + MAX_PCM) {
      //G 已落盘的音频也按聊天记录里的时长校验。
      const pcmBytes = bytes - WAV_HEADER;
      checkDuration(pcmBytes, expectedSeconds);
      const audio = await cached.arrayBuffer();
      return Buffer.from(audio);
    }

    //M 缓存为空时只请引擎取这条已定位语音，再转成可播放格式。
    const input = await this.reader.voice(message);
    const wav = await decodeVoice(input, expectedSeconds);
    const suffix = crypto.randomUUID();
    const temp = `${file}.${suffix}.tmp`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(temp, wav, { flag: 'wx', mode: 0o600 });
    try {
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    return wav;
  }
}
