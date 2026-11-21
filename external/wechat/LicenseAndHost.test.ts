/**
 * P3 + P4 收官验收单测：
 * 1) 离线 Ed25519 授权门禁（现场生成临时密钥对验证有效/过期/篡改/机器码不符/缺功能位/缺失 6 类场景与 402 业务阻断）；
 * 2) 默认监听 `127.0.0.1` 防弹窗与显式 `--host`（如 `0.0.0.0` / 指定网卡 IP）自由切换；
 * 3) 纯 Bun 引擎 `PureReader` 串联加密微信库、V2 图片与 SILK 语音的端到端 HTTP 闭环（零 Python、零真实个人数据）。
 */
import * as sqlite from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fastify from 'fastify';
import * as silk from 'silk-wasm';
import * as yaml from 'yaml';
import * as licenseModule from './License.ts';
import * as mainModule from './Main.ts';
import * as serviceModule from './ReaderService.ts';
import * as readRoutes from './ReadRoutes.ts';
import * as cryptoModule from './read/Crypto.ts';
import * as mediaDatModule from './read/MediaDat.ts';
import * as readerModule from './read/PureReader.ts';
import * as voiceCacheModule from './read/VoiceCache.ts';


const tempDirs: string[] = [];

/**
 * 创建测试临时目录并登记自动清理。
 */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-wx-p3p4-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});


