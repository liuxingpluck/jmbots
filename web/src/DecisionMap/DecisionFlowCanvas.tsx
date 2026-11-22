/**
 * 工作决策图形画布视图（思维导图 / 按日期 / 放射图），按需懒加载 @xyflow/react 与 d3-hierarchy。
 * 手机或桌面首屏进「专题目录」「四象限」时无需下载与解析重型图形库。
 */
import * as react from 'react';
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as dateMap from './DateMap.ts';
import * as layout from './Layout.ts';
import * as nodes from './Nodes.tsx';
import * as words from './Words.ts';

const t = words.t;

const NODE_TYPES = { decision: nodes.DecisionNode, day: nodes.DayNode };
const ORIGIN: xyflow.NodeOrigin = [0.5, 0.5];
const FIT: xyflow.FitViewOptions<layout.FlowNode> = {
  padding: { top: '24px', bottom: '48px', left: '24px', right: '24px' },
  maxZoom: 1,
};
const FIT_MOBILE: xyflow.FitViewOptions<layout.FlowNode> = {
  padding: { top: '44px', bottom: '68px', left: '12px', right: '12px' },
  minZoom: 0.62,
  maxZoom: 1.05,
};

/** 图形画布支持的三种看法。 */
export type CanvasLook = 'mind' | 'date' | 'radial';

/** 定位待定节点的镜头请求。 */
export interface PendingCameraRequest {
  nodeId: string;
  seq: number;
}

/** 图形画布属性。 */
export interface DecisionFlowCanvasProps {
  active: boolean;
  root?: string;
  focused?: string;
  look: CanvasLook;
  mode: layout.ViewMode;
  direction: layout.MindDirection;
  onlyAsk: boolean;
  isMobile: boolean;
  portrait: boolean;
  size: { width: number; height: number };
  scopeNodes: types.DecisionNode[];
  hasScopePath: boolean;
  folds: ReadonlyMap<string, boolean>;
  emptyText: string;
  cameraRequest: PendingCameraRequest | null;
  onOpen: (id: string, expand?: boolean) => void;
  onClose: () => void;
  onChangeDirection: (next: layout.MindDirection) => void;
  onChangeMode: (next: layout.ViewMode) => void;
}

/**
 * 渲染工作决策 React Flow 画布、手机导图操控胶囊与状态图例。
 * 保持单一 ReactFlow 实例原地热更新 nodes/edges 并自动 fitView，避免每次切换方向/范围都卸载重建整套 DOM。
 */
