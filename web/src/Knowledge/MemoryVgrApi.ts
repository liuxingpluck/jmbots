/**
 * 知识库「🧠 记忆与 VGR」视图接口封装：
 * 对接 /api/memory/* 与 /api/memory-graph/* 真实后端路由，沿用 jmbots 页面令牌；
 * 若线上 30086 尚未重启挂载新管理路由（vgr-config / items 回 404），自动平滑降级到已有的 health / backend / search 接口。
 */
import * as token from '../Token.ts';
import * as kbApi from './KnowledgeApi.ts';


/** 检索模式。 */
export type MemorySearchMode = 'hybrid' | 'semantic' | 'keyword' | 'graph';

/** 记忆来源。 */
export type MemorySourceKind = 'knowledge' | 'card' | 'history' | 'channel';

/** 长期记忆条归属类型。 */
export type MemoryItemScope = 'card' | 'knowledge';

/** 混合检索单条命中。 */
export interface MemoryUnifiedHit {
  source: MemorySourceKind;
  id: string;
  title: string;
  snippet: string;
  score: number;
  at: number;
  ref: string;
  via: string[];
  customer: string;
  bot: string;
  file?: string;
  where?: string;
  origin?: string;
  relations?: string[];
}

/** GET /api/memory/search 回包。 */
export interface MemoryUnifiedSearchResponse {
  mode: MemorySearchMode;
  hits: MemoryUnifiedHit[];
  unavailable: string[];
  skipped: string[];
  total_ms: number;
  relations?: string[];
  queryEntities?: string[];
  warnings?: string[];
}

/** Rust 记忆服务 /health 结构。 */
export interface RustMemoryHealth {
  url?: string;
  ok?: boolean;
  ms?: number;
  version?: string;
  runtime?: string;
  pid?: number;
  rssMb?: number;
  paused?: boolean;
  graph?: boolean;
  rerank?: boolean;
  defaultMode?: string;
  llm?: string;
  extractModel?: string;
  extractConcurrency?: number;
  error?: string;
  embedding?: {
    ready?: boolean;
    model?: string;
    dim?: number;
    error?: string;
  };
  counts?: {
    customers?: number;
    docs?: number;
    embedded?: number;
    entities?: number;
    relations?: number;
    history?: number;
    knowledge?: number;
    graphDone?: number;
    graphPending?: number;
    graphFailed?: number;
    graphSkipped?: number;
  };
}

/** VGR 与本地嵌入模型配置（memory.yaml 脱敏视图）。 */
export interface VgrConfigData {
  port: number;
  modelDir: string;
  modelDirResolved: string;
  modelDirExists: boolean;
  onnxruntime: string;
  onnxruntimeResolved: string;
  onnxruntimeExists: boolean;
  storeDir: string;
  storeDirResolved: string;
  storeDirExists: boolean;
  retrieval: {
    graph: boolean;
    defaultMode: 'hybrid' | 'graph';
    rerank: boolean;
    entityTopK: number;
    relationTopK: number;
    expansionDegree: number;
    finalTopK: number;
  };
  llm: {
    baseUrl: string;
    hasApiKey: boolean;
    model: string;
    extractModel: string;
    extractConcurrency: number;
    timeoutSecs: number;
  };
}

/** VGR 概览与配置总包。 */
export interface VgrOverviewResponse {
  ok: boolean;
  serviceUrl: string;
  filePath: string;
  fileExists: boolean;
  config: VgrConfigData;
  health: RustMemoryHealth;
  backend: Record<string, unknown>;
  restartHint?: string;
  /** 主服务尚未重启挂载 vgr-config 时的平滑兼容标记。 */
  legacyFallback?: boolean;
}

/** 更新 VGR 配置提交载荷。 */
export interface VgrConfigPatch {
  modelDir?: string;
  onnxruntime?: string;
  storeDir?: string;
  retrieval?: {
    graph?: boolean;
    defaultMode?: 'hybrid' | 'graph';
    rerank?: boolean;
    entityTopK?: number;
    relationTopK?: number;
    expansionDegree?: number;
    finalTopK?: number;
  };
  llm?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    extractModel?: string;
    extractConcurrency?: number;
    timeoutSecs?: number;
  };
}

