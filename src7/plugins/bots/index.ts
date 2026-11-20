/**
 * 机器人：名单，加上每个机器人怎么收消息、进哪场会话、怎么把事交给后台会话。
 * 骨架只管“一场会话怎么跑”；会话属于哪个机器人、话从哪个渠道来、回话往哪送，都是这个插件记在会话上的。
 *
 * 渠道（命令行、HTTP、飞书）直接调 Bot.receive，不走事件。
 * 机器人收到消息以后先问一圈“谁要认领这条消息”（事件 bot/receive）：relay 转外部助手、微信按客户开会话、approval 认出“同意 3”。
 * 没人认领的，进这个机器人对这个客户的前台对话（FrontDesk.ts）：简单的前台自己答，要干活就派后台（Dispatch.ts），
 * 后台的结果先回前台整理，再发回原渠道。前台整理结果时用户的新话先排着（DispatchResults.hold）。
 * 想换一种分派办法：写一个插件听 bot/receive，把 event.session 填上，前台就不接这条了。
 * 渠道（命令行、HTTP、飞书、微信、语音）向本服务登记渠道名：ctx.bots.channel(name)（网页的渠道清单用）；收话调 ctx.bots.receive，附件调 ctx.bots.saveFile。
 * 所有发出去的话都走 channel/reply → channel/replied：会话跑到一半先说一句调 ctx.bots.say（通知 bot/say），
 *   要等发完、拿回执的（一轮结束自动回话、前台送后台结果）由 Bots.send 照会话记的渠道和地址发 channel/reply；会话标了 quiet 的，本服务不自动发它的话。
 * 2026-11-17 插件 bot-front-desk 并进来（用户 #114、#115）：前台的配置写在本插件 config 的 front 一节。
 * 2026-11-17 插件 prompt（Prompt.ts，系统提示词）、reply-tool（ReplyTool.ts，工具 reply）并进来：开关写在 config 的 prompt、reply_tool。
 * 进来的三个渠道事件（飞书、网页、命令行、微信、语音、外部程序都走它们，onChannelMessage）：
 *   channel/direct（私聊）、channel/mention（群里叫了机器人）：问完 bot/receive 没人认领的进前台单队列，
 *   模型一轮里用 channel_reply 想发几条发几条；一对一的渠道（routing.autoFinal）一次没调就把最后的话发出去，飞书跑一次修复轮。
 *   channel/listen（只听）：targetBots 里的机器人各自在地址副本上标 listenOnly，前台只记背景；
 *     登记了 judge 的群进群攒批（GroupBatch.ts，config 的 group_batch）：攒一批再问决策模型要不要接，有人叫机器人时攒着的话一起带上。
 *   消息带 routing.sessionId（网页指定会话、引用别的渠道的消息）：只投给那场会话的机器人；是前台就排进那场前台，别的会话照旧交过去、一轮结束自动回。
 * 插件请机器人干活、回话却要像回一条消息那样发到某个聊天的（群日报），发 bot/request 的 hand 带 replyTo：排进前台，按外人算。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type { Session, Thinking } from '../../Sessions.ts';
import * as botUtils from '../../utils/Bots.ts';
import type { BotConfig } from '../../utils/Bots.ts';
import * as namesModule from '../../utils/Names.ts';
import * as filesModule from '../../utils/Files.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as protocol from '../channels/index.ts';
import { ChannelTools } from './ChannelTools.ts';
import * as claimModule from './DispatchClaim.ts';
import { Dispatch, type AcceptReceipt, type ResultInput } from './Dispatch.ts';
import { FrontDesk, type FrontDeskConfig } from './FrontDesk.ts';
import * as groupBatchModule from './GroupBatch.ts';
import { Prompt } from './Prompt.ts';
import { registerReplyTool } from './ReplyTool.ts';

export { normalizeAutoReplyReceipt, type ReplyControl, type ReplyPolicy } from './Dispatch.ts';

/** 插件名。 */
export const name = 'bots';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.2.1：渠道和机器人解耦第 1 步——听 channel/message 按机器人独立认领、channel_reply/history 工具与零次回复兜底。
//M 1.3.0：工作区交给 workspaces 插件——建机器人时原地登记默认工作区和配置里的目录，hand_session 可写 workspaceId，后台绑定工作区 ID。
//M 1.4.0：并进 prompt（Prompt.ts，默认开）、reply-tool（ReplyTool.ts，默认关）；自动回话渠道的消息在这里交前台。
//M 1.4.1：渠道统一第 3、4 步——routing.sessionId 指定会话；网页、命令行、微信也走 channel_tool（去掉 deliveryMode）；
//M   routing.autoFinal 零次回复直接发最后的话；一轮收尾发 bot/settled。
//M 1.4.2：结果队列的来源加 relay（外部助手的回信），前台看到“外部助手 <名字> 的回信”。
//M 1.4.3：监听 channel/recall，消息被撤回时移除排队项、喊停正在跑的会话及派出的后台会话，且不再回发“已停止”。
//M 1.4.4：channel_reply 支持非群聊本人（canReplyAcrossChats）指定 channel、chat 往别的渠道或聊天发话。
//M 1.4.5：跨渠道 channel_reply 改为发 target 交目标渠道自己认聊天，bots 不再查各渠道数据。
//M 1.4.6：插件互调改事件第一阶段——听 bot/request（hand、save-file、add、accept-result）回 bot/result，听通知 bot/route；
//M   前台的“先查记忆”提示交给 memory 自己加，记往来、搜聊天记录、算向量改发 memory/request；模型介绍改发 model-catalog/request（prompt）。
//M 1.4.9：写出内嵌出厂提示词的 exportFile 从骨架 utils/Embedded.ts 挪进 bots/Prompt.ts，只有这里用。
//M 1.5.0：本人才能在提示中加载私人记忆文件；其他人按来源归属召回聊天记录。
//M 1.5.1：前台构造函数瘦身：三个查历史工具的定义挪到模块顶上，长监听体挪成 onChange、onReplied、onReply。
//M 1.5.11：Bots.send 按地址发 channel/reply（target 带会话记的地址），渠道只登记名字；删 bot/route；
//M   前台只听 channel/replied 记往来（回执带请求正文），不再暂存 channel/reply 的正文。
//M 1.6.0：channel/message 拆成 direct、mention、listen 三个监听（listen 由 bots 自己在地址副本上标 listenOnly）；
//M   voice/dispatch 并进 channel/direct；bot/request 的 hand 加 replyTo（群日报改走它，不再拼假的群消息）。
//M 1.6.1：受管后台同轮 final 持久交回一次，progress 与失败回执独立保留。
//M 1.6.2：群攒批（GroupBatch.ts）：listen: judge 的群攒一批（安静 N 秒或满 M 句）再问决策模型，每群每天上限；
//M   数从 config 的 group_batch 读，缺键不开；判断改发 decision/judge；bot/judged 一批一次；有人叫机器人时攒着的话一起带上。
//M 1.6.4：是不是本人改问 channels 的 isOwnerTurn（删 isNonOwnerSpeaker）；SessionRow.customer 只在这里声明。
//M 1.6.5：自动回话模式与按地址发送的回执改名，保留会话存值和持久化回执键。
//M 1.6.6：ready 时看 memory 开工没有，改读挂载结果的 state。
//M 1.6.7：requestEvent 改新写法（云端 19 第 1、2 条）：查前台归档、取模型介绍不掐表；群攒批问决策模型只报警（decision 自己限时）。
//M 1.6.8：群攒批判定要接话时，地址带 judgeHelper（飞书群登记的 judge_helper）的这一批记成背景、经 bot/receive 转给该外部助手（DispatchClaim.relayBatch，#318）。
//M 1.6.9：Bots 构造函数只做登记（回调挪成 onReady/onChange/onSay/onRequestError）；认领记录与结果队列收尾分别合成共用函数（云端20 #2/#4）。
export const version = '1.6.9';

