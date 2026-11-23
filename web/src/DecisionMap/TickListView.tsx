/** AI工作台三栏经典视图：左侧智能视图/动态筛选器/分组视图/核心标签池（底部固定已完成与垃圾桶） + 中栏文档节点树 + 右侧详情面板。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as detail from './TickTaskDetail.tsx';
import * as utils from './TickUtils.ts';
import * as filterEngine from './WorkbenchFilter.ts';

/** 三栏节点列表视图入参。 */
export interface TickListViewProps {
  /** 全量原始任务数组（用于侧栏计数、垃圾桶、已完成箱及详情面板关联）。 */
  allTasks: readonly api.ControlTask[];
  /** 当前范围与顶部动态筛选条共同过滤后的未完成（或显式匹配状态）节点。 */
  filteredActiveTasks: readonly api.ControlTask[];
  /** 当前范围与顶部动态筛选条共同过滤后的含已完成节点集合。 */
  filteredWithDoneTasks: readonly api.ControlTask[];
  /** 可见分组（清单）定义数组。 */
  lists: readonly api.TaskListDef[];
  /** 已保存的自定义动态筛选视图数组。 */
  views: readonly api.TaskFilterViewDef[];
  /** 全量活跃标签及其实时节点计数。 */
  tagEntries: ReadonlyArray<readonly [string, number]>;
  /** 今日日期字符串 YYYY-MM-DD。 */
  todayStr: string;
  /** 当前左侧选中的导航范围。 */
  scope: filterEngine.WorkbenchScope;
  /** 切换左侧导航范围回调。 */
  onChangeScope: (next: filterEngine.WorkbenchScope) => void;
  /** 顶部动态组合筛选条规则。 */
  adhocRule: api.TaskFilterRule;
  /** 更新顶部动态组合筛选条规则回调。 */
  onChangeAdhocRule: (next: api.TaskFilterRule) => void;
  /** 点击标签筛选或叠加标签回调（multi=true 多选叠加，multi=false 单选切换）。 */
  onToggleTagFilter: (tagName: string, multi: boolean) => void;
  /** 打开新建自定义动态视图弹窗回调。 */
  onOpenCreateView: () => void;
  /** 打开编辑自定义动态视图弹窗回调。 */
  onOpenEditView: (view: api.TaskFilterViewDef) => void;
  /** 删除自定义动态视图回调。 */
  onDeleteView: (viewId: string, viewName: string) => Promise<void>;
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
  /** 可选无状态反方红军角色列表。 */
  personas?: readonly api.PersonaSummary[];
  /** 可选召唤红军角色无状态拍砖回调。 */
  onPersonaReview?: (
    taskId: string,
    personaId: string,
    prompt?: string,
  ) => Promise<boolean>;
  /** 新建自定义分组回调。 */
  onCreateList: (name: string, icon: string) => Promise<void>;
  /** 打开分组视图编辑弹窗回调。 */
  onOpenEditList: (list: api.TaskListDef) => void;
  /** 删除自定义分组回调。 */
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
const DEFAULT_SIDEBAR_WIDTH = 236;
const MIN_SIDEBAR_WIDTH = 168;
const MAX_SIDEBAR_WIDTH = 380;
const DEFAULT_DETAIL_WIDTH = 440;
const MIN_DETAIL_WIDTH = 300;
const MAX_DETAIL_WIDTH = 860;
const WIDE_DETAIL_WIDTH = 720;
const DEFAULT_TAG_VISIBLE_LIMIT = 12;

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

/** 渲染单行任务的前 3 个可点击标签胶囊及 +N 溢出徽标。 */
function renderRowTagPills(
  tags: readonly string[] | undefined,
  activeTags: readonly string[],
  onClickTag: (tagName: string) => void,
): react.JSX.Element | null {
  const list = tags ?? [];
  if (list.length === 0) return null;

  const shown = list.slice(0, 3);
  const rest = list.slice(3);
  return (
    <>
      {shown.map((tag) => (
        <button
          key={tag}
          type="button"
          className="tick-task-row__tag"
          data-active={activeTags.includes(tag)}
          title={`点击加入/移除 #${tag} 动态筛选`}
          onClick={(e) => {
            e.stopPropagation();
            onClickTag(tag);
          }}
        >
          #{tag}
        </button>
      ))}
      {rest.length > 0 && (
        <span
          className="tick-task-row__tag tick-task-row__tag--more"
          title={`更多标签：${rest.map((t) => `#${t}`).join(' ')}`}
        >
          +{String(rest.length)}
        </span>
      )}
    </>
  );
}

/** AI工作台三栏主组件。 */
export function TickListView(props: TickListViewProps): react.JSX.Element {
  const {
    allTasks,
    filteredActiveTasks,
    filteredWithDoneTasks,
    lists,
    views,
    tagEntries,
    todayStr,
    scope,
    onChangeScope,
    adhocRule,
    onChangeAdhocRule,
    onToggleTagFilter,
    onOpenCreateView,
    onOpenEditView,
    onDeleteView,
    selectedTaskId,
    onSelectTask,
    onCreateTask,
    onPatchTask,
    onDeleteTask,
    onAppendEvent,
    personas,
    onPersonaReview,
    onCreateList,
    onOpenEditList,
    onDeleteList,
  } = props;

  const [sortMode, setSortMode] = react.useState<utils.TickSortMode>('default');
  const [collapsedIds, setCollapsedIds] = react.useState<ReadonlySet<string>>(() => new Set());
  const [completedOpen, setCompletedOpen] = react.useState(true);
  //M 窄屏手机（<800px）默认收起左侧导航栏，让中栏节点列表完整占满视口宽度。
  const [sidebarOpen, setSidebarOpen] = react.useState(() => {
    if (typeof window === 'undefined') return true;

    return window.innerWidth >= 800;
  });

  //M 左侧分组视图与核心标签池折叠、迷你搜标签、展开低频标签及多选开关。
  const [groupsFolded, setGroupsFolded] = react.useState(false);
  const [tagsFolded, setTagsFolded] = react.useState(false);
  const [tagSearch, setTagSearch] = react.useState('');
  const [showAllTags, setShowAllTags] = react.useState(false);
  const [multiTagPin, setMultiTagPin] = react.useState(false);

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

  //M 顶部按需展开快速添加栏状态（默认不占行高，点中栏头部「+ 新建」展开）。
  const [quickAddOpen, setQuickAddOpen] = react.useState(false);
  const [quickTitle, setQuickTitle] = react.useState('');
  const [quickDue, setQuickDue] = react.useState<string>('');
  const [quickQuadrant, setQuickQuadrant] = react.useState<api.TickQuadrant>('q2');
  const [quickDueOpen, setQuickDueOpen] = react.useState(false);

  //M 中栏列表行内就地编辑标题状态（支持桌面端双击标题或双端点击 ✎ 按钮）。
  const [editingRowId, setEditingRowId] = react.useState<string | undefined>(undefined);
  const [editingRowTitle, setEditingRowTitle] = react.useState('');
  const cancelRowEditRef = react.useRef(false);

  //M 左侧新建/删除分组与动态视图内联确认状态（零原生弹窗）。
  const [addingList, setAddingList] = react.useState(false);
  const [newListName, setNewListName] = react.useState('');
  const [newListIcon, setNewListIcon] = react.useState('📋');
  const [confirmDeleteListId, setConfirmDeleteListId] = react.useState<string | undefined>(undefined);
  const [confirmDeleteViewId, setConfirmDeleteViewId] = react.useState<string | undefined>(undefined);
  const [confirmTrashTaskId, setConfirmTrashTaskId] = react.useState<string | undefined>(undefined);

  const normalTasks = react.useMemo(() => {
    return allTasks.filter((item) => utils.getTaskKind(item) === 'task');
  }, [allTasks]);

  const activeNormalTasks = react.useMemo(() => {
    return normalTasks.filter((item) => !utils.isTaskTrashed(item));
  }, [normalTasks]);

  const trashedTasks = react.useMemo(() => {
    return normalTasks.filter((item) => utils.isTaskTrashed(item));
  }, [normalTasks]);

  //M 全部侧边栏徽标统一走同一套 matchesTaskFilterRule 规则引擎计算！
  const sidebarCounts = react.useMemo(() => {
    const smartCounts = new Map<filterEngine.SmartViewKey, number>();
    for (const def of filterEngine.SMART_VIEW_DEFS) {
      const cnt = activeNormalTasks.filter((item) => {
        return filterEngine.matchesTaskFilterRule(item, def.rule, todayStr);
      }).length;
      smartCounts.set(def.key, cnt);
    }

    const viewCounts = new Map<string, number>();
    for (const view of views) {
      const cnt = activeNormalTasks.filter((item) => {
        return filterEngine.matchesTaskFilterRule(item, view.rule, todayStr);
      }).length;
      viewCounts.set(view.id, cnt);
    }

    const listCounts = new Map<string, number>();
    for (const list of lists) {
      const cnt = activeNormalTasks.filter((item) => {
        return filterEngine.matchesTaskFilterRule(item, { lists: [list.name] }, todayStr);
      }).length;
      listCounts.set(list.name, cnt);
    }

    let completedCount = 0;
    for (const item of activeNormalTasks) {
      if (utils.isTaskDone(item)) {
        completedCount += 1;
      }
    }

    return {
      smartCounts,
      viewCounts,
      listCounts,
      completedCount,
      trashCount: trashedTasks.length,
    };
  }, [activeNormalTasks, views, lists, trashedTasks.length, todayStr]);

  //M 计算中栏待办树节点与已完成节点列表。
  const { pendingTasks, doneTasks } = react.useMemo(() => {
    if (scope.kind === 'trash') {
      return { pendingTasks: trashedTasks, doneTasks: [] as api.ControlTask[] };
    }
    if (scope.kind === 'completed') {
      const finished = activeNormalTasks.filter((item) => {
        if (!utils.isTaskDone(item)) return false;

        return filterEngine.matchesTaskFilterRule(
          item,
          { ...adhocRule, includeDone: true },
          todayStr,
        );
      });
      return { pendingTasks: [] as api.ControlTask[], doneTasks: finished };
    }

    const explicitDoneFilter = adhocRule.statuses?.includes('done') ?? false;
    const pending: api.ControlTask[] = [];
    for (const item of filteredActiveTasks) {
      if (!explicitDoneFilter && utils.isTaskDone(item)) {
        continue;
      }
      pending.push(item);
    }

    const done: api.ControlTask[] = [];
    if (!explicitDoneFilter) {
      for (const item of filteredWithDoneTasks) {
        if (utils.isTaskDone(item)) {
          done.push(item);
        }
      }
    }
    return { pendingTasks: pending, doneTasks: done };
  }, [scope, trashedTasks, activeNormalTasks, adhocRule, todayStr, filteredActiveTasks, filteredWithDoneTasks]);

  const pendingRows = react.useMemo(() => {
    return utils.buildTaskTreeRows(pendingTasks, collapsedIds, sortMode);
  }, [pendingTasks, collapsedIds, sortMode]);

  const doneRows = react.useMemo(() => {
    return utils.sortTaskList(doneTasks, 'default');
  }, [doneTasks]);

  //M 核心标签池：支持关键词即时搜全量标签 + 默认只展示高频前 N 个防滚条爆炸。
  const displayedTagEntries = react.useMemo(() => {
    const kw = tagSearch.trim().toLowerCase();
    if (kw !== '') {
      return tagEntries.filter(([name]) => name.toLowerCase().includes(kw));
    }
    if (showAllTags) return tagEntries;

    return tagEntries.slice(0, DEFAULT_TAG_VISIBLE_LIMIT);
  }, [tagEntries, tagSearch, showAllTags]);

  const activeFilterTags = adhocRule.tags ?? [];
  const activeTagMode: api.TaskTagMode = adhocRule.tagMode ?? 'and';
  const selectedTask = allTasks.find((item) => item.id === selectedTaskId);
  const headerMeta = filterEngine.getScopeHeaderMeta(scope, lists, views);

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

  /** 回车提交快捷新建节点（自动继承当前视图的分组、日期与激活筛选标签）。 */
  const handleQuickCreate = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const parsed = utils.parseQuickTaskInput(quickTitle);
    if (parsed.title === '') return;

    const currentBase = filterEngine.getScopeBaseRule(scope, views);
    let targetList = '工作任务';
    if (scope.kind === 'smart' && scope.key === 'inbox') {
      targetList = '收集箱';
    }
    if (scope.kind === 'list') {
      targetList = scope.name;
    }
    if (currentBase.lists !== undefined && currentBase.lists.length > 0) {
      targetList = currentBase.lists[0]!;
    }

    let dueDate: string | null = null;
    if (quickDue !== '') {
      dueDate = quickDue;
    }
    const isTodayOrNext7 =
      scope.kind === 'smart' && (scope.key === 'today' || scope.key === 'next7');
    if (dueDate === null && isTodayOrNext7) {
      dueDate = todayStr;
    }

    const tags = [...parsed.tags];
    for (const inheritedTag of [...(currentBase.tags ?? []), ...activeFilterTags]) {
      if (!tags.includes(inheritedTag)) {
        tags.push(inheritedTag);
      }
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

  /** 在左侧栏切换视图范围（窄屏浮层模式下自动收起抽屉）。 */
  const selectScopeFromSidebar = (next: filterEngine.WorkbenchScope): void => {
    onChangeScope(next);
    if (typeof window !== 'undefined' && window.innerWidth < 800) {
      setSidebarOpen(false);
    }
  };

  /** 进入中栏行内标题就地编辑态。 */
  const startInlineEdit = (task: api.ControlTask): void => {
    cancelRowEditRef.current = false;
    setEditingRowId(task.id);
    setEditingRowTitle(task.title);
  };

  /** 取消中栏行内标题编辑。 */
  const cancelInlineEdit = (): void => {
    cancelRowEditRef.current = true;
    setEditingRowId(undefined);
    setEditingRowTitle('');
  };

  /** 提交保存中栏行内修改的标题。 */
  const commitInlineEdit = async (task: api.ControlTask): Promise<void> => {
    if (cancelRowEditRef.current) {
      cancelRowEditRef.current = false;
      return;
    }
    setEditingRowId(undefined);
    const cleaned = editingRowTitle.trim();
    if (cleaned === '' || cleaned === task.title) return;

    await onPatchTask(task.id, { title: cleaned, by: 'boss' }, '已更新节点标题');
  };

  /** 渲染任务行标题：桌面端（>799px）单击标题文字本身直接选中并就地改名，手机端交由详情抽屉修改。 */
  const renderRowTitleArea = (item: api.ControlTask): react.JSX.Element => {
    if (editingRowId === item.id) {
      return (
        <input
          type="text"
          className="tick-task-row__title-input"
          value={editingRowTitle}
          aria-label="修改节点标题"
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEditingRowTitle(e.target.value)}
          onBlur={() => void commitInlineEdit(item)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelInlineEdit();
            }
          }}
        />
      );
    }
    return (
      <>
        <span
          className="tick-task-row__title"
          title="点击直接修改标题"
          onClick={(e) => {
            if (typeof window !== 'undefined' && window.innerWidth <= 799) return;

            e.stopPropagation();
            onSelectTask(item.id);
            startInlineEdit(item);
          }}
        >
          {item.title}
        </span>
        <span className="tick-task-row__spacer" aria-hidden="true" />
      </>
    );
  };

