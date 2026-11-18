/** 读取签入的图和提交用户选择，沿用 jmbots 的页面令牌。 */
import type * as types from '../../../src7/plugins/decision-map/Types.ts';
import * as token from '../Token.ts';

const BASE = '/api/decision-map';

/** 请求并读取决策图接口的 JSON 返回。 */
async function request<T>(route: string, options?: RequestInit): Promise<T> {
  const endpoint = `${BASE}${route}`;

  //M 非本机打开页面时使用 jmbots 已保存的访问令牌。
  const address = token.withToken(endpoint, token.TOKEN);
  const response = await fetch(address, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

/** 获取当前快照，含中控最近确认的状态。 */
export function getGraph(signal?: AbortSignal): Promise<types.DecisionGraph> {
  const options = { signal };

  //M 画布轮询当前快照，用版本号跳过未变的布置。
  return request('/graph', options);
}

/** 提交单个选项，服务器校验并记录后返回。 */
export function choose(node: string, option: string): Promise<{ node: types.DecisionNode }> {
  const body = JSON.stringify({ node, option });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

  //M 用户点击后只提交一次，收到结果再刷新画布。
  return request('/choose', options);
}
