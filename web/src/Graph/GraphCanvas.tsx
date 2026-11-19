/**
 * 关系图画布：cytoscape（力导向 cose 布局、拖动、缩放、点选）。命中的边金色虚线流动，命中的点金色光圈呼吸，其余变淡。
 * merge 为 true 时只往图上加新的点和边（双击展开邻居），已有的点不动。
 */
import cytoscape from 'cytoscape';
import { useLayoutEffect, useRef, useState } from 'react';
import * as privacy from '../Privacy/Mask.tsx';
import type { Graph } from './GraphApi.ts';

/** 点的颜色：人、组织、事、编号/日期/数。 */
export const COLORS: Record<string, string> = { person: '#ff8fb1', org: '#62d2ff', thing: '#9b8cff', item: '#7ee0a1' };
const HIT = '#ffc44d';
const DARK: Record<string, string> = { person: '#5a2a3a', org: '#174a5c', thing: '#33295e', item: '#1f4f33' };

interface Props {
  graph: Graph;
  /** 命中的边号、点号（没有检索时是空的）。 */
  hitEdges: number[];
  hitNodes: number[];
  merge: boolean;
  /** 自增：同一张图要重新铺一次时改它。 */
  version: number;
  onNode: (id: number) => void;
  onEdge: (id: number) => void;
  onExpand: (name: string) => void;
}

/** 取绘图时写入的节点或关系原始编号。 */
function getRawId(target: cytoscape.SingularElementArgument): number {
  //M Cytoscape 返回宽类型，沿用原编号转换。
  const raw: unknown = target.data('raw');
  return Number(raw);
}

const STYLE = [
  { selector: 'node', style: {
    'background-fill': 'radial-gradient',
    'background-gradient-stop-colors': (ele: cytoscape.NodeSingular) => `#ffffff ${COLORS[ele.data('kind') as string] ?? '#9b8cff'} ${DARK[ele.data('kind') as string] ?? '#33295e'}`,
    'background-gradient-stop-positions': '0 35 100',
    label: 'data(name)', color: '#dfe6f5', 'font-size': 11, 'text-valign': 'bottom', 'text-margin-y': 4,
    'text-outline-color': '#060912', 'text-outline-width': 2, 'text-max-width': '140px', 'text-wrap': 'ellipsis',
    width: 'mapData(degree, 1, 10, 18, 46)', height: 'mapData(degree, 1, 10, 18, 46)',
    'border-width': 1.5, 'border-color': '#ffffff', 'border-opacity': 0.35,
    //M 节点外圈光晕沿用按实体 kind 映射的分类色，在画布上区分人、组织、事与编号。
    'underlay-color': (ele: cytoscape.NodeSingular) => COLORS[ele.data('kind') as string] ?? '#9b8cff', 'underlay-opacity': 0.22, 'underlay-padding': 6, 'underlay-shape': 'ellipse',
  } },
  { selector: 'edge', style: {
    width: 1.4, 'line-color': '#6e8cdc', 'line-opacity': 0.55, 'curve-style': 'bezier',
    'target-arrow-shape': 'triangle', 'target-arrow-color': '#8caaf0', 'arrow-scale': 0.9,
    'font-size': 10, color: '#b8c8f0', 'text-rotation': 'autorotate',
    'text-background-color': '#080c1a', 'text-background-opacity': 0.85, 'text-background-padding': '2px',
  } },
  { selector: 'edge.label', style: { label: 'data(label)' } },
  { selector: '.faded', style: { opacity: 0.28 } },
  { selector: 'node.hit', style: {
    'border-color': HIT, 'border-width': 3, 'border-opacity': 1, 'underlay-color': HIT, 'underlay-opacity': 0.4, 'underlay-padding': 7,
    color: '#ffe2a3', 'font-size': 13, 'font-weight': 'bold', 'z-index': 10,
  } },
  { selector: 'edge.hit', style: {
    width: 4, 'line-color': HIT, 'line-opacity': 1, 'target-arrow-color': HIT, 'line-style': 'dashed', 'line-dash-pattern': [10, 8],
    label: 'data(label)', color: '#ffd98a', 'font-size': 12, 'underlay-color': HIT, 'underlay-opacity': 0.18, 'underlay-padding': 5, 'z-index': 10,
  } },
  { selector: 'node:selected', style: { 'border-color': '#ffffff', 'border-width': 3, 'border-opacity': 1 } },
  { selector: 'edge:selected', style: { 'line-color': '#ffffff', 'target-arrow-color': '#ffffff', 'line-opacity': 1, label: 'data(label)' } },
] as unknown as cytoscape.StylesheetJson;

