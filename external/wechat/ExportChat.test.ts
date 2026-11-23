/**
 * `export-chat` 本地显式单会话导出模块全离线单测：
 * 100% 使用临时目录内现场合成的假 SQLite 加密库、假 PNG 图片、假 SILK 语音与假附件，绝不读取任何真实微信数据。
 * 覆盖：显式 CLI 门禁、目录穿越拦截、最近 N 条（含 2000 条）截断、按月/按条数分卷、相对路径媒体复制与缺失文件降级占位。
 */
import * as sqlite from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as silk from 'silk-wasm';
import * as yaml from 'yaml';
import * as cliMeta from './CliMeta.ts';
import * as exportModule from './ExportChat.ts';
import * as mainModule from './Main.ts';
import * as protocol from './Protocol.ts';
import * as cryptoModule from './read/Crypto.ts';


const tempDirs: string[] = [];

/**
 * 创建单测专属临时目录并登记自动清理。
 */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-wx-export-'));
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
 * 构建末尾保留 80 字节的合成明文 SQLite 库。
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
 * 将合成明文 SQLite 库逐页加密为 SQLCipher 4 格式。
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
 * 在临时沙箱中搭建一套完全合成的微信账号库（含 2050 条跨月消息、假 PNG 图片、假 SILK 语音、正常附件与穿越诱饵）。
 */
