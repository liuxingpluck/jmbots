/** 主动发件的 HTTP 与模型入口。两者先交 Outbound 存为待确认意图。 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import type { Http } from '../http/index.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as text from '../../utils/Text.ts';
import * as outbound from './Outbound.ts';

/** 校验 HTTP 输入。身份和申请来源不取自正文。 */
function getAction(body: unknown): outbound.OutboundAction | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;

  const fields = body as Record<string, unknown>;
  const action = fields['action'];
  if (action === undefined || action === 'prepare') {
    const channel = text.getText(fields, 'channel');
    const account = text.getText(fields, 'account');
    const chat = text.getText(fields, 'chat');
    const content = text.getText(fields, 'text');
    if (channel.trim() === '' || account.trim() === '' || chat.trim() === '' || content.trim() === '') return undefined;

    //M 保存将展示给核验用户的精确目标和正文。
    const message = { channel, account, chat, text: content, from: 'http' };
    return { action: 'prepare-channel', message };
  }

  const intentId = text.getText(fields, 'intentId');
  if (intentId.trim() === '' || intentId.length > 100) return undefined;
  if (action === 'status') return { action, intentId };
  if (action !== 'confirm' || fields['decision'] !== 'approve') return undefined;

  const observedIntentDigest = text.getText(fields, 'observedIntentDigest');
  const interactionId = text.getText(fields, 'interactionId');
  if (!/^[a-f0-9]{64}$/u.test(observedIntentDigest)) return undefined;
  if (interactionId.trim() === '' || interactionId.length > 100) return undefined;

  return { action, intentId, observedIntentDigest, interactionId, decision: 'approve' };
}

/** 让两种入口复用主站已有的确认、占位和回执账。 */
function requestOutbound(ctx: cordis.Context, action: outbound.OutboundAction, actor: 'owner' | 'model') {
  const program = outbound.DIRECT_PROGRAM;
  const payload = { ...action, program, actor };
  const options = {
    timeoutMs: 105_000,
    onFallback: () => ({ requestId: '', code: 503, error: '发件确认暂不可用，请按原意图核对' }),
  };

  //M 入口不直接接触渠道；确认权限和值都由 Outbound 核对。
  return events.requestEvent(ctx, 'approval/outbound-request', 'approval/outbound-result', payload, options);
}

/**
 * 注册主动发送的 HTTP 申请、查询和确认。
 * @param ctx 审批插件上下文。
 * @param http 已提供鉴权钩子的 HTTP 服务。
 */
export function mountChannelSend(ctx: cordis.Context, http: Pick<Http, 'app' | 'isVerified'>): void {
  const route = '/api/channel/send';
  //M 复用 HTTP 插件的已验证请求记录，确认不接收可替换的目标和正文。
  http.app.post<{ Body: unknown }>(route, async (request, reply) => {
    if (!http.isVerified(request)) return reply.code(403).send({ error: '发件请求未通过身份核验' });

    const action = getAction(request.body);
    if (action === undefined) return reply.code(400).send({ error: '主动发件参数无效' });

    //M 只有本机或验过匹配令牌的请求才作为本人操作进入原有发送账。
    const result = await requestOutbound(ctx, action, 'owner');
    if ('error' in result) return reply.code(result.code).send({ error: result.error });

    return { intent: result.intent };
  });
}

/** 注册只接受正文的模型工具，目标从本轮不可变来源快照读取。 */
export function registerChannelSendTool(ctx: cordis.Context): void {
  const definition = {
    name: 'channel_send',
    description: '向本轮飞书聊天提交一条纯文字发送申请，等待本人确认后才发送。只能填写正文。',
    parameters: piAi.Type.Object({ text: piAi.Type.String({ description: '待确认并发出的正文' }) },
      { additionalProperties: false }),
  };
  const tool = {
    definition,
    kinds: ['front', 'work'],
    run: async (args: Record<string, unknown>, session: Session,
      signal: AbortSignal, callId: string): Promise<string> => {
      if (signal.aborted) throw new Error('发件申请已取消');

      //G 不沿用旧会话可变地址。缺可信快照或当前渠道未接入时直接退出。
      const snapshot = session.row.activeSourceSnapshot ?? session.row.frontTask?.sourceSnapshot;
      if (snapshot?.channel !== 'feishu' || snapshot.accountId.trim() === '' || snapshot.chatId.trim() === '') {
        throw new Error('主动发件需要本轮可信飞书来源');
      }
      const content = text.getText(args, 'text');
      if (content.trim() === '') throw new Error('发件正文不能为空');

      const message = {
        channel: snapshot.channel,
        account: snapshot.accountId,
        chat: snapshot.chatId,
        text: content,
        from: 'model',
      };
      const toolKey = JSON.stringify([session.id, snapshot.replyRoundKey, callId]);
      const action = { action: 'prepare-channel' as const, message, toolKey };

      //M 只建立与本轮及工具调用绑定的意图，模型拿不到确认权限。
      const result = await requestOutbound(ctx, action, 'model');
      if ('error' in result) throw new Error(result.error);

      const { intentId, status } = result.intent;
      return JSON.stringify({ intentId, status });
    },
  };

  //M 沿用现有工具系统的会话类型和执行前审批。
  ctx.tools.register(tool);
}
