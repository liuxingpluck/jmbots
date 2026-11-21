/**
 * 积木知识库页面的接口封装：/api/knowledge/* 十八个接口，沿用 jmbots 的页面令牌。
 * 401 广播 jmbots:unauthorized（AuthGate 弹登录）；403 抛 KnowledgeError，页面据此切成只读；
 * 保存带 baseUpdatedAt，别处改过时后端回 409，这里交回 { conflict: true, doc } 让页面换成最新的。
 */
import type * as types from '../../../src7/plugins/knowledge/Types.ts';
import * as token from '../Token.ts';

//M 页面各文件用到的后端类型，在这里起别名转出去。
//M   不写 export type { … } from '…/src7/…'：Bun 打包不擦这种转出，会把 src7 算进入口的公共根，产物多套一层 web/。
export type KnowledgeDir = types.KnowledgeDir;
export type KnowledgeDirNode = types.KnowledgeDirNode;
export type KnowledgeDoc = types.KnowledgeDoc;
export type KnowledgeDocSummary = types.KnowledgeDocSummary;
export type KnowledgeMemoryHit = types.KnowledgeMemoryHit;
export type KnowledgeSearchHit = types.KnowledgeSearchHit;
export type KnowledgeSourceType = types.KnowledgeSourceType;
export type KnowledgeTreeResponse = types.KnowledgeTreeResponse;
export type KnowledgeTagMode = types.KnowledgeTagMode;
export type KnowledgeLinksResponse = types.KnowledgeLinksResponse;
export type KnowledgeGraphResponse = types.KnowledgeGraphResponse;
export type KnowledgeGraphNode = types.KnowledgeGraphNode;
export type KnowledgeGraphEdge = types.KnowledgeGraphEdge;
export type KnowledgeDisambiguateResponse = types.KnowledgeDisambiguateResponse;
export type KnowledgeSyncResult = types.KnowledgeSyncResult;
export type KnowledgeSyncStatusResponse = types.KnowledgeSyncStatusResponse;

const BASE = '/api/knowledge';

/** 只查未归目录文档时 dirId 传的值（Types.ts DocListFilter.dirId 的约定）。 */
export const UNASSIGNED = '__unassigned__';

/** 接口出错：带状态码，页面按 403 切只读。 */
export class KnowledgeError extends Error {
  /**
   * @param status HTTP 状态码。
   * @param message 给人看的一句话。
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET /api/knowledge/docs 的分页结果。 */
export interface DocPage {
  /** 本页文档摘要。 */
  items: types.KnowledgeDocSummary[];
  /** 满足筛选的总数。 */
  total: number;
  /** 本页上限。 */
  limit: number;
  /** 本页偏移。 */
  offset: number;
}

/** 列表筛选：目录、标签、专题、偏移；都可不填。 */
export interface DocQuery {
  /** 目录号；UNASSIGNED 只看未归类。 */
  dirId?: string;
  /** 标签名（一个时照旧发 tag，多个时发 tags=a,b），多个时按 tagMode 组合。 */
  tags?: string[];
  /** 多个标签怎么组合：all 全部满足、any 任一满足；只在选了两个以上标签时发。 */
  tagMode?: types.KnowledgeTagMode;
  /** 只看硬性系统规则。 */
  systemRule?: boolean;
  /** 工作决策节点号。 */
  topicId?: string;
  /** 分页偏移。 */
  offset?: number;
  /** 这一页拉几条；不写是 PAGE_SIZE。切回页面按已显示的条数刷新时用。 */
  limit?: number;
}

/** 列表一页几条。 */
export const PAGE_SIZE = 50;

/** 保存的结果：conflict 为 true 时 doc 是库里最新的（别处先改过）。 */
export interface SaveResult {
  /** 是不是冲突没存上。 */
  conflict: boolean;
  /** 存好的文档，或冲突时库里最新的文档。 */
  doc: types.KnowledgeDoc;
}


/**
 * 发请求并读 JSON；不成功时抛 KnowledgeError。
 * @param route /api/knowledge 后面的路径（含查询串）。
 * @param options fetch 选项。
 * @param allowConflict 为 true 时 409 不抛，原样交回回包（只有保存文档用）。
 */
async function request<T>(route: string, options?: RequestInit, allowConflict = false): Promise<T> {
  //M 非本机打开页面时带上 jmbots 已保存的访问令牌。
  const address = token.withToken(`${BASE}${route}`, token.TOKEN);
  const response = await fetch(address, options);
  if (response.ok) return response.json() as Promise<T>;

  //G 409 且调用方要自己处理冲突：回包里带着最新的 doc。
  if (response.status === 409 && allowConflict) return response.json() as Promise<T>;

  //G 外网或手机首次无令牌访问回 401 时广播事件，AuthGate 弹出登录。
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('jmbots:unauthorized'));
  }

  //M 其余按后端统一错误格式 { error } 读出原因；403 换成“只能看”的说法。
  const body = await response.json().catch(() => ({})) as { error?: string };
  let message = body.error ?? `请求失败（${String(response.status)}）`;
  if (response.status === 403) {
    message = '需要先登录才能修改知识库，现在只能看';
  }
  throw new KnowledgeError(response.status, message);
}


