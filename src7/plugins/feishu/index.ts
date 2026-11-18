/**
 * 飞书：一个插件管飞书的全部——渠道收发（这个文件）、确认卡片和进度卡片（cards/）、飞书云文档工具（doc/）、发件箱（outbox/）。
 * 用户定了：平台型插件放在一个插件里，用子文件夹分管功能。设计：docs/src7插件设计/feishu.md。
 *
 * 渠道：照 config.yaml 的 channels.feishu 名单，一个飞书应用一个 SDK 客户端、一条长连接（WebSocket），等 ready 才连。
 * 渠道只有一个，名字 feishu；回话地址（FeishuAddress）里的 appId 分清是哪个应用，回话从收消息的那个应用发回去。
 * 收：什么类型都接住，图片文件下载后用基类 saveFile 存进机器人工作区，话里写 @绝对路径；按消息号去重（存表，重启也认得）。
 * 群里只回 @ 了机器人的消息；插件配置 groups 里登记了 listen: all 的群，不 @ 的也交下去，标成只听（listenOnly）：
 * 以外部助手前缀开头的 relay 照转，别的前台只记进群的前台会话当背景、不回。listen: judge 的群同样不 @ 也听，前台记完问决策模型要不要主动接话（0.7.19）。
 * 发到群里的话：开头 @ 这一轮最后说话的人，文字里的 @名字 换成 <at user_id="…">名字</at>（名字→open_id 先查 people，再查群成员、流水里见过的）。
 * 认人认群看插件配置的 people、groups（谁是哪一档只在这里判断，写进回话地址的 owner、role、workspace）；收到的每条都记进来往流水 data/logs/feishu-contacts.jsonl。发：文字整条发，文字里的 @路径 换成「文件名」再一个个发文件。
 *
 * Cordis 大白话：apply 是插件的 main()，ctx 是它拿到的遥控器；通过 ctx 听的事件、登记的工具、ctx.effect 登记的收尾，
 * 插件被拔掉时 Cordis 自动撤掉。approval、progress 这两个服务“有就用”：ctx.inject([服务], 回调) 等于再挂一个小插件，
 * 服务来了 Cordis 才调回调（卡片开工），服务走了小插件自动拔掉（卡片停工），飞书别的功能不受影响。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import * as lark from '@larksuiteoapi/node-sdk';
import type * as cordis from 'cordis';
import type { Session, SessionMeta } from '../../Sessions.ts';
import * as namesModule from '../../utils/Names.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as protocol from '../../Channels.ts';
import * as api from './Api.ts';


/** 旧路 bots.channel 回调发送回执（结构对齐 bots 服务约定）。 */
interface LegacySendReceipt {
  status: 'accepted' | 'partial' | 'uncertain' | 'rejected';
  reason: string;
}


/** 旧路 bots.channel 回调来源地址（结构对齐 bots 服务约定）。 */
interface LegacyOrigin {
  channel?: string;
  address?: unknown;
}
import * as cards from './cards/Cards.ts';
import * as doc from './doc/Doc.ts';
import * as media from './Media.ts';
import * as outbox from './outbox/Outbox.ts';


/** 插件名。 */
export const name = 'feishu';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.2：channel/history 支持本人（owner）跨渠道、跨聊天查询飞书本地历史；外人仍仅限当前聊天。
//M 1.1.3：监听 im.message.recalled_v1 撤回消息事件，校验本人或原发信人后发出 channel/recall。
//M 1.1.4：onChannelReply 支持带 target 的跨渠道发话，在飞书自有群/私聊/流水数据里自认聊天。
export const version = '1.1.5';

/** 用到的服务。approval、progress 不写在这里（缺一个整个插件不开工），在 apply 里用 ctx.inject 有就用。 */
export const inject = ['resources', 'bots', 'sessions', 'tools'];


/** 一个渠道连接的状态，给网页左下角的小圆点（形状照 web-api.md 的 ChannelStatus）。 */
export interface ChannelStatus {
  /** 'feishu:<应用号>'；网页按 name 开头认渠道。 */
  name: string;
  /** 这条连接属于哪个机器人。 */
  bot?: string;
  /** 通不通。 */
  connected: boolean;
  /** 鼠标放上去的一句话。 */
  detail: string;
}


