/**
 * 中间步骤导日志的离线测试：一次执行走两步时，第一步（中间步骤）的 .json/.md
 * 必须在它自己走完时就写出来，不能等到整条链结束才补；会话.md 里的链接也都要能点开。
 *
 * 背景：拆成“一次 run 一步”之后，中间步骤从 runExecution 里提前返回了。以前只在结束路径
 * 导日志，目录里就只剩最后一步的文件，而每次重写的 会话.md 会列出库里所有步骤 → 死链。
 *
 * 全部在临时目录和内存数据库里做：假模型、假密钥，不联网、不读真实 config.yaml。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as engineModule from '../src/events/Loop.ts';
import * as events from '../src/events/Events.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as modelModule from '../src/capabilities/Model.ts';


/** 假 config.yaml：一个假供应商、一个默认模型、一个决策模型和“下一步”选择题。 */
const CONFIG = [
  'providers:',
  '  fake:',
  '    base_url: http://127.0.0.1:1/v1',
  '    api_key: fake-key-offline-test',
  'default_model: fake/m1',
  'models:',
  '  decision:',
  '    model: fake/d1',
  'engine:',
  '  max_steps: 10',
  'decision:',
  '  questions:',
  '    next_step:',
  '      type: choice',
  '      description: 下一步做什么',
  '      criteria:',
  '        continue: 还没做完，接着做',
  '        done: 做完了',
].join('\n');


/** 测试用的机器人名。 */
const BOT = '测试机器人';

/** 机器人配置：判断交给决策模型，第一步才会被判成“接着做”。 */
const BOT_CONFIG = ['description: 测试用', 'judge: decision', 'tools: []'].join('\n');


/**
 * 建临时运行时目录：config.yaml 和一个 judge 走决策模型的机器人。
 * @returns 目录；调用方负责删。
 */
function makeRuntimeDir(): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-log-step-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
  fs.mkdirSync(path.join(dir, 'bots', BOT), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bots', BOT, 'config.yaml'), BOT_CONFIG);
  return dir;
}


/**
 * 假模型：第一步回复一句话并判断“接着做”，第二步判断“做完了”。
 * @returns 假的 Ai。
 */
function fakeAi(): modelModule.Ai {
  /** 调了几次常规模型。 */
  let chatCalls = 0;
  /** 调了几次决策模型。 */
  let decisionCalls = 0;
  return {
    chat: () => {
      chatCalls += 1;
      /** 这一步的回复文字。 */
      const text = `第 ${chatCalls} 步做了点事`;
      return Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text }] } as unknown as modelModule.ChatOutput['message'],
        text,
        thinking: '',
        toolCalls: [],
        ms: 1,
        request: { model: 'fake/m1', thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] },
      });
    },
    decide: (input) => {
      decisionCalls += 1;
      return Promise.resolve({
        answers: { next_step: { type: 'choice', choice: decisionCalls === 1 ? 'continue' : 'done', probabilities: { continue: 0.9, done: 0.1 } } } as unknown as modelModule.DecideOutput['answers'],
        ms: 1,
        request: { model: 'fake/d1', state: input.state, questions: input.questions },
      });
    },
    hasDecision: () => true,
    listModels: () => [
      { id: 'fake/m1', name: 'm1', kind: 'chat', contextWindow: 8000, thinking: ['off'], price: { input: 0, output: 0 } },
      { id: 'fake/d1', name: 'd1', kind: 'decision', contextWindow: 8000, thinking: ['off'], price: { input: 0, output: 0 } },
    ],
  };
}


/**
 * 会话.md 里所有 .md 链接的目标文件名。
 * @param text 会话.md 全文。
 * @returns 链接里的文件名。
 */
function markdownLinks(text: string): string[] {
  return [...text.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1] ?? '');
}


bunTest.test('一次执行走两步：第一步的 .json/.md 立刻写出，会话.md 的链接都能打开', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 引擎。 */
    const engine = engineModule.createEngine({ resources, store, ai: fakeAi(), owner: 'test@1' });

    /** 提交的任务。 */
    const submitted = engine.submit({ input: '走两步看看', source: '命令行', bot: BOT });
    /** 领到并跑第一步。 */
    const first = store.claimNextExecution(submitted.sessionId, 'test@1');
    bunTest.expect(first).toBeDefined();
    await engine.runOneStep(first!);

    /** 会话（第一步走完后已经有工作区和执行者）。 */
    const session = store.getSession(submitted.sessionId)!;
    /** 会话目录。 */
    const sessionDir = resources.sessionDir(session);
    //M 1. 关键的一条：第一步是中间步骤（runOneStep 返回 undefined、整条链还没结束），
    //  它的 .json/.md 必须已经落盘。以前只在结束路径导日志，这里会找不到文件。
    bunTest.expect(store.listModelRequests(first!.id)).toHaveLength(1);
    bunTest.expect(fs.existsSync(path.join(sessionDir, `${first!.id}_1.json`))).toBe(true);
    bunTest.expect(fs.existsSync(path.join(sessionDir, `${first!.id}_1.md`))).toBe(true);
    //M 2. 这时会话.md 已经链到第一步的详情，而且链接指向的文件真的在。
    /** 第一步走完后的会话.md。 */
    const during = fs.readFileSync(path.join(sessionDir, '会话.md'), 'utf8');
    bunTest.expect(during).toContain(`[详情](${first!.id}_1.md)`);
    bunTest.expect(fs.existsSync(path.join(sessionDir, `${first!.id}_1.md`))).toBe(true);

    //M 3. 继续跑第二步，整条链结束；两步各自的文件都要在。
    /** 领到的第二步。 */
    const second = store.claimNextExecution(submitted.sessionId, 'test@1');
    bunTest.expect(second).toBeDefined();
    await engine.runOneStep(second!);

    /** 这次会话的全部执行。 */
    const executions = store.listEvents(submitted.sessionId, 'execution');
    bunTest.expect(executions).toHaveLength(2);
    /** 库里记录的每一步（执行事件 ID + 步号）。 */
    const steps = executions.flatMap((execution) => store.listModelRequests(execution.id).map((step) => ({ eventId: execution.id, step: step.step })));
    bunTest.expect(steps.map((item) => item.step)).toEqual([1, 2]);
    for (const item of steps) {
      bunTest.expect(fs.existsSync(path.join(sessionDir, `${item.eventId}_${item.step}.json`))).toBe(true);
      bunTest.expect(fs.existsSync(path.join(sessionDir, `${item.eventId}_${item.step}.md`))).toBe(true);
    }

    //M 4. 会话.md 里每一个 .md 链接都要能打开——死链正是这个 bug 的表面现象。
    /** 最终的会话.md。 */
    const overview = fs.readFileSync(path.join(sessionDir, '会话.md'), 'utf8');
    /** 所有链接目标。 */
    const links = markdownLinks(overview);
    bunTest.expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      bunTest.expect(fs.existsSync(path.join(sessionDir, link))).toBe(true);
    }

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
