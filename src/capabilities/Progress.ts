/**
 * 进度卡片（docs/界面/03_进度事件和复盘设计.md 第 1～2 节）。用户 11-06 拍板：一条消息一张卡，做完改成“完成 + 结果”、不撤回；
 * 限时（03 文档第 2.1 节，用户 11-06 定：“最长 20 分钟，超过 10 分钟就要介入”）：不选就最长 20 分钟、第 10 分钟开始报时；
 * 卡片上能选最多 15 / 20 分钟（提前 5 分钟报时）或不限时，还能随时终止；都从开始干活算。报时：每一步交给模型的话末尾加一行
 * 已经干了多久（clockNote）。到点先问判断模型：还在推进、5 分钟内能做完、没在打转，就延长 5 分钟，最多两次；不然打断，
 * 再用收尾模型不带工具总结做到哪了。卡片上选了 15、20 分钟的，到点就停，不判断。
 * 延够两次还没做完（第 5 条）：问审核模型，离谱就停下告诉用户；建议转就叫 BotLoop 开新会话、放进交接说明接着做，
 * 一件事只转一次。计时只在这里（事件 limit.warned、limit.reached、limit.extended、limit.stopped 也由这里报）。
 * 程序在收到、分派、每一步、每个工具、等审核、结束这些地方记一笔，不经过模型、不占 token；记不上、发不出去都不挡干活。
 * 能画卡片的渠道（飞书）发卡片、原地改；网页从 /api/progress 取。只在内存里，程序重启就没了。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as utils from '../utils/Utils.ts';
import type * as aiModule from './Model.ts';
import type * as depsModule from './Deps.ts';
import type * as eventsModule from './Events.ts';
import type * as resourcesModule from '../resources/Resources.ts';
import type * as storeModule from './Store.ts';
import type * as dispatchModule from '../dispatch/Dispatch.ts';
import type * as botLoopModule from '../bots/BotLoop.ts';
import * as checks from '../utils/Checks.ts';
import * as replyEvidence from './ReplyEvidence.ts';


/** 卡片最快多久改一次，毫秒：状态变得再勤也合并成一次（飞书一条消息每秒最多改 5 次）。 */
const PUSH_EVERY_MS = 1000;

/** 卡片上能选的限时，分钟（用户 11-06 定的）。 */
export const LIMIT_CHOICES = [15, 20];

/** 卡片上选了限时的，到点前几分钟开始报时（03 文档第 2.1 节第 2 条）。 */
const CHOSEN_REMIND_BEFORE_MINUTES = 5;

/** 到点判断时给判断模型看最近几行工作过程。 */
const JUDGE_LOG_LINES = 15;

/** 判断模型“是”的概率到多少算是。 */
const JUDGE_PASS = 0.5;

/** 到点问判断模型的三道是非题（03 文档第 2.1 节第 4 条）。 */
const JUDGE_QUESTIONS: Record<string, piAi.ClassifierBoolQuestion> = {
  progressing: {
    type: 'bool',
    instructions: '这件事还在往前推进吗？最近几步在做新的事、有进展，算“是”；原地踏步、重复同样的操作，算“否”。',
    criteria: { true: '在推进', false: '没在推进' },
  },
  nearlyDone: {
    type: 'bool',
    instructions: '照现在的进度，再给 5 分钟能把用户要的做完吗？',
    criteria: { true: '5 分钟内能做完', false: '5 分钟做不完' },
  },
  looping: {
    type: 'bool',
    instructions: '有没有在打转：同一条命令反复失败、反复做同样的事、绕圈子、偏离了用户要的？',
    criteria: { true: '在打转', false: '没在打转' },
  },
};

/** 结束的卡片在内存里留多久，毫秒：网页还要显示一会儿。 */
const KEEP_ENDED_MS = 10 * 60_000;

/** 工作过程最多记多少行（收尾总结读它）。 */
const LOG_LINES = 80;

/** 记进工作过程时，工具参数和结果各截多少字。 */
const LOG_CHARS = 200;

/** 卡片上那句话、结果各截多少字。 */
const TEXT_CHARS = 80;

/** 收尾总结怎么写。 */
const WRAPUP_PROMPT = {
  zh: '用户给这件事设了时间上限，现在到点了，工作已经停下。照下面的工作过程写一段收尾总结，三小段，每段一两句：做到哪了；卡在哪、为什么慢；还剩什么、接着做先干什么。只写工作过程里有的，不要编。',
  en: 'The user set a time limit for this task and it has been reached; the work has stopped. Using the work log below, write a short wrap-up in three parts, one or two sentences each: what got done; where it got stuck and why it was slow; what is left and what to do first next time. Only state what is in the log.',
};

/** 审核模型怎么看（03 文档第 2.1 节第 5 条）：延了两次还没做完，有没有离谱、要不要转新会话；只回一个 JSON。 */
const REVIEW_PROMPT = {
  zh: [
    '用户给这件事设了时间上限，已经延长过两次，还没做完。你是审核：读下面的用户原话和工作过程，判断两件事，只回一个 JSON，不要别的字：',
    '{"absurd": true 或 false, "absurdWhy": "…", "handoff": true 或 false, "handoffNote": "…"}',
    '- absurd：有没有离谱的行为：同一条命令反复失败、绕圈子、偏离了用户要的、乱删乱改。有就 true，absurdWhy 用一两句说清哪里离谱，引用工作过程里的事；没有就 false，absurdWhy 写空字符串。',
    '- handoff：要不要转到一个新会话接着做。方向是对的，只是上下文被旧的尝试塞满、越做越乱，换个干净的会话更容易做完，就 true；做不下去的原因换会话也解决不了（缺权限、缺东西、要用户定），就 false。absurd 是 true 时 handoff 写 false。',
    '- handoffNote：handoff 是 true 时写给新会话的交接说明，分四段，每段开头写小标题：目标（用户要什么）；做到哪了；卡在哪；别再怎么做（试过不行的路）。只写工作过程里有的，不要编。handoff 是 false 时写空字符串。',
  ].join('\n'),
  en: [
    'The user set a time limit for this task; it has been extended twice and is still not done. You are the reviewer: read the user request and the work log below and decide two things. Reply with one JSON object only, nothing else:',
    '{"absurd": true or false, "absurdWhy": "...", "handoff": true or false, "handoffNote": "..."}',
    '- absurd: is there unreasonable behaviour — the same command failing again and again, going in circles, drifting from what the user asked, careless deletes or edits? If so true, and absurdWhy says where in one or two sentences, citing the log; otherwise false and an empty absurdWhy.',
    '- handoff: should the work continue in a fresh session? true when the direction is right but the context is clogged with old attempts and a clean session would finish more easily; false when a fresh session would not help (missing permission, missing material, needs the user to decide). If absurd is true, handoff is false.',
    '- handoffNote: when handoff is true, a handover note for the new session in four parts, each with a short heading: goal (what the user wants); what is done; where it is stuck; what not to do again (paths that failed). Only state what is in the log. Empty string when handoff is false.',
  ].join('\n'),
};


