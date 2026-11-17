/**
 * 预览图画布：React Flow（@xyflow/react）+ dagre 从左到右分层。
 * 交互学 Toonflow：网格、缩放控件、小地图、拖拽点选；打开时默认 100%，镜头对准 CLI → 骨架，不把整图缩进窗口。
 * 平时只画当前选中节点的边，可切换显示全部。插件按分类成组，组可以折叠。
 * 状态颜色：正常、没挂（红）、没开工（橙）、未配置（灰）。
 * 深色外观参考即梦画布的配色和节点卡（只学样子，不用它的代码和素材）。
 * 2026-11-16 请求轨迹：经过的插件右上角标上第几步（①②…），步与步之间画橙色线并写上步号，出错的标红；
 * 只收到通知、没留下动作的插件画浅色虚框；其余变淡。选中一条轨迹时镜头对准经过的插件（不缩到看不清字）。
 * 轨迹默认用「按步骤看」：每个经过的插件一条横道，步骤从左到右排成卡片（第几步、干了什么、用了多久），像时序图；
 * 也可以切回「在结构图上看」。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react';
import dagre from '@dagrejs/dagre';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { FlowGraph, GraphEdge, GraphNode, NodeState, Trail } from './FlowApi.ts';


/** 按步骤看：横道高、左边道名宽、一步卡片宽高和间距。 */
const LANE_H = 96;
const LANE_LABEL_W = 190;
const STEP_W = 200;
const STEP_H = 70;
const STEP_GAP = 36;


const UNIT_W = 200;
const UNIT_H = 64;
const GROUP_HEAD = 36;
const PAD = 16;
const GAP = 12;
const COLS = 2;

const COLORS: Record<string, string> = {
  cli: '#2f9e44',
  skeleton: '#1c7ed6',
  ok: '#5c4b8a',
  failed: '#c92a2a',
  waiting: '#e67700',
  idle: '#868e96',
};


/** 分类组在图里的稳定 id，避免和插件名撞车。 */
function groupId(category: string): string {
  return `group:${category}`;
}

function groupSize(count: number, collapsed: boolean): { w: number; h: number } {
  if (collapsed || count <= 0) return { w: UNIT_W + PAD, h: GROUP_HEAD + 8 };
  const cols = Math.min(COLS, count);
  const rows = Math.ceil(count / COLS);
  return {
    w: PAD * 2 + cols * UNIT_W + (cols - 1) * GAP,
    h: GROUP_HEAD + PAD + rows * UNIT_H + (rows - 1) * GAP,
  };
}

function innerPosition(index: number): { x: number; y: number } {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { x: PAD + col * (UNIT_W + GAP), y: GROUP_HEAD + 8 + row * (UNIT_H + GAP) };
}


interface UnitData extends Record<string, unknown> {
  label: string;
  kind: GraphNode['kind'];
  state: NodeState;
  summary: string;
  hit: boolean;
  fail: boolean;
  dim: boolean;
  /** 轨迹里第几步经过这里。 */
  nos: number[];
  /** 只收到通知。 */
  heard: boolean;
  /** 右栏正点着的那一步在这里。 */
  active: boolean;
}

