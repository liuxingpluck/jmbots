/** 只在本插件临时目录验证发件箱格式与持久去重，不加载飞书或触发发送。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import * as noticesModule from './GuardNotices.ts';

/** 用例自己创建的目录，完成后仅清理这些目录。 */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('通知按同类滑动10分钟去重，重建实例仍生效；正文原子变成完整md', () => {
  const prefix = path.join(import.meta.dir, '.guard-notices-test-');
  const root = fs.mkdtempSync(prefix);
  roots.push(root);
  const notices = new noticesModule.GuardNotices(root);
  expect(notices.send('memory-high', '测试正文，不外发', 0)).toBe(true);
  expect(notices.send('memory-high', '不应重复', 599_999)).toBe(false);
  const reloaded = new noticesModule.GuardNotices(root);
  expect(reloaded.send('memory-high', '重载不应重复', 500_000)).toBe(false);
  expect(reloaded.send('memory-high', '十分钟后允许', 600_000)).toBe(true);
  expect(reloaded.send('license:fake', '另一类事件', 600_000)).toBe(true);
  const outbox = path.join(root, 'integrations', 'feishu', 'outbox');
  const names = fs.readdirSync(outbox);
  expect(names).toHaveLength(3);
  expect(names.every((name) => name.endsWith('.md'))).toBe(true);
  const texts = names.map((name) => fs.readFileSync(path.join(outbox, name), 'utf8'));
  expect(texts).toContain('测试正文，不外发');
  expect(texts).not.toContain('不应重复');
});
