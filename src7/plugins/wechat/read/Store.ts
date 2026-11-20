/** 微信消息格式和缓存表，内置渠道及独立进程共用。 */
import type * as sqlite from 'bun:sqlite';
import type * as readerModule from './Reader.ts';

/** 微信 SQLite 的语音类型，旧引擎没有 view 时也认得出来。 */
const VOICE_TYPE = 34;

/** 已在当前数据库连接上挂好会话变更临时触发器的实例集合。 */
const revisionDbs = new WeakSet<sqlite.Database>();

/**
 * 为当前数据库连接挂载会话级临时变更计数触发器（不改持久化表结构），用于识别新消息、历史补录与撤回更新。
 * @param db 微信消息所在的 SQLite 连接。
 */
export function ensureMessageRevisionTriggers(db: sqlite.Database): void {
  if (revisionDbs.has(db)) return;

  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wechat_messages'")
    .get();
  if (table === null) return;

  //M 在连接私有的 temp 库维护每个会话的写入修订号，增删改都递增，别的会话变动不互相干扰。
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _wechat_chat_rev'
    + ' (account TEXT NOT NULL, chat TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (account, chat))');
  db.exec('CREATE TEMP TRIGGER IF NOT EXISTS _wechat_msg_ai AFTER INSERT ON main.wechat_messages BEGIN'
    + ' INSERT INTO _wechat_chat_rev (account, chat, rev) VALUES (NEW.account, NEW.chat, 1)'
    + ' ON CONFLICT (account, chat) DO UPDATE SET rev = rev + 1; END');
  db.exec('CREATE TEMP TRIGGER IF NOT EXISTS _wechat_msg_au AFTER UPDATE ON main.wechat_messages BEGIN'
    + ' INSERT INTO _wechat_chat_rev (account, chat, rev) VALUES (NEW.account, NEW.chat, 1)'
    + ' ON CONFLICT (account, chat) DO UPDATE SET rev = rev + 1; END');
  db.exec('CREATE TEMP TRIGGER IF NOT EXISTS _wechat_msg_ad AFTER DELETE ON main.wechat_messages BEGIN'
    + ' INSERT INTO _wechat_chat_rev (account, chat, rev) VALUES (OLD.account, OLD.chat, 1)'
    + ' ON CONFLICT (account, chat) DO UPDATE SET rev = rev + 1; END');
  revisionDbs.add(db);
}

/**
 * 计算单个微信会话读取窗口当前的轻量版本号（结合进程代次、跨进程页版本、查询上限与本会话修订号）。
 * @param db 微信消息所在的 SQLite 连接。
 * @param bootId 当前服务实例启动代次。
 * @param account 微信账号。
 * @param chat 会话标识。
 * @param limit 查询上限。
 */
export function getChatMessageVersion(
  db: sqlite.Database,
  bootId: string,
  account: string,
  chat: string,
  limit: number,
): string {
  ensureMessageRevisionTriggers(db);
  const dataRow = db.query('PRAGMA data_version').get() as { data_version?: number } | null;
  const dataVersion = dataRow?.data_version ?? 0;
  const revRow = db
    .query('SELECT rev FROM temp._wechat_chat_rev WHERE account = ? AND chat = ?')
    .get(account, chat) as { rev: number } | null;
  const rev = revRow?.rev ?? 0;
  return `${bootId}:${String(dataVersion)}:${String(limit)}:${String(rev)}`;
}

/** 落库和通知使用同一份气泡类型。 */
export function getMessageView(message: readerModule.RawMessage): NonNullable<readerModule.RawMessage['view']> {
  const view = message.view ?? {};
  if (view.kind === undefined && message.local_type === VOICE_TYPE) return { ...view, kind: 'voice' };

  return view;
}

/**
 * 一条消息给人、给模型看的文字（2026-11-14 23:30 EST：原来非文字消息只剩空串，页面显示 [image]、模型也看不到）。
 * 照 jimukefu msgview 的种类：图片、语音、视频、链接/公众号文章、文件、引用、位置、名片、转账……
 */
//M 格式化引用回复里的摘录内容
function formatQuote(quote: NonNullable<readerModule.RawMessage['view']>['quote']): string {
  if (!quote) return '';

  return `（引用 ${quote.name ?? ''}：${quote.text ?? ''}）`;
}

/**
 * 把微信引擎的消息视图转成页面与模型共用的可读正文。
 * @param view 微信引擎的消息视图，可以缺省。
 * @returns 文字正文或带消息类型的摘要。
 */
