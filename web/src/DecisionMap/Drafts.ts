/** 按节点在 localStorage 持久化直达中控的输入草稿，刷新页面或切换视图都不丢字。 */
import * as react from 'react';

/** 草稿字典在 localStorage 中的存储键。 */
export const DRAFTS_KEY = 'jmbots.decision-map.drafts';

/** 本页组件间的草稿变化监听集合。 */
const listeners = new Set<() => void>();

/**
 * 安全读取整个草稿字典。
 * @returns 节点号到草稿文本的映射；不可读时返回空对象。
 */
function loadDraftMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    if (raw === null || raw === '') return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string' && val !== '') {
        out[key] = val;
      }
    }
    return out;
  } catch {
    //G 隐私模式或存储损坏时退回空草稿，不阻断工作台渲染。
    return {};
  }
}

/**
 * 读取指定节点的未发送草稿。
 * @param nodeId 节点号。
 * @returns 保存的草稿文本；没有时返回空串。
 */
export function readDraft(nodeId: string): string {
  if (nodeId === '') return '';

  const map = loadDraftMap();
  return map[nodeId] ?? '';
}

/**
 * 保存或清除指定节点的草稿，并通知同页输入框同步。
 * @param nodeId 节点号。
 * @param text 最新输入内容；空串会移除该节点条目。
 */
export function writeDraft(nodeId: string, text: string): void {
  if (nodeId === '') return;

  const map = loadDraftMap();
  if (text === '') {
    delete map[nodeId];
  }
  if (text !== '') {
    map[nodeId] = text;
  }
  try {
    const keys = Object.keys(map);
    if (keys.length === 0) {
      window.localStorage.removeItem(DRAFTS_KEY);
    }
    if (keys.length > 0) {
      window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(map));
    }
  } catch {
    //G 本地存储写满或禁用时忽略持久化异常，内存监听仍照常更新。
  }
  for (const listener of listeners) {
    listener();
  }
}

/**
 * 判断当前是否还有任意节点的非空白草稿（用于新版上线时不强行刷新打断输入）。
 * @returns 任一节点有非空白草稿返回 true。
 */
export function hasAnyDraft(): boolean {
  const map = loadDraftMap();
  for (const val of Object.values(map)) {
    if (val.trim() !== '') return true;
  }
  return false;
}

/**
 * 绑定指定节点草稿的 React Hook，跨视图切换、抽屉与常驻栏实时共享同一份草稿。
 * @param nodeId 目标节点号。
 * @returns 当前草稿和更新函数。
 */
export function useNodeDraft(nodeId: string): [string, (next: string) => void] {
  const [draft, setDraftState] = react.useState(() => readDraft(nodeId));

  react.useEffect(() => {
    //M 切换目标节点或收到其他输入框/标签页同步时刷新当前草稿显示。
    const sync = (): void => {
      setDraftState(readDraft(nodeId));
    };
    sync();
    listeners.add(sync);
    window.addEventListener('storage', sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', sync);
    };
  }, [nodeId]);

  const setDraft = react.useCallback((next: string): void => {
    setDraftState(next);
    writeDraft(nodeId, next);
  }, [nodeId]);

  return [draft, setDraft];
}
