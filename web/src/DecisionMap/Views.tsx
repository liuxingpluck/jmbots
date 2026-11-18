/** 决策图的表格和清单两种看法，和画布用同一份节点、同一个侧栏。 */
import * as react from 'react';
import type * as types from '../../../src7/plugins/decision-map/Types.ts';
import * as drawer from './Drawer.tsx';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 表格能按哪种状态筛。 */
type StateKey = 'pending' | 'working' | 'decided' | 'done' | 'open';

/** 筛选按钮：全部加四种状态。 */
const FILTERS: { key: StateKey | 'all'; label: string }[] = [
  //M 按钮文字在打开页面时按当前语言译好。
  { key: 'all', label: t('全部') },
  { key: 'pending', label: t('待定') },
  { key: 'working', label: t('进行中') },
  { key: 'decided', label: t('已定') },
  { key: 'done', label: t('做完') },
];

/** 表格和清单共用的参数。 */
interface ViewProps {
  /** 当前快照的全部节点。 */
  nodes: types.DecisionNode[];
  /** 侧栏正打开的节点号。 */
  selected?: string;
  /** 打开侧栏，实现在 DecisionMapPage 的 open。 */
  open: (id: string) => void;
}

/** 节点归到哪种状态，表格的状态列和筛选都用它。 */
function getState(entry: types.DecisionNode): { key: StateKey; label: string } {
  //M 待定最醒目，先判；其次看做完、进行中、已定。
  if (entry.kind === 'pending' && entry.status === 'open') return { key: 'pending', label: t('★ 待定') };
  if (entry.status === 'done' || entry.status === 'dropped') return { key: 'done', label: t('做完') };
  if (entry.status === 'working') return { key: 'working', label: t('进行中') };
  if (entry.kind === 'decided' || entry.status === 'decided') return { key: 'decided', label: t('已定 ✓') };

  //M 剩下的是还没动的功能和分叉。
  return { key: 'open', label: t('未开始') };
}

/** 节点所属的一级分支标题；中心目标自己没有分支。 */
function getBranchTitle(entry: types.DecisionNode, byId: Map<string, types.DecisionNode>): string {
  let current = entry;
  let parent = byId.get(entry.parent ?? '');
  if (parent === undefined) return '—';

  //M 往上找到直接挂在中心目标下的那一级。
  while (parent.parent !== null) {
    const next = byId.get(parent.parent);
    if (next === undefined) return parent.title;

    current = parent;
    parent = next;
  }
  return current.title;
}

/** 节点最后一次有动静的时间：创建、定下、中控确认、写话里最晚的。 */
function getUpdated(entry: types.DecisionNode): number {
  //M 把所有时间点收在一起取最晚的。
  const times = [entry.createdAt];
  if (entry.decidedAt !== undefined) times.push(entry.decidedAt);
  if (entry.acknowledgedAt !== undefined) times.push(entry.acknowledgedAt);
  for (const note of entry.notes ?? []) {
    times.push(note.at);
  }
  return Math.max(...times);
}

/** 摘要只取第一行当一句话。 */
function getLine(entry: types.DecisionNode): string {
  const [first] = entry.summary.split('\n');
  return first ?? '';
}

/** 选项列：推荐的标出来，已选的打勾。 */
function OptionCell({ entry }: { entry: types.DecisionNode }) {
  const options = entry.options ?? [];
  if (options.length === 0) return <span className="decision-table__none">—</span>;

  //M 每个选项一行，手机上也不挤成一团。
  return (
    <ul className="decision-table__options">
      {options.map((option) => (
        <li key={option.id} data-chosen={option.id === entry.chosen}>
          {option.text}
          {option.recommended === true && <span className="decision-option__recommended">{t('推荐')}</span>}
          {option.id === entry.chosen && <span className="decision-table__chosen">✓</span>}
        </li>
      ))}
    </ul>
  );
}