/**
 * 写请求的选项：JSON 体。
 * @param method POST、PUT 或 DELETE。
 * @param body 要发的对象；DELETE 不带。
 */
function getWriteOptions(method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method };

  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}


/**
 * 标签和系统规则筛选写成查询参数：一个标签时照旧发 tag（老后端也认）；多个时发 tags（逗号分隔）和 tagMode。
 * @param query 列表筛选。
 */
function getFilterParams(query: DocQuery): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {};
  if (query.systemRule === true) {
    params['systemRule'] = '1';
  }
  const tags = query.tags ?? [];
  if (tags.length === 1) {
    params['tag'] = tags[0];
  }
  if (tags.length > 1) {
    params['tags'] = tags.join(',');
    params['tagMode'] = query.tagMode;
  }
  return params;
}


/**
 * 把一组可选参数拼成查询串，空的不写。
 * @param values 参数名到值。
 * @returns 带问号的查询串；全空时是空字符串。
 */
function getQueryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;

    params.set(key, String(value));
  }
  const text = params.toString();
  if (text === '') return '';

  return `?${text}`;
}


/** 1. 目录树、标签计数、专题统计。 */
export function getTree(signal?: AbortSignal): Promise<types.KnowledgeTreeResponse> {
  return request('/tree', { signal });
}


/** 2. 文档摘要列表（按更新时间倒序，每页 50）。 */
export function listDocs(query: DocQuery, signal?: AbortSignal): Promise<DocPage> {
  const filterParams = getFilterParams(query);
  const values = { dirId: query.dirId, topicId: query.topicId, offset: query.offset, ...filterParams };
  const search = getQueryString({ ...values, limit: query.limit ?? PAGE_SIZE });
  return request(`/docs${search}`, { signal });
}


/** 3. 单篇完整文档（含正文）。 */
export async function getDoc(id: string, signal?: AbortSignal): Promise<types.KnowledgeDoc> {
  const route = `/docs/${encodeURIComponent(id)}`;
  const body = await request<{ doc: types.KnowledgeDoc }>(route, { signal });
  return body.doc;
}


/** 4. 新建文档。 */
export async function createDoc(input: types.CreateDocInput): Promise<types.KnowledgeDoc> {
  const options = getWriteOptions('POST', input);
  const body = await request<{ doc: types.KnowledgeDoc }>('/docs', options);
  return body.doc;
}


/**
 * 5. 保存文档：patch 里带 baseUpdatedAt，别处改过时不覆盖，交回 conflict 和库里最新的文档。
 * @param id 文档号。
 * @param patch 改动的字段加 baseUpdatedAt。
 */
export async function updateDoc(id: string, patch: types.UpdateDocInput): Promise<SaveResult> {
  const route = `/docs/${encodeURIComponent(id)}`;
  const options = getWriteOptions('PUT', patch);
  const body = await request<{ ok: boolean; doc?: types.KnowledgeDoc; error?: string }>(route, options, true);

  //G 409 回包里没有 doc 就没法换成最新的：当普通错误抛（云端 29 #18）。
  if (typeof body.doc !== 'object' || body.doc === null) {
    throw new KnowledgeError(409, body.error ?? '文档已在别处更新，请刷新后重试');
  }
  return { conflict: !body.ok, doc: body.doc };
}


/** 6. 删除文档。 */
export async function deleteDoc(id: string): Promise<void> {
  const route = `/docs/${encodeURIComponent(id)}`;
  await request(route, getWriteOptions('DELETE'));
}


/** 7. 新建目录（parentId 为 null 建在顶层）。 */
export async function createDir(name: string, parentId: string | null): Promise<types.KnowledgeDir> {
  const options = getWriteOptions('POST', { name, parentId });
  const body = await request<{ dir: types.KnowledgeDir }>('/dirs', options);
  return body.dir;
}


/** 8. 改目录：改名、移到别的父目录（null 移到顶层）。 */
export async function updateDir(id: string, patch: types.UpdateDirInput): Promise<types.KnowledgeDir> {
  const route = `/dirs/${encodeURIComponent(id)}`;
  const options = getWriteOptions('PUT', patch);
  const body = await request<{ dir: types.KnowledgeDir }>(route, options);
  return body.dir;
}


/** 9. 删目录：子目录上提、文档变未归类，不删文档。 */
export async function deleteDir(id: string): Promise<void> {
  const route = `/dirs/${encodeURIComponent(id)}`;
  await request(route, getWriteOptions('DELETE'));
}


/**
 * 10. 混合搜索：本地命中加相关记忆。q 不能为空（页面只在有搜索词时调）。
 * @param q 搜索词。
 * @param query 同时生效的目录、标签、专题筛选。
 * @param signal 中止信号。
 */