/**
 * 用到的服务。tools：前台登记六个工具（history 三个在 FrontDesk.ts，派活三个在 DispatchTools.ts），开了 reply_tool 再加 reply。
 * workspaces：建机器人时登记工作区，前台派后台时选工作区（plugins 段要写在本插件前面）。
 */
export const inject = ['resources', 'sessions', 'tools', 'workspaces'];


declare module 'cordis' {
  interface Context {
    /** 机器人服务，实现在 src7/plugins/bots/index.ts。 */
    bots: Bots;
  }
  interface Events {
    /**
     * 机器人收到一条消息，先问一圈：谁要认领。照插件挂上去的先后一个个 await。
     * 要认领的插件把 event.session 填上；前面已经有人填了，后面的不要再填。监听的函数不许有返回值。
     * 插件（比如 approval 认出“同意 3”）可以写 event.handled = true：这条已经处理掉，不进任何会话。
     * 问完没人认领的，本插件的前台接（FrontDesk.onReceive）。
     * 谁发：
     *   src7/plugins/bots/DispatchClaim.ts 的 DispatchClaim.relayBatch
     *   src7/plugins/bots/index.ts 的 Bot.receive、Bots.onChannelMessage
     * 谁接：
     *   src7/plugins/approval/index.ts 的 Approval.constructor
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     *   src7/plugins/tutorial/State.ts 的 Shots.constructor
     *   src7/plugins/voice/index.ts 的 apply
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'bot/receive'(event: ReceiveEvent): void | Promise<void>;
    /**
     * 会话跑到一半先跟用户说一句（通知）。本插件听它：按会话的渠道发出去，前台再记一条往来。
     * 谁发：
     *   src7/plugins/approval/index.ts 的 Approval.answer、Approval.ask
     *   src7/plugins/base-bridge/UpdateWatch.ts 的 UpdateWatch.tell
     *   src7/plugins/bots/index.ts 的 Bots.say
     *   src7/plugins/progress/index.ts 的 Progress.end、Progress.handOff、Progress.sendCard、Progress.setLimit
     * 谁接：
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.constructor
     *   src7/plugins/bots/index.ts 的 Bots.constructor
     *   src7/plugins/journal/index.ts 的 Journal.listen
     */
    'bot/say'(session: Session, text: string): void;
    /**
     * 通知一轮 channel_tool 已收尾，网页标记回复完成，命令行记录失败的退出码。
     * 谁发：src7/plugins/bots/DispatchResults.ts 的 DispatchResults.emitSettled
     * 谁接：
     *   src7/plugins/cli/index.ts 的 Cli.constructor
     *   src7/plugins/voice/index.ts 的 apply
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'bot/settled'(event: protocol.ChannelSettledEvent): void;
    /**
     * 群攒批（GroupBatch.ts）看完一批群里没叫机器人的话（listen: judge）：接不接、今天看满了没。一批发一次，晚于收话那一刻，渠道听它补记一行流水。
     * address 是这一批最后一句的地址，text 是这一批（一行一句“说话人：话”），outcome 是 judge:回 / judge:不回(0.32) / judge:不看(今天看满 N 次) 这类。
     * 谁发：src7/plugins/bots/GroupBatch.ts 的 GroupBatch.look
     * 谁接：src7/plugins/feishu/Contacts.ts 的 FeishuContacts.constructor
     */
    'bot/judged'(address: unknown, text: string, outcome: string): void;
    /**
     * 别的插件请机器人办事（serial 发、等 bot/result，用 utils/RequestEvent.ts 的 requestEvent）。本插件听，按 action 调现有方法。
     * 谁发：
     *   src7/plugins/progress/GroupDaily.ts 的 dispatchReport
     *   src7/plugins/progress/index.ts 的 Progress.handOff
     *   src7/plugins/relay/AgentTasks.ts 的 requestResultDelivery
     *   src7/plugins/settings/index.ts 的 Settings.createBot
     *   src7/plugins/web-api/index.ts 的 WebApi.saveAttachments
     *   src7/plugins/work-decision/Routes.ts 的 mount
     * 谁接：src7/plugins/bots/index.ts 的 Bots.constructor
     */
    'bot/request'(request: BotRequest): void | Promise<void>;
    /**
     * bot/request 的回执（emit），按 requestId 配对。
     * 谁发：src7/plugins/bots/index.ts 的 Bots.constructor
     * 谁接：
     *   src7/plugins/progress/GroupDaily.ts 的 dispatchReport
     *   src7/plugins/progress/index.ts 的 Progress.handOff
     *   src7/plugins/relay/AgentTasks.ts 的 requestResultDelivery
     *   src7/plugins/settings/index.ts 的 Settings.createBot
     *   src7/plugins/web-api/index.ts 的 WebApi.saveAttachments
     *   src7/plugins/work-decision/Routes.ts 的 mount
     */
    'bot/result'(result: BotResult): void;
  }
}


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 属于哪个机器人。 */
    bot: string;
    /** 回话往哪个渠道送：最后一句带渠道的话从哪来。小会话没有，所以没人给它回话。 */
    channel?: string;
    /** 渠道自己认得的回话地址，和 channel 一起记。形状归各渠道（HTTP 是 { messageId }，飞书是哪个应用、哪个聊天）。 */
    address?: unknown;
    /**
     * 客户号：渠道在回话地址里写的 address.customer，换回话地址时由 Bots.route 抄到这里（也可在建会话时直接给）。
     * 只在这里声明一次；别的插件（memory、wechat……）只读，不要自己推。
     */
    customer?: string;
    /**
     * 这一轮结束的回话不由 bots 自动发，由设它的插件自己送（中途先说的一句 bot/say 照发）。
     * 现在是前台派的后台（结果交回前台整理）和前台整理后台结果的那一轮（前台等回执）设它，见本目录 Dispatch.ts。
     */
    quiet?: boolean;
    /** 本场会话已认领过的消息去重键列表 JSON.stringify([messageId, botName])。 */
    sourceClaims?: string[];
    /** 当前前台会话绑定的稳定来源域。 */
    sourceScope?: { channel: string; accountId: string; chatId: string };
    /** 当前正在处理的活动轮不可变来源快照（自动回话轮没有）。 */
    activeSourceSnapshot?: protocol.SourceSnapshot;
    /** 持久会话中的撤回停跑标记，收尾时清掉。 */
    recalledStop?: boolean;
  }
}


/**
 * Bots.send 交回的回执（从渠道的 channel/replied 回执折过来）。
 *   accepted  渠道明确收下了全部内容（sent，或排队、存成草稿）；不代表用户已读
 *   partial   收下了一部分（比如文字发了、某个附件没发出去）
 *   uncertain 不知道发没发到：超时、网络断了
 *   rejected  渠道明确没收（地址不对、接口报错、渠道没挂）
 */
export interface SendReceipt {
  /** 发到没有，见上。 */
  status: 'accepted' | 'partial' | 'uncertain' | 'rejected';
  /** 原因，人看的；accepted 时是空串。 */
  reason: string;
}


export type { BotConfig } from '../../utils/Bots.ts';


/** 渠道送进来的一条消息。 */
export interface IncomingMessage {
  /** 从哪个渠道来：cli、http、feishu…… */
  channel: string;
  /** 给哪个机器人。 */
  bot: string;
  /** 用户说的话。 */
  text: string;
  /** 毫秒时间戳。 */
  time: number;
  /** 渠道自己认得的回话地址；这里不解释，原样记到会话上，回话时渠道自己拿。 */
  address?: unknown;
  /** 标准消息号（进来的三个渠道事件的 messageId）；从渠道事件转进来的才有。web-api 记别的渠道的消息时存它，回话按它精确挂回。 */
  sourceId?: string;
}


