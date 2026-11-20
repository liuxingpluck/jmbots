/** 只执行主程序明确批准的微信发送请求，在调用发送器前持久化一次性请求号（零跨目录 `src7/` 或 Python 依赖）。 */
import * as crypto from 'node:crypto';
import type * as sqlite from 'bun:sqlite';
import type * as fastify from 'fastify';
import * as protocol from './Protocol.ts';
import type * as readerModule from './read/PureReader.ts';


/** 只有宿主可以调用的明确批准发送入口。 */
export const SEND_ROUTE = '/jmbots/v1/channel/send';

/** 可注入的窗口发送器抽象接口。 */
export interface ExternalSender {
  /** 执行一次已核准发送并返回是否已回读确认。 */
  send(
    target: { account: string; chat: string; name: string; nickname: string },
    text: string,
    workerId: string,
  ): Promise<Record<string, unknown>>;
  /** 关闭发送器资源。 */
  close(): void;
}

/** 通过入口校验、由宿主绑定到本人批准结果的一份发件。 */
interface ApprovedCall {
  /** 同一份发送重试时沿用。 */
  requestId: string;
  /** 批准号，一次只对应一份发件。 */
  approvalId: string;
  /** 批准失效时间，Unix 毫秒。 */
  expiresAt: number;
  /** 微信账号，必须明确。 */
  account: string;
  /** 微信会话号，必须明确。 */
  chat: string;
  /** 严格按已批准的正文发送。 */
  text: string;
}

/** 交给宿主的可持久化结果。 */
interface Receipt {
  /** 只有回读确认才是 sent。 */
  status: 'sent' | 'failed' | 'uncertain';
  /** 失败或不确定时只给简短原因。 */
  reason?: string;
}

/** 发件表为同一请求保留原始批准和最新状态。 */
interface SavedSend {
  /** 用来拒绝换批准号的重试。 */
  approval_id: string;
  /** 用来拒绝延长批准时限的重试。 */
  expires_at: number;
  /** 用来拒绝改账号的重试。 */
  account: string;
  /** 用来拒绝改会话的重试。 */
  chat: string;
  /** 用来拒绝改正文的重试。 */
  text: string;
  /** sending 表示占过一次发送机会，进程重启后结果不确定。 */
  state: Receipt['status'] | 'sending';
  /** 终态的说明。 */
  note: string;
}


/** 读取经宿主批准的请求，缺少准确目标或批准时拒绝。 */
function getApprovedCall(body: Record<string, unknown>): ApprovedCall | undefined {
  const requestId = body['requestId'];
  const account = body['account'];
  const chat = body['chat'];
  const text = body['text'];
  const approval = body['approval'];

  //G 普通 reply、未批准和没有批准期限的请求都不能进入发件队列。
  if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) return undefined;

  const evidence = approval as Record<string, unknown>;
  const approvalId = evidence['id'];
  const expiresAt = evidence['expiresAt'];
  if (evidence['state'] !== 'approved') return undefined;
  if (typeof requestId !== 'string' || requestId.trim() === '') return undefined;
  if (typeof approvalId !== 'string' || approvalId.trim() === '') return undefined;
  if (typeof account !== 'string' || account.trim() === '') return undefined;
  if (typeof chat !== 'string' || chat.trim() === '') return undefined;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return undefined;

  return { requestId, approvalId, expiresAt, account, chat, text };
}


/** 将未能确认是否发出的记录交给人工核对。 */
const UNCONFIRMED: Receipt = { status: 'uncertain', reason: '微信发送结果待核对，不自动重发' };


/** 外置进程持久化发件、串行调发送器，并在退出时停接和排空。 */
export class ApprovedSend {
  /** 已占用一次性请求号、尚未完成的任务。 */
  private readonly active = new Map<string, Promise<Receipt>>();

  /** 发送在一个微信窗口上串行执行。 */
  private tail: Promise<void> = Promise.resolve();

  /** 关停后排队中的任务也不能开始发送。 */
  private stopping = false;

