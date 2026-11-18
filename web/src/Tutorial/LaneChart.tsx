/**
 * 泳道图和点中一步的详情（教程页右栏的「画布」）。
 *   LaneChart：第一列是道名（插件），后面每列一个阶段；格子里列着落在这格的步，点一步就选中它。
 *     格子的位置按道、列算出来（固定列宽，行高按这一道最多几项），箭头画在上面一层 SVG 里：
 *     往右的从格子右边连到下一格左边；同一列往下的走格子右边的缝，往上的走左边的缝，不穿过中间的格子。
 *   StepDetail：这一步做了什么（每行的函数、事件、代码位置，能看实现、看谁调它），关键变量，用到的函数注释，
 *     和这一步那一刻的运行时变量（点开才取，和上一步比变了的标黄）。
 * 后端：src7/plugins/tutorial/Lanes.ts 摆格子，index.ts 的 /api/tutorial/canvas、/api/tutorial/snapshot。
 */
import { useContext, useEffect, useState, type JSX } from 'react';
import * as virtuoso from 'react-virtuoso';
import { CallerList, JsonBlock, PATH_SEP, SiteLink, SourceToggle, TutorialScrollContext, VIRTUAL_THRESHOLD } from './Code.tsx';
import { TutorialApi, type Canvas, type CodeDoc, type LaneCell, type StateGroup, type Trail, type TrailRow, type TrailStep } from './TutorialApi.ts';


/** 第一列（道名）多宽，像素。 */
const LABEL_W = 156;

/** 每列占多宽（含两边留给箭头的缝），像素。 */
const COLUMN_W = 184;

/** 列与列之间留给箭头的缝，像素。 */
const GAP_W = 30;

/** 表头多高，像素。 */
const HEAD_H = 34;

/** 格子里一项多高，像素。 */
const ITEM_H = 22;

/** 格子上下的内边距，像素。 */
const CELL_PAD = 5;

/** 道与道之间的空隙，像素。 */
const ROW_GAP = 8;

/** 同一列里箭头往缝里弯多少，像素。 */
const BEND = 12;


/** 一个格子或一步在画布坐标系上的位置。 */
export interface Box {
  /** 左边。 */
  x: number;
  /** 上边。 */
  y: number;
  /** 宽。 */
  w: number;
  /** 高。 */
  h: number;
}

/** 整张泳道图的布局尺寸与每个格子、每一步的位置映射。 */
export interface CanvasLayout {
  tops: number[];
  heights: number[];
  width: number;
  total: number;
  boxes: Box[];
  stepBoxes: Map<number, Box>;
}


/**
 * 每一道的上边和高：高按这一道里最多几项的格子算。
 * @param laneCount 几道。
 * @param cells 格子。
 * @returns 每道的上边、高，和整张图多高。
 */
function getRows(laneCount: number, cells: LaneCell[]): { tops: number[]; heights: number[]; total: number } {
  //M 每道最多几项：没有格子的道也留一项高。
  const most: number[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    most.push(1);
  }
  for (const cell of cells) {
    const now = most[cell.lane] ?? 1;
    most[cell.lane] = Math.max(now, cell.items.length);
  }

  //M 从表头下面一道一道往下排。
  const tops: number[] = [];
  const heights: number[] = [];
  let y = HEAD_H;
  for (const count of most) {
    const height = CELL_PAD * 2 + count * ITEM_H;
    tops.push(y);
    heights.push(height);
    y += height + ROW_GAP;
  }
  return { tops, heights, total: y };
}


/**
 * 一个格子的位置。
 * @param cell 格子。
 * @param tops 每道的上边。
 * @param heights 每道的高。
 */
function getBox(cell: LaneCell, tops: number[], heights: number[]): Box {
  const x = LABEL_W + cell.column * COLUMN_W + GAP_W / 2;
  const y = tops[cell.lane] ?? 0;
  const h = heights[cell.lane] ?? ITEM_H;
  return { x, y, w: COLUMN_W - GAP_W, h };
}