/** 长期记忆条摘要。 */
export interface MemoryItemSummary {
  scope: MemoryItemScope;
  bot: string;
  path: string;
  title: string;
  preview: string;
  size: number;
  updatedAt: number;
}

/** 长期记忆条详情。 */
export interface MemoryItemDetail extends MemoryItemSummary {
  content: string;
}

/** 原文段落回包。 */
export interface PassageDetailResponse {
  passage?: {
    id: number;
    source: string;
    scope: string;
    title: string;
    text: string;
    start?: number;
    end?: number;
  } | null;
  relations?: Array<{ id?: number; text: string } | string>;
}


/** 通用带令牌 JSON 请求。 */
async function callJson<T>(urlPath: string, options?: RequestInit): Promise<T> {
  const fullUrl = token.withToken(urlPath, token.TOKEN);
  const res = await fetch(fullUrl, options);
  if (res.ok) {
    return res.json() as Promise<T>;
  }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('jmbots:unauthorized'));
  }
  const body = await res.json().catch(() => ({})) as { error?: string };
  let msg = body.error ?? `请求失败（${String(res.status)}）`;
  if (res.status === 403) {
    msg = '需要先登录验证本人身份后才能修改记忆与 VGR 配置';
  }
  throw new kbApi.KnowledgeError(res.status, msg);
}


/** 构造 JSON 写请求配置。 */
function jsonMethod(method: string, payload?: unknown): RequestInit {
  if (payload === undefined) return { method };

  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}


/** 1. 统一混合检索（支持 keyword / semantic / hybrid / graph 及多源过滤）。 */
export function searchUnifiedMemory(
  params: {
    q: string;
    mode: MemorySearchMode;
    sources: readonly MemorySourceKind[];
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<MemoryUnifiedSearchResponse> {
  const search = new URLSearchParams();
  search.set('q', params.q);
  search.set('mode', params.mode);
  if (params.sources.length > 0) {
    search.set('sources', params.sources.join(','));
  }
  search.set('limit', String(params.limit ?? 24));
  return callJson<MemoryUnifiedSearchResponse>(`/api/memory/search?${search.toString()}`, { signal });
}


/** 2. 按 ref 读取 Rust 段落完整原文与关系。 */
export function fetchPassageByRef(ref: string, signal?: AbortSignal): Promise<PassageDetailResponse> {
  return callJson<PassageDetailResponse>(ref, { signal });
}


/** 3. 读取 VGR 配置与引擎实时状态（404 时自动回退到 /api/memory/health + /backend）。 */
export async function fetchVgrOverview(signal?: AbortSignal): Promise<VgrOverviewResponse> {
  try {
    return await callJson<VgrOverviewResponse>('/api/memory/vgr-config', { signal });
  } catch (error) {
    if (!(error instanceof kbApi.KnowledgeError) || error.status !== 404) {
      throw error;
    }
    const [health, backend] = await Promise.all([
      callJson<RustMemoryHealth>('/api/memory/health', { signal }).catch((err: unknown): RustMemoryHealth => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })),
      callJson<Record<string, unknown>>('/api/memory/backend', { signal }).catch(() => ({})),
    ]);
    let defaultMode: 'hybrid' | 'graph' = 'hybrid';
    if (health.defaultMode === 'graph') {
      defaultMode = 'graph';
    }
    return {
      ok: true,
      legacyFallback: true,
      serviceUrl: health.url ?? 'http://127.0.0.1:30087',
      filePath: 'memory.yaml',
      fileExists: true,
      health,
      backend,
      config: {
        port: 30087,
        modelDir: 'program/models/bge-m3-int8',
        modelDirResolved: 'program/models/bge-m3-int8',
        modelDirExists: health.embedding?.ready === true,
        onnxruntime: 'program/onnxruntime/lib/onnxruntime.dll',
        onnxruntimeResolved: 'program/onnxruntime/lib/onnxruntime.dll',
        onnxruntimeExists: health.embedding?.ready === true,
        storeDir: 'data/memory',
        storeDirResolved: 'data/memory',
        storeDirExists: health.ok === true,
        retrieval: {
          graph: health.graph !== false,
          defaultMode,
          rerank: health.rerank !== false,
          entityTopK: 10,
          relationTopK: 10,
          expansionDegree: 2,
          finalTopK: 20,
        },
        llm: {
          baseUrl: '',
          hasApiKey: Boolean(health.llm),
          model: health.llm ?? '',
          extractModel: health.extractModel ?? '',
          extractConcurrency: health.extractConcurrency ?? 2,
          timeoutSecs: 180,
        },
      },
    };
  }
}


