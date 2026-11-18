/**
 * 整个网页：主题、三栏（左机器人、中聊天、右预览）、设置覆盖层。Esc 收起右栏。网址 # 后面的深链接见 Hash.ts。
 */
import * as antd from 'antd';
import enUS from 'antd/locale/en_US';
import frFR from 'antd/locale/fr_FR';
import zhCN from 'antd/locale/zh_CN';
import zhTW from 'antd/locale/zh_TW';
import * as react from 'react';
import * as api from './Api.ts';
import * as botList from './Bots/BotList.tsx';
import * as newBot from './Bots/NewBotModal.tsx';
import * as chat from './Chat/ChatArea.tsx';
import * as context from './Context.ts';
import * as hash from './Hash.ts';
import * as columns from './Layout/Columns.tsx';
import * as panel from './Panel/RightPanel.tsx';
import * as search from './Search/SearchModal.tsx';
import * as settings from './Settings/Settings.tsx';
import * as tokenPrompt from './Settings/TokenPrompt.tsx';
import * as theme from './Theme.ts';
import * as privacy from './Privacy/Mask.tsx';


/** antd 自己的文字用哪个语言包。 */
const ANTD_LOCALES = { 'zh-CN': zhCN, 'zh-TW': zhTW, en: enUS, fr: frFR };


/** 整个网页。 */
export function App(): react.JSX.Element {
  //M 订阅全局演示打码开关，决定是否要为顶部的打码提示条留出 42px 占位。
  const masked = privacy.useMask();
  /** 界面语言。 */
  //M 读取当前界面语言，交给 antd ConfigProvider 切换内置组件的语言包。
  const language = context.useUi((state) => state.language);
  /** 主题、右栏、设置。 */
  //M 订阅主题名、右栏/设置开关及关闭动作，驱动根部主题切换和 Esc 收起面板。
  const themeName = context.useUi((state) => state.themeName);
  const panelOpen = context.useUi((state) => state.panelOpen);
  const settingsOpen = context.useUi((state) => state.settingsOpen);
  const closePanel = context.useUi((state) => state.closePanel);
  /** 搜聊天、新建机器人的弹窗（开着时 Esc 只关弹窗，不收右栏）。 */
  //M 订阅搜索/建机器人弹窗状态以及面板、会话、机器人、设置操作，供快捷键和深链接使用。
  const searchOpen = context.useUi((state) => state.searchOpen);
  const newBotOpen = context.useUi((state) => state.newBotOpen);
  const setSearchOpen = context.useUi((state) => state.setSearchOpen);
  const openPanel = context.useUi((state) => state.openPanel);
  const openSession = context.useUi((state) => state.openSession);
  const selectBot = context.useUi((state) => state.selectBot);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);
  const setSettingsCategory = context.useUi((state) => state.setSettingsCategory);
  /** 主题。 */
  const spec = theme.THEMES[themeName];

  react.useEffect(() => {
    //M 主题配置变化时把 CSS 变量与 data-theme 写入 html 根节点，使整页样式即时联动。
    theme.applyTheme(document.documentElement, spec);
  }, [spec]);

  react.useEffect(() => {
    /** 照 # 后面说的做（深链接：#preview=路径、#tab=workspace、#settings=engine、#session=会话号）。 */
    const follow = (): void => {
      /** 要做什么。 */
      //M 解析地址栏 # 后面的深链接指令，按类型打开右栏预览、标签页、设置页或指定会话。
      const action = hash.parseHash(window.location.hash);
      if (action.kind === 'preview') {
        openPanel('preview', action.target);
        return;
      }
      if (action.kind === 'tab') {
        openPanel(action.tab);
        return;
      }
      if (action.kind === 'settings') {
        setSettingsCategory(action.category);
        setSettingsOpen(true);
        return;
      }
      if (action.kind === 'session') {
        openSession(action.sessionId);
        //M 先打开会话占位，再拉取该会话所属机器人并切过去后重开会话以对齐机器人上下文。
        void api.sessionDetail(action.sessionId).then((detail) => {
          if (detail.bot !== '') {
            selectBot(detail.bot);
            openSession(action.sessionId);
          }
        }, () => undefined);
      }
    };

    //M 首次挂载时立即按当前 URL hash 跳转一次，随后监听 hashchange 持续响应导航。
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [openPanel, openSession, selectBot, setSettingsOpen, setSettingsCategory]);

  react.useEffect(() => {
    /** Esc 收起右栏（设置开着时由设置页自己处理，弹窗开着时只关弹窗）；Ctrl+K（macOS ⌘K）开搜聊天（docs/界面/01_界面设计.md 6.1），在输入框里也管用。 */
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key === 'Escape' && !event.defaultPrevented && !searchOpen && !newBotOpen) {
        closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePanel, setSearchOpen, searchOpen, newBotOpen]);

  //M 提示条只在演示打码开着时出现，开着才让出顶部 42；右栏打开才渲染面板。
  let paddingTop = 0;
  if (masked) {
    paddingTop = 42;
  }
  let right: react.ReactNode = null;
  if (panelOpen) {
    right = <panel.RightPanel />;
  }

  //M 挂上当前主题与语言包，渲染打码横幅、三栏主布局，以及设置/搜索/建机器人/令牌全局弹窗。
  return (
    <antd.ConfigProvider theme={theme.antdTheme(spec)} locale={ANTD_LOCALES[language]}>
      <privacy.MaskBanner />
      <div style={{ height: '100%', paddingTop, boxSizing: 'border-box' }}>
      <columns.Columns left={<botList.BotList />} center={<chat.ChatArea />} right={right} />
      </div>
      {settingsOpen && <settings.Settings />}
      <search.SearchModal />
      <newBot.NewBotModal />
      <tokenPrompt.TokenPrompt />
    </antd.ConfigProvider>
  );
}
