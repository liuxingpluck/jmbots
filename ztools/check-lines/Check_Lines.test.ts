/** Check_Lines 的测试：在临时目录里搭一份小代码库，查出挪过的行号，再用 --fix 改好。 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as checkLines from './Check_Lines.ts';


/** 现在的源码：比文档写的时候在文件头多了两行。 */
const DEMO_SOURCE = [
  '// 头一行',
  '// 第二行',
  '/** 演示。 */',
  'export class Demo {',
  '  /** 跑。 */',
  '  run(): number {',
  '    return 1;',
  '  }',
  '',
  '  stop(): void {',
  '    return;',
  '  }',
  '}',
  '',
].join('\n');

/** 按旧行号写的骨架逐行 JSON。 */
const DEMO_NODES = [
  {
    id: 'r-demo',
    parent: null,
    title: 'src7/Demo.ts（共 11 行）',
    summary: '演示。',
    body: '## src7/Demo.ts 分块目录（共 11 行）\n\n- 全部（L1–L11）',
    sources: ['src7/Demo.ts'],
  },
  {
    id: 'r-demo-g1',
    parent: 'r-demo',
    title: 'L1–L11 全部',
    summary: '全部。',
    body: '## 全部\n\n- L1–L2 类头\n- L3–L11 两个方法',
    sources: ['src7/Demo.ts'],
  },
  {
    id: 'r-demo-01',
    parent: 'r-demo-g1',
    title: 'L1–L2 类头',
    summary: '类头。',
    body: [
      '**行号：L1–L2**',
      '',
      '### 代码原文',
      '```ts',
      '  1  /** 演示。 */',
      '  2  export class Demo {',
      '```',
      '',
      '### 解释',
      '- L2：类。',
    ].join('\n'),
    sources: ['src7/Demo.ts'],
  },
  {
    id: 'r-demo-02',
    parent: 'r-demo-g1',
    title: 'L3–L11 两个方法',
    summary: '两个方法。',
    body: [
      '**行号：L3–L11**',
      '',
      '### 代码原文',
      '```ts',
      '  3    /** 跑。 */',
      '  4    run(): number {',
      '  5      return 1;',
      '  6    }',
      '  7  ',
      '  8    stop(): void {',
      '  9      return;',
      ' 10    }',
      ' 11  }',
      '```',
      '',
      '### 解释',
      '- L4–L6：run。',
      '',
      '### 这段代码调用了',
      '- `Demo.run`（[Demo.ts L4](#lines=Demo.json&line=4) · 骨架）—— 跑一次。',
    ].join('\n'),
    sources: ['src7/Demo.ts'],
  },
];

/** 按旧行号写的教程 Markdown。 */
const DEMO_DOC = [
  '# 演示',
  '',
  '`Demo.run`（`Demo.ts:4`）跑一次。',
  '',
  '```ts',
  '// src7/Demo.ts',
  '4\t  run(): number {',
  '5\t    return 1;',
  '```',
  '',
  '返回值写在（`Demo.ts:5`）。',
  '',
].join('\n');

/** 每个测试搭的临时代码库，测完删掉。 */
const roots: string[] = [];

/**
 * 搭一份小代码库。
 * @param indent 骨架逐行 JSON 的缩进。
 * @returns 根目录。
 */
