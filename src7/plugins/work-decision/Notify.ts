/** 把待定件数和页面链接发给配置中的主人，以及控制面单向唤醒与作战室播报。 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as failureModule from '../../utils/Failure.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as channel from '../channels/Reply.ts';
import type * as targetModule from '../channels/Target.ts';
import type { DecisionRelayRequest } from './Routes.ts';
import * as types from './Types.ts';

export const PAGE = '/work-decision/';

/** 配置给出的通知目的地和手机可打开的地址。 */
export interface OwnerNotice {
  /** 发件渠道为这个机器人选账号。 */
  bot: string;
  /** 停在主人的私聊，模型不能写入此配置。 */
  target: targetModule.ChannelReplyTarget;
  /** 手机能打开的完整工作决策页。 */
  url: URL;
}

/** 主人通知路由配置：支持默认目标与按机器人名定向路由。 */
export interface OwnerNoticeConfig {
  /** 未命中专属机器人时回落的默认通知目标（来自 owner_target）。 */
  default?: OwnerNotice;
  /** 按机器人名索引的专属通知目标（来自 owner_targets）。 */
  byBot: Map<string, OwnerNotice>;
}

/** 解析后的单次提醒目标与可选机器人统计范围。 */
export interface ResolvedNotice {
  /** 命中的通知目标。 */
  notice: OwnerNotice;
  /** 命中专属机器人目标时记录该机器人名，用于多机器人并存时附带该机器人件数。 */
  scopedBot?: string;
}

/** 作战室群战报配置目的地（来自 plugins[name="work-decision"].config.broadcast_target）。 */
export interface BroadcastTarget {
  /** 发送渠道（默认 feishu）。 */
  channel: string;
  /** 负责往作战室发战报的机器人名。 */
  bot: string;
  /** 作战室群或聊天 ID（配置里填，代码不硬编码）。 */
  chatId: string;
}

/** 控制面任务单向唤醒与作战室播报的运行时路由配置。 */
export interface ControlDispatchConfig {
  /** 可选作战室战报投递目标（未配置时温和降级跳过）。 */
  broadcastTarget?: BroadcastTarget;
  /** 可选助手名到机器人名的映射表（helper_bots）。 */
  helperBots: ReadonlyMap<string, string>;
  /** 可选主人私聊通知配置（缺省时用于兜底解析目标机器人）。 */
  noticeConfig?: OwnerNoticeConfig;
}

/** 控制面单向唤醒与作战室播报的共享上下文输入。 */
export interface TaskDispatchInput {
  /** 已原子落盘的最新版任务卡。 */
  task: types.ControlTask;
  /** 本次落盘后的账本修订号。 */
  revision: number;
  /** 任务状态的中文展示名。 */
  statusLabel: string;
  /** 本次操作人或 AI 节点名。 */
  actor: string;
  /** 本次进展或事件说明正文。 */
  eventText: string;
  /** 可选单向唤醒的外部助手名。 */
  notifyHelper?: string;
  /** 可选显式指定唤醒机器人名。 */
  notifyBot?: string;
  /** 是否向配置作战室发送一行战报。 */
  broadcast: boolean;
}

/**
 * 为单个新待定节点解析负责发提醒的通知目标：优先按节点归属机器人，未命中则回落默认目标。
 * @param noticeConfig 启动时校验好的通知路由配置。
 * @param bot 节点归属的机器人名，旧节点或未归属节点可能为空。
 * @returns 命中的通知目标；既无专属配置又无默认配置时返回 undefined。
 */
function getNoticeForNode(
  noticeConfig: OwnerNoticeConfig,
  bot: string | undefined,
): ResolvedNotice | undefined {
  //M 节点带有归属机器人时，优先走 owner_targets 里的专属目标。
  if (bot !== undefined) {
    const dedicated = noticeConfig.byBot.get(bot);
    if (dedicated !== undefined) return { notice: dedicated, scopedBot: bot };
  }

  //M 未命中专属目标时，回落到默认 owner_target。
  if (noticeConfig.default !== undefined) return { notice: noticeConfig.default };

  return undefined;
}

