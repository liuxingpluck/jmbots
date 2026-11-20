/** 教程思维导图：支持消息轨迹（数据流转 #1→#N / 按插件分组 / 数据变化总表）、项目结构树与骨架逐行。 */
import * as react from 'react';
import * as xy from '@xyflow/react';
import * as i18n from '../I18n.ts';
import * as layout from '../Shared/MindMap.ts';
import * as api from './TutorialApi.ts';
import * as data from './MindData.ts';
import * as readme from './ReadmeTabs.tsx';
import * as lines from './LinesView.tsx';
import * as stepFlowMod from './StepDataFlow.tsx';
import '@xyflow/react/dist/style.css';
import './MindMap.css';

const VIEW_KEY = 'jmbots.tutorial.view';
const DIRECTION_KEY = 'jmbots.tutorial.mind-direction';
const TREE_KEY = 'jmbots.tutorial.mind-tree';
const VIEWS = ['canvas', 'mind'] as const;
const DIRECTIONS = ['sides', 'down'] as const;
const TREES = ['project', 'trace', 'lines'] as const;

export type TreeView = (typeof TREES)[number];
export type TraceSubMode = 'flow' | 'plugin' | 'table';

/** 读取持久化选择，只接受给定选项，访问失败使用默认。 */
function getChoice<T extends string>(key: string, defaults: T, allowed: readonly T[]): T {
  try {
    const saved = window.localStorage.getItem(key);
    //G 忽略旧值和无法识别的值。
    const chosen = allowed.find((option) => option === saved);
    return chosen ?? defaults;
  } catch {
    return defaults;
  }
}

/** 保存非敏感的视图偏好，存储禁用时界面继续工作。 */
function saveChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    //G 存储不可用也允许切换视图。
  }
}

/** 在原画布和思维导图之间保留上次使用的选择；地址带 ?view= 时优先，手机直开 ?canvas= 默认进步骤流。 */
export function useTutorialView() {
  //M 优先读地址栏显式指定的视图；手机竖屏点开具体消息画布时默认进纵向步骤卡片而非上次残留的导图。
  const [view, setView] = react.useState<'canvas' | 'mind'>(() => {
    const query = new URLSearchParams(window.location.search);
    const requested = query.get('view');
    if (requested === 'canvas' || requested === 'mind') return requested;
    if (window.innerWidth < 800 && query.get('canvas') !== null) return 'canvas';

    return getChoice(VIEW_KEY, 'canvas', VIEWS);
  });
  const select = (next: 'canvas' | 'mind'): void => {
    //M 控件马上切换，同时为下次打开记住选择。
    setView(next);
    saveChoice(VIEW_KEY, next);
  };
  return { view, select };
}

/** 画布上显示哪棵树（项目结构、消息走过的路、骨架逐行），由左栏点选，记住上次的。 */
export function useMindTree() {
  //M 第一次打开是项目结构，以后恢复上次看的树。
  const [mode, setMode] = react.useState(() => getChoice(TREE_KEY, 'project', TREES));
  const select = react.useCallback((next: TreeView): void => {
    //M 马上换树，同时为下次打开记住。
    setMode(next);
    saveChoice(TREE_KEY, next);
  }, []);
  return { mode, select };
}

/** 教程独立入口沿用地址和浏览器语言偏好。 */
export function useMindWords(): i18n.Translate {
  const [language] = react.useState<i18n.Language>(() => {
    const query = new URLSearchParams(window.location.search);
    //M 地址里的语言优先，便于独立打开教程链接。
    const requested = query.get('lang');
    const explicit = i18n.matchLanguage(requested);
    if (explicit !== undefined) return explicit;

    try {
      //M 没有显式语言时沿用网页记住的语言。
      const storage = window.localStorage;
      return i18n.loadLanguage(storage);
    } catch {
      return 'zh-CN';
    }
  });
  //M 给树和右栏持有同一稳定的翻译函数。
  return react.useCallback((key, params) => i18n.translate(language, key, params), [language]);
}

