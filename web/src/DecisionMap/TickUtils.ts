/** 滴答清单多视图工作台共享工具函数与元数据定义（日期、象限、树构建、排序与解析）。 */
import type * as api from './DecisionMapApi.ts';

/** 滴答左侧导航主模式：清单 / 日历 / 四象限 / 倒数纪念日 / 习惯。 */
export type TickNavMode = 'list' | 'calendar' | 'quadrant' | 'countdown' | 'habit';

/** 清单视图排序方式。 */
export type TickSortMode = 'default' | 'priority' | 'dueDate';

/** 四象限静态视觉元数据。 */
export interface QuadrantMeta {
  /** 象限编码。 */
  key: api.TickQuadrant;
  /** 罗马数字编号。 */
  roman: string;
  /** 中文名称。 */
  label: string;
  /** 对应默认控制面优先级。 */
  defaultPriority: api.ControlTaskPriority;
  /** 主题强调色。 */
  color: string;
}

/** 四个象限的完整配置，按 2x2 展示顺序排列。 */
export const QUADRANT_LIST: readonly QuadrantMeta[] = [
  { key: 'q1', roman: 'I', label: '重要且紧急', defaultPriority: 'P0', color: '#ef4444' },
  { key: 'q2', roman: 'II', label: '重要不紧急', defaultPriority: 'P1', color: '#f59e0b' },
  { key: 'q3', roman: 'III', label: '不重要但紧急', defaultPriority: 'P2', color: '#3b82f6' },
  { key: 'q4', roman: 'IV', label: '不重要不紧急', defaultPriority: 'P2', color: '#10b981' },
];

/** 四象限按编码快速查找表。 */
export const QUADRANT_MAP: Readonly<Record<api.TickQuadrant, QuadrantMeta>> = {
  q1: QUADRANT_LIST[0]!,
  q2: QUADRANT_LIST[1]!,
  q3: QUADRANT_LIST[2]!,
  q4: QUADRANT_LIST[3]!,
};

/** 后端未返回 lists 时的默认清单兜底列表。 */
export const DEFAULT_LISTS: readonly api.TaskListDef[] = [
  { id: 'list-work', name: '工作任务', icon: '💼', color: '#3b82f6', sortOrder: 1 },
  { id: 'list-personal', name: '个人备忘', icon: '📝', color: '#10b981', sortOrder: 2 },
  { id: 'list-study', name: '学习安排', icon: '📘', color: '#f59e0b', sortOrder: 3 },
];

/** 不可删除的内置系统清单名集合。 */
export const SYSTEM_LIST_NAMES: ReadonlySet<string> = new Set(['收集箱', '工作任务']);

/** 新建清单可选图标集合。 */
export const LIST_ICON_CHOICES: readonly string[] = ['💼', '📝', '📘', '🎯', '🚀', '💡', '🛒', '🏃'];

/** 新建纪念日可选图标集合。 */
export const COUNTDOWN_ICON_CHOICES: readonly string[] = ['⏳', '🧧', '🎉', '🎂', '🚀', '✈️', '💍', '⭐'];

/** 新建习惯可选图标集合。 */
export const HABIT_ICON_CHOICES: readonly string[] = ['🔥', '🏃', '📖', '💧', '🧘', '💪', '✍️', '🌙'];

/** AI 控制面任务状态简短中文映射。 */
export const AI_STATUS_META: Readonly<Record<api.ControlTaskStatus, { label: string; short: string }>> = {
  pending_decision: { label: '⏳ 待拍板', short: 'AI·待拍板' },
  ready: { label: '🟢 可直接干', short: 'AI·待派发' },
  running: { label: '⚡ 执行中', short: 'AI·执行中' },
  blocked: { label: '🚧 阻塞', short: 'AI·阻塞' },
  done: { label: '✅ 已验收', short: '已完成' },
  cancelled: { label: '🚫 已取消', short: '已取消' },
};

/** 周一至周日简写（按 Date.getDay 索引 0=周日）。 */
const WEEKDAY_NAMES: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 数字补两位零。 */
function pad2(num: number): string {
  if (num < 10) return `0${String(num)}`;

  return String(num);
}