  /**
   * @param db 外置程序独立的微信数据库。
   * @param channel 宿主登记给该程序的渠道名。
   * @param reader 读取当前连接的微信账号。
   * @param sender 启用发送时提供的发送器，默认缺席（只存草稿）。
   */
  constructor(
    private readonly db: sqlite.Database,
    private readonly channel: string,
    private readonly reader: Pick<readerModule.Reader, 'accounts'>,
    private readonly sender?: ExternalSender,
  ) {
    //M 独立保存批准发件，保留现有草稿回执和历史数据的用途。
    db.exec('CREATE TABLE IF NOT EXISTS wechat_send_requests ('
      + 'channel TEXT NOT NULL, request_id TEXT NOT NULL, approval_id TEXT NOT NULL, expires_at INTEGER NOT NULL,'
      + 'account TEXT NOT NULL, chat TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL,'
      + 'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,'
      + 'PRIMARY KEY (channel, request_id), UNIQUE (channel, approval_id))');
  }

  /** 挂载批准入口；普通渠道回复仍由现有草稿接口处理。 */
  mount(app: fastify.FastifyInstance, key: string): void {
    //M 只接受本进程的宿主密钥，校验渠道和批准后才进入业务队列。
    app.post(SEND_ROUTE, (request, reply) => {
      const given = request.headers[protocol.KEY_HEADER];
      //G 密钥须来自当前启动程序的宿主。
      if (!protocol.isSameKey(key, given)) {
        return reply.code(401).send({ status: 'failed', reason: '主程序密钥不对' });
      }
      const body = request.body as Record<string, unknown> | null | undefined;
      if (body?.['channel'] !== this.channel) {
        return reply.code(403).send({ status: 'failed', reason: '渠道没有登记给本程序' });
      }

      //G 接口接受批准记录及明确的账号、会话和原文。
      const call = getApprovedCall(body);
      if (call === undefined) {
        return reply.code(400).send({ status: 'failed', reason: '发送需要准确目标、正文和已批准的请求' });
      }

      //M 已校验的请求进入一次性发件队列。
      return this.enqueue(call);
    });
  }

  /** 立即关发送闸门；已交给发送器的操作仍等回执。 */
  stop(): void {
    this.stopping = true;
  }

  /** 等队列写回结果后关闭发送器，调用者随后才能关库。 */
  async close(): Promise<void> {
    //M 调用者直接关闭时也先停接，再等待在途调用。
    this.stop();
    await this.tail;
    //M 释放可选发送器连接。
    this.sender?.close();
  }

  /** 先持久化再排队；同一请求只会调用一次发送器。 */
  private async enqueue(call: ApprovedCall): Promise<Receipt> {
    const sql = 'SELECT approval_id, expires_at, account, chat, text, state, note FROM wechat_send_requests'
      + ' WHERE channel = ? AND request_id = ?';
    //M 预编译请求号查询语句，供去重与并发抢占复核共用。
    const statement = this.db.query<SavedSend, [string, string]>(sql);
    const requestId = call.requestId;

    //M 允许旧请求获取原回执，即使现已关停或取消监听。
    let saved = statement.get(this.channel, requestId);
    if (saved !== null) return this.getReceipt(call, saved);
    if (this.stopping) return { status: 'failed', reason: '微信发送正在关停' };

    //M 用数据库的两种唯一键守住请求号和批准号，先占位再执行。
    const insert = 'INSERT OR IGNORE INTO wechat_send_requests'
      + ' (channel, request_id, approval_id, expires_at, account, chat, text, state, note, created_at, updated_at)'
      + " VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', '', ?, ?)";
    const at = Date.now();
    const args = [
      this.channel, requestId, call.approvalId, call.expiresAt, call.account, call.chat, call.text, at, at,
    ];
    const inserted = this.db.query(insert).run(...args);
    if (inserted.changes === 0) {
      //G 另一连接抢先占用了请求号或该批准号已有另一条发件。
      saved = statement.get(this.channel, requestId);
      if (saved !== null) return this.getReceipt(call, saved);

      return { status: 'failed', reason: '批准号已关联其他发送请求' };
    }

    //M 在上一条完成后复查授权状态与名单，再开始本次操作。
    const task = this.tail.then(() => this.deliver(call));
    this.active.set(requestId, task);
    this.tail = task.then(() => undefined);
    try {
      return await task;
    } finally {
      this.active.delete(requestId);
    }
  }

