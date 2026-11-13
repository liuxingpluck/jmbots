/**
 * exec 审核（docs/10 5.7、6.11）：命令执行之前先审，两档、先快后慢，都放不了行才问用户。
 *   1. 程序的规矩（ExecRules.ts）：碰密钥文件的直接拒绝；jmbots 自己的检查和换版本直接执行
 *   2. 决策模型（配了才问）：是非题“安全”，概率不低于 engine.exec_pass（默认 0.2）就执行
 *   3. 小循环：常规模型用审核提示词，可以 read、find 看脚本和文件，回 {safe, what, risk, advice}；safe 就执行
 *   4. 问用户：记一条待确认、所有能发卡片的渠道都发。命令先挂起，会话不等，接着跑；用户决定了才执行（AgentLoop.ts 的 SessionRun.afterDecision）
 * 全过程返回给会话循环，记在这个工具结果的 details 里。从不抛错。
 * 命令窗口（executors/Runs.ts，没有会话）用 reviewCommand：只走前两档，要快；放不了行就把结论交回给发命令的，要用户拍板才发卡片。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as miniLoopModule from '../capabilities/MiniLoop.ts';
import * as tools from '../capabilities/tools/Tools.ts';
import * as utils from '../utils/Utils.ts';
import * as replyEvidence from '../capabilities/ReplyEvidence.ts';
import * as execRules from './ExecRules.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import type * as depsModule from '../capabilities/Deps.ts';
import type * as filesModule from '../capabilities/Files.ts';
import type * as model from '../capabilities/Model.ts';
import type * as storeModule from '../capabilities/Store.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 要审的东西。 */
export interface ExecReviewInput {
  /** 哪个会话要执行。 */
  session: storeModule.SessionRow;
  /** 命令。 */
  command: string;
  /** 在哪个目录执行。 */
  workDir: string;
  /** 用户的任务：会话摘要和最后一条用户消息。 */
  task: string;
  /** 生成这条 exec 的运行/步骤/消息快照，只透传给模型观察记录。 */
  trace?: Omit<storeModule.ReplyTrace, 'eventId'>;
}


/** 命令窗口要审的东西（没有会话，docs/界面/08_命令窗口.md 第 1 节）。 */
export interface CommandReviewInput {
  /** 命令。 */
  command: string;
  /** 在哪个目录跑。 */
  workDir: string;
  /** 谁发的、为什么跑：给决策模型看。 */
  task: string;
  /** 决策模型说不安全时，要不要发审核卡片等用户决定；false 就不跑，把结论交回去。 */
  askUser: boolean;
}


/** 审核的结论和全过程。 */
export interface ExecReviewRecord {
  /** run 执行、reject 不执行、pending 挂起等用户决定。 */
  verdict: 'run' | 'reject' | 'pending';
  /** 谁定的：rule 程序的规矩、decision 决策模型、llm 小循环、user 用户。 */
  by: 'rule' | 'decision' | 'llm' | 'user';
  /** 哪条规矩（by=rule 时）。 */
  rule?: string;
  /** 决策模型：模型、“安全”的概率、用时、出错原因。 */
  decision?: { model: string; probability?: number; ms: number; error?: string };
  /** 小循环的全过程。 */
  llm?: miniLoopModule.MiniLoopResult;
  /** 待确认：号、卡片发到了哪些渠道。 */
  approval?: { id: number; channels: string[] };
  /** 一句话：为什么执行或不执行。 */
  reason: string;
  /** 用了多久，毫秒。 */
  ms: number;
}


/** 网页发的消息的来源（web/src/Api.ts 的 from）：网页自己显示审核卡片。 */
const WEB_SOURCE = 'web';

/** 决策模型的是非题“安全”（docs/10 7.3）。 */
const SAFE_QUESTION: piAi.ClassifierBoolQuestion = {
  type: 'bool',
  instructions:
    '要执行这条命令。它安全吗——不会删改重要的文件、不会泄露密钥、不会影响系统和别的程序？'
    + '可以直接执行，回答“是”。',
  criteria: { true: '安全，可以直接执行', false: '有风险，要问用户' },
};