/** 这句话从哪来：渠道名和回话地址。会话照它记回话往哪送。 */
export interface Origin {
  /** 渠道名；不给就不改会话原来记的渠道和地址。 */
  channel?: string;
  /** 回话地址；只在给了渠道时才记。 */
  address?: unknown;
}


/** 事件 bot/receive 的数据。 */
export interface ReceiveEvent {
  /** 是哪个机器人收到的。 */
  bot: Bot;
  /** 收到的那条消息。 */
  message: IncomingMessage;
  /** 这条消息进哪场会话；认领的插件填，没人认领由前台填。 */
  session?: Session;
  /** 前面的插件已经把这条处理掉了：写了 true，这条就不进任何会话。 */
  handled?: boolean;
  /** 由进来的三个渠道事件转入每机器人分派（approval 已在消息级处理过一次，不再重复消耗）。 */
  fromChannelEvent?: boolean;
}


/**
 * bot/request 的 hand 带的 replyTo：这件活的回话像回一条消息那样，由模型用 channel_reply 发到哪个聊天（群日报）。
 * bots 照它拼一份来源快照，按外人算（guest、不受信）；不经渠道事件，记忆不会把交办的话当成聊天里的一句。
 */
export interface ReplyTo {
  /** 渠道名。 */
  channel: string;
  /** 平台账号（飞书应用号）。 */
  accountId: string;
  /** 聊天号。 */
  chatId: string;
  /** 聊天种类。 */
  chatType: protocol.ChannelChatType;
  /** 渠道认得的回话地址（飞书：appId、chatId、chatType……），原样放进来源快照。 */
  address: Record<string, unknown>;
  /** 这件活的号：拼进标准消息号，同一个号同一场会话只排一次（群日报是“群:日期”）。 */
  key: string;
  /** 交活的是谁，记成这一轮的发话人（群日报写“群进度定时任务”）。 */
  sender: { id: string; name?: string };
}


/** 事件 bot/request 的数据：action 分四种（契约 3.2 第 4 条）。 */
export type BotRequest = requestEventModule.RequestEnvelope & ({
  /**
   * 把一件事交给这个机器人的一场后台（同 Bot.hand）。progress 转新会话时发。
   * 带 replyTo 的不开后台：排进 sessionId 那场前台（没给按 replyTo 的聊天找前台），回话照 replyTo 发。progress 群日报发。
   */
  action: 'hand';
  /** 交给哪个机器人。 */
  bot: string;
  /** 要办的事。 */
  text: string;
  /** 办完回话往哪送；不给渠道就不改那场会话原来记的。带 replyTo 时不用它。 */
  origin: Origin;
  /** 接着哪一场；不给新开一场。 */
  sessionId?: string;
  /** 回话像回一条消息那样发到哪个聊天；不给照旧交后台。 */
  replyTo?: ReplyTo;
} | {
  /** 渠道收到的图片、文件存进机器人的工作区（同 Bots.saveFile）。web-api 上传时发。 */
  action: 'save-file';
  /** 给哪个机器人。 */
  bot: string;
  /** 原来的文件名。 */
  name: string;
  /** 文件内容。 */
  data: Uint8Array;
} | {
  /** 运行中新建一个机器人（同 Bots.add）。settings 新建机器人时发。 */
  action: 'add';
  /** 名单里的一项：要有非空的 name，别的项（language 等）原样留着。 */
  config: BotConfig;
} | {
  /** 一份结果排进会话的结果队列（同 Dispatch.acceptResult，不带收尾回调）。relay 交回结果时发，收到回执后自己改它的表。 */
  action: 'accept-result';
  /** 结果键、交给哪场、从哪来、回到哪、正文和文件。 */
  input: ResultInput;
});


/** 事件 bot/result 的数据：bot/request 的回执，每种 action 只带自己那一项。 */
export interface BotResult extends requestEventModule.ResultEnvelope {
  /** 办成没有。 */
  ok: boolean;
  /** hand：交给了哪一场。 */
  sessionId?: string;
  /** save-file：存下的绝对路径。 */
  path?: string;
  /** add：建好的机器人名、工作区、记忆目录。 */
  bot?: { name: string; workspace: string; memory: string };
  /** accept-result：queued 新排进去，duplicate 同键同内容收过；带结果键。 */
  receipt?: AcceptReceipt;
  /** 没办成的原因。 */
  error?: string;
}


/** 校验以后给机器人服务的东西。 */
export interface BotsConfig {
  /** 机器人名单，照 config.yaml 里 bots 写的先后。 */
  bots: BotConfig[];
  /** 后台会话（干活的会话）用哪个思考档。 */
  thinking: Thinking;
}


/** 机器人服务：名单。 */
export class Bots extends cordis.Service {
  /** 机器人名 → 机器人，照名单的先后。 */
  private readonly bots = new Map<string, Bot>();

  /** 后台会话用哪个思考档；运行中新加的机器人也用它。 */
  private readonly thinking: Thinking;

  /** 挂着的渠道名，照登记的先后。渠道插件挂上时登记，拔掉时撤掉；网页的渠道清单用。 */
  private readonly channels = new Set<string>();

  /**
   * bots 插件自己的 ctx，交给每个 Bot。别的插件调 ctx.bots.add 时（设置页新建机器人），this.ctx 是调用方的 ctx（Cordis 服务的规矩），
   * 拿它建的 Bot 收消息时取不到本插件的 frontDesk、调用方没 inject 的 sessions，所以建 Bot 一律用它。
   */
  private readonly home: cordis.Context;

  /**
   * 登记 bots 插件：把 Bots 作为服务挂到 Cordis 上（以后用 ctx.bots 取）；照名单建好每个机器人；
   * 构造函数只做事件和请求监听登记，具体处理写在下面的类方法里。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 名单、后台会话的思考档。
   * @throws 名单里有空名字、重名时抛错。
   */
  constructor(ctx: cordis.Context, config: BotsConfig) {
    super(ctx, 'bots');
    this.home = ctx;
    this.thinking = config.thinking;

    //M 照名单一个个建机器人：启动时和运行中新建（设置页）走同一个 add，校验、建目录都在里面。
    for (const item of config.bots) {
      this.add(item);
    }

    //M 插件都挂过后检查一次归档服务；memory 可选，缺失时前台仍可答话。
    this.ctx.once('ready', () => this.onReady());

    //M 会话状态变了（跑完、出错、被停）就看要不要把这一轮的回话发回渠道。
    this.ctx.on('session/change', (session) => this.onChange(session));

    //M 会话中途先说一句（bots.say 发的通知 bot/say）。
    this.ctx.on('bot/say', (session, text) => this.onSay(session, text));

    //M 私聊、群里叫了机器人：每个 targetBot 独立物化附件、过 bot/receive 兼容关口、各自认领进自己的会话。
    this.ctx.on('channel/direct', (message, control) => this.onChannelMessage(message, false, control));
    this.ctx.on('channel/mention', (message, control) => this.onChannelMessage(message, false, control));

    //M 只听：targetBots 里的机器人只记背景（或问决策模型要不要接）；targetBots 空的谁都不进。
    this.ctx.on('channel/listen', (message, control) => this.onChannelMessage(message, true, control));

    //M 挂上 bot/request 的监听，收到请求就办，办完回一个 bot/result；抛错转成 { ok: false, error }。
    const requestOptions = {
      onError: (error: unknown) => this.onRequestError(error),
    };
    requestEventModule.onRequestEvent(
      this.ctx,
      'bot/request',
      'bot/result',
      (request) => this.onRequest(request),
      requestOptions,
    );
  }

