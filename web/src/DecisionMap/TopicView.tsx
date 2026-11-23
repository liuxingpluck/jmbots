/** 子主题专题目录视图（PC 三栏 + 手机竖屏沉浸式卡片与「全部待拍板」速决流）。 */
import * as react from 'react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as markdown from '../Chat/Markdown.tsx';
import * as composer from './Composer.tsx';
import * as drafts from './Drafts.ts';
import * as drawer from './Drawer.tsx';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 手机端顶栏点击「待拍板 N」胶囊时进入的全项目待拍板汇总伪专题键。 */
export const ALL_PENDING_TOPIC = '__ALL_PENDING__';

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
  existingById?: ReadonlyMap<string, types.DecisionNode>,
): string {
  if (nodeId === undefined || nodeId === '' || nodeId === rootId) return rootId;

  const byId = existingById ?? new Map(nodes.map((entry) => [entry.id, entry]));
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
export interface TopicSummaryItem {
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

/**
 * 提取项目总览及全部顶层子主题摘要（有待拍板的子主题自动排在最前，方便手机一眼先定要紧事）。
 * @param nodes 当前项目的全部节点。
 * @returns 专题摘要数组（首项为项目总览，其余为排序后的顶层子主题）。
 */
export function getTopicSummaryItems(nodes: types.DecisionNode[]): TopicSummaryItem[] {
  const root = nodes.find((entry) => entry.parent === null);
  if (root === undefined) return [];

  const childrenMap = buildChildrenMap(nodes);
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

  const branches: TopicSummaryItem[] = [];
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
    branches.push({
      node: child,
      isOverview: false,
      pendingCount,
      doneCount,
      taskCount: Math.max(0, sub.length - 1),
      state,
    });
  }

  //M 有待拍板的专题优先置顶，相同待拍板数保持原登记顺序。
  branches.sort((left, right) => {
    const leftHas = left.pendingCount > 0;
    const rightHas = right.pendingCount > 0;
    if (leftHas && !rightHas) return -1;
    if (!leftHas && rightHas) return 1;
    if (leftHas && rightHas) return right.pendingCount - left.pendingCount;

    return 0;
  });

  return [overview, ...branches];
}

/** 计算首次默认选中的专题编号：手机首屏进 2 列专题方块总览，桌面优先进有待拍板的第一个子主题。 */
export function resolveActiveTopicId(
  topicItems: TopicSummaryItem[],
  topicId?: string,
  preferOverview = false,
): string {
  if (topicId === ALL_PENDING_TOPIC) return ALL_PENDING_TOPIC;

  const hasExplicit = topicItems.some((item) => item.node.id === topicId);
  if (hasExplicit && topicId !== undefined) return topicId;
  if (preferOverview) return topicItems[0]?.node.id ?? '';

  const topTopics = topicItems.filter((item) => !item.isOverview);
  const firstPending = topTopics.find((item) => item.pendingCount > 0);
  if (firstPending !== undefined) return firstPending.node.id;
  if (topTopics[0] !== undefined) return topTopics[0].node.id;

  return topicItems[0]?.node.id ?? '';
}

/** 专题视图的输入参数。 */
export interface TopicViewProps {
  /** 当前项目内的全部节点。 */
  nodes: types.DecisionNode[];
  /** 是否处于手机竖屏模式（< 800px）。 */
  isMobile?: boolean;
  /** 当前选中的专题编号（顶层子主题、项目根，或 ALL_PENDING_TOPIC）。 */
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
  isMobile = false,
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
  const [stateFilter, setStateFilter] = react.useState<'all' | FourStateKey>('all');
  const [expandedTaskId, setExpandedTaskId] = react.useState<string | undefined>(undefined);

  const root = nodes.find((entry) => entry.parent === null);
  const childrenMap = react.useMemo(() => buildChildrenMap(nodes), [nodes]);
  const topicItems = react.useMemo(() => getTopicSummaryItems(nodes), [nodes]);
  const byId = react.useMemo(() => new Map(nodes.map((entry) => [entry.id, entry])), [nodes]);

  if (root === undefined || topicItems.length === 0) {
    return <div className="decision-empty">{t('还没有AI工作台节点')}</div>;
  }

  const topTopics = topicItems.filter((item) => !item.isOverview);
  const resolvedId = resolveActiveTopicId(topicItems, topicId, isMobile);
  const isAllPendingMode = resolvedId === ALL_PENDING_TOPIC;
  const activeSummary = topicItems.find((item) => item.node.id === resolvedId) ?? topicItems[0]!;
  const activeTopic = activeSummary.node;
  const isOverview = !isAllPendingMode && activeSummary.isOverview && topTopics.length > 0;

  let subtreeRows = collectSubtree(activeTopic, childrenMap);
  if (isOverview || isAllPendingMode) {
    subtreeRows = collectSubtree(root, childrenMap);
  }
  const scopeNodes = subtreeRows.map((row) => row.node);
  const scopeById = new Map(scopeNodes.map((entry) => [entry.id, entry]));

  const pendingNodes = scopeNodes.filter((entry) => entry.kind === 'pending' && entry.status === 'open');
  const totalProjectPending = topicItems[0]?.pendingCount ?? 0;

  let taskRows = subtreeRows.filter((row) => row.depth > 0);
  if (!isOverview && !isAllPendingMode && taskRows.length === 0) {
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

  let defaultDockNode = activeTopic;
  if (isAllPendingMode) {
    defaultDockNode = root;
  }
  let targetNode = defaultDockNode;
  if (selectedNodeId !== undefined) {
    const picked = scopeById.get(selectedNodeId);
    if (picked !== undefined) {
      targetNode = picked;
    }
  }

  /** 切换专题并重置筛选。 */
  const chooseTopic = (id: string): void => {
    onSelectTopic(id);
    onSelectNode(undefined);
    setStateFilter('all');
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

  /** 点“追问/发话”锁定输入框上下文，手机端同时展开底部输入面板并聚焦。 */
  const focusComposerOn = (id: string): void => {
    onSelectNode(id);
    composer.requestOpenComposer();
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

  /** 渲染单张高呼吸感待拍板卡片（大触控圆角按钮 + 推荐微光高亮）。 */
  const renderPendingCard = (item: types.DecisionNode, showTopicEyebrow: boolean) => {
    const isTargeted = targetNode.id === item.id;
    const belongId = findTopicIdForNode(nodes, root.id, item.id, byId);
    const belongNode = byId.get(belongId);
    return (
      <div
        key={item.id}
        className="decision-topic-pending-card"
        data-node-id={item.id}
        data-targeted={isTargeted}
      >
        {showTopicEyebrow && belongNode !== undefined && belongNode.id !== root.id && (
          <button
            type="button"
            className="decision-pending-eyebrow"
            onClick={() => chooseTopic(belongNode.id)}
          >
            {belongNode.title} ›
          </button>
        )}
        <div className="decision-topic-pending-card__head">
          <strong className="decision-topic-pending-card__title">{item.title}</strong>
          <button
            type="button"
            className="decision-ghost-chip"
            onClick={() => focusComposerOn(item.id)}
          >
            💬 {t('追问')}
          </button>
        </div>
        {item.summary !== '' && (
          <p className="decision-topic-pending-card__summary">{item.summary}</p>
        )}
        {item.body !== undefined && item.body !== '' && (
          <div className="decision-drawer__body decision-topic-pending-card__body">
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
                data-recommended={option.recommended === true}
                disabled={busy}
                onClick={() => handlePickOption(item, option.id)}
              >
                <span className="decision-option__title">
                  <span>{option.text}</span>
                  {option.recommended === true && (
                    <span className="decision-option__recommended">{t('推荐')}</span>
                  )}
                </span>
                {option.cost !== undefined && option.cost !== '' && (
                  <span className="decision-option__cost">{option.cost}</span>
                )}
                {thisSaving && <span className="decision-option__cost">{t('正在保存…')}</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="decision-topic-shell">
      {/* PC 左栏：全部待拍板速决入口 + 顶层子主题目录树（手机端统一收进顶栏 ☰ 抽屉）。 */}
      <nav className="decision-topic-sidebar" aria-label={t('专题目录')}>
        <div className="decision-topic-sidebar__head">
          <span>{t('专题目录')}</span>
          <span className="decision-topic-sidebar__count">{String(topTopics.length)}</span>
        </div>
        <div className="decision-topic-sidebar__list">
          {totalProjectPending > 0 && (
            <button
              type="button"
              className="decision-topic-nav-btn decision-topic-nav-btn--all-pending"
              aria-pressed={isAllPendingMode}
              onClick={() => chooseTopic(ALL_PENDING_TOPIC)}
            >
              <span className="decision-topic-nav-btn__row">
                <span className="decision-topic-nav-btn__dot" data-state="pending" />
                <span className="decision-topic-nav-btn__title">{t('全部待拍板')}</span>
              </span>
              <span className="decision-topic-badge decision-topic-badge--pending">
                {String(totalProjectPending)}
              </span>
            </button>
          )}
          {topicItems.map((item) => {
            const active = !isAllPendingMode && item.node.id === activeTopic.id;
            let titleText = item.node.title;
            if (item.isOverview && topTopics.length > 0) {
              titleText = t('项目总览');
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
                      {String(item.pendingCount)}
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

      {/* 中间沉浸阅读区 */}
      <div className="decision-topic-main">
        <div className="decision-topic-scroll">
          {/* 模式 A：只看全部待拍板卡片流 */}
          {isAllPendingMode && (
            <section className="decision-topic-pinned-stream" aria-label={t('全部待拍板')}>
              {isMobile && topTopics.length > 0 && (
                <button
                  type="button"
                  className="decision-m-back-tiles"
                  data-back-tiles
                  onClick={() => chooseTopic(root.id)}
                >
                  ‹ {t('返回全部专题方块')}（{String(topTopics.length)}）
                </button>
              )}
              <div className="decision-stream-intro">
                <h2>{t('全部待拍板')}（{String(pendingNodes.length)}）</h2>
                <p>{t('单手点选即可拍板；想补充要求可点卡片右上「追问」，写完再点选项会一并发给哈基米。')}</p>
              </div>
              {actionError !== undefined && actionError !== '' && (
                <p className="decision-error" role="alert">{actionError}</p>
              )}
              {pendingNodes.length === 0 && (
                <div className="decision-topic-card">
                  <p className="decision-view__empty">{t('太棒了，当前所有事项都已拍板！')}</p>
                </div>
              )}
              {pendingNodes.length > 0 && (
                <div className="decision-topic-pinned__list">
                  {pendingNodes.map((item) => renderPendingCard(item, true))}
                </div>
              )}
            </section>
          )}

          {/* 模式 B1：手机竖屏 2 列专题方块网格一屏总览 */}
          {!isAllPendingMode && isMobile && isOverview && (
            <section className="decision-m-grid-view" aria-label={t('专题方块总览')}>
              <div className="decision-m-grid-banner">
                <span className="decision-m-grid-stat">
                  {t('共')} {String(topTopics.length)} {t('个专题')} · {t('总进度')}{' '}
                  {String(activeSummary.doneCount)}/{String(activeSummary.taskCount)}
                </span>
                {totalProjectPending > 0 && (
                  <button
                    type="button"
                    className="decision-m-grid-pending-btn"
                    onClick={() => chooseTopic(ALL_PENDING_TOPIC)}
                  >
                    ★ {String(totalProjectPending)} {t('件待拍板')} ›
                  </button>
                )}
              </div>
              <div className="decision-m-tile-grid">
                {topTopics.map((item) => {
                  let progressPct = 0;
                  if (item.taskCount > 0) {
                    progressPct = Math.round((item.doneCount / item.taskCount) * 100);
                  }
                  return (
                    <button
                      key={item.node.id}
                      type="button"
                      className="decision-m-tile"
                      data-state={item.state.key}
                      data-topic-tile={item.node.id}
                      onClick={() => chooseTopic(item.node.id)}
                    >
                      <span className="decision-m-tile__head">
                        <span className="decision-m-tile__state">
                          <i className="decision-m-tile__dot" data-state={item.state.key} />
                          {item.state.label}
                        </span>
                        {item.pendingCount > 0 && (
                          <span className="decision-m-tile__pending">
                            {String(item.pendingCount)} {t('待拍板')}
                          </span>
                        )}
                      </span>
                      <strong className="decision-m-tile__title">{item.node.title}</strong>
                      <span className="decision-m-tile__foot">
                        <span className="decision-m-tile__bar">
                          <i data-state={item.state.key} style={{ width: `${String(progressPct)}%` }} />
                        </span>
                        <span className="decision-m-tile__count">
                          {String(item.doneCount)}/{String(item.taskCount)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 模式 B2：具体专题页（或 PC 项目总览） */}
          {!isAllPendingMode && !(isMobile && isOverview) && (
            <>
              {isMobile && topTopics.length > 0 && (
                <button
                  type="button"
                  className="decision-m-back-tiles"
                  data-back-tiles
                  onClick={() => chooseTopic(root.id)}
                >
                  ‹ {t('返回全部专题方块')}（{String(topTopics.length)}）
                </button>
              )}
              <article className="decision-topic-card decision-topic-hero" data-node-id={activeTopic.id}>
                <div className="decision-topic-hero__head">
                  <div className="decision-topic-hero__badges">
                    <span className="decision-state-pill" data-state={activeSummary.state.key}>
                      {activeSummary.state.label}
                    </span>
                    {activeSummary.taskCount > 0 && (
                      <span className="decision-hero-progress">
                        {t('进度')} {String(activeSummary.doneCount)}/{String(activeSummary.taskCount)}
                      </span>
                    )}
                  </div>
                  <div className="decision-topic-hero__actions">
                    <button
                      type="button"
                      className="decision-ghost-chip"
                      onClick={() => focusComposerOn(activeTopic.id)}
                    >
                      💬 {t('发话')}
                    </button>
                    <button
                      type="button"
                      className="decision-ghost-chip"
                      onClick={() => onOpenInMind(activeTopic.id)}
                    >
                      {t('导图')} ›
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
                              {t('待拍板')} {String(item.pendingCount)}
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

              {pendingNodes.length > 0 && (
                <section className="decision-topic-pinned-group" aria-label={t('待拍板置顶区')}>
                  <div className="decision-section-heading">
                    <span className="decision-section-heading__dot" />
                    <h3>{t('待你拍板')}（{String(pendingNodes.length)}）</h3>
                  </div>
                  {actionError !== undefined && actionError !== '' && (
                    <p className="decision-error" role="alert">{actionError}</p>
                  )}
                  <div className="decision-topic-pinned__list">
                    {pendingNodes.map((item) => renderPendingCard(item, isOverview))}
                  </div>
                </section>
              )}

              <section className="decision-topic-section decision-topic-checklist" aria-label={t('子任务清单')}>
                <div className="decision-topic-tasks__head">
                  <h3 className="decision-topic-section__title">{t('子任务')}（{String(taskRows.length)}）</h3>
                  <div className="decision-topic-filters" role="group" aria-label={t('按四态筛选')}>
                    <button
                      type="button"
                      aria-pressed={stateFilter === 'all'}
                      onClick={() => setStateFilter('all')}
                    >
                      {t('全部')} {String(taskRows.length)}
                    </button>
                    {counts.pending > 0 && (
                      <button
                        type="button"
                        data-state-filter="pending"
                        aria-pressed={stateFilter === 'pending'}
                        onClick={() => setStateFilter('pending')}
                      >
                        {t('待拍板')} {String(counts.pending)}
                      </button>
                    )}
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
                      let padLeft = Math.min(Math.max(0, depth - 1) * 14, 42);
                      if (isMobile) {
                        padLeft = 0;
                      }
                      let parentHint = '';
                      if (isMobile && depth > 1 && item.parent !== null && item.parent !== activeTopic.id) {
                        parentHint = byId.get(item.parent)?.title ?? '';
                      }
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
                          style={{ paddingLeft: `${String(padLeft)}px` }}
                        >
                          <button
                            type="button"
                            className="decision-topic-task__row"
                            aria-expanded={isExpanded}
                            onClick={toggleRow}
                          >
                            <span className="decision-state-pill" data-state={st.key}>{st.label}</span>
                            <span className="decision-topic-task__main">
                              <span className="decision-topic-task__title">{item.title}</span>
                              {parentHint !== '' && (
                                <span className="decision-topic-task__parent">↳ {parentHint}</span>
                              )}
                            </span>
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
                                byId={byId}
                                focus={() => onOpenInMind(item.id)}
                                refresh={onRefresh}
                                expand={onExpand}
                              />
                              <div className="decision-topic-task__quick">
                                <button
                                  type="button"
                                  className="decision-ghost-chip"
                                  onClick={() => focusComposerOn(item.id)}
                                >
                                  💬 {t('针对此项给哈基米发话')}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {expandedTaskId === undefined && (
                  <div className="decision-topic-add-wrap">
                    <drawer.TaskActions
                      node={activeTopic}
                      byId={byId}
                      focus={() => onOpenInMind(activeTopic.id)}
                      refresh={onRefresh}
                      expand={onExpand}
                    />
                  </div>
                )}
              </section>
            </>
          )}

          {/* 手机单栏内嵌往来留言与中控回复（总览方块网格首屏保持清爽不堆在底下） */}
          {!(isMobile && isOverview) && (
            <div className="decision-topic-mobile-notes">
              <composer.ScopeNoteFeed
                nodes={scopeNodes}
                scopeRootId={defaultDockNode.id}
                targetNodeId={targetNode.id}
                onSelectNode={(id) => focusComposerOn(id)}
              />
            </div>
          )}
        </div>
      </div>

      {/* PC 右侧常驻栏 / 手机底部 48px 极简胶囊输入条 */}
      <composer.CentralDock
        targetNode={targetNode}
        defaultNode={defaultDockNode}
        scopeNodes={scopeNodes}
        onResetTarget={() => onSelectNode(undefined)}
        onSelectNode={onSelectNode}
        onSendNote={(id, text) => onSendNote(id, text)}
        sending={sending}
        noteError={noteError}
        inlineMobileNotes={!(isMobile && isOverview)}
      />
    </div>
  );
}
