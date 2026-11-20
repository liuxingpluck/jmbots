/** 微信独立进程按需缓存聊天记录，并同步已监听的外部渠道会话。 */
import type * as sqlite from 'bun:sqlite';
import type * as fastify from 'fastify';
import * as linkModule from './ChannelLink.ts';
import * as historyModule from './HistoryCache.ts';
import type * as readerModule from './read/PureReader.ts';
import * as storeModule from './read/Store.ts';

/** 微信公众号、系统会话和未识别的特殊会话仅存档。 */
const SKIP_REPLY = new RegExp(
  '^(gh_|@|(?:filehelper|weixin|notifymessage|fmessage|floatbottle|medianote|newsapp|qqmail'
  + '|brandsessionholder|brandservicesessionholder|qmessage|tmessage|qqsync)$)',
  'u',
);

/** 每账号每轮最多归档这些未监听会话，监听会话照常先同步。 */
const ARCHIVE_BATCH = 60;
/** 每账号每轮处理的监听历史补录批数。 */
const HISTORY_BATCHES = 3;

/** 独立进程启动时校验的读取配置。 */
export interface ReaderSettings {
  /** 轮询毫秒数，0 表示不启动后台轮询。 */
  intervalMs: number;
  /** 每个账号最多从最近会话清单读多少个。 */
  chatLimit: number;
  /** 开启后轮询未监听的会话并归档。 */
  archiveAll: boolean;
}

/** 保留已有的轮询节拍与会话限制，全会话归档显式启用。 */
export const DEFAULT_READ_SETTINGS: ReaderSettings = { intervalMs: 3000, chatLimit: 5000, archiveAll: false };

/** 一次只读同步里的目标会话。 */
interface Chat {
  /** 会话标识。 */
  chat: string;
  /** 最近会话显示名。 */
  name: string;
  /** 增量起点，首次为空。 */
  since: number | null;
  /** 请求已经知道的最新时间。 */
  at: number;
}

/** 为客服页提供会话记录，无需 jmbots 进程对象。 */
export class ReaderService {
  /** 告诉共用路由在打开的会话上读增量。 */
  readonly syncOnRead = true;
  /** 供客服页显示最近一次同步情况。 */
  readonly status = { rounds: 0, lastRunAt: 0, lastError: '', busy: false, chats: 0, synced: 0, pending: 0 };
  /** 独立进程里的消息写入器。 */
  private readonly store: storeModule.Store;
  /** 按账号及会话持久化往前补录的进度。 */
  private readonly history: historyModule.HistoryCache;
  /** 同一账号顺序读取及写库，避免网页读取抢走后台本要入队的新消息。 */
  private readonly pending = new Map<string, Promise<void>>();
  /** 多个页面同时刷新相同会话时共用一批读取。 */
  private readonly batches = new Map<string, Promise<void>>();
  /** 非监听归档失败时从下一组继续，保留失败会话的重试机会。 */
  private readonly archiveOffsets = new Map<string, number>();
  /** 每轮从上次排过的会话后开始，补录失败的会话也不挡其余会话。 */
  private readonly historyOffsets = new Map<string, number>();
  /** 启用回调后才会监听会话和代答主程序。 */
  private link?: linkModule.ChannelLink;

  /**
   * @param reader 本机只读微信引擎。
   * @param db 这个独立进程使用的微信库。
   * @param config 启动时校验好的读取选项。
   */
  constructor(
    readonly reader: readerModule.Reader,
    private readonly db: sqlite.Database,
    readonly config: ReaderSettings = DEFAULT_READ_SETTINGS,
  ) {
    //M 两边使用相同表、类型和消息去重键。
    this.store = new storeModule.Store(db);
    this.history = new historyModule.HistoryCache(db, reader, this.store);
  }

