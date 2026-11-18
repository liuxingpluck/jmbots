/**
 * 记忆检索页（/memory/）的演示引导。网址带 ?guide=1 自动开始；右上角「演示引导」也能开。2026-11-14 jm开发。
 * 演示客户是 demo:出版ERP（出版社 ERP 交付知识库，公开的产品文档，不含个人信息）。
 * 2026-11-14 23:05 EST：用户 22:56 要求话术里去掉“路演”和让人看出在路演的说法，改成正常使用的话术（引导按钮和功能不变）。
 */
import { ERP_CUSTOMER, ERP_QUESTIONS } from '../Memory/questions.ts';
import type { GuideStep } from './types.ts';

/** 记忆检索页（/memory/）右上角「演示引导」使用的步骤列表。 */
export const MEMORY_STEPS: GuideStep[] = [
  {
    id: 'welcome',
    title: { 'zh-CN': '记忆检索', en: 'Memory search' },
    description: {
      'zh-CN': '这一页是机器人的“记忆”：导入的文档切成段、做向量、抽出关系三元组，提问时三路一起找（关键词、向量、关系图）。按「下一步」一步步看。',
      en: 'This page shows the bot memory: documents are split, embedded, and turned into relation triples; a question is searched by keyword, vector, and graph together. Click Next.',
    },
  },
  {
    id: 'status',
    element: '[data-guide="status"]',
    side: 'bottom',
    title: { 'zh-CN': '服务状态', en: 'Service status' },
    description: {
      'zh-CN': '上面一排显示记忆服务是否在线、片段总数和已嵌入向量的数量，每 10 秒刷新。',
      en: 'Memory service status, total passages, and embedded passages. Refreshes every 10 seconds.',
    },
  },
  {
    id: 'progress',
    element: '[data-guide="progress"]',
    side: 'bottom',
    title: { 'zh-CN': '关系抽取进度', en: 'Relation extraction' },
    description: {
      'zh-CN': '后台用免费模型把每段话抽成“主语-关系-宾语”。绿色是已完成，灰色是排队中，红色是失败。没抽完也能检索，只是关系图那一路少一些。',
      en: 'In the background a free model turns each passage into subject-relation-object triples. Green is done, grey is pending, red failed. Search works before it finishes.',
    },
  },
  {
    id: 'customer',
    element: '[data-guide="customer"]',
    side: 'bottom',
    graph: { customer: ERP_CUSTOMER },
    title: { 'zh-CN': '选择客户', en: 'Choose a customer' },
    description: {
      'zh-CN': '每个客户的记忆互相隔离，必须先选客户才能查聊天记录。比如选「demo:出版ERP」。不选客户只会查公共知识库。',
      en: 'Each customer has isolated memory; you must pick one to search its records. Choose “demo:出版ERP”. Without a customer only the public knowledge base is searched.',
    },
  },
  {
    id: 'query',
    element: '[data-guide="query"]',
    side: 'bottom',
    prefill: ERP_QUESTIONS[0],
    title: { 'zh-CN': '输入问题', en: 'Type a question' },
    description: {
      'zh-CN': `已填入推荐问题：「${ERP_QUESTIONS[0]}」下面的小标签是更多常问的问题，点一下就填进来。`,
      en: `A recommended question is filled in: “${ERP_QUESTIONS[0]}” The chips below hold more common questions.`,
    },
  },
  {
    id: 'mode',
    element: '[data-guide="mode"]',
    side: 'bottom',
    title: { 'zh-CN': '检索方式', en: 'Search mode' },
    description: {
      'zh-CN': '「混合」三路一起找，最快；「图谱+重排」再让大模型挑最相关的关系，多跳问题更准，慢几秒。',
      en: '“Hybrid” searches three ways at once and is fastest; “Graph + rerank” lets the model pick relations, better for multi-hop questions but a few seconds slower.',
    },
  },
  {
    id: 'search',
    element: '[data-guide="search"]',
    side: 'bottom',
    waitFor: 'jmbots-guide-searched',
    title: { 'zh-CN': '点「检索」', en: 'Click Search' },
    description: {
      'zh-CN': '点一下检索。结果出来后会自动进下一步。',
      en: 'Click Search. The tour moves on when results arrive.',
    },
  },
  {
    id: 'hits',
    element: '[data-guide="hits"]',
    side: 'top',
    optional: true,
    title: { 'zh-CN': '命中原文', en: 'Matched passages' },
    description: {
      'zh-CN': '每张卡片是一段命中的原文：标题是出处（哪份文档哪一节），标签说明是哪一路找到的。点卡片展开全文。机器人回答时就引用这些段落。',
      en: 'Each card is a matched passage: the title is its source, the tags show which route found it. Click to expand. The bot cites these passages.',
    },
  },
  {
    id: 'relations',
    element: '[data-guide="relations"]',
    side: 'left',
    optional: true,
    title: { 'zh-CN': '关系和多跳', en: 'Relations and hops' },
    description: {
      'zh-CN': '右边是这次用到的关系三元组，首尾相接的会连成一条链，这就是“多跳”：从问题里的实体一步步走到答案。',
      en: 'On the right are the triples used; connected ones form a chain, which is the multi-hop path from the question to the answer.',
    },
  },
  {
    id: 'graph',
    element: '[data-guide="graph"]',
    side: 'left',
    optional: true,
    title: { 'zh-CN': '看关系图', en: 'Open the graph' },
    description: {
      'zh-CN': '想看图就点这里，新标签页打开关系图谱，同一个问题的命中路径会高亮流动。',
      en: 'Click here to open the relation graph in a new tab with the same question highlighted.',
    },
  },
  {
    id: 'import',
    element: '[data-guide="import"]',
    side: 'top',
    title: { 'zh-CN': '导入文档', en: 'Import documents' },
    description: {
      'zh-CN': '这里可以粘贴一段文字收进公共知识库，马上就能检索到。整本 PDF、Word 用 ztools/doc-import 导入（出版ERP 的 592 段就是这样进来的）。',
      en: 'Paste text here to add it to the public knowledge base; it is searchable right away. Whole PDFs or Word files go through ztools/doc-import.',
    },
  },
];
