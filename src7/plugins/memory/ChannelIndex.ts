/**
 * 渠道消息索引（C 块，11-18，用户 #130）：各渠道的消息按聊天记进一张表，能按“渠道 + 聊天 + 时间范围 + 关键词”查。
 * 增量：听 channel/message（用户的话；飞书、微信、网页、命令行都是先落盘再发）、channel/reply（机器人的话，带来源快照和正文），
 *   键分别是 messageId、replyRequestKey，INSERT OR IGNORE 幂等。
 * 查：工具 channel_search、GET /api/memory/channel。外人（src7/Channels.ts 的 isHistoryOwner 不过，群里本人也算）只查这一轮来源快照里的这个聊天。
 * 补旧：scripts/Backfill_Channel_Index.ts 用这里的 ChannelIndex 写。
 * 归属键：每行带 memory_key（MemoryKey.ts 算，私聊归人、群归群、本机归本人），统一检索的 person、group 按它查。
 * 不用 FTS5：中文没有分词，unicode61 整句当一个词、trigram 查不了两个字的词；先按渠道、聊天、时间走索引缩小范围，再 LIKE。
 * 设计：docs/开发进度/132_渠道消息进记忆_20261118.md。
 */
import type { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as protocolModule from '../../Channels.ts';
import type { Search } from './Search.ts';
import type { ChannelBackfill } from './ChannelBackfill.ts';
import * as memoryKeyModule from './MemoryKey.ts';


/** Rust 中渠道文档的保留命名空间，与客服往来分离。 */
export const CHANNEL_PARTITION = 'jmbots-channel:';

/** 表里的一行（一条渠道消息）。 */
export interface ChannelRow {
  /** 消息键：用户的话是渠道的 messageId（JSON [渠道, 账号, 原始号]），机器人的话是 replyRequestKey；补旧拼不出时另起。唯一。 */
  key: string;
  /** 渠道名：feishu、wechat、http、cli…… */
  channel: string;
  /** 渠道账号：飞书应用号、微信号；网页、命令行是 local。 */
  account: string;
  /** 聊天号：飞书 chat_id、微信会话名、http:本机、cli:本机。 */
  chat: string;
  /** 聊天种类：p2p、group、local；补旧时不知道是空串。 */
  chatType: string;
  /** user 聊天里的人说的；bot 机器人说的。 */
  direction: 'user' | 'bot';
  /** 发言人原始 ID（飞书 open_id、微信 wxid、机器人名）。 */
  senderId: string;
  /** 发言人名字；没有是空串。 */
  senderName: string;
  /** 哪个机器人（用户的话是目标机器人，逗号连着；机器人的话是它自己）。 */
  bot: string;
  /** 正文。 */
  text: string;
  /** 原始提及解析到的机器人；旧索引行可缺。 */
  mentionedBots?: string[];
  /** 记忆归属键（MemoryKey.ts 算）：私聊 person:…、群 group:…、本机 owner；打标以前的旧行、算不出的是空串，不写也当空串。 */
  memoryKey?: string;
  /** 时间，毫秒。 */
  at: number;
}


/** 一次查询。 */
/** 渠道查询的授权范围。 */
export interface ChannelScope {
  /** 只查这个渠道；不给不限。 */
  channel?: string;
  /** 只查这个聊天；不给不限。 */
  chat?: string;
  /** 只查当前渠道账号；同名聊天可能属于不同账号。 */
  account?: string;
  /** 此次查询允许的记忆归属；不给不限。 */
  memoryKey?: string;
}

/** 一次渠道查询。 */
export interface ChannelQuery extends ChannelScope {
  /** 只查涉及这个机器人的消息。 */
  bot?: string;
  /** 只查明确 @ 过该机器人的消息。 */
  mentionedBot?: string;
  /** 从这个时刻起（毫秒，含）；不给不限。 */
  since?: number;
  /** 到这个时刻止（毫秒，含）；不给不限。 */
  until?: number;
  /** 关键词：每个都要在正文里出现；空的不按词筛。 */
  words: string[];
  /** 最多几条。 */
  limit: number;
}


/** 这一轮能查多大范围。 */
export type ChannelAccess = memoryKeyModule.MemoryAccess;


/** 只有本轮来源的渠道、账号、聊天全部已锁定，才允许读尚未补标的老行。 */
function getMemoryKeyFilter(query: ChannelQuery): { sql: string; legacy: boolean } {
  if (query.channel && query.account && query.chat) {
    return { sql: "(memory_key = ? OR memory_key = '')", legacy: true };
  }
  return { sql: 'memory_key = ?', legacy: false };
}


/** 查询默认几条、最多几条。 */
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

/** 工具结果里一条正文最多留多少字。 */
const TEXT_MAX = 1000;


/** 渠道消息索引：一张表 memory_channel_messages。 */
export class ChannelIndex {
  /**
   * 建表和索引。
   * @param db 库（resources.db；补旧脚本自己开的同一个库）。
   * 副作用：建表。
   */
  constructor(private readonly db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS memory_channel_messages'
      + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, msg_key TEXT NOT NULL UNIQUE,'
      + ' channel TEXT NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL,'
      + ' chat_type TEXT NOT NULL, direction TEXT NOT NULL, sender_id TEXT NOT NULL,'
      + ' sender_name TEXT NOT NULL, bot TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,'
      + " mentioned_bots TEXT NOT NULL DEFAULT '[]', rust_state INTEGER NOT NULL DEFAULT 0,"
      + " memory_key TEXT NOT NULL DEFAULT '', front_only INTEGER NOT NULL DEFAULT 0)");

    //M 已有索引行沿用渠道可见性，只有待迁的前台原文会显式标记为前台归档。
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(memory_channel_messages)').all();
    if (!columns.some((column) => column.name === 'front_only')) {
      db.exec('ALTER TABLE memory_channel_messages ADD COLUMN front_only INTEGER NOT NULL DEFAULT 0');
    }

    //M 按聊天看一段时间（最常用）、不分聊天按时间看。
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_chat ON memory_channel_messages (channel, chat, at)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_at ON memory_channel_messages (at)');
    //M 队列按入库状态扫描，归属查询按键与时间扫描。
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_rust ON memory_channel_messages (rust_state, id)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_key ON memory_channel_messages (memory_key, at)');
  }

  /** 列出已标归属、渠道消息量与最近的本人发言名。只读元数据。 */
  ownershipRows(): { key: string; count: number; name: string }[] {
    //M 显示名取该人的最新非空渠道名。群名不在索引里，列表可退回聊天号。
    const sql = "WITH owners AS (SELECT memory_key, COUNT(*) AS count FROM memory_channel_messages"
      + " WHERE front_only = 0 AND memory_key <> '' GROUP BY memory_key)"
      + " SELECT owners.memory_key AS key, owners.count, COALESCE((SELECT sender_name FROM memory_channel_messages"
      + " WHERE front_only = 0 AND memory_key = owners.memory_key AND direction = 'user' AND sender_name <> ''"
      + " ORDER BY at DESC, id DESC LIMIT 1), '') AS name FROM owners";
    return this.db.query<{ key: string; count: number; name: string }, []>(sql).all();
  }

  /** Rust 会话已补归属但渠道旧行没打标时，仍可用渠道发话人 ID 找显示名。 */
  ownershipName(channel: string, id: string): string {
    const sql = "SELECT sender_name AS name FROM memory_channel_messages WHERE channel = ? AND sender_id = ?"
      + " AND front_only = 0 AND direction = 'user' AND sender_name <> '' ORDER BY at DESC, id DESC LIMIT 1";
    //M 以同一渠道的稳定身份取最近名字，避免把机器人的回复名算成对方。
    const statement = this.db.query<{ name: string }, [string, string]>(sql);
    return statement.get(channel, id)?.name ?? '';
  }

  /**
   * 记一条；同一个键已经有了就不动。
   * @param row 一条消息。
   * @param live 是否来自实时渠道事件。
   * @param frontOnly 正文仅允许经会话关联查询。
   * @returns 新记了是 true，早有了是 false。
   * 副作用：写库。
   */
  add(row: ChannelRow, live = false, frontOnly = false): boolean {
    const sql = 'INSERT OR IGNORE INTO memory_channel_messages'
      + ' (msg_key, channel, account, chat, chat_type, direction, sender_id, sender_name, bot, text, at,'
      + ' mentioned_bots, rust_state, memory_key, front_only)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const mentions = JSON.stringify(row.mentionedBots ?? []);
    const state = Number(live);
    const memoryKey = row.memoryKey ?? '';
    const values = [row.key, row.channel, row.account, row.chat, row.chatType, row.direction,
        row.senderId, row.senderName, row.bot, row.text, row.at, mentions, state, memoryKey, Number(frontOnly)];
    //M 幂等写入，按 SQLite 的影响行数区分新消息和重复消息。
    const changes = this.db.query(sql).run(...values).changes;
    if (changes === 0 && live) {
      //M 旧档先到时，实时事件仍可唤醒尚未同步的同一行。
      const promote = 'UPDATE memory_channel_messages SET rust_state = 1 WHERE msg_key = ? AND rust_state = 0';
      this.db.query(promote).run(row.key);
    }
    return changes === 1;
  }

  /** 按持久化队列取一批未确认记录。实时和历史各有一条队列。 */
  getRustBatch(live: boolean, limit: number): ChannelRow[] {
    const state = Number(live);
    const sql = 'SELECT * FROM memory_channel_messages WHERE front_only = 0 AND rust_state = ? ORDER BY id LIMIT ?';

    //M 使用状态索引取最早一批，Rust 确认的行不会再取到。
    const rows = this.db.query(sql).all(state, limit) as Record<string, unknown>[];
    return rows.map(getRow);
  }

  /** Rust 确认整批写入后，在同一事务内推进进度。 */
  confirmRustBatch(rows: ChannelRow[]): void {
    const sql = 'UPDATE memory_channel_messages SET rust_state = 2 WHERE msg_key = ?';
    //M 整批复用一个更新语句，事务中按消息键逐行确认。
    const statement = this.db.query(sql);
    const commit = this.db.transaction(() => {
      //M 整批确认以保留重启前的断点。
      for (const row of rows) {
        statement.run(row.key);
      }
    });
    commit();
  }

  /** 按已索引消息和 Rust 确认的消息统计进度。 */
  getRustProgress(): { total: number; done: number } {
    const sql = 'SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE rust_state = 2) AS done'
      + ' FROM memory_channel_messages WHERE front_only = 0';

    //M 计数和写入确认取自同一张表，页面轮询可以读到一致的进度。
    return this.db.query(sql).get() as { total: number; done: number };
  }

  /**
   * 有没有“差不多的同一条”：同渠道、同聊天、同方向、同正文，时间差在 windowMs 以内。补旧时键拼不出来（命令行、飞书机器人回复）用它去重。
   * @param row 一条消息。
   * @param windowMs 时间差。
   */
  hasSimilar(row: ChannelRow, windowMs: number): boolean {
    const sql = 'SELECT 1 FROM memory_channel_messages'
      + ' WHERE front_only = 0 AND channel = ? AND account = ? AND chat = ?'
      + ' AND direction = ? AND text = ? AND at BETWEEN ? AND ? LIMIT 1';
    const from = row.at - windowMs;
    const to = row.at + windowMs;

    //G 同名会话可能属于不同账号，近似去重也要限制在来源账号内。
    const found = this.db.query(sql).get(row.channel, row.account, row.chat, row.direction, row.text, from, to);
    return found !== null;
  }

  /**
   * 查：先按渠道、聊天、时间（走索引）缩小，再要求每个关键词都在正文里（LIKE，%、_ 照字面），新的在前。
   * @param query 条件（调用方查过范围）。
   * @returns 命中的消息。
   */
  search(query: ChannelQuery): ChannelRow[] {
    //G 前台专用往来只能按会话权限读，渠道查询即使是本人也不能绕过前台范围。
    const conditions = ['front_only = 0'];
    const values: (string | number)[] = [];

    //M 渠道、聊天、时间：有才加。
    for (const key of ['channel', 'chat', 'account'] as const) {
      const value = query[key];
      if (value === undefined) continue;
      conditions.push(`${key} = ?`);
      values.push(value);
    }
    if (query.since !== undefined) {
      conditions.push('at >= ?');
      values.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push('at <= ?');
      values.push(query.until);
    }
    if (query.bot !== undefined) {
      conditions.push("instr(',' || bot || ',', ',' || ? || ',') > 0");
      values.push(query.bot);
    }
    if (query.mentionedBot !== undefined) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(mentioned_bots) WHERE value = ?)');
      values.push(query.mentionedBot);
    }
    //M 归属过滤保留已锁定聊天的老行；不限账号的本人筛选仍要求已打标。
    if (query.memoryKey !== undefined) {
      const filter = getMemoryKeyFilter(query);
      conditions.push(filter.sql);
      values.push(query.memoryKey);
    }

    //M 关键词：每个都要有；% _ \ 转义，照字面找。
    for (const word of query.words) {
      conditions.push("text LIKE ? ESCAPE '\\'");
      values.push(`%${word.replace(/[\\%_]/gu, (mark) => `\\${mark}`)}%`);
    }

    //M 拼 SQL：没有条件就是全部。
    const where = conditions.join(' AND ');
    const sql = `SELECT * FROM memory_channel_messages WHERE ${where} ORDER BY at DESC, id DESC LIMIT ?`;
    values.push(query.limit);

    //M 查出来的行是表里的列名，用 getRow 逐行转成 ChannelRow 交回。
    const rows = this.db.query(sql).all(...values) as Record<string, unknown>[];
    return rows.map(getRow);
  }

  /** 按消息键定位，按时间和入库顺序取同一聊天前后的消息。 */
  context(key: string, query: ChannelQuery): { anchor: ChannelRow; before: ChannelRow[]; after: ChannelRow[] } {
    //M 用索引中的唯一消息键定位原文，再确认它位于可读的账号和聊天。
    const sql = 'SELECT * FROM memory_channel_messages WHERE msg_key = ? AND front_only = 0';
    const found = this.db.query(sql).get(key) as Record<string, unknown> | null;
    if (found === null) throw new Error('找不到这条渠道消息');

    //G 在读前后文前核对锚点的真实来源，防止只改引用中的聊天号来绕过权限。
    const anchor = getRow(found);
    for (const field of ['channel', 'chat', 'account'] as const) {
      if (query[field] === undefined || query[field] === anchor[field]) continue;
      throw new Error('找不到这条渠道消息');
    }
    //G 锚点、邻段共用与搜索相同的归属条件。
    const filter = getMemoryKeyFilter(query);
    if (query.memoryKey !== undefined && query.memoryKey !== anchor.memoryKey) {
      const oldInCurrentChat = filter.legacy && anchor.memoryKey === '';
      if (!oldInCurrentChat) {
        throw new Error('找不到这条渠道消息');
      }
    }

    //M 用 (at,id) 决定同毫秒消息的前后，账号和聊天均跟着锚点。
    let source = 'SELECT * FROM memory_channel_messages'
      + ' WHERE front_only = 0 AND channel = ? AND account = ? AND chat = ?';
    const scope = [anchor.channel, anchor.account, anchor.chat];
    if (query.memoryKey !== undefined) {
      source += ` AND ${filter.sql}`;
      scope.push(query.memoryKey);
    }
    const time = ' AND at BETWEEN ? AND ?';
    const beforeSql = `${source}${time} AND (at,id) < (?,?) ORDER BY at DESC, id DESC LIMIT ?`;
    const afterSql = `${source}${time} AND (at,id) > (?,?) ORDER BY at, id LIMIT ?`;
    const values = [...scope, query.since ?? 0,
      query.until ?? Number.MAX_SAFE_INTEGER, anchor.at, found['id'] as number, query.limit];
    //M 前后邻段共同使用锚点聊天和已授权归属。
    const before = this.db.query(beforeSql).all(...values) as Record<string, unknown>[];
    const after = this.db.query(afterSql).all(...values) as Record<string, unknown>[];
    return { anchor, before: before.reverse().map(getRow), after: after.map(getRow) };
  }
}