  /** 提交新建分组。 */
  const handleSubmitNewList = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const cleaned = newListName.trim();
    if (cleaned === '') return;

    await onCreateList(cleaned, newListIcon);
    setNewListName('');
    setAddingList(false);
    selectScopeFromSidebar({ kind: 'list', name: cleaned });
  };

  const canQuickAdd = scope.kind !== 'completed' && scope.kind !== 'trash';
  const showCompletedSection =
    scope.kind !== 'completed' && scope.kind !== 'trash' && doneRows.length > 0;
  let quickDueText = '';
  if (quickDue !== '') {
    quickDueText = utils.formatShortDate(quickDue, todayStr);
  }
  const tomorrowStr = utils.addDaysStr(todayStr, 1);

  /** 开始拖拽左侧栏或右侧详情栏分割条。 */
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

  let nextTagMode: api.TaskTagMode = 'or';
  if (activeTagMode === 'or') {
    nextTagMode = 'and';
  }
  let tagModeShort = '且';
  if (activeTagMode === 'or') {
    tagModeShort = '或';
  }

  return (
    <div className="tick-three-col" style={columnVars}>
      {/* 左栏：上部独立可滚动区（智能视图 / 动态筛选器 / 分组视图 / 核心标签池） + 底部固定贴底区（已完成 & 垃圾桶） */}
      {sidebarOpen && (
        <>
          <div
            className="tick-sidebar-backdrop"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="tick-sidebar" aria-label="视图与标签导航">
            <div className="tick-sidebar__scroll">
              {/* 1. 智能视图 */}
              <div className="tick-sidebar__section">
                <div className="tick-sidebar__section-head">
                  <span>智能视图</span>
                </div>
                <div className="tick-sidebar__group">
                  {filterEngine.SMART_VIEW_DEFS.map((meta) => {
                    const active = scope.kind === 'smart' && scope.key === meta.key;
                    const count = sidebarCounts.smartCounts.get(meta.key) ?? 0;
                    let countClass = 'tick-nav-item__count';
                    if (count > 0 && meta.accent === 'amber') {
                      countClass = 'tick-nav-item__count tick-nav-item__count--amber';
                    }
                    if (count > 0 && meta.accent === 'blue') {
                      countClass = 'tick-nav-item__count tick-nav-item__count--blue';
                    }
                    return (
                      <button
                        key={meta.key}
                        type="button"
                        className="tick-nav-item"
                        data-active={active}
                        onClick={() => selectScopeFromSidebar({ kind: 'smart', key: meta.key })}
                      >
                        <span className="tick-nav-item__icon">{meta.icon}</span>
                        <span className="tick-nav-item__label">{meta.label}</span>
                        {count > 0 && <span className={countClass}>{String(count)}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="tick-sidebar__divider" />

              {/* 2. 动态筛选器 / 自定义视图 */}
              <div className="tick-sidebar__section">
                <div className="tick-sidebar__section-head">
                  <span>动态筛选器</span>
                  <button
                    type="button"
                    className="tick-sidebar__add-btn"
                    title="新建自定义动态筛选视图"
                    aria-label="新建自定义动态筛选视图"
                    onClick={onOpenCreateView}
                  >
                    +
                  </button>
                </div>

                {views.length === 0 && (
                  <div className="tick-sidebar__hint-box">
                    在顶部组合标签/属性后点「存为视图」，或点右上 + 创建专属视图
                  </div>
                )}

                {views.length > 0 && (
                  <div className="tick-sidebar__group">
                    {views.map((view) => {
                      const active = scope.kind === 'view' && scope.viewId === view.id;
                      const count = sidebarCounts.viewCounts.get(view.id) ?? 0;
                      const confirming = confirmDeleteViewId === view.id;
                      const ruleTip = filterEngine.describeFilterRule(view.rule).join(' · ');
                      let viewDotStyle: react.CSSProperties | undefined;
                      if (view.color !== undefined && view.color !== '') {
                        viewDotStyle = { color: view.color };
                      }
                      let viewTip = ruleTip;
                      if (viewTip === '') {
                        viewTip = '双击或点右侧 ✎ 编辑动态筛选器';
                      }
                      return (
                        <div key={view.id} className="tick-nav-item-wrap" data-active={active}>
                          <button
                            type="button"
                            className="tick-nav-item"
                            data-active={active}
                            title={viewTip}
                            onClick={() => {
                              setConfirmDeleteViewId(undefined);
                              selectScopeFromSidebar({ kind: 'view', viewId: view.id });
                            }}
                            onDoubleClick={() => onOpenEditView(view)}
                          >
                            <span className="tick-nav-item__icon" style={viewDotStyle}>
                              {view.icon ?? '🔖'}
                            </span>
                            <span className="tick-nav-item__label">{view.name}</span>
                            {count > 0 && (
                              <span className="tick-nav-item__count">{String(count)}</span>
                            )}
                          </button>
                          {!confirming && (
                            <div className="tick-nav-item__hover-ops">
                              <button
                                type="button"
                                className="tick-nav-item__op-btn"
                                title={`编辑视图「${view.name}」`}
                                aria-label={`编辑视图 ${view.name}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenEditView(view);
                                }}
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className="tick-nav-item__op-btn tick-nav-item__op-btn--del"
                                title={`删除视图「${view.name}」`}
                                aria-label={`删除视图 ${view.name}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDeleteViewId(view.id);
                                }}
                              >
                                ×
                              </button>
                            </div>
                          )}
                          {confirming && (
                            <button
                              type="button"
                              className="tick-nav-item__del-confirm"
                              onClick={() => {
                                setConfirmDeleteViewId(undefined);
                                void onDeleteView(view.id, view.name);
                              }}
                            >
                              确认删
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="tick-sidebar__divider" />

              {/* 3. 分组视图（原清单，可折叠） */}
              <div className="tick-sidebar__section">
                <div className="tick-sidebar__section-head">
                  <button
                    type="button"
                    className="tick-sidebar__fold-head"
                    aria-expanded={!groupsFolded}
                    onClick={() => setGroupsFolded((prev) => !prev)}
                  >
                    <span>{groupsFolded && '▸'}{!groupsFolded && '▾'}</span>
                    <span>分组视图</span>
                    <span className="tick-sidebar__head-count">{String(lists.length)}</span>
                  </button>
                  <button
                    type="button"
                    className="tick-sidebar__add-btn"
                    title="新建分组"
                    aria-label="新建分组"
                    onClick={() => {
                      setGroupsFolded(false);
                      setAddingList((prev) => !prev);
                    }}
                  >
                    +
                  </button>
                </div>

                {!groupsFolded && addingList && (
                  <form
                    className="tick-inline-list-form"
                    onSubmit={(e) => void handleSubmitNewList(e)}
                  >
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
                        placeholder="输入分组名称…"
                        autoFocus
                        onChange={(e) => setNewListName(e.target.value)}
                      />
                      <button type="submit" className="tick-mini-btn tick-mini-btn--primary">
                        添加
                      </button>
                    </div>
                  </form>
                )}

                {!groupsFolded && (
                  <div className="tick-sidebar__group">
                    {lists.map((item) => {
                      const active = scope.kind === 'list' && scope.name === item.name;
                      const count = sidebarCounts.listCounts.get(item.name) ?? 0;
                      const deletable =
                        !utils.SYSTEM_LIST_NAMES.has(item.name)
                        && !item.id.startsWith('virtual-');
                      const confirming = confirmDeleteListId === item.id;
                      let listIconStyle: react.CSSProperties | undefined;
                      if (item.color !== undefined && item.color !== '') {
                        listIconStyle = { color: item.color };
                      }
                      return (
                        <div key={item.id} className="tick-nav-item-wrap" data-active={active}>
                          <button
                            type="button"
                            className="tick-nav-item"
                            data-active={active}
                            title="点击查看 · 双击或点右侧 ✎ 修改分组"
                            onClick={() => {
                              setConfirmDeleteListId(undefined);
                              selectScopeFromSidebar({ kind: 'list', name: item.name });
                            }}
                            onDoubleClick={() => onOpenEditList(item)}
                          >
                            <span className="tick-nav-item__icon" style={listIconStyle}>
                              {item.icon ?? '📋'}
                            </span>
                            <span className="tick-nav-item__label">{item.name}</span>
                            {count > 0 && (
                              <span className="tick-nav-item__count">{String(count)}</span>
                            )}
                          </button>
                          {!confirming && (
                            <div className="tick-nav-item__hover-ops">
                              <button
                                type="button"
                                className="tick-nav-item__op-btn"
                                title={`编辑分组「${item.name}」`}
                                aria-label={`编辑分组 ${item.name}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenEditList(item);
                                }}
                              >
                                ✎
                              </button>
                              {deletable && (
                                <button
                                  type="button"
                                  className="tick-nav-item__op-btn tick-nav-item__op-btn--del"
                                  title={`删除分组「${item.name}」`}
                                  aria-label={`删除分组 ${item.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmDeleteListId(item.id);
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          )}
                          {deletable && confirming && (
                            <button
                              type="button"
                              className="tick-nav-item__del-confirm"
                              onClick={() => {
                                setConfirmDeleteListId(undefined);
                                void onDeleteList(item.id, item.name);
                                if (active) {
                                  onChangeScope({ kind: 'smart', key: 'all' });
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
                )}
              </div>

              <div className="tick-sidebar__divider" />

              {/* 4. 核心标签池（可折叠 + 顶部迷你搜标签框 + 单选/多选叠加 + AND/OR 切换） */}
              <div className="tick-sidebar__section">
                <div className="tick-sidebar__section-head">
                  <button
                    type="button"
                    className="tick-sidebar__fold-head"
                    aria-expanded={!tagsFolded}
                    onClick={() => setTagsFolded((prev) => !prev)}
                  >
                    <span>{tagsFolded && '▸'}{!tagsFolded && '▾'}</span>
                    <span>核心标签池</span>
                    <span className="tick-sidebar__head-count">{String(tagEntries.length)}</span>
                  </button>
                  <div className="tick-tag-pool__tools">
                    <button
                      type="button"
                      className="tick-tag-pool__mini-pill"
                      data-active={multiTagPin}
                      title="开启后直接点击即可连续多选叠加多个标签（或按住 Ctrl/Shift 点击）"
                      onClick={() => setMultiTagPin((prev) => !prev)}
                    >
                      多选
                    </button>
                    <button
                      type="button"
                      className="tick-tag-pool__mini-pill"
                      data-active={activeFilterTags.length > 1}
                      title="切换多标签组合关系：且 (AND) / 或 (OR)"
                      onClick={() => onChangeAdhocRule({ ...adhocRule, tagMode: nextTagMode })}
                    >
                      {tagModeShort}
                    </button>
                  </div>
                </div>

                {!tagsFolded && tagEntries.length === 0 && (
                  <div className="tick-sidebar__hint-box">
                    在新建节点时输入 #标签 即可自动归入标签池并跨视图筛选
                  </div>
                )}

                {!tagsFolded && tagEntries.length > 0 && (
                  <>
                    <div className="tick-tag-pool__search-row">
                      <input
                        type="text"
                        className="tick-tag-pool__search"
                        value={tagSearch}
                        placeholder="搜标签…"
                        aria-label="搜索标签池"
                        onChange={(e) => setTagSearch(e.target.value)}
                      />
                      {activeFilterTags.length > 0 && (
                        <button
                          type="button"
                          className="tick-tag-pool__clear"
                          title="清空已选标签筛选"
                          onClick={() => onChangeAdhocRule({ ...adhocRule, tags: undefined })}
                        >
                          清空
                        </button>
                      )}
                    </div>

                    <div className="tick-sidebar__group">
                      {displayedTagEntries.map(([tagName, tagCount]) => {
                        const selected = activeFilterTags.includes(tagName);
                        return (
                          <div key={tagName} className="tick-tag-pool__row">
                            <button
                              type="button"
                              className="tick-nav-item tick-nav-item--tag"
                              data-active={selected}
                              title="点击按此标签筛选 · 按住 Ctrl/Shift 或点右侧 + 多选叠加"
                              onClick={(e) => {
                                const useMulti =
                                  multiTagPin || e.ctrlKey || e.metaKey || e.shiftKey;
                                onToggleTagFilter(tagName, useMulti);
                              }}
                            >
                              <span className="tick-nav-item__icon tick-nav-item__icon--hash">
                                #
                              </span>
                              <span className="tick-nav-item__label">{tagName}</span>
                              <span className="tick-nav-item__count">{String(tagCount)}</span>
                            </button>
                            <button
                              type="button"
                              className="tick-tag-pool__stack-btn"
                              data-selected={selected}
                              title={`将 #${tagName} 叠加/移除多选筛选`}
                              aria-label={`叠加筛选标签 ${tagName}`}
                              onClick={() => onToggleTagFilter(tagName, true)}
                            >
                              {selected && '✓'}
                              {!selected && '+'}
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {tagSearch.trim() === '' && tagEntries.length > DEFAULT_TAG_VISIBLE_LIMIT && (
                      <button
                        type="button"
                        className="tick-tag-pool__more-btn"
                        onClick={() => setShowAllTags((prev) => !prev)}
                      >
                        {showAllTags && '收起低频标签 ▴'}
                        {!showAllTags && `展开全部 (${String(tagEntries.length)}) ▾`}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* 底部固定吸底系统箱：永不被长标签或长分组挤出视口！ */}
            <div className="tick-sidebar__footer">
              <button
                type="button"
                className="tick-nav-item tick-nav-item--compact"
                data-active={scope.kind === 'completed'}
                onClick={() => selectScopeFromSidebar({ kind: 'completed' })}
              >
                <span className="tick-nav-item__icon">☑️</span>
                <span className="tick-nav-item__label">已完成</span>
                {sidebarCounts.completedCount > 0 && (
                  <span className="tick-nav-item__count">
                    {String(sidebarCounts.completedCount)}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="tick-nav-item tick-nav-item--compact"
                data-active={scope.kind === 'trash'}
                onClick={() => selectScopeFromSidebar({ kind: 'trash' })}
              >
                <span className="tick-nav-item__icon">🗑️</span>
                <span className="tick-nav-item__label">垃圾桶</span>
                {sidebarCounts.trashCount > 0 && (
                  <span className="tick-nav-item__count">
                    {String(sidebarCounts.trashCount)}
                  </span>
                )}
              </button>
            </div>
          </aside>

          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整左侧导航栏宽度（双击恢复默认）"
            title="拖动调整侧栏宽度 · 双击恢复默认"
            className="tick-resizer"
            data-dragging={draggingSide === 'sidebar'}
            onPointerDown={(e) => startResize('sidebar', e)}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          />
        </>
      )}

      {/* 中栏：标题、快速添加与多级父子文档节点树 */}
      <section className="tick-list-main" aria-label="文档节点列表">
        <header className="tick-list-header">
          <div className="tick-list-header__left">
            <button
              type="button"
              className="tick-icon-btn"
              title="切换左侧导航栏"
              aria-label="切换左侧导航栏"
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
            {canQuickAdd && (
              <button
                type="button"
                className="tick-header-add-btn"
                data-active={quickAddOpen}
                title="展开或收起快速新建框"
                aria-expanded={quickAddOpen}
                onClick={() => {
                  setQuickAddOpen((prev) => !prev);
                  setQuickDueOpen(false);
                }}
              >
                {quickAddOpen && '✕ 收起'}
                {!quickAddOpen && '+ 新建'}
              </button>
            )}
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

        {/* 按需展开的快速添加输入框（默认收起不占行高，支持 #标签 + 日期 + 象限 + Esc 收起） */}
        {canQuickAdd && quickAddOpen && (
          <form className="tick-quick-add" onSubmit={(e) => void handleQuickCreate(e)}>
            <span className="tick-quick-add__plus" aria-hidden="true">
              +
            </span>
            <input
              type="text"
              className="tick-quick-add__input"
              value={quickTitle}
              autoFocus
              placeholder={`新建节点至「${headerMeta.title}」，输入 #标签 自动打标，回车创建（Esc 收起）…`}
              onChange={(e) => setQuickTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setQuickDueOpen(false);
                  setQuickAddOpen(false);
                }
              }}
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
          {scope.kind === 'trash' && (
            <div className="tick-trash-tip">
              垃圾桶中的节点不会出现在四象限、日历与 AI 控制面中；可随时还原或永久删除。
            </div>
          )}

          {pendingRows.length === 0 && doneRows.length === 0 && (
            <div className="tick-list-empty">
              <p>当前筛选条件下暂无节点</p>
              {canQuickAdd && !quickAddOpen && (
                <button
                  type="button"
                  className="tick-header-add-btn"
                  onClick={() => setQuickAddOpen(true)}
                >
                  + 新建节点
                </button>
              )}
              {canQuickAdd && quickAddOpen && (
                <span>在上方新建框输入标题（支持 #标签）回车创建，按 Esc 收起</span>
              )}
            </div>
          )}

          {pendingRows.map((row) => {
            const item = row.task;
            const quadrant = utils.getEffectiveQuadrant(item);
            const selected = item.id === selectedTaskId;
            const done = utils.isTaskDone(item);
            const aiBadge = utils.getAiTaskBadge(item);
            const sourceBadge = filterEngine.getSourceChannelBadge(item);
            const isTrashView = scope.kind === 'trash';
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

            let foldLabel = '折叠子节点';
            if (row.collapsed) {
              foldLabel = '展开子节点';
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

                {renderRowTitleArea(item)}

                {sourceBadge !== undefined && (
                  <span className="tick-source-badge">{sourceBadge}</span>
                )}

                {aiBadge !== undefined && (
                  <span className="tick-ai-badge" data-status={aiBadge.status}>
                    {aiBadge.text}
                  </span>
                )}

                {renderRowTagPills(item.tags, activeFilterTags, (tag) =>
                  onToggleTagFilter(tag, true),
                )}

                {row.childCount > 0 && (
                  <span className="tick-task-row__tree" title={`${String(row.childCount)} 个子节点`}>
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
                        void onPatchTask(item.id, { trashedAt: null, by: 'boss' }, '已还原节点');
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
          {scope.kind === 'completed' &&
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
                  {renderRowTitleArea(item)}
                  {renderRowTagPills(item.tags, activeFilterTags, (tag) =>
                    onToggleTagFilter(tag, true),
                  )}
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
                      {renderRowTitleArea(item)}
                      {renderRowTagPills(item.tags, activeFilterTags, (tag) =>
                        onToggleTagFilter(tag, true),
                      )}
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
          allTasks={allTasks}
          lists={lists}
          todayStr={todayStr}
          wideRead={detailWidth >= WIDE_DETAIL_WIDTH - 20}
          onToggleWideRead={toggleWideRead}
          onClose={() => onSelectTask(undefined)}
          onSelectTask={(id) => onSelectTask(id)}
          onPatchTask={onPatchTask}
          onCreateTask={onCreateTask}
          onAppendEvent={onAppendEvent}
          personas={personas}
          onPersonaReview={onPersonaReview}
          onDeleteTask={onDeleteTask}
        />
      </div>
    </div>
  );
}
