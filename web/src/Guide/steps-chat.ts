/**
 * 聊天主页的演示引导步骤。改话术只改这个文件。
 * 2026-11-14 23:05 EST：用户 22:56 要求话术里去掉“路演”和让人看出在路演的说法，改成正常使用的话术（引导按钮和功能不变）。
 */
import { DEFAULT_QUESTION, ENTERPRISE_QUESTIONS, XINGHE_QUESTIONS } from './questions.ts';
import type { GuideStep } from './types.ts';

/** 除默认首题外的企业客服补充推荐问题列表，拼入输入框步骤说明。 */
const more = ENTERPRISE_QUESTIONS.slice(1, 3).map((q, i) => `${i + 2}. ${q}`).join('\n');
/** 星河科技知识库推荐问题列表，拼入输入框步骤说明。 */
const xinghe = XINGHE_QUESTIONS.slice(0, 2).map((q, i) => `${i + 1}. ${q}`).join('\n');

/** 聊天主页右上角「演示引导」按钮使用的步骤列表，包含引导话术与交互等待事件。 */
export const CHAT_STEPS: GuideStep[] = [
  {
    id: 'welcome',
    title: { 'zh-CN': '欢迎使用 jmbots', en: 'Welcome to jmbots' },
    description: {
      'zh-CN': '这里是 AI 客服：准确的记忆检索、关系图，以及微信监控。按「下一步」我会带你走一遍聊天页。也可以随时点「跳过」。',
      en: 'This is AI customer service: accurate memory retrieval, the relation graph, and WeChat monitoring. Click Next to walk through the chat page, or Skip at any time.',
    },
  },
  {
    id: 'bots',
    element: '.jm-bot-list, .jm-left-inner',
    side: 'right',
    title: { 'zh-CN': '先选一个机器人', en: 'Pick a bot' },
    description: {
      'zh-CN': '左边是机器人列表。点「助手」开始。每个机器人有自己的会话和记忆。',
      en: 'The left column lists bots. Choose 助手 (Assistant) to start. Each bot has its own sessions and memory.',
    },
  },
  {
    id: 'channel',
    element: '.jm-channel-filter',
    side: 'bottom',
    title: { 'zh-CN': '按渠道筛选', en: 'Filter by channel' },
    description: {
      'zh-CN': '网页把飞书、微信、网页等渠道合成一条时间线。这里可以只看某一个渠道；回复某条消息时，会从原来的渠道发回去。',
      en: 'Web, Feishu, and WeChat messages share one timeline. Filter by channel here. A reply is sent back on the original channel.',
    },
  },
  {
    id: 'composer',
    element: '.jm-composer',
    side: 'top',
    prefill: DEFAULT_QUESTION,
    waitFor: 'jmbots-guide-sent',
    title: { 'zh-CN': '问一句，看记忆检索', en: 'Ask a question to see memory retrieval' },
    description: {
      'zh-CN': `输入框里已填好一道多跳题（客户「企业客服」）：\n「${DEFAULT_QUESTION}」\n请点发送或按 Enter。发出后会自动进入下一步。也可以先点「下一步」只看界面。\n其它推荐问题：\n${more}\n问星河科技的资料，可用：\n${xinghe}`,
      en: `A multi-hop question for the customer “企业客服” is already filled in.\nClick Send or press Enter. The tour advances automatically after you send, or click Next to skip.\nOther suggested questions:\n${more}`,
    },
  },
  {
    id: 'header',
    element: '.jm-msg-bot .jm-msg-meta',
    side: 'bottom',
    optional: true,
    title: { 'zh-CN': '消息头：耗时和模型', en: 'Message header: duration and model' },
    description: {
      'zh-CN': '机器人回复上方会显示前台和后台各用了多久，例如「前台 7 秒 · 后台 1 分 30 秒」。右边是完整模型 ID 和档位，例如 magpie/workbuddy/deepseek-v4.1-flash · max。',
      en: 'Above the reply you will see front-desk and back-end duration, for example “前台 7 秒 · 后台 1 分 30 秒”, plus the full model ID and effort, such as magpie/workbuddy/deepseek-v4.1-flash · max.',
    },
  },
  {
    id: 'context-menu',
    element: '.jm-timeline, .jm-msg-bot',
    side: 'left',
    title: { 'zh-CN': '右键回复或引用', en: 'Right-click to reply or quote' },
    description: {
      'zh-CN': '在一条消息上点右键，可以「回复」或「引用」。回复会发回这条消息原来的渠道；引用会把原文带进输入框。',
      en: 'Right-click a message to Reply or Quote. A reply is sent on the original channel. A quote is inserted into the composer.',
    },
  },
  {
    id: 'asks',
    element: '.jm-ask',
    side: 'top',
    optional: true,
    title: { 'zh-CN': '选项卡', en: 'Option cards' },
    description: {
      'zh-CN': '当助手需要你做选择时，回复下方会出现选项卡，点一下就能选。没有选项时这一步会自动跳过。',
      en: 'When the assistant needs a choice, option cards appear under the reply. This step is skipped if there are none right now.',
    },
  },
  {
    id: 'panel',
    element: '.jm-chat-panel-toggle',
    side: 'bottom',
    title: { 'zh-CN': '打开右侧会话区', en: 'Open the right-hand panel' },
    description: {
      'zh-CN': '点「右栏」打开会话区。里面有会话、待办、正在运行的任务，以及待审核的审批卡。',
      en: 'Click to open the right-hand panel. It holds sessions, to-dos, running tasks, and approval cards.',
    },
  },
  {
    id: 'running',
    element: '.jm-running-tasks',
    side: 'left',
    optional: true,
    title: { 'zh-CN': '正在运行的任务', en: 'Running tasks' },
    description: {
      'zh-CN': '右栏顶部的「正在运行」会列出当前机器人同时在跑的前台和后台任务，包括已用时间和最新进度。点一行就跳到那个会话。没有任务时这块会藏起来。',
      en: 'At the top of the right panel, Running lists the bot’s current front-desk and back-end tasks, with elapsed time and latest progress. Click a row to open that session. The section hides when nothing is running.',
    },
  },
  {
    id: 'session',
    element: '.jm-session, .jm-panel-tabs',
    side: 'left',
    optional: true,
    title: { 'zh-CN': '会话和待办', en: 'Sessions and to-dos' },
    description: {
      'zh-CN': '「会话」标签可以切换这一场对话、换模型或停下。「待办」列出机器人正在做的几步。审批卡出现时，点「待审核」就能集中处理。',
      en: 'The Session tab switches conversations, changes the model, or stops a run. To-do lists the bot’s current steps. Approval cards are collected under Approvals.',
    },
  },
  {
    id: 'approval',
    element: '.jm-approval-head, .jm-chat-approvals',
    side: 'bottom',
    optional: true,
    title: { 'zh-CN': '审批卡', en: 'Approval cards' },
    description: {
      'zh-CN': '需要你确认的操作会以小卡片出现在时间线里，点标题展开详情再同意或拒绝。没有审批时这一步会跳过。',
      en: 'Actions that need your confirmation appear as compact cards in the timeline. Click the title to expand, then approve or reject. This step is skipped when there are none.',
    },
  },
  {
    id: 'graph-link',
    element: 'a[href*="/graph/"]',
    side: 'top',
    optional: true,
    title: { 'zh-CN': '查看本次记忆的关系图', en: 'Open the relation graph for this answer' },
    description: {
      'zh-CN': '回答用到记忆时，末尾会带「查看本次记忆的关系图」链接，点开是新标签页，不会改这个聊天页。推荐接着打开带 ?guide=1 的图谱页，继续下一步引导。',
      en: 'When an answer uses memory, it ends with a “查看本次记忆的关系图” link. It opens a new tab and does not change this chat page. Continue with the graph page, adding ?guide=1 to start its tour.',
    },
  },
];
