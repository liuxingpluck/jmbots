/**
 * memory 工具（src/capabilities/tools/Tools.ts）的离线测试：
 *   own / shared 两种 scope 的 list、read、write、delete；公共目录第一次写才创建；
 *   path 越出记忆文件夹时报错；分派只读模式只能 list、search、read；
 *   search 能搜到自己的记忆、公共记忆、个人技能、全局技能，配了 engine.memory_libs 才问基地，
 *   基地连不上不挡关键字结果。
 * 全部用临时运行时目录和最小 config.yaml，不读真实配置；基地用本机随机端口的假 HTTP 服务，不联网。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as toolsModule from '../src/capabilities/tools/Tools.ts';
import * as builders from './Builders.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 测试用的机器人名。 */
const BOT = '周小灵';


/** 一套测试用的临时运行时和依赖。 */
interface Harness {
  /** 临时运行时目录。 */
  dir: string;
  /** 资源。 */
  resources: resourcesModule.Resources;
  /** 依赖。 */
  deps: builders.TestDeps;
  /** 文件库。 */
  files: filesModule.Files;
}


/** setup 的额外配置：基地地址和要搜的库。 */
interface SetupOptions {
  /** config.yaml 的 engine.index_url。 */
  indexUrl?: string;
  /** config.yaml 的 engine.memory_libs。 */
  memoryLibs?: string;
}


/**
 * 建一套依赖：临时运行时目录里写最小 config.yaml，真的资源、文件库、内存数据库，假的模型和渠道。
 * @param options 基地搜索相关的配置。
 * @returns 临时运行时和依赖。
 */
async function setup(options: SetupOptions = {}): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-memory-'));
  /** config.yaml 的各行。 */
  const lines = ['providers: {}', 'default_model: magpie/test', 'bots:', `  - name: ${BOT}`, '    language: zh', 'engine:', '  merge_ms: 0'];
  if (options.indexUrl) {
    lines.push(`  index_url: ${JSON.stringify(options.indexUrl)}`);
  }
  if (options.memoryLibs) {
    lines.push(`  memory_libs: ${JSON.stringify(options.memoryLibs)}`);
  }
  await fs.writeFile(path.join(dir, 'config.yaml'), `${lines.join('\n')}\n`);
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot(BOT);
  /** 假模型：memory 工具用不到，被调到就说明测试写错了。 */
  const ai = builders.fakeAi({
    chat: () => Promise.reject(new Error('memory 测试不该调模型')),
    decide: () => Promise.reject(new Error('memory 测试不该调模型')),
    hasDecision: () => false,
    listModels: () => [],
  });
  /** 假渠道：memory 工具用不到。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  /** 依赖。 */
  const deps: builders.TestDeps = { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
  return { dir, resources, deps, files };
}


/**
 * 执行一次 memory 工具。
 * @param harness 测试环境。
 * @param args 工具参数。
 * @param readOnly 是不是分派只读模式。
 * @returns 工具结果。
 */
function memory(harness: Harness, args: Record<string, unknown>, readOnly = false): Promise<toolsModule.ToolResult> {
  /** 工具执行环境。 */
  const context: toolsModule.ToolContext = { bot: BOT, workDir: harness.dir, readOnly, vision: false };
  return builders.toolBoxOf(harness.deps).run('memory', args, context);
}


/**
 * 文件在不在。
 * @param file 文件路径。
 * @returns 在就是 true。
 */
async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false);
}


/**
 * 起一个假的基地记忆搜索服务：/search 回两条命中，记录收到的请求地址。
 * @returns 服务、它的地址和收到的请求。
 */
