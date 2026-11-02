/**
 * 网页入口：先写入主题颜色变量，再把 App 挂到 #root。
 * 由 web/index.html 引用；打包见 scripts/Build_Web.ts。
 */
import * as react from 'react';
import * as reactDomClient from 'react-dom/client';
import App from './App.tsx';
import * as theme from './Theme.ts';
import './App.css';

// m: 先写颜色变量再挂载，首帧就是深色，不会先闪一下白底。
theme.applyThemeVariables(document.documentElement);
/** 挂载点；index.html 里一定有，没有说明打包出了问题。 */
const rootElement = document.getElementById('root');
// g: 找不到挂载点时直接报错，而不是显示空白页。
if (!rootElement) {
  throw new Error('index.html 里缺少 #root');
}
reactDomClient.createRoot(rootElement).render(
  <react.StrictMode>
    <App />
  </react.StrictMode>,
);
