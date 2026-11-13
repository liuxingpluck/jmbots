/**
 * 模型供应商接入的离线测试：用 Bun.serve 在本机随机端口起假的 OpenAI 兼容服务（/models 和 /chat/completions），
 * 在临时运行时目录里写两家不同端口、名字不叫 magpie 的供应商，调 modelModule.Ai.connect(resources) 后断言清单合并行为。
 * 不传 piModels 替身（要真连本机假服务），不联网、不碰项目真实的 config.yaml，临时目录和 Files.test.ts 的 setup 一样留着不删。
 *
 * 假服务的 /chat/completions 必须回 SSE 流：Pi 的 openai-completions 实现固定发 stream: true，
 * 且要有一个带 finish_reason 的 chunk，否则 Pi 会以 “Stream ended without finish_reason” 报错。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as modelModule from '../src/capabilities/Model.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 两家供应商的名字（都不叫 magpie）。 */
const ALPHA = 'alpha';
const BETA = 'beta';


/** 假服务 /models 清单里的一项；各家字段写法不同，故意用宽松类型。 */
type FakeEntry = Record<string, unknown>;


/** 起一家假服务时要给的东西。 */
interface FakeOptions {
  /** /models 返回的 data；null 表示返回 500，模拟清单拉不到。不写就是空清单。 */
  entries?: FakeEntry[] | null;
}


/** 一家假服务收到的请求次数。 */
interface FakeHits {
  /** /models 被请求了几次。 */
  models: number;
  /** /chat/completions 被请求了几次。 */
  chat: number;
}


/** 起好的一家假服务。 */
interface Fake {
  /** Bun 的服务本身。 */
  server: ReturnType<typeof Bun.serve>;
  /** 实际监听的端口（port: 0 时由系统分配）。 */
  port: number;
  /** 写进 config.yaml 的 base_url。 */
  baseUrl: string;
  /** 请求计数；和闭包共用同一个对象，实时可读。 */
  hits: FakeHits;
  /** 停止监听（不动任何文件）。 */
  stop: () => void;
}


/**
 * 拼 Pi 认得的 OpenAI 流式响应：两个 chat.completion.chunk（第二个带 finish_reason 和 usage）加 [DONE]。
 * @param model 响应里的模型 ID（Pi 不校验它是否和请求一致）。
 * @returns SSE 正文。
 */
function sseBody(model: string): string {
  /** 拼一条 data 行。 */
  const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>): string => {
    /** 一个 chat.completion.chunk。 */
    const data: Record<string, unknown> = {
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) {
      data.usage = usage;
    }
    return `data: ${JSON.stringify(data)}\n\n`;
  };
  return [
    chunk({ role: 'assistant', content: '假服务回话' }, null),
    chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    'data: [DONE]\n\n',
  ].join('');
}


/**
 * 起一个监听随机端口的 Bun 服务；1024-15000 段偶发 os error 10013 时重试几次。
 * @param handler 请求处理函数。
 * @returns Bun 服务。
 */
function serveWithRetry(handler: (request: Request) => Response): ReturnType<typeof Bun.serve> {
  /** 最后一次的报错。 */
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`起假服务失败（试了 5 次）：${String(last)}`);
}


/**
 * 起一家假的 OpenAI 兼容服务：GET /models 给清单，POST /chat/completions 给流式回话，并记录请求次数。
 * @param options 清单内容；entries 为 null 时 /models 返回 500。
 * @returns 起好的假服务。
 */
function startFake(options: FakeOptions = {}): Fake {
  /** 请求计数。 */
  const hits: FakeHits = { models: 0, chat: 0 };
  /** 只按路径末段认接口，base_url 带不带 /v1 都能用。 */
  const handler = (request: Request): Response => {
    /** 请求的路径。 */
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/models')) {
      hits.models += 1;
      if (options.entries === null) {
        return new Response('清单故意拉不到', { status: 500 });
      }
      return Response.json({ data: options.entries ?? [] });
    }
    if (pathname.endsWith('/chat/completions')) {
      hits.chat += 1;
      return new Response(sseBody('fake-model'), {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }
    return new Response('没有这个接口', { status: 404 });
  };
  /** 系统分配端口的假服务。 */
  const server = serveWithRetry(handler);
  /** 实际端口；port: 0 时由系统分配，没拿到就没法拼 base_url。 */
  const port = server.port;
  if (port === undefined) {
    throw new Error('假服务没拿到端口');
  }
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    stop: () => {
      void server.stop(true);
    },
  };
}


