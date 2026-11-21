/** 记忆检索页的入口（web/memory.html，挂在 /memory/）。2026-11-14 jm开发。 */
import { createRoot } from 'react-dom/client';
import { AuthGate } from '../components/AuthGate.tsx';
import { ChunkErrorBoundary } from '../components/ChunkErrorBoundary.tsx';
import { MemoryPage } from './MemoryPage.tsx';
import './Memory.css';

//M 最外层接住换版、断网后懒加载分块失效（和 KnowledgeMain、TutorialMain 一样），里面套 AuthGate 承接外网登录。
createRoot(document.getElementById('root')!).render(
  <ChunkErrorBoundary>
    <AuthGate>
      <MemoryPage />
    </AuthGate>
  </ChunkErrorBoundary>,
);
