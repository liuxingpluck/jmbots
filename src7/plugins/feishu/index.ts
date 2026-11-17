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
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as api from './Api.ts';
import * as cards from './cards/Cards.ts';
import * as doc from './doc/Doc.ts';
import * as media from './Media.ts';
import * as outbox from './outbox/Outbox.ts';


/** 插件名。 */
export const name = 'feishu';

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
  /** 这个群登记的 listen: judge：只听的话记完由前台问决策模型要不要接话（bot-front-desk 读）；不是 judge 的群不写。 */
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
  return chatId === '' ? '' : `feishu:group:${chatId}`;
}


/** 名单里的一个飞书应用，校验后。 */
export interface FeishuApp {
  /** 应用号 app_id。 */
  appId: string;
  /** 应用密钥 app_secret：只交给 SDK，不打印、不进跟踪。 */
  appSecret: string;
  /** 这个应用对应哪个机器人。 */
  bot: string;
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
  /** 收到的本地时间，2026-11-17 10:30:05 的样子（textModule.clock）。 */
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
    if (typeof shaped?.message === 'string') return [typeof shaped.code === 'string' ? `${shaped.message}（${shaped.code}）` : shaped.message];
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
function outcomeOf(kind: string | undefined, listenOnly: boolean): string {
  if (kind === 'relay') return '转外部助手';
  if (kind !== undefined) return '交给会话';
  if (listenOnly) return '只记';
  return '别的插件处理掉了';
}


/** 现在的本地时间，日志用。 */
function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
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


/** 飞书渠道；外部发送复用实例方法。 */
export class Feishu {
  /** 渠道名。 */
  readonly name = 'feishu';

  /** 应用号 → 应用，照配置的先后。 */
  private readonly apps = new Map<string, AppState>();

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
    this.ctx.effect(() => this.ctx.bots.channel(this.name, (reply, session) => this.send(reply, session)));
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
  appsOf(bot: string): string[] {
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
    const row = this.ctx.resources.db.query(sql).get(id) as
      { app_id: string; chat_id: string; open_id: string; message_id: string } | null;
    if (row === null) return undefined;
    return { appId: row.app_id, chatId: row.chat_id, messageId: row.message_id, openId: row.open_id, chatType: 'p2p', customer: feishuCustomer('p2p', row.chat_id, row.open_id) };
  }

  /**
   * 这个应用的 SDK 客户端。
   * @param appId 应用号。
   * @returns 客户端。
   * @throws 没有这个应用时抛错。
   */
  client(appId: string): lark.Client {
    const app = this.apps.get(appId);
    if (app === undefined) {
      throw new Error(`没有飞书应用 ${appId}`);
    }
    return app.client;
  }