function startFakeBase(): { server: ReturnType<typeof Bun.serve>; url: string; requests: string[] } {
  /** 收到的请求地址。 */
  const requests: string[] = [];
  /** 处理请求：/rag/search 回 RAG 格式，/search 回老格式。 */
  const handler = (request: Request): Response => {
    /** 路径。 */
    const { pathname } = new URL(request.url);
    requests.push(request.url);
    if (pathname === '/rag/search') {
      return Response.json({
        hits: [{ lib: 'memory', path: '条目/甲.md', abs_path: path.join(os.tmpdir(), '假基地', '甲.md'), title: '甲标题', start_line: 3, end_line: 9, text: 'RAG 片段 BASE_RAG_SNIPPET', score: 1.2 }],
        not_indexed: [],
      });
    }
    return Response.json({
      hits: [
        { path: '条目/甲.md', lib: 'memory', summary: '基地摘要甲', snippet: '基地片段 BASE_SNIPPET' },
        { path: '乙.md', abs_path: path.join(os.tmpdir(), '假基地', '乙.md'), summary: '基地摘要乙' },
      ],
    });
  };
  /** 最后一次起的报错。 */
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      /** 服务本身（port: 0 由系统分配，避免撞端口）。 */
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
      return { server, url: `http://127.0.0.1:${server.port}`, requests };
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`起假基地失败（试了 5 次）：${String(last)}`);
}


bunTest.describe('memory：默认 scope 是自己的', () => {
  bunTest.test('list、write、read、delete 不写 scope 都动 bots/<bot>/memory/', async () => {
    const harness = await setup();
    /** 这个机器人的记忆目录。 */
    const memoryDir = harness.files.paths(BOT).memoryDir;
    /** 公共记忆目录（还没建）。 */
    const sharedDir = path.join(harness.dir, 'memory');

    //M 刚建好的机器人只有初始的 索引.md。
    const initial = await memory(harness, { action: 'list' });
    bunTest.expect(initial.isError).toBe(false);
    bunTest.expect(initial.text).toBe('索引.md');

    //M 写到子目录：memory 工具自己建上级目录。
    const written = await memory(harness, { action: 'write', path: '笔记/密码.md', content: '自己的记忆 OWN_TOKEN' });
    bunTest.expect(written.isError).toBe(false);
    bunTest.expect(written.text).toContain(path.join(memoryDir, '笔记', '密码.md'));
    bunTest.expect(await fs.readFile(path.join(memoryDir, '笔记', '密码.md'), 'utf8')).toBe('自己的记忆 OWN_TOKEN');

    /** 再列一次。 */
    const listed = await memory(harness, { action: 'list' });
    bunTest.expect(listed.isError).toBe(false);
    bunTest.expect(listed.text).toContain('索引.md');
    bunTest.expect(listed.text).toContain('笔记/密码.md');

    /** 读回来。 */
    const read = await memory(harness, { action: 'read', path: '笔记/密码.md' });
    bunTest.expect(read.isError).toBe(false);
    bunTest.expect(read.text).toBe('自己的记忆 OWN_TOKEN');

    /** 删掉。 */
    const deleted = await memory(harness, { action: 'delete', path: '笔记/密码.md' });
    bunTest.expect(deleted.isError).toBe(false);
    bunTest.expect(deleted.text).toContain('已删除记忆');
    bunTest.expect(await exists(path.join(memoryDir, '笔记', '密码.md'))).toBe(false);

    //M 默认 scope 不碰公共目录。
    bunTest.expect(await exists(sharedDir)).toBe(false);
  });
});


