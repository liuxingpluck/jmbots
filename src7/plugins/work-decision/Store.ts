/** 校验工作决策树及节点变更，通过 SQLite 将节点、留言和流水一并保存。 */
import * as crypto from 'node:crypto';
import type { Database } from 'bun:sqlite';
import * as failureModule from '../../utils/Failure.ts';
import * as sql from './Sqlite.ts';
import * as types from './Types.ts';

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

/** 校验入口传来的任务状态。 */
export function readStatus(value: unknown): types.DecisionStatus {
  const status = value as types.DecisionStatus;
  //G 状态必须在画布支持的取值内，后续的任务推进才能使用。
  if (!types.STATUSES.includes(status)) return invalid('status 不合法');

  return status;
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

/** 只接受已约定的两类收件人。 */
function readAsker(value: unknown): types.DecisionAsker | undefined {
  if (value === undefined) return;

  //G 新节点的收件人按种类校验来源标识。
  const item = readObject(value);
  if (item['kind'] === 'session') {
    const sessionId = readText(item['sessionId'], 'asker.sessionId');
    return { kind: 'session', sessionId };
  }
  if (item['kind'] === 'helper') {
    const name = readText(item['name'], 'asker.name');
    return { kind: 'helper', name };
  }
  //G 未知提问方不进入持久队列。
  return invalid('asker.kind 要是 session 或 helper');
}

/** 批量写入中的一项，继承已有节点未指定的字段。 */
function readNode(id: string, raw: Record<string, unknown>, before: types.DecisionNode | undefined, now: number) {
  const item = { ...before, ...raw };
  const kind = item['kind'] as types.DecisionKind;
  //G 合并后的状态也要符合画布支持的取值。
  const status = readStatus(item['status']);

  //G 只有约定的节点类型和状态能进入画布。
  if (!types.KINDS.includes(kind)) return invalid(`${id} 的 kind 不合法`);

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
  const body = item['body'];
  //G 正文保留原样，Markdown 的缩进和换行有含义。
  if (body !== undefined && typeof body !== 'string') return invalid('body 要是文本');

  //M 核对详情引用、依赖、决定选项和时间，供画布显示。
  const sources = readList(item['sources'], 'sources');
  const links = readList(item['links'], 'links');
  const needs = readList(item['needs'], 'needs');
  const chosen = readOptional(item['chosen'], 'chosen');
  const createdAt = readTime(item['createdAt'], 'createdAt') ?? now;
  let decidedAt = readTime(item['decidedAt'], 'decidedAt');
  let decidedBy = item['decidedBy'];

  //G 已做的选择不会被中控的过期快照覆盖。
  const reopens = status === 'open' && before?.status !== 'open';
  if (before?.chosen !== undefined && (chosen !== before.chosen || kind !== 'decided' || reopens)) {
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

  //M 已登记的收件人不会被节点补丁改写，避免点选重试发给另一方。
  const asker = before?.asker ?? readAsker(item['asker']);
  const bot = readOptional(item['bot'], 'bot');
  const workspaceId = readOptional(item['workspaceId'], 'workspaceId');
  return {
    id, kind, title, summary, parent, status, options, chosen, detailPath, body, sources, links, main, needs,
    bot, workspaceId, asker,
    createdAt: before?.createdAt ?? createdAt, decidedAt, decidedBy,
    acknowledgedAt: before?.acknowledgedAt, note: before?.note, notes: before?.notes,
  } satisfies types.DecisionNode;
}

/** 工作区是项目标识，缺少工作区的决策按机器人分别归类。 */
export function getProjectKey(node: Pick<types.DecisionNode, 'bot' | 'workspaceId'>): string {
  return JSON.stringify([node.bot ?? null, node.workspaceId ?? null]);
}

/** 校验父链、主线和跨枝依赖，并把子节点归入项目。 */
function checkGraph(nodes: Map<string, types.DecisionNode>, changed: Set<string>): void {
  if (nodes.size === 0) return;

  //G 每个项目需要一个唯一的中心目标，四种画法复用同一棵树。
  const roots = new Set<string>();
  const checked = new Map<string, types.DecisionNode>();
  for (const node of nodes.values()) {
    if (node.parent !== null) continue;

    //M 用同一组机器人和工作区找唯一根节点。
    const key = getProjectKey(node);
    //G 每个项目只允许一个目标根。
    if (node.kind !== 'goal' || roots.has(key)) return invalid('每个工作决策项目需要一个中心目标');
    roots.add(key);
    checked.set(node.id, node);
  }
  const mainParents = new Set<string>();
  for (const node of nodes.values()) {
    //M 沿父链找到项目根，记住已核对的路径，避免为同一棵子树反复遍历。
    let current = node;
    const visited = new Map<string, types.DecisionNode>();
    while (!checked.has(current.id)) {
      const parent = nodes.get(current.parent ?? '');
      if (parent === undefined || visited.has(current.id)) return invalid(`${node.id} 的父节点缺失或成环`);

      visited.set(current.id, current);
      current = parent;
    }
    const root = checked.get(current.id)!;
    for (const member of visited.values()) {
      //G 项目由根确定，补丁不能把一个子项归到与父项不同的项目。
      if (member.bot !== undefined && member.bot !== root.bot) return invalid(`${member.id} 的机器人应与项目一致`);
      if (member.workspaceId !== undefined && member.workspaceId !== root.workspaceId) {
        return invalid(`${member.id} 的工作区应与项目一致`);
      }
      checked.set(member.id, root);
      if (member.bot === root.bot && member.workspaceId === root.workspaceId) continue;

      const updated = { ...member, bot: root.bot, workspaceId: root.workspaceId };
      nodes.set(member.id, updated);
      //M 派生归属有变化时随批次入库。
      changed.add(member.id);
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
  private readonly storage: sql.Sqlite;
  private saved: types.DecisionGraph;

  /**
   * 打开工作决策表，并从旧目录恢复尚未入库的节点和历史。
   * @param db resources 打开的应用数据库。
   * @param legacyDir 旧应用的 data/decision-map 目录。
   * @param legacyWorkspaceId 导入旧图时使用的已有工作区，可省略。
   * 副作用：首次创建表并导入已有数据。
   */
  constructor(db: Database, legacyDir: string, legacyWorkspaceId?: string) {
    //M 已导入的库直接读三张表，旧文件保留。
    this.storage = new sql.Sqlite(db);
    //退场：所有运行时的旧 data/decision-map/graph.json 都导入 SQLite 以后
    let project: sql.WorkspaceProject | undefined;
    if (legacyWorkspaceId !== undefined) {
      project = this.storage.getWorkspace(legacyWorkspaceId);
      if (project === undefined) throw new Error('legacy_workspace_id 没有指向已登记的本人工作区');
    }
    //M 恢复旧快照、历史和留言，导入标记保证只处理一次。
    this.storage.importLegacy(legacyDir, project);
    //M 从库中取出最新工单树作为读图快照。
    this.saved = this.storage.getGraph();
  }

  /** 按已绑定 ID 找到工作区项目。 */
  getWorkspace(id: string): sql.WorkspaceProject | undefined {
    //M 复用工作区的标识和最新名称。
    return this.storage.getWorkspace(id);
  }

  /** 读取当前工作决策数据序号，不构造节点列表。 */
  getRevision(): number {
    //M 直接取库里的最新变化序号，供 30 秒轻量版本探针使用。
    return this.storage.getRevision();
  }

  /** 检查库版本，复用尚未变化的快照。 */
  getGraph(): types.DecisionGraph {
    //M 另一个连接提交了变化时重新读库。
    const revision = this.storage.getRevision();
    if (revision !== this.saved.revision) this.saved = this.storage.getGraph();
    return this.saved;
  }

  /** 显示时从工作区取当前名字，工作区改名不改变决策版本。 */
  getPublicGraph(): types.DecisionGraph {
    //M 公开快照继续用现有版本和节点。
    const graph = this.getGraph();
    //M 每个项目的目标根用于网页切换。
    const roots = graph.nodes.filter((node) => node.parent === null);
    const projects = roots.map((root) => {
      let name = root.title;
      if (root.workspaceId !== undefined) {
        //M 工作区名称直接取当前登记值。
        name = this.getWorkspace(root.workspaceId)?.name ?? name;
      }
      return { root: root.id, name };
    });
    return { ...graph, projects };
  }

  /** 从给定序号之后轮询改动，包含可靠的用户选择。 */
  getChanges(since: number) {
    //M 让 SQL 按序号过滤新增历史。
    return this.storage.getChanges(since);
  }

  /** 创建待定事项，返回节点和写入结果。相同的提问编号重试不创建第二件。 */
  ask(input: types.DecisionAsk) {
    //M 使用最新版本找同一编号已经登记的事项。
    const graph = this.getGraph();
    //M 工具调用和外部助手补交时可复用原节点。
    const before = graph.nodes.find((node) => node.id === input.id);
    if (before !== undefined) {
      //G 重试允许当前提问方取回原节点，别的请求不能抢用这个编号。
      const requestedBy = JSON.stringify(input.asker);
      const openedBy = JSON.stringify(before.asker);
      if (before.bot !== input.bot || before.workspaceId !== input.workspaceId || requestedBy !== openedBy) {
        throw new failureModule.Failure(409, '已有另一件工作决策使用这个编号');
      }
      return { node: before, graph, tasks: [] };
    }

    //M 由已绑定的归属查对应项目。
    const key = getProjectKey(input);
    //M 已建项目沿用现有根节点。
    const root = graph.nodes.find((node) => node.parent === null && getProjectKey(node) === key);
    const parent = root?.id ?? crypto.randomUUID();
    const node = { ...input, parent, kind: 'pending', status: 'open' } as const;
    const batch: unknown[] = [node];
    if (root === undefined) {
      //M 新项目第一次提问时建一个根，继续沿用现有任务树和布局。
      let title = `${input.bot} · 未归类`;
      if (input.workspaceId !== undefined) {
        const workspace = this.getWorkspace(input.workspaceId);
        title = workspace?.name ?? title;
      }
      batch.unshift({
        id: parent, kind: 'goal', status: 'working', title, bot: input.bot, workspaceId: input.workspaceId,
      });
    }

    //M 项目根和待定事项同批保存，结果使用实际写入的节点。
    const saved = this.put(batch, 'plugin');
    const inserted = saved.graph.nodes.find((entry) => entry.id === input.id)!;
    return { ...saved, node: inserted };
  }

  /** 校验整批节点，成功后一次提交。 */
  put(raw: unknown, actor: types.DecisionChange['actor']) {
    //G 只对具体的节点变更提交版本。
    if (!Array.isArray(raw) || raw.length === 0) return invalid('nodes 要是非空列表');

    //M 批量打补丁前取最新快照。
    const current = this.getGraph();
    const nodes = new Map(current.nodes.map((node) => [node.id, node]));
    const ids = new Set<string>();
    const tasks: types.DecisionTaskChange[] = [];
    const now = Date.now();
    for (const entry of raw) {
      //G 单批只有一个同名条目，防止修改顺序造成歧义。
      const input = readObject(entry);
      const id = readText(input['id'], 'id');
      if (ids.has(id)) return invalid(`这批节点的 ${id} 重复`);

      //M 先在草稿里合并节点，失败时不改变当前图。
      const before = nodes.get(id);
      let node = readNode(id, input, before, now);
      if (node.parent === null && node.workspaceId !== undefined) {
        //G 根的项目从已登记工作区取归属，拒绝指向外部工作区。
        const project = this.getWorkspace(node.workspaceId);
        if (project === undefined || (node.bot !== undefined && project.bot !== node.bot)) {
          return invalid(`${id} 的工作区不属于这个机器人`);
        }
        node = { ...node, bot: project.bot };
      }
      if (before?.status !== node.status) {
        //M 新增或变更状态才能触发任务变化通知。
        tasks.push({ node: id, title: node.title, status: node.status, previousStatus: before?.status });
      }
      ids.add(id);
      nodes.set(id, node);
    }

    //M 合并后再检查关系，允许同一批里先加子节点后加父节点。
    checkGraph(nodes, ids);
    const change = { action: 'put', actor, nodes: [...ids], tasks } as const;
    const changed = change.nodes.map((id) => nodes.get(id)!);
    this.commit([...nodes.values()], changed, change);
    return { graph: this.getGraph(), tasks };
  }

  /** 只推进任务状态，保留决定、作者与对话。重复设置同一状态照旧。 */
  setStatus(id: string, status: types.DecisionStatus, actor: types.DecisionChange['actor']) {
    //M 找到现有任务，保留原节点内容，只改状态。
    const node = this.getNode(id);
    if (node.status === status) return { node, tasks: [] };

    if (node.kind === 'pending' && status === 'open' && !node.options?.length) {
      //G 待定节点重新打开后必须有选项可供用户选择。
      return invalid(`${id} 待定时至少要有一个选项`);
    }

    const updated = { ...node, status };
    const tasks = [{ node: id, title: node.title, status, previousStatus: node.status }];
    const change = { action: 'status', actor, nodes: [id], tasks } as const;
    //M 状态和可补查的通知内容一起提交。
    this.replace(updated, change);
    return { node: updated, tasks };
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
   * 副作用：留言和变化在同一事务中写入数据库。
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

  /**
   * 记下中控对节点或某条用户留言的回话。
   * @param id 节点号。
   * @param replyTo 要回的用户留言号，回复节点选择时省略。
   * @param text 中控的回话。
   * @param relayReplyId relay 持久回信号，直达回话省略。
   * @returns 更新后的节点和中控这条留言。
   * 副作用：被回的留言补上 repliedAt，回话和变化一并写入数据库。
   */
  reply(id: string, replyTo: string | undefined, text: string, relayReplyId?: number) {
    //G 带留言号的回话只能指向这个节点上用户写过的那条。
    const node = this.getNode(id);
    const notes = node.notes ?? [];
    const target = notes.find((item) => item.id === replyTo && item.author === 'user');
    if (replyTo !== undefined && target === undefined) {
      throw new failureModule.Failure(404, `节点 ${id} 没有用户留言 ${replyTo}`);
    }

    //G 已写图但 relay 还没标已送时只确认已有记录，避免重复追加。
    if (relayReplyId !== undefined) {
      const existing = notes.find((note) => note.relayReplyId === relayReplyId);
      if (existing !== undefined) return { node, note: existing };
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
    const graph = this.getGraph();
    const node = graph.nodes.find((item) => item.id === id);
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
    this.commit(nodes, [node], change);
  }

  /** 节点、关联留言和流水同一次提交，成功后更新读图快照。 */
  private commit(
    nodes: types.DecisionNode[],
    changed: types.DecisionNode[],
    change: Omit<types.DecisionChange, 'seq' | 'at'>,
  ): void {
    const revision = this.saved.revision + 1;
    const row = { ...change, seq: revision, at: Date.now() };

    //G 事务里比对版本，避免旧草稿覆盖其他连接刚提交的新决定。
    const saved = this.storage.save(changed, row);
    if (!saved) throw new failureModule.Failure(409, '工作决策已更新，请刷新后重试');
    this.saved = { revision, nodes };
  }
}
