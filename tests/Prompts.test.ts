/**
 * 基础系统提示词的离线测试：临时运行时目录 + 内存数据库，验证 prompts/ 下的 .md
 * 按文件名排序、拼在角色自己的提示词前面，第一段和文件内容逐字一致；只给模型时也有基础段。
 *
 * 为什么盯“第一段逐字一致”：提示词缓存按前缀逐字节比对，第一段改一个字整个前缀就对不上，
 * 缓存全部落空。所以这里断言的是“原样”，不是“差不多”。
 * 不联网、不读真实运行时目录的 config.yaml、不调真模型。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as engineModule from '../src/events/Loop.ts';
import * as events from '../src/events/Events.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as modelModule from '../src/capabilities/Model.ts';


/** 测试用的机器人名。 */
const BOT = '测试机器人';

/** 第一段提示词的原文（故意带换行，验证整段一字不改；不带末尾换行，和文件字节对齐）。 */
const FIRST_PROMPT = '第一段原声：这句话一个字都不许改。\n第二行也要原样留着。';

/** 第二段提示词的原文。 */
const SECOND_PROMPT = '第二段：工具约定。';


/**
 * 建临时运行时目录：config.yaml、一个机器人，再清掉 Resources.load 自动复制进来的出厂提示词，
 * 换成测试自己的两份。这样用例不受仓库 prompts/ 以后增删文件影响。
 * @returns 目录；调用方负责删。
 */
function makeRuntimeDir(): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-prompts-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'default_model: fake/m1\n');
  fs.mkdirSync(path.join(dir, 'bots', BOT), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'bots', BOT, 'config.yaml'),
    ['description: 测试用', 'judge: rule', 'tools: []', 'system:', '  角色块: |', '    角色自己的提示词'].join('\n'),
  );
  return dir;
}


/**
 * 往运行时目录写测试用的基础提示词。调用前先清掉自动复制进来的出厂文件。
 * @param dir 临时运行时目录。
 */
function writePrompts(dir: string): void {
  /** 提示词目录。 */
  const promptsDir = path.join(dir, 'prompts');
  fs.rmSync(promptsDir, { recursive: true, force: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  //M 故意不按文件名顺序创建，验证排序靠文件名而不是创建顺序。
  fs.writeFileSync(path.join(promptsDir, '20_第三段.md'), '第三段。');
  fs.writeFileSync(path.join(promptsDir, '00_第一段.md'), FIRST_PROMPT);
  fs.writeFileSync(path.join(promptsDir, '10_第二段.md'), SECOND_PROMPT);
  //G README.md 和不是 .md 的文件都不该进提示词。
  fs.writeFileSync(path.join(promptsDir, 'README.md'), '这是说明，不是提示词。');
  fs.writeFileSync(path.join(promptsDir, '笔记.txt'), '也不是提示词。');
}


/**
 * 造一个只回话、不调工具的假模型，把每次 chat 拿到的系统提示词积木记下来。
 * @param seen 每次 chat 收到的系统提示词（积木名 → 正文）。
 * @returns 假的 Ai。
 */
function fakeAi(seen: Record<string, string>[]): modelModule.Ai {
  return {
    chat: (input) => {
      seen.push(input.system);
      /** 回复文字。 */
      const text = '好的';
      return Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text }] } as unknown as modelModule.ChatOutput['message'],
        text,
        thinking: '',
        toolCalls: [],
        ms: 1,
        request: { model: 'fake/m1', thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] },
      });
    },
    decide: () => Promise.reject(new Error('不该调用决策模型')),
    hasDecision: () => false,
    listModels: () => [],
  };
}