interface GroupData extends Record<string, unknown> {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

type CanvasNode = Node<UnitData, 'unit'> | Node<GroupData, 'category'>;


function UnitNode(props: NodeProps<Node<UnitData, 'unit'>>): JSX.Element {
  const { data, selected } = props;
  const classes = [
    'fl-node',
    `fl-node-${data.kind}`,
    `fl-state-${data.state}`,
    selected ? 'selected' : '',
    data.hit ? 'hit' : '',
    data.fail ? 'fail' : '',
    data.dim ? 'dim' : '',
    data.heard ? 'heard' : '',
    data.active ? 'active' : '',
  ].filter(Boolean).join(' ');
  const shown = data.nos.length > 4 ? [...data.nos.slice(0, 4), '…'] : data.nos;
  return (
    <div className={classes}>
      <Handle type="target" position={Position.Left} />
      {data.nos.length > 0 && <div className="fl-badges">{shown.map((no) => <span key={String(no)}>{no}</span>)}</div>}
      <div className="fl-node-head">
        <span className="fl-dot" />
        <div className="fl-node-title">{data.label}</div>
      </div>
      {data.summary !== '' && <div className="fl-node-desc">{data.summary}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function GroupNode(props: NodeProps<Node<GroupData, 'category'>>): JSX.Element {
  const { data } = props;
  const onToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    data.onToggle();
  };
  return (
    <div className={`fl-group${data.collapsed ? ' collapsed' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="fl-group-bar">
        <span>{data.label} · {data.count}</span>
        <button type="button" onClick={onToggle}>{data.collapsed ? '展开' : '折叠'}</button>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

interface StepData extends Record<string, unknown> {
  no: number;
  title: string;
  ms: string;
  error: boolean;
  active: boolean;
}

interface LaneData extends Record<string, unknown> {
  label: string;
  summary: string;
  state: NodeState;
}

function StepNode(props: NodeProps<Node<StepData, 'step'>>): JSX.Element {
  const { data } = props;
  return (
    <div className={`fl-stepcard${data.error ? ' fail' : ''}${data.active ? ' active' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="fl-stepcard-top"><span className="fl-no">{data.no}</span><span className="fl-ms">{data.ms}</span></div>
      <div className="fl-stepcard-title">{data.title}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function LaneNode(props: NodeProps<Node<LaneData, 'lane'>>): JSX.Element {
  const { data } = props;
  return (
    <div className={`fl-lane fl-state-${data.state}`}>
      <div className="fl-lane-label">
        <div className="fl-node-head"><span className="fl-dot" /><div className="fl-node-title">{data.label}</div></div>
        <div className="fl-node-desc">{data.summary}</div>
      </div>
    </div>
  );
}

const NODE_TYPES = { unit: UnitNode, category: GroupNode, step: StepNode, lane: LaneNode };


/** 毫秒写成人看的。 */
function shortMs(ms: number): string {
  return ms < 1000 ? `${String(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}


/**
 * 按步骤看：每个经过的插件一条横道（按第一次到的先后排），第几步就放第几列。
 * @param trail 轨迹。
 * @param graph 拿插件说明和状态。
 * @param activeStep 右栏点着的那一步。
 */
function lanesOf(trail: Trail, graph: FlowGraph, activeStep: number | null): { nodes: Node[]; edges: Edge[] } {
  const order: string[] = [];
  for (const step of trail.steps) if (!order.includes(step.node)) order.push(step.node);
  const width = LANE_LABEL_W + trail.steps.length * (STEP_W + STEP_GAP) + STEP_GAP;
  const nodes: Node[] = order.map((name, index) => {
    const info = graph.nodes.find((node) => node.id === name);
    return {
      id: `lane-${name}`,
      type: 'lane',
      position: { x: 0, y: index * LANE_H },
      data: { label: name, summary: info?.summary ?? '', state: info?.state ?? 'ok' },
      style: { width, height: LANE_H - 12 },
      selectable: false,
      draggable: false,
      zIndex: 0,
    };
  });
  for (const step of trail.steps) {
    nodes.push({
      id: `step-${String(step.no)}`,
      type: 'step',
      position: { x: LANE_LABEL_W + (step.no - 1) * (STEP_W + STEP_GAP) + STEP_GAP / 2, y: order.indexOf(step.node) * LANE_H + (LANE_H - 12 - STEP_H) / 2 },
      data: { no: step.no, title: step.title, ms: shortMs(step.ms), error: step.error, active: step.no === activeStep },
      style: { width: STEP_W, height: STEP_H },
      draggable: false,
      zIndex: 2,
    });
  }
  const edges: Edge[] = [];
  trail.steps.forEach((step, index) => {
    const next = trail.steps[index + 1];
    if (next === undefined) return;
    const active = activeStep === step.no || activeStep === next.no;
    const color = next.error ? '#e85d5d' : active ? '#ffb454' : '#e0a054';
    edges.push({
      id: `lane-edge-${String(step.no)}`,
      source: `step-${String(step.no)}`,
      target: `step-${String(next.no)}`,
      type: 'smoothstep',
      animated: active,
      zIndex: 1,
      style: { stroke: color, strokeWidth: active ? 3 : 2 },
    });
  });
  return { nodes, edges };
}


interface PathEdge {
  source: string;
  target: string;
  nos: number[];
  error: boolean;
}

interface ReplayMarks {
  hit: Set<string>;
  errors: Set<string>;
  heard: Set<string>;
  nos: Map<string, number[]>;
  path: PathEdge[];
  active: string | null;
  activeNo: number | null;
}

function marksOf(trail: Trail | null, activeStep: number | null): ReplayMarks {
  const marks: ReplayMarks = { hit: new Set(), errors: new Set(), heard: new Set(), nos: new Map(), path: [], active: null, activeNo: activeStep };
  if (trail === null) return marks;
  const byPair = new Map<string, PathEdge>();
  let previous: string | null = null;
  for (const step of trail.steps) {
    marks.hit.add(step.node);
    if (step.error) marks.errors.add(step.node);
    marks.nos.set(step.node, [...(marks.nos.get(step.node) ?? []), step.no]);
    if (step.no === activeStep) marks.active = step.node;
    for (const name of step.notified) marks.heard.add(name);
    if (previous !== null && previous !== step.node) {
      const key = edgeKey(previous, step.node);
      const edge = byPair.get(key) ?? { source: previous, target: step.node, nos: [], error: false };
      edge.nos.push(step.no);
      edge.error ||= step.error;
      byPair.set(key, edge);
    }
    previous = step.node;
  }
  for (const name of marks.hit) marks.heard.delete(name);
  marks.path = [...byPair.values()];
  return marks;
}

function edgeKey(source: string, target: string): string {
  return `${source}\0${target}`;
}


function layoutOf(
  graph: FlowGraph,
  collapsed: Set<string>,
  marks: ReplayMarks,
  onToggle: (category: string) => void,
  showHeard: boolean,
): { nodes: CanvasNode[]; lookup: Map<string, string> } {
  const cliAndSkeleton: GraphNode[] = [];
  const byCategory = new Map<string, GraphNode[]>();
  const hideHeard = marks.hit.size > 0 && !showHeard;
  for (const node of graph.nodes) {
    if (node.kind === 'cli' || node.kind === 'skeleton') {
      cliAndSkeleton.push(node);
      continue;
    }
    //M 结构图回放时，只听没动作的插件默认画成灰色虚框；关掉「显示未动作的插件」就把它们藏起来。
    if (hideHeard && marks.heard.has(node.id) && !marks.hit.has(node.id)) continue;
    const list = byCategory.get(node.category) ?? [];
    list.push(node);
    byCategory.set(node.category, list);
  }
  const categories = [...byCategory.keys()];

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 100, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of cliAndSkeleton) {
    g.setNode(node.id, { width: UNIT_W, height: UNIT_H });
  }
  for (const category of categories) {
    const count = byCategory.get(category)?.length ?? 0;
    const size = groupSize(count, collapsed.has(category));
    g.setNode(groupId(category), { width: size.w, height: size.h });
  }

  const seen = new Set<string>();
  const layoutEdge = (source: string, target: string) => {
    if (source === target) return;
    const key = `${source}->${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    g.setEdge(source, target);
  };
  for (const node of cliAndSkeleton) {
    if (node.kind === 'skeleton') layoutEdge('cli', node.id);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const endpoint = (id: string): string => {
    const node = byId.get(id);
    if (node === undefined) return id;
    if (node.kind === 'plugin') return groupId(node.category);
    return id;
  };
  for (const edge of graph.edges) {
    layoutEdge(endpoint(edge.source), endpoint(edge.target));
  }

  dagre.layout(g);

  const topLeft = (id: string): { x: number; y: number } => {
    const placed = g.node(id) as { x: number; y: number; width: number; height: number } | undefined;
    if (placed === undefined) return { x: 0, y: 0 };
    return { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2 };
  };

  const replaying = marks.hit.size > 0;
  const trailData = (id: string) => ({
    hit: marks.hit.has(id),
    fail: marks.errors.has(id),
    dim: replaying && !marks.hit.has(id) && !marks.heard.has(id),
    nos: marks.nos.get(id) ?? [],
    heard: marks.heard.has(id),
    active: marks.active === id,
  });
  const nodes: CanvasNode[] = [];
  const lookup = new Map<string, string>();

  for (const node of cliAndSkeleton) {
    lookup.set(node.id, node.id);
    nodes.push({
      id: node.id,
      type: 'unit',
      position: topLeft(node.id),
      data: {
        label: node.id,
        kind: node.kind,
        state: node.state,
        summary: node.summary,
        ...trailData(node.id),
      },
      style: { width: UNIT_W, height: UNIT_H },
    });
  }

  for (const category of categories) {
    const plugins = byCategory.get(category) ?? [];
    const folded = collapsed.has(category);
    const size = groupSize(plugins.length, folded);
    const gid = groupId(category);
    nodes.push({
      id: gid,
      type: 'category',
      position: topLeft(gid),
      data: { label: category, count: plugins.length, collapsed: folded, onToggle: () => onToggle(category) },
      style: { width: size.w, height: size.h },
      selectable: false,
    });
    if (folded) {
      for (const plugin of plugins) lookup.set(plugin.id, gid);
      continue;
    }
    plugins.forEach((plugin, index) => {
      lookup.set(plugin.id, plugin.id);
      nodes.push({
        id: plugin.id,
        type: 'unit',
        position: innerPosition(index),
        parentId: gid,
        extent: 'parent',
        data: {
          label: plugin.id,
          kind: plugin.kind,
          state: plugin.state,
          summary: plugin.summary,
          ...trailData(plugin.id),
        },
        style: { width: UNIT_W, height: UNIT_H },
      });
    });
  }
  return { nodes, lookup };
}


function edgesOf(
  graph: FlowGraph,
  lookup: Map<string, string>,
  marks: ReplayMarks,
  selected: string | null,
  showAll: boolean,
): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  const replaying = marks.hit.size > 0;
  for (const edge of graph.edges as GraphEdge[]) {
    const source = lookup.get(edge.source) ?? edge.source;
    const target = lookup.get(edge.target) ?? edge.target;
    if (source === target) continue;
    const id = `${edge.kind}-${source}-${target}-${edge.label}`;
    if (seen.has(id)) continue;
    const related = selected !== null && (
      source === selected || target === selected || edge.source === selected || edge.target === selected
    );
    if (!showAll && !related) continue;
    seen.add(id);
    const color = related ? '#5b8cff' : 'rgba(180, 196, 220, 0.42)';
    out.push({
      id,
      source,
      target,
      type: 'default',
      label: showAll || edge.label === '' ? undefined : edge.label,
      className: edge.kind,
      style: {
        stroke: color,
        strokeWidth: 1.2,
        strokeDasharray: edge.kind === 'inject' ? '6 4' : undefined,
        opacity: replaying ? 0.45 : 1,
      },
      labelStyle: { fontSize: 10, fill: color },
      data: { kind: edge.kind },
    });
  }

  //M 轨迹的线：步与步之间一条，写上是第几步走过去的；正点着的那一步动起来。
  for (const edge of marks.path) {
    const source = lookup.get(edge.source) ?? edge.source;
    const target = lookup.get(edge.target) ?? edge.target;
    if (source === target) continue;
    const active = marks.activeNo !== null && edge.nos.includes(marks.activeNo);
    const color = edge.error ? '#e85d5d' : active ? '#ffb454' : '#e0a054';
    out.push({
      id: `trail-${source}-${target}`,
      source,
      target,
      type: 'default',
      animated: active,
      zIndex: 10,
      label: `第 ${edge.nos.join('、')} 步`,
      className: `trail${edge.error ? ' error' : ''}${active ? ' active' : ''}`,
      style: { stroke: color, strokeWidth: active ? 3.5 : 2.4 },
      labelStyle: { fontSize: 12, fontWeight: 600, fill: color },
      labelBgStyle: { fill: '#1a1a1a', fillOpacity: 0.92 },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
    });
  }
  return out;
}


function FlowCanvasInner(props: {
  graph: FlowGraph;
  trail: Trail | null;
  activeStep: number | null;
  lanes: boolean;
  onPickStep: (no: number) => void;
  selected: string | null;
  focusSeq: number;
  showAllEdges: boolean;
  showHeard: boolean;
  onSelect: (id: string | null) => void;
  /** 左栏浮在画布上盖住多宽（FlowPage 的 leftInset）：镜头起点往右让这么多。 */
  inset: number;
}): JSX.Element {
  const { graph, trail, activeStep, lanes, onPickStep, selected, focusSeq, showAllEdges, showHeard, onSelect, inset } = props;
  const laneView = useMemo(
    () => (trail !== null && lanes ? lanesOf(trail, graph, activeStep) : null),
    [trail, lanes, graph, activeStep],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const primed = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const api = useReactFlow<CanvasNode>();
  const marks = useMemo(() => marksOf(trail, activeStep), [trail, activeStep]);
  const onToggle = useCallback((category: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);
  const laid = useMemo(
    () => layoutOf(graph, collapsed, marks, onToggle, showHeard),
    [graph, collapsed, marks, onToggle, showHeard],
  );
  const nodes = useMemo(
    () => laid.nodes.map((node) => ({ ...node, selected: node.id === selected })),
    [laid.nodes, selected],
  );
  const edges = useMemo(
    () => edgesOf(graph, laid.lookup, marks, selected, showAllEdges),
    [graph, laid.lookup, marks, selected, showAllEdges],
  );

  const focusStart = useCallback((instance: Pick<ReactFlowInstance<CanvasNode>, "setViewport">) => {
    if (lanes && trail !== null) return;
    //M 对准 CLI 和骨架三个服务的左沿，左边留出空隙。画布本身在侧栏右侧，不能再按整图缩，以免左上角被挡住。
    const starts = nodes.filter((node) => node.parentId === undefined && (node.id === 'cli' || node.data.kind === 'skeleton'));
    const first = starts[0] ?? nodes.find((node) => node.id === 'cli');
    if (first === undefined) return;
    const zoom = 1;
    const height = box.current?.clientHeight || 600;
    const left = Math.min(...starts.map((node) => node.position.x), first.position.x);
    const top = Math.min(...starts.map((node) => node.position.y), first.position.y);
    const bottom = Math.max(...starts.map((node) => node.position.y + UNIT_H), first.position.y + UNIT_H);
    const x = inset + 48 - left * zoom;
    const y = height / 2 - ((top + bottom) / 2) * zoom;
    void instance.setViewport({ x, y, zoom });
    primed.current = true;
  }, [nodes, lanes, trail, inset]);

  useEffect(() => {
    primed.current = false;
  }, [graph]);

  useEffect(() => {
    if (primed.current || nodes.length === 0) return;
    focusStart(api);
  }, [api, nodes, focusStart]);

  useEffect(() => {
    if (focusSeq === 0 || selected === null) return;
    const current = api.getNode(selected);
    if (current === undefined) return;
    const bounds = api.getNodesBounds([current]);
    const zoom = Math.max(api.getZoom(), 1);
    void api.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom, duration: 280 });
  }, [api, focusSeq, selected]);

  //M 换了一条轨迹：镜头对准经过的插件，最小 0.85 倍，字还看得清；装不下就以第一步为准，剩下的拖着看。
  const trailKey = trail === null ? '' : `${String(trail.message)}:${trail.steps.map((step) => step.node).join(',')}:${lanes ? 'lanes' : 'map'}`;
  useEffect(() => {
    if (trailKey !== '' && lanes) {
      //M 按步骤看：100% 从第 1 步开始看，往右拖看后面的。稍等一下再设，免得被结构图那边的初次对焦盖掉。
      const timer = window.setTimeout(() => { void api.setViewport({ x: inset + 16, y: 24, zoom: 1 }); }, 150);
      return () => window.clearTimeout(timer);
    }
    if (trailKey === '' || marks.hit.size === 0) return;
    const ids = [...marks.hit].map((id) => laid.lookup.get(id) ?? id).filter((id) => nodes.some((node) => node.id === id));
    if (ids.length === 0) return;
    const timer = window.setTimeout(() => {
      void api.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.12, minZoom: 0.85, maxZoom: 1, duration: 300 });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [trailKey]);

  //M 点步骤（中间卡片或右栏列表、上一步/下一步）只高亮和更新右栏，不 setCenter / fitView / 改缩放，免得画面乱晃。镜头只在刚打开一条轨迹或点左边名单时动。

  const onNodeClick = useCallback((_: MouseEvent, node: Node) => {
    if (node.type === 'category') return;
    if (node.type === 'step') {
      onPickStep(Number((node.data as StepData).no));
      return;
    }
    if (node.type === 'lane') {
      onSelect(node.id.slice('lane-'.length));
      return;
    }
    onSelect(node.id);
  }, [onSelect, onPickStep]);

  const onPaneClick = useCallback(() => { onSelect(null); }, [onSelect]);

  const nodeColor = useCallback((node: CanvasNode): string => {
    if (node.type === 'category') return '#ced4da';
    if (node.data.fail) return COLORS.failed ?? '#c92a2a';
    if (node.data.kind === 'cli') return COLORS.cli ?? '#2f9e44';
    if (node.data.kind === 'skeleton') return COLORS.skeleton ?? '#1c7ed6';
    return COLORS[node.data.state] ?? COLORS.ok ?? '#5c4b8a';
  }, []);

  return (
    <div ref={box} style={{ width: '100%', height: '100%' }}>
    <ReactFlow
      nodes={(laneView?.nodes ?? nodes) as CanvasNode[]}
      edges={laneView?.edges ?? edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      onInit={focusStart}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.2}
      maxZoom={2.5}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      fitView={false}
      defaultViewport={{ x: 64, y: 80, zoom: 1 }}
      attributionPosition="bottom-left"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1c1c1c" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        nodeColor={nodeColor}
        bgColor="#121212"
        maskColor="rgba(0, 0, 0, 0.55)"
        position="bottom-right"
      />
    </ReactFlow>
    </div>
  );
}


export function FlowCanvas(props: {
  graph: FlowGraph;
  trail: Trail | null;
  activeStep: number | null;
  lanes: boolean;
  onPickStep: (no: number) => void;
  selected: string | null;
  focusSeq: number;
  showAllEdges: boolean;
  showHeard: boolean;
  onSelect: (id: string | null) => void;
  inset: number;
}): JSX.Element {
  return (
    <div className="fl-canvas">
      <ReactFlowProvider>
        <FlowCanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
