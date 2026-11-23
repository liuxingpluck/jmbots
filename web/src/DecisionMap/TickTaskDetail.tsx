/** AI工作台右侧节点详情面板：方案 Markdown 阅读/编辑、一键复制、交互时间线与底部 AI 批示条。 */
import * as react from 'react';
import * as markdownModule from '../Chat/Markdown.tsx';
import * as api from './DecisionMapApi.ts';
import * as utils from './TickUtils.ts';

/** 底部批示框可选的唤醒中控或无状态反方红军角色目标。 */
type ReplyTarget = 'Claude' | 'HanXin' | 'none' | `persona:${string}`;

/** 任务详情面板入参。 */
export interface TickTaskDetailProps {
  /** 当前选中的任务；为空时显示引导空态。 */
  task: api.ControlTask | undefined;
  /** 全部任务列表（用于查找子任务与父任务）。 */
  allTasks: readonly api.ControlTask[];
  /** 可选清单定义列表。 */
  lists: readonly api.TaskListDef[];
  /** 今日日期字符串 YYYY-MM-DD。 */
  todayStr: string;
  /** 是否作为右侧滑板或抽屉浮层展示（提供关闭按钮）。 */
  onClose?: () => void;
  /** 当前是否处于宽读模式（用于展示展开/收窄切换按钮）。 */
  wideRead?: boolean;
  /** 切换宽读模式（当前宽度 <-> 720px）回调。 */
  onToggleWideRead?: () => void;
  /** 选中另一个任务（例如点击子任务或父任务跳转）。 */
  onSelectTask: (taskId: string) => void;
  /** 局部更新任务回调。 */
  onPatchTask: (
    taskId: string,
    patch: api.PatchControlTaskInput,
    toastText?: string,
  ) => Promise<void>;
  /** 创建子任务回调。 */
  onCreateTask: (
    input: api.CreateControlTaskInput,
    toastText?: string,
  ) => Promise<api.ControlTask | undefined>;
  /** 追加 AI 协同事件回调（支持唤醒与播报参数，成功返回 true）。 */
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
  /** 彻底删除任务回调。 */
  onDeleteTask: (taskId: string) => Promise<void>;
}

/** 所有可选 AI 状态列表。 */
const AI_STATUSES: readonly api.ControlTaskStatus[] = [
  'pending_decision',
  'ready',
  'running',
  'blocked',
  'done',
  'cancelled',
];

/** 所有可选优先级。 */
const AI_PRIORITIES: readonly api.ControlTaskPriority[] = ['P0', 'P1', 'P2'];

/** 顶部工具栏直接外露的任务状态快捷下拉选项。 */
const TOPBAR_STATUS_OPTIONS: ReadonlyArray<{
  key: api.ControlTaskStatus;
  label: string;
}> = [
  { key: 'pending_decision', label: '⏳ 待拍板' },
  { key: 'ready', label: '🟢 待办就绪' },
  { key: 'running', label: '⚡ 执行中' },
  { key: 'blocked', label: '🚧 等待后续(阻塞)' },
  { key: 'done', label: '✅ 已完成' },
  { key: 'cancelled', label: '🚫 已取消' },
];

/** 底部唤醒目标选择器选项。 */
const REPLY_TARGET_OPTIONS: ReadonlyArray<{
  key: 'Claude' | 'HanXin' | 'none';
  label: string;
  hint: string;
}> = [
  { key: 'Claude', label: '@哈基米 (132)', hint: '落盘并单向唤醒哈基米' },
  { key: 'HanXin', label: '@韩信 (130)', hint: '落盘并单向唤醒韩信' },
  { key: 'none', label: '仅记录不唤醒', hint: '仅记录时间线，不唤醒中控' },
];

/** 时间线事件类型中文徽标映射。 */
const EVENT_KIND_LABELS: Readonly<Record<api.ControlTaskEventKind, string>> = {
  created: '新建',
  principle_update: '原则更新',
  scope_change: '需求调整',
  status: '状态流转',
  heartbeat: '进度汇报',
  note: '批示对话',
  redteam: '红军拍砖',
  cancelled: '已取消',
};

/** 从 ReplyTarget 提取红军角色 ID；非红军目标返回 undefined。 */
function getPersonaIdFromTarget(target: ReplyTarget): string | undefined {
  if (!target.startsWith('persona:')) return undefined;

  return target.slice('persona:'.length);
}