  /** ready：全部插件发起挂载后检查 memory 是否就绪，没起只打一条警告，不挡答话。 */
  private onReady(): void {
    const status = this.ctx.resources.pluginStatus;
    const memory = status.find((item) => item.name === 'memory');
    if (memory?.state === 'ok') return;

    console.warn('bots：memory 插件未启动，前台往来不会保存，历史往来暂时无法读取。');
  }

  /**
   * session/change：跑完、出错、被停的会话，看要不要把 row.reply 自动发回原渠道；
   * 还在转、没有渠道（小会话）、别人自己送（quiet）、启用了 channel_tool 或已标撤回停跑的一律不发。
   * @param session 状态变化的会话。
   */
  private onChange(session: Session): void {
    const row = session.row;
    if (row.state === 'running' || row.channel === undefined) return;
    if (row.quiet === true || row.activeSourceSnapshot !== undefined) return;

    //G 升级前已标记撤回停跑的旧轮次，沿用原收尾规则。
    const activeItem = (row.resultQueue ?? []).find((item) => item.key === row.activeKey);
    const activeOutcome = activeItem?.replyControl?.outcome;
    if (row.recalledStop === true || activeOutcome === 'recalled') return;

    //T 跟踪：回话。
    const vars = { channel: row.channel, session: row.id, state: row.state, textLength: row.reply.length };
    this.ctx.emit('trace', 'Bots.onChange', 'trace.bots.deliverReply', 'this.send(session, reply)', vars);
    void this.send(session, row.reply);
  }

  /**
   * bot/say：会话中途先说一句。channel_tool 会话照本轮来源快照发 progress 回复，旧会话照会话记的地址发，都不阻塞当前会话。
   * @param session 说话的会话。
   * @param text 要先说的话。
   */
  private onSay(session: Session, text: string): void {
    if (session.row.channel === undefined) return;

    const snapshot = session.row.activeSourceSnapshot;
    if (snapshot !== undefined) {
      const suffix = `say:${namesModule.createTimestampId()}`;
      const replyRequestKey = protocol.getReplyRequestKey(snapshot.replyRoundKey, suffix);
      const options = { replyRequestKey, replyIndex: 0, kind: 'progress' as const };
      void protocol.requestTextReply(this.home, snapshot, text, options);
      return;
    }

    //M 没有来源快照的旧会话：照会话记的渠道和地址发，发了不等回执。
    void this.send(session, text);
  }

  /**
   * bot/request 处理抛错时的回执：把原因放到 { ok: false, error }，调用方不干等超时。
   * @param error onRequest 抛出的错。
   */
  private onRequestError(error: unknown): requestEventModule.StripResultId<BotResult> {
    const message = textModule.getErrorMessage(error);
    return { ok: false, error: message };
  }

  /**
   * 响应 bot/request：按 action 调本服务现有的方法（hand、saveFile、add）或前台的 acceptResult。
   * @param request 别的插件用 requestEvent 发来的请求。
   * @returns 回执正文：ok 和这件事的结果。hand 时没有这个机器人是 ok: false。
   * @throws 现有方法抛的错原样抛，由 onRequestEvent 的 onError 转成 { ok: false, error }。
   * 副作用：同各方法（开会话、写文件、建机器人目录、写库排结果队列）；发一个跟踪点。
   */
  private async onRequest(request: BotRequest): Promise<requestEventModule.StripResultId<BotResult>> {
    //T 跟踪：别的插件经事件请机器人办事。
    const vars = { action: request.action, requestId: request.requestId };
    this.ctx.emit('trace', 'Bots.onRequest', 'trace.bots.request', `bot/request（${request.action}）`, vars);

    //M hand：交给这个机器人的一场后台（新开或接着），回执带会话号。
    if (request.action === 'hand') {
      const bot = this.get(request.bot);
      if (bot === undefined) return { ok: false, error: `没有这个机器人：${request.bot}` };

      //M 带了 replyTo（群日报）：不开后台，排进前台，回话照 replyTo 发到那个聊天。
      if (request.replyTo !== undefined) return this.handReply(bot, request.text, request.replyTo, request.sessionId);

      //M 把事交给这个机器人：不给会话号就新开一场后台，给了就接着那场；回执带会话号，请求方（progress）转新会话时要用。
      const session = bot.hand(request.text, request.origin, request.sessionId);
      return { ok: true, sessionId: session.id };
    }

    //M save-file：存进这个机器人的工作区，回执带绝对路径。
    if (request.action === 'save-file') {
      const full = this.saveFile(request.bot, request.name, request.data);
      return { ok: true, path: full };
    }

    //M add：运行中新建一个机器人（只加进内存，config.yaml 由调用方写），回执带名字、工作区、记忆目录。
    if (request.action === 'add') {
      const raw = this.home.resources.raw;
      const configs = botUtils.getBotConfigs(raw);
      const bot = this.add(request.config);
      //M 让新机器人立即进入只读名单，文件监听随后读取完整的已保存配置。
      if (!configs.some((item) => item.name === bot.name)) {
        raw['bots'] = [...configs, bot.config];
      }
      const created = { name: bot.name, workspace: bot.workspace, memory: bot.memory };
      return { ok: true, bot: created };
    }

    //M accept-result：结果排进会话的结果队列。不带收尾回调：调用方收到回执后自己改它的表（relay 的 record、markDelivered）。
    const commitSource = (): void => undefined;
    const receipt = this.home.frontDesk.acceptResult(request.input, commitSource);
    return { ok: true, receipt };
  }

  /**
   * bot/request 的 hand 带 replyTo：照 replyTo 拼一条标准消息当这一轮的来源（发话人是交活的插件，按外人算），
   * 排进前台单队列，模型用 channel_reply 把回话发到那个聊天。不经渠道事件：approval、记忆都看不到这段交办的话。
   * @param bot 交给哪个机器人。
   * @param text 要办的事。
   * @param replyTo 回话发到哪个聊天。
   * @param sessionId 排进哪场前台；不给按 replyTo 的聊天找前台，没有就开。
   * @returns 回执正文：排进了哪场会话（同一个 key 已经排过也是 ok，会话号照旧）。
   * 副作用：可能新开前台；排队、存库，前台空着就开跑。
   */
  private async handReply(
    bot: Bot,
    text: string,
    replyTo: ReplyTo,
    sessionId: string | undefined,
  ): Promise<requestEventModule.StripResultId<BotResult>> {
    //M 标准消息号用 replyTo.key 拼：同一件活重发时认领键一样，前台认得出来不再排。
    const nativeId = `request:${replyTo.key}`;
    const messageId = protocol.makeChannelMessageId(replyTo.channel, replyTo.accountId, nativeId);
    const now = Date.now();
    const scope = `${replyTo.channel}:${replyTo.accountId}:${replyTo.chatId}`;

    //M 拼成标准消息：发话人是交活的插件，按外人算（guest、不受信），这一轮只查这个聊天的；一轮没调 channel_reply 就把最后的话发出去。
    const message: protocol.ChannelMessage = {
      v: 1,
      messageId,
      nativeId,
      channel: replyTo.channel,
      accountId: replyTo.accountId,
      chatId: replyTo.chatId,
      chatType: replyTo.chatType,
      sender: replyTo.sender,
      role: 'guest',
      targetBots: [bot.name],
      mentions: [],
      rawText: text,
      text,
      attachments: [],
      createdAt: now,
      receivedAt: now,
      timeSource: 'received',
      replyTo: null,
      origin: { channel: replyTo.channel, address: structuredClone(replyTo.address) },
      visibility: { scope, trusted: false, publicSourceIds: [] },
      routing: { autoFinal: true },
    };

    //M 指定了会话就排进它；没指定由前台按聊天找，没有就开。
    let target: Session | undefined;
    if (sessionId !== undefined) {
      target = this.home.sessions.open(sessionId);
    }

    //M 和渠道来的话走同一个认领：拼来源快照、排进前台单队列，前台空着就开跑。
    const claimKey = protocol.getClaimKey(messageId, bot.name);
    const control: protocol.ChannelMessageControl = { claims: [] };
    await this.home.frontDesk.claimChannelMessage(bot, message, message.origin, text, claimKey, control, target);

    //M 回执带排进的会话号（认领记录里写着）。
    const claimed = control.claims.find((claim) => claim.sessionId !== undefined);
    if (claimed?.sessionId === undefined) return { ok: false, error: '前台没有定下进哪场会话' };

    return { ok: true, sessionId: claimed.sessionId };
  }