/** 4. 保存 VGR 与本地嵌入模型配置（写回 memory.yaml）。 */
export function saveVgrConfig(patch: VgrConfigPatch): Promise<VgrOverviewResponse> {
  return callJson<VgrOverviewResponse>('/api/memory/vgr-config', jsonMethod('PUT', patch));
}


/** 5. 强制刷新知识库向量切片索引，可选重抽失败图谱。 */
export function reindexMemory(retryGraph: boolean): Promise<{
  ok: boolean;
  syncError?: string;
  graphRetry?: { ok: boolean; retry: number; error?: string };
  health: RustMemoryHealth;
  backend: Record<string, unknown>;
}> {
  return callJson('/api/memory/reindex', jsonMethod('POST', { retryGraph }));
}


/** 6. 列出长期记忆条（404 时平滑返回空列表与升级提示）。 */
export async function listMemoryItems(
  scope: 'all' | MemoryItemScope,
  bot = '',
  signal?: AbortSignal,
): Promise<{ bots: string[]; items: MemoryItemSummary[]; legacyFallback?: boolean }> {
  const qs = new URLSearchParams();
  qs.set('scope', scope);
  if (bot !== '') {
    qs.set('bot', bot);
  }
  try {
    return await callJson(`/api/memory/items?${qs.toString()}`, { signal });
  } catch (error) {
    if (error instanceof kbApi.KnowledgeError && error.status === 404) {
      return { bots: [], items: [], legacyFallback: true };
    }
    throw error;
  }
}


/** 7. 读取单条长期记忆全文。 */
export async function getMemoryItemDetail(
  scope: MemoryItemScope,
  bot: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<MemoryItemDetail> {
  const qs = new URLSearchParams({ scope, path: relPath });
  if (bot !== '') {
    qs.set('bot', bot);
  }
  const res = await callJson<{ item: MemoryItemDetail }>(`/api/memory/items/detail?${qs.toString()}`, { signal });
  return res.item;
}


/** 8. 新增或更新长期记忆条（knowledge 在旧版未重启时兼容回退 POST /api/memory/knowledge）。 */
export async function saveMemoryItem(input: {
  scope: MemoryItemScope;
  bot: string;
  path: string;
  content: string;
}): Promise<{ item?: MemoryItemDetail; indexed: boolean; indexWarning?: string }> {
  try {
    return await callJson('/api/memory/items', jsonMethod('POST', input));
  } catch (error) {
    if (error instanceof kbApi.KnowledgeError && error.status === 404 && input.scope === 'knowledge') {
      await callJson('/api/memory/knowledge', jsonMethod('POST', {
        bot: input.bot,
        name: input.path,
        content: input.content,
      }));
      return { indexed: true };
    }
    throw error;
  }
}


/** 9. 删除长期记忆条。 */
export function deleteMemoryItem(input: {
  scope: MemoryItemScope;
  bot: string;
  path: string;
}): Promise<{ ok: boolean; deleted: string; syncWarning?: string }> {
  const qs = new URLSearchParams({ scope: input.scope, path: input.path });
  if (input.bot !== '') {
    qs.set('bot', input.bot);
  }
  return callJson(`/api/memory/items?${qs.toString()}`, jsonMethod('DELETE'));
}