declare module 'cordis' {
  interface Context {
    /** 飞书渠道。没挂这个插件时 ctx.get('feishu') 是 undefined。 */
    feishu: Feishu;
  }
  interface Events {
    /** web-api 每来一次 GET /api/ui/status 挨个问一遍：各渠道往 list 里 push 自己的连接状态。这里每个飞书应用 push 一项。 */
    'web-api/status'(list: ChannelStatus[]): void | Promise<void>;
    /** 通过指定机器人向飞书聊天发送本地文件。 */
    'feishu/send-file'(request: SendFileRequest): void | Promise<void>;
    /** 返回发送结果，失败时带原因。 */
    'feishu/send-file-result'(result: SendFileResult): void;
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
  /** 是不是用户本人：people 里登记了 owner: true 的才是，没登记的不是。收消息、点卡片时写；没写的地址（发件箱这类）不当本人。 */
  owner?: boolean;
  /** 说话人是哪一档（people 的 role，没登记是 guest）：approval 照它收工具。和 owner 一样收消息、点卡片时写。 */
  role?: FeishuRole;
  /** builder、guest 的目录（people 的 dir；没登记的 guest 是 guests/_guest/）：这一轮的工作区，读写、exec、发文件都只在这里（utils/Workspace.ts 的 of 读）。owner 不写。 */
  workspace?: string;
  /** 说话人的名字：people 里登记的，没登记用群成员里查到的；都没有不写。relay 记收件、前台记群聊用。 */
  senderName?: string;
  /** 群名：groups 里登记的，没登记用群信息查到的；都没有、私聊不写。 */
  chatName?: string;
  /** 群里没 @ 机器人、这个群登记了 listen: all：只听。前台只记不回，relay 只认前缀开头的。 */
  listenOnly?: boolean;
  /** 这个群登记的 listen: judge：只听的话记完由前台问决策模型要不要接话（bots/FrontDesk.ts 读）；不是 judge 的群不写。 */
  judge?: boolean;
  /** 这个群登记的 judge_threshold：决策模型的把握 ≥ 它才接话（传给 decision 的 allowAt）；没写不写，用 decision 插件默认。 */
  judgeThreshold?: number;
  /** 前台判断完写回来的流水结果（judge:回 / judge:不回(0.32)）：onMessage 收尾记进来往流水那一行。 */
  judged?: string;
  /** 这个群登记的 relay：model 时 @ 机器人的话由模型判断要不要转外部助手（relay 读）；没登记不写。 */
  relay?: 'direct' | 'model';
  /** 这个群登记的 trusted：true 时本人在群里说话照旧带私人记忆（utils/Workspace.ts 的 privateAllowed 读）；没登记、私聊不写，当 false。 */
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


/** 名单里的一个飞书应用，校验后。 */
export interface FeishuApp {
  /** 应用号 app_id。 */
  appId: string;
  /** 应用密钥 app_secret：只交给 SDK，不打印、不进跟踪。 */
  appSecret: string;
  /** 这个应用默认对应哪个机器人。 */
  bot: string;
  /** 可选：同一个飞书应用允许认领的多个机器人名（缺省只含 [bot]）。 */
  bots?: string[];
}


/** 一个人能让机器人做什么：owner 本人什么都能；builder 在自己的目录里写代码、跑程序；guest 只查、读、搜、答。 */
export type FeishuRole = 'owner' | 'builder' | 'guest';


/** 登记的一个人（feishu 插件配置的 people）。 */
export interface FeishuPerson {
  /** 飞书 open_id：每个飞书应用不同，同一个人在几个应用下各登记一项。 */
  openId: string;
  /** 叫什么：收件、群聊记录里用它。 */
  name: string;
  /** 哪一档；旧写法 owner: true 并成 owner，不写是 guest。 */
  role: FeishuRole;
  /** builder、guest 的目录，绝对路径（不写是运行时目录 guests/<名字>/，启动时建好；guest 的名字当不了目录名时是 guests/_guest/）；owner 是 ''。 */
  dir: string;
}


/** 登记的一个群（feishu 插件配置的 groups）。 */
export interface FeishuGroup {
  /** 飞书群号 chat_id。 */
  chatId: string;
  /** 群名；不写是 ''（用飞书查到的）。 */
  name: string;
  /** mention 只收 @ 机器人的（默认）；all 不 @ 的也收，只记不回；judge 不 @ 的也收，记完问决策模型要不要主动接话。 */
  listen: 'mention' | 'all' | 'judge';
  /** listen: judge 时决策模型的把握 ≥ 它才接话；不写用 decision 插件默认（allow_at）。 */
  judgeThreshold?: number;
  /** direct 只认外部助手前缀（默认，和没登记一样）；model 时 @ 机器人的话由模型判断要不要转。 */
  relay: 'direct' | 'model';
  /** 受不受信：true 时本人在这个群里说话照旧带私人记忆；不写是 false（群里的回复大家都看得到）。 */
  trusted: boolean;
}


/** apply 校验好以后给 Feishu 的东西。 */
export interface FeishuConfig {
  /** 飞书开放平台的地址（SDK 的 domain）；默认 https://open.feishu.cn，离线测试指向假飞书。 */
  domain: string;
  /** 飞书应用，照配置的先后。 */
  apps: FeishuApp[];
  /** 认得的人：open_id → 人。 */
  people: Map<string, FeishuPerson>;
  /** 专门设过的群：chat_id → 群。 */
  groups: Map<string, FeishuGroup>;
}


/** 来往流水的一行（data/logs/feishu-contacts.jsonl、GET /api/feishu/contacts）。 */
export interface Contact {
  /** 收到的本地时间，2026-11-17 10:30:05 的样子（textModule.getClock）。 */
  at: string;
  /** 哪个飞书应用收的。 */
  app: string;
  /** p2p、group。 */
  chatType: string;
  chatId: string;
  /** 群名：登记的或查到的；私聊、查不到是 ''。 */
  chatName: string;
  /** 说话人 open_id。 */
  openId: string;
  /** 说话人名字：登记的或查到的；都没有是 ''。 */
  sender: string;
  /** 有没有 @ 机器人；私聊算 @ 了。 */
  atMe: boolean;
  /** 话的前 80 字，超了带“…”（附件是 [图片] 这类标记）。 */
  text: string;
  /** 最后怎么处理的：交给会话、转外部助手、只记、丢了、别的插件处理掉了、没处理成：原因。 */
  outcome: string;
}


/** 一个应用运行时的样子。 */
interface AppState {
  /** 配置里那一项。 */
  config: FeishuApp;
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


/** 收到的消息事件里用到的几项（SDK 的 im.message.receive_v1，types/index.d.ts:319138）。 */
interface ReceiveData {
  sender: { sender_id?: { open_id?: string }; sender_type: string };
  message: {
    message_id: string;
    parent_id?: string;
    root_id?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: { key: string; id: { open_id?: string }; name: string }[];
  };
}


/** 飞书 im.message.recalled_v1 撤回消息事件的字段。 */
interface RecallData {
  /** 事件唯一标识。 */
  event_id?: string;
  /** 飞书应用号。 */
  app_id?: string;
  /** 被撤回的原消息 ID。 */
  message_id?: string;
  /** 发生撤回的聊天 ID。 */
  chat_id?: string;
  /** 撤回毫秒时间戳字符串。 */
  recall_time?: string;
  /** 撤回者身份类型：message_owner 为原发消息人自撤，其余为群主/群管/企业管理员代撤。 */
  recall_type?: 'message_owner' | 'group_owner' | 'group_manager' | 'enterprise_manager';
  /** 可选操作者标识（带 open_id 时一并核验本人或原发信人）。 */
  operator_id?: { open_id?: string };
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

/** 长连接握手最多等多久，毫秒（0.4 同）。 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

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


/**
 * 一条消息最后怎么处理的，写进来往流水。
 * @param kind 接它的会话种类（Feishu.takenBy）；没有会话接是 undefined。
 * @param listenOnly 是不是只听的话。
 * @returns 一个词。
 */
function getOutcome(kind: string | undefined, listenOnly: boolean): string {
  if (kind === 'relay') return '转外部助手';
  if (kind !== undefined) return '交给会话';
  if (listenOnly) return '只记';
  return '别的插件处理掉了';
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

/** 飞书聊天本地原始日志的一行（存于 channels/feishu/chats/<appId>/<chatId>.jsonl）。 */
interface FeishuChatLogEntry {
  /** 标准消息 ID。 */
  messageId: string;
  /** 飞书原始消息 ID。 */
  nativeId: string | null;
  /** 所属应用 ID。 */
  appId: string;
  /** 聊天 ID。 */
  chatId: string;
  /** 方向：user 入站 / bot 出站。 */
  direction: 'user' | 'bot';
  /** UTC 毫秒时间戳。 */
  createdAt: number;
  /** 发送者信息。 */
  sender: { id: string; name?: string };
  /** 展示文本。 */
  text: string;
  /** @ 提及清单。 */
  mentions: protocol.ChannelMention[];
  /** 附件元数据（含脱敏字段）。 */
  attachments: Array<{ id: string; name: string; mime?: string; size?: number; state: 'available' | 'unavailable' }>;
}

/** 飞书发送幂等记录（存于 channels/feishu/replies/<appId>.jsonl）。 */
interface FeishuReplyRecord {
  /** 回复请求幂等键。 */
  replyRequestKey: string;
  /** 正文载荷摘要。 */
  payloadHash: string;
  /** 保存下来的回执。 */
  receipt: protocol.ReplyReceipt;
}

/** 飞书渠道；外部发送复用实例方法。 */
export class Feishu {
  /** 渠道名。 */
  readonly name = 'feishu';

  /** 应用号 → 应用，照配置的先后。 */
  private readonly apps = new Map<string, AppState>();

  /** 正在处理中的入站消息号（防并发重推穿透），保存+广播后写入 feishu_seen。 */
  private readonly inFlight = new Set<string>();

  /** 回复幂等键缓存（replyRequestKey → 记录）。 */
  private readonly replyCache = new Map<string, FeishuReplyRecord>();

  /** 已从磁盘加载过回复幂等文件的应用集合。 */
  private readonly loadedReplyApps = new Set<string>();

  /** 已收到撤回通知的原消息键 `${appId}:${nativeId}` 集合，拦截尚在下载附件的入站或刚撤回时的在途回话。 */
  private readonly recalledNativeIds = new Set<string>();

  /** 群号 → 群名和成员名字（chatNames 查的）。 */
  private readonly chats = new Map<string, ChatNames>();

  /** approval 服务；approval 挂着时 cards/ 填上，拔掉时清掉。 */
  approval: cards.ApprovalLike | undefined;

  /** progress 服务；progress 挂着时 cards/ 填上，拔掉时清掉。 */
  progress: cards.ProgressLike | undefined;

  /**
   * 建表、给每个应用建 SDK 客户端；ready 时连长连接；被拔掉时关长连接。
   * 向 bots 登记本渠道的发送函数；一轮结束回话和中途先说一句由 bots 按渠道名调用。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验过的配置。
   */
  constructor(private readonly ctx: cordis.Context, readonly config: FeishuConfig) {
    //M 向 bots 服务注册飞书回话投递函数，随本插件卸载由 Cordis 自动撤销。
    this.ctx.effect(() => this.ctx.bots.channel(this.name, (reply, session, origin) => this.send(reply, session, origin)));
    const db = this.ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS feishu_seen (message_id TEXT PRIMARY KEY, app_id TEXT, kind TEXT, at INTEGER)');
    db.exec('CREATE TABLE IF NOT EXISTS feishu_p2p'
      + ' (app_id TEXT PRIMARY KEY, chat_id TEXT, open_id TEXT, message_id TEXT, at INTEGER)');
    db.exec('CREATE TABLE IF NOT EXISTS feishu_cards'
      + ' (card_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, ended INTEGER, at INTEGER)');
    db.exec('CREATE INDEX IF NOT EXISTS feishu_cards_ref ON feishu_cards (kind, ref)');

    //M Bun 的 node:http 上传仍会走环境代理；仅 multipart 改用原生 fetch，并显式直连。
    //M 不改进程环境或 SDK 共享实例；普通接口、流式下载仍走 SDK 默认传输。
    const httpInstance = lark.defaultHttpInstance.create();
    httpInstance.interceptors.request.use((request) => {
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
    for (const app of config.apps) {
      const client = new lark.Client({
        //M 响应拦截器已解包为 SDK 的 HttpInstance 返回契约。
        httpInstance: httpInstance as unknown as lark.HttpInstance,
        appId: app.appId,
        appSecret: app.appSecret,
        domain: config.domain,
        loggerLevel: lark.LoggerLevel.warn,
        logger: SDK_LOGGER,
      });
      this.apps.set(app.appId, { config: app, client, state: '还没连', connected: false, at: Date.now() });
    }

    //M 都挂完了才连：这时候机器人、前台都在了，收到的消息有人接。
    this.ctx.on('ready', () => {
      this.connect();
    });

    //M 前台在会话跑完以后才判断完的话（bot/judged）：补记一行流水，写明判断的结果。
    this.ctx.on('bot/judged', (address, text, outcome) => {
      this.logJudged(address, text, outcome);
    });

    //M 网页问连接状态（web-api 发，挨个问）。没挂 web-api 就没人问。
    this.ctx.on('web-api/status', (list) => {
      this.status(list);
    });

    //M 统一渠道回复出口（接口 A）：监听 channel/reply，只发送纯文字并返回 channel/replied 回执。
    this.ctx.on('channel/reply', (request) => this.onChannelReply(request));

    //M 统一渠道历史入口（接口 A）：监听 channel/history，在授权范围内返回已落盘记录。
    this.ctx.on('channel/history', (request) => this.onChannelHistory(request));

    const requestOptions = {
      onError: (error: unknown) => {
        //G 发文件失败时通过回执把原因交给调用方。
        const detail = textModule.getMessage(error);
        return { ok: false, error: detail };
      },
    };

    //M 文件投递沿用现有的应用归属校验、上传和发送逻辑。
    requestEventModule.onRequestEvent(
      this.ctx,
      'feishu/send-file',
      'feishu/send-file-result',
      async (request) => {
        const options: SendFileOptions = {
          appId: request.appId,
          kind: request.kind,
          messageId: request.messageId,
        };

        //M 等上传并发送完成，再交回新消息号。
        const messageId = await this.sendFile(request.bot, request.chatId, request.filePath, options);
        return { ok: true, messageId };
      },
      requestOptions,
    );

    //M 被拔掉时关掉每条长连接。ctx.effect：先执行一次（这里什么也不做），交回的函数在插件被拔掉时 Cordis 来调。
    this.ctx.effect(() => {
      return () => {
        for (const app of this.apps.values()) {
          app.ws?.close();
        }
      };
    });
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
    return { appId: row.app_id, chatId: row.chat_id, messageId: row.message_id, openId: row.open_id, chatType: 'p2p', customer: feishuCustomer('p2p', row.chat_id, row.open_id) };
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

    //M 分发器：收消息、点卡片两个事件干活；已读、表情、进私聊几个登记空处理，免得 SDK 打“没有处理”的警告（0.4 同）。
    //M   收消息不等它处理完就交回：下载大文件可能很久，飞书等不到确认会重推（重推的有去重挡着）。
    //M   点卡片要等：交回的 { toast } 就是给飞书的回应，SDK 把它带回去（lib/index.js handleEventData）。
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn, logger: SDK_LOGGER }).register({
      'im.message.receive_v1': (data: ReceiveData) => {
        void this.onMessage(appId, data);
      },
      'im.message.recalled_v1': (data: RecallData) => {
        //M 收到消息撤回事件时异步核对本人或原发信人身份并通知机器人停止对应任务。
        void this.onRecall(appId, data);
      },
      //M 交互卡片按钮点击必须异步等候校验与业务结果，以便把 toast 及时带回飞书客户端。
      'card.action.trigger': (data: unknown) => this.onCard(appId, data),
      'im.message.message_read_v1': () => undefined,
      'im.message.reaction.created_v1': () => undefined,
      'im.message.reaction.deleted_v1': () => undefined,
      'im.chat.access_event.bot_p2p_chat_entered_v1': () => undefined,
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
      this.mark(app, `出错 ${textModule.getMessage(error)}`, false);
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
    const logTime = textModule.getClock(Date.now(), 'date');
    const line = `${logTime} 飞书 ${app.config.appId}（${app.config.bot}）${state}`;
    if (connected) {
      console.log(line);
    }
    if (!connected) {
      console.error(line);
    }

    //T 跟踪：飞书连接状态变了。
    const vars = { 应用: app.config.appId, 机器人: app.config.bot, 状态: state };
    this.ctx.emit('trace', 'Feishu.mark', '飞书长连接状态变了', 'app.state = state', vars);
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
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书 ${app.config.appId} 没查到机器人自己的 open_id（群里有 @ 就回）：${textModule.getMessage(error)}`);
    }
  }

  /**
   * 群名和群成员的名字：飞书的收消息事件不带名字，这里查群信息、群成员（只取第一页 100 人），记 CHAT_NAMES_MS。
   * 查不到（应用没开权限、断网）只打日志，交回空的，由用的人退回 chat_id、open_id 后 6 位；查不到的也记下，免得每句话都查一次。
   * @param app 哪个应用收的。
   * @param chatId 群号。
   * @returns 群名、成员名字。
   */
  private async chatNames(app: AppState, chatId: string): Promise<ChatNames> {
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
      const members = await api.call('查群成员', () => app.client.request<{ data?: { items?: { member_id?: string; name?: string }[] } }>({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${chatId}/members`,
        params: { member_id_type: 'open_id', page_size: 100 },
      }));
      for (const member of members.data?.items ?? []) {
        if (member.member_id !== undefined && member.name !== undefined) found.members.set(member.member_id, member.name);
      }
    } catch (error) {
      //M 查询失败时记录日期日志并缓存空名结构，避免同一群后续消息反复触发出错调用。
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书 ${app.config.appId} 没查到群 ${chatId} 的名字（用群号、open_id 后 6 位代替）：${textModule.getMessage(error)}`);
    }
    this.chats.set(chatId, found);
    return found;
  }

  /**
   * 收到一条消息：去重、记最近私聊的人、挂表情、换成文字、下载附件、交给机器人。
   * @param appId 哪个应用收的。
   * @param data 飞书的消息事件。
   * 副作用：写表；下载文件进工作区；推给机器人；出错给这个聊天发一句。
   */
  private async onMessage(appId: string, data: ReceiveData): Promise<void> {
    //M 按事件所属应用 ID 查找应用实例，找不到直接忽略。
    const app = this.apps.get(appId);
    if (app === undefined) return;
    const message = data.message;
    const db = this.ctx.resources.db;

    //G 重推或正在处理中（先查去重表和 inFlight；只有 raw 落盘并完成短分派之后才写 feishu_seen）。
    const seenRow = db.query("SELECT 1 FROM feishu_seen WHERE message_id = ? AND kind = 'in'").get(message.message_id);
    if (seenRow !== null || this.inFlight.has(message.message_id)) {
      //T 跟踪：重复的消息，去重挡掉。
      const vars = { 应用: appId, 消息: message.message_id };
      this.ctx.emit('trace', 'Feishu.onMessage', '同一条消息飞书又推了一次，不管', 'SELECT feishu_seen', vars);
      return;
    }
    //M 标记当前 message_id 正在异步入站处理，防飞书重推与自身异步周期并发重入。
    this.inFlight.add(message.message_id);

    try {
      //M 交由入站管线执行消息解析、存盘、分发，并在 finally 释放并发锁。
      await this.handleInboundMessage(appId, app, data);
    } finally {
      this.inFlight.delete(message.message_id);
    }
  }

  /**
   * 处理已确认非重推的飞书入站消息：解析 @ 提及与群配置 → 下载附件进渠道目录 → 写原始消息日志 →
   * 发统一事件 channel/message（支持单账号多机器人各自认领）→ 最后落盘 feishu_seen、流水并清理无回话表情。
   * @param appId 应用号。
   * @param app 应用运行时状态。
   * @param data 飞书消息事件。
   */
  private async handleInboundMessage(appId: string, app: AppState, data: ReceiveData): Promise<void> {
    const message = data.message;
    const db = this.ctx.resources.db;
    //M 取出该飞书账号配置允许投递的机器人名单，供群 @ 识别与路由拆解。
    const allowedBots = this.getAllowedBots(app.config);
    const mentions = message.mentions ?? [];
    const group = message.chat_type !== 'p2p';
    const self = app.botOpenId;

    //M @ 映射：已知本应用 botOpenId 时精确匹配，缺省时若群里有人被 @ 则按默认机器人命中（仅在当前应用允许名单里选）。
    const standardMentions: protocol.ChannelMention[] = mentions.map((item) => {
      const id = item.id.open_id ?? '';
      const botNames: string[] = [];
      if (self !== undefined && id === self) {
        botNames.push(app.config.bot);
      }
      if (self === undefined && id !== '') {
        botNames.push(app.config.bot);
      }
      let name = '';
      if (item.name !== undefined) {
        name = item.name;
      }
      //M 群内 @ 名称若与允许列表中的机器人名吻合，也记作命中该机器人。
      const matched = allowedBots.find((botName) => botName === name);
      if (matched !== undefined && !botNames.includes(matched)) {
        botNames.push(matched);
      }
      const out: protocol.ChannelMention = { id, botNames };
      if (item.key !== undefined && item.key !== '') out.token = item.key;
      if (item.name !== undefined && item.name !== '') out.name = item.name;
      return out;
    });

    let atMe = !group;
    if (group && self === undefined) {
      atMe = mentions.length > 0;
    }
    if (group && self !== undefined) {
      atMe = mentions.some((item) => item.id.open_id === self);
    }

    //M 换成文字，去掉 @ 占位符（rawText 保留带占位符的平台可读全文，丢掉也要记流水）。
    const described = media.describe(message.message_type, message.content);
    let body = described.text;
    for (const mention of mentions) {
      body = body.replaceAll(mention.key, '');
    }

    //M 认人、认群：config 里登记的名字优先；群名、人名没登记的，群里再去飞书查。
    const openId = data.sender.sender_id?.open_id ?? '';
    const person = this.config.people.get(openId);
    let registered: FeishuGroup | undefined;
    if (group) {
      registered = this.config.groups.get(message.chat_id);
    }
    let chatName = registered?.name ?? '';
    let senderName = person?.name ?? '';
    if (group && (chatName === '' || senderName === '')) {
      const names = await this.chatNames(app, message.chat_id);
      chatName = chatName || names.name;
      senderName = senderName || (names.members.get(openId) ?? '');
    }

    const contact: Omit<Contact, 'outcome'> = {
      //M 取格式化日期时间戳作为联系人流水记录时间，后文裁剪正文前 80 字。
      at: textModule.getClock(Date.now(), 'date'),
      app: appId,
      chatType: message.chat_type,
      chatId: message.chat_id,
      chatName,
      openId,
      sender: senderName,
      atMe,
      //M 截断消息文本保留摘要片段写入流水表，避免超长对话刷爆日志。
      text: textModule.clip(body.trim(), 80),
    };

    const listenOnly = !atMe;
    let targetBots: string[] = [];
    const byBotRouting: Record<string, protocol.BotRoutingHint> = {};
    if (!group) {
      targetBots = [...allowedBots];
      for (const botName of targetBots) {
        byBotRouting[botName] = { listenOnly: false };
      }
    }
    if (group) {
      const canListenAll = registered?.listen === 'all' || registered?.listen === 'judge';
      for (const botName of allowedBots) {
        const mentionedBot = standardMentions.some((m) => m.botNames.includes(botName));
        const activeForBot = mentionedBot || (atMe && botName === app.config.bot);
        if (activeForBot) {
          targetBots.push(botName);
          byBotRouting[botName] = { listenOnly: false };
          continue;
        }
        if (canListenAll) {
          targetBots.push(botName);
          byBotRouting[botName] = { listenOnly: true, judge: registered?.listen === 'judge' };
        }
      }
    }

    const standardMessageId = JSON.stringify([this.name, appId, message.message_id]);
    let chatType: protocol.ChannelChatType = 'group';
    if (message.chat_type === 'p2p') {
      chatType = 'p2p';
    }
    if (message.chat_type !== 'p2p' && message.chat_type !== 'group') {
      chatType = 'group';
    }

    //G 群里没 @ 任何目标机器人且未登记只听：存 raw 日志、记 seen、记流水“丢了”后返回。
    if (targetBots.length === 0) {
      const senderInfo: { id: string; name?: string } = { id: openId || 'unknown' };
      if (senderName !== '') {
        senderInfo.name = senderName;
      }
      const droppedEntry: FeishuChatLogEntry = {
        messageId: standardMessageId,
        nativeId: message.message_id,
        appId,
        chatId: message.chat_id,
        direction: 'user',
        createdAt: Date.now(),
        sender: senderInfo,
        text: body.trim() || '[空消息]',
        mentions: standardMentions,
        attachments: [],
      };
      //M 未触发回复或监听的群聊消息仍需落盘原始聊天历史、登记已见防重投并记为“丢了”。
      this.appendChatLog(appId, message.chat_id, droppedEntry);
      db.query('INSERT OR IGNORE INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)')
        .run(message.message_id, appId, 'in', Date.now());
      //M 追加一条“丢了”来往流水供核对群过滤情况。
      this.logContact(contact, '丢了');
      const vars = { 应用: appId, 聊天: message.chat_id };
      this.ctx.emit('trace', 'Feishu.onMessage', '群里这条没 @ 机器人，不回', 'atMe === false', vars);
      return;
    }

    if (message.chat_type === 'p2p' && openId !== '') {
      const sql = 'INSERT INTO feishu_p2p (app_id, chat_id, open_id, message_id, at) VALUES (?, ?, ?, ?, ?)'
        + ' ON CONFLICT(app_id) DO UPDATE SET chat_id = excluded.chat_id, open_id = excluded.open_id,'
        + ' message_id = excluded.message_id, at = excluded.at';
      //M 更新该应用最近私聊联系人映射，供发件箱、定时提醒与跨渠道云文档授权复用。
      db.query(sql).run(appId, message.chat_id, openId, message.message_id, Date.now());
    }

    const address: FeishuAddress = {
      appId,
      chatId: message.chat_id,
      messageId: message.message_id,
      openId,
      chatType: message.chat_type,
      //M 按会话类型计算统一客户键，供前台与记忆插件区分私聊与群聊上下文。
      customer: feishuCustomer(message.chat_type, message.chat_id, openId),
      //M 根据配置填充说话人的身份角色与限定工作目录（owner 不写 workspace）。
      ...roleFields(person, this.ctx.resources.dir('guests', GUEST_DIR)),
    };
    if (chatName !== '') address.chatName = chatName;
    if (senderName !== '') address.senderName = senderName;
    if (listenOnly) address.listenOnly = true;
    if (listenOnly && registered?.listen === 'judge') address.judge = true;
    if (listenOnly && registered?.listen === 'judge' && registered.judgeThreshold !== undefined) address.judgeThreshold = registered.judgeThreshold;
    if (registered !== undefined) address.relay = registered.relay;
    if (registered !== undefined) address.trusted = registered.trusted;

    const vars = { 应用: appId, 机器人: targetBots.join('、'), 类型: message.message_type, 聊天: message.chat_type, 只听: listenOnly };
    this.ctx.emit('trace', 'Feishu.onMessage', '飞书收到一条消息，存原始件并广播 channel/message', 'ctx.serial("channel/message", msg)', vars);

    try {
      //M 挂“敲键盘”表情，告诉用户收到了；仅在需要回复且非只听时挂。
      try {
        if (!listenOnly) {
          const reaction = await api.call('挂表情', () => app.client.im.v1.messageReaction.create({
            path: { message_id: message.message_id },
            data: { reaction_type: { emoji_type: 'Typing' } },
          }));
          const reactionId = reaction.data?.reaction_id;
          if (reactionId !== undefined && reactionId !== '') address.typingReaction = reactionId;
        }
      } catch (error) {
        //M 取格式化日期前缀记录挂“敲键盘”表情失败日志，不阻断主流程。
        const logTime = textModule.getClock(Date.now(), 'date');
        console.error(`${logTime} 飞书：表情没挂上：${textModule.getMessage(error)}`);
      }

      //M 若本条属于引用回复或合并转发消息，补充拉取上下文原文及其附带资源列表。
      const more = await media.related(this, appId, {
        messageId: message.message_id,
        parentId: message.parent_id || message.root_id,
        type: message.message_type,
      });

      //M 资源先存在飞书自己的渠道存储目录下，不直接写入单一机器人私有工作区；认领后再由每个机器人按授权工作区物化。
      const attachments: protocol.ChannelAttachment[] = [];
      const failed: string[] = [];
      const attachDir = this.ctx.resources.dir(
        'channels',
        'feishu',
        'attachments',
        namesModule.getSafeName(appId, Infinity),
        new Date().toLocaleDateString('sv-SE'),
      );
      for (const [idx, resource] of [...described.resources, ...more.resources].entries()) {
        const attachId = `${message.message_id}:${String(idx)}`;
        try {
          const content = await media.download(this, appId, resource.messageId ?? message.message_id, resource);
          const safe = namesModule.getSafeName(path.win32.basename(resource.name), Infinity);
          const filePath = path.join(attachDir, `${namesModule.getSafeName(message.message_id, 60)}_${String(idx)}_${safe}`);
          fs.writeFileSync(filePath, content);
          attachments.push({
            id: attachId,
            name: resource.name,
            size: content.length,
            sourceRef: filePath,
            state: 'available',
          });
        } catch (error) {
          //M 单个附件下载失败时记为不可用并把报错附进正文，不阻塞整条消息处理。
          const reason = textModule.getMessage(error);
          failed.push(`[${resource.name} 没下载下来：${reason}]`);
          attachments.push({
            id: attachId,
            name: resource.name,
            sourceRef: '',
            state: 'unavailable',
            reason,
          });
        }
      }

      const parts = [more.quote, body.trim(), more.forwarded, failed.join('\n')];
      const text = parts.filter((part) => part !== '').join('\n') || '[空消息]';
      const receivedAt = Date.now();
      let replyTo: protocol.ChannelReplyTo | null = null;
      const rawParent = message.parent_id || message.root_id;
      if (rawParent !== undefined && rawParent !== '') {
        replyTo = {
          nativeId: rawParent,
          messageId: JSON.stringify([this.name, appId, rawParent]),
        };
      }

      const role: protocol.ChannelRole = address.role ?? 'guest';
      const trusted = !group || address.trusted === true;
      const scope = `${this.name}:${appId}:${message.chat_id}`;
      const senderInfo: { id: string; name?: string } = { id: openId || 'unknown' };
      if (senderName !== '') {
        senderInfo.name = senderName;
      }
      const routing: protocol.ChannelRouting = { listenOnly, byBot: byBotRouting };
      if (address.judge === true) {
        routing.judge = true;
      }
      const channelMessage: protocol.ChannelMessage = {
        v: 1,
        messageId: standardMessageId,
        nativeId: message.message_id,
        channel: this.name,
        accountId: appId,
        chatId: message.chat_id,
        chatType,
        sender: senderInfo,
        role,
        targetBots,
        mentions: standardMentions,
        rawText: described.text,
        text,
        attachments,
        createdAt: receivedAt,
        receivedAt,
        timeSource: 'received',
        replyTo,
        origin: {
          channel: this.name,
          address: structuredClone(address) as unknown as Record<string, unknown>,
        },
        visibility: {
          scope,
          trusted,
          publicSourceIds: [],
        },
        routing,
      };

      //M 先持久化渠道原始记录，再发出 channel/message；短分派完成后才记 feishu_seen 去重。
      const chatEntry: FeishuChatLogEntry = {
        messageId: standardMessageId,
        nativeId: message.message_id,
        appId,
        chatId: message.chat_id,
        direction: 'user',
        createdAt: channelMessage.createdAt,
        sender: channelMessage.sender,
        text,
        mentions: standardMentions,
        attachments: attachments.map((item) => {
          const clean: FeishuChatLogEntry['attachments'][number] = {
            id: item.id,
            name: item.name,
            state: item.state,
          };
          if (item.mime !== undefined) clean.mime = item.mime;
          if (item.size !== undefined) clean.size = item.size;
          return clean;
        }),
      };
      //M 将入站消息标准化条目写入本地渠道聊天日志，供后续历史查询及审计使用。
      this.appendChatLog(appId, message.chat_id, chatEntry);

      //G 处理入站期间原消息已被撤回 → 补记去重与流水后立即退出，不再发 channel/message 拉起会话。
      if (this.recalledNativeIds.has(`${appId}:${message.message_id}`)) {
        db.query('INSERT OR IGNORE INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)')
          .run(message.message_id, appId, 'in', Date.now());
        this.logContact(contact, '已撤回');
        return;
      }

      const control: protocol.ChannelMessageControl = { claims: [] };
      await this.ctx.serial('channel/message', channelMessage, control);

      //M 确认原消息存盘且同步分发流程完成后才写 feishu_seen，防止崩溃丢消息。
      db.query('INSERT OR IGNORE INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)')
        .run(message.message_id, appId, 'in', Date.now());

      //M 根据各插件填回的认领声明汇总本条消息的最终流向并写入来往流水。
      const outcome = this.resolveOutcome(control, listenOnly, message.message_id, address.judged);
      this.logContact(contact, outcome);

      //M 若无机器人认领会话（或被审批插件直接截断），立即撤掉之前挂上的“敲键盘”表情。
      const hasSessionClaim = control.claims.some((c) => c.status === 'claimed' || c.status === 'relay');
      if (address.typingReaction !== undefined && (control.approvalHandled === true || (!hasSessionClaim && this.takenBy(message.message_id) === undefined))) {
        //M 调用撤回接口移除“正在输入”表情反馈。
        await this.untype(address);
      }
    } catch (error) {
      //M 捕获入站异常后登记失败流水与控制台报错，并尝试向发信方回传简明失败原因。
      const said = textModule.getMessage(error);
      this.logContact(contact, `没处理成：${said}`);
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书：消息 ${message.message_id} 没处理成：${said}`);
      try {
        //M 向原聊天发回兜底失败提示并清理可能残余的“敲键盘”表情。
        await this.sendText(address, `这条消息没处理成：${said}`);
        await this.untype(address);
      } catch (again) {
        //M 连兜底错误通知也发送失败时取时间前缀记录二次日志。
        const againTime = textModule.getClock(Date.now(), 'date');
        console.error(`${againTime} 飞书：“没处理成”也没发出去：${textModule.getMessage(again)}`);
      }
    }
  }

