/**
 * 渠道回复与渠道历史工具：
 *   - channel_reply：只在当前轮有 channel_tool 绑定时开放；纯文字发送（绝不把 @路径 当成文件上传），经 channel/reply ↔ channel/replied 拿回真实回执；
 *     受管后台会话（work）调 channel_reply 时先转回原前台，不越级直发原渠道；
 *   - 给统一记忆工具提供渠道归档，归档提供方核对查询范围和游标。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as protocol from '../../Channels.ts';
import * as historyTools from '../memory/HistoryTools.ts';
import type { QueueItem, ResultInput } from './Dispatch.ts';
import * as historyRequest from './HistoryRequest.ts';


/** 渠道历史默认每次返回条数（一般 50–100 条够用，默认 80）。 */
const DEFAULT_HISTORY_LIMIT = 80;

/** 历史查询一次允许的最大条数。 */
const MAX_HISTORY_LIMIT = 200;

/** 提醒模型必须显式调用渠道回复工具。 */
const CHANNEL_REPLY_HINT = '当前渠道不会自动把你的普通文字回答发给用户。'
  + '需要向用户汇报进度或给出最终回复时，必须调用 channel_reply 工具发送纯文字（纯文字不会把 @路径 当文件发送；同一次调用失败可查看回执）。'
  + '平常回复当前聊天不要填 channel 和 chat；只有用户本人明确要求去别的渠道或别的聊天发话时才填 channel 和 chat，不要自作主张往别处发。';


/** 登记并约束渠道回复和历史工具的生命周期与权限范围。 */
export class ChannelTools {
  /** 当前正在执行的工具调用 ID（会话号 → call.id），供幂等回复键使用。 */
  private readonly currentCallId = new Map<string, string>();

  /** 默认历史查询条数（未显式配置 front.history_limit 时默认 80，最多 200）。 */
  private readonly historyLimit: number;

