/**
 * 跟踪点：骨架和插件在关键的地方各发一个，说清“现在走到哪个模块的哪个函数、在干什么”。
 * 骨架只管发，不管打印；打印是 plugins/trace 的事。没挂打印插件时没人听，发了等于没发。
 * 写法：this.ctx.emit('trace', { module: 'Bots', fn: 'receive', text: '收到一条消息', vars: () => ({ … }) })。
 * 伪代码里 //T 开头的一行，就是这里要发一个跟踪点。
 */

declare module 'cordis' {
  interface Events {
    /** 一个跟踪点。只是通知，谁也不许靠它改流程。 */
    'trace'(point: TracePoint): void;
  }
}


/** 一个跟踪点。 */
export interface TracePoint {
  /** 哪个模块或插件：Bots、Sessions、plugins/cli…… */
  module: string;
  /** 哪个函数：receive、run、onCalls…… */
  fn: string;
  /** 是在响应哪个事件；不是在响应事件时不写。 */
  event?: string;
  /** 哪场会话的；还没有会话时（比如渠道刚收到话）不写。 */
  session?: string;
  /** 给人看的一句话：现在在干什么。 */
  text: string;
  /** 给写代码的人看的一句：对应的那行调用，比如 chat(request)。 */
  code?: string;
  /** 关键变量。写成函数，没人听的时候不会去算。 */
  vars?: () => Record<string, unknown>;
}
