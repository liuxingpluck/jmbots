/** 服务 ctx.frontDesk 的入口，组装派活、认领、结果队列和撤回。 */
import * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import type * as protocol from '../../Channels.ts';
import * as claimModule from './DispatchClaim.ts';
import * as recallModule from './DispatchRecall.ts';
import * as resultsModule from './DispatchResults.ts';
import * as toolsModule from './DispatchTools.ts';
import type { AcceptReceipt, FrontTask, QueueItem, ResultInput } from './DispatchResults.ts';
import type { FrontDesk } from './FrontDesk.ts';
import type { Bot, ReceiveEvent } from './index.ts';

export { normalizeLegacyReceipt } from './DispatchResults.ts';
export type {
  AcceptReceipt, FrontTask, QueueItem, ReplyControl, ReplyPolicy, ResultInput, ResultPayload, Stage,
} from './DispatchResults.ts';

declare module 'cordis' {
  interface Context {
    /**
     * 前台派后台和结果队列，实现在 src7/plugins/bots/Dispatch.ts 的 Dispatch。
     * agent-tasks 交回结果调 acceptResult；Bot.receive 收消息调 receive。
     */
    frontDesk: Dispatch;
  }
}


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 前台派的后台（hand_session 开的）才有：原前台、第几轮、工作区、派活时的地址、暂停。 */
    frontTask?: FrontTask;
    /** 结果队列：前台排后台和外部 AI 交回的结果、整理时用户新说的话；后台排外部 AI 交回的结果。处理完的留最近 KEEP 项，去重和 list_sessions 用。 */
    resultQueue?: QueueItem[];
    /** 正在处理的那一项的键；没在处理没有这项。 */
    activeKey?: string;
    /**
     * 后台绑定的工作区 ID（workspaces 插件的表）：hand_session new 时定下；append、bots.route 换回话地址都不改它，progress 转新会话照抄。
     * 老的没绑定的后台 append 时照旧落一遍目录再补上。
     */
    workspaceId?: string;
  }
}

/** 前台派后台与结果队列的服务入口。 */
export class Dispatch extends cordis.Service {
  private readonly results: resultsModule.DispatchResults;
  private readonly claims: claimModule.DispatchClaim;

  /** 保留原来的服务名、工具和监听顺序。 */
  constructor(ctx: cordis.Context, private readonly desk: FrontDesk) {
    super(ctx, 'frontDesk');

    //M 队列在原来的插件上下文收结果，认领和撤回都操作同一份队列。
    const recall = new recallModule.DispatchRecall(ctx, desk);
    this.results = new resultsModule.DispatchResults(ctx, recall);
    this.claims = new claimModule.DispatchClaim(ctx, desk, this.results);

    //M 顺序与拆分前一致，先挂派活工具，再处理收尾、恢复和撤回。
    new toolsModule.DispatchTools(ctx, desk);
    this.results.listen();
    recall.listen(this.results);
  }

  /** 把结果、去重与同步收尾交给同一个持久化队列。 */
  acceptResult(input: ResultInput, commitSource: () => void): AcceptReceipt {
    //M 沿用对其他插件开放的结果入口。
    return this.results.acceptResult(input, commitSource);
  }

  /**
   * 认领一条标准消息、排进前台单队列（channel_tool），前台空着就开始跑。
   * @param bot 目标机器人。
   * @param message 标准消息。
   * @param botOrigin 该机器人独立的兼容地址快照。
   * @param botText 规范化文本（含本机器人工作区物化后的附件提示）。
   * @param claimKey 去重认领键。
   * @param control 可选协调对象。
   * @param target 指定的前台（消息带 routing.sessionId、bots 已核对过是这个机器人的前台）；不给按来源范围找。
   */
  claimChannelMessage(
    bot: Bot,
    message: protocol.ChannelMessage,
    botOrigin: { channel: string; address: Record<string, unknown> },
    botText: string,
    claimKey: string,
    control?: protocol.ChannelMessageControl,
    target?: Session,
  ): Promise<void> {
    //M 沿用 frontDesk 的渠道认领入口，由认领模块处理消息。
    return this.claims.claimChannelMessage(bot, message, botOrigin, botText, claimKey, control, target);
  }

  /**
   * 收一条消息：Bot.receive 问完 bot/receive 后调。
   * 先交给前台定去向（没人认领的进这个客户的前台对话），再看那场前台是不是正在整理后台结果（是就先排着）。
   * 两步的先后和并进 bots 之前一样：前台、排着原来是 bot/receive 最后两个听的。
   * @param event 收到的消息；定了会话填 event.session，只记不回、排着的写 handled。
   */
  async receive(event: ReceiveEvent): Promise<void> {
    //M 没人认领的进这个客户的前台对话；已经认领、处理掉的，onReceive 不动。
    await this.desk.onReceive(event);

    //M 那场会话正在整理后台结果：用户的话先排着。
    this.results.hold(event);
  }
}
