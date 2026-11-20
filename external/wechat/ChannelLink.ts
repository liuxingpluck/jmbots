/** 微信独立进程的渠道接口：持久化入站待交队列，提供草稿和历史回调。 */
import type * as sqlite from 'bun:sqlite';
import type * as fastify from 'fastify';
import * as historyModule from './HistoryCache.ts';
import * as protocol from './Protocol.ts';
import type * as readerModule from './read/PureReader.ts';
import * as storeModule from './read/Store.ts';

/** 一次历史回调最多补这几批，深历史可以用原游标继续。 */
const BACKFILL_PAGES = 3;

/** 微信引擎缓存中的历史记录。 */
interface MessageRow {
  /** 数据分片。 */
  source: string;
  /** 分片内消息号。 */
  local_id: number;
  /** 微信时间，Unix 秒。 */
  at: number;
  /** 1 表示本账号发出。 */
  from_self: number;
  /** 气泡类别。 */
  kind: string;
  /** 引擎提供的发送者显示名。 */
  sender: string;
  /** 可读正文。 */
  text: string;
}

/** 两个方向共用微信会话、分片和本地消息号。 */
function getNativeId(chat: string, source: string, localId: number): string {
  return JSON.stringify([chat, source, localId]);
}

/** 缓存和增量都使用同一发信人编号。群聊只有引擎给出的昵称。 */
function getSender(account: string, chat: string, name: string, fromSelf: boolean): { id: string; name?: string } {
  if (fromSelf) return { id: account };

  if (name === '') return { id: chat };

  return { id: name, name };
}

/** 收到的附件用类型摘要表示，原件由微信客服页按原规则读取。 */
function getAttachments(kind: string): protocol.AttachmentNote[] {
  if (kind === 'voice') return [{ name: '语音', mime: 'audio/silk' }];

  if (kind === 'image') return [{ name: '图片' }];

  if (kind === 'video') return [{ name: '视频' }];

  if (kind === 'file') return [{ name: '文件' }];

  return [];
}

/** 绑定一个已登记渠道，保存待交消息并代答主程序的调用。 */
export class ChannelLink {
  /** @param db 独立微信的数据库，缓存和入站待交在同一事务内写入。 */
  constructor(
    private readonly db: sqlite.Database,
    private readonly channel: string,
    private readonly callback: string,
    private readonly key: string,
  ) {
    //M 独立进程重启后继续交未收下的消息，无需回扫微信记录。
    db.exec('CREATE TABLE IF NOT EXISTS wechat_channel_pending'
      + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, account TEXT, chat TEXT, payload TEXT)');
    db.exec('CREATE INDEX IF NOT EXISTS wechat_channel_pending_scope'
      + ' ON wechat_channel_pending(channel, account, chat)');

    //M 第一步留下的草稿表兼容旧库，只加一个用于原样重放的回调请求号。
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(wechat_outbox)').all();
    if (!columns.some((column) => column.name === 'request_id')) {
      db.exec('ALTER TABLE wechat_outbox ADD COLUMN request_id TEXT');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS wechat_outbox_request ON wechat_outbox(request_id)');
  }

  /** 新的监听消息随缓存一起落库。调用者已按监听规则筛好消息。 */
  enqueue(account: string, chat: string, name: string, group: boolean, message: readerModule.RawMessage): void {
    //M 沿用缓存的正文，并用会话、分片和本地号生成可重放的来源号。
    const view = storeModule.getMessageView(message);
    const kind = view.kind ?? 'other';
    const attachments = getAttachments(kind);
    const nativeId = getNativeId(chat, message.source, message.local_id);
    const sender = getSender(account, chat, view.sender ?? '', false);
    const description = storeModule.describe(view);
    const text = description.trim() || '[微信消息]';
    let chatType: protocol.InboundMessage['chatType'] = 'p2p';
    if (group) {
      chatType = 'group';
    }
    const body: protocol.InboundMessage = {
      channel: this.channel,
      account,
      chat,
      chatName: name,
      nativeId,
      chatType,
      sender,
      text,
      attachments,
      createdAt: message.create_time * 1000,
      mentioned: message.at_me,
    };
    const payload = JSON.stringify(body);
    const sql = 'INSERT INTO wechat_channel_pending (channel, account, chat, payload) VALUES (?,?,?,?)';

    //M 加入当前会话同步事务，保证入队与游标一起提交。
    const insert = this.db.query(sql);
    insert.run(this.channel, account, chat, payload);
  }

  /** 取消监听时清除这个会话尚未交出的消息。 */
  unwatch(account: string, chat: string): void {
    const sql = 'DELETE FROM wechat_channel_pending WHERE channel = ? AND account = ? AND chat = ?';

    //M 取消监听只清理该账号和聊天对应的待交记录。
    const remove = this.db.query(sql);
    remove.run(this.channel, account, chat);
  }

  /** 顺序交出待交消息，主程序确认收下或重复后才清除。失败留在库中等下轮。 */
  async flush(signal: AbortSignal): Promise<void> {
    //M 每次取队首，提交过程中取消监听时下一条不会再发。
    const select = this.db.query<{ id: number; payload: string }, [string]>(
      'SELECT id, payload FROM wechat_channel_pending WHERE channel = ? ORDER BY id LIMIT 1',
    );
    const remove = this.db.query('DELETE FROM wechat_channel_pending WHERE id = ?');
    const headers = { 'content-type': 'application/json', [protocol.KEY_HEADER]: this.key };
    const url = `${this.callback}/channel/message`;
    for (let count = 0; count < 50; count += 1) {
      if (signal.aborted) return;

      //M 每次重新取队首，尊重可能变更的监听开关。
      const row = select.get(this.channel);
      if (row === null) return;

      //M 网络失败或超时保留同一来源号，下次主程序可识别重放。
      const deadline = AbortSignal.timeout(5000);
      const lifetime = AbortSignal.any([signal, deadline]);
      const options: RequestInit = {
        method: 'POST',
        redirect: 'error',
        headers,
        body: row.payload,
        signal: lifetime,
      };
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`微信入站回调返回 HTTP ${String(response.status)}`);

      const receipt = await response.json() as Partial<protocol.InboundReceipt>;
      if (receipt.ok !== true || (receipt.status !== 'accepted' && receipt.status !== 'duplicate')) {
        throw new Error('主程序尚未确认收到微信消息');
      }

      //M 收到主程序回执才删除这条待交记录。
      remove.run(row.id);
    }
  }

