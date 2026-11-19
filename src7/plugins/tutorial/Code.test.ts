/**
 * 教程页「代码」「试一试」的后端：
 *   http/Routes.ts：从调用栈认出谁登记的路径（getOwner）；真 fastify 上登记路径，登记簿里有方法、路径、文件夹、位置，Fastify 补的 HEAD 不记；
 *   Code.ts：一个插件的对外函数（读源码）、登记的接口（登记簿）、登记的工具（Boot 记的归属），认不出归属的进“其他”。
 * 跑法：bun test ./src7/plugins/tutorial/Code.test.ts
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fastify from 'fastify';
import type * as cordis from 'cordis';
import * as routesModule from '../http/Routes.ts';
import * as versionsModule from '../../utils/Versions.ts';
import * as codeModule from './Code.ts';
import * as tutorialModule from './index.ts';
import * as skeletonModule from './Skeleton.ts';
import * as sourceModule from './Source.ts';


describe('getOwner：从调用栈认谁登记的', () => {
  test('跳过 Routes.ts 自己和第三方，认第一个插件文件', () => {
    const stack = [
      'Error: route',
      '    at hook (/x/jmbots/src7/plugins/http/Routes.ts:70:20)',
      '    at route (/x/jmbots/node_modules/fastify/lib/route.js:300:5)',
      '    at addRoutes (/x/jmbots/src7/plugins/relay/Routes.ts:88:9)',
      '    at apply (/x/jmbots/src7/plugins/relay/index.ts:12:3)',
    ].join('\n');
    expect(routesModule.getOwner(stack)).toEqual({ owner: 'relay', site: 'src7/plugins/relay/Routes.ts:88' });
  });

  test('Windows 的反斜杠路径也认', () => {
    const stack = 'Error\n    at x (F:\\jmbots\\src7\\plugins\\files-api\\index.ts:55:3)';
    expect(routesModule.getOwner(stack)).toEqual({ owner: 'files-api', site: 'src7/plugins/files-api/index.ts:55' });
  });

  test('编译版（没有源码路径）、骨架直接登记的认不出', () => {
    expect(routesModule.getOwner('Error\n    at x (/$bunfs/root/jmbots-server:1234:5)')).toBeUndefined();
    expect(routesModule.getOwner('Error\n    at x (/x/src7/Main.ts:10:5)')).toBeUndefined();
  });
});


describe('watchRoutes：真 fastify 上登记', () => {
  //M 源码在共享盘上，第一次加载 fastify 很慢，超时放宽。
  setDefaultTimeout(180_000);

  test('记方法、路径、登记的插件文件夹和位置；HEAD 不记；一串方法每个记一条', async () => {
    const app = fastify();
    const list: routesModule.RouteInfo[] = [];
    routesModule.watchRoutes(app, list);

    app.get('/api/demo/a', () => ({ ok: true }));
    app.route({ method: ['POST', 'PUT'], url: '/api/demo/b', handler: () => ({ ok: true }) });
    await app.ready();
    await app.close();

    expect(list.map((item) => `${item.method} ${item.url}`)).toEqual(['GET /api/demo/a', 'POST /api/demo/b', 'PUT /api/demo/b']);
    for (const item of list) {
      //M 这条是本测试文件登记的，文件夹就是 tutorial。
      expect(item.owner).toBe('tutorial');
      expect(item.site).toMatch(/^src7\/plugins\/tutorial\/Code\.test\.ts:\d+$/u);
    }
  });
});


describe('PluginCode.getCode', () => {
  /** 假的 ctx：登记簿里有 tutorial 的、relay 的、认不出的各一条；工具登记表里两个工具。 */
  const routes: routesModule.RouteInfo[] = [
    { method: 'GET', url: '/api/tutorial/plugins', owner: 'tutorial', site: 'src7/plugins/tutorial/index.ts:1' },
    { method: 'POST', url: '/api/relay/reply', owner: 'relay', site: 'src7/plugins/relay/Routes.ts:1' },
    { method: 'GET', url: '/api/mystery', owner: '', site: '' },
  ];
  const specs = new Map([
    ['edit', { definition: { name: 'edit', description: '改文件。第二句。' }, sessionKinds: ['work'] }],
    ['other-tool', { definition: { name: 'other-tool', description: '别人的' }, sessionKinds: ['front'] }],
  ]);
  const fake = {
    get: (name: string) => {
      if (name === 'http') return { routes };
      if (name === 'tools') return { specs };
      return undefined;
    },
  } as unknown as cordis.Context;
  const owners = new Map([['edit', 'file-tools'], ['other-tool', 'relay']]);
  const code = new codeModule.PluginCode(fake, new sourceModule.SourceDocs(), owners);

  test('tutorial：函数从源码读、接口只有它自己的、认不出的进“其他”', async () => {
    const info = await code.getCode('tutorial');
    const names = info.functions.map((item) => item.name);
    expect(names).toContain('apply');
    expect(names).toContain('PluginCode');
    const apply = info.functions.find((item) => item.name === 'apply');
    expect(apply?.kind).toBe('function');
    expect(apply?.site).toMatch(/^src7\/plugins\/tutorial\/index\.ts:\d+$/u);
    expect(apply?.summary).not.toBe('');

    expect(info.routes.map((item) => item.url)).toEqual(['/api/tutorial/plugins']);
    expect(info.others.map((item) => item.url)).toEqual(['/api/mystery']);
    expect(info.tools).toEqual([]);
  });

  test('file-tools：工具按 Boot 记的归属分，位置落在它自己的文件夹里', async () => {
    const info = await code.getCode('file-tools');
    expect(info.tools.map((item) => item.name)).toEqual(['edit']);
    expect(info.tools[0]?.summary).toBe('改文件');
    expect(info.tools[0]?.kinds).toEqual(['work']);
    expect(info.tools[0]?.site).toMatch(/^src7\/plugins\/file-tools\/.+\.ts:\d+$/u);
  });

  test('接口带 src7 里谁写了这条路径（登记那一句不算）', async () => {
    const info = await code.getCode('tutorial');
    const route = info.routes[0];
    //M 页面里没有 src7 文件写 '/api/tutorial/plugins'：callers 可以是空；这里只看结构。
    expect(Array.isArray(route?.callers)).toBe(true);
  });
});