/** 把 Date 格式化为本地 YYYY-MM-DD 字符串。 */
export function formatDateStr(date: Date): string {
  const year = String(date.getFullYear());
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

/** 获取本地今天的 YYYY-MM-DD 字符串。 */
export function getTodayStr(): string {
  return formatDateStr(new Date());
}

/** 把 YYYY-MM-DD 解析为本地零点 Date；非法格式返回 undefined。 */
export function parseDateStr(raw: string | null | undefined): Date | undefined {
  if (raw === undefined || raw === null) return undefined;

  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return undefined;

  return parsed;
}

/** 在指定 YYYY-MM-DD 基础上增减若干天，返回新 YYYY-MM-DD。 */
export function addDaysStr(baseStr: string, offsetDays: number): string {
  const base = parseDateStr(baseStr) ?? new Date();
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  return formatDateStr(next);
}

/** 计算两个 YYYY-MM-DD 相差天数（target - base）。 */
export function diffDays(baseStr: string, targetStr: string): number {
  const base = parseDateStr(baseStr);
  const target = parseDateStr(targetStr);
  if (base === undefined || target === undefined) return 0;

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - base.getTime()) / msPerDay);
}

/** 格式化短日期标签（今天 / 明天 / 昨天 / M月D日）。 */
export function formatShortDate(dateStr: string, todayStr: string): string {
  const diff = diffDays(todayStr, dateStr);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';

  const parsed = parseDateStr(dateStr);
  if (parsed === undefined) return dateStr;

  const month = String(parsed.getMonth() + 1);
  const day = String(parsed.getDate());
  return `${month}月${day}日`;
}

/** 格式化完整中文日期（YYYY年M月D日）。 */
export function formatFullDateZh(dateStr: string): string {
  const parsed = parseDateStr(dateStr);
  if (parsed === undefined) return dateStr;

  const year = String(parsed.getFullYear());
  const month = String(parsed.getMonth() + 1);
  const day = String(parsed.getDate());
  return `${year}年${month}月${day}日`;
}

/** 格式化简短时间戳（用于 AI 事件时间线）。 */
export function formatEventTime(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 近 N 天的日期单元格信息（供习惯周历使用）。 */
export interface RecentDayCell {
  /** YYYY-MM-DD 日期键。 */
  dateStr: string;
  /** 星期名（周日..周六）。 */
  weekday: string;
  /** 日期数字。 */
  dayNum: number;
  /** 是否为今天。 */
  isToday: boolean;
}

/** 生成截至今天的连续 N 天日期列表（从旧到新）。 */
export function getRecentDays(todayStr: string, count: number): RecentDayCell[] {
  const cells: RecentDayCell[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const dateStr = addDaysStr(todayStr, -i);
    const parsed = parseDateStr(dateStr) ?? new Date();
    const weekday = WEEKDAY_NAMES[parsed.getDay()] ?? '';
    cells.push({
      dateStr,
      weekday,
      dayNum: parsed.getDate(),
      isToday: i === 0,
    });
  }
  return cells;
}

/** 月视图日历单元格。 */
export interface CalendarDayCell {
  /** YYYY-MM-DD 日期键。 */
  dateStr: string;
  /** 当日号数。 */
  dayNum: number;
  /** 月份（1-12）。 */
  monthNum: number;
  /** 是否属于当前展示月份。 */
  inMonth: boolean;
  /** 是否今天。 */
  isToday: boolean;
}

/** 生成指定年月的 42 格（6 行 x 7 列，周日起）月历网格。 */
export function getMonthGrid(year: number, monthIndex: number, todayStr: string): CalendarDayCell[] {
  const firstDay = new Date(year, monthIndex, 1);
  const startOffset = firstDay.getDay();
  const gridStart = new Date(year, monthIndex, 1 - startOffset);
  const cells: CalendarDayCell[] = [];
  for (let idx = 0; idx < 42; idx += 1) {
    const cur = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + idx);
    const dateStr = formatDateStr(cur);
    cells.push({
      dateStr,
      dayNum: cur.getDate(),
      monthNum: cur.getMonth() + 1,
      inMonth: cur.getMonth() === monthIndex,
      isToday: dateStr === todayStr,
    });
  }
  return cells;
}

