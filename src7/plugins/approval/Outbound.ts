/** 本人的渠道发送确认，持久绑定原草稿或主动消息、批准及发送结果。 */
import * as crypto from 'node:crypto';
import type * as sqlite from 'bun:sqlite';
import type * as cordis from 'cordis';
import * as channels from '../channels/index.ts';
import * as events from '../../utils/RequestEvent.ts';
import type { FeishuAddress } from '../feishu/index.ts';
import type { ApprovedCall, ChannelSendResult, ProgramDraft, ProviderReceipt } from '../programs/ChannelSend.ts';

/** 待确认意图及批准各有十分钟期限。 */
const APPROVAL_MS = 600_000;
/** 外置草稿 HTTP 读取上限。 */
export const DRAFT_HTTP_WAIT_MS = 5000;
/** 内置渠道回执或外置发送 HTTP 请求的等待上限。 */
export const CHANNEL_WAIT_MS = 90_000;
/** 给 HTTP 回执或读取错误留出一秒转为事件回执。 */
const DRAFT_WAIT_MS = DRAFT_HTTP_WAIT_MS + 1000;
/** 外置发件经托管程序运输，事件回执比底层 HTTP 多等五秒。 */
const PROGRAM_WAIT_MS = CHANNEL_WAIT_MS + 5000;
/** 已冻结的定时提醒记录读取上限。 */
const REMINDER_READ_WAIT_MS = 1000;
/** 外层等待预留四秒供账本落盘及回执传递。 */
const RECEIPT_MARGIN_MS = 4000;
/** assist 等待提醒读记录、发件与记账的总上限。 */
export const REMINDER_WAIT_MS = REMINDER_READ_WAIT_MS + CHANNEL_WAIT_MS + RECEIPT_MARGIN_MS;
/** 确认入口等待重新读草稿、外置发件与记账的总上限。 */
const CONFIRM_WAIT_MS = DRAFT_WAIT_MS + PROGRAM_WAIT_MS + RECEIPT_MARGIN_MS;
/** 进程退出或传输中断后的在途请求只供本人核对。 */
const UNKNOWN: ProviderReceipt = { status: 'uncertain', reason: '发送结果待核对，不自动重发' };
/** 主站主动发件采用独立账本命名空间，和外置程序草稿隔离。 */
export const DIRECT_PROGRAM = '@channel';
/** 通过现有本人审批界面登记的定时提醒。 */
export const REMINDER_APPROVAL_KIND = 'assist-reminder';

/** 由可信入口提交的主动纯文本消息。 */
export interface ChannelSendMessage {
  /** 接收发送事件的渠道。 */
  channel: string;
  /** 精确的发送账号。 */
  account: string;
  /** 精确的聊天 ID。 */
  chat: string;
  /** 待本人确认的原文。 */
  text: string;
  /** 由入口填写的申请来源，如 http 或 model。 */
  from: string;
  /** 网页提醒的目标机器人，由已确认的提醒记录给出。 */
  targetBot?: string;
}

/** 程序界面经主站鉴权后可以执行的明确操作。 */
export type OutboundAction =
  | { action: 'prepare'; draftId: number }
  | { action: 'prepare-channel'; message: ChannelSendMessage; toolKey?: string }
  | { action: 'confirm'; intentId: string; observedIntentDigest: string; interactionId: string; decision: 'approve' }
  | { action: 'status'; intentId: string }
  | { action: 'status'; draftId: number }
  | { action: 'reconcile'; intentId: string; outcome: 'sent' | 'not-sent' };

/** actor 由可信入口填写，永不从请求正文读取。 */
type OutboundRequest = events.RequestEnvelope & OutboundAction & { program: string; actor: string };
/** 只给本人返回的意图或明确错误。 */
type OutboundResult = events.ResultEnvelope & (
  | { intent: ReturnType<typeof getView> }
  | { code: number; error: string }
);

