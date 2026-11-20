/** 通过只读引擎按账号和会话向前补录独立微信的缓存。补录只归档。 */
import type * as sqlite from 'bun:sqlite';
import type * as readerModule from './read/PureReader.ts';
import type * as storeModule from './read/Store.ts';

/** 只读引擎 backfill 每批支持的最大条数。 */
const LIMIT = 500;

/** 历史没有成功读取时的结构化原因，不包含聊天内容或解密路径。 */
export class HistoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** 网页、后台和回调共享历史补录任务及归档进度。 */
export class HistoryCache {
  /** 同一账号、会话同时最多运行一个补录批次。 */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly db: sqlite.Database,
    private readonly reader: readerModule.Reader,
    private readonly store: storeModule.Store,
  ) {
    //M 历史游标独立于增量位置，零散缓存不会被误认为中间都已读完。
    db.exec('CREATE TABLE IF NOT EXISTS wechat_history_scan'
      + ' (account TEXT, chat TEXT, until_time INTEGER, PRIMARY KEY (account, chat))');
  }

  /** 只在引擎确认取完时认为当前会话的往前历史已齐。 */
  isComplete(account: string, chat: string): boolean {
    //M 查已经确认过的补录进度，避免调用已无更早消息的引擎。
    const sql = 'SELECT full FROM wechat_sync WHERE account = ? AND chat = ?';
    const query = this.db.query<{ full: number | null }, [string, string]>(sql);
    const row = query.get(account, chat);
    return row?.full === 1;
  }

  /** 继续补这一会话的一批旧历史，重叠请求等待同一批。 */
  async fill(account: string, chat: string): Promise<void> {
    //G 已确认读完的会话不用再安排补录。
    if (this.isComplete(account, chat)) return;

    const key = JSON.stringify([account, chat]);

    //M 合并网页、轮询和历史回调发现的同一补录需要。
    const current = this.pending.get(key);
    if (current !== undefined) return current;

    const work = this.readBatch(account, chat);
    this.pending.set(key, work);
    try {
      await work;
    } finally {
      this.pending.delete(key);
    }
  }

  /** 当前补录结束后才能关闭独立数据库。 */
  async drain(): Promise<void> {
    //M 已失败的补录也算收尾完成，由发起方负责显示失败原因。
    await Promise.allSettled(this.pending.values());
  }

  /** 向前取一批并与游标一起落库，确认结束才写 full。 */
  private async readBatch(account: string, chat: string): Promise<void> {
    //G 账号必须来自引擎公布的已连接列表，避免把任意值用作引擎参数。
    const accounts = this.reader.accounts();
    if (!accounts.some((entry) => entry.id === account)) {
      throw new HistoryError('account_unavailable', '微信账号尚未连接');
    }

    //M 继续上次连续扫描位置，首次从本地最新消息所在秒开始，覆盖已知缓存间的空档。
    const scanSql = 'SELECT until_time FROM wechat_history_scan WHERE account = ? AND chat = ?';
    const scan = this.db.query<{ until_time: number }, [string, string]>(scanSql).get(account, chat);
    let until = scan?.until_time;
    if (until === undefined) {
      const newestSql = 'SELECT MAX(at) AS at FROM wechat_messages WHERE account = ? AND chat = ?';
      const newest = this.db.query<{ at: number | null }, [string, string]>(newestSql).get(account, chat);
      const last = newest?.at ?? Math.floor(Date.now() / 1000);
      until = last + 1;
    }

    //G 有监听的会话只补到已经同步过的时间，避免先归档后漏掉本应提交的新消息。
    const watchSql = 'SELECT last_time FROM wechat_watch WHERE account = ? AND chat = ?';
    const watchQuery = this.db.query<{ last_time: number | null }, [string, string]>(watchSql);
    const watch = watchQuery.get(account, chat);
    if (watch?.last_time === null) throw new HistoryError('history_incomplete', '等待监听会话的首轮同步');

    if (watch !== null) {
      until = Math.min(until, watch.last_time + 1);
    }

    //M 引擎按给定秒的严格之前查，重叠最老一秒可接住同一秒剩余的记录。
    let result: readerModule.SyncResult;
    try {
      result = await this.reader.backfill(account, chat, until, LIMIT);
    } catch {
      throw new HistoryError('history_error', '微信引擎读取旧消息失败，稍后可重试');
    }

    //G 读不到会话或读出错误不是空历史，保留可重试的位置。
    if (result.chat !== chat || result.error !== undefined) {
      throw new HistoryError('history_error', '微信引擎未能读取指定会话的历史');
    }
    if (result.missing) throw new HistoryError('chat_not_found', '微信引擎找不到此会话');

    //G 补录期间开启监听时，尚未经过监听同步的消息留给下一次增量读取。
    const current = watchQuery.get(account, chat);
    if (current !== null && (current.last_time === null || until > current.last_time + 1)) {
      throw new HistoryError('history_incomplete', '监听范围发生变化，历史稍后继续补录');
    }

    const messages = result.messages ?? [];
    let oldest = until;
    for (const message of messages) {
      //G 引擎返回超出本次范围的消息时不写入，也不推进历史游标。
      if (!Number.isSafeInteger(message.create_time) || message.create_time < 0 || message.create_time >= until) {
        throw new HistoryError('history_error', '微信引擎返回的历史时间超出查询范围');
      }
      oldest = Math.min(oldest, message.create_time);
    }
    const complete = messages.length < LIMIT;
    const next = oldest + 1;
    const tooDense = !complete && next >= until;

    //M 旧消息只走 Store 落库，入站队列和监听位置都不在此更新。
    const write = this.db.transaction(() => {
      for (const message of messages) {
        this.store.save(account, chat, message);
      }
      const progressSql = 'INSERT INTO wechat_sync (account,chat,name,is_group,last_time,full) VALUES (?,?,?,?,0,?)'
        + ' ON CONFLICT (account,chat) DO UPDATE SET full=excluded.full';
      const isGroup = Number(result.is_group === true);
      const full = Number(complete);
      const name = result.chat_display || chat;

      //M 与历史同一事务写入结束标记，不碰监听的增量位置。
      const save = this.db.query(progressSql);
      save.run(account, chat, name, isGroup, full);
      if (!complete && !tooDense) {
        const sql = 'INSERT INTO wechat_history_scan (account,chat,until_time) VALUES (?,?,?)'
          + ' ON CONFLICT (account,chat) DO UPDATE SET until_time=excluded.until_time';
        this.db.query(sql).run(account, chat, next);
      }
    });
    write();

    if (tooDense) throw new HistoryError('history_incomplete', '同一秒的消息达到引擎分页上限，无法确认完整历史');
  }
}
