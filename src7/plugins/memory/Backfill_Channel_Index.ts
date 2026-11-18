/**
 * 把各渠道的旧消息补进 memory 插件的渠道消息索引（memory_channel_messages，同目录的 ChannelIndex.ts）。
 * 新消息由 memory 插件听 channel/message、channel/reply 自己记；这个脚本只补插件挂上以前的，可以反复跑（记过的不再记）。
 * CLI 和后台回填共用归档读取和去重。导入时不运行 CLI，不直接开库。
 *
 * 用法（在 jmbots 目录）：
 *   bun src7/plugins/memory/Backfill_Channel_Index.ts --data <运行时目录>            先看：数各渠道有多少条，什么也不写
 *   bun src7/plugins/memory/Backfill_Channel_Index.ts --data <运行时目录> --run yes  真补
 *   --wechat_channel  微信插件发 channel/message 用的渠道名，默认 wechat（消息键要和它拼的一样）
 *
 * 读这几处（都在运行时目录里，只读）：
 *   飞书  channels/feishu/chats/<应用号>/<聊天号>.jsonl：一行一条，user、bot 两个方向都有；
 *   微信  data/jmbots7.db 的 wechat_messages：at 是秒；
 *   网页  data/jmbots7.db 的 web_messages：只取 channel = 'http' 的（别的渠道的行是镜像，各自的渠道补过了），回话在 replies 里；
 *   命令行 channels/cli/*.jsonl：只有用户的话。
 * 消息键照各渠道发 channel/message 的拼法 JSON [渠道, 账号, 原始号]，和插件新记的对得上；
 * 拼不出来的（飞书和网页里机器人的回复、命令行）再按“同渠道同聊天同方向同正文、时间差两分钟内”跳过，免得和插件记的重。
 * 服务开着也能跑（库设了 busy_timeout）。不打印消息内容，只打印条数。
 */
import * as bunSqlite from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as readline from 'node:readline';
import * as util from 'node:util';
import * as channelIndexModule from './ChannelIndex.ts';
import * as memoryKeyModule from './MemoryKey.ts';


/** 拼不出键时，“差不多的同一条”的时间差。 */
const SIMILAR_MS = 2 * 60 * 1000;


/** 一个渠道补了多少：读到几条、新记几条、早有了几条。 */
interface Count {
  /** 读到的。 */
  read: number;
  /** 新记的。 */
  added: number;
  /** 早有了的（键一样，或者差不多的同一条）。 */
  skipped: number;
}


/** 补一条要知道的：这一行，和要不要按“差不多的同一条”查重（键拼不出来时）。 */
export interface Candidate {
  /** 一行。 */
  row: channelIndexModule.ChannelRow;
  /** 键是另起的，和插件记的不一样：要按正文和时间查重。 */
  fuzzy: boolean;
}


/**
 * 读一个 jsonl 文件：一行一个 JSON，坏行跳过。
 * @param file 文件。
 * @returns 每一行解析出来的对象和行号（从 1 起）。
 */
async function* readJsonl(file: string): AsyncGenerator<{ value: Record<string, unknown>; line: number }> {
  //M 按行流式读取长聊天，回填任务可在任一批结束时让出事件循环。
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of lines) {
      line += 1;
      if (text.trim() === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        //G 文件最后一行有可能还未写完，继续读其他完整消息。
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

      const value = parsed as Record<string, unknown>;
      yield { value, line };
    }
  } finally {
    //M 迭代结束时关闭归档读取句柄。
    lines.close();
    input.destroy();
  }
}


/** 一个值当文字；不是文字是空串。 */
function getString(value: unknown): string {
  if (typeof value !== 'string') return '';

  return value;
}


/**
 * 飞书：channels/feishu/chats/<应用号>/<聊天号>.jsonl。用户的话键是 messageId（和 channel/message 一样）；机器人的回复按正文查重。
 * @param root 运行时目录。
 */
