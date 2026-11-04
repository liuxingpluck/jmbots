/**
 * 一次 run 只做一步的端到端测试（框架文档 6.1）：假模型 + 真数据库，跑一条三步的执行链。
 *
 * 盯死三件事：
 *   1. 判断说"接着做"时，下一步变成一条新的 execution 事件，由循环再领走——链条能自己走到底；
 *   2. **任务原文在上下文里只出现一次**。每步一个事件之后，buildContext 如果照旧给每个
 *      execution 都塞一条用户消息，模型就会看到任务被重复说了 N 遍，上下文直接毁掉；
 *   3. 步与步之间会话**不会**被当成"做完了"（hasUnfinished 一直为真），否则命令行和 HTTP
 *      的等待方会提前拿到结果，而活才走到一半。
 *
 * 全部在临时目录和内存数据库里做，不联网、不碰真实运行时目录。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as engineModule from '../src/events/Loop.ts';
import * as events from '../src/events/Events.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as modelModule from '../src/capabilities/Model.ts';


/** 假 config.yaml：一个供应商、一个默认模型，外加判断用的那道选择题（走真实的决策路径）。 */
const CONFIG = [
  'providers:',
  '  fake:',
  '    base_url: http://127.0.0.1:1/v1',
  '    api_key: fake-key-abcdefgh',
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

/** 它的配置：判断交给决策模型，这样才走得到"接着做"那条路（没角色时判断只走兜底规则）。 */
const BOT_CONFIG = ['description: 测试用', 'judge: decision', 'tools: []'].join('\n');


/**
 * 建好临时运行时目录：config.yaml 和一个 judge 走决策模型的机器人。
 * @returns 目录；调用方负责删。
 */
function makeRuntimeDir(): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-engine-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
  fs.mkdirSync(path.join(dir, 'bots', BOT), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bots', BOT, 'config.yaml'), BOT_CONFIG);
  return dir;
}


/**
 * 建一个假模型：前 continueTimes 次回复都带一句话、判断为"接着做"，之后回"做完了"。
 * @param continueTimes 前几次要接着做。
 * @param seenTexts 每次调用时把看到的用户消息原文记进来，供断言上下文有没有被污染。
 * @returns 假的 Ai。
 */
function fakeAi(continueTimes: number, seenTexts: string[][]): modelModule.Ai {
  /** 已经调了几次常规模型。 */
  let calls = 0;
  return {
    chat: (input) => {
      calls += 1;
      //M 把这次看到的全部用户消息文字记下来，用来验证任务原文有没有被重复塞。
      seenTexts.push(input.messages.filter((item) => item.role === 'user').map((item) => JSON.stringify(item.content)));
      /** 这次的回复文字。 */
      const text = calls <= continueTimes ? `第 ${calls} 步做了点事` : '全部做完了';
      return Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text }] } as unknown as modelModule.ChatOutput['message'],
        text,
        thinking: '',
        toolCalls: [],
        ms: 1,
        request: { model: 'fake/m1', thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] },
      });
    },
    //M 判断：前 continueTimes 步说"接着做"，之后说"做完了"。走的是真实的决策路径。
    decide: (input) => Promise.resolve({
      answers: { next_step: { type: 'choice', choice: calls <= continueTimes ? 'continue' : 'done', probabilities: { continue: 0.9, done: 0.1 } } } as unknown as modelModule.DecideOutput['answers'],
      ms: 1,
      request: { model: 'fake/d1', state: input.state, questions: input.questions },
    }),
    hasDecision: () => true,
    listModels: () => [
      { id: 'fake/m1', name: 'm1', kind: 'chat', contextWindow: 8000, thinking: ['off'], price: { input: 0, output: 0 } },
      { id: 'fake/d1', name: 'd1', kind: 'decision', contextWindow: 8000, thinking: ['off'], price: { input: 0, output: 0 } },
    ],
  };
}


bunTest.test('一次 run 一步：判断说接着做就写成新事件，链条自己走到底，任务原文只进上下文一次', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 每次调模型时看到的用户消息。 */
    const seenTexts: string[][] = [];
    /** 引擎：前两次接着做，第三次做完。 */
    const engine = engineModule.createEngine({ resources, store, ai: fakeAi(2, seenTexts), owner: 'test@1' });

    /** 提交的任务。 */
    const submitted = engine.submit({ input: '把这件事做完', source: '命令行', bot: BOT });
    await engine.runPending(submitted.sessionId);
    /** 做完后的会话。 */
    const session = await engine.waitIdle(submitted.sessionId);

    //M 1. 链条走完了，最后一步的回复发出去了。
    bunTest.expect(session.status).toBe('空闲');
    bunTest.expect(session.lastReply).toBe('全部做完了');
    //M 2. 一共三步，每步一个 execution 事件——这就是"一次 run 一步"。
    bunTest.expect(store.countSteps(submitted.sessionId)).toBe(3);
    bunTest.expect(seenTexts).toHaveLength(3);
    //M 3. 走完之后才没有未完成的事。
    bunTest.expect(store.hasUnfinished(submitted.sessionId)).toBe(false);

    //M 4. **最要紧的一条**：第三次调模型时，任务原文仍然只出现一次。
    //  要是 buildContext 给每个 execution 事件都塞一遍用户消息，这里会是 3。
    /** 最后一次看到的用户消息里，含任务原文的有几条。 */
    const taskLines = (seenTexts[2] ?? []).filter((line) => line.includes('把这件事做完'));
    bunTest.expect(taskLines).toHaveLength(1);

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('一次 run 一步：第一步做完后会话仍有未完成的事，waitIdle 不会提前返回', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 引擎：一直接着做，这样我们能停在半路看。 */
    const engine = engineModule.createEngine({ resources, store, ai: fakeAi(5, []), owner: 'test@1' });
    /** 提交的任务。 */
    const submitted = engine.submit({ input: '走几步看看', source: '命令行', bot: BOT });

    //M 只领一个事件、只跑一步，不用 runPending（它会一路跑到底）。
    /** 领到的第一步。 */
    const first = store.claimNextExecution(submitted.sessionId, 'test@1');
    bunTest.expect(first).toBeDefined();
    await engine.runOneStep(first!);

    //G 第一步已经 completed，但下一步已经插好了，所以会话仍然"有没做完的事"。
    bunTest.expect(store.getEvent(first?.id ?? 0)?.status).toBe('completed');
    bunTest.expect(store.hasUnfinished(submitted.sessionId)).toBe(true);
    bunTest.expect(store.countSteps(submitted.sessionId)).toBe(2);

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