/**
 * 创建末尾保留 80 字节的明文 SQLite 库并填充合成数据。
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
 * 将明文 SQLite 文件逐页按 SQLCipher 4 加密写出。
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


test('License：离线 Ed25519 公钥验签覆盖缺失、篡改、机器指纹不符、缺功能位、过期与在线激活全场景', async () => {
  const dir = makeTempDir();
  const licenseFile = path.join(dir, 'license.json');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const pubHex = licenseModule.exportPublicKeyHex(publicKey);

  let currentTimeMs = 1_760_000_000_000;
  const machineFp = 'aabbccddeeff00112233445566778899';

  const guard = new licenseModule.LicenseGuard({
    licenseFile,
    publicKey: pubHex,
    machineFingerprint: machineFp,
    now: () => currentTimeMs,
  });

  const app = fastify.default({ logger: false });
  guard.mount(app);
  app.get('/jmbots/v1/info', () => ({ ok: true, name: 'wechat', protocol: 1, license: guard.getStatus().state }));
  app.get('/jmbots/v1/health', () => ({ ok: true, name: 'wechat', protocol: 1 }));
  app.get('/api/wechat-kefu/status', () => ({ accounts: [], ok: true }));
  app.post('/jmbots/v1/channel/reply', () => ({ status: 'draft' }));
  await app.ready();

  try {
    // 1. 缺失许可证：健康与授权接口 200 放行，业务接口与渠道接口 402 阻断。
    expect((await app.inject('/jmbots/v1/health')).statusCode).toBe(200);
    const noneRes = await app.inject('/jmbots/v1/license');
    expect(noneRes.statusCode).toBe(200);
    expect(noneRes.json()).toMatchObject({ ok: true, state: 'none', code: 'missing_license', machineFingerprint: machineFp });

    const blockedKefu = await app.inject('/api/wechat-kefu/status');
    expect(blockedKefu.statusCode).toBe(402);
    expect(blockedKefu.json<{ error: string; code: string }>()).toMatchObject({
      code: 'missing_license',
      error: expect.stringContaining('未授权'),
    });
    const blockedReply = await app.inject({ method: 'POST', url: '/jmbots/v1/channel/reply', payload: {} });
    expect(blockedReply.statusCode).toBe(402);
    expect(blockedReply.json()).toMatchObject({ status: 'failed', reason: expect.stringContaining('未授权') });

    // 2. 错误私钥签发 / 篡改载荷：拒绝写入且保持未授权。
    const forgedToken = licenseModule.signLicenseToken({
      product: licenseModule.LICENSE_PRODUCT_ID,
      licenseId: 'lic-forged',
      issuedAt: currentTimeMs - 1000,
      expiresAt: currentTimeMs + 60_000,
      features: [licenseModule.REQUIRED_FEATURE],
    }, wrongPrivateKey);
    const forgedPut = await app.inject({
      method: 'PUT',
      url: '/jmbots/v1/license',
      payload: { token: forgedToken },
    });
    expect(forgedPut.statusCode).toBe(400);
    expect(forgedPut.json()).toMatchObject({ ok: false, state: 'none', code: 'invalid_signature' });

    const validBasePayload: licenseModule.LicensePayload = {
      product: licenseModule.LICENSE_PRODUCT_ID,
      licenseId: 'lic-enterprise-001',
      customer: '测试席位',
      issuedAt: currentTimeMs - 5_000,
      expiresAt: currentTimeMs + 60_000,
      machineFingerprint: machineFp,
      features: [licenseModule.REQUIRED_FEATURE, 'wechat-kefu'],
    };
    const validToken = licenseModule.signLicenseToken(validTokenPayload(validBasePayload, {}), privateKey);
    const tamperedToken = `${validToken.slice(0, -4)}AAAA`;
    const tamperedPut = await app.inject({
      method: 'PUT',
      url: '/jmbots/v1/license',
      payload: { token: tamperedToken },
    });
    expect(tamperedPut.statusCode).toBe(400);
    expect(tamperedPut.json()).toMatchObject({ code: 'invalid_signature' });

    // 3. 机器指纹不匹配与缺少必需功能位：均返回 400 未授权。
    const wrongMachineToken = licenseModule.signLicenseToken(
      validTokenPayload(validBasePayload, { machineFingerprint: 'ffffffffffffffffffffffffffffffff' }),
      privateKey,
    );
    const wrongMachinePut = await app.inject({
      method: 'PUT',
      url: '/jmbots/v1/license',
      payload: { token: wrongMachineToken },
    });
    expect(wrongMachinePut.statusCode).toBe(400);
    expect(wrongMachinePut.json()).toMatchObject({ code: 'machine_mismatch' });

    const noFeatureToken = licenseModule.signLicenseToken(
      validTokenPayload(validBasePayload, { features: ['other-only'] }),
      privateKey,
    );
    const noFeaturePut = await app.inject({
      method: 'PUT',
      url: '/jmbots/v1/license',
      payload: { token: noFeatureToken },
    });
    expect(noFeaturePut.statusCode).toBe(400);
    expect(noFeaturePut.json()).toMatchObject({ code: 'missing_feature' });

    // 4. 已过期的许可证：状态明确识别为 expired。
    const alreadyExpiredToken = licenseModule.signLicenseToken(
      validTokenPayload(validBasePayload, { expiresAt: currentTimeMs - 1 }),
      privateKey,
    );
    const expiredPut = await app.inject({
      method: 'PUT',
      url: '/jmbots/v1/license',
      payload: { token: alreadyExpiredToken },
    });
    expect(expiredPut.statusCode).toBe(400);
    expect(expiredPut.json()).toMatchObject({ state: 'expired', code: 'license_expired' });

    // 5. 写入合法有效许可证：落盘激活，业务接口立即 200 放行。
    const okPut = await app.inject({
      method: 'PUT',
      url: '/jmbots/v1/license',
      payload: { token: validToken },
    });
    expect(okPut.statusCode).toBe(200);
    expect(okPut.json()).toMatchObject({
      ok: true,
      state: 'licensed',
      licenseId: 'lic-enterprise-001',
      customer: '测试席位',
    });
    expect(fs.existsSync(licenseFile)).toBe(true);
    expect((await app.inject('/api/wechat-kefu/status')).statusCode).toBe(200);

    // 6. 时钟推进越过 expiresAt 后，实时转为 expired 并重新阻断业务接口，但 /jmbots/v1/license 保持 200 报告 expired。
    currentTimeMs += 120_000;
    const expiredQuery = await app.inject('/jmbots/v1/license');
    expect(expiredQuery.statusCode).toBe(200);
    expect(expiredQuery.json()).toMatchObject({ ok: true, state: 'expired', code: 'license_expired' });
    const blockedAfterExpire = await app.inject('/api/wechat-kefu/status');
    expect(blockedAfterExpire.statusCode).toBe(402);
    expect(blockedAfterExpire.json()).toMatchObject({ state: 'expired', code: 'license_expired' });
  } finally {
    await app.close();
  }
});


/**
 * 合并生成新的许可证载荷测试副本。
 */
function validTokenPayload(
  base: licenseModule.LicensePayload,
  overrides: Partial<licenseModule.LicensePayload>,
): licenseModule.LicensePayload {
  return { ...base, ...overrides };
}


