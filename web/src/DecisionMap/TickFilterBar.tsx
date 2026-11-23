/**
 * 积木AI工作台顶部「动态组合筛选条」与内置「存为视图 / 编辑视图」模态窗：
 * 支持标签（多选 + AND/OR）、状态、优先级、日期、来源渠道实时组合过滤，零原生弹窗持久化钉入侧栏。
 */
import * as react from 'react';
import type * as api from './DecisionMapApi.ts';
import * as utils from './TickUtils.ts';
import * as filterEngine from './WorkbenchFilter.ts';

/** 当前展开的下拉菜单类型。 */
type PopoverKey = 'tag' | 'status' | 'priority' | 'due' | 'channel';

/** 顶部动态组合筛选条组件入参。 */
export interface TickFilterBarProps {
  /** 当前激活的临时组合筛选条件。 */
  rule: api.TaskFilterRule;
  /** 更新临时组合筛选条件回调。 */
  onChangeRule: (next: api.TaskFilterRule) => void;
  /** 一键重置筛选条件回调。 */
  onReset: () => void;
  /** 点击「存为视图」打开内置模态窗回调。 */
  onOpenSaveView: () => void;
  /** 全量可用标签及其实时节点计数。 */
  tagEntries: ReadonlyArray<readonly [string, number]>;
  /** 当前组合筛选命中的活跃节点数。 */
  matchedCount: number;
  /** 当前左侧范围不是「全部节点」时可选展示的范围胶囊（支持一键退回全部节点）。 */
  scopePill?: {
    icon: string;
    label: string;
    isCustomView: boolean;
    onClear: () => void;
  };
}

/** 切换字符串数组中的某个元素，空数组归一为 undefined。 */
function toggleItemInArray<T extends string>(
  list: readonly T[] | undefined,
  item: T,
): T[] | undefined {
  const current = list ?? [];
  const exists = current.includes(item);
  let next: T[] = [];
  if (exists) {
    next = current.filter((val) => val !== item);
  }
  if (!exists) {
    next = [...current, item];
  }
  if (next.length === 0) return undefined;

  return next;
}