  /**
   * 登记渠道工具与相关关口监听。
   * @param ctx Cordis 上下文。
   * @param historyLimit 默认历史查询条数（未显式配置时默认 80，最多 200）。
   */
  constructor(private readonly ctx: cordis.Context, historyLimit = DEFAULT_HISTORY_LIMIT) {
    //M 默认条数由 bots 的 apply 校验配置后传进来（不写是 80）。
    this.historyLimit = historyLimit;

    //M channel_reply：默认发回本轮绑定来源；非群聊本人可传 channel / chat 跨渠道发纯文字，不解释 @路径。
    this.ctx.tools.register({
      definition: {
        name: 'channel_reply',
        description: '发送纯文字回复（不会把 @路径 解析成文件），返回 JSON 编码的 ReplyReceipt。'
          + '不写 channel 和 chat 时，一律发回本轮当前绑定的来源聊天（平常回复当前对话不要填它们）。'
          + '只有当用户本人明确要求“帮我在别的渠道或别的聊天里说一下/回一下”时，才指定目标 channel 和 chat，绝不要自作主张往别处发；'
          + '发往别处成功后，原来源不会自动补发回话，需要告知用户时由你自行决定是否再调一次不带 channel/chat 的 channel_reply。'
          + 'kind 可选 progress（阶段进度）或 final（默认，最终答复）。',
        parameters: piAi.Type.Object({
          text: piAi.Type.String({ minLength: 1, description: '要发送的纯文字内容' }),
          kind: piAi.Type.Optional(piAi.Type.Union([
            piAi.Type.Literal('progress'),
            piAi.Type.Literal('final'),
          ], { description: '回复类型：progress 或 final（默认 final）' })),
          channel: piAi.Type.Optional(piAi.Type.String({
            minLength: 1,
            description: '可选目标渠道名（feishu / wechat / http / cli）；仅在用户本人明确要求去别的渠道或聊天发话时填写，不写则发回当前来源',
          })),
          chat: piAi.Type.Optional(piAi.Type.String({
            minLength: 1,
            description: '可选目标聊天标识或名称（如飞书群号/群名、微信会话名/wxid、网页或命令行填 本机）；仅本人指定去别处发话时填写，不写则发回当前聊天',
          })),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => this.runReply(args, session),
    });

    //M 给统一记忆工具读取当前或获准的跨渠道聊天。
    const currentRoute = 'channel-current';
    historyTools.registerHistoryReader(this.ctx, currentRoute, (args, session) => this.runHistory('current', args, session));

    //M 从当前绑定聊天读取提及机器人的消息。
    const mentionsRoute = 'channel-mentions';
    historyTools.registerHistoryReader(this.ctx, mentionsRoute, (args, session) => this.runHistory('mentions', args, session));

    //M 按获准的发言人和聊天读取消息。
    const visibleRoute = 'channel-visible';
    historyTools.registerHistoryReader(this.ctx, visibleRoute, (args, session) => this.runHistory('visible', args, session));

    //M 记录正在执行的 call.id 供 channel_reply 生成幂等键。
    this.ctx.on('session/before-tool', (gate) => {
      this.currentCallId.set(gate.session.id, gate.call.id);
      if (gate.deny !== undefined) return;

      //G 激活 channel_tool 的受管 work 禁止再用旧 reply 旁路直发渠道。
      if (gate.call.name === 'reply' && this.hasBinding(gate.session)) {
        gate.deny = '当前来源使用 channel_reply，请改调 channel_reply（受管后台会经前台转达，不直接发给渠道）';
        return;
      }

      //G 未绑定 channel_tool 时不能执行 channel_reply。
      if (gate.call.name === 'channel_reply' && !this.hasBinding(gate.session)) {
        gate.deny = '当前会话没有活跃的渠道来源绑定，不能调用渠道工具';
      }
    });

    this.ctx.on('session/after-tool', (done) => {
      this.currentCallId.delete(done.session.id);
    });

    this.ctx.on('session/request', (request) => {
      this.filterTools(request);
    });
  }

  /**
   * 按本轮渠道绑定控制 channel_reply、旧 reply 和纯文字回复提示。
   * @param request 请求对象。
   */
  private filterTools(request: ChatRequest): void {
    const row = request.session.row;
    if (row.kind !== 'front' && row.kind !== 'work') return;

    //G 未绑定渠道回复能力时不展示 channel_reply。
    const hasReplyBinding = this.hasBinding(request.session);
    if (!hasReplyBinding) {
      request.tools = request.tools.filter((tool) => tool.name !== 'channel_reply');
    }

    //M relay direct 会话没有真模型；受管后台启用 channel_tool 时禁用旧 reply。
    if (hasReplyBinding && row.kind === 'work' && row.frontTask?.deliveryMode === 'channel_tool') {
      request.tools = request.tools.filter((tool) => tool.name !== 'reply');
    }

    //M channel_tool 模式必须显式调 channel_reply。
    if (hasReplyBinding && request.tools.some((tool) => tool.name === 'channel_reply')) {
      request.system.push(CHANNEL_REPLY_HINT);
    }

    //M 网页发话时带了“正在看哪儿”（web-api 校验过的 view）：前台这一轮的提示里说一句，模型知道用户说的“这个群”指哪儿。
    const view = this.getSnapshot(request.session)?.view;
    if (row.kind === 'front' && view !== undefined) {
      let label = view.label ?? '';
      if (label === '') {
        label = `${view.channel}·${view.chat}`;
      }
      request.system.push(`用户正在网页上看：${label}`);
    }
  }

  /**
   * 这场会话当前是否处于 channel_tool 绑定下。
   * @param session 目标会话。
   */
  private hasBinding(session: Session): boolean {
    const row = session.row;
    if (row.kind === 'front') {
      const active = this.getActiveItem(session);
      return active !== undefined && active.deliveryMode === 'channel_tool' && active.payload.sourceSnapshot !== undefined;
    }
    if (row.kind === 'work') {
      if (row.frontTask?.deliveryMode === 'channel_tool' && row.frontTask.sourceSnapshot !== undefined) return true;

      return row.activeSourceSnapshot !== undefined;
    }
    return false;
  }

  /**
   * 取出会话正在处理的活动项。
   * @param session 会话对象。
   */
  private getActiveItem(session: Session): QueueItem | undefined {
    const key = session.row.activeKey;
    if (key === undefined) return undefined;

    return (session.row.resultQueue ?? []).find((item) => item.key === key);
  }

  /**
   * 取出当前轮绑定的不可变来源快照。
   * @param session 会话对象。
   */
  private getSnapshot(session: Session): protocol.SourceSnapshot | undefined {
    const row = session.row;
    if (row.kind === 'front') {
      return this.getActiveItem(session)?.payload.sourceSnapshot ?? row.activeSourceSnapshot;
    }
    return row.frontTask?.sourceSnapshot ?? row.activeSourceSnapshot;
  }

  /**
   * 执行 channel_reply：默认纯文字发送到绑定的不可变来源，或受管后台转交原前台；
   * 非群聊本人（isHistoryOwner）显式传入别处 channel / chat 时，只附带 target 经 channel/reply 发出，由目标渠道自己认聊天。
   * @param args 工具参数（text, kind?, channel?, chat?）。
   * @param session 当前会话。
   */
  private async runReply(args: Record<string, unknown>, session: Session): Promise<string> {
    const text = String(args['text'] ?? '');
    if (text.trim() === '') {
      throw new Error('channel_reply 的 text 不能为空');
    }

    let kind: protocol.ReplyKind = 'final';
    if (args['kind'] === 'progress') {
      kind = 'progress';
    }

    let rawChannel = '';
    if (typeof args['channel'] === 'string') {
      rawChannel = args['channel'].trim();
    }
    let rawChat = '';
    if (typeof args['chat'] === 'string') {
      rawChat = args['chat'].trim();
    }

    //M 从执行上下文取本次工具 call.id 生成幂等请求键。
    const callId = this.currentCallId.get(session.id) ?? `manual_${String(Date.now())}`;
    const row = session.row;

    //M 受管后台在 channel_tool 模式下不直发渠道，一律转成前台通知队列项回传原前台；若非本人想发别处先直接拦截。
    const task = row.frontTask;
    const workSnapshot = task?.sourceSnapshot;
    if (row.kind === 'work' && task?.deliveryMode === 'channel_tool' && workSnapshot !== undefined) {
      const roundKey = workSnapshot.replyRoundKey;
      //M 计算标准回复幂等键，供受管后台转前台排队及拒收校验共用。
      const replyRequestKey = protocol.getReplyRequestKey(roundKey, callId);
      const workCross = this.getRequestedTarget(workSnapshot, rawChannel, rawChat);
      if (workCross.isElsewhere && !protocol.isHistoryOwner(workSnapshot)) {
        //G 外人或群聊本人在受管后台也不能指定往别的渠道/聊天发话。
        const denied = this.getRejectedReceipt(
          replyRequestKey,
          roundKey,
          0,
          kind,
          this.getCrossForbiddenReason(workSnapshot),
        );
        return JSON.stringify(denied);
      }

      const noticeKey = `work:${session.id}:notice:${callId}`;
      let routedText = `（后台阶段回复）\n${text}`;
      if (workCross.isElsewhere) {
        let targetChatLabel = workCross.chat;
        if (targetChatLabel === '') {
          targetChatLabel = '（默认聊天）';
        }
        routedText = `（后台请求代发到 ${workCross.channel} · ${targetChatLabel}）\n${text}`;
      }
      const noticeInput: ResultInput = {
        key: noticeKey,
        sessionId: task.front,
        source: { type: 'work', id: session.id },
        origin: structuredClone(task.origin),
        sourceSnapshot: structuredClone(workSnapshot),
        deliveryMode: 'channel_tool',
        payload: { text: routedText, files: [] },
      };
      //M 将转交通知排入原前台会话单队列，等待原前台整理发回。
      this.ctx.frontDesk.acceptResult(noticeInput, () => undefined);
      const queuedReceipt: protocol.ReplyReceipt = {
        v: 2,
        ok: true,
        status: 'queued',
        replyRequestKey,
        replyRoundKey: roundKey,
        replyIndex: 0,
        kind,
        parts: [{ partId: 'text:0', kind: 'text', status: 'queued', reason: '已转交原前台整理并回复原渠道' }],
        receiptId: noticeKey,
        reason: '受管后台不越级直发渠道，已转交原前台',
        at: Date.now(),
      };
      return JSON.stringify(queuedReceipt);
    }

    //M 前台会话或非受管直绑会话：读活动项里的不可变快照与 replyControl。
    const active = this.getActiveItem(session);
    const snapshot = this.getSnapshot(session);
    if (snapshot === undefined) {
      throw new Error('no_channel_binding：当前会话没有绑定的来源快照');
    }

    //M 基于回复轮键和调用号算出本次发信的幂等键。
    const replyControl = active?.replyControl;
    const replyRoundKey = replyControl?.roundKey ?? snapshot.replyRoundKey;
    const replyRequestKey = protocol.getReplyRequestKey(replyRoundKey, callId);

    //M 同一 replyRequestKey 重试保持原序号；新调用从 nextReplyIndex 取值并加一。
    let replyIndex = replyControl?.nextReplyIndex ?? 0;
    if (replyControl !== undefined) {
      const existingIndex = replyControl.receiptKeys.indexOf(replyRequestKey);
      if (existingIndex >= 0) {
        replyIndex = existingIndex;
      }
      if (existingIndex < 0) {
        replyControl.nextReplyIndex += 1;
        replyControl.receiptKeys.push(replyRequestKey);
        session.save();
      }
    }

    //M 仅判定当前调用是否要求发到当前绑定聊天之外；若指定别处，先用 isHistoryOwner 验权。
    const requested = this.getRequestedTarget(snapshot, rawChannel, rawChat);
    const parts: protocol.ReplyPartInput[] = [{ partId: 'text:0', kind: 'text', text }];
    let sendChannel = snapshot.channel;
    let target: protocol.ChannelReplyTarget | undefined;

    if (requested.isElsewhere) {
      //G 只有非群聊用户本人（isHistoryOwner）才能往别的渠道或聊天发话，外人与群聊本人直接拒收。
      if (!protocol.isHistoryOwner(snapshot)) {
        const forbidden = this.getRejectedReceipt(
          replyRequestKey,
          replyRoundKey,
          replyIndex,
          kind,
          this.getCrossForbiddenReason(snapshot),
        );
        if (active !== undefined) {
          active.deliveryReceipt = forbidden;
          session.save();
        }
        return JSON.stringify(forbidden);
      }

      sendChannel = requested.channel;
      //M 原样传入目标渠道和聊天串，由目标渠道在自己的 channel/reply 监听里识别聊天；bots 不触碰别家数据。
      target = { channel: requested.channel, chat: requested.chat };
    }

    //M 经统一事件 channel/reply 发往目标渠道；目标渠道未挂时由 requestChannelReply 直接回报“渠道 X 没挂”。
    const hashInput: { kind: protocol.ReplyKind; mode: 'text'; parts: protocol.ReplyPartInput[]; target?: protocol.ChannelReplyTarget } = {
      kind,
      mode: 'text',
      parts,
    };
    if (target !== undefined) {
      hashInput.target = target;
    }
    //M 计算包含 target 在内的正文摘要哈希。
    const payloadHash = protocol.getPayloadHash(hashInput);
    const replyReq: Omit<protocol.ChannelReplyRequest, 'requestId'> = {
      channel: sendChannel,
      bot: snapshot.botName,
      replyRequestKey,
      replyRoundKey,
      replyIndex,
      kind,
      mode: 'text',
      sourceSnapshot: structuredClone(snapshot),
      payloadHash,
      parts,
    };
    if (target !== undefined) {
      replyReq.target = target;
    }
    //M 经 channel/reply 发出回复请求；未挂载渠道由协议层直接回“渠道 X 没挂”。
    const receipt = await protocol.requestChannelReply(this.ctx, replyReq);

    if (active !== undefined) {
      //M 将渠道返回的真实发送回执落盘记到当前活动队列项。
      active.deliveryReceipt = receipt;
      session.save();
    }
    return JSON.stringify(receipt);
  }

  /**
   * 构造标准 v2 拒绝发送回执。
   * @param replyRequestKey 本次请求幂等键。
   * @param replyRoundKey 所属回复轮键。
   * @param replyIndex 本轮序号。
   * @param kind 回复类别。
   * @param reason 拒绝原因说明。
   * @returns rejected 状态的 ReplyReceipt。
   */
  private getRejectedReceipt(
    replyRequestKey: string,
    replyRoundKey: string,
    replyIndex: number,
    kind: protocol.ReplyKind,
    reason: string,
  ): protocol.ReplyReceipt {
    return {
      v: 2,
      ok: false,
      status: 'rejected',
      replyRequestKey,
      replyRoundKey,
      replyIndex,
      kind,
      parts: [{ partId: 'text:0', kind: 'text', status: 'rejected', reason }],
      reason,
      at: Date.now(),
    };
  }

  /**
   * 给出无权跨渠道/跨聊天发话的明确拒绝原因（区分群聊本人与外人）。
   * @param snapshot 当前轮来源快照。
   * @returns 中文原因。
   */
  private getCrossForbiddenReason(snapshot: protocol.SourceSnapshot): string {
    if (snapshot.chatType === 'group' && snapshot.role === 'owner') {
      return 'forbidden：群聊里不能指定 channel/chat 往别的渠道或聊天发话，群里的其他人会看到发往别处的内容';
    }
    return `forbidden：只有非群聊的用户本人（owner）才能指定 channel/chat 往别的渠道或聊天发话，当前身份（${snapshot.role}）只能回复当前聊天`;
  }

  /**
   * 解析调用方传入的 channel / chat 是否指向当前轮绑定来源之外的别处。
   * @param snapshot 当前轮来源快照。
   * @param rawChannel 工具传入的 channel（去首尾空白）。
   * @param rawChat 工具传入的 chat（去首尾空白）。
   * @returns 是否跨目标、规范化后的渠道名与原样保留的目标聊天字符串。
   */
  private getRequestedTarget(
    snapshot: protocol.SourceSnapshot,
    rawChannel: string,
    rawChat: string,
  ): { isElsewhere: boolean; channel: string; chat: string } {
    if (rawChannel === '' && rawChat === '') {
      return { isElsewhere: false, channel: snapshot.channel, chat: '' };
    }

    let channel = snapshot.channel;
    if (rawChannel !== '') {
      //M 统一渠道别名（如 web → http、wechat-kefu → wechat），与历史查询口径一致。
      channel = this.normalizeChannelName(rawChannel);
    }

    if (channel === snapshot.channel && (rawChat === '' || rawChat === snapshot.chatId)) {
      return { isElsewhere: false, channel: snapshot.channel, chat: '' };
    }
    return { isElsewhere: true, channel, chat: rawChat };
  }

  /**
   * 取出用于历史查询的来源快照：优先用 channel_tool 绑定的不可变快照，否则按 legacy_auto 会话的 channel 与 address 构造只读快照。
   * @param session 会话对象。
   * @returns 可用于历史权限检查与渠道路由的快照；无渠道来源时返回 undefined。
   */
  private getHistorySnapshot(session: Session): protocol.SourceSnapshot | undefined {
    //M channel_tool 会话直接使用当前轮绑定的不可变快照。
    const bound = this.getSnapshot(session);
    if (bound !== undefined) return bound;

    //M 兼容 legacy_auto 会话（网页、命令行、微信）：从后台派活来源或前台会话的 channel / address 推导只读快照。
    const row = session.row;
    let channel = row.channel;
    let rawAddress: unknown = row.address;
    if (row.kind === 'work' && row.frontTask?.origin.channel !== undefined) {
      channel = row.frontTask.origin.channel;
      rawAddress = row.frontTask.origin.address;
    }
    if (typeof channel !== 'string' || channel === '') return undefined;

    let addressObj: Record<string, unknown> = {};
    if (typeof rawAddress === 'object' && rawAddress !== null && !Array.isArray(rawAddress)) {
      addressObj = structuredClone(rawAddress) as Record<string, unknown>;
    }

    const normalizedChannel = this.normalizeChannelName(channel);
    let accountId = 'local';
    let chatId = textModule.getText(addressObj, 'customer');
    let chatType: protocol.ChannelChatType = 'local';
    let senderId = chatId || `${normalizedChannel}:本机`;

    if (normalizedChannel === 'http' && chatId === '') {
      chatId = 'http:本机';
      senderId = 'http:本机';
    }
    if (normalizedChannel === 'cli' && chatId === '') {
      chatId = 'cli:本机';
      senderId = 'cli:本机';
    }
    if (normalizedChannel === 'wechat') {
      accountId = textModule.getText(addressObj, 'account') || 'local';
      chatId = textModule.getText(addressObj, 'chat') || chatId;
      chatType = 'p2p';
      if (chatId.endsWith('@chatroom') || textModule.getText(addressObj, 'chatType') === 'group') {
        chatType = 'group';
      }
      senderId = chatId;
    }
    if (normalizedChannel === 'feishu') {
      accountId = textModule.getText(addressObj, 'appId') || 'local';
      chatId = textModule.getText(addressObj, 'chatId') || chatId;
      chatType = 'p2p';
      if (textModule.getText(addressObj, 'chatType') === 'group') {
        chatType = 'group';
      }
      senderId = textModule.getText(addressObj, 'openId') || chatId;
    }

    const rawMsgId = textModule.getField(addressObj, 'messageId');
    let snapshotMessageId = `${normalizedChannel}:${session.id}`;
    if (typeof rawMsgId === 'string' && rawMsgId !== '') {
      snapshotMessageId = rawMsgId;
    }
    if (typeof rawMsgId === 'number' && Number.isFinite(rawMsgId)) {
      snapshotMessageId = String(rawMsgId);
    }

    const snapshot: protocol.SourceSnapshot = {
      messageId: snapshotMessageId,
      nativeId: null,
      channel: normalizedChannel,
      accountId,
      chatId,
      chatType,
      senderId,
      role: protocol.resolveLegacyRole(addressObj),
      targetBots: [row.bot],
      mentions: [],
      origin: { channel: normalizedChannel, address: addressObj },
      visibility: {
        scope: `${normalizedChannel}:${accountId}:${chatId}`,
        trusted: chatType === 'local' || textModule.getField(addressObj, 'trusted') === true,
        publicSourceIds: [],
      },
      botName: row.bot,
      claimKey: `${normalizedChannel}:${session.id}:${row.bot}`,
      replyRoundKey: `${normalizedChannel}:${session.id}:${row.bot}:history`,
    };

    //M 预留网页“正在看哪儿”视图上下文（131 接入 POST /api/message 的 view 后可随来源快照或 address 传入）。
    const view = this.parseView(textModule.getField(addressObj, 'view'));
    if (view !== undefined) {
      snapshot.view = view;
    }
    return snapshot;
  }

  /**
   * 规范化渠道名称（兼容网页别名 web 与微信别名 wechat-kefu）。
   * @param rawChannel 原始渠道字符串。
   * @returns 规范化后的标准渠道名。
   */
  private normalizeChannelName(rawChannel: string): string {
    const trimmed = rawChannel.trim();
    if (trimmed === 'web') return 'http';
    if (trimmed === 'wechat-kefu') return 'wechat';

    return trimmed;
  }

  /**
   * 解析可选的网页当前查看上下文 view（channel / chat 须为非空字符串且不能是汇总标签 all）。
   * @param raw 未知格式的 view 字段。
   * @returns 合法视图或 undefined。
   */
  private parseView(raw: unknown): protocol.ChannelView | undefined {
    const rawChannel = textModule.getText(raw, 'channel').trim();
    const rawChat = textModule.getText(raw, 'chat').trim();
    if (rawChannel === '' || rawChannel === 'all' || rawChat === '') return undefined;

    return {
      channel: this.normalizeChannelName(rawChannel),
      chat: rawChat,
    };
  }

  /**
   * 解析历史查询的默认目标渠道与聊天：本人优先采用 131 预留的网页 view 上下文，否则回退当前会话来源。
   * @param snapshot 来源快照。
   * @param isOwner 是否为本人（owner）。
   * @returns 默认目标渠道与聊天标识。
   */
  private getDefaultTarget(
    snapshot: protocol.SourceSnapshot,
    isOwner: boolean,
  ): { channel: string; chatId: string } {
    //M 预留网页“正在看哪儿”默认入口：131 把 view: { channel, chat } 放进 channel/message（或 sourceSnapshot.view / origin.address.view）后，
    //M   本人未显式传 channel / chat 参数时默认查该视图对应的渠道和聊天；外人禁止使用 view 越出当前聊天。
    if (isOwner) {
      const view = this.parseView(snapshot.view ?? textModule.getField(snapshot.origin.address, 'view'));
      if (view !== undefined) return { channel: view.channel, chatId: view.chat };
    }

    return { channel: snapshot.channel, chatId: snapshot.chatId };
  }

  /**
   * 执行三类渠道历史查询：本人支持跨渠道、跨聊天查询，外人仅限当前所在聊天。
   * @param mode 查询模式：current / mentions / visible。
   * @param args 工具参数。
   * @param session 当前会话。
   */
  private async runHistory(mode: protocol.ChannelHistoryMode, args: Record<string, unknown>, session: Session): Promise<string> {
    const snapshot = this.getHistorySnapshot(session);
    if (snapshot === undefined) {
      const err: protocol.ChannelHistoryResult = {
        ok: false,
        items: [],
        nextCursor: null,
        scope: '',
        completeness: 'unsupported',
        error: { code: 'no_channel_binding', message: '当前会话没有绑定的渠道来源快照' },
      };
      return JSON.stringify(err);
    }

    let limit = this.historyLimit;
    if (typeof args['limit'] === 'number' && Number.isInteger(args['limit'])) {
      limit = Math.min(MAX_HISTORY_LIMIT, Math.max(1, args['limit']));
    }
    let before: string | undefined;
    const rawBefore = args['before'];
    if (typeof rawBefore === 'string' && rawBefore !== '') {
      before = rawBefore;
    }

    const isOwner = protocol.isHistoryOwner(snapshot);
    const defaultTarget = this.getDefaultTarget(snapshot, isOwner);

    //M current 模式支持显式传 channel / chat；visible 模式延续可选 chatId 参数。
    let requestedChannel = defaultTarget.channel;
    let explicitChannel = false;
    if (mode === 'current' && typeof args['channel'] === 'string' && args['channel'].trim() !== '') {
      requestedChannel = this.normalizeChannelName(args['channel']);
      explicitChannel = true;
    }

    let rawChatArg = args['chatId'];
    if (mode === 'current') {
      rawChatArg = args['chat'];
    }
    let requestedChatId: string | undefined = defaultTarget.chatId;
    if (typeof rawChatArg === 'string' && rawChatArg.trim() !== '') {
      requestedChatId = rawChatArg.trim();
    }
    if ((typeof rawChatArg !== 'string' || rawChatArg.trim() === '') && explicitChannel && requestedChannel !== defaultTarget.channel) {
      //M 本人跨渠道但未传 chat 时，不把原渠道的 chatId 串过去，交给目标渠道取默认聊天。
      requestedChatId = undefined;
    }

    let senderId: string | undefined;
    const rawSender = args['senderId'];
    if (typeof rawSender === 'string') {
      senderId = rawSender.trim();
    }

    //G visible 模式必须传非空 senderId。
    if (mode === 'visible' && (senderId === undefined || senderId === '')) {
      const bad: protocol.ChannelHistoryResult = {
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'invalid_argument', message: '按发言人查询需要提供非空的 senderId' },
      };
      return JSON.stringify(bad);
    }

    //G 外人（guest / builder）指定其他渠道或当前聊天之外的任何聊天一律拒绝。
    if (!isOwner && requestedChannel !== snapshot.channel) {
      const forbidden: protocol.ChannelHistoryResult = {
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: {
          code: 'forbidden',
          message: `外人（${snapshot.role}）只能查询当前渠道（${snapshot.channel}）的历史，不能跨渠道查询 ${requestedChannel}`,
        },
      };
      return JSON.stringify(forbidden);
    }
    if (!isOwner && requestedChatId !== undefined && requestedChatId !== snapshot.chatId) {
      const forbidden: protocol.ChannelHistoryResult = {
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: {
          code: 'forbidden',
          message: `外人（${snapshot.role}）只能查询当前聊天（${snapshot.chatId}）的历史，无权查看别的聊天 ${requestedChatId}`,
        },
      };
      return JSON.stringify(forbidden);
    }

    const result = await historyRequest.requestChannelHistory(this.ctx, {
      channel: requestedChannel,
      sourceSnapshot: structuredClone(snapshot),
      mode,
      chatId: requestedChatId,
      senderId,
      limit,
      before,
    });
    return JSON.stringify(result);
  }
}
