/**
 * 知识库「🕸️ 关系图谱」Obsidian 级全幅交互画布：
 * - 主内容区全幅渲染（非窄抽屉），1:1 像素坐标系 + 滚轮光标缩放 + 画布拖拽平移 + 单节点自由拖拽；
 * - 高斥力力导向布局 + 胶囊包围盒防重叠分离，节点按虚拟目录自动配色；
 * - 11.5px 清晰小字配半透明深色胶囊底衬（超 16 字优雅截断，悬停或选中展开全称）；
 * - 悬停高亮一跳邻居与有向连线、节点搜索直达定位、孤立节点显示开关、适应画布与重置视角；
 * - 点击节点在右侧弹出轻量预览抽屉（摘要 / 目录 / 标签 / 别名 / 正反向 [[双链]] +「打开编辑」按钮）。
 */
import * as react from 'react';
import * as api from './KnowledgeApi.ts';


/** 全库图谱单次最多渲染节点数。 */
const MAX_GRAPH_NODES = 320;
/** 力导向迭代轮数。 */
const FORCE_ROUNDS = 260;
/** 理想连线长度（拉大间距，杜绝挤成一团）。 */
const IDEAL_EDGE_LEN = 185;
/** 标签胶囊防碰撞推开轮数。 */
const COLLISION_ROUNDS = 36;
/** 默认截断字数（悬停或选中时展开完整标题）。 */
const LABEL_MAX_CHARS = 16;

/** 目录节点配色盘（柔和明快、深浅底均清晰）。 */
const DIR_PALETTE = [
  '#60a5fa',
  '#34d399',
  '#a78bfa',
  '#f472b6',
  '#fbbf24',
  '#2dd4bf',
  '#fb923c',
  '#818cf8',
] as const;

/** 未归目录节点的默认配色。 */
const UNASSIGNED_COLOR = '#94a3b8';


/** GraphView 组件入参。 */
export interface GraphViewProps {
  /** 整库双链图谱数据。 */
  fullGraph: api.KnowledgeGraphResponse | undefined;
  /** 全部虚拟目录（扁平列表，用于映射目录名与配色）。 */
  dirs: api.KnowledgeDir[];
  /** 已加载文档的补充信息（后端未重启前的 dirId / summary 兜底）。 */
  docMetaById: ReadonlyMap<string, { dirId: string | null; summary: string }>;
  /** 初始聚焦或选中的文档 ID（例如从编辑器点「🕸️ 图谱」切过来）。 */
  initialFocusId?: string;
  /** 是否只读模式。 */
  readOnly?: boolean;
  /** 在「📄 文档」视图中打开并编辑指定文档。 */
  onOpenEditor: (docId: string) => void;
  /** 新建指定标题的词条（双链悬空项快速创建）。 */
  onCreateDoc?: (title: string) => void;
}

/** 排好坐标并补齐目录与摘要的图谱节点。 */
interface PlacedNode extends api.KnowledgeGraphNode {
  x: number;
  y: number;
  resolvedDirId: string | null;
  resolvedSummary: string;
  color: string;
}

/** 画布平移与缩放状态。 */
interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

/** 拖拽手势状态：画布平移或单节点拖动。 */
type DragGesture =
  | {
      kind: 'pan';
      startClientX: number;
      startClientY: number;
      startPanX: number;
      startPanY: number;
      moved: boolean;
    }
  | {
      kind: 'node';
      nodeId: string;
      startClientX: number;
      startClientY: number;
      originX: number;
      originY: number;
      moved: boolean;
    };


/** 估算中英文混合文本的像素宽度（11.5px 字号下）。 */
function estimateLabelWidth(text: string): number {
  let width = 18;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      width += 12;
    } else {
      width += 6.8;
    }
  }
  return Math.max(54, Math.min(340, Math.ceil(width)));
}


/** 截断超长标题（按 Unicode 码点计）。 */
function truncateLabel(title: string, maxChars: number): string {
  const chars = [...title];
  if (chars.length <= maxChars) return title;

  return `${chars.slice(0, maxChars).join('')}…`;
}