async function* getFeishu(root: string): AsyncGenerator<Candidate> {
  const base = path.join(root, 'channels', 'feishu', 'chats');
  if (!fs.existsSync(base)) return;

  for (const appId of fs.readdirSync(base)) {
    const appDir = path.join(base, appId);
    if (!fs.statSync(appDir).isDirectory()) continue;

    for (const fileName of fs.readdirSync(appDir)) {
      if (!fileName.endsWith('.jsonl')) continue;

      const chatId = fileName.slice(0, -'.jsonl'.length);

      //M 读这个聊天文件的每一行（坏行跳过），挑出正文和消息号（messageId，和 channel/message 一样）；没有正文、没有消息号的行不补。
      //M person 是私聊对面的人：一个文件就是一个聊天，机器人的回复借前面最近一条用户的话的发话人。
      const file = path.join(appDir, fileName);
      let person = '';
      for await (const { value } of readJsonl(file)) {
        const text = getString(value['text']);
        const key = getString(value['messageId']);
        if (text.trim() === '' || key === '') continue;

        //M 方向：bot 是机器人发的，别的都算聊天里的人。
        let direction: 'user' | 'bot' = 'user';
        if (value['direction'] === 'bot') {
          direction = 'bot';
        }

        //M 发言人在 sender 里（id、name）；用户的话的发话人就是私聊对面的人。
        const sender = (value['sender'] ?? {}) as Record<string, unknown>;
        const senderId = getString(sender['id']);
        if (direction === 'user') {
          person = senderId;
        }

        //M 归属键：机器人的回复在用户开口之前（主动发的）就不知道对面是谁，留空等补写。
        const chatType = getString(value['chatType']);
        const keySource = { channel: 'feishu', chatType, chat: chatId, person };
        const memoryKey = memoryKeyModule.getMemoryKey(keySource);

        //M 机器人的回复键拼不出来，标成要按正文查重（fuzzy）。
        const row: channelIndexModule.ChannelRow = {
          key,
          channel: 'feishu',
          account: appId,
          chat: chatId,
          chatType,
          direction,
          senderId,
          senderName: getString(sender['name']),
          bot: '',
          text,
          memoryKey,
          at: Number(value['createdAt']) || 0,
        };
        yield { row, fuzzy: direction === 'bot' };
      }
    }
  }
}

/** 按 rowid 分页读 SQLite 归档，批间不保留读游标或事务。 */
function* getArchiveRows(db: bunSqlite.Database, sql: string): Generator<Record<string, unknown>> {
  //M 每页复用同一条预编译 SQL，只改变行号断点。
  const statement = db.query(sql);
  let cursor = 0;
  for (;;) {
    //M 每页限制 100 行，大库不会一次读进进程内存。
    const rows = statement.all(cursor) as Record<string, unknown>[];
    if (rows.length === 0) return;

    for (const row of rows) {
      cursor = Number(row['archive_id']);
      yield row;
    }
  }
}


/**
 * 微信：wechat_messages。键 JSON [渠道名, 账号, 分库:库内号]（和 wechat 插件发 channel/message 一样）；at 是秒。
 * @param db 运行时的库。
 * @param channel 微信插件的渠道名。
 */
function* getWechat(db: bunSqlite.Database, channel: string): Generator<Candidate> {
  //G 插件未挂载的运行时可能没有微信归档表。
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wechat_messages'").get();
  if (table === null) return;

  const sql = 'SELECT rowid AS archive_id, account, chat, source, local_id, at, from_self, sender, text'
    + ' FROM wechat_messages WHERE rowid > ? ORDER BY rowid LIMIT 100';
  //M 微信归档可能很大，用行号分页并逐条转成渠道索引格式。
  const rows = getArchiveRows(db, sql);
  //M 逐行转成候选：键照微信插件发 channel/message 的拼法，才和插件新记的对得上，所以都不用查重（fuzzy 为 false）。
  for (const item of rows) {
    const text = getString(item['text']);
    if (text.trim() === '') continue;

    //M 群的会话名以 @chatroom 结尾；发言人：群里写了的用它，自己发的记 self，私聊是对方。
    const chat = getString(item['chat']);
    let chatType = 'p2p';
    if (chat.endsWith('@chatroom')) {
      chatType = 'group';
    }

    //M 发言人 ID：消息里写了的用它，没写就是聊天对方（私聊）；自己发的记 self。
    let senderId = getString(item['sender']) || chat;
    if (item['from_self'] === 1) {
      senderId = 'self';
    }

    //M 归属键：微信私聊的会话名就是对面那个人（自己发的也归他），和微信插件发 channel/message 的发话人一样。
    const keySource = { channel, chatType, chat, person: chat };
    const memoryKey = memoryKeyModule.getMemoryKey(keySource);

    //M 键是 JSON [渠道名, 账号, 分库:库内号]，和微信插件发 channel/message 拼的一样。
    const account = getString(item['account']);
    const nativeId = `${getString(item['source'])}:${String(item['local_id'])}`;
    const row: channelIndexModule.ChannelRow = {
      key: JSON.stringify([channel, account, nativeId]),
      channel,
      account,
      chat,
      chatType,
      direction: 'user',
      senderId,
      senderName: getString(item['sender']),
      bot: '',
      text,
      memoryKey,
      at: Number(item['at']) * 1000,
    };
    yield { row, fuzzy: false };
  }
}


