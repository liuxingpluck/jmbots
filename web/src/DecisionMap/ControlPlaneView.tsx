/**
 * 工作决策顶栏「AI 任务控制面」前端看板视图。
 * - 顶部仪表带：6 态计数胶囊（待拍板 / 可直接干 / 执行中 / 阻塞 / 已验收 / 已取消）+ 可直接派发数 +「＋ 新建任务」按钮；
 * - 占坑互斥锁矩阵条：实时列出所有正被 running 任务占用的 lockTag 及其领单 AI，支持点击按锁筛选；
 * - 精致任务卡片列表：优先级徽章（P0/P1/P2）、状态与可派发提示、占坑标签、领单负责人、心跳时长监控
 *   （running 超过 15 分钟无心跳自动亮橙色「⚠️ 可能卡住」告警）、机器可验证验收标准、一键展开完整变更时间线；
 * - 全程应用内精致模态框（新建/编辑任务、追加原则与需求变更、删除确认），零原生浏览器弹窗。
 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as tickUtils from './TickUtils.ts';


/** 非研发个人生活清单集合（无占坑锁且无 AI 认领时不进研发控制面）。 */
const PERSONAL_NON_RD_LISTS: ReadonlySet<string> = new Set([
  '个人备忘',
  '心愿清单',
  '购物清单',
  '锻炼计划',
]);

/** 判断任务是否应在「AI 研发控制面」展示（过滤个人/商业沟通项）。 */
function isRdControlPlaneTask(task: api.ControlTask): boolean {
  if (!tickUtils.isControlPlaneTask(task)) return false;

  //G 持有互斥占坑锁的任务始终保留，避免与顶部活跃锁监控条脱节。
  if (task.lockTags.length > 0) return true;

  const listName = tickUtils.getTaskListName(task);
  //G 「商业沟通」清单专供老板看方案话术与回复，即使有中控 owner 也不混入研发控制面。
  if (listName === '商业沟通') return false;

  if (task.owner.trim() !== '') return true;
  if (PERSONAL_NON_RD_LISTS.has(listName)) return false;

  return true;
}

/** 心跳超时阈值：执行中任务超过 15 分钟无心跳标橙色告警。 */
const STALE_HEARTBEAT_MS = 15 * 60 * 1000;

export interface ControlPlaneViewProps {
  /** 来自 /api/work-decision/version 轮询探针的 tasksRev，变化时静默刷新任务板。 */
  externalTasksRev?: number;
  /** 是否窄屏手机模式。 */
  isMobile?: boolean;
  /** 来自父级工作台的共享任务板数据（与积木AI工作台零割裂同步）。 */
  sharedBoard?: api.ControlTaskListResponse;
  /** 父级共享加载态。 */
  sharedLoading?: boolean;
  /** 通知父级刷新共享任务板回调。 */
  onRefreshBoard?: (silent?: boolean) => Promise<void>;
}

const STATUS_META: ReadonlyArray<{
  key: api.ControlTaskStatus;
  label: string;
  icon: string;
}> = [
  { key: 'pending_decision', label: '待拍板', icon: '⏳' },
  { key: 'ready', label: '可直接干', icon: '🟢' },
  { key: 'running', label: '执行中', icon: '⚡' },
  { key: 'blocked', label: '阻塞', icon: '🚧' },
  { key: 'done', label: '已验收', icon: '✅' },
  { key: 'cancelled', label: '已取消', icon: '🚫' },
];

const STATUS_NAME_MAP: Record<api.ControlTaskStatus, string> = {
  pending_decision: '⏳ 待拍板',
  ready: '🟢 可直接干',
  running: '⚡ 执行中',
  blocked: '🚧 阻塞',
  done: '✅ 已验收',
  cancelled: '🚫 已取消',
};

const EVENT_KIND_META: Record<api.ControlTaskEventKind, { label: string; badge: string }> = {
  created: { label: '新建任务', badge: 'created' },
  principle_update: { label: '原则更新', badge: 'principle' },
  scope_change: { label: '需求调整', badge: 'scope' },
  status: { label: '状态流转', badge: 'status' },
  heartbeat: { label: '进度心跳', badge: 'heartbeat' },
  note: { label: '协同备注', badge: 'note' },
  cancelled: { label: '喊停取消', badge: 'cancelled' },
};


