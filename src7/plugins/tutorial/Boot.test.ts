/**
 * 录启动（Boot.ts，原 boot-trail 插件）和读源码（Source.ts）的离线测试（2026-11-16 132 写，11-17 131 搬进 tutorial）。
 * 跑法：bun test ./src7/plugins/tutorial
 * 用真的 Cordis：假的 resources、sessions 两个服务先挂上（相当于骨架），再照 Main.ts 的样子一个个挂插件、推 pluginStatus、发 ready，
 * 最后发一个 Http.listen 的跟踪点。查的是：
 *   步骤的先后和道（main、resources、tools、sessions、各插件、ready、接着跑会话、http）；
 *   插件挂好、多出的服务、外部入口加载失败的条目也有一行；
 *   注释真的从源码取到（Main.ts 的 main、Checks.ts 的 checkArgs），取不到的写明原因；
 *   记完 HTTP 监听叫写 boot.json。
 */
import { describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as bootModule from './Boot.ts';
import type * as filesModule from './Files.ts';
import * as sourceModule from './Source.ts';


/** 假的运行时目录：完整路径不许出现在交出去的行里。 */
const ROOT = '/home/someone/secret-place/jmbotsData';

/** 假的密钥：不许出现在交出去的行里。 */
const KEY = 'sk-should-not-leak';


/** 假的 resources：只给 boot-trail 读到的几项。 */
class FakeResources extends cordis.Service {
  root = ROOT;
  config = {
    defaultModel: 'fake/echo',
    providers: { fake: { baseUrl: 'http://10.0.0.1/v1', apiKey: KEY, api: 'openai-completions', models: {} } },
    plugins: [{ name: 'tutorial' }, { name: 'alpha' }, { name: 'missing-one' }, { name: 'beta' }],
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 0 },
  };
  pluginStatus: { name: string; mounted: boolean; started: boolean; missing: string[]; error: string; inject: string[] }[] = [];
  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
}


/** 假的 sessions：库里有一场还在 running。 */
class FakeSessions extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }
  find(where: { state?: string }): { id: string }[] {
    return where.state === 'running' ? [{ id: 's1' }] : [];
  }
}


/** alpha 插件挂上时提供的服务。 */
class AlphaService extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'alpha');
  }
}


/** 录下的启动：tutorial 那个假插件挂上时建。 */
let boot: bootModule.BootTrail | undefined;

/** 叫写 boot.json 的次数。 */
let written = 0;

/** 假的快照文件：只数一下叫没叫写 boot.json，不真写。 */
const FAKE_FILES = {
  writeBoot: () => {
    written += 1;
  },
} as unknown as filesModule.FlowFiles;


/** 三个假插件：tutorial 只建录启动的 BootTrail（真的 apply 还要 http），alpha 提供服务 alpha，beta 什么都不提供。 */
const PLUGINS: Record<string, { name: string; inject: string[]; apply: (ctx: cordis.Context) => void }> = {
  tutorial: { name: 'tutorial', inject: ['resources', 'sessions'], apply: (ctx) => { boot = new bootModule.BootTrail(ctx, FAKE_FILES); } },
  alpha: { name: 'alpha', inject: ['resources'], apply: (ctx) => { new AlphaService(ctx); } },
  beta: { name: 'beta', inject: [], apply: () => undefined },
};