/**
 * 命令审核器：一个进程建一个，会话循环（SessionRun）审会话里的 exec（review），命令窗口审单条命令（reviewCommand）。
 * 对外只有 review 和 reviewCommand，其余都是私有的一步。
 */
export class ExecReviewer {
  /**
   * @param resources 配置、机器人、提示词、模型选择
   *   （src/resources/Resources.ts 的 Resources，入口 src/entries/App.ts 建的）。
   * @param store 数据库：查消息、记回复（src/capabilities/Store.ts 的 Store，入口建的）。
   * @param files 文件库：会话文件路径、写消息文件（src/capabilities/Files.ts 的 Files，入口建的）。
   * @param ai 调模型：决策模型（src/capabilities/Model.ts 的 Ai，入口建的）。
   * @param approvals 待审核的命令（src/capabilities/Approvals.ts 的 Approvals，入口建的）。
   * @param miniLoop 小循环，第 3 档用它（src/capabilities/MiniLoop.ts 的 MiniLoop，调用方用 ai 和 secrets 建的）。
   * @param toolBox 工具库：第 3 档小循环里模型用的只读工具、工具定义都从它取
   *   （src/capabilities/tools/Tools.ts 的 ToolBox，入口建的）。
   * @param out 往渠道发东西的出口：渠道中心 ChannelHub（src/channels/index.ts），入口 src/entries/App.ts 最先建它，
   *   渠道开起来以前发会报“渠道没开”。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly store: storeModule.Store,
    private readonly files: filesModule.Files,
    private readonly ai: model.Ai,
    private readonly approvals: approvalsModule.Approvals,
    private readonly miniLoop: miniLoopModule.MiniLoop,
    private readonly toolBox: tools.ToolBox,
    private readonly out: depsModule.Outlet,
  ) {}


  /**
   * 审一条命令（docs/10 5.7）。
   * @param input 要审的东西。
   * @returns 结论和全过程；挂起时还有 wait，用户决定了才兑现。从不抛错。
   * 副作用：可能调决策模型、常规模型，记待确认、发卡片。
   */
  async review(
    input: ExecReviewInput,
  ): Promise<{ record: ExecReviewRecord; wait?: Promise<approvalsModule.ApprovalDecision> }> {
    /** 开始时间。 */
    const startedAt = Date.now();
    /** 记录。 */
    const record: ExecReviewRecord = { verdict: 'reject', by: 'rule', reason: '', ms: 0 };
    /**
     * 收尾：记下用时。
     * @param patch 结论。
     */
    const done = (patch: Partial<ExecReviewRecord>): { record: ExecReviewRecord } => {
      return { record: Object.assign(record, patch, { ms: Date.now() - startedAt }) };
    };
    try {
      //M 1. 程序的规矩。
      /** 碰到的密钥文件。 */
      const secret = execRules.touchesSecret(input.command);
      if (secret) {
        /** 拒绝的原因。 */
        const reason = `不准执行：命令碰了密钥文件 ${secret}。`
          + '要飞书、模型这些能力就用现成的工具；没有合适的工具，用 note_claude 找 Claude 加，不要自己去读配置。';
        return done({ verdict: 'reject', by: 'rule', rule: `碰了密钥文件 ${secret}`, reason });
      }
      if (execRules.isProjectCheck(input.command)) {
        return done({
          verdict: 'run',
          by: 'rule',
          rule: 'jmbots 自己的检查或换版本',
          reason: '项目自己的检查，直接执行',
        });
      }

      //M 2. 决策模型：概率够就执行。
      if (this.ai.hasDecision()) {
        record.decision = await this.askDecision(input);
        /** 门槛。 */
        const pass = this.resources.getSetting('execPass');
        if (
          !record.decision.error
          && record.decision.probability !== undefined
          && record.decision.probability >= pass
        ) {
          return done({
            verdict: 'run',
            by: 'decision',
            reason: `决策模型认为安全（${record.decision.probability.toFixed(2)} ≥ ${pass}）`,
          });
        }
      }

      //M 3. 小循环：safe 就执行；否则它写的说明放进审核卡片。
      record.llm = await this.askLlm(input);
      /** 小循环的结论。 */
      const value = record.llm.value;
      if (value?.safe === true) {
        return done({
          verdict: 'run',
          by: 'llm',
          reason: `小循环认为能直接执行：${utils.toText(value.what)}`,
        });
      }
      /** 卡片上的说明。 */
      const review = {
        what: typeof value?.what === 'string' ? value.what : '（审核没写出说明，请看命令本身）',
        risk: typeof value?.risk === 'string' ? value.risk : '不清楚',
        advice: typeof value?.advice === 'string' ? value.advice : '拿不准，请你看一眼',
      };

      //M 4. 问用户：发卡片，命令挂起，不等。
      /** 待确认的号、等结果的 Promise、卡片发到了哪些渠道。 */
      const asked = await this.sendCard(input, review);
      record.approval = { id: asked.id, channels: asked.channels };
      return {
        ...done({ verdict: 'pending', by: 'user', reason: `等用户决定（待确认 #${asked.id}）` }),
        wait: asked.wait,
      };
    } catch (error) {
      //G 审核自己出错：不执行，说清原因。
      return done({ verdict: 'reject', reason: `审核出错，没执行：${utils.errorText(error)}` });
    }
  }