/** 卡片现在在哪个阶段。 */
export type ProgressStage = 'dispatching' | 'held' | 'running' | 'merged' | 'done' | 'error' | 'interrupted' | 'limit' | 'timeout' | 'stopped' | 'flagged' | 'handed';


/** 各段花了多久。 */
export interface ProgressTimings {
  /** 分派用了多久，毫秒。 */
  dispatchMs: number;
  /** 模型思考一共多久，毫秒。 */
  modelMs: number;
  /** 走了几步。 */
  steps: number;
  /** 每个工具：调了几次、一共多久（毫秒）。 */
  tools: { name: string; count: number; ms: number }[];
}


/** 一张进度卡片看到的东西：渠道照它画卡片，网页照它显示。 */
export interface ProgressView {
  /** 卡片号（进程内递增）。 */
  id: number;
  /** 哪个机器人。 */
  bot: string;
  /** 管着的消息号。 */
  messageIds: number[];
  /** 触发它的那句话（截短）。 */
  text: string;
  /** 进了哪个会话。 */
  sessionId?: string;
  /** 会话标题。 */
  sessionTitle?: string;
  /** 用的模型。 */
  model?: string;
  /** 阶段。 */
  stage: ProgressStage;
  /** 当前在做什么，给人看的一句话。 */
  action: string;
  /** 开始的时间，毫秒。 */
  startedAt: number;
  /** 结束的时间，毫秒；还在做是 undefined。 */
  endedAt?: number;
  /** 最长做几分钟（不选就是默认的 engine.limit_default_minutes，20）；不限时是 undefined。不含延长的。 */
  limitMinutes?: number;
  /** 用户在卡片上选过（15、20 或不限时）；没选过就是默认上限。 */
  limitChosen?: boolean;
  /** 到点判断快做完了、延长过几次（每次 engine.limit_extend_minutes 分钟）。 */
  extended?: number;
  /** 各段耗时。 */
  timings: ProgressTimings;
  /** 结束时的结果或收尾总结。 */
  result?: string;
}


/** 内存里的一张卡。 */
interface Card {
  /** 看到的东西。 */
  view: ProgressView;
  /** 发到哪个渠道。 */
  channel: string;
  /** 渠道里的地址。 */
  address: Record<string, unknown>;
  /** 渠道里那张卡片的号（飞书 message_id）；空字符串是这个渠道画不了卡片；还没发是 undefined。 */
  handle?: string;
  /** 发、改排成一串，不并发。 */
  chain: Promise<void>;
  /** 合并改写的定时器。 */
  timer?: ReturnType<typeof setTimeout>;
  /** 到点（判断要不要停）的定时器。 */
  limitTimer?: ReturnType<typeof setTimeout>;
  /** 开始报时的定时器。 */
  remindTimer?: ReturnType<typeof setTimeout>;
  /** 开始报时的时间，毫秒；不限时是 undefined。 */
  remindAt?: number;
  /** 到点的时间（含延长），毫秒；不限时是 undefined。 */
  deadlineAt?: number;
  /** 要停：用户点了终止（stop）、限时到了（timeout）、审核建议转到新会话（handoff）。 */
  stopAsked?: 'stop' | 'timeout' | 'handoff';
  /** 这件事是从别的会话转过来的：延够了不再转（一件事只转一次）。 */
  handedOver?: boolean;
  /** 审核发现的离谱行为：停下时告诉用户。 */
  flagged?: string;
  /** 审核写的交接说明：转新会话时放进第一条消息。 */
  handoffNote?: string;
  /** 已经叫会话停了。 */
  interruptSent?: boolean;
  /** 工具开始的时间。 */
  toolStartedAt?: number;
  /** 工作过程，一行一件事。 */
  log: string[];
}


/** 收尾文字和它自己那次调用的生成依据，局部返回，不与审核共用“最近模型”。 */
interface WrapUpResult {
  /** 既有收尾文字，包含原来的失败提示，发送行为不变。 */
  text: string;
  /** 仅这次总结调用的生成依据，不能被审核或压缩调用覆盖。 */
  generation: storeModule.ReplyGeneration;
}


/** 审核模型的结论（第 5 条）。 */
interface ReviewVerdict {
  /** 有没有离谱的行为。 */
  absurd: boolean;
  /** 哪里离谱。 */
  absurdWhy: string;
  /** 要不要转到新会话接着做（建议转却没写交接说明的，算不转）。 */
  handoff: boolean;
  /** 给新会话的交接说明。 */
  handoffNote: string;
  /** 不离谱也不转时为什么（停下的原因里写它）。 */
  why: string;
}


/**
 * 审核没给出结论时的兜底：不离谱、不转，调用方就停下收尾。
 * @param why 为什么没有结论。
 */
function noVerdict(why: string): ReviewVerdict {
  return { absurd: false, absurdWhy: '', handoff: false, handoffNote: '', why };
}


/**
 * 毫秒写成秒。
 * @param ms 毫秒。
 * @returns 如“12.3 秒”“2 分 5 秒”。
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} 秒`;
  }
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}


/**
 * 各段耗时说成一句话。
 * @param view 卡片。
 * @returns 如“分派 2.1 秒；思考 5 步 40.2 秒；find ×3 18.4 秒、read ×5 2.1 秒；总共 1 分 3 秒”。
 */
export function describeTimings(view: ProgressView): string {
  /** 几段。 */
  const parts = [`分派 ${formatDuration(view.timings.dispatchMs)}`];
  if (view.timings.steps > 0) {
    parts.push(`思考 ${view.timings.steps} 步 ${formatDuration(view.timings.modelMs)}`);
  }
  if (view.timings.tools.length > 0) {
    parts.push([...view.timings.tools].sort((left, right) => right.ms - left.ms).map((item) => `${item.name} ×${item.count} ${formatDuration(item.ms)}`).join('、'));
  }
  parts.push(`总共 ${formatDuration((view.endedAt ?? Date.now()) - view.startedAt)}`);
  return parts.join('；');
}


/**
 * 工具参数说成一句短话（卡片上、工作过程里用）。
 * @param args 参数。
 */
function describeArgs(args: Record<string, unknown>): string {
  /** 最能说明它在干什么的那个参数。 */
  const main = args.command ?? args.query ?? args.path ?? args.pattern ?? args.text ?? args.action;
  return typeof main === 'string' ? utils.truncate(main.replace(/\s+/g, ' '), 60) : '';
}


