/**
 * 外置微信 100% 纯 Bun 只读引擎门面：
 * 直接组合 P1（Crypto / DbCache / MsgView / WechatDb）与 P2（MediaDat / VoiceExtract / KeyScan），
 * 零 Python 解释器、零外部脚本、零临时请求文件；日常轮询零 FFI 调用，仅显式 `--connect` 时按需提密。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import * as cacheModule from './DbCache.ts';
import * as keyScanModule from './KeyScan.ts';
import * as mediaDatModule from './MediaDat.ts';
import * as viewModule from './MsgView.ts';
import * as voiceExtractModule from './VoiceExtract.ts';
import * as wechatDbModule from './WechatDb.ts';


/** 已连接微信账号的展示摘要。 */
export interface Account {
  /** 稳定账号标识（如 `account_a1b2c3d4e5f6`）。 */
  id: string;
  /** 账号昵称（未知时为空串）。 */
  nickname: string;
  /** 账号原始 wxid（未知时为空串）。 */
  wxid: string;
}

/** 最近会话条目结构。 */
export interface ChatItem {
  /** 会话原始 username。 */
  username: string;
  /** 会话显示名。 */
  chat: string;
  /** 是否为群聊。 */
  is_group: boolean;
  /** 未读条数。 */
  unread: number;
  /** 最新消息摘要。 */
  last_message: string;
  /** 最新消息秒级时间戳。 */
  timestamp: number;
}

/** 单条消息结构（对齐 WechatDb 与客服库）。 */
export interface RawMessage {
  /** 消息所在分片文件名（如 `message_0.db`）。 */
  source: string;
  /** 分片内消息本地编号。 */
  local_id: number;
  /** 归一化后的基础消息类型号。 */
  local_type: number;
  /** 消息秒级 Unix 时间戳。 */
  create_time: number;
  /** 是否为本账号发出。 */
  from_self: boolean | null;
  /** 群聊中是否提及了本账号。 */
  at_me: boolean;
  /** 结构化气泡视图。 */
  view?: {
    kind?: string;
    text?: string;
    sender?: string;
    title?: string;
    desc?: string;
    seconds?: number;
    amount?: string;
    quote?: { name?: string; text?: string };
  };
}

/** 单个会话同步或补录的返回结构。 */
export interface SyncResult {
  /** 请求的会话标识。 */
  chat: string;
  /** 会话在联系人与消息分片中均不存在时为 true。 */
  missing: boolean;
  /** 单会话读取失败时的脱敏错误原因。 */
  error?: string;
  /** 是否为群聊。 */
  is_group?: boolean;
  /** 解析出的会话显示名称。 */
  chat_display?: string;
  /** 升序排列的消息列表。 */
  messages?: RawMessage[];
}

/** 语音提取请求四元组（须同时核对账号、会话、分片和本地消息号）。 */
export interface VoiceMessage {
  /** 微信账号编号。 */
  account: string;
  /** 会话原始 username。 */
  chat: string;
  /** 消息所在分片文件名。 */
  source: string;
  /** 分片内消息编号。 */
  localId: number;
}

/** 已解密落盘并可供客服页直接发送的图片文件信息。 */
export interface ImageFile {
  /** 本地缓存图片路径。 */
  file: string;
  /** 图片 MIME 类型。 */
  mime: string;
}

type MediaKind = 'image' | 'voice';

/** 媒体读取失败的冷却窗口（30 秒），毫秒。 */
const MEDIA_RETRY_MS = 30_000;

/** 内存最多缓存的媒体失败条目上限。 */
const MEDIA_FAILURE_LIMIT = 512;

/** `accounts.yaml` 里持久化的单条账号记录。 */
interface StoredAccountRecord {
  id: string;
  folder?: string;
  nickname?: string;
  wxid?: string;
  status?: string;
  db_dir?: string;
  verifiedKeys?: number;
  error?: string;
}

/** 单个已连接账号在进程内复用的解密缓存与读取实例。 */
interface AccountRuntimeContext {
  accountId: string;
  dbDir: string;
  stateAccountDir: string;
  keysMtimeMs: number;
  allKeys: cacheModule.KeyTable;
  cache: cacheModule.DbCache;
  wechatDb: wechatDbModule.WechatDb;
  wxid: string;
  folder: string;
  nickname: string;
}


