/** 校验并持久化整张决策图，记录单调递增的改动历史。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as types from './Types.ts';

/** 原子保存的快照含最近的改动，重启时可补上最后一条历史。 */
interface SavedGraph extends types.DecisionGraph {
  /** 已提交给快照、可能还未追加到历史的记录。 */
  head?: types.DecisionChange;
}

/** 对外的 API 输入错误，交由 HTTP 层返回 400。 */
function invalid(message: string): never {
  //G 统一报告接口输入不合法，保持已保存的图不变。
  throw new failureModule.Failure(400, message);
}

/** 只接收普通 JSON 对象。 */
export function readObject(raw: unknown): Record<string, unknown> {
  //G 节点与请求体都需要按字段读取，先拦截数组和空值。
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('需要 JSON 对象');

  return raw as Record<string, unknown>;
}

/** 读选项、标题和节点号时要求给出非空文本。 */
export function readText(value: unknown, field: string): string {
  //G 空文本不能作为名称或标识。
  if (typeof value !== 'string' || value.trim() === '') return invalid(`${field} 要是非空文本`);

  return value.trim();
}

/** 校验可省略的字符串字段。 */
function readOptional(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;

  //G 可选字段提供时必须是字符串。
  if (typeof value !== 'string') return invalid(`${field} 要是文本`);

  return value.trim();
}

/** 校验名称列表。 */
function readList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;

  //G 先校验列表形状，再要求其中每项是有效文本。
  if (!Array.isArray(value)) return invalid(`${field} 要是列表`);

  //M 分别清理每项的首尾空格，形成可用于连线或显示的值。
  return value.map((entry: unknown) => readText(entry, field));
}

/** 读取 JSON 中的毫秒时间戳，避免无效日期进入历史。 */
function readTime(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;

  //G Date 的有效范围比 JavaScript 安全整数范围略小。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8.64e15) {
    return invalid(`${field} 要是有效的毫秒时间戳`);
  }
  return value;
}

/** 检查待选项，选项号必须能在本节点内唯一定位。 */
function readOptions(value: unknown): types.DecisionOption[] | undefined {
  if (value === undefined) return undefined;

  //G 候选项必须能逐个校验。
  if (!Array.isArray(value)) return invalid('options 要是列表');

  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    //G 选项号随点选请求传回，必须在节点内唯一。
    const item = readObject(entry);
    const id = readText(item['id'], 'options.id');
    if (ids.has(id)) return invalid(`选项 ${id} 重复`);

    //M 提前校验推荐标记，网页可以直接展示。
    const recommended = item['recommended'];
    if (recommended !== undefined && typeof recommended !== 'boolean') return invalid('recommended 要是布尔值');

    ids.add(id);

    //M 网页分别使用必填标题和可选代价。
    const text = readText(item['text'], 'options.text');
    const cost = readOptional(item['cost'], 'options.cost');
    return { id, text, cost, recommended };
  });
}

