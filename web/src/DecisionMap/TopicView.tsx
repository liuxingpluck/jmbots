/** 子主题专题目录视图（仿 /tutorial/ 阅读结构：左栏子主题树 + 中栏背景/待拍板置顶/4态子任务 + 常驻直达中控）。 */
import * as react from 'react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as markdown from '../Chat/Markdown.tsx';
import * as composer from './Composer.tsx';
import * as drafts from './Drafts.ts';
import * as drawer from './Drawer.tsx';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 子任务统一展示的四态键值。 */
export type FourStateKey = 'pending' | 'working' | 'decided' | 'done';

/** 节点的四态标识与中文短标签。 */
export interface FourStateInfo {
  /** 状态键值，供样式和筛选器匹配。 */
  key: FourStateKey;
  /** 界面显示的四态名称。 */
  label: string;
}

/**
 * 将工作决策节点映射为清晰的四态：待拍板 / 进行中 / 已定 / 已完成。
 * @param node 决策或任务节点。
 * @returns 四态键值与文案。
 */
export function getFourState(node: types.DecisionNode): FourStateInfo {
  if (node.status === 'done' || node.status === 'dropped') {
    return { key: 'done', label: t('已完成') };
  }
  if (node.kind === 'pending' && node.status === 'open') {
    return { key: 'pending', label: t('待拍板') };
  }
  if (node.kind === 'decided' || node.status === 'decided') {
    return { key: 'decided', label: t('已定') };
  }
  return { key: 'working', label: t('进行中') };
}

/**
 * 构建父节点到直接子节点的邻接表。
 * @param nodes 当前项目的全部节点。
 * @returns 父节点号到子节点数组的映射。
 */
function buildChildrenMap(nodes: types.DecisionNode[]): Map<string, types.DecisionNode[]> {
  const map = new Map<string, types.DecisionNode[]>();
  for (const entry of nodes) {
    if (entry.parent === null) continue;

    const list = map.get(entry.parent) ?? [];
    list.push(entry);
    map.set(entry.parent, list);
  }
  return map;
}

/**
 * 按深度优先收集某节点及其全部后代（含自身在首项）。
 * @param rootNode 子树根节点。
 * @param childrenMap 父子邻接表。
 * @returns 带相对深度的节点条目数组。
 */
function collectSubtree(
  rootNode: types.DecisionNode,
  childrenMap: Map<string, types.DecisionNode[]>,
): { node: types.DecisionNode; depth: number }[] {
  const out: { node: types.DecisionNode; depth: number }[] = [];
  const stack: { node: types.DecisionNode; depth: number }[] = [{ node: rootNode, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    out.push(current);
    const kids = childrenMap.get(current.node.id) ?? [];
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      stack.push({ node: kids[index]!, depth: current.depth + 1 });
    }
  }
  return out;
}

/**
 * 查找任意节点所属的顶层子主题编号（根节点的直接子项；若就是根或无父链则回根编号）。
 * @param nodes 当前项目节点列表。
 * @param rootId 项目根节点号。
 * @param nodeId 待定位的节点号。
 * @returns 所属顶层子主题或根节点的编号。
 */
export function findTopicIdForNode(
  nodes: types.DecisionNode[],
  rootId: string,
  nodeId?: string,
): string {
  if (nodeId === undefined || nodeId === '' || nodeId === rootId) return rootId;

  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  let current = byId.get(nodeId);
  const visited = new Set<string>();
  while (current !== undefined && current.parent !== null) {
    if (visited.has(current.id)) break;

    visited.add(current.id);
    if (current.parent === rootId) return current.id;

    current = byId.get(current.parent);
  }
  return rootId;
}