describe('录下这次启动', () => {
  test('照 Main.ts 的先后挂完：步骤、服务、失败的插件、注释', async () => {
    const app = new cordis.Context();
    await app.plugin(FakeResources);
    await app.plugin(FakeSessions);
    const resources = app.get('resources') as unknown as FakeResources;

    //M 照 Main.ts 挂插件。missing-one 模拟找不到外部入口，还没有创建 fiber。
    for (const entry of resources.config.plugins) {
      const plugin = PLUGINS[entry.name];
      if (plugin === undefined) {
        resources.pluginStatus.push({ name: entry.name, mounted: false, started: false, missing: [], error: '找不到这个插件', inject: [] });
        continue;
      }
      await app.plugin(plugin);
      resources.pluginStatus.push({ name: entry.name, mounted: true, started: true, missing: [], error: '', inject: plugin.inject });
    }
    app.emit('ready', []);
    app.emit('trace', 'Http.listen', 'HTTP 服务开始监听', 'app.listen({ host, port })', { 地址: '0.0.0.0', 端口: 30086, 有令牌: true });

    expect(boot).toBeDefined();
    const service = boot!;
    const lines = await service.getLines();

    //M 先后和道。
    expect(lines.map((line) => line.name)).toEqual([
      'main', 'Resources', 'Tools', 'Sessions',
      'tutorial', 'alpha', 'missing-one', 'beta',
      'ready', '接着跑会话', 'Http.listen',
    ]);
    expect(lines.map((line) => line.node)).toEqual([
      'main', 'resources', 'tools', 'sessions',
      'tutorial', 'alpha', 'missing-one', 'beta',
      'main', 'main', 'http',
    ]);
    const byName = (name: string): bootModule.BootLine => lines.find((line) => line.name === name)!;

    //M 骨架：运行时目录给完整路径（调试用原样给）；这一步供应商只列名字。键是英文。
    expect(byName('main').facts['root']).toBe(resources.root);
    expect(byName('Resources').facts['providers']).toBe('fake');
    expect(byName('Resources').facts['plugins']).toBe(4);
    expect(String(byName('Sessions').facts['services'])).toContain('resources');

    //M 插件：挂好了；alpha 多出服务 alpha；missing-one 没挂上、标出错。
    expect(byName('alpha').facts['state']).toBe('挂好了');
    expect(byName('alpha').facts['newServices']).toBe('alpha');
    expect(byName('missing-one').facts).toMatchObject({ state: '没挂上', failed: true, error: '找不到这个插件' });
    expect(byName('ready').facts).toMatchObject({ plugins: 4, mounted: 3, notMounted: 'missing-one' });
    expect(String(byName('ready').facts['services'])).toContain('alpha');
    expect(byName('接着跑会话').facts['running']).toBe(1);
    expect(byName('Http.listen').facts).toEqual({ host: '0.0.0.0', port: 30086, hasToken: true });

    //M 记完 HTTP 监听叫写一次 boot.json；每步都拍了快照。
    expect(written).toBe(1);
    expect(lines.every((line) => service.getSnapshot(line.id) !== undefined)).toBe(true);

    //M 每个键都在说明表里有中文解释；键里没有中文。
    const keys = new Set(lines.flatMap((line) => Object.keys(line.facts)));
    expect([...keys].filter((key) => service.notes[key] === undefined)).toEqual([]);
    expect([...keys].filter((key) => /\p{Script=Han}/u.test(key))).toEqual([]);

    //M 注释从源码取：main 在 Main.ts，checkArgs 在 Checks.ts，都取到了；人话是注释第一句。
    const mainDocs = byName('main').docs;
    expect(mainDocs[0]).toMatchObject({ name: 'main', missing: '', important: true });
    expect(mainDocs[0]?.site).toMatch(/^src7\/Main\.ts:\d+$/u);
    expect(byName('main').site).toMatch(/^src7\/Main\.ts:\d+$/u);
    const checkArgs = mainDocs.find((doc) => doc.name === 'checkArgs');
    expect(checkArgs?.summary).toContain('解析并校验命令行');
    expect(checkArgs?.params.map((param) => param.name)).toEqual(['argv']);
    expect(checkArgs?.returns).not.toBe('');
    expect(byName('main').text).toBe('启动');

    //M 第一条插件步骤带外部入口说明，插件注释来自真实源码。
    expect(byName('tutorial').docs.map((doc) => doc.name)).toEqual(['tutorial', 'loadExternalPlugin', 'tutorial.apply']);
    expect(byName('tutorial').docs.map((doc) => doc.missing)).toEqual(['', '', '']);
    expect(byName('tutorial').docs[2]?.summary).toContain('挂上教程插件');

    //M 假插件没有源码：标“读不到源码”，人话退回本插件写的那句。
    expect(byName('alpha').docs[0]?.missing).toBe('读不到源码');
    expect(byName('alpha').text).toBe('挂插件 alpha');
  }, 60_000);

  test('getLineIndex：字符串里提到的不算定义', () => {
    const lines = ["const docs = [fn(file, 'function apply(', 'x')];", '', 'export function apply(ctx) {'];
    expect(sourceModule.getLineIndex(lines, 'function apply(')).toBe(2);
    expect(sourceModule.getLineIndex(lines, 'nothing here')).toBe(-1);
  });

  test('getSignature：跨行的签名拼成一行，去掉修饰和结尾的 {', () => {
    const lines = [
      'export function apply(ctx: cordis.Context, config: Config): void {',
      'export async function checkArgs(',
      '  argv: string[],',
      '  opts: { dry: boolean },',
      '): Promise<Args> {',
      "  'ready'(argv: string[]): void;",
      '  private async listen(): Promise<void> {',
    ];
    expect(sourceModule.getSignature(lines, 0)).toBe('apply(ctx: cordis.Context, config: Config): void');
    expect(sourceModule.getSignature(lines, 1)).toBe('async checkArgs(argv: string[], opts: { dry: boolean }): Promise<Args>');
    expect(sourceModule.getSignature(lines, 5)).toBe("'ready'(argv: string[]): void");
    expect(sourceModule.getSignature(lines, 6)).toBe('async listen(): Promise<void>');
  });

  test('getBlockEnd：普通函数、返回类型带 {}', () => {
    const plain = ['function add(a: number, b: number): number {', '  const sum = a + b;', '  return sum;', '}', ''];
    expect(sourceModule.getBlockEnd(plain, 0)).toBe(3);

    const typed = ['function pick(): { a: number } {', '  return { a: 1 };', '}'];
    expect(sourceModule.getBlockEnd(typed, 0)).toBe(2);
  });

  test('getBlockEnd：箭头函数，带 {} 的和一句话的', () => {
    const lines = ['const twice = (x: number) => {', '  return x * 2;', '};', 'const half = (x: number) => x / 2;'];
    expect(sourceModule.getBlockEnd(lines, 0)).toBe(2);
    expect(sourceModule.getBlockEnd(lines, 3)).toBe(3);
  });

  test('getBlockEnd、getFunctionAt：类方法，从方法里面一行找回它', () => {
    const lines = [
      'class Box {',
      '  private items: string[] = [];',
      '  add(item: string): void {',
      "    if (item === '') {",
      '      return;',
      '    }',
      '    this.items.push(item);',
      '  }',
      '}',
    ];
    expect(sourceModule.getBlockEnd(lines, 2)).toBe(7);
    expect(sourceModule.getFunctionAt(lines, 6)).toEqual({ start: 2, end: 7 });
    expect(sourceModule.getFunctionAt(lines, 2)).toEqual({ start: 2, end: 7 });
    //M 类的字段那行不在任何函数里。
    expect(sourceModule.getFunctionAt(lines, 1)).toBeUndefined();
  });

  test('getBlockEnd：字符串、模板字符串里的 } 不算', () => {
    const lines = [
      'function close(): string {',
      "  const a = '}';",
      '  const b = "}}";',
      '  const c = `${"}"} }`;',
      '  return a + b + c;',
      '}',
    ];
    expect(sourceModule.getBlockEnd(lines, 0)).toBe(5);
  });

  test('getBlockEnd：注释、正则里的 { 不算', () => {
    const lines = ['function open(): void {', '  // {', '  /* { { */', '  const re = /\\{[{]/u;', '}'];
    expect(sourceModule.getBlockEnd(lines, 0)).toBe(4);
  });

  test('getBlockEnd：一句调用（带回调）不是定义', () => {
    const lines = ['doThing(a, () => {', '  x();', '});'];
    expect(sourceModule.getBlockEnd(lines, 0)).toBe(-1);
  });

  test('getSource：从真实源码取 isCompiled 的完整实现，列出调到的函数', async () => {
    const docs = new sourceModule.SourceDocs();
    const embeddedFile = 'src7/utils/Embedded.ts';
    const embeddedLines = (await docs.read(embeddedFile)) ?? [];
    const at = sourceModule.getLineIndex(embeddedLines, 'export function isCompiled(');
    const source = await docs.getSource(embeddedFile, at + 1);
    expect(source?.lines).toEqual(['export function isCompiled(): boolean {', '  return compiled;', '}']);
    expect(source?.start).toBe(at + 1);
    expect(source?.cut).toBe(false);

    //M getDoc 里调了同文件的 getLineIndex、getBlockAbove：能点的那几个。
    const own = 'src7/plugins/tutorial/Source.ts';
    const ownLines = (await docs.read(own)) ?? [];
    const getDoc = sourceModule.getLineIndex(ownLines, 'async getDoc(');
    const calls = (await docs.getSource(own, getDoc + 1))?.calls.map((call) => call.name) ?? [];
    expect(calls).toContain('getLineIndex');
    expect(calls).toContain('getBlockAbove');
    expect(calls).not.toContain('getDoc');
  });

  test('getSource.callers：checkConfig 由 readConfig 调用，带上方的 //M；插件自己的同名 checkConfig 不算', async () => {
    const docs = new sourceModule.SourceDocs();
    const checksFile = 'src7/utils/Checks.ts';
    const checksLines = (await docs.read(checksFile)) ?? [];
    const at = sourceModule.getLineIndex(checksLines, 'export function checkConfig(');
    const source = await docs.getSource(checksFile, at + 1);
    expect(source?.name).toBe('checkConfig');

    const sites = source?.callers.map((caller) => caller.site) ?? [];
    const fromResources = source?.callers.find((caller) => caller.site.startsWith('src7/Resources.ts:'));
    expect(fromResources?.code).toContain('checks.checkConfig(written)');
    expect(fromResources?.why).toContain('checkConfig');
    expect(sites.some((site) => site.startsWith('src7/plugins/decision/'))).toBe(false);
    expect(sites.some((site) => site.startsWith(`${checksFile}:${String(at + 1)}`))).toBe(false);
  });

  test('getWhyAbove、getCodeOnly：隔了空行或同层的 } 不算；字符串、注释里的不算调用', () => {
    const lines = ['  //M 为什么调', '  const a = 1;', '  foo(a);', '', '  foo(b);', '  if (x) {', '  }', '  foo(c);'];
    expect(sourceModule.getWhyAbove(lines, 2)).toBe('为什么调');
    expect(sourceModule.getWhyAbove(lines, 4)).toBe('');
    expect(sourceModule.getWhyAbove(lines, 7)).toBe('');
    expect(sourceModule.getCodeOnly("say('foo(x)'); // foo(y)")).toBe("say('      '); ");
  });
});
