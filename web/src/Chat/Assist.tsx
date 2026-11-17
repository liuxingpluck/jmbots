/**
 * 助手体验（docs/src7插件设计/助手体验对照.md）：消息下的小表情、选项卡片，右栏“待办”。
 * 数据来自 assist 插件的 GET /api/assist，ChatArea 里 usePoll 每 2 秒取一次，放在这个模块的小仓库里，各处按消息号取。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/** 一个表情。 */
interface Reaction { id: number; messageId: number | null; emoji: string }
/** 一张选项卡片。 */
interface Ask { id: number; messageId: number | null; question: string; options: string[]; answer?: string }
/** 一场会话的待办。 */
interface Todo { id: number; sessionId: string; root?: string; updatedAt: number; items: { text: string; status: 'todo' | 'doing' | 'done' }[] }
/** GET /api/assist 的回答。 */
interface AssistData { reactions: Reaction[]; asks: Ask[]; todos: Todo[] }


/** 小仓库：当前机器人的数据和订阅者。 */
let data: AssistData = { reactions: [], asks: [], todos: [] };
const listeners = new Set<() => void>();
/** 订阅仓库。 */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
/** 取一次，存进仓库，通知订阅者。没挂 assist 插件就一直是空的。 */
async function load(bot: string): Promise<void> {
  try {
    data = await api.getJson<AssistData>(`/api/assist?bot=${encodeURIComponent(bot)}`);
  } catch {
    data = { reactions: [], asks: [], todos: [] };
  }
  for (const listener of listeners) listener();
}
/** 读仓库。 */
const useData = (): AssistData => react.useSyncExternalStore(subscribe, () => data);


/**
 * 每 2 秒取一次这个机器人的表情、卡片、待办。
 * @param bot 机器人；没有就不取。
 */
export function usePoll(bot: string | null): void {
  react.useEffect(() => {
    if (!bot) return undefined;
    void load(bot);
    const timer = window.setInterval(() => void load(bot), 2000);
    return () => window.clearInterval(timer);
  }, [bot]);
}


/**
 * 用户消息下面的小表情丸（机器人用 react 工具点的）。
 * @param props 消息号。
 */
export function Reactions(props: { messageId: number }): react.JSX.Element | null {
  const all = useData().reactions.filter((item) => item.messageId === props.messageId);
  if (all.length === 0) return null;
  return <div className="jm-reactions">{[...new Set(all.map((item) => item.emoji))].map((emoji) => <span key={emoji} className="jm-reaction">{emoji}</span>)}</div>;
}


/**
 * 挂在这条消息上的选项卡片：点一个选项，就把它当作用户的回复发出去。
 * @param props 机器人、消息号、发出去以后刷新时间线。
 */
export function Asks(props: { bot: string; messageId: number; onSent?: () => void }): react.JSX.Element | null {
  const t = i18n.useT();
  const asks = useData().asks.filter((item) => item.messageId === props.messageId).reverse();
  const [busy, setBusy] = react.useState(0);
  if (asks.length === 0) return null;
  /** 点了一个选项。 */
  const choose = async (ask: Ask, option: string): Promise<void> => {
    setBusy(ask.id);
    try {
      await api.sendJson(`/api/assist/asks/${String(ask.id)}`, 'POST', { answer: option });
      await api.sendMessage({ text: option, bot: props.bot, uploads: [] });
      await load(props.bot);
      props.onSent?.();
    } catch (error) {
      void antd.message.error(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(0);
    }
  };
  return (
    <>
      {asks.map((ask) => (
        <div key={ask.id} className={ask.answer !== undefined ? 'jm-ask jm-ask-done' : 'jm-ask'}>
          <div className="jm-ask-question">{ask.question}</div>
          <div className="jm-ask-options">
            {ask.options.map((option) => (
              <antd.Button key={option} size="small" autoInsertSpace={false} type={ask.answer === option ? 'primary' : 'default'}
                disabled={ask.answer !== undefined || busy !== 0}
                onClick={() => void choose(ask, option)}>
                {option}
              </antd.Button>
            ))}
          </div>
          {ask.answer !== undefined && <div className="jm-muted">{t('已选：{answer}', { answer: ask.answer })}</div>}
        </div>
      ))}
    </>
  );
}


/** 右栏“待办”：只看当前打开的会话（及其后台子会话），最近改的在前。 */
export function TodoPanel(): react.JSX.Element {
  const t = i18n.useT();
  const bot = context.useUi((state) => state.currentBot);
  const panelSessionId = context.useUi((state) => state.panelSessionId);
  usePoll(bot);
  const all = [...useData().todos].sort((a, b) => b.updatedAt - a.updatedAt);
  const focus = panelSessionId ?? all[0]?.sessionId ?? null;
  const focusRoot = all.find((item) => item.sessionId === focus)?.root ?? focus;
  const todos = focus === null ? [] : all.filter((item) => (item.root ?? item.sessionId) === focusRoot || item.sessionId === focus);
  const mark = { todo: '○', doing: '◐', done: '●' } as const;
  const [busy, setBusy] = react.useState(false);
  /** 只清当前打开的会话及其派出的后台子会话。 */
  const clearCurrent = async (): Promise<void> => {
    if (!bot || !focus) return;
    setBusy(true);
    try {
      await api.sendJson(`/api/assist/todos/clear?bot=${encodeURIComponent(bot)}&session=${encodeURIComponent(focus)}`, 'POST', {});
      await load(bot);
    } catch (error) {
      void antd.message.error(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="jm-todo-panel">
      {todos.length > 0 && (
        <div className="jm-todo-toolbar">
          <antd.Button size="small" autoInsertSpace={false} disabled={busy} onClick={() => void clearCurrent()}>{t('清除待办')}</antd.Button>
        </div>
      )}
      {todos.length === 0 && <div className="jm-empty">{t('还没有待办：机器人干三步以上的活时会列在这里')}</div>}
      {todos.map((todo) => (
        <div key={todo.id} className="jm-todo">
          <div className="jm-muted">{t('会话 {id}', { id: todo.sessionId })} · {new Date(todo.updatedAt).toLocaleTimeString()}</div>
          {todo.items.map((item, index) => (
            <div key={index} className={`jm-todo-item jm-todo-${item.status}`}><span>{mark[item.status]}</span> {item.text}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
