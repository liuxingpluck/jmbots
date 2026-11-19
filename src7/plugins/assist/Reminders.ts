/** 保存本轮聊天的提醒，管理到点发送和重启后的补发。 */
import * as piAi from '@earendil-works/pi-ai';
import type * as sqlite from 'bun:sqlite';
import type * as cordis from 'cordis';
import type { SourceSnapshot } from '../../Channels.ts';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as events from '../../utils/RequestEvent.ts';
import type { Pending } from '../approval/index.ts';
import * as outbound from '../approval/Outbound.ts';
import type { ProviderReceipt } from '../programs/ChannelSend.ts';
import * as reminderTime from './ReminderTime.ts';

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TEXT = 2000;
const UNCERTAIN = '发送结果待核对，未自动重发';
const CARD_UNCERTAIN = '确认卡登记结果不确定';
const LIST_ORDER = " ORDER BY state NOT IN ('awaiting', 'pending'),"
  + " CASE WHEN state IN ('awaiting', 'pending') THEN due_at ELSE -id END LIMIT 100";

/** 提醒的持久行只记录当前机器人、明确的渠道目标和预定内容。 */
interface Row {
  id: number;
  bot: string;
  channel: string;
  account: string;
  chat: string;
  sender: string;
  due_at: number;
  local_at: string;
  time_zone: string;
  text: string;
  session_id: string;
  confirmed: number;
  send_text: string | null;
  state: 'awaiting' | 'pending' | 'sending' | 'cancelled' | 'rejected' | ProviderReceipt['status'];
  reason: string | null;
}

/** 只把已占位提醒的原目标交给发送入口。 */
export interface Delivery {
  /** 原提醒的持久编号。 */
  id: number;
  /** 原来源渠道。 */
  channel: string;
  /** 原来源账号。 */
  account: string;
  /** 原群或私聊 ID。 */
  chat: string;
  /** 提醒内容，错过时间时带补发说明。 */
  text: string;
}

declare module 'cordis' {
  interface Events {
    /**
     * 审批在发件前按编号读取 assist 已占位的提醒。
     * 谁发：src7/plugins/approval/Outbound.ts 的 Outbound.sendReminder
     * 谁接：src7/plugins/assist/Reminders.ts 的 Reminders.start
     */
    'assist/reminder-read'(request: events.RequestEnvelope & { reminderId: number }): void | Promise<void>;
    /**
     * 冻结原目标、原正文和创建时的确认结论。
     * 谁发：src7/plugins/assist/Reminders.ts 的 Reminders.start
     * 谁接：src7/plugins/approval/Outbound.ts 的 Outbound.sendReminder
     */
    'assist/reminder-row'(result: events.ResultEnvelope & {
      row?: Readonly<Delivery & { bot: string; confirmed: boolean }>;
    }): void;
  }
}

/** 生产用系统钟，测试换成推进时间就能触发的假时钟。 */
export interface Clock {
  /** 当前 UTC 毫秒。 */
  now(): number;
  /** 安排一次唤醒并返回取消函数。 */
  wait(delay: number, callback: () => void): () => void;
}

