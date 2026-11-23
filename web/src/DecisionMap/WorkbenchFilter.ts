/**
 * 积木AI工作台统一动态筛选纯函数引擎：
 * 内置智能视图、保存的自定义动态视图、分组视图（原清单）与顶部组合筛选条共享同一套规则匹配。
 */
import type * as api from './DecisionMapApi.ts';
import * as utils from './TickUtils.ts';

/** 左侧内置智能视图标识。 */
export type SmartViewKey =
  | 'all'
  | 'today'
  | 'next7'
  | 'pending_decision'
  | 'ai_running'
  | 'inbox';

/** 左侧当前选中的主导航范围。 */
export type WorkbenchScope =
  | { kind: 'smart'; key: SmartViewKey }
  | { kind: 'view'; viewId: string }
  | { kind: 'list'; name: string }
  | { kind: 'completed' }
  | { kind: 'trash' };

/** 内置智能视图静态元数据。 */
export interface SmartViewMeta {
  /** 智能视图键名。 */
  key: SmartViewKey;
  /** 显示标题。 */
  label: string;
  /** 图标。 */
  icon: string;
  /** 等价的底层动态筛选规则。 */
  rule: api.TaskFilterRule;
  /** 计数非零时的高亮色系。 */
  accent?: 'amber' | 'blue';
}

/** 6 个内置智能视图配置（全部本质上都是 TaskFilterRule）。 */
export const SMART_VIEW_DEFS: readonly SmartViewMeta[] = [
  { key: 'all', label: '全部节点', icon: '🗂️', rule: {} },
  { key: 'today', label: '今天', icon: '📅', rule: { dueScope: 'today' } },
  { key: 'next7', label: '最近7天', icon: '🗓️', rule: { dueScope: 'next7' } },
  {
    key: 'pending_decision',
    label: '待我拍板',
    icon: '⏳',
    rule: { statuses: ['pending_decision'] },
    accent: 'amber',
  },
  {
    key: 'ai_running',
    label: 'AI执行中',
    icon: '⚡',
    rule: { statuses: ['running'] },
    accent: 'blue',
  },
  { key: 'inbox', label: '收集箱', icon: '📥', rule: { lists: ['收集箱'] } },
];

/** 新建或编辑自定义动态视图时的可选图标列表。 */
export const VIEW_ICON_CHOICES: readonly string[] = [
  '🔖',
  '🔥',
  '⚡',
  '🎯',
  '⏳',
  '🚀',
  '💎',
  '📡',
  '🧩',
  '📌',
];

/** 新建或编辑自定义动态视图时的可选强调色。 */
export const VIEW_COLOR_CHOICES: readonly string[] = [
  '#4c7ef3',
  '#f59e0b',
  '#ef4444',
  '#10b981',
  '#a855f7',
  '#06b6d4',
];

/** 顶部筛选条可选的状态筛选项。 */
export const FILTER_STATUS_OPTIONS: ReadonlyArray<{
  key: api.ControlTaskStatus;
  label: string;
  short: string;
}> = [
  { key: 'pending_decision', label: '⏳ 待拍板', short: '待拍板' },
  { key: 'ready', label: '🟢 就绪', short: '就绪' },
  { key: 'running', label: '⚡ 执行中', short: '执行中' },
  { key: 'blocked', label: '🚧 阻塞', short: '阻塞' },
  { key: 'done', label: '✅ 已完成', short: '已完成' },
];

/** 顶部筛选条可选的优先级筛选项。 */
export const FILTER_PRIORITY_OPTIONS: readonly api.ControlTaskPriority[] = ['P0', 'P1', 'P2'];

/** 顶部筛选条可选的日期筛选项。 */
export const FILTER_DUE_OPTIONS: ReadonlyArray<{
  key: Exclude<api.TaskDueScope, 'all'>;
  label: string;
}> = [
  { key: 'today', label: '今天' },
  { key: 'next7', label: '最近7天' },
  { key: 'overdue', label: '已过期' },
  { key: 'nodate', label: '无日期' },
];

/** 顶部筛选条可选的来源渠道筛选项。 */
export const FILTER_CHANNEL_OPTIONS: ReadonlyArray<{
  key: string;
  label: string;
}> = [
  { key: 'feishu', label: '飞书' },
  { key: 'wechat', label: '微信' },
  { key: 'workbench', label: '工作台' },
];

/** 判断节点的来源渠道是否命中指定渠道键（兼容 feishu / wechat / workbench 归一）。 */
export function matchesTaskSourceChannel(task: api.ControlTask, wanted: string): boolean {
  const rawChannel = task.sourceRef?.channel.trim() ?? '';
  if (rawChannel !== '' && rawChannel === wanted) return true;

  const lower = rawChannel.toLowerCase();
  const target = wanted.trim().toLowerCase();
  if (target === 'workbench' || target === 'web') {
    return lower === '' || lower === 'web' || lower === 'http' || lower === 'workbench';
  }
  if (target === 'wechat') {
    return lower === 'wechat' || lower.startsWith('wechat-');
  }
  return lower !== '' && lower === target;
}