/** 把一张卡的样子复制一份（messageIds、timings 都另拷，调用方改不到内存里的）。 */
function copyView(view: ProgressView): ProgressView {
  /** 各工具的统计，逐项拷贝。 */
  const tools = view.timings.tools.map((item) => ({ ...item }));
  return { ...view, messageIds: [...view.messageIds], timings: { ...view.timings, tools } };
}


/**
 * 进度登记表：一条消息一张卡，状态都在内存里。入口 src/entries/App.ts 建一个，
 * 挂在 deps.progress 上，BotLoop、SessionRunner、Http 等从 deps 取来用。
 */
export class Progress {
  /** 下一张卡的号。 */
  private nextId = 1;

  /** 卡片号 → 卡。 */
  private readonly cards = new Map<number, Card>();

  /** 消息号 → 卡片号。 */
  private readonly byMessage = new Map<number, number>();

  /** 会话 → 还在跑的那张卡的号。 */
  private readonly bySession = new Map<string, number>();

  /**
   * 机器人循环（src/bots/BotLoop.ts）：转新会话时用它开会话、放交接说明、跑起来。
   * 入口建完 BotLoop 后用 attachBotLoop 接上；没接上就不转，停下收尾。
   */
  private botLoop?: botLoopModule.BotLoop;

  /**
   * @param resources 运行时资源：读设置（超时分钟、收尾模型）、机器人语言、运行时目录；入口建。
   * @param store 数据库：查会话、写会话的 interrupt、存收尾总结的回复；入口建。
   * @param ai 模型：收尾总结调一次；入口建。
   * @param out 往渠道发东西的出口：渠道中心 ChannelHub（src/channels/index.ts），入口 src/entries/App.ts 最先建它，
   *   渠道开起来以前发会报“渠道没开”。
   * @param events 事件总线（src/capabilities/Events.ts 的 EventBus）：报 limit.*；由入口构造并传入。
   * @param minuteMs 一分钟算多少毫秒；只有测试会改小。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly store: storeModule.Store,
    private readonly ai: aiModule.Ai,
    private readonly out: depsModule.Outlet,
    private readonly events: eventsModule.EventBus,
    private readonly minuteMs = 60_000,
  ) {}

  /**
   * 接上机器人循环（转新会话要用）。BotLoop 构造时要先有 Progress，所以不放进构造参数：
   * 入口 src/entries/App.ts 建完 BotLoop 后调一次。
   * @param botLoop 机器人循环。
   */
  attachBotLoop(botLoop: botLoopModule.BotLoop): void {
    this.botLoop = botLoop;
  }

  /**
   * 转过来的交接说明（03 文档第 2.1 节第 5 条）：给它建一张卡、直接绑到新会话，按默认上限从头计时；
   * 记着是转过来的，延够了不再转。由 BotLoop.handOff（src/bots/BotLoop.ts）在排给新会话之前调。
   * @param rows 交接说明那一条。
   * @param sessionId 新会话。
   * @param fromTitle 老会话的标题（记进工作过程）。
   */
  handedOver(rows: storeModule.MessageRow[], sessionId: string, fromTitle: string): void {
    this.received(rows);
    /** 刚建的卡。 */
    const card = this.cards.get(this.byMessage.get(rows[0]?.id ?? 0) ?? 0);
    if (!card) {
      return;
    }
    card.handedOver = true;
    this.note(card, `从会话「${fromTitle}」转过来接着做`);
    /** 没经过分派：分派用时记 0。 */
    const record = { ms: 0 };
    this.dispatched(rows, sessionId, record);
  }

  /** 新的一批话到了：一批一张卡，发到这批最后一句来的渠道。 */
  received(rows: storeModule.MessageRow[]): void {
    /** 最后一句：卡片发到它来的渠道。 */
    const last = rows.at(-1);
    if (!last) {
      return;
    }
    /** 触发它的那句话（合并、压成一行、截短）。 */
    const text = utils.truncate(
      rows.map((row) => row.text).join(' ').replace(/\s+/g, ' '),
      TEXT_CHARS,
    );
    /** 卡片的样子。 */
    const view: ProgressView = {
      id: this.nextId,
      bot: last.bot,
      messageIds: rows.map((row) => row.id),
      text,
      stage: 'dispatching',
      action: '收到，正在分派',
      startedAt: Date.now(),
      timings: { dispatchMs: 0, modelMs: 0, steps: 0, tools: [] },
    };
    /** 卡。 */
    const card: Card = {
      view,
      channel: last.channel,
      address: last.address,
      chain: Promise.resolve(),
      log: [],
    };
    this.nextId += 1;
    this.cards.set(card.view.id, card);
    for (const row of rows) {
      this.byMessage.set(row.id, card.view.id);
    }
    this.push(card, true);
  }

  /** 这批要等某条待确认有结果才分派。 */
  held(rows: storeModule.MessageRow[], approvalId: number): void {
    /** 卡。 */
    const card = this.cards.get(this.byMessage.get(rows[0]?.id ?? 0) ?? 0);
    if (card) {
      card.view.stage = 'held';
      card.view.action = `要等待审核 #${approvalId} 有结果才能接着分派`;
      this.push(card);
    }
  }

  /** 分派完了：绑到会话；会话已经有卡在跑就并进那张。分派记录只用到用时（ms）。 */
  dispatched(
    rows: storeModule.MessageRow[],
    sessionId: string,
    record: Pick<dispatchModule.DispatchRecord, 'ms'>,
  ): void {
    /** 卡。 */
    const card = this.cards.get(this.byMessage.get(rows[0]?.id ?? 0) ?? 0);
    if (!card || card.view.endedAt) {
      return;
    }
    card.view.timings.dispatchMs += record.ms;
    /** 会话。 */
    const session = this.store.getSession(sessionId);
    /** 会话标题；查不到用会话号。 */
    const titleText = session?.title ?? sessionId;
    /** 这个会话已经有卡在跑：话并进那张，这张定格。 */
    const running = this.cards.get(this.bySession.get(sessionId) ?? 0);
    if (running && running !== card && !running.view.endedAt) {
      running.view.messageIds.push(...card.view.messageIds);
      this.note(running, `用户插话：${card.view.text}`);
      this.push(running);
      this.close(card, 'merged', `并进了会话「${titleText}」正在跑的那张卡`);
      return;
    }
    card.view.sessionId = sessionId;
    card.view.sessionTitle = session?.title;
    card.view.model = session?.model;
    card.view.stage = 'running';
    card.view.action = `进了会话「${titleText}」，马上开始`;
    this.bySession.set(sessionId, card.view.id);
    //M 用户没在卡片上选过限时：按默认上限计时（用户 11-06：“最长20分钟，初步超过10分钟就要介入”）。
    if (!card.view.limitChosen) {
      this.setLimit(card, this.resources.getSetting('limitDefaultMinutes'), false);
    }
    /** 记进工作过程的分派那一行。 */
    const dispatchLine = `分派：进会话「${titleText}」，用 ${session?.model ?? '默认模型'}，`
      + `用了 ${formatDuration(record.ms)}`;
    this.note(card, dispatchLine);
    this.push(card);
  }