  /** 启用当前启动配置登记的渠道，并登记监听开关。 */
  connect(app: fastify.FastifyInstance, channel: string, callback: string, key: string): void {
    //M 先挂回调，再开放客服的监听开关；监听仅支持生成草稿。
    const link = new linkModule.ChannelLink(this.db, channel, callback, key);
    this.link = link;
    link.mount(app, this.history);
    app.put('/api/wechat-kefu/watch', (request, reply) => {
      const body = request.body as Record<string, unknown> | null | undefined;
      const account = body?.['account'];
      const chat = body?.['chat'];
      const watch = body?.['watch'];
      const name = body?.['name'];
      if (typeof account !== 'string' || typeof chat !== 'string' || chat.trim() === ''
        || typeof watch !== 'boolean' || (name !== undefined && typeof name !== 'string')) {
        return reply.code(400).send({ error: '监听需要账号、聊天号和开关' });
      }
      //G 自动发送由后续切换启用，目前监听仅生成草稿。
      if (body?.['auto'] === true) return reply.code(409).send({ error: '外置微信当前只存草稿' });

      //G 账号必须由微信引擎确认，不能用任意字符串定位账号目录。
      const accounts = this.reader.accounts();
      if (!accounts.some((entry) => entry.id === account)) {
        return reply.code(400).send({ error: '微信账号尚未连接' });
      }

      //M 同步开始时依据监听记录选择增量或只归档的首轮。
      if (watch) {
        const sql = 'INSERT INTO wechat_watch (account,chat,name,auto,last_time) VALUES (?,?,?,0,NULL)'
          + ' ON CONFLICT (account,chat) DO UPDATE SET name=excluded.name,auto=0';
        const displayName = name || chat;
        this.db.query(sql).run(account, chat, displayName);
        return { ok: true };
      }

      //M 取消后同一事务里清理尚待交给主程序的记录。
      const stopWatching = this.db.transaction(() => {
        this.db.query('DELETE FROM wechat_watch WHERE account = ? AND chat = ?').run(account, chat);
        link.unwatch(account, chat);
      });
      stopWatching();
      return { ok: true };
    });
  }

  /** 后台同步所有已连接账号，按配置归档未监听会话，最后提交待交队列。 */
  async pollWatched(signal: AbortSignal): Promise<void> {
    //M 各账号独立推进游标。一轮中其他账号成功也保留已经发现的失败。
    const directory = this.reader.accounts();
    let chats = 0;
    let pending = 0;
    let issue = '';
    try {
      for (const account of directory) {
        if (signal.aborted) return;

        //M 一个账号读取失败时下一账号照常执行。
        try {
          const result = await this.pollAccount(account.id, signal);
          chats += result.chats;
          pending += result.pending;
        } catch (error) {
          issue = this.getReadError(error);
        }
      }
    } finally {
      this.status.chats = chats;
      this.status.pending = pending;
      this.status.lastError = issue;

      //M 一次轮询访问完账号后再更新统计，成功空列表也算完成一轮。
      this.finishRound();

      //M 读取与入站回调分别处理，账号出错也不会挡已入队消息。
      await this.link?.flush(signal);
    }
  }

