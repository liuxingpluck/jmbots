/** 决策图的后端、网页和跟踪记录共用的数据结构。 */

export const KINDS = ['goal', 'fork', 'feature', 'pending', 'decided', 'work'] as const;
export const STATUSES = ['open', 'decided', 'working', 'done', 'dropped'] as const;
export const QUADRANTS = ['q1', 'q2', 'q3', 'q4'] as const;

export type DecisionKind = typeof KINDS[number];
export type DecisionStatus = typeof STATUSES[number];
export type DecisionQuadrant = typeof QUADRANTS[number];
export type Quadrant = typeof QUADRANTS[number];

/** 用户可以选择的一项。 */
export interface DecisionOption {
  /** 同一节点内唯一的选项号。 */
  id: string;
  /** 一句话说明选择。 */
  text: string;
  /** 是否为推荐选项。 */
  recommended?: boolean;
  /** 一句话说明选择的代价。 */
  cost?: string;
}

/** 用户或中控在节点上写的一句话。 */
export interface DecisionNote {
  /** 节点内递增的留言号，如 n1。 */
  id: string;
  /** 谁写的。 */
  author: 'user' | 'central';
  /** 写下的毫秒时间戳。 */
  at: number;
  /** 写的内容。 */
  text: string;
  /** 用户写话时一并选的选项号。 */
  option?: string;
  /** 中控这句回的是哪条留言。 */
  replyTo?: string;
  /** 中控回过这条用户留言的毫秒时间戳。 */
  repliedAt?: number;
  /** 来自 relay 的持久回信号，重试时用它对账。 */
  relayReplyId?: number;
}

/** 主人定完以后接收结果的一方。 */
export type DecisionAsker = {
  /** 把结果送回提问的会话。 */
  kind: 'session';
  /** 提问时正在运行的持久会话号。 */
  sessionId: string;
} | {
  /** 把结果送到外部助手的 relay 收件。 */
  kind: 'helper';
  /** relay 配置中的助手名。 */
  name: string;
};

/** 当前图中的一个节点。 */
export interface DecisionNode {
  /** 图中唯一的节点号。 */
  id: string;
  /** 决策节点的类别。 */
  kind: DecisionKind;
  /** 画布上显示的简短标题。 */
  title: string;
  /** 一段可选的结论或背景。 */
  summary: string;
  /** 上一级节点号，中心目标是 null。 */
  parent: string | null;
  /** 归属的机器人；旧决策尚无归属时省略。 */
  bot?: string;
  /** 归属的工作区；缺省时列在该机器人名下的未归类决策。 */
  workspaceId?: string;
  /** 用户定完以后该把结果送给谁。 */
  asker?: DecisionAsker;
  /** 节点当前状态。 */
  status: DecisionStatus;
  /** 节点首次写入的毫秒时间戳。 */
  createdAt: number;
  /** 决定作出的毫秒时间戳，历史未记录时省略。 */
  decidedAt?: number;
  /** 作出决定的人。 */
  decidedBy?: 'user' | 'central';
  /** 决策提供的选项。 */
  options?: DecisionOption[];
  /** 已选的选项号。 */
  chosen?: string;
  /** 中控确认收到的毫秒时间戳。 */
  acknowledgedAt?: number;
  /** 中控确认时附的说明。 */
  note?: string;
  /** 详细说明在仓库中的位置。 */
  detailPath?: string;
  /** 侧栏展示的 Markdown 正文。 */
  body?: string;
  /** 记录决定来历的文档路径。 */
  sources?: string[];
  /** 可打开的证据链接。 */
  links?: string[];
  /** 节点是否在主线上。 */
  main?: boolean;
  /** 四象限手动归类：q1 重要且紧急、q2 重要不紧急、q3 紧急不重要、q4 不紧急不重要。 */
  quadrant?: DecisionQuadrant;
  /** 跨枝依赖的节点号。 */
  needs?: string[];
  /** 用户和中控在这个节点上写的话，按时间先后。 */
  notes?: DecisionNote[];
}

/** 整张图的公开快照。 */
export interface DecisionGraph {
  /** 最后一次改动的序号。 */
  revision: number;
  /** 供前端布局的节点。 */
  nodes: DecisionNode[];
  /** 公开接口附上各项目的根节点和显示名。 */
  projects?: DecisionProject[];
}