  /** 会话开始想第几步。 */
  thinking(sessionId: string, step: number, model: string): void {
    /** 卡。 */
    const card = this.active(sessionId);
    if (card) {
      card.view.model = model;
      card.view.timings.steps = step;
      card.view.action = `正在思考（第 ${step} 步）`;
      this.push(card);
    }
  }

  /** 这一步想完了。 */
  thought(sessionId: string, ms: number, text: string): void {
    /** 卡。 */
    const card = this.active(sessionId);
    if (card) {
      card.view.timings.modelMs += ms;
      if (text.trim()) {
        /** 想的内容压成一行、截短。 */
        const brief = utils.truncate(text.trim().replace(/\s+/g, ' '), LOG_CHARS);
        this.note(card, `第 ${card.view.timings.steps} 步想的：${brief}`);
      }
    }
  }

  /** 开始调一个工具。 */
  tool(sessionId: string, name: string, args: Record<string, unknown>): void {
    /** 卡。 */
    const card = this.active(sessionId);
    if (card) {
      card.toolStartedAt = Date.now();
      /** 参数。 */
      const brief = describeArgs(args);
      card.view.action = `正在调用 ${name}${brief ? `（${brief}）` : ''}`;
      this.push(card);
    }
  }

  /** 工具调完了。 */
  toolDone(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    ms: number,
    result: string,
  ): void {
    /** 卡。 */
    const card = this.active(sessionId);
    if (!card) {
      return;
    }
    /** 这个工具的统计。 */
    const stats = card.view.timings.tools.find((item) => item.name === name);
    if (stats) {
      stats.count += 1;
      stats.ms += ms;
    } else {
      card.view.timings.tools.push({ name, count: 1, ms });
    }
    card.toolStartedAt = undefined;
    /** 参数和结果各压成一行、截短。 */
    const argsText = utils.truncate(describeArgs(args), LOG_CHARS);
    const resultText = utils.truncate(result.replace(/\s+/g, ' '), LOG_CHARS);
    this.note(card, `调用 ${name}（${argsText}）用了 ${formatDuration(ms)}，结果：${resultText}`);
  }

  /** 一条命令在等用户审核（会话不等，接着跑）。 */
  waiting(sessionId: string, approvalId: number): void {
    /** 卡。 */
    const card = this.active(sessionId);
    if (card) {
      card.view.action = `一条命令在等审核 #${approvalId}，会话先接着干别的`;
      this.note(card, `命令要等审核 #${approvalId}`);
      this.push(card);
    }
  }

  /** 会话这次运行结束了。 */
  ended(sessionId: string, ending: storeModule.RunEnding, text: string): void {
    /** 卡。 */
    const card = this.cards.get(this.bySession.get(sessionId) ?? 0);
    if (!card) {
      return;
    }
    if (card.stopAsked === 'stop') {
      this.close(card, 'stopped', '用户终止了');
      return;
    }
    //M 要转新会话（第 5 条）：老会话正好做完了就当完成；不然开新会话接着做。
    if (card.stopAsked === 'handoff' && ending !== 'done') {
      void this.handOff(card, sessionId);
      return;
    }
    if (card.stopAsked !== 'timeout') {
      /** 结局 → 阶段和那句话。 */
      const looks: Record<storeModule.RunEnding, [ProgressStage, string]> = {
        done: ['done', '完成'],
        error: ['error', '出错了'],
        interrupted: ['interrupted', '被新的话打断了'],
        limit: ['limit', '步数到上限了'],
      };
      this.close(card, looks[ending][0], looks[ending][1], text);
      return;
    }
    //M 限时到了：先定格成“正在写收尾总结”，写完再改卡片、把总结发给用户；审核发现离谱的，连哪里离谱一起说。
    card.view.action = '时间到了，正在写收尾总结';
    this.push(card, true);
    void this.wrapUp(card).then(async (summary) => {
      if (card.flagged) {
        this.close(card, 'flagged', `审核发现离谱的行为，停下了（${this.limitText(card)}）`, summary.text);
        /** 发给用户的话：哪里离谱、做到哪了。 */
        const flaggedWords = '⚠ 延长过两次还没做完，审核发现离谱的行为，先停在这里，不自动往下做：\n'
          + `${card.flagged}\n\n做到哪了：\n${summary.text}`;
        await this.tellUser(card, sessionId, flaggedWords, summary.generation);
        return;
      }
      this.close(card, 'timeout', `到点收尾（${this.limitText(card)}）`, summary.text);
      /** 发给用户的话。 */
      const words = `⏱ 到点了，这件事先停在这里：\n${summary.text}`;
      await this.tellUser(card, sessionId, words, summary.generation);
    });
  }

  /**
   * 老会话停下了，转到新会话（第 5 条）：叫机器人循环照老会话开新会话、放进交接说明、跑起来；
   * 老卡片定格成“转到新会话”，告诉用户。转不成就照旧写收尾总结、停在这里。
   * @param card 老卡。
   * @param sessionId 老会话。
   * 副作用：开新会话、写库、发给用户；从不抛错。
   */
  private async handOff(card: Card, sessionId: string): Promise<void> {
    card.view.action = '正在转到新会话';
    this.push(card, true);
    /** 交接说明。 */
    const note = card.handoffNote ?? '';
    try {
      if (!this.botLoop) {
        throw new Error('没接上机器人循环');
      }
      /** 开新会话要的东西：回复照抄原消息的渠道和地址，还发回原来的聊天。 */
      const handOffArgs = {
        fromSession: sessionId,
        text: this.handOffText(card),
        channel: card.channel,
        address: card.address,
      };

      const session = await this.botLoop.handOff(handOffArgs);
      this.close(card, 'handed', `转到新会话「${session.title}」接着做`, note);
      /** 发给用户的话。 */
      const words = `↪ 延长过两次还没做完，审核建议换个干净的会话接着做，已经转到新会话「${session.title}」。`
        + `交接说明：\n${note}`;
      await this.tellUser(card, sessionId, words);
    } catch (error) {
      //G 转不成：照旧写收尾总结，停在这里。
      /** 转不成的原因。 */
      const reason = utils.errorText(error);
      console.error(`${utils.formatTime()} 转新会话没成：${reason}`);
      const summary = await this.wrapUp(card);
      this.close(card, 'timeout', `到点收尾（转新会话没成：${reason}）`, summary.text);
      /** 发给用户的话。 */
      const words = `⏱ 到点了，想转到新会话接着做但没成（${reason}），这件事先停在这里：\n${summary.text}`;
      await this.tellUser(card, sessionId, words, summary.generation);
    }
  }

