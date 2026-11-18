/**
 * 把各渠道的旧消息补进 memory 插件的渠道消息索引（memory_channel_messages，同目录的 ChannelIndex.ts）。
 * 新消息由 memory 插件听 channel/message、channel/reply 自己记；这个脚本只补插件挂上以前的，可以反复跑（记过的不再记）。
 * 放在 src7 里（不在 scripts/）：它用 src7 的 ChannelIndex，跟着 typecheck:src7 查；Main 不 import 它，编不进程序。
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
import * as util from 'node:util';
import * as channelIndexModule from './ChannelIndex.ts';


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
interface Candidate {
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
function readJsonl(file: string): { value: Record<string, unknown>; line: number }[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const values: { value: Record<string, unknown>; line: number }[] = [];
  for (const [index, text] of lines.entries()) {
    if (text.trim() === '') continue;

    try {
      values.push({ value: JSON.parse(text) as Record<string, unknown>, line: index + 1 });
    } catch {
      //M 坏行（写到一半断了的）：跳过。
      continue;
    }
  }
  return values;
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
function getFeishu(root: string): Candidate[] {
  const base = path.join(root, 'channels', 'feishu', 'chats');
  if (!fs.existsSync(base)) return [];

  const candidates: Candidate[] = [];
  for (const appId of fs.readdirSync(base)) {
    const appDir = path.join(base, appId);
    if (!fs.statSync(appDir).isDirectory()) continue;

    for (const fileName of fs.readdirSync(appDir)) {
      if (!fileName.endsWith('.jsonl')) continue;

      const chatId = fileName.slice(0, -'.jsonl'.length);

      //M 读这个聊天文件的每一行（坏行跳过），挑出正文和消息号（messageId，和 channel/message 一样）；没有正文、没有消息号的行不补。
      for (const { value } of readJsonl(path.join(appDir, fileName))) {
        const text = getString(value['text']);
        const key = getString(value['messageId']);
        if (text.trim() === '' || key === '') continue;

        //M 方向：bot 是机器人发的，别的都算聊天里的人。
        let direction: 'user' | 'bot' = 'user';
        if (value['direction'] === 'bot') {
          direction = 'bot';
        }

        //M 发言人在 sender 里（id、name）；机器人的回复键拼不出来，标成要按正文查重（fuzzy）。
        const sender = (value['sender'] ?? {}) as Record<string, unknown>;
        const row: channelIndexModule.ChannelRow = {
          key,
          channel: 'feishu',
          account: appId,
          chat: chatId,
          chatType: '',
          direction,
          senderId: getString(sender['id']),
          senderName: getString(sender['name']),
          bot: '',
          text,
          at: Number(value['createdAt']) || 0,
        };
        candidates.push({ row, fuzzy: direction === 'bot' });
      }
    }
  }
  return candidates;
}


/**
 * 微信：wechat_messages。键 JSON [渠道名, 账号, 分库:库内号]（和 wechat 插件发 channel/message 一样）；at 是秒。
 * @param db 运行时的库。
 * @param channel 微信插件的渠道名。
 */
function getWechat(db: bunSqlite.Database, channel: string): Candidate[] {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wechat_messages'").get();
  if (table === null) return [];

  const rows = db.query('SELECT account, chat, source, local_id, at, from_self, sender, text FROM wechat_messages').all() as Record<string, unknown>[];
  //M 逐行转成候选：键照微信插件发 channel/message 的拼法，才和插件新记的对得上，所以都不用查重（fuzzy 为 false）。
  const candidates: Candidate[] = [];
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
      at: Number(item['at']) * 1000,
    };
    candidates.push({ row, fuzzy: false });
  }
  return candidates;
}


/**
 * 网页：web_messages 里 channel = 'http' 的。用户的话键是 JSON ['http', 'local', 行号]（和 web-api 发 channel/message 一样）；
 * replies 里机器人的回话键另起（web-reply:<行号>:<第几条>），按正文查重。
 * @param db 运行时的库。
 */