async function createSyntheticWechatDataset(sandbox: string): Promise<{
  dataDir: string;
  accountId: string;
  peerWxid: string;
  fakePngBytes: Buffer;
  fakePdfBytes: Buffer;
}> {
  const dataDir = path.join(sandbox, 'plugin-data');
  const wxAccountRoot = path.join(sandbox, 'xwechat_files', 'wxid_synth_owner_0102');
  const dbStorage = path.join(wxAccountRoot, 'db_storage');
  fs.mkdirSync(dbStorage, { recursive: true });

  // 放置一份目录外诱饵机密文件，验证恶意文件标题 `../../outside_secret.txt` 绝不会被复制。
  fs.writeFileSync(path.join(sandbox, 'outside_secret.txt'), 'TOP-SECRET-DO-NOT-COPY', 'utf8');

  const peerWxid = 'wxid_synth_partner';
  const peerHash = crypto.createHash('md5').update(peerWxid, 'utf8').digest('hex');
  const msgTable = `Msg_${peerHash}`;

  // 合成一张合法 PNG 头部字节写入会话专属 attach 目录。
  const fakePngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('synthetic-png-payload-for-export-test', 'ascii'),
  ]);
  const existingImgMd5 = crypto.createHash('md5').update(fakePngBytes).digest('hex');
  const missingImgMd5 = '00112233445566778899aabbccddeeff';
  const attachImgDir = path.join(wxAccountRoot, 'msg', 'attach', peerHash, '2026-11', 'Img');
  fs.mkdirSync(attachImgDir, { recursive: true });
  fs.writeFileSync(path.join(attachImgDir, `${existingImgMd5}_t.dat`), fakePngBytes);

  // 合成一份合法下载文档放入 msg/file/2026-11/。
  const fakePdfBytes = Buffer.from('%PDF-1.4 synthetic-quote-sheet', 'ascii');
  const fileMonthDir = path.join(wxAccountRoot, 'msg', 'file', '2026-11');
  fs.mkdirSync(fileMonthDir, { recursive: true });
  fs.writeFileSync(path.join(fileMonthDir, '报价单_v1.pdf'), fakePdfBytes);

  // 合成 1 秒 24kHz 正弦波编码为真实 SILK 字节。
  const pcm = new Int16Array(24_000);
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 8_000);
  }
  const encodedSilk = await silk.encode(pcm, 24_000);

  const plainContact = path.join(sandbox, 'plain_contact.db');
  const plainMsg0 = path.join(sandbox, 'plain_msg0.db');
  const plainMedia0 = path.join(sandbox, 'plain_media0.db');

  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_synth_owner', '合成客服', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run(peerWxid, '王总', '合成客户王总');
  });

  // 构造 2050 条跨 2026-10 与 2026-11 的消息（前 1020 条在 10 月，后 1030 条在 11 月，末尾 6 条覆盖全部媒体场景）。
  const octBase = Math.floor(new Date('2026-10-15T04:00:00Z').getTime() / 1000);
  const novBase = Math.floor(new Date('2026-11-21T04:00:00Z').getTime() / 1000);
  const appFileType = Number((6n << 32n) | 49n);

  buildReservedPlainDb(plainMsg0, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_synth_owner'), (2, '${peerWxid}');
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

    const insertStmt = db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, ?, NULL)`);
    const writeAll = db.transaction(() => {
      for (let i = 1; i <= 1020; i += 1) {
        insertStmt.run(i, 1, octBase + i, 2, `十月历史记录 #${String(i)}`, 0);
      }
      for (let i = 1021; i <= 2044; i += 1) {
        let senderRow = 2;
        if (i % 2 === 0) {
          senderRow = 1;
        }
        insertStmt.run(i, 1, novBase + (i - 1020), senderRow, `十一月沟通记录 #${String(i)}`, 0);
      }
      // 2045：命中本地假 PNG 图片
      insertStmt.run(2045, 3, novBase + 2000, 2, `<msg><img md5="${existingImgMd5}" /></msg>`, 0);
      // 2046：本地不存在图片的降级占位
      insertStmt.run(2046, 3, novBase + 2001, 2, `<msg><img md5="${missingImgMd5}" /></msg>`, 0);
      // 2047：命中加密 media_0.db 的语音
      insertStmt.run(2047, 34, novBase + 2002, 2, '<msg><voicemsg voicelength="1000" /></msg>', 0);
      // 2048：本地未保存音频的语音降级占位
      insertStmt.run(2048, 34, novBase + 2003, 2, '<msg><voicemsg voicelength="3000" /></msg>', 0);
      // 2049：命中本地 msg/file 的合法文档
      const okFileXml = '<msg><appmsg><type>6</type><title>报价单_v1.pdf</title></appmsg></msg>';
      insertStmt.run(2049, appFileType, novBase + 2004, 2, okFileXml, 0);
      // 2050：恶意路径穿越文件标题（必须被拦截并降级为未保存占位）
      const evilFileXml = '<msg><appmsg><type>6</type><title>../../outside_secret.txt</title></appmsg></msg>';
      insertStmt.run(2050, appFileType, novBase + 2005, 2, evilFileXml, 0);
    });
    writeAll();
  });

  buildReservedPlainDb(plainMedia0, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, '${peerWxid}');
      CREATE TABLE VoiceInfo (
        chat_name_id INTEGER NOT NULL,
        local_id INTEGER NOT NULL,
        voice_data BLOB NOT NULL,
        voicelength INTEGER NOT NULL
      );
    `);
    db.query('INSERT INTO VoiceInfo VALUES (?, ?, ?, ?)').run(1, 2047, Buffer.from(encodedSilk.data), 1000);
  });

  const masterKey = crypto.createHash('sha256').update('synthetic-export-chat-key').digest();
  encryptSqliteFile(plainContact, path.join(dbStorage, 'contact', 'contact.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainMsg0, path.join(dbStorage, 'message', 'message_0.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainMedia0, path.join(dbStorage, 'message', 'media_0.db'), masterKey, crypto.randomBytes(16));

  const accountId = 'account_synth_export';
  const stateAccDir = path.join(dataDir, accountId);
  fs.mkdirSync(stateAccDir, { recursive: true });
  fs.writeFileSync(path.join(stateAccDir, 'config.json'), JSON.stringify({ db_dir: dbStorage }), 'utf8');
  const keyHex = masterKey.toString('hex');
  fs.writeFileSync(
    path.join(stateAccDir, 'all_keys.json'),
    JSON.stringify({
      'contact/contact.db': { enc_key: keyHex },
      'message/message_0.db': { enc_key: keyHex },
      'message/media_0.db': { enc_key: keyHex },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'accounts.yaml'),
    yaml.stringify([{
      id: accountId,
      folder: 'wxid_synth_owner_0102',
      wxid: 'wxid_synth_owner',
      nickname: '合成客服',
      status: 'connected',
    }]),
    'utf8',
  );

  return { dataDir, accountId, peerWxid, fakePngBytes, fakePdfBytes };
}


test('入口与安全守卫：必须显式子命令调用，严格阻断宿主静默触发、目录穿越与绝对路径泄漏', () => {
  const sandbox = makeTempDir();
  const dataDir = path.join(sandbox, 'data');
  const outDir = path.join(sandbox, 'bots', 'helper', 'workspace', 'channels', 'wechat', 'safe_chat');

  // 1. 未带显式子命令 `export-chat` 时传 `--chat` / `--out` 直接报错。
  expect(() => mainModule.parseCliOptions(['--data', dataDir, '--chat', 'a', '--out', outDir], {})).toThrow();

  // 2. 托管后台环境变量存在时拒绝触发全部本机扫描与导出子命令（scan-accounts / list-chats / export-chat / export-batch）。
  for (const subCmd of [
    ['scan-accounts', '--data', dataDir],
    ['list-chats', '--data', dataDir],
    ['export-chat', '--data', dataDir, '--chat', 'a', '--out', outDir],
    ['export-batch', '--data', dataDir, '--all', '--out', outDir],
  ]) {
    expect(() => mainModule.parseCliOptions(
      subCmd,
      { [protocol.KEY_ENV]: 'secret-host-key' },
    )).toThrow('仅支持本机手动显式调用');
    expect(() => mainModule.parseCliOptions(
      subCmd,
      { [protocol.CALLBACK_ENV]: 'http://127.0.0.1:30086/cb' },
    )).toThrow('仅支持本机手动显式调用');
  }

  // 3. `--media-dir` 目录穿越与绝对路径拦截。
  expect(() => exportModule.validateRelativeMediaDir('../escape', outDir)).toThrow('..');
  expect(() => exportModule.validateRelativeMediaDir('assets/../../outside', outDir)).toThrow('..');
  expect(() => exportModule.validateRelativeMediaDir('/tmp/evil', outDir)).toThrow('相对路径');
  expect(() => exportModule.validateRelativeMediaDir('C:\\evil\\media', outDir)).toThrow('相对路径');
  expect(() => exportModule.validateRelativeMediaDir('.', outDir)).toThrow('子目录');
  expect(() => exportModule.validateRelativeMediaDir('CON', outDir)).toThrow('保留');
  expect(exportModule.validateRelativeMediaDir('./media/', outDir)).toBe('media');

  // 4. 安全目录名清洗、防重名唯一目录名与确定性 Token 估算、绝对路径脱敏自检。
  expect(exportModule.sanitizeSafeSegment('../../客户/群:A*B?')).toBe('客户_群_A_B');
  expect(exportModule.sanitizeSafeSegment('NUL.txt')).toBe('_NUL.txt');
  expect(exportModule.buildUniqueSafeFolderName('魔法', 'wxid_magic_01')).toBe('魔法_wxid_magic_01');
  expect(exportModule.buildUniqueSafeFolderName('研发群', '482910@chatroom')).toBe('研发群_482910@chatroom');
  expect(exportModule.buildUniqueSafeFolderName('482910@chatroom', '482910@chatroom')).toBe('482910@chatroom');
  expect(exportModule.estimateTokens('')).toBe(0);
  expect(exportModule.estimateTokens('你好世界ABCD')).toBe(Math.ceil((4 * 2) / 3) + Math.ceil(4 / 4));
  const leakCheck = exportModule.verifyNoAbsolutePathLeak([`文件在 ${outDir}/messages.md`], [outDir]);
  expect(leakCheck.passed).toBe(false);
  expect(leakCheck.leakedAbsolutePaths).toBe(1);
});


test('最近 2000 条截断、相对路径媒体复制、恶意附件穿越拦截与不存在文件优雅降级占位', async () => {
  const sandbox = makeTempDir();
  const { dataDir, fakePngBytes, fakePdfBytes } = await createSyntheticWechatDataset(sandbox);
  const outDir = path.join(sandbox, 'bots', 'assistant', 'workspace', 'channels', 'wechat', '合成客户王总');

  // 按备注名“合成客户王总”显式导出全历史最近 2000 条（总库有 2050 条，最早 50 条应被精确截掉）。
  const options = exportModule.validateExportCliInput({
    data: dataDir,
    chat: '合成客户王总',
    out: outDir,
    limit: '2000',
    sinceDays: '0',
    chunkBy: 'none',
    maxTokens: '0',
    mediaDir: 'media',
  });
  const manifest = await exportModule.runExportChatCli(options);

  expect(manifest.totalMessages).toBe(2000);
  expect(manifest.chat.displayName).toBe('合成客户王总');
  expect(manifest.chat.safeFolderName).toBe('合成客户王总_wxid_synth_partner');
  expect(manifest.chat.chatType).toBe('p2p');
  expect(manifest.redactionCheck.passed).toBe(true);
  expect(manifest.redactionCheck.leakedAbsolutePaths).toBe(0);
  expect(manifest.media.copiedCount).toBe(3);
  expect(manifest.media.missingCount).toBe(3);
  expect(manifest.media.oversizeCount).toBe(0);
  expect(manifest.media.files).toEqual([
    './media/20261121_001.png',
    './media/20261121_002.wav',
    './media/20261121_003_报价单_v1.pdf',
  ]);

  const mdContent = fs.readFileSync(path.join(outDir, 'messages.md'), 'utf8');
  // 验证前 50 条已被截断，第 51 条为首条保留记录。
  expect(mdContent).not.toContain('十月历史记录 #50\r\n');
  expect(mdContent).toContain('十月历史记录 #51');
  // 验证命中的图片、语音、文件全部写成相对路径 `./media/...`。
  expect(mdContent).toContain('![图片](./media/20261121_001.png)');
  expect(mdContent).toContain('[语音 1 秒](./media/20261121_002.wav)');
  expect(mdContent).toContain('[文件: 报价单_v1.pdf](./media/20261121_003_报价单_v1.pdf)');
  // 验证缺失原件与恶意路径穿越附件均优雅降级为纯文本占位，且未复制沙箱诱饵文件。
  expect(mdContent).toContain('[图片（本地原图未保存）]');
  expect(mdContent).toContain('[语音 3 秒（本地原音频未保存）]');
  expect(mdContent).toContain('[文件: ../../outside_secret.txt（本地未保存）]');
  expect(mdContent).not.toContain(sandbox);

  const exportedMediaFiles = fs.readdirSync(path.join(outDir, 'media')).sort();
  expect(exportedMediaFiles).toEqual([
    '20261121_001.png',
    '20261121_002.wav',
    '20261121_003_报价单_v1.pdf',
  ]);
  expect(fs.readFileSync(path.join(outDir, 'media', '20261121_001.png')).equals(fakePngBytes)).toBe(true);
  expect(fs.readFileSync(path.join(outDir, 'media', '20261121_003_报价单_v1.pdf')).equals(fakePdfBytes)).toBe(true);
  expect(silk.isWav(fs.readFileSync(path.join(outDir, 'media', '20261121_002.wav')))).toBe(true);
});


test('长历史分卷：支持按月（month）与经 Main.runCli 按每 1000 条（count）拆分子目录且相对媒体链接有效', async () => {
  const sandbox = makeTempDir();
  const { dataDir, peerWxid } = await createSyntheticWechatDataset(sandbox);

  // 1. 按月拆分（`--chunk-by month --since-days 0`）
  const outByMonth = path.join(sandbox, 'export-month');
  const monthOpts = exportModule.validateExportCliInput({
    data: dataDir,
    chat: peerWxid,
    out: outByMonth,
    limit: '1500',
    sinceDays: '0',
    chunkBy: 'month',
    maxTokens: '0',
  });
  const monthManifest = await exportModule.runExportChatCli(monthOpts);
  expect(monthManifest.chunks.map((c) => [c.id, c.file, c.count])).toEqual([
    ['2026-10', './2026-10/messages.md', 470],
    ['2026-11', './2026-11/messages.md', 1030],
  ]);
  const novMd = fs.readFileSync(path.join(outByMonth, '2026-11', 'messages.md'), 'utf8');
  // 子目录内的 Markdown 自动使用 `../media/...` 相对路径精确指向 `<out>/media/`。
  expect(novMd).toContain('![图片](../media/20261121_001.png)');
  const resolvedFromSubDir = path.resolve(path.join(outByMonth, '2026-11'), '../media/20261121_001.png');
  expect(fs.existsSync(resolvedFromSubDir)).toBe(true);

  // 2. 经 `Main.runCli` 真实 CLI 子命令按每 1000 条拆分全量 2050 条（`--chunk-by count --chunk-size 1000 --since-days 0`）
  const outByCount = path.join(sandbox, 'export-count');
  await mainModule.runCli([
    'export-chat',
    '--data', dataDir,
    '--chat', peerWxid,
    '--out', outByCount,
    '--limit', '5000',
    '--since-days', '0',
    '--chunk-by', 'count',
    '--chunk-size', '1000',
    '--max-tokens', '0',
  ]);

  const countManifest = JSON.parse(
    fs.readFileSync(path.join(outByCount, 'manifest.json'), 'utf8'),
  ) as exportModule.ExportManifest;
  expect(countManifest.totalMessages).toBe(2050);
  expect(countManifest.redactionCheck.passed).toBe(true);
  expect(countManifest.chunks.map((c) => [c.id, c.file, c.count])).toEqual([
    ['part-001', './part-001/messages.md', 1000],
    ['part-002', './part-002/messages.md', 1000],
    ['part-003', './part-003/messages.md', 50],
  ]);
  const rootIndex = fs.readFileSync(path.join(outByCount, 'messages.md'), 'utf8');
  expect(rootIndex).toContain('[part-001](./part-001/messages.md)');
  expect(rootIndex).toContain('[part-003](./part-003/messages.md)');
});


test('scan-accounts 与 list-chats：零 message_N.db 读取、置顶优先排序、按昵称选号且零摘要/路径泄漏', () => {
  const sandbox = makeTempDir();
  const dataDir = path.join(sandbox, 'meta-data');
  const xwechatRoot = path.join(sandbox, 'xwechat_files');
  const alphaDbDir = path.join(xwechatRoot, 'wxid_alpha_1122', 'db_storage');
  const betaDbDir = path.join(xwechatRoot, 'wxid_beta_9988', 'db_storage');
  fs.mkdirSync(alphaDbDir, { recursive: true });
  fs.mkdirSync(path.join(betaDbDir, 'session'), { recursive: true });
  fs.writeFileSync(path.join(betaDbDir, 'session', 'session.db'), Buffer.alloc(4096));

  // 故意完全不创建 message_0.db，并在 SessionTable.summary 埋入诱饵正文，验证绝不读取消息正文或摘要列。
  const plainContact = path.join(sandbox, 'alpha_contact.db');
  const plainSession = path.join(sandbox, 'alpha_session.db');
  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_alpha', '大号阿法', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_polar', 'Polar', '北极星');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_magic', '魔法', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('482910@chatroom', 'AI核心群', '');
  });

  buildReservedPlainDb(plainSession, (db) => {
    db.exec(`
      CREATE TABLE SessionTable (
        username TEXT PRIMARY KEY,
        last_timestamp INTEGER,
        sort_timestamp INTEGER,
        is_pinned INTEGER,
        summary TEXT
      );
    `);
    const ins = db.query('INSERT INTO SessionTable VALUES (?, ?, ?, ?, ?)');
    // 普通私聊：时间最新但未置顶
    ins.run('wxid_polar', 1_795_300_000, 1_795_300_000, 0, 'SECRET_SUMMARY_MUST_NEVER_LEAK');
    // 置顶私聊（is_pinned = 1）：时间较早但置顶
    ins.run('wxid_magic', 1_795_100_000, 1_795_100_000, 1, 'SECRET_SUMMARY_2');
    // 置顶群聊（sort_timestamp > last_timestamp）：时间高于 wxid_magic，应排置顶第一
    ins.run('482910@chatroom', 1_795_200_000, 9_999_999_999, 0, 'SECRET_SUMMARY_3');
    // 系统折叠会话：应被自动过滤
    ins.run('brandsessionholder', 1_795_400_000, 1_795_400_000, 0, 'HOLDER');
  });

  const masterKey = crypto.createHash('sha256').update('synthetic-meta-key').digest();
  encryptSqliteFile(plainContact, path.join(alphaDbDir, 'contact', 'contact.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainSession, path.join(alphaDbDir, 'session', 'session.db'), masterKey, crypto.randomBytes(16));

  const alphaAccId = 'account_alpha';
  fs.mkdirSync(path.join(dataDir, alphaAccId), { recursive: true });
  fs.writeFileSync(path.join(dataDir, alphaAccId, 'config.json'), JSON.stringify({ db_dir: alphaDbDir }), 'utf8');
  const keyHex = masterKey.toString('hex');
  fs.writeFileSync(
    path.join(dataDir, alphaAccId, 'all_keys.json'),
    JSON.stringify({
      'contact/contact.db': { enc_key: keyHex },
      'session/session.db': { enc_key: keyHex },
    }),
    'utf8',
  );
  // accounts.yaml 里故意将 nickname 留空，测试 scan-accounts 从只读 contact.db 补齐昵称。
  fs.writeFileSync(
    path.join(dataDir, 'accounts.yaml'),
    yaml.stringify([{
      id: alphaAccId,
      folder: 'wxid_alpha_1122',
      wxid: 'wxid_alpha',
      nickname: '',
      status: 'connected',
    }]),
    'utf8',
  );

  const scanReport = cliMeta.runScanAccountsCli(cliMeta.validateScanAccountsInput({
    data: dataDir,
    root: xwechatRoot,
    json: true,
  }));
  expect(scanReport.count).toBe(2);
  expect(scanReport.accounts[0]).toEqual({
    accountId: 'account_alpha',
    wxid: 'wxid_alpha',
    nickname: '大号阿法',
    safeFolderName: '大号阿法_account_alpha',
    hasKey: true,
    active: true,
    dbReady: true,
  });
  expect(scanReport.accounts[1]?.hasKey).toBe(false);
  expect(scanReport.accounts[1]?.active).toBe(false);

  const scanTable = cliMeta.formatScanAccountsTable(scanReport);
  expect(scanTable).toContain('大号阿法_account_alpha');
  expect(
    exportModule.verifyNoAbsolutePathLeak([JSON.stringify(scanReport), scanTable], [sandbox, dataDir, xwechatRoot]).passed,
  ).toBe(true);

  // 通过微信昵称 `--account 大号阿法` 调用 list-chats（即使磁盘完全不存在 message_0.db 也能毫秒级返回）
  const listReport = cliMeta.runListChatsCli(cliMeta.validateListChatsInput({
    data: dataDir,
    account: '大号阿法',
    json: true,
  }));
  expect(listReport.account.nickname).toBe('大号阿法');
  expect(listReport.chats.map((c) => [c.displayName, c.chatType, c.pinned])).toEqual([
    ['AI核心群', 'group', true],
    ['魔法', 'p2p', true],
    ['北极星', 'p2p', false],
  ]);

  const listTable = cliMeta.formatListChatsTable(listReport);
  expect(listTable).toContain('📌');
  expect(JSON.stringify(listReport)).not.toContain('SECRET_SUMMARY');
  expect(listTable).not.toContain('SECRET_SUMMARY');
  expect(
    exportModule.verifyNoAbsolutePathLeak([JSON.stringify(listReport), listTable], [sandbox, dataDir]).passed,
  ).toBe(true);

  // 验证 --pinned-only 与 --type / --filter 组合筛选
  const pinnedOnly = cliMeta.runListChatsCli(cliMeta.validateListChatsInput({
    data: dataDir,
    account: 'wxid_alpha',
    pinnedOnly: true,
    type: 'p2p',
  }));
  expect(pinnedOnly.chats.map((c) => c.displayName)).toEqual(['魔法']);
});


test('默认最近 30 天按天分卷、Token 预算自动拆 _part2.md 与超大文件跳过复制占位（copyFileSync）', async () => {
  const sandbox = makeTempDir();
  const dataDir = path.join(sandbox, 'v2-data');
  const wxAccountRoot = path.join(sandbox, 'xwechat_files', 'wxid_owner_v2_abcd');
  const dbStorage = path.join(wxAccountRoot, 'db_storage');
  fs.mkdirSync(dbStorage, { recursive: true });

  const peerWxid = 'wxid_v2_friend';
  const peerHash = crypto.createHash('md5').update(peerWxid, 'utf8').digest('hex');
  const msgTable = `Msg_${peerHash}`;

  // 准备一个正常小文件（120B）与一个 2.0 MB 超大压缩包（用于验证 --max-file-mb 1 拦截）
  const fileMonthDir = path.join(wxAccountRoot, 'msg', 'file', '2026-11');
  fs.mkdirSync(fileMonthDir, { recursive: true });
  fs.writeFileSync(path.join(fileMonthDir, '会议纪要.txt'), '轻量纪要内容', 'utf8');
  fs.writeFileSync(path.join(fileMonthDir, '超大设计稿.zip'), Buffer.alloc(2 * 1024 * 1024, 0x5a));

  const plainContact = path.join(sandbox, 'v2_contact.db');
  const plainMsg0 = path.join(sandbox, 'v2_msg0.db');
  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_owner_v2', '合成号V2', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run(peerWxid, '李工', '架构师李工');
  });

  const oldSepTs = Math.floor(new Date('2026-09-10T04:00:00Z').getTime() / 1000);
  const nov20Ts = Math.floor(new Date('2026-11-20T04:00:00Z').getTime() / 1000);
  const nov21Ts = Math.floor(new Date('2026-11-21T04:00:00Z').getTime() / 1000);
  const fixedNowMs = new Date('2026-11-22T08:00:00Z').getTime();
  const appFileType = Number((6n << 32n) | 49n);

  buildReservedPlainDb(plainMsg0, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_owner_v2'), (2, '${peerWxid}');
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
    const ins = db.query(`INSERT INTO [${msgTable}] VALUES (?, ?, ?, ?, ?, 0, NULL)`);
    // 1 条超过 30 天的 9 月老消息（应被默认 --since-days 30 自动过滤）
    ins.run(1, 1, oldSepTs, 2, '九月超期老消息不应出现在近一个月导出中');
    // 2026-11-20 当天写入 12 条较长中文讨论，触发 --max-tokens 350 自动拆分为 _part2.md / _part3.md
    for (let i = 1; i <= 12; i += 1) {
      ins.run(
        10 + i,
        1,
        nov20Ts + i * 60,
        (i % 2) + 1,
        `第${String(i)}轮技术方案评审记录：采用按天分卷与确定性Token估算预算，保证AI上下文检索丝滑无损。`,
      );
    }
    // 2026-11-21 当天包含 1 个正常附件与 1 个 2MB 超限附件
    ins.run(30, appFileType, nov21Ts + 60, 2, '<msg><appmsg><type>6</type><title>会议纪要.txt</title></appmsg></msg>');
    ins.run(31, appFileType, nov21Ts + 120, 2, '<msg><appmsg><type>6</type><title>超大设计稿.zip</title></appmsg></msg>');
  });

  const masterKey = crypto.createHash('sha256').update('synthetic-v2-day-key').digest();
  encryptSqliteFile(plainContact, path.join(dbStorage, 'contact', 'contact.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainMsg0, path.join(dbStorage, 'message', 'message_0.db'), masterKey, crypto.randomBytes(16));

  const accId = 'account_v2';
  fs.mkdirSync(path.join(dataDir, accId), { recursive: true });
  fs.writeFileSync(path.join(dataDir, accId, 'config.json'), JSON.stringify({ db_dir: dbStorage }), 'utf8');
  fs.writeFileSync(
    path.join(dataDir, accId, 'all_keys.json'),
    JSON.stringify({
      'contact/contact.db': { enc_key: masterKey.toString('hex') },
      'message/message_0.db': { enc_key: masterKey.toString('hex') },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'accounts.yaml'),
    yaml.stringify([{ id: accId, folder: 'wxid_owner_v2_abcd', wxid: 'wxid_owner_v2', nickname: '合成号V2', status: 'connected' }]),
    'utf8',
  );

  const outDir = path.join(sandbox, 'export-v2-day');
  // 不传 chunkBy 和 sinceDays，直接核验默认值（sinceDays=30, chunkBy='day'），并设 maxTokens=350, maxFileMb=1
  const opts = exportModule.validateExportCliInput({
    data: dataDir,
    account: '合成号V2',
    chat: '架构师李工',
    out: outDir,
    maxTokens: '350',
    maxFileMb: '1',
    nowMs: fixedNowMs,
  });
  expect(opts.sinceDays).toBe(30);
  expect(opts.chunkBy).toBe('day');

  const manifest = await exportModule.runExportChatCli(opts);
  // 9 月老消息已过滤，仅保留 11-20 的 12 条 + 11-21 的 2 条 = 14 条，无损分布在各分卷中
  expect(manifest.totalMessages).toBe(14);
  expect(manifest.chunks.reduce((sum, c) => sum + c.count, 0)).toBe(14);
  expect(manifest.chunks.some((c) => c.id === '2026-11-20')).toBe(true);
  expect(manifest.chunks.some((c) => c.id === '2026-11-20_part2')).toBe(true);
  expect(manifest.chunks.some((c) => c.id === '2026-11-21')).toBe(true);
  expect(fs.existsSync(path.join(outDir, '2026-11-20.md'))).toBe(true);
  expect(fs.existsSync(path.join(outDir, '2026-11-20_part2.md'))).toBe(true);
  expect(fs.existsSync(path.join(outDir, '2026-11-21.md'))).toBe(true);

  // 验证 2.0 MB 超限文件未复制进 media/，且写入了清晰体积上限说明；正常小文件已通过 copyFileSync 落盘
  expect(manifest.media.copiedCount).toBe(1);
  expect(manifest.media.oversizeCount).toBe(1);
  const nov21Md = fs.readFileSync(path.join(outDir, '2026-11-21.md'), 'utf8');
  expect(nov21Md).toContain('[文件: 会议纪要.txt](./media/20261121_001_会议纪要.txt)');
  expect(nov21Md).toContain('[文件: 超大设计稿.zip（2.0 MB，超过单文件大小上限 1 MB 未复制）]');
  expect(fs.readdirSync(path.join(outDir, 'media'))).toEqual(['20261121_001_会议纪要.txt']);
  expect(manifest.redactionCheck.passed).toBe(true);
});


test('export-batch 批量导出：支持同名好友防碰撞目录（<显示名>_<唯一ID>）、私聊/群聊同构树与 --with-account-dir', async () => {
  const sandbox = makeTempDir();
  const dataDir = path.join(sandbox, 'batch-data');
  const wxAccountRoot = path.join(sandbox, 'xwechat_files', 'wxid_batch_owner_7788');
  const dbStorage = path.join(wxAccountRoot, 'db_storage');
  fs.mkdirSync(dbStorage, { recursive: true });

  const zhang1 = 'wxid_zhang_one';
  const zhang2 = 'wxid_zhang_two';
  const groupRoom = '889900@chatroom';
  const stalePeer = 'wxid_stale_peer';
  const tableOf = (u: string) => `Msg_${crypto.createHash('md5').update(u, 'utf8').digest('hex')}`;

  const fixedNowMs = new Date('2026-11-22T08:00:00Z').getTime();
  const recentTs = Math.floor(new Date('2026-11-21T06:00:00Z').getTime() / 1000);
  const staleTs = Math.floor(new Date('2026-08-01T06:00:00Z').getTime() / 1000);

  const plainContact = path.join(sandbox, 'batch_contact.db');
  const plainSession = path.join(sandbox, 'batch_session.db');
  const plainMsg0 = path.join(sandbox, 'batch_msg0.db');

  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
    const ins = db.query('INSERT INTO contact VALUES (?, ?, ?)');
    ins.run('wxid_batch_owner', '主力微信号', '');
    // 故意让两个不同 wxid 的好友拥有完全相同的备注名“张经理”，验证目录不会互相覆盖！
    ins.run(zhang1, 'ZhangA', '张经理');
    ins.run(zhang2, 'ZhangB', '张经理');
    ins.run(groupRoom, '项目交付群', '');
    ins.run(stalePeer, '八月老友', '');
  });

  buildReservedPlainDb(plainSession, (db) => {
    db.exec('CREATE TABLE SessionTable (username TEXT PRIMARY KEY, last_timestamp INTEGER, is_pinned INTEGER)');
    const ins = db.query('INSERT INTO SessionTable VALUES (?, ?, ?)');
    ins.run(groupRoom, recentTs + 30, 1);
    ins.run(zhang1, recentTs + 20, 0);
    ins.run(zhang2, recentTs + 10, 0);
    ins.run(stalePeer, staleTs, 0);
  });

  buildReservedPlainDb(plainMsg0, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES
        (1, 'wxid_batch_owner'),
        (2, '${zhang1}'),
        (3, '${zhang2}'),
        (4, '${groupRoom}'),
        (5, '${stalePeer}');
    `);
    for (const [uname, senderRow, text, ts] of [
      [zhang1, 2, '我是第一位张经理（华东区）', recentTs + 20],
      [zhang2, 3, '我是第二位张经理（华南区）', recentTs + 10],
      [groupRoom, 2, 'wxid_zhang_one:\n项目交付群里程碑已达成', recentTs + 30],
      [stalePeer, 5, '八月份的历史问候', staleTs],
    ] as const) {
      db.exec(`
        CREATE TABLE [${tableOf(uname)}] (
          local_id INTEGER PRIMARY KEY,
          local_type INTEGER NOT NULL,
          create_time INTEGER NOT NULL,
          real_sender_id INTEGER,
          message_content BLOB,
          WCDB_CT_message_content INTEGER,
          packed_info_data BLOB
        );
      `);
      db.query(`INSERT INTO [${tableOf(uname)}] VALUES (1, 1, ?, ?, ?, 0, NULL)`).run(ts, senderRow, text);
    }
  });

  const masterKey = crypto.createHash('sha256').update('synthetic-batch-key').digest();
  encryptSqliteFile(plainContact, path.join(dbStorage, 'contact', 'contact.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainSession, path.join(dbStorage, 'session', 'session.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainMsg0, path.join(dbStorage, 'message', 'message_0.db'), masterKey, crypto.randomBytes(16));

  const accId = 'account_batch';
  fs.mkdirSync(path.join(dataDir, accId), { recursive: true });
  fs.writeFileSync(path.join(dataDir, accId, 'config.json'), JSON.stringify({ db_dir: dbStorage }), 'utf8');
  const keyHex = masterKey.toString('hex');
  fs.writeFileSync(
    path.join(dataDir, accId, 'all_keys.json'),
    JSON.stringify({
      'contact/contact.db': { enc_key: keyHex },
      'session/session.db': { enc_key: keyHex },
      'message/message_0.db': { enc_key: keyHex },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'accounts.yaml'),
    yaml.stringify([{ id: accId, folder: 'wxid_batch_owner_7788', wxid: 'wxid_batch_owner', nickname: '主力微信号', status: 'connected' }]),
    'utf8',
  );

  // 1. `--all` 默认批量导出到任意自定义目录（自动跳过 8 月超期会话，且两个同名“张经理”各自独立成目录）
  const customOut = path.join(sandbox, 'user-custom-export-root');
  const batchOpts = exportModule.validateBatchExportInput({
    data: dataDir,
    account: '主力微信号',
    all: true,
    out: customOut,
    nowMs: fixedNowMs,
  });
  const batchManifest = await exportModule.runExportBatchCli(batchOpts);

  expect(batchManifest.totals.exportedChats).toBe(3);
  expect(batchManifest.totals.skippedChats).toBe(1);
  expect(batchManifest.totals.failedChats).toBe(0);
  expect(batchManifest.redactionCheck.passed).toBe(true);
  expect(batchManifest.items.map((i) => i.folder)).toEqual([
    './群聊/项目交付群_889900@chatroom',
    './私聊/张经理_wxid_zhang_one',
    './私聊/张经理_wxid_zhang_two',
  ]);
  expect(
    fs.readFileSync(path.join(customOut, '私聊', '张经理_wxid_zhang_one', '2026-11-21.md'), 'utf8'),
  ).toContain('华东区');
  expect(
    fs.readFileSync(path.join(customOut, '私聊', '张经理_wxid_zhang_two', '2026-11-21.md'), 'utf8'),
  ).toContain('华南区');
  expect(
    fs.readFileSync(path.join(customOut, '群聊', '项目交付群_889900@chatroom', '2026-11-21.md'), 'utf8'),
  ).toContain('项目交付群里程碑已达成');

  // 2. 经 `Main.runCli` 测试 `--chats` + `--with-account-dir` 嵌套 `<安全昵称>_<accountId>/` 隔离目录
  const multiAccOut = path.join(sandbox, 'multi-account-archive');
  await mainModule.runCli([
    'export-batch',
    '--data', dataDir,
    '--account', '主力微信号',
    '--chats', `${zhang1},项目交付群`,
    '--out', multiAccOut,
    '--with-account-dir',
    '--since-days', '0',
    '--json',
  ]);
  const nestedManifest = JSON.parse(
    fs.readFileSync(path.join(multiAccOut, 'batch-manifest.json'), 'utf8'),
  ) as exportModule.BatchExportManifest;
  expect(nestedManifest.account.safeFolderName).toBe('主力微信号_account_batch');
  expect(nestedManifest.items.map((i) => i.folder)).toEqual([
    './主力微信号_account_batch/私聊/张经理_wxid_zhang_one',
    './主力微信号_account_batch/群聊/项目交付群_889900@chatroom',
  ]);
  expect(nestedManifest.redactionCheck.passed).toBe(true);
});


