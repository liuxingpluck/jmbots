/**
 * 网页搜索（web_search 工具的实现）：按 config.yaml 的 search 列表一个个试，前一个出错或搜不到就换下一个。
 * 用户 11-02：“搜索要成为通用能力……通过环境配置提供不同种类的搜索配置参数并设好优先级；先用第一个，搜不到再用第二个、第三个”。
 *
 * 现有两种（kind）：
 *   magpie     本机 magpie 网关的 POST <base_url>/alpha/search（Codex 的 web.run 用的那个接口）：
 *              model 是 ChatGPT 账号的模型（如 codex/gpt-6-luna）就走 Codex 订阅自带的搜索；
 *              别的模型由 magpie 自己搜（能搜的模型或账号，再不行用 magpie 里配的搜索 API）。地址和密钥默认取 providers.magpie。
 *   zhipu_mcp  智谱的 MCP 搜索（web_search_prime，Streamable HTTP）：先 initialize，再 tools/list 找名字带 search 的工具，再 tools/call。
 *              api_key 写在 config.yaml（GLM Coding 套餐的密钥）。
 * DSH 的搜索（订阅插件里的 Codex web_search）走的也是 Codex 订阅，这里经 magpie 同样能用到，不再经 DSH 转。
 * 加新种类：在 searchOnce 里加一个分支，再在 config.example.yaml 写上例子。
 */
import type * as runtimeModule from '../core/Runtime.ts';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';


/** search 列表里的一项。 */
export interface SearchProvider {
  /** 种类：magpie 或 zhipu_mcp。 */
  kind: string;
  /** 显示的名字（报告“用谁搜的”）；不写用种类加模型。 */
  name?: string;
  /** magpie：用哪个模型的身份搜（不带 magpie/ 前缀，如 codex/gpt-6-luna）。 */
  model?: string;
  /** 地址：magpie 是网关的 /v1 地址（默认取 providers.magpie.base_url）；zhipu_mcp 是 MCP 地址（有默认）。 */
  url?: string;
  /** 密钥：magpie 默认取 providers.magpie.api_key；zhipu_mcp 必须写。 */
  api_key?: string;
}


/** 没配 search 时用的：Codex 订阅的搜索（经 magpie）。 */
export const DEFAULT_SEARCH: SearchProvider[] = [{ kind: 'magpie', model: 'codex/gpt-6-luna' }];

/** 智谱 MCP 搜索的默认地址。 */
const ZHIPU_MCP_URL = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';

/** 每个搜索最多等多久，毫秒。 */
const TIMEOUT_MS = 60_000;

/** 给模型看的结果最多多少字。 */
const MAX_CHARS = 20_000;

/** 发请求的函数（测试换成假的）。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;


/**
 * 读 config.yaml 的 search 列表；没写用 DEFAULT_SEARCH。
 * @param runtime 运行时。
 * @throws 写了但格式不对时抛错。
 */
export function readSearchProviders(runtime: runtimeModule.Runtime): SearchProvider[] {
  /** 原样。 */
  const raw = runtime.config.search;
  if (raw === undefined || raw === null) {
    return DEFAULT_SEARCH;
  }
  if (!Array.isArray(raw)) {
    throw new Error('config.yaml 的 search 要是列表，每项 {kind, model?, url?, api_key?}');
  }
  return (raw as unknown[]).map((item, index) => {
    /** 这一项。 */
    const record = checks.asRecord(item, `search[${index}]`);
    return {
      kind: checks.requireString(record.kind, `search[${index}].kind`),
      name: checks.optionalString(record.name, `search[${index}].name`),
      model: checks.optionalString(record.model, `search[${index}].model`),
      url: checks.optionalString(record.url, `search[${index}].url`),
      api_key: checks.optionalString(record.api_key, `search[${index}].api_key`),
    };
  });
}


/**
 * 按顺序搜，第一个搜到的就返回；都不行时抛错并列出每个的原因。
 * @param query 搜什么。
 * @param providers 搜索列表（有优先级）。
 * @param runtime 运行时（magpie 的默认地址和密钥）。
 * @param fetchImpl 发请求的函数。
 * @returns 给模型看的结果：第一行说用谁搜的、前面谁没搜到，后面是结果。
 */
export async function webSearch(query: string, providers: SearchProvider[], runtime: runtimeModule.Runtime, fetchImpl: FetchLike = fetch): Promise<string> {
  /** 前面没搜到的：名字和原因。 */
  const failed: string[] = [];
  for (const provider of providers) {
    /** 显示的名字。 */
    const name = provider.name ?? `${provider.kind}${provider.model ? ` ${provider.model}` : ''}`;
    try {
      /** 结果。 */
      const found = (await searchOnce(query, provider, runtime, fetchImpl)).trim();
      if (found.length < 20) {
        failed.push(`${name}：没搜到东西`);
        continue;
      }
      /** 第一行。 */
      const head = `（用 ${name} 搜的${failed.length > 0 ? `；前面没成：${failed.join('；')}` : ''}）`;
      return `${head}\n\n${utils.truncate(found, MAX_CHARS)}`;
    } catch (error) {
      failed.push(`${name}：${utils.errorText(error)}`);
    }
  }
  throw new Error(`都没搜到。${failed.join('；') || 'config.yaml 的 search 是空的'}`);
}


/**
 * 用一个搜索搜一次。
 * @param query 搜什么。
 * @param provider 哪个搜索。
 * @param runtime 运行时。
 * @param fetchImpl 发请求的函数。
 * @returns 搜到的文字（可能是空的）。
 * @throws 出错、没配好时抛错。
 */
