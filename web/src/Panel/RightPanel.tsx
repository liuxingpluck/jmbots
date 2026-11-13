/**
 * 右栏：动态预览（docs/界面/01_界面设计.md 第 9 节）。默认收起；点附件、事件行、机器人时展开，聊天区不关；Esc 关。
 * 事件（Events.tsx）查看具体回复的只读证据；会话（Session.tsx）看步骤和分派记录、换模型、停下（G批设计 8.1）；
 * 原有预览、工作区、消息、待审核、记忆、详情和用量各保留原入口。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as approvals from './Approvals.tsx';
import * as details from './Details.tsx';
import * as events from './Events.tsx';
import * as memory from './Memory.tsx';
import * as messages from './Messages.tsx';
import * as preview from './Preview.tsx';
import * as session from './Session.tsx';
import * as usage from './Usage.tsx';
import * as workspace from './Workspace.tsx';
import * as historyModule from './History.ts';
import './Reader.css';
import type * as storeModule from '../Store.ts';


/** 原有内容入口与只读事件追踪；窄右栏通过横向滚动选择标签。 */
const TABS: { key: storeModule.PanelTab; label: string }[] = [
  { key: 'events', label: '事件' },
  { key: 'preview', label: '预览' },
  { key: 'workspace', label: '工作区' },
  { key: 'session', label: '会话' },
  { key: 'messages', label: '消息' },
  { key: 'approvals', label: '待审核' },
  { key: 'memory', label: '记忆' },
  { key: 'details', label: '详情' },
  { key: 'usage', label: '用量' },
];