declare module 'cordis' {
  interface Events {
    /**
     * 主站和程序界面共用入口，请 approval 读取或明确确认发件意图。
     * 谁发：src7/plugins/approval/Outbound.ts 的 requestOutbound
     * 谁接：src7/plugins/approval/Outbound.ts 的 Outbound.constructor
     */
    'approval/outbound-request'(request: OutboundRequest): void | Promise<void>;
    /**
     * 交回主站和程序界面的单独回执，和普通审批、模型回复隔离。
     * 谁发：src7/plugins/approval/Outbound.ts 的 Outbound.constructor
     * 谁接：src7/plugins/approval/Outbound.ts 的 requestOutbound
     */
    'approval/outbound-result'(result: OutboundResult): void;
    /**
     * 定时器只交记录号，目标和批准从持久记录查回。
     * 谁发：src7/plugins/assist/index.ts 的 apply
     * 谁接：src7/plugins/approval/Outbound.ts 的 Outbound.constructor
     */
    'approval/reminder-send'(request: events.RequestEnvelope & { reminderId: number }): void | Promise<void>;
    /**
     * 由同一个主动发件账返回渠道回执。
     * 谁发：src7/plugins/approval/Outbound.ts 的 Outbound.constructor
     * 谁接：src7/plugins/assist/index.ts 的 apply
     */
    'approval/reminder-sent'(result: events.ResultEnvelope & { receipt: ProviderReceipt }): void;
  }
}

/**
 * 让核验后的入口向发件账申请、查看或确认原意图。
 * @param ctx 发起请求的插件上下文。
 * @param program 主站发件账或已登记的外置程序名。
 * @param actor 可信入口核验出的本人或模型身份。
 * @param action 已校验的意图操作与凭据。
 * @returns 发件账回执，或适用于原操作的未获回执说明。
 */
export async function requestOutbound(
  ctx: cordis.Context,
  program: string,
  actor: 'owner' | 'model',
  action: OutboundAction,
): Promise<OutboundResult> {
  const payload = { ...action, program, actor };
  const options = {
    timeoutMs: CONFIRM_WAIT_MS,
    onFallback: () => ({ requestId: '', code: 503, error: '发件确认暂不可用，请按原意图核对' }),
  };
  //M 两种入口共用批准账，等待原操作的配对回执。
  const result = await events.requestEvent(ctx, 'approval/outbound-request', 'approval/outbound-result', payload, options);
  if (action.action !== 'status' && events.isUnsure(result)) {
    return { requestId: '', code: 504, error: '发件操作结果不确定，请核对原意图，避免重复提交' };
  }
  return result;
}

/** 持久行包含精确正文，但不保存程序密钥或主站令牌。 */
interface IntentRow {
  /** 客服页的意图编号。 */
  id: string;
  /** 外置识别的固定业务请求号。 */
  send_id: string;
  /** 外置识别的固定批准号。 */
  approval_id: string;
  /** 程序名。 */
  program: string;
  /** 准备时核对的实例代次。 */
  generation: string;
  /** 当前登记的实际渠道名。 */
  channel: string;
  /** 草稿库内的数字编号。 */
  draft_id: number;
  /** 确切发件账号。 */
  account: string;
  /** 确切目标会话。 */
  chat: string;
  /** 网页聊天所属的机器人，飞书用账号和聊天寻址。 */
  target_bot: string | null;
  /** 提交和预览共用的原文。 */
  text: string;
  /** 包含精确草稿及来源身份的摘要。 */
  digest: string;
  /** 等待、在途或外置终态。 */
  state: 'waiting' | 'sending' | 'invalidated' | ProviderReceipt['status'];
  /** 待确认或已批准的截止毫秒数。 */
  expires_at: number;
  /** 外置原始业务回执，失败时没有外置回执则由主站说明。 */
  receipt: string | null;
  /** 本人核对的结果，独立于原始回执。 */
  checked: 'sent' | 'not-sent' | null;
}

/** 交给客服页展示确认详情和已保存结果。 */
function getView(row: IntentRow) {
  let receipt: ProviderReceipt | undefined;
  if (row.receipt !== null) {
    receipt = JSON.parse(row.receipt) as ProviderReceipt;
  }
  let status = row.state;
  if (status === 'invalidated') {
    status = 'failed';
  }
  return {
    intentId: row.id, requestId: row.send_id, draftId: row.draft_id, channel: row.channel,
    account: row.account, chat: row.chat, text: row.text, digest: row.digest, expiresAt: row.expires_at,
    status, receipt, checked: row.checked, canPrepareAgain: row.state === 'invalidated',
  };
}

