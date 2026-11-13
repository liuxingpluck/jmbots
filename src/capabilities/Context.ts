/**
 * 记忆库搜索（docs/10 3.3、6.7；docs/界面/03_进度事件和复盘设计.md 第 5 节）：调基地的接口，搜 config 的 engine.memory_libs 列的库。
 * memory 工具的 search 走这里：先用基地的 RAG（分词 + BM25，整句也能搜到）；基地太老没有 RAG、库还没建 RAG 索引时，用 memorycli 原来的搜索。
 * 开会话先搜时也搜一次记忆库（MemorySearch.recall）。连不上、没配都当“没搜到”，不挡别的结果。
 * 索引跟着改动走：每隔几秒看一次库目录里文件的修改时间，变了就让基地增量摄取、建 RAG 索引；另外每半小时整轮刷一次兜底。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as resourcesModule from '../resources/Resources.ts';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import * as recallModule from './Recall.ts';


/** 搜一次最多等多久（memorycli 是本机服务，正常几十毫秒）。 */
const SEARCH_TIMEOUT_MS = 5000;

/** 启动后等多久第一次刷新索引，毫秒。 */
const FIRST_REFRESH_MS = 60_000;

/** 多久整轮刷新一次索引，毫秒（兜底：没记着目录、太大不扫的库靠它；没变的文件基地会跳过）。 */
const REFRESH_MS = 30 * 60_000;

/** 多久看一次库目录里文件的修改时间，毫秒（用户 11-06：每隔几秒按文件时间戳自动更新）。 */
const SCAN_MS = 5000;

/** 同一个库两次刷新至少隔多久，毫秒（有文件一直在变时，不至于不停地摄取）。 */
const GAP_MS = 60_000;

/** 扫文件最多占多少时间：下一次至少隔“扫一遍用时”的这么多倍（大库在慢盘上扫一遍要好几秒，就扫得慢一点）。 */
const SCAN_SLOWDOWN = 10;

/** 文件比这多的库不扫（扫一遍要好几秒），只靠整轮刷新。 */
const SCAN_MAX_FILES = 10_000;

/** 扫的时候跳过的文件夹（依赖、编译产物，以及点开头的隐藏文件夹）。 */
const SCAN_SKIP = new Set(['node_modules', 'target', 'dist', '__pycache__']);

/** 开会话先搜时，记忆库最多给几条（用户 11-06：“rag搜索 我觉得搞多点吧”）。 */
const RECALL_LIB_HITS = 5;

/** 开会话先搜时，拿原话的前多少字去搜记忆库（太长的网址基地收不下）。 */
const RECALL_QUERY_CHARS = 300;

/** 等摄取做完时多久问一次，毫秒。 */
const POLL_MS = 5000;

/** 一个库的摄取最多等多久，毫秒。 */
const INGEST_WAIT_MS = 30 * 60_000;


/** 搜出来的一条。 */
export interface Found {
  /** 文件路径：有绝对路径就是绝对路径；没有时多库下前面标上库名。 */
  path: string;

  /** 这个文件讲什么：memorycli 里的 AI 摘要；RAG 的是行号和块标题；都没有就是空。 */
  summary: string;

  /** 命中的片段，已经截短过。 */
  snippet: string;
}


/** RAG 检索的结果。 */
export interface RagFound {
  /** 片段，分数高的在前。 */
  found: Found[];

  /** 还没建 RAG 索引的库。 */
  notIndexed: string[];
}


/**
 * 去掉地址末尾的斜杠。
 * @param baseUrl 基地地址。
 */
function trimUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}


/**
 * 一条命中里的片段：snippet、text，或者 snippets 数组拼起来。
 * @param row memorycli 返回的一条。
 * @returns 片段；都没有时是空字符串。
 */
