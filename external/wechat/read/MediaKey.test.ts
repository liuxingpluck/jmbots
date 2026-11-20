/**
 * P2 纯 Bun 图片 .dat 解密、语音媒体库直提转 WAV、以及按需内存密钥扫描器的全离线合成单测。
 * 全程使用现场合成的图片、正弦波 SILK、SQLCipher 4 加密库与虚拟内存缓冲区，绝不触碰真实微信进程或个人数据。
 */
import * as sqlite from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as silk from 'silk-wasm';
import * as cryptoModule from './Crypto.ts';
import * as cacheModule from './DbCache.ts';
import * as keyScanModule from './KeyScan.ts';
import * as mediaDatModule from './MediaDat.ts';
import * as voiceModule from './VoiceExtract.ts';


const tempDirs: string[] = [];

/**
 * 创建单测专属临时目录并纳入自动清理列表。
 */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-wx-p2-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});


/**
 * 创建末尾保留 80 字节（与微信 4.x WCDB / SQLCipher 4 页布局一致）的明文 SQLite 库。
 */
function buildReservedPlainDb(filePath: string, populate: (db: sqlite.Database) => void): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  {
    const initDb = new sqlite.Database(filePath);
    initDb.exec('PRAGMA journal_mode = DELETE; PRAGMA page_size = 4096; CREATE TABLE _seed(x); DROP TABLE _seed;');
    initDb.close();
  }
  const page1 = fs.readFileSync(filePath);
  page1[20] = cryptoModule.RESERVE_SIZE;
  page1.writeUInt16BE(cryptoModule.PAGE_SIZE - cryptoModule.RESERVE_SIZE, 105);
  page1.fill(0, cryptoModule.PAGE_SIZE - cryptoModule.RESERVE_SIZE, cryptoModule.PAGE_SIZE);
  fs.writeFileSync(filePath, page1);

  const db = new sqlite.Database(filePath);
  try {
    populate(db);
  } finally {
    db.close();
  }
}


/**
 * 按 SQLCipher 4 页格式将明文 SQLite 文件逐页加密（AES-256-CBC + HMAC-SHA512）。
 */
function encryptSqliteFile(
  plainPath: string,
  encryptedPath: string,
  encKey: Uint8Array,
  salt: Uint8Array,
): void {
  const raw = fs.readFileSync(plainPath);
  const totalPages = Math.floor(raw.byteLength / cryptoModule.PAGE_SIZE);
  const out = Buffer.allocUnsafe(totalPages * cryptoModule.PAGE_SIZE);
  const ivOffset = cryptoModule.PAGE_SIZE - cryptoModule.RESERVE_SIZE;
  const macKey = cryptoModule.deriveMacKey(encKey, salt);

  for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
    const start = (pageNo - 1) * cryptoModule.PAGE_SIZE;
    const plainPage = raw.subarray(start, start + cryptoModule.PAGE_SIZE);
    const iv = crypto.createHash('md5').update(plainPage).update(String(pageNo)).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
    cipher.setAutoPadding(false);

    const encPage = Buffer.alloc(cryptoModule.PAGE_SIZE);
    if (pageNo === 1) {
      Buffer.from(salt).copy(encPage, 0, 0, cryptoModule.SALT_SIZE);
      const body = plainPage.subarray(cryptoModule.SALT_SIZE, ivOffset);
      const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
      encrypted.copy(encPage, cryptoModule.SALT_SIZE);
    }
    if (pageNo !== 1) {
      const body = plainPage.subarray(0, ivOffset);
      const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
      encrypted.copy(encPage, 0);
    }
    iv.copy(encPage, ivOffset);
    const mac = cryptoModule.computePageHmac(macKey, encPage, pageNo);
    mac.copy(encPage, ivOffset + cryptoModule.IV_SIZE);
    encPage.copy(out, start);
  }

  fs.mkdirSync(path.dirname(encryptedPath), { recursive: true });
  fs.writeFileSync(encryptedPath, out);
}


/**
 * 生成一份合成的微信 4.x V2 / V1 加密 `.dat` 缓冲（15 字节头 + AES-128-ECB(PKCS7) + 单字节 XOR 尾部）。
 */
