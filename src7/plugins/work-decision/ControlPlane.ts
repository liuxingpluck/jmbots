/**
 * 多 AI 协同控制面任务存储与 HTTP 路由实现。
 * 数据独立持久化在 `<runtime>/control-plane-tasks.json`（走防杀毒容错原子写入），
 * 提供标准多 AI HTTP REST 接口：
 * - GET    /api/work-decision/tasks             列出任务、各状态计数、活跃占坑锁（activeLocks）与可立即派发队列（dispatchableIds）
 * - POST   /api/work-decision/tasks             创建任务卡（running 时检查占坑锁冲突）
 * - PATCH  /api/work-decision/tasks/:id         更新任务状态/优先级/负责人/验收标准/占坑锁（撞锁回 409）
 * - POST   /api/work-decision/tasks/:id/events  追加原则更新/需求变更/心跳事件并自动刷新 lastHeartbeatAt
 * - DELETE /api/work-decision/tasks/:id         删除任务卡
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as fastify from 'fastify';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import * as types from './Types.ts';


/** 磁盘持久化 JSON 结构。 */
interface PersistedControlBoard {
  version: 1;
  revision: number;
  tasks: types.ControlTask[];
}

/** 占坑互斥锁冲突错误（HTTP 409，附带结构化冲突列表）。 */
export class LockConflictFailure extends failureModule.Failure {
  constructor(
    message: string,
    readonly conflicts: types.ControlTaskLockConflict[],
  ) {
    super(409, message);
  }
}

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


/** 生成可读且唯一的任务卡 ID。 */
function generateTaskId(): string {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `ct-${stamp}-${rand}`;
}


/** 校验并清洗占坑标签数组（去首尾空白、去空、保序去重）。 */
function normalizeLockTags(raw: unknown): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new failureModule.Failure(400, 'lockTags 要写成字符串数组');
  }
  if (raw.length > MAX_LOCK_TAGS) {
    throw new failureModule.Failure(400, `lockTags 最多 ${String(MAX_LOCK_TAGS)} 个`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new failureModule.Failure(400, 'lockTags 里的每一项都要是字符串');
    }
    const tag = item.trim();
    if (tag === '' || seen.has(tag)) {
      continue;
    }
    if (tag.length > 80) {
      throw new failureModule.Failure(400, '单个 lockTag 最多 80 字');
    }
    seen.add(tag);
    out.push(tag);
  }
  return out;
}


/** 校验可选文本字段并限制长度。 */
function checkOptionalString(raw: unknown, field: string, maxLen = MAX_TEXT_CHARS): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new failureModule.Failure(400, `${field} 要写成字符串`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > maxLen) {
    throw new failureModule.Failure(400, `${field} 不能超过 ${String(maxLen)} 字`);
  }
  return trimmed;
}


/** 校验必填非空文本字段。 */
function checkRequiredString(raw: unknown, field: string, maxLen = MAX_TEXT_CHARS): string {
  const val = checksModule.checkNonEmptyText(raw, field).trim();
  if (val === '') {
    throw new failureModule.Failure(400, `${field} 不能为空白`);
  }
  if (val.length > maxLen) {
    throw new failureModule.Failure(400, `${field} 不能超过 ${String(maxLen)} 字`);
  }
  return val;
}


/** 深拷贝任务对象，防外部意外篡改内存状态。 */
function cloneTask(task: types.ControlTask): types.ControlTask {
  return {
    ...task,
    lockTags: [...task.lockTags],
    events: task.events.map((ev) => ({ ...ev })),
  };
}


/**
 * 多 AI 控制面任务存储与互斥锁仲裁器。
 */
export class ControlPlaneStore {
  private readonly filePath: string;
  private revision = 0;
  private tasks: types.ControlTask[] = [];

