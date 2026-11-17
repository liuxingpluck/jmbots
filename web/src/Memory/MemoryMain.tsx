/** 记忆检索页的入口（web/memory.html，挂在 /memory/）。2026-11-14 jm开发。 */
import { createRoot } from 'react-dom/client';
import { MemoryPage } from './MemoryPage.tsx';
import './Memory.css';

createRoot(document.getElementById('root')!).render(<MemoryPage />);