/** 用固定字段按原字节计算展示摘要，换账号、聊天、正文或代次都会失效。 */
function digestDraft(program: string, draft: ProgramDraft, targetBot?: string): string {
  const binding = [program, draft.generation, draft.channel, draft.draftId, draft.account, draft.chat, draft.text];
  if (targetBot !== undefined) {
    //M 网页提醒的摘要还绑定目标机器人，换机器人后原确认失效。
    binding.push(targetBot);
  }
  const bytes = JSON.stringify(binding);
  const hash = crypto.createHash('sha256');
  //M 摘要包含固定字段与原始正文。
  hash.update(bytes);
  return hash.digest('hex');
}

/** 不使用通用同发起人审批规则，只有本人确认才能声明这笔外发。 */
export class Outbound {
  /** 主站同一数据库的发件账。 */
  private readonly db: sqlite.Database;

  /** 建立发件账并登记可信入口；不连接微信，也不自动补发。 */
  constructor(private readonly ctx: cordis.Context, private readonly now: () => number = Date.now) {
    this.db = ctx.resources.db;
    //M 独立账本不进入通用文字审批和客户会话通知。
    const sql = 'CREATE TABLE IF NOT EXISTS approval_outbound (id TEXT PRIMARY KEY,'
      + ' send_id TEXT NOT NULL UNIQUE,'
      + ' approval_id TEXT NOT NULL UNIQUE, program TEXT NOT NULL, generation TEXT NOT NULL, channel TEXT NOT NULL,'
      + ' draft_id INTEGER NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL, target_bot TEXT,'
      + ' text TEXT NOT NULL, digest TEXT NOT NULL,'
      + ' state TEXT NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, interaction_id TEXT,'
      + ' receipt TEXT, checked TEXT, notified_at INTEGER)';
    this.db.exec(sql);
    const index = 'CREATE INDEX IF NOT EXISTS approval_outbound_draft ON approval_outbound (program, draft_id)';
    this.db.exec(index);
    //M 只由约定的事件入口取结果，不接受通用 approval/decide。
    const handle = (request: OutboundRequest) => this.handle(request);
    const failures = {
      onError: () => ({ code: 500, error: '发送确认处理失败，请按原意图核对' }),
    };
    //M 请求回执工具负责等待和关联，不把确认交给普通审批的监听者。
    events.onRequestEvent(ctx, 'approval/outbound-request', 'approval/outbound-result', handle, failures);
    //M 定时发送没有可提交目标的 HTTP 或模型入口，只能消费已到期的提醒行。
    const sendReminder = async (request: events.EventArg<'approval/reminder-send'>) => {
      const receipt = await this.sendReminder(request.reminderId);
      return { receipt };
    };
    const reminderFailure = { onError: () => ({ receipt: UNKNOWN }) };
    //M 监听到期发送并返回渠道回执，出错时向提醒队列交回未知状态。
    events.onRequestEvent(ctx, 'approval/reminder-send', 'approval/reminder-sent', sendReminder, reminderFailure);
    //M 重启后在途账只转待核；通知等待主程序所有插件已经挂载。
    ctx.on('ready', () => this.recover());
  }

  /** 以创建时的授权和已占位提醒为依据，使用原主动发件账。 */
  private async sendReminder(reminderId: number): Promise<ProviderReceipt> {
    const payload = { reminderId };
    const options = { timeoutMs: REMINDER_READ_WAIT_MS, onFallback: () => ({ requestId: '' }) };
    //G 只按提醒编号读取已占位的持久记录，发送目标和正文由提醒服务提供。
    const lookup = await events.requestEvent(this.ctx, 'assist/reminder-read', 'assist/reminder-row', payload, options);
    const row = lookup.row;
    if (row?.confirmed !== true) return { status: 'failed', reason: '提醒未到期、未获批准或已经处理' };

    const message: ChannelSendMessage = {
      channel: row.channel, account: row.account, chat: row.chat, text: row.text, from: 'reminder',
    };
    if (row.channel === 'http') {
      message.targetBot = row.bot;
    }
    const interactionId = `assist-reminder:${reminderId}`;
    //M 重入同一提醒时复用同一个意图和渠道去重键。
    const prepared = this.prepareChannel(message, interactionId, true);
    if ('error' in prepared) return { status: 'failed', reason: prepared.error };

    const intent = prepared.intent;
    //M 用发件账中实际保存的行核对原意图，再占住发送位置。
    const stored = this.get(DIRECT_PROGRAM, intent.intentId);
    if (stored === null) return UNKNOWN;

    const confirmation = {
      action: 'confirm' as const, intentId: intent.intentId, observedIntentDigest: intent.digest,
      interactionId, decision: 'approve' as const,
    };
    //M 到点才创建运输意图，批准来自建提醒时的记录。
    const result = await this.confirm(stored, confirmation);
    if ('error' in result) return { status: 'failed', reason: result.error };

    return result.intent.receipt ?? UNKNOWN;
  }

