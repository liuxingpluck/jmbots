/**
 * 积木客服页（/wechat-kefu/）的演示引导。网址带 ?guide=1 自动开始。2026-11-14 jm开发。
 * 演示时保持「演示打码」开着：会话名、消息全换成＊，不露个人微信隐私。
 * 2026-11-14 23:05 EST：用户 22:56 要求话术里去掉“路演”和让人看出在路演的说法，改成正常使用的话术（引导按钮和功能不变）。
 * 介绍监听、人工发送、自动发与 AI 建议的复制。
 */
import type { GuideStep } from './types.ts';

/** 积木客服页（/wechat-kefu/）右上角「演示引导」使用的步骤列表。 */
export const WECHAT_STEPS: GuideStep[] = [
  {
    id: 'welcome',
    title: { 'zh-CN': '积木客服：微信监听', en: 'WeChat customer service' },
    description: {
      'zh-CN': '这一页是微信客服插件 wechat-kefu。勾了「监听」的会话里，客户说的话交给机器人回答，回话先进发件区确认再发。',
      en: 'This is the wechat-kefu plugin. Messages in watched chats go to the bot, '
        + 'and replies wait in the outbox for confirmation.',
    },
  },
  {
    id: 'stats',
    element: '[data-guide="stats"]',
    side: 'bottom',
    title: { 'zh-CN': '会话概览', en: 'Overview' },
    description: {
      'zh-CN': '上面一排是统计：会话总数、群聊、私聊、公众号、企业微信、系统会话、重点监听。点分类卡片可以只看这一类。',
      en: 'Counts by type. Click a category card to filter the list.',
    },
  },
  {
    id: 'poll',
    element: '[data-guide="poll"]',
    side: 'bottom',
    title: { 'zh-CN': '轮询状态', en: 'Polling' },
    description: {
      'zh-CN': '绿点表示正在定时查新消息（间隔在 config.yaml 的 wechat-kefu.interval_ms 里配）；红点是出错，点开能看原因。',
      en: 'Green means polling for new messages (interval in config.yaml); red means an error.',
    },
  },
  {
    id: 'mask',
    element: '[data-guide="mask"]',
    side: 'bottom',
    title: { 'zh-CN': '演示打码', en: 'Demo masking' },
    description: {
      'zh-CN': '打开后会话名和消息全换成＊，只留字数，投屏不会露出个人微信隐私。',
      en: 'When on, chat names and messages are hidden; screen sharing shows no private WeChat content.',
    },
  },
  {
    id: 'list',
    element: '[data-guide="list"]',
    side: 'right',
    title: { 'zh-CN': '会话和监听开关', en: 'Chats and watch switches' },
    description: {
      'zh-CN': '左边是最近会话。点会话看消息，勾「监听」后可回复。后端开启发送时，勾「自动发」可直接发出机器人的回话。',
      en: 'Select a recent chat to read its messages. Turn on Watch to reply. '
        + 'When sending is enabled on the server, Auto sends bot replies without confirmation.',
    },
  },
  {
    id: 'scan',
    element: '[data-guide="scan"]',
    side: 'bottom',
    title: { 'zh-CN': '一键扫描', en: 'Scan' },
    description: {
      'zh-CN': '点一下重新读一遍本机微信的最近会话。第一次要解密数据库，可能要几十秒。',
      en: 'Re-read the recent chats from local WeChat. The first scan may take a while.',
    },
  },
  {
    id: 'messages',
    element: '[data-guide="messages"]',
    side: 'left',
    title: { 'zh-CN': '消息', en: 'Messages' },
    description: {
      'zh-CN': '中间是选中会话的消息，自己发的靠右。已监听的会话可以在下面手动发送，也可以点「让 AI 起草建议」。',
      en: 'Messages of the selected chat appear here, with yours on the right. '
        + 'In watched chats, send a message below or ask the AI to draft a suggestion.',
    },
  },
  {
    id: 'outbox',
    element: '[data-guide="outbox"]',
    side: 'left',
    title: { 'zh-CN': '待发回复', en: 'Outbox' },
    description: {
      'zh-CN': '右边是发件状态。草稿、失败或被拒的回复可点「发送」。待处理的 AI 建议可复制，演示打码时复制不可用。',
      en: 'Check the status of replies here. You can send drafts and resend failed or rejected replies. '
        + 'Copy is available for pending AI suggestions outside demo masking.',
    },
  },
];
