/** 决策图的表格和清单两种看法，和画布用同一份节点、同一个侧栏。 */
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
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
  if (entry.status === 'open' && entry.chosen !== undefined) return { key: 'open', label: t('未开始') };
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

/** 虚拟表需要数值宽度；列宽总和作为横向滚动宽度。 */
const TABLE_WIDTH = 960;
/** 小号表头的预留高度，表身按容器剩余空间滚动。 */
const TABLE_HEADER_HEIGHT = 48;
/** 独立的决策图入口没有主站的主题容器。 */
const TABLE_THEME: antd.ThemeConfig = {
  algorithm: antd.theme.darkAlgorithm,
  token: { colorBgContainer: '#11161f' },
  components: {
    Table: { headerBg: '#18202c', rowHoverBg: '#1f2938', borderColor: '#252e3d' },
  },
};
/** 虚拟表的行由 div 渲染，状态颜色仍沿用决策图主题。 */
const STATE_COLORS: Record<StateKey, string> = {
  pending: 'var(--decision-red)',
  working: 'var(--decision-blue)',
  decided: 'var(--decision-green)',
  done: 'var(--decision-muted)',
  open: 'var(--decision-muted)',
};

/** 表格看法：一行一个节点，能按状态筛，点一行打开侧栏。 */
export function TableView({ nodes, selected, open }: ViewProps) {
  const [filter, setFilter] = react.useState<StateKey | 'all'>('all');
  const [height, setHeight] = react.useState(1);
  const viewport = react.useRef<HTMLDivElement>(null);
  const byId = react.useMemo(() => new Map(nodes.map((entry) => [entry.id, entry])), [nodes]);

  //M 未开始的功能只在“全部”里出现，筛选后只渲染可见行。
  const rows = react.useMemo(() => nodes.filter((entry) => {
    if (filter === 'all') return true;

    const state = getState(entry);
    return state.key === filter;
  }), [nodes, filter]);

  react.useLayoutEffect(() => {
    //G 表格装好后再读取可用高度。
    const element = viewport.current;
    if (element === null) return;

    //M 跟随画布高度，窗口变化后仍可滚到最后一行。
    const measure = () => {
      const available = element.clientHeight - TABLE_HEADER_HEIGHT;
      setHeight(Math.max(1, available));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  /** 键盘回车或空格也能打开一行。 */
  const press = (event: react.KeyboardEvent, id: string): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    //M 拦下空格的页面滚动，再打开侧栏。
    event.preventDefault();
    open(id);
  };

  const columns: antd.TableColumnsType<types.DecisionNode> = [
    {
      key: 'state',
      title: t('状态'),
      width: 88,
      render: (_value, entry) => {
        const state = getState(entry);
        const style = { color: STATE_COLORS[state.key] };
        return <span className="decision-table__state" style={style}>{state.label}</span>;
      },
    },
    { dataIndex: 'title', title: t('标题'), width: 176, className: 'decision-table__title' },
    { key: 'summary', title: t('一句话'), width: 228, render: (_value, entry) => getLine(entry) },
    { key: 'branch', title: t('所属分支'), width: 132, render: (_value, entry) => getBranchTitle(entry, byId) },
    {
      key: 'options',
      title: t('要你定的选项'),
      width: 192,
      render: (_value, entry) => <OptionCell entry={entry} />,
    },
    {
      key: 'time',
      title: t('更新时间'),
      width: 144,
      className: 'decision-table__time',
      render: (_value, entry) => {
        const updated = getUpdated(entry);
        return drawer.getTime(updated);
      },
    },
  ];
  const locale = {
    emptyText: <p className="decision-view__empty">{t('这个状态下没有节点')}</p>,
  };
  const scroll = { x: TABLE_WIDTH, y: height, scrollToFirstRowOnChange: true };

  /** 虚拟行保留原定位、选中状态和点行交互。 */
  const getRowProps = (entry: types.DecisionNode) => {
    const state = getState(entry);
    const isSelected = entry.id === selected;
    const style: react.CSSProperties = { cursor: 'pointer' };
    if (state.key === 'pending') {
      style.background = '#2a1f29';
    }
    if (isSelected) {
      style.background = '#1f2938';
    }

    return {
      'data-state': state.key,
      'data-node-id': entry.id,
      'aria-selected': isSelected,
      tabIndex: 0,
      style,
      onClick: () => open(entry.id),
      onKeyDown: (event: react.KeyboardEvent) => press(event, entry.id),
    };
  };

  //M 顶上一排筛选，下面是可横向滚动的虚拟表。
  return (
    <div className="decision-view decision-table">
      <div className="decision-filters" role="group" aria-label={t('按状态筛')}>
        {FILTERS.map((item) => (
          <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="decision-table__scroll" ref={viewport}>
        <antd.ConfigProvider theme={TABLE_THEME}>
          <antd.Table
            size="small"
            virtual
            pagination={false}
            rowKey="id"
            columns={columns}
            dataSource={rows}
            scroll={scroll}
            locale={locale}
            onRow={getRowProps}
          />
        </antd.ConfigProvider>
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
  /** 此行可以展开下级。 */
  hasChildren: boolean;
}

/** 同级按快照顺序排列，供清单与聚焦路径使用。 */
function getChildren(nodes: types.DecisionNode[]) {
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
export function getScope(nodes: types.DecisionNode[], focus?: string) {
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

/** 为虚拟清单保留列表语义；部件引用固定，更新选中节点时不用重建清单。 */
const LIST_PARTS: virtuoso.Components<ListRow> = {
  List: react.forwardRef<HTMLDivElement, virtuoso.ListProps>(function DecisionList(props, ref) {
    return <div {...props} ref={ref} role="list" />;
  }),
};

/** 按深度优先列出所有未折叠的行，任意层都可以继续展开。 */
function getListRows(nodes: types.DecisionNode[], folds: ReadonlyMap<string, boolean>): ListRow[] {
  const root = nodes.find((entry) => entry.parent === null);
  if (root === undefined) return [];

  //M 显式栈让任意深度的分支仍按父项在前的顺序列出。
  const children = getChildren(nodes);
  const rows: ListRow[] = [];
  const stack = [{ entry: root, depth: -1 }];
  while (stack.length > 0) {
    const { entry, depth } = stack.pop()!;
    const below = children.get(entry.id) ?? [];
    const hasChildren = below.length > 0;
    rows.push({ entry, depth: Math.max(0, depth), hasChildren });
    if (folds.get(entry.id) === false) continue;

    for (let index = below.length - 1; index >= 0; index -= 1) {
      stack.push({ entry: below[index]!, depth: depth + 1 });
    }
  }
  return rows;
}

interface ListProps extends ViewProps {
  /** 与画布共用的展开状态。 */
  folds: ReadonlyMap<string, boolean>;
  /** 折叠或展开指定父节点。 */
  toggle: (id: string, expand: boolean) => void;
}

/** 清单看法：按一级分支分组的缩进列表，手机上最好读。 */
export function ListView({ nodes, selected, open, folds, toggle }: ListProps) {
  //M 快照更新时才重新摊平分支，滚动时只生成视口附近的行。
  const rows = react.useMemo(() => getListRows(nodes, folds), [nodes, folds]);
  if (rows.length === 0) return <p className="decision-view__empty">{t('还没有决策节点')}</p>;

  /** 一行就是一个按钮，点了打开侧栏。 */
  const getItem = (index: number, row: ListRow) => {
    const entry = row.entry;
    const state = getState(entry);
    const indent = { paddingLeft: `min(${String(12 + row.depth * 18)}px, 25vw)` };
    const expanded = folds.get(entry.id) !== false;
    const labelArgs = { title: entry.title };
    let foldLabel = t('展开「{title}」下的子项', labelArgs);
    let foldIcon = '+';
    if (expanded) {
      foldLabel = t('折叠「{title}」下的子项', labelArgs);
      foldIcon = '−';
    }
    const button = (
      <button
        type="button"
        className="decision-list__item"
        style={indent}
        data-state={state.key}
        data-node-id={entry.id}
        aria-pressed={entry.id === selected}
        onClick={() => open(entry.id)}
      >
        <span className="decision-list__state">{state.label}</span>
        <span className="decision-list__title">{entry.title}</span>
      </button>
    );
    const item = (
      <div className="decision-list__row">
        {button}
        {row.hasChildren && (
          <button
            className="decision-task-button"
            type="button"
            data-fold-node={entry.id}
            aria-expanded={expanded}
            aria-label={foldLabel}
            title={foldLabel}
            onClick={() => toggle(entry.id, !expanded)}
          >{foldIcon}</button>
        )}
      </div>
    );

    //M 分支标题保留原来的分隔线和名称，同时作为可点击的节点行。
    if (index > 0 && row.depth === 0) {
      return (
        <div role="listitem">
          <section className="decision-list__section" aria-label={entry.title}>
            {item}
          </section>
        </div>
      );
    }

    return <div role="listitem">{item}</div>;
  };

  //M 清单占满原视图，由 Virtuoso 按每行实际高度滚动。
  return (
    <div className="decision-view decision-list" style={{ display: 'block', overflow: 'hidden' }}>
      <virtuoso.Virtuoso
        data={rows}
        components={LIST_PARTS}
        computeItemKey={(_index, row) => row.entry.id}
        itemContent={getItem}
      />
    </div>
  );
}
