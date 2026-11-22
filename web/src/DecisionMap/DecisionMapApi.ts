/** 读取签入的图和提交用户选择，沿用 jmbots 的页面令牌。 */
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as token from '../Token.ts';

const BASE = '/api/work-decision';

export type ControlTask = types.ControlTask;
export type ControlTaskStatus = types.ControlTaskStatus;
export type ControlTaskPriority = types.ControlTaskPriority;
export type ControlTaskEventKind = types.ControlTaskEventKind;
export type ControlTaskEvent = types.ControlTaskEvent;
export type ActiveLockHolder = types.ActiveLockHolder;
export type ControlTaskListResponse = types.ControlTaskListResponse;

/** 轻量版本探针响应，仅包含进程启动时刻和数据修订号。 */
export interface DecisionVersion {
  /** 当前后端路由挂载时刻（毫秒时间戳），换版重启后改变。 */
  appStartedAt: number;
  /** 当前工作决策数据修订号，节点、选择、留言或回复变化后递增。 */
  dataRev: number;
  /** 多 AI 控制面任务面板修订号，任务或事件变化后递增。 */
  tasksRev?: number;
}

/** 请求并读取决策图接口的 JSON 返回。 */
async function request<T>(route: string, options?: RequestInit): Promise<T> {
  const endpoint = `${BASE}${route}`;

  //M 非本机打开页面时使用 jmbots 已保存的访问令牌。
  const address = token.withToken(endpoint, token.TOKEN);
  const response = await fetch(address, options);
  if (!response.ok) {
    //G 外网或手机首次无令牌访问回 401 时广播事件，页面弹出令牌输入条。
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('jmbots:unauthorized'));
    }
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

/** 读取轻量版本探针（约 50B），供每 30 秒无感检查使用。 */
export function getVersion(signal?: AbortSignal): Promise<DecisionVersion> {
  //M 只取启动时刻和数据序号，未变化时不拉完整节点图。
  return request('/version', { signal });
}

/** 获取当前快照，含中控最近确认的状态。 */
export function getGraph(signal?: AbortSignal): Promise<types.DecisionGraph> {
  const options = { signal };

  //M 画布轮询当前快照，用版本号跳过未变的布置。
  return request('/graph', options);
}

/** 提交单个选项，服务器校验并记录后返回。 */
export function choose(node: string, option: string): Promise<{ node: types.DecisionNode }> {
  const body = JSON.stringify({ node, option });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

  //M 用户点击后只提交一次，收到结果再刷新画布。
  return request('/choose', options);
}

/** 写话的回执：更新后的节点和刚记下的那条。 */
interface NoteReply {
  /** 更新后的节点，含全部留言。 */
  node: types.DecisionNode;
  /** 刚记下的留言。 */
  note: types.DecisionNote;
}

/**
 * 把用户在节点上写的话发给中控，可一并带上选项。
 * @param node 节点号。
 * @param text 用户写的话。
 * @param option 同时选的选项号，只写话时省略。
 * @returns 服务端记下后的节点和留言。
 */
export function addNote(node: string, text: string, option?: string): Promise<NoteReply> {
  const body = JSON.stringify({ node, text, option });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

  //M 服务端校验并落盘后才返回，页面用回执刷新面板。
  return request('/note', options);
}

/** 从网页新建一个子任务，服务端负责生成稳定节点号。 */
export function addChild(parent: string, title: string): Promise<{ id: string; graph: types.DecisionGraph }> {
  const body = JSON.stringify({ parent, title });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

  //M 网页入口会把新任务通知中控。
  return request('/child', options);
}

/** 只保存任务状态，节点上的已有决定与留言继续保留。 */
export function setStatus(id: string, status: types.DecisionStatus): Promise<{ node: types.DecisionNode }> {
  const body = JSON.stringify({ id, status });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

  //M 网页入口会把状态变化通知中控。
  return request('/status', options);
}

/** 手动调整节点的四象限归类，传 null 清除手动覆盖恢复自动规则。 */
export function setQuadrant(
  id: string,
  quadrant: types.DecisionQuadrant | null,
): Promise<{ node: types.DecisionNode }> {
  const body = JSON.stringify({ id, quadrant });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

  //M 点击象限胶囊后即时入库，返回更新后的节点。
  return request('/quadrant', options);
}


//==========================================================
// 多 AI 协同控制面任务面板 API（/api/work-decision/tasks*）
//==========================================================

/** 读取控制面任务列表、状态计数、活跃占坑锁与可立即派发队列。 */
export function getControlTasks(
  filter?: { status?: string; lockTag?: string; owner?: string },
  signal?: AbortSignal,
): Promise<types.ControlTaskListResponse> {
  const qs = new URLSearchParams();
  if (filter?.status !== undefined && filter.status !== '') {
    qs.set('status', filter.status);
  }
  if (filter?.lockTag !== undefined && filter.lockTag !== '') {
    qs.set('lockTag', filter.lockTag);
  }
  if (filter?.owner !== undefined && filter.owner !== '') {
    qs.set('owner', filter.owner);
  }
  const suffix = qs.toString();
  const route = suffix !== '' ? `/tasks?${suffix}` : '/tasks';
  return request(route, { signal });
}

/** 创建控制面任务卡。 */
export function createControlTask(input: {
  id?: string;
  title: string;
  summary?: string;
  status?: types.ControlTaskStatus;
  priority?: types.ControlTaskPriority;
  lockTags?: string[];
  owner?: string;
  doneCriteria?: string;
  by?: string;
  initialNote?: string;
}): Promise<{ ok: true; task: types.ControlTask }> {
  return request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 局部更新控制面任务卡（状态/优先级/负责人/验收标准/占坑锁，撞锁抛错含 409 详情）。 */
export function patchControlTask(
  id: string,
  patch: {
    title?: string;
    summary?: string;
    status?: types.ControlTaskStatus;
    priority?: types.ControlTaskPriority;
    lockTags?: string[];
    owner?: string;
    doneCriteria?: string;
    by?: string;
    reason?: string;
    eventKind?: types.ControlTaskEventKind;
    heartbeat?: boolean;
  },
): Promise<{ ok: true; task: types.ControlTask }> {
  return request(`/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** 追加一条原则更新 / 范围变更 / 心跳事件并自动刷新 lastHeartbeatAt。 */
export function appendControlTaskEvent(
  id: string,
  input: {
    kind?: types.ControlTaskEventKind;
    by?: string;
    text: string;
    status?: types.ControlTaskStatus;
  },
): Promise<{ ok: true; task: types.ControlTask; event: types.ControlTaskEvent }> {
  return request(`/tasks/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 删除控制面任务卡。 */
export function deleteControlTask(id: string): Promise<{ ok: true; deleted: string }> {
  return request(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