function snippetOf(row: { snippet?: unknown; text?: unknown; snippets?: unknown }): string {
  /** 直接给的。 */
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
 * 问 memorycli 的 /search。
 * @param baseUrl memorycli 地址（config 的 engine.index_url）。
 * @param query 要搜什么。
 * @param limit 最多几条。
 * @param lib 搜哪几个库，逗号连着写（如 “memory,aiskills”）；不写搜全部库。
 * @returns 搜到的；服务没起、超时、返回看不懂，都返回空数组（不抛错）。
 * 副作用：发一次 HTTP 请求。
 */
export async function search(baseUrl: string, query: string, limit: number, lib?: string): Promise<Found[]> {
  try {
    /** 地址。 */
    const url = `${trimUrl(baseUrl)}/search?q=${encodeURIComponent(query)}&limit=${String(limit)}${lib ? `&lib=${encodeURIComponent(lib)}` : ''}`;
    /** 回应。 */
    const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!response.ok) {
      return [];
    }
    /** 返回的 JSON：memorycli 的顶层是 hits，老接口是 results，两种都认。 */
    const body = (await response.json()) as { results?: unknown; hits?: unknown };
    /** 命中。 */
    let rows: unknown[] = [];
    if (Array.isArray(body.results)) {
      rows = body.results;
    } else if (Array.isArray(body.hits)) {
      rows = body.hits;
    }
    return rows.flatMap((item) => {
      /** 这一条。 */
      const row = item as { path?: unknown; abs_path?: unknown; lib?: unknown; summary?: unknown; snippet?: unknown; text?: unknown; snippets?: unknown };
      /** 相对库根目录的路径。 */
      const relative = checks.optionalString(row.path, 'path');
      if (!relative) {
        return [];
      }
      /** 哪个库。 */
      const libName = checks.optionalString(row.lib, 'lib');
      return [{
        path: checks.optionalString(row.abs_path, 'abs_path') ?? (libName ? `${libName}:${relative}` : relative),
        summary: checks.optionalString(row.summary, 'summary') ?? '',
        snippet: snippetOf(row),
      }];
    });
  } catch {
    //G memorycli 没起来、超时、地址写错——都当成“没搜到”，不能挡住正事。
    return [];
  }
}


/**
 * 问基地的 /rag/search：用户的话切成词，哪个词命中都算分（BM25），整句也能搜到。
 * @param baseUrl 基地地址（config 的 engine.index_url）。
 * @param query 要搜什么。
 * @param limit 最多几条。
 * @param lib 搜哪几个库，逗号连着写。
 * @returns 片段和还没建 RAG 索引的库；基地没起来、太老没有 RAG、返回看不懂，都是 undefined（不抛错）。
 * 副作用：发一次 HTTP 请求。
 */
export async function ragSearch(baseUrl: string, query: string, limit: number, lib: string): Promise<RagFound | undefined> {
  try {
    /** 地址。 */
    const url = `${trimUrl(baseUrl)}/rag/search?q=${encodeURIComponent(query)}&limit=${String(limit)}&lib=${encodeURIComponent(lib)}`;
    /** 回应。 */
    const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!response.ok) {
      return undefined;
    }
    /** 返回的 JSON（基地 local/src/rag.rs 的 RagOut）。 */
    const body = (await response.json()) as { hits?: unknown; not_indexed?: unknown };
    if (!Array.isArray(body.hits)) {
      return undefined;
    }
    /** 片段。 */
    const found = body.hits.flatMap((item) => {
      /** 这一条。 */
      const row = item as { path?: unknown; abs_path?: unknown; lib?: unknown; title?: unknown; start_line?: unknown; end_line?: unknown; text?: unknown };
      /** 相对库根目录的路径。 */
      const relative = checks.optionalString(row.path, 'path');
      if (!relative) {
        return [];
      }
      /** 哪个库。 */
      const libName = checks.optionalString(row.lib, 'lib');
      /** 第几行到第几行（基地没给就不写）。 */
      const lines = typeof row.start_line === 'number' && typeof row.end_line === 'number' && row.start_line > 0 ? `第 ${String(row.start_line)}–${String(row.end_line)} 行` : '';
      return [{
        path: checks.optionalString(row.abs_path, 'abs_path') ?? (libName ? `${libName}:${relative}` : relative),
        summary: [lines, checks.optionalString(row.title, 'title') ?? ''].filter(Boolean).join(' · '),
        snippet: checks.optionalString(row.text, 'text') ?? '',
      }];
    });
    /** 还没建索引的库。 */
    const notIndexed = Array.isArray(body.not_indexed) ? body.not_indexed.filter((name): name is string => typeof name === 'string') : [];
    return { found, notIndexed };
  } catch {
    //G 基地没起来、超时、返回看不懂：交给调用方退回老的搜索。
    return undefined;
  }
}


