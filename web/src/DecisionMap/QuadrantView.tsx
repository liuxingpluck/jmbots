/** 四象限（Eisenhower Matrix）视图：PC 2×2 全景独立滚屏 + 手机 2×2 四块一屏总览与单象限放大。 */
import * as react from 'react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as composer from './Composer.tsx';
import * as drawer from './Drawer.tsx';
import * as quadrants from './Quadrants.ts';
import * as topicView from './TopicView.tsx';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 四象限视图输入参数。 */
export interface QuadrantViewProps {
  /** 当前项目内的全部节点。 */
  nodes: types.DecisionNode[];
  /** 是否处于手机竖屏（< 800px）。 */
  isMobile: boolean;
  /** 当前选中的节点编号。 */
  selectedNodeId?: string;
  /** 选中或关闭详情节点。 */
  onSelectNode: (id?: string) => void;
  /** 提交待拍板选项。 */
  onChooseOption: (nodeId: string, optionId: string) => Promise<void>;
  /** 发送留言（可附带选项）。 */
  onSendNote: (nodeId: string, text: string, optionId?: string) => Promise<boolean>;
  /** 正在保存的选项键（nodeId:optionId）。 */
  savingKey?: string;
  /** 点选失败提示。 */
  actionError?: string;
  /** 留言发送中标记。 */
  sending: boolean;
  /** 留言失败提示。 */
  noteError?: string;
  /** 刷新整图快照。 */
  onRefresh: () => Promise<void>;
  /** 展开新子项父节点。 */
  onExpand: (id: string) => void;
  /** 在导图子树中聚焦当前节点。 */
  onFocusTree: (id: string) => void;
  /** 跳转到该节点所属专题目录。 */
  onOpenNodeTopic: (id: string) => void;
}

/** 提取节点摘要首行短句供手机放大卡片速览。 */
function getFirstSummaryLine(summary: string): string {
  const [line] = summary.split('\n');
  return (line ?? '').trim();
}

/** 读取地址栏可选的初始放大象限参数（默认 null 先展示 2×2 四块总览）。 */
function getInitialZoomedQuad(): types.DecisionQuadrant | null {
  const raw = new URLSearchParams(window.location.search).get('q');
  const found = quadrants.QUADRANT_SPECS.find((item) => item.key === raw);
  if (found !== undefined) return found.key;

  return null;
}

