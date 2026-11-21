/**
 * 积木知识库 SQLite 存储层：管理 kb_dirs、kb_docs、kb_tags 与 kb_doc_tags，
 * 提供事务一致性读写、目录环路防护、专题与标签聚合计数、多词相关性本地检索及磁盘镜像联动。
 */
import type { Database } from 'bun:sqlite';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import * as mirrorModule from './DiskMirror.ts';
import * as types from './Types.ts';


//==========================================================
// 表结构与底层行映射类型
//==========================================================

/** 幂等建表与索引 SQL（供 db 插件迁移账本与单测直连共用）。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kb_dirs (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_dirs_parent ON kb_dirs (parent_id, sort_order);

CREATE TABLE IF NOT EXISTS kb_docs (
  id TEXT PRIMARY KEY NOT NULL,
  dir_id TEXT,
  topic_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'note',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_dir ON kb_docs (dir_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_docs_topic ON kb_docs (topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_docs_updated ON kb_docs (updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_doc_tags (
  doc_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (doc_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_doc_tags_tag ON kb_doc_tags (tag_id, doc_id);
`;

interface DirRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface DocRow {
  id: string;
  dir_id: string | null;
  topic_id: string | null;
  title: string;
  summary: string;
  content: string;
  source_path: string;
  source_type: string;
  created_at: number;
  updated_at: number;
}

interface DocTagRow {
  doc_id: string;
  name: string;
}


//==========================================================
// 纯函数归一化与摘要提取
//==========================================================

/**
 * 归一化可空 ID（空串统一收敛为 null）。
 */
function normalizeNullableId(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed === '') return null;

  return trimmed;
}


/**
 * 校验并规范化自定义实体 ID（禁止 : 等 Windows 非法目录字符）。
 */
function checkCustomId(raw: string | undefined, prefix: string): string {
  if (raw === undefined || raw.trim() === '') return mirrorModule.generateAtomId(prefix);

  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(trimmed)) {
    throw new failureModule.Failure(400, `不合法的 ID 格式：${trimmed}`);
  }
  return trimmed;
}


/**
 * 转义 SQLite LIKE 模式中的 \、% 与 _ 通配符（配合 ESCAPE '\\' 使用）。
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/gu, '\\$&');
}


/** 标签名去掉两头空白和开头的 #。建标签、按标签筛、按名字找标签共用。 */
function cleanTag(raw: string): string {
  const trimmed = raw.trim();
  const noHash = trimmed.replace(/^#+/u, '');
  return noHash.trim();
}


/** 名称、标题：去掉两头空白后不能是空的。 */
function checkName(value: string, label: string): string {
  const name = value.trim();
  if (name === '') {
    throw new failureModule.Failure(400, `${label}不能为空`);
  }
  return name;
}


/**
 * 归一化标签列表：剥离前导 #、去空白并按大小写不敏感去重。
 */
export function normalizeTags(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new failureModule.Failure(400, '标签项必须是字符串');
    }
    const cleaned = cleanTag(item);
    if (cleaned === '') continue;
    if (cleaned.length > 64) {
      throw new failureModule.Failure(400, `标签名过长（最多 64 字）：${cleaned}`);
    }
    //G 逗号是筛选参数 ?tags=a,b 的分隔符，标签名里带了就再也筛不出来（云端 30 #1）。
    if (/[,，]/u.test(cleaned)) {
      throw new failureModule.Failure(400, `标签名不能包含逗号：${cleaned}`);
    }
    //G 纯点号（. ..）拼进 /tags/:name 会被浏览器按路径规范化吃掉，改名、删除打到别的地址（0.7.90 审计）。
    if (/^\.+$/u.test(cleaned)) {
      throw new failureModule.Failure(400, `标签名不能只有点号：${cleaned}`);
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(cleaned);
  }
  return out;
}


/**
 * 校验来源分类枚举。
 */
function checkSourceType(raw: unknown): types.KnowledgeSourceType {
  if (raw === undefined || raw === '') return 'note';
  if (typeof raw === 'string' && types.KNOWLEDGE_SOURCE_TYPES.includes(raw as types.KnowledgeSourceType)) {
    return raw as types.KnowledgeSourceType;
  }
  throw new failureModule.Failure(400, 'sourceType 必须是 note、file、url 或 transcript');
}


/**
 * 当用户未显式填写摘要时，从 Markdown 正文中提取前 140 字作为导读索引。
 */