  /**
   * 汇总一条飞书消息在 channel/message 后的流水结果文案。
   * @param control 协调结果。
   * @param listenOnly 原默认是否只听。
   * @param nativeId 飞书原生消息号（兼容未迁移路径）。
   * @param legacyJudged 旧字段 judged。
   */
  private resolveOutcome(
    control: protocol.ChannelMessageControl,
    listenOnly: boolean,
    nativeId: string,
    legacyJudged?: string,
  ): string {
    if (control.approvalHandled === true) return '别的插件处理掉了';

    //M 先查看是否有决定型或转发型插件在认领列表里给出了自定义结果说明。
    const judgedClaim = control.claims.find((c) => c.judged !== undefined);
    if (judgedClaim?.judged !== undefined) return judgedClaim.judged;

    if (legacyJudged !== undefined) return legacyJudged;

    //M 若认领表中标记为转给外部助手，则记为转外部助手。
    const relayClaim = control.claims.find((c) => c.status === 'relay');
    if (relayClaim !== undefined) return '转外部助手';

    //M 若已被某个会话正式认领或去重归并，则记为交给会话。
    const sessionClaim = control.claims.find((c) => c.status === 'claimed' || c.status === 'duplicate');
    if (sessionClaim !== undefined) return '交给会话';

    //M 若仅以旁听背景形式记录下来，则记为只记。
    const listenClaim = control.claims.find((c) => c.status === 'listen');
    if (listenClaim !== undefined) return '只记';

    //M 若被拦截性插件直接消化处理，则记为别的插件处理掉了。
    const handledClaim = control.claims.find((c) => c.status === 'handled');
    if (handledClaim !== undefined) return '别的插件处理掉了';

    //M 全无声明时回退按本地会话表认领记录归类最终流水状态。
    const kind = this.takenBy(nativeId);
    return getOutcome(kind, listenOnly);
  }

