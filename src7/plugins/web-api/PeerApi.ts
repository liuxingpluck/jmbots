/**
 * 外部访客客服 HTTP 接口（`POST /api/peer/message`，并兼容 `POST /api/message` 传 `peer`）：
 * 专为语舱 AI（`yucang-ai`）等外部社媒客服网关调用独立无渠道机器人（如 `INS客服`）设计。
 * 强制以最低权限 `role: 'guest'`（`owner: false`、`trusted: false`）入站：
 *   - 按 `(bot, peer.account, peer.id)` 自动隔离独立前台会话与 `person:http:<account>:<peerId>` 记忆归属；
 *   - 自动加载 `bots/<bot>/persona.md` 人设，严格阻断主人私人 `memory/`、目录授权 `grants`、`exec`/`write` 工具与“同意 N”审批；
 *   - 支持 `wait_ms`（默认 60000ms）单次请求同步等待本轮回复收尾，也支持 `wait_ms: 0` 异步轮询 `GET /api/messages/:id`。
 */
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as botUtils from '../../utils/Bots.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as protocol from '../channels/index.ts';
import type * as timelineModule from './Timeline.ts';


/** `POST /api/peer/message` 默认同步等待模型回复的毫秒上限。 */
const DEFAULT_PEER_WAIT_MS = 60_000;

/** 允许的单次最大同步等待毫秒上限。 */
const MAX_PEER_WAIT_MS = 120_000;

/** 外部买家 ID 最大字符长度。 */
const MAX_PEER_ID_CHARS = 200;

/** 店铺账号标识或展示昵称最大字符长度。 */
const MAX_LABEL_CHARS = 120;

/** 检查字符串是否包含控制字符（0x00-0x1F 或 0x7F）。 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}


/** 校验通过后的外部访客身份信息。 */
export interface ValidatedPeer {
  /** 外部平台买家唯一标识（如 Instagram 买家 ID 或 handle）。 */
  id: string;
  /** 买家可读展示名。 */
  name: string;
  /** 所属外部店铺/社媒账号标识（默认 `external`，多店铺间完全隔离）。 */
  account: string;
}

/** 外部访客消息接口返回结构（兼容 `{ id, file }` 并附带会话与回复详情）。 */
export interface PeerMessageReply {
  id: number;
  file: string;
  bot: string;
  peer: ValidatedPeer;
  chatId: string;
  sessionId: string | null;
  status: 'taken' | 'replied';
  reply: string;
  replies: string[];
}


/**
 * 校验并归一化请求体中的 `peer` 字段。
 * @param raw 原始 `peer` 对象。
 */
export function parsePeerInput(raw: unknown): ValidatedPeer {
  const rec = checksModule.checkRecord(raw, 'peer');
  const rawId = rec['id'];
  if (typeof rawId !== 'string') {
    throw new failureModule.Failure(400, 'peer.id 要是非空字符串');
  }
  const id = rawId.trim();
  if (id === '' || id.length > MAX_PEER_ID_CHARS || hasControlChars(id)) {
    throw new failureModule.Failure(400, `peer.id 长度需在 1 至 ${String(MAX_PEER_ID_CHARS)} 之间且不含控制字符`);
  }

  let account = 'external';
  const rawAccount = rec['account'];
  if (rawAccount !== undefined) {
    if (typeof rawAccount !== 'string') {
      throw new failureModule.Failure(400, 'peer.account 要是非空字符串');
    }
    const trimmedAcc = rawAccount.trim();
    if (trimmedAcc === '' || trimmedAcc.length > MAX_LABEL_CHARS || hasControlChars(trimmedAcc)) {
      throw new failureModule.Failure(400, 'peer.account 不能为空、超长或包含控制字符');
    }
    account = trimmedAcc;
  }

  let name = id;
  const rawName = rec['name'];
  if (rawName !== undefined) {
    if (typeof rawName !== 'string') {
      throw new failureModule.Failure(400, 'peer.name 要是字符串');
    }
    const trimmedName = rawName.trim();
    if (trimmedName.length > MAX_LABEL_CHARS || hasControlChars(trimmedName)) {
      throw new failureModule.Failure(400, 'peer.name 不能超长或包含控制字符');
    }
    if (trimmedName !== '') {
      name = trimmedName;
    }
  }

  return { id, name, account };
}


/**
 * 校验可选 `wait_ms` 等待毫秒参数。
 */
function parseWaitMs(raw: unknown, fallbackMs: number): number {
  if (raw === undefined) return fallbackMs;

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_PEER_WAIT_MS) {
    throw new failureModule.Failure(400, `wait_ms 要是 0 至 ${String(MAX_PEER_WAIT_MS)} 的整数毫秒`);
  }
  return raw;
}