export function describe(view: readerModule.RawMessage['view']): string {
  const v = view ?? {};
  const title = v.title ?? '';
  let desc = '';
  if (v.desc) {
    desc = ` — ${v.desc}`;
  }
  if (v.kind === 'text' || v.kind === 'system' || v.kind === 'call' || v.kind === 'other' || v.kind === undefined) {
    return v.text ?? '';
  }

  if (v.kind === 'image') return '[图片]';

  if (v.kind === 'emoji') return '[表情]';

  if (v.kind === 'voice') return `[语音 ${String(v.seconds ?? 0)} 秒]`;

  if (v.kind === 'video') return `[视频 ${String(v.seconds ?? 0)} 秒]`;

  //M 保留回复正文与引用摘录，让读者知道它回应了什么。
  if (v.kind === 'quote') return `${v.text ?? ''}${formatQuote(v.quote)}`;

  if (v.kind === 'location') return `[位置] ${title}${desc}`;

  if (v.kind === 'card') return `[名片] ${title}`;

  if (v.kind === 'transfer') return `[${v.desc ?? '转账'}] ${v.amount ?? ''}`;

  if (v.kind === 'file') return `[文件] ${title}`;

  let kindLabel = '文章/卡片';
  if (v.kind === 'link') {
    kindLabel = '链接';
  }
  return `[${kindLabel}] ${title}${desc}`;
}

/** 本地微信表及消息去重写入。 */
export class Store {
  /** @param db 内置或外置进程自己的 SQLite 数据库。 */
  constructor(private readonly db: sqlite.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS wechat_watch'
      + ' (account TEXT, chat TEXT, name TEXT, auto INTEGER, last_time INTEGER, PRIMARY KEY (account, chat))');
    //M view 保存整条气泡视图 JSON，供页面按消息类型渲染。
    db.exec('CREATE TABLE IF NOT EXISTS wechat_messages'
      + ' (account TEXT, chat TEXT, source TEXT, local_id INTEGER, at INTEGER,'
      + ' from_self INTEGER, kind TEXT, sender TEXT, text TEXT, view TEXT,'
      + ' PRIMARY KEY (account, chat, source, local_id))');

    //M 全部会话的同步进度，full=1 表示历史已补全。
    db.exec('CREATE TABLE IF NOT EXISTS wechat_sync'
      + ' (account TEXT, chat TEXT, name TEXT, is_group INTEGER, last_time INTEGER,'
      + ' full INTEGER, PRIMARY KEY (account, chat))');
    db.exec('CREATE TABLE IF NOT EXISTS wechat_outbox'
      + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, chat TEXT, name TEXT,'
      + ' text TEXT, state TEXT, note TEXT, at INTEGER)');
    ensureMessageRevisionTriggers(db);
  }

  /**
   * 存一条微信消息进 wechat_messages；以前存过的（撞上表的唯一键）不重复存，若撤回等字段变了则原地更新展示。
   * 同步、翻历史、补全量共用。
   * @param account 微信账号。
   * @param chat 哪个会话。
   * @param msg 读出来的一条消息。
   * @returns 这次新存进去是 true，以前存过（含原地更新撤回）是 false。
   * 副作用：写库。
   */
  save(account: string, chat: string, msg: readerModule.RawMessage): boolean {
    //M 消息里给人看的那块（类型、谁说的、内容）拆成表里的几列。
    const view = getMessageView(msg);
    let fromSelf = 0;
    if (msg.from_self === true) {
      fromSelf = 1;
    }
    const kind = view.kind ?? 'other';
    const sender = view.sender ?? '';
    //M 与入站事件共用正文格式，让落库的非文字消息也可读。
    const text = describe(view);
    const viewJson = JSON.stringify(view);

    //M INSERT OR IGNORE：新消息插入并返回 true，触发临时修订号递增。
    const sql = 'INSERT OR IGNORE INTO wechat_messages'
      + ' (account, chat, source, local_id, at, from_self, kind, sender, text, view)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const insert = this.db.query(sql);
    const result = insert.run(
      account,
      chat,
      msg.source,
      msg.local_id,
      msg.create_time,
      fromSelf,
      kind,
      sender,
      text,
      viewJson,
    );
    if (result.changes > 0) return true;

    //M 已落库消息若在微信侧发生撤回等原地变化，更新展示字段并推进修订号，但不当新消息重派机器人。
    const updateSql = 'UPDATE wechat_messages SET from_self = ?, kind = ?, sender = ?, text = ?, view = ?'
      + ' WHERE account = ? AND chat = ? AND source = ? AND local_id = ?'
      + " AND (from_self != ? OR kind != ? OR sender != ? OR text != ? OR IFNULL(view, '') != ?)";
    this.db.query(updateSql).run(
      fromSelf, kind, sender, text, viewJson,
      account, chat, msg.source, msg.local_id,
      fromSelf, kind, sender, text, viewJson,
    );
    return false;
  }
}
