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
import * as authGate from './components/AuthGate.tsx';
import * as chunkError from './components/ChunkErrorBoundary.tsx';
import './App.css';


/** 用户选过的主题。 */
//M 首帧挂载前先从本地存储读出主题并立刻应用，确保一打开就是深色背景不闪白。
const themeName = theme.loadThemeName(window.localStorage);
theme.applyTheme(document.documentElement, theme.THEMES[themeName]);
/** 状态仓库。 */
//M 按“URL ?lang= 参数优先、本地记忆语言次之”决定首屏语言，连同主题创建全局唯一状态仓库。
const urlLang = new URLSearchParams(window.location.search).get('lang');
const language = i18n.matchLanguage(urlLang) ?? i18n.loadLanguage(window.localStorage);
const store = storeModule.createUiStore(themeName, language);
/** 挂载点；index.html 里一定有，没有说明打包出了问题。 */
const rootElement = document.getElementById('root');
//G 找不到挂载点时直接报错，不显示空白页。
if (!rootElement) {
  throw new Error('index.html 里缺少 #root');
}

/** 通过外网门禁后再启动后台轮询并挂载主应用，本地直连首帧立即执行。 */
function MainAppShell(): react.JSX.Element {
  react.useEffect(() => poll.startPolling(store), []);
  return <appModule.App />;
}

//M 把状态仓库注入 UiContext，外层套上外网登录门禁壳后挂载根组件 App；最外层接住换版后懒加载分块失败。
reactDomClient.createRoot(rootElement).render(
  <react.StrictMode>
    <chunkError.ChunkErrorBoundary>
      <authGate.AuthGate>
        <context.UiContext.Provider value={store}>
          <MainAppShell />
        </context.UiContext.Provider>
      </authGate.AuthGate>
    </chunkError.ChunkErrorBoundary>
  </react.StrictMode>,
);
