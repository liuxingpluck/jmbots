/** AI工作台扩展视图集合：倒数纪念日大数字卡片、习惯近 7 天周历打卡与居中全局搜索弹窗。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as utils from './TickUtils.ts';

//==========================================================
// 1. 倒数纪念日视图（TickCountdownView）
//==========================================================

/** 倒数纪念日视图入参。 */
export interface TickCountdownViewProps {
  /** 全部任务数组（内部筛选 kind === 'countdown'）。 */
  tasks: readonly api.ControlTask[];
  /** 今日日期字符串 YYYY-MM-DD。 */
  todayStr: string;
  /** 创建纪念日回调。 */
  onCreateTask: (
    input: api.CreateControlTaskInput,
    toastText?: string,
  ) => Promise<api.ControlTask | undefined>;
  /** 彻底删除纪念日回调。 */
  onDeleteTask: (taskId: string) => Promise<void>;
}

/** 计算纪念日卡片展示的大数字与底部副文案。 */
function computeCountdownDisplay(
  task: api.ControlTask,
  todayStr: string,
): { days: number; subtitle: string; isPast: boolean } {
  const target = task.dueDate ?? todayStr;
  const rawDiff = utils.diffDays(todayStr, target);
  const fullZh = utils.formatFullDateZh(target);

  if (task.countdownMode === 'up') {
    const passed = Math.max(0, -rawDiff);
    return {
      days: passed,
      subtitle: `距离 ${fullZh} 已经`,
      isPast: true,
    };
  }
  if (rawDiff > 0) {
    return {
      days: rawDiff,
      subtitle: `距离 ${fullZh} 还有`,
      isPast: false,
    };
  }
  if (rawDiff === 0) {
    return {
      days: 0,
      subtitle: `${fullZh} · 就是今天`,
      isPast: false,
    };
  }
  return {
    days: Math.abs(rawDiff),
    subtitle: `距离 ${fullZh} 已经`,
    isPast: true,
  };
}