/** 批量写入中的一项，继承已有节点未指定的字段。 */
function readNode(id: string, raw: Record<string, unknown>, before: types.DecisionNode | undefined, now: number) {
  const item = { ...before, ...raw };
  const kind = item['kind'] as types.DecisionKind;
  const status = item['status'] as types.DecisionStatus;

  //G 只有约定的节点类型和状态能进入画布。
  if (!types.KINDS.includes(kind)) return invalid(`${id} 的 kind 不合法`);
  if (!types.STATUSES.includes(status)) return invalid(`${id} 的 status 不合法`);

  //M 标题用于图上节点，摘要用于详情栏。
  const title = readText(item['title'], 'title');
  const summary = readOptional(item['summary'], 'summary') ?? '';
  const parent = item['parent'] ?? null;

  //G 中心之外的节点必须有可以追踪到的父编号。
  if (parent !== null && (typeof parent !== 'string' || parent.trim() === '')) return invalid(`${id} 的 parent 不合法`);

  //G 可选的决定必须实际提供选项。
  const suppliedOptions = readOptions(item['options']);
  let options = suppliedOptions;
  if (before?.chosen !== undefined) {
    //M 已选节点继续显示当时的选项，即使发布方重发了不同的选项文字。
    options = before.options;
  }
  if (kind === 'pending' && status === 'open' && (options === undefined || options.length === 0)) {
    return invalid(`${id} 待定时至少要有一个选项`);
  }
  const main = item['main'];

  //G 主线标记交给布局直接使用，入口保证是布尔值。
  if (main !== undefined && typeof main !== 'boolean') return invalid(`${id} 的 main 要是布尔值`);

  //M 详情材料、依赖和既有确认随快照一起保存。
  const detailPath = readOptional(item['detailPath'], 'detailPath');
  const sources = readList(item['sources'], 'sources');
  const links = readList(item['links'], 'links');
  const needs = readList(item['needs'], 'needs');
  const chosen = readOptional(item['chosen'], 'chosen');
  const createdAt = readTime(item['createdAt'], 'createdAt') ?? now;
  let decidedAt = readTime(item['decidedAt'], 'decidedAt');
  let decidedBy = item['decidedBy'];

  //G 已做的选择不会被中控的过期快照覆盖。
  if (before?.chosen !== undefined && (chosen !== before.chosen || kind !== 'decided' || status === 'open')) {
    throw new failureModule.Failure(409, `${id} 已经作出了选择`);
  }
  if (chosen !== undefined && (kind !== 'decided' || !options?.some((option) => option.id === chosen))) {
    return invalid(`${id} 的已选项不存在或节点尚未定`);
  }
  if (decidedBy !== undefined && decidedBy !== 'user' && decidedBy !== 'central') {
    return invalid(`${id} 的 decidedBy 要是 user 或 central`);
  }
  if (kind === 'decided') {
    //M 新决定由中控发布时默认记作中控定，导入有出处的决定可给出原作者与时间。
    decidedBy = before?.decidedBy ?? decidedBy ?? 'central';
    decidedAt = before?.decidedAt ?? decidedAt;
    if (decidedAt === undefined && before?.kind !== 'decided' && raw['createdAt'] === undefined) {
      decidedAt = now;
    }
  }

  return {
    id, kind, title, summary, parent, status, options, chosen, detailPath, sources, links, main, needs,
    createdAt: before?.createdAt ?? createdAt, decidedAt, decidedBy,
    acknowledgedAt: before?.acknowledgedAt, note: before?.note, notes: before?.notes,
  } satisfies types.DecisionNode;
}

/** 校验批量应用后的树、主线与跨枝依赖。 */
function checkGraph(nodes: Map<string, types.DecisionNode>): void {
  if (nodes.size === 0) return;

  const roots = [...nodes.values()].filter((node) => node.parent === null);
  const root = roots[0];

  //G 放射布局从唯一的中心目标展开。
  if (roots.length !== 1 || root?.kind !== 'goal') return invalid('决策图需要一个中心目标');

  const mainParents = new Set<string>();
  for (const node of nodes.values()) {
    //G 每个节点都应沿 parent 回到中心，否则父节点缺失或构成循环。
    let next = node.parent;
    const visited = new Set([node.id]);
    while (next !== null) {
      const parent = nodes.get(next);
      if (parent === undefined || visited.has(next)) return invalid(`${node.id} 的父节点缺失或成环`);

      visited.add(next);
      next = parent.parent;
    }

    //G 主线从中心向外单独延伸，不能从中间跳过节点或再分成两支。
    if (node.main === true && node.parent !== null) {
      const parent = nodes.get(node.parent)!;
      if ((parent.id !== root.id && parent.main !== true) || mainParents.has(parent.id)) {
        return invalid(`${node.id} 的主线需要从中心连续延伸`);
      }
      mainParents.add(parent.id);
    }

    for (const need of node.needs ?? []) {
      //G 虚线也必须连接到有效的另一个节点。
      if (need === node.id || !nodes.has(need)) return invalid(`${node.id} 的依赖 ${need} 无效`);
    }
  }
}