/**
 * 发一个 POST，带 JSON。
 * @param baseUrl 基地地址。
 * @param route 路径，如 /rag/index。
 * @param body 请求体。
 * @returns 状态码；连不上是 undefined（不抛错）。
 * 副作用：发一次 HTTP 请求。
 */
async function postJson(baseUrl: string, route: string, body: unknown): Promise<number | undefined> {
  try {
    /** 回应。 */
    const response = await fetch(`${trimUrl(baseUrl)}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}


/**
 * 记忆库搜索：搜 config 的 engine.memory_libs 列的库（先 RAG，不行退回老搜索），
 * 并记着“这个进程里已经让基地建过 RAG 索引的库”，不反复催。
 * 谁建：入口 src/entries/App.ts 建一个，传给 ToolBox（memory 工具）和 SessionRunner（开场召回）。
 */
export class MemorySearch {
  /** 这个进程里已经让基地建过 RAG 索引的库：不反复催，漏了的等定时刷新。 */
  private readonly askedIndex = new Set<string>();

  /**
   * @param resources 资源（recall 从这里读 engine.index_url、engine.memory_libs）；src/entries/App.ts 建的那个。
   */
  constructor(private readonly resources: resourcesModule.Resources) {}

  /**
   * 搜记忆库：先用 RAG；一条也没搜到就把整句拆开再搜一次；基地太老没有 RAG、拆开也没搜到，
   * 就全用老的搜索；有库还没建 RAG 索引，就让基地去建，这次那几个库先用老的搜索补上。
   * @param baseUrl 基地地址（config 的 engine.index_url）。
   * @param query 要搜什么。
   * @param limit 最多几条。
   * @param lib 搜哪几个库，逗号连着写（config 的 engine.memory_libs）。
   * @returns 搜到的，RAG 的在前；连不上、都没搜到是空数组。
   * 副作用：发一到四次 HTTP 请求；第一次碰到没建 RAG 索引的库，让基地在后台建。
   */
  async searchLibs(baseUrl: string, query: string, limit: number, lib: string): Promise<Found[]> {
    /** RAG 的结果。 */
    let rag = await ragSearch(baseUrl, query, limit, lib);
    if (!rag) {
      return search(baseUrl, query, limit, lib);
    }
    //M 老基地把没空格的一串字当短语（字要挨着出现），整句常常一条也搜不到：
    //  拆成两个字一组、用空格隔开再搜一次。新基地第一次就能搜到，走不到这里。
    /** 拆开的话。 */
    const split = [...recallModule.grams(query)].join(' ');
    if (rag.found.length === 0 && split && split !== query.trim().toLowerCase()) {
      /** 拆开搜的结果。 */
      const again = await ragSearch(baseUrl, split, limit, lib);
      rag = { found: again?.found ?? [], notIndexed: rag.notIndexed };
    }
    //M 没建索引的库：第一次碰到就让基地建（后台跑，马上返回）。
    /** 这个进程还没催过的。 */
    const fresh = rag.notIndexed.filter((name) => !this.askedIndex.has(name));
    if (fresh.length > 0) {
      fresh.forEach((name) => this.askedIndex.add(name));
      void postJson(baseUrl, '/rag/index', { lib: fresh.join(',') });
    }
    //M 用老的搜索补上：RAG 一条也没搜到（老基地把整句当短语，常常搜不到）就补全部库，
    //  否则只补没建索引的库。
    /** 要补的库。 */
    const rest = rag.found.length === 0 ? lib : rag.notIndexed.join(',');
    return rest ? [...rag.found, ...(await search(baseUrl, query, limit, rest))] : rag.found;
  }

  /**
   * 开会话先搜时也搜记忆库：用 searchLibs 搜，再按“两个字一组”和原话对一遍，
   * 对上不到 3 分的丢掉（BM25 对什么话都会给几条，碰巧对上的不要）。
   * @param query 用户的原话。
   * @returns 写成 RecallHit 的几条（file 是路径，lines 是行号和块标题、片段），最多 5 条；
   *   没配、连不上、都对不上是空的。
   * 副作用：同 searchLibs。
   */
  async recall(query: string): Promise<recallModule.RecallHit[]> {
    //G 没配基地地址或库就不搜。
    /** 基地地址。 */
    const indexUrl = this.resources.getSetting('indexUrl');
    /** 要搜的库。 */
    const libs = this.resources.getSetting('memoryLibs');
    if (!indexUrl || !libs) {
      return [];
    }
    //M 拿原话的前若干字去搜，多取一倍再按字组打分筛。
    /** 拿去搜的话。 */
    const asked = [...query].slice(0, RECALL_QUERY_CHARS).join('');
    /** 原话的字组。 */
    const wanted = recallModule.grams(asked);
    /** 搜到的。 */
    const found = await this.searchLibs(indexUrl, asked, RECALL_LIB_HITS * 2, libs);
    return found
      .map((item) => {
        /** 和原话的字组对上几分。 */
        const score = recallModule.matchScore(wanted, `${item.summary}\n${item.snippet}`);
        return { item, score };
      })
      .filter((entry) => entry.score >= 3)
      .slice(0, RECALL_LIB_HITS)
      .map((entry) => ({
        file: entry.item.path,
        score: entry.score,
        lines: [
          entry.item.summary,
          utils.truncate(entry.item.snippet.replace(/\s+/g, ' ').trim(), 160),
        ].filter(Boolean),
      }));
  }
}


/**
 * 等基地把一个库摄取完：每隔一会儿问一次，问不到、做完了、等太久都返回。
 * @param baseUrl 基地地址。
 * @param lib 库名。
 * @param pollMs 多久问一次。
 * 副作用：发若干次 HTTP 请求。
 */
async function waitIngest(baseUrl: string, lib: string, pollMs: number): Promise<void> {
  /** 最晚等到什么时候。 */
  const deadline = Date.now() + INGEST_WAIT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(pollMs);
    /** 这个库的摄取（memorycli 的 GET /ingest：{ lib, job: { running, ... } }）。 */
    const body = await fetch(`${trimUrl(baseUrl)}/ingest?lib=${encodeURIComponent(lib)}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })
      .then((response) => (response.ok ? (response.json() as Promise<{ job?: { running?: unknown } | null }>) : undefined))
      .catch(() => undefined);
    if (body?.job?.running !== true) {
      return;
    }
  }
}


