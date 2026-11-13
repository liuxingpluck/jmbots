/**
 * 回复事件阅读：先呈现真实身份、所选回答、来源和分派理由，再按需展开原事件。
 * 仅请求同一后端的只读证据；展开与滚动绑定右侧查看历史，不重新执行或补造过程。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as readingModule from './Reading.ts';
import * as traceModule from './Trace.ts';
import * as replyLinkModule from '../Chat/ReplyLink.ts';
import type * as types from '../Types.ts';
import type * as storeModule from '../Store.ts';
import './Events.css';


/** 请求结果按目标保存，切换回复后的首帧不能沿用上一句证据。 */
interface LoadedTrace {
  /** 消息号与真实回复下标组成的请求身份。 */
  key: string;
  /** 已关联的安全证据；读取失败时为空。 */
  trace: types.ReplyTraceView | null;
  /** 真实接口或网络错误；成功时为空。 */
  error: string | null;
}


/** 折叠状态由当前查看历史拥有，不在各卡片里另存一份。 */
export interface TraceDisclosures {
  /** 当前条目展开的稳定 key。 */
  expanded: ReadonlySet<string>;
  /** 用户展开或收起一项；不会触发后端请求。 */
  change: (key: string, open: boolean) => void;
  /** 批量更新事件展开项，保留来源、回答等其他项。 */
  replace: (keys: string[]) => void;
}


/** 阅读正文的共同依赖；分派、来源与事件各自只取需要的字段。 */
interface TraceBodyProps {
  /** 后端已经安全投影的回复证据。 */
  trace: types.ReplyTraceView;
  /** 只整理已保存字段的展示器。 */
  presenter: traceModule.TracePresenter;
  /** 现有文件预览动作，继续遵守原文件接口的访问边界。 */
  openPanel: storeModule.UiState['openPanel'];
  /** 当前右栏历史条目的展开状态。 */
  disclosures: TraceDisclosures;
  /** 按明确消息号定位，内部会检查来源视图和缺失；省略时为离线只读渲染。 */
  onLocate?: (messageId: number, replyIndex: number | null) => void;
}


/** 原生折叠控件使用稳定 key；返回历史时恢复，程序恢复引起的 toggle 不重复写入。 */
function Disclosure(props: {
  /** 当前目标内唯一且稳定的展开标识。 */
  itemKey: string;
  /** 用户能理解的折叠标题。 */
  label: react.ReactNode;
  /** 右侧历史拥有的状态与动作。 */
  controls: TraceDisclosures;
  /** 按需阅读的正文。 */
  children: react.ReactNode;
}): react.JSX.Element {
  const open = props.controls.expanded.has(props.itemKey);
  return (
    <details
      className="jm-trace-disclosure"
      open={open}
      data-reading-key={props.itemKey}
      onToggle={(event) => props.controls.change(props.itemKey, event.currentTarget.open)}
    >
      <summary>{props.label}</summary>
      <div className="jm-trace-disclosure-body">{props.children}</div>
    </details>
  );
}


/** 秒/分常显，精确毫秒仅在标题中核对，原始证据值不被四舍五入替换。 */
function Duration(props: {
  /** 保存的毫秒；未记录为空。 */
  ms: number | null;
  /** 当前语言下的时间格式。 */
  presenter: traceModule.TracePresenter;
}): react.JSX.Element {
  const readable = props.presenter.duration(props.ms);
  const exact = props.presenter.exactDuration(props.ms);
  return <span className="jm-trace-duration" title={exact}>{readable}</span>;
}


/** 摘要常显，长文和片段边界可展开，完整文件交给现有预览。 */
function TextFragment(props: {
  /** 该片段稳定的历史 key。 */
  itemKey: string;
  /** 后端保存的安全文本片段。 */
  text: string;
  /** 原始文本总字符数；用于区分片段与全文。 */
  textChars: number;
  /** 摘要最长字数；所选回答比来源多留一些。 */
  max?: number;
  /** 原消息文件，可能含同条消息的多个回复。 */
  fileTarget: storeModule.PanelTarget;
  /** 当前目标的阅读依赖。 */
  body: TraceBodyProps;
}): react.JSX.Element {
  const t = i18n.useT();
  const preview = props.body.presenter.textPreview(props.text, props.textChars, props.max);
  const expanded = props.body.disclosures.expanded.has(props.itemKey);
  return (
    <div className="jm-trace-fragment">
      {!expanded && <p className="jm-trace-visible-text">{preview.summary}</p>}
      {preview.expandable && (
        <Disclosure itemKey={props.itemKey} label={t('展开已保存原文')} controls={props.body.disclosures}>
          <p className="jm-trace-full-text">{props.text}</p>
          {preview.fragmentNotice && <p className="jm-muted">{preview.fragmentNotice}</p>}
        </Disclosure>
      )}
      {props.fileTarget.path && (
        <button type="button" onClick={() => props.body.openPanel('preview', props.fileTarget)}>
          {t('打开完整消息文件')}
        </button>
      )}
    </div>
  );
}


