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
    const direct = checkLines.getHints(line, at, at + 'Sessions.ts:531'.length);
    expect(direct.primary).toBe('Session.loop');
    expect(direct.fromRow).toBeUndefined();

    const call = '（`ChannelTools.ts:356` 调 `requestChannelReply`）';
    const callAt = call.indexOf('ChannelTools');
    const hints = checkLines.getHints(call, callAt, callAt + 'ChannelTools.ts:356'.length);
    expect(hints.primary).toBeUndefined();
    expect(hints.extra).toEqual(['requestChannelReply']);

    //M 表格行没有紧挨着的名字时退回第一格；已有紧挨名字时紧挨的优先。
    const row = '| channel/reply（经 `requestTextReply`） | `Outbound.ts:535`（`submitChannel`）、`index.ts:1086` |';
    const firstAt = row.indexOf('Outbound.ts');
    const nearHints = checkLines.getHints(row, firstAt, firstAt + 'Outbound.ts:535'.length);
    expect(nearHints.primary).toBe('submitChannel');
    expect(nearHints.fromRow).toBeUndefined();

    const secondAt = row.indexOf('index.ts');
    const rowHints = checkLines.getHints(row, secondAt, secondAt + 'index.ts:1086'.length);
    expect(rowHints.primary).toBe('channel/reply');
    expect(rowHints.fromRow).toBe(true);
  });

  test('表格第一格取名（getRowName）覆盖常见写法与边界', () => {
    expect(checkLines.getRowName('| `fooBar` | `src7/Demo.ts:12` | 说明 |')).toBe('fooBar');
    expect(checkLines.getRowName('| apply | `src7/Demo.ts:12` | 说明 |')).toBe('apply');
    expect(checkLines.getRowName('| Approval.ask | 参数 | `index.ts:395` |')).toBe('Approval.ask');
    expect(checkLines.getRowName('| `Demo.constructor` | 构造 | `Demo.ts:10` |')).toBe('Demo.constructor');
    expect(checkLines.getRowName('| Approval.askModel(input,bot,script,why) | `index.ts:10` |')).toBe('Approval.askModel');
    expect(checkLines.getRowName('| `fooBar(a, b)` | `Demo.ts:12` |')).toBe('fooBar');
    expect(checkLines.getRowName('| `fooBar`(a, b) | `Demo.ts:12` |')).toBe('fooBar');
    expect(checkLines.getRowName('| readModel(value,providers):ImageModel\\|undefined | `index.ts:80` |')).toBe('readModel');
    expect(checkLines.getRowName('| `Model<Api>` | 类型 | `types.d.ts:32` |')).toBe('Model');
    expect(checkLines.getRowName('| Api.call<T> | 请求 | `Api.ts:10` |')).toBe('Api.call');
    expect(checkLines.getRowName('| parse<T>(raw: string) | 解析 | `Parse.ts:10` |')).toBe('parse');
    expect(checkLines.getRowName('| [`fooBar`](src7/Demo.ts#L12) | `Demo.ts:12` | 说明 |')).toBe('fooBar');
    expect(checkLines.getRowName('| [`Demo.run(a, b)`](#lines=Demo.json&line=6) | 说明 |')).toBe('Demo.run');
    expect(checkLines.getRowName('| [Demo.run](src7/Demo.ts#L6) | `Demo.ts:6` |')).toBe('Demo.run');
    expect(checkLines.getRowName('| **[`Demo.run`](src7/Demo.ts#L6)**（主入口） | `Demo.ts:6` |')).toBe('Demo.run');
    expect(checkLines.getRowName('| **`Demo.run`** | `Demo.ts:6` |')).toBe('Demo.run');
    expect(checkLines.getRowName('| bot/receive（`prepend: true`） | `index.ts:242` |')).toBe('bot/receive');
    expect(checkLines.getRowName('| `session/before-model`（技能） | `index.ts:27` |')).toBe('session/before-model');
    expect(checkLines.getRowName('| hits（prefixed闭包） | `index.ts:178` |')).toBe('hits');
    expect(checkLines.getRowName('| Bot.deliver `index.ts:643` | 投递 |')).toBe('Bot.deliver');
    expect(checkLines.getRowName('  | `fooBar` | `Demo.ts:12` |')).toBe('fooBar');

    //G 非表格行、表头、分隔行、路由、多符号并列、文件路径等不应误提取。
    expect(checkLines.getRowName('`fooBar`（`Demo.ts:12`）')).toBeUndefined();
    expect(checkLines.getRowName('| --- | --- |')).toBeUndefined();
    expect(checkLines.getRowName('| :---: | ---: |')).toBeUndefined();
    expect(checkLines.getRowName('| 名称 | 位置 | 说明 |')).toBeUndefined();
    expect(checkLines.getRowName('|  | `Demo.ts:12` |')).toBeUndefined();
    expect(checkLines.getRowName('| fooBar')).toBeUndefined();
    expect(checkLines.getRowName('| POST /api/approvals/:id | 审批 | `Api.ts:445` |')).toBeUndefined();
    expect(checkLines.getRowName('| ApprovalRequest / ApprovalResult | 类型 | `index.ts:10` |')).toBeUndefined();
    expect(checkLines.getRowName('| `foo` / `bar` | `Demo.ts:12` |')).toBeUndefined();
    expect(checkLines.getRowName('| `src7/Main.ts:12` | 位置 | `Demo.ts:12` |')).toBeUndefined();
    expect(checkLines.getRowName('| `Demo.ts` | 文件 | `Demo.ts:12` |')).toBeUndefined();
    expect(checkLines.getRowName('| `new cordis.Context()` | 根 | `Main.ts:79` |')).toBeUndefined();
    expect(checkLines.getRowName('| a < b | 比较 | `Demo.ts:12` |')).toBeUndefined();
    expect(checkLines.getRowName('| bots[].language（读配置） | 配置 | `Demo.ts:12` |')).toBeUndefined();
    expect(checkLines.getRowName('| providers.<决策模型>.base_url | 配置 | `Demo.ts:12` |')).toBeUndefined();
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

  test('函数表第一格核验与 --fix：定位定义行且不误改同文件调用点', () => {
    const root = makeRoot();
    //M 放一份带构造函数、方法、调用点和顶层函数的源码。
    const source = [
      '// 头一行',
      '// 第二行',
      'export class Worker {',
      '  constructor() {',
      '    this.work();',
      '  }',
      '  work(): number {',
      '    const value = 1;',
      '    return value;',
      '  }',
      '}',
      'export function boot(): Worker {',
      '  const worker = new Worker();',
      '  worker.work();',
      '  return worker;',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/Worker.ts'), source);

    const tableDoc = [
      '# 函数对照表',
      '',
      '| 函数 | 定义及调用 | 说明 |',
      '| --- | --- | --- |',
      '| `Worker.constructor` | `src7/Worker.ts:2`、`src7/Worker.ts:13` | 构造与 new 调用 |',
      '| Worker.work(x) | `src7/Worker.ts:6`、`src7/Worker.ts:11`、`src7/Worker.ts:14` | 定义漂了、第2处调用漂了、第3处对 |',
      '| [`boot`](src7/Worker.ts#L12) | `src7/Worker.ts:10` | 顶层入口 |',
      '| `Demo.run` | [Demo.ts L4](#lines=Demo.json&line=4) | 表格里的 #lines 链接 |',
      '| 内部体引用 | `src7/Worker.ts:8`（`work`） | 裸方法名落在方法体内不误提示 |',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/docs/函数表.md'), tableDoc);

    const files = ['src7/docs/函数表.md'];
    const checker = new checkLines.LineChecker(root, false);
    checker.run(files);
    const errors = checker.errors.map((problem) => problem.message);
    const warnings = checker.warnings.map((problem) => problem.message);

    //M 三处漂移的定义行和一处 #lines 链接都被检出。
    expect(errors.some((msg) => msg.includes('src7/Worker.ts:2 漂了') && msg.includes('应为 4'))).toBe(true);
    expect(errors.some((msg) => msg.includes('src7/Worker.ts:6 漂了') && msg.includes('应为 7'))).toBe(true);
    expect(errors.some((msg) => msg.includes('src7/Worker.ts:10 漂了') && msg.includes('应为 12'))).toBe(true);
    expect(errors.some((msg) => msg.includes('`Demo.run` 不在 src7/Demo.ts 第 4 行，应为 6'))).toBe(true);

    //M 同文件调用点 :11 不应报成「应为 7」，而是只给提示；:13（new Worker）、:14（worker.work）和 :8（work体内）不误提示。
    expect(errors.some((msg) => msg.includes('src7/Worker.ts:11'))).toBe(false);
    expect(warnings.some((msg) => msg.includes('src7/Worker.ts:11 里看不到表格第一格的 `Worker.work`'))).toBe(true);
    expect(warnings.some((msg) => msg.includes('src7/Worker.ts:13'))).toBe(false);
    expect(warnings.some((msg) => msg.includes('src7/Worker.ts:14'))).toBe(false);
    expect(warnings.some((msg) => msg.includes('src7/Worker.ts:8'))).toBe(false);

    //M --fix 只修定义行和 #lines 链接，不把调用点 :11 误改成 :7。
    const fixer = new checkLines.LineChecker(root, true);
    fixer.run(files);
    const updated = fs.readFileSync(path.join(root, 'src7/docs/函数表.md'), 'utf8');
    expect(updated).toContain('| `Worker.constructor` | `src7/Worker.ts:4`、`src7/Worker.ts:13` |');
    expect(updated).toContain('| Worker.work(x) | `src7/Worker.ts:7`、`src7/Worker.ts:11`、`src7/Worker.ts:14` |');
    expect(updated).toContain('| [`boot`](src7/Worker.ts#L12) | `src7/Worker.ts:12` |');
    expect(updated).toContain('| `Demo.run` | [Demo.ts L6](#lines=Demo.json&line=6) |');
  });

  test('文档链接 [文字 · 文件:行号](文件#L行号) 核对并同步 #L 锚点', () => {
    //M syncDocLinks：按方括号里的起始行同步圆括号里的 #L，保留范围与无行号链接。
    expect(checkLines.syncDocLinks('[`Demo.run` · src7/Demo.ts:6](Demo.ts#L4)')).toBe(
      '[`Demo.run` · src7/Demo.ts:6](Demo.ts#L6)',
    );
    expect(checkLines.syncDocLinks('[`Demo.run` · src7/Demo.ts:6–8](Demo.ts#L4)')).toBe(
      '[`Demo.run` · src7/Demo.ts:6–8](Demo.ts#L6)',
    );
    expect(checkLines.syncDocLinks('[见源码](Demo.ts#L4)')).toBe('[见源码](Demo.ts#L4)');

    //M 中点 `·` 分隔的链接文字能取出紧挨着引用的符号名或事件名。
    const linkLine = '[`Demo.run` · src7/Demo.ts:4](Demo.ts#L4) · [`Demo.stop` · `session/change` · src7/Demo.ts:8](Demo.ts#L8)';
    const firstAt = linkLine.indexOf('src7/Demo.ts:4');
    expect(checkLines.getHints(linkLine, firstAt, firstAt + 'src7/Demo.ts:4'.length).primary).toBe('Demo.run');
    const secondAt = linkLine.indexOf('src7/Demo.ts:8');
    expect(checkLines.getHints(linkLine, secondAt, secondAt + 'src7/Demo.ts:8'.length).primary).toBe('session/change');

    //M 端到端：校验模式报出漂移链接与 #L 不一致；--fix 同步更新方括号和 #L，重查归零。
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src7/plugins/demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src7/plugins/Index.ts'), '// 1\n// 2\nexport const BUILT_IN = [];\n');
    const readme = [
      '# 入口',
      '',
      '1. [`Demo.run` · src7/Demo.ts:4](Demo.ts#L4) · [`Demo.stop` · src7/Demo.ts:10](Demo.ts#L99)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/README.md'), readme);
    const pluginDoc = [
      '# demo',
      '',
      '演示插件。',
      '',
      '## 依赖',
      '无。',
      '',
      '## 听的事件',
      '无。',
      '',
      '## 发的事件',
      '无。',
      '',
      '## 对外函数',
      '无。',
      '',
      '## 内部函数',
      '[内置登记 · `BUILT_IN` · ../Index.ts:1](../Index.ts#L1)',
      '[真实登记 · `BUILT_IN` · ../Index.ts:2](../Index.ts#L2)',
      '',
      '## 数据',
      '无。',
      '',
      '## 配置',
      '无。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/plugins/demo/说明.md'), pluginDoc);

    const files = ['src7/README.md', 'src7/plugins/demo/说明.md'];
    const checker = new checkLines.LineChecker(root, false);
    checker.run(files);
    const errors = checker.errors.map((problem) => problem.message);
    expect(errors.some((msg) => msg.includes('src7/Demo.ts:4 漂了') && msg.includes('应为 6'))).toBe(true);
    expect(errors.some((msg) => msg.includes('Demo.ts#L99 和方括号里的 :10 不符'))).toBe(true);
    expect(errors.some((msg) => msg.includes('src7/plugins/Index.ts:2 漂了') && msg.includes('应为 3'))).toBe(true);

    const fixer = new checkLines.LineChecker(root, true);
    fixer.run(files);
    const fixedReadme = fs.readFileSync(path.join(root, 'src7/README.md'), 'utf8');
    expect(fixedReadme).toContain('[`Demo.run` · src7/Demo.ts:6](Demo.ts#L6)');
    expect(fixedReadme).toContain('[`Demo.stop` · src7/Demo.ts:10](Demo.ts#L10)');
    const fixedPluginDoc = fs.readFileSync(path.join(root, 'src7/plugins/demo/说明.md'), 'utf8');
    expect(fixedPluginDoc).toContain('[真实登记 · `BUILT_IN` · ../Index.ts:3](../Index.ts#L3)');

    const recheck = new checkLines.LineChecker(root, false);
    recheck.run(files);
    expect(recheck.errors).toEqual([]);
  });

  test('提取二级标题与文件头第一句（getSections / getHeadSentence）', () => {
    const md = [
      '# 插件',
      '',
      '## 依赖',
      '只用 http。',
      '',
      '```md',
      '## 围栏里的假标题',
      '```',
      '',
      '## 听的事件',
      '`demo/in`',
      '',
    ].join('\n');
    const sections = checkLines.getSections(md);
    expect([...sections.keys()]).toEqual(['依赖', '听的事件']);
    expect(sections.get('依赖')).toContain('只用 http。');
    expect(sections.get('听的事件')).toContain('demo/in');

    expect(checkLines.getHeadSentence('/**\n * 管理会话记录。\n * 第二句。\n */\n')).toBe('管理会话记录');
    expect(checkLines.getHeadSentence('/**\n * 管理会话记录；顺带归档。\n */\n')).toBe('管理会话记录');
    expect(checkLines.getHeadSentence('/**\n * 暴露三个入口：\n * - a\n */\n')).toBe('暴露三个入口：');
    expect(checkLines.getHeadSentence('import * as fs from "node:fs";\n')).toBe('');
  });

  test('插件说明校验：缺标准标题、源码收发事件漏写、index.ts 首句过长或冒号结尾', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src7/plugins/bad'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src7/plugins/good'), { recursive: true });

    //M bad 插件：首句超过 50 字且以冒号结尾，含多行 requestEvent、注释假事件与测试文件事件。
    const longHead = '管理超过五十个字符的插件启动描述测试文本'.repeat(3) + '：';
    const badIndex = [
      '/**',
      ' * ' + longHead,
      ' */',
      "ctx.on('bad/recv', () => {});",
      'requestEvent(',
      '  ctx,',
      "  'bad/ask',",
      ');',
      "// ctx.emit('comment/only');",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/plugins/bad/index.ts'), badIndex);
    fs.writeFileSync(path.join(root, 'src7/plugins/bad/Bad.test.ts'), "ctx.emit('test/only');\n");
    const badDoc = [
      '# bad',
      '',
      '## 依赖',
      '无。',
      '',
      '## 听的事件',
      '| 事件 | 说明 |',
      '| --- | --- |',
      '| `bad/recv` | 收消息 |',
      '',
      '## 发的事件',
      '无。',
      '',
      '## 对外函数',
      '无。',
      '',
      '## 数据',
      '无。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/plugins/bad/说明.md'), badDoc);

    //M good 插件：七个标准标题齐全、收发事件全登记、index.ts 首句简短平实。
    fs.writeFileSync(
      path.join(root, 'src7/plugins/good/index.ts'),
      "/** 管好自己的事。 */\nctx.emit('good/done');\n",
    );
    const goodDoc = [
      '# good',
      '',
      '管好自己的事。',
      '',
      '## 依赖',
      '无。',
      '',
      '## 听的事件',
      '无。',
      '',
      '## 发的事件',
      '`good/done`',
      '',
      '## 对外函数',
      '无。',
      '',
      '## 内部函数',
      '无。',
      '',
      '## 数据',
      '无。',
      '',
      '## 配置',
      '无。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/plugins/good/说明.md'), goodDoc);

    const checker = new checkLines.LineChecker(root, false);
    checker.run(['src7/plugins/bad/说明.md', 'src7/plugins/good/说明.md']);
    const errors = checker.errors.map((problem) => problem.site + ' ' + problem.message);

    expect(errors.some((msg) => msg.includes('缺 `## 内部函数`'))).toBe(true);
    expect(errors.some((msg) => msg.includes('缺 `## 配置`'))).toBe(true);
    expect(errors.some((msg) => msg.includes('src7/plugins/bad/index.ts:5') && msg.includes('`bad/ask`'))).toBe(true);
    expect(errors.some((msg) => msg.includes('`bad/recv`'))).toBe(false);
    expect(errors.some((msg) => msg.includes('`comment/only`'))).toBe(false);
    expect(errors.some((msg) => msg.includes('`test/only`'))).toBe(false);
    expect(errors.some((msg) => msg.includes('文件头第一句') && msg.includes('步骤标题会截断'))).toBe(true);
    expect(errors.some((msg) => msg.includes('文件头第一句以冒号结尾'))).toBe(true);
    expect(errors.some((msg) => msg.includes('src7/plugins/good/'))).toBe(false);
  });

  test('缺失文件在当前文档报问题、归档和重名歧义给提示，支持依赖目录起点', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src7/a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src7/b'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules/@scope/pkg/dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src7/a/Dup.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'src7/b/Dup.ts'), 'export const b = 2;\n');
    fs.writeFileSync(
      path.join(root, 'node_modules/@scope/pkg/dist/types.d.ts'),
      'export interface Msg { id: string; }\n',
    );

    const liveDoc = [
      '# 现行文档',
      '',
      '起点 `node_modules/@scope/pkg/dist/`。',
      '- 真缺文件：`src7/Missing.ts:1`',
      '- 重名短名：`Dup.ts:1`',
      '- 依赖全路径：`Msg`（`node_modules/@scope/pkg/dist/types.d.ts:1`）',
      '- 依赖相对路径：`Msg`（`types.d.ts:1`）',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src7/docs/引用测试.md'), liveDoc);
    fs.writeFileSync(path.join(root, 'src7/docs/云端/02_旧快照_20261121.md'), '旧引用 `src7/Missing.ts:1`。\n');

    const checker = new checkLines.LineChecker(root, false);
    checker.run(['src7/docs/引用测试.md', 'src7/docs/云端/02_旧快照_20261121.md']);
    const errors = checker.errors.map((problem) => problem.site + ' ' + problem.message);
    const warnings = checker.warnings.map((problem) => problem.site + ' ' + problem.message);

    //M 当前文档真缺文件升级为问题；依赖全路径与相对路径都能定位不误报。
    expect(errors).toEqual(['src7/docs/引用测试.md:4 找不到 src7/Missing.ts 是哪个文件']);
    //M 重名短名和归档文档缺文件仍只给提示。
    expect(warnings.some((msg) => msg.includes('Dup.ts 命中多个同名文件'))).toBe(true);
    expect(warnings.some((msg) => msg.includes('02_旧快照_20261121.md:1 找不到 src7/Missing.ts'))).toBe(true);
  });
});
