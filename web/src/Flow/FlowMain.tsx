/** 插件预览页的入口（web/flow.html）。 */
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import { FlowPage } from './FlowPage.tsx';
import './Flow.css';

createRoot(document.getElementById('root')!).render(<FlowPage />);