  /**
   * 审命令窗口的一条命令（docs/界面/08_命令窗口.md 第 1 节）：只走前两档（程序的规矩、决策模型），要快，不走小循环。
   * 放不了行时照用户的话把结论交回给发命令的（用户 11-06：“它只要判断是不是安全就行了，然后把结果反馈回来”）；
   * 写了 askUser 才发审核卡片等用户。
   * @param input 要审的东西。
   * @returns 结论和全过程；等用户时还有 wait，用户决定了才兑现。从不抛错。
   * 副作用：可能调决策模型；askUser 时记待确认、发卡片。
   */
  async reviewCommand(
    input: CommandReviewInput,
  ): Promise<{ record: ExecReviewRecord; wait?: Promise<approvalsModule.ApprovalDecision> }> {
    /** 开始时间。 */
    const startedAt = Date.now();
    /** 记录。 */
    const record: ExecReviewRecord = { verdict: 'reject', by: 'rule', reason: '', ms: 0 };
    /**
     * 收尾：记下用时。
     * @param patch 结论。
     */
    const done = (patch: Partial<ExecReviewRecord>): { record: ExecReviewRecord } => {
      return { record: Object.assign(record, patch, { ms: Date.now() - startedAt }) };
    };
    try {
      //M 1. 程序的规矩：碰密钥的拒绝，jmbots 自己的检查、发版、换版本直接跑。
      /** 碰到的密钥文件。 */
      const secret = execRules.touchesSecret(input.command);
      if (secret) {
        return done({
          verdict: 'reject',
          by: 'rule',
          rule: `碰了密钥文件 ${secret}`,
          reason: `不准执行：命令碰了密钥文件 ${secret}`,
        });
      }
      if (execRules.isProjectCheck(input.command)) {
        return done({
          verdict: 'run',
          by: 'rule',
          rule: 'jmbots 自己的检查或换版本',
          reason: '项目自己的检查，直接执行',
        });
      }

      //M 2. 决策模型：概率够就跑。
      /** 放不了行的原因。 */
      let doubt = '没配决策模型（config.yaml 的 models.decision），没法替你判断';
      if (this.ai.hasDecision()) {
        record.decision = await this.askDecision(input);
        /** 门槛。 */
        const pass = this.resources.getSetting('execPass');
        /** “安全”的概率。 */
        const probability = record.decision.probability;
        if (!record.decision.error && probability !== undefined && probability >= pass) {
          return done({
            verdict: 'run',
            by: 'decision',
            reason: `决策模型认为安全（${probability.toFixed(2)} ≥ ${String(pass)}）`,
          });
        }
        if (record.decision.error) {
          doubt = `决策模型出错：${record.decision.error}`;
        } else {
          doubt = `决策模型认为有风险（${probability?.toFixed(2) ?? '没给概率'} < ${String(pass)}）`;
        }
      }
      /** 谁定的不跑。 */
      const by = record.decision ? 'decision' : 'rule';

      //G 3. 没要问用户：不跑，结论交回去。
      if (!input.askUser) {
        return done({
          verdict: 'reject',
          by,
          reason: `没跑：${doubt}。要用户拍板就带上 ask_user 再发一次，会给用户发审核卡片。`,
        });
      }
      //M 4. 问用户：发卡片（和更新版本的卡片一样不挂会话），同意了才跑。
      /** 发卡片用哪个机器人。 */
      const bot = this.resources.listBots()[0]?.name;
      if (!bot) {
        return done({ verdict: 'reject', by, reason: `没跑：${doubt}；也没有机器人能发审核卡片` });
      }
      /** 卡片上的说明。 */
      const cardReview = {
        what: input.task || '（没写为什么）',
        risk: doubt,
        advice: '同意就跑，拒绝就不跑；结果交回给发命令的',
      };
      /** 待确认。 */
      const asked = this.approvals.ask({
        bot,
        sessionId: '',
        title: '命令窗口要跑一条命令',
        command: input.command,
        workDir: input.workDir,
        review: cardReview,
      });
      /** 那条待确认。 */
      const pending = this.approvals.list().find((item) => item.id === asked.id)!;
      /** 卡片发到了哪些渠道。 */
      const channels = await this.out
        .sendApproval('http', {}, pending)
        .catch(() => [] as string[]);
      record.approval = { id: asked.id, channels };
      return {
        ...done({
          verdict: 'pending',
          by: 'user',
          reason: `等用户决定（待确认 #${String(asked.id)}）：${doubt}`,
        }),
        wait: asked.wait,
      };
    } catch (error) {
      //G 审核自己出错：不跑，说清原因。
      return done({ verdict: 'reject', reason: `审核出错，没跑：${utils.errorText(error)}` });
    }
  }


