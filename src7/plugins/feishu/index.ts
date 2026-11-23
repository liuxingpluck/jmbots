/**
 * 接入飞书渠道收发、审批进度卡片、云文档工具与发件箱。
 * 用户定了：平台型插件放在一个插件里，用子文件夹分管功能。设计见同目录 说明.md 的「设计要点」一节。
 * 渠道收发按职责分文件：这个文件是入口（类型、配置校验、长连接、别的插件调的发送口、apply）；
 * 收消息、撤回、点卡片在 Inbound.ts，channel/reply 在 Reply.ts（所有发出去的话都经它），聊天日志在 ChatLog.ts，
 * 来往流水在 Contacts.ts。拆出去的几个类由 Feishu 构造时建好，挂在 feishu.inbound / reply / history / contacts 上。
 *
 * 渠道：照 config.yaml 的 channels.feishu 名单，一个飞书应用一个 SDK 客户端、一条长连接（WebSocket），等 ready 才连。
 * 渠道只有一个，名字 feishu；回话地址（FeishuAddress）里的 appId 分清是哪个应用，回话从收消息的那个应用发回去。
 * 收：什么类型都接住，图片文件下载后用基类 saveFile 存进机器人工作区，话里写 @绝对路径；按消息号去重（存表，重启也认得）。
 * 收到的一条只发一个事件（channels 的 emitInbound）：私聊 channel/direct；群里 @ 了机器人或引用了机器人的话 channel/mention，只回被叫到的；
 * 别的 channel/listen（没登记的群也发，记录类插件照记）。插件配置 groups 里登记了 listen: all 的群，只听的话交给本应用的机器人：
 * 以外部助手前缀开头的 relay 照转，别的前台只记进群的前台会话当背景、不回。
 * listen: judge 的群同样不 @ 也听，bots 的群攒批（GroupBatch.ts）攒一批再问决策模型要不要主动接话。
 * 发到群里的话：开头 @ 这一轮最后说话的人，文字里的 @名字 换成 <at user_id="…">名字</at>（名字→open_id 先查 people，再查群成员、流水里见过的）。
 * 认人认群看插件配置的 people、groups（谁是哪一档只在这里判断，写进回话地址的 owner、role、workspace）；
 * 收到的每条都记进来往流水 data/logs/feishu-contacts.jsonl。
 * 发：文字整条发，文字里的 @路径 换成「文件名」再一个个发文件。
 *
 * Cordis 大白话：apply 是插件的 main()，ctx 是它拿到的遥控器；通过 ctx 听的事件、登记的工具、ctx.effect 登记的收尾，
 * 插件被拔掉时 Cordis 自动撤掉。审批和进度卡片通过事件接收更新与发起操作。
 */
import * as fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import * as lark from '@larksuiteoapi/node-sdk';
import * as cordis from 'cordis';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as protocol from '../channels/index.ts';
import * as dbModule from '../db/index.ts';
import type { ChannelStatus } from '../web-api/index.ts';
import * as api from './Api.ts';
import * as cards from './cards/Cards.ts';
import * as configModule from './Config.ts';
import { FeishuContacts } from './Contacts.ts';
import * as doc from './doc/Doc.ts';
import { FeishuChatLog } from './ChatLog.ts';
import { FeishuHistoryPull } from './HistoryPull.ts';
import { FeishuInbound } from './Inbound.ts';
import type { RecallData, ReceiveData } from './Inbound.ts';
import * as media from './Media.ts';
import seenCompositeSql from './migrations/0001_feishu_seen_composite_pk.sql' with { type: 'text' };
import tablesSql from './migrations/0000_feishu_tables.sql' with { type: 'text' };
import * as outbox from './outbox/Outbox.ts';
import * as recall from './Recall.ts';
import { FeishuReply } from './Reply.ts';

/** sendText 交回的回执：accepted 文字和文件都发了，partial 有文件没发出去（reason 写哪几个）。 */
export interface SendTextReceipt {
  /** 文字和附件的发送状态。 */
  status: 'accepted' | 'partial' | 'uncertain' | 'rejected';
  /** 发送失败时的原因。 */
  reason: string;
  /** 文字正文发成后飞书返回的消息号（如 om_xxx）。 */
  messageId?: string;
}


/** 插件名。 */
export const name = 'feishu';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.3：监听 im.message.recalled_v1 撤回消息事件，校验本人或原发信人后发出 channel/recall。
//M 1.1.4：onChannelReply 支持带 target 的跨渠道发话，在飞书自有群/私聊/流水数据里自认聊天。
//M 1.1.9：登记群内每日进度的时间、机器人和提示，progress 读取已校验的配置。
//M 1.1.12：跨聊天发话认目标改用骨架的 parseChatTarget、findChatByIdOrName：飞书只交出候选清单（getChatCandidates）。
//M 1.1.13：入口文件按职责拆成 Inbound、Reply、History、Contacts 四个文件，收消息拆成几步；行为不变。
//M 1.1.18：长连接收到消息先发一个跟踪点 Feishu.start，入站的几个跟踪点都带 messageId（标准消息号），教程轨迹第一格就是飞书收到。
//M 1.2.0：收到的一条照 channels 的分法发 channel/direct、mention、listen 之一；没登记的群不 @ 也发 listen（不再“丢了”）；
//M   引用了机器人的话算叫了它；地址不再写 listenOnly（bots 自己标）。
//M 1.2.1：人员身份由 people[].role 决定，配置写旧身份键时报改法。
//M 1.2.2：listen: judge 的群改由 bots 的群攒批判断（一批一次，来往流水的判断结果由 bot/judged 补记）；本插件只改说明。
//M 1.2.3：群里回话隐去本机绝对路径（mentioned 里 hideLocalPaths）；feishu_send_file 认这一轮的授权目录（用户 #301）。
//M 1.2.4：拼标准消息时带上 accountName（应用配置的 bot 名），聊天归档的账号目录用它。
//M 1.3.0：拉群聊历史（HistoryPull.ts）：POST /api/feishu/history 及进群自动拉最近 history_on_join 条，发 channel/history 补记。
//M 1.3.1：收发文档路径按机器人和回话地址定位工作区。
//M 1.3.2：是不是群、点卡片的是不是本人改问 channels 的 isGroup、getSpeakerRole（从 utils/Workspace.ts 挪过去的），判断不变。
//M 1.3.3：新工具 feishu_recall（Recall.ts）撤回机器人自己发的消息；feishu_doc 群里建文档后给这个群阅读权限；提示里加“群里要文件优先发 Word”。
//M 1.3.4：发送文字和内联附件的返回类型改名为 SendTextReceipt。
//M 1.3.5：飞书开放接口每个请求自己限时 60 秒（HTTP_TIMEOUT_MS，axios timeout），到点算不确定；
//M   点卡片交给 approval、progress 改 requestEvent 新写法，本机的一问一答不掐表（云端 19 第 1、2 条）。
//M 1.3.6：groups 每项可写 judge_helper（#318）：listen: judge 的群判定要接话时，地址带 judgeHelper，bots 把这批话转给该外部助手。
//M 1.3.7：配置校验搬进 Config.ts（改用 Checks.ts 的公共校验）；构造函数只做登记，建表、建客户端、发文件、关连接挪成方法（云端20 第 2、3 条）。
//M 1.3.8：post 富文本入站剥除对本机器人的 @名字（保留他人 @提及），at 标签缺 user_name 时回退 user_id 且不叠双 @。
//M 1.3.9：新增 feishu/recall-message 温和撤回占位消息事件；sendText 返回文本 messageId；发件箱单份失败进 failed/ 不卡整轮并支持多应用路由。
//M 1.3.10：feishu_seen 经 db 迁移账本升为 (message_id, app_id) 复合主键隔离多应用去重；
//M   入站拦截 sender_type === 'app' 防全 AI 群互 @ 引用死循环。
export const version = '1.3.10';

