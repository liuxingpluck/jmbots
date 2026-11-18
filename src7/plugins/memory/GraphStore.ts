/**
 * 读 jmbots-memory 的库（data/memory/memory.db，只读）拼关系图：实体是节点，关系是边，边挂着它出自哪几段原文。
 * 隔离空间和服务一样：聊天记录按客户 h:<客户>（含合并进来的别名），知识库按机器人 k:<机器人>。
 * 只读打开；服务那边是 WAL，同时读不挡它写。
 */
import { Database } from 'bun:sqlite';
import * as channel from './ChannelIndex.ts';


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

/** 返回给前端的完整关系图结构。 */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 这个空间里一共几个实体、几条关系（图被截了时能看出来）。 */
  total: { nodes: number; edges: number };
}

/** 查询 relations 表连带实体与出处片段号的内部行结构。 */
interface RelRow {
  id: number;
  text: string;
  subj: number;
  obj: number;
  sn: string;
  obn: string;
  docs: string | null;
}


/** 按名字猜类别（没有类型字段，只为上色好看）。 */
function getKind(name: string): string {
  if (/[0-9]/u.test(name) || /^(HT|KH)-/u.test(name)) return 'item';

  if (/(公司|科技|集团|餐饮|中心|部|银行|学校|医院|工作室|团队|店)$/u.test(name)) return 'org';

  if (/^(我们|你们|他们|客户|用户|不|没|已)/u.test(name)) return 'thing';

  if (/^[\u4e00-\u9fa5]{2,3}$/u.test(name) && !/(项目|产品|合同|系统|热线|服务|坐席|报价|故障|事务|时间)$/u.test(name)) return 'person';

  return 'thing';
}

/** 关系原句去掉两头实体名，剩下的是关系词。 */
function getLabel(text: string, subj: string, obj: string): string {
  //M 原句开头是主语名的剥掉主语。
  let rest = text;
  if (rest.startsWith(subj)) {
    rest = rest.slice(subj.length);
  }

  //M 结尾是宾语名的剥掉宾语。
  if (rest.endsWith(obj)) {
    rest = rest.slice(0, rest.length - obj.length);
  }

  //M 剥完还剩字就是关系词；剥空了（原句只有两头名字）退回整句。
  const trimmed = rest.trim();
  if (trimmed !== '') return trimmed;

  return text;
}

/** 把逗号分隔的文档编号字符串解析成数字列表。 */
function parseDocIds(raw: string | null): number[] {
  //M 库里 GROUP_CONCAT 拼出来的是 "1,2,3"，没有出处时是 null：当空串拆，滤掉空项再转数字。
  return (raw ?? '').split(',').filter(Boolean).map(Number);
}


/**
 * 关系图只读存储：读取 jmbots-memory 写入的只读 SQLite，按客户和知识库空间查询关系网、命中子图与原文出处。
 */
export class GraphStore {
  /** 打开后的只读库；第一次查时才开（open）。 */
  private db: Database | undefined;

  /**
   * @param file jmbots-memory 的库文件（数据目录下 data/memory/memory.db），只读打开。
   */
  constructor(private readonly file: string) {}

  /** 打开数据库（第一次用时；文件不在就抛错给页面看）。 */
  private open(): Database {
    //M 懒打开：第一次查时才只读打开，之后一直复用这个连接。
    if (this.db === undefined) {
      this.db = new Database(this.file, { readonly: true });
    }
    return this.db;
  }

  /** 一个客户的全部 ID（自己 + 合并进来的别名 + 合并到的主 ID）。 */
  private customerIds(customer: string): string[] {
    //M 先查这个 ID 是不是别人的别名：是就换成它合并到的主 ID。
    const db = this.open();
    const row = db.query('SELECT customer FROM aliases WHERE alias = ?').get(customer) as { customer: string } | null;
    let main = customer;
    if (row !== null) {
      main = row.customer;
    }

    //M 再把挂在主 ID 下的别名都取出来，和主 ID、传进来的 ID 去重拼成一组。
    const aliasRows = db.query('SELECT alias FROM aliases WHERE customer = ?').all(main) as { alias: string }[];
    const alias = aliasRows.map((item) => item.alias);
    return [...new Set([main, customer, ...alias])];
  }