  /** 挂载只供当前主程序调用的回复和历史接口。 */
  mount(app: fastify.FastifyInstance, cache?: historyModule.HistoryCache): void {
    //G 同一个入口先查密钥和渠道，再查操作各自的参数。
    const authorize = async (request: fastify.FastifyRequest, reply: fastify.FastifyReply) => {
      const given = request.headers[protocol.KEY_HEADER];
      if (!protocol.isSameKey(this.key, given)) {
        return reply.code(401).send({ status: 'failed', reason: '主程序密钥不对' });
      }
      const body = request.body as Record<string, unknown> | null | undefined;
      if (body?.['channel'] !== this.channel) {
        return reply.code(403).send({ status: 'failed', reason: '渠道没有登记给本程序' });
      }
    };

    //M Fastify 在调用业务方法前跑完授权和入参校验。
    const options = { preHandler: authorize };
    app.post('/jmbots/v1/channel/reply', options, (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const requestId = body['requestId'];
      const account = body['account'];
      const chat = body['chat'];
      const text = body['text'];
      if (typeof requestId !== 'string' || requestId.trim() === '' || typeof account !== 'string'
        || typeof chat !== 'string' || chat.trim() === '' || typeof text !== 'string' || text.trim() === '') {
        return reply.code(400).send({ status: 'failed', reason: '回复需要请求号、账号、聊天号和正文' });
      }
      return this.saveDraft(requestId, account, chat, text);
    });
    app.post('/jmbots/v1/channel/history', options, (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const account = body['account'];
      const chat = body['chat'];
      const limit = body['limit'];
      const before = body['before'];
      const senderId = body['senderId'];
      if (typeof account !== 'string' || typeof chat !== 'string' || chat.trim() === ''
        || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200
        || (before !== undefined && typeof before !== 'string')
        || (senderId !== undefined && (typeof senderId !== 'string' || senderId === ''))) {
        const error = { code: 'bad_request', message: '历史查询的会话、页大小、游标或发送者无效' };
        return reply.code(400).send({ ok: false, error });
      }
      return this.history(account, chat, limit, before, senderId, cache);
    });
  }

  /** 只给已监听会话存草稿，重试收到原回执；同一请求号不能改正文或会话。 */
  private saveDraft(requestId: string, account: string, chat: string, text: string) {
    //M 先查旧请求，即使已取消监听也能交回已存的回执。
    const sql = 'SELECT account, chat, text FROM wechat_outbox WHERE request_id = ?';
    const key = JSON.stringify([this.channel, requestId]);
    const existing = this.db.query<{ account: string; chat: string; text: string }, [string]>(sql).get(key);
    if (existing !== null) {
      if ((account !== '' && existing.account !== account) || existing.chat !== chat || existing.text !== text) {
        return { status: 'failed', reason: '相同请求号的草稿内容或地址有变' };
      }
      return { status: 'draft' };
    }

    //G 跨渠道指定聊天时账号为空，只在唯一匹配的监听会话落草稿。
    const find = 'SELECT account, name FROM wechat_watch WHERE chat = ? AND (? = \'\' OR account = ?) LIMIT 2';
    const matches = this.db.query<{ account: string; name: string }, [string, string, string]>(find)
      .all(chat, account, account);
    const target = matches[0];
    if (matches.length !== 1 || target === undefined) {
      return { status: 'failed', reason: '无法唯一确定已监听的微信会话' };
    }

    //M 请求号和正文在一条 SQL 一起存好，退出重启后仍能去重。
    const insert = 'INSERT INTO wechat_outbox (account, chat, name, text, state, note, at, request_id)'
      + " VALUES (?,?,?,?,'draft','',?,?)";
    this.db.query(insert).run(target.account, chat, target.name, text, Date.now(), key);
    return { status: 'draft' };
  }

