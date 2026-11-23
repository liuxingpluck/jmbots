/** 积木AI工作台主壳：52px 极窄深黑图标导航栏 + 顶部动态组合筛选条 + 列表/日历/四象限/纪念日/习惯/搜索。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as calendarView from './TickCalendarView.tsx';
import * as extraViews from './TickExtraViews.tsx';
import * as filterBar from './TickFilterBar.tsx';
import * as listView from './TickListView.tsx';
import * as quadrantView from './TickQuadrantView.tsx';
import * as utils from './TickUtils.ts';
import * as filterEngine from './WorkbenchFilter.ts';
import './TickWorkspace.css';

/** 积木AI工作台主组件入参（与 AI 任务控制面共用同一份原子任务数据底座）。 */
export interface TickWorkspaceProps {
  /** 共享的任务、分组与自定义动态视图快照。 */
  board: api.ControlTaskListResponse | undefined;
  /** 是否正在首次加载。 */
  loading: boolean;
  /** 触发刷新共享任务与视图数据（silent=true 时静默同步）。 */
  onRefresh: (silent?: boolean) => Promise<void>;
  /** 当前工作台是否处于可见激活态（控制快捷键监听）。 */
  active: boolean;
}

/** 内置动态视图弹窗状态。 */
type ViewModalState =
  | { mode: 'create'; initialRule: api.TaskFilterRule }
  | { mode: 'edit'; view: api.TaskFilterViewDef };

/** 渲染极简线条 SVG 导航图标。 */
function renderRailIcon(
  kind: utils.TickNavMode | 'search' | 'refresh',
): react.JSX.Element {
  if (kind === 'list') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9">
        <rect x="4" y="4" width="16" height="16" rx="3.5" />
        <path d="M8.5 12.2l2.4 2.4 4.8-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'calendar') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9">
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
        <path d="M8 3.2v3.2M16 3.2v3.2M3.5 9.8h17" strokeLinecap="round" />
        <circle cx="9" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (kind === 'quadrant') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9">
        <rect x="4" y="4" width="6.8" height="6.8" rx="1.6" />
        <rect x="13.2" y="4" width="6.8" height="6.8" rx="1.6" />
        <rect x="4" y="13.2" width="6.8" height="6.8" rx="1.6" />
        <rect x="13.2" y="13.2" width="6.8" height="6.8" rx="1.6" />
      </svg>
    );
  }
  if (kind === 'countdown') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9">
        <rect x="4" y="5" width="16" height="15" rx="2.5" />
        <path d="M8 3.2v3M16 3.2v3" strokeLinecap="round" />
        <path
          d="M12 9.2l1.1 2.2 2.4.4-1.7 1.7.4 2.4-2.2-1.1-2.2 1.1.4-2.4-1.7-1.7 2.4-.4L12 9.2z"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'habit') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9">
        <circle cx="12" cy="12" r="8.2" />
        <path d="M12 7.8v4.6l3.2 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'search') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.2 4.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M20 12a8 8 0 1 1-2.3-5.6" strokeLinecap="round" />
      <path d="M20 4.5v4.2h-4.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 左侧极窄导航按钮配置。 */
const RAIL_ITEMS: ReadonlyArray<{ key: utils.TickNavMode; title: string }> = [
  { key: 'list', title: '节点列表' },
  { key: 'calendar', title: '日历' },
  { key: 'quadrant', title: '四象限' },
  { key: 'countdown', title: '倒数纪念日' },
  { key: 'habit', title: '习惯' },
];

/** 从地址栏读取 ?task=<id> 深链接任务号。 */
function readTaskParamFromUrl(): string | undefined {
  try {
    const raw = new URLSearchParams(window.location.search).get('task');
    if (raw === null) return undefined;

    const trimmed = raw.trim();
    if (trimmed === '') return undefined;

    return trimmed;
  } catch {
    return undefined;
  }
}