/**
 * 关系图画布组件：用 cytoscape 渲染实体节点和关系边，支持 cose 力导向布局、缩放滑块、点选实体/关系、双击展开邻居与演示打码。
 * @param props graph 图数据，hitEdges/hitNodes 命中高亮编号，merge 是否增量并入画布，version 触发布局刷新的版本号，onNode/onEdge/onExpand 节点与边交互回调。
 * @returns 画布容器与底部缩放控制条的 JSX 元素。
 * 副作用：创建并销毁 cytoscape 实例，启动并清理 requestAnimationFrame 命中高亮动画；图数据变化时重跑布局；开启打码时清空 canvas 像素并重刷节点/边展示文本。
 */
export function GraphCanvas(props: Props) {
  //M 订阅全局演示打码开关，决定画布节点名与关系词是否替换成脱敏文本。
  const mask = privacy.useMask();
  const box = useRef<HTMLDivElement>(null);
  //M 仅在内存保留原名；画布元素只保存当前可展示的字符串。
  const names = useRef(new Map<number, string>());
  const labels = useRef(new Map<number, string>());
  const cyRef = useRef<cytoscape.Core | null>(null);
  const handlers = useRef(props);
  handlers.current = props;
  //M 2026-11-14 23:20 EST 用户要：缩放滑块（显示百分比，拖动缩放），滚轮缩放时跟着动。
  const [zoom, setZoom] = useState(100);

  //M 建一次 cytoscape：事件、缩放到一定程度显示关系词、命中动画。
  useLayoutEffect(() => {
    const cy = cytoscape({ container: box.current, style: STYLE, minZoom: 0.15, maxZoom: 4, wheelSensitivity: 0.3 });
    cyRef.current = cy;
    cy.on('tap', 'node', (event: cytoscape.EventObjectNode) => {
      //M 节点点击按创建时保存的原始编号分发。
      const id = getRawId(event.target);
      handlers.current.onNode(id);
    });
    cy.on('tap', 'edge', (event: cytoscape.EventObjectEdge) => {
      //M 关系点击用同一套编号转换。
      const id = getRawId(event.target);
      handlers.current.onEdge(id);
    });
    cy.on('dbltap', 'node', (event: cytoscape.EventObjectNode) => {
      //M 双击仍按原始实体名展开邻居。
      const id = getRawId(event.target);
      const name = names.current.get(id);
      if (name !== undefined) handlers.current.onExpand(name);
    });
    cy.on('mouseover', 'node', (event) => { (event.target as cytoscape.NodeSingular).connectedEdges().addClass('label'); });
    cy.on('mouseout', 'node', () => { if (cy.zoom() < 1.3) cy.edges().removeClass('label'); });
    cy.on('zoom', () => {
      if (cy.zoom() >= 1.3) {
        cy.edges().addClass('label');
      }
      if (cy.zoom() < 1.3) {
        cy.edges().removeClass('label');
      }
      setZoom(Math.round(cy.zoom() * 100));
    });
    let offset = 0, frame = 0;
    const loop = (now: number) => {
      offset -= 1.2;
      const glow = 7 + 3 * Math.sin(now / 320);
      cy.batch(() => {
        cy.edges('.hit').style('line-dash-offset', offset);
        cy.nodes('.hit').style('underlay-padding', glow);
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(frame); cy.destroy(); cyRef.current = null; };
  }, []);

  //M 图或命中变了：换（或并入）元素，标命中/变淡，跑一次力导向。
  useLayoutEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    const { graph, hitEdges, hitNodes, merge } = props;
    if (!merge) {
      cy.elements().remove();
      names.current.clear();
      labels.current.clear();
    }
    for (const node of graph.nodes) names.current.set(node.id, node.name);
    for (const edge of graph.edges) labels.current.set(edge.id, edge.label);
    const center = cy.nodes(':selected').first();
    let at: cytoscape.Position | undefined;
    if (center.nonempty()) {
      at = center.position();
    }

    //M 筛选画布中尚未出现的新节点，归类 kind 并做隐私脱敏后批量加入 cytoscape（增量展开时排在选中节点附近）。
    cy.add(graph.nodes.filter((n) => cy.getElementById(`n${n.id}`).empty()).map((n) => {
      let kind = 'thing';
      if (['person', 'org', 'thing', 'item'].includes(n.kind)) {
        kind = n.kind;
      }
      const element: cytoscape.ElementDefinition = {
        group: 'nodes',
        data: { id: `n${n.id}`, raw: n.id, name: privacy.text(n.name, mask), kind, degree: n.degree },
      };
      if (at) {
        element.position = { x: at.x + Math.random() * 40 - 20, y: at.y + Math.random() * 40 - 20 };
      }
      return element;
    }));

    //M 仅把尚未在画布中且两端节点均已存在的新关系边经隐私脱敏后加入 cytoscape。
    cy.add(graph.edges.filter((e) => cy.getElementById(`e${e.id}`).empty() && cy.getElementById(`n${e.source}`).nonempty() && cy.getElementById(`n${e.target}`).nonempty())
      .map((e) => ({ group: 'edges' as const, data: { id: `e${e.id}`, raw: e.id, source: `n${e.source}`, target: `n${e.target}`, label: privacy.text(e.label, mask) } })));
    cy.elements().removeClass('hit faded');
    if (hitEdges.length > 0) {
      cy.elements().addClass('faded');
      for (const id of hitEdges) cy.getElementById(`e${id}`).removeClass('faded').addClass('hit');
      for (const id of hitNodes) cy.getElementById(`n${id}`).removeClass('faded').addClass('hit');
    }
    //M 点少时 fit 会放到很大、光圈挤在一起：铺完把缩放压到 1.3 以内。
    //M 2026-11-14 23:20 EST 用户要默认偏小一点：铺完再缩到 fit 的 85%（整体放得下、四周留白）。
    cy.one('layoutstop', () => {
      const level = Math.max(cy.minZoom(), Math.min(1.3, cy.zoom()) * 0.85);
      cy.zoom({ level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); cy.center();
    });
    //M 2026-11-14 23:20 EST 用户要节点间隔大些：斥力 20000→60000、连线 90/120→160/200、分块间距 80→160、重力 0.3→0.15。
    cy.layout({
      name: 'cose',
      animate: true,
      animationDuration: 900,
      randomize: !merge,
      fit: true,
      padding: 60,
      nodeRepulsion: () => 60000,
      nodeOverlap: 60,
      componentSpacing: 160,
      idealEdgeLength: (edge: cytoscape.EdgeSingular) => {
        if (edge.hasClass('hit')) return 200;

        return 160;
      },
      gravity: 0.15,
      numIter: 1500,
    }).run();
  }, [props.graph, props.hitEdges, props.hitNodes, props.version]);

  //M 开关改变时也刷新 merge 留下的旧元素；布局前提交，避免下一帧绘制原名。
  useLayoutEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    if (mask) {
      //G cytoscape 异步重画前清掉旧像素，不让关闭打码时的文字滞留画布。
      box.current?.querySelectorAll('canvas').forEach((canvas) => {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      });
    }
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        node.data('name', privacy.text(names.current.get(Number(node.data('raw'))) ?? '', mask));
      });
      cy.edges().forEach((edge) => {
        edge.data('label', privacy.text(labels.current.get(Number(edge.data('raw'))) ?? '', mask));
      });
    });
  }, [mask, props.graph, props.version]);

  //M 拖滑块：以画布中心缩放（范围跟 cytoscape 的 minZoom～maxZoom 一致，15%～400%）。
  const zoomTo = (percent: number) => {
    const cy = cyRef.current;
    if (cy === null) return;
    cy.zoom({ level: percent / 100, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  return (
    <>
      <div className="mg-cy" ref={box} />
      <div className="mg-zoom" title="拖动缩放（滚轮也行）">
        <button type="button" onClick={() => zoomTo(Math.max(15, zoom - 10))}>－</button>
        <input type="range" min={15} max={400} step={5} value={zoom} onChange={(e) => zoomTo(Number(e.target.value))} />
        <button type="button" onClick={() => zoomTo(Math.min(400, zoom + 10))}>＋</button>
        <b>{zoom}%</b>
        <button type="button" onClick={() => { cyRef.current?.fit(undefined, 60); }}>适应</button>
      </div>
    </>
  );
}