/** 顶部动态组合筛选条组件（列表、四象限、日历三大视图统一挂载）。 */
export function TickFilterBar(props: TickFilterBarProps): react.JSX.Element {
  const {
    rule,
    onChangeRule,
    onReset,
    onOpenSaveView,
    tagEntries,
    matchedCount,
    scopePill,
  } = props;

  const [openPop, setOpenPop] = react.useState<PopoverKey | undefined>(undefined);
  const [tagQuery, setTagQuery] = react.useState('');
  const barRef = react.useRef<HTMLDivElement | null>(null);

  //M 点击筛选条外部时自动收起打开的下拉浮层。
  react.useEffect(() => {
    if (openPop === undefined) return;

    const handlePointerDown = (event: PointerEvent): void => {
      const root = barRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;

      setOpenPop(undefined);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [openPop]);

  const activeTags = rule.tags ?? [];
  const activeTagMode: api.TaskTagMode = rule.tagMode ?? 'and';
  const activeStatuses = rule.statuses ?? [];
  const activePriorities = rule.priorities ?? [];
  const activeQuadrants = rule.quadrants ?? [];
  const activeDue = rule.dueScope ?? 'all';
  const activeChannels = rule.sourceChannels ?? [];
  const keyword = rule.keyword ?? '';

  const hasAdhoc = filterEngine.hasActiveRuleConditions(rule);

  const filteredTagOptions = react.useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    if (q === '') return tagEntries;

    return tagEntries.filter(([name]) => name.toLowerCase().includes(q));
  }, [tagEntries, tagQuery]);

  /** 切换指定下拉菜单开关。 */
  const togglePop = (key: PopoverKey): void => {
    setOpenPop((prev) => {
      if (prev === key) return undefined;

      return key;
    });
  };

  /** 切换单个标签选中态。 */
  const toggleTag = (tagName: string): void => {
    onChangeRule({
      ...rule,
      tags: toggleItemInArray(rule.tags, tagName),
    });
  };

  /** 在「且 (AND)」与「或 (OR)」之间切换多标签模式。 */
  const flipTagMode = (): void => {
    let nextMode: api.TaskTagMode = 'or';
    if (activeTagMode === 'or') {
      nextMode = 'and';
    }
    onChangeRule({ ...rule, tagMode: nextMode });
  };

  /** 切换单个状态筛选项。 */
  const toggleStatus = (st: api.ControlTaskStatus): void => {
    onChangeRule({
      ...rule,
      statuses: toggleItemInArray(rule.statuses, st),
    });
  };

  /** 切换单个优先级筛选项。 */
  const togglePriority = (pr: api.ControlTaskPriority): void => {
    onChangeRule({
      ...rule,
      priorities: toggleItemInArray(rule.priorities, pr),
    });
  };

  /** 切换单个四象限筛选项。 */
  const toggleQuadrant = (q: api.TickQuadrant): void => {
    onChangeRule({
      ...rule,
      quadrants: toggleItemInArray(rule.quadrants, q),
    });
  };

  /** 选择或取消到期日范围。 */
  const selectDueScope = (scopeKey: Exclude<api.TaskDueScope, 'all'>): void => {
    let nextScope: api.TaskDueScope | undefined = scopeKey;
    if (activeDue === scopeKey) {
      nextScope = undefined;
    }
    onChangeRule({ ...rule, dueScope: nextScope });
    setOpenPop(undefined);
  };

  /** 切换单个来源渠道筛选项。 */
  const toggleChannel = (channelKey: string): void => {
    onChangeRule({
      ...rule,
      sourceChannels: toggleItemInArray(rule.sourceChannels, channelKey),
    });
  };

  let tagModeLabel = '且';
  if (activeTagMode === 'or') {
    tagModeLabel = '或';
  }
  const activeDueOption = filterEngine.FILTER_DUE_OPTIONS.find((opt) => opt.key === activeDue);

  return (
    <div ref={barRef} className="tick-fbar" role="region" aria-label="动态组合筛选条">
      <div className="tick-fbar__left">
        {scopePill !== undefined && (
          <span className="tick-fbar__scope-pill" title="当前左侧基准范围，点 × 切回全部节点">
            <span>{scopePill.icon}</span>
            <span>{scopePill.label}</span>
            <button
              type="button"
              aria-label={`退出范围 ${scopePill.label}`}
              onClick={scopePill.onClear}
            >
              ×
            </button>
          </span>
        )}

        {/* 1. 标签多选 + AND/OR 下拉 */}
        <div className="tick-fbar__drop-wrap">
          <button
            type="button"
            className="tick-fbar__trigger"
            data-active={activeTags.length > 0 || openPop === 'tag'}
            aria-expanded={openPop === 'tag'}
            onClick={() => togglePop('tag')}
          >
            <span>🏷️ 标签</span>
            {activeTags.length > 0 && (
              <span className="tick-fbar__badge">{String(activeTags.length)}</span>
            )}
            <span className="tick-fbar__caret" aria-hidden="true">▾</span>
          </button>

          {openPop === 'tag' && (
            <div className="tick-fbar__pop tick-fbar__pop--tags">
              <div className="tick-fbar__pop-head">
                <input
                  type="text"
                  className="tick-fbar__pop-search"
                  value={tagQuery}
                  placeholder="搜标签…"
                  autoFocus
                  onChange={(e) => setTagQuery(e.target.value)}
                />
                <div className="tick-fbar__mode-switch" role="group" aria-label="多标签组合关系">
                  <button
                    type="button"
                    data-active={activeTagMode === 'and'}
                    onClick={() => onChangeRule({ ...rule, tagMode: 'and' })}
                  >
                    且 AND
                  </button>
                  <button
                    type="button"
                    data-active={activeTagMode === 'or'}
                    onClick={() => onChangeRule({ ...rule, tagMode: 'or' })}
                  >
                    或 OR
                  </button>
                </div>
              </div>

              <div className="tick-fbar__tag-list">
                {filteredTagOptions.length === 0 && (
                  <div className="tick-fbar__pop-empty">暂无匹配标签</div>
                )}
                {filteredTagOptions.map(([tagName, count]) => {
                  const checked = activeTags.includes(tagName);
                  return (
                    <button
                      key={tagName}
                      type="button"
                      className="tick-fbar__opt"
                      data-checked={checked}
                      onClick={() => toggleTag(tagName)}
                    >
                      <span className="tick-fbar__opt-box" aria-hidden="true">
                        {checked && '✓'}
                      </span>
                      <span className="tick-fbar__opt-label">#{tagName}</span>
                      <span className="tick-fbar__opt-count">{String(count)}</span>
                    </button>
                  );
                })}
              </div>

              {activeTags.length > 0 && (
                <button
                  type="button"
                  className="tick-fbar__pop-clear"
                  onClick={() => onChangeRule({ ...rule, tags: undefined })}
                >
                  清空已选标签
                </button>
              )}
            </div>
          )}
        </div>

        {/* 2. 状态多选下拉 */}
        <div className="tick-fbar__drop-wrap">
          <button
            type="button"
            className="tick-fbar__trigger"
            data-active={activeStatuses.length > 0 || openPop === 'status'}
            aria-expanded={openPop === 'status'}
            onClick={() => togglePop('status')}
          >
            <span>⚡ 状态</span>
            {activeStatuses.length > 0 && (
              <span className="tick-fbar__badge">{String(activeStatuses.length)}</span>
            )}
            <span className="tick-fbar__caret" aria-hidden="true">▾</span>
          </button>

          {openPop === 'status' && (
            <div className="tick-fbar__pop">
              {filterEngine.FILTER_STATUS_OPTIONS.map((opt) => {
                const checked = activeStatuses.includes(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className="tick-fbar__opt"
                    data-checked={checked}
                    onClick={() => toggleStatus(opt.key)}
                  >
                    <span className="tick-fbar__opt-box" aria-hidden="true">
                      {checked && '✓'}
                    </span>
                    <span className="tick-fbar__opt-label">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 3. 优先级与四象限多选下拉 */}
        <div className="tick-fbar__drop-wrap">
          <button
            type="button"
            className="tick-fbar__trigger"
            data-active={
              activePriorities.length > 0
              || activeQuadrants.length > 0
              || openPop === 'priority'
            }
            aria-expanded={openPop === 'priority'}
            onClick={() => togglePop('priority')}
          >
            <span>🎯 优先级</span>
            {activePriorities.length + activeQuadrants.length > 0 && (
              <span className="tick-fbar__badge">
                {String(activePriorities.length + activeQuadrants.length)}
              </span>
            )}
            <span className="tick-fbar__caret" aria-hidden="true">▾</span>
          </button>

          {openPop === 'priority' && (
            <div className="tick-fbar__pop">
              <div className="tick-fbar__pop-group-label">控制面优先级</div>
              {filterEngine.FILTER_PRIORITY_OPTIONS.map((pr) => {
                const checked = activePriorities.includes(pr);
                return (
                  <button
                    key={pr}
                    type="button"
                    className="tick-fbar__opt"
                    data-checked={checked}
                    onClick={() => togglePriority(pr)}
                  >
                    <span className="tick-fbar__opt-box" aria-hidden="true">
                      {checked && '✓'}
                    </span>
                    <span className="tick-fbar__opt-label">{pr}</span>
                  </button>
                );
              })}
              <div className="tick-fbar__pop-sep" />
              <div className="tick-fbar__pop-group-label">四象限</div>
              {utils.QUADRANT_LIST.map((qMeta) => {
                const checked = activeQuadrants.includes(qMeta.key);
                return (
                  <button
                    key={qMeta.key}
                    type="button"
                    className="tick-fbar__opt"
                    data-checked={checked}
                    onClick={() => toggleQuadrant(qMeta.key)}
                  >
                    <span className="tick-fbar__opt-box" aria-hidden="true">
                      {checked && '✓'}
                    </span>
                    <span className="tick-fbar__opt-label">
                      {qMeta.roman} · {qMeta.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 4. 日期范围单选下拉 */}
        <div className="tick-fbar__drop-wrap">
          <button
            type="button"
            className="tick-fbar__trigger"
            data-active={activeDue !== 'all' || openPop === 'due'}
            aria-expanded={openPop === 'due'}
            onClick={() => togglePop('due')}
          >
            <span>📅 日期</span>
            <span className="tick-fbar__caret" aria-hidden="true">▾</span>
          </button>

          {openPop === 'due' && (
            <div className="tick-fbar__pop">
              {filterEngine.FILTER_DUE_OPTIONS.map((opt) => {
                const checked = activeDue === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className="tick-fbar__opt"
                    data-checked={checked}
                    onClick={() => selectDueScope(opt.key)}
                  >
                    <span className="tick-fbar__opt-box" aria-hidden="true">
                      {checked && '✓'}
                    </span>
                    <span className="tick-fbar__opt-label">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 5. 来源渠道多选下拉 */}
        <div className="tick-fbar__drop-wrap">
          <button
            type="button"
            className="tick-fbar__trigger"
            data-active={activeChannels.length > 0 || openPop === 'channel'}
            aria-expanded={openPop === 'channel'}
            onClick={() => togglePop('channel')}
          >
            <span>📡 来源渠道</span>
            {activeChannels.length > 0 && (
              <span className="tick-fbar__badge">{String(activeChannels.length)}</span>
            )}
            <span className="tick-fbar__caret" aria-hidden="true">▾</span>
          </button>

          {openPop === 'channel' && (
            <div className="tick-fbar__pop">
              {filterEngine.FILTER_CHANNEL_OPTIONS.map((opt) => {
                const checked = activeChannels.includes(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className="tick-fbar__opt"
                    data-checked={checked}
                    onClick={() => toggleChannel(opt.key)}
                  >
                    <span className="tick-fbar__opt-box" aria-hidden="true">
                      {checked && '✓'}
                    </span>
                    <span className="tick-fbar__opt-label">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 6. 轻量关键词即时过滤 */}
        <div className="tick-fbar__kw-wrap">
          <input
            type="text"
            className="tick-fbar__kw-input"
            value={keyword}
            placeholder="🔍 筛选词…"
            aria-label="按标题、内容或标签关键词筛选"
            onChange={(e) => {
              const val = e.target.value;
              if (val.trim() === '') {
                onChangeRule({ ...rule, keyword: undefined });
                return;
              }
              onChangeRule({ ...rule, keyword: val });
            }}
          />
          {keyword !== '' && (
            <button
              type="button"
              className="tick-fbar__kw-clear"
              aria-label="清空关键词"
              onClick={() => onChangeRule({ ...rule, keyword: undefined })}
            >
              ×
            </button>
          )}
        </div>

        {/* 激活条件胶囊展示与一键移除 */}
        {activeTags.length > 1 && (
          <button
            type="button"
            className="tick-fbar__mode-chip"
            title="点击切换多标签组合关系（且 AND / 或 OR）"
            onClick={flipTagMode}
          >
            标签:{tagModeLabel} ⇄
          </button>
        )}

        {activeTags.map((tag) => (
          <span key={`tag-${tag}`} className="tick-fbar__chip tick-fbar__chip--tag">
            <span>#{tag}</span>
            <button
              type="button"
              aria-label={`移除标签筛选 ${tag}`}
              onClick={() => toggleTag(tag)}
            >
              ×
            </button>
          </span>
        ))}

        {activeStatuses.map((st) => {
          const opt = filterEngine.FILTER_STATUS_OPTIONS.find((item) => item.key === st);
          return (
            <span key={`st-${st}`} className="tick-fbar__chip">
              <span>{opt?.short ?? st}</span>
              <button
                type="button"
                aria-label={`移除状态筛选 ${st}`}
                onClick={() => toggleStatus(st)}
              >
                ×
              </button>
            </span>
          );
        })}

        {activePriorities.map((pr) => (
          <span key={`pr-${pr}`} className="tick-fbar__chip">
            <span>{pr}</span>
            <button
              type="button"
              aria-label={`移除优先级筛选 ${pr}`}
              onClick={() => togglePriority(pr)}
            >
              ×
            </button>
          </span>
        ))}

        {activeQuadrants.map((q) => (
          <span key={`q-${q}`} className="tick-fbar__chip">
            <span>象限 {utils.QUADRANT_MAP[q].roman}</span>
            <button
              type="button"
              aria-label={`移除象限筛选 ${q}`}
              onClick={() => toggleQuadrant(q)}
            >
              ×
            </button>
          </span>
        ))}

        {activeDueOption !== undefined && (
          <span className="tick-fbar__chip">
            <span>📅 {activeDueOption.label}</span>
            <button
              type="button"
              aria-label="移除日期筛选"
              onClick={() => onChangeRule({ ...rule, dueScope: undefined })}
            >
              ×
            </button>
          </span>
        )}

        {activeChannels.map((ch) => {
          const opt = filterEngine.FILTER_CHANNEL_OPTIONS.find((item) => item.key === ch);
          return (
            <span key={`ch-${ch}`} className="tick-fbar__chip">
              <span>📡 {opt?.label ?? ch}</span>
              <button
                type="button"
                aria-label={`移除来源筛选 ${ch}`}
                onClick={() => toggleChannel(ch)}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>

      {/* 右侧操作区：当有任意激活筛选条件时展示命中数、「存为视图」与「重置」 */}
      {hasAdhoc && (
        <div className="tick-fbar__right">
          <span className="tick-fbar__hit-count">命中 {String(matchedCount)}</span>
          <button
            type="button"
            className="tick-fbar__save-btn"
            onClick={onOpenSaveView}
          >
            💾 存为视图
          </button>
          <button
            type="button"
            className="tick-fbar__reset-btn"
            onClick={onReset}
          >
            重置
          </button>
        </div>
      )}
    </div>
  );
}

//==========================================================
// 内置「存为视图 / 编辑动态视图」模态窗（零原生弹窗）
//==========================================================

/** 动态筛选视图新建/编辑模态窗入参。 */
export interface TickViewModalProps {
  /** 模式：新建或编辑已有自定义视图。 */
  mode: 'create' | 'edit';
  /** 编辑模式下的原视图对象。 */
  editingView?: api.TaskFilterViewDef;
  /** 新建模式下预填的组合筛选规则。 */
  initialRule: api.TaskFilterRule;
  /** 全部任务（用于实时预览匹配条数）。 */
  tasks: readonly api.ControlTask[];
  /** 全量可见分组清单。 */
  lists: readonly api.TaskListDef[];
  /** 全量可用标签及计数。 */
  tagEntries: ReadonlyArray<readonly [string, number]>;
  /** 今日日期 YYYY-MM-DD。 */
  todayStr: string;
  /** 关闭模态窗回调。 */
  onClose: () => void;
  /** 提交保存回调（成功返回 true 关闭弹窗）。 */
  onSubmit: (payload: {
    name: string;
    icon: string;
    color: string;
    rule: api.TaskFilterRule;
  }) => Promise<boolean>;
}

/** 自定义动态筛选视图新建/编辑弹窗组件。 */
export function TickViewModal(props: TickViewModalProps): react.JSX.Element {
  const {
    mode,
    editingView,
    initialRule,
    tasks,
    lists,
    tagEntries,
    todayStr,
    onClose,
    onSubmit,
  } = props;

  const [name, setName] = react.useState(() => editingView?.name ?? '');
  const [icon, setIcon] = react.useState(() => editingView?.icon ?? '🔖');
  const [color, setColor] = react.useState(() => editingView?.color ?? '#4c7ef3');
  const [draftRule, setDraftRule] = react.useState<api.TaskFilterRule>(() => {
    if (editingView !== undefined) return { ...editingView.rule };

    return { ...initialRule };
  });
  const [customTagInput, setCustomTagInput] = react.useState('');
  const [saving, setSaving] = react.useState(false);

  const previewCount = react.useMemo(() => {
    return tasks.filter((item) => filterEngine.matchesTaskFilterRule(item, draftRule, todayStr))
      .length;
  }, [tasks, draftRule, todayStr]);

  const summaryParts = react.useMemo(() => {
    return filterEngine.describeFilterRule(draftRule);
  }, [draftRule]);

  const allListNames = react.useMemo(() => {
    const names = ['收集箱'];
    for (const item of lists) {
      if (!names.includes(item.name)) {
        names.push(item.name);
      }
    }
    return names;
  }, [lists]);

  const allSelectableTags = react.useMemo(() => {
    const set = new Set<string>(tagEntries.map(([tag]) => tag));
    for (const tag of draftRule.tags ?? []) {
      set.add(tag);
    }
    return [...set];
  }, [tagEntries, draftRule.tags]);

  /** 手动追加一个新标签进视图规则。 */
  const handleAddCustomTag = (): void => {
    const cleaned = customTagInput.trim().replace(/^#/u, '');
    if (cleaned === '') return;

    const cur = draftRule.tags ?? [];
    if (!cur.includes(cleaned)) {
      setDraftRule({ ...draftRule, tags: [...cur, cleaned] });
    }
    setCustomTagInput('');
  };

  /** 提交新建或更新动态筛选视图。 */
  const handleFormSubmit = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    const cleanedName = name.trim();
    if (cleanedName === '' || saving) return;

    setSaving(true);
    try {
      const ok = await onSubmit({
        name: cleanedName,
        icon,
        color,
        rule: draftRule,
      });
      if (ok) {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  let modalTitle = '存为动态筛选视图';
  if (mode === 'edit') {
    modalTitle = '编辑动态筛选视图';
  }
  let submitText = '保存并钉入左侧栏';
  if (mode === 'edit') {
    submitText = '保存修改';
  }
  if (saving) {
    submitText = '保存中…';
  }
  const activeTagMode: api.TaskTagMode = draftRule.tagMode ?? 'and';

  return (
    <div
      className="tick-search-layer"
      role="dialog"
      aria-modal="true"
      aria-label={modalTitle}
    >
      <div className="tick-search-mask" aria-hidden="true" onClick={onClose} />
      <form className="tick-view-modal" onSubmit={(e) => void handleFormSubmit(e)}>
        <header className="tick-view-modal__head">
          <h3>{modalTitle}</h3>
          <button
            type="button"
            className="tick-icon-btn"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="tick-view-modal__body">
          {/* 名称、图标与强调色 */}
          <div className="tick-view-modal__field">
            <label className="tick-view-modal__label" htmlFor="tick-view-name-input">
              视图名称
            </label>
            <input
              id="tick-view-name-input"
              type="text"
              className="tick-view-modal__input"
              value={name}
              placeholder="例如：P0 待拍板急件、AOBB 联调、飞书客户跟进…"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="tick-view-modal__appearance">
            <div className="tick-emoji-strip">
              {filterEngine.VIEW_ICON_CHOICES.map((ch) => (
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
            <div className="tick-view-modal__colors">
              {filterEngine.VIEW_COLOR_CHOICES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className="tick-color-dot"
                  data-active={color === hex}
                  style={{ backgroundColor: hex }}
                  aria-label={`颜色 ${hex}`}
                  onClick={() => setColor(hex)}
                />
              ))}
            </div>
          </div>

          {/* 标签多选 + AND/OR */}
          <div className="tick-view-modal__field">
            <div className="tick-view-modal__row-between">
              <span className="tick-view-modal__label">标签条件</span>
              <div className="tick-fbar__mode-switch">
                <button
                  type="button"
                  data-active={activeTagMode === 'and'}
                  onClick={() => setDraftRule({ ...draftRule, tagMode: 'and' })}
                >
                  且 AND
                </button>
                <button
                  type="button"
                  data-active={activeTagMode === 'or'}
                  onClick={() => setDraftRule({ ...draftRule, tagMode: 'or' })}
                >
                  或 OR
                </button>
              </div>
            </div>
            <div className="tick-view-modal__pills">
              {allSelectableTags.map((tag) => {
                const active = (draftRule.tags ?? []).includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className="tick-modal-pill"
                    data-active={active}
                    onClick={() => {
                      setDraftRule({
                        ...draftRule,
                        tags: toggleItemInArray(draftRule.tags, tag),
                      });
                    }}
                  >
                    #{tag}
                  </button>
                );
              })}
              <div className="tick-view-modal__tag-inline">
                <input
                  type="text"
                  value={customTagInput}
                  placeholder="+ 输入标签"
                  onChange={(e) => setCustomTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddCustomTag();
                    }
                  }}
                />
              </div>
            </div>
          </div>

          {/* 状态与优先级 */}
          <div className="tick-view-modal__field">
            <span className="tick-view-modal__label">状态</span>
            <div className="tick-view-modal__pills">
              {filterEngine.FILTER_STATUS_OPTIONS.map((opt) => {
                const active = (draftRule.statuses ?? []).includes(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className="tick-modal-pill"
                    data-active={active}
                    onClick={() => {
                      setDraftRule({
                        ...draftRule,
                        statuses: toggleItemInArray(draftRule.statuses, opt.key),
                      });
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="tick-view-modal__field">
            <span className="tick-view-modal__label">优先级与日期</span>
            <div className="tick-view-modal__pills">
              {filterEngine.FILTER_PRIORITY_OPTIONS.map((pr) => {
                const active = (draftRule.priorities ?? []).includes(pr);
                return (
                  <button
                    key={pr}
                    type="button"
                    className="tick-modal-pill"
                    data-active={active}
                    onClick={() => {
                      setDraftRule({
                        ...draftRule,
                        priorities: toggleItemInArray(draftRule.priorities, pr),
                      });
                    }}
                  >
                    {pr}
                  </button>
                );
              })}
              {filterEngine.FILTER_DUE_OPTIONS.map((opt) => {
                const active = draftRule.dueScope === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className="tick-modal-pill"
                    data-active={active}
                    onClick={() => {
                      let nextDue: api.TaskDueScope | undefined = opt.key;
                      if (active) {
                        nextDue = undefined;
                      }
                      setDraftRule({ ...draftRule, dueScope: nextDue });
                    }}
                  >
                    📅 {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 来源渠道与分组 */}
          <div className="tick-view-modal__field">
            <span className="tick-view-modal__label">来源渠道与所属分组</span>
            <div className="tick-view-modal__pills">
              {filterEngine.FILTER_CHANNEL_OPTIONS.map((opt) => {
                const active = (draftRule.sourceChannels ?? []).includes(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className="tick-modal-pill"
                    data-active={active}
                    onClick={() => {
                      setDraftRule({
                        ...draftRule,
                        sourceChannels: toggleItemInArray(draftRule.sourceChannels, opt.key),
                      });
                    }}
                  >
                    📡 {opt.label}
                  </button>
                );
              })}
              {allListNames.map((listName) => {
                const active = (draftRule.lists ?? []).includes(listName);
                return (
                  <button
                    key={listName}
                    type="button"
                    className="tick-modal-pill"
                    data-active={active}
                    onClick={() => {
                      setDraftRule({
                        ...draftRule,
                        lists: toggleItemInArray(draftRule.lists, listName),
                      });
                    }}
                  >
                    📁 {listName}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 实时规则摘要与命中预览 */}
          <div className="tick-view-modal__preview">
            <span className="tick-view-modal__preview-count">
              实时匹配 <strong>{String(previewCount)}</strong> 个节点
            </span>
            <span className="tick-view-modal__preview-desc">
              {summaryParts.length === 0 && '未限定额外条件（匹配全部活跃节点）'}
              {summaryParts.length > 0 && summaryParts.join(' · ')}
            </span>
          </div>
        </div>

        <footer className="tick-view-modal__foot">
          <button type="button" className="tick-mini-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="tick-primary-btn"
            disabled={saving || name.trim() === ''}
          >
            {submitText}
          </button>
        </footer>
      </form>
    </div>
  );
}