/** 工作决策页面可选择的一组节点。 */
export interface DecisionProject {
  /** 这一组节点的任务树根节点号。 */
  root: string;
  /** 工作区当前名称或未归类的显示名称。 */
  name: string;
}

/** 待主人定的事项，调用方附上提问方和项目归属。 */
export interface DecisionAsk {
  /** 调用方提供的去重键或节点编号。 */
  id: string;
  /** 简短标题。 */
  title: string;
  /** 一句话交代决策背景。 */
  summary: string;
  /** 可直接点选的项目。 */
  options: DecisionOption[];
  /** 可选 Markdown 正文。 */
  body?: string;
  /** 提问所在的机器人。 */
  bot: string;
  /** 提问所在的工作区，没有绑定时归到该机器人名下。 */
  workspaceId?: string;
  /** 决定送回的会话或外部助手。 */
  asker: DecisionAsker;
}

/** 一项值得通知中控的任务变化。 */
export interface DecisionTaskChange {
  /** 实际节点号，回信仍写进该节点。 */
  node: string;
  /** 变化时的标题。 */
  title: string;
  /** 新状态。 */
  status: DecisionStatus;
  /** 原状态，创建节点时省略。 */
  previousStatus?: DecisionStatus;
}

/** 每次改动追加到历史的一条。 */
export interface DecisionChange {
  /** 可用于增量查询的递增序号。 */
  seq: number;
  /** 改动时间戳。 */
  at: number;
  /** 改动发起者。 */
  actor: 'central' | 'user' | 'plugin';
  /** 操作名称。 */
  action: 'put' | 'status' | 'quadrant' | 'choose' | 'ack' | 'note' | 'reply';
  /** 受影响的节点号。 */
  nodes: readonly string[];
  /** 新建及状态变化详情，relay 不可用时可按变更接口读取。 */
  tasks?: readonly DecisionTaskChange[];
  /** 手动调整后的象限键值；清除手动归类恢复自动时为 null。 */
  quadrant?: DecisionQuadrant | null;
  /** 用户选择时的选项号。 */
  option?: string;
  /** 用户选择时的节点标题。 */
  title?: string;
  /** 确认附言。 */
  note?: string;
  /** 写话或回话时的留言号。 */
  noteId?: string;
}


//==========================================================
// 多 AI 协同控制面任务面板（Control Plane Task Board）
//==========================================================

/** 控制面任务状态：待拍板 / 可直接干 / 执行中 / 阻塞 / 已验收 / 已取消。 */
export const CONTROL_TASK_STATUSES = [
  'pending_decision',
  'ready',
  'running',
  'blocked',
  'done',
  'cancelled',
] as const;

export type ControlTaskStatus = (typeof CONTROL_TASK_STATUSES)[number];

/** 控制面任务优先级。 */
export const CONTROL_TASK_PRIORITIES = ['P0', 'P1', 'P2'] as const;

export type ControlTaskPriority = (typeof CONTROL_TASK_PRIORITIES)[number];

/** 变更时间线事件类别。 */
export const CONTROL_TASK_EVENT_KINDS = [
  'created',
  'principle_update',
  'scope_change',
  'status',
  'heartbeat',
  'note',
  'cancelled',
] as const;

export type ControlTaskEventKind = (typeof CONTROL_TASK_EVENT_KINDS)[number];

/** 任务卡变更时间线中的单条记录。 */
export interface ControlTaskEvent {
  /** 事件发生的毫秒时间戳。 */
  at: number;
  /** 发起人或 AI 节点标识（如 boss、central、coder-opus）。 */
  by: string;
  /** 事件种类。 */
  kind: ControlTaskEventKind;
  /** 变更或心跳说明文本。 */
  text: string;
}

/** 任务种类：普通任务 / 倒数纪念日 / 习惯打卡。 */
export const TASK_KINDS = ['task', 'countdown', 'habit'] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** 倒数纪念日模式：down 倒数还有 N 天 / up 正数已经 N 天。 */
export const COUNTDOWN_MODES = ['down', 'up'] as const;

export type CountdownMode = (typeof COUNTDOWN_MODES)[number];

