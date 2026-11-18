/** 决策图整页，保持快照最新并直接提交用户的点选。 */
import * as react from 'react';
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/decision-map/Types.ts';
import * as api from './DecisionMapApi.ts';
import * as drawer from './Drawer.tsx';
import * as layout from './Layout.ts';
import * as nodes from './Nodes.tsx';

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

/** 画布入口。主线、分叉与选项共用服务端当前快照。 */
export function DecisionMapPage() {
  const [graph, setGraph] = react.useState<types.DecisionGraph>();
  const [loadingError, setLoadingError] = react.useState<string>();
  const [nodeId, setNodeId] = react.useState<string>();
  const [saving, setSaving] = react.useState<string>();
  const [chooseError, setChooseError] = react.useState<string>();
  const [mode, setMode] = react.useState<layout.ViewMode>('main');
  const [expanded, setExpanded] = react.useState<ReadonlySet<string>>(() => new Set());
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

  const open = react.useCallback((id: string, isFold = false) => {
    if (isFold) {
      //M 展开状态由节点编号保留，轮询刷新后同一分组仍然打开。
      setExpanded((current) => {
        const next = new Set(current);
        if (next.delete(id)) return next;

        next.add(id);
        return next;
      });
      return;
    }
    setChooseError(undefined);
    setNodeId(id);
  }, []);
  const close = react.useCallback(() => {
    setChooseError(undefined);
    setNodeId(undefined);
  }, []);
  react.useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);

  //M 视图变化后重新布置节点，普通的轮询维持画布位置。
  const diagram = react.useMemo(() => {
    const entries = graph?.nodes ?? [];
    if (size.width === 0 || size.height === 0) return { nodes: [], edges: [] };

    const view = { mode, expanded, portrait, ...size };
    //M 卡片和连线按此时的画布比例一起计算。
    return layout.getLayout(entries, view, open);
  }, [graph, mode, expanded, portrait, size, open]);
  const pending = graph?.nodes.filter((node) => node.kind === 'pending' && node.status === 'open') ?? [];
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

  const submit = (id: string): void => {
    //M 侧栏点击直接提交，错误和禁用状态由页面维护。
    void chooseOption(id);
  };
  let empty = '还没有决策节点';
  if (graph === undefined) empty = '正在读取决策图';
  if (loadingError !== undefined) empty = loadingError;

  //M 画布保留缩放和拖动，选项栏仅在用户选中节点时打开。
  return (
    <main className="decision-page">
      <header className="decision-bar">
        <div className="decision-bar__title">
          <a href="/" className="decision-back" aria-label="返回 jmbots" title="返回 jmbots">‹</a>
          <h1>决策图</h1>
        </div>
        <div className="decision-filters" role="group" aria-label="画布显示范围">
          <button type="button" aria-pressed={mode === 'main'} onClick={() => changeMode('main')}>当前进展</button>
          <button type="button" aria-pressed={mode === 'pending'} onClick={() => changeMode('pending')}>只看待定</button>
          <button type="button" aria-pressed={mode === 'all'} onClick={() => changeMode('all')}>全部分支</button>
        </div>
        {pending.length > 0 && (
          <button type="button" className="decision-pending" onClick={openPending}>
            <span aria-hidden="true">★</span> {pending.length} 件待你决定
          </button>
        )}
        {pending.length === 0 && graph !== undefined && <span className="decision-all-clear">当前无待定项</span>}
      </header>

      <section className="decision-canvas" aria-label="放射决策图" ref={canvas}>
        {diagram.nodes.length > 0 && (
          <xyflow.ReactFlow<layout.FlowNode>
            key={`${mode}-${size.width}x${size.height}-${expanded.size}`}
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
        {diagram.nodes.length === 0 && <div className="decision-empty" role="status">{empty}</div>}
        {diagram.nodes.length > 0 && (
          <ul className="decision-legend" aria-label="图例">
            <li><i data-tone="main" />主线</li>
            <li><i data-tone="pending" />待定</li>
            <li><i data-tone="working" />进行中</li>
            <li><i data-tone="confirmed" />中控已确认</li>
          </ul>
        )}
        {selected !== undefined && (
          <drawer.Drawer
            node={selected}
            saving={saving}
            error={chooseError}
            close={close}
            choose={submit}
          />
        )}
      </section>
    </main>
  );
}