/** 可直接回给客服页的脱敏媒体不可用异常。 */
export class MediaUnavailable extends Error {
  /**
   * @param message 页面展示原因。
   * @param code 固定错误分类码。
   * @param exitCode 兼容保留的可选退出码字段。
   */
  constructor(message: string, readonly code = 'unavailable', readonly exitCode?: number) {
    super(message);
  }
}

/** 语音提取或解码不可用异常。 */
export class VoiceUnavailable extends MediaUnavailable {}


/**
 * 合并同一媒体的并发读取并在失败后短暂复用错误，避免轮询连打损坏附件。
 */
export class MediaAttempts<T> {
  private readonly pending = new Map<string, Promise<T>>();
  private readonly failures = new Map<string, {
    readonly error: unknown;
    readonly retryAt: number;
  }>();

  constructor(private readonly kind: MediaKind) {}

  /**
   * 命中进行中的请求或尚未过冷却期的失败结果时直接返回。
   * @param key 媒体唯一键。
   */
  getCached(key: string): Promise<T> | undefined {
    //M 优先复用尚未完成的同一读取任务。
    const active = this.pending.get(key);
    if (active !== undefined) return active;

    //M 检查短期失败冷却窗口是否仍在生效。
    const failure = this.failures.get(key);
    if (failure === undefined) return undefined;
    if (failure.retryAt > Date.now()) return Promise.reject(failure.error);

    this.failures.delete(key);
    return undefined;
  }

  /**
   * 跟踪一次新的媒体读取尝试，失败时只记录固定分类码并在短期内冷却。
   * @param key 媒体唯一键。
   * @param attempt 实际读取 Promise。
   */
  async track(key: string, attempt: Promise<T>): Promise<T> {
    this.pending.set(key, attempt);
    try {
      return await attempt;
    } catch (error) {
      let detail = 'unavailable';
      if (error instanceof MediaUnavailable) {
        detail = error.code;
      }
      console.error(`微信媒体读取失败（${this.kind}）：${detail}`);

      if (this.failures.size >= MEDIA_FAILURE_LIMIT) {
        const oldest = this.failures.keys().next().value;
        if (oldest !== undefined) {
          this.failures.delete(oldest);
        }
      }
      this.failures.set(key, { error, retryAt: Date.now() + MEDIA_RETRY_MS });
      throw error;
    } finally {
      this.pending.delete(key);
    }
  }
}


/**
 * 从微信账号目录名（如 `wxid_xxx_1a2b`）推断去除随机后缀后的原始 wxid。
 * @param folder 账号目录名。
 */
function inferWxidFromFolder(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed === '') return '';

  const match = /^(.+)_([0-9a-fA-F]{4,})$/u.exec(trimmed);
  if (match !== null && match[1] !== undefined) return match[1];

  return trimmed;
}


/**
 * 从 `packed_info_data` 二进制块中补充扫描可能出现的 32 位十六进制图片 MD5 字符串。
 * @param packed 可选二进制附属字段。
 */
function extractPackedMd5s(packed: Uint8Array | null): string[] {
  if (packed === null || packed.byteLength < 32) return [];

  const text = Buffer.from(packed).toString('latin1');
  const found: string[] = [];
  const re = /[0-9a-fA-F]{32}/gu;
  let match = re.exec(text);
  while (match !== null) {
    const hex = match[0].toLowerCase();
    if (!found.includes(hex)) {
      //M 收入去重后的 32 位十六进制候选串。
      found.push(hex);
    }
    match = re.exec(text);
  }
  return found;
}


/**
 * 将图片 `.dat` 解密错误码映射为客服页既有脱敏异常。
 * @param code MediaDat 返回的分类码。
 */
function mapImageError(code: mediaDatModule.ImageDatErrorCode): MediaUnavailable {
  if (code === 'need_image_key') {
    //G 缺少 V2 账号密钥时给出明确提示。
    return new MediaUnavailable('取不到图片：缺少微信图片解密密钥', 'need_image_key');
  }
  if (code === 'decrypt_failed') {
    //G 密文或填充损坏时返回解密失败。
    return new MediaUnavailable('取不到图片：图片解密失败', 'decrypt_failed');
  }
  //G 其余情况统一按原图片未保存返回。
  return new MediaUnavailable('取不到图片：微信未保存这张图片', 'not_found');
}