  /** 拒绝外人和同发起人代批，按已校验的操作选择读写。 */
  private async handle(request: OutboundRequest): Promise<events.StripResultId<OutboundResult>> {
    if (request.action === 'prepare-channel') {
      //G 模型只能递交自己的同会话申请；确认和查询仍要求核验本人。
      if (request.program !== DIRECT_PROGRAM || !['owner', 'model'].includes(request.actor)) {
        return { code: 403, error: '主动发件申请来源无效' };
      }

      //M 固定已校验的目标及原文，准备阶段完全不接触渠道运输。
      return this.prepareChannel(request.message, request.toolKey);
    }

    if (request.actor !== 'owner') return { code: 403, error: '发送确认只允许本人操作' };

    //M 准备只读取并展示原草稿。
    if (request.action === 'prepare') return this.prepare(request.program, request.draftId);

    if (request.action === 'status' && 'draftId' in request) {
      //M 页面刷新后只读查询该草稿原来的已保存意图。
      const last = this.latest(request.program, request.draftId);
      if (last === null) return { code: 404, error: '找不到这条草稿的发送意图' };

      //M 状态查询从主站保存的原记录返回。
      return { intent: getView(last) };
    }

    //G 意图与程序固定绑定，别的界面不能拿它确认或查询。
    const row = this.get(request.program, request.intentId);
    if (row === null) return { code: 404, error: '找不到该程序的发送意图' };

    //M 轮询读取持久状态，不接触外置发送能力。
    if (request.action === 'status') return { intent: getView(row) };

    //M 人工核对仅写核对字段。
    if (request.action === 'reconcile') return this.reconcile(row, request.outcome);

    //M 只有明确确认才进入发送判断。
    return this.confirm(row, request);
  }

  /** 读取按程序绑定的已保存意图。 */
  private get(program: string, id: string): IntentRow | null {
    const sql = 'SELECT * FROM approval_outbound WHERE program = ? AND id = ?';
    //G 取意图必须同时吻合程序名。
    return this.db.query<IntentRow, [string, string]>(sql).get(program, id);
  }

  /** 在同笔草稿已有在途或终态时复用原意图，不能换号补发。 */
  private latest(program: string, draftId: number): IntentRow | null {
    const sql = 'SELECT * FROM approval_outbound WHERE program = ? AND draft_id = ? ORDER BY rowid DESC LIMIT 1';
    //M 返回最新草稿意图供确认事务核对。
    return this.db.query<IntentRow, [string, number]>(sql).get(program, draftId);
  }

  /** 向 programs 查询精确草稿，超时在确认之前即失败。 */
  private readDraft(program: string, draftId: number): Promise<ChannelSendResult> {
    const payload = { action: 'draft' as const, program, draftId };
    const options = {
      timeoutMs: DRAFT_WAIT_MS,
      onFallback: () => ({ requestId: '', code: 503, error: '外部程序未就绪或草稿读取失败' }),
    };
    //M 批准不解析程序地址，也不持有启动密钥。
    return events.requestEvent(
      this.ctx, 'programs/channel-send-request', 'programs/channel-send-result', payload, options,
    );
  }

