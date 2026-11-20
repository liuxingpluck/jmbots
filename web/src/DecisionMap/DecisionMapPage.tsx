/** 决策图整页，保持快照最新，提交用户的点选和写的话，可在放射、思维导图、表格、清单四种看法间切换。 */
import * as react from 'react';
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as api from './DecisionMapApi.ts';
import * as drawer from './Drawer.tsx';
import * as layout from './Layout.ts';
import * as nodes from './Nodes.tsx';
import * as views from './Views.tsx';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 四种看法：放射图、思维导图、表格、清单。 */
type Look = 'radial' | 'mind' | 'table' | 'list';

const NODE_TYPES = { decision: nodes.DecisionNode };
const ORIGIN: xyflow.NodeOrigin = [0.5, 0.5];
const FIT: xyflow.FitViewOptions = {
  padding: { top: '24px', bottom: '48px', left: '24px', right: '24px' },
  maxZoom: 1,
};
const FIT_MOBILE: xyflow.FitViewOptions = {
  padding: { top: '12px', bottom: '44px', left: '8px', right: '8px' },
  maxZoom: 1,
};
const REFRESH_MS = 2400;
const MOBILE_WIDTH = 670;
/** 浏览器里记看法和思维导图方向的键。 */
const LOOK_KEY = 'jmbots.decision-map.look';
const DIRECTION_KEY = 'jmbots.decision-map.direction';
/** 看法切换按钮，顺序即显示顺序。 */
const LOOKS: { key: Look; label: string }[] = [
  //M 按钮文字在打开页面时按当前语言译好。
  { key: 'mind', label: t('思维导图') },
  { key: 'radial', label: t('放射') },
  { key: 'table', label: t('表格') },
  { key: 'list', label: t('清单') },
];

