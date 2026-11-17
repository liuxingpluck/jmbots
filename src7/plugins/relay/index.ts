/**
 * relay：一个不调模型的机器人，把用户的话转给外部助手，等它回信再回给用户。
 * 接哪些外部助手全看配置 helpers：每项一个（名字、前缀、webhook），第一个是默认的。代码里不写死任何助手。
 * 用户在网页、飞书上给标了 relay 的机器人发话，或者在任何机器人里以某个助手的前缀开头：
 *   direct 模式：不调模型。每一轮写一行进收件箱 inbox.jsonl，当场回“已转给 <助手>（#号），等回复”，这一轮就结束。
 *               外部助手回信（写 replies.jsonl 一行，或 POST /api/relay/reply），本插件再推一次这场会话，
 *               把回信当回答填进去，渠道照当时记的渠道和地址发回给用户，会话记录里也多一条 assistant。
 *   model 模式：照常走模型，模型用工具 relay_send 转话（只转给默认助手）；回信作为一句新的用户话交回那场会话，由模型转述。
 *   机器人没写 relay 时，飞书插件配置 groups 里登记了 relay: model 的群也算 model（飞书写进回话地址的 relay，见 sessionMode）。
 * 每条收件记下转给了哪个助手、谁在哪说的（owner、sender、chat、chatName）：回执、回信前面的署名、推不推 webhook，都照它。
 * 不调模型靠的是骨架现成的口子：插件在 session/request 里填了 request.answer，会话就不调 chat()。不用改骨架。
 * 配了 webhook_url 的助手，转出时推一次；没配的自己来看：读收件箱文件，或 GET /api/relay/inbox?helper=名字&since=号。
 * 收件带 files：话里 @路径 写的附件（渠道用 bots.saveFile 存进工作区的），换成相对运行时目录的路径，见 filesOf。
 * 设计：docs/src7插件设计/relay.md；给外部助手看的用法：docs/src7插件设计/进度/relay_用法.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Chat.ts';
import type { Session } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as textModule from '../../utils/Text.ts';
import type { Origin, ReceiveEvent } from '../bots/index.ts';
import * as routesModule from './Routes.ts';


/** 插件名。 */
export const name = 'relay';

/** 用到的服务。http、feishu 是可选的：用到时 ctx.get 现取，没挂就只走文件回信、发不了飞书文件。 */
export const inject = ['resources', 'tools', 'sessions', 'bots'];


/**
 * 按客户号认聊天种类：飞书群的客户号是 feishu:group:<chat_id>（feishu/index.ts 的 feishuCustomer），别的都算私聊。
 * @param customer 会话或回话地址里的客户号；没有给 ''。
 * @returns group 或 p2p。
 */
function chatOf(customer: string): ChatKind {
  return customer.startsWith('feishu:group:') ? 'group' : 'p2p';
}


/**
 * 话开头连续的附件标记和空白（prefixed 认前缀前跳过）。标记照 feishu/Media.ts 的 describe 和图文消息的写法：
 * [图片]、[表情包]、[文件]、[语音…]、[视频…]；还有渠道存附件后写的 @"绝对路径"、@绝对路径（feishu/index.ts:544）。
 */
const ATTACHMENT_MARKS = /^(?:\s|\[(?:图片|表情包|文件|语音[^\]]*|视频[^\]]*)\]|@"[^"]*"|@(?:[A-Za-z]:[\\/]|\/)\S*)*/u;


/** 名单项里 relay 的两种写法：direct 不调模型直接转；model 照常走模型，模型用 relay_send 转。 */
export type RelayMode = 'direct' | 'model';

/** 聊天种类：p2p 私聊（网页、接口也算），group 群聊。 */
export type ChatKind = 'p2p' | 'group';


/** 一个外部助手。 */
export interface Helper {
  /** 话里怎么称呼它；收件里记的也是这个名字。 */
  name: string;
  /** 任何机器人里以这些开头的话转给它，进这个机器人的 relay 会话（kind relay），不交给模型。不分大小写，规则见 prefixed。 */
  prefixes: string[];
  /** 转出时 POST 到这里（它的 webhook）；空串不推，它自己来读收件箱。 */
  webhookUrl: string;
  /** POST 时的鉴权头原文；发送前由 webhookAuthHeaders 收成请求头（可带 “Authorization:” 前缀）。 */
  webhookHeader: string;
}


/** apply 校验好以后给 Relay 的东西。 */
export interface RelayConfig {
  /** 多久没回提醒一次，分钟。 */
  remindMinutes: number;
  /** 多久没回就说“先放下”，分钟；之后回了照样送到。 */
  expireMinutes: number;
  /** 多久读一次 replies.jsonl，秒。 */
  pollSeconds: number;
  /** 外部助手。第一个是默认的：direct 机器人的平常话、relay_send、主动发没写 helper 的，都归它。 */
  helpers: [Helper, ...Helper[]];
  /** 这些机器人的话全部直接转（等于名单项写 relay: direct）。 */
  bots: string[];
}


/** 一条收件：inbox.jsonl 里一行、GET /api/relay/inbox 里一项，都是这个样子。 */
export interface InboxItem {
  /** 收件号，全局从 1 往上数；回信靠它对回那条消息。 */
  id: number;
  /** 哪个机器人收到的。 */
  bot: string;
  /** 转给了哪个外部助手。 */
  helper: string;
  /** 哪场会话。 */
  session: string;
  /** 用户从哪个渠道说的：http（网页、接口）、feishu…… */
  channel: string;
  /** 是不是用户本人说的：渠道在回话地址里写了 owner: true（飞书照插件配置的 people 判断）。 */
  owner: boolean;
  /** 说话人是哪一档：飞书照插件配置 people 写的 owner、builder、guest；别的渠道、旧收件是 ''。外部助手照它定接不接活。 */
  role: string;
  /** builder 的目录（他的活往这里写）；别的档、别的渠道是 ''。 */
  workspace: string;
  /** 说话人：渠道给的名字（飞书先用 people 登记的，再用飞书查到的），没给用 open_id 的后 6 位；都没有（网页、接口）是 ''。 */
  sender: string;
  /** 在哪说的：p2p 私聊（网页、接口也算），group 群聊。 */
  chat: ChatKind;
  /** 群名（飞书先用 groups 登记的，再用查到的），都没有用 chat_id；私聊是 ''。 */
  chatName: string;
  /** 用户的话；一轮里排着的几句用空行连起来。 */
  text: string;
  /** 这条带的附件（图片、文件）：相对运行时目录、用 / 分隔，如 bots/周小灵/workspace/inbox/2026-11-16/093005123_a.png；没有是 []。 */
  files: string[];
  /** 什么时候转出的，本地时间 2026-11-14 06:30:05 的样子。 */
  at: string;
  /** 同上，毫秒时间戳。 */
  atMs: number;
  /** pending 没回完；replied 回完了；expired 太久没回先放下了（之后回了照样送到，变 replied）。文件里永远是写入时的 pending。 */
  state: 'pending' | 'replied' | 'expired';
  /** 回完的时间（只有接口给）；没回完是 null。 */
  repliedAt?: string | null;
}