function encryptSyntheticV2Dat(
  plainImage: Uint8Array,
  aesKey: Uint8Array,
  xorKey: number,
  xorTailLength: number,
  magic: Uint8Array = mediaDatModule.V2_MAGIC,
): Buffer {
  const headLen = plainImage.byteLength - xorTailLength;
  const headSlice = plainImage.subarray(0, headLen);
  const tailSlice = plainImage.subarray(headLen);

  const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
  cipher.setAutoPadding(true);
  const encryptedHead = Buffer.concat([cipher.update(headSlice), cipher.final()]);

  const maskedTail = Buffer.allocUnsafe(tailSlice.byteLength);
  const mask = xorKey & 0xff;
  for (let i = 0; i < tailSlice.byteLength; i += 1) {
    maskedTail[i] = tailSlice[i]! ^ mask;
  }

  const header = Buffer.alloc(15);
  Buffer.from(magic).copy(header, 0);
  header.writeUInt32LE(encryptedHead.byteLength, 6);
  header.writeUInt32LE(maskedTail.byteLength, 10);
  header[14] = 0x01;
  return Buffer.concat([header, encryptedHead, maskedTail]);
}


/**
 * 对任意字节数组做整文件单字节异或（模拟老版微信 3.x `.dat`）。
 */
function maskWholeBufferXor(plain: Uint8Array, xorKey: number): Buffer {
  const out = Buffer.allocUnsafe(plain.byteLength);
  for (let i = 0; i < plain.byteLength; i += 1) {
    out[i] = plain[i]! ^ (xorKey & 0xff);
  }
  return out;
}


test('MediaDat：微信 3.x 单字节 XOR 解密各主流图片格式，并严格区分 RIFF WEBP 与 WAV 音频', () => {
  const fakeJpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    crypto.randomBytes(48),
    Buffer.from([0xff, 0xd9]),
  ]);
  const fakePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crypto.randomBytes(40),
  ]);
  const fakeGif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), crypto.randomBytes(32)]);
  const fakeWebp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    crypto.randomBytes(28),
  ]);
  const fakeWav = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WAVE', 'ascii'),
    crypto.randomBytes(28),
  ]);

  const jpegRes = mediaDatModule.decryptDatBuffer(maskWholeBufferXor(fakeJpeg, 0x5a));
  expect(jpegRes?.mime).toBe('image/jpeg');
  expect(jpegRes?.data.equals(fakeJpeg)).toBe(true);

  const pngRes = mediaDatModule.decryptDatBuffer(maskWholeBufferXor(fakePng, 0xa3));
  expect(pngRes?.mime).toBe('image/png');
  expect(pngRes?.data.equals(fakePng)).toBe(true);

  const gifRes = mediaDatModule.decryptDatBuffer(maskWholeBufferXor(fakeGif, 0x1f));
  expect(gifRes?.mime).toBe('image/gif');
  expect(gifRes?.data.equals(fakeGif)).toBe(true);

  const webpRes = mediaDatModule.decryptDatBuffer(maskWholeBufferXor(fakeWebp, 0x77));
  expect(webpRes?.mime).toBe('image/webp');
  expect(webpRes?.data.equals(fakeWebp)).toBe(true);

  // RIFF WAVE 音频绝不能被误判或解成 WebP 图片。
  expect(mediaDatModule.sniffImageMime(fakeWav)).toBe('application/octet-stream');
  expect(mediaDatModule.decryptXorDat(maskWholeBufferXor(fakeWav, 0x33))).toBeUndefined();
});