/** 表里一行转成 ChannelRow。 */
function getRow(row: Record<string, unknown>): ChannelRow {
  return {
    key: row['msg_key'] as string,
    channel: row['channel'] as string,
    account: row['account'] as string,
    chat: row['chat'] as string,
    chatType: row['chat_type'] as string,
    direction: row['direction'] as 'user' | 'bot',
    senderId: row['sender_id'] as string,
    senderName: row['sender_name'] as string,
    bot: row['bot'] as string,
    text: row['text'] as string,
    memoryKey: row['memory_key'] as string,
    at: row['at'] as number,
  };
}


/**
 * 用户的一条话（channel/message）→ 一行。
 * @param message 渠道发的标准消息。
 * @returns 一行；没有正文（纯附件、空话）是 undefined。
 */
export function getMessageRow(message: protocolModule.ChannelMessage): ChannelRow | undefined {
  if (message.text.trim() === '') return undefined;

  //M 归属键：私聊对面的人就是发话人。
  const keySource = {
    channel: message.channel,
    chatType: message.chatType,
    chat: message.chatId,
    person: message.sender.id,
  };

  //M 用标准渠道字段确定这条用户消息的归属。
  const memoryKey = memoryKeyModule.getMemoryKey(keySource);

  //M 拼成一行，归属键跟着落库。
  return {
    key: message.messageId,
    channel: message.channel,
    account: message.accountId,
    chat: message.chatId,
    chatType: message.chatType,
    direction: 'user',
    senderId: message.sender.id,
    senderName: message.sender.name ?? '',
    bot: message.targetBots.join(','),
    mentionedBots: [...new Set(message.mentions.flatMap((mention) => mention.botNames))],
    text: message.text,
    memoryKey,
    at: message.createdAt,
  };
}