/** 表 relay_items 的一行。 */
interface ItemRow {
  id: number;
  bot: string;
  helper: string;
  session_id: string;
  channel: string;
  /** 回话地址的 JSON；没有是 'null'。 */
  address: string;
  /** 1 是用户本人说的。 */
  owner: number;
  sender: string;
  chat: ChatKind;
  chat_name: string;
  text: string;
  /** 毫秒时间戳。 */
  at: number;
  /** 这一轮最后一句用户话的时间：防重启后重复登记；relay_send 转的是 null。 */
  last_msg_at: number | null;
  state: InboxItem['state'];
  reminded: number;
  replied_at: number | null;
}


/** 表 relay_replies 的一行。 */
interface ReplyRow {
  id: number;
  item_id: number;
  session_id: string;
  text: string;
  done: number;
  at: number;
  delivered: number;
  via: string;
}


/** 查超时隔多久查一次，毫秒。 */
const CHECK_MS = 30_000;

/** relay_items 建表以后加的栏：老库启动时补上（见构造函数），新库也走这一条，建表语句里不再写。 */
const ADDED_COLUMNS = [
  { name: 'helper', type: "TEXT NOT NULL DEFAULT ''" },
  { name: 'owner', type: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'sender', type: "TEXT NOT NULL DEFAULT ''" },
  { name: 'chat', type: "TEXT NOT NULL DEFAULT 'p2p'" },
  { name: 'chat_name', type: "TEXT NOT NULL DEFAULT ''" },
];

/** 收件里“谁、在哪说的”那几项。 */
type Speaker = Pick<InboxItem, 'owner' | 'role' | 'workspace' | 'sender' | 'chat' | 'chatName'>;

/** 给 /flow/ 运行时变量那组（stateForFlow）的键的中文解释。 */
const FLOW_NOTES: Record<string, string> = {
  pending: '收件里待回几条',
  lastId: '最近一条的号',
  helpers: '各外部助手',
  name: '助手名字',
  prefixes: '收话的前缀',
  pushes: '转出时推不推送（webhook）',
  bots: '直接转的机器人',
};

/** 毫秒时间戳 → 本地时间 2026-11-14 06:30:05（sv-SE 这个地区的写法正好是它）。 */
function local(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE');
}



/**
 * 把配置里的 webhook_header 收成请求头。空的就不带头。
 * 写了 “Authorization: 值”（不区分大小写）就只用后面的值做 Authorization；
 * 写了别的 “头名: 值” 就按那个头名发；只写值就当 Authorization 的值。
 * 不把值写进日志。
 * @param header 配置里的原文。
 * @returns 要附上的请求头。
 */
function webhookAuthHeaders(header: string): Record<string, string> {
  const raw = header.trim();
  if (raw === '') return {};
  const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*([\s\S]*)$/u.exec(raw);
  if (match === null || match[1] === undefined) return { Authorization: raw };
  const name = match[1];
  const value = (match[2] ?? '').trim();
  return name.toLowerCase() === 'authorization' ? { Authorization: value } : { [name]: value };
}


/** relay 插件本体。只由 apply 来建。 */
export class Relay {
  /**
   * 建表；给每个 relay 机器人建好 integrations/relay/<机器人>/；挂三个监听；http 在就登记两条接口；
   * 有 model 模式的机器人就登记工具 relay_send；开两个定时器（读回信文件、查超时），拔掉插件时关。
   * @param ctx Cordis 给这个插件的 ctx（大白话：插件拿到的“遥控器”，通过它登记的监听、定时器，拔插件时一起撤掉）。
   * @param config 校验过的配置。
   * 副作用：建表、建目录、登记接口和工具。
   */
  constructor(private readonly ctx: cordis.Context, readonly config: RelayConfig) {
    const db = this.ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS relay_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + ' session_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,'
      + " last_msg_at INTEGER, state TEXT NOT NULL DEFAULT 'pending', reminded INTEGER NOT NULL DEFAULT 0, replied_at INTEGER)");
    db.exec('CREATE TABLE IF NOT EXISTS relay_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,'
      + ' session_id TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL, at INTEGER NOT NULL,'
      + ' delivered INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL)');

    //M 缺的栏补上（ADDED_COLUMNS）。旧收件：helper 都算默认助手的；谁、在哪说的照它记的回话地址补。
    //  加栏和填值放进一个事务：中途断了就一起作废，下次启动还会再补，不会留下没填的收件。
    const columns = new Set((db.query('PRAGMA table_info(relay_items)').all() as { name: string }[]).map((column) => column.name));
    const missing = ADDED_COLUMNS.filter((column) => !columns.has(column.name));
    if (missing.length > 0) {
      const addColumns = db.transaction(() => {
        for (const column of missing) {
          db.exec(`ALTER TABLE relay_items ADD COLUMN ${column.name} ${column.type}`);
        }
        if (!columns.has('helper')) db.query('UPDATE relay_items SET helper = ?').run(this.config.helpers[0].name);
        if (!columns.has('sender')) this.fillSpeakers();
      });
      addColumns();
    }

    //M 先把文件夹和两个文件建好，外部助手一看就知道往哪写。
    for (const bot of this.ctx.bots.list()) {
      if (this.modeOf(bot.name) !== undefined) this.dirOf(bot.name);
    }

    //M 三个监听。ctx.on 挂在本插件的 ctx 上：插件被拔掉时 Cordis 自动撤掉。
    //M   bot/receive、session/request 是“挨个问”（serial），先后照 config.yaml 里 plugins 写的先后。
    this.ctx.on('bot/receive', (event) => {
      this.onReceive(event);
    });
    this.ctx.on('session/request', (request) => {
      this.onRequest(request);
    });
    this.ctx.on('session/change', (session) => {
      this.onChange(session);
    });

    //M http 是可选的：挂了（要写在 relay 前面）才登记两条接口；没挂就只有文件这条回信路。
    const http = this.ctx.get('http');
    if (http !== undefined) routesModule.routes(http, this);

    //M flow 是可选的：挂了就给 /flow/ 的「运行时变量」露几个数（不带用户的话、地址），flow 前后挂都接得上。
    void this.ctx.inject(['flow'], (sub) => {
      sub.effect(() => sub.flow.state('relay', () => this.stateForFlow(), FLOW_NOTES));
    });

    //M relay_send 一直登记：哪场会话能用要到每一步才知道（机器人写了 relay: model，或者飞书群登记了 relay: model），
    //M   不能用的由 offerTool 每一步从工具里拿掉，run 里再查一次。
    this.registerTool();