test('只读 --data 目录零写入保护：默认写 os.tmpdir() 缓存且支持 --cache-dir，不触发 EPERM/EACCES', async () => {
  const sandbox = makeTempDir();
  const ds = await createSyntheticWechatDataset(sandbox);
  const stateAccDir = path.join(ds.dataDir, ds.accountId);
  const cfg = JSON.parse(fs.readFileSync(path.join(stateAccDir, 'config.json'), 'utf8')) as { db_dir: string };
  const keysPath = path.join(stateAccDir, 'all_keys.json');
  const keysJson = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as Record<string, { enc_key: string }>;
  const encKeyHex = keysJson['contact/contact.db']!.enc_key;

  // 补建加密 session.db 以同时覆盖 list-chats / export-batch 与 export-chat（含 PNG 图片 + SILK 语音解码）
  const plainSession = path.join(sandbox, 'plain_ro_session.db');
  buildReservedPlainDb(plainSession, (db) => {
    db.exec(`
      CREATE TABLE SessionTable (
        username TEXT PRIMARY KEY,
        type INTEGER,
        unread_count INTEGER,
        summary TEXT,
        last_timestamp INTEGER,
        sort_timestamp INTEGER,
        last_msg_type INTEGER
      );
    `);
    const novTs = Math.floor(new Date('2026-11-21T06:00:00Z').getTime() / 1000);
    db.query('INSERT INTO SessionTable VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      ds.peerWxid, 0, 0, '', novTs, novTs + 3_600_000_000, 1,
    );
  });
  encryptSqliteFile(
    plainSession,
    path.join(cfg.db_dir, 'session', 'session.db'),
    Buffer.from(encKeyHex, 'hex'),
    crypto.randomBytes(16),
  );
  keysJson['session/session.db'] = { enc_key: encKeyHex };
  fs.writeFileSync(keysPath, JSON.stringify(keysJson), 'utf8');

  const collectRelFiles = (rootDir: string): string[] => {
    const out: string[] = [];
    const walk = (curr: string): void => {
      for (const entry of fs.readdirSync(curr, { withFileTypes: true })) {
        const abs = path.join(curr, entry.name);
        const rel = path.relative(rootDir, abs).replace(/\\/gu, '/');
        out.push(rel);
        if (entry.isDirectory()) {
          walk(abs);
        }
      }
    };
    walk(rootDir);
    return out.sort();
  };

  const beforeSnapshot = collectRelFiles(ds.dataDir);
  const customCacheDir = path.join(sandbox, 'explicit-cli-cache');
  const exportOutDefault = path.join(sandbox, 'ro-export-default-cache');
  const exportOutCustom = path.join(sandbox, 'ro-export-custom-cache');

  // 将 --data 与账号配置子目录设为只读（0o555），模拟受保护的线上运行态目录
  fs.chmodSync(stateAccDir, 0o555);
  fs.chmodSync(ds.dataDir, 0o555);
  try {
    // 1. 默认不传 --cache-dir：自动走 os.tmpdir()/jmbots-wechat-cache/<hash>，list-chats / scan-accounts 零报错
    const scanRes = cliMeta.runScanAccountsCli(cliMeta.validateScanAccountsInput({ data: ds.dataDir }));
    expect(scanRes.count).toBe(1);

    const listRes = cliMeta.runListChatsCli(
      cliMeta.validateListChatsInput({ data: ds.dataDir, account: ds.accountId, limit: '80' }),
    );
    expect(listRes.count).toBe(1);
    expect(listRes.chats[0]?.displayName).toBe('合成客户王总');

    await mainModule.runCli([
      'export-chat',
      '--data', ds.dataDir,
      '--account', ds.accountId,
      '--chat', ds.peerWxid,
      '--out', exportOutDefault,
      '--limit', '10',
      '--since-days', '0',
      '--json',
    ]);
    const manifestDefault = JSON.parse(
      fs.readFileSync(path.join(exportOutDefault, 'manifest.json'), 'utf8'),
    ) as exportModule.ExportManifest;
    expect(manifestDefault.totalMessages).toBe(10);
    expect(manifestDefault.media.copiedCount).toBe(3);
    expect(manifestDefault.redactionCheck.passed).toBe(true);

    // 2. 显式传 --cache-dir：缓存全部落入指定目录，且脱敏校验拦截 --cache-dir 路径泄漏
    await mainModule.runCli([
      'export-chat',
      '--data', ds.dataDir,
      '--cache-dir', customCacheDir,
      '--account', ds.accountId,
      '--chat', ds.peerWxid,
      '--out', exportOutCustom,
      '--limit', '10',
      '--since-days', '0',
      '--json',
    ]);
    expect(fs.existsSync(path.join(customCacheDir, 'db_cache', ds.accountId))).toBe(true);
    expect(fs.existsSync(path.join(customCacheDir, 'voice_cache'))).toBe(true);

    // 3. 核验只读 --data 目录内未新增任何 db_cache / media / message 缓存文件，快照 100% 一致
    expect(fs.existsSync(path.join(ds.dataDir, 'db_cache'))).toBe(false);
    expect(fs.existsSync(path.join(ds.dataDir, 'message'))).toBe(false);
    expect(fs.existsSync(path.join(stateAccDir, 'media'))).toBe(false);
    expect(collectRelFiles(ds.dataDir)).toEqual(beforeSnapshot);
  } finally {
    fs.chmodSync(ds.dataDir, 0o755);
    fs.chmodSync(stateAccDir, 0o755);
  }
});