/**
 * 机器人的一条回复（channel/reply）→ 一行：文字片段连起来，聊天照来源快照。
 * @param request 回复请求。
 * @returns 一行；只有附件没有文字是 undefined。
 */
export function getReplyRow(request: protocolModule.ChannelReplyRequest): ChannelRow | undefined {
  const texts = request.parts.filter((part) => part.kind === 'text').map((part) => part.text ?? '');
  const text = texts.join('\n').trim();
  if (text === '') return undefined;

  //M 归属键：私聊对面的人是这条回复回给的那个人（来源快照里的发话人）。
  const snapshot = request.sourceSnapshot;
  const keySource = {
    channel: snapshot.channel,
    chatType: snapshot.chatType,
    chat: snapshot.chatId,
    person: snapshot.senderId,
  };

  //M 回复沿用收件人的身份，避免把机器人的名字当作私聊归属。
  const memoryKey = memoryKeyModule.getMemoryKey(keySource);

  //M 拼成一行，归属键跟着落库。
  return {
    key: request.replyRequestKey,
    channel: snapshot.channel,
    account: snapshot.accountId,
    chat: snapshot.chatId,
    chatType: snapshot.chatType,
    direction: 'bot',
    senderId: request.bot,
    senderName: request.bot,
    bot: request.bot,
    text,
    memoryKey,
    at: Date.now(),
  };
}


