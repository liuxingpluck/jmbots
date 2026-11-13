/**
 * 时间线的纯函数（docs/界面/01_界面设计.md 第 7.1、9 节）：一批消息和回复，不分会话，按时间排；
 * 用户的话、事件行（进了哪个会话）、机器人的回复各是一项。翻页和取变化拿到的消息按号合并。
 */
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 时间线上的一项。 */
export type TimelineItem =
  | { kind: 'user'; key: string; at: number; message: types.MessageView }
  | { kind: 'event'; key: string; at: number; message: types.MessageView; dispatch: types.DispatchBrief }
  | {
      /** 机器人已发送的回复。 */
      kind: 'reply';
      /** 在同一时间线中唯一，使用消息号和回复下标组成。 */
      key: string;
      /** 回复发送的时间，毫秒。 */
      at: number;
      /** 回复对应的原始收件。 */
      message: types.MessageView;
      /** 发出的回复。 */
      reply: types.ReplyView;
      /** 收件 replies 的真实下标，用于打开精确的回复追踪。 */
      replyIndex: number;
    }
  | { kind: 'note'; key: string; at: number; message: types.MessageView; text: string }
  | { kind: 'approval'; key: string; at: number; approval: types.ApprovalView };


/**
 * 把新拿到的消息并进已有的（同一个号用新的）。
 * @param old 已有的：号 → 消息。
 * @param incoming 新拿到的。
 * @returns 新的表（不改旧的）。
 */
export function mergeMessages(old: ReadonlyMap<number, types.MessageView>, incoming: types.MessageView[]): Map<number, types.MessageView> {
  /** 新表。 */
  const merged = new Map(old);
  for (const message of incoming) {
    merged.set(message.id, message);
  }
  return merged;
}


/**
 * 同一时刻排序用的号：消息按消息号；卡片排在后面。
 * @param item 这一项。
 */
function idOf(item: TimelineItem): number {
  return item.kind === 'approval' ? Number.MAX_SAFE_INTEGER : item.message.id;
}


/**
 * 程序写进会话的话（待确认的结果）不是用户说的，显示成灰字。
 * @param text 消息的原话。
 */
export function isSystemNote(text: string): boolean {
  return text.startsWith('（系统）') || text.startsWith('(system)');
}


/** 按真实消息号与回复下标生成局部 DOM 定位键，不依赖正文、时间或当前分页。 */
export function locateKey(message: types.MessageView, replyIndex: number | null): string {
  if (replyIndex !== null) {
    return `r${message.id}_${replyIndex}`;
  }
  return isSystemNote(message.text) ? `n${message.id}` : `m${message.id}`;
}


/**
 * 排成时间线：用户的话在它收到的时候，事件行紧跟在后面，回复在它发出的时候；待审核的卡片在它提出来的时候，翻上去也能点。
 * @param messages 消息（顺序不要紧）。
 * @param approvals 还在等决定的命令。
 */
export function buildTimeline(messages: Iterable<types.MessageView>, approvals: types.ApprovalView[] = []): TimelineItem[] {
  /** 每一项，带上排序用的次序（同一时刻：用户的话 → 事件 → 回复）。 */
  const items: { item: TimelineItem; order: number }[] = approvals.map((approval) => ({ item: { kind: 'approval', key: `a${approval.id}`, at: approval.createdAt, approval }, order: 3 }));
  for (const message of messages) {
    if (isSystemNote(message.text)) {
      items.push({ item: { kind: 'note', key: `n${message.id}`, at: message.createdAt, message, text: message.text }, order: 0 });
    } else {
      items.push({ item: { kind: 'user', key: `m${message.id}`, at: message.createdAt, message }, order: 0 });
    }
    if (message.dispatch) {
      items.push({ item: { kind: 'event', key: `e${message.id}`, at: message.createdAt, message, dispatch: message.dispatch }, order: 1 });
    }
    message.replies.forEach((reply, index) => {
      /** 回复目标由持久数组位置决定；即使正文、时间相同也不会串到另一句。 */
      const replyItem: TimelineItem = {
        kind: 'reply',
        key: `r${message.id}_${index}`,
        at: reply.at,
        message,
        reply,
        replyIndex: index,
      };

      items.push({ item: replyItem, order: 2 });
    });
  }
  return items
    .sort((a, b) => a.item.at - b.item.at || idOf(a.item) - idOf(b.item) || a.order - b.order)
    .map((entry) => entry.item);
}


