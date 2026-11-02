/**
 * Model.ts 的离线测试：本机起一个假的 magpie（模型清单、对话、决策三个接口），不联网、不花钱。
 * 重点看发给 magpie 的请求体对不对：系统提示词、思考强度的写法、最大输出字段、决策请求的模型和问题。
 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as model from '../src/Model.ts';
import type * as runtime from '../src/Runtime.ts';


/** 假 magpie 收到的请求：路径和请求体，每个用例开始前清空。 */
const received: { path: string; body: Record<string, unknown> }[] = [];


/** 假 magpie 的模型清单：一个会思考的常规模型、一个没给上下文和最大输出的模型、一个决策模型。 */
const modelList = {
  data: [
    {
      id: 'auto/deepseek-v4.1-flash',
      display_name: 'DeepSeek V4.1 Flash',
      reasoning: true,
      supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }, { effort: 'high' }, { effort: 'max' }],
      context_window: 1000000,
      max_output_tokens: 128000,
      modalities: { input: ['text', 'image'] },
      pricing: { prompt: '0.000002', completion: '0.00001' },
    },
    { id: 'xiaomi/mimo-v2.5-asr', reasoning: false },
    { id: 'openrouter/typesafe/jev-1.14', kind: 'decision' },
  ],
};


/**
 * 一段 OpenAI Chat Completions 的流式回复：先一段文字，再结束原因和用量。
 * @param text 回复的文字。
 */
function streamReply(text: string): Response {
  /** 两个数据块：文字；结束和用量。 */
  const chunks = [
    { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } },
  ];
  /** SSE 正文。 */
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}


/** 假 magpie：GET /v1/models 回清单，POST /v1/chat/completions 回“好”，POST /v1/systemone 回“安全”的概率 0.93。 */
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    /** 请求的路径。 */
    const pathname = new URL(request.url).pathname;
    if (request.method === 'GET' && pathname === '/v1/models') {
      return Response.json(modelList);
    }
    received.push({ path: pathname, body: (await request.json()) as Record<string, unknown> });
    if (pathname === '/v1/chat/completions') {
      return streamReply('好');
    }
    if (pathname === '/v1/systemone') {
      return Response.json({ answers: { tool_safe: { type: 'noul', noul: 0.93 } }, usage: { input_tokens: 20, output_tokens: 1 } });
    }
    return new Response('没有这个接口', { status: 404 });
  },
});


test.afterAll(async () => {
  await server.stop(true);
});


test.beforeEach(() => {
  received.length = 0;
});


/**
 * 测试用的配置：唯一的供应商指向假 magpie；角色 asr 指向清单里没给最大输出的模型。
 * @param baseUrl 供应商地址，默认是假 magpie。
 */
function testConfig(baseUrl = new URL('/v1', server.url).href): runtime.Config {
  return {
    runtime_dir: './runtime',
    providers: {
      magpie: {
        base_url: baseUrl,
        api_key: 'magpie-test',
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
      },
    },
    models: {
      dispatch: { model: 'magpie/auto/deepseek-v4.1-flash', thinking: 'low' },
      work: { model: 'magpie/auto/deepseek-v4.1-flash', thinking: 'medium' },
      evaluate: { model: 'magpie/auto/deepseek-v4.1-flash', thinking: 'low' },
      decision: { model: 'magpie/openrouter/typesafe/jev-1.14' },
      asr: { model: 'magpie/xiaomi/mimo-v2.5-asr' },
    },
    workspaces: { 日常: { description: '测试' } },
  };
}


test.test('常规模型：积木拼成 system 消息，思考强度换成支持的档位，按 magpie 的写法发', async () => {
  const ai = await model.connect(testConfig());
  const reply = await ai.chat({
    role: 'work',
    system: { 角色: '你是测试助手。\n', 空块: '', 规则: '只说中文。' },
    messages: [{ role: 'user', content: '你好', timestamp: Date.now() }],
  });

  assert.equal(reply.error, undefined);
  assert.equal(reply.text, '好');
  assert.deepEqual(reply.toolCalls, []);
  // 配置要 medium，这个模型只有 none、low、high、max，往上换成 high。
  assert.equal(reply.request.thinkingAsked, 'medium');
  assert.equal(reply.request.thinking, 'high');
  assert.equal(reply.request.model, 'magpie/auto/deepseek-v4.1-flash');
  assert.equal(reply.request.system, '你是测试助手。\n\n只说中文。');

  /** 发给 magpie 的请求体。 */
  const sent = received[0]?.body ?? {};
  assert.equal(received[0]?.path, '/v1/chat/completions');
  assert.equal(sent.model, 'auto/deepseek-v4.1-flash');
  assert.equal(sent.reasoning_effort, 'high');
  assert.equal('store' in sent, false);
  assert.equal(typeof sent.max_tokens, 'number');
  /** 请求里的消息：第一条是系统提示词，用 system 角色。 */
  const sentMessages = sent.messages as { role: string; content: unknown }[];
  assert.equal(sentMessages[0]?.role, 'system');
  assert.ok(JSON.stringify(sentMessages[0]?.content).includes('只说中文。'));
});


test.test('常规模型：思考强度 off 按清单里的写法发 none', async () => {
  const ai = await model.connect(testConfig());
  const reply = await ai.chat({ role: 'work', thinking: 'off', system: {}, messages: [{ role: 'user', content: '你好', timestamp: Date.now() }] });

  assert.equal(reply.request.thinking, 'off');
  assert.equal(received[0]?.body.reasoning_effort, 'none');
});


test.test('清单里没给上下文和最大输出的模型不收，用它时报错', async () => {
  const ai = await model.connect(testConfig());
  await assert.rejects(ai.chat({ role: 'asr', system: {}, messages: [] }), /模型清单里没有 xiaomi\/mimo-v2.5-asr/);
});


test.test('决策模型：请求发到 /v1/systemone，真假题按 System One 的写法发，回答换回概率', async () => {
  const ai = await model.connect(testConfig());
  const verdict = await ai.decide({
    state: { 任务: '删掉临时文件' },
    questions: { tool_safe: { type: 'bool', instructions: '安全吗？', criteria: { true: '安全', false: '危险' } } },
  });

  assert.equal(verdict.error, undefined);
  assert.deepEqual(verdict.answers.tool_safe, { type: 'bool', probability: 0.93 });
  assert.equal(verdict.request.model, 'magpie/openrouter/typesafe/jev-1.14');
  assert.equal(received[0]?.path, '/v1/systemone');
  assert.equal(received[0]?.body.model, 'openrouter/typesafe/jev-1.14');
  assert.deepEqual(received[0]?.body.state, { 任务: '删掉临时文件' });
  assert.equal((received[0]?.body.questions as Record<string, { type: string }>).tool_safe?.type, 'noul');
});


test.test('连不上供应商时 connect 报错，说清是哪个供应商', async () => {
  // 先起再停一个服务，拿到一个肯定没人监听的端口。
  const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  /** 已经没人监听的地址。 */
  const deadUrl = new URL('/v1', closed.url).href;
  await closed.stop(true);
  await assert.rejects(model.connect(testConfig(deadUrl)), /供应商 magpie/);
});


test.test('思考强度写错了直接报错，不悄悄换成最低档', async () => {
  const ai = await model.connect(testConfig());
  await assert.rejects(ai.chat({ role: 'work', thinking: 'medum', system: {}, messages: [] }), /思考强度 medum 写错了/);
});
