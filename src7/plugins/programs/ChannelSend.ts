/** 代理本人确认入口和受批准的发送运输，外置草稿内容只从程序读取。 */
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as events from '../../utils/RequestEvent.ts';
import * as outbound from '../approval/Outbound.ts';
import type { OutboundAction } from '../approval/Outbound.ts';
import type { Host } from './Host.ts';
import * as protocol from './Protocol.ts';

/** 外置微信客服提供的只读草稿列表。 */
const DRAFTS_ROUTE = '/api/wechat-kefu/drafts';
/** 只由主站内部运输调用的批准发送接口。 */
const SEND_ROUTE = '/jmbots/v1/channel/send';
/** 发送开始后没有可靠回执时，保留未知结果。 */
const UNKNOWN: ProviderReceipt = { status: 'uncertain', reason: '发送结果待核对，不自动重发' };

/** 拦下旧客服页的本地临时批准入口，统一由主站确认。 */
export function isLegacySend(pathname: string): boolean {
  return pathname === '/api/wechat-kefu/outbox/send' || pathname === '/api/wechat-kefu/send';
}

/** 已从当前托管程序取回的精确草稿。 */
export interface ProgramDraft {
  /** 外置草稿编号。 */
  draftId: number;
  /** 登记的实际渠道名。 */
  channel: string;
  /** 当前实例的唯一代次，与密钥独立。 */
  generation: string;
  /** 确切发件账号。 */
  account: string;
  /** 确切目标聊天。 */
  chat: string;
  /** 数据库里原样保留的正文。 */
  text: string;
}

/** 外置批准发送接口承诺的回执。 */
export interface ProviderReceipt {
  /** 外置的业务状态。 */
  status: 'sent' | 'failed' | 'uncertain';
  /** 外置提供的原因，可能缺席。 */
  reason?: string;
}

/** 已被本人明确批准的 P2 请求，字段完全来自主站保存的原意图。 */
export interface ApprovedCall {
  /** 外置持久去重的业务号。 */
  requestId: string;
  /** 登记的实际渠道名。 */
  channel: string;
  /** 原发件账号。 */
  account: string;
  /** 原目标聊天。 */
  chat: string;
  /** 原正文。 */
  text: string;
  /** 与该请求绑定的固定批准。 */
  approval: {
    /** 永久批准号。 */
    id: string;
    /** 运输只接受已批准的发件。 */
    state: 'approved';
    /** Unix 毫秒过期时间。 */
    expiresAt: number;
  };
}

/** approval/outbound 经常规事件请 programs 读取原草稿，或提交已批准的发送。 */
export type ChannelSendRequest = events.RequestEnvelope & { program: string } & (
  | { action: 'draft'; draftId: number }
  | { action: 'send'; generation: string; call: ApprovedCall }
);

/** 运输返回原草稿、可靠回执，或明确未提交的错误。 */
export type ChannelSendResult = events.ResultEnvelope & (
  | { draft: ProgramDraft }
  | { receipt: ProviderReceipt }
  | { code: number; error: string }
);

declare module 'cordis' {
  interface Events {
    /**
     * 审核插件读草稿或请求发送。
     * 谁发：src7/plugins/approval/Outbound.ts 的 Outbound.readDraft、Outbound.submit
     * 谁接：src7/plugins/programs/ChannelSend.ts 的 listenChannelSend
     */
    'programs/channel-send-request'(request: ChannelSendRequest): void | Promise<void>;
    /**
     * 与运输请求关联的回执，永不携带密钥。
     * 谁发：src7/plugins/programs/ChannelSend.ts 的 listenChannelSend
     * 谁接：src7/plugins/approval/Outbound.ts 的 Outbound.readDraft、Outbound.submit
     */
    'programs/channel-send-result'(result: ChannelSendResult): void;
  }
}

/** 仅对已登记微信渠道的宿主启用当前草稿协议。 */
export function getWechatChannel(host: Host): string | undefined {
  //G 渠道从已通过单活检查的程序配置取得，不信任浏览器自填渠道。
  const channels = host.spec.channels.filter((item) => item.name === 'wechat' || item.name === 'wechat-external');
  if (channels.length !== 1) return undefined;

  return channels[0]?.name;
}

