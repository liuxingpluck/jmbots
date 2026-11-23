/** 读取签入的图和提交用户选择，沿用 jmbots 的页面令牌。 */
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as token from '../Token.ts';

const BASE = '/api/work-decision';

export type ControlTaskStatus = types.ControlTaskStatus;
export type ControlTaskPriority = types.ControlTaskPriority;
export type ControlTaskEventKind = types.ControlTaskEventKind;
export type ControlTaskEvent = types.ControlTaskEvent;
export type ControlTaskNotifications = types.ControlTaskNotifications;
export type ActiveLockHolder = types.ActiveLockHolder;
export type TaskFilterRule = types.TaskFilterRule;
export type TaskFilterViewDef = types.TaskFilterViewDef;
export type TaskTagMode = types.TaskTagMode;
export type TaskDueScope = types.TaskDueScope;
export type TaskSourceRef = types.TaskSourceRef;
export type PersonaSummary = types.PersonaSummary;
export type PersonaReviewInput = types.PersonaReviewInput;

/** 滴答风格任务实体类别：普通任务 / 倒数纪念日 / 习惯。 */
export type TickTaskKind = 'task' | 'countdown' | 'habit';

/** 滴答风格四象限编码。 */
export type TickQuadrant = 'q1' | 'q2' | 'q3' | 'q4';

/** 倒数纪念日计数方向：down 倒数，up 正数已过天数。 */
export type TickCountdownMode = 'down' | 'up';

/** 滴答风格自定义清单定义。 */
export interface TaskListDef {
  /** 清单唯一标识。 */
  id: string;
  /** 清单名称。 */
  name: string;
  /** 清单图标（Emoji）。 */
  icon?: string;
  /** 清单强调色。 */
  color?: string;
  /** 排序权重。 */
  sortOrder?: number;
}

/** 融合控制面与滴答工作台字段的原子任务结构。 */
export type ControlTask = types.ControlTask & {
  /** 实体类别，缺省视为普通任务 task。 */
  kind?: TickTaskKind;
  /** 所属清单名称，缺省为「工作任务」。 */
  list?: string;
  /** 父任务 ID，顶层为 null 或缺省。 */
  parentId?: string | null;
  /** 四象限归类，未设时按优先级映射。 */
  quadrant?: TickQuadrant | null;
  /** 截止日期或纪念日目标日期（YYYY-MM-DD）。 */
  dueDate?: string | null;
  /** 倒数日计算方向（down 倒数 / up 已过）。 */
  countdownMode?: TickCountdownMode;
  /** 任务、纪念日或习惯的图标。 */
  icon?: string;
  /** 任务标签数组。 */
  tags?: string[];
  /** 习惯打卡日期列表（YYYY-MM-DD[]）。 */
  checkIns?: string[];
  /** 移入垃圾桶时间戳，正常任务为 null 或缺省。 */
  trashedAt?: number | null;
  /** 列表内排序权重。 */
  sortOrder?: number;
};

/** GET /api/work-decision/tasks 响应结构（含分组清单与自定义动态筛选视图定义）。 */
export type ControlTaskListResponse = Omit<types.ControlTaskListResponse, 'tasks'> & {
  /** 全量任务数组。 */
  tasks: ControlTask[];
  /** 自定义清单列表，旧版后端未返回时前端兜底。 */
  lists?: TaskListDef[];
  /** 自定义动态筛选视图列表，旧版后端未返回时前端按空数组兜底。 */
  views?: TaskFilterViewDef[];
};

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
): Promise<ControlTaskListResponse> {
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
  let route = '/tasks';
  if (suffix !== '') {
    route = `/tasks?${suffix}`;
  }
  return request(route, { signal });
}

/** 创建任务/纪念日/习惯的入参。 */
export interface CreateControlTaskInput {
  /** 可选自定义 ID。 */
  id?: string;
  /** 标题。 */
  title: string;
  /** 详细备注或摘要。 */
  summary?: string;
  /** 初始控制面状态。 */
  status?: types.ControlTaskStatus;
  /** 优先级。 */
  priority?: types.ControlTaskPriority;
  /** 占坑锁标签。 */
  lockTags?: string[];
  /** 认领人。 */
  owner?: string;
  /** 验收标准。 */
  doneCriteria?: string;
  /** 创建者标识。 */
  by?: string;
  /** 初始备注事件。 */
  initialNote?: string;
  /** 实体类型：task / countdown / habit。 */
  kind?: TickTaskKind;
  /** 所属清单名称。 */
  list?: string;
  /** 父任务 ID。 */
  parentId?: string | null;
  /** 四象限编码。 */
  quadrant?: TickQuadrant | null;
  /** 截止或目标日期（YYYY-MM-DD）。 */
  dueDate?: string | null;
  /** 倒数日模式。 */
  countdownMode?: TickCountdownMode;
  /** 图标。 */
  icon?: string;
  /** 标签数组。 */
  tags?: string[];
  /** 打卡日期列表。 */
  checkIns?: string[];
  /** 移入垃圾桶时间戳。 */
  trashedAt?: number | null;
  /** 排序权重。 */
  sortOrder?: number;
}