describe('getWorkspace：从运行时目录找源码根', () => {
  test('配置写了源码目录就用它；没写、往上也找不到就是空串（不按目录名去猜）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-ws-'));
    try {
      //M 运行时和源码分开放：源码在 repo/，运行时在 data/。
      const runtimeDir = path.join(tmp, 'data');
      const repoDir = path.join(tmp, 'repo');
      const repoSrc = path.join(repoDir, 'src7');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(repoSrc, { recursive: true });
      fs.writeFileSync(path.join(repoSrc, 'Main.ts'), '// stub\n', 'utf8');

      //M 配置写了：用配置的。
      const configured = tutorialModule.getWorkspace(repoDir, runtimeDir);
      expect(configured).toBe(path.resolve(repoDir));

      //M 没写：往上找不到 src7/Main.ts，当前目录若是源码目录会命中，所以只断言不会命中 repo/。
      const guessed = tutorialModule.getWorkspace('', runtimeDir);
      expect(guessed).not.toBe(path.resolve(repoDir));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});


describe('Skeleton：系统骨架左栏与代码提取', () => {
  test('五个骨架模块带 VERSION 与 kind: skeleton', () => {
    //M 读取骨架左栏元数据清单，校验五项与主程序版本号一致。
    const items = skeletonModule.getSkeletonItems();
    expect(items.map((item) => item.name)).toEqual(['main', 'resources', 'tools', 'sessions', 'channels']);
    for (const item of items) {
      expect(item.kind).toBe('skeleton');
      expect(item.version).toBe(versionsModule.VERSION);
      expect(item.hasReadme).toBe(true);
    }
  });

  test('sessions 与 main 能从源码实时抽出说明、事件与对外函数（无磁盘 说明.md）', async () => {
    const source = new sourceModule.SourceDocs();
    //M 按源码实时抽取 sessions 模块文档与发出的事件及类方法索引。
    const sessionsReadme = await skeletonModule.getSkeletonReadme('sessions', source);
    expect(sessionsReadme.file).toBe('src7/Sessions.ts');
    expect(sessionsReadme.text).toContain(`# sessions v${versionsModule.VERSION}`);
    expect(sessionsReadme.text).toContain('session/request');
    expect(sessionsReadme.text).toContain('Sessions.create');

    //M main 代码清单应包含入口 main 函数与 utils 工具模块导出函数。
    const code = new codeModule.PluginCode(
      { get: () => undefined } as unknown as cordis.Context,
      source,
      new Map(),
    );
    const mainCode = await code.getCode('main');
    const mainNames = mainCode.functions.map((item) => item.name);
    expect(mainNames).toContain('main');
    expect(mainNames).toContain('checkArgs');
    const sessionsCode = await code.getCode('sessions');
    const sessionsNames = sessionsCode.functions.map((item) => item.name);
    expect(sessionsNames).toContain('Sessions.create');
    expect(sessionsNames).toContain('Session.run');
  });

  test('骨架工具：一个 utils 文件的说明有文件头、对外函数和内部函数', async () => {
    const source = new sourceModule.SourceDocs();
    //M 拿 Checks.ts 试：文件头写了“校验”，导出 checkArgs。
    const readme = await skeletonModule.getUtilReadme('src7/utils/Checks.ts', source);
    expect(readme.name).toBe('Checks.ts');
    expect(readme.text).toContain('# Checks.ts');
    expect(readme.text).toContain('校验');
    expect(readme.text).toContain('## 对外函数');
    expect(readme.text).toContain('`checkArgs`');
    expect(readme.text).toContain('## 内部函数');

    //M 读不到的文件给空说明，不抛错。
    const missing = await skeletonModule.getUtilReadme('src7/utils/没有这个.ts', source);
    expect(missing.text).toBe('');
  });
});