  /**
   * 问决策模型：这条命令安全吗。
   * @param input 要审的东西。
   * @returns 模型、概率、用时、出错原因。
   * 副作用：调一次决策模型。
   */
  private async askDecision(
    input: Pick<ExecReviewInput, 'command' | 'workDir' | 'task'>
      & Partial<Pick<ExecReviewInput, 'session' | 'trace'>>,
  ): Promise<NonNullable<ExecReviewRecord['decision']>> {
    /** 要跑的本地脚本。 */
    const script = execRules.readScript(input.command, input.workDir);
    /** 给决策模型看的现状。 */
    const state = {
      用户的任务: input.task,
      命令: input.command,
      执行目录: input.workDir,
      ...(script ? { 要跑的脚本: script.file, 脚本内容: script.content } : {}),
    };
    /** 回答。 */
    /** 问决策模型的参数。 */
    const decideArgs = {
      state,
      questions: { safe: SAFE_QUESTION },
      purpose: 'exec-review',
      bot: input.session?.bot,
      sessionId: input.session?.id,
      trace: input.trace,
    };
    /** 回答。 */
    const output = await this.ai.decide(decideArgs);
    /** 是非题的回答。 */
    const answer = output.answers.safe;
    return {
      model: output.request.model,
      probability: answer?.type === 'bool' ? answer.probability : undefined,
      ms: output.ms,
      error: output.error,
    };
  }


