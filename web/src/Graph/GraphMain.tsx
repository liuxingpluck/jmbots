/** 记忆关系图谱页的入口（web/graph.html）。 */
import { createRoot } from 'react-dom/client';
import { AuthGate } from '../components/AuthGate.tsx';
import { ChunkErrorBoundary } from '../components/ChunkErrorBoundary.tsx';
import { GraphPage } from './GraphPage.tsx';
import './Graph.css';

//M 最外层接住换版、断网后懒加载分块失效（和别的 7 个入口一样），里面套 AuthGate 承接外网登录。
createRoot(document.getElementById('root')!).render(
  <ChunkErrorBoundary>
    <AuthGate>
      <GraphPage />
    </AuthGate>
  </ChunkErrorBoundary>,
);
