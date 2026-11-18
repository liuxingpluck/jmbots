/**
 * 搜记忆：本地按“相邻两个字一组”打分（不分词也能大致比出像不像），基地的记忆库用 RAG 搜（不行退回老搜索）。
 * 照 0.4 src/capabilities/Recall.ts 和 Context.ts 的 search、ragSearch、searchLibs、recall。都是函数，不建 class。
 * 设计：docs/src7插件设计/memory.md 第 4 节。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as cordis from 'cordis';


/** 本地搜最多给几个文件（开场先搜用）。 */
const MAX_FILES = 3;

/** 每个文件最多给几行。 */
const MAX_LINES = 3;

/** 每行最多多少字。 */
const LINE_CHARS = 160;

/** 一个文件至少对上几分才算相关：两个字一组 1 分，英文和数字的整词 2 分。 */
const MIN_HITS = 3;

/** 比这大的文件不看，字节。 */
const MAX_FILE_BYTES = 256 * 1024;

/** 不用再给的文件：记忆概要 prompt 插件已经整篇拼进去了。 */
const SKIP_NAMES = new Set(['索引.md', 'index.md']);

/** 问基地一次最多等多久。 */
const BASE_TIMEOUT_MS = 5000;

/** 开场先搜：记忆库最多给几条。 */
const RECALL_LIB_HITS = 5;

/** 开场先搜：拿原话的前多少字去搜。 */
const RECALL_QUERY_CHARS = 300;


/** 搜到的一个文件（本地），或记忆库的一条（file 是路径，lines 是摘要和片段）。 */
export interface RecallHit {
  file: string;
  score: number;
  lines: string[];
}

/** 记忆库搜到的一条。 */
export interface Found {
  path: string;
  summary: string;
  snippet: string;
}

/** 搜哪几个库；基地服务每次从 ctx 可选获取，避免受插件挂载顺序影响。 */
export interface Base {
  ctx: cordis.Context;
  libs: string;
}


/** 这个进程里已经催基地建过 RAG 索引的库：不反复催（0.4 MemorySearch.askedIndex）。 */
const askedIndex = new Set<string>();


/**
 * 一段话拆成“相邻两个字一组”的集合，英文和数字按整词（3 个字母以上）。
 * @param text 一段话。
 */
export function grams(text: string): Set<string> {
  const found = new Set<string>();
  //M 英文和数字单独成段（“给Claude留话”拆成“给”“claude”“留话”），别的字母和汉字连成一段。
  for (const run of text.toLowerCase().match(/[a-z0-9]+|(?:(?![a-z0-9])[\p{L}\p{N}])+/gu) ?? []) {
    if (/^[a-z0-9]+$/u.test(run)) {
      if (run.length >= 3) found.add(run);
      continue;
    }
    const chars = [...run];
    for (let index = 0; index + 1 < chars.length; index += 1) found.add(`${chars[index]}${chars[index + 1]}`);
  }
  return found;
}

/**
 * 截到 max 个字，截了加“…”（记忆的片段只是提示，不用写共多少字）。
 * @param text 一段字。
 * @param max 最多几个字。
 */
export function short(text: string, max: number): string {
  return [...text].length > max ? `${[...text].slice(0, max).join('')}…` : text;
}

/** 一组字算几分：整词 2 分，两个字一组 1 分。 */
function weight(gram: string): number {
  return /^[a-z0-9]+$/u.test(gram) ? 2 : 1;
}

/**
 * 一段字和问的话对上了几分。
 * @param wanted 问的话的字组。
 * @param text 一段字。
 */
export function matchScore(wanted: Set<string>, text: string): number {
  //M 把这段字拆成字组，对上问的话里的字组就按 weight 加分（整词 2 分、两个字 1 分）。
  return [...grams(text)].filter((gram) => wanted.has(gram)).reduce((sum, gram) => sum + weight(gram), 0);
}

/**
 * 一个文件夹下的 Markdown 文件（跳过记忆概要）；文件夹不存在就是空的。
 * @param root 文件夹。
 */
