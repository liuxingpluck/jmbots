/** 2026-11-14 23:15 EST：命中出处离线测试，只用临时合成文件，不碰正式数据。 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Sources } from './Sources.ts';
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-sources-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'memory', 'ainit'), { recursive: true });
  for (const name of ['功能.xlsx', '交付.docx']) fs.writeFileSync(path.join(root, 'memory', 'ainit', name), 'fake');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
test('老导入 source 带客户冒号：按文件名定位原文件、Sheet 行来自正文而非 start/end', () => {
  const root = fixture();
  const s = new Sources(root, () => '【功能 · Sheet1 第10行】合成\n【功能 · Sheet1 第14行】合成');
  expect(s.describe({ id: 1, source: 'doc-import:demo:出版ERP:功能.xlsx', customer: 'demo:出版ERP', start: 24, end: 35 })).toEqual({ file: path.join(root, 'memory', 'ainit', '功能.xlsx'), where: 'Sheet1 第 10–14 行', origin: '' });
});
test('docx 行号明确是转换后，从1数', () => {
  const root = fixture(); const s = new Sources(root, () => '');
  expect(s.describe({ source: 'doc-import:demo:出版ERP:交付.docx', customer: 'demo:出版ERP', start: 0, end: 15 })).toEqual({ file: path.join(root, 'memory', 'ainit', '交付.docx'), where: '转成文字后第 1–16 行', origin: '' });
});
test('找不到不编造路径', () => {
  const s = new Sources(fixture(), () => '');
  const r = s.describe({ source: 'doc-import:demo:x:不存在.xlsx', customer: 'demo:x' });
  expect(r.file).toBe(''); expect(r.origin).toContain('没找到');
});
test('会话来源不是文件', () => {
  const s = new Sources(fixture(), () => '');
  expect(s.describe({ source: 'session:s1', customer: 'fake:客户' })).toEqual({ file: '', where: '', origin: '聊天记录 · 客户 fake:客户 · 会话 s1' });
});
test('相对数据目录 source 直接拼，绝对来源保持原样', () => {
  const root = fixture(); const s = new Sources(root, () => '');
  expect(s.describe({ source: 'doc-import:c:memory/ainit/交付.docx', customer: 'c' }).file).toBe(path.join(root, 'memory', 'ainit', '交付.docx'));
  expect(s.describe({ source: path.join(root, 'memory', 'ainit', '交付.docx') }).file).toBe(path.join(root, 'memory', 'ainit', '交付.docx'));
});