/** 获取任务实体类型，缺省为普通任务 task。 */
export function getTaskKind(task: api.ControlTask): api.TickTaskKind {
  if (task.kind === 'countdown' || task.kind === 'habit') return task.kind;

  return 'task';
}

/** 获取任务所属清单名称，缺省为「工作任务」。 */
export function getTaskListName(task: api.ControlTask): string {
  if (task.list !== undefined && task.list.trim() !== '') return task.list.trim();

  return '工作任务';
}

/** 判断任务是否已移入垃圾桶。 */
export function isTaskTrashed(task: api.ControlTask): boolean {
  return task.trashedAt !== undefined && task.trashedAt !== null && task.trashedAt > 0;
}

/** 判断任务是否已完成。 */
export function isTaskDone(task: api.ControlTask): boolean {
  return task.status === 'done';
}

/** 判断是否为在 AI 控制面可见的正常任务（排除倒数日、习惯与垃圾桶）。 */
export function isControlPlaneTask(task: api.ControlTask): boolean {
  if (isTaskTrashed(task)) return false;

  const kind = getTaskKind(task);
  if (kind === 'countdown' || kind === 'habit') return false;

  return true;
}

/** 获取任务展示用的有效四象限（显式 quadrant 优先，否则按 P0/P1/P2 映射）。 */
export function getEffectiveQuadrant(task: api.ControlTask): api.TickQuadrant {
  if (task.quadrant === 'q1' || task.quadrant === 'q2') return task.quadrant;
  if (task.quadrant === 'q3' || task.quadrant === 'q4') return task.quadrant;
  if (task.priority === 'P0') return 'q1';
  if (task.priority === 'P1') return 'q2';

  return 'q3';
}

/** 根据四象限推导建议的控制面优先级。 */
export function getPriorityForQuadrant(quadrant: api.TickQuadrant): api.ControlTaskPriority {
  return QUADRANT_MAP[quadrant].defaultPriority;
}

/** 判断任务是否带有 AI 控制面协同特征（需展示 AI 小徽章）。 */
export function getAiTaskBadge(task: api.ControlTask): { text: string; status: api.ControlTaskStatus } | undefined {
  if (task.status === 'running') return { text: 'AI·执行中', status: 'running' };
  if (task.status === 'blocked') return { text: 'AI·阻塞', status: 'blocked' };
  if (task.status === 'pending_decision') return { text: 'AI·待拍板', status: 'pending_decision' };

  const hasOwner = task.owner.trim() !== '';
  const hasLocks = task.lockTags.length > 0;
  if (task.status === 'ready' && (hasOwner || hasLocks)) {
    return { text: 'AI·待派发', status: 'ready' };
  }
  return undefined;
}

/** 把快速输入里的 #标签 提取出来，返回清理后的纯标题与标签数组。 */
export function parseQuickTaskInput(raw: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const seen = new Set<string>();
  const cleaned = raw.replace(/#([^\s#]+)/gu, (_full, name: string) => {
    const trimmed = name.trim();
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
    return '';
  });
  const title = cleaned.replace(/\s+/gu, ' ').trim();
  return { title, tags };
}

/** 合并后端 lists、兜底默认清单以及任务中出现过的自定义清单名。 */
export function resolveVisibleLists(
  backendLists: readonly api.TaskListDef[] | undefined,
  tasks: readonly api.ControlTask[],
): api.TaskListDef[] {
  let base: api.TaskListDef[] = [...DEFAULT_LISTS];
  if (backendLists !== undefined && backendLists.length > 0) {
    base = [...backendLists];
  }
  const byName = new Map<string, api.TaskListDef>();
  for (const item of base) {
    if (item.name === '收集箱') {
      continue;
    }
    byName.set(item.name, item);
  }
  for (const task of tasks) {
    if (getTaskKind(task) !== 'task' || isTaskTrashed(task)) {
      continue;
    }
    const listName = getTaskListName(task);
    if (listName === '收集箱' || byName.has(listName)) {
      continue;
    }
    byName.set(listName, {
      id: `virtual-${listName}`,
      name: listName,
      icon: '📋',
      sortOrder: 99,
    });
  }
  const merged = Array.from(byName.values());
  merged.sort((a, b) => (a.sortOrder ?? 50) - (b.sortOrder ?? 50));
  return merged;
}

