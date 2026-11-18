/**
 * 微信历史响应器：监听标准事件 channel/history，从运行时库 wechat_messages 读取已保存的微信聊天记录，
 * 按统一分页与游标协议回传 channel/history-result（供 Wechat 插件挂载）。
 */
import type * as cordis from 'cordis';
import type { Database } from 'bun:sqlite';
import * as protocol from '../../Channels.ts';


/** wechat_messages 表查询行结构。 */
interface WechatMessageRow {
  /** 消息来源库标识（如 m0）。 */
  source: string;
  /** 微信本地消息自增序号。 */
  local_id: number;
  /** 消息时间戳（微信引擎记录为秒，兼容毫秒）。 */
  at: number;
  /** 是否本微信号发出（1 为自己，0 为对方）。 */
  from_self: number;
  /** 消息种类（text / image / file / video / voice / quote 等）。 */
  kind: string;
  /** 群内发言人名称或微信号（私聊通常为空）。 */
  sender: string;
  /** 归一化后的可读文本。 */
  text: string;
  /** 原始气泡视图 JSON 字符串。 */
  view: string | null;
}


/** 解析后的微信目标账号与聊天标识。 */
interface WechatTarget {
  /** 微信账号 ID。 */
  account: string;
  /** 微信聊天标识（wxid 或群聊 ID）。 */
  chat: string;
}


/** 需要生成脱敏附件条目的微信消息类型集合。 */
const ATTACHMENT_KINDS = new Set(['image', 'file', 'video', 'voice']);


/** 微信历史查询处理器：供 Wechat 插件在构造阶段挂载。 */
export class WechatHistory {
  /** 渠道名称。 */
  readonly name = 'wechat';