  /**
   * @param runtimeRoot 运行时根目录（即 jmbotsData），任务文件存为 `<runtimeRoot>/control-plane-tasks.json`。
   */
  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, 'control-plane-tasks.json');
    this.loadFromDisk();
  }

  /** 当前控制面任务修订号（每次增删改递增，供 /version 探针感知）。 */
  getRevision(): number {
    return this.revision;
  }

  /** 启动时读取已有 JSON；不存在时初始化为空账本。 */
  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as Partial<PersistedControlBoard>;
      if (typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0) {
        this.revision = parsed.revision;
      }
      if (Array.isArray(parsed.tasks)) {
        this.tasks = parsed.tasks.filter((item): item is types.ControlTask => {
          return typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.title === 'string';
        });
      }
    } catch (error) {
      console.error(`work-decision：读取 control-plane-tasks.json 失败，已按空面板启动：${textModule.getErrorMessage(error)}`);
    }
  }

  /** 原子写盘（开启 fallback 防安全软件拦截 rename），写盘失败时由调用方回滚内存。 */
  private saveToDisk(nextRevision: number, nextTasks: types.ControlTask[]): void {
    const payload: PersistedControlBoard = {
      version: 1,
      revision: nextRevision,
      tasks: nextTasks,
    };
    filesModule.writeTextAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, true);
    this.revision = nextRevision;
    this.tasks = nextTasks;
  }

  /** 计算全局各状态计数、活跃占坑锁与不撞锁的可立即派发 ready 任务 ID 列表。 */
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

    const readyCandidates = sourceTasks.filter((task) => {
      if (task.status !== 'ready') {
        return false;
      }
      return task.lockTags.every((tag) => activeLocks[tag] === undefined);
    });

    readyCandidates.sort((a, b) => {
      const prioDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (prioDiff !== 0) {
        return prioDiff;
      }
      return a.createdAt - b.createdAt;
    });

    return {
      counts,
      activeLocks,
      dispatchableIds: readyCandidates.map((task) => task.id),
    };
  }

  /** 检查目标 lockTags 是否与除 excludeTaskId 以外的其他 running 任务撞坑；冲突时抛 409。 */
  private assertNoLockConflict(lockTags: readonly string[], excludeTaskId?: string): void {
    if (lockTags.length === 0) {
      return;
    }
    const conflicts: types.ControlTaskLockConflict[] = [];
    for (const other of this.tasks) {
      if (other.status !== 'running' || other.id === excludeTaskId) {
        continue;
      }
      for (const tag of lockTags) {
        if (other.lockTags.includes(tag)) {
          conflicts.push({
            lockTag: tag,
            taskId: other.id,
            title: other.title,
            owner: other.owner,
          });
        }
      }
    }
    if (conflicts.length === 0) {
      return;
    }
    const detail = conflicts
      .map((c) => {
        const holder = c.owner !== '' ? c.owner : '未署名节点';
        return `${c.lockTag}（正由 ${holder} 执行「${c.title}」[${c.taskId}] 占用）`;
      })
      .join('；');
    throw new LockConflictFailure(`占坑锁冲突，无法同时进入 running：${detail}`, conflicts);
  }

  /** 查询任务列表，支持按 status（可逗号分隔）与 lockTag、owner 筛选。 */
  list(filter?: {
    statuses?: readonly types.ControlTaskStatus[];
    lockTag?: string;
    owner?: string;
  }): types.ControlTaskListResponse {
    const meta = this.computeBoardMeta();
    let matched = this.tasks;

    if (filter?.statuses !== undefined && filter.statuses.length > 0) {
      const set = new Set(filter.statuses);
      matched = matched.filter((task) => set.has(task.status));
    }
    if (filter?.lockTag !== undefined && filter.lockTag !== '') {
      const tag = filter.lockTag;
      matched = matched.filter((task) => task.lockTags.includes(tag));
    }
    if (filter?.owner !== undefined && filter.owner !== '') {
      const who = filter.owner;
      matched = matched.filter((task) => task.owner === who);
    }

    const sorted = matched.map(cloneTask).sort((a, b) => {
      const stDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (stDiff !== 0) {
        return stDiff;
      }
      const prioDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (prioDiff !== 0) {
        return prioDiff;
      }
      return b.updatedAt - a.updatedAt;
    });

    return {
      ok: true,
      revision: this.revision,
      tasks: sorted,
      ...meta,
    };
  }

  /** 创建一张新的控制面任务卡。 */
  create(rawBody: unknown): {
    task: types.ControlTask;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const body = checksModule.checkRecord(rawBody, '请求体');
    const customId = checkOptionalString(body['id'], 'id', 120);
    if (customId !== undefined && customId !== '') {
      if (!/^[\w.:-]+$/u.test(customId)) {
        throw new failureModule.Failure(400, 'id 只能包含字母、数字、下划线、点、冒号或短横线');
      }
      if (this.tasks.some((item) => item.id === customId)) {
        throw new failureModule.Failure(409, `任务 ID 已存在：${customId}`);
      }
    }
    const id = customId !== undefined && customId !== '' ? customId : generateTaskId();
    const title = checkRequiredString(body['title'], 'title', 200);
    const summary = checkOptionalString(body['summary'], 'summary') ?? '';

    let status: types.ControlTaskStatus = 'pending_decision';
    if (body['status'] !== undefined) {
      status = checksModule.checkAllowedValue(body['status'], types.CONTROL_TASK_STATUSES, 'status');
    }

    let priority: types.ControlTaskPriority = 'P1';
    if (body['priority'] !== undefined) {
      priority = checksModule.checkAllowedValue(body['priority'], types.CONTROL_TASK_PRIORITIES, 'priority');
    }

    const lockTags = normalizeLockTags(body['lockTags']);
    const owner = checkOptionalString(body['owner'], 'owner', 120) ?? '';
    const doneCriteria = checkOptionalString(body['doneCriteria'], 'doneCriteria') ?? '';
    const by = checkOptionalString(body['by'], 'by', 120) || owner || 'central';

    if (status === 'running') {
      this.assertNoLockConflict(lockTags, id);
    }

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
      lastHeartbeatAt: status === 'running' ? now : null,
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

    const nextTasks = [...this.tasks, task];
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      task: cloneTask(task),
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }

  /** 局部修改任务字段、状态或占坑标签（切入 running 或改锁时强检 409 占坑冲突）。 */
  patch(id: string, rawBody: unknown): {
    task: types.ControlTask;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new failureModule.Failure(404, `任务不存在：${id}`);
    }
    const body = checksModule.checkRecord(rawBody, '请求体');
    const current = this.tasks[index]!;

    let nextTitle = current.title;
    if ('title' in body && body['title'] !== undefined) {
      nextTitle = checkRequiredString(body['title'], 'title', 200);
    }

    let nextSummary = current.summary;
    if ('summary' in body && body['summary'] !== undefined) {
      nextSummary = checkOptionalString(body['summary'], 'summary') ?? '';
    }

    let nextStatus = current.status;
    if ('status' in body && body['status'] !== undefined) {
      nextStatus = checksModule.checkAllowedValue(body['status'], types.CONTROL_TASK_STATUSES, 'status');
    }

    let nextPriority = current.priority;
    if ('priority' in body && body['priority'] !== undefined) {
      nextPriority = checksModule.checkAllowedValue(body['priority'], types.CONTROL_TASK_PRIORITIES, 'priority');
    }

    let nextLockTags = current.lockTags;
    if ('lockTags' in body && body['lockTags'] !== undefined) {
      nextLockTags = normalizeLockTags(body['lockTags']);
    }

    let nextOwner = current.owner;
    if ('owner' in body && body['owner'] !== undefined) {
      nextOwner = checkOptionalString(body['owner'], 'owner', 120) ?? '';
    }

    let nextDoneCriteria = current.doneCriteria;
    if ('doneCriteria' in body && body['doneCriteria'] !== undefined) {
      nextDoneCriteria = checkOptionalString(body['doneCriteria'], 'doneCriteria') ?? '';
    }

    //G 只要更新后的状态是 running，必须确保不与任何其他 running 任务抢占同一 lockTag。
    if (nextStatus === 'running') {
      this.assertNoLockConflict(nextLockTags, id);
    }

    const now = Date.now();
    const by = checkOptionalString(body['by'], 'by', 120) || nextOwner || 'central';
    const reason = checkOptionalString(body['reason'], 'reason') ?? '';
    let customEventKind: types.ControlTaskEventKind | undefined;
    if (body['eventKind'] !== undefined) {
      customEventKind = checksModule.checkAllowedValue(body['eventKind'], types.CONTROL_TASK_EVENT_KINDS, 'eventKind');
    }

    const changes: string[] = [];
    if (nextStatus !== current.status) {
      changes.push(`状态 ${STATUS_LABELS[current.status]} → ${STATUS_LABELS[nextStatus]}`);
    }
    if (nextPriority !== current.priority) {
      changes.push(`优先级 ${current.priority} → ${nextPriority}`);
    }
    if (nextOwner !== current.owner) {
      const fromOwner = current.owner || '未认领';
      const toOwner = nextOwner || '未认领';
      changes.push(`负责人 ${fromOwner} → ${toOwner}`);
    }
    if (JSON.stringify(nextLockTags) !== JSON.stringify(current.lockTags)) {
      const joined = nextLockTags.length > 0 ? nextLockTags.join(', ') : '无';
      changes.push(`占坑锁 [${joined}]`);
    }
    if (nextDoneCriteria !== current.doneCriteria) {
      changes.push('更新验收标准');
    }
    if (nextTitle !== current.title) {
      changes.push(`标题改为「${nextTitle}」`);
    }
    if (nextSummary !== current.summary) {
      changes.push('更新任务摘要');
    }

    let nextHeartbeat = current.lastHeartbeatAt;
    const touchHeartbeat = body['heartbeat'] === true
      || (nextStatus === 'running' && current.status !== 'running')
      || (nextStatus === 'running' && nextOwner !== current.owner);
    if (touchHeartbeat) {
      nextHeartbeat = now;
    }

    const nextEvents = current.events.map((ev) => ({ ...ev }));
    if (changes.length > 0 || reason !== '' || body['heartbeat'] === true) {
      let kind: types.ControlTaskEventKind = customEventKind ?? 'scope_change';
      if (customEventKind === undefined) {
        if (nextStatus === 'cancelled' && current.status !== 'cancelled') {
          kind = 'cancelled';
        } else if (nextStatus !== current.status) {
          kind = 'status';
        } else if (body['heartbeat'] === true && changes.length === 0) {
          kind = 'heartbeat';
        }
      }

      let eventText = changes.join('；');
      if (reason !== '') {
        if (eventText !== '') {
          eventText = `${eventText}（${reason}）`;
        } else {
          eventText = reason;
        }
      }
      if (eventText === '') {
        eventText = '上报心跳';
      }
      nextEvents.push({ at: now, by, kind, text: eventText });
      if (nextEvents.length > MAX_EVENTS_PER_TASK) {
        nextEvents.splice(0, nextEvents.length - MAX_EVENTS_PER_TASK);
      }
    }

    const updatedTask: types.ControlTask = {
      ...current,
      title: nextTitle,
      summary: nextSummary,
      status: nextStatus,
      priority: nextPriority,
      lockTags: nextLockTags,
      owner: nextOwner,
      doneCriteria: nextDoneCriteria,
      lastHeartbeatAt: nextHeartbeat,
      events: nextEvents,
      updatedAt: now,
    };

    const nextTasks = this.tasks.slice();
    nextTasks[index] = updatedTask;
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      task: cloneTask(updatedTask),
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }

  /** 追加一条原则更新 / 范围变更 / 心跳 / 备注事件，并自动刷新 lastHeartbeatAt。 */
  appendEvent(id: string, rawBody: unknown): {
    task: types.ControlTask;
    event: types.ControlTaskEvent;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new failureModule.Failure(404, `任务不存在：${id}`);
    }
    const body = checksModule.checkRecord(rawBody ?? {}, '请求体');
    const current = this.tasks[index]!;

    let kind: types.ControlTaskEventKind = 'note';
    if (body['kind'] !== undefined) {
      kind = checksModule.checkAllowedValue(body['kind'], types.CONTROL_TASK_EVENT_KINDS, 'kind');
    }

    let nextStatus = current.status;
    if (body['status'] !== undefined) {
      nextStatus = checksModule.checkAllowedValue(body['status'], types.CONTROL_TASK_STATUSES, 'status');
      if (nextStatus === 'running') {
        this.assertNoLockConflict(current.lockTags, id);
      }
    } else if (kind === 'cancelled') {
      nextStatus = 'cancelled';
    }

    const by = checkOptionalString(body['by'], 'by', 120) || current.owner || 'ai';
    let text = checkOptionalString(body['text'], 'text') ?? '';
    if (text === '') {
      if (kind === 'heartbeat') {
        text = '进度心跳正常';
      } else {
        throw new failureModule.Failure(400, 'text 要写成非空字符串');
      }
    }

    const now = Date.now();
    const event: types.ControlTaskEvent = { at: now, by, kind, text };
    const nextEvents = [...current.events.map((ev) => ({ ...ev })), event];
    if (nextEvents.length > MAX_EVENTS_PER_TASK) {
      nextEvents.splice(0, nextEvents.length - MAX_EVENTS_PER_TASK);
    }

    const updatedTask: types.ControlTask = {
      ...current,
      status: nextStatus,
      lastHeartbeatAt: now,
      events: nextEvents,
      updatedAt: now,
    };

    const nextTasks = this.tasks.slice();
    nextTasks[index] = updatedTask;
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      task: cloneTask(updatedTask),
      event,
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }

  /** 删除一张控制面任务卡。 */
  remove(id: string): {
    deleted: string;
    activeLocks: Record<string, types.ActiveLockHolder>;
    dispatchableIds: string[];
  } {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new failureModule.Failure(404, `任务不存在：${id}`);
    }
    const nextTasks = this.tasks.filter((item) => item.id !== id);
    this.saveToDisk(this.revision + 1, nextTasks);
    const meta = this.computeBoardMeta();
    return {
      deleted: id,
      activeLocks: meta.activeLocks,
      dispatchableIds: meta.dispatchableIds,
    };
  }
}