/**
 * 一个箭头的路径：往右的从右边连左边；同一列往下走右边的缝、往上走左边的缝；往左的从左边连右边。
 * @param from 起点格。
 * @param to 终点格。
 * @param sameColumn 两格在不在同一列。
 */
function getEdgePath(from: Box, to: Box, sameColumn: boolean): string {
  const fromMid = from.y + from.h / 2;
  const toMid = to.y + to.h / 2;

  //M 同一列：往下的走右边的缝，往上的走左边的缝。
  if (sameColumn) {
    if (to.y > from.y) {
      const right = from.x + from.w;
      return `M ${right} ${fromMid} C ${right + BEND} ${fromMid}, ${right + BEND} ${toMid}, ${right + 2} ${toMid}`;
    }
    const left = from.x;
    return `M ${left} ${fromMid} C ${left - BEND} ${fromMid}, ${left - BEND} ${toMid}, ${left - 2} ${toMid}`;
  }

  //M 往右：右边连到下一格的左边，两头水平。
  if (to.x > from.x) {
    const startX = from.x + from.w;
    const endX = to.x - 2;
    const middle = (startX + endX) / 2;
    return `M ${startX} ${fromMid} C ${middle} ${fromMid}, ${middle} ${toMid}, ${endX} ${toMid}`;
  }

  //M 往左（少见）：左边连到那一格的右边。
  const startX = from.x;
  const endX = to.x + to.w + 2;
  const middle = (startX + endX) / 2;
  return `M ${startX} ${fromMid} C ${middle} ${fromMid}, ${middle} ${toMid}, ${endX} ${toMid}`;
}


/**
 * 计算整张泳道图的总宽高、每道坐标、每格坐标与每一步的精确坐标（用于自适应视口与选中步自动居中）。
 * @param lanes 后端返回的泳道数据。
 */
export function getCanvasLayout(lanes: Canvas['lanes']): CanvasLayout {
  //M 按每道最大并发步数估算各道垂直位置与总高度。
  const { tops, heights, total } = getRows(lanes.lanes.length, lanes.cells);
  const width = LABEL_W + lanes.columns.length * COLUMN_W;
  //M 计算每个非空格子在泳道网格坐标系中的绝对矩形框。
  const boxes = lanes.cells.map((cell) => getBox(cell, tops, heights));
  const stepBoxes = new Map<number, Box>();
  for (let cellIdx = 0; cellIdx < lanes.cells.length; cellIdx += 1) {
    const cell = lanes.cells[cellIdx];
    const box = boxes[cellIdx];
    if (cell === undefined || box === undefined) continue;

    for (let itemIdx = 0; itemIdx < cell.items.length; itemIdx += 1) {
      const item = cell.items[itemIdx];
      if (item === undefined) continue;

      stepBoxes.set(item.step, {
        x: box.x,
        y: box.y + CELL_PAD + itemIdx * ITEM_H,
        w: box.w,
        h: ITEM_H,
      });
    }
  }
  return { tops, heights, width, total, boxes, stepBoxes };
}


/**
 * 泳道图：道名若是已知插件可点开右侧插件分栏，事件高亮时命中的格子和步骤加亮。
 * 桌面铺底模式下直接渲染自由画布，外层负责平移缩放；窄屏退化时使用横向可滚容器。
 * @param props.canvas 后端交的轨迹和泳道图。
 * @param props.picked 选中的第几步；0 是没选。
 * @param props.onPick 点了格子里的一步。
 * @param props.pluginNames 全部已知插件名（道名能否点击跳插件）。
 * @param props.activePlugin 右侧当前正展示的插件名（空串为未打开）。
 * @param props.matchedSteps 当前高亮事件命中的步骤集合。
 * @param props.onSelectPlugin 点击道名在右侧查看插件说明。
 * @param props.panZoom 是否处于底层平移缩放画布模式。
 */
