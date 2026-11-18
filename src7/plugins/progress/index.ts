/**
 * 进度和限时：有用户的会话（记录上有 channel、没有 parent；前台交出去的后台会话 kind work 有 parent 也算）每转一轮就有一项进度：开始时间、第几步、在调哪个工具、各工具用时、限时、阶段、结果。
 * 长跑提醒（用户 11-14 定的）：一轮跑满 15 分钟（engine.long_run_card_minutes）发一张卡片问要不要终止（approval 的待确认，网页、飞书同一份卡片数据）。
 *   点“终止”才停；点“继续”或一直不点都一直做下去。一轮只发一张；会话结束时还没点的卡片变灰写“会话已结束”。
 * 限时：默认不限时（engine.limit_default_minutes 默认 0，不能“不点就自动停”）；配了正数才照 0.4：到点前报时、到点判断。
 *   网页、卡片上能选 15/20 分钟（提前 5 分钟报时）或不限时，都从开始算；随时能终止。
 * 报时：每一步发给模型的对话末尾加一句“已经干了多久”（不存进对话），同时跟用户说一次。
 * 到点：用户选的直接停；默认的问 decision 三道题（在推进、5 分钟能做完、没在打转），都过就延 5 分钟，最多两次；
 *   延够了开一场审核小会话：离谱就停下说清哪里离谱，建议转就开一场新的后台会话带交接说明接着做（一件事只转一次），不然停下。
 * 停下以后开一场收尾小会话写“做到哪了、卡在哪、还剩什么”发给用户；做太久或被限时、终止的，记一行 data/overtime.jsonl，空闲时由 Review.ts 挑一件写复盘。
 * 每次变化发 progress/update（一场一秒最多一次，结束马上发）：feishu 画卡片、journal 记流水、网页 GET /api/progress 轮询。
 * 照 0.4 src/capabilities/Progress.ts、Review.ts。设计：docs/src7插件设计/progress.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { AskInput, Session, Thinking } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import type * as cardUtils from '../../utils/Card.ts';
import * as reviewModule from './Review.ts';
import * as words from './Words.ts';

export type { ReviewConfig } from './Review.ts';


/** 插件名。 */
export const name = 'progress';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.1：转新会话时照抄后台绑定的工作区 ID（row.workspaceId）。
export const version = '1.1.3';

/** 用到的服务：resources 拿配置和目录；bots 跟用户说话、转新会话；sessions 开收尾、审核小会话。approval（复盘用）、http、decision、modelCatalog、filesMirror 是可选的。 */
export const inject = ['resources', 'bots', 'sessions'];


/** progress 插件配置（plugins[progress].config）。主配置仍读顶层 engine 段；review 子键可调复盘检查间隔或设 false 关闭。 */
export interface ProgressConfig {
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
  handedOver?: boolean;
  timers: { push?: ReturnType<typeof setTimeout>; remind?: ReturnType<typeof setTimeout>; limit?: ReturnType<typeof setTimeout>; card?: ReturnType<typeof setTimeout> };
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
    progress?: { startedAt: number; limitMinutes?: number; limitChosen: boolean; extended: number; handedOver?: boolean; cardId?: number };
  }
}


/** 校验后的配置（顶层 engine 段）。 */
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

/** approval 服务里用到的（没挂 approval 时退回一句话提醒）。 */
interface ApprovalLike {
  ask(input: { kind: string; title: string; detail: string; payload?: unknown; bot: string; session?: string; card?: Omit<cardUtils.CardData, 'state' | 'result'> }): { id: number };
  close(id: number, note: string): unknown;
}

/** approval/decided 里用到的。 */
interface DecidedLike {
  id: number;
  kind: string;
  state: string;
  payload?: unknown;
  card?: { state: string };
}

/** decision 服务里用到的（decision.md 第 2 节）。 */
interface DecisionLike {
  judge(input: { kind: string; question: { instructions: string; yes: string; no: string }; state: Record<string, unknown>; bot?: string; allowAt?: number }):
    Promise<{ verdict: string; score?: number; reason: string }>;
}

