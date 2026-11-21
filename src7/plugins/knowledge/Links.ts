/**
 * 积木知识库的 [[双链]]（1.1.0）：从 Markdown 正文解析 [[标题]]、[[标题|别名]]，维护 kb_links 关系表，
 * 按标题（大小写不敏感）把链接连到文档上，给出引出链接、反向链接和图谱。
 * 写入都由 KnowledgeStore 在它自己的事务里调用，这里不开事务、不碰磁盘镜像。
 */
import type { Database } from 'bun:sqlite';
import * as failureModule from '../../utils/Failure.ts';
import type * as types from './Types.ts';


/**
 * 迁移第 4 版：[[双链]] 关系表。主键是（写链接的文档, 目标标题），target_id 按标题找到的文档，没有是 NULL（悬空）。
 * 写成 Drizzle 的分段格式，db.migrate 逐句执行。
 */
export const LINKS_SQL = [
  `CREATE TABLE IF NOT EXISTS kb_links (
  source_id TEXT NOT NULL,
  target_title TEXT NOT NULL,
  target_id TEXT,
  PRIMARY KEY (source_id, target_title)
)`,
  'CREATE INDEX IF NOT EXISTS idx_kb_links_target ON kb_links (target_id)',
  'CREATE INDEX IF NOT EXISTS idx_kb_links_title ON kb_links (target_title COLLATE NOCASE)',
].join(';\n--> statement-breakpoint\n');

/** [[目标]] 或 [[目标|别名]]：目标里不能有方括号、竖线、换行。 */
const WIKI_LINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/gu;

/** 围栏代码块（``` 或 ~~~ 开头的一行，到同样的符号结束）。 */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/u;

/** 行内代码：一对或多对反引号包着的一段。 */
const INLINE_CODE = /(`+)[^`]*?\1/gu;


/** 正文里解析出的一条双链。 */
export interface WikiLink {
  /** 目标标题（去掉两头空白）。 */
  title: string;
  /** 显示的别名；没写是 undefined。 */
  alias: string | undefined;
}


/**
 * 从 Markdown 正文里找出全部 [[双链]]：跳过围栏代码块和行内代码，标题按大小写不敏感去重，留第一次的写法。
 * @param content Markdown 正文。
 * @returns 按出现先后排列的链接。
 */
export function parseWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  const seen = new Set<string>();
  let fence = '';
  for (const line of content.split(/\r?\n/u)) {
    //M 围栏代码块：遇到开头记下符号，遇到同样的符号收尾，中间的行整行跳过。
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch !== null && fence === '') {
      fence = fenceMatch[1]!.slice(0, 3);
      continue;
    }
    if (fenceMatch !== null && fenceMatch[1]!.startsWith(fence)) {
      fence = '';
      continue;
    }
    if (fence !== '') continue;

    //M 行内代码先换成空格（长度不变），剩下的部分再找 [[ ]]。
    const plain = line.replace(INLINE_CODE, (code) => ' '.repeat(code.length));
    for (const match of plain.matchAll(WIKI_LINK)) {
      const title = match[1]!.trim();
      const key = title.toLowerCase();
      if (title === '' || seen.has(key)) continue;

      seen.add(key);
      const alias = match[2]?.trim();
      links.push({ title, alias: alias || undefined });
    }
  }
  return links;
}


/** kb_links 的一行。 */
interface LinkRow {
  source_id: string;
  target_title: string;
  target_id: string | null;
}

/** 图谱节点要的文档字段。 */
interface NodeRow {
  id: string;
  title: string;
  is_system_rule: number;
}


/** 按标题找文档 ID 的子查询：大小写不敏感，同名的取最早建的那篇。 */
const RESOLVE_SQL = `(
  SELECT d.id FROM kb_docs d
  WHERE d.title = kb_links.target_title COLLATE NOCASE
  ORDER BY d.created_at ASC, d.id ASC
  LIMIT 1
)`;


/** kb_links 的读写。 */
export class KnowledgeLinks {
  /**
   * @param db 应用共享 SQLite 连接（和 KnowledgeStore 同一个）。
   */
  constructor(private readonly db: Database) {}

  /**
   * 重写一篇文档的引出链接：先删掉它原来的，再按正文解析出来的逐条插入，并按标题连上已有文档。
   * 由 KnowledgeStore 在建文档、改正文的事务里调用。
   * @param docId 写链接的文档。
   * @param content 它的正文。
   */
  refreshDoc(docId: string, content: string): void {
    this.db.query('DELETE FROM kb_links WHERE source_id = ?').run(docId);
    const insertSql = `INSERT OR IGNORE INTO kb_links (source_id, target_title, target_id) VALUES (?, ?, NULL)`;
    for (const link of parseWikiLinks(content)) {
      this.db.query(insertSql).run(docId, link.title);
    }
    const resolveSql = `UPDATE kb_links SET target_id = ${RESOLVE_SQL} WHERE source_id = ?`;
    this.db.query(resolveSql).run(docId);
  }

  /**
   * 指向这些标题的链接重新按标题找一遍文档：新建、改名、删除文档后调，悬空的连上，删掉的置空（或换成另一篇同名的）。
   * @param titles 变动的标题（改名时新旧两个都给）。
   */
  relinkTitles(titles: readonly string[]): void {
    for (const title of titles) {
      const sql = `UPDATE kb_links SET target_id = ${RESOLVE_SQL} WHERE target_title = ? COLLATE NOCASE`;
      this.db.query(sql).run(title);
    }
  }

