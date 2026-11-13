/**
 * 中栏：聊天（docs/界面/01_界面设计.md 第 7 节）。上面一行是在和谁聊；中间是时间线；下面是输入框（Tiptap、附件、斜杠命令）。
 * 审核卡片（第 8 节）排在时间线里，不挡消息，翻上去也能点；有待审核时上面一行有个入口，点了在右栏集中看。? 打开快捷键帮助（输入框里打字时不触发）。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as composer from './Composer.tsx';
import * as helpModal from './HelpModal.tsx';
import * as mascot from '../Mascot/Mascot.tsx';
import * as messageList from './MessageList.tsx';
import * as progressBar from './ProgressBar.tsx';
import * as replyLinkModule from './ReplyLink.ts';
import * as useMessagesModule from './useMessages.ts';


/**
 * 按键是不是打在能输入的地方（输入框、文本框、可编辑区域）。
 * @param target 事件的目标。
 */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}


/** 中栏。 */
export function ChatArea(): react.JSX.Element {
  const t = i18n.useT();
  /** 正在聊的机器人。 */
  const current = context.useUi((state) => state.currentBot);
  const botNames = context.useUi((state) => state.bots.map((item) => item.name).join('\n'));
  /** 连得上吗。 */
  const online = context.useUi((state) => state.online) !== false;
  /** 几个界面动作。 */
  const selectBot = context.useUi((state) => state.selectBot);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 追踪与文件预览分别保存，查看事件不会关闭已打开的文件。 */
  const openTrace = context.useUi((state) => state.openTrace);
  const traceTarget = context.useUi((state) => state.traceTarget);
  /** 聊天和事件面板共享轻量关联；历史恢复后按需重新读取，不依赖右栏是否正打开。 */
  const uiStore = context.useUiStore();
  const evidenceLoader = react.useMemo(() => new replyLinkModule.ReplyEvidenceLoader(uiStore), [uiStore]);
  const traceKey = traceTarget
    ? `${traceTarget.bot}:${traceTarget.messageId}:${traceTarget.replyIndex}`
    : '';
  react.useEffect(() => {
    void evidenceLoader.load(traceTarget);
    return () => evidenceLoader.cancel();
  }, [evidenceLoader, traceKey]);
  /** 右栏开着没有、上次看的是哪一页（顶上的按钮开关右栏，用户 11-06：不用翻回去点图片）。 */
  const panelOpen = context.useUi((state) => state.panelOpen);
  const panelTab = context.useUi((state) => state.panelTab);
  const closePanel = context.useUi((state) => state.closePanel);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);
  /** 这个机器人还在等决定的命令。 */
  const allApprovals = context.useUi((state) => state.approvals);
  const approvals = react.useMemo(() => allApprovals.filter((item) => item.bot === current), [allApprovals, current]);
  /** 时间线的数据：只放网页里的对话，别的渠道在右栏“消息”。 */
  const messages = useMessagesModule.useMessages(current, 'web');
  /** 帮助开着没有。 */
  const [helpOpen, setHelpOpen] = react.useState(false);

  react.useEffect(() => {
    /** ? 打开帮助（不在输入框里时）。 */
    const onKey = (event: KeyboardEvent): void => {
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

  return (
    <div className="jm-chat">
      <header className="jm-chat-head">
        {/* 头像、名字、状态和左栏的机器人卡片重复，用户 11-06 要删掉（原话第 54 节）；只在窄窗口一次一栏时看得见这里，留一个名字。 */}
        <span className="jm-chat-title jm-narrow-only">{current ?? t('还没有机器人')}</span>
        <mascot.Mascot bot={current ?? undefined} />
        <antd.Button
          className="jm-chat-refresh"
          size="small"
          type="text"
          icon={<icons.ReloadOutlined />}
          title={t('刷新网页：换了版本后输入框里有字时不会自动刷新')}
          onClick={() => {
            //G 输入框里还有没发的字：先问，免得刷新把它丢了。
            if (document.querySelector('.jm-editor')?.textContent?.trim() && !window.confirm(t('输入框里还有没发的字，刷新会丢掉，确定刷新吗？'))) {
              return;
            }
            window.location.reload();
          }}
        >
          {t('刷新')}
        </antd.Button>
        <antd.Button
          size="small"
          type="text"
          className="jm-chat-panel-toggle"
          icon={panelOpen ? <icons.MenuUnfoldOutlined /> : <icons.MenuFoldOutlined />}
          title={panelOpen ? t('收起右栏') : t('打开右栏：预览、工作区、消息、待审核、记忆、详情')}
          onClick={() => (panelOpen ? closePanel() : openPanel(panelTab))}
        >
          {panelOpen ? t('收起右栏') : t('右栏')}
        </antd.Button>
        {approvals.length > 0 && (
          <button type="button" className="jm-chat-approvals" onClick={() => openPanel('approvals')}>
            {t('待审核 {count}', { count: approvals.length })}
          </button>
        )}
      </header>
      {current ? (
        <>
          <messageList.MessageList
            state={messages}
            bot={current}
            onOpen={onOpen}
            onTrace={openTrace}
            traceTarget={traceTarget}
            approvals={approvals}
          />
          <progressBar.ProgressBar bot={current} />
          <composer.Composer
            bot={current}
            online={online}
            bots={botNames ? botNames.split('\n') : []}
            selectBot={selectBot}
            openSettings={() => setSettingsOpen(true)}
            openHelp={() => setHelpOpen(true)}
            onSent={messages.refresh}
          />
        </>
      ) : (
        <div className="jm-chat-body">
          <div className="jm-empty">{online ? t('后端还没有机器人') : t('连不上后端，等它回来')}</div>
        </div>
      )}
      <helpModal.HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