  /** 读取源草稿只供展示，在事务中复用或建立同一草稿的有效意图。 */
  private async prepare(program: string, draftId: number) {
    //M 页面重开按草稿编号找回同一发送记录。
    const previous = this.latest(program, draftId);
    //G 已进入运输或终态的草稿保持原编号。
    if (previous !== null && previous.state !== 'waiting' && previous.state !== 'invalidated') {
      return { intent: getView(previous) };
    }

    //M 尚未出站时读取程序当前可确认的草稿。
    const response = await this.readDraft(program, draftId);
    if ('error' in response) return { code: response.code, error: response.error };
    if (!('draft' in response)) return { code: 502, error: '外部草稿回执不完整' };

    const draft = response.draft;
    //M 预览摘要固定在外置库的原文和目标。
    const digest = digestDraft(program, draft);
    const now = this.now();
    const create = this.db.transaction(() => {
      //G 等待读取草稿时另一请求可能已确认，写前必须重查。
      const existing = this.latest(program, draftId);
      if (existing !== null && existing.state !== 'waiting' && existing.state !== 'invalidated') return existing;
      if (existing?.state === 'waiting' && existing.digest === digest && existing.expires_at > now) return existing;

      //M 分开意图号、业务永久号和已批准时使用的外置批准号。
      const suffix = crypto.randomUUID();
      const sendId = 'kefu-draft:' + String(draftId) + ':' + suffix;
      const expiresAt = now + APPROVAL_MS;
      return this.insertIntent(program, draft, sendId, digest, expiresAt);
    });
    //M 并发准备只得到一个仍有效的预览；发送在明确确认之后。
    const inserted = create.immediate();
    if (inserted === null) return { code: 500, error: '无法保存发件意图' };

    //M 交给本人展示原文和确认摘要。
    return { intent: getView(inserted) };
  }

  /** 把两类发件写成同一格式的待确认意图。 */
  private insertIntent(
    program: string,
    draft: ProgramDraft,
    sendId: string,
    digest: string,
    expiresAt: number,
    targetBot?: string,
  ) {
    const id = crypto.randomUUID();
    const approvalId = crypto.randomUUID();
    const sql = 'INSERT INTO approval_outbound (id,send_id,approval_id,program,generation,channel,draft_id,'
      + ' account,chat,target_bot,text,digest,state,expires_at)'
      + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'waiting',?) RETURNING *";
    //M 预备写入语句，保存后直接返回刚建立的待确认意图。
    const insert = this.db.query<IntentRow, sqlite.SQLQueryBindings[]>(sql);

