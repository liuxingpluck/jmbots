/** 将决策树按叶子数分扇区，再按可读尺寸布置到 React Flow 画布里。 */
import * as d3 from 'd3-hierarchy';
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/decision-map/Types.ts';

export type ViewMode = 'all' | 'main' | 'pending';

/** 完整分支折叠在父卡片上。 */
interface Fold {
  /** 在当前视图内唯一的展开键。 */
  id: string;
  /** 这个控件下的实际节点数。 */
  count: number;
  /** 父节点的折叠分支是否已展开。 */
  expanded: boolean;
}

/** 送给自定义卡片的数据。 */
type VisualData = {
  /** 当前快照的节点。 */
  entry: types.DecisionNode;
  /** 打开节点或切换折叠，由 DecisionMapPage 提供。 */
  open: (id: string, isFold?: boolean) => void;
  /** 有折叠内容的卡片在角落显示 +N。 */
  fold?: Fold;
};

export type FlowNode = xyflow.Node<VisualData, 'decision'>;

/** 可见树及每张卡片有无折叠内容。 */
interface Branch {
  /** 当前节点信息。 */
  entry: types.DecisionNode;
  /** 在当前视图应摆到画布上的子节点。 */
  children: Branch[];
  /** 未过滤的整支节点数。 */
  size: number;
  /** 这一支已经全部处理完毕。 */
  complete: boolean;
  /** 折叠按钮数据。 */
  fold?: Fold;
}

/** 画布模式和它当前的像素尺寸。 */
interface View {
  /** 进展概览、只看待定、全部分支。 */
  mode: ViewMode;
  /** 当前视图里用户显式展开的节点。 */
  expanded: ReadonlySet<string>;
  /** 画布宽度。 */
  width: number;
  /** 画布高度。 */
  height: number;
  /** 窄屏用双列容纳同一棵放射树。 */
  portrait: boolean;
}

/** 卡片的碰撞边界。 */
interface Box {
  /** 卡片对应的树节点。 */
  branch: Branch;
  /** 中心坐标，从扇区初始点挪到最后位置。 */
  position: xyflow.XYPosition;
  /** 卡片宽度。 */
  width: number;
  /** 卡片高度。 */
  height: number;
}

const ROUND = 2 * Math.PI;
const GAP = 12;
const OVERVIEW_LIMIT = 25;
const OPPOSITE = {
  [xyflow.Position.Left]: xyflow.Position.Right,
  [xyflow.Position.Right]: xyflow.Position.Left,
  [xyflow.Position.Top]: xyflow.Position.Bottom,
  [xyflow.Position.Bottom]: xyflow.Position.Top,
};

/**
 * 先布置可见树，再生成卡片和连线。
 * @param entries 图的节点快照。
 * @param view 画布尺寸、模式及手动展开的分支。
 * @param open 卡片动作回调。
 */
export function getLayout(entries: types.DecisionNode[], view: View, open: VisualData['open']) {
  const root = entries.find((entry) => entry.parent === null);
  if (root === undefined) return { nodes: [], edges: [] };

  //M 过滤先保留祖先，之后才判断哪些同级子树可以收进一个 +N。
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const included = getIncluded(entries, byId, view.mode);
  const byParent = new Map<string, types.DecisionNode[]>();
  for (const entry of entries) {
    if (entry.parent === null) continue;

    //M 保留同级节点的输入顺序，让同一快照总是得到相同布局。
    const siblings = byParent.get(entry.parent) ?? [];
    siblings.push(entry);
    byParent.set(entry.parent, siblings);
  }

  //M d3 给出同一扇区内的相对角度和深度，展开后才重新计算叶子数。
  const rootBranch = getBranch(root, byParent, included, view);
  const hierarchy = d3.hierarchy(rootBranch);
  const tree = d3.tree<Branch>().size([ROUND, 1]);
  const radial = tree(hierarchy);
  const bounds = getBounds(view, radial.descendants().length);
  const positions = getPositions(radial, bounds, view.portrait);
  const branches = radial.descendants();
  const boxes = branches.map(({ data }) => getBox(data, positions, view));
  if (view.portrait) {
    //M 小屏按扇区期望的位置选择双列卡位，保持 14px 标题。
    placePortrait(boxes, bounds);
  }
  if (!view.portrait) {
    //M 桌面仅挪动冲突卡片，尽量保留扇区的位置关系。
    placeLandscape(boxes, bounds);
  }

  //M 卡片和连线共用最终坐标。尺寸从布局传给 CSS，避免估算值和实际不同。
  const nodes = boxes.map((box): FlowNode => {
    const { entry, fold } = box.branch;
    return {
      id: entry.id,
      type: 'decision',
      data: { entry, open, fold },
      position: box.position,
      style: { width: box.width, height: box.height },
      draggable: false,
    };
  });
  const edges: xyflow.Edge[] = [];
  for (const branch of branches) {
    const { entry } = branch.data;
    const parentId = branch.parent?.data.entry.id;
    if (parentId !== undefined) {
      //M 保留主线和普通分支两种连线强度。
      const edge = getEdge(parentId, entry.id, positions, entry.main === true, false);
      edges.push(edge);
    }
    for (const need of new Set(entry.needs ?? [])) {
      if (!positions.has(need)) continue;

      //M 依赖线只连当前能看见的节点，隐藏分支不画到空处。
      const edge = getEdge(need, entry.id, positions, false, true);
      edges.push(edge);
    }
  }
  return { nodes, edges };
}

