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
 * 不调模型靠的是骨架现成的口子：插件在 session/before-model 里填了 request.answer，会话就不调 chat()。不用改骨架。
 * 配了 webhook_url 的助手，转出时推一次；没配的自己来看：读收件箱文件，或 GET /api/relay/inbox?helper=名字&since=号。
 * 收件带 files：话里 @路径 写的附件（渠道用 bots.saveFile 存进工作区的），换成相对运行时目录的路径，见 getFiles。
 * 设计和给外部助手看的用法见同目录 说明.md 的「设计要点」「给外部助手的用法」两节。
 *
 * AgentTasks.ts 管外部 AI 的任务和单向留言，工具 agent_task 与 /api/agents* 在 http 就绪后挂。
 * 转话这一块要配置 helpers 才挂；只用任务通道的可以不写 helpers。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import type * as dispatchModule from '../bots/Dispatch.ts';
import type { Origin, ReceiveEvent } from '../bots/index.ts';
import * as agentTasksModule from './AgentTasks.ts';
import * as routesModule from './Routes.ts';
import * as failureModule from '../../utils/Failure.ts';


/** 插件名。 */
export const name = 'relay';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//  1.1.0：11-17 并进原外部任务与留言插件。1.2.0：按 chat 回信只认一字不差的聊天号、不再找 web_messages；回信文件限范围；agent_task 派活防重复。
//  1.3.0：回信先写进对话再标已送（relayReplyId 对账）；走模型的会话回信排进结果队列（acceptResult，键 relay:<回信号>）。
//  1.3.1：发飞书文件改发 feishu/send-file 请求（等回执，不伪造成功）；提醒改发 bot/say 通知。
//  1.3.2：转话回信和外部任务结果经 bot/request 入队，收到成功回执后更新各自的记录。
//  1.3.3：外部 AI 打招呼、交回结果的校验（checkAgentHello、checkTaskResult）从骨架 utils/Checks.ts 挪进 relay/Checks.ts，只有 relay 用。
//  1.4.0：单向留言通过 agent_task 的 reply:false 派送，执行端领取即送达。
//  1.4.1：明确轮询收件的本人标志与公开字段，补上旧留言的只读查看入口。
export const version = '1.4.5';

/** 决策图收件的来源，不代表机器人渠道或会话。 */
const DECISION_CHANNEL = 'decision-map';

/**
 * 用到的服务。http 是可选的：用到时 ctx.get 现取。发飞书文件走 feishu/send-file 事件，没人答就记“没发出去”。
 * 任务通道等 http 就绪；投递结果经 bot/request，须收到成功回执。
 */
export const inject = ['resources', 'tools', 'sessions', 'bots'];


/**
 * 按客户号认聊天种类：飞书群的客户号是 feishu:group:<chat_id>（feishu/index.ts 的 feishuCustomer），别的都算私聊。
 * @param customer 会话或回话地址里的客户号；没有给 ''。
 * @returns group 或 p2p。
 */
function getChat(customer: string): ChatKind {
  if (customer.startsWith('feishu:group:')) return 'group';

  return 'p2p';
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
  if (name.toLowerCase() === 'authorization') return { Authorization: value };

  return { [name]: value };
}