  /**
   * 要看的空间：客户的聊天记录空间，加（可选）机器人知识库空间、公共知识库。
   * @param customer 客户号；空串表示不看聊天记录。
   * @param bot 机器人名；给了且 knowledge 为 true 时加它的知识库。
   * @param knowledge 要不要带知识库空间。
   * @returns 空间名列表，如 h:<客户>、k:、k:<机器人>。
   */
  spaces(customer: string, bot: string | undefined, knowledge: boolean): string[] {
    //M 有客户才加聊天记录空间：客户自己和它的别名各一个 h:<ID>。
    let list: string[] = [];
    if (customer !== '') {
      list = this.customerIds(customer).map((id) => `h:${id}`);
    }

    //M 要带知识库时加公共库 k:，再加这个机器人自己的 k:<机器人>。
    if (knowledge) {
      list.push('k:');
      if (bot) {
        list.push(`k:${bot}`);
      }
    }
    return list;
  }

  /**
   * 有图的客户和知识库：给页面下拉框。
   * @returns 每个空间（scope）下每个客户一项：机器人、片段数；按空间、片段数从多到少排。
   */
  customers(): { customer: string; bot: string; docs: number; scope: string }[] {
    //M 只列客服和知识库的空间，渠道聊天有独立的检索入口。
    const sql = 'SELECT customer, MAX(bot) AS bot, COUNT(*) AS docs, scope FROM docs'
      + ' WHERE customer NOT GLOB ? GROUP BY scope, customer ORDER BY scope, docs DESC';
    const hidden = `${channel.CHANNEL_PARTITION}*`;
    const db = this.open();
    return db.query(sql).all(hidden) as never;
  }

  /** 关系行（带两头名字和出处）。 */
  private relations(where: string, args: (string | number)[]): RelRow[] {
    //M 关系连上两头实体取名字，出处片段号用子查询拼成逗号串；条件和参数由调用方给。
    const sql = `SELECT r.id, r.text, r.subj, r.obj, a.name AS sn, b.name AS obn,
        (SELECT GROUP_CONCAT(doc) FROM rel_docs d WHERE d.relation = r.id) AS docs
      FROM relations r JOIN entities a ON a.id = r.subj JOIN entities b ON b.id = r.obj WHERE ${where}`;
    return this.open().query(sql).all(...args) as RelRow[];
  }

  /** 关系行拼成图。 */
  private build(rows: RelRow[], total: Graph['total']): Graph {
    //M 同一个实体会出现在多条关系里，用 Map 按实体号合并成一个点。
    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    for (const row of rows) {
      //M 两头实体各记一个点（第一次见才猜类别），每出现在一条边上度数加一。
      for (const [id, nodeName] of [[row.subj, row.sn], [row.obj, row.obn]] as [number, string][]) {
        const node = nodes.get(id) ?? { id, name: nodeName, kind: getKind(nodeName), degree: 0 };
        node.degree += 1;
        nodes.set(id, node);
      }

      //M 每条关系一条边：关系词从原句剥出来，出处拆成片段号列表。
      edges.push({
        id: row.id,
        source: row.subj,
        target: row.obj,
        label: getLabel(row.text, row.sn, row.obn),
        text: row.text,
        docs: parseDocIds(row.docs),
      });
    }

    //M 点从 Map 里取出来成数组，连同总数交给页面。
    return { nodes: [...nodes.values()], edges, total };
  }

  /** 空间里一共几个实体、几条关系。 */
  private total(spaces: string[]): Graph['total'] {
    //M IN (...) 按空间个数拼 ? 占位，分别数实体和关系，图被截了页面也能看出总数。
    const marks = spaces.map(() => '?').join(',');
    const db = this.open();
    const nodes = (db.query(`SELECT COUNT(*) AS n FROM entities WHERE space IN (${marks})`).get(...spaces) as { n: number }).n;
    const edges = (db.query(`SELECT COUNT(*) AS n FROM relations WHERE space IN (${marks})`).get(...spaces) as { n: number }).n;
    return { nodes, edges };
  }

