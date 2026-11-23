/** 把待定件数和页面链接发给配置中的主人。 */
import type * as cordis from 'cordis';
import * as failureModule from '../../utils/Failure.ts';
import * as utils from '../../utils/index.ts';
import * as channel from '../channels/Reply.ts';
import type * as targetModule from '../channels/Target.ts';
import type * as types from './Types.ts';

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
