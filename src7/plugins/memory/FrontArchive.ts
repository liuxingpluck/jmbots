/** 前台往来的正文统一由渠道消息索引持有，关联表只保留编号和会话归属。 */
import * as crypto from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { ChannelIndex, ChannelRow } from './ChannelIndex.ts';

const unarchived = "NOT EXISTS (SELECT 1 FROM memory_channel_front WHERE archive_key = 'front-log:' || b.id)";

/** 这一条往来在会话里实际看到的内容。 */
export interface FrontMessage {
  /** 机器人名称。 */
  bot: string;
  /** 当时的渠道。 */
  channel: string;
  /** 发言方向。 */
  who: 'user' | 'bot';
  /** 实际收到这句的会话号。 */
  sessionId: string;
  /** 往来正文。 */
  text: string;
  /** 会话记录时间，毫秒。 */
  time: number;
  /** 已知时为标准消息号或回复请求键。 */
  sourceKey?: string;
}

/** 前台历史行，编号兼容原来的 bot-log 引用。 */
export interface FrontEntry extends FrontMessage {
  /** 独立的前台往来编号。 */
  id: number;
}

/** 只在调用方从会话关系得出的范围内查询。 */
export interface FrontQuery {
  /** 机器人和可读会话共同限定数据范围。 */
  bot: string;
  /** 当前前台及它可读的后台会话号。 */
  sessionIds: string[];
  /** 发言方向。 */
  who?: FrontMessage['who'];
  /** 指定往来编号。 */
  id?: number;
  /** 大于此编号。 */
  after?: number;
  /** 小于此编号。 */
  before?: number;
  /** 最早时间，含。 */
  from?: number;
  /** 最晚时间，含。 */
  to?: number;
  /** 背景只取这一轮开始前的往来。 */
  beforeTime?: number;
  /** 按字面匹配，缺省时列出范围内的记录。 */
  keyword?: string;
  /** 时间倒序、编号正序或编号倒序。 */
  order: 'time' | 'first' | 'last';
  /** 返回上限。 */
  limit: number;
}

declare module 'cordis' {
  interface Events {
    /**
     * 把前台或受管后台的往来交给记忆插件保存。
     * 谁发：src7/plugins/bots/FrontDesk.ts 的 FrontDesk.log
     * 谁接：src7/plugins/memory/index.ts 的 apply
     */
    'memory/front-message'(message: FrontMessage): void;
  }
}

export class FrontArchive {
  private readonly legacyMax: number;
  private readonly needsLegacyRead: boolean;

  constructor(private readonly db: Database, private readonly index: ChannelIndex) {
    //M 只存会话关系和历史编号，正文由渠道索引按消息键提供。
    db.exec('CREATE TABLE IF NOT EXISTS memory_channel_front ('
      + ' id INTEGER PRIMARY KEY, archive_key TEXT NOT NULL UNIQUE, msg_key TEXT NOT NULL,'
      + ' bot TEXT NOT NULL, session_id TEXT NOT NULL, time INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_front_session ON memory_channel_front (bot, session_id, time)');

    //M 窗口迁移前的新编号也给现有 bot-log 引用留足位置。
    const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_log'").get();
    let last = 0;
    if (exists !== null) {
      const maximum = db.query<{ last: number }, []>('SELECT COALESCE(MAX(id), 0) AS last FROM bot_log').get();
      last = maximum?.last ?? 0;
    }
    this.legacyMax = last;
    //M 停写版本先上线时仍读尚未迁移的往来。窗口迁完后重启会只读索引。
    let needsLegacyRead = false;
    if (last > 0) {
      const sql = 'SELECT 1 FROM bot_log AS b WHERE ' + unarchived + ' LIMIT 1';
      needsLegacyRead = db.query(sql).get() !== null;
    }
    this.needsLegacyRead = needsLegacyRead;
  }

  /** 复用确定对应同一条的渠道正文，其余内容按仅前台可读归档。 */
  record(message: FrontMessage, legacyId?: number): boolean {
    let identity = message.sourceKey;
    if (identity === undefined) {
      identity = crypto.randomUUID();
    }
    let archiveKey = 'front:' + JSON.stringify([message.sessionId, identity]);
    if (legacyId !== undefined) {
      archiveKey = 'front-log:' + String(legacyId);
    }