/** 用到的必需服务；db 存在时优先复用其迁移账本，未挂 db 时回退同连接 Db 实例。 */
export const inject = ['resources', 'bots', 'sessions', 'tools'];

/** 飞书数据库表结构迁移计划，交给 db 迁移账本按版本原子执行。 */
export const feishuMigrations: dbModule.MigrationPlan = {
  plugin: name,
  migrations: [
    { version: 1, sql: tablesSql },
    { version: 2, sql: seenCompositeSql },
  ],
};


declare module 'cordis' {
  interface Context {
    /** 飞书渠道。没挂这个插件时 ctx.get('feishu') 是 undefined。 */
    feishu: Feishu;
  }
  interface Events {
    /**
     * 通过指定机器人向飞书聊天发送本地文件。
     * 谁发：src7/plugins/relay/index.ts 的 Relay.sendFile
     * 谁接：src7/plugins/feishu/index.ts 的 Feishu.constructor
     */
    'feishu/send-file'(request: SendFileRequest): void | Promise<void>;
    /**
     * 返回发送结果，失败时带原因。
     * 谁发：src7/plugins/feishu/index.ts 的 Feishu.constructor
     * 谁接：src7/plugins/relay/index.ts 的 Relay.sendFile
     */
    'feishu/send-file-result'(result: SendFileResult): void;
    /**
     * 温和撤回飞书机器人刚发出的占位消息（如 relay 真回复发出后撤回“已转给…”）。
     * 谁发：src7/plugins/relay/index.ts 的 Relay.recallAckMessage
     * 谁接：src7/plugins/feishu/index.ts 的 Feishu.constructor
     */
    'feishu/recall-message'(request: RecallMessageRequest): void | Promise<void>;
    /**
     * 返回占位消息撤回结果；无撤回权限、超时或超撤回时限均回 ok: false，绝不阻断主流程。
     * 谁发：src7/plugins/feishu/index.ts 的 Feishu.constructor
     * 谁接：src7/plugins/relay/index.ts 的 Relay.recallAckMessage
     */
    'feishu/recall-message-result'(result: RecallMessageResult): void;
  }
}


/** 飞书的回话地址，记在会话的 row.address 上。 */
export interface FeishuAddress {
  /** 哪个飞书应用收的，就从哪个应用发回去。 */
  appId: string;
  /** 哪个聊天（私聊、群都有）。 */
  chatId: string;
  /** 用户那条消息；点卡片时是卡片那条。 */
  messageId: string;
  /** 谁发的；点卡片时是点的人。 */
  openId: string;
  /** p2p 私聊、group 群聊；点卡片时飞书不给，是 ''。 */
  chatType: string;
  /** 客户号：私聊 feishu:<open_id>，群聊 feishu:group:<chat_id>。给前台分会话、记忆检索用。 */
  customer?: string;
  /** 挂上的“敲键盘”表情号，回话时撤。 */
  typingReaction?: string;
  /** 是否用户本人：收消息和点卡片时，按 people 里登记的 role: owner 写入。 */
  owner?: boolean;
  /** 说话人是哪一档（people 的 role，没登记是 guest）：approval 照它收工具。和 owner 一样收消息、点卡片时写。 */
  role?: configModule.FeishuRole;
  /**
   * builder、guest 的目录（people 的 dir；没登记的 guest 是 guests/_guest/）：
   * 这一轮的工作区，读写、exec、发文件都只在这里（utils/Workspace.ts 的 of 读）。owner 不写。
   */
  workspace?: string;
  /** 说话人的名字：people 里登记的，没登记用群成员里查到的；都没有不写。relay 记收件、前台记群聊用。 */
  senderName?: string;
  /** 群名：groups 里登记的，没登记用群信息查到的；都没有、私聊不写。 */
  chatName?: string;
  /** 这个群登记的 listen: judge：只听的话进 bots 的群攒批，攒一批再问决策模型要不要接话（bots/GroupBatch.ts 读）；不是 judge 的群不写。 */
  judge?: boolean;
  /** 这个群登记的 judge_threshold：决策模型的把握 ≥ 它才接话（传给 decision 的 allowAt）；没写不写，用 decision 插件默认。 */
  judgeThreshold?: number;
  /** 前台判断完写回来的流水结果（judge:回 / judge:不回(0.32)）：onMessage 收尾记进来往流水那一行。 */
  judged?: string;
  /** 这个群登记的 judge_helper：群攒批判定要接话时，这批话转给这个外部助手（relay 的 helpers 里的名字），不由机器人自答（bots/GroupBatch.ts 读）；没登记不写。 */
  judgeHelper?: string;
  /** 这个群登记的 relay：model 时 @ 机器人的话由模型判断要不要转外部助手（relay 读）；没登记不写。 */
  relay?: 'direct' | 'model';
  /** 这个群登记的 trusted：true 时本人在群里说话照旧带私人记忆（memory/MemoryKey.ts 的 canReadAll 读）；没登记、私聊不写，当 false。 */
  trusted?: boolean;
}


/**
 * 飞书的客户号：私聊按人，群聊按群（和微信按聊天一场一样；群和私聊不共用，免得回话地址被冲掉）。
 * @param chatType p2p / group；点卡片时常是空的。
 * @param chatId 聊天号。
 * @param openId 发言人或点卡片的人。
 * @param p2pChat 点卡片、chatType 空时：这个 chatId 是不是已经记过的私聊。
 */
