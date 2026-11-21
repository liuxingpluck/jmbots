/**
 * 知识库的「🕸️ 双链图谱」抽屉：纯 SVG，不引第三方图库。
 * 全库：只画有链接的词条（按连线多少取前 MAX_NODES 篇），用简单的力导向排开；
 * 本篇邻居：这篇放中间，一跳邻居围成一圈（星型）。悬停高亮它和邻居，点节点打开那篇并收起抽屉。
 * 数据：全库用 KnowledgePage 已拿的整库图谱；本篇邻居另拉 GET /api/knowledge/graph?centerId=（knowledge 1.1.0）。
 */
import * as react from 'react';
import * as api from './KnowledgeApi.ts';

/** 全库模式最多画几个节点：再多 SVG 卡、也看不清。 */
const MAX_NODES = 300;

/** 力导向迭代次数。 */
const ITERATIONS = 220;

/** 节点少于这个数时每个都写标题；多了只写连线多的和悬停的。 */
const LABEL_ALL_BELOW = 60;


/** GraphView 的入参。 */
export interface GraphViewProps {
  /** 整库图谱（KnowledgePage 拉的）；还没拿到是 undefined。 */
  fullGraph: api.KnowledgeGraphResponse | undefined;
  /** 打开着的文档号：有就默认看「本篇邻居」。 */
  centerId: string | undefined;
  /** 打开一篇。实现在 KnowledgePage 的 openDoc。 */
  open: (id: string) => void;
  /** 收起抽屉。 */
  onClose: () => void;
}

/** 排好位置的节点。 */
interface Placed extends api.KnowledgeGraphNode {
  /** 横坐标。 */
  x: number;
  /** 纵坐标。 */
  y: number;
}


/**
 * 星型布局：中心在原点，其余围一圈。
 * @param nodes 节点。
 * @param centerId 中心。
 */