/** 常用视图跟随实际画布宽高，卡片特别多时才扩大画布范围。 */
function getBounds(view: View, count: number): { width: number; height: number } {
  if (view.portrait) {
    const rows = Math.ceil((count + 1) / 2);
    const height = Math.max(view.height - 56, 66 + (rows - 1) * 68);
    return { width: view.width - 16, height };
  }

  //M 预留边距、图例和控制按钮。扩展视图按卡片所需面积补足空间。
  const width = Math.max(560, view.width - 48);
  const height = Math.max(340, view.height - 72);
  const scale = Math.max(1, Math.sqrt(count * 30_000 / (width * height)));
  return { width: width * scale, height: height * scale };
}

/** 用 d3 的相对角度布成扇区，主线的每一层沿自己的弧前进。 */
function getPositions(
  root: d3.HierarchyPointNode<Branch>, bounds: { width: number; height: number }, portrait: boolean,
): Map<string, xyflow.XYPosition> {
  const positions = new Map<string, xyflow.XYPosition>([[root.data.entry.id, { x: 0, y: 0 }]]);
  const top = [...(root.children ?? [])];
  top.sort((a, b) => Number(b.data.entry.main === true) - Number(a.data.entry.main === true));
  const weights = top.map((branch) => branch.leaves().length);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const rx = Math.max(1, bounds.width / 2 - 111);
  const ry = Math.max(1, bounds.height / 2 - 46);
  let start = -Math.PI * 0.88;
  if (portrait) start = -Math.PI * 0.7;

  for (const [index, branch] of top.entries()) {
    //M 角度按可见叶子数分配，叶子多的分支得到更宽的扇区。
    const spread = ROUND * weights[index]! / total;
    const points = branch.descendants();
    const angleRange = points.map((point) => point.x);
    const first = Math.min(...angleRange);
    const span = Math.max(...angleRange) - first;
    for (const point of points) {
      const depth = (point.depth - 1) / Math.max(1, branch.height);
      let fraction = 0.5;
      if (span > 0) fraction = (point.x - first) / span;
      if (point.data.entry.main === true) fraction = 0.12 + 0.76 * depth;

      //M 浅分支也能走到边缘。主线随深度同时改变角度和半径。
      let distance = 0.52 + 0.48 * depth;
      if (branch.height === 0) distance = 0.88;
      const angle = start + spread * (0.08 + 0.84 * fraction);
      const x = Math.cos(angle) * rx * distance;
      const y = Math.sin(angle) * ry * distance;
      positions.set(point.data.entry.id, { x, y });
    }
    start += spread;
  }
  return positions;
}

