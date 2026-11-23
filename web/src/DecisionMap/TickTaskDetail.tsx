/** 滴答工作台右侧任务详情面板：编辑标题备注、日期象限、标签、内联子任务与 AI 协同控制。 */
import * as react from 'react';
import * as api from './DecisionMapApi.ts';
import * as utils from './TickUtils.ts';

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
  /** 是否作为右侧滑板浮层展示（提供关闭按钮）。 */
  onClose?: () => void;
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
  /** 追加 AI 协同事件回调。 */
  onAppendEvent: (
    taskId: string,
    text: string,
    kind: api.ControlTaskEventKind,
  ) => Promise<void>;
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

/** 拆分逗号或空格分隔的锁标签输入。 */
function splitLocks(raw: string): string[] {
  return raw
    .split(/[,，\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 滴答右侧任务详情面板组件。 */
export function TickTaskDetail(props: TickTaskDetailProps): react.JSX.Element {
  const {
    task,
    allTasks,
    lists,
    todayStr,
    onClose,
    onSelectTask,
    onPatchTask,
    onCreateTask,
    onAppendEvent,
    onDeleteTask,
  } = props;

  const [titleDraft, setTitleDraft] = react.useState('');
  const [summaryDraft, setSummaryDraft] = react.useState('');
  const [tagDraft, setTagDraft] = react.useState('');
  const [subtaskDraft, setSubtaskDraft] = react.useState('');
  const [dateMenuOpen, setDateMenuOpen] = react.useState(false);
  const [aiExpanded, setAiExpanded] = react.useState(false);
  const [confirmHardDelete, setConfirmHardDelete] = react.useState(false);
  const [savedHint, setSavedHint] = react.useState(false);

  //M AI 协同字段本地草稿，避免打字过程频繁触发请求。
  const [ownerDraft, setOwnerDraft] = react.useState('');
  const [locksDraft, setLocksDraft] = react.useState('');
  const [criteriaDraft, setCriteriaDraft] = react.useState('');
  const [noteDraft, setNoteDraft] = react.useState('');
  const [busy, setBusy] = react.useState(false);

  //M 切换任务或远端刷新时同步表单草稿。
  react.useEffect(() => {
    if (task === undefined) return;

    setTitleDraft(task.title);
    setSummaryDraft(task.summary);
    setOwnerDraft(task.owner);
    setLocksDraft(task.lockTags.join(', '));
    setCriteriaDraft(task.doneCriteria);
    setTagDraft('');
    setSubtaskDraft('');
    setNoteDraft('');
    setDateMenuOpen(false);
    setConfirmHardDelete(false);
    setSavedHint(false);
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

  /** 提交备注修改。 */
  const commitSummary = async (): Promise<void> => {
    if (summaryDraft === task.summary) return;

    await onPatchTask(task.id, { summary: summaryDraft, by: 'boss' });
    flashSaved();
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

  /** 追加一条时间线协同备注。 */
  const handleAppendNote = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = noteDraft.trim();
    if (trimmed === '') return;

    setBusy(true);
    try {
      await onAppendEvent(task.id, trimmed, 'note');
      setNoteDraft('');
    } finally {
      setBusy(false);
    }
  };

  /** 移入垃圾桶或从垃圾桶还原。 */
  const handleToggleTrash = async (): Promise<void> => {
    if (trashed) {
      await onPatchTask(task.id, { trashedAt: null, by: 'boss' }, '已从垃圾桶还原');
      return;
    }
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
  const reversedEvents = [...task.events].reverse();
  const aiStatusInfo = utils.AI_STATUS_META[task.status];
  const allListNames = ['收集箱', ...lists.map((item) => item.name)];
  if (!allListNames.includes(currentList)) {
    allListNames.push(currentList);
  }

  return (
    <aside className="tick-detail" aria-label="任务详情">
      {/* 顶部工具栏：勾选、日期、四象限旗帜、垃圾桶 */}
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
              onClick={() => void handleToggleTrash()}
            >
              🗑
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
              onClick={() => void handleToggleTrash()}
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
            type="text"
            className={titleInputClass}
            value={titleDraft}
            placeholder="任务标题"
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
          {savedHint && <span className="tick-saved-hint">已保存</span>}
        </div>

        <textarea
          className="tick-detail-summary"
          rows={4}
          value={summaryDraft}
          placeholder="输入内容或备注，失焦自动保存…"
          onChange={(e) => setSummaryDraft(e.target.value)}
          onBlur={() => void commitSummary()}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              void commitSummary();
            }
          }}
        />

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

              {/* 变更与心跳时间线 */}
              <div className="tick-ai-events">
                <div className="tick-ai-events__head">协同时间线</div>
                <form className="tick-ai-note-form" onSubmit={(e) => void handleAppendNote(e)}>
                  <input
                    type="text"
                    value={noteDraft}
                    placeholder="追加一条协同备注…"
                    onChange={(e) => setNoteDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="tick-mini-btn"
                    disabled={busy || noteDraft.trim() === ''}
                  >
                    记录
                  </button>
                </form>
                {reversedEvents.length === 0 && (
                  <p className="tick-ai-events__empty">暂无时间线记录</p>
                )}
                {reversedEvents.length > 0 && (
                  <ul className="tick-ai-events__list">
                    {reversedEvents.map((ev, idx) => (
                      <li key={`${String(ev.at)}-${String(idx)}`} className="tick-ai-event-row">
                        <div className="tick-ai-event-row__meta">
                          <span className="tick-ai-event-row__by">{ev.by}</span>
                          <span>{utils.formatEventTime(ev.at)}</span>
                        </div>
                        <p className="tick-ai-event-row__text">{ev.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

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
