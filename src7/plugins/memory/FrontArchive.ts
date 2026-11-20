/**
 * 前台往来归档与检索：正文统一由渠道消息索引持有，关联表只保留编号和会话归属；
 * 提供会话范围计算、前台往来翻页与关键词/语义合并检索（searchFront）及按编号取全文（getFront）。
 */
import * as crypto from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Session, Sessions } from '../../Sessions.ts';
import type { ChannelIndex, ChannelRow } from './ChannelIndex.ts';
import type { MemoryService } from './index.ts';
import * as memoryKeyModule from './MemoryKey.ts';

//退场：所有运行时的旧 bot_log 表数据都归档进 memory_channel_front（needsLegacyRead 恒为 false）以后
const unarchived = "NOT EXISTS (SELECT 1 FROM memory_channel_front WHERE archive_key = 'front-log:' || b.id)";

/** 查历史时每条截短到这么多字；全文用 memory_get。 */
const HISTORY_CLIP = 240;

/** 前台归档查询每次最多交回几条。 */
const HISTORY_PAGE = 20;

/** 语义命中的最低余弦相似度（bge-m3 已 L2 归一化）。 */
const SEMANTIC_MIN = 0.22;

/** 前台归档未挂载时给模型的提示。 */
export const HISTORY_UNAVAILABLE = '前台往来暂时读不到，请以本轮消息为准。';