/** 滴答清单视图的自定义清单定义。 */
export interface TaskListDef {
  /** 清单唯一标识（如 inbox、work）。 */
  id: string;
  /** 清单显示名称（如 收集箱、工作任务）。 */
  name: string;
  /** 可选 emoji 图标。 */
  icon?: string;
  /** 可选主题色。 */
  color?: string;
  /** 可选排序权重（越小越靠前）。 */
  sortOrder?: number;
}

/** 单张多 AI 协同控制面任务卡。 */
export interface ControlTask {
  /** 唯一任务 ID。 */
  id: string;
  /** 任务简短标题。 */
  title: string;
  /** 背景或需求摘要。 */
  summary: string;
  /** 当前状态。 */
  status: ControlTaskStatus;
  /** 优先级（P0 / P1 / P2）。 */
  priority: ControlTaskPriority;
  /** 占坑/资源互斥锁标签（如 ['repo:jmbots', 'host:132']）。 */
  lockTags: string[];
  /** 当前认领执行的 AI 或节点名；未认领为空字符串。 */
  owner: string;
  /** 可机器验证的验收标准（如 bun test 0 fail & curl 200）。 */
  doneCriteria: string;
  /** 认领 AI 最近一次心跳或事件上报毫秒时间戳；未上报为 null。 */
  lastHeartbeatAt: number | null;
  /** 完整变更与心跳时间线（按时间先后追加）。 */
  events: ControlTaskEvent[];
  /** 创建毫秒时间戳。 */
  createdAt: number;
  /** 最近修改毫秒时间戳。 */
  updatedAt: number;
  /** 任务种类（task 普通任务 / countdown 倒数纪念日 / habit 习惯打卡）；缺省视为 task。 */
  kind?: TaskKind;
  /** 所属清单名称（如 收集箱、工作任务）；老任务缺省视为 工作任务。 */
  list?: string;
  /** 父任务 ID（用于父子任务树）；显式清空时为 null。 */
  parentId?: string | null;
  /** 四象限手动归类（q1~q4 或 null）。 */
  quadrant?: Quadrant | null;
  /** 到期日或纪念日日期（YYYY-MM-DD）；显式清空时为 null。 */
  dueDate?: string | null;
  /** 倒数纪念日模式（down 倒数还有 N 天 / up 正数已经 N 天）。 */
  countdownMode?: CountdownMode;
  /** 可选 emoji 图标。 */
  icon?: string;
  /** 标签字符串数组。 */
  tags?: string[];
  /** 习惯打卡日期数组（YYYY-MM-DD）。 */
  checkIns?: string[];
  /** 软删除毫秒时间戳；未入垃圾桶或还原后为 null / 省略。 */
  trashedAt?: number | null;
  /** 排序权重（数值越小越靠前）。 */
  sortOrder?: number;
}

/** 创建控制面任务卡（POST /api/work-decision/tasks）的请求输入。 */
export interface ControlTaskCreateInput {
  /** 可选自定义任务 ID；缺省由服务端生成。 */
  id?: string;
  /** 任务简短标题（必填）。 */
  title: string;
  /** 背景或需求摘要。 */
  summary?: string;
  /** 初始任务状态；缺省为 ready。 */
  status?: ControlTaskStatus;
  /** 优先级（P0 / P1 / P2）；缺省为 P1。 */
  priority?: ControlTaskPriority;
  /** 占坑/资源互斥锁标签数组。 */
  lockTags?: string[];
  /** 当前认领执行的 AI 或节点名。 */
  owner?: string;
  /** 可机器验证的验收标准。 */
  doneCriteria?: string;
  /** 发起人或 AI 节点标识。 */
  by?: string;
  /** 创建时的初始时间线备注。 */
  initialNote?: string;
  /** 任务种类（task 普通任务 / countdown 倒数纪念日 / habit 习惯打卡）；缺省视为 task。 */
  kind?: TaskKind;
  /** 所属清单名称（如 收集箱、工作任务）；缺省视为 工作任务。 */
  list?: string;
  /** 父任务 ID（不能等于自身 id）；传 null 可清空。 */
  parentId?: string | null;
  /** 四象限手动归类（q1~q4 或 null）。 */
  quadrant?: Quadrant | null;
  /** 到期日或纪念日日期（YYYY-MM-DD 或 null）。 */
  dueDate?: string | null;
  /** 倒数纪念日模式（down 倒数 / up 正数）。 */
  countdownMode?: CountdownMode;
  /** 可选 emoji 图标。 */
  icon?: string;
  /** 标签字符串数组。 */
  tags?: string[];
  /** 习惯打卡日期数组（YYYY-MM-DD）。 */
  checkIns?: string[];
  /** 软删除毫秒时间戳或 null。 */
  trashedAt?: number | null;
  /** 排序权重。 */
  sortOrder?: number;
}