  /** 优先同步监听会话，再拾取发生变化的未监听会话和较早的历史。 */
  private async pollAccount(account: string, signal: AbortSignal): Promise<{ chats: number; pending: number }> {
    let watches: Chat[] = [];
    if (this.link !== undefined) {
      //M 启用了回调时优先同步监听名单。纯归档模式使用缓存自己的进度。
      const sql = 'SELECT chat,name,last_time AS since,0 AS at FROM wechat_watch WHERE account = ?';
      watches = this.db.query<Chat, [string]>(sql).all(account);
    }
    const targets = [...watches];
    let chats = watches.length;
    let pending = 0;
    let trouble: unknown;
    if (this.config.archiveAll) {
      try {
        //M 会话列表的时间只用于筛选有变化的未监听会话。
        const sessions = await this.reader.sessions(account, this.config.chatLimit);
        const watchIds = new Set(watches.map((watch) => watch.chat));
        const knownSql = 'SELECT chat,last_time FROM wechat_sync WHERE account = ?';
        const records = this.db.query<{ chat: string; last_time: number }, [string]>(knownSql).all(account);
        const known = new Map(records.map((record) => [record.chat, record.last_time]));
        const archive = sessions.filter((item) => {
          if (watchIds.has(item.username)) return false;

          const last = known.get(item.username);
          return last === undefined || item.timestamp > last;
        });
        //M 首次可能有大量会话，轮换批次可继续处理排在失败会话后面的记录。
        const offset = this.archiveOffsets.get(account) ?? 0;
        const start = offset % Math.max(1, archive.length);
        const tail = archive.slice(start, start + ARCHIVE_BATCH);
        const head = archive.slice(0, Math.min(start, ARCHIVE_BATCH - tail.length));
        const limited = [...tail, ...head];
        this.archiveOffsets.set(account, start + limited.length);
        for (const item of limited) {
          const since = known.get(item.username) || null;
          targets.push({ chat: item.username, name: item.chat, since, at: item.timestamp });
        }
        chats = sessions.length;
        pending = archive.length - limited.length;
      } catch (error) {
        trouble = error;
      }
    }

    //M 列表请求失败也继续读取已知监听会话，再按轮换顺序补录。
    if (signal.aborted) return { chats, pending };
    try {
      if (targets.length > 0) {
        await this.syncBatch(account, targets);
      }
    } catch (error) {
      trouble = error;
    }

    //M 只补首轮已同步的监听会话，轮换起点，避免失败会话挡住后面的会话。
    const incompleteSql = 'SELECT w.chat FROM wechat_watch w JOIN wechat_sync s USING (account, chat)'
      + ' WHERE w.account = ? AND w.last_time IS NOT NULL AND IFNULL(s.full, 0) = 0 ORDER BY w.chat';
    const incomplete = this.db.query<{ chat: string }, [string]>(incompleteSql).all(account);
    const count = Math.min(incomplete.length, HISTORY_BATCHES);

    //M 从上次轮到的位置继续。
    const offset = this.historyOffsets.get(account) ?? 0;
    for (let index = 0; index < count && !signal.aborted; index += 1) {
      const row = incomplete[(offset + index) % incomplete.length]!;
      try {
        await this.history.fill(account, row.chat);
      } catch (error) {
        trouble = error;
      }
    }
    if (incomplete.length > 0) {
      const next = (offset + count) % incomplete.length;
      this.historyOffsets.set(account, next);
    }
    if (trouble !== undefined) throw trouble;

    return { chats, pending };
  }

  /** 客服页点开已监听会话时也能推进补录；错误由状态接口显示。 */
  async backfillAll(account: string, chat: string): Promise<void> {
    try {
      await this.history.fill(account, chat);
    } catch (error) {
      this.status.lastError = this.getReadError(error);
    }
  }

  /** 退出前等正在落库的读取结束。 */
  async drain(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    await this.history.drain();
  }

  /** 给客服状态的错误只说明原因，避免把账号、引擎路径或原始回执写进日志。 */
  private getReadError(error: unknown): string {
    if (error instanceof historyModule.HistoryError) return error.message;

    return '微信引擎未能完成本轮读取，可稍后重试';
  }

  /** 更新客服页的完成时刻与已归档会话数。 */
  private finishRound(): void {
    //M 批次可能重复读同一会话，从库统计会话数而不是累计批次条数。
    const sql = 'SELECT COUNT(*) AS count FROM wechat_sync';
    const total = this.db.query<{ count: number }, []>(sql);
    const row = total.get();
    this.status.synced = row?.count ?? 0;
    this.status.lastRunAt = Date.now();
    this.status.rounds += 1;
  }

  /**
   * 同步页面正在看的已连接账号，符合监听规则的新增消息随缓存一起入队。
   * @param account 已连接的微信账号。
   * @param chats 页面请求更新的会话。
   */
  async syncChats(account: string, chats: Chat[]): Promise<void> {
    //G 客服页的账号字段必须指向引擎中已连接的账号。
    const accounts = this.reader.accounts();
    if (!accounts.some((entry) => entry.id === account)) throw new Error('微信账号尚未连接');

    //M 网页与轮询走同一账号的同步顺序。
    await this.syncBatch(account, chats);
    this.status.lastError = '';
    this.finishRound();
  }