    //M 主动消息使用草稿号 0，并用代次字段保存可信申请来源。
    return insert.get(id, sendId, approvalId, program, draft.generation, draft.channel, draft.draftId,
      draft.account, draft.chat, targetBot ?? null, draft.text, digest, expiresAt);
  }

  /** 记录主动消息。工具重放沿用原意图，另一段正文不能换进已建的意图。 */
  private prepareChannel(message: ChannelSendMessage, toolKey: string | undefined, reminder = false) {
    const targetBot = message.targetBot;
    const localReminder = reminder && message.channel === 'http' && message.account === 'local'
      && message.chat === 'http:本机' && targetBot !== undefined && targetBot !== '';
    if (message.channel !== 'feishu' && !localReminder) {
      return { code: 409, error: '主动发送当前只支持飞书和本机网页的已确认提醒' };
    }

    const draft = { ...message, draftId: 0, generation: message.from };
    //M 将渠道、目标和原文一起绑定到用户将核对的摘要。
    const digest = digestDraft(DIRECT_PROGRAM, draft, targetBot);
    let suffix: string = crypto.randomUUID();
    if (toolKey !== undefined) {
      const hash = crypto.createHash('sha256');
      //M 同一工具调用算出相同发送编号，重复申请会取回已有意图。
      const updated = hash.update(toolKey);
      suffix = updated.digest('hex');
    }
    const sendId = 'channel-send:' + suffix;
    const expiresAt = this.now() + APPROVAL_MS;

    //M 在同一事务中处理工具重放和首次申请。
    const create = this.db.transaction(() => {
      const sql = 'SELECT * FROM approval_outbound WHERE send_id = ?';
      const current = this.db.query<IntentRow, [string]>(sql).get(sendId);
      if (current !== null) return current;

      //M 条件查询没有找到记录时才建意图，继续留在同一个事务里。
      return this.insertIntent(DIRECT_PROGRAM, draft, sendId, digest, expiresAt, targetBot);
    });
    const row = create.immediate();
    if (row === null) return { code: 500, error: '无法保存主动发件意图' };
    if (row.digest !== digest) return { code: 409, error: '同一次工具调用的发件目标或原文已变化' };

    //M 返回已保存的意图和摘要，让调用方展示可确认的内容。
    return { intent: getView(row) };
  }

  /** 核对刚展示的摘要和新读到的草稿，再持久占住唯一发送位置。 */
  private async confirm(row: IntentRow, request: Extract<OutboundAction, { action: 'confirm' }>) {
    if (request.decision !== 'approve' || request.observedIntentDigest !== row.digest) {
      return { code: 409, error: '展示的发件意图不匹配，请重新读取' };
    }
    //G 已占位或有终态的重复确认只查原记录。
    if (row.state !== 'waiting') return { intent: getView(row) };
    if (row.expires_at <= this.now()) return { code: 409, error: '待确认意图已过期' };

    if (row.program !== DIRECT_PROGRAM) {
      //M 外置草稿发送前需重读；主动消息已原样存入主站账。
      const result = await this.readDraft(row.program, row.draft_id);
      if ('error' in result) return { code: result.code, error: result.error };
      if (!('draft' in result)) return { code: 502, error: '外部草稿回执不完整' };
      if (row.generation !== result.draft.generation) return { code: 409, error: '外部程序已换代，请重新准备确认' };

      //G 外置正文和目标必须与展示时一致。
      const activeDigest = digestDraft(row.program, result.draft);
      if (activeDigest !== row.digest) return { code: 409, error: '草稿目标或正文已变化，请重新确认' };
    }

    const now = this.now();
    const expiresAt = now + APPROVAL_MS;
    const claim = this.db.transaction(() => {
      //G 另一页可能已准备新意图或已经占位，旧页面不能发。
      const latest = this.getConfirmable(row);
      if (latest?.id !== row.id || latest.state !== 'waiting' || latest.expires_at <= now) {
        return { row: latest, claimed: false };
      }

      const sql = "UPDATE approval_outbound SET state = 'sending', approved_at = ?, expires_at = ?, interaction_id = ?"
        + " WHERE id = ? AND state = 'waiting' RETURNING *";
      //M 同时记下占位、批准时刻、有效期及交互证据。
      const update = this.db.query<IntentRow, [number, number, string, string]>(sql);
      const id = row.id;
      const interaction = request.interactionId;
      //G 是否取得运输资格只看本次有无实际写入。
      const changed = update.get(now, expiresAt, interaction, id);
      return { row: changed, claimed: changed !== null };
    });
    const outcome = claim.immediate();
    const approved = outcome.row;
    if (approved?.id !== row.id) return { code: 409, error: '待确认意图已更新，请重新读取' };
    if (!outcome.claimed) {
      if (approved.state === 'waiting') return { code: 409, error: '待确认意图已过期' };

      //M 并发请求读取已占位的记录。
      return { intent: getView(approved) };
    }

    //M 只有本次事务确实占到了唯一发送位置才调用外置。
    const delivery = await this.submit(approved);
    const done = this.saveReceipt(approved, delivery.receipt, delivery.invalidated);
    return { intent: getView(done) };
  }

  /** 主动意图各自确认，外置草稿只许确认当前版本。 */
  private getConfirmable(row: IntentRow): IntentRow | null {
    //M 直接发件的确认按独立意图编号读取。
    if (row.program === DIRECT_PROGRAM) return this.get(row.program, row.id);

    //M 外置程序的草稿可能已更新，确认前读取这一草稿最新的意图。
    return this.latest(row.program, row.draft_id);
  }

  /** 使用原业务号提交一次；未知结果从此只查或核对。 */
  private async submit(row: IntentRow): Promise<{ receipt: ProviderReceipt; invalidated: boolean }> {
    if (row.program === DIRECT_PROGRAM) {
      //M 主站已批准的文本由内置渠道消费一次性凭证并发出。
      const receipt = await this.submitChannel(row);
      return { receipt, invalidated: false };
    }

    const call: ApprovedCall = {
      requestId: row.send_id, channel: row.channel, account: row.account, chat: row.chat, text: row.text,
      approval: { id: row.approval_id, state: 'approved', expiresAt: row.expires_at },
    };
    const payload = { action: 'send' as const, program: row.program, generation: row.generation, call };
    const options = {
      timeoutMs: PROGRAM_WAIT_MS,
      onFallback: (): ChannelSendResult => ({ requestId: '', code: 503, error: '外部程序运输未挂载' }),
    };
    //M 运输回执和局部事件等待号无关，外置只认保存的 P2 业务号。
    const result = await events.requestEvent(
      this.ctx, 'programs/channel-send-request', 'programs/channel-send-result', payload, options,
    );
    //G 运输可能已发出，保留意图供核对。
    if (events.isUnsure(result)) return { receipt: UNKNOWN, invalidated: false };

    if ('receipt' in result) return { receipt: result.receipt, invalidated: false };
    if ('error' in result) {
      //G 运输已证明未发出时，保存本次失败，允许本人重新准备另一项确认。
      return { receipt: { status: 'failed', reason: result.error }, invalidated: true };
    }

    return { receipt: UNKNOWN, invalidated: false };
  }

  /**
   * 把已经批准的原目标和正文交给内置渠道：发 channel/reply，target 带渠道自己的确切地址（飞书照账号和聊天号直发，网页写提醒）。
   * 轮键、请求键都由业务发送号算出，同一笔重试时渠道按请求键去重。
   * @param row 已占住发送位置的意图。
   * @returns 渠道回执折成的外置回执：发了是 sent，明确没发（含渠道没挂）是 failed，超时这类是 uncertain。
   */
  private async submitChannel(row: IntentRow): Promise<ProviderReceipt> {
    //M 渠道自己认得的确切地址：网页提醒带意图号（网页按它去重写一条提醒），飞书是应用号和聊天号。
    let address: Record<string, unknown> = {
      appId: row.account,
      chatId: row.chat,
      messageId: '',
      openId: '',
      chatType: '',
    };
    if (row.channel === 'http') {
      address = { reminder: row.id };
    }
    const target = { channel: row.channel, chat: row.chat, address };

    const replyRoundKey = 'approved-send:' + row.send_id;
    const replyRequestKey = channels.getReplyRequestKey(replyRoundKey, row.send_id);
    const from = { bot: row.target_bot ?? '', replyRoundKey, target };
    const options = { replyRequestKey, replyIndex: 0, kind: 'final' as const };

    //M 交渠道协议发出，等渠道回执。
    const receipt = await channels.requestTextReply(this.ctx, from, row.text, options);

    //M 折成外置回执：渠道收下是 sent，明确没发（含渠道没挂）是 failed，别的不确定，保留原发送号等核对。
    if (receipt.ok) return { status: 'sent' };
    if (receipt.status === 'rejected') return { status: 'failed', reason: receipt.reason ?? '渠道拒发' };

    return { status: 'uncertain', reason: receipt.reason ?? UNKNOWN.reason };
  }

  /** 先归档再发通用事件；重启恢复或重复回执无法覆盖已有结果。 */
  private saveReceipt(row: IntentRow, receipt: ProviderReceipt, invalidated = false): IntentRow {
    const sql = "UPDATE approval_outbound SET state = ?, receipt = ? WHERE id = ? AND state = 'sending' RETURNING *";
    const serialized = JSON.stringify(receipt);
    let status: IntentRow['state'] = receipt.status;
    if (invalidated) {
      status = 'invalidated';
    }
    const id = row.id;
    //M 确认仍在运输后才可写终态，迟到回执不会覆盖恢复状态。
    const update = this.db.query<IntentRow, [string, string, string]>(sql);
    const changed = update.get(status, serialized, id);
    //G 已被恢复流程结算的行交回已存状态。
    if (changed === null) return this.get(row.program, id) ?? row;

    //G 主站主动发件走的是 channel/reply，渠道自己已经发过 channel/replied，不再补。
    if (row.program === DIRECT_PROGRAM) return changed;

    //M 外置程序的发件补一条通用回执；已持久化的事件不会启动第二次发送；不确定同时提示本人核对。
    this.publish(changed, receipt);
    if (receipt.status === 'uncertain') void this.notify(changed);
    return changed;
  }

  /** 仅本人可填人工核对结果，保留原始 uncertain，永不再提交。 */
  private reconcile(row: IntentRow, outcome: 'sent' | 'not-sent') {
    if (row.state !== 'uncertain') return { code: 409, error: '只有不确定的发件可以核对' };
    if (row.checked !== null && row.checked !== outcome) return { code: 409, error: '已保存另一核对结果' };

    const sql = 'UPDATE approval_outbound SET checked = ? WHERE id = ? AND checked IS NULL RETURNING *';
    const id = row.id;
    //M 核对状态与供应方回执分开记，重复操作保留第一次。
    const update = this.db.query<IntentRow, [string, string]>(sql);
    const changed = update.get(outcome, id);
    const saved = changed ?? row;
    //M 页面用同样的意图形状展示人工核对结果。
    return { intent: getView(saved) };
  }

  /**
   * 外置程序的发件不经 channel/reply，补一条通用 channel/replied（带拼出来的请求：渠道、聊天、正文），订阅者照它记；P2 failed 在标准事件中是 rejected。
   * @param row 已落库终态的意图。
   * @param receipt 外置回执。
   */
  private publish(row: IntentRow, receipt: ProviderReceipt): void {
    let status: channels.ReplyStatus = 'rejected';
    if (receipt.status !== 'failed') {
      status = receipt.status;
    }
    const round = 'approved-send:' + row.send_id;
    const key = channels.getReplyRequestKey(round, row.send_id);
    const parts: channels.ReplyPartInput[] = [{ partId: 'text', kind: 'text', text: row.text }];
    const target = { channel: row.channel, chat: row.chat };
    const hashInput = { kind: 'final', mode: 'text', parts, target };
    //M 拼出这笔发件对应的请求，回执带着它（没有来源快照，target 是外置程序的渠道和聊天号）。
    const request: channels.ChannelReplyRequest = {
      requestId: row.send_id,
      channel: row.channel,
      bot: row.target_bot ?? '',
      replyRequestKey: key,
      replyRoundKey: round,
      replyIndex: 0,
      kind: 'final',
      mode: 'text',
      payloadHash: channels.getPayloadHash(hashInput),
      parts,
      target,
    };
    //M 标准回执沿用发送意图使用的注入时钟。
    const result = channels.getReceipt(request, status, receipt.reason);
    result.at = this.now();
    try {
      //M 回执已经落库，订阅者出错也不影响后续核对。
      channels.emitReplied(this.ctx, request, result);
    } catch {
      console.error('外部渠道发送回执通知失败');
    }
  }

  /** 离线恢复仅标记可能已提交的发送，不发 P2 请求。 */
  private recover(): void {
    const sql = "SELECT * FROM approval_outbound WHERE state = 'sending'";
    //M 查上次没有保存终态的记录。
    const pending = this.db.query<IntentRow, []>(sql).all();
    for (const row of pending) {
      //G 在途仅归档为待核，永不重新发出。
      this.saveReceipt(row, UNKNOWN);
    }
  }

  /** 当前飞书配置明确为本人的私聊才收提示，不落客户私聊或群。 */
  private async notify(row: IntentRow): Promise<void> {
    try {
      //G 未挂飞书时由客服页展示待核。
      const feishu = this.ctx.get('feishu');
      if (feishu === undefined) return;

      const criteria = { channel: 'feishu' };
      //M 从已有私聊地址定位登记为本人的人。
      const sessions = this.ctx.sessions.find(criteria);
      for (const session of sessions) {
        const address = session.address as FeishuAddress | undefined;
        if (address?.chatType !== 'p2p' || typeof address.chatId !== 'string' || address.chatId === '') continue;

        //G 用当前人员配置再核一遍本人，不沿用旧会话的角色或回退到最近私聊。
        const person = feishu.config.people.get(address.openId);
        if (person?.role !== 'owner') continue;

        const sql = 'UPDATE approval_outbound SET notified_at = ? WHERE id = ? AND notified_at IS NULL';
        const now = this.now();
        const id = row.id;
        //G 先占住唯一提醒位置，重复核对不得再提醒。
        const mark = this.db.query(sql);
        const sent = mark.run(now, id);
        if (sent.changes !== 1) return;

        const message = '外部微信有一条发件结果不确定，请在客服页核对。发件编号 ' + row.send_id;
        //M 提示只送已验证的本人地址，正文和目标都不放入通知。
        await feishu.sendText(address, message);
        return;
      }
    } catch {
      console.error('外部渠道发送结果提醒未送达');
    }
  }
}