/** 获取任务来源渠道的简短中文展示名（用于任务行或详情徽标）。 */
export function getSourceChannelBadge(task: api.ControlTask): string | undefined {
  const raw = task.sourceRef?.channel.trim().toLowerCase() ?? '';
  if (raw === '') return undefined;
  if (raw === 'feishu') return '飞书';
  if (raw === 'wechat' || raw.startsWith('wechat-')) return '微信';
  if (raw === 'web' || raw === 'http' || raw === 'workbench') return undefined;

  return task.sourceRef?.channel.trim();
}

/** 判断到期日是否满足 dueScope 条件。 */
function matchesDueScope(
  dueDate: string | null | undefined,
  dueScope: api.TaskDueScope | undefined,
  todayStr: string,
): boolean {
  if (dueScope === undefined || dueScope === 'all') return true;

  const due = dueDate?.trim() ?? '';
  if (dueScope === 'nodate') return due === '';
  if (due === '') return false;
  if (dueScope === 'overdue') return due < todayStr;
  if (dueScope === 'today') return due === todayStr;

  const next7End = utils.addDaysStr(todayStr, 7);
  return due >= todayStr && due <= next7End;
}

/**
 * 统一核心规则匹配纯函数：判定单个原子任务节点是否命中给定 TaskFilterRule。
 * @param task 待检查的任务节点。
 * @param rule 动态筛选条件。
 * @param todayStr 今日日期 YYYY-MM-DD。
 */
export function matchesTaskFilterRule(
  task: api.ControlTask,
  rule: api.TaskFilterRule,
  todayStr: string,
): boolean {
  //G 垃圾桶软删除项与纪念日/习惯不进入通用文档节点筛选结果。
  if (utils.isTaskTrashed(task)) return false;
  if (utils.getTaskKind(task) !== 'task') return false;

  const explicitDone = rule.statuses?.includes('done') ?? false;
  const allowDone = rule.includeDone === true || explicitDone;
  if (!allowDone && utils.isTaskDone(task)) return false;

  if (rule.statuses !== undefined && rule.statuses.length > 0) {
    if (!rule.statuses.includes(task.status)) return false;
  }
  if (rule.priorities !== undefined && rule.priorities.length > 0) {
    if (!rule.priorities.includes(task.priority)) return false;
  }
  if (rule.quadrants !== undefined && rule.quadrants.length > 0) {
    const quad = utils.getEffectiveQuadrant(task);
    if (!rule.quadrants.includes(quad)) return false;
  }
  if (rule.lists !== undefined && rule.lists.length > 0) {
    const listName = utils.getTaskListName(task);
    if (!rule.lists.includes(listName)) return false;
  }
  if (rule.tags !== undefined && rule.tags.length > 0) {
    const taskTags = task.tags ?? [];
    if (rule.tagMode === 'or') {
      const hitAny = rule.tags.some((tag) => taskTags.includes(tag));
      if (!hitAny) return false;
    }
    if (rule.tagMode !== 'or') {
      const hitAll = rule.tags.every((tag) => taskTags.includes(tag));
      if (!hitAll) return false;
    }
  }
  if (!matchesDueScope(task.dueDate, rule.dueScope, todayStr)) return false;

  if (rule.hasSource === true && task.sourceRef === undefined) return false;
  if (rule.hasSource === false && task.sourceRef !== undefined) return false;

  if (rule.sourceChannels !== undefined && rule.sourceChannels.length > 0) {
    const hitChannel = rule.sourceChannels.some((ch) => matchesTaskSourceChannel(task, ch));
    if (!hitChannel) return false;
  }
  if (rule.keyword !== undefined && rule.keyword.trim() !== '') {
    const kw = rule.keyword.trim().toLowerCase();
    const inTitle = task.title.toLowerCase().includes(kw);
    const inSummary = task.summary.toLowerCase().includes(kw);
    const inOwner = task.owner.toLowerCase().includes(kw);
    const inTags = (task.tags ?? []).some((tag) => tag.toLowerCase().includes(kw));
    if (!inTitle && !inSummary && !inOwner && !inTags) return false;
  }
  return true;
}

