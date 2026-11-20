/**
 * 纯 Bun 微信解密、页摘要增量缓存、安全 XML 气泡视图与分片只读查询的全离线合成单测。
 * 全程现场生成合成 SQLCipher 4 加密库、合成 WAL、Zstd 压缩正文与 18 类 XML 样本，零 Python、零真实个人数据。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as cryptoModule from './Crypto.ts';
import * as cacheModule from './DbCache.ts';
import * as viewModule from './MsgView.ts';
import * as dbModule from './WechatDb.ts';


const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-wx-purebun-'));
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
 * 创建一个预留末尾 80 字节（SQLite header byte 20 = 80, usableSize = 4016）的空白明文 SQLite 库，
 * 随后执行建表与写入回调，使其页布局与微信 4.x WCDB / SQLCipher 4 完全一致。
 */
function buildReservedPlainDb(filePath: string, populate: (db: sqlite.Database) => void): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  {
    const initDb = new sqlite.Database(filePath);
    initDb.exec('PRAGMA journal_mode = DELETE; PRAGMA page_size = 4096; CREATE TABLE _seed(x); DROP TABLE _seed;');
    initDb.close();
  }
  const page1 = fs.readFileSync(filePath);
  // SQLite 头部第 20 字节记录每页末尾保留空间（80 字节），根 B-tree 页偏移 105 处重设为 4016 并清零保留区。
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
 * 将单页 4096 字节明文 SQLite 页按 SQLCipher 4 格式加密（含随机 IV 与真实 HMAC-SHA512）。
 */
function encryptPlainPage(
  encKey: Uint8Array,
  salt: Uint8Array,
  plainPage: Uint8Array,
  pageNo: number,
  deterministicIv?: Uint8Array,
): Buffer {
  const iv = deterministicIv !== undefined ? Buffer.from(deterministicIv) : crypto.randomBytes(cryptoModule.IV_SIZE);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  cipher.setAutoPadding(false);

  const out = Buffer.alloc(cryptoModule.PAGE_SIZE);
  const ivOffset = cryptoModule.PAGE_SIZE - cryptoModule.RESERVE_SIZE;
  if (pageNo === 1) {
    Buffer.from(salt).copy(out, 0, 0, cryptoModule.SALT_SIZE);
    const body = plainPage.subarray(cryptoModule.SALT_SIZE, ivOffset);
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    encrypted.copy(out, cryptoModule.SALT_SIZE);
  } else {
    const body = plainPage.subarray(0, ivOffset);
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    encrypted.copy(out, 0);
  }
  iv.copy(out, ivOffset);

  const macKey = cryptoModule.deriveMacKey(encKey, salt);
  const mac = cryptoModule.computePageHmac(macKey, out, pageNo);
  mac.copy(out, ivOffset + cryptoModule.IV_SIZE);
  return out;
}

/**
 * 将整份明文 SQLite 文件按页加密写出为 SQLCipher 4 数据库文件（同一页内容配合固定派生 IV 以稳定复现页摘要）。
 */
function encryptSqliteFile(plainPath: string, encryptedPath: string, encKey: Uint8Array, salt: Uint8Array): number {
  const raw = fs.readFileSync(plainPath);
  const totalPages = Math.floor(raw.byteLength / cryptoModule.PAGE_SIZE);
  const out = Buffer.allocUnsafe(totalPages * cryptoModule.PAGE_SIZE);
  for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
    const start = (pageNo - 1) * cryptoModule.PAGE_SIZE;
    const plainPage = raw.subarray(start, start + cryptoModule.PAGE_SIZE);
    const pageIv = crypto.createHash('md5').update(plainPage).update(String(pageNo)).digest();
    const encPage = encryptPlainPage(encKey, salt, plainPage, pageNo, pageIv);
    encPage.copy(out, start);
  }
  fs.mkdirSync(path.dirname(encryptedPath), { recursive: true });
  fs.writeFileSync(encryptedPath, out);
  return totalPages;
}

/**
 * 构造一份合成加密 -wal 文件（支持混入不同 salt 旧帧、非法页号帧以及末尾未刷完的半截残帧）。
 */
