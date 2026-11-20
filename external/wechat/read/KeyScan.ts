/**
 * 微信 4.x 数据库密钥纯 Bun 按需内存扫描器（支持 Config.Cipher 指针链解码与 x'...' 十六进制字面量回退）。
 * 仅在用户显式触发连接（`--connect`）时按需调用 `bun:ffi` 只读访问 Windows 微信进程内存，
 * 日常轮询零 FFI 调用；全程只读不注入，且绝不向日志或异常输出任何密钥、候选串或个人路径。
 */
import * as ffi from 'bun:ffi';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cryptoModule from './Crypto.ts';
import * as cacheModule from './DbCache.ts';


/** 微信 4.1+ WCDB 加密配置对象在内存中的固定类名标识（30 字节 ASCII）。 */
export const WINDOWS_CONFIG_CIPHER_NAME = Buffer.from('com.Tencent.WCDB.Config.Cipher', 'ascii');

/** 微信 4.1+ Windows 版 Config.Cipher 配置块固定 32 字节循环异或掩码。 */
export const WINDOWS_CONFIG_XOR_MASK = Buffer.from(
  'd2c7442458020000004889442450488b450048844c2448488944254048584c24',
  'hex',
);

/** 64 位 Windows 用户态虚拟地址上限（低于该值才视为合理用户态指针）。 */
export const WINDOWS_MAX_USER_ADDRESS = 0x0000_8000_0000_0000n;

/** Windows 用户态最低有效指针下限（跳过前 64 KiB 空指针保护区）。 */
const WINDOWS_MIN_USER_ADDRESS = 0x0000_0000_0001_0000n;

/** VirtualQueryEx 遍历用户态虚拟空间时的扫描上限地址。 */
const WINDOWS_REGION_SCAN_LIMIT = 0x0000_7fff_ffff_ffffn;

/** Config.Cipher 数据块允许读取的最大字节数。 */
const WINDOWS_CONFIG_BLOB_MAX = 1024;

/** Config.Cipher 分块扫描单次读取上限（2 MiB）。 */
const CONFIG_SCAN_CHUNK_BYTES = 2 * 1024 * 1024;

/** 原始 hex 模式回退扫描单次读取上限（4 MiB）。 */
const HEX_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** 原始 hex 模式跨块重叠字节数，防止 `x'...'` 字面量恰好跨在分块边界被截断。 */
const HEX_SCAN_OVERLAP_BYTES = 256;

/** Win32 VirtualQueryEx 接受的允许纳入扫描的单区域最大长度（500 MiB）。 */
const MAX_SINGLE_REGION_BYTES = 500n * 1024n * 1024n;

/** Win32 MEM_COMMIT 已提交物理/页文件内存状态常量。 */
const WIN32_MEM_COMMIT = 0x1000;

/** Win32 PROCESS_QUERY_LIMITED_INFORMATION 权限位（用于查询进程可执行文件名）。 */
const WIN32_PROCESS_QUERY_LIMITED_INFO = 0x1000;

/** Win32 PROCESS_VM_READ | PROCESS_QUERY_INFORMATION 权限组合（只读扫描虚拟内存）。 */
const WIN32_PROCESS_READ_QUERY = 0x0010 | 0x0400;

/** 64 位 Windows MEMORY_BASIC_INFORMATION 结构体固定字节大小。 */
const WIN64_MBI_BYTES = 48;

/** Win32 页面可读保护属性集合（只读、读写、写时拷贝、执行可读等，排除 PAGE_GUARD / NOACCESS）。 */
const WIN32_READABLE_PROTECT = new Set([0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]);

/** Config.Cipher 解码块内匹配大小写 `x'...'` 十六进制字面量的正则。 */
const CONFIG_HEX_LITERAL_RE = /[xX]'([0-9a-fA-F]{64,192})'/gu;

/** 进程内存回退扫描匹配小写 `x'...'` 十六进制字面量的正则。 */
const RAW_HEX_LITERAL_RE = /x'([0-9a-fA-F]{64,192})'/gu;


/** 进程可读虚拟内存区域描述。 */
export interface MemoryRegion {
  /** 区域起始虚拟地址。 */
  base: bigint;
  /** 区域可读字节长度。 */
  size: number;
}

/** 抽象的只读进程内存访问器（离线单测注入合成内存页，生产连接注入 Win32 ReadProcessMemory）。 */
export interface ProcessMemoryReader {
  /** 可选进程编号标识（仅用于统计，不暴露敏感信息）。 */
  pid?: number;
  /** 待顺序扫描的可读内存区域列表。 */
  regions: readonly MemoryRegion[];
  /** 按任意虚拟地址与长度只读读取一段内存；不可读或越界时返回 undefined。 */
  readMemory(address: bigint, length: number): Buffer | undefined;
}

/** 单个待匹配密钥的微信加密数据库首页摘要信息。 */
export interface DbSaltItem {
  /** 相对 db_storage 的正斜杠路径（如 `message/message_0.db`）。 */
  relPath: string;
  /** 数据库磁盘绝对路径。 */
  absPath: string;
  /** 数据库文件字节大小。 */
  size: number;
  /** 首页前 16 字节盐值的 32 位小写十六进制字符串。 */
  saltHex: string;
  /** 数据库前 4096 字节原始首页内容（供 HMAC-SHA512 验密）。 */
  page1: Buffer;
}

