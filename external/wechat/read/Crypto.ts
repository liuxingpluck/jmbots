/**
 * 微信 4.x（WCDB / SQLCipher 4）纯 Bun 数据库页解密、首页 HMAC 验密与 WAL 帧合并。
 * 由 DbCache 和未来的本机密钥扫描器调用；全程只读源数据库与 -wal，把明文页写入本插件自有的缓存副本。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 微信 4.x SQLCipher 数据库的固定页大小，单位字节。 */
export const PAGE_SIZE = 4096;

/** 数据库 AES-256 加密密钥字节数。 */
export const KEY_SIZE = 32;

/** 第 1 页头部的数据库盐值字节数。 */
export const SALT_SIZE = 16;

/** 每页末尾保留区字节数：16 字节 IV 加 64 字节 HMAC-SHA512。 */
export const RESERVE_SIZE = 80;

/** AES-256-CBC 初始化向量字节数。 */
export const IV_SIZE = 16;

/** SQLCipher 4 页尾 HMAC-SHA512 摘要字节数。 */
export const HMAC_SIZE = 64;

/** SQLite WAL 文件头固定字节数。 */
export const WAL_HEADER_SIZE = 32;

/** SQLite WAL 单帧头部固定字节数。 */
export const WAL_FRAME_HEADER_SIZE = 24;

/** WAL 允许回写的最大合理页号，防止坏帧把副本文件撑出稀疏巨洞。 */
const MAX_WAL_PAGE = 1_000_000;

/** 标准明文 SQLite 3 文件的 16 字节魔数头。 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');


/**
 * 根据数据库首页 16 字节 salt 派生 SQLCipher 4 的 HMAC-SHA512 校验密钥。
 * @param encKey 32 字节数据库加密主密钥。
 * @param salt 数据库第 1 页前 16 字节的原始盐值。
 * @returns 32 字节 MAC 密钥。
 */
export function deriveMacKey(encKey: Uint8Array, salt: Uint8Array): Buffer {
  //M SQLCipher 4 对文件盐逐字节异或 0x3a 后跑 2 轮 PBKDF2-HMAC-SHA512。
  const macSalt = Buffer.allocUnsafe(SALT_SIZE);
  for (let index = 0; index < SALT_SIZE; index += 1) {
    macSalt[index] = (salt[index] ?? 0) ^ 0x3a;
  }
  return crypto.pbkdf2Sync(encKey, macSalt, 2, KEY_SIZE, 'sha512');
}


/**
 * 计算单页加密数据（含 16 字节 IV 与小端页号）的 SQLCipher 4 HMAC-SHA512 摘要。
 * @param macKey 由 deriveMacKey 派生的 32 字节 MAC 密钥。
 * @param pageData 完整的 4096 字节加密页。
 * @param pageNo 从 1 开始的数据库页号。
 * @returns 64 字节 HMAC-SHA512 摘要。
 */
export function computePageHmac(macKey: Uint8Array, pageData: Uint8Array, pageNo: number): Buffer {
  //M 第 1 页跳过前 16 字节明文 salt，其余页从偏移 0 起算，均覆盖密文与 16 字节 IV。
  let startOffset = 0;
  if (pageNo === 1) {
    startOffset = SALT_SIZE;
  }
  const hmacEnd = PAGE_SIZE - RESERVE_SIZE + IV_SIZE;
  const payload = pageData.subarray(startOffset, hmacEnd);
  const pageFooter = Buffer.allocUnsafe(4);
  pageFooter.writeUInt32LE(pageNo, 0);

  //M 按密文区段加 4 字节小端页号的顺序送入 HMAC-SHA512。
  const hmac = crypto.createHmac('sha512', macKey);
  hmac.update(payload);
  hmac.update(pageFooter);
  return hmac.digest();
}


/**
 * 用数据库第 1 页的 HMAC-SHA512 校验 32 字节密钥是否与该加密库匹配。
 * @param encKey 待验证的 32 字节加密密钥。
 * @param page1 数据库前 4096 字节原始数据。
 * @returns 密钥与首页完全匹配时为 true，长度不对或验签不过为 false。
 */
export function verifyPage1Key(encKey: Uint8Array, page1: Uint8Array): boolean {
  //G 密钥或首页长度不足时直接判无效，避免向密码学原语送残缺切片。
  if (encKey.byteLength !== KEY_SIZE || page1.byteLength < PAGE_SIZE) return false;

  //M 取出首页盐值派生 MAC 密钥，再与页尾保存的 64 字节签名做定长比对。
  const salt = page1.subarray(0, SALT_SIZE);
  const macKey = deriveMacKey(encKey, salt);
  const expected = computePageHmac(macKey, page1, 1);
  const stored = page1.subarray(PAGE_SIZE - HMAC_SIZE, PAGE_SIZE);
  return crypto.timingSafeEqual(expected, stored);
}


/**
 * 把一页 SQLCipher 4 加密数据解密成标准 4096 字节明文 SQLite 页。
 * @param encKey 32 字节数据库加密密钥。
 * @param pageData 单页加密字节（不足 4096 字节时按零补齐后再解）。
 * @param pageNo 从 1 开始的页号；第 1 页自动还原 SQLite 文件头。
 * @returns 4096 字节标准 SQLite 明文页（末尾 80 字节保留区置零）。
 */
