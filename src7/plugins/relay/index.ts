/**
 * relay：一个不调模型的机器人，把用户的话转给外部助手，等它回信再回给用户。
 * 接哪些外部助手全看配置 helpers：每项一个（名字、前缀、webhook），第一个是默认的。代码里不写死任何助手。
 * 用户在网页、飞书上给标了 relay 的机器人发话，或者在任何机器人里以某个助手的前缀开头：
 *   direct 模式：不调模型。每一轮写一行进收件箱 inbox.jsonl，当场回“已转给 <助手>（#号），等回复”，这一轮就结束；
 *               外部助手回信（写 replies.jsonl 一行，或 POST /api/relay/reply），本插件再推一次这场会话，
 *               把回信当回答填进去，渠道照当时记的渠道和地址发回给用户；飞书真回复发出后异步撤回原“已转给”占位消息。
 *   model 模式：照常走模型，模型用工具 relay_send 转话（只转给默认助手）；回信作为一句新的用户话交回那场会话，由模型转述。
 *
 * 子模块分工：
 *   Receive.ts   入站收话三条直路分流、前缀匹配、说话人身份与 webhook 载荷拼装；
 *   Files.ts     文件收发目录、附件路径提取、回信文件范围校验与配置解析；
 *   Decision.ts  工作决策台（work-decision）选择与留言收件归档；
 *   AgentTasks.ts 外部 AI 任务与单向留言通道（/api/agents*）。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as botUtils from '../../utils/Bots.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import type * as dispatchModule from '../bots/Dispatch.ts';
import type { Origin, ReceiveEvent } from '../bots/index.ts';
import * as channels from '../channels/index.ts';
import type * as dbModule from '../db/index.ts';
import * as agentTasksModule from './AgentTasks.ts';
import * as decisionModule from './Decision.ts';
import * as filesModule from './Files.ts';
import tablesSql from './migrations/0000_relay_tables.sql' with { type: 'text' };
import helperSql from './migrations/0001_relay_helper.sql' with { type: 'text' };
import speakerSql from './migrations/0002_relay_speaker.sql' with { type: 'text' };
import ackSql from './migrations/0003_relay_ack.sql' with { type: 'text' };
import * as receiveModule from './Receive.ts';
import * as routesModule from './Routes.ts';


/** 插件名。 */
export const name = 'relay';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.4.9：决策回信只用收件保存的精确目标，拒绝旧的本人身份配置键。
//M 1.5.1：已定选项的收件结果按请求号回发。
//M 1.5.2：结果投递、决策图回信、发文件使用 reply 或 why；本机请求等回执，飞书发文件暂用原等待上限。
//M 1.5.3：收件与回信表改走 db 迁移账本（adoptColumn 接管旧列），旧行补值标 //退场：；Relay 构造函数瘦身为纯登记。
//M 1.5.4：helpers 支持可选展示名 title（内部名 name 不变）；预留 address.relayHelper 群攒批静默转交入口。
//M 1.5.5：prefixed 跳过引用及前导 @提及与空白；中文结尾前缀允许直接紧跟英文字母或数字（如“哈基米a OBB”）。
//M 1.5.6：飞书真回复发出后异步温和撤回“已转给”占位消息（ack_message_id）；收话分流、文件与决策辅助拆入独立子模块瘦身。
//M 1.5.7：飞书发文件、撤回占位不再自己掐表（原 30 秒、15 秒），飞书自己限时 60 秒、到点回执；删“等待回执超时”分支（云端 31 第 2 条）。
//M 1.5.8：新增可选 owner_p2p_direct 配置，仅本人私聊指定机器人且未命中其他显式前缀时免前缀直通指定外部助手。
//M 1.5.9：新增 exclusive_bots（机器人独占直通）与 owner_group_direct（受信私人群免前缀直通）；
//M   POST /api/relay/reply 与 accept 支持可选 alsoCloseIds 静默闭环同聊天同机器人旧 pending 收件并撤回飞书占位；
//M   remind_minutes 与 expire_minutes 允许填 0 且默认 0（彻底禁用超时催促与过期放下）。
export const version = '1.5.9';

/** 用到的服务。db 负责收件与回信表的版本迁移和事务；http 是可选的：用到时 ctx.get 现取。 */
export const inject = ['resources', 'tools', 'sessions', 'bots', 'db'];


/** 名单项里 relay 的两种写法：direct 不调模型直接转；model 照常走模型，模型用 relay_send 转。 */
export type RelayMode = 'direct' | 'model';

/** 聊天种类：p2p 私聊（网页、接口也算），group 群聊。 */
export type ChatKind = 'p2p' | 'group';


/** 一个外部助手。 */
export interface Helper {
  /** 内部标识：收件表 helper 列、查询筛选与回信核对都用它。 */
  name: string;
  /** 给用户和模型看的展示名；没写配置时等于 name。 */
  title: string;
  /** 任何机器人里以这些开头的话转给它，进这个机器人的 relay 会话（kind relay），不交给模型。 */
  prefixes: string[];
  /** 转出时 POST 到这里（它的 webhook）；空串不推，它自己来读收件箱。 */
  webhookUrl: string;
  /** POST 时的鉴权头原文；发送前由 webhookAuthHeaders 收成请求头。 */
  webhookHeader: string;
}


/** 仅本人私聊指定机器人时免前缀直通某个外部助手的规则。 */
export interface OwnerP2pDirectRule {
  /** 目标机器人名字（不可重复）。 */
  bot: string;
  /** 默认投递的外部助手名字（必须在 helpers 中存在）。 */
  helper: string;
}


/** 指定机器人独占直通某个外部助手的规则（不走本地模型、不受其他助手前缀劫持）。 */
export interface ExclusiveBotRule {
  /** 目标机器人名字（不可重复）。 */
  bot: string;
  /** 独占绑定的外部助手名字（必须在 helpers 中存在）。 */
  helper: string;
}


/** 仅本人在指定受信群发给指定机器人时免前缀直通某个外部助手的规则。 */
export interface OwnerGroupDirectRule {
  /** 目标群号（飞书 chat_id，同机器人下不可重复）。 */
  chatId: string;
  /** 目标机器人名字。 */
  bot: string;
  /** 默认投递的外部助手名字（必须在 helpers 中存在）。 */
  helper: string;
}