/** 格式化相对时长（如「刚刚」「3 分钟前」「2 小时 15 分前」）。 */
function formatElapsed(fromMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (diffSec < 45) {
    return '刚刚';
  }
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) {
    return `${String(mins)} 分钟前`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    if (remMins === 0) {
      return `${String(hours)} 小时前`;
    }
    return `${String(hours)} 小时 ${String(remMins)} 分前`;
  }
  const days = Math.floor(hours / 24);
  return `${String(days)} 天前`;
}


/** 格式化简短时间点。 */
function formatClock(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}


/** 把逗号或空格分隔的锁标签输入拆成字符串数组。 */
function splitLockTagsInput(raw: string): string[] {
  return raw
    .split(/[,，\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}


/** 新建或编辑任务的表单结构。 */
interface TaskFormModalState {
  mode: 'create' | 'edit';
  taskId?: string;
  title: string;
  summary: string;
  status: api.ControlTaskStatus;
  priority: api.ControlTaskPriority;
  lockTagsText: string;
  owner: string;
  doneCriteria: string;
  reason: string;
}

/** 追加变更时间线事件的弹窗结构。 */
interface EventModalState {
  taskId: string;
  taskTitle: string;
  kind: api.ControlTaskEventKind;
  by: string;
  text: string;
}


/** 多 AI 协同控制面任务面板主组件。 */
export function ControlPlaneView(props: ControlPlaneViewProps): react.JSX.Element {
  const { externalTasksRev, sharedBoard, sharedLoading, onRefreshBoard } = props;
  const isShared = onRefreshBoard !== undefined;

  const [localBoard, setLocalBoard] = react.useState<api.ControlTaskListResponse | undefined>(undefined);
  const [localLoading, setLocalLoading] = react.useState(true);
  let board = localBoard;
  let loading = localLoading;
  if (isShared) {
    board = sharedBoard;
    loading = sharedLoading ?? false;
  }
  const [banner, setBanner] = react.useState<{ kind: 'ok' | 'err'; text: string } | undefined>(undefined);

  //M 过滤条件：状态、占坑标签、关键词
  const [statusFilter, setStatusFilter] = react.useState<'all' | api.ControlTaskStatus>('all');
  const [lockFilter, setLockFilter] = react.useState<string | undefined>(undefined);
  const [searchText, setSearchText] = react.useState('');

  //M 已展开变更时间线的任务 ID 集合
  const [expandedIds, setExpandedIds] = react.useState<ReadonlySet<string>>(() => new Set());
  //M 正在提交快捷动作的任务 ID
  const [busyTaskId, setBusyTaskId] = react.useState<string | undefined>(undefined);

  //M 应用内弹窗状态（新建/编辑任务、追加事件、删除确认）
  const [formModal, setFormModal] = react.useState<TaskFormModalState | undefined>(undefined);
  const [eventModal, setEventModal] = react.useState<EventModalState | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = react.useState<api.ControlTask | undefined>(undefined);
  const [modalSubmitting, setModalSubmitting] = react.useState(false);

  //M 每 30 秒刷新一次当前时钟，用于实时计算心跳超时告警
  const [nowMs, setNowMs] = react.useState(() => Date.now());
  const bannerTimerRef = react.useRef<number | undefined>(undefined);
  const lastSeenRevRef = react.useRef<number | undefined>(undefined);

  useClockTick(setNowMs);

  const showToast = react.useCallback((kind: 'ok' | 'err', text: string) => {
    window.clearTimeout(bannerTimerRef.current);
    setBanner({ kind, text });
    bannerTimerRef.current = window.setTimeout(() => setBanner(undefined), 5500);
  }, []);

  /** 拉取完整控制面任务账本。 */
  const loadBoard = react.useCallback(async (silent = false) => {
    if (onRefreshBoard !== undefined) {
      await onRefreshBoard(silent);
      return;
    }
    if (!silent) {
      setLocalLoading(true);
    }
    try {
      const data = await api.getControlTasks();
      lastSeenRevRef.current = data.revision;
      setLocalBoard(data);
    } catch (error) {
      let msg = String(error);
      if (error instanceof Error) {
        msg = error.message;
      }
      showToast('err', msg);
    } finally {
      if (!silent) {
        setLocalLoading(false);
      }
    }
  }, [onRefreshBoard, showToast]);

  react.useEffect(() => {
    if (isShared) return;

    void loadBoard(false);
  }, [isShared, loadBoard]);

  //M 外部 30 秒 /version 探针发现 tasksRev 递增时静默同步任务面板。
  react.useEffect(() => {
    if (isShared) return;
    if (externalTasksRev === undefined) return;

    if (lastSeenRevRef.current !== undefined && externalTasksRev !== lastSeenRevRef.current) {
      void loadBoard(true);
    }
  }, [externalTasksRev, isShared, loadBoard]);

  //M Esc 关闭当前打开的应用内模态框。
  react.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      if (deleteTarget !== undefined) {
        event.stopPropagation();
        setDeleteTarget(undefined);
        return;
      }
      if (eventModal !== undefined) {
        event.stopPropagation();
        setEventModal(undefined);
        return;
      }
      if (formModal !== undefined) {
        event.stopPropagation();
        setFormModal(undefined);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [deleteTarget, eventModal, formModal]);

  /** 切换某张任务卡的变更时间线展开态。 */
  const toggleTimeline = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      return next;
    });
  };

  /** 打开新建任务模态框。 */
  const openCreateModal = (): void => {
    setFormModal({
      mode: 'create',
      title: '',
      summary: '',
      status: 'ready',
      priority: 'P1',
      lockTagsText: lockFilter ?? '',
      owner: '',
      doneCriteria: '',
      reason: '',
    });
  };

  /** 打开编辑任务模态框。 */
  const openEditModal = (task: api.ControlTask): void => {
    setFormModal({
      mode: 'edit',
      taskId: task.id,
      title: task.title,
      summary: task.summary,
      status: task.status,
      priority: task.priority,
      lockTagsText: task.lockTags.join(', '),
      owner: task.owner,
      doneCriteria: task.doneCriteria,
      reason: '',
    });
  };

  /** 提交新建或编辑任务表单。 */
  const submitTaskForm = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    if (formModal === undefined) {
      return;
    }
    const title = formModal.title.trim();
    if (title === '') {
      showToast('err', '请填写任务标题');
      return;
    }
    const lockTags = splitLockTagsInput(formModal.lockTagsText);
    setModalSubmitting(true);
    try {
      if (formModal.mode === 'create') {
        await api.createControlTask({
          title,
          summary: formModal.summary.trim(),
          status: formModal.status,
          priority: formModal.priority,
          lockTags,
          owner: formModal.owner.trim(),
          doneCriteria: formModal.doneCriteria.trim(),
          by: 'boss',
          initialNote: formModal.reason.trim() || undefined,
        });
        showToast('ok', `已创建任务「${title}」`);
      }
      if (formModal.mode === 'edit' && formModal.taskId !== undefined) {
        await api.patchControlTask(formModal.taskId, {
          title,
          summary: formModal.summary.trim(),
          status: formModal.status,
          priority: formModal.priority,
          lockTags,
          owner: formModal.owner.trim(),
          doneCriteria: formModal.doneCriteria.trim(),
          by: 'boss',
          reason: formModal.reason.trim() || undefined,
        });
        showToast('ok', `已更新任务「${title}」`);
      }
      setFormModal(undefined);
      await loadBoard(true);
    } catch (error) {
      showToast('err', tickUtils.getErrorMessage(error));
    } finally {
      setModalSubmitting(false);
    }
  };

  /** 快捷切换状态或发送心跳。 */
  const quickTransition = async (
    task: api.ControlTask,
    patch: Parameters<typeof api.patchControlTask>[1],
    okMessage: string,
  ): Promise<void> => {
    setBusyTaskId(task.id);
    try {
      await api.patchControlTask(task.id, { by: 'boss', ...patch });
      showToast('ok', okMessage);
      await loadBoard(true);
    } catch (error) {
      showToast('err', tickUtils.getErrorMessage(error));
    } finally {
      setBusyTaskId(undefined);
    }
  };

  /** 提交追加变更时间线事件。 */
  const submitEventModal = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    if (eventModal === undefined) {
      return;
    }
    const trimmed = eventModal.text.trim();
    if (trimmed === '' && eventModal.kind !== 'heartbeat') {
      showToast('err', '请输入变更或备注内容');
      return;
    }
    setModalSubmitting(true);
    try {
      await api.appendControlTaskEvent(eventModal.taskId, {
        kind: eventModal.kind,
        by: eventModal.by.trim() || 'boss',
        text: trimmed || '手动上报心跳正常',
      });
      const targetId = eventModal.taskId;
      setEventModal(undefined);
      setExpandedIds((prev) => new Set(prev).add(targetId));
      showToast('ok', '变更时间线已记录并刷新心跳');
      await loadBoard(true);
    } catch (error) {
      showToast('err', tickUtils.getErrorMessage(error));
    } finally {
      setModalSubmitting(false);
    }
  };

  /** 确认删除任务卡。 */
  const confirmDeleteTask = async (): Promise<void> => {
    if (deleteTarget === undefined) {
      return;
    }
    setModalSubmitting(true);
    try {
      await api.deleteControlTask(deleteTarget.id);
      showToast('ok', `已删除任务「${deleteTarget.title}」`);
      setDeleteTarget(undefined);
      await loadBoard(true);
    } catch (error) {
      showToast('err', tickUtils.getErrorMessage(error));
    } finally {
      setModalSubmitting(false);
    }
  };

  //M 过滤掉倒数纪念日、习惯、垃圾桶及纯个人/商业沟通任务，保持 AI 研发控制面聚焦清爽。
  const allTasks = react.useMemo(() => {
    const raw = board?.tasks ?? [];
    return raw.filter((task) => isRdControlPlaneTask(task));
  }, [board?.tasks]);

  const counts = react.useMemo(() => {
    const summary: Record<api.ControlTaskStatus, number> = {
      pending_decision: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    };
    for (const item of allTasks) {
      summary[item.status] += 1;
    }
    return summary;
  }, [allTasks]);

  const activeLocks = board?.activeLocks ?? {};
  const activeLockEntries = Object.entries(activeLocks);
  const visibleIdSet = new Set(allTasks.map((item) => item.id));
  const dispatchableSet = new Set(
    (board?.dispatchableIds ?? []).filter((id) => visibleIdSet.has(id)),
  );

  //M 本地多维筛选（状态 + 占坑锁 + 搜索词）
  const visibleTasks = react.useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return allTasks.filter((task) => {
      if (statusFilter !== 'all' && task.status !== statusFilter) {
        return false;
      }
      if (lockFilter !== undefined && !task.lockTags.includes(lockFilter)) {
        return false;
      }
      if (q === '') {
        return true;
      }
      if (task.title.toLowerCase().includes(q) || task.summary.toLowerCase().includes(q)) {
        return true;
      }
      if (task.owner.toLowerCase().includes(q) || task.doneCriteria.toLowerCase().includes(q)) {
        return true;
      }
      return task.lockTags.some((tag) => tag.toLowerCase().includes(q));
    });
  }, [allTasks, statusFilter, lockFilter, searchText]);

  return (
    <section className="cp-board" aria-label="多 AI 协同控制面任务面板">
      {/* 顶部通知吐司 */}
      {banner !== undefined && (
        <div className="cp-toast" data-kind={banner.kind} role="status">
          <span>{banner.text}</span>
          <button type="button" className="cp-toast__close" onClick={() => setBanner(undefined)}>✕</button>
        </div>
      )}

      {/* 1. 顶部状态计数胶囊与工具栏 */}
      <div className="cp-topbar">
        <div className="cp-status-pills" role="tablist" aria-label="任务状态过滤">
          <button
            type="button"
            className="cp-status-pill"
            data-active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          >
            <span>全部</span>
            <span className="cp-pill-count">{allTasks.length}</span>
          </button>
          {STATUS_META.map((item) => {
            const count = counts[item.key] ?? 0;
            if (item.key === 'cancelled' && count === 0 && statusFilter !== 'cancelled') {
              return null;
            }
            return (
              <button
                key={item.key}
                type="button"
                className="cp-status-pill"
                data-status={item.key}
                data-active={statusFilter === item.key}
                onClick={() => {
                  setStatusFilter((prev) => {
                    if (prev === item.key) return 'all';

                    return item.key;
                  });
                }}
              >
                <span>{item.icon} {item.label}</span>
                <span className="cp-pill-count">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="cp-topbar__right">
          <span className="cp-dispatch-hint" title="当前处于可直接干（ready）且不与任何执行中任务撞坑的任务数">
            🚀 可直接派发 <b>{dispatchableSet.size}</b>
          </span>
          <input
            type="search"
            className="cp-search-input"
            value={searchText}
            placeholder="搜标题 / 负责人 / 锁标签…"
            onChange={(e) => setSearchText(e.target.value)}
          />
          <button
            type="button"
            className="cp-btn cp-btn--ghost"
            disabled={loading}
            onClick={() => void loadBoard(false)}
          >
            ↻ 刷新
          </button>
          <button type="button" className="cp-btn cp-btn--primary" onClick={openCreateModal}>
            ＋ 新建任务
          </button>
        </div>
      </div>

      {/* 2. 当前占坑互斥锁实时监控带 */}
      <div className="cp-locks-bar">
        <span className="cp-locks-bar__label">🔒 当前占坑锁：</span>
        {activeLockEntries.length === 0 && (
          <span className="cp-locks-bar__free">当前无执行中占坑锁，所有「可直接干」任务均可无冲突派发</span>
        )}
        {activeLockEntries.map(([tag, holder]) => {
          const isFiltered = lockFilter === tag;
          let ownerText = '未署名';
          if (holder.owner !== '') {
            ownerText = holder.owner;
          }
          return (
            <button
              key={tag}
              type="button"
              className="cp-lock-chip"
              data-active={isFiltered}
              title={`正在由 ${ownerText} 执行「${holder.title}」占用，点击筛选相关任务`}
              onClick={() => {
                setLockFilter((prev) => {
                  if (prev === tag) return undefined;

                  return tag;
                });
              }}
            >
              <span className="cp-lock-chip__tag">{tag}</span>
              <span className="cp-lock-chip__sep">←</span>
              <span className="cp-lock-chip__owner">{ownerText}</span>
            </button>
          );
        })}
        {lockFilter !== undefined && !activeLocks[lockFilter] && (
          <button
            type="button"
            className="cp-lock-chip"
            data-active="true"
            onClick={() => setLockFilter(undefined)}
          >
            <span>筛选锁：{lockFilter} ×</span>
          </button>
        )}
        {lockFilter !== undefined && (
          <button type="button" className="cp-clear-link" onClick={() => setLockFilter(undefined)}>
            清除锁筛选
          </button>
        )}
      </div>

      {/* 3. 任务卡片列表 */}
      <div className="cp-list-wrap">
        {loading && board === undefined && (
          <div className="cp-empty">正在读取多 AI 控制面任务账本…</div>
        )}
        {!loading && visibleTasks.length === 0 && (
          <div className="cp-empty">
            <p>当前筛选条件下没有任务卡</p>
            <button type="button" className="cp-btn cp-btn--primary" onClick={openCreateModal}>
              ＋ 创建第一张 AI 协同任务卡
            </button>
          </div>
        )}

        <div className="cp-cards-grid">
          {visibleTasks.map((task) => {
            const isDispatchable = dispatchableSet.has(task.id);
            const blockingHolders = task.lockTags
              .map((tag) => {
                const holder = activeLocks[tag];
                if (holder === undefined || holder.taskId === task.id) {
                  return undefined;
                }
                return { tag, holder };
              })
              .filter((item): item is { tag: string; holder: api.ActiveLockHolder } => item !== undefined);

            const hbBase = task.lastHeartbeatAt ?? task.updatedAt;
            const elapsedMs = Math.max(0, nowMs - hbBase);
            const isStaleRunning = task.status === 'running' && elapsedMs >= STALE_HEARTBEAT_MS;
            const isExpanded = expandedIds.has(task.id);
            const isBusy = busyTaskId === task.id;
            const reversedEvents = [...task.events].reverse();
            const blockingHint = blockingHolders
              .map((b) => `${b.tag}(${b.holder.owner || b.holder.taskId})`)
              .join(', ');
            let ownerBadgeText = '未认领';
            if (task.owner !== '') {
              ownerBadgeText = task.owner;
            }
            let hbLabel = `🕒 更新于 ${formatElapsed(task.updatedAt, nowMs)}`;
            if (task.lastHeartbeatAt !== null) {
              hbLabel = `💓 心跳 ${formatElapsed(task.lastHeartbeatAt, nowMs)}`;
            }
            let timelineArrow = '▾';
            if (isExpanded) {
              timelineArrow = '▴';
            }

            return (
              <article
                key={task.id}
                className="cp-card"
                data-status={task.status}
                data-stale={isStaleRunning}
              >
                <header className="cp-card__head">
                  <span className="cp-prio-badge" data-prio={task.priority}>
                    {task.priority}
                  </span>
                  <span className="cp-state-badge" data-status={task.status}>
                    {STATUS_NAME_MAP[task.status]}
                  </span>
                  {isDispatchable && (
                    <span className="cp-ready-go-badge" title="所有占坑标签均空闲，巡检环或任意空闲 AI 可直接领单开干">
                      🚀 可直接派发
                    </span>
                  )}
                  {task.status === 'ready' && !isDispatchable && blockingHolders.length > 0 && (
                    <span
                      className="cp-wait-lock-badge"
                      title={`等待占坑锁释放：${blockingHint}`}
                    >
                      ⏳ 等待锁释放 ({blockingHolders.map((b) => b.tag).join(', ')})
                    </span>
                  )}

                  <span className="cp-grow" />

                  <span className="cp-owner-pill" data-claimed={task.owner !== ''}>
                    🤖 {ownerBadgeText}
                  </span>
                </header>

                <h3 className="cp-card__title">{task.title}</h3>
                {task.summary !== '' && <p className="cp-card__summary">{task.summary}</p>}

                {/* 占坑标签与心跳监控行 */}
                <div className="cp-card__meta-row">
                  <div className="cp-card__tags">
                    {task.lockTags.length === 0 && (
                      <span className="cp-tag-none">🔓 无互斥占坑标签</span>
                    )}
                    {task.lockTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="cp-tag-pill"
                        data-active={lockFilter === tag}
                        onClick={() => {
                          setLockFilter((prev) => {
                            if (prev === tag) return undefined;

                            return tag;
                          });
                        }}
                      >
                        🔒 {tag}
                      </button>
                    ))}
                  </div>

                  <span className="cp-grow" />

                  {isStaleRunning && (
                    <span className="cp-hb-stale" title="执行中任务超过 15 分钟未收到进度心跳，请巡检核实是否卡死">
                      ⚠️ 心跳 {formatElapsed(hbBase, nowMs)} · 可能卡住
                    </span>
                  )}
                  {!isStaleRunning && <span className="cp-hb-normal">{hbLabel}</span>}
                </div>

                {/* 机器可验证验收标准 */}
                {task.doneCriteria !== '' && (
                  <div className="cp-criteria-box">
                    <span className="cp-criteria-box__label">🎯 验收标准：</span>
                    <code className="cp-criteria-box__code">{task.doneCriteria}</code>
                  </div>
                )}

                {/* 快捷流转与变更时间线操作栏 */}
                <footer className="cp-card__actions">
                  {task.status === 'pending_decision' && (
                    <button
                      type="button"
                      className="cp-btn cp-btn--accent"
                      disabled={isBusy}
                      onClick={() => void quickTransition(
                        task,
                        { status: 'ready', reason: '老板拍板放行进入可直接干队列' },
                        `「${task.title}」已放行进入可直接干队列`,
                      )}
                    >
                      ✓ 拍板放行
                    </button>
                  )}

                  {task.status === 'ready' && (
                    <button
                      type="button"
                      className="cp-btn cp-btn--accent"
                      disabled={isBusy}
                      onClick={() => void quickTransition(
                        task,
                        { status: 'running', owner: task.owner || 'central', reason: '开始执行任务' },
                        `「${task.title}」已进入执行中`,
                      )}
                    >
                      ▶ 领单执行
                    </button>
                  )}

                  {task.status === 'running' && (
                    <>
                      <button
                        type="button"
                        className="cp-btn cp-btn--ghost"
                        disabled={isBusy}
                        onClick={() => void quickTransition(
                          task,
                          { heartbeat: true, by: task.owner || 'boss' },
                          `已刷新「${task.title}」心跳`,
                        )}
                      >
                        💓 心跳
                      </button>
                      <button
                        type="button"
                        className="cp-btn cp-btn--success"
                        disabled={isBusy}
                        onClick={() => void quickTransition(
                          task,
                          { status: 'done', reason: '达到验收标准，确认完成' },
                          `「${task.title}」已验收完成并释放占坑锁`,
                        )}
                      >
                        ✅ 验收完成
                      </button>
                      <button
                        type="button"
                        className="cp-btn cp-btn--warn"
                        disabled={isBusy}
                        onClick={() => void quickTransition(
                          task,
                          { status: 'blocked', reason: '标记阻塞并释放运行占坑锁' },
                          `「${task.title}」已标记为阻塞`,
                        )}
                      >
                        🚧 阻塞
                      </button>
                    </>
                  )}

                  {task.status === 'blocked' && (
                    <button
                      type="button"
                      className="cp-btn cp-btn--accent"
                      disabled={isBusy}
                      onClick={() => void quickTransition(
                        task,
                        { status: 'ready', reason: '阻塞解除，回到可直接干队列' },
                        `「${task.title}」已解除阻塞`,
                      )}
                    >
                      🟢 解除阻塞
                    </button>
                  )}

                  <button
                    type="button"
                    className="cp-btn cp-btn--ghost"
                    onClick={() => setEventModal({
                      taskId: task.id,
                      taskTitle: task.title,
                      kind: 'principle_update',
                      by: 'boss',
                      text: '',
                    })}
                  >
                    📝 记原则/变更
                  </button>

                  <button
                    type="button"
                    className="cp-btn cp-btn--ghost"
                    onClick={() => openEditModal(task)}
                  >
                    ✏️ 编辑
                  </button>

                  <button
                    type="button"
                    className="cp-btn cp-btn--ghost"
                    aria-expanded={isExpanded}
                    onClick={() => toggleTimeline(task.id)}
                  >
                    🕒 时间线 ({task.events.length}) {timelineArrow}
                  </button>

                  <span className="cp-grow" />

                  <button
                    type="button"
                    className="cp-btn cp-btn--danger-text"
                    onClick={() => setDeleteTarget(task)}
                  >
                    删除
                  </button>
                </footer>

                {/* 完整变更时间线展开抽屉 */}
                {isExpanded && (
                  <div className="cp-timeline">
                    {reversedEvents.map((ev, idx) => {
                      const info = EVENT_KIND_META[ev.kind] ?? { label: ev.kind, badge: 'note' };
                      return (
                        <div key={`${String(ev.at)}-${String(idx)}`} className="cp-timeline__item">
                          <span className="cp-timeline__badge" data-kind={info.badge}>
                            {info.label}
                          </span>
                          <span className="cp-timeline__by">{ev.by}</span>
                          <span className="cp-timeline__time">{formatClock(ev.at)}</span>
                          <p className="cp-timeline__text">{ev.text}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      {/* 模态框 1：新建 / 编辑任务卡 */}
      {formModal !== undefined && (
        <div className="cp-modal-layer" role="dialog" aria-modal="true" aria-label="任务卡编辑">
          <div className="cp-modal-mask" onClick={() => setFormModal(undefined)} />
          <form className="cp-modal-card cp-modal-card--wide" onSubmit={(e) => void submitTaskForm(e)}>
            <h3 className="cp-modal-title">
              {formModal.mode === 'create' && '＋ 新建多 AI 协同任务卡'}
              {formModal.mode !== 'create' && '✏️ 编辑控制面任务卡'}
            </h3>

            <label className="cp-field">
              <span>任务标题 *</span>
              <input
                type="text"
                autoFocus
                value={formModal.title}
                placeholder="例如：上海官网授权校验联调"
                onChange={(e) => setFormModal({ ...formModal, title: e.target.value })}
              />
            </label>

            <label className="cp-field">
              <span>背景与边界摘要</span>
              <textarea
                rows={3}
                value={formModal.summary}
                placeholder="交代核心目标、严禁触碰的目录边界或架构约束…"
                onChange={(e) => setFormModal({ ...formModal, summary: e.target.value })}
              />
            </label>

            <div className="cp-field-row">
              <label className="cp-field">
                <span>优先级</span>
                <select
                  value={formModal.priority}
                  onChange={(e) => setFormModal({
                    ...formModal,
                    priority: e.target.value as api.ControlTaskPriority,
                  })}
                >
                  <option value="P0">P0 · 最高优</option>
                  <option value="P1">P1 · 高优主线</option>
                  <option value="P2">P2 · 常规排期</option>
                </select>
              </label>

              <label className="cp-field">
                <span>当前状态</span>
                <select
                  value={formModal.status}
                  onChange={(e) => setFormModal({
                    ...formModal,
                    status: e.target.value as api.ControlTaskStatus,
                  })}
                >
                  {STATUS_META.map((st) => (
                    <option key={st.key} value={st.key}>
                      {st.icon} {st.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="cp-field">
                <span>领单 AI / 节点负责人</span>
                <input
                  type="text"
                  value={formModal.owner}
                  placeholder="如 coder-opus / coder-carbon / 130"
                  onChange={(e) => setFormModal({ ...formModal, owner: e.target.value })}
                />
              </label>
            </div>

            <label className="cp-field">
              <span>占坑互斥锁标签（逗号或空格分隔，防多个 AI 同时改同一仓库/机器撞车）</span>
              <input
                type="text"
                value={formModal.lockTagsText}
                placeholder="例如：repo:jmbots, host:132"
                onChange={(e) => setFormModal({ ...formModal, lockTagsText: e.target.value })}
              />
            </label>

            <label className="cp-field">
              <span>可机器验证的验收标准（Done Criteria）</span>
              <input
                type="text"
                value={formModal.doneCriteria}
                placeholder="例如：bun test 0 fail & GET /api/work-decision/tasks 返回 200"
                onChange={(e) => setFormModal({ ...formModal, doneCriteria: e.target.value })}
              />
            </label>

            <label className="cp-field">
              <span>
                {formModal.mode === 'create' && '初始原则备注（可选）'}
                {formModal.mode !== 'create' && '本次调整说明（记入变更时间线）'}
              </span>
              <input
                type="text"
                value={formModal.reason}
                placeholder="可选说明…"
                onChange={(e) => setFormModal({ ...formModal, reason: e.target.value })}
              />
            </label>

            <div className="cp-modal-actions">
              <button type="button" className="cp-btn cp-btn--ghost" onClick={() => setFormModal(undefined)}>
                取消
              </button>
              <button type="submit" className="cp-btn cp-btn--primary" disabled={modalSubmitting}>
                {modalSubmitting && '正在保存…'}
                {!modalSubmitting && '保存任务卡'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 模态框 2：追加原则更新 / 范围变更 / 心跳备注 */}
      {eventModal !== undefined && (
        <div className="cp-modal-layer" role="dialog" aria-modal="true" aria-label="追加变更时间线">
          <div className="cp-modal-mask" onClick={() => setEventModal(undefined)} />
          <form className="cp-modal-card" onSubmit={(e) => void submitEventModal(e)}>
            <h3 className="cp-modal-title">📝 记录变更或原则：{eventModal.taskTitle}</h3>

            <div className="cp-field-row">
              <label className="cp-field">
                <span>记录类型</span>
                <select
                  value={eventModal.kind}
                  onChange={(e) => setEventModal({
                    ...eventModal,
                    kind: e.target.value as api.ControlTaskEventKind,
                  })}
                >
                  <option value="principle_update">🧭 老板原则更新 (principle_update)</option>
                  <option value="scope_change">📐 需求范围调整 (scope_change)</option>
                  <option value="note">💬 协同进度备注 (note)</option>
                  <option value="heartbeat">💓 进度心跳上报 (heartbeat)</option>
                  <option value="cancelled">🚫 喊停取消任务 (cancelled)</option>
                </select>
              </label>

              <label className="cp-field">
                <span>记录人 / AI 节点</span>
                <input
                  type="text"
                  value={eventModal.by}
                  placeholder="boss / central / coder-opus"
                  onChange={(e) => setEventModal({ ...eventModal, by: e.target.value })}
                />
              </label>
            </div>

            <label className="cp-field">
              <span>具体内容</span>
              <textarea
                rows={3}
                autoFocus
                value={eventModal.text}
                placeholder="写下老板最新指示、边界调整或当前阶段性产出…"
                onChange={(e) => setEventModal({ ...eventModal, text: e.target.value })}
              />
            </label>

            <div className="cp-modal-actions">
              <button type="button" className="cp-btn cp-btn--ghost" onClick={() => setEventModal(undefined)}>
                取消
              </button>
              <button type="submit" className="cp-btn cp-btn--primary" disabled={modalSubmitting}>
                {modalSubmitting && '提交中…'}
                {!modalSubmitting && '追加到时间线'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 模态框 3：删除任务确认框 */}
      {deleteTarget !== undefined && (
        <div className="cp-modal-layer" role="dialog" aria-modal="true" aria-label="确认删除任务卡">
          <div className="cp-modal-mask" onClick={() => setDeleteTarget(undefined)} />
          <div className="cp-modal-card">
            <h3 className="cp-modal-title">删除任务「{deleteTarget.title}」？</h3>
            <p className="cp-modal-desc">
              删除后该任务卡及其 {deleteTarget.events.length} 条变更时间线将从控制面移除（若只是终止任务，建议改标为「已取消」以保留审计轨迹）。
            </p>
            <div className="cp-modal-actions">
              <button type="button" className="cp-btn cp-btn--ghost" onClick={() => setDeleteTarget(undefined)}>
                保留任务
              </button>
              <button
                type="button"
                className="cp-btn cp-btn--danger"
                disabled={modalSubmitting}
                onClick={() => void confirmDeleteTask()}
              >
                {modalSubmitting && '删除中…'}
                {!modalSubmitting && '确认永久删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}


/** 每 30 秒刷新当前时间戳的轻量辅助 Hook。 */
function useClockTick(setNowMs: react.Dispatch<react.SetStateAction<number>>): void {
  react.useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [setNowMs]);
}
