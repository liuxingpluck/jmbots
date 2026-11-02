/**
 * “事件”页面取数据的入口：请求 jmbots 后端（src/channels/Http.ts），和知识库的假数据 Api.ts 分开。
 * 页面由 jmbots 服务自己托管，所以都是同源请求，不用 token。
 */


/** 会话（数据库 jmbot_sessions 的一行）。 */
export interface Session {
  /** 会话 ID：17 位时间加 3 位随机数。 */
  id: string;
  /** 标题：分派时 AI 起的，或第一条输入的开头；分派对话以“分派_”开头。 */
  title: string;
  /** task 执行对话，route 分派对话。 */
  kind: 'task' | 'route';
  /** 交给的机器人。 */
  bot: string | null;
  /** 交给的智能体。 */
  agent: string | null;
  /** 只用模型时的模型 ID。 */
  model: string | null;
  /** 工作区名字。 */
  workspace: string;
  /** 来源，如“命令行”“HTTP”“飞书私聊 oc_xxx”。 */
  source: string;
  /** 空闲、执行中、等待确认、出错。 */
  status: string;
  /** 最后一次回复。 */
  lastReply: string | null;
  /** 创建时间（毫秒）。 */
  createdAt: number;
  /** 最近活动时间（毫秒）。 */
  updatedAt: number;
}


/** 事件（jmbot_events 的一行）：execution 执行、dispatch 分派、judge 判断、exec_review 命令审核。 */
export interface EventRow {
  /** 事件 ID。 */
  id: number;
  /** 所属会话。 */
  sessionId: string;
  /** 挂在哪个 execution 下面；execution 自己是 null。 */
  parentId: number | null;
  /** 类型。 */
  type: string;
  /** 内容，各类型不一样，原样显示。 */
  payload: unknown;
  /** pending、running、paused、completed、failed。 */
  status: string;
  /** 出错信息。 */
  error: string | null;
  /** 创建时间。 */
  createdAt: number;
  /** 更新时间。 */
  updatedAt: number;
}


/** 一步的模型调用（jmbot_model_requests 的一行）。 */
export interface StepRow {
  /** 记录 ID。 */
  id: number;
  /** 第几步。 */
  step: number;
  /** 执行者，如 bot:周小灵。 */
  actor: string;
  /** 发给模型的请求：模型、思考强度、系统提示词、工具、上下文消息。 */
  request: Record<string, unknown>;
  /** 模型的回复：文字、思考、工具调用、用时；调用还没回来时是 null。 */
  response: Record<string, unknown> | null;
  /** in_progress、completed、failed。 */
  status: string;
  /** 出错信息。 */
  error: string | null;
  /** 开始时间。 */
  createdAt: number;
  /** 结束时间。 */
  updatedAt: number;
}


/** 一次工具调用（jmbot_tool_results 的一行）。 */
export interface ToolRow {
  /** 记录 ID。 */
  id: number;
  /** 第几步调的。 */
  step: number;
  /** 工具名。 */
  toolName: string;
  /** 参数。 */
  input: unknown;
  /** in_progress（执行中、等确认或结果未知）、completed、failed。 */
  status: string;
  /** 结果。 */
  output: unknown;
  /** 出错信息。 */
  error: string | null;
  /** 开始时间。 */
  createdAt: number;
  /** 结束时间。 */
  updatedAt: number;
}


/** 待确认的命令（jmbot_exec_approvals 的一行）。 */
export interface ApprovalRow {
  /** 待确认 ID。 */
  id: number;
  /** 命令。 */
  command: string;
  /** 在哪个目录执行。 */
  workDir: string;
  /** pending、approved、rejected。 */
  status: string;
  /** 用户附的话。 */
  note: string | null;
  /** 创建时间。 */
  createdAt: number;
}


/** 一个会话的全部原始记录（GET /api/sessions/:id/full）。 */
export interface SessionFull {
  /** 会话。 */
  session: Session;
  /** 全部事件。 */
  events: EventRow[];
  /** 每次执行的模型调用和工具调用。 */
  executions: { eventId: number; steps: StepRow[]; tools: ToolRow[] }[];
  /** 全部待确认命令。 */
  approvals: ApprovalRow[];
  /** 日志文件所在的会话目录。 */
  sessionDir: string;
}


/** 机器人或智能体的简介（GET /api/bots、/api/agents）。 */
export interface RoleSummary {
  /** 名字。 */
  name: string;
  /** 一句话说明。 */
  description: string;
}


/**
 * 发请求并读 JSON；状态码不是 2xx 时抛出后端给的中文错误。
 * @param url 地址。
 * @param init 请求设置。
 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  /** 响应。 */
  const response = await fetch(url, init);
  /** 响应体。 */
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `请求失败：HTTP ${response.status}`);
  }
  return body as T;
}


/** 列最近的会话（最多 100 个）。 */
export function listSessions(): Promise<Session[]> {
  return requestJson<Session[]>('/api/sessions?limit=100');
}


/**
 * 取一个会话的全部原始记录。
 * @param sessionId 会话 ID。
 */
export function getSessionFull(sessionId: string): Promise<SessionFull> {
  return requestJson<SessionFull>(`/api/sessions/${encodeURIComponent(sessionId)}/full`);
}


/** 列机器人和智能体（提交任务时选执行者）。 */
export async function listRoles(): Promise<{ bots: RoleSummary[]; agents: RoleSummary[] }> {
  /** 两个列表一起取。 */
  const [bots, agents] = await Promise.all([requestJson<RoleSummary[]>('/api/bots'), requestJson<RoleSummary[]>('/api/agents')]);
  return { bots, agents };
}


/** 提交任务的参数。 */
export interface RunInput {
  /** 要做的事。 */
  text: string;
  /** 接着哪个会话；不写就新开。 */
  sessionId?: string;
  /** 交给哪个机器人。 */
  bot?: string;
  /** 交给哪个智能体。 */
  agent?: string;
}


/**
 * 提交任务（不等做完）。
 * @param input 任务。
 * @returns 会话 ID 和事件 ID。
 */
export function run(input: RunInput): Promise<{ sessionId: string; eventId: number }> {
  return requestJson('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}


/**
 * 确认或拒绝一条待确认的命令。
 * @param approvalId 待确认 ID。
 * @param decision 同意或拒绝。
 */
export function decide(approvalId: number, decision: 'approved' | 'rejected'): Promise<unknown> {
  return requestJson(`/api/approvals/${approvalId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
}
