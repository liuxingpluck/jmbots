/** 滴答清单多视图工作台主壳：52px 极窄深黑图标导航栏 + 清单/日历/四象限/纪念日/习惯/搜索。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as calendarView from './TickCalendarView.tsx';
import * as extraViews from './TickExtraViews.tsx';
import * as listView from './TickListView.tsx';
import * as quadrantView from './TickQuadrantView.tsx';
import * as utils from './TickUtils.ts';
import './TickWorkspace.css';

/** 滴答工作台主组件入参（与 AI 任务控制面共用同一份任务数据底座）。 */
export interface TickWorkspaceProps {
  /** 共享的任务与清单快照。 */
  board: api.ControlTaskListResponse | undefined;
  /** 是否正在首次加载。 */
  loading: boolean;
  /** 触发刷新共享任务与清单数据（silent=true 时静默同步）。 */
  onRefresh: (silent?: boolean) => Promise<void>;
  /** 当前工作台是否处于可见激活态（控制快捷键监听）。 */
  active: boolean;
}

/** 渲染极简线条 SVG 导航图标，还原滴答深色侧边栏风格。 */
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
  { key: 'list', title: '清单' },
  { key: 'calendar', title: '日历' },
  { key: 'quadrant', title: '四象限' },
  { key: 'countdown', title: '倒数纪念日' },
  { key: 'habit', title: '习惯' },
];

/** 滴答清单多视图工作台主组件。 */
export function TickWorkspace(props: TickWorkspaceProps): react.JSX.Element {
  const { board, loading, onRefresh, active } = props;

  const [navMode, setNavMode] = react.useState<utils.TickNavMode>('list');
  const [listFilter, setListFilter] = react.useState<listView.TickListFilter>({
    kind: 'list',
    name: '工作任务',
  });
  const [selectedTaskId, setSelectedTaskId] = react.useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = react.useState(false);
  const [toast, setToast] = react.useState<{ kind: 'ok' | 'err'; text: string } | undefined>(
    undefined,
  );
  const toastTimerRef = react.useRef<number | undefined>(undefined);

  const todayStr = utils.getTodayStr();
  const tasks = board?.tasks ?? [];
  const lists = react.useMemo(() => {
    return utils.resolveVisibleLists(board?.lists, tasks);
  }, [board?.lists, tasks]);

  /** 展示一条轻量顶部吐司。 */
  const showToast = react.useCallback((kind: 'ok' | 'err', text: string) => {
    window.clearTimeout(toastTimerRef.current);
    setToast({ kind, text });
    toastTimerRef.current = window.setTimeout(() => setToast(undefined), 3200);
  }, []);

  //M 全局快捷键：在滴答工作台激活态按 Ctrl+K / Cmd+K 呼出搜索，Esc 关闭搜索或详情滑板。
  react.useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }
      if (event.key === 'Escape' && searchOpen) {
        event.stopPropagation();
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, searchOpen]);

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

  /** 统一追加 AI 协同时间线事件。 */
  const handleAppendEvent = react.useCallback(
    async (
      taskId: string,
      text: string,
      kind: api.ControlTaskEventKind,
    ): Promise<void> => {
      try {
        await api.appendControlTaskEvent(taskId, { kind, by: 'boss', text });
        showToast('ok', '已写入 AI 协同时间线');
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
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

  /** 新建自定义清单。 */
  const handleCreateList = react.useCallback(
    async (name: string, icon: string): Promise<void> => {
      try {
        await api.createTaskList({ name, icon });
        showToast('ok', `已新建清单「${name}」`);
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 删除自定义清单。 */
  const handleDeleteList = react.useCallback(
    async (listId: string, listName: string): Promise<void> => {
      try {
        await api.deleteTaskList(listId);
        showToast('ok', `已删除清单「${listName}」`);
        await onRefresh(true);
      } catch (error) {
        showToast('err', utils.getErrorMessage(error));
      }
    },
    [onRefresh, showToast],
  );

  /** 搜索结果点击任务：切回清单视图并精确定位选中该任务。 */
  const handleJumpTask = (task: api.ControlTask): void => {
    setSearchOpen(false);
    setNavMode('list');
    const listName = utils.getTaskListName(task);
    if (listName === '收集箱') {
      setListFilter({ kind: 'inbox' });
    }
    if (listName !== '收集箱') {
      setListFilter({ kind: 'list', name: listName });
    }
    setSelectedTaskId(task.id);
  };

  /** 搜索结果点击清单：切回清单视图并打开该清单。 */
  const handleJumpList = (listName: string): void => {
    setSearchOpen(false);
    setNavMode('list');
    if (listName === '收集箱') {
      setListFilter({ kind: 'inbox' });
      return;
    }
    setListFilter({ kind: 'list', name: listName });
  };

  return (
    <section className="tick-shell" aria-label="滴答清单多视图工作台">
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
      <nav className="tick-rail" aria-label="滴答视图切换">
        <div className="tick-rail__top">
          <div className="tick-rail__brand" title="滴答工作台 · 与 AI 任务控制面共用底座">
            ✓
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
            title="刷新任务与清单"
            aria-label="刷新任务与清单"
            disabled={loading}
            onClick={() => void onRefresh(false)}
          >
            {renderRailIcon('refresh')}
          </button>
        </div>
      </nav>

      {/* 主视图内容区 */}
      <div className="tick-stage">
        {loading && board === undefined && (
          <div className="tick-loading" role="status">
            正在同步滴答任务与清单…
          </div>
        )}

        {board !== undefined && navMode === 'list' && (
          <listView.TickListView
            tasks={tasks}
            lists={lists}
            todayStr={todayStr}
            filter={listFilter}
            onChangeFilter={setListFilter}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            onCreateTask={handleCreateTask}
            onPatchTask={handlePatchTask}
            onDeleteTask={handleDeleteTask}
            onAppendEvent={handleAppendEvent}
            onCreateList={handleCreateList}
            onDeleteList={handleDeleteList}
          />
        )}

        {board !== undefined && navMode === 'quadrant' && (
          <quadrantView.TickQuadrantView
            tasks={tasks}
            lists={lists}
            todayStr={todayStr}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            onCreateTask={handleCreateTask}
            onPatchTask={handlePatchTask}
            onDeleteTask={handleDeleteTask}
            onAppendEvent={handleAppendEvent}
          />
        )}

        {board !== undefined && navMode === 'calendar' && (
          <calendarView.TickCalendarView
            tasks={tasks}
            lists={lists}
            todayStr={todayStr}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            onCreateTask={handleCreateTask}
            onPatchTask={handlePatchTask}
            onDeleteTask={handleDeleteTask}
            onAppendEvent={handleAppendEvent}
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
