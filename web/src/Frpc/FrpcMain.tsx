/** 外网隧道控制台入口（web/frpc.html）：首帧写入深色主题变量，外层套 AuthGate 承接外网登录。 */
import { createRoot } from 'react-dom/client';
import { AuthGate } from '../components/AuthGate.tsx';
import * as theme from '../Theme.ts';
import { FrpcPage } from './FrpcPage.tsx';
import './Frpc.css';

//M 读取已保存主题（默认 dark）并在首帧注入根节点，避免加载时闪白。
const themeName = theme.loadThemeName(window.localStorage);
const spec = theme.THEMES[themeName];
theme.applyTheme(document.documentElement, spec);

//M 挂载外网隧道控制台根组件，公网域名自动经过统一 AuthGate 鉴权。
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <AuthGate>
      <FrpcPage />
    </AuthGate>,
  );
}
