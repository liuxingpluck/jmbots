/**
 * web-search 插件防回归与安全边界离线单元测试：
 *   1. 配置校验（readProviders）：类型非法、缺失必填字段、未知 provider、借用供应商地址与密钥、去除尾斜杠；
 *   2. Magpie 搜索协议：正常返回、非字符串对象格式化、HTTP 200 错误文案识别并自动回退下一家；
 *   3. 智谱 MCP Streamable HTTP 协议：JSON 与 SSE 响应解析、Mcp-Session-Id 透传、缺工具/isError 报错；
 *   4. 安全与稳定性边界：密钥在报错中强制脱敏为 ***、AbortSignal 立即终止不再试后续源、MIN_CHARS/MAX_CHARS 边界。
 * 全程仅起 127.0.0.1 临时回环模拟服务，零外网依赖、零副作用。
 * 跑法：bun test ./src7/tests/Audit_WebSearch.test.ts --timeout 60000
 */
import * as bunTest from 'bun:test';
import * as http from 'node:http';
import * as cordis from 'cordis';
import type * as piAi from '@earendil-works/pi-ai';
import type { Session } from '../Sessions.ts';
import * as toolsModule from '../Tools.ts';
import * as webSearchPlugin from '../plugins/web-search/index.ts';


/** 模拟 HTTP 处理器入参。 */
interface MockRequest {
  /** 请求路径。 */
  url: string;
  /** 小写请求头表。 */
  headers: http.IncomingHttpHeaders;
  /** 解析后的 JSON 请求体。 */
  body: Record<string, unknown>;
}

/** 模拟 HTTP 响应结构。 */
interface MockResponse {
  /** HTTP 状态码，默认 200。 */
  status?: number;
  /** 响应头。 */
  headers?: Record<string, string>;
  /** 响应正文文本。 */
  body: string;
}

/** 每个用例结束后按逆序释放的清理函数队列。 */
const closers: Array<() => Promise<unknown> | void> = [];

bunTest.afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/**
 * 启动仅监听 127.0.0.1 随机端口的离线模拟服务，测完自动关闭。
 * @param handler 请求处理回调。
 * @returns 基础地址（无尾斜杠）与已收到的请求记录。
 */