/** apply 校验好以后给 Relay 的东西。 */
export interface RelayConfig {
  /** 多久没回提醒一次，分钟；0 表示彻底禁用催促提醒。 */
  remindMinutes: number;
  /** 多久没回就说“先放下”，分钟；0 表示彻底禁用过期放下，之后回了照样送到。 */
  expireMinutes: number;
  /** 多久读一次 replies.jsonl，秒。 */
  pollSeconds: number;
  /** 外部助手。第一个是默认的。 */
  helpers: [Helper, ...Helper[]];
  /** 这些机器人的话全部直接转（等于名单项写 relay: direct）。 */
  bots: string[];
  /** 仅本人私聊（p2p + owner=true + 非 listenOnly）发给指定机器人时，未命中其他显式前缀也直通对应助手。 */
  ownerP2pDirect: OwnerP2pDirectRule[];
  /** 独占直通规则：目标机器人非 listenOnly 消息全部直进 relay 会话并最高优先级锁定对应助手。 */
  exclusiveBots: ExclusiveBotRule[];
  /** 受信私人群直通规则：仅本人在指定群发给指定机器人且非 listenOnly 时免前缀直通对应助手。 */
  ownerGroupDirect: OwnerGroupDirectRule[];
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
  /** 是不是用户本人说的。 */
  owner: boolean;
  /** 说话人是哪一档：owner、builder、guest 或 ''。 */
  role: string;
  /** builder 的目录；别的档、别的渠道是 ''。 */
  workspace: string;
  /** 说话人显示名。 */
  sender: string;
  /** 在哪说的：p2p 私聊，group 群聊。 */
  chat: ChatKind;
  /** 群名；私聊是 ''。 */
  chatName: string;
  /** 用户的话；一轮里排着的几句用空行连起来。 */
  text: string;
  /** 这条带的附件（相对运行时目录路径）。 */
  files: string[];
  /** 什么时候转出的，本地时间字符串。 */
  at: string;
  /** 同上，毫秒时间戳。 */
  atMs: number;
  /** pending 没回完；replied 回完了；expired 太久没回先放下了。 */
  state: 'pending' | 'replied' | 'expired';
  /** 回完的时间（只有接口给）；没回完是 null。 */
  repliedAt?: string | null;
}

/** 收件里“谁、在哪说的”那几项。 */
export type Speaker = Pick<InboxItem, 'owner' | 'role' | 'workspace' | 'sender' | 'chat' | 'chatName'>;


/** 表 relay_items 的一行。 */
interface ItemRow {
  id: number;
  bot: string;
  helper: string;
  session_id: string;
  channel: string;
  address: string;
  owner: number;
  sender: string;
  chat: ChatKind;
  chat_name: string;
  text: string;
  at: number;
  last_msg_at: number | null;
  state: InboxItem['state'];
  reminded: number;
  replied_at: number | null;
  ack_message_id: string;
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

/** sendTo 附加的占位记录或真回复撤回关联信息。 */
interface SendTurnMeta {
  /** 本轮发的是收件 #id 的“已转给”占位提示（发出后保存其平台 messageId）。 */
  ackItemId?: number;
  /** 本轮发的是收件 #id 的真回复（发成后触发撤回原占位消息）。 */
  replyItemId?: number;
}


/** 查超时隔多久查一次，毫秒。 */
const CHECK_MS = 30_000;

/** relay 收件与回信表的迁移计划：接管旧栏并新增 ack_message_id 占位消息号栏。 */
const relayMigrations: dbModule.MigrationPlan = {
  plugin: name,
  migrations: [
    { version: 1, sql: tablesSql },
    {
      version: 2,
      sql: helperSql,
      adoptColumn: { table: 'relay_items', name: 'helper' },
    },
    {
      version: 3,
      sql: speakerSql,
      adoptColumn: { table: 'relay_items', name: 'sender' },
    },
    {
      version: 4,
      sql: ackSql,
      adoptColumn: { table: 'relay_items', name: 'ack_message_id' },
    },
  ],
};

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


/** relay 插件本体。只由 apply 来建。 */
export class Relay {
  /** direct 会话这一轮在送哪条回信：会话号 → 回信号（onRequest 记）。 */
  private readonly answering = new Map<string, number>();
  /** direct 会话这一轮真回复关联哪条收件：会话号 → 收件号（用于发成后撤回原占位消息）。 */
  private readonly replyingItem = new Map<string, number>();
  /** direct 会话这一轮正在发哪条收件的“已转给”占位提示：会话号 → 收件号。 */
  private readonly ackingItem = new Map<string, number>();
  /** direct 会话这一轮的回答发到哪：会话号 → 渠道和地址。 */
  private readonly answerTo = new Map<string, Origin>();
  /** 正在向结果队列投递的会话，按每场会话的回信顺序排队。 */
  private readonly delivering = new Set<string>();

  /**
   * 建表；建目录；挂三个会话监听、工作决策监听、HTTP 接口与 relay_send 工具；开两个定时器。
   */
  constructor(private readonly ctx: cordis.Context, readonly config: RelayConfig) {
    this.ctx.db.migrate(relayMigrations);
    this.migrateOldItems();

    for (const bot of botUtils.getBotConfigs(this.ctx.resources.raw)) {
      if (this.hasBotRelayDir(bot.name)) {
        filesModule.ensureBotRelayDir(this.ctx.resources, bot.name);
      }
    }

    this.ctx.on('bot/receive', (event) => this.onReceive(event));
    this.ctx.on('session/before-model', (request) => this.onRequest(request));
    this.ctx.on('session/change', (session) => this.onChange(session));

    const http = this.ctx.get('http');
    if (http !== undefined) {
      routesModule.routes(http, this);
    }
    void this.ctx.inject(['flow'], (sub) => {
      sub.effect(() => sub.flow.state('relay', () => this.stateForFlow(), FLOW_NOTES));
    });

    this.registerTool();

    const decisionOptions = {
      filter: (decision: requestEventModule.EventArg<'work-decision/decided'>) => decision.asker.kind === 'helper',
    };
    requestEventModule.onRequestEvent(
      this.ctx,
      'work-decision/decided',
      'work-decision/decided-result',
      (decision) => this.onDecisionChosen(decision),
      decisionOptions,
    );
    const noteOptions = {
      filter: (request: requestEventModule.EventArg<'work-decision/note'>) => request.action !== 'reply',
    };
    requestEventModule.onRequestEvent(
      this.ctx,
      'work-decision/note',
      'work-decision/note-result',
      (request) => this.receiveDecision(request),
      noteOptions,
    );

    this.ctx.effect(() => this.startTimers());
    this.ctx.on('ready', () => this.onReady());
  }

  //退场：所有运行时的 relay_items 旧行都补完 helper 和 chat 以后
  /** 给刚由迁移补上列的旧收件填上默认助手与说话人信息。 */
  private migrateOldItems(): void {
    this.ctx.db.transaction(() => {
      const defaultHelper = this.config.helpers[0].name;
      this.run("UPDATE relay_items SET helper = ? WHERE helper = ''", [defaultHelper]);
      this.fillSpeakers();
    });
  }

