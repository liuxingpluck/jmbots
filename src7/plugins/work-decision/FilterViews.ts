/**
 * 自定义动态筛选视图（TaskFilterViewDef）与规则（TaskFilterRule）：
 * 负责外部入参一次规范化校验、磁盘旧数据容错读取、深拷贝排序及原子任务节点规则匹配。
 */
import * as crypto from 'node:crypto';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as types from './Types.ts';


/** TaskFilterRule 允许出现的全部字段键名集合。 */
const ALLOWED_RULE_KEYS: ReadonlySet<string> = new Set([
  'tags',
  'tagMode',
  'lists',
  'statuses',
  'priorities',
  'quadrants',
  'dueScope',
  'sourceChannels',
  'hasSource',
  'keyword',
  'includeDone',
]);

/** 自定义视图 ID 允许的字符集。 */
const VIEW_ID_PATTERN = /^[\w.:-]+$/u;

/** 单条规则里标签或分组的最大个数。 */
const MAX_RULE_ITEMS = 50;

/** 来源渠道筛选最大个数。 */
const MAX_SOURCE_CHANNELS = 24;

/** 枚举筛选最大个数。 */
const MAX_ENUM_ITEMS = 12;

/** 关键词最大长度。 */
const MAX_KEYWORD_CHARS = 200;


/** 生成带 view 前缀的唯一视图 ID。 */
function generateViewId(): string {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `view-${stamp}-${rand}`;
}


/** 校验必填非空短文本并去掉首尾空白。 */
function checkRequiredText(raw: unknown, field: string, maxLen: number): string {
  //G 先校验为非空字符串并去掉首尾空白。
  const trimmed = checksModule.checkNonEmptyText(raw, field).trim();
  if (trimmed === '') {
    throw new failureModule.Failure(400, `${field} 不能为空白`);
  }
  if (trimmed.length > maxLen) {
    throw new failureModule.Failure(400, `${field} 不能超过 ${String(maxLen)} 字`);
  }
  return trimmed;
}


/** 校验可选短文本；未传返回 undefined，传入非字符串或超长抛 400。 */
function checkOptionalText(raw: unknown, field: string, maxLen: number): string | undefined {
  if (raw === undefined) return undefined;

  if (typeof raw !== 'string') {
    throw new failureModule.Failure(400, `${field} 要写成字符串`);
  }
  //M 去掉首尾空白后核对长度上限。
  const trimmed = raw.trim();
  if (trimmed.length > maxLen) {
    throw new failureModule.Failure(400, `${field} 不能超过 ${String(maxLen)} 字`);
  }
  return trimmed;
}


