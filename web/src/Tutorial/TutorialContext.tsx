/**
 * 教程页轻量级公共上下文、常量、纯计算函数与静态飞书消息路线（不依赖 antd、@xyflow/react 或 JSON 树组件）。
 */
import { createContext, type JSX } from 'react';
import type { Trail } from './TutorialApi.ts';


/** 窄屏轨迹看法：默认纵向步骤流，保留泳道全景与顺序图一键切换。 */
export type NarrowTraceMode = 'steps' | 'lanes' | 'seq';

/** 变了的地方拼成一个键：一串键名用这个字连起来（键名里不会有它）。 */
export const PATH_SEP = '\u001f';

/** 右栏独立滚动容器 Context：内部长列表借它做 react-virtuoso 虚拟滚动，不另起嵌套滚动框。 */
export const TutorialScrollContext = createContext<HTMLElement | null>(null);

/** 超过或达到这个条数时，长列表改用虚拟滚动；短列表保持普通渲染。 */
export const VIRTUAL_THRESHOLD = 30;

/** 一个函数的源码达到这个行数时，逐行改用虚拟滚动；少于它保持普通渲染。 */
export const CODE_VIRTUAL_LINES = 200;

/** 插件状态 → 一句话说明。 */
export const STATE_WORDS: Readonly<Record<string, string>> = {
  missing: '找不到插件',
  mounting: '正在挂载',
  ok: '挂上了',
  failed: '没挂上',
  waiting: '挂了但缺服务，没开工',
  idle: '配置里没挂',
};

/** 渠道英文代号 → 左栏显示中文短标签。 */
const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  feishu: '飞书',
  http: '网页',
  wechat: '微信',
  cli: '命令行',
};


/**
 * 把数值夹在 [min, max] 之间。
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


/**
 * 渠道代号转短中文徽标文本（未知代号原样显示）。
 * @param channel 渠道英文代号。
 */
export function getChannelLabel(channel?: string): string {
  if (channel === undefined || channel === '') return '';

  return CHANNEL_LABELS[channel] ?? channel;
}


/**
 * 算出某个事件在当前轨迹里出现的全部步骤号（去重升序）。
 * @param trail 当前画布轨迹。
 * @param eventName 事件名。
 */
export function getMatchedSteps(trail: Trail | null, eventName: string): number[] {
  if (trail === null || eventName === '') return [];

  const matched: number[] = [];
  for (const step of trail.steps) {
    if (step.rows.some((row) => row.name === eventName)) {
      matched.push(step.no);
    }
  }
  return matched;
}


/** 静态路线的一站：谁做、做什么、涉及的事件。 */
export interface RouteStop {
  title: string;
  plugins: string[];
  events: string[];
}


/** 一条飞书消息怎么走（当前代码），没跑过消息也能看。 */
export const FEISHU_ROUTE: RouteStop[] = [
  {
    title: 'WebSocket 收到，按消息号去重（feishu/index.ts:578、Inbound.ts:169）',
    plugins: ['feishu'],
    events: [],
  },
  {
    title: '下载附件、写原件 JSONL（Inbound.ts:247、:251）',
    plugins: ['feishu'],
    events: [],
  },
  {
    title: '经 emitInbound 一条只发一个：私聊 direct、群里叫了 mention、没叫 listen（Inbound.ts:734）',
    plugins: ['feishu', 'channels'],
    events: ['channel/direct', 'channel/mention', 'channel/listen'],
  },
  {
    title: '各插件按需听：记进库、收件表、看批复（只看前两个）（memory/ChannelIndex.ts:621 等）',
    plugins: ['memory', 'web-api', 'approval'],
    events: [],
  },
  {
    title: '认出哪个机器人接，relay 可抢走；只听的先判断（bots/index.ts:552、DispatchClaim.ts:77）',
    plugins: ['bots', 'relay'],
    events: ['bot/receive'],
  },
  {
    title: '排进前台单队列，轮到就开跑（bots/DispatchResults.ts:854）',
    plugins: ['bots'],
    events: [],
  },
  {
    title: '会话循环四个关口（Sessions.ts:812、:843、:768，Tools.ts:187）',
    plugins: [],
    events: ['session/before-model', 'session/after-model', 'session/before-tool', 'session/after-tool'],
  },
  {
    title: '模型调 channel_reply，发回复请求等回执（bots/ChannelTools.ts:292、channels/Reply.ts:213）',
    plugins: ['bots', 'channels'],
    events: ['channel/reply'],
  },
  {
    title: '飞书发出去，回带原请求的回执（feishu/Reply.ts:65、:144、:201）',
    plugins: ['feishu', 'channels'],
    events: ['channel/replied'],
  },
  {
    title: '会话完；一次没回的：飞书再跑一轮，网页把最后一句发出（DispatchResults.ts:542、:550）',
    plugins: ['bots'],
    events: ['session/change'],
  },
  {
    title: '这一轮完了，接着推下一条（bots/DispatchResults.ts:707）',
    plugins: ['bots'],
    events: ['bot/settled'],
  },
];


/**
 * 左栏路线的一站。
 * @param props.index 第几站，从 0 起。
 * @param props.stop 这一站。
 * @param props.pluginNames 全部已知插件名，是插件的标签能点。
 * @param props.onSelectPlugin 点插件在右栏看。
 */
export function RouteStopItem(props: {
  index: number;
  stop: RouteStop;
  pluginNames: Set<string>;
  onSelectPlugin: (name: string, ptab?: string) => void;
}): JSX.Element {
  const { stop } = props;
  return (
    <div className="tu-route-stop">
      <div><b>{props.index + 1}</b> {stop.title}</div>
      <div className="tu-route-tags">
        {stop.plugins.map((plugin) => {
          if (!props.pluginNames.has(plugin)) return <span key={plugin} className="tu-dep-tag skeleton">{plugin}</span>;

          return (
            <button
              key={plugin}
              type="button"
              className="tu-dep-tag clickable"
              onClick={() => props.onSelectPlugin(plugin, 'events')}
            >
              {plugin}
            </button>
          );
        })}
        {stop.events.map((event) => (
          <code key={event} className="tu-route-event">{event}</code>
        ))}
      </div>
    </div>
  );
}