/** relay 插件本体。只由 apply 来建。 */
export class Relay {
  /**
   * direct 会话这一轮在送哪条回信：会话号 → 回信号（onRequest 记）。这一轮正常结束（session/change 收到 done，
   * 回答已经接进对话、存了盘）时 onChange 标已送：万一有插件在 session/after-model 换掉回答、丢了 relayReplyId，也不会反复重发。
   * 只在内存里，断电就没了，那时靠 markWritten 按 relayReplyId 对账。
   */
  private readonly answering = new Map<string, number>();
  /** 正在向结果队列投递的会话，按每场会话的回信顺序排队。 */
  private readonly delivering = new Set<string>();

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
      + ' session_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, text TEXT NOT NULL,'
      + ' at INTEGER NOT NULL,'
      + " last_msg_at INTEGER, state TEXT NOT NULL DEFAULT 'pending', reminded INTEGER NOT NULL DEFAULT 0,"
      + ' replied_at INTEGER)');
    db.exec('CREATE TABLE IF NOT EXISTS relay_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,'
      + ' session_id TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL, at INTEGER NOT NULL,'
      + ' delivered INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL)');

    //M 缺的栏补上（ADDED_COLUMNS）。旧收件：helper 都算默认助手的；谁、在哪说的照它记的回话地址补。
    //  加栏和填值放进一个事务：中途断了就一起作废，下次启动还会再补，不会留下没填的收件。
    const tableInfo = db.query('PRAGMA table_info(relay_items)').all() as { name: string }[];
    const columns = new Set(tableInfo.map((column) => column.name));
    const missing = ADDED_COLUMNS.filter((column) => !columns.has(column.name));
    if (missing.length > 0) {
      const addColumns = db.transaction(() => {
        for (const column of missing) {
          db.exec(`ALTER TABLE relay_items ADD COLUMN ${column.name} ${column.type}`);
        }
        //M 给迁移前的转发条目补上默认助手，以便继续按助手查询。
        if (!columns.has('helper')) db.query('UPDATE relay_items SET helper = ?').run(this.config.helpers[0].name);

        //M 旧表缺发送方列时，从原回话地址恢复发送人和群信息。
        if (!columns.has('sender')) this.fillSpeakers();
      });
      addColumns();
    }

    //M 先把文件夹和两个文件建好，外部助手一看就知道往哪写。
    for (const bot of this.ctx.bots.list()) {
      if (this.getMode(bot.name) !== undefined) this.getDir(bot.name);
    }

    //M 三个监听。ctx.on 挂在本插件的 ctx 上：插件被拔掉时 Cordis 自动撤掉。
    //M   bot/receive、session/before-model 是“挨个问”（serial），先后照 config.yaml 里 plugins 写的先后。
    this.ctx.on('bot/receive', (event) => {
      this.onReceive(event);
    });

    //M 在模型请求入口决定本轮是直转还是开放转话工具。
    this.ctx.on('session/before-model', (request) => {
      this.onRequest(request);
    });

    //M 在会话状态变化后检查积压回信是否可以送出。
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

    //M 决策图也用中控已有的收件轮询。此入口只记通知，不创建或推进机器人会话。
    requestEventModule.onRequestEvent(this.ctx, 'decision-map/relay', 'decision-map/relay-result', (request) => {
      const helper = this.config.helpers.find((item) => item.name === request.helper);
      if (helper === undefined) return { ok: false, error: 'relay 没有该中控助手' };

      const channel = DECISION_CHANNEL;
      const key = `${channel}:${request.node}`;
      const params = [helper.name, channel, key];
      const condition = 'helper = ? AND channel = ? AND session_id = ?';
      if (request.action === 'ack') {
        const sql = `UPDATE relay_items SET state = 'replied', replied_at = ? WHERE ${condition} AND state = 'pending'`;
        const values = [Date.now(), ...params];

        //M 确认图上决定后清除待收状态，中控的下次轮询能等到新决定。
        this.run(sql, values);
        return { ok: true };
      }

      //G 以节点号识别补投，同一决定只进收件箱一次。
      const sql = `SELECT id FROM relay_items WHERE ${condition} LIMIT 1`;
      const [previous] = this.query<{ id: number }>(sql, params);
      if (previous !== undefined) return { ok: true, id: previous.id };

      //M 收件列表需要机器人标识，取运行时名单中第一个。
      const bot = this.ctx.bots.list()[0]?.name;
      if (bot === undefined || request.text === undefined) return { ok: false, error: '缺少收件内容或机器人' };

      const sender = '决策图';
      const address = { owner: true, role: 'owner', senderName: sender, decisionTarget: request.target };
      const insert = 'INSERT INTO relay_items (bot, helper, session_id, channel, address, owner, sender, chat,'
        + ' chat_name, text, at, reminded) VALUES (?, ?, ?, ?, ?, 1, ?, \'p2p\', \'\', ?, ?, 1)';
      const values = [bot, helper.name, key, channel, JSON.stringify(address), sender, request.text, Date.now()];

      //M 仅写供 Wait_Relay 读取的中控收件，回执给决定页用于反馈投递结果。
      const created = this.run(insert, values);
      return { ok: true, id: Number(created.lastInsertRowid) };
    });

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
      const sql = 'SELECT DISTINCT r.session_id, i.channel FROM relay_replies r'
        + ' JOIN relay_items i ON i.id = r.item_id WHERE r.delivered = 0';
      const rows = this.query<{ session_id: string; channel: string }>(sql, []);
      for (const row of rows) {
        //M 启动补送也按收件的来源区分，不尝试打开决策图的伪会话。
        void this.deliverSoon(row.session_id, row.channel);
      }

      //M 启动时先读一遍文件回信，避免等待首个定时间隔。
      this.pollFile();
    });
  }

  /**
   * 老库补栏时，照每条收件记的回话地址补上谁、在哪说的（构造函数的事务里调）。
   * 副作用：改库。
   */
  private fillSpeakers(): void {
    //M 扫描旧转发条目，用保存的回话地址提取发言人信息。
    for (const row of this.query<{ id: number; address: string }>('SELECT id, address FROM relay_items', [])) {
      const speaker = this.getSpeaker(JSON.parse(row.address) as unknown);
      let ownerFlag = 0;
      if (speaker.owner) {
        ownerFlag = 1;
      }
      const values = [ownerFlag, speaker.sender, speaker.chat, speaker.chatName, row.id];

      //M 回填发言者和会话类型字段，供后续回信和状态查询使用。
      this.run('UPDATE relay_items SET owner = ?, sender = ?, chat = ?, chat_name = ? WHERE id = ?', values);
    }
  }

  /**
   * 谁、在哪说的：只看渠道写在回话地址里的几项，收件和 webhook 推送共用。
   * 是不是本人、哪一档不在这里判断：飞书插件照 people 写进地址的 owner、role、workspace（旧收件的地址没有，算 false、''）。
   * @param address 回话地址（飞书的 FeishuAddress：owner、role、workspace、openId、chatId、customer、senderName、chatName）。
   * @returns owner、role、workspace、sender、chat、chatName；说明见 InboxItem。
   */
  private getSpeaker(address: unknown): Speaker {
    //M 从渠道地址取发言人标识和会话号，作为显示名与群类型的来源。
    const openId = utils.getStringField(address, 'openId');
    const chat = getChat(utils.getStringField(address, 'customer'));
    //M 名字、群名飞书插件写了才有（登记的优先，再是查到的）；都没有用 open_id 后 6 位、chat_id。
    const sender = utils.getStringField(address, 'senderName') || openId.slice(-6);
    const groupName = utils.getStringField(address, 'chatName') || utils.getStringField(address, 'chatId');
    let chatName = '';
    if (chat === 'group') {
      chatName = groupName;
    }
    return {
      owner: utils.getField(address, 'owner') === true,
      role: utils.getStringField(address, 'role'),
      workspace: utils.getStringField(address, 'workspace'),
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
    //M 统计待回条数和最新转发号，用于流程页快照。
    const countSql = "SELECT COUNT(*) AS count FROM relay_items WHERE state = 'pending'";
    const pending = this.query<{ count: number }>(countSql, []);
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
  getMode(bot: string): RelayMode | undefined {
    if (this.config.bots.includes(bot)) return 'direct';

    //M 插件名单以外按机器人的配置决定转发模式。
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
    //M 先用机器人自己的转发模式，覆盖地址里的群规则。
    const byBot = this.getMode(row.bot);
    if (byBot !== undefined) return byBot;

    //M 机器人未指定模式时，读取渠道地址中的群转发设置。
    if (utils.getField(row.address, 'relay') === 'model') return 'model';

    return undefined;
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

    //M 按配置顺序选第一个前缀命中的助手。
    return this.config.helpers.find((helper) => helper.prefixes.some(hits));
  }

  /**
   * 这场会话是不是“直接转”的：所在聊天开了 direct 的机器人的前台会话，或者前缀触发开的 relay 会话。小会话不算。
   * @param session 会话。
   * @returns 是不是。
   */
  private direct(session: Session): boolean {
    const row = session.row;
    //G 只让顶层会话走直转，普通会话根据配置再判断。
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
      //M 把当前筛选项的值绑定给刚拼接的查询条件。
      values.push(value);
    }

    //M 限制本轮批量并把查询行转成外部助手能读的收件条目。
    sql += ' ORDER BY id LIMIT ?';
    values.push(limit);
    const items = this.query<ItemRow>(sql, values).map((row) => this.view(row));

    //M 同时给出表中的最新转发号，供轮询端判断是否有后续数据。
    const last = this.query<{ last: number | null }>('SELECT MAX(id) AS last FROM relay_items', [])[0]?.last ?? 0;
    return { items, last };
  }

  /**
   * 收下一条回信。两条回信路（replies.jsonl、POST /api/relay/reply）共用，外面进来的东西在这里校验一次。
   * 先把参数都查完、找到收件、查完文件，才动库：查不过的不留半截收件。
   * @param input 回信：{ id: 收件号 | chat, text, done?（默认 true）, helper?（给 chat 时是谁主动发，不写是默认助手）, bot?, file?, reply_to? }。
   * @param via 从哪条路来：file / http。
   * @param bot 文件那条路：是哪个机器人的 replies.jsonl；收件不是这个机器人的就不收，按 chat 找也只找这个机器人的。
   * @returns 收下以后的那条收件。
   * @throws failureModule.Failure：id 不是正整数、text 空、done 不是布尔、helper 不是接着的助手、写了 helper 却和收件的助手对不上、
   *   file 不在或出了范围（getReplyFile）400；没有这个号、按 chat 精确找不到 404。
   * 副作用：写库；done 时收件改成 replied；按来源投递回信；按 chat 主动发时新登记一条收件。
   */
  accept(input: unknown, via: 'file' | 'http', bot?: string): InboxItem {
    let body: Record<string, unknown> = {};
    if (typeof input === 'object' && input !== null) {
      body = input as Record<string, unknown>;
    }
    const helper = body['helper'] ?? this.config.helpers[0].name;
    if (typeof helper !== 'string' || !this.config.helpers.some((one) => one.name === helper)) {
      const names = this.config.helpers.map((one) => one.name).join('、');
      //G 用允许的助手名单提示回信方修正无效的目标。
      throw new failureModule.Failure(400, `helper 只能写接着的助手：${names}`);
    }

    //G 话、做完没有、文件路径的写法：先查，查不过不动库。
    const text = body['text'];
    const done = body['done'] ?? true;
    const file = body['file'];
    if (typeof text !== 'string' || text.trim() === '') {
      throw new failureModule.Failure(400, 'text 要写成非空的字符串');
    }
    if (typeof done !== 'boolean') {
      throw new failureModule.Failure(400, 'done 要写成 true 或 false，不写是 true');
    }
    if (file !== undefined && (typeof file !== 'string' || file === '')) {
      throw new failureModule.Failure(400, 'file 要写成文件路径（相对数据目录，或绝对路径）');
    }

    //G 收件号：不给收件号就要给 chat（飞书 chat_id / 微信 chat）。
    const id = body['id'];
    const chat = body['chat'];
    const byChat = (id === undefined || id === null) && typeof chat === 'string' && chat !== '';
    if (!byChat && (typeof id !== 'number' || !Number.isInteger(id) || id < 1)) {
      throw new failureModule.Failure(400, 'id 要写成正整数（收件号），或者给 chat');
    }

    //M 按 chat 找只找哪个机器人的：文件那条路是那个 replies.jsonl 的机器人；接口那条路照正文写的 bot，没写不限。
    let chatBot = bot;
    if (chatBot === undefined && typeof body['bot'] === 'string') {
      chatBot = body['bot'];
    }

    //M 收件：给了 chat 按聊天号精确找（findForChat，不改库）；不然照收件号取。
    let item: ItemRow | undefined;
    if (byChat) {
      item = this.findForChat(chat as string, chatBot, helper);
    }
    if (!byChat) {
      item = this.getItem(id as number);
    }
    if (item === undefined) {
      throw new failureModule.Failure(404, `没有这个收件号：${String(id)}`);
    }
    if (bot !== undefined && item.bot !== bot) {
      throw new failureModule.Failure(400, `收件 #${String(item.id)} 是 ${item.bot} 的，不是 ${bot} 的`);
    }

    //M 按 chat 找到的是别的助手的收件：这个助手在这个聊天还没有收件，是它主动发，下面借那条记的渠道和地址新登记一条。
    const proactive = byChat && item.helper !== helper;
    if (!proactive && body['helper'] !== undefined && item.helper !== helper) {
      throw new failureModule.Failure(400, `收件 #${String(item.id)} 是转给 ${item.helper} 的，helper 写的是 ${helper}`);
    }

    //G 回信带的文件：只许这个机器人的工作区、relay 给它的目录里面的，出范围直接拒（getReplyFile）。
    let fileFull: string | undefined;
    if (typeof file === 'string') {
      fileFull = this.getReplyFile(item.bot, file);
    }

    //M 都查过了才动库：主动发的先登记那条新收件。
    if (proactive) {
      item = this.startProactive(item, helper);
    }
    const itemId = item.id;

    //M reply_to（飞书消息号）：回话挂在那条下面——改收件记的地址里的 messageId，飞书插件按它用回复接口发。
    const replyTo = body['reply_to'];
    if (typeof replyTo === 'string' && replyTo !== '') {
      const updateSql = "UPDATE relay_items SET address = json_set(address, '$.messageId', ?)"
        + " WHERE id = ? AND address LIKE '{%'";
      this.run(updateSql, [replyTo, itemId]);
    }

    //M 记一条回信；done 就把收件改成 replied（放下了的也改，回了就算回完）。
    const now = Date.now();
    let doneFlag = 0;
    if (done) {
      doneFlag = 1;
    }

    //M 先把已接受的回信写入待送队列，之后才轮到渠道发送。
    this.run('INSERT INTO relay_replies (item_id, session_id, text, done, at, via) VALUES (?, ?, ?, ?, ?, ?)',
      [itemId, item.session_id, text, doneFlag, now, via]);
    if (done) {
      this.run("UPDATE relay_items SET state = 'replied', replied_at = ? WHERE id = ?", [now, itemId]);
    }

    //T 跟踪：收到一条回信。
    const vars = { helper: item.helper, inboxId: itemId, session: item.session_id, deliverySource: via, complete: done, length: text.length };
    this.ctx.emit('trace', 'Relay.accept', 'trace.relay.accept', 'INSERT INTO relay_replies', vars);

    //M 按收件来源回到真实会话或决策图节点。
    void this.deliverSoon(item.session_id, item.channel);

    //M 回信带的文件（上面查过范围）：照收件记的地址发。
    const latest = this.getItem(itemId) ?? item;
    if (fileFull !== undefined) {
      void this.sendFile(latest, fileFull);
    }

    //M 以接口使用的格式返回更新后的转发条目。
    return this.view(latest);
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
    //M 取渠道里的客户标识，使转发会话按客户隔离。
    const customer = utils.getStringField(address, 'customer');
    //M direct 进前台会话；只听的话不整句转，和别的一样要以某个助手的前缀开头才进 relay 会话。都按客户分。
    const listenOnly = utils.getField(address, 'listenOnly') === true;
    let kind: 'front' | 'relay' = 'front';
    if (listenOnly || this.getMode(bot) !== 'direct') {
      if (this.prefixed(event.message.text) === undefined) return;
      kind = 'relay';
    }

    //M 按确定的会话种类和客户接收这条入站消息。
    event.session = this.openOrCreateSession(bot, kind, customer);
  }

  /** 按机器人、种类、可选客户找已有会话，没有就新建。 */
  private openOrCreateSession(bot: string, kind: 'front' | 'relay', customer = ''): Session {
    const where: { bot: string; kind: string; customer?: string } = { bot, kind };
    if (customer !== '') {
      where.customer = customer;
    }

    //M 先查同一客户与种类的已有会话，找到就恢复它。
    const found = this.ctx.sessions.find(where)[0];
    if (found !== undefined) return this.ctx.sessions.open(found.id);

    //M 首次接待该客户时创建对应会话。
    return this.ctx.sessions.create(where);
  }

  /**
   * 响应 session/before-model：direct 机器人的会话（不是小会话）一定填 request.answer，绝不落到真模型。
   * 有新话 → 登记收件，回“已转给”；没新话、有没送的回信 → 回信当回答；都没有 → 回一句“没有新消息”。
   * @param request 这一步的请求。
   */
  private onRequest(request: ChatRequest): void {
    const session = request.session;
    const row = session.row;
    //G 跳过普通会话的直转流程，由工具逻辑决定是否引导模型转话。
    if (!this.direct(session)) {
      this.offerTool(request);
      return;
    }

    //M 这一轮还没送回信：清掉上一轮留下的（上一轮失败了没走到 onChange），免得这一轮结束时把没送的标成已送。
    this.answering.delete(session.id);

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

    //M 回信：先对账（上一轮写进对话、还没标已送就断了的补标，免得再送一次），再取这场会话最早一条没送的。
    this.markWritten(session);
    const reply = this.query<ReplyRow>(
      'SELECT * FROM relay_replies WHERE session_id = ? AND delivered = 0 ORDER BY id LIMIT 1', [session.id])[0];
    if (reply !== undefined) {
      //M 回话先换成那条收件当时的渠道和地址，再把回信当回答。
      const item = this.getItem(reply.item_id);
      if (item !== undefined) this.ctx.bots.route(session, this.getOrigin(item));

      //M 这里不标已送：回答带着回信号，骨架写进对话、存盘以后，session/change 时才标（onChange、markWritten）。
      const helper = item?.helper ?? this.config.helpers[0].name;
      request.answer = this.said(row.bot, `${helper}：${reply.text}`, reply.id);
      this.answering.set(session.id, reply.id);

      //T 跟踪：送出一条回信。
      const vars = { inboxId: reply.item_id, session: session.id, channel: row.channel, length: reply.text.length };
      this.ctx.emit('trace', 'Relay.onRequest', 'trace.relay.returnReply', 'request.answer = said(reply.text)', vars);
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

    //G 只有模型转发模式需要向模型添加转发说明。
    if (this.sessionMode(request.session) === 'model') {
      let where = '';
      //M 群聊时向模型说明发言者可能不止一人。
      if (getChat(row.customer ?? '') === 'group') {
        where = '这是群聊，可能有几个人在说话。';
      }

      //M 给当前模型请求补上转话条件，供模型判断何时使用工具。
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
    let skip = '';
    if (heads.length > 0) {
      skip = `以 ${heads.join('、')} 开头的话已经直接转给外部助手了，不用再转。`;
    }
    return `聊到要查代码、定方案、改东西，或者问 jmbots 本身怎么做时，用 relay_send 把要点转给外部助手 ${helper}；`
      + `闲聊、打招呼不转。${skip}`;
  }

  /**
   * 响应 session/change：direct 会话一轮正常结束 → 这一轮送的那条回信标已送（回答已经接进对话、存了盘），
   * 再交给 deliverSoon（它先对账，还有没送的再推一次）。
   * @param session 状态刚变的会话。
   * 副作用：改 relay_replies.delivered；可能再推会话。
   */
  private onChange(session: Session): void {
    //G 失败了不再推，免得一直重跑；不是 direct 的不归这里推。
    if (session.row.state !== 'done' || !this.direct(session)) return;

    //M 这一轮送的那条：标已送。
    const replyId = this.answering.get(session.id);
    if (replyId !== undefined) {
      this.answering.delete(session.id);
      this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [replyId]);
    }

    //M 退出繁忙状态后再尝试送出排队期间收到的回信。
    void this.deliverSoon(session.id);
  }

  /**
   * 把一场会话没送的回信送出去。
   * direct（relay 会话、direct 机器人的前台）：先对账（markWritten），还有没送的就推那场会话，由 onRequest 程序回答
   *   （setTimeout 隔开：这时候会话可能正在收尾，马上调 run 会直接返回；在转的，转完 session/change 会再来）。
   *   direct 机器人的前台也走这条：进结果队列的话，前台会把结果当一句 user 话接进对话，onRequest 又会把它当新话转回给助手。
   * model（走模型的前台、后台）：按回信号发 bot/request，结果键为 relay:<回信号>；回执成功才标已送。
   * @param sessionId 会话号或决策图收件键。
   * @param channel 收件来源。决策图回信经事件写入图，真实会话沿用原有处理。
   * 副作用：改 relay_replies.delivered；写节点、推会话或排进结果队列。
   */
  private async deliverSoon(sessionId: string, channel?: string): Promise<void> {
    if (channel === DECISION_CHANNEL) {
      //M 决策图由它自己的插件接收回复，不经过会话层。
      const deliver = (reply: ReplyRow) => this.queueDecisionReply(reply);
      await this.deliverPending(sessionId, deliver);
      return;
    }

    let session: Session;
    try {
      //M 恢复接收回信的原会话，后面按会话模式选择回传方式。
      session = this.ctx.sessions.open(sessionId);
    } catch (error) {
      console.error(`relay：回信送不出去：${textModule.getErrorMessage(error)}`);
      return;
    }

    //M 用原会话的模式区分直接投递与交回模型处理。
    const mode = this.sessionMode(session);

    //M direct：对完账没有要送的就不推（推了会多一句“没有新消息”发给用户）；推之前那一拍再对一次（中间可能已经送了）。
    if (this.direct(session)) {
      if (!this.hasLeft(session)) return;

      setTimeout(() => {
        //G 延后执行前重新核对待送回信，避免重复启动会话。
        if (!this.hasLeft(session)) return;

        //M 让空闲会话接收仍未送出的回信。
        void session.run();
      }, 0);
      return;
    }

    //G 机器人在这种聊天里已经不是 model 了 → 回信留在库里，不推（推了会去调真模型）。
    if (mode !== 'model') return;

    //M 模型会话走原来的结果队列。
    const deliver = (reply: ReplyRow) => this.queueReply(sessionId, reply);
    await this.deliverPending(sessionId, deliver);
  }

  /** 按回信号串行投递同一收件键下的待送回信，每轮只尝试一次。 */
  private async deliverPending(sessionId: string, deliver: (reply: ReplyRow) => Promise<void>): Promise<void> {
    //G 正在投递时让当前循环继续，新入库的回信会按编号排在后面。
    if (this.delivering.has(sessionId)) return;

    //M 同一场会话只开一个投递循环，保证待送回信按编号发送。
    this.delivering.add(sessionId);
    try {
      let lastId = 0;
      const sql = 'SELECT * FROM relay_replies WHERE session_id = ? AND delivered = 0 AND id > ? ORDER BY id LIMIT 1';
      while (true) {
        const params = [sessionId, lastId];

        //M 每次查下一条，包含前一条等待回执时新收到的回信。
        const [reply] = this.query<ReplyRow>(sql, params);
        if (reply === undefined) return;

        //M 依次投递，每轮只尝试每条回信一次。
        await deliver(reply);
        lastId = reply.id;
      }
    } catch (error) {
      console.error(`relay：会话 ${sessionId} 的回信投递出错：${textModule.getErrorMessage(error)}`);
    } finally {
      this.delivering.delete(sessionId);
    }
  }

  /** 决策图确认回信已写入节点后，才把待送记录标成已送。 */
  private async queueDecisionReply(reply: ReplyRow): Promise<void> {
    //G 找不到原收件就保留待送记录，避免错投到同名节点。
    const item = this.getItem(reply.item_id);
    if (item === undefined) return;

    //M 新收件带精确地址；旧收件把原收件键交给决策图解释。
    const prefixLength = DECISION_CHANNEL.length + 1;
    const key = reply.session_id.slice(prefixLength);
    const origin = this.getOrigin(item);
    const stored = utils.getField(origin.address, 'decisionTarget');
    const node = utils.getStringField(stored, 'node');
    const note = utils.getStringField(stored, 'note') || undefined;
    let target: { node: string; note?: string } | undefined;
    if (node !== '') target = { node, note };

    const requestName = 'decision-map/relay-reply';
    const resultName = 'decision-map/relay-replied';
    const payload = { id: reply.id, key, target, text: reply.text };
    const uncertain = '决策图回信写入结果不确定';
    const onFallback = () => ({ requestId: '', ok: false });
    const options = { timeoutMs: 3000, onFallback };

    //M 给写图端持久回信号。晚到或再次核对按同一编号去重。
    const result = await requestEventModule.requestEvent(this.ctx, requestName, resultName, payload, options);
    if (requestEventModule.isUnsure(result)) {
      console.error(`relay：回信 #${String(reply.id)} 的${uncertain}，保留原回信号待对账`);
      return;
    }

    if (!result.ok) {
      if (result.error !== undefined) console.error(`relay：决策图回信写入失败：${result.error}`);
      return;
    }

    const sql = 'UPDATE relay_replies SET delivered = 1 WHERE id = ?';
    const params = [reply.id];
    //M 节点存盘后才结清，崩溃或缺少接收插件时保留补送机会。
    this.run(sql, params);
  }

  /**
   * 对完账以后，这场会话还有没送的回信吗。direct 推会话之前问。
   * @param session 会话。
   * @returns 有没有。
   * 副作用：markWritten 补标已送。
   */
  private hasLeft(session: Session): boolean {
    //M 先对齐原会话里已经写入的回信，避免重复发送。
    this.markWritten(session);

    //M 只查是否还有一条未送回信，用于决定要不要启动会话。
    const left = this.query<{ id: number }>(
      'SELECT id FROM relay_replies WHERE session_id = ? AND delivered = 0 LIMIT 1', [session.id]);
    return left.length > 0;
  }

  /**
   * 一条回信经事件排进走模型的会话，收到成功回执后标已送。
   * @param sessionId 会话号（front 或 work）。
   * @param reply 没送的回信。
   * 副作用：排进结果队列（前台下一拍整理后回原渠道，后台看一轮接着做）；改 relay_replies.delivered。出错只打日志，留着下次送。
   */
  private async queueReply(sessionId: string, reply: ReplyRow): Promise<void> {
    //M 找到回信对应的转发条目，用其中的助手名标注回传来源。
    const item = this.getItem(reply.item_id);
    const helper = item?.helper ?? this.config.helpers[0].name;

    //M 结果：键 relay:<回信号>，同一条重排是 duplicate；来源 relay、id 写助手名（前台看到“外部助手 <名字> 的回信”）；回话地址是那条收件当时记的。
    const key = `relay:${String(reply.id)}`;
    const input: dispatchModule.ResultInput = {
      key,
      sessionId,
      source: { type: 'relay', id: helper },
      payload: { text: `${helper} 回复（#${String(reply.item_id)}）：${reply.text}`, files: [] },
    };
    if (item !== undefined) {
      input.origin = this.getOrigin(item);
    }

    try {
      //M 等机器人确认入队，重复回执也表示同一条已在队列里。
      const delivered = await agentTasksModule.requestResultDelivery(this.ctx, input);

      //G 未确认回执时保留待对账状态，使用原键避免把同一回信写两次。
      if (delivered.uncertain) {
        console.error(`relay：回信 #${String(reply.id)} 的投递结果不确定，保留结果键 ${key} 待对账`);
        return;
      }

      //G 明确投递失败时保留待送状态。
      if (!delivered.ok || delivered.receipt === undefined) {
        const reason = delivered.error ?? '未返回投递凭据';
        console.error(`relay：回信 #${String(reply.id)} 排不进会话 ${sessionId} 的结果队列：${reason}`);
        return;
      }

      const sql = 'UPDATE relay_replies SET delivered = 1 WHERE id = ?';
      const params = [reply.id];

      //M 确认入队后更新源记录。
      this.run(sql, params);
    } catch (error) {
      //M 本地标记失败时保留回信，重试用相同结果键补记。
      console.error(`relay：回信 #${String(reply.id)} 投递或标记失败：${textModule.getErrorMessage(error)}`);
      return;
    }

    //T 跟踪：回信排进结果队列。
    const vars = { replyId: reply.id, inboxId: reply.item_id, session: sessionId, key: key };
    this.ctx.emit('trace', 'Relay.queueReply', 'trace.relay.queueReply', 'bot/request accept-result', vars);
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
    //M 先写出带唯一编号的转发条目，给文件与 webhook 两种投递方式共用。
    const item = this.insert(session, helper.name, text, lastMsgAt);

    //M 追加文件收件箱，供对方轮询取走这条消息。
    fs.appendFileSync(path.join(this.getDir(item.bot), 'inbox.jsonl'), `${JSON.stringify(item)}\n`, 'utf8');

    //M 有 webhook 时同时通知指定助手。
    void this.push(item, helper, session.row.address);

    //T 跟踪：转出一条。
    const vars = { helper: helper.name, inboxId: item.id, session: session.id, channel: item.channel, sender: item.sender, chat: item.chat, length: text.length };
    this.ctx.emit('trace', 'Relay.register', 'trace.relay.register', 'fs.appendFileSync(inbox.jsonl)', vars);
    return item.id;
  }

  /**
   * 插一条收件进表：渠道、地址、谁在哪说的都取会话现在记的。register 和主动发（startProactive）共用。
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
    //M 用原渠道地址补齐发言者和会话类型，随转发条目保存。
    const speaker = this.getSpeaker(row.address);
    let ownerFlag = 0;
    if (speaker.owner) {
      ownerFlag = 1;
    }
    const values = [
      row.bot, helper, session.id, channel, JSON.stringify(row.address ?? null),
      ownerFlag, speaker.sender, speaker.chat, speaker.chatName, text, now, lastMsgAt,
    ];
    //M 把转发与原会话绑定存库，并取得后续对账使用的编号。
    const result = this.run(
      'INSERT INTO relay_items (bot, helper, session_id, channel, address, owner, sender, chat, chat_name,'
        + ' text, at, last_msg_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values);

    //M 拼出待投递的条目与附件清单，交给外部助手。
    return {
      id: Number(result.lastInsertRowid), bot: row.bot, helper, session: session.id, channel, ...speaker,
      text, files: this.getFiles(text), at: local(now), atMs: now, state: 'pending',
    };
  }

  /**
   * 读每个 relay 机器人的 replies.jsonl：从 replies.pos 记的字节往后读，只处理以换行结尾的整行，逐行 accept。
   * 出错的行写进 replies.err.jsonl（带原因），不卡住后面的。读完更新 replies.pos。
   * 副作用：读写文件、写库、推会话。
   */
  private pollFile(): void {
    //M 逐个查看机器人，文件回信只从开启转发的机器人读取。
    for (const bot of this.ctx.bots.list()) {
      if (this.getMode(bot.name) === undefined) continue;
      try {
        //M 单独处理该机器人的新增回信，个别读取失败不妨碍其他机器人。
        this.pollOne(bot.name);
      } catch (error) {
        console.error(`relay：读 ${bot.name} 的回信文件出错：${textModule.getErrorMessage(error)}`);
      }
    }
  }

  /**
   * 读一个机器人的 replies.jsonl。
   * @param bot 机器人名。
   */
  private pollOne(bot: string): void {
    //M 定位机器人的回信文件和读游标，让轮询从上次位置继续。
    const dir = this.getDir(bot);
    const file = path.join(dir, 'replies.jsonl');
    const posFile = path.join(dir, 'replies.pos');
    const size = fs.statSync(file).size;
    let pos = 0;
    if (fs.existsSync(posFile)) {
      pos = Number(fs.readFileSync(posFile, 'utf8').trim());
    }
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
        //M 文件进来的回信也走统一的交回校验和入库。
        this.accept(JSON.parse(line) as unknown, 'file', bot);
      } catch (error) {
        //G 保存坏行与异常原因，便于排查并让后续行继续处理。
        const failed = { line, reason: textModule.getErrorMessage(error), at: local(Date.now()) };
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
    //M 只检查仍在等回信的条目，从最早的开始算超时。
    for (const item of this.query<ItemRow>("SELECT * FROM relay_items WHERE state = 'pending' ORDER BY id", [])) {
      const minutes = (now - item.at) / 60_000;
      const expire = minutes >= this.config.expireMinutes;
      if (!expire && (item.reminded === 1 || minutes < this.config.remindMinutes)) continue;

      let session: Session;
      try {
        //M 恢复等待回信的会话，以便把提醒发回原来的地方。
        session = this.ctx.sessions.open(item.session_id);
      } catch {
        continue;
      }
      //G 会话正在转 → 下一次再说，免得插到这一轮中间。
      if (session.row.state === 'running') continue;

      const shown = String(Math.floor(minutes));
      let text = `${item.helper} 还没回复（#${String(item.id)}，已 ${shown} 分钟），话还在它的收件箱里，回了会接着发给你。`;
      let traceSummary = 'trace.relay.remind';
      if (expire) {
        //M 达到超时上限时结束等待，并记录已提醒。
        this.run("UPDATE relay_items SET state = 'expired', reminded = 1 WHERE id = ?", [item.id]);
        text = `${item.helper} ${shown} 分钟没回（#${String(item.id)}），这条先放下；之后回了还会发给你。`;
        traceSummary = 'trace.relay.expire';
      }
      if (!expire) {
        //M 还没到期时只记已提醒，等待助手继续回复。
        this.run('UPDATE relay_items SET reminded = 1 WHERE id = ?', [item.id]);
      }

      //M 按转发时保存的地址把提醒发回给用户；说话是通知，发出即走（bot/say）。
      this.ctx.bots.route(session, this.getOrigin(item));
      this.ctx.emit('bot/say', session, text);

      //T 跟踪：提醒或放下。
      const vars = { inboxId: item.id, session: item.session_id, minutes: shown };
      this.ctx.emit('trace', 'Relay.checkLate', traceSummary, "ctx.emit('bot/say', session, text)", vars);
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
    let bodyText = text;
    if (quoted !== null) {
      bodyText = text.slice(quoted[0].length);
    }
    //M 聊天号：飞书写 chatId，微信写 chat。
    const chatId = utils.getStringField(address, 'chatId') || utils.getStringField(address, 'chat');
    const body = {
      id: item.id, bot: item.bot, channel: item.channel,
      chat: chatId, chat_type: item.chat, chat_name: item.chatName,
      sender_open_id: utils.getStringField(address, 'openId'), sender: item.sender,
      message_id: utils.getStringField(address, 'messageId'),
      owner: item.owner,
      role: item.role,
      workspace: item.workspace,
      text: bodyText, files: item.files,
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
        result = `推不出去：${textModule.getErrorMessage(error)}`;
      }
    }

    //T 跟踪：推 webhook。
    const vars = { helper: helper.name, inboxId: item.id, chat: body.chat, owner: body.owner, result: result };
    this.ctx.emit('trace', 'Relay.push', 'trace.relay.push', 'fetch(webhook_url)', vars);
  }

  /**
   * 按聊天号找回信该挂的收件，只在 relay 自己记的收件里找，聊天号要一字不差（地址里的 chatId 或 chat 全等，不模糊匹配）：
   * 这个助手在这个聊天有收件就用最近那条；没有就用别的助手在这个聊天最近那条（调用方照它的地址登记一条主动发的）。
   * 不再去 web_messages 按“最近一条”找地址：认错聊天会把回信发给别人（用户的底线：外人看不到用户的私人数据）。
   * @param chat 飞书 chat_id 或微信 chat。
   * @param bot 只找哪个机器人的；不给不限。
   * @param helper 哪个助手的回信。
   * @returns 找到的收件。不改库。
   * @throws failureModule.Failure：relay 在这个聊天没收过件 404。
   */
  private findForChat(chat: string, bot: string | undefined, helper: string): ItemRow {
    //M 聊天号全等：飞书地址写 chatId，微信写 chat（同 push）；这个助手的排前面，再按新旧。
    const sql = "SELECT * FROM relay_items WHERE (json_extract(address, '$.chatId') = ?"
      + " OR json_extract(address, '$.chat') = ?)"
      + ' AND (? IS NULL OR bot = ?) ORDER BY (helper = ?) DESC, id DESC LIMIT 1';
    const values = [chat, chat, bot ?? null, bot ?? null, helper];
    const found = this.query<ItemRow>(sql, values)[0];
    if (found === undefined) {
      const message = `relay 没在聊天 ${chat} 收过件，找不到回话地址（只认 relay 自己记的收件，聊天号要一字不差）；用收件号 id 回`;
      throw new failureModule.Failure(404, message);
    }

    return found;
  }

  /**
   * 主动发：开（或找回）这个机器人的 relay 会话，照那条收件记的渠道和地址 route，再登记一条“主动发”的收件。
   * @param from findForChat 找到的、同一个聊天里别的助手的收件。
   * @param helper 主动发的助手。
   * @returns 新登记的收件。
   * 副作用：可能新开会话；改会话的回话地址；写一条收件。
   */
  private startProactive(from: ItemRow, helper: string): ItemRow {
    //G 那条收件没记渠道：route 改不了地址，会话还停在别的聊天上，登记下去会发错人。
    if (from.channel === '') {
      throw new failureModule.Failure(404, `收件 #${String(from.id)} 没记渠道，借不了它的地址主动发；用收件号 id 回`);
    }

    //M 复用或创建转发会话，并接回原条目的渠道地址。
    const session = this.openOrCreateSession(from.bot, 'relay');
    const origin = this.getOrigin(from);
    this.ctx.bots.route(session, origin);

    //M 生成主动回信对应的转发记录，返回后续投递所需的数据库行。
    const inserted = this.insert(session, helper, `（${helper} 主动发）`, null);
    return this.getItem(inserted.id)!;
  }

  /**
   * 回信带的文件落到哪：相对数据目录或绝对路径，解开链接以后只许在这个机器人的工作区（bots/<机器人>/workspace、
   * workspaces 插件的 bots/<机器人>/workspaces）或 relay 给它的目录（integrations/relay/<机器人>）里面，而且要是文件。
   * @param bot 收件的机器人。
   * @param file 回信写的路径。
   * @returns 解开链接后的绝对路径。
   * @throws failureModule.Failure 400：出了范围（../、别的盘、链接指出去）、不在、不是文件。
   */
  private getReplyFile(bot: string, file: string): string {
    const root = this.ctx.resources.root;
    const full = path.resolve(root, file);

    //M 许可的目录：机器人的工作区（假机器人可能没有）、它的多个工作区、relay 给它的目录。
    const dirs: string[] = [];
    const workspace = this.ctx.bots.get(bot)?.workspace;
    if (workspace !== undefined) {
      dirs.push(workspace);
    }

    //M 追加该机器人的会话工作区与转发目录作为候选附件根。
    dirs.push(path.join(root, 'bots', bot, 'workspaces'));
    dirs.push(path.join(root, 'integrations', 'relay', bot));

    //M 挨个看落不落在里面（utils/Workspace.ts 的 inside：解开链接再比，出去了抛错）。
    let real: string | undefined;
    for (const dir of dirs) {
      try {
        real = workspaceModule.resolveWorkspacePath(dir, full);
        break;
      } catch {
        //M 不在这个目录里：看下一个。
        continue;
      }
    }
    if (real === undefined) {
      //G 没有一个候选根能容纳该文件时，拒绝分发并提示允许的位置。
      throw new failureModule.Failure(400, `回信带的文件只能在机器人 ${bot} 的工作区或 integrations/relay/${bot}/ 里：${file}`);
    }

    //G 要是一个在的文件。
    if (!fs.existsSync(real) || !fs.statSync(real).isFile()) {
      throw new failureModule.Failure(400, `回信带的文件不在：${file}`);
    }
    return real;
  }

  /**
   * 回信带的文件：飞书收件就用飞书插件上传后发到那个聊天（挂在 messageId 那条下面）；别的渠道暂不支持，只记 trace。
   * @param item 收件。
   * @param full 文件的绝对路径（getReplyFile 查过范围）。
   */
  private async sendFile(item: ItemRow, full: string): Promise<void> {
    const where = JSON.parse(item.address) as { appId?: string; chatId?: string; messageId?: string } | null;
    const channelName = item.channel || '（没有）';
    let result = `没发出去：渠道 ${channelName} 还不支持发文件`;

    if (item.channel === 'feishu' && where?.chatId !== undefined) {
      const request = {
        bot: item.bot,
        chatId: where.chatId,
        filePath: full,
        appId: where.appId,
        messageId: where.messageId,
      };
      const reasons: Record<requestEventModule.FallbackReason, string> = {
        unhandled: '飞书插件没挂，没人接发文件的请求',
        timeout: '等了 30 秒飞书没回',
        aborted: '请求被中止',
        error: '飞书处理时出错',
      };
      const onFallback = (reason: requestEventModule.FallbackReason, detail?: string) => {
        const error = `${reasons[reason]} ${detail ?? ''}`.trim();
        return { requestId: '', ok: false, error };
      };
      const options = {
        prefix: 'sf',
        timeoutMs: 30_000,
        onFallback,
      };

      //M 等飞书回执。超时可能已经发送，只记录结果不确定。
      const received = await requestEventModule.requestEvent(
        this.ctx,
        'feishu/send-file',
        'feishu/send-file-result',
        request,
        options,
      );
      result = `没发出去：${received.error ?? '原因不明'}`;
      if (requestEventModule.isUnsure(received)) {
        result = `飞书文件发送结果不确定：${received.error ?? '未获回执'}`;
      }
      if (received.ok) {
        result = `已发 ${received.messageId ?? ''}`;
      }
    }

    //T 跟踪：回信带的文件。
    const vars = { helper: item.helper, inboxId: item.id, file: full, result: result };
    const people = 'trace.relay.sendFile';
    const code = "requestEvent(ctx, 'feishu/send-file', 'feishu/send-file-result', request, options)";
    this.ctx.emit('trace', 'Relay.sendFile', people, code, vars);
  }

  /** 登记工具 relay_send：开了 model 的那种聊天里，模型用它把话转给默认助手（helpers 的第一个）。 */
  private registerTool(): void {
    const main = this.config.helpers[0];
    const helper = main.name;
    //M 用默认助手注册模型侧转话工具，供允许转发的会话使用。
    this.ctx.tools.register({
      definition: {
        name: 'relay_send',
        description: `把话转给外部助手 ${helper}。它大约每 5 分钟看一次，回信会作为新的一句话交回这场会话。`
          + `用户要找 ${helper}、或者要 ${helper} 帮忙时用；${this.whenToRelay()}`,
        parameters: piAi.Type.Object({
          text: piAi.Type.String({ description: `要转给 ${helper} 的话：用户原话一字不改，或你整理好的问题` }),
        }),
      },
      sessionKinds: ['front', 'work'],
      run: (args, session) => {
        //G 调用时再确认会话允许模型转发，避免普通会话误用工具。
        if (this.sessionMode(session) !== 'model') {
          throw new Error(`这场会话不能用 relay_send（机器人 ${session.row.bot} 没写 relay: model，这个群也没登记 relay: model）`);
        }
        const text = String(args['text']).trim();
        if (text === '') throw new Error('text 不能是空的');

        //M 登记转发并返回任务号，方便模型告诉用户回信将送去哪里。
        const id = this.register(session, main, text, null);
        return `已转给 ${helper}（#${String(id)}），它大约每 5 分钟看一次，回信会作为新的一句话交回这场会话`;
      },
    });
  }

  /**
   * 一句“程序说的”回答：长得像模型的回答，提供方写 relay，模型写机器人名（网页回话的生成依据显示 relay/机器人）。
   * @param bot 机器人名。
   * @param text 要说的话。
   * @param replyId 这句是哪条回信（relay_replies.id）：记在回答的 relayReplyId 上，跟着对话存盘，markWritten 照它对账；不是回信不写。
   * @returns 填进 request.answer 的 AssistantMessage。content 放转话文字，provider 和 model 标记来源。
   */
  private said(bot: string, text: string, replyId?: number): piAi.AssistantMessage {
    const answer: piAi.AssistantMessage & { relayReplyId?: number } = {
      ...piAi.fauxAssistantMessage(text),
      provider: 'relay',
      model: bot,
    };
    if (replyId !== undefined) {
      answer.relayReplyId = replyId;
    }
    return answer;
  }

  /**
   * 对一遍账：这场会话还没标已送、但对话里已经有它的回答（回答带 relayReplyId）的回信，补标已送。
   * 骨架先把回答接进对话、存盘（Session.append），再发 session/change；标已送放在这之后，中间断了下次对账补标，不会再送一次。
   * @param session 会话。
   * 副作用：改 relay_replies.delivered。
   */
  private markWritten(session: Session): void {
    //M 对话里已经写进去的回信号。
    const written = new Set<number>();
    for (const message of session.row.messages) {
      const replyId = (message as { relayReplyId?: unknown }).relayReplyId;
      if (typeof replyId === 'number') {
        written.add(replyId);
      }
    }
    if (written.size === 0) return;

    //M 没标已送的里面，写进去了的补标。
    const pendingSql = 'SELECT id FROM relay_replies WHERE session_id = ? AND delivered = 0';
    const pending = this.query<{ id: number }>(pendingSql, [session.id]);
    for (const reply of pending) {
      if (!written.has(reply.id)) continue;

      //M 已写进会话的回信补记为已送，避免服务重启后重投。
      this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [reply.id]);
    }
  }

  /**
   * 收件当时记的渠道和地址。
   * @param item 收件。
   * @returns 给 bots.route、bot.hand 的 origin；当时没有渠道就是空的（不改会话原来记的）。
   */
  private getOrigin(item: ItemRow): Origin {
    if (item.channel === '') return {};
    return { channel: item.channel, address: JSON.parse(item.address) as unknown };
  }

  /**
   * 一个机器人的收件夹：运行时目录 integrations/relay/<机器人>/，里面的 inbox.jsonl、replies.jsonl 没有就建空的。
   * @param bot 机器人名。
   * @returns 绝对路径。
   */
  private getDir(bot: string): string {
    //M 按机器人定位文件通道目录，后面确保收件与回信文件可用。
    const dir = this.ctx.resources.ensureRuntimeDir('integrations', 'relay', bot);
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
  private getFiles(text: string): string[] {
    const root = this.ctx.resources.root;
    const files: string[] = [];
    //M 从转发文本提取候选附件，再筛出运行时目录中的绝对路径。
    for (const file of imageModule.getAtPaths(text)) {
      //G 不是绝对路径（@人）、不在运行时目录里（别的盘、上一层）→ 不算附件。
      if (!path.isAbsolute(file)) continue;
      const relative = path.relative(root, file);
      const up = relative === '..' || relative.startsWith(`..${path.sep}`);
      if (relative === '' || up || path.isAbsolute(relative)) continue;

      //M 传相对运行时目录的正斜杠路径，供外部助手定位附件。
      files.push(relative.split(path.sep).join('/'));
    }
    return files;
  }

  /**
   * 取一条收件。
   * @param id 收件号。
   * @returns 没有是 undefined。
   */
  private getItem(id: number): ItemRow | undefined {
    //M 用全局转发号读取条目，供回信关联原会话。
    return this.query<ItemRow>('SELECT * FROM relay_items WHERE id = ?', [id])[0];
  }

  /**
   * 表里的一行 → 对外的样子。
   * @param row 表里的一行。
   * @returns 收件。
   */
  private view(row: ItemRow): InboxItem {
    //M 哪一档、builder 的目录：收件存了原样的回话地址，照它现读，不另加栏。
    const { role, workspace } = this.getSpeaker(JSON.parse(row.address) as unknown);
    //M 轮询只回本人布尔值，不序列化渠道回话地址或说话人的原始标识。
    const owner = row.owner === 1;
    let repliedAt: string | null = null;
    if (row.replied_at !== null) {
      repliedAt = local(row.replied_at);
    }
    return {
      id: row.id,
      bot: row.bot,
      helper: row.helper,
      session: row.session_id,
      channel: row.channel,
      owner,
      role,
      workspace,
      sender: row.sender,
      chat: row.chat,
      chatName: row.chat_name,
      text: row.text,
      files: this.getFiles(row.text),
      at: local(row.at),
      atMs: row.at,
      state: row.state,
      repliedAt,
    };
  }

  /**
   * 查库。
   * @param sql 语句。
   * @param values 参数。
   * @returns 查到的行。
   */
  private query<T>(sql: string, values: (string | number | null)[]): T[] {
    //M 统一绑定查询参数，返回调用方需要的转发表行。
    return this.ctx.resources.db.query(sql).all(...values) as T[];
  }

  /**
   * 改库。
   * @param sql 语句。
   * @param values 参数。
   * @returns 改了几行、新行的号。
   */
  private run(sql: string, values: (string | number | null)[]): { lastInsertRowid: number | bigint } {
    //M 统一绑定写入参数，给新增记录的调用方返回行号。
    return this.ctx.resources.db.query(sql).run(...values);
  }
}


/**
 * 挂上 relay。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务
 * （resources、sessions、bots）都就绪，再调一次 apply(ctx, 配置)。插件通过 ctx 听事件、登记工具和定时器，
 * 插件被拔掉时这些登记自动撤掉。详见 plugins/Index.ts 的 PluginModule。
 * 先后：写在 http、fake-model 后面，model-fallback 前面（session/before-model、bot/receive 照挂的先后挨个问）。
 *   前台在 bots 里：bot/receive 问完了没人认领才轮到前台，所以 relay 的认领总在前台前面。
 * 挂两样：转话（写了 helpers 才挂）和任务通道（http 就绪后挂）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config config.yaml 的 plugins 段里写给它的：helpers（要转话才写，每项 name、prefixes，可写 webhook_url、
 *   webhook_header，第一个是默认助手）、bots、remind_minutes、expire_minutes、poll_seconds；tasks（任务通道，{ scan_ms }）。
 *   旧的 owner_open_ids 这里不读：feishu 插件校验配置时把它并进 people（本人只在飞书插件判断）。
 * @throws 配置写得不对、helpers 写了但是空的、名单项 relay 写了别的值、tasks.scan_ms 不对时抛错。
 */
export function apply(ctx: cordis.Context, config: RelayWritten | undefined): void {
  //M 插件的配置是外面进来的，在这里校验一次：任务通道的 tasks 子键先查，写错了整个插件不挂。
  const written = config ?? {};
  const scanMs = agentTasksModule.getScanMs(written.tasks);

  //M 写了 helpers 才挂转话，配置写错就抛错；只用任务通道时可以省略 helpers。
  if (written.helpers !== undefined) {
    applyRelay(ctx, written);
  }

  //M 外部 AI 任务通道等 http 就绪，交回的投递依赖机器人事件应答。
  void ctx.inject(agentTasksModule.TASKS_INJECT, (sub) => {
    agentTasksModule.applyAgentTasks(sub, scanMs);
  });
}


/** config.yaml 里写给 relay 的（还没查）。 */
interface RelayWritten {
  /** 多久没回提醒一次，分钟。 */
  remind_minutes?: unknown;
  /** 多久没回先放下，分钟。 */
  expire_minutes?: unknown;
  /** 多久读一次 replies.jsonl，秒。 */
  poll_seconds?: unknown;
  /** 外部助手；不写就不挂转话。 */
  helpers?: unknown;
  /** 这些机器人的话全部直接转。 */
  bots?: unknown;
  /** 旧写法：本人的 open_id，飞书插件读。 */
  owner_open_ids?: unknown;
  /** 任务通道：{ scan_ms }，见 AgentTasks.ts 的 getScanMs。 */
  tasks?: unknown;
}


/**
 * 挂上转话：查 helpers 等配置，建 Relay（登记 relay_send、听 bot/receive 和 session/before-model、两条接口、定时读回信）。
 * @param ctx relay 的 ctx。
 * @param written config.yaml 里写给 relay 的（apply 查过写了 helpers）。
 * @throws helpers 是空的、名字重复、前缀有空串，别的项写得不对时抛错，插件不挂。
 */
function applyRelay(ctx: cordis.Context, written: RelayWritten): void {
  const positive = (value: unknown, fallback: number, key: string): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !(value > 0)) throw new Error(`relay 的 ${key} 要写成正数`);
    return value;
  };

  const list = (value: unknown, fallback: string[], key: string): string[] => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) {
      throw new Error(`relay 的 ${key} 要写成字符串列表`);
    }
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
    let one: Record<string, unknown> = {};
    if (typeof entry === 'object' && entry !== null) {
      one = entry as Record<string, unknown>;
    }
    const name = one['name'];
    if (typeof name !== 'string' || name.trim() === '' || helpers.some((known) => known.name === name)) {
      throw new Error('relay 的 helpers 每项要写 name，名字不能重复');
    }

    //G 校验助手的前缀列表，后面再排除会匹配所有消息的空项。
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

  //M 用已校验的助手和时间参数启动转发服务，登记监听和回信轮询。
  new Relay(ctx, {
    remindMinutes: positive(written.remind_minutes, 15, 'remind_minutes'),
    expireMinutes: positive(written.expire_minutes, 120, 'expire_minutes'),
    pollSeconds: positive(written.poll_seconds, 2, 'poll_seconds'),
    //M 上面查过 helpers 至少一项，每项不是进了名单就是抛错了。
    helpers: helpers as [Helper, ...Helper[]],
    bots: list(written.bots, [], 'bots'),
  });
}
