/**
 * 会话循环（docs/10 5.4、5.5、6.12）：常规的 agent loop。两个类：
 *   SessionRunner：一个进程一个，所有会话共用；runSession 做准备（读会话、beginRun、建 RunState），
 *     再建一个 SessionRun 去跑。
 *   SessionRun：一次运行建一个，状态（RunState）存成字段；run 是主循环：
 *   ① 收插话（几条合成一条用户消息；会话第一条输入前面加“这个会话”和记忆概要）+ 自动感应
 *   ② 压缩检查 → ③ 调模型 → ④ 有工具调用：一个个执行，每个执行前看有没有人打断，exec 先过审核 → 回 ①
 *   ⑤ 没有工具调用：有插话回 ①；被打断就停；否则没 reply 过就把这次的回答发出去（兜底），
 *     结束这次运行
 * 一次运行最多 max_rounds 步（默认 300）。数据库是真相：每一步重新读会话（分派可能换了模型、
 * summary 改了标题），只写回循环自己管的字段（对话、上下文长度、回复给谁、运行记录、感应点），
 * 写完照数据库重写会话文件。从不抛错。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as recallModule from '../capabilities/Recall.ts';
import * as tools from '../capabilities/tools/Tools.ts';
import * as debug from '../utils/Debug.ts';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import * as contextFit from './ContextFit.ts';
import * as replyEvidence from '../capabilities/ReplyEvidence.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import type * as contextModule from '../capabilities/Context.ts';
import type * as depsModule from '../capabilities/Deps.ts';
import type * as eventsModule from '../capabilities/Events.ts';
import type * as filesModule from '../capabilities/Files.ts';
import type * as model from '../capabilities/Model.ts';
import type * as progressModule from '../capabilities/Progress.ts';
import type * as storeModule from '../capabilities/Store.ts';
import type * as resourcesModule from '../resources/Resources.ts';
import type * as execReview from './ExecReview.ts';


/** 一次运行里的临时状态，不进数据库。 */
export interface RunState {
  /** 会话（每一步重新从数据库读）。 */
  session: storeModule.SessionRow;
  /** 机器人。 */
  bot: resourcesModule.BotInfo;
  /** 工作目录。 */
  workDir: string;
  /** 这是第几次运行。 */
  run: number;
  /** 这次运行调了几次模型（到 max_rounds 就停）。 */
  rounds: number;
  /** 从最后一条用户消息以来 reply 过没有（没有的话，结束时把最后的回答发出去）。 */
  replied: boolean;
  /** 上下文涨到多少再考虑压缩。 */
  nextCompressAt: number;
  /** 本次运行的起点事件号，只用于只读追踪；记录失败时没有。 */
  runEventId?: number;
  /** 最近一次真正送出请求的上下文事件号。 */
  contextEventId?: number;
  /** 当前观察轮的来源，只影响展示，不改变执行的 replied 或轮询分支。 */
  turnMessageIds?: number[];
  /** 当前观察轮是否已经成功记录过回复；新输入到来后才开始下一轮。 */
  turnReplied?: boolean;
  /** 当前观察轮开始的持久事件号，供只读范围使用。 */
  turnEventId?: number;
  /** 最近一次成功常规生成的安全快照；压缩/审核不能覆盖。 */
  generation?: storeModule.ReplyGeneration;
  /** 上述生成对应的输入快照，多句工具回复共享。 */
  association?: storeModule.ReplyAssociation;
}


/** 模型清单里查到的几项。 */
interface ModelInfo {
  /** 能不能看图。 */
  vision: boolean;
  /** 上下文上限，token。 */
  contextWindow: number;
  /** 能用的思考档。 */
  thinking: string[];
}


/** 拼好的一次请求（buildRequest 的结果）。 */
interface BuiltRequest {
  /** 系统提示词积木。 */
  system: Record<string, string>;
  /** 系统提示词全文。 */
  systemText: string;
  /** 用到的提示词文件。 */
  promptFiles: string[];
  /** 技能个数。 */
  skills: number;
  /** 这次要送的对话。 */
  messages: piAi.Message[];
  /** 能用的工具。 */
  tools: piAi.Tool[];
  /** 请求上下文是否经历预算裁剪；保存的是这次请求的实际状态。 */
  fitted: boolean;
}


/** 程序写进对话的几句话（docs/10 7.4）。 */
const WORDS = {
  zh: {
    channel: (kind: string) => ({ feishu: '飞书', http: 'HTTP' })[kind] ?? kind,
    header: (channel: string, time: string, id: number) => `[${channel} · ${time} · 消息 #${id}]`,
    session: (session: storeModule.SessionRow, description: string, workDir: string) => {
      return `# 这个会话\n\n会话 ID：${session.id}；标题：${session.title}；`
        + `工作区：${session.workspace}${description ? `（${description}）` : ''}；`
        + `工作目录：${workDir}`;
    },
    memory: (index: string) => {
      return '# 记忆概要（memory/索引.md，开会话时的样子；要细节用 memory 搜或读）\n\n'
        + `${index.trim() || '（还没有）'}`;
    },
    user: '# 用户的消息',
    interrupted: '未执行：用户在你执行前打断了，见下一条用户消息。',
    unknown: '结果未知：程序重启时这个工具正在执行，可能做了也可能没做；'
      + '先查实际情况再决定要不要重做。',
    mustCompress: '（系统）请把以上对话压缩成一段摘要：目标、做过的、定下的决定、'
      + '读过和改过的文件、没做完的、用户的偏好和纠正。只回摘要本身。',
    mayCompress: (tokens: number, at: number) => {
      return `（系统）上下文已经 ${tokens} token，超过 ${at}。`
        + '如果前面的对话可以压缩，请调用 summary 并把 compress 设为 true；'
        + '不需要就忽略这句，接着做。';
    },
    summaryHead: '（以下是前面对话的摘要）',
    limit: (rounds: number) => `走了 ${rounds} 步还没做完，先停在这里；回“继续”接着做。`,
    modelError: (reason: string) => `模型出错了：${reason}`,
    notExecuted: (reason: string) => `未执行：${reason}`,
    pending: (id: number) => {
      return `已提交审核，还没执行（待确认 #${id}），在等用户决定。`
        + '用户决定后会有一条消息告诉你结果，不要重新调用这条命令。'
        + '依赖这条命令结果的事先别做，别的事照常做；'
        + '没别的事就结束，不用再提醒用户确认，卡片已经发给用户了。';
    },
    approved: (id: number, by: string, command: string, result: string) => {
      return `（系统）待确认 #${id}：用户同意了（${by}），命令已经执行。\n`
        + `命令：${command}\n结果：\n${result}`;
    },
    rejected: (id: number, by: string, command: string) => {
      return `（系统）待确认 #${id}：用户拒绝了（${by}），命令没有执行。\n命令：${command}`;
    },
    sense: (from: string, to: string, lines: string[]) => {
      return `（系统）自动感应：${from}～${to} 之间有这些变化。\n${lines.join('\n')}\n`
        + '和手上的事有关就去看（memory 读、session_list），无关就接着做。';
    },
    senseMemory: (items: string[]) => `记忆：${items.join('；')}。`,
    senseNew: (workspace: string, titles: string[]) => {
      return `工作区「${workspace}」：新开了会话${titles.map((title) => `「${title}」`).join('')}。`;
    },
    senseProgress: (title: string, summary: string) => {
      return `会话「${title}」有新进展：${summary || '（还没写摘要）'}`;
    },
    skills: (lines: string[]) => {
      return '# 技能\n\nskills/ 下的技能。要做的事对得上哪个，先 read 它的 SKILL.md 再照着做：\n'
        + lines.join('\n');
    },
    toolImages: '（上面工具读到的图）',
  },
  en: {
    channel: (kind: string) => kind,
    header: (channel: string, time: string, id: number) => {
      return `[${channel} · ${time} · message #${id}]`;
    },
    session: (session: storeModule.SessionRow, description: string, workDir: string) => {
      return `# This session\n\nSession ID: ${session.id}; title: ${session.title}; `
        + `workspace: ${session.workspace}${description ? ` (${description})` : ''}; `
        + `working directory: ${workDir}`;
    },
    memory: (index: string) => {
      return '# Memory summary (memory/index.md, as of when this session started; '
        + 'search or read memory for details)\n\n'
        + `${index.trim() || '(nothing yet)'}`;
    },
    user: '# User message',
    interrupted: 'Not executed: interrupted by the user before it ran; see the next user message.',
    unknown: 'Result unknown: the program restarted while this tool was running; '
      + 'it may or may not have taken effect. Check before redoing it.',
    mustCompress: '(system) Compress the conversation above into one summary: the goal, '
      + 'what was done, decisions made, files read and changed, what is unfinished, '
      + "the user's preferences and corrections. Reply with the summary only.",
    mayCompress: (tokens: number, at: number) => {
      return `(system) The context is ${tokens} tokens, past ${at}. `
        + 'If the earlier conversation can be compressed, call summary with compress set to true; '
        + 'otherwise ignore this and carry on.';
    },
    summaryHead: '(Summary of the earlier conversation)',
    limit: (rounds: number) => {
      return `Stopped after ${rounds} steps without finishing; reply "continue" to go on.`;
    },
    modelError: (reason: string) => `The model failed: ${reason}`,
    notExecuted: (reason: string) => `Not executed: ${reason}`,
    pending: (id: number) => {
      return `Submitted for review, not run yet (pending #${id}); waiting for the user. `
        + 'A message will tell you the result once they decide, so do not call this command again. '
        + 'Hold off on anything that depends on its result and carry on with the rest; '
        + 'if nothing else is left, finish without reminding the user, who already has the card.';
    },
    approved: (id: number, by: string, command: string, result: string) => {
      return `(system) Pending #${id}: the user approved (${by}) and the command has run.\n`
        + `Command: ${command}\nResult:\n${result}`;
    },
    rejected: (id: number, by: string, command: string) => {
      return `(system) Pending #${id}: the user rejected it (${by}); the command did not run.\n`
        + `Command: ${command}`;
    },
    sense: (from: string, to: string, lines: string[]) => {
      return `(system) Auto-sense: changes between ${from} and ${to}.\n${lines.join('\n')}\n`
        + 'Look if it matters to your task; otherwise carry on.';
    },
    senseMemory: (items: string[]) => `Memory: ${items.join('; ')}.`,
    senseNew: (workspace: string, titles: string[]) => {
      /** 加了引号的会话标题。 */
      const quoted = titles.map((title) => `"${title}"`).join(', ');
      return `Workspace "${workspace}": new session ${quoted}.`;
    },
    senseProgress: (title: string, summary: string) => {
      return `Session "${title}" made progress: ${summary || '(no summary yet)'}`;
    },
    skills: (lines: string[]) => {
      return '# Skills\n\nSkills under skills/. When your task matches one, '
        + `read its SKILL.md first and follow it:\n${lines.join('\n')}`;
    },
    toolImages: '(Image(s) read by the tool above)',
  },
};