  /**
   * 一个飞书应用配置允许的目标机器人名单（去重保序，缺省 [config.bot]）。
   * @param app 应用配置。
   */
  private getAllowedBots(app: FeishuApp): string[] {
    const list = [app.bot, ...(app.bots ?? [])];
    return [...new Set(list)];
  }

  /**
   * 响应 channel/reply（接口 A）：仅接受本渠道且 mode === 'text' 的纯文字发送（绝不把 @/abs/path 解释为附件）。
   * 支持按 replyRequestKey 幂等与同键冲突拒绝；发送完写入渠道回执日志、聊天历史并 emit channel/replied。
   * @param request 回复请求。
   */
  private async onChannelReply(request: protocol.ChannelReplyRequest): Promise<void> {
    if (request.channel !== this.name || request.handled === true) return;

    request.handled = true;
    const emitReplied = (receipt: protocol.ReplyReceipt): void => {
      this.ctx.emit('channel/replied', {
        requestId: request.requestId,
        replyRoundKey: request.replyRoundKey,
        receipt,
      });
    };

    const buildRejected = (reason: string): protocol.ReplyReceipt => ({
      v: 2,
      ok: false,
      status: 'rejected',
      replyRequestKey: request.replyRequestKey,
      replyRoundKey: request.replyRoundKey,
      replyIndex: request.replyIndex,
      kind: request.kind,
      parts: request.parts.map((part) => ({
        partId: part.partId,
        kind: part.kind,
        status: 'rejected',
        reason,
      })),
      reason,
      at: Date.now(),
    });

    //G 原飞书消息已在本插件登记撤回 → 拒绝发送并回传 rejected 回执。
    const nativeKey = `${request.sourceSnapshot.accountId}:${request.sourceSnapshot.nativeId ?? ''}`;
    if (request.sourceSnapshot.channel === this.name && this.recalledNativeIds.has(nativeKey)) {
      //M 将撤回拒收回执发出并结束当前外发处理。
      emitReplied(buildRejected('recalled：原消息已撤回，不再发送回复'));
      return;
    }

    if (request.mode !== 'text') {
      //M 当前统一回复口仅实现纯文字模式，拒绝非文本请求并回报不支持状态。
      emitReplied(buildRejected('capability_unsupported：飞书 channel/reply 当前只支持纯文字'));
      return;
    }

    //M 默认沿用当前轮绑定的来源地址；若请求附带 target，只在飞书自有群/私聊/流水数据中认出目标聊天。
    let appId = request.sourceSnapshot.accountId;
    let chatId = request.sourceSnapshot.chatId;
    let address: FeishuAddress = {
      ...(request.sourceSnapshot.origin.address as unknown as FeishuAddress),
      appId,
      chatId,
      messageId: request.sourceSnapshot.nativeId ?? '',
    };
    if (request.target !== undefined) {
      //M 按目标渠道自带的认聊天逻辑解析目标应用与地址，认不出即回 rejected。
      const targetResolved = this.getReplyTargetAddress(request.bot, request.target.chat);
      if (typeof targetResolved === 'string') {
        emitReplied(buildRejected(targetResolved));
        return;
      }
      appId = targetResolved.appId;
      chatId = targetResolved.chatId;
      address = targetResolved;
    }

    //M 按应用号和幂等键查历史发信回执，保证同一条回复重发不重复投递。
    const existing = this.getReplyRecord(appId, request.replyRequestKey);
    if (existing !== undefined) {
      if (existing.payloadHash === request.payloadHash) {
        //M 同键同载荷命中幂等记录，直接复播原有回执。
        emitReplied(existing.receipt);
        return;
      }
      //M 同键不同载荷说明重放冲突，拒绝发送并告知上游拒绝回执。
      emitReplied(buildRejected('reply_conflict：同一 replyRequestKey 的发送内容不一致'));
      return;
    }

    //M 校验请求指向的飞书应用与会话 chatId 有效，缺失则直接拒发。
    const app = this.apps.get(appId);
    if (app === undefined || chatId === '') {
      //M 反馈目标应用或会话无效的拒绝回执。
      emitReplied(buildRejected('飞书应用或聊天号无效'));
      return;
    }
    const rawText = request.parts.map((part) => part.text ?? '').filter((part) => part !== '').join('\n');
    //M 补齐群聊 @ 发信人前缀并将文内 @昵称 替换为飞书 <at> 标签。
    const body = this.mentioned(address, this.withAt(address, rawText));

    let receipt: protocol.ReplyReceipt;
    try {
      let providerId = '';
      if (body.trim() !== '') {
        //M 非空白正文经统一发信方法发出（按原消息号回复，必要时退回直发）。
        providerId = await media.message(this, appId, chatId, 'text', { text: body }, address.messageId || undefined);
      }
      const now = Date.now();
      const receiptPart: protocol.ReplyReceiptPart = {
        partId: request.parts[0]?.partId ?? 'text:0',
        kind: 'text',
        status: 'sent',
      };
      if (providerId !== '') {
        receiptPart.providerId = providerId;
      }
      receipt = {
        v: 2,
        ok: true,
        status: 'sent',
        replyRequestKey: request.replyRequestKey,
        replyRoundKey: request.replyRoundKey,
        replyIndex: request.replyIndex,
        kind: request.kind,
        parts: [receiptPart],
        at: now,
      };
      if (providerId !== '') {
        receipt.messageIds = [providerId];
      }
      let nativeOutId: string | null = null;
      if (providerId !== '') {
        nativeOutId = providerId;
      }
      //M 将机器人发出回复同步写入本地聊天历史以便 channel/history 查询回溯。
      this.appendChatLog(appId, chatId, {
        messageId: JSON.stringify([this.name, appId, providerId || `out_${request.requestId}`]),
        nativeId: nativeOutId,
        appId,
        chatId,
        direction: 'bot',
        createdAt: now,
        sender: { id: app.botOpenId ?? request.bot, name: request.bot },
        text: rawText,
        mentions: [],
        attachments: [],
      });
      if (request.kind === 'final' && address.typingReaction !== undefined) {
        //M 最终回复发出后立即撤销之前挂上的“敲键盘”表态。
        await this.untype(address);
      }
    } catch (error) {
      //M 发信失败时解析错误说明，按 Api.NotSent 区分明确拒收与超时未知状态。
      const reason = textModule.getMessage(error);
      let status: protocol.ReplyStatus = 'uncertain';
      if (error instanceof api.NotSent) {
        status = 'rejected';
      }
      receipt = {
        v: 2,
        ok: false,
        status,
        replyRequestKey: request.replyRequestKey,
        replyRoundKey: request.replyRoundKey,
        replyIndex: request.replyIndex,
        kind: request.kind,
        parts: [{ partId: request.parts[0]?.partId ?? 'text:0', kind: 'text', status, reason }],
        reason,
        at: Date.now(),
      };
    }

    //M 落盘回复幂等记录，保存每次发送回执的哈希与状态。
    this.saveReplyRecord(appId, {
      replyRequestKey: request.replyRequestKey,
      payloadHash: request.payloadHash,
      receipt,
    });
    //M 对外推送 channel/replied 标准化回执事件通知上游发信方。
    emitReplied(receipt);
  }

