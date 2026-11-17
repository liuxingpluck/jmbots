/**
 * 插件预览页和 flow 插件说话（同源相对地址）。令牌用 web/src/Token.ts。
 */
import { TOKEN, withToken } from '../Token.ts';


export type NodeState = 'ok' | 'failed' | 'waiting' | 'idle';

export interface GraphNode {
  id: string;
  kind: 'cli' | 'skeleton' | 'plugin';
  category: string;
  summary: string;
  state: NodeState;
  error: string;
  missing: string[];
  configured: boolean;
  /** 要用的服务（挂载结果）。 */
  inject: string[];
  /** 这次运行发过的事件。 */
  emits: string[];
  /** Cordis 上登记着的监听。 */
  listens: string[];
  http: string;
  /** 挂上时多出的服务（boot-trail 记的）。 */
  provides: string[];
  /** 挂上时多登记的工具（boot-trail 记的）。 */
  tools: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'inject' | 'listen';
  label: string;
}

export interface FlowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  problems: string[];
  /** 话里带它的消息才拍运行时快照（flow 配置 snapshot_keyword）；旧后端没有。 */
  snapshotKeyword?: string;
  /** 源码根目录（flow 配置 workspace，或往上找到的），「在 VS Code 里打开」拼路径用；找不到是空串。 */
  workspace?: string;
}


/** GET 一个接口，出错抛接口给的 error。 */
export async function get<T>(path: string): Promise<T> {
  const response = await fetch(withToken(path, TOKEN));
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body;
}


/** 一条请求轨迹里一步的一行（不含对话内容）。 */
export interface TrailRow {
  t: number;
  gap: number;
  kind: string;
  name: string;
  text: string;
  listeners: string[];
  site: string;
  facts: Record<string, string | number | boolean>;
  error: boolean;
}

/** 轨迹的一步：连着落在同一个插件上的几行。 */
export interface TrailStep {
  no: number;
  node: string;
  title: string;
  t: number;
  ms: number;
  error: boolean;
  notified: string[];
  rows: TrailRow[];
  /** 这一步的函数注释（只有启动轨迹有，boot-trail 从源码取）。 */
  docs?: CodeDoc[];
}

/** 一段函数注释，取自代码自己的 JSDoc。 */
export interface CodeDoc {
  name: string;
  /** 文件:行号。 */
  site: string;
  /** 重要的展开显示，不重要的只显示 summary 第一行。 */
  important: boolean;
  /** 空串是取到了；不然是原因：缺注释、读不到源码、找不到这段代码。 */
  missing: string;
  /** 函数原型，一行；文件开头的注释是空串。 */
  signature: string;
  summary: string;
  params: { name: string; text: string }[];
  returns: string;
  throws: string;
  effects: string;
}

/** 一个函数的完整源码（GET /api/flow/source，boot-trail/Source.ts 的 FunctionSource）。 */
export interface FunctionSource {
  /** 相对代码目录的文件。 */
  file: string;
  /** 起止行号，源文件里的真实行号（从 1 起，含 end）。 */
  start: number;
  end: number;
  /** 没找到函数结尾、只给了前 80 行时是 true。 */
  cut: boolean;
  /** start 到 end 那几行原文。 */
  lines: string[];
  /** 里面调到的、找得到定义的函数：名字和“文件:行号”。 */
  calls: { name: string; site: string }[];
  /** 这个函数的名字；这一行不在函数里是空串。 */
  name: string;
  /** 谁调它：每处调用的“文件:行号”、那一行代码、调用处上方的 //M 注释（没有是空串）。 */
  callers: { site: string; code: string; why: string }[];
}

export interface Trail {
  message: number;
  session: string | null;
  bot: string;
  channel: string;
  /** 用户那句话；启动是空串。 */
  preview?: string;
  at: number;
  ms: number;
  state: string;
  error: boolean;
  steps: TrailStep[];
  /** 关键变量的英文键 → 中文解释，整条轨迹共用（JsonBlock 在那行后面灰字显示）。 */
  notes?: Record<string, string>;
}

/** 最近请求列表的一项。 */
export interface RequestItem {
  message: number;
  bot: string;
  channel: string;
  at: number;
  ms: number;
  state: string;
  error: boolean;
  steps: number;
  nodes: string[];
  /** 用户那句话。 */
  preview?: string;
}


/** POST 一个接口，出错抛接口给的 error。 */
export async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(withToken(path, TOKEN), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? String(response.status));
  return result;
}


/** 一次模型调用的用量（usage 插件的一行）。 */
export interface DetailUsage {
  at: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  ms: number;
  ok: boolean;
  error?: string;
}

/** 一条跟踪行（journal 记的，变量全量原样）。 */
export interface DetailLine {
  at: number;
  kind: string;
  name: string;
  mode: string;
  listeners: string[];
  text: string;
  site: string;
  vars: Record<string, unknown>;
  sessionId: string | null;
  messageId: number | null;
  bot: string | null;
}

/** GET /api/flow/detail：一条请求的「变量 / 详情」。 */
export interface FlowDetail {
  message: number;
  /** 这条请求挑出的跟踪行。 */
  lines: DetailLine[];
  /** 这场会话的对话.md（files-mirror 写的）；没有是空串。 */
  conversation: string;
  usage: DetailUsage[];
}

/** GET /api/flow/state 的一组运行时变量（全量原样，调试用不打码）。 */
export interface StateGroup {
  /** 组名：main、服务名（resources、tools、sessions……），或插件用 ctx.flow.state 登记的名字。 */
  name: string;
  /** 一句人话。 */
  note: string;
  /** 这一刻的值。 */
  value: unknown;
  /** 手写的键的中文解释（main 组、插件登记的）。 */
  notes?: Record<string, string>;
}

/** GET /api/flow/snapshot：点中轨迹一步时那一刻的运行时变量。 */
export interface Snapshot {
  /** 拍的时刻，毫秒时间戳。 */
  at: number;
  /** 第几步。 */
  no: number;
  /** 这一步在图上的点。 */
  node: string;
  groups: StateGroup[];
  /** 和上一步比变了的地方，每处一串键名（第一个是组名）；第一步没得比是 null。 */
  changed: string[][] | null;
}
