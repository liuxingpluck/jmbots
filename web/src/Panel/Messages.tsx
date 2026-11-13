/**
 * 右栏的“消息”（docs/界面/01_界面设计.md 第 9 节）：飞书、微信等渠道来的消息和回复，和中栏时间线一样的样子。
 * 中栏只放网页里的对话，渠道的都在这里，免得混。能按渠道筛（渠道从取到的消息里来），往上滚看更早的。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as messageList from '../Chat/MessageList.tsx';
import * as timeline from '../Chat/Timeline.ts';
import * as useMessagesModule from '../Chat/useMessages.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/** 筛选项“全部”。 */
const ALL = '全部';


/** 消息。 */
export function Messages(): react.JSX.Element {
  const t = i18n.useT();
  /** 正在聊的机器人。 */
  const bot = context.useUi((state) => state.currentBot);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 外部渠道的回复和中栏使用同一个精确追踪入口。 */
  const openTrace = context.useUi((state) => state.openTrace);
  const traceTarget = context.useUi((state) => state.traceTarget);
  const location = context.useUi((state) => state.chatLocation);
  /** 别的渠道的消息。 */
  const state = useMessagesModule.useMessages(bot, 'other');
  /** 只看哪个渠道。 */
  const [channel, setChannel] = react.useState(ALL);
  react.useEffect(() => {
    if (location?.origin === 'other' && location.bot === bot) {
      setChannel(ALL);
    }
  }, [location?.serial, bot]);
  /** 取到的消息里有哪些渠道。 */
  const channels = react.useMemo(() => [...new Set([...state.messages.values()].map((message) => timeline.channelLabel(message.channel, message.source, t)))].sort(), [state.messages, t]);
  /** 筛过的状态。 */
  const shown = react.useMemo(
    () => (channel === ALL ? state : { ...state, messages: new Map([...state.messages].filter(([, message]) => timeline.channelLabel(message.channel, message.source, t) === channel)) }),
    [state, channel, t],
  );

  /** 在预览里打开一个文件。 */
  const onOpen = react.useCallback((target: { path: string; name: string }) => openPanel('preview', target), [openPanel]);

  if (!bot) {
    return <div className="jm-empty">{t('还没有机器人')}</div>;
  }
  return (
    <div className="jm-panel-messages">
      {channels.length > 1 && (
        <antd.Segmented className="jm-channel-filter" size="small" value={channel} options={[{ value: ALL, label: t('全部') }, ...channels.map((label) => ({ value: label, label }))]} onChange={(value) => setChannel(String(value))} />
      )}
      <messageList.MessageList
        state={shown}
        bot={bot}
        onOpen={onOpen}
        onTrace={openTrace}
        traceTarget={traceTarget}
        emptyText={t('还没有别的渠道来的消息')}
      />
    </div>
  );
}