/** 顶部身份只使用回复发送时保存的机器人、标题和当时工作区。 */
function ReplyHeader(props: TraceBodyProps): react.JSX.Element {
  const t = i18n.useT();
  const target = props.trace.target;
  const at = props.presenter.timestamp(target.at);
  const exactAt = props.presenter.timestamp(target.at, true, true);
  const timing = props.presenter.timingLabels(props.trace);
  const fileTarget = { path: target.messageFile, name: t('消息 #{id}', { id: target.messageId }) };
  const presentation = new replyLinkModule.ReplyLink(t);
  const firstSource = target.association.messageIds[0];
  const answerPreview = props.presenter.textPreview(target.text, target.textChars);

  return (
    <header className="jm-trace-reply-header">
      <div className="jm-trace-heading">
        <h2>{t('{bot}的回复', { bot: target.bot })}</h2>
        <time title={exactAt}>{at}</time>
      </div>
      <p className="jm-trace-identity">
        <span title={target.sessionId}>{target.sessionTitle || target.sessionId || t('会话未记录')}</span>
        {target.workspace && <span>{t('工作区：{name}', { name: target.workspace })}</span>}
        <span title={presentation.generationTitle(target.generation)}>
          {presentation.generation(target.generation)}
        </span>
      </p>
      <div className="jm-trace-association">
        <span className="jm-reply-link-tag">{presentation.tag(target)}</span>
        <span title={target.association.source}>{presentation.association(target.association)}</span>
        <button type="button" disabled={!props.onLocate}
          onClick={() => props.onLocate?.(target.messageId, target.replyIndex)}>{t('定位回答')}</button>
        <button type="button" disabled={!props.onLocate || firstSource === undefined}
          onClick={() => firstSource !== undefined && props.onLocate?.(firstSource, null)}>{t('定位来源')}</button>
      </div>
      <div className="jm-trace-header-actions">
      <Disclosure itemKey="answer" label={t('回答原文')} controls={props.disclosures}>
        <p className="jm-trace-full-text">{target.text}</p>
        {answerPreview.fragmentNotice && <p className="jm-muted">{answerPreview.fragmentNotice}</p>}
        {target.messageFile && (
          <button type="button" onClick={() => props.openPanel('preview', fileTarget)}>{t('打开完整消息文件')}</button>
        )}
      </Disclosure>
        <Disclosure itemKey="timing" label={t('{label} {duration}', {
          label: timing.elapsedLabel,
          duration: props.presenter.duration(props.trace.elapsedMs),
        })} controls={props.disclosures}>
          <p>{t('来源接收')} · {props.presenter.timestamp(props.trace.startedAt, true, true)}</p>
          <p>{timing.endLabel} · {props.presenter.timestamp(props.trace.endedAt, true, true)}</p>
        </Disclosure>
      </div>
    </header>
  );
}


