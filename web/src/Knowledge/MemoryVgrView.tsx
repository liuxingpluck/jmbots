/**
 * 知识库「🧠 记忆与 VGR」一体化管理视图：
 * 1. 顶部实时展示 Rust jmbots-memory 引擎、本地嵌入模型（bge-m3 等）、向量化覆盖率与图谱三元组抽取进度，支持一键刷新索引与重抽失败图谱；
 * 2. 「🔎 混合检索」：直连 /api/memory/search，清晰标出 keyword / vector / graph 命中路由徽章，支持按来源过滤、查看原文段落及一键沉淀进知识库文档；
 * 3. 「🗂️ 长期记忆条」：管理 memory/ 长期记忆卡片与 knowledge/ 独立知识切片（新增、查看、编辑、删除，全程应用内弹窗）；
 * 4. 「⚙️ 本地嵌入模型与 VGR 配置」：可视化读写 memory.yaml（模型路径、ONNX Runtime、存储目录、检索重排与抽取模型参数，密钥安全脱敏）。
 */
import * as react from 'react';
import * as token from '../Token.ts';
import * as docList from './DocList.tsx';
import * as dialogs from './KbDialogs.tsx';
import * as kbApi from './KnowledgeApi.ts';
import * as memApi from './MemoryVgrApi.ts';


/** MemoryVgrView 入参。 */
export interface MemoryVgrViewProps {
  /** 是否只读模式。 */
  readOnly: boolean;
  /** 顶栏提示吐司。 */
  onNotice: (message: string) => void;
  /** 接口异常统一上报（如 403 切只读）。 */
  onError: (error: unknown) => void;
  /** 沉淀为知识库文档后跳转到文档编辑器。 */
  onSavedToKnowledge: (docId: string) => void;
}

type SubTab = 'search' | 'items' | 'config';

const ALL_SOURCES: readonly memApi.MemorySourceKind[] = ['knowledge', 'card', 'history', 'channel'];

const SOURCE_LABELS: Record<memApi.MemorySourceKind, string> = {
  knowledge: '📚 知识切片',
  card: '🗂️ 记忆卡片',
  history: '💬 历史会话',
  channel: '📨 渠道归档',
};

const MODE_OPTIONS: ReadonlyArray<{ value: memApi.MemorySearchMode; label: string; tip: string }> = [
  { value: 'hybrid', label: '混合检索 (Hybrid)', tip: 'FTS 关键词 + 本地向量语义 RRF 融合' },
  { value: 'semantic', label: '纯向量 (Vector)', tip: '使用本地嵌入模型计算余弦语义相似度' },
  { value: 'keyword', label: '关键词 (Keyword)', tip: '精确词面与字组快速检索' },
  { value: 'graph', label: '图谱增强 (Graph)', tip: '叠加实体识别、多跳关系子图与重排' },
];


/** 格式化字节数。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


/** 渲染命中通路徽章（keyword / vector / graph）。 */
function renderViaBadges(via: readonly string[]): react.JSX.Element {
  const normalized = via.length > 0 ? via : ['keyword'];
  return (
    <span className="kb-vgr-via-list">
      {normalized.map((route) => {
        const key = route.toLowerCase();
        let label = route;
        let kind = 'other';
        if (key === 'keyword' || key === 'fts' || key === 'literal') {
          label = 'keyword · 关键词';
          kind = 'keyword';
        } else if (key === 'vector' || key === 'semantic' || key === 'dense') {
          label = 'vector · 向量';
          kind = 'vector';
        } else if (key === 'graph' || key === 'relation') {
          label = 'graph · 关系图';
          kind = 'graph';
        }
        return (
          <span key={route} className="kb-via-badge" data-via={kind}>
            {label}
          </span>
        );
      })}
    </span>
  );
}