async function markdownFiles(root: string): Promise<string[]> {
  try {
    const names = await Array.fromAsync(new Bun.Glob('**/*.md').scan({ cwd: root, onlyFiles: true }));
    return names.filter((name) => !SKIP_NAMES.has(path.basename(name))).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

/**
 * 在几个文件夹里找和这段话最像的文件。
 * @param roots 文件夹。
 * @param query 原话。
 * @param options maxFiles 最多几个（默认 3）；loose 短话也算（字组全对上就算，memory 工具用）。
 * @returns 最像的几个，分数从高到低。
 */
export async function local(roots: string[], query: string, options: { maxFiles?: number; loose?: boolean } = {}): Promise<RecallHit[]> {
  //G 问的话切不出字组（比如只有两个字母）就没法搜，直接交回空。
  const wanted = grams(query);
  if (wanted.size === 0) return [];

  //M 够格的最低分：loose 时短话字组全对上也算（最多只要到 MIN_HITS），否则固定 MIN_HITS 分。
  const need = options.loose === true ? Math.min(MIN_HITS, [...wanted].reduce((sum, gram) => sum + weight(gram), 0)) : MIN_HITS;

  //M 逐个文件夹、逐个 Markdown 文件打分，分数不到 need 的丢掉。
  const hits: RecallHit[] = [];
  for (const root of roots) {
    for (const file of await markdownFiles(root)) {
      const text = await fs.stat(file).then((stat) => (stat.size <= MAX_FILE_BYTES ? fs.readFile(file, 'utf8') : ''), () => '');
      const matched = matchScore(wanted, text);
      if (matched < need) continue;

      //M 对上字组最多的几行，每行截到 160 字。
      const lines = text.split(/\r?\n/u)
        .map((line) => ({ line: line.trim(), hits: [...grams(line)].filter((gram) => wanted.has(gram)).length }))
        .filter((item) => item.line !== '' && item.hits > 0)
        .sort((left, right) => right.hits - left.hits)
        .slice(0, MAX_LINES)
        .map((item) => ([...item.line].length > LINE_CHARS ? `${[...item.line].slice(0, LINE_CHARS).join('')}…` : item.line));
      hits.push({ file, score: matched / Math.sqrt(text.length + 100), lines });
    }
  }
  return hits.sort((left, right) => right.score - left.score).slice(0, options.maxFiles ?? MAX_FILES);
}

/**
 * 搜到的写成一段（开场先搜放进系统提示词）。
 * @param hits 搜到的。
 * @param language 机器人的语言。
 * @returns 没搜到是 ''。
 */
export function describe(hits: RecallHit[], language: string): string {
  if (hits.length === 0) return '';

  const head = language === 'en'
    ? '# Possibly relevant memory (found by the program from this message; read the file if it helps, ignore it if not)'
    : '# 可能相关的记忆（程序按这次的话先搜的；有用就读那个文件，没用就不管）';
  return [head, '', ...hits.map((hit) => [`@${hit.file}`, ...hit.lines.map((line) => `  …${line}`)].join('\n'))].join('\n');
}


/**
 * 问基地一个 GET，交回 JSON。
 * @param base 用于获取基地服务的上下文和库名。
 * @param route 路径加查询串。
 * @returns 连不上、不是 200、看不懂都是 undefined（不抛错：基地没开不能挡正事）。
 */
export async function getJson(base: Base, route: string): Promise<Record<string, unknown> | undefined> {
  //M 地址、fetch 和超时都归 ctx.base；记忆只负责把不可用变成没有检索结果。
  const service = base.ctx.get('base');
  if (service === undefined) return undefined;
  try {
    const response = await service.getJson(route, BASE_TIMEOUT_MS);
    if (response.status < 200 || response.status >= 300) return undefined;
    const body = response.body;
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 给基地发一个 POST JSON。
 * @param base 用于获取基地服务的上下文和库名。
 * @param route 路径，如 /rag/index。
 * @param body 请求体，原样转成 JSON。
 * @returns 状态码；连不上是 undefined。
 */
export async function postJson(base: Base, route: string, body: unknown): Promise<number | undefined> {
  //M 摄取的 400、409 仍交给 Libs 判断；没配地址或断连用 undefined 表示跳过。
  const service = base.ctx.get('base');
  if (service === undefined) return undefined;
  try {
    const response = await service.postJson(route, body, BASE_TIMEOUT_MS);
    return response.status;
  } catch {
    return undefined;
  }
}

/** 取一个字符串字段，不是字符串就 undefined。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 基地的一条命中写成 Found：abs_path 优先，没有就“库名:相对路径”。
 * @param row 一条。
 * @param summary 摘要。
 * @param snippet 片段。
 */
function toFound(row: Record<string, unknown>, summary: string, snippet: string): Found[] {
  //M 路径、库名、绝对路径都用 str 取（不是字符串当没有）；没有路径的行没法引用，丢掉。
  const relative = str(row['path']);
  if (relative === undefined) return [];
  const lib = str(row['lib']);
  return [{ path: str(row['abs_path']) ?? (lib === undefined ? relative : `${lib}:${relative}`), summary, snippet }];
}

/**
 * 老搜索 GET /search：顶层认 hits、results 两种。
 * @returns 连不上是 []。
 */
async function oldSearch(base: Base, query: string, limit: number, lib: string): Promise<Found[]> {
  //M 问基地的老搜索；连不上、不是 200 时 body 是 undefined，下面就交回 []。
  const body = await getJson(base, `/search?q=${encodeURIComponent(query)}&limit=${String(limit)}&lib=${encodeURIComponent(lib)}`);
  const rows = Array.isArray(body?.['results']) ? body['results'] : Array.isArray(body?.['hits']) ? body['hits'] : [];

  //M 每条命中取摘要和片段（没有 snippet 退 text，再退各段 snippets 拼起来），转成 Found。
  return (rows as Record<string, unknown>[]).flatMap((row) => {
    const parts = Array.isArray(row['snippets']) ? (row['snippets'] as Record<string, unknown>[]).map((part) => str(part['text']) ?? '').filter((part) => part !== '') : [];
    return toFound(row, str(row['summary']) ?? '', str(row['snippet']) ?? str(row['text']) ?? parts.join('\n'));
  });
}

/**
 * RAG 搜 GET /rag/search。
 * @returns 片段和还没建索引的库；基地没有 RAG、连不上是 undefined。
 */
async function ragSearch(base: Base, query: string, limit: number, lib: string): Promise<{ found: Found[]; notIndexed: string[] } | undefined> {
  //M 问基地的 RAG 搜索；连不上、不是 200 时 body 是 undefined。
  const body = await getJson(base, `/rag/search?q=${encodeURIComponent(query)}&limit=${String(limit)}&lib=${encodeURIComponent(lib)}`);
  //G 回的东西里没有 hits 数组，说明基地没有 RAG（版本太老），交回 undefined 让调用方退回老搜索。
  if (!Array.isArray(body?.['hits'])) return undefined;

  //M 每条命中把行号和标题拼成摘要、正文当片段，转成 Found。
  const found =(body['hits'] as Record<string, unknown>[]).flatMap((row) => {
    const start = row['start_line'];
    const end = row['end_line'];
    const lines = typeof start === 'number' && typeof end === 'number' && start > 0 ? `第 ${String(start)}–${String(end)} 行` : '';
    return toFound(row, [lines, str(row['title']) ?? ''].filter((part) => part !== '').join(' · '), str(row['text']) ?? '');
  });
  const notIndexed = Array.isArray(body['not_indexed']) ? (body['not_indexed'] as unknown[]).filter((name): name is string => typeof name === 'string') : [];
  return { found, notIndexed };
}

/**
 * 搜记忆库：先 RAG；一条没有就拆成字组再搜一次；基地太老没有 RAG 就全用老搜索；
 * 有库还没建 RAG 索引，第一次碰到就催基地去建（后台跑），这次先用老搜索补上。
 * @param base 基地和库。
 * @param query 搜什么。
 * @param limit 最多几条。
 */
export async function searchLibs(base: Base, query: string, limit: number): Promise<Found[]> {
  //M 先走 RAG 搜；基地没有 RAG（交回 undefined）就整个退回老搜索。
  let rag = await ragSearch(base, query, limit, base.libs);
  if (rag === undefined) return oldSearch(base, query, limit, base.libs);

  //M 老基地把没空格的一串字当短语，整句常常一条也搜不到：拆成两个字一组、空格隔开再搜一次。
  const split = [...grams(query)].join(' ');
  if (rag.found.length === 0 && split !== '' && split !== query.trim().toLowerCase()) {
    const again = await ragSearch(base, split, limit, base.libs);
    rag = { found: again?.found ?? [], notIndexed: rag.notIndexed };
  }

  //M 没建索引的库：第一次碰到就让基地建（基地马上回，后台建）。
  const fresh = rag.notIndexed.filter((name) => !askedIndex.has(name));
  if (fresh.length > 0) {
    fresh.forEach((name) => askedIndex.add(name));
    void postJson(base, '/rag/index', { lib: fresh.join(',') });
  }

  //M 老搜索补上：RAG 一条也没有就补全部库，否则只补没建索引的。
  const rest = rag.found.length === 0 ? base.libs : rag.notIndexed.join(',');
  return rest === '' ? rag.found : [...rag.found, ...(await oldSearch(base, query, limit, rest))];
}

/**
 * 开场先搜也搜记忆库：原话前 300 字去搜 10 条，再按字组和原话对一遍，不到 3 分的丢（BM25 对什么话都给几条），最多 5 条。
 * @param base 基地和库；没配是 undefined → []。
 * @param query 原话。
 */
export async function libs(base: Base | undefined, query: string): Promise<RecallHit[]> {
  if (base === undefined) return [];

  //M 原话取前 300 字，拆成字组，多要一倍条数去搜记忆库（searchLibs），下面再按字组筛。
  const asked = [...query].slice(0, RECALL_QUERY_CHARS).join('');
  const wanted = grams(asked);
  const found = await searchLibs(base, asked, RECALL_LIB_HITS * 2);

  //M 每条按字组和原话对分，不到 3 分的丢，最多 5 条，写成和本地命中一样的形状（file、score、lines）。
  return found
    .map((item) => ({ item, score: matchScore(wanted, `${item.summary}\n${item.snippet}`) }))
    .filter((entry) => entry.score >= MIN_HITS)
    .slice(0, RECALL_LIB_HITS)
    .map((entry) => ({
      file: entry.item.path,
      score: entry.score,
      lines: [entry.item.summary, short(entry.item.snippet.replace(/\s+/gu, ' ').trim(), LINE_CHARS)].filter((line) => line !== ''),
    }));
}
