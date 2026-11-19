/** 主动发件的 HTTP 与模型入口。两者先交 Outbound 存为待确认意图。 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import type { Http } from '../http/index.ts';
import * as utils from '../../utils/index.ts';
import * as outbound from './Outbound.ts';

/** 校验 HTTP 输入。身份和申请来源不取自正文。 */
function getAction(body: unknown): outbound.OutboundAction | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;

  const fields = body as Record<string, unknown>;
  const action = fields['action'];
  if (action === undefined || action === 'prepare') {
    //G 申请必须同时带上完整目标和正文，后续确认才能核对这一份内容。
    const channel = utils.getStringField(fields, 'channel');
    const account = utils.getStringField(fields, 'account');
    const chat = utils.getStringField(fields, 'chat');
    const content = utils.getStringField(fields, 'text');
    if (channel.trim() === '' || account.trim() === '' || chat.trim() === '' || content.trim() === '') return undefined;

    //M 保存将展示给核验用户的精确目标和正文。
    const message = { channel, account, chat, text: content, from: 'http' };
    return { action: 'prepare-channel', message };
  }

  //G 查询和确认都要带已有意图的编号，限定长度后再交给发件账。
  const intentId = utils.getStringField(fields, 'intentId');
  if (intentId.trim() === '' || intentId.length > 100) return undefined;
  if (action === 'status') return { action, intentId };
  if (action !== 'confirm' || fields['decision'] !== 'approve') return undefined;

  //G 用户确认时要同时带看过的摘要和本次交互编号，供发件账核验。
  const observedIntentDigest = utils.getStringField(fields, 'observedIntentDigest');
  const interactionId = utils.getStringField(fields, 'interactionId');
  if (!/^[a-f0-9]{64}$/u.test(observedIntentDigest)) return undefined;
  if (interactionId.trim() === '' || interactionId.length > 100) return undefined;

  return { action, intentId, observedIntentDigest, interactionId, decision: 'approve' };
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

    //G 校验请求正文再转交，缺少必要字段的请求直接返回错误。
    const action = getAction(request.body);
    if (action === undefined) return reply.code(400).send({ error: '主动发件参数无效' });

    //M 只有本机或验过匹配令牌的请求才作为本人操作进入原有发送账。
    const result = await outbound.requestOutbound(ctx, outbound.DIRECT_PROGRAM, 'owner', action);
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
    sessionKinds: ['front', 'work'],
    run: async (args: Record<string, unknown>, session: Session,
      signal: AbortSignal, callId: string): Promise<string> => {
      if (signal.aborted) throw new Error('发件申请已取消');

      //G 不沿用旧会话可变地址。缺可信快照或当前渠道未接入时直接退出。
      const snapshot = session.row.activeSourceSnapshot ?? session.row.frontTask?.sourceSnapshot;
      if (snapshot?.channel !== 'feishu' || snapshot.accountId.trim() === '' || snapshot.chatId.trim() === '') {
        throw new Error('主动发件需要本轮可信飞书来源');
      }
      //G 模型只提供非空正文，渠道、账号和聊天都从本轮快照取。
      const content = utils.getStringField(args, 'text');
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
      const result = await outbound.requestOutbound(ctx, outbound.DIRECT_PROGRAM, 'model', action);
      if ('error' in result) throw new Error(result.error);

      const { intentId, status } = result.intent;
      return JSON.stringify({ intentId, status });
    },
  };

  //M 沿用现有工具系统的会话类型和执行前审批。
  ctx.tools.register(tool);
}