function writeSyntheticWal(
  walPath: string,
  walSalt1: number,
  walSalt2: number,
  frames: readonly {
    pageNo: number;
    salt1: number;
    salt2: number;
    encryptedPage: Uint8Array;
  }[],
  trailingPartialBytes = 0,
): void {
  const header = Buffer.alloc(cryptoModule.WAL_HEADER_SIZE);
  header.writeUInt32BE(0x377f0682, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(cryptoModule.PAGE_SIZE, 8);
  header.writeUInt32BE(walSalt1, 16);
  header.writeUInt32BE(walSalt2, 20);

  const chunks: Buffer[] = [header];
  for (const frame of frames) {
    const fh = Buffer.alloc(cryptoModule.WAL_FRAME_HEADER_SIZE);
    fh.writeUInt32BE(frame.pageNo, 0);
    fh.writeUInt32BE(frame.salt1, 8);
    fh.writeUInt32BE(frame.salt2, 12);
    chunks.push(fh, Buffer.from(frame.encryptedPage));
  }
  if (trailingPartialBytes > 0) {
    chunks.push(crypto.randomBytes(trailingPartialBytes));
  }
  fs.writeFileSync(walPath, Buffer.concat(chunks));
}


/**
 * 对比两份明文 SQLite 文件，把所有发生变化的页加密打包成同代 WAL 帧列表（真实还原 SQLite 提交到 WAL 的多页事务）。
 */
function diffEncryptedWalFrames(
  beforePlainPath: string,
  afterPlainPath: string,
  encKey: Uint8Array,
  salt: Uint8Array,
  salt1: number,
  salt2: number,
): { pageNo: number; salt1: number; salt2: number; encryptedPage: Buffer }[] {
  const before = fs.readFileSync(beforePlainPath);
  const after = fs.readFileSync(afterPlainPath);
  const beforePages = Math.floor(before.byteLength / cryptoModule.PAGE_SIZE);
  const afterPages = Math.floor(after.byteLength / cryptoModule.PAGE_SIZE);
  const frames: { pageNo: number; salt1: number; salt2: number; encryptedPage: Buffer }[] = [];
  for (let pageNo = 1; pageNo <= afterPages; pageNo += 1) {
    const start = (pageNo - 1) * cryptoModule.PAGE_SIZE;
    const afterSlice = after.subarray(start, start + cryptoModule.PAGE_SIZE);
    const unchanged = pageNo <= beforePages
      && before.subarray(start, start + cryptoModule.PAGE_SIZE).equals(afterSlice);
    if (!unchanged) {
      frames.push({
        pageNo,
        salt1,
        salt2,
        encryptedPage: encryptPlainPage(encKey, salt, afterSlice, pageNo),
      });
    }
  }
  return frames;
}


test('Crypto：SQLCipher 4 首页 HMAC 验密、整库解密完整性与 WAL 同代帧合并（忽略旧盐帧与末尾半帧）', () => {
  const dir = makeTempDir();
  const plainV1 = path.join(dir, 'plain_v1.db');
  const plainV2 = path.join(dir, 'plain_v2.db');
  const encDb = path.join(dir, 'encrypted.db');
  const encWal = `${encDb}-wal`;
  const decDb = path.join(dir, 'decrypted.db');

  const key = crypto.randomBytes(cryptoModule.KEY_SIZE);
  const wrongKey = crypto.randomBytes(cryptoModule.KEY_SIZE);
  const salt = crypto.randomBytes(cryptoModule.SALT_SIZE);

  buildReservedPlainDb(plainV1, (db) => {
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    for (let index = 1; index <= 80; index += 1) {
      db.query('INSERT INTO notes (id, body) VALUES (?, ?)').run(index, `初始记录_${String(index)}_${'甲'.repeat(40)}`);
    }
  });

  // 拷贝出 V2 并在其上修改一行，提取全部变更页（含首页变更计数与叶子数据页）放进合成 WAL。
  fs.copyFileSync(plainV1, plainV2);
  {
    const db2 = new sqlite.Database(plainV2);
    db2.query('UPDATE notes SET body = ? WHERE id = 1').run('WAL新提交内容_已覆盖');
    db2.close();
  }

  const pageCount = encryptSqliteFile(plainV1, encDb, key, salt);
  expect(pageCount).toBeGreaterThan(2);

  const encBytes = fs.readFileSync(encDb);
  const page1 = encBytes.subarray(0, cryptoModule.PAGE_SIZE);
  expect(cryptoModule.verifyPage1Key(key, page1)).toBe(true);
  expect(cryptoModule.verifyPage1Key(wrongKey, page1)).toBe(false);
  expect(cryptoModule.verifyPage1Key(key.subarray(0, 16), page1)).toBe(false);
  expect(cryptoModule.verifyPage1Key(key, page1.subarray(0, 1024))).toBe(false);

  const tampered = Buffer.from(page1);
  tampered[128] = (tampered[128] ?? 0) ^ 0xff;
  expect(cryptoModule.verifyPage1Key(key, tampered)).toBe(false);

  const written = cryptoModule.decryptDatabaseFile(encDb, decDb, key);
  expect(written).toBe(pageCount);

  // 混入旧代次坏帧、非法 0 号页帧与 777 字节末尾半截残帧，验证只合入同代合法帧。
  const validFrames = diffEncryptedWalFrames(plainV1, plainV2, key, salt, 0x11223344, 0x55667788);
  expect(validFrames.length).toBeGreaterThanOrEqual(2);
  const garbageEncPage = crypto.randomBytes(cryptoModule.PAGE_SIZE);

  writeSyntheticWal(
    encWal,
    0x11223344,
    0x55667788,
    [
      { pageNo: 2, salt1: 0xdeadbeef, salt2: 0x55667788, encryptedPage: garbageEncPage },
      { pageNo: 0, salt1: 0x11223344, salt2: 0x55667788, encryptedPage: garbageEncPage },
      ...validFrames,
    ],
    777,
  );

  const patched = cryptoModule.applyWalFrames(encWal, decDb, key);
  expect(patched).toEqual(validFrames.map((item) => item.pageNo));

  const checkDb = new sqlite.Database(decDb, { readonly: true });
  try {
    const integrity = checkDb.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get();
    expect(integrity?.integrity_check).toBe('ok');
    const row1 = checkDb.query<{ body: string }, []>('SELECT body FROM notes WHERE id = 1').get();
    expect(row1?.body).toBe('WAL新提交内容_已覆盖');
  } finally {
    checkDb.close();
  }
});


test('DbCache：8B blake2b256 页摘要增量刷新、WAL 换代回滚、跨实例持久化与路径越界拦截', () => {
  const dir = makeTempDir();
  const dbDir = path.join(dir, 'db_storage');
  const cacheRoot = path.join(dir, 'cache');
  const plainBase = path.join(dir, 'plain_base.db');
  const plainWalEdit = path.join(dir, 'plain_wal.db');
  const plainCheckpointed = path.join(dir, 'plain_ckpt.db');
  const targetEnc = path.join(dbDir, 'message', 'message_0.db');
  const targetWal = `${targetEnc}-wal`;

  const key = crypto.randomBytes(cryptoModule.KEY_SIZE);
  const salt = crypto.randomBytes(cryptoModule.SALT_SIZE);
  const allKeys: cacheModule.KeyTable = {
    _meta: { generator: 'synthetic' },
    'message\\message_0.db': { enc_key: key.toString('hex'), salt: salt.toString('hex') },
  };

  expect(cacheModule.getDatabaseKey(allKeys, '../outside.db')).toBeUndefined();
  expect(cacheModule.getDatabaseKey(allKeys, '/abs/path.db')).toBeUndefined();
  expect(cacheModule.getDatabaseKey(allKeys, 'message/message_0.db')?.equals(key)).toBe(true);

  buildReservedPlainDb(plainBase, (db) => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT NOT NULL)');
    for (let i = 1; i <= 120; i += 1) {
      db.query('INSERT INTO items (id, val) VALUES (?, ?)').run(i, `行_${String(i)}_${'乙'.repeat(50)}`);
    }
  });
  const totalPages = encryptSqliteFile(plainBase, targetEnc, key, salt);
  expect(totalPages).toBeGreaterThanOrEqual(4);

  const cache = new cacheModule.DbCache(allKeys, dbDir, cacheRoot);
  const firstReplica = cache.getDecryptedPath('message/message_0.db');
  expect(firstReplica).toBeDefined();
  expect(cache.stats).toEqual({ hits: 0, full: 1, incremental: 0, pages: 0 });

  // 未改动时再次获取应直接命中，零解密。
  expect(cache.getDecryptedPath('message\\message_0.db')).toBe(firstReplica);
  expect(cache.stats).toEqual({ hits: 1, full: 1, incremental: 0, pages: 0 });

  // 仅新增 WAL：触发增量刷新（主库未变，重解页数为 0，仅应用 WAL 帧）。
  fs.copyFileSync(plainBase, plainWalEdit);
  {
    const db = new sqlite.Database(plainWalEdit);
    db.query('UPDATE items SET val = ? WHERE id = 120').run('来自WAL的临时更新');
    db.close();
  }
  const walFrames = diffEncryptedWalFrames(plainBase, plainWalEdit, key, salt, 101, 202);
  writeSyntheticWal(targetWal, 101, 202, walFrames);

  const afterWalReplica = cache.getDecryptedPath('message/message_0.db')!;
  expect(cache.stats.incremental).toBe(1);
  expect(cache.stats.pages).toBe(0);
  {
    const conn = new sqlite.Database(afterWalReplica, { readonly: true });
    const row = conn.query<{ val: string }, []>('SELECT val FROM items WHERE id = 120').get();
    conn.close();
    expect(row?.val).toBe('来自WAL的临时更新');
  }

  // 模拟 WAL 换代清空 + 主库仅第 1 条记录所在单页发生变更，并用全新 DbCache 实例从 _mtimes.json 恢复增量刷新。
  fs.rmSync(targetWal, { force: true });
  fs.copyFileSync(plainBase, plainCheckpointed);
  {
    const db = new sqlite.Database(plainCheckpointed);
    db.query('UPDATE items SET val = ? WHERE id = 1').run('主库单页更新_其余页不动');
    db.close();
  }
  encryptSqliteFile(plainCheckpointed, targetEnc, key, salt);
  const futureTime = new Date(Date.now() + 5000);
  fs.utimesSync(targetEnc, futureTime, futureTime);

  const reloadedCache = new cacheModule.DbCache(allKeys, dbDir, cacheRoot);
  const ckptReplica = reloadedCache.getDecryptedPath('message/message_0.db')!;
  expect(reloadedCache.stats.full).toBe(0);
  expect(reloadedCache.stats.incremental).toBe(1);
  // 应只重解了上次 WAL 覆盖页 + 本次主库变动的单页，远小于总页数。
  expect(reloadedCache.stats.pages).toBeLessThan(totalPages);

  {
    const conn = new sqlite.Database(ckptReplica, { readonly: true });
    const r1 = conn.query<{ val: string }, []>('SELECT val FROM items WHERE id = 1').get();
    const r120 = conn.query<{ val: string }, []>('SELECT val FROM items WHERE id = 120').get();
    conn.close();
    expect(r1?.val).toBe('主库单页更新_其余页不动');
    expect(r120?.val.startsWith('行_120_')).toBe(true);
  }
});


