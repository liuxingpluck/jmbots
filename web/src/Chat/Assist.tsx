/**
 * 助手体验（docs/src7插件设计/助手体验对照.md）：消息下的小表情、选项卡片，右栏“待办”。
 * 聊天区和右栏共用页面轮询取回的助手数据，表情与选项按消息号展示。
 * 卡片、待办、待办子项超过 30 条只画看得见的（Shared/LongList.tsx）；卡片的选项后端限 2～6 个，照旧逐个画。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as readingModule from '../Panel/Reading.ts';
import * as longList from '../Shared/LongList.tsx';
import type * as storeModule from '../Store.ts';


/** 一条消息下卡片多到虚拟化时占多高，像素；外面已是聊天的虚拟列表，这里自己滚。 */
const ASKS_HEIGHT = 320;

/** 一份待办子项多到虚拟化时占多高，像素。 */
const STEPS_HEIGHT = 320;

/** 两份待办之间的间距，像素；和 .jm-todo-panel 的 gap 一样。 */
const TODO_GAP = 12;


/** 切换机器人后还没取到该机器人数据时共用的空数据。 */
const EMPTY_ASSIST: storeModule.AssistData = { reactions: [], asks: [], todos: [] };


/** 订阅当前机器人的助手数据。 */
function useData(): storeModule.AssistData {
  //M 聊天区与右栏读同一份页面仓库，切换时只显示所选机器人的数据。
  return context.useUi((state) => {
    if (state.assist?.bot !== state.currentBot) return EMPTY_ASSIST;

    return state.assist ?? EMPTY_ASSIST;
  });
}


/**
 * 用户消息下面的小表情丸（机器人用 react 工具点的）。
 * @param props 消息号。
 * @returns 去重后的小表情元素；没有表情时返回 null。
 */