/**
 * 纯 Bun 微信只读读取器（兼容原 `Reader` 全部公开方法签名，彻底无 Python 依赖）。
 */
export class Reader {
  //M 初始化图片读取并发去重与短期失败节流池。
  private readonly images = new MediaAttempts<ImageFile>('image');
  private readonly contexts = new Map<string, AccountRuntimeContext>();
  readonly root: string;
  private readonly legacyEngineRoot: string;
  private readonly extraAtNames: string[];

  /**
   * 兼容两参数 `(dataDir, atNames)` 与旧三参数 `(engineRoot, _unusedPython, atNames)` 构造签名。
   * @param root 外置插件数据目录（或旧版引擎根目录）。
   * @param secondArg 两参数模式下为逗号分隔 `atNames`，三参数模式下忽略旧 python 路径。
   * @param thirdArg 三参数模式下的 `atNames`；传入时 `fourthLegacy` 由 `root` 充当兼容目录。
   * @param legacyEngineDir 显式指定的兼容旧引擎目录（可选）。
   */
  constructor(
    root: string,
    secondArg = '',
    thirdArg?: string,
    legacyEngineDir?: string,
  ) {
    this.root = root;
    let rawAtNames = secondArg;
    if (thirdArg !== undefined) {
      rawAtNames = thirdArg;
    }
    this.legacyEngineRoot = legacyEngineDir ?? root;
    this.extraAtNames = rawAtNames
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }

  /**
   * 定位存放 `accounts.yaml` 与账号密钥子目录的状态根目录（优先 `<data>`，兼容 `<engine>/runtime/data`）。
   */
  private resolveStateDir(): string | undefined {
    if (this.root === '') return undefined;

    const candidates = [
      this.root,
      path.join(this.root, 'runtime', 'data'),
      path.join(this.legacyEngineRoot, 'runtime', 'data'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'accounts.yaml'))) {
        return candidate;
      }
    }
    return this.root;
  }

  /**
   * 读取 `accounts.yaml` 中的原始账号清单。
   */
  private loadAccountRecords(): { stateDir: string; list: StoredAccountRecord[] } {
    const stateDir = this.resolveStateDir();
    if (stateDir === undefined) {
      return { stateDir: '', list: [] };
    }
    const file = path.join(stateDir, 'accounts.yaml');
    if (!fs.existsSync(file)) {
      return { stateDir, list: [] };
    }
    try {
      const parsed = yaml.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) {
        return { stateDir, list: [] };
      }
      const records: StoredAccountRecord[] = [];
      for (const raw of parsed) {
        if (typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>)['id'] === 'string') {
          //M 收录结构合法的账号配置项。
          records.push(raw as StoredAccountRecord);
        }
      }
      return { stateDir, list: records };
    } catch {
      return { stateDir, list: [] };
    }
  }

  /**
   * 返回当前所有状态为 `connected` 的微信账号列表。
   */
  accounts(): Account[] {
    const { list } = this.loadAccountRecords();
    return list
      .filter((item) => item.status === 'connected')
      .map((item) => {
        const folder = String(item.folder ?? '');
        let wxid = String(item.wxid ?? '');
        if (wxid === '' && folder !== '') {
          //M 未显式记录 wxid 时按账号文件夹名自动推断。
          wxid = inferWxidFromFolder(folder);
        }
        return {
          id: String(item.id),
          nickname: String(item.nickname ?? ''),
          wxid,
        };
      });
  }

  /**
   * 获取或刷新指定已连接账号的 `DbCache` 与 `WechatDb` 运行时上下文。
   * @param accountId 账号标识。
   */
  private getAccountContext(accountId: string): AccountRuntimeContext {
    const { stateDir, list } = this.loadAccountRecords();
    //M 查找匹配编号且状态为 connected 的账号记录。
    const record = list.find((item) => item.id === accountId && item.status === 'connected');
    if (record === undefined || stateDir === '') {
      throw new Error('微信账号尚未连接');
    }

    const stateAccountDir = path.join(stateDir, accountId);
    let dbDir = '';
    if (typeof record.db_dir === 'string') {
      dbDir = record.db_dir;
    }
    const configPath = path.join(stateAccountDir, 'config.json');
    if (dbDir === '' && fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { db_dir?: unknown };
        if (typeof cfg.db_dir === 'string') {
          dbDir = cfg.db_dir;
        }
      } catch {
        dbDir = '';
      }
    }
    if (dbDir === '' || !fs.existsSync(dbDir)) {
      throw new Error('找不到微信账号数据库目录');
    }

    const keysPath = path.join(stateAccountDir, 'all_keys.json');
    const keysStat = fs.statSync(keysPath, { throwIfNoEntry: false });
    if (!keysStat?.isFile()) {
      throw new Error('缺少微信数据库解密密钥，请先执行账号连接');
    }

    //M 密钥文件与数据库目录均未变化时直接复用已有缓存实例。
    const existing = this.contexts.get(accountId);
    if (existing !== undefined && existing.dbDir === dbDir && existing.keysMtimeMs === keysStat.mtimeMs) {
      return existing;
    }

    let allKeys: cacheModule.KeyTable;
    try {
      const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('invalid keys');
      }
      allKeys = parsed as cacheModule.KeyTable;
    } catch {
      throw new Error('微信数据库密钥文件损坏');
    }

    const folder = String(record.folder ?? path.basename(path.dirname(path.resolve(dbDir))));
    let wxid = String(record.wxid ?? '');
    if (wxid === '') {
      //M 补齐目录推断的账号 wxid 供收发方向与图片派生使用。
      wxid = inferWxidFromFolder(folder);
    }
    const nickname = String(record.nickname ?? '');
    const cacheRoot = path.join(this.root, 'db_cache', accountId);
    const mergedAtNames = [...this.extraAtNames];
    if (nickname !== '' && !mergedAtNames.includes(nickname)) {
      //M 将本账号昵称一并纳入群聊文本 @ 识别词表。
      mergedAtNames.push(nickname);
    }
    const wechatDb = new wechatDbModule.WechatDb({
      dbDir,
      allKeys,
      cacheRoot,
      selfWxid: wxid,
      atNames: mergedAtNames,
    });

    const context: AccountRuntimeContext = {
      accountId,
      dbDir,
      stateAccountDir,
      keysMtimeMs: keysStat.mtimeMs,
      allKeys,
      cache: wechatDb.cache,
      wechatDb,
      wxid,
      folder,
      nickname,
    };
    this.contexts.set(accountId, context);
    return context;
  }

  /**
   * 纯 Bun 读取指定账号最近活跃会话列表。
   * @param account 账号标识。
   * @param limit 最大返回条数。
   */
  async sessions(account: string, limit: number): Promise<ChatItem[]> {
    //M 获取账号增量缓存上下文并直接查询 session.db。
    const ctx = this.getAccountContext(account);
    return ctx.wechatDb.sessions(limit);
  }

  /**
   * 纯 Bun 批量同步同一账号下的多个会话（首次 `since === null` 取最近 50 条存量，后续增量最多 500 条）。
   * @param account 账号标识。
   * @param chats 待同步会话与增量时间戳列表。
   */
  async syncBatch(account: string, chats: { chat: string; since: number | null }[]): Promise<SyncResult[]> {
    //M 直接在进程内经 WechatDb 批量扫描分片消息，免写任何临时请求文件。
    const ctx = this.getAccountContext(account);
    return ctx.wechatDb.syncBatch(chats, 50, 500);
  }

  /**
   * 纯 Bun 向前分页补录指定会话在 `until` 秒之前的历史消息。
   * @param account 账号标识。
   * @param chat 会话标识。
   * @param until 严格时间上界（Unix 秒）。
   * @param limit 本批最大条数。
   */
  async backfill(account: string, chat: string, until: number, limit: number): Promise<SyncResult> {
    //M 直接调用 WechatDb.backfill 读取早期分片记录。
    const ctx = this.getAccountContext(account);
    return ctx.wechatDb.backfill(chat, until, limit);
  }

  /**
   * 按指定条数上限读取单个会话最近 `limit` 条完整消息（超过单页 5000 条时自动向前循环 backfill 拼接）。
   * @param account 微信账号标识。
   * @param chatQuery 会话原始 username 或唯一备注/群名。
   * @param limit 需要导出的最近消息条数上限。
   * @returns 命中会话时返回元信息与时间升序消息列表；该账号下不存在此会话时返回 undefined。
   */
  async readChatHistory(
    account: string,
    chatQuery: string,
    limit: number,
  ): Promise<{ username: string; displayName: string; isGroup: boolean; messages: RawMessage[] } | undefined> {
    const ctx = this.getAccountContext(account);
    const pageCap = 5000;
    const firstBatchSize = Math.min(limit, pageCap);
    //M 先拉取最新一批消息并解析标准会话 username。
    const first = ctx.wechatDb.syncChat(chatQuery, null, firstBatchSize);
    if (first.missing) return undefined;

    if (first.error !== undefined) {
      throw new Error('读取微信会话记录失败');
    }

    const username = first.username ?? chatQuery;
    const displayName = first.chat_display ?? username;
    const isGroup = first.is_group === true;
    const initialRows = first.messages ?? [];
    if (initialRows.length >= limit || initialRows.length < pageCap) {
      return {
        username,
        displayName,
        isGroup,
        messages: initialRows.slice(-limit),
      };
    }

    //M 需要超过 5000 条长历史时，按最早秒级时间戳继续向前分页去重拼接。
    const byKey = new Map<string, RawMessage>();
    let oldestTime = Number.MAX_SAFE_INTEGER;
    for (const msg of initialRows) {
      const msgKey = `${msg.source}:${String(msg.local_id)}`;
      byKey.set(msgKey, msg);
      oldestTime = Math.min(oldestTime, msg.create_time);
    }

    while (byKey.size < limit && oldestTime > 0) {
      const untilTime = oldestTime + 1;
      //M 向前拉取更早一批记录。
      const older = ctx.wechatDb.backfill(username, untilTime, pageCap);
      if (older.missing || older.error !== undefined) {
        break;
      }
      const batch = older.messages ?? [];
      if (batch.length === 0) {
        break;
      }

      let nextOldest = oldestTime;
      let addedCount = 0;
      for (const msg of batch) {
        const msgKey = `${msg.source}:${String(msg.local_id)}`;
        if (!byKey.has(msgKey)) {
          byKey.set(msgKey, msg);
          addedCount += 1;
        }
        nextOldest = Math.min(nextOldest, msg.create_time);
      }
      if (batch.length < pageCap || addedCount === 0 || nextOldest >= oldestTime) {
        break;
      }
      oldestTime = nextOldest;
    }

    const merged = [...byKey.values()];
    merged.sort((left, right) => {
      if (left.create_time !== right.create_time) return left.create_time - right.create_time;
      if (left.source !== right.source) return left.source.localeCompare(right.source);
      return left.local_id - right.local_id;
    });
    return {
      username,
      displayName,
      isGroup,
      messages: merged.slice(-limit),
    };
  }

  /**
   * 在当前微信账号的 `msg/file` 附件目录内安全查找已下载的本地文件原件（严格拦截路径穿越与外部软链接）。
   * @param account 微信账号标识。
   * @param rawTitle 消息气泡中的文件标题。
   * @param createTime 消息秒级时间戳。
   */
  findSafeFileAttachment(account: string, rawTitle: string, createTime: number): string | undefined {
    const trimmed = rawTitle.trim();
    if (trimmed === '' || trimmed.includes('\0')) return undefined;
    //G 标题自身若含路径分隔符或 .. 穿越片段，直接拒绝定位磁盘文件。
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return undefined;
    }
    if (trimmed.includes('..')) return undefined;

    const ctx = this.getAccountContext(account);
    let wechatAccountRoot = ctx.dbDir;
    if (path.basename(ctx.dbDir) === 'db_storage') {
      wechatAccountRoot = path.dirname(ctx.dbDir);
    }
    const fileRoot = path.join(wechatAccountRoot, 'msg', 'file');
    if (!fs.existsSync(fileRoot)) return undefined;

    let realRoot: string;
    try {
      realRoot = fs.realpathSync(fileRoot);
    } catch {
      return undefined;
    }

    const candidateDirs: string[] = [];
    if (createTime > 0) {
      const dt = new Date(createTime * 1000);
      const yyyy = String(dt.getFullYear());
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      //M 优先查找消息发出当月的附件归档夹。
      candidateDirs.push(path.join(realRoot, `${yyyy}-${mm}`));
    }
    //M 同时允许直接在 msg/file 根与其余月份子目录查找。
    candidateDirs.push(realRoot);
    try {
      const entries = fs.readdirSync(realRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && /^\d{4}-\d{2}$/u.test(entry.name)) {
          const monthDir = path.join(realRoot, entry.name);
          if (!candidateDirs.includes(monthDir)) {
            //M 纳入其它月份归档目录以兼容跨月延迟下载。
            candidateDirs.push(monthDir);
          }
        }
      }
    } catch {
      return undefined;
    }

    const maxFileBytes = 100 * 1024 * 1024;
    for (const dir of candidateDirs) {
      const candidate = path.join(dir, trimmed);
      const stat = fs.statSync(candidate, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size <= 0 || stat.size > maxFileBytes) {
        continue;
      }
      try {
        //G 用 realpathSync 确认目标文件未通过符号链接或目录联接跳出 msg/file 根目录。
        const realTarget = fs.realpathSync(candidate);
        const rel = path.relative(realRoot, realTarget);
        const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (inside) return realTarget;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * 纯 Bun 解密并缓存单条图片消息的缩略图（或原图）。
   * @param account 微信账号标识。
   * @param chat 会话原始 username。
   * @param source 消息分片库名。
   * @param localId 分片内消息本地编号。
   */
  image(account: string, chat: string, source: string, localId: number): Promise<ImageFile> {
    const key = JSON.stringify([account, chat, source, localId]);
    //M 合并并发请求与短期失败冷却。
    const known = this.images.getCached(key);
    if (known !== undefined) return known;

    const attempt = this.loadImagePure(account, chat, source, localId);
    //M 登记图片读取任务并维护失败冷却。
    return this.images.track(key, attempt);
  }

  /**
   * 执行纯 Bun 图片定位、`.dat` 解密与缩略图缓存写入。
   */
  private async loadImagePure(
    account: string,
    chat: string,
    source: string,
    localId: number,
  ): Promise<ImageFile> {
    const ctx = this.getAccountContext(account);
    const safeSource = source.replace(/[^\w-]/gu, '_');
    const cacheFile = path.join(ctx.stateAccountDir, 'media', 'jmbots', `${safeSource}_${String(localId)}.img`);
    const metaFile = `${cacheFile}.mime`;
    if (fs.existsSync(cacheFile) && fs.existsSync(metaFile)) {
      return { file: cacheFile, mime: fs.readFileSync(metaFile, 'utf8').trim() || 'image/jpeg' };
    }

    //M 先从对应消息分片取回该条图片消息的原始 XML 与创建时间。
    const rawMsg = ctx.wechatDb.readMessageRaw(chat, source, localId);
    if (rawMsg === undefined) {
      throw new MediaUnavailable('取不到图片：微信未保存这张图片', 'not_found');
    }

    //M 汇总 XML 与附属二进制块里的候选图片 MD5。
    const md5s = viewModule.extractImageMd5s(rawMsg.bodyText);
    for (const extraMd5 of extractPackedMd5s(rawMsg.packedInfo)) {
      if (!md5s.includes(extraMd5)) {
        md5s.push(extraMd5);
      }
    }
    if (md5s.length === 0) {
      //G 消息内容不含任何图片 MD5 时直接报告未保存。
      throw new MediaUnavailable('取不到图片：微信未保存这张图片', 'not_found');
    }

    //M 仅在本会话自己的 attach 哈希目录内定位 .dat 文件。
    const datPath = mediaDatModule.findImageDatPath(ctx.dbDir, chat, rawMsg.createTime, md5s, true);
    if (datPath === undefined) {
      throw new MediaUnavailable('取不到图片：微信未保存这张图片', 'not_found');
    }

    let wechatAccountRoot = ctx.dbDir;
    if (path.basename(ctx.dbDir) === 'db_storage') {
      wechatAccountRoot = path.dirname(ctx.dbDir);
    }
    const keyFilePath = path.join(ctx.stateAccountDir, 'media', 'image_key.json');
    const accountName = ctx.wxid || ctx.folder;

    //M 纯 Bun 解密 3.x XOR 或 4.x V1/V2 .dat 图片并持久化已验真的图片密钥。
    const outcome = mediaDatModule.decryptImageDatFile(datPath, {
      keyFilePath,
      accountName,
      searchRoots: [wechatAccountRoot],
    });
    if (!outcome.ok) {
      throw mapImageError(outcome.code);
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tempFile = `${cacheFile}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tempFile, outcome.image.data, { mode: 0o600 });
    fs.renameSync(tempFile, cacheFile);
    fs.writeFileSync(metaFile, outcome.image.mime, { encoding: 'utf8', mode: 0o600 });
    return { file: cacheFile, mime: outcome.image.mime };
  }

  /**
   * 纯 Bun 从加密媒体分片库直接提取归一化 SILK 语音流（零临时 `.silk` 文件落盘）。
   * @param message 待提取语音的四元组定位信息。
   */
  async voice(message: VoiceMessage): Promise<Buffer> {
    const ctx = this.getAccountContext(message.account);
    //G 先在指定消息分片内复核 `(chat, source, localId)` 确实存在，杜绝伪造分片串读。
    const rawMsg = ctx.wechatDb.readMessageRaw(message.chat, message.source, message.localId);
    if (rawMsg === undefined) {
      throw new VoiceUnavailable('微信未保存原音频', 'not_found');
    }

    try {
      //M 直接经 DbCache + bun:sqlite 从 media_N.db / biz_media_N.db 提取 SILK 字节。
      const extracted = voiceExtractModule.extractVoiceSilk(
        ctx.cache,
        ctx.allKeys,
        message.chat,
        message.localId,
      );
      return extracted.silk;
    } catch (error) {
      if (error instanceof voiceExtractModule.VoiceExtractError) {
        throw new VoiceUnavailable(error.message, error.code);
      }
      //G 兜底转换未知异常为脱敏语音错误。
      throw new VoiceUnavailable('读取微信语音失败', 'unavailable');
    }
  }
}


/**
 * 纯 Bun 枚举指定目录下的微信账号并将清单写入 `<dataDir>/accounts.yaml`（不触碰进程内存、不打印私密路径）。
 * @param dataDir 外置插件数据目录。
 * @param wechatFolder 用户指定的微信存储目录。
 */
export function discoverAccountsToData(
  dataDir: string,
  wechatFolder: string,
): Array<{ id: string; folder: string; wxid: string; nickname: string; status: string }> {
  //M 只在指定根目录下枚举包含 db_storage 的微信账号文件夹。
  const discovered = keyScanModule.discoverAccountDbDirs(wechatFolder);
  if (discovered.length === 0) {
    throw new Error('指定目录未找到微信账号数据库（db_storage）');
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const accountsFile = path.join(dataDir, 'accounts.yaml');
  const existingMap = new Map<string, StoredAccountRecord>();
  if (fs.existsSync(accountsFile)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(accountsFile, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const isObj = typeof item === 'object' && item !== null;
          if (isObj && typeof (item as Record<string, unknown>)['id'] === 'string') {
            const rec = item as StoredAccountRecord;
            existingMap.set(rec.id, rec);
          }
        }
      }
    } catch {
      existingMap.clear();
    }
  }

  const merged: StoredAccountRecord[] = [];
  const summary: Array<{ id: string; folder: string; wxid: string; nickname: string; status: string }> = [];
  for (const item of discovered) {
    const prev = existingMap.get(item.id);
    const wxid = prev?.wxid || inferWxidFromFolder(item.folder);
    const nickname = prev?.nickname ?? '';
    const status = prev?.status ?? 'discovered';
    const accountStateDir = path.join(dataDir, item.id);
    fs.mkdirSync(accountStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(accountStateDir, 'config.json'),
      JSON.stringify({ db_dir: item.dbDir }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );

    //M 合并已有备注昵称与连接状态。
    merged.push({ id: item.id, folder: item.folder, wxid, nickname, status });
    summary.push({ id: item.id, folder: item.folder, wxid, nickname, status });
  }

  fs.writeFileSync(accountsFile, yaml.stringify(merged), { encoding: 'utf8', mode: 0o600 });
  return summary;
}


/**
 * 显式按需触发（`--connect`）：调用 `KeyScan.scanWindowsWechatKeys` 提取微信数据库密钥并更新 `<dataDir>/accounts.yaml`。
 * 仅在用户执行一次性初始化或换号重连命令时运行，日常轮询绝不调用。
 * @param dataDir 外置插件数据目录。
 * @param wechatFolder 用户指定的微信存储目录。
 * @param targetPid 可选指定的单个 Weixin.exe 进程 PID。
 */
export function connectAccountsToData(
  dataDir: string,
  wechatFolder: string,
  targetPid?: number,
): Array<{
  id: string;
  folder: string;
  wxid: string;
  nickname: string;
  status: string;
  verifiedDbs: number;
  error?: string;
}> {
  //M 先发现账号目录并初始化状态文件。
  const discovered = keyScanModule.discoverAccountDbDirs(wechatFolder);
  if (discovered.length === 0) {
    throw new Error('指定目录未找到微信账号数据库（db_storage）');
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const accountsFile = path.join(dataDir, 'accounts.yaml');
  const existingMap = new Map<string, StoredAccountRecord>();
  if (fs.existsSync(accountsFile)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(accountsFile, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const isObj = typeof item === 'object' && item !== null;
          if (isObj && typeof (item as Record<string, unknown>)['id'] === 'string') {
            const rec = item as StoredAccountRecord;
            existingMap.set(rec.id, rec);
          }
        }
      }
    } catch {
      existingMap.clear();
    }
  }

  const persisted: StoredAccountRecord[] = [];
  const report: Array<{
    id: string;
    folder: string;
    wxid: string;
    nickname: string;
    status: string;
    verifiedDbs: number;
    error?: string;
  }> = [];

  for (const item of discovered) {
    const prev = existingMap.get(item.id);
    const wxid = prev?.wxid || inferWxidFromFolder(item.folder);
    let nickname = prev?.nickname ?? '';
    const accountStateDir = path.join(dataDir, item.id);
    fs.mkdirSync(accountStateDir, { recursive: true });
    const keysPath = path.join(accountStateDir, 'all_keys.json');

    try {
      //M 按需惰性调用 Win32 FFI 只读扫描微信进程内存并写出 all_keys.json。
      const scanRes = keyScanModule.scanWindowsWechatKeys(item.dbDir, keysPath, targetPid);
      fs.writeFileSync(
        path.join(accountStateDir, 'config.json'),
        JSON.stringify({ db_dir: item.dbDir }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );

      if (nickname === '' && wxid !== '') {
        try {
          //M 若刚解开了 contact.db，顺带补填本账号昵称供界面展示。
          const tempDb = new wechatDbModule.WechatDb({
            dbDir: item.dbDir,
            allKeys: scanRes.keyTable,
            cacheRoot: path.join(dataDir, 'db_cache', item.id),
            selfWxid: wxid,
          });
          nickname = tempDb.loadContactNames().get(wxid) ?? '';
        } catch {
          nickname = '';
        }
      }

      //M 记录提密成功的持久化项与控制台脱敏报告项。
      persisted.push({
        id: item.id,
        folder: item.folder,
        wxid,
        nickname,
        status: 'connected',
        verifiedKeys: scanRes.matchedDbs,
      });
      //M 追加脱敏连接成功结果。
      report.push({
        id: item.id,
        folder: item.folder,
        wxid,
        nickname,
        status: 'connected',
        verifiedDbs: scanRes.matchedDbs,
      });
    } catch (error) {
      let reason = '提密失败';
      if (error instanceof Error && error.message !== '') {
        reason = error.message;
      }
      //M 记录连接失败状态供调用方排查。
      persisted.push({ id: item.id, folder: item.folder, wxid, nickname, status: 'failed', error: reason });
      //M 追加脱敏失败结果。
      report.push({
        id: item.id,
        folder: item.folder,
        wxid,
        nickname,
        status: 'failed',
        verifiedDbs: 0,
        error: reason,
      });
    }
  }

  fs.writeFileSync(accountsFile, yaml.stringify(persisted), { encoding: 'utf8', mode: 0o600 });
  return report;
}