/** 为目标、待定和普通卡片选择足够显示两行标题的尺寸。 */
function getBox(branch: Branch, positions: Map<string, xyflow.XYPosition>, view: View): Box {
  const { entry } = branch;
  const position = positions.get(entry.id)!;
  //M 待定卡片预留更大的阅读和高亮空间。
  const pending = isPending(entry);
  if (view.portrait) {
    const width = Math.min(156, (view.width - 48) / 2);
    if (entry.kind === 'goal') return { branch, position, width: 128, height: 62 };
    if (pending) return { branch, position, width: width + 8, height: 66 };

    return { branch, position, width, height: 58 };
  }
  if (entry.kind === 'goal') return { branch, position, width: 158, height: 96 };
  if (pending) return { branch, position, width: 222, height: 84 };

  return { branch, position, width: 196, height: 74 };
}

/** 检查目标中心点和已经落位的卡片是否有碰撞。 */
function isFree(box: Box, position: xyflow.XYPosition, placed: Box[]): boolean {
  //G 留出卡片和待定高亮之间的缓冲。
  return placed.every((other) => {
    const dx = Math.abs(position.x - other.position.x);
    const dy = Math.abs(position.y - other.position.y);
    return dx >= (box.width + other.width) / 2 + GAP || dy >= (box.height + other.height) / 2 + GAP;
  });
}

/** 在目标点附近寻找能装下当前卡片的位置。 */
function placeLandscape(boxes: Box[], bounds: { width: number; height: number }): void {
  const placed: Box[] = [];
  for (const box of boxes) {
    //M 扇区点有空间时直接落位，只有冲突才找离它最近的位置。
    if (isFree(box, box.position, placed)) {
      //M 后面的卡片以这张已落位的卡片作为碰撞边界。
      placed.push(box);
      continue;
    }

    //M 只在碰撞时找最近的空位，留在画布尺寸允许的区间。
    const limitX = (bounds.width - box.width) / 2;
    const limitY = (bounds.height - box.height) / 2;
    let best: xyflow.XYPosition | undefined;
    let distance = Infinity;
    for (let y = -limitY; y <= limitY; y += 16) {
      for (let x = -limitX; x <= limitX; x += 16) {
        const deltaX = x - box.position.x;
        const deltaY = y - box.position.y;
        const cost = deltaX * deltaX + deltaY * deltaY;
        if (cost >= distance) continue;

        const candidate = { x, y };
        //G 空位即使离得近，也要给周围的字和高亮留出间隔。
        if (!isFree(box, candidate, placed)) continue;

        best = candidate;
        distance = cost;
      }
    }
    if (best === undefined) {
      //M 特大展开图会多占一行，避免把两张必须能点击的卡片叠在一起。
      const bottom = Math.max(...placed.map((other) => other.position.y + other.height / 2));
      best = { x: box.position.x, y: bottom + box.height / 2 + GAP };
    }
    Object.assign(box.position, best);
    //M 后续卡片用最终落点判断冲突。
    placed.push(box);
  }
}

/** 窄屏把扇区坐标映射到最近的双列卡位，中央保留目标。 */
function placePortrait(boxes: Box[], bounds: { width: number; height: number }): void {
  if (boxes.length < 2) return;

  const rows = Math.ceil((boxes.length + 1) / 2);
  const rootRow = Math.floor((rows - 1) / 2);
  const gap = (bounds.height - 66) / (rows - 1);
  const maxWidth = Math.max(...boxes.map((box) => box.width));
  const x = (bounds.width - maxWidth) / 2;
  const slots: xyflow.XYPosition[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = (row - (rows - 1) / 2) * gap;
    if (row === rootRow) {
      boxes[0]!.position.y = y;
      continue;
    }

    //M 初始左右和上下顺序来自径向扇区，卡位只消除窄屏上的横向挤压。
    slots.push({ x: -x, y }, { x, y });
  }
  for (const box of boxes.slice(1)) {
    let best = 0;
    let distance = Infinity;
    for (const [index, slot] of slots.entries()) {
      const dx = slot.x - box.position.x;
      const dy = slot.y - box.position.y;
      const cost = dx * dx + dy * dy;
      if (cost >= distance) continue;

      best = index;
      distance = cost;
    }
    //M 每个位置只用一次，满屏展开时按所需的实际行数增高。
    const [chosen] = slots.splice(best, 1);
    Object.assign(box.position, chosen);
  }
}

/** 待用户决定的卡片拥有独立的尺寸与颜色。 */
function isPending(entry: types.DecisionNode): boolean {
  return entry.kind === 'pending' && entry.status === 'open';
}