/** 历史查询的附加条件，未提供的字段不参与筛选。 */
interface HistoryRange {
  /** 只取这一类发送人。 */
  who?: 'user' | 'bot';
  /** 最早时间，含。 */
  from?: number;
  /** 最晚时间，含。 */
  to?: number;
  /** 只取此编号之后的往来。 */
  after?: number;
  /** 只取此编号之前的往来。 */
  before?: number;
}

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
  //退场：所有运行时的旧 bot_log 表数据都归档进 memory_channel_front（needsLegacyRead 恒为 false）以后
  private readonly legacyMax: number;
  private readonly needsLegacyRead: boolean;

  constructor(private readonly db: Database, private readonly index: ChannelIndex) {
    //M 只存会话关系和历史编号，正文由渠道索引按消息键提供。
    db.exec('CREATE TABLE IF NOT EXISTS memory_channel_front ('
      + ' id INTEGER PRIMARY KEY, archive_key TEXT NOT NULL UNIQUE, msg_key TEXT NOT NULL,'
      + ' bot TEXT NOT NULL, session_id TEXT NOT NULL, time INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_channel_front_session ON memory_channel_front (bot, session_id, time)');

    //退场：所有运行时的旧 bot_log 表数据都归档进 memory_channel_front（needsLegacyRead 恒为 false）以后
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
      if (value === undefined) {
        continue;
      }

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
    //退场：所有运行时的旧 bot_log 表数据都归档进 memory_channel_front（needsLegacyRead 恒为 false）以后
    if (this.needsLegacyRead) {
      //M 过渡期只合并还没有关联的旧行，查询条件、顺序和分页同时约束新旧两边。
      source += ' UNION ALL SELECT b.id, b.bot, b.channel, b.who, b.sessionId, b.text, b.time FROM bot_log AS b'
        + ' WHERE ' + unarchived;
    }
    const sql = `SELECT * FROM (${source}) WHERE ${predicate} ORDER BY ${order} LIMIT ?`;

    //M 给出这场有权读取的前台编号及其索引正文。
    return this.db.query<FrontEntry, (string | number)[]>(sql).all(...values, query.limit);
  }

  /**
   * 按条件翻一页前台往来，最多 20 条。有关键词时合并文字匹配和语义检索。
   * @param sessions 会话仓库，用于计算本场及交办后台的会话范围。
   * @param service 记忆服务，有关键词时用于计算嵌入向量。
   * @param session 前台对话。
   * @param args 工具参数。
   * @returns 拼好的单页往来摘要文本。
   */
  async searchFront(
    sessions: Sessions,
    service: MemoryService,
    session: Session,
    args: Record<string, unknown>,
  ): Promise<string> {
    //M 只查这场前台和它交办的后台会话（同一个客户），范围外的往来看不到。
    const ids = getFrontSessionIds(sessions, session);
    if (ids.length === 0) return '没有往来。';

    const requestedCount = (args['count'] as number | undefined) ?? HISTORY_PAGE;
    const take = Math.min(HISTORY_PAGE, Math.max(1, requestedCount));
    const rawKeyword = args['keyword'];
    let keyword: string | undefined;
    if (typeof rawKeyword === 'string') {
      keyword = rawKeyword.trim() || undefined;
    }

    //M 只把工具传来的有效筛选项交给两路检索共用。
    const range: HistoryRange = {};
    const who = args['who'];
    if (who === 'user' || who === 'bot') {
      range.who = who;
    }
    const numericKeys = ['from', 'to', 'after', 'before'] as const;
    for (const key of numericKeys) {
      const value = args[key];
      if (typeof value === 'number') {
        range[key] = value;
      }
    }
    const fromEarliest = args['from_earliest'] === true || range.after !== undefined;
    //M 同一份筛选条件约束关键词和语义两路，确保它们都只看当前会话范围。
    const filter = { bot: session.row.bot, sessionIds: ids, ...range };

    //M 有关键词才查语义。语义命中时再取更多关键词候选，合并后按相关程度排序。
    let semantic: Array<{ entry: FrontEntry; score: number }> = [];
    if (keyword !== undefined) {
      semantic = await this.semanticHits(service, filter, keyword);
    }
    const ranked = semantic.length > 0;
    let candidateCount = take;
    if (ranked) {
      candidateCount = 2000;
    }

    //M 保留按字匹配和语义匹配的去重总数，用于提示翻页。
    let order: FrontQuery['order'] = 'last';
    if (fromEarliest) {
      order = 'first';
    }
    const query: FrontQuery = { ...filter, keyword, order, limit: candidateCount };
    const keywordRows = this.read(query);
    if (!fromEarliest) {
      keywordRows.reverse();
    }
    const semanticRows = semantic.map((hit) => hit.entry);
    const union = uniqueById(keywordRows, semanticRows);
    let shown = keywordRows;
    let orderNote = '按时间从早到晚';
    if (ranked) {
      shown = mergeHistoryHits(keywordRows, semantic, take);
      orderNote = '按相关程度';
    }
    if (shown.length === 0) return '没有符合条件的往来。';

    //M 开头一句说总数和这页范围、还有更多怎么翻；每条往来用 formatFrontEntry 截短排成一行，回给模型。
    const total = union.length;
    const first = String(shown[0]?.id);
    const last = String(shown.at(-1)?.id);
    let head = `共 ${String(total)} 条，这页 ${String(shown.length)} 条（编号 ${first}–${last}，${orderNote}）。`;
    if (total > shown.length) {
      head += '还有更多时，用 after 往后翻或 before 往前翻。';
    }
    //M 每条只放截短的正文和编号，模型需要全文时可用历史工具。
    const lines = shown.map((entry) => formatFrontEntry(entry, HISTORY_CLIP));
    return [head, ...lines].join('\n');
  }

  /** 语义检索只比较同一会话范围的候选，向量由记忆服务按需计算。 */
  private async semanticHits(
    service: MemoryService,
    filter: Omit<FrontQuery, 'order' | 'limit'>,
    keyword: string,
  ): Promise<Array<{ entry: FrontEntry; score: number }>> {
    const query: FrontQuery = { ...filter, order: 'last', limit: 2000 };
    //G 先按会话权限取候选，没有可查的往来就不向记忆模型请求向量。
    const candidates = this.read(query);
    if (candidates.length === 0) return [];

    //M 记忆服务离线时仍保留字面检索。
    const words = [keyword];
    const queryVec = await service.embed(words).catch(() => undefined);
    const vector = queryVec?.[0];
    if (vector === undefined) return [];

    const hits: Array<{ entry: FrontEntry; score: number }> = [];
    for (let offset = 0; offset < candidates.length; offset += 32) {
      //M 按与原前台同样的批量大小编码，不再另建 SQLite 向量缓存。
      const batch = candidates.slice(offset, offset + 32);
      const texts = batch.map((entry) => entry.text);
      const vectors = await service.embed(texts).catch(() => undefined);
      if (vectors === undefined) {
        break;
      }

      for (const [index, entry] of batch.entries()) {
        const value = vectors[index];
        if (value === undefined) {
          continue;
        }

        //M 和查询向量同维且超过原门槛的才参与前台结果排序。
        const score = cosine(vector, value);
        if (score >= SEMANTIC_MIN) {
          hits.push({ entry, score });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
    return hits.slice(0, HISTORY_PAGE);
  }

  /**
   * 读取本场前台归档中指定编号的全文。
   * @param sessions 会话仓库，用于计算本场及交办后台的会话范围。
   * @param session 前台对话。
   * @param id 往来编号。
   * @returns 指定往来的完整一行文本，或不存在提示。
   */
  getFront(sessions: Sessions, session: Session, id: number): string {
    //G 同时按机器人、会话范围和编号查，越界时没有结果。
    const sessionIds = getFrontSessionIds(sessions, session);
    const query: FrontQuery = { bot: session.row.bot, sessionIds, id, order: 'last', limit: 1 };
    const entries = this.read(query);
    const row = entries[0];
    if (row === undefined) return `没有编号 ${String(id)} 的往来，或不属于这场对话。`;

    //M 范围内的才排成一行（不截短）回给模型。
    return formatFrontEntry(row);
  }
}

/**
 * 核对前台归档编号读取权限：只允许有本人权限的前台会话读取。
 * @param session 调工具的会话。
 * @throws 外人、非受信群聊或非前台会话时抛错。
 */
export function checkFrontAccess(session: Session): void {
  const access = memoryKeyModule.getMemoryAccess(session.row);
  //G 原前台归档编号可能关联未补标的旧记录。
  if (!access.full || session.row.kind !== 'front') {
    throw new Error('这一轮只能查当前渠道聊天，请用 memory_search 查询已归属的记录');
  }
}

/** 计算这场前台及它交办的后台会话范围。 */
export function getFrontSessionIds(sessions: Sessions, session: Session): string[] {
  //M 和 assist 一样：后台会话的 parent 是交出它的前台对话。
  const root = session.row.parent ?? session.row.id;
  const kids = sessions.find({ parent: root }).map((row) => row.id);
  const ids = new Set<string>([root, session.row.id, ...kids]);
  //M 还没记下 parent 的旧后台：只有一场前台时也算进来，免得分会话落地前查不到交办记录。
  //M   非本人（builder、guest）说的那一轮不算：旧后台不知道是谁的，可能是用户自己的活。
  const access = memoryKeyModule.getMemoryAccess(session.row);
  if (!access.full) return [...ids];

  if (session.row.kind === 'front' && sessions.find({ bot: session.row.bot, kind: 'front' }).length <= 1) {
    for (const work of sessions.find({ bot: session.row.bot, kind: 'work' })) {
      if (work.parent === undefined) {
        ids.add(work.id);
      }
    }
  }
  return [...ids];
}

/** 把一条前台往来写成带原文编号的一行。 */
export function formatFrontEntry(entry: FrontEntry, clip?: number): string {
  const when = new Date(entry.time).toLocaleString('zh-CN', { hour12: false });
  let who = '机器人';
  if (entry.who === 'user') {
    who = '用户';
  }
  let body = entry.text;
  let suffix = '';
  if (clip !== undefined && body.length > clip) {
    body = body.slice(0, clip);
    suffix = '…（把 #编号交给 memory_get 取全文）';
  }
  return `#${String(entry.id)} [${when} ${entry.channel} ${who}] ${body}${suffix}`;
}

/**
 * 把关键词命中和语义命中按编号合并，语义分数高的靠前；只要关键词命中也保留。
 * @param keywordRows 按字匹配到的往来。
 * @param semantic 语义命中。
 * @param take 最多留几条。
 * @returns 合并排序后的当前页往来。
 */
function mergeHistoryHits(
  keywordRows: FrontEntry[],
  semantic: Array<{ entry: FrontEntry; score: number }>,
  take: number,
): FrontEntry[] {
  const scores = new Map<number, { entry: FrontEntry; score: number }>();
  for (const entry of keywordRows) {
    scores.set(entry.id, { entry, score: 1 });
  }
  for (const hit of semantic) {
    const prev = scores.get(hit.entry.id);
    if (prev === undefined) {
      scores.set(hit.entry.id, hit);
      continue;
    }

    //M 同一条同时命中关键词和语义时提高它的分数。
    const score = hit.score + 1;
    if (score > prev.score) {
      scores.set(hit.entry.id, { entry: prev.entry, score });
    }
  }

  //M 先按分数，再按编号稳定排序，只交回当前页的原文记录。
  const ranked = [...scores.values()];
  ranked.sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
  const shown = ranked.slice(0, take);
  return shown.map((row) => row.entry);
}

/**
 * 按编号去重，先出现的留下。
 * @param groups 若干组往来。
 * @returns 去重后的往来列表。
 */
function uniqueById(...groups: FrontEntry[][]): FrontEntry[] {
  const seen = new Set<number>();
  const out: FrontEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      //M 两路命中同一个编号时，只把第一次出现的那条留下。
      out.push(entry);
    }
  }
  return out;
}

/**
 * 余弦相似度；长度不同或零向量交回 0。
 * @param a 向量 a。
 * @param b 向量 b。
 * @returns 余弦相似度分数。
 */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;

  return dot / denom;
}