  /**
   * 仅从飞书自有数据（群名缓存、groups 配置、feishu_p2p 表、来往流水与聊天日志）识别跨渠道/跨聊天发送目标。
   * 认不出时交回明确原因“没有叫 X 的聊天”；认出时交回干净的 FeishuAddress（不带原消息号与 openId，避免误 @ 路人）。
   * @param bot 当前机器人名。
   * @param rawChat 调用方给出的原始聊天串（群号、群名、私聊名或 appId:chatId）。
   */
  private getReplyTargetAddress(bot: string, rawChat: string): FeishuAddress | string {
    const exact = rawChat.trim();
    if (exact === '') return 'chat_not_found：没有叫 （空） 的聊天';

    //M 剥离网页常见的“飞书·群·”与“飞书·私聊·”展示前缀，以便用群名/人名匹配飞书记录。
    let labelTarget = exact;
    if (exact.startsWith('飞书·群·')) {
      labelTarget = exact.slice('飞书·群·'.length);
    }
    if (exact.startsWith('飞书·私聊·')) {
      labelTarget = exact.slice('飞书·私聊·'.length);
    }

    //M 查询绑定到该机器人的全部飞书应用号，校验或限定 appId 前缀。
    const allowedApps = this.getApps(bot);
    if (allowedApps.length === 0) return `chat_not_found：没有叫 ${exact} 的聊天`;

    let candidateApps = allowedApps;
    let lookupChat = exact;
    const sep = exact.indexOf(':');
    if (sep > 0) {
      const left = exact.slice(0, sep).trim();
      const right = exact.slice(sep + 1).trim();
      if (left !== '' && right !== '' && (this.apps.has(left) || left === this.name)) {
        if (left !== this.name && !allowedApps.includes(left)) {
          return `chat_not_found：没有叫 ${exact} 的聊天`;
        }
        if (left !== this.name) {
          candidateApps = [left];
        }
        lookupChat = right;
        labelTarget = right;
      }
    }

    let appId = '';
    let chatId = '';
    let chatType = 'group';
    let chatName = '';

    //M 1) 先在已缓存的飞书群列表（含群号与群名）里核对目标群。
    for (const [id, info] of this.chats) {
      if (id === lookupChat || (info.name !== '' && info.name === labelTarget)) {
        chatId = id;
        chatName = info.name;
        chatType = 'group';
        break;
      }
    }

    //M 2) 再在配置 groups（专项群配置）中核对目标群号与群名。
    if (chatId === '') {
      for (const group of this.config.groups.values()) {
        if (group.chatId === lookupChat || (group.name !== '' && group.name === labelTarget)) {
          chatId = group.chatId;
          chatName = group.name;
          chatType = 'group';
          break;
        }
      }
    }

    //M 3) 再查飞书私聊表 feishu_p2p（按 chatId、openId 或配置人名 matching）。
    if (chatId === '') {
      const p2pRows = this.ctx.resources.db.query('SELECT app_id, chat_id, open_id FROM feishu_p2p ORDER BY at DESC LIMIT 200')
        .all() as Array<{ app_id: string; chat_id: string; open_id: string }>;
      for (const row of p2pRows) {
        if (!candidateApps.includes(row.app_id)) {
          continue;
        }
        //M 从人员表读取配置人名并核对 chatId、openId 或展示名。
        const personName = this.config.people.get(row.open_id)?.name ?? '';
        if (row.chat_id === lookupChat || row.open_id === lookupChat || (personName !== '' && personName === labelTarget)) {
          appId = row.app_id;
          chatId = row.chat_id;
          chatType = 'p2p';
          break;
        }
      }
    }

    //M 4) 再查飞书来往流水 data/logs/feishu-contacts.jsonl，覆盖历史出现过的群聊或私聊。
    if (chatId === '') {
      for (const contact of this.contacts(500)) {
        if (!candidateApps.includes(contact.app)) {
          continue;
        }
        const matchId = contact.chatId === lookupChat;
        const matchGroup = contact.chatName !== '' && contact.chatName === labelTarget;
        const matchPerson = contact.chatType === 'p2p' && contact.sender !== '' && contact.sender === labelTarget;
        if (matchId || matchGroup || matchPerson) {
          appId = contact.app;
          chatId = contact.chatId;
          chatType = contact.chatType || 'group';
          chatName = contact.chatName;
          break;
        }
      }
    }

    //M 5) 最后只读检查本地聊天历史文件是否存在（不新建目录）。
    if (chatId === '') {
      for (const candidateApp of candidateApps) {
        const logFile = path.join(
          this.ctx.resources.root,
          'channels',
          'feishu',
          'chats',
          namesModule.getSafeName(candidateApp, Infinity),
          `${namesModule.getSafeName(lookupChat, Infinity)}.jsonl`,
        );
        if (fs.existsSync(logFile)) {
          appId = candidateApp;
          chatId = lookupChat;
          if (lookupChat.startsWith('ou_')) {
            chatType = 'p2p';
          }
          break;
        }
      }
    }

    if (chatId === '') return `chat_not_found：没有叫 ${exact} 的聊天`;

    //M 未确定所属 appId 时，优先挑本地存在该聊天历史文件的应用，否则取绑定列表第一个应用。
    if (appId === '') {
      for (const candidateApp of candidateApps) {
        const logFile = path.join(
          this.ctx.resources.root,
          'channels',
          'feishu',
          'chats',
          namesModule.getSafeName(candidateApp, Infinity),
          `${namesModule.getSafeName(chatId, Infinity)}.jsonl`,
        );
        if (fs.existsSync(logFile)) {
          appId = candidateApp;
          break;
        }
      }
    }
    if (appId === '') {
      appId = candidateApps[0] ?? '';
    }
    if (appId === '') return `chat_not_found：没有叫 ${exact} 的聊天`;

    //M 返回干净的目标地址，openId 与 messageId 置空避免群里误 @ 路人或错挂回复。
    const address: FeishuAddress = {
      appId,
      chatId,
      messageId: '',
      openId: '',
      chatType,
      customer: feishuCustomer(chatType, chatId, '', chatType === 'p2p'),
    };
    if (chatName !== '') {
      address.chatName = chatName;
    }
    return address;
  }

  /**
   * 响应 channel/history（接口 A）：在当前账号/聊天与授权交集内返回已落盘记录。
   * 明确校验游标防篡改、mentions 缺 botOpenId 时报错 identity_unresolved（不把 @任何人 当 @自己）。
   * @param request 历史查询请求。
   */
  private onChannelHistory(request: protocol.ChannelHistoryRequest): void {
    if (request.channel !== this.name) return;

    request.handled = true;
    const emitResult = (result: protocol.ChannelHistoryResult): void => {
      this.ctx.emit('channel/history-result', { ...result, requestId: request.requestId });
    };

    //M 按统一协议判断当前发起者是否为拥有跨聊天查询权限的 owner 账号。
    const snapshot = request.sourceSnapshot;
    const isOwner = protocol.isHistoryOwner(snapshot);
    let rawChat = '';
    if (request.chatId !== undefined && request.chatId.trim() !== '') {
      rawChat = request.chatId.trim();
    }
    if (rawChat === '' && snapshot.channel === this.name) {
      rawChat = snapshot.chatId;
    }

    //G 再核聊天范围权限：guest / builder 仅当前飞书聊天，owner 可跨渠道、跨聊天查询任意飞书应用聊天。
    const isSameChat = snapshot.channel === this.name && rawChat !== '' && rawChat === snapshot.chatId;
    if (!isOwner && !isSameChat) {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'forbidden', message: `无权访问聊天 ${rawChat}` },
      });
      return;
    }

    //M 解析目标应用号与聊天 ID：支持传入 appId:chatId，跨渠道时优先挑选存在聊天记录的机器人应用。
    let appId = '';
    let targetChatId = rawChat;
    if (rawChat.includes(':')) {
      const sep = rawChat.indexOf(':');
      const maybeApp = rawChat.slice(0, sep);
      const maybeChat = rawChat.slice(sep + 1);
      if (this.apps.has(maybeApp) && maybeChat !== '') {
        appId = maybeApp;
        targetChatId = maybeChat;
      }
    }
    if (appId === '' && snapshot.channel === this.name && this.apps.has(snapshot.accountId)) {
      appId = snapshot.accountId;
    }
    if (appId === '') {
      //M 查该机器人配置的全部飞书应用列表作为备选，没有则兜底枚举所有已配置飞书应用。
      let candidates = this.getApps(snapshot.botName);
      if (candidates.length === 0) {
        candidates = [...this.apps.keys()];
      }
      if (targetChatId !== '') {
        for (const candidate of candidates) {
          if (fs.existsSync(this.chatLogFile(candidate, targetChatId))) {
            appId = candidate;
            break;
          }
        }
      }
      if (appId === '' && candidates[0] !== undefined) {
        appId = candidates[0];
      }
    }

