/**
 * 微信加密数据库增量解密缓存：按文件 mtime/大小与每页 8 字节 blake2b256 摘要识别变动页，
 * 仅重解密变更页与 WAL 覆盖页，产出可供 bun:sqlite 只读直连的标准明文 SQLite 副本。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cryptoModule from './Crypto.ts';


/** 每页加密内容用于判变的短摘要长度，单位字节。 */
export const PAGE_DIGEST_SIZE = 8;

/** all_keys.json 中单个数据库条目的结构（不含以下划线开头的元数据项）。 */
export interface KeyEntry {
  /** 64 位十六进制字符串表示的 32 字节数据库加密密钥；不可打印到日志。 */
  enc_key: string;
  /** 可选的 32 位十六进制首页 salt 记录。 */
  salt?: string;
  /** 可选的原始库大小记录，单位 MB。 */
  size_mb?: number;
}

/** 账号密钥表：数据库相对路径（如 message/message_0.db）到密钥对象的映射。 */
export type KeyTable = Readonly<Record<string, KeyEntry | unknown>>;

/** 持久化在 _mtimes.json 里的单库缓存元数据。 */
interface PersistedCacheItem {
  /** 主库上次同步时的修改时间戳，单位毫秒。 */
  dbMtimeMs: number;
  /** 主库上次同步时的字节大小。 */
  dbSize: number;
  /** WAL 文件上次同步时的修改时间戳，不存在时为 0。 */
  walMtimeMs: number;
  /** WAL 文件上次同步时的字节大小，不存在时为 0。 */
  walSize: number;
  /** 明文副本的绝对路径，用于核对缓存目录未搬迁。 */
  replicaPath: string;
  /** 上一轮从 WAL 覆盖进明文副本的页号列表；下轮刷新前须先按主库还原。 */
  walPages: number[];
}

/** 内存里维护的单库旧状态。 */
interface CachedMeta {
  /** 主库上次记录的修改时间戳，毫秒。 */
  dbMtimeMs: number;
  /** 主库上次记录的字节大小。 */
  dbSize: number;
  /** WAL 上次记录的修改时间戳，毫秒。 */
  walMtimeMs: number;
  /** WAL 上次记录的字节大小。 */
  walSize: number;
  /** 明文副本路径；尚未校验未变化前仅凭 walPages 走增量。 */
  replicaPath: string;
  /** 是否已在启动或上轮确认主库和 WAL 均未变动。 */
  fresh: boolean;
  /** 上次打入副本的 WAL 页号；未知时为 undefined（必须走整库解密）。 */
  walPages: number[] | undefined;
}

/** 缓存命中与刷新次数统计，供单测验证增量刷新与排查性能。 */
export interface CacheStats {
  /** mtime 与大小均未变化、直接返回现成副本的次数。 */
  hits: number;
  /** 整库全量解密的次数。 */
  full: number;
  /** 仅增量重解密变动页与 WAL 帧的次数。 */
  incremental: number;
  /** 增量刷新期间实际重解密的主库页总数。 */
  pages: number;
}


/**
 * 校验相对数据库路径不含目录穿越或盘符前缀，并统一转为正斜杠格式。
 * @param relPath 调用方传入的数据库相对路径。
 * @returns 合法的正斜杠相对路径；非法时返回 undefined。
 */
export function normalizeDbRelPath(relPath: string): string | undefined {
  if (relPath.trim() === '' || relPath.includes('\0')) return undefined;

  const unified = relPath.replaceAll('\\', '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/u.test(unified)) return undefined;

  const normalized = path.posix.normalize(unified);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  if (normalized.split('/').includes('..')) return undefined;

  return normalized;
}


/**
 * 生成同一相对路径在 Windows 与 POSIX 下可能出现的键名写法。
 * @param relPath 已校验的正斜杠相对路径。
 * @returns 去重后的候选键名列表。
 */
export function getKeyPathVariants(relPath: string): string[] {
  const backslash = relPath.replaceAll('/', '\\');
  const nativeSep = relPath.replaceAll('/', path.sep);
  const candidates = [relPath, backslash, nativeSep];
  return [...new Set(candidates)];
}


/**
 * 从 all_keys 映射里查找某个相对库路径的 32 字节密钥；兼容正反斜杠写法并忽略 _ 元数据键。
 * @param allKeys 账号的密钥映射表。
 * @param relPath 数据库相对 db_storage 的路径。
 * @returns 32 字节密钥 Buffer；找不到或格式非法返回 undefined。
 */
export function getDatabaseKey(allKeys: KeyTable, relPath: string): Buffer | undefined {
  //G 先拦下越界相对路径，避免拼出 db_storage 之外的任意磁盘路径。
  const normalized = normalizeDbRelPath(relPath);
  if (normalized === undefined) return undefined;

  //M 依次尝试正斜杠与反斜杠键名，兼容 Windows 提密工具生成的 all_keys.json。
  const variants = getKeyPathVariants(normalized);
  for (const key of variants) {
    if (key.startsWith('_')) {
      continue;
    }
    const entry = allKeys[key];
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const hex = (entry as Partial<KeyEntry>).enc_key;
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(hex)) {
      continue;
    }
    return Buffer.from(hex, 'hex');
  }
  return undefined;
}


