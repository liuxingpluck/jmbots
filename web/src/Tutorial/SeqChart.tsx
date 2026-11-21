/**
 * 顺序图（教程页画布的第二种看法，和 LaneChart 的表格能切）、点箭头的事件详情、左栏静态的“一条飞书消息”路线。
 *   SeqChart：一道一个插件，时间往下；每一步在它那道上一个方块，这一步发的事件是一支箭头，从发出方指向每个监听者。
 *     点方块 = 选中这一步（右栏看插件、函数、文件:行、一句人话、关键变量，和表格一样）；
 *     点箭头 = 选中这一步并高亮这个事件（右栏看 EventArrowDetail）。
 *   EventArrowDetail：事件名、谁发谁听（带文件:行）、数据的 TS 类型（取自事件目录）、这一次实际带的值（跟踪点记下的关键值）。
 *   FeishuRoute：静态的路线，没跑过消息也能看。
 * 后端：src7/plugins/tutorial/index.ts 的 /api/tutorial/events（事件目录），轨迹来自 /api/tutorial/canvas。
 */
import { useEffect, useState, type JSX } from 'react';
import * as i18n from '../I18n.ts';
import * as traceText from '../locales/Trace.ts';
import { JsonBlock, SiteLink } from './Code.tsx';
import {
  TutorialApi,
  type Canvas,
  type EventCatalogItem,
  type EventSite,
  type Trail,
  type TrailRow,
  type TrailStep,
} from './TutorialApi.ts';
import type { CanvasLayout } from './LaneChart.tsx';

/** 每道多宽，像素。 */
const LANE_W = 168;

/** 表头多高，像素。 */
const HEAD_H = 34;

/** 方块多宽、多高，像素。 */
const BLOCK_W = 150;
const BLOCK_H = 26;

/** 一支箭头占一行，多高，像素。 */
const ARROW_H = 22;

/** 步与步之间的空隙，像素。 */
const STEP_GAP = 10;

/** 没人听的事件画的短箭头多长，像素。 */
const STUB_W = 36;

/** 方块、箭头标签最多显示几个字，多的省略（完整的放 title 里）。 */
const LABEL_MAX = 17;


/** 一个方块：一步落在它那道上。 */
interface SeqBlock {
  step: number;
  lane: number;
  y: number;
  text: string;
  error: boolean;
}


/** 一支箭头：某步发的某个事件，到一个监听者；没人听时 to 等于 from。 */
interface SeqArrow {
  step: number;
  event: string;
  from: number;
  to: number;
  y: number;
  /** 标签只在这个事件的第一支箭头上画。 */
  label: boolean;
  error: boolean;
}


/** 整张顺序图：尺寸和每一步的位置沿用表格的布局类型，滚动居中、适应窗口都用同一套。 */
export interface SeqLayout extends CanvasLayout {
  lanes: string[];
  blocks: SeqBlock[];
  arrows: SeqArrow[];
}


/** 事件行：不是函数的行。 */
function isEventRow(row: TrailRow): boolean {
  return row.kind !== '函数';
}


/** 过长的字省略。 */
function cut(text: string): string {
  if (text.length <= LABEL_MAX) return text;

  return `${text.slice(0, LABEL_MAX)}…`;
}


/**
 * 一步的一句话：和右栏 StepDetail 的标题同一个算法。
 * @param step 这一步。
 * @param t 翻译。
 */
function getStepText(step: TrailStep, t: i18n.Translate): string {
  const hasCaption = step.rows.some((row) => traceText.isTraceText(row.text));
  if (!hasCaption) return step.title;

  return traceText.getTraceStepTitle(step.rows, (text, params) => i18n.renderTrace(t, text, params));
}


/**
 * 摆顺序图：道照第一次出现的先后（先是每步所在的道，再是只听不做的监听者），一步一段往下，段里先方块后箭头。
 * @param trail 轨迹。
 * @param t 翻译。
 */