/** 账号 db_storage 下全部加密数据库的盐值索引集合。 */
export interface DbSaltCollection {
  /** 收集到的有效加密库列表。 */
  files: DbSaltItem[];
  /** 每个 32 位十六进制 salt 对应的数据库相对路径列表。 */
  saltToDbs: Map<string, string[]>;
}

/** Config.Cipher 指针链解码产出的单个候选密钥项。 */
export interface ConfigKeyCandidate {
  /** 64 位小写十六进制表示的 32 字节候选主密钥。 */
  encKeyHex: string;
  /** 若字面量内紧跟 16 字节盐值，则为对应 32 位小写十六进制盐值。 */
  embeddedSalt?: string;
}

/** Config.Cipher 扫描阶段脱敏计数统计。 */
export interface ConfigCipherScanStats {
  /** 命中类名字符串 `com.Tencent.WCDB.Config.Cipher` 的虚拟地址数。 */
  needleOccurrences: number;
  /** 命中 `(addr, 30)` 字符串引用对的次数。 */
  stringObjectRefs: number;
  /** 通过节点结构校验的候选节点数。 */
  nodeCandidates: number;
  /** 去重后的候选 Config 对象指针数。 */
  configPtrCandidates: number;
  /** 长度为 99 字节的标准配置块命中数。 */
  blob99Count: number;
  /** 解码筛出的去重高熵候选密钥数。 */
  candidateCount: number;
  /** 通过数据库首页 HMAC 验真的候选密钥数。 */
  verifiedCandidates: number;
  /** 本阶段成功匹配的数据库盐值数。 */
  matchedSalts: number;
}

/** 一次完整内存提密流程的汇总结果。 */
export interface KeyScanSummary {
  /** 已匹配的 `saltHex -> encKeyHex` 映射。 */
  saltKeys: Map<string, string>;
  /** 可直接写入 `all_keys.json` 或传给 `DbCache` 的相对路径密钥表。 */
  keyTable: Record<string, cacheModule.KeyEntry>;
  /** 总数据库数量。 */
  totalDbs: number;
  /** 成功匹配密钥的数据库数量。 */
  matchedDbs: number;
  /** 未能匹配密钥的数据库相对路径列表。 */
  missingDbs: string[];
  /** Config.Cipher 阶段累计统计。 */
  configStats: ConfigCipherScanStats;
  /** 回退 hex 扫描阶段命中的字面量总数。 */
  rawHexMatches: number;
  /** 交叉验证阶段补齐的盐值数量。 */
  crossVerifiedSalts: number;
}

/** 用户指定目录下发现的单个微信账号数据库目录条目。 */
export interface DiscoveredWechatAccount {
  /** 基于 dbDir 哈希生成的稳定账号标识（如 `account_a1b2c3d4e5f6`）。 */
  id: string;
  /** 微信账号目录名（如 `wxid_xxx_1234`）。 */
  folder: string;
  /** 账号下的 `db_storage` 绝对路径。 */
  dbDir: string;
}


/**
 * 从缓冲区指定偏移读取 64 位无符号小端整数；越界时返回 0n。
 * @param data 源字节缓冲。
 * @param offset 字节偏移。
 */
function readU64LE(data: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > data.byteLength) return 0n;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}


/**
 * 将 64 位无符号整数编码为 8 字节小端 Buffer。
 * @param value 非负 64 位整数。
 */
function packU64LE(value: bigint): Buffer {
  const out = Buffer.allocUnsafe(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}


/**
 * 判断 32 字节候选密钥是否具备正常随机密钥的字节离散度（排除全零、全 0xff 与低熵噪声）。
 * @param keyBytes 32 字节候选密钥。
 */
export function isProbable32ByteKey(keyBytes: Uint8Array): boolean {
  if (keyBytes.byteLength !== cryptoModule.KEY_SIZE) return false;

  const distinct = new Set<number>();
  let allZero = true;
  let allFf = true;
  for (let index = 0; index < keyBytes.byteLength; index += 1) {
    const byteVal = keyBytes[index]!;
    distinct.add(byteVal);
    if (byteVal !== 0x00) {
      allZero = false;
    }
    if (byteVal !== 0xff) {
      allFf = false;
    }
  }
  if (allZero || allFf) return false;

  return distinct.size >= 15;
}


/**
 * 递归扫描账号 `db_storage` 目录，收集全部有效 `.db` 文件的首页面与 16 字节盐值。
 * @param dbDir 微信账号的 `db_storage` 目录路径。
 */
export function collectDbSalts(dbDir: string): DbSaltCollection {
  const files: DbSaltItem[] = [];
  const saltToDbs = new Map<string, string[]>();
  if (dbDir === '' || !fs.existsSync(dbDir)) {
    return { files, saltToDbs };
  }

  const stack: string[] = [dbDir];
  const dirsToVisit: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    //M 记录待枚举文件的目录节点。
    dirsToVisit.push(current);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const subDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(current, entry.name))
      .sort()
      .reverse();
    for (const sub of subDirs) {
      //M 将子目录逆序压栈以保持稳定字典序遍历。
      stack.push(sub);
    }
  }

  for (const dirPath of dirsToVisit) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const sortedNames = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    for (const name of sortedNames) {
      if (!name.endsWith('.db') || name.endsWith('-wal') || name.endsWith('-shm')) {
        continue;
      }
      const absPath = path.join(dirPath, name);
      let fileSize = 0;
      try {
        fileSize = fs.statSync(absPath).size;
      } catch {
        continue;
      }
      if (fileSize < cryptoModule.PAGE_SIZE) {
        continue;
      }

      const rawRel = path.relative(dbDir, absPath);
      //M 统一归一化为安全正斜杠相对路径，跨平台对齐 DbCache 键名。
      const relPath = cacheModule.normalizeDbRelPath(rawRel);
      if (relPath === undefined) {
        continue;
      }

      const page1 = Buffer.allocUnsafe(cryptoModule.PAGE_SIZE);
      const fd = fs.openSync(absPath, 'r');
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, page1, 0, cryptoModule.PAGE_SIZE, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (bytesRead < cryptoModule.PAGE_SIZE) {
        continue;
      }

      //G 已是明文 SQLite 头的文件无需提取加密盐。
      if (page1.subarray(0, 15).toString('ascii') === 'SQLite format 3') {
        continue;
      }

      const saltHex = page1.subarray(0, cryptoModule.SALT_SIZE).toString('hex');
      //M 记录当前加密数据库的首页内容与盐值归组。
      files.push({ relPath, absPath, size: fileSize, saltHex, page1 });
      let list = saltToDbs.get(saltHex);
      if (list === undefined) {
        list = [];
        saltToDbs.set(saltHex, list);
      }
      //M 将相对路径归入同盐值数据库列表。
      list.push(relPath);
    }
  }

  return { files, saltToDbs };
}