/** 四象限决策矩阵主体组件。 */
function QuadrantViewInner({
  nodes,
  isMobile,
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
  onFocusTree,
  onOpenNodeTopic,
}: QuadrantViewProps) {
  const [scopeFilter, setScopeFilter] = react.useState<quadrants.QuadrantScopeFilter>('active');
  const [zoomedQuad, setZoomedQuad] = react.useState<types.DecisionQuadrant | null>(getInitialZoomedQuad);

  const root = react.useMemo(() => nodes.find((entry) => entry.parent === null), [nodes]);
  const byId = react.useMemo(() => new Map(nodes.map((entry) => [entry.id, entry])), [nodes]);
  const allEntries = react.useMemo(() => quadrants.buildQuadrantEntries(nodes), [nodes]);
  const visibleEntries = react.useMemo(
    () => quadrants.filterQuadrantEntries(allEntries, scopeFilter),
    [allEntries, scopeFilter],
  );
  const counts = react.useMemo(() => {
    let activeCount = 0;
    let pendingCount = 0;
    for (const entry of allEntries) {
      if (!entry.isClosed) activeCount += 1;
      if (entry.isPendingOpen) pendingCount += 1;
    }
    return { activeCount, pendingCount, totalCount: allEntries.length };
  }, [allEntries]);

  const grouped = react.useMemo(() => {
    const map = new Map<types.DecisionQuadrant, quadrants.QuadrantEntry[]>();
    for (const spec of quadrants.QUADRANT_SPECS) {
      map.set(spec.key, []);
    }
    for (const entry of visibleEntries) {
      map.get(entry.quadrant)!.push(entry);
    }
    return map;
  }, [visibleEntries]);

  if (root === undefined) {
    return <div className="decision-empty">{t('还没有工作决策节点')}</div>;
  }

  const { activeCount, pendingCount, totalCount } = counts;
  let selectedNode: types.DecisionNode | undefined;
  if (selectedNodeId !== undefined) {
    selectedNode = byId.get(selectedNodeId);
  }
  let drawerSaving: string | undefined;
  if (selectedNode !== undefined && savingKey !== undefined && savingKey.startsWith(`${selectedNode.id}:`)) {
    drawerSaving = savingKey.slice(selectedNode.id.length + 1);
  }

  const renderFilterPills = () => (
    <div className="decision-quad-filters" role="group" aria-label={t('四象限筛选')}>
      <button
        type="button"
        data-quad-filter="active"
        aria-pressed={scopeFilter === 'active'}
        onClick={() => setScopeFilter('active')}
      >
        {t('未完结')} {String(activeCount)}
      </button>
      <button
        type="button"
        data-quad-filter="pending"
        aria-pressed={scopeFilter === 'pending'}
        onClick={() => setScopeFilter('pending')}
      >
        {t('仅待拍板')} {String(pendingCount)}
      </button>
      <button
        type="button"
        data-quad-filter="all"
        aria-pressed={scopeFilter === 'all'}
        onClick={() => setScopeFilter('all')}
      >
        {t('含已完结')} {String(totalCount)}
      </button>
    </div>
  );

  const renderDetailDrawer = () => {
    if (selectedNode === undefined) return null;

    //M 直接透传四象限矩阵已算好的归属象限与节点字典，保证侧栏高亮与卡片所在格完全一致。
    const selectedEntry = allEntries.find((entry) => entry.node.id === selectedNode.id);
    return (
      <drawer.Drawer
        key={selectedNode.id}
        node={selectedNode}
        quadrant={selectedEntry?.quadrant}
        byId={byId}
        saving={drawerSaving}
        error={actionError}
        close={() => onSelectNode(undefined)}
        choose={(opt) => void onChooseOption(selectedNode.id, opt)}
        sending={sending}
        noteError={noteError}
        send={(text, opt) => onSendNote(selectedNode.id, text, opt)}
        focus={() => onFocusTree(selectedNode.id)}
        openTopic={() => onOpenNodeTopic(selectedNode.id)}
        refresh={onRefresh}
        expand={onExpand}
      />
    );
  };

  //M 手机竖屏（< 800px）：默认一屏完整展示 2×2 四块总览，轻点任意一块全屏放大查看全部小块。
  if (isMobile) {
    const zoomedSpec = quadrants.QUADRANT_SPECS.find((spec) => spec.key === zoomedQuad);
    let zoomedItems: quadrants.QuadrantEntry[] = [];
    if (zoomedSpec !== undefined) {
      zoomedItems = grouped.get(zoomedSpec.key) ?? [];
    }

    return (
      <div className="decision-quad-m-shell">
        {zoomedSpec === undefined && (
          <div className="decision-quad-m-overview">
            <div className="decision-quad-m-bar">
              {renderFilterPills()}
              <span className="decision-quad-m-hint">{t('轻点象限放大')} ›</span>
            </div>
            <div className="decision-quad-m-grid">
              {quadrants.QUADRANT_SPECS.map((spec) => {
                const items = grouped.get(spec.key) ?? [];
                const quadPending = items.filter((item) => item.isPendingOpen).length;
                const previews = items.slice(0, 5);
                return (
                  <button
                    key={spec.key}
                    type="button"
                    className="decision-quad-m-tile"
                    data-quad={spec.key}
                    data-quad-tile={spec.key}
                    onClick={() => setZoomedQuad(spec.key)}
                  >
                    <span className="decision-quad-m-tile__top">
                      <span className="decision-quad-badge" data-quad={spec.key}>{spec.code}</span>
                      <span className="decision-quad-m-tile__count">{String(items.length)}</span>
                      {quadPending > 0 && (
                        <span className="decision-quad-m-tile__pending">★ {String(quadPending)}</span>
                      )}
                    </span>
                    <strong className="decision-quad-m-tile__title">{t(spec.title)}</strong>
                    <span className="decision-quad-m-tile__sub">{t(spec.subtitle)}</span>
                    <span className="decision-quad-m-preview">
                      {previews.length === 0 && (
                        <span className="decision-quad-m-preview__empty">{t('当前无事项')}</span>
                      )}
                      {previews.map((item) => {
                        const st = topicView.getFourState(item.node);
                        return (
                          <span key={item.node.id} className="decision-quad-m-preview__row">
                            <i className="decision-m-tile__dot" data-state={st.key} />
                            <span className="decision-quad-m-preview__text">{item.node.title}</span>
                          </span>
                        );
                      })}
                    </span>
                    <span className="decision-quad-m-tile__more">
                      {t('查看全部')} {String(items.length)} {t('项')} ›
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {zoomedSpec !== undefined && (
          <div className="decision-quad-m-zoom" data-quad={zoomedSpec.key}>
            <div className="decision-quad-m-zoom__nav">
              <button
                type="button"
                className="decision-m-back-tiles"
                data-quad-back
                onClick={() => setZoomedQuad(null)}
              >
                ‹ {t('返回四象限')}
              </button>
              <div className="decision-quad-m-zoom__tabs" role="tablist" aria-label={t('快速切换象限')}>
                {quadrants.QUADRANT_SPECS.map((spec) => {
                  const len = grouped.get(spec.key)?.length ?? 0;
                  return (
                    <button
                      key={spec.key}
                      type="button"
                      role="tab"
                      data-quad={spec.key}
                      data-quad-tab={spec.key}
                      aria-selected={spec.key === zoomedSpec.key}
                      onClick={() => setZoomedQuad(spec.key)}
                    >
                      {spec.code} <span>{String(len)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="decision-quad-m-zoom__scroll">
              <div className="decision-quad-m-zoom__hero" data-quad={zoomedSpec.key}>
                <div className="decision-quad-m-zoom__hero-top">
                  <span className="decision-quad-badge" data-quad={zoomedSpec.key}>{zoomedSpec.code}</span>
                  <h2>{t(zoomedSpec.title)}</h2>
                  <span className="decision-quad-m-zoom__sub">{t(zoomedSpec.subtitle)}</span>
                </div>
                {renderFilterPills()}
              </div>

              {zoomedItems.length === 0 && (
                <div className="decision-topic-card">
                  <p className="decision-view__empty">{t('当前筛选下该象限没有事项')}</p>
                </div>
              )}

              <div className="decision-quad-m-list">
                {zoomedItems.map((entry) => {
                  const st = topicView.getFourState(entry.node);
                  const line = getFirstSummaryLine(entry.node.summary);
                  const optLen = entry.node.options?.length ?? 0;
                  return (
                    <button
                      key={entry.node.id}
                      type="button"
                      className="decision-quad-m-card"
                      data-quad-node={entry.node.id}
                      data-pending={entry.isPendingOpen}
                      aria-pressed={selectedNode?.id === entry.node.id}
                      onClick={() => onSelectNode(entry.node.id)}
                    >
                      <span className="decision-quad-m-card__top">
                        <span className="decision-state-pill" data-state={st.key}>{st.label}</span>
                        {entry.topicTitle !== '' && (
                          <span className="decision-quad-topic-tag">{entry.topicTitle}</span>
                        )}
                        {entry.isManual && (
                          <span className="decision-quad-manual-tag">{t('手动')}</span>
                        )}
                      </span>
                      <strong className="decision-quad-m-card__title">{entry.node.title}</strong>
                      {line !== '' && (
                        <span className="decision-quad-m-card__desc">{line}</span>
                      )}
                      {entry.isPendingOpen && optLen > 0 && (
                        <span className="decision-quad-m-card__cta">
                          ★ {String(optLen)} {t('个选项 · 点此拍板')} ›
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {renderDetailDrawer()}
        {selectedNode === undefined && (
          <composer.CentralDock
            targetNode={root}
            defaultNode={root}
            scopeNodes={nodes}
            onResetTarget={() => onSelectNode(undefined)}
            onSelectNode={onSelectNode}
            onSendNote={(id, text) => onSendNote(id, text)}
            sending={sending}
            noteError={noteError}
          />
        )}
      </div>
    );
  }

  //M PC 宽屏（>= 800px）：主区铺开 2×2 四象限独立滚动矩阵 + 右侧常驻详情拍板/留言面板。
  return (
    <div className="decision-quad-pc">
      <div className="decision-quad-pc__main">
        <div className="decision-quad-bar">
          <div className="decision-quad-bar__left">
            <strong>{t('艾森豪威尔四象限')}</strong>
            {renderFilterPills()}
          </div>
          <span className="decision-quad-bar__hint">
            {t('点任意小块在右侧直接看正文、拍板选项或切换所属象限')}
          </span>
        </div>

        <div className="decision-quad-grid">
          {quadrants.QUADRANT_SPECS.map((spec) => {
            const items = grouped.get(spec.key) ?? [];
            const quadPending = items.filter((item) => item.isPendingOpen).length;
            return (
              <section
                key={spec.key}
                className="decision-quad-box"
                data-quad={spec.key}
                aria-label={`${spec.code} ${spec.title}`}
              >
                <header className="decision-quad-box__head">
                  <div className="decision-quad-box__title-row">
                    <span className="decision-quad-badge" data-quad={spec.key}>{spec.code}</span>
                    <h3>{t(spec.title)}</h3>
                    <span className="decision-quad-box__sub">{t(spec.subtitle)}</span>
                  </div>
                  <div className="decision-quad-box__counts">
                    {quadPending > 0 && (
                      <span className="decision-topic-badge decision-topic-badge--pending">
                        ★ {String(quadPending)} {t('待拍板')}
                      </span>
                    )}
                    <span className="decision-topic-badge">{String(items.length)}</span>
                  </div>
                </header>

                <div className="decision-quad-box__list">
                  {items.length === 0 && (
                    <p className="decision-quad-box__empty">{t('当前筛选下无事项')}</p>
                  )}
                  {items.map((entry) => {
                    const st = topicView.getFourState(entry.node);
                    const active = selectedNode?.id === entry.node.id;
                    return (
                      <button
                        key={entry.node.id}
                        type="button"
                        className="decision-quad-chip"
                        data-quad-node={entry.node.id}
                        data-state={st.key}
                        aria-pressed={active}
                        onClick={() => onSelectNode(entry.node.id)}
                      >
                        <span className="decision-quad-chip__top">
                          <i className="decision-m-tile__dot" data-state={st.key} />
                          <span className="decision-quad-chip__title">{entry.node.title}</span>
                        </span>
                        <span className="decision-quad-chip__meta">
                          {entry.isPendingOpen && (
                            <span className="decision-quad-chip__pending">★ {t('待拍板')}</span>
                          )}
                          {!entry.isPendingOpen && (
                            <span className="decision-quad-chip__state">{st.label}</span>
                          )}
                          {entry.topicTitle !== '' && (
                            <span className="decision-quad-topic-tag">{entry.topicTitle}</span>
                          )}
                          {entry.isManual && (
                            <span className="decision-quad-manual-tag">{t('手动')}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="decision-quad-pc__side">
        {selectedNode !== undefined && renderDetailDrawer()}
        {selectedNode === undefined && (
          <composer.CentralDock
            targetNode={root}
            defaultNode={root}
            scopeNodes={nodes}
            onResetTarget={() => onSelectNode(undefined)}
            onSelectNode={onSelectNode}
            onSendNote={(id, text) => onSendNote(id, text)}
            sending={sending}
            noteError={noteError}
          />
        )}
      </div>
    </div>
  );
}

/** 记忆化四象限矩阵视图，避免顶栏或后台探针无关状态导致重复重绘。 */
export const QuadrantView = react.memo(QuadrantViewInner);