export function Reactions(props: { messageId: number }): react.JSX.Element | null {
  //M 从共享仓库订阅表情列表并筛选出属于本条消息的反应。
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
  const refreshAssist = context.useUi((state) => state.refreshAssist);
  const [busy, setBusy] = react.useState(0);
  if (asks.length === 0) return null;
  /** 点了一个选项。 */
  const choose = async (ask: storeModule.Ask, option: string): Promise<void> => {
    setBusy(ask.id);
    try {
      //M 先向后端登记选项答案，再把它作为用户消息发出并立即刷新助手仓库与时间线。
      await api.sendJson(`/api/assist/asks/${String(ask.id)}`, 'POST', { answer: option });
      await api.sendMessage({ text: option, bot: props.bot, uploads: [] });
      await refreshAssist(props.bot);
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
  /**
   * 画一张卡片：问题、选项按钮、已选的答案。
   * @param ask 选项卡片；由下面的 LongList 逐张传进来。
   */
  const renderAsk = (ask: storeModule.Ask): react.ReactNode => {
    let askClass = 'jm-ask';
    if (ask.answer !== undefined) {
      askClass = 'jm-ask jm-ask-done';
    }
    return (
      <div className={askClass}>
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
  };

  //M 一条消息下的卡片不到 30 张逐张画；多了在固定高度里只画看得见的。
  return (
    <longList.LongList
      items={asks}
      getKey={(ask) => ask.id}
      render={renderAsk}
      height={ASKS_HEIGHT}
    />
  );
}


/**
 * 右栏“待办”：只看当前打开的会话（及其后台子会话），最近改的在前。
 * @returns 待办面板元素。
 * 副作用：点击清除待办时调用清理接口并刷新共享数据。
 */
export function TodoPanel(): react.JSX.Element {
  //M 读取当前机器人和焦点会话，从共享数据中归并待办和提醒。
  const t = i18n.useT();
  const bot = context.useUi((state) => state.currentBot);
  const panelSessionId = context.useUi((state) => state.panelSessionId);
  const refreshAssist = context.useUi((state) => state.refreshAssist);
  const current = useData();
  const all = [...current.todos].sort((a, b) => b.updatedAt - a.updatedAt);
  const reminders = current.reminders ?? [];
  const focus = panelSessionId ?? all[0]?.sessionId ?? null;
  const focusRoot = all.find((item) => item.sessionId === focus)?.root ?? focus;
  let todos: typeof all = [];
  if (focus !== null) {
    todos = all.filter((item) => (item.root ?? item.sessionId) === focusRoot || item.sessionId === focus);
  }
  const mark = { todo: '○', doing: '◐', done: '●' } as const;
  const [busy, setBusy] = react.useState(false);
  /** 右栏的滚动容器（RightPanel 的 .jm-panel-body）；待办多时跟着它滚，不另起滚动条。 */
  const panelScroll = react.useContext(readingModule.PanelScrollContext);
  /** 只清当前打开的会话及其派出的后台子会话。 */
  const clearCurrent = async (): Promise<void> => {
    if (!bot || !focus) return;
    setBusy(true);
    try {
      //M 清除当前焦点会话及派生子会话的待办，随后立刻重拉一次数据更新视图。
      await api.sendJson(`/api/assist/todos/clear?bot=${encodeURIComponent(bot)}&session=${encodeURIComponent(focus)}`, 'POST', {});
      await refreshAssist(bot);
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
  /**
   * 画待办里的一项：状态圈和文字。
   * @param step 一项；由内层 LongList 逐项传进来。
   */
  const renderStep = (step: storeModule.TodoStep): react.ReactNode => (
    <div className={`jm-todo-item jm-todo-${step.status}`}><span>{mark[step.status]}</span> {step.text}</div>
  );

  /**
   * 画一份待办：哪场会话、几点改的，下面是各项；项多了在固定高度里只画看得见的。
   * @param todo 一份待办；由外层 LongList 逐份传进来。
   */
  const renderTodo = (todo: storeModule.Todo): react.ReactNode => (
    <div className="jm-todo">
      <div className="jm-muted">{t('会话 {id}', { id: todo.sessionId })} · {new Date(todo.updatedAt).toLocaleTimeString()}</div>
      <longList.LongList
        items={todo.items}
        getKey={(_step, index) => index}
        render={renderStep}
        height={STEPS_HEIGHT}
      />
    </div>
  );

  const reminderStates = {
    awaiting: t('等你确认'), pending: t('待提醒'), sending: t('正在发送'), sent: t('已提醒'),
    failed: t('发送失败'), uncertain: t('发送结果待核对'), cancelled: t('已取消'), rejected: t('已拒绝'),
  };
  const renderReminder = (reminder: storeModule.Reminder): react.ReactNode => (
    <div className="jm-todo">
      <div className="jm-muted">{reminder.at} {reminder.timeZone} · {reminderStates[reminder.state]}</div>
      <div className="jm-todo-item">{reminder.text}</div>
      {reminder.reason !== null && <div className="jm-muted">{reminder.reason}</div>}
    </div>
  );

  //M 渲染待办工具栏（含清除按钮）、空态提示与各会话待办条目；份数多了跟着右栏滚动只画看得见的。
  return (
    <div className="jm-todo-panel">
      {todos.length > 0 && (
        <div className="jm-todo-toolbar">
          <antd.Button size="small" autoInsertSpace={false} disabled={busy} onClick={() => void clearCurrent()}>{t('清除待办')}</antd.Button>
        </div>
      )}
      {todos.length === 0 && <div className="jm-empty">{t('还没有待办：机器人干三步以上的活时会列在这里')}</div>}
      <longList.LongList
        items={todos}
        getKey={(todo) => todo.id}
        render={renderTodo}
        gap={TODO_GAP}
        scrollParent={panelScroll}
      />
      {reminders.length > 0 && (
        <section aria-label={t('提醒')}>
          <h3>{t('提醒')}</h3>
          <longList.LongList
            items={reminders}
            getKey={(reminder) => reminder.id}
            render={renderReminder}
            gap={TODO_GAP}
            scrollParent={panelScroll}
          />
        </section>
      )}
    </div>
  );
}