/** 排序比较：支持默认 / 优先级 / 到期日。 */
export function sortTaskList(
  tasks: readonly api.ControlTask[],
  mode: TickSortMode,
): api.ControlTask[] {
  const copied = [...tasks];
  const qRank: Record<api.TickQuadrant, number> = { q1: 0, q2: 1, q3: 2, q4: 3 };
  copied.sort((a, b) => {
    if (mode === 'priority') {
      const qa = qRank[getEffectiveQuadrant(a)];
      const qb = qRank[getEffectiveQuadrant(b)];
      if (qa !== qb) return qa - qb;
    }
    if (mode === 'dueDate') {
      const da = a.dueDate ?? '9999-12-31';
      const db = b.dueDate ?? '9999-12-31';
      if (da !== db) return da.localeCompare(db);
    }
    const sa = a.sortOrder ?? 0;
    const sb = b.sortOrder ?? 0;
    if (sa !== sb) return sa - sb;

    return b.createdAt - a.createdAt;
  });
  return copied;
}

/** 展平后的父子任务树节点。 */
export interface TaskTreeRow {
  /** 任务对象。 */
  task: api.ControlTask;
  /** 缩进深度（顶层为 0）。 */
  depth: number;
  /** 子任务总数量。 */
  childCount: number;
  /** 当前是否处于折叠状态。 */
  collapsed: boolean;
}

/** 按 parentId 构建带循环守卫的展平父子任务树，供多级列表与四象限渲染。 */
export function buildTaskTreeRows(
  tasks: readonly api.ControlTask[],
  collapsedIds: ReadonlySet<string>,
  sortMode: TickSortMode,
): TaskTreeRow[] {
  const idSet = new Set(tasks.map((item) => item.id));
  const childrenMap = new Map<string, api.ControlTask[]>();
  const roots: api.ControlTask[] = [];

  for (const item of tasks) {
    const pid = item.parentId ?? null;
    if (pid !== null && pid !== item.id && idSet.has(pid)) {
      const bucket = childrenMap.get(pid) ?? [];
      bucket.push(item);
      childrenMap.set(pid, bucket);
      continue;
    }
    roots.push(item);
  }

  const rows: TaskTreeRow[] = [];
  const visited = new Set<string>();

  const walk = (nodes: api.ControlTask[], depth: number): void => {
    const sorted = sortTaskList(nodes, sortMode);
    for (const node of sorted) {
      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);
      const kids = childrenMap.get(node.id) ?? [];
      const collapsed = collapsedIds.has(node.id);
      rows.push({
        task: node,
        depth,
        childCount: kids.length,
        collapsed,
      });
      if (kids.length > 0 && !collapsed) {
        walk(kids, depth + 1);
      }
    }
  };

  walk(roots, 0);

  //G 若数据中存在孤立环路节点，保底追加到末尾防止任务凭空消失。
  for (const item of tasks) {
    if (!visited.has(item.id)) {
      visited.add(item.id);
      rows.push({ task: item, depth: 0, childCount: 0, collapsed: false });
    }
  }
  return rows;
}

/** 计算习惯的连续打卡天数（截至今天或昨天）。 */
export function getHabitStreak(checkIns: readonly string[] | undefined, todayStr: string): number {
  if (checkIns === undefined || checkIns.length === 0) return 0;

  const set = new Set(checkIns);
  let cursor = todayStr;
  if (!set.has(cursor)) {
    cursor = addDaysStr(todayStr, -1);
  }
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDaysStr(cursor, -1);
  }
  return streak;
}

/** 格式化错误对象为可读文本。 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}
