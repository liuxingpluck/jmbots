/** 积木客服页的入口（web/wechat-kefu.html，挂在 /wechat-kefu/）。 */
import { createRoot } from 'react-dom/client';
import { AuthGate } from '../components/AuthGate.tsx';
import { ChunkErrorBoundary } from '../components/ChunkErrorBoundary.tsx';
import { WechatPage } from './WechatPage.tsx';
import './Wechat.css';

//M 外层套 ChunkErrorBoundary 与 AuthGate，承接公网登录鉴权并兜底换版后分块加载异常。
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <ChunkErrorBoundary>
      <AuthGate>
        <WechatPage />
      </AuthGate>
    </ChunkErrorBoundary>,
  );
}
