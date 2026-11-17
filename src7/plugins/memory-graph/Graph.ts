/**
 * 读 jmbots-memory 的库（data/memory/memory.db，只读）拼关系图：实体是节点，关系是边，边挂着它出自哪几段原文。
 * 隔离空间和服务一样：聊天记录按客户 h:<客户>（含合并进来的别名），知识库按机器人 k:<机器人>。
 * 只读打开；服务那边是 WAL，同时读不挡它写。
 */
import { Database } from 'bun:sqlite';


/** 图上的一个点。 */
export interface GraphNode {
  id: number;
  name: string;
  /** 猜的类别：person 人、org 组织、item 编号/金额/日期、thing 事。只用来上色。 */
  kind: string;
  /** 在这张图里连了几条边。 */
  degree: number;
}

/** 图上的一条边。 */
export interface GraphEdge {
  id: number;
  source: number;
  target: number;
  /** 关系词（去掉两头实体名）。 */
  label: string;
  /** 原句：主语 关系 宾语。 */
  text: string;
  /** 出自哪几段（片段号，GET /api/memory-graph/passage/:id 取原文）。 */
  docs: number[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 这个空间里一共几个实体、几条关系（图被截了时能看出来）。 */
  total: { nodes: number; edges: number };
}

interface RelRow { id: number; text: string; subj: number; obj: number; sn: string; obn: string; docs: string | null }


/** 按名字猜类别（没有类型字段，只为上色好看）。 */
function kindOf(name: string): string {
  if (/[0-9]/u.test(name) || /^(HT|KH)-/u.test(name)) return 'item';
  if (/(公司|科技|集团|餐饮|中心|部|银行|学校|医院|工作室|团队|店)$/u.test(name)) return 'org';
  if (/^(我们|你们|他们|客户|用户|不|没|已)/u.test(name)) return 'thing';
  if (/^[\u4e00-\u9fa5]{2,3}$/u.test(name) && !/(项目|产品|合同|系统|热线|服务|坐席|报价|故障|事务|时间)$/u.test(name)) return 'person';
  return 'thing';
}

/** 关系原句去掉两头实体名，剩下的是关系词。 */
function labelOf(text: string, subj: string, obj: string): string {
  let rest = text;
  if (rest.startsWith(subj)) rest = rest.slice(subj.length);
  if (rest.endsWith(obj)) rest = rest.slice(0, rest.length - obj.length);
  return rest.trim() || text;
}


export class GraphStore {
  private db: Database | undefined;

  constructor(private readonly file: string) {}

  /** 打开（第一次用时；文件不在就报错给页面看）。 */
  private open(): Database {
    this.db ??= new Database(this.file, { readonly: true });
    return this.db;
  }

  /** 一个客户的全部 ID（自己 + 合并进来的别名 + 合并到的主 ID）。 */
  private customerIds(customer: string): string[] {
    const db = this.open();
    const main = (db.query('SELECT customer FROM aliases WHERE alias = ?').get(customer) as { customer: string } | null)?.customer ?? customer;
    const alias = (db.query('SELECT alias FROM aliases WHERE customer = ?').all(main) as { alias: string }[]).map((row) => row.alias);
    return [...new Set([main, customer, ...alias])];
  }

  /** 要看的空间：客户的聊天记录空间，加（可选）机器人知识库空间、公共知识库。 */
  spaces(customer: string, bot: string | undefined, knowledge: boolean): string[] {
    const list = customer === '' ? [] : this.customerIds(customer).map((id) => `h:${id}`);
    if (knowledge) list.push('k:', ...(bot ? [`k:${bot}`] : []));
    return list;
  }

  /** 有图的客户和知识库：给页面下拉框。 */
  customers(): { customer: string; bot: string; docs: number; scope: string }[] {
    return this.open().query(`SELECT customer, MAX(bot) AS bot, COUNT(*) AS docs, scope FROM docs GROUP BY scope, customer ORDER BY scope, docs DESC`).all() as never;
  }

  /** 关系行（带两头名字和出处）。 */
  private relations(where: string, args: (string | number)[]): RelRow[] {
    return this.open().query(`SELECT r.id, r.text, r.subj, r.obj, a.name AS sn, b.name AS obn,
        (SELECT GROUP_CONCAT(doc) FROM rel_docs d WHERE d.relation = r.id) AS docs
      FROM relations r JOIN entities a ON a.id = r.subj JOIN entities b ON b.id = r.obj WHERE ${where}`).all(...args) as RelRow[];
  }

  /** 关系行拼成图。 */
  private build(rows: RelRow[], total: Graph['total']): Graph {
    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    for (const row of rows) {
      for (const [id, name] of [[row.subj, row.sn], [row.obj, row.obn]] as [number, string][]) {
        const node = nodes.get(id) ?? { id, name, kind: kindOf(name), degree: 0 };
        node.degree += 1;
        nodes.set(id, node);
      }
      edges.push({ id: row.id, source: row.subj, target: row.obj, label: labelOf(row.text, row.sn, row.obn), text: row.text,
        docs: (row.docs ?? '').split(',').filter(Boolean).map(Number) });
    }
    return { nodes: [...nodes.values()], edges, total };
  }

