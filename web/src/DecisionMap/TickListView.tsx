/** 滴答清单三栏经典视图：左侧智能箱/清单/标签 + 中栏多级父子任务树 + 右侧详情面板。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as detail from './TickTaskDetail.tsx';
import * as utils from './TickUtils.ts';

/** 清单视图左侧选中范围类型。 */
export type TickListFilter =
  | { kind: 'today' }
  | { kind: 'next7' }
  | { kind: 'inbox' }
  | { kind: 'list'; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'completed' }
  | { kind: 'trash' };

/** 三栏清单视图入参。 */
export interface TickListViewProps {
  /** 全部任务数组。 */
  tasks: readonly api.ControlTask[];
  /** 可见清单定义数组。 */
  lists: readonly api.TaskListDef[];
  /** 今日日期字符串 YYYY-MM-DD。 */
  todayStr: string;
  /** 当前左侧选中的过滤范围。 */
  filter: TickListFilter;
  /** 切换左侧过滤范围回调。 */
  onChangeFilter: (next: TickListFilter) => void;
  /** 当前选中的任务 ID。 */
  selectedTaskId: string | undefined;
  /** 选中任务回调。 */
  onSelectTask: (taskId: string | undefined) => void;
  /** 创建任务回调。 */
  onCreateTask: (
    input: api.CreateControlTaskInput,
    toastText?: string,
  ) => Promise<api.ControlTask | undefined>;
  /** 更新任务回调。 */
  onPatchTask: (
    taskId: string,
    patch: api.PatchControlTaskInput,
    toastText?: string,
  ) => Promise<void>;
  /** 彻底删除任务回调。 */
  onDeleteTask: (taskId: string) => Promise<void>;
  /** 追加 AI 事件回调。 */
  onAppendEvent: (
    taskId: string,
    text: string,
    kind: api.ControlTaskEventKind,
    options?: { notifyHelper?: string; broadcast?: boolean },
  ) => Promise<boolean>;
  /** 新建自定义清单回调。 */
  onCreateList: (name: string, icon: string) => Promise<void>;
  /** 删除自定义清单回调。 */
  onDeleteList: (listId: string, listName: string) => Promise<void>;
}

/** 排序按钮循环顺序与文案。 */
const SORT_LABELS: Readonly<Record<utils.TickSortMode, string>> = {
  default: '默认排序',
  priority: '按象限优先级',
  dueDate: '按到期日期',
};

const SIDEBAR_WIDTH_KEY = 'jmbots.tick.sidebarWidth';
const DETAIL_WIDTH_KEY = 'jmbots.tick.detailWidth';
const DEFAULT_SIDEBAR_WIDTH = 226;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 380;
const DEFAULT_DETAIL_WIDTH = 440;
const MIN_DETAIL_WIDTH = 300;
const MAX_DETAIL_WIDTH = 860;
const WIDE_DETAIL_WIDTH = 720;

/** 把列宽限制在允许区间内。 */
function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 从 localStorage 读取列宽，异常或越界时回退默认值。 */
function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;

    const num = Number(raw);
    if (!Number.isFinite(num)) return fallback;

    return clampWidth(num, min, max);
  } catch {
    return fallback;
  }
}

/** 持久化列宽到 localStorage（隐私模式失败静默跳过）。 */
function writeStoredWidth(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    return;
  }
}

/** 计算当前过滤视图的顶部标题与图标。 */
function getFilterHeader(
  filter: TickListFilter,
  lists: readonly api.TaskListDef[],
): { icon: string; title: string } {
  if (filter.kind === 'today') return { icon: '📅', title: '今天' };
  if (filter.kind === 'next7') return { icon: '🗓️', title: '最近7天' };
  if (filter.kind === 'inbox') return { icon: '📥', title: '收集箱' };
  if (filter.kind === 'completed') return { icon: '☑️', title: '已完成' };
  if (filter.kind === 'trash') return { icon: '🗑️', title: '垃圾桶' };
  if (filter.kind === 'tag') return { icon: '#', title: filter.name };

  const found = lists.find((item) => item.name === filter.name);
  return { icon: found?.icon ?? '📋', title: filter.name };
}

