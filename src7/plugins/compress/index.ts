/**
 * 压缩：对话太长时，把前面的压成一段摘要。
 * 做法是会话里嵌一场小会话：新开一场 kind 是 compress 的会话，让它跑同一个循环写出摘要。
 * 所以压缩的每一步也落库、也发 session/change，界面上看得到压缩的过程。
 * 摘要记在这个插件自己的表里，原会话存的对话一个字不动；下一步先套上已有的摘要，不用重压。
 * 以后别的“会话里再问一次模型”的事（比如审核一条命令）照这个做法写。
 */
import type * as cordis from 'cordis';
import type { ContextEvent } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'compress';

/** 用到的服务。 */
export const inject = ['resources', 'sessions'];


/** 给压缩插件的配置：config.yaml 的 plugins.compress。 */
export interface CompressConfig {
  /** 对话到多少 token 就压缩。 */
  at: number;
  /** 压缩以后原样留下最近几条。 */
  keep: number;
}


/** 压缩。 */
class Compress {
  /**
   * 建自己的表，挂监听。
   * @param ctx Cordis 给的 ctx。
   * @param config 多长才压、留几条。
   */
  constructor(private readonly ctx: cordis.Context, private readonly config: CompressConfig) {
    //M 没有 compress_log 表就建：会话号、压到第几条、摘要、时间。
    //M ctx.on('session/context', (event) => this.onContext(event))。
    throw new Error('待实现');
  }

  /**
   * 响应 session/context：太长了就压。
   * @param event 会话和这一步要发的对话。
   * 副作用：可能新开一场小会话并跑完它；写自己的表。
   */
  private async onContext(event: ContextEvent): Promise<void> {
    //G 这场本身是 compress，或者是 default（默认对话只带最近往来，不用压）→ 不管。
    //M 表里有这场以前压过的 → 先套上：event.messages = [一条写着摘要的消息, ...压到的那一条以后的]。
    //G 估一下 event.messages 的 token 数，没到 config.at → return。
    //T 跟踪：『对话太长，开一场小会话来压缩』 变量 { 会话号, 估的 token 数, 压到第几条 }
    //M event.session.changeState('wait_compress')。
    //M 小会话 = ctx.sessions.create({ bot, kind: 'compress', parent: event.session.id })。没有渠道，不会被当成回话。
    //M 小会话.add('user', 要压缩的那一段：除了最近 config.keep 条以外的)。
    //M await 小会话.run()。它要提示词时，资源给的是压缩那一套。
    //M 摘要 = 小会话最后那句回答。小会话出错了 → 这次不压，原样发。
    //M 把（会话号、压到第几条、摘要）记进自己的表。
    //M event.messages = [一条写着摘要的消息, ...最近 config.keep 条]。
    //M event.session.changeState('running')。
    throw new Error('待实现');
  }
}


/**
 * 挂上压缩。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 CompressConfig。
 */
export function apply(ctx: cordis.Context, config: CompressConfig): void {
  //M 校验一次：at、keep 都必须是正整数；keep 不写是 6。
  new Compress(ctx, config);
}