/** 星型一跳布局（以聚焦节点为圆心，邻居均匀环绕并防重叠）。 */
function layoutStar(
  nodes: readonly Omit<PlacedNode, 'x' | 'y'>[],
  centerId: string,
): PlacedNode[] {
  const others = nodes.filter((node) => node.id !== centerId);
  const radius = Math.max(195, others.length * 28);
  const placed: PlacedNode[] = [];
  for (const node of nodes) {
    if (node.id === centerId) {
      placed.push({ ...node, x: 0, y: 0 });
    }
  }
  others.forEach((node, index) => {
    const angle = (index / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    placed.push({
      ...node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  });
  return resolveCollisions(placed, centerId);
}


/** 标签胶囊包围盒碰撞消解，彻底消除节点与标题互相压字。 */
function resolveCollisions(nodes: PlacedNode[], pinnedId?: string): PlacedNode[] {
  const count = nodes.length;
  if (count <= 1) return nodes;

  const xs = Float64Array.from(nodes.map((n) => n.x));
  const ys = Float64Array.from(nodes.map((n) => n.y));
  const halfWidths = Float64Array.from(
    nodes.map((n) => estimateLabelWidth(truncateLabel(n.title, LABEL_MAX_CHARS)) * 0.5 + 14),
  );
  const minVertical = 48;

  for (let pass = 0; pass < COLLISION_ROUNDS; pass += 1) {
    let anyOverlap = false;
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const dx = xs[b]! - xs[a]!;
        const dy = ys[b]! - ys[a]!;
        const minHorizontal = halfWidths[a]! + halfWidths[b]!;
        const overlapX = minHorizontal - Math.abs(dx);
        const overlapY = minVertical - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        anyOverlap = true;
        const aPinned = nodes[a]!.id === pinnedId;
        const bPinned = nodes[b]!.id === pinnedId;
        let shareA = 0.5;
        let shareB = 0.5;
        if (aPinned) {
          shareA = 0;
          shareB = 1;
        } else if (bPinned) {
          shareA = 1;
          shareB = 0;
        }

        //M 沿重叠较浅的轴轻轻推开，既不破坏拓扑聚落，又保证胶囊文字零遮挡。
        if (overlapY <= overlapX * 0.85) {
          let dirY = 1;
          if (dy < 0 || (dy === 0 && (a + b) % 2 === 0)) {
            dirY = -1;
          }
          const push = overlapY + 2;
          ys[a] = ys[a]! - dirY * push * shareA;
          ys[b] = ys[b]! + dirY * push * shareB;
        } else {
          let dirX = 1;
          if (dx < 0 || (dx === 0 && (a + b) % 2 === 1)) {
            dirX = -1;
          }
          const push = overlapX * 0.6 + 2;
          xs[a] = xs[a]! - dirX * push * shareA;
          xs[b] = xs[b]! + dirX * push * shareB;
        }
      }
    }
    if (!anyOverlap) {
      break;
    }
  }

  return nodes.map((node, index) => ({
    ...node,
    x: Math.round(xs[index]! * 10) / 10,
    y: Math.round(ys[index]! * 10) / 10,
  }));
}


/**
 * Obsidian 风格力导向布局：黄金角初始螺旋 + 强斥力 + 弹簧引力 + 温和向心收拢 + 胶囊防碰撞分离。
 */
function layoutForce(
  nodes: readonly Omit<PlacedNode, 'x' | 'y'>[],
  edges: readonly api.KnowledgeGraphEdge[],
): PlacedNode[] {
  const count = nodes.length;
  if (count === 0) return [];

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const indexOf = new Map<string, number>();

  //M 有连线的核心节点排内圈，孤立节点排外圈，黄金角均匀散开。
  nodes.forEach((node, index) => {
    indexOf.set(node.id, index);
    const angle = index * 2.39996323;
    const baseRadius = node.degree > 0 ? IDEAL_EDGE_LEN * 0.72 : IDEAL_EDGE_LEN * 1.15;
    const radius = baseRadius * Math.sqrt(index + 1);
    xs[index] = Math.cos(angle) * radius;
    ys[index] = Math.sin(angle) * radius;
  });

  const pairs: [number, number][] = [];
  for (const edge of edges) {
    const from = indexOf.get(edge.source);
    const to = indexOf.get(edge.target);
    if (from === undefined || to === undefined) {
      continue;
    }

    pairs.push([from, to]);
  }

  let temperature = IDEAL_EDGE_LEN * 1.8;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const repulsionK = IDEAL_EDGE_LEN * IDEAL_EDGE_LEN * 1.45;

  for (let round = 0; round < FORCE_ROUNDS; round += 1) {
    dx.fill(0);
    dy.fill(0);

    //M 1. 节点斥力
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const ddx = xs[a]! - xs[b]!;
        const ddy = ys[a]! - ys[b]!;
        const dist = Math.max(1, Math.hypot(ddx, ddy));
        const force = repulsionK / dist;
        const fx = (ddx / dist) * force;
        const fy = (ddy / dist) * force;
        dx[a] = dx[a]! + fx;
        dy[a] = dy[a]! + fy;
        dx[b] = dx[b]! - fx;
        dy[b] = dy[b]! - fy;
      }
    }

    //M 2. 双链弹簧拉力
    for (const [a, b] of pairs) {
      const ddx = xs[a]! - xs[b]!;
      const ddy = ys[a]! - ys[b]!;
      const dist = Math.max(1, Math.hypot(ddx, ddy));
      const force = (dist * dist) / IDEAL_EDGE_LEN;
      const fx = (ddx / dist) * force;
      const fy = (ddy / dist) * force;
      dx[a] = dx[a]! - fx;
      dy[a] = dy[a]! - fy;
      dx[b] = dx[b]! + fx;
      dy[b] = dy[b]! + fy;
    }

    //M 3. 温和向心引力（孤立节点稍微多收一点，避免飘到画布外围太远）
    for (let i = 0; i < count; i += 1) {
      const gravity = nodes[i]!.degree > 0 ? 0.035 : 0.075;
      dx[i] = dx[i]! - xs[i]! * gravity * IDEAL_EDGE_LEN * 0.08;
      dy[i] = dy[i]! - ys[i]! * gravity * IDEAL_EDGE_LEN * 0.08;

      const stepLen = Math.max(1, Math.hypot(dx[i]!, dy[i]!));
      const step = Math.min(stepLen, temperature);
      xs[i] = xs[i]! + (dx[i]! / stepLen) * step;
      ys[i] = ys[i]! + (dy[i]! / stepLen) * step;
    }
    temperature = Math.max(1.2, temperature * 0.972);
  }

  const rawPlaced: PlacedNode[] = nodes.map((node, index) => ({
    ...node,
    x: xs[index]!,
    y: ys[index]!,
  }));
  return resolveCollisions(rawPlaced);
}


