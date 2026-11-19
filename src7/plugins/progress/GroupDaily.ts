/** 按飞书群配置在本地时间派发每日进度，借用标准渠道回话与群记忆。 */
import type * as cordis from 'cordis';
import * as channel from '../../Channels.ts';
import type { SessionMeta } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import type { FeishuGroup } from '../feishu/index.ts';

/** 已在飞书配置入口校验的群和定时参数。 */
type GroupReport = NonNullable<FeishuGroup['daily']> & Pick<FeishuGroup, 'chatId' | 'name'>;

/** 延迟不到一整分钟的定时器仍跑这次，停机错过的整分钟不补。 */
const MINUTE_MS = 60_000;
const DAILY_SOURCE = 'daily-progress';
const DAILY_TOOLS = new Set(['memory_get', 'channel_reply']);


/** 取运行机器的本地时分及前后日，保持夏令时切换时按日历调度。 */
function getLocalTime(now: Date, days: number, hour: number, minute: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute);
}


/** 严格取未来的计划时刻，重启时跳过已经到点的当天任务。 */
export function getNextReportAt(now: Date, hour: number, minute: number): Date {
  //M 对照当天本地时钟，错过今天就等下一天。
  const today = getLocalTime(now, 0, hour, minute);
  if (today > now) return today;

  //M 今天的时间已过，明天同一时分再发。
  return getLocalTime(now, 1, hour, minute);
}


/** 按本地日历给记忆查询传日期和时间，不做 UTC 换算。 */
function getLocalDay(at: Date): string {
  const year = String(at.getFullYear());
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}


/** 构造同群标准来源并触发一次派发。不会直接发送飞书 API 请求。 */
export async function dispatchReport(ctx: cordis.Context, group: GroupReport, scheduledAt: Date): Promise<void> {
  //M 覆盖上一条定时消息发出后的汇报，夜间回复也能在第二天纳入总结。
  const yesterday = getLocalTime(scheduledAt, -1, group.hour, group.minute);
  const day = getLocalDay(scheduledAt);
  const priorDay = getLocalDay(yesterday);
  const hour = String(group.hour).padStart(2, '0');
  const minute = String(group.minute).padStart(2, '0');
  const slot = hour + ':' + minute;
  const since = priorDay + ' ' + slot;
  const until = day + ' ' + slot;
  const heading = '【群进度定时任务 ' + until + '】';
  const instructions = [
    heading + ' 这条消息由系统发起。',
    '先用 memory_get 查本群记录，不给 ref，since 设为 ' + since + '，until 设为 ' + until + '，limit 设为 200。',
    '按成员实际汇报归纳今天的项目进度，昨晚的补充注明日期。忽略其他定时提示与机器人回复。',
    '根据配置列出的应汇报成员找出未汇报的人，使用 @群名片姓名。没有明确名单就说明，避免猜测。',
    '列出明天的安排。用 channel_reply 在本群发一条汇总，保留下面的项目要求。',
    group.prompt,
  ];
  const text = instructions.join('\n');
  const nativeId = DAILY_SOURCE + ':' + group.chatId + ':' + day;
  const accountId = group.appId;
  const chatId = group.chatId;
  const scope = 'feishu:' + accountId + ':' + chatId;
  const scheduled = DAILY_SOURCE;
  const customer = 'feishu:group:' + chatId + ':' + scheduled + ':' + accountId + ':' + day;
  const address = {
    appId: accountId, chatId, chatType: 'group', chatName: group.name, customer, messageId: '', openId: '',
    owner: false, role: 'guest', trusted: false, scheduled,
  };
  //M 使用群级非本人来源，即使该群的普通本人来话受信，也只会查当前群归属。
  const messageId = channel.makeChannelMessageId('feishu', accountId, nativeId);
  const createdAt = scheduledAt.getTime();
  const receivedAt = Date.now();
  const bot = group.bot;
  const front = { bot, kind: 'front', customer };
  //M 单开当天的前台轮，避免沿用群聊旧会话中受信本人查询过的工具结果。
  const existing = ctx.sessions.find(front)[0];
  const sessionId = existing?.id ?? ctx.sessions.create(front).id;
  const message: channel.ChannelMessage = {
    v: 1, messageId, nativeId, channel: 'feishu', accountId, chatId, chatType: 'group',
    sender: { id: scheduled, name: '群进度定时任务' }, role: 'guest', targetBots: [group.bot], mentions: [],
    rawText: heading, text, attachments: [], createdAt, receivedAt, timeSource: 'received', replyTo: null,
    origin: { channel: 'feishu', address }, visibility: { scope, trusted: false, publicSourceIds: [] },
    routing: { listenOnly: false, autoFinal: true, sessionId },
  };
  const control: channel.ChannelMessageControl = { claims: [] };
  //M 从现有渠道入口让目标机器人认领，回复沿用原群的飞书地址。
  await ctx.serial('channel/message', message, control);
}


/** 判断本轮标准来源是否为群进度定时消息。 */
function isReportRound(row: SessionMeta): boolean {
  const source = row.frontTask?.sourceSnapshot ?? row.activeSourceSnapshot;
  return source?.origin.address['scheduled'] === DAILY_SOURCE;
}


/** 仅给日报轮开放本群检索和回复工具。 */
export function bindReportTools(ctx: cordis.Context): void {
  //M 模型只看到它能用的群内工具，普通聊天保持原清单。
  ctx.on('session/before-model', (request) => {
    if (!isReportRound(request.session.row)) return;

    request.tools = request.tools.filter((tool) => DAILY_TOOLS.has(tool.name));
  });
  ctx.on('session/before-tool', (gate) => {
    //G 只拦日报轮中超出本群检索与回复用途的工具。
    if (!isReportRound(gate.session.row) || DAILY_TOOLS.has(gate.call.name)) return;

    //G 即使模型输出未提供的工具名，执行关口也限定这个群的查和发。
    gate.deny = '群进度定时任务只能查询和回复本群消息';
  });
}


/** 根据登记的群挂时钟，插件卸载时取消尚未触发的日程。 */
export function setupGroupReports(ctx: cordis.Context, groups: Iterable<FeishuGroup>): void {
  for (const group of groups) {
    const daily = group.daily;
    if (daily === undefined) continue;

    const report = { ...daily, chatId: group.chatId, name: group.name };
    ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout>;
      const schedule = (): void => {
        //M 用本地日历计算下一次，只安排登记群的下一次机会。
        const now = new Date();
        const at = getNextReportAt(now, report.hour, report.minute);
        const delay = at.getTime() - now.getTime();
        timer = setTimeout(() => {
          const late = Date.now() - at.getTime();
          //M 先安排后一天，单次耗时或失败不会中断后续定时。
          schedule();
          if (late < 0 || late >= MINUTE_MS) return;

          //M 只执行仍在预定分钟内的群任务，房间归属来自已校验配置。
          void dispatchReport(ctx, report, at).catch((error: unknown) => {
            const reason = textModule.getErrorMessage(error);
            console.error('群进度定时任务失败 ' + report.chatId + '：' + reason);
          });
        }, delay);
        timer.unref();
      };
      //M 启动本群定时器，拔掉 progress 或飞书时一并撤销。
      schedule();
      return () => clearTimeout(timer);
    });
  }
}
