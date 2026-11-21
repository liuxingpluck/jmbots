/**
 * 教程底层全视口泳道图与顺序图舞台（按需懒加载 chunk）：
 * 桌面模式支持拖拽平移与滚轮缩放、自带左上角 HUD 与左下角工具条；
 * 窄屏（< 800px）默认使用纵向时间线步骤卡片并支持原地展开详情，同时保留泳道全景与顺序图切换。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Alert, Spin } from 'antd';
import * as i18n from '../I18n.ts';
import * as traceText from '../locales/Trace.ts';
import { LaneChart, StepDetail, getCanvasLayout, type CanvasLayout } from './LaneChart.tsx';
import { SeqChart, getSeqLayout } from './SeqChart.tsx';
import { StepDataFlowPanel, findStepFlow, resolveTrailDataFlow } from './StepDataFlow.tsx';
import { TutorialApi, type Canvas, type Trail, type TrailDataFlow, type TrailStep } from './TutorialApi.ts';
import { clamp, getChannelLabel, getMatchedSteps, type NarrowTraceMode } from './TutorialContext.tsx';


/** 底层画布平移缩放状态（桌面模式用 CSS transform）。 */
interface CanvasTransform {
  tx: number;
  ty: number;
  scale: number;
}

/** 画布中间未被左右浮栏遮挡的安全可视区域，单位像素。 */
interface SafeViewport {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;


/**
 * 算出当前画布中间未被左右浮栏遮挡的安全区域边界。
 */
function getSafeViewport(
  stageW: number,
  stageH: number,
  leftOpen: boolean,
  leftW: number,
  rightOpen: boolean,
  rightW: number,
): SafeViewport {
  let left = 92;
  if (leftOpen) {
    left = leftW + 24;
  }
  let right = stageW - 92;
  if (rightOpen) {
    right = stageW - rightW - 24;
  }
  const safeRight = Math.max(left + 180, right);
  const top = 56;
  const bottom = Math.max(top + 120, stageH - 54);
  return {
    left,
    top,
    right: safeRight,
    bottom,
    width: Math.max(180, safeRight - left),
    height: Math.max(120, bottom - top),
  };
}


/**
 * 算出让整张泳道图自适应放进中间安全可视区的平移与缩放。
 */
function getFitTransform(layout: CanvasLayout, safe: SafeViewport): CanvasTransform {
  const pad = 16;
  const availW = Math.max(120, safe.width - pad * 2);
  const availH = Math.max(100, safe.height - pad * 2);
  const scaleX = availW / Math.max(1, layout.width);
  const scaleY = availH / Math.max(1, layout.total);
  //M 用宽高里能容纳全图的一项，并允许小图在正常缩放范围内放大。
  const fitted = Math.min(scaleX, scaleY);
  const scale = clamp(fitted, MIN_SCALE, MAX_SCALE);
  const drawnW = layout.width * scale;
  const drawnH = layout.total * scale;
  const tx = Math.round(safe.left + Math.max(pad, (safe.width - drawnW) / 2));
  const ty = Math.round(safe.top + Math.max(8, (safe.height - drawnH) / 2));
  return { tx, ty, scale };
}


/** 把轨迹一步的标题还原为当前语言的自然短句，避免把原始 trace 键名摆上卡片。 */
function getStepDisplayTitle(step: TrailStep, tr: i18n.Translate): string {
  let text = step.title;
  if (traceText.isTraceText(text) || text === '') {
    text = traceText.getTraceStepTitle(step.rows, (id, params) => i18n.renderTrace(tr, id, params));
  }
  if (text === '') return step.node;

  return text;
}


/** 提取一步里发出的不重复事件名（最多 3 个），供窄屏步骤卡片速览。 */
function getStepEvents(step: TrailStep): string[] {
  const names: string[] = [];
  for (const row of step.rows) {
    if (row.kind !== '事件') continue;
    if (names.includes(row.name)) continue;
    names.push(row.name);
    if (names.length >= 3) break;
  }
  return names;
}


/** 格式化一步耗时文本，慢操作（>= 500ms）转秒显示更直观。 */
function formatStepDuration(ms: number): string {
  if (ms <= 0) return '<1ms';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${String(ms)}ms`;
}


/** 把轨迹状态英文转成直观中文短标签。 */
function getTrailStateLabel(state: string): string {
  if (state === 'done') return '已完成';
  if (state === 'running') return '处理中';
  if (state === 'failed') return '出错';
  if (state === 'stopped') return '已停止';
  return state;
}


/** 底层全视口泳道图舞台参数。 */
export interface CanvasStageProps {
  name: string;
  step: number;
  onPick: (step: number) => void;
  onPickArrow: (step: number, event: string) => void;
  keyword: string;
  hasSnapshot?: boolean;
  pluginNames: Set<string>;
  activePlugin: string;
  highlightEvent: string;
  onSelectPlugin: (name: string, ptab?: string) => void;
  onOpenSkeletonLines: (skeletonFile: string) => void;
  onSelectEvent: (eventName: string) => void;
  onClearEvent: () => void;
  onTrailLoaded: (canvasName: string, trail: Trail | null, dataFlow?: TrailDataFlow | null) => void;
  workspace: string;
  leftOpen: boolean;
  leftWidth: number;
  rightOpen: boolean;
  rightWidth: number;
  isNarrow: boolean;
  narrowMode: NarrowTraceMode;
  onNarrowModeChange: (mode: NarrowTraceMode) => void;
}


/** 底层全视口泳道图舞台。 */
export function CanvasStage(props: CanvasStageProps): JSX.Element {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  //M 桌面画布两种看法：表格（泳道）、顺序图。
  const [look, setLook] = useState<'table' | 'seq'>('table');
  const [mobileFit, setMobileFit] = useState(true);
  const [narrowWidth, setNarrowWidth] = useState(() => Math.max(300, window.innerWidth - 28));
  const tr = i18n.useT();
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [transform, setTransform] = useState<CanvasTransform>({ tx: 296, ty: 68, scale: 1 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const autoFittedForRef = useRef('');
  const lastCenteredStepRef = useRef('');
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const { onTrailLoaded } = props;

  //M 拉取当前画布的数据。
  useEffect(() => {
    setCanvas(null);
    setError('');
    onTrailLoaded(props.name, null, null);
    let alive = true;
    const url = `/api/tutorial/canvas?name=${encodeURIComponent(props.name)}`;
    const loading = TutorialApi.get<Canvas>(url);
    loading.then((loaded) => {
      if (!alive) return;

      setCanvas(loaded);
      //M 画布轨迹加载成功后通知顶层页面保存当前活动轨迹与数据流转，并联动右侧步骤详情。
      onTrailLoaded(props.name, loaded.trail, loaded.dataFlow ?? null);
    }, (failed: unknown) => {
      if (alive) {
        setError((failed as Error).message);
      }
    });
    return () => {
      alive = false;
    };
  }, [props.name, onTrailLoaded]);

  const resolvedDataFlow = useMemo(() => {
    if (canvas === null) return null;

    return resolveTrailDataFlow(canvas.trail, canvas.dataFlow);
  }, [canvas]);

  const seqLayout = useMemo(() => {
    if (canvas === null) return null;

    //M 顺序图的摆法：道、方块、箭头。
    return getSeqLayout(canvas.trail, tr);
  }, [canvas, tr]);

  const layout = useMemo(() => {
    if (canvas === null) return null;

    //M 预计算当前看法的尺寸及每步包围盒缓存，供视图居中与窄屏缩宽复用。
    if (props.isNarrow && props.narrowMode === 'seq') return seqLayout;
    if (!props.isNarrow && look === 'seq') return seqLayout;

    return getCanvasLayout(canvas.lanes);
  }, [canvas, look, props.isNarrow, props.narrowMode, seqLayout]);

  //M 计算此刻不被左右两浮栏挡住的中间区域。
  const getLiveSafe = useCallback((): SafeViewport => {
    const stageW = stageRef.current?.clientWidth || window.innerWidth;
    const stageH = stageRef.current?.clientHeight || Math.max(400, window.innerHeight - 52);
    return getSafeViewport(stageW, stageH, props.leftOpen, props.leftWidth, props.rightOpen, props.rightWidth);
  }, [props.leftOpen, props.leftWidth, props.rightOpen, props.rightWidth]);

  //M 适应窗口：把整张泳道图缩放并居中摆进中间可见区域。
  const fitToWindow = useCallback((): void => {
    if (layout === null) return;

    //M 基于当前安全可视区反算全图自适应变换并应用到画布。
    const safe = getLiveSafe();
    setTransform(getFitTransform(layout, safe));
  }, [getLiveSafe, layout]);

  //M 100% 原比例：停在中间安全区左上角。
  const resetToHundred = useCallback((): void => {
    const safe = getLiveSafe();
    setTransform({ tx: safe.left + 8, ty: safe.top + 8, scale: 1 });
  }, [getLiveSafe]);

  //M 每次切换到一张新画布加载完毕时，自动适应一次窗口，开页就一眼看得全。
  useEffect(() => {
    if (props.isNarrow || layout === null) return;

    const fitKey = `${props.name}:${String(layout.width)}:${String(layout.total)}`;
    if (autoFittedForRef.current === fitKey) return;

    autoFittedForRef.current = fitKey;
    lastCenteredStepRef.current = '';
    //M 初次展现该画布时重置缩放平移矩阵使整张泳道图恰好居中可见。
    setTransform(getFitTransform(layout, getLiveSafe()));
  }, [getLiveSafe, layout, props.isNarrow, props.name]);

  //M 选中某一步时：若它落在左右两浮栏下面或屏幕外（尤其被右栏遮住），自动把画布平移到中间安全区看得见的地方。
  useEffect(() => {
    if (props.isNarrow || layout === null || props.step <= 0) {
      lastCenteredStepRef.current = '';
      return;
    }
    const stepKey = `${props.name}#${String(props.step)}:${String(props.rightOpen)}:${String(props.leftOpen)}`;
    if (lastCenteredStepRef.current === stepKey) return;

    lastCenteredStepRef.current = stepKey;
    //M 查表获得当前选中步所在的像素包围盒，找不到则保持视口不动。
    const box = layout.stepBoxes.get(props.step);
    if (box === undefined) return;

    const safe = getLiveSafe();
    setTransform((prev) => {
      const pad = 20;
      const stepLeft = prev.tx + box.x * prev.scale;
      const stepRight = stepLeft + box.w * prev.scale;
      const stepTop = prev.ty + box.y * prev.scale;
      const stepBottom = stepTop + box.h * prev.scale;

      let nextTx = prev.tx;
      let nextTy = prev.ty;
      if (stepRight > safe.right - pad) {
        nextTx -= stepRight - (safe.right - pad);
      }
      const adjustedLeft = nextTx + box.x * prev.scale;
      if (adjustedLeft < safe.left + pad) {
        nextTx += safe.left + pad - adjustedLeft;
      }
      if (stepBottom > safe.bottom - pad) {
        nextTy -= stepBottom - (safe.bottom - pad);
      }
      const adjustedTop = nextTy + box.y * prev.scale;
      if (adjustedTop < safe.top + pad) {
        nextTy += safe.top + pad - adjustedTop;
      }
      if (nextTx === prev.tx && nextTy === prev.ty) return prev;

      return { ...prev, tx: Math.round(nextTx), ty: Math.round(nextTy) };
    });
  }, [getLiveSafe, layout, props.isNarrow, props.leftOpen, props.name, props.rightOpen, props.step]);

  //M 滚轮以鼠标所在位置为中心缩放（必须用 passive: false 拦住浏览器默认页面滚动）。
  useEffect(() => {
    if (props.isNarrow) return undefined;

    const el = stageRef.current;
    if (el === null) return undefined;

    const onWheel = (event: WheelEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.tu-stage-hud, .tu-stage-tools') !== null) return;

      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      let factor = 0.9;
      if (event.deltaY < 0) {
        factor = 1.12;
      }
      const prev = transformRef.current;
      //M 将滚轮缩放倍率的步进结果夹在合法缩限以内，避免无限放大或缩小失踪。
      const nextScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
      if (nextScale === prev.scale) return;

      const worldX = (mouseX - prev.tx) / prev.scale;
      const worldY = (mouseY - prev.ty) / prev.scale;
      setTransform({
        tx: Math.round(mouseX - worldX * nextScale),
        ty: Math.round(mouseY - worldY * nextScale),
        scale: nextScale,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [props.isNarrow]);

  //M 窄屏模式下实时测量舞台宽度，供「适应屏宽」按真实容器宽度缩放整张泳道图或顺序图。
  useEffect(() => {
    if (!props.isNarrow) return undefined;

    const el = stageRef.current;
    if (el === null) return undefined;

    const measure = (): void => {
      if (el.clientWidth > 0) {
        setNarrowWidth(el.clientWidth);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.isNarrow]);

  //M 按住空白区域拖动平移画布（按钮、链接、输入控件上的点击照常响应）。
  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (props.isNarrow || event.button !== 0) return;

    const target = event.target;
    const interactiveSel = 'button, a, input, textarea, select, .tu-stage-hud, .tu-stage-tools';
    if (target instanceof Element && target.closest(interactiveSel) !== null) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startTx = transformRef.current.tx;
    const startTy = transformRef.current.ty;
    setDragging(true);

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      setTransform((prev) => ({
        ...prev,
        tx: Math.round(startTx + dx),
        ty: Math.round(startTy + dy),
      }));
    };
    const onUp = (): void => {
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  let stageClass = 'tu-stage';
  if (dragging) {
    stageClass = 'tu-stage dragging';
  }
  if (props.isNarrow) {
    stageClass = 'tu-stage narrow';
  }

  const liveSafe = getLiveSafe();
  let hudLeft = 16;
  let hudMaxWidth: number | undefined;
  if (!props.isNarrow) {
    hudLeft = liveSafe.left;
    hudMaxWidth = Math.max(240, liveSafe.right - liveSafe.left);
  }

  let title = '启动流程';
  if (props.name !== 'boot') {
    title = `消息 #${props.name}`;
  }

  const trail = canvas?.trail ?? null;
  //M 若选中事件高亮，找出当前轨迹里所有触发过该事件的步骤号供画布加亮及 HUD 快速跳转。
  const matchedList = getMatchedSteps(trail, props.highlightEvent);
  const matchedSet = new Set(matchedList);

  const metaParts: string[] = [];
  if (trail !== null) {
    if (trail.bot !== '') {
      metaParts.push(trail.bot);
    }
    if (trail.channel !== '') {
      //M 把英文渠道代号映射为中文短标签拼入画布摘要条。
      metaParts.push(getChannelLabel(trail.channel));
    }
    metaParts.push(trail.state);
    metaParts.push(`${String(trail.steps.length)} 步 · ${String(trail.ms)}ms`);
  }

  let hudTitleTip = title;
  if (trail !== null && trail.preview !== '') {
    hudTitleTip = `${title}：${trail.preview}`;
  }
  if (props.name !== 'boot' && props.hasSnapshot === false) {
    hudTitleTip += `（未带 ${props.keyword}，无运行时变量快照；泳道与源码照常可看）`;
  }

  const zoomPercent = String(Math.round(transform.scale * 100));

  let mobileChannelLabel = '';
  if (trail !== null && trail.channel !== '') {
    mobileChannelLabel = getChannelLabel(trail.channel);
  }
  let mobileStateClass = 'tu-m-state-pill';
  if (trail !== null && trail.state === 'done') mobileStateClass += ' done';
  if (trail !== null && (trail.state === 'failed' || trail.error)) mobileStateClass += ' error';

  return (
    <div ref={stageRef} className={stageClass} onPointerDown={onStagePointerDown}>
      {/* 桌面端：右栏之外贴靠在左栏右边的一行摘要 HUD，不吃大片垂直空间。 */}
      {!props.isNarrow && (
        <div
          className="tu-stage-hud"
          style={{ left: hudLeft, maxWidth: hudMaxWidth }}
          title={hudTitleTip}
        >
          <span className="tu-hud-title">{title}</span>
          {trail !== null && trail.preview !== '' && (
            <span className="tu-hud-preview">{trail.preview}</span>
          )}
          {metaParts.length > 0 && (
            <span className="tu-hud-meta">{metaParts.join(' · ')}</span>
          )}
          {trail !== null && trail.error && (
            <span className="tu-hud-err">有出错步</span>
          )}
          {props.name !== 'boot' && props.hasSnapshot === true && (
            <span className="tu-shot-badge">含快照</span>
          )}
          {props.name !== 'boot' && props.hasSnapshot === false && (
            <span className="tu-hud-tag">无快照</span>
          )}
          {props.highlightEvent !== '' && matchedList.length > 0 && (
            <span className="tu-hud-events">
              <span className="tu-hud-ev-name">{props.highlightEvent}</span>
              {matchedList.map((no) => {
                let hitClass = 'tu-event-hit-btn';
                if (props.step === no) {
                  hitClass = 'tu-event-hit-btn active';
                }
                return (
                  <button
                    key={no}
                    type="button"
                    className={hitClass}
                    onClick={
                      //M 点击事件命中步骤徽章直接跳转到画布对应步骤。
                      () => props.onPick(no)
                    }
                  >
                    #{String(no)}
                  </button>
                );
              })}
              <button type="button" className="tu-link" onClick={props.onClearEvent}>清除</button>
            </span>
          )}
        </div>
      )}

      {/* 手机端：原生感消息摘要卡片 + 看法分段胶囊条。 */}
      {props.isNarrow && trail !== null && (
        <section className="tu-m-trace-card">
          <div className="tu-m-trace-meta">
            {mobileChannelLabel !== '' && (
              <span className={`tu-ch-badge ${trail.channel}`}>{mobileChannelLabel}</span>
            )}
            {trail.bot !== '' && <span className="tu-m-bot-pill">{trail.bot}</span>}
            <span className={mobileStateClass}>{getTrailStateLabel(trail.state)}</span>
            <span className="tu-m-trace-stat">
              {String(trail.steps.length)} 步 · {formatStepDuration(trail.ms)}
            </span>
            {props.name !== 'boot' && props.hasSnapshot === true && (
              <span className="tu-shot-badge">含快照</span>
            )}
          </div>
          {trail.preview !== '' && (
            <p className="tu-m-trace-preview">{trail.preview}</p>
          )}
          {props.highlightEvent !== '' && matchedList.length > 0 && (
            <div className="tu-m-event-filter">
              <span className="tu-hud-ev-name">⚡ {props.highlightEvent}</span>
              <div className="tu-m-event-hits">
                {matchedList.map((no) => {
                  let hitClass = 'tu-event-hit-btn';
                  if (props.step === no) hitClass += ' active';
                  return (
                    <button
                      key={no}
                      type="button"
                      className={hitClass}
                      onClick={() => props.onPick(no)}
                    >
                      #{String(no)}
                    </button>
                  );
                })}
                <button type="button" className="tu-link" onClick={props.onClearEvent}>清除</button>
              </div>
            </div>
          )}
          <div className="tu-m-trace-bar">
            <div className="tu-m-seg" role="tablist" aria-label="轨迹展示方式">
              <button
                type="button"
                className="tu-m-seg-btn"
                data-narrow-mode="steps"
                aria-pressed={props.narrowMode === 'steps'}
                onClick={() => props.onNarrowModeChange('steps')}
              >
                步骤流
              </button>
              <button
                type="button"
                className="tu-m-seg-btn"
                data-narrow-mode="lanes"
                aria-pressed={props.narrowMode === 'lanes'}
                onClick={() => props.onNarrowModeChange('lanes')}
              >
                泳道全景
              </button>
              <button
                type="button"
                className="tu-m-seg-btn"
                data-narrow-mode="seq"
                aria-pressed={props.narrowMode === 'seq'}
                onClick={() => props.onNarrowModeChange('seq')}
              >
                顺序图
              </button>
            </div>
            {props.narrowMode !== 'steps' && (
              <button
                type="button"
                className="tu-m-fit-toggle"
                data-stage-fit
                aria-pressed={mobileFit}
                onClick={() => setMobileFit((prev) => !prev)}
              >
                {mobileFit && '适应屏宽'}
                {!mobileFit && '原大横滑'}
              </button>
            )}
          </div>
        </section>
      )}

      {/* 加载态或报错居中提示（躲在浮栏中间可见区）。 */}
      {error !== '' && (
        <div className="tu-stage-center" style={{ left: hudLeft, maxWidth: hudMaxWidth }}>
          <Alert type="error" showIcon title={error} />
        </div>
      )}
      {error === '' && canvas === null && (
        <div className="tu-stage-center" style={{ left: hudLeft, maxWidth: hudMaxWidth }}>
          <Spin />
        </div>
      )}

      {/* 泳道图本体：桌面模式下包在平移缩放层内铺满整个视口。 */}
      {canvas !== null && !props.isNarrow && (
        <div
          className="tu-stage-world"
          style={{
            transform:
              `translate(${String(transform.tx)}px, ${String(transform.ty)}px) scale(${String(transform.scale)})`,
            transformOrigin: '0 0',
          }}
        >
          {look === 'table' && (
            <LaneChart
              canvas={canvas}
              picked={props.step}
              onPick={props.onPick}
              pluginNames={props.pluginNames}
              activePlugin={props.activePlugin}
              matchedSteps={matchedSet}
              onSelectPlugin={props.onSelectPlugin}
              panZoom
            />
          )}
          {look === 'seq' && seqLayout !== null && (
            <SeqChart
              canvas={canvas}
              layout={seqLayout}
              picked={props.step}
              event={props.highlightEvent}
              onPick={props.onPick}
              onPickArrow={props.onPickArrow}
              pluginNames={props.pluginNames}
              activePlugin={props.activePlugin}
              onSelectPlugin={props.onSelectPlugin}
            />
          )}
        </div>
      )}

      {/* 手机端默认：纵向时间线步骤卡片，点一步直接在当前卡片内就地展开状态变化、函数、源码与快照。 */}
      {canvas !== null && props.isNarrow && props.narrowMode === 'steps' && (
        <div className="tu-m-steps">
          {canvas.trail.steps.map((stepItem) => {
            const picked = props.step === stepItem.no;
            const hit = matchedSet.has(stepItem.no);
            const stepTitle = getStepDisplayTitle(stepItem, tr);
            const stepEvents = getStepEvents(stepItem);
            const stepFlow = findStepFlow(resolvedDataFlow, stepItem.no);
            const isSkeleton = stepFlow?.layer === 'skeleton';
            let cardClass = 'tu-m-step-card';
            if (isSkeleton) cardClass += ' skeleton';
            if (picked) cardClass += ' picked';
            if (stepItem.error) cardClass += ' error';
            if (hit) cardClass += ' event-hit';

            let nodeClass = 'tu-m-step-node';
            let nodeLabel = stepItem.node;
            if (isSkeleton) {
              nodeClass += ' skeleton';
              nodeLabel = `骨架 · ${stepItem.node}`;
            }

            let sumClass = 'tu-m-step-summary';
            if (isSkeleton) sumClass += ' gold';
            if (!isSkeleton && (stepFlow?.changes.length ?? 0) > 0) sumClass += ' changed';

            let msClass = 'tu-m-step-ms';
            if (stepItem.ms >= 500) msClass += ' slow';
            let chevron = '▾';
            if (picked) chevron = '▴';
            const onToggleStep = (): void => {
              if (picked) {
                props.onPick(0);
                return;
              }
              props.onPick(stepItem.no);
            };
            return (
              <div key={stepItem.no} className={cardClass}>
                <button
                  type="button"
                  className="tu-m-step-btn"
                  data-step-card={stepItem.no}
                  aria-expanded={picked}
                  onClick={onToggleStep}
                >
                  <div className="tu-m-step-top">
                    <span className="tu-m-step-no">#{String(stepItem.no)}</span>
                    <span className={nodeClass}>{nodeLabel}</span>
                    {stepItem.error && <span className="tu-m-step-err">报错</span>}
                    <span className={msClass}>{formatStepDuration(stepItem.ms)}</span>
                    <span className="tu-m-step-chev" aria-hidden="true">{chevron}</span>
                  </div>
                  <div className="tu-m-step-title">{stepTitle}</div>
                  {stepFlow !== undefined && stepFlow.summary !== '' && (
                    <div className={sumClass}>{stepFlow.summary}</div>
                  )}
                  {stepEvents.length > 0 && (
                    <div className="tu-m-step-events">
                      {stepEvents.map((evName) => (
                        <span key={evName} className="tu-m-step-ev">⚡ {evName}</span>
                      ))}
                    </div>
                  )}
                </button>
                {picked && (
                  <div className="tu-m-step-detail">
                    {stepFlow !== undefined && (
                      <StepDataFlowPanel
                        compact
                        trail={canvas.trail}
                        step={stepItem}
                        stepFlow={stepFlow}
                        dataFlow={resolvedDataFlow ?? undefined}
                        workspace={props.workspace}
                        pluginNames={props.pluginNames}
                        onPickStep={props.onPick}
                        onOpenSkeletonLines={props.onOpenSkeletonLines}
                        onSelectPlugin={props.onSelectPlugin}
                      />
                    )}
                    <StepDetail
                      canvas={props.name}
                      trail={canvas.trail}
                      step={stepItem}
                      workspace={props.workspace}
                      keyword={props.keyword}
                      pluginNames={props.pluginNames}
                      highlightEvent={props.highlightEvent}
                      hideHeader={stepFlow !== undefined}
                      onSelectPlugin={props.onSelectPlugin}
                      onSelectEvent={props.onSelectEvent}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 手机端切到泳道全景或顺序图时：支持一键适应屏宽或原尺寸横滑。 */}
      {canvas !== null && props.isNarrow && props.narrowMode !== 'steps' && (
        <div className="tu-m-chart-shell">
          {!mobileFit && props.narrowMode === 'lanes' && (
            <LaneChart
              canvas={canvas}
              picked={props.step}
              onPick={props.onPick}
              pluginNames={props.pluginNames}
              activePlugin={props.activePlugin}
              matchedSteps={matchedSet}
              onSelectPlugin={props.onSelectPlugin}
              panZoom={false}
            />
          )}
          {!mobileFit && props.narrowMode === 'seq' && seqLayout !== null && (
            <div className="tu-lanes-scroll">
              <SeqChart
                canvas={canvas}
                layout={seqLayout}
                picked={props.step}
                event={props.highlightEvent}
                onPick={props.onPick}
                onPickArrow={props.onPickArrow}
                pluginNames={props.pluginNames}
                activePlugin={props.activePlugin}
                onSelectPlugin={props.onSelectPlugin}
              />
            </div>
          )}
          {mobileFit && layout !== null && (() => {
            const fitScale = clamp((narrowWidth - 16) / Math.max(1, layout.width), 0.34, 1);
            const scaledHeight = Math.ceil(layout.total * fitScale) + 12;
            return (
              <div className="tu-lanes-fit" style={{ height: `${String(scaledHeight)}px` }}>
                <div
                  style={{
                    width: `${String(layout.width)}px`,
                    transform: `scale(${String(fitScale)})`,
                    transformOrigin: '0 0',
                  }}
                >
                  {props.narrowMode === 'lanes' && (
                    <LaneChart
                      canvas={canvas}
                      picked={props.step}
                      onPick={props.onPick}
                      pluginNames={props.pluginNames}
                      activePlugin={props.activePlugin}
                      matchedSteps={matchedSet}
                      onSelectPlugin={props.onSelectPlugin}
                      panZoom
                    />
                  )}
                  {props.narrowMode === 'seq' && seqLayout !== null && (
                    <SeqChart
                      canvas={canvas}
                      layout={seqLayout}
                      picked={props.step}
                      event={props.highlightEvent}
                      onPick={props.onPick}
                      onPickArrow={props.onPickArrow}
                      pluginNames={props.pluginNames}
                      activePlugin={props.activePlugin}
                      onSelectPlugin={props.onSelectPlugin}
                    />
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 画布左下角控件：适应窗口、100%、当前比例、交互说明。 */}
      {!props.isNarrow && canvas !== null && (
        <div className="tu-stage-tools" style={{ left: hudLeft }}>
          <button
            type="button"
            className="tu-tool-btn"
            aria-pressed={look === 'table'}
            onClick={() => setLook('table')}
          >
            表格
          </button>
          <button
            type="button"
            className="tu-tool-btn"
            aria-pressed={look === 'seq'}
            onClick={() => setLook('seq')}
          >
            顺序图
          </button>
          <button type="button" className="tu-tool-btn" onClick={fitToWindow}>适应窗口</button>
          <button type="button" className="tu-tool-btn" onClick={resetToHundred}>100%</button>
          <span className="tu-tool-zoom">{zoomPercent}%</span>
          <span className="tu-tool-hint">滚轮缩放 · 按住空白拖动 · 点步看详情</span>
        </div>
      )}
    </div>
  );
}