/** 局部更新任务/纪念日/习惯的入参（传 null 可清空可选字段）。 */
export interface PatchControlTaskInput {
  /** 标题。 */
  title?: string;
  /** 备注或摘要。 */
  summary?: string;
  /** 状态。 */
  status?: types.ControlTaskStatus;
  /** 优先级。 */
  priority?: types.ControlTaskPriority;
  /** 占坑锁标签。 */
  lockTags?: string[];
  /** 认领人。 */
  owner?: string;
  /** 验收标准。 */
  doneCriteria?: string;
  /** 操作者。 */
  by?: string;
  /** 变更原因。 */
  reason?: string;
  /** 追加的事件类型。 */
  eventKind?: types.ControlTaskEventKind;
  /** 是否同时上报心跳。 */
  heartbeat?: boolean;
  /** 实体类型。 */
  kind?: TickTaskKind;
  /** 所属清单名称。 */
  list?: string;
  /** 父任务 ID（null 清空）。 */
  parentId?: string | null;
  /** 四象限编码（null 清空）。 */
  quadrant?: TickQuadrant | null;
  /** 截止或目标日期（null 清空）。 */
  dueDate?: string | null;
  /** 倒数日模式。 */
  countdownMode?: TickCountdownMode;
  /** 图标。 */
  icon?: string;
  /** 标签列表。 */
  tags?: string[];
  /** 习惯打卡日期列表。 */
  checkIns?: string[];
  /** 垃圾桶时间戳（null 还原）。 */
  trashedAt?: number | null;
  /** 排序权重。 */
  sortOrder?: number;
}

/** 创建控制面或滴答任务卡。 */
export function createControlTask(
  input: CreateControlTaskInput,
): Promise<{ ok: true; task: ControlTask }> {
  return request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 局部更新控制面或滴答任务卡（撞锁抛错含 409 详情）。 */
export function patchControlTask(
  id: string,
  patch: PatchControlTaskInput,
): Promise<{ ok: true; task: ControlTask }> {
  return request(`/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** 追加一条原则更新 / 范围变更 / 心跳事件并自动刷新 lastHeartbeatAt（支持可选唤醒与播报）。 */
export function appendControlTaskEvent(
  id: string,
  input: {
    kind?: types.ControlTaskEventKind;
    by?: string;
    text: string;
    status?: types.ControlTaskStatus;
    notifyHelper?: string;
    notifyBot?: string;
    broadcast?: boolean;
  },
): Promise<{
  ok: true;
  task: ControlTask;
  event: types.ControlTaskEvent;
  notifications?: types.ControlTaskNotifications;
}> {
  return request(`/tasks/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 彻底删除任务卡。 */
export function deleteControlTask(id: string): Promise<{ ok: true; deleted: string }> {
  return request(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 切换习惯某天打卡状态，缺省 date 为今天。 */
export function toggleHabitCheckIn(
  id: string,
  date?: string,
): Promise<{ ok: true; task: ControlTask }> {
  const payload: { date?: string } = {};
  if (date !== undefined) {
    payload.date = date;
  }
  return request(`/tasks/${encodeURIComponent(id)}/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 新建滴答自定义清单。 */
export function createTaskList(input: {
  name: string;
  icon?: string;
  color?: string;
}): Promise<{ ok: true; list: TaskListDef }> {
  return request('/lists', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 修改分组清单名称、图标、主题色或排序权重（重名回 409，改名原子级联更新任务与视图）。 */
export function patchTaskList(
  id: string,
  patch: {
    name?: string;
    icon?: string | null;
    color?: string | null;
    sortOrder?: number;
  },
): Promise<{
  ok: true;
  revision: number;
  list: TaskListDef;
  lists: TaskListDef[];
  views?: TaskFilterViewDef[];
}> {
  return request(`/lists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** patchTaskList 的标准简短别名。 */
export const patchList = patchTaskList;

/** 删除自定义分组清单。 */
export function deleteTaskList(id: string): Promise<{ ok: true; deleted: string }> {
  return request(`/lists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 新建可持久化的自定义动态筛选视图。 */
export function createFilterView(input: {
  id?: string;
  name: string;
  icon?: string;
  color?: string;
  rule: TaskFilterRule;
  sortOrder?: number;
}): Promise<{ ok: true; revision: number; view: TaskFilterViewDef; views: TaskFilterViewDef[] }> {
  return request('/views', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 更新自定义动态筛选视图的名称、图标、主题色或筛选规则。 */
export function patchFilterView(
  id: string,
  patch: {
    name?: string;
    icon?: string | null;
    color?: string | null;
    rule?: TaskFilterRule;
    sortOrder?: number;
  },
): Promise<{ ok: true; revision: number; view: TaskFilterViewDef; views: TaskFilterViewDef[] }> {
  return request(`/views/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** 删除自定义动态筛选视图。 */
export function deleteFilterView(
  id: string,
): Promise<{ ok: true; revision: number; deleted: string; views: TaskFilterViewDef[] }> {
  return request(`/views/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /api/work-decision/tasks/:id/persona-review 前端响应结构。 */
export type PersonaReviewResult = Omit<types.PersonaReviewResult, 'task'> & {
  /** 落盘后的最新任务卡完整副本。 */
  task: ControlTask;
};

/** 读取已启用的无状态反方红军角色列表。 */
export function getPersonas(
  signal?: AbortSignal,
): Promise<{ ok: true; personas: PersonaSummary[] }> {
  return request('/personas', { signal });
}

/** 请求指定红军角色对任务卡执行一次无状态拍砖并原位写入时间线。 */
export function requestPersonaReview(
  id: string,
  input: PersonaReviewInput,
): Promise<PersonaReviewResult> {
  return request(`/tasks/${encodeURIComponent(id)}/persona-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
