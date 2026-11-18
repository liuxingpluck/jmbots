/**
 * 进度和限时：有用户的会话（记录上有 channel、没有 parent；前台交出去的后台会话 kind work 有 parent 也算）每转一轮就有一项进度：开始时间、第几步、在调哪个工具、各工具用时、限时、阶段、结果。
 * 长跑提醒（用户 11-14 定的）：一轮跑满 15 分钟（progress.long_run_card_minutes）发一张卡片问要不要终止（approval 的待确认，网页、飞书同一份卡片数据）。
 *   点“终止”才停；点“继续”或一直不点都一直做下去。一轮只发一张；会话结束时还没点的卡片变灰写“会话已结束”。
 * 限时：默认不限时（progress.limit_default_minutes 默认 0，不能“不点就自动停”）；配了正数才照 0.4：到点前报时、到点判断。
 *   网页、卡片上能选 15/20 分钟（提前 5 分钟报时）或不限时，都从开始算；随时能终止。
 * 报时：每一步发给模型的对话末尾加一句“已经干了多久”（不存进对话），同时跟用户说一次。
 * 到点：用户选的直接停；默认的问 decision 三道题（在推进、5 分钟能做完、没在打转），都过就延 5 分钟，最多两次；
 *   延够了开一场审核小会话：离谱就停下说清哪里离谱，建议转就开一场新的后台会话带交接说明接着做（一件事只转一次），不然停下。
 * 停下以后开一场收尾小会话写“做到哪了、卡在哪、还剩什么”发给用户；做太久或被限时、终止的，记一行 data/overtime.jsonl，空闲时由 Review.ts 挑一件写复盘。
 * 每次变化发 progress/update（一场一秒最多一次，结束马上发）：feishu 画卡片、journal 记流水、网页 GET /api/progress 轮询。
 * 照 0.4 src/capabilities/Progress.ts、Review.ts。设计见同目录 说明.md 的「设计要点」一节（含复盘）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { AskInput, Session, Thinking } from '../../Sessions.ts';
import * as checks from '../../utils/Checks.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import type * as cardUtils from '../../utils/Card.ts';
import * as dailyModule from './GroupDaily.ts';
import * as reviewModule from './Review.ts';
import * as words from './Words.ts';

export type { ReviewConfig } from './Review.ts';


/** 插件名。 */
export const name = 'progress';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.1：转新会话时照抄后台绑定的工作区 ID（row.workspaceId）。
//M 1.1.4：说话改发 bot/say，取思考档发 model-catalog/request，读对话记录发 journal/request，不再直接调别的插件。
//M 1.1.5：长跑、复盘、限时判断和转交改用请求事件。
//M 1.1.6：接入已登记飞书群的每日进度调度。
//M 1.1.7：限时与收尾配置迁入插件 config，旧 engine 键在入口兼容。
export const version = '1.1.7';

/** resources 拿配置和目录，bots 查机器人，sessions 开小会话；http 可选。审核、决策和转交经事件。 */
export const inject = ['resources', 'bots', 'sessions'];


/** progress 插件配置（plugins[progress].config）。 */
export interface ProgressConfig {
  /** 默认限时分钟；0 表示不限时。 */
  limit_default_minutes?: number;
  /** 默认限时提前几分钟报时。 */
  limit_remind_before_minutes?: number;
  /** 每次延长的分钟数。 */
  limit_extend_minutes?: number;
  /** 最多可延长的次数。 */
  limit_extend_times?: number;
  /** 将慢任务记入超时日志的分钟数阈值。 */
  overtime_minutes?: number;
  /** 长跑提醒分钟数；0 表示关闭。 */
  long_run_card_minutes?: number;
  /** 收尾与复盘模型；留空使用原会话模型。 */
  wrapup_model?: string | null;
  /** 延够后的限时审核模型；留空使用原会话模型。 */
  limit_review_model?: string | null;
  /** 超时复盘设置（原 review 插件配置）；写 false 或 enabled: false 关闭自动复盘。 */
  review?: reviewModule.ReviewConfig | false;
}


/** 阶段：前台在转是 dispatching，后台在转是 running，结束后是结局。 */
export type ProgressStage = 'dispatching' | 'running' | 'done' | 'error' | 'stopped' | 'timeout' | 'flagged' | 'handed';

/** 一项进度（feishu 的 ProgressItemLike、网页的 ProgressView 都按这个读）。 */
export interface ProgressItem {
  /** 进程里从 1 往上数；网页、卡片按它点按钮。 */
  id: number;
  sessionId: string;
  bot: string;
  /** 触发这一轮的那句话，截 80 字。 */
  text: string;
  /** 会话的总结（summary 插件写的），没有就不给。 */
  sessionTitle?: string;
  model: string;
  stage: ProgressStage;
  /** 现在在做什么，一句话。 */
  action: string;
  startedAt: number;
  endedAt?: number;
  /** 模型回答了几次。 */
  steps: number;
  /** 到点的时刻（含延长）；不限时没有。 */
  deadline?: number;
  /** 限时几分钟（不含延长）；不限时没有。 */
  limitMinutes?: number;
  limitChosen: boolean;
  extended: number;
  timings: words.Timings;
  /** 结束时的结果或收尾总结，截 240 字。 */
  result?: string;
  /** 网页的 ProgressView 带这一项（0.4 的消息号）；src7 一轮一项，给空的。 */
  messageIds: number[];
}

/** 内存里的一项：加上不给外面看的。 */
interface Item extends ProgressItem {
  session: Session;
  /** 工作过程，最多 80 行（判断、审核、收尾读它）。 */
  log: string[];
  /** 这一轮用户说的话。 */
  said: string[];
  /** 上一条消息的时刻（算每步、每个工具用时）。 */
  lastAt: number;
  remindAt?: number;
  stopAsked?: 'stop' | 'timeout' | 'handoff';
  flagged?: string;
  handoffNote?: string;
  /** 已发起转交，等待新会话接单。 */
  handoffPending?: boolean;
  handedOver?: boolean;
  timers: {
    push?: ReturnType<typeof setTimeout>;
    remind?: ReturnType<typeof setTimeout>;
    limit?: ReturnType<typeof setTimeout>;
    card?: ReturnType<typeof setTimeout>;
  };
  /** 发过的长跑提醒卡片（待确认号）；发过就不再发。 */
  cardId?: number;
  lastPush: number;
}


declare module 'cordis' {
  interface Context {
    /** 进度服务，实现在 src7/plugins/progress/index.ts。别的插件当可选依赖，用 ctx.get('progress') 现取。 */
    progress: Progress;
  }
  interface Events {
    /** 一项进度有变化（拷贝）。feishu 那边声明的是 ProgressItemLike，字段是这个的子集。 */
    'progress/update'(item: ProgressItem): void;
    /** 查询或操作会话进度。 */
    'progress/request'(request: ProgressRequest): void | Promise<void>;
    /** 返回进度列表或进度操作的反馈。 */
    'progress/result'(result: ProgressResult): void;
  }
}

/** 进度服务接受的查询和操作。 */
type ProgressRequest = requestEventModule.RequestEnvelope & ({
  /** 终止或改变限时。 */
  action: 'act';
  /** 要操作的会话号。 */
  sessionId: string;
  /** 终止或限时。 */
  op: 'stop' | 'limit';
  /** 限时分钟数，省略或小于等于 0 时改为不限时。 */
  minutes?: number;
} | {
  /** 查询进度列表。 */
  action: 'list';
  /** 只看某个机器人的进度，省略时看全部。 */
  bot?: string;
});

