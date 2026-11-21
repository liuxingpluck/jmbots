/** 小停顿时判断最新的半句，继续说或字幕变化时撤销过期的结果。 */

import * as asr from './Asr.ts';
import * as cloud from './CloudAsr.ts';
import * as common from './Common.ts';
import type * as models from './Models.ts';
import type * as routes from './Routes.ts';

const PROMPT = '判断这段转写在当前停顿处是否已经说完。'
  + '缺后半句、缺宾语、提到接下来还有内容或无法确定时回答 NO。'
  + '即使是闲聊或简短回答，只要句意完整，也可回答 YES。';

/** 每轮麦克风连接只保留一个可撤销的断句判断。 */
export class Turn {
  private active?: AbortController;
  private quiet = 0;
  private text = '';
  private judged = '';
  private readonly pauseSamples: number;
  /** 每分钟最多判断几次（turn.max_per_minute）。 */
  private readonly limit: common.MinuteLimit;

  /** 输入每次判断的通用模型、最短停顿和实际线路的回报出口。 */
  constructor(
    private readonly predict: models.Predict,
    pauseMs: number,
    maxPerMinute: number,
    private readonly report: (place?: routes.Place, reason?: string) => void,
  ) {
    this.pauseSamples = pauseMs * asr.SAMPLE_RATE / 1000;
    this.limit = new common.MinuteLimit(maxPerMinute);
  }

  /** 转写器更新当前句时，旧字幕尚在飞行的判断即作废。 */
  update(text: string): void {
    if (text === this.text) return;

    this.text = text;
    //G 字幕内容变动后旧请求不能切断新内容。
    this.active?.abort();
    this.active = undefined;
  }

  /** 最终字幕、切换和停麦都结束当前候选。 */
  reset(): void {
    //G 重置停顿和已判快照，不把上一句的停顿算给新句。
    this.active?.abort();
    this.active = undefined;
    this.text = '';
    this.judged = '';
    this.quiet = 0;
  }

  /** 只在有实际停顿、字幕及可提前收尾的 ASR 时发起判断。 */
  accept(pcm: Int16Array, cut?: () => void): void {
    //M 与整句云转写共用同一帧的声能口径。
    const speaking = cloud.hasSpeech(pcm);
    if (speaking) {
      this.quiet = 0;
      //G 继续说话时即刻撤掉待定的断句结果。
      this.active?.abort();
      this.active = undefined;
      return;
    }

    this.quiet += pcm.length;
    const text = this.text;
    //G 停顿不够长、字太少（和任务理解同一个口径：按字数数、默认 MIN_CHARS）都不判。
    if (cut === undefined || this.quiet < this.pauseSamples) return;
    if (common.getCharCount(text) < common.MIN_CHARS) return;

    if (this.active !== undefined || this.judged === text) return;

    //G 断句模型也有单连接限速，超出则让既有静音收尾。
    const now = performance.now();
    if (this.limit.isFull(now)) return;

    this.limit.add();
    this.judged = text;
    const controller = new AbortController();
    this.active = controller;
    const signal = controller.signal;
    //M 等待模型期间继续收音，仅采用这次短停顿仍然有效的结果。
    void this.predict(PROMPT, text, signal, this.report).then((complete) => {
      if (signal.aborted || complete !== true) return;

      cut();
    }).catch(() => {
      //G 模型失败继续由 ASR 的正常端点收尾。
    }).finally(() => {
      if (this.active === controller) {
        this.active = undefined;
      }
    });
  }
}
