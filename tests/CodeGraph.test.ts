/**
 * codegraph 工具的离线测试：在临时目录搭一个小项目（嵌套函数经返回对象转出去、跨文件调用），
 * 检查 find、callers、callees、deps、users、path 都查得对。不调模型。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as codeGraph from '../src/capabilities/tools/CodeGraph.ts';


/** 临时项目目录。 */
let root = '';


bunTest.beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-'));
  fs.mkdirSync(path.join(root, 'core'));
  fs.mkdirSync(path.join(root, 'channels'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', allowImportingTsExtensions: true, noEmit: true, strict: true, types: [] },
    include: ['**/*.ts'],
  }));
  fs.writeFileSync(path.join(root, 'core', 'Util.ts'), 'export function shout(text: string): string {\n  return text.toUpperCase();\n}\n');
  fs.writeFileSync(path.join(root, 'core', 'Engine.ts'), [
    "import * as util from './Util.ts';",
    'export function createEngine() {',
    '  function submit(text: string): string {',
    '    return util.shout(text);',
    '  }',
    '  async function handleMessage(text: string): Promise<string> {',
    '    return Promise.resolve(submit(text));',
    '  }',
    '  return { handleMessage };',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'channels', 'Chat.ts'), [
    "import * as engineModule from '../core/Engine.ts';",
    'export function start(): void {',
    '  const engine = engineModule.createEngine();',
    "  engine.handleMessage('hi');",
    '}',
    '',
  ].join('\n'));
});


bunTest.afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});


bunTest.test('find 找得到嵌套函数', () => {
  /** 结果。 */
  const output = codeGraph.queryGraph({ action: 'find', start: root, name: 'createEngine.handleMessage' });
  bunTest.expect(output).toContain('core/Engine.ts:6');
});


bunTest.test('callers 能查到经返回对象转出去的调用', () => {
  /** 结果。 */
  const output = codeGraph.queryGraph({ action: 'callers', start: root, name: 'handleMessage' });
  bunTest.expect(output).toContain('channels/Chat.ts:4（位于 start）');
  bunTest.expect(output).not.toContain('core/Engine.ts:6（');
});


bunTest.test('callees 认得出带 async 的嵌套函数', () => {
  /** 结果。 */
  const output = codeGraph.queryGraph({ action: 'callees', start: root, name: 'createEngine.handleMessage' });
  bunTest.expect(output).toContain('submit');
  bunTest.expect(output).toContain('core/Engine.ts:3');
});


bunTest.test('callees 列出被调用的函数', () => {
  /** 结果。 */
  const output = codeGraph.queryGraph({ action: 'callees', start: root, name: 'submit' });
  bunTest.expect(output).toContain('shout');
  bunTest.expect(output).toContain('core/Util.ts:1');
});


bunTest.test('deps、users、path 按导入关系查', () => {
  /** 调用方文件。 */
  const chat = path.join(root, 'channels', 'Chat.ts');
  /** 最底层的文件。 */
  const util = path.join(root, 'core', 'Util.ts');
  bunTest.expect(codeGraph.queryGraph({ action: 'deps', start: root, file: chat })).toContain('core/Engine.ts');
  bunTest.expect(codeGraph.queryGraph({ action: 'users', start: root, file: util })).toContain('core/Engine.ts');
  bunTest.expect(codeGraph.queryGraph({ action: 'path', start: root, file: chat, to: util })).toContain('channels/Chat.ts → core/Engine.ts → core/Util.ts');
  bunTest.expect(codeGraph.queryGraph({ action: 'path', start: root, file: util, to: chat })).toContain('（反方向）');
});


bunTest.test('找不到时说清楚', () => {
  bunTest.expect(codeGraph.queryGraph({ action: 'find', start: root, name: 'nothingHere' })).toContain('没找到');
});