  //退场：所有运行时的 relay_items 旧行都补完 helper 和 chat 以后
  /** 老库补栏时，照每条尚未填 chat 的收件记的回话地址补上谁、在哪说的。 */
  private fillSpeakers(): void {
    const rows = this.query<{ id: number; address: string }>("SELECT id, address FROM relay_items WHERE chat = ''", []);
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.address);
      const speaker = receiveModule.getSpeaker(parsed);
      let ownerFlag = 0;
      if (speaker.owner) {
        ownerFlag = 1;
      }
      const values = [ownerFlag, speaker.sender, speaker.chat, speaker.chatName, row.id];
      this.run('UPDATE relay_items SET owner = ?, sender = ?, chat = ?, chat_name = ? WHERE id = ?', values);
    }
  }

  /** 把工作决策里属于外部助手的用户选择收进 relay 收件箱。 */
  private onDecisionChosen(decision: requestEventModule.EventArg<'work-decision/decided'>) {
    if (decision.asker.kind !== 'helper') return { ok: false };

    return this.receiveDecision({
      action: 'deliver' as const,
      node: decision.key,
      helper: decision.asker.name,
      text: decision.text,
      target: { node: decision.node, note: decision.note },
    });
  }

  /** 启动轮询回信文件与超时检查两个定时器，返回拔插件时的清理函数。 */
  private startTimers(): () => void {
    const pollMs = this.config.pollSeconds * 1000;
    const poll = setInterval(() => {
      this.pollFile();
    }, pollMs);
    const late = setInterval(() => {
      this.checkLate();
    }, CHECK_MS);
    return () => {
      clearInterval(poll);
      clearInterval(late);
    };
  }

  /** 插件全部挂完后，把上次没送出的回信补送一遍，并首读一次回信文件。 */
  private onReady(): void {
    const sql = 'SELECT DISTINCT r.session_id, i.channel FROM relay_replies r'
      + ' JOIN relay_items i ON i.id = r.item_id WHERE r.delivered = 0';
    const rows = this.query<{ session_id: string; channel: string }>(sql, []);
    for (const row of rows) {
      void this.deliverSoon(row.session_id, row.channel);
    }
    this.pollFile();
  }

  /** 给 /flow/ 看的运行时变量。 */
  private stateForFlow(): Record<string, unknown> {
    const countSql = "SELECT COUNT(*) AS count FROM relay_items WHERE state = 'pending'";
    const pending = this.query<{ count: number }>(countSql, []);
    const last = this.query<{ last: number | null }>('SELECT MAX(id) AS last FROM relay_items', []);
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

  /** 取外部助手面向用户与模型的展示名；找不到登记项时回退内部名。 */
  private getTitle(name: string): string {
    const found = this.config.helpers.find((one) => one.name === name);
    return found?.title ?? name;
  }

  /** 这个机器人是不是 relay 机器人、哪种（direct / model / undefined）。 */
  getMode(bot: string): RelayMode | undefined {
    if (this.config.bots.includes(bot)) return 'direct';

    return botUtils.getBotConfig(this.ctx.resources.raw, bot)?.['relay'] as RelayMode | undefined;
  }

  /** 这个机器人是否启用了文件收发目录与 replies.jsonl 轮询（含 exclusive_bots、owner_p2p_direct 与 owner_group_direct 指定的机器人）。 */
  private hasBotRelayDir(bot: string): boolean {
    if (this.getMode(bot) !== undefined) return true;
    if (this.config.exclusiveBots.some((rule) => rule.bot === bot)) return true;
    if (this.config.ownerP2pDirect.some((rule) => rule.bot === bot)) return true;

    return this.config.ownerGroupDirect.some((rule) => rule.bot === bot);
  }

  /** 这场会话怎么转：先看机器人；机器人没写再看飞书群地址里的 relay: model。 */
  private sessionMode(session: Session): RelayMode | undefined {
    const row = session.row;
    const byBot = this.getMode(row.bot);
    if (byBot !== undefined) return byBot;
    if (utils.getField(row.address, 'relay') === 'model') return 'model';

    return undefined;
  }

  /** 这句话以哪个外部助手的前缀开头。 */
  private prefixed(text: string): Helper | undefined {
    return receiveModule.matchHelperPrefix(this.config.helpers, text);
  }

  /** 这场会话是不是“直接转”的顶层会话。 */
  private direct(session: Session): boolean {
    const row = session.row;
    return row.parent === undefined && (row.kind === 'relay' || this.sessionMode(session) === 'direct');
  }

  /** 列收件，接口 GET /api/relay/inbox 用。 */
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

  /** 收下一条回信（replies.jsonl 与 POST /api/relay/reply 共用）。 */
  accept(input: unknown, via: 'file' | 'http', bot?: string): InboxItem {
    let body: Record<string, unknown> = {};
    if (typeof input === 'object' && input !== null) {
      body = input as Record<string, unknown>;
    }
    const helper = body['helper'] ?? this.config.helpers[0].name;
    if (typeof helper !== 'string' || !this.config.helpers.some((one) => one.name === helper)) {
      const names = this.config.helpers.map((one) => one.name).join('、');
      throw new failureModule.Failure(400, `helper 只能写接着的助手：${names}`);
    }

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

    const alsoCloseInput = this.parseAlsoCloseIds(body['alsoCloseIds']);

    const id = body['id'];
    const chat = body['chat'];
    const byChat = (id === undefined || id === null) && typeof chat === 'string' && chat !== '';
    if (!byChat && (typeof id !== 'number' || !Number.isInteger(id) || id < 1)) {
      throw new failureModule.Failure(400, 'id 要写成正整数（收件号），或者给 chat');
    }

    let chatBot = bot;
    if (chatBot === undefined && typeof body['bot'] === 'string') {
      chatBot = body['bot'];
    }

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

    const proactive = byChat && item.helper !== helper;
    if (!proactive && body['helper'] !== undefined && item.helper !== helper) {
      throw new failureModule.Failure(400, `收件 #${String(item.id)} 是转给 ${item.helper} 的，helper 写的是 ${helper}`);
    }

    let fileFull: string | undefined;
    if (typeof file === 'string') {
      fileFull = filesModule.resolveAllowedReplyFile(this.ctx.resources, item.bot, file);
    }

    //M 在写库前校验完 alsoCloseIds 存在性与助手/机器人/同聊天安全边界，确保校验失败不留半套写入。
    let targetHelper = item.helper;
    let primaryIdForDedup: number | undefined = item.id;
    if (proactive) {
      targetHelper = helper;
      primaryIdForDedup = undefined;
    }
    const extraItems = this.resolveAlsoCloseItems(alsoCloseInput, primaryIdForDedup, targetHelper, item, bot);

    if (proactive) {
      item = this.startProactive(item, helper);
    }
    const itemId = item.id;

    const replyTo = body['reply_to'];
    const now = Date.now();
    let doneFlag = 0;
    if (done) {
      doneFlag = 1;
    }

    //M 主回信写入与 alsoCloseIds 静默闭环在同一数据库事务内提交，不插多余 relay_replies、不发重复飞书回复。
    const recallExtras: { item: ItemRow; ackMsgId: string }[] = [];
    this.ctx.db.transaction(() => {
      if (typeof replyTo === 'string' && replyTo !== '') {
        const updateSql = "UPDATE relay_items SET address = json_set(address, '$.messageId', ?)"
          + " WHERE id = ? AND address LIKE '{%'";
        this.run(updateSql, [replyTo, itemId]);
      }

      this.run(
        'INSERT INTO relay_replies (item_id, session_id, text, done, at, via) VALUES (?, ?, ?, ?, ?, ?)',
        [itemId, item.session_id, text, doneFlag, now, via],
      );
      if (done) {
        this.run("UPDATE relay_items SET state = 'replied', replied_at = ? WHERE id = ?", [now, itemId]);
      }

      for (const extra of extraItems) {
        if (extra.state !== 'pending') continue;

        this.run(
          "UPDATE relay_items SET state = 'replied', replied_at = ?, reminded = 1 WHERE id = ? AND state = 'pending'",
          [now, extra.id],
        );
        if (extra.channel === 'feishu' && extra.ack_message_id !== '') {
          this.run("UPDATE relay_items SET ack_message_id = '' WHERE id = ?", [extra.id]);
          recallExtras.push({ item: extra, ackMsgId: extra.ack_message_id });
        }
      }
    });

    //M 被静默闭环的旧飞书收件若有“已转给”占位消息，温和异步触发撤回（失败静默降级）。
    for (const pendingRecall of recallExtras) {
      void this.recallAckMessage(pendingRecall.item, pendingRecall.ackMsgId);
    }

    //T 跟踪：收到一条回信。
    const vars = {
      helper: item.helper,
      inboxId: itemId,
      session: item.session_id,
      deliverySource: via,
      complete: done,
      length: text.length,
    };
    this.ctx.emit('trace', 'Relay.accept', 'trace.relay.accept', 'INSERT INTO relay_replies', vars);

    void this.deliverSoon(item.session_id, item.channel);

    const latest = this.getItem(itemId) ?? item;
    if (fileFull !== undefined) {
      void this.sendFile(latest, fileFull);
    }
    return this.view(latest);
  }

  /**
   * 入口校验可选的 alsoCloseIds：省略返回空数组；传入须为正整数数组，否则抛 400。
   */
  private parseAlsoCloseIds(raw: unknown): number[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      throw new failureModule.Failure(400, 'alsoCloseIds 要写成正整数数组');
    }

    const ids: number[] = [];
    for (const one of raw) {
      if (typeof one !== 'number' || !Number.isInteger(one) || one < 1) {
        throw new failureModule.Failure(400, 'alsoCloseIds 每项都要写成正整数');
      }
      ids.push(one);
    }
    return ids;
  }

  /** 从收件保存的地址 JSON 中提取精确聊天号（chatId 优先，其次 chat）。 */
  private getItemChatKey(row: ItemRow): string {
    try {
      const parsed = JSON.parse(row.address) as unknown;
      return utils.getStringField(parsed, 'chatId') || utils.getStringField(parsed, 'chat');
    } catch {
      return '';
    }
  }

  /**
   * 去重并剔除主收件号后，逐项校验 alsoCloseIds 的存在性（404）与助手/机器人/同聊天安全边界（400）。
   */
  private resolveAlsoCloseItems(
    rawIds: readonly number[],
    primaryId: number | undefined,
    primaryHelper: string,
    primaryItem: ItemRow,
    bot: string | undefined,
  ): ItemRow[] {
    const seen = new Set<number>();
    const items: ItemRow[] = [];
    const primaryChat = this.getItemChatKey(primaryItem);

    for (const extraId of rawIds) {
      if (extraId === primaryId || seen.has(extraId)) continue;
      seen.add(extraId);

      const extra = this.getItem(extraId);
      if (extra === undefined) {
        throw new failureModule.Failure(404, `alsoCloseIds 中没有这个收件号：${String(extraId)}`);
      }
      if (extra.helper !== primaryHelper) {
        const msg = `alsoCloseIds 中的收件 #${String(extraId)} 是转给 ${extra.helper} 的，不能由 ${primaryHelper} 关闭`;
        throw new failureModule.Failure(400, msg);
      }
      //G 强制校验机器人归属一致（覆盖 HTTP 通道 bot 缺省与 file 通道传参两种场景）。
      if (extra.bot !== primaryItem.bot || (bot !== undefined && extra.bot !== bot)) {
        const msg = `alsoCloseIds 中的收件 #${String(extraId)} 是 ${extra.bot} 的，不能由 ${primaryItem.bot} 关闭`;
        throw new failureModule.Failure(400, msg);
      }
      //G 强制校验同一渠道与同一聊天/会话边界，严禁误关其他群聊或私聊用户的待回项。
      if (extra.channel !== primaryItem.channel) {
        const msg = `alsoCloseIds 中的收件 #${String(extraId)} 来自其他渠道，不能跨渠道关闭`;
        throw new failureModule.Failure(400, msg);
      }
      const extraChat = this.getItemChatKey(extra);
      const sameChat = primaryChat !== '' && extraChat === primaryChat;
      const sameSession = primaryChat === '' && extraChat === '' && extra.session_id === primaryItem.session_id;
      if (!sameChat && !sameSession) {
        const msg = `alsoCloseIds 中的收件 #${String(extraId)} 不属于当前聊天，不能跨聊天关闭`;
        throw new failureModule.Failure(400, msg);
      }
      items.push(extra);
    }
    return items;
  }

  /**
   * 响应 bot/receive：用 Receive.pickReceiveSessionKind 扁平分流规则判定去向并打开对应会话。
   */
  private onReceive(event: ReceiveEvent): void {
    //G 前面已经有人定了去向、处理掉了 → 不管。
    if (event.session !== undefined || event.handled === true) return;

    const bot = event.bot.name;
    const address = event.message.address;
    const kind = receiveModule.pickReceiveSessionKind(
      this.getMode(bot),
      address,
      event.message.text,
      this.config.helpers,
      bot,
      this.config.ownerP2pDirect,
      this.config.exclusiveBots,
      this.config.ownerGroupDirect,
    );
    if (kind === undefined) return;

    const customer = utils.getStringField(address, 'customer');
    event.session = this.openOrCreateSession(bot, kind, customer);
  }

  /** 按机器人、种类、可选客户找已有会话，没有就新建。 */
  private openOrCreateSession(bot: string, kind: 'front' | 'relay', customer = ''): Session {
    const where: { bot: string; kind: string; customer?: string } = { bot, kind };
    if (customer !== '') {
      where.customer = customer;
    }

    const found = this.ctx.sessions.find(where)[0];
    if (found !== undefined) return this.ctx.sessions.open(found.id);

    return this.ctx.sessions.create(where);
  }

  /**
   * 响应 session/before-model：direct 会话不调真模型，分“登记新话占位”与“送出待送回信”两条扁平分支。
   */
  private onRequest(request: ChatRequest): void {
    const session = request.session;
    const row = session.row;
    if (!this.direct(session)) {
      this.offerTool(request);
      return;
    }

    //M 清掉上一轮残留的待送状态，标 quiet 由 relay 自己按准确地址发回话。
    this.answering.delete(session.id);
    this.replyingItem.delete(session.id);
    this.ackingItem.delete(session.id);
    this.answerTo.delete(session.id);
    row.quiet = true;

    const lastAnswer = row.messages.findLastIndex((message) => message.role === 'assistant');
    const fresh = row.messages.slice(lastAnswer + 1).filter((message) => message.role === 'user');
    const lastUser = fresh.at(-1);
    if (lastUser !== undefined) {
      this.handleDirectFreshTurn(request, fresh, lastUser.timestamp);
      return;
    }

    if (this.handleDirectReplyTurn(request)) return;

    request.answer = this.said(row.bot, '（没有新消息，也没有新回信）');
  }

  /** 处理 direct 会话的新用户话：登记收件并生成“已转给”占位提示（群攒批静默转交除外）。 */
  private handleDirectFreshTurn(
    request: ChatRequest,
    fresh: piAi.Message[],
    lastTimestamp: number,
  ): void {
    const session = request.session;
    const row = session.row;
    const text = fresh.map((message) => piAi.contentText(message.content)).join('\n\n');
    const known = this.query<{ id: number; helper: string }>(
      'SELECT id, helper FROM relay_items WHERE session_id = ? AND last_msg_at = ? AND text = ?',
      [session.id, lastTimestamp, text],
    )[0];
    const exclusiveHelper = receiveModule.matchExclusiveBotHelper(
      row.bot,
      row.address,
      this.config.helpers,
      this.config.exclusiveBots,
    );
    const relayHelper = utils.getStringField(row.address, 'relayHelper').trim();
    const explicitHelper = this.config.helpers.find((one) => one.name === relayHelper);
    const ownerDirectHelper = receiveModule.matchOwnerP2pDirectHelper(
      row.bot,
      row.address,
      this.config.helpers,
      this.config.ownerP2pDirect,
    );
    const ownerGroupHelper = receiveModule.matchOwnerGroupDirectHelper(
      row.bot,
      row.address,
      this.config.helpers,
      this.config.ownerGroupDirect,
    );
    const helper = exclusiveHelper
      ?? this.prefixed(text)
      ?? explicitHelper
      ?? ownerDirectHelper
      ?? ownerGroupHelper
      ?? this.config.helpers[0];
    const id = known?.id ?? this.register(session, helper, text, lastTimestamp);
    if (relayHelper !== '') {
      request.answer = this.said(row.bot, '');
      return;
    }
    this.ackingItem.set(session.id, id);
    const shownHelper = this.getTitle(known?.helper ?? helper.name);
    request.answer = this.said(row.bot, `已转给 ${shownHelper}（#${String(id)}），等回复。`);
  }

  /** 处理 direct 会话的待送回信轮：填好署名回信并记住原收件号以便发成后撤回占位消息。 */
  private handleDirectReplyTurn(request: ChatRequest): boolean {
    const session = request.session;
    const row = session.row;
    this.markWritten(session);
    const reply = this.query<ReplyRow>(
      'SELECT * FROM relay_replies WHERE session_id = ? AND delivered = 0 ORDER BY id LIMIT 1',
      [session.id],
    )[0];
    if (reply === undefined) return false;

    const item = this.getItem(reply.item_id);
    if (item !== undefined) {
      this.answerTo.set(session.id, this.getOrigin(item));
      this.replyingItem.set(session.id, item.id);
    }

    const helper = item?.helper ?? this.config.helpers[0].name;
    const shownHelper = this.getTitle(helper);
    request.answer = this.said(row.bot, `${shownHelper}：${reply.text}`, reply.id);
    this.answering.set(session.id, reply.id);

    //T 跟踪：送出一条回信。
    const vars = { inboxId: reply.item_id, session: session.id, channel: row.channel, length: reply.text.length };
    this.ctx.emit('trace', 'Relay.onRequest', 'trace.relay.returnReply', 'request.answer = said(reply.text)', vars);
    return true;
  }

  /** 走模型的前台、后台会话：按模式添加转话提示或移除 relay_send 工具。 */
  private offerTool(request: ChatRequest): void {
    const row = request.session.row;
    if (row.kind !== 'front' && row.kind !== 'work') return;

    if (this.sessionMode(request.session) === 'model') {
      let where = '';
      if (receiveModule.getChat(row.customer ?? '') === 'group') {
        where = '这是群聊，可能有几个人在说话。';
      }
      request.system.push(`${where}${receiveModule.formatWhenToRelay(this.config.helpers)}`);
      return;
    }
    request.tools = request.tools.filter((tool) => tool.name !== 'relay_send');
  }

  /** 响应 session/change：direct 会话一轮结束，发出回答并标记已送。 */
  private onChange(session: Session): void {
    if (session.row.state === 'running' || !this.direct(session)) return;

    this.sendAnswer(session);
    if (session.row.state !== 'done') return;

    const replyId = this.answering.get(session.id);
    if (replyId !== undefined) {
      this.answering.delete(session.id);
      this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [replyId]);
    }
    void this.deliverSoon(session.id);
  }

  /** 把 direct 会话这一轮的回答（row.reply）发往目标渠道，附带占位或真回复元数据。 */
  private sendAnswer(session: Session): void {
    const row = session.row;
    const ackItemId = this.ackingItem.get(session.id);
    const replyItemId = this.replyingItem.get(session.id);
    this.ackingItem.delete(session.id);
    this.replyingItem.delete(session.id);

    if (row.quiet !== true) return;

    let origin: Origin = { channel: row.channel, address: row.address };
    const recorded = this.answerTo.get(session.id);
    this.answerTo.delete(session.id);
    if (recorded?.channel !== undefined) {
      origin = recorded;
    }
    if (row.reply === '') return;

    void this.sendTo(row.bot, origin, row.reply, 'final', session.id, { ackItemId, replyItemId });
  }

  /**
   * 照确切地址发一句话；占位提示发成时记录 ack_message_id，真回复发回飞书成功后异步撤回原占位消息。
   */
  private async sendTo(
    bot: string,
    origin: Origin,
    text: string,
    kind: channels.ReplyKind,
    sessionId: string,
    meta: SendTurnMeta = {},
  ): Promise<void> {
    const channel = origin.channel;
    if (channel === undefined) return;

    const address = utils.getRecord(origin.address);
    const chat = utils.getStringField(address, 'chatId') || utils.getStringField(address, 'chat');
    const target = { channel, chat, address };

    const replyRoundKey = channels.getReplyRoundKey(sessionId, bot, 'relay');
    const replyRequestKey = channels.getReplyRequestKey(replyRoundKey, crypto.randomUUID());
    const from = { bot, replyRoundKey, target, sessionId };
    const options = { replyRequestKey, replyIndex: 0, kind, atFiles: true };
    const receipt = await channels.requestTextReply(this.ctx, from, text, options);

    if (!receipt.ok) {
      console.error(`relay：会话 ${sessionId} 的话没发出去：${receipt.reason ?? receipt.status}`);
      return;
    }

    //M 1) 本轮是飞书“已转给”占位消息：记录平台返回的 ack_message_id；若真回复已先一步抵达则当场撤回。
    if (meta.ackItemId !== undefined && channel === 'feishu') {
      const ackMsgId = receipt.messageIds?.[0]?.trim() ?? '';
      if (ackMsgId !== '') {
        const current = this.getItem(meta.ackItemId);
        if (current !== undefined && current.state === 'replied') {
          void this.recallAckMessage(current, ackMsgId);
          return;
        }
        this.run('UPDATE relay_items SET ack_message_id = ? WHERE id = ?', [ackMsgId, meta.ackItemId]);
      }
      return;
    }

    //M 2) 本轮是飞书真回复且发送成功：清空并异步触发撤回原“已转给”占位消息（失败静默降级，不影响真回复）。
    if (meta.replyItemId !== undefined && channel === 'feishu') {
      const current = this.getItem(meta.replyItemId);
      if (current !== undefined && current.ack_message_id !== '') {
        const ackMsgId = current.ack_message_id;
        this.run("UPDATE relay_items SET ack_message_id = '' WHERE id = ?", [current.id]);
        void this.recallAckMessage(current, ackMsgId);
      }
    }
  }

  /**
   * 通过事件请飞书插件撤回原“已转给”占位消息。
   * 容错铁律：无撤回权限、超时或消息超过撤回时限均静默记诊断，绝不报错阻断主线。
   */
  private async recallAckMessage(item: ItemRow, ackMessageId: string): Promise<void> {
    let outcome = 'unhandled';
    try {
      const where = JSON.parse(item.address) as { appId?: string; chatId?: string } | null;
      const asked = await requestEventModule.requestEvent(
        this.ctx,
        'feishu/recall-message',
        'feishu/recall-message-result',
        {
          bot: item.bot,
          messageId: ackMessageId,
          appId: where?.appId,
          chatId: where?.chatId,
        },
        { prefix: 'rc' },
      );
      if (asked.why !== undefined) {
        outcome = `skipped:${asked.why}`;
      }
      if (asked.why === undefined && asked.reply.ok) {
        outcome = 'recalled';
      }
      if (asked.why === undefined && !asked.reply.ok) {
        outcome = `failed:${asked.reply.error ?? 'unknown'}`;
      }
    } catch (error) {
      outcome = `error:${textModule.getErrorMessage(error)}`;
    }

    //T 跟踪：异步撤回占位消息。
    const vars = { inboxId: item.id, messageId: ackMessageId, outcome };
    const code = "requestEvent(ctx, 'feishu/recall-message', 'feishu/recall-message-result', ...)";
    this.ctx.emit('trace', 'Relay.recallAckMessage', 'trace.relay.recallAck', code, vars);
  }

  /** 把一场会话没送的回信送出去。 */
  private async deliverSoon(sessionId: string, channel?: string): Promise<void> {
    if (channel === decisionModule.DECISION_CHANNEL || channel === decisionModule.LEGACY_DECISION_CHANNEL) {
      const deliver = (reply: ReplyRow) => this.queueDecisionReply(reply);
      await this.deliverPending(sessionId, deliver);
      return;
    }

    let session: Session;
    try {
      session = this.ctx.sessions.open(sessionId);
    } catch (error) {
      console.error(`relay：回信送不出去：${textModule.getErrorMessage(error)}`);
      return;
    }

    const mode = this.sessionMode(session);
    if (this.direct(session)) {
      if (!this.hasLeft(session)) return;

      setTimeout(() => {
        if (!this.hasLeft(session)) return;

        void session.run();
      }, 0);
      return;
    }
    if (mode !== 'model') return;

    const deliver = (reply: ReplyRow) => this.queueReply(sessionId, reply);
    await this.deliverPending(sessionId, deliver);
  }

  /** 按回信号串行投递同一收件键下的待送回信，每轮只尝试一次。 */
  private async deliverPending(sessionId: string, deliver: (reply: ReplyRow) => Promise<void>): Promise<void> {
    if (this.delivering.has(sessionId)) return;

    this.delivering.add(sessionId);
    try {
      let lastId = 0;
      const sql = 'SELECT * FROM relay_replies WHERE session_id = ? AND delivered = 0 AND id > ? ORDER BY id LIMIT 1';
      while (true) {
        const [reply] = this.query<ReplyRow>(sql, [sessionId, lastId]);
        if (reply === undefined) return;

        await deliver(reply);
        lastId = reply.id;
      }
    } catch (error) {
      console.error(`relay：会话 ${sessionId} 的回信投递出错：${textModule.getErrorMessage(error)}`);
    } finally {
      this.delivering.delete(sessionId);
    }
  }

  /** 把一条工作决策或留言写给外部助手。 */
  private receiveDecision(request: requestEventModule.EventArg<'work-decision/note'>) {
    return decisionModule.handleDecisionNote(
      this.ctx.resources.raw,
      this.config.helpers,
      { query: (s, v) => this.query(s, v), run: (s, v) => this.run(s, v) },
      request,
    );
  }

  /** 决策图确认回信已写入节点后，才把待送记录标成已送。 */
  private async queueDecisionReply(reply: ReplyRow): Promise<void> {
    const item = this.getItem(reply.item_id);
    if (item === undefined) return;

    const origin = this.getOrigin(item);
    const target = decisionModule.extractDecisionTarget(origin.address);
    if (target === undefined) {
      console.error(`relay：回信 #${String(reply.id)} 缺少精确决策目标，保留待核对`);
      return;
    }

    const payload = { action: 'reply' as const, id: reply.id, target, text: reply.text };
    const asked = await requestEventModule.requestEvent(
      this.ctx,
      'work-decision/note',
      'work-decision/note-result',
      payload,
    );
    if (asked.why === 'unhandled') return;
    if (asked.why !== undefined) {
      console.error(`relay：回信 #${String(reply.id)} 的决策图回信写入结果不确定，保留原回信号待对账`);
      return;
    }
    if (!asked.reply.ok) {
      if (asked.reply.error !== undefined) {
        console.error(`relay：决策图回信写入失败：${asked.reply.error}`);
      }
      return;
    }
    this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [reply.id]);
  }

  /** 对完账以后，这场会话还有没送的回信吗。 */
  private hasLeft(session: Session): boolean {
    this.markWritten(session);
    const left = this.query<{ id: number }>(
      'SELECT id FROM relay_replies WHERE session_id = ? AND delivered = 0 LIMIT 1',
      [session.id],
    );
    return left.length > 0;
  }

  /** 一条回信经事件排进走模型的会话，收到成功回执后标已送。 */
  private async queueReply(sessionId: string, reply: ReplyRow): Promise<void> {
    const item = this.getItem(reply.item_id);
    const helper = item?.helper ?? this.config.helpers[0].name;
    const shownHelper = this.getTitle(helper);

    const key = `relay:${String(reply.id)}`;
    const input: dispatchModule.ResultInput = {
      key,
      sessionId,
      source: { type: 'relay', id: helper },
      payload: { text: `${shownHelper} 回复（#${String(reply.item_id)}）：${reply.text}`, files: [] },
    };
    if (item !== undefined) {
      input.origin = this.getOrigin(item);
    }

    try {
      const delivered = await agentTasksModule.requestResultDelivery(this.ctx, input);
      if (delivered.uncertain) {
        console.error(`relay：回信 #${String(reply.id)} 的投递结果不确定，保留结果键 ${key} 待对账`);
        return;
      }
      if (!delivered.ok || delivered.receipt === undefined) {
        const reason = delivered.error ?? '未返回投递凭据';
        console.error(`relay：回信 #${String(reply.id)} 排不进会话 ${sessionId} 的结果队列：${reason}`);
        return;
      }
      this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [reply.id]);
    } catch (error) {
      console.error(`relay：回信 #${String(reply.id)} 投递或标记失败：${textModule.getErrorMessage(error)}`);
      return;
    }

    //T 跟踪：回信排进结果队列。
    const vars = { replyId: reply.id, inboxId: reply.item_id, session: sessionId, key };
    this.ctx.emit('trace', 'Relay.queueReply', 'trace.relay.queueReply', 'bot/request accept-result', vars);
  }

  /** 记一条收件：插表，追加一行 inbox.jsonl，配了 webhook 就推一次。 */
  private register(session: Session, helper: Helper, text: string, lastMsgAt: number | null): number {
    const item = this.insert(session, helper.name, text, lastMsgAt);
    const botDir = filesModule.ensureBotRelayDir(this.ctx.resources, item.bot);
    fs.appendFileSync(path.join(botDir, 'inbox.jsonl'), `${JSON.stringify(item)}\n`, 'utf8');
    void this.push(item, helper, session.row.address);

    //T 跟踪：转出一条。
    const vars = {
      helper: helper.name,
      inboxId: item.id,
      session: session.id,
      channel: item.channel,
      sender: item.sender,
      chat: item.chat,
      length: text.length,
    };
    this.ctx.emit('trace', 'Relay.register', 'trace.relay.register', 'fs.appendFileSync(inbox.jsonl)', vars);
    return item.id;
  }

  /** 插一条收件进表。 */
  private insert(
    session: Session,
    helper: string,
    text: string,
    lastMsgAt: number | null,
    origin?: Origin,
  ): InboxItem {
    const row = session.row;
    const now = Date.now();
    let channel = row.channel ?? '';
    let address = row.address;
    if (origin !== undefined) {
      channel = origin.channel ?? '';
      address = origin.address;
    }

    const speaker = receiveModule.getSpeaker(address);
    let ownerFlag = 0;
    if (speaker.owner) {
      ownerFlag = 1;
    }
    const values = [
      row.bot, helper, session.id, channel, JSON.stringify(address ?? null),
      ownerFlag, speaker.sender, speaker.chat, speaker.chatName, text, now, lastMsgAt,
    ];
    const result = this.run(
      'INSERT INTO relay_items (bot, helper, session_id, channel, address, owner, sender, chat, chat_name,'
        + ' text, at, last_msg_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values,
    );
    const files = filesModule.extractRelativeFiles(this.ctx.resources.root, text);
    return {
      id: Number(result.lastInsertRowid),
      bot: row.bot,
      helper,
      session: session.id,
      channel,
      ...speaker,
      text,
      files,
      at: textModule.formatLocalTime(now, 'date'),
      atMs: now,
      state: 'pending',
    };
  }

  /** 轮询读取每个 relay 机器人的 replies.jsonl。 */
  private pollFile(): void {
    for (const bot of botUtils.getBotConfigs(this.ctx.resources.raw)) {
      if (!this.hasBotRelayDir(bot.name)) continue;
      try {
        const dir = filesModule.ensureBotRelayDir(this.ctx.resources, bot.name);
        filesModule.pollBotReplyFile(dir, bot.name, (parsed, b) => this.accept(parsed, 'file', b));
      } catch (error) {
        console.error(`relay：读 ${bot.name} 的回信文件出错：${textModule.getErrorMessage(error)}`);
      }
    }
  }

  /** 查超时：remind_minutes > 0 时过线提醒一次，expire_minutes > 0 时过线改为 expired；两者均为 0 时彻底禁用。 */
  private checkLate(): void {
    const remindEnabled = this.config.remindMinutes > 0;
    const expireEnabled = this.config.expireMinutes > 0;
    //G 催促提醒与过期放下均禁用时直接跳过，不查库也不发任何提醒消息。
    if (!remindEnabled && !expireEnabled) return;

    const now = Date.now();
    for (const item of this.query<ItemRow>("SELECT * FROM relay_items WHERE state = 'pending' ORDER BY id", [])) {
      const minutes = (now - item.at) / 60_000;
      const expire = expireEnabled && minutes >= this.config.expireMinutes;
      const remind = remindEnabled && item.reminded === 0 && minutes >= this.config.remindMinutes;
      if (!expire && !remind) continue;

      let session: Session;
      try {
        session = this.ctx.sessions.open(item.session_id);
      } catch {
        continue;
      }
      if (session.row.state === 'running') continue;

      const shownHelper = this.getTitle(item.helper);
      const shown = String(Math.floor(minutes));
      let text = `${shownHelper} 还没回复（#${String(item.id)}，已 ${shown} 分钟），话还在它的收件箱里，回了会接着发给你。`;
      let traceSummary = 'trace.relay.remind';
      if (expire) {
        this.run("UPDATE relay_items SET state = 'expired', reminded = 1 WHERE id = ?", [item.id]);
        text = `${shownHelper} ${shown} 分钟没回（#${String(item.id)}），这条先放下；之后回了还会发给你。`;
        traceSummary = 'trace.relay.expire';
      }
      if (!expire) {
        this.run('UPDATE relay_items SET reminded = 1 WHERE id = ?', [item.id]);
      }

      const origin = this.getOrigin(item);
      void this.sendTo(item.bot, origin, text, 'progress', session.id);

      //T 跟踪：提醒或放下。
      const vars = { inboxId: item.id, session: item.session_id, minutes: shown };
      this.ctx.emit('trace', 'Relay.checkLate', traceSummary, "ctx.serial('channel/reply')", vars);
    }
  }

  /** 推一条收件通知到外部助手的 webhook。 */
  private async push(item: InboxItem, helper: Helper, address: unknown): Promise<void> {
    const body = receiveModule.buildWebhookBody(item, address);
    let result = '没配 webhook_url，只记收件箱';
    if (helper.webhookUrl !== '') {
      try {
        const response = await fetch(helper.webhookUrl, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', ...receiveModule.webhookAuthHeaders(helper.webhookHeader) },
        });
        result = `HTTP ${String(response.status)}`;
      } catch (error) {
        result = `推不出去：${textModule.getErrorMessage(error)}`;
      }
    }

    //T 跟踪：推 webhook。
    const vars = { helper: helper.name, inboxId: item.id, chat: body['chat'], owner: body['owner'], result };
    this.ctx.emit('trace', 'Relay.push', 'trace.relay.push', 'fetch(webhook_url)', vars);
  }

  /** 按聊天号精确查找已有收件。 */
  private findForChat(chat: string, bot: string | undefined, helper: string): ItemRow {
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

  /** 借同聊天其他助手的已有地址新登记一条主动发收件。 */
  private startProactive(from: ItemRow, helper: string): ItemRow {
    if (from.channel === '') {
      throw new failureModule.Failure(404, `收件 #${String(from.id)} 没记渠道，借不了它的地址主动发；用收件号 id 回`);
    }
    const session = this.openOrCreateSession(from.bot, 'relay');
    const origin = this.getOrigin(from);
    const inserted = this.insert(session, helper, `（${helper} 主动发）`, null, origin);
    return this.getItem(inserted.id)!;
  }

  /** 回信带的文件：飞书收件就发 feishu/send-file 请求上传并挂到原消息下。 */
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
      //M 请飞书发文件。飞书每个开放接口自己限时 60 秒（feishu 1.3.5），这里不另掐表，30 秒没回只报警。
      const options = { prefix: 'sf', warnAfterMs: 30_000 };
      const asked = await requestEventModule.requestEvent(
        this.ctx,
        'feishu/send-file',
        'feishu/send-file-result',
        request,
        options,
      );

      result = `没发出去：${asked.reply?.error ?? '原因不明'}`;
      if (asked.reply?.ok === true) {
        result = `已发 ${asked.reply.messageId ?? ''}`;
      }
      if (asked.why === 'unhandled') {
        result = '没发出去：飞书插件没挂，没人接发文件的请求';
      }
      if (asked.why === 'error') {
        result = `飞书文件发送结果不确定：飞书处理时出错 ${asked.detail ?? ''}`.trim();
      }
    }

    //T 跟踪：回信带的文件。
    const vars = { helper: item.helper, inboxId: item.id, file: full, result };
    const code = "requestEvent(ctx, 'feishu/send-file', 'feishu/send-file-result', request, options)";
    this.ctx.emit('trace', 'Relay.sendFile', 'trace.relay.sendFile', code, vars);
  }

  /** 登记工具 relay_send。 */
  private registerTool(): void {
    const main = this.config.helpers[0];
    const helper = this.getTitle(main.name);
    const whenText = receiveModule.formatWhenToRelay(this.config.helpers);
    this.ctx.tools.register({
      definition: {
        name: 'relay_send',
        description: `把话转给外部助手 ${helper}。它大约每 5 分钟看一次，回信会作为新的一句话交回这场会话。`
          + `用户要找 ${helper}、或者要 ${helper} 帮忙时用；${whenText}`,
        parameters: piAi.Type.Object({
          text: piAi.Type.String({ description: `要转给 ${helper} 的话：用户原话一字不改，或你整理好的问题` }),
        }),
      },
      sessionKinds: ['front', 'work'],
      run: (args, session) => {
        if (this.sessionMode(session) !== 'model') {
          const msg = `这场会话不能用 relay_send（机器人 ${session.row.bot} 没写 relay: model，这个群也没登记 relay: model）`;
          throw new Error(msg);
        }
        const text = String(args['text']).trim();
        if (text === '') throw new Error('text 不能是空的');

        const id = this.register(session, main, text, null);
        return `已转给 ${helper}（#${String(id)}），它大约每 5 分钟看一次，回信会作为新的一句话交回这场会话`;
      },
    });
  }

  /** 拼一句程序生成的 AssistantMessage。 */
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

  /** 对账：对话记录里已写入 relayReplyId 的回信补标 delivered = 1。 */
  private markWritten(session: Session): void {
    const written = new Set<number>();
    for (const message of session.row.messages) {
      const replyId = (message as { relayReplyId?: unknown }).relayReplyId;
      if (typeof replyId === 'number') {
        written.add(replyId);
      }
    }
    if (written.size === 0) return;

    const pending = this.query<{ id: number }>(
      'SELECT id FROM relay_replies WHERE session_id = ? AND delivered = 0',
      [session.id],
    );
    for (const reply of pending) {
      if (!written.has(reply.id)) continue;

      this.run('UPDATE relay_replies SET delivered = 1 WHERE id = ?', [reply.id]);
    }
  }

  /** 收件当时记的渠道和地址。 */
  private getOrigin(item: ItemRow): Origin {
    if (item.channel === '') return {};
    return { channel: item.channel, address: JSON.parse(item.address) as unknown };
  }

  /** 取一条收件。 */
  private getItem(id: number): ItemRow | undefined {
    return this.query<ItemRow>('SELECT * FROM relay_items WHERE id = ?', [id])[0];
  }

  /** 表行映射为对外 InboxItem。 */
  private view(row: ItemRow): InboxItem {
    const { role, workspace } = receiveModule.getSpeaker(JSON.parse(row.address) as unknown);
    const owner = row.owner === 1;
    let repliedAt: string | null = null;
    if (row.replied_at !== null) {
      repliedAt = textModule.formatLocalTime(row.replied_at, 'date');
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
      files: filesModule.extractRelativeFiles(this.ctx.resources.root, row.text),
      at: textModule.formatLocalTime(row.at, 'date'),
      atMs: row.at,
      state: row.state,
      repliedAt,
    };
  }

  /** 查库。 */
  private query<T>(sql: string, values: (string | number | null)[]): T[] {
    return this.ctx.resources.db.query(sql).all(...values) as T[];
  }

  /** 改库。 */
  private run(sql: string, values: (string | number | null)[]): { lastInsertRowid: number | bigint } {
    return this.ctx.resources.db.query(sql).run(...values);
  }
}


