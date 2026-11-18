/**
 * 回复事件阅读：先呈现真实身份、所选回答、来源和分派理由，再按需展开原事件。
 * 仅请求同一后端的只读证据；展开与滚动绑定右侧查看历史，不重新执行或补造过程。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
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
  /** 外层可滚动容器；浏览器查看时交给 react-virtuoso 虚拟滚动。 */
  scrollParent?: HTMLElement | null;
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
  //M 渲染原生折叠控件并在切换展开状态时同步写入右栏历史。
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
  //M 同时换算首屏可读耗时与悬停精确毫秒值，保留原始证据精度。
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
  //M 获取翻译函数与演示打码开关，供片段提示和文件入口控制使用。
  const t = i18n.useT();
  const masked = privacy.useMask();

  //M 将保存的文本缩成首屏摘要并判断是否需要展开或打开原文件。
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
      {!masked && props.fileTarget.path && (
        <span className="jm-trace-file-actions">
          <button
            //M 点击后在右栏预览完整消息文件，方便对照未截断的原文。
            type="button"
            onClick={() => props.body.openPanel('preview', props.fileTarget)}
          >
            {t('打开完整消息文件')}
          </button>
          <vscodeLink.VsCodeOpen site={props.fileTarget.path} />
        </span>
      )}
    </div>
  );
}


/** 顶部身份只使用回复发送时保存的机器人、标题和当时工作区。 */
function ReplyHeader(props: TraceBodyProps): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供头部文案及敏感文件入口控制使用。
  const t = i18n.useT();
  const masked = privacy.useMask();

  //M 整理回复时间、生成与关联展示器及回答摘要，供头部各区域渲染。
  const target = props.trace.target;
  const at = props.presenter.timestamp(target.at);
  const exactAt = props.presenter.timestamp(target.at, true, true);
  const timing = props.presenter.timingLabels(props.trace);
  const fileTarget = { path: target.messageFile, name: t('消息 #{id}', { id: target.messageId }) };
  const presentation = new replyLinkModule.ReplyLink(t);
  const firstSource = target.association.messageIds[0];
  const answerPreview = props.presenter.textPreview(target.text, target.textChars);

  //M 渲染回复头部身份、生成模型标识、关联来源标签及跳转操作栏。
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
        <button
          type="button"
          disabled={!target.sessionId && !target.messageId}
          onClick={() => {
            const query = new URLSearchParams();
            if (target.sessionId) query.set('session', target.sessionId);
            if (target.messageId) query.set('message', String(target.messageId));
            window.open(`/flow/?${query.toString()}`, '_blank', 'noopener,noreferrer');
          }}
        >{t('查看流程图')}</button>
      </div>
      <div className="jm-trace-header-actions">
      <Disclosure itemKey="answer" label={t('回答原文')} controls={props.disclosures}>
        <p className="jm-trace-full-text">{target.text}</p>
        {answerPreview.fragmentNotice && <p className="jm-muted">{answerPreview.fragmentNotice}</p>}
        {!masked && target.messageFile && (
          <span className="jm-trace-file-actions">
            <button
              //M 点击在右栏打开完整消息文件预览，以便查看未截断的原文件。
              type="button"
              onClick={() => props.openPanel('preview', fileTarget)}>{t('打开完整消息文件')}</button>
            <vscodeLink.VsCodeOpen site={target.messageFile} />
          </span>
        )}
      </Disclosure>
        <Disclosure itemKey="timing" label={t('{label} {duration}', {
          label: timing.elapsedLabel,
          //M 把总耗时换算为可读秒/分，拼入耗时折叠标题。
          duration: props.presenter.duration(props.trace.elapsedMs),
        })} controls={props.disclosures}>
          <p>{t('来源接收')} · {
            //M 格式化回复流程起始时间为精确本地毫秒串，供用户核对过程。
            props.presenter.timestamp(props.trace.startedAt, true, true)
          }</p>
          <p>{timing.endLabel} · {
            //M 格式化回复流程结束时间为精确本地毫秒串，与起点对照核验。
            props.presenter.timestamp(props.trace.endedAt, true, true)
          }</p>
        </Disclosure>
      </div>
    </header>
  );
}