/**
 * 为手动触发提醒接口解析通知目标。
 * @param noticeConfig 启动时校验好的通知路由配置。
 * @param bot 可选的显式机器人名；省略时走默认目标，无默认且仅有一项专属目标时用该项。
 * @returns 命中的通知目标与可选统计范围。
 */
export function getManualNotice(
  noticeConfig: OwnerNoticeConfig | undefined,
  bot?: string,
): ResolvedNotice {
  //G 未配置任何通知目标时拒绝手动触发。
  if (noticeConfig === undefined) {
    throw new failureModule.Failure(400, '请配置 owner_target 或 owner_targets，以及 public_url');
  }

  //M 显式指定机器人时，先查专属目标表，再核对默认目标是否同名。
  if (bot !== undefined) {
    const dedicated = noticeConfig.byBot.get(bot);
    if (dedicated !== undefined) return { notice: dedicated, scopedBot: bot };

    const fallback = noticeConfig.default;
    if (fallback !== undefined && fallback.bot === bot) return { notice: fallback };

    throw new failureModule.Failure(400, `未找到机器人「${bot}」的通知目标`);
  }

  //M 未指定机器人时，优先沿用默认目标。
  if (noticeConfig.default !== undefined) return { notice: noticeConfig.default };

  //M 未设默认目标但只有一项专属目标时，自动使用该项。
  if (noticeConfig.byBot.size === 1) {
    const only = noticeConfig.byBot.values().next().value;
    if (only !== undefined) return { notice: only, scopedBot: only.bot };
  }

  //G 多机器人且未设默认目标时，要求调用方显式指定 bot。
  throw new failureModule.Failure(400, '已配置多个机器人通知目标且未设默认 owner_target，请传 bot 指定提醒机器人');
}

/** 判断本次写入是否产生新待定项，按节点归属机器人去重后分别排发提醒。 */
export function notifyNew(
  ctx: cordis.Context,
  noticeConfig: OwnerNoticeConfig | undefined,
  graph: types.DecisionGraph,
  changes: readonly types.DecisionTaskChange[],
): void {
  if (noticeConfig === undefined) return;

  //G 只通知这批新开或重新打开的待定事项。
  const opened = new Set(changes.filter((task) => task.status === 'open').map((task) => task.node));
  const newPending = graph.nodes.filter((node) => node.kind === 'pending' && opened.has(node.id));
  if (newPending.length === 0) return;

  //M 逐个节点按 node.bot 匹配通知目标，并按发件机器人名去重。
  const matched = new Map<string, ResolvedNotice>();
  for (const node of newPending) {
    const resolved = getNoticeForNode(noticeConfig, node.bot);
    if (resolved === undefined) continue;

    const existing = matched.get(resolved.notice.bot);
    if (existing === undefined) {
      matched.set(resolved.notice.bot, resolved);
      continue;
    }

    //M 同一机器人同时命中专属节点与回落节点时，按全局待定件数合并提醒。
    if (resolved.scopedBot === undefined) {
      existing.scopedBot = undefined;
    }
  }
  if (matched.size === 0) return;

  //M 决策在此之前已经落库。通知不挡住外部请求或会话的工具执行。
  for (const entry of matched.values()) {
    void notify(ctx, entry.notice, graph, undefined, entry.scopedBot).then((result) => {
      if (result.status === 'sent' || result.status === 'draft') return;

      console.error(`work-decision：主人提醒未确认（${entry.notice.bot}），${result.status}`);
    }).catch(() => {
      console.error(`work-decision：主人提醒处理失败（${entry.notice.bot}）`);
    });
  }
}