test('发行版拒绝换验签公钥：--license-pubkey 和 JMBOTS_WECHAT_PUBKEY 都报错，源码跑照常可换', () => {
  const dir = makeTempDir();
  const fakeKey = '00'.repeat(32);
  const keyArgs = ['--data', dir, '--license-pubkey', fakeKey];

  //M 发行版：命令行传、环境变量传，都要明确报错。
  expect(() => mainModule.parseCliOptions(keyArgs, {}, true)).toThrow('发行版不接受');
  const envWithKey = { JMBOTS_WECHAT_PUBKEY: fakeKey };
  expect(() => mainModule.parseCliOptions(['--data', dir], envWithKey, true)).toThrow('发行版不接受');

  //M 发行版不带换公钥参数：照常启动，用内置公钥。
  const releaseOpt = mainModule.parseCliOptions(['--data', dir], {}, true);
  expect(releaseOpt.mode).toBe('serve');
  if (releaseOpt.mode === 'serve') {
    expect(releaseOpt.licensePubkey).toBeUndefined();
  }

  //M 源码跑（默认 release=false）：换公钥照常生效，冒烟和单测靠它自签授权。
  const devOpt = mainModule.parseCliOptions(keyArgs, {});
  expect(devOpt.mode).toBe('serve');
  if (devOpt.mode === 'serve') {
    expect(devOpt.licensePubkey).toBe(fakeKey);
  }
});


test('Host 监听参数：默认绑定 127.0.0.1 免防火墙弹窗，显式传 --host 可切换至 0.0.0.0 或指定网卡 IP', async () => {
  const dir = makeTempDir();
  const dummyPage = path.join(dir, 'page.html');
  fs.writeFileSync(dummyPage, '<!doctype html><title>host-test</title>', 'utf8');

  // 1. CLI 参数解析：缺省严格为 127.0.0.1，显式 --host 或环境变量可覆盖。
  const defaultOpt = mainModule.parseCliOptions(['--data', dir, '--page', dummyPage], {});
  expect(defaultOpt.mode).toBe('serve');
  if (defaultOpt.mode === 'serve') {
    expect(defaultOpt.host).toBe('127.0.0.1');
  }

  const allInterfacesOpt = mainModule.parseCliOptions(
    ['--data', dir, '--page', dummyPage, '--host', '0.0.0.0', '--port', '39100'],
    {},
  );
  expect(allInterfacesOpt.mode).toBe('serve');
  if (allInterfacesOpt.mode === 'serve') {
    expect(allInterfacesOpt.host).toBe('0.0.0.0');
    expect(allInterfacesOpt.port).toBe(39100);
  }

  const lanIpOpt = mainModule.parseCliOptions(['--data', dir, '--page', dummyPage], {
    JMBOTS_WECHAT_HOST: '192.168.50.10',
  });
  if (lanIpOpt.mode === 'serve') {
    expect(lanIpOpt.host).toBe('192.168.50.10');
  }

  expect(() => mainModule.parseCliOptions(['--data', dir, '--host', '   '], {})).toThrow('--host');

  // 2. 验证 startWechatServer 真实将默认 127.0.0.1 与显式 0.0.0.0 传给底层 listen（拦截回绑 127.0.0.1 避免弹窗）。
  const capturedHosts: Array<{ host: string; port: number }> = [];
  if (defaultOpt.mode === 'serve') {
    const srvDefault = await mainModule.startWechatServer(defaultOpt, {
      async listen(app, opts) {
        capturedHosts.push(opts);
        return await app.listen({ port: 0, host: '127.0.0.1' });
      },
    });
    await srvDefault.close();
  }

  if (allInterfacesOpt.mode === 'serve') {
    const srvExplicit = await mainModule.startWechatServer(allInterfacesOpt, {
      async listen(app, opts) {
        capturedHosts.push(opts);
        return await app.listen({ port: 0, host: '127.0.0.1' });
      },
    });
    expect(srvExplicit.host).toBe('0.0.0.0');
    await srvExplicit.close();
  }

  expect(capturedHosts).toEqual([
    { host: '127.0.0.1', port: 0 },
    { host: '0.0.0.0', port: 39100 },
  ]);
});


