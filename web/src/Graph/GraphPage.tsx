/**
 * 记忆关系图谱页（/graph/，memory-graph 插件托管）：选客户看整张关系网；输入问题走记忆检索，命中的关系高亮，
 * 右栏是命中路径（关系连成链）和命中原文；点点看关联原文，点线看关系出自哪段；双击点展开邻居。
 * 网址参数：customer、bot、q（有就先检索）、mode（hybrid | graph）、token。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as virtuoso from 'react-virtuoso';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
import * as api from '../Api.ts';
import { TOKEN, withToken } from '../Token.ts';
import { Guide } from '../Guide/Guide.tsx';
import { GRAPH_STEPS } from '../Guide/steps-graph.ts';
import { COLORS, GraphCanvas } from './GraphCanvas.tsx';
import { get, type Customer, type Doc, type Graph, type GraphEdge } from './GraphApi.ts';
import * as saveToKnowledge from '../components/SaveToKnowledge.tsx';

const PARAMS = new URLSearchParams(window.location.search);
//M 从网址查询参数读取可选机器人名，供后续图谱与检索请求透传限定范围。
const BOT = PARAMS.get('bot') ?? '';
const EMPTY: Graph = { nodes: [], edges: [], total: { nodes: 0, edges: 0 } };
const VIA: Record<string, string> = { keyword: '关键词', vector: '向量', graph: '关系图' };

/** 右栏在看什么。 */
type Side =
  | { type: 'summary' }
  | { type: 'node'; name: string; relations: { id: number; text: string }[]; docs: Doc[] }
  | { type: 'edge'; subject: string; object: string; label: string; text: string; docs: Doc[] }
  | { type: 'doc'; doc: Doc; relations: { id: number; text: string }[] };

/**
 * 实体存进知识库时的正文：实体名、已加载的关系、关联原文标题，写成 Markdown。
 * @param name 实体名。
 * @param relations 右栏已经拉到的关系。
 * @param docs 右栏已经拉到的关联原文。
 */
function getEntityMarkdown(name: string, relations: { id: number; text: string }[], docs: Doc[]): string {
  const lines = [`# ${name}`, ''];
  if (relations.length > 0) {
    lines.push(`## 关系（${String(relations.length)}）`, '');
    for (const relation of relations) {
      lines.push(`- ${relation.text}`);
    }
    lines.push('');
  }
  if (docs.length > 0) {
    lines.push(`## 关联原文（${String(docs.length)}）`, '');
    for (const doc of docs) {
      lines.push(`- #${String(doc.id)} ${doc.title}`);
    }
  }
  return lines.join('\n').trim();
}

/** 判断异常是否由 AbortController 主动取消触发。 */
function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;

  return false;
}

/** 命中的边首尾相接连成链（最长的在前）。 */
function getChains(graph: Graph, hit: number[]): GraphEdge[][] {
  const edges = graph.edges.filter((e) => hit.includes(e.id));
  const used = new Set<number>();
  const out: GraphEdge[][] = [];
  for (const edge of edges) {
    if (used.has(edge.id)) continue;

    const path = [edge];
    used.add(edge.id);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of edges) {
        if (used.has(f.id)) continue;
        if (f.source === path[path.length - 1]!.target) {
          path.push(f);
          used.add(f.id);
          grew = true;
          continue;
        }
        if (f.target === path[0]!.source) {
          path.unshift(f);
          used.add(f.id);
          grew = true;
        }
      }
    }
    out.push(path);
  }
  return out.sort((a, b) => b.length - a.length);
}

function DocView({ doc }: { doc: Doc }) {
  //M 订阅全局演示打码开关，确保原文标题、客户来源与正文展示前统一脱敏。
  const mask = privacy.useMask();
  const extraFile = (doc as Doc & { file?: unknown }).file;
  let filePath = '';
  if (typeof extraFile === 'string') {
    filePath = extraFile;
  }
  let tag = '';
  if (doc.customer) {
    tag = ` · ${privacy.text(doc.customer, mask)}`;
  }
  if (!doc.customer && doc.scope === 'knowledge') {
    tag = ' · 知识库';
  }

  //M 渲染单条关联原文卡片：标题、非打码态 VS Code 打开链接与脱敏后的正文。
  return (
    <div className="mg-doc">
      <div className="t" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>#{doc.id} · {privacy.text(doc.title, mask)}{tag}</span>
        {!mask && filePath !== '' && <vscodeLink.VsCodeOpen site={filePath} />}
      </div>
      {privacy.text(doc.text, mask)}
    </div>
  );
}

