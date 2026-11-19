/** 教程“骨架逐行”视图：一份骨架文件拆成的树，画布可拖可缩放，点节点看代码和解释。 */
import * as react from 'react';
import * as xy from '@xyflow/react';
import * as i18n from '../I18n.ts';
import * as layout from '../Shared/MindMap.ts';
import * as api from './TutorialApi.ts';
import * as readme from './ReadmeTabs.tsx';
import '@xyflow/react/dist/style.css';

/** 骨架逐行 JSON 里的一个节点。 */
interface LineNode {
  id: string;
  parent: string | null;
  title: string;
  summary: string;
  body: string;
  sources: string[];
}

/** 排好序的树节点。 */
interface LineBranch {
  node: LineNode;
  children: LineBranch[];
}

type Card = xy.Node<LineCardData, 'lineCard'>;

interface LineCardData {
  label: string;
  selected: boolean;
  folded: boolean;
  hasChildren: boolean;
  toggle: () => void;
  focus: () => void;
  pick: () => void;
  [key: string]: unknown;
}

const ORIGIN: xy.NodeOrigin = [0.5, 0.5];
const FIT = { padding: 0.14, maxZoom: 1.2, minZoom: 0.1 };

/** 按 parent 连成树，同层按 id 排序；根是 parent 为 null 的节点。 */
function getLineTree(nodes: readonly LineNode[]): LineBranch | undefined {
  const branches = new Map<string, LineBranch>();
  for (const node of nodes) branches.set(node.id, { node, children: [] });
  let root: LineBranch | undefined;
  for (const branch of branches.values()) {
    const parent = branch.node.parent;
    if (parent === null) root = branch;
    if (parent === null) continue;

    //M 同一个父下按 id 顺序排，id 里的数字就是代码进入顺序。
    branches.get(parent)?.children.push(branch);
  }
  for (const branch of branches.values()) {
    branch.children.sort((left, right) => left.node.id.localeCompare(right.node.id));
  }
  return root;
}

/** 从树里按 id 找一棵子树。 */
function findBranch(root: LineBranch, id: string): LineBranch {
  const stack = [root];
  for (const branch of stack) {
    if (branch.node.id === id) return branch;

    stack.push(...branch.children);
  }
  return root;
}

/** 卡片：标题、折叠按钮、只看这棵子树；点卡片选中。 */
function LineCard({ data: card }: xy.NodeProps<Card>): react.JSX.Element {
  let className = 'tu-lines-card';
  if (card.selected) className += ' tu-lines-card-on';
  const mark = card.folded ? '＋' : '－';
  return (
    <div className={className} onClick={card.pick}>
      <xy.Handle type="source" position={xy.Position.Left} id="left" />
      <xy.Handle type="source" position={xy.Position.Right} id="right" />
      <xy.Handle type="target" position={xy.Position.Left} id="left" />
      <xy.Handle type="target" position={xy.Position.Right} id="right" />
      <span>{card.label}</span>
      <span className="tu-lines-tools nodrag">
        {card.hasChildren && <button type="button" onClick={card.toggle}>{mark}</button>}
        <button type="button" onClick={card.focus}>◎</button>
      </span>
    </div>
  );
}

const TYPES = { lineCard: LineCard };

interface ViewProps {
  t: i18n.Translate;
}