    if (targetChatId === '' && appId !== '') {
      //M 跨渠道仅指定应用而未指明 chatId 时，默认回落到该应用最近私聊过的聊天。
      targetChatId = this.lastPrivate(appId)?.chatId ?? '';
    }
    if (targetChatId === '') {
      //M 目标聊天仍为空时返回参数错误结果并提前终止查询。
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'invalid_argument', message: '跨渠道查询飞书历史需要指定 chat' },
      });
      return;
    }

    //M 校验解析出的应用 ID 已注册，不存在则返回渠道不可用错误。
    const app = this.apps.get(appId);
    if (app === undefined) {
      //M 找不到对应飞书应用配置时通过结果事件回报错误码。
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'channel_unavailable', message: `未知飞书应用 ${appId}` },
      });
      return;
    }

    if (request.mode === 'mentions') {
      if (app.botOpenId === undefined) {
        //M 尚未拿到机器人自身 open_id 时拒绝精确 mentions 过滤并返回 identity_unresolved。
        emitResult({
          ok: false,
          items: [],
          nextCursor: null,
          scope: `${this.name}:${appId}:${targetChatId}`,
          completeness: 'local_only',
          error: { code: 'identity_unresolved', message: `应用 ${appId} 尚未取得机器人自己的 open_id，无法精确识别 @ 提及` },
        });
        return;
      }
    }

    const expectedSenderId = request.senderId ?? '';
    let decodedCursor: protocol.HistoryCursorPayload | undefined;
    if (request.before !== undefined && request.before !== '') {
      //M 解码并严格校对翻页游标签名与当前查询上下文是否一致，防止跨会话越权伪造游标。
      decodedCursor = protocol.decodeHistoryCursor(request.before, {
        channel: this.name,
        accountId: appId,
        chatId: targetChatId,
        mode: request.mode,
        senderId: expectedSenderId,
        botName: snapshot.botName,
      });
      if (decodedCursor === undefined) {
        //M 游标验签或范围校验失败时返回 invalid_cursor 终止翻页。
        emitResult({
          ok: false,
          items: [],
          nextCursor: null,
          scope: `${this.name}:${appId}:${targetChatId}`,
          completeness: 'local_only',
          error: { code: 'invalid_cursor', message: '历史翻页游标无效或与当前查询范围不匹配' },
        });
        return;
      }
    }

    //M 从本地 jsonl 日志加载当前群/私聊的全部已落盘消息供后续过滤分页。
    const rawEntries = this.readChatLog(appId, targetChatId);
    const filtered = rawEntries.filter((entry) => {
      if (request.mode === 'mentions') {
        return entry.mentions.some((m) => m.botNames.includes(snapshot.botName) || (app.botOpenId !== undefined && m.id === app.botOpenId));
      }
      if (request.mode === 'visible') {
        return entry.sender.id === expectedSenderId;
      }
      return true;
    });

    //M 按 (createdAt, messageId) 稳定升序排列，再严格切取 cursor 之前最近 limit 条。
    filtered.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      if (a.messageId < b.messageId) return -1;
      if (a.messageId > b.messageId) return 1;
      return 0;
    });

    let bounded = filtered;
    if (decodedCursor !== undefined) {
      bounded = filtered.filter((entry) => {
        if (entry.createdAt < decodedCursor.beforeAt) return true;
        return entry.createdAt === decodedCursor.beforeAt && entry.messageId < decodedCursor.beforeId;
      });
    }

    const page = bounded.slice(-request.limit);
    let nextCursor: string | null = null;
    if (bounded.length > page.length && page[0] !== undefined) {
      //M 仍有更早消息可翻页时，按当前页首条消息的 (时间, ID) 及查询作用域签发下一页游标。
      nextCursor = protocol.encodeHistoryCursor({
        beforeAt: page[0].createdAt,
        beforeId: page[0].messageId,
        channel: this.name,
        accountId: appId,
        chatId: targetChatId,
        mode: request.mode,
        senderId: expectedSenderId,
        botName: snapshot.botName,
      });
    }

    const items: protocol.ChannelHistoryItem[] = page.map((entry) => ({
      messageId: entry.messageId,
      nativeId: entry.nativeId,
      direction: entry.direction,
      createdAt: entry.createdAt,
      sender: entry.sender,
      text: entry.text,
      mentions: entry.mentions,
      attachments: entry.attachments,
    }));

    //M 发出本地落盘历史的成功查询结果事件。
    emitResult({
      ok: true,
      items,
      nextCursor,
      scope: `${this.name}:${appId}:${targetChatId}`,
      completeness: 'local_only',
    });
  }

  /** 飞书聊天本地日志文件（channels/feishu/chats/<app>/<chat>.jsonl）。 */
  private chatLogFile(appId: string, chatId: string): string {
    //M 将 appId 安全转义为目录名，生成对应的聊天历史文件夹并拼出聊天日志文件。
    const dir = this.ctx.resources.dir('channels', 'feishu', 'chats', namesModule.getSafeName(appId, Infinity));
    return path.join(dir, `${namesModule.getSafeName(chatId, Infinity)}.jsonl`);
  }

  /** 追加写入一条聊天原始记录（同 messageId 去重，防重启或重放双写）。 */
  private appendChatLog(appId: string, chatId: string, entry: FeishuChatLogEntry): void {
    //M 定位日志文件并扫现有记录，同一 messageId 已存在则跳过，防重放双写。
    const file = this.chatLogFile(appId, chatId);
    const existing = this.readChatLog(appId, chatId);
    if (existing.some((item) => item.messageId === entry.messageId)) return;

    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 读取某个聊天的全部已保存原始消息。 */
  private readChatLog(appId: string, chatId: string): FeishuChatLogEntry[] {
    //M 按应用号和聊天 ID 解析 jsonl 路径，不存在即视为空历史。
    const file = this.chatLogFile(appId, chatId);
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const items: FeishuChatLogEntry[] = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line) as FeishuChatLogEntry);
      } catch {
        continue;
      }
    }
    return items;
  }

  /** 飞书回复幂等记录文件（channels/feishu/replies/<app>.jsonl）。 */
  private replyLogFile(appId: string): string {
    //M 初始化存储各飞书应用已发回复幂等凭据的运行时目录。
    const dir = this.ctx.resources.dir('channels', 'feishu', 'replies');
    return path.join(dir, `${namesModule.getSafeName(appId, Infinity)}.jsonl`);
  }

  /** 确保把该应用历史回复幂等键读入内存缓存。 */
  private ensureReplyLoaded(appId: string): void {
    if (this.loadedReplyApps.has(appId)) return;

    //M 首次访问该应用时标记已加载，并逐行把历史幂等记录装载进内存 Map。
    this.loadedReplyApps.add(appId);
    const file = this.replyLogFile(appId);
    if (!fs.existsSync(file)) return;

    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line) as FeishuReplyRecord;
        this.replyCache.set(rec.replyRequestKey, rec);
      } catch {
        continue;
      }
    }
  }

  /** 查同应用已保存的回复幂等记录。 */
  private getReplyRecord(appId: string, replyRequestKey: string): FeishuReplyRecord | undefined {
    //M 先懒加载历史回复日志，再从内存缓存检索对应请求幂等键。
    this.ensureReplyLoaded(appId);
    return this.replyCache.get(replyRequestKey);
  }

  /** 保存并持久化回复幂等记录。 */
  private saveReplyRecord(appId: string, record: FeishuReplyRecord): void {
    //M 先同步加载防覆盖旧键，再同时写入内存索引和磁盘 jsonl 追加日志。
    this.ensureReplyLoaded(appId);
    this.replyCache.set(record.replyRequestKey, record);
    fs.appendFileSync(this.replyLogFile(appId), `${JSON.stringify(record)}\n`, 'utf8');
  }

  /**
   * 这条消息是哪种会话接的：回话地址是它的那场飞书会话。
   * @param messageId 飞书消息号。
   * @returns 会话种类（front、relay……）；没有会话接（只记了、被别的插件处理掉了）是 undefined。
   */
  private takenBy(messageId: string): string | undefined {
    //M Sessions.find 每一项用 json_extract(meta, '$.项') 比，所以 address.messageId 这种嵌套的也能找。
    const where = { channel: 'feishu', 'address.messageId': messageId } as unknown as Partial<SessionMeta>;
    return this.ctx.sessions.find(where)[0]?.kind;
  }

  /**
   * 来往流水记一行：运行时目录 data/logs/feishu-contacts.jsonl，追加。开发阶段不打码。
   * @param contact 这条消息的时间、应用、聊天、说话人、有没有 @、话的前 80 字。
   * @param outcome 最后怎么处理的。
   * 副作用：写文件；写不进只打日志，不挡消息。
   */
  private logContact(contact: Omit<Contact, 'outcome'>, outcome: string): void {
    const line: Contact = { ...contact, outcome };
    try {
      //M 以追加行写入 data/logs/feishu-contacts.jsonl 记录全量来往流水。
      fs.appendFileSync(this.contactsFile(), `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      //M 写流水失败仅打印带时间戳日志，不阻断正常消息处理。
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书：来往流水没写进去：${textModule.getMessage(error)}`);
    }
  }

  /**
   * 最近的来往流水，接口 GET /api/feishu/contacts 用。
   * @param limit 最多几条。
   * @returns 新的在前。
   */
  contacts(limit: number): Contact[] {
    //M 解析流水文件路径，未生成过直接返回空列表。
    const file = this.contactsFile();
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit).reverse().map((line) => JSON.parse(line) as Contact);
  }

  /** @returns 来往流水文件的绝对路径（文件夹没有就建）。 */
  private contactsFile(): string {
    //M 确保 data/logs 运行时子目录存在并拼接飞书来往流水 jsonl 路径。
    return path.join(this.ctx.resources.dir('data', 'logs'), 'feishu-contacts.jsonl');
  }

  /**
   * 点卡片按钮：认出是哪张卡片、谁点的、按钮值，交给 cards/ 处理，回给飞书一个小提示。
   * @param appId 哪个应用收的。
   * @param data 飞书的 card.action.trigger 事件（新版回调）；旧版字段也认。
   * @returns { toast }：SDK 把它当回调的回应带回飞书。
   */
  private async onCard(appId: string, data: unknown): Promise<{ toast: Toast }> {
    const event = (data ?? {}) as {
      operator?: { open_id?: string };
      context?: { open_message_id?: string; open_chat_id?: string };
      action?: { value?: unknown };
      open_id?: string;
      open_message_id?: string;
      open_chat_id?: string;
    };
    const openId = event.operator?.open_id ?? event.open_id ?? '';
    const cardId = event.context?.open_message_id ?? event.open_message_id ?? '';
    const chatId = event.context?.open_chat_id ?? event.open_chat_id ?? '';

    //M 按钮值：对象直接用；字符串先当 JSON 解析。
    let value = event.action?.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = {};
      }
    }
    //M 结合 feishu_p2p 表反查点击来源是否为私聊并构建标准回话地址结构。
    const p2p = chatId !== '' && this.ctx.resources.db.query('SELECT 1 FROM feishu_p2p WHERE app_id = ? AND chat_id = ?').get(appId, chatId) !== null;
    let chatType = '';
    if (chatId !== '') {
      chatType = 'group';
    }
    if (p2p) {
      chatType = 'p2p';
    }
    let customerChatType = '';
    if (p2p) {
      customerChatType = 'p2p';
    }
    //M 按聊天类型与私聊反查结果生成标准客户标识（群与私聊保持隔离）。
    const customer = feishuCustomer(customerChatType, chatId, openId, p2p);
    const address: FeishuAddress = { appId, chatId, messageId: cardId, openId, chatType, customer };
    //M 点卡片的人是哪一档：和收消息一样只看 people。
    const guestDir = this.ctx.resources.dir('guests', GUEST_DIR);
    //M 提取人员档位字段（owner / role / workspace）写入回话地址。
    const fields = roleFields(this.config.people.get(openId), guestDir);
    Object.assign(address, fields);
    //M 群受不受信：和收消息一样按群号查 groups。
    if (!p2p) {
      const registered = this.config.groups.get(chatId);
      if (registered !== undefined) {
        address.trusted = registered.trusted;
      }
    }


    //T 跟踪：点了卡片按钮。
    const vars = { 应用: appId, 卡片: cardId, 按钮: JSON.stringify(value ?? {}) };
    this.ctx.emit('trace', 'Feishu.onCard', '飞书卡片上点了按钮，交给卡片那块', 'cards.onAction(...)', vars);
    try {
      const toast = await cards.onAction(this, address, cardId, (value ?? {}) as Record<string, unknown>);
      return { toast: toast ?? { type: 'info', content: '这个按钮没有用了' } };
    } catch (error) {
      return { toast: { type: 'error', content: `没处理成：${textModule.getMessage(error)}` } };
    }
  }

  /**
   * 登记给 bots 的发送：把会话的话发回飞书；这一轮结束了再撤“敲键盘”表情。
   * 出错打日志、写进回执，不往外抛；不自动重发。
   * @param reply 要说的话。
   * @param session 哪场会话。
   * @param origin 发到哪：给了就用它的地址（前台送后台结果），没给用会话现在记的。
   * @returns 回执：全发了 accepted，文件有没发出去的 partial，飞书明确拒了 rejected，断网超时这类不知道的 uncertain。
   */
  protected async send(reply: string, session: Session, origin?: LegacyOrigin): Promise<LegacySendReceipt> {
    const address = (origin?.address ?? session.row.address) as FeishuAddress | undefined;
    /** 发完的回执；出错时下面改掉。 */
    let receipt: LegacySendReceipt;
    try {
      //M 群聊回复前自动补 @ 说话人，再经统一文本+附件发送通道投递飞书。
      receipt = await this.sendText(address, this.withAt(address, reply));
    } catch (error) {
      //M 提取异常说明并带时间戳输出发送失败日志，再按 NotSent 区分回执状态。
      const reason = textModule.getMessage(error);
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书：会话 ${session.id} 的回话没发出去：${reason}`);

      //M 飞书明确拒了是 rejected；别的（断网、超时）不知道收没收，是 uncertain。
      receipt = { status: 'uncertain', reason };
      if (error instanceof api.NotSent) {
        receipt = { status: 'rejected', reason };
      }
    }
    //M 这一轮结束了，撤“敲键盘”表情。给了 origin 的（前台送后台结果）是早先那句话的地址，表情那时已经撤过。
    if (origin === undefined && session.row.state !== 'running' && address?.typingReaction !== undefined) {
      await this.untype(address);
    }
    return receipt;
  }

  /**
   * 发文字，再发文字里 @"路径"、@路径 指的文件（存在的绝对路径文件才算），文字里换成「文件名」。
   * @param address 回话地址。
   * @param text 要发的话。
   * @returns 回执：都发了 accepted；有文件没发出去是 partial（原因写哪几个）。
   * @throws 地址没有 chatId（api.NotSent）、文字发不出去时抛错；某个文件发不出去时补发一句说明，不抛。
   */
  async sendText(address: FeishuAddress | undefined, text: string): Promise<LegacySendReceipt> {
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
    if (body.trim() !== '') {
      await media.message(this, address.appId, address.chatId, 'text', { text: body }, address.messageId);
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
        const said = `「${baseName(item.file)}」没发出去：${textModule.getMessage(error)}`;
        const logTime = textModule.getClock(Date.now(), 'date');
        console.error(`${logTime} 飞书：${said}`);
        failed.push(said);
        //M 把该附件未送达的原因文字单独发到原会话，不阻断后续其余文件投递。
        await media.message(this, address.appId, address.chatId, 'text', { text: said }, address.messageId);
      }
    }

    //M 有文件没发出去：只发了一部分。
    if (failed.length > 0) return { status: 'partial', reason: failed.join('；') };

    return { status: 'accepted', reason: '' };
  }

  /**
   * 这个群里认得的名字 → open_id：先流水里见过的说话人，再飞书群成员，最后 people 登记的（后写的盖前面的，所以登记的优先）。
   * @param address 回话地址：取群号。
   * @returns 名字 → open_id；名字空的不收。
   */
  private getNames(address: FeishuAddress): Map<string, string> {
    const found = new Map<string, string>();

    //M 流水里这个群见过的说话人。
    for (const line of this.contacts(1000)) {
      if (line.chatId === address.chatId && line.sender !== '' && line.openId !== '') found.set(line.sender, line.openId);
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
   * 群里的话：把 @名字 换成 <at user_id="open_id">名字</at>；认不出的名字原样留着。私聊不动。
   * @param address 回话地址。
   * @param text 要发的话。
   * @returns 换好的话。
   */
  private mentioned(address: FeishuAddress, text: string): string {
    //G 私聊或正文不含 @ 符号时无需转换 <at> 标签，直接原样返回。
    if (!workspaceModule.isGroup(address) || !text.includes('@')) return text;

    //M 长名字先换，免得“陈”抢了“陈大管家”。
    const known = this.getNames(address);
    let body = text;
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
  private withAt(address: FeishuAddress | undefined, reply: string): string {
    //G 私聊、无目标发言人 openId 或空回复不额外前置 @ 标签。
    if (address === undefined || !workspaceModule.isGroup(address) || address.openId === '' || reply.trim() === '') return reply;

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
   * 前台补报一次判断的结果：补记一行流水，outcome 写 judge:回 / judge:不回(0.32)。
   * @param address 回话地址（不是飞书的忽略）。
   * @param text 那句话。
   * @param outcome 判断的结果。
   */
  private logJudged(address: unknown, text: string, outcome: string): void {
    //M 从透传地址安全取出 appId，确认属于飞书渠道再补记决策结果流水。
    const appId = textModule.getText(address, 'appId');
    if (!this.apps.has(appId)) return;
    const contact: Omit<Contact, 'outcome'> = {
      //M 汇总日期戳、聊天元信息与裁剪后正文构成流水条，写入来往记录。
      at: textModule.getClock(Date.now(), 'date'), app: appId, chatType: textModule.getText(address, 'chatType'),
      chatId: textModule.getText(address, 'chatId'), chatName: textModule.getText(address, 'chatName'),
      openId: textModule.getText(address, 'openId'), sender: textModule.getText(address, 'senderName'), atMe: false,
      text: textModule.clip(text.trim(), 80),
    };
    //M 将前台补充判定的结果标签追加写入联系人流水文件。
    this.logContact(contact, outcome);
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
  private async untype(address: FeishuAddress): Promise<void> {
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
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书：表情没撤掉：${textModule.getMessage(error)}`);
    }
  }

  /**
   * 响应 web-api/status：每个应用放一项。
   * @param list web-api 给的清单，往里 push。
   */
  private status(list: ChannelStatus[]): void {
    for (const app of this.apps.values()) {
      const at = new Date(app.at).toLocaleString('zh-CN', { hour12: false });
      list.push({ name: `feishu:${app.config.appId}`, bot: app.config.bot, connected: app.connected, detail: `${app.state}（${at}）` });
    }
  }

  /**
   * 登记已收到撤回通知的平台原消息键 `${appId}:${nativeId}`（最多保留 500 条）。
   * @param appId 飞书应用号。
   * @param nativeId 飞书原生消息号。
   */
  private rememberRecalledNative(appId: string, nativeId: string): void {
    //M 将平台原消息键写入已撤回集合，超过容量上限时淘汰最早登记的一条。
    this.recalledNativeIds.add(`${appId}:${nativeId}`);
    if (this.recalledNativeIds.size <= 500) return;

    const oldest = this.recalledNativeIds.values().next().value;
    if (oldest !== undefined) {
      this.recalledNativeIds.delete(oldest);
    }
  }

  /**
   * 收到飞书 im.message.recalled_v1 撤回事件：只认本人或原发消息人撤回，通知 bots 停掉对应正在跑或排队的任务。
   * @param appId 哪个飞书应用收到撤回事件。
   * @param data 飞书撤回事件载荷。
   */
  private async onRecall(appId: string, data: RecallData): Promise<void> {
    //G 忽略未知应用或缺少消息/聊天标识的残缺事件。
    if (!this.apps.has(appId)) return;

    const nativeId = data.message_id ?? '';
    const chatId = data.chat_id ?? '';
    if (nativeId === '' || chatId === '') return;

    //M 按与 channel/message 完全一致的口径算出标准消息号，并读取本地聊天日志查出原发送人。
    const standardMessageId = protocol.makeChannelMessageId(this.name, appId, nativeId);
    const logged = this.readChatLog(appId, chatId).find((entry) => entry.messageId === standardMessageId);

    //G 机器人自己撤回的出站消息不触发停任务。
    if (logged?.direction === 'bot') return;

    //M 若事件携带操作者 open_id，核对是否本人（owner）或该条原发消息人。
    const operatorId = data.operator_id?.open_id ?? '';
    let recalledId = '';
    let isOwner = false;
    let kind: 'sender' | 'owner' = 'sender';
    if (operatorId !== '') {
      //M 查询操作者在 people 配置里的身份档位并对照原消息发送者。
      const operatorOwner = this.config.people.get(operatorId)?.role === 'owner';
      let operatorIsSender = data.recall_type === 'message_owner';
      if (logged !== undefined) {
        operatorIsSender = logged.sender.id === operatorId;
      }
      if (!operatorOwner && !operatorIsSender) return;

      recalledId = operatorId;
      isOwner = operatorOwner;
      if (operatorOwner) {
        kind = 'owner';
      }
    }

    //M 标准飞书撤回事件未带操作者时，仅放行原发信人本人自撤（message_owner），群管代撤无法确认是否本人一律忽略。
    if (operatorId === '') {
      if (data.recall_type !== 'message_owner') return;

      //M 查出原发信人 ID 并校验其是否在 people 里登记为本人（owner）。
      recalledId = logged?.sender.id ?? '';
      isOwner = recalledId !== '' && this.config.people.get(recalledId)?.role === 'owner';
      if (isOwner) {
        kind = 'owner';
      }
    }

    //M 先登记撤回消息号以拦截附件下载中的入站和在途回话，再发 channel/recall 让 bots 立即停跑与清队列。
    this.rememberRecalledNative(appId, nativeId);
    const vars = { 应用: appId, 聊天: chatId, 原消息: nativeId, 撤回人: recalledId || 'message_owner', 本人: isOwner };
    this.ctx.emit('trace', 'Feishu.onRecall', '飞书收到撤回消息事件，通知 bots 停掉对应任务', "ctx.serial('channel/recall', event)", vars);
    await this.ctx.serial('channel/recall', {
      channel: this.name,
      accountId: appId,
      chatId,
      messageId: standardMessageId,
      nativeId,
      recalledBy: { id: recalledId, kind, isOwner },
    });
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
 * 校验配置。channels.feishu 是外面进来的（config.yaml），在这里校验一次，里面直接信。
 * @param ctx 插件的 ctx（读 config.yaml、查机器人名单）。
 * @param written plugins 段里写给本插件的配置：domain、people、groups 都可选。
 * @returns 校验后的配置。
 * @throws 哪一项不对时抛错；错误里不带 app_secret。
 */
export function checkConfig(ctx: cordis.Context, written: unknown): FeishuConfig {
  let ownObject: unknown = {};
  if (typeof written === 'object' && written !== null) {
    ownObject = written;
  }
  const own = ownObject as Record<string, unknown>;
  const domain = own['domain'] ?? 'https://open.feishu.cn';
  if (typeof domain !== 'string' || !/^https?:\/\/\S+$/u.test(domain)) {
    throw new Error('feishu 插件的 domain 要写成 http:// 或 https:// 开头的地址');
  }

  const channels = ctx.resources.raw['channels'] as { feishu?: unknown } | undefined;
  const list = channels?.feishu;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('config.yaml 的 channels.feishu 要写成一张清单，至少一个飞书应用');
  }
  const apps: FeishuApp[] = [];
  for (const [index, value] of list.entries()) {
    let itemObject: unknown = {};
    if (typeof value === 'object' && value !== null) {
      itemObject = value;
    }
    const item = itemObject as Record<string, unknown>;
    const where = `channels.feishu 第 ${String(index + 1)} 项`;
    const appId = item['app_id'];
    const appSecret = item['app_secret'];
    const bot = item['bot'];
    if (typeof appId !== 'string' || appId === '') throw new Error(`${where} 要写非空的 app_id`);
    if (typeof appSecret !== 'string' || appSecret === '') throw new Error(`${where} 要写非空的 app_secret`);
    //M 校验主机器人名字存在于已配置的机器人名单中。
    if (typeof bot !== 'string' || ctx.bots.get(bot) === undefined) {
      throw new Error(`${where} 的 bot 要写机器人名单里有的名字`);
    }
    if (apps.some((app) => app.appId === appId)) throw new Error(`${where} 的 app_id 和前面的重了`);
    const extraBotsRaw = item['bots'];
    let botsList: string[] | undefined;
    if (extraBotsRaw !== undefined) {
      //M 校验多机器人共享账号配置的每一个追加机器人名均合法存在。
      if (!Array.isArray(extraBotsRaw) || extraBotsRaw.some((one) => typeof one !== 'string' || ctx.bots.get(one) === undefined)) {
        throw new Error(`${where} 的 bots 要写成机器人名单里已有名字的清单`);
      }
      botsList = [...new Set([bot, ...(extraBotsRaw as string[])])];
    }
    const appEntry: FeishuApp = { appId, appSecret, bot };
    if (botsList !== undefined) {
      appEntry.bots = botsList;
    }
    apps.push(appEntry);
  }
  //M 校验并解析人员权限清单与群配置清单后拼出完整飞书配置对象。
  return { domain: domain.replace(/\/+$/u, ''), apps, people: getPeople(ctx, own), groups: getGroups(own) };
}


