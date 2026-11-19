/**
 * 飞书：一个插件管飞书的全部——渠道收发、确认卡片和进度卡片（cards/）、飞书云文档工具（doc/）、发件箱（outbox/）。
 * 用户定了：平台型插件放在一个插件里，用子文件夹分管功能。设计见同目录 说明.md 的「设计要点」一节。
 * 渠道收发按职责分文件：这个文件是入口（类型、配置校验、长连接、别的插件调的发送口、apply）；
 * 收消息、撤回、点卡片在 Inbound.ts，channel/reply、channel/send 在 Reply.ts，聊天日志在 ChatLog.ts，
 * 来往流水在 Contacts.ts。拆出去的几个类由 Feishu 构造时建好，挂在 feishu.inbound / reply / history / contacts 上。
 *
 * 渠道：照 config.yaml 的 channels.feishu 名单，一个飞书应用一个 SDK 客户端、一条长连接（WebSocket），等 ready 才连。
 * 渠道只有一个，名字 feishu；回话地址（FeishuAddress）里的 appId 分清是哪个应用，回话从收消息的那个应用发回去。
 * 收：什么类型都接住，图片文件下载后用基类 saveFile 存进机器人工作区，话里写 @绝对路径；按消息号去重（存表，重启也认得）。
 * 群里只回 @ 了机器人的消息；插件配置 groups 里登记了 listen: all 的群，不 @ 的也交下去，标成只听（listenOnly）：
 * 以外部助手前缀开头的 relay 照转，别的前台只记进群的前台会话当背景、不回。
 * listen: judge 的群同样不 @ 也听，前台记完问决策模型要不要主动接话（0.7.19）。
 * 发到群里的话：开头 @ 这一轮最后说话的人，文字里的 @名字 换成 <at user_id="…">名字</at>（名字→open_id 先查 people，再查群成员、流水里见过的）。
 * 认人认群看插件配置的 people、groups（谁是哪一档只在这里判断，写进回话地址的 owner、role、workspace）；
 * 收到的每条都记进来往流水 data/logs/feishu-contacts.jsonl。
 * 发：文字整条发，文字里的 @路径 换成「文件名」再一个个发文件。
 *
 * Cordis 大白话：apply 是插件的 main()，ctx 是它拿到的遥控器；通过 ctx 听的事件、登记的工具、ctx.effect 登记的收尾，
 * 插件被拔掉时 Cordis 自动撤掉。审批和进度卡片通过事件接收更新与发起操作。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import * as lark from '@larksuiteoapi/node-sdk';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as api from './Api.ts';
import * as cards from './cards/Cards.ts';
import { FeishuContacts } from './Contacts.ts';
import * as doc from './doc/Doc.ts';
import { FeishuChatLog } from './ChatLog.ts';
import { FeishuInbound } from './Inbound.ts';
import type { RecallData, ReceiveData } from './Inbound.ts';
import * as media from './Media.ts';
import * as outbox from './outbox/Outbox.ts';
import { FeishuReply } from './Reply.ts';

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


/** 插件名。 */
export const name = 'feishu';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.3：监听 im.message.recalled_v1 撤回消息事件，校验本人或原发信人后发出 channel/recall。
//M 1.1.4：onChannelReply 支持带 target 的跨渠道发话，在飞书自有群/私聊/流水数据里自认聊天。
//M 1.1.9：登记群内每日进度的时间、机器人和提示，progress 读取已校验的配置。
//M 1.1.12：跨聊天发话认目标改用骨架的 parseChatTarget、findChatByIdOrName：飞书只交出候选清单（getChatCandidates）。
//M 1.1.13：入口文件按职责拆成 Inbound、Reply、History、Contacts 四个文件，收消息拆成几步；行为不变。
//M 1.1.18：长连接收到消息先发一个跟踪点 Feishu.start，入站的几个跟踪点都带 messageId（标准消息号），教程轨迹第一格就是飞书收到。
export const version = '1.1.21';

/** 用到的必需服务。审核和进度通过事件协作。 */
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
    /**
     * web-api 每来一次 GET /api/ui/status 挨个问一遍：各渠道往 list 里 push 自己的连接状态。这里每个飞书应用 push 一项。
     * 谁发：src7/plugins/web-api/index.ts 的 WebApi.routes
     * 谁接：src7/plugins/feishu/index.ts 的 Feishu.constructor；src7/plugins/wechat/index.ts 的 Wechat.constructor
     */
    'web-api/status'(list: ChannelStatus[]): void | Promise<void>;
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
  /**
   * builder、guest 的目录（people 的 dir；没登记的 guest 是 guests/_guest/）：
   * 这一轮的工作区，读写、exec、发文件都只在这里（utils/Workspace.ts 的 of 读）。owner 不写。
   */
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
  /** 这个群登记的 trusted：true 时本人在群里说话照旧带私人记忆（utils/Workspace.ts 的 isPrivateMemoryAllowed 读）；没登记、私聊不写，当 false。 */
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
  /** 每日群进度设置。省略时不挂定时。 */
  daily?: { hour: number; minute: number; bot: string; appId: string; prompt: string };
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