/** 外部访客对话接入控制器（复用 `http` 渠道收件表与回复链路，强制锁定 `guest` 权限）。 */
export class PeerApi {
  /** 等待指定 `messageId` 收尾（`bot/settled`）的挂起回调表。 */
  private readonly waiters = new Map<number, Set<() => void>>();

  /** 单调递增时间戳，避免高并发同毫秒消息撞车。 */
  private lastAt = 0;

  /**
   * @param ctx `web-api` 插件上下文。
   * @param timeline 共享收件表。
   * @param savePeerImages 复用 `WebApi` 的内联图片校验与工作区落盘函数。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly timeline: timelineModule.Timeline,
    private readonly savePeerImages: (bot: string, rawImages: unknown) => Promise<string[]>,
  ) {
    //M 插件卸载时唤醒全部在途等待者，避免悬挂 Promise。
    this.ctx.effect(() => () => {
      for (const group of this.waiters.values()) {
        for (const wake of group) {
          wake();
        }
      }
      this.waiters.clear();
    });
  }

  /**
   * 在 `web-api` 的同一个 Fastify 作用域下挂载专用外部访客接口 `POST /api/peer/message`。
   * @param scope Fastify 路由作用域。
   */
  routes(scope: fastify.FastifyInstance): void {
    scope.post<{ Body: unknown }>('/api/peer/message', async (request) => {
      return await this.accept(request.body, DEFAULT_PEER_WAIT_MS);
    });
  }

  /**
   * 由 `WebApi.onSettled` 在收尾落盘后同步调用，唤醒正在等待该消息回复的 HTTP 调用方。
   * @param messageId 已标为 `replied` 的 `web_messages.id`。
   */
  notifySettled(messageId: number): void {
    const group = this.waiters.get(messageId);
    if (group === undefined) return;

    this.waiters.delete(messageId);
    for (const wake of group) {
      wake();
    }
  }

  /**
   * 校验并接收一条外部访客消息，按 `(bot, peer.account, peer.id)` 路由至独立 `guest` 前台会话。
   * @param raw 原始请求体。
   * @param defaultWaitMs 未显式传 `wait_ms` 时的默认等待时长。
   */
  async accept(raw: unknown, defaultWaitMs = 0): Promise<PeerMessageReply> {
    const body = checksModule.checkRecord(raw, '请求体');

    //G 严格禁止外部访客请求携带目录授权、主人会话号或渠道内部视图，从入口封死越权路径。
    if (body['grants'] !== undefined) {
      throw new failureModule.Failure(400, '外部访客消息禁止携带 grants 目录授权');
    }
    if (body['view'] !== undefined) {
      throw new failureModule.Failure(400, '外部访客消息禁止携带 view 视图参数');
    }
    if (body['session'] !== undefined && body['session'] !== '') {
      throw new failureModule.Failure(400, '外部访客消息按 peer 自动隔离会话，禁止指定 session');
    }

    const peer = parsePeerInput(body['peer']);
    const waitMs = parseWaitMs(body['wait_ms'], defaultWaitMs);

    const text = body['text'] ?? '';
    if (typeof text !== 'string') {
      throw new failureModule.Failure(400, 'text 要是字符串');
    }

    const from = body['from'] ?? 'peer-api';
    if (typeof from !== 'string' || from.trim() === '') {
      throw new failureModule.Failure(400, 'from 要是非空字符串');
    }

    const wanted = body['bot'] ?? botUtils.getDefaultBot(this.ctx.resources.raw);
    if (typeof wanted !== 'string') {
      throw new failureModule.Failure(400, 'bot 要是字符串');
    }
    if (botUtils.getBotConfig(this.ctx.resources.raw, wanted) === undefined) {
      throw new failureModule.Failure(400, `没有这个机器人：${wanted}`);
    }

    const imagePaths = await this.savePeerImages(wanted, body['images']);
    if (text.trim() === '' && imagePaths.length === 0) {
      throw new failureModule.Failure(400, 'text 和 images 至少要有一样');
    }

    const mentions = imagePaths.map((item) => {
      if (/\s/u.test(item)) return `@"${item}"`;

      return `@${item}`;
    });
    const said = [text, ...mentions].filter((item) => item !== '').join('\n');

    //M 按 `peer:<account>:<peerId>` 构造全局唯一的访客会话号与记忆人名键，多店铺同名买家亦互不串线。
    const chatId = `peer:${peer.account}:${peer.id}`;
    const scopedSenderId = `${peer.account}:${peer.id}`;
    const customer = `http:${chatId}`;
    const storedAddress = {
      accountId: peer.account,
      chatId,
      chatType: 'p2p',
      senderId: scopedSenderId,
      peerId: peer.id,
      name: peer.name,
      customer,
      role: 'guest',
      owner: false,
    };

    const id = this.timeline.insert({
      bot: wanted,
      channel: 'http',
      source: from.trim(),
      text: said,
      address: JSON.stringify(storedAddress),
    });

    //M 在入站前预先挂好结算等待器，防止同步极速模型在 emitInbound 返回前即触发 onSettled 漏唤醒。
    let waitPromise: Promise<void> | undefined;
    if (waitMs > 0) {
      waitPromise = this.waitForMessageSettled(id, waitMs);
    }

    let emitError: unknown;
    try {
      await this.emitGuestInbound(id, wanted, peer, chatId, scopedSenderId, storedAddress, said);
    } catch (error) {
      emitError = error;
    }
    if (emitError !== undefined) {
      this.notifySettled(id);
      this.timeline.remove(id);
      throw new failureModule.Failure(400, textModule.getErrorMessage(emitError));
    }

    if (waitPromise !== undefined) {
      await waitPromise;
    }

    const finalRecord = this.timeline.get(id);
    let status: 'taken' | 'replied' = 'taken';
    let sessionId: string | null = null;
    let replies: string[] = [];
    if (finalRecord !== undefined) {
      status = finalRecord.status;
      sessionId = finalRecord.sessionId;
      replies = finalRecord.replies.map((item) => item.text).filter((item) => item !== '');
    }

    return {
      id,
      file: '',
      bot: wanted,
      peer,
      chatId,
      sessionId,
      status,
      reply: replies.join('\n\n'),
      replies,
    };
  }