    //M 两个定时器。ctx.effect 登记“开了什么、拔掉时怎么关”：Cordis 拔这个插件时调返回的函数。
    this.ctx.effect(() => {
      const poll = setInterval(() => {
        this.pollFile();
      }, this.config.pollSeconds * 1000);
      const late = setInterval(() => {
        this.checkLate();
      }, CHECK_MS);
      return () => {
        clearInterval(poll);
        clearInterval(late);
      };
    });

    //M 都挂完了（ready）：上次没送出的回信送一遍，文件里积着的回信读一遍。
    this.ctx.on('ready', () => {
      for (const row of this.query<{ session_id: string }>(
        'SELECT DISTINCT session_id FROM relay_replies WHERE delivered = 0', [])) {
        this.deliverSoon(row.session_id);
      }
      this.pollFile();
    });
  }

  /**
   * 老库补栏时，照每条收件记的回话地址补上谁、在哪说的（构造函数的事务里调）。
   * 副作用：改库。
   */
  private fillSpeakers(): void {
    for (const row of this.query<{ id: number; address: string }>('SELECT id, address FROM relay_items', [])) {
      const speaker = this.speakerOf(JSON.parse(row.address) as unknown);
      const values = [speaker.owner ? 1 : 0, speaker.sender, speaker.chat, speaker.chatName, row.id];

      this.run('UPDATE relay_items SET owner = ?, sender = ?, chat = ?, chat_name = ? WHERE id = ?', values);
    }
  }

  /**
   * 谁、在哪说的：只看渠道写在回话地址里的几项，收件和 webhook 推送共用。
   * 是不是本人、哪一档不在这里判断：飞书插件照 people 写进地址的 owner、role、workspace（旧收件的地址没有，算 false、''）。
   * @param address 回话地址（飞书的 FeishuAddress：owner、role、workspace、openId、chatId、customer、senderName、chatName）。
   * @returns owner、role、workspace、sender、chat、chatName；说明见 InboxItem。
   */
  private speakerOf(address: unknown): Speaker {
    const openId = textModule.textOf(address, 'openId');
    const chat = chatOf(textModule.textOf(address, 'customer'));
    //M 名字、群名飞书插件写了才有（登记的优先，再是查到的）；都没有用 open_id 后 6 位、chat_id。
    const sender = textModule.textOf(address, 'senderName') || openId.slice(-6);
    const groupName = textModule.textOf(address, 'chatName') || textModule.textOf(address, 'chatId');
    const chatName = chat === 'group' ? groupName : '';
    return {
      owner: textModule.fieldOf(address, 'owner') === true,
      role: textModule.textOf(address, 'role'),
      workspace: textModule.textOf(address, 'workspace'),
      sender,
      chat,
      chatName,
    };
  }

  /**
   * 给 /flow/ 看的运行时变量（flow 插件的 ctx.flow.state 现调）。
   * @returns 收件待回几条、各助手（名字、前缀、推不推 webhook）、最近一条的号、直接转的机器人；不带话、地址、webhook 地址。
   */
  private stateForFlow(): Record<string, unknown> {
    const pending = this.query<{ count: number }>("SELECT COUNT(*) AS count FROM relay_items WHERE state = 'pending'", []);
    const last = this.query<{ last: number | null }>('SELECT MAX(id) AS last FROM relay_items', []);
    //M 键是英文，中文解释在 FLOW_NOTES。
    return {
      pending: pending[0]?.count ?? 0,
      lastId: last[0]?.last ?? 0,
      helpers: this.config.helpers.map((helper) => ({
        name: helper.name,
        prefixes: helper.prefixes,
        pushes: helper.webhookUrl !== '',
      })),
      bots: this.config.bots,
    };
  }

  /**
   * 这个机器人是不是 relay 机器人、哪种。名单项的 relay 在 apply 里校验过。
   * @param bot 机器人名。
   * @returns 名单项 relay 写的 direct / model；没写、没这个机器人是 undefined。
   */
  modeOf(bot: string): RelayMode | undefined {
    if (this.config.bots.includes(bot)) return 'direct';
    return this.ctx.bots.get(bot)?.config['relay'] as RelayMode | undefined;
  }

  /**
   * 这场会话怎么转：先看机器人；机器人没写，飞书群登记了 relay: model（飞书插件写进回话地址的 relay）就是 model。
   * 群登记的 direct 和没登记一样，只认前缀，所以不算。
   * @param session 会话。
   * @returns direct / model；都不是是 undefined。
   */
  private sessionMode(session: Session): RelayMode | undefined {
    const row = session.row;
    const byBot = this.modeOf(row.bot);
    if (byBot !== undefined) return byBot;
    return textModule.fieldOf(row.address, 'relay') === 'model' ? 'model' : undefined;
  }

  /**
   * 这句话以哪个外部助手的前缀开头。前缀去掉两头空白、不分大小写比；
   * 后面紧跟的是句尾、汉字，或者不是字母数字下划线（空白、中英文标点等）才算：cc 你好、CC你好、Cc，你好 算，ccc、cctv、cc1 不算。
   * 开头的附件、引用块和空白先跳过，再认正文的前缀；只处理识别用的副本，收件保留完整原话。
   * @param text 用户的话。
   * @returns 那个助手；都不是是 undefined。
   */
  private prefixed(text: string): Helper | undefined {
    //M 先跳过引用前的附件标记和空白。
    let said = text.replace(ATTACHMENT_MARKS, '');

    //M 引用里也可能有【标题】，数清配对的括号后再跳过，避免把引用中的 cc 当成正文。
    if (said.startsWith('【回复的消息：')) {
      let depth = 0;
      for (let index = 0; index < said.length; index += 1) {
        const mark = said[index];
        if (mark === '【') depth += 1;
        if (mark === '】') depth -= 1;
        if (depth !== 0) continue;

        said = said.slice(index + 1).replace(ATTACHMENT_MARKS, '');
        break;
      }
    }

    const hits = (prefix: string): boolean => {
      const head = prefix.trim();
      if (said.slice(0, head.length).toLowerCase() !== head.toLowerCase()) return false;

      const next = said.charAt(head.length);
      return next === '' || /\p{Script=Han}/u.test(next) || !/[\p{L}\p{N}_]/u.test(next);
    };
    return this.config.helpers.find((helper) => helper.prefixes.some(hits));
  }

  /**
   * 这场会话是不是“直接转”的：所在聊天开了 direct 的机器人的前台会话，或者前缀触发开的 relay 会话。小会话不算。
   * @param session 会话。
   * @returns 是不是。
   */
  private direct(session: Session): boolean {
    const row = session.row;
    return row.parent === undefined && (row.kind === 'relay' || this.sessionMode(session) === 'direct');
  }

  /**
   * 列收件，接口 GET /api/relay/inbox 用。状态以库为准。
   * @param since 只给号比它大的。
   * @param limit 最多几条。
   * @param only 只看哪个机器人（bot）、哪种状态（state）、转给哪个助手（helper）的；是 undefined 的那项不管。
   * @returns 收件（号从小到大），和库里最大的收件号。
   */
  list(
    since: number,
    limit: number,
    only: Record<'bot' | 'state' | 'helper', string | undefined>,
  ): { items: InboxItem[]; last: number } {
    let sql = 'SELECT * FROM relay_items WHERE id > ?';
    const values: (string | number)[] = [since];
    for (const column of ['bot', 'state', 'helper'] as const) {
      const value = only[column];
      if (value === undefined) continue;
      sql += ` AND ${column} = ?`;
      values.push(value);
    }
    sql += ' ORDER BY id LIMIT ?';
    values.push(limit);
    const items = this.query<ItemRow>(sql, values).map((row) => this.view(row));
    const last = this.query<{ last: number | null }>('SELECT MAX(id) AS last FROM relay_items', [])[0]?.last ?? 0;
    return { items, last };
  }

  /**
   * 收下一条回信。两条回信路（replies.jsonl、POST /api/relay/reply）共用，外面进来的东西在这里校验一次。
   * @param input 回信：{ id: 收件号 | chat, text, done?（默认 true）, helper?（给 chat 时是谁主动发，不写是默认助手） }。
   * @param via 从哪条路来：file / http。
   * @param bot 文件那条路：是哪个机器人的 replies.jsonl；收件不是这个机器人的就不收。
   * @returns 收下以后的那条收件。
   * @throws routesModule.Failure：id 不是正整数、text 空、done 不是布尔、helper 不是接着的助手、写了 helper 却和收件的助手对不上 400；没有这个号 404。
   * 副作用：写库；done 时收件改成 replied；推那场会话把回信送出去。
   */
  accept(input: unknown, via: 'file' | 'http', bot?: string): InboxItem {
    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const helper = body['helper'] ?? this.config.helpers[0].name;
    if (typeof helper !== 'string' || !this.config.helpers.some((one) => one.name === helper)) {
      const names = this.config.helpers.map((one) => one.name).join('、');
      throw new routesModule.Failure(400, `helper 只能写接着的助手：${names}`);
    }

    //M 不给收件号、给 chat（飞书 chat_id / 微信 chat）：挂到这个助手在这个聊天最近一条收件上，没有就主动发。
    const chat = body['chat'];
    const chatBot = typeof body['bot'] === 'string' ? body['bot'] : undefined;
    const byChat = typeof chat === 'string' && chat !== '';
    const id = body['id'] ?? (byChat ? this.itemForChat(chat, chatBot, helper) : undefined);
    const text = body['text'];
    const done = body['done'] ?? true;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      throw new routesModule.Failure(400, 'id 要写成正整数（收件号），或者给 chat');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new routesModule.Failure(400, 'text 要写成非空的字符串');
    }
    if (typeof done !== 'boolean') {
      throw new routesModule.Failure(400, 'done 要写成 true 或 false，不写是 true');
    }
    const file = body['file'];
    if (file !== undefined && (typeof file !== 'string' || file === '')) {
      throw new routesModule.Failure(400, 'file 要写成文件路径（相对数据目录，或绝对路径）');
    }
    const item = this.itemOf(id);
    if (item === undefined) {
      throw new routesModule.Failure(404, `没有这个收件号：${String(id)}`);
    }
    if (bot !== undefined && item.bot !== bot) {
      throw new routesModule.Failure(400, `收件 #${String(id)} 是 ${item.bot} 的，不是 ${bot} 的`);
    }
    if (body['helper'] !== undefined && item.helper !== helper) {
      throw new routesModule.Failure(400, `收件 #${String(id)} 是转给 ${item.helper} 的，helper 写的是 ${helper}`);
    }

    //M reply_to（飞书消息号）：回话挂在那条下面——改收件记的地址里的 messageId，飞书插件按它用回复接口发。
    const replyTo = body['reply_to'];
    if (typeof replyTo === 'string' && replyTo !== '') {
      this.run("UPDATE relay_items SET address = json_set(address, '$.messageId', ?) WHERE id = ? AND address LIKE '{%'", [replyTo, id]);
    }

    //M 记一条回信；done 就把收件改成 replied（放下了的也改，回了就算回完）。
    const now = Date.now();
    this.run('INSERT INTO relay_replies (item_id, session_id, text, done, at, via) VALUES (?, ?, ?, ?, ?, ?)',
      [id, item.session_id, text, done ? 1 : 0, now, via]);
    if (done) {
      this.run("UPDATE relay_items SET state = 'replied', replied_at = ? WHERE id = ?", [now, id]);
    }

    //T 跟踪：收到一条回信。
    const vars = { 收件号: id, 会话: item.session_id, 从哪来: via, 回完了: done, 字数: text.length };
    this.ctx.emit('trace', 'Relay.accept', `收到 ${item.helper} 的回信`, 'INSERT INTO relay_replies', vars);

    this.deliverSoon(item.session_id);
    if (typeof file === 'string') this.sendFile(this.itemOf(id) ?? item, file);
    return this.view(this.itemOf(id) ?? item);
  }

  /**
   * 响应 bot/receive：relay direct 机器人的消息，还没人定去向时，进这个客户的前台会话；
   * 别的、以及渠道标了只听的（listenOnly，飞书群里没 @ 机器人的话），以前缀开头的进这个客户的 relay 会话。每个客户一场，没有就开。
   * @param event 哪个机器人、哪条消息；把会话填进 event.session。
   */
  private onReceive(event: ReceiveEvent): void {
    //G 前面已经有人定了去向、处理掉了 → 不管。
    if (event.session !== undefined || event.handled === true) return;

    const bot = event.bot.name;
    const address = event.message.address;
    const customer = textModule.textOf(address, 'customer');
    //M direct 进前台会话；只听的话不整句转，和别的一样要以某个助手的前缀开头才进 relay 会话。都按客户分。
    const listenOnly = textModule.fieldOf(address, 'listenOnly') === true;
    let kind: 'front' | 'relay' = 'front';
    if (listenOnly || this.modeOf(bot) !== 'direct') {
      if (this.prefixed(event.message.text) === undefined) return;
      kind = 'relay';
    }

    const found = this.ctx.sessions.find({ bot, kind, ...(customer === '' ? {} : { customer }) })[0];
    event.session = found === undefined
      ? this.ctx.sessions.create({ bot, kind, ...(customer === '' ? {} : { customer }) })
      : this.ctx.sessions.open(found.id);
  }

  /**
   * 响应 session/request：direct 机器人的会话（不是小会话）一定填 request.answer，绝不落到真模型。
   * 有新话 → 登记收件，回“已转给”；没新话、有没送的回信 → 回信当回答；都没有 → 回一句“没有新消息”。
   * @param request 这一步的请求。
   */
  private onRequest(request: ChatRequest): void {
    const session = request.session;
    const row = session.row;
    if (!this.direct(session)) {
      this.offerTool(request);
      return;
    }

    //M 新话：最后一条 assistant 之后的用户话。这一轮新来的几句合成一条收件（同一步排着的几句才会合，平时一句一条）。
    const lastAnswer = row.messages.findLastIndex((message) => message.role === 'assistant');
    const fresh = row.messages.slice(lastAnswer + 1).filter((message) => message.role === 'user');
    const lastUser = fresh.at(-1);
    if (lastUser !== undefined) {
      //G 库里已经有这一轮（重启后接着跑）→ 不重复登记，照样回“已转给”。
      const known = this.query<{ id: number; helper: string }>(
        'SELECT id, helper FROM relay_items WHERE session_id = ? AND last_msg_at = ?',
        [session.id, lastUser.timestamp])[0];
      const text = fresh.map((message) => piAi.contentText(message.content)).join('\n\n');
      //M 以哪个助手的前缀开头就转给哪个；direct 机器人的平常话转给默认助手。
      const helper = this.prefixed(text) ?? this.config.helpers[0];
      const id = known?.id ?? this.register(session, helper, text, lastUser.timestamp);
      request.answer = this.said(row.bot, `已转给 ${known?.helper ?? helper.name}（#${String(id)}），等回复。`);
      return;
    }

    //M 回信：这场会话最早一条没送的。回话先换成那条收件当时的渠道和地址，再把回信当回答。
    const reply = this.query<ReplyRow>(
      'SELECT * FROM relay_replies WHERE session_id = ? AND delivered = 0 ORDER BY id LIMIT 1', [session.id])[0];
    if (reply !== undefined) {
      const item = this.itemOf(reply.item_id);
      if (item !== undefined) this.ctx.bots.route(session, this.originOf(item));
      this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [reply.id]);
      const helper = item?.helper ?? this.config.helpers[0].name;
      request.answer = this.said(row.bot, `${helper}：${reply.text}`);

      //T 跟踪：送出一条回信。
      const vars = { 收件号: reply.item_id, 会话: session.id, 渠道: row.channel ?? '（没有）', 字数: reply.text.length };
      this.ctx.emit('trace', 'Relay.onRequest', '回信当回答，送回当时那条消息', 'request.answer = said(reply.text)', vars);
      return;
    }

    //M 什么都没有（有人手动 run）也要填，绝不落到真模型。
    request.answer = this.said(row.bot, '（没有新消息，也没有新回信）');
  }

  /**
   * 走模型的前台、后台会话：是 model（机器人写了，或者飞书群登记了），就在系统提示词里说什么时候用 relay_send；
   * 不是就把 relay_send 从这一步的工具里拿掉（工具按会话种类登记，分不出是哪个群）。
   * @param request 这一步的请求；改它的 system、tools。
   */
  private offerTool(request: ChatRequest): void {
    const row = request.session.row;
    //G 小会话（压缩、总结这些）不管。
    if (row.kind !== 'front' && row.kind !== 'work') return;

    if (this.sessionMode(request.session) === 'model') {
      const where = chatOf(row.customer ?? '') === 'group' ? '这是群聊，可能有几个人在说话。' : '';
      request.system.push(`${where}${this.whenToRelay()}`);
      return;
    }
    request.tools = request.tools.filter((tool) => tool.name !== 'relay_send');
  }

  /**
   * 什么时候转给默认助手：工具说明和系统提示词共用这一段。
   * @returns 一段话。
   */
  private whenToRelay(): string {
    const helper = this.config.helpers[0].name;
    //M 前缀照配置写（去掉两头空白、去重），代码里不写死 cc。
    const heads = [...new Set(this.config.helpers.flatMap((one) => one.prefixes.map((prefix) => prefix.trim())))];
    const skip = heads.length === 0 ? '' : `以 ${heads.join('、')} 开头的话已经直接转给外部助手了，不用再转。`;
    return `聊到要查代码、定方案、改东西，或者问 jmbots 本身怎么做时，用 relay_send 把要点转给外部助手 ${helper}；`
      + `闲聊、打招呼不转。${skip}`;
  }

  /**
   * 响应 session/change：direct 会话一轮结束、还有没送的回信 → 再推一次。
   * @param session 状态刚变的会话。
   */
  private onChange(session: Session): void {
    if (session.row.state !== 'done' || !this.direct(session)) return; // 失败了不再推，免得一直重跑
    const left = this.query<{ id: number }>(
      'SELECT id FROM relay_replies WHERE session_id = ? AND delivered = 0 LIMIT 1', [session.id]);
    if (left.length > 0) this.deliverSoon(session.id);
  }

  /**
   * 把一场会话没送的回信送出去。
   * direct：推那场会话（setTimeout 隔开：这时候会话可能正在收尾，马上调 run 会直接返回；在转的，转完 session/change 会再来）。
   * model：每条回信作为一句新话交回那场会话（bot.hand），由模型转述。
   * @param sessionId 会话号。
   */
  private deliverSoon(sessionId: string): void {
    let session: Session;
    try {
      session = this.ctx.sessions.open(sessionId);
    } catch (error) {
      console.error(`relay：回信送不出去：${textModule.messageOf(error)}`);
      return;
    }
    const mode = this.sessionMode(session);

    if (this.direct(session)) {
      setTimeout(() => {
        void session.run();
      }, 0);
      return;
    }

    //G 机器人在这种聊天里已经不是 model 了 → 回信留在库里，不推（推了会去调真模型）。
    if (mode !== 'model') return;
    const bot = this.ctx.bots.get(session.row.bot);
    const replies = this.query<ReplyRow>(
      'SELECT * FROM relay_replies WHERE session_id = ? AND delivered = 0 ORDER BY id', [sessionId]);
    for (const reply of replies) {
      const item = this.itemOf(reply.item_id);
      this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [reply.id]);
      const helper = item?.helper ?? this.config.helpers[0].name;
      const text = `${helper} 回复（#${String(reply.item_id)}）：${reply.text}`;
      bot?.hand(text, item === undefined ? {} : this.originOf(item), sessionId);
    }
  }

  /**
   * 记一条收件：插表，追加一行 inbox.jsonl，这个助手配了 webhook 就推一次。
   * @param session 哪场会话；渠道、地址取它现在记的。
   * @param helper 转给哪个外部助手。
   * @param text 要转的话。
   * @param lastMsgAt 这一轮最后一句用户话的时间；relay_send 转的给 null。
   * @returns 收件号。
   * 副作用：写库、写文件、推 webhook。
   */
  private register(session: Session, helper: Helper, text: string, lastMsgAt: number | null): number {
    const item = this.insert(session, helper.name, text, lastMsgAt);
    fs.appendFileSync(path.join(this.dirOf(item.bot), 'inbox.jsonl'), `${JSON.stringify(item)}\n`, 'utf8');
    void this.push(item, helper, session.row.address);

    //T 跟踪：转出一条。
    const vars = { 收件号: item.id, 会话: session.id, 渠道: item.channel, 说话人: item.sender, 聊天: item.chat, 字数: text.length };
    this.ctx.emit('trace', 'Relay.register', `转出一条给 ${helper.name}：写进收件箱`, 'fs.appendFileSync(inbox.jsonl)', vars);
    return item.id;
  }

  /**
   * 插一条收件进表：渠道、地址、谁在哪说的都取会话现在记的。register 和主动发（itemForChat）共用。
   * @param session 哪场会话。
   * @param helper 转给哪个外部助手（名字）。
   * @param text 要转的话。
   * @param lastMsgAt 这一轮最后一句用户话的时间；relay_send 转的、主动发的给 null。
   * @returns 插进去的那条（对外的样子）。
   * 副作用：写库。
   */
  private insert(session: Session, helper: string, text: string, lastMsgAt: number | null): InboxItem {
    const row = session.row;
    const now = Date.now();
    const channel = row.channel ?? '';
    const speaker = this.speakerOf(row.address);
    const values = [
      row.bot, helper, session.id, channel, JSON.stringify(row.address ?? null),
      speaker.owner ? 1 : 0, speaker.sender, speaker.chat, speaker.chatName, text, now, lastMsgAt,
    ];
    const result = this.run(
      'INSERT INTO relay_items (bot, helper, session_id, channel, address, owner, sender, chat, chat_name, text, at, last_msg_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values);

    return {
      id: Number(result.lastInsertRowid), bot: row.bot, helper, session: session.id, channel, ...speaker,
      text, files: this.filesOf(text), at: local(now), atMs: now, state: 'pending',
    };
  }

  /**
   * 读每个 relay 机器人的 replies.jsonl：从 replies.pos 记的字节往后读，只处理以换行结尾的整行，逐行 accept。
   * 出错的行写进 replies.err.jsonl（带原因），不卡住后面的。读完更新 replies.pos。
   * 副作用：读写文件、写库、推会话。
   */
  private pollFile(): void {
    for (const bot of this.ctx.bots.list()) {
      if (this.modeOf(bot.name) === undefined) continue;
      try {
        this.pollOne(bot.name);
      } catch (error) {
        console.error(`relay：读 ${bot.name} 的回信文件出错：${textModule.messageOf(error)}`);
      }
    }
  }

  /**
   * 读一个机器人的 replies.jsonl。
   * @param bot 机器人名。
   */
  private pollOne(bot: string): void {
    const dir = this.dirOf(bot);
    const file = path.join(dir, 'replies.jsonl');
    const posFile = path.join(dir, 'replies.pos');
    const size = fs.statSync(file).size;
    let pos = fs.existsSync(posFile) ? Number(fs.readFileSync(posFile, 'utf8').trim()) : 0;
    //G 记的位置不对、或者文件被截短了（有人清空重写）→ 从头读。
    if (!Number.isInteger(pos) || pos < 0 || pos > size) pos = 0;
    if (pos === size) return;

    //M 只读到最后一个换行：写了一半的行留到下次。
    const data = Buffer.alloc(size - pos);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, data, 0, data.length, pos);
    } finally {
      fs.closeSync(fd);
    }
    const end = data.lastIndexOf(0x0a);
    if (end < 0) return;

    for (const line of data.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        this.accept(JSON.parse(line) as unknown, 'file', bot);
      } catch (error) {
        const failed = { line, reason: textModule.messageOf(error), at: local(Date.now()) };
        fs.appendFileSync(path.join(dir, 'replies.err.jsonl'), `${JSON.stringify(failed)}\n`, 'utf8');
      }
    }
    fs.writeFileSync(posFile, String(pos + end + 1));
  }

  /**
   * 查超时：pending 的收件，过 remind_minutes 没提醒过就提醒一次；过 expire_minutes 改成 expired，说“先放下”。
   * 话照那条收件当时的渠道地址发（bots.say）。会话正在转就下一次再说。
   * 副作用：写库、发话。
   */
  private checkLate(): void {
    const now = Date.now();
    for (const item of this.query<ItemRow>("SELECT * FROM relay_items WHERE state = 'pending' ORDER BY id", [])) {
      const minutes = (now - item.at) / 60_000;
      const expire = minutes >= this.config.expireMinutes;
      if (!expire && (item.reminded === 1 || minutes < this.config.remindMinutes)) continue;

      let session: Session;
      try {
        session = this.ctx.sessions.open(item.session_id);
      } catch {
        continue;
      }
      //G 会话正在转 → 下一次再说，免得插到这一轮中间。
      if (session.row.state === 'running') continue;

      const shown = String(Math.floor(minutes));
      let text: string;
      if (expire) {
        this.run("UPDATE relay_items SET state = 'expired', reminded = 1 WHERE id = ?", [item.id]);
        text = `${item.helper} ${shown} 分钟没回（#${String(item.id)}），这条先放下；之后回了还会发给你。`;
      } else {
        this.run('UPDATE relay_items SET reminded = 1 WHERE id = ?', [item.id]);
        text = `${item.helper} 还没回复（#${String(item.id)}，已 ${shown} 分钟），话还在它的收件箱里，回了会接着发给你。`;
      }
      this.ctx.bots.route(session, this.originOf(item));
      this.ctx.bots.say(session, text);

      //T 跟踪：提醒或放下。
      const vars = { 收件号: item.id, 会话: item.session_id, 分钟: shown };
      this.ctx.emit('trace', 'Relay.checkLate', expire ? '太久没回，先放下' : '没回，提醒一次', 'bots.say(session, text)', vars);
    }
  }

  /**
   * 推一条到这个助手的 webhook：{ id, bot, channel, chat, chat_type, chat_name, sender_open_id, sender, message_id, owner,
   * role, workspace, text, files, reply_to, time }。chat 是聊天号（回信给 chat 用），chat_type、chat_name、sender、owner、
   * role、workspace 同收件的 chat、chatName、sender、owner、role、workspace。
   * 它没配 webhook_url 只记日志。推失败只记日志：话已在收件箱里，外部助手照样能轮询到。
   * @param item 刚插进去的收件。
   * @param helper 推给哪个助手。
   * @param address 回话地址：取聊天号、说话人 open_id、消息号。
   */
  private async push(item: InboxItem, helper: Helper, address: unknown): Promise<void> {
    const text = item.text;
    //M 飞书插件把被回复的那条写成开头的【回复的消息：…】，单拿出来给 reply_to。
    const quoted = /^【回复的消息：([\s\S]*?)】\n?/u.exec(text);
    //M 聊天号：飞书写 chatId，微信写 chat。
    const chatId = textModule.textOf(address, 'chatId') || textModule.textOf(address, 'chat');
    const body = {
      id: item.id, bot: item.bot, channel: item.channel,
      chat: chatId, chat_type: item.chat, chat_name: item.chatName,
      sender_open_id: textModule.textOf(address, 'openId'), sender: item.sender,
      message_id: textModule.textOf(address, 'messageId'), owner: item.owner, role: item.role, workspace: item.workspace,
      text: quoted === null ? text : text.slice(quoted[0].length), files: item.files,
      reply_to: quoted?.[1] ?? null, time: item.at,
    };
    let result = '没配 webhook_url，只记收件箱';
    if (helper.webhookUrl !== '') {
      try {
        const response = await fetch(helper.webhookUrl, {
          method: 'POST', body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', ...webhookAuthHeaders(helper.webhookHeader) },
        });
        result = `HTTP ${String(response.status)}`;
      } catch (error) {
        result = `推不出去：${textModule.messageOf(error)}`;
      }
    }

    //T 跟踪：推 webhook。
    const vars = { 收件号: item.id, 聊天: body.chat, 本人: body.owner, 结果: result };
    this.ctx.emit('trace', 'Relay.push', `推给 ${helper.name} 的 webhook`, 'fetch(webhook_url)', vars);
  }

  /**
   * 按聊天找回信该挂的收件：这个助手在这个聊天最近的一条；没有就开（或找回）这个机器人的 relay 会话，
   * 登记一条“主动发”的收件。主动发的地址从收件表 web_messages 里这个聊天最近一条消息取（飞书 chatId / 微信 chat）。
   * @param chat 飞书 chat_id 或微信 chat。
   * @param bot 哪个机器人；不给就用找到的那条的。
   * @param helper 哪个助手的回信。
   * @returns 收件号。
   * @throws routesModule.Failure：找不到这个聊天 404。
   */
  private itemForChat(chat: string, bot: string | undefined, helper: string): number {
    const like = `%"${chat.replaceAll('"', '')}"%`;
    const item = this.query<{ id: number }>(
      'SELECT id FROM relay_items WHERE address LIKE ? AND helper = ? AND (? IS NULL OR bot = ?) ORDER BY id DESC LIMIT 1',
      [like, helper, bot ?? null, bot ?? null])[0];
    if (item !== undefined) return item.id;

    const seen = this.query<{ bot: string; channel: string; address: string }>(
      'SELECT bot, channel, address FROM web_messages WHERE address LIKE ? AND (? IS NULL OR bot = ?) ORDER BY id DESC LIMIT 1',
      [like, bot ?? null, bot ?? null])[0];
    if (seen === undefined) throw new routesModule.Failure(404, `没见过这个聊天：${chat}`);
    const found = this.ctx.sessions.find({ bot: seen.bot, kind: 'relay' })[0];
    const session = found === undefined
      ? this.ctx.sessions.create({ bot: seen.bot, kind: 'relay' })
      : this.ctx.sessions.open(found.id);
    this.ctx.bots.route(session, { channel: seen.channel, address: JSON.parse(seen.address) as unknown });
    return this.insert(session, helper, `（${helper} 主动发）`, null).id;
  }

  /**
   * 回信带的文件：飞书收件就用飞书插件上传后发到那个聊天（挂在 messageId 那条下面）；别的渠道暂不支持，只记 trace。
   * @param item 收件。
   * @param file 文件路径：相对数据目录，或绝对路径。
   */
  private sendFile(item: ItemRow, file: string): void {
    const full = path.resolve(this.ctx.resources.root, file);
    const where = JSON.parse(item.address) as { appId?: string; chatId?: string; messageId?: string } | null;
    const feishu = this.ctx.get('feishu');
    const sending = item.channel === 'feishu' && where?.chatId !== undefined && feishu !== undefined
      ? feishu.sendFile(item.bot, where.chatId, full, { appId: where.appId, messageId: where.messageId })
      : Promise.reject(new Error(
          feishu === undefined && item.channel === 'feishu'
            ? '飞书插件没挂，发不了文件'
            : `渠道 ${item.channel || '（没有）'} 还不支持发文件`,
        ));
    void sending.then((messageId) => `已发 ${messageId}`, (error: unknown) => `没发出去：${textModule.messageOf(error)}`).then((result) => {
      //T 跟踪：回信带的文件。
      const vars = { 收件号: item.id, 文件: full, 结果: result };
      this.ctx.emit('trace', 'Relay.sendFile', `${item.helper} 回信带的文件`, 'ctx.get("feishu").sendFile(bot, chatId, file)', vars);
    });
  }

  /** 登记工具 relay_send：开了 model 的那种聊天里，模型用它把话转给默认助手（helpers 的第一个）。 */
  private registerTool(): void {
    const main = this.config.helpers[0];
    const helper = main.name;
    this.ctx.tools.register({
      definition: {
        name: 'relay_send',
        description: `把话转给外部助手 ${helper}。它大约每 5 分钟看一次，回信会作为新的一句话交回这场会话。`
          + `用户要找 ${helper}、或者要 ${helper} 帮忙时用；${this.whenToRelay()}`,
        parameters: piAi.Type.Object({
          text: piAi.Type.String({ description: `要转给 ${helper} 的话：用户原话一字不改，或你整理好的问题` }),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => {
        if (this.sessionMode(session) !== 'model') {
          throw new Error(`这场会话不能用 relay_send（机器人 ${session.row.bot} 没写 relay: model，这个群也没登记 relay: model）`);
        }
        const text = String(args['text']).trim();
        if (text === '') throw new Error('text 不能是空的');
        const id = this.register(session, main, text, null);
        return `已转给 ${helper}（#${String(id)}），它大约每 5 分钟看一次，回信会作为新的一句话交回这场会话`;
      },
    });
  }

  /**
   * 一句“程序说的”回答：长得像模型的回答，提供方写 relay，模型写机器人名（网页回话的生成依据显示 relay/机器人）。
   * @param bot 机器人名。
   * @param text 要说的话。
   * @returns 填进 request.answer 的回答。
   */
  private said(bot: string, text: string): piAi.AssistantMessage {
    return { ...piAi.fauxAssistantMessage(text), provider: 'relay', model: bot };
  }

  /**
   * 收件当时记的渠道和地址。
   * @param item 收件。
   * @returns 给 bots.route、bot.hand 的 origin；当时没有渠道就是空的（不改会话原来记的）。
   */
  private originOf(item: ItemRow): Origin {
    if (item.channel === '') return {};
    return { channel: item.channel, address: JSON.parse(item.address) as unknown };
  }

  /**
   * 一个机器人的收件夹：运行时目录 integrations/relay/<机器人>/，里面的 inbox.jsonl、replies.jsonl 没有就建空的。
   * @param bot 机器人名。
   * @returns 绝对路径。
   */
  private dirOf(bot: string): string {
    const dir = this.ctx.resources.dir('integrations', 'relay', bot);
    for (const file of ['inbox.jsonl', 'replies.jsonl']) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) fs.writeFileSync(full, '');
    }
    return dir;
  }

  /**
   * 话里带的附件。渠道（feishu、web-api）把收到的图片、文件用 bots.saveFile 存进工作区，话里写 @绝对路径（有空白时 @"路径"）。
   * 只认运行时目录里面的绝对路径（别的 @ 是 @人、@别处，不算）；不查文件在不在，同一条收件每次算出来都一样。
   * @param text 收件的话。
   * @returns 相对运行时目录、用 / 分隔的路径，按出现先后，去重。
   */
  private filesOf(text: string): string[] {
    const root = this.ctx.resources.root;
    const files: string[] = [];
    for (const file of imageModule.atPaths(text)) {
      //G 不是绝对路径（@人）、不在运行时目录里（别的盘、上一层）→ 不算附件。
      if (!path.isAbsolute(file)) continue;
      const relative = path.relative(root, file);
      const up = relative === '..' || relative.startsWith(`..${path.sep}`);
      if (relative === '' || up || path.isAbsolute(relative)) continue;

      files.push(relative.split(path.sep).join('/'));
    }
    return files;
  }

  /**
   * 取一条收件。
   * @param id 收件号。
   * @returns 没有是 undefined。
   */
  private itemOf(id: number): ItemRow | undefined {
    return this.query<ItemRow>('SELECT * FROM relay_items WHERE id = ?', [id])[0];
  }

  /**
   * 表里的一行 → 对外的样子。
   * @param row 表里的一行。
   * @returns 收件。
   */
  private view(row: ItemRow): InboxItem {
    //M 哪一档、builder 的目录：收件存了原样的回话地址，照它现读，不另加栏。
    const { role, workspace } = this.speakerOf(JSON.parse(row.address) as unknown);
    return {
      id: row.id,
      bot: row.bot,
      helper: row.helper,
      session: row.session_id,
      channel: row.channel,
      owner: row.owner === 1,
      role,
      workspace,
      sender: row.sender,
      chat: row.chat,
      chatName: row.chat_name,
      text: row.text,
      files: this.filesOf(row.text),
      at: local(row.at),
      atMs: row.at,
      state: row.state,
      repliedAt: row.replied_at === null ? null : local(row.replied_at),
    };
  }

  /**
   * 查库。
   * @param sql 语句。
   * @param values 参数。
   * @returns 查到的行。
   */
  private query<T>(sql: string, values: (string | number | null)[]): T[] {
    return this.ctx.resources.db.query(sql).all(...values) as T[];
  }

  /**
   * 改库。
   * @param sql 语句。
   * @param values 参数。
   * @returns 改了几行、新行的号。
   */
  private run(sql: string, values: (string | number | null)[]): { lastInsertRowid: number | bigint } {
    return this.ctx.resources.db.query(sql).run(...values);
  }
}


