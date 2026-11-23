/** 滴答深色月视图日历：7 列网格、今日蓝圈高亮、彩色象限任务条与指定日期快捷添加。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as detail from './TickTaskDetail.tsx';
import * as utils from './TickUtils.ts';

/** 月视图日历入参。 */
export interface TickCalendarViewProps {
  /** 全部任务数组。 */
  tasks: readonly api.ControlTask[];
  /** 可见清单定义列表。 */
  lists: readonly api.TaskListDef[];
  /** 今日日期字符串 YYYY-MM-DD。 */
  todayStr: string;
  /** 当前选中的任务 ID（右侧滑板详情展示）。 */
  selectedTaskId: string | undefined;
  /** 选中或关闭任务详情回调。 */
  onSelectTask: (taskId: string | undefined) => void;
  /** 创建任务回调。 */
  onCreateTask: (
    input: api.CreateControlTaskInput,
    toastText?: string,
  ) => Promise<api.ControlTask | undefined>;
  /** 局部更新任务回调。 */
  onPatchTask: (
    taskId: string,
    patch: api.PatchControlTaskInput,
    toastText?: string,
  ) => Promise<void>;
  /** 彻底删除任务回调。 */
  onDeleteTask: (taskId: string) => Promise<void>;
  /** 追加 AI 协同事件回调。 */
  onAppendEvent: (
    taskId: string,
    text: string,
    kind: api.ControlTaskEventKind,
    options?: { notifyHelper?: string; broadcast?: boolean },
  ) => Promise<boolean>;
}

