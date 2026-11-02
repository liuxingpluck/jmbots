/** Agent.ts、Judge.ts 的离线测试：假模型（Fakes.ts）按写好的剧本回答，看一轮怎么走、记了什么。不联网、不花钱。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as agent from '../src/Agent.ts';
import type * as bot from '../src/Bot.ts';
import * as memory from '../src/Memory.ts';
import type * as model from '../src/Model.ts';
import * as runtime from '../src/Runtime.ts';
import * as utils from '../src/Utils.ts';
import * as fakes from './Fakes.ts';


/** 每个用例自己的临时目录；用例结束后删除。 */
let tempDir = '';


/** 每个用例自己的运行时。 */
let zbots: runtime.Runtime;


/** 每个用例自己的对话，在“日常”工作区里。 */
let conversation: memory.Conversation;


/** 测试用的设置：问法和 config.example.yaml 的一样意思，写短一点。一轮被拦超过 1 次就停。 */
const settings: agent.AgentSettings = {
  maxSteps: 5,
  checkTools: ['shell'],
  passProbability: 0.5,
  maxBlocks: 1,
  toolSafe: { type: 'bool', instructions: '安全吗？', criteria: { true: '安全', false: '危险' } },
  nextStep: { type: 'choice', instructions: '下一步怎么走？', criteria: { continue: '接着做', done: '做完了', ask_user: '问用户', block: '停下' } },
};


/** 测试用的 bot：周小灵能转交给资料员；“严格的”由判断员判断。 */
const bots: Record<string, bot.BotDefinition> = {
  周小灵: { name: '周小灵', description: '聊天', system: { 身份: '你是周小灵。' }, tools: ['shell', 'read'], judge: 'decision', routes: ['资料员'] },
  资料员: { name: '资料员', description: '查资料', system: { 身份: '你是资料员。' }, tools: ['read'], judge: 'decision', routes: [] },
  严格的: { name: '严格的', description: '由判断员判断', system: { 身份: '你很严格。' }, tools: [], judge: '判断员', routes: ['资料员'] },
  判断员: { name: '判断员', description: '判断下一步', system: { 身份: '你是判断员。' }, tools: [], judge: 'decision', routes: [] },
};


test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zbots-agent-'));
  /** 配置文件路径。 */
  const configFile = path.join(tempDir, 'config.yaml');
  await utils.writeYaml(configFile, {
    providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1', api_key: 'magpie-test' } },
    models: {
      dispatch: { model: 'magpie/workbuddy/deepseek-v4.1-flash' },
      work: { model: 'magpie/workbuddy/deepseek-v4.1-flash' },
      evaluate: { model: 'magpie/workbuddy/deepseek-v4.1-flash' },
      decision: { model: 'magpie/openrouter/typesafe/jev-1.14' },
    },
    workspaces: { 日常: { description: '日常问答' } },
  });
  zbots = await runtime.loadRuntime(['--config', configFile]);
  conversation = await memory.createConversation(zbots, { title: '测试', bot: '周小灵', workspace: '日常', from: '命令行' });
});


test.afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});


/**
 * 决策模型的回答：安全题按 safe 给概率；“下一步怎么走”按顺序从 nextSteps 里取，取完了选 done。
 * @param nextSteps 每次“下一步怎么走”选什么，按先后。
 * @param safe 安全题回答“安全”的概率。
 */
function answers(nextSteps: string[], safe = 0.9): (input: model.DecideInput) => Record<string, piAi.ClassifierAnswer> {
  /** 还没用的选择。 */
  const queue = [...nextSteps];
  return (input): Record<string, piAi.ClassifierAnswer> => {
    if (input.questions.tool_safe) {
      return { tool_safe: { type: 'bool', probability: safe } };
    }
    /** 这次选什么。 */
    const choice = queue.shift() ?? 'done';
    return { next_step: { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 } };
  };
}


/**
 * 假工具：记下每次调用的参数，回一句固定的结果。
 * @param name 工具名。
 * @param calls 调用参数记到这里。
 */
function fakeTool(name: string, calls: piAi.JsonObject[]): agent.AgentTool {
  return {
    definition: { name, description: `${name} 工具`, parameters: piAi.Type.Object({}) },
    execute: (args) => {
      calls.push(args);
      return Promise.resolve(`${name} 的结果`);
    },
  };
}