test('MediaDat：微信 4.x V2/V1 解密、UIN 文件名派生、image_key.json 持久化与按会话哈希缩略图定位', () => {
  const root = makeTempDir();
  const wxAccountDir = path.join(root, 'wxid_synthetic_9f8e');
  const dbDir = path.join(wxAccountDir, 'db_storage');
  const statsDir = path.join(wxAccountDir, 'config');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(statsDir, { recursive: true });

  const realUin = 246813579;
  // 放入无关候选 UIN、真实 UIN 文件名，以及位于 msg/attach 跳过目录内的诱饵文件名。
  fs.writeFileSync(path.join(statsDir, '11223344.ini'), '');
  fs.writeFileSync(path.join(statsDir, `key_${String(realUin)}_report.statistic`), '');
  const attachIgnoredDir = path.join(wxAccountDir, 'msg', 'attach', 'noise');
  fs.mkdirSync(attachIgnoredDir, { recursive: true });
  fs.writeFileSync(path.join(attachIgnoredDir, 'key_99999999_ignored.statistic'), '');

  const uinList = mediaDatModule.collectUinCandidates(wxAccountDir);
  expect(uinList).toContain(realUin);
  expect(uinList).toContain(11223344);
  expect(uinList).not.toContain(99999999);

  // 微信 4.x 派生密钥时使用剥除随机后缀的基础 wxid。
  const keyInfo = mediaDatModule.deriveV2ImageKeys(realUin, 'wxid_synthetic');
  const plainJpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x18]),
    crypto.randomBytes(90),
    Buffer.from([0xff, 0xd9]),
  ]);
  const plainPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crypto.randomBytes(64),
  ]);

  const v2JpegBytes = encryptSyntheticV2Dat(plainJpeg, keyInfo.aesKey, keyInfo.xorKey, 12, mediaDatModule.V2_MAGIC);
  const v1PngBytes = encryptSyntheticV2Dat(plainPng, keyInfo.aesKey, keyInfo.xorKey, 7, mediaDatModule.V1_MAGIC);

  // 布局会话 A 与会话 B 的附件目录，验证只读会话隔离。
  const chatA = 'wxid_customer_alpha';
  const chatB = 'wxid_customer_beta';
  const hashA = crypto.createHash('md5').update(chatA, 'utf8').digest('hex');
  const hashB = crypto.createHash('md5').update(chatB, 'utf8').digest('hex');
  const md5Jpeg = crypto.createHash('md5').update(plainJpeg).digest('hex');
  const md5Png = crypto.createHash('md5').update(plainPng).digest('hex');
  const md5OtherChat = 'fedcba9876543210fedcba9876543210';

  const imgDirA = path.join(wxAccountDir, 'msg', 'attach', hashA, '2026-11', 'Img');
  const imgDirACrossMonth = path.join(wxAccountDir, 'msg', 'attach', hashA, '2026-10', 'Img');
  const imgDirB = path.join(wxAccountDir, 'msg', 'attach', hashB, '2026-11', 'Img');
  fs.mkdirSync(imgDirA, { recursive: true });
  fs.mkdirSync(imgDirACrossMonth, { recursive: true });
  fs.mkdirSync(imgDirB, { recursive: true });

  const thumbPathA = path.join(imgDirA, `${md5Jpeg}_t.dat`);
  const fullPathA = path.join(imgDirA, `${md5Jpeg}.dat`);
  const crossMonthV1Path = path.join(imgDirACrossMonth, `${md5Png}_t.dat`);
  const otherChatPath = path.join(imgDirB, `${md5OtherChat}_t.dat`);
  fs.writeFileSync(thumbPathA, v2JpegBytes);
  fs.writeFileSync(fullPathA, v2JpegBytes);
  fs.writeFileSync(crossMonthV1Path, v1PngBytes);
  fs.writeFileSync(otherChatPath, v2JpegBytes);

  const novTimestamp = Math.floor(new Date('2026-11-15T12:00:00Z').getTime() / 1000);
  expect(mediaDatModule.findImageDatPath(dbDir, chatA, novTimestamp, [md5Jpeg], true)).toBe(thumbPathA);
  expect(mediaDatModule.findImageDatPath(dbDir, chatA, novTimestamp, [md5Jpeg], false)).toBe(fullPathA);
  // 跨月归档（时间戳在 11 月但图片落在 10 月目录）在本会话目录内可兜底找到。
  expect(mediaDatModule.findImageDatPath(dbDir, chatA, novTimestamp, [md5Png], true)).toBe(crossMonthV1Path);
  // 严禁跨会话读取另一聊天的图片 MD5。
  expect(mediaDatModule.findImageDatPath(dbDir, chatA, novTimestamp, [md5OtherChat], true)).toBeUndefined();

  // 无密钥且无 UIN 搜索目录时应明确返回 need_image_key。
  const missingKeyRes = mediaDatModule.decryptImageDatFile(thumbPathA, {});
  expect(missingKeyRes).toEqual({ ok: false, code: 'need_image_key' });

  // 传入带随机后缀的目录名与 searchRoots，自动枚举 UIN 派生并写出 image_key.json。
  const keyCachePath = path.join(root, 'state', 'image_key.json');
  const firstDec = mediaDatModule.decryptImageDatFile(thumbPathA, {
    keyFilePath: keyCachePath,
    accountName: 'wxid_synthetic_9f8e',
    searchRoots: [wxAccountDir],
  });
  expect(firstDec.ok).toBe(true);
  if (firstDec.ok) {
    expect(firstDec.image.mime).toBe('image/jpeg');
    expect(firstDec.image.data.equals(plainJpeg)).toBe(true);
  }
  expect(fs.existsSync(keyCachePath)).toBe(true);

  // 清空 UIN 统计目录后，单靠已持久化的 image_key.json 即可同时解开 V2 与 V1 文件。
  fs.rmSync(statsDir, { recursive: true, force: true });
  const v1Dec = mediaDatModule.decryptImageDatFile(crossMonthV1Path, {
    keyFilePath: keyCachePath,
  });
  expect(v1Dec.ok).toBe(true);
  if (v1Dec.ok) {
    expect(v1Dec.image.mime).toBe('image/png');
    expect(v1Dec.image.data.equals(plainPng)).toBe(true);
  }

  // 损坏后续密文块（首块仍命中图片密钥，尾块 PKCS7 填充损坏）与不存在路径的错误分类校验。
  const brokenPath = path.join(root, 'broken_v2.dat');
  const corrupted = Buffer.from(v2JpegBytes);
  const lastAesOffset = corrupted.byteLength - 12 - 4;
  corrupted[lastAesOffset] = corrupted[lastAesOffset]! ^ 0xff;
  fs.writeFileSync(brokenPath, corrupted);
  expect(mediaDatModule.decryptImageDatFile(brokenPath, { keyFilePath: keyCachePath })).toEqual({
    ok: false,
    code: 'decrypt_failed',
  });
  expect(mediaDatModule.decryptImageDatFile(path.join(root, 'missing.dat'))).toEqual({
    ok: false,
    code: 'not_found',
  });
});