/**
 * 这一轮能查多大范围：照来源快照（受管后台是派活时的 frontTask.sourceSnapshot，前台是 activeSourceSnapshot）。
 * 本人（isHistoryOwner：不是外人、不在群里，飞书本人或本机网页、命令行）全都能查；别的只查快照里这个聊天。
 * @param session 调工具的会话。
 */
export function getAccess(session: Session): ChannelAccess {
  //M 记忆工具和开场召回共享可信来源和归属。
  return memoryKeyModule.getMemoryAccess(session.row);
}

/** 按来源快照决定本轮能查的渠道、聊天和账号。 */
export function getScope(args: Record<string, unknown>, access: ChannelAccess): ChannelScope {
  //G 本人可以指定聊天，外人和群聊只能用这一轮快照里的范围。
  const channel = textModule.getText(args, 'channel') || undefined;
  const chat = textModule.getText(args, 'chat') || undefined;
  if (access.full) return { channel, chat };

  if (!access.channel || !access.chat || !access.account || access.key === undefined) {
    throw new Error('这一轮没有确定的来源聊天和归属，查不了渠道消息');
  }

  const otherChannel = channel !== undefined && channel !== access.channel;
  const otherChat = chat !== undefined && chat !== access.chat;
  if (otherChannel || otherChat) throw new Error('这一轮说话的不是用户本人（或在群里），只能查这个聊天的消息');

  return { channel: access.channel, chat: access.chat, account: access.account, memoryKey: access.key };
}


