/**
 * 时间线（docs/界面/01_界面设计.md 第 7.1 节）：用户的靠右、机器人的靠左、事件行是中间的灰色小字（点了在右栏打开会话 md）。
 * 新消息来了自动到底；用户正在往上看时不打扰，显示“有新消息”。滚到顶自动取更早的，取完保持看着的位置不跳。
 * 列表用 react-virtuoso 虚拟滚动（用户 11-17：有滚动条的地方都要虚拟滚动），只画看得见的那几条。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as approvalCard from '../Approval/ApprovalCard.tsx';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as attachmentView from './AttachmentView.tsx';
import * as markdown from './Markdown.tsx';
import * as timeline from './Timeline.ts';
import * as assist from './Assist.tsx';
import * as replyLinkModule from './ReplyLink.ts';
import * as context from '../Context.ts';
import './ReplyLink.css';
import type * as types from '../Types.ts';
import type * as composer from './Composer.tsx';
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
  /** 从右键菜单选定回复目标，交给中栏输入框。 */
  onReply?: (reply: composer.ReplyDraft) => void;
  /** 将当前气泡原文引用进输入框。 */
  onQuote?: (text: string) => void;
  /** 关联来源被渠道筛掉时回到全部。 */
  onClearFilter?: () => void;
}


/** 离底部多近算“在底部”，像素。 */
const BOTTOM_SLACK = 48;

/** 虚拟列表第一项的起始下标：往上翻取到更早的就往下减，要一直是正数（react-virtuoso 的 firstItemIndex）。 */
const FIRST_INDEX = 1_000_000;

/** 看得见的上下各多画多少像素：Markdown、图片高度不定，多画一点，快速滚动时不露白。 */
const OVERSCAN_PX = 800;

/** 定位后等目标画出来再聚焦，最多等几帧。 */
const FOCUS_FRAMES = 20;


/** 时间线顶上那一行要的状态，经 react-virtuoso 的 context 传进 TimelineHead。 */
interface TimelineContext {
  /** 服务端还有没有更早的。 */
  hasMore: boolean;
  /** 正在取更早的。 */
  loadingOlder: boolean;
}


/**
 * 时间线顶上：留出上边距；还有更早的就提示往上滚。
 * 由 react-virtuoso 当 Header 画（见 TIMELINE_PARTS），context 来自 MessageList 的 headContext。
 */
function TimelineHead(props: {
  /** 有没有更早的、是不是正在取。 */
  context: TimelineContext;
}): react.JSX.Element {
  //M 取翻译函数，用于本地化“往上滚/正在取更早”提示语。
  const t = i18n.useT();

  //M 正在取就说正在取，否则提示往上滚。
  let hint = t('往上滚看更早的');
  if (props.context.loadingOlder) {
    hint = t('正在取更早的…');
  }

  return (
    <div className="jm-timeline-head">
      {props.context.hasMore && <div className="jm-timeline-more">{hint}</div>}
    </div>
  );
}


/** 时间线底部留白：让最后一条消息和输入框之间保留完整间距，不半截贴边。 */
function TimelineFoot(): react.JSX.Element {
  return <div className="jm-timeline-foot" />;
}


/** 交给 react-virtuoso 的自定义部件；放在组件外面，每次渲染是同一个对象，列表不重建。 */
const TIMELINE_PARTS: virtuoso.Components<timeline.TimelineItem, TimelineContext> = {
  Header: TimelineHead,
  Footer: TimelineFoot,
};


/** 消息动作只在右键菜单显示；Shift+F10 也可打开，不占用常驻消息空间。 */
function MessageMenu(props: {
  /** 消息动作。 */
  items: antd.MenuProps['items'];
  /** 气泡内容。 */
  children: react.ReactElement;
}): react.JSX.Element {
  const [open, setOpen] = react.useState(false);
  return (
    <antd.Dropdown menu={{ items: props.items }} trigger={['contextMenu']} open={open} onOpenChange={setOpen}>
      <div tabIndex={0} onKeyDown={(event) => {
        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
          event.preventDefault();
          setOpen(true);
        }
        if (event.key === 'Escape') {
          setOpen(false);
        }
      }}>
        {props.children}
      </div>
    </antd.Dropdown>
  );
}