/**
 * 来源的小标记。
 * @param channel 渠道：http，或 feishu:<应用 ID>。
 * @param source 来源：网页发的是 web。
 * @param t 翻译函数；不传是简体中文原文。
 */
export function channelLabel(channel: string, source: string, t: i18n.Translate = i18n.source): string {
  if (channel.startsWith('feishu')) {
    return t('飞书');
  }
  return source === 'web' ? t('网页') : 'HTTP';
}


/**
 * 模型 ID 写短一点：只留最后一段（供应商/分组/模型 → 模型）。
 * @param model 供应商/模型 ID。
 */
export function shortModel(model: string): string {
  return model.split('/').pop() ?? model;
}


/**
 * 事件行的文字。
 * @param dispatch 分派简要。
 * @param t 翻译函数；不传是简体中文原文。
 */
export function eventText(dispatch: types.DispatchBrief, t: i18n.Translate = i18n.source): string {
  /** 标题。 */
  const title = dispatch.title || dispatch.sessionId;
  if (dispatch.action === 'new') {
    return dispatch.model ? t('新开了会话「{title}」，用 {model}', { title, model: shortModel(dispatch.model) }) : t('新开了会话「{title}」', { title });
  }
  //M 追加不换模型，只写进了哪个会话。
  return t('进了会话「{title}」', { title });
}


/**
 * 消息还没进会话时的小字。
 * @param status 消息状态。
 * @param t 翻译函数；不传是简体中文原文。
 * @returns 已经进了会话是空。
 */
export function pendingText(status: string, t: i18n.Translate = i18n.source): string {
  if (status === 'new') {
    return t('等分派');
  }
  if (status === 'dispatching') {
    return t('分派中');
  }
  if (status === 'queued') {
    return t('排队中');
  }
  return '';
}


/**
 * 时间写成给人看的样子：今天的只写时分，别的写月日。
 * @param at 毫秒。
 * @param now 现在（测试用）。
 */
export function formatTime(at: number, now = Date.now()): string {
  /** 那个时刻。 */
  const date = new Date(at);
  /** 两位数。 */
  const two = (value: number): string => String(value).padStart(2, '0');
  /** 时分。 */
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return new Date(now).toDateString() === date.toDateString() ? time : `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`;
}


/**
 * 回复离那条消息过了多久，写成给人看的样子（用户 11-06：秒数，或 x 分钟 x 秒，或 x 小时 x 分 x 秒）。
 * @param ms 毫秒：回复的时刻减去消息收到的时刻。
 * @param t 翻译。
 * @returns 如“耗时 35 秒”；不到 1 秒是“耗时不到 1 秒”；时间对不上（负数、不是数）是空字符串。
 */
export function formatElapsed(ms: number, t: i18n.Translate = i18n.source): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  /** 一共几秒。 */
  const total = Math.round(ms / 1000);
  if (total < 1) {
    return t('耗时不到 1 秒');
  }
  /** 时、分、秒。 */
  const [hours, minutes, seconds] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  if (hours > 0) {
    return t('耗时 {hours} 小时 {minutes} 分 {seconds} 秒', { hours, minutes, seconds });
  }
  if (minutes > 0) {
    return t('耗时 {minutes} 分钟 {seconds} 秒', { minutes, seconds });
  }
  return t('耗时 {seconds} 秒', { seconds });
}
