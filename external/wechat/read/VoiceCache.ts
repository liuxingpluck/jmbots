/**
 * 外置微信自包含的语音 WAV 缓存管理：
 * 直接复用 P2 `VoiceExtract.decodeSilkToWav` 在内存完成 SILK -> 24kHz WAV 解码，
 * 按四元组 SHA-256 原子落盘 `wechat_voice_<hash>/voice.wav` 供浏览器重复播放复用。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readerModule from './PureReader.ts';
import * as voiceExtractModule from './VoiceExtract.ts';


/** 24kHz 16-bit 单声道 PCM 每秒字节数。 */
const BYTE_RATE = 48_000;

/** 单条语音最大允许毫秒数（120 秒）。 */
const MAX_DURATION_MS = 120_000;

/** 允许缓存的最大 PCM 数据字节数。 */
const MAX_PCM_BYTES = (BYTE_RATE * MAX_DURATION_MS) / 1000;

/** 标准 RIFF WAV 头部字节数。 */
const WAV_HEADER_BYTES = 44;


/**
 * 核对已落盘缓存 WAV 的时长是否仍在气泡记录秒数的 1 秒容差内。
 * @param pcmBytes PCM 数据段字节数。
 * @param expectedSeconds 气泡记录秒数（未知时省略）。
 */
function verifyCachedDuration(pcmBytes: number, expectedSeconds?: number): void {
  if (expectedSeconds === undefined) return;

  const actualSeconds = pcmBytes / BYTE_RATE;
  if (Math.abs(actualSeconds - expectedSeconds) > 1) {
    //G 偏差超过 1 秒时拒绝把错位缓存返回给前端播放器。
    throw new readerModule.VoiceUnavailable('音频时长与聊天记录不符', 'duration_mismatch');
  }
}


/**
 * 将提取出的 SILK 字节解码成 24kHz 单声道 WAV，并将异常统一转换为 `VoiceUnavailable`。
 * @param input SILK 字节流。
 * @param expectedSeconds 可选的气泡记录时长（秒）。
 */
export async function decodeVoice(input: Uint8Array, expectedSeconds?: number): Promise<Buffer> {
  try {
    //M 委托 P2 VoiceExtract.decodeSilkToWav 完成 WASM 解码与时长核对。
    return await voiceExtractModule.decodeSilkToWav(input, expectedSeconds);
  } catch (error) {
    if (error instanceof voiceExtractModule.VoiceExtractError) {
      throw new readerModule.VoiceUnavailable(error.message, error.code);
    }
    //G 未知解码故障统一归为 silk_decode_failed。
    throw new readerModule.VoiceUnavailable('SILK 解码失败', 'silk_decode_failed');
  }
}


/**
 * 按 `(account, chat, source, localId)` 哈希隔离缓存已解码的 WAV 文件。
 */
export class VoiceAudio {
  //M 初始化语音解码并发去重与短期失败节流池。
  private readonly attempts = new readerModule.MediaAttempts<Buffer>('voice');

  /**
   * @param reader 提供 `voice(message)` 提取能力的纯 Bun 读取器。
   * @param messagesDir 存放 `wechat_voice_<hash>/voice.wav` 的本地目录。
   */
  constructor(
    private readonly reader: Pick<readerModule.Reader, 'voice'>,
    private readonly messagesDir: string,
  ) {}

  /**
   * 获取指定语音消息的 WAV 字节；缓存未命中时从媒体库直提 SILK、内存解码并原子落盘。
   * @param message 已核实在本地消息表存在的语音定位四元组。
   * @param expectedSeconds 气泡记录时长（秒）。
   */
  get(message: readerModule.VoiceMessage, expectedSeconds?: number): Promise<Buffer> {
    const key = JSON.stringify([message.account, message.chat, message.source, message.localId]);
    const id = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    //M 复用进行中的解码或短期冷却失败。
    const known = this.attempts.getCached(id);
    if (known !== undefined) return known;

    const attempt = this.loadOrDecode(message, id, expectedSeconds);
    //M 登记新的提取转码任务并维护失败冷却。
    return this.attempts.track(id, attempt);
  }

  /**
   * 优先读取现有 WAV 缓存，缺失时提取解码并通过临时文件原子重命名落盘。
   */
  private async loadOrDecode(
    message: readerModule.VoiceMessage,
    id: string,
    expectedSeconds?: number,
  ): Promise<Buffer> {
    const dir = path.join(this.messagesDir, `wechat_voice_${id}`);
    const file = path.join(dir, 'voice.wav');
    const cached = Bun.file(file);
    const bytes = cached.size;
    if (bytes > WAV_HEADER_BYTES && bytes <= WAV_HEADER_BYTES + MAX_PCM_BYTES) {
      //G 复用已有 WAV 前同样核对时长余量。
      verifyCachedDuration(bytes - WAV_HEADER_BYTES, expectedSeconds);
      const audio = await cached.arrayBuffer();
      return Buffer.from(audio);
    }

    //M 从纯 Bun 读取器直提 SILK 并在内存转成 WAV。
    const silkBytes = await this.reader.voice(message);
    const wav = await decodeVoice(silkBytes, expectedSeconds);
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