/** 决策模型的是非题“压缩”（docs/10 7.3）。 */
const COMPRESS_QUESTION: piAi.ClassifierBoolQuestion = {
  type: 'bool',
  instructions:
    '这个会话的上下文已经很长。现在把前面的对话压缩成摘要，'
    + '会不会丢掉接下来马上要用的原文？不会丢、可以压，回答“是”。',
  criteria: { true: '可以压', false: '先别压' },
};


/** “这次不压”之后，上下文再涨这么多才再问。 */
const COMPRESS_AGAIN_TOKENS = 50_000;


/** 图片扩展名 → MIME。 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};


/**
 * 模型清单里的这个模型。
 * @param parts 用到模型库（ai）。
 * @param model 模型 ID。
 */
function modelInfo(parts: Pick<RunnerParts, 'ai'>, model: string): ModelInfo | undefined {
  /** 清单里的。 */
  const found = parts.ai.listModels().find((item) => item.id === model);
  if (!found) {
    return undefined;
  }
  return {
    vision: found.vision === true,
    contextWindow: found.contextWindow,
    thinking: found.thinking,
  };
}


/**
 * 工具参数的摘要（tool.before 用）：每个参数名留着，值转成文字只留前 80 字。
 * @param args 工具参数。
 * @returns 参数名 → 前 80 字。
 */
function argsBrief(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, utils.truncate(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 80)]),
  );
}


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
 * 撤掉这些消息上的“正在输入”：这次运行收到的消息，再加最近那条（重启接着跑时，它是上一次运行收的）。
 * 不属于某一次运行的状态（出错收尾时 RunState 可能还没建），所以留在类外。
 * @param parts 用到数据库（取收件）和渠道出口（撤“正在输入”）。
 * @param session 会话。
 * @param run 第几次运行。
 * @returns 无；撤不掉只打日志。
 * 副作用：调渠道。
 */
function stopTyping(parts: Pick<RunnerParts, 'store' | 'out'>, session: storeModule.SessionRow, run: number): void {
  /** 这次运行收的消息号。 */
  const runIds = session.messages
    .filter((stored) => stored.run === run)
    .flatMap((stored) => stored.messageIds ?? []);
  /** 要撤的消息号。 */
  const ids = new Set([...runIds, ...(session.replyTo === null ? [] : [session.replyTo])]);
  for (const id of ids) {
    /** 这条收件。 */
    const row = parts.store.getMessage(id);
    if (!row) {
      continue;
    }
    void parts.out.stopTyping?.(row.channel, row.address).catch((error: unknown) => {
      console.error(`消息 #${id} 的“正在输入”没撤掉：${utils.errorText(error)}`);
    });
  }
}


/**
 * 会话循环要用的对象：入口 src/entries/App.ts 建好交给 SessionRunner，SessionRunner 原样交给每一次 SessionRun；
 * 测试用 tests/Builders.ts 的 runnerOf 建。
 */
export interface RunnerParts {
  /** 资源：配置、机器人、提示词（只读）。 */
  resources: resourcesModule.Resources;
  /** 数据库：会话、收件。 */
  store: storeModule.Store;
  /** 文件库：会话文件、消息文件、记忆、技能。 */
  files: filesModule.Files;
  /** 模型库：每一步调模型、压缩时问决策模型。 */
  ai: model.Ai;
  /** 往渠道发东西：渠道中心 ChannelHub（src/channels/index.ts），撤“正在输入”用。 */
  out: depsModule.Outlet;
  /** 进度卡片（src/capabilities/Progress.ts）；由入口构造并传入。 */
  progress: progressModule.Progress;
  /** 命令审核（src/executors/ExecReview.ts 的 ExecReviewer）：exec 执行前先审。 */
  reviewer: execReview.ExecReviewer;
  /** 工具库（src/capabilities/tools/Tools.ts 的 ToolBox）：模型调的工具、工具定义都从它取。 */
  toolBox: tools.ToolBox;
  /** 记忆库搜索（src/capabilities/Context.ts 的 MemorySearch）：开场召回用。 */
  memorySearch: contextModule.MemorySearch;
  /** 事件总线（src/capabilities/Events.ts 的 EventBus）：在断点上报事件（docs/11 第 5.2 节）；由入口构造并传入。 */
  events: eventsModule.EventBus;
}


/**
 * 会话运行器：一个进程一个，所有会话共用。runSession 做准备，再建一个 SessionRun 去跑。
 */
export class SessionRunner {
  /**
   * @param parts 会话循环要用的对象（见 RunnerParts，入口 src/entries/App.ts 建的）。
   */
  constructor(private readonly parts: RunnerParts) {}


