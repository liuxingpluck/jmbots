/**
 * 多 AI 协同控制面任务与滴答视图原子存储与 HTTP 路由实现。
 * 数据独立持久化在 `<runtime>/control-plane-tasks.json`（走防杀毒容错原子写入），
 * 提供控制面任务与滴答视图共用 REST 接口：
 * - GET    /api/work-decision/tasks             列出任务、清单、各状态计数、活跃占坑锁与可派发队列（可按来源 6 维筛）
 * - POST   /api/work-decision/tasks             创建任务卡（未传 status 默认 ready，running 检查撞锁，来源重复回 409）
 * - POST   /api/work-decision/tasks/upsert      按 sourceRef 幂等入池：没有就建，有就补来源、追加事件
 * - PATCH  /api/work-decision/tasks/:id         局部更新任务卡（支持 PUT，撞锁回 409）
 * - POST   /api/work-decision/tasks/:id/events  追加原则更新/需求变更/心跳事件并刷新 lastHeartbeatAt
 * - DELETE /api/work-decision/tasks/:id         硬删除任务卡
 * - POST   /api/work-decision/tasks/:id/checkin 切换习惯打卡日期并返回最新任务
 * - POST   /api/work-decision/lists             新建自定义清单（同名幂等返回）
 * - PATCH  /api/work-decision/lists/:id         更新清单并同步改名后任务的 list 字段
 * - DELETE /api/work-decision/lists/:id         删除清单并将旗下任务归回收集箱（inbox 不可删）
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import * as notificationsModule from './Notify.ts';
import * as sourceRefModule from './SourceRef.ts';
import * as types from './Types.ts';


/** 占坑互斥锁冲突错误（HTTP 409，附带结构化冲突列表）。 */
export class LockConflictFailure extends failureModule.Failure {
  /**
   * @param message 给调用方看的占坑冲突说明。
   * @param conflicts 逐个冲突标签的持有者明细。
   */
  constructor(
    message: string,
    readonly conflicts: types.ControlTaskLockConflict[],
  ) {
    super(409, message);
  }
}

/** 来源重复错误（HTTP 409）：同一来源已经有一张没进垃圾桶的任务，附带它的任务 ID。 */
export class DuplicateSourceFailure extends failureModule.Failure {
  /**
   * @param message 给调用方看的说明。
   * @param taskId 已有任务的 ID。
   */
  constructor(
    message: string,
    readonly taskId: string,
  ) {
    super(409, message);
  }
}

/** 来源引用的校验、去重键与筛选（无状态，全文件共用一个）。 */
const SOURCE_REFS = new sourceRefModule.SourceRefHelper();

/** 内置默认清单列表（旧文件缺失 lists 时兜底返回，首次写盘一并保存）。 */
export const DEFAULT_TASK_LISTS: readonly types.TaskListDef[] = [
  { id: 'inbox', name: '收集箱', icon: '📥', sortOrder: 0 },
  { id: 'work', name: '工作任务', icon: '💼', sortOrder: 1 },
  { id: 'memo', name: '个人备忘', icon: '🏡', sortOrder: 2 },
  { id: 'wish', name: '心愿清单', icon: '🦄', sortOrder: 3 },
  { id: 'shopping', name: '购物清单', icon: '📦', sortOrder: 4 },
  { id: 'study', name: '学习安排', icon: '📖', sortOrder: 5 },
  { id: 'fitness', name: '锻炼计划', icon: '🏃', sortOrder: 6 },
];

/** 状态展示排序权重（执行中与待拍板优先置顶）。 */
const STATUS_ORDER: Record<types.ControlTaskStatus, number> = {
  running: 0,
  pending_decision: 1,
  ready: 2,
  blocked: 3,
  done: 4,
  cancelled: 5,
};

/** 优先级排序权重。 */
const PRIORITY_ORDER: Record<types.ControlTaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

/** 各状态对应的中文展示名。 */
const STATUS_LABELS: Record<types.ControlTaskStatus, string> = {
  pending_decision: '待拍板',
  ready: '可直接干',
  running: '执行中',
  blocked: '阻塞',
  done: '已验收',
  cancelled: '已取消',
};

/** 单个任务最多保留事件条数上限（防极端高频心跳无限膨胀）。 */
const MAX_EVENTS_PER_TASK = 500;
/** 单文本最大长度。 */
const MAX_TEXT_CHARS = 4000;
/** 占坑标签最大个数。 */
const MAX_LOCK_TAGS = 24;
/** 滴答标签最大个数。 */
const MAX_TAGS = 50;
/** 习惯打卡日期记录最大个数。 */
const MAX_CHECKINS = 5000;
/** YYYY-MM-DD 日期格式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
/** 自定义任务或清单 ID 格式。 */
const ID_PATTERN = /^[\w.:-]+$/u;
/** JS Date 可安全表示的最大毫秒时间戳。 */
const MAX_TIMESTAMP_MS = 8.64e15;