/**
 * 一张登记清单（people、groups）：不写是空的，写了要是对象的清单。
 * @param value 配置里写的。
 * @param key 哪一项，报错用。
 * @returns 每项当对象读。
 */
function getEntries(value: unknown, key: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  const valid = Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
  if (!valid) throw new Error(`feishu 插件的 ${key} 要写成清单，每项一个对象`);
  return value as Record<string, unknown>[];
}


/**
 * 回话地址里“这个人是哪一档”的几项：owner、role，builder、guest 再加 workspace。收消息、点卡片共用。
 * @param person 登记的人；没登记是 undefined，当 guest。
 * @param guestDir 没登记的 guest 用的目录（运行时目录 guests/_guest/）。
 * @returns 要并进地址的几项。
 */
function roleFields(person: FeishuPerson | undefined, guestDir: string): Pick<FeishuAddress, 'owner' | 'role' | 'workspace'> {
  const role = person?.role ?? 'guest';
  const fields: Pick<FeishuAddress, 'owner' | 'role' | 'workspace'> = { owner: role === 'owner', role };
  if (person?.role === 'builder') fields.workspace = person.dir;
  //M guest 也不读机器人的工作区（里面有用户的收件、截图）：登记了用他的目录，没登记的用 guests/_guest/；guest 只有只读工具。
  if (role === 'guest') fields.workspace = person?.dir || guestDir;
  return fields;
}


