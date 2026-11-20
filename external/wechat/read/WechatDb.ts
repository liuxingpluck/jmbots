/**
 * 微信 4.x 纯 Bun 只读数据库查询层：通过 DbCache 获取明文副本，用 bun:sqlite（readonly）
 * 读取 session.db、contact.db 与 message_N.db 分片（Msg_<md5> + Name2Id），
 * 当 WCDB_CT == 4 时用 Bun.zstdDecompressSync 解压正文与 msgsource。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import * as cacheModule from './DbCache.ts';
import * as viewModule from './MsgView.ts';


/** WCDB 标记 Zstandard 压缩列的固定枚举值。 */
export const WCDB_CT_ZSTD = 4;

/** Zstandard 帧头 4 字节魔数（0x28 B5 2F FD），用于 SessionTable.summary 兜底识别压缩帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 合法的微信消息分表名格式：Msg_ 加 32 位小写 MD5。 */
const SAFE_MSG_TABLE_RE = /^Msg_[0-9a-f]{32}$/u;

/** 共享的宽松 UTF-8 解码器（遇到损坏字节用替换符，不抛异常中断整批同步）。 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });


/** 创建 WechatDb 查询器所需的配置。 */
export interface WechatDbOptions {
  /** 微信账号的 db_storage 目录路径（只读访问）。 */
  dbDir: string;
  /** 账号 all_keys.json 对应的密钥映射表。 */
  allKeys: cacheModule.KeyTable;
  /** 本插件用来存放明文 SQLite 副本与页摘要的缓存根目录。 */
  cacheRoot: string;
  /** 可选的预解密目录（兼容旧环境已存在的 decrypted/contact/contact.db）。 */
  decryptedDir?: string;
  /** 可选的已知登录账号 wxid；未提供时自动从 dbDir 父目录名与联系人表推导。 */
  selfWxid?: string;
  /** 群聊正文推断 @我 时额外匹配的群昵称或别名列表。 */
  atNames?: readonly string[];
}

/** 最近会话条目（与现有 Reader.ChatItem 完全兼容）。 */
export interface SessionItem {
  /** 会话原始标识（如 wxid_xxx 或 xxx@chatroom）。 */
  username: string;
  /** 展示名（备注优先，其次昵称，最后回退 username）。 */
  chat: string;
  /** 是否为微信群聊。 */
  is_group: boolean;
  /** 未读消息条数。 */
  unread: number;
  /** 最近一条消息的单行摘要（群聊已剥除发送人前缀）。 */
  last_message: string;
  /** 最近一条消息的中文类型名。 */
  msg_type: string;
  /** 群聊最近发言人显示名；私聊为空串。 */
  sender: string;
  /** 最近消息 Unix 秒级时间戳。 */
  timestamp: number;
  /** 格式化为 MM-DD HH:mm 的本地时间文本。 */
  time: string;
}

/** 同步或补录返回的单条结构化消息（与现有 Reader.RawMessage 完全兼容）。 */
export interface SyncedMessage {
  /** 来源分片库副本文件名（与 local_id 共同组成去重键）。 */
  source: string;
  /** 该分片表内的本地消息自增号。 */
  local_id: number;
  /** 基础消息类型（local_type 低 32 位）。 */
  local_type: number;
  /** 消息发出时间，Unix 秒。 */
  create_time: number;
  /** 是否由当前登录微信号自己发出；无法判定时为 null。 */
  from_self: boolean | null;
  /** 群聊中是否 @ 了当前登录账号。 */
  at_me: boolean;
  /** 群聊中是否 @ 所有人。 */
  at_all: boolean;
  /** @ 判定的数据来源。 */
  at_source: 'atuserlist' | 'text' | '';
  /** 供客服页渲染与渠道摘要使用的气泡视图。 */
  view: viewModule.MessageView;
}

/** 单个会话增量同步或向前补录的结果（与现有 Reader.SyncResult 完全兼容）。 */
export interface ChatSyncResult {
  /** 调用方请求的会话标识（syncBatch 原样回填）。 */
  chat: string;
  /** 解析出的真实会话 username。 */
  username?: string;
  /** 解析出的会话展示名。 */
  chat_display?: string;
  /** 微信库中是否找不到该会话。 */
  missing: boolean;
  /** 单会话同步异常时的简短原因。 */
  error?: string;
  /** 是否为群聊。 */
  is_group?: boolean;
  /** 按 create_time 升序排列的消息列表。 */
  messages?: SyncedMessage[];
  /** 单条或单分片解析失败时的诊断说明（无正文）。 */
  failures?: string[] | null;
  /** 是否仍有超过本次 limit 的更多消息待拉取。 */
  more?: boolean;
}