/** 日历表头星期名称（周日起）。 */
const CALENDAR_HEADERS: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 深色月视图日历组件。 */
export function TickCalendarView(props: TickCalendarViewProps): react.JSX.Element {
  const {
    tasks,
    lists,
    todayStr,
    selectedTaskId,
    onSelectTask,
    onCreateTask,
    onPatchTask,
    onDeleteTask,
    onAppendEvent,
  } = props;

  const todayDate = utils.parseDateStr(todayStr) ?? new Date();
  const [cursor, setCursor] = react.useState<{ year: number; month: number }>(() => ({
    year: todayDate.getFullYear(),
    month: todayDate.getMonth(),
  }));

  //M 点击某日期右上 + 时弹出内联添加框。
  const [addingDate, setAddingDate] = react.useState<string | undefined>(undefined);
  const [draftTitle, setDraftTitle] = react.useState('');
  const [draftQuadrant, setDraftQuadrant] = react.useState<api.TickQuadrant>('q2');
  const [expandedDate, setExpandedDate] = react.useState<string | undefined>(undefined);

  const cells = react.useMemo(() => {
    return utils.getMonthGrid(cursor.year, cursor.month, todayStr);
  }, [cursor.year, cursor.month, todayStr]);

  //M 按 dueDate 聚合并排序当月可见普通任务。
  const tasksByDate = react.useMemo(() => {
    const map = new Map<string, api.ControlTask[]>();
    for (const item of tasks) {
      if (utils.isTaskTrashed(item)) {
        continue;
      }
      if (utils.getTaskKind(item) !== 'task') {
        continue;
      }
      const due = item.dueDate ?? null;
      if (due === null || due === '') {
        continue;
      }
      const list = map.get(due) ?? [];
      list.push(item);
      map.set(due, list);
    }
    for (const [key, list] of map.entries()) {
      map.set(key, utils.sortTaskList(list, 'priority'));
    }
    return map;
  }, [tasks]);

  const selectedTask = tasks.find((item) => item.id === selectedTaskId);

  /** 切换上一个月或下一个月。 */
  const shiftMonth = (delta: number): void => {
    setCursor((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  /** 一键跳回今天所在月份。 */
  const jumpToday = (): void => {
    const now = utils.parseDateStr(todayStr) ?? new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
  };

  /** 在指定日期下创建新任务。 */
  const handleCreateForDate = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    if (addingDate === undefined) return;

    const parsed = utils.parseQuickTaskInput(draftTitle);
    if (parsed.title === '') return;

    const targetDate = addingDate;
    setDraftTitle('');
    setAddingDate(undefined);
    const created = await onCreateTask({
      title: parsed.title,
      kind: 'task',
      list: '工作任务',
      quadrant: draftQuadrant,
      priority: utils.getPriorityForQuadrant(draftQuadrant),
      dueDate: targetDate,
      tags: parsed.tags,
      status: 'ready',
      by: 'boss',
    });
    if (created !== undefined) {
      onSelectTask(created.id);
    }
  };

  /** 勾选任务条上的微型完成框。 */
  const handleToggleDone = async (task: api.ControlTask): Promise<void> => {
    let nextStatus: api.ControlTaskStatus = 'done';
    if (utils.isTaskDone(task)) {
      nextStatus = 'ready';
    }
    await onPatchTask(task.id, { status: nextStatus, by: 'boss' });
  };

  const monthTitle = `${String(cursor.year)}年${String(cursor.month + 1)}月`;

  return (
    <div className="tick-page-with-drawer">
      <div className="tick-cal-page">
        <header className="tick-cal-header">
          <div className="tick-cal-header__left">
            <h2 className="tick-cal-header__title">{monthTitle}</h2>
          </div>
          <div className="tick-cal-header__right">
            <button
              type="button"
              className="tick-cal-add-btn"
              title="在今天快速添加日程任务"
              onClick={() => {
                setAddingDate(todayStr);
                setDraftTitle('');
              }}
            >
              + 新建日程
            </button>
            <div className="tick-cal-nav" role="group" aria-label="月份导航">
              <button
                type="button"
                aria-label="上个月"
                onClick={() => shiftMonth(-1)}
              >
                ‹
              </button>
              <button type="button" onClick={jumpToday}>
                今天
              </button>
              <button
                type="button"
                aria-label="下个月"
                onClick={() => shiftMonth(1)}
              >
                ›
              </button>
            </div>
          </div>
        </header>

        {/* 指定日期快捷添加条 */}
        {addingDate !== undefined && (
          <form className="tick-cal-quick-bar" onSubmit={(e) => void handleCreateForDate(e)}>
            <span className="tick-cal-quick-bar__date">
              📅 {utils.formatFullDateZh(addingDate)}
            </span>
            <input
              type="text"
              value={draftTitle}
              placeholder="输入日程任务标题，回车创建…"
              autoFocus
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setAddingDate(undefined);
                }
              }}
            />
            <div className="tick-flag-group">
              {utils.QUADRANT_LIST.map((item) => {
                let flagClass = `tick-flag-btn tick-flag-btn--${item.key}`;
                if (draftQuadrant === item.key) {
                  flagClass = `${flagClass} tick-flag-btn--active`;
                }
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={flagClass}
                    title={item.label}
                    onClick={() => setDraftQuadrant(item.key)}
                  >
                    ⚑
                  </button>
                );
              })}
            </div>
            <button type="submit" className="tick-mini-btn tick-mini-btn--primary">
              添加
            </button>
            <button
              type="button"
              className="tick-mini-btn"
              onClick={() => setAddingDate(undefined)}
            >
              取消
            </button>
          </form>
        )}

        {/* 7 列星期表头 */}
        <div className="tick-cal-weekdays">
          {CALENDAR_HEADERS.map((name) => (
            <div key={name} className="tick-cal-weekday">
              {name}
            </div>
          ))}
        </div>

        {/* 6x7 深色月历网格 */}
        <div className="tick-cal-grid">
          {cells.map((cell) => {
            const dayTasks = tasksByDate.get(cell.dateStr) ?? [];
            const isExpanded = expandedDate === cell.dateStr;
            const visibleLimit = 4;
            let shownTasks = dayTasks;
            if (!isExpanded && dayTasks.length > visibleLimit) {
              shownTasks = dayTasks.slice(0, visibleLimit);
            }
            const hiddenCount = dayTasks.length - shownTasks.length;

            let cellClass = 'tick-cal-cell';
            if (!cell.inMonth) {
              cellClass = 'tick-cal-cell tick-cal-cell--muted';
            }
            if (cell.isToday) {
              cellClass = `${cellClass} tick-cal-cell--today`;
            }

            let dayLabel = String(cell.dayNum);
            if (cell.dayNum === 1 && !cell.isToday) {
              dayLabel = `${String(cell.monthNum)}月1日`;
            }

            let numClass = 'tick-cal-cell__num';
            if (cell.isToday) {
              numClass = 'tick-cal-cell__num tick-cal-cell__num--today';
            }

            return (
              <div key={cell.dateStr} className={cellClass}>
                <div className="tick-cal-cell__top">
                  <span className={numClass}>{dayLabel}</span>
                  <button
                    type="button"
                    className="tick-cal-cell__add"
                    title={`在 ${cell.dateStr} 添加任务`}
                    aria-label={`在 ${cell.dateStr} 添加任务`}
                    onClick={() => {
                      setAddingDate(cell.dateStr);
                      setDraftTitle('');
                    }}
                  >
                    +
                  </button>
                </div>

                <div className="tick-cal-cell__bars">
                  {shownTasks.map((task) => {
                    const quad = utils.getEffectiveQuadrant(task);
                    const done = utils.isTaskDone(task);
                    const selected = task.id === selectedTaskId;
                    let barClass = `tick-cal-bar tick-cal-bar--${quad}`;
                    if (done) {
                      barClass = `${barClass} tick-cal-bar--done`;
                    }
                    if (selected) {
                      barClass = `${barClass} tick-cal-bar--selected`;
                    }
                    return (
                      <div
                        key={task.id}
                        className={barClass}
                        title={task.title}
                        onClick={() => onSelectTask(task.id)}
                      >
                        <button
                          type="button"
                          className="tick-cal-bar__check"
                          aria-label={`勾选 ${task.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleToggleDone(task);
                          }}
                        >
                          {done && '✓'}
                        </button>
                        <span className="tick-cal-bar__title">{task.title}</span>
                      </div>
                    );
                  })}

                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      className="tick-cal-more"
                      onClick={() => setExpandedDate(cell.dateStr)}
                    >
                      还有 {String(hiddenCount)} 项
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 右侧详情滑板（窄屏附带背景遮罩） */}
      {selectedTask !== undefined && (
        <div
          className="tick-drawer-backdrop"
          aria-hidden="true"
          onClick={() => onSelectTask(undefined)}
        />
      )}
      {selectedTask !== undefined && (
        <div className="tick-drawer-panel">
          <detail.TickTaskDetail
            task={selectedTask}
            allTasks={tasks}
            lists={lists}
            todayStr={todayStr}
            onClose={() => onSelectTask(undefined)}
            onSelectTask={(id) => onSelectTask(id)}
            onPatchTask={onPatchTask}
            onCreateTask={onCreateTask}
            onAppendEvent={onAppendEvent}
            onDeleteTask={onDeleteTask}
          />
        </div>
      )}
    </div>
  );
}