/**
 * 挂上 relay。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务
 * （resources、sessions、bots）都就绪，再调一次 apply(ctx, 配置)。插件通过 ctx 听事件、登记工具和定时器，
 * 插件被拔掉时这些登记自动撤掉。详见 plugins/Index.ts 的 PluginModule。
 * 先后：写在 http、fake-model 后面，bot-front-desk、model-fallback 前面（session/request、bot/receive 照挂的先后挨个问）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config config.yaml 的 plugins 段里写给它的：helpers（必写，每项 name、prefixes，可写 webhook_url、
 *   webhook_header，第一个是默认助手）、bots、remind_minutes、expire_minutes、poll_seconds。
 *   旧的 owner_open_ids 这里不读：feishu 插件校验配置时把它并进 people（本人只在飞书插件判断）。
 * @throws 配置写得不对、helpers 没写、名单项 relay 写了别的值时抛错。
 */
export function apply(
  ctx: cordis.Context,
  config: { remind_minutes?: unknown; expire_minutes?: unknown; poll_seconds?: unknown; helpers?: unknown;
    bots?: unknown; owner_open_ids?: unknown } | undefined,
): void {
  //M 插件的配置是外面进来的，在这里校验一次。
  const written = config ?? {};
  const positive = (value: unknown, fallback: number, key: string): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !(value > 0)) throw new Error(`relay 的 ${key} 要写成正数`);
    return value;
  };

  const list = (value: unknown, fallback: string[], key: string): string[] => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) throw new Error(`relay 的 ${key} 要写成字符串列表`);
    return value as string[];
  };
  const str = (value: unknown, key: string): string => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error(`relay 的 ${key} 要写成字符串`);
    return value.trim();
  };

  //M 外部助手全看配置，代码里不写死谁：helpers 每项一个，第一个是默认助手。
  if (!Array.isArray(written.helpers) || written.helpers.length === 0) {
    throw new Error('relay 要在 helpers 里写至少一个外部助手（每项 name、prefixes，可写 webhook_url、webhook_header）');
  }
  const helpers: Helper[] = [];
  for (const entry of written.helpers as unknown[]) {
    const one = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const name = one['name'];
    if (typeof name !== 'string' || name.trim() === '' || helpers.some((known) => known.name === name)) {
      throw new Error('relay 的 helpers 每项要写 name，名字不能重复');
    }
    const prefixes = list(one['prefixes'], [], `${name} 的 prefixes`);
    //G 空前缀会把所有的话都截走。
    if (prefixes.some((prefix) => prefix.trim() === '')) throw new Error(`relay 里 ${name} 的 prefixes 不能有空串`);
    helpers.push({
      name,
      prefixes,
      webhookUrl: str(one['webhook_url'], `${name} 的 webhook_url`),
      webhookHeader: str(one['webhook_header'], `${name} 的 webhook_header`),
    });
  }

  //M 名单项的 relay 也在这里查一次：只许 direct、model，或者不写。按群分的写在飞书插件配置的 groups 里。
  for (const bot of ctx.bots.list()) {
    const mode = bot.config['relay'];
    if (mode !== undefined && mode !== 'direct' && mode !== 'model') {
      throw new Error(`机器人 ${bot.name} 的 relay 只能写 direct 或 model（按群分的写在 feishu 插件配置的 groups 里）`);
    }
  }

  new Relay(ctx, {
    remindMinutes: positive(written.remind_minutes, 15, 'remind_minutes'),
    expireMinutes: positive(written.expire_minutes, 120, 'expire_minutes'),
    pollSeconds: positive(written.poll_seconds, 2, 'poll_seconds'),
    //M 上面查过 helpers 至少一项，每项不是进了名单就是抛错了。
    helpers: helpers as [Helper, ...Helper[]],
    bots: list(written.bots, [], 'bots'),
  });
}