/** model-catalog 里用到的：模型的思考档。 */
interface CatalogLike {
  find(id: string): { thinking: string[] } | undefined;
}


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
      if (item === undefined || item.endedAt !== undefined || item.remindAt === undefined || Date.now() < item.remindAt) return;
      const content = `（系统）这件事已经干了 ${textModule.getDuration(Date.now() - item.startedAt)}，${this.limitText(item)}。`
        + '回复用户时说清干了多久、做到哪了；快到点了就抓紧收尾，做不完就写清做到哪了、还剩什么。';
      request.messages.push({ role: 'user', content, timestamp: Date.now() });
    });

    //M approval/decided（通知）：长跑提醒卡片定了。同意 = 终止；拒绝 = 继续（记一笔，什么都不改）；ended 是会话结束时自己作废的，不管。
    ctx.on('approval/decided', (pending: DecidedLike) => {
      if (pending.kind !== LONG_RUN_KIND || pending.card?.state === 'ended') return;
      const sessionId = (pending.payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== 'string') return;
      const item = this.items.get(sessionId);
      if (pending.state === 'approved') {
        this.act(sessionId, 'stop');
        return;
      }
      if (item !== undefined) {
        this.note(item, '长跑提醒：用户点了继续');
        //T 跟踪：用户点了继续。
        this.ctx.emit('trace', 'Progress.continue', '长跑提醒点了继续，一直做下去', "ctx.on('approval/decided')", { 会话: sessionId, 卡片: pending.id });
      }
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
      startedAt: saved?.startedAt ?? Date.now(), steps: 0, limitChosen: false, extended: 0, timings: { modelMs: 0, tools: [] }, messageIds: [],
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
    item.timers.card = setTimeout(() => this.sendCard(item), Math.max(0, item.startedAt + this.settings.longRunMinutes * MINUTE - Date.now()));
  }

  /**
   * 发长跑提醒卡片：已运行多久、现在在做什么、第几步、用户的话；“终止”（危险色）和“继续”。
   * 有 approval 就登记成待确认（网页审批面板、飞书卡片都照卡片数据画，回“同意 N”也行）；没有就跟用户说一句，网页进度上还能点终止。
   */
  private sendCard(item: Item): void {
    if (item.endedAt !== undefined || item.stopAsked !== undefined || item.cardId !== undefined) return;
    //M 计算当前已运行时长并检查可选的 approval 服务是否就绪，用于决定发交互卡片还是纯文本提醒。
    const elapsed = textModule.getDuration(Date.now() - item.startedAt);
    const approval = this.ctx.get('approval') as ApprovalLike | undefined;
    //T 跟踪：发长跑提醒。
    this.ctx.emit('trace', 'Progress.sendCard', '跑满时长，发卡片问要不要终止', 'approval.ask(长跑提醒卡片)', { 会话: item.sessionId, 干了: elapsed, 有审批: approval !== undefined });
    if (approval === undefined) {
      item.cardId = 0;
      this.ctx.bots.say(item.session, `⏳ 这件事已经干了 ${elapsed}，现在${item.action}。要停就在网页进度上点“终止”；不管它就一直做下去。`);
      this.saveRow(item);
      return;
    }
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
      buttons: [{ action: 'approve', label: '终止', style: 'danger' }, { action: 'reject', label: '继续', style: 'default' }],
    };
    //M 向审批服务登记长跑确认卡片并记住卡片 ID，写日志存库防止重启重复弹窗。
    const pending = approval.ask({
      kind: LONG_RUN_KIND, title: card.title, detail: `已运行 ${elapsed}，现在${item.action}`, payload: { sessionId: item.sessionId }, bot: item.bot, session: item.sessionId, card,
    });
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
        if (block.type === 'thinking' && block.thinking.trim() !== '') this.note(item, `思考：${textModule.clip(block.thinking.trim().split('\n')[0] ?? '', LOG_CHARS)}`);
        if (block.type === 'text' && block.text.trim() !== '') this.note(item, `说：${textModule.clip(block.text.trim(), LOG_CHARS)}`);
        if (block.type === 'toolCall') this.note(item, `调用 ${block.name} ${textModule.clip(JSON.stringify(block.arguments), LOG_CHARS)}`);
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
      this.note(item, `结果 ${message.toolName}${errSuffix}：${textModule.clip(piAi.contentText(message.content), LOG_CHARS)}`);
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
      this.ctx.emit('trace', 'Progress.remind', '开始报时', 'bots.say(session, 报时)', { 会话: item.sessionId, 干了: elapsed });
      this.ctx.bots.say(item.session, `⏳ 这件事已经干了 ${elapsed}，${this.limitText(item)}；到点会先停下，把做到哪写给你。`);
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
    this.ctx.emit('trace', 'Progress.onDeadline', '到点了，判断要不要延', 'judge(item)', { 会话: item.sessionId, 延: verdict.extend, 为什么: verdict.why });
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
   * 问 decision 三道题（在推进、5 分钟能做完、在打转）。没挂 decision 就到点停。
   * @returns 延不延、为什么。
   */
  private async judge(item: Item): Promise<{ extend: boolean; why: string }> {
    //M decision 是可选的服务：ctx.get 现取，没挂（或没开工）是 undefined。
    const decision = this.ctx.get('decision') as DecisionLike | undefined;
    if (decision === undefined) return { extend: false, why: '没挂 decision，到点就停' };

    //M 组装任务摘要、已耗时和最近工作日志作为判断上下文，并发询问三道评估题。
    const state = {
      用户的话: item.text, 已经干了: textModule.getDuration(Date.now() - item.startedAt), 限时: this.limitText(item),
      最近的工作过程: item.log.slice(-JUDGE_LOG_LINES).join('\n'),
    };
    try {
      //M 并发向 decision 询问推进、有望完成和打转三道评估题，依据打分门槛决定是否自动延期。
      const ask = (question: { instructions: string; yes: string; no: string }) =>
        decision.judge({ kind: 'progress-limit', question, state, bot: item.bot, allowAt: JUDGE_PASS });
      const [progressing, nearlyDone, looping] = await Promise.all([ask(words.QUESTIONS.progressing), ask(words.QUESTIONS.nearlyDone), ask(words.QUESTIONS.looping)]);
      if (progressing.score === undefined || nearlyDone.score === undefined || looping.score === undefined) {
        return { extend: false, why: `判断模型没答上来，到点就停：${progressing.reason}` };
      }
      const detail = `推进 ${progressing.score.toFixed(2)}、快做完 ${nearlyDone.score.toFixed(2)}、打转 ${looping.score.toFixed(2)}`;
      const extend = progressing.score >= JUDGE_PASS && nearlyDone.score >= JUDGE_PASS && looping.score < JUDGE_PASS;
      let why = `判断模型认为不该再延长（${detail}）`;
      if (extend) {
        why = `判断模型：${detail}`;
      }
      return { extend, why };
    } catch (error) {
      return { extend: false, why: `判断模型出错，到点就停：${textModule.getMessage(error)}` };
    }
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
    const answer = await this.small(item, 'progress-review', words.REVIEW_PROMPT[this.language(item)] ?? words.REVIEW_PROMPT['zh'] ?? '', content, model, this.thinking(model, 'high'));
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
    if (item === undefined || item.endedAt !== undefined) return;
    this.clearTimers(item, false);
    const row = session.row;

    if (item.stopAsked === 'handoff' && row.state !== 'done') {
      //M 因审核建议转交而停且未自发完成时，执行会话交接接力继续做。
      this.handOff(item);
      return;
    }
    if (item.stopAsked === 'timeout') {
      //M 因限时或离谱被叫停时，先推送收尾中状态再开收尾小会话汇总进展与卡点。
      item.action = '时间到了，正在写收尾总结';
      this.push(item, true);
      const content = `用户的话：\n${item.said.join('\n') || item.text}\n\n工作过程：\n${item.log.join('\n')}`;
      const model = this.settings.wrapupModel ?? row.model;
      const summary = await this.small(item, 'wrapup', words.WRAPUP_PROMPT[this.language(item)] ?? words.WRAPUP_PROMPT['zh'] ?? '', content, model, this.thinking(model, 'low'));
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
      this.ctx.bots.say(session, `${head}\n${summary}`);
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

  /** 转新会话：交接说明、用户原话、老会话的 对话.md 路径交给 bot.hand，新会话的项标上转过。 */
  private handOff(item: Item): void {
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
    const text = `（交接）这件事从会话 ${row.id} 转过来接着做。\n\n用户的原话：\n${item.said.join('\n') || item.text}\n\n交接说明：\n${note}\n\n老会话的记录：${md}`;

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
      task.handedTo = created.id;
      //M 把转交去向的新会话 ID 及时保存进老会话记录，防止老会话误把半截结果交回前台。
      item.session.save();
      freshId = created.id;
    }
    //M 把交接摘要投递给新会话并打上 handedOver 防止再转，随后定格老会话并告知用户去向。
    const fresh = bot.hand(text, { channel: row.channel, address: row.address }, freshId);
    const next = this.items.get(fresh.id);
    if (next !== undefined) next.handedOver = true;
    fresh.row.progress = { ...(fresh.row.progress ?? { startedAt: Date.now(), limitChosen: false, extended: 0 }), handedOver: true };
    fresh.save();
    this.close(item, 'handed', `转到新会话 ${fresh.id}`);
    this.ctx.bots.say(item.session, `↪ 这件事转到新会话 ${fresh.id} 接着做。交接说明：\n${note}`);
  }

  /**
   * 开一场小会话问一次：收尾、审核共用。
   * @returns 做完时的回答；没做完交回“（没写成：原因）”。
   */
  private async small(item: Item, kind: string, prompt: string, content: string, model: string, thinking: Thinking): Promise<string> {
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
   * 定格：记结局、清定时器、删 row.progress、马上推、10 分钟后删项；做太久或被限时、终止的记进 overtime.jsonl。
   */
  private close(item: Item, stage: ProgressStage, action: string, result?: string): void {
    item.endedAt = Date.now();
    //M 长跑提醒卡片还在等：作废成“会话已结束”，网页、飞书的卡片变灰。已经点过的 close 会交回一句“已经定过了”，不管。
    if (item.cardId !== undefined && item.cardId > 0) (this.ctx.get('approval') as ApprovalLike | undefined)?.close(item.cardId, `会话已结束（${action}）`);
    item.stage = stage;
    item.action = action;
    if (result !== undefined && result !== '') item.result = textModule.clip(result, 240);
    this.clearTimers(item, false);
    delete item.session.row.progress;
    item.session.save();
    this.push(item, true);
    setTimeout(() => {
      if (this.items.get(item.sessionId) === item) this.items.delete(item.sessionId);
    }, KEEP_ENDED_MS).unref?.();

    //T 跟踪：一轮定格。
    this.ctx.emit('trace', 'Progress.close', '一轮定格', 'close(item, stage)', { 会话: item.sessionId, 结局: stage, 用时: textModule.getDuration(item.endedAt - item.startedAt) });

    const usedMs = item.endedAt - item.startedAt;
    if (usedMs < this.settings.overtimeMinutes * MINUTE && !['timeout', 'stopped', 'flagged', 'handed'].includes(stage)) return;
    //M 运行过久或被强制终止的会话，先把各段耗时及元信息组装成一条超时记录。
    const line = {
      at: item.endedAt, bot: item.bot, sessionId: item.sessionId, sessionTitle: item.sessionTitle ?? '', text: item.text, stage, usedMs,
      limitMinutes: item.limitMinutes, timings: item.timings, timingsText: words.timingsText(item.steps, item.timings, usedMs), model: item.model,
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
    const { session, log, said, lastAt, remindAt, stopAsked, flagged, handoffNote, handedOver, timers, lastPush, cardId, ...shown } = item;
    void [log, said, lastAt, remindAt, stopAsked, flagged, handoffNote, handedOver, timers, lastPush, cardId];
    const title = (session.row as { summary?: string }).summary;
    const copy: ProgressItem = { ...shown, timings: { modelMs: shown.timings.modelMs, tools: shown.timings.tools.map((tool) => ({ ...tool })) }, messageIds: [] };
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
    const saved: NonNullable<typeof row.progress> = { startedAt: item.startedAt, limitChosen: item.limitChosen, extended: item.extended };
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
   * 小会话的思考档：有 modelCatalog 就取这个模型最低（收尾）或最高（审核）的非 off 档；没有用 minimal、high。
   * @param want low 取最低、high 取最高。
   */
  private thinking(model: string, want: 'low' | 'high'): Thinking {
    //M 查询可选的 modelCatalog 服务以拿到该模型实际支持的思考档位列表。
    const catalog = this.ctx.get('modelCatalog') as CatalogLike | undefined;
    const levels = (catalog?.find(model)?.thinking ?? []).filter((level): level is Thinking => LEVELS.includes(level as Thinking));
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
 * 读顶层 engine 段的限时配置（正数，可以是小数，测试用）。
 * @throws 写错了抛错。
 */
function readSettings(ctx: cordis.Context): Settings {
  const engine = (ctx.resources.raw['engine'] ?? {}) as Record<string, unknown>;
  const number = (key: string, fallback: number, allowZero = false): number => {
    const value = engine[key] ?? fallback;
    if (typeof value !== 'number' || value < 0 || (!allowZero && value === 0)) {
      let kind = '正';
      if (allowZero) {
        kind = '不小于 0 的';
      }
      throw new Error(`engine.${key} 要是${kind}数`);
    }
    return value;
  };
  const model = (key: string): string | undefined => {
    const value = engine[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !value.includes('/')) throw new Error(`engine.${key} 要写成 供应商名/模型 ID`);
    return value;
  };
  //M 校验并汇总顶层 engine 中的各类数值限时与超时阈值设置。
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
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后 Cordis 调一次。主限时配置读顶层 engine，复盘定时读 config.review。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins[progress].config（可选：{ review?: { enabled?, first_ms?, every_ms? } | false }）。
 * @throws config.review 或顶层 engine 中的限时配置不合法时抛错。
 * 副作用：注册 progress 服务，可选挂载 Review 复盘定时器与 HTTP 进度查询/操作路由。
 */
export function apply(ctx: cordis.Context, config?: ProgressConfig): void {
  //M 先校验复盘子配置再读取限时配置，构造 Progress 服务挂载进 Cordis。
  const reviewSettings = reviewModule.readReviewSettings(config);
  const progress = new Progress(ctx, readSettings(ctx));

  //M 复盘需要 approval 问用户确认；通过 ctx.inject(['approval'], ...) 挂载，兼容没挂 approval 的最小配置或单测。
  if (reviewSettings.enabled) {
    void ctx.inject(['approval'], (sub) => {
      new reviewModule.Review(sub, progress, reviewSettings);
    });
  }

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口。
  void ctx.inject(['http'], (sub) => {
    sub.http.app.get<{ Querystring: { bot?: string } }>('/api/progress', async (request) => progress.list(request.query.bot));
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