/** 一个应用运行时的样子。 */
export interface AppState {
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

  /** 回话：响应 channel/reply、channel/send（Reply.ts）。 */
  readonly reply: FeishuReply;

  /**
   * 建表、给每个应用建 SDK 客户端；ready 时连长连接；被拔掉时关长连接。
   * 向 bots 登记本渠道的发送函数；一轮结束回话和中途先说一句由 bots 按渠道名调用。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验过的配置。
   */
  constructor(private readonly ctx: cordis.Context, readonly config: FeishuConfig) {
    //M 向 bots 服务注册飞书回话投递函数，随本插件卸载由 Cordis 自动撤销。
    this.ctx.effect(() => this.ctx.bots.channel(
      this.name,
      (reply, session, origin) => this.send(reply, session, origin),
    ));
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

    const requestOptions = {
      onError: (error: unknown) => {
        //G 发文件失败时通过回执把原因交给调用方。
        const detail = textModule.getErrorMessage(error);
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

    //M 分发器：收消息、点卡片两个事件干活；已读、表情、进私聊几个登记空处理，免得 SDK 打“没有处理”的警告（0.4 同）。
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
      console.error(`${logTime} 飞书 ${app.config.appId} 没查到机器人自己的 open_id（群里有 @ 就回）：${textModule.getErrorMessage(error)}`);
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
      const reason = textModule.getErrorMessage(error);
      const logTime = textModule.formatLocalTime(Date.now(), 'date');
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
        const said = `「${baseName(item.file)}」没发出去：${textModule.getErrorMessage(error)}`;
        const logTime = textModule.formatLocalTime(Date.now(), 'date');
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
   * 群里的话：把 @名字 换成 <at user_id="open_id">名字</at>；认不出的名字原样留着。私聊不动。
   * @param address 回话地址。
   * @param text 要发的话。
   * @returns 换好的话。
   */
  mentioned(address: FeishuAddress, text: string): string {
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
  withAt(address: FeishuAddress | undefined, reply: string): string {
    //G 私聊、无目标发言人 openId 或空回复不额外前置 @ 标签。
    if (address === undefined || !workspaceModule.isGroup(address)) return reply;
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
    if (typeof bot !== 'string' || botUtils.getBotConfig(ctx.resources.raw, bot) === undefined) {
      throw new Error(`${where} 的 bot 要写机器人名单里有的名字`);
    }
    if (apps.some((app) => app.appId === appId)) throw new Error(`${where} 的 app_id 和前面的重了`);
    const extraBotsRaw = item['bots'];
    let botsList: string[] | undefined;
    if (extraBotsRaw !== undefined) {
      //M 校验多机器人共享账号配置的每一个追加机器人名均合法存在。
      const botsInvalid = !Array.isArray(extraBotsRaw)
        || extraBotsRaw.some((one) => typeof one !== 'string' || botUtils.getBotConfig(ctx.resources.raw, one) === undefined);
      if (botsInvalid) {
        throw new Error(`${where} 的 bots 要写成机器人名单里已有名字的清单`);
      }
      botsList = [...new Set([bot, ...(extraBotsRaw as string[])])];
    }
    const appEntry: FeishuApp = { appId, appSecret, bot };
    if (botsList !== undefined) {
      appEntry.bots = botsList;
    }
    //M 把校验完的一项加入已配置应用清单，启动时按这个清单连飞书。
    apps.push(appEntry);
  }
  //M 校验并解析人员权限清单与群配置清单后拼出完整飞书配置对象。
  return { domain: domain.replace(/\/+$/u, ''), apps, people: getPeople(ctx, own), groups: getGroups(own, apps) };
}


/**
 * 一张登记清单（people、groups）：不写是空的，写了要是对象的清单。
 * @param value 配置里写的。
 * @param key 哪一项，报错用。
 * @returns 每项当对象读。
 */
function getEntries(value: unknown, key: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  const valid = Array.isArray(value)
    && value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
  if (!valid) throw new Error(`feishu 插件的 ${key} 要写成清单，每项一个对象`);
  return value as Record<string, unknown>[];
}


/** 没登记的 guest 共用的目录名：运行时目录 guests/_guest/（Inbound.ts 收消息、点卡片时也用）。 */
export const GUEST_DIR = '_guest';


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
      //M 确保已按配置解析的工作区目录存在。
      filesModule.ensureDir(dir);
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
      //M 确保已按配置解析的工作区目录存在。
      filesModule.ensureDir(dir);
    }
    people.set(openId, { openId, name, role: role as FeishuRole, dir });
  }

  //M 旧写法：relay 插件配置的 owner_open_ids。people 里登记过的照 people，没登记的补成本人。
  const relay = ctx.resources.config.plugins.find((entry) => entry.name === 'relay');
  const legacy = utils.getField(relay?.config, 'owner_open_ids') ?? [];
  if (!Array.isArray(legacy) || !legacy.every((id) => typeof id === 'string')) {
    throw new Error('relay 的 owner_open_ids 要写成字符串清单（新写法是 feishu 插件 people 里 owner: true）');
  }
  for (const openId of legacy as string[]) {
    if (openId !== '' && !people.has(openId)) people.set(openId, { openId, name: '', role: 'owner', dir: '' });
  }
  return people;
}


/**
 * 专门设过的群：groups 每项 chat_id（必写）、name、listen（mention / all / judge，默认 mention）、
 * judge_threshold（0 到 1，可不写）、relay（direct / model，默认 direct）、
 * trusted（true / false，默认 false：本人在 trusted 群里说话才带私人记忆）。
 * @param own feishu 插件的配置。
 * @returns chat_id → 群。
 * @throws 哪项没写 chat_id、chat_id 重了、listen 或 relay 写了别的值、judge_threshold 不是 0 到 1 的数、trusted 不是布尔时抛错。
 */
function getGroups(own: Record<string, unknown>, apps: FeishuApp[]): Map<string, FeishuGroup> {
  const groups = new Map<string, FeishuGroup>();
  //M 逐条解析并校验专项群规则（监听策略、决策阈值、中转方式及隐私信任标记）。
  for (const item of getEntries(own['groups'], 'groups')) {
    const chatId = item['chat_id'];
    const name = item['name'] ?? '';
    let listen = item['listen'] ?? 'mention';
    const relay = item['relay'] ?? 'direct';
    const trusted = item['trusted'] ?? false;
    const threshold = item['judge_threshold'];
    if (typeof chatId !== 'string' || chatId === '') throw new Error('feishu 插件的 groups 每项要写 chat_id');
    if (groups.has(chatId)) throw new Error(`feishu 插件的 groups 里 ${chatId} 写了两次`);
    if (typeof name !== 'string') throw new Error(`feishu 插件 groups 里 ${chatId} 的 name 要写成字符串`);

    //M 校验每日任务并从指定机器人的应用中确定唯一的发信账号。
    const daily = getGroupDaily(item['daily'], chatId, apps);
    if (daily !== undefined && item['listen'] === undefined) {
      //M 已启用日报的群默认也收没有 @ 的成员汇报。
      listen = 'all';
    }
    if (listen !== 'mention' && listen !== 'all' && listen !== 'judge') {
      throw new Error(`feishu 插件 groups 里 ${chatId} 的 listen 只能写 mention、all 或 judge`);
    }
    if (threshold !== undefined && (typeof threshold !== 'number' || threshold < 0 || threshold > 1)) {
      throw new Error(`feishu 插件 groups 里 ${chatId} 的 judge_threshold 要写 0 到 1 的数`);
    }
    if (relay !== 'direct' && relay !== 'model') {
      throw new Error(`feishu 插件 groups 里 ${chatId} 的 relay 只能写 direct 或 model`);
    }
    if (typeof trusted !== 'boolean') throw new Error(`feishu 插件 groups 里 ${chatId} 的 trusted 只能写 true 或 false`);
    const groupEntry: FeishuGroup = { chatId, name, listen, relay, trusted };
    if (threshold !== undefined) {
      groupEntry.judgeThreshold = threshold;
    }
    if (daily !== undefined) {
      groupEntry.daily = daily;
    }
    groups.set(chatId, groupEntry);
  }
  return groups;
}


/** 群日报入站配置的校验，匹配一个飞书发信账号并拆好本地时间。 */
function getGroupDaily(raw: unknown, chatId: string, apps: FeishuApp[]): FeishuGroup['daily'] {
  if (raw === undefined) return undefined;

  const where = 'feishu 群 ' + chatId + ' 的 daily';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(where + ' 要写 at、bot 和 prompt');
  }
  const daily = raw as Record<string, unknown>;
  const { at, bot, prompt } = daily;
  const requestedApp = daily['app_id'];
  if (typeof at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(at)) {
    throw new Error(where + ' 的 at 要写成本地时刻 HH:mm');
  }
  if (typeof bot !== 'string' || bot.trim() === '') throw new Error(where + ' 的 bot 要写机器人名');
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error(where + ' 的 prompt 要写非空文字');

  //M 共享应用同样接单，多个可用发信账号时由配置显式消除歧义。
  const candidates = apps.filter((app) => app.bot === bot || app.bots?.includes(bot));
  const selected = candidates.filter((app) => requestedApp === undefined || app.appId === requestedApp);
  if (selected.length !== 1) throw new Error(where + ' 要能确定一个属于该机器人的 app_id');

  //M 时间在配置入口拆开，定时器直接使用数值。
  const hour = Number(at.slice(0, 2));
  const minute = Number(at.slice(3));
  return { hour, minute, bot, appId: selected[0]!.appId, prompt: prompt.trim() };
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
  const feishu = new Feishu(ctx, checkConfig(ctx, config));
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

  //M 依次挂载飞书文件发送工具、云文档工具与定时发件箱监听，随插件同生命周期撤销。
  media.setup(feishu, ctx);
  doc.setup(feishu, ctx);
  outbox.setup(feishu, ctx);

  //M 直接订阅审批和进度通知，相关插件迟挂时也能收到更新。
  cards.setupApproval(feishu, ctx);
  cards.setupProgress(feishu, ctx);
}