    //M 正文和会话编号一起提交，重放沿用第一次保存的条目。
    const save = this.db.transaction(() => {
      const known = this.db.query('SELECT id FROM memory_channel_front WHERE archive_key = ?').get(archiveKey);
      if (known !== null) return false;

      let key = archiveKey;
      if (message.sourceKey !== undefined) {
        //G 渠道记录必须与实际方向和正文相同，处理过的附件路径与上下文仍按会话原文保存。
        const sql = 'SELECT msg_key FROM memory_channel_messages'
          + ' WHERE msg_key = ? AND front_only = 0 AND channel = ? AND direction = ? AND text = ?'
          + " AND instr(',' || bot || ',', ',' || ? || ',') > 0";
        const found = this.db.query<{ msg_key: string }, [string, string, string, string, string]>(sql)
          .get(message.sourceKey, message.channel, message.who, message.text, message.bot);
        if (found !== null) {
          key = found.msg_key;
        }
      }

      if (key === archiveKey) {
        //G 缺可靠来源身份的内容仅通过会话范围读取。
        const row: ChannelRow = {
          key,
          channel: message.channel,
          account: '',
          chat: '',
          chatType: '',
          direction: message.who,
          senderId: '',
          senderName: '',
          bot: message.bot,
          text: message.text,
          at: message.time,
        };
        //M 正文仍走渠道索引，最后一个标记限制它只能按会话读取。
        this.index.add(row, false, true);
      }

      //M 迁移沿用历史编号，新的在 SQLite 写事务里分配。
      const sql = 'INSERT INTO memory_channel_front (id, archive_key, msg_key, bot, session_id, time)'
        + ' VALUES (COALESCE(?, max(COALESCE((SELECT max(id) FROM memory_channel_front), 0), ?) + 1), ?, ?, ?, ?, ?)';
      this.db.query(sql).run(
        legacyId ?? null, this.legacyMax, archiveKey, key, message.bot, message.sessionId, message.time,
      );
      return true;
    });
    return save.immediate();
  }

  /** 读可见会话的最近往来、分页或指定编号。 */
  read(query: FrontQuery): FrontEntry[] {
    if (query.sessionIds.length === 0) return [];

    //G 编号和其他筛选条件不能放宽机器人和会话范围。
    const slots = query.sessionIds.map(() => '?').join(', ');
    const where = ['bot = ?', `sessionId IN (${slots})`];
    const values: (string | number)[] = [query.bot, ...query.sessionIds];
    const filters = [
      ['who = ?', query.who],
      ['id = ?', query.id],
      ['id > ?', query.after],
      ['id < ?', query.before],
      ['time >= ?', query.from],
      ['time <= ?', query.to],
      ['time < ?', query.beforeTime],
      ['instr(text, ?) > 0', query.keyword],
    ] as const;
    for (const [condition, value] of filters) {
      if (value === undefined) continue;

      //M 条件与绑定值成对追加，空的筛选项已在上面跳过。
      where.push(condition);
      values.push(value);
    }

    let order = 'id DESC';
    if (query.order === 'first') {
      order = 'id';
    }
    if (query.order === 'time') {
      order = 'time DESC, id DESC';
    }
    const predicate = where.join(' AND ');
    let source = 'SELECT f.id, f.bot, m.channel, m.direction AS who, f.session_id AS sessionId, m.text, f.time'
      + ' FROM memory_channel_front AS f JOIN memory_channel_messages AS m ON m.msg_key = f.msg_key';
    if (this.needsLegacyRead) {
      //M 过渡期只合并还没有关联的旧行，查询条件、顺序和分页同时约束新旧两边。
      source += ' UNION ALL SELECT b.id, b.bot, b.channel, b.who, b.sessionId, b.text, b.time FROM bot_log AS b'
        + ' WHERE ' + unarchived;
    }
    const sql = `SELECT * FROM (${source}) WHERE ${predicate} ORDER BY ${order} LIMIT ?`;

    //M 给出这场有权读取的前台编号及其索引正文。
    return this.db.query<FrontEntry, (string | number)[]>(sql).all(...values, query.limit);
  }
}