  /**
   * 整张图：空间里的关系，最多 limit 条边（连得多的实体优先）；给了 focus 就只要这个实体和它 depth 跳以内的。
   * @param spaces 要看的空间（spaces() 算出来的）。
   * @param limit 最多几条边。
   * @param focus 只看这个实体名附近；不给就是整张图。
   * @param depth focus 往外几跳，默认 1。
   * @returns 图和这些空间里的实体、关系总数。
   */
  graph(spaces: string[], limit: number, focus?: string, depth = 1): Graph {
    if (spaces.length === 0) return { nodes: [], edges: [], total: { nodes: 0, edges: 0 } };

    //M 先取这些空间里的全部关系，下面再按 focus 和 limit 往下筛。
    const marks = spaces.map(() => '?').join(',');
    const all = this.relations(`r.space IN (${marks})`, spaces);
    let rows = all;

    //M 给了 focus：先取和它直接相连的实体，每多一跳就把连到这些实体的关系两头也纳进来。
    if (focus) {
      let ents = new Set(all.filter((row) => row.sn === focus || row.obn === focus).flatMap((row) => [row.subj, row.obj]));
      for (let step = 1; step < depth; step++) {
        ents = new Set(all.filter((row) => ents.has(row.subj) || ents.has(row.obj)).flatMap((row) => [row.subj, row.obj]));
      }

      //M 只留至少一头落在这些实体里的关系。
      rows = all.filter((row) => ents.has(row.subj) || ents.has(row.obj));
    }

    //M 关系太多就截：先数每个实体连了几条，再按分量从大到小留前 limit 条。
    if (rows.length > limit) {
      const degree = new Map<number, number>();
      for (const row of rows) {
        for (const id of [row.subj, row.obj]) {
          degree.set(id, (degree.get(id) ?? 0) + 1);
        }
      }

      //M 一条关系的分量是两头实体度数之和，连得多的实体身上的关系排前面。
      const weight = (row: RelRow) => (degree.get(row.subj) ?? 0) + (degree.get(row.obj) ?? 0);
      rows = [...rows].sort((a, b) => weight(b) - weight(a)).slice(0, limit);
    }

    //M 筛好的关系拼成图，总数按整个空间数，页面能看出截掉了多少。
    return this.build(rows, this.total(spaces));
  }

  /**
   * 一次检索的命中子图：服务返回的关系原句 → 关系行（命中边），再带上命中实体的一跳邻居（最多 extra 条）。
   * @param spaces 要看的空间。
   * @param texts 服务返回的关系原句（可重复）。
   * @param extra 邻居边最多几条。
   * @returns 图，和命中的边号、点号。
   */
  hitGraph(spaces: string[], texts: string[], extra: number): Graph & { hitEdges: number[]; hitNodes: number[] } {
    if (spaces.length === 0 || texts.length === 0) return { nodes: [], edges: [], total: { nodes: 0, edges: 0 }, hitEdges: [], hitNodes: [] };

    //M 按原句（去重）在这些空间里找回关系行，就是命中的边；两头实体就是命中的点。
    const marks = spaces.map(() => '?').join(',');
    const uniq = [...new Set(texts)];
    const hit = this.relations(`r.space IN (${marks}) AND r.text IN (${uniq.map(() => '?').join(',')})`, [...spaces, ...uniq]);
    const hitNodes = [...new Set(hit.flatMap((row) => [row.subj, row.obj]))];

    //M 命中的点再带一跳邻居关系（去掉已命中的），最多 extra 条，图上能看到上下文。
    let near: RelRow[] = [];
    if (hitNodes.length > 0) {
      near = this.relations(
        `r.space IN (${marks}) AND (r.subj IN (${hitNodes.join(',')}) OR r.obj IN (${hitNodes.join(',')}))`,
        spaces,
      ).filter((row) => !hit.some((item) => item.id === row.id)).slice(0, extra);
    }

    //M 命中边和邻居边一起拼图，另带命中的边号、点号给页面高亮。
    return { ...this.build([...hit, ...near], this.total(spaces)), hitEdges: hit.map((row) => row.id), hitNodes };
  }