/** 拆分逗号或空格分隔的锁标签输入。 */
function splitLocks(raw: string): string[] {
  return raw
    .split(/[,，\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 根据任务当前认领人推导默认唤醒中控（owner 含「韩信」默认韩信，否则默认哈基米）。 */
function getDefaultReplyTarget(owner: string): ReplyTarget {
  if (owner.includes('韩信')) return 'HanXin';

  return 'Claude';
}

/** 复制文本到剪贴板，局域网 HTTP 环境降级使用隐藏 textarea 兜底。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  if (text === '') return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    //G 非 HTTPS 局域网环境下 Clipboard API 可能不可用，改走 execCommand 兜底。
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', 'true');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(helper);
    return ok;
  } catch {
    return false;
  }
}

/** 自适应调整底部批示输入框高度（2 行起，最高 132px）。 */
function resizeReplyTextarea(el: HTMLTextAreaElement | null): void {
  if (el === null) return;

  el.style.height = 'auto';
  const nextHeight = Math.min(Math.max(el.scrollHeight, 48), 132);
  el.style.height = `${String(nextHeight)}px`;
}

/** 右侧节点详情面板组件。 */
export function TickTaskDetail(props: TickTaskDetailProps): react.JSX.Element {
  const {
    task,
    allTasks,
    lists,
    todayStr,
    onClose,
    wideRead,
    onToggleWideRead,
    onSelectTask,
    onPatchTask,
    onCreateTask,
    onAppendEvent,
    personas,
    onPersonaReview,
    onDeleteTask,
  } = props;

  const [titleDraft, setTitleDraft] = react.useState('');
  const [summaryDraft, setSummaryDraft] = react.useState('');
  const [summaryEditing, setSummaryEditing] = react.useState(false);
  const [tagDraft, setTagDraft] = react.useState('');
  const [subtaskDraft, setSubtaskDraft] = react.useState('');
  const [dateMenuOpen, setDateMenuOpen] = react.useState(false);
  const [aiExpanded, setAiExpanded] = react.useState(false);
  const [confirmTrashModalOpen, setConfirmTrashModalOpen] = react.useState(false);
  const [confirmHardDelete, setConfirmHardDelete] = react.useState(false);
  const [savedHint, setSavedHint] = react.useState(false);
  const [copiedKey, setCopiedKey] = react.useState<string | undefined>(undefined);

  //M AI 协同字段与底部常驻批示回复条状态（切任务时才清空输入草稿，轮询刷新不打断打字）。
  const [ownerDraft, setOwnerDraft] = react.useState('');
  const [locksDraft, setLocksDraft] = react.useState('');
  const [criteriaDraft, setCriteriaDraft] = react.useState('');
  const [noteDraft, setNoteDraft] = react.useState('');
  const [replyTarget, setReplyTarget] = react.useState<ReplyTarget>('Claude');
  const [busy, setBusy] = react.useState(false);

  const prevTaskIdRef = react.useRef<string | undefined>(undefined);
  const copyTimerRef = react.useRef<number | undefined>(undefined);
  const titleInputRef = react.useRef<HTMLInputElement | null>(null);
  const replyTextareaRef = react.useRef<HTMLTextAreaElement | null>(null);

  //M 切换到不同任务时重置编辑态、回复草稿与默认唤醒目标。
  react.useEffect(() => {
    if (task === undefined) {
      prevTaskIdRef.current = undefined;
      return;
    }
    if (prevTaskIdRef.current === task.id) return;

    prevTaskIdRef.current = task.id;
    setTitleDraft(task.title);
    setSummaryDraft(task.summary);
    setSummaryEditing(task.summary.trim() === '');
    setOwnerDraft(task.owner);
    setLocksDraft(task.lockTags.join(', '));
    setCriteriaDraft(task.doneCriteria);
    setTagDraft('');
    setSubtaskDraft('');
    setNoteDraft('');
    setReplyTarget(getDefaultReplyTarget(task.owner));
    setDateMenuOpen(false);
    setConfirmTrashModalOpen(false);
    setConfirmHardDelete(false);
    setSavedHint(false);
    setCopiedKey(undefined);
    if (replyTextareaRef.current !== null) {
      replyTextareaRef.current.style.height = '';
    }
  }, [task]);

  //M 移入垃圾桶深色确认弹窗打开时，按 Esc 可即时取消关闭。
  react.useEffect(() => {
    if (!confirmTrashModalOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setConfirmTrashModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [confirmTrashModalOpen]);

  //M 同一任务被远端轮询刷新时仅同步非编辑中的字段，避免覆盖未保存草稿。
  react.useEffect(() => {
    if (task === undefined) return;
    if (prevTaskIdRef.current !== task.id) return;

    setTitleDraft(task.title);
    setOwnerDraft(task.owner);
    setLocksDraft(task.lockTags.join(', '));
    setCriteriaDraft(task.doneCriteria);
    if (!summaryEditing) {
      setSummaryDraft(task.summary);
    }
  }, [task?.id, task?.updatedAt]);

  if (task === undefined) {
    return (
      <aside className="tick-detail tick-detail--empty" aria-label="任务详情">
        <div className="tick-detail-placeholder">
          <div className="tick-detail-placeholder__icon" aria-hidden="true">
            ✓
          </div>
          <p className="tick-detail-placeholder__title">点选任意任务查看或编辑详情</p>
          <p className="tick-detail-placeholder__sub">
            支持子任务拆解、象限日期规划与 AI 协同控制
          </p>
        </div>
      </aside>
    );
  }

  const quadrant = utils.getEffectiveQuadrant(task);
  const done = utils.isTaskDone(task);
  const trashed = utils.isTaskTrashed(task);
  const currentList = utils.getTaskListName(task);
  const tags = task.tags ?? [];

  //M 找出当前任务的父任务与直接子任务。
  let parentTask: api.ControlTask | undefined;
  if (task.parentId !== undefined && task.parentId !== null) {
    parentTask = allTasks.find((item) => item.id === task.parentId);
  }
  const childTasks = allTasks.filter((item) => {
    if (utils.isTaskTrashed(item)) return false;

    return item.parentId === task.id;
  });

  /** 闪现一次轻量「已保存」提示。 */
  const flashSaved = (): void => {
    setSavedHint(true);
    window.setTimeout(() => setSavedHint(false), 1600);
  };

  /** 提交标题修改。 */
  const commitTitle = async (): Promise<void> => {
    const cleaned = titleDraft.trim();
    if (cleaned === '') {
      setTitleDraft(task.title);
      return;
    }
    if (cleaned === task.title) return;

    await onPatchTask(task.id, { title: cleaned, by: 'boss' });
    flashSaved();
  };

  /** 复制任意方案全文或时间线文本并闪现 1.5s 已复制提示。 */
  const handleCopyText = async (key: string, text: string): Promise<void> => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;

    window.clearTimeout(copyTimerRef.current);
    setCopiedKey(key);
    copyTimerRef.current = window.setTimeout(() => setCopiedKey(undefined), 1500);
  };

  /** 提交备注/方案修改（returnToRead=true 且内容非空时切回 Markdown 阅读态）。 */
  const commitSummary = async (returnToRead: boolean): Promise<void> => {
    if (summaryDraft !== task.summary) {
      await onPatchTask(task.id, { summary: summaryDraft, by: 'boss' });
      flashSaved();
    }
    if (returnToRead && summaryDraft.trim() !== '') {
      setSummaryEditing(false);
    }
  };

  /** 切换任务完成态。 */
  const toggleDone = async (): Promise<void> => {
    let nextStatus: api.ControlTaskStatus = 'done';
    if (done) {
      nextStatus = 'ready';
    }
    await onPatchTask(task.id, { status: nextStatus, by: 'boss' });
  };

  /** 设置或清除到期日期。 */
  const updateDueDate = async (nextDate: string | null): Promise<void> => {
    setDateMenuOpen(false);
    await onPatchTask(task.id, { dueDate: nextDate, by: 'boss' });
  };

  /** 切换四象限并同步优先级。 */
  const updateQuadrant = async (nextQ: api.TickQuadrant): Promise<void> => {
    const nextPriority = utils.getPriorityForQuadrant(nextQ);
    await onPatchTask(task.id, {
      quadrant: nextQ,
      priority: nextPriority,
      by: 'boss',
    });
  };

  /** 切换所属清单。 */
  const updateList = async (nextList: string): Promise<void> => {
    await onPatchTask(task.id, { list: nextList, by: 'boss' });
  };

  /** 添加一个标签。 */
  const handleAddTag = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const cleaned = tagDraft.trim().replace(/^#/u, '');
    if (cleaned === '') return;
    if (tags.includes(cleaned)) {
      setTagDraft('');
      return;
    }
    setTagDraft('');
    await onPatchTask(task.id, { tags: [...tags, cleaned], by: 'boss' });
  };

  /** 移除一个标签。 */
  const handleRemoveTag = async (target: string): Promise<void> => {
    const nextTags = tags.filter((item) => item !== target);
    await onPatchTask(task.id, { tags: nextTags, by: 'boss' });
  };

  /** 快速添加一条直接子任务。 */
  const handleAddSubtask = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const parsed = utils.parseQuickTaskInput(subtaskDraft);
    if (parsed.title === '') return;

    setSubtaskDraft('');
    await onCreateTask({
      title: parsed.title,
      kind: 'task',
      list: currentList,
      parentId: task.id,
      quadrant,
      priority: utils.getPriorityForQuadrant(quadrant),
      tags: parsed.tags,
      status: 'ready',
      by: 'boss',
    });
  };

  /** 切换某条子任务的完成状态。 */
  const handleToggleSubtask = async (sub: api.ControlTask): Promise<void> => {
    let nextStatus: api.ControlTaskStatus = 'done';
    if (utils.isTaskDone(sub)) {
      nextStatus = 'ready';
    }
    await onPatchTask(sub.id, { status: nextStatus, by: 'boss' });
  };

  /** 保存 AI 协同字段。 */
  const handleSaveAiFields = async (): Promise<void> => {
    setBusy(true);
    try {
      await onPatchTask(
        task.id,
        {
          owner: ownerDraft.trim(),
          lockTags: splitLocks(locksDraft),
          doneCriteria: criteriaDraft.trim(),
          by: 'boss',
        },
        '已更新 AI 协同配置',
      );
    } finally {
      setBusy(false);
    }
  };

  const personaList = personas ?? [];
  const selectedPersonaId = getPersonaIdFromTarget(replyTarget);
  let activePersona: api.PersonaSummary | undefined;
  if (selectedPersonaId !== undefined && onPersonaReview !== undefined) {
    activePersona = personaList.find((item) => item.id === selectedPersonaId);
  }

  /** 提交底部常驻批示/回复，或召唤无状态反方红军角色拍砖。 */
  const sendReply = async (): Promise<void> => {
    if (busy) return;

    const trimmed = noteDraft.trim();
    if (activePersona !== undefined && onPersonaReview !== undefined) {
      setBusy(true);
      try {
        const ok = await onPersonaReview(task.id, activePersona.id, trimmed);
        if (ok) {
          setNoteDraft('');
          if (replyTextareaRef.current !== null) {
            replyTextareaRef.current.style.height = '';
          }
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    if (trimmed === '') return;

    let notifyHelper: string | undefined;
    if (replyTarget === 'Claude' || replyTarget === 'HanXin') {
      notifyHelper = replyTarget;
    }
    setBusy(true);
    try {
      const ok = await onAppendEvent(task.id, trimmed, 'note', { notifyHelper });
      if (ok) {
        setNoteDraft('');
        if (replyTextareaRef.current !== null) {
          replyTextareaRef.current.style.height = '';
        }
      }
    } finally {
      setBusy(false);
    }
  };

  /** 底部批示框提交包装。 */
  const handleAppendNote = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    await sendReply();
  };

  /** 从垃圾桶还原任务。 */
  const handleRestoreFromTrash = async (): Promise<void> => {
    await onPatchTask(task.id, { trashedAt: null, by: 'boss' }, '已从垃圾桶还原');
  };

  /** 在自定义深色确认框中确认移入垃圾桶。 */
  const handleConfirmMoveToTrash = async (): Promise<void> => {
    setConfirmTrashModalOpen(false);
    await onPatchTask(task.id, { trashedAt: Date.now(), by: 'boss' }, '已移入垃圾桶');
  };

  let dueLabel = '设置日期';
  let dueClass = 'tick-detail-date-btn';
  if (task.dueDate !== undefined && task.dueDate !== null && task.dueDate !== '') {
    dueLabel = utils.formatShortDate(task.dueDate, todayStr);
    const diff = utils.diffDays(todayStr, task.dueDate);
    if (diff < 0 && !done) {
      dueClass = 'tick-detail-date-btn tick-detail-date-btn--overdue';
    }
    if (diff === 0 && !done) {
      dueClass = 'tick-detail-date-btn tick-detail-date-btn--today';
    }
  }

  let checkBtnClass = `tick-checkbox tick-checkbox--${quadrant}`;
  if (done) {
    checkBtnClass = `${checkBtnClass} tick-checkbox--done`;
  }

  let titleInputClass = 'tick-detail-title';
  if (done) {
    titleInputClass = 'tick-detail-title tick-detail-title--done';
  }

  const tomorrowStr = utils.addDaysStr(todayStr, 1);
  const nextWeekStr = utils.addDaysStr(todayStr, 7);
  const timelineEvents = task.events;
  const aiStatusInfo = utils.AI_STATUS_META[task.status];
  const allListNames = ['收集箱', ...lists.map((item) => item.name)];
  if (!allListNames.includes(currentList)) {
    allListNames.push(currentList);
  }

  const hasSummary = task.summary.trim() !== '';
  const showSummaryEditor = summaryEditing || !hasSummary;
  const isPersonaMode = activePersona !== undefined;
  let replyPlaceholder = '输入您的批示或回复，Ctrl+Enter 发送…';
  if (isPersonaMode) {
    replyPlaceholder = '可选：输入你想重点追问的问题，留空则直接对整张卡片一键拍砖…';
  }
  let replySendLabel = '发送并唤醒哈基米';
  if (replyTarget === 'HanXin') {
    replySendLabel = '发送并唤醒韩信';
  }
  if (replyTarget === 'none') {
    replySendLabel = '发送批示';
  }
  if (activePersona !== undefined) {
    replySendLabel = `召唤 ${activePersona.icon} ${activePersona.shortName}拍砖`;
  }
  if (busy && activePersona !== undefined) {
    replySendLabel = `${activePersona.icon} 拍砖思考中…`;
  }
  if (busy && activePersona === undefined) {
    replySendLabel = '发送中…';
  }
  const canSendReply = !busy && (isPersonaMode || noteDraft.trim() !== '');

  return (
    <aside className="tick-detail" aria-label="任务详情">
      {/* 顶部工具栏：勾选、直改状态、日期、四象限旗帜、垃圾桶 */}
      <header className="tick-detail__bar">
        <div className="tick-detail__bar-left">
          <button
            type="button"
            className={checkBtnClass}
            aria-label="切换任务完成状态"
            aria-pressed={done}
            onClick={() => void toggleDone()}
          >
            {done && <span aria-hidden="true">✓</span>}
          </button>
          <select
            className="tick-detail-status-select"
            data-status={task.status}
            aria-label="切换任务状态"
            title="切换任务当前状态"
            value={task.status}
            onChange={(e) => {
              const next = e.target.value as api.ControlTaskStatus;
              void onPatchTask(task.id, { status: next, by: 'boss' }, '已切换状态');
            }}
          >
            {TOPBAR_STATUS_OPTIONS.map((st) => (
              <option key={st.key} value={st.key}>
                {st.label}
              </option>
            ))}
          </select>
          <span className="tick-detail__divider" aria-hidden="true" />
          <div className="tick-detail-date-wrap">
            <button
              type="button"
              className={dueClass}
              onClick={() => setDateMenuOpen((prev) => !prev)}
            >
              <span aria-hidden="true">📅</span>
              <span>{dueLabel}</span>
            </button>
            {dateMenuOpen && (
              <div className="tick-popover tick-date-popover">
                <div className="tick-date-quick">
                  <button type="button" onClick={() => void updateDueDate(todayStr)}>
                    今天
                  </button>
                  <button type="button" onClick={() => void updateDueDate(tomorrowStr)}>
                    明天
                  </button>
                  <button type="button" onClick={() => void updateDueDate(nextWeekStr)}>
                    下周
                  </button>
                  <button
                    type="button"
                    className="tick-date-quick__clear"
                    onClick={() => void updateDueDate(null)}
                  >
                    清除
                  </button>
                </div>
                <input
                  type="date"
                  className="tick-date-native"
                  value={task.dueDate ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') {
                      void updateDueDate(null);
                      return;
                    }
                    void updateDueDate(val);
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="tick-detail__bar-right">
          <div className="tick-flag-group" role="group" aria-label="设置四象限优先级">
            {utils.QUADRANT_LIST.map((item) => {
              const active = quadrant === item.key;
              let flagClass = `tick-flag-btn tick-flag-btn--${item.key}`;
              if (active) {
                flagClass = `${flagClass} tick-flag-btn--active`;
              }
              return (
                <button
                  key={item.key}
                  type="button"
                  className={flagClass}
                  title={`${item.roman} ${item.label}`}
                  aria-pressed={active}
                  onClick={() => void updateQuadrant(item.key)}
                >
                  ⚑
                </button>
              );
            })}
          </div>
          {!trashed && (
            <button
              type="button"
              className="tick-icon-btn"
              title="移入垃圾桶"
              aria-label="移入垃圾桶"
              onClick={() => setConfirmTrashModalOpen(true)}
            >
              🗑
            </button>
          )}
          {onToggleWideRead !== undefined && (
            <button
              type="button"
              className="tick-wide-toggle"
              data-active={wideRead === true}
              title="在当前宽度与 720px 宽读模式间切换"
              aria-pressed={wideRead === true}
              onClick={onToggleWideRead}
            >
              {wideRead === true && '⛶ 收窄'}
              {wideRead !== true && '⛶ 展开'}
            </button>
          )}
          {onClose !== undefined && (
            <button
              type="button"
              className="tick-icon-btn"
              title="关闭详情"
              aria-label="关闭详情"
              onClick={onClose}
            >
              ✕
            </button>
          )}
        </div>
      </header>

      {/* 垃圾桶横幅：支持还原或页内二次确认彻底删除 */}
      {trashed && (
        <div className="tick-trash-banner">
          <span>该任务已在垃圾桶中</span>
          <div className="tick-trash-banner__actions">
            <button
              type="button"
              className="tick-mini-btn tick-mini-btn--primary"
              onClick={() => void handleRestoreFromTrash()}
            >
              还原
            </button>
            {!confirmHardDelete && (
              <button
                type="button"
                className="tick-mini-btn tick-mini-btn--danger"
                onClick={() => setConfirmHardDelete(true)}
              >
                彻底删除
              </button>
            )}
            {confirmHardDelete && (
              <button
                type="button"
                className="tick-mini-btn tick-mini-btn--danger-solid"
                onClick={() => void onDeleteTask(task.id)}
              >
                确认永久删除
              </button>
            )}
          </div>
        </div>
      )}

      {/* 移入垃圾桶深色确认弹窗（严禁原生 window.confirm） */}
      {confirmTrashModalOpen && !trashed && (
        <div
          className="tick-confirm-layer"
          role="dialog"
          aria-modal="true"
          aria-label="确认移入垃圾桶"
        >
          <div
            className="tick-confirm-mask"
            aria-hidden="true"
            onClick={() => setConfirmTrashModalOpen(false)}
          />
          <div className="tick-confirm-dialog">
            <h4 className="tick-confirm-dialog__title">🗑 移入垃圾桶？</h4>
            <p className="tick-confirm-dialog__desc">
              确认将「<strong>{task.title}</strong>」移入垃圾桶吗？移入后可在左侧底部「垃圾桶」随时还原。
            </p>
            <div className="tick-confirm-dialog__actions">
              <button
                type="button"
                className="tick-mini-btn"
                onClick={() => setConfirmTrashModalOpen(false)}
              >
                取消 (Esc)
              </button>
              <button
                type="button"
                className="tick-mini-btn tick-mini-btn--danger-solid"
                onClick={() => void handleConfirmMoveToTrash()}
              >
                确认移入垃圾桶
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 主体滚动区 */}
      <div className="tick-detail__body">
        {parentTask !== undefined && (
          <button
            type="button"
            className="tick-parent-crumb"
            onClick={() => onSelectTask(parentTask.id)}
          >
            ↖ 上级任务：{parentTask.title}
          </button>
        )}

        <div className="tick-detail-title-row">
          <input
            ref={titleInputRef}
            type="text"
            className={titleInputClass}
            value={titleDraft}
            title="点击直接修改标题（回车保存）"
            placeholder="任务标题"
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                setTitleDraft(task.title);
                e.currentTarget.blur();
              }
            }}
          />
          <button
            type="button"
            className="tick-detail-title-edit"
            title="点击直接修改标题（回车保存）"
            aria-label="修改标题"
            onClick={() => {
              titleInputRef.current?.focus();
              titleInputRef.current?.select();
            }}
          >
            ✎
          </button>
          {savedHint && <span className="tick-saved-hint">已保存</span>}
        </div>

        {/* 方案简报 / 正文：非空默认 Markdown 阅读态，支持一键复制全文与双态切换编辑 */}
        {!showSummaryEditor && (
          <section className="tick-summary-card" aria-label="方案简报">
            <div className="tick-summary-card__head">
              <span className="tick-summary-card__label">📄 方案简报</span>
              <div className="tick-summary-card__actions">
                <button
                  type="button"
                  className="tick-copy-btn"
                  data-copied={copiedKey === 'summary'}
                  onClick={() => void handleCopyText('summary', task.summary)}
                >
                  {copiedKey === 'summary' && '✓ 已复制'}
                  {copiedKey !== 'summary' && '📋 复制全文'}
                </button>
                <button
                  type="button"
                  className="tick-mini-btn"
                  onClick={() => {
                    setSummaryDraft(task.summary);
                    setSummaryEditing(true);
                  }}
                >
                  ✏️ 编辑
                </button>
              </div>
            </div>
            <div className="tick-summary-card__body tick-markdown">
              <markdownModule.Markdown text={task.summary} onOpen={() => undefined} />
            </div>
          </section>
        )}

        {showSummaryEditor && (
          <section className="tick-summary-editor" aria-label="编辑方案简报">
            <div className="tick-summary-card__head">
              <span className="tick-summary-card__label">✏️ 编辑方案简报（支持 Markdown）</span>
              {hasSummary && (
                <div className="tick-summary-card__actions">
                  <button
                    type="button"
                    className="tick-copy-btn"
                    data-copied={copiedKey === 'summary'}
                    onClick={() => void handleCopyText('summary', summaryDraft)}
                  >
                    {copiedKey === 'summary' && '✓ 已复制'}
                    {copiedKey !== 'summary' && '📋 复制'}
                  </button>
                </div>
              )}
            </div>
            <textarea
              className="tick-detail-summary"
              rows={6}
              value={summaryDraft}
              placeholder="输入方案简报、话术或工单（支持 Markdown、表格与 ```代码块```，Ctrl+S 保存）…"
              onChange={(e) => setSummaryDraft(e.target.value)}
              onBlur={() => void commitSummary(false)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  void commitSummary(true);
                }
              }}
            />
            <div className="tick-summary-editor__actions">
              <button
                type="button"
                className="tick-mini-btn tick-mini-btn--primary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void commitSummary(true)}
              >
                保存并返回阅读
              </button>
              {hasSummary && (
                <button
                  type="button"
                  className="tick-mini-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSummaryDraft(task.summary);
                    setSummaryEditing(false);
                  }}
                >
                  取消
                </button>
              )}
            </div>
          </section>
        )}

        {/* 直接可见的交互时间线：老板批示与 AI 回复分区呈现 + Markdown 渲染 + 单条复制 */}
        <section className="tick-detail-section tick-timeline-section" aria-label="对话与批示时间线">
          <div className="tick-detail-section__head">
            <span>💬 对话与批示时间线</span>
            <span className="tick-detail-section__count">{String(timelineEvents.length)} 条</span>
          </div>
          {timelineEvents.length === 0 && (
            <p className="tick-timeline-empty">暂无互动记录，在下方输入批示即可直达对应中控</p>
          )}
          {timelineEvents.length > 0 && (
            <ul className="tick-timeline-list">
              {timelineEvents.map((ev, idx) => {
                const isBoss = ev.by === 'boss';
                const isRedteam = ev.kind === 'redteam';
                let roleAttr = 'ai';
                let roleLabel = `🤖 ${ev.by}`;
                if (isBoss) {
                  roleAttr = 'boss';
                  roleLabel = '👤 老板批示';
                }
                if (isRedteam) {
                  roleAttr = 'redteam';
                  roleLabel = ev.by;
                }
                const kindLabel = EVENT_KIND_LABELS[ev.kind] ?? ev.kind;
                const copyKey = `ev-${String(idx)}`;
                const isCopied = copiedKey === copyKey;
                return (
                  <li
                    key={`${String(ev.at)}-${String(idx)}`}
                    className="tick-event-card"
                    data-role={roleAttr}
                  >
                    <div className="tick-event-card__head">
                      <div className="tick-event-card__meta">
                        <span className="tick-event-card__by">{roleLabel}</span>
                        <span className="tick-event-card__kind">{kindLabel}</span>
                        <span className="tick-event-card__time">{utils.formatEventTime(ev.at)}</span>
                      </div>
                      <button
                        type="button"
                        className="tick-copy-btn tick-copy-btn--sm"
                        data-copied={isCopied}
                        onClick={() => void handleCopyText(copyKey, ev.text)}
                      >
                        {isCopied && '✓ 已复制'}
                        {!isCopied && '复制'}
                      </button>
                    </div>
                    <div className="tick-event-card__body tick-markdown">
                      <markdownModule.Markdown text={ev.text} onOpen={() => undefined} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 标签区块 */}
        <section className="tick-detail-section">
          <div className="tick-detail-section__head">
            <span>标签</span>
          </div>
          <div className="tick-tags-row">
            {tags.map((tag) => (
              <span key={tag} className="tick-tag-pill">
                #{tag}
                <button
                  type="button"
                  aria-label={`移除标签 ${tag}`}
                  onClick={() => void handleRemoveTag(tag)}
                >
                  ×
                </button>
              </span>
            ))}
            <form className="tick-tag-add-form" onSubmit={(e) => void handleAddTag(e)}>
              <input
                type="text"
                className="tick-tag-input"
                value={tagDraft}
                placeholder="+ 添加标签"
                onChange={(e) => setTagDraft(e.target.value)}
              />
            </form>
          </div>
        </section>

        {/* 内联子任务区块 */}
        <section className="tick-detail-section">
          <div className="tick-detail-section__head">
            <span>子任务</span>
            <span className="tick-detail-section__count">{String(childTasks.length)}</span>
          </div>
          <div className="tick-subtasks">
            {childTasks.map((sub) => {
              const subDone = utils.isTaskDone(sub);
              const subQ = utils.getEffectiveQuadrant(sub);
              let subCheckClass = `tick-checkbox tick-checkbox--sm tick-checkbox--${subQ}`;
              if (subDone) {
                subCheckClass = `${subCheckClass} tick-checkbox--done`;
              }
              let subTitleClass = 'tick-subtask-item__title';
              if (subDone) {
                subTitleClass = `${subTitleClass} tick-subtask-item__title--done`;
              }
              return (
                <div key={sub.id} className="tick-subtask-item">
                  <button
                    type="button"
                    className={subCheckClass}
                    aria-label={`切换子任务 ${sub.title}`}
                    onClick={() => void handleToggleSubtask(sub)}
                  >
                    {subDone && <span aria-hidden="true">✓</span>}
                  </button>
                  <button
                    type="button"
                    className={subTitleClass}
                    onClick={() => onSelectTask(sub.id)}
                  >
                    {sub.title}
                  </button>
                </div>
              );
            })}
            <form className="tick-subtask-add" onSubmit={(e) => void handleAddSubtask(e)}>
              <input
                type="text"
                value={subtaskDraft}
                placeholder="+ 添加子任务，回车创建…"
                onChange={(e) => setSubtaskDraft(e.target.value)}
              />
            </form>
          </div>
        </section>

        {/* 底部折叠「AI 协同控制」小卡片 */}
        <section className="tick-ai-card">
          <button
            type="button"
            className="tick-ai-card__toggle"
            aria-expanded={aiExpanded}
            onClick={() => setAiExpanded((prev) => !prev)}
          >
            <span className="tick-ai-card__title">🤖 AI 协同控制</span>
            <span className="tick-ai-card__summary">
              {aiStatusInfo.label} · {task.priority} · {String(task.events.length)} 条记录
            </span>
            <span className="tick-ai-card__chev" aria-hidden="true">
              {aiExpanded && '▾'}
              {!aiExpanded && '▸'}
            </span>
          </button>

          {aiExpanded && (
            <div className="tick-ai-card__body">
              <div className="tick-ai-grid">
                <label className="tick-ai-field">
                  <span>控制面状态</span>
                  <select
                    value={task.status}
                    onChange={(e) => {
                      const next = e.target.value as api.ControlTaskStatus;
                      void onPatchTask(task.id, { status: next, by: 'boss' });
                    }}
                  >
                    {AI_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {utils.AI_STATUS_META[st].label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="tick-ai-field">
                  <span>优先级</span>
                  <select
                    value={task.priority}
                    onChange={(e) => {
                      const next = e.target.value as api.ControlTaskPriority;
                      void onPatchTask(task.id, { priority: next, by: 'boss' });
                    }}
                  >
                    {AI_PRIORITIES.map((pr) => (
                      <option key={pr} value={pr}>
                        {pr}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="tick-ai-field">
                <span>认领 AI / 负责人</span>
                <input
                  type="text"
                  value={ownerDraft}
                  placeholder="如 coder-opus / central"
                  onChange={(e) => setOwnerDraft(e.target.value)}
                />
              </label>

              <label className="tick-ai-field">
                <span>资源占坑锁（逗号分隔）</span>
                <input
                  type="text"
                  value={locksDraft}
                  placeholder="如 repo:jmbots, host:win"
                  onChange={(e) => setLocksDraft(e.target.value)}
                />
              </label>

              <label className="tick-ai-field">
                <span>验收标准</span>
                <input
                  type="text"
                  value={criteriaDraft}
                  placeholder="可验证的完成标准…"
                  onChange={(e) => setCriteriaDraft(e.target.value)}
                />
              </label>

              <div className="tick-ai-actions">
                <button
                  type="button"
                  className="tick-mini-btn tick-mini-btn--primary"
                  disabled={busy}
                  onClick={() => void handleSaveAiFields()}
                >
                  保存 AI 配置
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* 底部常驻「批示 / 回复给 AI · 无状态反方红军拍砖」快捷输入条 */}
      <form
        className="tick-reply-bar"
        data-persona={isPersonaMode}
        aria-label="批示与回复给 AI"
        onSubmit={(e) => void handleAppendNote(e)}
      >
        <div className="tick-reply-bar__head">
          <span className="tick-reply-bar__title">💬 批示 / 反方拍砖</span>
          <div className="tick-reply-targets" role="group" aria-label="选择唤醒目标或反方红军角色">
            {REPLY_TARGET_OPTIONS.map((opt) => {
              const selected = replyTarget === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  className="tick-reply-target"
                  title={opt.hint}
                  aria-pressed={selected}
                  data-active={selected}
                  data-target={opt.key}
                  onClick={() => setReplyTarget(opt.key)}
                >
                  {opt.label}
                </button>
              );
            })}
            {personaList.length > 0 && onPersonaReview !== undefined && (
              <>
                <span className="tick-reply-targets__sep" aria-hidden="true" />
                {personaList.map((persona) => {
                  const targetKey: ReplyTarget = `persona:${persona.id}`;
                  const selected = replyTarget === targetKey;
                  const modelLabel = persona.resolvedModel || persona.preferredModel;
                  return (
                    <button
                      key={targetKey}
                      type="button"
                      className="tick-reply-target tick-reply-target--persona"
                      title={`${persona.tagline}（无状态模型：${modelLabel}）`}
                      aria-pressed={selected}
                      data-active={selected}
                      data-target="persona"
                      onClick={() => setReplyTarget(targetKey)}
                    >
                      {persona.icon} {persona.shortName}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
        <div className="tick-reply-bar__composer">
          <textarea
            ref={replyTextareaRef}
            className="tick-reply-bar__input"
            rows={2}
            value={noteDraft}
            placeholder={replyPlaceholder}
            onChange={(e) => {
              setNoteDraft(e.target.value);
              resizeReplyTextarea(e.currentTarget);
            }}
            onKeyDown={(e) => {
              const isSubmitKey = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
              if (isSubmitKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void sendReply();
              }
            }}
          />
          <button
            type="submit"
            className="tick-reply-bar__send"
            data-persona={isPersonaMode}
            disabled={!canSendReply}
          >
            {replySendLabel}
          </button>
        </div>
      </form>

      {/* 底部栏：所属清单快速切换 */}
      <footer className="tick-detail__foot">
        <span className="tick-detail__foot-icon" aria-hidden="true">
          📥
        </span>
        <select
          className="tick-detail__list-select"
          aria-label="切换所属清单"
          value={currentList}
          onChange={(e) => void updateList(e.target.value)}
        >
          {allListNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </footer>
    </aside>
  );
}
