/** 微信消息格式和缓存表，内置渠道及独立进程共用。 */
import type * as sqlite from 'bun:sqlite';
import type * as readerModule from './Reader.ts';

/** 微信 SQLite 的语音类型，旧引擎没有 view 时也认得出来。 */
const VOICE_TYPE = 34;

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
    db.exec('CREATE TABLE IF NOT EXISTS wechat_messages'
      + ' (account TEXT, chat TEXT, source TEXT, local_id INTEGER, at INTEGER,'
      + ' from_self INTEGER, kind TEXT, sender TEXT, text TEXT, PRIMARY KEY (account, chat, source, local_id))');
    //M 2026-11-14 23:30 EST：存整条气泡视图（JSON），页面按种类画图片、语音条、卡片。老库补一列。
    if (!(db.query('PRAGMA table_info(wechat_messages)').all() as { name: string }[])
      .some((col) => col.name === 'view')) db.exec('ALTER TABLE wechat_messages ADD COLUMN view TEXT');
    //M 2026-11-14 23:15 EST：全部会话的同步进度（原来记在 wechat_watch.last_time，只有重点监听的有）。
    db.exec('CREATE TABLE IF NOT EXISTS wechat_sync'
      + ' (account TEXT, chat TEXT, name TEXT, is_group INTEGER, last_time INTEGER, PRIMARY KEY (account, chat))');
    //M 2026-11-15 00:17 EST：full=1 表示这个监听会话的历史已经全部补进库了（不只是最近一段）。
    if (!(db.query('PRAGMA table_info(wechat_sync)').all() as { name: string }[])
      .some((col) => col.name === 'full')) db.exec('ALTER TABLE wechat_sync ADD COLUMN full INTEGER');
    db.exec('CREATE TABLE IF NOT EXISTS wechat_outbox'
      + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, chat TEXT, name TEXT,'
      + ' text TEXT, state TEXT, note TEXT, at INTEGER)');
  }

  /**
   * 存一条微信消息进 wechat_messages；以前存过的（撞上表的唯一键）不重复存。同步、翻历史、补全量共用。
   * @param account 微信账号。
   * @param chat 哪个会话。
   * @param msg 读出来的一条消息。
   * @returns 这次新存进去是 true，以前存过是 false。
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

    //M INSERT OR IGNORE：撞上就不写，changes 是 0。
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
      JSON.stringify(view),
    );
    return result.changes > 0;
  }
}