/**
 * 对微信 4.1+ `Config.Cipher` 数据块做循环异或解码，提取候选密钥与内嵌盐值列表。
 * @param blob 从配置对象读取的原始加密配置字节块。
 */
export function decodeConfigCipherCandidates(blob: Uint8Array): ConfigKeyCandidate[] {
  if (blob.byteLength === 0 || blob.byteLength > WINDOWS_CONFIG_BLOB_MAX) return [];

  const decoded = Buffer.allocUnsafe(blob.byteLength);
  const maskLen = WINDOWS_CONFIG_XOR_MASK.byteLength;
  for (let index = 0; index < blob.byteLength; index += 1) {
    decoded[index] = blob[index]! ^ WINDOWS_CONFIG_XOR_MASK[index % maskLen]!;
  }

  const text = decoded.toString('latin1');
  const candidates: ConfigKeyCandidate[] = [];
  const seen = new Set<string>();
  CONFIG_HEX_LITERAL_RE.lastIndex = 0;

  let match = CONFIG_HEX_LITERAL_RE.exec(text);
  while (match !== null) {
    const run = (match[1] ?? '').toLowerCase();
    const starts: number[] = [0];
    if (run.length > 96) {
      for (let pos = 0; pos <= run.length - 64; pos += 32) {
        if (!starts.includes(pos)) {
          //M 长十六进制串按 16 字节对齐步进补充候选切分起点。
          starts.push(pos);
        }
      }
      const tailStart = run.length - 64;
      if (!starts.includes(tailStart)) {
        //M 同时纳入末尾 64 位作为候选密钥起点。
        starts.push(tailStart);
      }
    }

    for (const start of starts) {
      if (start < 0 || start + 64 > run.length) {
        continue;
      }
      const encKeyHex = run.slice(start, start + 64);
      if (encKeyHex.length !== 64 || !/^[0-9a-f]{64}$/u.test(encKeyHex)) {
        continue;
      }
      const encKeyBytes = Buffer.from(encKeyHex, 'hex');
      //G 排除低熵伪造串，减少无效 PBKDF2 验密开销。
      if (!isProbable32ByteKey(encKeyBytes)) {
        continue;
      }

      let embeddedSalt: string | undefined;
      if (start + 96 <= run.length) {
        embeddedSalt = run.slice(start + 64, start + 96);
      }
      const dedupeKey = `${encKeyHex}:${embeddedSalt ?? ''}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        const item: ConfigKeyCandidate = { encKeyHex };
        if (embeddedSalt !== undefined) {
          item.embeddedSalt = embeddedSalt;
        }
        //M 收入去重后的高熵候选密钥与可选内嵌盐值。
        candidates.push(item);
      }
    }
    match = CONFIG_HEX_LITERAL_RE.exec(text);
  }

  return candidates;
}


/**
 * 按给定块大小与跨块重叠字节数顺序遍历内存区域，把每段连续数据交给回调处理。
 * @param reader 进程只读内存访问器。
 * @param chunkSize 单次底层读取字节上限。
 * @param overlap 相邻分块保留的尾部重叠字节数。
 * @param onChunk 分块处理回调；返回 false 时立即终止后续遍历。
 */
function forEachRegionChunk(
  reader: ProcessMemoryReader,
  chunkSize: number,
  overlap: number,
  onChunk: (chunkBase: bigint, data: Buffer) => boolean,
): void {
  for (const region of reader.regions) {
    let offset = 0;
    let tail: Buffer = Buffer.alloc(0);
    let tailBase = region.base;

    while (offset < region.size) {
      const readLen = Math.min(chunkSize, region.size - offset);
      const currentAddr = region.base + BigInt(offset);
      const chunk = reader.readMemory(currentAddr, readLen);
      offset += readLen;

      if (chunk === undefined || chunk.byteLength === 0) {
        tail = Buffer.alloc(0);
        tailBase = region.base + BigInt(offset);
        continue;
      }

      let dataBase = currentAddr;
      let combined = chunk;
      if (tail.byteLength > 0) {
        dataBase = tailBase;
        combined = Buffer.concat([tail, chunk]);
      }

      const keepGoing = onChunk(dataBase, combined);
      if (!keepGoing) return;

      if (overlap > 0) {
        const keepBytes = Math.min(overlap, combined.byteLength);
        tail = combined.subarray(combined.byteLength - keepBytes);
        tailBase = dataBase + BigInt(combined.byteLength - keepBytes);
      }
      if (overlap <= 0) {
        tail = Buffer.alloc(0);
        tailBase = region.base + BigInt(offset);
      }
    }
  }
}


/**
 * 用数据库首页 HMAC-SHA512 校验单个候选密钥是否匹配尚未解开的盐值。
 * @param encKeyHex 64 位十六进制候选密钥。
 * @param preferredSalt 可选优先验证的 32 位十六进制盐值。
 * @param collection 数据库首页盐值集合。
 * @param keyMap 已验证通过的 `saltHex -> encKeyHex` 映射。
 * @param remainingSalts 尚未匹配的盐值集合。
 * @returns 本次新匹配成功的盐值个数。
 */
function verifyCandidateAgainstSalts(
  encKeyHex: string,
  preferredSalt: string | undefined,
  collection: DbSaltCollection,
  keyMap: Map<string, string>,
  remainingSalts: Set<string>,
): number {
  if (remainingSalts.size === 0) return 0;

  const encKey = Buffer.from(encKeyHex, 'hex');
  //G 校验前再次确认 32 字节密钥离散度合法。
  if (!isProbable32ByteKey(encKey)) return 0;

  let targetSalts: string[] = [...remainingSalts];
  if (preferredSalt !== undefined && remainingSalts.has(preferredSalt)) {
    targetSalts = [preferredSalt];
  }

  let matched = 0;
  for (const saltHex of targetSalts) {
    if (!remainingSalts.has(saltHex)) {
      continue;
    }
    for (const item of collection.files) {
      if (item.saltHex !== saltHex) {
        continue;
      }
      //M 调用 Crypto.verifyPage1Key 做 SQLCipher 4 首页 HMAC-SHA512 定长验真。
      if (cryptoModule.verifyPage1Key(encKey, item.page1)) {
        keyMap.set(saltHex, encKeyHex.toLowerCase());
        remainingSalts.delete(saltHex);
        matched += 1;
        break;
      }
    }
  }
  return matched;
}


/**
 * 扫描微信 4.1+ 进程内存中的 `com.Tencent.WCDB.Config.Cipher` 指针链并验证候选数据库密钥。
 * @param reader 只读进程内存访问器。
 * @param collection 待匹配的数据库首页集合。
 * @param keyMap 输出已验证的 `saltHex -> encKeyHex` 映射。
 * @param remainingSalts 剩余未匹配盐值集合。
 */
export function scanConfigCipherInMemory(
  reader: ProcessMemoryReader,
  collection: DbSaltCollection,
  keyMap: Map<string, string>,
  remainingSalts: Set<string>,
): ConfigCipherScanStats {
  const stats: ConfigCipherScanStats = {
    needleOccurrences: 0,
    stringObjectRefs: 0,
    nodeCandidates: 0,
    configPtrCandidates: 0,
    blob99Count: 0,
    candidateCount: 0,
    verifiedCandidates: 0,
    matchedSalts: 0,
  };
  if (remainingSalts.size === 0) return stats;

  //M 第一步：分块定位 `com.Tencent.WCDB.Config.Cipher` 类名字面量的全部虚拟地址。
  const needleAddresses = new Set<bigint>();
  const needleOverlap = WINDOWS_CONFIG_CIPHER_NAME.byteLength - 1;
  forEachRegionChunk(reader, CONFIG_SCAN_CHUNK_BYTES, needleOverlap, (chunkBase, data) => {
    let pos = data.indexOf(WINDOWS_CONFIG_CIPHER_NAME);
    while (pos >= 0) {
      needleAddresses.add(chunkBase + BigInt(pos));
      pos = data.indexOf(WINDOWS_CONFIG_CIPHER_NAME, pos + 1);
    }
    return true;
  });

  stats.needleOccurrences = needleAddresses.size;
  if (needleAddresses.size === 0) return stats;

  //M 第二步：为每个类名地址构造 16 字节 `(ptr, len=30)` 引用对特征。
  const nameLenBuf = packU64LE(BigInt(WINDOWS_CONFIG_CIPHER_NAME.byteLength));
  const pairPatterns: Buffer[] = [];
  for (const addr of needleAddresses) {
    pairPatterns.push(Buffer.concat([packU64LE(addr), nameLenBuf]));
  }

  const seenConfigPtrs = new Set<bigint>();
  const seenCandidates = new Set<string>();

  //M 第三步：扫描引用节点，顺着 `node + 0x28 -> config + 0x88 -> blob` 只读解出候选密钥。
  forEachRegionChunk(reader, CONFIG_SCAN_CHUNK_BYTES, 0x80, (chunkBase, data) => {
    if (remainingSalts.size === 0) return false;

    for (const pattern of pairPatterns) {
      let pos = data.indexOf(pattern);
      while (pos >= 0) {
        stats.stringObjectRefs += 1;
        const qaddr = chunkBase + BigInt(pos);
        if (qaddr >= 0x10n) {
          const node = reader.readMemory(qaddr - 0x10n, 0x50);
          if (node !== undefined && node.byteLength >= 0x40) {
            //M 复核节点内保存的字符串指针与长度字段确实指向 Config.Cipher 类名。
            const strPtr = readU64LE(node, 0x10);
            const strLen = readU64LE(node, 0x18);
            const configPtr = readU64LE(node, 0x28);
            const validHeader = (
              needleAddresses.has(strPtr)
              && strLen === BigInt(WINDOWS_CONFIG_CIPHER_NAME.byteLength)
              && configPtr >= WINDOWS_MIN_USER_ADDRESS
              && configPtr < WINDOWS_MAX_USER_ADDRESS
            );
            if (validHeader) {
              stats.nodeCandidates += 1;
              seenConfigPtrs.add(configPtr);
              const obj = reader.readMemory(configPtr + 0x88n, 0x28);
              if (obj !== undefined && obj.byteLength >= 0x18) {
                const dataPtr = readU64LE(obj, 0x08);
                const dataLen = readU64LE(obj, 0x10);
                const validBlobRange = (
                  dataLen > 0n
                  && dataLen <= BigInt(WINDOWS_CONFIG_BLOB_MAX)
                  && dataPtr >= WINDOWS_MIN_USER_ADDRESS
                  && dataPtr < WINDOWS_MAX_USER_ADDRESS
                );
                if (validBlobRange) {
                  const byteLen = Number(dataLen);
                  const blob = reader.readMemory(dataPtr, byteLen);
                  if (blob !== undefined && blob.byteLength === byteLen) {
                    if (byteLen === 99) {
                      stats.blob99Count += 1;
                    }
                    //M 循环异或解码配置块并用数据库首页 HMAC 核验候选。
                    const candidates = decodeConfigCipherCandidates(blob);
                    for (const cand of candidates) {
                      const candKey = `${cand.encKeyHex}:${cand.embeddedSalt ?? ''}`;
                      if (seenCandidates.has(candKey)) {
                        continue;
                      }
                      seenCandidates.add(candKey);
                      stats.candidateCount += 1;
                      const matched = verifyCandidateAgainstSalts(
                        cand.encKeyHex,
                        cand.embeddedSalt,
                        collection,
                        keyMap,
                        remainingSalts,
                      );
                      if (matched > 0) {
                        stats.verifiedCandidates += 1;
                        stats.matchedSalts += matched;
                      }
                    }
                  }
                }
              }
            }
          }
        }
        pos = data.indexOf(pattern, pos + 1);
      }
    }
    return remainingSalts.size > 0;
  });

  stats.configPtrCandidates = seenConfigPtrs.size;
  return stats;
}


/**
 * 回退扫描进程可读内存中的原始 `x'<hex>'` SQLCipher 字面量并验证数据库首页。
 * @param reader 只读进程内存访问器。
 * @param collection 待匹配的数据库首页集合。
 * @param keyMap 输出已验证的 `saltHex -> encKeyHex` 映射。
 * @param remainingSalts 剩余未匹配盐值集合。
 * @returns 扫描期间命中的 `x'...'` 字面量总数。
 */
export function scanHexPatternsInMemory(
  reader: ProcessMemoryReader,
  collection: DbSaltCollection,
  keyMap: Map<string, string>,
  remainingSalts: Set<string>,
): number {
  if (remainingSalts.size === 0) return 0;

  let hexMatches = 0;
  forEachRegionChunk(reader, HEX_SCAN_CHUNK_BYTES, HEX_SCAN_OVERLAP_BYTES, (_chunkBase, data) => {
    if (remainingSalts.size === 0) return false;

    const text = data.toString('latin1');
    RAW_HEX_LITERAL_RE.lastIndex = 0;
    let match = RAW_HEX_LITERAL_RE.exec(text);
    while (match !== null) {
      const hexStr = (match[1] ?? '').toLowerCase();
      hexMatches += 1;
      const hexLen = hexStr.length;

      if (hexLen === 96) {
        const encKeyHex = hexStr.slice(0, 64);
        const saltHex = hexStr.slice(64, 96);
        if (remainingSalts.has(saltHex)) {
          //M 96 位字面量前 64 位是密钥、后 32 位是数据库盐值，定向验密最快。
          verifyCandidateAgainstSalts(encKeyHex, saltHex, collection, keyMap, remainingSalts);
        }
      }
      if (hexLen === 64 && remainingSalts.size > 0) {
        //M 64 位字面量不含内嵌盐值，依次与剩余未解开的数据库首页比对。
        verifyCandidateAgainstSalts(hexStr, undefined, collection, keyMap, remainingSalts);
      }
      if (hexLen > 96 && hexLen % 2 === 0) {
        const encKeyHex = hexStr.slice(0, 64);
        const saltHex = hexStr.slice(hexLen - 32);
        if (remainingSalts.has(saltHex)) {
          //M 超长偶数字面量按前 64 位密钥加末尾 32 位盐值核验。
          verifyCandidateAgainstSalts(encKeyHex, saltHex, collection, keyMap, remainingSalts);
        }
      }

      if (remainingSalts.size === 0) return false;

      match = RAW_HEX_LITERAL_RE.exec(text);
    }
    return remainingSalts.size > 0;
  });

  return hexMatches;
}


/**
 * 用已提取成功的密钥对尚未匹配的其余数据库盐值做交叉验证（覆盖同密钥异盐分库）。
 * @param collection 数据库首页盐值集合。
 * @param keyMap 已验证的 `saltHex -> encKeyHex` 映射（命中时原地补充）。
 * @returns 交叉验证新补齐的盐值数量。
 */
export function crossVerifySalts(
  collection: DbSaltCollection,
  keyMap: Map<string, string>,
): number {
  if (keyMap.size === 0) return 0;

  const knownKeys = [...new Set(keyMap.values())];
  let crossMatched = 0;

  for (const saltHex of collection.saltToDbs.keys()) {
    if (keyMap.has(saltHex)) {
      continue;
    }
    //M 取该未匹配盐值下的一份代表库首页用于交叉验密。
    const sample = collection.files.find((item) => item.saltHex === saltHex);
    if (sample === undefined) {
      continue;
    }
    for (const knownHex of knownKeys) {
      const keyBuf = Buffer.from(knownHex, 'hex');
      //M 核对已知主密钥是否同样能通过该分片库首页的 HMAC 校验。
      if (cryptoModule.verifyPage1Key(keyBuf, sample.page1)) {
        keyMap.set(saltHex, knownHex);
        crossMatched += 1;
        break;
      }
    }
  }
  return crossMatched;
}


/**
 * 从一组只读进程内存读取器中提取并验证账号下全部微信数据库的密钥（纯内存逻辑，离线单测可直接调用）。
 * @param collection 由 `collectDbSalts` 收集的数据库首页集合。
 * @param readers 待扫描的一个或多个进程内存访问器。
 */
export function extractKeysFromMemoryReaders(
  collection: DbSaltCollection,
  readers: readonly ProcessMemoryReader[],
): KeyScanSummary {
  const saltKeys = new Map<string, string>();
  const remainingSalts = new Set<string>(collection.saltToDbs.keys());
  const totalStats: ConfigCipherScanStats = {
    needleOccurrences: 0,
    stringObjectRefs: 0,
    nodeCandidates: 0,
    configPtrCandidates: 0,
    blob99Count: 0,
    candidateCount: 0,
    verifiedCandidates: 0,
    matchedSalts: 0,
  };
  let rawHexMatches = 0;

  for (const reader of readers) {
    if (remainingSalts.size === 0) {
      break;
    }
    //M 先跑微信 4.1+ Config.Cipher 指针链精准扫描。
    const stepStats = scanConfigCipherInMemory(reader, collection, saltKeys, remainingSalts);
    totalStats.needleOccurrences += stepStats.needleOccurrences;
    totalStats.stringObjectRefs += stepStats.stringObjectRefs;
    totalStats.nodeCandidates += stepStats.nodeCandidates;
    totalStats.configPtrCandidates += stepStats.configPtrCandidates;
    totalStats.blob99Count += stepStats.blob99Count;
    totalStats.candidateCount += stepStats.candidateCount;
    totalStats.verifiedCandidates += stepStats.verifiedCandidates;
    totalStats.matchedSalts += stepStats.matchedSalts;

    if (remainingSalts.size === 0) {
      break;
    }
    //M 若仍有未匹配盐值，回退扫描可读内存区里的原始 `x'...'` 模式。
    rawHexMatches += scanHexPatternsInMemory(reader, collection, saltKeys, remainingSalts);
  }

  //M 最后用已找到的密钥交叉核验剩余异盐分库。
  const crossVerifiedSalts = crossVerifySalts(collection, saltKeys);

  const keyTable: Record<string, cacheModule.KeyEntry> = {};
  const missingDbs: string[] = [];
  for (const item of collection.files) {
    const encKeyHex = saltKeys.get(item.saltHex);
    if (encKeyHex !== undefined) {
      keyTable[item.relPath] = {
        enc_key: encKeyHex,
        salt: item.saltHex,
        size_mb: Math.round((item.size / (1024 * 1024)) * 10) / 10,
      };
      continue;
    }
    //M 记录未能匹配到有效密钥的数据库相对路径。
    missingDbs.push(item.relPath);
  }

  return {
    saltKeys,
    keyTable,
    totalDbs: collection.files.length,
    matchedDbs: Object.keys(keyTable).length,
    missingDbs,
    configStats: totalStats,
    rawHexMatches,
    crossVerifiedSalts,
  };
}


/**
 * 将提取出的数据库密钥表以权限 0600 原子写入 `all_keys.json`。
 * @param outputPath 目标 JSON 文件路径。
 * @param keyTable 相对路径到密钥对象的映射表。
 */
export function writeAllKeysJson(
  outputPath: string,
  keyTable: Readonly<Record<string, cacheModule.KeyEntry>>,
): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const content = `${JSON.stringify(keyTable, null, 2)}\n`;
  const tempPath = `${outputPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, outputPath);
}


/**
 * 只在用户显式指定的根目录下发现含 `db_storage` 的微信账号目录（绝不全盘搜索其它磁盘）。
 * @param folder 用户指定的微信存储目录（如 `xwechat_files` 或其父目录）。
 */
export function discoverAccountDbDirs(folder: string): DiscoveredWechatAccount[] {
  if (folder.trim() === '' || !fs.existsSync(folder)) return [];

  let baseDir = path.resolve(folder);
  const nestedXwechat = path.join(baseDir, 'xwechat_files');
  const nestedStat = fs.statSync(nestedXwechat, { throwIfNoEntry: false });
  if (nestedStat?.isDirectory()) {
    baseDir = nestedXwechat;
  }

  //G 若用户直接传了单个账号目录（自身直接包含 db_storage），直接返回该账号。
  const directDb = path.join(baseDir, 'db_storage');
  if (fs.statSync(directDb, { throwIfNoEntry: false })?.isDirectory()) {
    const directId = `account_${crypto.createHash('sha256').update(directDb, 'utf8').digest('hex').slice(0, 12)}`;
    return [{ id: directId, folder: path.basename(baseDir), dbDir: directDb }];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const accounts: DiscoveredWechatAccount[] = [];
  const sortedDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dirName of sortedDirs) {
    const dbDir = path.join(baseDir, dirName, 'db_storage');
    if (!fs.statSync(dbDir, { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    const id = `account_${crypto.createHash('sha256').update(dbDir, 'utf8').digest('hex').slice(0, 12)}`;
    //M 将包含 db_storage 的有效微信账号目录加入发现列表。
    accounts.push({ id, folder: dirName, dbDir });
  }
  return accounts;
}


/**
 * 按需打开 `psapi.dll` 与 `kernel32.dll` 枚举正在运行的 `Weixin.exe` 进程 PID 列表。
 * 仅在 `scanWindowsWechatKeys` 内惰性调用，不在模块加载或日常轮询阶段触碰任何系统 DLL。
 */
function openWindowsApi() {
  const psapi = ffi.dlopen('psapi.dll', {
    EnumProcesses: {
      args: [ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.ptr],
      returns: ffi.FFIType.i32,
    },
  });

  const kernel32 = ffi.dlopen('kernel32.dll', {
    OpenProcess: {
      args: [ffi.FFIType.u32, ffi.FFIType.i32, ffi.FFIType.u32],
      returns: ffi.FFIType.u64,
    },
    CloseHandle: {
      args: [ffi.FFIType.u64],
      returns: ffi.FFIType.i32,
    },
    QueryFullProcessImageNameW: {
      args: [ffi.FFIType.u64, ffi.FFIType.u32, ffi.FFIType.ptr, ffi.FFIType.ptr],
      returns: ffi.FFIType.i32,
    },
    VirtualQueryEx: {
      args: [ffi.FFIType.u64, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.u64],
      returns: ffi.FFIType.u64,
    },
    ReadProcessMemory: {
      args: [ffi.FFIType.u64, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.u64, ffi.FFIType.ptr],
      returns: ffi.FFIType.i32,
    },
  });

  return { psapi, kernel32 };
}


/**
 * 通过已打开的 Win32 API 枚举全部正在运行的 `Weixin.exe` 进程 PID（不启动 tasklist/wmic 等外部命令）。
 * @param api 由 `openWindowsApi` 打开的动态库句柄对。
 */
function listWeixinPids(api: ReturnType<typeof openWindowsApi>): number[] {
  const maxPids = 16_384;
  const pidsBuf = new Uint32Array(maxPids);
  const neededBuf = new Uint32Array(1);
  const ok = api.psapi.symbols.EnumProcesses(
    ffi.ptr(pidsBuf),
    pidsBuf.byteLength,
    ffi.ptr(neededBuf),
  );
  if (ok === 0) {
    throw new Error('无法枚举本机进程列表');
  }

  const count = Math.min(maxPids, Math.floor((neededBuf[0] ?? 0) / 4));
  const nameUtf16 = new Uint16Array(32_768);
  const lenBuf = new Uint32Array(1);
  const matchedPids: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const pid = pidsBuf[index] ?? 0;
    if (pid === 0) {
      continue;
    }
    const handle = api.kernel32.symbols.OpenProcess(WIN32_PROCESS_QUERY_LIMITED_INFO, 0, pid);
    if (handle === 0n) {
      continue;
    }
    try {
      lenBuf[0] = nameUtf16.length;
      const queried = api.kernel32.symbols.QueryFullProcessImageNameW(
        handle,
        0,
        ffi.ptr(nameUtf16),
        ffi.ptr(lenBuf),
      );
      if (queried !== 0) {
        const charLen = lenBuf[0] ?? 0;
        const exePath = Buffer.from(nameUtf16.buffer, 0, charLen * 2).toString('utf16le');
        const baseName = path.win32.basename(exePath).toLowerCase();
        if (baseName === 'weixin.exe') {
          //M 收集确认镜像名为 Weixin.exe 的进程 PID。
          matchedPids.push(pid);
        }
      }
    } finally {
      api.kernel32.symbols.CloseHandle(handle);
    }
  }

  return matchedPids;
}


/**
 * 枚举目标进程内全部已提交且可读的用户态虚拟内存区域。
 * @param api 已打开的 Win32 API。
 * @param processHandle 具备 PROCESS_QUERY_INFORMATION 权限的进程句柄。
 */
function enumReadableProcessRegions(
  api: ReturnType<typeof openWindowsApi>,
  processHandle: bigint,
): MemoryRegion[] {
  const regions: MemoryRegion[] = [];
  const mbiBuf = Buffer.alloc(WIN64_MBI_BYTES);
  let addr = 0n;

  while (addr < WINDOWS_REGION_SCAN_LIMIT) {
    const retBytes = api.kernel32.symbols.VirtualQueryEx(
      processHandle,
      addr,
      ffi.ptr(mbiBuf),
      BigInt(WIN64_MBI_BYTES),
    );
    if (retBytes === 0n) {
      break;
    }

    const baseAddress = mbiBuf.readBigUInt64LE(0);
    const regionSize = mbiBuf.readBigUInt64LE(24);
    const state = mbiBuf.readUInt32LE(32);
    const protect = mbiBuf.readUInt32LE(36);

    const isReadable = (
      state === WIN32_MEM_COMMIT
      && WIN32_READABLE_PROTECT.has(protect)
      && regionSize > 0n
      && regionSize < MAX_SINGLE_REGION_BYTES
    );
    if (isReadable) {
      //M 记录当前已提交且具备可读属性的用户态内存区。
      regions.push({ base: baseAddress, size: Number(regionSize) });
    }

    const nextAddr = baseAddress + regionSize;
    if (nextAddr <= addr) {
      break;
    }
    addr = nextAddr;
  }

  return regions;
}


/**
 * 按需在 Windows 本机扫描正在运行的 `Weixin.exe` 进程内存，提取并验真微信数据库密钥后写入 `all_keys.json`。
 * 严禁在常规消息轮询期间调用；仅由用户显式发起 `--connect` 初始化或换号重连时执行一次。
 * @param dbDir 微信账号的 `db_storage` 目录路径。
 * @param outputPath 验证通过的密钥输出文件路径（`all_keys.json`）。
 * @param targetPid 可选指定单个微信进程 PID；省略时自动查找全部 `Weixin.exe`。
 */
export function scanWindowsWechatKeys(
  dbDir: string,
  outputPath: string,
  targetPid?: number,
): KeyScanSummary {
  if (process.platform !== 'win32') {
    throw new Error('微信进程内存密钥提取仅支持在 Windows 本机执行');
  }

  //M 先收集磁盘上待解锁数据库的首页与盐值，无加密库时直接报错返回。
  const collection = collectDbSalts(dbDir);
  if (collection.files.length === 0) {
    throw new Error('指定目录未找到待解密的微信加密数据库');
  }

  //M 惰性打开 Win32 系统 DLL，用完立即在 finally 关闭释放。
  const api = openWindowsApi();
  const openedHandles: bigint[] = [];
  try {
    let pids: number[] = [];
    if (targetPid !== undefined) {
      pids = [targetPid];
    }
    if (targetPid === undefined) {
      //M 枚举全部正在运行的 Weixin.exe 进程。
      pids = listWeixinPids(api);
    }
    if (pids.length === 0) {
      throw new Error('没有找到正在运行的微信（Weixin.exe），请先登录电脑微信');
    }

    const readers: ProcessMemoryReader[] = [];
    const bytesReadBuf = new BigUint64Array(1);
    for (const pid of pids) {
      const handle = api.kernel32.symbols.OpenProcess(WIN32_PROCESS_READ_QUERY, 0, pid);
      if (handle === 0n) {
        continue;
      }
      //M 登记已打开的进程句柄，确保 finally 统一关闭不泄漏。
      openedHandles.push(handle);
      //M 收集该进程的可读虚拟内存区域并封装只读读取回调。
      const regions = enumReadableProcessRegions(api, handle);
      readers.push({
        pid,
        regions,
        readMemory(address: bigint, length: number): Buffer | undefined {
          if (length <= 0) return undefined;

          const out = Buffer.allocUnsafe(length);
          bytesReadBuf[0] = 0n;
          const ok = api.kernel32.symbols.ReadProcessMemory(
            handle,
            address,
            ffi.ptr(out),
            BigInt(length),
            ffi.ptr(bytesReadBuf),
          );
          if (ok === 0) return undefined;

          const actual = Number(bytesReadBuf[0] ?? 0n);
          if (actual <= 0) return undefined;

          if (actual === length) return out;

          return Buffer.from(out.subarray(0, actual));
        },
      });
    }

    if (readers.length === 0) {
      throw new Error('无法以只读权限打开微信进程内存，请确认与微信同权限运行');
    }

    //M 执行 Config.Cipher 指针链扫描 + 原始 hex 回退 + 跨盐交叉验证。
    const summary = extractKeysFromMemoryReaders(collection, readers);
    if (summary.matchedDbs === 0) {
      throw new Error('未能从正在运行的微信进程中匹配到当前账号的数据库密钥');
    }

    //M 将验证通过的密钥表原子写入目标 all_keys.json。
    writeAllKeysJson(outputPath, summary.keyTable);
    return summary;
  } finally {
    for (const handle of openedHandles) {
      api.kernel32.symbols.CloseHandle(handle);
    }
    //M 扫描结束后立即卸载临时打开的 Win32 动态库句柄。
    api.kernel32.close();
    //M 同步关闭进程枚举动态库句柄。
    api.psapi.close();
  }
}