test('MsgView：安全 XML 守卫（拦截 DOCTYPE/ENTITY/超长）与全部 18 类微信气泡视图 + 群 @ 解析', () => {
  // 1. 安全守卫测试
  expect(viewModule.parseSafeXml('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><msg>&xxe;</msg>')).toBeUndefined();
  expect(viewModule.parseSafeXml('<msg><!ENTITY bad "boom"></msg>')).toBeUndefined();
  expect(viewModule.parseSafeXml(`<msg>${'a'.repeat(viewModule.MAX_XML_LENGTH)}</msg>`)).toBeUndefined();

  // 2. 18+ 种气泡视图全覆盖核对
  expect(viewModule.buildMessageView(1, '普通文字', '群友甲')).toEqual({
    kind: 'text', text: '普通文字', sender: '群友甲',
  });

  // 系统：撤回、拍一拍（wxid 映射）、进群模板、坏 XML 兜底
  expect(viewModule.buildMessageView(
    10002,
    '<sysmsg type="revokemsg"><revokemsg><replacemsg><![CDATA["张三" 撤回了一条消息]]></replacemsg></revokemsg></sysmsg>',
    '张三',
  )).toEqual({ kind: 'system', text: '"张三" 撤回了一条消息' });

  const patLookup = (wxid: string) => (wxid === 'wxid_a' ? '小明' : wxid === 'wxid_b' ? '小红' : undefined);
  expect(viewModule.buildMessageView(
    10000,
    '<sysmsg type="pat"><pat><template><![CDATA["${wxid_a}" 拍了拍 "${wxid_b}" 的肩膀]]></template></pat></sysmsg>',
    '',
    null,
    patLookup,
  )).toEqual({ kind: 'system', text: '"小明" 拍了拍 "小红" 的肩膀' });

  expect(viewModule.buildMessageView(
    10000,
    '<sysmsg type="sysmsgtemplate"><sysmsgtemplate><content_template><template><![CDATA["$username$"邀请"$names$"加入了群聊]]></template>'
      + '<link_list><link name="username"><memberlist><member><nickname>群主</nickname></member></memberlist></link>'
      + '<link name="names"><memberlist><member><nickname>甲</nickname></member><member><nickname>乙</nickname></member></memberlist></link>'
      + '</link_list></content_template></sysmsgtemplate></sysmsg>',
    '',
  )).toEqual({ kind: 'system', text: '"群主"邀请"甲、乙"加入了群聊' });

  expect(viewModule.buildMessageView(10000, '<sysmsg><unclosed>', '')).toEqual({
    kind: 'system', text: '[系统消息]',
  });

  // 图片（含 packed_info_data MD5 优先 + XML md5/hdmd5）
  const packedMd5 = '0123456789abcdef0123456789abcdef';
  const xmlMd5 = 'fedcba9876543210fedcba9876543210';
  expect(viewModule.buildMessageView(
    3,
    `<msg><img cdnthumbwidth="320" cdnthumbheight="240" md5="${xmlMd5}" /></msg>`,
    '',
    Buffer.from(`prefix_${packedMd5}_suffix`, 'ascii'),
  )).toEqual({
    kind: 'image',
    width: 320,
    height: 240,
    media: { image: [packedMd5, xmlMd5] },
  });

  // 表情、语音、视频、位置、名片、通话
  expect(viewModule.buildMessageView(
    47,
    '<msg><emoji width="120" height="120" cdnurl="https://example.invalid/e.gif" aeskey="aabb" md5="ccdd"/></msg>',
    '',
  )).toEqual({
    kind: 'emoji',
    width: 120,
    height: 120,
    media: { emoji: { cdnurl: 'https://example.invalid/e.gif', aeskey: 'aabb', md5: 'ccdd' } },
  });

  expect(viewModule.buildMessageView(34, '<msg><voicemsg voicelength="4600" /></msg>', '')).toEqual({
    kind: 'voice', seconds: 5,
  });
  expect(viewModule.buildMessageView(43, '<msg><videomsg playlength="18" /></msg>', '')).toEqual({
    kind: 'video', seconds: 18,
  });
  expect(viewModule.buildMessageView(48, '<msg><location poiname="科技园" label="深南大道1号" /></msg>', '')).toEqual({
    kind: 'location', title: '科技园', desc: '深南大道1号',
  });
  expect(viewModule.buildMessageView(42, '<msg nickname="李四顾问" username="wxid_lisi" />', '')).toEqual({
    kind: 'card', title: '李四顾问', desc: '个人名片',
  });
  expect(viewModule.buildMessageView(50, '<msg><VoIPBubbleMsg><msg><![CDATA[Duration: 02:15]]></msg></VoIPBubbleMsg></msg>', '')).toEqual({
    kind: 'call', text: '通话时长 02:15',
  });
  expect(viewModule.buildMessageView(50, '<voipmsg><msg>Canceled</msg></voipmsg>', '')).toEqual({
    kind: 'call', text: '已取消',
  });

  // 类型 49 富媒体全族：quote / file(64位类型) / transfer / redpacket / channels / record(嵌套CDATA) / music / miniapp / link
  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><title>收到，马上办</title><type>57</type><refermsg><type>1</type><displayname>王总</displayname><content>今天发报价单</content></refermsg></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'quote',
    text: '收到，马上办',
    quote: { name: '王总', text: '今天发报价单' },
  });

  // 被引用的是图片消息（type=3）时，不泄漏内部 XML，折叠成 [图片]
  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><title>看这张</title><type>57</type><refermsg><type>3</type><displayname>王总</displayname><content>&lt;img md5="abc"/&gt;</content></refermsg></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'quote',
    text: '看这张',
    quote: { name: '王总', text: '[图片]' },
  });

  const file64BitType = Number((6n << 32n) | 49n);
  expect(viewModule.buildMessageView(
    file64BitType,
    '<msg><appmsg><title>合同终稿.pdf</title><appattach><totallen>1048576</totallen></appattach></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'file', title: '合同终稿.pdf', size: 1048576,
  });

  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><type>2000</type><wcpayinfo><paysubtype>3</paysubtype><feedesc>￥520.00</feedesc></wcpayinfo></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'transfer', title: '微信转账', desc: '已收款', amount: '￥520.00',
  });

  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><type>2001</type><wcpayinfo><sendertitle>开工大吉</sendertitle></wcpayinfo></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'redpacket', title: '开工大吉', desc: '微信红包',
  });

  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><type>51</type><finderFeed><nickname>极客频道</nickname><desc>新品拆解直播</desc></finderFeed></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'channels', title: '极客频道', desc: '新品拆解直播', source: '视频号',
  });

  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><type>19</type><title>甲与乙的聊天记录</title><des>共2条</des>'
      + '<recorditem><![CDATA[<recordinfo><datalist>'
      + '<dataitem><sourcename>甲</sourcename><datadesc>第一句安排</datadesc></dataitem>'
      + '<dataitem><sourcename>乙</sourcename><datadesc>没问题</datadesc></dataitem>'
      + '</datalist></recordinfo>]]></recorditem></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'record',
    title: '甲与乙的聊天记录',
    desc: '共2条',
    items: [
      { sender: '甲', text: '第一句安排' },
      { sender: '乙', text: '没问题' },
    ],
  });

  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><type>3</type><title>夜曲</title><des>周杰伦</des><sourcedisplayname>QQ音乐</sourcedisplayname><url>https://music.invalid/1</url></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'music', title: '夜曲', desc: '周杰伦', source: 'QQ音乐', url: 'https://music.invalid/1',
  });

  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><type>33</type><title>顺丰速运+</title><des>查快递</des><sourcedisplayname>顺丰</sourcedisplayname></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'miniapp', title: '顺丰速运+', desc: '查快递', source: '顺丰',
  });

  expect(viewModule.buildMessageView(
    49,
    '<msg><appmsg><type>5</type><title>年度报告</title><des>摘要说明</des><sourcedisplayname>公众号甲</sourcedisplayname><url>https://mp.invalid/a</url><thumburl>https://mp.invalid/t.jpg</thumburl></appmsg></msg>',
    '',
  )).toEqual({
    kind: 'link',
    title: '年度报告',
    desc: '摘要说明',
    source: '公众号甲',
    url: 'https://mp.invalid/a',
    thumburl: 'https://mp.invalid/t.jpg',
  });

  expect(viewModule.buildMessageView(9999, '未知二进制', '')).toEqual({
    kind: 'other', text: '[消息]',
  });

  // 3. 群聊 @ 判定（atuserlist 精确名单 vs 空标签屏蔽正文误判 vs 无标签正文推断）
  expect(viewModule.getMentionFlags(
    true,
    1,
    '@客服小助手\u2005请帮忙看看',
    '<msgsource><atuserlist><![CDATA[wxid_other,wxid_me]]></atuserlist></msgsource>',
    'wxid_me',
    ['客服小助手'],
  )).toEqual({ atMe: true, atAll: false, atSource: 'atuserlist' });

  // 有空 <atuserlist></atuserlist> 时说明是纯手打的 @，不按真 @ 算
  expect(viewModule.getMentionFlags(
    true,
    1,
    '@客服小助手 手打假提及',
    '<msgsource><atuserlist></atuserlist></msgsource>',
    'wxid_me',
    ['客服小助手'],
  )).toEqual({ atMe: false, atAll: false, atSource: 'atuserlist' });

  // 老表无 atuserlist 标签时回退正文推断（认 \u2005 与额外群昵称，不误判前缀更长的名字）
  expect(viewModule.getMentionFlags(
    true,
    1,
    '@所有人 @值班小灵\u2005紧急通知',
    '<msgsource><bizflag>0</bizflag></msgsource>',
    'wxid_me',
    ['值班小灵'],
  )).toEqual({ atMe: true, atAll: true, atSource: 'text' });

  expect(viewModule.getMentionFlags(
    true,
    1,
    '@值班小灵二号 这是叫别人',
    undefined,
    'wxid_me',
    ['值班小灵'],
  )).toEqual({ atMe: false, atAll: false, atSource: '' });
});


