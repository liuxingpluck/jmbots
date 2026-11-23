/** 滴答四象限 2x2 深色矩阵视图：按红/黄/蓝/绿四象限与已过期/即将到期/无日期/已完成分组。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as detail from './TickTaskDetail.tsx';
import * as utils from './TickUtils.ts';

/** 四象限视图入参。 */
export interface TickQuadrantViewProps {
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

/** 单个象限内部四类时间分组结构。 */
interface QuadrantGroups {
  /** 已过期任务。 */
  overdue: api.ControlTask[];
  /** 今天及未来有日期任务。 */
  upcoming: api.ControlTask[];
  /** 无日期任务。 */
  noDate: api.ControlTask[];
  /** 已完成任务。 */
  done: api.ControlTask[];
}

/** 将某象限的任务划分进四个分组。 */
function partitionQuadrantTasks(
  items: readonly api.ControlTask[],
  todayStr: string,
): QuadrantGroups {
  const overdue: api.ControlTask[] = [];
  const upcoming: api.ControlTask[] = [];
  const noDate: api.ControlTask[] = [];
  const done: api.ControlTask[] = [];

  for (const item of items) {
    if (utils.isTaskDone(item)) {
      done.push(item);
      continue;
    }
    const due = item.dueDate ?? null;
    if (due === null || due === '') {
      noDate.push(item);
      continue;
    }
    if (due < todayStr) {
      overdue.push(item);
      continue;
    }
    upcoming.push(item);
  }
  return { overdue, upcoming, noDate, done };
}

/** 滴答四象限主视图组件。 */
export function TickQuadrantView(props: TickQuadrantViewProps): react.JSX.Element {
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

  //M 记录哪些分组被折叠（键格式：q1:done 等），默认折叠各象限的已完成分组。
  const [foldedGroups, setFoldedGroups] = react.useState<ReadonlySet<string>>(
    () => new Set(['q1:done', 'q2:done', 'q3:done']),
  );
  const [foldedTrees, setFoldedTrees] = react.useState<ReadonlySet<string>>(() => new Set());
  const [addingQuad, setAddingQuad] = react.useState<api.TickQuadrant | undefined>(undefined);
  const [draftTitle, setDraftTitle] = react.useState('');

  //M 仅纳入未进垃圾桶的普通任务。
  const normalTasks = react.useMemo(() => {
    return tasks.filter((item) => {
      if (utils.isTaskTrashed(item)) return false;

      return utils.getTaskKind(item) === 'task';
    });
  }, [tasks]);

  //M 按四象限归类并再做时间分组。
  const byQuadrant = react.useMemo(() => {
    const buckets: Record<api.TickQuadrant, api.ControlTask[]> = {
      q1: [],
      q2: [],
      q3: [],
      q4: [],
    };
    for (const item of normalTasks) {
      const q = utils.getEffectiveQuadrant(item);
      buckets[q].push(item);
    }
    return {
      q1: partitionQuadrantTasks(buckets.q1, todayStr),
      q2: partitionQuadrantTasks(buckets.q2, todayStr),
      q3: partitionQuadrantTasks(buckets.q3, todayStr),
      q4: partitionQuadrantTasks(buckets.q4, todayStr),
    };
  }, [normalTasks, todayStr]);

  const selectedTask = tasks.find((item) => item.id === selectedTaskId);

  /** 切换某个时间分组的折叠态。 */
  const toggleGroupFold = (key: string): void => {
    setFoldedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      next.add(key);
      return next;
    });
  };

  /** 切换象限内父任务树折叠态。 */
  const toggleTreeFold = (taskId: string): void => {
    setFoldedTrees((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
        return next;
      }
      next.add(taskId);
      return next;
    });
  };

  /** 勾选完成或取消完成。 */
  const handleToggleDone = async (task: api.ControlTask): Promise<void> => {
    let nextStatus: api.ControlTaskStatus = 'done';
    if (utils.isTaskDone(task)) {
      nextStatus = 'ready';
    }
    await onPatchTask(task.id, { status: nextStatus, by: 'boss' });
  };

  /** 在指定象限卡片内快速创建任务。 */
  const handleQuickAdd = async (
    event: react.FormEvent,
    quadrant: api.TickQuadrant,
  ): Promise<void> => {
    event.preventDefault();
    const parsed = utils.parseQuickTaskInput(draftTitle);
    if (parsed.title === '') return;

    setDraftTitle('');
    setAddingQuad(undefined);
    const created = await onCreateTask({
      title: parsed.title,
      kind: 'task',
      list: '工作任务',
      quadrant,
      priority: utils.getPriorityForQuadrant(quadrant),
      tags: parsed.tags,
      status: 'ready',
      by: 'boss',
    });
    if (created !== undefined) {
      onSelectTask(created.id);
    }
  };

  /** 渲染某象限内的单个时间分组区块。 */
  const renderGroup = (
    quadKey: api.TickQuadrant,
    groupKey: string,
    label: string,
    items: readonly api.ControlTask[],
    isDoneGroup: boolean,
  ): react.JSX.Element | null => {
    if (items.length === 0) return null;

    const fullKey = `${quadKey}:${groupKey}`;
    const isFolded = foldedGroups.has(fullKey);
    const rows = utils.buildTaskTreeRows(items, foldedTrees, 'dueDate');

    return (
      <div key={fullKey} className="tick-q-group">
        <button
          type="button"
          className="tick-q-group__head"
          aria-expanded={!isFolded}
          onClick={() => toggleGroupFold(fullKey)}
        >
          <span>{isFolded && '▸'}{!isFolded && '▾'}</span>
          <span>{label}</span>
          <span className="tick-q-group__count">{String(items.length)}</span>
        </button>

        {!isFolded && (
          <div className="tick-q-group__rows">
            {rows.map((row) => {
              const item = row.task;
              const done = utils.isTaskDone(item);
              const selected = item.id === selectedTaskId;
              const listName = utils.getTaskListName(item);
              const aiBadge = utils.getAiTaskBadge(item);

              let checkClass = `tick-checkbox tick-checkbox--sm tick-checkbox--${quadKey}`;
              if (done) {
                checkClass = `${checkClass} tick-checkbox--done`;
              }

              let rowClass = 'tick-q-row';
              if (isDoneGroup || done) {
                rowClass = 'tick-q-row tick-q-row--done';
              }

              let dueText = '';
              let dueClass = 'tick-q-row__due';
              if (item.dueDate !== undefined && item.dueDate !== null && item.dueDate !== '') {
                dueText = utils.formatShortDate(item.dueDate, todayStr);
                const diff = utils.diffDays(todayStr, item.dueDate);
                if (diff < 0 && !done) {
                  dueClass = 'tick-q-row__due tick-q-row__due--overdue';
                }
                if (diff === 0 && !done) {
                  dueClass = 'tick-q-row__due tick-q-row__due--today';
                }
              }

              const padStyle: react.CSSProperties = {
                paddingLeft: `${String(6 + row.depth * 18)}px`,
              };

              return (
                <div
                  key={item.id}
                  className={rowClass}
                  data-selected={selected}
                  style={padStyle}
                  onClick={() => onSelectTask(item.id)}
                >
                  {row.childCount > 0 && (
                    <button
                      type="button"
                      className="tick-fold-btn"
                      aria-label="切换子任务折叠"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleTreeFold(item.id);
                      }}
                    >
                      {row.collapsed && '▸'}
                      {!row.collapsed && '▾'}
                    </button>
                  )}
                  <button
                    type="button"
                    className={checkClass}
                    aria-label={`勾选 ${item.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleToggleDone(item);
                    }}
                  >
                    {done && <span aria-hidden="true">✓</span>}
                  </button>
                  <span className="tick-q-row__title">{item.title}</span>
                  {aiBadge !== undefined && (
                    <span className="tick-ai-badge tick-ai-badge--compact" data-status={aiBadge.status}>
                      {aiBadge.text}
                    </span>
                  )}
                  <span className="tick-q-row__list">{listName}</span>
                  {dueText !== '' && <span className={dueClass}>{dueText}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="tick-page-with-drawer">
      <div className="tick-quadrant-page">
        <header className="tick-view-header">
          <h2 className="tick-view-header__title">四象限</h2>
          <span className="tick-view-header__hint">
            按紧急与重要程度自动归类 · 点击任意任务可右侧调整象限与日期
          </span>
        </header>

        <div className="tick-quadrant-grid">
          {utils.QUADRANT_LIST.map((meta) => {
            const groups = byQuadrant[meta.key];
            const activeCount =
              groups.overdue.length + groups.upcoming.length + groups.noDate.length;
            const totalCount = activeCount + groups.done.length;
            const isAdding = addingQuad === meta.key;

            return (
              <section
                key={meta.key}
                className={`tick-q-card tick-q-card--${meta.key}`}
                aria-label={meta.label}
              >
                <header className="tick-q-card__head">
                  <div className="tick-q-card__title-wrap">
                    <span className={`tick-q-roman tick-q-roman--${meta.key}`}>
                      {meta.roman}
                    </span>
                    <h3 className={`tick-q-card__title tick-q-card__title--${meta.key}`}>
                      {meta.label}
                    </h3>
                    <span className="tick-q-card__badge">{String(activeCount)}</span>
                  </div>
                  <button
                    type="button"
                    className="tick-icon-btn"
                    title={`向「${meta.label}」快速添加任务`}
                    aria-label={`添加 ${meta.label} 任务`}
                    onClick={() => {
                      if (isAdding) {
                        setAddingQuad(undefined);
                        return;
                      }
                      setAddingQuad(meta.key);
                      setDraftTitle('');
                    }}
                  >
                    +
                  </button>
                </header>

                {isAdding && (
                  <form
                    className="tick-q-quick-form"
                    onSubmit={(e) => void handleQuickAdd(e, meta.key)}
                  >
                    <input
                      type="text"
                      value={draftTitle}
                      placeholder={`添加到「${meta.label}」，回车创建…`}
                      autoFocus
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setAddingQuad(undefined);
                        }
                      }}
                    />
                    <button type="submit" className="tick-mini-btn tick-mini-btn--primary">
                      添加
                    </button>
                  </form>
                )}

                <div className="tick-q-card__body">
                  {totalCount === 0 && (
                    <div className="tick-q-card__empty">暂无任务，点右上 + 快速添加</div>
                  )}
                  {renderGroup(meta.key, 'overdue', '已过期', groups.overdue, false)}
                  {renderGroup(meta.key, 'upcoming', '即将到期', groups.upcoming, false)}
                  {renderGroup(meta.key, 'noDate', '无日期', groups.noDate, false)}
                  {renderGroup(meta.key, 'done', '已完成', groups.done, true)}
                </div>
              </section>
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