export function LaneChart(props: {
  canvas: Canvas;
  picked: number;
  onPick: (step: number) => void;
  pluginNames: Set<string>;
  activePlugin: string;
  matchedSteps: Set<number>;
  onSelectPlugin: (name: string, ptab?: string) => void;
  panZoom?: boolean;
}): JSX.Element {
  const { lanes } = props.canvas;
  //M 计算泳道画布布局尺寸与全部格子的绝对位置，供单元格及 SVG 连线共用。
  const { tops, heights, width, total, boxes } = getCanvasLayout(lanes);

  let lanesClass = 'tu-lanes';
  let labelColClass = 'tu-lane-sticky-col';
  if (props.panZoom === true) {
    lanesClass = 'tu-lanes tu-lanes-surface';
    labelColClass = 'tu-lane-col';
  }

  const chart = (
    <div className={lanesClass} style={{ width, height: total }}>
      {/* 表头：每列的阶段名。 */}
      {lanes.columns.map((column, index) => (
        <div key={column} className="tu-lane-head" style={{ left: LABEL_W + index * COLUMN_W, width: COLUMN_W }}>
          {column}
        </div>
      ))}

      {/* 第一列：道名（窄屏横向滚动时吸左，桌面自由画布时绝对定位跟随缩放）。 */}
      <div className={labelColClass} style={{ width: LABEL_W, height: total }}>
        <div className="tu-lane-corner" style={{ width: LABEL_W, height: 34 }} />
        {lanes.lanes.map((lane, index) => {
          const top = tops[index] ?? 0;
          const height = heights[index] ?? ITEM_H;
          const isPlugin = props.pluginNames.has(lane);
          const isActiveLane = props.activePlugin !== '' && props.activePlugin === lane;
          let labelClass = 'tu-lane-label';
          if (index % 2 === 1) {
            labelClass += ' odd';
          }
          if (isPlugin) {
            labelClass += ' clickable';
          }
          if (isActiveLane) {
            labelClass += ' active';
          }
          const labelBoxStyle = { top: top - ROW_GAP / 2, height: height + ROW_GAP, width: LABEL_W };
          return (
            <div key={lane} className="tu-lane-label-wrap" style={labelBoxStyle}>
              {isPlugin && (
                <button
                  type="button"
                  className={labelClass}
                  style={{ width: LABEL_W }}
                  title={`点击查看 ${lane} 插件详情`}
                  onClick={
                    //M 点击左列插件道名时在右侧「插件」页签打开该插件说明。
                    () => props.onSelectPlugin(lane)
                  }
                >
                  {lane}
                </button>
              )}
              {!isPlugin && (
                <span className={labelClass} style={{ width: LABEL_W }} title={lane}>{lane}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* 泳道行底色与选中整行高亮：保持在格子下层横跨全宽。 */}
      {lanes.lanes.map((lane, index) => {
        const top = tops[index] ?? 0;
        const height = heights[index] ?? ITEM_H;
        const isActiveLane = props.activePlugin !== '' && props.activePlugin === lane;
        let className = 'tu-lane-row';
        if (index % 2 === 1) {
          className += ' odd';
        }
        if (isActiveLane) {
          className += ' active-plugin';
        }
        return (
          <div key={lane} className={className} style={{ top: top - ROW_GAP / 2, height: height + ROW_GAP, width }} />
        );
      })}

      {/* 箭头：在格子下面一层，不挡点。 */}
      <svg className="tu-lane-edges" width={width} height={total}>
        <defs>
          <marker id="tu-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {lanes.edges.map((edge) => {
          const fromCell = lanes.cells[edge.from];
          const toCell = lanes.cells[edge.to];
          const from = boxes[edge.from];
          const to = boxes[edge.to];
          if (fromCell === undefined || toCell === undefined || from === undefined || to === undefined) return null;

          //M 连着选中的那一步的箭头加亮。
          const sameColumn = fromCell.column === toCell.column;
          const path = getEdgePath(from, to, sameColumn);
          const fromPicked = fromCell.items.some((item) => item.step === props.picked);
          const toPicked = toCell.items.some((item) => item.step === props.picked);
          let className = 'tu-edge';
          if (fromPicked || toPicked) {
            className = 'tu-edge picked';
          }
          return <path key={`${String(edge.from)}-${String(edge.to)}`} className={className} d={path} markerEnd="url(#tu-arrow)" />;
        })}
      </svg>

      {/* 格子：每项一步，点了选中这一步；若当前有事件高亮且命中，给格子与步骤项加醒目标记。 */}
      {lanes.cells.map((cell, index) => {
        const box = boxes[index];
        if (box === undefined) return null;

        const hasPicked = cell.items.some((item) => item.step === props.picked);
        const hasEventHit = cell.items.some((item) => props.matchedSteps.has(item.step));
        let className = 'tu-cell';
        if (cell.error) {
          className += ' error';
        }
        if (hasEventHit) {
          className += ' event-hit';
        }
        if (hasPicked) {
          className += ' picked';
        }
        return (
          <div key={`${String(cell.lane)}-${String(cell.column)}`} className={className} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
            {cell.items.map((item) => {
              let itemClass = 'tu-cell-item';
              if (props.matchedSteps.has(item.step)) {
                itemClass += ' event-hit';
              }
              if (item.step === props.picked) {
                itemClass += ' picked';
              }
              const title = `第 ${String(item.step)} 步：${item.text}`;
              return (
                <button
                  key={item.step}
                  type="button"
                  className={itemClass}
                  title={title}
                  onClick={
                    //M 点击格子中的步骤编号后选中该步并弹出其右栏详情。
                    () => props.onPick(item.step)
                  }
                >
                  <b>{item.step}</b> {item.text}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );

  if (props.panZoom === true) return chart;

  return <div className="tu-lanes-scroll">{chart}</div>;
}


/**
 * 一步的关键变量：只有一行带变量就是那行的；几行都带就每行一项，标上函数名或事件名。
 * @param step 这一步。
 * @returns 没有变量是 undefined。
 */
function getStepVars(step: TrailStep): unknown {
  const rows = step.rows.filter((row) => Object.keys(row.facts).length > 0);
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return rows[0]?.facts;

  return rows.map((row) => ({ name: row.name, ...row.facts }));
}


/** 函数归并后的单行数据类型。 */
interface FunctionSummaryRow {
  name: string;
  site: string;
  text: string;
  count: number;
}


/**
 * 这一步里的函数行，同名同位置的并成一项（数一下几次）。
 * @param step 这一步。
 */
function getFunctionRows(step: TrailStep): FunctionSummaryRow[] {
  const found = new Map<string, FunctionSummaryRow>();
  for (const row of step.rows) {
    if (row.kind !== '函数') continue;

    const key = `${row.name}\0${row.site}`;
    const before = found.get(key);
    if (before !== undefined) {
      before.count += 1;
      continue;
    }
    found.set(key, { name: row.name, site: row.site, text: row.text, count: 1 });
  }
  return [...found.values()];
}


/**
 * 一段函数注释的内容主体：名字、原型、可直开 VS Code 的位置、解释、实现、谁调它。
 * @param props.doc 注释。
 * @param props.workspace 源码根目录。
 */
function DocItemBody(props: { doc: CodeDoc; workspace: string }): JSX.Element {
  const { doc } = props;
  let summary = doc.summary;
  if (!doc.important) {
    summary = doc.summary.split('\n')[0] ?? '';
  }
  const params = doc.params.map((param) => `${param.name} ${param.text}`).join('；');
  return (
    <>
      <code className="tu-fn-name">{doc.name}</code>
      {doc.missing !== '' && <span className="tu-error"> {doc.missing}</span>}
      {doc.signature !== '' && <code className="tu-signature">{doc.signature}</code>}
      <div className="tu-site">
        <SiteLink workspace={props.workspace} site={doc.site} />
      </div>
      {summary !== '' && <p className="tu-muted tu-pre">{summary}</p>}
      {doc.important && params !== '' && <p>输入：{params}</p>}
      {doc.important && doc.effects !== '' && <p>改了什么：{doc.effects}</p>}
      {doc.important && doc.returns !== '' && <p>输出：{doc.returns}</p>}
      {doc.important && doc.throws !== '' && <p>出错：{doc.throws}</p>}
      {doc.signature !== '' && <SourceToggle site={doc.site} />}
      {doc.signature !== '' && <CallerList site={doc.site} />}
    </>
  );
}


/**
 * 渲染“走到的函数”单条内容。
 */
function FunctionRowBody(props: { item: FunctionSummaryRow; workspace: string }): JSX.Element {
  const { item } = props;
  return (
    <>
      <code className="tu-fn-name">{item.name}</code>
      {item.count > 1 && <span className="tu-muted"> ×{item.count}</span>}
      {item.text !== '' && <span> {item.text}</span>}
      <div className="tu-site">
        <SiteLink workspace={props.workspace} site={item.site} />
      </div>
      <SourceToggle site={item.site} />
      <CallerList site={item.site} />
    </>
  );
}


/**
 * 渲染“发的事件”单条内容。
 */
function EventRowBody(props: {
  row: TrailRow;
  workspace: string;
  pluginNames: Set<string>;
  highlightEvent: string;
  onSelectPlugin: (name: string, ptab?: string) => void;
  onSelectEvent: (eventName: string) => void;
}): JSX.Element {
  const { row } = props;
  let pillClass = 'tu-event-pill';
  if (props.highlightEvent === row.name) {
    pillClass = 'tu-event-pill active';
  }
  return (
    <>
      <button
        type="button"
        className={pillClass}
        title={`点击在当前画布上高亮事件 ${row.name}`}
        onClick={
          //M 点击事件徽章在画布上高亮所有触发过该事件的步骤格子。
          () => props.onSelectEvent(row.name)
        }
      >
        {row.name}
      </button>
      {row.text !== '' && <span> {row.text}</span>}
      {row.listeners.length > 0 && (
        <div className="tu-listener-tags">
          <span className="tu-muted">听的人：</span>
          {row.listeners.map((listener) => {
            if (props.pluginNames.has(listener)) {
              return (
                <button
                  key={listener}
                  type="button"
                  className="tu-dep-tag clickable"
                  title={`点击在右侧查看 ${listener} 的事件监听处理`}
                  onClick={
                    //M 点击监听插件标签直接跳转到右侧该插件的「事件」分栏。
                    () => props.onSelectPlugin(listener, 'events')
                  }
                >
                  {listener}
                </button>
              );
            }
            return (
              <span key={listener} className="tu-dep-tag skeleton">{listener}</span>
            );
          })}
        </div>
      )}
      <div className="tu-site">
        <SiteLink workspace={props.workspace} site={row.site} />
      </div>
      <SourceToggle site={row.site} label="看发它的那段" />
    </>
  );
}


/**
 * 运行时变量快照单组折合块。
 */
function SnapshotGroupItem(props: { group: StateGroup; changed: Set<string> | undefined }): JSX.Element {
  const { group, changed } = props;
  let title = group.name;
  if (changed !== undefined) {
    title = `${group.name} · 变了 ${String(changed.size)} 处`;
  }
  let className = 'tu-state-group';
  if (changed !== undefined) {
    className = 'tu-state-group changed';
  }
  return (
    <details className={className} open={changed !== undefined}>
      <summary>{title}</summary>
      <JsonBlock head={<span className="tu-muted">{group.note}</span>} value={group.value} empty="（空）" marks={changed} notes={group.notes} />
    </details>
  );
}


/**
 * 这一步那一刻的运行时变量：点开才向后端要（快照很大），和上一步比变了的组、键标黄；组数 >= 30 时开启虚拟滚动。
 * @param props.canvas 画布名：boot 或消息号。
 * @param props.step 第几步。
 * @param props.keyword 快照关键词：没快照时提示用。
 */
function StepSnapshot(props: { canvas: string; step: number; keyword: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState<{ changed: string[][] | null; groups: StateGroup[] } | null>(null);
  const [error, setError] = useState('');
  const scrollParent = useContext(TutorialScrollContext);

  //M 换了步：清掉上一步的。
  useEffect(() => {
    setShot(null);
    setError('');
  }, [props.canvas, props.step]);

  //M 开着才取。
  useEffect(() => {
    if (!open) return undefined;

    let alive = true;
    const query = `name=${encodeURIComponent(props.canvas)}&step=${String(props.step)}`;
    //M 仅当用户点开“运行时变量”折合框时按需拉取当前步骤快照及前一步变更路径。
    const loading = TutorialApi.get<{ changed: string[][] | null; groups: StateGroup[] }>(`/api/tutorial/snapshot?${query}`);
    loading.then((result) => {
      if (alive) setShot(result);
    }, (failed: unknown) => {
      if (alive) setError((failed as Error).message);
    });
    return () => {
      alive = false;
    };
  }, [open, props.canvas, props.step]);

  //M 变了的地方按组分开：组名去掉，剩下的路径连成一个键给 JsonBlock。
  const marks = new Map<string, Set<string>>();
  for (const keyPath of shot?.changed ?? []) {
    const [groupName = '', ...rest] = keyPath;
    const set = marks.get(groupName) ?? new Set<string>();
    set.add(rest.join(PATH_SEP));
    marks.set(groupName, set);
  }

  //M 顶上一句：变了几处；第一步没得比。
  let said = '';
  if (shot !== null) {
    said = '第一步，没有上一步可比';
    if (shot.changed !== null) {
      said = `比上一步变了 ${String(shot.changed.length)} 处（标黄）`;
    }
  }

  const groups = shot?.groups ?? [];
  const useVirtual = open && groups.length >= VIRTUAL_THRESHOLD && scrollParent !== null;

  return (
    <details className="tu-snapshot" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>这一步那一刻的运行时变量（事件发出时拍的；带 {props.keyword} 的消息和启动才有）</summary>
      {error !== '' && <p className="tu-error">{error}</p>}
      {open && shot === null && error === '' && <p className="tu-muted">正在取…</p>}
      {said !== '' && <p className="tu-muted">{said}</p>}
      {useVirtual && (
        <virtuoso.Virtuoso
          customScrollParent={scrollParent}
          data={groups}
          computeItemKey={(_index, group) => group.name}
          itemContent={(_index, group) => <SnapshotGroupItem group={group} changed={marks.get(group.name)} />}
        />
      )}
      {!useVirtual && groups.map((group) => (
        <SnapshotGroupItem key={group.name} group={group} changed={marks.get(group.name)} />
      ))}
    </details>
  );
}


/**
 * 点中一步的详情：函数实现（支持直开 VS Code）、发出的事件（可点高亮画布）及听它的插件标签、关键变量与快照。
 * 长列表 >= 30 项借外层右栏容器做虚拟滚动。
 * @param props.canvas 画布名：boot 或消息号。
 * @param props.trail 整条轨迹（说明表 notes 用它的）。
 * @param props.step 选中的这一步。
 * @param props.workspace 源码根目录。
 * @param props.keyword 快照关键词。
 * @param props.pluginNames 全部已知插件名。
 * @param props.highlightEvent 当前高亮的事件名。
 * @param props.onSelectPlugin 点击跳转并切到指定插件与标签页。
 * @param props.onSelectEvent 点击事件名高亮画布对应步骤。
 */
export function StepDetail(props: {
  canvas: string;
  trail: Trail;
  step: TrailStep;
  workspace: string;
  keyword: string;
  pluginNames: Set<string>;
  highlightEvent: string;
  onSelectPlugin: (name: string, ptab?: string) => void;
  onSelectEvent: (eventName: string) => void;
}): JSX.Element {
  const { step, workspace } = props;
  const scrollParent = useContext(TutorialScrollContext);
  //M 过滤出当前步中属于函数跟踪点的执行记录。
  const functions = getFunctionRows(step);
  const events = step.rows.filter((row) => row.kind !== '函数');
  const heard = step.rows.flatMap((row) => row.listeners);
  const listeners = [...new Set(heard)];
  const stepIsPlugin = props.pluginNames.has(step.node);

  const virtFunctions = functions.length >= VIRTUAL_THRESHOLD && scrollParent !== null;
  const virtEvents = events.length >= VIRTUAL_THRESHOLD && scrollParent !== null;
  const virtDocs = step.docs.length >= VIRTUAL_THRESHOLD && scrollParent !== null;

  return (
    <div className="tu-detail">
      <div className="tu-head-row">
        <h3>
          第 {step.no} 步 · {step.node}
          <span className="tu-muted"> · 用了 {step.ms} 毫秒</span>
        </h3>
        {stepIsPlugin && (
          <button
            type="button"
            className="tu-step-plugin-btn"
            onClick={
              //M 点击后在右侧切换到「插件」分栏并选中当前步所属插件。
              () => props.onSelectPlugin(step.node)
            }
          >
            查看 {step.node} 插件 →
          </button>
        )}
      </div>
      <p>{step.title}</p>

      {functions.length > 0 && (
        <div className="tu-block">
          <h4>走到的函数（{functions.length}）</h4>
          {virtFunctions && (
            <div className="tu-virt-list">
              <virtuoso.Virtuoso
                customScrollParent={scrollParent}
                data={functions}
                computeItemKey={(_index, item) => `${item.name}-${item.site}`}
                itemContent={(_index, item) => (
                  <div className="tu-virt-item">
                    <FunctionRowBody item={item} workspace={workspace} />
                  </div>
                )}
              />
            </div>
          )}
          {!virtFunctions && (
            <ul>
              {functions.map((item) => (
                <li key={`${item.name}-${item.site}`}>
                  <FunctionRowBody item={item} workspace={workspace} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div className="tu-block">
          <h4>发的事件（{events.length}）</h4>
          {virtEvents && (
            <div className="tu-virt-list">
              <virtuoso.Virtuoso
                customScrollParent={scrollParent}
                data={events}
                computeItemKey={(index, row) => `${row.name}-${String(index)}`}
                itemContent={(_index, row) => (
                  <div className="tu-virt-item">
                    <EventRowBody
                      row={row}
                      workspace={workspace}
                      pluginNames={props.pluginNames}
                      highlightEvent={props.highlightEvent}
                      onSelectPlugin={props.onSelectPlugin}
                      onSelectEvent={props.onSelectEvent}
                    />
                  </div>
                )}
              />
            </div>
          )}
          {!virtEvents && (
            <ul>
              {events.map((row, index) => (
                <li key={`${row.name}-${String(index)}`}>
                  <EventRowBody
                    row={row}
                    workspace={workspace}
                    pluginNames={props.pluginNames}
                    highlightEvent={props.highlightEvent}
                    onSelectPlugin={props.onSelectPlugin}
                    onSelectEvent={props.onSelectEvent}
                  />
                </li>
              ))}
            </ul>
          )}
          {listeners.length > 0 && step.notified.length > 0 && (
            <p className="tu-muted">只听没留下跟踪点的：{step.notified.join('、')}</p>
          )}
        </div>
      )}

      <div className="tu-block">
        <JsonBlock
          head={<h4>关键变量</h4>}
          value={
            //M 合并并抽取本步所有跟踪行携带的关键调试变量。
            getStepVars(step)
          }
          empty="这一步没有记下变量。"
          notes={props.trail.notes}
        />
      </div>

      {step.docs.length > 0 && (
        <div className="tu-block">
          <h4>用到的函数（注释取自代码，{step.docs.length}）</h4>
          {virtDocs && (
            <div className="tu-virt-list">
              <virtuoso.Virtuoso
                customScrollParent={scrollParent}
                data={step.docs}
                computeItemKey={(_index, doc) => `${doc.name}-${doc.site}`}
                itemContent={(_index, doc) => (
                  <div className="tu-virt-item">
                    <DocItemBody doc={doc} workspace={workspace} />
                  </div>
                )}
              />
            </div>
          )}
          {!virtDocs && (
            <ul>
              {step.docs.map((doc) => (
                <li key={`${doc.name}-${doc.site}`}>
                  <DocItemBody doc={doc} workspace={workspace} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <StepSnapshot canvas={props.canvas} step={step.no} keyword={props.keyword} />
    </div>
  );
}