/** 通用连接锚点组：支持左、右、上、下双向贴边连线。 */
function ZoomHandles(): react.JSX.Element {
  return (
    <>
      <xy.Handle type="source" position={xy.Position.Left} id="left" />
      <xy.Handle type="source" position={xy.Position.Right} id="right" />
      <xy.Handle type="source" position={xy.Position.Bottom} id="bottom" />
      <xy.Handle type="target" position={xy.Position.Left} id="left" />
      <xy.Handle type="target" position={xy.Position.Right} id="right" />
      <xy.Handle type="target" position={xy.Position.Top} id="top" />
    </>
  );
}

type TreeCard = xy.Node<{
  label: string;
  action?: () => void;
  expand?: boolean;
  selected?: boolean;
}, 'mindCard'>;

interface DataFlowCardPayload extends Record<string, unknown> {
  step: number;
  node: string;
  layer: 'skeleton' | 'plugin';
  ms: number;
  error: boolean;
  title: string;
  fnText: string;
  summary: string;
  hasChanges: boolean;
  selected: boolean;
  action: () => void;
}

type FlowCard = xy.Node<DataFlowCardPayload, 'dataFlowCard'>;
type AnyMindNode = TreeCard | FlowCard;

/** 树形导图普通卡片，只负责显示和打开详情。 */
function MindCard({ data: card }: xy.NodeProps<TreeCard>): react.JSX.Element {
  let cls = 'tu-mind-card';
  if (card.selected === true) cls += ' selected';
  if (card.action === undefined) return <div className={cls}><ZoomHandles />{card.label}</div>;

  return (
    <div>
      <ZoomHandles />
      <button className={`${cls} nodrag`} type="button" aria-expanded={card.expand} onClick={card.action}>
        {card.label}
      </button>
    </div>
  );
}

/** 端到端数据流转步骤卡片：步号、骨架金色徽标/插件徽标、耗时、动作标题、函数定位与底部状态变化胶囊。 */
function DataFlowCard({ data: card }: xy.NodeProps<FlowCard>): react.JSX.Element {
  let cardClass = 'tu-df-flow-card nodrag';
  if (card.layer === 'skeleton') cardClass += ' skeleton';
  if (card.selected) cardClass += ' selected';
  if (card.error) cardClass += ' error';

  let modClass = 'tu-df-node-mod plugin';
  let modText = card.node;
  if (card.layer === 'skeleton') {
    modClass = 'tu-df-node-mod skeleton';
    modText = `骨架 · ${card.node}`;
  }

  let msClass = 'tu-df-node-ms';
  if (card.ms >= 500) msClass += ' slow';

  let sumClass = 'tu-df-node-sum';
  if (card.layer === 'skeleton') sumClass += ' gold';
  if (card.layer !== 'skeleton' && card.hasChanges) sumClass += ' changed';

  return (
    <div>
      <ZoomHandles />
      <button
        type="button"
        className={cardClass}
        data-flow-step={card.step}
        aria-pressed={card.selected}
        onClick={card.action}
      >
        <div className="tu-df-node-top">
          <span className="tu-df-node-no">#{String(card.step)}</span>
          <span className={modClass}>{modText}</span>
          {card.error && <span className="tu-df-node-err">报错</span>}
          <span className={msClass}>{stepFlowMod.formatStepMs(card.ms)}</span>
        </div>
        <div className="tu-df-node-title">{card.title}</div>
        {card.fnText !== '' && (
          <div className="tu-df-node-fn" title={card.fnText}>{card.fnText}</div>
        )}
        {card.summary !== '' && (
          <div className={sumClass} title={card.summary}>{card.summary}</div>
        )}
      </button>
    </div>
  );
}

const TYPES = { mindCard: MindCard, dataFlowCard: DataFlowCard };
const ORIGIN: xy.NodeOrigin = [0.5, 0.5];
const FIT = { padding: 0.14, maxZoom: 1.35, minZoom: 0.2 };
const FIT_FLOW = { padding: 0.12, maxZoom: 1.02, minZoom: 0.3 };
const FIT_NARROW = { padding: 0.08, maxZoom: 1.15, minZoom: 0.52 };
const FIT_CONTROLS = { padding: 0.1, maxZoom: 1.5, minZoom: 0.2 };

