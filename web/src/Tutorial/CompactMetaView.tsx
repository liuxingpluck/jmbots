/**
 * 教程页「极限压缩认知架构（横向全景地图 + 纵向 4 段学习路线 + 洋葱圈同心圆）」全屏交互视图。
 * 严格遵循 4~6 工作记忆组块渐进披露：
 *   - 「🗺️ 全景地图」：5 原子签子 + 3 主线 + 5 张 L0 块卡（排他展开 L1 子角色）+ L2 三行插件卡；
 *   - 「🧭 4段路线」：4 张学习大段卡（排他选中）+ 当前段 ≤4 张小块卡（3~5 概念 + 离线闭环实验 + 可展开 10 秒自测 + 篇目直达）；
 *   - 「🧅 洋葱圈」：4 层同心圆依赖视图（独立拆分为 CompactOnionView.tsx），呈现外圈依赖内圈与圆心骨架核 0 插件依赖。
 */
import * as react from 'react';
import * as tokenModule from '../Token.ts';
import * as meta from './CompactMetaData.ts';
import * as onionView from './CompactOnionView.tsx';
import * as quizBoxModule from './CompactQuizBox.tsx';
import * as quizModule from './QuizSubmit.ts';
import './TanghuluCanvas.css';
import './CompactMetaView.css';

/** CompactMetaView 组件入参。 */
export interface CompactMetaViewProps {
  /** 切换到 28 节点糖葫芦原详图。 */
  onDetail: () => void;
  /** 关闭画布返回教程主视图。 */
  onClose: () => void;
}

/** 顶栏三个认知维度页签：横向找位置 vs 纵向按段学 vs 同心圆看依赖。 */
type CompactTab = 'map' | 'route' | 'onion';


/**
 * 统计单个 L0 大块内包含的插件总数。
 * @param block L0 功能大块。
 */
function countBlockPlugins(block: meta.Block): number {
  let total = 0;
  for (const role of block.roles) {
    total += role.plugins.length;
  }
  return total;
}


/**
 * 把带 .md 后缀的组块文件名美化为紧凑阅读标签（如 01_第一块.md -> 01_第一块）。
 * @param docFile 真实组块文件名。
 */
function formatDocLabel(docFile: string): string {
  return docFile.replace(/\.md$/u, '');
}


/**
 * 渲染单个 L0 功能大块卡片及其排他展开的 L1 子角色列表。
 */