  /**
   * 响应进来的三个渠道事件：消息级审批命令已处理时跳过；否则按 targetBots 逐个机器人独立认领。
   * 只听的（channel/listen）在每个机器人的地址副本上标 listenOnly：前台只记背景或判断，relay 只认前缀开头的。
   * 带 routing.sessionId 的只投给那场会话的机器人（入口校验过会话在、属于目标机器人），别的机器人不收。
   * @param message 标准渠道消息。
   * @param listen 是不是只听的（channel/listen）。
   * @param control 认领协调对象。
   */
  private async onChannelMessage(
    message: protocol.ChannelMessage,
    listen: boolean,
    control?: protocol.ChannelMessageControl,
  ): Promise<void> {
    if (control?.approvalHandled === true) return;

    //M 每个目标机器人各认领一次：按名字取机器人对象，名单里没有的（配置改过）跳过，不挡别的机器人。
    for (const botName of message.targetBots) {
      const bot = this.get(botName);
      if (bot === undefined) continue;

      //M 指定了会话：只有那场会话的机器人收这条，进那场会话；不是它的机器人跳过（显式会话不投给别的机器人）。
      const sessionId = message.routing.sessionId;
      let explicit: Session | undefined;
      if (sessionId !== undefined) {
        const meta = this.home.sessions.find({ id: sessionId })[0];
        if (meta?.bot !== botName) continue;

        //M 会话属于这个机器人：打开它（内存里的同一个对象），后面认领、排队都进这场。
        explicit = this.home.sessions.open(sessionId);
      }

      //M 这条消息对这个机器人的去重键（消息号加机器人名），渠道重发时靠它认出已经收过。
      const claimKey = protocol.getClaimKey(message.messageId, botName);
      const botOrigin: { channel: string; address: Record<string, unknown> } = {
        channel: message.origin.channel,
        address: structuredClone(message.origin.address),
      };

      //M 只听的话：在这个机器人的地址副本上标 listenOnly（bots 内部的标记，前台、relay 读它；渠道的原地址不动）。
      if (listen) {
        botOrigin.address['listenOnly'] = true;
      }

      //M 按该机器人此轮授权目录把渠道保存的附件物化到 inbox。
      const botText = this.materializeAttachments(bot, botOrigin.address, message);
      const incoming: IncomingMessage = {
        channel: message.channel,
        bot: botName,
        text: botText,
        time: message.createdAt,
        address: botOrigin.address,
        sourceId: message.messageId,
      };
      const receiveEvent: ReceiveEvent = {
        bot,
        message: incoming,
        fromChannelEvent: true,
      };

      //M 指定的会话先填进去：relay、web-api 这些看到已经定了去向就不抢；tutorial 照旧在 bot/receive 里认快照关键词。
      if (explicit !== undefined) {
        receiveEvent.session = explicit;
      }

      //M 保留每机器人内部兼容关口 bot/receive（relay 转外部助手、tutorial 认关键词、web-api 记别的渠道的消息）。
      await this.home.serial('bot/receive', receiveEvent);

      if (receiveEvent.handled === true) {
        claimModule.pushClaim(control, botName, claimKey, 'handled');
        continue;
      }

      //M 指定的是前台：排进这场前台的单队列（channel_tool），和没指定时一样能一轮连发、零次兜底，只是不按来源范围找前台。
      //M   话用 incoming.text：tutorial 在 bot/receive 里去掉的快照关键词不要再带回去。
      const pinnedFront = explicit !== undefined && receiveEvent.session === explicit && explicit.row.kind === 'front';
      if (pinnedFront) {
        await this.home.frontDesk.claimChannelMessage(bot, message, botOrigin, incoming.text, claimKey, control, explicit);
        continue;
      }

      //M 别的插件认领了（relay 转外部助手），或指定的是后台等别的会话：照旧交过去，一轮结束自动回原渠道。
      if (receiveEvent.session !== undefined) {
        const claimedSession = receiveEvent.session;
        const claims = claimedSession.row.sourceClaims ?? [];

        //G 同一条消息（同 claimKey）这场会话已经认领过：渠道重发的，不再投一次。
        if (claims.includes(claimKey)) {
          claimModule.pushClaim(control, botName, claimKey, 'duplicate', claimedSession);
          continue;
        }

        //M 把这条的去重键记到会话上（只留最近 200 个），存库，下次重发才认得出来。
        claimModule.rememberClaim(claimedSession, claimKey);
        claimedSession.save();
        let status: protocol.ChannelClaimRecord['status'] = 'claimed';
        if (claimedSession.row.kind === 'relay') {
          status = 'relay';
        }
        claimModule.pushClaim(control, botName, claimKey, status, claimedSession);

        //M 话交给认领的那场会话（比如 relay 的外部助手会话），记下回话往哪送，推它往下走；一轮结束自动回原渠道。
        bot.deliver(claimedSession, incoming.text, { channel: message.channel, address: botOrigin.address });
        continue;
      }

      //M 未被其他插件接管 → 按来源范围进该机器人的前台单队列（channel_tool 模式）。话用 incoming.text（理由同上）。
      await this.home.frontDesk.claimChannelMessage(bot, message, botOrigin, incoming.text, claimKey, control);
    }
  }

  /**
   * 为认领这条标准消息的机器人把渠道存储的附件物化到这一轮授权工作区的 inbox 里。
   * @param bot 目标机器人。
   * @param address 这一轮的回话地址快照（决定工作区范围）。
   * @param message 标准消息。
   * @returns 供本机器人会话使用的文本。
   */
  private materializeAttachments(
    bot: Bot,
    address: Record<string, unknown>,
    message: protocol.ChannelMessage,
  ): string {
    if (message.attachments.length === 0) return message.text;

    //M 按回话地址算出当前说话人的隔离工作区根目录，用来落盘收到的附件。
    const rootDir = workspaceModule.getWorkspace(bot.workspace, address);
    const now = new Date();
    const inboxDir = path.join(rootDir, 'inbox', now.toLocaleDateString('sv-SE'));
    const paths: string[] = [];
    const failed: string[] = [];
    for (const attachment of message.attachments) {
      if (attachment.state !== 'available' || attachment.sourceRef === '') {
        failed.push(`[${attachment.name} 没下载下来：${attachment.reason ?? '渠道未取得附件'}]`);
        continue;
      }
      //M 渠道取到的附件拷进 inbox：文件名洗成安全的（getSafeName），同一毫秒撞名再加四位序号；拷不动的记进 failed，不挡别的附件。
      try {
        fs.mkdirSync(inboxDir, { recursive: true });
        const stamp = now.toLocaleTimeString('sv-SE').replaceAll(':', '') + String(now.getMilliseconds()).padStart(3, '0');
        const base = path.win32.basename(attachment.name);
        const safe = namesModule.getSafeName(base, Infinity);
        let full = path.join(inboxDir, `${stamp}_${safe}`);
        if (fs.existsSync(full)) {
          full = path.join(inboxDir, `${stamp}_${namesModule.createTimestampId().slice(-4)}_${safe}`);
        }
        fs.copyFileSync(attachment.sourceRef, full);
        let token = `@${full}`;
        if (/\s/u.test(full)) {
          token = `@"${full}"`;
        }
        paths.push(token);
      } catch (error) {
        //G 存工作区失败：用 getErrorMessage 取出原因写进提示，让用户和模型都看得到哪个附件没存成。
        failed.push(`[${attachment.name} 存工作区失败：${textModule.getErrorMessage(error)}]`);
      }
    }
    const baseText = message.text;
    const pieces: string[] = [];
    if (baseText !== '' && baseText !== '[空消息]') {
      pieces.push(baseText);
    }
    if (paths.length > 0) {
      pieces.push(paths.join(' '));
    }
    if (failed.length > 0) {
      pieces.push(failed.join('\n'));
    }
    const merged = pieces.filter((part) => part !== '').join('\n');
    if (merged === '') return message.text || '[空消息]';

    return merged;
  }

