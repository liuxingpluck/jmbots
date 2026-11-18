/** 只读统计 Rust 段落的归属覆盖率。只查来源与身份元数据，输出总数和原因。 */
import * as sqlite from 'bun:sqlite';
import * as path from 'node:path';
import * as channelModule from './ChannelIndex.ts';
import * as keyModule from './MemoryKey.ts';
import * as storeModule from './Store.ts';


/** 旧渠道索引里用于判断归属的字段，查询不取正文。 */
interface AttributionRow {
  /** 消息所在渠道。 */
  channel: string;
  /** 原渠道账号，用于区分同号的私聊。 */
  account: string;
  /** 原渠道聊天号。 */
  chat: string;
  /** 已记录的私聊、群聊或本机类型。 */
  chatType: string;
  /** 用户发言或机器人回复。 */
  direction: string;
  /** 原始发言人，旧回复可能只记了 bot 或 self。 */
  senderId: string;
}

/** 写入时主库作为附件，预览时直接打开。 */
export type IndexSchema = 'main' | 'app_index';


/** 两处扫描共用缺失渠道归属的原因类别。 */
function getChannelReasons() {
  return { ambiguousPerson: 0, missingPerson: 0, missingChat: 0, missingChannel: 0, unknownChatType: 0 };
}


/** 渠道归属只使用来源元数据。 */
const attributionFields = 'channel, account, chat, chat_type AS chatType, direction, sender_id AS senderId';


/** 原渠道、账号、私聊中有两位不同发话人就足以判歧义。 */
function getPeerLookup(index: sqlite.Database, table: string) {
  const sql = `SELECT DISTINCT sender_id AS senderId FROM ${table}`
    + " WHERE channel = ? AND account = ? AND chat = ? AND chat_type = 'p2p' AND direction = 'user'"
    + " AND sender_id NOT IN ('', 'self') LIMIT 2";
  //M 复用查询查找每条老回复的对话人。
  return index.query<{ senderId: string }, [string, string, string]>(sql);
}


/** 用历史渠道字段还原线上归属输入，无法确定时记录原因。 */
function getChannelKey(
  row: AttributionRow,
  findPeers: ReturnType<typeof getPeerLookup>,
  reasons: ReturnType<typeof getChannelReasons>,
): string {
  let person = row.senderId;
  const wechatPrivate = row.channel === 'wechat' && row.chatType === 'p2p';
  if (wechatPrivate) {
    //M 微信私聊的聊天号就是对方 ID，包括早期记为 self 的发送端。
    person = row.chat;
  }
  if (!wechatPrivate && row.chatType === 'p2p' && row.direction === 'bot') {
    //M 旧回复未记收件人，只采用同账号、同私聊中唯一的对话人。
    person = '';
    if (row.channel !== '' && row.account !== '' && row.chat !== '') {
      const candidates = findPeers.all(row.channel, row.account, row.chat);
      if (candidates.length > 1) {
        reasons.ambiguousPerson += 1;
        return '';
      }
      person = candidates[0]?.senderId ?? '';
    }
  }
  if (!wechatPrivate && row.chatType === 'p2p' && row.direction !== 'bot') {
    //G 仅用户发言能提供对方 ID，self 是旧记录占位。
    if (row.direction !== 'user' || person === 'self') {
      person = '';
    }
  }

  //M 归属键沿用线上写入的函数，旧记录只补来源字段。
  const source = { channel: row.channel, chatType: row.chatType, chat: row.chat, person };
  const key = keyModule.getMemoryKey(source);
  if (key !== '') return key;

  if (row.channel === '') {
    reasons.missingChannel += 1;
    return '';
  }
  if (row.chatType === 'p2p') {
    reasons.missingPerson += 1;
    return '';
  }
  if (row.chatType === 'group') {
    reasons.missingChat += 1;
    return '';
  }
  reasons.unknownChatType += 1;
  return '';
}


/**
 * 只扫描空键渠道行，返回可补和缺失归属原因的计数，不写库。
 * @param index 主库连接，或附上主库的 Rust 连接。
 * @param collect Backfill_Memory_Keys 的渠道计划收集器。
 * @param schema 主库在连接中的名字。
 */