/** 等自定义卡片完成 DOM 测量后再执行 fitView，彻底解决首帧冷开白画布问题。 */
function AutoFit(props: { frame: string; options: xy.FitViewOptions }): null {
  const initialized = xy.useNodesInitialized();
  const instance = xy.useReactFlow();
  const fittedRef = react.useRef('');

  react.useEffect(() => {
    //G 节点尚未完成首次宽高测量或当前帧已适配过时不重复触发。
    if (!initialized || fittedRef.current === props.frame) return undefined;

    fittedRef.current = props.frame;
    //M 首帧动画帧立即居中，并在 80ms 布局稳定后再校准一次确保零偏移。
    const raf = window.requestAnimationFrame(() => {
      void instance.fitView(props.options);
    });
    const timer = window.setTimeout(() => {
      void instance.fitView(props.options);
    }, 80);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [initialized, instance, props.frame, props.options]);

  return null;
}

/** 把共享布局给出的中心点转成树形卡片和连接线。 */
function getTreeChart(
  root: data.Branch,
  direction: layout.MindDirection,
  pick: (item: data.Branch) => void,
  expanded: ReadonlySet<string>,
  pickedStep: number,
): { nodes: AnyMindNode[]; edges: xy.Edge[] } {
  //M 留出比卡片更宽的层距，坐标算法和决策图共用。
  let spacing = { breadth: 56, depth: 216 };
  if (direction === 'down') spacing = { breadth: 190, depth: 84 };
  const children = (branch: data.Branch): readonly data.Branch[] => branch.children;
  const points = layout.getMindPoints(root, children, direction, spacing);
  const nodes: AnyMindNode[] = [];
  const edges: xy.Edge[] = [];
  for (const { item, position, parent } of points) {
    //M 有详情或能展开的节点才显示成按钮，选中步同步高亮。
    const isStepSelected = item.pick?.kind === 'step' && item.pick.no === pickedStep && pickedStep > 0;
    const card: TreeCard['data'] = { label: item.label, selected: isStepSelected };
    if (item.pick !== undefined || item.expand !== undefined) card.action = () => pick(item);
    if (item.expand !== undefined) card.expand = expanded.has(item.expand);
    const node: TreeCard = { id: item.id, type: 'mindCard', position, data: card };
    nodes.push(node);
    if (parent === undefined) continue;

    //M 连线从父卡片朝向子卡片的外侧出发。
    let sourceHandle = 'right';
    let targetHandle = 'left';
    if (position.x < 0) {
      sourceHandle = 'left';
      targetHandle = 'right';
    }
    if (direction === 'down') {
      sourceHandle = 'bottom';
      targetHandle = 'top';
    }
    edges.push({
      id: `${parent.id}→${item.id}`,
      source: parent.id,
      target: item.id,
      sourceHandle,
      targetHandle,
    });
  }
  return { nodes, edges };
}

/** 把端到端数据流转规格转成自定义 DataFlowCard 节点与高亮有向边。 */
function getDataFlowChart(
  trail: api.Trail,
  flow: api.TrailDataFlow,
  direction: layout.MindDirection,
  pickedStep: number,
  t: i18n.Translate,
  onPickStep: (no: number) => void,
): { nodes: AnyMindNode[]; edges: xy.Edge[] } {
  const graph = data.buildDataFlowGraph(trail, flow, direction, t);
  const nodes: AnyMindNode[] = graph.nodes.map((spec): FlowCard => ({
    id: spec.id,
    type: 'dataFlowCard',
    position: spec.position,
    data: {
      step: spec.step,
      node: spec.node,
      layer: spec.layer,
      ms: spec.ms,
      error: spec.error,
      title: spec.title,
      fnText: spec.fnText,
      summary: spec.summary,
      hasChanges: spec.hasChanges,
      selected: pickedStep === spec.step && pickedStep > 0,
      action: () => onPickStep(spec.step),
    },
  }));

  //M 选中某步时自动加亮其入边（暖金）与出边（亮青），所有边标签统一衬深色圆角胶囊底色。
  const edges: xy.Edge[] = graph.edges.map((spec): xy.Edge => {
    const isIncoming = pickedStep > 0 && spec.toStep === pickedStep;
    const isOutgoing = pickedStep > 0 && spec.fromStep === pickedStep;
    const active = isIncoming || isOutgoing;

    let stroke = '#64748b';
    let strokeWidth = 1.7;
    let labelFill = '#cbd5e1';
    let bgStroke = 'rgba(148, 163, 184, 0.34)';
    let zIndex = 2;
    if (isIncoming) {
      stroke = '#f59e0b';
      labelFill = '#fde68a';
    }
    if (isOutgoing) {
      stroke = '#38bdf8';
      labelFill = '#bae6fd';
    }
    if (active) {
      strokeWidth = 2.6;
      bgStroke = stroke;
      zIndex = 6;
    }

    return {
      id: spec.id,
      type: 'smoothstep',
      source: spec.source,
      target: spec.target,
      sourceHandle: spec.sourceHandle,
      targetHandle: spec.targetHandle,
      label: spec.label,
      animated: active,
      zIndex,
      style: { stroke, strokeWidth },
      markerEnd: { type: xy.MarkerType.ArrowClosed, width: 15, height: 15, color: stroke },
      labelStyle: {
        fill: labelFill,
        fontSize: 10.5,
        fontWeight: 600,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      labelBgStyle: {
        fill: '#0b101b',
        fillOpacity: 0.94,
        stroke: bgStroke,
        strokeWidth: 1,
      },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 6,
    };
  });

  return { nodes, edges };
}

/** 从现有说明接口渐进读取，限制最多六条并行响应。 */
function useDocs(plugins: readonly api.PluginItem[]): ReadonlyMap<string, data.PluginDoc> {
  const [docs, setDocs] = react.useState(new Map<string, data.PluginDoc>());
  react.useEffect(() => {
    let cancelled = false;
    const items = plugins.filter((plugin) => plugin.hasReadme || plugin.kind === 'skeleton');
    async function load(): Promise<void> {
      const all = new Map<string, data.PluginDoc>();
      for (let start = 0; start < items.length; start += 6) {
        if (cancelled) return;

        const slice = items.slice(start, start + 6);
        const pending = slice.map(async ({ name }) => {
          //M 复用说明页数据源和文档解析。单个插件缺资料不阻塞整个树。
          const escaped = encodeURIComponent(name);
          const path = `/api/tutorial/readme?name=${escaped}`;
          const document = await api.TutorialApi.get<{ text: string }>(path);
          return { name, content: readme.getMindReadme(document.text) };
        });
        const batch = await Promise.allSettled(pending);
        if (cancelled) return;

        for (const result of batch) {
          if (result.status === 'fulfilled') all.set(result.value.name, result.value.content);
        }
        setDocs(new Map(all));
      }
    }
    //M 插件列表更新后，丢弃上一批旧文档并重新加载。
    setDocs(new Map());
    void load();
    return () => { cancelled = true; };
  }, [plugins]);
  return docs;
}

/** 事件关系展示说明里记录的发出方和监听方。 */
function EventDetail({ name, docs, t, close }: {
  name: string; docs: ReadonlyMap<string, data.PluginDoc>; t: i18n.Translate; close: () => void;
}): react.JSX.Element {
  //M 合并各插件说明中的事件关系，空的一侧显示文档未记载。
  const items = Array.from(docs);
  const emitted = items.filter(([, doc]) => doc.emitted.includes(name)).map(([plugin]) => plugin);
  const listened = items.filter(([, doc]) => doc.listened.includes(name)).map(([plugin]) => plugin);
  const missing = t('说明未记载');
  const title = t('事件');
  const closeLabel = t('关闭');
  const emitterLabel = t('谁发');
  const listenerLabel = t('谁听');
  const emitters = emitted.join('、') || missing;
  const listeners = listened.join('、') || missing;
  return (
    <aside className="tu-mind-event" aria-label={title}>
      <div className="tu-mind-event-head">
        <h3>{name}</h3>
        <button type="button" onClick={close}>{closeLabel}</button>
      </div>
      <dl>
        <dt>{emitterLabel}</dt>
        <dd>{emitters}</dd>
        <dt>{listenerLabel}</dt>
        <dd>{listeners}</dd>
      </dl>
    </aside>
  );
}

interface Props {
  plugins: readonly api.PluginItem[];
  trail: api.Trail | null;
  dataFlow?: api.TrailDataFlow | null;
  pickedStep?: number;
  canvas: string;
  left: number;
  right: number;
  t: i18n.Translate;
  onPick: (target: data.Pick) => void;
  /** 左栏选中的模块，用于骨架逐行双向同步。 */
  plugin: string;
  /** 把骨架文件选择交回教程路由。 */
  onSelectPlugin: (name: string) => void;
  /** /api/programs 的进程插件清单，项目树里单独一组。 */
  programs: readonly api.ProgramItem[];
  /** 显示哪棵树，左栏点「项目结构」、消息、骨架模块时切换。 */
  mode: TreeView;
  /** 切换导图树模式（供顶栏快捷胶囊在窄屏收起左栏时直接切换）。 */
  onSelectMode?: (mode: TreeView) => void;
  /** 骨架逐行的块详情放进右侧详情的位置。 */
  detailHost: HTMLElement | null;
  /** 点了骨架逐行的一块。 */
  onLineDetail: () => void;
}

/** 三棵树共用一片画布，消息轨迹默认呈现 #1→#N 端到端数据流转图，也可一键切换按插件分组或数据变化总表。 */
export function TutorialMindMap(props: Props): react.JSX.Element {
  const { plugins, trail, dataFlow, pickedStep = 0, canvas, left, right, t, onPick } = props;
  const { plugin, onSelectPlugin, programs, mode, onSelectMode, detailHost, onLineDetail } = props;
  //M 记住上次的方向，消息轨迹子模式默认选中「数据流转」。
  const [direction, setDirection] = react.useState(() => getChoice(DIRECTION_KEY, 'sides', DIRECTIONS));
  const [traceSubMode, setTraceSubMode] = react.useState<TraceSubMode>('flow');
  const [expanded, setExpanded] = react.useState<ReadonlySet<string>>(() => new Set(['skeleton']));
  const [event, setEvent] = react.useState('');
  const docs = useDocs(plugins);

  const resolvedFlow = react.useMemo(() => {
    if (trail === null) return null;

    return stepFlowMod.resolveTrailDataFlow(trail, dataFlow);
  }, [dataFlow, trail]);

  /** 记住视图方向，在当前树里重新安排卡片。 */
  function selectDirection(next: layout.MindDirection): void {
    //M 方向变化后重新排布，刷新时沿用这个方向。
    setDirection(next);
    saveChoice(DIRECTION_KEY, next);
  }

  react.useEffect(() => {
    //M 左栏换了树，收起上一棵树打开的事件关系。
    setEvent('');
  }, [mode]);

  /** 分支按钮切换子树，叶子将详情交给事件面板或原右栏。 */
  function pick(branch: data.Branch): void {
    const key = branch.expand;
    if (key !== undefined) {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
          return next;
        }
        next.add(key);
        return next;
      });
    }
    const target = branch.pick;
    if (target === undefined) return;
    if (target.kind === 'event') {
      setEvent(target.name);
      return;
    }
    //M 插件和步骤复用教程右栏原有详情。
    setEvent('');
    onPick(target);
  }

  //M 按当前模式构建对应的 React Flow 节点与边：消息轨迹默认走 #1→#N 数据流转链。
  let chart: { nodes: AnyMindNode[]; edges: xy.Edge[] } | undefined;
  if (mode === 'project') {
    const tree = data.getProjectTree(plugins, docs, expanded, t, programs);
    chart = getTreeChart(tree, direction, pick, expanded, pickedStep);
  }
  if (mode === 'trace' && traceSubMode === 'plugin' && trail !== null) {
    const tree = data.getTrailTree(trail, t);
    chart = getTreeChart(tree, direction, pick, expanded, pickedStep);
  }
  if (mode === 'trace' && traceSubMode === 'flow' && trail !== null && resolvedFlow !== null) {
    chart = getDataFlowChart(
      trail,
      resolvedFlow,
      direction,
      pickedStep,
      t,
      (no) => onPick({ kind: 'step', no }),
    );
  }

  const title = t('思维导图');
  const directionLabel = t('展开方向');
  const sidesLabel = t('左右展开');
  const downLabel = t('上下展开');
  const emptyLabel = t('请在左栏选择一条消息');
  const showTable = mode === 'trace' && traceSubMode === 'table';
  const showDirectionToggle = !showTable;

  //M 角上的小切换只管方向，并保留上次选择。
  const showSides = () => selectDirection('sides');
  const showDown = () => selectDirection('down');

  //M 切换树、轨迹子模式、方向或消息时重新 fitView；点选步骤只更新高亮，不重置缩放平移。
  const nodeCount = chart?.nodes.length ?? 0;
  const frame = `${mode}:${traceSubMode}:${direction}:${canvas}:${String(nodeCount)}`;
  const fitFrame = `${frame}:${String(left)}:${String(right)}`;
  let initialFit = FIT;
  if (mode === 'trace' && traceSubMode === 'flow') initialFit = FIT_FLOW;
  if (typeof window !== 'undefined' && window.innerWidth < 800) {
    initialFit = FIT_NARROW;
  }

  let sectionClass = 'tu-mind';
  if (showTable) sectionClass += ' tu-mind-table-mode';

  return (
    <section className={sectionClass} style={{ left, right }} aria-label={title}>
      <div className="tu-mind-head">
        {onSelectMode !== undefined && (
          <div className="tu-mind-modes" role="group" aria-label={t('导图内容')}>
            <button
              type="button"
              aria-pressed={mode === 'trace'}
              onClick={() => onSelectMode('trace')}
            >
              {t('消息轨迹')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'project'}
              onClick={() => onSelectMode('project')}
            >
              {t('项目结构')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'lines'}
              onClick={() => onSelectMode('lines')}
            >
              {t('骨架逐行')}
            </button>
          </div>
        )}

        {mode === 'trace' && (
          <div className="tu-mind-submodes" role="group" aria-label={t('消息轨迹视图')}>
            <button
              type="button"
              data-trace-view="flow"
              aria-pressed={traceSubMode === 'flow'}
              onClick={() => setTraceSubMode('flow')}
            >
              {t('数据流转')}
            </button>
            <button
              type="button"
              data-trace-view="plugin"
              aria-pressed={traceSubMode === 'plugin'}
              onClick={() => setTraceSubMode('plugin')}
            >
              {t('按插件分组')}
            </button>
            <button
              type="button"
              data-trace-view="table"
              aria-pressed={traceSubMode === 'table'}
              onClick={() => setTraceSubMode('table')}
            >
              {t('数据变化总表')}
            </button>
          </div>
        )}

        {showDirectionToggle && (
          <div className="tu-mind-direction" role="group" aria-label={directionLabel}>
            <button type="button" data-look="mind-lr" aria-pressed={direction === 'sides'} onClick={showSides}>
              {sidesLabel}
            </button>
            <button type="button" data-look="mind-tb" aria-pressed={direction === 'down'} onClick={showDown}>
              {downLabel}
            </button>
          </div>
        )}
      </div>

      {mode === 'lines' && (
        <lines.LinesView
          t={t}
          plugin={plugin}
          onSelectPlugin={onSelectPlugin}
          direction={direction}
          detailHost={detailHost}
          onDetail={onLineDetail}
        />
      )}

      {showTable && (trail === null || resolvedFlow === null) && (
        <p className="tu-mind-empty">{emptyLabel}</p>
      )}
      {showTable && trail !== null && resolvedFlow !== null && (
        <stepFlowMod.DataFlowTable
          trail={trail}
          dataFlow={resolvedFlow}
          pickedStep={pickedStep}
          t={t}
          onPickStep={(no) => onPick({ kind: 'step', no })}
        />
      )}

      {mode !== 'lines' && !showTable && chart === undefined && (
        <p className="tu-mind-empty">{emptyLabel}</p>
      )}
      {mode !== 'lines' && !showTable && chart !== undefined && (
        <xy.ReactFlow
          key={frame}
          nodes={chart.nodes}
          edges={chart.edges}
          nodeTypes={TYPES}
          nodeOrigin={ORIGIN}
          nodesDraggable={false}
          nodesConnectable={false}
          className="dark"
          fitView
          fitViewOptions={initialFit}
          minZoom={0.18}
        >
          <AutoFit frame={fitFrame} options={initialFit} />
          <xy.Background />
          <xy.Controls showInteractive={false} fitViewOptions={FIT_CONTROLS} />
        </xy.ReactFlow>
      )}
      {event && <EventDetail name={event} docs={docs} t={t} close={() => setEvent('')} />}
    </section>
  );
}
