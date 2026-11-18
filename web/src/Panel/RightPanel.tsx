/**
 * 右栏：动态预览（docs/界面/01_界面设计.md 第 9 节）。默认收起；点附件、事件行、机器人时展开，聊天区不关；Esc 关。
 * 事件（Events.tsx）查看具体回复的只读证据；会话（Session.tsx）看步骤和分派记录、换模型、停下（G批设计 8.1）；
 * 顶部「正在运行」（RunningTasks.tsx）列出当前机器人同时在跑的前台和后台任务，没有任务时不显示。
 * 原有预览、工作区、消息、待审核、记忆、详情和用量各保留原入口。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as approvals from './Approvals.tsx';
import * as assist from '../Chat/Assist.tsx';
import * as details from './Details.tsx';
import * as events from './Events.tsx';
import * as memory from './Memory.tsx';
import * as messages from './Messages.tsx';
import * as preview from './Preview.tsx';
import * as runningTasks from './RunningTasks.tsx';
import * as session from './Session.tsx';
import * as usage from './Usage.tsx';
import * as workspace from './Workspace.tsx';
import * as historyModule from './History.ts';
import * as readingModule from './Reading.ts';
import './Reader.css';
import type * as storeModule from '../Store.ts';


/** 原有内容入口与只读事件追踪；窄右栏通过横向滚动选择标签。 */
const TABS: { key: storeModule.PanelTab; label: string }[] = [
  { key: 'events', label: '事件' },
  { key: 'preview', label: '预览' },
  { key: 'workspace', label: '工作区' },
  { key: 'session', label: '会话' },
  { key: 'todo', label: '待办' },
  { key: 'messages', label: '消息' },
  { key: 'approvals', label: '待审核' },
  { key: 'memory', label: '记忆' },
  { key: 'details', label: '详情' },
  { key: 'usage', label: '用量' },
];


/** 预览的标签页：一个文件一个，点名字切换、点 × 关掉，多了用 ‹ › 切到上一个、下一个（用户 11-06）。 */
function PreviewTabs(): react.JSX.Element | null {
  //M 获取翻译函数与演示打码开关，供预览标签提示和文件名脱敏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 开着的预览和正在看的那个。 */
  //M 订阅当前打开的预览标签清单、焦点路径及切换/关闭预览动作。
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
    //M 按系统路径语义归一化比较路径，找到当前激活的预览标签索引。
    return historyModule.getFileIdentity(item.path) === historyModule.getFileIdentity(current?.path);
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
  //M 渲染已打开文件的多标签切换栏，支持轮转切换上一个预览。
  return (
    <div className="jm-preview-tabs">
      <antd.Button size="small" type="text" icon={<icons.LeftOutlined />} aria-label={t('上一个预览')} disabled={tabs.length < 2} onClick={() => step(-1)} />
      <div className="jm-preview-tab-list" ref={listRef}>
        {tabs.map((item) => {
          let tabClass = 'jm-preview-tab';
          //M 对比归一化路径判断当前标签是否选中，决定高亮样式。
          if (historyModule.getFileIdentity(item.path) === historyModule.getFileIdentity(current?.path)) {
            tabClass = 'jm-preview-tab jm-preview-tab-active';
          }
          //M 渲染单个预览标签，悬停路径与显示名称按演示开关脱敏。
          return (
            <span key={item.path} className={tabClass} title={privacy.text(item.path, masked)}>
              <button type="button" className="jm-preview-tab-name" onClick={() => showPreview(item.path)}>
                {privacy.name(item.name, masked)}
              </button>
              <button type="button" className="jm-preview-tab-close" aria-label={t('关掉这个预览')} onClick={() => closePreview(item.path)}>
                ×
              </button>
            </span>
          );
        })}
      </div>
      <antd.Button
        //M 轮转切换到下一个已打开的预览标签。
        size="small" type="text" icon={<icons.RightOutlined />} aria-label={t('下一个预览')} disabled={tabs.length < 2} onClick={() => step(1)} />
    </div>
  );
}


/** 根据当前查看历史条目生成栏头标题。 */
function getReadingIdentity(
  current: historyModule.PanelHistoryEntry | undefined,
  t: i18n.Translate,
  masked: boolean,
): string {
  if (!current) return t('右侧内容');

  //M 文件预览条目在栏头展示脱敏后的当前文件名。
  if (current.tab === 'preview' && current.target) return privacy.name(current.target.name, masked);

  if (current.tab === 'events' && current.traceTarget) {
    return t('消息 #{id} 的第 {number} 条回复', {
      id: current.traceTarget.messageId,
      number: current.traceTarget.replyIndex + 1,
    });
  }
  const tab = TABS.find((item) => item.key === current.tab);
  if (tab) return t(tab.label);

  return t('右侧内容');
}


