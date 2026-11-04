/**
 * 上下文挑选：分派阶段先用 jmindex 搜出相关的代码、文档、技能，再用决策模型快速筛一遍，
 * 只把真有帮助的塞进执行者的系统提示词。
 *
 * 为什么要筛（用户 2026-11-04 定）：搜索给的是"看起来相关"，塞多了是噪音、还烧上下文。
 * 决策模型一次就能对一个文件给出多路概率——有帮助 / 没帮助 / 拿不准要细看——比一个
 * 阈值卡死灵活：拿不准的那部分可以单独交给低思考模型再看，而不是直接扔掉或直接塞进去。
 *
 * jmindex 是个独立的可执行文件（Rust），这里只当它是个 HTTP 服务用；它没起来就什么都不挑，
 * 照常干活——挑上下文是锦上添花，不能because它挂了就把正事挡住。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as checks from '../utils/Checks.ts';
import type * as modelModule from './Model.ts';


/** jmindex 搜出来的一条。 */
export interface Found {
  /** 文件路径（相对项目根）。 */
  path: string;

  /** 这个文件讲什么：jmindex 里的 AI 摘要，没有就是空。 */
  summary: string;

  /** 命中的片段，已经截短过。 */
  snippet: string;
}


/** 筛过之后的一条。 */
export interface Picked extends Found {
  /** 有帮助的概率（0–1）。 */
  helpful: number;

  /** 决策模型怎么判的：keep 收下、drop 扔掉、look 拿不准要细看。 */
  verdict: 'keep' | 'drop' | 'look';
}


/** 挑上下文的设置。 */
export interface PickOptions {
  /** jmindex 的地址，如 http://127.0.0.1:30090；不写就不挑。 */
  baseUrl?: string;

  /** 最多搜几条回来筛。 */
  limit?: number;

  /** 概率到多少算"有帮助"。 */
  keepAbove?: number;

  /** 片段最多留多少字，免得把上下文撑爆。 */
  maxSnippetChars?: number;
}


/** 搜索默认要几条。 */
const DEFAULT_LIMIT = 8;

/** 默认多大概率算有帮助。 */
const DEFAULT_KEEP_ABOVE = 0.6;

/** 默认每条片段留多少字。 */
const DEFAULT_SNIPPET_CHARS = 800;

/** 问 jmindex 最多等多久，毫秒。 */
const SEARCH_TIMEOUT_MS = 8_000;

/** 导整张关系图可能慢一些。 */
const GRAPH_TIMEOUT_MS = 60_000;

/** jmindex 的产物放在运行时目录的哪个文件夹（用户 2026-11-04 定：要放进来，给人看）。 */
const GRAPH_DIR = 'jmindex';


/**
 * 让 jmindex 把关系图谱导成一张网页，存进运行时目录，人可以直接点开看。
 *
 * 用户 2026-11-04 要求：jmindex 每次生成的东西要以"带图文、给人阅读"的形式放在运行时目录的
 * jmindex/ 文件夹里，而且 HTML 必须点得开。
 *
 * @param baseUrl jmindex 地址。
 * @param runtimeDir 运行时目录。
 * @param query 看哪一块的关系；不写就是整张图。
 * @returns 写好的文件路径；jmindex 没起来或写不了时是 undefined（不抛错）。
 * 副作用：发一次 HTTP 请求，往 <运行时目录>/jmindex/ 写一个 .html。
 */