/**
 * 时间参数 → 毫秒：写成 2026-11-17、2026-11-17 08:30 这类（服务器本地时间），或毫秒数。
 * @param value 工具参数或查询参数。
 * @param label 参数名，报错用。
 * @returns 毫秒；没写是 undefined。
 * @throws 认不出来时抛错。
 */
function getTime(value: unknown, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;

  if (typeof value !== 'string') throw new Error(`${label} 要写日期或毫秒数`);

  //M 全是数字：当毫秒。
  const text = value.trim();
  if (text === '') return undefined;

  if (/^\d+$/u.test(text)) {
    const millis = Number(text);
    if (Number.isSafeInteger(millis)) return millis;

    throw new Error(`${label} 超出毫秒数范围`);
  }

  const parsed = Date.parse(text.replace(' ', 'T'));
  if (Number.isNaN(parsed)) throw new Error(`${label} 要写成 2026-11-17 或 2026-11-17 08:30 这样的时间（或毫秒数）：${text}`);

  return parsed;
}


/**
 * 工具和接口共用：把参数拼成查询（时间、关键词、条数），范围由调用方定。
 * @param args 参数：since、until、query、limit。
 * @param scope 渠道、聊天（调用方查过范围）。
 */
export function getQuery(args: Record<string, unknown>, scope: ChannelScope): ChannelQuery {
  //M 关键词参数按空白拆成几个词，每个词都要在正文里出现。
  const words = textModule.getText(args, 'query').split(/\s+/u).filter((word) => word !== '');

  //M 条数：默认 50，1 到 200。
  let limit = LIMIT_DEFAULT;
  const written = Number(args['limit']);
  if (Number.isInteger(written) && written > 0) {
    limit = Math.min(written, LIMIT_MAX);
  }

  //M 时间参数换成毫秒（认不出来抛错），连同调用方定好的渠道、聊天一起拼成查询。
  const since = getTime(args['since'], 'since');
  const until = getTime(args['until'], 'until');
  if (since !== undefined && until !== undefined && since > until) throw new Error('since 不能晚于 until');

  return { ...scope, since, until, words, limit };
}


