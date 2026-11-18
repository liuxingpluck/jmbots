/**
 * 记忆关系图谱页（/graph/，memory-graph 插件托管）：选客户看整张关系网；输入问题走记忆检索，命中的关系高亮，
 * 右栏是命中路径（关系连成链）和命中原文；点点看关联原文，点线看关系出自哪段；双击点展开邻居。
 * 网址参数：customer、bot、q（有就先检索）、mode（hybrid | graph）、token。
 */
import { useEffect, useMemo, useState } from 'react';
import * as virtuoso from 'react-virtuoso';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
import * as api from '../Api.ts';
import { TOKEN, withToken } from '../Token.ts';
import { Guide } from '../Guide/Guide.tsx';
import { GRAPH_STEPS } from '../Guide/steps-graph.ts';
import { COLORS, GraphCanvas } from './GraphCanvas.tsx';
import { get, type Customer, type Doc, type Graph, type GraphEdge } from './GraphApi.ts';

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
          path.push(f); used.add(f.id); grew = true;
          continue;
        }
        if (f.target === path[0]!.source) {
          path.unshift(f); used.add(f.id); grew = true;
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
 * 并驱动 GraphCanvas 渲染整网或检索高亮子图。
 * @returns 图谱页顶部控制栏、画布舞台与右侧详情栏组成的 JSX 元素。
 * 副作用：请求 `/api/memory-graph/*` 接口读写图谱与详情，监听 `jmbots-guide-prefill` 并派发 `jmbots-guide-searched` 引导事件，
 * 以及在检索后设置提示条自动清除定时器。
 */
export function GraphPage() {
  //M 演示打码默认关；开着时顶部有提示条，下面 paddingTop/top 才让位
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
  const [knowledge, setKnowledge] = useState(false);
  const [graph, setGraph] = useState<Graph>(EMPTY);
  const [hitEdges, setHitEdges] = useState<number[]>([]);
  const [hitNodes, setHitNodes] = useState<number[]>([]);
  const [merge, setMerge] = useState(false);
  const [version, setVersion] = useState(0);
  const [found, setFound] = useState<api.MemorySearchResult | null>(null);
  const [side, setSide] = useState<Side>({ type: 'summary' });
  const [sideEl, setSideEl] = useState<HTMLElement | null>(null);
  const [banner, setBanner] = useState('');
  const [ready, setReady] = useState(false);

  const getCommonQuery = (extra = '') => {
    let botParam = '';
    if (BOT) {
      botParam = `&bot=${encodeURIComponent(BOT)}`;
    }
    let knowledgeParam = '';
    if (knowledge) {
      knowledgeParam = '&knowledge=1';
    }
    return `customer=${encodeURIComponent(customer)}${botParam}${knowledgeParam}${extra}`;
  };
  const show = (g: Graph, hits: number[], nodes: number[], keep = false) => {
    setGraph(g); setHitEdges(hits); setHitNodes(nodes); setMerge(keep); setVersion((v) => v + 1);
  };

  const loadAll = async () => {
    setBanner('读取整张关系网…'); setFound(null); setSide({ type: 'summary' });
    try {
      //M 拼装当前客户与知识库范围参数，拉取最多 200 个节点的全量关系网并交由画布重绘。
      const g = await get<Graph>(`/api/memory-graph/graph?${getCommonQuery('&limit=200')}`);
      show(g, [], []);
      let emptyBanner = '';
      if (g.nodes.length === 0) {
        emptyBanner = '这个客户还没有抽出关系（后台抽三元组可能还没跑完）';
      }
      setBanner(emptyBanner);
    } catch (error) { setBanner(`读取失败：${(error as Error).message}`); }
  };

  const search = async (text = query) => {
    //G 问句为空时直接回退加载整张关系网，不发起空检索。
    if (!text.trim()) { await loadAll(); return; }
    let modeHint = '';
    if (mode === 'graph') {
      modeHint = '（图谱+大模型重排，约 5–10 秒）';
    }
    setBanner(`正在从记忆里检索：${text}${modeHint}`);
    setSide({ type: 'summary' });
    try {
      //M 记忆页与图谱页使用同一检索，图谱的整体查询和点边原文仍走图谱接口。
      const params = new URLSearchParams({ q: text, mode, sources: 'knowledge', limit: '8' });
      if (customer !== '') {
        params.set('customer', customer);
        params.set('sources', 'history,knowledge');
      }
      if (BOT !== '') params.set('bot', BOT);

      //M 统一结果有命中子图时高亮，没走关系时仍展示原文摘要。
      const result = await api.memorySearch(params);
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
      window.setTimeout(() => setBanner(''), 6000);
      window.dispatchEvent(new Event('jmbots-guide-searched'));
    } catch (error) {
      setBanner(`检索失败：${(error as Error).message}`);
      window.dispatchEvent(new Event('jmbots-guide-searched'));
    }
  };

  const expand = async (name: string) => {
    //M 以双击节点为焦点拉取最多 120 个关联邻居（含知识库），以增量 merge 模式并入当前画布并保留原高亮。
    setBanner(`展开：${name}`);
    const g = await get<Graph>(`/api/memory-graph/graph?${getCommonQuery('&knowledge=1&limit=120')}&focus=${encodeURIComponent(name)}`);
    show(g, hitEdges, hitNodes, true);
    setBanner('');
  };

  const openNode = async (id: number) => {
    //M 点选节点时拉取该实体的全部关系与关联原文，切到右侧实体详情栏展示。
    const j = await get<{ entity: { name: string } | null; relations: { id: number; text: string }[]; docs: Doc[] }>(`/api/memory-graph/entity/${id}`);
    setSide({ type: 'node', name: j.entity?.name ?? '', relations: j.relations, docs: j.docs });
  };
  const openEdge = async (id: number) => {
    //M 点选关系边或路径连线时拉取该三元组原句与来源段落，切到右侧关系详情栏展示。
    const j = await get<{ relation: { subject: string; object: string; label: string; text: string } | null; docs: Doc[] }>(`/api/memory-graph/edge/${id}`);
    if (j.relation) setSide({ type: 'edge', ...j.relation, docs: j.docs });
  };
  const openDoc = async (id: number) => {
    //M 点击命中原文时拉取该段完整原文及其挂接的关系列表，切到右侧原文详情栏展示。
    const j = await get<{ passage: Doc; relations: { id: number; text: string }[] }>(`/api/memory-graph/passage/${id}`);
    setSide({ type: 'doc', doc: j.passage, relations: j.relations });
  };

  //M 开页：取客户列表；网址带了 q 就先检索，否则看整张网。
  useEffect(() => {
    void get<{ list: Customer[] }>('/api/memory-graph/customers').then((j) => {
      setCustomers(j.list);
      if (!PARAMS.has('customer')) setCustomer(j.list.find((c) => c.scope === 'history')?.customer ?? '');
      setReady(true);
    }).catch((error: Error) => setBanner(`读不到记忆库：${error.message}`));
  }, []);

  useEffect(() => {
    //M 客户就绪或切换客户/知识库范围时：有初始问句则自动检索，否则加载全量关系网。
    if (!ready) return;
    if (customer === '') setKnowledge(true);
    if (query.trim()) {
      void search();
      return;
    }

    //M 未填检索问句时拉取当前范围的整张关系网。
    void loadAll();
  }, [ready, customer, knowledge]);

  useEffect(() => {
    const onPrefill = (event: Event): void => {
      const detail = (event as CustomEvent<{ text?: string; customer?: string; mode?: 'hybrid' | 'graph' }>).detail ?? {};
      if (detail.customer) setCustomer(detail.customer);
      if (detail.mode) setMode(detail.mode);
      if (typeof detail.text === 'string' && detail.text.trim()) setQuery(detail.text);
    };
    window.addEventListener('jmbots-guide-prefill', onPrefill);
    return () => window.removeEventListener('jmbots-guide-prefill', onPrefill);
  }, []);

  const names = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.name])), [graph]);
  const top = useMemo(() => [...graph.nodes].sort((a, b) => b.degree - a.degree).slice(0, 12), [graph]);
  let backTarget = '关系网';
  if (found) {
    backTarget = '检索结果';
  }
  const back = <p><button onClick={() => setSide({ type: 'summary' })}>← 回到{backTarget}</button></p>;
  const history = customers.filter((c) => c.scope === 'history');
  if (customer !== '' && !history.some((c) => c.customer === customer)) history.unshift({ customer, bot: '', docs: 0, scope: 'history' });
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
  let foundModeLabel = '混合';
  if (found?.mode === 'graph') {
    foundModeLabel = '图谱+重排';
  }
  const locatedGraph = found?.graph ?? EMPTY;
  const locatedEdges = locatedGraph.hitEdges ?? [];

  //M 渲染关系图谱页三段主体：顶部控制栏（客户/问句/检索模式/打码开关/跨页导航）、中间画布舞台与右侧详情栏。
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
              docsLabel = `（${c.docs} 段）`;
            }

            //M 按打码开关脱敏客户名称并渲染单个下拉选项。
            return <option key={index} value={String(index)}>{privacy.text(c.customer, mask)}{docsLabel}</option>;
          })}
          <option value="">只看知识库</option>
        </select>
        {
          //M 问题输入框、检索方式与操作按钮：脱敏回显输入、触发检索或重读全网、切换打码并带令牌跳转记忆/聊天页。
        /**/}
        <input className="mg-q" value={privacy.text(query, mask)} readOnly={mask} placeholder="问一句，比如：王磊的上级是谁？她负责什么？"
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
        <select data-guide="mode" value={mode} onChange={(e) => setMode(e.target.value)} title="检索方式">
          <option value="hybrid">混合检索（快）</option>
          <option value="graph">图谱+大模型重排</option>
        </select>
        <button data-guide="search" onClick={() => void search()}>检索并高亮</button>
        <button className="ghost" onClick={() => { setQuery(''); void loadAll(); }}>整张关系网</button>
        <label><input type="checkbox" checked={knowledge} onChange={(e) => setKnowledge(e.target.checked)} />含知识库</label>
        <button type="button" onClick={() => privacy.setMask(!mask)}>{maskLabel}</button>
        <a className="mg-link" href={withToken('/memory/', TOKEN)}>记忆检索</a>
        <a className="mg-link" href={withToken('/', TOKEN)}>聊天</a>
        <Guide steps={GRAPH_STEPS} className="mg-guide-btn" />
      </header>

      <div className="mg-stage" style={{ top: stageTop }}>
        {
          //M 渲染关系图画布组件并接入节点/边点选与邻居展开回调，同时按打码开关脱敏状态横幅。
        /**/}
        <GraphCanvas graph={graph} hitEdges={hitEdges} hitNodes={hitNodes} merge={merge} version={version}
          onNode={(id) => void openNode(id)} onEdge={(id) => void openEdge(id)} onExpand={(name) => void expand(name)} />
        {banner && <div className="mg-banner">{privacy.text(banner, mask)}</div>}
        <div className="mg-legend">
          {[['person', '人'], ['org', '组织'], ['thing', '事'], ['item', '编号/日期/数']].map(([k, t]) => <span key={k}><i style={{ background: COLORS[k!] }} />{t}</span>)}
          <span><i style={{ background: '#ffc44d' }} />命中路径</span>
        </div>
        <div className="mg-help">滚轮缩放 · 拖空白处平移 · 拖点 · 点点/线看原文 · 双击点展开邻居</div>
      </div>

      <aside className="mg-side" ref={setSideEl} style={{ top: stageTop }}>
        {side.type === 'summary' && found && (
          <>
            {
              //M 渲染检索命中路径：把命中边首尾连成多跳链并绑定节点/边详情点击，名称和关系词按需脱敏。
            /**/}
            <h2>命中路径（{locatedEdges.length} 条关系）</h2>
            {locatedEdges.length === 0 && <div className="mg-muted">这次没有走到关系（只靠关键词/向量命中）</div>}
            {getChains(locatedGraph, locatedEdges).map((path) => (
              <div className="mg-chain" key={path[0]!.id}>
                <span className="mg-ent" onClick={() => void openNode(path[0]!.source)}>{privacy.text(names.get(path[0]!.source) ?? '', mask)}</span>
                {path.map((e) => (
                  <span key={e.id} style={{ display: 'contents' }}>
                    <span className="mg-rel" onClick={() => void openEdge(e.id)}>—{privacy.text(e.label, mask)}→</span>
                    <span className="mg-ent" onClick={() => void openNode(e.target)}>{privacy.text(names.get(e.target) ?? '', mask)}</span>
                  </span>
                ))}
              </div>
            ))}
            {
              //M 展示检索统计指标、问句提取实体与后端告警提示，字符串均经隐私脱敏。
            /**/}
            <div className="mg-stat">
              <span><b>{found.queryEntities.length}</b>问句实体</span>
              <span><b>{found.hits.length}</b>命中原文</span>
              <span><b>{found.total_ms}</b>毫秒（{foundModeLabel}）</span>
            </div>
            {found.queryEntities.length > 0 && <div className="mg-muted">问句实体：{privacy.text(found.queryEntities.join('、'), mask)}</div>}
            {(found.warnings ?? []).length > 0 && <div className="mg-muted">提示：{privacy.text(found.warnings!.join('；'), mask)}</div>}
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

                  //M 渲染命中原文卡片 DOM：点击加载原文详情、展示通路徽章与脱敏标题。
                  return (
                    <div className="mg-card" onClick={() => void openDoc(passageId)}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <b>[{h.id}] {privacy.text(h.title, mask)}</b>
                        {!mask && hitFile !== '' && <vscodeLink.VsCodeOpen site={hitFile} />}
                      </span>
                      {h.via.map((v) => {
                        //M 已知命中通路映射为中文徽章，未知通路名按打码开关脱敏。
                        let badgeClass = 'mg-badge ';
                        let badgeText = privacy.text(v, mask);
                        if (['keyword', 'vector', 'graph'].includes(v)) {
                          badgeClass = `mg-badge ${v}`;
                          badgeText = VIA[v]!;
                        }
                        return <span key={v} className={badgeClass}>{badgeText}</span>;
                      })}
                      {
                        //M 展示当前命中片段的脱敏正文摘要与相关度分数。
                      /**/}
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
            {
              //M 未检索时展示当前范围关系网概况及度数最高的核心实体列表，点击可进入实体详情。
            /**/}
            <h2>{privacy.text(customer, mask) || '知识库'} 的关系网</h2>
            <div className="mg-stat">
              <span><b>{graph.nodes.length}</b>实体（共 {graph.total.nodes}）</span>
              <span><b>{graph.edges.length}</b>关系（共 {graph.total.edges}）</span>
            </div>
            <h2>连接最多的实体</h2>
            {top.map((n) => <div className="mg-card" key={n.id} onClick={() => void openNode(n.id)}><b>{privacy.text(n.name, mask)}</b><span className="mg-badge">{n.degree} 条</span></div>)}
            <p className="mg-muted">点一个实体看它关联的原文；双击展开它的邻居。上面输入问题可以看检索命中的路径。</p>
          </>
        )}
        {side.type === 'node' && (
          <>
            {
              //M 渲染实体详情栏：显示脱敏实体名、连着的关系卡片列表与关联原文列表。
            /**/}
            <h2>实体</h2>
            <div className="mg-chain"><span className="mg-ent">{privacy.text(side.name, mask)}</span></div>
            <h2>连着的关系（{side.relations.length}）</h2>
            {sideEl !== null && side.relations.length > 0 && (
              <virtuoso.Virtuoso
                customScrollParent={sideEl}
                data={side.relations}
                computeItemKey={(_index, r) => r.id}
                itemContent={(_index, r) => (
                  <div className="mg-card" onClick={() => void openEdge(r.id)}>{privacy.text(r.text, mask)}</div>
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
            {
              //M 提供从实体详情栏直接把该实体邻居增量展开并入画布的操作按钮。
            /**/}
            <p><button onClick={() => void expand(side.name)}>展开它的邻居</button></p>
            {back}
          </>
        )}
        {side.type === 'edge' && (
          <>
            {
              //M 渲染关系详情栏：显示脱敏后的主客体三元组、原句与来源原文片段。
            /**/}
            <h2>关系</h2>
            <div className="mg-chain"><span className="mg-ent">{privacy.text(side.subject, mask)}</span><span className="mg-rel">—{privacy.text(side.label, mask)}→</span><span className="mg-ent">{privacy.text(side.object, mask)}</span></div>
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
            {
              //M 渲染原文详情栏：展示选中段落内容及挂接在该原文上的关系列表，点击关系可跳转查看。
            /**/}
            <h2>原文</h2>
            <DocView doc={side.doc} />
            <h2>挂在这段上的关系</h2>
            {sideEl !== null && side.relations.length > 0 && (
              <virtuoso.Virtuoso
                customScrollParent={sideEl}
                data={side.relations}
                computeItemKey={(_index, r) => r.id}
                itemContent={(_index, r) => (
                  <div className="mg-card" onClick={() => void openEdge(r.id)}>{privacy.text(r.text, mask)}</div>
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