/** 消息分片表定位信息。 */
interface ShardTable {
  /** 明文 SQLite 副本路径。 */
  replicaPath: string;
  /** 原始分片库名（如 message_0.db），作为稳定的 source 标识。 */
  sourceName: string;
  /** 校验通过的 Msg_<md5> 表名。 */
  tableName: string;
  /** 该分片内该会话的最大 create_time，用于主分片排序。 */
  maxCreateTime: number;
}

/** SQLite 消息表查询出的原始行结构。 */
interface RawMsgRow {
  /** 分片本地序号。 */
  local_id: number;
  /** 原始 32/64 位类型整数。 */
  local_type: number;
  /** Unix 秒级创建时间。 */
  create_time: number;
  /** Name2Id 中的发言人编号。 */
  real_sender_id: number | null;
  /** 原始或 Zstd 压缩的消息正文。 */
  message_content: string | Uint8Array | null;
  /** message_content 的压缩标志（4 表示 Zstd）。 */
  wcdb_ct_content: number | null;
  /** 可选的 msgsource XML 原文或压缩字节。 */
  msg_source?: string | Uint8Array | null;
  /** 可选的 msgsource 压缩标志（4 表示 Zstd）。 */
  wcdb_ct_source?: number | null;
  /** 可选的图片附属二进制数据。 */
  packed_info_data?: Uint8Array | null;
}


/**
 * 解压 WCDB 消息列或 msgsource 列：当 ct === 4（或字节以 Zstd 魔数开头）时用 Bun.zstdDecompressSync 解压。
 * @param content SQLite 读出的字符串、二进制 BLOB 或 null。
 * @param compressionType WCDB_CT_* 列数值（4 代表 Zstandard）。
 * @returns UTF-8 文本；为空或压缩帧损坏时返回 undefined。
 */
export function decompressContent(
  content: string | Uint8Array | null | undefined,
  compressionType: number | null | undefined,
): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === 'string') return content;

  const isZstdFlag = compressionType === WCDB_CT_ZSTD;
  const hasZstdMagic = (
    content.byteLength >= 4
    && content[0] === ZSTD_MAGIC[0]
    && content[1] === ZSTD_MAGIC[1]
    && content[2] === ZSTD_MAGIC[2]
    && content[3] === ZSTD_MAGIC[3]
  );

  if (isZstdFlag || hasZstdMagic) {
    try {
      const decompressed = Bun.zstdDecompressSync(content);
      return UTF8_DECODER.decode(decompressed);
    } catch {
      return undefined;
    }
  }
  return UTF8_DECODER.decode(content);
}


/**
 * 计算会话 username 对应的微信消息分表名 `Msg_<32位小写MD5>`。
 * @param username 会话原始标识（如 wxid_xxx 或 123@chatroom）。
 */
export function getMessageTableName(username: string): string {
  const md5 = crypto.createHash('md5').update(username, 'utf8').digest('hex');
  return `Msg_${md5}`;
}


/**
 * 从 all_keys 映射中筛选全部消息分片库相对路径（`message/message_N.db`），按正斜杠路径升序返回。
 * @param allKeys 账号密钥表。
 */
export function findMessageDbKeys(allKeys: cacheModule.KeyTable): string[] {
  const matched = new Set<string>();
  for (const rawKey of Object.keys(allKeys)) {
    if (rawKey.startsWith('_')) {
      continue;
    }
    //M 归一化斜杠后匹配 message/message_数字.db。
    const normalized = cacheModule.normalizeDbRelPath(rawKey);
    if (normalized === undefined) {
      continue;
    }
    if (/^message\/message_\d+\.db$/u.test(normalized)) {
      matched.add(normalized);
    }
  }
  return [...matched].sort();
}


/**
 * 拆分群聊消息正文头部的 `senderWxid:\n` 前缀。
 * @param content 解压后的消息文本。
 * @param isGroup 是否为群聊会话。
 */
function splitGroupContent(content: string | undefined, isGroup: boolean): { senderPrefix: string; bodyText: string } {
  if (content === undefined || content === '') return { senderPrefix: '', bodyText: '' };

  if (isGroup) {
    const marker = content.indexOf(':\n');
    if (marker >= 0) {
      return {
        senderPrefix: content.slice(0, marker),
        bodyText: content.slice(marker + 2),
      };
    }
  }
  return { senderPrefix: '', bodyText: content };
}


