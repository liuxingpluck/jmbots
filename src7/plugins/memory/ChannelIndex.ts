/**
 * 渠道消息索引（C 块，11-18，用户 #130）：各渠道的消息按聊天记进一张表，能按“渠道 + 聊天 + 时间范围 + 关键词”查。
 * 增量：听 channel/message（用户的话；飞书、微信、网页、命令行都是先落盘再发）、channel/reply（机器人的话，带来源快照和正文），
 *   键分别是 messageId、replyRequestKey，INSERT OR IGNORE 幂等。
 * 查：工具 channel_search、GET /api/memory/channel。外人（src7/Channels.ts 的 isHistoryOwner 不过，群里本人也算）只查这一轮来源快照里的这个聊天。
 * 补旧：scripts/Backfill_Channel_Index.ts 用这里的 ChannelIndex 写。
 * 不用 FTS5：中文没有分词，unicode61 整句当一个词、trigram 查不了两个字的词；先按渠道、聊天、时间走索引缩小范围，再 LIKE。
 * 设计：docs/开发进度/132_渠道消息进记忆_20261118.md。
 */
import type { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as protocolModule from '../../Channels.ts';


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
  /** 时间，毫秒。 */
  at: number;
}


/** 一次查询。 */
export interface ChannelQuery {
  /** 只查这个渠道；不给不限。 */
  channel?: string;
  /** 只查这个聊天；不给不限。 */
  chat?: string;
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
interface ChannelAccess {
  /** 本人（isHistoryOwner）：哪个渠道、哪个聊天都能查。 */
  full: boolean;
  /** 这一轮来源快照的渠道；没有快照是 undefined。 */
  channel?: string;
  /** 这一轮来源快照的聊天；没有快照是 undefined。 */
  chat?: string;
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
    db.exec('CREATE TABLE IF NOT EXISTS memory_channel_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, msg_key TEXT NOT NULL UNIQUE,'
      + ' channel TEXT NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL, chat_type TEXT NOT NULL, direction TEXT NOT NULL,'
      + ' sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, bot TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)');

    //M 按聊天看一段时间（最常用）、不分聊天按时间看。
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_chat ON memory_channel_messages (channel, chat, at)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_at ON memory_channel_messages (at)');
  }

  /**
   * 记一条；同一个键已经有了就不动。
   * @param row 一条消息。
   * @returns 新记了是 true，早有了是 false。
   * 副作用：写库。
   */
  add(row: ChannelRow): boolean {
    const sql = 'INSERT OR IGNORE INTO memory_channel_messages'
      + ' (msg_key, channel, account, chat, chat_type, direction, sender_id, sender_name, bot, text, at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [row.key, row.channel, row.account, row.chat, row.chatType, row.direction, row.senderId, row.senderName, row.bot, row.text, row.at];
    const changes = this.db.query(sql).run(...values).changes;
    return changes === 1;
  }

  /**
   * 有没有“差不多的同一条”：同渠道、同聊天、同方向、同正文，时间差在 windowMs 以内。补旧时键拼不出来（命令行、飞书机器人回复）用它去重。
   * @param row 一条消息。
   * @param windowMs 时间差。
   */
  hasSimilar(row: ChannelRow, windowMs: number): boolean {
    const sql = 'SELECT 1 FROM memory_channel_messages WHERE channel = ? AND chat = ? AND direction = ? AND text = ? AND at BETWEEN ? AND ? LIMIT 1';
    const found = this.db.query(sql).get(row.channel, row.chat, row.direction, row.text, row.at - windowMs, row.at + windowMs);
    return found !== null;
  }

  /**
   * 查：先按渠道、聊天、时间（走索引）缩小，再要求每个关键词都在正文里（LIKE，%、_ 照字面），新的在前。
   * @param query 条件（调用方查过范围）。
   * @returns 命中的消息。
   */
  search(query: ChannelQuery): ChannelRow[] {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    //M 渠道、聊天、时间：有才加。
    if (query.channel !== undefined) {
      conditions.push('channel = ?');
      values.push(query.channel);
    }
    if (query.chat !== undefined) {
      conditions.push('chat = ?');
      values.push(query.chat);
    }
    if (query.since !== undefined) {
      conditions.push('at >= ?');
      values.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push('at <= ?');
      values.push(query.until);
    }

    //M 关键词：每个都要有；% _ \ 转义，照字面找。
    for (const word of query.words) {
      conditions.push("text LIKE ? ESCAPE '\\'");
      values.push(`%${word.replace(/[\\%_]/gu, (mark) => `\\${mark}`)}%`);
    }

    //M 拼 SQL：没有条件就是全部。
    let sql = 'SELECT * FROM memory_channel_messages';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY at DESC, id DESC LIMIT ?';
    values.push(query.limit);

    //M 查出来的行是表里的列名，用 getRow 逐行转成 ChannelRow 交回。
    const rows = this.db.query(sql).all(...values) as Record<string, unknown>[];
    return rows.map(getRow);
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
    text: message.text,
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

  const snapshot = request.sourceSnapshot;
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
    at: Date.now(),
  };
}


/**
 * 这一轮能查多大范围：照来源快照（受管后台是派活时的 frontTask.sourceSnapshot，前台是 activeSourceSnapshot）。
 * 本人（isHistoryOwner：不是外人、不在群里，飞书本人或本机网页、命令行）全都能查；别的只查快照里这个聊天。
 * @param session 调工具的会话。
 */
