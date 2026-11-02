/** Log.ts 的离线测试：在临时目录里建一个对话，写几步记录，看文件名、请求文件和给人看的 Markdown。不调模型。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as log from '../src/Log.ts';
import * as memory from '../src/Memory.ts';
import type * as model from '../src/Model.ts';
import * as runtime from '../src/Runtime.ts';
import * as utils from '../src/Utils.ts';


/** 每个用例自己的临时目录；用例结束后删除。 */
let tempDir = '';


/** 每个用例自己的对话，在“日常”工作区里。 */
let conversation: memory.Conversation;


test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zbots-log-'));
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
  /** 运行时。 */
  const zbots = await runtime.loadRuntime(['--config', configFile]);
  conversation = await memory.createConversation(zbots, { title: '读笔记', bot: '周小灵', workspace: '日常', from: '命令行' });
});


test.afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});


/**
 * 造一次模型调用的结果，像 Model.ts 的 chat() 返回的那样。
 * @param text 模型的回复文字。
 * @param toolCalls 模型要的工具调用。
 */
function fakeChat(text: string, toolCalls: piAi.ToolCall[]): model.ChatOutput {
  /** 模型的思考，里面故意带一行像标题的文字。 */
  const thinking = '先读文件。\n## 不是标题';
  /** 用量。 */
  const usage: piAi.Usage = {
    input: 1200,
    output: 80,
    cacheRead: 1000,
    cacheWrite: 0,
    totalTokens: 1280,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking }, { type: 'text', text }, ...toolCalls],
      api: 'openai-completions',
      provider: 'magpie',
      model: 'workbuddy/deepseek-v4.1-flash',
      usage,
      stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    },
    text,
    thinking,
    toolCalls,
    ms: 3200,
    request: {
      role: 'work',
      model: 'magpie/workbuddy/deepseek-v4.1-flash',
      thinkingAsked: 'high',
      thinking: 'high',
      system: '你是周小灵。',
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: '读一下 todo.md', timestamp: 1 }],
    },
  };
}


test.test('写一步：步数加一，文件名是“时间 ID_第几步”，.json 存请求，.md 给人看', async () => {
  /** 模型要的工具调用。 */
  const call: piAi.ToolCall = { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'todo.md' } };
  /** 决策门的回答。 */
  const decision: model.DecideOutput = {
    answers: { tool_safe: { type: 'bool', probability: 0.97 }, on_track: { type: 'bool', probability: 0.88 } },
    ms: 400,
    request: { model: 'magpie/openrouter/typesafe/jev-1.14', state: { 工具: 'read' }, questions: {} },
  };
  const name = await log.writeStep(conversation, {
    kind: '执行',
    chat: fakeChat('我先读一下。', [call]),
    decisions: [{ about: '第一步：安全吗、思路对吗', output: decision, verdict: '放行' }],
    // 工具结果里故意带一个代码块：外面的围栏要比它长，才不会提前结束。
    tools: [{ call, result: '- 买菜\n```\n代码块\n```', isError: false, ms: 120 }],
  });

  assert.match(name, /^\d{17}[a-z]{3}_1$/);
  assert.equal(conversation.info.steps, 1);

  /** .json 里的请求。 */
  const request = JSON.parse(await fs.readFile(path.join(conversation.dir, `${name}.json`), 'utf8')) as {
    step: number;
    kind: string;
    chat: model.ChatRequest;
    decisions: { about: string; model: string }[];
  };
  assert.equal(request.step, 1);
  assert.equal(request.kind, '执行');
  assert.equal(request.chat.model, 'magpie/workbuddy/deepseek-v4.1-flash');
  assert.equal(request.chat.system, '你是周小灵。');
  assert.equal(request.chat.tools[0]?.name, 'read');
  assert.deepEqual(request.decisions.map((item) => [item.about, item.model]), [['第一步：安全吗、思路对吗', 'magpie/openrouter/typesafe/jev-1.14']]);

  /** .md 全文。 */
  const text = await fs.readFile(path.join(conversation.dir, `${name}.md`), 'utf8');
  assert.ok(text.startsWith('# 第 1 步 · 执行 · '));
  assert.ok(text.includes('- 模型：magpie/workbuddy/deepseek-v4.1-flash；思考强度：要 high，实际 high'));
  assert.ok(text.includes('- 用时 3.2 秒；输入 1200 token（缓存命中 1000），输出 80 token'));
  assert.ok(text.includes(`：${name}.json`));
  assert.ok(text.includes('## 思考\n\n> 先读文件。\n> ## 不是标题\n\n## 回复\n\n我先读一下。'));
  assert.ok(text.includes('## 决策 1：第一步：安全吗、思路对吗\n\n- 结论：放行\n- 回答：tool_safe 0.97，on_track 0.88\n- 用时 0.4 秒'));
  assert.ok(text.includes('## 工具 1：read\n\n参数：\n\n```json\n{\n  "path": "todo.md"\n}\n```'));
  assert.ok(text.includes('结果（正常，用时 0.1 秒）：\n\n````text\n- 买菜\n```\n代码块\n```\n````'));

  /** 存回文件的对话信息。 */
  const saved = (await utils.readYaml(path.join(conversation.dir, '对话.yaml'))) as memory.ConversationInfo;
  assert.equal(saved.steps, 1);
});


test.test('第二步编号接着走；出错、没调工具时也写清楚；索引里的步数跟着变', async () => {
  await log.writeStep(conversation, { kind: '执行', chat: fakeChat('第一句', []), decisions: [], tools: [] });
  /** 出错的一次调用。 */
  const failed: model.ChatOutput = { ...fakeChat('', []), error: '连不上 magpie' };
  const name = await log.writeStep(conversation, { kind: '执行', chat: failed, decisions: [], tools: [] });

  assert.match(name, /^\d{17}[a-z]{3}_2$/);
  /** 第二步的 .md。 */
  const text = await fs.readFile(path.join(conversation.dir, `${name}.md`), 'utf8');
  assert.ok(text.includes('- 出错：连不上 magpie'));
  assert.ok(text.includes('## 回复\n\n（没有文字）'));
  assert.ok(!text.includes('## 工具'));
  assert.ok(!text.includes('## 决策'));

  /** 对话文件夹里的步骤文件，按文件名排序就是按时间排序。 */
  const stepFiles = (await fs.readdir(conversation.dir)).filter((fileName) => fileName.endsWith('.md')).sort();
  assert.deepEqual(stepFiles.map((fileName) => fileName.slice(21)), ['1.md', '2.md']);
  /** 工作区索引。 */
  const indexText = await fs.readFile(path.join(conversation.workspace.dir, '索引.md'), 'utf8');
  assert.ok(indexText.includes('| 读笔记 | 周小灵 | 进行中 | 命令行 | 2 |'));
});