  /**
   * 新会话的第一条消息：说明是转过来的、用户原话全文、审核写的交接说明。
   * @param card 老卡。
   * @returns 交接说明全文（BotLoop.handOff 再补上老会话记录在哪）。
   */
  private handOffText(card: Card): string {
    /** 老会话叫什么。 */
    const fromTitle = card.view.sessionTitle ?? card.view.sessionId ?? '';
    /** 干了多久。 */
    const used = formatDuration(Date.now() - card.view.startedAt);
    return [
      `（系统）这件事在会话「${fromTitle}」里做了 ${used}，延长过两次还没做完；审核建议换个干净的会话接着做，所以转到这里。`,
      '先看交接说明，别再走“别再怎么做”里写的路；做完照常回复用户，说清是接着上一个会话做的。',
      '',
      '用户原来的话：',
      this.askedText(card),
      '',
      '交接说明：',
      card.handoffNote ?? '',
    ].join('\n');
  }

  /**
   * 用户原话全文：这张卡管着的每条消息的原话（从库里取；卡片上那句只有 TEXT_CHARS 字）。
   * @param card 卡。
   */
  private askedText(card: Card): string {
    /** 每条消息的原话。 */
    const texts = card.view.messageIds
      .map((id) => this.store.getMessage(id)?.text ?? '')
      .filter((text) => text.trim());
    return texts.length > 0 ? texts.join('\n') : card.view.text;
  }

  /**
   * 给用户发一句话（收尾总结、转新会话这类）：存进这张卡最后一条消息的回复，再发到渠道。
   * @param card 卡。
   * @param sessionId 会话（记进回复）。
   * @param words 话。
   * 副作用：写库；往渠道发。发不出去只打日志。
   */
  private async tellUser(
    card: Card,
    sessionId: string,
    words: string,
    generation = replyEvidence.programGeneration('progress-notice'),
  ): Promise<void> {
    /** 最后一条消息。 */
    const lastId = card.view.messageIds.at(-1)!;
    /** 存进消息的回复。 */
    const reply = {
      at: Date.now(),
      session: { id: sessionId, title: card.view.sessionTitle ?? '', file: '' },
      text: words,
      generation: { ...generation },
      association: replyEvidence.association(card.view.messageIds, 'run', '进度卡保存的明确消息范围，未记录生成观察轮'),
    };
    this.store.addReply(lastId, reply);
    await this.out.send(card.channel, card.address, words).catch((error: unknown) => {
      console.error(`${utils.formatTime()} 发给用户的话没发出去：${utils.errorText(error)}`);
    });
  }

  /** 用户点了卡片上的按钮：stop 终止；limit 限时，从开始干活算（minutes 不给就是不限）。输出回给用户的一句话。 */
  act(cardId: number, action: 'stop' | 'limit', minutes?: number): string {
    /** 卡。 */
    const card = this.cards.get(cardId);
    if (!card || card.view.endedAt) {
      return '这件事已经结束了';
    }
    if (action === 'stop') {
      card.stopAsked = 'stop';
      card.view.action = '正在停下';
      this.interrupt(card);
      this.push(card, true);
      return '收到，马上停';
    }
    if (!minutes) {
      this.setLimit(card, undefined, true);
      this.push(card, true);
      return '不限时，一直做，也不报时';
    }
    //M 从开始干活算（用户 11-06：15 分钟后再点“最多 5 分钟”，就该马上结束）；点过就不再延长，到点就停。
    /** 还剩多久。 */
    const left = card.view.startedAt + minutes * this.minuteMs - Date.now();
    if (left <= 0) {
      this.setLimit(card, minutes, true);
      this.stop(card, `已经超过 ${minutes} 分钟，用户在卡片上点的`);
      return `已经超过 ${minutes} 分钟，马上收尾`;
    }
    this.setLimit(card, minutes, true);
    this.push(card, true);
    return `最多做 ${minutes} 分钟，还剩 ${formatDuration(left)}`;
  }

  /**
   * 报时那一行（03 文档第 2.1 节第 3 条）：过了报时点、还没结束、不是不限时，才有。会话循环每一步调模型前拿一次，
   * 只加在这次送给模型的话末尾，不存进对话。
   * @param sessionId 会话。
   * @returns 那一行；不用报时是 undefined。
   */
  clockNote(sessionId: string): string | undefined {
    /** 卡。 */
    const card = this.cards.get(this.bySession.get(sessionId) ?? 0);
    if (!card || card.view.endedAt || card.remindAt === undefined || Date.now() < card.remindAt) {
      return undefined;
    }
    /** 已经干了多久。 */
    const elapsed = formatDuration(Date.now() - card.view.startedAt);
    return `（系统）这件事已经干了 ${elapsed}，${this.limitText(card)}。`
      + '回复用户时说清干了多久、做到哪了；快到点了就抓紧收尾，做不完就写清做到哪了、还剩什么。';
  }

  /**
   * 定这张卡的限时、排两个定时器：报时点、到点。不限时就都清掉。
   * @param card 卡。
   * @param minutes 最长几分钟；undefined 是不限时。
   * @param chosen 是不是用户在卡片上选的（选的提前 5 分钟报时，默认的提前 engine.limit_remind_before_minutes）。
   */
  private setLimit(card: Card, minutes: number | undefined, chosen: boolean): void {
    clearTimeout(card.limitTimer);
    clearTimeout(card.remindTimer);
    card.view.limitMinutes = minutes;
    card.view.limitChosen = chosen;
    card.view.extended = 0;
    if (minutes === undefined) {
      card.remindAt = undefined;
      card.deadlineAt = undefined;
      return;
    }
    /** 到点前几分钟开始报时。 */
    const before = chosen ? CHOSEN_REMIND_BEFORE_MINUTES : this.resources.getSetting('limitRemindBeforeMinutes');
    card.deadlineAt = card.view.startedAt + minutes * this.minuteMs;
    card.remindAt = card.deadlineAt - before * this.minuteMs;
    //M 报时点：报一条 limit.warned，以后每一步都带着报时那一行（clockNote）。
    card.remindTimer = setTimeout(() => {
      if (!card.view.endedAt) {
        this.note(card, `过了报时点（第 ${String(Math.round((card.remindAt! - card.view.startedAt) / this.minuteMs))} 分钟），开始报时`);
        this.report(card, 'limit.warned', { minutes, elapsedMs: Date.now() - card.view.startedAt, chosen });
        this.push(card);
      }
    }, Math.max(0, card.remindAt - Date.now()));
    this.armDeadline(card);
  }

  /**
   * 排到点的定时器（到 card.deadlineAt）。
   * @param card 卡。
   */
  private armDeadline(card: Card): void {
    clearTimeout(card.limitTimer);
    if (card.deadlineAt === undefined) {
      return;
    }
    card.limitTimer = setTimeout(() => {
      void this.onDeadline(card).catch((error: unknown) => {
        console.error(`${utils.formatTime()} 限时到点处理出错：${utils.errorText(error)}`);
      });
    }, Math.max(0, card.deadlineAt - Date.now()));
  }