/** 平滑同步 ?task= 查询参数（保留 tab=tick / tab=workbench、token 等既有参数）。 */
function syncTaskParamToUrl(taskId: string | undefined): void {
  try {
    const url = new URL(window.location.href);
    if (taskId === undefined || taskId === '') {
      url.searchParams.delete('task');
    }
    if (taskId !== undefined && taskId !== '') {
      url.searchParams.set('task', taskId);
    }
    const nextHref = `${url.pathname}${url.search}${url.hash}`;
    const curHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextHref === curHref) return;

    window.history.replaceState(window.history.state, '', nextHref);
  } catch {
    return;
  }
}

/** 构造批示落盘与单向唤醒后的轻提示文案。 */
function formatAppendEventToast(
  notifyHelper: string | undefined,
  wakeup: api.ControlTaskNotifications['wakeup'] | undefined,
): string {
  if (notifyHelper === undefined || notifyHelper === '') {
    return '已记录批示';
  }
  let helperLabel = notifyHelper;
  if (notifyHelper === 'Claude') {
    helperLabel = '哈基米';
  }
  if (notifyHelper === 'HanXin') {
    helperLabel = '韩信';
  }
  if (wakeup !== undefined && !wakeup.ok) {
    const reason = wakeup.reason ?? '唤醒通道未配置';
    return `已记录批示（${helperLabel}唤醒未投递：${reason}）`;
  }
  return `已记录并唤醒 ${helperLabel}`;
}

