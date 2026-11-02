/**
 * “事件”页面的状态（zustand）：现在是不是在事件页、选中了哪个会话、会话列表、选中会话的全部原始记录。
 * 网址写法：`#/events`（还没选会话）、`#/events/<会话ID>`。选中状态以网址为准，刷新页面还在原来的会话。
 * 在事件页时每 2 秒刷新一次（页面在后台时不刷），执行中的会话每一步都能及时看到。
 * 浏览器监听和定时器在本文件加载时装一次。
 */
import * as zustand from 'zustand';
import * as api from './EventsApi.ts';


/** 事件页的状态和动作。 */
interface EventsState {
  /** 网址是不是 `#/events` 开头（App 据此显示事件页还是知识库）。 */
  active: boolean;
  /** 选中的会话 ID；没选时为 null。 */
  sessionId: string | null;
  /** 最近的会话。 */
  sessions: api.Session[];
  /** 选中会话的全部原始记录；还没取到时为 null。 */
  full: api.SessionFull | null;
  /** 最近一次刷新的错误；成功后清空。 */
  error: string | null;
  /** 刷新会话列表和选中会话。 */
  refresh: () => Promise<void>;
  /** 选中一个会话（写网址）。 */
  select: (sessionId: string) => void;
}


/** 事件页的 store；组件用 `useEventsStore((state) => state.xxx)` 取一块。 */
export const useEventsStore = zustand.create<EventsState>()((set, get) => ({
  ...parseHash(window.location.hash),
  sessions: [],
  full: null,
  error: null,
  refresh: async () => {
    /** 刷新开始时选中的会话；结果回来时已经换了会话，就丢掉这次的结果。 */
    const sessionId = get().sessionId;
    try {
      /** 会话列表和选中会话一起取。 */
      const [sessions, full] = await Promise.all([api.listSessions(), sessionId ? api.getSessionFull(sessionId) : Promise.resolve(null)]);
      // g: 等结果的时候换了会话，丢掉过时的结果。
      if (get().sessionId !== sessionId) {
        return;
      }
      set({ sessions, full, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  select: (sessionId) => {
    window.location.hash = `#/events/${encodeURIComponent(sessionId)}`;
  },
}));


/**
 * 解析网址：是不是事件页、选中了哪个会话。
 * @param hash 网址的 hash。
 */
function parseHash(hash: string): { active: boolean; sessionId: string | null } {
  /** hash 的各段：['events', 会话ID]。 */
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] !== 'events') {
    return { active: false, sessionId: null };
  }
  return { active: true, sessionId: parts[1] ? decodeURIComponent(parts[1]) : null };
}


/** 按网址更新 store；换了会话就先清掉旧的记录，再马上刷新。 */
function syncHash(): void {
  /** 网址解析出的状态。 */
  const next = parseHash(window.location.hash);
  /** 原来的状态。 */
  const previous = useEventsStore.getState();
  if (next.active === previous.active && next.sessionId === previous.sessionId) {
    return;
  }
  useEventsStore.setState({ ...next, full: next.sessionId === previous.sessionId ? previous.full : null });
  if (next.active) {
    void useEventsStore.getState().refresh();
  }
}


// m: 手改 hash、浏览器前进后退时同步；在事件页、页面在前台时每 2 秒刷新一次。
window.addEventListener('hashchange', syncHash);
window.addEventListener('popstate', syncHash);
window.setInterval(() => {
  if (useEventsStore.getState().active && document.visibilityState === 'visible') {
    void useEventsStore.getState().refresh();
  }
}, 2000);