/** 倒数纪念日大数字卡片视图。 */
export function TickCountdownView(props: TickCountdownViewProps): react.JSX.Element {
  const { tasks, todayStr, onCreateTask, onDeleteTask } = props;

  const [adding, setAdding] = react.useState(false);
  const [title, setTitle] = react.useState('');
  const [dueDate, setDueDate] = react.useState(() => utils.addDaysStr(todayStr, 7));
  const [mode, setMode] = react.useState<api.TickCountdownMode>('down');
  const [icon, setIcon] = react.useState('⏳');
  const [confirmDeleteId, setConfirmDeleteId] = react.useState<string | undefined>(undefined);

  const countdowns = react.useMemo(() => {
    const list = tasks.filter((item) => {
      if (utils.isTaskTrashed(item)) return false;

      return utils.getTaskKind(item) === 'countdown';
    });
    return utils.sortTaskList(list, 'dueDate');
  }, [tasks]);

  /** 提交新建倒数纪念日。 */
  const handleCreate = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const cleaned = title.trim();
    if (cleaned === '' || dueDate === '') return;

    await onCreateTask(
      {
        title: cleaned,
        kind: 'countdown',
        dueDate,
        countdownMode: mode,
        icon,
        list: '收集箱',
        status: 'ready',
        by: 'boss',
      },
      `已添加纪念日「${cleaned}」`,
    );
    setTitle('');
    setAdding(false);
  };

  return (
    <section className="tick-extra-page" aria-label="倒数纪念日">
      <header className="tick-view-header">
        <div className="tick-view-header__left">
          <h2 className="tick-view-header__title">倒数纪念日</h2>
          <span className="tick-view-header__count">{String(countdowns.length)}</span>
        </div>
        <button
          type="button"
          className="tick-primary-btn"
          onClick={() => setAdding((prev) => !prev)}
        >
          {!adding && '+ 新建纪念日'}
          {adding && '收起表单'}
        </button>
      </header>

      {adding && (
        <form className="tick-inline-panel" onSubmit={(e) => void handleCreate(e)}>
          <div className="tick-emoji-strip">
            {utils.COUNTDOWN_ICON_CHOICES.map((ch) => (
              <button
                key={ch}
                type="button"
                className="tick-emoji-btn"
                data-active={icon === ch}
                onClick={() => setIcon(ch)}
              >
                {ch}
              </button>
            ))}
          </div>
          <div className="tick-inline-panel__row">
            <input
              type="text"
              className="tick-inline-panel__input"
              value={title}
              placeholder="例如：周末、春节、产品发布日…"
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              type="date"
              className="tick-inline-panel__date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            <select
              className="tick-inline-panel__select"
              value={mode}
              onChange={(e) => setMode(e.target.value as api.TickCountdownMode)}
            >
              <option value="down">倒数（还有 N 天）</option>
              <option value="up">累计（已经 N 天）</option>
            </select>
            <button type="submit" className="tick-primary-btn">
              创建
            </button>
          </div>
        </form>
      )}

      {countdowns.length === 0 && (
        <div className="tick-extra-empty">
          <div className="tick-extra-empty__art" aria-hidden="true">
            ⏳
          </div>
          <h3>记录每一个重要日子</h3>
          <p>支持目标日倒计时与里程碑累计天数，一目了然</p>
          <button
            type="button"
            className="tick-primary-btn"
            onClick={() => setAdding(true)}
          >
            + 添加第一个纪念日
          </button>
        </div>
      )}

      {countdowns.length > 0 && (
        <div className="tick-countdown-grid">
          {countdowns.map((item) => {
            const info = computeCountdownDisplay(item, todayStr);
            const confirming = confirmDeleteId === item.id;
            const iconText = item.icon ?? '⏳';
            return (
              <article key={item.id} className="tick-countdown-card">
                <div className="tick-countdown-card__actions">
                  {!confirming && (
                    <button
                      type="button"
                      className="tick-countdown-card__del"
                      title="删除纪念日"
                      aria-label={`删除 ${item.title}`}
                      onClick={() => setConfirmDeleteId(item.id)}
                    >
                      ×
                    </button>
                  )}
                  {confirming && (
                    <button
                      type="button"
                      className="tick-mini-btn tick-mini-btn--danger-solid"
                      onClick={() => {
                        setConfirmDeleteId(undefined);
                        void onDeleteTask(item.id);
                      }}
                    >
                      确认删
                    </button>
                  )}
                </div>

                <div className="tick-countdown-card__head">
                  <span className="tick-countdown-card__icon" aria-hidden="true">
                    {iconText}
                  </span>
                  <h3 className="tick-countdown-card__title">{item.title}</h3>
                </div>

                <div className="tick-countdown-card__number">{String(info.days)}</div>
                <p className="tick-countdown-card__sub">{info.subtitle}</p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

//==========================================================
// 2. 习惯周历打卡视图（TickHabitView）
//==========================================================

/** 习惯打卡视图入参。 */
export interface TickHabitViewProps {
  /** 全部任务数组（内部筛选 kind === 'habit'）。 */
  tasks: readonly api.ControlTask[];
  /** 今日日期字符串 YYYY-MM-DD。 */
  todayStr: string;
  /** 创建习惯回调。 */
  onCreateTask: (
    input: api.CreateControlTaskInput,
    toastText?: string,
  ) => Promise<api.ControlTask | undefined>;
  /** 切换某天打卡回调。 */
  onToggleCheckIn: (taskId: string, dateStr: string) => Promise<void>;
  /** 彻底删除习惯回调。 */
  onDeleteTask: (taskId: string) => Promise<void>;
}

/** 习惯近 7 天横向周历打卡视图。 */
export function TickHabitView(props: TickHabitViewProps): react.JSX.Element {
  const { tasks, todayStr, onCreateTask, onToggleCheckIn, onDeleteTask } = props;

  const [adding, setAdding] = react.useState(false);
  const [title, setTitle] = react.useState('');
  const [icon, setIcon] = react.useState('🔥');
  const [confirmDeleteId, setConfirmDeleteId] = react.useState<string | undefined>(undefined);

  const recentDays = react.useMemo(() => utils.getRecentDays(todayStr, 7), [todayStr]);

  const habits = react.useMemo(() => {
    const list = tasks.filter((item) => {
      if (utils.isTaskTrashed(item)) return false;

      return utils.getTaskKind(item) === 'habit';
    });
    return utils.sortTaskList(list, 'default');
  }, [tasks]);

  /** 提交新建习惯。 */
  const handleCreate = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const cleaned = title.trim();
    if (cleaned === '') return;

    await onCreateTask(
      {
        title: cleaned,
        kind: 'habit',
        icon,
        list: '收集箱',
        status: 'ready',
        checkIns: [],
        by: 'boss',
      },
      `已创建习惯「${cleaned}」`,
    );
    setTitle('');
    setAdding(false);
  };

  return (
    <section className="tick-extra-page" aria-label="习惯打卡">
      <header className="tick-view-header">
        <div className="tick-view-header__left">
          <h2 className="tick-view-header__title">习惯</h2>
          <span className="tick-view-header__count">{String(habits.length)}</span>
        </div>
        <button
          type="button"
          className="tick-primary-btn"
          onClick={() => setAdding((prev) => !prev)}
        >
          {!adding && '+ 新建习惯'}
          {adding && '收起表单'}
        </button>
      </header>

      {adding && (
        <form className="tick-inline-panel" onSubmit={(e) => void handleCreate(e)}>
          <div className="tick-emoji-strip">
            {utils.HABIT_ICON_CHOICES.map((ch) => (
              <button
                key={ch}
                type="button"
                className="tick-emoji-btn"
                data-active={icon === ch}
                onClick={() => setIcon(ch)}
              >
                {ch}
              </button>
            ))}
          </div>
          <div className="tick-inline-panel__row">
            <input
              type="text"
              className="tick-inline-panel__input"
              value={title}
              placeholder="例如：每日阅读 30 分钟、早起喝水、复盘…"
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
            <button type="submit" className="tick-primary-btn">
              创建习惯
            </button>
          </div>
        </form>
      )}

      {/* 近 7 天周历顶部日期条 */}
      <div className="tick-habit-weekbar">
        <div className="tick-habit-weekbar__lead">近 7 天打卡</div>
        <div className="tick-habit-days">
          {recentDays.map((day) => {
            let dayClass = 'tick-habit-day-head';
            if (day.isToday) {
              dayClass = 'tick-habit-day-head tick-habit-day-head--today';
            }
            return (
              <div key={day.dateStr} className={dayClass}>
                <span className="tick-habit-day-head__week">{day.weekday}</span>
                <span className="tick-habit-day-head__num">{String(day.dayNum)}</span>
              </div>
            );
          })}
        </div>
        <div className="tick-habit-weekbar__stat">累计</div>
      </div>

      {habits.length === 0 && (
        <div className="tick-extra-empty">
          <div className="tick-extra-empty__art" aria-hidden="true">
            ⏰
          </div>
          <h3>来一起养成习惯吧</h3>
          <p>坚持让我们闪闪发光</p>
          <button
            type="button"
            className="tick-primary-btn"
            onClick={() => setAdding(true)}
          >
            + 创建第一个习惯
          </button>
        </div>
      )}

      {habits.length > 0 && (
        <div className="tick-habit-list">
          {habits.map((habit) => {
            const checkSet = new Set(habit.checkIns ?? []);
            const totalCount = checkSet.size;
            const streak = utils.getHabitStreak(habit.checkIns, todayStr);
            const confirming = confirmDeleteId === habit.id;
            const iconText = habit.icon ?? '🔥';

            return (
              <div key={habit.id} className="tick-habit-row">
                <div className="tick-habit-row__info">
                  <span className="tick-habit-row__icon" aria-hidden="true">
                    {iconText}
                  </span>
                  <div className="tick-habit-row__meta">
                    <span className="tick-habit-row__title">{habit.title}</span>
                    {streak > 0 && (
                      <span className="tick-habit-row__streak">
                        已连续 {String(streak)} 天
                      </span>
                    )}
                  </div>
                </div>

                <div className="tick-habit-days">
                  {recentDays.map((day) => {
                    const checked = checkSet.has(day.dateStr);
                    let circleClass = 'tick-habit-circle';
                    if (checked) {
                      circleClass = 'tick-habit-circle tick-habit-circle--checked';
                    }
                    if (day.isToday && !checked) {
                      circleClass = 'tick-habit-circle tick-habit-circle--today';
                    }
                    return (
                      <button
                        key={day.dateStr}
                        type="button"
                        className={circleClass}
                        aria-label={`${habit.title} ${day.dateStr} 打卡`}
                        aria-pressed={checked}
                        onClick={() => void onToggleCheckIn(habit.id, day.dateStr)}
                      >
                        {checked && '✓'}
                      </button>
                    );
                  })}
                </div>

                <div className="tick-habit-row__stat">
                  <span className="tick-habit-row__total">{String(totalCount)} 天</span>
                  {!confirming && (
                    <button
                      type="button"
                      className="tick-habit-row__del"
                      title="删除习惯"
                      aria-label={`删除习惯 ${habit.title}`}
                      onClick={() => setConfirmDeleteId(habit.id)}
                    >
                      ×
                    </button>
                  )}
                  {confirming && (
                    <button
                      type="button"
                      className="tick-mini-btn tick-mini-btn--danger-solid"
                      onClick={() => {
                        setConfirmDeleteId(undefined);
                        void onDeleteTask(habit.id);
                      }}
                    >
                      确认删
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

//==========================================================
// 3. 居中深色全局搜索弹窗（TickSearchModal）
//==========================================================

/** 全局搜索弹窗入参。 */
export interface TickSearchModalProps {
  /** 全部任务数组。 */
  tasks: readonly api.ControlTask[];
  /** 全部可见清单列表。 */
  lists: readonly api.TaskListDef[];
  /** 今日日期字符串 YYYY-MM-DD。 */
  todayStr: string;
  /** 关闭搜索弹窗回调。 */
  onClose: () => void;
  /** 点击某条搜索到的任务回调（跳转清单并选中）。 */
  onJumpTask: (task: api.ControlTask) => void;
  /** 点击某条搜索到的清单回调（跳转打开清单）。 */
  onJumpList: (listName: string) => void;
}

/** 居中深色全局搜索模态窗（支持任务/清单胶囊切换）。 */
export function TickSearchModal(props: TickSearchModalProps): react.JSX.Element {
  const { tasks, lists, todayStr, onClose, onJumpTask, onJumpList } = props;

  const [query, setQuery] = react.useState('');
  const [scope, setScope] = react.useState<'task' | 'list'>('task');

  const trimmed = query.trim().toLowerCase();

  //M 匹配普通任务（标题、备注、标签、清单名）。
  const matchedTasks = react.useMemo(() => {
    if (trimmed === '') return [] as api.ControlTask[];

    return tasks
      .filter((item) => {
        if (utils.isTaskTrashed(item)) return false;
        if (utils.getTaskKind(item) !== 'task') return false;
        if (item.title.toLowerCase().includes(trimmed)) return true;
        if (item.summary.toLowerCase().includes(trimmed)) return true;
        if (utils.getTaskListName(item).toLowerCase().includes(trimmed)) return true;

        return (item.tags ?? []).some((tag) => tag.toLowerCase().includes(trimmed));
      })
      .slice(0, 30);
  }, [tasks, trimmed]);

  //M 匹配清单（含收集箱及所有清单）。
  const matchedLists = react.useMemo(() => {
    if (trimmed === '') return [] as api.TaskListDef[];

    const allLists: api.TaskListDef[] = [
      { id: 'sys-inbox', name: '收集箱', icon: '📥' },
      ...lists,
    ];
    return allLists.filter((item) => item.name.toLowerCase().includes(trimmed));
  }, [lists, trimmed]);

  return (
    <div className="tick-search-layer" role="dialog" aria-modal="true" aria-label="全局搜索">
      <div className="tick-search-mask" aria-hidden="true" onClick={onClose} />
      <div className="tick-search-card">
        <div className="tick-search-input-row">
          <span className="tick-search-input-row__icon" aria-hidden="true">
            🔍
          </span>
          <input
            type="text"
            className="tick-search-input"
            value={query}
            placeholder="搜索任务、备注、标签或清单…"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <button
            type="button"
            className="tick-icon-btn"
            aria-label="关闭搜索"
            onClick={() => {
              if (query !== '') {
                setQuery('');
                return;
              }
              onClose();
            }}
          >
            ✕
          </button>
        </div>

        <div className="tick-search-tabs" role="tablist" aria-label="搜索范围">
          <button
            type="button"
            role="tab"
            className="tick-search-pill"
            aria-selected={scope === 'task'}
            data-active={scope === 'task'}
            onClick={() => setScope('task')}
          >
            任务
          </button>
          <button
            type="button"
            role="tab"
            className="tick-search-pill"
            aria-selected={scope === 'list'}
            data-active={scope === 'list'}
            onClick={() => setScope('list')}
          >
            清单
          </button>
        </div>

        <div className="tick-search-body">
          {trimmed === '' && (
            <div className="tick-search-placeholder">
              <div className="tick-search-placeholder__icon" aria-hidden="true">
                🔭
              </div>
              <p>输入关键词即可搜索</p>
              <span>快捷键 Ctrl/Cmd + K 随时呼出，Esc 关闭</span>
            </div>
          )}

          {trimmed !== '' && scope === 'task' && matchedTasks.length === 0 && (
            <div className="tick-search-placeholder">
              <p>未找到与「{query.trim()}」匹配的任务</p>
            </div>
          )}

          {trimmed !== '' && scope === 'task' && matchedTasks.length > 0 && (
            <div className="tick-search-results">
              {matchedTasks.map((item) => {
                const quad = utils.getEffectiveQuadrant(item);
                const done = utils.isTaskDone(item);
                const listName = utils.getTaskListName(item);
                let dotClass = `tick-search-dot tick-search-dot--${quad}`;
                if (done) {
                  dotClass = 'tick-search-dot tick-search-dot--done';
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="tick-search-item"
                    onClick={() => onJumpTask(item)}
                  >
                    <span className={dotClass} aria-hidden="true" />
                    <span className="tick-search-item__title">{item.title}</span>
                    <span className="tick-search-item__meta">{listName}</span>
                    {item.dueDate !== undefined && item.dueDate !== null && item.dueDate !== '' && (
                      <span className="tick-search-item__due">
                        {utils.formatShortDate(item.dueDate, todayStr)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {trimmed !== '' && scope === 'list' && matchedLists.length === 0 && (
            <div className="tick-search-placeholder">
              <p>未找到与「{query.trim()}」匹配的清单</p>
            </div>
          )}

          {trimmed !== '' && scope === 'list' && matchedLists.length > 0 && (
            <div className="tick-search-results">
              {matchedLists.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  className="tick-search-item"
                  onClick={() => onJumpList(list.name)}
                >
                  <span className="tick-search-item__icon" aria-hidden="true">
                    {list.icon ?? '📋'}
                  </span>
                  <span className="tick-search-item__title">{list.name}</span>
                  <span className="tick-search-item__meta">打开清单 →</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