/**
 * 把 Unix 秒级时间戳格式化为 `MM-DD HH:mm`（与 sessions.py 一致）。
 * @param timestampSeconds Unix 秒。
 */
function formatShortTime(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}


/**
 * 判断一条消息是否由当前登录微信号自己发出（对齐 sync.py:_is_from_self）。
 * @param senderUsername Name2Id 解析出的发言人 username。
 * @param chatUsername 当前会话 username。
 * @param isGroup 是否为群聊。
 * @param selfWxid 当前登录账号 wxid。
 */
function resolveFromSelf(
  senderUsername: string,
  chatUsername: string,
  isGroup: boolean,
  selfWxid: string,
): boolean | null {
  if (senderUsername === '') return null;
  if (!isGroup) return senderUsername !== chatUsername;
  if (selfWxid === '') return null;

  return senderUsername === selfWxid;
}


/**
 * 提取未知异常的简短消息文本。
 * @param error 捕获到的异常值。
 */
function getErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/**
 * 只读打开一份明文 SQLite 副本执行回调，确保句柄在 finally 中立即关闭。
 * @param replicaPath 明文 SQLite 副本路径。
 * @param work 查询回调。
 */
function withReadonlyDb<T>(replicaPath: string, work: (conn: sqlite.Database) => T): T {
  const conn = new sqlite.Database(replicaPath, { readonly: true });
  try {
    return work(conn);
  } finally {
    //M 查询结束立即释放副本只读连接。
    conn.close();
  }
}


/**
 * 从单个消息分片连接中读取 Name2Id 映射表（rowid -> user_name）。
 * @param conn 已打开的消息分库只读连接。
 */
function loadName2IdMap(conn: sqlite.Database): Map<number, string> {
  const map = new Map<number, string>();
  try {
    //M 读取当前分片发言人编号与 username 映射。
    const sql = 'SELECT rowid, user_name FROM Name2Id';
    const rows = conn.query<{ rowid: number; user_name: string | null }, []>(sql).all();
    for (const row of rows) {
      if (typeof row.user_name === 'string' && row.user_name !== '') {
        map.set(row.rowid, row.user_name);
      }
    }
  } catch {
    // 部分极简分库无 Name2Id 表时返回空映射。
  }
  return map;
}


/**
 * 检查指定消息表包含哪些可选扩展列（source/WCDB_CT_source 与 packed_info_data）。
 * @param conn 已打开的消息分库连接。
 * @param tableName 已通过 SAFE_MSG_TABLE_RE 校验的表名。
 */
function inspectMsgColumns(
  conn: sqlite.Database,
  tableName: string,
): { hasSource: boolean; hasPacked: boolean } {
  //M 读取消息表结构，探测是否存在 msgsource 与图片附属二进制列。
  const rows = conn.query<{ name: string }, []>(`PRAGMA table_info([${tableName}])`).all();
  const names = new Set(rows.map((row) => row.name));
  const hasSource = names.has('source') && names.has('WCDB_CT_source');
  const hasPacked = names.has('packed_info_data');
  return { hasSource, hasPacked };
}


/**
 * 拼出单张消息表的 SELECT 列清单（把可选列统一别名到 RawMsgRow 字段名）。
 * @param flags 表列探测结果。
 */
function buildSelectColumns(flags: { hasSource: boolean; hasPacked: boolean }): string {
  let cols = 'local_id, local_type, create_time, real_sender_id, message_content,'
    + ' WCDB_CT_message_content AS wcdb_ct_content';
  if (flags.hasSource) {
    cols += ', source AS msg_source, WCDB_CT_source AS wcdb_ct_source';
  }
  if (flags.hasPacked) {
    cols += ', packed_info_data';
  }
  return cols;
}


/**
 * 单个微信账号的纯 Bun 只读查询引擎（替代原 Python wechat_cli 的 sessions / sync / backfill）。
 */
export class WechatDb {
  /** 底层加密库页级增量缓存。 */
  readonly cache: DbCacheType;

  /** 已排序的消息分片相对键列表（如 message/message_0.db）。 */
  readonly msgDbKeys: readonly string[];

  /** 预解密目录路径（可选）。 */
  private readonly decryptedDir: string | undefined;

  /** 调用方显式指定的自身 wxid（可选）。 */
  private readonly configuredSelfWxid: string;

  /** 群聊正文推断使用的额外 @ 昵称列表。 */
  private readonly extraAtNames: readonly string[];

