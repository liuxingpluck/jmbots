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
import * as privacy from '../Privacy/Mask.tsx';


/** 筛选项“全部”。 */
const ALL = '全部';


/**
 * 右栏“消息”标签页：展示飞书、微信等外部渠道的消息时间线，支持按渠道筛选并在定位时重置筛选。
 * @returns 渠道筛选栏与外部渠道消息时间线；未选中机器人时返回空状态提示。
 * 副作用：订阅当前机器人、外部渠道消息列表、追踪跳转与定位状态，支持点击打开文件预览或事件追踪。
 */
export function Messages(): react.JSX.Element {
  //M 取当前语言翻译函数与演示打码开关状态。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 正在聊的机器人。 */
  //M 订阅当前选中的机器人与打开文件预览动作。
  const bot = context.useUi((state) => state.currentBot);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 外部渠道的回复和中栏使用同一个精确追踪入口。 */
  //M 订阅事件追踪跳转入口、当前追踪目标及消息定位状态。
  const openTrace = context.useUi((state) => state.openTrace);
  const traceTarget = context.useUi((state) => state.traceTarget);
  const location = context.useUi((state) => state.chatLocation);
  /** 别的渠道的消息。 */
  //M 拉取并订阅当前机器人来自网页以外渠道的消息集合。
  const state = useMessagesModule.useMessages(bot, 'other');
  /** 只看哪个渠道。 */
  const [channel, setChannel] = react.useState(ALL);
  react.useEffect(() => {
    if (location?.origin === 'other' && location.bot === bot) {
      setChannel(ALL);
    }
  }, [location?.serial, bot]);
  /** 取到的消息里有哪些渠道。 */
  //M 从已取到的外部消息汇总去重并排序后的渠道标签列表，用于生成筛选分段。
  const channels = react.useMemo(() => [...new Set([...state.messages.values()].map((message) => timeline.getChannelLabel(message.channel, message.source, t)))].sort(), [state.messages, t]);
  /** 筛过的状态。 */
  const shown = react.useMemo(() => {
    if (channel === ALL) return state;

    //M 按所选渠道标签过滤消息映射表，只保留命中该渠道的条目。
    const entries = [...state.messages].filter(([, message]) => timeline.getChannelLabel(message.channel, message.source, t) === channel);
    return { ...state, messages: new Map(entries) };
  }, [state, channel, t]);

  /** 在预览里打开一个文件。 */
  const onOpen = react.useCallback((target: { path: string; name: string }) => openPanel('preview', target), [openPanel]);

  if (!bot) {
    return <div className="jm-empty">{t('还没有机器人')}</div>;
  }
  return (
    <div className="jm-panel-messages">
      {channels.length > 1 && (
        //M 存在多个外部渠道时显示分段筛选条，并按演示开关脱敏渠道名称。
        <antd.Segmented className="jm-channel-filter" size="small" value={channel} options={[{ value: ALL, label: t('全部') }, ...channels.map((label) => ({ value: label, label: privacy.text(label, masked) }))]} onChange={(value) => setChannel(String(value))} />
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