/** 回信要写入的准确节点及可选用户留言。 */
export interface ReplyTarget {
  /** 节点号。 */
  node: string;
  /** 用户留言号；回复选择时省略。 */
  note?: string;
}

/** 单个运行时目录对应一张图。写入同步完成，选择和提交之间不会被另一请求抢占。 */
export class Store {
  private readonly current: string;
  private readonly history: string;
  private saved: SavedGraph = { revision: 0, nodes: [] };
  private changes: types.DecisionChange[] = [];
  private historyNeedsBreak = false;

  /**
   * 从运行时目录恢复图和历史。
   * @param dir data/decision-map 目录。
   * 副作用：补上上一次快照已提交的历史记录。
   */
  constructor(dir: string) {
    this.current = path.join(dir, 'graph.json');
    this.history = path.join(dir, 'history.jsonl');
    if (fs.existsSync(this.current)) {
      const encoded = fs.readFileSync(this.current, 'utf8');
      this.saved = JSON.parse(encoded) as SavedGraph;
      for (const node of this.saved.nodes) {
        //M 旧版只有网页点选会写 decidedAt，据此恢复旧快照的决定来源。
        if (node.decidedBy === undefined && node.chosen !== undefined && node.decidedAt !== undefined) {
          node.decidedBy = 'user';
        }
      }
    }
    if (fs.existsSync(this.history)) {
      const encoded = fs.readFileSync(this.history, 'utf8');
      this.historyNeedsBreak = encoded !== '' && !encoded.endsWith('\n');
      const rows = encoded.split('\n');
      for (const row of rows) {
        if (row.trim() === '') continue;

        //M 正常逐行恢复历史。进程中断留下的末行由快照的 head 补齐。
        try {
          const change = JSON.parse(row) as types.DecisionChange;
          this.changes.push(change);
        } catch {
          continue;
        }
      }
    }
    //M 恢复快照后补上中断时来不及追加的最后一条。
    this.recoverHistory();
  }

  /** 读图时只给网页公开节点和版本。 */
  getGraph(): types.DecisionGraph {
    return { revision: this.saved.revision, nodes: this.saved.nodes };
  }

  /** 从给定序号之后轮询改动，包含可靠的用户选择。 */
  getChanges(since: number) {
    const changes = this.changes.filter((record) => record.seq > since);
    const head = this.saved.head;
    if (head !== undefined && head.seq > since && changes.at(-1)?.seq !== head.seq) {
      //M 已提交快照但尚未追加的决定仍可立即轮询。
      changes.push(head);
    }
    return { last: this.saved.revision, changes };
  }

  /** 校验整批节点，成功后一次提交。 */
  put(raw: unknown): types.DecisionGraph {
    //G 只对具体的节点变更提交版本。
    if (!Array.isArray(raw) || raw.length === 0) return invalid('nodes 要是非空列表');

    const nodes = new Map(this.saved.nodes.map((node) => [node.id, node]));
    const ids = new Set<string>();
    const now = Date.now();
    for (const entry of raw) {
      //G 单批只有一个同名条目，防止修改顺序造成歧义。
      const input = readObject(entry);
      const id = readText(input['id'], 'id');
      if (ids.has(id)) return invalid(`这批节点的 ${id} 重复`);

      //M 先在草稿里合并节点，失败时不改变当前图。
      const before = nodes.get(id);
      const node = readNode(id, input, before, now);
      ids.add(id);
      nodes.set(id, node);
    }

    //M 合并后再检查关系，允许同一批里先加子节点后加父节点。
    checkGraph(nodes);
    const change = { action: 'put', actor: 'central', nodes: [...ids] } as const;
    this.commit([...nodes.values()], change);
    return this.getGraph();
  }