bunTest.describe('memory：shared scope 动公共目录', () => {
  bunTest.test('公共目录没建时 list 回空、不报错；第一次 write 才建目录', async () => {
    const harness = await setup();
    /** 运行时公共记忆目录。 */
    const sharedDir = path.join(harness.dir, 'memory');

    bunTest.expect(await exists(sharedDir)).toBe(false);
    /** 没建时的 list。 */
    const empty = await memory(harness, { action: 'list', scope: 'shared' });
    bunTest.expect(empty.isError).toBe(false);
    bunTest.expect(empty.text).toBe('（记忆文件夹是空的）');
    //G list 只读，不能顺手把目录建出来。
    bunTest.expect(await exists(sharedDir)).toBe(false);

    /** 第一次写。 */
    const written = await memory(harness, { action: 'write', scope: 'shared', path: '公共/规范.md', content: '公共记忆 SHARED_TOKEN' });
    bunTest.expect(written.isError).toBe(false);
    bunTest.expect(written.text).toContain(path.join(sharedDir, '公共', '规范.md'));
    bunTest.expect(await exists(sharedDir)).toBe(true);
    bunTest.expect(await fs.readFile(path.join(sharedDir, '公共', '规范.md'), 'utf8')).toBe('公共记忆 SHARED_TOKEN');
  });

  bunTest.test('list、read、write、delete 写 scope 都动运行时 memory/，不碰自己的', async () => {
    const harness = await setup();
    /** 自己的记忆目录。 */
    const memoryDir = harness.files.paths(BOT).memoryDir;
    /** 运行时公共记忆目录。 */
    const sharedDir = path.join(harness.dir, 'memory');

    await memory(harness, { action: 'write', scope: 'shared', path: '共享.md', content: '公共的 SHARED_LIST_TOKEN' });

    /** 公共 list。 */
    const listed = await memory(harness, { action: 'list', scope: 'shared' });
    bunTest.expect(listed.isError).toBe(false);
    bunTest.expect(listed.text).toContain('共享.md');

    /** 公共 read。 */
    const read = await memory(harness, { action: 'read', scope: 'shared', path: '共享.md' });
    bunTest.expect(read.isError).toBe(false);
    bunTest.expect(read.text).toBe('公共的 SHARED_LIST_TOKEN');

    /** 自己的 list 里没有公共文件。 */
    const own = await memory(harness, { action: 'list' });
    bunTest.expect(own.text).not.toContain('共享.md');

    /** 公共 delete。 */
    const deleted = await memory(harness, { action: 'delete', scope: 'shared', path: '共享.md' });
    bunTest.expect(deleted.isError).toBe(false);
    bunTest.expect(deleted.text).toContain('已删除记忆');
    bunTest.expect(await exists(path.join(sharedDir, '共享.md'))).toBe(false);
    //M 自己的记忆目录不受影响。
    bunTest.expect(await exists(path.join(memoryDir, '共享.md'))).toBe(false);
  });
});


bunTest.describe('memory：path 越界报错', () => {
  bunTest.test('../x、..\\..\\x 和绝对路径逃出都报错，不读写外面的文件', async () => {
    const harness = await setup();
    /** 运行时目录外面的一个文件（绝对路径逃出用）。 */
    const outside = path.join(os.tmpdir(), `jmbots-memory-outside-${String(Date.now())}.md`);
    /** 几种越界写法。 */
    const escapes = ['../x.md', '..\\..\\x.md', outside];

    for (const bad of escapes) {
      /** 写越界。 */
      const written = await memory(harness, { action: 'write', path: bad, content: '越界' });
      bunTest.expect(written.isError).toBe(true);
      bunTest.expect(written.text).toContain('memory 只能动');

      /** 读越界。 */
      const read = await memory(harness, { action: 'read', path: bad });
      bunTest.expect(read.isError).toBe(true);
      bunTest.expect(read.text).toContain('memory 只能动');
    }

    //G 公共目录也一样，越界不能写出去。
    const sharedEscape = await memory(harness, { action: 'write', scope: 'shared', path: '../逃出.md', content: '越界' });
    bunTest.expect(sharedEscape.isError).toBe(true);
    bunTest.expect(sharedEscape.text).toContain('memory 只能动');
    bunTest.expect(await exists(outside)).toBe(false);
  });
});


bunTest.describe('memory：分派只读模式', () => {
  bunTest.test('write、delete 报错；list、read、search 照常', async () => {
    const harness = await setup();
    /** 这个机器人的记忆目录。 */
    const memoryDir = harness.files.paths(BOT).memoryDir;
    //M 先用正常模式放一份记忆。
    await memory(harness, { action: 'write', path: '只读.md', content: '只读测试 READONLY_TOKEN' });

    /** 只读模式写：拒绝。 */
    const written = await memory(harness, { action: 'write', path: '禁止.md', content: '不该写' }, true);
    bunTest.expect(written.isError).toBe(true);
    bunTest.expect(written.text).toContain('分派只能 list、search、read');
    bunTest.expect(await exists(path.join(memoryDir, '禁止.md'))).toBe(false);

    /** 只读模式删：拒绝，原文件还在。 */
    const deleted = await memory(harness, { action: 'delete', path: '只读.md' }, true);
    bunTest.expect(deleted.isError).toBe(true);
    bunTest.expect(deleted.text).toContain('分派只能 list、search、read');
    bunTest.expect(await exists(path.join(memoryDir, '只读.md'))).toBe(true);

    /** 只读模式 list：照常。 */
    const listed = await memory(harness, { action: 'list' }, true);
    bunTest.expect(listed.isError).toBe(false);
    bunTest.expect(listed.text).toContain('只读.md');

    /** 只读模式 read：照常。 */
    const read = await memory(harness, { action: 'read', path: '只读.md' }, true);
    bunTest.expect(read.isError).toBe(false);
    bunTest.expect(read.text).toBe('只读测试 READONLY_TOKEN');

    /** 只读模式 search：照常。 */
    const searched = await memory(harness, { action: 'search', query: 'READONLY_TOKEN' }, true);
    bunTest.expect(searched.isError).toBe(false);
    bunTest.expect(searched.text).toContain('READONLY_TOKEN');
  });
});