/** 表格看法：一行一个节点，能按状态筛，点一行打开侧栏。 */
export function TableView({ nodes, selected, open }: ViewProps) {
  const [filter, setFilter] = react.useState<StateKey | 'all'>('all');
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const rows = nodes.filter((entry) => {
    if (filter === 'all') return true;

    //M 未开始的功能只在“全部”里出现。
    const state = getState(entry);
    return state.key === filter;
  });

  /** 键盘回车或空格也能打开一行。 */
  const press = (event: react.KeyboardEvent, id: string): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    //M 拦下空格的页面滚动，再打开侧栏。
    event.preventDefault();
    open(id);
  };

  //M 顶上一排筛选，下面是可横向滚动的表。
  return (
    <div className="decision-view decision-table">
      <div className="decision-filters" role="group" aria-label={t('按状态筛')}>
        {FILTERS.map((item) => (
          <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="decision-table__scroll">
        <table>
          <thead>
            <tr>
              <th>{t('状态')}</th>
              <th>{t('标题')}</th>
              <th>{t('一句话')}</th>
              <th>{t('所属分支')}</th>
              <th>{t('要你定的选项')}</th>
              <th>{t('更新时间')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const state = getState(entry);
              const updated = getUpdated(entry);

              //M 一行写齐状态、标题、一句话、分支、选项和更新时间，点了打开侧栏。
              return (
                <tr
                  key={entry.id}
                  tabIndex={0}
                  data-state={state.key}
                  data-node-id={entry.id}
                  aria-selected={entry.id === selected}
                  onClick={() => open(entry.id)}
                  onKeyDown={(event) => press(event, entry.id)}
                >
                  <td className="decision-table__state">{state.label}</td>
                  <td className="decision-table__title">{entry.title}</td>
                  <td>{getLine(entry)}</td>
                  <td>{getBranchTitle(entry, byId)}</td>
                  <td><OptionCell entry={entry} /></td>
                  <td className="decision-table__time">{drawer.getTime(updated)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="decision-view__empty">{t('这个状态下没有节点')}</p>}
      </div>
    </div>
  );
}

/** 清单里的一行：节点和它在分支里的层深。 */
interface ListRow {
  /** 节点。 */
  entry: types.DecisionNode;
  /** 在所属分支里的层深，一级分支是 0。 */
  depth: number;
}

/** 按先根后子的顺序把一支摊成缩进行。 */
function getRows(
  entry: types.DecisionNode, depth: number, byParent: Map<string, types.DecisionNode[]>, rows: ListRow[],
): void {
  //M 先放自己，再按顺序放子节点。
  rows.push({ entry, depth });
  const children = byParent.get(entry.id) ?? [];
  for (const child of children) {
    //M 子节点紧跟在父节点下面，层深加一。
    getRows(child, depth + 1, byParent, rows);
  }
}

/** 清单看法：按一级分支分组的缩进列表，手机上最好读。 */
export function ListView({ nodes, selected, open }: ViewProps) {
  //M 从中心目标开始分组，图里还没有目标时给一句提示。
  const root = nodes.find((entry) => entry.parent === null);
  if (root === undefined) return <p className="decision-view__empty">{t('还没有决策节点')}</p>;

  //M 同级保持快照里的顺序。
  const byParent = new Map<string, types.DecisionNode[]>();
  for (const entry of nodes) {
    if (entry.parent === null) continue;

    //M 把节点挂到父节点名下。
    const siblings = byParent.get(entry.parent) ?? [];
    siblings.push(entry);
    byParent.set(entry.parent, siblings);
  }
  const branches = byParent.get(root.id) ?? [];

  /** 一行就是一个按钮，点了打开侧栏。 */
  const getItem = (row: ListRow) => {
    //M 状态决定颜色，层深决定缩进。
    const state = getState(row.entry);
    const indent = { paddingLeft: `${String(12 + row.depth * 18)}px` };

    //M 整行是一个按钮，手机上好按。
    return (
      <li key={row.entry.id}>
        <button
          type="button"
          className="decision-list__item"
          style={indent}
          data-state={state.key}
          data-node-id={row.entry.id}
          aria-pressed={row.entry.id === selected}
          onClick={() => open(row.entry.id)}
        >
          <span className="decision-list__state">{state.label}</span>
          <span className="decision-list__title">{row.entry.title}</span>
        </button>
      </li>
    );
  };

  //M 中心目标在最上面，每个一级分支一组。
  return (
    <div className="decision-view decision-list">
      <ul className="decision-list__group">{getItem({ entry: root, depth: 0 })}</ul>
      {branches.map((branch) => {
        const rows: ListRow[] = [];
        getRows(branch, 0, byParent, rows);

        return (
          <section key={branch.id} className="decision-list__section" aria-label={branch.title}>
            <ul className="decision-list__group">{rows.map(getItem)}</ul>
          </section>
        );
      })}
    </div>
  );
}