export function deriveAutoSummary(content: string): string {
  const plain = content
    .replace(/^#+\s+/gmu, '')
    .replace(/[`*_~>\[\]]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = [...plain];
  if (chars.length <= 140) return plain;

  return `${chars.slice(0, 140).join('')}…`;
}


/**
 * 围绕首个命中的检索词截取一段高可读性的上下文片段。
 */
function extractSnippet(content: string, summary: string, terms: string[]): string {
  const base = content.trim() || summary.trim();
  if (base === '') return '';

  const flat = base.replace(/\s+/gu, ' ');
  const lower = flat.toLowerCase();
  let hitPos = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (hitPos < 0 || idx < hitPos)) {
      hitPos = idx;
    }
  }
  if (hitPos < 0) {
    const head = [...flat];
    if (head.length <= 160) return flat;

    return `${head.slice(0, 160).join('')}…`;
  }

  const start = Math.max(0, hitPos - 40);
  const slice = flat.slice(start, start + 160);
  let prefix = '';
  if (start > 0) {
    prefix = '…';
  }
  let suffix = '';
  if (start + 160 < flat.length) {
    suffix = '…';
  }
  return `${prefix}${slice}${suffix}`;
}


/** 将数据库目录行映射为领域对象。 */
function mapDirRow(row: DirRow): types.KnowledgeDir {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


/** 将数据库文档行与标签映射为摘要对象。 */
function mapDocSummary(row: DocRow, tags: string[]): types.KnowledgeDocSummary {
  let sourceType: types.KnowledgeSourceType = 'note';
  if (types.KNOWLEDGE_SOURCE_TYPES.includes(row.source_type as types.KnowledgeSourceType)) {
    sourceType = row.source_type as types.KnowledgeSourceType;
  }
  return {
    id: row.id,
    dirId: row.dir_id,
    topicId: row.topic_id,
    title: row.title,
    summary: row.summary,
    sourcePath: row.source_path,
    sourceType,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


//==========================================================
// KnowledgeStore 核心实现
//==========================================================

/** 一次筛选最多带几个标签。 */
export const MAX_FILTER_TAGS = 20;


/**
 * 筛选用的标签：单个 tag 和多个 tags 合在一起，去掉前导 #、空白和空的，大小写不敏感去重。
 * @param tag 单个标签（老参数）。
 * @param tags 多个标签。
 * @returns 去重后的标签名，保留第一次出现时的写法。
 */
export function getFilterTags(tag: string | undefined, tags: string[] | undefined): string[] {
  const raw = [tag ?? '', ...(tags ?? [])];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw) {
    const name = cleanTag(item);
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;

    seen.add(key);
    names.push(name);
  }

  //G 筛选标签最多 MAX_FILTER_TAGS 个：每个占一个 SQLite 参数，极端长的网址不至于撞参数上限（云端 30 #1）。
  if (names.length > MAX_FILTER_TAGS) {
    throw new failureModule.Failure(400, `筛选标签最多 ${String(MAX_FILTER_TAGS)} 个`);
  }
  return names;
}


/** 文档已在别处更新：updateDoc 带的 baseUpdatedAt 过期了。带上库里最新的文档，路由原样回给前端刷新。 */
export class KnowledgeConflictError extends failureModule.Failure {
  /**
   * @param doc 库里最新的文档。
   */
  constructor(readonly doc: types.KnowledgeDoc) {
    super(409, '文档已在别处更新，请刷新后重试');
  }
}


/** 积木知识库 SQLite 存储服务。 */
export class KnowledgeStore {
  /**
   * @param db 应用共享 SQLite 连接。
   * @param mirror 可选磁盘镜像导出器。
   */
  constructor(
    private readonly db: Database,
    private readonly mirror?: mirrorModule.DiskMirror,
  ) {
    db.exec(SCHEMA_SQL);
  }

  /** 在单个 SQLite 事务内执行一组写操作。 */
  private runTx<T>(work: () => T): T {
    const tx = this.db.transaction(work);
    return tx();
  }

  /** 安全刷新磁盘镜像（以 SQLite 事务提交为准，磁盘偶发故障只记日志不向外抛 500）。 */
  private syncMirrorWrite(doc: types.KnowledgeDoc): void {
    if (this.mirror === undefined) return;
    try {
      this.mirror.writeDoc(doc);
    } catch (error) {
      console.error(`knowledge：导出文档 ${doc.id} 镜像失败：${textModule.getErrorMessage(error)}`);
    }
  }

  /** 安全清理已删文档的磁盘镜像目录。 */
  private syncMirrorRemove(id: string, createdAt: number): void {
    if (this.mirror === undefined) return;
    try {
      this.mirror.removeDoc(id, createdAt);
    } catch (error) {
      console.error(`knowledge：删除文档 ${id} 镜像失败：${textModule.getErrorMessage(error)}`);
    }
  }

  //----------------------------------------------------------
  // 虚拟目录（kb_dirs）CRUD 与环路保护
  //----------------------------------------------------------

  /** 按 ID 查询单个目录。 */
  getDir(id: string): types.KnowledgeDir | undefined {
    const sql = 'SELECT id, parent_id, name, sort_order, created_at, updated_at FROM kb_dirs WHERE id = ?';
    const row = this.db.query<DirRow, [string]>(sql).get(id);
    if (row === null) return undefined;

    return mapDirRow(row);
  }

  /** 列出全部目录（按 sort_order、created_at 稳定升序）。 */
  listDirs(): types.KnowledgeDir[] {
    const sql = `
      SELECT id, parent_id, name, sort_order, created_at, updated_at
      FROM kb_dirs
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `;
    return this.db.query<DirRow, []>(sql).all().map(mapDirRow);
  }

  /** 校验父目录存在且不会与自身/子孙形成死循环。 */
  private assertValidParent(dirId: string, parentId: string | null): void {
    if (parentId === null) return;
    if (parentId === dirId) {
      throw new failureModule.Failure(400, '目录不能把自身设为父目录');
    }

    let cursor: string | null = parentId;
    const visited = new Set<string>();
    while (cursor !== null) {
      if (cursor === dirId) {
        throw new failureModule.Failure(400, '不能将目录移动到其子孙目录下');
      }
      if (visited.has(cursor)) break;

      visited.add(cursor);
      const node = this.getDir(cursor);
      if (node === undefined) {
        throw new failureModule.Failure(404, `父目录不存在：${cursor}`);
      }
      cursor = node.parentId;
    }
  }

  /** 新建虚拟目录。 */
  createDir(input: types.CreateDirInput): types.KnowledgeDir {
    const name = checkName(input.name, '目录名称');
    const id = checkCustomId(input.id, 'dir_');
    if (this.getDir(id) !== undefined) {
      throw new failureModule.Failure(409, `目录 ID 已存在：${id}`);
    }

    const parentId = normalizeNullableId(input.parentId);
    this.assertValidParent(id, parentId);
    const sortOrder = input.sortOrder ?? 0;

    const now = Date.now();
    const sql = `
      INSERT INTO kb_dirs (id, parent_id, name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    this.db.query(sql).run(id, parentId, name, sortOrder, now, now);
    return { id, parentId, name, sortOrder, createdAt: now, updatedAt: now };
  }

  /** 更新虚拟目录名称、父节点或排序权重。 */
  updateDir(id: string, input: types.UpdateDirInput): types.KnowledgeDir {
    const existing = this.getDir(id);
    if (existing === undefined) {
      throw new failureModule.Failure(404, `目录不存在：${id}`);
    }

    let name = existing.name;
    if (input.name !== undefined) {
      name = checkName(input.name, '目录名称');
    }

    let parentId = existing.parentId;
    if ('parentId' in input) {
      parentId = normalizeNullableId(input.parentId);
      this.assertValidParent(id, parentId);
    }

    const sortOrder = input.sortOrder ?? existing.sortOrder;

    const now = Date.now();
    this.db
      .query('UPDATE kb_dirs SET parent_id = ?, name = ?, sort_order = ?, updated_at = ? WHERE id = ?')
      .run(parentId, name, sortOrder, now, id);
    return { ...existing, parentId, name, sortOrder, updatedAt: now };
  }

  /**
   * 删除虚拟目录：遵循「删目录绝不删原文档」，下属子目录上提至原父级，目录内文档解绑为未归类（dir_id = null）。
   */
  deleteDir(id: string): void {
    const existing = this.getDir(id);
    if (existing === undefined) {
      throw new failureModule.Failure(404, `目录不存在：${id}`);
    }

    const detachedIds = this.db
      .query<{ id: string }, [string]>('SELECT id FROM kb_docs WHERE dir_id = ?')
      .all(id)
      .map((r) => r.id);

    const now = Date.now();
    this.runTx(() => {
      this.db
        .query('UPDATE kb_dirs SET parent_id = ?, updated_at = ? WHERE parent_id = ?')
        .run(existing.parentId, now, id);
      this.db
        .query('UPDATE kb_docs SET dir_id = NULL, updated_at = ? WHERE dir_id = ?')
        .run(now, id);
      this.db.query('DELETE FROM kb_dirs WHERE id = ?').run(id);
    });

    for (const docId of detachedIds) {
      const refreshed = this.getDoc(docId);
      if (refreshed !== undefined) {
        this.syncMirrorWrite(refreshed);
      }
    }
  }

  //----------------------------------------------------------
  // 标签关联与文档（kb_docs / kb_tags / kb_doc_tags）CRUD
  //----------------------------------------------------------

  /** 批量查询一批文档各自的标签列表。 */
  private loadTagsByDocIds(docIds: readonly string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (docIds.length === 0) return result;

    const placeholders = docIds.map(() => '?').join(', ');
    const sql = `
      SELECT dt.doc_id, t.name
      FROM kb_doc_tags dt
      JOIN kb_tags t ON t.id = dt.tag_id
      WHERE dt.doc_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE ASC
    `;
    const rows = this.db.query<DocTagRow, string[]>(sql).all(...docIds);
    for (const row of rows) {
      const list = result.get(row.doc_id) ?? [];
      list.push(row.name);
      result.set(row.doc_id, list);
    }
    return result;
  }

  /** 在事务内重写指定文档的全部标签关联并清理无引用的孤立标签。 */
  private replaceDocTags(docId: string, tags: readonly string[], now: number): void {
    this.db.query('DELETE FROM kb_doc_tags WHERE doc_id = ?').run(docId);
    for (const tagName of tags) {
      let existing = this.db
        .query<{ id: string }, [string]>('SELECT id FROM kb_tags WHERE name = ? COLLATE NOCASE')
        .get(tagName);
      if (existing === null) {
        const tagId = mirrorModule.generateAtomId('tag_');
        this.db
          .query('INSERT INTO kb_tags (id, name, created_at) VALUES (?, ?, ?)')
          .run(tagId, tagName, now);
        existing = { id: tagId };
      }
      this.db
        .query('INSERT OR IGNORE INTO kb_doc_tags (doc_id, tag_id) VALUES (?, ?)')
        .run(docId, existing.id);
    }
    this.pruneOrphanTags();
  }

  /** 清理没有任何文档引用的孤儿标签。 */
  private pruneOrphanTags(): void {
    this.db.exec('DELETE FROM kb_tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM kb_doc_tags)');
  }

  /** 按 ID 读取完整知识文档（含正文与标签）。 */
  getDoc(id: string): types.KnowledgeDoc | undefined {
    const sql = `
      SELECT id, dir_id, topic_id, title, summary, content, source_path, source_type, created_at, updated_at
      FROM kb_docs WHERE id = ?
    `;
    const row = this.db.query<DocRow, [string]>(sql).get(id);
    if (row === null) return undefined;

    const tags = this.loadTagsByDocIds([id]).get(id) ?? [];
    return { ...mapDocSummary(row, tags), content: row.content };
  }

  /** 新建知识文档并同步导出磁盘镜像。 */
  createDoc(input: types.CreateDocInput): types.KnowledgeDoc {
    const title = checkName(input.title, '文档标题');
    const id = checkCustomId(input.id, '');
    if (this.getDoc(id) !== undefined) {
      throw new failureModule.Failure(409, `文档 ID 已存在：${id}`);
    }

    const dirId = normalizeNullableId(input.dirId);
    if (dirId !== null && this.getDir(dirId) === undefined) {
      throw new failureModule.Failure(404, `所属目录不存在：${dirId}`);
    }
    const topicId = normalizeNullableId(input.topicId);
    const content = input.content ?? '';
    let summary = (input.summary ?? '').trim();
    if (summary === '' && content.trim() !== '') {
      summary = deriveAutoSummary(content);
    }
    const sourcePath = (input.sourcePath ?? '').trim();
    const sourceType = checkSourceType(input.sourceType);
    const tags = normalizeTags(input.tags);
    const now = Date.now();

    this.runTx(() => {
      const insertSql = `
        INSERT INTO kb_docs (
          id, dir_id, topic_id, title, summary, content, source_path, source_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      this.db
        .query(insertSql)
        .run(id, dirId, topicId, title, summary, content, sourcePath, sourceType, now, now);
      if (tags.length > 0) {
        this.replaceDocTags(id, tags, now);
      }
    });

    const created = this.getDoc(id)!;
    this.syncMirrorWrite(created);
    return created;
  }

  /** 局部更新知识文档字段及标签，并同步刷新磁盘镜像。 */
  updateDoc(id: string, input: types.UpdateDocInput): types.KnowledgeDoc {
    const existing = this.getDoc(id);
    if (existing === undefined) {
      throw new failureModule.Failure(404, `文档不存在：${id}`);
    }

    //G 带了编辑时的 updatedAt 却和库里的对不上：别处（另一个标签页、手机）先存过了，不覆盖，交回最新的。
    const isStale = input.baseUpdatedAt !== undefined && input.baseUpdatedAt !== existing.updatedAt;
    if (isStale) {
      throw new KnowledgeConflictError(existing);
    }

    let dirId = existing.dirId;
    if ('dirId' in input) {
      dirId = normalizeNullableId(input.dirId);
      if (dirId !== null && this.getDir(dirId) === undefined) {
        throw new failureModule.Failure(404, `所属目录不存在：${dirId}`);
      }
    }

    let topicId = existing.topicId;
    if ('topicId' in input) {
      topicId = normalizeNullableId(input.topicId);
    }

    let title = existing.title;
    if (input.title !== undefined) {
      title = checkName(input.title, '文档标题');
    }

    const content = input.content ?? existing.content;
    let summary = existing.summary;
    if (input.summary !== undefined) {
      summary = input.summary.trim();
    }
    const wasAutoSummary = existing.summary === '' || existing.summary === deriveAutoSummary(existing.content);
    if (input.summary === undefined && input.content !== undefined && wasAutoSummary) {
      summary = deriveAutoSummary(content);
    }
    if (summary === '' && content.trim() !== '' && input.summary === undefined) {
      summary = deriveAutoSummary(content);
    }

    let sourcePath = existing.sourcePath;
    if (input.sourcePath !== undefined) {
      sourcePath = input.sourcePath.trim();
    }

    let sourceType = existing.sourceType;
    if (input.sourceType !== undefined) {
      sourceType = checkSourceType(input.sourceType);
    }

    let nextTags: string[] | undefined;
    if (input.tags !== undefined) {
      nextTags = normalizeTags(input.tags);
    }

    const now = Date.now();
    this.runTx(() => {
      const sql = `
        UPDATE kb_docs
        SET dir_id = ?, topic_id = ?, title = ?, summary = ?, content = ?,
            source_path = ?, source_type = ?, updated_at = ?
        WHERE id = ?
      `;
      this.db.query(sql).run(dirId, topicId, title, summary, content, sourcePath, sourceType, now, id);
      if (nextTags !== undefined) {
        this.replaceDocTags(id, nextTags, now);
      }
    });

    const updated = this.getDoc(id)!;
    this.syncMirrorWrite(updated);
    return updated;
  }

  /** 删除知识文档并移除关联标签关系与磁盘镜像。 */
  deleteDoc(id: string): void {
    const existing = this.getDoc(id);
    if (existing === undefined) {
      throw new failureModule.Failure(404, `文档不存在：${id}`);
    }

    this.runTx(() => {
      this.db.query('DELETE FROM kb_doc_tags WHERE doc_id = ?').run(id);
      this.db.query('DELETE FROM kb_docs WHERE id = ?').run(id);
      this.pruneOrphanTags();
    });
    this.syncMirrorRemove(id, existing.createdAt);
  }

  //----------------------------------------------------------
  // 目录树统计、多条件分页列表与本地相关性检索
  //----------------------------------------------------------

  /** 组装完整目录树、标签计数与各工作台专题挂载统计。 */
  getTree(): Omit<types.KnowledgeTreeResponse, 'ok'> {
    const flatDirs = this.listDirs();
    const dirCounts = new Map<string, number>();
    let unassignedDocs = 0;
    let totalDocs = 0;

    const dirStatRows = this.db
      .query<{ dir_id: string | null; cnt: number }, []>('SELECT dir_id, COUNT(*) AS cnt FROM kb_docs GROUP BY dir_id')
      .all();
    for (const row of dirStatRows) {
      totalDocs += row.cnt;
      if (row.dir_id === null) {
        unassignedDocs += row.cnt;
        continue;
      }
      dirCounts.set(row.dir_id, row.cnt);
    }

    //M 组装父子目录树；若父节点缺失则回退挂到顶层避免孤儿隐身。
    const nodeMap = new Map<string, types.KnowledgeDirNode>();
    for (const dir of flatDirs) {
      nodeMap.set(dir.id, { ...dir, docCount: dirCounts.get(dir.id) ?? 0, children: [] });
    }
    const roots: types.KnowledgeDirNode[] = [];
    for (const dir of flatDirs) {
      const current = nodeMap.get(dir.id)!;
      if (dir.parentId !== null && nodeMap.has(dir.parentId)) {
        nodeMap.get(dir.parentId)!.children.push(current);
        continue;
      }
      roots.push(current);
    }

    const tagSql = `
      SELECT t.id, t.name, COUNT(dt.doc_id) AS docCount
      FROM kb_tags t
      JOIN kb_doc_tags dt ON dt.tag_id = t.id
      GROUP BY t.id, t.name
      ORDER BY docCount DESC, t.name COLLATE NOCASE ASC
    `;
    const tags = this.db.query<types.KnowledgeTagStat, []>(tagSql).all();

    const topicSql = `
      SELECT topic_id AS topicId, COUNT(*) AS docCount
      FROM kb_docs
      WHERE topic_id IS NOT NULL AND topic_id != ''
      GROUP BY topic_id
      ORDER BY docCount DESC, topic_id ASC
    `;
    const topics = this.db.query<types.KnowledgeTopicStat, []>(topicSql).all();

    return { dirs: roots, flatDirs, tags, topics, totalDocs, unassignedDocs };
  }

  /** 按目录、专题、标签与关键词分页筛选文档列表。 */
  listDocs(
    filter: types.DocListFilter = {},
    maxLimitCap = 200,
  ): {
    items: (types.KnowledgeDocSummary | types.KnowledgeDoc)[];
    total: number;
    limit: number;
    offset: number;
  } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter.dirId !== undefined && filter.dirId.trim() !== '') {
      const dirVal = filter.dirId.trim();
      if (dirVal === '__unassigned__') {
        clauses.push('d.dir_id IS NULL');
      }
      if (dirVal !== '__unassigned__') {
        clauses.push('d.dir_id = ?');
        params.push(dirVal);
      }
    }

    if (filter.topicId !== undefined && filter.topicId.trim() !== '') {
      clauses.push('d.topic_id = ?');
      params.push(filter.topicId.trim());
    }

    //M 标签交集：tag 和 tags 合并去重，文档要把这些标签全带上才算（G3）。
    const tagNames = getFilterTags(filter.tag, filter.tags);
    if (tagNames.length > 0) {
      const marks = tagNames.map(() => '?').join(', ');
      clauses.push(`d.id IN (
          SELECT dt.doc_id FROM kb_doc_tags dt
          JOIN kb_tags t ON t.id = dt.tag_id
          WHERE t.name COLLATE NOCASE IN (${marks})
          GROUP BY dt.doc_id
          HAVING COUNT(DISTINCT t.id) = ?
        )`);
      params.push(...tagNames, tagNames.length);
    }

    if (filter.q !== undefined && filter.q.trim() !== '') {
      const terms = filter.q.trim().split(/\s+/u).filter((t) => t !== '');
      for (const term of terms) {
        const pattern = `%${escapeLikeTerm(term)}%`;
        clauses.push(`(
          d.title LIKE ? ESCAPE '\\' OR d.summary LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\' OR EXISTS (
            SELECT 1 FROM kb_doc_tags dt
            JOIN kb_tags t ON t.id = dt.tag_id
            WHERE dt.doc_id = d.id AND t.name LIKE ? ESCAPE '\\'
          )
        )`);
        params.push(pattern, pattern, pattern, pattern);
      }
    }

    let whereSql = '';
    if (clauses.length > 0) {
      whereSql = `WHERE ${clauses.join(' AND ')}`;
    }

    const totalRow = this.db
      .query<{ cnt: number }, (string | number)[]>(`SELECT COUNT(*) AS cnt FROM kb_docs d ${whereSql}`)
      .get(...params);
    const total = totalRow?.cnt ?? 0;

    let rawLimit = 50;
    if (filter.limit !== undefined && Number.isFinite(filter.limit)) {
      rawLimit = Math.trunc(filter.limit);
    }
    const limit = Math.min(maxLimitCap, Math.max(1, rawLimit));

    let rawOffset = 0;
    if (filter.offset !== undefined && Number.isFinite(filter.offset)) {
      rawOffset = Math.trunc(filter.offset);
    }
    const offset = Math.max(0, rawOffset);

    const selectSql = `
      SELECT d.id, d.dir_id, d.topic_id, d.title, d.summary, d.content,
             d.source_path, d.source_type, d.created_at, d.updated_at
      FROM kb_docs d
      ${whereSql}
      ORDER BY d.updated_at DESC, d.id DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.query<DocRow, (string | number)[]>(selectSql).all(...params, limit, offset);
    const tagMap = this.loadTagsByDocIds(rows.map((r) => r.id));

    const items = rows.map((row) => {
      const summaryObj = mapDocSummary(row, tagMap.get(row.id) ?? []);
      if (filter.includeContent === true) {
        return { ...summaryObj, content: row.content };
      }
      return summaryObj;
    });
    return { items, total, limit, offset };
  }

  /**
   * 按标题、标签、摘要与正文多字段加权搜索本地知识库文档。
   */
  searchLocal(
    queryText: string,
    options: { dirId?: string; topicId?: string; tag?: string; tags?: string[]; limit?: number } = {},
  ): types.KnowledgeSearchHit[] {
    let maxHits = 20;
    if (options.limit !== undefined && Number.isFinite(options.limit)) {
      maxHits = Math.min(50, Math.max(1, Math.trunc(options.limit)));
    }
    const trimmed = queryText.trim();
    let terms: string[] = [];
    if (trimmed !== '') {
      terms = trimmed.split(/\s+/u).filter((t) => t !== '');
    }

    //M 先利用 SQLite 条件缩小候选集，再做字段级打分与上下文片段抽取。
    const candidates = this.listDocs(
      {
        dirId: options.dirId,
        topicId: options.topicId,
        tag: options.tag,
        tags: options.tags,
        q: trimmed,
        limit: 2000,
        offset: 0,
        includeContent: true,
      },
      2000,
    ).items as types.KnowledgeDoc[];

    const hits: types.KnowledgeSearchHit[] = [];
    for (const doc of candidates) {
      let score = 0;
      const matchedSet = new Set<'title' | 'summary' | 'content' | 'tag'>();
      const lowerTitle = doc.title.toLowerCase();
      const lowerSummary = doc.summary.toLowerCase();
      const lowerContent = doc.content.toLowerCase();
      const lowerTags = doc.tags.map((t) => t.toLowerCase());

      if (terms.length === 0) {
        score = 10;
      }
      for (const term of terms) {
        const lt = term.toLowerCase();
        if (lowerTitle.includes(lt)) {
          score += 50;
          matchedSet.add('title');
        }
        if (lowerTags.some((tg) => tg.includes(lt))) {
          score += 35;
          matchedSet.add('tag');
        }
        if (lowerSummary.includes(lt)) {
          score += 20;
          matchedSet.add('summary');
        }
        if (lowerContent.includes(lt)) {
          score += 10;
          matchedSet.add('content');
        }
      }
      if (score <= 0) continue;

      const { content: _omitted, ...summaryFields } = doc;
      hits.push({
        ...summaryFields,
        snippet: extractSnippet(doc.content, doc.summary, terms),
        score,
        matchedIn: [...matchedSet],
      });
    }

    hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return hits.slice(0, maxHits);
  }

  //----------------------------------------------------------
  // 标签治理（改名、并进已有标签、删除）与相关文档推荐（1.0.2）
  //----------------------------------------------------------

  /** 按名字（大小写不敏感）找标签。 */
  private findTag(name: string): { id: string; name: string } | undefined {
    const sql = 'SELECT id, name FROM kb_tags WHERE name = ? COLLATE NOCASE';
    const cleaned = cleanTag(name);
    const row = this.db.query<{ id: string; name: string }, [string]>(sql).get(cleaned);
    if (row === null) return undefined;

    return row;
  }

  /** 挂着某个标签的文档 ID。 */
  private getTagDocIds(tagId: string): string[] {
    const sql = 'SELECT doc_id FROM kb_doc_tags WHERE tag_id = ?';
    return this.db.query<{ doc_id: string }, [string]>(sql).all(tagId).map((row) => row.doc_id);
  }

  /**
   * 标签变了的文档：updated_at 记成现在（打开着编辑框的人再存会拿到 409 去刷新，不会把旧标签写回来），再刷磁盘镜像。
   * 调用方在事务里先改好关联，本函数在事务里只改时间，镜像在事务外刷。
   */
  private touchDocs(docIds: readonly string[], now: number): void {
    for (const docId of docIds) {
      this.db.query('UPDATE kb_docs SET updated_at = ? WHERE id = ?').run(now, docId);
    }
  }

  /** 事务提交后刷新这批文档的磁盘镜像。 */
  private refreshMirrors(docIds: readonly string[]): void {
    for (const docId of docIds) {
      const doc = this.getDoc(docId);
      if (doc !== undefined) {
        this.syncMirrorWrite(doc);
      }
    }
  }

  /**
   * 标签改名；新名字已经有了就并进去（原标签的文档挂到新标签上，原标签删掉）。
   * @param oldName 原标签名（大小写不敏感）。
   * @param newName 新标签名，照 normalizeTags 的规矩查（不能空、不能带逗号、最多 64 字）。
   * @returns 改名还是合并、影响了几篇。
   * @throws Failure(404) 原标签不存在；Failure(400) 新名字不合法。
   */
  renameTag(oldName: string, newName: string): Omit<types.KnowledgeTagRenameResult, 'ok'> {
    const cleaned = normalizeTags([newName]);
    if (cleaned.length !== 1) {
      throw new failureModule.Failure(400, '新标签名不能为空');
    }
    const target = cleaned[0]!;
    const source = this.findTag(oldName);
    if (source === undefined) {
      throw new failureModule.Failure(404, `标签不存在：${oldName}`);
    }

    //M 新名字是另一个已有标签：合并进去；是它自己（只改大小写）或还没有：原地改名。
    const existing = this.findTag(target);
    let mergeId = '';
    let newNameStored = target;
    if (existing !== undefined && existing.id !== source.id) {
      mergeId = existing.id;
      newNameStored = existing.name;
    }
    const merged = mergeId !== '';
    const docIds = this.getTagDocIds(source.id);
    const now = Date.now();
    this.runTx(() => {
      if (merged) {
        //M INSERT OR IGNORE：两个标签都挂着的文档，主键冲突就跳过。
        const moveSql = 'INSERT OR IGNORE INTO kb_doc_tags (doc_id, tag_id)'
          + ' SELECT doc_id, ? FROM kb_doc_tags WHERE tag_id = ?';
        this.db.query(moveSql).run(mergeId, source.id);
        this.db.query('DELETE FROM kb_doc_tags WHERE tag_id = ?').run(source.id);
        this.db.query('DELETE FROM kb_tags WHERE id = ?').run(source.id);
      }
      if (!merged) {
        this.db.query('UPDATE kb_tags SET name = ? WHERE id = ?').run(target, source.id);
      }
      this.touchDocs(docIds, now);
    });
    this.refreshMirrors(docIds);
    return { oldName: source.name, newName: newNameStored, merged, affectedDocs: docIds.length };
  }

  /**
   * 删除标签：解除它和所有文档的关联再删掉，文档本身不动。
   * @param name 标签名（大小写不敏感）。
   * @returns 删掉的名字和影响了几篇。
   * @throws Failure(404) 标签不存在。
   */
  deleteTag(name: string): Omit<types.KnowledgeTagDeleteResult, 'ok'> {
    const tag = this.findTag(name);
    if (tag === undefined) {
      throw new failureModule.Failure(404, `标签不存在：${name}`);
    }

    const docIds = this.getTagDocIds(tag.id);
    const now = Date.now();
    this.runTx(() => {
      this.db.query('DELETE FROM kb_doc_tags WHERE tag_id = ?').run(tag.id);
      this.db.query('DELETE FROM kb_tags WHERE id = ?').run(tag.id);
      this.touchDocs(docIds, now);
    });
    this.refreshMirrors(docIds);
    return { name: tag.name, affectedDocs: docIds.length };
  }

  /**
   * 相关文档：同专题 +3、每个共同标签 +2、同目录 +1，只要分大于 0 的，排除自己；分高的在前，同分新的在前。
   * @param id 文档 ID。
   * @param limit 最多几篇（调用方已限在 1～20）。
   * @returns 相关文档。
   * @throws Failure(404) 文档不存在。
   */
  getRelated(id: string, limit: number): types.KnowledgeRelatedItem[] {
    const doc = this.getDoc(id);
    if (doc === undefined) {
      throw new failureModule.Failure(404, `文档不存在：${id}`);
    }

    //M 攒每篇候选：同专题、同目录、共同标签各查一次，最后统一算分、拼理由。
    const found = new Map<string, { sameTopic: boolean; sameDir: boolean; shared: string[] }>();
    const getEntry = (docId: string) => {
      const entry = found.get(docId) ?? { sameTopic: false, sameDir: false, shared: [] };
      found.set(docId, entry);
      return entry;
    };
    const idSql = 'SELECT id FROM kb_docs WHERE {column} = ? AND id != ?';
    if (doc.topicId !== null) {
      const topicSql = idSql.replace('{column}', 'topic_id');
      for (const row of this.db.query<{ id: string }, [string, string]>(topicSql).all(doc.topicId, id)) {
        getEntry(row.id).sameTopic = true;
      }
    }
    const tagSql = `
      SELECT dt.doc_id, t.name
      FROM kb_doc_tags dt
      JOIN kb_tags t ON t.id = dt.tag_id
      WHERE dt.tag_id IN (SELECT tag_id FROM kb_doc_tags WHERE doc_id = ?) AND dt.doc_id != ?
      ORDER BY t.name COLLATE NOCASE ASC
    `;
    for (const row of this.db.query<DocTagRow, [string, string]>(tagSql).all(id, id)) {
      getEntry(row.doc_id).shared.push(row.name);
    }
    if (doc.dirId !== null) {
      const dirSql = idSql.replace('{column}', 'dir_id');
      for (const row of this.db.query<{ id: string }, [string, string]>(dirSql).all(doc.dirId, id)) {
        getEntry(row.id).sameDir = true;
      }
    }
    if (found.size === 0) return [];

    //M 取候选的摘要和标签，算分（同专题 +3、每个共同标签 +2、同目录 +1）、拼理由，排序截断。
    const ids = [...found.keys()];
    const placeholders = ids.map(() => '?').join(', ');
    const listSql = `
      SELECT id, dir_id, topic_id, title, summary, '' AS content, source_path, source_type, created_at, updated_at
      FROM kb_docs WHERE id IN (${placeholders})
    `;
    const rows = this.db.query<DocRow, string[]>(listSql).all(...ids);
    const tagMap = this.loadTagsByDocIds(ids);
    const items = rows.map((row): types.KnowledgeRelatedItem => {
      const entry = found.get(row.id)!;
      const reasons: string[] = [];
      let score = entry.shared.length * 2;
      if (entry.sameTopic) {
        score += 3;
        reasons.push('同专题');
      }
      if (entry.shared.length > 0) {
        reasons.push(`共同标签: ${entry.shared.join('、')}`);
      }
      if (entry.sameDir) {
        score += 1;
        reasons.push('同目录');
      }
      return {
        id: row.id,
        title: row.title,
        summary: row.summary,
        dirId: row.dir_id,
        topicId: row.topic_id,
        tags: tagMap.get(row.id) ?? [],
        score,
        reasons,
        updatedAt: row.updated_at,
      };
    });
    items.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return items.slice(0, limit);
  }
}