  /** 读取旧回执，验证重试与第一次请求完全一致。 */
  private async getReceipt(call: ApprovedCall, saved: SavedSend): Promise<Receipt> {
    const mismatched = saved.approval_id !== call.approvalId
      || saved.expires_at !== call.expiresAt
      || saved.account !== call.account
      || saved.chat !== call.chat
      || saved.text !== call.text;
    if (mismatched) {
      return { status: 'failed', reason: '发送请求的批准、目标或正文与原请求不同' };
    }
    if (saved.state === 'sent') return { status: 'sent' };
    if (saved.state !== 'sending') return { status: saved.state, reason: saved.note };

    //G 在本进程内等待已有操作；重启后没有该 Promise，直接交回不确定。
    return this.active.get(call.requestId) ?? UNCONFIRMED;
  }

  /** 顺序执行并保存回执；中断或写回失败都保守地视为不确定。 */
  private async deliver(call: ApprovedCall): Promise<Receipt> {
    let receipt: Receipt;
    try {
      //M 区分前置拒绝与已经交给发送器的情况。
      receipt = await this.trySend(call);
    } catch {
      receipt = { status: 'failed', reason: '无法读取当前微信发送条件' };
    }

    try {
      const sql = 'UPDATE wechat_send_requests SET state = ?, note = ?, updated_at = ?'
        + " WHERE channel = ? AND request_id = ? AND state = 'sending'";
      const at = Date.now();
      const note = receipt.reason ?? '';
      //M 将一次性 sending 占位原子更新为最终发送状态。
      const result = this.db.query(sql).run(receipt.status, note, at, this.channel, call.requestId);
      if (result.changes !== 1) return UNCONFIRMED;

      return receipt;
    } catch {
      return UNCONFIRMED;
    }
  }

  /** 进入发送器前读新鲜名单和有效期，之后只接受回读确认。 */
  private async trySend(call: ApprovedCall): Promise<Receipt> {
    const sender = this.sender;
    if (this.stopping) return { status: 'failed', reason: '微信发送正在关停' };
    if (sender === undefined) return { status: 'failed', reason: '本实例只存草稿' };
    if (call.expiresAt <= Date.now()) return { status: 'failed', reason: '发送批准已过期' };

    const sql = 'SELECT name FROM wechat_watch WHERE account = ? AND chat = ?';
    //M 排到执行前复查目标会话仍在当前监听名单。
    const watched = this.db.query<{ name: string }, [string, string]>(sql).get(call.account, call.chat);
    if (watched === null) return { status: 'failed', reason: '微信会话已不在监听名单' };

    //M 排到本条时复核账号仍处于已连接状态。
    const accounts = this.reader.accounts();
    const account = accounts.find((item) => item.id === call.account);
    if (account === undefined) return { status: 'failed', reason: '微信账号尚未连接' };

    const target = { account: call.account, chat: call.chat, name: watched.name, nickname: account.nickname };
    const identity = JSON.stringify([this.channel, call.requestId]);
    const hash = crypto.createHash('sha256').update(identity).digest('hex');
    const workerId = `jmbots-external-wechat-${hash}`;

    try {
      //M 委托外部 HTTP 发送桥执行一次发送并核对确认标志。
      const result = await sender.send(target, call.text, workerId);
      if (result['confirmed'] === true) return { status: 'sent' };
    } catch {
      return UNCONFIRMED;
    }

    return UNCONFIRMED;
  }
}


/**
 * 创建纯 HTTP 外置窗口发送桥（不携带或启动任何 Python OCR 子进程）。
 * @param _engine 兼容保留参数。
 * @param _ocrPython 兼容保留参数。
 * @param aobwUrl 可选 AOBW HTTP 服务地址。
 * @param _lockFile 兼容保留参数。
 */
export function createSender(
  _engine: string,
  _ocrPython?: string,
  aobwUrl?: string,
  _lockFile?: string,
): ExternalSender {
  const url = (aobwUrl ?? 'http://127.0.0.1:30010').replace(/\/+$/u, '');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--aobw-url 必须是 HTTP(S) 地址');
  }

  return {
    async send(target, text, workerId): Promise<Record<string, unknown>> {
      const response = await fetch(`${url}/wechat/send`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, text, workerId }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) return { confirmed: false };
      return await response.json() as Record<string, unknown>;
    },
    close(): void {
      // 纯 HTTP 发送桥无本地常驻子进程。
    },
  };
}
