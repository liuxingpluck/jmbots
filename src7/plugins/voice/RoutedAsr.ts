/** 切换听写线路时保留尚未确认的音频，并隔离已退出线路的回调。 */

import type * as asr from './Asr.ts';
import * as routes from './Routes.ts';

/** 当前听写连接可尝试的一条线路。 */
export interface AsrRoute {
  /** 告知页面实际发往哪里。 */
  place: routes.Place;
  /** 准备一条本次听写专用的识别流。 */
  open(signal: AbortSignal): asr.Asr | Promise<asr.Asr>;
}

/** 一帧尚未由最终字幕确认的音频。 */
interface Frame {
  /** 同连接的起点样本数。 */
  at: number;
  /** 原始 PCM 样本。 */
  pcm: Int16Array;
}

/** 管理主备两条线路，最多尝试每条一次。 */
export class RoutedAsr implements asr.Asr {
  onPartial: asr.Asr['onPartial'] = () => {};
  onFinal: asr.Asr['onFinal'] = () => {};
  onProvider: routes.Report = () => {};
  onReset = (): void => {};
  onError: NonNullable<asr.Asr['onError']> = () => {};

  private readonly controller = new AbortController();
  private readonly frames: Frame[] = [];
  private stream?: asr.Asr;
  private starting: Promise<void>;
  private next = 0;
  private received = 0;
  private sent = 0;

  /** 等连接安装完回调再启用首选线路。 */
  constructor(private readonly choices: AsrRoute[], private readonly retainSamples: number) {
    //M 异步启动期间仍允许当前连接接收浏览器音频。
    this.starting = Promise.resolve().then(() => this.start());
  }

  /** 仅对支持提前断句的识别线路开放收尾。 */
  get cut(): (() => void) | undefined {
    const stream = this.stream;
    if (stream?.cut === undefined) return undefined;

    return () => {
      //M 检查处理半句时选定的线路仍在服务。
      if (this.stream !== stream) return;

      try {
        //M 只提前结束当前句，下一帧继续由同一模型接收。
        stream.cut?.();
      } catch {
        //G 切句使引擎不可用时交给备用线路恢复。
        this.fail('转写提前收尾失败');
      }
    };
  }

  /** 保留最近有界的未确认 PCM，送给已启用的引擎。 */
  accept(pcm: Int16Array): void {
    if (this.controller.signal.aborted) return;

    const at = this.received;
    this.received += pcm.length;
    //M 用绝对样本位置标记未确认的 PCM。
    this.frames.push({ at, pcm });
    //G 滑动保留量有限，长时间没有字幕时也不增长内存。
    const retainAt = Math.max(0, this.received - this.retainSamples);
    this.discardBefore(retainAt);

    const stream = this.stream;
    if (stream === undefined) return;

    //M 同步识别可能在这一帧内确认最终字幕。
    this.sent = this.received;
    this.feed(stream, pcm);
  }

  /** 主动停麦后排空已有音频，也等待在收尾期间发生的线路切换。 */
  async finish(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const starting = this.starting;
      await starting;
      if (this.starting !== starting) continue;

      const stream = this.stream;
      if (stream === undefined) return;

      try {
        //M 云端需要等最后一条转写回执；本地可能同步完成。
        await stream.finish?.();
      } catch {
        this.fail('转写收尾失败');
      }
      if (this.starting === starting) return;
    }
  }

  /** 释放当前线路与尚未确认的音频，撤销任何还在启动的线路。 */
  close(): void {
    this.controller.abort();
    this.frames.length = 0;
    //M 先清空归属再关闭，避免上游 close 回调触发切换。
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
  }

  /** 建立下一条线路，重放仍属于当前听写连接的音频。 */
  private async start(reason?: string): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted) return;

    const route = this.choices[this.next];
    if (route === undefined) {
      const failure = reason ?? '没有可用的转写线路';
      //G 主备都失败时让当前浏览器结束听写。
      this.onError(failure);
      return;
    }
    this.next += 1;
    try {
      //M 守卫放行或服务地址准备好后才取得实现。
      const stream = await route.open(signal);
      if (signal.aborted) {
        stream.close();
        return;
      }

      const replay = this.frames.slice();
      const offset = replay[0]?.at ?? this.received;
      this.stream = stream;
      stream.onPartial = (text) => {
        if (this.stream !== stream) return;

        //M 只转发当前识别流的临时字幕。
        this.onPartial(text);
      };
      stream.onFinal = (text, endSamples) => {
        if (this.stream !== stream) return;

        let end = this.sent;
        if (endSamples !== undefined) {
          end = Math.min(end, offset + endSamples);
        }
        //M 云转写按上游句尾位置清除已提交的音频，本地按当前帧确认。
        this.discardBefore(end);
        this.onFinal(text);
      };
      stream.onError = (why) => {
        if (this.stream !== stream) return;

        //G 回调仍属于当前线路才切换。
        this.fail(why);
      };

      //M 成功创建识别流才报告线路；原因随切换一起发出。
      const report = (): void => {
        if (this.stream !== stream) return;

        this.onProvider(route.place, reason);
      };
      if (stream.onReady !== undefined) {
        //M 等云端明确接受 run-task 才把标记显示给页面。
        stream.onReady = report;
      }
      if (stream.onReady === undefined) {
        report();
      }
      for (const frame of replay) {
        if (this.stream !== stream) break;

        this.sent = frame.at + frame.pcm.length;
        //M 已确认过的音频不跟着备选重复转写。
        this.feed(stream, frame.pcm);
      }
    } catch (error) {
      //G 启动异常用固定原因交给备选线路。
      const why = routes.getFailure(error, '转写线路启动失败');
      this.fail(why);
    }
  }

  /** 处理同步原生识别异常与云端发帧异常。 */
  private feed(stream: asr.Asr, pcm: Int16Array): void {
    try {
      //M 音频只能进入当前路线。
      stream.accept(pcm);
    } catch {
      this.fail('转写线路处理失败');
    }
  }

  /** 关闭当前实现，并即时为后续音频安排备用线路。 */
  private fail(reason: string): void {
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
    //G 不让已退出线路的临时字幕继续参与判断。
    this.onReset();
    //M 保留尚未确认的音频，同时让 stop 等待新的启动结果。
    this.starting = this.start(reason);
  }

  /** 移除已确认或超出保留窗口的样本。 */
  private discardBefore(end: number): void {
    while (this.frames.length > 0) {
      const first = this.frames[0]!;
      if (first.at >= end) return;

      const skip = end - first.at;
      if (skip < first.pcm.length) {
        first.pcm = first.pcm.subarray(skip);
        first.at = end;
        return;
      }
      this.frames.shift();
    }
  }
}
