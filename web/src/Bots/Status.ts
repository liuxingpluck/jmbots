/**
 * 机器人状态框的文字和颜文字（docs/界面/01_界面设计.md 第 6 节）。纯数据和纯函数；画出来在 Sprite.tsx。
 * 优先级（后端算好的）：有待确认 → 等待中；有运行中的会话 → 正在干活；有消息排队 → 等待中；都没有 → 休闲中。
 * 连不上后端时网页自己显示休假中。
 */
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 显示出来的状态：后端给的三种，加上连不上时的 off。 */
export type ShownStatus = types.BotStatus | 'off';


/** 一种状态的样子。 */
export interface StatusLook {
  /** 文字。 */
  label: string;
  /** 颜文字的几帧：一帧的不动；多帧的轮着显示（正在干活像在敲键盘）。 */
  frames: string[];
  /** 颜色用主题里的哪个（CSS 变量名去掉 --jm- 前缀）。 */
  tone: 'warning' | 'success' | 'muted' | 'accent';
}


/** 每种状态的样子。 */
export const STATUS_LOOKS: Record<ShownStatus, StatusLook> = {
  waiting: { label: '等待中', frames: ['(・ω・)'], tone: 'warning' },
  working: { label: '正在干活', frames: ['(๑•̀ㅂ•́)و', '(๑•̀ㅁ•́)ง'], tone: 'success' },
  idle: { label: '休闲中', frames: ['(￣▽￣)'], tone: 'accent' },
  off: { label: '休假中', frames: ['(－_－) zzZ'], tone: 'muted' },
};


/**
 * 显示哪种状态。
 * @param online 连得上后端吗。
 * @param bot 后端给的机器人；还没拿到是 undefined。
 */
export function shownStatus(online: boolean, bot: types.BotView | undefined): ShownStatus {
  if (!online || !bot) {
    return 'off';
  }
  return bot.status;
}


/**
 * 状态框里跟在状态后面的短说明（第 6 节）。
 * @param status 显示的状态。
 * @param bot 后端给的机器人。
 * @param t 翻译函数；不传是简体中文原文。
 */
export function statusShort(status: ShownStatus, bot: types.BotView | undefined, t: i18n.Translate = i18n.source): string {
  if (status === 'off' || !bot) {
    return t('连不上');
  }
  if (bot.approvals > 0) {
    return t('{count} 条要确认', { count: bot.approvals });
  }
  if (bot.running > 0) {
    return t('{count} 个会话', { count: bot.running });
  }
  if (bot.queued > 0) {
    return t('{count} 条排队', { count: bot.queued });
  }
  return t('等你吩咐');
}


/**
 * 状态框的完整说明（鼠标放上去看）：为什么是这个状态。
 * @param status 显示的状态。
 * @param bot 后端给的机器人。
 * @param t 翻译函数；不传是简体中文原文。
 */
export function statusDetail(status: ShownStatus, bot: types.BotView | undefined, t: i18n.Translate = i18n.source): string {
  if (status === 'off' || !bot) {
    return t('连不上后端');
  }
  if (bot.approvals > 0) {
    return t('{count} 条命令等你确认', { count: bot.approvals });
  }
  if (bot.running > 0) {
    return t('{count} 个会话在跑', { count: bot.running });
  }
  if (bot.queued > 0) {
    return t('{count} 条消息在排队', { count: bot.queued });
  }
  return '';
}
