/**
 * 外置微信自包含的本地 SQLite 消息缓存表、会话修订触发器与气泡可读摘要转换器。
 * 零跨目录依赖 `src7/`，保持表结构与字段语义 100% 兼容既有数据库。
 */
import type * as sqlite from 'bun:sqlite';
import type * as readerModule from './PureReader.ts';


/** 微信消息基础类型常量：34 为语音消息。 */
const VOICE_TYPE = 34;

/** 记录已在当前 SQLite 连接上安装过临时修订触发器的实例集合。 */
const revisionDbs = new WeakSet<sqlite.Database>();


/**
 * 在当前 SQLite 连接的 temp 空间挂载会话级变更计数触发器，供客服页轮询轻量判变。
 * @param db 已打开的外置微信消息库连接。
 */
export function ensureMessageRevisionTriggers(db: sqlite.Database): void {
  if (revisionDbs.has(db)) return;

  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wechat_messages'")
    .get();
  if (table === null) return;

  //M 在连接私有 temp 表内按 (account, chat) 递增修订计数，避免跨会话变更误触发重传。
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
 * 计算单个微信会话当前消息窗口的轻量版本号（组合实例启动代次、页版本、查询上限与会话修订号）。
 * @param db 微信消息库连接。
 * @param bootId 当前进程启动随机标识。
 * @param account 微信账号编号。
 * @param chat 会话原始 username。
 * @param limit 查询条数上限。
 */
export function getChatMessageVersion(
  db: sqlite.Database,
  bootId: string,
  account: string,
  chat: string,
  limit: number,
): string {
  //M 确保连接已挂载临时触发器后再读取修订号。
  ensureMessageRevisionTriggers(db);
  const dataRow = db.query('PRAGMA data_version').get() as { data_version?: number } | null;
  const dataVersion = dataRow?.data_version ?? 0;
  const revRow = db
    .query('SELECT rev FROM temp._wechat_chat_rev WHERE account = ? AND chat = ?')
    .get(account, chat) as { rev: number } | null;
  const rev = revRow?.rev ?? 0;
  return `${bootId}:${String(dataVersion)}:${String(limit)}:${String(rev)}`;
}


/**
 * 归一化单条原始消息的气泡视图（旧消息未带 kind 但 local_type 为 34 时补齐为 voice）。
 * @param message 读取器产出的原始消息。
 */
export function getMessageView(
  message: readerModule.RawMessage,
): NonNullable<readerModule.RawMessage['view']> {
  const view = message.view ?? {};
  if (view.kind === undefined && message.local_type === VOICE_TYPE) {
    return { ...view, kind: 'voice' };
  }
  return view;
}


/**
 * 格式化引用回复气泡里的原消息摘录后缀。
 * @param quote 引用字段。
 */
function formatQuote(quote: NonNullable<readerModule.RawMessage['view']>['quote']): string {
  if (!quote) return '';

  return `（引用 ${quote.name ?? ''}：${quote.text ?? ''}）`;
}


/**
 * 将结构化气泡视图转换为客服页与大模型共用的可读中文摘要。
 * @param view 消息气泡视图。
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
  if (v.kind === 'quote') {
    //M 拼接回复正文与被引用内容。
    return `${v.text ?? ''}${formatQuote(v.quote)}`;
  }
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


/** 外置微信进程私有的 SQLite 表初始化与消息去重落库器。 */
export class Store {
  /**
   * @param db 外置进程自己的 SQLite 数据库连接。
   */
  constructor(private readonly db: sqlite.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS wechat_watch'
      + ' (account TEXT, chat TEXT, name TEXT, auto INTEGER, last_time INTEGER, PRIMARY KEY (account, chat))');
    db.exec('CREATE TABLE IF NOT EXISTS wechat_messages'
      + ' (account TEXT, chat TEXT, source TEXT, local_id INTEGER, at INTEGER,'
      + ' from_self INTEGER, kind TEXT, sender TEXT, text TEXT, view TEXT,'
      + ' PRIMARY KEY (account, chat, source, local_id))');
    db.exec('CREATE TABLE IF NOT EXISTS wechat_sync'
      + ' (account TEXT, chat TEXT, name TEXT, is_group INTEGER, last_time INTEGER,'
      + ' full INTEGER, PRIMARY KEY (account, chat))');
    db.exec('CREATE TABLE IF NOT EXISTS wechat_outbox'
      + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, chat TEXT, name TEXT,'
      + ' text TEXT, state TEXT, note TEXT, at INTEGER)');
    //M 建表完成后确保临时会话修订触发器就绪。
    ensureMessageRevisionTriggers(db);
  }

  /**
   * 将单条微信消息去重写入 `wechat_messages`；若旧记录发生撤回变更则原地刷新展示字段但不算新消息。
   * @param account 微信账号标识。
   * @param chat 会话原始 username。
   * @param msg 待保存的消息对象。
   * @returns 首次新插入时返回 true，已存在（含原地更新）时返回 false。
   */
  save(account: string, chat: string, msg: readerModule.RawMessage): boolean {
    //M 提取标准化视图并计算落库文本与 JSON。
    const view = getMessageView(msg);
    let fromSelf = 0;
    if (msg.from_self === true) {
      fromSelf = 1;
    }
    const kind = view.kind ?? 'other';
    const sender = view.sender ?? '';
    //M 生成消息列表展示摘要与完整气泡 JSON。
    const text = describe(view);
    const viewJson = JSON.stringify(view);

    const sql = 'INSERT OR IGNORE INTO wechat_messages'
      + ' (account, chat, source, local_id, at, from_self, kind, sender, text, view)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    //M 执行幂等插入并根据受影响行数判断是否为新消息。
    const result = this.db.query(sql).run(
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

    //M 已存在记录若发生撤回等展示变化，原地更新字段但不触发新入站投递。
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
