/**
 * 积木知识库页面的接口封装：/api/knowledge/* 十个接口，沿用 jmbots 的页面令牌。
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
  /** 标签名，多个时取交集（一个时照旧发 tag，多个时发 tags=a,b）。 */
  tags?: string[];
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
 * 标签筛选写成查询参数：一个时照旧发 tag（老后端也认），多个时发 tags（逗号分隔，后端取交集）。
 * @param tags 选中的标签；没有是空。
 */
function getTagParams(tags: string[] | undefined): { tag?: string; tags?: string } {
  if (tags === undefined || tags.length === 0) return {};

  if (tags.length === 1) return { tag: tags[0] };

  return { tags: tags.join(',') };
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
  const tagParams = getTagParams(query.tags);
  const values = { dirId: query.dirId, topicId: query.topicId, offset: query.offset, ...tagParams };
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
  const tagParams = getTagParams(query.tags);
  const params = getQueryString({ q, dirId: query.dirId, topicId: query.topicId, ...tagParams, limit: 30 });
  return request(`/search${params}`, { signal });
}
