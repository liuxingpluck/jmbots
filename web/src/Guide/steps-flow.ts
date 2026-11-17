/**
 * 插件预览页 /flow/ 的引导步骤。改话术只改这个文件。话术按正常使用写。
 */
import type { GuideStep } from './types.ts';

export const FLOW_STEPS: GuideStep[] = [
  {
    id: 'welcome',
    title: { 'zh-CN': '插件预览', en: 'Plugin map' },
    description: {
      'zh-CN': '这里能看清 jmbots 是怎么搭起来的：CLI 启动骨架三个服务，插件按分类挂在后面。也能看一条真实消息进来后先后经过了谁。',
      en: 'See how jmbots is assembled: the CLI starts three core services and plugins hang off them by category. You can also follow one real message through the system.',
    },
  },
  {
    id: 'probe',
    element: '[data-guide="probe"]',
    side: 'bottom',
    title: { 'zh-CN': '发一条请求', en: 'Send a request' },
    description: {
      'zh-CN': '选一个机器人，点「发一条测试请求」。发的是一句固定的话（介绍自己、报时间），和在聊天页发消息走的是同一条路。',
      en: 'Pick a bot and click the send button. It sends a fixed sentence along the same path as the chat page.',
    },
  },
  {
    id: 'requests',
    element: '[data-guide="requests"], [data-guide="trail"]',
    side: 'left',
    optional: true,
    title: { 'zh-CN': '选一条请求', en: 'Pick a request' },
    description: {
      'zh-CN': '右边列着最近的请求。点一条，中间按步骤排开：每个经过的插件一条横道，卡片从左到右是第 1、2、3…步，写着干了什么、用了多久；出错的变红。点「在结构图上看」可以在整张结构图上看同一条路径。',
      en: 'Recent requests are listed on the right. Click one: the plugins it passed get numbered, orange lines connect them in order, errors turn red.',
    },
  },
  {
    id: 'canvas',
    element: '.fl-canvas',
    side: 'right',
    title: { 'zh-CN': '读图', en: 'Reading the map' },
    description: {
      'zh-CN': '点一张步骤卡片，右栏会展开这一步里的事件、谁在听、哪一行代码。在结构图上看时，插件右上角的小圆数字是第几步到过这里，虚线框是只收到通知、没做事的插件。可以拖动、滚轮缩放。',
      en: 'Small numbered badges show which steps passed a node. Dashed boxes were only notified. Drag, scroll to zoom, use the minimap for the overview.',
    },
  },
  {
    id: 'steps',
    element: '.fl-trail',
    side: 'left',
    optional: true,
    title: { 'zh-CN': '每一步干了什么', en: 'What each step did' },
    description: {
      'zh-CN': '右栏按顺序列出每一步：哪个插件、干了什么、用了多久。点开一步能看到里面的事件、谁在听、是哪一行代码。',
      en: 'Each step lists the plugin, what it did and how long it took. Expand a step to see the events, listeners and code location.',
    },
  },
];
