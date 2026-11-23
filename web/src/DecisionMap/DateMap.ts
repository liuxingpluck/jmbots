/** 按日期看法：根在左，往右依次是日期、那天提出的分支、分支下的待定和已定项，最新的日期在上。 */
import * as d3 from 'd3-hierarchy';
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import type * as layout from './Layout.ts';
import * as words from './Words.ts';

const t = words.t;

/** 按看页面的这台机器的本地时区划日期（不写死某个时区）。 */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DAY_TEXT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: ZONE,
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const DAY_MS = 86_400_000;
/** 同一列相邻卡片的垂直间距，和相邻两列的水平间距。 */
const BREADTH = 110;
const DEPTH = 270;

/** 树上的一项：已做好的画布节点和它下面的项。 */
interface Item {
  /** 画布节点，位置在排版后填。 */
  node: layout.FlowNode;
  /** 是否是等用户定的事项。 */
  ask: boolean;
  /** 是否在主线上，同一列里排在前面。 */
  main: boolean;
  /** 下一列的项。 */
  children: Item[];
}

/** 等用户定的事项。 */
function isAsk(entry: types.DecisionNode): boolean {
  return entry.kind === 'pending' && entry.status === 'open';
}

/** 卡片第三行：中控的决定、用户选的项，或这一项属于哪个前一天的分支。 */
function getHint(entry: types.DecisionNode, parentTitle: string | undefined): string | undefined {
  let parent: string | undefined;
  if (parentTitle !== undefined) parent = t('属于「{title}」', { title: parentTitle });
  if (isAsk(entry)) return parent;

  //M 中控定的话写在 summary 里，以“中控定”开头的那一行。
  const central = /中控定[^\n]*/.exec(entry.summary);
  if (central !== null) return central[0];

  const option = entry.options?.find((item) => item.id === entry.chosen);
  if (option !== undefined) return t('选：{text}', { text: option.text });

  return parent;
}

/** 日期卡片左上的短词：今天、昨天，其余留空。 */
function getRelative(day: string): string {
  const now = Date.now();
  if (day === DAY_KEY.format(now)) return t('今天');
  if (day === DAY_KEY.format(now - DAY_MS)) return t('昨天');

  return '';
}

/**
 * 按日期看法的卡片和连线。
 * @param entries 当前范围的节点，其中 parent 为 null 的是根。
 * @param folds 用户收起的日期，键是 day:日期，值 false 表示收起。
 * @param open 卡片动作回调。
 * @param onlyAsk 只留等用户定的事项和通往它们的路。
 */
export function getDateLayout(
  entries: types.DecisionNode[], folds: ReadonlyMap<string, boolean>, open: layout.VisualData['open'], onlyAsk: boolean,
) {
  const root = entries.find((entry) => entry.parent === null);
  if (root === undefined) return { nodes: [], edges: [] };

  //M 每个节点按自己的创建日期归到一天，同一天里挂在最近的同日祖先下，没有就直接挂在日期下。
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rest = entries.filter((entry) => entry !== root).sort((a, b) => a.createdAt - b.createdAt);
  const keyOf = (entry: types.DecisionNode): string => DAY_KEY.format(entry.createdAt);
  const items = new Map<string, Item>();
  for (const entry of rest) {
    const ask = isAsk(entry);
    const main = entry.main === true;
    items.set(entry.id, { node: makeCard(entry, ask, undefined, open), ask, main, children: [] });
  }
  const tops = new Map<string, Item[]>();
  for (const entry of rest) {
    const day = keyOf(entry);
    let host = entry.parent;
    while (host !== null && host !== root.id && keyOf(byId.get(host)!) !== day) {
      host = byId.get(host)!.parent;
    }
    const item = items.get(entry.id)!;
    if (host !== null && host !== root.id) {
      items.get(host)!.children.push(item);
      continue;
    }

    //M 同日祖先找不到时，卡片上写明它属于哪个别的日子提出的分支。
    const above = byId.get(entry.parent ?? '');
    if (above !== undefined && above !== root) item.node = makeCard(entry, item.ask, above.title, open);
    const list = tops.get(day) ?? [];
    list.push(item);
    tops.set(day, list);
  }

  const dayItems: Item[] = [];
  for (const day of [...tops.keys()].sort().reverse()) {
    const list = tops.get(day)!;
    const mark = (item: Item): boolean => {
      item.children = item.children.filter(mark);
      return item.ask || item.children.length > 0;
    };
    if (onlyAsk) list.splice(0, list.length, ...list.filter(mark));
    if (list.length === 0) continue;

    list.sort((a, b) => Number(b.main) - Number(a.main));
    const same = rest.filter((entry) => keyOf(entry) === day);
    const asks = same.filter(isAsk).length;
    const id = `day:${day}`;
    const expanded = folds.get(id) !== false;
    const label = `${getRelative(day)} ${DAY_TEXT.format(Date.parse(`${day}T12:00:00Z`))}`.trim();
    const data = { day, label, total: same.length, asks, expanded, open };
    const node: layout.DayNode = { id, type: 'day', data, position: { x: 0, y: 0 }, draggable: false };
    let shown = list;
    if (!expanded) shown = [];
    dayItems.push({ node, ask: false, main: false, children: shown });
  }

  const rootNode = makeCard(root, false, undefined, open);
  const tree = d3.tree<Item>().nodeSize([BREADTH, DEPTH]).separation(() => 1);
  const laid = tree(d3.hierarchy<Item>({ node: rootNode, ask: false, main: false, children: dayItems }));
  const nodes: layout.FlowNode[] = [];
  const edges: xyflow.Edge[] = [];
  for (const point of laid.descendants()) {
    const { node } = point.data;
    nodes.push({ ...node, position: { x: point.y, y: point.x } });
    if (point.parent === null) continue;

    //M 从左卡片的右边曲线接到右卡片的左边；主线用粗金线。
    const from = point.parent.data.node;
    let className = 'decision-edge';
    if (node.type === 'decision' && node.data.entry.main === true) className += ' decision-edge--main';
    edges.push({
      id: `${from.id}>${node.id}`,
      source: from.id,
      target: node.id,
      sourceHandle: xyflow.Position.Right,
      targetHandle: xyflow.Position.Left,
      type: 'default',
      className,
    });
  }
  return { nodes, edges };
}

/** 一张决策卡；根目标用目标的尺寸，其余统一大小，留一行放第三行说明。 */
function makeCard(
  entry: types.DecisionNode, ask: boolean, parent: string | undefined, open: layout.VisualData['open'],
): layout.CardNode {
  const hint = getHint(entry, parent);
  let style = { width: 220, height: 100 };
  if (entry.kind === 'goal') style = { width: 158, height: 96 };
  if (ask) style = { width: 232, height: 100 };

  return {
    id: entry.id,
    type: 'decision',
    data: { entry, open, hint },
    position: { x: 0, y: 0 },
    style,
    draggable: false,
  };
}
