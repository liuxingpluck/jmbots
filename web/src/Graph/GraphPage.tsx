/**
 * 记忆关系图谱页（/graph/，memory-graph 插件托管）：选客户看整张关系网；输入问题走记忆检索，命中的关系高亮，
 * 右栏是命中路径（关系连成链）和命中原文；点点看关联原文，点线看关系出自哪段；双击点展开邻居。
 * 网址参数：customer、bot、q（有就先检索）、mode（hybrid | graph）、token。
 */
import { useEffect, useMemo, useState } from 'react';
import * as privacy from '../Privacy/Mask.tsx';
import { Guide } from '../Guide/Guide.tsx';
import { GRAPH_STEPS } from '../Guide/steps-graph.ts';
import { COLORS, GraphCanvas } from './GraphCanvas.tsx';
import { get, type Customer, type Doc, type Found, type Graph, type GraphEdge, type Hit } from './GraphApi.ts';

const PARAMS = new URLSearchParams(window.location.search);
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
function chains(graph: Graph, hit: number[]): GraphEdge[][] {
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
        if (f.source === path[path.length - 1]!.target) { path.push(f); used.add(f.id); grew = true; }
        else if (f.target === path[0]!.source) { path.unshift(f); used.add(f.id); grew = true; }
      }
    }
    out.push(path);
  }
  return out.sort((a, b) => b.length - a.length);
}

function DocView({ doc }: { doc: Doc }) {
  const mask = privacy.useMask();
  return (
    <div className="mg-doc">
      <div className="t">#{doc.id} · {privacy.text(doc.title, mask)}{doc.customer ? ` · ${privacy.text(doc.customer, mask)}` : doc.scope === 'knowledge' ? ' · 知识库' : ''}</div>
      {privacy.text(doc.text, mask)}
    </div>
  );
}