export function countChannelKeys(
  index: sqlite.Database,
  collect: (messageKey: string, key: string) => void,
  schema: IndexSchema,
) {
  //G 新列先由已发布的插件安装，迁移只负责其中的数据。
  const columnsSql = `PRAGMA ${schema}.table_info(memory_channel_messages)`;
  const columns = index.query<{ name: string }, []>(columnsSql).all();
  const installed = columns.some((column) => column.name === 'memory_key');
  if (!installed) {
    throw new Error('主库还没有 memory_key，先让 memory 1.7 或更新版启动一次');
  }

  //M 已标的行仍可供同一私聊查找对话人，只有空键行进入计划。
  const counts = { empty: 0, recoverable: 0, reasons: getChannelReasons() };
  const table = `${schema}.memory_channel_messages`;
  const findPeers = getPeerLookup(index, table);
  const sql = `SELECT msg_key AS messageKey, ${attributionFields} FROM ${table} WHERE memory_key = ''`;
  const rows = index.query<AttributionRow & { messageKey: string }, []>(sql);
  for (const row of rows.iterate()) {
    counts.empty += 1;
    const key = getChannelKey(row, findPeers, counts.reasons);
    if (key === '') continue;

    //M 计划只保存原消息键和待补归属。
    counts.recoverable += 1;
    collect(row.messageKey, key);
  }
  return counts;
}


/** 可确定归属的段落及需要同步的渠道消息。 */
export interface KeyCandidate {
  /** Rust 段落行号。 */
  id: number;
  /** 段落原客户号。 */
  previous: string;
  /** 已从来源元数据算出的归属键。 */
  key: string;
  /** 渠道段落对应的原消息键。 */
  messageKey?: string;
}

/** 迁移时按旧会话的明确来源地址推断归属；缺地址或来源不明都保持空白。 */
function getSessionKey(raw: string, previous: string): string {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return '';
  }
  if (meta === null || typeof meta !== 'object') return '';

  const origin = (meta['frontTask'] as { origin?: { channel?: string; address?: unknown } } | undefined)?.origin;
  const channel = origin?.channel ?? meta['channel'];
  if (typeof channel !== 'string') return '';

  //M 来源用会话保留的回话地址，不从正文、客户名字或最后出现的发言人猜。
  let address = meta['address'];
  if (origin !== undefined) {
    address = origin.address;
  }
  //G 旧段落的客户必须吻合会话地址，避免把曾被改派到其他聊天的会话整体归给最后一位。
  let customer = meta['customer'];
  if (typeof customer !== 'string' || customer === '') {
    customer = storeModule.customerFrom(channel, address);
  }
  if (customer !== previous) return '';

  //M 复用线上归属解析，确保迁移使用同一套标识。
  const source = keyModule.getOriginSource(channel, address);
  return keyModule.getMemoryKey(source);
}


/**
 * 逐段核对 Rust 存量与主库渠道索引。
 * @param store Rust 记忆库。
 * @param index jmbots 主库。
 * @param candidate 迁移入口的候选收集器；给出时才尝试会话来源。
 * @param schema 主库在连接中的名字。
 * @returns 可补、已标和不能补的计数。不写两边的库。
 */