export function feishuCustomer(chatType: string, chatId: string, openId: string, p2pChat = false): string {
  if (chatType === 'group' && chatId !== '') return `feishu:group:${chatId}`;
  if (chatType === 'p2p' && openId !== '') return `feishu:${openId}`;
  if (chatType === '' && p2pChat && openId !== '') return `feishu:${openId}`;
  if (chatType === '' && chatId !== '' && !p2pChat) return `feishu:group:${chatId}`;
  if (openId !== '') return `feishu:${openId}`;
  if (chatId === '') return '';

  return `feishu:group:${chatId}`;
}


/** 一个应用运行时的样子。 */
export interface AppState {
  /** 配置里那一项。 */
  config: configModule.FeishuApp;
  /** SDK 客户端：调开放接口用，令牌 SDK 自己管。 */
  client: lark.Client;
  /** 长连接；ready 以后才有。 */
  ws?: lark.WSClient;
  /** 连接状态：“还没连”“已连上”“断线重连中”“已重连”“出错 原因”。 */
  state: string;
  /** 通不通。 */
  connected: boolean;
  /** 状态变的时刻，毫秒。 */
  at: number;
  /** 机器人自己的 open_id：认群里是不是 @ 了它。连上以后去查，查不到是 undefined。 */
  botOpenId?: string;
}


/** 一个群的名字和成员名字，查一次记一阵（Feishu.chatNames）。 */
interface ChatNames {
  /** 群名；查不到是 ''。 */
  name: string;
  /** 成员 open_id → 名字。 */
  members: Map<string, string>;
  /** 查的时刻，毫秒。 */
  at: number;
}


/** 卡片按钮给用户的小提示。 */
export interface Toast {
  /** success、info、warning、error。 */
  type: string;
  /** 一句话。 */
  content: string;
}


/** 去重记录留几天：连上时删更早的“收到”记录。 */
const SEEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** 飞书应用号的样子：SDK 长连接只认这种（lib/index.js WSClient.start）。 */
const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/u;

/** 长连接握手最多等多久，毫秒。 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * 每个飞书开放接口请求最多等多久，毫秒（发消息、上传文件、拉历史都算；上传大文件也够）。
 * 飞书是真走网络的那一层，自己限时：到点 axios 断开，Api.call 抛普通错，回执照旧记“发没发到不确定”；
 * 等飞书的插件（channels 回话、relay 发文件）不再自己掐表。
 */
const HTTP_TIMEOUT_MS = 60_000;

/** 群名、群成员名字查过以后记多久，毫秒；过了再查（有人改名、新进群）。 */
const CHAT_NAMES_MS = 10 * 60 * 1000;


/**
 * 给 SDK 的日志：只打警告以上，而且每条只取一句话。
 * SDK 自己出错时会把 axios 的整个错误对象交给日志，里面有请求头（令牌）和请求体（换令牌时带着 app_secret），原样打会漏密钥。
 */
const SDK_LOGGER = {
  error: (...parts: unknown[]): void => {
    console.error(`飞书 SDK：${brief(parts)}`);
  },
  warn: (...parts: unknown[]): void => {
    console.error(`飞书 SDK：${brief(parts)}`);
  },
  info: (): void => undefined,
  debug: (): void => undefined,
  trace: (): void => undefined,
};


/**
 * SDK 日志的几段拼成一句：错误只取 message，字符串照写，别的对象不打（可能带请求配置）。
 * @param parts SDK 交给日志的东西。
 * @returns 一句话。
 */
function brief(parts: unknown[]): string {
  const said = parts.flatMap((part) => {
    if (part instanceof Error) return [part.message];
    if (typeof part === 'string') return [part];
    //M SDK 有时把几段包成一个数组再交过来：拆开照同样的规矩取。
    if (Array.isArray(part)) return [brief(part)];
    //M 别的对象只取 message、code 两项（axios 错误这类），不打整个对象。
    const shaped = part as { message?: unknown; code?: unknown } | null;
    if (typeof shaped?.message === 'string') {
      if (typeof shaped.code === 'string') return [`${shaped.message}（${shaped.code}）`];

      return [shaped.message];
    }
    return [];
  });
  return said.join(' ').slice(0, 300);
}


/** 发送选项；多个应用时用 appId 精确指定。 */
export interface SendFileOptions {
  /** 上传类型；不填按扩展名识别。 */
  kind?: 'image' | 'file' | 'video';
  /** 必须属于 bot 的应用号。 */
  appId?: string;
  /** 要回复的消息号；失败退回普通发送。 */
  messageId?: string;
}

/** 其他插件提交的文件投递请求。 */
interface SendFileRequest extends requestEventModule.RequestEnvelope, Pick<SendFileOptions, 'appId' | 'messageId'> {
  /** 发送文件的机器人名。 */
  bot: string;
  /** 目标飞书聊天号。 */
  chatId: string;
  /** 本地文件绝对路径。 */
  filePath: string;
  /** 显式指定图片或附件；省略时按扩展名识别。 */
  kind?: 'image' | 'file';
}

/** 文件投递回执。 */
interface SendFileResult extends requestEventModule.ResultEnvelope {
  /** 飞书发送是否成功。 */
  ok: boolean;
  /** 飞书返回的新消息号。 */
  messageId?: string;
  /** 发送失败原因。 */
  error?: string;
}

/** 撤回单条机器人占位消息的请求载荷。 */
export interface RecallMessageRequest extends requestEventModule.RequestEnvelope {
  /** 发出占位消息的机器人名。 */
  bot: string;
  /** 飞书消息号（如 om_xxx）。 */
  messageId: string;
  /** 所属应用号；不填时在单应用机器人下自动选用。 */
  appId?: string;
  /** 可选所属聊天号，用于核验与同步标记本地聊天日志。 */
  chatId?: string;
}

/** 撤回单条机器人占位消息的回执。 */
export interface RecallMessageResult extends requestEventModule.ResultEnvelope {
  /** 是否已成功撤回（含已被删除）。 */
  ok: boolean;
  /** 未撤成时的原因说明。 */
  error?: string;
}

/**
 * 所有 SDK 客户端共用的 HTTP 实例。Feishu.createClients 调。
 * 每个请求自己限时（HTTP_TIMEOUT_MS），挂住的请求到点断开、算不确定，不让等它的会话一直等。
 * Bun 的 node:http 上传仍会走环境代理：仅 multipart 改用原生 fetch，并显式直连；不改进程环境或 SDK 共享实例，普通接口、流式下载仍走 SDK 默认传输。
 * @returns 带请求、响应拦截器的 axios 实例。
 */
