/**
 * 记忆关系图谱页的演示引导步骤。改话术只改这个文件。
 * 2026-11-14 23:05 EST：用户 22:56 要求话术里去掉“路演”和让人看出在路演的说法，改成正常使用的话术（引导按钮和功能不变）。
 */
import { CUSTOMER_DEMO, DEFAULT_QUESTION } from './questions.ts';
import type { GuideStep } from './types.ts';

export const GRAPH_STEPS: GuideStep[] = [
  {
    id: 'welcome',
    title: { 'zh-CN': '记忆关系图谱', en: 'Memory relation graph' },
    description: {
      'zh-CN': '这是独立的关系图页，不是聊天页改出来的。整张图来自记忆库抽出的人物、组织和事项关系。按「下一步」看怎么检索和读图。',
      en: 'This is a standalone graph page, not a modification of the chat page. It shows people, organizations, and facts extracted from memory. Click Next to see how to search and read the graph.',
    },
  },
  {
    id: 'customer',
    element: '.mg-header select[data-guide="customer"], .mg-header select:first-of-type',
    side: 'bottom',
    graph: { customer: CUSTOMER_DEMO },
    title: { 'zh-CN': '选择客户', en: 'Choose a customer' },
    description: {
      'zh-CN': '每个客户一张图，互不混杂。选「demo:企业客服」看云舟科技的制度文档。',
      en: 'Each customer has a separate graph. Choose “demo:企业客服” to see Yunzhou Tech policies.',
    },
  },
  {
    id: 'query',
    element: '.mg-q',
    side: 'bottom',
    prefill: DEFAULT_QUESTION,
    title: { 'zh-CN': '输入一道多跳问题', en: 'Type a multi-hop question' },
    description: {
      'zh-CN': `已填入推荐问题：「${DEFAULT_QUESTION}」这句要连跳好几步（产品故障→处理团队→负责人的上级）才能答全。`,
      en: `A recommended question is filled in: “${DEFAULT_QUESTION}” It takes several hops (product incident → handling team → that lead’s manager) to answer fully.`,
    },
  },
  {
    id: 'mode',
    element: '.mg-header select[data-guide="mode"]',
    side: 'bottom',
    graph: { mode: 'graph' },
    title: { 'zh-CN': '选择检索方式', en: 'Choose a search mode' },
    description: {
      'zh-CN': '「混合检索」很快，大约零点几秒，适合现场随手问，但多跳题可能少一跳。「图谱+大模型重排」更准，大约 5 到 10 秒，要准就用这个。',
      en: 'Hybrid search is fast (a fraction of a second) and good for quick questions, but it may miss a hop. Graph + rerank is more accurate (about 5–10 seconds) and is the one to use when accuracy matters.',
    },
  },
  {
    id: 'search',
    element: '.mg-header button[data-guide="search"]',
    side: 'bottom',
    waitFor: 'jmbots-guide-searched',
    title: { 'zh-CN': '检索并高亮', en: 'Search and highlight' },
    description: {
      'zh-CN': '点「检索并高亮」。选了图谱+重排时，页面会提示要等几秒。检索结束后会自动进入下一步；也可以先点「下一步」。',
      en: 'Click Search and highlight. With graph + rerank, the page tells you to wait a few seconds. The tour advances when the search finishes, or click Next to skip.',
    },
  },
  {
    id: 'canvas',
    element: '.mg-stage',
    side: 'right',
    title: { 'zh-CN': '金色高亮的命中路径', en: 'Golden highlighted path' },
    description: {
      'zh-CN': '命中的关系会变成金色虚线并流动，相关的点带光圈，其它点和线会变淡。可以拖空白处平移、滚轮缩放、拖动一个点。',
      en: 'Hit relations become a flowing golden dashed path, with a halo on the related nodes; everything else fades. Drag the background to pan, scroll to zoom, and drag a node to move it.',
    },
  },
  {
    id: 'side',
    element: '.mg-side',
    side: 'left',
    title: { 'zh-CN': '关系链和原文出处', en: 'Relation chains and sources' },
    description: {
      'zh-CN': '右边列出这次命中的关系链，下面是原文出处，并标出是关键词、向量还是关系图命中的。点一条原文可以看整段。',
      en: 'The right pane lists the hit relation chains, then the source passages, tagged as keyword, vector, or graph hits. Click a passage to read it in full.',
    },
  },
  {
    id: 'click',
    element: '.mg-stage',
    side: 'bottom',
    title: { 'zh-CN': '点节点或连线', en: 'Click a node or an edge' },
    description: {
      'zh-CN': '点一个点，右边会列出它关联的原文；点一条线，会显示这句关系出自哪段。可以现在点一下试试，再按「下一步」。',
      en: 'Click a node to see its related passages on the right. Click an edge to see which passage the relation came from. Try it now, then click Next.',
    },
  },
  {
    id: 'expand',
    element: '.mg-help',
    side: 'top',
    title: { 'zh-CN': '双击展开邻居', en: 'Double-click to expand neighbors' },
    description: {
      'zh-CN': '双击一个点，会展开它的邻居，把周围相关的人和事也画出来。可以先选一个金色路径上的点再双击。',
      en: 'Double-click a node to expand its neighbors and reveal related people and facts. Try a node on the golden path first.',
    },
  },
];