/**
 * 刷新记忆库的索引：每个库先让基地增量摄取（不打 AI 标签，不花钱），做完再增量建 RAG 索引。没变的文件基地会跳过。
 * @param baseUrl 基地地址（config 的 engine.index_url）。
 * @param lib 哪几个库，逗号连着写（config 的 engine.memory_libs）。
 * @param pollMs 等摄取时多久问一次（测试可以给小的）。
 * @returns 出了问题的库，每个一句话；都好就是空的。
 * 副作用：基地写那几个库的数据库和 RAG 索引。
 */
export async function refreshLibs(baseUrl: string, lib: string, pollMs = POLL_MS): Promise<string[]> {
  /** 出了问题的。 */
  const problems: string[] = [];
  for (const name of lib.split(',').map((part) => part.trim()).filter(Boolean)) {
    //M 先摄取：开始了（200）或者已经在摄取（409）就等它做完；库没记着目录（400，老库）就直接建 RAG 索引。
    /** 摄取的状态码。 */
    const ingest = await postJson(baseUrl, '/ingest', { lib: name, ai: false });
    if (ingest === undefined) {
      //G 基地连不上：后面的库也不用试了。
      problems.push(`${name}：基地连不上`);
      break;
    }
    if (ingest === 200 || ingest === 409) {
      await waitIngest(baseUrl, name, pollMs);
    } else if (ingest !== 400) {
      problems.push(`${name}：摄取没开始（${String(ingest)}）`);
    }
    /** 建 RAG 索引的状态码。 */
    const rag = await postJson(baseUrl, '/rag/index', { lib: name });
    if (rag !== 200) {
      problems.push(`${name}：RAG 索引没开始建（${rag === undefined ? '连不上' : String(rag)}）`);
    }
  }
  return problems;
}


/**
 * 一个文件夹的“指纹”：文件个数，加上每个文件的大小和修改时间，任何文件增、删、改都会让它变。跳过依赖、编译产物和点开头的文件夹。
 * @param root 文件夹。
 * @param maxFiles 文件超过这么多就不算了（扫一遍太慢）。
 * @returns 指纹；文件太多、文件夹读不了是 undefined。
 * 副作用：只读文件夹。
 */