/** 没登记的 guest 共用的目录名：运行时目录 guests/_guest/。 */
const GUEST_DIR = '_guest';


/** people 里 role 能写的值。 */
const ROLES: string[] = ['owner', 'builder', 'guest'];


/**
 * 认得的人：people 每项 open_id、name（必写）、role（owner / builder / guest，默认 guest）、dir（builder 的目录）。
 * 旧写法 owner: true 当 role: owner；relay 配置里旧的 owner_open_ids 也收进来（当本人、名字空着），本人只在这里判断。
 * builder、guest 的 dir 相对运行时目录算（写绝对路径也行），不写是 guests/<名字>/；没有就建。
 * @param ctx 读运行时目录、relay 的插件配置。
 * @param own feishu 插件的配置。
 * @returns open_id → 人。
 * @throws 哪项没写 open_id、name，role 写了别的值，owner 不是布尔，dir 不是文字，builder 没写 dir 而名字当不了目录名，
 *   open_id 重了，旧 owner_open_ids 不是字符串清单时抛错。
 */
function getPeople(ctx: cordis.Context, own: Record<string, unknown>): Map<string, FeishuPerson> {
  const people = new Map<string, FeishuPerson>();
  //M 逐条解析并校验配置里登记的人员身份档案（owner / builder / guest）。
  for (const item of getEntries(own['people'], 'people')) {
    const openId = item['open_id'];
    const name = item['name'];
    const owner = item['owner'] ?? false;
    if (typeof openId !== 'string' || openId === '' || typeof name !== 'string' || name === '') {
      throw new Error('feishu 插件的 people 每项要写 open_id 和 name');
    }
    if (typeof owner !== 'boolean') throw new Error(`feishu 插件 people 里 ${name} 的 owner 要写 true 或 false`);
    if (people.has(openId)) throw new Error(`feishu 插件的 people 里 ${openId} 写了两次`);

    //M 哪一档：写了 role 照 role；旧写法 owner: true 是本人；都没写是 guest。
    let defaultRole = 'guest';
    if (owner) {
      defaultRole = 'owner';
    }
    const role = item['role'] ?? defaultRole;
    if (typeof role !== 'string' || !ROLES.includes(role)) {
      throw new Error(`feishu 插件 people 里 ${name} 的 role 要写 owner、builder 或 guest`);
    }

    //M builder 的目录：写了相对运行时目录算，没写是 guests/<名字>/；没有就建。owner 用不到。
    let dir = '';
    if (role === 'builder') {
      const written = item['dir'] ?? path.join('guests', name);
      if (typeof written !== 'string' || written === '') throw new Error(`feishu 插件 people 里 ${name} 的 dir 要写目录`);
      if (item['dir'] === undefined && (path.basename(name) !== name || name === '..')) {
        throw new Error(`feishu 插件 people 里 ${name} 的名字当不了目录名，给他写 dir`);
      }
      dir = path.resolve(ctx.resources.root, written);
      fs.mkdirSync(dir, { recursive: true });
    }
    //M guest 的目录：写了照写，没写是 guests/<名字>/，名字当不了目录名就用 guests/_guest/；只建这一个目录。
    if (role === 'guest') {
      let defaultGuestDir = path.join('guests', GUEST_DIR);
      if (path.basename(name) === name && name !== '..') {
        defaultGuestDir = path.join('guests', name);
      }
      const written = item['dir'] ?? defaultGuestDir;
      if (typeof written !== 'string' || written === '') throw new Error(`feishu 插件 people 里 ${name} 的 dir 要写目录`);
      dir = path.resolve(ctx.resources.root, written);
      fs.mkdirSync(dir, { recursive: true });
    }
    people.set(openId, { openId, name, role: role as FeishuRole, dir });
  }

  //M 旧写法：relay 插件配置的 owner_open_ids。people 里登记过的照 people，没登记的补成本人。
  const relay = ctx.resources.config.plugins.find((entry) => entry.name === 'relay');
  const legacy = textModule.getField(relay?.config, 'owner_open_ids') ?? [];
  if (!Array.isArray(legacy) || !legacy.every((id) => typeof id === 'string')) {
    throw new Error('relay 的 owner_open_ids 要写成字符串清单（新写法是 feishu 插件 people 里 owner: true）');
  }
  for (const openId of legacy as string[]) {
    if (openId !== '' && !people.has(openId)) people.set(openId, { openId, name: '', role: 'owner', dir: '' });
  }
  return people;
}


/**
 * 专门设过的群：groups 每项 chat_id（必写）、name、listen（mention / all / judge，默认 mention）、judge_threshold（0 到 1，可不写）、relay（direct / model，默认 direct）、
 * trusted（true / false，默认 false：本人在 trusted 群里说话才带私人记忆）。
 * @param own feishu 插件的配置。
 * @returns chat_id → 群。
 * @throws 哪项没写 chat_id、chat_id 重了、listen 或 relay 写了别的值、judge_threshold 不是 0 到 1 的数、trusted 不是布尔时抛错。
 */
function getGroups(own: Record<string, unknown>): Map<string, FeishuGroup> {
  const groups = new Map<string, FeishuGroup>();
  //M 逐条解析并校验专项群规则（监听策略、决策阈值、中转方式及隐私信任标记）。
  for (const item of getEntries(own['groups'], 'groups')) {
    const chatId = item['chat_id'];
    const name = item['name'] ?? '';
    const listen = item['listen'] ?? 'mention';
    const relay = item['relay'] ?? 'direct';
    const trusted = item['trusted'] ?? false;
    const threshold = item['judge_threshold'];
    if (typeof chatId !== 'string' || chatId === '') throw new Error('feishu 插件的 groups 每项要写 chat_id');
    if (groups.has(chatId)) throw new Error(`feishu 插件的 groups 里 ${chatId} 写了两次`);
    if (typeof name !== 'string') throw new Error(`feishu 插件 groups 里 ${chatId} 的 name 要写成字符串`);
    if (listen !== 'mention' && listen !== 'all' && listen !== 'judge') throw new Error(`feishu 插件 groups 里 ${chatId} 的 listen 只能写 mention、all 或 judge`);
    if (threshold !== undefined && (typeof threshold !== 'number' || threshold < 0 || threshold > 1)) throw new Error(`feishu 插件 groups 里 ${chatId} 的 judge_threshold 要写 0 到 1 的数`);
    if (relay !== 'direct' && relay !== 'model') throw new Error(`feishu 插件 groups 里 ${chatId} 的 relay 只能写 direct 或 model`);
    if (typeof trusted !== 'boolean') throw new Error(`feishu 插件 groups 里 ${chatId} 的 trusted 只能写 true 或 false`);
    const groupEntry: FeishuGroup = { chatId, name, listen, relay, trusted };
    if (threshold !== undefined) {
      groupEntry.judgeThreshold = threshold;
    }
    groups.set(chatId, groupEntry);
  }
  return groups;
}


/**
 * 挂上飞书。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里的服务都就绪，再调一次 apply。
 * 这里建渠道、登记云文档工具、开发件箱；卡片那块各开一个小插件，approval、progress 来了才开工。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins 段里写给它的：{ domain?: 飞书开放平台地址, people?: 认得的人, groups?: 专门设过的群 }。
 * @throws 配置不对时抛错。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  //M 先按运行配置校验飞书账号、人员和群规则，再创建飞书渠道主实例。
  const feishu = new Feishu(ctx, checkConfig(ctx, config));
  //M 挂成服务：别的插件用 ctx.get('feishu') 调 sendFile，不要 import 本文件的函数。
  ctx.provide('feishu', feishu);

  //M http 挂了（写在 feishu 前面）才有来往流水的接口：GET /api/feishu/contacts?limit=（默认 50，最多 1000），新的在前。
  const http = ctx.get('http');
  if (http !== undefined) {
    http.app.get<{ Querystring: { limit?: string } }>('/api/feishu/contacts', (request) => {
      const limit = textModule.getNumber(request.query.limit, 50, 1, 1000);
      return { items: feishu.contacts(limit) };
    });
  }

  //M 依次挂载飞书文件发送工具、云文档工具与定时发件箱监听，随插件同生命周期撤销。
  media.setup(feishu, ctx);
  doc.setup(feishu, ctx);
  outbox.setup(feishu, ctx);

  //M ctx.inject(服务, 回调) 就是 ctx.plugin({ inject: 服务, apply: 回调 })：服务在了才调回调，服务走了这个小插件自动拔掉。
  void ctx.inject(['approval'], (sub) => {
    cards.setupApproval(feishu, sub);
  });
  void ctx.inject(['progress'], (sub) => {
    cards.setupProgress(feishu, sub);
  });
}