async function startMockServer(
  handler: (req: MockRequest) => Promise<MockResponse> | MockResponse,
): Promise<{ url: string; received: MockRequest[] }> {
  const received: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const rawText = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> = {};
      if (rawText !== '') {
        try {
          parsed = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      const record: MockRequest = {
        url: req.url ?? '/',
        headers: req.headers,
        body: parsed,
      };
      received.push(record);
      void Promise.resolve(handler(record)).then((reply) => {
        const status = reply.status ?? 200;
        const headers = reply.headers ?? { 'content-type': 'application/json' };
        res.writeHead(status, headers);
        res.end(reply.body);
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  closers.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('回环测试端口未拿到有效地址');
  }
  return { url: `http://127.0.0.1:${String(addr.port)}`, received };
}


/** 从 JSON-RPC 请求体安全读取字符串类型的 method 名。 */
function getRpcMethod(body: Record<string, unknown>): string {
  const raw = body['method'];
  if (typeof raw === 'string') return raw;

  return '';
}

/** 构造最小内存会话对象，仅满足 Tools.execute 调用契约。 */
function makeSession(): Session {
  const row = {
    id: 's_ws_audit',
    kind: 'front',
    bot: '审计机',
    model: 'fake/model',
    state: 'running',
    reply: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { id: row.id, row } as unknown as Session;
}


/** 假资源服务配置。 */
interface FakeResourcesOptions {
  /** 顶层 search 配置。 */
  search: unknown;
  /** 供应商映射表。 */
  providers: Record<string, { baseUrl: string; apiKey: string }>;
}

/** 假资源服务，仅提供顶层 search 原始配置与 providers 映射。 */
class FakeResources extends cordis.Service {
  readonly raw: Record<string, unknown>;
  readonly config: { providers: Record<string, { baseUrl: string; apiKey: string }> };

  constructor(ctx: cordis.Context, options: FakeResourcesOptions) {
    super(ctx, 'resources');
    this.raw = { search: options.search };
    this.config = { providers: options.providers };
  }
}


/**
 * 构建挂载了 tools 与 web-search 的隔离 Cordis 上下文。
 * @param search 顶层 search 段配置。
 * @param providers 可供借用的供应商表。
 */
async function setupWorld(
  search: unknown,
  providers: Record<string, { baseUrl: string; apiKey: string }> = {},
): Promise<{ ctx: cordis.Context; traces: Array<{ where: string; vars: Record<string, unknown> }> }> {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const traces: Array<{ where: string; vars: Record<string, unknown> }> = [];
  ctx.on('trace', (where, _summary, _code, vars) => {
    traces.push({ where, vars });
  });

  await ctx.plugin(FakeResources, { search, providers });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(webSearchPlugin);
  return { ctx, traces };
}


/**
 * 通过骨架 Tools.execute 执行一次 web_search 工具调用。
 * @param ctx 已挂载插件的上下文。
 * @param query 查询词。
 * @param signal 可选停止信号。
 */
async function runSearch(
  ctx: cordis.Context,
  query: string,
  signal?: AbortSignal,
): Promise<toolsModule.ToolOutcome> {
  const call: piAi.ToolCall = {
    type: 'toolCall',
    id: 'call_ws_1',
    name: 'web_search',
    arguments: { query },
  };
  let activeSignal = new AbortController().signal;
  if (signal !== undefined) {
    activeSignal = signal;
  }
  return ctx.tools.execute(call, makeSession(), activeSignal);
}


bunTest.describe('Audit_WebSearch：网页搜索核心回归与安全边界', () => {
  bunTest.test('1. 入口配置校验：拒绝非数组、未知 kind、缺字段、未知 provider 与非字符串项', async () => {
    const badConfigs: Array<{ raw: unknown; err: string }> = [
      { raw: 'not-array', err: 'search 要写成一张清单' },
      { raw: [{ kind: 'google' }], err: '只能是 magpie 或 zhipu_mcp' },
      { raw: [{ kind: 'zhipu_mcp' }], err: 'api_key 要填智谱的密钥' },
      { raw: [{ kind: 'zhipu_mcp', api_key: 123 }], err: 'search[0].api_key 要是字符串' },
      { raw: [{ kind: 'magpie' }], err: 'search[0].model 要写' },
      { raw: [{ kind: 'magpie', model: 'm1', provider: 'missing' }], err: '不在 providers 里' },
      { raw: [{ kind: 'magpie', model: 'm1' }], err: '要写 provider' },
    ];

    for (const item of badConfigs) {
      const ctx = new cordis.Context();
      closers.push(() => ctx.fiber.dispose());
      await ctx.plugin(FakeResources, { search: item.raw, providers: {} });
      await ctx.plugin(toolsModule.Tools);
      //G 直接调用 apply 同步捕获配置入口校验异常，避免被 Cordis 异步包装吞掉。
      bunTest.expect(() => webSearchPlugin.apply(ctx)).toThrow(item.err);
    }
  });

  bunTest.test('2. 未配置 search 时照常注册到 front 与 work，调用时返回明确配置引导', async () => {
    const { ctx } = await setupWorld(undefined);
    const frontTools = ctx.tools.listToolsForSessionKind('front').map((item) => item.name);
    const workTools = ctx.tools.listToolsForSessionKind('work').map((item) => item.name);
    bunTest.expect(frontTools).toContain('web_search');
    bunTest.expect(workTools).toContain('web_search');

    const outcome = await runSearch(ctx, 'Bun 1.4 新特性');
    bunTest.expect(outcome.isError).toBe(true);
    bunTest.expect(outcome.text).toContain('没配网页搜索');
  });

  bunTest.test('3. Magpie 借用供应商 baseUrl/apiKey（去尾斜杠）并成功返回搜索结果', async () => {
    const mock = await startMockServer((req) => {
      bunTest.expect(req.url).toBe('/v1/alpha/search');
      bunTest.expect(req.headers.authorization).toBe('Bearer secret-borrowed-key');
      bunTest.expect(req.body['model']).toBe('gpt-search');
      const output = '这是一段足够长的 Magpie 网页搜索返回正文，来源 https://example.com/doc。';
      return { body: JSON.stringify({ output }) };
    });

    const providers = { gw: { baseUrl: `${mock.url}/v1///`, apiKey: 'secret-borrowed-key' } };
    const search = [{ kind: 'magpie', model: 'gpt-search', provider: 'gw' }];
    const { ctx, traces } = await setupWorld(search, providers);

    const outcome = await runSearch(ctx, '测试查询');
    bunTest.expect(outcome.isError).toBe(false);
    bunTest.expect(outcome.text).toContain('（用 magpie gpt-search 搜的）');
    bunTest.expect(outcome.text).toContain('https://example.com/doc');
    //G WebSearch 自身的跟踪事件不得泄露密钥或查询原文。
    const wsTraces = traces.filter((item) => item.where === 'WebSearch.search');
    bunTest.expect(wsTraces.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(wsTraces);
    bunTest.expect(serialized).not.toContain('secret-borrowed-key');
    bunTest.expect(serialized).not.toContain('测试查询');
  });

  bunTest.test('4. Magpie 返回非字符串结构化 output 时格式化为 JSON 文本输出', async () => {
    const mock = await startMockServer(() => {
      const payload = { output: [{ title: '条目一', url: 'https://example.org/a' }] };
      return { body: JSON.stringify(payload) };
    });

    const search = [{ kind: 'magpie', name: '结构化网关', model: 'm1', url: mock.url }];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, '结构化结果');
    bunTest.expect(outcome.isError).toBe(false);
    bunTest.expect(outcome.text).toContain('（用 结构化网关 搜的）');
    bunTest.expect(outcome.text).toContain('"title": "条目一"');
  });

  bunTest.test('5. Magpie HTTP 200 返回 couldn\'t search 伪成功时自动回退下一家并记录失败原因', async () => {
    const first = await startMockServer(() => ({
      body: JSON.stringify({ output: "magpie couldn't search this topic right now" }),
    }));
    const second = await startMockServer(() => ({
      body: JSON.stringify({ output: '第二家网关成功命中：包含超过二十个字的完整检索内容。' }),
    }));

    const search = [
      { kind: 'magpie', name: '主网关', model: 'm1', url: first.url },
      { kind: 'magpie', name: '备网关', model: 'm2', url: second.url },
    ];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, '故障回退');
    bunTest.expect(outcome.isError).toBe(false);
    bunTest.expect(outcome.text).toContain('用 备网关 搜的；前面没成：主网关：magpie couldn\'t search');
    bunTest.expect(outcome.text).toContain('第二家网关成功命中');
  });

  bunTest.test('6. 结果少于 20 字（MIN_CHARS）判定未搜到并切下一家；全失败聚合报错', async () => {
    const shortOne = await startMockServer(() => ({
      body: JSON.stringify({ output: '太短了' }),
    }));
    const shortTwo = await startMockServer(() => ({
      body: JSON.stringify({ output: '   也很短   ' }),
    }));

    const search = [
      { kind: 'magpie', name: '源A', model: 'm1', url: shortOne.url },
      { kind: 'magpie', name: '源B', model: 'm2', url: shortTwo.url },
    ];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, '冷门关键词');
    bunTest.expect(outcome.isError).toBe(true);
    bunTest.expect(outcome.text).toContain('都没搜到');
    bunTest.expect(outcome.text).toContain('源A：没搜到东西');
    bunTest.expect(outcome.text).toContain('源B：没搜到东西');
  });

  bunTest.test('7. 安全边界：上游 HTTP 500 回显请求头密钥时必须脱敏为 ***，绝不泄露给模型', async () => {
    const secret = 'sk-ultra-sensitive-token-987654';
    const leakServer = await startMockServer(() => ({
      status: 500,
      body: `upstream failed with header Authorization: Bearer ${secret} and retry key=${secret}`,
    }));

    const search = [{ kind: 'magpie', name: '泄漏测试源', model: 'm1', url: leakServer.url, api_key: secret }];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, '敏感密钥测试');
    bunTest.expect(outcome.isError).toBe(true);
    bunTest.expect(outcome.text).not.toContain(secret);
    bunTest.expect(outcome.text).toContain('***');
  });

  bunTest.test('8. 智谱 MCP Streamable HTTP（JSON 响应）：完整 4 步握手并透传 Mcp-Session-Id', async () => {
    const seenSessions: Array<string | undefined> = [];
    const seenMethods: string[] = [];

    const mcp = await startMockServer((req) => {
      const method = getRpcMethod(req.body);
      const id = req.body['id'];
      seenMethods.push(method);
      seenSessions.push(req.headers['mcp-session-id'] as string | undefined);

      if (method === 'initialize') {
        return {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-abc-123' },
          body: JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26' } }),
        };
      }
      if (method === 'notifications/initialized') {
        return { status: 202, body: '' };
      }
      if (method === 'tools/list') {
        const tools = [{ name: 'webSearchPrime', inputSchema: { required: ['custom_q'] } }];
        return { body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools } }) };
      }
      if (method === 'tools/call') {
        const params = req.body['params'] as { name?: string; arguments?: Record<string, unknown> };
        bunTest.expect(params.name).toBe('webSearchPrime');
        bunTest.expect(params.arguments?.['custom_q']).toBe('MCP 查询词');
        const content = [{ type: 'text', text: '智谱 MCP JSON 协议成功返回二十字以上的真实搜索摘要。' }];
        return { body: JSON.stringify({ jsonrpc: '2.0', id, result: { content } }) };
      }
      return { status: 400, body: '{}' };
    });

    const search = [{ kind: 'zhipu_mcp', name: '智谱测试', url: mcp.url, api_key: 'zp-key-1' }];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, 'MCP 查询词');
    bunTest.expect(outcome.isError).toBe(false);
    bunTest.expect(seenMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    bunTest.expect(seenSessions).toEqual([undefined, 'sess-abc-123', 'sess-abc-123', 'sess-abc-123']);
    bunTest.expect(outcome.text).toContain('智谱 MCP JSON 协议成功返回');
  });

  bunTest.test('9. 智谱 MCP SSE（text/event-stream）响应解析并拼接多段 content', async () => {
    const mcp = await startMockServer((req) => {
      const method = getRpcMethod(req.body);
      const id = req.body['id'];
      const headers = { 'content-type': 'text/event-stream' };

      if (method === 'initialize') {
        const line = JSON.stringify({ jsonrpc: '2.0', id, result: {} });
        return { headers, body: `event: message\ndata: ${line}\n\n` };
      }
      if (method === 'notifications/initialized') {
        return { status: 202, body: '' };
      }
      if (method === 'tools/list') {
        const line = JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'prime_search' }] } });
        return { headers, body: `data: ${line}\n\n` };
      }
      const content = [{ text: '第一段 SSE 检索结果内容。' }, { text: '第二段 SSE 检索结果内容，总字数超阈值。' }];
      const callLine = JSON.stringify({ jsonrpc: '2.0', id, result: { content } });
      return { headers, body: `data: {"jsonrpc":"2.0","id":999,"result":{}}\ndata: ${callLine}\n\n` };
    });

    const search = [{ kind: 'zhipu_mcp', url: mcp.url, api_key: 'zp-sse-key' }];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, 'SSE 协议');
    bunTest.expect(outcome.isError).toBe(false);
    bunTest.expect(outcome.text).toContain('第一段 SSE 检索结果内容');
    bunTest.expect(outcome.text).toContain('第二段 SSE 检索结果内容');
  });

  bunTest.test('10. 智谱 MCP 异常场景：缺少搜索工具与 tools/call 返回 isError=true 均正确报错', async () => {
    const noToolServer = await startMockServer((req) => {
      const method = getRpcMethod(req.body);
      const id = req.body['id'];
      if (method === 'initialize') return { body: JSON.stringify({ jsonrpc: '2.0', id, result: {} }) };
      if (method === 'notifications/initialized') return { status: 202, body: '' };

      return { body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'weather_only' }] } }) };
    });
    const isErrServer = await startMockServer((req) => {
      const method = getRpcMethod(req.body);
      const id = req.body['id'];
      if (method === 'initialize') return { body: JSON.stringify({ jsonrpc: '2.0', id, result: {} }) };
      if (method === 'notifications/initialized') return { status: 202, body: '' };
      if (method === 'tools/list') {
        return { body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'web_search' }] } }) };
      }

      const result = { isError: true, content: [{ text: '配额已用尽' }] };
      return { body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
    });

    const search = [
      { kind: 'zhipu_mcp', name: '无工具端', url: noToolServer.url, api_key: 'k1' },
      { kind: 'zhipu_mcp', name: '报错端', url: isErrServer.url, api_key: 'k2' },
    ];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, '异常测试');
    bunTest.expect(outcome.isError).toBe(true);
    bunTest.expect(outcome.text).toContain('MCP 里没有搜索工具（有：weather_only）');
    bunTest.expect(outcome.text).toContain('报错端：配额已用尽');
  });

  bunTest.test('11. AbortSignal 触发后立即中止且绝不再尝试后续搜索供应商', async () => {
    const controller = new AbortController();
    const slowFirst = await startMockServer(async () => {
      await Bun.sleep(2000);
      return { body: JSON.stringify({ output: '不应到达这里的结果内容超过二十个字符' }) };
    });
    const untouchedSecond = await startMockServer(() => ({
      body: JSON.stringify({ output: '第二家不应该被调用到的长文本内容' }),
    }));

    const search = [
      { kind: 'magpie', name: '慢源', model: 'm1', url: slowFirst.url },
      { kind: 'magpie', name: '后续源', model: 'm2', url: untouchedSecond.url },
    ];
    const { ctx } = await setupWorld(search);

    const timer = setTimeout(() => {
      controller.abort();
    }, 60);
    const outcome = await runSearch(ctx, '取消搜索', controller.signal);
    clearTimeout(timer);

    //G 骨架 Tools.execute 将主动中止记为“已停止”（isError=false），且后续搜索源绝不被调用。
    bunTest.expect(outcome.isError).toBe(false);
    bunTest.expect(outcome.text).toContain('已停止');
    bunTest.expect(untouchedSecond.received).toHaveLength(0);
  });

  bunTest.test('12. 超长检索结果按 MAX_CHARS（20000 字）截断并附带原总字数说明', async () => {
    const hugeText = '汉'.repeat(25_000);
    const mock = await startMockServer(() => ({
      body: JSON.stringify({ output: hugeText }),
    }));

    const search = [{ kind: 'magpie', name: '大文本源', model: 'm1', url: mock.url }];
    const { ctx } = await setupWorld(search);

    const outcome = await runSearch(ctx, '超长返回');
    bunTest.expect(outcome.isError).toBe(false);
    bunTest.expect(outcome.text.length).toBeLessThan(21_000);
    bunTest.expect(outcome.text).toContain('25000');
  });
});
