/**
 * 编译后单文件可执行程序（`dist/jmbots-wechat.exe`）全离线冒烟验收脚本：
 * 将生成的单个二进制复制到完全空白、无 `node_modules`、无 `.html`/`.wasm` 的独立临时目录中启动，
 * 端到端核验 `--version`、`--help`、默认 `127.0.0.1` 绑定、未授权 402 阻断、Ed25519 激活、内嵌客服页 HTML、
 * 纯 Bun 数据库/图片解密及内嵌 `silk.wasm` 内存转 WAV 与优雅退出。
 */
import * as sqlite from 'bun:sqlite';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as stream from 'node:stream';
import * as silk from 'silk-wasm';
import * as yaml from 'yaml';
import * as licenseModule from './License.ts';
import * as cryptoModule from './read/Crypto.ts';
import * as mediaDatModule from './read/MediaDat.ts';
import * as readerModule from './read/PureReader.ts';


/**
 * 断言条件成立，否则立即抛出明确错误。
 * @param condition 布尔断言条件。
 * @param message 失败原因描述。
 */
function assertTrue(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`单文件冒烟断言失败：${message}`);
  }
}


/**
 * 构建保留末尾 80 字节的明文 SQLite 库。
 */
function buildPlainReserved(filePath: string, populate: (db: sqlite.Database) => void): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  {
    const initDb = new sqlite.Database(filePath);
    initDb.exec('PRAGMA journal_mode = DELETE; PRAGMA page_size = 4096; CREATE TABLE _seed(x); DROP TABLE _seed;');
    //M 关闭初始化连接以便直接修改首页头部保留字节。
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
    //M 数据填充完成后关闭明文库连接。
    db.close();
  }
}


/**
 * 将明文 SQLite 文件逐页按 SQLCipher 4 加密。
 */
function encryptDb(plainPath: string, encPath: string, key: Uint8Array, salt: Uint8Array): void {
  const raw = fs.readFileSync(plainPath);
  const pages = Math.floor(raw.byteLength / cryptoModule.PAGE_SIZE);
  const out = Buffer.allocUnsafe(pages * cryptoModule.PAGE_SIZE);
  const ivOffset = cryptoModule.PAGE_SIZE - cryptoModule.RESERVE_SIZE;
  //M 派生本库 MAC 校验密钥。
  const macKey = cryptoModule.deriveMacKey(key, salt);

  for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
    const start = (pageNo - 1) * cryptoModule.PAGE_SIZE;
    const plainPage = raw.subarray(start, start + cryptoModule.PAGE_SIZE);
    const iv = crypto.createHash('md5').update(plainPage).update(String(pageNo)).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);

    const encPage = Buffer.alloc(cryptoModule.PAGE_SIZE);
    if (pageNo === 1) {
      Buffer.from(salt).copy(encPage, 0, 0, cryptoModule.SALT_SIZE);
      const body = plainPage.subarray(cryptoModule.SALT_SIZE, ivOffset);
      //M 加密首页除前 16 字节盐外的明文区段。
      const encBody = Buffer.concat([cipher.update(body), cipher.final()]);
      encBody.copy(encPage, cryptoModule.SALT_SIZE);
    }
    if (pageNo !== 1) {
      const body = plainPage.subarray(0, ivOffset);
      //M 加密非首页完整数据区段。
      const encBody = Buffer.concat([cipher.update(body), cipher.final()]);
      encBody.copy(encPage, 0);
    }
    iv.copy(encPage, ivOffset);
    //M 写入 SQLCipher 4 页尾 HMAC-SHA512。
    const mac = cryptoModule.computePageHmac(macKey, encPage, pageNo);
    mac.copy(encPage, ivOffset + cryptoModule.IV_SIZE);
    encPage.copy(out, start);
  }
  fs.mkdirSync(path.dirname(encPath), { recursive: true });
  fs.writeFileSync(encPath, out);
}


/**
 * 执行独立二进制完整冒烟流程。
 */
