/**
 * 积木知识库 REST API 路由与记忆服务温和桥接（/api/knowledge/*）。
 * 所有写接口（POST/PUT/DELETE）强制核验 ctx.http.isVerified(request)，未通过一律返回 403；
 * 搜索接口通过 requestEvent 桥接 memory/request，未挂载 memory 或远端离线时平滑退化，绝不报错中断。
 */
import type * as cordis from 'cordis';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as storeModule from './Store.ts';
import type * as types from './Types.ts';


/** 搜记忆最多等几毫秒（只读，晚了就不要）。 */
const MEMORY_WAIT_MS = 4000;


//==========================================================
// 记忆服务事件桥接（零跨插件 import）
//==========================================================

/** 记忆检索桥接回执。 */
export interface MemoryBridgeOutcome {
  /** memory 插件与检索通道是否成功返回。 */
  available: boolean;
  /** 融合回来的记忆命中列表。 */
  hits: types.KnowledgeMemoryHit[];
  /** 可选温和告警文本。 */
  warning?: string;
}


/**
 * 通过 Cordis requestEvent 向 memory 插件发起混合检索；未挂载或离线时零报错退化。
 * @param ctx 插件上下文。
 * @param queryText 搜索关键词。
 * @param limit 最多返回条数。
 * @param sources 请求的记忆来源列表（默认搜知识库、卡片与渠道归档）。
 * @returns 温和桥接结果。
 */
export async function searchMemoryBridge(
  ctx: cordis.Context,
  queryText: string,
  limit: number,
  sources = 'knowledge,card,channel',
): Promise<MemoryBridgeOutcome> {
  const q = queryText.trim();
  if (q === '') return { available: false, hits: [] };

  //M 搜记忆是只读的，晚了就不要：自己限 4 秒（memory 后端 HTTP 限 8 秒），到点按中止处理。
  const options = { prefix: 'kb', signal: AbortSignal.timeout(MEMORY_WAIT_MS) };
  const asked = await requestEventModule.requestEvent(
    ctx,
    'memory/request',
    'memory/result',
    {
      action: 'search',
      query: { q, sources, limit },
    },
    options,
  );

  //G 无人接单说明当前实例未挂 memory 插件，静默返回空数组。
  if (asked.why === 'unhandled') {
    return { available: false, hits: [] };
  }
  if (asked.why !== undefined) {
    return { available: false, hits: [], warning: asked.detail ?? `记忆桥接未完成：${asked.why}` };
  }
  if (!asked.reply.ok) {
    return { available: false, hits: [], warning: asked.reply.error ?? '记忆服务暂不可用' };
  }

  const rawHits = asked.reply.search?.hits ?? [];
  const hits: types.KnowledgeMemoryHit[] = rawHits.map((item) => ({
    source: item.source,
    id: item.id,
    title: item.title,
    snippet: item.snippet,
    score: item.score,
    at: item.at,
    ref: item.ref,
  }));
  const warnings = asked.reply.search?.warnings ?? [];
  if (warnings.length > 0) {
    return { available: true, hits, warning: warnings.join('；') };
  }
  return { available: true, hits };
}


//==========================================================
// 入参读取辅助函数
//==========================================================

/** 从对象读取可选字符串字段。 */
function readOptionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const val = rec[key];
  if (val === undefined) return undefined;
  if (typeof val !== 'string') {
    throw new failureModule.Failure(400, `${key} 必须是字符串`);
  }
  return val;
}


/** 从对象读取可空字符串字段（允许传 null 置空）。 */
function readNullableString(rec: Record<string, unknown>, key: string): string | null | undefined {
  const val = rec[key];
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (typeof val !== 'string') {
    throw new failureModule.Failure(400, `${key} 必须是字符串或 null`);
  }
  return val;
}


/** 从对象读取可选字符串数组。 */
function readOptionalStringArray(rec: Record<string, unknown>, key: string): string[] | undefined {
  const val = rec[key];
  if (val === undefined) return undefined;
  if (!Array.isArray(val) || val.some((item) => typeof item !== 'string')) {
    throw new failureModule.Failure(400, `${key} 必须是字符串数组`);
  }
  return val as string[];
}


/** 从查询对象读取可选字符串参数。 */
function readQueryText(query: Record<string, unknown>, key: string): string | undefined {
  const val = query[key];
  if (typeof val === 'string') return val;

  return undefined;
}


/**
 * 从查询对象读标签列表：?tag=a&tag=b（重复参数）、?tags=a,b（逗号分隔，中文逗号也认）都收，去重留给 Store。
 * @param query 查询对象。
 * @returns 标签名；都没给是空数组。
 */
function readQueryTags(query: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ['tag', 'tags']) {
    const val = query[key];
    let values: unknown[] = [val];
    if (Array.isArray(val)) {
      values = val;
    }
    for (const item of values) {
      if (typeof item !== 'string') continue;

      names.push(...item.split(/[,，]/u));
    }
  }
  return names;
}