/** 判断一条 TaskFilterRule 是否包含任意有效过滤条件。 */
export function hasActiveRuleConditions(rule: api.TaskFilterRule): boolean {
  if ((rule.tags?.length ?? 0) > 0) return true;
  if ((rule.lists?.length ?? 0) > 0) return true;
  if ((rule.statuses?.length ?? 0) > 0) return true;
  if ((rule.priorities?.length ?? 0) > 0) return true;
  if ((rule.quadrants?.length ?? 0) > 0) return true;
  if (rule.dueScope !== undefined && rule.dueScope !== 'all') return true;
  if ((rule.sourceChannels?.length ?? 0) > 0) return true;
  if (rule.hasSource !== undefined) return true;
  if (rule.keyword !== undefined && rule.keyword.trim() !== '') return true;
  if (rule.includeDone === true) return true;

  return false;
}

/** 将左侧当前选中的范围映射为底层动态筛选规则（已完成与垃圾桶返回空基准规则）。 */
export function getScopeBaseRule(
  scope: WorkbenchScope,
  views: readonly api.TaskFilterViewDef[],
): api.TaskFilterRule {
  if (scope.kind === 'smart') {
    const found = SMART_VIEW_DEFS.find((item) => item.key === scope.key);
    if (found !== undefined) return { ...found.rule };

    return {};
  }
  if (scope.kind === 'view') {
    const found = views.find((item) => item.id === scope.viewId);
    if (found !== undefined) return { ...found.rule };

    return {};
  }
  if (scope.kind === 'list') {
    return { lists: [scope.name] };
  }
  return {};
}

/** 计算当前左侧范围的展示图标与标题。 */
export function getScopeHeaderMeta(
  scope: WorkbenchScope,
  lists: readonly api.TaskListDef[],
  views: readonly api.TaskFilterViewDef[],
): { icon: string; title: string; color?: string } {
  if (scope.kind === 'completed') return { icon: '☑️', title: '已完成' };
  if (scope.kind === 'trash') return { icon: '🗑️', title: '垃圾桶' };
  if (scope.kind === 'smart') {
    const found = SMART_VIEW_DEFS.find((item) => item.key === scope.key);
    if (found !== undefined) return { icon: found.icon, title: found.label };

    return { icon: '🗂️', title: '全部节点' };
  }
  if (scope.kind === 'view') {
    const found = views.find((item) => item.id === scope.viewId);
    if (found !== undefined) {
      return {
        icon: found.icon ?? '🔖',
        title: found.name,
        color: found.color,
      };
    }
    return { icon: '🔖', title: '动态视图' };
  }
  const foundList = lists.find((item) => item.name === scope.name);
  return { icon: foundList?.icon ?? '📋', title: scope.name, color: foundList?.color };
}

/** 合并两个去重字符串数组。 */
function mergeUniqueStrings(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] | undefined {
  const set = new Set<string>();
  for (const item of first ?? []) {
    if (item.trim() !== '') {
      set.add(item.trim());
    }
  }
  for (const item of second ?? []) {
    if (item.trim() !== '') {
      set.add(item.trim());
    }
  }
  if (set.size === 0) return undefined;

  return [...set];
}

/** 将左侧基准范围规则与顶部临时组合筛选条合并为一条完整可持久化的 TaskFilterRule。 */
export function mergeFilterRules(
  base: api.TaskFilterRule,
  adhoc: api.TaskFilterRule,
): api.TaskFilterRule {
  const merged: api.TaskFilterRule = {};

  const mergedTags = mergeUniqueStrings(base.tags, adhoc.tags);
  if (mergedTags !== undefined) {
    merged.tags = mergedTags;
  }
  const nextTagMode = adhoc.tagMode ?? base.tagMode;
  if (nextTagMode !== undefined) {
    merged.tagMode = nextTagMode;
  }

  let lists = base.lists;
  if (adhoc.lists !== undefined && adhoc.lists.length > 0) {
    lists = adhoc.lists;
  }
  if (lists !== undefined && lists.length > 0) {
    merged.lists = [...lists];
  }

  let statuses = base.statuses;
  if (adhoc.statuses !== undefined && adhoc.statuses.length > 0) {
    statuses = adhoc.statuses;
  }
  if (statuses !== undefined && statuses.length > 0) {
    merged.statuses = [...statuses];
  }

  let priorities = base.priorities;
  if (adhoc.priorities !== undefined && adhoc.priorities.length > 0) {
    priorities = adhoc.priorities;
  }
  if (priorities !== undefined && priorities.length > 0) {
    merged.priorities = [...priorities];
  }

  let quadrants = base.quadrants;
  if (adhoc.quadrants !== undefined && adhoc.quadrants.length > 0) {
    quadrants = adhoc.quadrants;
  }
  if (quadrants !== undefined && quadrants.length > 0) {
    merged.quadrants = [...quadrants];
  }

  let dueScope = base.dueScope;
  if (adhoc.dueScope !== undefined && adhoc.dueScope !== 'all') {
    dueScope = adhoc.dueScope;
  }
  if (dueScope !== undefined && dueScope !== 'all') {
    merged.dueScope = dueScope;
  }

  let channels = base.sourceChannels;
  if (adhoc.sourceChannels !== undefined && adhoc.sourceChannels.length > 0) {
    channels = adhoc.sourceChannels;
  }
  if (channels !== undefined && channels.length > 0) {
    merged.sourceChannels = [...channels];
  }

  const hasSource = adhoc.hasSource ?? base.hasSource;
  if (hasSource !== undefined) {
    merged.hasSource = hasSource;
  }

  let keyword = base.keyword?.trim() ?? '';
  if (adhoc.keyword !== undefined && adhoc.keyword.trim() !== '') {
    keyword = adhoc.keyword.trim();
  }
  if (keyword !== '') {
    merged.keyword = keyword;
  }

  const includeDone = adhoc.includeDone ?? base.includeDone;
  if (includeDone === true) {
    merged.includeDone = true;
  }
  return merged;
}