export function GraphPage() {
  //M 演示打码默认关；开着时顶部有提示条，下面 paddingTop/top 才让位
  const mask = privacy.useMask();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState(PARAMS.get('customer') ?? '');
  const [query, setQuery] = useState(PARAMS.get('q') ?? '');
  const [mode, setMode] = useState(PARAMS.get('mode') === 'graph' ? 'graph' : 'hybrid');
  const [knowledge, setKnowledge] = useState(false);
  const [graph, setGraph] = useState<Graph>(EMPTY);
  const [hitEdges, setHitEdges] = useState<number[]>([]);
  const [hitNodes, setHitNodes] = useState<number[]>([]);
  const [merge, setMerge] = useState(false);
  const [version, setVersion] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  const [side, setSide] = useState<Side>({ type: 'summary' });
  const [banner, setBanner] = useState('');
  const [ready, setReady] = useState(false);

  const common = (extra = '') => `customer=${encodeURIComponent(customer)}${BOT ? `&bot=${encodeURIComponent(BOT)}` : ''}${knowledge ? '&knowledge=1' : ''}${extra}`;
  const show = (g: Graph, hits: number[], nodes: number[], keep = false) => {
    setGraph(g); setHitEdges(hits); setHitNodes(nodes); setMerge(keep); setVersion((v) => v + 1);
  };

  const loadAll = async () => {
    setBanner('读取整张关系网…'); setFound(null); setSide({ type: 'summary' });
    try {
      const g = await get<Graph>(`/api/memory-graph/graph?${common('&limit=200')}`);
      show(g, [], []);
      setBanner(g.nodes.length ? '' : '这个客户还没有抽出关系（后台抽三元组可能还没跑完）');
    } catch (error) { setBanner(`读取失败：${(error as Error).message}`); }
  };

  const search = async (text = query) => {
    if (!text.trim()) { await loadAll(); return; }
    setBanner(`正在从记忆里检索：${text}${mode === 'graph' ? '（图谱+大模型重排，约 5–10 秒）' : ''}`);
    setSide({ type: 'summary' });
    try {
      const result = await get<Found>(`/api/memory-graph/search?q=${encodeURIComponent(text)}&mode=${mode}&${common()}`);
      setFound(result);
      show(result.graph, result.graph.hitEdges, result.graph.hitNodes);
      setBanner(result.graph.hitEdges.length ? `找到 ${result.graph.hitEdges.length} 条关系，金色流动的是这次回答用到的路径` : '没有命中关系，右侧是命中的原文');
      window.setTimeout(() => setBanner(''), 6000);
      window.dispatchEvent(new Event('jmbots-guide-searched'));
    } catch (error) {
      setBanner(`检索失败：${(error as Error).message}`);
      window.dispatchEvent(new Event('jmbots-guide-searched'));
    }
  };

  const expand = async (name: string) => {
    setBanner(`展开：${name}`);
    const g = await get<Graph>(`/api/memory-graph/graph?${common('&knowledge=1&limit=120')}&focus=${encodeURIComponent(name)}`);
    show(g, hitEdges, hitNodes, true);
    setBanner('');
  };

  const openNode = async (id: number) => {
    const j = await get<{ entity: { name: string } | null; relations: { id: number; text: string }[]; docs: Doc[] }>(`/api/memory-graph/entity/${id}`);
    setSide({ type: 'node', name: j.entity?.name ?? '', relations: j.relations, docs: j.docs });
  };
  const openEdge = async (id: number) => {
    const j = await get<{ relation: { subject: string; object: string; label: string; text: string } | null; docs: Doc[] }>(`/api/memory-graph/edge/${id}`);
    if (j.relation) setSide({ type: 'edge', ...j.relation, docs: j.docs });
  };
  const openDoc = async (id: number) => {
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
    if (!ready) return;
    if (customer === '') setKnowledge(true);
    void (query.trim() ? search() : loadAll());
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
  const back = <p><button onClick={() => setSide({ type: 'summary' })}>← 回到{found ? '检索结果' : '关系网'}</button></p>;
  const history = customers.filter((c) => c.scope === 'history');
  if (customer !== '' && !history.some((c) => c.customer === customer)) history.unshift({ customer, bot: '', docs: 0, scope: 'history' });

  return (
    <>
      <privacy.MaskBanner />
      <header className="mg-header" style={{ top: mask ? 52 : undefined }}>
        <h1>◈ 记忆关系图谱</h1>
        <select data-guide="customer" value={customer === '' ? '' : String(history.findIndex((c) => c.customer === customer))}
          onChange={(e) => setCustomer(e.target.value === '' ? '' : history[Number(e.target.value)]!.customer)} title="客户">
          {history.map((c, index) => <option key={index} value={String(index)}>{privacy.text(c.customer, mask)}{c.docs ? `（${c.docs} 段）` : ''}</option>)}
          <option value="">只看知识库</option>
        </select>
        <input className="mg-q" value={privacy.text(query, mask)} readOnly={mask} placeholder="问一句，比如：王磊的上级是谁？她负责什么？"
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
        <select data-guide="mode" value={mode} onChange={(e) => setMode(e.target.value)} title="检索方式">
          <option value="hybrid">混合检索（快）</option>
          <option value="graph">图谱+大模型重排</option>
        </select>
        <button data-guide="search" onClick={() => void search()}>检索并高亮</button>
        <button className="ghost" onClick={() => { setQuery(''); void loadAll(); }}>整张关系网</button>
        <label><input type="checkbox" checked={knowledge} onChange={(e) => setKnowledge(e.target.checked)} />含知识库</label>
        <button type="button" onClick={() => privacy.setMask(!mask)}>{mask ? '关闭打码' : '打开打码'}</button>
        <Guide steps={GRAPH_STEPS} className="mg-guide-btn" />
      </header>

      <div className="mg-stage" style={{ top: mask ? 108 : undefined }}>
        <GraphCanvas graph={graph} hitEdges={hitEdges} hitNodes={hitNodes} merge={merge} version={version}
          onNode={(id) => void openNode(id)} onEdge={(id) => void openEdge(id)} onExpand={(name) => void expand(name)} />
        {banner && <div className="mg-banner">{privacy.text(banner, mask)}</div>}
        <div className="mg-legend">
          {[['person', '人'], ['org', '组织'], ['thing', '事'], ['item', '编号/日期/数']].map(([k, t]) => <span key={k}><i style={{ background: COLORS[k!] }} />{t}</span>)}
          <span><i style={{ background: '#ffc44d' }} />命中路径</span>
        </div>
        <div className="mg-help">滚轮缩放 · 拖空白处平移 · 拖点 · 点点/线看原文 · 双击点展开邻居</div>
      </div>

      <aside className="mg-side" style={{ top: mask ? 108 : undefined }}>
        {side.type === 'summary' && found && (
          <>
            <h2>命中路径（{found.graph.hitEdges.length} 条关系）</h2>
            {found.graph.hitEdges.length === 0 && <div className="mg-muted">这次没有走到关系（只靠关键词/向量命中）</div>}
            {chains(found.graph, found.graph.hitEdges).map((path) => (
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
            <div className="mg-stat">
              <span><b>{found.queryEntities.length}</b>问句实体</span>
              <span><b>{found.hits.length}</b>命中原文</span>
              <span><b>{found.total_ms}</b>毫秒（{found.mode === 'graph' ? '图谱+重排' : '混合'}）</span>
            </div>
            {found.queryEntities.length > 0 && <div className="mg-muted">问句实体：{privacy.text(found.queryEntities.join('、'), mask)}</div>}
            {(found.warnings ?? []).length > 0 && <div className="mg-muted">提示：{privacy.text(found.warnings!.join('；'), mask)}</div>}
            <h2>本次检索命中的原文（{found.hits.length}）</h2>
            {found.hits.map((h: Hit) => (
              <div className="mg-card" key={h.id} onClick={() => void openDoc(h.id)}>
                <b>[{h.id}] {privacy.text(h.title, mask)}</b>{h.via.map((v) => <span key={v} className={`mg-badge ${['keyword', 'vector', 'graph'].includes(v) ? v : ''}`}>{['keyword', 'vector', 'graph'].includes(v) ? VIA[v] : privacy.text(v, mask)}</span>)}
                <div>{privacy.text(h.snippet, mask)}</div>
                <div className="mg-meta">相关度 {(h.score * 100).toFixed(0)}%{h.relations ? ` · ${privacy.text(h.relations.join('；'), mask)}` : ''}</div>
              </div>
            ))}
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
            {top.map((n) => <div className="mg-card" key={n.id} onClick={() => void openNode(n.id)}><b>{privacy.text(n.name, mask)}</b><span className="mg-badge">{n.degree} 条</span></div>)}
            <p className="mg-muted">点一个实体看它关联的原文；双击展开它的邻居。上面输入问题可以看检索命中的路径。</p>
          </>
        )}
        {side.type === 'node' && (
          <>
            <h2>实体</h2>
            <div className="mg-chain"><span className="mg-ent">{privacy.text(side.name, mask)}</span></div>
            <h2>连着的关系（{side.relations.length}）</h2>
            {side.relations.map((r) => <div className="mg-card" key={r.id} onClick={() => void openEdge(r.id)}>{privacy.text(r.text, mask)}</div>)}
            <h2>关联原文（{side.docs.length}）</h2>
            {side.docs.map((d) => <DocView key={d.id} doc={d} />)}
            <p><button onClick={() => void expand(side.name)}>展开它的邻居</button></p>
            {back}
          </>
        )}
        {side.type === 'edge' && (
          <>
            <h2>关系</h2>
            <div className="mg-chain"><span className="mg-ent">{privacy.text(side.subject, mask)}</span><span className="mg-rel">—{privacy.text(side.label, mask)}→</span><span className="mg-ent">{privacy.text(side.object, mask)}</span></div>
            <div className="mg-muted">原句：{privacy.text(side.text, mask)}</div>
            <h2>关系来源（{side.docs.length} 段原文）</h2>
            {side.docs.map((d) => <DocView key={d.id} doc={d} />)}
            {back}
          </>
        )}
        {side.type === 'doc' && (
          <>
            <h2>原文</h2>
            <DocView doc={side.doc} />
            <h2>挂在这段上的关系</h2>
            {side.relations.map((r) => <div className="mg-card" key={r.id} onClick={() => void openEdge(r.id)}>{privacy.text(r.text, mask)}</div>)}
            {back}
          </>
        )}
      </aside>
    </>
  );
}