function placeStar(nodes: readonly api.KnowledgeGraphNode[], centerId: string): Placed[] {
  const others = nodes.filter((node) => node.id !== centerId);
  const radius = Math.max(140, others.length * 16);
  const placed: Placed[] = [];
  for (const node of nodes) {
    if (node.id === centerId) {
      placed.push({ ...node, x: 0, y: 0 });
    }
  }
  others.forEach((node, index) => {
    const angle = (index / others.length) * Math.PI * 2 - Math.PI / 2;
    placed.push({ ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return placed;
}


/**
 * 力导向布局（Fruchterman-Reingold 简化版）：节点互相推开，连线拉近，往中间轻轻收，温度逐步降下来。
 * 初始位置按序号铺成螺旋，结果每次一样。
 * @param nodes 节点。
 * @param edges 边。
 */
function placeForce(nodes: readonly api.KnowledgeGraphNode[], edges: readonly api.KnowledgeGraphEdge[]): Placed[] {
  const count = nodes.length;
  const ideal = 60;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const indexOf = new Map<string, number>();
  nodes.forEach((node, index) => {
    indexOf.set(node.id, index);
    const angle = index * 2.399963;
    const radius = ideal * Math.sqrt(index + 1);
    xs[index] = Math.cos(angle) * radius;
    ys[index] = Math.sin(angle) * radius;
  });

  //M 边换成序号对，免得每轮查表。
  const pairs: [number, number][] = [];
  for (const edge of edges) {
    const from = indexOf.get(edge.source);
    const to = indexOf.get(edge.target);
    if (from === undefined || to === undefined) continue;

    pairs.push([from, to]);
  }

  let temperature = ideal * 2;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  for (let round = 0; round < ITERATIONS; round += 1) {
    dx.fill(0);
    dy.fill(0);

    //M 互相推开：力和距离成反比。
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const ddx = xs[a]! - xs[b]!;
        const ddy = ys[a]! - ys[b]!;
        const dist = Math.max(1, Math.hypot(ddx, ddy));
        const force = (ideal * ideal) / dist;
        dx[a] = dx[a]! + (ddx / dist) * force;
        dy[a] = dy[a]! + (ddy / dist) * force;
        dx[b] = dx[b]! - (ddx / dist) * force;
        dy[b] = dy[b]! - (ddy / dist) * force;
      }
    }

    //M 连线拉近：力和距离的平方成正比。
    for (const [a, b] of pairs) {
      const ddx = xs[a]! - xs[b]!;
      const ddy = ys[a]! - ys[b]!;
      const dist = Math.max(1, Math.hypot(ddx, ddy));
      const force = (dist * dist) / ideal;
      dx[a] = dx[a]! - (ddx / dist) * force;
      dy[a] = dy[a]! - (ddy / dist) * force;
      dx[b] = dx[b]! + (ddx / dist) * force;
      dy[b] = dy[b]! + (ddy / dist) * force;
    }

    //M 每个点按合力挪一步（不超过当前温度），再往原点收一点，免得散开的小团飘远。
    for (let index = 0; index < count; index += 1) {
      const length = Math.max(1, Math.hypot(dx[index]!, dy[index]!));
      const step = Math.min(length, temperature);
      xs[index] = (xs[index]! + (dx[index]! / length) * step) * 0.99;
      ys[index] = (ys[index]! + (dy[index]! / length) * step) * 0.99;
    }
    temperature = Math.max(1, temperature * 0.97);
  }
  return nodes.map((node, index) => ({ ...node, x: xs[index]!, y: ys[index]! }));
}


/**
 * 画布范围：包住全部节点，四周留出写标题的空。
 * @param placed 排好的节点。
 */
function getViewBox(placed: readonly Placed[]): string {
  if (placed.length === 0) return '-100 -100 200 200';

  const xs = placed.map((node) => node.x);
  const ys = placed.map((node) => node.y);
  const pad = 60;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const width = Math.max(...xs) - minX + pad;
  const height = Math.max(...ys) - minY + pad;
  return `${String(minX)} ${String(minY)} ${String(width)} ${String(height)}`;
}


/** 双链图谱抽屉。 */
export function GraphView(props: GraphViewProps): react.JSX.Element {
  const { fullGraph, centerId, open, onClose } = props;

  //M 有打开着的文档默认看它的邻居，没有就看全库。
  let firstScope: 'center' | 'all' = 'all';
  if (centerId !== undefined) {
    firstScope = 'center';
  }
  const [scope, setScope] = react.useState(firstScope);
  const [centerGraph, setCenterGraph] = react.useState<api.KnowledgeGraphResponse>();
  const [error, setError] = react.useState<string>();
  const [hovered, setHovered] = react.useState<string>();

  //M 本篇邻居另拉一次。
  react.useEffect(() => {
    if (scope !== 'center' || centerId === undefined) return;

    const controller = new AbortController();
    setCenterGraph(undefined);
    api.fetchGraph(centerId, controller.signal).then((found) => {
      if (controller.signal.aborted) return;

      setCenterGraph(found);
      setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;

      let message = String(reason);
      if (reason instanceof Error) {
        message = reason.message;
      }
      setError(message);
    });
    return () => controller.abort();
  }, [scope, centerId]);

  //M Esc 收起。
  react.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  //M 选出要画的节点和边，排好位置（只在数据变了时重算）。
  let source = fullGraph;
  if (scope === 'center') {
    source = centerGraph;
  }
  const layout = react.useMemo(() => {
    if (source === undefined) return undefined;

    if (scope === 'center' && centerId !== undefined) {
      return { placed: placeStar(source.nodes, centerId), edges: source.edges, hidden: 0 };
    }
    const linked = source.nodes.filter((node) => node.degree > 0);
    linked.sort((a, b) => b.degree - a.degree);
    const kept = linked.slice(0, MAX_NODES);
    const keptIds = new Set(kept.map((node) => node.id));
    const edges = source.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target));
    const hidden = source.nodes.length - kept.length;
    return { placed: placeForce(kept, edges), edges, hidden };
  }, [source, scope, centerId]);

  //M 悬停的节点和它的邻居一起高亮。
  const near = new Set<string>();
  if (hovered !== undefined && layout !== undefined) {
    near.add(hovered);
    for (const edge of layout.edges) {
      if (edge.source === hovered) {
        near.add(edge.target);
      }
      if (edge.target === hovered) {
        near.add(edge.source);
      }
    }
  }
  const byId = new Map(layout?.placed.map((node) => [node.id, node]) ?? []);
  const showAllLabels = (layout?.placed.length ?? 0) < LABEL_ALL_BELOW;

  /** 点节点：打开那篇，收起抽屉。 */
  const pick = (id: string): void => {
    onClose();
    open(id);
  };

  return (
    <div className="kb-graph-layer" role="dialog" aria-label="双链图谱">
      <div className="kb-graph-scrim" onClick={onClose} />
      <section className="kb-graph">
        <header className="kb-graph-head">
          <span className="kb-graph-title">🕸️ 双链图谱</span>
          <div className="kb-modes" role="tablist">
            {centerId !== undefined && (
              <button type="button" data-active={scope === 'center'} onClick={() => setScope('center')}>本篇邻居</button>
            )}
            <button type="button" data-active={scope === 'all'} onClick={() => setScope('all')}>全库</button>
          </div>
          <span className="kb-grow" />
          <button type="button" className="kb-icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </header>
        {error !== undefined && <p className="kb-error">{error}</p>}
        {layout === undefined && error === undefined && <p className="kb-muted kb-center">正在加载…</p>}
        {layout !== undefined && layout.placed.length === 0 && (
          <p className="kb-muted kb-center">还没有 [[双链]]：在正文里敲 [[ 链接别的词条</p>
        )}
        {layout !== undefined && layout.placed.length > 0 && (
          <svg className="kb-graph-svg" viewBox={getViewBox(layout.placed)} preserveAspectRatio="xMidYMid meet">
            <defs>
              <marker id="kb-graph-arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6"
                orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="kb-graph-arrow" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const from = byId.get(edge.source);
              const to = byId.get(edge.target);
              if (from === undefined || to === undefined) return null;

              const lit = near.has(edge.source) && near.has(edge.target) && hovered !== undefined;
              return (
                <line
                  key={`${edge.source}>${edge.target}`}
                  className="kb-graph-edge"
                  data-lit={lit}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  markerEnd="url(#kb-graph-arrow)"
                />
              );
            })}
            {layout.placed.map((node) => {
              const radius = 5 + Math.sqrt(node.degree) * 2;
              const showLabel = showAllLabels || node.degree >= 3 || near.has(node.id) || node.id === centerId;
              return (
                <g
                  key={node.id}
                  className="kb-graph-node"
                  data-center={node.id === centerId}
                  data-rule={node.isSystemRule}
                  data-dim={hovered !== undefined && !near.has(node.id)}
                  transform={`translate(${String(node.x)} ${String(node.y)})`}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(undefined)}
                  onClick={() => pick(node.id)}
                >
                  <title>{node.title}</title>
                  <circle r={radius} />
                  {showLabel && <text y={radius + 13}>{node.isSystemRule && '🔒'}{node.title}</text>}
                </g>
              );
            })}
          </svg>
        )}
        {layout !== undefined && layout.hidden > 0 && (
          <p className="kb-muted kb-small kb-graph-foot">另有 {layout.hidden} 篇没有双链或超出 {MAX_NODES} 篇上限，没画出来</p>
        )}
      </section>
    </div>
  );
}
