/**
 * 网页入口：先把主题写进页面（首帧就是深色，不闪白），建状态仓库、开始轮询，再把 App 挂到 #root。
 * 由 web/index.html 引用；打包见 web/Build.ts。
 */
import * as react from 'react';
import * as reactDomClient from 'react-dom/client';
import * as appModule from './App.tsx';
import * as context from './Context.ts';
import * as i18n from './I18n.ts';
import * as poll from './Poll.ts';
import * as storeModule from './Store.ts';
import * as theme from './Theme.ts';
import './App.css';


/** 用户选过的主题。 */
const themeName = theme.loadThemeName(window.localStorage);
theme.applyTheme(document.documentElement, theme.THEMES[themeName]);
/** 状态仓库。 */
const store = storeModule.createUiStore(themeName, i18n.matchLanguage(new URLSearchParams(window.location.search).get('lang')) ?? i18n.loadLanguage(window.localStorage, navigator.language));
/** 挂载点；index.html 里一定有，没有说明打包出了问题。 */
const rootElement = document.getElementById('root');
//G 找不到挂载点时直接报错，不显示空白页。
if (!rootElement) {
  throw new Error('index.html 里缺少 #root');
}
poll.startPolling(store);
reactDomClient.createRoot(rootElement).render(
  <react.StrictMode>
    <context.UiContext.Provider value={store}>
      <appModule.App />
    </context.UiContext.Provider>
  </react.StrictMode>,
);
