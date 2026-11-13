/**
 * 整个网页：主题、三栏（左机器人、中聊天、右预览）、设置覆盖层。Esc 收起右栏。网址 # 后面的深链接见 Hash.ts。
 */
import * as antd from 'antd';
import enUS from 'antd/locale/en_US';
import frFR from 'antd/locale/fr_FR';
import zhCN from 'antd/locale/zh_CN';
import zhTW from 'antd/locale/zh_TW';
import * as react from 'react';
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


/** antd 自己的文字用哪个语言包。 */
const ANTD_LOCALES = { 'zh-CN': zhCN, 'zh-TW': zhTW, en: enUS, fr: frFR };


/** 整个网页。 */
export function App(): react.JSX.Element {
  /** 界面语言。 */
  const language = context.useUi((state) => state.language);
  /** 主题、右栏、设置。 */
  const themeName = context.useUi((state) => state.themeName);
  const panelOpen = context.useUi((state) => state.panelOpen);
  const settingsOpen = context.useUi((state) => state.settingsOpen);
  const closePanel = context.useUi((state) => state.closePanel);
  /** 搜聊天、新建机器人的弹窗（开着时 Esc 只关弹窗，不收右栏）。 */
  const searchOpen = context.useUi((state) => state.searchOpen);
  const newBotOpen = context.useUi((state) => state.newBotOpen);
  const setSearchOpen = context.useUi((state) => state.setSearchOpen);
  const openPanel = context.useUi((state) => state.openPanel);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);
  const setSettingsCategory = context.useUi((state) => state.setSettingsCategory);
  /** 主题。 */
  const spec = theme.THEMES[themeName];

  react.useEffect(() => {
    theme.applyTheme(document.documentElement, spec);
  }, [spec]);

  react.useEffect(() => {
    /** 照 # 后面说的做（深链接：#preview=路径、#tab=workspace、#settings=engine）。 */
    const follow = (): void => {
      /** 要做什么。 */
      const action = hash.parseHash(window.location.hash);
      if (action.kind === 'preview') {
        openPanel('preview', action.target);
      } else if (action.kind === 'tab') {
        openPanel(action.tab);
      } else if (action.kind === 'settings') {
        setSettingsCategory(action.category);
        setSettingsOpen(true);
      }
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [openPanel, setSettingsOpen, setSettingsCategory]);

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

  return (
    <antd.ConfigProvider theme={theme.antdTheme(spec)} locale={ANTD_LOCALES[language]}>
      <columns.Columns left={<botList.BotList />} center={<chat.ChatArea />} right={panelOpen ? <panel.RightPanel /> : null} />
      {settingsOpen && <settings.Settings />}
      <search.SearchModal />
      <newBot.NewBotModal />
      <tokenPrompt.TokenPrompt />
    </antd.ConfigProvider>
  );
}