  /** 校验选项并定稿。同一选择重试时返回原节点。 */
  choose(id: string, chosen: string) {
    //G 选择只能指向节点实际提供的选项。
    const node = this.getNode(id);
    const option = node.options?.find((item) => item.id === chosen);
    if (option === undefined) return invalid(`节点 ${id} 没有选项 ${chosen}`);
    if (node.chosen === chosen && node.decidedBy === 'user') return { node, option, changed: false };
    if (node.kind !== 'pending' || node.status !== 'open') {
      //G 第一个选择保存后，后到的不同选项不能覆盖它。
      throw new failureModule.Failure(409, `节点 ${id} 已定或不可选`);
    }

    const decidedAt = Date.now();
    const decided = { ...node, kind: 'decided', status: 'decided', chosen, decidedAt, decidedBy: 'user' } as const;
    const change = { action: 'choose', actor: 'user', nodes: [id], option: chosen, title: node.title } as const;

    //M 先把选择落盘，再由路由通知中控。
    this.replace(decided, change);
    return { node: decided, option, changed: true };
  }

  /** 标记中控已经收到用户选择。 */
  ack(id: string, note?: string): types.DecisionNode {
    //G 中控只能确认已经选定的节点。
    const node = this.getNode(id);
    if (node.chosen === undefined) throw new failureModule.Failure(409, `节点 ${id} 还没有选择`);
    if (node.acknowledgedAt !== undefined && (note === undefined || note === node.note)) return node;

    const acknowledgedAt = node.acknowledgedAt ?? Date.now();
    const updated = { ...node, acknowledgedAt, note };
    const change = { action: 'ack', actor: 'central', nodes: [id], note } as const;

    //M 只补确认记录，用户选择保留原样。
    this.replace(updated, change);
    return updated;
  }

  /**
   * 记下用户在节点上写的一句话，不改节点状态。
   * @param id 节点号，入口已校验为非空文本。
   * @param text 用户写的话，入口已校验非空和长度。
   * @param option 同时选的选项号，入口已先用 choose 落盘。
   * @returns 更新后的节点和新留言。
   * 副作用：快照和历史各记一条 note。
   */
  addNote(id: string, text: string, option?: string) {
    //M 留言号按节点内条数递增，relay 用它区分同一节点的多条收件。
    const node = this.getNode(id);
    const notes = node.notes ?? [];
    const count = notes.length + 1;
    const noteId = `n${String(count)}`;
    const at = Date.now();
    const note: types.DecisionNote = { id: noteId, author: 'user', at, text, option };

    //M 只追加留言，待定节点照旧待定，等中控处理。
    const updated = { ...node, notes: [...notes, note] };
    const change = { action: 'note', actor: 'user', nodes: [id], noteId, title: node.title, option } as const;
    this.replace(updated, change);
    return { node: updated, note };
  }

  /** 新收件带原始节点和留言号，重启时也能处理旧格式的待送回信。 */
  replyFromRelay(key: string, text: string, relayReplyId: number, target?: ReplyTarget): void {
    if (target !== undefined) {
      //M 新收件无需拆字符串，节点号可以包含井号。
      this.reply(target.node, target.note, text, relayReplyId);
      return;
    }

    //M 旧收件的键是完整节点号，或在末尾附加 #留言号。
    const isNode = this.saved.nodes.some((node) => node.id === key);
    const separator = key.lastIndexOf('#');
    if (isNode || separator < 0) {
      this.reply(key, undefined, text, relayReplyId);
      return;
    }

    const nodeId = key.slice(0, separator);
    const noteId = key.slice(separator + 1);
    //M 交给同一个入口核对节点和用户留言，并以回信号去重。
    this.reply(nodeId, noteId, text, relayReplyId);
  }

