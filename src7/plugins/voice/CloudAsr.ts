/**
 * 云端语音转写实现：`BailianAsr`（百炼实时流式）与 `XiaomiAsr`（小米整句转写）。
 * 提供语音能量检测 `hasSpeech`，音频 PCM 仅在当前连接和有界内存缓冲区里流转，不落盘。
 * 由 `Lines.ts` 按配置装配并交给 `RoutedAsr` 做主备切换。
 */

import * as crypto from 'node:crypto';
import * as asr from './Asr.ts';
import * as routes from './Routes.ts';

/** 入口已校验的云端地址、凭据与模型。 */
export interface CloudOptions {
  /** 语音服务地址。 */
  url: URL;
  /** 仅放入请求头。 */
  apiKey: string;
  /** 此线路的模型。 */
  model: string;
  /** 一句的静音阈值。 */
  silenceMs: number;
  /** 一句的 PCM 样本硬上限。 */
  maxSamples: number;
}

/** 减少背景噪声造成的误开口，用于批量语音的分段和短停顿判断。 */
export function hasSpeech(pcm: Int16Array): boolean {
  let energy = 0;
  for (const sample of pcm) {
    energy += sample * sample;
  }
  return energy > pcm.length * 240 ** 2;
}

/** PCM 帧的内存视图，源样本在本次转写期间保持不变。 */
function getPcmBytes(pcm: Int16Array): Buffer {
  //M 浏览器采样已按 Int16 小端解码，本部署在小端主机运行。
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** 一条已授权的 Fun-ASR WebSocket。 */
export class BailianAsr implements asr.Asr {
  onPartial: asr.Asr['onPartial'] = () => {};
  onFinal: asr.Asr['onFinal'] = () => {};
  onReady = (): void => {};
  onError: NonNullable<asr.Asr['onError']> = () => {};

  private readonly socket: WebSocket;
  private readonly id = crypto.randomUUID();
  private readonly pending: Buffer[] = [];
  private readonly done = Promise.withResolvers<void>();
  private timer?: ReturnType<typeof setTimeout>;
  private transcriptTimer?: ReturnType<typeof setTimeout>;
  private queuedSamples = 0;
  private ready = false;
  private finishing = false;
  private closed = false;

  /** 先等待 task-started，再从有界队列送出已经到达的 PCM。 */
  constructor(private readonly settings: CloudOptions) {
    const headers = { Authorization: 'Bearer ' + settings.apiKey };
    //M 使用 Bun 已有的 WebSocket，不新增运行时依赖。
    const connect = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
    const options = { headers };
    const socket = new connect(settings.url, options);
    this.socket = socket;
    this.timer = setTimeout(() => this.fail('百炼连接超时'), 5000);
    socket.addEventListener('open', () => this.start());
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('error', () => this.fail('百炼连接失败'));
    socket.addEventListener('close', () => this.fail('百炼连接中断'));
  }

  /** 从当前页流送音频，握手期间暂存在内存。 */
  accept(pcm: Int16Array): void {
    if (this.closed || this.finishing) return;
    if (this.socket.bufferedAmount > this.settings.maxSamples * 2) {
      //G 持续发不出去时释放这一条线路。
      this.fail('百炼发送缓冲超限');
      return;
    }

    //M WebSocket 只接收这帧的有效字节。
    const bytes = getPcmBytes(pcm);
    if (this.ready) {
      //M 在线路就绪时直接送出二进制，不重复编码。
      this.socket.send(bytes);
      if (this.transcriptTimer === undefined && hasSpeech(pcm)) {
        //G 网络静默时有声输入也必须在有限时间内得到回应。
        this.transcriptTimer = setTimeout(() => this.fail('百炼等待字幕超时'), 8000);
      }
      return;
    }
    if (this.queuedSamples + pcm.length > this.settings.maxSamples) {
      //G 等待握手的积压超过单句预算时尝试备选。
      this.fail('百炼握手等待的音频过长');
      return;
    }
    this.queuedSamples += pcm.length;
    //M 音频等 run-task 被接受后按到达次序发送。
    this.pending.push(bytes);
  }

  /** 通知上游排空，等最终字幕或有界收尾期限。 */
  finish(): Promise<void> {
    if (this.closed || this.finishing) return this.done.promise;
    this.finishing = true;
    if (this.ready) {
      //M 握手已经就绪时立即请求最后字幕。
      this.finishTask();
    }
    return this.done.promise;
  }

  /** 取消传输并清掉排队帧。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.transcriptTimer);
    this.pending.length = 0;
    //M 取消或收尾时解除 stop 的等待。
    this.done.resolve();
    //M 请求 WebSocket 正常关闭，后续回执由 closed 过滤。
    this.socket.close();
  }

  /** 请求开始已配置的实时模型。 */
  private start(): void {
    if (this.closed) return;
    const parameters = {
      sample_rate: asr.SAMPLE_RATE,
      format: 'pcm',
      max_sentence_silence: Math.max(200, Math.min(this.settings.silenceMs, 6000)),
    };
    const payload = {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: this.settings.model,
      parameters,
      input: {},
    };
    //M 云端确认 run-task 后才传麦克风数据。
    this.send('run-task', payload);
  }

  /** 解码供应商的字幕事件和收尾回执。 */
  private receive(data: unknown): void {
    if (this.closed || typeof data !== 'string') return;
    try {
      const frame = JSON.parse(data) as {
        header?: { task_id?: string; event?: string; error_code?: string };
        payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean; end_time?: number } } };
      };
      const header = frame.header;
      if (header?.task_id !== this.id) return;
      if (header.event === 'task-started' && !this.ready) {
        clearTimeout(this.timer);
        this.ready = true;
        //M 供应商已经确认正在接收音频，开始显示云端标记。
        this.onReady();
        for (const bytes of this.pending) {
          //M 发完握手前的录音，顺序与用户说话一致。
          this.socket.send(bytes);
        }
        this.pending.length = 0;
        if (this.finishing) {
          //M 停麦发生在握手期间时补发收尾请求。
          this.finishTask();
        }
        return;
      }
      if (header.event === 'task-finished') {
        if (!this.finishing) {
          //G 服务端提前结束时当前连接仍需要可用的转写。
          this.fail('百炼提前结束听写');
          return;
        }
        //M 正常结束时释放上游并结束本轮对字幕的等待。
        this.close();
        return;
      }
      if (header.event === 'task-failed') {
        const code = header.error_code ?? '';
        let reason = '百炼转写失败';
        if (/quota|limit|throttl|balance/i.test(code)) {
          reason = '百炼额度不足或限流';
        }
        //G 供应商拒绝继续服务时交给备选。
        this.fail(reason);
        return;
      }
      const sentence = frame.payload?.output?.sentence;
      const text = sentence?.text;
      if (header.event !== 'result-generated' || typeof text !== 'string' || text === '') return;

      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = undefined;
      if (sentence?.sentence_end === true) {
        const ms = sentence.end_time;
        let end: number | undefined;
        if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
          end = Math.round(ms * asr.SAMPLE_RATE / 1000);
        }
        //M 时间戳只用于清理已确认的录音，不出本连接。
        this.onFinal(text, end);
        return;
      }
      //M 句内转写只更新当前句的临时字幕。
      this.onPartial(text);
    } catch {
      //G 协议错误结束这一条线路。
      this.fail('百炼响应无效');
    }
  }

  /** 处理正常停止过程，等待服务端送完字幕。 */
  private finishTask(): void {
    clearTimeout(this.transcriptTimer);
    //G 最终字幕仍受独立收尾期限约束。
    this.timer = setTimeout(() => this.fail('百炼收尾超时'), 5000);
    //M 继续接收转写直到 task-finished。
    this.send('finish-task', { input: {} });
  }

  /** 发送与这条识别任务配对的控制事件。 */
  private send(action: string, payload: Record<string, unknown>): void {
    const header = { action, task_id: this.id, streaming: 'duplex' };
    const frame = JSON.stringify({ header, payload });
    //M 控制帧用同一个 task ID 与供应商配对。
    this.socket.send(frame);
  }

  /** 关闭一次失败的云转写，交由外层决定切换。 */
  private fail(reason: string): void {
    if (this.closed) return;
    //M 先隔离上游迟到事件，再允许外层尝试新线路。
    this.close();
    //M 告知外层当前失败的固定原因。
    this.onError(reason);
  }
}

