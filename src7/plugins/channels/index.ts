/**
 * 渠道协议插件 channels：渠道和机器人之间共用的事件、标准数据结构和无状态小函数（接口 A）。
 * 依赖型插件：不挂服务、不进 plugins/Index.ts 的自带名单，渠道和 bots 等插件直接 import 本文件。
 * 这里只做事件声明和汇总导出，类型和函数按主题放在同目录：
 *   - Message.ts：进来的一条消息（分法和发事件 emitInbound、渠道消息、提及、附件、来源、可见性、路由、认领、撤回），
 *     说话的是谁（isOwnerTurn、getSpeakerRole、isGroup：谁是本人只在这里判）；
 *   - Reply.ts：回复请求、回执、回执拼法、回复键；
 *   - TextReply.ts：只发纯文字的渠道共用的 channel/reply 响应器；
 *   - Target.ts：跨渠道、跨聊天发话（能不能跨、目标串怎么拆、候选聊天怎么认）。
 * 事件：
 *   - channel/direct、channel/mention、channel/listen(message, control)：渠道收到原始消息并落盘后经 emitInbound 发，一条只发一个——
 *     私聊、群里叫了机器人、只听；approval 只看前两个里的批复，bots 按 targetBots 逐个独立认领（只听的记背景或判断）；
 *   - channel/history(messages)：渠道拉回来的群历史（机器人进群以前、服务停着时的话），不触发会话、不回话，只给记录类插件（memory、聊天归档）补记；
 *   - channel/reply(request) ↔ channel/replied(event)：所有发出去的话都走它（回复工具、零次兜底、审批直回、按地址发的自动回话、relay 回信、
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
//M 1.2.0：channel/message 拆成 direct、mention、listen，分法 getInboundEvent、发事件 emitInbound；
//M   删 routing.listenOnly、judge、byBot 和 BotRoutingHint，加 routing.partial（主路线 3）。
//M 1.3.0：聊天记全写 MD——ArchiveListen.ts 听 direct、mention、listen、history、replied、recall，写进聊天目录和附件/。
//M 1.5.0：ChannelMessage 加可选 accountName（收消息的账号叫什么）；聊天归档的账号目录有名字就叫“名字_ID”。
//M 1.6.0：加 channel/history（渠道拉回的历史消息，只给记录类插件补记，不进 bots）。
//M 1.7.0：聊天归档也听 channel/history，拉回的群历史写进聊天 MD。
//M 1.8.0：说话的是谁（isOwnerTurn、getSpeakerRole、isGroup）从 utils/Workspace.ts 挪进 Message.ts；删 resolveLegacyRole。
//M 1.8.1：明确按地址发的渠道协议用语。
export const version = '1.8.1';


declare module 'cordis' {
  interface Events {
    /**
     * 私聊机器人（飞书 p2p、微信、网页、命令行、语音；语音半句提前开工的带 routing.partial）。渠道存下原件后发，挨个问：
     * approval 先看是不是“同意 3”这类批复，bots 再按 targetBots 逐个机器人认领。
     * 各渠道（cli、feishu、programs、voice、web-api、wechat）都经 emitInbound 发。
     * 谁发：src7/plugins/channels/Message.ts 的 emitInbound
     * 谁接：
     *   src7/plugins/approval/Grants.ts 的 Grants.constructor
     *   src7/plugins/approval/index.ts 的 Approval.constructor
     *   src7/plugins/bots/index.ts 的 Bots.constructor
     *   src7/plugins/channels/ArchiveListen.ts 的 applyChatArchive
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     *   src7/plugins/voice/Replies.ts 的 VoiceReplies.constructor
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'channel/direct'(
      message: messageModule.ChannelMessage,
      control?: messageModule.ChannelMessageControl,
    ): void | Promise<void>;
    /**
     * 群里叫了机器人：@ 了它，或引用了它的话。和 channel/direct 一样挨个问：approval 先看批复，bots 认领 targetBots 里被叫到的机器人。
     * 各渠道（feishu、programs、wechat）经 emitInbound 发。
     * 谁发：src7/plugins/channels/Message.ts 的 emitInbound
     * 谁接：
     *   src7/plugins/approval/Grants.ts 的 Grants.constructor
     *   src7/plugins/approval/index.ts 的 Approval.constructor
     *   src7/plugins/bots/index.ts 的 Bots.constructor
     *   src7/plugins/channels/ArchiveListen.ts 的 applyChatArchive
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'channel/mention'(
      message: messageModule.ChannelMessage,
      control?: messageModule.ChannelMessageControl,
    ): void | Promise<void>;
    /**
     * 只听：机器人收到了、但没叫它的话（群里没 @，没登记的群也发；语音里只入档的整句）。approval 不审批它，只由 Grants 给地址写上授权目录。
     * bots 把 targetBots 里的机器人记进前台当背景或判断要不要接（targetBots 空的谁都不进）；memory、网页照记。
     * 各渠道（feishu、programs、voice）经 emitInbound 发。
     * 谁发：src7/plugins/channels/Message.ts 的 emitInbound
     * 谁接：
     *   src7/plugins/approval/Grants.ts 的 Grants.constructor
     *   src7/plugins/bots/index.ts 的 Bots.constructor
     *   src7/plugins/channels/ArchiveListen.ts 的 applyChatArchive
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'channel/listen'(
      message: messageModule.ChannelMessage,
      control?: messageModule.ChannelMessageControl,
    ): void | Promise<void>;
    /**
     * 渠道拉回来的一批历史消息（飞书 im/v1/messages 拉群历史：机器人进群以前、服务停着时的话），按时间从旧到新。
     * 不是新来的话：不触发会话、不回话、不问 approval，bots 不听；只给记录类插件补记（memory 入历史回填队列，按消息号去重）。
     * 谁发：src7/plugins/feishu/HistoryPull.ts 的 FeishuHistoryPull.pull
     * 谁接：
     *   src7/plugins/channels/ArchiveListen.ts 的 applyChatArchive
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     */
    'channel/history'(messages: messageModule.ChannelMessage[]): void | Promise<void>;
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
     *   src7/plugins/channels/ArchiveListen.ts 的 applyChatArchive
     *   src7/plugins/channels/Reply.ts 的 requestChannelReply
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'channel/replied'(event: replyModule.ChannelRepliedEvent): void;
    /**
     * 渠道确认本人或原发信人撤回消息后发出。bots 清理排队原消息，通知正在处理它的会话。
     * 谁发：src7/plugins/feishu/Inbound.ts 的 FeishuInbound.onRecall
     * 谁接：
     *   src7/plugins/bots/DispatchRecall.ts 的 DispatchRecall.listen
     *   src7/plugins/channels/ArchiveListen.ts 的 applyChatArchive
     *   src7/plugins/memory/ChannelIndex.ts 的 applyChannelIndex
     */
    'channel/recall'(event: messageModule.ChannelRecallEvent): void | Promise<void>;
  }
}