/** 左栏选文件，中间画布，右边详情。 */
export function LinesView({ t }: ViewProps): react.JSX.Element {
  const [files, setFiles] = react.useState<string[]>([]);
  const [name, setName] = react.useState('');
  const [nodes, setNodes] = react.useState<LineNode[]>([]);
  const [failed, setFailed] = react.useState(false);
  const [folded, setFolded] = react.useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = react.useState('');
  const [selectedId, setSelectedId] = react.useState('');
  const [flowNodes, setFlowNodes, onNodesChange] = xy.useNodesState<Card>([]);
  const moved = react.useRef(new Map<string, { x: number; y: number }>());

  react.useEffect(() => {
    //M 进入视图先取文件清单，默认打开第一份。
    const loading = api.TutorialApi.get<{ files: string[] }>('/api/tutorial/lines');
    void loading.then((result) => {
      setFiles(result.files);
      setName(result.files[0] ?? '');
    }, () => setFailed(true));
  }, []);

  react.useEffect(() => {
    if (name === '') return;

    let active = true;
    //M 换文件时清掉折叠、聚焦、选中和拖动过的位置。
    const route = `/api/tutorial/line?name=${encodeURIComponent(name)}`;
    const loading = api.TutorialApi.get<{ text: string }>(route);
    void loading.then((result) => {
      if (!active) return;

      const list = JSON.parse(result.text) as LineNode[];
      const root = getLineTree(list);
      //M 默认只展开根，看到按顺序排的各块，再逐层点开。
      const open = new Set(list.map((item) => item.id));
      open.delete(root?.node.id ?? '');
      moved.current = new Map();
      setFailed(false);
      setNodes(list);
      setFolded(open);
      setFocusId('');
      setSelectedId(root?.node.id ?? '');
    }, () => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [name]);

  const tree = react.useMemo(() => getLineTree(nodes), [nodes]);

  const chart = react.useMemo(() => {
    if (tree === undefined) return { cards: [] as Card[], edges: [] as xy.Edge[] };

    const top = findBranch(tree, focusId);
    //M 折叠的节点不给子，布局只排看得见的。
    const children = (branch: LineBranch): readonly LineBranch[] => {
      if (folded.has(branch.node.id)) return [];

      return branch.children;
    };
    const spacing = { breadth: 84, depth: 270 };
    const points = layout.getMindPoints(top, children, 'sides', spacing);
    const cards: Card[] = [];
    const edges: xy.Edge[] = [];
    for (const { item, position, parent } of points) {
      const id = item.node.id;
      const toggle = (): void => {
        setFolded((current) => {
          const next = new Set(current);
          if (next.has(id)) {
            next.delete(id);
            return next;
          }
          next.add(id);
          return next;
        });
      };
      const data: LineCardData = {
        label: item.node.title,
        selected: id === selectedId,
        folded: folded.has(id),
        hasChildren: item.children.length > 0,
        toggle,
        focus: () => setFocusId(id),
        pick: () => setSelectedId(id),
      };
      const place = moved.current.get(id) ?? position;
      cards.push({ id, type: 'lineCard', position: place, data });
      if (parent === undefined) continue;

      let sourceHandle = 'right';
      let targetHandle = 'left';
      if (position.x < 0) {
        sourceHandle = 'left';
        targetHandle = 'right';
      }
      edges.push({ id: `${parent.node.id}→${id}`, source: parent.node.id, target: id, sourceHandle, targetHandle });
    }
    return { cards, edges };
  }, [tree, folded, focusId, selectedId]);

  react.useEffect(() => {
    //M 布局变了就换一套卡片，拖过的卡片保持原位。
    setFlowNodes(chart.cards);
  }, [chart]);

  const onDragStop = (_event: unknown, node: Card): void => {
    //M 记下拖动后的位置，之后展开折叠重排时不被挪回去。
    moved.current.set(node.id, node.position);
  };

  const selected = nodes.find((item) => item.id === selectedId);
  const fileLabel = t('选择文件');
  const allLabel = t('看全部');
  const failLabel = t('读不到骨架逐行');
  const sourceLabel = t('来源');
  const frame = `${name}:${focusId}:${chart.cards.length}`;

  return (
    <div className="tu-lines">
      <div className="tu-lines-bar">
        <select aria-label={fileLabel} value={name} onChange={(event) => setName(event.target.value)}>
          {files.map((file) => <option key={file} value={file}>{file.replace(/\.json$/u, '.ts')}</option>)}
        </select>
        {focusId !== '' && <button type="button" onClick={() => setFocusId('')}>{allLabel}</button>}
      </div>
      {failed && <p className="tu-mind-empty" role="alert">{failLabel}</p>}
      <div className="tu-lines-main">
        <xy.ReactFlow
          key={frame}
          nodes={flowNodes}
          edges={chart.edges}
          nodeTypes={TYPES}
          nodeOrigin={ORIGIN}
          onNodesChange={onNodesChange}
          onNodeDragStop={onDragStop}
          nodesConnectable={false}
          className="dark"
          fitView
          fitViewOptions={FIT}
          minZoom={0.1}
        >
          <xy.Background />
          <xy.Controls showInteractive={false} />
        </xy.ReactFlow>
        {selected !== undefined && (
          <aside className="tu-lines-detail">
            <h3>{selected.title}</h3>
            <p>{selected.summary}</p>
            <readme.MarkdownContent body={selected.body} />
            <p className="tu-muted">{sourceLabel}：{selected.sources.join('、')}</p>
          </aside>
        )}
      </div>
    </div>
  );
}