  /** 返回指定会话的历史，缓存不足时从同一账号和会话补录。 */
  private async history(
    account: string,
    chat: string,
    limit: number,
    before: string | undefined,
    senderId: string | undefined,
    cache: historyModule.HistoryCache | undefined,
  ) {
    let resolved = account;
    if (account === '') {
      const sql = 'SELECT account FROM wechat_sync WHERE chat = ? LIMIT 2';
      //G 跨渠道查询只在唯一的账号中定位会话。
      const find = this.db.query<{ account: string }, [string]>(sql);
      const matches = find.all(chat);
      const target = matches[0];
      if (matches.length !== 1 || target === undefined) {
        return { ok: false, error: { code: 'chat_not_found', message: '无法唯一确定已同步的微信会话' } };
      }
      resolved = target.account;
    }

    //G 只接受这个账号、聊天内的边界消息号；账号解析变化后不继续翻原来的页。
    let until: Pick<MessageRow, 'at' | 'source' | 'local_id'> | null = null;
    if (before !== undefined) {
      let parts: unknown;
      try {
        parts = JSON.parse(before);
      } catch {
        return { ok: false, error: { code: 'invalid_cursor', message: '历史游标格式不对' } };
      }
      if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== resolved || parts[1] !== chat
        || typeof parts[2] !== 'string' || typeof parts[3] !== 'number' || !Number.isSafeInteger(parts[3])) {
        return { ok: false, error: { code: 'invalid_cursor', message: '翻页起点不属于这场聊天' } };
      }
      const sql = 'SELECT at, source, local_id FROM wechat_messages'
        + ' WHERE account = ? AND chat = ? AND source = ? AND local_id = ?';
      until = this.db.query<Pick<MessageRow, 'at' | 'source' | 'local_id'>, [string, string, string, number]>(sql)
        .get(resolved, chat, parts[2], parts[3]);
      if (until === null) {
        return { ok: false, error: { code: 'invalid_cursor', message: '翻页起点已失效或不属于这场聊天' } };
      }
    }

    //M 先按发送者筛选，再用时间、分片和本地号取最近一页。
    let sql = 'SELECT source, local_id, at, from_self, kind, sender, text FROM wechat_messages'
      + ' WHERE account = ? AND chat = ?';
    const params: Array<string | number> = [resolved, chat];
    if (senderId !== undefined) {
      sql += " AND CASE WHEN from_self = 1 THEN account WHEN sender = '' THEN chat ELSE sender END = ?";
      params.push(senderId);
    }
    if (until !== null) {
      sql += ' AND (at, source, local_id) < (?, ?, ?)';
      params.push(until.at, until.source, until.local_id);
    }
    sql += ' ORDER BY at DESC, source DESC, local_id DESC LIMIT ?';

    //M 多取一条判断当前会话还有没有下一页。
    params.push(limit + 1);
    const select = this.db.query<MessageRow, Array<string | number>>(sql);
    let rows = select.all(...params);

    //M 本地记录不够时按当前过滤范围补录，再用同一个复合游标重查。
    if (cache !== undefined && rows.length <= limit) {
      try {
        for (let count = 0; count < BACKFILL_PAGES && rows.length <= limit; count += 1) {
          if (cache.isComplete(resolved, chat)) break;

          await cache.fill(resolved, chat);
          rows = select.all(...params);
        }
      } catch (error) {
        //G 引擎失败明确回错，让调用方保留同一个分页条件重试。
        if (error instanceof historyModule.HistoryError) {
          return { ok: false, error: { code: error.code, message: error.message } };
        }
        return { ok: false, error: { code: 'history_error', message: '微信历史补录失败' } };
      }

      //G 只在确认读尽时返回没有下一页。
      if (rows.length <= limit && !cache.isComplete(resolved, chat)) {
        const error = { code: 'history_incomplete', message: '更早记录仍在补录，可用原游标重试' };
        return { ok: false, error };
      }
    }

    const page = rows.slice(0, limit).reverse();
    const first = page[0];
    let next: string | null = null;
    if (rows.length > limit && first !== undefined) {
      next = JSON.stringify([resolved, chat, first.source, first.local_id]);
    }

    //M 交回时间正序的稳定消息号以及和入站一致的发送者、正文及附件。
    const items = page.map((row) => {
      const fromSelf = row.from_self === 1;
      let direction: 'user' | 'bot' = 'user';
      if (fromSelf) {
        direction = 'bot';
      }
      return {
        nativeId: getNativeId(chat, row.source, row.local_id),
        direction,
        createdAt: row.at * 1000,
        sender: getSender(resolved, chat, row.sender, fromSelf),
        text: row.text.trim() || '[微信消息]',
        attachments: getAttachments(row.kind),
      };
    });
    return { ok: true, account: resolved, chat, items, next };
  }
}