function getAccess(session: Session): ChannelAccess {
  const snapshot = session.row.frontTask?.sourceSnapshot ?? session.row.activeSourceSnapshot;
  if (snapshot === undefined) return { full: false };

  //M 是不是本人（飞书本人、本机网页或命令行，且不在群里）交给渠道协议判断：本人哪个聊天都能查，别人只能查快照里这个聊天。
  const full = protocolModule.isHistoryOwner(snapshot);
  return { full, channel: snapshot.channel, chat: snapshot.chatId };
}


/**
 * 时间参数 → 毫秒：写成 2026-11-17、2026-11-17 08:30 这类（服务器本地时间），或毫秒数。
 * @param value 工具参数或查询参数。
 * @param label 参数名，报错用。
 * @returns 毫秒；没写是 undefined。
 * @throws 认不出来时抛错。
 */
function getTime(value: unknown, label: string): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  //M 全是数字：当毫秒。
  const text = value.trim();
  if (/^\d+$/u.test(text)) return Number(text);

  const parsed = Date.parse(text.replace(' ', 'T'));
  if (Number.isNaN(parsed)) throw new Error(`${label} 要写成 2026-11-17 或 2026-11-17 08:30 这样的时间（或毫秒数）：${text}`);

  return parsed;
}


/**
 * 工具和接口共用：把参数拼成查询（时间、关键词、条数），范围由调用方定。
 * @param args 参数：since、until、query、limit。
 * @param scope 渠道、聊天（调用方查过范围）。
 */
function getQuery(args: Record<string, unknown>, scope: { channel?: string; chat?: string }): ChannelQuery {
  //M 关键词参数按空白拆成几个词，每个词都要在正文里出现。
  const words = textModule.getText(args, 'query').split(/\s+/u).filter((word) => word !== '');

  //M 条数：默认 50，1 到 200。
  let limit = LIMIT_DEFAULT;
  const written = Number(args['limit']);
  if (Number.isInteger(written) && written > 0) {
    limit = Math.min(written, LIMIT_MAX);
  }

  //M 时间参数换成毫秒（认不出来抛错），连同调用方定好的渠道、聊天一起拼成查询。
  return {
    ...scope,
    since: getTime(args['since'], 'since'),
    until: getTime(args['until'], 'until'),
    words,
    limit,
  };
}


/**
 * 工具结果：一条一行“[时间] 渠道·聊天 发言人：正文”，新的在前。
 * @param rows 命中的消息。
 * @param query 查询（写在开头）。
 */
function getResultText(rows: ChannelRow[], query: ChannelQuery): string {
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
 * 副作用：登记监听、工具、接口。
 */
export function applyChannelIndex(ctx: cordis.Context, index: ChannelIndex): void {
  //M 用户的话：渠道先落盘再发 channel/message；记不上只打日志，不挡别人认领。
  ctx.on('channel/message', (message) => {
    try {
      const row = getMessageRow(message);
      if (row !== undefined) {
        index.add(row);
      }
    } catch (error) {
      //G 记不进索引只打日志，不往外抛，别挡别人认领这条消息。
      console.error(`memory：渠道消息记不进索引：${textModule.getMessage(error)}`);
    }
  });

  //M 机器人的话：回复工具发出时（channel/reply）记，同一个 replyRequestKey 重试不重复。
  ctx.on('channel/reply', (request) => {
    try {
      const row = getReplyRow(request);
      if (row !== undefined) {
        index.add(row);
      }
    } catch (error) {
      //G 记不进索引只打日志，不往外抛，别挡回复发出去。
      console.error(`memory：机器人的回复记不进索引：${textModule.getMessage(error)}`);
    }
  });

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
      //M 先算这一轮能查多大范围：本人全部，别人只能查来源快照里这个聊天。
      const access = getAccess(session);

      //M 渠道、聊天参数读成字符串；没写是 undefined（不限）。
      let channel = textModule.getText(args, 'channel') || undefined;
      let chat = textModule.getText(args, 'chat') || undefined;

      //G 不是本人（或在群里）：只许这一轮这个聊天；写了别的直接拒。
      if (!access.full) {
        if (access.chat === undefined) throw new Error('这一轮没有来源聊天，查不了渠道消息');

        const otherChannel = channel !== undefined && channel !== access.channel;
        const otherChat = chat !== undefined && chat !== access.chat;
        if (otherChannel || otherChat) throw new Error('这一轮说话的不是用户本人（或在群里），只能查这个聊天的消息');

        channel = access.channel;
        chat = access.chat;
      }

      //M 范围定好了，把时间、关键词、条数拼成查询，到表里查。
      const query = getQuery(args, { channel, chat });
      const rows = index.search(query);

      //T 跟踪：查了一次渠道消息。
      const vars = {
        会话: session.id,
        本人: access.full,
        渠道: query.channel ?? '全部',
        聊天: query.chat ?? '全部',
        关键词: query.words.join(' '),
        条数: rows.length,
      };
      //T 把这一次查的范围、关键词和命中条数发进跟踪。
      ctx.emit('trace', 'ChannelIndex.search', '查渠道消息', 'SELECT memory_channel_messages', vars);

      //M 命中的消息拼成一条一行的文字交回给模型。
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
        return { hits: index.search(query) };
      } catch (error) {
        //G 参数写错（比如时间认不出来）回 400 并带原因。
        return reply.code(400).send({ error: textModule.getMessage(error) });
      }
    });
  });
}
