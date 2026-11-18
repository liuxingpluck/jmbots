/** 共享思维导图坐标布局，保持各页自己的卡片、边和交互。 */
import * as d3 from 'd3-hierarchy';

/** 思维导图往左右两边展开，或从上向下展开。 */
export type MindDirection = 'sides' | 'down';

/** 一层中相邻节点的距离和相邻两层的距离。 */
interface Spacing { breadth: number; depth: number }

/** 中心坐标及只在这棵树里使用的父节点。 */
interface MindPoint<T> { item: T; parent?: T; position: { x: number; y: number } }

/**
 * 排布输入树，根位于 0,0，一级分支左右交替。相同输入保持遍历顺序和坐标。
 * @param root 输入根节点。
 * @param children 返回给定节点的子节点，不修改源树。
 * @param direction 展开方向。
 * @param spacing 卡片留白和层距。
 * @returns 根在前，其后为各侧按层遍历的节点及坐标。无副作用。
 */
export function getMindPoints<T>(
  root: T, children: (item: T) => readonly T[], direction: MindDirection, spacing: Spacing,
): MindPoint<T>[] {
  //M 左右展开把奇偶分支分到两边，竖排只用一棵树。
  const first = children(root);
  let sides = [{ sign: 1, items: first }];
  if (direction === 'sides') {
    const right = first.filter((_item, index) => index % 2 === 0);
    const left = first.filter((_item, index) => index % 2 === 1);
    sides = [{ sign: 1, items: right }, { sign: -1, items: left }];
  }
  const points: MindPoint<T>[] = [{ item: root, position: { x: 0, y: 0 } }];
  for (const side of sides) {
    //M 每侧都使用同一逻辑根，d3 的 x 分隔同层卡片，y 表示层深。
    const getChildren = (item: T): readonly T[] => {
      if (item === root) return side.items;
      return children(item);
    };
    const hierarchy = d3.hierarchy(root, getChildren);
    const size: [number, number] = [spacing.breadth, spacing.depth];
    const tree = d3.tree<T>().nodeSize(size);
    const laid = tree(hierarchy);
    for (const point of laid.descendants()) {
      if (point.parent === null) continue;

      let position = { x: side.sign * point.y, y: point.x };
      if (direction === 'down') position = { x: point.x, y: point.y };
      //M 调用方用原节点和父节点分别画卡片和连线。
      const placed = { item: point.data, parent: point.parent.data, position };
      points.push(placed);
    }
  }
  return points;
}