/**
 * 工具结果：一条一行“[时间] 渠道·聊天 发言人：正文”，新的在前。
 * @param rows 命中的消息。
 * @param query 查询（写在开头）。
 */
export function getResultText(rows: ChannelRow[], query: ChannelQuery): string {
  const where = `${query.channel ?? '所有渠道'}·${query.chat ?? '所有聊天'}`;
  if (rows.length === 0) return `${where} 没找到消息`;

  const lines = [`${where} 找到 ${String(rows.length)} 条（新的在前，最多 ${String(query.limit)} 条）：`];
  for (const row of rows) {
    const time = new Date(row.at).toLocaleString('sv-SE').slice(0, 16);
    let who = row.senderName || row.senderId;
    if (row.direction === 'bot') {
      who = `机器人 ${row.bot}`;
    }
    const text = row.text.replace(/\s+/gu, ' ').slice(0, TEXT_MAX);
    lines.push(`[${time}] ${row.channel}·${row.chat} ${who}：${text}`);
  }
  return lines.join('\n');
}


/**
 * 查渠道消息开关（memory 插件配置的 channel_index）：不写是开。
 * @param raw 配置里写的。
 * @throws 不是布尔时抛错。
 */
export function readEnabled(raw: unknown): boolean {
  if (raw === undefined) return true;

  if (typeof raw !== 'boolean') throw new Error('memory 的 channel_index 要写 true 或 false（不写是开）');

  return raw;
}


