/**
 * 外置微信客服页自包含的演示打码开关与脱敏渲染函数。
 * 与主站共用 `jmbots.wechat.mask` 本地存储键，开启时仅在前端渲染层隐藏客户姓名与聊天内容。
 */
import * as react from 'react';
import * as locale from '../KefuLocale.ts';


/** 演示打码开关在 localStorage 中的持久化键名。 */
export const KEY = 'jmbots.wechat.mask';

/** 同页切换打码开关时的自定义通知事件名。 */
const CHANGE = 'jmbots-mask-change';


/**
 * 读取当前演示打码状态（仅明确写入 `'on'` 时视为开启）。
 */
export function getMask(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}


/**
 * 更新演示打码状态并向当前页广播变更事件。
 * @param enabled 为 true 时开启打码，false 时移除持久化键。
 */
export function setMask(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(KEY, 'on');
    }
    if (!enabled) {
      window.localStorage.removeItem(KEY);
    }
  } catch {
    // 浏览器禁用本地存储时保持静默。
  }
  //M 通知同页内订阅了打码状态的组件立即重绘。
  window.dispatchEvent(new Event(CHANGE));
}


/**
 * 订阅本页及同源标签页的打码开关变化。
 * @param notify 状态变更回调。
 */
function subscribe(notify: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === KEY || event.key === null) {
      //M 跨标签页改动打码键时触发订阅通知。
      notify();
    }
  };
  window.addEventListener(CHANGE, notify);
  window.addEventListener('storage', onStorage);
  window.addEventListener('pageshow', notify);
  return () => {
    window.removeEventListener(CHANGE, notify);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pageshow', notify);
  };
}


/**
 * React 组件订阅演示打码状态的 Hook。
 */
export function useMask(): boolean {
  //M 用 useSyncExternalStore 绑定本地存储与自定义事件。
  return react.useSyncExternalStore(subscribe, getMask, () => false);
}


/**
 * 对昵称或会话名脱敏：开启打码时仅保留首个 Unicode 字符加 `**`。
 * @param value 原始名称。
 * @param enabled 是否开启打码。
 */
export function name(value: string, enabled: boolean): string {
  if (!enabled || value === '') return value;

  const chars = Array.from(value);
  return `${chars[0] ?? ''}**`;
}


/**
 * 对消息正文或错误说明整段打码隐藏。
 * @param value 原始文本。
 * @param enabled 是否开启打码。
 */
export function text(value: string, enabled: boolean): string {
  if (!enabled || value === '') return value;

  //M 按当前页面语言返回本地化的“（已打码）”占位词。
  return locale.getLabels().maskedText;
}