test('WechatDb：跨加密库只读查询 sessions / syncBatch / backfill（含 Zstd 正文与 msgsource 解压及实时 WAL）', () => {
  const dir = makeTempDir();
  // 模拟真实目录层级 .../wxid_me_9f8e/db_storage，自动推导 selfWxid = wxid_me
  const dbDir = path.join(dir, 'xwechat_files', 'wxid_me_9f8e', 'db_storage');
  const cacheRoot = path.join(dir, 'cache');
  const plainWork = path.join(dir, 'plain_work');

  const keySession = crypto.randomBytes(32);
  const keyContact = crypto.randomBytes(32);
  const keyMsg0 = crypto.randomBytes(32);
  const keyMsg1 = crypto.randomBytes(32);
  const salt = crypto.randomBytes(16);

  const p2pChat = 'wxid_alice';
  const groupChat = '889900@chatroom';
  const p2pTable = dbModule.getMessageTableName(p2pChat);
  const groupTable = dbModule.getMessageTableName(groupChat);

  // 1. contact.db
  const plainContact = path.join(plainWork, 'contact.db');
  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
    const ins = db.query('INSERT INTO contact (username, nick_name, remark) VALUES (?, ?, ?)');
    ins.run('wxid_me', '我的原昵称', '');
    ins.run(p2pChat, 'Alice昵称', '客户陈女士');
    ins.run(groupChat, 'VIP售后群', '');
    ins.run('wxid_bob', '技术小王', '小王备注');
  });
  encryptSqliteFile(plainContact, path.join(dbDir, 'contact', 'contact.db'), keyContact, salt);

  // 2. session.db（含 Zstd 压缩 summary 与群聊发送者前缀）
  const plainSession = path.join(plainWork, 'session.db');
  buildReservedPlainDb(plainSession, (db) => {
    db.exec('CREATE TABLE SessionTable ('
      + 'username TEXT PRIMARY KEY, unread_count INTEGER, summary BLOB, last_timestamp INTEGER,'
      + 'last_msg_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT)');
    const ins = db.query('INSERT INTO SessionTable VALUES (?, ?, ?, ?, ?, ?, ?)');
    const zstdSummary = Bun.zstdCompressSync(Buffer.from('wxid_bob:\n@我的原昵称\u2005发票开好了吗', 'utf8'));
    ins.run(groupChat, 3, zstdSummary, 1_760_000_300, 1, 'wxid_bob', '群名片小王');
    ins.run(p2pChat, 1, '好的谢谢', 1_760_000_200, 1, p2pChat, '');
  });
  encryptSqliteFile(plainSession, path.join(dbDir, 'session', 'session.db'), keySession, salt);

  // 3. message_0.db（承载较早分片消息 + 64位文件消息）
  const plainMsg0 = path.join(plainWork, 'message_0.db');
  buildReservedPlainDb(plainMsg0, (db) => {
    db.exec('CREATE TABLE Name2Id (user_name TEXT)');
    db.query('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)').run(1, 'wxid_me');
    db.query('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)').run(2, p2pChat);
    db.query('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)').run(3, 'wxid_bob');

    db.exec(`CREATE TABLE [${p2pTable}] (`
      + 'local_id INTEGER PRIMARY KEY, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER,'
      + 'message_content BLOB, WCDB_CT_message_content INTEGER)');
    const insP2p = db.query(`INSERT INTO [${p2pTable}] VALUES (?, ?, ?, ?, ?, ?)`);
    insP2p.run(1, 1, 1_760_000_050, 2, Bun.zstdCompressSync(Buffer.from('你好，在吗？', 'utf8')), 4);
    insP2p.run(2, 1, 1_760_000_100, 1, '您好，在的！', 0);

    db.exec(`CREATE TABLE [${groupTable}] (`
      + 'local_id INTEGER PRIMARY KEY, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER,'
      + 'message_content BLOB, WCDB_CT_message_content INTEGER, source BLOB, WCDB_CT_source INTEGER)');
    const insGrp = db.query(`INSERT INTO [${groupTable}] VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const fileXml = 'wxid_bob:\n<msg><appmsg><title>对账单.xlsx</title><appattach><totallen>4096</totallen></appattach></appmsg></msg>';
    insGrp.run(
      10,
      Number((6n << 32n) | 49n),
      1_760_000_120,
      3,
      Bun.zstdCompressSync(Buffer.from(fileXml, 'utf8')),
      4,
      null,
      0,
    );
  });
  encryptSqliteFile(plainMsg0, path.join(dbDir, 'message', 'message_0.db'), keyMsg0, salt);

  // 4. message_1.db + 伴生实时加密 -wal（最新消息在 WAL 帧里！）
  const plainMsg1Base = path.join(plainWork, 'message_1_base.db');
  const plainMsg1Wal = path.join(plainWork, 'message_1_wal.db');
  buildReservedPlainDb(plainMsg1Base, (db) => {
    db.exec('CREATE TABLE Name2Id (user_name TEXT)');
    db.query('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)').run(1, 'wxid_me');
    db.query('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)').run(2, p2pChat);
    db.query('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)').run(3, 'wxid_bob');

    db.exec(`CREATE TABLE [${p2pTable}] (`
      + 'local_id INTEGER PRIMARY KEY, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER,'
      + 'message_content BLOB, WCDB_CT_message_content INTEGER)');
    db.query(`INSERT INTO [${p2pTable}] VALUES (?, ?, ?, ?, ?, ?)`).run(
      1, 1, 1_760_000_200, 2, '好的谢谢', 0,
    );

    db.exec(`CREATE TABLE [${groupTable}] (`
      + 'local_id INTEGER PRIMARY KEY, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER,'
      + 'message_content BLOB, WCDB_CT_message_content INTEGER, source BLOB, WCDB_CT_source INTEGER)');
    // 填充几十行让表跨越多页，随后通过 WAL 追加最新一条 Zstd 压缩 @我 消息
    const ins = db.query(`INSERT INTO [${groupTable}] VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 1; i <= 30; i += 1) {
      ins.run(i, 1, 1_760_000_130 + i, 3, `wxid_bob:\n日常群聊闲聊_${String(i)}_${'丙'.repeat(30)}`, 0, null, 0);
    }
  });

  fs.copyFileSync(plainMsg1Base, plainMsg1Wal);
  {
    const db = new sqlite.Database(plainMsg1Wal);
    const zstdBody = Bun.zstdCompressSync(Buffer.from('wxid_bob:\n@我的原昵称\u2005发票开好了吗', 'utf8'));
    const zstdSource = Bun.zstdCompressSync(
      Buffer.from('<msgsource><atuserlist><![CDATA[wxid_me]]></atuserlist></msgsource>', 'utf8'),
    );
    db.query(`INSERT INTO [${groupTable}] VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      99, 1, 1_760_000_300, 3, zstdBody, 4, zstdSource, 4,
    );
    db.close();
  }

  const encMsg1Path = path.join(dbDir, 'message', 'message_1.db');
  const msg1BasePages = encryptSqliteFile(plainMsg1Base, encMsg1Path, keyMsg1, salt);
  const rawBase1 = fs.readFileSync(plainMsg1Base);
  const rawWal1 = fs.readFileSync(plainMsg1Wal);
  const msg1WalPages = Math.floor(rawWal1.byteLength / cryptoModule.PAGE_SIZE);
  const walFrames: { pageNo: number; salt1: number; salt2: number; encryptedPage: Uint8Array }[] = [];
  for (let p = 1; p <= msg1WalPages; p += 1) {
    const start = (p - 1) * cryptoModule.PAGE_SIZE;
    const afterSlice = rawWal1.subarray(start, start + cryptoModule.PAGE_SIZE);
    const sameAsBase = p <= msg1BasePages
      && rawBase1.subarray(start, start + cryptoModule.PAGE_SIZE).equals(afterSlice);
    if (!sameAsBase) {
      walFrames.push({
        pageNo: p,
        salt1: 0xabcdef01,
        salt2: 0x10fedcba,
        encryptedPage: encryptPlainPage(keyMsg1, salt, afterSlice, p),
      });
    }
  }
  writeSyntheticWal(`${encMsg1Path}-wal`, 0xabcdef01, 0x10fedcba, walFrames, 128);

  const allKeys: cacheModule.KeyTable = {
    'contact/contact.db': { enc_key: keyContact.toString('hex') },
    'session/session.db': { enc_key: keySession.toString('hex') },
    'message/message_0.db': { enc_key: keyMsg0.toString('hex') },
    'message\\message_1.db': { enc_key: keyMsg1.toString('hex') },
  };

  const wechatDb = new dbModule.WechatDb({
    dbDir,
    allKeys,
    cacheRoot,
    atNames: ['售后管家'],
  });

  // 检验 sessions()
  const recent = wechatDb.sessions(10);
  expect(recent).toHaveLength(2);
  expect(recent[0]).toMatchObject({
    username: groupChat,
    chat: 'VIP售后群',
    is_group: true,
    unread: 3,
    last_message: '@我的原昵称\u2005发票开好了吗',
    msg_type: '文本',
    sender: '小王备注',
    timestamp: 1_760_000_300,
  });
  expect(recent[1]).toMatchObject({
    username: p2pChat,
    chat: '客户陈女士',
    is_group: false,
    unread: 1,
    last_message: '好的谢谢',
    sender: '',
    timestamp: 1_760_000_200,
  });

  // 检验 syncBatch（跨分片合并、WAL 最新消息、Zstd msgsource @我 识别、私聊收发方向、不存在会话）
  const batch = wechatDb.syncBatch([
    { chat: p2pChat, since: null },
    { chat: groupChat, since: 1_760_000_290 },
    { chat: 'not_exist_chat', since: null },
  ]);
  expect(batch).toHaveLength(3);

  const p2pRes = batch[0]!;
  expect(p2pRes.missing).toBe(false);
  expect(p2pRes.chat_display).toBe('客户陈女士');
  expect(p2pRes.messages?.map((m) => [m.source, m.local_id, m.from_self, m.view.text])).toEqual([
    ['message_0.db', 1, false, '你好，在吗？'],
    ['message_0.db', 2, true, '您好，在的！'],
    ['message_1.db', 1, false, '好的谢谢'],
  ]);

  const grpRes = batch[1]!;
  expect(grpRes.missing).toBe(false);
  expect(grpRes.is_group).toBe(true);
  expect(grpRes.messages).toHaveLength(1);
  expect(grpRes.messages?.[0]).toMatchObject({
    source: 'message_1.db',
    local_id: 99,
    create_time: 1_760_000_300,
    from_self: false,
    at_me: true,
    at_source: 'atuserlist',
    view: {
      kind: 'text',
      sender: '小王备注',
      text: '@我的原昵称\u2005发票开好了吗',
    },
  });

  expect(batch[2]).toEqual({ chat: 'not_exist_chat', missing: true });

  // 检验 backfill（严格时间上界、跨分片补齐 message_0.db 里的早期文件消息、more 分页标记）
  const pageA = wechatDb.backfill(groupChat, 1_760_000_300, 10);
  expect(pageA.more).toBe(true);
  expect(pageA.messages).toHaveLength(10);
  expect(pageA.messages?.[0]?.create_time).toBeLessThan(pageA.messages?.[9]?.create_time ?? 0);

  const oldestBatch = wechatDb.backfill(groupChat, 1_760_000_135, 10);
  expect(oldestBatch.more).toBe(false);
  const fileItem = oldestBatch.messages?.[0];
  expect(fileItem).toMatchObject({
    source: 'message_0.db',
    local_id: 10,
    local_type: 49,
    view: {
      kind: 'file',
      title: '对账单.xlsx',
      size: 4096,
      sender: '小王备注',
    },
  });
});
