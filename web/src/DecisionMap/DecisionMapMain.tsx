/** 决策图页面的独立入口。 */
import * as client from 'react-dom/client';
import * as authGate from '../components/AuthGate.tsx';
import * as page from './DecisionMapPage.tsx';
import '@xyflow/react/dist/style.css';
import './DecisionMap.css';

//M 网页插件在 /work-decision/ 托管这个独立页面，外层套 AuthGate 承接外网登录。
const root = document.getElementById('root')!;
const app = client.createRoot(root);
app.render(
  <authGate.AuthGate>
    <page.DecisionMapPage />
  </authGate.AuthGate>,
);