/** 判断节点是否同时满足左侧基准规则与顶部临时组合规则（支持临时勾选「已完成」状态穿透）。 */
export function matchesCombinedRules(
  task: api.ControlTask,
  base: api.TaskFilterRule,
  adhoc: api.TaskFilterRule,
  todayStr: string,
  forceIncludeDone = false,
): boolean {
  const adhocWantsDone = adhoc.includeDone === true || (adhoc.statuses?.includes('done') ?? false);
  let effectiveBase = base;
  if (forceIncludeDone || adhocWantsDone) {
    effectiveBase = { ...base, includeDone: true };
  }
  let effectiveAdhoc = adhoc;
  if (forceIncludeDone) {
    effectiveAdhoc = { ...adhoc, includeDone: true };
  }
  if (!matchesTaskFilterRule(task, effectiveBase, todayStr)) return false;

  return matchesTaskFilterRule(task, effectiveAdhoc, todayStr);
}

/** 汇总所有未完成普通文档节点的标签频次（按数量降序、名称升序排列）。 */
export function collectTagCounts(
  tasks: readonly api.ControlTask[],
): Array<[string, number]> {
  const byTag = new Map<string, number>();
  for (const item of tasks) {
    if (utils.isTaskTrashed(item) || utils.getTaskKind(item) !== 'task') {
      continue;
    }
    if (utils.isTaskDone(item)) {
      continue;
    }
    for (const tag of item.tags ?? []) {
      const cleaned = tag.trim();
      if (cleaned !== '') {
        byTag.set(cleaned, (byTag.get(cleaned) ?? 0) + 1);
      }
    }
  }
  const entries = Array.from(byTag.entries());
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];

    return a[0].localeCompare(b[0], 'zh-CN');
  });
  return entries;
}

/** 将一条 TaskFilterRule 概括为可读的中文摘要词组列表（供存为视图弹窗与悬停提示展示）。 */
export function describeFilterRule(rule: api.TaskFilterRule): string[] {
  const parts: string[] = [];
  if (rule.tags !== undefined && rule.tags.length > 0) {
    let joiner = ' 且 ';
    if (rule.tagMode === 'or') {
      joiner = ' 或 ';
    }
    parts.push(`标签: ${rule.tags.map((t) => `#${t}`).join(joiner)}`);
  }
  if (rule.lists !== undefined && rule.lists.length > 0) {
    parts.push(`分组: ${rule.lists.join(' / ')}`);
  }
  if (rule.statuses !== undefined && rule.statuses.length > 0) {
    const names = rule.statuses.map((st) => {
      const found = FILTER_STATUS_OPTIONS.find((opt) => opt.key === st);
      return found?.short ?? st;
    });
    parts.push(`状态: ${names.join(' / ')}`);
  }
  if (rule.priorities !== undefined && rule.priorities.length > 0) {
    parts.push(`优先级: ${rule.priorities.join(' / ')}`);
  }
  if (rule.quadrants !== undefined && rule.quadrants.length > 0) {
    parts.push(`象限: ${rule.quadrants.map((q) => utils.QUADRANT_MAP[q].roman).join(' / ')}`);
  }
  if (rule.dueScope !== undefined && rule.dueScope !== 'all') {
    const found = FILTER_DUE_OPTIONS.find((opt) => opt.key === rule.dueScope);
    if (found !== undefined) {
      parts.push(`日期: ${found.label}`);
    }
  }
  if (rule.sourceChannels !== undefined && rule.sourceChannels.length > 0) {
    const names = rule.sourceChannels.map((ch) => {
      const found = FILTER_CHANNEL_OPTIONS.find((opt) => opt.key === ch);
      return found?.label ?? ch;
    });
    parts.push(`来源: ${names.join(' / ')}`);
  }
  if (rule.keyword !== undefined && rule.keyword.trim() !== '') {
    parts.push(`关键词: "${rule.keyword.trim()}"`);
  }
  if (rule.includeDone === true) {
    parts.push('含已完成');
  }
  return parts;
}