function getHttpInstance(): ReturnType<typeof lark.defaultHttpInstance.create> {
  const httpOptions = { timeout: HTTP_TIMEOUT_MS };
  const httpInstance = lark.defaultHttpInstance.create(httpOptions);
  httpInstance.interceptors.request.use((request) => {
    //M 对 multipart/form-data 请求改走原生 fetch 直连，绕开 Bun node:http 的代理链路。
    if (String(request.headers.get('Content-Type')).startsWith('multipart/form-data')) {
      request.adapter = 'fetch';
      request.env = { FormData: globalThis.FormData };
      request.fetchOptions = { proxy: '' };
    }
    return request;
  });
  //M create 不继承 SDK 的响应拦截器：保留普通响应解包和下载所需的响应头。
  httpInstance.interceptors.response.use((response) => {
    if ((response.config as { $return_headers?: boolean }).$return_headers) {
      return { data: response.data, headers: response.headers };
    }
    return response.data;
  });
  return httpInstance;
}


/** 飞书渠道；外部发送复用实例方法。 */
export class Feishu {
  /** 渠道名。 */
  readonly name = 'feishu';

  /** 应用号 → 应用，照配置的先后（Reply.ts、Inbound.ts 也读）。 */
  readonly apps = new Map<string, AppState>();

  /** 群号 → 群名和成员名字（chatNames 查的；Reply.ts 认目标聊天也读）。 */
  readonly chats = new Map<string, ChatNames>();

  /** 收：收消息、撤回、点卡片，start 把 SDK 的事件交给它（Inbound.ts）。 */
  readonly inbound: FeishuInbound;

  /** 聊天原始日志，供撤回核验与回复定位。 */
  readonly history: FeishuChatLog;

  /** 来往流水：记、读 data/logs/feishu-contacts.jsonl，听 bot/judged 补记（Contacts.ts）。 */
  readonly contacts: FeishuContacts;

  /** 回话：响应 channel/reply（Reply.ts）。 */
  readonly reply: FeishuReply;

  /** 拉群历史：HTTP 接口和机器人新进群调它（HistoryPull.ts）。 */
  readonly historyPull: FeishuHistoryPull;

  /**
   * 建表、给每个应用建 SDK 客户端；ready 时连长连接；被拔掉时关长连接。
   * 向 bots 登记本渠道名（网页的渠道清单用）；所有回话都经 channel/reply 到 Reply.ts。
   * 构造函数只做登记，建表、建客户端、发文件、关连接写成下面的方法。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验过的配置。
   */
  constructor(private readonly ctx: cordis.Context, readonly config: configModule.FeishuConfig) {
    //M 向 bots 登记渠道名，随本插件卸载由 Cordis 自动撤销。
    this.ctx.effect(() => this.ctx.bots.channel(this.name));

    //M 建本插件的表，再给每个应用建 SDK 客户端。
    this.createTables();
    this.createClients();

    //M 收（Inbound.ts）：不登记事件，start 把长连接收到的消息、撤回、点卡片交给它。
    this.inbound = new FeishuInbound(this.ctx, this);

    //M 都挂完了才连：这时候机器人、前台都在了，收到的消息有人接。
    this.ctx.on('ready', () => {
      this.connect();
    });

    //M 来往流水（Contacts.ts）：自己登记 bot/judged 监听，前台判断完补记一行。
    this.contacts = new FeishuContacts(this.ctx, this);

    //M 网页问连接状态（web-api 发，挨个问）。没挂 web-api 就没人问。
    this.ctx.on('web-api/status', (list) => {
      this.status(list);
    });

    //M 回话（Reply.ts）：自己登记 channel/reply（会话的回复）和 channel/send（已批准的主动发件）监听。
    this.reply = new FeishuReply(this.ctx, this);

    //M 保留飞书聊天原始日志，供撤回核验与回复定位。
    this.history = new FeishuChatLog(this.ctx);

    //M 拉群历史：用聊天日志去重，拼好的历史发 channel/history。
    this.historyPull = new FeishuHistoryPull(this.ctx, this);

    //M 别的插件请本插件发文件（feishu/send-file）和撤回占位消息（feishu/recall-message）。
    const requestOptions = {
      onError: (error: unknown) => this.onSendFileError(error),
    };
    //M 挂载 feishu/send-file 请求-回执监听，由 onSendFile 执行上传发送。
    requestEventModule.onRequestEvent(
      this.ctx,
      'feishu/send-file',
      'feishu/send-file-result',
      (request) => this.onSendFile(request),
      requestOptions,
    );
    //M 挂载 feishu/recall-message 请求-回执监听，由 onRecallMessage 温和撤回占位消息。
    requestEventModule.onRequestEvent(
      this.ctx,
      'feishu/recall-message',
      'feishu/recall-message-result',
      (request) => this.onRecallMessage(request),
      requestOptions,
    );

    //M 被拔掉时关掉每条长连接。ctx.effect：先执行一次（这里什么也不做），交回的函数在插件被拔掉时 Cordis 来调。
    this.ctx.effect(() => () => {
      this.closeConnections();
    });
  }

  /** 通过 db 迁移账本建表并把旧 feishu_seen 无损升级为复合主键。 */
  private createTables(): void {
    //M 优先复用宿主挂载的 db 服务；未挂时回退同连接 Db 走同一迁移账本。
    const dbService = this.ctx.get('db');
    if (dbService !== undefined) {
      //M 宿主已挂载 db 服务时直接复用主库迁移账本按版本执行。
      dbService.migrate(feishuMigrations);
      return;
    }

    //M 未注入 db 服务的独立环境（如单测）用同连接 Db 走完全同一份迁移账本，不手写裸建表。
    const standalone = new dbModule.Db(new cordis.Context(), this.ctx.resources.db);
    //M 原子应用 feishu 表创建与 feishu_seen 复合主键迁移。
    standalone.migrate(feishuMigrations);
  }

  /**
   * 给每个应用建 SDK 客户端，记进 apps（状态“还没连”）。所有客户端共用一个 HTTP 实例（getHttpInstance）。
   * 构造函数调一次。
   */
  private createClients(): void {
    //M 建本插件共用的带 60 秒超时及直连 multipart 的 axios 实例。
    const httpInstance = getHttpInstance();
    for (const app of this.config.apps) {
      const client = new lark.Client({
        //M 响应拦截器已解包为 SDK 的 HttpInstance 返回契约。
        httpInstance: httpInstance as unknown as lark.HttpInstance,
        appId: app.appId,
        appSecret: app.appSecret,
        domain: this.config.domain,
        loggerLevel: lark.LoggerLevel.warn,
        logger: SDK_LOGGER,
      });
      this.apps.set(app.appId, { config: app, client, state: '还没连', connected: false, at: Date.now() });
    }
  }