/** 局部更新控制面任务卡（PATCH / PUT /api/work-decision/tasks/:id）的请求输入。 */
export interface ControlTaskPatchInput {
  /** 任务简短标题。 */
  title?: string;
  /** 背景或需求摘要。 */
  summary?: string;
  /** 目标任务状态。 */
  status?: ControlTaskStatus;
  /** 优先级（P0 / P1 / P2）。 */
  priority?: ControlTaskPriority;
  /** 占坑/资源互斥锁标签数组。 */
  lockTags?: string[];
  /** 当前认领执行的 AI 或节点名。 */
  owner?: string;
  /** 可机器验证的验收标准。 */
  doneCriteria?: string;
  /** 发起人或 AI 节点标识。 */
  by?: string;
  /** 本次更新的原因备注。 */
  reason?: string;
  /** 显式指定写入时间线的事件类型。 */
  eventKind?: ControlTaskEventKind;
  /** 是否强制刷新一次心跳。 */
  heartbeat?: boolean;
  /** 任务种类（task 普通任务 / countdown 倒数纪念日 / habit 习惯打卡）。 */
  kind?: TaskKind;
  /** 所属清单名称。 */
  list?: string;
  /** 父任务 ID（不能等于自身 id）；传 null 清空。 */
  parentId?: string | null;
  /** 四象限手动归类（q1~q4）；传 null 清空。 */
  quadrant?: Quadrant | null;
  /** 到期日或纪念日日期（YYYY-MM-DD）；传 null 清空。 */
  dueDate?: string | null;
  /** 倒数纪念日模式（down / up）。 */
  countdownMode?: CountdownMode;
  /** 可选 emoji 图标。 */
  icon?: string;
  /** 标签字符串数组。 */
  tags?: string[];
  /** 习惯打卡日期数组（YYYY-MM-DD）。 */
  checkIns?: string[];
  /** 软删除毫秒时间戳；传 null 从垃圾桶还原。 */
  trashedAt?: number | null;
  /** 排序权重。 */
  sortOrder?: number;
}

/** control-plane-tasks.json 磁盘持久化结构。 */
export interface ControlPlaneFile {
  /** 文件结构版本号（当前为 1）。 */
  version: 1;
  /** 控制面任务账本递增修订号。 */
  revision: number;
  /** 控制面与个人任务列表。 */
  tasks: ControlTask[];
  /** 任务清单列表；老文件缺省时由服务端按默认清单兜底。 */
  lists?: TaskListDef[];
}

/** 当前正被 running 任务占用的资源坑位信息。 */
export interface ActiveLockHolder {
  /** 占用该锁的任务 ID。 */
  taskId: string;
  /** 占用该锁的任务标题。 */
  title: string;
  /** 当前执行负责人。 */
  owner: string;
}

/** 409 占坑冲突明细项。 */
export interface ControlTaskLockConflict extends ActiveLockHolder {
  /** 冲突的占坑标签名。 */
  lockTag: string;
}

/** GET /api/work-decision/tasks 响应契约。 */
export interface ControlPlaneSnapshot {
  /** 请求成功。 */
  ok: true;
  /** 控制面任务账本递增修订号。 */
  revision: number;
  /** 满足筛选条件的任务列表。 */
  tasks: ControlTask[];
  /** 当前可用任务清单列表（按 sortOrder 升序）。 */
  lists: TaskListDef[];
  /** 全量各状态任务计数（不受筛选参数影响，供顶栏仪表带直接展示）。 */
  counts: Record<ControlTaskStatus, number>;
  /** 当前全局正在被 running 任务占用的坑位映射（lockTag -> 持有者）。 */
  activeLocks: Record<string, ActiveLockHolder>;
  /** 当前处于 ready 状态且不与任何 running 任务撞坑、巡检环可立即派发的任务 ID 列表。 */
  dispatchableIds: string[];
}

/** GET /api/work-decision/tasks 响应契约的兼容别名。 */
export type ControlTaskListResponse = ControlPlaneSnapshot;
