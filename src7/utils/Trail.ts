/**
 * 跟踪行和轨迹的形状，以及 journal 与 tutorial 共用的两个常量。
 * journal（Trail.ts 收轨迹）和 tutorial（画泳道图、拍快照）各自按这些形状读写，彼此不 import；
 * 要对方的数据就发 journal/request、等 journal/result。
 */
import type * as traceText from '../../web/src/locales/Trace.ts';


/** 一段函数注释：启动轨迹由 tutorial/Source.ts 从源码取（CodeDoc，字段更多），这里只认名字，别的原样带给页面。 */
export interface TrailDoc {
  /** 函数名或文件名。 */
  name: string;
}


/** 跟踪行里这里用到的字段（journal 的 JournalEvent 带的更多，也能直接给）。 */
export interface TrailLine {
  id: number;
  at: number;
  kind: string;
  name: string;
  /** Cordis 发法；旧流水和启动合成行可传旧文字或省略。 */
  mode?: string;
  listeners: string[];
  text: string;
  site: string;
  sessionId: string | null;
  messageId: number | null;
  /** 标准消息号（渠道发来的）；旧行、启动合成行没有。 */
  sourceId?: string | null;
  vars: Record<string, unknown>;
  /** 泳道图上的道；不给就按 site 认（getNode）。启动轨迹给：一个插件一步。 */
  node?: string;
  /** 已经挑过、可以露的关键值；不给就从 vars 里按 FACT_KEYS 挑。 */
  facts?: Record<string, string | number | boolean>;
  /** 这一行对应的函数注释（启动轨迹才有）。 */
  docs?: TrailDoc[];
}


/** 一步里的一行，给页面展开看。 */
export interface TrailRow {
  /** 离这条请求开始过了多少毫秒。 */
  t: number;
  /** 到下一行隔了多少毫秒（最后一行是 0）。 */
  gap: number;
  /** 函数（跟踪点）还是事件。 */
  kind: string;
  /** 跟踪点是“模块.函数”，事件是事件名。 */
  name: string;
  /** 文案编号或旧行原文。 */
  text: string;
  /** 当前文案需要的插值。旧行没有。 */
  params?: traceText.TraceParams;
  /** 事件行：听的人（去掉只记账的 journal、tutorial、usage）。 */
  listeners: string[];
  /** 文件:行号。 */
  site: string;
  /** 不含对话内容的几个关键值。 */
  facts: Record<string, string | number | boolean>;
  /** 这一行算不算出错。 */
  error: boolean;
}


/** 轨迹的一步：连着落在同一个插件（或骨架服务）上的几行。 */
export interface TrailStep {
  /** 第几步，从 1 起。 */
  no: number;
  /** 泳道图上的道：插件名，或 main / resources / tools / sessions。 */
  node: string;
  /** 这一步在干什么（一句话）。 */
  title: string;
  /** 离开始多少毫秒。 */
  t: number;
  /** 这一步用了多少毫秒（到下一步开始）。 */
  ms: number;
  /** 这一步里有没有出错的行。 */
  error: boolean;
  /** 收到通知但没留下跟踪点的插件（只听不说的）。 */
  notified: string[];
  /** 这一步的几行。 */
  rows: TrailRow[];
  /** 这一步的函数注释，照行的先后；请求轨迹没有，是空的。 */
  docs: TrailDoc[];
}


/** 一条请求的轨迹。 */
export interface Trail {
  /** 收件表消息号；启动是 0。 */
  message: number;
  /** 哪场会话；启动、没找到是 null。 */
  session: string | null;
  /** 哪个机器人。 */
  bot: string;
  /** 哪个渠道；启动写“启动”。 */
  channel: string;
  /** 用户那句话（调试用不打码）；启动、没记到的是空串。 */
  preview: string;
  /** 开始时刻，毫秒时间戳。 */
  at: number;
  /** 从收下到回话写回用了多少毫秒。 */
  ms: number;
  /** running：还没回完；done、failed、stopped：会话最后的状态；unknown：没找到收尾。 */
  state: string;
  /** 有没有出错的步。 */
  error: boolean;
  /** 一步一步。 */
  steps: TrailStep[];
  /** 关键变量的英文键 → 中文解释，整条轨迹共用一张（网页在 JSON 那行后面灰字显示）。 */
  notes: Record<string, string>;
}



/** 和这条请求无关、隔一会儿就来一次的事件。journal 收轨迹、tutorial 拍快照都跳过这些。 */
export const NOISE = new Set(['web-api/status', 'trace', 'ready']);

/** 自带插件里名字和文件夹不一样的（plugins/Index.ts 的别名）：名字 → 文件夹。journal 认道、tutorial/Boot.ts 找插件文件都用它。 */
export const FOLDERS: Record<string, string> = { 'wechat-kefu': 'wechat' };