  /**
   * 跑一个会话：开始一次运行，一步一步做到模型不再调工具（或者被打断、到上限、出错）。
   * 已经在运行就立刻返回（新排给它的话由正在跑的那一次收走）。
   * @param sessionId 会话 ID。
   * @returns 无；从不抛错。
   * 副作用：调模型、执行工具、发回复、写库、写会话文件。
   */
  async runSession(sessionId: string): Promise<void> {
    /** 停用机器人不能先 beginRun 再报错；历史任务与重启恢复同样经过此边界。 */
    const requested = this.parts.store.getSession(sessionId);
    if (requested && !this.parts.resources.listBots().some((bot) => bot.name === requested.bot)) {
      console.error(`会话 ${sessionId} 所属机器人未启用，不开始运行`);
      return;
    }
    //G 开不了（已经在运行、数据库出错）：不往下走。
    try {
      if (!this.parts.store.beginRun(sessionId)) {
        return;
      }
    } catch (error) {
      console.error(`会话 ${sessionId} 开不了：${utils.errorText(error)}`);
      return;
    }
    try {
      //M 准备：机器人、工作目录、第几次运行、压缩阈值，建这次运行的状态。
      /** 会话。 */
      const session = this.parts.store.getSession(sessionId)!;
      /** 机器人。 */
      const bot = this.parts.resources.getBot(session.bot);
      /** 机器人的工作区。 */
      const workspaces = await this.parts.files.listWorkspaces(bot.name);
      /** 会话的工作区。 */
      const workspace = workspaces.find((item) => item.name === session.workspace)
        ?? (await this.parts.files.ensureWorkspace(bot.name, session.workspace, ''));
      /** 模型。 */
      const model = modelInfo(this.parts, session.model);
      /** 压缩阈值：模型上限不到 250K 时用上限的 80%。 */
      const compressAt = model && model.contextWindow > 0 && model.contextWindow < 250_000
        ? Math.floor(model.contextWindow * 0.8)
        : this.parts.resources.getSetting('compressAt');
      /** 回复给的那条消息。 */
      const replyRow = session.replyTo === null
        ? undefined
        : this.parts.store.getMessage(session.replyTo);
      /** 运行状态。replied 看数据库：回复给的那条消息回过没有，重启接着跑时也算得对；新话进来时 takeInsertions 再改。 */
      const state: RunState = {
        session,
        bot,
        workDir: workspace.dir,
        run: session.runs.at(-1)?.n ?? 1,
        rounds: 0,
        replied: session.replyTo === null || (replyRow?.replies.length ?? 0) > 0,
        nextCompressAt: compressAt,
        turnMessageIds: [],
        turnReplied: false,
      };
      /** 重启补发只恢复保存的助手证据，不能拿此时会话的 model/thinking 冒充生成设置。 */
      const last = session.messages.at(-1);
      if (replyRow && last?.message.role === 'assistant') {
        const syntheticReply: storeModule.Reply = {
          at: Date.now(),
          session: { id: session.id, title: session.title, file: '' },
          text: textOf(last.message).trim(),
          generation: last.generation,
          association: last.association,
        };
        const recovered = new replyEvidence.ReplyEvidenceReader(this.parts.store).read(replyRow, syntheticReply);
        state.generation = recovered.generation;
        state.association = recovered.association;
      }
      /** ⑥ 打印点要看的字段。 */
      const startFields = () => ({
        session: sessionId,
        run: state.run,
        model: session.model,
        messages: session.messages.length,
        tokens: session.tokens,
      });
      await debug.point('⑥ 会话开始一次运行', startFields);

      //M 建一次运行去跑。
      /** 这一次运行。 */
      const sessionRun = new SessionRun(this.parts, state, this);
      await sessionRun.run();
    } catch (error) {
      //G 程序自己的毛病：会话标成出错，这次运行记成出错，不往外抛。
      console.error(`会话 ${sessionId} 出错：${utils.errorText(error)}`);
      this.markError(sessionId, error);
    }
  }


  /**
   * 程序自己出了毛病：会话标成出错，最后一次运行记成出错，撤“正在输入”，进度卡片收尾。
   * @param sessionId 会话 ID。
   * @param error 原因。
   * @returns 无；数据库也坏了就只能留在日志里。
   * 副作用：写库、调渠道。
   */
  private markError(sessionId: string, error: unknown): void {
    try {
      /** 会话。 */
      const session = this.parts.store.getSession(sessionId);
      if (!session) {
        return;
      }
      /** 最后一次运行记成出错。 */
      const runs = session.runs.map((run, index) => {
        if (index === session.runs.length - 1 && !run.ending) {
          return { ...run, endedAt: Date.now(), ending: 'error' as const };
        }
        return run;
      });
      this.parts.store.updateSession(sessionId, { status: 'error', runs });
      stopTyping(this.parts, session, session.runs.at(-1)?.n ?? 0);
      this.parts.progress.ended(sessionId, 'error', utils.errorText(error));
      this.parts.events.emit(
        'run.ended',
        { run: session.runs.at(-1)?.n ?? 0, ending: 'error', error: utils.truncate(utils.errorText(error), 500) },
        { source: 'AgentLoop', bot: session.bot, sessionId },
      );
    } catch {
      // 数据库也坏了就只能留在日志里。
    }
  }
}


/**
 * 一次运行：状态存在 state 字段里（调试时点开 this 就能看到），run 是主循环。
 * 由 SessionRunner.runSession 建，跑完就丢。
 */
export class SessionRun {
  /**
   * @param parts 会话循环要用的对象（见 RunnerParts，SessionRunner 原样传下来的）。
   * @param state 这次运行的状态（SessionRunner.runSession 准备好的）。
   * @param runner 会话运行器：用户决定了挂起的命令以后，afterDecision 用它接着跑会话。
   */
  constructor(
    private readonly parts: RunnerParts,
    private readonly state: RunState,
    private readonly runner: SessionRunner,
  ) {}


  /**
   * 主循环：一步一步做到模型不再调工具（或者被打断、到上限、出错）。
   * @returns 无；从不抛错的约定由 SessionRunner.runSession 兜住。
   * 副作用：调模型、执行工具、发回复、写库、写会话文件。
   */
  async run(): Promise<void> {
    const state = this.state;
    const sessionId = state.session.id;
    //M 补上次被切断的工具。
    if (this.repairCut() > 0) {
      await this.save();
    }
    /** 运行起点来自本次持久记录，不用会话号或墙钟猜。 */
    const started = this.report('run.started', {
      model: state.session.model,
      workDir: state.workDir,
      startedAt: state.session.runs.at(-1)?.startedAt,
    });
    state.runEventId = started?.id;
    /** 一次运行最多几步。 */
    const maxRounds = this.parts.resources.getSetting('maxRounds');

    for (;;) {
      //M ① 重新读会话（分派可能换了模型、summary 改了标题），收插话，自动感应。
      state.session = {
        ...this.parts.store.getSession(sessionId)!,
        messages: state.session.messages,
        tokens: state.session.tokens,
        replyTo: state.session.replyTo,
        sensedAt: state.session.sensedAt,
      };
      /** 收了几条。 */
      const inserted = await this.takeInsertions();
      /** 有没有变化。 */
      const sensed = await this.sense(inserted > 0);
      if (inserted > 0 || sensed) {
        await this.save();
      }
      //G 没有要回应的（最后一条是助手的回答）：这次运行结束。重启前模型答完了、还没发出去的，这里补发。
      /** 最后一条。 */
      const last = state.session.messages.at(-1)?.message;
      if (!last || last.role === 'assistant') {
        if (await this.finish('done', last ? textOf(last) : '')) {
          return;
        }
        continue;
      }
      if (state.rounds >= maxRounds) {
        if (await this.finish('limit')) {
          return;
        }
        continue;
      }

      //M ② 压缩检查，③ 调模型。这一步刚收的话不压进摘要：压完接在摘要后面，模型看到的还是原话。
      /** 这一步刚收的话。 */
      const fresh = inserted > 0 ? state.session.messages.pop() : undefined;
      await this.maybeCompress();
      if (fresh) {
        state.session.messages.push(fresh);
      }
      this.report('step.before', { step: state.rounds + 1, model: state.session.model, tokens: state.session.tokens });
      /** 模型的回复。 */
      const output = await this.callModel();
      await this.save();
      if (output.error) {
        if (await this.finish('error', output.error)) {
          return;
        }
        continue;
      }

      //M ④ 有工具调用：一个个执行，执行前看打断；被打断了又没有插话就结束（被打断）。
      if (output.toolCalls.length > 0) {
        if (await this.runCalls(output.toolCalls)) {
          if ((await this.takeInsertions()) > 0) {
            await this.save();
            continue;
          }
          if (await this.finish('interrupted')) {
            return;
          }
        }
        continue;
      }

      //M ⑤ 没有工具调用：先看插话和打断；都没有就结束（没 reply 过就把这次的回答发出去）。
      /** 谁要打断。 */
      const interruptBy = this.parts.store.takeInterrupt(sessionId);
      if ((await this.takeInsertions()) > 0) {
        await this.save();
        continue;
      }
      /** 结局：没人打断是做完了。 */
      const ending = interruptBy === null ? 'done' : 'interrupted';
      if (await this.finish(ending, interruptBy === null ? output.text : '')) {
        return;
      }
    }
  }


  /**
   * 用户的任务：会话摘要和最后一条用户消息（exec 审核、压缩的题用）。
   */
  private taskText(): string {
    /** 最后一条用户消息。 */
    const lastUser = this.state.session.messages.findLast((stored) => {
      return stored.message.role === 'user' && !stored.summary;
    });
    /** 最后一条用户消息的文字，最多 500 字。 */
    const lastText = lastUser ? utils.truncate(textOf(lastUser.message), 500) : '';
    return [this.state.session.summary, lastText].filter(Boolean).join('\n');
  }


  /**
   * 工具的执行环境。
   */
  private toolContext(): tools.ToolContext {
    /** 运行缺少输入记录时，至少只标记确实被回复的目标，不把空数组称作完整运行来源。 */
    const recordedIds = this.messageIds();
    let fallbackIds = recordedIds;
    if (recordedIds.length === 0 && this.state.session.replyTo !== null) {
      fallbackIds = [this.state.session.replyTo];
    }
    const fallbackAssociation = replyEvidence.association(
      fallbackIds,
      recordedIds.length > 0 ? 'run' : 'target',
      recordedIds.length > 0 ? '本次运行已保存的来源，未记录新观察轮' : '仅能确认回复目标，运行输入未记录',
    );
    return {
      bot: this.state.bot.name,
      workDir: this.state.workDir,
      readOnly: false,
      vision: modelInfo(this.parts, this.state.session.model)?.vision === true,
      sessionId: this.state.session.id,
      generation: this.state.generation ? { ...this.state.generation } : replyEvidence.unknownGeneration(),
      association: this.state.association ? replyEvidence.association(
        this.state.association.messageIds,
        this.state.association.scope,
        this.state.association.source,
      ) : fallbackAssociation,
      trace: {
        run: this.state.run,
        step: this.state.rounds,
        messageIds: this.state.association?.messageIds.slice() ?? this.messageIds(),
        runEventId: this.state.runEventId,
        contextEventId: this.state.contextEventId,
        turnEventId: this.state.turnEventId,
      },
    };
  }