export function decryptPage(encKey: Uint8Array, pageData: Uint8Array, pageNo: number): Buffer {
  //G 尾页偶有不足一整页的输入时先补零对齐 4096 字节，保证 CBC 块长度整除 16。
  let fullPage = pageData;
  if (pageData.byteLength < PAGE_SIZE) {
    const padded = Buffer.alloc(PAGE_SIZE);
    padded.set(pageData.subarray(0, pageData.byteLength), 0);
    fullPage = padded;
  }

  //M 从保留区起始处取出 16 字节 IV，关闭 PKCS7 自动填充按原始块解密。
  const ivOffset = PAGE_SIZE - RESERVE_SIZE;
  const iv = fullPage.subarray(ivOffset, ivOffset + IV_SIZE);
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  decipher.setAutoPadding(false);

  //M 输出缓冲区预先置零，末尾 80 字节保留区天然为零填充。
  const output = Buffer.alloc(PAGE_SIZE);
  if (pageNo === 1) {
    //M 第 1 页前 16 字节是文件 salt，解密中间 4000 字节后拼回标准 SQLite 魔数头。
    const encryptedFirst = fullPage.subarray(SALT_SIZE, ivOffset);
    const partA = decipher.update(encryptedFirst);
    const partB = decipher.final();
    SQLITE_HEADER.copy(output, 0);
    partA.copy(output, SALT_SIZE);
    partB.copy(output, SALT_SIZE + partA.byteLength);
    return output;
  }

  //M 第 2 页起从偏移 0 到 4016 共 251 个整块全部是 AES-256-CBC 密文。
  const encryptedBody = fullPage.subarray(0, ivOffset);
  const bodyA = decipher.update(encryptedBody);
  const bodyB = decipher.final();
  bodyA.copy(output, 0);
  bodyB.copy(output, bodyA.byteLength);
  return output;
}


/**
 * 修正独立明文 SQLite 副本首页头部：
 * 1. 将 WAL 模式标志（偏移 18/19 的 2）归位为普通日志模式 1，避免只读打开副本时寻找伴生 -shm/-wal；
 * 2. 当 WAL 追加了超出主库原总页数的新页（如新建群表）而未重写第 1 页时，同步放大偏移 28..31 的库总页数，
 *    防止 SQLite 3.7+ 按旧页数截断而将新表根页判为 SQLITE_CORRUPT。
 * @returns 若放大了偏移 28..31 的库页数则返回 true（提示增量缓存将第 1 页纳入下次还原集合）。
 */
function syncReplicaHeader(fd: number): boolean {
  const fileSize = fs.fstatSync(fd).size;
  const actualPages = Math.floor(fileSize / PAGE_SIZE);
  if (actualPages < 1) return false;

  const header = Buffer.allocUnsafe(32);
  const readBytes = fs.readSync(fd, header, 0, 32, 0);
  if (readBytes < 32) return false;
  if (header.subarray(0, 15).toString('ascii') !== 'SQLite format 3') return false;

  let dirty = false;
  let grewHeaderPages = false;
  if (header[18] === 2 || header[19] === 2) {
    header[18] = 1;
    header[19] = 1;
    dirty = true;
  }
  const inHeaderPages = header.readUInt32BE(28);
  if (inHeaderPages > 0 && actualPages > inHeaderPages) {
    header.writeUInt32BE(actualPages, 28);
    dirty = true;
    grewHeaderPages = true;
  }
  if (dirty) {
    fs.writeSync(fd, header, 0, 32, 0);
  }
  return grewHeaderPages;
}


/**
 * 将整个 SQLCipher 4 加密数据库逐页解密写出为明文 SQLite 文件。
 * @param dbPath 源加密 .db 文件路径（只读打开）。
 * @param outPath 目标明文 SQLite 副本路径（覆盖写出）。
 * @param encKey 32 字节数据库加密密钥。
 * @returns 实际解密写出的整页数量。
 * 副作用：创建 outPath 父目录并覆写 outPath。
 */
export function decryptDatabaseFile(dbPath: string, outPath: string, encKey: Uint8Array): number {
  const fileSize = fs.statSync(dbPath).size;
  const totalPages = Math.floor(fileSize / PAGE_SIZE);
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });

  //M 用固定 4096 字节缓冲区顺序流式读出并解密写回，几百 MB 大库也不占峰值内存。
  const fin = fs.openSync(dbPath, 'r');
  const fout = fs.openSync(outPath, 'w+');
  const pageBuffer = Buffer.allocUnsafe(PAGE_SIZE);
  let writtenPages = 0;
  try {
    for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
      const fileOffset = (pageNo - 1) * PAGE_SIZE;
      const bytesRead = fs.readSync(fin, pageBuffer, 0, PAGE_SIZE, fileOffset);
      if (bytesRead <= 0) {
        break;
      }
      if (bytesRead < PAGE_SIZE) {
        pageBuffer.fill(0, bytesRead, PAGE_SIZE);
      }
      //M 逐页解密后按相同页偏移写进明文副本。
      const plainPage = decryptPage(encKey, pageBuffer, pageNo);
      fs.writeSync(fout, plainPage, 0, PAGE_SIZE, fileOffset);
      writtenPages += 1;
    }
    syncReplicaHeader(fout);
  } finally {
    fs.closeSync(fin);
    fs.closeSync(fout);
  }
  return writtenPages;
}