  /**
   * 登记 channel/history 事件监听。
   * @param ctx Wechat 插件的 Cordis 上下文（随插件卸载自动注销监听）。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 响应渠道历史查询事件，仅处理 channel 为 wechat 的请求。
    this.ctx.on('channel/history', (request) => this.onChannelHistory(request));
  }

  /**
   * 处理微信历史查询请求：校验权限与游标后从 wechat_messages 分页返回。
   * @param request 渠道历史查询请求。
   */
  private onChannelHistory(request: protocol.ChannelHistoryRequest): void {
    if (request.channel !== this.name) return;

    request.handled = true;
    const emitResult = (result: protocol.ChannelHistoryResult): void => {
      this.ctx.emit('channel/history-result', { ...result, requestId: request.requestId });
    };

    const snapshot = request.sourceSnapshot;
    const db = this.ctx.resources.db;
    //M 用来源快照与请求的会话标识确定查询目标，供权限校验与读库共用。
    const target = this.resolveTarget(db, snapshot, request.chatId);

    //G 二次核对访问权限：外人仅限本人当前所在的微信账号与聊天，本人放行跨渠道、跨聊天查询。
    const isOwner = protocol.isHistoryOwner(snapshot);
    const isSameChat = snapshot.channel === this.name
      && target.account === snapshot.accountId
      && target.chat === snapshot.chatId;
    if (!isOwner && !isSameChat) {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'forbidden', message: `无权访问微信聊天 ${target.chat}` },
      });
      return;
    }

    //G 微信本地消息表尚未保存结构化 @ 提及清单，mentions 模式明确返回 identity_unresolved。
    if (request.mode === 'mentions') {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: `${this.name}:${target.account}:${target.chat}`,
        completeness: 'local_only',
        error: { code: 'identity_unresolved', message: '微信本地消息表未保存结构化 @ 提及对象' },
      });
      return;
    }

    //M 从 wechat_messages 读取目标会话全部已存消息并转换成标准历史项。
    const entries = this.readEntries(db, target.account, target.chat);
    const result = protocol.paginateChannelHistory({
      request,
      channel: this.name,
      accountId: target.account,
      chatId: target.chat,
      entries,
    });

    //M 带上请求号送回分页结果，让调用方关联这次查询。
    emitResult(result);
  }

  /**
   * 判断数据库中是否存在指定表（兼容测试仅挂载部分表的场景）。
   * @param db 运行时 SQLite 数据库实例。
   * @param tableName 表名。
   * @returns 存在返回 true。
   */
  private hasTable(db: Database, tableName: string): boolean {
    //G 查 SQLite 元数据，兼容尚未创建该微信表的数据库。
    const row = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return row !== null && row !== undefined;
  }

  /**
   * 检查指定 (account, chat) 是否在微信任意持久化表中出现。
   * @param db 数据库实例。
   * @param account 微信账号 ID。
   * @param chat 微信聊天 ID。
   * @returns 存在记录返回 true。
   */
  private hasPair(db: Database, account: string, chat: string): boolean {
    //M 先以已有消息确认这个账号确实包含该会话。
    if (this.hasTable(db, 'wechat_messages')) {
      const hit = db.query('SELECT 1 FROM wechat_messages WHERE account = ? AND chat = ? LIMIT 1').get(account, chat);
      if (hit !== null && hit !== undefined) return true;
    }

    //M 消息表未命中时，用同步记录确认账号与会话对应关系。
    if (this.hasTable(db, 'wechat_sync')) {
      const hit = db.query('SELECT 1 FROM wechat_sync WHERE account = ? AND chat = ? LIMIT 1').get(account, chat);
      if (hit !== null && hit !== undefined) return true;
    }

    //M 未同步的会话也可能已加入监听，用监听记录补查。
    if (this.hasTable(db, 'wechat_watch')) {
      const hit = db.query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ? LIMIT 1').get(account, chat);
      if (hit !== null && hit !== undefined) return true;
    }
    return false;
  }

  /**
   * 仅按聊天标识在微信各表中查找最近关联的账号 ID。
   * @param db 数据库实例。
   * @param chat 微信聊天 ID。
   * @returns 命中的账号 ID，未找到返回空串。
   */
  private findAccountByChat(db: Database, chat: string): string {
    if (chat === '') return '';

    //M 优先从该会话最新的消息恢复所属账号。
    if (this.hasTable(db, 'wechat_messages')) {
      const msgRow = db.query('SELECT account FROM wechat_messages WHERE chat = ? ORDER BY at DESC LIMIT 1')
        .get(chat) as { account: string } | null;
      if (msgRow !== null && msgRow !== undefined) return msgRow.account;
    }

    //M 消息没有记录时，用最新同步记录找账号。
    if (this.hasTable(db, 'wechat_sync')) {
      const syncRow = db.query('SELECT account FROM wechat_sync WHERE chat = ? ORDER BY last_time DESC LIMIT 1')
        .get(chat) as { account: string } | null;
      if (syncRow !== null && syncRow !== undefined) return syncRow.account;
    }

    //M 仍无同步记录时，从监听名单查出账号。
    if (this.hasTable(db, 'wechat_watch')) {
      const watchRow = db.query('SELECT account FROM wechat_watch WHERE chat = ? LIMIT 1')
        .get(chat) as { account: string } | null;
      if (watchRow !== null && watchRow !== undefined) return watchRow.account;
    }
    return '';
  }

  /**
   * 核对指定 chat 字符串是否在微信表中出现。
   * @param db 数据库实例。
   * @param chat 微信聊天 ID。
   * @returns 存在返回 true。
   */
  private hasChat(db: Database, chat: string): boolean {
    //M 只要本地任一微信表能反查出账号，就认为该会话已知。
    return this.findAccountByChat(db, chat) !== '';
  }

  /**
   * 解析本次查询目标的微信账号与聊天 ID：兼容传入纯 chat、wechat:chat、account:chat 或缺省跨渠道默认定位。
   * @param db 数据库实例。
   * @param snapshot 当前来源快照。
   * @param requestedChatId 请求中传入的可选聊天标识。
   * @returns 解析后的目标账号与聊天标识。
   */
  private resolveTarget(
    db: Database,
    snapshot: protocol.SourceSnapshot,
    requestedChatId?: string,
  ): WechatTarget {
    //M 未传 chatId：优先沿用当前微信会话；跨渠道未指定 chat 时取最近活跃的一条微信会话。
    if (requestedChatId === undefined || requestedChatId.trim() === '') {
      if (snapshot.channel === this.name && snapshot.chatId !== '') {
        let ownAccount = 'local';
        if (snapshot.accountId !== '') {
          ownAccount = snapshot.accountId;
        }
        return { account: ownAccount, chat: snapshot.chatId };
      }

      //M 跨渠道未指定目标时，先找最后一条消息所在的微信会话。
      if (this.hasTable(db, 'wechat_messages')) {
        const latest = db.query('SELECT account, chat FROM wechat_messages ORDER BY at DESC, local_id DESC LIMIT 1')
          .get() as { account: string; chat: string } | null;
        if (latest !== null && latest !== undefined) return { account: latest.account, chat: latest.chat };
      }

      //M 无消息可用时，退回最近有时间记录的监听会话。
      if (this.hasTable(db, 'wechat_watch')) {
        const watched = db.query('SELECT account, chat FROM wechat_watch ORDER BY last_time DESC LIMIT 1')
          .get() as { account: string; chat: string } | null;
        if (watched !== null && watched !== undefined) return { account: watched.account, chat: watched.chat };
      }

      //M 监听名单也无记录时，使用最近同步的会话。
      if (this.hasTable(db, 'wechat_sync')) {
        const synced = db.query('SELECT account, chat FROM wechat_sync ORDER BY last_time DESC LIMIT 1')
          .get() as { account: string; chat: string } | null;
        if (synced !== null && synced !== undefined) return { account: synced.account, chat: synced.chat };
      }
      return { account: 'local', chat: '' };
    }

    const raw = requestedChatId.trim();
    let targetAccount = '';
    let targetChat = '';

    //M 解析带冒号前缀的格式（wechat:chat 或 account:chat），前提是整串不是现成 chat 名。
    if (raw.includes(':') && !this.hasChat(db, raw)) {
      const sep = raw.indexOf(':');
      const left = raw.slice(0, sep);
      const right = raw.slice(sep + 1);
      if (left === 'wechat' && right !== '') {
        targetChat = right;
      }
      if (left !== 'wechat' && left !== '' && right !== '') {
        targetAccount = left;
        targetChat = right;
      }
    }

    if (targetChat === '') {
      targetChat = raw;
    }

    if (targetAccount === '') {
      //M 同渠道同聊优先保留当前快照账号；否则按库里实际存在的记录匹配账号。
      if (snapshot.channel === this.name && snapshot.accountId !== '') {
        if (targetChat === snapshot.chatId || this.hasPair(db, snapshot.accountId, targetChat)) {
          targetAccount = snapshot.accountId;
        }
      }
    }

    if (targetAccount === '') {
      //M 请求未能确定账号时，用本地保存的会话归属补齐查询目标。
      targetAccount = this.findAccountByChat(db, targetChat);
    }

    if (targetAccount === '') {
      targetAccount = 'local';
      if (snapshot.channel === this.name && snapshot.accountId !== '') {
        targetAccount = snapshot.accountId;
      }
    }

    return { account: targetAccount, chat: targetChat };
  }

  /**
   * 查询会话的中文显示名（依次查找 wechat_sync 与 wechat_watch）。
   * @param db 数据库实例。
   * @param account 微信账号 ID。
   * @param chat 微信聊天 ID。
   * @returns 聊天展示名称；查不到返回空串。
   */
  private readChatName(db: Database, account: string, chat: string): string {
    //M 先用同步保存的名称标注历史消息所属的会话。
    if (this.hasTable(db, 'wechat_sync')) {
      const row = db.query('SELECT name FROM wechat_sync WHERE account = ? AND chat = ?')
        .get(account, chat) as { name: string | null } | null;
      if (typeof row?.name === 'string' && row.name !== '') return row.name;
    }

    //M 同步名称不存在时，尝试沿用监听名单记录的名称。
    if (this.hasTable(db, 'wechat_watch')) {
      const row = db.query('SELECT name FROM wechat_watch WHERE account = ? AND chat = ?')
        .get(account, chat) as { name: string | null } | null;
      if (typeof row?.name === 'string' && row.name !== '') return row.name;
    }
    return '';
  }

  /**
   * 从 wechat_messages 读取指定聊天的全部原始记录并映射成标准 ChannelHistoryItem 列表。
   * @param db 数据库实例。
   * @param account 微信账号 ID。
   * @param chat 微信聊天 ID。
   * @returns 标准历史摘要项数组。
   */
  private readEntries(db: Database, account: string, chat: string): protocol.ChannelHistoryItem[] {
    //G 缺会话号或微信消息表时，没有可供分页的本地消息。
    if (chat === '' || !this.hasTable(db, 'wechat_messages')) return [];

    //M 取目标会话的显示名与消息，供下面逐条转换成统一格式。
    const chatName = this.readChatName(db, account, chat);
    const rows = db.query(
      'SELECT source, local_id, at, from_self, kind, sender, text, view FROM wechat_messages WHERE account = ? AND chat = ?',
    ).all(account, chat) as WechatMessageRow[];

    const entries: protocol.ChannelHistoryItem[] = [];
    for (const row of rows) {
      const nativeId = `${row.source}:${String(row.local_id)}`;
      //M 把来源表与本地消息号变成跨渠道历史识别的消息 ID。
      const messageId = protocol.makeChannelMessageId(this.name, account, nativeId);

      //M 微信引擎落库为秒级时间戳，统一折算成毫秒；若已是毫秒则原样保留。
      let createdAt = row.at;
      if (row.at > 0 && row.at < 1_000_000_000_000) {
        createdAt = row.at * 1000;
      }

      let direction: 'user' | 'bot' = 'user';
      if (row.from_self === 1) {
        direction = 'bot';
      }

      //M 补齐标准历史项的发言人、可读正文和附件引用。
      const sender = this.buildSender(row, account, chat, chatName);
      const text = this.buildText(row);
      const attachments = this.buildAttachments(row, nativeId);

      entries.push({
        messageId,
        nativeId,
        direction,
        createdAt,
        sender,
        text,
        mentions: [],
        attachments,
      });
    }
    return entries;
  }

  /**
   * 组装标准发送者结构：自己发的标为“我”，群消息优先使用 sender 列，私聊附带会话显示名。
   * @param row 微信消息行。
   * @param account 微信账号 ID。
   * @param chat 微信聊天 ID。
   * @param chatName 会话展示名称。
   * @returns 标准发送者对象。
   */
  private buildSender(
    row: WechatMessageRow,
    account: string,
    chat: string,
    chatName: string,
  ): { id: string; name?: string } {
    if (row.from_self === 1) return { id: account, name: '我' };
    if (row.sender !== '') return { id: row.sender, name: row.sender };

    const sender: { id: string; name?: string } = { id: chat };
    if (chatName !== '') {
      sender.name = chatName;
    }
    return sender;
  }

  /**
   * 组装标准展示文本：空文本时回退为 [kind] 占位描述。
   * @param row 微信消息行。
   * @returns 可读消息文本。
   */
  private buildText(row: WechatMessageRow): string {
    if (row.text !== '') return row.text;

    let kindLabel = 'other';
    if (row.kind !== '') {
      kindLabel = row.kind;
    }
    return `[${kindLabel}]`;
  }

  /**
   * 为媒体/文件类型的微信消息生成脱敏附件元数据（绝不暴露任何本机路径）。
   * @param row 微信消息行。
   * @param nativeId 消息原生标识。
   * @returns 脱敏附件元数据列表。
   */
  private buildAttachments(
    row: WechatMessageRow,
    nativeId: string,
  ): protocol.ChannelHistoryItem['attachments'] {
    if (!ATTACHMENT_KINDS.has(row.kind)) return [];

    let title = '';
    if (row.view !== null && row.view !== '') {
      try {
        const parsed = JSON.parse(row.view) as { title?: unknown };
        if (typeof parsed.title === 'string') {
          title = parsed.title.trim();
        }
      } catch {
        title = '';
      }
    }

    let attachName = title;
    if (attachName === '') {
      if (row.kind === 'image') attachName = '图片';
      if (row.kind === 'file') attachName = '文件';
      if (row.kind === 'video') attachName = '视频';
      if (row.kind === 'voice') attachName = '语音';
    }
    if (attachName === '') {
      attachName = row.kind;
    }

    return [{
      id: `${nativeId}:att:1`,
      name: attachName,
      state: 'available',
    }];
  }
}
