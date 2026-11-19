/**
 * 中栏：聊天（docs/界面/01_界面设计.md 第 7 节）。上面一行是在和谁聊；中间是时间线；下面是输入框（Tiptap、附件、斜杠命令）。
 * 审核卡片（第 8 节）排在时间线里，不挡消息，翻上去也能点；有待审核时上面一行有个入口，点了在右栏集中看。? 打开快捷键帮助（输入框里打字时不触发）。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as channelTabs from './ChannelTabs.tsx';
import * as composer from './Composer.tsx';
import * as guide from '../Guide/Guide.tsx';
import { CHAT_STEPS } from '../Guide/steps-chat.ts';
import * as helpModal from './HelpModal.tsx';
import * as mascot from '../Mascot/Mascot.tsx';
import * as messageList from './MessageList.tsx';
import * as privacy from '../Privacy/Mask.tsx';
import * as progressBar from './ProgressBar.tsx';
import * as voiceBar from './VoiceBar.tsx';
import * as quickPages from '../Layout/QuickPages.tsx';
import * as replyLinkModule from './ReplyLink.ts';
import * as useMessagesModule from './useMessages.ts';


/**
 * 按键是不是打在能输入的地方（输入框、文本框、可编辑区域）。
 * @param target 事件的目标。
 */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}


/**
 * 中栏聊天区域组件：串联渠道筛选栏、消息时间线、进度条、输入框与快捷键帮助弹窗。
 * @returns 中栏聊天界面 JSX 元素。
 * 副作用：订阅消息与 assist 轮询、加载/取消回复关联证据、监听 popstate 与全局键盘事件，并在切换视图时写入 URL 查询串。
 */
