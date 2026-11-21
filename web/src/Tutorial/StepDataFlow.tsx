/**
 * 教程「数据流转与状态变化」公共转换、右栏步骤接力面板与整屏数据变化总表。
 *   resolveTrailDataFlow：把后端 canvas.dataFlow 归一化；旧快照或未返回时按 trail.steps 优雅兜底，绝不白屏或崩溃。
 *   StepDataFlowPanel   ：右栏「这一步」顶部与手机卡片展开区的接力导航条、骨架直达联动、输入/前→后变化/去向卡片。
 *   DataFlowTable       ：思维导图「消息轨迹 → 数据变化总表」整屏表格，点击任意行同步定位步骤并展开右侧详情。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import * as i18n from '../I18n.ts';
import * as traceText from '../locales/Trace.ts';
import { SiteLink } from '../VscodeLink.tsx';
import { PayloadDiff, PayloadExportBar } from './PayloadDiff.tsx';
import type * as api from './TutorialApi.ts';


/** 已知骨架模块名到逐行图文件名的固定映射。 */
const SKELETON_FILES: Readonly<Record<string, string>> = {
  main: 'Main',
  resources: 'Resources',
  tools: 'Tools',
  sessions: 'Sessions',
  cordis: 'Cordis',
};


/**
 * 把轨迹一步的标题还原为当前语言的自然短句。
 * @param step 轨迹步骤。
 * @param t 翻译函数。
 */
export function resolveStepTitle(step: api.TrailStep, t: i18n.Translate): string {
  //M 若 step.title 是 trace.* 键名或空串，从行记录重新拼出可读句子。
  let text = step.title;
  if (traceText.isTraceText(text) || text === '') {
    text = traceText.getTraceStepTitle(step.rows, (id, params) => i18n.renderTrace(t, id, params));
  }
  if (text === '') return step.node;

  return text;
}


/**
 * 把源码路径缩写成紧凑的 模块/文件:行号，便于节点卡片和总表展示。
 * @param site 原始源码位置。
 */
