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
//M 首帧挂载前先从本地存储读出主题并立刻应用，确保一打开就是深色背景不闪白。
const themeName = theme.loadThemeName(window.localStorage);
theme.applyTheme(document.documentElement, theme.THEMES[themeName]);
/** 状态仓库。 */
//M 按“URL ?lang= 参数优先、本地记忆语言次之”决定首屏语言，连同主题创建全局唯一状态仓库。
const store = storeModule.createUiStore(themeName, i18n.matchLanguage(new URLSearchParams(window.location.search).get('lang')) ?? i18n.loadLanguage(window.localStorage));
/** 挂载点；index.html 里一定有，没有说明打包出了问题。 */
const rootElement = document.getElementById('root');
//G 找不到挂载点时直接报错，不显示空白页。
if (!rootElement) {
  throw new Error('index.html 里缺少 #root');
}

//M 在挂载页面前启动后台轮询，第一时间拉回机器人状态、待确认列表和后端版本信息。
poll.startPolling(store);
//M 把状态仓库注入 UiContext 并挂载根组件 App，让全站组件共享同一份界面状态。
reactDomClient.createRoot(rootElement).render(
  <react.StrictMode>
    <context.UiContext.Provider value={store}>
      <appModule.App />
    </context.UiContext.Provider>
  </react.StrictMode>,
);
