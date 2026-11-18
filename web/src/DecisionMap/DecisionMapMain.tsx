/** 决策图页面的独立入口。 */
import * as client from 'react-dom/client';
import * as page from './DecisionMapPage.tsx';
import '@xyflow/react/dist/style.css';
import './DecisionMap.css';

//M 网页插件在 /decision-map/ 托管这个独立页面。
const root = document.getElementById('root')!;
const app = client.createRoot(root);
app.render(<page.DecisionMapPage />);