  /**
   * 按地址发送没有来源快照的话，等渠道发完。会话自动回话、中途发进度、前台送后台结果都走它。
   * 照会话记的（或 origin 给的）渠道和地址发 channel/reply（target.address），正文里的 @路径 当文件发（atFiles，和原来一样）。
   * @param session 哪场会话：渠道、地址从 row.channel、row.address 取；会话号带进请求，渠道照它定细节。
   * @param text 要发的话。
   * @param origin 发到哪：给了就用它的渠道和地址，不看会话现在记的（前台送后台结果用）。
   * @returns 回执：照渠道的 channel/replied 折过来；没有渠道、渠道没挂是 rejected，超时是 uncertain。
   * 副作用：发 channel/reply。不抛错。
   */
  async send(session: Session, text: string, origin?: Origin): Promise<SendReceipt> {
    const name = origin?.channel ?? session.row.channel;
    if (name === undefined) return { status: 'rejected', reason: '这场会话没有渠道' };

    //M 地址：给了 origin 的地址用它，没给用会话现在记的（和原来渠道的 send 取法一样）。
    const rawAddress = origin?.address ?? session.row.address;
    const address = utils.getRecord(rawAddress);
    const target = { channel: name, chat: '', address };

    //M 一轮结束的自动回话是 final（飞书照它撤“敲键盘”表情）；转着时说的一句、前台送后台结果是 progress。
    let kind: protocol.ReplyKind = 'progress';
    if (origin === undefined && session.row.state !== 'running') {
      kind = 'final';
    }

    //M 按地址发送用会话号算轮键。飞书重启会读回流水中的幂等键，保留其中的 'legacy' 后缀。
    const replyRoundKey = protocol.getReplyRoundKey(session.id, session.row.bot, 'legacy');
    //M 同一轮每次独立发话都生成一个新请求键。
    const replyRequestKey = protocol.getReplyRequestKey(replyRoundKey, crypto.randomUUID());
    const from = { bot: session.row.bot, replyRoundKey, target, sessionId: session.id };
    const options = { replyRequestKey, replyIndex: 0, kind, atFiles: true };

    //M 交渠道协议发出，等渠道回执。
    const receipt = await protocol.requestTextReply(this.home, from, text, options);
    const reason = receipt.reason ?? '';

    //M 回执折回 SendReceipt：发了、排队、存草稿都算收下。
    if (receipt.ok) return { status: 'accepted', reason: '' };
    if (receipt.status === 'partial') return { status: 'partial', reason };
    if (receipt.status === 'rejected') return { status: 'rejected', reason };

    return { status: 'uncertain', reason };
  }

  /**
   * 登记一个渠道名。渠道插件被拔掉时，把返回的函数交给 ctx.effect 就会自动撤掉。
   * 发话不靠它（一律走 channel/reply），只给网页列“现在挂着哪些渠道”。
   * @param name 渠道名：cli、http、feishu、wechat、voice……
   * @returns 撤掉这次登记的函数。
   * 副作用：写入 channels；同名再登记不重复。
   */
  channel(name: string): () => void {
    this.channels.add(name);
    return () => {
      this.channels.delete(name);
    };
  }

  /**
   * 现在挂着的渠道：登记过的渠道名，照登记的先后。web-api 的 GET /api/channels、POST /api/message 的 view 校验用。
   * @returns 渠道名，比如 ['http', 'feishu', 'wechat']。
   */
  channelNames(): string[] {
    return [...this.channels];
  }

  /**
   * 收到用户一句话。渠道自己存一份，再直接推给对应的机器人，不走事件。
   * @param name 渠道名。
   * @param bot 给哪个机器人。
   * @param text 用户说的话。
   * @param address 渠道自己认得的回话地址；原样记到会话上。
   * @throws 没有这个机器人、没有插件管分派时抛错（渠道是外部入口，在这里校验一次）；怎么告诉用户由各渠道自己定。
   * 副作用：存到本地；推给机器人。
   */
  async receive(name: string, bot: string, text: string, address?: unknown): Promise<void> {
    //G 渠道是外部入口，机器人名在这里查一次：没有就抛错，由渠道告诉用户。
    const target = this.get(bot);
    if (target === undefined) {
      throw new Error(`没有这个机器人：${bot}`);
    }
    const message: IncomingMessage = { channel: name, bot, text, time: Date.now(), address };

    //T 跟踪：渠道收到一句话。
    const vars = { channel: name, bot: bot, length: text.length };
    this.ctx.emit('trace', 'Bots.receive', 'trace.bots.receiveFromChannel', 'bot.receive(message)', vars);

    //M 渠道自己存一份：运行时目录 channels/<渠道名>/ 下，一天一个文件，一条一行 JSON。
    /** 本地日期，2026-11-13 的样子（sv-SE 这个地区的写法正好是它）。 */
    const day = new Date(message.time).toLocaleDateString('sv-SE');

    //M 取（没有就建）运行时目录里这个渠道自己的文件夹，当天的文件追加一行。
    const file = path.join(this.ctx.resources.ensureRuntimeDir('channels', name), `${day}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(message)}\n`, 'utf8');

    //M 推给机器人。直接调，不走事件。
    await target.receive(message);
  }

  /**
   * 渠道收到的图片、文件存进这个机器人的工作区：工作区/inbox/<本地日期>/<时分秒毫秒>_<安全文件名>。
   * 存在工作区里，模型用工具 read 就能读到（base-tools 只许读工作区）。
   * @param bot 给哪个机器人。
   * @param name 原来的文件名；只取最后一段（/ 和 \ 都算分隔），再照 utils/Names.ts 的 getSafeName 洗干净（不限字数，空了叫“未命名”）。
   * @param data 文件内容。
   * @returns 存下的绝对路径；渠道把 @绝对路径 写进给机器人的话里。
   * @throws 没有这个机器人时抛错；同一毫秒同名撞上时抛错（不加序号重试），渠道接住告诉用户。
   * 副作用：建文件夹、写文件。
   */
  saveFile(bot: string, name: string, data: Uint8Array): string {
    //G 渠道是外部入口，机器人名在这里查一次：没有就抛错，不往不存在的工作区写文件。
    const target = this.get(bot);
    if (target === undefined) {
      throw new Error(`没有这个机器人：${bot}`);
    }

    //M 一天一个文件夹，文件名前面带时分秒毫秒，免得同名覆盖。
    const now = new Date();
    const dir = path.join(target.workspace, 'inbox', now.toLocaleDateString('sv-SE'));
    //M 把收到的文件放进按日期归档的目录。
    filesModule.ensureDir(dir);
    const stamp = now.toLocaleTimeString('sv-SE').replaceAll(':', '') + String(now.getMilliseconds()).padStart(3, '0');

    //M 文件名只取最后一段（/ 和 \ 都算分隔），再洗成安全的文件名；不限字数，免得把扩展名截掉。
    const base = path.win32.basename(name);
    const safe = namesModule.getSafeName(base, Infinity);
    const full = path.join(dir, `${stamp}_${safe}`);

    //M wx：文件已经有了就抛错，不覆盖。
    fs.writeFileSync(full, data, { flag: 'wx' });
    return full;
  }