export function formatShortSite(site: string): string {
  //G 空位置直接返回空串。
  if (site === '') return '';

  const normalized = site.replace(/\\/gu, '/');
  return normalized
    .replace(/^src7\/plugins\//u, '')
    .replace(/^src7\//u, '');
}


/**
 * 格式化步骤耗时，零毫秒标为 <1ms。
 * @param ms 毫秒数。
 */
export function formatStepMs(ms: number): string {
  if (ms <= 0) return '<1ms';

  return `${String(ms)}ms`;
}


/**
 * 根据模块名判断默认骨架文件名；普通插件返回空串。
 * @param node 模块名。
 */
export function inferSkeletonFile(node: string): string {
  return SKELETON_FILES[node.toLowerCase()] ?? '';
}


/**
 * 归一化单条输入字段，缺省属性补安全默认值。
 */
function normalizeField(raw: Partial<api.DataField>): api.DataField {
  let source: 'real' | 'schema' = 'real';
  if (raw.source === 'schema') source = 'schema';
  return {
    key: String(raw.key ?? ''),
    value: String(raw.value ?? ''),
    note: String(raw.note ?? ''),
    source,
  };
}


/**
 * 归一化单条状态变化记录，缺省属性补安全默认值。
 */
function normalizeChange(raw: Partial<api.DataChange>): api.DataChange {
  let source: 'real' | 'schema' = 'real';
  if (raw.source === 'schema') source = 'schema';
  return {
    target: String(raw.target ?? ''),
    field: String(raw.field ?? ''),
    before: String(raw.before ?? ''),
    after: String(raw.after ?? ''),
    note: String(raw.note ?? ''),
    source,
  };
}


/**
 * 从原始 TrailStep 合成兜底 StepDataFlow，兼容旧快照或未返回 dataFlow 的接口响应。
 */
function buildFallbackStepFlow(
  trail: api.Trail,
  step: api.TrailStep,
  prev: api.TrailStep | undefined,
  next: api.TrailStep | undefined,
): api.StepDataFlow {
  //M 识别骨架模块与本步首个函数行、事件行。
  const inferredSkeleton = inferSkeletonFile(step.node);
  let layer: 'skeleton' | 'plugin' = 'plugin';
  if (inferredSkeleton !== '') layer = 'skeleton';

  const fnRow = step.rows.find((row) => row.kind === '函数');
  const evRow = step.rows.find((row) => row.kind !== '函数');
  const prevEv = prev?.rows.find((row) => row.kind !== '函数');

  //M 抽取跟踪行 facts 作为实测输入字段。
  const inputs: api.DataField[] = [];
  const seenKeys = new Set<string>();
  for (const row of step.rows) {
    for (const [key, val] of Object.entries(row.facts)) {
      if (seenKeys.has(key)) continue;

      seenKeys.add(key);
      inputs.push({
        key,
        value: String(val),
        note: trail.notes[key] ?? '跟踪关键值',
        source: 'real',
      });
      if (inputs.length >= 6) break;
    }
    if (inputs.length >= 6) break;
  }

  let inVia = prevEv?.name ?? '';
  if (inVia === '' && prev !== undefined) inVia = '函数调用';
  let outVia = evRow?.name ?? '';
  if (outVia === '' && next !== undefined) outVia = '后续接力';

  let summary = '';
  if (evRow !== undefined) summary = `发出 ${evRow.name}`;
  if (summary === '' && inputs[0] !== undefined) summary = `${inputs[0].key}: ${inputs[0].value}`;
  if (summary === '' && fnRow !== undefined) summary = fnRow.name;

  return {
    step: step.no,
    node: step.node,
    layer,
    stage: step.node,
    fnName: fnRow?.name ?? '',
    fnSite: fnRow?.site ?? evRow?.site ?? '',
    skeletonFile: inferredSkeleton,
    summary,
    incoming: {
      fromStep: prev?.no ?? null,
      via: inVia,
      dataType: '',
    },
    inputs,
    changes: [],
    outgoing: {
      toStep: next?.no ?? null,
      toNode: next?.node ?? '',
      via: outVia,
      dataType: '',
      label: outVia,
    },
  };
}


/**
 * 归一化后端返回的单个 StepDataFlow，并用兜底值补齐缺失字段。
 */
function mergeStepFlow(raw: Partial<api.StepDataFlow>, fallback: api.StepDataFlow): api.StepDataFlow {
  //M 优先采用后端精确推导的字段，空缺处退回轨迹兜底。
  let layer = fallback.layer;
  if (raw.layer === 'skeleton' || raw.layer === 'plugin') layer = raw.layer;

  let skeletonFile = raw.skeletonFile ?? '';
  if (skeletonFile === '' && layer === 'skeleton') skeletonFile = fallback.skeletonFile;

  const incomingRaw = raw.incoming;
  let fromStep = fallback.incoming.fromStep;
  if (incomingRaw !== undefined) fromStep = incomingRaw.fromStep;
  const incoming = {
    fromStep,
    via: incomingRaw?.via ?? fallback.incoming.via,
    dataType: incomingRaw?.dataType ?? fallback.incoming.dataType,
  };

  const outgoingRaw = raw.outgoing;
  let toStep = fallback.outgoing.toStep;
  if (outgoingRaw !== undefined) toStep = outgoingRaw.toStep;
  const outgoing = {
    toStep,
    toNode: outgoingRaw?.toNode ?? fallback.outgoing.toNode,
    via: outgoingRaw?.via ?? fallback.outgoing.via,
    dataType: outgoingRaw?.dataType ?? fallback.outgoing.dataType,
    label: outgoingRaw?.label ?? fallback.outgoing.label,
  };

  let inputs = fallback.inputs;
  if (Array.isArray(raw.inputs)) inputs = raw.inputs.map((item) => normalizeField(item));

  let changes = fallback.changes;
  if (Array.isArray(raw.changes)) changes = raw.changes.map((item) => normalizeChange(item));

  return {
    step: raw.step ?? fallback.step,
    node: raw.node ?? fallback.node,
    layer,
    stage: raw.stage ?? fallback.stage,
    fnName: raw.fnName ?? fallback.fnName,
    fnSite: raw.fnSite ?? fallback.fnSite,
    skeletonFile,
    summary: raw.summary ?? fallback.summary,
    incoming,
    inputs,
    changes,
    outgoing,
  };
}


/**
 * 归一化或兜底构造整条轨迹的 TrailDataFlow，保证每个 TrailStep 都有对应的 StepDataFlow。
 * @param trail 轨迹数据。
 * @param raw 后端返回的可选 dataFlow。
 */
export function resolveTrailDataFlow(
  trail: api.Trail,
  raw?: api.TrailDataFlow | null,
): api.TrailDataFlow {
  //M 建立步号索引表，便于按真实步骤顺序与后端 dataFlow 对齐。
  const byStep = new Map<number, Partial<api.StepDataFlow>>();
  if (raw !== undefined && raw !== null && Array.isArray(raw.steps)) {
    for (const item of raw.steps) {
      if (typeof item?.step === 'number') byStep.set(item.step, item);
    }
  }

  const steps: api.StepDataFlow[] = [];
  for (let index = 0; index < trail.steps.length; index++) {
    const current = trail.steps[index];
    if (current === undefined) continue;

    const prev = trail.steps[index - 1];
    const next = trail.steps[index + 1];
    const fallback = buildFallbackStepFlow(trail, current, prev, next);
    const hit = byStep.get(current.no);
    if (hit === undefined) {
      steps.push(fallback);
      continue;
    }
    steps.push(mergeStepFlow(hit, fallback));
  }

  //M 收集核心表、内存对象与事件通道；若后端未返回 objects，则从事件行自动提炼兜底对象清单。
  const objects: api.TrailDataFlow['objects'] = [];
  if (raw !== undefined && raw !== null && Array.isArray(raw.objects)) {
    for (const obj of raw.objects) {
      if (!obj || typeof obj.name !== 'string' || obj.name === '') continue;

      let kind: 'table' | 'memory' | 'event' = 'memory';
      if (obj.kind === 'table' || obj.kind === 'event') kind = obj.kind;
      objects.push({ name: obj.name, kind, role: String(obj.role ?? '') });
    }
  }
  if (objects.length === 0) {
    const seenEvents = new Set<string>();
    for (const step of trail.steps) {
      for (const row of step.rows) {
        if (row.kind === '函数' || seenEvents.has(row.name)) continue;

        seenEvents.add(row.name);
        objects.push({ name: row.name, kind: 'event', role: `${step.node} 发出事件` });
        if (objects.length >= 6) break;
      }
      if (objects.length >= 6) break;
    }
  }

  return { steps, objects };
}


/**
 * 从 TrailDataFlow 中按步号查找单步数据流转。
 */
export function findStepFlow(
  flow: api.TrailDataFlow | null,
  stepNo: number,
): api.StepDataFlow | undefined {
  if (flow === null || stepNo <= 0) return undefined;

  return flow.steps.find((item) => item.step === stepNo);
}


/**
 * 拼出有向边或微流程条上的紧凑流转标签。
 */
export function getTransferText(via: string, dataType: string, preferred = ''): string {
  if (preferred !== '') return preferred;
  if (via !== '' && dataType !== '') return `${via} · ${dataType}`;
  if (via !== '') return via;
  if (dataType !== '') return dataType;

  return '顺次接力';
}


/**
 * 将对象类别转为中文短徽标。
 */
function getObjectKindLabel(kind: 'table' | 'memory' | 'event'): string {
  if (kind === 'table') return '表';
  if (kind === 'event') return '事件';

  return '内存';
}


/**
 * 将字段来源转为极轻来源徽标文字。
 */
function getSourceBadgeText(source: 'real' | 'schema'): string {
  if (source === 'schema') return '结构';

  return '实测';
}


/** 判断键盘焦点是否落在输入控件中（避免空格播放键抢占搜索框输入）。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}


/**
 * 步骤接力导航条：上一步 / 播放控制（▶/⏸ 1.5s 自动推进） / 当前步与模块类型 / 下一步 + 来龙去脉微流程条。
 */
function StepRelayBar(props: {
  trail: api.Trail;
  step: api.TrailStep;
  stepFlow: api.StepDataFlow;
  onPickStep: (stepNo: number) => void;
}): JSX.Element {
  const { trail, step, stepFlow, onPickStep } = props;
  const [playing, setPlaying] = useState(false);
  const [fast, setFast] = useState(false);
  const expectedAutoStepRef = useRef<number | null>(null);

  const index = trail.steps.findIndex((item) => item.no === step.no);
  //M 不用三元表达式定位前后相邻步骤，支持任意步号序列一键接力跳转。
  let prev: api.TrailStep | undefined;
  if (index > 0) prev = trail.steps[index - 1];
  let next: api.TrailStep | undefined;
  if (index >= 0 && index + 1 < trail.steps.length) next = trail.steps[index + 1];

  //M 切换消息画布时立即停表，防止旧画布播放状态串到新画布。
  useEffect(() => {
    expectedAutoStepRef.current = null;
    setPlaying(false);
  }, [trail.at, trail.message]);

  //M 区分自动跳步与用户手动点步：非计时器推进的步号变化或抵达终点时立即停表。
  useEffect(() => {
    if (!playing) return;
    if (expectedAutoStepRef.current !== step.no) {
      expectedAutoStepRef.current = null;
      setPlaying(false);
      return;
    }
    expectedAutoStepRef.current = null;
    const curIdx = trail.steps.findIndex((item) => item.no === step.no);
    if (curIdx < 0 || curIdx + 1 >= trail.steps.length) {
      setPlaying(false);
    }
  }, [playing, step.no, trail.steps]);

  //M 自动播放计时器：默认 1.5s（2x 为 0.75s）推进一步，卸载或暂停时清理 timeout 零泄漏。
  useEffect(() => {
    if (!playing) return undefined;

    const curIdx = trail.steps.findIndex((item) => item.no === step.no);
    const nextStep = trail.steps[curIdx + 1];
    if (curIdx < 0 || nextStep === undefined) {
      setPlaying(false);
      return undefined;
    }
    let delayMs = 1500;
    if (fast) delayMs = 750;
    const timer = window.setTimeout(() => {
      expectedAutoStepRef.current = nextStep.no;
      onPickStep(nextStep.no);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [fast, onPickStep, playing, step.no, trail.steps]);

  const togglePlay = useCallback((): void => {
    if (playing) {
      expectedAutoStepRef.current = null;
      setPlaying(false);
      return;
    }
    if (trail.steps.length <= 1) return;

    const curIdx = trail.steps.findIndex((item) => item.no === step.no);
    const firstStep = trail.steps[0];
    //M 已在最后一步点播放时自动回到 #1 从头播放整条链路。
    if ((curIdx < 0 || curIdx + 1 >= trail.steps.length) && firstStep !== undefined) {
      expectedAutoStepRef.current = firstStep.no;
      setPlaying(true);
      onPickStep(firstStep.no);
      return;
    }
    setPlaying(true);
  }, [onPickStep, playing, step.no, trail.steps]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isEditableTarget(event.target)) return;

      event.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePlay]);

  let prevTitle = '已是第一步';
  if (prev !== undefined) prevTitle = `跳到 #${String(prev.no)} ${prev.node}`;
  let nextTitle = '已是最后一步';
  if (next !== undefined) nextTitle = `跳到 #${String(next.no)} ${next.node}`;

  const isSkeleton = stepFlow.layer === 'skeleton';
  let modBadgeClass = 'tu-df-layer-pill plugin';
  let modBadgeText = `插件 · ${step.node}`;
  if (isSkeleton) {
    modBadgeClass = 'tu-df-layer-pill skeleton';
    modBadgeText = `骨架 · ${step.node}`;
  }
  let msClass = 'tu-df-ms-pill';
  if (step.ms >= 500) msClass += ' slow';
  let playBtnClass = 'tu-df-play-btn';
  if (playing) playBtnClass += ' playing';
  let speedLabel = '1x';
  if (fast) speedLabel = '2x';

  const inText = getTransferText(stepFlow.incoming.via, stepFlow.incoming.dataType);
  const outText = getTransferText(
    stepFlow.outgoing.via,
    stepFlow.outgoing.dataType,
    stepFlow.outgoing.label,
  );
  const fromStepNo = stepFlow.incoming.fromStep;
  const toStepNo = stepFlow.outgoing.toStep;
  let currentStage = stepFlow.stage;
  if (currentStage === '') currentStage = step.node;

  return (
    <nav className="tu-df-relay" aria-label="步骤接力导航">
      <div className="tu-df-relay-top">
        <button
          type="button"
          className="tu-df-relay-btn"
          data-relay-prev
          disabled={prev === undefined}
          title={prevTitle}
          onClick={() => {
            if (prev !== undefined) onPickStep(prev.no);
          }}
        >
          {prev !== undefined && `← 上一步 #${String(prev.no)}`}
          {prev === undefined && '起点 #1'}
        </button>

        <div className="tu-df-relay-cur">
          <div className="tu-df-relay-play">
            <button
              type="button"
              className={playBtnClass}
              data-relay-play
              disabled={trail.steps.length <= 1}
              aria-pressed={playing}
              title="按 1.5s 间隔自动逐跳播放（快捷键：空格）"
              onClick={togglePlay}
            >
              {playing && '⏸ 暂停'}
              {!playing && '▶ 播放'}
            </button>
            <button
              type="button"
              className="tu-df-speed-btn"
              data-relay-speed
              title="切换播放速度（1x=1.5s / 2x=0.75s）"
              onClick={() => setFast((cur) => !cur)}
            >
              {speedLabel}
            </button>
          </div>
          <span className="tu-df-cur-no">当前 #{String(step.no)}</span>
          <span className={modBadgeClass}>{modBadgeText}</span>
          <span className={msClass}>{formatStepMs(step.ms)}</span>
        </div>

        <button
          type="button"
          className="tu-df-relay-btn"
          data-relay-next
          disabled={next === undefined}
          title={nextTitle}
          onClick={() => {
            if (next !== undefined) onPickStep(next.no);
          }}
        >
          {next !== undefined && `下一步 #${String(next.no)} →`}
          {next === undefined && `终点 #${String(step.no)}`}
        </button>
      </div>

      <div className="tu-df-micro-flow">
        {fromStepNo !== null && (
          <button
            type="button"
            className="tu-df-hop-chip clickable"
            onClick={() => onPickStep(fromStepNo)}
            title={`点击跳回上游步骤 #${String(fromStepNo)}`}
          >
            来自 #{String(fromStepNo)} ({inText})
          </button>
        )}
        {fromStepNo === null && (
          <span className="tu-df-hop-chip muted">外部入口 ({inText})</span>
        )}
        <span className="tu-df-hop-sep" aria-hidden="true">→</span>
        <span className="tu-df-hop-cur">{currentStage}</span>
        <span className="tu-df-hop-sep" aria-hidden="true">→</span>
        {toStepNo !== null && (
          <button
            type="button"
            className="tu-df-hop-chip clickable"
            onClick={() => onPickStep(toStepNo)}
            title={`点击跳往下一站 #${String(toStepNo)}`}
          >
            传往 #{String(toStepNo)} ({outText})
          </button>
        )}
        {toStepNo === null && (
          <span className="tu-df-hop-chip muted">链路收尾 ({outText})</span>
        )}
      </div>
    </nav>
  );
}


/** 右栏「这一步」与手机内联卡片共用的数据流转与状态变化面板属性。 */
export interface StepDataFlowPanelProps {
  trail: api.Trail;
  step: api.TrailStep;
  stepFlow: api.StepDataFlow;
  workspace: string;
  pluginNames: ReadonlySet<string>;
  onPickStep: (stepNo: number) => void;
  onOpenSkeletonLines: (skeletonFile: string) => void;
  onSelectPlugin: (name: string) => void;
  /** 手机步骤卡片内展开时使用紧凑排布。 */
  compact?: boolean;
}


/**
 * 右栏「这一步」顶部的数据流转、状态变化（前 → 后）与骨架/插件一键直达面板。
 */
export function StepDataFlowPanel(props: StepDataFlowPanelProps): JSX.Element {
  const { trail, step, stepFlow, workspace, pluginNames, compact = false } = props;
  const t = i18n.useT();
  const title = resolveStepTitle(step, t);
  const isSkeleton = stepFlow.layer === 'skeleton' && stepFlow.skeletonFile !== '';
  const skeletonLabel = stepFlow.skeletonFile.replace(/\.(ts|json)$/iu, '');
  const canOpenPlugin = pluginNames.has(step.node);

  //M 手机紧凑模式最多展示前 4 个输入项，桌面右栏完整展示。
  let visibleInputs = stepFlow.inputs;
  if (compact && visibleInputs.length > 4) visibleInputs = visibleInputs.slice(0, 4);

  const outViaText = getTransferText(
    stepFlow.outgoing.via,
    stepFlow.outgoing.dataType,
    stepFlow.outgoing.label,
  );
  const toStepNo = stepFlow.outgoing.toStep;
  let rootClass = 'tu-df-panel';
  if (compact) rootClass += ' compact';

  return (
    <section className={rootClass} aria-label="本步数据流转与状态变化">
      <StepRelayBar
        trail={trail}
        step={step}
        stepFlow={stepFlow}
        onPickStep={props.onPickStep}
      />

      <div className="tu-df-headline">
        <div className="tu-df-headline-main">
          <h3 className="tu-df-step-title">{title}</h3>
          {(stepFlow.fnName !== '' || stepFlow.fnSite !== '') && (
            <div className="tu-df-fn-line">
              {stepFlow.fnName !== '' && <code className="tu-df-fn-code">{stepFlow.fnName}</code>}
              {stepFlow.fnSite !== '' && <SiteLink workspace={workspace} site={stepFlow.fnSite} />}
            </div>
          )}
        </div>

        <div className="tu-df-jump-group">
          {isSkeleton && (
            <button
              type="button"
              className="tu-df-skeleton-btn"
              data-open-skeleton={skeletonLabel}
              onClick={() => props.onOpenSkeletonLines(stepFlow.skeletonFile)}
            >
              在「骨架逐行」中看 {skeletonLabel} 代码块 →
            </button>
          )}
          {canOpenPlugin && !isSkeleton && (
            <button
              type="button"
              className="tu-step-plugin-btn"
              onClick={() => props.onSelectPlugin(step.node)}
            >
              查看 {step.node} 插件 →
            </button>
          )}
          {canOpenPlugin && isSkeleton && (
            <button
              type="button"
              className="tu-df-sub-plugin-btn"
              onClick={() => props.onSelectPlugin(step.node)}
            >
              {step.node} 模块说明 →
            </button>
          )}
        </div>
      </div>

      <div className="tu-df-card">
        <div className="tu-df-card-head">
          <span className="tu-df-card-title">数据流转与状态变化</span>
          {stepFlow.summary !== '' && (
            <span className="tu-df-summary-pill">{stepFlow.summary}</span>
          )}
        </div>

        <PayloadDiff
          trail={trail}
          stepNo={step.no}
          workspace={workspace}
          compact={compact}
        />

        <div className="tu-df-section">
          <div className="tu-df-sec-label">状态变化（前 → 后）</div>
          {stepFlow.changes.length === 0 && (
            <div className="tu-df-no-change">
              {stepFlow.summary !== '' && <span>{stepFlow.summary}</span>}
              {stepFlow.summary === '' && <span>本步主要做转发或校验，未直接改写持久化状态</span>}
            </div>
          )}
          {stepFlow.changes.length > 0 && (
            <div className="tu-df-changes-list">
              {stepFlow.changes.map((change, idx) => {
                let targetName = change.target;
                if (change.field !== '') targetName = `${change.target}.${change.field}`;
                let srcClass = 'tu-df-src-tag real';
                if (change.source === 'schema') srcClass = 'tu-df-src-tag schema';
                return (
                  <div key={`${targetName}-${String(idx)}`} className="tu-df-change-row">
                    <div className="tu-df-change-head">
                      <code className="tu-df-change-target">[{targetName}]</code>
                      <span className={srcClass}>{getSourceBadgeText(change.source)}</span>
                      {change.note !== '' && <span className="tu-df-change-note">{change.note}</span>}
                    </div>
                    <div className="tu-df-change-diff">
                      <code className="tu-df-val-before">{change.before || '空'}</code>
                      <span className="tu-df-diff-arrow" aria-hidden="true">→</span>
                      <code className="tu-df-val-after">{change.after || '空'}</code>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {visibleInputs.length > 0 && (
          <div className="tu-df-section">
            <div className="tu-df-sec-label">入口数据（收到什么）</div>
            <div className="tu-df-inputs-grid">
              {visibleInputs.map((field, idx) => {
                let srcClass = 'tu-df-src-tag real';
                if (field.source === 'schema') srcClass = 'tu-df-src-tag schema';
                return (
                  <div key={`${field.key}-${String(idx)}`} className="tu-df-input-item">
                    <span className="tu-df-input-left">
                      <code className="tu-df-input-key">{field.key}</code>
                      {field.note !== '' && <span className="tu-df-input-note">{field.note}</span>}
                    </span>
                    <span className="tu-df-input-right">
                      <code className="tu-df-input-val">{field.value || '（空）'}</code>
                      <span className={srcClass}>{getSourceBadgeText(field.source)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="tu-df-section tu-df-out-row">
          <div className="tu-df-out-info">
            <span className="tu-df-sec-label inline">去向数据</span>
            <code className="tu-df-out-via">{outViaText}</code>
            {stepFlow.outgoing.toNode !== '' && (
              <span className="tu-df-out-target">→ {stepFlow.outgoing.toNode}</span>
            )}
          </div>
          {toStepNo !== null && (
            <button
              type="button"
              className="tu-df-next-jump-btn"
              onClick={() => props.onPickStep(toStepNo)}
            >
              跳到下一步 #{String(toStepNo)} →
            </button>
          )}
        </div>
      </div>
    </section>
  );
}


/**
 * 整屏「从头到尾数据变化总表」：顶部列出涉及的数据表/内存对象/事件，下方逐行对照每步输入、前→后变化与下一站。
 */
export function DataFlowTable(props: {
  trail: api.Trail;
  dataFlow: api.TrailDataFlow;
  pickedStep: number;
  t: i18n.Translate;
  onPickStep: (stepNo: number) => void;
}): JSX.Element {
  const { trail, dataFlow, pickedStep, t, onPickStep } = props;
  const stepByNo = new Map<number, api.TrailStep>();
  for (const step of trail.steps) stepByNo.set(step.no, step);

  return (
    <div className="tu-dft-wrap">
      <div className="tu-dft-head-bar">
        {dataFlow.objects.length > 0 && (
          <div className="tu-dft-objects" aria-label="涉及的核心数据表与内存对象">
            <span className="tu-dft-obj-lead">涉及对象：</span>
            {dataFlow.objects.map((obj, idx) => {
              const kindLabel = getObjectKindLabel(obj.kind);
              let objTip = `[${kindLabel}] ${obj.name}`;
              if (obj.role !== '') objTip = `[${kindLabel}] ${obj.name}：${obj.role}`;
              return (
                <span
                  key={`${obj.name}-${String(idx)}`}
                  className={`tu-dft-obj-badge ${obj.kind}`}
                  title={objTip}
                >
                  <b>{kindLabel}</b>
                  <code>{obj.name}</code>
                </span>
              );
            })}
          </div>
        )}
        {dataFlow.objects.length === 0 && <span className="tu-dft-obj-lead">全链路数据变化总表</span>}
        <PayloadExportBar trail={trail} dataFlow={dataFlow} />
      </div>

      <div className="tu-dft-scroll">
        <table className="tu-dft-table">
          <thead>
            <tr>
              <th>#步号</th>
              <th>模块</th>
              <th>阶段与函数</th>
              <th>输入数据</th>
              <th>状态变化（前 → 后）</th>
              <th>传向下一站</th>
            </tr>
          </thead>
          <tbody>
            {dataFlow.steps.map((item) => {
              const rawStep = stepByNo.get(item.step);
              let stepTitle = item.stage;
              if (rawStep !== undefined) stepTitle = resolveStepTitle(rawStep, t);
              const shortSite = formatShortSite(item.fnSite);
              const isPicked = pickedStep === item.step;
              let rowClass = 'tu-dft-row';
              if (isPicked) rowClass += ' picked';
              if (item.layer === 'skeleton') rowClass += ' skeleton-row';

              let modClass = 'tu-df-layer-pill plugin';
              let modLabel = item.node;
              if (item.layer === 'skeleton') {
                modClass = 'tu-df-layer-pill skeleton';
                modLabel = `骨架 · ${item.node}`;
              }

              const outLabel = getTransferText(
                item.outgoing.via,
                item.outgoing.dataType,
                item.outgoing.label,
              );

              return (
                <tr
                  key={item.step}
                  className={rowClass}
                  data-dft-step={item.step}
                  aria-selected={isPicked}
                  onClick={() => onPickStep(item.step)}
                >
                  <td className="tu-dft-col-no">
                    <span className="tu-dft-no-pill">#{String(item.step)}</span>
                    {rawStep !== undefined && (
                      <span className="tu-dft-ms">{formatStepMs(rawStep.ms)}</span>
                    )}
                  </td>
                  <td className="tu-dft-col-mod">
                    <span className={modClass}>{modLabel}</span>
                  </td>
                  <td className="tu-dft-col-fn">
                    <div className="tu-dft-title">{stepTitle}</div>
                    {(item.fnName !== '' || shortSite !== '') && (
                      <div className="tu-dft-site">
                        {item.fnName !== '' && <code>{item.fnName}</code>}
                        {shortSite !== '' && <span>{shortSite}</span>}
                      </div>
                    )}
                  </td>
                  <td className="tu-dft-col-in">
                    {item.inputs.slice(0, 3).map((field, idx) => (
                      <div key={`${field.key}-${String(idx)}`} className="tu-dft-kv">
                        <code>{field.key}</code>
                        <span>{field.value}</span>
                      </div>
                    ))}
                    {item.inputs.length === 0 && (
                      <span className="tu-dft-muted">
                        {getTransferText(item.incoming.via, item.incoming.dataType)}
                      </span>
                    )}
                  </td>
                  <td className="tu-dft-col-diff">
                    {item.changes.map((ch, idx) => {
                      let targetText = ch.target;
                      if (ch.field !== '') targetText = `${ch.target}.${ch.field}`;
                      return (
                        <div key={`${targetText}-${String(idx)}`} className="tu-dft-diff-line">
                          <code className="tu-dft-diff-key">{targetText}:</code>
                          <span className="tu-dft-before">{ch.before || '空'}</span>
                          <span className="tu-dft-arrow">→</span>
                          <b className="tu-dft-after">{ch.after || '空'}</b>
                        </div>
                      );
                    })}
                    {item.changes.length === 0 && item.summary !== '' && (
                      <span className="tu-dft-sum-chip">{item.summary}</span>
                    )}
                    {item.changes.length === 0 && item.summary === '' && (
                      <span className="tu-dft-muted">—</span>
                    )}
                  </td>
                  <td className="tu-dft-col-out">
                    {item.outgoing.toStep !== null && (
                      <div className="tu-dft-out-box">
                        <span className="tu-dft-out-step">
                          → #{String(item.outgoing.toStep)} {item.outgoing.toNode}
                        </span>
                        <code>{outLabel}</code>
                      </div>
                    )}
                    {item.outgoing.toStep === null && (
                      <span className="tu-dft-muted">链路终点</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