/**
 * 网页：web_messages 里 channel = 'http' 的。用户的话键是 JSON ['http', 'local', 行号]（和 web-api 发 channel/message 一样）；
 * replies 里机器人的回话键另起（web-reply:<行号>:<第几条>），按正文查重。
 * @param db 运行时的库。
 */
function* getWeb(db: bunSqlite.Database): Generator<Candidate> {
  //G 插件未挂载的运行时可能没有网页归档表。
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_messages'").get();
  if (table === null) return;

  const sql = 'SELECT id AS archive_id, id, bot, text, replies, created_at FROM web_messages'
    + " WHERE id > ? AND channel = 'http' ORDER BY id LIMIT 100";
  //M 只读网页自己的消息，其他渠道的镜像已由原渠道归档覆盖。
  const rows = getArchiveRows(db, sql);
  for (const item of rows) {
    //M 用户与机器人回复共享原消息行号和目标机器人；本机网页归本人。
    const id = String(item['id']);
    const bot = getString(item['bot']);
    const keySource = { channel: 'http', chatType: 'local', chat: 'http:本机', person: '' };
    const memoryKey = memoryKeyModule.getMemoryKey(keySource);
    const shared = { channel: 'http', account: 'local', chat: 'http:本机', chatType: 'local', bot, memoryKey };

    //M 用户的话。
    const text = getString(item['text']);
    if (text.trim() !== '') {
      const row: channelIndexModule.ChannelRow = {
        ...shared,
        key: JSON.stringify(['http', 'local', id]),
        direction: 'user',
        senderId: 'http',
        senderName: '',
        text,
        at: Number(item['created_at']),
      };
      yield { row, fuzzy: false };
    }

    //M 机器人的回话：replies 是 JSON 数组 [{ at, text, … }]。
    let replies: unknown = [];
    try {
      replies = JSON.parse(getString(item['replies']) || '[]');
    } catch {
      replies = [];
    }
    if (!Array.isArray(replies)) continue;

    //M 每条回话一行：正文取 text，没写时间就借用户那条的时间；键另起（web-reply:行号:第几条），按正文查重。
    for (const [index, reply] of replies.entries()) {
      if (reply === null || typeof reply !== 'object') continue;

      //M 历史回复数组可能混有附件，只有文字能送入 Rust。
      const said = getString((reply as Record<string, unknown>)['text']);
      if (said.trim() === '') continue;

      const at = Number((reply as Record<string, unknown>)['at']) || Number(item['created_at']);
      const row: channelIndexModule.ChannelRow = {
        ...shared,
        key: `web-reply:${id}:${String(index)}`,
        direction: 'bot',
        senderId: bot,
        senderName: bot,
        text: said,
        at,
      };
      yield { row, fuzzy: true };
    }
  }
}


/**
 * 命令行：channels/cli/<日期>.jsonl，只有用户的话。键另起（cli-file:<文件名>:<行号>，文件里没存 channel/message 用的原始号），按正文查重。
 * @param root 运行时目录。
 */
async function* getCli(root: string): AsyncGenerator<Candidate> {
  const base = path.join(root, 'channels', 'cli');
  if (!fs.existsSync(base)) return;

  //M 命令行是本机来源，归本人。
  const keySource = { channel: 'cli', chatType: 'local', chat: 'cli:本机', person: '' };
  const memoryKey = memoryKeyModule.getMemoryKey(keySource);
  for (const fileName of fs.readdirSync(base)) {
    if (!fileName.endsWith('.jsonl')) continue;

    //M 读这个日期文件的每一行（坏行跳过），取用户的话；没有正文的行不补。
    const file = path.join(base, fileName);
    for await (const { value, line } of readJsonl(file)) {
      const text = getString(value['text']);
      if (text.trim() === '') continue;

      //M 键另起（cli-file:文件名:行号），按正文查重；目标机器人取 bot 字段。
      const row: channelIndexModule.ChannelRow = {
        key: `cli-file:${fileName}:${String(line)}`,
        channel: 'cli',
        account: 'local',
        chat: 'cli:本机',
        chatType: 'local',
        direction: 'user',
        senderId: 'cli',
        senderName: '',
        bot: getString(value['bot']),
        text,
        memoryKey,
        at: Number(value['time']) || 0,
      };
      yield { row, fuzzy: true };
    }
  }
}