/** 进度服务的回执。 */
interface ProgressResult extends requestEventModule.ResultEnvelope {
  /** act 是否执行了操作。 */
  ok?: boolean;
  /** act 给用户看的操作反馈。 */
  text?: string;
  /** list 返回的进度项。 */
  items?: ProgressItem[];
}

declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 这一轮的限时：一轮开始写、结束删。重启后接着跑的会话照原来的开始时间和限时接着计。 */
    progress?: {
      startedAt: number;
      limitMinutes?: number;
      limitChosen: boolean;
      extended: number;
      handedOver?: boolean;
      cardId?: number;
    };
  }
}


/** 入口迁移并校验后的限时与模型配置。 */
interface Settings {
  defaultMinutes: number;
  remindBefore: number;
  extendMinutes: number;
  extendTimes: number;
  wrapupModel?: string;
  reviewModel?: string;
  overtimeMinutes: number;
  /** 跑满几分钟发长跑提醒卡片；0 不发。 */
  longRunMinutes: number;
}

/** approval/decided 里用到的。 */
interface DecidedLike {
  id: number;
  kind: string;
  state: string;
  payload?: unknown;
  card?: { state: string };
}

/** 决策回执和问题的类型，取自事件契约。 */
type JudgeReply = requestEventModule.EventArg<'decision/judge-result'>;
type JudgeQuestion = requestEventModule.EventArg<'decision/judge'>['question'];