  /**
   * 一段原文 + 挂在它上面的关系。
   * @param id 片段号。
   * @returns { passage, relations }：片段不存在时 passage 是 null。
   */
  passage(id: number): unknown {
    //M 取片段原文（起止时间改名成 start、end 给页面），再取挂在这段上的关系。
    const db = this.open();
    const doc = db.query('SELECT id, source, scope, bot, customer, session, title, text, at, start_at AS start, end_at AS end FROM docs WHERE id = ?').get(id);
    const relations = db.query('SELECT r.id, r.text FROM relations r JOIN rel_docs d ON d.relation = r.id WHERE d.doc = ?').all(id);
    return { passage: doc, relations };
  }

  /** 从本地只读库取同一出处的相邻段，先确认锚点与 Rust 服务的原文一致。 */
  passageContext(anchor: {
    id: number; source: string; scope: string; bot: string; customer: string;
    session: string; start: number; end: number; text: string;
  }, limit: number): { before: unknown[]; after: unknown[] } | undefined {
    //M 同一篇文档或会话的邻段必须共享作用域、客户、机器人和来源。
    const db = this.open();
    const filter = ' FROM docs WHERE source = ? AND scope = ? AND bot = ? AND customer = ? AND session = ?';
    const fields = [anchor.source, anchor.scope, anchor.bot, anchor.customer, anchor.session];
    const check = `SELECT 1${filter} AND id = ? AND start_at = ? AND end_at = ? AND text = ?`;
    const found = db.query(check).get(...fields, anchor.id, anchor.start, anchor.end, anchor.text);
    if (found === null) return undefined;

    //M 同一来源按段落起止和编号排序，分别取指定条数的前文、后文。
    const columns = 'SELECT id, title, text, at, start_at AS start, end_at AS end';
    const beforeSql = `${columns}${filter} AND (start_at,end_at,id) < (?,?,?)`
      + ' ORDER BY start_at DESC, end_at DESC, id DESC LIMIT ?';
    const afterSql = `${columns}${filter} AND (start_at,end_at,id) > (?,?,?)`
      + ' ORDER BY start_at, end_at, id LIMIT ?';
    const position = [anchor.start, anchor.end, anchor.id, limit];
    const before = db.query(beforeSql).all(...fields, ...position);
    const after = db.query(afterSql).all(...fields, ...position);
    return { before: before.reverse(), after };
  }

  /**
   * 一个实体：连着的关系 + 这些关系出自的原文（最多 12 段）。
   * @param id 实体号。
   * @returns { entity, relations, docs }：实体不存在时 entity 是 null。
   */
  entity(id: number): unknown {
    //M 取实体本身和连着它的关系，再从这些关系的出处里去重取前 12 个片段号。
    const db = this.open();
    const node = db.query('SELECT id, name, space FROM entities WHERE id = ?').get(id);
    const rels = this.relations('r.subj = ? OR r.obj = ?', [id, id]);
    const docIds = [...new Set(rels.flatMap((row) => parseDocIds(row.docs)))].slice(0, 12);

    //M 有出处才查原文；片段号是库里来的整数，直接拼进 IN。
    let docs: unknown[] = [];
    if (docIds.length > 0) {
      docs = db.query(`SELECT id, title, text, customer, scope FROM docs WHERE id IN (${docIds.join(',')})`).all();
    }

    //M 关系只给页面要的号和原句。
    return { entity: node, relations: rels.map((row) => ({ id: row.id, text: row.text })), docs };
  }

  /**
   * 一条关系：原句、两头、出自的原文。
   * @param id 关系号。
   * @returns { relation, docs }：关系不存在时 relation 是 null、docs 是空。
   */
  edge(id: number): unknown {
    //G 按关系号取一行（带两头名字和出处），没有就给空。
    const row = this.relations('r.id = ?', [id])[0];
    if (row === undefined) return { relation: null, docs: [] };

    //M 有出处片段才查原文。
    const docIds = parseDocIds(row.docs);
    let docs: unknown[] = [];
    if (docIds.length > 0) {
      docs = this.open().query(`SELECT id, title, text, customer, scope FROM docs WHERE id IN (${docIds.join(',')})`).all();
    }

    //M 原句、主语、宾语和剥出来的关系词一起给页面。
    return { relation: { id: row.id, text: row.text, subject: row.sn, object: row.obn, label: getLabel(row.text, row.sn, row.obn) }, docs };
  }
}
