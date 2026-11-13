/**
 * 时间线（docs/界面/01_界面设计.md 第 7.1 节）：用户的靠右、机器人的靠左、事件行是中间的灰色小字（点了在右栏打开会话 md）。
 * 新消息来了自动到底；用户正在往上看时不打扰，显示“有新消息”。滚到顶自动取更早的，取完保持看着的位置不跳。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as approvalCard from '../Approval/ApprovalCard.tsx';
import * as i18n from '../I18n.ts';
import * as attachmentView from './AttachmentView.tsx';
import * as markdown from './Markdown.tsx';
import * as timeline from './Timeline.ts';
import * as replyLinkModule from './ReplyLink.ts';
import * as context from '../Context.ts';
import './ReplyLink.css';
import type * as types from '../Types.ts';
import type * as messagesModule from './useMessages.ts';
import type * as storeModule from '../Store.ts';


/** 时间线的属性。 */
interface MessageListProps {
  /** 数据和动作（useMessages）。 */
  state: messagesModule.MessagesState;
  /** 机器人名（机器人消息上显示）。 */
  bot: string;
  /** 在右栏打开一个文件。 */
  onOpen: (target: { path: string; name: string }) => void;
  /** 查看具体回复的只读事件；目标来自时间线里的真实回复下标。 */
  onTrace: storeModule.UiState['openTrace'];
  /** 当前选中的回复；没有选中时是 null。 */
  traceTarget: storeModule.TraceTarget | null;
  /** 没有消息时显示什么；不写是“说点什么吧”。 */
  emptyText?: string;
  /** 还在等决定的命令：卡片排在时间线里（右栏的“消息”不放）。 */
  approvals?: types.ApprovalView[];
}


/** 离底部多近算“在底部”，像素。 */
const BOTTOM_SLACK = 48;


/**
 * 复制按钮。
 * @param props text 要复制的文字。
 */
