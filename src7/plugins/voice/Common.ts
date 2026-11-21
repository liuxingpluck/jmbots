/** 语音插件几个文件共用的东西：渠道身份常量、字数口径、每分钟限速。Tasks.ts、Replies.ts、Turn.ts、Config.ts 用。 */

/** 语音渠道名：标准消息、回话请求里的 channel。 */
export const CHANNEL = 'voice';
/** 本机：语音没有平台账号、聊天号时用的账号号、聊天号和聊天类型。 */
export const LOCAL = 'local';
/** 网页没给设备号时的语音客户号。 */
export const CUSTOMER = 'voice:本机';
/** 断句、任务理解开始判断前最少几个字；judge.min_chars 没写时也用它。 */
export const MIN_CHARS = 6;
/** 限速窗口：一分钟。 */
const WINDOW_MS = 60_000;


/**
 * 按字数数：一个汉字、一个表情都算一个字，不按 UTF-16 长度。
 * @param text 字幕文字。
 * @returns 字数。
 */
export function getCharCount(text: string): number {
  return Array.from(text).length;
}


/** 每分钟最多判断几次：任务理解（Tasks.ts）和断句（Turn.ts）各建一个，各数各的。 */
export class MinuteLimit {
  /** 这一分钟从哪一刻开始数。 */
  private windowStart = performance.now();
  /** 这一分钟已经判断了几次。 */
  private calls = 0;

  /**
   * @param max 每分钟最多几次，来自配置 judge.max_per_minute 或 turn.max_per_minute。
   */
  constructor(private readonly max: number) {}

  /**
   * 这一分钟的名额是不是用完了；过了一分钟先从零重新数。
   * @param now 现在（performance.now()）。
   * @returns 用完了是 true。
   */
  isFull(now: number): boolean {
    //M 窗口过了一分钟：从这一刻重新数。
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.calls = 0;
    }
    return this.calls >= this.max;
  }

  /** 记一次判断。 */
  add(): void {
    this.calls += 1;
  }
}