/** 一项一秒最多推一次。 */
const PUSH_EVERY_MS = 1000;
/** 选了限时的提前几分钟报时。 */
const CHOSEN_REMIND_BEFORE = 5;
/** 结束的项留多久。 */
const KEEP_ENDED_MS = 10 * 60_000;
/** 工作过程最多几行。 */
const LOG_LINES = 80;
/** 工作过程里参数、结果各截几个字。 */
const LOG_CHARS = 200;
/** 判断时看最近几行工作过程。 */
const JUDGE_LOG_LINES = 15;
/** 判断题过线。 */
const JUDGE_PASS = 0.5;
/** 长跑提醒在待确认里的 kind。 */
const LONG_RUN_KIND = 'long-run';
/** 一分钟。 */
const MINUTE = 60_000;
/** 思考档从低到高。 */
const LEVELS: Thinking[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
/** 模型目录查询最多等三秒。 */
const CATALOG_TIMEOUT_MS = 3000;

/** 原进度项已经结束或查不到时，操作沿用这句反馈。 */
const ENDED_TEXT = '这件事已经结束了';

/** 进度服务。 */
export class Progress extends cordis.Service {
  /** 会话号 → 项。 */
  private readonly items = new Map<string, Item>();
  private nextId = 1;

  /**
   * 登记 progress 插件：把 Progress 作为服务挂到 Cordis 上（以后用 ctx.progress 取）；再听会话的三个事件。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param settings 校验后的配置。
   * 副作用：监听会话、长跑提醒与进度请求，并在插件卸载时清理定时器。
   */
  constructor(ctx: cordis.Context, private readonly settings: Settings) {
    super(ctx, 'progress');

    //M session/change（通知）：变成 running 就开一项；done、stopped、failed 就收尾。没有渠道（小会话）或有 parent 的不管，
    //M   但前台交出去的后台会话（kind work）要管：11-14 “分会话”起后台会话的 parent 记成交出它的前台对话，
    //M   原来的“有 parent 不管”就把它们漏了，长跑提醒、限时都不再发（Cards_Test 抓到的，2026-11-14 17:35 EST 修）。
    ctx.on('session/change', (session) => {
      const row = session.row;
      if (row.channel === undefined || (row.parent !== undefined && row.kind !== 'work')) return;

      if (row.state === 'running') {
        //M 会话进入运行态时初始化或续接本轮进度项与定时器。
        this.start(session);
        return;
      }
      //M 会话结束或出错时异步触发收尾总结与超时登记，兜底记录错误防止未捕获异常。
      void this.end(session).catch((error: unknown) => console.error(`进度收尾出错：${textModule.getMessage(error)}`));
    });

    //M session/message（通知）：对话里新接了一条 → 记步数、用时、在做什么、工作过程。
    ctx.on('session/message', (session, message) => this.onMessage(session, message));

    //M session/request（挨个问）：过了报时点就在这一步发给模型的对话末尾加一句报时。只改这一步的副本，不进对话。
    //M   要在 plugins 里写在 bots（前台）、compress 后面：它们会整个换掉 request.messages。
    ctx.on('session/request', (request) => {
      const item = this.items.get(request.session.id);
      if (item === undefined || item.endedAt !== undefined || item.remindAt === undefined) return;
      if (Date.now() < item.remindAt) return;
      const content = `（系统）这件事已经干了 ${textModule.getDuration(Date.now() - item.startedAt)}，${this.limitText(item)}。`
        + '回复用户时说清干了多久、做到哪了；快到点了就抓紧收尾，做不完就写清做到哪了、还剩什么。';
      request.messages.push({ role: 'user', content, timestamp: Date.now() });
    });

    //M approval/decided（通知）：长跑提醒卡片定了。同意 = 终止；拒绝 = 继续（记一笔，什么都不改）；ended 是会话结束时自己作废的，不管。
    ctx.on('approval/decided', (pending: DecidedLike) => {
      if (pending.kind !== LONG_RUN_KIND || pending.card?.state === 'ended') return;
      const sessionId = (pending.payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== 'string') return;

      //G 只有本轮确认登记的卡片可以控制会话，忽略超时后才出现的卡片。
      const item = this.items.get(sessionId);
      if (item === undefined || item.endedAt !== undefined || item.cardId !== pending.id) return;

      if (pending.state === 'approved') {
        //M 用户从本轮长跑卡片点了终止。
        this.act(sessionId, 'stop');
        return;
      }

      //M 用户选择继续，工作过程只记一条日志。
      this.note(item, '长跑提醒：用户点了继续');

      //T 跟踪：用户点了继续。
      const continueVars = { 会话: sessionId, 卡片: pending.id };
      this.ctx.emit('trace', 'Progress.continue', '长跑提醒点了继续，一直做下去', "ctx.on('approval/decided')", continueVars);
    });

    const requestOptions = {
      onError: (error: unknown, request: ProgressRequest) => {
        if (request.action === 'list') return { items: [] };

        //G 操作没做成时把错误说明回给卡片调用方。
        const text = textModule.getMessage(error);
        return { ok: false, text };
      },
    };

    //M 两种进度请求沿用原服务的查询和控制逻辑。
    requestEventModule.onRequestEvent(
      ctx,
      'progress/request',
      'progress/result',
      (request) => {
        if (request.action === 'list') {
          //M 按机器人筛选并返回进度项副本。
          const items = this.list(request.bot);
          return { items };
        }

        //G 用当前进度项状态判断操作能否执行。
        const active = this.getActiveItem(request.sessionId);
        if (active === undefined) return { ok: false, text: ENDED_TEXT };

        //M 用原方法执行操作，保留给用户看的反馈。
        const text = this.act(request.sessionId, request.op, request.minutes);
        return { ok: true, text };
      },
      requestOptions,
    );

    //M 拔插件时清掉所有定时器。ctx.effect：先执行一次，交回的函数在插件被拔掉时 Cordis 来调。
    ctx.effect(() => () => {
      for (const item of this.items.values()) this.clearTimers(item, true);
    });
  }

  /**
   * 在转的和结束不到 10 分钟的，新的在前。
   * @param bot 只看这个机器人的；空串、不给是全部。
   * @returns 拷贝。
   */
  list(bot?: string): ProgressItem[] {
    //M 按开始时间倒序筛选并转换成只读视图副本，供网页轮询和复盘服务查询状态。
    return [...this.items.values()].filter((item) => bot === undefined || bot === '' || item.bot === bot)
      .sort((left, right) => right.startedAt - left.startedAt).map((item) => this.view(item));
  }

  /**
   * 查仍在运行的进度项。
   * @param sessionId 会话号。
   * @returns 正在运行的进度项，未找到或已结束时为空。
   */
  private getActiveItem(sessionId: string): Item | undefined {
    //M 按会话号取内存中的进度项，供监听和直接操作共用。
    const item = this.items.get(sessionId);

    //G 已结束的项仍会保留一会儿供查询，但不能操作。
    if (item?.endedAt !== undefined) return undefined;

    return item;
  }

  /**
   * 网页、卡片上的按钮：终止，或限时（从开始算最多 N 分钟；不给或 0 是不限时，也就是“继续”）。
   * @param sessionId 会话号。
   * @param action stop 或 limit。
   * @param minutes 限时几分钟。
   * @returns 给用户看的一句话。不抛错。
   * 副作用：可能调用 session.stop 终止会话、重设限时与定时器并持久化和推送进度。
   */
  act(sessionId: string, action: 'stop' | 'limit', minutes?: number): string {
    //G 查找对应进度项；已结束或不存在时直接提示用户不再处理。
    const item = this.getActiveItem(sessionId);
    if (item === undefined) return ENDED_TEXT;

    if (action === 'stop') {
      item.stopAsked = 'stop';
      item.action = '正在停下';
      //M 记录用户主动终止日志并立即下发停止指令，随后强制推送最新进度。
      this.note(item, '用户点了终止');
      item.session.stop('progress');
      this.push(item, true);
      return '收到，马上停';
    }
    if (minutes === undefined || minutes <= 0) {
      //M 改成不限时并清掉报时与到点定时器，立刻推送状态通知前端。
      this.setLimit(item, undefined, true);
      this.push(item, true);
      return '不限时，一直做，也不报时';
    }
    //M 从开始干活算：15 分钟后再点“最多 5 分钟”就该马上结束；点过就不再延长，到点就停。
    const left = item.startedAt + minutes * MINUTE - Date.now();
    this.setLimit(item, minutes, true);
    if (left <= 0) {
      this.stop(item, `已经超过 ${String(minutes)} 分钟，用户点的`);
      return `已经超过 ${String(minutes)} 分钟，马上收尾`;
    }
    //M 剩余限时还充足，立即向外推送更新后的限时和倒计时信息。
    this.push(item, true);
    return `最多做 ${String(minutes)} 分钟，还剩 ${textModule.getDuration(left)}`;
  }

  /**
   * 网页按数字号点按钮：先找到项，再转交 act 处理。
   * @param id 进程内递增的进度数字序号。
   * @param action stop 或 limit。
   * @param minutes 限时几分钟。
   * @returns 给用户看的反馈语（找不到时提示已结束）。
   * 副作用：同 act，可能终止会话或更新限时及定时器。
   */
  actById(id: number, action: 'stop' | 'limit', minutes?: number): string {
    const item = [...this.items.values()].find((entry) => entry.id === id);
    if (item === undefined) return ENDED_TEXT;

    //M 通过数字序号换取真实 sessionId，再沿用统一的控制与推送逻辑执行操作。
    return this.act(item.sessionId, action, minutes);
  }

  /**
   * 一轮开始：有 row.progress 就照它接着计（重启接着跑），没有就新建，按默认限时。
   * @param session 变成 running 的会话。
   */
  private start(session: Session): void {
    //G 已有未结束的进度项则跳过，留有已结束旧项时先清净定时器防止内存泄漏。
    const old = this.items.get(session.id);
    if (old !== undefined && old.endedAt === undefined) return;
    if (old !== undefined) this.clearTimers(old, true);

    const row = session.row;
    const saved = row.progress;
    const lastUser = row.messages.findLast((message) => message.role === 'user');
    let text = '';
    if (lastUser !== undefined) {
      //M 提取最近一条用户文本并截短为 80 字作为本轮任务标题展示。
      text = textModule.clip(piAi.contentText(lastUser.content), 80);
    }
    let stage: ProgressStage = 'running';
    let action = '开始干活';
    if (row.kind === 'front') {
      stage = 'dispatching';
      action = '前台在看这句话';
    }
    const item: Item = {
      id: this.nextId++, sessionId: session.id, bot: row.bot, text,
      model: row.model, stage, action,
      startedAt: saved?.startedAt ?? Date.now(),
      steps: 0,
      limitChosen: false,
      extended: 0,
      timings: { modelMs: 0, tools: [] },
      messageIds: [],
      session, log: [], said: [], lastAt: Date.now(), timers: {}, lastPush: 0,
    };
    if (saved?.handedOver === true) item.handedOver = true;
    if (saved?.cardId !== undefined) item.cardId = saved.cardId;
    this.items.set(session.id, item);
    if (saved === undefined) {
      let defaultMinutes: number | undefined;
      if (this.settings.defaultMinutes !== 0) {
        defaultMinutes = this.settings.defaultMinutes;
      }
      //M 新开一轮时按全局默认分钟数配置限时，并持久化进会话 row.progress。
      this.setLimit(item, defaultMinutes, false);
    }
    if (saved !== undefined) {
      //M 从重启前持久化进度恢复时记录重启日志，沿用原有的限时及延长次数排好定时器。
      this.note(item, '程序重启过，接着计时');
      item.extended = saved.extended;
      this.setLimit(item, saved.limitMinutes, saved.limitChosen, saved.extended);
    }
    //M 排定长跑提醒卡片定时器并立刻向外推送本轮新建进度。
    this.armCard(item);
    this.push(item, true);
  }

  /** 排长跑提醒：前台分流的不发（它很快交给后台）；发过的不再发。 */
  private armCard(item: Item): void {
    clearTimeout(item.timers.card);
    if (this.settings.longRunMinutes === 0 || item.cardId !== undefined || item.session.row.kind === 'front') return;

    //M 计算距离跑满长跑提醒阈值的剩余毫秒，到点后发长跑提醒卡片。
    const cardDelay = Math.max(0, item.startedAt + this.settings.longRunMinutes * MINUTE - Date.now());
    item.timers.card = setTimeout(() => {
      //M 卡片登记需要等回执，定时器只发起请求并记录意外错误。
      void this.sendCard(item).catch((error: unknown) => console.error(`长跑提醒出错：${textModule.getMessage(error)}`));
    }, cardDelay);
  }

  /**
   * 发长跑提醒卡片：已运行多久、现在在做什么、第几步、用户的话；“终止”（危险色）和“继续”。
   * @param item 正在长跑的进度项。
   * 副作用：登记待确认卡片并记下编号；登记失败时发文字提醒。
   */
  private async sendCard(item: Item): Promise<void> {
    //G 已结束、正在停下或已提醒的会话无需再发卡片。
    if (item.endedAt !== undefined || item.stopAsked !== undefined || item.cardId !== undefined) return;

    //M 取当前耗时，填入待确认卡片和文字退路。
    const elapsed = textModule.getDuration(Date.now() - item.startedAt);
    const card: Omit<cardUtils.CardData, 'state' | 'result'> = {
      kind: 'long-run',
      title: `这件事已经干了 ${elapsed}，要不要终止？`,
      reason: `后台会话跑了超过 ${String(this.settings.longRunMinutes)} 分钟。点“终止”马上停下；点“继续”或者不管它，就一直做下去，不会再问。`,
      items: [
        { label: '已运行', value: elapsed },
        { label: '现在在做', value: item.action },
        { label: '模型回答了', value: `${String(item.steps)} 次` },
        { label: '用户的话', value: item.text || '（没有）' },
        { label: '会话', value: item.sessionId, code: true },
      ],
      buttons: [
        { action: 'approve', label: '终止', style: 'danger' },
        { action: 'reject', label: '继续', style: 'default' },
      ],
    };
    //M 登记长跑确认卡片，只有成功回执里的编号能供后续关闭使用。
    const input = {
      kind: LONG_RUN_KIND,
      title: card.title,
      detail: `已运行 ${elapsed}，现在${item.action}`,
      payload: { sessionId: item.sessionId },
      bot: item.bot,
      session: item.sessionId,
      card,
    };
    const request = { action: 'ask', input } as const;
    const options = {
      timeoutMs: 5000,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => ({
        requestId: '', error: detail ?? reason,
      }),
    };

    //M 等待审核插件确认登记，缺席、超时和出错都走文字退路。
    const reply = await requestEventModule.requestEvent(
      this.ctx, 'approval/request', 'approval/result', request, options,
    );

    //T 跟踪：记录卡片是否登记成功。
    const pending = reply.pending;
    const cardVars = { 会话: item.sessionId, 干了: elapsed, 卡片: pending?.id, 错误: reply.error };
    this.ctx.emit('trace', 'Progress.sendCard', '请审核插件登记长跑提醒', 'approval/request ask', cardVars);

    //G 回执回来时会话已经结束，立即关闭刚登记的卡片。
    if (item.endedAt !== undefined) {
      if (pending !== undefined) {
        this.closeCard(pending.id, item.action);
      }
      return;
    }

    //G 审核请求未获确认时只提醒用户，停止操作仍由用户决定。
    if (pending === undefined || reply.error !== undefined) {
      if (item.stopAsked !== undefined) return;

      item.cardId = 0;
      const text = `⏳ 这件事已经干了 ${elapsed}，现在${item.action}。要停就在网页进度上点“终止”；不管它就一直做下去。`;

      //M 卡片未登记时发文字，并记住这一轮已经提醒过。
      this.ctx.emit('bot/say', item.session, text);
      this.saveRow(item);
      return;
    }

    //M 记下待确认卡片编号并写进工作过程日志与会话表，避免进程重启后重复发送。
    item.cardId = pending.id;
    this.note(item, `跑满 ${String(this.settings.longRunMinutes)} 分钟，发了长跑提醒 #${String(pending.id)}`);
    this.saveRow(item);
  }

  /**
   * 对话里新接了一条：用户的话记下；模型的回答算一步、记在调哪个工具；工具结果记次数和用时。
   * @param session 哪场会话。
   * @param message 新接的一条。
   */
  private onMessage(session: Session, message: piAi.Message): void {
    //G 会话未建进度项或已进入结束态时忽略后续消息事件。
    const item = this.items.get(session.id);
    if (item === undefined || item.endedAt !== undefined) return;

    //M 计算与上条消息的时间差并更新明细统计，随后按节流规则推送最新进度。
    const at = message.timestamp ?? Date.now();
    const spent = Math.max(0, at - item.lastAt);
    item.lastAt = at;
    this.recordMessage(item, message, spent);
    this.push(item);
  }

  /** 按消息角色更新进度项的步数、用时与工作日志。 */
  private recordMessage(item: Item, message: piAi.Message, spent: number): void {
    if (message.role === 'user') {
      //M 记录本轮用户发言原文进日志；若进度标题尚空则取此句前 80 字补齐。
      const said = piAi.contentText(message.content);
      item.said.push(said);
      if (item.text === '') item.text = textModule.clip(said, 80);
      this.note(item, `用户：${textModule.clip(said, LOG_CHARS)}`);
      return;
    }
    if (message.role === 'assistant') {
      item.steps += 1;
      item.timings.modelMs += spent;
      item.model = `${message.provider}/${message.model}`;
      for (const block of message.content) {
        //M 将模型该步的思考首行、文本输出与工具入参逐条摘录进工作过程日志。
        if (block.type === 'thinking' && block.thinking.trim() !== '') {
          const firstLine = block.thinking.trim().split('\n')[0] ?? '';
          this.note(item, `思考：${textModule.clip(firstLine, LOG_CHARS)}`);
        }
        if (block.type === 'text' && block.text.trim() !== '') {
          this.note(item, `说：${textModule.clip(block.text.trim(), LOG_CHARS)}`);
        }
        if (block.type === 'toolCall') {
          const argsText = textModule.clip(JSON.stringify(block.arguments), LOG_CHARS);
          this.note(item, `调用 ${block.name} ${argsText}`);
        }
      }
      //M 提取本步首个工具调用的参数摘要，将当前进度展示文本更新为正在调该工具。
      const call = message.content.find((block) => block.type === 'toolCall');
      item.action = '在写回答';
      if (call?.type === 'toolCall') {
        const brief = words.argsBrief(call.arguments);
        let suffix = '';
        if (brief !== '') {
          suffix = `（${brief}）`;
        }
        item.action = `正在调用 ${call.name}${suffix}`;
      }
      return;
    }
    if (message.role === 'toolResult') {
      //M 按工具名累加调用次数和累计耗时，供停下后统计耗时分布。
      const tool = item.timings.tools.find((entry) => entry.name === message.toolName);
      if (tool === undefined) {
        item.timings.tools.push({ name: message.toolName, count: 1, ms: spent });
      }
      if (tool !== undefined) {
        tool.count += 1;
        tool.ms += spent;
      }
      let errSuffix = '';
      if (message.isError) {
        errSuffix = '（出错）';
      }
      //M 把工具返回摘要（标明是否出错）写入日志，并将当前行动状态切换为思考下一步。
      const resultText = textModule.clip(piAi.contentText(message.content), LOG_CHARS);
      this.note(item, `结果 ${message.toolName}${errSuffix}：${resultText}`);
      item.action = '在想下一步';
    }
  }

  /**
   * 设限时：清两个定时器，算到点、报时点，排定时器，同步进 row.progress。
   * @param item 哪一项。
   * @param minutes 限时几分钟；不限时是 undefined。
   * @param chosen 是不是用户选的。
   * @param extended 延长过几次（重启接着计时用；平时清零）。
   */
  private setLimit(item: Item, minutes: number | undefined, chosen: boolean, extended = 0): void {
    clearTimeout(item.timers.remind);
    clearTimeout(item.timers.limit);
    item.limitChosen = chosen;
    item.extended = extended;
    delete item.remindAt;
    delete item.deadline;
    if (minutes === undefined) {
      delete item.limitMinutes;
      //M 设成不限时后持久化清理后的 row.progress，不排报时和到点定时器。
      this.saveRow(item);
      return;
    }
    item.limitMinutes = minutes;
    item.deadline = item.startedAt + (minutes + extended * this.settings.extendMinutes) * MINUTE;
    let beforeMinutes = this.settings.remindBefore;
    if (chosen) {
      beforeMinutes = CHOSEN_REMIND_BEFORE;
    }
    const remindAt = item.deadline - beforeMinutes * MINUTE;
    item.remindAt = remindAt;
    item.timers.remind = setTimeout(() => {
      if (item.endedAt !== undefined) return;
      //M 到了提前报时时刻时计算已用时长并记入日志，同时通知用户临近限时。
      const elapsed = textModule.getDuration(Date.now() - item.startedAt);
      this.note(item, `过了报时点（干了 ${elapsed}），开始报时`);
      //T 跟踪：开始报时。
      const remindVars = { 会话: item.sessionId, 干了: elapsed };
      this.ctx.emit('trace', 'Progress.remind', '开始报时', "ctx.emit('bot/say', session, text)", remindVars);
      const limit = this.limitText(item);
      const text = `⏳ 这件事已经干了 ${elapsed}，${limit}；到点会先停下，把做到哪写给你。`;

      //M 通知机器人发报时消息，再推送进度更新。
      this.ctx.emit('bot/say', item.session, text);
      this.push(item);
    }, Math.max(0, remindAt - Date.now()));
    //M 排好到点定时器并立即保存限时设置到会话行中。
    this.armDeadline(item);
    this.saveRow(item);
  }

  /** 排到点定时器。 */
  private armDeadline(item: Item): void {
    clearTimeout(item.timers.limit);
    if (item.deadline === undefined) return;
    //M 排定到点定时器触发 onDeadline 评估是否停下或延长，异常时兜底停下会话。
    item.timers.limit = setTimeout(() => {
      void this.onDeadline(item).catch((error: unknown) => this.stop(item, `到点判断出错：${textModule.getMessage(error)}`));
    }, Math.max(0, item.deadline - Date.now()));
  }

  /**
   * 到点：用户选的直接停；延够了开审核；不然问 decision 要不要延。
   * @param item 哪一项。
   */
  private async onDeadline(item: Item): Promise<void> {
    if (item.endedAt !== undefined || item.stopAsked !== undefined) return;
    if (item.limitChosen) {
      //M 用户亲自选定了限时分钟数，到点不再自动延长而是直接叫停。
      this.stop(item, '用户选的限时，到点就停');
      return;
    }
    if (item.extended >= this.settings.extendTimes) {
      //M 自动延长次数已用满，交由审核小会话决定是否转新会话或直接收尾。
      await this.afterExtensions(item);
      return;
    }
    //M 还可以继续延长，先向 decision 服务询问三道评估题决定是否延期。
    const verdict = await this.judge(item);

    //T 跟踪：到点判断。
    const deadlineVars = { 会话: item.sessionId, 延: verdict.extend, 为什么: verdict.why };
    this.ctx.emit('trace', 'Progress.onDeadline', '到点了，判断要不要延', 'judge(item)', deadlineVars);
    if (item.endedAt !== undefined || item.stopAsked !== undefined) return;
    if (!verdict.extend) {
      this.stop(item, verdict.why);
      return;
    }
    item.extended += 1;
    item.deadline = (item.deadline ?? Date.now()) + this.settings.extendMinutes * MINUTE;
    //M 判断通过允许延长：记延长日志、重排到点定时器、存库并向前端推送最新时限。
    this.note(item, `延长 ${String(this.settings.extendMinutes)} 分钟（第 ${String(item.extended)} 次）：${verdict.why}`);
    this.armDeadline(item);
    this.saveRow(item);
    this.push(item, true);
  }

  /**
   * 问 decision 三道题（在推进、5 分钟能做完、在打转）。缺任一分数就到点停。
   * @param item 到期的进度项。
   * @returns 延不延、为什么。
   */
  private async judge(item: Item): Promise<{ extend: boolean; why: string }> {
    //M 组装任务摘要、已耗时和最近工作日志作为判断上下文，并发询问三道评估题。
    const state = {
      用户的话: item.text, 已经干了: textModule.getDuration(Date.now() - item.startedAt), 限时: this.limitText(item),
      最近的工作过程: item.log.slice(-JUDGE_LOG_LINES).join('\n'),
    };
    const options = {
      timeoutMs: 20_000,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string): JudgeReply => ({
        requestId: '', verdict: 'unsure', reason: detail ?? `决策请求未获回复（${reason}）`,
      }),
    };
    const ask = (question: JudgeQuestion): Promise<JudgeReply> => {
      const request = { kind: 'progress-limit', question, state, bot: item.bot, allowAt: JUDGE_PASS };

      //M 三道判断题使用相同的会话快照和评分门槛。
      return requestEventModule.requestEvent(this.ctx, 'decision/judge', 'decision/judge-result', request, options);
    };

    //M 并发收集三个分数，齐全时才考虑延长。
    const progressingReply = ask(words.QUESTIONS.progressing);
    const nearlyDoneReply = ask(words.QUESTIONS.nearlyDone);
    const loopingReply = ask(words.QUESTIONS.looping);
    const requests = [progressingReply, nearlyDoneReply, loopingReply] as const;
    const [progressing, nearlyDone, looping] = await Promise.all(requests);

    //G 任一题没有分数就保留原时限，并如实报告那道题的原因。
    if (progressing.score === undefined) return { extend: false, why: progressing.reason };
    if (nearlyDone.score === undefined) return { extend: false, why: nearlyDone.reason };
    if (looping.score === undefined) return { extend: false, why: looping.reason };

    const progressingText = progressing.score.toFixed(2);
    const nearlyDoneText = nearlyDone.score.toFixed(2);
    const loopingText = looping.score.toFixed(2);
    const detail = `推进 ${progressingText}、快做完 ${nearlyDoneText}、打转 ${loopingText}`;
    const extend = progressing.score >= JUDGE_PASS && nearlyDone.score >= JUDGE_PASS && looping.score < JUDGE_PASS;
    let why = `判断模型认为不该再延长（${detail}）`;
    if (extend) {
      why = `判断模型：${detail}`;
    }
    return { extend, why };
  }

  /** 延够了：转过的直接停；开审核小会话，离谱 → 停并说清；建议转 → 停下后转新会话；不然停。 */
  private async afterExtensions(item: Item): Promise<void> {
    if (item.handedOver === true) {
      //G 这件事之前已经转过一次新会话，防止无限接力，延够后直接停下收尾。
      this.stop(item, '延够了，这件事已经转过一次新会话，不再转');
      return;
    }
    //M 更新进度显示为审核中，拼装对话和日志内容开审核小会话判断当前是否离谱或需转新会话。
    item.action = '延够了，在审核要不要换个会话';
    this.push(item, true);
    const content = `用户的话：\n${item.said.join('\n') || item.text}\n\n工作过程：\n${item.log.join('\n')}`;
    const model = this.settings.reviewModel ?? item.session.row.model;
    const language = this.language(item);
    const prompt = words.REVIEW_PROMPT[language] ?? words.REVIEW_PROMPT['zh'] ?? '';

    //M 审核小会话优先用模型支持的最高档。
    const thinking = await this.getThinking(model, 'high');
    if (item.endedAt !== undefined || item.stopAsked !== undefined) return;

    //M 会话仍在运行才继续审核。
    const answer = await this.small(item, 'progress-review', prompt, content, model, thinking);
    if (item.endedAt !== undefined || item.stopAsked !== undefined) return;

    //M 解析审核结论并记入日志，再依据离谱/转交/停下分支推进。
    const verdict = words.readVerdict(answer);
    this.note(item, `审核：${verdict.why}`);
    if (verdict.absurd) {
      item.flagged = verdict.absurdWhy;
      //G 审核发现死循环或离谱行为，立即标明原因并停下会话。
      this.stop(item, `审核发现离谱：${verdict.absurdWhy}`);
      return;
    }
    if (verdict.handoff) {
      item.stopAsked = 'handoff';
      item.handoffNote = verdict.handoffNote;
      item.action = '要转到新会话，正在停下老的';
      //M 审核建议转交新会话：先停止老会话并推送等待交接状态，待 end 触发交接。
      item.session.stop('progress');
      this.push(item, true);
      return;
    }
    //M 未发现离谱且无需转交时，按普通超时结论停下会话准备收尾。
    this.stop(item, verdict.why);
  }

  /** 叫停：记下是限时停的，session.stop，马上推。 */
  private stop(item: Item, why: string): void {
    if (item.endedAt !== undefined) return;
    clearTimeout(item.timers.remind);
    clearTimeout(item.timers.limit);
    item.stopAsked = 'timeout';
    item.action = '时间到了，正在停下';
    //M 把带限时信息的停止原因写入日志，立即停止会话并推送前端。
    this.note(item, `${this.limitText(item)}到了，停下：${why}`);
    item.session.stop('progress');
    this.push(item, true);
  }

  /**
   * 一轮结束：转新会话、写收尾、或者直接定格。
   * @param session 结束的会话。
   */
  private async end(session: Session): Promise<void> {
    //G 取对应进度项，若不存在或已经定格则跳过；否则先清净定时器准备收尾。
    const item = this.items.get(session.id);
    if (item === undefined || item.endedAt !== undefined || item.handoffPending === true) return;
    this.clearTimers(item, false);
    const row = session.row;

    if (item.stopAsked === 'handoff' && row.state !== 'done') {
      //M 因审核建议转交而停且未自发完成时，执行会话交接接力继续做。
      item.handoffPending = true;
      await this.handOff(item);
      return;
    }
    if (item.stopAsked === 'timeout') {
      //M 因限时或离谱被叫停时，先推送收尾中状态再开收尾小会话汇总进展与卡点。
      item.action = '时间到了，正在写收尾总结';
      this.push(item, true);
      const content = `用户的话：\n${item.said.join('\n') || item.text}\n\n工作过程：\n${item.log.join('\n')}`;
      const model = this.settings.wrapupModel ?? row.model;
      const language = this.language(item);
      const prompt = words.WRAPUP_PROMPT[language] ?? words.WRAPUP_PROMPT['zh'] ?? '';

      //M 收尾小会话优先用模型支持的最低档。
      const thinking = await this.getThinking(model, 'low');

      //M 取得思考档后生成收尾摘要。
      const summary = await this.small(item, 'wrapup', prompt, content, model, thinking);
      const flagged = item.flagged;
      let stage: ProgressStage = 'timeout';
      let action = '到点停下了';
      let head = '⏱ 到点了，这件事先停在这里：';
      if (flagged !== undefined) {
        stage = 'flagged';
        action = '发现离谱，停下了';
        head = `⚠ 这件事做得离谱，先停下了：${flagged}\n收尾：`;
      }
      //M 按是否标为离谱定格结局，再把生成的收尾总结发给用户。
      this.close(item, stage, action, summary);
      const text = `${head}\n${summary}`;

      //M 通知机器人把收尾内容发给用户。
      this.ctx.emit('bot/say', session, text);
      return;
    }
    if (row.state === 'done') {
      //M 会话自然完成，以 done 结局定格本轮进度。
      this.close(item, 'done', '完成', row.reply);
      return;
    }
    if (row.state === 'failed') {
      //M 会话异常报错结束，以 error 结局定格本轮进度。
      this.close(item, 'error', '出错了', row.reply);
      return;
    }
    //M 其余由用户或外部叫停的场景，以 stopped 结局定格本轮进度。
    this.close(item, 'stopped', '已停止', row.reply);
  }

  /**
   * 通过 bot/request 转新会话，只有收到接单回执才记为已转交。
   * @param item 已停下等待接手的进度项。
   * 副作用：保存接手会话与进度标记，定格老会话，通知用户结果。
   */
  private async handOff(item: Item): Promise<void> {
    //M 取所属机器人实例和老会话记录文件路径，为创建新会话接手准备上下文。
    const row = item.session.row;
    const bot = this.ctx.bots.get(row.bot);
    const md = path.join(this.ctx.resources.root, 'bots', row.bot, 'sessions', row.id, '对话.md');
    const note = item.handoffNote ?? '';
    if (bot === undefined) {
      //G 原机器人已不在配置中导致无法开启新会话，直接按 stopped 定格。
      this.close(item, 'stopped', '想转新会话，但机器人不在了');
      return;
    }
    const said = item.said.join('\n') || item.text;
    const text = `（交接）这件事从会话 ${row.id} 转过来接着做。\n\n用户的原话：\n${said}\n\n`
      + `交接说明：\n${note}\n\n老会话的记录：${md}`;

    //M 前台派的后台（bots/Dispatch.ts 记了 frontTask）：新会话接着记原前台、工作区、模型，结果照旧交回原前台；
    //M   老会话记上转去哪，它这次停下不交回。绑定的工作区 ID（row.workspaceId）照抄；地址里带着工作区目录，bot.hand 照它换。
    let freshId: string | undefined;
    const task = row.frontTask;
    if (task !== undefined) {
      const created = this.ctx.sessions.create({
        kind: 'work',
        bot: row.bot,
        parent: row.parent,
        customer: row.customer,
        model: row.model,
        thinking: row.thinking,
        frontTask: { ...task, round: 1 },
        quiet: true,
        workspaceId: row.workspaceId,
      });
      //M 先在内存中屏蔽老会话下一拍的交回，收到回执后再随定格存盘。
      freshId = created.id;
      task.handedTo = freshId;
    }
    //M 把交接摘要投递给新会话并打上 handedOver 防止再转，随后定格老会话并告知用户去向。
    const origin = { channel: row.channel, address: row.address };
    const request = { action: 'hand', bot: row.bot, text, origin, sessionId: freshId } as const;
    const options = {
      timeoutMs: 10_000,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => ({
        requestId: '', ok: false, error: detail ?? `转交未获回执（${reason}）`,
      }),
    };

    //M 把交接内容发给机器人，凭回执定位实际接手的会话。
    const reply = await requestEventModule.requestEvent(this.ctx, 'bot/request', 'bot/result', request, options);

    //G 转交失败，撤掉老会话的转交标记，留下真实失败原因。
    if (!reply.ok || reply.sessionId === undefined) {
      if (task !== undefined && task.handedTo === freshId) {
        delete task.handedTo;
      }
      const failure = `想转新会话，但没有接手成功：${reply.error ?? '回执没有会话号'}`;

      //M 将失败原因写入进度和日志，告知原会话的用户。
      this.note(item, failure);
      this.close(item, 'stopped', failure);
      this.ctx.emit('bot/say', item.session, failure);
      return;
    }

    //M 接手后给新会话打上 handedOver，防止同一件事再次自动转交。
    const fresh = this.ctx.sessions.open(reply.sessionId);
    const next = this.items.get(fresh.id);
    if (next !== undefined) next.handedOver = true;
    const freshProgress = fresh.row.progress ?? { startedAt: Date.now(), limitChosen: false, extended: 0 };
    fresh.row.progress = { ...freshProgress, handedOver: true };
    fresh.save();
    this.close(item, 'handed', `转到新会话 ${fresh.id}`);
    const notice = `↪ 这件事转到新会话 ${fresh.id} 接着做。交接说明：\n${note}`;

    //M 通知机器人向用户说明新会话去向和交接内容。
    this.ctx.emit('bot/say', item.session, notice);
  }

  /**
   * 开一场小会话问一次：收尾、审核共用。
   * @returns 做完时的回答；没做完交回“（没写成：原因）”。
   */
  private async small(
    item: Item,
    kind: string,
    prompt: string,
    content: string,
    model: string,
    thinking: Thinking,
  ): Promise<string> {
    //M 骨架的 sessions.ask 问一次。
    const askInput: AskInput = {
      bot: item.bot,
      kind,
      parent: item.sessionId,
      model,
      thinking,
      text: `${prompt}\n\n${content}`,
    };
    //M 发起独立小会话并等待模型生成审核结论或收尾总结。
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //M 没做完写明原因。
    if (!ok) return `（没写成：${reply}）`;

    return reply;
  }

  /**
   * 请求把长跑卡片标为会话已结束。
   * @param id 待确认项编号。
   * @param action 会话结束时的进度说明。
   * 副作用：通知审核插件关闭尚未点过的卡片；进度结算照常完成。
   */
  private closeCard(id: number, action: string): void {
    const note = `会话已结束（${action}）`;
    const request = { action: 'close', id, note } as const;

    //M 卡片清理是单向指令，不等待回执。
    void this.ctx.serial('approval/request', request).catch((error: unknown) => {
      console.error(`关闭长跑提醒 #${String(id)} 失败：${textModule.getMessage(error)}`);
    });
  }

  /**
   * 定格：记结局、清定时器、删 row.progress、马上推、10 分钟后删项；做太久或被限时、终止的记进 overtime.jsonl。
   */
  private close(item: Item, stage: ProgressStage, action: string, result?: string): void {
    item.endedAt = Date.now();
    if (item.cardId !== undefined && item.cardId > 0) {
      //M 作废仍待确认的长跑提醒，进度结算继续进行。
      this.closeCard(item.cardId, action);
    }
    item.stage = stage;
    item.action = action;

    //M 收尾只保留简短结果，供进度页显示。
    if (result !== undefined && result !== '') item.result = textModule.clip(result, 240);

    //M 结束后清除定时器和会话进度记录，随后通知进度页。
    this.clearTimers(item, false);
    delete item.session.row.progress;
    item.session.save();
    this.push(item, true);
    setTimeout(() => {
      if (this.items.get(item.sessionId) === item) this.items.delete(item.sessionId);
    }, KEEP_ENDED_MS).unref?.();

    //T 跟踪：一轮定格。
    const closeVars = {
      会话: item.sessionId,
      结局: stage,
      用时: textModule.getDuration(item.endedAt - item.startedAt),
    };
    this.ctx.emit('trace', 'Progress.close', '一轮定格', 'close(item, stage)', closeVars);

    const usedMs = item.endedAt - item.startedAt;
    const forced = ['timeout', 'stopped', 'flagged', 'handed'].includes(stage);
    if (usedMs < this.settings.overtimeMinutes * MINUTE && !forced) return;
    //M 运行过久或被强制终止的会话，先把各段耗时及元信息组装成一条超时记录。
    const line = {
      at: item.endedAt,
      bot: item.bot,
      sessionId: item.sessionId,
      sessionTitle: item.sessionTitle ?? '',
      text: item.text,
      stage,
      usedMs,
      limitMinutes: item.limitMinutes,
      timings: item.timings,
      timingsText: words.timingsText(item.steps, item.timings, usedMs),
      model: item.model,
    };
    //M 将超时记录追加写入 overtime.jsonl，供空闲时 Review 挑选复盘。
    fs.appendFileSync(path.join(this.ctx.resources.dir('data'), 'overtime.jsonl'), `${JSON.stringify(line)}\n`, 'utf8');
  }

  /** 合并成一秒一次推 progress/update；now 时马上推。 */
  private push(item: Item, now = false): void {
    const send = (): void => {
      delete item.timers.push;
      item.lastPush = Date.now();
      //M 清除节流标记并向事件总线广播一份脱敏后的进度视图副本。
      this.ctx.emit('progress/update', this.view(item));
    };
    if (now) {
      clearTimeout(item.timers.push);
      //M 强制立即推送时取消未触发的节流定时器并当场发出。
      send();
      return;
    }
    if (item.timers.push !== undefined) return;
    const wait = item.lastPush + PUSH_EVERY_MS - Date.now();
    if (wait <= 0) {
      //M 距上次推送已达或超过节流间隔，立即发送本次更新。
      send();
      return;
    }
    item.timers.push = setTimeout(send, wait);
  }

  /** 拷贝出给外面看的那部分。 */
  private view(item: Item): ProgressItem {
    const {
      session,
      log,
      said,
      lastAt,
      remindAt,
      stopAsked,
      flagged,
      handoffNote,
      handoffPending,
      handedOver,
      timers,
      lastPush,
      cardId,
      ...shown
    } = item;
    void [log, said, lastAt, remindAt, stopAsked, flagged, handoffNote, handoffPending];
    void [handedOver, timers, lastPush, cardId];
    const title = (session.row as { summary?: string }).summary;
    const copiedTimings = {
      modelMs: shown.timings.modelMs,
      tools: shown.timings.tools.map((tool) => ({ ...tool })),
    };
    const copy: ProgressItem = { ...shown, timings: copiedTimings, messageIds: [] };
    if (title !== undefined && title !== '') copy.sessionTitle = title;
    return copy;
  }

  /** 工作过程记一行（最多 80 行）。 */
  private note(item: Item, line: string): void {
    //M 拼接当前本地时间记入工作过程缓冲，超出上限时裁掉最早的旧行。
    item.log.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`);
    if (item.log.length > LOG_LINES) item.log.splice(0, item.log.length - LOG_LINES);
  }

  /** 限时写成一句话。 */
  private limitText(item: Item): string {
    //M 按当前限时分钟数与延长次数生成可读中文描述，供日志和报时引用。
    return words.limitText(item.limitMinutes, item.extended, this.settings.extendMinutes);
  }

  /** row.progress 跟着内存那项改，存库。 */
  private saveRow(item: Item): void {
    const row = item.session.row;
    const saved: NonNullable<typeof row.progress> = {
      startedAt: item.startedAt,
      limitChosen: item.limitChosen,
      extended: item.extended,
    };
    if (item.limitMinutes !== undefined) saved.limitMinutes = item.limitMinutes;
    if (item.handedOver === true) saved.handedOver = true;
    if (item.cardId !== undefined) saved.cardId = item.cardId;
    row.progress = saved;
    //M 将最新进度限时状态写入会话行持久化，保证进程重启后能接着计时。
    item.session.save();
  }

  /** 清定时器；all 时连合并推的也清。 */
  private clearTimers(item: Item, all: boolean): void {
    clearTimeout(item.timers.remind);
    clearTimeout(item.timers.limit);
    clearTimeout(item.timers.card);
    if (all) clearTimeout(item.timers.push);
  }

  /** 机器人的语言，不写是 zh。 */
  private language(item: Item): string {
    //M 读取当前机器人配置中的首选语言，缺省时按中文选用提示词。
    return String(this.ctx.bots.get(item.bot)?.config['language'] ?? 'zh');
  }

  /**
   * 查收尾、审核和复盘小会话的思考档。
   * @param model 供应商名/模型 ID。
   * @param want low 取最低、high 取最高。
   * @returns 支持的非 off 档，目录无应答或无合适档位时用 minimal 或 high。
   */
  async getThinking(model: string, want: 'low' | 'high'): Promise<Thinking> {
    const request = { action: 'find', model } as const;
    const options = {
      timeoutMs: CATALOG_TIMEOUT_MS,
      onFallback: () => ({ requestId: '' }),
    };

    //M 通过事件取模型支持的思考档，供同插件的三种小会话选择。
    const result = await requestEventModule.requestEvent(
      this.ctx,
      'model-catalog/request',
      'model-catalog/result',
      request,
      options,
    );
    const infoLevels = result.info?.thinking ?? [];
    const levels = infoLevels.filter((level): level is Thinking => LEVELS.includes(level as Thinking));
    if (levels.length === 0) {
      if (want === 'low') return 'minimal';

      return 'high';
    }
    const sorted = [...levels].sort((left, right) => LEVELS.indexOf(left) - LEVELS.indexOf(right));
    let picked = sorted.at(-1);
    if (want === 'low') {
      picked = sorted[0];
    }
    return picked ?? 'minimal';
  }
}


/**
 * 在插件入口逐项合并新配置和 0.4 的旧键，再校验限时与模型。
 * @param config 插件清单项里的 progress 配置。
 * @param legacy 旧 engine 段。
 * @returns 服务和复盘共用的配置。
 * @throws 数值或模型格式不合法时抛错。
 */
function readSettings(config: ProgressConfig, legacy: Record<string, unknown> | undefined): Settings {
  const getValue = (key: keyof ProgressConfig): unknown => {
    const oldPath = `engine.${key}`;
    const newPath = `plugins[progress].config.${key}`;
    const current = config[key];
    const previous = legacy?.[key];

    //M 用项目共用迁移规则保留旧值，并在本进程提示一次。
    return checks.getMigratedConfig(current, previous, oldPath, newPath);
  };
  const number = (key: keyof ProgressConfig, fallback: number, allowZero = false): number => {
    //M 旧值合并后按现有数值规则校验，未填时沿用默认。
    const configured = getValue(key);
    const value = configured ?? fallback;
    if (typeof value !== 'number' || value < 0 || (!allowZero && value === 0)) {
      let kind = '正';
      if (allowZero) {
        kind = '不小于 0 的';
      }
      throw new Error(`progress.${key} 要是${kind}数`);
    }
    return value;
  };
  const model = (key: keyof ProgressConfig): string | undefined => {
    //M 保留模型留空时回退到原会话模型的行为。
    const value = getValue(key);
    if (value === undefined || value === null || value === '') return undefined;
    const invalid = `progress.${key} 要写成 供应商名/模型 ID`;
    //G 非空模型配置必须带供应商。
    if (typeof value !== 'string' || !value.includes('/')) throw new Error(invalid);

    return value;
  };
  //M 校验限时、延长与长跑的分钟数，汇总为内部配置。
  const settings: Settings = {
    defaultMinutes: number('limit_default_minutes', 0, true),
    remindBefore: number('limit_remind_before_minutes', 10, true),
    extendMinutes: number('limit_extend_minutes', 5),
    extendTimes: number('limit_extend_times', 2, true),
    overtimeMinutes: number('overtime_minutes', 10, true),
    longRunMinutes: number('long_run_card_minutes', 15, true),
  };
  //M 解析可选的收尾和审核模型覆写项，有效时记入配置对象。
  const wrapup = model('wrapup_model');
  const review = model('limit_review_model');
  if (wrapup !== undefined) settings.wrapupModel = wrapup;
  if (review !== undefined) settings.reviewModel = review;
  return settings;
}


/**
 * 挂上进度与超时复盘（review 已并入本插件）。
 * Cordis 在依赖服务就绪后调用。限时与复盘从 progress 清单项读取。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins[progress].config，可省略。
 * @throws 限时、模型或复盘配置不合法时抛错。
 * 副作用：注册 progress 服务，可选挂载 Review 复盘定时器与 HTTP 进度查询/操作路由。
 */
export function apply(ctx: cordis.Context, config?: ProgressConfig): void {
  //M 校验插件配置形状和复盘设置，再在入口迁移 0.4 的旧进度键。
  const reviewSettings = reviewModule.readReviewSettings(config);
  const legacy = ctx.resources.raw['engine'] as Record<string, unknown> | undefined;
  const current = config ?? {};
  const settings = readSettings(current, legacy);

  //M 进度服务和复盘都使用入口解析好的配置。
  const progress = new Progress(ctx, settings);

  //M 复盘经事件查待确认和送审，按自己的配置挂载。
  if (reviewSettings.enabled) {
    //M 复用收尾模型设置，未配时由复盘沿用该会话模型。
    new reviewModule.Review(ctx, progress, reviewSettings, settings.wrapupModel);
  }

  //M 飞书是可选的：按该渠道已校验的群配置挂本地定时。
  void ctx.inject(['feishu'], (sub) => {
    const groups = sub.feishu.config.groups.values();
    //M 给日报轮限工具，再为已登记的群挂定时。
    dailyModule.bindReportTools(sub);
    dailyModule.setupGroupReports(sub, groups);
  });

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口。
  void ctx.inject(['http'], (sub) => {
    sub.http.app.get<{ Querystring: { bot?: string } }>(
      '/api/progress',
      async (request) => progress.list(request.query.bot),
    );
    sub.http.app.post<{ Params: { id: string }; Body: unknown }>('/api/progress/:id', async (request) => {
      let body: Record<string, unknown> = {};
      if (typeof request.body === 'object' && request.body !== null) {
        body = request.body as Record<string, unknown>;
      }
      let minutes: number | undefined;
      if (typeof body['minutes'] === 'number' && body['minutes'] > 0) {
        minutes = body['minutes'];
      }
      let action: 'stop' | 'limit' = 'limit';
      if (body['action'] === 'stop') {
        action = 'stop';
      }
      //M 将解析后的数字 ID、动作与限时分钟数转交给 progress.actById 执行并返回回执。
      return { text: progress.actById(Number(request.params.id), action, minutes) };
    });
  });
}