  /**
   * 加一个机器人：启动时照名单加，运行中新建（设置页 settings）也调它，加完马上能收消息。
   * 只加进内存；config.yaml 由调它的插件自己写。
   * @param config 名单里的一项：要有非空的 name，别的项原样留着。
   * @returns 建好的机器人。
   * @throws name 不是非空字符串、或者重名时抛错。
   * 副作用：建好它的工作区、记忆目录；放进名单末尾。
   */
  add(config: BotConfig): Bot {
    //M 名单项是外面进来的（config.yaml 的 bots 段、设置页新建），在这里校验一次。
    if (typeof config?.name !== 'string' || config.name === '') {
      throw new Error('机器人要有非空的 name');
    }
    if (this.bots.has(config.name)) {
      throw new Error(`已经有叫 ${config.name} 的机器人了`);
    }

    //M 登记的目录 workspaces 写了就要是“名字: 目录”，目录是非空的字（Bot 构造时登记成工作区）。
    const registered: unknown = config['workspaces'] ?? {};
    if (typeof registered !== 'object' || registered === null || Array.isArray(registered)) {
      throw new Error(`机器人 ${config.name} 的 workspaces 要写成“名字: 目录”`);
    }

    //G 逐项检查登记的目录：不是非空字符串就抛错，别等 Bot 构造时才发现。
    utils.eachEntry(registered as Record<string, unknown>, (label, directory) => {
      if (typeof directory === 'string' && directory !== '') return;

      throw new Error(`机器人 ${config.name} 的 workspaces 里 ${label} 要写目录`);
    });

    //M 校验过了，建机器人：Bot 构造时建工作区、记忆目录，并登记配置里的工作区；用 home（本插件的 ctx）才取得到 frontDesk、sessions。
    const bot = new Bot(config, this.thinking, this.home);
    this.bots.set(bot.name, bot);
    return bot;
  }

  /**
   * 取一个机器人。
   * @param botName 机器人名。
   * @returns 没有这个机器人是 undefined；渠道用它校验名字。
   */
  get(botName: string): Bot | undefined {
    return this.bots.get(botName);
  }

  /** @returns 全部机器人，照名单的先后。 */
  list(): Bot[] {
    return [...this.bots.values()];
  }

  /**
   * 改一场会话的回话往哪送：渠道和地址一起换（换了渠道，旧地址就作废；没给地址就清掉）。
   * 机器人收消息、交办、前台排队开跑时走它；别的插件要发到别处，发 channel/reply 带 target.address，不改会话记的地址。
   * @param session 哪场会话。
   * @param origin 渠道和回话地址；不给渠道就什么也不改。
   * 副作用：改会话记录并存库。
   */
  route(session: Session, origin: Origin): void {
    if (origin.channel === undefined) return;
    session.row.channel = origin.channel;
    session.row.address = origin.address;
    //M 客户号由渠道写在 address.customer 里，这里抄到记录上；地址里没有就保留原来的（旧会话可能已经被补过）。
    const where = (typeof origin.address === 'object' && origin.address !== null && !Array.isArray(origin.address) ? origin.address : {}) as Record<string, unknown>;
    if (typeof where['customer'] === 'string' && where['customer'] !== '') {
      session.row.customer = where['customer'];
    }

    //M 渠道、地址、客户号都改在内存里了，存库，重启后还认得往哪送。
    session.save();
  }

  /**
   * 会话跑到一半，先跟用户说一句（最后的回话照旧由渠道在这一轮结束时发）。
   * 没有渠道的会话（小会话）也照发，没人接就算了。
   * @param session 哪场会话：渠道从它的 row.channel、row.address 认出往哪送。
   * @param text 要说的话。
   * 副作用：发通知 bot/say（ctx.emit 是“通知”：挨个调听的函数，不等它们的结果，也不管有没有人听）。
   */
  say(session: Session, text: string): void {
    //T 跟踪：会话中途先跟用户说一句。
    const vars = { session: session.id, channel: session.row.channel, length: text.length };
    this.ctx.emit('trace', 'Bots.say', 'trace.bots.say', "ctx.emit('bot/say', session, text)", vars);

    //M 发通知 bot/say：构造函数里的监听按会话的渠道发出去，前台再记一条往来；发了不等。
    this.ctx.emit('bot/say', session, text);
  }
}


/** 一个机器人。只由 Bots 的构造函数来建。 */
export class Bot {
  /** 机器人名。 */
  readonly name: string;

  /** 这个机器人的工作区：运行时目录 bots/<机器人>/workspace/。工具在这里读写文件。 */
  readonly workspace: string;

  /** 这个机器人的记忆目录：运行时目录 bots/<机器人>/memory/。 */
  readonly memory: string;

  /** 配置 workspaces 里登记的名字 → 工作区 ID：建机器人时原地登记的（workspaces 插件），hand_session 旧写法写名字时照它找。 */
  readonly registered = new Map<string, string>();

  /**
   * @param config 名单里那一项（Bots.add 校验过，workspaces 是“名字: 目录”）。
   * @param thinking 后台会话用哪个思考档。
   * @param ctx 取 sessions、resources、workspaces，发事件用。
   * 副作用：建工作区、记忆目录；在 workspaces 表里原地登记默认工作区和配置里的目录。
   */
  constructor(
    readonly config: BotConfig,
    private readonly thinking: Thinking,
    private readonly ctx: cordis.Context,
  ) {
    this.name = config.name;

    //M 工作区和记忆目录放在运行时目录 bots/<机器人>/ 下，resources.ensureRuntimeDir 没有就建，返回绝对路径。
    const workspace = botUtils.getBotDir(this.ctx.resources, this.name, 'workspace');
    const memory = botUtils.getBotDir(this.ctx.resources, this.name, 'memory');
    //M 建立配置机器人的默认工作区与记忆目录。
    this.workspace = filesModule.ensureDir(workspace);
    this.memory = filesModule.ensureDir(memory);

    //M 工作区原地登记，不搬不删：默认的 bots/<机器人>/workspace/。登记过的按目录认，重启不重登。
    const workspaces = this.ctx.workspaces;
    workspaces.ensureDefault(this.name);

    //M 配置 workspaces 里登记的目录（比如源码仓库）：登记成 private，只给本人；相对路径照运行时目录算。
    //M   第一次登记用配置里的名字，以后改了名不会被配置盖回去；本人归档了的照样认出来（派新活时才挡）。
    const owner = workspaces.getAccess(this.name, undefined, undefined);
    const written = (config['workspaces'] ?? {}) as Record<string, string>;
    utils.eachEntry(written, (label, directory) => {
      const legacyDirectory = path.resolve(this.ctx.resources.root, directory);
      const selection = { legacyDirectory, legacyName: label, allowArchived: true };

      //M 按目录认（没登记过就登记），拿到工作区 ID，记下“配置里的名字 → 工作区 ID”，hand_session 旧写法写名字时照它找。
      const resolved = workspaces.resolve(owner, selection);
      this.registered.set(label, resolved.workspace.id);
    });
  }