/** 读浏览器里记着的一项；隐私模式等读不了时是 null。 */
function readStored(key: string): string | null {
  //G 本地存储可能被浏览器禁用，读不到就当没记过。
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 记下一项；写不了就算了，下次打开用默认看法。 */
function writeStored(key: string, value: string): void {
  //G 本地存储写满或被禁用时不影响切换本身。
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

/** 打开时用哪种看法：记着的优先；没记过时手机用清单，宽屏用思维导图。 */
function getStartLook(): Look {
  //M 先看浏览器记着的看法，认得出才用。
  const stored = readStored(LOOK_KEY);
  const known = LOOKS.find((item) => item.key === stored);
  if (known !== undefined) return known.key;
  if (window.innerWidth <= MOBILE_WIDTH) return 'list';

  return 'mind';
}

/** 思维导图方向：记着“上下”就上下，默认左右。 */
function getStartDirection(): layout.MindDirection {
  //M 只有记着“上下”时才竖排。
  const stored = readStored(DIRECTION_KEY);
  if (stored === 'down') return 'down';

  return 'sides';
}

/** 画布入口。主线、分叉与选项共用服务端当前快照。 */
export function DecisionMapPage() {
  const [graph, setGraph] = react.useState<types.DecisionGraph>();
  const [loadingError, setLoadingError] = react.useState<string>();
  const focusLink = new URLSearchParams(window.location.search).get('focus') ?? undefined;
  const [nodeId, setNodeId] = react.useState<string | undefined>(focusLink);
  const [projectRoot, setProjectRoot] = react.useState<string>();
  const [saving, setSaving] = react.useState<string>();
  const [chooseError, setChooseError] = react.useState<string>();
  const [mode, setMode] = react.useState<layout.ViewMode>('main');
  const [look, setLook] = react.useState<Look>(getStartLook);
  const [direction, setDirection] = react.useState<layout.MindDirection>(getStartDirection);
  const [sending, setSending] = react.useState(false);
  const [noteError, setNoteError] = react.useState<string>();
  const [folds, setFolds] = react.useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [focused, setFocused] = react.useState<string>();
  const canvas = react.useRef<HTMLElement>(null);
  const flow = react.useRef<xyflow.ReactFlowInstance<layout.FlowNode> | undefined>(undefined);
  const lastPending = react.useRef<string | undefined>(undefined);
  const [size, setSize] = react.useState({ width: 0, height: 0 });
  const portrait = size.width <= MOBILE_WIDTH;

  react.useLayoutEffect(() => {
    const element = canvas.current;
    if (element === null) return;

    //M 用画布的实际尺寸排图，顶栏换行和手机竖屏都计入可用空间。
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) => {
        if (current.width === width && current.height === height) return current;

        return { width, height };
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    //M 第一次渲染前取得尺寸，避免等下一次窗口变化才出现图。
    measure();
    return () => observer.disconnect();
  }, []);

  const refresh = react.useCallback(async (signal?: AbortSignal) => {
    try {
      //M 版本没变时保留上次的节点数组，画布位置和缩放都不会跳动。
      const next = await api.getGraph(signal);
      setGraph((current) => {
        if (current === undefined || next.revision > current.revision) return next;
        if (next.revision < current.revision) return current;

        //M 工作区改名不写新的决策流水，同版本也更新项目栏。
        if (JSON.stringify(next.projects) !== JSON.stringify(current.projects)) {
          return { ...current, projects: next.projects };
        }

        return current;
      });
      setLoadingError(undefined);
    } catch (error) {
      if (signal?.aborted === true) return;

      let message = String(error);
      if (error instanceof Error) message = error.message;
      setLoadingError(message);
    }
  }, []);
  react.useEffect(() => {
    const control = new AbortController();

    //M 中控提交新节点或确认收到后，打开的画布自动跟上。
    void refresh(control.signal);
    const timer = window.setInterval(() => { void refresh(control.signal); }, REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      control.abort();
    };
  }, [refresh]);

  const open = react.useCallback((id: string, expand?: boolean) => {
    if (expand !== undefined) {
      //M 按节点编号保存开关，切换视图和轮询后仍可继续读同一分支。
      setFolds((current) => new Map(current).set(id, expand));
      return;
    }
    setChooseError(undefined);
    setNoteError(undefined);
    setNodeId(id);
  }, []);
  const close = react.useCallback(() => {
    setChooseError(undefined);
    setNoteError(undefined);
    setNodeId(undefined);
  }, []);
  react.useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);

  const projects = graph?.projects ?? [];
  const linkedNode = graph?.nodes.find((node) => node.id === focusLink);
  let root = projectRoot ?? projects[0]?.root;
  if (projectRoot === undefined && linkedNode !== undefined) {
    //M 分享的链接直接打开对应项目，未指定节点时使用第一个项目。
    const linkedRoot = graph?.nodes.find((node) => {
      return node.parent === null && node.bot === linkedNode.bot && node.workspaceId === linkedNode.workspaceId;
    });
    root = linkedRoot?.id ?? root;
  }
  //M 先按项目筛节点，再按选择的子树聚焦，四种看法共享范围。
  const scope = react.useMemo(() => {
    const entries = graph?.nodes ?? [];
    const project = views.getScope(entries, root);
    return views.getScope(project.nodes, focused);
  }, [graph, root, focused]);

  /** 进子树或回上层。聚焦根至少展开一层。 */
  function focusTree(id?: string): void {
    close();
    setFocused(id);
    if (id !== undefined) open(id, true);
  }

  /** 选择项目后关闭上一个项目的详情和子树焦点。 */
  function selectProject(id: string): void {
    if (id === root) return;

    focusTree();
    setProjectRoot(id);
  }

  //M 视图变化后重新布置节点，普通的轮询维持画布位置。
  const diagram = react.useMemo(() => {
    if (size.width === 0 || size.height === 0) return { nodes: [], edges: [] };

    const view = { mode, folds, portrait, ...size };
    if (scope.path.length > 0) view.mode = 'all';
    //M 卡片和连线按此时的画布比例和看法一起计算；表格和清单不用画布。
    if (look === 'mind') return layout.getMindLayout(scope.nodes, view, open, direction);
    if (look === 'radial') return layout.getLayout(scope.nodes, view, open);

    return { nodes: [], edges: [] };
  }, [scope, mode, folds, portrait, size, open, look, direction]);
  const isCanvas = look === 'mind' || look === 'radial';
  const pending = scope.nodes.filter((node) => node.kind === 'pending' && node.status === 'open');
  const selected = graph?.nodes.find((node) => node.id === nodeId);
  let fit = FIT;
  if (portrait) {
    fit = FIT_MOBILE;
  }

  /** 切换到明确选中的视图。 */
  function changeMode(next: layout.ViewMode): void {
    if (mode === next) return;

    //M 切换视图时关闭旧的说明，让新卡片使用自己的缩放范围。
    close();
    setMode(next);
  }

  /** 切换看法并记在浏览器里，下次打开还是这个。 */
  function changeLook(next: Look): void {
    if (look === next) return;

    //M 侧栏保持打开，换个看法接着看同一个节点。
    writeStored(LOOK_KEY, next);
    setLook(next);
  }

  /** 思维导图在左右和上下之间切换，同样记在浏览器里。 */
  function changeDirection(next: layout.MindDirection): void {
    if (direction === next) return;

    //M 方向变了要重新布局，记下来下次打开照旧。
    writeStored(DIRECTION_KEY, next);
    setDirection(next);
  }

  /** 从顶栏依次飞到下一件待定事项，不因关闭抽屉而重置顺序。 */
  function openPending(): void {
    if (pending.length === 0) return;

    const current = pending.findIndex((node) => node.id === lastPending.current);
    const next = pending[(current + 1) % pending.length]!;
    lastPending.current = next.id;
    open(next.id);

    const map = flow.current;
    const target = diagram.nodes.find((node) => node.id === next.id);
    if (map === undefined || target === undefined) return;

    //M 窄屏说明从底部打开，把目标放到说明上方。减少动态效果时立即定位。
    const zoom = Math.max(1.08, map.getZoom());
    let y = target.position.y;
    if (portrait) y += size.height * 0.28 / zoom;
    let duration = 480;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0;
    const camera = { zoom, duration };
    void map.setCenter(target.position.x, y, camera);
  }

  const connect = react.useCallback((map: xyflow.ReactFlowInstance<layout.FlowNode>) => {
    //M 顶栏依次定位到待定卡片时沿用当前视图的 React Flow 实例。
    flow.current = map;
  }, []);

  /** 把当前选项持久化，成功后用回执立刻更新这个节点。 */
  async function chooseOption(option: string): Promise<void> {
    if (selected === undefined || saving !== undefined) return;

    setSaving(option);
    setChooseError(undefined);
    try {
      //M 服务端保留互斥选择。同一点击只在拿到结果后显示已定。
      const chosen = await api.choose(selected.id, option);
      setGraph((current) => {
        if (current === undefined) return current;

        const entries = current.nodes.map((node) => {
          if (node.id === chosen.node.id && node.chosen === undefined) return chosen.node;

          return node;
        });
        return { ...current, nodes: entries };
      });
      await refresh();
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      setChooseError(message);
      await refresh();
    } finally {
      setSaving(undefined);
    }
  }

  /**
   * 把用户写的话发给中控，可一并带上选项。
   * @param text 写的话。
   * @param option 同时选的选项号。
   * @returns 发成功是 true，侧栏据此清空输入框。
   */
  async function sendNote(text: string, option?: string): Promise<boolean> {
    if (selected === undefined || sending) return false;

    setSending(true);
    setNoteError(undefined);
    try {
      //M 服务端记下后版本号变大，刷新一次面板就能看到这条话。
      await api.addNote(selected.id, text, option);
      await refresh();
      return true;
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      setNoteError(message);
      await refresh();
      return false;
    } finally {
      setSending(false);
    }
  }

  const submit = (id: string): void => {
    //M 侧栏点击直接提交，错误和禁用状态由页面维护。
    void chooseOption(id);
  };
  let empty = '还没有决策节点';
  if (graph === undefined) empty = '正在读取决策图';
  if (loadingError !== undefined) empty = loadingError;

  //M 画布区域的读屏名称跟着语言包走。
  const canvasLabel = t('工作决策');

  //M 画布保留缩放和拖动，选项栏仅在用户选中节点时打开。
  return (
    <main className="decision-page">
      <header className="decision-bar">
        <div className="decision-bar__title">
          <a href="/" className="decision-back" aria-label="返回 jmbots" title="返回 jmbots">‹</a>
          <h1>{canvasLabel}</h1>
        </div>
        {isCanvas && scope.path.length === 0 && (
          <div className="decision-filters" role="group" aria-label="画布显示范围">
            <button type="button" aria-pressed={mode === 'main'} onClick={() => changeMode('main')}>当前进展</button>
            <button type="button" aria-pressed={mode === 'pending'} onClick={() => changeMode('pending')}>只看待定</button>
            <button type="button" aria-pressed={mode === 'all'} onClick={() => changeMode('all')}>全部分支</button>
          </div>
        )}
        <div className="decision-looks">
          <div className="decision-filters" role="group" aria-label={t('看法')}>
            <span className="decision-looks__label">{t('看法')}</span>
            {LOOKS.map((item) => (
              <button
                key={item.key}
                type="button"
                data-look={item.key}
                aria-pressed={look === item.key}
                onClick={() => changeLook(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {look === 'mind' && (
            <div className="decision-filters" role="group" aria-label={t('思维导图方向')}>
              <button
                type="button"
                data-dir="lr"
                aria-pressed={direction === 'sides'}
                onClick={() => changeDirection('sides')}
              >
                {t('左右')}
              </button>
              <button
                type="button"
                data-dir="tb"
                aria-pressed={direction === 'down'}
                onClick={() => changeDirection('down')}
              >
                {t('上下')}
              </button>
            </div>
          )}
        </div>
        {pending.length > 0 && (
          <button type="button" className="decision-pending" onClick={openPending}>
            <span aria-hidden="true">★</span> {pending.length} 件待你决定
          </button>
        )}
        {pending.length === 0 && graph !== undefined && <span className="decision-all-clear">当前无待定项</span>}
      </header>
      {scope.path.length > 0 && (
        <nav className="decision-breadcrumb" aria-label={t('任务树路径')}>
          <button type="button" data-tree-root onClick={() => focusTree()}>{t('全部节点')}</button>
          {scope.path.map((entry) => {
            if (entry.id === focused) return <span key={entry.id} aria-current="location">{entry.title}</span>;

            return (
              <button type="button" key={entry.id} data-tree-ancestor={entry.id} onClick={() => focusTree(entry.id)}>
                {entry.title}
              </button>
            );
          })}
        </nav>
      )}

      <div className="decision-content">
        {projects.length > 0 && (
          <nav className="decision-projects" aria-label={t('项目')}>
            {projects.map((project) => (
              <button
                key={project.root}
                type="button"
                aria-pressed={project.root === root}
                onClick={() => selectProject(project.root)}
              >
                {project.name}
              </button>
            ))}
          </nav>
        )}
        <section className="decision-canvas" aria-label={canvasLabel} ref={canvas} data-look={look}>
          {isCanvas && diagram.nodes.length > 0 && (
            <xyflow.ReactFlow<layout.FlowNode>
              key={`${root ?? ''}-${look}-${direction}-${mode}-${size.width}x${size.height}-${focused ?? ''}`}
              nodes={diagram.nodes}
              edges={diagram.edges}
              nodeTypes={NODE_TYPES}
              nodeOrigin={ORIGIN}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              fitView
              fitViewOptions={fit}
              minZoom={0.08}
              maxZoom={2}
              className="dark"
              onInit={connect}
              onPaneClick={close}
            >
              <xyflow.Background gap={26} size={1.2} color="#303a50" />
              <xyflow.Controls position="bottom-right" showInteractive={false} fitViewOptions={fit} />
            </xyflow.ReactFlow>
          )}
          {isCanvas && diagram.nodes.length === 0 && <div className="decision-empty" role="status">{empty}</div>}
          {!isCanvas && graph === undefined && <div className="decision-empty" role="status">{empty}</div>}
          {look === 'table' && graph !== undefined && (
            <views.TableView nodes={scope.nodes} selected={nodeId} open={open} />
          )}
          {look === 'list' && graph !== undefined && (
            <views.ListView nodes={scope.nodes} selected={nodeId} open={open} folds={folds} toggle={open} />
          )}
          {isCanvas && diagram.nodes.length > 0 && (
            <ul className="decision-legend" aria-label="图例">
              <li><i data-tone="main" />主线</li>
              <li><i data-tone="pending" />待定</li>
              <li><i data-tone="working" />进行中</li>
              <li><i data-tone="confirmed" />中控已确认</li>
            </ul>
          )}
          {selected !== undefined && (
            <drawer.Drawer
              key={selected.id}
              node={selected}
              saving={saving}
              error={chooseError}
              close={close}
              choose={submit}
              sending={sending}
              noteError={noteError}
              send={sendNote}
              focus={() => focusTree(selected.id)}
              refresh={refresh}
              expand={(id) => open(id, true)}
            />
          )}
        </section>
      </div>
    </main>
  );
}