/**
 * 挂上渠道消息索引：听两个渠道事件写索引，登记工具 channel_search，http 在就开 GET /api/memory/channel。memory 的 apply 调。
 * @param ctx memory 插件的 ctx。
 * @param index 索引。
 * @param rust 渠道同步任务，缺省时只写本地索引。
 * 副作用：登记监听、工具、接口。
 */
export function applyChannelIndex(
  ctx: cordis.Context, index: ChannelIndex, unified: Search, rust?: ChannelBackfill,
): void {
  //M 用户的话：渠道先落盘再发 channel/message；记不上只打日志，不挡别人认领。
  ctx.on('channel/message', (message) => {
    try {
      const row = getMessageRow(message);
      if (row === undefined) return;

      //M 先持久化消息，再通知后台同步。Rust 慢或离线时不阻塞渠道。
      index.add(row, true);
      rust?.wake();
    } catch (error) {
      //G 记不进索引只打日志，不往外抛，别挡别人认领这条消息。
      console.error(`memory：渠道消息记不进索引：${textModule.getMessage(error)}`);
    }
  }, { prepend: true });

  //M 机器人的话：回复工具发出时（channel/reply）记，同一个 replyRequestKey 重试不重复。
  ctx.on('channel/reply', (request) => {
    try {
      const row = getReplyRow(request);
      if (row === undefined) return;

      //M 与入站共用持久化队列，重复回复沿用首次记下的正文和时间。
      index.add(row, true);
      rust?.wake();
    } catch (error) {
      //G 记不进索引只打日志，不往外抛，别挡回复发出去。
      console.error(`memory：机器人的回复记不进索引：${textModule.getMessage(error)}`);
    }
  }, { prepend: true });

  //M 工具 channel_search：前台、后台都给；外人那一轮 approval 的只读名单里有它，但只查得到自己这个聊天。
  ctx.tools.register({
    definition: {
      name: 'channel_search',
      description: '按渠道、聊天、时间、关键词查各渠道（飞书、微信、网页、命令行）的聊天记录，新的在前。'
        + '本人：channel、chat 都可以写（chat 是飞书 chat_id、微信会话名、http:本机、cli:本机），不写就查全部；'
        + '不是本人、或者在群里：只能查这个聊天，写了别的会被拒。'
        + 'since、until 写成 2026-11-17 或 2026-11-17 08:30；query 是关键词，空格分开的几个都要有；limit 默认 50、最多 200。',
      parameters: piAi.Type.Object({
        channel: piAi.Type.Optional(piAi.Type.String({ description: '渠道：feishu、wechat、http、cli' })),
        chat: piAi.Type.Optional(piAi.Type.String({ description: '聊天号' })),
        since: piAi.Type.Optional(piAi.Type.String({ description: '从什么时候起' })),
        until: piAi.Type.Optional(piAi.Type.String({ description: '到什么时候止' })),
        query: piAi.Type.Optional(piAi.Type.String({ description: '关键词，空格分开' })),
        limit: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, maximum: LIMIT_MAX, description: '最多几条，默认 50' })),
      }),
    },
    kinds: ['front', 'work'],
    run: (args, session) => {
      //M 兼容原参数和文本格式，查询和权限交给统一检索。
      const { rows, query } = unified.findChannel(args, session);
      return getResultText(rows, query);
    },
  });

  //M 接口：令牌由 http 统一查（本机来的不查），这里按本人全量查。
  void ctx.inject(['http'], (sub) => {
    sub.http.app.get<{ Querystring: Record<string, unknown> }>('/api/memory/channel', async (request, reply) => {
      const params = request.query;
      try {
        const scope = {
          channel: textModule.getText(params, 'channel') || undefined,
          chat: textModule.getText(params, 'chat') || undefined,
        };
        //M 接口的关键词参数叫 q，换成工具用的 query 再拼查询；范围不限制（本人全量）。
        const query = getQuery({ ...params, query: params['q'] }, scope);
        const id = textModule.getText(params, 'id');
        if (id !== '') return index.context(id, query);

        //M 常规接口保留按关键词和时间查消息的回执。
        return { hits: index.search(query) };
      } catch (error) {
        //G 参数写错（比如时间认不出来）回 400 并带原因。
        return reply.code(400).send({ error: textModule.getMessage(error) });
      }
    });
  });
}