/** 将有界 PCM 转成小米接受的 WAV，并且只存在内存。 */
function getWave(frames: Buffer[], samples: number): string {
  const bytes = samples * 2;
  const header = Buffer.alloc(44);
  //M 将 PCM 包成微软 WAV 的 RIFF 容器。
  header.write('RIFF', 0);
  header.writeUInt32LE(bytes + 36, 4);
  //M 格式块宣告单轨 PCM 的帧格式。
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(asr.SAMPLE_RATE, 24);
  header.writeUInt32LE(asr.SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  //M 紧接着标记音频块的开始与长度。
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const wave = Buffer.concat([header, ...frames], bytes + header.length);
  return 'data:audio/wav;base64,' + wave.toString('base64');
}

/** 小米奇整句识别。同一连接的待处理语音有界且按顺序收尾。 */
export class XiaomiAsr implements asr.Asr {
  onPartial: asr.Asr['onPartial'] = () => {};
  onFinal: asr.Asr['onFinal'] = () => {};
  onError: NonNullable<asr.Asr['onError']> = () => {};

  private readonly controller = new AbortController();
  private readonly silenceSamples: number;
  private frames: Buffer[] = [];
  private count = 0;
  private sent = 0;
  private quiet = 0;
  private queued = 0;
  private queue = Promise.resolve();

  /** 把已配置的端点时长换算为样本。 */
  constructor(private readonly settings: CloudOptions) {
    this.silenceSamples = Math.round(settings.silenceMs * asr.SAMPLE_RATE / 1000);
  }

  /** 只缓存当前正在说的话，静音后开始上传这一句。 */
  accept(pcm: Int16Array): void {
    if (this.controller.signal.aborted) return;
    this.sent += pcm.length;
    //M 只有检测到开口才开始积累整句。
    const speech = hasSpeech(pcm);
    if (this.count === 0 && !speech) return;
    if (speech) {
      this.quiet = 0;
    }
    if (!speech) {
      this.quiet += pcm.length;
    }

    //M 取连续 PCM 视图，待本句结束才打包。
    const bytes = getPcmBytes(pcm);
    //M 保留本句声音的原有次序。
    this.frames.push(bytes);
    this.count += pcm.length;
    if (this.quiet >= this.silenceSamples || this.count >= this.settings.maxSamples) {
      //M 到静音端点或时长上限就提交这一句。
      this.flush();
    }
  }

  /** 停麦时把最后一段和排队的句子全部交完。 */
  async finish(): Promise<void> {
    //M 等待本连接的上传队列时也保留总期限。
    this.flush();
    const deadline = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      if (!this.controller.signal.aborted) {
        //G 收尾时限用尽，中止旧队列并通知外层。
        this.onError('小米转写收尾超时');
        //M 释放旧线路占用的音频和请求。
        this.close();
      }
      //M 有界等待结束，即使供应商尚未确认也允许备选接手。
      deadline.resolve();
    }, 16_000);
    try {
      const waits = [this.queue, deadline.promise];
      await Promise.race(waits);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 取消 HTTP 和尚未提交的句子。 */
  close(): void {
    this.controller.abort();
    this.frames = [];
    this.count = 0;
  }

  /** 一次只传一整句，等待中的音频最多保留一个当前句预算。 */
  private flush(): void {
    if (this.controller.signal.aborted || this.count === 0) return;
    if (this.queued + this.count > this.settings.maxSamples * 2) {
      //G 慢服务的输入积压不能持续增长。
      this.onError('小米待转写音频过多');
      //M 清理已经超过本连接预算的待发语音。
      this.close();
      return;
    }
    const frames = this.frames;
    const count = this.count;
    const end = this.sent;
    this.frames = [];
    this.count = 0;
    this.quiet = 0;
    this.queued += count;
    this.queue = this.queue.then(async () => {
      if (this.controller.signal.aborted) return;
      try {
        //M 上一句上传结束才提交同连接的下一句。
        const text = await this.transcribe(frames, count);
        if (this.controller.signal.aborted) return;

        //M 将句尾偏移一起发出，外层可丢弃已确认声音。
        this.onFinal(text, end);
      } catch (error) {
        if (!this.controller.signal.aborted) {
          //G 供应商错误正文不能进入线路日志。
          const reason = routes.getFailure(error, '小米转写失败');
          //M 由外层延续未确认的语音。
          this.onError(reason);
          //M 取消这条线路尚未完成的其他请求。
          this.close();
        }
      } finally {
        this.queued -= count;
      }
    });
  }

  /** 只将已切好的句子提交给已配置的小米端点。 */
  private async transcribe(chunks: Buffer[], samples: number): Promise<string> {
    //M 小米整句转写接受 WAV 数据 URI。
    const data = getWave(chunks, samples);
    const content = [{ type: 'input_audio', input_audio: { data } }];
    const messages = [{ role: 'user', content }];
    const body = JSON.stringify({ model: this.settings.model, messages, stream: false });
    const headers = { Authorization: 'Bearer ' + this.settings.apiKey, 'Content-Type': 'application/json' };
    const timeout = AbortSignal.timeout(8000);
    const signal = AbortSignal.any([this.controller.signal, timeout]);
    const options = { method: 'POST', headers, body, signal, redirect: 'error' } as const;
    //M 供应商要求整段 base64，网络响应不写文件。
    const response = await fetch(this.settings.url, options);
    if (!response.ok) {
      await response.body?.cancel();
      throw routes.getHttpFailure(response.status);
    }
    const result = await response.json() as { choices?: { message?: { content?: string } }[] };
    const text = result.choices?.[0]?.message?.content;
    //G 上游未按契约返回文字时调整线路。
    if (typeof text !== 'string') throw new routes.RouteFailure('小米转写响应无效');
    return text;
  }
}