/** 注册内部运输，不把管理发送路径开放给代理客户。 */
export function listenChannelSend(ctx: cordis.Context, hosts: ReadonlyMap<string, Host>): void {
  const handle = (request: ChannelSendRequest) => {
    //M 只从已经允许启动的托管表选目标。
    const host = hosts.get(request.program);
    if (host === undefined) return { code: 503, error: '外部程序未就绪' };

    //M 托管表选出的实例提供草稿和发送能力。
    return callProgram(host, request);
  };
  //M 抛出的发送异常按已可能提交处理，草稿读取异常只报读取失败。
  events.onRequestEvent(ctx, 'programs/channel-send-request', 'programs/channel-send-result', handle, {
    onError: (_error, request) => {
      if (request.action === 'send') return { receipt: UNKNOWN };

      return { code: 502, error: '外部草稿读取失败' };
    },
  });
}

/** 固定地址、固定协议；调用前重新核对实例和批准期限。 */
async function callProgram(host: Host, request: ChannelSendRequest) {
  //G 同一次同步读取地址、当前密钥和代次；后台自动重启也会更换代次。
  const target = host.getSendTarget();
  if (target === undefined) return { code: 503, error: '外部程序未就绪' };

  //G 只对实际配置为微信渠道的程序开放这条运输。
  const channel = getWechatChannel(host);
  if (channel === undefined) return { code: 409, error: '程序未登记可确认发送的微信渠道' };

  const headers = { [protocol.KEY_HEADER]: target.key, 'content-type': 'application/json' };
  if (request.action === 'draft') {
    //M 从现有只读草稿接口按编号取记录，不相信客户端或者模型传入正文。
    const signal = AbortSignal.timeout(outbound.DRAFT_HTTP_WAIT_MS);
    const options = { headers, signal, redirect: 'error' as const };
    const response = await fetch(target.base + DRAFTS_ROUTE, options);
    if (!response.ok) return { code: 502, error: '外部草稿读取失败' };

    const decoded: unknown = await response.json();
    const id = request.draftId;
    const generation = target.generation;
    //M 草稿字段与这次读取的程序代次作为一个快照交回。
    const draft = getDraft(decoded, id, channel, generation);
    if (draft === undefined) return { code: 409, error: '没有可确认的草稿或草稿状态已经改变' };

    return { draft };
  }

  //G 实例代次变化或超过截止时间都在发请求前拒绝，绝不把旧批准换新密钥提交。
  if (target.generation !== request.generation || channel !== request.call.channel) {
    return { code: 409, error: '外部程序代次或渠道已变化，请重新确认' };
  }
  if (request.call.approval.expiresAt <= Date.now()) return { code: 409, error: '发送批准已过期' };

  //M 保留批准上的全部原值；没有结果时只交回待核，不在这里重试。
  const body = JSON.stringify(request.call);
  const signal = AbortSignal.timeout(outbound.CHANNEL_WAIT_MS);
  const options = { method: 'POST', headers, body, signal, redirect: 'error' as const };
  const response = await fetch(target.base + SEND_ROUTE, options);
  const decoded: unknown = await response.json();
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return { receipt: UNKNOWN };

  const wire = decoded as Record<string, unknown>;
  const status = wire['status'];
  if (status !== 'sent' && status !== 'failed' && status !== 'uncertain') return { receipt: UNKNOWN };

  const reason = wire['reason'];
  const receipt: ProviderReceipt = { status };
  if (typeof reason === 'string') {
    //G 外置错误偶尔回显请求细节，启动密钥不能进入审批账或页面。
    receipt.reason = reason.replaceAll(target.key, '[已隐藏]');
  }
  return { receipt };
}

/** 只接当前列表里仍然是草稿的原始账号、聊天和正文。 */
function getDraft(decoded: unknown, id: number, channel: string, generation: string): ProgramDraft | undefined {
  if (!Array.isArray(decoded)) return undefined;

  for (const row of decoded) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;

    const record = row as Record<string, unknown>;
    const draftId = record['id'];
    if (draftId !== id) continue;

    const state = record['state'];
    if (state !== 'draft') return undefined;

    const account = record['account'];
    const chat = record['chat'];
    const body = record['text'];
    if (typeof account !== 'string' || account.trim() === '') return undefined;
    if (typeof chat !== 'string' || chat.trim() === '') return undefined;
    if (typeof body !== 'string' || body.trim() === '') return undefined;

    return { draftId, channel, generation, account, chat, text: body };
  }
  return undefined;
}