export function countMemoryKeys(
  store: sqlite.Database,
  index: sqlite.Database,
  candidate?: (item: KeyCandidate) => void,
  schema: IndexSchema = 'main',
) {
  const counts = {
    total: 0,
    tagged: 0,
    recoverable: 0,
    reasons: {
      unowned: 0,
      outsideChannelIndex: 0,
      missingIndexRow: 0,
      ...getChannelReasons(),
    },
  };

  //M 查历史字段，不依赖新版本才有的 memory_key 列。
  const messages = `${schema}.memory_channel_messages`;
  const indexQuery = `SELECT ${attributionFields} FROM ${messages} WHERE msg_key = ?`;
  const tableSql = `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`;
  const hasTable = index.query(tableSql);
  const present = hasTable.get('memory_channel_messages') !== null;
  let findRow: sqlite.Statement<AttributionRow, [string]> | undefined;
  let findPeers: ReturnType<typeof getPeerLookup> | undefined;
  if (present) {
    //M 复用按消息键和私聊查找的查询；旧运行时可能还没有渠道索引。
    findRow = index.query(indexQuery);
    findPeers = getPeerLookup(index, messages);
  }

  //M 流式读段落元数据，常驻内存只保留计数和当前行。
  //M 旧统计不读取会话。迁移需要时才尝试打开会话元数据查询。
  let findSession: sqlite.Statement<{ meta: string }, [string]> | undefined;
  if (candidate !== undefined) {
    if (hasTable.get('sessions') !== null) {
      const sessionSql = `SELECT meta FROM ${schema}.sessions WHERE id = ?`;
      findSession = index.query(sessionSql);
    }
  }

  //M 只读取段落标识和归属字段，避免把正文带进统计进程。
  const docs = store.query<{ id: number; source: string; scope: string; customer: string }, []>(
    'SELECT rowid AS id, source, scope, customer FROM docs',
  );
  for (const doc of docs.iterate()) {
    counts.total += 1;
    if (doc.scope !== 'history') {
      counts.reasons.unowned += 1;
      continue;
    }

    //M 已经入库的归属键与正式写入、检索使用同一格式检查。
    if (keyModule.isMemoryKey('person', doc.customer) || keyModule.isMemoryKey('group', doc.customer)) {
      counts.tagged += 1;
      continue;
    }

    //G 无渠道来源键的前台、会话或导入段落，不能用消息索引可靠推断归属。
    const prefix = channelModule.CHANNEL_PARTITION;
    if (!doc.source.startsWith(prefix)) {
      const session = /^(?:session|bot-log):([^:]+)$/u.exec(doc.source)?.[1];
      if (session !== undefined && findSession !== undefined) {
        //M 只针对现存且地址明确的会话生成迁移项。
        const found = findSession.get(session);
        if (found !== null) {
          const key = getSessionKey(found.meta, doc.customer);
          if (key !== '') {
            counts.recoverable += 1;
            candidate?.({ id: doc.id, previous: doc.customer, key });
            continue;
          }
        }
      }
      counts.reasons.outsideChannelIndex += 1;
      continue;
    }

    //M 用稳定的渠道消息键回查元数据，避免凭旧客户号猜人。
    const messageKey = doc.source.slice(prefix.length);
    const row = findRow?.get(messageKey);
    if (row == null || findPeers === undefined) {
      counts.reasons.missingIndexRow += 1;
      continue;
    }

    //M 段落与空键索引走同一套推断。
    const key = getChannelKey(row, findPeers, counts.reasons);
    if (key === '') continue;

    counts.recoverable += 1;
    candidate?.({ id: doc.id, previous: doc.customer, key, messageKey });
  }
  return counts;
}


/** 读取运行时的两张库，或显式提供 memsvc 的库文件路径。输出仅包含计数。 */
function main(): void {
  const [flag, runtime, storeFlag, storeFile] = process.argv.slice(2);
  //G 必须确定数据根；库路径不写时取程序的默认位置。
  if (flag !== '--data' || !runtime || (storeFlag !== undefined && (storeFlag !== '--store' || !storeFile))) {
    throw new Error('用法：bun Count_Memory_Keys.ts --data <运行时目录> [--store <记忆库文件>]');
  }

  //M 两个文件均按只读方式打开，文件缺失时报告错误。
  const indexPath = path.join(runtime, 'data', 'jmbots7.db');
  const storePath = storeFile ?? path.join(runtime, 'data', 'memory', 'memory.db');
  const options = { readonly: true, create: false };
  const index = new sqlite.Database(indexPath, options);
  try {
    const store = new sqlite.Database(storePath, options);
    try {
      const counts = countMemoryKeys(store, index);
      const output = JSON.stringify(counts, null, 2);
      console.log(output);
    } finally {
      store.close();
    }
  } finally {
    //M 即使审计中断也要关闭主库，释放读连接。
    index.close();
  }
}


if (import.meta.main) {
  //M 仅命令行入口打开文件；测试可用内存库直接调用统计。
  main();
}