bunTest.test('readBasePrompts()：按文件名排序，只收 .md，README 不算，内容原样', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    writePrompts(dir);
    //M 第一段必须和文件内容逐字一致，提示词缓存才命中；这里直接比字符串。
    bunTest.expect(await resources.readBasePrompts()).toEqual([FIRST_PROMPT, SECOND_PROMPT, '第三段。']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('有角色时：基础段排在角色自己的提示词前面，第一段和文件内容逐字一致', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    writePrompts(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 每次 chat 看到的系统提示词。 */
    const seen: Record<string, string>[] = [];
    /** 引擎。 */
    const engine = engineModule.createEngine({ resources, store, ai: fakeAi(seen), owner: 'test@1' });
    /** 提交的任务。 */
    const submitted = engine.submit({ input: '看代码', source: '命令行', bot: BOT });
    await engine.runPending(submitted.sessionId);

    /** 第一次调模型的系统提示词。 */
    const system = seen[0] ?? {};
    /** 积木顺序。 */
    const keys = Object.keys(system);
    //M 1. 基础段必须排最前，角色自己的提示词只能排在它后面。
    bunTest.expect(keys.slice(0, 3)).toEqual(['基础', '基础2', '基础3']);
    bunTest.expect(keys.indexOf('角色块')).toBeGreaterThan(keys.indexOf('基础3'));
    bunTest.expect(keys.at(-1)).toBe('环境');
    //M 2. 第一段和文件内容逐字一致——差一个字缓存就全落空。
    bunTest.expect(system['基础']).toBe(FIRST_PROMPT);
    bunTest.expect(system['基础2']).toBe(SECOND_PROMPT);
    //M 3. 角色自己的提示词还在，不是被基础段顶掉了。
    bunTest.expect(system['角色块']).toContain('角色自己的提示词');

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test("分派对话（kind: 'route'）不拼基础提示词，普通任务会话照拼", async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    writePrompts(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 每次 chat 看到的系统提示词。 */
    const seen: Record<string, string>[] = [];
    /** 引擎。 */
    const engine = engineModule.createEngine({ resources, store, ai: fakeAi(seen), owner: 'test@1' });

    //M 先跑一个分派对话：它的会话种类是 route。
    /** 分派对话。 */
    const route = engine.submit({ input: '这句话该派到哪', source: '命令行', bot: BOT, kind: 'route' });
    await engine.runPending(route.sessionId);
    /** 分派对话看到的系统提示词。 */
    const routeSystem = seen[0] ?? {};

    //M 1. 分派对话不该出现任何基础段——基础提示词里那套工具习惯会让它把 DSML 当文字吐出来。
    bunTest.expect(Object.keys(routeSystem).filter((key) => key.startsWith('基础'))).toEqual([]);
    //M 2. 角色自己的提示词和环境块照拼：不是把整个系统提示词都跳过了。
    bunTest.expect(routeSystem['角色块']).toContain('角色自己的提示词');
    bunTest.expect(routeSystem['环境']).toContain('会话 ID：');

    //M 再跑一个普通任务会话：同样的设置，基础段必须照旧排在最前面。
    /** 普通任务。 */
    const task = engine.submit({ input: '看代码', source: '命令行', bot: BOT });
    await engine.runPending(task.sessionId);
    /** 普通任务看到的系统提示词。 */
    const taskSystem = seen[1] ?? {};
    bunTest.expect(Object.keys(taskSystem).slice(0, 3)).toEqual(['基础', '基础2', '基础3']);
    bunTest.expect(taskSystem['基础']).toBe(FIRST_PROMPT);

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('只给模型、没有角色时：也给基础段，且不拼角色那套', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    writePrompts(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 每次 chat 看到的系统提示词。 */
    const seen: Record<string, string>[] = [];
    /** 引擎。 */
    const engine = engineModule.createEngine({ resources, store, ai: fakeAi(seen), owner: 'test@1' });
    /** 提交的任务：只给模型，没有机器人。 */
    const submitted = engine.submit({ input: '只回一句', source: '命令行', model: 'fake/m1' });
    await engine.runPending(submitted.sessionId);

    /** 第一次调模型的系统提示词。 */
    const system = seen[0] ?? {};
    //M 1. 没有角色时基础段照给——它是给模型本身看的，和有没有角色无关。
    bunTest.expect(Object.keys(system)).toEqual(['基础', '基础2', '基础3']);
    bunTest.expect(system['基础']).toBe(FIRST_PROMPT);
    //G 没有角色就不该出现角色积木和环境块，拼装只保留基础段。
    bunTest.expect(system['环境']).toBeUndefined();

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