  /** 网页与后台按账号顺序完成读取和写入，失败不挡下一批。 */
  private async syncBatch(account: string, chats: Chat[]): Promise<void> {
    //M 重复刷新的页面沿用正在进行的读取，不在慢速引擎前重复排队。
    const key = JSON.stringify([account, chats.map((entry) => entry.chat)]);
    const batch = this.batches.get(key);
    if (batch !== undefined) return batch;

    //M 先接上同账号队尾，轮到本批才按最新监听位置读取。
    const previous = this.pending.get(account) ?? Promise.resolve();
    const syncing = previous.catch(() => undefined).then(() => this.sync(account, chats)).catch((error: unknown) => {
      //G 共用批次的所有调用方都收到同一个安全的错误。
      const reason = this.getReadError(error);
      this.status.lastError = reason;
      throw new historyModule.HistoryError('sync_error', reason);
    });
    this.pending.set(account, syncing);
    this.batches.set(key, syncing);

    this.status.busy = true;
    try {
      await syncing;
    } finally {
      //M 只有当前一批还是队尾时才释放账号的同步状态。
      this.batches.delete(key);
      if (this.pending.get(account) === syncing) {
        this.pending.delete(account);
      }
      this.status.busy = this.pending.size > 0;
    }
  }

  /** 读取并在同一事务中写入消息和进度。 */
  private async sync(account: string, chats: Chat[]): Promise<void> {
    //M 已监听会话使用监听位置，首次同步不使用网页旧的缓存位置。
    const getWatch = this.db.query<{ last_time: number | null }, [string, string]>(
      'SELECT last_time FROM wechat_watch WHERE account = ? AND chat = ?',
    );
    const link = this.link;
    const watched = new Map<string, number | null>();
    const targets = chats.map(({ chat, since }) => {
      //M 记录本批读取时的监听位置，落库前再确认开关是否变化。
      const watch = getWatch.get(account, chat);
      if (link !== undefined && watch !== null) {
        watched.set(chat, watch.last_time);
        return { chat, since: watch.last_time };
      }
      return { chat, since };
    });

    //M 由引擎按账号有序读取，不同时改写解密副本。
    const results = await this.reader.syncBatch(account, targets);
    const rows = new Map(results.map((item) => [item.chat, item]));
    let missed = false;
    const write = this.db.transaction(() => {
      for (const chat of chats) {
        const result = rows.get(chat.chat);
        if (result === undefined || result.missing || result.error !== undefined) {
          missed = true;
          continue;
        }

        //G 读取期间取消或重设监听的批次仅归档，不推进后来设置的监听位置。
        const current = getWatch.get(account, chat.chat);
        const before = watched.get(chat.chat);
        const sameWatch = current !== null && before === current.last_time;
        const group = result.is_group === true;
        const include = sameWatch && before !== null && !SKIP_REPLY.test(chat.chat);
        const name = result.chat_display || chat.name;

        //M 首轮只归档。后续新增的对方私聊或群内 @ 消息与缓存一起入库，防止中途退出漏交。
        let last = before ?? chat.since ?? 0;
        if (before === null) {
          last = 0;
        }
        const messages = result.messages ?? [];
        if (messages.length === 0) {
          last = Math.max(last, chat.at);
        }
        for (const message of messages) {
          const added = this.store.save(account, chat.chat, message);
          last = Math.max(last, message.create_time);
          if (!include || !added || link === undefined || message.from_self !== false) continue;
          if (group && !message.at_me) continue;

          link.enqueue(account, chat.chat, name, group, message);
        }
        if (sameWatch) {
          //M 入队后再推进监听位置，失败时一并回滚。
          const updateWatch = 'UPDATE wechat_watch SET last_time = ? WHERE account = ? AND chat = ?';
          const update = this.db.query(updateWatch);
          update.run(last, account, chat.chat);
        }
        const isGroup = Number(group);
        const sql = 'INSERT INTO wechat_sync (account,chat,name,is_group,last_time) VALUES (?,?,?,?,?)'
          + ' ON CONFLICT (account,chat) DO UPDATE SET name=excluded.name,is_group=excluded.is_group,'
          + ' last_time=MAX(wechat_sync.last_time,excluded.last_time)';

        //M 新旧批次可能交错抵达，同步位置只向前移。
        const update = this.db.query(sql);
        update.run(account, chat.chat, name, isGroup, last);
      }
    });

    //M 成功落库后才更新状态，避免失败时页面显示同步完成。
    write();
    if (missed) throw new historyModule.HistoryError('sync_error', '部分微信会话读取失败，读取位置已保留');
  }
}