function DecisionFlowCanvasInner(props: DecisionFlowCanvasProps): react.JSX.Element {
  const { active, root, focused, look, mode, direction, onlyAsk, isMobile, portrait, size } = props;
  const { scopeNodes, hasScopePath, folds, emptyText, cameraRequest } = props;
  const flowRef = react.useRef<xyflow.ReactFlowInstance<layout.FlowNode> | undefined>(undefined);
  const handledSeqRef = react.useRef(0);
  const needsFitRef = react.useRef(false);

  let fit = FIT;
  if (portrait) fit = FIT_MOBILE;

  //M 按当前视图类型（思维导图、日期或放射）即时排布节点与连线坐标。
  const diagram = react.useMemo(() => {
    if (size.width === 0 || size.height === 0) return { nodes: [], edges: [] };

    const view = { mode, folds, portrait, ...size };
    if (hasScopePath) view.mode = 'all';
    if (look === 'date') return dateMap.getDateLayout(scopeNodes, folds, props.onOpen, onlyAsk);
    if (look === 'mind') return layout.getMindLayout(scopeNodes, view, props.onOpen, direction);

    return layout.getLayout(scopeNodes, view, props.onOpen);
  }, [direction, folds, hasScopePath, look, mode, onlyAsk, portrait, props.onOpen, scopeNodes, size]);

  //M 布局输入参数变化时标记需要在可见态下重新 fitView；单纯在导图与四象限之间往返切换时保持用户现有镜头位置。
  react.useEffect(() => {
    needsFitRef.current = true;
  }, [diagram.nodes.length, direction, fit, focused, look, mode, onlyAsk, portrait, root]);

  //M 当画布处于可见激活态且存在待处理的 fitView 标记时，在下一帧平滑适配视口。
  react.useEffect(() => {
    if (!active || !needsFitRef.current) return;

    const map = flowRef.current;
    if (map === undefined || diagram.nodes.length === 0) return;

    needsFitRef.current = false;
    const rafId = window.requestAnimationFrame(() => {
      void map.fitView(fit);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [active, diagram.nodes.length, direction, fit, focused, look, mode, onlyAsk, portrait, root]);

  //M 响应顶栏「待定」按钮发来的镜头聚焦请求，平滑平移并放大到目标待定卡片。
  react.useEffect(() => {
    if (cameraRequest === null || cameraRequest.seq === handledSeqRef.current) return;

    const map = flowRef.current;
    const target = diagram.nodes.find((node) => node.id === cameraRequest.nodeId);
    if (map === undefined || target === undefined) return;

    handledSeqRef.current = cameraRequest.seq;
    const zoom = Math.max(1.08, map.getZoom());
    let y = target.position.y;
    if (portrait) y += (size.height * 0.28) / zoom;
    let duration = 480;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0;
    void map.setCenter(target.position.x, y, { zoom, duration });
  }, [cameraRequest, diagram.nodes, portrait, size.height]);

  const connect = react.useCallback((map: xyflow.ReactFlowInstance<layout.FlowNode>): void => {
    flowRef.current = map;
  }, []);

  return (
    <>
      {isMobile && look === 'mind' && diagram.nodes.length > 0 && (
        <div className="decision-m-mind-bar" role="toolbar" aria-label={t('导图操控')}>
          <button
            type="button"
            aria-pressed={direction === 'sides'}
            onClick={() => props.onChangeDirection('sides')}
          >
            {t('左右')}
          </button>
          <button
            type="button"
            aria-pressed={direction === 'down'}
            onClick={() => props.onChangeDirection('down')}
          >
            {t('上下')}
          </button>
          <span className="decision-m-mind-bar__sep" />
          <button
            type="button"
            aria-pressed={mode === 'main'}
            onClick={() => props.onChangeMode('main')}
          >
            {t('主线')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'pending'}
            onClick={() => props.onChangeMode('pending')}
          >
            {t('待定')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'all'}
            onClick={() => props.onChangeMode('all')}
          >
            {t('全图')}
          </button>
        </div>
      )}

      {diagram.nodes.length > 0 && (
        <xyflow.ReactFlow<layout.FlowNode>
          nodes={diagram.nodes}
          edges={diagram.edges}
          nodeTypes={NODE_TYPES}
          nodeOrigin={ORIGIN}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          onlyRenderVisibleElements
          panOnDrag
          zoomOnPinch
          fitView
          fitViewOptions={fit}
          minZoom={0.22}
          maxZoom={2}
          className="dark"
          onInit={connect}
          onPaneClick={props.onClose}
        >
          <xyflow.Background gap={26} size={1.2} color="#303a50" />
          <xyflow.Controls position="bottom-right" showInteractive={false} fitViewOptions={fit} />
        </xyflow.ReactFlow>
      )}

      {diagram.nodes.length === 0 && <div className="decision-empty" role="status">{emptyText}</div>}

      {look === 'date' && diagram.nodes.length > 0 && (
        <ul className="decision-legend" aria-label="图例">
          <li><i data-tone="pending" />{t('等用户定')}</li>
          <li><i data-tone="confirmed" />{t('中控已定')}</li>
          <li><i data-tone="chosen" />{t('用户已定')}</li>
          <li><i data-tone="done" />{t('做完')}</li>
        </ul>
      )}
      {(look === 'mind' || look === 'radial') && diagram.nodes.length > 0 && (
        <ul className="decision-legend" aria-label="图例">
          <li><i data-tone="main" />主线</li>
          <li><i data-tone="pending" />待定</li>
          <li><i data-tone="working" />进行中</li>
          <li><i data-tone="confirmed" />中控已定</li>
          <li><i data-tone="chosen" />用户已定</li>
        </ul>
      )}
    </>
  );
}

/** 记忆化工作决策画布组件。 */
export const DecisionFlowCanvas = react.memo(DecisionFlowCanvasInner);
