/**
 * 知识库前端代码守卫测试：
 * 1. 确保 web/src/Knowledge/ 下彻底清零原生浏览器弹窗（window.alert / window.prompt / window.confirm），仅保留关页未保存 beforeunload；
 * 2. 验证三态主视图（📄 文档 | 🕸️ 关系图谱 | 🧠 记忆与 VGR）及 VGR 通路徽章完整存在。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'bun:test';


const KNOWLEDGE_WEB_DIR = path.resolve(import.meta.dirname, '../../../web/src/Knowledge');


/** 剥离块注释与行注释，避免注释说明文字触发误报。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}


describe('web/src/Knowledge 前端规范与融合视图守卫', () => {
  test('彻底清零原生 window.alert / window.prompt / window.confirm，保留 beforeunload 离开守卫', () => {
    const entries = fs.readdirSync(KNOWLEDGE_WEB_DIR).filter((name) => /\.(ts|tsx)$/u.test(name));
    expect(entries.length).toBeGreaterThanOrEqual(15);

    const violations: string[] = [];
    let hasBeforeUnload = false;

    for (const fileName of entries) {
      const fullPath = path.join(KNOWLEDGE_WEB_DIR, fileName);
      const raw = fs.readFileSync(fullPath, 'utf8');
      if (raw.includes("addEventListener('beforeunload'")) {
        hasBeforeUnload = true;
      }
      const codeOnly = stripComments(raw);
      if (/\bwindow\.(alert|prompt|confirm)\s*\(/u.test(codeOnly)) {
        violations.push(`${fileName}: window.alert/prompt/confirm`);
      }
      //M 直接裸调 alert(...) / prompt(...) / confirm(...)（排除对象方法如 kbDialog.confirm / kbDialog.prompt）
      if (/(?<![.\w$])(alert|prompt|confirm)\s*\(/u.test(codeOnly) && fileName !== 'KbDialogs.tsx') {
        violations.push(`${fileName}: bare alert/prompt/confirm`);
      }
    }

    expect(violations).toEqual([]);
    expect(hasBeforeUnload).toBe(true);
  });

  test('顶栏三态切换（文档 / 关系图谱 / 记忆与 VGR）与 VGR 命中通路徽章就绪', () => {
    const pageCode = fs.readFileSync(path.join(KNOWLEDGE_WEB_DIR, 'KnowledgePage.tsx'), 'utf8');
    expect(pageCode).toContain('📄 文档');
    expect(pageCode).toContain('🕸️ 关系图谱');
    expect(pageCode).toContain('🧠 记忆与 VGR');

    const graphCode = fs.readFileSync(path.join(KNOWLEDGE_WEB_DIR, 'GraphView.tsx'), 'utf8');
    expect(graphCode).toContain('适应画布');
    expect(graphCode).toContain('重置视角');
    expect(graphCode).toContain('孤立节点');
    expect(graphCode).toContain('打开编辑');

    const vgrCode = fs.readFileSync(path.join(KNOWLEDGE_WEB_DIR, 'MemoryVgrView.tsx'), 'utf8');
    expect(vgrCode).toContain('keyword · 关键词');
    expect(vgrCode).toContain('vector · 向量');
    expect(vgrCode).toContain('graph · 关系图');
    expect(vgrCode).toContain('model_dir');
  });
});