/**
 * 读第几步的 .md 记录。
 * @param stepNumber 第几步。
 */
async function readStep(stepNumber: number): Promise<string> {
  /** 这一步的文件名。 */
  const fileName = (await fs.readdir(conversation.dir)).find((item) => item.endsWith(`_${stepNumber}.md`));
  assert.ok(fileName, `没有第 ${stepNumber} 步的记录`);
  return fs.readFile(path.join(conversation.dir, fileName), 'utf8');
}


/**
 * 跑一轮，只换剧本和起头的 bot。
 * @param fake 假模型。
 * @param botName 起头的 bot。
 * @param tools 工具。
 */
function run(fake: fakes.FakeAi, botName = '周小灵', tools: agent.AgentTool[] = []): Promise<agent.RoundResult> {
  return agent.runRound({ ai: fake.ai, conversation, bots, botName, task: '帮我看看', tools, settings });
}


test.test('聊天：模型直接回答，分类模型判 done，就把回答回给用户', async () => {
  const fake = fakes.createFakeAi([{ text: '你好呀' }], answers(['done']));
  const result = await run(fake);

  assert.deepEqual(result, { reply: '你好呀', ending: 'done', steps: 1 });
  assert.equal(fake.chats[0]?.role, 'work');
  assert.deepEqual(fake.chats[0]?.system, { 身份: '你是周小灵。' });
  // “下一步怎么走”的选项里，多了转交给资料员。
  /** 下一步题。 */
  const question = fake.decisions[0]?.questions.next_step;
  assert.ok(question?.type === 'choice' && 'route:资料员' in question.criteria);
  // 上下文存下了用户的话和模型的回答；记了一步。
  assert.deepEqual((await memory.loadContext(conversation)).map((message) => message.role), ['user', 'assistant']);
  assert.equal(conversation.info.steps, 1);
  assert.ok((await readStep(1)).includes('## 决策 1：下一步怎么走\n\n- 结论：done：done 0.90'));
});


test.test('工具：shell 先过安全门，被拦下不执行；read 不用问；判 continue 接着走，第二步判 done', async () => {
  /** read、shell 收到的参数。 */
  const readCalls: piAi.JsonObject[] = [];
  const shellCalls: piAi.JsonObject[] = [];
  const fake = fakes.createFakeAi(
    [
      { text: '先看文件，再清理。', toolCalls: [{ name: 'read', arguments: { path: 'a.txt' } }, { name: 'shell', arguments: { command: 'Remove-Item -Recurse C:\\' } }] },
      { text: '那就不删了。' },
    ],
    answers(['continue', 'done'], 0.01),
  );
  const result = await run(fake, '周小灵', [fakeTool('read', readCalls), fakeTool('shell', shellCalls)]);

  assert.deepEqual(result, { reply: '那就不删了。', ending: 'done', steps: 2 });
  assert.deepEqual(readCalls, [{ path: 'a.txt' }]);
  assert.deepEqual(shellCalls, []);
  assert.deepEqual(fake.decisions.map((item) => Object.keys(item.questions)), [['tool_safe'], ['next_step'], ['next_step']]);
  // 第二次调模型时，上下文里有两条工具结果，shell 那条是被拦下的。
  /** 第二次调模型时的工具结果。 */
  const results = (fake.chats[1]?.messages ?? []).filter((message): message is piAi.ToolResultMessage => message.role === 'toolResult');
  assert.deepEqual(results.map((message) => [message.toolName, message.isError]), [['read', false], ['shell', true]]);
  assert.ok((await readStep(1)).includes('- 结论：拦下（安全 0.01，低于 0.5）'));
});


test.test('这一步调了工具时判 done 也接着走；没调工具判 continue 时催一句', async () => {
  const fake = fakes.createFakeAi(
    [{ text: '先读一下', toolCalls: [{ name: 'read', arguments: { path: 'a.txt' } }] }, { text: '读完了，再想想' }, { text: '答案是 42' }],
    answers(['done', 'continue', 'done']),
  );
  const result = await run(fake, '周小灵', [fakeTool('read', [])]);

  assert.deepEqual(result, { reply: '答案是 42', ending: 'done', steps: 3 });
  /** 第三次调模型时上下文的最后一条。 */
  const last = fake.chats[2]?.messages.at(-1);
  assert.ok(last?.role === 'user' && last.content === '（还没做完，请接着做。）');
});