test('PureReader 端到端闭环：纯 Bun 直读加密会话/联系人/消息/语音分片库与 V2 图片并通过 HTTP 路由返回', async () => {
  const root = makeTempDir();
  const dataDir = path.join(root, 'plugin-data');
  const wxRoot = path.join(root, 'xwechat_files', 'wxid_e2e_bot_1a2b');
  const dbStorage = path.join(wxRoot, 'db_storage');
  const statDir = path.join(wxRoot, 'config');
  fs.mkdirSync(dbStorage, { recursive: true });
  fs.mkdirSync(statDir, { recursive: true });

  // 1. 准备合成 UIN、V2 加密图片与 1 秒 SILK 语音。
  const uin = 98765432;
  fs.writeFileSync(path.join(statDir, `key_${String(uin)}_cfg.statistic`), '');
  const imgKeys = mediaDatModule.deriveV2ImageKeys(uin, 'wxid_e2e_bot');
  const plainJpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    crypto.randomBytes(64),
    Buffer.from([0xff, 0xd9]),
  ]);
  const imgMd5 = crypto.createHash('md5').update(plainJpeg).digest('hex');
  const headSlice = plainJpeg.subarray(0, plainJpeg.byteLength - 8);
  const tailSlice = plainJpeg.subarray(plainJpeg.byteLength - 8);
  const aesCipher = crypto.createCipheriv('aes-128-ecb', imgKeys.aesKey, null);
  const encHead = Buffer.concat([aesCipher.update(headSlice), aesCipher.final()]);
  const maskedTail = Buffer.from(tailSlice.map((b) => b ^ imgKeys.xorKey));
  const v2Header = Buffer.alloc(15);
  mediaDatModule.V2_MAGIC.copy(v2Header, 0);
  v2Header.writeUInt32LE(encHead.byteLength, 6);
  v2Header.writeUInt32LE(maskedTail.byteLength, 10);
  const v2Dat = Buffer.concat([v2Header, encHead, maskedTail]);

  const customerWxid = 'wxid_vip_client';
  const chatHash = crypto.createHash('md5').update(customerWxid, 'utf8').digest('hex');
  const attachImgDir = path.join(wxRoot, 'msg', 'attach', chatHash, '2026-11', 'Img');
  fs.mkdirSync(attachImgDir, { recursive: true });
  fs.writeFileSync(path.join(attachImgDir, `${imgMd5}_t.dat`), v2Dat);

  const pcm = new Int16Array(24_000);
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 10_000);
  }
  const silkEncoded = await silk.encode(pcm, 24_000);

  // 2. 构建并加密 session.db、contact.db、message_0.db、media_0.db。
  const msgTime = Math.floor(new Date('2026-11-18T10:00:00Z').getTime() / 1000);
  const tableHash = crypto.createHash('md5').update(customerWxid, 'utf8').digest('hex');
  const msgTable = `Msg_${tableHash}`;

  const plainSession = path.join(root, 'p_session.db');
  const plainContact = path.join(root, 'p_contact.db');
  const plainMsg0 = path.join(root, 'p_msg0.db');
  const plainMedia0 = path.join(root, 'p_media0.db');

  buildReservedPlainDb(plainSession, (db) => {
    db.exec(`
      CREATE TABLE SessionTable (
        username TEXT PRIMARY KEY,
        unread_count INTEGER,
        summary TEXT,
        last_timestamp INTEGER,
        last_msg_type INTEGER,
        last_msg_sender TEXT,
        last_sender_display_name TEXT
      );
    `);
    db.query('INSERT INTO SessionTable VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      customerWxid, 2, '你好客服', msgTime + 2, 1, customerWxid, 'VIP客户老张',
    );
  });

  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_e2e_bot', '官方客服号', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run(customerWxid, '张先生', 'VIP客户老张');
  });

  buildReservedPlainDb(plainMsg0, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_e2e_bot'), (2, '${customerWxid}');
      CREATE TABLE [${msgTable}] (
        local_id INTEGER PRIMARY KEY,
        local_type INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        real_sender_id INTEGER,
        message_content BLOB,
        WCDB_CT_message_content INTEGER,
        packed_info_data BLOB
      );
    `);
    db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
      10, 1, msgTime, 2, '请问你们今天发货吗？', 0,
    );
    const imgXml = `<msg><img md5="${imgMd5}" length="1024" /></msg>`;
    db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
      11, 3, msgTime + 1, 2, imgXml, 0,
    );
    const voiceXml = '<msg><voicemsg voicelength="1000" /></msg>';
    db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
      12, 34, msgTime + 2, 2, voiceXml, 0,
    );
  });

  buildReservedPlainDb(plainMedia0, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, '${customerWxid}');
      CREATE TABLE VoiceInfo (
        chat_name_id INTEGER NOT NULL,
        local_id INTEGER NOT NULL,
        voice_data BLOB NOT NULL,
        voicelength INTEGER NOT NULL
      );
    `);
    db.query('INSERT INTO VoiceInfo VALUES (?, ?, ?, ?)').run(1, 12, Buffer.from(silkEncoded.data), 1000);
  });

  const masterKey = crypto.createHash('sha256').update('e2e-pure-bun-master-key').digest();
  const s1 = crypto.createHash('md5').update('s1').digest();
  const s2 = crypto.createHash('md5').update('s2').digest();
  const s3 = crypto.createHash('md5').update('s3').digest();
  const s4 = crypto.createHash('md5').update('s4').digest();

  encryptSqliteFile(plainSession, path.join(dbStorage, 'session', 'session.db'), masterKey, s1);
  encryptSqliteFile(plainContact, path.join(dbStorage, 'contact', 'contact.db'), masterKey, s2);
  encryptSqliteFile(plainMsg0, path.join(dbStorage, 'message', 'message_0.db'), masterKey, s3);
  encryptSqliteFile(plainMedia0, path.join(dbStorage, 'message', 'media_0.db'), masterKey, s4);

  // 3. 运行纯 Bun 账号发现并写入已验真的 all_keys.json。
  const discovered = readerModule.discoverAccountsToData(dataDir, path.join(root, 'xwechat_files'));
  expect(discovered).toHaveLength(1);
  const accId = discovered[0]!.id;
  expect(discovered[0]!.wxid).toBe('wxid_e2e_bot');

  const keyHex = masterKey.toString('hex');
  fs.writeFileSync(
    path.join(dataDir, accId, 'all_keys.json'),
    JSON.stringify({
      'session/session.db': { enc_key: keyHex },
      'contact/contact.db': { enc_key: keyHex },
      'message/message_0.db': { enc_key: keyHex },
      'message/media_0.db': { enc_key: keyHex },
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'accounts.yaml'),
    yaml.stringify([{ id: accId, folder: 'wxid_e2e_bot_1a2b', wxid: 'wxid_e2e_bot', nickname: '官方客服号', status: 'connected' }]),
    'utf8',
  );

  // 4. 启动纯 Bun 读取服务并逐一请求 HTTP 客服接口。
  const localDb = new sqlite.Database(':memory:');
  const pureReader = new readerModule.Reader(dataDir, '');
  const voiceCache = new voiceCacheModule.VoiceAudio(pureReader, path.join(dataDir, 'message'));
  const readerSvc = new serviceModule.ReaderService(pureReader, localDb, {
    intervalMs: 3000,
    chatLimit: 100,
    archiveAll: false,
  });
  const app = fastify.default({ logger: false });
  readRoutes.mountReadRoutes(app, localDb, readerSvc, voiceCache);
  await app.ready();

  try {
    const statusRes = await app.inject('/api/wechat-kefu/status');
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toMatchObject({
      accounts: [{ id: accId, wxid: 'wxid_e2e_bot', nickname: '官方客服号' }],
    });

    const chatsRes = await app.inject(`/api/wechat-kefu/chats?account=${encodeURIComponent(accId)}`);
    expect(chatsRes.statusCode).toBe(200);
    expect(chatsRes.json()).toMatchObject([
      { username: customerWxid, chat: 'VIP客户老张', unread: 2, watch: false },
    ]);

    const msgsUrl = `/api/wechat-kefu/messages?account=${encodeURIComponent(accId)}&chat=${encodeURIComponent(customerWxid)}`;
    const msgsRes = await app.inject(msgsUrl);
    expect(msgsRes.statusCode).toBe(200);
    const msgs = msgsRes.json<Array<{ local_id: number; kind: string; text: string; source: string }>>();
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => [m.local_id, m.kind, m.text])).toEqual([
      [10, 'text', '请问你们今天发货吗？'],
      [11, 'image', '[图片]'],
      [12, 'voice', '[语音 1 秒]'],
    ]);

    const imgQuery = new URLSearchParams({
      account: accId,
      chat: customerWxid,
      source: 'message_0.db',
      local_id: '11',
    });
    const imgRes = await app.inject(`/api/wechat-kefu/image?${imgQuery.toString()}`);
    expect(imgRes.statusCode).toBe(200);
    expect(imgRes.headers['content-type']).toBe('image/jpeg');
    expect(imgRes.rawPayload.equals(plainJpeg)).toBe(true);

    const voiceQuery = new URLSearchParams({
      account: accId,
      chat: customerWxid,
      source: 'message_0.db',
      local_id: '12',
    });
    const voiceRes = await app.inject(`/api/wechat-kefu/voice?${voiceQuery.toString()}`);
    expect(voiceRes.statusCode).toBe(200);
    expect(voiceRes.headers['content-type']).toBe('audio/wav');
    expect(silk.isWav(voiceRes.rawPayload)).toBe(true);
  } finally {
    await readerSvc.drain();
    await app.close();
    localDb.close();
  }
});