/**
 * 计算单页 4096 字节密文的 blake2b256 前 8 字节摘要，用于极速判断主库单页是否变动。
 * @param pageData 单页密文字节。
 * @returns 8 字节摘要 Buffer。
 */
export function getPageDigest(pageData: Uint8Array): Buffer {
  //M 调 Bun 原生 blake2b256 计算密文页摘要并截取前 8 字节。
  const hasher = new Bun.CryptoHasher('blake2b256');
  hasher.update(pageData);
  const digest = Buffer.from(hasher.digest());
  return Buffer.from(digest.subarray(0, PAGE_DIGEST_SIZE));
}


/**
 * 从已打开文件按页号读取一整页，末尾不足 4096 字节时补零。
 * @param fd 已打开的只读文件描述符。
 * @param pageNo 从 1 开始的页号。
 * @param scratch 复用的 4096 字节读缓冲。
 * @returns 实际读到数据时返回 scratch 视图，到达文件尾返回 undefined。
 */
function readPaddedPage(fd: number, pageNo: number, scratch: Buffer): Buffer | undefined {
  const offset = (pageNo - 1) * cryptoModule.PAGE_SIZE;
  const bytesRead = fs.readSync(fd, scratch, 0, cryptoModule.PAGE_SIZE, offset);
  if (bytesRead <= 0) return undefined;

  if (bytesRead < cryptoModule.PAGE_SIZE) {
    scratch.fill(0, bytesRead, cryptoModule.PAGE_SIZE);
  }
  return scratch;
}


/**
 * 对整份加密主库逐页计算 8 字节摘要并写入 .pages 旁路文件。
 * @param dbPath 加密主库路径。
 * @param digestPath 旁路摘要文件输出路径。
 * @param totalPages 主库整页数。
 */
function writeFullDigests(dbPath: string, digestPath: string, totalPages: number): void {
  const fin = fs.openSync(dbPath, 'r');
  const scratch = Buffer.allocUnsafe(cryptoModule.PAGE_SIZE);
  const allDigests = Buffer.allocUnsafe(totalPages * PAGE_DIGEST_SIZE);
  try {
    for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
      //M 逐页读取加密原文并把 8 字节摘要顺序填入连续缓冲区。
      const page = readPaddedPage(fin, pageNo, scratch);
      if (page === undefined) {
        allDigests.fill(0, (pageNo - 1) * PAGE_DIGEST_SIZE, pageNo * PAGE_DIGEST_SIZE);
        continue;
      }
      const digest = getPageDigest(page);
      digest.copy(allDigests, (pageNo - 1) * PAGE_DIGEST_SIZE);
    }
  } finally {
    fs.closeSync(fin);
  }
  const tempPath = `${digestPath}.tmp`;
  fs.writeFileSync(tempPath, allDigests);
  fs.renameSync(tempPath, digestPath);
}


/**
 * 读取文件的 mtimeMs 与字节大小；文件不存在时返回全零。
 * @param targetPath 待查文件路径。
 * @returns 修改时间与大小快照。
 */
