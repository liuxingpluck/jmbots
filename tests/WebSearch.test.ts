/**
 * 网页搜索的离线测试：假的 fetch 模拟 magpie 的 /alpha/search 和智谱 MCP（SSE 回应），
 * 检查按顺序试、前一个搜不到换下一个、结果第一行说清用谁搜的、都不行时列出原因。不连网、不调模型。
 */
import * as bunTest from 'bun:test';
import type * as resourcesModule from '../src/resources/Resources.ts';
import * as webSearch from '../src/capabilities/tools/WebSearch.ts';


/** 假资源：只用到 getProviders().magpie 和 getSearch()。 */
const resources = {
  getProviders: () => ({ magpie: { base_url: 'http://magpie.test/v1', api_key: 'k' } }),
  getSearch: () => undefined,
} as unknown as resourcesModule.Resources;

/** 一段够长的搜索结果。 */
const FOUND = 'Bun 1.9 发布了，地址 https://bun.sh/blog/bun-v1.9 ，主要改进是……';


/**
 * 假的智谱 MCP：按方法回 SSE。
 * @param body 请求体。
 */
function zhipuReply(body: { id?: number; method: string }): Response {
  if (body.id === undefined) {
    return new Response('', { status: 202 });
  }
  /** 各方法的结果。 */
  const results: Record<string, unknown> = {
    initialize: { protocolVersion: '2025-03-26' },
    'tools/list': { tools: [{ name: 'webSearchPrime', inputSchema: { required: ['search_query'] } }] },
    'tools/call': { content: [{ type: 'text', text: FOUND }] },
  };
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] })}\n\n`, {
    headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' },
  });
}


bunTest.test('magpie 搜不了就换智谱 MCP，第一行说清用谁搜的', async () => {
  /** 发过的请求地址。 */
  const urls: string[] = [];
  /** 假 fetch。 */
  const fakeFetch: webSearch.FetchLike = (url, init) => {
    urls.push(url);
    if (url.startsWith('http://magpie.test')) {
      return Promise.resolve(Response.json({ output: "magpie couldn't search the web for bun: no searcher" }));
    }
    return Promise.resolve(zhipuReply(JSON.parse(init.body as string) as { id?: number; method: string }));
  };
  /** 结果。 */
  const output = await webSearch.webSearch('bun 新版本', [{ kind: 'magpie', model: 'codex/gpt-6-luna' }, { kind: 'zhipu_mcp', api_key: 'z', name: '智谱' }], resources, fakeFetch);
  bunTest.expect(urls[0]).toBe('http://magpie.test/v1/alpha/search');
  bunTest.expect(output.split('\n')[0]).toContain('用 智谱 搜的');
  bunTest.expect(output.split('\n')[0]).toContain('magpie codex/gpt-6-luna');
  bunTest.expect(output).toContain('bun.sh/blog');
});


bunTest.test('第一个搜到就不再试后面的', async () => {
  /** 请求次数。 */
  let calls = 0;
  /** 假 fetch。 */
  const fakeFetch: webSearch.FetchLike = () => {
    calls += 1;
    return Promise.resolve(Response.json({ output: FOUND }));
  };
  /** 结果。 */
  const output = await webSearch.webSearch('bun', [{ kind: 'magpie', model: 'codex/gpt-6-luna' }, { kind: 'zhipu_mcp', api_key: 'z' }], resources, fakeFetch);
  bunTest.expect(calls).toBe(1);
  bunTest.expect(output).toContain('（用 magpie codex/gpt-6-luna 搜的）');
});


bunTest.test('都不行时抛错并列出每个的原因', async () => {
  /** 假 fetch：都 500。 */
  const fakeFetch: webSearch.FetchLike = () => Promise.resolve(new Response('坏了', { status: 500 }));
  /** 拿到的错。 */
  let message = '';
  try {
    await webSearch.webSearch('bun', [{ kind: 'magpie', model: 'm' }, { kind: 'zhipu_mcp' }, { kind: 'xx' }], resources, fakeFetch);
  } catch (error) {
    message = String(error);
  }
  bunTest.expect(message).toMatch(/HTTP 500.*要在 config.yaml 写 api_key.*不认识的搜索种类 xx/);
});


bunTest.test('没配 search 时用默认（Codex 订阅经 magpie）', () => {
  bunTest.expect(webSearch.readSearchProviders(resources)).toEqual(webSearch.DEFAULT_SEARCH);
});