/** 右栏统一查看导航，独立于“上/下一个已开文件”两枚原按钮。 */
function ReadingHistory(): react.JSX.Element {
  //M 读取翻译、打码状态、历史栈与前进后退回调，并生成当前条目栏头标题。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const entries = context.useUi((state) => state.panelHistory);
  const index = context.useUi((state) => state.panelHistoryIndex);
  const back = context.useUi((state) => state.panelBack);
  const forward = context.useUi((state) => state.panelForward);
  const identity = getReadingIdentity(entries[index], t, masked);
  let position = '0';
  if (index >= 0) {
    position = String(index + 1);
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
      <span className="jm-muted">{position} / {entries.length}</span>
    </nav>
  );
}


/**
 * 右栏。
 * @returns 右栏导航与当前激活功能页元素。
 * 副作用：订阅面板状态与插件挂载状态，切换标签或关闭右栏时更新 UI Store。
 */
export function RightPanel(): react.JSX.Element {
  //M 获取翻译函数，用于右栏标签文案与关闭按钮提示。
  const t = i18n.useT();
  /** 在哪个标签、看什么。 */
  //M 订阅当前激活标签、预览目标、已挂载插件列表及打开/关闭面板动作。
  const tab = context.useUi((state) => state.panelTab);
  const target = context.useUi((state) => state.panelTarget);
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const openPanel = context.useUi((state) => state.openPanel);
  const closePanel = context.useUi((state) => state.closePanel);
  const [panelScroll, setPanelScroll] = react.useState<HTMLDivElement | null>(null);
  /** 未挂载的插件对应标签不展示（如 assist 未挂载时隐藏“待办”）。 */
  const visibleTabs = react.useMemo(() => {
    return TABS.filter((item) => {
      //G 仅在 assist 插件挂载时展示“待办”标签。
      if (item.key === 'todo') return api.isPluginMounted(mountedPlugins, 'assist', false);

      //G 仅在 approval 插件挂载时展示“待审核”标签。
      if (item.key === 'approvals') return api.isPluginMounted(mountedPlugins, 'approval', true);

      //G 用量并进 model-catalog 插件后，按它是否挂载展示“用量”标签。
      if (item.key === 'usage') return api.isPluginMounted(mountedPlugins, 'model-catalog', true);

      //G 仅在 memory 或 base-bridge 插件挂载时展示“记忆”标签。
      if (item.key === 'memory') {
        return api.isPluginMounted(mountedPlugins, 'memory', true) || api.isPluginMounted(mountedPlugins, 'base-bridge', false);
      }

      return true;
    });
  }, [mountedPlugins]);
  let activeTab = tab;
  if (!visibleTabs.some((item) => item.key === tab)) {
    activeTab = visibleTabs[0]?.key ?? 'workspace';
  }
  /** 待审核有几条（标在标签上）。 */
  //M 订阅待审核命令数量，用于在标签上角标提示。
  const waiting = context.useUi((state) => state.approvals.length);
  /** 正在聊的机器人有几个会话在跑：“工作区”标签上亮一个一闪一闪的点（用户 11-06 原话第 62 节）。 */
  //M 订阅当前机器人运行中会话数，用于在“工作区/会话”标签亮起忙碌指示。
  const running = context.useUi((state) => state.bots.find((item) => item.name === state.currentBot)?.running ?? 0);
  /**
   * 一个标签上写什么。
   * @param item 标签。
   */
  const getTabLabel = (item: (typeof TABS)[number]): react.ReactNode => {
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
            value={activeTab}
            //M 生成可见标签页的切换选项及带待审核计数/忙碌指示的标签内容。
            options={visibleTabs.map((item) => ({ value: item.key, label: getTabLabel(item) }))}
            onChange={(value) => openPanel(value)}
          />
        </div>
        <antd.Button type="text" size="small" icon={<icons.CloseOutlined />} aria-label={t('收起右栏（Esc）')} onClick={closePanel} />
      </header>
      <ReadingHistory />
      <readingModule.PanelScrollContext.Provider value={panelScroll}>
        <div className="jm-panel-body" ref={setPanelScroll}>
          <runningTasks.RunningTasks />
          {activeTab === 'events' && <events.Events />}
          {activeTab === 'preview' && (
            <>
              <PreviewTabs />
              <preview.Preview target={target} />
            </>
          )}
          {activeTab === 'workspace' && <workspace.Workspace />}
          {activeTab === 'session' && <session.Session />}
          {activeTab === 'messages' && <messages.Messages />}
          {activeTab === 'approvals' && <approvals.Approvals />}
          {activeTab === 'memory' && <memory.Memory />}
          {activeTab === 'details' && <details.Details />}
          {activeTab === 'usage' && <usage.Usage />}
          {activeTab === 'todo' && <assist.TodoPanel />}
        </div>
      </readingModule.PanelScrollContext.Provider>
    </div>
  );
}