  /** 上传并发送本地文件，返回 message_id；多应用未指定 appId 时拒绝猜测。 */
  async sendFile(bot: string, chatId: string, filePath: string, options: SendFileOptions = {}): Promise<string> {
    const apps = this.appsOf(bot);
    const appId = options.appId ?? (apps.length === 1 ? apps[0] : undefined);
    if (!appId || !apps.includes(appId)) throw new Error('请指定属于该机器人的飞书 appId');
    if (!chatId) throw new Error('发送文件需要 chatId');
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
    this.ctx.resources.db.query("DELETE FROM feishu_seen WHERE kind = 'in' AND at < ?").run(Date.now() - SEEN_KEEP_MS);
    for (const app of this.apps.values()) {
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
        this.mark(app, '已连上', true);
        void this.findSelf(app);
      },
      onReconnecting: () => {
        this.mark(app, '断线重连中', false);
      },
      onReconnected: () => {
        this.mark(app, '已重连', true);
      },
      onError: (error) => {
        this.mark(app, `出错 ${error.message}`, false);
      },
    });
    app.ws = ws;
    try {
      await ws.start({ eventDispatcher: dispatcher });
    } catch (error) {
      this.mark(app, `出错 ${textModule.messageOf(error)}`, false);
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
    const line = `${now()} 飞书 ${app.config.appId}（${app.config.bot}）${state}`;
    if (connected) console.log(line);
    else console.error(line);

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
      const info = await api.call('查机器人信息', () => app.client.request<{ code?: number; bot?: { open_id?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      }));
      app.botOpenId = info.bot?.open_id;
    } catch (error) {
      console.error(`${now()} 飞书 ${app.config.appId} 没查到机器人自己的 open_id（群里有 @ 就回）：${textModule.messageOf(error)}`);
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
    const known = this.chats.get(chatId);
    if (known !== undefined && Date.now() - known.at < CHAT_NAMES_MS) return known;

    const found: ChatNames = { name: '', members: new Map(), at: Date.now() };
    try {
      const chat = await api.call('查群信息', () => app.client.request<{ data?: { name?: string } }>({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${chatId}`,
      }));
      found.name = chat.data?.name ?? '';

      const members = await api.call('查群成员', () => app.client.request<{ data?: { items?: { member_id?: string; name?: string }[] } }>({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${chatId}/members`,
        params: { member_id_type: 'open_id', page_size: 100 },
      }));
      for (const member of members.data?.items ?? []) {
        if (member.member_id !== undefined && member.name !== undefined) found.members.set(member.member_id, member.name);
      }
    } catch (error) {
      console.error(`${now()} 飞书 ${app.config.appId} 没查到群 ${chatId} 的名字（用群号、open_id 后 6 位代替）：${textModule.messageOf(error)}`);
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
    const app = this.apps.get(appId);
    if (app === undefined) return;
    const message = data.message;
    const db = this.ctx.resources.db;

    //G 重推的（同一个消息号已经收过）→ 不管。
    const inserted = db.query('INSERT OR IGNORE INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)')
      .run(message.message_id, appId, 'in', Date.now());
    if (inserted.changes === 0) {
      //T 跟踪：重复的消息，去重挡掉。
      const vars = { 应用: appId, 消息: message.message_id };
      this.ctx.emit('trace', 'Feishu.onMessage', '同一条消息飞书又推了一次，不管', 'INSERT OR IGNORE feishu_seen', vars);
      return;
    }

    //M 群里有没有 @ 机器人。机器人自己的 open_id 没查到时，有人被 @ 就算。私聊算 @ 了。
    const mentions = message.mentions ?? [];
    const group = message.chat_type !== 'p2p';
    const self = app.botOpenId;
    const atMe = !group || (self === undefined ? mentions.length > 0 : mentions.some((item) => item.id.open_id === self));

    //M 换成文字，去掉 @ 的占位符（@_user_1 这种）。丢掉的也要记进流水，所以先换。
    const described = media.describe(message.message_type, message.content);
    let body = described.text;
    for (const mention of mentions) {
      body = body.replaceAll(mention.key, '');
    }

    //M 认人、认群：config 里登记的名字优先；群名、人名没登记的，群里再去飞书查（查不到就不写）。
    const openId = data.sender.sender_id?.open_id ?? '';
    const person = this.config.people.get(openId);
    const registered = group ? this.config.groups.get(message.chat_id) : undefined;
    let chatName = registered?.name ?? '';
    let senderName = person?.name ?? '';
    if (group && (chatName === '' || senderName === '')) {
      const names = await this.chatNames(app, message.chat_id);
      chatName = chatName || names.name;
      senderName = senderName || (names.members.get(openId) ?? '');
    }

    //M 来往流水的这一行：最后怎么处理的到出口再填（logContact）。
    const contact: Omit<Contact, 'outcome'> = {
      at: textModule.clock(Date.now(), 'date'), app: appId, chatType: message.chat_type, chatId: message.chat_id, chatName,
      openId, sender: senderName, atMe, text: textModule.clip(body.trim(), 80),
    };

    //G 群里没 @ 机器人：登记成 listen: all 的群标成只听照样交下去（外部助手前缀开头的 relay 照转，别的前台只记、不回）；
    //G   别的群丢掉。
    const listenOnly = !atMe;
    if (listenOnly && registered?.listen !== 'all' && registered?.listen !== 'judge') {
      this.logContact(contact, '丢了');

      //T 跟踪：群里没 @ 机器人。
      const vars = { 应用: appId, 聊天: message.chat_id };
      this.ctx.emit('trace', 'Feishu.onMessage', '群里这条没 @ 机器人，不回', 'atMe === false', vars);
      return;
    }

    if (message.chat_type === 'p2p' && openId !== '') {
      const sql = 'INSERT INTO feishu_p2p (app_id, chat_id, open_id, message_id, at) VALUES (?, ?, ?, ?, ?)'
        + ' ON CONFLICT(app_id) DO UPDATE SET chat_id = excluded.chat_id, open_id = excluded.open_id,'
        + ' message_id = excluded.message_id, at = excluded.at';
      db.query(sql).run(appId, message.chat_id, openId, message.message_id, Date.now());
    }
    const address: FeishuAddress = {
      appId,
      chatId: message.chat_id,
      messageId: message.message_id,
      openId,
      chatType: message.chat_type,
      customer: feishuCustomer(message.chat_type, message.chat_id, openId),
      ...roleFields(person, this.ctx.resources.dir('guests', GUEST_DIR)),
    };
    if (chatName !== '') address.chatName = chatName;
    if (senderName !== '') address.senderName = senderName;
    if (listenOnly) address.listenOnly = true;
    //G listen: judge 的群：不 @ 的话带上 judge，前台记完去问决策模型；阈值登记了才写。
    if (listenOnly && registered?.listen === 'judge') address.judge = true;
    if (listenOnly && registered?.listen === 'judge' && registered.judgeThreshold !== undefined) address.judgeThreshold = registered.judgeThreshold;
    if (registered !== undefined) address.relay = registered.relay;
    //M 群受不受信：按群号查 groups 写进地址，prompt、memory、前台看它决定带不带私人记忆。
    if (registered !== undefined) address.trusted = registered.trusted;

    //T 跟踪：飞书收到一条消息。
    const vars = { 应用: appId, 机器人: app.config.bot, 类型: message.message_type, 聊天: message.chat_type, 只听: listenOnly };
    this.ctx.emit('trace', 'Feishu.onMessage', '飞书收到一条消息，换成文字交给机器人', 'this.ctx.bots.receive(this.name, bot, text, address)', vars);

    try {
      //M 挂“敲键盘”表情，告诉用户收到了；挂不上只打日志。只听的不挂：大多不回，挂了撤不掉。
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
        console.error(`${now()} 飞书：表情没挂上：${textModule.messageOf(error)}`);
      }

      const more = await media.related(this, appId, {
        messageId: message.message_id,
        parentId: message.parent_id || message.root_id,
        type: message.message_type,
      });

      //M 资源一个个下载，存进机器人工作区；下不来的写明原因。
      const paths: string[] = [];
      const failed: string[] = [];
      for (const resource of [...described.resources, ...more.resources]) {
        try {
          const content = await media.download(this, appId, resource.messageId ?? message.message_id, resource);
          const saved = this.ctx.bots.saveFile(app.config.bot, resource.name, content);
          paths.push(/\s/u.test(saved) ? `@"${saved}"` : `@${saved}`);
        } catch (error) {
          failed.push(`[${resource.name} 没下载下来：${textModule.messageOf(error)}]`);
        }
      }
      const parts = [more.quote, body.trim(), more.forwarded, paths.join(' '), failed.join('\n')];
      const text = parts.filter((part) => part !== '').join('\n') || '[空消息]';
      await this.ctx.bots.receive(this.name, app.config.bot, text, address);

      //M 看是哪种会话接的，记进流水。
      const kind = this.takenBy(message.message_id);
      this.logContact(contact, address.judged ?? outcomeOf(kind, listenOnly));

      //G 被别的插件处理掉了（比如 approval 认出“同意 3”），没有会话接这条 → 回话不会来，表情现在就撤。
      if (address.typingReaction !== undefined && kind === undefined) {
        await this.untype(address);
      }
    } catch (error) {
      const said = textModule.messageOf(error);
      this.logContact(contact, `没处理成：${said}`);
      console.error(`${now()} 飞书：消息 ${message.message_id} 没处理成：${said}`);
      try {
        await this.sendText(address, `这条消息没处理成：${said}`);
        await this.untype(address);
      } catch (again) {
        console.error(`${now()} 飞书：“没处理成”也没发出去：${textModule.messageOf(again)}`);
      }
    }
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
      fs.appendFileSync(this.contactsFile(), `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      console.error(`${now()} 飞书：来往流水没写进去：${textModule.messageOf(error)}`);
    }
  }

  /**
   * 最近的来往流水，接口 GET /api/feishu/contacts 用。
   * @param limit 最多几条。
   * @returns 新的在前。
   */
  contacts(limit: number): Contact[] {
    const file = this.contactsFile();
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit).reverse().map((line) => JSON.parse(line) as Contact);
  }

  /** @returns 来往流水文件的绝对路径（文件夹没有就建）。 */
  private contactsFile(): string {
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
    const p2p = chatId !== '' && this.ctx.resources.db.query('SELECT 1 FROM feishu_p2p WHERE app_id = ? AND chat_id = ?').get(appId, chatId) !== null;
    const address: FeishuAddress = { appId, chatId, messageId: cardId, openId, chatType: p2p ? 'p2p' : (chatId !== '' ? 'group' : ''), customer: feishuCustomer(p2p ? 'p2p' : '', chatId, openId, p2p) };
    //M 点卡片的人是哪一档：和收消息一样只看 people。
    Object.assign(address, roleFields(this.config.people.get(openId), this.ctx.resources.dir('guests', GUEST_DIR)));
    //M 群受不受信：和收消息一样按群号查 groups。
    const registered = p2p ? undefined : this.config.groups.get(chatId);
    if (registered !== undefined) address.trusted = registered.trusted;


    //T 跟踪：点了卡片按钮。
    const vars = { 应用: appId, 卡片: cardId, 按钮: JSON.stringify(value ?? {}) };
    this.ctx.emit('trace', 'Feishu.onCard', '飞书卡片上点了按钮，交给卡片那块', 'cards.onAction(...)', vars);
    try {
      const toast = await cards.onAction(this, address, cardId, (value ?? {}) as Record<string, unknown>);
      return { toast: toast ?? { type: 'info', content: '这个按钮没有用了' } };
    } catch (error) {
      return { toast: { type: 'error', content: `没处理成：${textModule.messageOf(error)}` } };
    }
  }

  /**
   * 基类要的：把会话的话发回飞书；这一轮结束了再撤“敲键盘”表情。出错只打日志（基类是 void this.send）。
   * @param reply 要说的话。
   * @param session 哪场会话。
   */
  protected async send(reply: string, session: Session): Promise<void> {
    const address = session.row.address as FeishuAddress | undefined;
    try {
      await this.sendText(address, this.withAt(address, reply));
    } catch (error) {
      console.error(`${now()} 飞书：会话 ${session.id} 的回话没发出去：${textModule.messageOf(error)}`);
    }
    if (session.row.state !== 'running' && address?.typingReaction !== undefined) {
      await this.untype(address);
    }
  }

  /**
   * 发文字，再发文字里 @"路径"、@路径 指的文件（存在的绝对路径文件才算），文字里换成「文件名」。
   * @param address 回话地址。
   * @param text 要发的话。
   * @throws 地址没有 chatId、文字发不出去时抛错；某个文件发不出去时补发一句说明，不抛。
   */
  async sendText(address: FeishuAddress | undefined, text: string): Promise<void> {
    if (address === undefined || typeof address.chatId !== 'string' || address.chatId === '') {
      throw new Error('飞书回话地址里没有 chatId，不知道发到哪');
    }
    const files: { token: string; file: string }[] = [];
    for (const match of text.matchAll(/@"([^"]+)"|@([^\s"]+)/gu)) {
      const file = match[1] ?? match[2] ?? '';
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
    for (const item of files) {
      try {
        await media.sendFile(this, address.appId, address.chatId, item.file, undefined, address.messageId);
      } catch (error) {
        const said = `「${baseName(item.file)}」没发出去：${textModule.messageOf(error)}`;
        console.error(`${now()} 飞书：${said}`);
        await media.message(this, address.appId, address.chatId, 'text', { text: said }, address.messageId);
      }
    }
  }

  /**
   * 这个群里认得的名字 → open_id：先流水里见过的说话人，再飞书群成员，最后 people 登记的（后写的盖前面的，所以登记的优先）。
   * @param address 回话地址：取群号。
   * @returns 名字 → open_id；名字空的不收。
   */
  private namesOf(address: FeishuAddress): Map<string, string> {
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
    if (!workspaceModule.isGroup(address) || !text.includes('@')) return text;

    //M 长名字先换，免得“陈”抢了“陈大管家”。
    const known = this.namesOf(address);
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
    if (address === undefined || !workspaceModule.isGroup(address) || address.openId === '' || reply.trim() === '') return reply;

    //M 话里已经 @ 了他（周小灵自己写的 @名字 也算）：不再加。
    const converted = this.mentioned(address, reply);
    const tag = `user_id="${address.openId}"`;
    if (converted.includes(tag)) return reply;

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
    const appId = textModule.textOf(address, 'appId');
    if (!this.apps.has(appId)) return;
    const contact: Omit<Contact, 'outcome'> = {
      at: textModule.clock(Date.now(), 'date'), app: appId, chatType: textModule.textOf(address, 'chatType'),
      chatId: textModule.textOf(address, 'chatId'), chatName: textModule.textOf(address, 'chatName'),
      openId: textModule.textOf(address, 'openId'), sender: textModule.textOf(address, 'senderName'), atMe: false,
      text: textModule.clip(text.trim(), 80),
    };
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
    const row = this.ctx.resources.db.query(sql).get(cardId) as { app_id: string } | null;
    if (row === null) {
      throw new Error(`查不到卡片 ${cardId} 是哪个飞书应用发的`);
    }
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
      const client = this.client(address.appId);
      await api.call('撤表情', () => client.im.v1.messageReaction.delete({
        path: { message_id: address.messageId, reaction_id: reactionId },
      }));
    } catch (error) {
      console.error(`${now()} 飞书：表情没撤掉：${textModule.messageOf(error)}`);
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
  const own = (typeof written === 'object' && written !== null ? written : {}) as Record<string, unknown>;
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
    const item = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const where = `channels.feishu 第 ${String(index + 1)} 项`;
    const appId = item['app_id'];
    const appSecret = item['app_secret'];
    const bot = item['bot'];
    if (typeof appId !== 'string' || appId === '') throw new Error(`${where} 要写非空的 app_id`);
    if (typeof appSecret !== 'string' || appSecret === '') throw new Error(`${where} 要写非空的 app_secret`);
    if (typeof bot !== 'string' || ctx.bots.get(bot) === undefined) {
      throw new Error(`${where} 的 bot 要写机器人名单里有的名字`);
    }
    if (apps.some((app) => app.appId === appId)) throw new Error(`${where} 的 app_id 和前面的重了`);
    apps.push({ appId, appSecret, bot });
  }
  return { domain: domain.replace(/\/+$/u, ''), apps, people: peopleOf(ctx, own), groups: groupsOf(own) };
}


/**
 * 一张登记清单（people、groups）：不写是空的，写了要是对象的清单。
 * @param value 配置里写的。
 * @param key 哪一项，报错用。
 * @returns 每项当对象读。
 */
function entriesOf(value: unknown, key: string): Record<string, unknown>[] {
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
function peopleOf(ctx: cordis.Context, own: Record<string, unknown>): Map<string, FeishuPerson> {
  const people = new Map<string, FeishuPerson>();
  for (const item of entriesOf(own['people'], 'people')) {
    const openId = item['open_id'];
    const name = item['name'];
    const owner = item['owner'] ?? false;
    if (typeof openId !== 'string' || openId === '' || typeof name !== 'string' || name === '') {
      throw new Error('feishu 插件的 people 每项要写 open_id 和 name');
    }
    if (typeof owner !== 'boolean') throw new Error(`feishu 插件 people 里 ${name} 的 owner 要写 true 或 false`);
    if (people.has(openId)) throw new Error(`feishu 插件的 people 里 ${openId} 写了两次`);

    //M 哪一档：写了 role 照 role；旧写法 owner: true 是本人；都没写是 guest。
    const role = item['role'] ?? (owner ? 'owner' : 'guest');
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
      const written = item['dir'] ?? (path.basename(name) === name && name !== '..' ? path.join('guests', name) : path.join('guests', GUEST_DIR));
      if (typeof written !== 'string' || written === '') throw new Error(`feishu 插件 people 里 ${name} 的 dir 要写目录`);
      dir = path.resolve(ctx.resources.root, written);
      fs.mkdirSync(dir, { recursive: true });
    }
    people.set(openId, { openId, name, role: role as FeishuRole, dir });
  }

  //M 旧写法：relay 插件配置的 owner_open_ids。people 里登记过的照 people，没登记的补成本人。
  const relay = ctx.resources.config.plugins.find((entry) => entry.name === 'relay');
  const legacy = textModule.fieldOf(relay?.config, 'owner_open_ids') ?? [];
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
function groupsOf(own: Record<string, unknown>): Map<string, FeishuGroup> {
  const groups = new Map<string, FeishuGroup>();
  for (const item of entriesOf(own['groups'], 'groups')) {
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
    groups.set(chatId, { chatId, name, listen, relay, trusted, ...(threshold === undefined ? {} : { judgeThreshold: threshold }) });
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
  const feishu = new Feishu(ctx, checkConfig(ctx, config));
  //M 挂成服务：别的插件用 ctx.get('feishu') 调 sendFile，不要 import 本文件的函数。
  ctx.provide('feishu', feishu);

  //M http 挂了（写在 feishu 前面）才有来往流水的接口：GET /api/feishu/contacts?limit=（默认 50，最多 1000），新的在前。
  const http = ctx.get('http');
  if (http !== undefined) {
    http.app.get<{ Querystring: { limit?: string } }>('/api/feishu/contacts', (request) => {
      const limit = textModule.numberOf(request.query.limit, 50, 1, 1000);
      return { items: feishu.contacts(limit) };
    });
  }

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