export function getSeqLayout(trail: Trail, t: i18n.Translate): SeqLayout {
  //M 道：每步所在的道，再补上只听不做的监听者。
  const lanes: string[] = [];
  const addLane = (name: string): void => {
    if (lanes.includes(name)) return;

    lanes.push(name);
  };
  for (const step of trail.steps) {
    addLane(step.node);
  }
  for (const step of trail.steps) {
    for (const row of step.rows.filter(isEventRow)) {
      row.listeners.forEach(addLane);
    }
  }

  //M 一步一段往下排：方块在上，这一步发的每个事件占一行箭头。
  const blocks: SeqBlock[] = [];
  const arrows: SeqArrow[] = [];
  const stepBoxes = new Map<number, { x: number; y: number; w: number; h: number }>();
  let y = HEAD_H + STEP_GAP;
  for (const step of trail.steps) {
    const lane = lanes.indexOf(step.node);
    blocks.push({ step: step.no, lane, y, text: getStepText(step, t), error: step.error });
    stepBoxes.set(step.no, { x: lane * LANE_W + (LANE_W - BLOCK_W) / 2, y, w: BLOCK_W, h: BLOCK_H });
    y += BLOCK_H;
    for (const row of step.rows.filter(isEventRow)) {
      const targets = row.listeners.filter((name) => name !== step.node).map((name) => lanes.indexOf(name));
      if (targets.length === 0) targets.push(lane);
      targets.forEach((to, index) => {
        arrows.push({
          step: step.no,
          event: row.name,
          from: lane,
          to,
          y: y + ARROW_H - 6,
          label: index === 0,
          error: row.error,
        });
      });
      y += ARROW_H;
    }
    y += STEP_GAP;
  }
  return { tops: [], heights: [], width: lanes.length * LANE_W, total: y, boxes: [], stepBoxes, lanes, blocks, arrows };
}


/** 道中线的横坐标。 */
function getLaneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}


/**
 * 顺序图。
 * @param props.canvas 后端交的轨迹。
 * @param props.layout getSeqLayout 摆好的。
 * @param props.picked 选中的第几步；0 没选。
 * @param props.event 高亮的事件名；'' 没有。
 * @param props.onPick 点方块。
 * @param props.onPickArrow 点箭头：哪一步、哪个事件。
 * @param props.pluginNames 全部已知插件名（道名能不能点）。
 * @param props.activePlugin 右栏正在看的插件。
 * @param props.onSelectPlugin 点道名在右栏看插件。
 */