export function ChatArea(): react.JSX.Element {
  //M 取翻译函数和当前界面语言，用于中栏文案本地化及引导组件切换语言。
  const t = i18n.useT();
  const language = context.useUi((state) => state.language);
  /** 正在聊的机器人。 */
  //M 读取当前机器人名和全部机器人名单，驱动时间线数据源和输入框切换弹窗。
  const current = context.useUi((state) => state.currentBot);
  const botNames = context.useUi((state) => state.bots.map((item) => item.name).join('\n'));
  /** 连得上吗。 */
  //M 读取后端连通状态，断连时显示提示并禁用发送按钮。
  const online = context.useUi((state) => state.online) !== false;
  /** 几个界面动作。 */
  //M 取切换机器人与打开右栏的全局动作，分发给输入框、时间线和顶栏按钮。
  const selectBot = context.useUi((state) => state.selectBot);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 追踪与文件预览分别保存，查看事件不会关闭已打开的文件。 */
  //M 取事件追踪动作与当前选中回复目标，供时间线高亮关联来源并触发证据加载。
  const openTrace = context.useUi((state) => state.openTrace);
  const traceTarget = context.useUi((state) => state.traceTarget);
  /** 聊天和事件面板共享轻量关联；历史恢复后按需重新读取，不依赖右栏是否正打开。 */
  //M 取得 Store 实例并构造回复证据加载器，在追踪目标变化时按需补拉关联来源。
  const uiStore = context.useUiStore();
  const evidenceLoader = react.useMemo(() => new replyLinkModule.ReplyEvidenceLoader(uiStore), [uiStore]);
  let traceKey = '';
  if (traceTarget) {
    traceKey = `${traceTarget.bot}:${traceTarget.messageId}:${traceTarget.replyIndex}`;
  }
  react.useEffect(() => {
    //M 追踪目标变化时拉取关联回复的证据摘要，切换目标或卸载时取消在途请求。
    void evidenceLoader.load(traceTarget);
    return () => evidenceLoader.cancel();
  }, [evidenceLoader, traceKey]);
  /** 右栏开着没有、上次看的是哪一页（顶上的按钮开关右栏，用户 11-06：不用翻回去点图片）。 */
  //M 读取右栏开关状态、当前页签及开关与设置动作，控制顶栏右栏切换按钮与输入命令。
  const panelOpen = context.useUi((state) => state.panelOpen);
  const panelTab = context.useUi((state) => state.panelTab);
  const closePanel = context.useUi((state) => state.closePanel);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);
  /** 这个机器人还在等决定的命令。 */
  //M 读取全局待审核列表并按当前机器人过滤，展示在时间线和顶栏提醒按钮上。
  const allApprovals = context.useUi((state) => state.approvals);
  const approvals = react.useMemo(() => allApprovals.filter((item) => item.bot === current), [allApprovals, current]);
  /** 统一时间线按渠道与具体聊天筛选，同步网址查询串；回复目标与当前机器人绑定。 */
  //M 读取隐私打码开关，筛选横幅展示聊天名称时据此决定是否脱敏。
  const masked = privacy.useMask();
  const [view, setView] = react.useState<channelTabs.ChannelViewState>(() => {
    //M 初始化时从地址栏查询串恢复渠道和聊天筛选条件，并生成展示用的短标签。
    const initial = channelTabs.getChannelViewFromUrl();
    return {
      channel: initial.channel,
      chat: initial.chat,
      chatLabel: channelTabs.getChatShortLabel(initial.chat, initial.channel),
    };
  });
  const applyView = react.useCallback((next: channelTabs.ChannelViewState): void => {
    //M 切换渠道或聊天筛选时同步写入地址栏查询串，保持刷新后视图可还原。
    setView(next);
    channelTabs.writeChannelViewToUrl(next.channel, next.chat);
  }, []);
  react.useEffect(() => {
    const onPopState = (): void => {
      //M 浏览器前进或后退时重新从地址栏读取筛选条件并生成短标签，使时间线同步回退。
      const next = channelTabs.getChannelViewFromUrl();
      setView({
        channel: next.channel,
        chat: next.chat,
        chatLabel: channelTabs.getChatShortLabel(next.chat, next.channel),
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const [reply, setReply] = react.useState<composer.ReplyDraft | null>(null);
  const [quote, setQuote] = react.useState<{ text: string } | null>(null);
  //M 按当前机器人与渠道聊天筛选条件订阅并拉取统一时间线消息流。
  const messages = useMessagesModule.useMessages(current, 'web', { channel: view.channel, chat: view.chat, unified: true });
  react.useEffect(() => setReply(null), [current]);
  //M 检查已挂载插件清单，决定是否显示进度条。
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const progressEnabled = api.isPluginMounted(mountedPlugins, 'progress', false);
  /** 帮助开着没有。 */
  const [helpOpen, setHelpOpen] = react.useState(false);

  react.useEffect(() => {
    /** ? 打开帮助（不在输入框里时）。 */
    const onKey = (event: KeyboardEvent): void => {
      //G 仅在焦点不在输入框或可编辑区域时响应 ? 快捷键，避免干扰正常输入。
      if (event.key === '?' && !isTyping(event.target)) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 在右栏打开一个文件。 */
  const onOpen = react.useCallback((target: { path: string; name: string }) => openPanel('preview', target), [openPanel]);

  //M 右栏按钮文案与空状态展示先在 return 前定好，保持 JSX 清晰。
  let panelIcon = <icons.MenuFoldOutlined />;
  let panelTitle = t('打开右栏：预览、工作区、消息、待审核、记忆、详情');
  let panelLabel = t('右栏');
  if (panelOpen) {
    panelIcon = <icons.MenuUnfoldOutlined />;
    panelTitle = t('收起右栏');
    panelLabel = t('收起右栏');
  }
  let emptyText = t('连不上后端，等它回来');
  if (online) {
    emptyText = t('后端还没有机器人');
  }
  let body = (
    <div className="jm-chat-body">
      <div className="jm-empty">{emptyText}</div>
    </div>
  );
  if (current) {
    let botList: string[] = [];
    if (botNames) {
      botList = botNames.split('\n');
    }
    let composerView: { channel: string; chat?: string } | undefined;
    let viewBanner = '';
    if (view.channel) {
      const channelName = channelTabs.getChannelName(view.channel, t);
      if (view.chat) {
        composerView = { channel: view.channel, chat: view.chat };
        const shortLabel = view.chatLabel || channelTabs.getChatShortLabel(view.chat, view.channel);
        viewBanner = t('正在看：{channel} · {chat}，机器人会知道', { channel: channelName, chat: privacy.name(shortLabel, masked) });
      }
      if (!view.chat) {
        composerView = { channel: view.channel };
        viewBanner = t('正在看：{channel} · 全部聊天，机器人会知道', { channel: channelName });
      }
    }
    body = (
      <>
        <channelTabs.ChannelTabs bot={current} value={view} onChange={applyView} />
        <messageList.MessageList
          key={`${current}:${view.channel}:${view.chat}`}
          state={messages}
          onReply={setReply}
          onQuote={(text) => setQuote({ text })}
          onClearFilter={() => applyView({ channel: '', chat: '', chatLabel: '' })}
          bot={current}
          onOpen={onOpen}
          onTrace={openTrace}
          traceTarget={traceTarget}
          approvals={approvals}
        />
        {progressEnabled && <progressBar.ProgressBar bot={current} />}
        <voiceBar.VoiceBar bot={current} online={online} />
        <composer.Composer
          bot={current}
          online={online}
          bots={botList}
          selectBot={selectBot}
          openSettings={() => setSettingsOpen(true)}
          openHelp={() => setHelpOpen(true)}
          reply={reply}
          quote={quote}
          onCancelReply={() => setReply(null)}
          onSent={messages.refresh}
          view={composerView}
          viewBanner={viewBanner}
          onClearView={() => applyView({ channel: '', chat: '', chatLabel: '' })}
        />
      </>
    );
  }
  return (
    <div className="jm-chat">
      <header className="jm-chat-head">
        {/* 头像、名字、状态和左栏的机器人卡片重复，用户 11-06 要删掉（原话第 54 节）；只在窄窗口一次一栏时看得见这里，留一个名字。 */}
        <span className="jm-chat-title jm-narrow-only">{current ?? t('还没有机器人')}</span>
        <mascot.Mascot bot={current ?? undefined} />
        <div className="jm-chat-head-right">
          <quickPages.QuickPages />
          <antd.Button
            size="small"
            type="text"
            className="jm-chat-panel-toggle"
            icon={panelIcon}
            title={panelTitle}
            onClick={() => {
              if (panelOpen) {
                closePanel();
                return;
              }
              openPanel(panelTab);
            }}
          >
            {panelLabel}
          </antd.Button>
          <guide.Guide steps={CHAT_STEPS} language={language} />
          {approvals.length > 0 && (
            <button type="button" className="jm-chat-approvals" onClick={() => openPanel('approvals')}>
              {t('待审核 {count}', { count: approvals.length })}
            </button>
          )}
        </div>
      </header>
      {body}
      <helpModal.HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