function CopyButton(props: { text: string }): react.JSX.Element {
  const t = i18n.useT();
  /** 刚复制过。 */
  const [copied, setCopied] = react.useState(false);
  return (
    <antd.Button
      type="text"
      size="small"
      className="jm-msg-action"
      aria-label={t('复制这条')}
      icon={copied ? <icons.CheckOutlined /> : <icons.CopyOutlined />}
      onClick={() => {
        void navigator.clipboard.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}


/**
 * 一项。
 * @param props item 这一项；bot 机器人名；onOpen 打开文件。
 */
function Item(props: {
  /** 当前时间线项。 */
  item: timeline.TimelineItem;
  /** 机器人名字。 */
  bot: string;
  /** 原有文件预览动作。 */
  onOpen: MessageListProps['onOpen'];
  /** 只读追踪动作。 */
  onTrace: MessageListProps['onTrace'];
  /** 已选中的回复，切回预览时仍保留。 */
  traceTarget: storeModule.TraceTarget | null;
  /** 只高亮这句回复实际关联的来源集合，历史范围已由后端明确标注。 */
  selection: storeModule.ReplySelection | null;
}): react.JSX.Element {
  const t = i18n.useT();
  const item = props.item;
  const presentation = new replyLinkModule.ReplyLink(t);
  const linked = item.kind !== 'approval' && props.selection?.target.bot === props.bot
    && props.selection.association.messageIds.includes(item.message.id);
  const linkTag = props.selection ? presentation.tag(props.selection.target) : '';
  if (item.kind === 'approval') {
    return <approvalCard.ApprovalCard approval={item.approval} />;
  }
  if (item.kind === 'note') {
    return (
      <div className={linked ? 'jm-event jm-event-note jm-msg-linked' : 'jm-event jm-event-note'}
        data-timeline-key={item.key} tabIndex={-1}>
        {linked && <span className="jm-reply-link-tag">{linkTag}</span>}
        {item.text}
      </div>
    );
  }
  if (item.kind === 'event') {
    return (
      <div className="jm-event">
        <button type="button" disabled={!item.dispatch.file} onClick={() => props.onOpen({ path: item.dispatch.file, name: item.dispatch.title || item.dispatch.sessionId })} title={item.dispatch.reason}>
          {timeline.eventText(item.dispatch, t)}
        </button>
      </div>
    );
  }
  if (item.kind === 'user') {
    /** 还没进会话时的小字。 */
    const pending = timeline.pendingText(item.message.status, t);
    return (
      <div className={linked ? 'jm-msg jm-msg-user jm-msg-linked' : 'jm-msg jm-msg-user'}
        data-timeline-key={item.key} tabIndex={-1}>
        <div className="jm-msg-meta">
          {linked && <span className="jm-reply-link-tag">{linkTag}</span>}
          <span className="jm-msg-source">{timeline.channelLabel(item.message.channel, item.message.source, t)}</span>
          <span>{timeline.formatTime(item.at)}</span>
          {pending && <span className="jm-msg-pending">{pending}</span>}
          <CopyButton text={item.message.text} />
        </div>
        <div className="jm-bubble jm-bubble-user">
          <markdown.Markdown text={item.message.text} onOpen={props.onOpen} />
        </div>
      </div>
    );
  }
  /** 从收到那条消息到这条回复用了多久。 */
  const elapsed = timeline.formatElapsed(item.reply.at - item.message.createdAt, t);
  /** 所选目标使用真实数组下标；不依赖可能重复的正文和发送时间。 */
  const traceTarget: storeModule.TraceTarget = {
    bot: item.message.bot,
    messageId: item.message.id,
    replyIndex: item.replyIndex,
  };
  const selected = props.traceTarget?.bot === traceTarget.bot
    && props.traceTarget.messageId === traceTarget.messageId
    && props.traceTarget.replyIndex === traceTarget.replyIndex;

  /**
   * 点正文打开追踪；操作附件、链接、复制或选择文字时继续交给原控件。
   * 明确按钮另作键盘入口，避免把整个 Markdown 气泡伪装成一个按钮。
   */
  const inspectBody = (event: react.MouseEvent<HTMLDivElement>): void => {
    const clicked = event.target;
    if (!(clicked instanceof Element)) {
      return;
    }
    if (clicked.closest('a, button, input, textarea, select, audio, video, summary, .jm-att, [role="button"]')) {
      return;
    }
    if (window.getSelection()?.isCollapsed === false) {
      return;
    }

    props.onTrace(traceTarget, item.reply);
  };
  return (
    <div className={selected ? 'jm-msg jm-msg-bot jm-msg-traced jm-msg-linked' : 'jm-msg jm-msg-bot'}
      data-timeline-key={item.key} tabIndex={-1}>
      <div className="jm-msg-meta">
        {selected && <span className="jm-reply-link-tag">{linkTag}</span>}
        <span className="jm-msg-source">{props.bot}</span>
        <span>{timeline.formatTime(item.at)}</span>
        {elapsed && <span className="jm-msg-elapsed" title={t('从收到你那条消息到这条回复')}>{elapsed}</span>}
        <button type="button" className="jm-msg-session" disabled={!item.reply.session.file} onClick={() => props.onOpen({ path: item.reply.session.file, name: item.reply.session.title })}>
          {item.reply.session.title}
        </button>
        <CopyButton text={item.reply.text} />
        <button
          type="button"
          className="jm-msg-trace"
          aria-pressed={selected}
          onClick={() => props.onTrace(traceTarget, item.reply)}
        >
          {t('查看事件')}
        </button>
        <span className="jm-reply-generation" title={presentation.generationTitle(item.reply.generation)}>
          {presentation.generation(item.reply.generation)}
        </span>
      </div>
      <div className="jm-bubble jm-bubble-bot jm-bubble-inspect" onClick={inspectBody}>
        <markdown.Markdown text={item.reply.text} onOpen={props.onOpen} />
        {item.reply.attachments
          .filter((attachment) => !item.reply.text.includes(attachment.path))
          .map((attachment) => (
            <attachmentView.AttachmentView key={attachment.path} attachment={attachment} onOpen={props.onOpen} />
          ))}
      </div>
    </div>
  );
}


/**
 * 时间线。
 * @param props 数据、机器人名、打开文件。
 */
export function MessageList(props: MessageListProps): react.JSX.Element {
  const t = i18n.useT();
  const selection = context.useUi((state) => state.replySelection);
  const selectionError = context.useUi((state) => state.replySelectionError);
  const resolution = context.useUi((state) => state.sourceResolutions[props.state.origin]);
  const setResolution = context.useUi((state) => state.setSourceResolution);
  const locateMessage = context.useUi((state) => state.locateMessage);
  const location = context.useUi((state) => state.chatLocation);
  const finishLocation = context.useUi((state) => state.finishLocation);
  const presentation = react.useMemo(() => new replyLinkModule.ReplyLink(t), [t]);
  const selected = selection && replyLinkModule.ReplyLink.sameTarget(selection.target, props.traceTarget)
    ? selection
    : null;
  /** 滚动的那个元素。 */
  const scroller = react.useRef<HTMLDivElement>(null);
  /** 用户是不是在底部（上一次滚动时记下的）。 */
  const atBottom = react.useRef(true);
  /** 取更早的之前的滚动高度（取完以后保持位置）。 */
  const heightBeforeOlder = react.useRef<number | null>(null);
  /** 有没有没看到的新消息。 */
  const [unseen, setUnseen] = react.useState(false);
  /** 上一次最后一项的键：卡片决定了消失时不算有新消息。 */
  const previousLast = react.useRef<string | undefined>(undefined);
  /** 补取完成后等待本地 DOM 就绪，不能用旧位置请求滚动新目标。 */
  const [locationReady, setLocationReady] = react.useState<{ serial: number; key: string } | null>(null);
  /** 时间线。 */
  const items = react.useMemo(() => timeline.buildTimeline(props.state.messages.values(), props.approvals), [props.state.messages, props.approvals]);
  /** 最后一项的键：变了说明有新东西。 */
  const lastKey = items.at(-1)?.key;
  const { hasMore, loadingOlder, loadOlder } = props.state;
  const ensureMessages = props.state.ensureMessages;
  const origin = props.state.origin;
  const sourceKey = selected?.association.messageIds.join(',') ?? '';
  const targetKey = props.traceTarget
    ? `${props.traceTarget.bot}:${props.traceTarget.messageId}:${props.traceTarget.replyIndex}`
    : '';

  //M 所选回复需要的旧来源按明确号补取；跨视图与缺失都留下可读结果。
  react.useEffect(() => {
    if (!selected || sourceKey === '') {
      return;
    }
    let disposed = false;
    void ensureMessages(selected.association.messageIds).then((result) => {
      if (!disposed) {
        setResolution(selected.target, origin, {
          foreignIds: result.foreignIds,
          missingIds: result.missingIds,
          error: null,
        });
      }
    }).catch((error: unknown) => {
      if (!disposed) {
        const reason = error instanceof Error ? error.message : String(error);
        setResolution(selected.target, origin, { foreignIds: [], missingIds: [], error: reason });
      }
    });
    return () => {
      disposed = true;
    };
  }, [targetKey, sourceKey, ensureMessages, origin, setResolution]);

  //M 明确定位先补目标号，再让布局阶段在该列表自己的滚动容器中定位。
  react.useEffect(() => {
    if (!location || location.bot !== props.bot || location.origin !== origin || location.status !== 'pending') {
      return;
    }
    let disposed = false;
    void ensureMessages([location.messageId]).then((result) => {
      if (disposed) {
        return;
      }
      const row = result.visible.find((message) => message.id === location.messageId);
      if (!row || (location.replyIndex !== null && !row.replies[location.replyIndex])) {
        finishLocation(location.serial, 'missing', t('目标消息或回复无法在此视图定位。'));
        return;
      }
      const key = timeline.locateKey(row, location.replyIndex);
      setLocationReady({ serial: location.serial, key });
    }).catch((error: unknown) => {
      if (!disposed) {
        const reason = error instanceof Error ? error.message : String(error);
        finishLocation(location.serial, 'failed', reason);
      }
    });
    return () => {
      disposed = true;
    };
  }, [location?.serial, origin, props.bot, ensureMessages, finishLocation, t]);

  //M 内容变了：取的是更早的就保持位置；在底部就到底；不在底部就提示有新消息。
  react.useLayoutEffect(() => {
    /** 滚动元素。 */
    const element = scroller.current;
    if (!element) {
      return;
    }
    if (heightBeforeOlder.current !== null) {
      element.scrollTop += element.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
      return;
    }
    if (atBottom.current) {
      element.scrollTop = element.scrollHeight;
    } else if (previousLast.current !== lastKey) {
      setUnseen(true);
    }
    previousLast.current = lastKey;
  }, [items.length, lastKey]);

  react.useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !locationReady || locationReady.serial !== location?.serial || location.status !== 'pending') {
      return;
    }
    const target = element.querySelector<HTMLElement>(`[data-timeline-key="${locationReady.key}"]`);
    if (!target) {
      return;
    }
    const containerRect = element.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - containerRect.top + element.scrollTop;
    element.scrollTop = Math.max(0, offset - element.clientHeight / 2 + targetRect.height / 2);
    target.focus({ preventScroll: true });
    atBottom.current = false;
    finishLocation(locationReady.serial, 'located');
  }, [locationReady, location?.serial, location?.status, items, finishLocation]);

  //M 输入框长高、窗口变矮时时间线跟着变矮：原来在底部就继续贴底，别让最后几条被挡住（用户 11-06）。
  react.useEffect(() => {
    /** 滚动元素。 */
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    /** 盯着它的高度。 */
    const observer = new ResizeObserver(() => {
      if (atBottom.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** 滚动：记下在不在底部；到顶了取更早的。 */
  const onScroll = (): void => {
    /** 滚动元素。 */
    const element = scroller.current;
    if (!element) {
      return;
    }
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK;
    if (atBottom.current) {
      setUnseen(false);
    }
    if (element.scrollTop < BOTTOM_SLACK && hasMore && !loadingOlder) {
      heightBeforeOlder.current = element.scrollHeight;
      void loadOlder();
    }
  };

  /** 到底。 */
  const toBottom = (): void => {
    /** 滚动元素。 */
    const element = scroller.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    atBottom.current = true;
    setUnseen(false);
  };

  return (
    <div className="jm-timeline-wrap">
      {selected && (
        <div className="jm-reply-link-notice">
          <span className="jm-reply-link-tag">{presentation.tag(selected.target)}</span>
          <span title={selected.association.source}>{presentation.association(selected.association)}</span>
          {!resolution && <small>{t('正在补取关联消息…')}</small>}
          {resolution?.foreignIds.length ? (
            <p>
              {t('来源在另一视图：{ids}', { ids: resolution.foreignIds.join('、') })}
              <button type="button" onClick={() => locateMessage({
                bot: props.bot,
                origin: origin === 'web' ? 'other' : 'web',
                messageId: resolution.foreignIds[0]!,
                replyIndex: null,
              })}>{t('到另一视图定位')}</button>
            </p>
          ) : null}
          {resolution?.missingIds.length ? <p>{t('来源消息缺失：{ids}', { ids: resolution.missingIds.join('、') })}</p> : null}
          {resolution?.error && <p role="alert">{t('关联消息补取失败：{reason}', { reason: resolution.error })}</p>}
        </div>
      )}
      {selectionError && props.traceTarget && <p className="jm-reply-link-notice" role="alert">{selectionError}</p>}
      {location?.bot === props.bot && location.origin === origin && location.error && (
        <p className="jm-reply-link-notice" role="alert">{location.error}</p>
      )}
      <div className="jm-timeline" ref={scroller} onScroll={onScroll}>
        {hasMore && <div className="jm-timeline-more">{loadingOlder ? t('正在取更早的…') : t('往上滚看更早的')}</div>}
        {props.state.loaded && items.length === 0 && <div className="jm-empty">{props.emptyText ?? t('还没有消息，说点什么吧')}</div>}
        {items.map((item) => (
          <Item
            key={item.key}
            item={item}
            bot={props.bot}
            onOpen={props.onOpen}
            onTrace={props.onTrace}
            traceTarget={props.traceTarget}
            selection={selected}
          />
        ))}
      </div>
      {unseen && (
        <button type="button" className="jm-unseen" onClick={toBottom}>
          <icons.ArrowDownOutlined /> {t('有新消息')}
        </button>
      )}
    </div>
  );
}