/** 历史缺口在首屏只占一条短提示，完整说明保留在同一个折叠区。 */
function Gaps(props: TraceBodyProps): react.JSX.Element {
  //M 获取翻译函数并汇总历史记录缺口说明，供首屏短提示渲染。
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
  //M 获取翻译函数与演示打码开关，供来源区域标题和人物脱敏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  return (
    <section className="jm-trace-source-section" aria-label={t('来源消息')}>
      <Disclosure itemKey="sources" label={t('查看关联来源（{count} 条）', {
        count: props.trace.target.association.messageIds.length,
      })} controls={props.disclosures}>
      {props.trace.sources.length === 0 && <p className="jm-muted">{t('来源消息未记录或已经不存在。')}</p>}
      {props.trace.sources.map((source) => {
        //M 将每条来源消息的收到时间格式化为首屏简略时间与悬停精确时间。
        const at = props.presenter.timestamp(source.createdAt);
        const exactAt = props.presenter.timestamp(source.createdAt, true, true);
        /** web 是已保存的入口标识，用已知入口名解释，不猜实际发送人的姓名。 */
        //M 按演示开关对发送方姓名执行脱敏，避免直接暴露身份。
        let sourceName = privacy.name(source.source, masked);
        if (source.source === 'web') {
          sourceName = `${t('网页')}（web）`;
        }
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
  //M 获取翻译函数与演示打码开关，供阶段文本及错误信息内路径脱敏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const view = props.view;
  const stage = view.stage;
  let usedClass = 'jm-muted';
  if (stage.used) {
    usedClass = 'jm-trace-stage-used';
  }
  return (
    <article className="jm-trace-stage">
      <div className="jm-trace-stage-head">
        <h4>{view.title}</h4>
        <span className={usedClass}>{view.used}</span>
      </div>
      <p className="jm-trace-stage-model">{view.model}</p>
      <p className="jm-trace-stage-time">
        <span>{view.elapsedLabel}</span>
        <span title={view.exactElapsed}>{view.elapsed}</span>
      </p>
      {stage.summary && <p className="jm-trace-stage-summary">{stage.summary}</p>}
      {stage.error && (
        <p className="jm-trace-error">
          <vscodeLink.TextWithVscodeLinks text={stage.error} masked={masked} />
        </p>
      )}
      <Disclosure itemKey={props.itemKey} label={t('阶段依据与调用记录')} controls={props.body.disclosures}>
        <p>{t('操作开始')} · {
          //M 把阶段开始时间格式化为带毫秒的精确本地时间，供展开核对。
          props.body.presenter.timestamp(stage.startedAt, true, true)
        }</p>
        {stage.msSource === 'calls-sum' && (
          <p className="jm-muted">{t('这里只合计已保存的模型调用时间，不含未记录的工具、排队等间隔。')}</p>
        )}
        {stage.options.length > 0 && (
          <ul className="jm-trace-options">
            {stage.options.map((option, index) => {
              //M 将候选分支的原始概率值换算为百分比展示文本。
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
  //M 获取翻译函数，并从分派记录整理出当时保存的分派理由与阶段视图。
  const t = i18n.useT();
  const dispatch = props.dispatch;
  const reason = props.body.presenter.dispatchReason(dispatch);
  const stages = props.body.presenter.stages(dispatch.stages);
  const unknown = t('未记录');
  /** 新开会话的标题来自已保存分派结论，悬停仍可核对真实入队的会话号。 */
  let savedTitle: string | null = null;
  if (typeof dispatch.result.title === 'string') {
    savedTitle = dispatch.result.title;
  }
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
  //M 获取翻译函数，用于历史分派折叠标题显示。
  const t = i18n.useT();
  const historical = props.trace.dispatches.filter((dispatch) => {
    //G 过滤掉已经挂在某条发送事件下的分派记录，避免在兜底区重复呈现。
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
  //M 获取翻译函数与演示打码开关，供事件标题、事实和原始字段脱敏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();

  //M 关联该事件对应的分派记录，并生成脱敏后的事件原始 JSON 字符串。
  const item = props.item;
  const record = item.record;
  const dispatch = props.body.presenter.dispatchFor(record, props.body.trace.dispatches);
  const original = privacy.text(props.body.presenter.raw(record), masked);
  const classes = ['jm-trace-event', `jm-trace-${item.category}`];
  if (item.failed) {
    classes.push('jm-trace-failed');
  }

  //M 渲染单条事件节点，对其标题与摘要按演示状态脱敏。
  return (
    <li className={classes.join(' ')} style={{ listStyle: 'none' }}>
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
        <h3>{privacy.text(item.title, masked)}</h3>
        {item.summary && <p className="jm-trace-event-summary">{privacy.text(item.summary, masked)}</p>}
        {dispatch && (
          <Disclosure itemKey={`event-dispatch:${record.id}`} label={t('分派模型、阶段与依据')}
            controls={props.body.disclosures}>
            <DispatchCard itemKey={`event-dispatch:${record.id}`} dispatch={dispatch} body={props.body} />
          </Disclosure>
        )}
        <Disclosure itemKey={`event:${record.id}`} label={t('规则、数据与依据')} controls={props.body.disclosures}>
          <dl className="jm-trace-facts">
            <div>
              <dt>{t('记录时间')}</dt>
              <dd>{item.fullTime}</dd>
            </div>
            <div>
              <dt>{t('报告模块')}</dt>
              <dd>
                <vscodeLink.TextWithVscodeLinks
                  //M 对报告模块文本按演示状态脱敏后再识别内嵌源码路径链接。
                  text={privacy.text(record.source, masked)}
                  masked={masked}
                />
              </dd>
            </div>
            {item.facts.map((fact) => (
              <div key={fact.key}>
                <dt
                  //M 悬停原始字段键和展示标签均按演示状态执行正文脱敏。
                  title={privacy.text(fact.key, masked)}
                >{privacy.text(fact.label, masked)}</dt>
                <dd>
                  <pre>
                    <vscodeLink.TextWithVscodeLinks
                      //M 对事实取值脱敏后再解析其中的可执行或源码路径链接。
                      text={privacy.text(fact.value, masked)}
                      masked={masked}
                    />
                  </pre>
                </dd>
              </div>
            ))}
          </dl>
          <Disclosure
            itemKey={`event-raw:${record.id}`}
            label={t('查看事件原始字段')}
            controls={props.body.disclosures}
          >
            <pre>
              <vscodeLink.TextWithVscodeLinks text={original} masked={masked} />
            </pre>
          </Disclosure>
        </Disclosure>
      </article>
    </li>
  );
}


/** 未精确归属回复的用量留在最后，不混进分派阶段或真实事件。 */
function Usage(props: TraceBodyProps): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供同会话时间窗调用记录脱敏与文案展示使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const renderUsageRow = (usage: types.TraceUsage, index: number): react.JSX.Element => {
    //M 格式化调用时间戳并对原始用量记录执行脱敏，供折叠详情核对。
    const at = props.presenter.timestamp(usage.at);
    const original = privacy.text(props.presenter.raw(usage), masked);
    const key = `usage:${usage.at}:${usage.model}:${index}`;
    return (
      <Disclosure key={key} itemKey={key} label={`${at} · ${usage.model}`} controls={props.disclosures}>
        <pre>{original}</pre>
      </Disclosure>
    );
  };

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
        {props.trace.usage.length > 0 && (
          <virtuoso.Virtuoso
            customScrollParent={props.scrollParent ?? undefined}
            initialItemCount={Math.min(props.trace.usage.length, 20)}
            data={props.trace.usage}
            computeItemKey={(index, usage) => `usage:${usage.at}:${usage.model}:${index}`}
            //M 按虚拟滚动视口逐行渲染同时间窗内的模型调用详情。
            itemContent={(index, usage) => renderUsageRow(usage, index)}
          />
        )}
      </Disclosure>
    </section>
  );
}


/**
 * 已加载证据的阅读正文；导出供离线渲染检查，不包含请求或执行副作用。
 * @param input 阅读正文所需的追踪证据、展示器、折叠控制及定位回调。
 * @returns 回复证据正文元素。
 * 副作用：无（纯渲染与绑定已有回调，不发起网络请求或修改执行状态）。
 */
export function TraceBody(input: TraceBodyProps): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，用于界面文案和整份证据副本脱敏。
  const t = i18n.useT();
  const masked = privacy.useMask();
  //M 展示副本保留技术判别；原始事件仍交展示器判别，正文和 JSON 在出口另行打码。
  const props = { ...input, trace: privacy.record(input.trace, masked) };
  const items = react.useMemo(() => input.presenter.items(input.trace.events), [input.presenter, input.trace.events]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const eventKeys = items.map((item) => `event:${item.record.id}`);
  const allExpanded = eventKeys.length > 0 && eventKeys.every((key) => props.disclosures.expanded.has(key));

  /** 批量只操作事件事实，保留回答、来源、原始字段和分派的单独展开状态。 */
  const toggleEvents = (): void => {
    const retained = [...props.disclosures.expanded].filter((key) => !/^event:\d+$/.test(key));
    let updated = [...retained, ...eventKeys];
    if (allExpanded) {
      updated = retained;
    }
    //M 批量替换事件事实的展开 key 列表，保留其他区域的独立折叠状态。
    props.disclosures.replace(updated);
  };
  let toggleLabel = t('展开全部');
  if (allExpanded) {
    toggleLabel = t('收起全部');
  }

  return (
    <>
      <ReplyHeader {...props} />
      <Gaps {...props} />
      <section className="jm-trace-records" aria-label={t('已保存的事件')}>
        <div className="jm-trace-toolbar">
          <h3>{t('已保存的事件')}</h3>
          {items.length > 0 && (
            <button type="button" onClick={toggleEvents}>{toggleLabel}</button>
          )}
          <span>{t('按事件发送序号向下 · {count} 条', { count: items.length })}</span>
        </div>
        <div className="jm-trace-legend">
          <span>□ {t('程序规则')}</span><span>◇ {t('模型决策')}</span><span>○ {t('外部回执')}</span>
          <span>{t('时间：{zone}', { zone })}</span>
        </div>
        {items.length > 0 && (
          <div className="jm-trace-timeline" role="list" aria-label={t('回复关联事件，按持久化序号排列')}>
            <virtuoso.Virtuoso
              customScrollParent={props.scrollParent ?? undefined}
              initialItemCount={Math.min(items.length, 20)}
              data={items}
              computeItemKey={(_index, item) => item.record.id}
              itemContent={(_index, item) => <EventItem item={item} body={props} />}
            />
          </div>
        )}
        <p className="jm-trace-end">{t('记录到此结束 · 只读查看不会重新执行')}</p>
      </section>
      <Dispatches {...props} />
      <Sources {...props} />
      <Usage {...props} />
    </>
  );
}


/**
 * 请求与阅读历史接线；异步返回必须匹配当前回复，加载占位态不覆盖旧阅读位置。
 * @returns 事件追踪面板元素。
 * 副作用：按当前目标请求回复追踪与来源定位接口，更新证据上下文、阅读位置及定位错误状态。
 */
export function Events(): react.JSX.Element {
  //M 从多语言、打码及 UI 仓库订阅追踪目标、当前机器人及面板操作回调。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const target = context.useUi((state) => state.traceTarget);
  const currentBot = context.useUi((state) => state.currentBot);
  const openPanel = context.useUi((state) => state.openPanel);
  const setEvidence = context.useUi((state) => state.setReplyEvidence);
  const locateMessage = context.useUi((state) => state.locateMessage);
  const uiStore = context.useUiStore();
  const [locateError, setLocateError] = react.useState<string | null>(null);
  /** 同一回答内连续定位多个来源也只接受最后一次操作。 */
  const locateRequest = react.useRef(0);
  //M 读取当前查看历史条目的轻量阅读状态与保存函数，用于同步展开项与滚动位置。
  const { reading, saveReading } = readingModule.useReadingState();
  const scroller = react.useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = react.useState<HTMLDivElement | null>(null);
  const attachScroller = react.useCallback((element: HTMLDivElement | null): void => {
    scroller.current = element;
    setScrollEl(element);
  }, []);
  const [loaded, setLoaded] = react.useState<LoadedTrace | null>(null);
  const [refresh, setRefresh] = react.useState(0);
  //M 随当前语言缓存事件展示器实例，避免每次重绘重复构造。
  const presenter = react.useMemo(() => new traceModule.TracePresenter(t), [t]);
  /** 多个原生 toggle 可连续发生，ref 保留最新展开列表，避免后一个覆盖前一个。 */
  const expandedRef = react.useRef(reading.expanded);
  expandedRef.current = reading.expanded;

  const replaceExpanded = react.useCallback((keys: string[]): void => {
    expandedRef.current = keys;
    saveReading({ expanded: keys });
  }, [saveReading]);
  const getErrorText = (error: unknown): string => {
    if (error instanceof Error) return error.message;

    return String(error);
  };
  const changeExpanded = react.useCallback((key: string, open: boolean): void => {
    const previous = expandedRef.current;
    if (previous.includes(key) === open) {
      return;
    }
    let updated = previous.filter((item) => item !== key);
    if (open) {
      updated = [...previous, key];
    }
    replaceExpanded(updated);
  }, [replaceExpanded]);
  const disclosures = react.useMemo<TraceDisclosures>(() => ({
    expanded: new Set(reading.expanded),
    change: changeExpanded,
    replace: replaceExpanded,
  }), [reading.expanded, changeExpanded, replaceExpanded]);

  /** 机器人不一致时不请求旧目标；消息号是全局持久号，和回复下标组成唯一目标。 */
  let active: storeModule.TraceTarget | null = null;
  if (target?.bot === currentBot) {
    active = target;
  }
  const messageId = active?.messageId;
  const replyIndex = active?.replyIndex;
  let targetKey = '';
  if (active) {
    targetKey = `${active.messageId}:${active.replyIndex}`;
  }
  let result: LoadedTrace | null = null;
  if (loaded?.key === targetKey) {
    result = loaded;
  }
  //M 在当前目标的追踪证据就绪后接管滚动容器位置恢复与保存，加载态不覆盖原位置。
  readingModule.useReadingScroll(scroller, Boolean(result?.trace));

  react.useEffect(() => {
    if (!target || messageId === undefined || replyIndex === undefined) {
      return;
    }
    /** 切回复或卸载后，旧请求不能把自己的正文和阅读位置带进新目标。 */
    let disposed = false;
    const key = `${messageId}:${replyIndex}`;
    //M 请求该条回复的完整只读追踪证据，并回写证据状态与当前匹配结果。
    void api.messageTrace(messageId, replyIndex).then((trace) => {
      if (!disposed) {
        setEvidence(target, trace.target);
        setLoaded({ key, trace, error: null });
      }
    }).catch((error: unknown) => {
      if (!disposed) {
        //G 未切换目标或卸载时展示可读的追踪加载错误信息。
        setLoaded({ key, trace: null, error: getErrorText(error) });
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
    //M 先按消息号向后端核查消息归属与视图来源，再决定是否跳转定位。
    void api.resolveMessages(target.bot, [id]).then((resolved) => {
      //G 校验请求序号与当前追踪目标仍一致，过期的定位回调直接丢弃。
      if (mine !== locateRequest.current
        || !replyLinkModule.ReplyLink.sameTarget(uiStore.getState().traceTarget, selectedTarget)) {
        return;
      }
      const message = resolved.messages.find((row) => row.id === id);
      if (!message) {
        setLocateError(t('消息 #{id} 已缺失或不属于当前机器人。', { id }));
        return;
      }
      //M 核查通过后根据消息来源推断视图归属，定位到聊天时间线对应位置。
      locateMessage({
        bot: selectedTarget.bot,
        origin: replyLinkModule.ReplyLink.origin(message),
        messageId: id,
        replyIndex: index,
      });
    }).catch((error: unknown) => {
      //G 仅当定位请求仍为最新且未切换目标时写入可读错误提示。
      if (mine === locateRequest.current
        && replyLinkModule.ReplyLink.sameTarget(uiStore.getState().traceTarget, selectedTarget)) {
        setLocateError(getErrorText(error));
      }
    });
  };

  if (!active) {
    return <div className="jm-empty">{t('点击一条机器人回复的“查看事件”，在这里查看来源与过程。')}</div>;
  }
  //M 渲染追踪面板顶栏、加载态与按演示状态脱敏的追踪/定位错误，并挂载证据正文。
  return (
    <div key={targetKey} className="jm-trace jm-trace-reader" ref={attachScroller}>
      <div className="jm-trace-top">
        <span>{t('回复事件追踪')}</span>
        <antd.Button size="small" onClick={() => setRefresh(refresh + 1)}>{t('刷新')}</antd.Button>
      </div>
      {!result && <p role="status">{t('正在读取事件…')}</p>}
      {result?.error && <p className="jm-trace-notice" role="alert">{privacy.text(result.error, masked)}</p>}
      {locateError && <p className="jm-trace-notice" role="alert">{privacy.text(locateError, masked)}</p>}
      {result?.trace && (
        <TraceBody trace={result.trace} presenter={presenter} openPanel={openPanel}
          disclosures={disclosures} onLocate={requestLocate} scrollParent={scrollEl} />
      )}
    </div>
  );
}
