/**
 * 记忆检索页（/memory/，web 插件托管 dist/web/memory.html）。明天演示的主角。2026-11-14 jm开发。
 * 上：服务状态（记忆服务、vgr、段数、嵌入、关系抽取进度）；中：选客户 + 提问 → 命中原文卡片、关系三元组和多跳链；下：粘贴文字导入公共知识库。
 * 接口都是同源相对地址，不认端口：状态和检索走 memory-graph（/api/memory-graph/status、customers、search），导入走 memory（POST /api/memory/knowledge）。
 *   记忆服务地址在 config.yaml 里 memory-graph 的 backend_url，以后改成 30087 页面不用动。
 * 隐私：客户下拉只列 demo: 开头的演示客户；不选客户只查公共知识库（记忆服务本身也拒绝不带客户号查聊天记录）。
 * 网址参数：customer、q（有就先检索）、mode（hybrid | graph）、guide=1（自动开演示引导）、token。
 */
import { useEffect, useMemo, useState } from 'react';
import * as virtuoso from 'react-virtuoso';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
import { Guide } from '../Guide/Guide.tsx';
import type { GuidePrefillDetail } from '../Guide/Guide.tsx';
import { MEMORY_STEPS } from '../Guide/steps-memory.ts';
import { get, type Customer, type Found, type GraphEdge, type Hit } from '../Graph/GraphApi.ts';
import { DEMO_PREFIX, ERP_CUSTOMER, ERP_QUESTIONS } from './questions.ts';
import { TOKEN, withToken } from '../Token.ts';

const PARAMS = new URLSearchParams(window.location.search);
const VIA: Record<string, string> = { keyword: '关键词', vector: '向量', graph: '关系图' };
const KNOWLEDGE = '';

/** 2026-11-14 23:15 EST：服务端补的出处；旧服务没这些字段时页面仍能看。 */
type LocatedHit = Hit & { source?: string; file?: string; where?: string; origin?: string };

/** 记忆服务 /health 里用到的字段（memsvc/src/http.rs 的 health）。 */
interface Counts { customers?: number; docs?: number; embedded?: number; entities?: number; relations?: number; graphDone?: number; graphPending?: number; graphFailed?: number; graphSkipped?: number; history?: number; knowledge?: number }
interface Probe { url: string; ok: boolean; ms: number; error?: string; version?: string; counts?: Counts; extractModel?: string; embedding?: { model?: string; ready?: boolean }; status?: string }
interface Status { memory: Probe; vgr: Probe; mode: string }

/** POST 一个接口（带上和 get 一样的令牌）。 */
async function post<T>(path: string, body: unknown): Promise<T> {
  //M 2026-11-14 22:50 EST：令牌用 Token.ts 那一份；原来直接拼 ?token=，path 带 ? 时会拼错。
  const response = await fetch(withToken(path, TOKEN), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? String(response.status));
  return json;
}