/** 预览的标签页：一个文件一个，点名字切换、点 × 关掉，多了用 ‹ › 切到上一个、下一个（用户 11-06）。 */
function PreviewTabs(): react.JSX.Element | null {
  const t = i18n.useT();
  /** 开着的预览和正在看的那个。 */
  const tabs = context.useUi((state) => state.previewTabs);
  const current = context.useUi((state) => state.panelTarget);
  const showPreview = context.useUi((state) => state.showPreview);
  const closePreview = context.useUi((state) => state.closePreview);
  /** 标签那一排，切过去时把它滚到看得见的地方。 */
  const listRef = react.useRef<HTMLDivElement>(null);
  react.useEffect(() => {
    listRef.current?.querySelector('.jm-preview-tab-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current?.path]);
  if (tabs.length === 0) {
    return null;
  }
  /** 正在看的是第几个。 */
  const index = tabs.findIndex((item) => {
    return historyModule.fileIdentity(item.path) === historyModule.fileIdentity(current?.path);
  });
  /**
   * 切到上一个或下一个，到头了绕回来。
   * @param delta -1 上一个，1 下一个。
   */
  const step = (delta: number): void => {
    /** 要切到的。 */
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) {
      showPreview(next.path);
    }
  };
  return (
    <div className="jm-preview-tabs">
      <antd.Button size="small" type="text" icon={<icons.LeftOutlined />} aria-label={t('上一个预览')} disabled={tabs.length < 2} onClick={() => step(-1)} />
      <div className="jm-preview-tab-list" ref={listRef}>
        {tabs.map((item) => (
          <span key={item.path}
            className={historyModule.fileIdentity(item.path) === historyModule.fileIdentity(current?.path)
              ? 'jm-preview-tab jm-preview-tab-active' : 'jm-preview-tab'} title={item.path}>
            <button type="button" className="jm-preview-tab-name" onClick={() => showPreview(item.path)}>
              {item.name}
            </button>
            <button type="button" className="jm-preview-tab-close" aria-label={t('关掉这个预览')} onClick={() => closePreview(item.path)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <antd.Button size="small" type="text" icon={<icons.RightOutlined />} aria-label={t('下一个预览')} disabled={tabs.length < 2} onClick={() => step(1)} />
    </div>
  );
}


/** 右栏统一查看导航，独立于“上/下一个已开文件”两枚原按钮。 */
function ReadingHistory(): react.JSX.Element {
  const t = i18n.useT();
  const entries = context.useUi((state) => state.panelHistory);
  const index = context.useUi((state) => state.panelHistoryIndex);
  const back = context.useUi((state) => state.panelBack);
  const forward = context.useUi((state) => state.panelForward);
  const current = entries[index];
  let identity = t('右侧内容');
  if (current?.tab === 'preview' && current.target) {
    identity = current.target.name;
  } else if (current?.tab === 'events' && current.traceTarget) {
    identity = t('消息 #{id} 的第 {number} 条回复', {
      id: current.traceTarget.messageId,
      number: current.traceTarget.replyIndex + 1,
    });
  } else if (current) {
    const tab = TABS.find((item) => item.key === current.tab);
    if (tab) {
      identity = t(tab.label);
    }
  }

  return (
    <nav className="jm-reading-history" aria-label={t('右栏查看历史')}>
      <antd.Button size="small" type="text" icon={<icons.LeftOutlined />}
        aria-label={t('后退到上一处查看')} title={t('后退到上一处查看')}
        disabled={index <= 0} onClick={back} />
      <antd.Button size="small" type="text" icon={<icons.RightOutlined />}
        aria-label={t('前进到下一处查看')} title={t('前进到下一处查看')}
        disabled={index < 0 || index >= entries.length - 1} onClick={forward} />
      <span className="jm-reading-identity" title={identity}>{identity}</span>
      <span className="jm-muted">{index < 0 ? '0' : String(index + 1)} / {entries.length}</span>
    </nav>
  );
}


/** 右栏。 */
export function RightPanel(): react.JSX.Element {
  const t = i18n.useT();
  /** 在哪个标签、看什么。 */
  const tab = context.useUi((state) => state.panelTab);
  const target = context.useUi((state) => state.panelTarget);
  const openPanel = context.useUi((state) => state.openPanel);
  const closePanel = context.useUi((state) => state.closePanel);
  /** 待审核有几条（标在标签上）。 */
  const waiting = context.useUi((state) => state.approvals.length);
  /** 正在聊的机器人有几个会话在跑：“工作区”标签上亮一个一闪一闪的点（用户 11-06 原话第 62 节）。 */
  const running = context.useUi((state) => state.bots.find((item) => item.name === state.currentBot)?.running ?? 0);
  /**
   * 一个标签上写什么。
   * @param item 标签。
   */
  const tabLabel = (item: (typeof TABS)[number]): react.ReactNode => {
    if (item.key === 'approvals' && waiting > 0) {
      return `${t(item.label)} ${waiting}`;
    }
    if ((item.key === 'workspace' || item.key === 'session') && running > 0) {
      return (
        <span title={t('{count} 个会话在干活', { count: running })}>
          {t(item.label)}
          <i className="jm-busy-dot" />
        </span>
      );
    }
    return t(item.label);
  };
  return (
    <div className="jm-panel">
      <header className="jm-panel-head">
        <div className="jm-panel-tabs">
          <antd.Segmented
            size="small"
            value={tab}
            options={TABS.map((item) => ({ value: item.key, label: tabLabel(item) }))}
            onChange={(value) => openPanel(value)}
          />
        </div>
        <antd.Button type="text" size="small" icon={<icons.CloseOutlined />} aria-label={t('收起右栏（Esc）')} onClick={closePanel} />
      </header>
      <ReadingHistory />
      <div className="jm-panel-body">
        {tab === 'events' && <events.Events />}
        {tab === 'preview' && (
          <>
            <PreviewTabs />
            <preview.Preview target={target} />
          </>
        )}
        {tab === 'workspace' && <workspace.Workspace />}
        {tab === 'session' && <session.Session />}
        {tab === 'messages' && <messages.Messages />}
        {tab === 'approvals' && <approvals.Approvals />}
        {tab === 'memory' && <memory.Memory />}
        {tab === 'details' && <details.Details />}
        {tab === 'usage' && <usage.Usage />}
      </div>
    </div>
  );
}