function getWeb(db: bunSqlite.Database): Candidate[] {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_messages'").get();
  if (table === null) return [];

  const rows = db.query("SELECT id, bot, text, replies, created_at FROM web_messages WHERE channel = 'http'").all() as Record<string, unknown>[];
  const candidates: Candidate[] = [];
  for (const item of rows) {
    const id = String(item['id']);
    const bot = getString(item['bot']);
    const shared = { channel: 'http', account: 'local', chat: 'http:本机', chatType: 'local', bot };

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
      candidates.push({ row, fuzzy: false });
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
      candidates.push({ row, fuzzy: true });
    }
  }
  return candidates;
}


/**
 * 命令行：channels/cli/<日期>.jsonl，只有用户的话。键另起（cli-file:<文件名>:<行号>，文件里没存 channel/message 用的原始号），按正文查重。
 * @param root 运行时目录。
 */
function getCli(root: string): Candidate[] {
  const base = path.join(root, 'channels', 'cli');
  if (!fs.existsSync(base)) return [];

  const candidates: Candidate[] = [];
  for (const fileName of fs.readdirSync(base)) {
    if (!fileName.endsWith('.jsonl')) continue;

    //M 读这个日期文件的每一行（坏行跳过），取用户的话；没有正文的行不补。
    for (const { value, line } of readJsonl(path.join(base, fileName))) {
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
        at: Number(value['time']) || 0,
      };
      candidates.push({ row, fuzzy: true });
    }
  }
  return candidates;
}


/**
 * 把一个渠道的候选写进索引（或者只数）。
 * @param index 索引；只看时是 undefined。
 * @param candidates 候选。
 * @returns 条数。
 */
function fill(index: channelIndexModule.ChannelIndex | undefined, candidates: Candidate[]): Count {
  const count: Count = { read: candidates.length, added: 0, skipped: 0 };
  if (index === undefined) return count;

  for (const { row, fuzzy } of candidates) {
    //G 键拼不出来的：差不多的同一条已经有了就跳过。
    if (fuzzy && index.hasSimilar(row, SIMILAR_MS)) {
      count.skipped += 1;
      continue;
    }

    //M 记一条；键一样的早有了不动。
    if (index.add(row)) {
      count.added += 1;
      continue;
    }
    count.skipped += 1;
  }
  return count;
}


//M 参数：--data 运行时目录（必写），--run yes 才写，--wechat_channel 微信渠道名。
const parsed = util.parseArgs({
  options: { data: { type: 'string' }, run: { type: 'string' }, wechat_channel: { type: 'string' } },
  strict: true,
});
const root = parsed.values.data;
if (root === undefined || !fs.existsSync(path.join(root, 'data', 'jmbots7.db'))) {
  console.error('要写 --data <运行时目录>（里面要有 data/jmbots7.db）');
  process.exit(1);
}
const running = parsed.values.run === 'yes';
const wechatChannel = parsed.values.wechat_channel ?? 'wechat';

//M 开库：只看时只读；真补时读写（库已存在，不新建）。只传 readonly: false 时 bun 没有打开标志，会报 SQLITE_MISUSE，所以写成两种。
//M 真补时等别人的写锁最多 5 秒（服务开着也能跑）。
let openOptions: { readonly: true } | { readwrite: true } = { readonly: true };
if (running) {
  openOptions = { readwrite: true };
}
const db = new bunSqlite.Database(path.join(root, 'data', 'jmbots7.db'), openOptions);
let index: channelIndexModule.ChannelIndex | undefined;
if (running) {
  //M 真补才建索引对象（表不在就建）；只看时 index 是 undefined，fill 只数条数、不写。
  db.exec('PRAGMA busy_timeout = 5000');
  index = new channelIndexModule.ChannelIndex(db);
}

//M 四个渠道挨个补，打印条数（不打印内容）。
const sources: [string, () => Candidate[]][] = [
  ['飞书', () => getFeishu(root)],
  ['微信', () => getWechat(db, wechatChannel)],
  ['网页', () => getWeb(db)],
  ['命令行', () => getCli(root)],
];
for (const [label, read] of sources) {
  const count = fill(index, read());
  if (!running) {
    console.log(`${label}：读到 ${String(count.read)} 条（只看，没写；加 --run yes 真补）`);
    continue;
  }
  console.log(`${label}：读到 ${String(count.read)} 条，新记 ${String(count.added)} 条，早有了 ${String(count.skipped)} 条`);
}
db.close();
