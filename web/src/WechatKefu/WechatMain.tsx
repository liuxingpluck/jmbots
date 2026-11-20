/** 积木客服页的入口（web/wechat-kefu.html，挂在 /wechat-kefu/）。2026-11-14 jm开发。 */
import { createRoot } from 'react-dom/client';
import { AuthGate } from '../components/AuthGate.tsx';
import { WechatPage } from './WechatPage.tsx';
import './Wechat.css';

createRoot(document.getElementById('root')!).render(
  <AuthGate>
    <WechatPage />
  </AuthGate>,
);