/** 读取路由路径参数（如 :id、:name，Fastify 已解好百分号编码）。 */
function readParam(params: unknown, key: string): string {
  const raw = (params as Record<string, unknown> | null)?.[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new failureModule.Failure(400, `缺少路径参数 ${key}`);
  }
  return raw.trim();
}


//==========================================================
// 挂载全部 /api/knowledge/* 路由
//==========================================================

/**
 * 在 ctx.http.app 上登记积木知识库全部读写与混合搜索接口。
 * @param ctx 插件上下文。
 * @param store 知识库存储实例。
 */
export function mountKnowledgeRoutes(
  ctx: cordis.Context,
  store: storeModule.KnowledgeStore,
): void {
  const app = ctx.http.app;

  //M 1. 目录树 + 标签计数 + 工作台专题挂载统计。
  app.get('/api/knowledge/tree', () => {
    const tree = store.getTree();
    return { ok: true, ...tree };
  });

  //M 2. 文档多维筛选与分页列表。
  app.get('/api/knowledge/docs', (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const includeContent = query['includeContent'] === '1' || query['includeContent'] === 'true';
    const filter: types.DocListFilter = {
      dirId: readQueryText(query, 'dirId'),
      topicId: readQueryText(query, 'topicId'),
      tags: readQueryTags(query),
      q: readQueryText(query, 'q'),
      limit: checksModule.checkCount(query['limit'], 'limit'),
      offset: checksModule.checkCount(query['offset'], 'offset'),
      includeContent,
    };
    const page = store.listDocs(filter);
    return { ok: true, ...page };
  });

  //M 3. 读取单篇完整文档（含 Markdown 正文）。
  app.get('/api/knowledge/docs/:id', (request) => {
    const id = readParam(request.params, 'id');
    const doc = store.getDoc(id);
    if (doc === undefined) {
      throw new failureModule.Failure(404, `文档不存在：${id}`);
    }
    return { ok: true, doc };
  });

  //M 4. 新建知识文档（强检身份核验）。
  app.post('/api/knowledge/docs', (request) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const body = checksModule.checkRecord(request.body, '请求体');
    const title = readOptionalString(body, 'title') ?? '';
    const input: types.CreateDocInput = {
      id: readOptionalString(body, 'id'),
      dirId: readNullableString(body, 'dirId'),
      topicId: readNullableString(body, 'topicId'),
      title,
      summary: readOptionalString(body, 'summary'),
      content: readOptionalString(body, 'content'),
      sourcePath: readOptionalString(body, 'sourcePath'),
      sourceType: readOptionalString(body, 'sourceType') as types.KnowledgeSourceType | undefined,
      tags: readOptionalStringArray(body, 'tags'),
    };
    const doc = store.createDoc(input);
    return { ok: true, doc };
  });

  //M 5. 更新知识文档（支持局部修改与标签重绑，强检身份核验；带 baseUpdatedAt 时防别处改过被覆盖）。
  app.put('/api/knowledge/docs/:id', (request, reply) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const id = readParam(request.params, 'id');
    const body = checksModule.checkRecord(request.body, '请求体');
    const patch: types.UpdateDocInput = {};
    if ('dirId' in body) {
      patch.dirId = readNullableString(body, 'dirId');
    }
    if ('topicId' in body) {
      patch.topicId = readNullableString(body, 'topicId');
    }
    if ('title' in body) {
      patch.title = readOptionalString(body, 'title');
    }
    if ('summary' in body) {
      patch.summary = readOptionalString(body, 'summary');
    }
    if ('content' in body) {
      patch.content = readOptionalString(body, 'content');
    }
    if ('sourcePath' in body) {
      patch.sourcePath = readOptionalString(body, 'sourcePath');
    }
    if ('sourceType' in body) {
      patch.sourceType = readOptionalString(body, 'sourceType') as types.KnowledgeSourceType | undefined;
    }
    if ('tags' in body) {
      patch.tags = readOptionalStringArray(body, 'tags');
    }
    if (body['baseUpdatedAt'] !== undefined) {
      patch.baseUpdatedAt = checksModule.checkNumber(body['baseUpdatedAt'], 'baseUpdatedAt', { integer: true });
    }

    //G 别处先改过：回 409，并把库里最新的文档一起带回，前端直接拿它刷新（统一的错误处理只回 error，带不了 doc）。
    try {
      const doc = store.updateDoc(id, patch);
      return { ok: true, doc };
    } catch (error) {
      if (!(error instanceof storeModule.KnowledgeConflictError)) throw error;

      reply.code(409);
      return { ok: false, error: error.message, doc: error.doc };
    }
  });

  //M 6. 删除知识文档（强检身份核验）。
  app.delete('/api/knowledge/docs/:id', (request) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const id = readParam(request.params, 'id');
    store.deleteDoc(id);
    return { ok: true, id };
  });

  //M 7. 新建虚拟目录（强检身份核验）。
  app.post('/api/knowledge/dirs', (request) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const body = checksModule.checkRecord(request.body, '请求体');
    const name = readOptionalString(body, 'name') ?? '';
    let sortOrder: number | undefined;
    if (body['sortOrder'] !== undefined) {
      sortOrder = checksModule.checkNumber(body['sortOrder'], 'sortOrder', { integer: true });
    }
    const dir = store.createDir({
      id: readOptionalString(body, 'id'),
      parentId: readNullableString(body, 'parentId'),
      name,
      sortOrder,
    });
    return { ok: true, dir };
  });

  //M 8. 更新虚拟目录（强检身份核验）。
  app.put('/api/knowledge/dirs/:id', (request) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const id = readParam(request.params, 'id');
    const body = checksModule.checkRecord(request.body, '请求体');
    const patch: types.UpdateDirInput = {};
    if ('name' in body) {
      patch.name = readOptionalString(body, 'name');
    }
    if ('parentId' in body) {
      patch.parentId = readNullableString(body, 'parentId');
    }
    if ('sortOrder' in body && body['sortOrder'] !== undefined) {
      patch.sortOrder = checksModule.checkNumber(body['sortOrder'], 'sortOrder', { integer: true });
    }
    const dir = store.updateDir(id, patch);
    return { ok: true, dir };
  });

  //M 9. 删除虚拟目录（不删原文档，强检身份核验）。
  app.delete('/api/knowledge/dirs/:id', (request) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const id = readParam(request.params, 'id');
    store.deleteDir(id);
    return { ok: true, id };
  });

  //M 10. 混合搜索：本地 SQLite 加权命中 + 桥接 memory 搜索。
  app.get('/api/knowledge/search', async (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    let q = '';
    if (typeof query['q'] === 'string') {
      q = query['q'].trim();
    }
    let dirId: string | undefined;
    if (typeof query['dirId'] === 'string' && query['dirId'].trim() !== '') {
      dirId = query['dirId'].trim();
    }
    let topicId: string | undefined;
    if (typeof query['topicId'] === 'string' && query['topicId'].trim() !== '') {
      topicId = query['topicId'].trim();
    }
    //M 标签：?tag= 可重复，?tags= 逗号分隔，合并去重后按交集筛（G3）。
    const tags = storeModule.getFilterTags(undefined, readQueryTags(query));
    if (q === '' && dirId === undefined && topicId === undefined && tags.length === 0) {
      throw new failureModule.Failure(400, '请至少提供搜索词 q、topicId、dirId 或 tag 之一');
    }

    const limit = checksModule.checkCount(query['limit'], 'limit') ?? 15;
    const hits = store.searchLocal(q, { dirId, topicId, tags, limit });

    const skipMemory = query['includeMemory'] === '0' || query['includeMemory'] === 'false';
    if (skipMemory || q === '') {
      const localOnly: types.KnowledgeSearchResponse = {
        ok: true,
        query: q,
        hits,
        memoryAvailable: false,
        memoryHits: [],
      };
      return localOnly;
    }

    const mem = await searchMemoryBridge(ctx, q, Math.min(10, limit));
    const response: types.KnowledgeSearchResponse = {
      ok: true,
      query: q,
      hits,
      memoryAvailable: mem.available,
      memoryHits: mem.hits,
    };
    if (mem.warning !== undefined && mem.warning !== '') {
      response.memoryWarning = mem.warning;
    }
    return response;
  });

  //M 11. 标签改名；新名字已有就合并（强检身份核验）。
  app.put('/api/knowledge/tags/:name', (request) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const name = readParam(request.params, 'name');
    const body = checksModule.checkRecord(request.body, '请求体');
    const newName = readOptionalString(body, 'newName');
    if (newName === undefined) {
      throw new failureModule.Failure(400, '要写 newName');
    }
    const result: types.KnowledgeTagRenameResult = { ok: true, ...store.renameTag(name, newName) };
    return result;
  });

  //M 12. 删除标签，文档本身不动（强检身份核验）。
  app.delete('/api/knowledge/tags/:name', (request) => {
    ctx.http.requireVerified(request, '知识库写操作');
    const name = readParam(request.params, 'name');
    const result: types.KnowledgeTagDeleteResult = { ok: true, ...store.deleteTag(name) };
    return result;
  });

  //M 13. 相关文档推荐：limit 默认 6，限在 1～20。
  app.get('/api/knowledge/docs/:id/related', (request) => {
    const id = readParam(request.params, 'id');
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const written = checksModule.checkCount(query['limit'], 'limit') ?? 6;
    const limit = Math.min(20, Math.max(1, written));
    const response: types.KnowledgeRelatedResponse = { ok: true, docId: id, items: store.getRelated(id, limit) };
    return response;
  });
}