/** 历史缺口在首屏只占一条短提示，完整说明保留在同一个折叠区。 */
function Gaps(props: TraceBodyProps): react.JSX.Element {
  const t = i18n.useT();
  const summary = props.presenter.noteSummary(props.trace);
  return (
    <aside className="jm-trace-gaps">
      <p>{summary}</p>
      {props.trace.notes.length > 0 && (
        <Disclosure itemKey="notes" label={t('记录说明')} controls={props.disclosures}>
          <ul>{props.trace.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
        </Disclosure>
      )}
    </aside>
  );
}


/** 来源身份、收到时间和原话摘要直接可读，编号仅作辅助定位。 */
function Sources(props: TraceBodyProps): react.JSX.Element {
  const t = i18n.useT();
  return (
    <section className="jm-trace-source-section" aria-label={t('来源消息')}>
      <Disclosure itemKey="sources" label={t('查看关联来源（{count} 条）', {
        count: props.trace.target.association.messageIds.length,
      })} controls={props.disclosures}>
      {props.trace.sources.length === 0 && <p className="jm-muted">{t('来源消息未记录或已经不存在。')}</p>}
      {props.trace.sources.map((source) => {
        const at = props.presenter.timestamp(source.createdAt);
        const exactAt = props.presenter.timestamp(source.createdAt, true, true);
        /** web 是已保存的入口标识，用已知入口名解释，不猜实际发送人的姓名。 */
        const sourceName = source.source === 'web' ? `${t('网页')}（web）` : source.source;
        const fileTarget = { path: source.file, name: t('消息 #{id}', { id: source.id }) };
        return (
          <article key={source.id} className="jm-trace-source-card">
            <div className="jm-trace-source-identity">
              <strong>{t('发送方／来源：{name}', { name: sourceName || t('未记录') })}</strong>
              <span>{t('渠道：{name}', { name: source.channel })}</span>
              <time title={exactAt}>{at}</time>
              <span className="jm-muted">#{source.id}</span>
              <button type="button" disabled={!props.onLocate}
                onClick={() => props.onLocate?.(source.id, null)}>{t('定位这条来源')}</button>
            </div>
            <TextFragment
              itemKey={`source:${source.id}`}
              text={source.text}
              textChars={source.textChars}
              fileTarget={fileTarget}
              body={props}
            />
          </article>
        );
      })}
      </Disclosure>
    </section>
  );
}


/** 决策或兜底依原保存顺序呈现；概率按需展开。 */
function DispatchStage(props: {
  /** 阶段的稳定阅读 key。 */
  itemKey: string;
  /** 已保存阶段与首屏投影。 */
  view: traceModule.TraceStageView;
  /** 当前目标的阅读依赖。 */
  body: TraceBodyProps;
}): react.JSX.Element {
  const t = i18n.useT();
  const view = props.view;
  const stage = view.stage;
  return (
    <article className="jm-trace-stage">
      <div className="jm-trace-stage-head">
        <h4>{view.title}</h4>
        <span className={stage.used ? 'jm-trace-stage-used' : 'jm-muted'}>{view.used}</span>
      </div>
      <p className="jm-trace-stage-model">{view.model}</p>
      <p className="jm-trace-stage-time">
        <span>{view.elapsedLabel}</span>
        <span title={view.exactElapsed}>{view.elapsed}</span>
      </p>
      {stage.summary && <p className="jm-trace-stage-summary">{stage.summary}</p>}
      {stage.error && <p className="jm-trace-error">{stage.error}</p>}
      <Disclosure itemKey={props.itemKey} label={t('阶段依据与调用记录')} controls={props.body.disclosures}>
        <p>{t('操作开始')} · {props.body.presenter.timestamp(stage.startedAt, true, true)}</p>
        {stage.msSource === 'calls-sum' && (
          <p className="jm-muted">{t('这里只合计已保存的模型调用时间，不含未记录的工具、排队等间隔。')}</p>
        )}
        {stage.options.length > 0 && (
          <ul className="jm-trace-options">
            {stage.options.map((option, index) => {
              const probability = props.body.presenter.probability(option.probability);
              return (
                <li key={index}>
                  <span>{option.label}</span>
                  <strong title={String(option.probability ?? '')}>{probability}</strong>
                  {option.session && <small>{option.session}</small>}
                </li>
              );
            })}
          </ul>
        )}
      </Disclosure>
    </article>
  );
}


/** 分派卡前置：理由、总时间、去向、默认/实际模型都来自当时记录。 */
function DispatchCard(props: {
  /** 同一批分派的稳定阅读 key。 */
  itemKey: string;
  /** 后端安全投影的分派记录。 */
  dispatch: types.TraceDispatch;
  /** 当前目标的阅读依赖。 */
  body: TraceBodyProps;
}): react.JSX.Element {
  const t = i18n.useT();
  const dispatch = props.dispatch;
  const reason = props.body.presenter.dispatchReason(dispatch);
  const stages = props.body.presenter.stages(dispatch.stages);
  const unknown = t('未记录');
  /** 新开会话的标题来自已保存分派结论，悬停仍可核对真实入队的会话号。 */
  const savedTitle = typeof dispatch.result.title === 'string' ? dispatch.result.title : null;
  const sessionLabel = savedTitle || dispatch.targetSessionId || unknown;
  return (
    <article className="jm-trace-dispatch-card">
      <div className="jm-trace-dispatch-head">
        <span>{t('分派总耗时')}</span>
        <Duration ms={dispatch.ms} presenter={props.body.presenter} />
      </div>
      <p className="jm-trace-dispatch-reason">{reason}</p>
      <dl className="jm-trace-dispatch-target">
        <div><dt>{t('目标机器人')}</dt><dd>{dispatch.targetBot}</dd></div>
        <div><dt>{t('目标会话')}</dt><dd title={dispatch.targetSessionId ?? undefined}>{sessionLabel}</dd></div>
        <div><dt>{t('工作区')}</dt><dd>{dispatch.workspace || unknown}</dd></div>
        <div><dt>{t('配置默认模型')}</dt><dd>{dispatch.defaultModel || unknown}</dd></div>
        <div><dt>{t('分派实际模型')}</dt><dd>{dispatch.actualModel || unknown}</dd></div>
      </dl>
      <div className="jm-trace-stages">
        {stages.map((view, index) => {
          const stageKey = `${props.itemKey}:stage:${index}:${view.stage.kind}`;
          return <DispatchStage key={stageKey} itemKey={stageKey} view={view} body={props.body} />;
        })}
      </div>
      {dispatch.checks.length > 0 && (
        <Disclosure
          itemKey={`${props.itemKey}:checks`}
          label={t('程序核对依据')}
          controls={props.body.disclosures}
        >
          <ul>{dispatch.checks.map((check, index) => <li key={index}>{check}</li>)}</ul>
        </Disclosure>
      )}
    </article>
  );
}


/** 旧记录即使没有完整事件，也能阅读已经保存的分派结论和各阶段。 */
function Dispatches(props: TraceBodyProps): react.JSX.Element | null {
  const t = i18n.useT();
  const historical = props.trace.dispatches.filter((dispatch) => {
    return !props.trace.events.some((event) => props.presenter.dispatchFor(event, [dispatch]) !== undefined);
  });
  if (historical.length === 0) {
    return null;
  }
  return (
    <section className="jm-trace-historical-dispatch">
      <Disclosure itemKey="historical-dispatch" label={t('历史分派记录（无发送序号）')} controls={props.disclosures}>
      {historical.map((dispatch) => {
        const batch = dispatch.messageIds.join(',');
        const itemKey = `dispatch:${batch}:${dispatch.startedAt ?? 'unknown'}`;
        return <DispatchCard key={itemKey} itemKey={itemKey} dispatch={dispatch} body={props} />;
      })}
      </Disclosure>
    </section>
  );
}


/** 原始事件仍按持久号向下，事实和原始字段各有稳定阅读 key。 */
function EventItem(props: {
  /** 不按墙钟重新排序的事件投影。 */
  item: traceModule.TraceItem;
  /** 当前目标的阅读依赖。 */
  body: TraceBodyProps;
}): react.JSX.Element {
  const t = i18n.useT();
  const item = props.item;
  const record = item.record;
  const dispatch = props.body.presenter.dispatchFor(record, props.body.trace.dispatches);
  const original = props.body.presenter.raw(record);
  const classes = ['jm-trace-event', `jm-trace-${item.category}`];
  if (item.failed) {
    classes.push('jm-trace-failed');
  }

  return (
    <li className={classes.join(' ')}>
      <div className="jm-trace-stamp">
        <time title={item.fullTime}>{item.time}</time>
        <span title={t('相邻记录的时间戳差，不能当作单项操作耗时')}>{item.delta}</span>
      </div>
      <article className="jm-trace-event-main">
        <div className="jm-trace-event-meta">
          <span>#{record.id}</span>
          <span>{item.symbol} {item.categoryText}</span>
          <code>{record.type}</code>
        </div>
        <h3>{item.title}</h3>
        {item.summary && <p className="jm-trace-event-summary">{item.summary}</p>}
        {dispatch && (
          <Disclosure itemKey={`event-dispatch:${record.id}`} label={t('分派模型、阶段与依据')}
            controls={props.body.disclosures}>
            <DispatchCard itemKey={`event-dispatch:${record.id}`} dispatch={dispatch} body={props.body} />
          </Disclosure>
        )}
        <Disclosure itemKey={`event:${record.id}`} label={t('规则、数据与依据')} controls={props.body.disclosures}>
          <dl className="jm-trace-facts">
            <div><dt>{t('记录时间')}</dt><dd>{item.fullTime}</dd></div>
            <div><dt>{t('报告模块')}</dt><dd>{record.source}</dd></div>
            {item.facts.map((fact) => (
              <div key={fact.key}><dt title={fact.key}>{fact.label}</dt><dd><pre>{fact.value}</pre></dd></div>
            ))}
          </dl>
          <Disclosure
            itemKey={`event-raw:${record.id}`}
            label={t('查看事件原始字段')}
            controls={props.body.disclosures}
          >
            <pre>{original}</pre>
          </Disclosure>
        </Disclosure>
      </article>
    </li>
  );
}


/** 未精确归属回复的用量留在最后，不混进分派阶段或真实事件。 */
function Usage(props: TraceBodyProps): react.JSX.Element {
  const t = i18n.useT();
  return (
    <section className="jm-trace-evidence">
      <Disclosure
        itemKey="usage"
        label={t('同会话时间窗的模型调用（{count} 次）', { count: props.trace.usage.length })}
        controls={props.disclosures}
      >
        <p className="jm-muted">
          {t('这些用量记录只有会话和时间，不能精确归属这句回复。精确关联的调用在上方事件中。')}
        </p>
        {props.trace.usage.map((usage, index) => {
          const at = props.presenter.timestamp(usage.at);
          const original = props.presenter.raw(usage);
          const key = `usage:${usage.at}:${usage.model}:${index}`;
          return (
            <Disclosure key={key} itemKey={key} label={`${at} · ${usage.model}`} controls={props.disclosures}>
              <pre>{original}</pre>
            </Disclosure>
          );
        })}
      </Disclosure>
    </section>
  );
}


/** 已加载证据的阅读正文；导出供离线渲染检查，不包含请求或执行副作用。 */
export function TraceBody(props: TraceBodyProps): react.JSX.Element {
  const t = i18n.useT();
  const items = react.useMemo(() => props.presenter.items(props.trace.events), [props.presenter, props.trace.events]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const eventKeys = items.map((item) => `event:${item.record.id}`);
  const allExpanded = eventKeys.length > 0 && eventKeys.every((key) => props.disclosures.expanded.has(key));

  /** 批量只操作事件事实，保留回答、来源、原始字段和分派的单独展开状态。 */
  const toggleEvents = (): void => {
    const retained = [...props.disclosures.expanded].filter((key) => !/^event:\d+$/.test(key));
    const updated = allExpanded ? retained : [...retained, ...eventKeys];
    props.disclosures.replace(updated);
  };

  return (
    <>
      <ReplyHeader {...props} />
      <Gaps {...props} />
      <section className="jm-trace-records" aria-label={t('已保存的事件')}>
        <div className="jm-trace-toolbar">
          <h3>{t('已保存的事件')}</h3>
          {items.length > 0 && (
            <button type="button" onClick={toggleEvents}>{allExpanded ? t('收起全部') : t('展开全部')}</button>
          )}
          <span>{t('按事件发送序号向下 · {count} 条', { count: items.length })}</span>
        </div>
        <div className="jm-trace-legend">
          <span>□ {t('程序规则')}</span><span>◇ {t('模型决策')}</span><span>○ {t('外部回执')}</span>
          <span>{t('时间：{zone}', { zone })}</span>
        </div>
        {items.length > 0 && (
          <ol className="jm-trace-timeline" aria-label={t('回复关联事件，按持久化序号排列')}>
            {items.map((item) => <EventItem key={item.record.id} item={item} body={props} />)}
          </ol>
        )}
        <p className="jm-trace-end">{t('记录到此结束 · 只读查看不会重新执行')}</p>
      </section>
      <Dispatches {...props} />
      <Sources {...props} />
      <Usage {...props} />
    </>
  );
}


/** 请求与阅读历史接线；异步返回必须匹配当前回复，加载占位态不覆盖旧阅读位置。 */
export function Events(): react.JSX.Element {
  const t = i18n.useT();
  const target = context.useUi((state) => state.traceTarget);
  const currentBot = context.useUi((state) => state.currentBot);
  const openPanel = context.useUi((state) => state.openPanel);
  const setEvidence = context.useUi((state) => state.setReplyEvidence);
  const locateMessage = context.useUi((state) => state.locateMessage);
  const uiStore = context.useUiStore();
  const [locateError, setLocateError] = react.useState<string | null>(null);
  /** 同一回答内连续定位多个来源也只接受最后一次操作。 */
  const locateRequest = react.useRef(0);
  const { reading, saveReading } = readingModule.useReadingState();
  const scroller = react.useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = react.useState<LoadedTrace | null>(null);
  const [refresh, setRefresh] = react.useState(0);
  const presenter = react.useMemo(() => new traceModule.TracePresenter(t), [t]);
  /** 多个原生 toggle 可连续发生，ref 保留最新展开列表，避免后一个覆盖前一个。 */
  const expandedRef = react.useRef(reading.expanded);
  expandedRef.current = reading.expanded;

  const replaceExpanded = react.useCallback((keys: string[]): void => {
    expandedRef.current = keys;
    saveReading({ expanded: keys });
  }, [saveReading]);
  const changeExpanded = react.useCallback((key: string, open: boolean): void => {
    const previous = expandedRef.current;
    if (previous.includes(key) === open) {
      return;
    }
    const updated = open ? [...previous, key] : previous.filter((item) => item !== key);
    replaceExpanded(updated);
  }, [replaceExpanded]);
  const disclosures = react.useMemo<TraceDisclosures>(() => ({
    expanded: new Set(reading.expanded),
    change: changeExpanded,
    replace: replaceExpanded,
  }), [reading.expanded, changeExpanded, replaceExpanded]);

  /** 机器人不一致时不请求旧目标；消息号是全局持久号，和回复下标组成唯一目标。 */
  const active = target?.bot === currentBot ? target : null;
  const messageId = active?.messageId;
  const replyIndex = active?.replyIndex;
  const targetKey = active ? `${active.messageId}:${active.replyIndex}` : '';
  const result = loaded?.key === targetKey ? loaded : null;
  readingModule.useReadingScroll(scroller, Boolean(result?.trace));

  react.useEffect(() => {
    if (!target || messageId === undefined || replyIndex === undefined) {
      return;
    }
    /** 切回复或卸载后，旧请求不能把自己的正文和阅读位置带进新目标。 */
    let disposed = false;
    const key = `${messageId}:${replyIndex}`;
    void api.messageTrace(messageId, replyIndex).then((trace) => {
      if (!disposed) {
        setEvidence(target, trace.target);
        setLoaded({ key, trace, error: null });
      }
    }).catch((error: unknown) => {
      if (!disposed) {
        const reason = error instanceof Error ? error.message : String(error);
        setLoaded({ key, trace: null, error: reason });
      }
    });
    return () => {
      disposed = true;
    };
  }, [messageId, replyIndex, refresh]);
  react.useEffect(() => {
    locateRequest.current += 1;
    setLocateError(null);
    return () => {
      locateRequest.current += 1;
    };
  }, [targetKey]);

  /** 先按号查真实来源视图，再定位；跨来源、缺失和快速切换都不猜。 */
  const requestLocate = (id: number, index: number | null): void => {
    if (!target) {
      return;
    }
    const selectedTarget = target;
    const mine = ++locateRequest.current;
    setLocateError(null);
    void api.resolveMessages(target.bot, [id]).then((resolved) => {
      if (mine !== locateRequest.current
        || !replyLinkModule.ReplyLink.sameTarget(uiStore.getState().traceTarget, selectedTarget)) {
        return;
      }
      const message = resolved.messages.find((row) => row.id === id);
      if (!message) {
        setLocateError(t('消息 #{id} 已缺失或不属于当前机器人。', { id }));
        return;
      }
      locateMessage({
        bot: selectedTarget.bot,
        origin: replyLinkModule.ReplyLink.origin(message),
        messageId: id,
        replyIndex: index,
      });
    }).catch((error: unknown) => {
      if (mine === locateRequest.current
        && replyLinkModule.ReplyLink.sameTarget(uiStore.getState().traceTarget, selectedTarget)) {
        const reason = error instanceof Error ? error.message : String(error);
        setLocateError(reason);
      }
    });
  };

  if (!active) {
    return <div className="jm-empty">{t('点击一条机器人回复的“查看事件”，在这里查看来源与过程。')}</div>;
  }
  return (
    <div key={targetKey} className="jm-trace jm-trace-reader" ref={scroller}>
      <div className="jm-trace-top">
        <span>{t('回复事件追踪')}</span>
        <antd.Button size="small" onClick={() => setRefresh(refresh + 1)}>{t('刷新')}</antd.Button>
      </div>
      {!result && <p role="status">{t('正在读取事件…')}</p>}
      {result?.error && <p className="jm-trace-notice" role="alert">{result.error}</p>}
      {locateError && <p className="jm-trace-notice" role="alert">{locateError}</p>}
      {result?.trace && (
        <TraceBody trace={result.trace} presenter={presenter} openPanel={openPanel}
          disclosures={disclosures} onLocate={requestLocate} />
      )}
    </div>
  );
}
