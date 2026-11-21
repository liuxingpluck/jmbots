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

  // 2. 托管后台环境变量存在时拒绝触发 `export-chat`。
  expect(() => mainModule.parseCliOptions(
    ['export-chat', '--data', dataDir, '--chat', 'a', '--out', outDir],
    { [protocol.KEY_ENV]: 'secret-host-key' },
  )).toThrow('仅支持本机手动显式调用');

  // 3. `--media-dir` 目录穿越与绝对路径拦截。
  expect(() => exportModule.validateRelativeMediaDir('../escape', outDir)).toThrow('..');
  expect(() => exportModule.validateRelativeMediaDir('assets/../../outside', outDir)).toThrow('..');
  expect(() => exportModule.validateRelativeMediaDir('/tmp/evil', outDir)).toThrow('相对路径');
  expect(() => exportModule.validateRelativeMediaDir('C:\\evil\\media', outDir)).toThrow('相对路径');
  expect(() => exportModule.validateRelativeMediaDir('.', outDir)).toThrow('子目录');
  expect(() => exportModule.validateRelativeMediaDir('CON', outDir)).toThrow('保留');
  expect(exportModule.validateRelativeMediaDir('./media/', outDir)).toBe('media');

  // 4. 安全目录名清洗与绝对路径脱敏自检。
  expect(exportModule.sanitizeSafeSegment('../../客户/群:A*B?')).toBe('客户_群_A_B');
  expect(exportModule.sanitizeSafeSegment('NUL.txt')).toBe('_NUL.txt');
  const leakCheck = exportModule.verifyNoAbsolutePathLeak([`文件在 ${outDir}/messages.md`], [outDir]);
  expect(leakCheck.passed).toBe(false);
  expect(leakCheck.leakedAbsolutePaths).toBe(1);
});


test('最近 2000 条截断、相对路径媒体复制、恶意附件穿越拦截与不存在文件优雅降级占位', async () => {
  const sandbox = makeTempDir();
  const { dataDir, fakePngBytes, fakePdfBytes } = await createSyntheticWechatDataset(sandbox);
  const outDir = path.join(sandbox, 'bots', 'assistant', 'workspace', 'channels', 'wechat', '合成客户王总');

  // 按备注名“合成客户王总”显式导出最近 2000 条（总库有 2050 条，最早 50 条应被精确截掉）。
  const options = exportModule.validateExportCliInput({
    data: dataDir,
    chat: '合成客户王总',
    out: outDir,
    limit: '2000',
    chunkBy: 'none',
    mediaDir: 'media',
  });
  const manifest = await exportModule.runExportChatCli(options);

  expect(manifest.totalMessages).toBe(2000);
  expect(manifest.chat.displayName).toBe('合成客户王总');
  expect(manifest.chat.chatType).toBe('p2p');
  expect(manifest.redactionCheck.passed).toBe(true);
  expect(manifest.redactionCheck.leakedAbsolutePaths).toBe(0);
  expect(manifest.media.copiedCount).toBe(3);
  expect(manifest.media.missingCount).toBe(3);
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

  // 1. 按月拆分（`--chunk-by month`）
  const outByMonth = path.join(sandbox, 'export-month');
  const monthOpts = exportModule.validateExportCliInput({
    data: dataDir,
    chat: peerWxid,
    out: outByMonth,
    limit: '1500',
    chunkBy: 'month',
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

  // 2. 经 `Main.runCli` 真实 CLI 子命令按每 1000 条拆分全量 2050 条（`--chunk-by count --chunk-size 1000`）
  const outByCount = path.join(sandbox, 'export-count');
  await mainModule.runCli([
    'export-chat',
    '--data', dataDir,
    '--chat', peerWxid,
    '--out', outByCount,
    '--limit', '5000',
    '--chunk-by', 'count',
    '--chunk-size', '1000',
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