/** 记忆与 VGR 融合主视图。 */
export function MemoryVgrView(props: MemoryVgrViewProps): react.JSX.Element {
  const { readOnly, onNotice, onError, onSavedToKnowledge } = props;
  const kbDialog = dialogs.useKbDialog();

  const [subTab, setSubTab] = react.useState<SubTab>('search');

  //M 1. 引擎概览与 VGR 配置状态
  const [overview, setOverview] = react.useState<memApi.VgrOverviewResponse | undefined>(undefined);
  const [overviewLoading, setOverviewLoading] = react.useState(true);
  const [reindexing, setReindexing] = react.useState(false);

  //M 配置表单草稿
  const [cfgModelDir, setCfgModelDir] = react.useState('');
  const [cfgOnnx, setCfgOnnx] = react.useState('');
  const [cfgStoreDir, setCfgStoreDir] = react.useState('');
  const [cfgDefaultMode, setCfgDefaultMode] = react.useState<'hybrid' | 'graph'>('hybrid');
  const [cfgGraphOn, setCfgGraphOn] = react.useState(true);
  const [cfgRerankOn, setCfgRerankOn] = react.useState(true);
  const [cfgFinalTopK, setCfgFinalTopK] = react.useState(20);
  const [cfgEntityTopK, setCfgEntityTopK] = react.useState(10);
  const [cfgRelationTopK, setCfgRelationTopK] = react.useState(10);
  const [cfgExpansionDegree, setCfgExpansionDegree] = react.useState(2);
  const [cfgLlmBaseUrl, setCfgLlmBaseUrl] = react.useState('');
  const [cfgLlmApiKey, setCfgLlmApiKey] = react.useState('');
  const [cfgLlmModel, setCfgLlmModel] = react.useState('');
  const [cfgExtractModel, setCfgExtractModel] = react.useState('');
  const [cfgExtractConcurrency, setCfgExtractConcurrency] = react.useState(2);
  const [savingConfig, setSavingConfig] = react.useState(false);

  //M 2. 混合检索状态
  const [searchInput, setSearchInput] = react.useState('');
  const [searchMode, setSearchMode] = react.useState<memApi.MemorySearchMode>('hybrid');
  const [selectedSources, setSelectedSources] = react.useState<memApi.MemorySourceKind[]>([
    'knowledge',
    'card',
    'channel',
  ]);
  const [searching, setSearching] = react.useState(false);
  const [searchRes, setSearchRes] = react.useState<memApi.MemoryUnifiedSearchResponse | undefined>(undefined);
  const [searchError, setSearchError] = react.useState<string | undefined>(undefined);
  const [expandedRef, setExpandedRef] = react.useState<string | undefined>(undefined);
  const [passageCache, setPassageCache] = react.useState<Record<string, memApi.PassageDetailResponse>>({});

  //M 3. 长期记忆条管理状态
  const [itemScopeFilter, setItemScopeFilter] = react.useState<'all' | memApi.MemoryItemScope>('all');
  const [itemBotFilter, setItemBotFilter] = react.useState('');
  const [bots, setBots] = react.useState<string[]>([]);
  const [items, setItems] = react.useState<memApi.MemoryItemSummary[]>([]);
  const [itemsLoading, setItemsLoading] = react.useState(false);
  const [itemsLegacy, setItemsLegacy] = react.useState(false);

  //M 当前编辑或新建的长期记忆条
  const [editingItem, setEditingItem] = react.useState<{
    isNew: boolean;
    scope: memApi.MemoryItemScope;
    bot: string;
    path: string;
    content: string;
  } | undefined>(undefined);
  const [itemSaving, setItemSaving] = react.useState(false);

  /** 将后端返回的 VgrConfigData 同步进配置编辑框。 */
  const hydrateConfigForm = react.useCallback((cfg: memApi.VgrConfigData) => {
    setCfgModelDir(cfg.modelDir);
    setCfgOnnx(cfg.onnxruntime);
    setCfgStoreDir(cfg.storeDir);
    setCfgDefaultMode(cfg.retrieval.defaultMode);
    setCfgGraphOn(cfg.retrieval.graph);
    setCfgRerankOn(cfg.retrieval.rerank);
    setCfgFinalTopK(cfg.retrieval.finalTopK);
    setCfgEntityTopK(cfg.retrieval.entityTopK);
    setCfgRelationTopK(cfg.retrieval.relationTopK);
    setCfgExpansionDegree(cfg.retrieval.expansionDegree);
    setCfgLlmBaseUrl(cfg.llm.baseUrl);
    setCfgLlmApiKey('');
    setCfgLlmModel(cfg.llm.model);
    setCfgExtractModel(cfg.llm.extractModel);
    setCfgExtractConcurrency(cfg.llm.extractConcurrency);
  }, []);

  /** 拉取 VGR 概览与引擎状态。 */
  const loadOverview = react.useCallback(async () => {
    setOverviewLoading(true);
    try {
      const data = await memApi.fetchVgrOverview();
      setOverview(data);
      hydrateConfigForm(data.config);
    } catch (error) {
      onError(error);
    } finally {
      setOverviewLoading(false);
    }
  }, [hydrateConfigForm, onError]);

  react.useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  /** 拉取长期记忆条列表。 */
  const loadItems = react.useCallback(async () => {
    setItemsLoading(true);
    try {
      const res = await memApi.listMemoryItems(itemScopeFilter, itemBotFilter);
      setBots(res.bots);
      setItems(res.items);
      setItemsLegacy(res.legacyFallback === true);
    } catch (error) {
      onError(error);
    } finally {
      setItemsLoading(false);
    }
  }, [itemScopeFilter, itemBotFilter, onError]);

  react.useEffect(() => {
    if (subTab === 'items') {
      void loadItems();
    }
  }, [subTab, loadItems]);

  /** 执行混合检索。 */
  const runSearch = async (event?: react.FormEvent): Promise<void> => {
    if (event !== undefined) {
      event.preventDefault();
    }
    const q = searchInput.trim();
    if (q === '') {
      onNotice('请输入要检索的关键词或问题');
      return;
    }
    if (selectedSources.length === 0) {
      onNotice('请至少勾选一个记忆来源');
      return;
    }
    setSearching(true);
    setSearchError(undefined);
    try {
      const res = await memApi.searchUnifiedMemory({
        q,
        mode: searchMode,
        sources: selectedSources,
        limit: 24,
      });
      setSearchRes(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSearchError(msg);
    } finally {
      setSearching(false);
    }
  };

  /** 切换检索来源多选胶囊。 */
  const toggleSource = (src: memApi.MemorySourceKind): void => {
    setSelectedSources((prev) => {
      if (prev.includes(src)) {
        if (prev.length === 1) return prev;
        return prev.filter((item) => item !== src);
      }
      return [...prev, src];
    });
  };

  /** 展开查看 Rust 原文段落。 */
  const togglePassage = async (ref: string): Promise<void> => {
    if (expandedRef === ref) {
      setExpandedRef(undefined);
      return;
    }
    setExpandedRef(ref);
    if (!ref.startsWith('/api/memory-graph/passage/') || passageCache[ref] !== undefined) {
      return;
    }
    try {
      const detail = await memApi.fetchPassageByRef(ref);
      setPassageCache((prev) => ({ ...prev, [ref]: detail }));
    } catch (error) {
      onError(error);
    }
  };

  /** 一键把检索命中的片段沉淀为结构化知识库文档。 */
  const promoteHitToKnowledge = async (hit: memApi.MemoryUnifiedHit): Promise<void> => {
    const defaultTitle = hit.title.trim() !== '' ? hit.title.trim() : `记忆摘录 ${hit.id}`;
    const nextTitle = await kbDialog.prompt({
      title: '沉淀为知识库文档',
      message: '将该条记忆命中保存为结构化知识库文档（自动支持 [[双链]] 与标签治理）：',
      initialValue: defaultTitle,
      placeholder: '输入知识文档标题…',
      confirmText: '保存并打开',
    });
    if (nextTitle === null) return;

    const fullPassage = passageCache[hit.ref]?.passage?.text ?? hit.snippet;
    const provenance = hit.file || hit.origin || hit.ref;
    const contentLines = [
      fullPassage,
      '',
      '---',
      `> 来源：\`${hit.source}\` · ${provenance}`,
    ];
    try {
      const created = await kbApi.createDoc({
        title: nextTitle,
        content: contentLines.join('\n'),
        sourcePath: provenance,
        sourceType: 'note',
        tags: ['记忆沉淀'],
      });
      onNotice(`已沉淀为知识文档「${created.title}」`);
      onSavedToKnowledge(created.id);
    } catch (error) {
      onError(error);
    }
  };

  /** 刷新索引或重抽失败关系图。 */
  const triggerReindex = async (retryGraph: boolean): Promise<void> => {
    setReindexing(true);
    try {
      const res = await memApi.reindexMemory(retryGraph);
      setOverview((prev) => {
        if (prev === undefined) return prev;
        return { ...prev, health: res.health, backend: res.backend };
      });
      if (res.syncError !== undefined) {
        onNotice(`索引同步提示：${res.syncError}`);
      } else if (retryGraph && res.graphRetry !== undefined) {
        if (res.graphRetry.ok) {
          onNotice(`索引已刷新，已重新排队 ${String(res.graphRetry.retry)} 条失败图谱记录`);
        } else {
          onNotice(`知识索引已刷新；图谱重抽提示：${res.graphRetry.error ?? '未知原因'}`);
        }
      } else {
        onNotice('知识库与记忆切片索引刷新完成');
      }
    } catch (error) {
      onError(error);
    } finally {
      setReindexing(false);
    }
  };

  /** 打开一条长期记忆全文以便查阅或编辑。 */
  const openMemoryItem = async (summary: memApi.MemoryItemSummary): Promise<void> => {
    try {
      const detail = await memApi.getMemoryItemDetail(summary.scope, summary.bot, summary.path);
      setEditingItem({
        isNew: false,
        scope: detail.scope,
        bot: detail.bot,
        path: detail.path,
        content: detail.content,
      });
    } catch (error) {
      onError(error);
    }
  };

  /** 开始新增长期记忆条。 */
  const startNewMemoryItem = (): void => {
    let defaultScope: memApi.MemoryItemScope = 'card';
    if (itemScopeFilter === 'knowledge') {
      defaultScope = 'knowledge';
    }
    setEditingItem({
      isNew: true,
      scope: defaultScope,
      bot: itemBotFilter,
      path: '新建记忆.md',
      content: '# 记忆标题\n\n在这里记录长期事实、业务口径或偏好…\n',
    });
  };

  /** 保存长期记忆条。 */
  const saveCurrentItem = async (): Promise<void> => {
    if (editingItem === undefined) return;

    const trimmedPath = editingItem.path.trim();
    if (trimmedPath === '') {
      onNotice('请填写相对文件名（以 .md 或 .txt 结尾）');
      return;
    }
    setItemSaving(true);
    try {
      const res = await memApi.saveMemoryItem({
        scope: editingItem.scope,
        bot: editingItem.bot,
        path: trimmedPath,
        content: editingItem.content,
      });
      if (res.indexWarning !== undefined) {
        onNotice(`文件已保存（向量同步提示：${res.indexWarning}）`);
      } else {
        onNotice('长期记忆条已保存');
      }
      setEditingItem((prev) => (prev === undefined ? undefined : { ...prev, isNew: false, path: trimmedPath }));
      await loadItems();
      void loadOverview();
    } catch (error) {
      onError(error);
    } finally {
      setItemSaving(false);
    }
  };

  /** 删除长期记忆条（应用内确认框）。 */
  const deleteCurrentItem = async (target: { scope: memApi.MemoryItemScope; bot: string; path: string }): Promise<void> => {
    const ok = await kbDialog.confirm({
      title: `删除长期记忆条「${target.path}」`,
      message: '删除后磁盘文件与对应记忆索引片段将被移除，确定继续吗？',
      confirmText: '确认删除',
      danger: true,
    });
    if (!ok) return;

    try {
      await memApi.deleteMemoryItem(target);
      onNotice(`已删除「${target.path}」`);
      if (
        editingItem !== undefined
        && editingItem.scope === target.scope
        && editingItem.bot === target.bot
        && editingItem.path === target.path
      ) {
        setEditingItem(undefined);
      }
      await loadItems();
      void loadOverview();
    } catch (error) {
      onError(error);
    }
  };

  /** 保存 VGR 与本地嵌入模型配置到 memory.yaml。 */
  const submitVgrConfig = async (event: react.FormEvent): Promise<void> => {
    event.preventDefault();
    setSavingConfig(true);
    try {
      const patch: memApi.VgrConfigPatch = {
        modelDir: cfgModelDir.trim(),
        onnxruntime: cfgOnnx.trim(),
        storeDir: cfgStoreDir.trim(),
        retrieval: {
          graph: cfgGraphOn,
          defaultMode: cfgDefaultMode,
          rerank: cfgRerankOn,
          finalTopK: cfgFinalTopK,
          entityTopK: cfgEntityTopK,
          relationTopK: cfgRelationTopK,
          expansionDegree: cfgExpansionDegree,
        },
        llm: {
          baseUrl: cfgLlmBaseUrl.trim(),
          model: cfgLlmModel.trim(),
          extractModel: cfgExtractModel.trim(),
          extractConcurrency: cfgExtractConcurrency,
        },
      };
      if (cfgLlmApiKey.trim() !== '' && patch.llm !== undefined) {
        patch.llm.apiKey = cfgLlmApiKey.trim();
      }
      const next = await memApi.saveVgrConfig(patch);
      setOverview(next);
      hydrateConfigForm(next.config);
      onNotice(next.restartHint ?? 'VGR 与本地嵌入模型配置已保存');
    } catch (error) {
      onError(error);
    } finally {
      setSavingConfig(false);
    }
  };

  const health = overview?.health;
  const counts = health?.counts;
  const emb = health?.embedding;
  const rustOnline = health?.ok === true;
  const embReady = emb?.ready === true;
  const graphHref = token.withToken('/graph/?knowledge=1', token.TOKEN);

  return (
    <section className="kb-vgr-workspace" aria-label="记忆与 VGR 向量管理中心">
      {/* 顶部实时引擎与本地嵌入状态仪表带 */}
      <div className="kb-vgr-telemetry">
        <div className="kb-vgr-stat-card">
          <div className="kb-vgr-stat-top">
            <span className="kb-status-dot" data-ok={rustOnline} />
            <span className="kb-vgr-stat-label">VGR 记忆引擎 (Rust)</span>
          </div>
          <div className="kb-vgr-stat-main">
            {overviewLoading && '正在探活…'}
            {!overviewLoading && rustOnline && `在线 · v${health?.version ?? '0.1'}`}
            {!overviewLoading && !rustOnline && '未在线（降级走本地检索）'}
          </div>
          <div className="kb-vgr-stat-sub kb-muted kb-small">
            {overview?.serviceUrl ?? '127.0.0.1:30087'}
            {health?.ms !== undefined && ` · ${String(health.ms)}ms`}
            {health?.rssMb !== undefined && ` · ${String(health.rssMb)} MB`}
          </div>
        </div>

        <div className="kb-vgr-stat-card">
          <div className="kb-vgr-stat-top">
            <span className="kb-status-dot" data-ok={embReady} />
            <span className="kb-vgr-stat-label">本地嵌入模型 (ONNX)</span>
          </div>
          <div className="kb-vgr-stat-main">
            {embReady ? `${emb?.model ?? 'bge-m3'} · ${String(emb?.dim ?? 1024)} 维` : '模型未就绪'}
          </div>
          <div className="kb-vgr-stat-sub kb-muted kb-small" title={overview?.config.modelDirResolved}>
            路径：{overview?.config.modelDir ?? 'program/models/bge-m3-int8'}
          </div>
        </div>

        <div className="kb-vgr-stat-card">
          <div className="kb-vgr-stat-top">
            <span className="kb-vgr-stat-label">向量与知识切片规模</span>
          </div>
          <div className="kb-vgr-stat-main">
            已向量化 {counts?.embedded ?? 0} / {counts?.docs ?? 0} 段
          </div>
          <div className="kb-vgr-stat-sub kb-muted kb-small">
            知识段 {counts?.knowledge ?? 0} · 对话段 {counts?.history ?? 0} · 实体 {counts?.entities ?? 0} · 关系 {counts?.relations ?? 0}
          </div>
        </div>

        <div className="kb-vgr-stat-card">
          <div className="kb-vgr-stat-top">
            <span className="kb-vgr-stat-label">关系图三元组抽取 & 索引</span>
          </div>
          <div className="kb-vgr-stat-main">
            完成 {counts?.graphDone ?? 0} · 待抽 {counts?.graphPending ?? 0} · 失败 {counts?.graphFailed ?? 0}
          </div>
          <div className="kb-vgr-stat-actions">
            {!readOnly && overview?.legacyFallback !== true && (
              <>
                <button
                  type="button"
                  className="kb-link-btn kb-small"
                  disabled={reindexing}
                  onClick={() => void triggerReindex(false)}
                >
                  {reindexing ? '处理中…' : '🔄 刷新知识索引'}
                </button>
                <button
                  type="button"
                  className="kb-link-btn kb-small"
                  disabled={reindexing}
                  onClick={() => void triggerReindex(true)}
                >
                  ⚡ 重抽失败图谱
                </button>
              </>
            )}
            <a className="kb-link-btn kb-small" href={graphHref} target="_blank" rel="noreferrer">
              🕸️ 实体图谱页 ↗
            </a>
          </div>
        </div>
      </div>

      {overview?.legacyFallback === true && (
        <p className="kb-notice">
          提示：当前 30086 服务尚未重启加载新增的 VGR 配置与条目写接口，现已平滑连接现有检索与引擎探活接口；重启服务后即可在线读写 memory.yaml 与长期记忆文件。
        </p>
      )}

      {/* 子工作台切换栏 */}
      <div className="kb-vgr-subbar">
        <div className="kb-modes" role="tablist" aria-label="记忆与 VGR 功能切换">
          <button
            type="button"
            data-active={subTab === 'search'}
            onClick={() => setSubTab('search')}
          >
            🔎 混合检索 (keyword / vector / graph)
          </button>
          <button
            type="button"
            data-active={subTab === 'items'}
            onClick={() => setSubTab('items')}
          >
            🗂️ 长期记忆条管理
          </button>
          <button
            type="button"
            data-active={subTab === 'config'}
            onClick={() => setSubTab('config')}
          >
            ⚙️ 本地嵌入模型与 VGR 配置
          </button>
        </div>
      </div>

      {/* 子面板 1：混合检索工作台 */}
      {subTab === 'search' && (
        <div className="kb-vgr-panel">
          <form className="kb-vgr-search-box" onSubmit={(e) => void runSearch(e)}>
            <div className="kb-vgr-search-row">
              <input
                type="search"
                className="kb-vgr-query-input"
                value={searchInput}
                placeholder="输入问题、业务事实或关键词，实时验证 VGR 关键词 + 向量 + 关系图混合召回…"
                onChange={(event) => setSearchInput(event.target.value)}
              />
              <button type="submit" className="kb-primary-btn" disabled={searching}>
                {searching ? '正在检索…' : '混合检索'}
              </button>
            </div>

            <div className="kb-vgr-filter-row">
              <span className="kb-muted kb-small">检索模式：</span>
              <div className="kb-modes" role="radiogroup" aria-label="检索模式">
                {MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    data-active={searchMode === opt.value}
                    title={opt.tip}
                    onClick={() => setSearchMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <span className="kb-muted kb-small kb-vgr-gap-left">数据来源：</span>
              <div className="kb-vgr-source-pills">
                {ALL_SOURCES.map((src) => {
                  const active = selectedSources.includes(src);
                  return (
                    <button
                      key={src}
                      type="button"
                      className="kb-pill-toggle"
                      data-active={active}
                      onClick={() => toggleSource(src)}
                    >
                      {SOURCE_LABELS[src]}
                    </button>
                  );
                })}
              </div>
            </div>
          </form>

          {searchError !== undefined && <p className="kb-error">{searchError}</p>}

          {searchRes === undefined && !searching && searchError === undefined && (
            <div className="kb-empty kb-center">
              输入任意问题或关键词测试四路融合检索，每条结果都会直观标出 <code>keyword</code> / <code>vector</code> / <code>graph</code> 命中来源
            </div>
          )}

          {searchRes !== undefined && (
            <div className="kb-vgr-results">
              <div className="kb-vgr-meta-bar kb-muted kb-small">
                <span>共命中 {searchRes.hits.length} 条</span>
                <span>·</span>
                <span>模式：{searchRes.mode}</span>
                <span>·</span>
                <span>耗时 {searchRes.total_ms} ms</span>
                {searchRes.unavailable.length > 0 && (
                  <span className="kb-warn-inline">· 未响应来源：{searchRes.unavailable.join('、')}</span>
                )}
                {(searchRes.warnings ?? []).length > 0 && (
                  <span className="kb-warn-inline">· {searchRes.warnings!.join('；')}</span>
                )}
              </div>

              {((searchRes.queryEntities?.length ?? 0) > 0 || (searchRes.relations?.length ?? 0) > 0) && (
                <div className="kb-vgr-graph-evidence">
                  {(searchRes.queryEntities?.length ?? 0) > 0 && (
                    <div className="kb-vgr-entities-row">
                      <span className="kb-muted kb-small">识别实体：</span>
                      {searchRes.queryEntities!.map((ent) => (
                        <span key={ent} className="kb-chip">{ent}</span>
                      ))}
                    </div>
                  )}
                  {(searchRes.relations?.length ?? 0) > 0 && (
                    <div className="kb-vgr-triples-row">
                      <span className="kb-muted kb-small">命中图谱三元组：</span>
                      <div className="kb-vgr-triples-list">
                        {searchRes.relations!.slice(0, 8).map((rel) => (
                          <span key={rel} className="kb-triple-pill">🕸️ {rel}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {searchRes.hits.length === 0 && (
                <p className="kb-empty kb-center">未找到匹配的记忆或知识片段</p>
              )}

              <div className="kb-vgr-hit-list">
                {searchRes.hits.map((hit) => {
                  const isPassage = hit.ref.startsWith('/api/memory-graph/passage/');
                  const isExpanded = expandedRef === hit.ref;
                  const cachedPassage = passageCache[hit.ref];
                  let provenanceText = hit.origin || hit.ref;
                  if (hit.file !== undefined && hit.file !== '') {
                    provenanceText = hit.file;
                    if (hit.where !== undefined && hit.where !== '') {
                      provenanceText = `${hit.file} · ${hit.where}`;
                    }
                  }
                  return (
                    <article key={`${hit.source}:${hit.id}`} className="kb-vgr-hit-card">
                      <header className="kb-vgr-hit-head">
                        <span className="kb-source-tag" data-source={hit.source}>
                          {SOURCE_LABELS[hit.source] ?? hit.source}
                        </span>
                        <strong className="kb-vgr-hit-title">{hit.title || hit.id}</strong>
                        {renderViaBadges(hit.via)}
                        <span className="kb-grow" />
                        <span className="kb-vgr-score" title="RRF 归一化综合得分">
                          得分 {(hit.score * 100).toFixed(1)}%
                        </span>
                        {hit.at > 0 && (
                          <span className="kb-muted kb-small">{docList.getShortTime(hit.at)}</span>
                        )}
                      </header>

                      <p className="kb-vgr-hit-snippet">{hit.snippet}</p>

                      {(hit.relations?.length ?? 0) > 0 && (
                        <div className="kb-vgr-hit-rels">
                          {hit.relations!.slice(0, 4).map((rel) => (
                            <span key={rel} className="kb-triple-pill">🔗 {rel}</span>
                          ))}
                        </div>
                      )}

                      <footer className="kb-vgr-hit-foot">
                        <span className="kb-muted kb-small kb-vgr-provenance">
                          {provenanceText}
                        </span>
                        <span className="kb-grow" />
                        {isPassage && (
                          <button
                            type="button"
                            className="kb-link-btn kb-small"
                            onClick={() => void togglePassage(hit.ref)}
                          >
                            {isExpanded ? '收起原文' : '查看完整段落'}
                          </button>
                        )}
                        {!readOnly && (
                          <button
                            type="button"
                            className="kb-link-btn kb-small"
                            onClick={() => void promoteHitToKnowledge(hit)}
                          >
                            📥 沉淀入知识库
                          </button>
                        )}
                      </footer>

                      {isExpanded && (
                        <div className="kb-vgr-passage-box">
                          {cachedPassage === undefined ? (
                            <p className="kb-muted kb-small">正在读取段落原文…</p>
                          ) : (
                            <pre className="kb-vgr-passage-pre">
                              {cachedPassage.passage?.text ?? '（无原文内容）'}
                            </pre>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 子面板 2：长期记忆条管理 */}
      {subTab === 'items' && (
        <div className="kb-vgr-items-split">
          <aside className="kb-vgr-items-side">
            <div className="kb-vgr-items-bar">
              <select
                className="kb-vgr-select"
                value={itemScopeFilter}
                aria-label="长期记忆分类过滤"
                onChange={(e) => setItemScopeFilter(e.target.value as 'all' | memApi.MemoryItemScope)}
              >
                <option value="all">全部长期记忆</option>
                <option value="card">记忆卡片 (memory/)</option>
                <option value="knowledge">独立知识切片 (knowledge/)</option>
              </select>

              <select
                className="kb-vgr-select"
                value={itemBotFilter}
                aria-label="归属机器人过滤"
                onChange={(e) => setItemBotFilter(e.target.value)}
              >
                <option value="">公共 + 全部机器人</option>
                {bots.map((botName) => (
                  <option key={botName} value={botName}>机器人：{botName}</option>
                ))}
              </select>

              {!readOnly && (
                <button type="button" className="kb-primary-btn kb-small" onClick={startNewMemoryItem}>
                  ＋ 新增
                </button>
              )}
            </div>

            {itemsLegacy && (
              <p className="kb-muted kb-small kb-pad">
                提示：重启服务后即可在此浏览和管理全部 memory/ 卡片与独立知识切片；当前仍可新增公共知识切片。
              </p>
            )}
            {itemsLoading && <p className="kb-muted kb-center">正在扫描记忆文件…</p>}
            {!itemsLoading && !itemsLegacy && items.length === 0 && (
              <p className="kb-empty kb-center">暂无长期记忆文件，点右上角「＋ 新增」创建</p>
            )}

            <div className="kb-vgr-item-list">
              {items.map((item) => {
                const key = `${item.scope}:${item.bot}:${item.path}`;
                const isSelected = editingItem !== undefined
                  && !editingItem.isNew
                  && editingItem.scope === item.scope
                  && editingItem.bot === item.bot
                  && editingItem.path === item.path;
                return (
                  <div
                    key={key}
                    className="kb-vgr-item-card"
                    data-active={isSelected}
                    onClick={() => void openMemoryItem(item)}
                  >
                    <div className="kb-vgr-item-row">
                      <span className="kb-source-tag" data-source={item.scope}>
                        {item.scope === 'card' ? '卡片' : '切片'}
                      </span>
                      {item.bot !== '' && <span className="kb-chip">{item.bot}</span>}
                      <strong className="kb-vgr-item-title">{item.title}</strong>
                    </div>
                    <div className="kb-muted kb-small kb-vgr-item-path">{item.path}</div>
                    {item.preview !== '' && (
                      <p className="kb-vgr-item-preview">{item.preview}</p>
                    )}
                    <div className="kb-vgr-item-meta kb-muted kb-small">
                      <span>{formatBytes(item.size)}</span>
                      <span>·</span>
                      <span>{docList.getShortTime(item.updatedAt)}</span>
                      {!readOnly && (
                        <>
                          <span className="kb-grow" />
                          <button
                            type="button"
                            className="kb-link-btn kb-tag-delete kb-small"
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteCurrentItem(item);
                            }}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>

          <main className="kb-vgr-item-editor">
            {editingItem === undefined && (
              <p className="kb-empty kb-center">在左侧选择一条长期记忆查看/编辑，或点击「＋ 新增」创建</p>
            )}
            {editingItem !== undefined && (
              <div className="kb-vgr-editor-form">
                <div className="kb-vgr-editor-head">
                  <select
                    className="kb-vgr-select"
                    disabled={!editingItem.isNew || readOnly}
                    value={editingItem.scope}
                    onChange={(e) => setEditingItem({
                      ...editingItem,
                      scope: e.target.value as memApi.MemoryItemScope,
                    })}
                  >
                    <option value="card">记忆卡片 (memory/)</option>
                    <option value="knowledge">独立知识切片 (knowledge/)</option>
                  </select>

                  <select
                    className="kb-vgr-select"
                    disabled={!editingItem.isNew || readOnly}
                    value={editingItem.bot}
                    onChange={(e) => setEditingItem({ ...editingItem, bot: e.target.value })}
                  >
                    <option value="">公共共享</option>
                    {bots.map((botName) => (
                      <option key={botName} value={botName}>机器人：{botName}</option>
                    ))}
                  </select>

                  <input
                    type="text"
                    className="kb-vgr-path-input"
                    disabled={!editingItem.isNew || readOnly}
                    value={editingItem.path}
                    placeholder="相对路径，如 偏好/日常习惯.md"
                    onChange={(e) => setEditingItem({ ...editingItem, path: e.target.value })}
                  />

                  <span className="kb-grow" />

                  {!editingItem.isNew && !readOnly && (
                    <button
                      type="button"
                      className="kb-danger-btn"
                      onClick={() => void deleteCurrentItem(editingItem)}
                    >
                      删除
                    </button>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      className="kb-primary-btn"
                      disabled={itemSaving}
                      onClick={() => void saveCurrentItem()}
                    >
                      {itemSaving ? '正在保存…' : '保存记忆条'}
                    </button>
                  )}
                </div>

                <textarea
                  className="kb-vgr-textarea"
                  readOnly={readOnly}
                  value={editingItem.content}
                  placeholder="输入 Markdown 或纯文本长期记忆内容…"
                  onChange={(e) => setEditingItem({ ...editingItem, content: e.target.value })}
                />
              </div>
            )}
          </main>
        </div>
      )}

      {/* 子面板 3：本地嵌入模型与 VGR 配置 (memory.yaml) */}
      {subTab === 'config' && (
        <div className="kb-vgr-panel">
          <form className="kb-vgr-config-form" onSubmit={(e) => void submitVgrConfig(e)}>
            <div className="kb-vgr-config-card">
              <div className="kb-vgr-card-head">
                <h4>1. 本地嵌入模型与向量存储路径</h4>
                <span className="kb-muted kb-small">配置文件：{overview?.filePath ?? 'memory.yaml'}</span>
              </div>

              <div className="kb-vgr-field-grid">
                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">
                    本地嵌入模型目录 (<code>model_dir</code>)
                    <span className="kb-path-badge" data-ok={overview?.config.modelDirExists}>
                      {overview?.config.modelDirExists ? '✅ 磁盘已就绪' : '⚠️ 目录未找到'}
                    </span>
                  </span>
                  <input
                    type="text"
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgModelDir}
                    placeholder="program/models/bge-m3-int8"
                    onChange={(e) => setCfgModelDir(e.target.value)}
                  />
                  <span className="kb-muted kb-small">
                    实际解析路径：{overview?.config.modelDirResolved ?? '-'}（需含 model.onnx 与 tokenizer.json）
                  </span>
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">
                    ONNX Runtime 动态库路径 (<code>onnxruntime</code>)
                    <span className="kb-path-badge" data-ok={overview?.config.onnxruntimeExists}>
                      {overview?.config.onnxruntimeExists ? '✅ 动态库已就绪' : '⚠️ 文件未找到'}
                    </span>
                  </span>
                  <input
                    type="text"
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgOnnx}
                    placeholder="program/onnxruntime/lib/onnxruntime.dll"
                    onChange={(e) => setCfgOnnx(e.target.value)}
                  />
                  <span className="kb-muted kb-small">
                    实际解析路径：{overview?.config.onnxruntimeResolved ?? '-'}
                  </span>
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">
                    VGR 向量与关系图库目录 (<code>store_dir</code>)
                    <span className="kb-path-badge" data-ok={overview?.config.storeDirExists}>
                      {overview?.config.storeDirExists ? '✅ 已创建' : '首次启动自动创建'}
                    </span>
                  </span>
                  <input
                    type="text"
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgStoreDir}
                    placeholder="data/memory"
                    onChange={(e) => setCfgStoreDir(e.target.value)}
                  />
                  <span className="kb-muted kb-small">
                    实际解析路径：{overview?.config.storeDirResolved ?? '-'}
                  </span>
                </label>
              </div>
            </div>

            <div className="kb-vgr-config-card">
              <div className="kb-vgr-card-head">
                <h4>2. VGR 混合检索与图谱重排策略 (<code>retrieval</code>)</h4>
              </div>

              <div className="kb-vgr-row-grid">
                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">默认检索模式 (<code>default_mode</code>)</span>
                  <select
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgDefaultMode}
                    onChange={(e) => setCfgDefaultMode(e.target.value as 'hybrid' | 'graph')}
                  >
                    <option value="hybrid">hybrid（关键词 + 本地向量 RRF 融合）</option>
                    <option value="graph">graph（叠加实体多跳图谱与重排）</option>
                  </select>
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">最终返回条数 (<code>final_top_k</code>)</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgFinalTopK}
                    onChange={(e) => setCfgFinalTopK(Math.max(1, Number(e.target.value) || 20))}
                  />
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">实体召回上限 (<code>entity_top_k</code>)</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgEntityTopK}
                    onChange={(e) => setCfgEntityTopK(Math.max(1, Number(e.target.value) || 10))}
                  />
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">关系召回上限 (<code>relation_top_k</code>)</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgRelationTopK}
                    onChange={(e) => setCfgRelationTopK(Math.max(1, Number(e.target.value) || 10))}
                  />
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">图谱多跳展开度数 (<code>expansion_degree</code>)</span>
                  <input
                    type="number"
                    min={1}
                    max={4}
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgExpansionDegree}
                    onChange={(e) => setCfgExpansionDegree(Math.min(4, Math.max(1, Number(e.target.value) || 2)))}
                  />
                </label>
              </div>

              <div className="kb-vgr-switches">
                <label className="kb-check">
                  <input
                    type="checkbox"
                    disabled={readOnly || overview?.legacyFallback === true}
                    checked={cfgGraphOn}
                    onChange={(e) => setCfgGraphOn(e.target.checked)}
                  />
                  <span>启用后台关系图三元组抽取与图谱检索 (<code>retrieval.graph</code>)</span>
                </label>
                <label className="kb-check">
                  <input
                    type="checkbox"
                    disabled={readOnly || overview?.legacyFallback === true}
                    checked={cfgRerankOn}
                    onChange={(e) => setCfgRerankOn(e.target.checked)}
                  />
                  <span>启用大模型相关性精排 (<code>retrieval.rerank</code>)</span>
                </label>
              </div>
            </div>

            <div className="kb-vgr-config-card">
              <div className="kb-vgr-card-head">
                <h4>3. 图谱三元组抽取与重排模型 (<code>llm</code>)</h4>
                <span className="kb-muted kb-small">
                  {overview?.config.llm.hasApiKey ? '🔒 API 密钥已配置（安全脱敏，不回显明文）' : '未单独配置密钥'}
                </span>
              </div>

              <div className="kb-vgr-row-grid">
                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">OpenAI 兼容接口地址 (<code>base_url</code>)</span>
                  <input
                    type="text"
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgLlmBaseUrl}
                    placeholder="https://api.openai.com/v1"
                    onChange={(e) => setCfgLlmBaseUrl(e.target.value)}
                  />
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">更新 API Key（留空保持原密钥不变）</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgLlmApiKey}
                    placeholder={overview?.config.llm.hasApiKey ? '••••••••（留空不修改已有密钥）' : '输入新 API Key…'}
                    onChange={(e) => setCfgLlmApiKey(e.target.value)}
                  />
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">查询实体与重排模型 (<code>model</code>)</span>
                  <input
                    type="text"
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgLlmModel}
                    placeholder="例如 deepseek-chat"
                    onChange={(e) => setCfgLlmModel(e.target.value)}
                  />
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">后台三元组抽取模型 (<code>extract_model</code>)</span>
                  <input
                    type="text"
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgExtractModel}
                    placeholder="留空则共用 model"
                    onChange={(e) => setCfgExtractModel(e.target.value)}
                  />
                </label>

                <label className="kb-vgr-field">
                  <span className="kb-vgr-field-title">抽取并发数 (<code>extract_concurrency</code>)</span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    disabled={readOnly || overview?.legacyFallback === true}
                    value={cfgExtractConcurrency}
                    onChange={(e) => setCfgExtractConcurrency(Math.min(16, Math.max(1, Number(e.target.value) || 2)))}
                  />
                </label>
              </div>
            </div>

            {!readOnly && overview?.legacyFallback !== true && (
              <div className="kb-vgr-config-foot">
                <button type="submit" className="kb-primary-btn" disabled={savingConfig}>
                  {savingConfig ? '正在写入 memory.yaml…' : '💾 保存配置到 memory.yaml'}
                </button>
                <span className="kb-muted kb-small">
                  保存时自动保留原文件注释及未修改的 API Key；改动嵌入模型路径后重启 jmbots-memory 生效。
                </span>
              </div>
            )}
          </form>
        </div>
      )}

      {kbDialog.modalElement}
    </section>
  );
}