export async function folderStamp(root: string, maxFiles = SCAN_MAX_FILES): Promise<string | undefined> {
  /** 还没看的文件夹。 */
  const dirs = [root];
  /** 文件个数、修改时间之和、大小之和、最晚的修改时间。 */
  let [count, mtimes, sizes, latest] = [0, 0, 0, 0];
  try {
    for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        /** 完整路径。 */
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SCAN_SKIP.has(entry.name)) {
            dirs.push(full);
          }
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        count += 1;
        if (count > maxFiles) {
          return undefined;
        }
        /** 这个文件（看的时候刚好被删了就跳过）。 */
        const stat = await fs.stat(full).catch(() => undefined);
        mtimes += stat?.mtimeMs ?? 0;
        sizes += stat?.size ?? 0;
        latest = Math.max(latest, stat?.mtimeMs ?? 0);
      }
    }
  } catch {
    return undefined;
  }
  return `${String(count)}:${String(latest)}:${String(mtimes)}:${String(sizes)}`;
}


/**
 * 问基地每个库的根目录和文件数（GET /health）。
 * @param baseUrl 基地地址。
 * @returns 库名 → 根目录（没记着是 undefined）和文件数；连不上、看不懂是 undefined。
 * 副作用：发一次 HTTP 请求。
 */
async function libRoots(baseUrl: string): Promise<Map<string, { root?: string; files: number }> | undefined> {
  try {
    /** 回应。 */
    const response = await fetch(`${trimUrl(baseUrl)}/health`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!response.ok) {
      return undefined;
    }
    /** 返回的 JSON（memorycli 的 /health：{ libs: [{ name, root, totals: { files } }] }）。 */
    const body = (await response.json()) as { libs?: { name?: unknown; root?: unknown; totals?: { files?: unknown } }[] };
    return new Map((body.libs ?? []).flatMap((lib) => (typeof lib.name === 'string'
      ? [[lib.name, { root: typeof lib.root === 'string' ? lib.root : undefined, files: typeof lib.totals?.files === 'number' ? lib.totals.files : 0 }] as const]
      : [])));
  } catch {
    return undefined;
  }
}


/** 定时刷新的几个间隔（毫秒），测试可以给小的。 */
export interface RefreshTiming {
  /** 启动后等多久第一次整轮刷新。 */
  firstMs: number;
  /** 多久整轮刷新一次。 */
  refreshMs: number;
  /** 多久看一次文件的修改时间。 */
  scanMs: number;
  /** 同一个库两次刷新至少隔多久。 */
  gapMs: number;
  /** 等摄取时多久问一次。 */
  pollMs: number;
}


/** 一个库的扫描状态。 */
interface LibWatch {
  /** 库的根目录（基地 /health 给的）；没记着、文件太多就不扫。 */
  root?: string;
  /** 上次刷新时的指纹。 */
  refreshed?: string;
  /** 上一次扫到的指纹。 */
  last?: string;
  /** 上次刷新的时刻，毫秒。 */
  refreshedAt: number;
}


/**
 * 记忆库索引的定时刷新：让记忆库的索引跟着改动走（engine.memory_libs 列的库）。
 * 启动一分钟后整轮刷一次（顺便问各库的根目录），之后每半小时一次兜底；
 * 平时每 5 秒看一次库目录里文件的修改时间（扫一遍用时长的话，间隔拉长到用时的 10 倍），
 * 变了、又稳住了一轮（写完了）、离这个库上次刷新超过一分钟，就只刷这个库。
 * 同一时间只刷一个。没配基地、没配库就什么也不做。
 * 谁建：入口 src/entries/App.ts 建一个，启动时调 start；测试给小的间隔。
 */
export class IndexRefresher {
  /** 几个间隔（不写的用默认值）。 */
  private readonly timing: RefreshTiming;

  /** 每个库的扫描状态。 */
  private readonly watches = new Map<string, LibWatch>();

  /** 上次整轮刷新的时刻；0 是还没刷过。 */
  private roundAt = 0;

  /** 停了没有。 */
  private stopped = false;