/** 命中的边首尾相接连成链（最长的在前），和图谱页同一个算法。 */
function getChains(edges: GraphEdge[], hit: number[]): GraphEdge[][] {
  const list = edges.filter((e) => hit.includes(e.id));
  const used = new Set<number>();
  const out: GraphEdge[][] = [];
  for (const edge of list) {
    if (used.has(edge.id)) continue;
    const path = [edge];
    used.add(edge.id);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of list) {
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

/** 一个状态卡片。 */
function Card(props: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <div className={`mm-card ${props.tone ?? ''}`}>
      <div className="mm-card-label">{props.label}</div>
      <div className="mm-card-value">{props.value}</div>
      {props.sub && <div className="mm-card-sub">{props.sub}</div>}
    </div>
  );
}

/** 一张命中卡片：点开看全文。 */
function HitCard({ hit, index }: { hit: LocatedHit; index: number }) {
  //M 订阅全局演示打码开关，并整理来源路径、VS Code 跳转定位与去前缀后的正文。
  const mask = privacy.useMask();
  const [open, setOpen] = useState(index === 0);
  const [copied, setCopied] = useState('');
  const source = hit.file || hit.origin || hit.source || '';
  const location = [source, hit.where].filter(Boolean).join(' · ');
  const hitSite = vscodeLink.withLineHint(source, hit.where);
  const text = hit.snippet.replace(/^【来源：[^】]*】\s*/u, '');
  let cardClass = 'mm-hit ';
  if (open) {
    cardClass = 'mm-hit open';
  }

  //M 区分客户来源（按打码开关脱敏）与公共知识库标签。
  let scopeText = privacy.text(hit.customer, mask);
  if (hit.scope === 'knowledge') {
    scopeText = '公共知识库';
  }

  //M 渲染单张命中卡片：序号、脱敏标题、命中通路徽章、可选来源行及脱敏正文。
  return (
    <div className={cardClass} onClick={() => setOpen(!open)}>
      <div className="mm-hit-head">
        <span className="mm-hit-no">{index + 1}</span>
        <span className="mm-hit-title">{privacy.text(hit.title, mask)}</span>
      </div>
      <div className="mm-hit-tags">
        {hit.via.map((v) => {
          //M 将已知命中通路映射为中文徽章，未知通路名按打码设置脱敏。
          let badgeClass = 'mm-tag ';
          let badgeText = privacy.text(v, mask);
          if (['keyword', 'vector', 'graph'].includes(v)) {
            badgeClass = `mm-tag ${v}`;
            badgeText = VIA[v]!;
          }
          return <span key={v} className={badgeClass}>{badgeText}</span>;
        })}
        <span className="mm-tag score">相关度 {hit.score.toFixed(3)}</span>
        <span className="mm-tag">{scopeText}</span>
      </div>
      {/* 2026-11-14 23:15 EST：原文件路径 + 行号/Sheet 行范围，一键复制并支持在 VS Code 打开；打码开着不露路径，也不让复制和链接带出私有信息。 */}
      {
        //M 有来源信息时渲染脱敏位置、非打码态 VS Code 打开链接与复制按钮。
      /**/}
      {location !== '' && <div className="mm-hit-source" onClick={(event) => event.stopPropagation()}>
        <span>{privacy.text(location, mask)}</span>
        {!mask && hitSite !== '' && <vscodeLink.VsCodeOpen site={hitSite} />}
        <button disabled={mask} onClick={() => {
          void navigator.clipboard.writeText(location).then(() => setCopied('已复制'), () => setCopied('复制失败，请手动选择'));
        }}>{copied || '复制来源'}</button>
      </div>}
      {
        //M 展示按当前打码开关处理后的命中片段正文。
      /**/}
      <div className="mm-hit-text">{privacy.text(text, mask)}</div>
    </div>
  );
}

/**
 * 记忆检索页面主组件：轮询记忆服务与 vgr 状态、切换演示客户或公共知识库发起检索、
 * 展示命中原文卡片与多跳关系链，并支持粘贴文本导入公共知识库。
 * @returns 记忆检索页顶栏、状态卡片区、搜索栏、命中结果与导入区的 JSX 元素。
 * 副作用：定时轮询 `/api/memory-graph/status`，拉取 `/api/memory-graph/customers`，
 * 发起 `/api/memory-graph/search` 与 `POST /api/memory/knowledge`，并监听/派发演示引导事件。
 */
export function MemoryPage() {
  //M 演示打码默认关；开着时顶部有提示条，下面 paddingTop/top 才让位
  const mask = privacy.useMask();
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState(PARAMS.get('customer') ?? ERP_CUSTOMER);
  const [query, setQuery] = useState(PARAMS.get('q') ?? '');
  let initialMode = 'hybrid';
  if (PARAMS.get('mode') === 'graph') {
    initialMode = 'graph';
  }
  const [mode, setMode] = useState(initialMode);
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [importName, setImportName] = useState('');
  const [importText, setImportText] = useState('');
  const [importNote, setImportNote] = useState('');

  //M 状态：开页取一次，之后每 10 秒一次。
  useEffect(() => {
    const load = () => get<Status>('/api/memory-graph/status')
      .then((s) => { setStatus(s); setStatusError(''); })
      .catch((error: Error) => setStatusError(`读不到状态：${error.message}（主服务的 plugins 里要挂 memory-graph）`));
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  //M 客户：只留演示客户（demo: 开头）。
  useEffect(() => {
    void get<{ list: Customer[] }>('/api/memory-graph/customers').then((j) => {
      const seen = new Set<string>();
      setCustomers(j.list.filter((c) => c.customer.startsWith(DEMO_PREFIX) && !seen.has(c.customer) && seen.add(c.customer)));
    }).catch(() => undefined);
  }, []);

  const search = async (text = query, who = customer, how = mode) => {
    const q = text.trim();
    if (q === '') { setBanner('先输入一个问题'); return; }
    setBusy(true);
    let modeHint = '';
    if (how === 'graph') {
      modeHint = '（图谱+重排，约 5–10 秒）';
    }
    setBanner(`正在检索：${q}${modeHint}`);
    try {
      //M 拼装客户与检索模式参数调用记忆检索接口，保存命中结果与耗时反馈。
      const params = new URLSearchParams({ q, mode: how });
      if (who !== KNOWLEDGE) params.set('customer', who);
      const result = await get<Found>(`/api/memory-graph/search?${params.toString()}`);
      setFound(result);
      setBanner(`找到 ${String(result.hits.length)} 段原文、${String(result.relations.length)} 条关系，用时 ${String(result.total_ms)} ms`);
    } catch (error) {
      setFound(null);
      setBanner(`检索失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event('jmbots-guide-searched'));
    }
  };

  //M 演示引导预填：问题、客户、检索方式。
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<GuidePrefillDetail>).detail;
      if (detail.text) setQuery(detail.text);
      if (detail.customer !== undefined) setCustomer(detail.customer);
      if (detail.mode) setMode(detail.mode);
    };
    window.addEventListener('jmbots-guide-prefill', onPrefill);
    return () => window.removeEventListener('jmbots-guide-prefill', onPrefill);
  }, []);

  //M 网址带了 q 就先检索一次。
  useEffect(() => {
    if (PARAMS.get('q')) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const importKnowledge = async () => {
    if (importName.trim() === '' || importText.trim() === '') { setImportNote('标题和内容都要填'); return; }
    setImportNote('正在收进知识库…');
    try {
      //M 把标题与正文提交到知识库导入接口写入磁盘，并提示新生成的文件路径供直接检索。
      const j = await post<{ file: string }>('/api/memory/knowledge', { name: importName.trim(), content: importText });
      setImportNote(`已收进公共知识库：${j.file}。现在不选客户（公共知识库）就能检索到。`);
      setImportText('');
    } catch (error) {
      setImportNote(`导入失败：${(error as Error).message}（主服务的 plugins 里要挂 memory）`);
    }
  };

  const counts = status?.memory.counts ?? {};
  const done = counts.graphDone ?? 0, pending = counts.graphPending ?? 0, failed = counts.graphFailed ?? 0;
  const total = Math.max(1, done + pending + failed);
  const paths = useMemo(() => {
    if (!found) return [];

    //M 把本次检索命中的关系边首尾串联为多跳路径，供右侧边栏按最长链优先展示。
    return getChains(found.graph.edges, found.graph.hitEdges);
  }, [found]);
  const names = useMemo(() => new Map((found?.graph.nodes ?? []).map((n) => [n.id, n.name])), [found]);
  const graphParams = new URLSearchParams({ q: query, mode });
  if (customer) {
    graphParams.set('customer', customer);
  }
  let graphLink = `/graph/?${graphParams.toString()}`;
  if (mask) {
    graphLink = '/graph/';
  }
  let choices = customers;
  if (!customers.some((c) => c.customer === customer) && customer !== KNOWLEDGE) {
    choices = [{ customer, bot: '', docs: 0, scope: 'history' }, ...customers];
  }
  const formatCount = (n: number | undefined) => (n ?? 0).toLocaleString('zh-CN');
  let pageTop: number | undefined;
  let maskLabel = '打开打码';
  if (mask) {
    pageTop = 52;
    maskLabel = '关闭打码';
  }

  //M 整理记忆服务与 vgr 适配器卡片的状态文案和色阶（错误信息按打码开关脱敏）。
  let memValue = '…';
  let memTone: 'ok' | 'bad' | undefined;
  let memSub = privacy.text(statusError, mask);
  if (status) {
    memValue = '离线';
    memTone = 'bad';
    memSub = '没连上';
    if (status.memory.ok) {
      memValue = '在线';
      memTone = 'ok';
      memSub = `v${privacy.text(status.memory.version ?? '?', mask)} · ${String(status.memory.ms)} ms`;
    }
  }
  let vgrValue = '…';
  let vgrTone: 'ok' | 'warn' | undefined;
  let vgrSub = '';
  if (status) {
    vgrValue = '离线';
    vgrTone = 'warn';
    vgrSub = '没起来，不影响混合检索';
    if (status.vgr.ok) {
      vgrValue = '在线';
      vgrTone = 'ok';
      vgrSub = `${String(status.vgr.ms)} ms`;
    }
  }
  let embeddedTone: 'ok' | undefined;
  if (counts.docs && counts.embedded === counts.docs) {
    embeddedTone = 'ok';
  }
  let selectedCustomer = String(choices.findIndex((c) => c.customer === customer));
  if (customer === KNOWLEDGE) {
    selectedCustomer = KNOWLEDGE;
  }
  let searchLabel = '检索';
  if (busy) {
    searchLabel = '检索中…';
  }

  //M 渲染记忆检索页主体：顶栏操作、服务状态卡片、搜索与推荐问句区、命中原文/关系链及公共知识库导入区。
  return (
    <div className="mm-page" style={{ paddingTop: pageTop }}>
      <privacy.MaskBanner />
      <header className="mm-header" style={{ top: pageTop }}>
        <h1>记忆检索</h1>
        <span className="mm-sub">jmbots 记忆服务 · 关键词 + 向量 + 关系图</span>
        <span className="mm-grow" />
        <button type="button" onClick={() => privacy.setMask(!mask)}>{maskLabel}</button>
        <a className="mm-link" href="/graph/" target="_blank" rel="noreferrer">关系图谱</a>
        <a className="mm-link" href="/" target="_blank" rel="noreferrer">聊天</a>
        <Guide steps={MEMORY_STEPS} className="mm-guide" />
      </header>

      <main className="mm-main">
        <section className="mm-cards" data-guide="status">
          {
            //M 渲染服务状态、文档/向量/实体/三元组计数卡及关系抽取进度条，数字格式化并按需脱敏模型名。
          /**/}
          <Card label="记忆服务" value={memValue} tone={memTone} sub={memSub} />
          <Card label="vgr 适配器" value={vgrValue} tone={vgrTone} sub={vgrSub} />
          <Card label="文档段数" value={formatCount(counts.docs)} sub={`客户聊天 ${formatCount(counts.history)} · 知识库 ${formatCount(counts.knowledge)}`} />
          <Card label="已嵌入向量" value={`${formatCount(counts.embedded)} / ${formatCount(counts.docs)}`} sub={privacy.text(status?.memory.embedding?.model ?? '', mask)} tone={embeddedTone} />
          {/* 2026-11-14：实体、关系分两张卡，数字大了不被省略号截断。 */}
          <Card label="实体" value={formatCount(counts.entities)} sub={`客户 ${formatCount(counts.customers)} 个`} />
          <Card label="关系三元组" value={formatCount(counts.relations)} sub="后台抽取，持续增加" />
          <div className="mm-card mm-progress" data-guide="progress">
            <div className="mm-card-label">关系抽取进度</div>
            <div className="mm-card-value">{Math.round((done / total) * 100)}%</div>
            <div className="mm-bar">
              <i className="done" style={{ width: `${String((done / total) * 100)}%` }} />
              <i className="failed" style={{ width: `${String((failed / total) * 100)}%` }} />
            </div>
            <div className="mm-card-sub">完成 {formatCount(done)} · 排队 {formatCount(pending)} · 失败 {formatCount(failed)}</div>
          </div>
        </section>

        <section className="mm-search">
          {
            //M 渲染客户范围选择下拉框（客户名按打码状态脱敏）以及下方推荐演示问题快捷栏。
          /**/}
          <div className="mm-row">
            <select
              data-guide="customer"
              value={selectedCustomer}
              onChange={(e) => {
                if (e.target.value === KNOWLEDGE) {
                  setCustomer(KNOWLEDGE);
                  return;
                }
                setCustomer(choices[Number(e.target.value)]!.customer);
              }}
            >
              {
                //M 按打码状态脱敏渲染可选演示客户与文档段数选项。
              /**/}
              {choices.map((c, index) => <option key={index} value={String(index)}>{privacy.text(c.customer, mask)}（{c.docs} 段）</option>)}
              <option value={KNOWLEDGE}>公共知识库（不选客户）</option>
            </select>
            {
              //M 问题输入框、检索模式下拉与检索触发按钮：打码态只读脱敏、支持回车触发与推荐问题一键检索。
            /**/}
            <input data-guide="query" className="mm-q" value={privacy.text(query, mask)} readOnly={mask} placeholder="问一个问题，比如：厂送通知是用来管什么的？"
              onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
            <select data-guide="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="hybrid">混合检索</option>
              <option value="graph">图谱+重排</option>
            </select>
            <button data-guide="search" disabled={busy} onClick={() => void search()}>{searchLabel}</button>
          </div>
          <div className="mm-chips">
            {ERP_QUESTIONS.map((q) => <button key={q} className="mm-chip" onClick={() => { setQuery(q); void search(q); }}>{q}</button>)}
          </div>
          {banner && <div className="mm-banner">{privacy.text(banner, mask)}</div>}
        </section>

        {found && (
          <section className="mm-results">
            <div className="mm-hits" data-guide="hits">
              <h2>命中原文（{found.hits.length}）</h2>
              {found.hits.length === 0 && <p className="mm-muted">没有命中。换个说法，或换成「图谱+重排」。</p>}
              {found.hits.length > 0 && (
                <virtuoso.Virtuoso
                  useWindowScroll
                  data={found.hits}
                  computeItemKey={(_index, hit) => hit.id}
                  itemContent={(index, hit) => <HitCard hit={hit} index={index} />}
                />
              )}
            </div>
            <aside className="mm-rels" data-guide="relations">
              {
                //M 展示问句中提取的实体及首尾相连的多跳关系路径，实体与关系词均按打码开关脱敏。
              /**/}
              <h2>问题里的实体</h2>
              <div className="mm-ents">{found.queryEntities.map((e) => <span key={e} className="mm-ent">{privacy.text(e, mask)}</span>)}</div>
              {paths.length > 0 && (
                <>
                  <h2>多跳路径（{paths.length}）</h2>
                  {paths.slice(0, 6).map((path) => (
                    <div className="mm-chain" key={path.map((e) => e.id).join('-')}>
                      <span className="mm-ent">{privacy.text(names.get(path[0]!.source) ?? '?', mask)}</span>
                      {path.map((e) => (
                        <span key={e.id}><span className="mm-rel">—{privacy.text(e.label, mask)}→</span><span className="mm-ent">{privacy.text(names.get(e.target) ?? '?', mask)}</span></span>
                      ))}
                    </div>
                  ))}
                </>
              )}
              {
                //M 展示本次检索用到的关系三元组、关系图谱页跳转链接与告警提示（均按打码处理）。
              /**/}
              <h2>用到的关系三元组（{found.relations.length}）</h2>
              {found.relations.length === 0 && <p className="mm-muted">这次没有用到关系（关系抽取可能还没跑到这些段）。</p>}
              <ol className="mm-triples">{found.relations.slice(0, 20).map((r) => <li key={r}>{privacy.text(r, mask)}</li>)}</ol>
              <a data-guide="graph" className="mm-graph-link" href={graphLink} target="_blank" rel="noreferrer">在关系图谱里看这次检索 →</a>
              {found.warnings && found.warnings.length > 0 && <p className="mm-muted">提示：{privacy.text(found.warnings.join('；'), mask)}</p>}
            </aside>
          </section>
        )}

        <section className="mm-import" data-guide="import">
          {
            //M 公共知识库导入表单：按打码状态脱敏并锁定输入、提交写入知识库并渲染可点开的导入路径反馈。
          /**/}
          <h2>导入文档</h2>
          <p className="mm-muted">粘贴一段文字，收进公共知识库，马上能检索。整本 PDF / Word 用 <code>ztools/doc-import</code> 导入到指定客户（出版ERP 就是这样导进来的）。</p>
          <div className="mm-row">
            <input value={privacy.text(importName, mask)} readOnly={mask} placeholder="标题，比如：退货流程说明" onChange={(e) => setImportName(e.target.value)} />
            <button onClick={() => void importKnowledge()}>收进知识库</button>
          </div>
          <textarea value={privacy.text(importText, mask)} readOnly={mask} rows={5} placeholder="正文…" onChange={(e) => setImportText(e.target.value)} />
          {importNote && <div className="mm-banner"><vscodeLink.TextWithVscodeLinks text={privacy.text(importNote, mask)} masked={mask} /></div>}
        </section>
      </main>
    </div>
  );
}