bunTest.describe('memory search：四处来源', () => {
  bunTest.test('自己的记忆、公共记忆、个人技能、全局技能都按关键字搜到', async () => {
    const harness = await setup();
    /** 这个机器人的几个目录。 */
    const own = harness.files.paths(BOT);
    /** 运行时公共记忆目录。 */
    const sharedDir = path.join(harness.dir, 'memory');

    //M 四处各放一个只在这个文件里出现的关键字。
    await fs.writeFile(path.join(own.memoryDir, '记忆.md'), '# 记忆\n自己记忆 OWN_MEMORY_KW\n');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, '公共.md'), '# 公共\n公共记忆 SHARED_MEMORY_KW\n');
    /** 个人技能文件。 */
    const personalSkill = path.join(own.botDir, 'skills', '个人技能', 'SKILL.md');
    await fs.mkdir(path.dirname(personalSkill), { recursive: true });
    await fs.writeFile(personalSkill, '# 个人技能\n个人技能 PERSONAL_SKILL_KW\n');
    /** 全局技能文件。 */
    const globalSkill = path.join(harness.dir, 'skills', '全局技能', 'SKILL.md');
    await fs.mkdir(path.dirname(globalSkill), { recursive: true });
    await fs.writeFile(globalSkill, '# 全局技能\n全局技能 GLOBAL_SKILL_KW\n');

    /** search 不需要给 scope。 */
    const result = await memory(harness, { action: 'search', query: 'OWN_MEMORY_KW SHARED_MEMORY_KW PERSONAL_SKILL_KW GLOBAL_SKILL_KW' });
    bunTest.expect(result.isError).toBe(false);
    for (const keyword of ['OWN_MEMORY_KW', 'SHARED_MEMORY_KW', 'PERSONAL_SKILL_KW', 'GLOBAL_SKILL_KW']) {
      bunTest.expect(result.text).toContain(keyword);
    }
    //M 每条要带上是哪个文件：四处各对一次绝对路径。
    bunTest.expect(result.text).toContain(path.join(own.memoryDir, '记忆.md'));
    bunTest.expect(result.text).toContain(path.join(sharedDir, '公共.md'));
    bunTest.expect(result.text).toContain(personalSkill);
    bunTest.expect(result.text).toContain(globalSkill);
  });
});