  /**
   * 记下中控对节点或某条用户留言的回话。
   * @param id 节点号。
   * @param replyTo 要回的用户留言号，回复节点选择时省略。
   * @param text 中控的回话。
   * @param relayReplyId relay 持久回信号，直达回话省略。
   * @returns 更新后的节点和中控这条留言。
   * 副作用：被回的留言补上 repliedAt，快照和历史各记一条 reply。
   */
  reply(id: string, replyTo: string | undefined, text: string, relayReplyId?: number) {
    //G 带留言号的回话只能指向这个节点上用户写过的那条。
    const node = this.getNode(id);
    const notes = node.notes ?? [];
    const target = notes.find((item) => item.id === replyTo && item.author === 'user');
    if (replyTo !== undefined && target === undefined) {
      throw new failureModule.Failure(404, `节点 ${id} 没有用户留言 ${replyTo}`);
    }

    //G 已写图但 relay 还没标已送时，仅补齐历史并确认，避免重复追加。
    if (relayReplyId !== undefined) {
      const existing = notes.find((note) => note.relayReplyId === relayReplyId);
      if (existing !== undefined) {
        this.recoverHistory();
        return { node, note: existing };
      }
    }

    //M 回话也排进同一列表，网页按时间一起列出。
    const count = notes.length + 1;
    const noteId = `n${String(count)}`;
    const at = Date.now();
    const answer: types.DecisionNote = { id: noteId, author: 'central', at, text, replyTo };
    if (relayReplyId !== undefined) answer.relayReplyId = relayReplyId;
    const marked = notes.map((item) => {
      if (item.id !== replyTo) return item;

      return { ...item, repliedAt: item.repliedAt ?? at };
    });

    //M 回话落盘后由路由归档对应的 relay 收件。
    const updated = { ...node, notes: [...marked, answer] };
    const relatedNote = replyTo ?? noteId;
    const change = { action: 'reply', actor: 'central', nodes: [id], noteId: relatedNote } as const;
    this.replace(updated, change);
    return { node: updated, note: answer };
  }

  /** 按完整编号读单个节点，找不到给 404。 */
  private getNode(id: string): types.DecisionNode {
    //G 只按完整编号操作，未知节点直接报 404。
    const node = this.saved.nodes.find((item) => item.id === id);
    if (node === undefined) throw new failureModule.Failure(404, `找不到节点 ${id}`);

    return node;
  }

  /** 用更新后的节点替换原记录，顺序照旧。 */
  private replace(node: types.DecisionNode, change: Omit<types.DecisionChange, 'seq' | 'at'>): void {
    const nodes = this.saved.nodes.map((item) => {
      if (item.id === node.id) return node;

      return item;
    });

    //M 只有完整图通过持久化后才更新已发布的版本。
    this.commit(nodes, change);
  }

  /** 原子更新快照后追加历史。 */
  private commit(nodes: types.DecisionNode[], change: Omit<types.DecisionChange, 'seq' | 'at'>): void {
    //M 上次快照里的历史必须先记上，才可以提交新的版本。
    this.recoverHistory();
    const revision = this.saved.revision + 1;
    const head = { ...change, seq: revision, at: Date.now() };
    const saved = { revision, nodes, head };
    const text = JSON.stringify(saved, null, 2);

    //M 快照同目录改名是提交点，历史可随后根据 head 补记。
    filesModule.writeTextAtomic(this.current, text);
    this.saved = saved;
    this.recoverHistory();
  }

  /** 只追加尚未写入的最新记录，重启也可沿同一序号去重。 */
  private recoverHistory(): void {
    const head = this.saved.head;
    if (head === undefined || this.changes.at(-1)?.seq === head.seq) return;

    //M 如果进程中断留了半行，追加换行后再补记，保留原历史。
    const encoded = JSON.stringify(head);
    let line = `${encoded}\n`;
    if (this.historyNeedsBreak) line = `\n${line}`;
    try {
      fs.appendFileSync(this.history, line, 'utf8');
    } catch (error) {
      this.historyNeedsBreak = true;
      throw error;
    }
    this.historyNeedsBreak = false;

    //M 文件确认写入后，轮询直接使用同一条内存记录。
    this.changes.push(head);
  }
}