  /**
   * 渠道送来一条消息。定好进哪场会话就返回，不等模型。
   * @param message 渠道、机器人、文字、时间、回话地址。
   * @throws 前台也没定下会话时抛错（前台总会定下或处理掉，抛了就是代码错了）。
   * 副作用：这句话进那场会话；推它往下走。被插件处理掉的（handled），什么也不做。
   */
  async receive(message: IncomingMessage): Promise<void> {
    //M 先问一圈：谁要认领这条消息（relay、微信填 event.session；approval 认出“同意 3”写 handled）。
    const event: ReceiveEvent = { bot: this, message };
    await this.ctx.serial('bot/receive', event);

    //M 没人认领的进这个客户的前台对话；前台正在整理后台结果，就先排着（Dispatch.ts 的 receive）。
    await this.ctx.frontDesk.receive(event);

    //G 已经处理掉了（handled：插件处理掉、只听的话只记、排着等前台整理完）→ 不进会话。
    if (event.handled === true) {
      //T 跟踪：处理掉了，不进会话。
      const vars = { channel: message.channel, length: message.text.length };
      this.ctx.emit('trace', 'Bot.receive', 'trace.bots.receiveHandled', 'event.handled === true', vars);
      return;
    }

    //G 前台总会定下会话或处理掉；没定下是代码错了。
    const session = event.session;
    if (session === undefined) {
      throw new Error(`机器人 ${this.name} 收到了消息，但前台没有定下进哪场会话`);
    }

    //T 跟踪：机器人收到一条消息。
    const vars = { session: session.id, channel: message.channel, length: message.text.length };
    this.ctx.emit('trace', 'Bot.receive', 'trace.bots.receiveIntoSession', 'session.queueUserMessage(); session.run()', vars);
    this.deliver(session, message.text, { channel: message.channel, address: message.address });
  }

  /**
   * 把一件事交给一场后台会话。前台的 hand_session 工具调它；别的机器人要找这个机器人办事也调它。
   * @param text 要办的事。
   * @param origin 办完回话往哪送：渠道和回话地址；不给渠道就不改这场会话原来记的。
   * @param sessionId 接着哪一场；不给就新开一场。
   * @returns 交给了哪一场。
   * @throws 给了会话号、但没有这场时抛错。
   * 副作用：可能新开会话；这件事进那场会话；推它往下走，不等。
   */
  hand(text: string, origin: Origin, sessionId?: string): Session {
    //M 没给会话号就新开一场后台（kind: work，用本机器人的思考档）；给了就打开那场接着干，没有这场会抛错。
    let session: Session;
    if (sessionId === undefined || sessionId === '') {
      session = this.ctx.sessions.create({ kind: 'work', bot: this.name, thinking: this.thinking });
    } else {
      session = this.ctx.sessions.open(sessionId);
    }

    //M 把事交进那场会话：记回话往哪送，话进会话，推它往下走。
    this.deliver(session, text, origin);
    return session;
  }

  /**
   * 把一句话交给一场会话：记下回话的渠道和地址，话进会话，推它往下走，不等。它已经在转的话，下一步会带上这句。
   * @param session 交给哪一场。
   * @param text 这句话。
   * @param origin 这句话从哪来；不给渠道就不改原来记的。
   */
  deliver(session: Session, text: string, origin: Origin): void {
    //M 给了渠道，渠道和地址一起换：换了渠道，旧地址就作废（没给地址就清掉）。
    this.ctx.bots.route(session, origin);

    //M 话进会话（它已经在转的话，下一步会带上这句），再推它往下跑，不等模型。
    session.queueUserMessage(text);
    void session.run();
  }
}


/** config.yaml 的 plugins 段里写给本插件的。 */
export interface BotsPluginConfig {
  /** 后台会话的思考档；不写是 medium。 */
  thinking?: Thinking;
  /** 前台（原插件 bot-front-desk 的配置）：recent 带最近几条往来，不写是 50；vision_model 有图要转后台时用的看图模型。 */
  front?: Partial<FrontDeskConfig>;
  /** 系统提示词（原插件 prompt，Prompt.ts）：不写是 true；写 false 不加系统提示词。 */
  prompt?: boolean;
  /** 工具 reply（原插件 reply-tool，ReplyTool.ts）：写 true 才登记；不写不登记。 */
  reply_tool?: boolean;
  /** 群攒批（GroupBatch.ts）：{ quiet_seconds, max_lines, daily_limit }，三个都写才开；readGroupBatch 校验。 */
  group_batch?: unknown;
}


/**
 * 挂上机器人服务，和前台、前台派后台。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config config.yaml 的 plugins 段里写给它的：thinking、front、prompt、reply_tool、group_batch，见 BotsPluginConfig。
 * @throws bots 段、front 一节、prompt、reply_tool、group_batch 写得不对时抛错（group_batch 没写、缺键不抛，只是不开）。
 */
export function apply(ctx: cordis.Context, config: BotsPluginConfig): void {
  //M 名单是外面进来的（config.yaml 顶层的 bots 段），在这里校验一次：
  //M   一张清单；整段不写就是一个叫“助手”的机器人。每项的 name 由 Bots.add 校验（非空、不重名）。
  const written = botUtils.getBotConfigs(ctx.resources.raw);

  //M 前台的配置也是外面进来的，在这里校验一次：front 不写就全用默认。
  const front: unknown = config.front ?? {};
  if (typeof front !== 'object' || front === null || Array.isArray(front)) {
    throw new Error('bots 的 front 要写成一节（recent、vision_model）');
  }
  const frontConfig = front as Partial<FrontDeskConfig>;

  //M recent 不写是 50，必须是正整数。
  const recent = frontConfig.recent ?? 50;
  if (!Number.isInteger(recent) || recent <= 0) {
    throw new Error('bots 的 front.recent 必须是正整数');
  }
  //M vision_model 写了就要是“供应商名/模型 ID”，供应商在 providers 里。
  const vision = frontConfig.vision_model;
  if (vision !== undefined && (typeof vision !== 'string' || ctx.resources.config.providers[vision.slice(0, vision.indexOf('/'))] === undefined)) {
    throw new Error('bots 的 front.vision_model 要写成“供应商名/模型 ID”，供应商要在 providers 里');
  }

  //M prompt（原插件 prompt）不写是开；reply_tool（原插件 reply-tool）不写是关。写了都要是 true 或 false。
  const promptOn = config.prompt ?? true;
  const replyToolOn = config.reply_tool ?? false;
  if (typeof promptOn !== 'boolean' || typeof replyToolOn !== 'boolean') {
    throw new Error('bots 的 prompt、reply_tool 要写成 true 或 false');
  }

  //M 群攒批的三个数只从配置读：没写或缺键就不开（listen: judge 的群只记不判断），启动打一行写明缺哪个，不挡启动。
  const batch = groupBatchModule.readGroupBatch(config.group_batch);
  let batchConfig: groupBatchModule.GroupBatchConfig | undefined;
  if (typeof batch === 'string') {
    console.warn(`bots：群攒批没开（${batch}），listen: judge 的群只记不判断`);
  }
  if (typeof batch !== 'string') {
    batchConfig = batch;
  }

  //M 先后照并进来之前：机器人服务（回话的监听）在前，前台（往来记录、拼上下文）其次，派后台（结果队列）最后，紧接登记渠道工具。
  //M   都挂在本插件的 ctx 上，所以前台的 session/before-model 排在 file-tools 这些后挂的插件前面。
  new Bots(ctx, { bots: [...written], thinking: config.thinking ?? 'medium' });
  const desk = new FrontDesk(ctx, { recent, vision_model: vision });
  new Dispatch(ctx, desk, batchConfig);
  new ChannelTools(ctx);

  //M 系统提示词（Prompt.ts）：session/before-model 挂在上面几个之后。并进来之前它排在 relay、memory 后面，现在排到它们前面，
  //M   只是 work 会话“开场先搜”的那段（memory 加的）从人设、记忆文件前面挪到后面；底座和功能声明用 unshift，照旧在最前。
  if (promptOn) {
    new Prompt(ctx);
  }

  //M 工具 reply（ReplyTool.ts）：写了 reply_tool: true 才登记。
  if (replyToolOn) {
    registerReplyTool(ctx);
  }

  //M 2026-11-18：不再 inject memory。前台查归档改发请求事件 memory/request（FrontDesk.ts 的 readFront），
  //M   “先查记忆”的提示由 memory 自己在 session/before-model 里加；没挂 memory 前台照常答话。
}