/** 滴答清单三栏主组件。 */
export function TickListView(props: TickListViewProps): react.JSX.Element {
  const {
    tasks,
    lists,
    todayStr,
    filter,
    onChangeFilter,
    selectedTaskId,
    onSelectTask,
    onCreateTask,
    onPatchTask,
    onDeleteTask,
    onAppendEvent,
    onCreateList,
    onDeleteList,
  } = props;

  const [sortMode, setSortMode] = react.useState<utils.TickSortMode>('default');
  const [collapsedIds, setCollapsedIds] = react.useState<ReadonlySet<string>>(() => new Set());
  const [completedOpen, setCompletedOpen] = react.useState(true);
  const [sidebarOpen, setSidebarOpen] = react.useState(true);

  //M 左右两条竖向分割条的可拖拽列宽与宽读模式状态。
  const [sidebarWidth, setSidebarWidth] = react.useState(() =>
    readStoredWidth(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
  );
  const [detailWidth, setDetailWidth] = react.useState(() =>
    readStoredWidth(DETAIL_WIDTH_KEY, DEFAULT_DETAIL_WIDTH, MIN_DETAIL_WIDTH, MAX_DETAIL_WIDTH),
  );
  const [draggingSide, setDraggingSide] = react.useState<'sidebar' | 'detail' | undefined>(
    undefined,
  );
  const preWideWidthRef = react.useRef<number>(DEFAULT_DETAIL_WIDTH);
  const dragCleanupRef = react.useRef<(() => void) | undefined>(undefined);

  react.useEffect(() => {
    writeStoredWidth(SIDEBAR_WIDTH_KEY, sidebarWidth);
  }, [sidebarWidth]);

  react.useEffect(() => {
    writeStoredWidth(DETAIL_WIDTH_KEY, detailWidth);
  }, [detailWidth]);

  react.useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  //M 顶部快速添加栏状态。
  const [quickTitle, setQuickTitle] = react.useState('');
  const [quickDue, setQuickDue] = react.useState<string>('');
  const [quickQuadrant, setQuickQuadrant] = react.useState<api.TickQuadrant>('q2');
  const [quickDueOpen, setQuickDueOpen] = react.useState(false);

  //M 左侧新建/删除清单内联状态。
  const [addingList, setAddingList] = react.useState(false);
  const [newListName, setNewListName] = react.useState('');
  const [newListIcon, setNewListIcon] = react.useState('📋');
  const [confirmDeleteListId, setConfirmDeleteListId] = react.useState<string | undefined>(undefined);
  const [confirmTrashTaskId, setConfirmTrashTaskId] = react.useState<string | undefined>(undefined);

  const next7Limit = utils.addDaysStr(todayStr, 6);

  //M 过滤出所有普通任务（排除倒数纪念日与习惯）。
  const normalTasks = react.useMemo(() => {
    return tasks.filter((item) => utils.getTaskKind(item) === 'task');
  }, [tasks]);

  const activeTasks = react.useMemo(() => {
    return normalTasks.filter((item) => !utils.isTaskTrashed(item));
  }, [normalTasks]);

  const trashedTasks = react.useMemo(() => {
    return normalTasks.filter((item) => utils.isTaskTrashed(item));
  }, [normalTasks]);

  //M 统计智能箱、自定义清单、标签、已完成与垃圾桶计数。
  const counts = react.useMemo(() => {
    let todayCount = 0;
    let next7Count = 0;
    let inboxCount = 0;
    let completedCount = 0;
    const byList = new Map<string, number>();
    const byTag = new Map<string, number>();

    for (const item of activeTasks) {
      if (utils.isTaskDone(item)) {
        completedCount += 1;
        continue;
      }
      const listName = utils.getTaskListName(item);
      if (listName === '收集箱') {
        inboxCount += 1;
      }
      byList.set(listName, (byList.get(listName) ?? 0) + 1);

      const due = item.dueDate ?? null;
      if (due !== null && due !== '') {
        if (due <= todayStr) {
          todayCount += 1;
        }
        if (due <= next7Limit) {
          next7Count += 1;
        }
      }
      for (const tag of item.tags ?? []) {
        byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
      }
    }

    const tagEntries = Array.from(byTag.entries()).sort((a, b) => b[1] - a[1]);
    return {
      todayCount,
      next7Count,
      inboxCount,
      completedCount,
      trashCount: trashedTasks.length,
      byList,
      tagEntries,
    };
  }, [activeTasks, trashedTasks.length, todayStr, next7Limit]);

  //M 按当前选中范围筛选出待办任务与已完成任务。
  const { pendingTasks, doneTasks } = react.useMemo(() => {
    if (filter.kind === 'trash') {
      return { pendingTasks: trashedTasks, doneTasks: [] as api.ControlTask[] };
    }
    if (filter.kind === 'completed') {
      const finished = activeTasks.filter((item) => utils.isTaskDone(item));
      return { pendingTasks: [] as api.ControlTask[], doneTasks: finished };
    }

    const matched = activeTasks.filter((item) => {
      if (filter.kind === 'inbox') {
        return utils.getTaskListName(item) === '收集箱';
      }
      if (filter.kind === 'list') {
        return utils.getTaskListName(item) === filter.name;
      }
      if (filter.kind === 'tag') {
        return (item.tags ?? []).includes(filter.name);
      }
      const due = item.dueDate ?? null;
      if (due === null || due === '') return false;
      if (filter.kind === 'today') return due <= todayStr;
      if (filter.kind === 'next7') return due <= next7Limit;

      return false;
    });

    const pending: api.ControlTask[] = [];
    const done: api.ControlTask[] = [];
    for (const item of matched) {
      if (utils.isTaskDone(item)) {
        done.push(item);
        continue;
      }
      pending.push(item);
    }
    return { pendingTasks: pending, doneTasks: done };
  }, [activeTasks, trashedTasks, filter, todayStr, next7Limit]);

  const pendingRows = react.useMemo(() => {
    return utils.buildTaskTreeRows(pendingTasks, collapsedIds, sortMode);
  }, [pendingTasks, collapsedIds, sortMode]);

  const doneRows = react.useMemo(() => {
    return utils.sortTaskList(doneTasks, 'default');
  }, [doneTasks]);

  const selectedTask = tasks.find((item) => item.id === selectedTaskId);
  const headerMeta = getFilterHeader(filter, lists);

  /** 循环切换排序方式。 */
  const cycleSort = (): void => {
    if (sortMode === 'default') {
      setSortMode('priority');
      return;
    }
    if (sortMode === 'priority') {
      setSortMode('dueDate');
      return;
    }
    setSortMode('default');
  };

  /** 切换父任务折叠/展开状态。 */
  const toggleCollapse = (taskId: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
        return next;
      }
      next.add(taskId);
      return next;
    });
  };

  /** 循环切换快捷输入栏的四象限。 */
  const cycleQuickQuadrant = (): void => {
    if (quickQuadrant === 'q1') {
      setQuickQuadrant('q2');
      return;
    }
    if (quickQuadrant === 'q2') {
      setQuickQuadrant('q3');
      return;
    }
    if (quickQuadrant === 'q3') {
      setQuickQuadrant('q4');
      return;
    }
    setQuickQuadrant('q1');
  };

  /** 回车提交快捷新建任务。 */
  const handleQuickCreate = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const parsed = utils.parseQuickTaskInput(quickTitle);
    if (parsed.title === '') return;

    let targetList = '工作任务';
    if (filter.kind === 'inbox') {
      targetList = '收集箱';
    }
    if (filter.kind === 'list') {
      targetList = filter.name;
    }

    let dueDate: string | null = null;
    if (quickDue !== '') {
      dueDate = quickDue;
    }
    if (dueDate === null && (filter.kind === 'today' || filter.kind === 'next7')) {
      dueDate = todayStr;
    }

    const tags = [...parsed.tags];
    if (filter.kind === 'tag' && !tags.includes(filter.name)) {
      tags.push(filter.name);
    }

    setQuickTitle('');
    setQuickDueOpen(false);
    const created = await onCreateTask({
      title: parsed.title,
      kind: 'task',
      list: targetList,
      quadrant: quickQuadrant,
      priority: utils.getPriorityForQuadrant(quickQuadrant),
      dueDate,
      tags,
      status: 'ready',
      by: 'boss',
    });
    if (created !== undefined) {
      onSelectTask(created.id);
    }
  };

  /** 勾选或取消勾选任务完成态。 */
  const handleToggleDone = async (task: api.ControlTask): Promise<void> => {
    let nextStatus: api.ControlTaskStatus = 'done';
    if (utils.isTaskDone(task)) {
      nextStatus = 'ready';
    }
    await onPatchTask(task.id, { status: nextStatus, by: 'boss' });
  };

  /** 提交新建清单。 */
  const handleSubmitNewList = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const cleaned = newListName.trim();
    if (cleaned === '') return;

    await onCreateList(cleaned, newListIcon);
    setNewListName('');
    setAddingList(false);
    onChangeFilter({ kind: 'list', name: cleaned });
  };

  const canQuickAdd = filter.kind !== 'completed' && filter.kind !== 'trash';
  const showCompletedSection = filter.kind !== 'completed' && filter.kind !== 'trash' && doneRows.length > 0;
  let quickDueText = '';
  if (quickDue !== '') {
    quickDueText = utils.formatShortDate(quickDue, todayStr);
  }
  const tomorrowStr = utils.addDaysStr(todayStr, 1);

  /** 开始拖拽左侧清单栏或右侧详情栏分割条（拖动期间禁用全局选字）。 */
  const startResize = (
    side: 'sidebar' | 'detail',
    event: react.PointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;

    event.preventDefault();
    dragCleanupRef.current?.();

    const startX = event.clientX;
    let startWidth = detailWidth;
    if (side === 'sidebar') {
      startWidth = sidebarWidth;
    }

    setDraggingSide(side);
    document.body.classList.add('tick-resizing');

    const onMove = (ev: PointerEvent): void => {
      const delta = ev.clientX - startX;
      if (side === 'sidebar') {
        setSidebarWidth(clampWidth(startWidth + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
        return;
      }
      setDetailWidth(clampWidth(startWidth - delta, MIN_DETAIL_WIDTH, MAX_DETAIL_WIDTH));
    };

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      document.body.classList.remove('tick-resizing');
      setDraggingSide(undefined);
      dragCleanupRef.current = undefined;
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  /** 在当前宽度与 720px 宽读模式间切换详情面板宽度。 */
  const toggleWideRead = (): void => {
    if (detailWidth >= WIDE_DETAIL_WIDTH - 20) {
      let restore = DEFAULT_DETAIL_WIDTH;
      if (preWideWidthRef.current < WIDE_DETAIL_WIDTH - 20) {
        restore = preWideWidthRef.current;
      }
      setDetailWidth(clampWidth(restore, MIN_DETAIL_WIDTH, MAX_DETAIL_WIDTH));
      return;
    }
    preWideWidthRef.current = detailWidth;
    setDetailWidth(WIDE_DETAIL_WIDTH);
  };

  const columnVars = {
    '--tick-sidebar-w': `${String(sidebarWidth)}px`,
    '--tick-detail-w': `${String(detailWidth)}px`,
  } as react.CSSProperties;

  return (
    <div className="tick-three-col" style={columnVars}>
      {/* 左栏：智能箱 + 清单 + 标签 + 已完成/垃圾桶 + 可拖拽分割条 */}
      {sidebarOpen && (
        <>
          <aside className="tick-sidebar" aria-label="清单与智能箱">
          <div className="tick-sidebar__group">
            <button
              type="button"
              className="tick-nav-item"
              data-active={filter.kind === 'today'}
              onClick={() => onChangeFilter({ kind: 'today' })}
            >
              <span className="tick-nav-item__icon">📅</span>
              <span className="tick-nav-item__label">今天</span>
              {counts.todayCount > 0 && (
                <span className="tick-nav-item__count">{String(counts.todayCount)}</span>
              )}
            </button>
            <button
              type="button"
              className="tick-nav-item"
              data-active={filter.kind === 'next7'}
              onClick={() => onChangeFilter({ kind: 'next7' })}
            >
              <span className="tick-nav-item__icon">🗓️</span>
              <span className="tick-nav-item__label">最近7天</span>
              {counts.next7Count > 0 && (
                <span className="tick-nav-item__count">{String(counts.next7Count)}</span>
              )}
            </button>
            <button
              type="button"
              className="tick-nav-item"
              data-active={filter.kind === 'inbox'}
              onClick={() => onChangeFilter({ kind: 'inbox' })}
            >
              <span className="tick-nav-item__icon">📥</span>
              <span className="tick-nav-item__label">收集箱</span>
              {counts.inboxCount > 0 && (
                <span className="tick-nav-item__count">{String(counts.inboxCount)}</span>
              )}
            </button>
          </div>

          <div className="tick-sidebar__divider" />

          {/* 清单列表区 */}
          <div className="tick-sidebar__section">
            <div className="tick-sidebar__section-head">
              <span>清单</span>
              <button
                type="button"
                className="tick-sidebar__add-btn"
                title="新建清单"
                aria-label="新建清单"
                onClick={() => setAddingList((prev) => !prev)}
              >
                +
              </button>
            </div>

            {addingList && (
              <form className="tick-inline-list-form" onSubmit={(e) => void handleSubmitNewList(e)}>
                <div className="tick-emoji-strip">
                  {utils.LIST_ICON_CHOICES.map((icon) => (
                    <button
                      key={icon}
                      type="button"
                      className="tick-emoji-btn"
                      data-active={newListIcon === icon}
                      onClick={() => setNewListIcon(icon)}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
                <div className="tick-inline-list-form__row">
                  <input
                    type="text"
                    value={newListName}
                    placeholder="输入清单名称…"
                    autoFocus
                    onChange={(e) => setNewListName(e.target.value)}
                  />
                  <button type="submit" className="tick-mini-btn tick-mini-btn--primary">
                    添加
                  </button>
                </div>
              </form>
            )}

            <div className="tick-sidebar__group">
              {lists.map((item) => {
                const active = filter.kind === 'list' && filter.name === item.name;
                const count = counts.byList.get(item.name) ?? 0;
                const deletable = !utils.SYSTEM_LIST_NAMES.has(item.name) && !item.id.startsWith('virtual-');
                const confirming = confirmDeleteListId === item.id;
                return (
                  <div key={item.id} className="tick-nav-item-wrap">
                    <button
                      type="button"
                      className="tick-nav-item"
                      data-active={active}
                      onClick={() => {
                        setConfirmDeleteListId(undefined);
                        onChangeFilter({ kind: 'list', name: item.name });
                      }}
                    >
                      <span className="tick-nav-item__icon">{item.icon ?? '📋'}</span>
                      <span className="tick-nav-item__label">{item.name}</span>
                      {count > 0 && (
                        <span className="tick-nav-item__count">{String(count)}</span>
                      )}
                    </button>
                    {deletable && !confirming && (
                      <button
                        type="button"
                        className="tick-nav-item__del"
                        title={`删除清单「${item.name}」`}
                        aria-label={`删除清单 ${item.name}`}
                        onClick={() => setConfirmDeleteListId(item.id)}
                      >
                        ×
                      </button>
                    )}
                    {deletable && confirming && (
                      <button
                        type="button"
                        className="tick-nav-item__del-confirm"
                        onClick={() => {
                          setConfirmDeleteListId(undefined);
                          void onDeleteList(item.id, item.name);
                          if (active) {
                            onChangeFilter({ kind: 'inbox' });
                          }
                        }}
                      >
                        确认删
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="tick-sidebar__divider" />

          {/* 标签聚合区 */}
          <div className="tick-sidebar__section">
            <div className="tick-sidebar__section-head">
              <span>标签</span>
            </div>
            {counts.tagEntries.length === 0 && (
              <div className="tick-sidebar__hint-box">
                在添加任务时输入 #标签 可自动归类并筛选不同清单的任务
              </div>
            )}
            {counts.tagEntries.length > 0 && (
              <div className="tick-sidebar__group">
                {counts.tagEntries.map(([tagName, tagCount]) => {
                  const active = filter.kind === 'tag' && filter.name === tagName;
                  return (
                    <button
                      key={tagName}
                      type="button"
                      className="tick-nav-item"
                      data-active={active}
                      onClick={() => onChangeFilter({ kind: 'tag', name: tagName })}
                    >
                      <span className="tick-nav-item__icon tick-nav-item__icon--hash">#</span>
                      <span className="tick-nav-item__label">{tagName}</span>
                      <span className="tick-nav-item__count">{String(tagCount)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="tick-sidebar__divider" />

          {/* 底部系统箱：已完成 / 垃圾桶 */}
          <div className="tick-sidebar__group">
            <button
              type="button"
              className="tick-nav-item"
              data-active={filter.kind === 'completed'}
              onClick={() => onChangeFilter({ kind: 'completed' })}
            >
              <span className="tick-nav-item__icon">☑️</span>
              <span className="tick-nav-item__label">已完成</span>
              {counts.completedCount > 0 && (
                <span className="tick-nav-item__count">{String(counts.completedCount)}</span>
              )}
            </button>
            <button
              type="button"
              className="tick-nav-item"
              data-active={filter.kind === 'trash'}
              onClick={() => onChangeFilter({ kind: 'trash' })}
            >
              <span className="tick-nav-item__icon">🗑️</span>
              <span className="tick-nav-item__label">垃圾桶</span>
              {counts.trashCount > 0 && (
                <span className="tick-nav-item__count">{String(counts.trashCount)}</span>
              )}
            </button>
          </div>
        </aside>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整清单侧栏宽度（双击恢复默认）"
            title="拖动调整侧栏宽度 · 双击恢复默认"
            className="tick-resizer"
            data-dragging={draggingSide === 'sidebar'}
            onPointerDown={(e) => startResize('sidebar', e)}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          />
        </>
      )}

      {/* 中栏：标题、快速添加与多级父子任务树 */}
      <section className="tick-list-main" aria-label="任务列表">
        <header className="tick-list-header">
          <div className="tick-list-header__left">
            <button
              type="button"
              className="tick-icon-btn"
              title="切换左侧清单栏"
              aria-label="切换左侧清单栏"
              onClick={() => setSidebarOpen((prev) => !prev)}
            >
              ☰
            </button>
            <span className="tick-list-header__icon" aria-hidden="true">
              {headerMeta.icon}
            </span>
            <h2 className="tick-list-header__title">{headerMeta.title}</h2>
          </div>
          <div className="tick-list-header__right">
            <button
              type="button"
              className="tick-sort-btn"
              title="点击切换排序方式"
              onClick={cycleSort}
            >
              ⇅ {SORT_LABELS[sortMode]}
            </button>
          </div>
        </header>

        {/* 快速添加输入框（支持 #标签 + 日期 + 象限） */}
        {canQuickAdd && (
          <form className="tick-quick-add" onSubmit={(e) => void handleQuickCreate(e)}>
            <span className="tick-quick-add__plus" aria-hidden="true">
              +
            </span>
            <input
              type="text"
              className="tick-quick-add__input"
              value={quickTitle}
              placeholder={`添加任务至「${headerMeta.title}」，输入 #标签 自动归类，回车创建…`}
              onChange={(e) => setQuickTitle(e.target.value)}
            />
            <div className="tick-quick-add__tools">
              <div className="tick-quick-due-wrap">
                <button
                  type="button"
                  className="tick-quick-chip"
                  data-active={quickDue !== ''}
                  title="设置截止日期"
                  onClick={() => setQuickDueOpen((prev) => !prev)}
                >
                  📅 {quickDueText}
                </button>
                {quickDueOpen && (
                  <div className="tick-popover tick-date-popover tick-date-popover--right">
                    <div className="tick-date-quick">
                      <button
                        type="button"
                        onClick={() => {
                          setQuickDue(todayStr);
                          setQuickDueOpen(false);
                        }}
                      >
                        今天
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setQuickDue(tomorrowStr);
                          setQuickDueOpen(false);
                        }}
                      >
                        明天
                      </button>
                      <button
                        type="button"
                        className="tick-date-quick__clear"
                        onClick={() => {
                          setQuickDue('');
                          setQuickDueOpen(false);
                        }}
                      >
                        清除
                      </button>
                    </div>
                    <input
                      type="date"
                      className="tick-date-native"
                      value={quickDue}
                      onChange={(e) => {
                        setQuickDue(e.target.value);
                        setQuickDueOpen(false);
                      }}
                    />
                  </div>
                )}
              </div>

              <button
                type="button"
                className={`tick-flag-btn tick-flag-btn--${quickQuadrant} tick-flag-btn--active`}
                title={`当前象限：${utils.QUADRANT_MAP[quickQuadrant].label}（点击切换）`}
                onClick={cycleQuickQuadrant}
              >
                ⚑
              </button>
            </div>
          </form>
        )}

        {/* 列表滚动内容区 */}
        <div className="tick-list-scroll">
          {filter.kind === 'trash' && (
            <div className="tick-trash-tip">
              垃圾桶中的任务不会出现在四象限、日历与 AI 控制面中；可随时还原或永久删除。
            </div>
          )}

          {/* 进行中/垃圾桶任务树 */}
          {pendingRows.length === 0 && doneRows.length === 0 && (
            <div className="tick-list-empty">
              <p>当前列表暂无任务</p>
              {canQuickAdd && <span>在上方输入框直接回车即可快速添加一条任务</span>}
            </div>
          )}

          {pendingRows.map((row) => {
            const item = row.task;
            const quadrant = utils.getEffectiveQuadrant(item);
            const selected = item.id === selectedTaskId;
            const done = utils.isTaskDone(item);
            const aiBadge = utils.getAiTaskBadge(item);
            const isTrashView = filter.kind === 'trash';
            const confirmingTrash = confirmTrashTaskId === item.id;

            let checkClass = `tick-checkbox tick-checkbox--${quadrant}`;
            if (done) {
              checkClass = `${checkClass} tick-checkbox--done`;
            }

            let dueText = '';
            let dueOverdue = false;
            let dueToday = false;
            if (item.dueDate !== undefined && item.dueDate !== null && item.dueDate !== '') {
              dueText = utils.formatShortDate(item.dueDate, todayStr);
              const diff = utils.diffDays(todayStr, item.dueDate);
              if (diff < 0 && !done) {
                dueOverdue = true;
              }
              if (diff === 0 && !done) {
                dueToday = true;
              }
            }

            let dueClass = 'tick-task-row__due';
            if (dueOverdue) {
              dueClass = 'tick-task-row__due tick-task-row__due--overdue';
            }
            if (dueToday) {
              dueClass = 'tick-task-row__due tick-task-row__due--today';
            }

            const indentStyle: react.CSSProperties = {
              paddingLeft: `${String(12 + row.depth * 22)}px`,
            };

            let foldLabel = '折叠子任务';
            if (row.collapsed) {
              foldLabel = '展开子任务';
            }

            return (
              <div
                key={item.id}
                className="tick-task-row"
                data-selected={selected}
                style={indentStyle}
                onClick={() => onSelectTask(item.id)}
              >
                {row.childCount > 0 && (
                  <button
                    type="button"
                    className="tick-fold-btn"
                    aria-label={foldLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(item.id);
                    }}
                  >
                    {row.collapsed && '▸'}
                    {!row.collapsed && '▾'}
                  </button>
                )}
                {row.childCount === 0 && <span className="tick-fold-spacer" aria-hidden="true" />}

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

                <span className="tick-task-row__title">{item.title}</span>

                {aiBadge !== undefined && (
                  <span className="tick-ai-badge" data-status={aiBadge.status}>
                    {aiBadge.text}
                  </span>
                )}

                {(item.tags ?? []).slice(0, 2).map((tag) => (
                  <span key={tag} className="tick-task-row__tag">
                    #{tag}
                  </span>
                ))}

                {row.childCount > 0 && (
                  <span className="tick-task-row__tree" title={`${String(row.childCount)} 个子任务`}>
                    ↳{String(row.childCount)}
                  </span>
                )}

                {dueText !== '' && <span className={dueClass}>{dueText}</span>}

                {isTrashView && (
                  <div
                    className="tick-trash-row-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="tick-mini-btn"
                      onClick={() => {
                        void onPatchTask(item.id, { trashedAt: null, by: 'boss' }, '已还原任务');
                      }}
                    >
                      还原
                    </button>
                    {!confirmingTrash && (
                      <button
                        type="button"
                        className="tick-mini-btn tick-mini-btn--danger"
                        onClick={() => setConfirmTrashTaskId(item.id)}
                      >
                        删除
                      </button>
                    )}
                    {confirmingTrash && (
                      <button
                        type="button"
                        className="tick-mini-btn tick-mini-btn--danger-solid"
                        onClick={() => {
                          setConfirmTrashTaskId(undefined);
                          void onDeleteTask(item.id);
                        }}
                      >
                        确认删
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* 专属「已完成」视图直接渲染已完成项 */}
          {filter.kind === 'completed' &&
            doneRows.map((item) => {
              const selected = item.id === selectedTaskId;
              const listName = utils.getTaskListName(item);
              return (
                <div
                  key={item.id}
                  className="tick-task-row tick-task-row--done"
                  data-selected={selected}
                  onClick={() => onSelectTask(item.id)}
                >
                  <span className="tick-fold-spacer" aria-hidden="true" />
                  <button
                    type="button"
                    className="tick-checkbox tick-checkbox--done"
                    aria-label={`恢复 ${item.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleToggleDone(item);
                    }}
                  >
                    <span aria-hidden="true">✓</span>
                  </button>
                  <span className="tick-task-row__title">{item.title}</span>
                  <span className="tick-task-row__list-chip">{listName}</span>
                  {item.dueDate !== undefined && item.dueDate !== null && item.dueDate !== '' && (
                    <span className="tick-task-row__due">
                      {utils.formatShortDate(item.dueDate, todayStr)}
                    </span>
                  )}
                </div>
              );
            })}

          {/* 普通视图底部可折叠「已完成」区块 */}
          {showCompletedSection && (
            <div className="tick-done-group">
              <button
                type="button"
                className="tick-done-group__toggle"
                aria-expanded={completedOpen}
                onClick={() => setCompletedOpen((prev) => !prev)}
              >
                <span>{completedOpen && '▾'}{!completedOpen && '▸'}</span>
                <span>已完成</span>
                <span className="tick-done-group__count">{String(doneRows.length)}</span>
              </button>
              {completedOpen &&
                doneRows.map((item) => {
                  const selected = item.id === selectedTaskId;
                  return (
                    <div
                      key={item.id}
                      className="tick-task-row tick-task-row--done"
                      data-selected={selected}
                      onClick={() => onSelectTask(item.id)}
                    >
                      <span className="tick-fold-spacer" aria-hidden="true" />
                      <button
                        type="button"
                        className="tick-checkbox tick-checkbox--done"
                        aria-label={`取消完成 ${item.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleToggleDone(item);
                        }}
                      >
                        <span aria-hidden="true">✓</span>
                      </button>
                      <span className="tick-task-row__title">{item.title}</span>
                      {item.dueDate !== undefined && item.dueDate !== null && item.dueDate !== '' && (
                        <span className="tick-task-row__due">
                          {utils.formatShortDate(item.dueDate, todayStr)}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </section>

      {/* 窄屏选中任务时的半透明遮罩层（桌面端隐藏） */}
      {selectedTask !== undefined && (
        <div
          className="tick-drawer-backdrop"
          aria-hidden="true"
          onClick={() => onSelectTask(undefined)}
        />
      )}

      {/* 右侧详情分割条（桌面端生效，窄屏自动隐藏；双击恢复 440px） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整详情面板宽度（双击恢复默认）"
        title="拖动调整详情宽度 · 双击恢复默认"
        className="tick-resizer"
        data-dragging={draggingSide === 'detail'}
        onPointerDown={(e) => startResize('detail', e)}
        onDoubleClick={() => setDetailWidth(DEFAULT_DETAIL_WIDTH)}
      />

      {/* 右栏：桌面端固定详情栏；窄屏（<=799px）选中任务时以抽屉浮层滑出 */}
      <div
        className="tick-drawer-panel tick-list-detail-wrap"
        data-open={selectedTask !== undefined}
      >
        <detail.TickTaskDetail
          task={selectedTask}
          allTasks={tasks}
          lists={lists}
          todayStr={todayStr}
          wideRead={detailWidth >= WIDE_DETAIL_WIDTH - 20}
          onToggleWideRead={toggleWideRead}
          onClose={() => onSelectTask(undefined)}
          onSelectTask={(id) => onSelectTask(id)}
          onPatchTask={onPatchTask}
          onCreateTask={onCreateTask}
          onAppendEvent={onAppendEvent}
          onDeleteTask={onDeleteTask}
        />
      </div>
    </div>
  );
}