test('VoiceExtract：加密 media_0.db 直提 SILK 与 silk-wasm 内存转 WAV（含 Name2Id 会话隔离与时长校验）', async () => {
  const dir = makeTempDir();
  const dbStorage = path.join(dir, 'db_storage');
  const cacheDir = path.join(dir, 'cache');
  const plainMediaDb = path.join(dir, 'plain_media_0.db');
  const encMediaDb = path.join(dbStorage, 'message', 'media_0.db');

  // 现场合成 1 秒 24kHz 单声道 440Hz 正弦波并用 silk-wasm 编码为真实 SILK 流。
  const sampleCount = 24_000;
  const pcmSamples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    pcmSamples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 12_000);
  }
  const encodedSilk = await silk.encode(pcmSamples, 24_000);
  expect(encodedSilk.data.byteLength).toBeGreaterThan(20);

  // 校验 normalizeSilkBytes 兼容腾讯 0x02 前缀、短填充前缀并拒绝非 SILK 杂音。
  const normalizedSample = voiceModule.normalizeSilkBytes(encodedSilk.data);
  expect(normalizedSample).toBeDefined();
  expect(normalizedSample?.subarray(0, 9).toString('ascii')).toBe('#!SILK_V3');
  const paddedSilk = Buffer.concat([Buffer.from([0x02, 0x00, 0x01]), normalizedSample!]);
  expect(voiceModule.normalizeSilkBytes(paddedSilk)?.equals(normalizedSample!)).toBe(true);
  expect(voiceModule.normalizeSilkBytes(crypto.randomBytes(64))).toBeUndefined();

  // 构造含 Name2Id 与 VoiceInfo 的加密 media_0.db，故意让两个不同会话都拥有 local_id = 42。
  const otherPcm = new Int16Array(48_000);
  const encodedOtherTwoSec = await silk.encode(otherPcm, 24_000);

  buildReservedPlainDb(plainMediaDb, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_voice_alice'), (2, 'wxid_voice_bob');
      CREATE TABLE VoiceInfo (
        chat_name_id INTEGER NOT NULL,
        local_id INTEGER NOT NULL,
        voice_data BLOB NOT NULL,
        voicelength INTEGER NOT NULL
      );
    `);
    db.query('INSERT INTO VoiceInfo VALUES (?, ?, ?, ?)').run(1, 42, Buffer.from(encodedSilk.data), 1000);
    db.query('INSERT INTO VoiceInfo VALUES (?, ?, ?, ?)').run(2, 42, Buffer.from(encodedOtherTwoSec.data), 2000);
    db.query('INSERT INTO VoiceInfo VALUES (?, ?, ?, ?)').run(1, 99, Buffer.from('not-a-silk-voice-stream'), 1000);
  });

  const mediaKey = crypto.randomBytes(cryptoModule.KEY_SIZE);
  const mediaSalt = crypto.randomBytes(cryptoModule.SALT_SIZE);
  encryptSqliteFile(plainMediaDb, encMediaDb, mediaKey, mediaSalt);

  const allKeys: cacheModule.KeyTable = {
    'message/media_0.db': { enc_key: mediaKey.toString('hex'), salt: mediaSalt.toString('hex') },
  };
  expect(voiceModule.findMediaDbKeys(allKeys)).toEqual(['message/media_0.db']);

  const cache = new cacheModule.DbCache(allKeys, dbStorage, cacheDir);
  const wav = await voiceModule.extractVoiceWav(cache, allKeys, 'wxid_voice_alice', 42, 1);
  expect(silk.isWav(wav)).toBe(true);
  const wavInfo = silk.getWavFileInfo(wav);
  expect(wavInfo.fmt.formatCode).toBe(1);
  expect(wavInfo.fmt.numberOfChannels).toBe(1);
  expect(wavInfo.fmt.sampleRate).toBe(24_000);
  expect(wavInfo.fmt.bitsPerSample).toBe(16);

  // 不同会话各自命中自己的同 local_id 音频（Bob 是 2 秒音频）。
  const bobWav = await voiceModule.extractVoiceWav(cache, allKeys, 'wxid_voice_bob', 42, 2);
  expect(bobWav.byteLength).toBeGreaterThan(wav.byteLength + 30_000);

  // 未收录在 Name2Id 的第三人请求同一 local_id = 42 时绝不串音，必须报 not_found。
  let wrongChatCode = '';
  try {
    await voiceModule.extractVoiceWav(cache, allKeys, 'wxid_stranger', 42);
  } catch (err) {
    if (err instanceof voiceModule.VoiceExtractError) {
      wrongChatCode = err.code;
    }
  }
  expect(wrongChatCode).toBe('not_found');

  // 时长与聊天记录气泡不符（期望 6 秒但实际 1 秒）时必须报 duration_mismatch。
  let mismatchCode = '';
  try {
    await voiceModule.extractVoiceWav(cache, allKeys, 'wxid_voice_alice', 42, 6);
  } catch (err) {
    if (err instanceof voiceModule.VoiceExtractError) {
      mismatchCode = err.code;
    }
  }
  expect(mismatchCode).toBe('duration_mismatch');

  // 损坏的非 SILK BLOB 报 not_silk。
  let badBlobCode = '';
  try {
    await voiceModule.extractVoiceWav(cache, allKeys, 'wxid_voice_alice', 99);
  } catch (err) {
    if (err instanceof voiceModule.VoiceExtractError) {
      badBlobCode = err.code;
    }
  }
  expect(badBlobCode).toBe('not_silk');
});


test('KeyScan：合成虚拟内存 Config.Cipher 指针链解码、跨 4MB 分块边界 hex 扫描与同钥异盐交叉验证', () => {
  const root = makeTempDir();
  const accountRoot = path.join(root, 'xwechat_files', 'wxid_offline_01');
  const dbStorage = path.join(accountRoot, 'db_storage');

  // 1. 验证账号目录发现只扫传入目录，绝不外扩。
  fs.mkdirSync(dbStorage, { recursive: true });
  const accounts = keyScanModule.discoverAccountDbDirs(root);
  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.folder).toBe('wxid_offline_01');
  expect(accounts[0]?.dbDir).toBe(dbStorage);
  expect(accounts[0]?.id.startsWith('account_')).toBe(true);

  // 2. 生成两把保证高离散度的 32 字节密钥与三份不同盐值的加密库（第 3 库与第 1 库共享 key1 以测交叉验证）。
  const key1 = crypto.createHash('sha256').update('synthetic-wechat-db-key-alpha-2026').digest();
  const key2 = crypto.createHash('sha256').update('synthetic-wechat-db-key-bravo-2026').digest();
  expect(keyScanModule.isProbable32ByteKey(key1)).toBe(true);
  expect(keyScanModule.isProbable32ByteKey(key2)).toBe(true);
  expect(keyScanModule.isProbable32ByteKey(Buffer.alloc(32, 0))).toBe(false);
  expect(keyScanModule.isProbable32ByteKey(Buffer.alloc(32, 0xff))).toBe(false);

  const salt1 = crypto.createHash('md5').update('salt-session-1').digest();
  const salt2 = crypto.createHash('md5').update('salt-message-2').digest();
  const salt3 = crypto.createHash('md5').update('salt-contact-3').digest();

  const plainSession = path.join(root, 'plain_session.db');
  const plainMsg = path.join(root, 'plain_msg.db');
  const plainContact = path.join(root, 'plain_contact.db');

  buildReservedPlainDb(plainSession, (db) => {
    db.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('session_ok');");
  });
  buildReservedPlainDb(plainMsg, (db) => {
    db.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('message_ok');");
  });
  buildReservedPlainDb(plainContact, (db) => {
    db.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('contact_cross_ok');");
  });

  const encSession = path.join(dbStorage, 'session', 'session.db');
  const encMsg = path.join(dbStorage, 'message', 'message_0.db');
  const encContact = path.join(dbStorage, 'contact', 'contact.db');
  encryptSqliteFile(plainSession, encSession, key1, salt1);
  encryptSqliteFile(plainMsg, encMsg, key2, salt2);
  encryptSqliteFile(plainContact, encContact, key1, salt3);

  // 放入明文 SQLite 库与 -wal 旁路文件，确认 collectDbSalts 自动排除不误收。
  fs.copyFileSync(plainSession, path.join(dbStorage, 'unencrypted.db'));
  fs.writeFileSync(`${encMsg}-wal`, Buffer.alloc(4096, 0xaa));

  const collection = keyScanModule.collectDbSalts(dbStorage);
  expect(collection.files.map((f) => f.relPath)).toEqual([
    'contact/contact.db',
    'message/message_0.db',
    'session/session.db',
  ]);
  expect(collection.saltToDbs.size).toBe(3);

  // 3. 构造纯内存合成虚拟地址空间：
  //    - 区域 A：存放类名 `com.Tencent.WCDB.Config.Cipher`
  //    - 区域 B：存放引用节点、Config 对象（+0x88）以及异或掩码后的 99 字节 `x'<key1><salt1>'` 块
  //    - 区域 C：长度 4MB + 512B，故意把原始 `x'<key2><salt2>'` 横跨在 4MB 分块切分点上
  const regionABase = 0x0000_0001_4000_0000n;
  const regionABuf = Buffer.alloc(4096);
  const needleOffset = 384;
  keyScanModule.WINDOWS_CONFIG_CIPHER_NAME.copy(regionABuf, needleOffset);
  const needleVirtualAddr = regionABase + BigInt(needleOffset);

  const regionBBase = 0x0000_0002_2000_0000n;
  const regionBBuf = Buffer.alloc(8192);
  const nodeOffset = 0x200;
  const configOffset = 0x600;
  const blobOffset = 0x900;
  const configVirtualAddr = regionBBase + BigInt(configOffset);
  const blobVirtualAddr = regionBBase + BigInt(blobOffset);

  // 填充 node：+0x10 为类名地址，+0x18 为长度 30，+0x28 为 configPtr。
  regionBBuf.writeBigUInt64LE(needleVirtualAddr, nodeOffset + 0x10);
  regionBBuf.writeBigUInt64LE(BigInt(keyScanModule.WINDOWS_CONFIG_CIPHER_NAME.byteLength), nodeOffset + 0x18);
  regionBBuf.writeBigUInt64LE(configVirtualAddr, nodeOffset + 0x28);

  // 填充 config + 0x88：+0x08 为 blobPtr，+0x10 为标准长度 99。
  const rawLiteral1 = Buffer.from(`X'${key1.toString('hex').toUpperCase()}${salt1.toString('hex')}'`, 'ascii');
  expect(rawLiteral1.byteLength).toBe(99);
  const maskedBlob1 = Buffer.allocUnsafe(rawLiteral1.byteLength);
  for (let i = 0; i < rawLiteral1.byteLength; i += 1) {
    const maskByte = keyScanModule.WINDOWS_CONFIG_XOR_MASK[i % keyScanModule.WINDOWS_CONFIG_XOR_MASK.byteLength]!;
    maskedBlob1[i] = rawLiteral1[i]! ^ maskByte;
  }
  maskedBlob1.copy(regionBBuf, blobOffset);
  regionBBuf.writeBigUInt64LE(blobVirtualAddr, configOffset + 0x88 + 0x08);
  regionBBuf.writeBigUInt64LE(BigInt(maskedBlob1.byteLength), configOffset + 0x88 + 0x10);

  // 区域 C：把 `x'<key2><salt2>'` 正好跨在 4 MiB 边界（前 40 字节在块 1 末尾，后 59 字节在块 2 开头）。
  const fourMb = 4 * 1024 * 1024;
  const regionCBase = 0x0000_0003_0000_0000n;
  const regionCBuf = Buffer.alloc(fourMb + 512, 0x20);
  const rawLiteral2 = Buffer.from(`x'${key2.toString('hex')}${salt2.toString('hex')}'`, 'ascii');
  rawLiteral2.copy(regionCBuf, fourMb - 40);

  const memorySegments: Array<{ base: bigint; data: Buffer }> = [
    { base: regionABase, data: regionABuf },
    { base: regionBBase, data: regionBBuf },
    { base: regionCBase, data: regionCBuf },
  ];

  const syntheticReader: keyScanModule.ProcessMemoryReader = {
    pid: 424242,
    regions: memorySegments.map((seg) => ({ base: seg.base, size: seg.data.byteLength })),
    readMemory(address: bigint, length: number): Buffer | undefined {
      for (const seg of memorySegments) {
        const segEnd = seg.base + BigInt(seg.data.byteLength);
        if (address >= seg.base && address < segEnd) {
          const start = Number(address - seg.base);
          const avail = Math.min(length, seg.data.byteLength - start);
          return Buffer.from(seg.data.subarray(start, start + avail));
        }
      }
      return undefined;
    },
  };

  // 4. 执行纯内存提取，验证三把盐值（Config.Cipher + 跨块 raw hex + 同钥异盐交叉验证）一次全解开。
  const summary = keyScanModule.extractKeysFromMemoryReaders(collection, [syntheticReader]);
  expect(summary.configStats.needleOccurrences).toBe(1);
  expect(summary.configStats.blob99Count).toBe(1);
  expect(summary.configStats.matchedSalts).toBe(1);
  expect(summary.rawHexMatches).toBe(1);
  expect(summary.crossVerifiedSalts).toBe(1);
  expect(summary.totalDbs).toBe(3);
  expect(summary.matchedDbs).toBe(3);
  expect(summary.missingDbs).toEqual([]);

  // 5. 落盘 all_keys.json 后交给 DbCache 解密三座库，核实 SQLite 明文读取完全闭环。
  const keysJsonPath = path.join(root, 'state', 'all_keys.json');
  keyScanModule.writeAllKeysJson(keysJsonPath, summary.keyTable);
  const loadedKeys = JSON.parse(fs.readFileSync(keysJsonPath, 'utf8')) as cacheModule.KeyTable;
  const cache = new cacheModule.DbCache(loadedKeys, dbStorage, path.join(root, 'cache'));

  for (const [relPath, expectedMarker] of [
    ['session/session.db', 'session_ok'],
    ['message/message_0.db', 'message_ok'],
    ['contact/contact.db', 'contact_cross_ok'],
  ] as const) {
    const replica = cache.getDecryptedPath(relPath);
    expect(replica).toBeDefined();
    const conn = new sqlite.Database(replica!, { readonly: true });
    try {
      const row = conn.query<{ v: string }, []>('SELECT v FROM marker LIMIT 1').get();
      expect(row?.v).toBe(expectedMarker);
    } finally {
      conn.close();
    }
  }
});