/** 过滤时把所选卡片和通往中心的路径一起保留。 */
function getIncluded(
  entries: types.DecisionNode[], byId: Map<string, types.DecisionNode>, mode: ViewMode,
): Set<string> {
  if (mode === 'all') return new Set(byId.keys());

  //M 先保留目标、主线和所有待定。进展很多时从原顺序补充正在进行的卡片。
  const priority = entries.filter((entry) => entry.parent === null || entry.main === true || isPending(entry));
  const required = new Set(priority);
  const working = entries.filter((entry) => entry.status === 'working' && !required.has(entry));
  let visible = priority;
  if (mode === 'pending') visible = entries.filter(isPending);
  if (mode === 'main') visible = [...priority, ...working];

  const included = new Set<string>();
  for (const entry of visible) {
    const chain: string[] = [];
    let ancestor: types.DecisionNode | undefined = entry;
    while (ancestor !== undefined && !included.has(ancestor.id)) {
      //M 一次收集整条未显示的父链，避免预算用到一半而留下断线。
      chain.push(ancestor.id);
      if (ancestor.parent === null) break;

      ancestor = byId.get(ancestor.parent);
    }
    if (mode === 'main' && !required.has(entry) && included.size + chain.length > OVERVIEW_LIMIT) continue;

    //M 整条路径同时保留，容量不足的进行中分支仍可从父卡片展开。
    for (const id of chain) {
      included.add(id);
    }
  }
  return included;
}

/** 将未展开的整支子树收进父卡片，减少首屏参与适应窗口的节点。 */
function getBranch(
  entry: types.DecisionNode, byParent: Map<string, types.DecisionNode[]>, included: Set<string>, view: View,
): Branch {
  const children = byParent.get(entry.id) ?? [];
  //M 先计算子树的总数与完成情况，父卡片的 +N 才能包含后代。
  const branches = children.map((child) => getBranch(child, byParent, included, view));
  const size = branches.reduce((sum, child) => sum + child.size, 1);
  const terminal = entry.status === 'done' || entry.status === 'dropped' || entry.status === 'decided';
  const complete = terminal && entry.main !== true && branches.every((child) => child.complete);
  if (view.mode === 'pending') {
    const kept = branches.filter((branch) => included.has(branch.entry.id));
    return { entry, children: kept, size, complete };
  }

  //M 概览收起暂时不需看的节点。全图也可一次收起同父节点的已完结整支。
  const hidden = branches.filter((branch) => {
    if (view.mode === 'main' && included.has(entry.id)) return !included.has(branch.entry.id);

    return branch.complete;
  });
  if (hidden.length === 0 || complete) return { entry, children: branches, size, complete };

  const id = entry.id;
  const count = hidden.reduce((sum, branch) => sum + branch.size, 0);
  const expanded = view.expanded.has(id);
  const fold = { id, count, expanded };
  if (expanded) return { entry, children: branches, size, complete, fold };

  const kept = branches.filter((branch) => !hidden.includes(branch));
  return { entry, children: kept, size, complete, fold };
}

/** 从卡片向目标方向选择适合的边缘。 */
function getDirection(dx: number, dy: number): xyflow.Position {
  if (Math.abs(dx) >= Math.abs(dy) && dx >= 0) return xyflow.Position.Right;
  if (Math.abs(dx) >= Math.abs(dy)) return xyflow.Position.Left;
  if (dy >= 0) return xyflow.Position.Bottom;

  return xyflow.Position.Top;
}

/** 为 React Flow 建立主线、放射线或跨分支依赖。 */
function getEdge(
  source: string, target: string, positions: Map<string, xyflow.XYPosition>, main: boolean, dependency: boolean,
): xyflow.Edge {
  const from = positions.get(source)!;
  const to = positions.get(target)!;
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  //M 向另一张卡片的边缘接线，保留主线和依赖的视觉区别。
  const out = getDirection(dx, dy);
  let className = 'decision-edge';
  if (main) className += ' decision-edge--main';
  if (dependency) className += ' decision-edge--dependency';

  const id = JSON.stringify([source, target, dependency]);
  return { id, source, target, sourceHandle: out, targetHandle: OPPOSITE[out], type: 'straight', className };
}

