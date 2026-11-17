/**
 * boot-trail 的离线测试（2026-11-16，132 写）。
 * 跑法：bun test ./src7/plugins/boot-trail/BootTrail.test.ts（test:src7 跑 ./src7/plugins 时一起跑到）。
 * 用真的 Cordis：假的 resources、sessions 两个服务先挂上（相当于骨架），再照 Main.ts 的样子一个个挂插件、推 pluginStatus、发 ready，
 * 最后发一个 Http.listen 的跟踪点。查的是：
 *   步骤的先后和点（main、resources、tools、sessions、各插件、ready、接着跑会话、http）；
 *   插件挂好、多出的服务、loadPlugin 就失败的那个也有一行；
 *   注释真的从源码取到（Main.ts 的 main、Checks.ts 的 checkArgs），取不到的写明原因；
 *   网页上不露完整路径、不露密钥。
 */
import { describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as bootTrail from './index.ts';
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
    plugins: [{ name: 'boot-trail' }, { name: 'alpha' }, { name: 'missing-one' }, { name: 'beta' }],
    maxSteps: 20,
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


/** 两个假插件：alpha 提供服务 alpha，beta 什么都不提供。 */
const PLUGINS: Record<string, { name: string; inject: string[]; apply: (ctx: cordis.Context) => void }> = {
  'boot-trail': bootTrail,
  alpha: { name: 'alpha', inject: ['resources'], apply: (ctx) => { new AlphaService(ctx); } },
  beta: { name: 'beta', inject: [], apply: () => undefined },
};


describe('boot-trail 记下这次启动', () => {
  test('照 Main.ts 的先后挂完：步骤、服务、失败的插件、注释、不露路径和密钥', async () => {
    const app = new cordis.Context();
    await app.plugin(FakeResources);
    await app.plugin(FakeSessions);
    const resources = app.get('resources') as unknown as FakeResources;

    //M 照 Main.ts 挂插件：挂上的推 mounted:true；missing-one 是 loadPlugin 就失败（找不到），没有 fiber。
    for (const entry of resources.config.plugins) {
      const plugin = PLUGINS[entry.name];
      if (plugin === undefined) {
        resources.pluginStatus.push({ name: entry.name, mounted: false, started: false, missing: [], error: '找不到这个插件', inject: [] });
        continue;
      }
      await app.plugin(plugin);
      resources.pluginStatus.push({ name: entry.name, mounted: true, started: true, missing: [], error: '', inject: plugin.inject });
    }
    //M 数一下启动走完的通知（flow 听它写 boot.json）。
    let done = 0;
    app.on('boot-trail/done', () => {
      done += 1;
    });
    app.emit('ready', []);
    app.emit('trace', 'Http.listen', 'HTTP 服务开始监听', 'app.listen({ host, port })', { 地址: '0.0.0.0', 端口: 30086, 有令牌: true });

    const service = app.get('bootTrail') as bootTrail.BootTrail | undefined;
    expect(service).toBeDefined();
    const lines = await service!.lines();

    //M 先后和点。
    expect(lines.map((line) => line.name)).toEqual([
      'main', 'Resources', 'Tools', 'Sessions',
      'boot-trail', 'alpha', 'missing-one', 'beta',
      'ready', '接着跑会话', 'Http.listen',
    ]);
    expect(lines.map((line) => line.node)).toEqual([
      'main', 'resources', 'tools', 'sessions',
      'boot-trail', 'alpha', 'missing-one', 'beta',
      'main', 'main', 'http',
    ]);
    const byName = (name: string): bootTrail.BootLine => lines.find((line) => line.name === name)!;

    //M 骨架：运行时目录给完整路径（调试用原样给）；这一步供应商只列名字。键是英文。
    expect(byName('main').facts['root']).toBe(resources.root);
    expect(byName('Resources').facts['providers']).toBe('fake');
    expect(byName('Resources').facts['plugins']).toBe(4);
    expect(String(byName('Sessions').facts['services'])).toContain('resources');

    //M 插件：挂好了；alpha 多出服务 alpha；boot-trail 自己多出 bootTrail；missing-one 没挂上、标出错。
    expect(byName('alpha').facts['state']).toBe('挂好了');
    expect(byName('alpha').facts['newServices']).toBe('alpha');
    expect(byName('boot-trail').facts['newServices']).toBe('bootTrail');
    expect(byName('missing-one').facts).toMatchObject({ state: '没挂上', failed: true, error: '找不到这个插件' });
    expect(byName('ready').facts).toMatchObject({ plugins: 4, mounted: 3, notMounted: 'missing-one' });
    expect(String(byName('ready').facts['services'])).toContain('alpha');
    expect(byName('接着跑会话').facts['running']).toBe(1);
    expect(byName('Http.listen').facts).toEqual({ host: '0.0.0.0', port: 30086, hasToken: true });

    //M 记完 HTTP 监听发一次 boot-trail/done；每个插件多出的服务交给 flow 画边。
    expect(done).toBe(1);
    expect(service!.provided().find((item) => item.name === 'alpha')?.services).toEqual(['alpha']);
    expect(service!.provided().find((item) => item.name === 'boot-trail')?.services).toEqual(['bootTrail']);

    //M 每个键都在说明表里有中文解释；键里没有中文。
    const keys = new Set(lines.flatMap((line) => Object.keys(line.facts)));
    expect([...keys].filter((key) => service!.notes[key] === undefined)).toEqual([]);
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

    //M boot-trail 自己的文件开头注释、第一个插件那步带 loadPlugin。
    expect(byName('boot-trail').docs.map((doc) => doc.name)).toEqual(['boot-trail', 'loadPlugin', 'boot-trail.apply']);
    expect(byName('boot-trail').docs.map((doc) => doc.missing)).toEqual(['', '', '']);
    //M boot-trail 自己的文件里也有字符串 'function apply('，site 要指到真正的定义那行。
    expect(byName('boot-trail').docs[2]?.summary).toContain('挂上 boot-trail');

    //M 假插件没有源码：标“读不到源码”，人话退回本插件写的那句。
    expect(byName('alpha').docs[0]?.missing).toBe('读不到源码');
    expect(byName('alpha').text).toBe('挂插件 alpha');
  }, 60_000);

  test('lineOf：字符串里提到的不算定义', () => {
    const lines = ["const docs = [fn(file, 'function apply(', 'x')];", '', 'export function apply(ctx) {'];
    expect(sourceModule.lineOf(lines, 'function apply(')).toBe(2);
    expect(sourceModule.lineOf(lines, 'nothing here')).toBe(-1);
  });

  test('signatureOf：跨行的签名拼成一行，去掉修饰和结尾的 {', () => {
    const lines = [
      'export function apply(ctx: cordis.Context, config: Config): void {',
      'export async function checkArgs(',
      '  argv: string[],',
      '  opts: { dry: boolean },',
      '): Promise<Args> {',
      "  'ready'(argv: string[]): void;",
      '  private async listen(): Promise<void> {',
    ];
    expect(sourceModule.signatureOf(lines, 0)).toBe('apply(ctx: cordis.Context, config: Config): void');
    expect(sourceModule.signatureOf(lines, 1)).toBe('async checkArgs(argv: string[], opts: { dry: boolean }): Promise<Args>');
    expect(sourceModule.signatureOf(lines, 5)).toBe("'ready'(argv: string[]): void");
    expect(sourceModule.signatureOf(lines, 6)).toBe('async listen(): Promise<void>');
  });

  test('blockEnd：普通函数、返回类型带 {}', () => {
    const plain = ['function add(a: number, b: number): number {', '  const sum = a + b;', '  return sum;', '}', ''];
    expect(sourceModule.blockEnd(plain, 0)).toBe(3);

    const typed = ['function pick(): { a: number } {', '  return { a: 1 };', '}'];
    expect(sourceModule.blockEnd(typed, 0)).toBe(2);
  });

  test('blockEnd：箭头函数，带 {} 的和一句话的', () => {
    const lines = ['const twice = (x: number) => {', '  return x * 2;', '};', 'const half = (x: number) => x / 2;'];
    expect(sourceModule.blockEnd(lines, 0)).toBe(2);
    expect(sourceModule.blockEnd(lines, 3)).toBe(3);
  });

  test('blockEnd、functionAt：类方法，从方法里面一行找回它', () => {
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
    expect(sourceModule.blockEnd(lines, 2)).toBe(7);
    expect(sourceModule.functionAt(lines, 6)).toEqual({ start: 2, end: 7 });
    expect(sourceModule.functionAt(lines, 2)).toEqual({ start: 2, end: 7 });
    //M 类的字段那行不在任何函数里。
    expect(sourceModule.functionAt(lines, 1)).toBeUndefined();
  });

  test('blockEnd：字符串、模板字符串里的 } 不算', () => {
    const lines = [
      'function close(): string {',
      "  const a = '}';",
      '  const b = "}}";',
      '  const c = `${"}"} }`;',
      '  return a + b + c;',
      '}',
    ];
    expect(sourceModule.blockEnd(lines, 0)).toBe(5);
  });

  test('blockEnd：注释、正则里的 { 不算', () => {
    const lines = ['function open(): void {', '  // {', '  /* { { */', '  const re = /\\{[{]/u;', '}'];
    expect(sourceModule.blockEnd(lines, 0)).toBe(4);
  });

  test('blockEnd：一句调用（带回调）不是定义', () => {
    const lines = ['doThing(a, () => {', '  x();', '});'];
    expect(sourceModule.blockEnd(lines, 0)).toBe(-1);
  });

  test('sourceOf：从真实源码取 isCompiled 的完整实现，列出调到的函数', async () => {
    const docs = new sourceModule.SourceDocs();
    const embeddedFile = 'src7/utils/Embedded.ts';
    const embeddedLines = (await docs.read(embeddedFile)) ?? [];
    const at = sourceModule.lineOf(embeddedLines, 'export function isCompiled(');
    const source = await docs.sourceOf(embeddedFile, at + 1);
    expect(source?.lines).toEqual(['export function isCompiled(): boolean {', '  return compiled;', '}']);
    expect(source?.start).toBe(at + 1);
    expect(source?.cut).toBe(false);

    //M docOf 里调了同文件的 lineOf、emptyDoc：能点的那几个。
    const own = 'src7/plugins/boot-trail/Source.ts';
    const ownLines = (await docs.read(own)) ?? [];
    const docOf = sourceModule.lineOf(ownLines, 'async docOf(');
    const calls = (await docs.sourceOf(own, docOf + 1))?.calls.map((call) => call.name) ?? [];
    expect(calls).toContain('lineOf');
    expect(calls).toContain('blockAbove');
    expect(calls).not.toContain('docOf');
  });

  test('sourceOf.callers：checkConfig 是 Resources 构造调的，带上方的 //M；插件自己的同名 checkConfig 不算', async () => {
    const docs = new sourceModule.SourceDocs();
    const checksFile = 'src7/utils/Checks.ts';
    const checksLines = (await docs.read(checksFile)) ?? [];
    const at = sourceModule.lineOf(checksLines, 'export function checkConfig(');
    const source = await docs.sourceOf(checksFile, at + 1);
    expect(source?.name).toBe('checkConfig');

    const sites = source?.callers.map((caller) => caller.site) ?? [];
    const fromResources = source?.callers.find((caller) => caller.site.startsWith('src7/Resources.ts:'));
    expect(fromResources?.code).toContain('checks.checkConfig(raw)');
    expect(fromResources?.why).toContain('checkConfig');
    expect(sites.some((site) => site.startsWith('src7/plugins/decision/'))).toBe(false);
    expect(sites.some((site) => site.startsWith(`${checksFile}:${String(at + 1)}`))).toBe(false);
  });

  test('whyAbove、codeOnly：隔了空行或同层的 } 不算；字符串、注释里的不算调用', () => {
    const lines = ['  //M 为什么调', '  const a = 1;', '  foo(a);', '', '  foo(b);', '  if (x) {', '  }', '  foo(c);'];
    expect(sourceModule.whyAbove(lines, 2)).toBe('为什么调');
    expect(sourceModule.whyAbove(lines, 4)).toBe('');
    expect(sourceModule.whyAbove(lines, 7)).toBe('');
    expect(sourceModule.codeOnly("say('foo(x)'); // foo(y)")).toBe("say('      '); ");
  });
});