  /**
   * 构造严格锁定为 `role: 'guest'`、`trusted: false` 的标准私聊消息并发出 `channel/direct`。
   */
  private async emitGuestInbound(
    id: number,
    wanted: string,
    peer: ValidatedPeer,
    chatId: string,
    scopedSenderId: string,
    storedAddress: Record<string, unknown>,
    said: string,
  ): Promise<void> {
    const now = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = now;

    const originAddress: Record<string, unknown> = {
      ...storedAddress,
      messageId: id,
      verifiedOwner: false,
    };
    const nativeId = String(id);
    const messageId = protocol.makeChannelMessageId('http', peer.account, nativeId);
    const channelMessage: protocol.ChannelMessage = {
      v: 1,
      messageId,
      nativeId,
      channel: 'http',
      accountId: peer.account,
      chatId,
      chatType: 'p2p',
      sender: { id: scopedSenderId, name: peer.name },
      role: 'guest',
      targetBots: [wanted],
      mentions: [],
      rawText: said,
      text: said,
      attachments: [],
      createdAt: now,
      receivedAt: now,
      timeSource: 'received',
      replyTo: null,
      origin: {
        channel: 'http',
        address: originAddress,
      },
      visibility: {
        scope: `http:${peer.account}:${chatId}`,
        trusted: false,
        publicSourceIds: [],
      },
      routing: {
        autoFinal: true,
      },
    };

    const control: protocol.ChannelMessageControl = { claims: [] };
    await protocol.emitInbound(this.ctx, channelMessage, true, control);
    const claim = control.claims.find((one) => one.bot === wanted && one.sessionId !== undefined);
    if (claim?.sessionId === undefined) {
      throw new Error(`机器人 ${wanted} 未能认领访客消息`);
    }
    this.timeline.bindSession(id, claim.sessionId);
  }

  /**
   * 等待 `messageId` 状态变为 `replied` 或到达 `waitMs` 超时阈值（超时不报错，返回当前 `taken` 状态供继续轮询）。
   */
  private waitForMessageSettled(messageId: number, waitMs: number): Promise<void> {
    const existing = this.timeline.get(messageId);
    if (existing?.status === 'replied') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let group = this.waiters.get(messageId);
      if (group === undefined) {
        group = new Set();
        this.waiters.set(messageId, group);
      }

      let done = false;
      const finish = (): void => {
        if (done) return;

        done = true;
        clearTimeout(timer);
        const current = this.waiters.get(messageId);
        current?.delete(finish);
        if (current !== undefined && current.size === 0) {
          this.waiters.delete(messageId);
        }
        resolve();
      };

      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      group.add(finish);

      //M 二次复核状态，彻底消除注册瞬间的竞态窗口。
      if (this.timeline.get(messageId)?.status === 'replied') {
        finish();
      }
    });
  }
}


/**
 * 判断请求体是否显式携带了 `peer` 字段（供 `POST /api/message` 分流至 `PeerApi`）。
 */
export function hasPeerField(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;

  return utils.getField(raw, 'peer') !== undefined;
}