/** 汇总当前待定项，通过标准渠道发送并收回执。 */
export async function notify(
  ctx: cordis.Context,
  notice: OwnerNotice,
  graph: types.DecisionGraph,
  key?: string,
  scopedBot?: string,
) {
  //M 统计当前各项目待定件数；多机器人并存时为专属机器人顺带标明其待定件数。
  const openPending = graph.nodes.filter((node) => node.kind === 'pending' && node.status === 'open');
  const pending = openPending.length;
  let headline = `工作决策有 ${String(pending)} 件等你定`;
  if (scopedBot !== undefined) {
    const botPending = openPending.filter((node) => node.bot === scopedBot).length;
    if (botPending !== pending) {
      headline = `工作决策有 ${String(pending)} 件等你定（${scopedBot} ${String(botPending)} 件）`;
    }
  }

  const url = new URL(notice.url);
  const server = ctx.resources.raw['server'];
  //M 用当前服务令牌生成手机可打开的链接。
  const token = utils.getStringField(server, 'token');
  if (token !== '') {
    //M 仅把登录令牌交给配置的收件地址，返回值和日志只带发送结果。
    url.searchParams.set('token', token);
  }
  const text = `${headline}\n${url.href}`;
  const suffix = key ?? String(graph.revision);
  //M 去重键带机器人名，避免同一修订号向多个机器人并发提醒时撞键。
  const replyRoundKey = `work-decision:notice:${notice.bot}:${suffix}`;
  const from = { bot: notice.bot, target: notice.target, replyRoundKey };
  const options = { kind: 'final' as const, replyIndex: 0, replyRequestKey: replyRoundKey };

  //M 主路线统一的渠道回复负责选路和同键重投。
  const receipt = await channel.requestTextReply(ctx, from, text, options);
  return { pending, status: receipt.status };
}


/**
 * 按优先级解析唤醒目标中控时使用的机器人名：
 * 请求显式 notifyBot > 配置 helper_bots[helper] > broadcast_target.bot > owner_target / 单项 owner_targets。
 * @param notifyHelper 目标外部助手名。
 * @param notifyBot 请求传入的可选机器人名。
 * @param dispatchConfig 控制面唤醒与播报配置。
 * @returns 解析出的机器人名；全部缺省时返回 undefined。
 */
export function resolveWakeupBot(
  notifyHelper: string,
  notifyBot: string | undefined,
  dispatchConfig: ControlDispatchConfig,
): string | undefined {
  //M 请求显式指定 notifyBot 时优先采用。
  if (notifyBot !== undefined) return notifyBot;

  //M 其次按配置的 helper_bots 映射表解析目标机器人。
  const helperBots: ReadonlyMap<string, string> = dispatchConfig.helperBots;
  const mapped = helperBots.get(notifyHelper);
  if (mapped !== undefined) return mapped;

  //M 未配 helper_bots 时优先兜底使用配置的作战室机器人。
  if (dispatchConfig.broadcastTarget !== undefined) return dispatchConfig.broadcastTarget.bot;

  //M 仍缺省时回落默认 owner_target 或唯一的 owner_targets 条目。
  const notice = dispatchConfig.noticeConfig;
  if (notice?.default !== undefined) return notice.default.bot;

  if (notice !== undefined && notice.byBot.size === 1) {
    const only = notice.byBot.values().next().value;
    if (only !== undefined) return only.bot;
  }
  return undefined;
}


/** 剥离文本中可能混入的飞书 <at> 标签，保留人名纯文本。 */
function stripAtTags(raw: string): string {
  return raw
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/giu, '$1')
    .replace(/<\/?at\b[^>]*>/giu, '');
}


/**
 * 通过既有 work-decision/note 事件向目标中控的 relay 收件箱投递一次性单向唤醒。
 * 绝不阻塞或抛错阻断任务主写入，失败仅记日志并返回结构化状态。
 */