function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/**
 * 单条时间线项组件：按审批、备注、分派事件、用户消息或机器人回复渲染对应气泡与同色关联标记。
 * 由 MessageList 的 renderItem 交给 react-virtuoso 渲染，并导出给 tests/Ui_ReplyLink.test.ts 逐项静态核对同色标记。
 * @param props 组件属性，含时间线项 item、机器人名 bot、预览/追踪/回复/引用回调及 traceTarget、selection 状态。
 * @returns 对应类型的单条时间线 JSX 元素。
 * 副作用：无直接副作用；点击复制、查看事件、打开会话文件或右键菜单操作时会写入剪贴板或触发相应回调。
 */
export function Item(props: {
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
  /** 右键回复动作。 */
  onReply: MessageListProps['onReply'];
  /** 插入引用动作。 */
  onQuote: MessageListProps['onQuote'];
}): react.JSX.Element {
  //M 取翻译函数、判断本条消息是否触发微信隐私打码，并构建回复关联样式器。
  const t = i18n.useT();
  const item = props.item;
  const enabled = privacy.useMask();
  const masked = enabled && privacy.wechat(item);
  const presentation = new replyLinkModule.ReplyLink(t);

  //M 判断当前项是否属于选中回复的关联来源，并生成对应的同色角标文本。
  const linked = item.kind !== 'approval' && props.selection?.target.bot === props.bot
    && props.selection.association.messageIds.includes(item.message.id);
  let linkTag = '';
  if (props.selection) {
    linkTag = presentation.tag(props.selection.target);
  }
  if (item.kind === 'approval') {
    //G 微信来源在隐私打码模式下隐藏审批正文，仅保留脱敏后的待审核占位。
    if (masked) return <div className="jm-event">{privacy.text('待审核', true)}</div>;

    return <approvalCard.ApprovalCard approval={item.approval} />;
  }
  if (item.kind === 'note') {
    let noteClass = 'jm-event jm-event-note';
    if (linked) {
      noteClass = 'jm-event jm-event-note jm-msg-linked';
    }
    //M 渲染系统备注行：若属于选中回复的关联来源则附加同色标记，并对正文脱敏。
    return (
      <div className={noteClass} data-timeline-key={item.key} tabIndex={-1}>
        {linked && <span className="jm-reply-link-tag">{linkTag}</span>}
        {privacy.text(item.text, masked)}
      </div>
    );
  }
  if (item.kind === 'event') {
    //M 渲染分派事件行：对摘要和悬停原因脱敏，未打码且有会话文件时点击在右栏预览。
    return (
      <div className="jm-event">
        <button type="button" disabled={masked || !item.dispatch.file} onClick={() => props.onOpen({ path: item.dispatch.file, name: item.dispatch.title || item.dispatch.sessionId })} title={privacy.text(item.dispatch.reason, masked)}>
          {privacy.text(timeline.getEventText(item.dispatch, t), masked)}
        </button>
      </div>
    );
  }
  let body = item.message.text;
  if (item.kind === 'reply') {
    body = item.reply.text;
  }
  //M 提取气泡正文并按当前微信打码状态脱敏，供右键复制和引用操作复用。
  const text = privacy.text(body, masked);
  const copy = (value: string): void => {
    void navigator.clipboard.writeText(value).then(
      () => antd.message.success(t('已复制')),
      () => antd.message.error(t('复制失败，请选择文字后复制')),
    );
  };
  const menuItems: antd.MenuProps['items'] = [
    {
      key: 'reply', label: t('回复'), icon: <icons.RollbackOutlined />,
      disabled: masked || !props.onReply,
      onClick: () => !masked && props.onReply?.({
        id: item.message.id,
        channel: item.message.channel,
        peer: item.message.peer,
        text: item.message.text,
      }),
    },
    {
      key: 'copy', label: t('复制'), icon: <icons.CopyOutlined />,
      onClick: () => copy(text),
    },
    {
      key: 'quote', label: t('引用'), icon: <icons.SnippetsOutlined />,
      disabled: !props.onQuote,
      onClick: () => props.onQuote?.(text),
    },
  ];
  //M 组装消息来源徽标：展示渠道名及按隐私开关脱敏后的发言人名称。
  const source = (
    <>
      <span className="jm-msg-channel" title={item.message.channel}>{item.message.channel}</span>
      <span className="jm-msg-peer" title={privacy.name(item.message.peer, masked)}>{privacy.name(item.message.peer, masked)}</span>
    </>
  );
  if (item.kind === 'user') {
    /** 还没进会话时的小字。 */
    //M 把尚未分派或排队中的消息状态转成元信息提示文案。
    const pending = timeline.getPendingText(item.message.status, t);
    let userClass = 'jm-msg jm-msg-user';
    if (linked) {
      userClass = 'jm-msg jm-msg-user jm-msg-linked';
    }
    //M 渲染用户消息气泡：展示关联标记、来源、发送时间及排队提示。
    return (
      <MessageMenu items={menuItems}>
      <div className={userClass} data-timeline-key={item.key} tabIndex={-1}>
        <div className="jm-msg-meta">
          {linked && <span className="jm-reply-link-tag">{linkTag}</span>}
          {source}
          <span>{timeline.formatTime(item.at)}</span>
          {pending && <span className="jm-msg-pending">{pending}</span>}

        </div>
        <div className="jm-bubble jm-bubble-user">
          {item.message.replyTo && (
            //M 存在被回复的原消息时，按隐私开关脱敏后渲染引用人名和正文摘要。
            <blockquote className="jm-message-quote">
              <strong>{privacy.name(item.message.replyTo.peer, masked)} · #{item.message.replyTo.id}</strong>
              <span>{privacy.text(item.message.replyTo.text, masked)}</span>
            </blockquote>
          )}
          {item.message.reply_to != null && !item.message.replyTo && (
            <blockquote className="jm-message-quote">{t('引用消息')} #{item.message.reply_to}</blockquote>
          )}
          <markdown.Markdown
            //M 按微信打码状态处理用户消息正文后交给 Markdown 渲染，点击附件在右栏打开。
            text={privacy.text(item.message.text, masked)}
            onOpen={props.onOpen}
          />
        </div>
        {!masked && <assist.Reactions messageId={item.message.id} />}
      </div>
      </MessageMenu>
    );
  }
  /** 前台、后台各用了多久；旧回话没有分开记录时，整段算前台。 */
  let frontMs = item.reply.frontMs;
  if (frontMs == null && item.reply.workMs == null) {
    frontMs = item.reply.at - item.message.createdAt;
  }
  //M 把前台等待与后台工作耗时格式化为可读时长，用于气泡元信息提示。
  const elapsed = timeline.formatFrontWorkElapsed(frontMs, item.reply.workMs, t);
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
  //M 把查看事件和查看会话接到当前回复的菜单。
  menuItems.push(
    { type: 'divider' },
    {
      key: 'trace',
      'data-action': 'trace',
      label: t('查看事件'),
      onClick: () => props.onTrace(traceTarget, item.reply),
    },
    {
      //M 会话标题按隐私开关脱敏后作为“查看会话”菜单项标签，缺标题时使用默认文案。
      key: 'session', label: privacy.name(item.reply.session.title, masked) || t('查看会话'),
      disabled: masked || !item.reply.session.file,
      onClick: () => props.onOpen({ path: item.reply.session.file, name: item.reply.session.title }),
    },
  );
  let botClass = 'jm-msg jm-msg-bot';
  if (selected) {
    botClass = 'jm-msg jm-msg-bot jm-msg-traced jm-msg-linked';
  }
  let speech = '';
  if (item.message.channel === 'voice' && 'spoken' in item.reply) {
    if (item.reply.spoken === true) {
      speech = t('已播报');
    }
    if (item.reply.spoken === false) {
      speech = t('未播报');
    }
  }
  //M 渲染机器人回复气泡：展示时间戳、耗时、代际标识及脱敏后的 Markdown 回复正文。
  return (
    <MessageMenu items={menuItems}>
    <div
      className={botClass}
      data-timeline-key={item.key}
      data-msg-id={item.message.id}
      data-reply-index={item.replyIndex}
      tabIndex={-1}
    >
      <div className="jm-msg-meta">
        {selected && <span className="jm-reply-link-tag">{linkTag}</span>}
        <span className="jm-msg-source">{props.bot}</span>
        <span>{timeline.formatTime(item.at)}</span>
        {elapsed && <span className="jm-msg-elapsed" title={t('前台从收到你那条消息到交出或说完；后台从接手到这条回复')}>{elapsed}</span>}
        {source}
        {speech !== '' && <span className="jm-msg-source">{speech}</span>}
        <span className="jm-reply-generation" title={presentation.generationTitle(item.reply.generation)}>
          {presentation.generation(item.reply.generation)}
        </span>
      </div>
      <div
        className="jm-bubble jm-bubble-bot jm-bubble-inspect"
        //M 同一消息可有多条回复，沿用时间线键定位可直接点击的正文。
        data-trace-reply={item.key}
        onClick={inspectBody}
      >
        <markdown.Markdown text={privacy.text(item.reply.text, masked)} onOpen={props.onOpen} />
        {!masked && item.reply.attachments
          .filter((attachment) => !item.reply.text.includes(attachment.path))
          .map((attachment) => (
            <attachmentView.AttachmentView key={attachment.path} attachment={attachment} onOpen={props.onOpen} />
          ))}
      </div>
      {!masked && item.replyIndex === item.message.replies.length - 1 && <assist.Asks bot={item.message.bot} messageId={item.message.id} />}
    </div>
    </MessageMenu>
  );
}


