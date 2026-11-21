/** 四象限（Eisenhower Matrix）定义与存量节点的默认自动归类规则。 */
import type * as types from '../../../src7/plugins/work-decision/Types.ts';

/** 单个象限的展示元数据。 */
export interface QuadrantSpec {
  /** 象限键值：q1~q4。 */
  key: types.DecisionQuadrant;
  /** 短编号标签：Q1~Q4。 */
  code: string;
  /** 完整象限名。 */
  title: string;
  /** 侧栏胶囊短名称。 */
  shortLabel: string;
  /** 一句话行动指引。 */
  subtitle: string;
}

/** 固定顺序的四个艾森豪威尔象限配置。 */
export const QUADRANT_SPECS: readonly QuadrantSpec[] = [
  {
    key: 'q1',
    code: 'Q1',
    title: '重要且紧急',
    shortLabel: '重要紧急',
    subtitle: '立刻拍板 · 核心阻塞',
  },
  {
    key: 'q2',
    code: 'Q2',
    title: '重要不紧急',
    shortLabel: '重要不急',
    subtitle: '战略主线 · 稳步推进',
  },
  {
    key: 'q3',
    code: 'Q3',
    title: '紧急不重要',
    shortLabel: '紧急不重',
    subtitle: '顺手速决 · 近期配合',
  },
  {
    key: 'q4',
    code: 'Q4',
    title: '不紧急不重要',
    shortLabel: '低优收尾',
    subtitle: '低优备忘 · 已定收尾',
  },
];

/** 四象限筛选范围：默认未完结（过滤掉已定与已做完的历史噪音），可切仅待拍板或含已完结。 */
export type QuadrantScopeFilter = 'active' | 'pending' | 'all';

/** 归入某个象限的单条卡片数据。 */
export interface QuadrantEntry {
  /** 节点本体。 */
  node: types.DecisionNode;
  /** 最终所属象限（手动优先，否则走自动规则）。 */
  quadrant: types.DecisionQuadrant;
  /** 是否为用户或中控显式指定的手动象限。 */
  isManual: boolean;
  /** 所属顶层专题名称（项目直属时为空串）。 */
  topicTitle: string;
  /** 所属顶层专题编号。 */
  topicId: string;
  /** 是否为待主人点选的开放待定项。 */
  isPendingOpen: boolean;
  /** 是否已完结（已定、做完或已放下）。 */
  isClosed: boolean;
}

const HIGH_IMPACT_RE = /(?:P0|隐患|直连|开工|第一单|住宅\s*IP|架构|底座|知识库|A\+A\+A|主线|安全|回退)/iu;
const TRIVIAL_CLEANUP_RE = /(?:删掉废弃|表情包|精简成三行|外网隧道|占位消息)/u;
const TIME_URGENT_RE = /(?:P0|真验|提醒|到家在场|24\s*小时|下次重启|立刻|(?<!不)紧急)/iu;
const LOW_BACKGROUND_RE = /(?:表情包|介绍用法|等周周定|累计步数|getRowName)/iu;

/** 判断节点或其祖先链上是否带有 main 主线标记。 */
function hasMainInChain(node: types.DecisionNode, byId?: ReadonlyMap<string, types.DecisionNode>): boolean {
  if (node.main === true) return true;
  if (byId === undefined) return false;

  let current = byId.get(node.parent ?? '');
  const seen = new Set<string>();
  while (current !== undefined && current.parent !== null) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    if (current.main === true) return true;
    current = byId.get(current.parent);
  }
  return false;
}

/** 判断节点是否属于已定或已结束状态。 */
export function isClosedDecisionNode(node: types.DecisionNode): boolean {
  if (node.status === 'done' || node.status === 'dropped') return true;
  if (node.status === 'decided' || node.kind === 'decided') return true;

  return false;
}

/**
 * 计算节点的四象限归属：已存手动字段 `node.quadrant` 绝对优先；未设置时按状态、主线和关键词干净归类。
 * @param node 目标节点。
 * @param byId 可选节点字典，用于向父链追溯主线标记。
 * @returns q1~q4 象限键。
 */