function getFileStamp(targetPath: string): { exists: boolean; mtimeMs: number; size: number } {
  const stat = fs.statSync(targetPath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
  return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
}


/**
 * 单个微信账号 db_storage 目录的解密副本缓存管理器。
 */
export class DbCache {
  /** 当前账号库对应的独立缓存子目录（按 dbDir 路径指纹隔离）。 */
  readonly cacheDir: string;

  /** 缓存状态持久化 JSON 文件路径。 */
  readonly mtimeFile: string;

  /** 本实例运行期间的命中与增量刷新统计。 */
  readonly stats: CacheStats = { hits: 0, full: 0, incremental: 0, pages: 0 };

  /** 以正斜杠相对路径为键的副本状态表。 */
  private readonly entries = new Map<string, CachedMeta>();

  /**
   * @param allKeys 账号 all_keys.json 解析后的密钥表。
   * @param dbDir 微信账号的 db_storage 目录绝对路径。
   * @param cacheRoot 本插件存放解密副本的缓存根目录（如 <data>/cache/<account>）。
   */
  constructor(
    private readonly allKeys: KeyTable,
    readonly dbDir: string,
    cacheRoot: string,
  ) {
    const resolvedDb = path.resolve(dbDir);
    let identityInput = resolvedDb;
    if (process.platform === 'win32') {
      identityInput = resolvedDb.toLowerCase();
    }
    const fingerprint = crypto.createHash('sha256').update(identityInput).digest('hex').slice(0, 24);
    this.cacheDir = path.join(path.resolve(cacheRoot), fingerprint);
    this.mtimeFile = path.join(this.cacheDir, '_mtimes.json');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    //M 启动时载入上次持久化的 mtime 与 WAL 页清单，供跨重启增量刷新复用。
    this.loadPersistentState();
  }

  /**
   * 获取指定相对路径数据库（如 session/session.db）的最新明文 SQLite 副本路径。
   * 若主库与 -wal 均未变直接复用；有旧副本和摘要则走页级增量刷新；否则全量解密。
   * @param relKey 数据库相对 db_storage 的路径。
   * @returns 明文 SQLite 副本绝对路径；无对应密钥或源库文件不存在时返回 undefined。
   */
  getDecryptedPath(relKey: string): string | undefined {
    //G 先找正反斜杠兼容的密钥，无密钥的库无法解密。
    const normalized = normalizeDbRelPath(relKey);
    if (normalized === undefined) return undefined;

    //M 提取 32 字节密钥并定位源 .db 与伴生 -wal 文件。
    const encKey = getDatabaseKey(this.allKeys, normalized);
    if (encKey === undefined) return undefined;

    const nativeRel = normalized.replaceAll('/', path.sep);
    const dbPath = path.join(this.dbDir, nativeRel);
    const dbStamp = getFileStamp(dbPath);
    if (!dbStamp.exists || dbStamp.size < cryptoModule.PAGE_SIZE) return undefined;

    //M 计算目标副本与摘要文件路径，并读取内存里已知的旧状态。
    const walPath = `${dbPath}-wal`;
    const walStamp = getFileStamp(walPath);
    const replicaPath = this.getReplicaPath(normalized);
    const digestPath = this.getDigestPath(normalized);
    const known = this.entries.get(normalized);

    //G 源主库与 WAL 的时间戳和字节数都未变化，且明文副本仍在磁盘上时直接命中返回。
    if (
      known !== undefined
      && known.fresh
      && known.dbMtimeMs === dbStamp.mtimeMs
      && known.dbSize === dbStamp.size
      && known.walMtimeMs === walStamp.mtimeMs
      && known.walSize === walStamp.size
      && fs.existsSync(replicaPath)
    ) {
      this.stats.hits += 1;
      return replicaPath;
    }

    //M 判断是否具备页级增量刷新的全部前提：已有副本、合法页摘要与上一轮 WAL 覆盖页记录。
    const digestStamp = getFileStamp(digestPath);
    const canIncremental = (
      known?.walPages !== undefined
      && fs.existsSync(replicaPath)
      && digestStamp.exists
      && digestStamp.size % PAGE_DIGEST_SIZE === 0
    );

    let walPages: number[] | undefined;
    if (canIncremental && known?.walPages !== undefined) {
      const mainChanged = known.dbMtimeMs !== dbStamp.mtimeMs || known.dbSize !== dbStamp.size;
      try {
        //M 只重解密变动的主库页与上次被旧 WAL 改写过的页，再叠上当前最新 WAL。
        walPages = this.refreshIncremental(
          dbPath,
          walPath,
          replicaPath,
          digestPath,
          encKey,
          dbStamp.size,
          known.walPages,
          mainChanged,
        );
      } catch {
        //G 增量途中若遇并发截断或坏缓存文件，回退整库全量重解密确保副本一致。
        walPages = undefined;
      }
    }

    if (walPages === undefined) {
      //M 首次读取或增量回退时全量解密主库、生成摘要文件并合并当前 WAL。
      walPages = this.refreshFull(dbPath, walPath, replicaPath, digestPath, encKey, dbStamp.size);
    }

    this.entries.set(normalized, {
      dbMtimeMs: dbStamp.mtimeMs,
      dbSize: dbStamp.size,
      walMtimeMs: walStamp.mtimeMs,
      walSize: walStamp.size,
      replicaPath,
      fresh: true,
      walPages,
    });
    //M 每次刷新完成后把最新 mtime 与 WAL 页清单原子写回磁盘。
    this.savePersistentState();
    return replicaPath;
  }

  /**
   * 算出正斜杠相对路径对应的明文副本路径。
   * @param normalizedRel 已归一化的正斜杠相对路径。
   */
  private getReplicaPath(normalizedRel: string): string {
    const shortHash = crypto.createHash('md5').update(normalizedRel).digest('hex').slice(0, 12);
    return path.join(this.cacheDir, `${shortHash}.db`);
  }

  /**
   * 算出正斜杠相对路径对应的 8 字节页摘要旁路文件路径。
   * @param normalizedRel 已归一化的正斜杠相对路径。
   */
  private getDigestPath(normalizedRel: string): string {
    const replica = this.getReplicaPath(normalizedRel);
    return `${replica.slice(0, -3)}.pages`;
  }

  /**
   * 全量解密主库、写出全量加密页摘要并打上当前 WAL。
   */
  private refreshFull(
    dbPath: string,
    walPath: string,
    replicaPath: string,
    digestPath: string,
    encKey: Uint8Array,
    dbSize: number,
  ): number[] {
    const totalPages = Math.floor(dbSize / cryptoModule.PAGE_SIZE);
    //M 先全量写出明文主库，再建立页摘要基准，最后合并同代 WAL 帧。
    cryptoModule.decryptDatabaseFile(dbPath, replicaPath, encKey);
    writeFullDigests(dbPath, digestPath, totalPages);
    this.stats.full += 1;
    return cryptoModule.applyWalFrames(walPath, replicaPath, encKey);
  }

  /**
   * 在现有明文副本上还原上次 WAL 页、仅重解密摘要变化的页，再合并最新 WAL。
   */
  private refreshIncremental(
    dbPath: string,
    walPath: string,
    replicaPath: string,
    digestPath: string,
    encKey: Uint8Array,
    dbSize: number,
    oldWalPages: readonly number[],
    mainChanged: boolean,
  ): number[] {
    const totalPages = Math.floor(dbSize / cryptoModule.PAGE_SIZE);
    const redoPages = new Set<number>();
    for (const pageNo of oldWalPages) {
      if (pageNo >= 1 && pageNo <= totalPages) {
        redoPages.add(pageNo);
      }
    }

    //M 主库发生过 checkpoint 更新时，逐页对比 8 字节摘要找出真正变动的页号。
    let freshDigests: Buffer | undefined;
    if (mainChanged) {
      const oldDigests = fs.readFileSync(digestPath);
      freshDigests = Buffer.allocUnsafe(totalPages * PAGE_DIGEST_SIZE);
      const scanFd = fs.openSync(dbPath, 'r');
      const scanBuf = Buffer.allocUnsafe(cryptoModule.PAGE_SIZE);
      try {
        for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
          //M 读取当前加密页算新摘要，与旧旁路摘要不等或超出旧长度时加入重解集合。
          const page = readPaddedPage(scanFd, pageNo, scanBuf);
          if (page === undefined) {
            freshDigests.fill(0, (pageNo - 1) * PAGE_DIGEST_SIZE, pageNo * PAGE_DIGEST_SIZE);
            continue;
          }
          const digest = getPageDigest(page);
          const start = (pageNo - 1) * PAGE_DIGEST_SIZE;
          digest.copy(freshDigests, start);
          const end = start + PAGE_DIGEST_SIZE;
          const hadOld = end <= oldDigests.byteLength;
          if (!hadOld || !oldDigests.subarray(start, end).equals(digest)) {
            redoPages.add(pageNo);
          }
        }
      } finally {
        fs.closeSync(scanFd);
      }
    }

    //M 按升序页号从源库读取需要还原或更新的加密页，解密写回副本对应偏移。
    const sortedRedo = [...redoPages].sort((left, right) => left - right);
    const fin = fs.openSync(dbPath, 'r');
    const fout = fs.openSync(replicaPath, 'r+');
    const scratch = Buffer.allocUnsafe(cryptoModule.PAGE_SIZE);
    try {
      for (const pageNo of sortedRedo) {
        //M 读取变动页并解密覆盖明文副本同位置。
        const page = readPaddedPage(fin, pageNo, scratch);
        if (page === undefined) {
          continue;
        }
        const plain = cryptoModule.decryptPage(encKey, page, pageNo);
        const offset = (pageNo - 1) * cryptoModule.PAGE_SIZE;
        fs.writeSync(fout, plain, 0, cryptoModule.PAGE_SIZE, offset);
      }
      //M 若主库截短则同步截齐副本，随后打 WAL 时如有更高页会自动扩展。
      fs.ftruncateSync(fout, totalPages * cryptoModule.PAGE_SIZE);
    } finally {
      fs.closeSync(fin);
      fs.closeSync(fout);
    }

    if (freshDigests !== undefined) {
      const tempDigest = `${digestPath}.tmp`;
      fs.writeFileSync(tempDigest, freshDigests);
      fs.renameSync(tempDigest, digestPath);
    }

    this.stats.incremental += 1;
    this.stats.pages += sortedRedo.length;
    //M 将最新一代 WAL 帧覆盖进刚刚还原好的主库副本。
    return cryptoModule.applyWalFrames(walPath, replicaPath, encKey);
  }

  /**
   * 启动时从 _mtimes.json 恢复旧副本状态；路径搬迁或损坏的条目自动忽略。
   */
  private loadPersistentState(): void {
    if (!fs.existsSync(this.mtimeFile)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.mtimeFile, 'utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

    const record = parsed as Record<string, unknown>;
    for (const rawKey of Object.keys(record)) {
      //G 校验持久化键名与副本路径仍指向当前缓存目录。
      const normalized = normalizeDbRelPath(rawKey);
      if (normalized === undefined) {
        continue;
      }
      const rawItem = record[rawKey];
      if (typeof rawItem !== 'object' || rawItem === null) {
        continue;
      }
      const item = rawItem as Partial<PersistedCacheItem>;
      const expectedReplica = this.getReplicaPath(normalized);
      if (item.replicaPath !== expectedReplica || !fs.existsSync(expectedReplica)) {
        continue;
      }
      if (
        typeof item.dbMtimeMs !== 'number'
        || typeof item.dbSize !== 'number'
        || typeof item.walMtimeMs !== 'number'
        || typeof item.walSize !== 'number'
      ) {
        continue;
      }

      let walPages: number[] | undefined;
      if (Array.isArray(item.walPages) && item.walPages.every((n) => Number.isInteger(n) && n >= 1)) {
        walPages = item.walPages;
      }

      //M 核对磁盘现况决定是否可直接标记为 fresh，对不上的保留 walPages 待首次查询走增量。
      const nativeRel = normalized.replaceAll('/', path.sep);
      const dbPath = path.join(this.dbDir, nativeRel);
      const dbStamp = getFileStamp(dbPath);
      const walStamp = getFileStamp(`${dbPath}-wal`);
      const unchanged = (
        dbStamp.exists
        && dbStamp.mtimeMs === item.dbMtimeMs
        && dbStamp.size === item.dbSize
        && walStamp.mtimeMs === item.walMtimeMs
        && walStamp.size === item.walSize
      );
      this.entries.set(normalized, {
        dbMtimeMs: item.dbMtimeMs,
        dbSize: item.dbSize,
        walMtimeMs: item.walMtimeMs,
        walSize: item.walSize,
        replicaPath: expectedReplica,
        fresh: unchanged,
        walPages,
      });
    }
  }

  /**
   * 将当前缓存条目原子写回 _mtimes.json；I/O 异常不阻断本次读取返回。
   */
  private savePersistentState(): void {
    const output: Record<string, PersistedCacheItem> = {};
    for (const [key, meta] of this.entries) {
      if (meta.walPages === undefined) {
        continue;
      }
      output[key] = {
        dbMtimeMs: meta.dbMtimeMs,
        dbSize: meta.dbSize,
        walMtimeMs: meta.walMtimeMs,
        walSize: meta.walSize,
        replicaPath: meta.replicaPath,
        walPages: meta.walPages,
      };
    }
    try {
      const tempFile = `${this.mtimeFile}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(output), 'utf8');
      fs.renameSync(tempFile, this.mtimeFile);
    } catch {
      // 缓存索引落盘失败不影响当次已生成的明文副本读取。
    }
  }
}