export function search(
  q: string,
  query: DocQuery,
  signal?: AbortSignal,
): Promise<types.KnowledgeSearchResponse> {
  const filterParams = getFilterParams(query);
  const params = getQueryString({ q, dirId: query.dirId, topicId: query.topicId, ...filterParams, limit: 30 });
  return request(`/search${params}`, { signal });
}


//==========================================================
//M 标签治理与相关文档（knowledge v1.0.2，131 在补后端；没上线时前端温和降级）
//==========================================================

/** 改名、合并、删除标签的回执。 */
export interface TagMutationResult {
  /** 成功。 */
  ok: true;
  /** 原标签名（改名、合并）或被删的标签名（删除时放在 name）。 */
  oldName?: string;
  /** 新标签名（改名、合并）。 */
  newName?: string;
  /** 被删的标签名（删除）。 */
  name?: string;
  /** 新名字本来就有：两个标签合成了一个。 */
  merged?: boolean;
  /** 动到了几篇文档。 */
  affectedDocs: number;
}

/** 一篇相关文档推荐。 */
export interface RelatedDocItem {
  /** 文档号。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 摘要。 */
  summary: string;
  /** 所在目录；未归类是 null。 */
  dirId: string | null;
  /** 所在专题；没有是 null。 */
  topicId: string | null;
  /** 标签。 */
  tags: string[];
  /** 相关度，越大越相关。 */
  score: number;
  /** 推荐理由，比如“同专题”“共同标签: AOBB”。 */
  reasons: string[];
  /** 最近修改时间。 */
  updatedAt: string | number;
}


/**
 * 11. 标签改名；新名字已经有了就合并成一个。
 * @param name 原标签名。
 * @param newName 新标签名。
 */
export function renameOrMergeTag(name: string, newName: string): Promise<TagMutationResult> {
  const route = `/tags/${encodeURIComponent(name)}`;
  return request(route, getWriteOptions('PUT', { newName }));
}


/**
 * 12. 删除标签：只从文档上摘掉，文档不删。
 * @param name 标签名。
 */
export function deleteTag(name: string): Promise<TagMutationResult> {
  const route = `/tags/${encodeURIComponent(name)}`;
  return request(route, getWriteOptions('DELETE'));
}


/**
 * 13. 一篇文档的相关文档推荐。后端没上线（404）、网络不通、回包不对时安静交回空数组，不打扰页面。
 * @param docId 文档号。
 * @param limit 最多几篇。
 * @param signal 换文档时中止。
 * @returns 推荐列表；拿不到是空数组。
 */
export async function fetchRelatedDocs(docId: string, limit = 6, signal?: AbortSignal): Promise<RelatedDocItem[]> {
  const route = `/docs/${encodeURIComponent(docId)}/related${getQueryString({ limit })}`;
  try {
    const body = await request<{ items?: unknown }>(route, { signal });
    if (!Array.isArray(body.items)) return [];

    return body.items as RelatedDocItem[];
  } catch {
    return [];
  }
}


/**
 * 14. 一篇文档的 [[双链]]：引出链接（含还没建的）和引用了它的文档。
 * @param docId 文档号。
 * @param signal 换文档时中止。
 */
export function fetchDocLinks(docId: string, signal?: AbortSignal): Promise<types.KnowledgeLinksResponse> {
  const route = `/docs/${encodeURIComponent(docId)}/links`;
  return request(route, { signal });
}


/**
 * 15. 双链图谱：不给 centerId 是整个知识库（全部文档都是节点，页面顺带拿它当标题索引）；给了是这篇和一跳邻居。
 * @param centerId 中心文档号。
 * @param signal 中止信号。
 */
export function fetchGraph(centerId?: string, signal?: AbortSignal): Promise<types.KnowledgeGraphResponse> {
  const route = `/graph${getQueryString({ centerId })}`;
  return request(route, { signal });
}


//==========================================================
//M 别名消歧与本地目录同步（knowledge v1.2.0）
//==========================================================

/**
 * 16. 别名消歧：标题或别名和这个词一样的文档，两篇以上 ambiguous 为 true。
 * @param q 要查的词。
 * @param signal 中止信号。
 */
export function disambiguate(q: string, signal?: AbortSignal): Promise<types.KnowledgeDisambiguateResponse> {
  return request(`/disambiguate${getQueryString({ q })}`, { signal });
}


/**
 * 17. 同步一次本地目录（只读源目录）：dirs 不给用后端配置的 localWatchDirs；category 不给放进「外部学习」。
 * @param dirs 临时指定的本机绝对路径。
 * @param category 分类（虚拟目录名）。
 */
export function syncFolders(dirs?: string[], category?: string): Promise<types.KnowledgeSyncResponse> {
  return request('/sync-folders', getWriteOptions('POST', { dirs, category }));
}


/** 18. 同步状态：配置的目录和最近一次同步的结果。 */
export function getSyncStatus(signal?: AbortSignal): Promise<types.KnowledgeSyncStatusResponse> {
  return request('/sync-status', { signal });
}