const systemClock: Clock = {
  now: Date.now,
  wait: (delay, callback) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

/** 读机器人本轮的不可变来话地址，只接受接入提醒的原聊天。 */
function getSource(session: Session): SourceSnapshot | undefined {
  const snapshot = session.row.activeSourceSnapshot ?? session.row.frontTask?.sourceSnapshot;
  if (snapshot?.channel === 'http' && snapshot.accountId === 'local' && snapshot.chatId === 'http:本机'
    && snapshot.role === 'owner' && snapshot.origin.address['verifiedOwner'] === true) return snapshot;

  if (snapshot?.channel !== 'feishu' || snapshot.accountId === '' || snapshot.chatId === ''
    || snapshot.senderId === '' || (snapshot.chatType !== 'group' && snapshot.chatType !== 'p2p')) {
    return undefined;
  }
  return snapshot;
}

/** 交回前后端使用的展示字段，隐藏去重键和发送者。 */
function getView(row: Row) {
  return {
    id: row.id,
    at: row.local_at,
    timeZone: row.time_zone,
    text: row.text,
    state: row.state,
    reason: row.reason,
  };
}

/** assist 的提醒仓库和调度器，共用 resources 的 SQLite。 */
export class Reminders {
  private readonly time: reminderTime.ReminderTime;
  private readonly db: sqlite.Database;
  private stopWait?: () => void;
  private send?: (message: Delivery) => Promise<ProviderReceipt>;
  private startedAt = 0;
  private draining = false;
  private registered = false;
  private readonly issuing = new Set<number>();

  /** 建表并留待发送入口接通。 */
  constructor(
    private readonly ctx: cordis.Context,
    config: unknown,
    private readonly clock: Clock = systemClock,
  ) {
    //M 解析和显示都用同一份时区配置，模型给出的分钟才能对应到调度时刻。
    this.time = new reminderTime.ReminderTime(config);
    this.db = ctx.resources.db;

    //M 时间、目标和调用去重键一起保存，重启后可以继续处理待发提醒。
    this.db.exec(`CREATE TABLE IF NOT EXISTS assist_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot TEXT NOT NULL, channel TEXT NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL,
      sender TEXT NOT NULL, round_key TEXT NOT NULL, call_key TEXT NOT NULL,
      due_at INTEGER NOT NULL, local_at TEXT NOT NULL, time_zone TEXT NOT NULL, text TEXT NOT NULL,
      session_id TEXT NOT NULL, confirmed INTEGER NOT NULL, late INTEGER NOT NULL DEFAULT 0, send_text TEXT,
      state TEXT NOT NULL, reason TEXT,
      UNIQUE (bot, round_key, call_key)
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS assist_reminders_due ON assist_reminders (state, due_at, id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS assist_reminders_chat ON assist_reminders (bot, channel, account, chat)');
  }

  /** 给可设置提醒的模型说明本轮采用的日历时间。 */
  hint(request: ChatRequest): void {
    if (this.send === undefined) return;

    //G 可信来源才有权限定提醒，也才需要在这轮请求里提示当前时间。
    const source = getSource(request.session);
    if (source === undefined) return;

    //M 以当前时间和配置时区生成日期提示。
    const now = this.clock.now();
    const local = this.time.format(now);
    const weekdayFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: this.time.zone, weekday: 'long' });
    const weekday = weekdayFormat.format(now);
    const hint = `提醒按 ${this.time.zone} 计算，现在是 ${local} ${weekday}。`
      + `把「周六早上」等相对说法换算成当地日期；只给日期就用 ${this.time.morning}。`
      + '用户明确要到点提醒时调用 remind_add，提醒时间和被提醒的事项时间分开。'
      + '结果是 awaiting 时告诉对方要等本人确认。';

    //M 用配置时区提供当轮日期，避免按服务器的自然日换算。
    request.system.push(hint);
  }

  /** 启动时交回在途提醒取发件回执，再继续调度待发提醒。 */
  start(send: (message: Delivery) => Promise<ProviderReceipt>): void {
    if (this.send !== undefined) return;

    this.startedAt = this.clock.now();
    this.send = send;
    if (!this.registered) {
      //M 发送入口就绪才让模型登记提醒，目标仍由会话来源决定。
      this.registerTools();
      this.ctx.on('approval/decided', (pending) => this.onDecision(pending));
      //M 仅发送方可以从已占位的行得到冻结的目标和正文。
      const read = (request: events.EventArg<'assist/reminder-read'>) => this.getDelivery(request.reminderId);
      events.onRequestEvent(this.ctx, 'assist/reminder-read', 'assist/reminder-row', read);
      this.registered = true;
    }

    //M 审批状态先于事件写入，进程恢复时用持久卡片补齐可能遗漏的决定。
    const waiting = this.db.query<Row, []>("SELECT * FROM assist_reminders WHERE state = 'awaiting'").all();
    for (const reminder of waiting) {
      void this.ensureCard(reminder).catch(() => {
        this.ctx.emit('trace', 'Assist.reminders', '恢复提醒确认失败', 'Reminders.ensureCard', { id: reminder.id });
      });
    }
    //M 原有在途记录以同一编号和正文重新交给 Outbound，由发件账决定是否需要发送。
    const sql = "SELECT * FROM assist_reminders WHERE state = 'sending' ORDER BY due_at, id";
    const stuck = this.db.query<Row, []>(sql).all();
    if (stuck.length > 0) {
      void this.drain(stuck).catch(() => {
        this.ctx.emit('trace', 'Assist.reminders', '恢复在途提醒失败', 'Reminders.drain', {});
      });
      return;
    }

    //M 按排期处理待发记录。
    this.arm();
  }

  /** 插件卸载时关闭唤醒，保留 SQLite 中的任务及在途记录。 */
  stop(): void {
    this.send = undefined;
    this.stopWait?.();
    this.stopWait = undefined;
  }

  /** 给已核验网页按机器人展示各聊天下的提醒。 */
  listForBot(bot: string) {
    const sql = 'SELECT * FROM assist_reminders WHERE bot = ?' + LIST_ORDER;
    //M 网页按机器人读取全部聊天的提醒，统一转换为界面记录。
    const rows = this.db.query<Row, [string]>(sql).all(bot);
    return rows.map(getView);
  }

  /** 声明工具参数及作用范围，供现有 Tools 关口校验和执行。 */
  private registerTools(): void {
    const sessionKinds = ['front', 'work'];
    const strict = { additionalProperties: false };
    //M 登记新增提醒的工具，目标从当前会话取。
    this.ctx.tools.register({
      sessionKinds,
      definition: {
        name: 'remind_add',
        description: '在本轮飞书群、飞书私聊或已核验网页聊天定一条纯文字提醒，到点发回这里。',
        parameters: piAi.Type.Object({
          at: piAi.Type.String({ description: '配置时区的 YYYY-MM-DD HH:mm；只有早上日期时可写 YYYY-MM-DD' }),
          text: piAi.Type.String({ minLength: 1, maxLength: MAX_TEXT, description: '到点要发的提醒正文' }),
        }, strict),
      },
      run: async (args, session, signal, callId) => {
        if (signal.aborted) throw new Error('设置提醒已取消');

        const at = args['at'] as string;
        const text = args['text'] as string;
        //M 用会话与调用号保存提醒，同一次调用重放仍使用原记录。
        const saved = this.add(session, at, text, callId);
        if (saved.state === 'awaiting') {
          //M 群聊或外人创建只登记请求，由本人现在确认一次。
          await this.ensureCard(saved);
        }
        //M 确认流程可能已经改过记录，读取最新状态后再回给模型。
        const current = this.getById(saved.id);
        return JSON.stringify(getView(current));
      },
    });

    //M 登记查询工具，按本轮聊天和说话人限制范围。
    this.ctx.tools.register({
      sessionKinds,
      definition: {
        name: 'remind_list',
        description: '列本轮聊天的提醒及发送状态。访客只能查看自己设置的提醒。',
        parameters: piAi.Type.Object({}, strict),
      },
      run: (_args, session) => {
        //G 查询前先得到可信聊天来源，避免按模型任意指定的目标查询。
        const source = getSource(session);
        if (source === undefined) throw new Error('提醒需要本轮可信聊天来源');

        //M 本人能查同聊，其他说话人只查自己创建的提醒。
        const scope = this.getScope(session, source);
        const sql = 'SELECT * FROM assist_reminders WHERE bot = ? AND channel = ? AND account = ? AND chat = ?'
          + ' AND (? = 1 OR sender = ?)' + LIST_ORDER;
        const rows = this.db.query<Row, sqlite.SQLQueryBindings[]>(sql).all(...scope);
        const reminders = rows.map(getView);
        return JSON.stringify(reminders);
      },
    });

    //M 登记取消工具，它只能更改尚未发送且属于当前来源的提醒。
    this.ctx.tools.register({
      sessionKinds,
      definition: {
        name: 'remind_cancel',
        description: '按编号取消本轮聊天里尚未发送的提醒。访客只能取消自己设置的提醒。',
        parameters: piAi.Type.Object({ id: piAi.Type.Integer({ minimum: 1, description: '提醒编号' }) }, strict),
      },
      run: async (args, session) => {
        //G 取消前先取得可信聊天来源，避免影响其它聊天。
        const source = getSource(session);
        if (source === undefined) throw new Error('提醒需要本轮可信聊天来源');

        const id = args['id'] as number;
        //M 更新条件同时限定聊天、创建人权限和还可取消的状态。
        const scope = this.getScope(session, source);
        const sql = "UPDATE assist_reminders SET state = 'cancelled', reason = NULL WHERE id = ?"
          + " AND state IN ('pending', 'awaiting')"
          + ' AND bot = ? AND channel = ? AND account = ? AND chat = ? AND (? = 1 OR sender = ?)';
        const changed = this.db.query(sql).run(id, ...scope);
        if (changed.changes === 0) return '当前聊天里没有可取消的这条提醒';

        //M 已取消的队首立即从计时表移开，下一条补位。
        this.arm();
        const row = this.getById(id);
        if (row.confirmed === 1) return '已取消该提醒';

        //M 作废卡片失败时仍交回已经保存的取消结果。
        const card = await this.getCard(row).catch(() => undefined);
        if (card?.state === 'waiting') {
          const uncertainty = await this.closeCard(card.id);
          if (uncertainty !== undefined) return `已取消该提醒，${uncertainty}`;
        }
        return '已取消该提醒';
      },
    });
  }

  /** 请审批服务读取它持久保存的提醒卡。 */
  private async getCard(row: Row): Promise<Pending | undefined> {
    const payload = { action: 'reminder-card' as const, reminderId: row.id, bot: row.bot };
    const options = { timeoutMs: 5000, onFallback: () => ({ requestId: '', error: '确认卡读取暂不可用' }) };
    //M 先读持久审批卡，重放时可沿用已经确认的结果。
    const result = await events.requestEvent(this.ctx, 'approval/request', 'approval/result', payload, options);
    if (result.error !== undefined) throw new Error(result.error);

    return result.pending;
  }

  /** 读已存在的提醒，返回最新状态给同一次工具调用。 */
  private getById(id: number): Row {
    const sql = 'SELECT * FROM assist_reminders WHERE id = ?';
    //M 等审批后照编号重读，调用方拿到的是当前状态。
    return this.db.query<Row, [number]>(sql).get(id)!;
  }

  /** 建一次确认卡，恢复或重放时沿用先前的持久审批。 */
  private async ensureCard(row: Row): Promise<void> {
    //G 同一个提醒只允许一段确认流程在途，防止并发发出两张卡。
    if (this.issuing.has(row.id)) return;

    //M 占住提醒编号，等确认流程完成再释放。
    this.issuing.add(row.id);
    try {
      //M 先找已经建好的卡片，等待期间取消或停用时直接退出。
      const existing = await this.getCard(row);
      if (this.send === undefined || this.getById(row.id).state !== 'awaiting') return;

      if (existing !== undefined) {
        //M 已有卡片时复用它的决定，恢复时也不重复发卡。
        this.applyDecision(row.id, row.bot, existing.state);
        return;
      }
      //G 已发出但超时时只核对原卡，避免再次登记。
      if (this.getById(row.id).reason === CARD_UNCERTAIN) return;

      const payload = { reminderId: row.id };
      const input = {
        kind: outbound.REMINDER_APPROVAL_KIND,
        title: `确认定时提醒 #${row.id}`,
        detail: `发回飞书聊天 ${row.chat}\n原定 ${row.local_at} ${row.time_zone}\n${row.text}\n错过原定时刻时会注明时间并补发。`,
        payload, bot: row.bot, session: row.session_id,
      };
      const request = { action: 'ask' as const, input };
      const onFallback = () => ({ requestId: '', error: '确认卡登记暂不可用' });
      const options = { timeoutMs: 5000, onFallback };
      //M 复用本人审批卡，不因到点再次询问。
      const reply = await events.requestEvent(this.ctx, 'approval/request', 'approval/result', request, options);
      if (this.send === undefined) return;

      const card = reply.pending;
      //M 请求卡片期间可能已有取消操作，按最新状态决定是否作废卡片。
      const current = this.getById(row.id);
      //G 登记结果不确定时沿用持久待核对原因，下次核对原卡。
      if (events.isUnsure(reply)) throw new Error(CARD_UNCERTAIN);

      if (card === undefined) throw new Error(reply.error ?? '确认卡登记暂不可用');

      if (current.state === 'cancelled') {
        //M 提醒已取消，关闭新建的卡片以免用户继续确认。
        await this.closeCard(card.id);
        return;
      }
      const sql = "UPDATE assist_reminders SET reason = NULL WHERE id = ? AND state = 'awaiting'";
      //M 确认卡已登记，清除先前的临时失败原因。
      this.db.query(sql).run(row.id);
    } catch (error) {
      if (this.send === undefined) return;

      //G 一次查询故障不能清掉尚未核对的登记状态。
      if (this.getById(row.id).reason === CARD_UNCERTAIN) return;

      let reason = '确认卡处理暂不可用';
      if (error instanceof Error) {
        reason = error.message;
      }
      const sql = "UPDATE assist_reminders SET reason = ? WHERE id = ? AND state = 'awaiting'";
      //M 暂时建卡失败时保留原因，让等待确认的记录可查。
      this.db.query(sql).run(reason, row.id);
    } finally {
      this.issuing.delete(row.id);
    }
  }

  /** 取消提醒时作废待表决卡片。回执结果不确定时提示核对。 */
  private async closeCard(id: number): Promise<string | undefined> {
    const request = { action: 'close' as const, id, note: '提醒已取消' };
    const uncertain = '确认卡作废结果不确定';
    const onFallback = () => ({ requestId: '' });
    const options = { timeoutMs: 5000, onFallback };

    //M 已保存的取消状态继续有效，卡片结果单独记录。
    const result = await events.requestEvent(this.ctx, 'approval/request', 'approval/result', request, options);
    if (!events.isUnsure(result)) return undefined;

    const vars = { 卡片: id };
    this.ctx.emit('trace', 'Reminders.closeCard', uncertain, 'approval/request close', vars);
    return uncertain;
  }

  /** 只消费本插件发起的确认；确认及拒绝都落入提醒列表。 */
  private onDecision(pending: Pending): void {
    if (this.send === undefined || pending.kind !== outbound.REMINDER_APPROVAL_KIND) return;

    const payload = pending.payload as { reminderId?: number } | null;
    const id = payload?.reminderId;
    if (id === undefined || !Number.isSafeInteger(id)) return;

    //M 审批服务只在已持久化决定后广播；取消等终态由更新条件保护。
    this.applyDecision(id, pending.bot, pending.state);
  }

  /** 已批准的提醒加入队列，过了约定时刻就带补发说明。 */
  private applyDecision(id: number, bot: string, state: Pending['state']): void {
    if (state === 'waiting') return;

    let next = 'rejected';
    if (state === 'approved') {
      next = 'pending';
    }
    const now = this.clock.now();
    const confirmed = Number(state === 'approved');
    const sql = "UPDATE assist_reminders SET state = ?, reason = NULL, confirmed = ?, late = (due_at < ?)"
      + " WHERE id = ? AND bot = ? AND state = 'awaiting'";
    //M 只更新仍待确认的记录，再按新的待发队列重新设钟。
    this.db.query(sql).run(next, confirmed, now, id, bot);
    this.arm();
  }

  /** 共享列表和取消的范围，本人可管理同聊，外人还要对上创建者。 */
  private getScope(session: Session, source: SourceSnapshot): sqlite.SQLQueryBindings[] {
    const owner = Number(source.role === 'owner');
    return [session.row.bot, source.channel, source.accountId, source.chatId, owner, source.senderId];
  }

  /** 同一轮同一工具调用重放时沿用原记录。 */
  private add(session: Session, at: string, text: string, callId: string): Row {
    //G 建立提醒只能绑定当前可信来源。
    const source = getSource(session);
    if (source === undefined) throw new Error('提醒需要本轮可信聊天来源');

    const bot = session.row.bot;
    const round = source.replyRoundKey;
    const content = text.trim();
    if (content === '') throw new Error('提醒正文不能为空');

    //M 先把本地时刻换成 UTC 毫秒，再留一份本地显示值供核对。
    const due = this.time.parse(at);
    const local = this.time.format(due);
    const save = this.db.transaction(() => {
      const lookup = 'SELECT * FROM assist_reminders WHERE bot = ? AND round_key = ? AND call_key = ?';
      //G 原调用重放沿用已存提醒，时间或正文变化则拒绝。
      const existing = this.db.query<Row, [string, string, string]>(lookup).get(bot, round, callId);
      if (existing !== null) {
        if (existing.due_at !== due || existing.text !== content) throw new Error('同次调用的提醒内容已变化');

        return existing;
      }

      const now = this.clock.now();
      if (due <= now) throw new Error('提醒时间要晚于当前时间');

      const ownPrivate = source.role === 'owner' && source.chatType === 'p2p';
      const ownerConfirmed = Number(ownPrivate || source.channel === 'http');
      let state = 'awaiting';
      if (ownerConfirmed === 1) {
        state = 'pending';
      }
      const sql = 'INSERT INTO assist_reminders (bot, channel, account, chat, sender, round_key, call_key,'
        + ' due_at, local_at, time_zone, text, session_id, confirmed, state)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *';
      //M 把提醒正文与本轮的账号、聊天和创建者原子写入。
      return this.db.query<Row, sqlite.SQLQueryBindings[]>(sql).get(
        bot, source.channel, source.accountId, source.chatId, source.senderId, round, callId,
        due, local, this.time.zone, content, session.row.id, ownerConfirmed, state,
      )!;
    });

    //M 原子登记后再计算最近到期时刻，调用重放不会多记一条。
    const reminder = save.immediate();
    this.arm();
    return reminder;
  }

  /** 给审批发件入口交回当前已确认的冻结记录。 */
  private getDelivery(id: number) {
    const sql = "SELECT * FROM assist_reminders WHERE id = ? AND state = 'sending' AND due_at <= ?";
    const now = this.clock.now();
    //G 只有已被占位且到期的提醒才能取到冻结的发送内容。
    const row = this.db.query<Row, [number, number]>(sql).get(id, now);
    if (row?.send_text == null) return {};

    const delivery = Object.freeze({
      id: row.id, bot: row.bot, channel: row.channel, account: row.account, chat: row.chat, text: row.send_text,
      confirmed: row.confirmed === 1,
    });
    return { row: delivery };
  }

  /** 只为最早一条待发记录等待，超过计时器上限时到时再计算。 */
  private arm(): void {
    if (this.send === undefined || this.draining) return;

    this.stopWait?.();
    this.stopWait = undefined;
    //M 只查最早的一条待发送记录，计时器到期再读最新队列。
    const row = this.db.query<{ due_at: number }, []>(
      "SELECT due_at FROM assist_reminders WHERE state = 'pending' ORDER BY due_at, id LIMIT 1",
    ).get();
    if (row === null) return;

    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, row.due_at - this.clock.now()));
    //M 到点后以数据库中的最新状态为准，取消与发送的占位互斥。
    this.stopWait = this.clock.wait(delay, () => {
      this.stopWait = undefined;
      void this.drain().catch(() => {
        this.ctx.emit('trace', 'Assist.reminders', '调度提醒失败', 'Reminders.drain', {});
      });
    });
  }

  /** 顺序占位并记录渠道回执，启动前错过的提醒前缀标明补发。 */
  private async drain(stuck: Row[] = []): Promise<void> {
    if (this.draining) return;

    this.draining = true;
    try {
      //M 先补齐上次没有保存的回执，再为新到期的提醒占位。
      for (const row of stuck) {
        await this.deliver(row);
      }
      while (this.send !== undefined) {
        const now = this.clock.now();
        const sql = "UPDATE assist_reminders SET state = 'sending', send_text = CASE WHEN due_at < ? OR late = 1"
          + " THEN '补发提醒（原定 ' || local_at || ' ' || time_zone || '）：' || text ELSE '提醒：' || text END"
          + " WHERE id = (SELECT id FROM assist_reminders WHERE state = 'pending' AND due_at <= ?"
          + ' ORDER BY due_at, id LIMIT 1) RETURNING *';
        //M 原子占位最早的到期提醒并冻结正文，避免取消与发送交叉。
        const row = this.db.query<Row, [number, number]>(sql).get(this.startedAt, now);
        if (row === null) return;

        //M 新占位与重启恢复共用冻结的正文和发送编号。
        await this.deliver(row);
      }
    } finally {
      this.draining = false;
      //M 本轮占位结束后重新等待下一条到期记录。
      this.arm();
    }
  }

  /** 提交已占位的提醒，把发件账回执记回该行。 */
  private async deliver(row: Row): Promise<void> {
    const send = this.send;
    if (send === undefined) return;

    const message = {
      id: row.id,
      channel: row.channel,
      account: row.account,
      chat: row.chat,
      text: row.send_text!,
    };
    let receipt: ProviderReceipt = { status: 'uncertain', reason: UNCERTAIN };
    try {
      //M 以原编号提交同一提醒，重复交接由发件账去重。
      receipt = await send(message);
    } catch {
      //G 运输异常可能发生在收到消息后，保留结果待核。
    }
    if (this.send !== send) return;

    //M 仅更新仍在途的记录，展示发件账实际回执。
    const update = "UPDATE assist_reminders SET state = ?, reason = ? WHERE id = ? AND state = 'sending'";
    this.db.query(update).run(receipt.status, receipt.reason ?? null, row.id);
  }
}