/** 校验并去重清洗规则中的字符串数组字段。 */
function checkTextArray(
  raw: unknown,
  field: string,
  maxItems: number,
  maxItemLen: number,
): string[] {
  //G 必须为数组且长度不超过上限。
  const items = checksModule.checkArray(raw, field);
  if (items.length > maxItems) {
    throw new failureModule.Failure(400, `${field} 最多 ${String(maxItems)} 项`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      throw new failureModule.Failure(400, `${field} 里的每一项都要是字符串`);
    }
    //M 去掉首尾空白后跳过空串与重复项。
    const trimmed = item.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      continue;
    }
    if (trimmed.length > maxItemLen) {
      throw new failureModule.Failure(400, `单个 ${field} 不能超过 ${String(maxItemLen)} 字`);
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}


/** 校验并去重清洗规则中的固定枚举数组字段。 */
function checkEnumArray<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T[] {
  //G 必须为数组且逐项落在允许枚举集合内。
  const items = checksModule.checkArray(raw, field);
  if (items.length > MAX_ENUM_ITEMS) {
    throw new failureModule.Failure(400, `${field} 最多 ${String(MAX_ENUM_ITEMS)} 项`);
  }
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    const val = checksModule.checkAllowedValue(item, allowed, field);
    if (!seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}


/** 在 YYYY-MM-DD 日期字符串基础上增加指定天数并返回 YYYY-MM-DD。 */
function addDaysDateStr(baseStr: string, offsetDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(baseStr.trim());
  if (match === null) return baseStr;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const next = new Date(year, month - 1, day + offsetDays);
  const y = String(next.getFullYear());
  const m = String(next.getMonth() + 1).padStart(2, '0');
  const d = String(next.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}


/** 计算任务的有效四象限（显式 quadrant 优先，否则按优先级映射）。 */
function getEffectiveQuadrant(task: types.ControlTask): types.Quadrant {
  if (task.quadrant === 'q1' || task.quadrant === 'q2') return task.quadrant;
  if (task.quadrant === 'q3' || task.quadrant === 'q4') return task.quadrant;
  if (task.priority === 'P0') return 'q1';
  if (task.priority === 'P1') return 'q2';

  return 'q3';
}


/** 判断单张任务的来源渠道是否命中目标渠道条件（支持 feishu / wechat / workbench 归一）。 */
function matchesSourceChannel(task: types.ControlTask, wanted: string): boolean {
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


/** 判断任务到期日是否落在指定范围（today / next7 / overdue / nodate / all）。 */
function matchesDueScope(
  dueDate: string | null | undefined,
  dueScope: types.TaskDueScope | undefined,
  todayStr: string,
): boolean {
  if (dueScope === undefined || dueScope === 'all') return true;

  const due = dueDate?.trim() ?? '';
  if (dueScope === 'nodate') return due === '';
  if (due === '') return false;
  if (dueScope === 'overdue') return due < todayStr;
  if (dueScope === 'today') return due === todayStr;

  const next7End = addDaysDateStr(todayStr, 7);
  return due >= todayStr && due <= next7End;
}


/** 自定义动态筛选视图校验、克隆排序与规则匹配工具类（无状态，供 ControlPlaneStore 复用）。 */
export class FilterViewHelper {
  /**
   * 入口校验并规范化外部传入的 TaskFilterRule。
   * @param raw 外部请求体中的 rule 对象。
   * @returns 清洗后的纯净规则对象。
   * @throws Failure(400)：非对象、含未知字段或任一维度类型/枚举非法。
   */
  normalizeRule(raw: unknown): types.TaskFilterRule {
    //G 规则必须是一组键值对象，且不允许夹带未知筛选键。
    const record = checksModule.checkRecord(raw, 'rule');
    for (const key of Object.keys(record)) {
      if (!ALLOWED_RULE_KEYS.has(key)) {
        throw new failureModule.Failure(400, `rule 包含不支持的字段：${key}`);
      }
    }

    const rule: types.TaskFilterRule = {};
    if (record['tags'] !== undefined) {
      const tags = checkTextArray(record['tags'], 'rule.tags', MAX_RULE_ITEMS, 60);
      if (tags.length > 0) {
        rule.tags = tags;
      }
    }
    if (record['tagMode'] !== undefined) {
      rule.tagMode = checksModule.checkAllowedValue(
        record['tagMode'],
        types.TAG_MODES,
        'rule.tagMode',
      );
    }
    if (record['lists'] !== undefined) {
      const lists = checkTextArray(record['lists'], 'rule.lists', MAX_RULE_ITEMS, 80);
      if (lists.length > 0) {
        rule.lists = lists;
      }
    }
    if (record['statuses'] !== undefined) {
      const statuses = checkEnumArray(
        record['statuses'],
        types.CONTROL_TASK_STATUSES,
        'rule.statuses',
      );
      if (statuses.length > 0) {
        rule.statuses = statuses;
      }
    }
    if (record['priorities'] !== undefined) {
      const priorities = checkEnumArray(
        record['priorities'],
        types.CONTROL_TASK_PRIORITIES,
        'rule.priorities',
      );
      if (priorities.length > 0) {
        rule.priorities = priorities;
      }
    }
    if (record['quadrants'] !== undefined) {
      const quadrants = checkEnumArray(record['quadrants'], types.QUADRANTS, 'rule.quadrants');
      if (quadrants.length > 0) {
        rule.quadrants = quadrants;
      }
    }
    if (record['dueScope'] !== undefined) {
      rule.dueScope = checksModule.checkAllowedValue(
        record['dueScope'],
        types.DUE_SCOPES,
        'rule.dueScope',
      );
    }
    if (record['sourceChannels'] !== undefined) {
      const channels = checkTextArray(
        record['sourceChannels'],
        'rule.sourceChannels',
        MAX_SOURCE_CHANNELS,
        80,
      );
      if (channels.length > 0) {
        rule.sourceChannels = channels;
      }
    }
    if (record['hasSource'] !== undefined) {
      rule.hasSource = checksModule.checkFlag(record['hasSource'], 'rule.hasSource');
    }
    if (record['keyword'] !== undefined) {
      const kw = checkOptionalText(record['keyword'], 'rule.keyword', MAX_KEYWORD_CHARS);
      if (kw !== undefined && kw !== '') {
        rule.keyword = kw;
      }
    }
    if (record['includeDone'] !== undefined) {
      rule.includeDone = checksModule.checkFlag(record['includeDone'], 'rule.includeDone');
    }
    return rule;
  }

  /** 深拷贝单条筛选规则，隔离数组引用。 */
  cloneRule(rule: types.TaskFilterRule): types.TaskFilterRule {
    const copy: types.TaskFilterRule = { ...rule };
    if (rule.tags !== undefined) {
      copy.tags = [...rule.tags];
    }
    if (rule.lists !== undefined) {
      copy.lists = [...rule.lists];
    }
    if (rule.statuses !== undefined) {
      copy.statuses = [...rule.statuses];
    }
    if (rule.priorities !== undefined) {
      copy.priorities = [...rule.priorities];
    }
    if (rule.quadrants !== undefined) {
      copy.quadrants = [...rule.quadrants];
    }
    if (rule.sourceChannels !== undefined) {
      copy.sourceChannels = [...rule.sourceChannels];
    }
    return copy;
  }

  /** 深拷贝单个自定义动态视图定义。 */
  cloneView(view: types.TaskFilterViewDef): types.TaskFilterViewDef {
    return {
      ...view,
      rule: this.cloneRule(view.rule),
    };
  }

  /** 按 sortOrder 升序排列并返回独立副本数组。 */
  sortViews(views: readonly types.TaskFilterViewDef[]): types.TaskFilterViewDef[] {
    //M 逐项深拷贝后按 sortOrder 升序排列，未设权重排末尾。
    return views.map((item) => this.cloneView(item)).sort((a, b) => {
      const orderA = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
  }

  /** 启动时容错恢复磁盘中的 views 数组；过滤掉损坏条目，不阻断服务启动。 */
  loadDiskViews(rawItems: readonly unknown[]): types.TaskFilterViewDef[] {
    const valid: types.TaskFilterViewDef[] = [];
    for (const item of rawItems) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        continue;
      }
      const rec = item as Record<string, unknown>;
      let id = '';
      if (typeof rec['id'] === 'string') {
        id = rec['id'].trim();
      }
      let name = '';
      if (typeof rec['name'] === 'string') {
        name = rec['name'].trim();
      }
      if (id === '' || name === '' || typeof rec['rule'] !== 'object' || rec['rule'] === null) {
        continue;
      }
      try {
        //M 用宽松提取恢复已知规则键，确保历史持久化视图安全加载。
        const rawRule = rec['rule'] as Record<string, unknown>;
        const knownRule: Record<string, unknown> = {};
        for (const key of Object.keys(rawRule)) {
          if (ALLOWED_RULE_KEYS.has(key)) {
            knownRule[key] = rawRule[key];
          }
        }
        const rule = this.normalizeRule(knownRule);
        const restored: types.TaskFilterViewDef = { id, name, rule };
        if (typeof rec['icon'] === 'string' && rec['icon'].trim() !== '') {
          restored.icon = rec['icon'].trim();
        }
        if (typeof rec['color'] === 'string' && rec['color'].trim() !== '') {
          restored.color = rec['color'].trim();
        }
        if (typeof rec['sortOrder'] === 'number' && Number.isFinite(rec['sortOrder'])) {
          restored.sortOrder = rec['sortOrder'];
        }
        valid.push(restored);
      } catch {
        continue;
      }
    }
    return this.sortViews(valid);
  }

  /**
   * 校验新建自定义视图请求体并生成新条目。
   * @param existing 当前已存在的全部自定义视图。
   * @param rawBody POST /api/work-decision/views 请求体。
   */
  buildCreatedView(
    existing: readonly types.TaskFilterViewDef[],
    rawBody: unknown,
  ): types.TaskFilterViewDef {
    //G 入口校验请求体、必填名称、可选自定义 ID 及必填 rule。
    const body = checksModule.checkRecord(rawBody, '请求体');
    const name = checkRequiredText(body['name'], 'name', 80);
    const customId = checkOptionalText(body['id'], 'id', 80);
    if (customId !== undefined && customId !== '') {
      if (!VIEW_ID_PATTERN.test(customId)) {
        throw new failureModule.Failure(400, 'id 只能包含字母、数字、下划线、点、冒号或短横线');
      }
      if (existing.some((item) => item.id === customId)) {
        throw new failureModule.Failure(400, `动态视图 ID 已存在：${customId}`);
      }
    }
    if (existing.some((item) => item.name === name)) {
      throw new failureModule.Failure(400, `动态视图名称已存在：${name}`);
    }

    //G 校验并规范化绑定的动态筛选规则。
    const rule = this.normalizeRule(body['rule']);
    let id = generateViewId();
    if (customId !== undefined && customId !== '') {
      id = customId;
    }

    const icon = checkOptionalText(body['icon'], 'icon', 32);
    const color = checkOptionalText(body['color'], 'color', 32);
    let sortOrder: number | undefined;
    if (body['sortOrder'] !== undefined) {
      sortOrder = checksModule.checkNumber(body['sortOrder'], 'sortOrder');
    }
    if (sortOrder === undefined) {
      //M 未传 sortOrder 时默认排在当前已有视图末尾。
      let maxOrder = -1;
      for (const item of existing) {
        if (item.sortOrder !== undefined && item.sortOrder > maxOrder) {
          maxOrder = item.sortOrder;
        }
      }
      sortOrder = maxOrder + 1;
    }

    const created: types.TaskFilterViewDef = { id, name, rule, sortOrder };
    if (icon !== undefined && icon !== '') {
      created.icon = icon;
    }
    if (color !== undefined && color !== '') {
      created.color = color;
    }
    return created;
  }

  /**
   * 校验局部更新自定义视图请求体并返回合并后的条目。
   * @param existing 当前已存在的全部自定义视图。
   * @param id 目标视图 ID。
   * @param rawBody PATCH /api/work-decision/views/:id 请求体。
   */
  buildPatchedView(
    existing: readonly types.TaskFilterViewDef[],
    id: string,
    rawBody: unknown,
  ): { index: number; updated: types.TaskFilterViewDef } {
    const index = existing.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new failureModule.Failure(404, `动态视图不存在：${id}`);
    }
    //G 入口校验请求体结构并逐项合并更新字段。
    const body = checksModule.checkRecord(rawBody, '请求体');
    const current = existing[index]!;
    const updated = this.cloneView(current);

    if ('name' in body && body['name'] !== undefined) {
      const nextName = checkRequiredText(body['name'], 'name', 80);
      if (existing.some((item) => item.id !== id && item.name === nextName)) {
        throw new failureModule.Failure(400, `动态视图名称已存在：${nextName}`);
      }
      updated.name = nextName;
    }
    for (const key of ['icon', 'color'] as const) {
      if (!(key in body) || body[key] === undefined) {
        continue;
      }
      let val = '';
      if (body[key] !== null) {
        val = checkOptionalText(body[key], key, 32) ?? '';
      }
      if (val === '') {
        delete updated[key];
      }
      if (val !== '') {
        updated[key] = val;
      }
    }
    if ('sortOrder' in body && body['sortOrder'] !== undefined) {
      updated.sortOrder = checksModule.checkNumber(body['sortOrder'], 'sortOrder');
    }
    if ('rule' in body && body['rule'] !== undefined) {
      //G 更新筛选规则时同样执行完整校验。
      updated.rule = this.normalizeRule(body['rule']);
    }
    return { index, updated };
  }

  /**
   * 纯函数判定一张控制面任务节点是否命中给定 TaskFilterRule。
   * @param task 待判定的任务节点。
   * @param rule 动态筛选条件。
   * @param todayStr 当天本地日期 YYYY-MM-DD。
   */
  matchesRule(
    task: types.ControlTask,
    rule: types.TaskFilterRule,
    todayStr: string,
  ): boolean {
    //G 垃圾桶节点与非普通文档节点（倒数日、习惯）不进入通用任务筛选流。
    if (task.trashedAt !== undefined && task.trashedAt !== null && task.trashedAt > 0) return false;
    if (task.kind === 'countdown' || task.kind === 'habit') return false;

    const explicitDone = rule.statuses?.includes('done') ?? false;
    const allowDone = rule.includeDone === true || explicitDone;
    if (!allowDone && task.status === 'done') return false;

    if (rule.statuses !== undefined && rule.statuses.length > 0) {
      if (!rule.statuses.includes(task.status)) return false;
    }
    if (rule.priorities !== undefined && rule.priorities.length > 0) {
      if (!rule.priorities.includes(task.priority)) return false;
    }
    if (rule.quadrants !== undefined && rule.quadrants.length > 0) {
      const effectiveQuad = getEffectiveQuadrant(task);
      if (!rule.quadrants.includes(effectiveQuad)) return false;
    }
    if (rule.lists !== undefined && rule.lists.length > 0) {
      let listName = '工作任务';
      if (task.list !== undefined && task.list.trim() !== '') {
        listName = task.list.trim();
      }
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
      const hitChannel = rule.sourceChannels.some((ch) => matchesSourceChannel(task, ch));
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
}