  /**
   * @param options 账号 db_storage 路径、密钥表、缓存根目录与身份附加项。
   */
  constructor(options: WechatDbOptions) {
    //M 初始化增量解密缓存与消息分库清单。
    this.cache = new cacheModule.DbCache(options.allKeys, options.dbDir, options.cacheRoot);
    this.msgDbKeys = findMessageDbKeys(options.allKeys);
    this.decryptedDir = options.decryptedDir;
    this.configuredSelfWxid = (options.selfWxid ?? '').trim();
    this.extraAtNames = options.atNames ?? [];
  }

  /**
   * 读取账号最近活跃会话列表（按 last_timestamp 倒序）。
   * @param limit 最多返回的会话数（正整数）。
   * @returns 与 Reader.sessions 输出结构一致的会话数组。
   * @throws session.db 缺少密钥或源库不可读时抛错。
   */
  sessions(limit: number): SessionItem[] {
    //M 先刷新或复用 session/session.db 明文副本。
    const sessionReplica = this.cache.getDecryptedPath('session/session.db');
    if (sessionReplica === undefined) {
      throw new Error('无法解密 session.db');
    }

    //M 加载联系人备注与昵称字典，供会话名与群内最后发言人展示。
    const names = this.loadContactNames();
    const clampedLimit = Math.max(1, Math.min(Math.trunc(limit), 10_000));

    type RawSession = {
      username: string;
      unread_count: number | null;
      summary: string | Uint8Array | null;
      last_timestamp: number;
      last_msg_type: number;
      last_msg_sender: string | null;
      last_sender_display_name: string | null;
    };

    //M 只读查询 SessionTable 最近活跃记录。
    const rawRows = withReadonlyDb(sessionReplica, (conn) => {
      const sql = 'SELECT username, unread_count, summary, last_timestamp,'
        + ' last_msg_type, last_msg_sender, last_sender_display_name'
        + ' FROM SessionTable WHERE last_timestamp > 0 ORDER BY last_timestamp DESC LIMIT ?';
      return conn.query<RawSession, [number]>(sql).all(clampedLimit);
    });

    const items: SessionItem[] = [];
    for (const row of rawRows) {
      const username = row.username;
      const display = names.get(username) ?? username;
      const isGroup = username.includes('@chatroom');

      let summaryText = '';
      if (typeof row.summary === 'string') {
        summaryText = row.summary;
      }
      if (row.summary instanceof Uint8Array) {
        //M 二进制 summary 在微信 4.x 中为 Zstd 压缩文本，解压失败时回退固定说明。
        summaryText = decompressContent(row.summary, WCDB_CT_ZSTD) ?? '(压缩内容)';
      }
      const sepIndex = summaryText.indexOf(':\n');
      if (sepIndex >= 0) {
        summaryText = summaryText.slice(sepIndex + 2);
      }

      let senderDisplay = '';
      const rawSender = row.last_msg_sender ?? '';
      if (isGroup && rawSender !== '') {
        senderDisplay = names.get(rawSender) ?? (row.last_sender_display_name || rawSender);
      }

      //M 汇总单行会话元数据，字段命名保持与原 Python CLI 完全一致。
      const msgTypeLabel = viewModule.getMessageTypeLabel(row.last_msg_type);
      const timeLabel = formatShortTime(row.last_timestamp);
      items.push({
        chat: display,
        username,
        is_group: isGroup,
        unread: row.unread_count ?? 0,
        last_message: summaryText,
        msg_type: msgTypeLabel,
        sender: senderDisplay,
        timestamp: row.last_timestamp,
        time: timeLabel,
      });
    }
    return items;
  }