bunTest.describe('memory search：本地整句和短话', () => {
  bunTest.test('整句“飞书发件箱怎么用”和短话“飞书”都能搜到', async () => {
    const harness = await setup();
    await fs.writeFile(path.join(harness.files.paths(BOT).memoryDir, '飞书发件箱.md'), '# 飞书发件箱\n飞书发件箱：往 outbox 放一份 md\n');
    /** 整句。 */
    const whole = await memory(harness, { action: 'search', query: '飞书发件箱怎么用' });
    bunTest.expect(whole.isError).toBe(false);
    bunTest.expect(whole.text).toContain('飞书发件箱.md');
    bunTest.expect(whole.text).toContain('outbox');
    /** 短话。 */
    const short = await memory(harness, { action: 'search', query: '飞书' });
    bunTest.expect(short.isError).toBe(false);
    bunTest.expect(short.text).toContain('飞书发件箱.md');
  });

  bunTest.test('只有两个字母（UI）时退回关键字也能搜到', async () => {
    const harness = await setup();
    await fs.writeFile(path.join(harness.files.paths(BOT).memoryDir, 'UI.md'), '# UI\n界面说明 UI_UI\n');
    /** 两个字母切不出字组，走关键字退路。 */
    const result = await memory(harness, { action: 'search', query: 'UI' });
    bunTest.expect(result.isError).toBe(false);
    bunTest.expect(result.text).toContain('UI.md');
  });

  bunTest.test('放 9 个都相关的文件，最多出 8 个', async () => {
    const harness = await setup();
    for (let index = 1; index <= 9; index += 1) {
      await fs.writeFile(path.join(harness.files.paths(BOT).memoryDir, `相关${String(index)}.md`), `# 相关${String(index)}\n飞书发件箱：往 outbox 放一份 md，第 ${String(index)} 份\n`);
    }
    /** 搜索结果。 */
    const result = await memory(harness, { action: 'search', query: '飞书发件箱' });
    bunTest.expect(result.isError).toBe(false);
    bunTest.expect(result.text.match(/@/g)?.length ?? 0).toBe(8);
  });
});


bunTest.describe('memory search：基地记忆库', () => {
  bunTest.test('配了 engine.memory_libs 就问基地，基地结果和关键字结果合在一起', async () => {
    const fake = startFakeBase();
    try {
      const harness = await setup({ indexUrl: fake.url, memoryLibs: 'memory,aiskills' });
      //M 本地也放一条，确认基地结果不会顶掉关键字结果。
      await fs.writeFile(path.join(harness.files.paths(BOT).memoryDir, '本地.md'), '本地关键字 LOCAL_KW\n');

      const result = await memory(harness, { action: 'search', query: 'LOCAL_KW' });
      bunTest.expect(result.isError).toBe(false);
      bunTest.expect(result.text).toContain('LOCAL_KW');
      //M RAG 命中：绝对路径、行号加标题、片段都在。
      bunTest.expect(result.text).toContain(path.join(os.tmpdir(), '假基地', '甲.md'));
      bunTest.expect(result.text).toContain('第 3–9 行 · 甲标题');
      bunTest.expect(result.text).toContain('RAG 片段 BASE_RAG_SNIPPET');
      bunTest.expect(result.text).toContain('# 记忆库 memory,aiskills');

      //M 只发一次 /rag/search，查询、条数、库名都对。
      bunTest.expect(fake.requests).toHaveLength(1);
      /** 请求地址。 */
      const url = new URL(fake.requests[0] ?? '');
      bunTest.expect(url.pathname).toBe('/rag/search');
      bunTest.expect(url.searchParams.get('q')).toBe('LOCAL_KW');
      bunTest.expect(url.searchParams.get('limit')).toBe('8');
      bunTest.expect(url.searchParams.get('lib')).toBe('memory,aiskills');
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('没配 engine.memory_libs：关键字照常搜，一个请求也不发', async () => {
    const fake = startFakeBase();
    try {
      //M 只配基地地址、不配库名。
      const harness = await setup({ indexUrl: fake.url });
      await fs.writeFile(path.join(harness.files.paths(BOT).memoryDir, '本地.md'), '本地关键字 NO_LIB_KW\n');

      const result = await memory(harness, { action: 'search', query: 'NO_LIB_KW' });
      bunTest.expect(result.isError).toBe(false);
      bunTest.expect(result.text).toContain('NO_LIB_KW');
      bunTest.expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('基地连不上：不挡关键字结果', async () => {
    //M 127.0.0.1:1 没有服务，模拟基地没起来；关键字结果照样返回。
    const harness = await setup({ indexUrl: 'http://127.0.0.1:1', memoryLibs: 'memory' });
    await fs.writeFile(path.join(harness.files.paths(BOT).memoryDir, '本地.md'), '本地关键字 OFFLINE_KW\n');

    const result = await memory(harness, { action: 'search', query: 'OFFLINE_KW' });
    bunTest.expect(result.isError).toBe(false);
    bunTest.expect(result.text).toContain('OFFLINE_KW');
  });
});