/**
 * 记忆关系图谱页面主组件：管理客户切换、检索模式（混合或图谱重排）、知识库开关与右侧详情栏，
 * 内置 AbortController + 递增代次号（requestSeq）与在途请求去重，杜绝切换范围时的旧结果乱序覆盖或重复拉取。
 */
export function GraphPage() {
  //M 演示打码默认关；开着时顶部有提示条，下面 paddingTop/top 才让位。
  const mask = privacy.useMask();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState(PARAMS.get('customer') ?? '');
  //M 默认使用混合检索；仅当网址显式指定 mode=graph 时切换到图谱+大模型重排。
  let initialMode = 'hybrid';
  if (PARAMS.get('mode') === 'graph') {
    initialMode = 'graph';
  }

  //M 初始化当前检索模式与地址栏带来的初始问句状态。
  const [mode, setMode] = useState(initialMode);
  const [query, setQuery] = useState(PARAMS.get('q') ?? '');
  const [knowledge, setKnowledge] = useState(() => (PARAMS.get('customer') ?? '') === '');
  const [graph, setGraph] = useState<Graph>(EMPTY);
  const [hitEdges, setHitEdges] = useState<number[]>([]);
  const [hitNodes, setHitNodes] = useState<number[]>([]);
  const [merge, setMerge] = useState(false);
  const [version, setVersion] = useState(0);
  const [found, setFound] = useState<api.MemorySearchResult | null>(null);
  const [side, setSide] = useState<Side>({ type: 'summary' });
  //M 知识库能不能用（顺带拿目录）：页面打开时探一次，不能用就不显示「存入知识库」。
  const kbDirs = saveToKnowledge.useKnowledgeDirs();
  const [sideEl, setSideEl] = useState<HTMLElement | null>(null);
  const [banner, setBanner] = useState('');
  const [ready, setReady] = useState(false);

  //M 主画布请求与右侧详情请求分别维护 AbortController、递增代次号与在途键，防竞态且零重复发包。
  const mainAbortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const inFlightKeyRef = useRef('');
  const bannerTimerRef = useRef(0);
  const sideAbortRef = useRef<AbortController | null>(null);
  const sideSeqRef = useRef(0);

  const clearBannerTimer = useCallback((): void => {
    if (bannerTimerRef.current !== 0) {
      window.clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = 0;
    }
  }, []);

  /** 启动一次新的主图谱请求：中止旧在途请求并递增 requestSeq。 */
  const beginMainRequest = useCallback((dedupKey: string, force: boolean): {
    seq: number;
    signal: AbortSignal;
  } | null => {
    //G 相同范围/检索参数已在途中且非用户强制重刷时直接跳过重复请求。
    if (!force && inFlightKeyRef.current === dedupKey && mainAbortRef.current !== null) {
      return null;
    }
    mainAbortRef.current?.abort();
    //M 主图要换了，右侧在途的详情也作废，免得迟到的 openNode 盖掉新图的 summary（云端 26 次要 #1）。
    sideAbortRef.current?.abort();
    sideSeqRef.current += 1;
    const controller = new AbortController();
    mainAbortRef.current = controller;
    inFlightKeyRef.current = dedupKey;
    requestSeqRef.current += 1;
    clearBannerTimer();
    return { seq: requestSeqRef.current, signal: controller.signal };
  }, [clearBannerTimer]);

  /** 启动一次右侧实体/关系/原文详情请求，切换点击目标时立即取消上一次详情拉取。 */
  const beginSideRequest = useCallback((): { seq: number; signal: AbortSignal } => {
    sideAbortRef.current?.abort();
    const controller = new AbortController();
    sideAbortRef.current = controller;
    sideSeqRef.current += 1;
    return { seq: sideSeqRef.current, signal: controller.signal };
  }, []);

  const getCommonQuery = useCallback((extra = ''): string => {
    let botParam = '';
    if (BOT) {
      botParam = `&bot=${encodeURIComponent(BOT)}`;
    }
    let knowledgeParam = '';
    if (knowledge) {
      knowledgeParam = '&knowledge=1';
    }
    return `customer=${encodeURIComponent(customer)}${botParam}${knowledgeParam}${extra}`;
  }, [customer, knowledge]);

  const show = useCallback((g: Graph, hits: number[], nodes: number[], keep = false): void => {
    setGraph(g);
    setHitEdges(hits);
    setHitNodes(nodes);
    setMerge(keep);
    setVersion((v) => v + 1);
  }, []);

  const loadAll = useCallback(async (force = false): Promise<void> => {
    const queryStr = getCommonQuery('&limit=200');
    const started = beginMainRequest(`graph:${queryStr}`, force);
    if (started === null) return;

    const { seq, signal } = started;
    setBanner('读取整张关系网…');
    setFound(null);
    setSide({ type: 'summary' });
    try {
      //M 拼装当前客户与知识库范围参数，拉取最多 200 个节点的全量关系网并核验请求代次。
      const g = await get<Graph>(`/api/memory-graph/graph?${queryStr}`, signal);
      if (signal.aborted || seq !== requestSeqRef.current) return;

      show(g, [], []);
      let emptyBanner = '';
      if (g.nodes.length === 0) {
        emptyBanner = '这个客户还没有抽出关系（后台抽三元组可能还没跑完）';
      }
      setBanner(emptyBanner);
    } catch (error) {
      if (isAbortError(error, signal) || seq !== requestSeqRef.current) return;

      setBanner(`读取失败：${(error as Error).message}`);
    } finally {
      if (seq === requestSeqRef.current) {
        inFlightKeyRef.current = '';
      }
    }
  }, [beginMainRequest, getCommonQuery, show]);

  const search = useCallback(async (text = query, force = false): Promise<void> => {
    //G 问句为空时直接回退加载整张关系网，不发起空检索。
    const trimmed = text.trim();
    if (!trimmed) {
      await loadAll(force);
      return;
    }

    const params = new URLSearchParams({ q: trimmed, mode, sources: 'knowledge', limit: '8' });
    if (customer !== '') {
      params.set('customer', customer);
      params.set('sources', 'history,knowledge');
    }
    if (BOT !== '') params.set('bot', BOT);

    const started = beginMainRequest(`search:${params.toString()}`, force);
    if (started === null) return;

    const { seq, signal } = started;
    let modeHint = '';
    if (mode === 'graph') {
      modeHint = '（图谱+大模型重排，约 5–10 秒）';
    }
    setBanner(`正在从记忆里检索：${trimmed}${modeHint}`);
    setSide({ type: 'summary' });
    try {
      //M 统一结果有命中子图时高亮，过期响应直接丢弃绝不覆盖新范围。
      const result = await api.memorySearch(params, signal);
      if (signal.aborted || seq !== requestSeqRef.current) return;

      setFound(result);
      const resultGraph = result.graph ?? EMPTY;
      const edges = resultGraph.hitEdges ?? [];
      const nodes = resultGraph.hitNodes ?? [];
      show(resultGraph, edges, nodes);
      let hitBanner = '没有命中关系，右侧是命中的原文';
      if (edges.length > 0) {
        hitBanner = `找到 ${String(edges.length)} 条关系，金色流动的是这次回答用到的路径`;
      }
      if (result.unavailable.length > 0) hitBanner += `。未响应：${result.unavailable.join('、')}`;
      setBanner(hitBanner);
      bannerTimerRef.current = window.setTimeout(() => {
        if (seq === requestSeqRef.current) setBanner('');
      }, 6000);
      window.dispatchEvent(new Event('jmbots-guide-searched'));
    } catch (error) {
      if (isAbortError(error, signal) || seq !== requestSeqRef.current) return;

      setBanner(`检索失败：${(error as Error).message}`);
      window.dispatchEvent(new Event('jmbots-guide-searched'));
    } finally {
      if (seq === requestSeqRef.current) {
        inFlightKeyRef.current = '';
      }
    }
  }, [beginMainRequest, customer, loadAll, mode, query, show]);

  const expand = async (name: string): Promise<void> => {
    const queryStr = `${getCommonQuery('&knowledge=1&limit=120')}&focus=${encodeURIComponent(name)}`;
    const started = beginMainRequest(`expand:${queryStr}`, true);
    if (started === null) return;

    const { seq, signal } = started;
    //M 以双击节点为焦点拉取最多 120 个关联邻居，以增量 merge 模式并入当前画布并保留原高亮。
    setBanner(`展开：${name}`);
    try {
      const g = await get<Graph>(`/api/memory-graph/graph?${queryStr}`, signal);
      if (signal.aborted || seq !== requestSeqRef.current) return;

      show(g, hitEdges, hitNodes, true);
      setBanner('');
    } catch (error) {
      if (isAbortError(error, signal) || seq !== requestSeqRef.current) return;

      setBanner(`展开失败：${(error as Error).message}`);
    } finally {
      if (seq === requestSeqRef.current) {
        inFlightKeyRef.current = '';
      }
    }
  };

  const openNode = async (id: number): Promise<void> => {
    const { seq, signal } = beginSideRequest();
    try {
      //M 点选节点时拉取该实体的全部关系与关联原文，切到右侧实体详情栏展示。
      const url = `/api/memory-graph/entity/${String(id)}`;
      const j = await get<{
        entity: { name: string } | null;
        relations: { id: number; text: string }[];
        docs: Doc[];
      }>(url, signal);
      if (signal.aborted || seq !== sideSeqRef.current) return;

      setSide({ type: 'node', name: j.entity?.name ?? '', relations: j.relations, docs: j.docs });
    } catch (error) {
      if (isAbortError(error, signal)) return;
    }
  };

  const openEdge = async (id: number): Promise<void> => {
    const { seq, signal } = beginSideRequest();
    try {
      //M 点选关系边或路径连线时拉取该三元组原句与来源段落，切到右侧关系详情栏展示。
      const url = `/api/memory-graph/edge/${String(id)}`;
      const j = await get<{
        relation: { subject: string; object: string; label: string; text: string } | null;
        docs: Doc[];
      }>(url, signal);
      if (signal.aborted || seq !== sideSeqRef.current) return;
      if (j.relation) setSide({ type: 'edge', ...j.relation, docs: j.docs });
    } catch (error) {
      if (isAbortError(error, signal)) return;
    }
  };

  const openDoc = async (id: number): Promise<void> => {
    const { seq, signal } = beginSideRequest();
    try {
      //M 点击命中原文时拉取该段完整原文及其挂接的关系列表，切到右侧原文详情栏展示。
      const url = `/api/memory-graph/passage/${String(id)}`;
      const j = await get<{ passage: Doc; relations: { id: number; text: string }[] }>(url, signal);
      if (signal.aborted || seq !== sideSeqRef.current) return;

      setSide({ type: 'doc', doc: j.passage, relations: j.relations });
    } catch (error) {
      if (isAbortError(error, signal)) return;
    }
  };

  //M 开页：取客户列表，组件卸载时统一取消全部在途请求与提示计时器。
  useEffect(() => {
    const bootAbort = new AbortController();
    void get<{ list: Customer[] }>('/api/memory-graph/customers', bootAbort.signal).then((j) => {
      if (bootAbort.signal.aborted) return;

      setCustomers(j.list);
      if (!PARAMS.has('customer')) {
        const firstCustomer = j.list.find((c) => c.scope === 'history')?.customer ?? '';
        setCustomer(firstCustomer);
        if (firstCustomer !== '' && PARAMS.get('customer') === null) {
          setKnowledge(false);
        }
      }
      setReady(true);
    }).catch((error: Error) => {
      if (isAbortError(error, bootAbort.signal)) return;

      setBanner(`读不到记忆库：${error.message}`);
    });
    return () => {
      bootAbort.abort();
      mainAbortRef.current?.abort();
      sideAbortRef.current?.abort();
      clearBannerTimer();
    };
  }, [clearBannerTimer]);

  useEffect(() => {
    //M 客户就绪或切换客户/知识库范围时：切到空客户先翻开 knowledge 再单次拉数，绝不连发两次。
    if (!ready) return;
    if (customer === '' && !knowledge) {
      setKnowledge(true);
      return;
    }
    sideAbortRef.current?.abort();
    if (query.trim()) {
      void search(query, false);
      return;
    }

    //M 未填检索问句时拉取当前范围的整张关系网。
    void loadAll(false);
  }, [ready, customer, knowledge]);

  useEffect(() => {
    const onPrefill = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ text?: string; customer?: string; mode?: 'hybrid' | 'graph' }>
      ).detail ?? {};
      if (detail.customer) setCustomer(detail.customer);
      if (detail.mode) setMode(detail.mode);
      if (typeof detail.text === 'string' && detail.text.trim()) setQuery(detail.text);
    };
    window.addEventListener('jmbots-guide-prefill', onPrefill);
    return () => window.removeEventListener('jmbots-guide-prefill', onPrefill);
  }, []);

  const names = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.name])), [graph]);
  const top = useMemo(
    () => [...graph.nodes].sort((a, b) => b.degree - a.degree).slice(0, 12),
    [graph],
  );
  let backTarget = '关系网';
  if (found) {
    backTarget = '检索结果';
  }
  const back = (
    <p>
      <button type="button" onClick={() => setSide({ type: 'summary' })}>
        ← 回到{backTarget}
      </button>
    </p>
  );
  const history = customers.filter((c) => c.scope === 'history');
  if (customer !== '' && !history.some((c) => c.customer === customer)) {
    history.unshift({ customer, bot: '', docs: 0, scope: 'history' });
  }
  let headerTop: number | undefined;
  let stageTop: number | undefined;
  let maskLabel = '打开打码';
  if (mask) {
    headerTop = 52;
    stageTop = 108;
    maskLabel = '关闭打码';
  }
  let selectedCustomer = '';
  if (customer !== '') {
    selectedCustomer = String(history.findIndex((c) => c.customer === customer));
  }
  const warnings = found?.warnings ?? [];
  let foundModeLabel = '混合';
  if (found?.mode === 'graph') {
    foundModeLabel = '图谱+重排';
  }
  const locatedGraph = found?.graph ?? EMPTY;
  const locatedEdges = locatedGraph.hitEdges ?? [];

  //M 渲染关系图谱页三段主体：顶部控制栏、中间画布舞台与右侧详情栏。
  return (
    <>
      <privacy.MaskBanner />
      <header className="mg-header" style={{ top: headerTop }}>
        <h1>◈ 记忆关系图谱</h1>
        <select
          data-guide="customer"
          value={selectedCustomer}
          onChange={(e) => {
            if (e.target.value === '') {
              setCustomer('');
              return;
            }
            setCustomer(history[Number(e.target.value)]!.customer);
          }}
          title="客户"
        >
          {history.map((c, index) => {
            //M 按打码开关脱敏显示可选客户名并拼接文档段数标签。
            let docsLabel = '';
            if (c.docs > 0) {
              docsLabel = `（${String(c.docs)} 段）`;
            }
            return (
              <option key={index} value={String(index)}>
                {privacy.text(c.customer, mask)}{docsLabel}
              </option>
            );
          })}
          <option value="">只看知识库</option>
        </select>
        <input
          className="mg-q"
          value={privacy.text(query, mask)}
          readOnly={mask}
          placeholder="问一句，比如：王磊的上级是谁？她负责什么？"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search(query, true);
          }}
        />
        <select data-guide="mode" value={mode} onChange={(e) => setMode(e.target.value)} title="检索方式">
          <option value="hybrid">混合检索（快）</option>
          <option value="graph">图谱+大模型重排</option>
        </select>
        <button type="button" data-guide="search" onClick={() => void search(query, true)}>
          检索并高亮
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setQuery('');
            void loadAll(true);
          }}
        >
          整张关系网
        </button>
        <label>
          <input
            type="checkbox"
            checked={knowledge}
            onChange={(e) => setKnowledge(e.target.checked)}
          />
          含知识库
        </label>
        <button type="button" onClick={() => privacy.setMask(!mask)}>{maskLabel}</button>
        <a className="mg-link" href={withToken('/memory/', TOKEN)}>记忆检索</a>
        <a className="mg-link" href={withToken('/', TOKEN)}>聊天</a>
        <Guide steps={GRAPH_STEPS} className="mg-guide-btn" />
      </header>

      <div className="mg-stage" style={{ top: stageTop }}>
        <GraphCanvas
          graph={graph}
          hitEdges={hitEdges}
          hitNodes={hitNodes}
          merge={merge}
          version={version}
          onNode={(id) => void openNode(id)}
          onEdge={(id) => void openEdge(id)}
          onExpand={(name) => void expand(name)}
        />
        {banner && <div className="mg-banner">{privacy.text(banner, mask)}</div>}
        <div className="mg-legend">
          {[['person', '人'], ['org', '组织'], ['thing', '事'], ['item', '编号/日期/数']].map(([k, label]) => (
            <span key={k}><i style={{ background: COLORS[k!] }} />{label}</span>
          ))}
          <span><i style={{ background: '#ffc44d' }} />命中路径</span>
        </div>
        <div className="mg-help">滚轮缩放 · 拖空白处平移 · 拖点 · 点点/线看原文 · 双击点展开邻居</div>
      </div>

      <aside className="mg-side" ref={setSideEl} style={{ top: stageTop }}>
        {side.type === 'summary' && found && (
          <>
            <h2>命中路径（{locatedEdges.length} 条关系）</h2>
            {locatedEdges.length === 0 && (
              <div className="mg-muted">这次没有走到关系（只靠关键词/向量命中）</div>
            )}
            {getChains(locatedGraph, locatedEdges).map((path) => {
              const headSource = path[0]!.source;
              const headName = privacy.text(names.get(headSource) ?? '', mask);
              return (
                <div className="mg-chain" key={path[0]!.id}>
                  <span className="mg-ent" onClick={() => void openNode(headSource)}>{headName}</span>
                  {path.map((e) => {
                    const targetName = privacy.text(names.get(e.target) ?? '', mask);
                    return (
                      <span key={e.id} style={{ display: 'contents' }}>
                        <span className="mg-rel" onClick={() => void openEdge(e.id)}>
                          —{privacy.text(e.label, mask)}→
                        </span>
                        <span className="mg-ent" onClick={() => void openNode(e.target)}>
                          {targetName}
                        </span>
                      </span>
                    );
                  })}
                </div>
              );
            })}
            <div className="mg-stat">
              <span><b>{found.queryEntities.length}</b>问句实体</span>
              <span><b>{found.hits.length}</b>命中原文</span>
              <span><b>{found.total_ms}</b>毫秒（{foundModeLabel}）</span>
            </div>
            {found.queryEntities.length > 0 && (
              <div className="mg-muted">
                问句实体：{privacy.text(found.queryEntities.join('、'), mask)}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="mg-muted">提示：{privacy.text(warnings.join('；'), mask)}</div>
            )}
            <h2>本次检索命中的原文（{found.hits.length}）</h2>
            {sideEl !== null && found.hits.length > 0 && (
              <virtuoso.Virtuoso
                customScrollParent={sideEl}
                data={found.hits}
                computeItemKey={(_index, h) => h.id}
                itemContent={(_index, h) => {
                  //M 整理单条命中卡片的关系说明与附加文件出处路径。
                  let relSuffix = '';
                  if (h.relations) {
                    relSuffix = ` · ${privacy.text(h.relations.join('；'), mask)}`;
                  }
                  const hitFile = h.file ?? '';
                  const passageId = Number(h.id);

                  return (
                    <div className="mg-card" onClick={() => void openDoc(passageId)}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <b>[{h.id}] {privacy.text(h.title, mask)}</b>
                        {!mask && hitFile !== '' && <vscodeLink.VsCodeOpen site={hitFile} />}
                      </span>
                      {h.via.map((v) => {
                        let badgeClass = 'mg-badge ';
                        let badgeText = privacy.text(v, mask);
                        if (['keyword', 'vector', 'graph'].includes(v)) {
                          badgeClass = `mg-badge ${v}`;
                          badgeText = VIA[v]!;
                        }
                        return <span key={v} className={badgeClass}>{badgeText}</span>;
                      })}
                      <div>{privacy.text(h.snippet, mask)}</div>
                      <div className="mg-meta">相关度 {(h.score * 100).toFixed(0)}%{relSuffix}</div>
                    </div>
                  );
                }}
              />
            )}
          </>
        )}
        {side.type === 'summary' && !found && (
          <>
            <h2>{privacy.text(customer, mask) || '知识库'} 的关系网</h2>
            <div className="mg-stat">
              <span><b>{graph.nodes.length}</b>实体（共 {graph.total.nodes}）</span>
              <span><b>{graph.edges.length}</b>关系（共 {graph.total.edges}）</span>
            </div>
            <h2>连接最多的实体</h2>
            {top.map((n) => (
              <div className="mg-card" key={n.id} onClick={() => void openNode(n.id)}>
                <b>{privacy.text(n.name, mask)}</b>
                <span className="mg-badge">{n.degree} 条</span>
              </div>
            ))}
            <p className="mg-muted">
              点一个实体看它关联的原文；双击展开它的邻居。上面输入问题可以看检索命中的路径。
            </p>
          </>
        )}
        {side.type === 'node' && (
          <>
            <h2>实体</h2>
            <div className="mg-chain"><span className="mg-ent">{privacy.text(side.name, mask)}</span></div>
            {
              //M 知识库能用、没开打码（打码时不露原文）：给「存入知识库」；换实体时 key 变，面板重新预填。
            /**/}
            {kbDirs !== undefined && !mask && (
              <saveToKnowledge.SaveToKnowledgeButton
                key={side.name}
                title={`实体：${side.name}`}
                content={getEntityMarkdown(side.name, side.relations, side.docs)}
                dirs={kbDirs}
                defaultTag="图谱沉淀"
              />
            )}
            <h2>连着的关系（{side.relations.length}）</h2>
            {sideEl !== null && side.relations.length > 0 && (
              <virtuoso.Virtuoso
                customScrollParent={sideEl}
                data={side.relations}
                computeItemKey={(_index, r) => r.id}
                itemContent={(_index, r) => (
                  <div className="mg-card" onClick={() => void openEdge(r.id)}>
                    {privacy.text(r.text, mask)}
                  </div>
                )}
              />
            )}
            <h2>关联原文（{side.docs.length}）</h2>
            {sideEl !== null && side.docs.length > 0 && (
              <virtuoso.Virtuoso
                customScrollParent={sideEl}
                data={side.docs}
                computeItemKey={(_index, d) => d.id}
                itemContent={(_index, d) => <DocView doc={d} />}
              />
            )}
            <p><button type="button" onClick={() => void expand(side.name)}>展开它的邻居</button></p>
            {back}
          </>
        )}
        {side.type === 'edge' && (
          <>
            <h2>关系</h2>
            <div className="mg-chain">
              <span className="mg-ent">{privacy.text(side.subject, mask)}</span>
              <span className="mg-rel">—{privacy.text(side.label, mask)}→</span>
              <span className="mg-ent">{privacy.text(side.object, mask)}</span>
            </div>
            <div className="mg-muted">原句：{privacy.text(side.text, mask)}</div>
            <h2>关系来源（{side.docs.length} 段原文）</h2>
            {sideEl !== null && side.docs.length > 0 && (
              <virtuoso.Virtuoso
                customScrollParent={sideEl}
                data={side.docs}
                computeItemKey={(_index, d) => d.id}
                itemContent={(_index, d) => <DocView doc={d} />}
              />
            )}
            {back}
          </>
        )}
        {side.type === 'doc' && (
          <>
            <h2>原文</h2>
            <DocView doc={side.doc} />
            <h2>挂在这段上的关系</h2>
            {sideEl !== null && side.relations.length > 0 && (
              <virtuoso.Virtuoso
                customScrollParent={sideEl}
                data={side.relations}
                computeItemKey={(_index, r) => r.id}
                itemContent={(_index, r) => (
                  <div className="mg-card" onClick={() => void openEdge(r.id)}>
                    {privacy.text(r.text, mask)}
                  </div>
                )}
              />
            )}
            {back}
          </>
        )}
      </aside>
    </>
  );
}
