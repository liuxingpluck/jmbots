/**
 * 分派（docs/10 5.3、6.10）：拿到一批新消息后定下打断哪些正在运行的会话、放进哪个工作区、新开还是追加到哪个会话、用什么模型。
 * 两档，先快后慢：决策模型（配了才走，有把握才用）→ 常规模型的小循环（带只读工具，回 JSON，核对不过重跑）→ 程序兜底。
 * 每一步都记进分派记录：数据库 messages.dispatch，文件 message/<消息文件名>_分派.md / .json。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as miniLoopModule from '../capabilities/MiniLoop.ts';
import * as tools from '../capabilities/tools/Tools.ts';
import * as utils from '../utils/Utils.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import type * as eventsModule from '../capabilities/Events.ts';
import type * as filesModule from '../capabilities/Files.ts';
import type * as model from '../capabilities/Model.ts';
import type * as storeModule from '../capabilities/Store.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 分派的结论（docs/10 5.3 的表）。 */
export interface Decision {
  /** 要打断的会话 ID，只认运行中的。 */
  interrupt: string[];
  /** 放进哪个工作区；没有就新建。 */
  workspace: string;
  /** 新工作区的一句话说明。 */
  workspaceDescription: string;
  /** new 新开；或者要追加的会话 ID。 */
  session: string;
  /** 新开时的标题。 */
  title: string;
  /** 用哪个模型：新开必填；追加时只在要换模型时才填，不换是空。 */
  model: string;
  /** 思考档；空 = 这个模型的最高档。 */
  thinking: string;
  /** 一句话理由。 */
  reason: string;
  /** 这批要等这条待确认有结果才能做（写了就先不做，审核后重新分派）；不依赖待确认时没有。 */
  waitFor?: number;
  /** 谁定的：decision 决策模型 / llm 常规模型 / fallback 程序兜底。 */
  by: 'decision' | 'llm' | 'fallback';
}


/** 分派看到的现状（决策模型和常规模型看到的是同一份，按“最不常变的在前”排）。 */
export interface DispatchState {
  /** 机器人名。 */
  bot: string;
  /** 这一批新消息。 */
  messages: { id: number; channel: string; source: string; at: number; text: string; images: number }[];
  /** 可用的模型；limitedUntil 是被限流、冷却到什么时候（毫秒），没在冷却是 undefined（docs/10 6.5）。 */
  models: { id: string; vision: boolean; contextWindow: number; thinking: string[]; price: { input: number; output: number }; limitedUntil?: number }[];
  /** 模型评价（knowledge/模型评价.md，截过的）。 */
  modelReview: string;
  /** 机器人的记忆概要。 */
  memoryIndex: string;
  /** 工作区和里面的会话。 */
  workspaces: { name: string; description: string; sessions: SessionLine[] }[];
  /** 还在等用户决定的命令：号、哪个会话、命令、做什么。 */
  approvals: { id: number; sessionId: string; command: string; what: string }[];
}


/** 现状里一个会话那一行。 */
export interface SessionLine {
  /** 会话 ID。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 摘要。 */
  summary: string;
  /** 状态。 */
  status: string;
  /** 用的模型。 */
  model: string;
  /** 已用上下文。 */
  tokens: number;
  /** 最大上下文。 */
  contextWindow: number;
  /** 能不能看图。 */
  vision: boolean;
  /** 最后活动时间，毫秒。 */
  updatedAt: number;
  /** 第一句、最后一句用户的话、最后一次回复的开头（各截 200 字）。 */
  firstUser: string;
  lastUser: string;
  lastReply: string;
  /** 压缩版的路径。 */
  compact: string;
}


/** 分派记录：分派的全过程。 */
export interface DispatchRecord {
  /** 这一批的消息号。 */
  messageIds: number[];
  /** 开始时间，毫秒。 */
  startedAt: number;
  /** 用了多久，毫秒。 */
  ms: number;
  /** 决策模型那一档：模型、用时、题面、每个选项的概率、打断的题面和概率、用没用、为什么、填入的状态（现状）；没走这一档时没有。 */
  decisionModel?: {
    model: string;
    ms: number;
    error?: string;
    question: string;
    options: { label: string; session: string; probability: number }[];
    interruptQuestion?: string;
    interrupt?: number;
    used: boolean;
    why: string;
    state: string;
  };
  /** 常规模型那一档（小循环的结果）；没走这一档时没有。 */
  llm?: miniLoopModule.MiniLoopResult;
  /** 每次核对没过的原因。 */
  checks: string[];
  /** 结论。 */
  result: Decision;
}


/** 现状里最多列多少个会话（最近的在前；运行中的都列）：现状太长，分派又慢又贵。 */
const MAX_SESSIONS = 20;

/** 决策模型的时限，毫秒。 */
const DECISION_TIMEOUT_MS = 5000;

/** 常规模型的时限，毫秒：一个机器人的消息是一批一批分派的，卡在这里后面的话都进不来（包括喊停的）。 */
const LLM_TIMEOUT_MS = 180_000;

/** 决策模型有把握的门槛。 */
const SURE = 0.6;

/** 图片扩展名。 */
const IMAGE_PATTERN = /@"?[^"\s]+\.(?:png|jpe?g|gif|webp)"?/gi;

/** 决策模型的是非题“打断”（docs/10 7.3）。 */
const INTERRUPT_QUESTION: piAi.ClassifierBoolQuestion = {
  type: 'bool',
  instructions: '有会话正在运行。这条新消息是不是要它马上停下手上的事——用户在纠正、反悔、喊停或改需求？只是补充信息、催一下、问进度不算。',
  criteria: { true: '要停下', false: '不用停' },
};
/**
 * 一条 Pi 消息里的文字。
 * @param message 消息。
 */