export function resolveNodeQuadrant(
  node: types.DecisionNode,
  byId?: ReadonlyMap<string, types.DecisionNode>,
): types.DecisionQuadrant {
  if (node.quadrant !== undefined) return node.quadrant;
  if (isClosedDecisionNode(node)) return 'q4';

  const text = `${node.title}\n${node.summary}`;
  const hasMain = hasMainInChain(node, byId);
  const isTrivial = TRIVIAL_CLEANUP_RE.test(text);
  const isImportant = hasMain || node.kind === 'feature' || node.status === 'working' || HIGH_IMPACT_RE.test(text);
  const isTimeUrgent = TIME_URGENT_RE.test(text);

  if (node.kind === 'pending' && node.status === 'open') {
    if (isImportant && !isTrivial) return 'q1';
    return 'q3';
  }
  if (isTimeUrgent && isImportant && !isTrivial) return 'q1';
  if (isTimeUrgent) return 'q3';
  if (LOW_BACKGROUND_RE.test(text)) return 'q4';

  return 'q2';
}

/** 查找某节点挂在根目标下的顶层专题节点。 */
function findTopTopic(
  node: types.DecisionNode,
  rootId: string,
  byId: ReadonlyMap<string, types.DecisionNode>,
): types.DecisionNode | undefined {
  let current: types.DecisionNode | undefined = node;
  const seen = new Set<string>();
  while (current !== undefined && current.parent !== null) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    if (current.parent === rootId) return current;
    current = byId.get(current.parent);
  }
  return undefined;
}

/** 给同象限卡片排优先级：开放待拍板最顶 -> 进行中 -> 未开始 -> 已定/已完成。 */
function getSortWeight(entry: QuadrantEntry): number {
  if (entry.isPendingOpen) return 0;
  if (entry.node.status === 'working') return 1;
  if (entry.node.status === 'open') return 2;
  if (entry.node.status === 'decided' || entry.node.kind === 'decided') return 3;

  return 4;
}

/**
 * 从项目节点列表提取并归类四象限条目（自动过滤中心根目标与纯目录分组壳节点）。
 * @param nodes 当前项目的全部节点。
 * @returns 按优先级排好序的四象限条目列表。
 */
export function buildQuadrantEntries(nodes: types.DecisionNode[]): QuadrantEntry[] {
  const root = nodes.find((entry) => entry.parent === null);
  if (root === undefined) return [];

  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const parentIds = new Set<string>();
  for (const entry of nodes) {
    if (entry.parent !== null) parentIds.add(entry.parent);
  }

  const list: QuadrantEntry[] = [];
  for (const node of nodes) {
    if (node.parent === null) continue;
    //M 纯分组目录（fork 且底下已有子项、又没手动指定象限）不重复当卡片塞进象限，其名称作为子卡片标签展示。
    if (node.kind === 'fork' && parentIds.has(node.id) && node.quadrant === undefined) continue;

    const top = findTopTopic(node, root.id, byId);
    let topicTitle = '';
    let topicId = root.id;
    if (top !== undefined && top.id !== node.id) {
      topicTitle = top.title;
      topicId = top.id;
    }
    const isPendingOpen = node.kind === 'pending' && node.status === 'open';
    list.push({
      node,
      quadrant: resolveNodeQuadrant(node, byId),
      isManual: node.quadrant !== undefined,
      topicTitle,
      topicId,
      isPendingOpen,
      isClosed: isClosedDecisionNode(node),
    });
  }

  list.sort((left, right) => getSortWeight(left) - getSortWeight(right));
  return list;
}

/** 按当前范围筛选条件过滤四象限条目。 */
export function filterQuadrantEntries(
  entries: readonly QuadrantEntry[],
  scopeFilter: QuadrantScopeFilter,
): QuadrantEntry[] {
  if (scopeFilter === 'all') return [...entries];
  if (scopeFilter === 'pending') return entries.filter((entry) => entry.isPendingOpen);

  return entries.filter((entry) => !entry.isClosed);
}
