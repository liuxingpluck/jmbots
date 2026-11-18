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
    //M 拉取指定机器人的助手数据刷新模块小仓库，出错时重置为空集避免残留旧数据。
    data = await api.getJson<AssistData>(`/api/assist?bot=${encodeURIComponent(bot)}`);
  } catch {
    data = { reactions: [], asks: [], todos: [] };
  }
  for (const listener of listeners) listener();
}
/** 读仓库。 */
const useData = (): AssistData => react.useSyncExternalStore(subscribe, () => data, () => data);


/**
 * 每 2 秒取一次这个机器人的表情、卡片、待办。
 * @param bot 机器人；没有或 assist 插件未挂载时就不取。
 * @param enabled assist 插件有没有挂载。
 * @returns 无返回值。
 * 副作用：挂载或参数变化后每 2 秒轮询 GET /api/assist 并通知所有订阅组件刷新。
 */
export function usePoll(bot: string | null, enabled = true): void {
  react.useEffect(() => {
    if (!bot || !enabled) return undefined;

    //M 就绪后先立即拉一次，再按 2 秒周期轮询最新助手数据。
    void load(bot);
    const timer = window.setInterval(() => void load(bot), 2000);
    return () => window.clearInterval(timer);
  }, [bot, enabled]);
}


/**
 * 用户消息下面的小表情丸（机器人用 react 工具点的）。
 * @param props 消息号。
 * @returns 去重后的小表情元素；没有表情时返回 null。
 */
export function Reactions(props: { messageId: number }): react.JSX.Element | null {
  //M 从模块小仓库订阅表情列表并筛选出属于本条消息的反应。
  const all = useData().reactions.filter((item) => item.messageId === props.messageId);
  if (all.length === 0) return null;
  return <div className="jm-reactions">{[...new Set(all.map((item) => item.emoji))].map((emoji) => <span key={emoji} className="jm-reaction">{emoji}</span>)}</div>;
}


/**
 * 挂在这条消息上的选项卡片：点一个选项，就把它当作用户的回复发出去。
 * @param props 机器人、消息号、发出去以后刷新时间线。
 * @returns 选项卡片组；该消息没有选项卡片时返回 null。
 * 副作用：点击选项时调用后端记录答案并替用户发送消息，随后刷新本地仓库并弹出失败提示。
 */
export function Asks(props: { bot: string; messageId: number; onSent?: () => void }): react.JSX.Element | null {
  //M 订阅界面翻译并按消息号过滤选项卡片（最新的卡片排前面）。
  const t = i18n.useT();
  const asks = useData().asks.filter((item) => item.messageId === props.messageId).reverse();
  const [busy, setBusy] = react.useState(0);
  if (asks.length === 0) return null;
  /** 点了一个选项。 */
  const choose = async (ask: Ask, option: string): Promise<void> => {
    setBusy(ask.id);
    try {
      //M 先向后端登记选项答案，再把它作为用户消息发出并立即刷新助手仓库与时间线。
      await api.sendJson(`/api/assist/asks/${String(ask.id)}`, 'POST', { answer: option });
      await api.sendMessage({ text: option, bot: props.bot, uploads: [] });
      await load(props.bot);
      props.onSent?.();
    } catch (error) {
      let msg = String(error);
      if (error instanceof Error) {
        msg = error.message;
      }
      void antd.message.error(msg);
    } finally {
      setBusy(0);
    }
  };
  return (
    <>
      {asks.map((ask) => {
        let askClass = 'jm-ask';
        if (ask.answer !== undefined) {
          askClass = 'jm-ask jm-ask-done';
        }
        return (
          <div key={ask.id} className={askClass}>
            <div className="jm-ask-question">{ask.question}</div>
            <div className="jm-ask-options">
              {ask.options.map((option) => {
                let buttonType: 'primary' | 'default' = 'default';
                if (ask.answer === option) {
                  buttonType = 'primary';
                }
                //M 点击选项后调用 choose 提交答案并发送回复，已作答或提交中禁用按钮防止重复点击。
                return (
                  <antd.Button key={option} size="small" autoInsertSpace={false} type={buttonType}
                    disabled={ask.answer !== undefined || busy !== 0}
                    onClick={() => void choose(ask, option)}>
                    {option}
                  </antd.Button>
                );
              })}
            </div>
            {ask.answer !== undefined && <div className="jm-muted">{t('已选：{answer}', { answer: ask.answer })}</div>}
          </div>
        );
      })}
    </>
  );
}


/**
 * 右栏“待办”：只看当前打开的会话（及其后台子会话），最近改的在前。
 * @returns 待办面板元素。
 * 副作用：assist 插件挂载时每 2 秒轮询待办数据；点击清除待办时调用清理接口并刷新。
 */
export function TodoPanel(): react.JSX.Element {
  //M 读取翻译、当前机器人、焦点会话与插件挂载状态，仅在 assist 启用时轮询待办数据。
  const t = i18n.useT();
  const bot = context.useUi((state) => state.currentBot);
  const panelSessionId = context.useUi((state) => state.panelSessionId);
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const assistEnabled = api.isPluginMounted(mountedPlugins, 'assist', false);
  usePoll(bot, assistEnabled);
  const all = [...useData().todos].sort((a, b) => b.updatedAt - a.updatedAt);
  const focus = panelSessionId ?? all[0]?.sessionId ?? null;
  const focusRoot = all.find((item) => item.sessionId === focus)?.root ?? focus;
  let todos: typeof all = [];
  if (focus !== null) {
    todos = all.filter((item) => (item.root ?? item.sessionId) === focusRoot || item.sessionId === focus);
  }
  const mark = { todo: '○', doing: '◐', done: '●' } as const;
  const [busy, setBusy] = react.useState(false);
  /** 只清当前打开的会话及其派出的后台子会话。 */
  const clearCurrent = async (): Promise<void> => {
    if (!bot || !focus) return;
    setBusy(true);
    try {
      //M 清除当前焦点会话及派生子会话的待办，随后立刻重拉一次数据更新视图。
      await api.sendJson(`/api/assist/todos/clear?bot=${encodeURIComponent(bot)}&session=${encodeURIComponent(focus)}`, 'POST', {});
      await load(bot);
    } catch (error) {
      let msg = String(error);
      if (error instanceof Error) {
        msg = error.message;
      }
      void antd.message.error(msg);
    } finally {
      setBusy(false);
    }
  };
  //M 渲染待办工具栏（含清除按钮）、空态提示与各会话待办条目。
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