async function sendTaskWakeup(
  ctx: cordis.Context,
  dispatchConfig: ControlDispatchConfig,
  input: TaskDispatchInput,
  helper: string,
): Promise<types.WakeupNotificationResult> {
  //M 解析本次单向唤醒归属的机器人名，供 relay 与调用方回执展示。
  const bot = resolveWakeupBot(helper, input.notifyBot, dispatchConfig);
  const head = `[控制面单向唤醒 · 任务 ${input.task.id}] 来自 ${input.actor}`;
  const subject = `（状态：${input.statusLabel}）：${input.task.title}`;
  const lines = [
    `${head}${subject}`,
    `进展：${input.eventText}`,
    '（本消息为面板单向唤醒，处理完请回写控制面，勿在群内互 @ 循环）',
  ];
  const nodeKey = `cp:${input.task.id}#rev:${String(input.revision)}`;
  const targetNode = `${types.CONTROL_WAKEUP_TARGET_PREFIX}${input.task.id}`;
  const relay: events.StripEnvelope<DecisionRelayRequest> = {
    action: 'deliver',
    node: nodeKey,
    helper,
    text: lines.join('\n'),
    target: { node: targetNode },
  };
  if (bot !== undefined) {
    relay.bot = bot;
  }

  const buildFailure = (reason: string): types.WakeupNotificationResult => {
    const failed: types.WakeupNotificationResult = { ok: false, helper, reason };
    if (bot !== undefined) {
      failed.bot = bot;
    }
    return failed;
  };

  try {
    //M 复用既有 work-decision/note 请求-回执事件写入目标 helper 的 relay 收件箱（maxHops=1 防循环）。
    const asked = await events.requestEvent(ctx, 'work-decision/note', 'work-decision/note-result', relay);
    if (asked.why === 'unhandled') {
      console.error(`work-decision：控制面单向唤醒失败（${helper}），未挂载 relay 处理监听`);
      //M 返回未挂载 relay 的温和失败回执。
      return buildFailure('未挂载 relay 插件或无人处理 work-decision/note');
    }
    if (asked.why !== undefined) {
      const reason = asked.detail ?? asked.why;
      console.error(`work-decision：控制面单向唤醒异常（${helper}），${reason}`);
      //M 返回 relay 事件异常回执。
      return buildFailure(reason);
    }
    if (!asked.reply.ok) {
      const reason = asked.reply.error ?? 'relay 投递未成功';
      console.error(`work-decision：控制面单向唤醒被拒（${helper}），${reason}`);
      //M 返回 relay 拒收原因。
      return buildFailure(reason);
    }
    const result: types.WakeupNotificationResult = { ok: true, helper };
    if (bot !== undefined) {
      result.bot = bot;
    }
    if (asked.reply.id !== undefined) {
      result.relayId = asked.reply.id;
    }
    return result;
  } catch (error) {
    //M 捕获未预期异常并温和降级返回，绝不影响控制面任务写盘。
    const reason = textModule.getErrorMessage(error);
    console.error(`work-decision：控制面单向唤醒出错（${helper}），${reason}`);
    //M 构造包含异常摘要的失败状态。
    return buildFailure(reason);
  }
}


/**
 * 向配置的作战室群发送 2–3 行不带 <at> 标签的精炼纯文本战报。
 * 未配置 broadcast_target 时温和返回 { ok: false, reason: '未配置 broadcast_target' }。
 */