/** 积木AI工作台主组件。 */
export function TickWorkspace(props: TickWorkspaceProps): react.JSX.Element {
  const { board, loading, onRefresh, active } = props;

  const [navMode, setNavMode] = react.useState<utils.TickNavMode>('list');
  const [scope, setScope] = react.useState<filterEngine.WorkbenchScope>({
    kind: 'smart',
    key: 'all',
  });
  const [adhocRule, setAdhocRule] = react.useState<api.TaskFilterRule>({});
  const [selectedTaskId, setSelectedTaskId] = react.useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = react.useState(false);
  const [viewModal, setViewModal] = react.useState<ViewModalState | undefined>(undefined);
  const [personas, setPersonas] = react.useState<readonly api.PersonaSummary[]>([]);
  const [toast, setToast] = react.useState<{ kind: 'ok' | 'err'; text: string } | undefined>(
    undefined,
  );
  const toastTimerRef = react.useRef<number | undefined>(undefined);
  const pendingDeepLinkRef = react.useRef<string | undefined>(readTaskParamFromUrl());
  const deepLinkCheckedRef = react.useRef(false);

  //M 初始化拉取可用无状态反方红军角色列表（失败静默降级为空数组，不影响基础工作台功能）。
  react.useEffect(() => {
    const controller = new AbortController();
    api
      .getPersonas(controller.signal)
      .then((res) => {
        setPersonas(res.personas);
      })
      .catch(() => {
        setPersonas([]);
      });
    return () => controller.abort();
  }, []);

  const todayStr = utils.getTodayStr();
  const tasks = board?.tasks ?? [];
  const views = board?.views ?? [];
  const lists = react.useMemo(() => {
    return utils.resolveVisibleLists(board?.lists, tasks);
  }, [board?.lists, tasks]);

  const tagEntries = react.useMemo(() => {
    return filterEngine.collectTagCounts(tasks);
  }, [tasks]);

  //M 若当前选中的自定义动态视图已被删除，自动退回「全部节点」。
  react.useEffect(() => {
    if (scope.kind !== 'view') return;
    if (board === undefined) return;

    const stillExists = views.some((item) => item.id === scope.viewId);
    if (!stillExists) {
      setScope({ kind: 'smart', key: 'all' });
    }
  }, [board, scope, views]);

  //M 计算统一动态筛选规则与投影给三大视图（列表、四象限、日历）的同一份任务集合。
  const baseRule = react.useMemo(() => {
    return filterEngine.getScopeBaseRule(scope, views);
  }, [scope, views]);

  const filteredActiveTasks = react.useMemo(() => {
    return tasks.filter((item) => {
      return filterEngine.matchesCombinedRules(item, baseRule, adhocRule, todayStr, false);
    });
  }, [tasks, baseRule, adhocRule, todayStr]);

  const filteredWithDoneTasks = react.useMemo(() => {
    const hasExplicitStatus =
      (baseRule.statuses?.length ?? 0) > 0 || (adhocRule.statuses?.length ?? 0) > 0;
    if (hasExplicitStatus) return filteredActiveTasks;

    return tasks.filter((item) => {
      return filterEngine.matchesCombinedRules(item, baseRule, adhocRule, todayStr, true);
    });
  }, [tasks, baseRule, adhocRule, todayStr, filteredActiveTasks]);

  /** 展示一条轻量顶部吐司。 */
  const showToast = react.useCallback((kind: 'ok' | 'err', text: string) => {
    window.clearTimeout(toastTimerRef.current);
    setToast({ kind, text });
    toastTimerRef.current = window.setTimeout(() => setToast(undefined), 3200);
  }, []);

  //M 全局快捷键：在工作台激活态按 Ctrl+K / Cmd+K 呼出搜索，Esc 关闭弹窗。
  react.useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }
      if (event.key === 'Escape' && viewModal !== undefined) {
        event.stopPropagation();
        setViewModal(undefined);
        return;
      }
      if (event.key === 'Escape' && searchOpen) {
        event.stopPropagation();
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, searchOpen, viewModal]);

  /** 统一创建任务/纪念日/习惯。 */
  const handleCreateTask = react.useCallback(
    async (
      input: api.CreateControlTaskInput,
      toastText?: string,
    ): Promise<api.ControlTask | undefined> => {
      try {
        const res = await api.createControlTask(input);
        if (toastText !== undefined) {
          showToast('ok', toastText);
        }
        await onRefresh(true);
        return res.task;
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
        return undefined;
      }
    },
    [onRefresh, showToast],
  );

  /** 统一局部更新任务。 */
  const handlePatchTask = react.useCallback(
    async (
      taskId: string,
      patch: api.PatchControlTaskInput,
      toastText?: string,
    ): Promise<void> => {
      try {
        await api.patchControlTask(taskId, patch);
        if (toastText !== undefined) {
          showToast('ok', toastText);
        }
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 统一彻底删除任务。 */
  const handleDeleteTask = react.useCallback(
    async (taskId: string): Promise<void> => {
      try {
        await api.deleteControlTask(taskId);
        setSelectedTaskId((prev) => {
          if (prev === taskId) return undefined;

          return prev;
        });
        showToast('ok', '已彻底删除');
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 统一追加 AI 协同时间线事件（支持透传 notifyHelper 与 broadcast）。 */
  const handleAppendEvent = react.useCallback(
    async (
      taskId: string,
      text: string,
      kind: api.ControlTaskEventKind,
      options?: { notifyHelper?: string; broadcast?: boolean },
    ): Promise<boolean> => {
      try {
        const payload: Parameters<typeof api.appendControlTaskEvent>[1] = {
          kind,
          by: 'boss',
          text,
        };
        if (options?.notifyHelper !== undefined && options.notifyHelper !== '') {
          payload.notifyHelper = options.notifyHelper;
        }
        if (options?.broadcast !== undefined) {
          payload.broadcast = options.broadcast;
        }
        const res = await api.appendControlTaskEvent(taskId, payload);
        showToast(
          'ok',
          formatAppendEventToast(payload.notifyHelper, res.notifications?.wakeup),
        );
        await onRefresh(true);
        return true;
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
        return false;
      }
    },
    [onRefresh, showToast],
  );

  /** 召唤无状态反方红军角色一键拍砖或带追问审阅任务卡。 */
  const handlePersonaReview = react.useCallback(
    async (
      taskId: string,
      personaId: string,
      prompt?: string,
    ): Promise<boolean> => {
      try {
        const payload: api.PersonaReviewInput = { personaId };
        if (prompt !== undefined && prompt !== '') {
          payload.prompt = prompt;
        }
        const res = await api.requestPersonaReview(taskId, payload);
        const sec = (res.durationMs / 1000).toFixed(1);
        showToast('ok', `红军拍砖已落盘（${res.event.by} · ${sec}s）`);
        await onRefresh(true);
        return true;
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
        return false;
      }
    },
    [onRefresh, showToast],
  );

  /** 切换习惯某天打卡状态。 */
  const handleToggleCheckIn = react.useCallback(
    async (taskId: string, dateStr: string): Promise<void> => {
      try {
        await api.toggleHabitCheckIn(taskId, dateStr);
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 新建自定义分组（清单）。 */
  const handleCreateList = react.useCallback(
    async (name: string, icon: string): Promise<void> => {
      try {
        await api.createTaskList({ name, icon });
        showToast('ok', `已新建分组「${name}」`);
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 删除自定义分组（清单）。 */
  const handleDeleteList = react.useCallback(
    async (listId: string, listName: string): Promise<void> => {
      try {
        await api.deleteTaskList(listId);
        showToast('ok', `已删除分组「${listName}」`);
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 提交新建或编辑自定义动态筛选视图。 */
  const handleSubmitViewModal = react.useCallback(
    async (payload: {
      name: string;
      icon: string;
      color: string;
      rule: api.TaskFilterRule;
    }): Promise<boolean> => {
      try {
        if (viewModal?.mode === 'edit' && viewModal.view !== undefined) {
          await api.patchFilterView(viewModal.view.id, payload);
          showToast('ok', `已更新视图「${payload.name}」`);
          await onRefresh(true);
          return true;
        }
        const created = await api.createFilterView(payload);
        setAdhocRule({});
        setScope({ kind: 'view', viewId: created.view.id });
        showToast('ok', `已存为视图「${created.view.name}」并钉入左侧栏`);
        await onRefresh(true);
        return true;
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
        return false;
      }
    },
    [onRefresh, showToast, viewModal],
  );

  /** 删除一条自定义动态筛选视图。 */
  const handleDeleteView = react.useCallback(
    async (viewId: string, viewName: string): Promise<void> => {
      try {
        await api.deleteFilterView(viewId);
        setScope((prev) => {
          if (prev.kind === 'view' && prev.viewId === viewId) {
            return { kind: 'smart', key: 'all' };
          }
          return prev;
        });
        showToast('ok', `已删除动态视图「${viewName}」`);
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 点击左侧标签池或列表任务行标签胶囊：单选切换或多选叠加进顶部动态筛选条。 */
  const handleToggleTagFilter = react.useCallback(
    (tagName: string, multiSelect: boolean): void => {
      setScope((prev) => {
        if (prev.kind === 'trash' || prev.kind === 'completed') {
          return { kind: 'smart', key: 'all' };
        }
        return prev;
      });
      setAdhocRule((prev) => {
        const cur = prev.tags ?? [];
        const hasTag = cur.includes(tagName);
        if (!multiSelect) {
          if (cur.length === 1 && hasTag) {
            return { ...prev, tags: undefined };
          }
          return { ...prev, tags: [tagName] };
        }
        let nextTags: string[] = [];
        if (hasTag) {
          nextTags = cur.filter((item) => item !== tagName);
        }
        if (!hasTag) {
          nextTags = [...cur, tagName];
        }
        if (nextTags.length === 0) {
          return { ...prev, tags: undefined };
        }
        return { ...prev, tags: nextTags };
      });
    },
    [],
  );

  /** 搜索结果点击或 URL 深链接定位任务：切回对应范围并选中该节点。 */
  const handleJumpTask = react.useCallback((task: api.ControlTask): void => {
    setSearchOpen(false);
    const kind = utils.getTaskKind(task);
    if (kind === 'countdown') {
      setNavMode('countdown');
      setSelectedTaskId(undefined);
      return;
    }
    if (kind === 'habit') {
      setNavMode('habit');
      setSelectedTaskId(undefined);
      return;
    }
    setNavMode('list');
    setAdhocRule({});
    if (utils.isTaskTrashed(task)) {
      setScope({ kind: 'trash' });
      setSelectedTaskId(task.id);
      return;
    }
    setScope({ kind: 'smart', key: 'all' });
    setSelectedTaskId(task.id);
  }, []);

  //M 首屏挂载且任务列表首次加载完成后，消费一次 ?task=<id> 深链接并精准定位。
  react.useEffect(() => {
    if (deepLinkCheckedRef.current) return;
    if (board === undefined) return;

    deepLinkCheckedRef.current = true;
    const targetId = pendingDeepLinkRef.current;
    pendingDeepLinkRef.current = undefined;
    if (targetId === undefined) return;

    const matched = tasks.find((item) => item.id === targetId);
    if (matched !== undefined) {
      handleJumpTask(matched);
    }
  }, [board, tasks, handleJumpTask]);

  //M 选中或取消选中任务时，平滑同步地址栏 ?task= 参数。
  react.useEffect(() => {
    if (!active) return;
    if (!deepLinkCheckedRef.current) return;

    syncTaskParamToUrl(selectedTaskId);
  }, [active, selectedTaskId]);

  /** 搜索结果点击分组：切回列表视图并打开该分组。 */
  const handleJumpList = (listName: string): void => {
    setSearchOpen(false);
    setNavMode('list');
    if (listName === '收集箱') {
      setScope({ kind: 'smart', key: 'inbox' });
      return;
    }
    setScope({ kind: 'list', name: listName });
  };

  /** 打开「存为视图」内置模态窗（自动合并当前左侧基准范围与顶部筛选条件）。 */
  const openSaveCurrentView = (): void => {
    const merged = filterEngine.mergeFilterRules(baseRule, adhocRule);
    setViewModal({ mode: 'create', initialRule: merged });
  };

  const showFilterBar =
    board !== undefined
    && (navMode === 'list' || navMode === 'quadrant' || navMode === 'calendar');

  let scopePill: filterBar.TickFilterBarProps['scopePill'];
  const isNonAllScope =
    !(scope.kind === 'smart' && scope.key === 'all')
    && scope.kind !== 'completed'
    && scope.kind !== 'trash';
  if (isNonAllScope && (navMode !== 'list' || scope.kind === 'view')) {
    const meta = filterEngine.getScopeHeaderMeta(scope, lists, views);
    scopePill = {
      icon: meta.icon,
      label: meta.title,
      isCustomView: scope.kind === 'view',
      onClear: () => setScope({ kind: 'smart', key: 'all' }),
    };
  }

  return (
    <section className="tick-shell" aria-label="积木AI工作台">
      {/* 顶部轻提示吐司 */}
      {toast !== undefined && (
        <div className="tick-toast" data-kind={toast.kind} role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            className="tick-toast__close"
            onClick={() => setToast(undefined)}
          >
            ✕
          </button>
        </div>
      )}

      {/* 最左 52px 极窄深黑图标导航栏 */}
      <nav className="tick-rail" aria-label="AI工作台视图切换">
        <div className="tick-rail__top">
          <div className="tick-rail__brand" title="积木AI工作台 · 原子节点与多视图协同底座">
            🧩
          </div>
          {RAIL_ITEMS.map((item) => {
            const isActive = navMode === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className="tick-rail__btn"
                title={item.title}
                aria-label={item.title}
                aria-pressed={isActive}
                data-active={isActive}
                onClick={() => {
                  setNavMode(item.key);
                  if (item.key !== 'list') {
                    setSelectedTaskId(undefined);
                  }
                }}
              >
                {renderRailIcon(item.key)}
              </button>
            );
          })}

          <div className="tick-rail__sep" />

          <button
            type="button"
            className="tick-rail__btn"
            title="全局搜索（Ctrl+K）"
            aria-label="全局搜索"
            data-active={searchOpen}
            onClick={() => setSearchOpen(true)}
          >
            {renderRailIcon('search')}
          </button>
        </div>

        <div className="tick-rail__bottom">
          <button
            type="button"
            className="tick-rail__btn"
            title="刷新节点与视图"
            aria-label="刷新节点与视图"
            disabled={loading}
            onClick={() => void onRefresh(false)}
          >
            {renderRailIcon('refresh')}
          </button>
        </div>
      </nav>

      {/* 主视图内容区（顶部统一动态组合筛选条 + 多视图投影舞台） */}
      <div className="tick-stage">
        {loading && board === undefined && (
          <div className="tick-loading" role="status">
            正在同步积木AI工作台数据…
          </div>
        )}

        {showFilterBar && (
          <filterBar.TickFilterBar
            rule={adhocRule}
            onChangeRule={setAdhocRule}
            onReset={() => setAdhocRule({})}
            onOpenSaveView={openSaveCurrentView}
            tagEntries={tagEntries}
            matchedCount={filteredActiveTasks.length}
            scopePill={scopePill}
          />
        )}

        <div className="tick-stage__body">
          {board !== undefined && navMode === 'list' && (
            <listView.TickListView
              allTasks={tasks}
              filteredActiveTasks={filteredActiveTasks}
              filteredWithDoneTasks={filteredWithDoneTasks}
              lists={lists}
              views={views}
              tagEntries={tagEntries}
              todayStr={todayStr}
              scope={scope}
              onChangeScope={setScope}
              adhocRule={adhocRule}
              onChangeAdhocRule={setAdhocRule}
              onToggleTagFilter={handleToggleTagFilter}
              onOpenCreateView={openSaveCurrentView}
              onOpenEditView={(view) => setViewModal({ mode: 'edit', view })}
              onDeleteView={handleDeleteView}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onCreateTask={handleCreateTask}
              onPatchTask={handlePatchTask}
              onDeleteTask={handleDeleteTask}
              onAppendEvent={handleAppendEvent}
              personas={personas}
              onPersonaReview={handlePersonaReview}
              onCreateList={handleCreateList}
              onDeleteList={handleDeleteList}
            />
          )}

          {board !== undefined && navMode === 'quadrant' && (
            <quadrantView.TickQuadrantView
              tasks={filteredWithDoneTasks}
              allTasks={tasks}
              lists={lists}
              todayStr={todayStr}
              activeFilterTags={adhocRule.tags ?? []}
              onToggleTagFilter={(tag) => handleToggleTagFilter(tag, true)}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onCreateTask={handleCreateTask}
              onPatchTask={handlePatchTask}
              onDeleteTask={handleDeleteTask}
              onAppendEvent={handleAppendEvent}
              personas={personas}
              onPersonaReview={handlePersonaReview}
            />
          )}

          {board !== undefined && navMode === 'calendar' && (
            <calendarView.TickCalendarView
              tasks={filteredWithDoneTasks}
              allTasks={tasks}
              lists={lists}
              todayStr={todayStr}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onCreateTask={handleCreateTask}
              onPatchTask={handlePatchTask}
              onDeleteTask={handleDeleteTask}
              onAppendEvent={handleAppendEvent}
              personas={personas}
              onPersonaReview={handlePersonaReview}
            />
          )}

          {board !== undefined && navMode === 'countdown' && (
            <extraViews.TickCountdownView
              tasks={tasks}
              todayStr={todayStr}
              onCreateTask={handleCreateTask}
              onDeleteTask={handleDeleteTask}
            />
          )}

          {board !== undefined && navMode === 'habit' && (
            <extraViews.TickHabitView
              tasks={tasks}
              todayStr={todayStr}
              onCreateTask={handleCreateTask}
              onToggleCheckIn={handleToggleCheckIn}
              onDeleteTask={handleDeleteTask}
            />
          )}
        </div>
      </div>

      {/* 内置「存为视图 / 编辑动态视图」模态窗 */}
      {viewModal !== undefined && (() => {
        let editingView: api.TaskFilterViewDef | undefined;
        let modalRule: api.TaskFilterRule = {};
        if (viewModal.mode === 'edit') {
          editingView = viewModal.view;
          modalRule = viewModal.view.rule;
        }
        if (viewModal.mode === 'create') {
          modalRule = viewModal.initialRule;
        }
        return (
          <filterBar.TickViewModal
            mode={viewModal.mode}
            editingView={editingView}
            initialRule={modalRule}
            tasks={tasks}
            lists={lists}
            tagEntries={tagEntries}
            todayStr={todayStr}
            onClose={() => setViewModal(undefined)}
            onSubmit={handleSubmitViewModal}
          />
        );
      })()}

      {/* 全局搜索弹窗 */}
      {searchOpen && (
        <extraViews.TickSearchModal
          tasks={tasks}
          lists={lists}
          todayStr={todayStr}
          onClose={() => setSearchOpen(false)}
          onJumpTask={handleJumpTask}
          onJumpList={handleJumpList}
        />
      )}
    </section>
  );
}