export async function exportGraph(baseUrl: string, runtimeDir: string, query?: string): Promise<string | undefined> {
  try {
    /** 问哪一块。 */
    const q = query ? `?q=${encodeURIComponent(query)}` : '';
    /** 返回的网页。 */
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/graph${q}`, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
    if (!response.ok) {
      return undefined;
    }
    /** 返回的内容。 */
    const body = await response.text();
    /** 最终要写的网页。 */
    let html: string;
    if (body.trimStart().toLowerCase().startsWith('<!doctype') || body.trimStart().toLowerCase().startsWith('<html')) {
      //G jmindex 直接给了网页，就用它。
      html = body;
    } else {
      //G 这个版本的 /graph 只给 JSON（edges）：自己包成一张能点开看的网页，不然没法给人看。
      /** 解析出来的图数据。 */
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return undefined;
      }
      html = renderGraphHtml(data, query);
    }
    /** 存哪儿。 */
    const dir = path.join(runtimeDir, GRAPH_DIR);
    await fs.mkdir(dir, { recursive: true });
    /** 文件名：整张图固定一个名字，查某一块的带上名字。 */
    const file = path.join(dir, query ? `关系图_${query.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.html` : '关系图.html');
    await fs.writeFile(file, html, 'utf8');
    return file;
  } catch {
    //G 导图只是给人看的，失败了不能影响正事。
    return undefined;
  }
}


/**
 * 从 /graph 返回的 JSON 里抽出边（容错：没有 edges 就当空）。
 * @param data 解析后的 JSON。
 * @returns 边列表；src/dst 缺了的条目丢掉。
 */
function extractEdges(data: unknown): { src: string; dst: string; kind: string; weight: number | null }[] {
  /** 顶层。 */
  const record = data as { edges?: unknown };
  if (!Array.isArray(record?.edges)) {
    return [];
  }
  /** 抽出来的边。 */
  const out: { src: string; dst: string; kind: string; weight: number | null }[] = [];
  for (const raw of record.edges) {
    /** 这一条。 */
    const row = raw as { src?: unknown; dst?: unknown; kind?: unknown; weight?: unknown };
    /** 两端。 */
    const src = checks.optionalString(row.src, 'src');
    const dst = checks.optionalString(row.dst, 'dst');
    if (!src || !dst) {
      continue;
    }
    out.push({ src, dst, kind: checks.optionalString(row.kind, 'kind') ?? '', weight: typeof row.weight === 'number' ? row.weight : null });
  }
  return out;
}


/**
 * HTML 转义，防止文件名/符号里的尖括号把页面搞坏。
 * @param text 原文。
 * @returns 转义后的文字。
 */
function escapeHtml(text: string): string {
  /** 字符 → 实体。 */
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, (ch) => map[ch] ?? ch);
}


/**
 * 把 jmindex 的 /graph JSON（edges）包成一张能直接点开看的关系图网页。
 * 自带一个简单的力导向布局 + 可筛选的边表格，全部内联，不依赖外网。
 * @param data /graph 返回的 JSON。
 * @param query 看的是哪一块（不写就是整张图）。
 * @returns 完整的 HTML 文本。
 */
function renderGraphHtml(data: unknown, query?: string): string {
  /** 边。 */
  const edges = extractEdges(data);
  /** 出现过的节点。 */
  const ids = new Set<string>();
  for (const edge of edges) {
    ids.add(edge.src);
    ids.add(edge.dst);
  }
  /** 标题。 */
  const title = query ? `关系图 · ${query}` : '整张关系图';
  /** 嵌进页面的数据（< 转义，免得被当成 </script>）。 */
  const dataJson = JSON.stringify({ edges }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"Segoe UI",sans-serif;background:#0f1216;color:#e6e6e6;display:flex;flex-direction:column;height:100vh}
header{padding:10px 16px;border-bottom:1px solid #222;display:flex;gap:18px;align-items:baseline;flex-wrap:wrap}
header h1{font-size:16px;margin:0}header .stat{color:#8b98a5;font-size:13px}
main{flex:1;display:flex;min-height:0}canvas{flex:1;min-width:0;display:block}
#side{width:420px;max-width:45vw;border-left:1px solid #222;display:flex;flex-direction:column;min-height:0}
#find{margin:8px;padding:6px 8px;background:#171b21;border:1px solid #2a323c;color:#e6e6e6;border-radius:6px}
#tbl{overflow:auto;font-size:12px}table{border-collapse:collapse;width:100%}
td,th{padding:4px 8px;border-bottom:1px solid #1c222a;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:#12171d;color:#8b98a5}.k{color:#8b98a5}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
</style></head><body>
<header><h1>${escapeHtml(title)}</h1><span class="stat" id="stats">${String(edges.length)} 条边 / ${String(ids.size)} 个节点</span><span class="stat">右侧表格可筛选；图里只画度数最高的一部分</span></header>
<main><canvas id="c"></canvas><div id="side"><input id="find" placeholder="筛选 src / dst / 关系…"><div id="tbl"></div></div></main>
<script>
const DATA=${dataJson};
const A=DATA.edges;
const deg=new Map();
for(const e of A){deg.set(e.src,(deg.get(e.src)||0)+1);deg.set(e.dst,(deg.get(e.dst)||0)+1);}
const ids=[...deg.keys()].sort((a,b)=>deg.get(b)-deg.get(a));
const LIMIT=400;
const shown=new Set(ids.slice(0,LIMIT));
const nodes=new Map();
for(const id of shown){nodes.set(id,{id:id,x:(Math.random()-0.5)*500,y:(Math.random()-0.5)*500,vx:0,vy:0});}
const edges=A.filter(e=>shown.has(e.src)&&shown.has(e.dst));
const ns=[...nodes.values()];
const cv=document.getElementById('c'),ctx=cv.getContext('2d');
let W=0,H=0,DPR=window.devicePixelRatio||1;
function resize(){W=cv.clientWidth;H=cv.clientHeight;cv.width=W*DPR;cv.height=H*DPR;ctx.setTransform(DPR,0,0,DPR,0,0);}
window.addEventListener('resize',resize);resize();
function color(id){if(id.indexOf('file:')===0)return '#4aa3ff';if(id.indexOf('sym:')===0)return '#ffb454';return '#9aa7b4';}
function step(){
 for(let i=0;i<ns.length;i++){for(let j=i+1;j<ns.length;j++){const a=ns[i],b=ns[j];let dx=b.x-a.x,dy=b.y-a.y;let d2=dx*dx+dy*dy+0.01;if(d2>90000)continue;const f=9000/d2,d=Math.sqrt(d2)||1;dx/=d;dy/=d;a.vx-=dx*f;a.vy-=dy*f;b.vx+=dx*f;b.vy+=dy*f;}}
 for(const e of edges){const a=nodes.get(e.src),b=nodes.get(e.dst);if(!a||!b)continue;let dx=b.x-a.x,dy=b.y-a.y;let d=Math.sqrt(dx*dx+dy*dy)||0.01;const f=(d-80)*0.03;dx/=d;dy/=d;a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f;}
 for(const a of ns){a.vx-=a.x*0.002;a.vy-=a.y*0.002;a.vx*=0.86;a.vy*=0.86;a.x+=a.vx;a.y+=a.vy;}
}
function draw(){
 ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(W/2,H/2);
 ctx.strokeStyle='rgba(130,150,170,0.22)';ctx.lineWidth=0.6;
 for(const e of edges){const a=nodes.get(e.src),b=nodes.get(e.dst);if(!a||!b)continue;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
 for(const a of ns){ctx.fillStyle=color(a.id);ctx.beginPath();ctx.arc(a.x,a.y,2.6,0,6.2832);ctx.fill();}
 ctx.restore();
}
let tick=0;function loop(){step();draw();if(++tick<240)requestAnimationFrame(loop);}
requestAnimationFrame(loop);
document.getElementById('stats').textContent=(deg.size)+' 个节点 · '+A.length+' 条边'+(deg.size>LIMIT?'（图里只画度数最高的 '+LIMIT+' 个）':'');
const tbl=document.getElementById('tbl');
function esc(s){return String(s).replace(/[&<>]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':'&gt;';});}
function renderTable(f){f=(f||'').toLowerCase();const rows=A.filter(function(e){return !f||e.src.toLowerCase().indexOf(f)>=0||e.dst.toLowerCase().indexOf(f)>=0||(e.kind||'').toLowerCase().indexOf(f)>=0;});const cap=rows.slice(0,2000);let h='<table><thead><tr><th>src → dst</th><th>关系</th></tr></thead><tbody>';for(const e of cap){h+='<tr><td><span class="dot" style="background:'+color(e.src)+'"></span>'+esc(e.src)+'<br>→ '+esc(e.dst)+'</td><td class="k">'+esc(e.kind||'')+(e.weight==null?'':' '+e.weight)+'</td></tr>';}h+='</tbody></table>';if(rows.length>cap.length){h+='<p class="k" style="margin:8px">只列前 2000 条，共 '+rows.length+' 条</p>';}tbl.innerHTML=h;}
document.getElementById('find').addEventListener('input',function(ev){renderTable(ev.target.value);});
renderTable('');
</script></body></html>`;
}


/**
 * 从一条命中里取片段文字：老格式用 snippet/text，jmindex 真身用 snippets 数组里的 text 拼起来。
 * @param row 一条命中。
 * @returns 片段；都没有时是空串。
 */
function snippetOf(row: { snippet?: unknown; text?: unknown; snippets?: unknown }): string {
  /** 直接给的片段。 */
  const direct = checks.optionalString(row.snippet, 'snippet') ?? checks.optionalString(row.text, 'text');
  if (direct) {
    return direct;
  }
  if (Array.isArray(row.snippets)) {
    return row.snippets
      .map((part) => checks.optionalString((part as { text?: unknown }).text, 'snippets.text'))
      .filter((part): part is string => Boolean(part))
      .join('\n');
  }
  return '';
}


/**
 * 问 jmindex 要相关的文件。
 * @param baseUrl jmindex 地址。
 * @param query 要搜什么（一般就是任务原文）。
 * @param limit 最多几条。
 * @returns 搜到的；服务没起、超时、返回看不懂，都返回空数组（不抛错）。
 * 副作用：发一次 HTTP 请求。
 */
export async function search(baseUrl: string, query: string, limit: number): Promise<Found[]> {
  try {
    /** 搜索结果。 */
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return [];
    }
    /** 返回的 JSON。 */
    const body = (await response.json()) as { results?: unknown; hits?: unknown };
    //G jmindex 真身返回的顶层字段是 hits，老接口/测试里是 results——两种都认，别只认一种。
    /** 这一批命中。 */
    let rows: unknown[] = [];
    if (Array.isArray(body.results)) {
      rows = body.results;
    } else if (Array.isArray(body.hits)) {
      rows = body.hits;
    }
    return rows.flatMap((item) => {
      /** 这一条。 */
      const row = item as { path?: unknown; summary?: unknown; snippet?: unknown; text?: unknown; snippets?: unknown };
      /** 路径。 */
      const path = checks.optionalString(row.path, 'path');
      if (!path) {
        return [];
      }
      return [{
        path,
        summary: checks.optionalString(row.summary, 'summary') ?? '',
        snippet: snippetOf(row),
      }];
    });
  } catch {
    //G jmindex 没起来、超时、地址写错——都当成"没搜到"，不能挡住正事。
    return [];
  }
}


/**
 * 给决策模型看的那道题：这个文件对这件任务有没有帮助。
 * 写在代码里而不是 config.yaml，是因为选项的含义和下面的处理逻辑绑死了（改了选项就要改代码）。
 */
const QUESTION = {
  type: 'choice' as const,
  description: '这个文件对完成下面这件任务有没有帮助？',
  instructions: '只看给出的摘要和片段来判断，不要猜文件里还有什么。宁可判成"拿不准"，也不要把不相关的收进来占地方。',
  criteria: {
    keep: '直接有帮助：任务要改它、要照它的做法、或者答案就在里面',
    drop: '没帮助：讲的是别的事，塞进去只会占地方',
    look: '拿不准：看起来沾边但摘要和片段不够判断，值得再细看一眼',
  },
};


/**
 * 把概率和模型选的那一项合成最终判断。
 * @param helpful 有帮助的概率。
 * @param keepAbove 到多少算有帮助。
 * @param choice 决策模型选的那一项。
 * @returns 收下、扔掉，还是拿不准。无副作用。
 */
function verdictOf(helpful: number, keepAbove: number, choice: string): Picked['verdict'] {
  if (helpful >= keepAbove) {
    return 'keep';
  }
  //G 概率不够但模型自己说"拿不准"：留成 look，别直接扔——这正是用户要的第三条路。
  if (choice === 'look') {
    return 'look';
  }
  return 'drop';
}


/**
 * 把搜到的文件挨个交给决策模型筛一遍。
 * @param input 任务原文、搜到的文件、模型、判多少算有帮助。
 * @returns 每条带上概率和判断，按有帮助的概率从高到低。
 * 副作用：调决策模型（每个文件一次；决策模型很快很便宜）。
 */
export async function judgeFound(input: {
  task: string;
  found: Found[];
  ai: modelModule.Ai;
  keepAbove: number;
}): Promise<Picked[]> {
  //G 没配决策模型就不筛：搜到什么算什么，由调用方决定要不要用。
  if (!input.ai.hasDecision()) {
    return input.found.map((item) => ({ ...item, helpful: 0, verdict: 'look' as const }));
  }
  /** 筛过的。 */
  const picked: Picked[] = [];
  for (const item of input.found) {
    /** 这一次的判断。 */
    const decision = await input.ai.decide({
      state: { 任务: input.task, 文件: item.path, 这个文件讲什么: item.summary, 命中的片段: item.snippet },
      questions: { context_useful: QUESTION },
    });
    /** 回答。 */
    const answer = decision.answers.context_useful;
    if (decision.error || answer?.type !== 'choice') {
      //G 决策出错不扔文件：标成"拿不准"，交给调用方决定。
      picked.push({ ...item, helpful: 0, verdict: 'look' });
      continue;
    }
    /** 有帮助的概率。 */
    const helpful = answer.probabilities.keep ?? 0;
    picked.push({ ...item, helpful, verdict: verdictOf(helpful, input.keepAbove, answer.choice) });
  }
  return picked.sort((a, b) => b.helpful - a.helpful);
}


/**
 * 分派阶段挑上下文：搜 → 筛 → 拼成一段能直接塞进系统提示词的文字。
 * @param input 任务原文、模型、设置。
 * @returns 拼好的一段话和挑中的文件；jmindex 没配或没起来时返回空。
 * 副作用：发 HTTP 请求、调决策模型。
 */
export async function pickContext(input: {
  task: string;
  ai: modelModule.Ai;
  options: PickOptions;
}): Promise<{ text: string; picked: Picked[] }> {
  /** jmindex 地址。 */
  const baseUrl = input.options.baseUrl;
  if (!baseUrl) {
    return { text: '', picked: [] };
  }
  /** 搜到的。 */
  const found = await search(baseUrl, input.task, input.options.limit ?? DEFAULT_LIMIT);
  if (found.length === 0) {
    return { text: '', picked: [] };
  }
  /** 每条片段截短，别把上下文撑爆。 */
  const trimmed = found.map((item) => ({ ...item, snippet: item.snippet.slice(0, input.options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS) }));
  /** 筛过的。 */
  const picked = await judgeFound({ task: input.task, found: trimmed, ai: input.ai, keepAbove: input.options.keepAbove ?? DEFAULT_KEEP_ABOVE });
  /** 真要塞进去的。 */
  const keep = picked.filter((item) => item.verdict === 'keep');
  if (keep.length === 0) {
    return { text: '', picked };
  }
  return {
    text: [
      '下面几份文件是按这件任务搜出来、并且判断过确实相关的，先看它们再动手：',
      ...keep.map((item) => `- ${item.path}（${(item.helpful * 100).toFixed(0)}% 相关）${item.summary ? `：${item.summary}` : ''}`),
    ].join('\n'),
    picked,
  };
}