  /**
   * feishu/send-file：别的插件请本插件发文件。沿用应用归属校验、上传和发送逻辑（sendFile）。
   * @param request 机器人、聊天号、文件路径，可选应用号、种类、要回复的消息号。
   * @returns 发成了和新消息号。
   * @throws sendFile 抛的错（应用不对、上传失败等），由 onSendFileError 转成回执。
   */
  private async onSendFile(request: SendFileRequest): Promise<{ ok: true; messageId: string }> {
    const options: SendFileOptions = {
      appId: request.appId,
      kind: request.kind,
      messageId: request.messageId,
    };

    //M 等上传并发送完成，再交回新消息号。
    const messageId = await this.sendFile(request.bot, request.chatId, request.filePath, options);
    return { ok: true, messageId };
  }

  /**
   * feishu/recall-message：温和撤回机器人刚发出的占位消息，权限不足或过期仅回 ok: false。
   */
  private async onRecallMessage(request: RecallMessageRequest): Promise<Omit<RecallMessageResult, 'requestId'>> {
    const candidates = [...this.apps.values()]
      .filter((app) => app.config.bot === request.bot || app.config.bots?.includes(request.bot))
      .map((app) => app.config.appId);
    let appId = request.appId ?? '';
    if (appId === '' && candidates.length === 1) {
      appId = candidates[0] ?? '';
    }
    //G 无论是否显式传了 appId，都必须确认归属该 bot（在 candidates 内）且应用已加载。
    if (appId === '' || !candidates.includes(appId) || !this.apps.has(appId)) {
      return { ok: false, error: `无法确定归属机器人 ${request.bot} 的飞书应用：${request.appId ?? request.bot}` };
    }
    //M 应用归属核验通过，委托 Recall 模块温和撤回目标占位消息。
    return recall.recallBotMessage(this, appId, request.chatId, request.messageId);
  }

  /**
   * feishu/send-file 处理抛错时的回执：发文件失败，把原因交给调用方。
   * @param error 抛出的错。
   */
  private onSendFileError(error: unknown): { ok: false; error: string } {
    //M 提取可读错误文本作为文件发送失败回执原因。
    const detail = textModule.getErrorMessage(error);
    return { ok: false, error: detail };
  }

  /** 插件被拔掉时关掉每条长连接。 */
  private closeConnections(): void {
    for (const app of this.apps.values()) {
      app.ws?.close();
    }
  }

  /**
   * 这个机器人的飞书应用号，照配置先后（卡片、云文档用）。
   * @param bot 机器人名。
   * @returns 应用号；没有是空数组。
   */
  getApps(bot: string): string[] {
    return [...this.apps.values()].filter((app) => app.config.bot === bot).map((app) => app.config.appId);
  }

  /**
   * 这个应用最近私聊的人（发件箱、没会话的卡片、云文档权限用）。
   * @param appId 哪个应用；不给用配置里第一个。
   * @returns 回话地址；没人私聊过是 undefined。
   */
  lastPrivate(appId?: string): FeishuAddress | undefined {
    const id = appId ?? this.config.apps[0]?.appId ?? '';
    const sql = 'SELECT app_id, chat_id, open_id, message_id FROM feishu_p2p WHERE app_id = ?';
    //M 从 feishu_p2p 表查该应用最近一次私聊的会话与联系人定位。
    const row = this.ctx.resources.db.query(sql).get(id) as
      { app_id: string; chat_id: string; open_id: string; message_id: string } | null;
    if (row === null) return undefined;
    //M 按统一客户键规则拼出完整的私聊回话地址结构。
    return {
      appId: row.app_id,
      chatId: row.chat_id,
      messageId: row.message_id,
      openId: row.open_id,
      chatType: 'p2p',
      customer: feishuCustomer('p2p', row.chat_id, row.open_id),
    };
  }

  /**
   * 这个应用的 SDK 客户端。
   * @param appId 应用号。
   * @returns 客户端。
   * @throws 没有这个应用时抛错。
   */
  client(appId: string): lark.Client {
    //M 查已初始化的应用状态表取出其专属飞书 SDK 客户端。
    const app = this.apps.get(appId);
    if (app === undefined) {
      throw new Error(`没有飞书应用 ${appId}`);
    }
    return app.client;
  }

  /** 上传并发送本地文件，返回 message_id；多应用未指定 appId 时拒绝猜测。 */
  async sendFile(bot: string, chatId: string, filePath: string, options: SendFileOptions = {}): Promise<string> {
    //M 查出该机器人绑定的全部飞书应用号，单应用时默认选用，多应用须显式指定。
    const apps = this.getApps(bot);
    let singleAppId: string | undefined;
    if (apps.length === 1) {
      singleAppId = apps[0];
    }
    const appId = options.appId ?? singleAppId;
    if (!appId || !apps.includes(appId)) throw new Error('请指定属于该机器人的飞书 appId');
    if (!chatId) throw new Error('发送文件需要 chatId');
    //M 校验应用归属和目标聊天后转交媒体模块执行上传并发送文件。
    return media.sendFile(this, appId, chatId, filePath, options.kind, options.messageId);
  }

  /** @returns 本插件的数据库连接（cards/、outbox/ 用）。 */
  get db(): Database {
    return this.ctx.resources.db;
  }

  /**
   * 响应 ready：每个应用连长连接；一个连不上只打一行错、状态记“出错 原因”，不挡别的应用。
   * 副作用：删 7 天前的去重记录；开长连接。
   */
  private connect(): void {
    //M 启动连线前清理超过 7 天的入站消息去重缓存。
    this.ctx.resources.db.query("DELETE FROM feishu_seen WHERE kind = 'in' AND at < ?").run(Date.now() - SEEN_KEEP_MS);
    for (const app of this.apps.values()) {
      //M 逐个并行发起飞书长连接启动流程，单应用异常不影响其余应用。
      void this.start(app);
    }
  }