async function searchOnce(query: string, provider: SearchProvider, runtime: runtimeModule.Runtime, fetchImpl: FetchLike): Promise<string> {
  if (provider.kind === 'magpie') {
    return searchMagpie(query, provider, runtime, fetchImpl);
  }
  if (provider.kind === 'zhipu_mcp') {
    return searchZhipuMcp(query, provider, fetchImpl);
  }
  throw new Error(`不认识的搜索种类 ${provider.kind}（现有 magpie、zhipu_mcp）`);
}


/**
 * magpie 的 /alpha/search：一次一个查询，结果在 output 里；magpie 搜不了时也回 200，output 以 “magpie couldn't search” 开头。
 * @param query 搜什么。
 * @param provider 配置。
 * @param runtime 运行时（默认地址和密钥取 providers.magpie）。
 * @param fetchImpl 发请求的函数。
 */
async function searchMagpie(query: string, provider: SearchProvider, runtime: runtimeModule.Runtime, fetchImpl: FetchLike): Promise<string> {
  /** providers.magpie。 */
  const magpie = runtime.providers.magpie;
  /** 网关的 /v1 地址。 */
  const base = (provider.url ?? magpie?.base_url ?? 'http://127.0.0.1:3425/v1').replace(/\/+$/, '');
  //G 没有模型就不知道用谁的身份搜。
  if (!provider.model) {
    throw new Error('magpie 搜索要写 model（如 codex/gpt-6-luna）');
  }
  /** 回应。 */
  const response = await fetchImpl(`${base}/alpha/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.api_key ?? magpie?.api_key ?? 'magpie-jmbots'}` },
    // 照 Codex 自己发的 SearchRequest 写全（ChatGPT 账号的模型会原样转给 ChatGPT 后端，少了 id 会报 400，11-02 实测）。
    body: JSON.stringify({
      id: `jmbots-${utils.createSessionId()}`,
      model: provider.model,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: query }] }],
      commands: { search_query: [{ q: query }] },
      settings: { search_context_size: 'medium', allowed_callers: ['direct'], external_web_access: true },
      max_output_tokens: 2500,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  /** 内容。 */
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}：${utils.truncate(text, 300)}`);
  }
  /** output。 */
  const output = utils.toText((JSON.parse(text) as { output?: unknown }).output);
  if (/^magpie (couldn't|can only) search/i.test(output.trim())) {
    throw new Error(utils.truncate(output.trim(), 300));
  }
  return output;
}


/**
 * 智谱 MCP 搜索：initialize → notifications/initialized → tools/list（找名字带 search 的工具和它必填的参数名）→ tools/call。
 * @param query 搜什么。
 * @param provider 配置（要 api_key）。
 * @param fetchImpl 发请求的函数。
 */
async function searchZhipuMcp(query: string, provider: SearchProvider, fetchImpl: FetchLike): Promise<string> {
  //G 没密钥。
  if (!provider.api_key) {
    throw new Error('zhipu_mcp 要在 config.yaml 写 api_key');
  }
  /** MCP 地址。 */
  const url = provider.url ?? ZHIPU_MCP_URL;
  /** 服务给的会话 ID（initialize 的回应头里）。 */
  let mcpSession = '';
  /**
   * 发一条 JSON-RPC，返回 result（通知不等结果）。
   * @param id 请求 ID；通知写 undefined。
   * @param method 方法。
   * @param params 参数。
   */
  const rpc = async (id: number | undefined, method: string, params: unknown): Promise<Record<string, unknown>> => {
    /** 请求头。 */
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${provider.api_key ?? ''}` };
    if (mcpSession) {
      headers['Mcp-Session-Id'] = mcpSession;
    }
    /** 回应。 */
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    mcpSession = response.headers.get('mcp-session-id') ?? mcpSession;
    /** 内容。 */
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} HTTP ${response.status}：${utils.truncate(text, 300)}`);
    }
    if (id === undefined) {
      return {};
    }
    /** 回应里的 JSON-RPC 消息：普通 JSON，或 SSE 的 data: 行。 */
    const messages = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
      : [JSON.parse(text) as Record<string, unknown>];
    /** 对应这次请求的那条。 */
    const reply = messages.find((message) => message.id === id);
    if (!reply) {
      throw new Error(`${method} 没有回应`);
    }
    if (reply.error) {
      throw new Error(`${method} 出错：${JSON.stringify(reply.error).slice(0, 300)}`);
    }
    return checks.asRecord(reply.result ?? {}, `${method} 的 result`);
  };

  await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jmbots', version: '1' } });
  await rpc(undefined, 'notifications/initialized', {});
  /** 工具清单。 */
  const listed = (await rpc(2, 'tools/list', {})).tools as { name?: string; inputSchema?: { required?: string[] } }[] | undefined;
  /** 搜索工具。 */
  const tool = (listed ?? []).find((item) => /search/i.test(item.name ?? ''));
  if (!tool?.name) {
    throw new Error(`MCP 里没有搜索工具（有：${(listed ?? []).map((item) => item.name).join('、') || '无'}）`);
  }
  /** 放查询的参数名。 */
  const argName = tool.inputSchema?.required?.[0] ?? 'search_query';
  /** 调用结果。 */
  const result = await rpc(3, 'tools/call', { name: tool.name, arguments: { [argName]: query } });
  /** 文字内容。 */
  const text = ((result.content as { type?: string; text?: string }[] | undefined) ?? []).map((item) => item.text ?? '').join('\n');
  if (result.isError === true) {
    throw new Error(utils.truncate(text, 300));
  }
  return text;
}
