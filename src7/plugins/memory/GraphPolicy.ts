/**
 * 聊天记录进不进关系图（2026-11-14 用户定：演示客户的聊天记录不自动抽成关系图，免得“用户说/机器人答”污染图谱）。
 * memory 插件配置：
 *   history_graph: false        所有聊天记录只收进记忆（照样能搜），不抽关系图；默认 true。
 *   no_graph_customers: [...]   这些客户的聊天记录不抽关系图；写 `demo:*` 这种以 * 结尾的按前缀算。
 * 写入 Rust 记忆服务时给 MemoryDoc 带 graph: false，服务据此跳过关系抽取。
 * 知识库、文档导入不受影响（它们不是聊天记录）。
 */

/** 读好的规则。 */
export interface GraphPolicy {
  /** 聊天记录默认进不进图。 */
  historyGraph: boolean;
  /** 不进图的客户（可带 * 结尾按前缀）。 */
  noGraphCustomers: string[];
}

/** 不写配置时：都进图（和以前一样）。 */
export const GRAPH_ALL: GraphPolicy = { historyGraph: true, noGraphCustomers: [] };

/**
 * 从 memory 插件配置读规则。
 * @param raw memory 插件的 config。
 * @returns 读好的规则：history_graph 没写算 true，客户名单去掉空白和空项。
 * @throws 写错类型时抛错。
 */
export function readGraphPolicy(raw: Record<string, unknown>): GraphPolicy {
  //G 两个配置项在入口这里校验一次：类型写错当场报错，不让错配置悄悄当成默认值。
  const flag = raw['history_graph'];
  if (flag !== undefined && typeof flag !== 'boolean') throw new Error('memory.history_graph 要是 true 或 false');
  const list = raw['no_graph_customers'] ?? [];
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) throw new Error('memory.no_graph_customers 要是字符串列表');
  return { historyGraph: flag !== false, noGraphCustomers: (list as string[]).map((item) => item.trim()).filter((item) => item !== '') };
}

/**
 * 这个客户的聊天记录要不要抽关系图。
 * @param policy 规则。
 * @param customer 客户号（渠道:用户）。
 * @returns true 要抽关系图；总开关关了或客户在名单里就是 false。
 */
export function wantsGraph(policy: GraphPolicy, customer: string): boolean {
  if (!policy.historyGraph) return false;

  //M 名单里有一条对上就不进图：带 * 结尾的按前缀比，其余要整串相等。
  return !policy.noGraphCustomers.some((rule) => (rule.endsWith('*') ? customer.startsWith(rule.slice(0, -1)) : customer === rule));
}

/**
 * 给聊天记录片段打上进图标记：不进图就加 graph: false，进图就原样（不写 = 抽）。
 * @param policy 规则。
 * @param doc 片段。
 * @returns 要进图的原样返回；不进图的返回带 graph: false 的副本，不改原对象。
 */
export function markGraph<T extends { customer: string; graph?: boolean }>(policy: GraphPolicy, doc: T): T {
  //M 按这条片段的客户号判一次进不进图，判下来不进图才多带一个 graph: false。
  return wantsGraph(policy, doc.customer) ? doc : { ...doc, graph: false };
}

/**
 * 在整份配置的插件列表里找 memory 插件的 config（别的插件要照同一规则写聊天记录时用）。
 * @param plugins 配置里的插件列表。
 * @returns 找到的 config；没找到或没写 config 时是空对象（readGraphPolicy 会当成默认规则）。
 */
export function memoryPluginConfig(plugins: readonly { name: string; config?: unknown }[]): Record<string, unknown> {
  //M 插件名可能写成路径（带反斜杠），先统一成正斜杠，再认 memory 或 .../memory。
  for (const plugin of plugins) {
    const name = plugin.name.replace(/\\/gu, '/');
    if (name !== 'memory' && !name.endsWith('/memory')) continue;
    if (plugin.config !== null && typeof plugin.config === 'object') return plugin.config as Record<string, unknown>;
  }
  return {};
}