  /**
   * 连一个应用的长连接。
   * @param app 哪个应用。
   */
  private async start(app: AppState): Promise<void> {
    const appId = app.config.appId;

    //G 应用号格式不对 → SDK 的长连接只打一行日志就不连了（lib/index.js WSClient.start），这里记成“出错”，网页小圆点看得到。
    if (!APP_ID_PATTERN.test(appId)) {
      this.mark(app, '出错 app_id 不对：飞书应用号是 cli_ 加 16 位十六进制', false);
      return;
    }

    //M 分发器：收消息、点卡片两个事件干活；已读、表情、进私聊几个登记空处理，免得 SDK 打“没有处理”的警告。
    //M   收消息不等它处理完就交回：下载大文件可能很久，飞书等不到确认会重推（重推的有去重挡着）。
    //M   点卡片要等：交回的 { toast } 就是给飞书的回应，SDK 把它带回去（lib/index.js handleEventData）。
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn, logger: SDK_LOGGER }).register({
      'im.message.receive_v1': (data: ReceiveData) => {
        //T 跟踪：长连接收到一条消息，轨迹的第一格；messageId 是标准消息号，journal 按它把后面的行串起来。
        const vars = {
          appId: appId,
          messageId: JSON.stringify([this.name, appId, data.message.message_id]),
          type: data.message.message_type,
          chat: data.message.chat_type,
        };
        this.ctx.emit('trace', 'Feishu.start', 'trace.feishu.wsReceived', 'im.message.receive_v1', vars);
        //M 长连接回调不阻塞 ACK，异步交由 FeishuInbound.onMessage 按应用与消息号去重分派。
        void this.inbound.onMessage(appId, data);
      },
      'im.message.recalled_v1': (data: RecallData) => {
        //M 收到消息撤回事件时异步核对本人或原发信人身份并通知机器人停止对应任务。
        void this.inbound.onRecall(appId, data);
      },
      //M 交互卡片按钮点击必须异步等候校验与业务结果，以便把 toast 及时带回飞书客户端。
      'card.action.trigger': (data: unknown) => this.inbound.onCard(appId, data),
      'im.message.message_read_v1': () => undefined,
      'im.message.reaction.created_v1': () => undefined,
      'im.message.reaction.deleted_v1': () => undefined,
      'im.chat.access_event.bot_p2p_chat_entered_v1': () => undefined,
      //M 机器人新进群：异步拉一次最近的历史（不等它，失败只打日志）。开放平台要订阅“机器人进群”事件才会收到。
      'im.chat.member.bot.added_v1': (data: { chat_id?: string }) => {
        if (data.chat_id === undefined) return;

        //M 异步补拉新进群最近历史，失败仅打控制台日志。
        void this.historyPull.onJoin(app, data.chat_id);
      },
    });

    const ws = new lark.WSClient({
      appId,
      appSecret: app.config.appSecret,
      domain: this.config.domain,
      loggerLevel: lark.LoggerLevel.warn,
      logger: SDK_LOGGER,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      onReady: () => {
        //M 长连接建链成功后登记连通状态并异步探测机器人自身 open_id（用于群内 @ 识别）。
        this.mark(app, '已连上', true);
        void this.findSelf(app);
      },
      onReconnecting: () => {
        //M 长连接断开重连时更新渠道面板状态为断线重连中。
        this.mark(app, '断线重连中', false);
      },
      onReconnected: () => {
        //M 重连恢复后把状态切回已连接。
        this.mark(app, '已重连', true);
      },
      onError: (error) => {
        //M 长连接运行时底层报错时记录异常信息以便状态圆点展示。
        this.mark(app, `出错 ${error.message}`, false);
      },
    });
    app.ws = ws;
    try {
      //M 正式开启飞书长连接并挂接事件分发器。
      await ws.start({ eventDispatcher: dispatcher });
    } catch (error) {
      //M 长连接握手或启动抛错时提取可读报错写入状态面板。
      this.mark(app, `出错 ${textModule.getErrorMessage(error)}`, false);
    }
  }

  /**
   * 记下连接状态变了，打一行日志。
   * @param app 哪个应用。
   * @param state 新状态。
   * @param connected 通不通。
   */
  private mark(app: AppState, state: string, connected: boolean): void {
    app.state = state;
    app.connected = connected;
    app.at = Date.now();
    //M 取带日期的时间戳前缀写入连接状态变化日志。
    const logTime = textModule.formatLocalTime(Date.now(), 'date');
    const line = `${logTime} 飞书 ${app.config.appId}（${app.config.bot}）${state}`;
    if (connected) {
      console.log(line);
    }
    if (!connected) {
      console.error(line);
    }

    //T 跟踪：飞书连接状态变了。
    const vars = { appId: app.config.appId, bot: app.config.bot, state: state };
    this.ctx.emit('trace', 'Feishu.mark', 'trace.feishu.connectionChanged', 'app.state = state', vars);
  }

  /**
   * 查机器人自己的 open_id，认群里是不是 @ 了它。查不到就算了：群里只要有人被 @ 就当是 @ 它。
   * @param app 哪个应用。
   */
  private async findSelf(app: AppState): Promise<void> {
    try {
      //M 调开放平台接口查询当前应用对应机器人的 open_id，用于精准判别群消息是否 @ 自己。
      const info = await api.call('查机器人信息', () => app.client.request<{ code?: number; bot?: { open_id?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      }));
      app.botOpenId = info.bot?.open_id;
    } catch (error) {
      //M 查询自身信息失败仅记日志不阻断连线，后续群 @ 退回模糊放行策略。
      const logTime = textModule.formatLocalTime(Date.now(), 'date');
      const errText = textModule.getErrorMessage(error);
      console.error(`${logTime} 飞书 ${app.config.appId} 没查到机器人自己的 open_id（群里有 @ 就回）：${errText}`);
    }
  }

  /**
   * 群名和群成员的名字：飞书的收消息事件不带名字，这里查群信息、群成员（只取第一页 100 人），记 CHAT_NAMES_MS。
   * 查不到（应用没开权限、断网）只打日志，交回空的，由用的人退回 chat_id、open_id 后 6 位；查不到的也记下，免得每句话都查一次。
   * @param app 哪个应用收的。
   * @param chatId 群号。
   * @returns 群名、成员名字。
   */
  async chatNames(app: AppState, chatId: string): Promise<ChatNames> {
    //M 先命中未过期的群信息本地缓存，减少群聊高频发言带来的接口请求。
    const known = this.chats.get(chatId);
    if (known !== undefined && Date.now() - known.at < CHAT_NAMES_MS) return known;

    const found: ChatNames = { name: '', members: new Map(), at: Date.now() };
    try {
      //M 拉取群名称元数据。
      const chat = await api.call('查群信息', () => app.client.request<{ data?: { name?: string } }>({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${chatId}`,
      }));
      found.name = chat.data?.name ?? '';

      //M 拉取首屏最多 100 位群成员的 open_id 与显示名对照表。
      type GroupMembers = { data?: { items?: { member_id?: string; name?: string }[] } };
      const members = await api.call('查群成员', () => app.client.request<GroupMembers>({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${chatId}/members`,
        params: { member_id_type: 'open_id', page_size: 100 },
      }));
      for (const member of members.data?.items ?? []) {
        if (member.member_id !== undefined && member.name !== undefined) {
          found.members.set(member.member_id, member.name);
        }
      }
    } catch (error) {
      //M 查询失败时记录日期日志并缓存空名结构，避免同一群后续消息反复触发出错调用。
      const logTime = textModule.formatLocalTime(Date.now(), 'date');
      const reason = textModule.getErrorMessage(error);
      console.error(`${logTime} 飞书 ${app.config.appId} 没查到群 ${chatId} 的名字（用群号、open_id 后 6 位代替）：${reason}`);
    }
    this.chats.set(chatId, found);
    return found;
  }

  /**
   * 发文字，再发文字里 @"路径"、@路径 指的文件（存在的绝对路径文件才算），文字里换成「文件名」。
   * @param address 回话地址。
   * @param text 要发的话。
   * @returns 回执：都发了 accepted；有文件没发出去是 partial（原因写哪几个）。
   * @throws 地址没有 chatId（api.NotSent）、文字发不出去时抛错；某个文件发不出去时补发一句说明，不抛。
   */
  async sendText(address: FeishuAddress | undefined, text: string): Promise<SendTextReceipt> {
    if (address === undefined || typeof address.chatId !== 'string' || address.chatId === '') {
      //M 回话地址缺失 chatId 属于明确无法投递的目标错误，抛出 NotSent。
      throw new api.NotSent('飞书回话地址里没有 chatId，不知道发到哪');
    }
    const files: { token: string; file: string }[] = [];
    for (const match of text.matchAll(/@"([^"]+)"|@([^\s"]+)/gu)) {
      const file = match[1] ?? match[2] ?? '';
      //M 核查提取出的 @路径 确认为本地真实存在文件后，才收录为待上传附件。
      if (isFile(file)) files.push({ token: match[0], file });
    }
    let body = text;
    for (const item of files) {
      body = body.replace(item.token, `「${baseName(item.file)}」`);
    }
    //M 群里的话：@名字 换成飞书的 <at> 标签，才真的 @ 到人。
    body = this.mentioned(address, body);
    let messageId: string | undefined;
    if (body.trim() !== '') {
      messageId = await media.message(this, address.appId, address.chatId, 'text', { text: body }, address.messageId);
    }

    //M 文件一个个发；发不出去的补一句，不挡后面的。
    /** 没发出去的文件，每个一句原因；写进回执。 */
    const failed: string[] = [];
    for (const item of files) {
      try {
        //M 依次上传并发出从回话文本中识别到的单个本地文件附件。
        await media.sendFile(this, address.appId, address.chatId, item.file, undefined, address.messageId);
      } catch (error) {
        //M 单个附件发送失败时拼接文件名与失败原因，取日期前缀打印控制台，并补发文字告知用户。
        const said = `「${baseName(item.file)}」没发出去：${textModule.getErrorMessage(error)}`;
        const logTime = textModule.formatLocalTime(Date.now(), 'date');
        console.error(`${logTime} 飞书：${said}`);
        failed.push(said);
        //M 把该附件未送达的原因文字单独发到原会话，不阻断后续其余文件投递。
        await media.message(this, address.appId, address.chatId, 'text', { text: said }, address.messageId);
      }
    }

    //M 有文件没发出去：只发了一部分。
    if (failed.length > 0) return { status: 'partial', reason: failed.join('；'), messageId };

    return { status: 'accepted', reason: '', messageId };
  }

  /**
   * 这个群里认得的名字 → open_id：先流水里见过的说话人，再飞书群成员，最后 people 登记的（后写的盖前面的，所以登记的优先）。
   * @param address 回话地址：取群号。
   * @returns 名字 → open_id；名字空的不收。
   */
  private getNames(address: FeishuAddress): Map<string, string> {
    const found = new Map<string, string>();

    //M 流水里这个群见过的说话人。
    for (const line of this.contacts.list(1000)) {
      if (line.chatId === address.chatId && line.sender !== '' && line.openId !== '') {
        found.set(line.sender, line.openId);
      }
    }

    //M 飞书查到的群成员（chatNames 缓存的）。
    for (const [openId, name] of this.chats.get(address.chatId)?.members ?? []) {
      if (name !== '') found.set(name, openId);
    }

    //M people 登记的名字最准，盖掉前面的。
    for (const person of this.config.people.values()) {
      if (person.name !== '') found.set(person.name, person.openId);
    }
    return found;
  }

  /**
   * 群里的话：本机绝对路径换成文件名、目录名（用户 #301：群里不报本机路径）；
   * 再把 @名字 换成 <at user_id="open_id">名字</at>，认不出的名字原样留着。私聊不动（本人自己的界面不打码）。
   * @param address 回话地址。
   * @param text 要发的话。
   * @returns 换好的话。
   */
  mentioned(address: FeishuAddress, text: string): string {
    //G 私聊原样返回。
    if (!protocol.isGroup(address)) return text;

    //M 群里所有人都看得到：本机绝对路径只留最后一段（utils/Text.ts 的 hideLocalPaths）。
    const hidden = textModule.hideLocalPaths(text);

    //G 正文不含 @ 符号时无需转换 <at> 标签。
    if (!hidden.includes('@')) return hidden;

    //M 长名字先换，免得“陈”抢了“陈大管家”。
    const known = this.getNames(address);
    let body = hidden;
    for (const name of [...known.keys()].sort((a, b) => b.length - a.length)) {
      body = body.replaceAll(`@${name}`, `<at user_id="${known.get(name) ?? ''}">${name}</at>`);
    }
    return body;
  }

  /**
   * 群里的回信开头 @ 这一轮最后说话的人（回话地址里的 openId）；名字先 people，再地址里查到的，再群成员，都没有用 open_id 后 6 位。
   * 话里已经 @ 了他就不重复。私聊、没有 openId 的地址、空话不动。
   * @param address 回话地址。
   * @param reply 机器人的话。
   * @returns 加好 @ 的话。
   */
  withAt(address: FeishuAddress | undefined, reply: string): string {
    //G 私聊、无目标发言人 openId 或空回复不额外前置 @ 标签。
    if (address === undefined || !protocol.isGroup(address)) return reply;
    if (address.openId === '' || reply.trim() === '') return reply;

    //M 话里已经 @ 了他（周小灵自己写的 @名字 也算）：不再加。
    const converted = this.mentioned(address, reply);
    const tag = `user_id="${address.openId}"`;
    if (converted.includes(tag)) return reply;

    //M 依优先级解析收信人显示名（配置通讯录 → 地址自带 → 群成员缓存 → openId 后 6 位）。
    const name = this.config.people.get(address.openId)?.name || address.senderName
      || this.chats.get(address.chatId)?.members.get(address.openId) || address.openId.slice(-6);
    return `<at ${tag}>${name}</at> ${reply}`;
  }

  /**
   * 发一张卡片，记下卡片号属于哪个应用（改卡片时要）。
   * @param address 发到哪。
   * @param card 卡片 JSON。
   * @returns 卡片号（卡片消息的 message_id）。
   * @throws 发不出去时抛错。
   */
  async sendCard(address: FeishuAddress, card: unknown): Promise<string> {
    //M 发出交互卡片消息并把新生成的 cardId 与应用映射写进 feishu_seen 供后续更新卡片反查。
    const cardId = await media.message(this, address.appId, address.chatId, 'interactive', card);
    const sql = 'INSERT OR REPLACE INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)';
    this.ctx.resources.db.query(sql).run(cardId, address.appId, 'card', Date.now());
    return cardId;
  }

  /**
   * 原地换掉一张卡片。
   * @param cardId 卡片号。
   * @param card 新的卡片 JSON。
   * @throws 查不到这张卡片是哪个应用发的、改不成时抛错。
   */
  async updateCard(cardId: string, card: unknown): Promise<void> {
    const sql = "SELECT app_id FROM feishu_seen WHERE message_id = ? AND kind = 'card'";
    //M 从 feishu_seen 反查该卡片最初由哪只飞书应用发出。
    const row = this.ctx.resources.db.query(sql).get(cardId) as { app_id: string } | null;
    if (row === null) {
      throw new Error(`查不到卡片 ${cardId} 是哪个飞书应用发的`);
    }
    //M 取出发送应用对应的 SDK 客户端，带 429 重试原地 patch 卡片内容。
    const client = this.client(row.app_id);
    await api.call('改卡片', () => client.im.v1.message.patch({
      path: { message_id: cardId },
      data: { content: JSON.stringify(card) },
    }));
  }

  /**
   * 撤掉“敲键盘”表情。撤过就从地址上去掉，免得同一个地址撤两次；撤不掉只打日志。
   * @param address 回话地址。
   */
  async untype(address: FeishuAddress): Promise<void> {
    const reactionId = address.typingReaction;
    if (reactionId === undefined) return;
    delete address.typingReaction;
    try {
      //M 取收信应用 SDK 客户端并调接口删除原消息上的“正在输入”表情。
      const client = this.client(address.appId);
      await api.call('撤表情', () => client.im.v1.messageReaction.delete({
        path: { message_id: address.messageId, reaction_id: reactionId },
      }));
    } catch (error) {
      //M 撤表态失败仅带时间戳记日志，避免异常外溢影响主回话收尾。
      const logTime = textModule.formatLocalTime(Date.now(), 'date');
      console.error(`${logTime} 飞书：表情没撤掉：${textModule.getErrorMessage(error)}`);
    }
  }

  /**
   * 响应 web-api/status：每个应用放一项。
   * @param list web-api 给的清单，往里 push。
   */
  private status(list: ChannelStatus[]): void {
    for (const app of this.apps.values()) {
      const at = new Date(app.at).toLocaleString('zh-CN', { hour12: false });
      //M 把每个应用的连接状态和更新时间分别显示在网页上。
      list.push({
        name: `feishu:${app.config.appId}`,
        bot: app.config.bot,
        connected: app.connected,
        detail: `${app.state}（${at}）`,
      });
    }
  }

}