  /**
   * 到点（03 文档第 2.1 节第 4 条）：先报 limit.reached；还能延长就问判断模型，还在推进、快做完、没在打转就延长，
   * 不然停下（和点“终止”一样，之后写收尾总结）。
   * @param card 卡。
   */
  private async onDeadline(card: Card): Promise<void> {
    if (card.view.endedAt || card.stopAsked) {
      return;
    }
    /** 延长过几次。 */
    const extended = card.view.extended ?? 0;
    this.report(card, 'limit.reached', { minutes: card.view.limitMinutes, elapsedMs: Date.now() - card.view.startedAt, extended });
    //M 用户在卡片上选的上限：到点就停，不判断、不延长（第 2 条“选 15 或 20：到点自动停”）。
    if (card.view.limitChosen) {
      this.stop(card, `${this.limitText(card)}，是用户在卡片上选的，到点就停`);
      return;
    }
    if (extended >= this.resources.getSetting('limitExtendTimes')) {
      await this.afterExtensions(card, extended);
      return;
    }
    /** 判断的结果。 */
    const verdict = await this.judge(card);
    if (card.view.endedAt || card.stopAsked) {
      return;
    }
    if (!verdict.extend) {
      this.stop(card, verdict.why);
      return;
    }
    /** 一次延长几分钟。 */
    const extendMinutes = this.resources.getSetting('limitExtendMinutes');
    card.view.extended = extended + 1;
    card.deadlineAt = (card.deadlineAt ?? Date.now()) + extendMinutes * this.minuteMs;
    /** 第几次（一共几次）。 */
    const times = `第 ${String(card.view.extended)}/${String(this.resources.getSetting('limitExtendTimes'))} 次`;
    this.note(card, `到点判断快做完了，再给 ${String(extendMinutes)} 分钟（${times}）：${verdict.why}`);
    this.report(card, 'limit.extended', { times: card.view.extended, minutes: extendMinutes, why: verdict.why });
    this.armDeadline(card);
    this.push(card, true);
  }

  /**
   * 延够了还没做完（第 5 条）：转过一次的直接停；不然问审核模型，离谱就停下（收尾时告诉用户哪里离谱），
   * 建议转、也接上了机器人循环就转新会话，都不是就停下收尾。
   * @param card 卡。
   * @param extended 延长过几次。
   */
  private async afterExtensions(card: Card, extended: number): Promise<void> {
    /** 停下的原因开头。 */
    const why = `${this.limitText(card)}，已经延长过 ${String(extended)} 次`;
    if (card.handedOver) {
      this.stop(card, `${why}；这件事已经转过一次新会话，不再转`);
      return;
    }
    /** 审核的结论。 */
    const verdict = await this.review(card);
    if (card.view.endedAt || card.stopAsked) {
      return;
    }
    if (verdict.absurd) {
      card.flagged = verdict.absurdWhy || '（审核没写哪里离谱）';
      this.stop(card, `${why}；审核发现离谱：${card.flagged}`, { review: 'absurd' });
      return;
    }
    if (verdict.handoff && this.botLoop) {
      this.askHandOff(card, verdict.handoffNote, `${why}；审核建议换个干净的会话接着做`);
      return;
    }
    if (verdict.handoff) {
      this.stop(card, `${why}；审核建议转新会话，但没接上机器人循环，只能停下`, { review: 'handoff' });
      return;
    }
    this.stop(card, `${why}；${verdict.why}`, { review: 'stop' });
  }

