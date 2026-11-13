/**
 * 审核卡片的规矩（docs/界面/01_界面设计.md 第 8 节），纯函数好测：这是用户替软硬审核做决定的地方，不能错按。
 *   - Enter 永远不会同意；两个按钮都不是默认按钮。
 *   - 卡片出现后 ARM_MS 内按钮不响应（防止正在点别处时误点）。
 *   - 键盘 Y、N 只在卡片有焦点时生效；输入框里打字时不触发。
 */
import * as i18n from '../I18n.ts';


/** 卡片出现后多久按钮才响应，毫秒。 */
export const ARM_MS = 1000;


/** 用户的决定。 */
export type Decision = 'approve' | 'reject';


/**
 * 按钮能不能按了。
 * @param shownAt 这张卡片出现的时间，毫秒。
 * @param now 现在，毫秒。
 */
export function isArmed(shownAt: number, now: number): boolean {
  return now - shownAt >= ARM_MS;
}


/**
 * 一次按键算不算决定。
 * @param key 按键（KeyboardEvent.key）。
 * @param inCard 焦点在不在卡片上（输入框里打字时是 false）。
 * @param armed 按钮能不能按了。
 * @param modified 按着 Ctrl、Alt、Meta 没有（按着时不算，免得和快捷键撞）。
 * @returns 决定；不算决定是 null。
 */
export function decisionForKey(key: string, inCard: boolean, armed: boolean, modified: boolean): Decision | null {
  //G 不在卡片上、还没能按、按着修饰键：都不算。Enter、空格永远不算。
  if (!inCard || !armed || modified) {
    return null;
  }
  if (key === 'y' || key === 'Y') {
    return 'approve';
  }
  if (key === 'n' || key === 'N') {
    return 'reject';
  }
  return null;
}


/**
 * 决定以后给用户看的话。
 * @param decision 决定。
 * @param status 接口的状态码（200 成功、404 已经处理过了）；连不上是 0。
 * @param t 翻译函数；不传是简体中文原文。
 */
export function decisionNotice(decision: Decision, status: number, t: i18n.Translate = i18n.source): string {
  if (status === 404) {
    return t('已经处理过了（飞书那边先点了，或者会话已经不等了）');
  }
  if (status >= 200 && status < 300) {
    return decision === 'approve' ? t('已同意执行') : t('已拒绝');
  }
  return status === 0 ? t('连不上后端，没决定成，等它回来再点') : t('没决定成（{status}），再点一次', { status });
}
