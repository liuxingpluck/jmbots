/**
 * 网页搜索的离线测试：假的 fetch 模拟 Magpie 网关的 /alpha/search 和智谱 MCP（SSE 回应），
 * 检查按顺序试、前一个搜不到换下一个、结果第一行说清用谁搜的、都不行时列出原因；
 * 没配搜索时不替用户挑哪一家，magpie 种类的地址和密钥只从 provider 写的那一家借。不连网、不调模型。
 */
import * as bunTest from 'bun:test';
import type * as resourcesModule from '../src/resources/Resources.ts';
import * as webSearch from '../src/capabilities/tools/WebSearch.ts';


/** 假资源：只用到 getProviders() 和 getSearch()。供应商名随便起，代码不认哪一家。 */
const resources = {
  getProviders: () => ({ gw: { base_url: 'http://gateway.test/v1', api_key: 'k' } }),
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


bunTest.test('magpie 搜不了就换智谱 MCP，第一行说清用谁搜的；地址和密钥取 provider 写的那一家', async () => {
  /** 发过的请求地址。 */
  const urls: string[] = [];
  /** 发给网关的密钥。 */
  const keys: string[] = [];
  /** 假 fetch。 */
  const fakeFetch: webSearch.FetchLike = (url, init) => {
    urls.push(url);
    if (url.startsWith('http://gateway.test')) {
      keys.push(new Headers(init.headers).get('authorization') ?? '');
      return Promise.resolve(Response.json({ output: "magpie couldn't search the web for bun: no searcher" }));
    }
    return Promise.resolve(zhipuReply(JSON.parse(init.body as string) as { id?: number; method: string }));
  };
  /** 搜索列表。 */
  const providers: webSearch.SearchProvider[] = [
    { kind: 'magpie', provider: 'gw', model: 'some/model' },
    { kind: 'zhipu_mcp', api_key: 'z', name: '智谱' },
  ];
  /** 结果。 */
  const output = await webSearch.webSearch('bun 新版本', providers, resources, fakeFetch);
  bunTest.expect(urls[0]).toBe('http://gateway.test/v1/alpha/search');
  bunTest.expect(keys).toEqual(['Bearer k']);
  bunTest.expect(output.split('\n')[0]).toContain('用 智谱 搜的');
  bunTest.expect(output.split('\n')[0]).toContain('magpie some/model');
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
  /** 搜索列表。 */
  const providers: webSearch.SearchProvider[] = [
    { kind: 'magpie', provider: 'gw', model: 'some/model' },
    { kind: 'zhipu_mcp', api_key: 'z' },
  ];
  /** 结果。 */
  const output = await webSearch.webSearch('bun', providers, resources, fakeFetch);
  bunTest.expect(calls).toBe(1);
  bunTest.expect(output).toContain('（用 magpie some/model 搜的）');
});


bunTest.test('都不行时抛错并列出每个的原因', async () => {
  /** 假 fetch：都 500。 */
  const fakeFetch: webSearch.FetchLike = () => Promise.resolve(new Response('坏了', { status: 500 }));
  /** 搜索列表。 */
  const providers: webSearch.SearchProvider[] = [
    { kind: 'magpie', provider: 'gw', model: 'm' },
    { kind: 'zhipu_mcp' },
    { kind: 'xx' },
  ];
  /** 拿到的错。 */
  let message = '';
  try {
    await webSearch.webSearch('bun', providers, resources, fakeFetch);
  } catch (error) {
    message = String(error);
  }
  bunTest.expect(message).toMatch(/HTTP 500.*要在 config.yaml 写 api_key.*不认识的搜索种类 xx/);
});


bunTest.test('没配 search：列表是空的，不替用户挑哪一家；搜的时候说清去设置里加', async () => {
  bunTest.expect(webSearch.readSearchProviders(resources)).toEqual([]);
  /** 拿到的错。 */
  let message = '';
  try {
    await webSearch.webSearch('bun', [], resources, () => Promise.reject(new Error('不该发请求')));
  } catch (error) {
    message = String(error);
  }
  bunTest.expect(message).toContain('没配网页搜索');
  bunTest.expect(message).toContain('设置的“搜索”');
});


bunTest.test('读 search：provider 照写的读进来', () => {
  /** 写了 search 的假资源。 */
  const written = {
    getProviders: () => ({}),
    getSearch: () => [{ kind: 'magpie', provider: 'gw', model: 'some/model' }],
  } as unknown as resourcesModule.Resources;
  /** 读出来的。 */
  const providers = webSearch.readSearchProviders(written);
  bunTest.expect(providers[0]?.provider).toBe('gw');
  bunTest.expect(providers[0]?.model).toBe('some/model');
});


bunTest.test('magpie 没写 provider 也没写 url：报错，一个请求都不发；不会按名字去找哪一家', async () => {
  /** 假资源：有一家正好叫 magpie，没写 provider 时也不能拿它。 */
  const named = {
    getProviders: () => ({ magpie: { base_url: 'http://named.test/v1', api_key: 'k' } }),
    getSearch: () => undefined,
  } as unknown as resourcesModule.Resources;
  /** 发过的请求地址。 */
  const urls: string[] = [];
  /** 假 fetch：记下所有地址；真被调到就回一段搜索结果。 */
  const fakeFetch: webSearch.FetchLike = (url) => {
    urls.push(url);
    return Promise.resolve(Response.json({ output: FOUND }));
  };
  /** 没写 provider 时拿到的错。 */
  let missing = '';
  try {
    await webSearch.webSearch('bun', [{ kind: 'magpie', model: 'm' }], named, fakeFetch);
  } catch (error) {
    missing = String(error);
  }
  /** provider 写了一家不存在的时拿到的错。 */
  let unknown = '';
  try {
    await webSearch.webSearch('bun', [{ kind: 'magpie', provider: 'nobody', model: 'm' }], named, fakeFetch);
  } catch (error) {
    unknown = String(error);
  }
  bunTest.expect(missing).toContain('都没搜到');
  bunTest.expect(missing).toContain('magpie 搜索要写 provider');
  bunTest.expect(unknown).toContain('provider 写的 nobody 不在 config.yaml 的 providers 里');
  bunTest.expect(urls).toEqual([]);
});