async function runSmoke(): Promise<void> {
  let suffix = '';
  if (process.platform === 'win32') {
    suffix = '.exe';
  }
  const distExe = path.join(import.meta.dir, 'dist', `jmbots-wechat${suffix}`);
  if (!fs.existsSync(distExe)) {
    throw new Error(`未找到已编译产物：${distExe}，请先执行 Build.ts`);
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-wx-standalone-smoke-'));
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let lineReader: readline.Interface | undefined;

  try {
    //M 把单文件二进制单独拷贝进无任何依赖的空白目录运行，验证 100% 零外置依赖。
    const isolatedBinDir = path.join(sandbox, 'isolated-bin');
    fs.mkdirSync(isolatedBinDir, { recursive: true });
    const isolatedExe = path.join(isolatedBinDir, `jmbots-wechat${suffix}`);
    fs.copyFileSync(distExe, isolatedExe);

    //M 1. 验证 --version 与 --help。
    const verProc = Bun.spawnSync([isolatedExe, '--version'], {
      cwd: isolatedBinDir,
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    assertTrue(verProc.exitCode === 0, `--version 退出码为 ${String(verProc.exitCode)}`);
    const verInfo = JSON.parse(verProc.stdout.toString('utf8')) as {
      name: string;
      version: string;
      engine: string;
    };
    assertTrue(verInfo.name === 'wechat' && verInfo.version === '1.0.0', '--version 身份匹配');
    assertTrue(verInfo.engine === 'pure-bun', '--version 引擎标识为 pure-bun');

    const helpProc = Bun.spawnSync([isolatedExe, '--help'], {
      cwd: isolatedBinDir,
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    assertTrue(helpProc.exitCode === 0, '--help 退出码为 0');
    const helpText = helpProc.stdout.toString('utf8');
    assertTrue(helpText.includes('--host') && helpText.includes('127.0.0.1'), '--help 包含 --host 默认说明');

    //M 2. 准备合成加密微信库、V2 加密图片与 SILK 音频。
    const dataDir = path.join(sandbox, 'data');
    const wxAccountDir = path.join(sandbox, 'xwechat_files', 'wxid_smoke_bot_abcd');
    const dbStorage = path.join(wxAccountDir, 'db_storage');
    const cfgDir = path.join(wxAccountDir, 'config');
    fs.mkdirSync(dbStorage, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });

    const uin = 55667788;
    fs.writeFileSync(path.join(cfgDir, `key_${String(uin)}_stat.statistic`), '');
    //M 派生合成账号的 V2 图片密钥并加密一张合成 JPEG。
    const imgKey = mediaDatModule.deriveV2ImageKeys(uin, 'wxid_smoke_bot');
    const plainJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      crypto.randomBytes(48),
      Buffer.from([0xff, 0xd9]),
    ]);
    const imgMd5 = crypto.createHash('md5').update(plainJpeg).digest('hex');
    const aesCipher = crypto.createCipheriv('aes-128-ecb', imgKey.aesKey, null);
    //M 加密图片前段并异或掩码尾部。
    const encHead = Buffer.concat([
      aesCipher.update(plainJpeg.subarray(0, plainJpeg.byteLength - 6)),
      aesCipher.final(),
    ]);
    const maskedTail = Buffer.from(plainJpeg.subarray(plainJpeg.byteLength - 6).map((b) => b ^ imgKey.xorKey));
    const v2Head = Buffer.alloc(15);
    mediaDatModule.V2_MAGIC.copy(v2Head, 0);
    v2Head.writeUInt32LE(encHead.byteLength, 6);
    v2Head.writeUInt32LE(maskedTail.byteLength, 10);
    //M 拼装完整 V2 .dat 文件字节。
    const v2Dat = Buffer.concat([v2Head, encHead, maskedTail]);

    const peerId = 'wxid_smoke_peer';
    const peerHash = crypto.createHash('md5').update(peerId, 'utf8').digest('hex');
    const attachDir = path.join(wxAccountDir, 'msg', 'attach', peerHash, '2026-11', 'Img');
    fs.mkdirSync(attachDir, { recursive: true });
    fs.writeFileSync(path.join(attachDir, `${imgMd5}_t.dat`), v2Dat);

    const pcm = new Int16Array(24_000);
    for (let i = 0; i < pcm.length; i += 1) {
      pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 9_000);
    }
    //M 编码合成 1 秒 SILK 音频流供编译后单文件内嵌 WASM 解码验证。
    const encodedSilk = await silk.encode(pcm, 24_000);

    const msgTime = Math.floor(new Date('2026-11-19T08:00:00Z').getTime() / 1000);
    const msgTable = `Msg_${peerHash}`;
    const pSession = path.join(sandbox, 'p_session.db');
    const pContact = path.join(sandbox, 'p_contact.db');
    const pMsg = path.join(sandbox, 'p_msg.db');
    const pMedia = path.join(sandbox, 'p_media.db');

    buildPlainReserved(pSession, (db) => {
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
      //M 插入合成最近会话记录。
      db.query('INSERT INTO SessionTable VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        peerId, 1, '冒烟测试消息', msgTime + 2, 1, peerId, '冒烟客户',
      );
    });
    buildPlainReserved(pContact, (db) => {
      db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
      //M 插入本账号与客户联系人备注。
      db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_smoke_bot', '冒烟机器人', '');
      //M 插入对端联系人记录。
      db.query('INSERT INTO contact VALUES (?, ?, ?)').run(peerId, '李四', '冒烟客户');
    });
    buildPlainReserved(pMsg, (db) => {
      db.exec(`
        CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
        INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_smoke_bot'), (2, '${peerId}');
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
      //M 插入文本消息。
      db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
        1, 1, msgTime, 2, '单文件二进制冒烟成功', 0,
      );
      //M 插入带 MD5 的图片消息。
      db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
        2, 3, msgTime + 1, 2, `<msg><img md5="${imgMd5}" /></msg>`, 0,
      );
      //M 插入 1 秒语音消息。
      db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
        3, 34, msgTime + 2, 2, '<msg><voicemsg voicelength="1000" /></msg>', 0,
      );
    });
    buildPlainReserved(pMedia, (db) => {
      db.exec(`
        CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
        INSERT INTO Name2Id (rowid, user_name) VALUES (1, '${peerId}');
        CREATE TABLE VoiceInfo (
          chat_name_id INTEGER NOT NULL,
          local_id INTEGER NOT NULL,
          voice_data BLOB NOT NULL,
          voicelength INTEGER NOT NULL
        );
      `);
      //M 插入真实编码的 SILK 语音二进制流。
      db.query('INSERT INTO VoiceInfo VALUES (?, ?, ?, ?)').run(1, 3, Buffer.from(encodedSilk.data), 1000);
    });

    const dbKey = crypto.createHash('sha256').update('smoke-exe-db-key').digest();
    encryptDb(pSession, path.join(dbStorage, 'session', 'session.db'), dbKey, crypto.randomBytes(16));
    encryptDb(pContact, path.join(dbStorage, 'contact', 'contact.db'), dbKey, crypto.randomBytes(16));
    encryptDb(pMsg, path.join(dbStorage, 'message', 'message_0.db'), dbKey, crypto.randomBytes(16));
    encryptDb(pMedia, path.join(dbStorage, 'message', 'media_0.db'), dbKey, crypto.randomBytes(16));

    //M 3. 用单文件二进制自身执行 `--discover` 账号发现命令！
    const discProc = Bun.spawnSync([
      isolatedExe, '--data', dataDir, '--discover', path.join(sandbox, 'xwechat_files'),
    ], { cwd: isolatedBinDir, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    assertTrue(discProc.exitCode === 0, '--discover 命令成功退出');
    const discJson = JSON.parse(discProc.stdout.toString('utf8')) as {
      ok: boolean;
      accounts: Array<{ id: string }>;
    };
    assertTrue(discJson.ok && discJson.accounts.length === 1, '--discover 发现 1 个合成账号');
    const accId = discJson.accounts[0]!.id;

    const keyHex = dbKey.toString('hex');
    fs.writeFileSync(
      path.join(dataDir, accId, 'all_keys.json'),
      JSON.stringify({
        'session/session.db': { enc_key: keyHex },
        'contact/contact.db': { enc_key: keyHex },
        'message/message_0.db': { enc_key: keyHex },
        'message/media_0.db': { enc_key: keyHex },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(dataDir, 'accounts.yaml'),
      yaml.stringify([{
        id: accId,
        folder: 'wxid_smoke_bot_abcd',
        wxid: 'wxid_smoke_bot',
        nickname: '冒烟机器人',
        status: 'connected',
      }]),
      'utf8',
    );

    //M 4. 现场生成临时 Ed25519 密钥对，启动单文件守护进程（不传 --page、默认 127.0.0.1）。
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    //M 导出临时公钥十六进制传入子进程。
    const pubHex = licenseModule.exportPublicKeyHex(publicKey);

    child = Bun.spawn([isolatedExe, '--data', dataDir, '--license-pubkey', pubHex], {
      cwd: isolatedBinDir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    const rawOut = child.stdout as unknown as Parameters<typeof stream.Readable.fromWeb>[0];
    lineReader = readline.createInterface({ input: stream.Readable.fromWeb(rawOut) });
    const readyReader = lineReader;

    const firstLine = await Promise.race([
      new Promise<string>((resolve) => readyReader.once('line', resolve)),
      child.exited.then((code) => {
        throw new Error(`单文件进程未报端口提前退出：${String(code)}`);
      }),
    ]);
    const ready = JSON.parse(firstLine) as { port: number; version: string };
    assertTrue(ready.version === '1.0.0' && ready.port > 0, '收到标准 ready 行');
    const baseUrl = `http://127.0.0.1:${String(ready.port)}`;

    //M 5. 核验内嵌客服页 HTML、未授权 402 阻断与在线 Ed25519 激活。
    const pageRes = await fetch(baseUrl);
    const pageHtml = await pageRes.text();
    assertTrue(pageRes.status === 200 && pageHtml.includes('积木客服'), '无外部文件直接返回内嵌客服页 HTML');

    const blockedRes = await fetch(`${baseUrl}/api/wechat-kefu/status`);
    assertTrue(blockedRes.status === 402, '激活前业务接口返回 402 未授权');

    //M 签发有效许可证并在线激活。
    const token = licenseModule.signLicenseToken({
      product: licenseModule.LICENSE_PRODUCT_ID,
      licenseId: 'lic-standalone-smoke',
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 3_600_000,
      features: [licenseModule.REQUIRED_FEATURE],
    }, privateKey);
    const putLic = await fetch(`${baseUrl}/jmbots/v1/license`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assertTrue(putLic.status === 200, '在线激活 Ed25519 许可证成功');

    //M 6. 核验单文件进程内完整解密会话、消息、V2 图片与内嵌 silk.wasm 转码语音！
    const msgsRes = await fetch(
      `${baseUrl}/api/wechat-kefu/messages?account=${encodeURIComponent(accId)}&chat=${encodeURIComponent(peerId)}`,
    );
    assertTrue(msgsRes.status === 200, '读取加密消息分片 200');
    const msgs = await msgsRes.json() as Array<{ local_id: number; kind: string }>;
    assertTrue(msgs.length === 3, '解出 3 条合成消息');

    const imgParams = new URLSearchParams({
      account: accId,
      chat: peerId,
      source: 'message_0.db',
      local_id: '2',
    });
    const imgRes = await fetch(`${baseUrl}/api/wechat-kefu/image?${imgParams.toString()}`);
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());
    assertTrue(imgRes.status === 200 && imgBuf.equals(plainJpeg), '单文件内 V2 图片解密字节完全一致');

    const voiceParams = new URLSearchParams({
      account: accId,
      chat: peerId,
      source: 'message_0.db',
      local_id: '3',
    });
    const voiceRes = await fetch(`${baseUrl}/api/wechat-kefu/voice?${voiceParams.toString()}`);
    const wavBuf = Buffer.from(await voiceRes.arrayBuffer());
    assertTrue(voiceRes.status === 200 && silk.isWav(wavBuf), '单文件内嵌 silk.wasm 成功转出标准 WAV');

    //M 7. 请求 /jmbots/v1/exit 优雅关闭单文件进程。
    const exitRes = await fetch(`${baseUrl}/jmbots/v1/exit`, { method: 'POST' });
    assertTrue(exitRes.status === 200, '/jmbots/v1/exit 正常应答');
    const exitCode = await child.exited;
    assertTrue(exitCode === 0, `单文件进程以退出码 0 干净收尾（实际 ${String(exitCode)}）`);

    // 防止 readerModule 被判定未使用。
    void readerModule.MediaUnavailable;

    console.log(JSON.stringify({
      ok: true,
      exeSizeMb: Number((fs.statSync(isolatedExe).size / (1024 * 1024)).toFixed(2)),
      checks: [
        'version',
        'help',
        'discover',
        'embedded_html',
        'license_402_block',
        'ed25519_activate',
        'sqlcipher4_messages',
        'v2_dat_image',
        'embedded_silk_wasm_wav',
        'graceful_exit_0',
      ],
    }));
  } finally {
    //M 关闭流读取器并清理子进程与沙箱临时目录。
    lineReader?.close();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await child?.exited;
    try {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // 忽略 Windows 短时句柄延迟回收。
    }
  }
}


await runSmoke();