test('脱敏防误杀与 WAL 扩页新群分库补齐：群友发 https/C:\\demo/Users 不误杀，结构化或真实前缀泄漏必拦，WAL 新建群正常导出', async () => {
  const sandbox = makeTempDir();
  const dataDir = path.join(sandbox, 'tech-group-data');
  const wxRoot = path.join(sandbox, 'xwechat_files', 'wxid_tech_owner_0011');
  const dbStorage = path.join(wxRoot, 'db_storage');
  fs.mkdirSync(dbStorage, { recursive: true });

  const techGroupId = '99887766@chatroom';
  const walNewGroupId = '11223344@chatroom';
  const techTable = `Msg_${crypto.createHash('md5').update(techGroupId, 'utf8').digest('hex')}`;
  const walNewTable = `Msg_${crypto.createHash('md5').update(walNewGroupId, 'utf8').digest('hex')}`;

  const plainContact = path.join(sandbox, 'tg_contact.db');
  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT)');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_tech_owner', 'Leon', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_dev_alice', 'Alice', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run(techGroupId, 'Claude Code 1群-12月航海', '');
    db.query('INSERT INTO contact VALUES (?, ?, ?)').run(walNewGroupId, 'FDE入门2群', '');
  });

  // 1. message_0.db（模拟 --connect 后新生成的同密钥分片：故意不写进 all_keys.json 键名，靠首页 HMAC 交叉验真）
  const plainMsg0 = path.join(sandbox, 'tg_msg0.db');
  const nov22Ts = Math.floor(new Date('2026-11-22T09:00:00Z').getTime() / 1000);
  buildReservedPlainDb(plainMsg0, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_tech_owner'), (2, 'wxid_dev_alice');
      CREATE TABLE [${techTable}] (
        local_id INTEGER PRIMARY KEY,
        local_type INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        real_sender_id INTEGER,
        message_content BLOB,
        WCDB_CT_message_content INTEGER,
        packed_info_data BLOB
      );
    `);
    const ins = db.query(`INSERT INTO [${techTable}] VALUES (?, 1, ?, 2, ?, 0, NULL)`);
    ins.run(1, nov22Ts - 86_400 * 60, 'wxid_dev_alice:\n两个月前的老链接 https://docs.anthropic.com/en/docs/claude-code');
    ins.run(2, nov22Ts, 'wxid_dev_alice:\n报错在 C:\\demo\\app.ts 和 /Users/dev/project/index.ts 以及 /home/ubuntu/run.sh，详见 http://127.0.0.1:3000/api');
  });

  // 2. message_1.db + message_1.db-wal：模拟新建群在 WAL 中扩页建表（主库第 1 页仍停留在旧 inHeaderDbSize 且带 WAL 标志 2）
  const plainMsg1Base = path.join(sandbox, 'tg_msg1_base.db');
  const plainMsg1Grown = path.join(sandbox, 'tg_msg1_grown.db');
  buildReservedPlainDb(plainMsg1Base, (db) => {
    db.exec(`
      CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY);
      INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_tech_owner'), (2, 'wxid_dev_alice');
      CREATE TABLE _filler (id INTEGER PRIMARY KEY, pad TEXT);
    `);
    // 让 sqlite_master 溢出到子页，或者后续扩页时不重写第 1 页旧页数头
    for (let k = 1; k <= 40; k += 1) {
      db.query('INSERT INTO _filler VALUES (?, ?)').run(k, 'X'.repeat(200));
    }
  });
  const baseBytes = fs.readFileSync(plainMsg1Base);
  const oldPages = Math.floor(baseBytes.byteLength / cryptoModule.PAGE_SIZE);
  // 模拟原库处于 WAL 模式（偏移 18/19 = 2）
  baseBytes[18] = 2;
  baseBytes[19] = 2;
  fs.writeFileSync(plainMsg1Base, baseBytes);

  fs.copyFileSync(plainMsg1Base, plainMsg1Grown);
  {
    const restoreHdr = fs.readFileSync(plainMsg1Grown);
    restoreHdr[18] = 1;
    restoreHdr[19] = 1;
    fs.writeFileSync(plainMsg1Grown, restoreHdr);
    const db = new sqlite.Database(plainMsg1Grown);
    db.exec(`
      CREATE TABLE [${walNewTable}] (
        local_id INTEGER PRIMARY KEY,
        local_type INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        real_sender_id INTEGER,
        message_content BLOB,
        WCDB_CT_message_content INTEGER,
        packed_info_data BLOB
      );
    `);
    db.query(`INSERT INTO [${walNewTable}] VALUES (1, 1, ?, 2, ?, 0, NULL)`).run(
      nov22Ts + 10,
      'wxid_dev_alice:\n11-22 刚建群落入 WAL 扩页的新消息 https://example.com/fde',
    );
    db.close();
  }
  const grownBytes = fs.readFileSync(plainMsg1Grown);
  const grownPages = Math.floor(grownBytes.byteLength / cryptoModule.PAGE_SIZE);
  expect(grownPages).toBeGreaterThan(oldPages);
  // 故意把第 1 页偏移 28..31 改回旧页数 oldPages（模拟 WAL 扩页但第 1 页未刷新页数头，此前会触发 SQLITE_CORRUPT 导致 0 条）
  grownBytes.writeUInt32BE(oldPages, 28);
  grownBytes[18] = 2;
  grownBytes[19] = 2;

  const masterKey = crypto.createHash('sha256').update('synthetic-tech-group-key').digest();
  const salt1 = crypto.randomBytes(16);
  encryptSqliteFile(plainContact, path.join(dbStorage, 'contact', 'contact.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainMsg0, path.join(dbStorage, 'message', 'message_0.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainMsg1Base, path.join(dbStorage, 'message', 'message_1.db'), masterKey, salt1);

  // 写入加密 message_1.db-wal（携带扩页后的帧与 commitDbSize = grownPages）
  const walHeader = Buffer.alloc(cryptoModule.WAL_HEADER_SIZE);
  walHeader.writeUInt32BE(0x377f0682, 0);
  walHeader.writeUInt32BE(3007000, 4);
  walHeader.writeUInt32BE(cryptoModule.PAGE_SIZE, 8);
  walHeader.writeUInt32BE(777, 16);
  walHeader.writeUInt32BE(888, 20);
  const walChunks: Buffer[] = [walHeader];
  const ivOffset = cryptoModule.PAGE_SIZE - cryptoModule.RESERVE_SIZE;
  const macKey1 = cryptoModule.deriveMacKey(masterKey, salt1);
  for (let p = 1; p <= grownPages; p += 1) {
    const start = (p - 1) * cryptoModule.PAGE_SIZE;
    const plainPage = grownBytes.subarray(start, start + cryptoModule.PAGE_SIZE);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', masterKey, iv);
    cipher.setAutoPadding(false);
    const encPage = Buffer.alloc(cryptoModule.PAGE_SIZE);
    if (p === 1) {
      salt1.copy(encPage, 0, 0, 16);
      Buffer.concat([cipher.update(plainPage.subarray(16, ivOffset)), cipher.final()]).copy(encPage, 16);
    }
    if (p !== 1) {
      Buffer.concat([cipher.update(plainPage.subarray(0, ivOffset)), cipher.final()]).copy(encPage, 0);
    }
    iv.copy(encPage, ivOffset);
    cryptoModule.computePageHmac(macKey1, encPage, p).copy(encPage, ivOffset + 16);

    const fh = Buffer.alloc(cryptoModule.WAL_FRAME_HEADER_SIZE);
    fh.writeUInt32BE(p, 0);
    let commitVal = 0;
    if (p === grownPages) {
      commitVal = grownPages;
    }
    fh.writeUInt32BE(commitVal, 4);
    fh.writeUInt32BE(777, 8);
    fh.writeUInt32BE(888, 12);
    walChunks.push(fh, encPage);
  }
  fs.writeFileSync(path.join(dbStorage, 'message', 'message_1.db-wal'), Buffer.concat(walChunks));

  // 再放一个完全未知密钥的 message_9.db，验证 unkeyedShards 准确提示且不阻断已有分片导出
  const plainMsg9 = path.join(sandbox, 'tg_msg9.db');
  buildReservedPlainDb(plainMsg9, (db) => {
    db.exec('CREATE TABLE t(x INT)');
  });
  const otherKey = crypto.createHash('sha256').update('totally-different-unconnected-key').digest();
  encryptSqliteFile(plainMsg9, path.join(dbStorage, 'message', 'message_9.db'), otherKey, crypto.randomBytes(16));

  const accId = 'account_tech';
  fs.mkdirSync(path.join(dataDir, accId), { recursive: true });
  fs.writeFileSync(path.join(dataDir, accId, 'config.json'), JSON.stringify({ db_dir: dbStorage }), 'utf8');
  const keyHex = masterKey.toString('hex');
  fs.writeFileSync(
    path.join(dataDir, accId, 'all_keys.json'),
    JSON.stringify({
      'contact/contact.db': { enc_key: keyHex },
      // 故意不登记 message/message_0.db，验证自动发现 + 交叉验真；仅登记 message_1.db
      'message/message_1.db': { enc_key: keyHex },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'accounts.yaml'),
    yaml.stringify([{ id: accId, folder: 'wxid_tech_owner_0011', wxid: 'wxid_tech_owner', nickname: 'Leon', status: 'connected' }]),
    'utf8',
  );

  // A. 导出技术群（含 --since-days 0 覆盖 60 天前消息 + https:// + C:\demo\app.ts + /Users/dev/project）：正常落盘不误杀！
  const outTech = path.join(sandbox, 'out-tech');
  const manifestTech = await exportModule.runExportChatCli(exportModule.validateExportCliInput({
    data: dataDir,
    account: 'Leon',
    chat: 'Claude Code 1群-12月航海',
    out: outTech,
    sinceDays: '0',
  }));
  expect(manifestTech.totalMessages).toBe(2);
  expect(manifestTech.redactionCheck.passed).toBe(true);
  expect(manifestTech.unkeyedShards).toEqual(['message/message_9.db']);
  const novMd = fs.readFileSync(path.join(outTech, '2026-11-22.md'), 'utf8');
  expect(novMd).toContain('C:\\demo\\app.ts');
  expect(novMd).toContain('/Users/dev/project/index.ts');
  expect(novMd).toContain('http://127.0.0.1:3000/api');

  // B. 导出 11-22 仅存在于 WAL 扩页区的 FDE入门2群：不再因旧页数头返回 0 条！
  const outWal = path.join(sandbox, 'out-wal-new');
  const manifestWal = await exportModule.runExportChatCli(exportModule.validateExportCliInput({
    data: dataDir,
    account: 'Leon',
    chat: 'FDE入门2群',
    out: outWal,
    sinceDays: '0',
  }));
  expect(manifestWal.totalMessages).toBe(1);
  expect(manifestWal.redactionCheck.passed).toBe(true);

  // C. 严格红线校验：若结构化区域（manifest.json / 元信息头 / ./media/ 链接）或 forbiddenPrefixes 泄漏宿主机路径仍 100% 拦截
  expect(
    exportModule.verifyNoAbsolutePathLeak(
      ['正文讨论 C:\\demo\\app.ts 与 https://claude.ai/code'],
      [dataDir, outTech, dbStorage],
      ['# 微信聊天记录：测试\n- 会话类型：群聊', './media/20261122_001.png'],
      [os.homedir()],
    ).passed,
  ).toBe(true);
  expect(
    exportModule.verifyNoAbsolutePathLeak(
      ['干净正文'],
      [dataDir, outTech],
      ['{"mediaDir": "C:\\\\secret\\\\media"}'],
    ).passed,
  ).toBe(false);
  expect(
    exportModule.verifyNoAbsolutePathLeak(
      ['干净正文'],
      [dataDir, outTech],
      ['![图片](/Users/admin/Desktop/leak.png)'],
    ).passed,
  ).toBe(false);
  expect(
    exportModule.verifyNoAbsolutePathLeak(
      [`泄露了真实库目录 ${dbStorage}/message/message_0.db`],
      [dataDir, outTech, dbStorage],
      ['# 干净头部'],
    ).passed,
  ).toBe(false);
  expect(
    exportModule.verifyNoAbsolutePathLeak(
      ['干净正文'],
      [dataDir],
      [`{"leak": "${os.homedir().replaceAll('\\', '/')}/secret"}`],
      [os.homedir()],
    ).passed,
  ).toBe(false);
});


test('微信 4.x list-chats 置顶判定：精准读取 contact.flag 第 11 位（2048），杜绝草稿/同步引起的 sort_timestamp 普通秒差假置顶', () => {
  const sandbox = makeTempDir();
  const dataDir = path.join(sandbox, 'pin-fix-data');
  const dbStorage = path.join(sandbox, 'xwechat_files', 'wxid_pin_owner_01', 'db_storage');
  fs.mkdirSync(dbStorage, { recursive: true });

  const plainContact = path.join(sandbox, 'pin_contact.db');
  const plainSession = path.join(sandbox, 'pin_session.db');
  buildReservedPlainDb(plainContact, (db) => {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT, flag INTEGER)');
    const ins = db.query('INSERT INTO contact VALUES (?, ?, ?, ?)');
    ins.run('wxid_pin_owner', '主力号', '', 3);
    // flag = 3（未置顶），尽管 SessionTable 中 sort_timestamp 因草稿编辑比 last_timestamp 大 10 万秒，也绝不能标为置顶！
    ins.run('wxid_polar_unpinned', '北极星', '', 3);
    ins.run('wxid_lcw_unpinned', '小嘿', '', 3);
    // flag = 2051（2048 | 3，真实置顶好友）与 flag = 67585（2048 位为 1，真实置顶群）
    ins.run('wxid_real_top_friend', '真正置顶伙伴', '', 2051);
    ins.run('778899@chatroom', '真正置顶核心群', '', 67585);
  });

  buildReservedPlainDb(plainSession, (db) => {
    db.exec(`
      CREATE TABLE SessionTable (
        username TEXT PRIMARY KEY,
        last_timestamp INTEGER,
        sort_timestamp INTEGER,
        status INTEGER
      );
    `);
    const ins = db.query('INSERT INTO SessionTable VALUES (?, ?, ?, 0)');
    ins.run('wxid_polar_unpinned', 1_795_173_808, 1_795_281_138);
    ins.run('wxid_lcw_unpinned', 1_795_091_588, 1_795_149_559);
    ins.run('wxid_real_top_friend', 1_795_000_000, 1_795_000_000);
    ins.run('778899@chatroom', 1_795_100_000, 1_795_100_000);
  });

  const masterKey = crypto.createHash('sha256').update('synthetic-pin-bit-key').digest();
  encryptSqliteFile(plainContact, path.join(dbStorage, 'contact', 'contact.db'), masterKey, crypto.randomBytes(16));
  encryptSqliteFile(plainSession, path.join(dbStorage, 'session', 'session.db'), masterKey, crypto.randomBytes(16));

  const accId = 'account_pin_fix';
  fs.mkdirSync(path.join(dataDir, accId), { recursive: true });
  fs.writeFileSync(path.join(dataDir, accId, 'config.json'), JSON.stringify({ db_dir: dbStorage }), 'utf8');
  const keyHex = masterKey.toString('hex');
  fs.writeFileSync(
    path.join(dataDir, accId, 'all_keys.json'),
    JSON.stringify({
      'contact/contact.db': { enc_key: keyHex },
      'session/session.db': { enc_key: keyHex },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'accounts.yaml'),
    yaml.stringify([{ id: accId, folder: 'wxid_pin_owner_01', wxid: 'wxid_pin_owner', nickname: '主力号', status: 'connected' }]),
    'utf8',
  );

  const report = cliMeta.runListChatsCli(cliMeta.validateListChatsInput({ data: dataDir, account: accId }));
  expect(report.chats.map((c) => [c.displayName, c.pinned])).toEqual([
    ['真正置顶核心群', true],
    ['真正置顶伙伴', true],
    ['北极星', false],
    ['小嘿', false],
  ]);

  const onlyPinned = cliMeta.runListChatsCli(
    cliMeta.validateListChatsInput({ data: dataDir, account: accId, pinnedOnly: true }),
  );
  expect(onlyPinned.chats.map((c) => c.displayName)).toEqual(['真正置顶核心群', '真正置顶伙伴']);
});