async function broadcastTaskReport(
  ctx: cordis.Context,
  broadcastTarget: BroadcastTarget | undefined,
  input: TaskDispatchInput,
): Promise<types.BroadcastNotificationResult> {
  //G 未配置作战室目的地时温和降级，不报错不阻断任务更新。
  if (broadcastTarget === undefined) {
    return { ok: false, reason: '未配置 broadcast_target' };
  }

  //M 剥离潜在 <at> 标签拼出纯文本战报正文，并按是否带 notifyHelper 附带单向唤醒尾注。
  const cleanActor = stripAtTags(input.actor);
  //M 清洗任务标题中的潜在 <at> 标签。
  const cleanTitle = stripAtTags(input.task.title);
  //M 清洗进展正文中的潜在 <at> 标签。
  const cleanEvent = stripAtTags(input.eventText);
  let detailLine = cleanEvent;
  if (input.notifyHelper !== undefined) {
    //M 清洗唤醒助手名后附在战报末尾。
    const cleanHelper = stripAtTags(input.notifyHelper);
    detailLine = `${detailLine} → 已单向唤醒 ${cleanHelper}`;
  }
  const header = `📋 [控制面战报] ${cleanActor} 更新「${cleanTitle}」（${input.statusLabel}）`;
  const text = `${header}\n${detailLine}`;

  const suffix = `${input.task.id}:${String(input.revision)}:${crypto.randomUUID()}`;
  const replyRoundKey = `work-decision:broadcast:${suffix}`;
  const target: targetModule.ChannelReplyTarget = {
    channel: broadcastTarget.channel,
    chat: broadcastTarget.chatId,
  };
  const from: channel.ReplyFrom = {
    bot: broadcastTarget.bot,
    target,
    replyRoundKey,
  };
  const options = {
    kind: 'final' as const,
    replyIndex: 0,
    replyRequestKey: replyRoundKey,
  };
  const baseResult = {
    channel: broadcastTarget.channel,
    bot: broadcastTarget.bot,
    chatId: broadcastTarget.chatId,
  };

  try {
    //M 复用标准 channel/reply 渠道协议发送作战室战报。
    const receipt = await channel.requestTextReply(ctx, from, text, options);
    if (receipt.ok) {
      const sent: types.BroadcastNotificationResult = {
        ok: true,
        ...baseResult,
        status: receipt.status,
      };
      if (receipt.messageIds !== undefined) {
        sent.messageIds = receipt.messageIds;
      }
      return sent;
    }
    const reason = receipt.reason ?? receipt.status;
    console.error(`work-decision：作战室战报未送达（${broadcastTarget.chatId}），${reason}`);
    return { ok: false, ...baseResult, status: receipt.status, reason };
  } catch (error) {
    //M 捕获渠道发送异常并记录诊断日志，不阻断控制面主写入。
    const reason = textModule.getErrorMessage(error);
    console.error(`work-decision：作战室战报发送异常（${broadcastTarget.chatId}），${reason}`);
    return { ok: false, ...baseResult, reason };
  }
}


/**
 * 在控制面任务写盘后并发触发可选的单向唤醒（notifyHelper）与作战室战报播报（broadcast）。
 * @param ctx 插件 Cordis 上下文。
 * @param dispatchConfig 启动时解析的控制面通知路由配置。
 * @param input 已落盘任务及本次变更上下文。
 * @returns 唤醒与播报回执汇总对象。
 */
export async function dispatchTaskNotifications(
  ctx: cordis.Context,
  dispatchConfig: ControlDispatchConfig,
  input: TaskDispatchInput,
): Promise<types.ControlTaskNotifications> {
  const result: types.ControlTaskNotifications = {};
  let wakeupTask: Promise<types.WakeupNotificationResult> | undefined;
  if (input.notifyHelper !== undefined) {
    //M 启动向目标中控 relay 收件箱的单向唤醒投递。
    wakeupTask = sendTaskWakeup(ctx, dispatchConfig, input, input.notifyHelper);
  }

  let broadcastTask: Promise<types.BroadcastNotificationResult> | undefined;
  if (input.broadcast) {
    //M 启动向配置作战室群发一行战报的渠道投递。
    broadcastTask = broadcastTaskReport(ctx, dispatchConfig.broadcastTarget, input);
  }

  if (wakeupTask !== undefined) {
    result.wakeup = await wakeupTask;
  }
  if (broadcastTask !== undefined) {
    result.broadcast = await broadcastTask;
  }
  return result;
}