/**
 * 拼一家供应商在 config.yaml 里的段落。
 * @param name 供应商名。
 * @param baseUrl 假服务地址。
 * @param extra 这一家多写的行（api、list_models、models 等），调用方自带缩进。
 * @returns YAML 行。
 */
function providerBlock(name: string, baseUrl: string, extra: string[] = []): string[] {
  return [
    `  ${name}:`,
    `    base_url: ${baseUrl}`,
    '    api_key: fake-key-abcdefgh',
    ...extra,
  ];
}


/**
 * 建临时运行时目录，写只含两家假供应商的 config.yaml（不读、不打印项目真实的 config.yaml）。
 * 和 tests/Files.test.ts 的 setup 一样，临时目录留着不删。
 * @param providers providers 段里两家的完整 YAML 行。
 * @param defaultModel 默认模型 ID（写成“家名/模型”）。
 * @returns 运行时目录。
 */
function makeDir(providers: string[], defaultModel: string): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-providers-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), [
    'providers:',
    ...providers,
    `default_model: ${defaultModel}`,
    'bots:',
    '  - name: 助手',
    '    language: zh',
  ].join('\n'));
  return dir;
}


/**
 * 在临时目录里连上模型库（不传 piModels 替身，真连本机假服务）。
 * @param dir 运行时目录。
 * @returns 模型库。
 */
async function connect(dir: string): Promise<modelModule.Ai> {
  return modelModule.Ai.connect(await resourcesModule.Resources.load(dir));
}


/**
 * 从 listModels() 里按 ID 找一项。
 * @param ai 模型库。
 * @param id 供应商/模型 ID。
 * @returns 找到的那一项；没找到是 undefined。
 */
function find(ai: modelModule.Ai, id: string): modelModule.ModelSummary | undefined {
  return ai.listModels().find((item) => item.id === id);
}


/**
 * 用「家名/模型」调一次最简单的对话。
 * @param ai 模型库。
 * @param model 供应商/模型 ID。
 * @returns 对话结果。
 */
function chat(ai: modelModule.Ai, model: string): Promise<modelModule.ChatOutput> {
  return ai.chat({ model, system: {}, messages: [], tools: [] });
}


/**
 * 关掉这个用例起的全部假服务（停止监听，不删文件）。
 * @param fakes 假服务。
 * @returns 无。
 */
function stopAll(fakes: Fake[]): void {
  for (const fake of fakes) {
    fake.stop();
  }
}