  /** 下一次的定时器。 */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param resources 资源（读 engine.index_url、engine.memory_libs）；src/entries/App.ts 建的那个。
   * @param timing 几个间隔，不写用默认的（测试可以给小的）。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    timing: Partial<RefreshTiming> = {},
  ) {
    this.timing = {
      firstMs: FIRST_REFRESH_MS,
      refreshMs: REFRESH_MS,
      scanMs: SCAN_MS,
      gapMs: GAP_MS,
      pollMs: POLL_MS,
      ...timing,
    };
  }

  /**
   * 开始：约好第一次。
   * 副作用：起一个一直跑的定时器；读库目录；让基地摄取、建索引；出了问题打一行日志。
   */
  start(): void {
    this.stopped = false;
    this.timer = setTimeout(() => this.loop(), this.timing.firstMs);
  }

  /**
   * 停下（测试用）。
   */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /**
   * 有问题就打一行日志。
   * @param problems 出了问题的库，每个一句话。
   */
  private report(problems: string[]): void {
    if (problems.length > 0) {
      console.error(`${utils.formatTime()} 记忆库索引没刷新好：${problems.join('；')}`);
    }
  }

  /**
   * 看一次，再约下一次；出错不能让它停下。
   */
  private loop(): void {
    void this.tick()
      .catch((error: unknown) => {
        console.error(`${utils.formatTime()} 记忆库索引刷新出错：${utils.errorText(error)}`);
        return 0;
      })
      .then((cost) => {
        if (!this.stopped) {
          /** 下一次隔多久：至少 scanMs；扫得慢就拉长。 */
          const waitMs = Math.max(this.timing.scanMs, cost * SCAN_SLOWDOWN);
          this.timer = setTimeout(() => this.loop(), waitMs);
        }
      });
  }

  /**
   * 看一次。
   * @returns 这次扫文件用了多少毫秒（定下一次隔多久）。
   */
  private async tick(): Promise<number> {
    //G 没配基地地址或库就什么也不做。
    /** 基地地址。 */
    const indexUrl = this.resources.getSetting('indexUrl');
    /** 要刷的库。 */
    const names = (this.resources.getSetting('memoryLibs') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!indexUrl || names.length === 0) {
      return 0;
    }
    //M 到点整轮刷新，否则只看文件的修改时间。
    if (this.roundAt === 0 || Date.now() - this.roundAt >= this.timing.refreshMs) {
      await this.refreshRound(indexUrl, names);
      return 0;
    }
    return this.scanChanged(indexUrl, names);
  }

  /**
   * 整轮刷新：先问各库的根目录、记下刷新前的指纹，再刷全部。
   * @param indexUrl 基地地址。
   * @param names 要刷的库。
   * 副作用：改扫描状态；让基地摄取、建索引。
   */
  private async refreshRound(indexUrl: string, names: string[]): Promise<void> {
    this.roundAt = Date.now();
    /** 各库的根目录。 */
    const roots = await libRoots(indexUrl);
    for (const name of names) {
      /** 这个库。 */
      const info = roots?.get(name);
      /** 扫不扫：有根目录、文件不太多。 */
      const root = info?.root && info.files <= SCAN_MAX_FILES ? info.root : undefined;
      /** 刷新前的指纹。 */
      const stamp = root ? await folderStamp(root) : undefined;
      this.watches.set(name, { root, refreshed: stamp, last: stamp, refreshedAt: Date.now() });
    }
    this.report(await refreshLibs(indexUrl, names.join(','), this.timing.pollMs));
  }

  /**
   * 平时只看文件的修改时间：变了、又稳住了一轮、离上次刷新够久，就只刷这个库。
   * @param indexUrl 基地地址。
   * @param names 要看的库。
   * @returns 这次扫文件用了多少毫秒。
   * 副作用：改扫描状态；让基地摄取、建索引。
   */
  private async scanChanged(indexUrl: string, names: string[]): Promise<number> {
    /** 扫文件用的毫秒。 */
    let cost = 0;
    for (const name of names) {
      /** 这个库的扫描状态。 */
      const watch = this.watches.get(name);
      if (!watch?.root) {
        continue;
      }
      /** 开始扫的时刻。 */
      const began = Date.now();
      /** 这次的指纹。 */
      const stamp = await folderStamp(watch.root);
      cost += Date.now() - began;
      /** 变了、又稳住了一轮。 */
      const settled = stamp && stamp !== watch.refreshed && stamp === watch.last;
      if (settled && Date.now() - watch.refreshedAt >= this.timing.gapMs) {
        watch.refreshed = stamp;
        watch.refreshedAt = Date.now();
        this.report(await refreshLibs(indexUrl, name, this.timing.pollMs));
      }
      watch.last = stamp;
    }
    return cost;
  }
}