  /**
   * 一次批量同步多个会话的存量或增量消息（共用同一次联系人表读取与解密缓存）。
   * @param chats 待同步会话数组，since 为 null 表示首轮拉取最近 initialLimit 条。
   * @param initialLimit 首轮存量拉取上限，默认 50。
   * @param limit 增量拉取上限，默认 500。
   */
  syncBatch(
    chats: readonly { chat: string; since: number | null }[],
    initialLimit = 50,
    limit = 500,
  ): ChatSyncResult[] {
    const safeInit = Math.max(1, Math.min(Math.trunc(initialLimit), 5000));
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));

    //M 同批次内只加载一次联系人名称与本账号身份，避免每个会话重查 contact.db。
    const names = this.loadContactNames();
    const { selfWxid, atNames } = this.resolveSelfIdentity(names);
    const results: ChatSyncResult[] = [];

    for (const item of chats) {
      const chatQuery = item.chat;
      if (chatQuery === '' || chatQuery.startsWith('-')) {
        continue;
      }
      let rowLimit = safeLimit;
      if (item.since === null) {
        rowLimit = safeInit;
      }
      try {
        //M 按单个会话合并全部分片消息，单会话报错只记在该项 error 上不中断其余会话。
        const synced = this.collectChatMessages(chatQuery, names, selfWxid, atNames, {
          mode: 'sync',
          sinceTime: item.since,
          limit: rowLimit,
        });
        //M 收入本会话的同步结果。
        results.push(synced);
      } catch (error) {
        //G 捕获单会话同步错误并填入错误项。
        const message = getErrorDetail(error);
        results.push({ chat: chatQuery, missing: false, error: message });
      }
    }
    return results;
  }

  /**
   * 同步单个会话的消息（sinceTime 为 null 取最近 limit 条，否则取 create_time >= sinceTime）。
   * @param chatQuery 会话 username 或唯一备注/昵称。
   * @param sinceTime 增量起始秒级时间戳；首次传 null。
   * @param limit 条数上限，默认 200。
   */
  syncChat(chatQuery: string, sinceTime: number | null, limit = 200): ChatSyncResult {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
    //M 加载联系人与自身身份后查询单会话。
    const names = this.loadContactNames();
    const { selfWxid, atNames } = this.resolveSelfIdentity(names);
    return this.collectChatMessages(chatQuery, names, selfWxid, atNames, {
      mode: 'sync',
      sinceTime,
      limit: safeLimit,
    });
  }

  /**
   * 向前补录单个会话在指定秒级时间戳之前的历史消息（create_time < untilTime 的最近 limit 条，升序返回）。
   * @param chatQuery 会话 username 或唯一备注/昵称。
   * @param untilTime 严格上界 Unix 秒级时间戳。
   * @param limit 本批条数上限，默认 500。
   */
  backfill(chatQuery: string, untilTime: number, limit = 500): ChatSyncResult {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
    //M 加载联系人与自身身份后按严格时间上界向前分页。
    const names = this.loadContactNames();
    const { selfWxid, atNames } = this.resolveSelfIdentity(names);
    return this.collectChatMessages(chatQuery, names, selfWxid, atNames, {
      mode: 'backfill',
      untilTime: Math.trunc(untilTime),
      limit: safeLimit,
    });
  }

  /**
   * 按确切会话、消息分片名与分片本地消息号只读取回单条解压后的原始消息（供图片提取 MD5 与语音分片归属核验使用）。
   * @param chatUsername 会话原始 username。
   * @param sourceName 分片库文件名（如 `message_0.db`）。
   * @param localId 分片表内 `local_id`。
   */
  readMessageRaw(
    chatUsername: string,
    sourceName: string,
    localId: number,
  ): { createTime: number; baseType: number; bodyText: string; packedInfo: Uint8Array | null } | undefined {
    if (chatUsername === '' || sourceName === '' || !Number.isSafeInteger(localId)) return undefined;

    const isGroup = chatUsername.includes('@chatroom');
    //M 定位该会话的全部消息分片并筛选请求指定的分片库。
    const shards = this.findMessageShards(chatUsername);
    const targetShard = shards.find((item) => item.sourceName === sourceName);
    if (targetShard === undefined) return undefined;

    try {
      //M 在目标分片内按主键 local_id 取回原始行并解压正文。
      return withReadonlyDb(targetShard.replicaPath, (conn) => {
        const colFlags = inspectMsgColumns(conn, targetShard.tableName);
        const selectCols = buildSelectColumns(colFlags);
        const sql = `SELECT ${selectCols} FROM [${targetShard.tableName}] WHERE local_id = ? LIMIT 1`;
        const row = conn.query<RawMsgRow, [number]>(sql).get(localId);
        if (row === null) return undefined;

        const content = decompressContent(row.message_content, row.wcdb_ct_content);
        const { bodyText } = splitGroupContent(content, isGroup);
        const { baseType } = viewModule.splitMessageType(row.local_type);
        return {
          createTime: row.create_time,
          baseType,
          bodyText,
          packedInfo: row.packed_info_data ?? null,
        };
      });
    } catch {
      return undefined;
    }
  }

  /**
   * 读取 contact.db 构建 `username -> 显示名（备注 > 昵称 > username）` 字典。
   * contact.db 缺席时返回空 Map，不阻断只靠 wxid 的消息读取。
   */
  loadContactNames(): Map<string, string> {
    let contactPath: string | undefined;
    if (this.decryptedDir !== undefined) {
      const preDecrypted = path.join(this.decryptedDir, 'contact', 'contact.db');
      if (fs.existsSync(preDecrypted)) {
        contactPath = preDecrypted;
      }
    }
    if (contactPath === undefined) {
      //M 优先经增量解密缓存获取最新 contact/contact.db 明文副本。
      contactPath = this.cache.getDecryptedPath('contact/contact.db');
    }
    if (contactPath === undefined) return new Map();

    try {
      //M 只读扫描联系人表，按备注优先于昵称拼装展示名。
      return withReadonlyDb(contactPath, (conn) => {
        const map = new Map<string, string>();
        const sql = 'SELECT username, nick_name, remark FROM contact';
        const rows = conn.query<{
          username: string | null;
          nick_name: string | null;
          remark: string | null;
        }, []>(sql).all();
        for (const row of rows) {
          if (!row.username) {
            continue;
          }
          const display = row.remark || row.nick_name || row.username;
          map.set(row.username, display);
        }
        return map;
      });
    } catch {
      return new Map();
    }
  }

  /**
   * 推导当前账号的 wxid 与正文 @ 推断使用的昵称列表。
   * @param names 已加载的联系人显示名表。
   */
  private resolveSelfIdentity(names: ReadonlyMap<string, string>): { selfWxid: string; atNames: string[] } {
    let selfWxid = this.configuredSelfWxid;
    if (selfWxid === '') {
      //M 微信目录形如 .../xwechat_files/wxid_xxx_1a2b/db_storage，剥去随机后缀在联系人表核验。
      const accountFolder = path.basename(path.dirname(path.resolve(this.cache.dbDir)));
      const candidates = [accountFolder];
      const suffixMatch = /^(.+)_([0-9a-fA-F]{4,})$/u.exec(accountFolder);
      if (suffixMatch !== null && suffixMatch[1] !== undefined) {
        candidates.unshift(suffixMatch[1]);
      }
      for (const candidate of candidates) {
        if (candidate !== '' && names.has(candidate)) {
          selfWxid = candidate;
          break;
        }
      }
    }

    const atNames: string[] = [];
    let selfNick = '';
    if (selfWxid !== '') {
      selfNick = names.get(selfWxid) ?? '';
    }
    for (const raw of [selfNick, ...this.extraAtNames]) {
      const trimmed = raw.trim();
      if (trimmed !== '' && !atNames.includes(trimmed)) {
        //M 收录去重后的有效群提及昵称。
        atNames.push(trimmed);
      }
    }
    return { selfWxid, atNames };
  }

  /**
   * 将调用方传入的聊天标识（wxid、@chatroom 或唯一备注名）解析成确切 username。
   * @param chatQuery 原始查询标识。
   * @param names 联系人名称映射。
   */
  private resolveChatUsername(chatQuery: string, names: ReadonlyMap<string, string>): string | undefined {
    if (names.has(chatQuery) || chatQuery.startsWith('wxid_') || chatQuery.includes('@chatroom')) {
      return chatQuery;
    }

    const needle = chatQuery.toLowerCase();
    const exactMatches: string[] = [];
    const partialMatches: string[] = [];
    for (const [username, display] of names) {
      const lower = display.toLowerCase();
      if (lower === needle) {
        //M 记录显示名完全相等的候选。
        exactMatches.push(username);
        continue;
      }
      if (lower.includes(needle)) {
        //M 记录显示名包含关键字的候选。
        partialMatches.push(username);
      }
    }

    let pool = exactMatches;
    if (pool.length === 0) {
      pool = partialMatches;
    }
    if (pool.length > 1) {
      throw new Error('Ambiguous chat name; use an exact username');
    }
    return pool[0];
  }

  /**
   * 在所有已解密的 message_N.db 分片中定位包含该会话 Msg_<md5> 表的分库，按最新消息时间倒序返回。
   * @param username 已解析的会话 username。
   */
  private findMessageShards(username: string): ShardTable[] {
    //M 计算表名并做严格白名单校验，防止任何动态表名注入。
    const tableName = getMessageTableName(username);
    if (!SAFE_MSG_TABLE_RE.test(tableName)) return [];

    const shards: ShardTable[] = [];
    for (const relKey of this.msgDbKeys) {
      //M 刷新或复用该消息分片的明文副本。
      const replicaPath = this.cache.getDecryptedPath(relKey);
      if (replicaPath === undefined) {
        continue;
      }
      const sourceName = path.posix.basename(relKey);
      try {
        //M 检查分片内是否存在这张会话表，并顺带读取最大时间排序。
        const hit = withReadonlyDb(replicaPath, (conn): ShardTable | undefined => {
          const exists = conn
            .query<{ ok: number }, [string]>("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(tableName);
          if (exists === null) return undefined;

          const maxRow = conn
            .query<{ max_ct: number | null }, []>(`SELECT MAX(create_time) AS max_ct FROM [${tableName}]`)
            .get();
          return {
            replicaPath,
            sourceName,
            tableName,
            maxCreateTime: maxRow?.max_ct ?? 0,
          };
        });
        if (hit !== undefined) {
          //M 记下包含目标消息表的有效分片。
          shards.push(hit);
        }
      } catch {
        // 坏分片在具体扫描阶段再记入 failures，此处不中断其它分片发现。
      }
    }

    shards.sort((left, right) => right.maxCreateTime - left.maxCreateTime);
    return shards;
  }

  /**
   * 执行跨分片消息读取、Zstd 解压、发送者映射、@ 判定与气泡视图构建（sync 与 backfill 共用）。
   */
  private collectChatMessages(
    chatQuery: string,
    names: ReadonlyMap<string, string>,
    selfWxid: string,
    atNames: readonly string[],
    range:
      | { mode: 'sync'; sinceTime: number | null; limit: number }
      | { mode: 'backfill'; untilTime: number; limit: number },
  ): ChatSyncResult {
    //M 先把聊天标识解析成标准 username，找不到时标记 missing: true。
    const username = this.resolveChatUsername(chatQuery, names);
    if (username === undefined) {
      return { chat: chatQuery, missing: true };
    }

    const displayName = names.get(username) ?? username;
    const isGroup = username.includes('@chatroom');
    //M 找出所有含该会话消息表的分片库。
    const shards = this.findMessageShards(username);
    if (shards.length === 0) {
      return {
        chat: chatQuery,
        username,
        chat_display: displayName,
        missing: false,
        is_group: isGroup,
        messages: [],
        failures: null,
        more: false,
      };
    }

    const lookupDisplayName = (wxid: string): string | undefined => {
      if (wxid === '') return undefined;
      if (selfWxid !== '' && wxid === selfWxid) return 'me';
      return names.get(wxid);
    };

    const collected: SyncedMessage[] = [];
    const failures: string[] = [];
    let more = false;

    //==========================================================
    //M 逐个消息分片读取原始行，解压正文与 msgsource 并构建结构化气泡
    //==========================================================
    for (const shard of shards) {
      try {
        //M 在单分片只读连接内取回本批候选行与 Name2Id 映射。
        const shardData = withReadonlyDb(shard.replicaPath, (conn) => {
          const idMap = loadName2IdMap(conn);
          const colFlags = inspectMsgColumns(conn, shard.tableName);
          const selectCols = buildSelectColumns(colFlags);
          let rows: RawMsgRow[] = [];
          let shardMore = false;

          if (range.mode === 'sync' && range.sinceTime === null) {
            //M 首次同步取最新 limit 条后翻回时间升序。
            const sql = `SELECT ${selectCols} FROM [${shard.tableName}]`
              + ' ORDER BY create_time DESC, local_id DESC LIMIT ?';
            rows = conn.query<RawMsgRow, [number]>(sql).all(range.limit).reverse();
          }
          if (range.mode === 'sync' && range.sinceTime !== null) {
            //M 增量同步从 sinceTime 起多取 1 条以判断是否有剩余。
            const sql = `SELECT ${selectCols} FROM [${shard.tableName}]`
              + ' WHERE create_time >= ? ORDER BY create_time ASC, local_id ASC LIMIT ?';
            const fetched = conn.query<RawMsgRow, [number, number]>(sql).all(range.sinceTime, range.limit + 1);
            if (fetched.length > range.limit) {
              shardMore = true;
              rows = fetched.slice(0, range.limit);
            }
            if (fetched.length <= range.limit) {
              rows = fetched;
            }
          }
          if (range.mode === 'backfill') {
            //M 历史补录按严格上界向前倒序多取 1 条后再翻回时间正序。
            const sql = `SELECT ${selectCols} FROM [${shard.tableName}]`
              + ' WHERE create_time < ? ORDER BY create_time DESC, local_id DESC LIMIT ?';
            const fetched = conn.query<RawMsgRow, [number, number]>(sql).all(range.untilTime, range.limit + 1);
            if (fetched.length > range.limit) {
              shardMore = true;
              rows = fetched.slice(0, range.limit);
            }
            if (fetched.length <= range.limit) {
              rows = fetched;
            }
            rows.reverse();
          }
          return { idMap, colFlags, rows, shardMore };
        });

        if (shardData.shardMore) {
          more = true;
        }

        for (const row of shardData.rows) {
          try {
            //M 解压正文和可选 msgsource XML，拆分群发送者并构建气泡视图。
            const content = decompressContent(row.message_content, row.wcdb_ct_content);
            const { senderPrefix, bodyText } = splitGroupContent(content, isGroup);
            let senderUsername = '';
            if (row.real_sender_id !== null) {
              senderUsername = shardData.idMap.get(row.real_sender_id) ?? '';
            }

            let senderLabel = '';
            if (isGroup) {
              //M 群聊按发言人映射计算气泡发送者显示名。
              senderLabel = this.resolveGroupSenderLabel(
                senderUsername,
                senderPrefix,
                username,
                names,
                selfWxid,
              );
            }

            let sourceXml: string | undefined;
            if (shardData.colFlags.hasSource) {
              //M 解压 msgsource 列供精确 @ 判定使用。
              sourceXml = decompressContent(row.msg_source, row.wcdb_ct_source);
            }

            //M 计算群提及标志、结构化气泡视图与收发方向。
            const mentions = viewModule.getMentionFlags(
              isGroup,
              row.local_type,
              bodyText,
              sourceXml,
              selfWxid,
              atNames,
            );
            const view = viewModule.buildMessageView(
              row.local_type,
              bodyText,
              senderLabel,
              row.packed_info_data,
              lookupDisplayName,
            );
            const { baseType } = viewModule.splitMessageType(row.local_type);
            const fromSelf = resolveFromSelf(senderUsername, username, isGroup, selfWxid);

            //M 将组装完成的单条结构化消息加入合并列表。
            collected.push({
              source: shard.sourceName,
              local_id: row.local_id,
              local_type: baseType,
              create_time: row.create_time,
              from_self: fromSelf,
              at_me: mentions.atMe,
              at_all: mentions.atAll,
              at_source: mentions.atSource,
              view,
            });
          } catch (error) {
            //G 单条消息解析异常只记入诊断数组，不丢弃同批其余消息。
            const detail = getErrorDetail(error);
            failures.push(`local_id=${String(row.local_id)}: ${detail}`);
          }
        }
      } catch (error) {
        //G 单分片打开或查询异常只记入诊断数组，继续扫描其余分片。
        const detail = getErrorDetail(error);
        failures.push(`${shard.sourceName}: ${detail}`);
      }
    }

    //==========================================================
    //M 合并全部分片记录按 (create_time, source, local_id) 升序排列并裁剪窗口
    //==========================================================
    collected.sort((left, right) => {
      if (left.create_time !== right.create_time) return left.create_time - right.create_time;
      if (left.source !== right.source) return left.source.localeCompare(right.source);
      return left.local_id - right.local_id;
    });

    let finalMessages = collected;
    if (range.mode === 'sync' && range.sinceTime === null && collected.length > range.limit) {
      finalMessages = collected.slice(-range.limit);
    }
    if (range.mode === 'backfill' && collected.length > range.limit) {
      more = true;
      finalMessages = collected.slice(-range.limit);
    }

    let finalFailures: string[] | null = null;
    if (failures.length > 0) {
      finalFailures = failures;
    }

    return {
      chat: chatQuery,
      username,
      chat_display: displayName,
      missing: false,
      is_group: isGroup,
      messages: finalMessages,
      failures: finalFailures,
      more,
    };
  }

  /**
   * 解析群聊发言人的显示名称（对齐 messages.py:_resolve_sender_label）。
   */
  private resolveGroupSenderLabel(
    senderUsername: string,
    senderFromContent: string,
    chatUsername: string,
    names: ReadonlyMap<string, string>,
    selfWxid: string,
  ): string {
    if (senderUsername !== '' && senderUsername !== chatUsername) {
      if (selfWxid !== '' && senderUsername === selfWxid) return 'me';
      return names.get(senderUsername) ?? senderUsername;
    }
    if (senderFromContent !== '') {
      if (selfWxid !== '' && senderFromContent === selfWxid) return 'me';
      return names.get(senderFromContent) ?? senderFromContent;
    }
    return '';
  }
}

type DbCacheType = cacheModule.DbCache;