  /**
   * 问审核模型（engine.limit_review_model，不写用会话的模型），思考档用这个模型最强的：有没有离谱的行为、要不要转新会话。
   * 读用户原话全文、限时、干了多久、这件事的工作过程（卡片记的最近 LOG_LINES 行，比判断模型看的多）。
   * @param card 卡。
   * @returns 结论；没有模型、出错、读不出 JSON，都是不离谱、不转（why 写原因），调用方就停下收尾。
   */
  private async review(card: Card): Promise<ReviewVerdict> {
    /** 审核用的模型。 */
    const model = this.resources.getSetting('limitReviewModel')
      ?? card.view.model
      ?? this.resources.getDefaultModel();
    if (!model) {
      return noVerdict('没配审核模型（engine.limit_review_model），停下收尾');
    }
    /** 最强的思考档。 */
    const thinking = this.ai.listModels()
      .find((item) => item.id === model)?.thinking.filter((level) => level !== 'off').at(-1);
    /** 语言。 */
    const language = this.resources.getBot(card.view.bot).language === 'en' ? 'en' : 'zh';
    /** 已经干了多久。 */
    const used = formatDuration(Date.now() - card.view.startedAt);
    /** 给模型的话。 */
    const content = [
      `用户的话：\n${this.askedText(card)}`,
      `已经干了：${used}；限时：${this.limitText(card)}`,
      `工作过程：\n${card.log.join('\n')}`,
    ].join('\n\n');
    /** 一条用户消息。 */
    const message: piAi.Message = {
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    /** 调模型的参数。 */
    const chatArgs = {
      model,
      thinking,
      system: { prompt: REVIEW_PROMPT[language] },
      purpose: 'limit-review',
      trace: this.callTrace(card),
      bot: card.view.bot,
      sessionId: card.view.sessionId,
      messages: [message],
      tools: [],
    };
    try {
      /** 回答。 */
      const output = await this.ai.chat(chatArgs);
      if (output.error) {
        return noVerdict(`审核模型出错，停下收尾：${output.error}`);
      }
      return this.readVerdict(output.text);
    } catch (error) {
      return noVerdict(`审核模型出错，停下收尾：${utils.errorText(error)}`);
    }
  }

  /**
   * 读审核模型的回答：取出 JSON，absurd、handoff 是真假值才算；建议转却没写交接说明的，算不转。
   * @param text 模型的回答。
   * @returns 结论；读不出来就是不离谱、不转，why 写原因。
   */
  private readVerdict(text: string): ReviewVerdict {
    /** 回答里的 JSON。 */
    const json = checks.extractJson(text);
    if (!json || typeof json.absurd !== 'boolean' || typeof json.handoff !== 'boolean') {
      /** 回答的开头，写进原因。 */
      const head = utils.truncate(text.replace(/\s+/g, ' '), 200);
      return noVerdict(`审核模型的回答读不出结论，停下收尾：${head}`);
    }
    /** 哪里离谱。 */
    const absurdWhy = typeof json.absurdWhy === 'string' ? json.absurdWhy.trim() : '';
    /** 交接说明。 */
    const handoffNote = typeof json.handoffNote === 'string' ? json.handoffNote.trim() : '';
    if (json.absurd) {
      return { absurd: true, absurdWhy, handoff: false, handoffNote: '', why: '审核发现离谱' };
    }
    if (json.handoff && !handoffNote) {
      return noVerdict('审核建议转新会话，但没写交接说明，停下收尾');
    }
    if (json.handoff) {
      return { absurd: false, absurdWhy: '', handoff: true, handoffNote, why: '审核建议转新会话' };
    }
    return noVerdict('审核模型：不离谱，也不建议转新会话，停下收尾');
  }

  /**
   * 要转新会话（第 5 条）：记下交接说明，叫老会话停；老会话停下以后（ended）再开新会话。
   * @param card 卡。
   * @param note 审核写的交接说明。
   * @param why 为什么转。
   */
  private askHandOff(card: Card, note: string, why: string): void {
    clearTimeout(card.limitTimer);
    clearTimeout(card.remindTimer);
    card.stopAsked = 'handoff';
    card.handoffNote = note;
    card.view.action = '审核建议换个干净的会话接着做，正在停下';
    this.note(card, `${this.limitText(card)}到了，转新会话：${why}`);
    /** 报给事件表的数据。 */
    const data = { why, elapsedMs: Date.now() - card.view.startedAt, review: 'handoff' };
    this.report(card, 'limit.stopped', data);
    this.interrupt(card);
    this.push(card, true);
  }

  /**
   * 到点问判断模型（engine.limit_judge_model，不写用 models.decision）三件事：还在不在往前推进、再给 5 分钟能不能做完、
   * 有没有在打转。前两件是、第三件不是，才延长。没有判断模型、判断出错都不延长。
   * @param card 卡。
   * @returns 延不延长、为什么。
   */
  private async judge(card: Card): Promise<{ extend: boolean; why: string }> {
    /** 判断用的模型。 */
    const model = this.resources.getSetting('limitJudgeModel');
    if (!model && !this.ai.hasDecision()) {
      return { extend: false, why: '没配判断模型（engine.limit_judge_model、models.decision），到点就停' };
    }
    try {
      /** 判断模型的回答。 */
      const output = await this.ai.decide({
        model,
        purpose: 'limit',
        trace: this.callTrace(card),
        bot: card.view.bot,
        sessionId: card.view.sessionId,
        state: {
          用户的话: card.view.text,
          已经干了: formatDuration(Date.now() - card.view.startedAt),
          限时: this.limitText(card),
          最近的工作过程: card.log.slice(-JUDGE_LOG_LINES).join('\n'),
        },
        questions: JUDGE_QUESTIONS,
      });
      if (output.error) {
        return { extend: false, why: `判断模型出错，到点就停：${output.error}` };
      }
      /** 一道题“是”的概率。 */
      const yes = (name: string): number => {
        /** 那一题的回答。 */
        const answer = output.answers[name];
        return answer?.type === 'bool' ? answer.probability : 0;
      };
      /** 三道题的概率。 */
      const [progressing, nearlyDone, looping] = [yes('progressing'), yes('nearlyDone'), yes('looping')];
      /** 写成一句。 */
      const detail = `推进 ${progressing.toFixed(2)}、快做完 ${nearlyDone.toFixed(2)}、打转 ${looping.toFixed(2)}`;
      if (progressing >= JUDGE_PASS && nearlyDone >= JUDGE_PASS && looping < JUDGE_PASS) {
        return { extend: true, why: `判断模型：${detail}` };
      }
      return { extend: false, why: `判断模型认为不该再延长（${detail}）` };
    } catch (error) {
      return { extend: false, why: `判断模型出错，到点就停：${utils.errorText(error)}` };
    }
  }

  /**
   * 停下这件事（到点、或者点了已经超过的限时）：记一笔、报 limit.stopped、叫会话停，结束时写收尾总结。
   * @param card 卡。
   * @param why 为什么停。
   * @param extra 一起报进 limit.stopped 的数据（如审核的结论 review）。
   */
  private stop(card: Card, why: string, extra: Record<string, unknown> = {}): void {
    clearTimeout(card.limitTimer);
    clearTimeout(card.remindTimer);
    card.stopAsked = 'timeout';
    card.view.action = '时间到了，正在停下';
    this.note(card, `${this.limitText(card)}到了，停下：${why}`);
    /** 报给事件表的数据。 */
    const data = { why, elapsedMs: Date.now() - card.view.startedAt, ...extra };
    this.report(card, 'limit.stopped', data);
    this.interrupt(card);
    this.push(card, true);
  }

  /**
   * 限时写成一句：“最多 20 分钟”“最多 20 分钟（延长过 1 次，共 25 分钟）”“不限时”。
   * @param card 卡。
   */
  private limitText(card: Card): string {
    /** 最长几分钟。 */
    const minutes = card.view.limitMinutes;
    if (minutes === undefined) {
      return '不限时';
    }
    /** 延长过几次。 */
    const extended = card.view.extended ?? 0;
    if (extended === 0) {
      return `最多 ${String(minutes)} 分钟`;
    }
    /** 一共几分钟。 */
    const total = minutes + extended * this.resources.getSetting('limitExtendMinutes');
    return `最多 ${String(minutes)} 分钟（延长过 ${String(extended)} 次，共 ${String(total)} 分钟）`;
  }

  /** 模型排队前固定卡片归属；只读运行号与消息号，不改变限时或模型选择。 */
  private callTrace(card: Card): aiModule.CallTrace {
    /** 卡片没有会话时不猜运行；有会话则使用调用当时实际的最近一次运行。 */
    const session = card.view.sessionId ? this.store.getSession(card.view.sessionId) : undefined;
    return {
      run: session?.runs.at(-1)?.n,
      messageIds: [...card.view.messageIds],
    };
  }

  /**
   * 报一个限时的事件：挂在这个会话最近一次运行的 run.started 下面。
   * @param card 卡。
   * @param type 类型（limit.*）。
   * @param data 数据。
   */
  private report(card: Card, type: string, data: Record<string, unknown>): void {
    /** 这个会话最近一次运行开始的那条事件。 */
    const started = card.view.sessionId
      ? this.events.list({ type: 'run.started', sessionId: card.view.sessionId, limit: 1 })[0]
      : undefined;
    this.events.emit(type, data, {
      source: 'Progress',
      bot: card.view.bot,
      sessionId: card.view.sessionId,
      messageId: card.view.messageIds.at(-1),
      parent: started?.id,
    });
  }

  /** 现在的卡片，新的在前；给了机器人就只看它的。 */
  list(bot?: string): ProgressView[] {
    return [...this.cards.values()]
      .filter((card) => !bot || card.view.bot === bot)
      .map((card) => copyView(card.view))
      .sort((left, right) => right.id - left.id);
  }

  /**
   * 把卡片发出去或改掉（排进这张卡自己的串里）。
   * @param card 卡。
   */
  private send(card: Card): void {
    /** 这一刻的样子。 */
    const view = copyView(card.view);
    card.chain = card.chain
      .then(async () => {
        if (card.handle === undefined) {
          card.handle = (await this.out.sendProgress?.(card.channel, card.address, view)) ?? '';
        } else if (card.handle) {
          await this.out.updateProgress?.(card.channel, card.handle, view);
        }
      })
      .catch((error: unknown) => {
        console.error(`${utils.formatTime()} 进度卡片 #${view.id} 没发成：${utils.errorText(error)}`);
      });
  }

  /**
   * 要改卡片了：结束时马上改，平时合并成每秒最多一次。
   * @param card 卡。
   * @param now 马上改。
   */
  private push(card: Card, now = false): void {
    if (!now) {
      card.timer ??= setTimeout(() => {
        card.timer = undefined;
        this.send(card);
      }, PUSH_EVERY_MS);
      return;
    }
    clearTimeout(card.timer);
    card.timer = undefined;
    this.send(card);
  }

  /**
   * 记一行工作过程。
   * @param card 卡。
   * @param line 一行。
   */
  private note(card: Card, line: string): void {
    card.log.push(line);
    if (card.log.length > LOG_LINES) {
      card.log.splice(0, card.log.length - LOG_LINES);
    }
  }

  /**
   * 叫会话停下：和用户插一句“停”一样，写会话的 interrupt。会话还没跑起来时先记着，跑起来的第一步再叫。
   * @param card 卡。
   */
  private interrupt(card: Card): void {
    /** 会话。 */
    const session = card.view.sessionId ? this.store.getSession(card.view.sessionId) : undefined;
    if (session?.status === 'running' && !card.interruptSent) {
      this.store.updateSession(session.id, { interrupt: card.view.messageIds.at(-1)! });
      card.interruptSent = true;
    }
  }

  /**
   * 这个会话正在跑的那张卡；用户要停的话顺手叫停。
   * @param sessionId 会话。
   */
  private active(sessionId: string): Card | undefined {
    /** 卡。 */
    const card = this.cards.get(this.bySession.get(sessionId) ?? 0);
    if (card?.stopAsked) {
      this.interrupt(card);
    }
    return card;
  }

  /**
   * 收尾总结：不带工具，只调一次收尾模型（engine.wrapup_model，没配就用会话自己的模型），思考档用最低的。
   * @param card 卡。
   * @returns 总结；写不成时写明原因。
   */
  private async wrapUp(card: Card): Promise<WrapUpResult> {
    /** 模型。 */
    const model = this.resources.getSetting('wrapupModel')
      ?? card.view.model
      ?? this.resources.getDefaultModel();
    if (!model) {
      return {
        text: '（没配收尾模型，写不了总结）',
        generation: replyEvidence.programGeneration('wrapup-error'),
      };
    }
    /** 最低的思考档。 */
    const thinking = this.ai.listModels()
      .find((item) => item.id === model)?.thinking.find((level) => level !== 'off');
    /** 语言。 */
    const language = this.resources.getBot(card.view.bot).language === 'en' ? 'en' : 'zh';
    /** 给模型的话。 */
    const message: piAi.Message = {
      role: 'user',
      content: `用户的话：${card.view.text}\n\n工作过程：\n${card.log.join('\n')}`,
      timestamp: Date.now(),
    };
    /** 调模型的参数。 */
    const chatArgs = {
      model,
      thinking,
      system: { prompt: WRAPUP_PROMPT[language] },
      purpose: 'wrapup',
      trace: this.callTrace(card),
      bot: card.view.bot,
      sessionId: card.view.sessionId,
      messages: [message],
      tools: [],
    };
    try {
      /** 回答。 */
      const output = await this.ai.chat(chatArgs);
      if (output.error) {
        return {
          text: `（收尾总结没写成：${output.error}）`,
          generation: replyEvidence.programGeneration('wrapup-error'),
        };
      }
      return {
        text: output.text.trim(),
        generation: output.text.trim() ? replyEvidence.modelGeneration(output, {
          purpose: 'wrapup',
          run: chatArgs.trace.run,
          kind: 'model-wrapped',
        }) : replyEvidence.programGeneration('wrapup-empty'),
      };
    } catch (error) {
      return {
        text: `（收尾总结没写成：${utils.errorText(error)}）`,
        generation: replyEvidence.programGeneration('wrapup-error'),
      };
    }
  }

  /**
   * 卡片结束：定格、马上改、过一阵从内存里删掉。
   * @param card 卡。
   * @param stage 结局。
   * @param action 最后那句话。
   * @param result 结果。
   */
  private close(card: Card, stage: ProgressStage, action: string, result?: string): void {
    clearTimeout(card.limitTimer);
    clearTimeout(card.remindTimer);
    card.view.stage = stage;
    card.view.action = action;
    card.view.endedAt = Date.now();
    card.view.result = result ? utils.truncate(result.trim(), TEXT_CHARS * 3) : undefined;
    if (card.view.sessionId && this.bySession.get(card.view.sessionId) === card.view.id) {
      this.bySession.delete(card.view.sessionId);
    }
    this.push(card, true);
    setTimeout(() => this.cards.delete(card.view.id), KEEP_ENDED_MS);
    //M 做太久的、限时到点的、用户终止的、审核停下的、转了新会话的，记进超时登记（data/overtime.jsonl），以后复盘看（设计第 4 节）。
    /** 用了多久。 */
    const usedMs = card.view.endedAt - card.view.startedAt;
    /** 超时的分钟数（设置）。 */
    const overtimeMs = this.resources.getSetting('overtimeMinutes') * 60_000;
    /** 限时、终止、审核这几种结局，不看用了多久都登记。 */
    const limitStages: ProgressStage[] = ['timeout', 'stopped', 'flagged', 'handed'];
    /** 要不要登记：超时了，或者是上面几种结局；并进别的卡的不登记。 */
    const overtime = usedMs >= overtimeMs || limitStages.includes(stage);
    if (stage !== 'merged' && overtime) {
      /** 一行登记。 */
      const line = JSON.stringify({
        at: card.view.endedAt,
        bot: card.view.bot,
        sessionId: card.view.sessionId,
        sessionTitle: card.view.sessionTitle,
        text: card.view.text,
        stage,
        usedMs,
        limitMinutes: card.view.limitMinutes,
        timings: card.view.timings,
        messageIds: card.view.messageIds,
        model: card.view.model,
      });
      /** 登记文件。 */
      const file = path.join(this.resources.dir, 'data', 'overtime.jsonl');
      void fs.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.appendFile(file, `${line}\n`, 'utf8'))
        .catch((error: unknown) => {
          console.error(`${utils.formatTime()} 超时登记没写成：${utils.errorText(error)}`);
        });
    }
  }
}
