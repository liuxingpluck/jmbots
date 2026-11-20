/** 把待定件数和页面链接发给配置中的主人。 */
import type * as cordis from 'cordis';
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

/** 判断本次写入是否产生新待定项，有才排一次通知。 */
export function notifyNew(
  ctx: cordis.Context,
  notice: OwnerNotice | undefined,
  graph: types.DecisionGraph,
  changes: readonly types.DecisionTaskChange[],
): void {
  if (notice === undefined) return;

  //G 只通知这批新开或重新打开的待定事项。
  const opened = new Set(changes.filter((task) => task.status === 'open').map((task) => task.node));
  const hasNew = graph.nodes.some((node) => node.kind === 'pending' && opened.has(node.id));
  if (!hasNew) return;

  //M 决策在此之前已经落库。通知不挡住外部请求或会话的工具执行。
  void notify(ctx, notice, graph).then((result) => {
    if (result.status === 'sent' || result.status === 'draft') return;

    console.error(`work-decision：主人提醒未确认，${result.status}`);
  }).catch(() => {
    console.error('work-decision：主人提醒处理失败');
  });
}

/** 汇总当前待定项，通过标准渠道发送并收回执。 */
export async function notify(
  ctx: cordis.Context,
  notice: OwnerNotice,
  graph: types.DecisionGraph,
  key?: string,
) {
  //M 统计当前各项目待定件数，合并成一条主人提醒。
  const pending = graph.nodes.filter((node) => node.kind === 'pending' && node.status === 'open').length;
  const url = new URL(notice.url);
  const server = ctx.resources.raw['server'];
  //M 用当前服务令牌生成手机可打开的链接。
  const token = utils.getStringField(server, 'token');
  if (token !== '') {
    //M 仅把登录令牌交给配置的收件地址，返回值和日志只带发送结果。
    url.searchParams.set('token', token);
  }
  const text = `工作决策有 ${String(pending)} 件等你定\n${url.href}`;
  const replyRoundKey = `work-decision:notice:${key ?? String(graph.revision)}`;
  const from = { bot: notice.bot, target: notice.target, replyRoundKey };
  const options = { kind: 'final' as const, replyIndex: 0, replyRequestKey: replyRoundKey };

  //M 主路线统一的渠道回复负责选路和同键重投。
  const receipt = await channel.requestTextReply(ctx, from, text, options);
  return { pending, status: receipt.status };
}