/** config.yaml 里写给 relay 的原始结构。 */
export interface RelayWritten {
  remind_minutes?: unknown;
  expire_minutes?: unknown;
  poll_seconds?: unknown;
  helpers?: unknown;
  bots?: unknown;
  owner_p2p_direct?: unknown;
  exclusive_bots?: unknown;
  owner_group_direct?: unknown;
  tasks?: unknown;
}


/**
 * 挂上 relay：校验配置后按需挂载转话（Relay）与外部 AI 任务通道（AgentTasks）。
 */
export function apply(ctx: cordis.Context, config: RelayWritten | undefined): void {
  const written = config ?? {};
  if (Object.hasOwn(written, 'owner_open_ids')) {
    throw new Error('relay 的 owner_open_ids 已不用，请在飞书插件 people 里登记本人并写 role: owner');
  }

  const scanMs = agentTasksModule.getScanMs(written.tasks);
  if (written.helpers !== undefined) {
    applyRelay(ctx, written);
  }

  void ctx.inject(agentTasksModule.TASKS_INJECT, (sub) => {
    agentTasksModule.applyAgentTasks(sub, scanMs);
  });
}


/** 校验 helpers 配置并构建 Relay 实例。 */
function applyRelay(ctx: cordis.Context, written: RelayWritten): void {
  const config = filesModule.parseRelayWrittenConfig(ctx.resources.raw, written);
  new Relay(ctx, config);
}
