/**
 * Source.ts「谁调它（getCallers）」精准度单测：
 * 验证私有方法与未导出函数不跨文件乱抓同名调用（如 WebApi.accept 不再误抓 stream.accept），
 * 同时公共函数、同插件类方法、Cordis 骨架服务（Sessions / Resources / Tools）及 Session 实例方法仍能找全真实调用方。
 */
import { describe, expect, test } from 'bun:test';
import * as sourceModule from './Source.ts';


describe('SourceDocs.getSource / getCallers 调用链精准匹配', () => {
  const docs = new sourceModule.SourceDocs();

  test('private 方法 WebApi.accept 只返回 web-api/index.ts 内部真实调用，零外部噪音', async () => {
    const lines = await docs.read('src7/plugins/web-api/index.ts');
    expect(lines).toBeDefined();
    const defLine = sourceModule.getLineIndex(lines!, 'private async accept(') + 1;
    expect(defLine).toBeGreaterThan(0);

    const source = await docs.getSource('src7/plugins/web-api/index.ts', defLine);
    expect(source?.name).toBe('accept');
    const sites = source?.callers.map((item) => item.site) ?? [];
    expect(sites.length).toBeGreaterThan(0);
    //G 所有调用点必须都在 web-api/index.ts 本文件内，绝不混入 voice/relay/programs 的同名 .accept(。
    for (const site of sites) {
      expect(site.startsWith('src7/plugins/web-api/index.ts:')).toBe(true);
    }
    expect(source?.callers.some((item) => item.code.includes('this.accept('))).toBe(true);
  });

  test('插件内部公开类方法 Timeline.reply 只抓导入了 Timeline 的 web-api 调用方', async () => {
    const lines = await docs.read('src7/plugins/web-api/Timeline.ts');
    expect(lines).toBeDefined();
    const defLine = sourceModule.getLineIndex(lines!, 'reply(id: number,') + 1;
    expect(defLine).toBeGreaterThan(0);

    const source = await docs.getSource('src7/plugins/web-api/Timeline.ts', defLine);
    expect(source?.name).toBe('reply');
    const sites = source?.callers.map((item) => item.site) ?? [];
    expect(sites.some((site) => site.startsWith('src7/plugins/web-api/index.ts:'))).toBe(true);
    //G 不应把其他插件里的 channel/reply 或 reply(...) 误算进来。
    expect(sites.every((site) => site.startsWith('src7/plugins/web-api/'))).toBe(true);
  });

  test('骨架 Cordis 服务方法（Resources.getModel / Sessions.find）能跨插件找出真实调用方', async () => {
    const resLines = await docs.read('src7/Resources.ts');
    const getModelLine = sourceModule.getLineIndex(resLines!, 'getModel(') + 1;
    const getModelSource = await docs.getSource('src7/Resources.ts', getModelLine);
    expect(getModelSource?.name).toBe('getModel');
    const modelSites = getModelSource?.callers.map((item) => item.site) ?? [];
    expect(modelSites.some((site) => site.startsWith('src7/Sessions.ts:'))).toBe(true);

    const sesLines = await docs.read('src7/Sessions.ts');
    const findLine = sourceModule.getLineIndex(sesLines!, 'find(where:') + 1;
    const findSource = await docs.getSource('src7/Sessions.ts', findLine);
    expect(findSource?.name).toBe('find');
    const findSites = findSource?.callers.map((item) => item.site) ?? [];
    expect(findSites.some((site) => site.startsWith('src7/plugins/bots/'))).toBe(true);
    expect(findSites.some((site) => site.startsWith('src7/plugins/web-api/'))).toBe(true);
  });

  test('骨架 Session.run 能找出跨插件会话启动调用，且过滤掉 SQLite db.query(...).run(...)', async () => {
    const sesLines = await docs.read('src7/Sessions.ts');
    const runLine = sourceModule.getLineIndex(sesLines!, 'async run(): Promise<void>') + 1;
    const runSource = await docs.getSource('src7/Sessions.ts', runLine);
    expect(runSource?.name).toBe('run');

    const callers = runSource?.callers ?? [];
    expect(callers.some((item) => item.site.startsWith('src7/Main.ts:'))).toBe(true);
    expect(callers.some((item) => item.site.startsWith('src7/plugins/bots/'))).toBe(true);
    //G 绝不能把 SQLite 的 query.run(...) 或 Drizzle 的 orm.insert(...).run() 误当成 Session.run()。
    expect(callers.some((item) => item.code.includes('query') || item.code.includes('orm.'))).toBe(false);
  });

  test('跨文件导出的公共工具函数 checkModelRef 准确找出引用它的模块', async () => {
    const checkLines = await docs.read('src7/utils/Checks.ts');
    const refLine = sourceModule.getLineIndex(checkLines!, 'export function checkModelRef(') + 1;
    const refSource = await docs.getSource('src7/utils/Checks.ts', refLine);
    expect(refSource?.name).toBe('checkModelRef');
    const sites = refSource?.callers.map((item) => item.site) ?? [];
    expect(sites.some((site) => site.startsWith('src7/utils/Checks.ts:'))).toBe(true);
    expect(sites.some((site) => site.startsWith('src7/plugins/voice/'))).toBe(true);
  });
});


describe('接口块的范围与 JSDoc 首句（云端 32 第 3 条：Skeleton 不再裸数花括号）', () => {
  test('JSDoc、字符串、行注释里有不成对的 { } 时，getBlockEnd 仍配到接口真正的结尾', () => {
    const lines = [
      'export interface DemoConfig {',
      '  /** 写法像 { a: 1 这样，少了一个右括号。 */',
      '  first: string;',
      "  /** 默认 '}' 这种字符串也不算。 */",
      '  second?: number; // 行尾注释里 { 也不算',
      '  nested: {',
      '    inner: boolean;',
      '  };',
      "  third: '{';",
      '}',
      '',
      'export interface OtherConfig {',
      '  last: string;',
      '}',
    ];
    expect(sourceModule.getBlockEnd(lines, 0)).toBe(9);
    expect(sourceModule.getBlockEnd(lines, 11)).toBe(13);
  });

  test('declare module 里缩进的 interface Events 也能配上，事件 JSDoc 里的 { 不截断', () => {
    const lines = [
      "declare module 'cordis' {",
      '  interface Events {',
      '    /** 收到消息（payload 形如 { text 时）。 */',
      "    'demo/a'(payload: { text: string }): void;",
      '    /** 第二个事件。 */',
      "    'demo/b'(): void;",
      '  }',
      '}',
    ];
    expect(sourceModule.getBlockEnd(lines, 1)).toBe(6);
    expect(sourceModule.getSummaryAbove(lines, 3)).toBe('收到消息（payload 形如 { text 时）');
    expect(sourceModule.getSummaryAbove(lines, 5)).toBe('第二个事件');
  });

  test('TOP_EXPORT 认顶层 export function / class，不认缩进的和 export const', () => {
    expect(sourceModule.TOP_EXPORT.exec('export async function getPlan(a) {')?.slice(1)).toEqual(['function', 'getPlan']);
    expect(sourceModule.TOP_EXPORT.exec('export class Store {')?.slice(1)).toEqual(['class', 'Store']);
    expect(sourceModule.TOP_EXPORT.exec('  export function inner() {')).toBeNull();
    expect(sourceModule.TOP_EXPORT.exec('export const value = 1;')).toBeNull();
    expect(sourceModule.getSummaryAbove(['', 'export function none() {}'], 1)).toBe('');
  });
});