function makeRoot(indent = 2): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lines-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src7/docs/骨架逐行'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src7/docs/云端'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src7/Demo.ts'), DEMO_SOURCE);
  const json = JSON.stringify(DEMO_NODES, null, indent).split('\n').join('\r\n');
  fs.writeFileSync(path.join(root, 'src7/docs/骨架逐行/Demo.json'), json);
  fs.writeFileSync(path.join(root, 'src7/docs/演示.md'), DEMO_DOC);
  fs.writeFileSync(path.join(root, 'src7/docs/云端/01_旧评审_20261118.md'), '见 `Demo.ts:99`。\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Check_Lines', () => {
  test('找连续原文', () => {
    expect(checkLines.findRun(['a', 'b', 'a', 'b'], ['a', 'b'])).toEqual([1, 3]);
    expect(checkLines.findRun(['a', 'b', 'c'], ['b', 'c'])).toEqual([2]);
  });

  test('没有名字的行号按前后代码原文推算', () => {
    const shifts = [
      { file: 'f', start: 10, end: 12, delta: 3, applied: true },
      { file: 'f', start: 20, end: 22, delta: 3, applied: true },
      { file: 'f', start: 30, end: 31, delta: 5, applied: true },
    ];
    expect(checkLines.inferDelta(11, shifts)).toBe(3);
    expect(checkLines.inferDelta(15, shifts)).toBe(3);
    expect(checkLines.inferDelta(25, shifts)).toBeUndefined();
  });

  test('取引用旁边的名字', () => {
    const line = '私有方法 `Session.loop`，`Sessions.ts:531`，插件调不到';
    const at = line.indexOf('Sessions.ts');
    expect(checkLines.getHints(line, at, at + 'Sessions.ts:531'.length).primary).toBe('Session.loop');
    const call = '（`ChannelTools.ts:356` 调 `requestChannelReply`）';
    const callAt = call.indexOf('ChannelTools');
    const hints = checkLines.getHints(call, callAt, callAt + 'ChannelTools.ts:356'.length);
    expect(hints.primary).toBeUndefined();
    expect(hints.extra).toEqual(['requestChannelReply']);
  });

  test('归档文档只查越界', () => {
    expect(checkLines.isArchive('src7/docs/云端/01_旧评审_20261118.md')).toBe(true);
    expect(checkLines.isArchive('src7/docs/组块阅读/01_第一块.md')).toBe(false);
  });

  test('校验模式只报不改', () => {
    const root = makeRoot();
    const files = checkLines.expandTargets(root, ['src7/docs']);
    const checker = new checkLines.LineChecker(root, false);
    checker.run(files);
    const messages = checker.errors.map((problem) => problem.message).join('\n');
    expect(messages).toContain('代码原文现在在 L5–L13');
    expect(messages).toContain('src7/Demo.ts:4 漂了');
    expect(messages).toContain('src7/Demo.ts:5 漂了');
    expect(checker.warnings.some((problem) => problem.message.includes('归档文档'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src7/docs/演示.md'), 'utf8')).toBe(DEMO_DOC);
  });

  test('--fix 改好能定位的，剩下的列出来', () => {
    const root = makeRoot();
    const files = checkLines.expandTargets(root, ['src7/docs']);
    const fixer = new checkLines.LineChecker(root, true);
    fixer.run(files);
    expect(fixer.changes.length).toBeGreaterThan(0);

    const doc = fs.readFileSync(path.join(root, 'src7/docs/演示.md'), 'utf8');
    expect(doc).toContain('`Demo.run`（`Demo.ts:6`）');
    expect(doc).toContain('6\t  run(): number {');
    expect(doc).toContain('（`Demo.ts:7`）');

    const raw = fs.readFileSync(path.join(root, 'src7/docs/骨架逐行/Demo.json'), 'utf8');
    expect(raw.includes('\r\n')).toBe(true);
    const nodes = JSON.parse(raw) as typeof DEMO_NODES;
    expect(nodes[0].title).toBe('src7/Demo.ts（共 13 行）');
    expect(nodes[1].title).toBe('L3–L13 全部');
    expect(nodes[2].body).toContain('  3  /** 演示。 */');
    expect(nodes[2].body).toContain('- L4：类。');
    expect(nodes[3].title).toBe('L5–L13 两个方法');
    expect(nodes[3].body).toContain('- L6–L8：run。');
    expect(nodes[3].body).toContain('[Demo.ts L6](#lines=Demo.json&line=6)');

    const checker = new checkLines.LineChecker(root, false);
    checker.run(files);
    const left = checker.errors.map((problem) => problem.message);
    expect(left).toEqual(['L1–L2 没有块盖住']);
  });

  test('JSON 原来缩进 1 格的，写回也是 1 格', () => {
    const root = makeRoot(1);
    const files = checkLines.expandTargets(root, ['src7/docs/骨架逐行']);
    const fixer = new checkLines.LineChecker(root, true);
    fixer.run(files);
    expect(fixer.writeErrors).toEqual([]);
    const raw = fs.readFileSync(path.join(root, 'src7/docs/骨架逐行/Demo.json'), 'utf8');
    const nodes = JSON.parse(raw) as typeof DEMO_NODES;
    expect(raw).toBe(JSON.stringify(nodes, null, 1).split('\n').join('\r\n'));
    expect(nodes[3].title).toBe('L5–L13 两个方法');
  });
});