bunTest.test('a. 清单只给 {id}：embedding 不收、其余全收，contextWindow=128000、vision=false，chat 用「家名/模型」能调通', async () => {
  /** 家 A：两个普通模型加一个 embedding 模型。 */
  const alpha = startFake({ entries: [{ id: 'chat-a' }, { id: 'chat-b' }, { id: 'text-embedding-3-small' }] });
  /** 家 B：不同端口，同样只给 {id}。 */
  const beta = startFake({ entries: [{ id: 'chat-c' }] });
  /** 临时运行时目录。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/chat-a`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 列出来的全部模型 ID。 */
    const ids = ai.listModels().map((item) => item.id);
    bunTest.expect(ids).toContain(`${ALPHA}/chat-a`);
    bunTest.expect(ids).toContain(`${ALPHA}/chat-b`);
    bunTest.expect(ids).toContain(`${BETA}/chat-c`);
    bunTest.expect(ids).not.toContain(`${ALPHA}/text-embedding-3-small`);
    /** 只给 ID 时上下文长度用保守值 128000，看不了图。 */
    const one = find(ai, `${ALPHA}/chat-a`);
    bunTest.expect(one?.contextWindow).toBe(128000);
    bunTest.expect(one?.vision).toBe(false);
    /** 另一家也一样。 */
    const other = find(ai, `${BETA}/chat-c`);
    bunTest.expect(other?.contextWindow).toBe(128000);
    bunTest.expect(other?.vision).toBe(false);
    /** 两家都真的被拉过清单。 */
    bunTest.expect(alpha.hits.models).toBeGreaterThan(0);
    bunTest.expect(beta.hits.models).toBeGreaterThan(0);
    /** 用「家名/模型」调 chat，假 /chat/completions 的流式回应要能被 Pi 接受。 */
    const output = await chat(ai, `${ALPHA}/chat-a`);
    bunTest.expect(output.error).toBeUndefined();
    bunTest.expect(alpha.hits.chat).toBeGreaterThan(0);
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('b. 清单带 context_window / max_output_tokens：缺参数的那个不收，给全的照收', async () => {
  /** 家 A：一个参数给全，一个只给了 context_window。 */
  const alpha = startFake({ entries: [
    { id: 'full-a', context_window: 32000, max_output_tokens: 4096 },
    { id: 'missing-a', context_window: 16000 },
  ] });
  /** 家 B：只给 {id}，不受 detailed 影响。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/full-a`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 列出来的全部模型 ID。 */
    const ids = ai.listModels().map((item) => item.id);
    bunTest.expect(ids).toContain(`${ALPHA}/full-a`);
    bunTest.expect(ids).not.toContain(`${ALPHA}/missing-a`);
    /** 给全的那个用清单里的上下文长度。 */
    bunTest.expect(find(ai, `${ALPHA}/full-a`)?.contextWindow).toBe(32000);
    /** 别家照常。 */
    bunTest.expect(ids).toContain(`${BETA}/chat-b`);
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('c. OpenRouter 写法认得：context_length、top_provider.max_completion_tokens、architecture.input_modalities 含 image 时 vision=true', async () => {
  /** 家 A：一个能看图、一个只能看字，字段全用 OpenRouter 的写法。 */
  const alpha = startFake({ entries: [
    { id: 'vision-pro', context_length: 200000, top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'text-only', context_length: 64000, top_provider: { max_completion_tokens: 4096 }, architecture: { input_modalities: ['text'] } },
  ] });
  /** 家 B：普通清单。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/vision-pro`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 能看图的模型。 */
    const vision = find(ai, `${ALPHA}/vision-pro`);
    bunTest.expect(vision?.contextWindow).toBe(200000);
    bunTest.expect(vision?.vision).toBe(true);
    /** 只能看字的模型。 */
    const textOnly = find(ai, `${ALPHA}/text-only`);
    bunTest.expect(textOnly?.contextWindow).toBe(64000);
    bunTest.expect(textOnly?.vision).toBe(false);
    /** 别家照常。 */
    bunTest.expect(ai.listModels().map((item) => item.id)).toContain(`${BETA}/chat-b`);
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('d1. providers.<名字>.models 手写覆盖清单：vision、context_window 生效，清单里没有的手写 id 也会列出来', async () => {
  /** 家 A：清单里 manual-a 只给 text、上下文 8000。 */
  const alpha = startFake({ entries: [
    { id: 'manual-a', context_window: 8000, max_output_tokens: 1024, modalities: { input: ['text'] } },
  ] });
  /** 家 B：普通清单。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录；手写把 manual-a 改成能看图、上下文 65536，另加一个清单没有的 extra-a。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl, [
      '    models:',
      '      manual-a:',
      '        vision: true',
      '        context_window: 65536',
      '      extra-a:',
      '        context_window: 4096',
      '        max_output_tokens: 512',
    ]),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/manual-a`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 手写的优先于清单。 */
    const manual = find(ai, `${ALPHA}/manual-a`);
    bunTest.expect(manual?.contextWindow).toBe(65536);
    bunTest.expect(manual?.vision).toBe(true);
    /** 清单里没有、只在手写里出现的模型也会被加进列表。 */
    const extra = find(ai, `${ALPHA}/extra-a`);
    bunTest.expect(extra?.contextWindow).toBe(4096);
    bunTest.expect(extra?.vision).toBe(false);
    /** 别家照常。 */
    bunTest.expect(ai.listModels().map((item) => item.id)).toContain(`${BETA}/chat-b`);
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('d2. list_models: false 时不请求 /models，只用 config 里手写的模型', async () => {
  /** 家 A：服务在、清单也有，但配置写了不拉清单。 */
  const alpha = startFake({ entries: [{ id: 'listed-a' }] });
  /** 家 B：正常拉清单。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl, [
      '    list_models: false',
      '    models:',
      '      offline-a:',
      '        context_window: 32768',
    ]),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/offline-a`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 家 A 一次 /models 都没请求，家 B 请求了。 */
    bunTest.expect(alpha.hits.models).toBe(0);
    bunTest.expect(beta.hits.models).toBeGreaterThan(0);
    /** 只有手写的模型，没有清单里的那个。 */
    const ids = ai.listModels().map((item) => item.id);
    bunTest.expect(ids).toContain(`${ALPHA}/offline-a`);
    bunTest.expect(ids).not.toContain(`${ALPHA}/listed-a`);
    bunTest.expect(find(ai, `${ALPHA}/offline-a`)?.contextWindow).toBe(32768);
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('e. 一家端口没人听：connect 不抛错，另一家照常能用，listModels() 只有连上的那家', async () => {
  /** 借系统分配一个端口，立刻关掉服务，保证这个端口没人听。 */
  const dead = startFake();
  /** 没人听的地址。 */
  const deadUrl = dead.baseUrl;
  dead.stop();
  /** 另一家正常服务。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, deadUrl),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${BETA}/chat-b`);
  try {
    /** connect 不该抛错，只把连不上的那家跳过。 */
    const ai = await connect(dir);
    /** 列出来的全部模型 ID。 */
    const ids = ai.listModels().map((item) => item.id);
    bunTest.expect(ids.some((id) => id.startsWith(`${ALPHA}/`))).toBe(false);
    bunTest.expect(ids).toContain(`${BETA}/chat-b`);
    /** 连上的那家照常能对话。 */
    const output = await chat(ai, `${BETA}/chat-b`);
    bunTest.expect(output.error).toBeUndefined();
  } finally {
    stopAll([beta]);
  }
});


bunTest.test('f. api 写错的那家被跳过，不挡别家', async () => {
  /** 家 A：服务正常，但 api 写成不认识的值。 */
  const alpha = startFake({ entries: [{ id: 'chat-a' }] });
  /** 家 B：正常。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl, ['    api: bogus-api']),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${BETA}/chat-b`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 列出来的全部模型 ID。 */
    const ids = ai.listModels().map((item) => item.id);
    bunTest.expect(ids.some((id) => id.startsWith(`${ALPHA}/`))).toBe(false);
    bunTest.expect(ids).toContain(`${BETA}/chat-b`);
    /** 协议检查在拉清单之前，所以那家连 /models 都不该被请求。 */
    bunTest.expect(alpha.hits.models).toBe(0);
    /** 别家照常能对话。 */
    const output = await chat(ai, `${BETA}/chat-b`);
    bunTest.expect(output.error).toBeUndefined();
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('g. /models 拉不到（返回 500）但手写了模型：用手写的', async () => {
  /** 家 A：/models 返回 500，/chat/completions 仍然可用。 */
  const alpha = startFake({ entries: null });
  /** 家 B：正常。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录；家 A 手写一个模型。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl, [
      '    models:',
      '      fallback-a:',
      '        context_window: 32768',
      '        max_output_tokens: 2048',
    ]),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/fallback-a`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 清单确实被请求过，只是没拉到。 */
    bunTest.expect(alpha.hits.models).toBeGreaterThan(0);
    /** 手写的模型照样在列表里，参数用手写的。 */
    const one = find(ai, `${ALPHA}/fallback-a`);
    bunTest.expect(one?.contextWindow).toBe(32768);
    bunTest.expect(one?.vision).toBe(false);
    /** 别家照常。 */
    bunTest.expect(ai.listModels().map((item) => item.id)).toContain(`${BETA}/chat-b`);
    /** 手写模型照样能对话（/chat/completions 不受 /models 影响）。 */
    const output = await chat(ai, `${ALPHA}/fallback-a`);
    bunTest.expect(output.error).toBeUndefined();
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('h. 启动时 /models 拉不到、用了手写的；之后拉得到了，reconnect 原地换成新清单', async () => {
  /** 家 A 的清单：先拉不到，后面改成拉得到（假服务每次请求都读它）。 */
  const alphaOptions: FakeOptions = { entries: null };
  /** 家 A。 */
  const alpha = startFake(alphaOptions);
  /** 家 B：正常。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录；家 A 手写一个模型。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl, [
      '    models:',
      '      fallback-a:',
      '        context_window: 32768',
      '        max_output_tokens: 2048',
    ]),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/fallback-a`);
  try {
    /** 模型库：启动时家 A 只有手写的。 */
    const ai = await connect(dir);
    bunTest.expect(find(ai, `${ALPHA}/listed-a`)).toBeUndefined();

    //M 家 A 还是拉不到：说没连上、写明原因，手写的照旧在。
    /** 第一次重连的结果。 */
    const failed = await ai.reconnect(ALPHA);
    bunTest.expect(failed).toHaveLength(1);
    bunTest.expect(failed[0]?.ok).toBe(false);
    bunTest.expect(failed[0]?.error).toContain('HTTP 500');
    bunTest.expect(failed[0]?.models).toBe(1);
    bunTest.expect(find(ai, `${ALPHA}/fallback-a`)).toBeDefined();

    //M 家 A 拉得到了：换成清单加手写的，新拉到的能对话。
    alphaOptions.entries = [{ id: 'listed-a' }];
    /** 第二次重连的结果。 */
    const connected = await ai.reconnect(ALPHA);
    bunTest.expect(connected[0]?.ok).toBe(true);
    bunTest.expect(connected[0]?.error).toBeUndefined();
    bunTest.expect(connected[0]?.models).toBe(2);
    bunTest.expect(find(ai, `${ALPHA}/fallback-a`)).toBeDefined();
    /** 新拉到的模型对话的结果。 */
    const output = await chat(ai, `${ALPHA}/listed-a`);
    bunTest.expect(output.error).toBeUndefined();
    /** 别家没受影响。 */
    bunTest.expect(find(ai, `${BETA}/chat-b`)).toBeDefined();
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('i. reconnect 不给供应商就每家都重连、各回一条；给了配置里没有的抛错', async () => {
  /** 两家都正常。 */
  const alpha = startFake({ entries: [{ id: 'chat-a' }] });
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${ALPHA}/chat-a`);
  try {
    /** 模型库。 */
    const ai = await connect(dir);
    /** 启动时两家一共拉了几次清单。 */
    const before = alpha.hits.models + beta.hits.models;
    /** 每家都重连的结果。 */
    const results = await ai.reconnect();
    bunTest.expect(results.map((item) => item.provider)).toEqual([ALPHA, BETA]);
    bunTest.expect(results.every((item) => item.ok)).toBe(true);
    bunTest.expect(alpha.hits.models + beta.hits.models).toBe(before + 2);
    /** 配置里没有的那家：抛的错。 */
    let thrown = '';
    try {
      await ai.reconnect('nobody');
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    bunTest.expect(thrown).toContain('providers 里没有 nobody');
  } finally {
    stopAll([alpha, beta]);
  }
});


bunTest.test('j. 启动时清单拉不到、又没手写模型的那家：reconnect 拉到了就能用', async () => {
  /** 家 A 的清单：先拉不到，后面改成拉得到。 */
  const alphaOptions: FakeOptions = { entries: null };
  /** 家 A。 */
  const alpha = startFake(alphaOptions);
  /** 家 B：正常。 */
  const beta = startFake({ entries: [{ id: 'chat-b' }] });
  /** 临时运行时目录；家 A 没手写模型。 */
  const dir = makeDir([
    ...providerBlock(ALPHA, alpha.baseUrl),
    ...providerBlock(BETA, beta.baseUrl),
  ], `${BETA}/chat-b`);
  try {
    /** 模型库：启动时家 A 一个模型都没有。 */
    const ai = await connect(dir);
    /** 启动时家 A 的模型。 */
    const alphaModels = ai.listModels().filter((item) => item.id.startsWith(`${ALPHA}/`));
    bunTest.expect(alphaModels).toHaveLength(0);
    alphaOptions.entries = [{ id: 'chat-a' }];
    /** 重连的结果。 */
    const results = await ai.reconnect(ALPHA);
    bunTest.expect(results[0]?.ok).toBe(true);
    bunTest.expect(results[0]?.models).toBe(1);
    bunTest.expect(find(ai, `${ALPHA}/chat-a`)).toBeDefined();
  } finally {
    stopAll([alpha, beta]);
  }
});