function BlockAccordionCard(props: {
  block: meta.Block;
  isOpen: boolean;
  isBase: boolean;
  selectedPlugin: string;
  onToggleBlock: (blockId: string) => void;
  onSelectPlugin: (pluginName: string) => void;
}): react.JSX.Element {
  const { block, isOpen, isBase, selectedPlugin, onToggleBlock, onSelectPlugin } = props;
  const pluginTotal = countBlockPlugins(block);

  let blockClass = 'tu-cm-block';
  if (isOpen) {
    blockClass = 'tu-cm-block is-open';
  }

  let chevText = '▸ 展开角色';
  if (isOpen) {
    chevText = '▾ 收起';
  }

  let rolesClass = 'tu-cm-roles';
  if (isBase) {
    rolesClass = 'tu-cm-roles tu-cm-base-roles';
  }

  return (
    <section className={blockClass} data-block-id={block.id}>
      <button
        type="button"
        className="tu-cm-block-btn"
        aria-expanded={isOpen}
        data-cm-block={block.id}
        onClick={() => onToggleBlock(block.id)}
      >
        <div className="tu-cm-block-top">
          <span className="tu-cm-block-name">{block.name}</span>
          <span className="tu-cm-block-badges">
            <span className="tu-cm-count-pill">
              {String(block.roles.length)} 角色 · {String(pluginTotal)} 插件
            </span>
            <span className="tu-cm-chev">{chevText}</span>
          </span>
        </div>
        <div className="tu-cm-block-line">{block.line}</div>
      </button>

      {isOpen && (
        <div className={rolesClass} data-cm-roles={block.id}>
          {block.roles.map((role) => (
            <div key={role.name} className="tu-cm-role-item">
              <span className="tu-cm-role-name">{role.name}</span>
              <div className="tu-cm-plugin-pills">
                {role.plugins.map((pluginName) => {
                  let pillClass = 'tu-cm-plugin-btn';
                  if (selectedPlugin === pluginName) {
                    pillClass = 'tu-cm-plugin-btn is-active';
                  }
                  return (
                    <button
                      key={pluginName}
                      type="button"
                      className={pillClass}
                      data-cm-plugin={pluginName}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectPlugin(pluginName);
                      }}
                    >
                      {pluginName}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}


/**
 * 统计单个学习大段内已通过自测的小块数量。
 * @param stage 学习大段元数据。
 * @param quizStore 本地自测记录映射。
 */
function countStagePassed(stage: meta.Stage, quizStore: quizModule.QuizStore): number {
  let count = 0;
  for (const chunk of stage.chunks) {
    if (quizStore[chunk.id]?.passed === true) {
      count += 1;
    }
  }
  return count;
}


/**
 * 渲染「🧭 4段路线」页签内容：4 张排他大段卡 + 当前段 ≤4 张小块学习卡（动态选机器人页内直答批改）。
 */
function LearningRoutePanel(props: {
  activeStageId: string;
  openQuizIds: ReadonlySet<string>;
  quizStore: quizModule.QuizStore;
  availableBots: readonly string[];
  botsLoading: boolean;
  botsError: string;
  onRetryBots: () => void;
  selectedBot: string;
  onSelectBot: (bot: string) => void;
  onSelectStage: (stageId: string) => void;
  onToggleQuiz: (chunkId: string) => void;
  onUpdateQuizRecord: (chunkId: string, next: quizModule.QuizRecord) => void;
  onJumpNextChunk: (chunkId: string) => void;
}): react.JSX.Element {
  const {
    activeStageId,
    openQuizIds,
    quizStore,
    availableBots,
    botsLoading,
    botsError,
    onRetryBots,
    selectedBot,
    onSelectBot,
    onSelectStage,
    onToggleQuiz,
    onUpdateQuizRecord,
    onJumpNextChunk,
  } = props;
  const activeStage = meta.STAGES.find((item) => item.id === activeStageId) ?? meta.STAGES[0];
  const fullRouteHref = tokenModule.withToken(
    `/tutorial/?page=doc&rtab=reading&reading=${encodeURIComponent('00_学习路线.md')}`,
    tokenModule.TOKEN,
  );

  return (
    <>
      <div className="tu-cm-stage-head">
        <span className="tu-cm-stage-title">
          先分段、再分块（4 大段 × 每段 4 块 × 每块 3~5 概念 ≈ 66 核心概念；页内填答可选任意配置机器人批改并自动记进度）
        </span>
        <a className="tu-cm-doc-link" href={fullRouteHref}>
          阅读完整《00_学习路线》文档 →
        </a>
      </div>

      {/* 顶部 4 张排他学习大段卡 */}
      <div className="tu-cm-stages-bar" role="tablist" aria-label="4大渐进学习段">
        {meta.STAGES.map((stage) => {
          const isSelected = activeStage?.id === stage.id;
          let cardCls = 'tu-cm-stage-card';
          if (isSelected) {
            cardCls = 'tu-cm-stage-card is-active';
          }
          const passedCount = countStagePassed(stage, quizStore);
          let stageBadge = `${String(stage.chunks.length)} 块`;
          if (passedCount > 0) {
            stageBadge = `✅ ${String(passedCount)}/${String(stage.chunks.length)} 过关`;
          }
          return (
            <button
              key={stage.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              className={cardCls}
              data-cm-stage={stage.id}
              onClick={() => onSelectStage(stage.id)}
            >
              <div className="tu-cm-block-top">
                <span className="tu-cm-block-name">{stage.title}</span>
                <span className="tu-cm-count-pill">{stageBadge}</span>
              </div>
              <div className="tu-cm-stage-unlock">解锁：{stage.unlock}</div>
            </button>
          );
        })}
      </div>

      {/* 当前选中段的 ≤4 张工作记忆小块卡 */}
      {activeStage !== undefined && (
        <div className="tu-cm-chunks-grid" data-cm-stage-chunks={activeStage.id}>
          {activeStage.chunks.map((chunk, chunkIndex) => {
            const quizOpen = openQuizIds.has(chunk.id);
            const record = quizStore[chunk.id];
            const isPassed = record?.passed === true;
            const nextChunk = activeStage.chunks[chunkIndex + 1];
            let quizBtnText = '📝 10秒自测 ▸';
            if (quizOpen) {
              quizBtnText = '📝 收起自测 ▾';
            }
            if (!quizOpen && isPassed) {
              quizBtnText = '✅ 看批改记录 ▸';
            }
            return (
              <article key={chunk.id} className="tu-cm-chunk-card" data-cm-chunk={chunk.id}>
                <div className="tu-cm-block-top">
                  <span className="tu-cm-chunk-title">{chunk.title}</span>
                  <span className="tu-cm-block-badges">
                    {isPassed && <span className="tu-cm-passed-pill">✅ 已过关</span>}
                    <span className="tu-cm-count-pill">{String(chunk.concepts.length)} 概念</span>
                  </span>
                </div>

                <div className="tu-cm-concept-list">
                  {chunk.concepts.map((concept) => (
                    <span key={concept} className="tu-cm-concept-chip">
                      {concept}
                    </span>
                  ))}
                </div>

                <div className="tu-cm-lab-box">
                  <span className="tu-cm-lab-label">🧪 最小闭环实验：</span>
                  <span>{chunk.lab}</span>
                </div>

                <div className="tu-cm-chunk-foot">
                  <div className="tu-cm-doc-links">
                    {chunk.docs.map((docFile) => {
                      const href = tokenModule.withToken(
                        `/tutorial/?page=doc&rtab=reading&reading=${encodeURIComponent(docFile)}`,
                        tokenModule.TOKEN,
                      );
                      return (
                        <a key={docFile} className="tu-cm-doc-link" href={href}>
                          📖 {formatDocLabel(docFile)} →
                        </a>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    className="tu-cm-quiz-btn"
                    aria-expanded={quizOpen}
                    data-cm-quiz-toggle={chunk.id}
                    onClick={() => onToggleQuiz(chunk.id)}
                  >
                    {quizBtnText}
                  </button>
                </div>

                {quizOpen && (
                  <quizBoxModule.CompactQuizBox
                    chunk={chunk}
                    availableBots={availableBots}
                    botsLoading={botsLoading}
                    botsError={botsError}
                    onRetryBots={onRetryBots}
                    selectedBot={selectedBot}
                    onSelectBot={onSelectBot}
                    record={record}
                    nextChunk={nextChunk}
                    onUpdateRecord={onUpdateQuizRecord}
                    onJumpNext={onJumpNextChunk}
                  />
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}


/** 从 URL 查询参数读取初始页签（?tab=route 或 ?tab=onion），缺省为 map。 */
function readInitialTab(): CompactTab {
  try {
    const param = new URLSearchParams(window.location.search).get('tab');
    if (param === 'route') return 'route';
    if (param === 'onion') return 'onion';
  } catch {
    //G 测试或非浏览器环境下默认落回全景地图。
  }
  return 'map';
}


/**
 * 「极限压缩认知架构（全景地图 + 4段路线）」主组件。
 * @param props 切换详图与关闭回调。
 */
export function CompactMetaView(props: CompactMetaViewProps): react.JSX.Element {
  const { onClose, onDetail } = props;

  /** 当前激活的认知维度页签：支持 ?tab=route / ?tab=onion 直达，默认全景地图。 */
  const [activeTab, setActiveTab] = react.useState<CompactTab>(() => readInitialTab());

  /** 全景地图中当前排他展开的 L0 块 ID；空串表示全部折叠。 */
  const [openBlockId, setOpenBlockId] = react.useState<string>('front');

  /** 全景地图底部 L2 面板选中的插件目录名。 */
  const [selectedPlugin, setSelectedPlugin] = react.useState<string>('bots');

  /** 4 段路线中当前排他选中的大段 ID。 */
  const [activeStageId, setActiveStageId] = react.useState<string>('stage-1');

  /** 4 段路线中已展开 10 秒自测题的小块 ID 集合（默认展开 1.1 方便直接作答）。 */
  const [openQuizIds, setOpenQuizIds] = react.useState<Set<string>>(() => new Set(['1.1']));

  /** 4 段路线各小块页内自测回答与批改本地持久化表。 */
  const [quizStore, setQuizStore] = react.useState<quizModule.QuizStore>(() => quizModule.loadQuizStore());

  /** 从 GET /api/bots 动态拉取的可用机器人列表（零硬编码）。 */
  const [availableBots, setAvailableBots] = react.useState<string[]>([]);

  /** 机器人列表是否正在加载中。 */
  const [botsLoading, setBotsLoading] = react.useState<boolean>(true);

  /** 拉取机器人列表失败时的中文报错；成功时为空串。 */
  const [botsError, setBotsError] = react.useState<string>('');

  /** 当前选中的批改机器人名（记住上次选择，回落到后端清单第一项）。 */
  const [selectedBot, setSelectedBot] = react.useState<string>(() => quizModule.loadPreferredBot());

  /** 机器人列表拉取序列号，防止重试并发返回覆盖最新结果。 */
  const botsSeqRef = react.useRef<number>(0);

  /** 组件挂载标记，避免卸载后异步写入状态。 */
  const mountedRef = react.useRef<boolean>(true);

  /** 从 /api/bots 动态拉取系统已配置的全部机器人（支持重试）。 */
  const handleLoadBots = react.useCallback((): void => {
    const seq = botsSeqRef.current + 1;
    botsSeqRef.current = seq;
    setBotsLoading(true);
    setBotsError('');

    const run = async (): Promise<void> => {
      const result = await quizModule.fetchAvailableBots();
      //G 卸载或已有更新一次重试请求时丢弃过时结果。
      if (!mountedRef.current || botsSeqRef.current !== seq) return;

      setBotsLoading(false);
      setBotsError(result.error);
      setAvailableBots(result.bots);
      if (result.bots.length > 0) {
        setSelectedBot((prev) => {
          const resolved = quizModule.resolveSelectedBot(result.bots, prev);
          if (resolved !== '') {
            quizModule.savePreferredBot(resolved);
          }
          return resolved;
        });
      }
    };
    void run();
  }, []);

  //M 页面加载时从 /api/bots 动态拉取系统已配置的全部机器人，避免硬编码任何机器人名。
  react.useEffect(() => {
    mountedRef.current = true;
    handleLoadBots();
    return () => {
      mountedRef.current = false;
    };
  }, [handleLoadBots]);

  /** 切换并记住当前批改机器人。 */
  const handleSelectBot = react.useCallback((bot: string): void => {
    setSelectedBot(bot);
    quizModule.savePreferredBot(bot);
  }, []);

  //M 按 Escape 键关闭全屏架构视图返回教程页；焦点在输入框或下拉选择框内时不误关闭。
  react.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isFormControl =
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement;
      if (isFormControl) return;

      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /** 更新单块自测记录并同步写入浏览器本地存储。 */
  const handleUpdateQuizRecord = react.useCallback((chunkId: string, next: quizModule.QuizRecord): void => {
    setQuizStore((prev) => {
      const updated: quizModule.QuizStore = { ...prev, [chunkId]: next };
      quizModule.saveQuizStore(updated);
      return updated;
    });
  }, []);

  /** 过关后一键展开下一块自测框并平滑滚到视野内。 */
  const handleJumpNextChunk = react.useCallback((nextChunkId: string): void => {
    setOpenQuizIds((prev) => {
      const next = new Set(prev);
      next.add(nextChunkId);
      return next;
    });
    window.requestAnimationFrame(() => {
      const target = document.querySelector(`[data-cm-chunk="${nextChunkId}"]`);
      if (target !== null) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, []);

  /** 排他手风琴切换 L0 大块。 */
  const handleToggleBlock = (blockId: string): void => {
    if (openBlockId === blockId) {
      setOpenBlockId('');
      return;
    }
    setOpenBlockId(blockId);
    const targetBlock = meta.BLOCKS.find((item) => item.id === blockId);
    const firstPlugin = targetBlock?.roles[0]?.plugins[0];
    if (firstPlugin !== undefined) {
      setSelectedPlugin(firstPlugin);
    }
  };

  /** 切换单个小块的 10 秒自测题展开状态。 */
  const handleToggleQuiz = (chunkId: string): void => {
    setOpenQuizIds((prev) => {
      const next = new Set(prev);
      if (next.has(chunkId)) {
        next.delete(chunkId);
        return next;
      }
      next.add(chunkId);
      return next;
    });
  };

  let mapTabClass = 'tu-cm-tab-btn';
  if (activeTab === 'map') {
    mapTabClass = 'tu-cm-tab-btn is-active';
  }

  let routeTabClass = 'tu-cm-tab-btn';
  if (activeTab === 'route') {
    routeTabClass = 'tu-cm-tab-btn is-active';
  }

  let onionTabClass = 'tu-cm-tab-btn';
  if (activeTab === 'onion') {
    onionTabClass = 'tu-cm-tab-btn is-active';
  }

  const mainBlocks = meta.BLOCKS.filter((item) => item.id !== 'base');
  const baseBlock = meta.BLOCKS.find((item) => item.id === 'base');

  return (
    <div
      className="tu-th-overlay"
      data-th-theme="dark"
      data-cm-root
      role="dialog"
      aria-label="极限压缩认知架构全景"
    >
      {/* ==================== 顶栏 ==================== */}
      <header className="tu-th-header">
        <div className="tu-th-brand-group">
          <div className="tu-th-brand-logo" title="极限压缩认知架构">
            ⚡
          </div>
          <div className="tu-th-brand-title-wrap">
            <div className="tu-th-brand-title">
              <span>积木 AI (jmbots src7) · 极限压缩认知架构</span>
              <span className="tu-th-brand-tag">34/34 插件 · 4段路线 · 洋葱圈</span>
            </div>
            <div className="tu-th-brand-subtitle">
              横向全景找位置（L0→L1→L2） · 纵向分段吃透机制（4段×4块） · 同心圆看依赖层级
            </div>
          </div>
        </div>

        <div className="tu-cm-tabs" role="tablist" aria-label="认知视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'map'}
            className={mapTabClass}
            data-cm-tab="map"
            onClick={() => setActiveTab('map')}
          >
            🗺️ 全景地图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'route'}
            className={routeTabClass}
            data-cm-tab="route"
            onClick={() => setActiveTab('route')}
          >
            🧭 4段路线
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'onion'}
            className={onionTabClass}
            data-cm-tab="onion"
            onClick={() => setActiveTab('onion')}
          >
            🧅 洋葱圈
          </button>
        </div>

        <div className="tu-th-toolbar-right">
          <button
            type="button"
            className="tu-cm-detail-btn"
            data-cm-detail
            onClick={onDetail}
          >
            🍡 查看原详图
          </button>
          <button
            type="button"
            className="tu-th-close-btn"
            data-th-close
            onClick={onClose}
          >
            ← 返回教程
          </button>
        </div>
      </header>

      {/* ==================== 主体滚动区 ==================== */}
      <main className="tu-cm-body">
        <div className="tu-cm-container">
          {activeTab === 'map' && (
            <>
              <section className="tu-cm-skewer-box" aria-label="骨架签子与主连线">
                <div className="tu-cm-motto-row">
                  <span className="tu-cm-motto-tag">🎯 第一性原理元点</span>
                  <span className="tu-cm-motto-text">{meta.ORIGIN_MOTTO}</span>
                </div>

                <div className="tu-cm-atoms-head">
                  <span className="tu-cm-atoms-label">🍡 骨架签子 · 5 大不可再分原子</span>
                  <span>关口 = 会话 × 串行事件（after-model 暂无人听）</span>
                </div>

                <div className="tu-cm-atoms-grid">
                  {meta.ATOMS.map((atom, index) => (
                    <div key={atom.id} className="tu-cm-atom-card" data-cm-atom={atom.id}>
                      <div className="tu-cm-atom-top">
                        <span className="tu-cm-atom-name">
                          {String(index + 1)}. {atom.name}
                        </span>
                        <code className="tu-cm-atom-site" title={atom.site}>
                          {atom.site}
                        </code>
                      </div>
                      <div className="tu-cm-atom-line">{atom.line}</div>
                    </div>
                  ))}
                </div>

                <div className="tu-cm-links-bar">
                  <span className="tu-cm-links-title">🔗 块间仅靠 3 条线：</span>
                  {meta.LINKS.map((link) => (
                    <span key={link.name} className="tu-cm-link-pill">
                      <span className="tu-cm-link-name">{link.name}</span>
                      <span className="tu-cm-link-desc">{link.line}</span>
                    </span>
                  ))}
                  <span className="tu-cm-links-note">底座靠 inject 托底，不拉连线</span>
                </div>
              </section>

              <div className="tu-cm-stage-head">
                <span className="tu-cm-stage-title">
                  L0 全局 5 大块（点击单块排他展开 L1 子角色，点击插件胶囊看底部 L2 三行卡）
                </span>
                <span>① 渠道 ⇄ ② 前台 ⇄ ③ 思考 ⇄ ④ 手脚（下托 ⑤ 底座）</span>
              </div>

              <div className="tu-cm-main-row">
                {mainBlocks.map((block) => (
                  <BlockAccordionCard
                    key={block.id}
                    block={block}
                    isOpen={openBlockId === block.id}
                    isBase={false}
                    selectedPlugin={selectedPlugin}
                    onToggleBlock={handleToggleBlock}
                    onSelectPlugin={setSelectedPlugin}
                  />
                ))}
              </div>

              {baseBlock !== undefined && (
                <BlockAccordionCard
                  block={baseBlock}
                  isOpen={openBlockId === baseBlock.id}
                  isBase={true}
                  selectedPlugin={selectedPlugin}
                  onToggleBlock={handleToggleBlock}
                  onSelectPlugin={setSelectedPlugin}
                />
              )}

              <onionView.CompactPluginCard pluginName={selectedPlugin} cardAttr="cm" />
            </>
          )}

          {activeTab === 'route' && (
            <LearningRoutePanel
              activeStageId={activeStageId}
              openQuizIds={openQuizIds}
              quizStore={quizStore}
              availableBots={availableBots}
              botsLoading={botsLoading}
              botsError={botsError}
              onRetryBots={handleLoadBots}
              selectedBot={selectedBot}
              onSelectBot={handleSelectBot}
              onSelectStage={setActiveStageId}
              onToggleQuiz={handleToggleQuiz}
              onUpdateQuizRecord={handleUpdateQuizRecord}
              onJumpNextChunk={handleJumpNextChunk}
            />
          )}

          {activeTab === 'onion' && <onionView.CompactOnionView />}
        </div>
      </main>
    </div>
  );
}
