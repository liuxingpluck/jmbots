/**
 * 工作决策子树范围切分纯函数与基础视图枚举类型（零图形库、零 AntD 依赖，首屏轻量加载）。
 */
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import type * as mind from '../Shared/MindMap.ts';

/** 导图与放射视图的分支过滤模式。 */
export type ViewMode = 'all' | 'main' | 'pending';

/** 思维导图展开方向：左右两边或从上往下。 */
export type MindDirection = mind.MindDirection;

/** 同级按快照顺序排列，供清单与聚焦路径共用。 */
export function getChildren(nodes: types.DecisionNode[]): Map<string, types.DecisionNode[]> {
  const children = new Map<string, types.DecisionNode[]>();
  for (const entry of nodes) {
    if (entry.parent === null) continue;

    const siblings = children.get(entry.parent) ?? [];
    siblings.push(entry);
    children.set(entry.parent, siblings);
  }
  return children;
}

/** 从快照取出单棵子树和从总目标到它的面包屑。 */
export function getScope(
  nodes: types.DecisionNode[],
  focus?: string,
): { nodes: types.DecisionNode[]; path: types.DecisionNode[] } {
  if (focus === undefined) return { nodes, path: [] };

  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const root = byId.get(focus);
  if (root === undefined) return { nodes, path: [] };

  const path = [root];
  let parent = root.parent;
  while (parent !== null) {
    const entry = byId.get(parent);
    if (entry === undefined) break;

    path.push(entry);
    parent = entry.parent;
  }

  //M 只把当前视图的根视为顶层，保存的真实父编号保持原样。
  const children = getChildren(nodes);
  const scope: types.DecisionNode[] = [{ ...root, parent: null }];
  for (const entry of scope) {
    for (const child of children.get(entry.id) ?? []) {
      scope.push(child);
    }
  }
  return { nodes: scope, path: path.reverse() };
}