/**
 * 是不是一个存在的、绝对路径的文件。
 * @param file 路径。
 * @returns 是就是 true。
 */
function isFile(file: string): boolean {
  try {
    return (file.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(file)) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}


/**
 * 文件名：/ 和 \ 都算分隔。
 * @param file 路径。
 * @returns 最后一段。
 */
function baseName(file: string): string {
  return file.split(/[\\/]/u).pop() ?? file;
}


/**
 * 挂上飞书。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里的服务都就绪，再调一次 apply。
 * 建渠道、登记云文档工具和发件箱，并挂卡片监听。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins 段里写给它的：{ domain?: 飞书开放平台地址, people?: 认得的人, groups?: 专门设过的群 }。
 * @throws 配置不对时抛错。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  //M 先按运行配置校验飞书账号、人员和群规则，再创建飞书渠道主实例。
  const feishu = new Feishu(ctx, configModule.checkConfig(ctx, config));
  //M 挂成服务：别的插件用 ctx.get('feishu') 调 sendFile，不要 import 本文件的函数。
  ctx.provide('feishu', feishu);

  //M http 挂了（写在 feishu 前面）才有来往流水的接口：GET /api/feishu/contacts?limit=（默认 50，最多 1000），新的在前。
  const http = ctx.get('http');
  if (http !== undefined) {
    http.app.get<{ Querystring: { limit?: string } }>('/api/feishu/contacts', (request) => {
      const limit = textModule.parseBoundedInt(request.query.limit, 50, 1, 1000);
      return { items: feishu.contacts.list(limit) };
    });
  }

  //M http 挂了才有拉群历史的接口：POST /api/feishu/history { chat_id, app_id?, limit? }，在入口校验一次，再交给 HistoryPull.pull。
  if (http !== undefined) {
    type HistoryBody = { chat_id?: unknown; app_id?: unknown; limit?: unknown };
    http.app.post<{ Body: HistoryBody }>('/api/feishu/history', async (request, reply) => {
      const body = request.body ?? {};
      const chatId = body.chat_id;
      if (typeof chatId !== 'string' || chatId === '') return reply.code(400).send({ error: '要给 chat_id（群号）' });

      //G 一个应用时 app_id 可以不写；几个应用要写清用哪个。
      const appId = body.app_id ?? feishu.config.apps[0]?.appId;
      if (feishu.config.apps.length > 1 && body.app_id === undefined) {
        return reply.code(400).send({ error: '配了几个飞书应用，要给 app_id' });
      }
      let app: AppState | undefined;
      if (typeof appId === 'string') {
        app = feishu.apps.get(appId);
      }
      //G 指定的应用不存在或未初始化时返回 400 参数错误。
      if (app === undefined) return reply.code(400).send({ error: `没有飞书应用 ${String(appId)}` });

      const maxLimit = configModule.MAX_HISTORY_LIMIT;
      const limit = body.limit ?? configModule.DEFAULT_HISTORY_LIMIT;
      const limitValid = typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= maxLimit;
      if (!limitValid) {
        //G limit 超出合法整数范围时返回 400 参数错误。
        return reply.code(400).send({ error: `limit 要写 1 到 ${String(maxLimit)} 的整数` });
      }

      //M 拉的过程出错（权限不够等）把中文原因带回去，不悄悄失败。
      try {
        return await feishu.historyPull.pull(app, chatId, limit as number);
      } catch (error) {
        return reply.code(502).send({ error: textModule.getErrorMessage(error) });
      }
    });
  }

  //M 依次挂载飞书文件发送工具、云文档工具与定时发件箱监听，随插件同生命周期撤销。
  media.setup(feishu, ctx);
  doc.setup(feishu, ctx);
  recall.setup(feishu, ctx);
  outbox.setup(feishu, ctx);

  //M 直接订阅审批和进度通知，相关插件迟挂时也能收到更新。
  cards.setupApproval(feishu, ctx);
  cards.setupProgress(feishu, ctx);
}