/**
 * 聊天消息虚拟滚动时间线组件：负责上滑加载更早消息、新消息自动贴底、关联来源补取与定位聚焦。
 * @param props 组件属性，含消息状态 state、机器人名 bot、打开文件/追踪/回复/引用/清筛选回调及待审核列表。
 * @returns 包含关联来源提示条、虚拟列表或空状态以及新消息浮标的 JSX 元素。
 * 副作用：按追踪目标与定位请求触发消息补取（ensureMessages）、更新 Store 解析与定位状态，并执行列表滚动和 DOM 聚焦。
 */
export function MessageList(props: MessageListProps): react.JSX.Element {
  //M 获取翻译函数、隐私打码开关以及回复关联与定位相关的 Store 状态和动作。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const selection = context.useUi((state) => state.replySelection);
  const selectionError = context.useUi((state) => state.replySelectionError);
  const resolution = context.useUi((state) => state.sourceResolutions[props.state.origin]);
  const setResolution = context.useUi((state) => state.setSourceResolution);
  const locateMessage = context.useUi((state) => state.locateMessage);
  const location = context.useUi((state) => state.chatLocation);
  const finishLocation = context.useUi((state) => state.finishLocation);

  //M 构造回复关联标记样式器，并校对 Store 里的关联选择是否仍对应当前追踪目标。
  const presentation = react.useMemo(() => new replyLinkModule.ReplyLink(t), [t]);
  let selected: storeModule.ReplySelection | null = null;
  if (selection && replyLinkModule.ReplyLink.sameTarget(selection.target, props.traceTarget)) {
    selected = selection;
  }
  /** 虚拟列表的句柄：滚到某一项、到底。 */
  const list = react.useRef<virtuoso.VirtuosoHandle>(null);
  /** 滚动的那个元素（react-virtuoso 经 scrollerRef 交出来）：定位后在里面找目标聚焦。 */
  const scroller = react.useRef<HTMLElement | null>(null);
  /** 用户是不是在底部（react-virtuoso 的 atBottomStateChange 记下的）。 */
  const atBottom = react.useRef(true);
  /** 上一次的第一项和它在虚拟列表里的下标：往上翻时前面多出几项，下标就减几，看着的位置不跳。 */
  const [head, setHead] = react.useState<{ key: string | undefined; index: number }>({
    key: undefined,
    index: FIRST_INDEX,
  });
  /** 有没有没看到的新消息。 */
  const [unseen, setUnseen] = react.useState(false);
  /** 上一次最后一项的键：卡片决定了消失时不算有新消息。 */
  const previousLast = react.useRef<string | undefined>(undefined);
  /** 补取完成后等待本地 DOM 就绪，不能用旧位置请求滚动新目标。 */
  const [locationReady, setLocationReady] = react.useState<{ serial: number; key: string } | null>(null);
  /** 时间线。 */
  //M 把收发消息、分派事件与待审核卡片合并构建为有序时间线列表供虚拟滚动使用。
  const items = react.useMemo(() => timeline.buildTimeline(props.state.messages.values(), props.approvals), [props.state.messages, props.approvals]);
  /** 最后一项的键：变了说明有新东西。 */
  const lastKey = items.at(-1)?.key;
  const { hasMore, loadingOlder, loadOlder } = props.state;
  const ensureMessages = props.state.ensureMessages;
  const origin = props.state.origin;
  const sourceKey = selected?.association.messageIds.join(',') ?? '';
  let targetKey = '';
  if (props.traceTarget) {
    targetKey = `${props.traceTarget.bot}:${props.traceTarget.messageId}:${props.traceTarget.replyIndex}`;
  }

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
      //M 补取关联来源出错时提取可读异常文本写入 Store，以便界面展示失败原因。
      if (!disposed) {
        setResolution(selected.target, origin, { foreignIds: [], missingIds: [], error: getErrorText(error) });
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
      //M 确认目标消息已出现在当前视图后生成 timelineKey，驱动后续滚到可视区并聚焦。
      const key = timeline.getLocateKey(row, location.replyIndex);
      setLocationReady({ serial: location.serial, key });
    }).catch((error: unknown) => {
      if (!disposed) {
        finishLocation(location.serial, 'failed', getErrorText(error));
      }
    });
    return () => {
      disposed = true;
    };
  }, [location?.serial, origin, props.bot, ensureMessages, finishLocation, t]);

  //M 往上翻取到了更早的：原来的第一项现在排第几，前面就多了几项，虚拟列表的起始下标减掉这么多，看着的位置不跳。
  //  在渲染时算（React 文档“随 props 调整 state”的写法，不放 effect），这样同一次渲染里 data 和 firstItemIndex 对得上。
  const firstKey = items[0]?.key;
  let firstItemIndex = head.index;
  if (head.key !== firstKey) {
    /** 原来的第一项在新列表里的位置；找不到（换了筛选、第一项被删）是 -1，不动下标。 */
    const shifted = items.findIndex((item) => item.key === head.key);
    if (shifted > 0) {
      firstItemIndex = head.index - shifted;
    }

    setHead({ key: firstKey, index: firstItemIndex });
  }

  //M 最后一项换了（来了新东西）：用户不在底部就提示有新消息；在底部由 react-virtuoso 的 followOutput 自己跟到底。
  react.useEffect(() => {
    if (previousLast.current === lastKey) return;

    previousLast.current = lastKey;
    if (atBottom.current) return;

    setUnseen(true);
  }, [lastKey]);

  //M 定位：补取完成后在时间线里找到目标的下标，滚到正中，等它画出来再聚焦。
  react.useEffect(() => {
    if (!locationReady) return;

    if (locationReady.serial !== location?.serial) return;

    if (location.status !== 'pending') return;

    /** 目标在时间线里的下标（react-virtuoso 的 scrollToIndex 按 data 的下标，从 0 起，不加 firstItemIndex）。 */
    const index = items.findIndex((item) => item.key === locationReady.key);
    if (index < 0) return;

    const handle = list.current;
    if (!handle) return;

    const scrollArgs: virtuoso.FlatIndexLocationWithAlign = {
      index,
      align: 'center',
    };

    handle.scrollToIndex(scrollArgs);

    //M 虚拟列表滚过去以后才把目标画出来：逐帧找，找到就聚焦，最多等 FOCUS_FRAMES 帧。
    /** 已经等了几帧。 */
    let frames = 0;
    /** 要聚焦的那一项的选择器，data-timeline-key 打在 Item 的用户话、提示和回复上。 */
    const selector = `[data-timeline-key="${locationReady.key}"]`;
    const focusTarget = (): void => {
      const target = scroller.current?.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      frames += 1;
      if (frames >= FOCUS_FRAMES) return;

      requestAnimationFrame(focusTarget);
    };

    requestAnimationFrame(focusTarget);
    atBottom.current = false;
    finishLocation(locationReady.serial, 'located');
  }, [locationReady, location?.serial, location?.status, items, finishLocation]);

  /**
   * react-virtuoso 报在不在底部（离底 BOTTOM_SLACK 像素内算在底部）：到底了就收起“有新消息”。
   * 输入框长高、窗口变矮、最后一条的图片加载变高时，原来在底部的由 followOutput 继续贴底（用户 11-06）。
   */
  const onAtBottom = (bottom: boolean): void => {
    atBottom.current = bottom;
    if (!bottom) return;

    setUnseen(false);
  };

  /** 滚到最前面：还有更早的、又没在取，就取更早的一页。 */
  const onStart = (): void => {
    if (!hasMore) return;

    if (loadingOlder) return;

    void loadOlder();
  };

  /** react-virtuoso 交出滚动元素；它的类型还带着 Window（用整页滚动时），这里只收元素。 */
  const onScroller = (element: HTMLElement | Window | null): void => {
    if (element instanceof HTMLElement) {
      scroller.current = element;
      return;
    }
    scroller.current = null;
  };

  /** 到底。 */
  const toBottom = (): void => {
    const bottomArgs: virtuoso.FlatIndexLocationWithAlign = {
      index: 'LAST',
      align: 'end',
    };

    list.current?.scrollToIndex(bottomArgs);
    atBottom.current = true;
    setUnseen(false);
  };

  /** 时间线顶上那一行的状态，交给 TimelineHead。 */
  const headContext: TimelineContext = {
    hasMore,
    loadingOlder,
  };

  /** 一项怎么画：外面包一层 jm-timeline-item，留出左右边距和项与项之间的空隙（原来是滚动容器的 padding 和 gap）。 */
  const renderItem = (_index: number, item: timeline.TimelineItem): react.JSX.Element => (
    <div className="jm-timeline-item">
      <Item
        item={item}
        bot={props.bot}
        onOpen={props.onOpen}
        onTrace={props.onTrace}
        traceTarget={props.traceTarget}
        selection={selected}
        onReply={props.onReply}
        onQuote={props.onQuote}
      />
    </div>
  );

  //M 还没取到第一页：先占住位置，不画列表。
  let body = <div className="jm-timeline" />;

  //M 取到了但一条都没有：空提示居中。
  if (props.state.loaded && items.length === 0) {
    body = (
      <div className="jm-timeline jm-timeline-empty">
        <div className="jm-empty">{props.emptyText ?? t('还没有消息，说点什么吧')}</div>
      </div>
    );
  }

  //M 有内容：虚拟列表。一开始停在最后一条；在底部时新来的跟到底；滚到最前面取更早的。
  if (props.state.loaded && items.length > 0) {
    body = (
      <virtuoso.Virtuoso
        ref={list}
        className="jm-timeline"
        data={items}
        context={headContext}
        components={TIMELINE_PARTS}
        computeItemKey={(_index, item) => item.key}
        itemContent={renderItem}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        followOutput="auto"
        atBottomThreshold={BOTTOM_SLACK}
        atBottomStateChange={onAtBottom}
        startReached={onStart}
        increaseViewportBy={OVERSCAN_PX}
        scrollerRef={onScroller}
      />
    );
  }

  let locateLabel = t('到另一视图定位');
  if (props.onClearFilter) {
    locateLabel = t('查看全部渠道');
  }
  return (
    <div className="jm-timeline-wrap">
      {selected && (
        //M 选中回复关联时展示同色角标与来源说明，方便核对这条回复关联了哪些消息。
        <div className="jm-reply-link-notice">
          <span className="jm-reply-link-tag">{presentation.tag(selected.target)}</span>
          <span title={selected.association.source}>{presentation.association(selected.association)}</span>
          {!resolution && <small>{t('正在补取关联消息…')}</small>}
          {(resolution?.foreignIds.length ?? 0) > 0 && (
            <p>
              {t('来源不在当前筛选：{ids}', { ids: resolution!.foreignIds.join('、') })}
              <button type="button" onClick={() => {
                if (props.onClearFilter) {
                  props.onClearFilter();
                  return;
                }
                let targetOrigin: 'web' | 'other' = 'web';
                if (origin === 'web') {
                  targetOrigin = 'other';
                }
                locateMessage({
                  bot: props.bot,
                  origin: targetOrigin,
                  messageId: resolution!.foreignIds[0]!,
                  replyIndex: null,
                });
              }}>{locateLabel}</button>
            </p>
          )}
          {(resolution?.missingIds.length ?? 0) > 0 && <p>{t('来源消息缺失：{ids}', { ids: resolution!.missingIds.join('、') })}</p>}
          {
            //M 补取关联消息失败时把错误原因脱敏后提示在顶部关联栏。
            resolution?.error && <p role="alert">{t('关联消息补取失败：{reason}', { reason: privacy.text(resolution.error, masked) })}</p>
          }
        </div>
      )}
      {
        //M 回复关联解析出错且仍有追踪目标时，按隐私开关脱敏并提示报错信息。
        selectionError && props.traceTarget && <p className="jm-reply-link-notice" role="alert">{privacy.text(selectionError, masked)}</p>
      }
      {location?.bot === props.bot && location.origin === origin && location.error && (
        //M 当前视图的消息定位失败时，按隐私开关脱敏后展示定位错误提示。
        <p className="jm-reply-link-notice" role="alert">{privacy.text(location.error, masked)}</p>
      )}
      {body}
      {unseen && (
        <button type="button" className="jm-unseen" onClick={toBottom}>
          <icons.ArrowDownOutlined /> {t('有新消息')}
        </button>
      )}
    </div>
  );
}