/** 读取路由参数 :id。 */
function readTaskIdParam(params: unknown): string {
  const raw = (params as Record<string, unknown> | null)?.['id'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new failureModule.Failure(400, '缺少任务 ID');
  }
  return raw.trim();
}


/** 解析查询参数 ?status=（支持逗号分隔多状态）。 */
function parseStatusQuery(raw: string | undefined): types.ControlTaskStatus[] | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parts = raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (parts.length === 0) {
    return undefined;
  }
  return parts.map((item) => checksModule.checkAllowedValue(item, types.CONTROL_TASK_STATUSES, 'status'));
}


/**
 * 在 `/api/work-decision` 路由域下挂载多 AI 协同控制面任务 REST 接口。
 */
export function mountControlPlaneRoutes(
  scope: fastify.FastifyInstance,
  prefix: string,
  controlStore: ControlPlaneStore,
): void {
  //M 1. 查询任务面板、活跃占坑锁与可派发队列。
  scope.get<{ Querystring: { status?: string; lockTag?: string; owner?: string } }>(
    `${prefix}/tasks`,
    (request) => {
      const statuses = parseStatusQuery(request.query.status);
      const lockTag = request.query.lockTag?.trim() || undefined;
      const owner = request.query.owner?.trim() || undefined;
      return controlStore.list({ statuses, lockTag, owner });
    },
  );

  //M 2. 创建新任务卡（撞锁时返回 409 及结构化 conflicts）。
  scope.post<{ Body: unknown }>(`${prefix}/tasks`, (request, reply) => {
    try {
      const created = controlStore.create(request.body);
      return { ok: true, ...created };
    } catch (error) {
      if (error instanceof LockConflictFailure) {
        return reply.code(409).send({
          ok: false,
          error: error.message,
          conflicts: error.conflicts,
        });
      }
      throw error;
    }
  });

  //M 3. 更新任务卡（支持 PATCH 与 PUT，撞锁回 409）。
  scope.route<{ Params: { id: string }; Body: unknown }>({
    method: ['PATCH', 'PUT'],
    url: `${prefix}/tasks/:id`,
    handler(request, reply) {
      try {
        const id = readTaskIdParam(request.params);
        const updated = controlStore.patch(id, request.body);
        return { ok: true, ...updated };
      } catch (error) {
        if (error instanceof LockConflictFailure) {
          return reply.code(409).send({
            ok: false,
            error: error.message,
            conflicts: error.conflicts,
          });
        }
        throw error;
      }
    },
  });

  //M 4. 追加原则更新 / 范围变更 / 心跳事件并自动刷新 lastHeartbeatAt。
  scope.post<{ Params: { id: string }; Body: unknown }>(
    `${prefix}/tasks/:id/events`,
    (request, reply) => {
      try {
        const id = readTaskIdParam(request.params);
        const appended = controlStore.appendEvent(id, request.body);
        return { ok: true, ...appended };
      } catch (error) {
        if (error instanceof LockConflictFailure) {
          return reply.code(409).send({
            ok: false,
            error: error.message,
            conflicts: error.conflicts,
          });
        }
        throw error;
      }
    },
  );

  //M 5. 删除任务卡。
  scope.delete<{ Params: { id: string } }>(`${prefix}/tasks/:id`, (request) => {
    const id = readTaskIdParam(request.params);
    const removed = controlStore.remove(id);
    return { ok: true, ...removed };
  });
}