  /**
   * 小循环：常规模型看命令、脚本和文件，回 {safe, what, risk, advice}。
   * @param input 要审的东西。
   * @returns 小循环的结果。
   * 副作用：调模型；读文件。
   */
  private async askLlm(input: ExecReviewInput): Promise<miniLoopModule.MiniLoopResult> {
    /** 机器人。 */
    const bot = this.resources.getBot(input.session.bot);
    /** 用的模型（和分派同一个）。 */
    const choice = this.resources.getModelChoice('dispatch');
    /** 要跑的本地脚本。 */
    const script = execRules.readScript(input.command, input.workDir);
    /** 给模型看的内容，一段一段拼起来。 */
    const parts = [
      `用户的任务：${input.task || '（没写）'}`,
      `命令：${input.command}`,
      `执行目录：${input.workDir}`,
      ...(script ? [`要跑的脚本：${script.file}（前 4000 字）\n${script.content}`] : []),
    ];
    return this.miniLoop.askJson({
      model: choice?.model ?? '',
      thinking: choice?.thinking ?? 'low',
      purpose: 'exec-review',
      trace: input.trace,
      system: this.resources.prompt('review', bot.language).text,
      input: parts.join('\n\n'),
      tools: this.toolBox.definitions(tools.TOOL_NAMES.review),
      toolContext: {
        bot: bot.name,
        workDir: input.workDir,
        readOnly: false,
        vision: false,
        sessionId: input.session.id,
        trace: input.trace,
      },
      toolBox: this.toolBox,
      maxSteps: 6,
      check: (value) => {
        if (typeof value.safe === 'boolean' && typeof value.what === 'string') {
          return undefined;
        }
        return 'safe 要是 true 或 false，what 要写这条命令做什么';
      },
      language: bot.language,
    });
  }


  /**
   * 记待确认、发审核卡片。消息来的渠道没收到卡片（发不了，或者根本不支持），就把要确认的事当一句回复发给它；
   * 网页自己会显示卡片，不用。
   * @param input 要审的东西。
   * @param review 小循环写的说明。
   * @returns 待确认的号、等结果的 Promise、卡片发到了哪些渠道。
   * 副作用：记待确认；发卡片或回复。
   */
  private async sendCard(
    input: ExecReviewInput,
    review: { what: string; risk: string; advice: string },
  ): Promise<{ id: number; wait: Promise<approvalsModule.ApprovalDecision>; channels: string[] }> {
    //M 1. 记待确认。
    /** 待确认。 */
    const asked = this.approvals.ask({
      bot: input.session.bot,
      sessionId: input.session.id,
      command: input.command,
      workDir: input.workDir,
      review,
    });
    /** 回复发给哪条消息。 */
    const replyTo = input.session.replyTo;
    const message = replyTo === null ? undefined : this.store.getMessage(replyTo);
    /** 那条待确认。 */
    const pending = this.approvals.list().find((item) => item.id === asked.id)!;

    //M 2. 发卡片。
    /** 卡片发到了哪些渠道。 */
    const channels = await this.out
      .sendApproval(message?.channel ?? 'http', message?.address ?? {}, pending)
      .catch(() => [] as string[]);

    //M 3. 消息来的渠道没收到卡片：把要确认的事当一句回复发给它，并记进回复和消息文件。
    if (message && message.source !== WEB_SOURCE && !channels.includes(message.channel)) {
      /** 说明。 */
      const text = `要执行一条命令，等你决定（待确认 #${asked.id}）：
${input.command}
目录：${input.workDir}
${review.what}
风险：${review.risk}
建议：${review.advice}
回复“同意 ${asked.id}”或“拒绝 ${asked.id}”。`;
      //G 同上，出口用时才取。
      await this.out
        .send(message.channel, message.address, text)
        .catch(() => undefined);
      /** 记进消息的回复。 */
      const reply = {
        at: Date.now(),
        session: {
          id: input.session.id,
          title: input.session.title,
          file: this.files.sessionFiles(input.session).md,
        },
        text,
        generation: replyEvidence.programGeneration('approval-notice', {
          run: input.trace?.run,
          step: input.trace?.step,
        }),
        association: replyEvidence.association(
          input.trace?.messageIds ?? [message.id],
          input.trace ? 'run' : 'target',
          '程序审核通知的明确输入范围，不能归给审核模型',
        ),
      };
      this.store.addReply(message.id, reply);
      /** 刚记了回复的那条消息。 */
      const updated = this.store.getMessage(message.id)!;
      await this.files.writeMessage(updated, input.session).catch(() => undefined);
    }
    return { ...asked, channels };
  }
}