function textOf(message: piAi.Message): string {
  if (message.role === 'system') {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}


/**
 * 截短，换行压成空格。
 * @param text 原文。
 * @param max 最多几个字。
 */
function clip(text: string, max: number): string {
  /** 压平的。 */
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}


/**
 * 一个会话那一行：第一句、最后一句用户的话、最后一次回复的开头都从对话里取。
 * @param session 会话。
 * @param model 模型清单里的这个模型。
 * @param compact 压缩版的路径。
 */
function sessionLine(
  session: storeModule.SessionRow,
  model: model.ModelSummary | undefined,
  compact: string,
): SessionLine {
  /** 有消息号的用户消息（用户真说的话，不是程序追加的）。 */
  const userMessages = session.messages.filter(
    (stored) => stored.message.role === 'user' && stored.messageIds?.length,
  );
  /** 用户的话（去掉开头那行 [渠道 · 时间 · 消息 #号] 和“这个会话”那段）。 */
  const users = userMessages
    .map((stored) => textOf(stored.message).split(/\n# (?:用户的消息|User message)\n\n/).at(-1) ?? '')
    .map((text) => text.replace(/^\[[^\]]*消息 #\d+\]\n|^\[[^\]]*message #\d+\]\n/gm, ''));
  /** 最后一次回复：reply 的 text，或者最后一条助手的话。 */
  let lastReply = '';
  for (const stored of session.messages) {
    if (stored.message.role !== 'assistant') {
      continue;
    }
    for (const block of stored.message.content) {
      if (block.type === 'toolCall' && block.name === 'reply' && typeof block.arguments.text === 'string') {
        lastReply = block.arguments.text;
      }
    }
    /** 助手的话。 */
    const text = textOf(stored.message).trim();
    if (text && !stored.message.content.some((block) => block.type === 'toolCall')) {
      lastReply = text;
    }
  }
  return {
    id: session.id,
    title: session.title,
    summary: session.summary,
    status: session.status,
    model: session.model,
    tokens: session.tokens,
    contextWindow: model?.contextWindow ?? 0,
    vision: model?.vision === true,
    updatedAt: session.updatedAt,
    firstUser: clip(users[0] ?? '', 200),
    lastUser: clip(users.at(-1) ?? '', 200),
    lastReply: clip(lastReply, 200),
    compact,
  };
}


/** 强制分派能用的工具：都只读。 */
const FORCE_TOOLS = ['session_list', 'read', 'find', 'memory'];

/** “强制执行”别的语言的说法。 */
const FORCE_WORDS = /^(force[ -]?(run|execute|exec)|forced execution|forcer l['’]ex[ée]cution|ex[ée]cution forc[ée]e|ex[ée]cuter de force)(?=$|[\s,，:：.。!！])|^force$/iu;

/** 强制分派时写在现状前面的话。 */
const FORCE_NOTE = {
  zh: '# 这是强制分派\n\n用户说了“强制执行”：平时的分派、审核或者某个会话可能卡住了。先用工具看清楚（运行中的会话、历史消息都在这个机器人的文件夹里，只能读，不能改），再定。\n- 在 JSON 里多写一个 "report"：给用户看的一两句话，卡在哪、你打算怎么办。\n- 用户除了“强制执行”还说了要做的事：放进一个会话去做。不要追加到运行中的会话（它可能就是卡住的那个），要做就新开。\n- 用户只说了“强制执行”，或者没有要做的事：session 写 "none"，只报告。\n- 你不能替用户决定待审核的命令，只能告诉他还有哪些在等。\n\n',
  en: '# This is a forced dispatch\n\nThe user said "force run": normal dispatch, a review or a session may be stuck. Look first with the tools (running sessions and past messages are in this bot\'s folder; read only), then decide.\n- Add "report" to the JSON: one or two sentences for the user on what is stuck and what you will do.\n- If the user asked for something besides "force run", put it in a session. Do not append to a running session (it may be the stuck one); open a new one.\n- If they only said "force run" or asked for nothing else, write "none" for session and only report.\n- You cannot decide pending commands for the user; only tell them which are waiting.\n\n',
};


/**
 * 这句话是不是“强制执行”（用户 11-05：开头是它就算，前面可以多几个字，“主协岗强制执行”也算；四种语言）。
 * @param text 用户的原话。
 */
export function isForceText(text: string): boolean {
  /** 去掉首尾空白。 */
  const plain = text.trim();
  /** 中文的说法和它前面的字。 */
  const chinese = /^(\p{L}{0,6}?)(强制执行|強制執行)/u.exec(plain);
  if (chinese) {
    //G “不要强制执行”“如何强制执行”不算。
    return !/[不别別勿没沒未怎为為如何什]/u.test(chinese[1] ?? '');
  }
  return FORCE_WORDS.test(plain);
}


/**
 * 分派器：一个进程建一个，BotLoop 拿着它给每批消息分派（forceDispatch 是“强制执行”用的）。
 * 对外只有 dispatch 和 forceDispatch，其余都是私有的一步。
 */
export class Dispatcher {
  /**
   * @param resources 配置、机器人、提示词、模型选择
   *   （src/resources/Resources.ts 的 Resources，入口 src/entries/App.ts 建的）。
   * @param store 数据库：会话、消息（src/capabilities/Store.ts 的 Store，入口建的）。
   * @param files 文件库：工作区、记忆概要、会话文件路径（src/capabilities/Files.ts 的 Files，入口建的）。
   * @param ai 调模型：列模型、决策模型（src/capabilities/Model.ts 的 Ai，入口建的）。
   * @param approvals 待审核的命令（src/capabilities/Approvals.ts 的 Approvals，入口建的）。
   * @param miniLoop 小循环，第 2 档用它（src/capabilities/MiniLoop.ts 的 MiniLoop，调用方用 ai 和 secrets 建的）。
   * @param toolBox 工具库：小循环里模型用的只读工具、工具定义都从它取
   *   （src/capabilities/tools/Tools.ts 的 ToolBox，入口建的）。
   * @param events 事件总线（src/capabilities/Events.ts 的 EventBus，入口建的）：报 dispatch.decided；
   *   测试里不给就不报。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly store: storeModule.Store,
    private readonly files: filesModule.Files,
    private readonly ai: model.Ai,
    private readonly approvals: approvalsModule.Approvals,
    private readonly miniLoop: miniLoopModule.MiniLoop,
    private readonly toolBox: tools.ToolBox,
    private readonly events: eventsModule.EventBus,
  ) {}


  /**
   * 分派一批消息（docs/10 5.3）：决策模型 → 常规模型 → 程序兜底，全过程记进分派记录。
   * @param bot 机器人名。
   * @param messages 这一批（同一来源，按先后）。
   * @param llmTimeoutMs 常规模型最多等多久，毫秒；测试可以改小。
   * @returns 分派记录，结论在 result 里；从不抛错（最差也是程序兜底）。
   * 副作用：调决策模型、常规模型。
   */
  async dispatch(
    bot: string,
    messages: storeModule.MessageRow[],
    llmTimeoutMs = LLM_TIMEOUT_MS,
  ): Promise<DispatchRecord> {
    /** 开始时间。 */
    const startedAt = Date.now();
    /** 记录里先放的结论：兜底的样子，后面覆盖。 */
    const fallbackResult: Decision = {
      interrupt: [],
      workspace: '日常',
      workspaceDescription: '',
      session: 'new',
      title: '（未命名）',
      model: this.resources.getDefaultModel() ?? '',
      thinking: '',
      reason: '',
      by: 'fallback',
    };
    /** 记录。 */
    const record: DispatchRecord = {
      messageIds: messages.map((row) => row.id),
      startedAt,
      ms: 0,
      checks: [],
      result: fallbackResult,
    };
    this.reportStarted(bot, record, false);
    try {
      //M 1. 拼现状：决策模型和常规模型看同一份。
      /** 机器人。 */
      const info = this.resources.getBot(bot);
      const { state, text } = await this.describe(info, messages);
      this.reportContext(bot, state, text.length, record.messageIds);
      /** 结论。 */
      let decided: Decision | undefined;

      //M 2. 第 1 档决策模型：有待审核时要判断“依赖不依赖”，决策模型的题里没有这一问，交给常规模型。
      /** 有没有会话可以接着做。 */
      const hasSessions = state.workspaces.some((workspace) => workspace.sessions.length > 0);
      /** 该不该先问决策模型。 */
      const tryDecision = this.ai.hasDecision() && state.approvals.length === 0 && hasSessions;
      if (tryDecision) {
        decided = await this.askDecisionModel(state, text, record);
      }

      //M 3. 第 2 档常规模型：卡住了就不等，走程序兜底。
      if (!decided) {
        /** 常规模型的结论，或者超时。 */
        const answer = await Promise.race([
          this.askModel(info, state, text, record),
          Bun.sleep(llmTimeoutMs).then(() => 'timeout' as const),
        ]);
        if (answer === 'timeout') {
          record.checks.push(`常规模型超过 ${llmTimeoutMs / 1000} 秒还没定下来`);
        } else {
          decided = answer;
        }
      }

      //M 4. 都没定下来：程序兜底。
      record.result = decided ?? this.fallback(bot, state);
      //M 5. 报结论（有拦处理器时先问，docs/11_附 第 3.4 节）。
      await this.gateDecision(bot, state, record, false);
    } catch (error) {
      record.checks.push(`分派出错：${utils.errorText(error)}`);
    }
    record.ms = Date.now() - startedAt;
    return record;
  }


  /**
   * 强制分派（用户 11-05）：不排队、不走机器人循环，平时的分派卡住了也能用。
   * 常规模型带只读工具看清现状，报告给用户；有要做的事就新开会话。
   * 决定不了待审核的命令，也不追加到运行中的会话。模型连不上时程序兜底：报告现状，有要做的事就按兜底新开。
   * @param bot 机器人名。
   * @param message 这句话。
   * @param llmTimeoutMs 常规模型最多等多久。
   * @returns 分派记录、给用户看的话、要不要进会话。
   * 副作用：调模型；读机器人文件夹。
   */
  async forceDispatch(
    bot: string,
    message: storeModule.MessageRow,
    llmTimeoutMs = LLM_TIMEOUT_MS,
  ): Promise<{ record: DispatchRecord; report: string; run: boolean }> {
    /** 开始时间。 */
    const startedAt = Date.now();

    //M 1. 拼现状，数出还没进会话的消息。
    /** 机器人。 */
    const info = this.resources.getBot(bot);
    const { state, text } = await this.describe(info, [message]);
    /** 还没进会话的消息。 */
    const waiting = this.store
      .listMessages(bot, { statuses: ['new', 'dispatching', 'queued', 'held'] })
      .filter((row) => row.id !== message.id);
    /** 去掉“强制执行”的说法和标点以后剩下的话。 */
    const rest = message.text
      .trim()
      .replace(/^\p{L}{0,6}?(强制执行|強制執行)/u, '')
      .replace(FORCE_WORDS, '');
    /** 除了“强制执行”还说了别的没有（去掉说法和标点以后还有字）。 */
    const hasTask = /[\p{L}\p{N}]/u.test(rest);
    /** 记录里先放的结论：兜底的样子，后面覆盖。 */
    const fallbackResult: Decision = {
      interrupt: [],
      workspace: '日常',
      workspaceDescription: '',
      session: 'new',
      title: '强制执行',
      model: '',
      thinking: '',
      reason: '',
      by: 'fallback',
    };
    /** 记录。 */
    const record: DispatchRecord = {
      messageIds: [message.id],
      startedAt,
      ms: 0,
      checks: ['强制分派'],
      result: fallbackResult,
    };
    this.reportStarted(bot, record, true);
    this.reportContext(bot, state, text.length, record.messageIds);
    /** 核对通过的结论；只报告时是 null。 */
    let decided: Decision | null | undefined;
    /** 模型写的报告。 */
    let report = '';

    //M 2. 常规模型带只读工具看现状，报告 + 结论；卡住了就不等。
    /** 分派用的模型。 */
    const choice = this.resources.getModelChoice('dispatch');
    if (choice?.model) {
      /** 小循环的入参。 */
      const request = {
        model: choice.model,
        thinking: choice.thinking ?? 'low',
        system: this.resources.prompt('dispatch', info.language).text,
        input: `${FORCE_NOTE[info.language]}${text}`,
        tools: this.toolBox.definitions(FORCE_TOOLS),
        toolContext: {
          bot,
          workDir: this.files.paths(bot).botDir,
          readOnly: true,
          vision: false,
        },
        toolBox: this.toolBox,
        maxSteps: 12,
        /**
         * 核对模型回的 JSON（miniLoop.askJson 调）：记下报告；session 是 none 就只报告；
         * 否则用 check 核对，运行中的会话不能追加。
         */
        check: (value: Record<string, unknown>): string | undefined => {
          report = typeof value.report === 'string' ? value.report.trim() : '';
          if (value.session === 'none') {
            decided = null;
            return undefined;
          }
          /** 核对结果。 */
          const result = this.check(value, state, bot);
          if (typeof result === 'string') {
            return result;
          }
          //G 运行中的会话可能就是卡住的那个。
          if (this.store.getSession(result.session)?.status === 'running') {
            return `会话 ${result.session} 在运行，可能就是卡住的那个：要做就新开（session 写 new，还要写工作区、标题、模型）`;
          }
          decided = { ...result, waitFor: undefined };
          return undefined;
        },
        language: info.language,
        purpose: 'dispatch',
        trace: { messageIds: [...record.messageIds] },
      };
      /** 模型的回答；卡住了就不等。 */
      const llm = await Promise.race([
        this.miniLoop.askJson(request),
        Bun.sleep(llmTimeoutMs).then(() => undefined),
      ]);
      if (llm) {
        record.llm = llm;
      } else {
        record.checks.push(`常规模型超过 ${llmTimeoutMs / 1000} 秒还没定下来`);
      }
    }

    //M 3. 模型没定下来：有要做的事就按兜底新开，否则只报告。
    if (decided === undefined) {
      decided = hasTask ? this.fallback(bot, state) : null;
      report ||= '强制分派时模型没定下来，下面是程序看到的。';
    }
    if (decided) {
      record.result = decided;
      await this.gateDecision(bot, state, record, true);
    }
    record.ms = Date.now() - startedAt;

    //M 4. 报告 = 模型写的 + 程序看到的现状。
    /** 给用户看的话。 */
    const fullReport = [report, this.forceSummary(state, waiting)].filter(Boolean).join('\n');
    return { record, report: fullReport, run: decided !== null };
  }


  /**
   * 拼现状（docs/10 5.3）：按“最不常变的在前”排——模型清单 → 模型评价 → 机器人和记忆概要 →
   * 工作区和会话 → 新消息，好让前面几段每次都一样、命中缓存。决策模型和常规模型看到的是同一份。
   * @param bot 机器人。
   * @param messages 这一批新消息。
   * @returns 现状和它的文字。
   */
  private async describe(
    bot: resourcesModule.BotInfo,
    messages: storeModule.MessageRow[],
  ): Promise<{ state: DispatchState; text: string }> {
    /** 模型清单。 */
    const models = this.ai.listModels().filter((item) => item.kind === 'chat');
    /** 模型 ID → 模型。 */
    const byId = new Map(models.map((item) => [item.id, item]));
    /** 会话：最近的在前，最多 20 个，运行中的都列。 */
    const rows = this.store.listSessions(bot.name);
    /** 列出来的会话。 */
    const shown = rows.filter((row, index) => index < MAX_SESSIONS || row.status === 'running');
    /** 文件夹里有的工作区。 */
    const folders = await this.files.listWorkspaces(bot.name);
    /** 工作区：文件夹里有的，加上会话引用了、文件夹还没建的。 */
    const listed = folders.map((workspace) => ({
      name: workspace.name,
      description: workspace.description,
    }));
    for (const row of shown) {
      if (!listed.some((workspace) => workspace.name === row.workspace)) {
        listed.push({ name: row.workspace, description: '' });
      }
    }
    /** 工作区和里面的会话。 */
    const workspaces = listed.map((workspace) => ({
      name: workspace.name,
      description: workspace.description,
      sessions: shown
        .filter((row) => row.workspace === workspace.name)
        .map((row) => sessionLine(row, byId.get(row.model), this.files.sessionFiles(row).compact)),
    }));
    /** 新消息。 */
    const newMessages = messages.map((row) => ({
      id: row.id,
      channel: row.channel,
      source: row.source,
      at: row.createdAt,
      text: row.text,
      images: (row.text.match(IMAGE_PATTERN) ?? []).length,
    }));
    /** 可用的模型。 */
    const modelLines = models.map((item) => ({
      id: item.id,
      vision: item.vision === true,
      contextWindow: item.contextWindow,
      thinking: item.thinking,
      price: item.price,
      limitedUntil: item.limitedUntil,
    }));
    /** 模型评价。 */
    const modelReview = await this.resources.readModelReview();
    /** 机器人的记忆概要。 */
    const memoryIndex = await this.files.readMemoryIndex(bot.name);
    /** 还在等用户决定的命令（只要这个机器人的、已经挂到会话上的）。 */
    const approvals = this.approvals
      .list()
      .filter((item) => item.bot === bot.name && item.sessionId !== '')
      .map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        command: item.command,
        what: item.review.what,
      }));
    /** 现状。 */
    const state: DispatchState = {
      bot: bot.name,
      messages: newMessages,
      models: modelLines,
      modelReview,
      memoryIndex,
      workspaces,
      approvals,
    };

    //M 把现状拼成文字：模型 → 评价 → 机器人 → 工作区和会话 → 待审核 → 新消息。
    /** 各段。 */
    const lines: string[] = ['# 可用的模型', ''];
    for (const item of state.models) {
      /** 被限流时补一句：别选它（选了也是换备用模型在干，网页上显示的就不对了）。 */
      const limited = item.limitedUntil === undefined
        ? ''
        : `；**限流中，${utils.formatTime(item.limitedUntil)} 恢复，先别选**`;
      /** 看图能力。 */
      const visionText = item.vision ? '能看图' : '看不了图';
      /** 价格。 */
      const priceText = `输入 ${item.price.input} / 输出 ${item.price.output} 美元每百万 token`;
      lines.push(
        `- ${item.id}：${visionText}，最大上下文 ${item.contextWindow}，` +
          `思考档位 ${item.thinking.join('/') || '无'}，价格 ${priceText}${limited}`,
      );
    }
    lines.push(
      '',
      '# 模型评价',
      '',
      state.modelReview.trim() || '（还没有）',
      '',
      '# 机器人',
      '',
      `名字：${bot.name}`,
      '',
      '记忆概要：',
      '',
      state.memoryIndex.trim() || '（还没有）',
      '',
      '# 工作区和会话',
    );
    for (const workspace of state.workspaces) {
      lines.push('', `## ${workspace.name}：${workspace.description || '（没写说明）'}`);
      for (const line of workspace.sessions) {
        /** 看图能力。 */
        const visionText = line.vision ? '能看图' : '看不了图';
        lines.push(
          `- ${line.id}「${line.title}」 ${line.status} · ${line.model}（${visionText}，` +
            `已用 ${line.tokens} / 最大 ${line.contextWindow || '?'}）· ` +
            `最后活动 ${utils.formatTime(line.updatedAt)}`,
          `  摘要：${line.summary || '（还没写）'}`,
          `  第一句：${line.firstUser || '（无）'}；最后一句：${line.lastUser || '（无）'}；` +
            `最后回复：${line.lastReply || '（无）'}`,
          `  压缩版：${line.compact}`,
        );
      }
      if (workspace.sessions.length === 0) {
        lines.push('（还没有会话）');
      }
    }
    //M 待审核放在这里，不写进提示词：没有待审核时一个字也不多，缓存也不变。
    if (state.approvals.length > 0) {
      lines.push('', '# 待审核的命令（还没执行，在等用户决定）', '');
      for (const item of state.approvals) {
        /** 命令和做什么，截短。 */
        const brief = `${clip(item.command, 200)}：${clip(item.what, 120)}`;
        lines.push(`- #${item.id} · 会话 ${item.sessionId} · ${brief}`);
      }
      lines.push(
        '',
        '只有新消息真的要等其中一条有结果才能做（比如接着它做下一步、要用它要删的东西），' +
          '才在 JSON 里加 "wait_for": 号，这批就先不做、告诉用户在等什么，用户审核后重新分派。' +
          '和这些命令无关的消息不要写 wait_for，照常分派：别的事不能被审核挡住。',
      );
    }
    lines.push('', '# 新消息');
    for (const message of state.messages) {
      /** 带图时补一句。 */
      const imageText = message.images > 0 ? ` · 带图 ${message.images} 张` : '';
      lines.push(
        '',
        `- #${message.id} · ${message.channel} · 来源 ${message.source} · ` +
          `${utils.formatTime(message.at)}${imageText}`,
        message.text,
      );
    }
    return { state, text: lines.join('\n') };
  }


  /**
   * 第 1 档：决策模型。问“去向”（每个已有会话一项，加“新开”），有会话运行中时再问“打断”。
   * 直接用的条件：去向选的是已有会话且概率 ≥ 0.6；打断 ≥ 0.6 或 ≤ 0.4
   * （要打断的必须就是那个会话、而且它在运行）；带图时那个会话的模型能看图。
   * @param state 现状。
   * @param text 现状的文字。
   * @param record 分派记录（写进 decisionModel）。
   * @returns 结论；拿不准、出错、超时时 undefined（交给第 2 档）。
   * 副作用：调一次决策模型。
   */
  private async askDecisionModel(
    state: DispatchState,
    text: string,
    record: DispatchRecord,
  ): Promise<Decision | undefined> {
    /** 全部会话。 */
    const sessions = state.workspaces.flatMap(
      (workspace) => workspace.sessions.map((line) => ({ ...line, workspace: workspace.name })),
    );
    /** 选项键 → 会话（键不用纯数字，免得 JSON 对象重排）。 */
    const keys = new Map(sessions.map((line, index) => [`s${index + 1}`, line]));
    /** 去向的选项。 */
    const criteria: Record<string, string> = { new: '新的事，开新会话' };
    for (const [key, line] of keys) {
      /** 摘要；没有就用最后一句用户的话。 */
      const brief = clip(line.summary || line.lastUser, 80);
      criteria[key] = `接着「${line.title}」（${line.workspace}；${brief}；${line.status}）`;
    }
    /** 有会话在运行。 */
    const running = sessions.some((line) => line.status === 'running');
    /** 题。 */
    const questions: Record<string, piAi.ClassifierQuestion> = {
      route: {
        type: 'choice',
        instructions: '用户刚发来新消息。它该接着哪个已有会话做，还是一件新的事？',
        criteria,
      },
    };
    if (running) {
      questions.interrupt = INTERRUPT_QUESTION;
    }

    //M 1. 问决策模型，超时当成出错的回答。
    /** 开始时间。 */
    const startedAt = Date.now();
    /** 超时当成出错的回答。 */
    const timedOut: model.DecideOutput = {
      answers: {},
      error: `超过 ${DECISION_TIMEOUT_MS / 1000} 秒没回`,
      ms: DECISION_TIMEOUT_MS,
      request: {
        model: this.resources.getModelChoice('decision')?.model ?? '',
        state: {},
        questions,
      },
    };
    /** 决策模型的入参。 */
    const decideArgs = {
      state: { 现状: text },
      questions,
      purpose: 'dispatch',
      bot: state.bot,
      trace: { messageIds: [...record.messageIds] },
    };
    /** 回答。 */
    const output = await Promise.race([
      this.ai.decide(decideArgs),
      Bun.sleep(DECISION_TIMEOUT_MS).then(() => timedOut),
    ]);

    //M 2. 把回答整理成每个选项的概率，先记进分派记录。
    /** 去向的回答。 */
    const route = output.answers.route;
    /** 打断的回答。 */
    const interruptAnswer = output.answers.interrupt;
    /** 每个选项的概率。 */
    const options = Object.entries(criteria).map(([key, label]) => ({
      label,
      session: key === 'new' ? 'new' : (keys.get(key)?.id ?? key),
      probability: route?.type === 'choice' ? (route.probabilities[key] ?? 0) : 0,
    }));
    /** 打断的概率。 */
    const interrupt = interruptAnswer?.type === 'bool' ? interruptAnswer.probability : undefined;
    record.decisionModel = {
      model: output.request.model,
      ms: Date.now() - startedAt,
      error: output.error,
      question: questions.route!.instructions,
      options,
      ...(running ? { interruptQuestion: INTERRUPT_QUESTION.instructions } : {}),
      interrupt,
      used: false,
      why: '',
      state: text,
    };

    //M 3. 判定：都满足才直接用。
    /** 概率最高的选项。 */
    const best = [...options].sort((left, right) => right.probability - left.probability)[0];
    /** 选中的会话。 */
    const chosen = best && best.session !== 'new'
      ? sessions.find((line) => line.id === best.session)
      : undefined;
    /** 带图。 */
    const hasImages = state.messages.some((message) => message.images > 0);
    /** 没用的原因。 */
    let why = '';
    if (output.error) {
      why = `出错：${output.error}`;
    } else if (!best || !chosen) {
      why = '去向选的是新开（新开要挑工作区和模型），交给常规模型';
    } else if (best.probability < SURE) {
      why = `去向最高 ${best.probability.toFixed(2)}，没到 ${SURE}，拿不准`;
    } else if (interrupt !== undefined && interrupt > 1 - SURE && interrupt < SURE) {
      why = `打断 ${interrupt.toFixed(2)}，拿不准`;
    } else if (interrupt !== undefined && interrupt >= SURE && chosen.status !== 'running') {
      why = '要打断的不是选中的那个会话，交给常规模型';
    } else if (hasImages && !chosen.vision) {
      why = '消息带图，那个会话的模型看不了图，要换模型';
    }
    if (why || !chosen || !best) {
      record.decisionModel.why = why;
      return undefined;
    }

    //M 4. 有把握：直接用，打断的话只打断选中的这个会话。
    /** 打断吗。 */
    const stop = interrupt !== undefined && interrupt >= SURE;
    /** 打断那一问的说明；没问就没有。 */
    const interruptText = interrupt === undefined
      ? ''
      : `；打断${stop ? '“是”' : '“否”'} ${interrupt.toFixed(2)}`;
    record.decisionModel.used = true;
    record.decisionModel.why =
      `去向选「${chosen.title}」${best.probability.toFixed(2)} ≥ ${SURE}${interruptText}，都有把握，直接用`;
    return {
      interrupt: stop ? [chosen.id] : [],
      workspace: chosen.workspace,
      workspaceDescription: '',
      session: chosen.id,
      title: '',
      model: '',
      thinking: '',
      reason: record.decisionModel.why,
      by: 'decision',
    };
  }


  /**
   * 报分派结论 dispatch.decided（docs/11_附 第 3.4 节）。挂了拦处理器时先问：它给了新结论，就当成模型回的 JSON
   * 用 check 再核一遍，过了才用，不过就丢掉、写进 record.checks 和日志。默认没人挂，等于只报，不等。
   * @param bot 机器人名。
   * @param state 分派看到的现状（check 要用）。
   * @param record 分派记录：用了新结论就改它的 result、checks。
   * @param force 是不是强制分派那条路。
   * 副作用：记事件；可能改 record。
   */
  private async gateDecision(bot: string, state: DispatchState, record: DispatchRecord, force: boolean): Promise<void> {
    /** 原结论。 */
    const result = record.result;
    /** 事件的数据。 */
    const data = {
      session: result.session,
      workspace: result.workspace,
      model: result.model,
      interrupt: result.interrupt,
      waitFor: result.waitFor,
      by: result.by,
      ms: Date.now() - record.startedAt,
      startedAt: record.startedAt,
      endedAt: Date.now(),
      defaultModel: this.resources.getDefaultModel() ?? null,
      reason: result.reason,
      checks: record.checks.length,
      checkReasons: [...record.checks],
      decisionModel: record.decisionModel ? {
        model: record.decisionModel.model,
        ms: record.decisionModel.ms,
        used: record.decisionModel.used,
        why: record.decisionModel.why,
        error: record.decisionModel.error,
      } : null,
      llm: record.llm ? {
        model: record.llm.request.model,
        error: record.llm.error,
        steps: record.llm.steps.length,
      } : null,
      force,
      messageIds: record.messageIds,
    };
    /** 属于谁。 */
    const options = { source: 'Dispatch', bot, messageId: record.messageIds.at(-1) };
    //G 没人挂拦处理器：只报，不 await。
    if (!this.events.hasGate('dispatch.decided')) {
      this.events.emit('dispatch.decided', data, options);
      return;
    }
    /** 拦处理器的回答。 */
    const answer = await this.events.gate('dispatch.decided', { ...data, decision: { ...result } }, options);
    if (!answer.decision) {
      return;
    }
    /** 新结论核对的结果。 */
    const checked = this.check(answer.decision, state, bot);
    if (typeof checked === 'string') {
      record.checks.push(`拦处理器（${answer.by ?? '?'}）给的结论没过核对，仍用原结论：${checked}`);
      console.error(`${utils.formatTime()} dispatch.decided 的拦处理器结论没过核对：${checked}`);
      return;
    }
    record.result = { ...checked, by: result.by };
    record.checks.push(`结论被拦处理器（${answer.by ?? '?'}）改过`);
  }

  /** 开始分派的观察记录，默认值和实际选择始终分开。 */
  private reportStarted(bot: string, record: DispatchRecord, force: boolean): void {
    const data = {
      messageIds: [...record.messageIds],
      startedAt: record.startedAt,
      force,
      trigger: force ? 'force' : 'batch',
      defaultModel: this.resources.getDefaultModel() ?? null,
      dispatchModel: this.resources.getModelChoice('dispatch')?.model ?? null,
      decisionModel: this.resources.getModelChoice('decision')?.model ?? null,
    };
    this.events.emit('dispatch.started', data, {
      source: 'Dispatch',
      bot,
      messageId: record.messageIds.at(-1),
    });
  }

  /** 分派真正读取的现状，只记录引用与短片段，不写整份状态或系统提示词。 */
  private reportContext(bot: string, state: DispatchState, chars: number, messageIds: number[]): void {
    const sessions = state.workspaces.flatMap((workspace) => workspace.sessions);
    const data = {
      messageIds: [...messageIds],
      chars,
      messages: state.messages.map((message) => ({
        id: message.id,
        at: message.at,
        chars: message.text.length,
        text: utils.truncate(message.text, 200),
        images: message.images,
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        summary: utils.truncate(session.summary, 120),
      })),
      memoryIndexChars: state.memoryIndex.length,
      modelReviewChars: state.modelReview.length,
      availableModels: state.models.length,
      pendingApprovals: state.approvals.length,
    };
    this.events.emit('dispatch.context', data, {
      source: 'Dispatch',
      bot,
      messageId: messageIds.at(-1),
    });
  }


  /**
   * 核对常规模型回的结论：会话是这个机器人的、要打断的确实在运行、模型在清单里、带图时模型能看图、
   * 新开有标题和模型。
   * @param value 模型回的 JSON。
   * @param state 现状。
   * @param bot 机器人名。
   * @returns 结论，或者哪里不对。
   */
  private check(
    value: Record<string, unknown>,
    state: DispatchState,
    bot: string,
  ): Decision | string {
    /** 字符串字段。 */
    const text = (key: string): string => {
      const field = value[key];
      return typeof field === 'string' ? field.trim() : '';
    };
    /** 会话 ID 或 new。 */
    const session = text('session');
    /** 工作区。 */
    const workspace = text('workspace');
    /** 模型。 */
    const modelId = text('model');
    /** 要等的待确认。 */
    const waitFor = typeof value.wait_for === 'number' ? value.wait_for : undefined;
    if (waitFor !== undefined) {
      /** 要等的待确认确实在待审核里。 */
      const waitOk = state.approvals.some((item) => item.id === waitFor);
      if (!waitOk) {
        return `wait_for 写的 #${waitFor} 不在待审核的命令里；不用等就去掉它`;
      }
      return {
        interrupt: [],
        workspace: '',
        workspaceDescription: '',
        session: 'new',
        title: '',
        model: '',
        thinking: '',
        reason: text('reason'),
        waitFor,
        by: 'llm',
      };
    }
    /** 要打断的。 */
    const interrupt = Array.isArray(value.interrupt)
      ? value.interrupt.filter(
          (item): item is string => typeof item === 'string' && item.length > 0,
        )
      : [];
    /** 这个机器人的会话。 */
    const own = new Map(this.store.listSessions(bot).map((row) => [row.id, row]));
    /** 模型清单。 */
    const models = new Map(state.models.map((item) => [item.id, item]));
    /** 带图。 */
    const images = state.messages.some((message) => message.images > 0);
    if (!session) {
      return 'session 要写 new 或者一个会话 ID';
    }
    if (session !== 'new' && !own.has(session)) {
      return `会话 ${session} 不是这个机器人的`;
    }
    if (!workspace || /[\\/:*?"<>|]|\.$/.test(workspace)) {
      return 'workspace 要写一个工作区名（一层文件夹名，不能带 \\ / : * ? " < > | ，不能以点结尾）';
    }
    for (const id of interrupt) {
      if (own.get(id)?.status !== 'running') {
        return `要打断的 ${id} 不在运行中`;
      }
    }
    if (session === 'new' && !text('title')) {
      return '新开会话要写 title';
    }
    if (session === 'new' && !modelId) {
      return '新开会话要写 model';
    }
    if (modelId && !models.has(modelId)) {
      return `模型 ${modelId} 不在可用的模型里`;
    }
    /** 最后用的模型。 */
    const finalModel = modelId || own.get(session)?.model || '';
    if (images && finalModel && models.get(finalModel)?.vision !== true) {
      return `消息带图，${finalModel} 看不了图，要挑能看图的模型`;
    }
    return {
      interrupt,
      workspace: session === 'new' ? workspace : (own.get(session)?.workspace ?? workspace),
      workspaceDescription: text('workspace_description'),
      session,
      title: text('title'),
      model: modelId,
      thinking: text('thinking'),
      reason: text('reason'),
      by: 'llm',
    };
  }


  /**
   * 第 2 档：常规模型的小循环（系统提示词“00_base_dsh.md + 分派提示词”，现状是第一条输入，
   * 带只读工具，最多 6 步，核对不过重跑 2 次）。
   * @param bot 机器人。
   * @param state 现状。
   * @param text 现状的文字。
   * @param record 分派记录（写进 llm 和 checks）。
   * @returns 结论；没成时 undefined。
   * 副作用：调模型；读机器人文件夹。
   */
  private async askModel(
    bot: resourcesModule.BotInfo,
    state: DispatchState,
    text: string,
    record: DispatchRecord,
  ): Promise<Decision | undefined> {
    /** 分派用的模型。 */
    const choice = this.resources.getModelChoice('dispatch');
    if (!choice?.model) {
      record.checks.push('没配分派的模型（models.dispatch），也没有 default_model');
      return undefined;
    }
    /** 核对通过的结论。 */
    let decided: Decision | undefined;
    /** 小循环的入参。 */
    const request = {
      model: choice.model,
      thinking: choice.thinking ?? 'low',
      system: this.resources.prompt('dispatch', bot.language).text,
      input: text,
      tools: this.toolBox.definitions(tools.TOOL_NAMES.dispatch),
      toolContext: {
        bot: bot.name,
        workDir: this.files.paths(bot.name).botDir,
        readOnly: true,
        vision: false,
      },
      toolBox: this.toolBox,
      maxSteps: 6,
      /** 核对模型回的 JSON（miniLoop.askJson 调）：不过的原因记进 record.checks。 */
      check: (value: Record<string, unknown>): string | undefined => {
        /** 核对结果。 */
        const result = this.check(value, state, bot.name);
        if (typeof result === 'string') {
          record.checks.push(result);
          return result;
        }
        decided = result;
        return undefined;
      },
      language: bot.language,
      purpose: 'dispatch',
      trace: { messageIds: [...record.messageIds] },
    };

    //M 跑小循环；模型回的 JSON 核对通过才算数。
    record.llm = await this.miniLoop.askJson(request);
    return record.llm.value ? decided : undefined;
  }


  /**
   * 程序兜底：新开会话，放进最近用过的工作区（没有就“日常”），用默认模型
   * （带图而它看不了图，就换清单里第一个能看图的），谁也不打断。
   * @param bot 机器人名。
   * @param state 现状。
   * @returns 结论。
   */
  private fallback(bot: string, state: DispatchState): Decision {
    /** 最近用过的工作区。 */
    const workspace = this.store.listSessions(bot)[0]?.workspace ?? '日常';
    /** 默认模型。 */
    let modelId = this.resources.getDefaultModel() ?? state.models[0]?.id ?? '';
    /** 带图。 */
    const hasImages = state.messages.some((message) => message.images > 0);
    if (hasImages && !state.models.find((item) => item.id === modelId)?.vision) {
      modelId = state.models.find((item) => item.vision)?.id ?? modelId;
    }
    return {
      interrupt: [],
      workspace,
      workspaceDescription: '',
      session: 'new',
      title: '（未命名）',
      model: modelId,
      thinking: '',
      reason: '决策模型和常规模型都没定下来，程序兜底',
      by: 'fallback',
    };
  }


  /**
   * 程序自己写的现状：模型连不上时用户也能看到卡在哪。
   * @param state 现状。
   * @param waiting 还没进会话的消息。
   */
  private forceSummary(state: DispatchState, waiting: storeModule.MessageRow[]): string {
    /** 运行中的会话。 */
    const running = state.workspaces
      .flatMap((workspace) => workspace.sessions)
      .filter((line) => line.status === 'running');
    /** 运行中会话的标题。 */
    const runningTitles = running.map((line) => `「${line.title}」`).join('');
    /** 待审核的号。 */
    const approvalIds = state.approvals.map((item) => `#${item.id}`).join('、');
    return [
      `运行中的会话 ${running.length} 个${running.length > 0 ? `：${runningTitles}` : ''}`,
      `待审核 ${state.approvals.length} 条${state.approvals.length > 0 ? `：${approvalIds}` : ''}`,
      `还没进会话的消息 ${waiting.length} 条`,
    ].join('；');
  }
}
