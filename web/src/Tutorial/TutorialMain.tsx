/** 教程页的入口（web/tutorial.html）：先把主题写进页面（默认深色，首帧不闪白），再挂载 TutorialPage。 */
import { createRoot } from 'react-dom/client';
import * as theme from '../Theme.ts';
import { AuthGate } from '../components/AuthGate.tsx';
import { ChunkErrorBoundary } from '../components/ChunkErrorBoundary.tsx';
import { TutorialPage } from './TutorialPage.tsx';
import './Tutorial.css';

//M 读用户在主网页选过的主题（未选过默认 dark），写进根节点 CSS 变量。
const themeName = theme.loadThemeName(window.localStorage);
const spec = theme.THEMES[themeName];
theme.applyTheme(document.documentElement, spec);

//M 页面挂在 #root 上，外层套 AuthGate 承接外网登录，最外层接住懒加载分块失败。
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <ChunkErrorBoundary>
      <AuthGate>
        <TutorialPage />
      </AuthGate>
    </ChunkErrorBoundary>,
  );
}