  /**
   * 往对话里加一条工具结果。
   * @param call 工具调用。
   * @param text 结果文字。
   * @param isError 出错没有。
   * @param extra 图片、审核记录。
   */
  private pushResult(
    call: piAi.ToolCall,
    text: string,
    isError: boolean,
    extra: { images?: string[]; details?: unknown } = {},
  ): void {
    /** 工具结果消息。 */
    const message: piAi.ToolResultMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text }],
      isError,
      timestamp: Date.now(),
    };
    if (extra.details !== undefined) {
      message.details = JSON.parse(JSON.stringify(extra.details)) as piAi.JsonValue;
    }
    this.state.session.messages.push({
      message,
      run: this.state.run,
      ...(extra.images?.length ? { images: extra.images } : {}),
    });
  }


  /**
   * 报一个事件（会话循环的断点，docs/11 第 5.2 节）：带上机器人、会话，数据里补上第几次运行。
   * @param type 类型。
   * @param data 数据。
   * 副作用：记事件（没给事件总线时什么都不做）。
   */
  private report(type: string, data: Record<string, unknown>): eventsModule.EventRecord | undefined {
    return this.parts.events.emit(
      type,
      {
        run: this.state.run,
        step: this.state.rounds,
        messageIds: this.state.turnMessageIds?.slice() ?? this.messageIds(),
        ...data,
      },
      {
        source: 'AgentLoop',
        bot: this.state.bot.name,
        sessionId: this.state.session.id,
        messageId: this.state.session.replyTo ?? undefined,
      },
    );
  }

  /** 本次运行截至当前真正收走的消息号；每次返回新数组，异步请求不会被后续插话污染。 */
  private messageIds(): number[] {
    const ids = this.state.session.messages.flatMap((stored) => {
      return stored.run === this.state.run ? stored.messageIds ?? [] : [];
    });
    return [...new Set(ids)];
  }

  /**
   * 报一步做完（step.after）；换了模型再报一条 model.switched。
   * @param output 模型的回复。
   * @param ms 这一步用了多久，毫秒。
   */
  private reportStep(output: { text: string; toolCalls: piAi.ToolCall[]; error?: string; message: piAi.AssistantMessage; request: { model: string; fallbackFrom?: string; tried?: string[] } }, ms: number): void {
    /** 第几步。 */
    const step = this.state.rounds + 1;
    this.report('step.after', {
      step,
      ms,
      model: output.request.model,
      tools: output.toolCalls.map((call) => call.name),
      tokens: output.message.usage.totalTokens,
      ...(output.error ? { error: utils.truncate(output.error, 500) } : {}),
    });
    if (output.request.fallbackFrom) {
      this.report('model.switched', {
        step,
        from: output.request.fallbackFrom,
        to: output.request.model,
        tried: output.request.tried ?? [],
      });
    }
  }

  /**
   * 报一次搜索（search.done）：开场召回时按字组搜自己的记忆（local）、用基地 RAG 搜记忆库（rag）。
   * @param kind local 或 rag。
   * @param query 搜的话。
   * @param hits 实际返回的命中，用于记录文件引用及结果量。
   * @param startedAt 真正发起搜索的时间，毫秒。
   * @param messageIds 本次准备中的来源号；此时用户消息尚未加入会话。
   * @param error 观察到的出错原因；底层自行降级时没有。
   */
  private reportSearch(
    kind: 'local' | 'rag',
    query: string,
    hits: recallModule.RecallHit[],
    startedAt: number,
    messageIds: number[],
    error?: string,
  ): void {
    const endedAt = Date.now();
    const resultChars = hits.reduce((total, hit) => total + hit.lines.join('\n').length, 0);
    this.report('search.done', {
      kind,
      source: 'recall',
      messageIds,
      query: utils.truncate(query, 200),
      hits: hits.length,
      files: hits.map((hit) => hit.file),
      chars: resultChars,
      startedAt,
      endedAt,
      ms: endedAt - startedAt,
      error,
      emptyReason: hits.length === 0 && !error ? '无命中或底层降级；未记录具体原因' : undefined,
    });
  }


  /**
   * 补“结果未知”：上次被重启切断、没有结果的工具调用（只会出在最后一条助手消息上）。
   * @returns 补了几个。
   */
  private repairCut(): number {
    /** 对话。 */
    const messages = this.state.session.messages;
    /** 最后一条助手消息在哪。 */
    const index = messages.findLastIndex((stored) => stored.message.role === 'assistant');
    if (index < 0) {
      return 0;
    }
    /** 那条助手消息。 */
    const assistant = messages[index]!.message as piAi.AssistantMessage;
    /** 已经有结果的调用。 */
    const done = new Set(messages.slice(index + 1).flatMap((stored) => {
      return stored.message.role === 'toolResult' ? [stored.message.toolCallId] : [];
    }));
    /** 补了几个。 */
    let repaired = 0;
    for (const block of assistant.content) {
      if (block.type === 'toolCall' && !done.has(block.id)) {
        this.pushResult(block, WORDS[this.state.bot.language].unknown, true);
        repaired += 1;
      }
    }
    return repaired;
  }


  /**
   * 开会话时程序替模型搜记忆的几个地方：自己的记忆、公共记忆、个人技能、全局技能。
   * @param bot 机器人名。
   */
  private recallRoots(bot: string): string[] {
    /** 这个机器人的文件夹。 */
    const own = this.parts.files.paths(bot);
    return [
      own.memoryDir,
      path.join(this.parts.resources.dir, 'memory'),
      path.join(own.botDir, 'skills'),
      path.join(this.parts.resources.dir, 'skills'),
    ];
  }


  /**
   * 拼会话第一条输入开头的“这个会话”和记忆概要（压缩后也用）。
   */
  private async firstInput(): Promise<string> {
    const state = this.state;
    /** 这种语言的话。 */
    const words = WORDS[state.bot.language];
    /** 机器人的工作区。 */
    const workspaces = await this.parts.files.listWorkspaces(state.bot.name);
    /** 工作区说明。 */
    const description = workspaces.find((item) => item.name === state.session.workspace)
      ?.description ?? '';
    /** 记忆概要。 */
    const memoryIndex = await this.parts.files.readMemoryIndex(state.bot.name);
    return [
      words.session(state.session, description, state.workDir),
      words.memory(memoryIndex),
    ].join('\n\n');
  }


  /**
   * 收插话：排给这个会话的话收走，几条合成一条用户消息（每条前面一行 [渠道 · 时间 · 消息 #号]）；
   * 会话的第一条输入前面加“这个会话”和记忆概要。reply_to 改成最后一条。
   * @returns 收了几条。
   * 副作用：收件改成 taken（写库）；对话里加一条（save 时写库）。
   */
  private async takeInsertions(): Promise<number> {
    const state = this.state;
    /** 收走的。 */
    const rows = this.parts.store.takeQueued(state.session.id);
    if (rows.length === 0) {
      return 0;
    }
    /** 输入关联是观察状态：已成功回复后才重开；尚未回复时后来的多批继续累加。 */
    const newTurn = !state.turnMessageIds?.length || state.turnReplied === true;
    const previousIds = newTurn ? [] : state.turnMessageIds ?? [];
    const incomingIds = rows.map((row) => row.id);
    state.turnMessageIds = [...new Set([...previousIds, ...incomingIds])];
    state.turnReplied = false;
    state.association = replyEvidence.association(
      state.turnMessageIds,
      'turn',
      '生成前保存的本轮输入；已成功回复后的新输入开始新轮，未回复的多批输入累加',
    );
    if (newTurn) {
      state.generation = undefined;
      const turn = this.report('turn.started', { messageIds: [...state.turnMessageIds] });
      state.turnEventId = turn?.id;
    }
    /** 收走排队消息的时刻；在检索和提示词准备之前报告。 */
    const takenAt = Date.now();
    this.report('message.taken', {
      messageIds: rows.map((row) => row.id),
      takenAt,
      chars: rows.reduce((total, row) => total + row.text.length, 0),
      bytes: rows.reduce((total, row) => total + Buffer.byteLength(row.text), 0),
    });
    /** 这种语言的话。 */
    const words = WORDS[state.bot.language];
    /** 合成的正文。 */
    const body = rows.map((row) => {
      /** 渠道名（冒号前面那段）。 */
      const channel = words.channel(row.channel.split(':')[0] ?? '');
      return `${words.header(channel, utils.formatTime(row.createdAt), row.id)}\n${row.text}`;
    }).join('\n\n');
    /** 是不是会话的第一条输入。 */
    const first = !state.session.messages.some((stored) => stored.message.role === 'user');
    //M 开会话时程序先按原话搜一次记忆，放进开场消息：调研数过，模型很少想起来自己搜（设计第 5 节）。
    //M 自己的记忆、公共记忆、技能按字组打分；配了记忆库再用 RAG 搜几条
    //M （用户 11-06：“rag搜索 我觉得搞多点吧”）。搜不成不挡会话。
    /** 用户的原话。 */
    const said = rows.map((row) => row.text).join('\n');
    /** 搜到的记忆。 */
    let recalled = '';
    if (first) {
      /** 准备中的来源还没写进会话，显式传给检索事件。 */
      const messageIds = rows.map((row) => row.id);
      /** 开始搜的时间。 */
      let searchStartedAt = Date.now();
      let searchError: string | undefined;
      this.report('search.started', {
        kind: 'local',
        messageIds,
        startedAt: searchStartedAt,
        roots: this.recallRoots(state.bot.name),
      });
      /** 按字组搜到的。 */
      const local = await recallModule.recall(this.recallRoots(state.bot.name), said)
        .catch((error: unknown) => {
          searchError = utils.errorText(error);
          return [];
        });
      this.reportSearch('local', said, local, searchStartedAt, messageIds, searchError);
      searchStartedAt = Date.now();
      searchError = undefined;
      /** 是否真的配置了记忆库；未配置时沿用原调用的空结果，不报告一次虚构的搜索。 */
      const hasLibraries = Boolean(this.parts.resources.getSetting('indexUrl')
        && this.parts.resources.getSetting('memoryLibs'));
      if (hasLibraries) {
        this.report('search.started', {
          kind: 'rag',
          messageIds,
          startedAt: searchStartedAt,
          libraries: this.parts.resources.getSetting('memoryLibs'),
        });
      }
      /** 记忆库里搜到的。 */
      const libs = await this.parts.memorySearch.recall(said).catch((error: unknown) => {
        searchError = utils.errorText(error);
        return [];
      });
      //G 没配记忆库就没搜，不报（不然每次都是“没搜到”）。
      if (hasLibraries) {
        this.reportSearch('rag', said, libs, searchStartedAt, messageIds, searchError);
      }
      recalled = recallModule.describeRecall(
        [...local, ...libs],
        state.bot.language === 'en' ? 'en' : 'zh',
      );
    }
    /** 这条用户消息。 */
    const content = first
      ? [await this.firstInput(), recalled, `${words.user}\n\n${body}`].filter(Boolean).join('\n\n')
      : body;
    state.session.messages.push({
      message: { role: 'user', content, timestamp: Date.now() },
      run: state.run,
      messageIds: rows.map((row) => row.id),
    });
    state.session.replyTo = rows.at(-1)!.id;
    state.replied = false;
    //M 打断要的是“先看这条”：这条已经进了对话，就不要再拦模型看完以后要调的工具、要说的话。
    /** 谁要打断。 */
    const interruptBy = this.parts.store.getSession(state.session.id)?.interrupt ?? null;
    if (rows.some((row) => row.id === interruptBy)) {
      this.parts.store.takeInterrupt(state.session.id);
    }
    return rows.length;
  }


  /**
   * 自动感应（docs/10 5.4）：感应点以来，记忆有没有被别的会话改过，同一个工作区有没有新开的会话、
   * 别的会话有没有新进展。有就在对话最后加一句“（系统）自动感应：……”
   * （最后一条是这一步刚收的用户消息就接在它后面），感应点挪到现在。
   * @param appendToLast 最后一条是不是这一步刚收的用户消息。
   * @returns 有没有变化。
   */
  private async sense(appendToLast: boolean): Promise<boolean> {
    const state = this.state;
    /** 感应点。 */
    const since = state.session.sensedAt;
    /** 现在。 */
    const now = Date.now();
    /** 这种语言的话。 */
    const words = WORDS[state.bot.language];
    /** 记忆文件夹。 */
    const memoryDir = this.parts.files.paths(state.bot.name).memoryDir;

    //M 1. 记忆：改过的文件，去掉这个会话自己用 memory 写的、删的。
    /** 自己动过的记忆文件。 */
    const own = new Set<string>();
    for (const stored of state.session.messages) {
      if (stored.message.role !== 'assistant' || stored.message.timestamp < since) {
        continue;
      }
      for (const block of stored.message.content) {
        if (block.type === 'toolCall' && block.name === 'memory'
          && typeof block.arguments.path === 'string') {
          own.add(path.resolve(memoryDir, block.arguments.path));
        }
      }
    }
    /** 记忆文件夹里改过的。 */
    const changes = await this.parts.files.listMemoryChanges(state.bot.name, since);
    /** 别人改的。 */
    const memory = changes.filter((change) => !own.has(change.path));

    //M 2. 工作区：新开的会话；有过动静、现在不在运行的别的会话。
    /** 同一个工作区的别的会话。 */
    const others = this.parts.store
      .listSessions(state.bot.name, { workspace: state.session.workspace })
      .filter((item) => item.id !== state.session.id);
    /** 新开的。 */
    const fresh = others.filter((item) => item.createdAt > since);
    /** 有新进展的。 */
    const progressed = others.filter((item) => {
      return item.createdAt <= since && item.updatedAt > since && item.status !== 'running';
    });
    if (memory.length === 0 && fresh.length === 0 && progressed.length === 0) {
      return false;
    }

    //M 3. 写成一句话，加在最后；感应点挪到现在。
    /** 各行。 */
    const lines: string[] = [];
    if (memory.length > 0) {
      lines.push(words.senseMemory(memory.map((change) => {
        /** 相对记忆文件夹的路径。 */
        const relative = path.relative(memoryDir, change.path).replace(/\\/g, '/');
        return `${relative}（${change.head}）`;
      })));
    }
    if (fresh.length > 0) {
      lines.push(words.senseNew(state.session.workspace, fresh.map((item) => item.title)));
    }
    for (const item of progressed) {
      lines.push(words.senseProgress(item.title, utils.truncate(item.summary, 100)));
    }
    /** 那句话。 */
    const note = words.sense(
      utils.formatTime(since).slice(11),
      utils.formatTime(now).slice(11),
      lines,
    );
    /** 最后一条。 */
    const last = state.session.messages.at(-1);
    if (appendToLast && last?.message.role === 'user' && typeof last.message.content === 'string') {
      last.message.content = `${last.message.content}\n\n${note}`;
    } else {
      state.session.messages.push({
        message: { role: 'user', content: note, timestamp: now },
        run: state.run,
      });
    }
    state.session.sensedAt = now;
    return true;
  }


  /**
   * 拼系统提示词（00_base_dsh.md + 机器人提示词 + 技能清单）和这次要送的对话
   * （从最后一条摘要开始；能看图的模型把图换成 base64）。
   * @returns 系统提示词积木、全文、提示词文件、技能个数、对话、工具。
   */
  private async buildRequest(): Promise<BuiltRequest> {
    const state = this.state;
    /** 提示词。 */
    const prompt = this.parts.resources.prompt('bot', state.bot.language);
    /** 技能。 */
    const skills = await this.parts.files.listSkills(state.bot.name);
    /** 技能清单。 */
    const skillsText = skills.length > 0
      ? WORDS[state.bot.language].skills(
        skills.map((skill) => `- ${skill.name}：${skill.description}（@${skill.file}）`),
      )
      : '';
    /** 系统提示词积木。 */
    const system: Record<string, string> = {
      prompt: prompt.text,
      ...(skillsText ? { skills: skillsText } : {}),
    };
    /** 模型。 */
    const model = modelInfo(this.parts, state.session.model);

    //M 从最后一条摘要开始；能看图的模型，工具结果里的图读成 base64 接在后面。
    //M 这组工具结果后面紧跟着用户的话时，图并进那条用户消息：Pi 会把工具结果的图单独发成一条用户消息，
    //M 两条用户消息连着发，前一条的图会被丢掉（11-05 复现过：模型回“图片内容被过滤了”，上下文只涨 190 token）。
    /** 从哪条开始。 */
    const start = Math.max(
      0,
      state.session.messages.findLastIndex((stored) => stored.summary === true),
    );
    /** 要送的那些。 */
    const list = state.session.messages.slice(start);
    /** 对话。 */
    let messages: piAi.Message[] = [];
    /** 实际请求是否被 fitContext 裁剪，供观察记录说明输入边界。 */
    let fitted = false;
    /** 等着并进下一条用户消息的图。 */
    let carried: piAi.ImageContent[] = [];
    for (const [index, stored] of list.entries()) {
      if (stored.message.role === 'toolResult' && model?.vision && stored.images?.length) {
        /** 图片块。 */
        const images: piAi.ImageContent[] = [];
        for (const file of stored.images) {
          /** 内容。 */
          const data = await fs.readFile(file).catch(() => undefined);
          if (data) {
            /** 图片的 MIME。 */
            const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? 'image/png';
            images.push({ type: 'image', data: data.toString('base64'), mimeType });
          }
        }
        /** 这组工具结果之后的第一条。 */
        const next = list.slice(index + 1).find((item) => item.message.role !== 'toolResult');
        if (next?.message.role === 'user') {
          carried.push(...images);
          messages.push(stored.message);
        } else {
          messages.push({ ...stored.message, content: [...stored.message.content, ...images] });
        }
      } else if (stored.message.role === 'user' && carried.length > 0) {
        /** 并了图的用户消息内容。 */
        const content: piAi.UserMessage['content'] = [
          { type: 'text', text: WORDS[state.bot.language].toolImages },
          ...carried,
          { type: 'text', text: textOf(stored.message) },
        ];
        messages.push({ ...stored.message, content });
        carried = [];
      } else {
        messages.push(stored.message);
      }
    }
    //G 万一压完还是超：这一次请求临时裁剪（记录不动）。
    if (model && model.contextWindow > 0) {
      /** 预算：上限的九成减掉系统提示词。 */
      const budget = Math.floor(model.contextWindow * 0.9) - contextFit.estimateTokens(system);
      if (contextFit.estimateTokens(messages) > budget) {
        messages = contextFit.fitContext(messages, budget).messages;
        fitted = true;
      }
    }
    return {
      system,
      systemText: Object.values(system).join('\n\n'),
      promptFiles: prompt.files,
      skills: skills.length,
      messages,
      tools: this.parts.toolBox.definitions(tools.TOOL_NAMES.session),
      fitted,
    };
  }


  /**
   * 先写库再写文件：只写回循环自己管的字段，然后照数据库重写会话的三个文件。
   * @returns 无（state.session 换成写完后的最新一行）。
   * 副作用：写库、写会话文件。
   */
  private async save(): Promise<void> {
    const state = this.state;
    /** 这次运行走了几步。 */
    const steps = state.session.messages.filter((stored) => {
      return stored.run === state.run && stored.message.role === 'assistant';
    }).length;
    /** 库里现有的运行记录（分派可能改过）。 */
    const runs = this.parts.store.getSession(state.session.id)?.runs ?? state.session.runs;
    state.session = this.parts.store.updateSession(state.session.id, {
      messages: state.session.messages,
      tokens: state.session.tokens,
      replyTo: state.session.replyTo,
      sensedAt: state.session.sensedAt,
      runs: runs.map((run) => (run.n === state.run ? { ...run, steps } : run)),
    });
    /** 系统提示词等。 */
    const request = await this.buildRequest();
    /** 用户消息对应的收件号。 */
    const incomingIds = [...new Set(state.session.messages.flatMap((stored) => {
      return stored.messageIds ?? [];
    }))];
    /** 用户消息对应的收件。 */
    const incoming = incomingIds
      .map((id) => this.parts.store.getMessage(id))
      .filter((row): row is storeModule.MessageRow => row !== undefined);
    /** 写文件要的。 */
    const view: filesModule.SessionView = {
      promptFiles: request.promptFiles,
      skills: request.skills,
      system: request.systemText,
      tools: request.tools,
      model: modelInfo(this.parts, state.session.model),
      workDir: state.workDir,
      incoming,
    };
    await this.parts.files.writeSession(state.session, view).catch((error: unknown) => {
      console.error(`会话 ${state.session.id} 的文件没写成：${utils.errorText(error)}`);
    });
  }


  /**
   * 调一次模型并记下：回复放进对话，上下文长度记到会话上。出错时不放进对话。
   * @param extra 这次额外加在最后的一条用户消息（只用来要压缩摘要，不记进对话）。
   * @returns 模型的回复；调不了时 error 里写原因。
   * 副作用：调模型。
   */
  private async callModel(
    extra?: string,
  ): Promise<{ text: string; toolCalls: piAi.ToolCall[]; error?: string }> {
    const state = this.state;
    /** 请求。 */
    const request = await this.buildRequest();
    /** 模型。 */
    const model = modelInfo(this.parts, state.session.model);
    /** 思考档：会话上写的；没写用这个模型的最高档。 */
    const thinking = state.session.thinking
      ?? model?.thinking.filter((level) => level !== 'off').at(-1);
    /** 这一步开始的时间（进度卡片记耗时）。 */
    const startedAt = Date.now();
    /** ⑦ 打印点要看的字段。 */
    const callFields = () => ({
      step: state.rounds + 1,
      model: state.session.model,
      thinking,
      contextTokens: state.session.tokens,
    });
    /** ⑦ 的标题。 */
    const callTitle = `⑦ 第 ${String(state.rounds + 1)} 步：调模型${extra ? '（压缩摘要）' : ''}`;
    await debug.point(callTitle, callFields);
    if (!extra) {
      this.parts.progress.thinking(state.session.id, state.rounds + 1, state.session.model);
    }
    try {
      //M 末尾多加的一句（不存进对话）：压缩时是“请写摘要”；平时过了报时点是报时那一行（docs/界面/03 第 2.1 节第 3 条）。
      /** 那一句；都没有是 undefined。 */
      const tail = extra ?? this.parts.progress.clockNote(state.session.id);
      /** 要送的对话。 */
      const messages = tail
        ? [...request.messages, { role: 'user' as const, content: tail, timestamp: Date.now() }]
        : request.messages;
      /** 调模型的参数。 */
      const chatArgs = {
        model: state.session.model,
        thinking,
        system: request.system,
        messages,
        tools: request.tools,
        purpose: extra ? 'compact' : 'session',
        bot: state.bot.name,
        sessionId: state.session.id,
        trace: {
          run: state.run,
          step: state.rounds + 1,
          messageIds: state.association?.messageIds.slice() ?? this.messageIds(),
        },
      };
      /** 安全上下文清单从最后准备好的 messages 生成，不从会话当前记录倒推。 */
      const contextEvent = this.reportContext(request, messages, extra !== undefined);
      state.contextEventId = contextEvent?.id;
      /** 回复。 */
      const output = await this.parts.ai.chat(chatArgs);
      if (!extra) {
        this.parts.progress.thought(state.session.id, Date.now() - startedAt, output.text);
        this.reportStep(output, Date.now() - startedAt);
      }
      /** ⑧ 打印点要看的字段。 */
      const replyFields = () => ({
        ms: Date.now() - startedAt,
        text: output.text.slice(0, 80),
        tools: output.toolCalls.map((call) => call.name),
        totalTokens: output.message.usage.totalTokens,
        error: output.error,
      });
      //G 压缩摘要那次也走这里，步数不加。
      await debug.point(`⑧ 第 ${String(state.rounds + 1)} 步：模型回了`, replyFields);
      if (output.error) {
        return { text: '', toolCalls: [], error: output.error };
      }
      if (!extra) {
        state.rounds += 1;
        /** 只在成功的常规生成后固定；实际路由与发送档位来自该次 ChatRequest。 */
        const generation = replyEvidence.modelGeneration(output, {
          purpose: 'session',
          run: state.run,
          step: state.rounds,
        });
        const association = state.association ? replyEvidence.association(
          state.association.messageIds,
          state.association.scope,
          state.association.source,
        ) : replyEvidence.association(this.messageIds(), 'run', '运行保存的输入，未记录新观察轮');
        state.generation = generation;
        state.association = association;
        state.session.messages.push({
          message: output.message,
          run: state.run,
          effort: output.request.thinking,
          generation: { ...generation },
          association,
        });
        /** 用量。 */
        const usage = output.message.usage;
        state.session.tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
      }
      return { text: output.text, toolCalls: output.toolCalls };
    } catch (error) {
      return { text: '', toolCalls: [], error: utils.errorText(error) };
    }
  }

  /**
   * 在真正调模型前记录安全的输入清单，全文系统提示和图片数据不会进事件。
   * @param request 本次准备好的请求。
   * @param messages 真正送出的对话，已含末尾报时或压缩指令。
   * @param compact 本次是否在写压缩摘要。
   * @returns 记录的持久事件；观察失败不影响调用。
   */
  private reportContext(
    request: BuiltRequest,
    messages: piAi.Message[],
    compact: boolean,
  ): eventsModule.EventRecord | undefined {
    /** 逐条引用只保留头 30 项，避免整个事件被大数据截短；总体数量与遗漏数明确记录。 */
    const references = messages.slice(0, 30).map((message, index) => {
      /** 未变形的消息按对象引用匹配；图像合并/裁剪后只能在时间与角色唯一时关联。 */
      const identical = this.state.session.messages.find((item) => item.message === message);
      const candidates = this.state.session.messages.filter((item) => {
        return item.message.role === message.role && item.message.timestamp === message.timestamp;
      });
      const stored = identical ?? (candidates.length === 1 ? candidates[0] : undefined);
      const text = textOf(message);
      const images = Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'image').length
        : 0;
      return {
        index,
        role: message.role,
        at: message.timestamp,
        messageIds: stored?.messageIds ?? [],
        referenceKnown: stored !== undefined,
        summary: stored?.summary === true,
        toolCallId: message.role === 'toolResult' ? message.toolCallId : undefined,
        chars: text.length,
        images,
        //M 程序拼进用户输入的记忆/会话资料不复制全文，只记实际读取引用和数量。
        text: utils.truncate(text, 100),
      };
    });
    const data = {
      step: this.state.rounds + 1,
      compact,
      model: this.state.session.model,
      promptFiles: request.promptFiles,
      systemChars: request.systemText.length,
      skills: request.skills,
      tools: request.tools.map((tool) => tool.name),
      contextCount: messages.length,
      context: references,
      omitted: Math.max(0, messages.length - references.length),
      fitted: request.fitted,
    };
    return this.report('context.built', data);
  }


  /**
   * 记一段压缩摘要：开头重新带上“这个会话”和现在的记忆概要，再接摘要；
   * 以后拼上下文从这条开始。感应点挪到现在。
   * @param summary 摘要正文。
   */
  private async addSummary(summary: string): Promise<void> {
    const state = this.state;
    /** 压之前的 token。 */
    const tokensBefore = state.session.tokens;
    /** 这种语言的话。 */
    const words = WORDS[state.bot.language];
    /** 摘要消息的正文。 */
    const content = `${await this.firstInput()}\n\n${words.summaryHead}\n${summary}`;
    state.session.messages.push({
      message: { role: 'user', content, timestamp: Date.now() },
      run: state.run,
      summary: true,
    });
    state.session.sensedAt = Date.now();
    state.session.tokens = contextFit.estimateTokens(summary);
    this.report('compact.done', { tokensBefore, tokensAfter: state.session.tokens });
  }


  /**
   * 让模型写摘要并记进去（必须压）：同一份系统提示词和对话，最后加一句“请把以上对话压缩成摘要”。
   * @returns 压成了没有。
   */
  private async compressNow(): Promise<boolean> {
    /** 摘要。 */
    const output = await this.callModel(WORDS[this.state.bot.language].mustCompress);
    if (output.error || !output.text.trim()) {
      return false;
    }
    await this.addSummary(output.text.trim());
    return true;
  }


  /**
   * 压缩检查（docs/10 5.5）：上下文到了阈值，配了决策模型就问“压缩”，说压就压；
   * 没配就提醒模型自己定；“这次不压”之后再涨 50K 才再问；到了模型上限的 90% 不问，直接压。
   * @returns 无。
   * 副作用：可能调决策模型、调模型写摘要，对话里加一条。
   */
  private async maybeCompress(): Promise<void> {
    const state = this.state;
    /** 模型。 */
    const model = modelInfo(this.parts, state.session.model);
    /** 上下文。 */
    const tokens = state.session.tokens;
    if (tokens < state.nextCompressAt) {
      return;
    }
    /** 上限的 90%：到了不问，直接压。 */
    const force = model && model.contextWindow > 0
      ? Math.ceil(model.contextWindow * 0.9)
      : Infinity;
    /** “这次不压”之后涨到多少再问：再涨 50K，但不越过上限的 90%。 */
    const again = Math.min(tokens + COMPRESS_AGAIN_TOKENS, force);
    //M 1. 到了上限的 90%：直接压。
    if (tokens >= force) {
      if (!(await this.compressNow())) {
        state.nextCompressAt = tokens + COMPRESS_AGAIN_TOKENS;
      }
      return;
    }
    //M 2. 配了决策模型：问“压缩”，说压就必须压。
    if (this.parts.ai.hasDecision()) {
      /** 最近 6 条。 */
      const recent = state.session.messages
        .slice(-6)
        .map((stored) => utils.truncate(textOf(stored.message), 300));
      /** 给决策模型看的现状。 */
      const decideArgs = {
        state: {
          已用上下文: tokens,
          最大上下文: model?.contextWindow ?? 0,
          会话摘要: state.session.summary,
          最近的消息: recent,
        },
        questions: { compress: COMPRESS_QUESTION },
        purpose: 'compact',
        bot: state.bot.name,
        sessionId: state.session.id,
      };
      /** 回答。 */
      const output = await this.parts.ai.decide(decideArgs);
      /** 是非题的回答。 */
      const answer = output.answers.compress;
      if (!output.error && answer?.type === 'bool' && answer.probability >= 0.5
        && (await this.compressNow())) {
        return;
      }
      state.nextCompressAt = again;
      return;
    }
    //M 3. 没配决策模型：在对话最后提醒一句，由模型自己定。
    state.session.messages.push({
      message: {
        role: 'user',
        content: WORDS[state.bot.language].mayCompress(tokens, state.nextCompressAt),
        timestamp: Date.now(),
      },
      run: state.run,
    });
    state.nextCompressAt = again;
  }


  /**
   * 用户决定了挂起的命令：同意就执行；结果当一条消息排给这个会话，接着跑
   * （回复还发到这个会话最近那条消息的渠道）。
   * 状态在挂起那一刻取出来：这次运行之后还会继续变。
   * @param call 那个 exec 调用。
   * @param execInput 挂起前已经校验并审核过的命令参数。
   * @param id 待确认的号。
   * @param wait 等用户决定的 Promise。
   * @returns 无；从不抛错，出错打日志。
   * 副作用：执行命令；写文件、写库；跑会话。
   */
  private async afterDecision(
    call: piAi.ToolCall,
    execInput: checks.ExecInput,
    id: number,
    wait: Promise<approvalsModule.ApprovalDecision>,
  ): Promise<void> {
    const parts = this.parts;
    /** 挂起时的东西（运行状态之后还会变）。 */
    const { bot, workDir } = this.state;
    const sessionId = this.state.session.id;
    const words = WORDS[bot.language];
    /** 审批属于挂起命令的生成步骤；等待期间新插话不能改变这份观察关联。 */
    const approvalTrace = this.toolContext().trace;
    try {
      /** 用户的决定。 */
      const decision = await wait;
      this.report('review.decided', {
        ...approvalTrace,
        callId: call.id,
        approvalId: id,
        verdict: decision.approve ? 'approve' : 'reject',
        by: decision.by,
      });
      /** 命令。 */
      const command = execInput.command;
      /** 告诉会话的话。 */
      let text = words.rejected(id, decision.by, command);
      if (decision.approve) {
        /** 执行命令的环境。 */
        const context: tools.ToolContext = {
          bot: bot.name,
          workDir,
          readOnly: false,
          vision: false,
          sessionId,
          trace: approvalTrace,
        };
        /** 用户放行后才开始真正执行，等待审批的时间不能算成命令耗时。 */
        const startedAt = Date.now();
        this.report('tool.before', {
          ...approvalTrace,
          tool: call.name,
          callId: call.id,
          approvalId: id,
          args: argsBrief(call.arguments),
          startedAt,
        });
        /** 命令的结果。 */
        const result = await this.parts.toolBox.runExec(execInput, context);
        const endedAt = Date.now();
        this.report('tool.after', {
          ...approvalTrace,
          tool: call.name,
          callId: call.id,
          approvalId: id,
          startedAt,
          endedAt,
          ms: endedAt - startedAt,
          isError: result.isError,
          chars: result.text.length,
          bytes: Buffer.byteLength(result.text),
          result: utils.truncate(result.text, 500),
        });
        text = words.approved(id, decision.by, command, result.text);
      }
      //M 排给会话：和渠道收到一句话一样，只是不分派（BotLoop.receive 的指定会话）。
      /** 会话最近那条消息：回复还发到它的渠道。 */
      const replyTo = parts.store.getSession(sessionId)?.replyTo ?? null;
      const origin = replyTo === null ? undefined : parts.store.getMessage(replyTo);
      /** 回复发到哪个渠道。 */
      const channel = origin?.channel ?? 'http';
      /** 存好的消息文件。 */
      const saved = await parts.files.saveIncoming(bot.name, channel, text, []);
      //M addMessage 和 queueMessages 中间没有 await：机器人循环领不走它。
      /** 要记的收件。 */
      const newMessage = {
        bot: bot.name,
        channel,
        source: origin?.source ?? 'http',
        address: origin?.address ?? {},
        file: saved.file,
        text: saved.text,
      };
      /** 这条消息。 */
      const row = parts.store.addMessage(newMessage);
      parts.store.queueMessages([row.id], sessionId, null);
      parts.events.emit('message.queued', {
        messageIds: [row.id],
        queuedAt: parts.store.getMessage(row.id)?.updatedAt,
        via: 'approval',
        targetBot: bot.name,
        targetSession: sessionId,
        approvalId: id,
      }, { source: 'AgentLoop', bot: bot.name, sessionId, messageId: row.id });
      //M 等这条的消息重新分派（结果已经排给会话了）：可能不用做了，可能追加，也可能新开。
      parts.store.releaseMessages(decision.held);
      await parts.files.writeMessage(
        parts.store.getMessage(row.id)!,
        parts.store.getSession(sessionId),
      );
      await this.runner.runSession(sessionId);
    } catch (error) {
      console.error(`${utils.formatTime()} 待确认 #${id} 决定以后出错：${utils.errorText(error)}`);
    }
  }


  /**
   * 一个个执行工具：每个执行前看有没有人打断；exec 先过审核；reply 记下“回过了”；
   * summary 带 compress 就记一段摘要。
   * @param calls 模型要调的工具。
   * @returns 被打断了没有。
   * 副作用：执行工具；每个工具做完都写库、写文件。
   */
  private async runCalls(calls: piAi.ToolCall[]): Promise<boolean> {
    const state = this.state;
    /** 这种语言的话。 */
    const words = WORDS[state.bot.language];
    /** 被打断了没有。 */
    let interrupted = false;
    /** 这一步里带 compress 的 summary：等这一步的工具都有了结果再记（摘要后面不能跟着找不到调用的工具结果）。 */
    let compressed: string | undefined;
    for (const call of calls) {
      if (!interrupted && this.parts.store.takeInterrupt(state.session.id) !== null) {
        interrupted = true;
      }
      if (interrupted) {
        this.pushResult(call, words.interrupted, true);
        continue;
      }
      //M exec 先审核：放行才执行；拒绝写“未执行”；要问用户就挂起，会话不等，接着跑，用户决定了才执行。
      /** 审核记录。 */
      let review: execReview.ExecReviewRecord | undefined;
      /** exec 原始参数只在工具调用入口解析一次，审核与实际执行共用。 */
      let execInput: checks.ExecInput | undefined;
      if (call.name === 'exec') {
        try {
          execInput = checks.readExecInput(call.arguments);
        } catch (error) {
          this.pushResult(call, utils.errorText(error), true);
          await this.save();
          continue;
        }
        /** 要审的东西。 */
        const reviewInput: execReview.ExecReviewInput = {
          session: state.session,
          command: execInput.command,
          workDir: state.workDir,
          task: this.taskText(),
          trace: this.toolContext().trace,
        };
        /** 审核起止和真正执行分开，拒绝/等待也有明确的依据。 */
        const reviewStartedAt = Date.now();
        this.report('review.started', {
          callId: call.id,
          command: utils.truncate(reviewInput.command, 300),
          startedAt: reviewStartedAt,
        });
        /** 审核的结论。 */
        const reviewed = await this.parts.reviewer.review(reviewInput);
        review = reviewed.record;
        this.report('review.decided', {
          callId: call.id,
          verdict: review.verdict,
          by: review.by,
          rule: review.rule,
          reason: utils.truncate(review.reason, 300),
          decisionModel: review.decision,
          llmModel: review.llm?.request.model,
          startedAt: reviewStartedAt,
          endedAt: Date.now(),
          ms: review.ms,
        });
        if (review.verdict === 'pending' && reviewed.wait) {
          /** 待确认的号。 */
          const approvalId = review.approval?.id ?? 0;
          this.parts.progress.waiting(state.session.id, approvalId);
          this.report('review.pending', { approvalId, command: utils.truncate(reviewInput.command, 300) });
          this.pushResult(call, words.pending(approvalId), false, { details: review });
          await this.save();
          void this.afterDecision(call, execInput, approvalId, reviewed.wait);
          continue;
        }
        if (review.verdict === 'reject') {
          this.pushResult(call, words.notExecuted(review.reason), true, { details: review });
          await this.save();
          continue;
        }
      }
      /** ⑨ 打印点要看的字段。 */
      const startFields = () => ({
        tool: call.name,
        args: JSON.stringify(call.arguments).slice(0, 80),
      });
      await debug.point('⑨ 工具开始', startFields);
      this.parts.progress.tool(state.session.id, call.name, call.arguments);
      /** 工具开始的时间。 */
      const toolStartedAt = Date.now();
      this.report('tool.before', {
        tool: call.name,
        callId: call.id,
        args: argsBrief(call.arguments),
        startedAt: toolStartedAt,
      });
      /** 结果。 */
      const toolContext = this.toolContext();
      if (call.name === 'reply' && toolContext.generation) {
        toolContext.generation = { ...toolContext.generation, callId: call.id };
      }
      let result: tools.ToolResult;
      if (execInput) {
        result = await this.parts.toolBox.runExec(execInput, toolContext);
      } else {
        result = await this.parts.toolBox.run(call.name, call.arguments, toolContext);
      }
      this.parts.progress.toolDone(
        state.session.id,
        call.name,
        call.arguments,
        Date.now() - toolStartedAt,
        result.text,
      );
      this.report('tool.after', {
        tool: call.name,
        callId: call.id,
        startedAt: toolStartedAt,
        endedAt: Date.now(),
        ms: Date.now() - toolStartedAt,
        isError: result.isError === true,
        result: utils.truncate(result.text, 500),
        chars: result.text.length,
        bytes: Buffer.byteLength(result.text),
        images: result.images?.length ?? 0,
      });
      /** ⑩ 打印点要看的字段。 */
      const doneFields = () => ({
        tool: call.name,
        isError: result.isError,
        result: result.text.slice(0, 80),
      });
      await debug.point('⑩ 工具结束', doneFields);
      this.pushResult(call, result.text, result.isError, {
        images: result.images,
        details: review,
      });
      if (!result.isError && call.name === 'reply') {
        state.replied = true;
        state.turnReplied = true;
      }
      if (!result.isError && call.name === 'summary' && call.arguments.compress === true
        && typeof call.arguments.text === 'string') {
        compressed = call.arguments.text;
      }
      await this.save();
    }
    if (compressed !== undefined) {
      await this.addSummary(compressed);
      await this.save();
    }
    return interrupted;
  }


  /**
   * 结束这次运行：做完时没 reply 过就把最后的回答发出去（兜底）；到上限、出错时回一句；
   * 被打断的不发。
   * @param ending 结局。
   * @param text 做完时模型最后的回答；出错时是原因。
   * @returns 真的结束了；正好又排来了话时是 false（回去接着跑）。
   * 副作用：发回复；写库、写文件。
   */
  private async finish(ending: storeModule.RunEnding, text = ''): Promise<boolean> {
    const state = this.state;
    /** 这种语言的话。 */
    const words = WORDS[state.bot.language];
    /** 要发的话。 */
    let reply = '';
    if (ending === 'done' && !state.replied) {
      reply = text.trim();
    } else if (ending === 'limit') {
      reply = words.limit(state.rounds);
    } else if (ending === 'error') {
      reply = words.modelError(text);
    }
    if (reply && state.session.replyTo !== null) {
      const replyContext = this.toolContext();
      if (ending !== 'done') {
        replyContext.generation = replyEvidence.programGeneration(`session-${ending}`, {
          run: state.run,
          step: state.rounds,
        });
      }
      const sent = await this.parts.toolBox.run('reply', { text: reply }, replyContext);
      if (!sent.isError) {
        state.turnReplied = true;
      }
    }
    state.replied = true;
    await this.save();
    /** 结束了没有。 */
    const ended = this.parts.store.endRun(state.session.id, ending);
    /** ⑫ 打印点要看的字段。 */
    const endFields = () => ({
      session: state.session.id,
      ending,
      ended,
      steps: state.rounds,
      tokens: state.session.tokens,
    });
    await debug.point('⑫ 这次运行结束', endFields);
    if (!ended && ending === 'limit') {
      //M 到上限时又来了话：用户给了新方向，这次运行接着跑，步数重新数。
      state.rounds = 0;
    }
    if (ended) {
      state.session = this.parts.store.getSession(state.session.id) ?? state.session;
      await this.save().catch(() => undefined);
      stopTyping(this.parts, state.session, state.run);
      this.parts.progress.ended(state.session.id, ending, reply || text);
      this.report('run.ended', { ending, steps: state.rounds, replied: state.replied });
    }
    return ended;
  }
}