export function SeqChart(props: {
  canvas: Canvas;
  layout: SeqLayout;
  picked: number;
  event: string;
  onPick: (step: number) => void;
  onPickArrow: (step: number, event: string) => void;
  pluginNames: Set<string>;
  activePlugin: string;
  onSelectPlugin: (name: string, ptab?: string) => void;
}): JSX.Element {
  const { layout } = props;
  return (
    <svg className="tu-seq" width={layout.width} height={layout.total}>
      <defs>
        <marker
          id="tu-seq-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>

      {/* 表头：道名；是插件的能点，右栏看它。 */}
      {layout.lanes.map((lane, index) => {
        let className = 'tu-seq-head';
        if (props.pluginNames.has(lane)) {
          className += ' clickable';
        }
        if (props.activePlugin === lane) {
          className += ' active';
        }
        return (
          <g
            key={lane}
            className={className}
            onClick={
              //M 点道名：是插件就在右栏看这个插件。
              () => {
                if (!props.pluginNames.has(lane)) return;

                props.onSelectPlugin(lane);
              }
            }
          >
            <rect x={index * LANE_W + 4} y={0} width={LANE_W - 8} height={HEAD_H - 4} rx={6} />
            <text x={getLaneX(index)} y={HEAD_H / 2 - 2} textAnchor="middle" dominantBaseline="middle">{lane}</text>
            <line className="tu-seq-life" x1={getLaneX(index)} y1={HEAD_H} x2={getLaneX(index)} y2={layout.total} />
          </g>
        );
      })}

      {/* 箭头在方块下面一层。 */}
      {layout.arrows.map((arrow, index) => {
        const fromX = getLaneX(arrow.from);
        let toX = getLaneX(arrow.to);
        if (arrow.to === arrow.from) {
          toX = fromX + STUB_W;
        }
        let className = 'tu-seq-arrow';
        if (arrow.event === props.event) {
          className += ' hit';
        }
        if (arrow.event === props.event && arrow.step === props.picked) {
          className += ' picked';
        }
        if (arrow.error) {
          className += ' error';
        }
        let labelX = fromX + 8;
        let anchor: 'start' | 'end' = 'start';
        if (toX < fromX) {
          labelX = fromX - 8;
          anchor = 'end';
        }
        return (
          <g
            key={`${String(index)}-${arrow.event}`}
            className={className}
            onClick={
              //M 点箭头：选中这一步并高亮这个事件，右栏看事件详情。
              () => props.onPickArrow(arrow.step, arrow.event)
            }
          >
            <title>{arrow.event}</title>
            <line className="tu-seq-hit" x1={fromX} y1={arrow.y} x2={toX} y2={arrow.y} />
            <line
              className="tu-seq-line"
              x1={fromX}
              y1={arrow.y}
              x2={toX}
              y2={arrow.y}
              markerEnd="url(#tu-seq-arrow)"
            />
            {arrow.label && <text x={labelX} y={arrow.y - 4} textAnchor={anchor}>{cut(arrow.event)}</text>}
          </g>
        );
      })}

      {/* 方块：一步一个，点了选中这一步。 */}
      {layout.blocks.map((block) => {
        let className = 'tu-seq-block';
        if (block.step === props.picked) {
          className += ' picked';
        }
        if (block.error) {
          className += ' error';
        }
        const x = block.lane * LANE_W + (LANE_W - BLOCK_W) / 2;
        return (
          <g
            key={block.step}
            className={className}
            onClick={
              //M 点方块：选中这一步。
              () => props.onPick(block.step)
            }
          >
            <title>{`#${String(block.step)} ${block.text}`}</title>
            <rect x={x} y={block.y} width={BLOCK_W} height={BLOCK_H} rx={5} />
            <text x={x + 8} y={block.y + BLOCK_H / 2} dominantBaseline="middle">
              {cut(`${String(block.step)} ${block.text}`)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}


/** 事件目录只拉一次，各处共用。 */
let catalogLoading: Promise<EventCatalogItem[]> | null = null;

/** 拉事件目录；还没生成（404）就交空表，右栏写明没有。 */
function loadCatalog(): Promise<EventCatalogItem[]> {
  if (catalogLoading !== null) return catalogLoading;

  catalogLoading = TutorialApi.get<{ events: EventCatalogItem[] }>('/api/tutorial/events').then(
    (body) => body.events,
    () => [],
  );
  return catalogLoading;
}


/** 发或听的一处：插件、函数、文件:行（点开 VS Code）。 */
function SiteItem(props: {
  item: EventSite;
  workspace: string;
  pluginNames: Set<string>;
  onSelectPlugin: (name: string, ptab?: string) => void;
}): JSX.Element {
  const { item } = props;
  return (
    <li>
      {props.pluginNames.has(item.plugin) && (
        <button
          type="button"
          className="tu-dep-tag clickable"
          onClick={() => props.onSelectPlugin(item.plugin, 'events')}
        >
          {item.plugin}
        </button>
      )}
      {!props.pluginNames.has(item.plugin) && <span className="tu-dep-tag skeleton">{item.plugin}</span>}
      {' '}
      <code className="tu-fn-name">{item.function}</code>
      <div className="tu-site"><SiteLink workspace={props.workspace} site={item.site} /></div>
    </li>
  );
}


/**
 * 点箭头看到的：事件名、谁发谁听、数据的 TS 类型、这一次实际带的值。
 * @param props.rows 这一步里这个事件名的行（同名发了几次就几行）。
 * @param props.workspace 源码根目录。
 * @param props.notes 关键变量的中文解释。
 * @param props.pluginNames 全部已知插件名。
 * @param props.onSelectPlugin 点插件名在右栏看。
 */
export function EventArrowDetail(props: {
  rows: TrailRow[];
  workspace: string;
  notes: Record<string, string>;
  pluginNames: Set<string>;
  onSelectPlugin: (name: string, ptab?: string) => void;
}): JSX.Element {
  const name = props.rows[0]?.name ?? '';
  const [catalog, setCatalog] = useState<EventCatalogItem[] | null>(null);
  //M 事件目录只拉一次。
  useEffect(() => {
    let alive = true;
    void loadCatalog().then((events) => {
      if (alive) setCatalog(events);
    });
    return () => {
      alive = false;
    };
  }, []);

  const item = catalog?.find((event) => event.name === name);
  //M 同名发了几次就几份，只有一份时直接给那份。
  let values: unknown = props.rows.map((row) => row.facts);
  if (props.rows.length === 1) {
    values = props.rows[0]?.facts;
  }
  return (
    <div className="tu-block tu-arrow-detail">
      <h4>事件 <code className="tu-fn-name">{name}</code></h4>
      {catalog === null && <p className="tu-muted">读事件目录…</p>}
      {catalog !== null && item === undefined && (
        <p className="tu-muted">事件目录里没有这个事件（目录没生成，或事件还没写进源码）。先跑 bun ztools/check-events/Check_Event_Docs.ts。</p>
      )}
      {item !== undefined && (
        <>
          <p className="tu-muted">{item.mode}{item.pair !== '' && ` · 一对：${item.pair}`}　{item.doc}</p>
          <div className="tu-site">声明：<SiteLink workspace={props.workspace} site={item.declaredAt} /></div>
          <h5>谁发</h5>
          {item.senders.length === 0 && <p className="tu-muted">没人发</p>}
          <ul>
            {item.senders.map((site) => (
              <SiteItem
                key={site.site}
                item={site}
                workspace={props.workspace}
                pluginNames={props.pluginNames}
                onSelectPlugin={props.onSelectPlugin}
              />
            ))}
          </ul>
          <h5>谁听</h5>
          {item.listeners.length === 0 && <p className="tu-muted">没人听</p>}
          <ul>
            {item.listeners.map((site) => (
              <SiteItem
                key={site.site}
                item={site}
                workspace={props.workspace}
                pluginNames={props.pluginNames}
                onSelectPlugin={props.onSelectPlugin}
              />
            ))}
          </ul>
          <h5>数据的 TS 类型</h5>
          <code className="tu-signature">{item.signature}</code>
          {item.types.map((type) => (
            <div key={type.name} className="tu-seq-type">
              <code className="tu-fn-name">{type.name}</code> <span className="tu-muted">{type.kind}　{type.doc}</span>
              <div className="tu-site"><SiteLink workspace={props.workspace} site={type.site} /></div>
              {type.definition !== '' && <pre className="tu-json">{type.definition}</pre>}
              <ul>
                {type.fields.map((field) => (
                  <li key={field.name}>
                    <code>{field.name}{field.optional && '?'}: {field.type}</code>
                    {field.doc !== '' && <span className="tu-muted"> {field.doc}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      <JsonBlock
        head={<h5>这一次实际带的值（跟踪点记下的关键值）</h5>}
        value={values}
        empty="这一次没记关键值"
        notes={props.notes}
      />
    </div>
  );
}


export { FEISHU_ROUTE, RouteStopItem, type RouteStop } from './TutorialContext.tsx';
