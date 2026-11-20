/** 记忆关系图谱页的入口（web/graph.html）。 */
import { createRoot } from 'react-dom/client';
import { AuthGate } from '../components/AuthGate.tsx';
import { GraphPage } from './GraphPage.tsx';
import './Graph.css';

createRoot(document.getElementById('root')!).render(
  <AuthGate>
    <GraphPage />
  </AuthGate>,
);
