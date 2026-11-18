/** 模型介绍和评价页的入口（web/model-notes.html，挂在 /model-notes/）。2026-11-17。 */
import * as client from 'react-dom/client';
import * as theme from '../Theme.ts';
import { ModelNotesPage } from './ModelNotesPage.tsx';
import './ModelNotes.css';

//M 读用户在主网页选过的主题（未选过默认深色），把 CSS 变量写进页面。
const themeName = theme.loadThemeName(window.localStorage);
const spec = theme.THEMES[themeName];
theme.applyTheme(document.documentElement, spec);

client.createRoot(document.getElementById('root')!).render(<ModelNotesPage />);