  /**
   * 删掉一篇文档写出去的全部链接（删文档时调）。
   * @param docId 被删的文档。
   */
  removeSource(docId: string): void {
    this.db.query('DELETE FROM kb_links WHERE source_id = ?').run(docId);
  }

  /** 关系表是空的（老库刚升到第 4 版，还没回填）。 */
  isEmpty(): boolean {
    const row = this.db.query<{ one: number }, []>('SELECT 1 AS one FROM kb_links LIMIT 1').get();
    return row === null;
  }

  /**
   * 按全部文档的正文重建关系表（老库升级后回填一次）。
   * //退场：所有运行中的库都升到 knowledge 1.1.0、kb_links 回填过以后，连同 index.ts 里的调用一起删。
   */
  rebuildAll(): void {
    const rows = this.db.query<{ id: string; content: string }, []>('SELECT id, content FROM kb_docs').all();
    const work = this.db.transaction(() => {
      for (const row of rows) {
        this.refreshDoc(row.id, row.content);
      }
    });
    work();
  }

  /**
   * 一篇文档的引出链接和反向链接。
   * @param docId 文档 ID（调用方已确认存在）。
   * @returns 引出链接按正文先后；反向链接不含自己，新的在前。
   */
  getLinks(docId: string): Omit<types.KnowledgeLinksResponse, 'ok'> {
    const outSql = 'SELECT source_id, target_title, target_id FROM kb_links WHERE source_id = ? ORDER BY rowid ASC';
    const outRows = this.db.query<LinkRow, [string]>(outSql).all(docId);
    const outgoing = outRows.map((row): types.KnowledgeOutlink => ({
      targetTitle: row.target_title,
      targetId: row.target_id,
      exists: row.target_id !== null,
    }));

    const backSql = `
      SELECT DISTINCT d.id, d.title, d.summary, d.updated_at
      FROM kb_links l
      JOIN kb_docs d ON d.id = l.source_id
      WHERE l.target_id = ? AND l.source_id != ?
      ORDER BY d.updated_at DESC, d.id DESC
    `;
    type BackRow = { id: string; title: string; summary: string; updated_at: number };
    const backRows = this.db.query<BackRow, [string, string]>(backSql).all(docId, docId);
    const backlinks = backRows.map((row): types.KnowledgeBacklink => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      updatedAt: row.updated_at,
    }));
    return { outgoing, backlinks };
  }

  /**
   * 双链图谱。不带 centerId：全部文档和全部连上的链接；带了：中心和它的一跳邻居，以及连着中心的边。
   * 指向自己的链接、悬空的链接不画。
   * @param centerId 中心文档 ID；不给是整个知识库。
   * @param getTags 按文档 ID 批量取标签（KnowledgeStore 传它自己的 loadTagsByDocIds）。
   * @returns 节点和边。
   * @throws Failure(404) 中心文档不存在。
   */
  getGraph(
    centerId: string | undefined,
    getTags: (ids: readonly string[]) => Map<string, string[]>,
  ): Omit<types.KnowledgeGraphResponse, 'ok'> {
    //M 先取边：连上了、不指向自己；有中心时只要一头是中心的。
    let edgeSql = `
      SELECT source_id, target_title, target_id FROM kb_links
      WHERE target_id IS NOT NULL AND target_id != source_id
    `;
    const params: string[] = [];
    if (centerId !== undefined) {
      edgeSql += ' AND (source_id = ? OR target_id = ?)';
      params.push(centerId, centerId);
    }
    const edgeRows = this.db.query<LinkRow, string[]>(`${edgeSql} ORDER BY rowid ASC`).all(...params);
    const edges = edgeRows.map((row): types.KnowledgeGraphEdge => ({
      source: row.source_id,
      target: row.target_id!,
      targetTitle: row.target_title,
    }));

    //M 再取节点：整个库是全部文档；有中心时是中心加边上出现过的文档。
    const allSql = 'SELECT id, title, is_system_rule FROM kb_docs ORDER BY updated_at DESC';
    let nodeRows = this.db.query<NodeRow, []>(allSql).all();
    if (centerId !== undefined) {
      const ids = new Set([centerId]);
      for (const edge of edges) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
      const marks = [...ids].map(() => '?').join(', ');
      const sql = `SELECT id, title, is_system_rule FROM kb_docs WHERE id IN (${marks}) ORDER BY updated_at DESC`;
      nodeRows = this.db.query<NodeRow, string[]>(sql).all(...ids);
      if (!nodeRows.some((row) => row.id === centerId)) {
        throw new failureModule.Failure(404, `文档不存在：${centerId}`);
      }
    }

    //M 度数：这张图里每个节点连着几条边。
    const degrees = new Map<string, number>();
    for (const edge of edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }
    const tagMap = getTags(nodeRows.map((row) => row.id));
    const nodes = nodeRows.map((row): types.KnowledgeGraphNode => ({
      id: row.id,
      title: row.title,
      tags: tagMap.get(row.id) ?? [],
      isSystemRule: row.is_system_rule === 1,
      degree: degrees.get(row.id) ?? 0,
    }));
    return { nodes, edges };
  }
}