/** 后台与 CLI 沿用同一套历史来源，逐条返回供调用方限批。 */
export async function* getArchives(root: string, db: bunSqlite.Database): AsyncGenerator<Candidate> {
  //M 顺次扫描各渠道，避免同一时间挂多个文件读取句柄。
  yield* getFeishu(root);
  yield* getWechat(db, 'wechat');
  yield* getWeb(db);
  yield* getCli(root);
}

/** 按原渠道键或同一聊天内的近似内容去重，再补进本地索引。 */
export function addCandidate(index: channelIndexModule.ChannelIndex, candidate: Candidate): boolean {
  const { row, fuzzy } = candidate;
  //G 归档里拼不出事件键的消息，沿用既有的近似去重规则。
  if (fuzzy && index.hasSimilar(row, SIMILAR_MS)) return false;

  //M 有事件键的归档直接使用索引的唯一约束去重。
  return index.add(row);
}

/** 依 CLI 选项把一个渠道的候选写进索引或只计数，不打印正文。 */
async function fill(
  index: channelIndexModule.ChannelIndex | undefined,
  candidates: Iterable<Candidate> | AsyncIterable<Candidate>,
): Promise<Count> {
  const count: Count = { read: 0, added: 0, skipped: 0 };
  for await (const candidate of candidates) {
    count.read += 1;
    if (index === undefined) continue;

    //M 脚本和后台任务从同一个入口去重。
    if (addCandidate(index, candidate)) {
      count.added += 1;
      continue;
    }
    count.skipped += 1;
  }
  return count;
}


/** 仅 CLI 入口打开指定的运行时库并逐渠道打印计数。 */
async function runCli(): Promise<void> {
  //M 参数：--data 为运行时目录，--run yes 才写，--wechat_channel 可指定微信渠道名。
  const parsed = util.parseArgs({
    options: { data: { type: 'string' }, run: { type: 'string' }, wechat_channel: { type: 'string' } },
    strict: true,
  });
  const root = parsed.values.data;
  if (root === undefined) throw new Error('要写 --data <运行时目录>（里面要有 data/jmbots7.db）');

  const dbFile = path.join(root, 'data', 'jmbots7.db');
  if (!fs.existsSync(dbFile)) throw new Error('要写 --data <运行时目录>（里面要有 data/jmbots7.db）');

  //M 只看时只读，真正补录时才允许写已存在的库。
  const running = parsed.values.run === 'yes';
  let openOptions: { readonly: true } | { readwrite: true } = { readonly: true };
  if (running) {
    openOptions = { readwrite: true };
  }
  const db = new bunSqlite.Database(dbFile, openOptions);
  try {
    let index: channelIndexModule.ChannelIndex | undefined;
    if (running) {
      //M 真补才建索引，等别人的写锁最多五秒。
      db.exec('PRAGMA busy_timeout = 5000');
      index = new channelIndexModule.ChannelIndex(db);
    }
    const wechatChannel = parsed.values.wechat_channel ?? 'wechat';
    const sources: [string, () => Iterable<Candidate> | AsyncIterable<Candidate>][] = [
      ['飞书', () => getFeishu(root)],
      ['微信', () => getWechat(db, wechatChannel)],
      ['网页', () => getWeb(db)],
      ['命令行', () => getCli(root)],
    ];

    //M 四个渠道挨个补，只打印条数。
    for (const [label, read] of sources) {
      const candidates = read();
      const count = await fill(index, candidates);
      if (!running) {
        console.log(`${label}：读到 ${String(count.read)} 条（只看，没写；加 --run yes 真补）`);
        continue;
      }
      console.log(`${label}：读到 ${String(count.read)} 条，新记 ${String(count.added)} 条，早有了 ${String(count.skipped)} 条`);
    }
  } finally {
    //M 读写失败时也释放 SQLite 连接。
    db.close();
  }
}

//M 把命令行逻辑限定在直接运行脚本时，插件导入只复用归档读取。
if (import.meta.main) {
  await runCli().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