  /** 空间里一共几个实体、几条关系。 */
  private total(spaces: string[]): Graph['total'] {
    const marks = spaces.map(() => '?').join(',');
    const db = this.open();
    const nodes = (db.query(`SELECT COUNT(*) AS n FROM entities WHERE space IN (${marks})`).get(...spaces) as { n: number }).n;
    const edges = (db.query(`SELECT COUNT(*) AS n FROM relations WHERE space IN (${marks})`).get(...spaces) as { n: number }).n;
    return { nodes, edges };
  }

  /**
   * 整张图：空间里的关系，最多 limit 条边（连得多的实体优先）；给了 focus 就只要这个实体和它 depth 跳以内的。
   */
  graph(spaces: string[], limit: number, focus?: string, depth = 1): Graph {
    if (spaces.length === 0) return { nodes: [], edges: [], total: { nodes: 0, edges: 0 } };
    const marks = spaces.map(() => '?').join(',');
    const all = this.relations(`r.space IN (${marks})`, spaces);
    let rows = all;
    if (focus) {
      let ents = new Set(all.filter((row) => row.sn === focus || row.obn === focus).flatMap((row) => [row.subj, row.obj]));
      for (let step = 1; step < depth; step++) {
        ents = new Set(all.filter((row) => ents.has(row.subj) || ents.has(row.obj)).flatMap((row) => [row.subj, row.obj]));
      }
      rows = all.filter((row) => ents.has(row.subj) || ents.has(row.obj));
    }
    if (rows.length > limit) {
      const degree = new Map<number, number>();
      for (const row of rows) for (const id of [row.subj, row.obj]) degree.set(id, (degree.get(id) ?? 0) + 1);
      const weight = (row: RelRow) => (degree.get(row.subj) ?? 0) + (degree.get(row.obj) ?? 0);
      rows = [...rows].sort((a, b) => weight(b) - weight(a)).slice(0, limit);
    }
    return this.build(rows, this.total(spaces));
  }

  /**
   * 一次检索的命中子图：服务返回的关系原句 → 关系行（命中边），再带上命中实体的一跳邻居（最多 extra 条）。
   * @returns 图，和命中的边号、点号。
   */
  hitGraph(spaces: string[], texts: string[], extra: number): Graph & { hitEdges: number[]; hitNodes: number[] } {
    if (spaces.length === 0 || texts.length === 0) return { nodes: [], edges: [], total: { nodes: 0, edges: 0 }, hitEdges: [], hitNodes: [] };
    const marks = spaces.map(() => '?').join(',');
    const uniq = [...new Set(texts)];
    const hit = this.relations(`r.space IN (${marks}) AND r.text IN (${uniq.map(() => '?').join(',')})`, [...spaces, ...uniq]);
    const hitNodes = [...new Set(hit.flatMap((row) => [row.subj, row.obj]))];
    const near = hitNodes.length === 0 ? [] : this.relations(
      `r.space IN (${marks}) AND (r.subj IN (${hitNodes.join(',')}) OR r.obj IN (${hitNodes.join(',')}))`, spaces)
      .filter((row) => !hit.some((h) => h.id === row.id)).slice(0, extra);
    return { ...this.build([...hit, ...near], this.total(spaces)), hitEdges: hit.map((row) => row.id), hitNodes };
  }

  /** 一段原文 + 挂在它上面的关系。 */
  passage(id: number): unknown {
    const db = this.open();
    const doc = db.query('SELECT id, source, scope, bot, customer, session, title, text, at, start_at AS start, end_at AS end FROM docs WHERE id = ?').get(id);
    const relations = (db.query('SELECT r.id, r.text FROM relations r JOIN rel_docs d ON d.relation = r.id WHERE d.doc = ?').all(id));
    return { passage: doc, relations };
  }

  /** 一个实体：连着的关系 + 这些关系出自的原文（最多 12 段）。 */
  entity(id: number): unknown {
    const db = this.open();
    const node = db.query('SELECT id, name, space FROM entities WHERE id = ?').get(id);
    const rels = this.relations('r.subj = ? OR r.obj = ?', [id, id]);
    const docIds = [...new Set(rels.flatMap((row) => (row.docs ?? '').split(',').filter(Boolean).map(Number)))].slice(0, 12);
    const docs = docIds.length === 0 ? [] : db.query(`SELECT id, title, text, customer, scope FROM docs WHERE id IN (${docIds.join(',')})`).all();
    return { entity: node, relations: rels.map((row) => ({ id: row.id, text: row.text })), docs };
  }

  /** 一条关系：原句、两头、出自的原文。 */
  edge(id: number): unknown {
    const row = this.relations('r.id = ?', [id])[0];
    if (row === undefined) return { relation: null, docs: [] };
    const docIds = (row.docs ?? '').split(',').filter(Boolean).map(Number);
    const docs = docIds.length === 0 ? [] : this.open().query(`SELECT id, title, text, customer, scope FROM docs WHERE id IN (${docIds.join(',')})`).all();
    return { relation: { id: row.id, text: row.text, subject: row.sn, object: row.obn, label: labelOf(row.text, row.sn, row.obn) }, docs };
  }
}