/** 提取只允许 HTTP/HTTPS 的安全外链。 */
function getSafeLinks(values: string[]): string[] {
  return values.filter((value) => /^https?:\/\//iu.test(value));
}

/** 目录树里单个顶层子主题的统计摘要。 */
interface TopicSummaryItem {
  /** 子主题根节点。 */
  node: types.DecisionNode;
  /** 是否为项目总览根项。 */
  isOverview: boolean;
  /** 该专题内未决的待拍板数量。 */
  pendingCount: number;
  /** 已完成项数量。 */
  doneCount: number;
  /** 子任务总数量（不含专题根自身）。 */
  taskCount: number;
  /** 专题整体四态。 */
  state: FourStateInfo;
}

/** 专题视图的输入参数。 */
export interface TopicViewProps {
  /** 当前项目内的全部节点。 */
  nodes: types.DecisionNode[];
  /** 当前选中的专题编号（顶层子主题或项目根）。 */
  topicId?: string;
  /** 切换专题回调。 */
  onSelectTopic: (id: string) => void;
  /** 当前显式选中的子节点编号。 */
  selectedNodeId?: string;
  /** 选中或切换发话目标节点。 */
  onSelectNode: (id?: string) => void;
  /** 点选某个待拍板项的选项。 */
  onChooseOption: (nodeId: string, optionId: string) => Promise<void>;
  /** 发送留言（可附带选项）。 */
  onSendNote: (nodeId: string, text: string, optionId?: string) => Promise<boolean>;
  /** 正在保存选项的节点与选项键。 */
  savingKey?: string;
  /** 点选报错信息。 */
  actionError?: string;
  /** 是否正在发送留言。 */
  sending: boolean;
  /** 发送留言报错信息。 */
  noteError?: string;
  /** 任务新增或改状态后刷新快照。 */
  onRefresh: () => Promise<void>;
  /** 展开新子项父节点。 */
  onExpand: (id: string) => void;
  /** 切到思维导图并聚焦指定专题子树。 */
  onOpenInMind: (id: string) => void;
}

/** 子主题专题目录视图主体。 */
export function TopicView({
  nodes,
  topicId,
  onSelectTopic,
  selectedNodeId,
  onSelectNode,
  onChooseOption,
  onSendNote,
  savingKey,
  actionError,
  sending,
  noteError,
  onRefresh,
  onExpand,
  onOpenInMind,
}: TopicViewProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = react.useState(false);
  const [stateFilter, setStateFilter] = react.useState<'all' | FourStateKey>('all');
  const [expandedTaskId, setExpandedTaskId] = react.useState<string | undefined>(undefined);

  const root = nodes.find((entry) => entry.parent === null);
  const childrenMap = react.useMemo(() => buildChildrenMap(nodes), [nodes]);

  const topicItems = react.useMemo<TopicSummaryItem[]>(() => {
    if (root === undefined) return [];

    const topChildren = childrenMap.get(root.id) ?? [];
    const allPending = nodes.filter((entry) => entry.kind === 'pending' && entry.status === 'open').length;
    const allTasks = Math.max(0, nodes.length - 1);
    const allDone = nodes.filter(
      (entry) => entry.id !== root.id && (entry.status === 'done' || entry.status === 'dropped'),
    ).length;
    const overview: TopicSummaryItem = {
      node: root,
      isOverview: true,
      pendingCount: allPending,
      doneCount: allDone,
      taskCount: allTasks,
      state: getFourState(root),
    };
    const items: TopicSummaryItem[] = [overview];
    for (const child of topChildren) {
      const sub = collectSubtree(child, childrenMap);
      let pendingCount = 0;
      let doneCount = 0;
      for (const row of sub) {
        if (row.node.kind === 'pending' && row.node.status === 'open') {
          pendingCount += 1;
        }
        if (row.depth > 0 && (row.node.status === 'done' || row.node.status === 'dropped')) {
          doneCount += 1;
        }
      }
      let state = getFourState(child);
      if (pendingCount > 0) {
        state = { key: 'pending', label: t('待拍板') };
      }
      items.push({
        node: child,
        isOverview: false,
        pendingCount,
        doneCount,
        taskCount: Math.max(0, sub.length - 1),
        state,
      });
    }
    return items;
  }, [nodes, root, childrenMap]);

  if (root === undefined) {
    return <div className="decision-empty">{t('还没有工作决策节点')}</div>;
  }

  //M 解析当前激活的专题：优先用外部传入的合法 topicId，否则优先有待拍板的第一个子主题。
  const topTopics = topicItems.filter((item) => !item.isOverview);
  let resolvedTopicId = topicId;
  const hasExplicit = topicItems.some((item) => item.node.id === resolvedTopicId);
  if (!hasExplicit) {
    const firstPending = topTopics.find((item) => item.pendingCount > 0);
    resolvedTopicId = firstPending?.node.id ?? topTopics[0]?.node.id ?? root.id;
  }
  const activeSummary = topicItems.find((item) => item.node.id === resolvedTopicId) ?? topicItems[0]!;
  const activeTopic = activeSummary.node;
  const isOverview = activeSummary.isOverview && topTopics.length > 0;

  //M 当前专题覆盖的子树（项目总览含整棵树，具体子主题含该分支全部后代）。
  let subtreeRows = collectSubtree(activeTopic, childrenMap);
  if (isOverview) {
    subtreeRows = collectSubtree(root, childrenMap);
  }
  const scopeNodes = subtreeRows.map((row) => row.node);
  const scopeById = new Map(scopeNodes.map((entry) => [entry.id, entry]));

  //M 待拍板置顶区：收集本专题范围内所有尚未拍板的节点。
  const pendingNodes = scopeNodes.filter((entry) => entry.kind === 'pending' && entry.status === 'open');

  //M 子任务清单：具体专题下展示专题根之下的全部子项；若专题自身无子项则展示自身，不留空页。
  let taskRows = subtreeRows.filter((row) => row.depth > 0);
  if (!isOverview && taskRows.length === 0) {
    taskRows = subtreeRows;
  }

  const counts = { pending: 0, working: 0, decided: 0, done: 0 };
  for (const row of taskRows) {
    const st = getFourState(row.node);
    counts[st.key] += 1;
  }
  const filteredRows = taskRows.filter((row) => {
    if (stateFilter === 'all') return true;

    return getFourState(row.node).key === stateFilter;
  });

  //M 计算常驻输入框实际锁定的目标节点：已选且在本专题内则用它，否则默认挂本专题根节点。
  let targetNode = activeTopic;
  if (selectedNodeId !== undefined) {
    const picked = scopeById.get(selectedNodeId);
    if (picked !== undefined) {
      targetNode = picked;
    }
  }

  /** 切换专题并收起手机抽屉菜单。 */
  const chooseTopic = (id: string): void => {
    onSelectTopic(id);
    onSelectNode(undefined);
    setStateFilter('all');
    setMobileMenuOpen(false);
  };

  /** 点击待拍板卡片的选项：若该节点已有未发草稿则连话带选项一并发，否则直接提交选项。 */
  const handlePickOption = (item: types.DecisionNode, optionId: string): void => {
    const written = drafts.readDraft(item.id).trim();
    if (written === '') {
      void onChooseOption(item.id, optionId);
      return;
    }
    void onSendNote(item.id, written, optionId).then((ok) => {
      if (ok) drafts.writeDraft(item.id, '');
    });
  };

  /** 点“追问此项”锁定输入框上下文并聚焦到输入框。 */
  const focusComposerOn = (id: string): void => {
    onSelectNode(id);
    window.requestAnimationFrame(() => {
      document.getElementById('decision-write-text')?.focus();
    });
  };

  const sources = new Set(activeTopic.sources ?? []);
  if (activeTopic.detailPath !== undefined && activeTopic.detailPath !== '') {
    sources.add(activeTopic.detailPath);
  }
  const links = getSafeLinks(activeTopic.links ?? []);
  const busy = savingKey !== undefined || sending;

  let mobileDrawerLabel = `${t('切换专题')} (${String(topicItems.length)}) ▾`;
  if (mobileMenuOpen) {
    mobileDrawerLabel = `${t('收起目录')} ▴`;
  }

  return (
    <div className="decision-topic-shell">
      {/* PC 左栏：顶层子主题目录树；手机竖屏收起为顶部抽屉菜单。 */}
      <nav className="decision-topic-sidebar" aria-label={t('专题目录')}>
        <div className="decision-topic-sidebar__head">
          <span>{t('专题目录')}</span>
          <span className="decision-topic-sidebar__count">{String(topTopics.length)}</span>
        </div>
        <div className="decision-topic-sidebar__list">
          {topicItems.map((item) => {
            const active = item.node.id === activeTopic.id;
            let titleText = item.node.title;
            if (item.isOverview && topTopics.length > 0) {
              titleText = `${t('项目总览')} · ${item.node.title}`;
            }
            return (
              <button
                key={item.node.id}
                type="button"
                className="decision-topic-nav-btn"
                data-topic-id={item.node.id}
                data-state={item.state.key}
                aria-pressed={active}
                onClick={() => chooseTopic(item.node.id)}
              >
                <span className="decision-topic-nav-btn__row">
                  <span className="decision-topic-nav-btn__dot" data-state={item.state.key} />
                  <span className="decision-topic-nav-btn__title">{titleText}</span>
                </span>
                <span className="decision-topic-nav-btn__badges">
                  {item.pendingCount > 0 && (
                    <span className="decision-topic-badge decision-topic-badge--pending">
                      ★ {String(item.pendingCount)}
                    </span>
                  )}
                  {item.taskCount > 0 && (
                    <span className="decision-topic-badge">
                      {String(item.doneCount)}/{String(item.taskCount)}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* 中间专题阅读区：手机竖屏自带顶部专题切换条与单栏顺畅排版。 */}
      <div className="decision-topic-main">
        <div className="decision-topic-mobile-bar">
          <div className="decision-topic-mobile-bar__top">
            <div className="decision-topic-mobile-bar__current">
              <span className="decision-state-pill" data-state={activeSummary.state.key}>
                {activeSummary.state.label}
              </span>
              <strong>{activeTopic.title}</strong>
            </div>
            <button
              type="button"
              className="decision-task-button"
              data-topic-drawer-toggle
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileDrawerLabel}
            </button>
          </div>
          {topTopics.length > 0 && (
            <div className="decision-topic-mobile-chips" role="tablist" aria-label={t('快速切换子主题')}>
              {topicItems.map((item) => {
                const active = item.node.id === activeTopic.id;
                let chipTitle = item.node.title;
                if (item.isOverview) {
                  chipTitle = t('总览');
                }
                return (
                  <button
                    key={item.node.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="decision-topic-chip"
                    data-state={item.state.key}
                    onClick={() => chooseTopic(item.node.id)}
                  >
                    {item.pendingCount > 0 && <span className="decision-topic-chip__star">★{item.pendingCount} </span>}
                    {chipTitle}
                  </button>
                );
              })}
            </div>
          )}
          {mobileMenuOpen && (
            <div className="decision-topic-mobile-drawer" role="menu">
              {topicItems.map((item) => {
                const active = item.node.id === activeTopic.id;
                let titleText = item.node.title;
                if (item.isOverview && topTopics.length > 0) {
                  titleText = `${t('项目总览')} · ${item.node.title}`;
                }
                return (
                  <button
                    key={item.node.id}
                    type="button"
                    role="menuitem"
                    className="decision-topic-nav-btn"
                    aria-pressed={active}
                    onClick={() => chooseTopic(item.node.id)}
                  >
                    <span className="decision-topic-nav-btn__row">
                      <span className="decision-topic-nav-btn__dot" data-state={item.state.key} />
                      <span className="decision-topic-nav-btn__title">{titleText}</span>
                    </span>
                    <span className="decision-topic-nav-btn__badges">
                      {item.pendingCount > 0 && (
                        <span className="decision-topic-badge decision-topic-badge--pending">
                          ★ {String(item.pendingCount)}
                        </span>
                      )}
                      <span className="decision-topic-badge">{item.state.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="decision-topic-scroll">
          {/* 1. 专题背景说明卡片 */}
          <article className="decision-topic-card decision-topic-hero" data-node-id={activeTopic.id}>
            <div className="decision-topic-hero__head">
              <div className="decision-topic-hero__badges">
                <span className="decision-state-pill" data-state={activeSummary.state.key}>
                  {activeSummary.state.label}
                </span>
                {activeSummary.pendingCount > 0 && (
                  <span className="decision-state-pill" data-state="pending">
                    ★ {String(activeSummary.pendingCount)} {t('项待拍板')}
                  </span>
                )}
              </div>
              <div className="decision-topic-hero__actions">
                <button
                  type="button"
                  className="decision-task-button"
                  onClick={() => focusComposerOn(activeTopic.id)}
                >
                  {t('对本专题发话')}
                </button>
                <button
                  type="button"
                  className="decision-task-button"
                  onClick={() => onOpenInMind(activeTopic.id)}
                >
                  {t('在导图中看')}
                </button>
              </div>
            </div>
            <h2 className="decision-topic-hero__title">{activeTopic.title}</h2>
            {activeTopic.summary !== '' && (
              <p className="decision-topic-hero__summary">{activeTopic.summary}</p>
            )}
            {activeTopic.body !== undefined && activeTopic.body !== '' && (
              <div className="decision-drawer__body decision-topic-hero__body">
                <markdown.Markdown text={activeTopic.body} onOpen={() => undefined} />
              </div>
            )}
            {(sources.size > 0 || links.length > 0) && (
              <div className="decision-topic-hero__refs">
                {[...sources].map((src) => <span key={src} className="decision-ref-tag">{src}</span>)}
                {links.map((href) => (
                  <a key={href} href={href} target="_blank" rel="noreferrer" className="decision-ref-link">
                    {href}
                  </a>
                ))}
              </div>
            )}
          </article>

          {/* 项目总览模式下展示各顶层子主题进度卡片，点一下直达该子主题 */}
          {isOverview && topTopics.length > 0 && (
            <section className="decision-topic-section" aria-label={t('子主题总览')}>
              <h3 className="decision-topic-section__title">{t('分主题进度')}（{String(topTopics.length)}）</h3>
              <div className="decision-topic-overview-grid">
                {topTopics.map((item) => (
                  <button
                    key={item.node.id}
                    type="button"
                    className="decision-topic-overview-card"
                    data-state={item.state.key}
                    onClick={() => chooseTopic(item.node.id)}
                  >
                    <div className="decision-topic-overview-card__head">
                      <span className="decision-state-pill" data-state={item.state.key}>{item.state.label}</span>
                      {item.pendingCount > 0 && (
                        <span className="decision-topic-badge decision-topic-badge--pending">
                          ★ {String(item.pendingCount)} {t('待拍板')}
                        </span>
                      )}
                    </div>
                    <strong className="decision-topic-overview-card__title">{item.node.title}</strong>
                    {item.node.summary !== '' && (
                      <span className="decision-topic-overview-card__summary">{item.node.summary}</span>
                    )}
                    <span className="decision-topic-overview-card__meta">
                      {t('已完成')} {String(item.doneCount)} / {String(item.taskCount)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* 2. 待拍板置顶区 */}
          {pendingNodes.length > 0 && (
            <section className="decision-topic-section decision-topic-pinned" aria-label={t('待拍板置顶区')}>
              <h3 className="decision-topic-section__title decision-topic-section__title--pending">
                ★ {t('待拍板置顶区')}（{String(pendingNodes.length)}）
              </h3>
              {actionError !== undefined && actionError !== '' && (
                <p className="decision-error" role="alert">{actionError}</p>
              )}
              <div className="decision-topic-pinned__list">
                {pendingNodes.map((item) => {
                  const isTargeted = targetNode.id === item.id;
                  return (
                    <div
                      key={item.id}
                      className="decision-topic-pending-card"
                      data-node-id={item.id}
                      data-targeted={isTargeted}
                    >
                      <div className="decision-topic-pending-card__head">
                        <strong>{item.title}</strong>
                        <button
                          type="button"
                          className="decision-task-button"
                          onClick={() => focusComposerOn(item.id)}
                        >
                          {t('追问/备注')}
                        </button>
                      </div>
                      {item.summary !== '' && (
                        <p className="decision-topic-pending-card__summary">{item.summary}</p>
                      )}
                      {item.body !== undefined && item.body !== '' && (
                        <div className="decision-drawer__body">
                          <markdown.Markdown text={item.body} onOpen={() => undefined} />
                        </div>
                      )}
                      <div className="decision-options" aria-label={t('可选决定')}>
                        {item.options?.map((option) => {
                          const thisSaving = savingKey === `${item.id}:${option.id}`;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              className="decision-option"
                              data-option-id={option.id}
                              disabled={busy}
                              onClick={() => handlePickOption(item, option.id)}
                            >
                              <span className="decision-option__title">
                                {option.text}
                                {option.recommended === true && (
                                  <span className="decision-option__recommended">{t('推荐')}</span>
                                )}
                              </span>
                              {option.cost !== undefined && option.cost !== '' && (
                                <span className="decision-option__cost">{option.cost}</span>
                              )}
                              {thisSaving && <span className="decision-option__cost">{t('正在保存')}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 3. 子任务清单（4 态：待拍板 / 进行中 / 已定 / 已完成） */}
          <section className="decision-topic-section" aria-label={t('子任务清单')}>
            <div className="decision-topic-tasks__head">
              <h3 className="decision-topic-section__title">{t('子任务清单')}（{String(taskRows.length)}）</h3>
              <div className="decision-topic-filters" role="group" aria-label={t('按四态筛选')}>
                <button
                  type="button"
                  aria-pressed={stateFilter === 'all'}
                  onClick={() => setStateFilter('all')}
                >
                  {t('全部')} {String(taskRows.length)}
                </button>
                <button
                  type="button"
                  data-state-filter="pending"
                  aria-pressed={stateFilter === 'pending'}
                  onClick={() => setStateFilter('pending')}
                >
                  {t('待拍板')} {String(counts.pending)}
                </button>
                <button
                  type="button"
                  data-state-filter="working"
                  aria-pressed={stateFilter === 'working'}
                  onClick={() => setStateFilter('working')}
                >
                  {t('进行中')} {String(counts.working)}
                </button>
                <button
                  type="button"
                  data-state-filter="decided"
                  aria-pressed={stateFilter === 'decided'}
                  onClick={() => setStateFilter('decided')}
                >
                  {t('已定')} {String(counts.decided)}
                </button>
                <button
                  type="button"
                  data-state-filter="done"
                  aria-pressed={stateFilter === 'done'}
                  onClick={() => setStateFilter('done')}
                >
                  {t('已完成')} {String(counts.done)}
                </button>
              </div>
            </div>

            {filteredRows.length === 0 && (
              <p className="decision-view__empty">{t('当前筛选下没有子任务')}</p>
            )}
            {filteredRows.length > 0 && (
              <div role="list" className="decision-topic-task-list">
                {filteredRows.map(({ node: item, depth }) => {
                  const st = getFourState(item);
                  const isExpanded = expandedTaskId === item.id;
                  const isTargeted = targetNode.id === item.id;
                  const chosenOpt = item.options?.find((opt) => opt.id === item.chosen);
                  const noteLen = item.notes?.length ?? 0;
                  const padLeft = Math.min(Math.max(0, depth - 1) * 16, 48);
                  const toggleRow = (): void => {
                    onSelectNode(item.id);
                    if (isExpanded) {
                      setExpandedTaskId(undefined);
                      return;
                    }
                    setExpandedTaskId(item.id);
                  };
                  return (
                    <div
                      key={item.id}
                      role="listitem"
                      className="decision-topic-task"
                      data-node-id={item.id}
                      data-state={st.key}
                      data-targeted={isTargeted}
                      style={{ marginLeft: `${String(padLeft)}px` }}
                    >
                      <button
                        type="button"
                        className="decision-topic-task__row"
                        aria-expanded={isExpanded}
                        onClick={toggleRow}
                      >
                        <span className="decision-state-pill" data-state={st.key}>{st.label}</span>
                        <span className="decision-topic-task__title">{item.title}</span>
                        <span className="decision-topic-task__right">
                          {chosenOpt !== undefined && (
                            <span className="decision-topic-task__chosen">✓ {chosenOpt.text}</span>
                          )}
                          {noteLen > 0 && (
                            <span className="decision-topic-task__notes">💬 {String(noteLen)}</span>
                          )}
                        </span>
                      </button>
                      {isExpanded && (
                        <div className="decision-topic-task__detail">
                          {item.summary !== '' && (
                            <p className="decision-drawer__summary">{item.summary}</p>
                          )}
                          {item.body !== undefined && item.body !== '' && (
                            <div className="decision-drawer__body">
                              <markdown.Markdown text={item.body} onOpen={() => undefined} />
                            </div>
                          )}
                          {(item.kind === 'decided' || item.status === 'decided') && (
                            <drawer.DecisionHistory node={item} />
                          )}
                          <drawer.TaskActions
                            node={item}
                            focus={() => onOpenInMind(item.id)}
                            refresh={onRefresh}
                            expand={onExpand}
                          />
                          <div className="decision-topic-task__quick">
                            <button
                              type="button"
                              className="decision-task-button"
                              onClick={() => focusComposerOn(item.id)}
                            >
                              {t('针对此项给中控发话')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 未展开具体子项时，在当前专题根下展示状态与快捷加子项入口 */}
            {expandedTaskId === undefined && (
              <div className="decision-topic-add-wrap">
                <drawer.TaskActions
                  node={activeTopic}
                  focus={() => onOpenInMind(activeTopic.id)}
                  refresh={onRefresh}
                  expand={onExpand}
                />
              </div>
            )}
          </section>

          {/* 4. 手机单栏内嵌往来留言与中控回复（PC 端在右侧常驻栏展示） */}
          <div className="decision-topic-mobile-notes">
            <composer.ScopeNoteFeed
              nodes={scopeNodes}
              scopeRootId={activeTopic.id}
              targetNodeId={targetNode.id}
              onSelectNode={(id) => focusComposerOn(id)}
            />
          </div>
        </div>
      </div>

      {/* PC 右侧常驻栏 / 手机底部悬浮输入框 */}
      <composer.CentralDock
        targetNode={targetNode}
        defaultNode={activeTopic}
        scopeNodes={scopeNodes}
        onResetTarget={() => onSelectNode(undefined)}
        onSelectNode={onSelectNode}
        onSendNote={(id, text) => onSendNote(id, text)}
        sending={sending}
        noteError={noteError}
        inlineMobileNotes
      />
    </div>
  );
}