test.test('转交：分类模型选 route:资料员，下一步换资料员执行，上下文共用', async () => {
  const fake = fakes.createFakeAi([{ text: '这个要查资料' }, { text: '查到了：在第 3 页' }], answers(['route:资料员', 'done']));
  const result = await run(fake);

  assert.deepEqual(result, { reply: '查到了：在第 3 页', ending: 'done', steps: 2 });
  assert.deepEqual(fake.chats[1]?.system, { 身份: '你是资料员。' });
  /** 转交时接进上下文的话。 */
  const handover = fake.chats[1]?.messages.at(-1);
  assert.ok(handover?.role === 'user' && typeof handover.content === 'string' && handover.content.includes('周小灵 把任务转交给 资料员'));
  // 资料员不能再转交，它的“下一步怎么走”里没有 route 选项。
  /** 资料员那一步的下一步题。 */
  const question = fake.decisions[1]?.questions.next_step;
  assert.ok(question?.type === 'choice' && !Object.keys(question.criteria).some((key) => key.startsWith('route:')));
});


test.test('判断者是别的 bot：它回 JSON，提醒接进上下文；回的不是 JSON 时按默认规则走', async () => {
  const fake = fakes.createFakeAi(
    [
      { text: '第一步的回答' },
      { text: '好的：{"action": "continue", "message": "再核对一下数字"}' },
      { text: '核对过了，是 42' },
      { text: '我觉得可以了' },
    ],
    answers([]),
  );
  const result = await run(fake, '严格的');

  assert.deepEqual(result, { reply: '核对过了，是 42', ending: 'done', steps: 2 });
  assert.equal(fake.chats[1]?.role, 'dispatch');
  assert.deepEqual(fake.chats[1]?.system, { 身份: '你是判断员。' });
  /** 第二次执行时上下文的最后一条：判断员的提醒。 */
  const reminder = fake.chats[2]?.messages.at(-1);
  assert.ok(reminder?.role === 'user' && reminder.content === '（再核对一下数字）');
  // 判断员的两次也各记一步：执行、判断、执行、判断。没问分类模型。
  assert.equal(conversation.info.steps, 4);
  assert.ok((await readStep(2)).startsWith('# 第 2 步 · 判断（判断员）'));
  assert.deepEqual(fake.decisions, []);
});


test.test('出错：模型出错就停下；一轮里被拦超过上限也停下', async () => {
  const failed = await run(fakes.createFakeAi([{ text: '', error: '连不上 magpie' }], answers([])));
  assert.equal(failed.ending, 'error');
  assert.match(failed.reply, /连不上 magpie/);

  const fake = fakes.createFakeAi(
    [{ text: '删两个', toolCalls: [{ name: 'shell', arguments: { command: 'a' } }, { name: 'shell', arguments: { command: 'b' } }] }],
    answers(['continue'], 0.1),
  );
  const stopped = await run(fake, '周小灵', [fakeTool('shell', [])]);
  assert.equal(stopped.ending, 'error');
  assert.match(stopped.reply, /2 个操作被决策模型判为不安全/);
});


test.test('读设置：缺 agent、decision 段或问题就报错，齐了就换成执行设置', () => {
  assert.throws(() => agent.readSettings(zbots.config), /缺 agent 或 decision 段/);
  /** 只有 tool_safe、缺 next_step 的决策设置。 */
  const decision: runtime.DecisionConfig = { check_tools: ['shell'], pass_probability: 0.6, max_blocks: 2, questions: { tool_safe: settings.toolSafe } };
  /** 只差 next_step 的配置。 */
  const partial: runtime.Config = { ...zbots.config, agent: { max_steps: 3 }, decision };
  assert.throws(() => agent.readSettings(partial), /要有 tool_safe 和 next_step/);
  /** 齐全的配置。 */
  const complete: runtime.Config = { ...partial, decision: { ...decision, questions: { tool_safe: settings.toolSafe, next_step: settings.nextStep } } };
  assert.deepEqual(agent.readSettings(complete), { ...settings, maxSteps: 3, passProbability: 0.6, maxBlocks: 2 });
});