/** 生成带前缀的唯一可读 ID。 */
function generateId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}-${stamp}-${rand}`;
}


/** 判断软删除时间戳是否有效（即任务处于垃圾桶中）。 */
function isTrashedValue(value: number | null | undefined): boolean {
  return value !== undefined && value !== null;
}


/** 判断任务当前是否处于垃圾桶软删除状态。 */
function isTrashedTask(task: types.ControlTask): boolean {
  //M 读取任务上的软删除时间戳。
  return isTrashedValue(task.trashedAt);
}


/** 浅拷贝单个清单定义，防外部修改内存缓存。 */
function cloneList(item: types.TaskListDef): types.TaskListDef {
  return { ...item };
}


/** 复制一份默认清单数组。 */
function cloneDefaultLists(): types.TaskListDef[] {
  //M 按默认定义逐项浅拷贝，确保调用方拿不到共享常量引用。
  return DEFAULT_TASK_LISTS.map(cloneList);
}


/** 按 sortOrder 升序复制一份清单数组。 */
function sortLists(lists: readonly types.TaskListDef[]): types.TaskListDef[] {
  //M 复制后按 sortOrder 排序，未写权重排在末尾。
  return lists.map(cloneList).sort((a, b) => {
    const orderA = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });
}


/** 深拷贝任务对象，防外部意外篡改内存状态。 */
function cloneTask(task: types.ControlTask): types.ControlTask {
  const copy: types.ControlTask = {
    ...task,
    lockTags: [...task.lockTags],
    events: task.events.map((ev) => ({ ...ev })),
  };
  if (task.tags !== undefined) {
    copy.tags = [...task.tags];
  }
  if (task.checkIns !== undefined) {
    copy.checkIns = [...task.checkIns];
  }
  if (task.sourceRef !== undefined) {
    copy.sourceRef = SOURCE_REFS.clone(task.sourceRef);
  }
  return copy;
}


/** 校验并清洗去重字符串数组（供 lockTags、tags、checkIns 共用）。 */
function normalizeStringList(
  raw: unknown,
  field: string,
  maxItems: number,
  maxItemLen: number,
): string[] {
  //G 必须传入数组且条目数不超过上限。
  const items = checksModule.checkArray(raw, field);
  if (items.length > maxItems) {
    //G 超出条目上限直接拒绝，防单条任务膨胀。
    throw new failureModule.Failure(400, `${field} 最多 ${String(maxItems)} 个`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      //G 数组每一项都必须为字符串。
      throw new failureModule.Failure(400, `${field} 里的每一项都要是字符串`);
    }
    //M 去掉首尾空白后跳过空串与重复项。
    const val = item.trim();
    if (val === '' || seen.has(val)) {
      continue;
    }
    if (val.length > maxItemLen) {
      //G 单个条目超长报错，不静默截断。
      throw new failureModule.Failure(400, `单个 ${field} 最多 ${String(maxItemLen)} 字`);
    }
    seen.add(val);
    //M 按首次出现顺序收进清洗结果。
    out.push(val);
  }
  return out;
}


/** 校验可选文本字段并限制长度。 */
function checkOptionalString(
  raw: unknown,
  field: string,
  maxLen = MAX_TEXT_CHARS,
): string | undefined {
  if (raw === undefined) return undefined;

  if (typeof raw !== 'string') {
    //G 传入了非字符串类型立即返回 400。
    throw new failureModule.Failure(400, `${field} 要写成字符串`);
  }
  //M 去掉首尾空白后核对长度上限。
  const trimmed = raw.trim();
  if (trimmed.length > maxLen) {
    //G 超过字段最大允许长度直接拒收。
    throw new failureModule.Failure(400, `${field} 不能超过 ${String(maxLen)} 字`);
  }
  return trimmed;
}


/** 校验必填非空文本字段。 */
function checkRequiredString(raw: unknown, field: string, maxLen = MAX_TEXT_CHARS): string {
  //G 复用骨架非空检查并禁止纯空白文本。
  const val = checksModule.checkNonEmptyText(raw, field).trim();
  if (val === '') {
    //G 仅含空白字符不视为有效内容。
    throw new failureModule.Failure(400, `${field} 不能为空白`);
  }
  if (val.length > maxLen) {
    //G 超过字段最大允许长度直接拒收。
    throw new failureModule.Failure(400, `${field} 不能超过 ${String(maxLen)} 字`);
  }
  return val;
}


/** 校验允许传 null 清空的可选字符串字段（空串同样按 null 清空）。 */
function checkNullableString(
  raw: unknown,
  field: string,
  maxLen: number,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  if (typeof raw !== 'string') {
    //G 非 null 时必须为字符串。
    throw new failureModule.Failure(400, `${field} 要写成字符串或 null`);
  }
  //M 去首尾空白后，空串视为显式清空为 null。
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLen) {
    //G 超过字段最大允许长度直接拒收。
    throw new failureModule.Failure(400, `${field} 不能超过 ${String(maxLen)} 字`);
  }
  return trimmed;
}


/** 校验可选到期日或纪念日（YYYY-MM-DD 或 null 清空）。 */
function checkDueDate(raw: unknown): string | null | undefined {
  //G 先按可空字符串做类型和空串归一。
  const value = checkNullableString(raw, 'dueDate', 32);
  if (value === undefined || value === null) return value;

  if (!DATE_PATTERN.test(value)) {
    //G 非空日期必须严格满足 YYYY-MM-DD 格式。
    throw new failureModule.Failure(400, 'dueDate 要写成 YYYY-MM-DD 格式');
  }
  return value;
}


/** 校验可选四象限字段（q1~q4 或 null 清空）。 */
function checkQuadrant(raw: unknown): types.Quadrant | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;

  //G 非空值必须在 QUADRANTS 枚举内。
  return checksModule.checkAllowedValue(raw, types.QUADRANTS, 'quadrant');
}


/** 校验父任务 ID（不能等于任务自身 id，传 null 可清空）。 */
function checkParentId(raw: unknown, selfId: string): string | null | undefined {
  //G 先按可空字符串解析并去空白。
  const value = checkNullableString(raw, 'parentId', 120);
  if (value === selfId) {
    //G 禁止把任务设为自己的父节点形成自环。
    throw new failureModule.Failure(400, 'parentId 不能等于任务自身 id');
  }
  return value;
}


/** 校验软删除毫秒时间戳（非负安全整数或 null 还原）。 */
function checkTrashedAt(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  //G 统一用骨架 checkNumber 校验非负整型时间戳。
  const rule = { integer: true, min: 0, max: MAX_TIMESTAMP_MS };
  return checksModule.checkNumber(raw, 'trashedAt', rule);
}


/** 校验可选排序权重（任意有限数字）。 */
function checkSortOrder(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;

  //G 统一用骨架 checkNumber 校验有限数值。
  return checksModule.checkNumber(raw, 'sortOrder');
}


/** 校验习惯打卡日期（缺省时取当天本地 YYYY-MM-DD）。 */
function checkCheckinDate(raw: unknown): string {
  if (raw === undefined) {
    //M 未传 date 时按本地时钟格式化当天日期。
    return textModule.formatLocalTime(Date.now(), 'date').slice(0, 10);
  }
  if (typeof raw !== 'string') {
    //G 传入非字符串时拒绝打卡请求。
    throw new failureModule.Failure(400, 'date 要写成 YYYY-MM-DD 格式');
  }
  //M 校验去掉首尾空白后满足 YYYY-MM-DD。
  const trimmed = raw.trim();
  if (!DATE_PATTERN.test(trimmed)) {
    //G 拒绝不符合日期格式的输入。
    throw new failureModule.Failure(400, 'date 要写成 YYYY-MM-DD 格式');
  }
  return trimmed;
}


/** 把请求体中存在的滴答原子扩展字段校验后写入目标任务对象。 */
function applyExtendedFields(
  body: Record<string, unknown>,
  taskId: string,
  target: types.ControlTask,
): void {
  if ('kind' in body && body['kind'] !== undefined) {
    //G 校验任务种类是否合法。
    target.kind = checksModule.checkAllowedValue(body['kind'], types.TASK_KINDS, 'kind');
  }
  if ('list' in body && body['list'] !== undefined) {
    //M 空串表示清空自定义清单名，回退默认工作任务视角。
    const listName = checkOptionalString(body['list'], 'list', 80);
    if (listName === '') {
      delete target.list;
    }
    if (listName !== undefined && listName !== '') {
      target.list = listName;
    }
  }
  if ('parentId' in body && body['parentId'] !== undefined) {
    //G 校验父任务 ID（支持传 null 清空，禁止自指）。
    target.parentId = checkParentId(body['parentId'], taskId);
  }
  if ('quadrant' in body && body['quadrant'] !== undefined) {
    //G 校验四象限键值（支持传 null 清空）。
    target.quadrant = checkQuadrant(body['quadrant']);
  }
  if ('dueDate' in body && body['dueDate'] !== undefined) {
    //G 校验 YYYY-MM-DD 日期格式（支持传 null 清空）。
    target.dueDate = checkDueDate(body['dueDate']);
  }
  if ('countdownMode' in body && body['countdownMode'] !== undefined) {
    //G 校验倒数/正数纪念日方向枚举。
    target.countdownMode = checksModule.checkAllowedValue(
      body['countdownMode'],
      types.COUNTDOWN_MODES,
      'countdownMode',
    );
  }
  if ('icon' in body && body['icon'] !== undefined) {
    //M 空串清空图标，非空保留 emoji 文本。
    const iconVal = checkOptionalString(body['icon'], 'icon', 32);
    if (iconVal === '') {
      delete target.icon;
    }
    if (iconVal !== undefined && iconVal !== '') {
      target.icon = iconVal;
    }
  }
  if ('tags' in body && body['tags'] !== undefined) {
    //M 清洗并去重任务标签数组。
    target.tags = normalizeStringList(body['tags'], 'tags', MAX_TAGS, 60);
  }
  if ('checkIns' in body && body['checkIns'] !== undefined) {
    //M 清洗并去重习惯打卡日期数组。
    target.checkIns = normalizeStringList(body['checkIns'], 'checkIns', MAX_CHECKINS, 32);
  }
  if ('trashedAt' in body && body['trashedAt'] !== undefined) {
    //G 校验软删除时间戳或传 null 还原。
    target.trashedAt = checkTrashedAt(body['trashedAt']);
  }
  if ('sortOrder' in body && body['sortOrder'] !== undefined) {
    //G 校验排序权重数值。
    target.sortOrder = checkSortOrder(body['sortOrder']);
  }
  if (body['sourceRef'] === null) {
    //M 传 null 清空来源关联。
    delete target.sourceRef;
  }
  if (body['sourceRef'] !== undefined && body['sourceRef'] !== null) {
    //G 校验并规范化来源引用。
    target.sourceRef = SOURCE_REFS.normalize(body['sourceRef']);
  }
}


/** 判定磁盘读出的条目是否为合法 ControlTask 基础对象。 */
function isValidTaskRecord(item: unknown): item is types.ControlTask {
  if (typeof item !== 'object' || item === null) return false;

  const rec = item as Record<string, unknown>;
  return typeof rec['id'] === 'string' && typeof rec['title'] === 'string';
}


/** 判定磁盘读出的条目是否为合法 TaskListDef 清单定义。 */
function isValidListRecord(item: unknown): item is types.TaskListDef {
  if (typeof item !== 'object' || item === null) return false;

  const rec = item as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || rec['id'].trim() === '') return false;

  return typeof rec['name'] === 'string' && rec['name'].trim() !== '';
}


/** 根据修改内容推算写入时间线的事件类型。 */
function resolvePatchEventKind(
  customKind: types.ControlTaskEventKind | undefined,
  currentStatus: types.ControlTaskStatus,
  nextStatus: types.ControlTaskStatus,
  heartbeat: boolean,
  changeCount: number,
): types.ControlTaskEventKind {
  if (customKind !== undefined) return customKind;
  if (nextStatus === 'cancelled' && currentStatus !== 'cancelled') return 'cancelled';
  if (nextStatus !== currentStatus) return 'status';
  if (heartbeat && changeCount === 0) return 'heartbeat';

  return 'scope_change';
}


/** 拼接局部更新的时间线描述文本。 */
function formatPatchEventText(changes: readonly string[], reason: string): string {
  //M 先按分号汇总字段变更明细。
  const summary = changes.join('；');
  if (reason !== '' && summary !== '') return `${summary}（${reason}）`;
  if (reason !== '') return reason;
  if (summary !== '') return summary;

  return '上报心跳';
}


/** 汇总局部更新前后的人类可读变更列表（用于追加时间线）。 */
function collectPatchChanges(current: types.ControlTask, updated: types.ControlTask): string[] {
  const changes: string[] = [];
  if (updated.status !== current.status) {
    //M 记录任务状态流转。
    changes.push(`状态 ${STATUS_LABELS[current.status]} → ${STATUS_LABELS[updated.status]}`);
  }
  if (updated.priority !== current.priority) {
    //M 记录优先级变化。
    changes.push(`优先级 ${current.priority} → ${updated.priority}`);
  }
  if (updated.owner !== current.owner) {
    let fromOwner = '未认领';
    if (current.owner !== '') {
      fromOwner = current.owner;
    }
    let toOwner = '未认领';
    if (updated.owner !== '') {
      toOwner = updated.owner;
    }
    //M 记录认领负责人交接。
    changes.push(`负责人 ${fromOwner} → ${toOwner}`);
  }
  if (JSON.stringify(updated.lockTags) !== JSON.stringify(current.lockTags)) {
    let joined = '无';
    if (updated.lockTags.length > 0) {
      joined = updated.lockTags.join(', ');
    }
    //M 记录占坑互斥锁调整。
    changes.push(`占坑锁 [${joined}]`);
  }
  if (updated.doneCriteria !== current.doneCriteria) {
    //M 记录验收标准变动。
    changes.push('更新验收标准');
  }
  if (updated.title !== current.title) {
    //M 记录标题修改。
    changes.push(`标题改为「${updated.title}」`);
  }
  if (updated.summary !== current.summary) {
    //M 记录任务摘要更新。
    changes.push('更新任务摘要');
  }
  //M 检查软删除移入/还原状态转换。
  const wasTrashed = isTrashedTask(current);
  const nowTrashed = isTrashedTask(updated);
  if (!wasTrashed && nowTrashed) {
    //M 记下移入垃圾桶事件。
    changes.push('移入垃圾桶');
  }
  if (wasTrashed && !nowTrashed) {
    //M 记下从垃圾桶还原事件。
    changes.push('从垃圾桶还原');
  }
  const refBefore = current.sourceRef;
  const refAfter = updated.sourceRef;
  if (refBefore !== undefined && refAfter === undefined) {
    //M 记下清空来源关联。
    changes.push('清空来源关联');
  }
  if (refBefore === undefined && refAfter !== undefined) {
    //M 记下新增来源关联。
    changes.push(`关联来源 ${SOURCE_REFS.describe(refAfter)}`);
  }
  const refChanged = JSON.stringify(refBefore) !== JSON.stringify(refAfter);
  if (refBefore !== undefined && refAfter !== undefined && refChanged) {
    //M 记下来源关联更新。
    changes.push(`更新来源关联 ${SOURCE_REFS.describe(refAfter)}`);
  }
  return changes;
}


/** 写一张任务后的统一结果：最新修订号、任务副本、活跃占坑锁与可派发队列。 */
export interface TaskWriteResult {
  /** 写盘后的修订号。 */
  revision: number;
  /** 写盘后的任务副本。 */
  task: types.ControlTask;
  /** 活跃占坑锁。 */
  activeLocks: Record<string, types.ActiveLockHolder>;
  /** 不撞锁、可立即派发的 ready 任务 ID。 */
  dispatchableIds: string[];
}

/** 按来源幂等入池的结果。 */
export interface UpsertResult extends TaskWriteResult {
  /** 这次新建了任务。 */
  created: boolean;
  /** 这次命中了已有任务（没新建）。 */
  deduplicated: boolean;
}


/**
 * 多 AI 控制面任务与滴答视图存储仲裁器。
 */
export class ControlPlaneStore {
  /** 磁盘 JSON 文件绝对路径。 */
  private readonly filePath: string;
  /** 控制面任务账本递增修订号。 */
  private revision = 0;
  /** 内存中的全部任务卡列表。 */
  private tasks: types.ControlTask[] = [];
  /** 内存中的任务清单定义列表（按 sortOrder 升序）。 */
  private lists: types.TaskListDef[] = [];

  /**
   * @param runtimeRoot 运行时根目录（即 jmbotsData），账本存为 `<runtimeRoot>/control-plane-tasks.json`。
   */
  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, 'control-plane-tasks.json');
    //M 初始化默认清单后从磁盘恢复任务与清单，老格式保持向后兼容。
    this.lists = cloneDefaultLists();
    this.loadFromDisk();
  }

  /** 当前控制面任务修订号（每次增删改递增，供 /version 探针感知）。 */
  getRevision(): number {
    return this.revision;
  }

  /** 返回按 sortOrder 排好序的清单浅拷贝数组。 */
  private getClonedLists(): types.TaskListDef[] {
    //M 统一排序并返回独立副本。
    return sortLists(this.lists);
  }

  /** 启动时读取已有 JSON；兼容老文件缺失 lists 或新字段，读取失败按空面板兜底。 */
  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) return;

    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as Partial<types.ControlPlaneFile>;
      if (
        typeof parsed.revision === 'number'
        && Number.isSafeInteger(parsed.revision)
        && parsed.revision >= 0
      ) {
        this.revision = parsed.revision;
      }
      if (Array.isArray(parsed.tasks)) {
        //M 原样保留老任务全部字段，只过滤损坏的非对象条目。
        this.tasks = parsed.tasks.filter(isValidTaskRecord);
      }
      if (Array.isArray(parsed.lists)) {
        //M 文件含有效清单时沿用文件定义，空数组或全非法时保持默认清单兜底。
        const validLists = parsed.lists.filter(isValidListRecord);
        if (validLists.length > 0) {
          //M 按 sortOrder 排好后存入内存清单。
          this.lists = sortLists(validLists);
        }
      }
    } catch (error) {
      //G 解析异常时打印错误并退回空面板与默认清单，不阻塞服务启动。
      const msg = textModule.getErrorMessage(error);
      console.error(`work-decision：读取 control-plane-tasks.json 失败，已按空面板启动：${msg}`);
    }
  }

  /** 原子写盘（开启 fallback 防安全软件拦截 rename），写成功后提交内存状态。 */
  private saveToDisk(
    nextRevision: number,
    nextTasks: types.ControlTask[],
    nextLists: types.TaskListDef[] = this.lists,
  ): void {
    const payload: types.ControlPlaneFile = {
      version: 1,
      revision: nextRevision,
      tasks: nextTasks,
      lists: nextLists,
    };
    //M 原子写盘并同时持久化 tasks 与 lists（老文件首次写盘即补齐 lists）。
    filesModule.writeTextAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, true);
    this.revision = nextRevision;
    this.tasks = nextTasks;
    this.lists = nextLists;
  }

  /** 计算全局各状态计数、活跃占坑锁与不撞锁的可立即派发 ready 任务 ID 列表（均跳过垃圾桶任务）。 */
  computeBoardMeta(sourceTasks: readonly types.ControlTask[] = this.tasks): {
    counts: Record<types.ControlTaskStatus, number>;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const counts: Record<types.ControlTaskStatus, number> = {
      pending_decision: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    };
    const activeLocks: Record<string, types.ActiveLockHolder> = {};

    for (const task of sourceTasks) {
      //G 已软删除进垃圾桶的任务不计入活跃状态计数与占坑锁。
      if (isTrashedTask(task)) {
        continue;
      }
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      if (task.status !== 'running') {
        continue;
      }
      for (const tag of task.lockTags) {
        if (activeLocks[tag] === undefined) {
          activeLocks[tag] = {
            taskId: task.id,
            title: task.title,
            owner: task.owner,
          };
        }
      }
    }

    //M 仅从非垃圾桶的 ready 任务中筛选完全不撞活跃占坑锁的可派发队列。
    const readyCandidates = sourceTasks.filter((task) => {
      if (isTrashedTask(task) || task.status !== 'ready') return false;

      //M 确认全部占坑标签当前未被任何 running 任务占用。
      return task.lockTags.every((tag) => activeLocks[tag] === undefined);
    });

    //M 按优先级（P0→P2）与创建时间升序排列可派发队列。
    readyCandidates.sort((a, b) => {
      const prioDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (prioDiff !== 0) return prioDiff;

      return a.createdAt - b.createdAt;
    });

    return {
      counts,
      activeLocks,
      //M 提取排好序的任务 ID 供巡检环直接取单。
      dispatchableIds: readyCandidates.map((task) => task.id),
    };
  }

  /**
   * 按来源找没进垃圾桶的已有任务：先比去重键，对不上再退到同渠道同 relayId 或 messageId。
   * 当现有任务与入参均显式设置了不同的非空 dedupeKey 时，跳过退化合并（支持同消息拆多张任务）。
   * @param ref 已规范化的来源。
   * @param excludeTaskId 不算这张任务（改自己的来源时用）。
   * @returns 命中任务在 this.tasks 里的下标；没命中是 -1。
   */
  private findBySource(ref: types.TaskSourceRef, excludeTaskId?: string): number {
    //M 只看带来源、没进垃圾桶的其他任务。
    const isCandidate = (task: types.ControlTask): boolean => {
      return task.sourceRef !== undefined && !isTrashedTask(task) && task.id !== excludeTaskId;
    };

    //M 先按去重键找。
    const key = SOURCE_REFS.deriveDedupeKey(ref);
    if (key !== undefined) {
      const byKey = this.tasks.findIndex((task) => {
        return isCandidate(task) && SOURCE_REFS.deriveDedupeKey(task.sourceRef!) === key;
      });
      if (byKey >= 0) return byKey;
    }

    //M 去重键对不上时，退到同渠道同 relayId 或 messageId；双方显式 dedupeKey 不同则跳过退化合并。
    const incomingKey = ref.dedupeKey?.trim() ?? '';
    return this.tasks.findIndex((task) => {
      if (!isCandidate(task)) return false;

      const existingRef = task.sourceRef!;
      const existingKey = existingRef.dedupeKey?.trim() ?? '';
      const hasDistinctKeys = incomingKey !== '' && existingKey !== '' && incomingKey !== existingKey;
      //G 双方均显式设置了不同的非空 dedupeKey，跳过按消息 ID 退化合并。
      if (hasDistinctKeys) return false;

      return SOURCE_REFS.isSameMessage(existingRef, ref);
    });
  }

  /**
   * 来源已被别的没进垃圾桶的任务占了就抛 409（带已有任务 ID），POST /tasks 不悄悄复用。
   * @param ref 已规范化的来源。
   * @param excludeTaskId 不算这张任务。
   * @throws DuplicateSourceFailure(409)。
   */
  private assertSourceFree(ref: types.TaskSourceRef, excludeTaskId?: string): void {
    const index = this.findBySource(ref, excludeTaskId);
    if (index < 0) return;

    const existing = this.tasks[index]!;
    throw new DuplicateSourceFailure(`这个来源已经有任务了：${existing.id}（${existing.title}）`, existing.id);
  }

  /** 检查 lockTags 是否与除 excludeTaskId 外其他未进垃圾桶的 running 任务撞坑；冲突时抛 409。 */
  private assertNoLockConflict(lockTags: readonly string[], excludeTaskId?: string): void {
    if (lockTags.length === 0) return;

    const conflicts: types.ControlTaskLockConflict[] = [];
    for (const other of this.tasks) {
      //G 仅对非垃圾桶的 running 任务执行 409 互斥锁校验。
      if (other.status !== 'running' || isTrashedTask(other) || other.id === excludeTaskId) {
        continue;
      }
      for (const tag of lockTags) {
        if (other.lockTags.includes(tag)) {
          //M 记下冲突的占坑标签及当前持有任务信息。
          conflicts.push({
            lockTag: tag,
            taskId: other.id,
            title: other.title,
            owner: other.owner,
          });
        }
      }
    }
    if (conflicts.length === 0) return;

    //M 拼装冲突明细供人类与多 AI 快速排查占用方。
    const detail = conflicts
      .map((c) => {
        let holder = '未署名节点';
        if (c.owner !== '') {
          holder = c.owner;
        }
        return `${c.lockTag}（正由 ${holder} 执行「${c.title}」[${c.taskId}] 占用）`;
      })
      .join('；');
    //G 存在占坑冲突时抛出 409 异常，阻止双 AI 撞车。
    throw new LockConflictFailure(`占坑锁冲突，无法同时进入 running：${detail}`, conflicts);
  }

  /** 查询任务与清单快照，支持按 status（逗号分隔）、lockTag、owner 与来源 6 维筛选。 */
  list(filter?: {
    statuses?: readonly types.ControlTaskStatus[];
    lockTag?: string;
    owner?: string;
    source?: types.ControlTaskSourceFilter;
  }): types.ControlPlaneSnapshot {
    //M 先基于全量任务计算全局计数、活跃锁与可派发队列。
    const meta = this.computeBoardMeta();
    let matched = this.tasks;

    if (filter?.statuses !== undefined && filter.statuses.length > 0) {
      const set = new Set(filter.statuses);
      //M 按查询参数过滤目标状态任务。
      matched = matched.filter((task) => set.has(task.status));
    }
    if (filter?.lockTag !== undefined && filter.lockTag !== '') {
      const tag = filter.lockTag;
      //M 按占坑标签过滤任务。
      matched = matched.filter((task) => task.lockTags.includes(tag));
    }
    if (filter?.owner !== undefined && filter.owner !== '') {
      const who = filter.owner;
      //M 按负责人过滤任务。
      matched = matched.filter((task) => task.owner === who);
    }
    if (filter?.source !== undefined) {
      const source = filter.source;
      //M 按来源 channel、bot、chatId、sessionId、relayId、hasSource 过滤任务。
      matched = matched.filter((task) => SOURCE_REFS.matchesFilter(task.sourceRef, source));
    }

    //M 复制并按状态、优先级、最近修改时间降序整理返回列表。
    const sorted = matched.map(cloneTask).sort((a, b) => {
      const stDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (stDiff !== 0) return stDiff;

      const prioDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (prioDiff !== 0) return prioDiff;

      return b.updatedAt - a.updatedAt;
    });

    return {
      ok: true,
      revision: this.revision,
      tasks: sorted,
      //M 返回排好序的清单定义列表供前端直接渲染。
      lists: this.getClonedLists(),
      ...meta,
    };
  }

  /** 创建一张新的控制面或滴答任务卡（未传 status 默认为 ready）。 */
  create(rawBody: unknown): {
    revision: number;
    task: types.ControlTask;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    //G 入口校验请求体结构及可选自定义 ID 合法性。
    const body = checksModule.checkRecord(rawBody, '请求体');
    const customId = checkOptionalString(body['id'], 'id', 120);
    if (customId !== undefined && customId !== '') {
      if (!ID_PATTERN.test(customId)) {
        //G 拒绝含路径或非法符号的自定义 ID。
        throw new failureModule.Failure(400, 'id 只能包含字母、数字、下划线、点、冒号或短横线');
      }
      if (this.tasks.some((item) => item.id === customId)) {
        //G 任务 ID 冲突返回 409。
        throw new failureModule.Failure(409, `任务 ID 已存在：${customId}`);
      }
    }
    //M 补齐任务 ID 并校验标题、摘要、状态、优先级、占坑锁与负责人字段。
    let id = generateId('ct');
    if (customId !== undefined && customId !== '') {
      id = customId;
    }
    //M 校验标题与可选摘要。
    const title = checkRequiredString(body['title'], 'title', 200);
    const summary = checkOptionalString(body['summary'], 'summary') ?? '';

    let status: types.ControlTaskStatus = 'ready';
    if (body['status'] !== undefined) {
      //G 显式传入 status 时必须在允许的 6 种状态内。
      status = checksModule.checkAllowedValue(body['status'], types.CONTROL_TASK_STATUSES, 'status');
    }

    let priority: types.ControlTaskPriority = 'P1';
    if (body['priority'] !== undefined) {
      //G 显式传入 priority 时必须在 P0~P2 内。
      priority = checksModule.checkAllowedValue(
        body['priority'],
        types.CONTROL_TASK_PRIORITIES,
        'priority',
      );
    }

    let lockTags: string[] = [];
    if (body['lockTags'] !== undefined) {
      //M 清洗并去重占坑标签列表。
      lockTags = normalizeStringList(body['lockTags'], 'lockTags', MAX_LOCK_TAGS, 80);
    }
    //M 校验负责人、验收标准、操作者与初始时间线说明。
    const owner = checkOptionalString(body['owner'], 'owner', 120) ?? '';
    const doneCriteria = checkOptionalString(body['doneCriteria'], 'doneCriteria') ?? '';
    const by = checkOptionalString(body['by'], 'by', 120) || owner || 'central';

    //M 生成创建时刻与初始时间线说明。
    const now = Date.now();
    const defaultEventText = `创建任务（状态：${STATUS_LABELS[status]}，优先级：${priority}）`;
    const initialNote = checkOptionalString(body['initialNote'], 'initialNote') || defaultEventText;

    const task: types.ControlTask = {
      id,
      title,
      summary,
      status,
      priority,
      lockTags,
      owner,
      doneCriteria,
      lastHeartbeatAt: null,
      events: [
        {
          at: now,
          by,
          kind: 'created',
          text: initialNote,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    //M 解析并写入所有可选滴答视图原子字段（含 parentId !== id 与格式校验）。
    applyExtendedFields(body, id, task);

    //G 来源撞上没进垃圾桶的已有任务时回 409（带已有任务 ID）。
    if (task.sourceRef !== undefined) {
      this.assertSourceFree(task.sourceRef);
    }

    //G 非垃圾桶任务进入 running 前检查占坑锁互斥。
    if (status === 'running' && !isTrashedTask(task)) {
      this.assertNoLockConflict(lockTags, id);
      task.lastHeartbeatAt = now;
    }

    //M 追加任务并原子写盘。
    const nextTasks = [...this.tasks, task];
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      revision: this.revision,
      task: cloneTask(task),
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }

  /** 局部修改任务字段、扩展属性或占坑标签（非垃圾桶进入 running 时强检 409 占坑冲突）。 */
  patch(id: string, rawBody: unknown): {
    revision: number;
    task: types.ControlTask;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      //G 任务不存在返回 404。
      throw new failureModule.Failure(404, `任务不存在：${id}`);
    }
    //G 入口校验请求体结构，并在独立拷贝上校验并合并所有补丁字段。
    const body = checksModule.checkRecord(rawBody, '请求体');
    const current = this.tasks[index]!;
    const updatedTask = cloneTask(current);

    if ('title' in body && body['title'] !== undefined) {
      //G 校验更新后的非空标题。
      updatedTask.title = checkRequiredString(body['title'], 'title', 200);
    }
    if ('summary' in body && body['summary'] !== undefined) {
      //G 校验更新后的任务摘要。
      updatedTask.summary = checkOptionalString(body['summary'], 'summary') ?? '';
    }
    if ('status' in body && body['status'] !== undefined) {
      //G 校验更新后的任务状态枚举。
      updatedTask.status = checksModule.checkAllowedValue(
        body['status'],
        types.CONTROL_TASK_STATUSES,
        'status',
      );
    }
    if ('priority' in body && body['priority'] !== undefined) {
      //G 校验更新后的优先级枚举。
      updatedTask.priority = checksModule.checkAllowedValue(
        body['priority'],
        types.CONTROL_TASK_PRIORITIES,
        'priority',
      );
    }
    if ('lockTags' in body && body['lockTags'] !== undefined) {
      //M 清洗并去重占坑锁标签。
      updatedTask.lockTags = normalizeStringList(body['lockTags'], 'lockTags', MAX_LOCK_TAGS, 80);
    }
    if ('owner' in body && body['owner'] !== undefined) {
      //G 校验负责人字符串。
      updatedTask.owner = checkOptionalString(body['owner'], 'owner', 120) ?? '';
    }
    if ('doneCriteria' in body && body['doneCriteria'] !== undefined) {
      //G 校验验收标准字符串。
      updatedTask.doneCriteria = checkOptionalString(body['doneCriteria'], 'doneCriteria') ?? '';
    }

    //M 合并并校验本次补丁中提供的滴答扩展字段（支持 null 清空）。
    applyExtendedFields(body, id, updatedTask);

    //G 换了来源或从垃圾桶还原时，来源不许撞上别的没进垃圾桶的任务。
    const refChanged = JSON.stringify(updatedTask.sourceRef) !== JSON.stringify(current.sourceRef);
    const restored = isTrashedTask(current) && !isTrashedTask(updatedTask);
    if (updatedTask.sourceRef !== undefined && !isTrashedTask(updatedTask) && (refChanged || restored)) {
      this.assertSourceFree(updatedTask.sourceRef, id);
    }

    //G 只要更新后是未进垃圾桶的 running 状态，必须确保不与其他 running 任务撞锁。
    if (updatedTask.status === 'running' && !isTrashedTask(updatedTask)) {
      this.assertNoLockConflict(updatedTask.lockTags, id);
    }

    //M 解析时间线操作人与变更说明。
    const now = Date.now();
    const by = checkOptionalString(body['by'], 'by', 120) || updatedTask.owner || 'central';
    const reason = checkOptionalString(body['reason'], 'reason') ?? '';
    let customEventKind: types.ControlTaskEventKind | undefined;
    if (body['eventKind'] !== undefined) {
      //G 校验显式传入的时间线事件种类。
      customEventKind = checksModule.checkAllowedValue(
        body['eventKind'],
        types.CONTROL_TASK_EVENT_KINDS,
        'eventKind',
      );
    }

    //M 刷新心跳时间戳与汇总变更时间线。
    const claimedOrOwnerChanged = updatedTask.status === 'running'
      && !isTrashedTask(updatedTask)
      && (current.status !== 'running' || updatedTask.owner !== current.owner);
    if (body['heartbeat'] === true || claimedOrOwnerChanged) {
      updatedTask.lastHeartbeatAt = now;
    }

    //M 收集前后字段差异并按需追加时间线事件。
    const changes = collectPatchChanges(current, updatedTask);
    if (changes.length > 0 || reason !== '' || body['heartbeat'] === true) {
      //M 推算事件类型与人类可读描述文本。
      const kind = resolvePatchEventKind(
        customEventKind,
        current.status,
        updatedTask.status,
        body['heartbeat'] === true,
        changes.length,
      );
      const eventText = formatPatchEventText(changes, reason);
      //M 追加最新一条变更或心跳记录，并限制单任务事件数上限。
      updatedTask.events.push({ at: now, by, kind, text: eventText });
      if (updatedTask.events.length > MAX_EVENTS_PER_TASK) {
        updatedTask.events.splice(0, updatedTask.events.length - MAX_EVENTS_PER_TASK);
      }
    }
    updatedTask.updatedAt = now;

    //M 替换内存切片并原子写盘。
    const nextTasks = this.tasks.slice();
    nextTasks[index] = updatedTask;
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      revision: this.revision,
      task: cloneTask(updatedTask),
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }

  /**
   * 按来源幂等入池：没有就建一张，有就只补来源里缺的子字段、按需重开并追加一条事件。
   * @param rawBody 请求体（ControlTaskUpsertInput，外面进来的，这里校验一次）。
   * @returns created / deduplicated 两个标记，加上写盘后的修订号、任务、活跃锁与可派发队列。
   * @throws Failure(400)：sourceRef 没写或不对、其他字段不对；LockConflictFailure(409)：新建直接 running 撞锁。
   */
  upsertBySource(rawBody: unknown): UpsertResult {
    //G sourceRef 必填并校验。
    const body = checksModule.checkRecord(rawBody, '请求体');
    if (body['sourceRef'] === undefined || body['sourceRef'] === null) {
      throw new failureModule.Failure(400, 'sourceRef 必填：要写成带 channel 的对象');
    }
    const ref = SOURCE_REFS.normalize(body['sourceRef']);

    //G 这次的话（eventText，别名 note）和 reopen 开关。
    const eventText = checkOptionalString(body['eventText'], 'eventText')
      || checkOptionalString(body['note'], 'note')
      || '';
    let reopen = false;
    if (body['reopen'] !== undefined) {
      reopen = checksModule.checkFlag(body['reopen'], 'reopen');
    }

    //M 命中已有任务：只补来源、按需重开和追加事件。
    const index = this.findBySource(ref);
    if (index >= 0) {
      const merged = this.mergeIntoExisting(index, ref, body, eventText, reopen);
      return { created: false, deduplicated: true, ...merged };
    }

    //M 没命中：补默认值后走 create（create 再校验一遍字段并查撞锁）。
    const createBody = this.getUpsertCreateBody(body, ref, eventText);
    const created = this.create(createBody);
    return { created: true, deduplicated: false, ...created };
  }

  /**
   * 入池新建时补默认值：标题用这次的话的第一行（再没有用来源），摘要是这次的话，清单进收集箱。
   * 状态、优先级不写由 create 补（ready、P1）。
   * @param body 已校验过结构的请求体。
   * @param ref 已规范化的来源。
   * @param eventText 这次的话。
   * @returns 交给 create 的请求体。
   */
  private getUpsertCreateBody(
    body: Record<string, unknown>,
    ref: types.TaskSourceRef,
    eventText: string,
  ): Record<string, unknown> {
    const label = SOURCE_REFS.describe(ref);
    const createBody: Record<string, unknown> = { ...body, sourceRef: ref };
    if (body['title'] === undefined) {
      //M 没写标题：这次的话的第一行（截 60 字），没有话就写截断后的来源（避免超过 200 字上限）。
      const shortLabel = label.slice(0, 120).trim();
      let title = `来自 ${shortLabel} 的任务`;
      const firstLine = eventText.split('\n')[0]?.trim() ?? '';
      if (firstLine !== '') {
        title = firstLine.slice(0, 60);
      }
      createBody['title'] = title;
    }
    if (body['summary'] === undefined && eventText !== '') {
      //M 没写摘要：这次的话。
      createBody['summary'] = eventText;
    }
    if (body['list'] === undefined) {
      //M 没写清单：进收集箱（用户改过名时用改后的名字）。
      const inbox = this.lists.find((item) => item.id === 'inbox');
      createBody['list'] = inbox?.name ?? '收集箱';
    }
    if (body['initialNote'] === undefined) {
      //M 初始时间线写清从哪来。
      createBody['initialNote'] = `从 ${label} 入池`;
    }
    return createBody;
  }

  /**
   * 入池命中已有任务：只补来源里缺的子字段，主字段一个不动；done、cancelled 的传了 reopen 才回到待派发；带了话追加一条备注。
   * 什么都没变时不写盘、不涨修订号。
   * @param index 命中任务的下标。
   * @param ref 这次来的来源。
   * @param body 已校验过结构的请求体（只读 by）。
   * @param eventText 这次的话；空串不追加。
   * @param reopen 是否重开已完成或已取消的任务。
   */
  private mergeIntoExisting(
    index: number,
    ref: types.TaskSourceRef,
    body: Record<string, unknown>,
    eventText: string,
    reopen: boolean,
  ): TaskWriteResult {
    const current = this.tasks[index]!;
    const updatedTask = cloneTask(current);
    updatedTask.sourceRef = SOURCE_REFS.mergeMissing(current.sourceRef!, ref);
    const now = Date.now();
    const by = checkOptionalString(body['by'], 'by', 120) || current.owner || 'central';

    //M 已完成或已取消：传了 reopen 才回到待派发，不然保持原状态。
    const closed = current.status === 'done' || current.status === 'cancelled';
    if (closed && reopen) {
      updatedTask.status = 'ready';
      const text = `状态 ${STATUS_LABELS[current.status]} → ${STATUS_LABELS.ready}（同一来源重新入池）`;
      updatedTask.events.push({ at: now, by, kind: 'status', text });
    }

    //M 这次带了话就追加一条备注。
    if (eventText !== '') {
      updatedTask.events.push({ at: now, by, kind: 'note', text: eventText });
    }

    //G 来源没补出新东西、也没有新事件：原样返回，不写盘。
    const meta = this.computeBoardMeta();
    const refChanged = JSON.stringify(updatedTask.sourceRef) !== JSON.stringify(current.sourceRef);
    if (!refChanged && updatedTask.events.length === current.events.length) {
      return {
        revision: this.revision,
        task: cloneTask(current),
        activeLocks: meta.activeLocks,
        dispatchableIds: meta.dispatchableIds,
      };
    }

    //M 裁掉超出上限的旧事件，替换后原子写盘。
    if (updatedTask.events.length > MAX_EVENTS_PER_TASK) {
      updatedTask.events.splice(0, updatedTask.events.length - MAX_EVENTS_PER_TASK);
    }
    updatedTask.updatedAt = now;
    const nextTasks = this.tasks.slice();
    nextTasks[index] = updatedTask;
    this.saveToDisk(this.revision + 1, nextTasks);
    const nextMeta = this.computeBoardMeta();
    return {
      revision: this.revision,
      task: cloneTask(updatedTask),
      activeLocks: nextMeta.activeLocks,
      dispatchableIds: nextMeta.dispatchableIds,
    };
  }

  /** 追加一条原则更新 / 范围变更 / 心跳 / 备注事件，并自动刷新 lastHeartbeatAt。 */
  appendEvent(id: string, rawBody: unknown): {
    revision: number;
    task: types.ControlTask;
    event: types.ControlTaskEvent;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      //G 任务不存在返回 404。
      throw new failureModule.Failure(404, `任务不存在：${id}`);
    }
    //G 校验请求体并解析事件种类。
    const body = checksModule.checkRecord(rawBody ?? {}, '请求体');
    const current = this.tasks[index]!;

    let kind: types.ControlTaskEventKind = 'note';
    if (body['kind'] !== undefined) {
      //G 校验事件种类是否在允许枚举内。
      kind = checksModule.checkAllowedValue(body['kind'], types.CONTROL_TASK_EVENT_KINDS, 'kind');
    }

    let nextStatus = current.status;
    if (body['status'] !== undefined) {
      //G 显式变更状态时校验合法性；非垃圾桶任务进入 running 需防撞锁。
      nextStatus = checksModule.checkAllowedValue(body['status'], types.CONTROL_TASK_STATUSES, 'status');
      if (nextStatus === 'running' && !isTrashedTask(current)) {
        //G 仅对非垃圾桶任务检查占坑锁冲突。
        this.assertNoLockConflict(current.lockTags, id);
      }
    }
    if (body['status'] === undefined && kind === 'cancelled') {
      nextStatus = 'cancelled';
    }

    //M 校验追加事件的操作人与正文内容。
    const by = checkOptionalString(body['by'], 'by', 120) || current.owner || 'ai';
    let text = checkOptionalString(body['text'], 'text') ?? '';
    if (text === '' && kind !== 'heartbeat') {
      //G 非心跳事件必须给出非空说明文字。
      throw new failureModule.Failure(400, 'text 要写成非空字符串');
    }
    if (text === '' && kind === 'heartbeat') {
      text = '进度心跳正常';
    }

    //M 构造事件并裁剪超长历史。
    const now = Date.now();
    const event: types.ControlTaskEvent = { at: now, by, kind, text };
    const nextEvents = [...current.events.map((ev) => ({ ...ev })), event];
    if (nextEvents.length > MAX_EVENTS_PER_TASK) {
      nextEvents.splice(0, nextEvents.length - MAX_EVENTS_PER_TASK);
    }

    const updatedTask: types.ControlTask = {
      ...cloneTask(current),
      status: nextStatus,
      lastHeartbeatAt: now,
      events: nextEvents,
      updatedAt: now,
    };

    //M 保存最新事件与心跳时间并原子落盘。
    const nextTasks = this.tasks.slice();
    nextTasks[index] = updatedTask;
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      revision: this.revision,
      task: cloneTask(updatedTask),
      event,
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }

  /** 硬删除一张控制面或滴答任务卡。 */
  remove(id: string): {
    revision: number;
    deleted: string;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      //G 任务不存在返回 404。
      throw new failureModule.Failure(404, `任务不存在：${id}`);
    }
    //M 从任务列表移除目标项并原子写盘。
    const nextTasks = this.tasks.filter((item) => item.id !== id);
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      revision: this.revision,
      deleted: id,
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }

  /** 新建自定义清单（同名清单幂等返回已存在条目，避免重复）。 */
  createList(rawBody: unknown): {
    revision: number;
    list: types.TaskListDef;
    lists: types.TaskListDef[];
  } {
    //G 校验请求体、必填名称及可选自定义 ID。
    const body = checksModule.checkRecord(rawBody, '请求体');
    const name = checkRequiredString(body['name'], 'name', 80);
    const customId = checkOptionalString(body['id'], 'id', 80);
    if (customId !== undefined && customId !== '' && !ID_PATTERN.test(customId)) {
      //G 拒绝包含非法字符的清单 ID。
      throw new failureModule.Failure(400, 'id 只能包含字母、数字、下划线、点、冒号或短横线');
    }

    //M 同名清单已存在时做幂等检查：ID 一致（或未指定 ID）直接返回原清单。
    const sameName = this.lists.find((item) => item.name === name);
    if (sameName !== undefined) {
      if (customId !== undefined && customId !== '' && customId !== sameName.id) {
        //G 同名清单却传入冲突 ID 时返回 400。
        throw new failureModule.Failure(400, `清单「${name}」已存在`);
      }
      return {
        revision: this.revision,
        list: cloneList(sameName),
        lists: this.getClonedLists(),
      };
    }

    if (customId !== undefined && customId !== '' && this.lists.some((item) => item.id === customId)) {
      //G 清单 ID 已被其他名称占用时返回 400。
      throw new failureModule.Failure(400, `清单 ID 已存在：${customId}`);
    }

    //M 解析新建清单的 ID、图标、主题色与排序权重。
    let id = generateId('list');
    if (customId !== undefined && customId !== '') {
      id = customId;
    }
    //M 校验可选图标、主题色与排序权重。
    const icon = checkOptionalString(body['icon'], 'icon', 32);
    const color = checkOptionalString(body['color'], 'color', 32);
    let sortOrder = checkSortOrder(body['sortOrder']);
    if (sortOrder === undefined) {
      //M 未传 sortOrder 时默认排在已有清单末尾。
      let maxOrder = -1;
      for (const item of this.lists) {
        if (item.sortOrder !== undefined && item.sortOrder > maxOrder) {
          maxOrder = item.sortOrder;
        }
      }
      sortOrder = maxOrder + 1;
    }

    const created: types.TaskListDef = { id, name, sortOrder };
    if (icon !== undefined && icon !== '') {
      created.icon = icon;
    }
    if (color !== undefined && color !== '') {
      created.color = color;
    }

    //M 按 sortOrder 排好序后写盘。
    const nextLists = sortLists([...this.lists, created]);
    this.saveToDisk(this.revision + 1, this.tasks, nextLists);
    return {
      revision: this.revision,
      list: cloneList(created),
      lists: this.getClonedLists(),
    };
  }

  /** 修改清单属性；若改名则同步更新归属旧清单名任务的 list 字段。 */
  patchList(id: string, rawBody: unknown): {
    revision: number;
    list: types.TaskListDef;
    lists: types.TaskListDef[];
  } {
    const index = this.lists.findIndex((item) => item.id === id);
    if (index < 0) {
      //G 清单不存在返回 404。
      throw new failureModule.Failure(404, `清单不存在：${id}`);
    }
    //G 校验请求体并合并更新字段。
    const body = checksModule.checkRecord(rawBody, '请求体');
    const current = this.lists[index]!;
    const updated = cloneList(current);

    if ('name' in body && body['name'] !== undefined) {
      //G 校验新清单名称并防止与其他清单重名。
      const nextName = checkRequiredString(body['name'], 'name', 80);
      if (this.lists.some((item) => item.id !== id && item.name === nextName)) {
        //G 禁止改名后与其他清单重名。
        throw new failureModule.Failure(400, `清单名称已存在：${nextName}`);
      }
      updated.name = nextName;
    }
    for (const key of ['icon', 'color'] as const) {
      if (!(key in body) || body[key] === undefined) {
        continue;
      }
      //M 空串或 null 清空对应显示属性，非空保留去空白文本。
      let val = '';
      if (body[key] !== null) {
        val = checkOptionalString(body[key], key, 32) ?? '';
      }
      if (val === '') {
        delete updated[key];
      }
      if (val !== '') {
        updated[key] = val;
      }
    }
    if ('sortOrder' in body && body['sortOrder'] !== undefined) {
      //G 校验清单排序权重。
      updated.sortOrder = checkSortOrder(body['sortOrder']);
    }

    //M 若清单名称发生变化，同步把归属旧名称的任务迁到新清单名。
    let nextTasks = this.tasks;
    if (updated.name !== current.name) {
      const now = Date.now();
      nextTasks = this.tasks.map((task) => {
        const belonging = task.list ?? '工作任务';
        if (belonging !== current.name) return task;

        return { ...cloneTask(task), list: updated.name, updatedAt: now };
      });
    }

    const rawNextLists = this.lists.slice();
    rawNextLists[index] = updated;
    //M 重新排序并原子持久化任务与清单。
    const nextLists = sortLists(rawNextLists);
    this.saveToDisk(this.revision + 1, nextTasks, nextLists);
    return {
      revision: this.revision,
      list: cloneList(updated),
      lists: this.getClonedLists(),
    };
  }

  /** 删除自定义清单（禁止删 inbox），并将其下任务的 list 归回收集箱。 */
  removeList(id: string): {
    revision: number;
    lists: types.TaskListDef[];
  } {
    if (id === 'inbox') {
      //G 收集箱是兜底根清单，禁止删除。
      throw new failureModule.Failure(400, '不能删除默认收集箱 inbox');
    }
    //G 查找待删清单是否存在。
    const target = this.lists.find((item) => item.id === id);
    if (target === undefined) {
      //G 清单不存在返回 404。
      throw new failureModule.Failure(404, `清单不存在：${id}`);
    }

    //M 找到收集箱当前名称并把待删清单下任务全部归回收集箱。
    const inboxName = this.lists.find((item) => item.id === 'inbox')?.name ?? '收集箱';
    const now = Date.now();
    const nextTasks = this.tasks.map((task) => {
      const belonging = task.list ?? '工作任务';
      if (belonging !== target.name) return task;

      return { ...cloneTask(task), list: inboxName, updatedAt: now };
    });
    //M 从清单数组中移除目标清单。
    const nextLists = this.lists.filter((item) => item.id !== id);
    //M 原子写盘提交删除与任务归位。
    this.saveToDisk(this.revision + 1, nextTasks, nextLists);
    return {
      revision: this.revision,
      lists: this.getClonedLists(),
    };
  }

  /** 切换习惯任务某天（默认今天本地 YYYY-MM-DD）的打卡状态并按日期排序。 */
  toggleCheckIn(id: string, rawBody: unknown): {
    revision: number;
    task: types.ControlTask;
  } {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      //G 任务不存在返回 404。
      throw new failureModule.Failure(404, `任务不存在：${id}`);
    }
    //G 校验请求体与可选日期（不传默认当天本地 YYYY-MM-DD）。
    const body = checksModule.checkRecord(rawBody ?? {}, '请求体');
    const date = checkCheckinDate(body['date']);

    const current = this.tasks[index]!;
    const dates = new Set<string>(current.checkIns ?? []);
    const existed = dates.has(date);
    if (existed) {
      dates.delete(date);
    }
    if (!existed) {
      dates.add(date);
    }
    //M 切换完成后按 YYYY-MM-DD 升序整理打卡日期列表。
    const nextCheckIns = [...dates].sort();
    const updatedTask: types.ControlTask = {
      ...cloneTask(current),
      checkIns: nextCheckIns,
      updatedAt: Date.now(),
    };

    const nextTasks = this.tasks.slice();
    nextTasks[index] = updatedTask;
    //M 原子落盘并返回最新任务卡。
    this.saveToDisk(this.revision + 1, nextTasks);
    return {
      revision: this.revision,
      task: cloneTask(updatedTask),
    };
  }
}


/** 读取路由参数 :id。 */
function readIdParam(params: unknown, missingMessage: string): string {
  const raw = (params as Record<string, unknown> | null)?.['id'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    //G 缺少路径参数 ID 直接返回 400。
    throw new failureModule.Failure(400, missingMessage);
  }
  return raw.trim();
}


/** GET /api/work-decision/tasks 的查询参数：状态、占坑标签、负责人，加来源 6 维。 */
interface TaskListQuery extends sourceRefModule.SourceRefQuery {
  /** 状态（逗号分隔多个）。 */
  status?: string;
  /** 占坑标签。 */
  lockTag?: string;
  /** 负责人。 */
  owner?: string;
}


/** 解析查询参数 ?status=（支持逗号分隔多状态）。 */
function parseStatusQuery(raw: string | undefined): types.ControlTaskStatus[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  const parts = raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (parts.length === 0) return undefined;

  //G 逐个校验查询参数里的状态枚举值。
  return parts.map((item) => {
    return checksModule.checkAllowedValue(item, types.CONTROL_TASK_STATUSES, 'status');
  });
}


/** HTTP 入口传入的已校验可选唤醒与播报参数。 */
interface TaskNotificationInput {
  /** 可选单向唤醒目标外部助手名。 */
  notifyHelper?: string;
  /** 可选显式指定唤醒机器人名。 */
  notifyBot?: string;
  /** 是否向配置作战室发送一行战报（默认 false）。 */
  broadcast: boolean;
}


/** 入口校验一次可选 notifyHelper、notifyBot 与 broadcast 参数，非法输入返回 400。 */
function parseTaskNotificationInput(rawBody: unknown): TaskNotificationInput {
  //G 入口校验请求体结构，在任务落盘前拦截非法通知参数。
  const body = checksModule.checkRecord(rawBody, '请求体');
  let notifyHelper: string | undefined;
  if ('notifyHelper' in body && body['notifyHelper'] !== undefined) {
    //G 显式传入 notifyHelper 时必须是非空非纯空白字符串。
    notifyHelper = checkRequiredString(body['notifyHelper'], 'notifyHelper', 120);
  }
  let notifyBot: string | undefined;
  if ('notifyBot' in body && body['notifyBot'] !== undefined) {
    //G 显式传入 notifyBot 时必须是非空非纯空白字符串。
    notifyBot = checkRequiredString(body['notifyBot'], 'notifyBot', 120);
  }
  let broadcast = false;
  if ('broadcast' in body && body['broadcast'] !== undefined) {
    //G 显式传入 broadcast 时必须为布尔值。
    broadcast = checksModule.checkFlag(body['broadcast'], 'broadcast');
  }
  return { notifyHelper, notifyBot, broadcast };
}


/** 从 PATCH 写盘后的任务卡提取操作人与进展摘要，供单向唤醒和战报播报复用。 */
function getPatchNotifySummary(
  rawBody: unknown,
  task: types.ControlTask,
): { actor: string; eventText: string } {
  const latest = task.events.at(-1);
  if (latest !== undefined && latest.at === task.updatedAt) {
    return { actor: latest.by, eventText: latest.text };
  }

  //M 读取请求体中的操作人，未追加新时间线事件时回落任务负责人。
  const body = checksModule.checkRecord(rawBody, '请求体');
  const actor = checkOptionalString(body['by'], 'by', 120) || task.owner || 'central';
  return { actor, eventText: '更新任务信息' };
}


/** 任务写盘后按需触发单向唤醒与作战室播报；未传相关参数时返回 undefined。 */
async function maybeDispatchNotifications(
  ctx: cordis.Context | undefined,
  dispatchConfig: notificationsModule.ControlDispatchConfig | undefined,
  noticeOpts: TaskNotificationInput,
  task: types.ControlTask,
  revision: number,
  actor: string,
  eventText: string,
): Promise<types.ControlTaskNotifications | undefined> {
  if (ctx === undefined) return undefined;
  if (noticeOpts.notifyHelper === undefined && !noticeOpts.broadcast) return undefined;

  const config = dispatchConfig ?? { helperBots: new Map<string, string>() };
  //M 投递动作发生在账本落盘之后，单向唤醒或播报失败不回滚、不阻塞写盘结果。
  return notificationsModule.dispatchTaskNotifications(ctx, config, {
    task,
    revision,
    statusLabel: STATUS_LABELS[task.status],
    actor,
    eventText,
    notifyHelper: noticeOpts.notifyHelper,
    notifyBot: noticeOpts.notifyBot,
    broadcast: noticeOpts.broadcast,
  });
}


/** 统一将占坑互斥锁冲突与来源重复转为 HTTP 409 结构化响应。 */
async function runWithLockReply<T>(
  reply: fastify.FastifyReply,
  action: () => T | Promise<T>,
): Promise<T | fastify.FastifyReply> {
  try {
    //M 执行写操作并返回正常载荷。
    return await action();
  } catch (error) {
    //G 捕获占坑互斥锁冲突并回传 409 与冲突持有者清单。
    if (error instanceof LockConflictFailure) {
      return reply.code(409).send({
        ok: false,
        error: error.message,
        conflicts: error.conflicts,
      });
    }
    //G 来源重复：回 409 并带上已有任务 ID。
    if (error instanceof DuplicateSourceFailure) {
      return reply.code(409).send({
        ok: false,
        error: error.message,
        taskId: error.taskId,
      });
    }
    throw error;
  }
}


/**
 * 在 `/api/work-decision` 路由域下挂载控制面任务与滴答视图 REST 接口。
 * @param scope Fastify 路由作用域。
 * @param prefix 路由前缀（`/api/work-decision`）。
 * @param controlStore 控制面与滴答任务持久化存储实例。
 * @param ctx 可选插件上下文，用于触发单向唤醒与作战室战报事件。
 * @param dispatchConfig 可选唤醒与播报配置（broadcast_target、helper_bots、owner_targets）。
 */
export function mountControlPlaneRoutes(
  scope: fastify.FastifyInstance,
  prefix: string,
  controlStore: ControlPlaneStore,
  ctx?: cordis.Context,
  dispatchConfig?: notificationsModule.ControlDispatchConfig,
): void {
  //M 1. 查询任务列表、清单定义、状态计数、活跃占坑锁与可派发队列（可按来源 6 维筛）。
  scope.get<{ Querystring: TaskListQuery }>(
    `${prefix}/tasks`,
    (request) => {
      //G 解析并校验可选 status 过滤串与来源筛选参数（relayId、hasSource 不对回 400）。
      const statuses = parseStatusQuery(request.query.status);
      const lockTag = request.query.lockTag?.trim() || undefined;
      const owner = request.query.owner?.trim() || undefined;
      const source = SOURCE_REFS.parseQuery(request.query);
      //M 读取控制面任务与清单完整快照。
      return controlStore.list({ statuses, lockTag, owner, source });
    },
  );

  //M 2. 创建新任务卡（撞锁时返回 409 及结构化 conflicts），支持可选单向唤醒与作战室播报。
  scope.post<{ Body: unknown }>(`${prefix}/tasks`, (request, reply) => {
    //M 先在入口校验通知参数，再写盘并按需投递通知，撞锁由统一包装转 409。
    return runWithLockReply(reply, async () => {
      //G 入口校验一次可选 notifyHelper、notifyBot 与 broadcast。
      const noticeOpts = parseTaskNotificationInput(request.body);
      //M 写入新任务并返回最新锁信息。
      const created = controlStore.create(request.body);
      const initialEvent = created.task.events[0];
      const actor = initialEvent?.by ?? (created.task.owner || 'central');
      const eventText = initialEvent?.text ?? '创建任务';
      //M 按需向目标中控投递单向唤醒并向作战室播报战报。
      const notifications = await maybeDispatchNotifications(
        ctx,
        dispatchConfig,
        noticeOpts,
        created.task,
        created.revision,
        actor,
        eventText,
      );
      if (notifications !== undefined) return { ok: true, ...created, notifications };

      return { ok: true, ...created };
    });
  });

  //M 2b. 按来源幂等入池（新建直接 running 撞锁回 409），支持可选单向唤醒与作战室播报。
  scope.post<{ Body: unknown }>(`${prefix}/tasks/upsert`, (request, reply) => {
    //M 先在入口校验通知参数，再入池写盘并按需投递通知，撞锁由统一包装转 409。
    return runWithLockReply(reply, async () => {
      //G 入口校验一次可选 notifyHelper、notifyBot 与 broadcast。
      const noticeOpts = parseTaskNotificationInput(request.body);
      //M 新建或命中已有任务。
      const upserted = controlStore.upsertBySource(request.body);
      //M 提取本次的操作人与事件说明用于通知投递。
      const summary = getPatchNotifySummary(request.body, upserted.task);
      //M 按需向目标中控投递单向唤醒并向作战室播报战报。
      const notifications = await maybeDispatchNotifications(
        ctx,
        dispatchConfig,
        noticeOpts,
        upserted.task,
        upserted.revision,
        summary.actor,
        summary.eventText,
      );
      if (notifications !== undefined) return { ok: true, ...upserted, notifications };

      return { ok: true, ...upserted };
    });
  });

  //M 3. 更新任务卡（支持 PATCH 与 PUT，撞锁回 409），支持可选单向唤醒与作战室播报。
  scope.route<{ Params: { id: string }; Body: unknown }>({
    method: ['PATCH', 'PUT'],
    url: `${prefix}/tasks/:id`,
    handler(request, reply) {
      //M 先在入口校验通知参数，再写盘并按需投递通知，撞锁由统一包装转 409。
      return runWithLockReply(reply, async () => {
        //G 读取任务 ID 并局部更新字段。
        const id = readIdParam(request.params, '缺少任务 ID');
        //G 入口校验一次可选 notifyHelper、notifyBot 与 broadcast。
        const noticeOpts = parseTaskNotificationInput(request.body);
        //M 执行局部更新并返回最新任务与占坑锁快照。
        const updated = controlStore.patch(id, request.body);
        //M 提取本次更新的操作人与事件说明用于通知投递。
        const summary = getPatchNotifySummary(request.body, updated.task);
        //M 按需向目标中控投递单向唤醒并向作战室播报战报。
        const notifications = await maybeDispatchNotifications(
          ctx,
          dispatchConfig,
          noticeOpts,
          updated.task,
          updated.revision,
          summary.actor,
          summary.eventText,
        );
        if (notifications !== undefined) return { ok: true, ...updated, notifications };

        return { ok: true, ...updated };
      });
    },
  });

  //M 4. 追加原则更新 / 范围变更 / 心跳事件并自动刷新 lastHeartbeatAt，支持可选单向唤醒与作战室播报。
  scope.post<{ Params: { id: string }; Body: unknown }>(
    `${prefix}/tasks/:id/events`,
    (request, reply) => {
      //M 委托存储层追加事件，进入 running 撞锁由统一包装转 409。
      return runWithLockReply(reply, async () => {
        //G 读取任务 ID 并追加时间线事件。
        const id = readIdParam(request.params, '缺少任务 ID');
        //G 入口校验一次可选 notifyHelper、notifyBot 与 broadcast。
        const noticeOpts = parseTaskNotificationInput(request.body ?? {});
        //M 写入事件并刷新心跳时间。
        const appended = controlStore.appendEvent(id, request.body);
        //M 按需向目标中控投递单向唤醒并向作战室播报战报。
        const notifications = await maybeDispatchNotifications(
          ctx,
          dispatchConfig,
          noticeOpts,
          appended.task,
          appended.revision,
          appended.event.by,
          appended.event.text,
        );
        if (notifications !== undefined) return { ok: true, ...appended, notifications };

        return { ok: true, ...appended };
      });
    },
  );

  //M 5. 硬删除任务卡。
  scope.delete<{ Params: { id: string } }>(`${prefix}/tasks/:id`, (request) => {
    //G 读取任务 ID 并执行删除。
    const id = readIdParam(request.params, '缺少任务 ID');
    //M 从账本中永久删除任务。
    const removed = controlStore.remove(id);
    return { ok: true, ...removed };
  });

  //M 6. 切换习惯打卡日期（默认当天本地 YYYY-MM-DD）。
  scope.post<{ Params: { id: string }; Body: unknown }>(
    `${prefix}/tasks/:id/checkin`,
    (request) => {
      //G 读取任务 ID 并切换目标日期打卡记录。
      const id = readIdParam(request.params, '缺少任务 ID');
      //M 执行打卡切换并返回排序后的最新任务。
      const checked = controlStore.toggleCheckIn(id, request.body);
      return { ok: true, ...checked };
    },
  );

  //M 7. 创建自定义清单（同名幂等返回）。
  scope.post<{ Body: unknown }>(`${prefix}/lists`, (request) => {
    //M 校验并写入新清单定义。
    const created = controlStore.createList(request.body);
    return { ok: true, ...created };
  });

  //M 8. 修改清单并同步更新归属旧名称任务的 list 字段（支持 PATCH 与 PUT）。
  scope.route<{ Params: { id: string }; Body: unknown }>({
    method: ['PATCH', 'PUT'],
    url: `${prefix}/lists/:id`,
    handler(request) {
      //G 读取清单 ID 并修改名称、图标、颜色或排序权重。
      const id = readIdParam(request.params, '缺少清单 ID');
      //M 更新清单并同步迁出改名后归属的任务。
      const updated = controlStore.patchList(id, request.body);
      return { ok: true, ...updated };
    },
  });

  //M 9. 删除清单并将旗下任务归回收集箱（inbox 不可删除）。
  scope.delete<{ Params: { id: string } }>(`${prefix}/lists/:id`, (request) => {
    //G 读取清单 ID 并校验非 inbox 后执行删除。
    const id = readIdParam(request.params, '缺少清单 ID');
    //M 移除清单并把归属任务回收到收集箱。
    const removed = controlStore.removeList(id);
    return { ok: true, ...removed };
  });
}