/**
 * 把加密 -wal 文件中属于当前检查点代次（salt1/salt2 一致）的完整帧解密覆盖进明文副本。
 * 末尾尚未提交或尚未刷完的半截帧自动忽略，并在扩页后同步修正首页页数头。
 * @param walPath 源 .db-wal 文件路径（不存在或为空时直接返回空数组）。
 * @param outPath 已存在的目标明文 SQLite 副本路径（按页原地覆写）。
 * @param encKey 32 字节数据库加密密钥。
 * @returns 本次实际打进明文副本的升序去重页号列表。
 * 副作用：原地更新 outPath 对应页。
 */
export function applyWalFrames(walPath: string, outPath: string, encKey: Uint8Array): number[] {
  if (!fs.existsSync(walPath)) return [];

  const walSize = fs.statSync(walPath).size;
  if (walSize <= WAL_HEADER_SIZE) return [];

  const wf = fs.openSync(walPath, 'r');
  const df = fs.openSync(outPath, 'r+');
  const walHeader = Buffer.allocUnsafe(WAL_HEADER_SIZE);
  const frameHeader = Buffer.allocUnsafe(WAL_FRAME_HEADER_SIZE);
  const encPage = Buffer.allocUnsafe(PAGE_SIZE);
  const patchedPages = new Set<number>();
  try {
    const headerBytes = fs.readSync(wf, walHeader, 0, WAL_HEADER_SIZE, 0);
    if (headerBytes < WAL_HEADER_SIZE) return [];

    //M WAL 头部 16..24 字节存放本代两个大端 32 位 salt，换代残留的旧帧靠它筛除。
    const walSalt1 = walHeader.readUInt32BE(16);
    const walSalt2 = walHeader.readUInt32BE(20);
    const frameStride = WAL_FRAME_HEADER_SIZE + PAGE_SIZE;

    //M 先轻扫帧头定位最后一个已提交事务边界（commitDbSize > 0）；若全为 0 则兼容合成测试帧。
    let lastCommitOffset = -1;
    for (let offset = WAL_HEADER_SIZE; offset + frameStride <= walSize; offset += frameStride) {
      const fhRead = fs.readSync(wf, frameHeader, 0, WAL_FRAME_HEADER_SIZE, offset);
      if (fhRead < WAL_FRAME_HEADER_SIZE) {
        break;
      }
      const pageNo = frameHeader.readUInt32BE(0);
      const commitPages = frameHeader.readUInt32BE(4);
      const fSalt1 = frameHeader.readUInt32BE(8);
      const fSalt2 = frameHeader.readUInt32BE(12);
      if (pageNo > 0 && pageNo <= MAX_WAL_PAGE && fSalt1 === walSalt1 && fSalt2 === walSalt2 && commitPages > 0) {
        lastCommitOffset = offset;
      }
    }

    //M 只遍历到最后一个完整（且已提交）帧边界，微信并发追加留下的未提交尾帧自动跳过。
    for (let offset = WAL_HEADER_SIZE; offset + frameStride <= walSize; offset += frameStride) {
      if (lastCommitOffset >= 0 && offset > lastCommitOffset) {
        break;
      }
      const fhRead = fs.readSync(wf, frameHeader, 0, WAL_FRAME_HEADER_SIZE, offset);
      if (fhRead < WAL_FRAME_HEADER_SIZE) {
        break;
      }
      const pageOffset = offset + WAL_FRAME_HEADER_SIZE;
      const epRead = fs.readSync(wf, encPage, 0, PAGE_SIZE, pageOffset);
      if (epRead < PAGE_SIZE) {
        break;
      }

      const pageNo = frameHeader.readUInt32BE(0);
      const frameSalt1 = frameHeader.readUInt32BE(8);
      const frameSalt2 = frameHeader.readUInt32BE(12);
      //G 排除非法页号以及上一轮 checkpoint 残留在文件后半段的旧代次帧。
      if (pageNo === 0 || pageNo > MAX_WAL_PAGE) {
        continue;
      }
      if (frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) {
        continue;
      }

      //M 同页在 WAL 里多次出现时按时间顺序后写盖前写，最终保留最新提交页。
      const plainPage = decryptPage(encKey, encPage, pageNo);
      const targetOffset = (pageNo - 1) * PAGE_SIZE;
      fs.writeSync(df, plainPage, 0, PAGE_SIZE, targetOffset);
      patchedPages.add(pageNo);
    }

    if (patchedPages.size > 0) {
      const grewHeader = syncReplicaHeader(df);
      if (grewHeader) {
        patchedPages.add(1);
      }
    }
  } finally {
    fs.closeSync(wf);
    fs.closeSync(df);
  }

  return [...patchedPages].sort((left, right) => left - right);
}