/** 在程序界面命名空间登记主站确认路由；这里的正文不交外置。 */
export function mountOutbound(
  ctx: cordis.Context,
  app: fastify.FastifyInstance,
  isVerified: (request: fastify.FastifyRequest) => boolean,
  hosts: ReadonlyMap<string, Host>,
): void {
  const route = '/programs/:name/_approval/:action';
  app.post<{ Params: { name: string; action: string }; Body: unknown }>(
    route,
    { bodyLimit: 4096 },
    async (request, reply) => {
      //G 只认 HTTP 钩子的核验结果，客户自填的头或 owner 字段都不起作用。
      if (!isVerified(request)) return reply.code(403).send({ error: '发送确认只允许本人操作' });

      //G 只接受已登记的操作及其固定字段。
      const action = request.params.action;
      const program = request.params.name;
      //M 浏览器确认直接走主站账。
      return handleOutbound(ctx, program, action, request.body, reply);
    },
  );

  //M 托管外置客服可把代理已核验的本人操作交回同一个确认入口。
  const callback = '/api/programs/:name/channel/approval';
  app.post<{ Params: { name: string }; Body: unknown }>(callback, { bodyLimit: 4096 }, async (request, reply) => {
    const program = request.params.name;
    const host = hosts.get(program);
    const target = host?.getSendTarget();
    const key = request.headers[protocol.KEY_HEADER];
    //G 只有本次托管实例能转交代理核验过的确认，配置名不能自行冒充。
    const verified = protocol.isSameKey(target?.key, key);
    if (!verified) return reply.code(403).send({ error: '发送确认只允许当前托管程序转交' });

    const body = request.body as { action?: unknown } | null | undefined;
    const action = body?.action;
    //G 未明确操作的回调不进入发送账。
    if (typeof action !== 'string') return reply.code(400).send({ error: '发送确认参数无效' });

    //M 外置只转交页面操作，不提供批准号、目标或者正文。
    return handleOutbound(ctx, program, action, body, reply);
  });
}

/** 把合法的双阶段操作交给同一份主站批准账。 */
async function handleOutbound(
  ctx: cordis.Context,
  program: string,
  name: string,
  body: unknown,
  reply: fastify.FastifyReply,
) {
  //G 参数有误时不要把原正文送往程序。
  const action = getAction(name, body);
  if (action === undefined) return reply.code(400).send({ error: '发送确认参数无效' });

  //M 交给 approval 查原记录、批准及归档，路由本身不生成批准。
  const result = await outbound.requestOutbound(ctx, program, 'owner', action);
  if ('error' in result) return reply.code(result.code).send({ error: result.error });

  return { intent: result.intent };
}

/** 代理外置旧路径时仅允许双阶段操作，移除旧版能用来本地发件的 id。 */
export function getProxyApproval(path: string, method: string, body: unknown): OutboundAction | undefined {
  if (path !== '/api/wechat-kefu/outbox/send' || method !== 'POST') return undefined;
  if (!(body instanceof Uint8Array) || body.length > 4096) return undefined;

  try {
    const json = Buffer.from(body).toString('utf8');
    const parsed = JSON.parse(json) as { action?: unknown } | null;
    const action = parsed?.action;
    if (typeof action !== 'string') return undefined;

    //M 只重建批准操作字段，旧外置程序收到也无法从 id 生成临时批准。
    return getAction(action, parsed);
  } catch {
    return undefined;
  }
}

/** 在 HTTP 入口校验字段，保留主站存账的不可变意图标识。 */
function getAction(action: string, body: unknown): OutboundAction | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;

  const fields = body as Record<string, unknown>;
  const draftId = fields['draftId'];
  if (action === 'prepare' || (action === 'status' && draftId !== undefined)) {
    if (typeof draftId !== 'number' || !Number.isSafeInteger(draftId) || draftId < 1) return undefined;

    if (action === 'prepare') return { action, draftId };

    return { action: 'status', draftId };
  }

  const intentId = fields['intentId'];
  if (typeof intentId !== 'string' || intentId === '' || intentId.length > 100) return undefined;
  if (action === 'status') return { action, intentId };
  if (action === 'reconcile') {
    const outcome = fields['outcome'];
    if (outcome !== 'sent' && outcome !== 'not-sent') return undefined;

    return { action, intentId, outcome };
  }
  if (action !== 'confirm') return undefined;

  const observedIntentDigest = fields['observedIntentDigest'];
  const interactionId = fields['interactionId'];
  const decision = fields['decision'];
  if (decision !== 'approve') return undefined;
  if (typeof observedIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(observedIntentDigest)) return undefined;
  if (typeof interactionId !== 'string' || interactionId.trim() === '' || interactionId.length > 100) return undefined;

  return { action, intentId, observedIntentDigest, interactionId, decision };
}