/** 计算适应画布（Fit）所需的平移与缩放（限制最大自动放大倍率，绝不把字撑大）。 */
function computeFitViewport(
  nodes: readonly { x: number; y: number }[],
  width: number,
  height: number,
): Viewport {
  const safeW = Math.max(320, width);
  const safeH = Math.max(260, height);
  if (nodes.length === 0) {
    return { panX: safeW / 2, panY: safeH / 2, zoom: 1 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) {
      minX = node.x;
    }
    if (node.x > maxX) {
      maxX = node.x;
    }
    if (node.y < minY) {
      minY = node.y;
    }
    if (node.y > maxY) {
      maxY = node.y;
    }
  }
  const padX = 120;
  const padY = 90;
  const boxW = Math.max(180, maxX - minX + padX * 2);
  const boxH = Math.max(160, maxY - minY + padY * 2);
  const rawZoom = Math.min(safeW / boxW, safeH / boxH);
  const zoom = Math.max(0.32, Math.min(1.12, rawZoom));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    panX: safeW / 2 - centerX * zoom,
    panY: safeH / 2 - centerY * zoom,
    zoom,
  };
}


/** Obsidian 级全幅交互关系图谱视图。 */
export function GraphView(props: GraphViewProps): react.JSX.Element {
  const { fullGraph, dirs, docMetaById, initialFocusId, readOnly, onOpenEditor, onCreateDoc } = props;

  //M 范围：all（全库）或 center（选中节点的一跳邻居）。
  const [scope, setScope] = react.useState<'all' | 'center'>('all');
  const [selectedId, setSelectedId] = react.useState<string | undefined>(initialFocusId);
  const [hoveredId, setHoveredId] = react.useState<string | undefined>(undefined);
  const [dirFilter, setDirFilter] = react.useState<string | undefined>(undefined);
  //M 默认隐藏孤立节点（聚焦已连网词条，让首屏在 85%~100% 清晰比例下铺满画布），点击顶部按钮可随时展开。
  const [showIsolated, setShowIsolated] = react.useState<boolean>(false);
  const [searchQuery, setSearchQuery] = react.useState('');
  const [searchFocused, setSearchFocused] = react.useState(false);

  //M 一跳邻居子图数据。
  const [centerGraph, setCenterGraph] = react.useState<api.KnowledgeGraphResponse | undefined>(undefined);
  const [graphError, setGraphError] = react.useState<string | undefined>(undefined);

  //M 右侧轻预览抽屉按需拉取的单篇详情与双链列表。
  const [previewDoc, setPreviewDoc] = react.useState<api.KnowledgeDoc | undefined>(undefined);
  const [previewLinks, setPreviewLinks] = react.useState<api.KnowledgeLinksResponse | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = react.useState(false);

  //M 画布容器尺寸、视口变换与手动拖拽节点坐标覆盖。
  const stageRef = react.useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = react.useState({ width: 960, height: 640 });
  const [viewport, setViewport] = react.useState<Viewport>({ panX: 480, panY: 320, zoom: 0.9 });
  const [manualCoords, setManualCoords] = react.useState<Record<string, { x: number; y: number }>>({});
  const [isDraggingCanvas, setIsDraggingCanvas] = react.useState(false);
  const [draggingNodeId, setDraggingNodeId] = react.useState<string | undefined>(undefined);
  const gestureRef = react.useRef<DragGesture | null>(null);
  const autoFittedKeyRef = react.useRef('');

  //M 外部从编辑器切进图谱并传入新的 initialFocusId 时同步选中。
  react.useEffect(() => {
    if (initialFocusId !== undefined) {
      setSelectedId(initialFocusId);
    }
  }, [initialFocusId]);

  //M 监听画布容器真实像素尺寸。
  react.useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;

    const updateSize = (): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  //M 目录配色与名称表。
  const dirColorMap = react.useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    dirs.forEach((dir, idx) => {
      const color = DIR_PALETTE[idx % DIR_PALETTE.length]!;
      map.set(dir.id, { name: dir.name, color });
    });
    return map;
  }, [dirs]);

  //M 聚焦一跳模式时按需拉取 centerGraph。
  react.useEffect(() => {
    if (scope !== 'center' || selectedId === undefined) return;

    const controller = new AbortController();
    setCenterGraph(undefined);
    api.fetchGraph(selectedId, controller.signal).then((res) => {
      if (controller.signal.aborted) return;

      setCenterGraph(res);
      setGraphError(undefined);
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;

      const msg = err instanceof Error ? err.message : String(err);
      setGraphError(msg);
    });
    return () => controller.abort();
  }, [scope, selectedId]);

  //M 选中节点变化时拉取右侧轻预览抽屉所需的正文摘要与正反向双链。
  react.useEffect(() => {
    if (selectedId === undefined) {
      setPreviewDoc(undefined);
      setPreviewLinks(undefined);
      setPreviewLoading(false);
      return;
    }
    const controller = new AbortController();
    setPreviewLoading(true);
    void Promise.all([
      api.getDoc(selectedId, controller.signal).catch(() => undefined),
      api.fetchDocLinks(selectedId, controller.signal).catch(() => undefined),
    ]).then(([doc, links]) => {
      if (controller.signal.aborted) return;

      setPreviewDoc(doc);
      setPreviewLinks(links);
      setPreviewLoading(false);
    });
    return () => controller.abort();
  }, [selectedId]);

  //M 计算当前要展示的节点、目录图例计数与静态布局坐标。
  const graphData = scope === 'center' && selectedId !== undefined ? centerGraph : fullGraph;

  const layout = react.useMemo(() => {
    if (graphData === undefined) return undefined;

    const enriched = graphData.nodes.map((node) => {
      const fallback = docMetaById.get(node.id);
      const resolvedDirId = node.dirId !== undefined ? node.dirId : (fallback?.dirId ?? null);
      const resolvedSummary = node.summary ?? fallback?.summary ?? '';
      let color = UNASSIGNED_COLOR;
      if (resolvedDirId !== null) {
        color = dirColorMap.get(resolvedDirId)?.color ?? UNASSIGNED_COLOR;
      }
      return {
        ...node,
        resolvedDirId,
        resolvedSummary,
        color,
      };
    });

    const isolatedTotal = enriched.filter((n) => n.degree === 0).length;

    //M 目录计数（供图例胶囊显示）。
    const legendMap = new Map<string, { key: string; name: string; color: string; count: number }>();
    for (const node of enriched) {
      const key = node.resolvedDirId ?? api.UNASSIGNED;
      let name = '未归类';
      if (node.resolvedDirId !== null) {
        name = dirColorMap.get(node.resolvedDirId)?.name ?? '其他目录';
      }
      const existing = legendMap.get(key);
      if (existing !== undefined) {
        existing.count += 1;
      } else {
        legendMap.set(key, { key, name, color: node.color, count: 1 });
      }
    }
    const legend = [...legendMap.values()].sort((a, b) => b.count - a.count);

    if (scope === 'center' && selectedId !== undefined) {
      const placed = layoutStar(enriched, selectedId);
      return {
        placed,
        edges: graphData.edges,
        isolatedTotal,
        hiddenCount: 0,
        legend,
        layoutKey: `center:${selectedId}:${String(placed.length)}`,
      };
    }

    let candidates = enriched;
    if (!showIsolated) {
      candidates = candidates.filter((node) => node.degree > 0 || node.id === selectedId);
    }
    if (dirFilter !== undefined) {
      candidates = candidates.filter((node) => (node.resolvedDirId ?? api.UNASSIGNED) === dirFilter);
    }

    const sorted = [...candidates].sort((a, b) => b.degree - a.degree);
    const kept = sorted.slice(0, MAX_GRAPH_NODES);
    const keptIds = new Set(kept.map((n) => n.id));
    const edges = graphData.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
    const placed = layoutForce(kept, edges);
    const hiddenCount = enriched.length - kept.length;
    const layoutKey = `all:${String(kept.length)}:${String(edges.length)}:${String(showIsolated)}:${dirFilter ?? ''}`;

    return {
      placed,
      edges,
      isolatedTotal,
      hiddenCount,
      legend,
      layoutKey,
    };
  }, [graphData, docMetaById, dirColorMap, scope, selectedId, showIsolated, dirFilter]);

  //M 合并用户手动拖动过的节点坐标。
  const effectiveNodes = react.useMemo(() => {
    if (layout === undefined) return [];

    return layout.placed.map((node) => {
      const override = manualCoords[node.id];
      if (override === undefined) return node;

      return { ...node, x: override.x, y: override.y };
    });
  }, [layout, manualCoords]);

  const nodeById = react.useMemo(() => {
    return new Map(effectiveNodes.map((node) => [node.id, node]));
  }, [effectiveNodes]);

  //M 首次拿到布局或切换范围时自动适应画布（Fit）。
  const fitCanvas = react.useCallback((targetNodes?: readonly { x: number; y: number }[]) => {
    const list = targetNodes ?? effectiveNodes;
    const next = computeFitViewport(list, stageSize.width, stageSize.height);
    setViewport(next);
  }, [effectiveNodes, stageSize.width, stageSize.height]);

  react.useEffect(() => {
    if (layout === undefined || layout.placed.length === 0) return;
    if (autoFittedKeyRef.current === layout.layoutKey) return;

    autoFittedKeyRef.current = layout.layoutKey;
    setManualCoords({});
    const next = computeFitViewport(layout.placed, stageSize.width, stageSize.height);
    setViewport(next);
  }, [layout, stageSize.width, stageSize.height]);

  //M 重置视角：清空所有手动拖拽坐标并重新适应画布。
  const resetView = react.useCallback(() => {
    setManualCoords({});
    if (layout !== undefined) {
      const next = computeFitViewport(layout.placed, stageSize.width, stageSize.height);
      setViewport(next);
    }
  }, [layout, stageSize.width, stageSize.height]);

  //M 平滑聚焦到指定节点坐标并打开其右侧轻预览。
  const focusNode = react.useCallback((id: string) => {
    setSelectedId(id);
    const target = nodeById.get(id);
    if (target === undefined) return;

    setViewport((prev) => {
      const nextZoom = Math.max(prev.zoom, 1.05);
      //M 考虑右侧预览抽屉宽度（340px），将聚焦节点居中在左侧可视画布中央。
      const visibleWidth = Math.max(320, stageSize.width - 340);
      return {
        zoom: nextZoom,
        panX: visibleWidth / 2 - target.x * nextZoom,
        panY: stageSize.height / 2 - target.y * nextZoom,
      };
    });
  }, [nodeById, stageSize.width, stageSize.height]);

  //M 鼠标滚轮围绕光标无级缩放（挂原生 non-passive wheel 监听避免页面滚动）。
  react.useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;

      setViewport((prev) => {
        const nextZoom = Math.max(0.22, Math.min(3.2, prev.zoom * factor));
        const ratio = nextZoom / prev.zoom;
        return {
          zoom: nextZoom,
          panX: cursorX - (cursorX - prev.panX) * ratio,
          panY: cursorY - (cursorY - prev.panY) * ratio,
        };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  //M 画布平移与单节点拖拽手势。
  const onCanvasPointerDown = (event: react.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDraggingCanvas(true);
    gestureRef.current = {
      kind: 'pan',
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: viewport.panX,
      startPanY: viewport.panY,
      moved: false,
    };
  };

  const onNodePointerDown = (event: react.PointerEvent<SVGGElement>, node: PlacedNode): void => {
    if (event.button !== 0) return;

    event.stopPropagation();
    const svg = stageRef.current?.querySelector('svg');
    if (svg !== null && svg !== undefined) {
      svg.setPointerCapture(event.pointerId);
    }
    setDraggingNodeId(node.id);
    gestureRef.current = {
      kind: 'node',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: node.x,
      originY: node.y,
      moved: false,
    };
  };

  const onSvgPointerMove = (event: react.PointerEvent<SVGSVGElement>): void => {
    const gesture = gestureRef.current;
    if (gesture === null) return;

    const dx = event.clientX - gesture.startClientX;
    const dy = event.clientY - gesture.startClientY;
    if (Math.hypot(dx, dy) >= 4) {
      gesture.moved = true;
    }

    if (gesture.kind === 'pan') {
      setViewport((prev) => ({
        ...prev,
        panX: gesture.startPanX + dx,
        panY: gesture.startPanY + dy,
      }));
      return;
    }

    const worldX = gesture.originX + dx / viewport.zoom;
    const worldY = gesture.originY + dy / viewport.zoom;
    setManualCoords((prev) => ({
      ...prev,
      [gesture.nodeId]: { x: worldX, y: worldY },
    }));
  };

  const onSvgPointerUp = (event: react.PointerEvent<SVGSVGElement>): void => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setIsDraggingCanvas(false);
    setDraggingNodeId(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (gesture === null) return;

    if (gesture.kind === 'node' && !gesture.moved) {
      setSelectedId(gesture.nodeId);
    } else if (gesture.kind === 'pan' && !gesture.moved) {
      //M 点击空白画布处收起节点轻预览抽屉。
      setSelectedId(undefined);
    }
  };

  //M 按钮缩放（围绕画布中心）。
  const stepZoom = (factor: number): void => {
    const cx = stageSize.width / 2;
    const cy = stageSize.height / 2;
    setViewport((prev) => {
      const nextZoom = Math.max(0.22, Math.min(3.2, prev.zoom * factor));
      const ratio = nextZoom / prev.zoom;
      return {
        zoom: nextZoom,
        panX: cx - (cx - prev.panX) * ratio,
        panY: cy - (cy - prev.panY) * ratio,
      };
    });
  };

  //M 计算悬停或选中节点的一跳关联高亮集合。
  const activeFocusId = hoveredId ?? selectedId;
  const neighborIds = react.useMemo(() => {
    const set = new Set<string>();
    if (activeFocusId === undefined || layout === undefined) return set;

    set.add(activeFocusId);
    for (const edge of layout.edges) {
      if (edge.source === activeFocusId) {
        set.add(edge.target);
      }
      if (edge.target === activeFocusId) {
        set.add(edge.source);
      }
    }
    return set;
  }, [activeFocusId, layout]);

  //M 搜索框即时筛选候选节点。
  const searchResults = react.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q === '') return [];

    return effectiveNodes
      .filter((node) => {
        if (node.title.toLowerCase().includes(q)) return true;
        if ((node.aliases ?? []).some((alias) => alias.toLowerCase().includes(q))) return true;
        return node.tags.some((tag) => tag.toLowerCase().includes(q));
      })
      .slice(0, 10);
  }, [effectiveNodes, searchQuery]);

  //M 放大画布时轻微反向补偿字号，保证放大后节点间距拉开而文字依然精致不突兀。
  let labelScale = 1;
  if (viewport.zoom > 1.15) {
    labelScale = 1 / Math.pow(viewport.zoom, 0.38);
  }

  const selectedNode = selectedId !== undefined ? nodeById.get(selectedId) : undefined;
  const selectedDirName = selectedNode?.resolvedDirId
    ? (dirColorMap.get(selectedNode.resolvedDirId)?.name ?? '未归类')
    : '未归类';
  const summaryText = previewDoc?.summary || selectedNode?.resolvedSummary || '';
  const aliasList = previewDoc?.aliases ?? selectedNode?.aliases ?? [];
  const tagList = previewDoc?.tags ?? selectedNode?.tags ?? [];

  return (
    <section className="kb-graph-workspace" aria-label="知识库关系图谱画布">
      {/* 顶栏控制条 */}
      <div className="kb-graph-toolbar">
        <div className="kb-modes" role="tablist" aria-label="图谱范围">
          <button
            type="button"
            data-active={scope === 'all'}
            onClick={() => setScope('all')}
          >
            全库图谱
          </button>
          <button
            type="button"
            disabled={selectedId === undefined}
            data-active={scope === 'center'}
            title={selectedId === undefined ? '先在画布中点选一个节点' : '只看当前选中节点的一跳双链邻居'}
            onClick={() => setScope('center')}
          >
            聚焦一跳
          </button>
        </div>

        {/* 搜索定位框 */}
        <div className="kb-graph-search-wrap">
          <input
            type="search"
            className="kb-graph-search"
            value={searchQuery}
            placeholder="🔍 搜索节点标题 / 别名 / 标签定位…"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => window.setTimeout(() => setSearchFocused(false), 160)}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && searchResults.length > 0) {
                event.preventDefault();
                focusNode(searchResults[0]!.id);
                setSearchFocused(false);
              }
            }}
          />
          {searchFocused && searchQuery.trim() !== '' && (
            <div className="kb-graph-search-pop" role="listbox">
              {searchResults.length === 0 && (
                <div className="kb-graph-search-empty">当前图谱中没有匹配的节点</div>
              )}
              {searchResults.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="kb-graph-search-item"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    focusNode(item.id);
                    setSearchFocused(false);
                  }}
                >
                  <span className="kb-graph-dot" style={{ background: item.color }} />
                  <span className="kb-graph-search-name">{item.title}</span>
                  <span className="kb-muted kb-small">度 {item.degree}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {scope === 'all' && (
          <button
            type="button"
            className="kb-pill-toggle"
            data-active={showIsolated}
            onClick={() => setShowIsolated((prev) => !prev)}
            title="切换是否显示没有任何 [[双链]] 连线的孤立词条"
          >
            孤立节点 ({layout?.isolatedTotal ?? 0})
          </button>
        )}

        <span className="kb-grow" />

        <div className="kb-graph-stats kb-muted kb-small">
          <span>{effectiveNodes.length} 节点</span>
          <span>·</span>
          <span>{layout?.edges.length ?? 0} 连线</span>
        </div>

        <div className="kb-graph-zoom-group">
          <button type="button" className="kb-icon-btn" onClick={() => stepZoom(1 / 1.2)} title="缩小">−</button>
          <span className="kb-graph-zoom-val">{Math.round(viewport.zoom * 100)}%</span>
          <button type="button" className="kb-icon-btn" onClick={() => stepZoom(1.2)} title="放大">＋</button>
          <button type="button" className="kb-link-btn" onClick={() => fitCanvas()} title="自动缩放居中全部节点">
            适应画布
          </button>
          <button type="button" className="kb-link-btn" onClick={resetView} title="还原拖拽过的节点位置并重置视角">
            重置视角
          </button>
        </div>
      </div>

      {/* 主画布 + 右侧轻预览抽屉 */}
      <div className="kb-graph-body">
        <div className="kb-graph-stage" ref={stageRef} data-panning={isDraggingCanvas}>
          {graphError !== undefined && <p className="kb-error kb-center">{graphError}</p>}
          {layout === undefined && graphError === undefined && (
            <p className="kb-muted kb-center">正在构建关系图谱…</p>
          )}
          {layout !== undefined && effectiveNodes.length === 0 && (
            <div className="kb-empty kb-center">
              <p>当前筛选下暂无图谱节点</p>
              {!showIsolated && (layout.isolatedTotal > 0) && (
                <button type="button" className="kb-primary-btn" onClick={() => setShowIsolated(true)}>
                  显示 {layout.isolatedTotal} 个孤立文档节点
                </button>
              )}
            </div>
          )}

          {layout !== undefined && effectiveNodes.length > 0 && (
            <svg
              className="kb-graph-canvas"
              width="100%"
              height="100%"
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onSvgPointerMove}
              onPointerUp={onSvgPointerUp}
              onPointerCancel={onSvgPointerUp}
            >
              <defs>
                <marker
                  id="kb-arrow-idle"
                  viewBox="0 0 10 10"
                  refX="14"
                  refY="5"
                  markerWidth="5.5"
                  markerHeight="5.5"
                  orient="auto-start-reverse"
                >
                  <path d="M0,1 L10,5 L0,9 z" fill="rgba(148, 163, 184, 0.45)" />
                </marker>
                <marker
                  id="kb-arrow-lit"
                  viewBox="0 0 10 10"
                  refX="14"
                  refY="5"
                  markerWidth="6.5"
                  markerHeight="6.5"
                  orient="auto-start-reverse"
                >
                  <path d="M0,1 L10,5 L0,9 z" fill="var(--jm-accent)" />
                </marker>
              </defs>

              <g transform={`translate(${String(viewport.panX)} ${String(viewport.panY)}) scale(${String(viewport.zoom)})`}>
                {/* 连线层 */}
                {layout.edges.map((edge) => {
                  const from = nodeById.get(edge.source);
                  const to = nodeById.get(edge.target);
                  if (from === undefined || to === undefined) return null;

                  const isLit = activeFocusId !== undefined
                    && (edge.source === activeFocusId || edge.target === activeFocusId);
                  const isDim = hoveredId !== undefined && !isLit;
                  return (
                    <line
                      key={`${edge.source}->${edge.target}`}
                      className="kb-canvas-edge"
                      data-lit={isLit}
                      data-dim={isDim}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      markerEnd={isLit ? 'url(#kb-arrow-lit)' : 'url(#kb-arrow-idle)'}
                    />
                  );
                })}

                {/* 节点与深色半透明胶囊标签层 */}
                {effectiveNodes.map((node) => {
                  const radius = 6 + Math.min(10, Math.sqrt(node.degree) * 2.4);
                  const isSelected = node.id === selectedId;
                  const isHovered = node.id === hoveredId;
                  const isExpanded = isHovered || isSelected;
                  const isDim = hoveredId !== undefined && !neighborIds.has(node.id);
                  const isDragging = node.id === draggingNodeId;

                  const rawLabel = node.isSystemRule ? `🔒 ${node.title}` : node.title;
                  const displayText = isExpanded ? rawLabel : truncateLabel(rawLabel, LABEL_MAX_CHARS);
                  const pillW = estimateLabelWidth(displayText);
                  const pillH = 20;

                  return (
                    <g
                      key={node.id}
                      className="kb-canvas-node"
                      data-selected={isSelected}
                      data-hovered={isHovered}
                      data-dim={isDim}
                      data-dragging={isDragging}
                      transform={`translate(${String(node.x)} ${String(node.y)})`}
                      onPointerDown={(event) => onNodePointerDown(event, node)}
                      onMouseEnter={() => setHoveredId(node.id)}
                      onMouseLeave={() => setHoveredId((prev) => (prev === node.id ? undefined : prev))}
                    >
                      {isSelected && (
                        <circle
                          r={radius + 6}
                          fill="none"
                          stroke="var(--jm-accent)"
                          strokeWidth={2}
                          opacity={0.85}
                        />
                      )}
                      {node.isSystemRule && (
                        <circle
                          r={radius + 3}
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth={1.6}
                          strokeDasharray="3 2"
                        />
                      )}
                      <circle
                        className="kb-canvas-dot"
                        r={radius}
                        fill={node.color}
                      />
                      <g transform={`translate(0 ${String(radius + 13)}) scale(${String(labelScale)})`}>
                        <rect
                          x={-pillW / 2}
                          y={-pillH / 2}
                          width={pillW}
                          height={pillH}
                          rx={6}
                          ry={6}
                          className="kb-canvas-pill"
                          data-active={isExpanded}
                        />
                        <text
                          className="kb-canvas-label"
                          y={4}
                          textAnchor="middle"
                        >
                          {displayText}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {/* 左下角虚拟目录配色图例（点击可按目录过滤） */}
          {layout !== undefined && layout.legend.length > 0 && scope === 'all' && (
            <div className="kb-graph-legend" aria-label="目录配色图例">
              {dirFilter !== undefined && (
                <button
                  type="button"
                  className="kb-legend-chip kb-legend-reset"
                  onClick={() => setDirFilter(undefined)}
                >
                  全部目录 ×
                </button>
              )}
              {layout.legend.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="kb-legend-chip"
                  data-active={dirFilter === entry.key}
                  onClick={() => setDirFilter((prev) => (prev === entry.key ? undefined : entry.key))}
                  title={`按目录「${entry.name}」筛选节点`}
                >
                  <span className="kb-graph-dot" style={{ background: entry.color }} />
                  <span>{entry.name}</span>
                  <span className="kb-count">{entry.count}</span>
                </button>
              ))}
            </div>
          )}

          {layout !== undefined && layout.hiddenCount > 0 && (
            <div className="kb-graph-hint-bar kb-muted kb-small">
              已隐藏 {layout.hiddenCount} 个节点（可通过顶部「孤立节点」或目录图例切换显示）
            </div>
          )}
        </div>

        {/* 右侧节点轻量预览抽屉 */}
        {selectedNode !== undefined && (
          <aside className="kb-graph-inspector" aria-label="选中节点预览">
            <div className="kb-inspector-head">
              <div className="kb-inspector-badges">
                <span className="kb-inspector-dir">
                  <span className="kb-graph-dot" style={{ background: selectedNode.color }} />
                  {selectedDirName}
                </span>
                {selectedNode.isSystemRule && (
                  <span className="kb-rule-badge">🔒 硬性规则</span>
                )}
              </div>
              <button
                type="button"
                className="kb-icon-btn"
                onClick={() => setSelectedId(undefined)}
                aria-label="关闭节点预览"
              >
                ×
              </button>
            </div>

            <h3 className="kb-inspector-title">{selectedNode.title}</h3>

            <div className="kb-inspector-actions">
              <button
                type="button"
                className="kb-primary-btn"
                onClick={() => onOpenEditor(selectedNode.id)}
              >
                📝 打开编辑
              </button>
              {scope === 'all' ? (
                <button
                  type="button"
                  className="kb-link-btn"
                  onClick={() => setScope('center')}
                >
                  🎯 聚焦邻居
                </button>
              ) : (
                <button
                  type="button"
                  className="kb-link-btn"
                  onClick={() => setScope('all')}
                >
                  返回全库
                </button>
              )}
            </div>

            <div className="kb-inspector-section">
              <div className="kb-inspector-label">内容摘要</div>
              {previewLoading && summaryText === '' && (
                <p className="kb-muted kb-small">正在读取摘要…</p>
              )}
              {summaryText !== '' && (
                <p className="kb-inspector-summary">{summaryText}</p>
              )}
              {!previewLoading && summaryText === '' && (
                <p className="kb-muted kb-small">暂无摘要</p>
              )}
            </div>

            {aliasList.length > 0 && (
              <div className="kb-inspector-section">
                <div className="kb-inspector-label">实体别名</div>
                <div className="kb-inspector-chips">
                  {aliasList.map((alias) => (
                    <span key={alias} className="kb-chip">{alias}</span>
                  ))}
                </div>
              </div>
            )}

            {tagList.length > 0 && (
              <div className="kb-inspector-section">
                <div className="kb-inspector-label">标签</div>
                <div className="kb-inspector-chips">
                  {tagList.map((tag) => (
                    <span key={tag} className="kb-chip">#{tag}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="kb-inspector-section">
              <div className="kb-inspector-label">
                引出双链 ({previewLinks?.outgoing.length ?? 0})
              </div>
              {previewLinks === undefined && previewLoading && (
                <p className="kb-muted kb-small">正在加载双链…</p>
              )}
              {previewLinks !== undefined && previewLinks.outgoing.length === 0 && (
                <p className="kb-muted kb-small">本篇未引用其他词条</p>
              )}
              {previewLinks !== undefined && previewLinks.outgoing.length > 0 && (
                <ul className="kb-inspector-links">
                  {previewLinks.outgoing.map((out) => (
                    <li key={out.targetTitle} className="kb-inspector-link-row">
                      {out.exists && out.targetId !== null ? (
                        <button
                          type="button"
                          className="kb-inspector-link-btn"
                          onClick={() => {
                            if (nodeById.has(out.targetId!)) {
                              focusNode(out.targetId!);
                            } else {
                              onOpenEditor(out.targetId!);
                            }
                          }}
                        >
                          <span>↗ [[{out.targetTitle}]]</span>
                        </button>
                      ) : (
                        <span className="kb-inspector-missing">
                          <span>[[{out.targetTitle}]]</span>
                          {out.ambiguous && <span className="kb-muted kb-small">（同名歧义）</span>}
                          {!out.ambiguous && !readOnly && onCreateDoc !== undefined && (
                            <button
                              type="button"
                              className="kb-link-btn kb-small"
                              onClick={() => onCreateDoc(out.targetTitle)}
                            >
                              ＋ 新建
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="kb-inspector-section">
              <div className="kb-inspector-label">
                反向链接 ({previewLinks?.backlinks.length ?? 0})
              </div>
              {previewLinks !== undefined && previewLinks.backlinks.length === 0 && (
                <p className="kb-muted kb-small">暂无其他词条引用本篇</p>
              )}
              {previewLinks !== undefined && previewLinks.backlinks.length > 0 && (
                <ul className="kb-inspector-links">
                  {previewLinks.backlinks.map((back) => (
                    <li key={back.id} className="kb-inspector-link-row">
                      <button
                        type="button"
                        className="kb-inspector-link-btn"
                        onClick={() => {
                          if (nodeById.has(back.id)) {
                            focusNode(back.id);
                          } else {
                            onOpenEditor(back.id);
                          }
                        }}
                      >
                        <span>↙ {back.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
