/** 教程“骨架逐行”视图：一份骨架文件拆成的树，画布可拖可缩放，点节点看代码和解释。 */
import * as react from 'react';
import * as reactDom from 'react-dom';
import * as antd from 'antd';
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
const FILES = [
  'Main.json', 'Resources.json', 'Tools.json', 'Sessions.json', 'channels插件.json', '进程插件.json', 'Cordis.json',
];
/** 进程插件那张不是逐行，是主程序、programs、二进制三方的握手流程。 */
const HANDSHAKE_FILE = '进程插件.json';
/** channels 是 plugins/channels/ 里五个文件的讲解，不是骨架单个文件。 */
const CHANNELS_FILE = 'channels插件.json';

/** 下拉和引导句里显示的名字：骨架文件显示成 .ts，握手图单独起名。 */
function getFileLabel(file: string): string {
  if (file === HANDSHAKE_FILE) return '进程插件（三方握手）';
  if (file === CHANNELS_FILE) return 'channels 插件（渠道协议）';
  if (file === 'Cordis.json') return 'Cordis 插件生命周期';

  return file.replace(/\.json$/u, '.ts');
}

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

/** 包含某行号的最细节点（行号范围最短的那个）；找不到返回 undefined。 */
function findLineNode(nodes: readonly LineNode[], line: number): LineNode | undefined {
  let best: LineNode | undefined;
  let bestSpan = Infinity;
  for (const node of nodes) {
    //M 行号范围写在 body 开头：**行号：L73–L76**。
    const hit = /\*\*行号：L(\d+)(?:–L(\d+))?\*\*/u.exec(node.body);
    if (hit === null) continue;

    const from = Number(hit[1]);
    const to = Number(hit[2] ?? hit[1]);
    if (line < from || line > to) continue;
    if (to - from >= bestSpan) continue;

    best = node;
    bestSpan = to - from;
  }
  return best;
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
  //M 折叠着显示＋，展开着显示－。
  let mark = '－';
  if (card.folded) mark = '＋';
  return (
    <div className={className} onClick={card.pick}>
      <xy.Handle type="source" position={xy.Position.Left} id="left" />
      <xy.Handle type="source" position={xy.Position.Right} id="right" />
      <xy.Handle type="target" position={xy.Position.Left} id="left" />
      <xy.Handle type="target" position={xy.Position.Right} id="right" />
      <xy.Handle type="source" position={xy.Position.Bottom} id="bottom" />
      <xy.Handle type="target" position={xy.Position.Top} id="top" />
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
  /** 左栏当前选中的模块名。 */
  plugin: string;
  /** 下拉选择同步回左栏。 */
  onSelectPlugin: (name: string) => void;
  /** 共用工具栏的左右或上下方向。 */
  direction: layout.MindDirection;
  /** 三栏时右侧详情里留给块详情的位置；没有就在画布旁边显示。 */
  detailHost: HTMLElement | null;
  /** 点了一块，请右侧详情切过来显示它。 */
  onDetail: () => void;
}

/** 左栏选文件，中间画布，右边详情。 */
export function LinesView(props: ViewProps): react.JSX.Element {
  const { t, plugin, onSelectPlugin, direction, detailHost, onDetail } = props;
  const [files, setFiles] = react.useState<string[]>([]);
  const [nodes, setNodes] = react.useState<LineNode[]>([]);
  const [failed, setFailed] = react.useState(false);
  const [folded, setFolded] = react.useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = react.useState('');
  const [selectedId, setSelectedId] = react.useState('');
  const [flowNodes, setFlowNodes, onNodesChange] = xy.useNodesState<Card>([]);
  const moved = react.useRef(new Map<string, { x: number; y: number }>());
  const flow = react.useRef<xy.ReactFlowInstance<Card> | null>(null);
  const fitting = react.useRef(true);
  //M 链接跳转的待办：跨文件时先记下，等新文件加载完再定位；centerId 等画布换好卡片再居中。
  const pending = react.useRef<{ file: string; line: number } | null>(null);
  const centerId = react.useRef('');
  //M 左栏和下拉共用模块名，插件说明不属于骨架时回到入口 Main。
  const requested = FILES.find((file) => file.toLowerCase() === `${plugin}.json`);
  const name = requested ?? 'Main.json';

  react.useEffect(() => {
    //M 进入视图先取文件清单，打开哪份由左栏选中的骨架模块决定。
    const loading = api.TutorialApi.get<{ files: string[] }>('/api/tutorial/lines');
    void loading.then((result) => {
      //M 清单按骨架进入顺序排，不依赖后端文件系统顺序。
      const ordered = FILES.filter((file) => result.files.includes(file));
      setFiles(ordered);
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
      moved.current = new Map();
      setFailed(false);
      setNodes(list);
      //M 打开时全部展开，＋/－ 仍可手动折叠。
      setFolded(new Set());
      setFocusId('');
      setSelectedId('');
    }, () => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [name]);

  const tree = react.useMemo(() => getLineTree(nodes), [nodes]);

  react.useEffect(() => {
    if (selectedId === '') return;

    //M 选中一块就请右侧详情切到块详情。
    onDetail();
  }, [selectedId]);

  const locate = (line: number): void => {
    //M 选包含该行的最细节点，展开它的祖先，退出子树聚焦，选中并等画布居中。
    const target = findLineNode(nodes, line);
    if (target === undefined) return;

    const open = new Set<string>();
    let parent = target.parent;
    while (parent !== null) {
      open.add(parent);
      parent = nodes.find((item) => item.id === parent)?.parent ?? null;
    }
    setFolded((current) => new Set([...current].filter((id) => !open.has(id))));
    setFocusId('');
    setSelectedId(target.id);
    centerId.current = target.id;
  };

  react.useEffect(() => {
    //M 新文件加载完（nodes 变了）才处理跨文件的待定位。
    const todo = pending.current;
    if (todo === null || todo.file !== name || nodes.length === 0) return;

    pending.current = null;
    locate(todo.line);
  }, [nodes]);

  const onHashLink = (href: string): void => {
    //M #plugin=名字 切到左栏那个插件；#lines=文件.json&line=行号 切文件并定位。
    const params = new URLSearchParams(href.slice(1));
    const pluginName = params.get('plugin');
    if (pluginName !== null) {
      onSelectPlugin(pluginName);
      return;
    }

    const file = params.get('lines');
    const line = Number(params.get('line'));
    if (file === null || Number.isNaN(line)) return;
    if (file === name) {
      locate(line);
      return;
    }

    pending.current = { file, line };
    onSelectPlugin(file.replace(/\.json$/u, '').toLowerCase());
  };

  const chart = react.useMemo(() => {
    if (tree === undefined) return { cards: [] as Card[], edges: [] as xy.Edge[] };

    const top = findBranch(tree, focusId);
    //M 折叠的节点不给子，布局只排看得见的。
    const children = (branch: LineBranch): readonly LineBranch[] => {
      if (folded.has(branch.node.id)) return [];

      return branch.children;
    };
    let spacing = { breadth: 100, depth: 290 };
    if (direction === 'down') spacing = { breadth: 290, depth: 120 };
    //M 借上下树保持兄弟顺序；横排时交换坐标，所有子都在右边。
    const points = layout.getMindPoints(top, children, 'down', spacing);
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
        focus: () => {
          //M 只看这棵子树时子树也全展开。
          setFolded(new Set());
          setFocusId(id);
        },
        pick: () => setSelectedId(id),
      };
      let arranged = position;
      if (direction === 'sides') arranged = { x: position.y, y: position.x };
      const place = moved.current.get(id) ?? arranged;
      cards.push({ id, type: 'lineCard', position: place, data });
      if (parent === undefined) continue;

      let sourceHandle = 'right';
      let targetHandle = 'left';
      if (direction === 'down') {
        sourceHandle = 'bottom';
        targetHandle = 'top';
      }
      edges.push({ id: `${parent.node.id}→${id}`, source: parent.node.id, target: id, sourceHandle, targetHandle });
    }
    return { cards, edges };
  }, [tree, folded, focusId, selectedId, direction]);

  react.useEffect(() => {
    //M 布局变了就换一套卡片，拖过的卡片保持原位。
    setFlowNodes(chart.cards);
  }, [chart]);

  react.useEffect(() => {
    //M 换文件、子树或方向才重新适应；等卡片真正换进画布后再适应，折叠展开和缩放不触发。
    fitting.current = true;
  }, [name, focusId, direction, tree]);

  react.useEffect(() => {
    const instance = flow.current;
    if (instance === null || flowNodes.length === 0) return;

    //M 有待居中的节点就居中它，不再整体适应。
    const target = flowNodes.find((card) => card.id === centerId.current);
    if (target !== undefined && selectedId === target.id) {
      centerId.current = '';
      fitting.current = false;
      void instance.setCenter(target.position.x, target.position.y, { zoom: 1, duration: 300 });
      return;
    }
    if (!fitting.current) return;

    fitting.current = false;
    void instance.fitView(FIT);
  }, [flowNodes]);

  const onInit = (instance: xy.ReactFlowInstance<Card>): void => {
    //M 记下这块画布自己的实例，之后的适应视图只作用于它。
    flow.current = instance;
  };

  const onDragStop = (_event: unknown, node: Card): void => {
    //M 记下拖动后的位置，之后展开折叠重排时不被挪回去。
    moved.current.set(node.id, node.position);
  };

  const onPickFile = (file: string): void => {
    //M 下拉换文件时改左栏选中项，由同一个路由带回这份文件。
    const module = file.replace(/\.json$/u, '').toLowerCase();
    onSelectPlugin(module);
  };

  const selected = nodes.find((item) => item.id === selectedId);
  const fileLabel = t('选择文件');
  const allLabel = t('看全部');
  const failLabel = t('读不到骨架逐行');
  const sourceLabel = t('来源');
  //M 没选块时的一句引导，带上当前源文件名；握手图换一句。
  const sourceName = getFileLabel(name);
  const introParams = { file: `src7/${sourceName}` };
  let introLabel = t('这是 {file} 的逐行图，点块看每段代码', introParams);
  if (name === HANDSHAKE_FILE) introLabel = t('这是进程插件三方握手的流程图，点块看每一步');
  if (name === CHANNELS_FILE) introLabel = t('这是 plugins/channels/ 五个文件的讲解，点块看每段代码');
  if (name === 'Cordis.json') introLabel = '这是插件从挂上到卸下的示意图，按编号读；不是本次运行的录屏。';
  //M 下拉里按源文件名显示，值仍是 JSON 文件名。
  const fileOptions = files.map((file) => ({ value: file, label: getFileLabel(file) }));

  //M 块详情：三栏时放进右侧详情，没有位置就放在画布旁边。
  const detail = (
    <>
      {selected === undefined && tree !== undefined && (
        <aside className="tu-lines-detail">
          <p>{introLabel}</p>
          <ol>
            {tree.children.map((branch) => (
              <li key={branch.node.id}>
                <button type="button" onClick={() => setSelectedId(branch.node.id)}>{branch.node.title}</button>
              </li>
            ))}
          </ol>
        </aside>
      )}
      {selected !== undefined && (
        <aside className="tu-lines-detail">
          <h3>{selected.title}</h3>
          <p>{selected.summary}</p>
          <readme.MarkdownContent body={selected.body} onHashLink={onHashLink} />
          <p className="tu-muted">{sourceLabel}：{selected.sources.join('、')}</p>
        </aside>
      )}
    </>
  );

  return (
    <div className="tu-lines">
      <div className="tu-lines-bar">
        <antd.Select
          aria-label={fileLabel}
          data-testid="tutorial-lines-file"
          size="small"
          popupMatchSelectWidth={false}
          value={name}
          options={fileOptions}
          onChange={onPickFile}
        />
        {focusId !== '' && <button type="button" onClick={() => setFocusId('')}>{allLabel}</button>}
      </div>
      {failed && <p className="tu-mind-empty" role="alert">{failLabel}</p>}
      <div className="tu-lines-main">
        <xy.ReactFlow
          nodes={flowNodes}
          edges={chart.edges}
          nodeTypes={TYPES}
          nodeOrigin={ORIGIN}
          onNodesChange={onNodesChange}
          onInit={onInit}
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
        {detailHost === null && detail}
      </div>
      {detailHost !== null && reactDom.createPortal(detail, detailHost)}
    </div>
  );
}
