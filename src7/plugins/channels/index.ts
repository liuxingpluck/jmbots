/**
 * 渠道协议插件 channels：渠道和机器人之间共用的事件、标准数据结构和无状态小函数（接口 A）。
 * 依赖型插件：不挂服务、不进 plugins/Index.ts 的自带名单，渠道和 bots 等插件直接 import 本文件。
 * 这里只做事件声明和汇总导出，类型和函数按主题放在同目录：
 *   - Message.ts：进来的一条消息（渠道消息、提及、附件、来源、可见性、路由、认领、撤回）；
 *   - Reply.ts：回复请求、回执、回执拼法、回复键；
 *   - TextReply.ts：只发纯文字的渠道共用的 channel/reply 响应器；
 *   - Target.ts：跨渠道、跨聊天发话（能不能跨、目标串怎么拆、候选聊天怎么认）。
 * 事件：
 *   - channel/message(message, control)：渠道收到原始消息并落盘后发出；approval 消息级指令先消费一次，bots 按 targetBots 逐个独立认领；
 *   - channel/reply(request) ↔ channel/replied(event)：所有发出去的话都走它（回复工具、零次兜底、审批直回、旧路自动回话、relay 回信、
 *     本人批准的主动发件），匹配的渠道发完回发回执，回执带着请求本身；
 *   - channel/recall(event)：渠道确认原消息撤回后发出，bots 移除排队消息并通知正在处理它的会话。
 */
import type * as messageModule from './Message.ts';
import type * as replyModule from './Reply.ts';

export * from './Message.ts';
export * from './Reply.ts';
export * from './Target.ts';
export * from './TextReply.ts';


//M 插件版本号，写成 x.y.z；不进自带名单，由 说明.md 开头和插件地图展示。
//M 1.1.0：回执带请求本身；来源快照可选，target 可带确切地址；channel/send 并进 channel/reply（主路线 2）。
export const version = '1.1.0';


declare module 'cordis' {
  interface Events {
    /**
     * 渠道收到消息并存下原件后发出：approval 消息级命令先看，随后 bots 按 targetBots 逐个独立认领。
     * 谁发：
     *   src7/plugins/cli/index.ts 的 Cli.submitLine
     *   src7/plugins/feishu/Inbound.ts 的 FeishuInbound.deliver
     *   src7/plugins/programs/ChannelBridge.ts 的 ChannelBridge.dispatch
     *   src7/plugins/progress/GroupDaily.ts 的 dispatchReport
     *   src7/plugins/voice/Tasks.ts 的 VoiceTasks.dispatch、VoiceTasks.record
     *   src7/plugins/web-api/index.ts 的 WebApi.emitChannelMessage
     *   src7/plugins/wechat/index.ts 的 Wechat.store
     * 谁接：
     *   src7/plugins/approval/index.ts 的 Approval.constructor
     *   src7/plugins/bots/index.ts 的 Bots.constructor
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'channel/message'(
      message: messageModule.ChannelMessage,
      control?: messageModule.ChannelMessageControl,
    ): void | Promise<void>;
    /**
     * 请渠道发一条（所有发出去的话都走它）：回来源快照的原消息，带 target.chat 跨聊天认目标，带 target.address 照确切地址发。
     * 匹配 channel 的渠道插件置 handled、发完回发 channel/replied；没人接单立刻回 rejected。
     * 谁发：src7/plugins/channels/Reply.ts 的 requestChannelReply
     * 谁接：
     *   src7/plugins/channels/TextReply.ts 的 registerTextReply
     *   src7/plugins/feishu/Reply.ts 的 FeishuReply.constructor
     *   src7/plugins/voice/Replies.ts 的 VoiceReplies.constructor
     */
    'channel/reply'(request: replyModule.ChannelReplyRequest): void | Promise<void>;
    /**
     * 发成了没有：渠道发完（或确认失败）经 emitReplied 回传回执，回执带着请求本身（正文、来源快照、目标）；
     * 外置程序的主动发件由 approval 补一条。记往来、记忆、网页挂回都只听它。
     * 谁发：src7/plugins/channels/Reply.ts 的 emitReplied
     * 谁接：
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.constructor
     *   src7/plugins/channels/Reply.ts 的 requestChannelReply
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'channel/replied'(event: replyModule.ChannelRepliedEvent): void;
    /**
     * 渠道确认本人或原发信人撤回消息后发出。bots 清理排队原消息，通知正在处理它的会话。
     * 谁发：src7/plugins/feishu/Inbound.ts 的 FeishuInbound.onRecall
     * 谁接：src7/plugins/bots/DispatchRecall.ts 的 DispatchRecall.listen
     */
    'channel/recall'(event: messageModule.ChannelRecallEvent): void | Promise<void>;
  }
}
