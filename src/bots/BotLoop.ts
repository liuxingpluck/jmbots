/**
 * 机器人循环（docs/10 5.2、6.13）：class BotLoop，一个进程一个，所有机器人共用（入口 src/entries/App.ts 建的）。
 *   receive：渠道收到一句话 → 图存进 message/、定好消息文件名 → 记一行收件（new）→ 写消息文件
 *   start：每 poll_ms 看一次；同一来源静够 merge_ms（机器人.yaml 可另设）就把它所有新到的一起领走 → 先挑出在回答待确认的 → 其余分派 → place → 跑会话
 *   place：照结论打断、建会话或换模型、把这批排给会话、写分派记录和消息文件
 * 一个机器人的消息一批一批分派，先来的先分；会话可以同时跑好几个。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as approvalsModule from '../capabilities/Approvals.ts';
import * as dispatchModule from '../dispatch/Dispatch.ts';
import * as debug from '../utils/Debug.ts';
import * as utils from '../utils/Utils.ts';
import * as replyEvidence from '../capabilities/ReplyEvidence.ts';
import type * as depsModule from '../capabilities/Deps.ts';
import type * as filesModule from '../capabilities/Files.ts';
import type * as eventsModule from '../capabilities/Events.ts';
import type * as aiModule from '../capabilities/Model.ts';
import type * as progressModule from '../capabilities/Progress.ts';
import * as storeModule from '../capabilities/Store.ts';
import type * as agentLoop from '../executors/AgentLoop.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 决策模型认为“在回答待确认”的概率要到这么高才算：误放行比多问一句糟得多。 */
const APPROVAL_SURE = 0.9;

/** 问决策模型最多等多久，毫秒。 */
const APPROVAL_TIMEOUT_MS = 8000;

/** 问决策模型的题：用户说的不是程序认得出的那几个词时。 */
const APPROVAL_QUESTION: piAi.ClassifierChoiceQuestion = {
  type: 'choice',
  instructions:
    '有一条命令在等用户决定要不要执行。用户刚说了这句话，它是在回答这条命令吗？'
    + '拿不准就选 other。',
  criteria: {
    approve: '明确同意执行这条命令',
    reject: '明确不要执行这条命令',
    resend: '要再看一次这条待确认的卡片',
    other: '在说别的事，或者看不出来',
  },
};


/** 渠道收到的一句话。 */
export interface IncomingInput {
  /** 哪个机器人的：飞书应用知道自己对应哪个机器人；HTTP 不写就给第一个。 */
  bot: string;
  /** 渠道：http，或 feishu:<应用 ID>。 */
  channel: string;
  /** 来源（合批用）：飞书 = 应用 + 聊天 + 发送人；HTTP = 请求里的 from。 */
  source: string;
  /** 回复地址：飞书是 chat_id、message_id 等；HTTP 是 {}。 */
  address: Record<string, unknown>;
  /** 原话。 */
  text: string;
  /** 带的图。 */
  images: filesModule.IncomingImage[];
  /** 指定会话：不分派，直接排给它（换版本报告结果用）；一般不写。 */
  session?: string;
}


/** 限时转新会话要的东西（Progress.handOff 给；docs/界面/03 第 2.1 节第 5 条）。 */
export interface HandOffInput {
  /** 老会话：照它的工作区、模型、思考档开新会话。 */
  fromSession: string;
  /** 交接说明：新会话的第一条消息（这里再补上老会话的记录在哪）。 */
  text: string;
  /** 回到哪个渠道：照抄原消息的。 */
  channel: string;
  /** 渠道里的回复地址：照抄原消息的，回复还发回原来的聊天。 */
  address: Record<string, unknown>;
}


/** 转过来的交接说明在收件表里的来源（source）。 */
const HANDOFF_SOURCE = 'handoff';


/** 机器人循环：收话、合批、分派、排给会话、跑起来。一个进程一个，所有机器人共用。 */
export class BotLoop {
  /**
   * 下面这些都是入口 src/entries/App.ts 建的，一个进程一份。
   * @param resources 资源：机器人、合批等多久、看几次（src/resources/Resources.ts）。
   * @param store 数据库：收件、会话、领一批新消息（src/capabilities/Store.ts）。
   * @param files 文件库：存图、写消息文件和分派记录（src/capabilities/Files.ts）。
   * @param ai 模型库：用户打字回的话是不是在答待确认，问决策模型（src/capabilities/Model.ts 的 Ai）。
   * @param approvals 待确认登记表：用户打字同意、拒绝、要再发卡片（src/capabilities/Approvals.ts）。
   * @param out 往渠道发东西：渠道中心 ChannelHub（src/channels/index.ts）：回话、再发审核卡片。
   * @param dispatcher 分派（src/dispatch/Dispatch.ts 的 Dispatcher）。
   * @param runner 会话运行器（src/executors/AgentLoop.ts 的 SessionRunner）。
   * @param progress 进度卡片（src/capabilities/Progress.ts）；由入口构造并传入。
   * @param events 事件总线（src/capabilities/Events.ts 的 EventBus）：报 message.received、batch.taken；由入口构造并传入。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly store: storeModule.Store,
    private readonly files: filesModule.Files,
    private readonly ai: aiModule.Ai,
    private readonly approvals: approvalsModule.Approvals,
    private readonly out: depsModule.Outlet,
    private readonly dispatcher: dispatchModule.Dispatcher,
    private readonly runner: agentLoop.SessionRunner,
    private readonly progress: progressModule.Progress,
    private readonly events: eventsModule.EventBus,
  ) {}


  /**
   * 渠道收到一句话：存图、记收件、写消息文件。指定了会话的直接排给它并跑起来。
   * @param input 收到的。
   * @returns 新的收件。
   * @throws 机器人不存在、指定的会话不是这个机器人的时抛错。
   * 副作用：写文件、写库；指定会话时跑会话。
   */
  async receive(input: IncomingInput): Promise<storeModule.MessageRow> {
    this.resources.getBot(input.bot);
    //G 指定的会话要存在、而且是这个机器人的。
    if (input.session && this.store.getSession(input.session)?.bot !== input.bot) {
      throw new Error(`会话 ${input.session} 不是机器人 ${input.bot} 的`);
    }

    //M ① 存图，定好消息文件名。
    /** 存好的图和消息文件名。 */
    const saved = await this.files.saveIncoming(
      input.bot,
      input.channel,
      input.text,
      input.images,
    );

    //M ② 记一行收件（new）。
    /** 要记的收件。 */
    const newMessage = {
      bot: input.bot,
      channel: input.channel,
      source: input.source,
      address: input.address,
      file: saved.file,
      text: saved.text,
    };
    /** 收件。 */
    const row = this.store.addMessage(newMessage);
    //M 外部接管的机器人只落收件，不启动强制分派、指定会话或模型。
    if (this.files.readBotSettings(input.bot).relayOnly) {
      this.store.holdMessages([row.id], null);
      const held = this.store.getMessage(row.id)!;
      await this.files.writeMessage(held);
      await this.out.stopTyping?.(row.channel, row.address).catch((error: unknown) => {
        console.error(`仅转接收件撤销输入状态失败：${utils.errorText(error)}`);
      });
      return held;
    }
    //M 事件：收到一条（同步记，和下面的强制执行之间仍然没有 await）。
    this.events.emit(
      'message.received',
      {
        channel: row.channel,
        source: row.source,
        text: utils.truncate(row.text, 500),
        chars: row.text.length,
        bytes: Buffer.byteLength(row.text),
        images: input.images.length,
        forced: dispatchModule.isForceText(input.text),
        toSession: input.session ?? null,
      },
      { source: 'BotLoop', bot: row.bot, messageId: row.id },
    );
    /** ② 打印点要看的字段。 */
    const pointFields = () => ({
      id: row.id,
      bot: row.bot,
      channel: row.channel,
      source: row.source,
      status: row.status,
      file: row.file,
    });
    await debug.point('② 收件：存进 messages 表', pointFields);

    //M ③ 强制执行：和 addMessage 中间没有 await，机器人循环领不走它；
    //M 另开一轮分派，平时的卡住了也不受影响（用户 11-05）。
    if (!input.session && dispatchModule.isForceText(input.text)) {
      this.store.holdMessages([row.id], null);
      await this.files.writeMessage(this.store.getMessage(row.id)!);
      void this.forceRun(row);
      return row;
    }

    //M ④ 指定了会话：直接排给它并跑起来。和 addMessage 中间没有 await：机器人循环领不走它。
    if (input.session) {
      this.store.queueMessages([row.id], input.session, null);
      this.reportQueued([row], input.session, 'direct');
      /** 指定的会话。 */
      const target = this.store.getSession(input.session);
      await this.files.writeMessage(this.store.getMessage(row.id)!, target);
      void this.runner.runSession(input.session);
      return this.store.getMessage(row.id)!;
    }

    //M ⑤ 一般情况：写消息文件，等机器人循环来领。
    await this.files.writeMessage(row);
    return row;
  }


  /**
   * 限时转新会话（docs/界面/03 第 2.1 节第 5 条）：照老会话开一个新会话（同一个工作区、模型、思考档），
   * 把交接说明当第一条消息放进去，挂上进度卡片（限时从头算，记着是转过来的），跑起来。不经过分派。
   * 由 Progress.handOff（src/capabilities/Progress.ts）在老会话停下以后调。
   * @param input 老会话、交接说明、回到哪个渠道。
   * @returns 新会话。
   * @throws 老会话不存在时抛错。
   * 副作用：写库、写文件；跑会话。
   */
  async handOff(input: HandOffInput): Promise<storeModule.SessionRow> {
    /** 老会话。 */
    const from = this.store.getSession(input.fromSession);
    if (!from) {
      throw new Error(`会话 ${input.fromSession} 不存在`);
    }

    //M ① 新会话：照老会话的工作区、模型、思考档。
    /** 新会话的参数。 */
    const newSession = {
      bot: from.bot,
      workspace: from.workspace,
      title: `${from.title}（接着做）`,
      model: from.model,
      thinking: from.thinking,
    };
    const session = this.store.createSession(newSession);

    //M ② 交接说明补上老会话的记录在哪，存成一条收件。
    /** 老会话的记录。 */
    const fromFile = this.files.sessionFiles(from).md;
    /** 新会话的第一条消息。 */
    const text = `${input.text}\n\n老会话的记录在：${fromFile}（要查细节时再看，不用整份读）`;
    const saved = await this.files.saveIncoming(from.bot, input.channel, text, []);
    /** 要记的收件。 */
    const newMessage = {
      bot: from.bot,
      channel: input.channel,
      source: HANDOFF_SOURCE,
      address: input.address,
      file: saved.file,
      text: saved.text,
    };
    const row = this.store.addMessage(newMessage);

    //M ③ 挂进度卡片、排给新会话：和 addMessage 中间没有 await，机器人循环领不走它。
    this.progress.handedOver([row], session.id, from.title);
    this.store.queueMessages([row.id], session.id, null);
    this.reportQueued([row], session.id, 'handoff');
    /** 报给事件表的数据。 */
    const receivedData = {
      channel: row.channel,
      source: row.source,
      text: utils.truncate(row.text, 500),
      images: 0,
      forced: false,
      toSession: session.id,
    };
    this.events.emit('message.received', receivedData, { source: 'BotLoop', bot: row.bot, messageId: row.id });

    //M ④ 写消息文件，跑起来。
    await this.files.writeMessage(this.store.getMessage(row.id)!, session);
    void this.runner.runSession(session.id);
    return session;
  }


  /**
   * 起这个机器人的循环：合批领消息 → 分派 → place → 跑会话（不 await）。
   * @param bot 机器人名。
   * @returns 停下的函数。
   * 副作用：一直轮询数据库；调模型；写库、写文件。
   */
  start(bot: string): () => void {
    /** 停了没有。 */
    let stopped = false;
    /** 多久看一次。 */
    const pollMs = this.resources.getSetting('pollMs');
    void (async () => {
      while (!stopped) {
        try {
          if (this.files.readBotSettings(bot).relayOnly) {
            await Bun.sleep(pollMs);
            continue;
          }
          //M ① 合批等多久：机器人.yaml 里单独设的优先，没有用 config 的。
          /** 合批等待。 */
          const mergeMs =
            this.files.readBotSettings(bot).mergeMs
            ?? this.resources.getSetting('mergeMs');
          /** 领到的一批。 */
          const batch = this.store.takeNewBatch(bot, mergeMs);
          if (batch.length === 0) {
            await Bun.sleep(pollMs);
            continue;
          }
          //M 事件：领到一批。
          this.events.emit(
            'batch.taken',
            {
              messageIds: batch.map((item) => item.id),
              startedAt: Math.min(...batch.map((item) => item.createdAt)),
              endedAt: Date.now(),
              mergeMs,
              maxWaitMs: storeModule.MAX_MERGE_WAIT_MS,
              lastReceivedAt: Math.max(...batch.map((item) => item.createdAt)),
              waits: batch.map((item) => ({
                messageId: item.id,
                startedAt: item.createdAt,
                endedAt: item.updatedAt,
                ms: item.updatedAt - item.createdAt,
                chars: item.text.length,
                bytes: Buffer.byteLength(item.text),
              })),
              rule: '同来源静够 mergeMs 或最早消息达到 maxWaitMs；实际还受轮询与前批分派占用影响',
            },
            { source: 'BotLoop', bot, messageId: batch.at(-1)?.id },
          );

          //M ② 先挑出在回答待确认的，其余的才分派。
          /** 不是在回答待确认的。 */
          const rest = await this.takeApprovalReplies(bot, batch);
          if (rest.length === 0) {
            continue;
          }
          /** ③ 打印点要看的字段。 */
          const takenFields = () => ({ bot, messageIds: rest.map((row) => row.id) });
          await debug.point('③ 机器人循环取到一批', takenFields);
          this.progress.received(rest);

          //M ③ 分派。
          /** 分派记录。 */
          const record = await this.dispatcher.dispatch(bot, rest);
          /** 分派的结论。 */
          const result = record.result;
          /** ④ 打印点要看的字段。 */
          const decidedFields = () => ({
            session: result.session,
            title: result.title,
            model: result.model,
            thinking: result.thinking,
            by: result.by,
            ms: record.ms,
            reason: result.reason.slice(0, 80),
          });
          await debug.point('④ 分派出结论', decidedFields);

          //M ④ 要等待确认：先不做，等用户决定后重新分派。
          if (result.waitFor !== undefined) {
            await this.holdForApproval(rest, record, result.waitFor);
            this.progress.held(rest, result.waitFor);
            continue;
          }

          //M ⑤ 排给会话，跑起来（不 await）。
          /** 会话。 */
          const sessionId = await this.place(rest, record);
          this.progress.dispatched(rest, sessionId, record);
          void this.runner.runSession(sessionId);
        } catch (error) {
          console.error(`${utils.formatTime()} 机器人 ${bot} 的循环出错：${utils.errorText(error)}`);
          await Bun.sleep(pollMs);
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }


  /**
   * 照分派的结论安排：① 要打断的、确实在运行的会话写上 interrupt；
   * ② 新开就建工作区和会话，追加并换模型就改会话的模型；
   * ③ 这批排给会话（queued，记下分派记录）；④ 写分派记录、重写这批每条的消息文件（多出“分派”一段）。
   * @param messages 这一批。
   * @param record 分派记录。
   * @returns 会话 ID。
   * 副作用：写库、写文件。
   */
  private async place(
    messages: storeModule.MessageRow[],
    record: dispatchModule.DispatchRecord,
  ): Promise<string> {
    /** 机器人。 */
    const bot = messages[0]!.bot;
    /** 结论。 */
    const result = record.result;
    /** 这批最后一条。 */
    const lastId = messages.at(-1)!.id;

    //M ① 打断。
    for (const id of result.interrupt) {
      /** 要打断的会话。 */
      const target = this.store.getSession(id);
      if (target?.bot === bot && target.status === 'running') {
        this.store.updateSession(id, { interrupt: lastId });
      }
    }

    //M ② 新开，或者追加（要换模型就改）。
    /** 要追加的会话。 */
    let session = result.session === 'new' ? undefined : this.store.getSession(result.session);
    if (!session || session.bot !== bot) {
      result.workspace ||= '日常';
      try {
        await this.files.ensureWorkspace(bot, result.workspace, result.workspaceDescription);
      } catch (error) {
        //G 模型起的名字建不出文件夹：放进“日常”，话不能丢。
        record.checks.push(
          `工作区「${result.workspace}」建不出来，放进“日常”：${utils.errorText(error)}`,
        );
        result.workspace = '日常';
        await this.files.ensureWorkspace(bot, result.workspace, '');
      }
      /** 新会话的参数。 */
      const newSession = {
        bot,
        workspace: result.workspace,
        title: result.title || '（未命名）',
        model: result.model || this.resources.getDefaultModel() || '',
        thinking: result.thinking || null,
      };
      session = this.store.createSession(newSession);
    } else if (result.model && result.model !== session.model) {
      /** 换模型要改的字段。 */
      const modelChange = { model: result.model, thinking: result.thinking || null };
      session = this.store.updateSession(session.id, modelChange);
    }

    /** ⑤ 打印点要看的字段。 */
    const placedFields = () => ({
      session: session.id,
      title: session.title,
      workspace: session.workspace,
      model: session.model,
      kind: result.session === 'new' ? '新开' : '追加',
      messageIds: messages.map((row) => row.id),
    });
    await debug.point('⑤ 进会话', placedFields);

    //M ③ 排给会话；④ 写分派记录和消息文件：文件是写给人看的，写不成也不能挡住会话跑。
    this.store.queueMessages(messages.map((row) => row.id), session.id, record);
    this.reportQueued(messages, session.id, 'dispatch');
    try {
      await this.files.writeDispatch(
        this.store.getMessage(messages[0]!.id)!,
        record,
        session,
      );
      for (const row of messages) {
        await this.files.writeMessage(this.store.getMessage(row.id)!, session);
      }
    } catch (error) {
      console.error(
        `${utils.formatTime()} 消息 #${lastId} 的分派文件没写成：${utils.errorText(error)}`,
      );
    }
    return session.id;
  }

  /**
   * queueMessages 成功后报告真正的入队位置；分派结论、入队、开始执行分别记录。
   * @param messages 入队的原收件。
   * @param sessionId 实际目标会话（新建后已经是真实号）。
   * @param via 入队触发方式。
   * 副作用：仅记录事件；不决定是否启动会话。
   */
  private reportQueued(
    messages: storeModule.MessageRow[],
    sessionId: string,
    via: 'dispatch' | 'direct' | 'handoff',
  ): void {
    const session = this.store.getSession(sessionId);
    const last = messages.at(-1);
    const queuedAt = last ? this.store.getMessage(last.id)?.updatedAt : undefined;
    const data = {
      messageIds: messages.map((row) => row.id),
      queuedAt,
      via,
      targetBot: session?.bot,
      targetSession: sessionId,
      model: session?.model,
      thinking: session?.thinking,
      defaultModel: this.resources.getDefaultModel() ?? null,
      chars: messages.reduce((total, row) => total + row.text.length, 0),
    };
    this.events.emit('message.queued', data, {
      source: 'BotLoop',
      bot: last?.bot,
      sessionId,
      messageId: last?.id,
    });
  }


  /**
   * 强制执行：单独分派一次，把现状回复给用户；有要做的事就放进新会话跑起来。
   * @param row 这句话。
   * @returns 无；从不抛错，出错告诉用户。
   * 副作用：调模型；发回复；写库、写文件；跑会话。
   */
  private async forceRun(row: storeModule.MessageRow): Promise<void> {
    /**
     * 回复用户（引用他这条消息）。
     * @param text 回复。
     */
    const answer = async (
      text: string,
      generation = replyEvidence.programGeneration('force-dispatch-notice'),
    ): Promise<void> => {
      /** 引用他这条消息的回复地址。 */
      const quoteAddress = { ...row.address, quote: true };
      /** 只有发送成功才写入成功回复记录。 */
      const notice: storeModule.Reply = {
        at: Date.now(),
        session: {
          id: '',
          title: '',
          file: '',
        },
        text,
        generation,
        association: replyEvidence.association([row.id], 'target', '强制分派报告所回复的原消息'),
      };
      await this.deliverNotice(row, quoteAddress, notice);
    };
    try {
      //M ① 强制分派一次，拿到结论和要回复的现状。
      /** 分派的结论。 */
      const out = await this.dispatcher.forceDispatch(row.bot, row);
      /** 结论里的决定。 */
      const result = out.record.result;
      /** 小循环旧记录没有实际成功路由，报告即使含模型文字也不能用请求模型冒充。 */
      const reportGeneration = out.record.llm?.value?.report
        ? { ...replyEvidence.unknownGeneration(), purpose: 'force-dispatch-report' }
        : replyEvidence.programGeneration('force-dispatch-notice');
      /** ④ 打印点要看的字段。 */
      const decidedFields = () => ({
        session: result.session,
        title: result.title,
        model: result.model,
        thinking: result.thinking,
        by: result.by,
        ms: out.record.ms,
        reason: result.reason.slice(0, 80),
      });
      await debug.point('④ 分派出结论（强制）', decidedFields);

      //M ② 有待审核：卡片发到说话的这个渠道，用户当场就能点
      //M （用户 11-05：帮我查是不是审核卡住了，飞书上就能执行）。
      const approvals = this.approvals.list();
      for (const item of approvals.filter((approval) => approval.bot === row.bot)) {
        await this.out.sendApproval(row.channel, row.address, item, true).catch(() => []);
      }

      //M ③ 没有要做的事：关掉这条，回复现状。
      if (!out.run) {
        this.store.closeMessage(row.id);
        await answer(out.report, reportGeneration);
        return;
      }

      //M ④ 有要做的事：放进会话，回复现状，跑起来。
      /** 会话。 */
      const sessionId = await this.place([row], out.record);
      await answer(out.report, reportGeneration);
      await this.runner.runSession(sessionId);
    } catch (error) {
      this.store.closeMessage(row.id);
      await answer(`强制分派出错：${utils.errorText(error)}`);
    }
  }


  /**
   * 这句话是不是在回答待确认：程序先认明确的说法；
   * 认不出、只有一条待确认、又配了决策模型时问它，很有把握才算。
   * @param row 这句话。
   * @param pending 还在等的。
   * @returns 认出来的；不是就是 undefined。
   * 副作用：可能调决策模型。
   */
  private async readApprovalReply(
    row: storeModule.MessageRow,
    pending: approvalsModule.PendingApproval[],
  ): Promise<approvalsModule.ApprovalText | undefined> {
    //M ① 程序认明确的说法。
    /** 程序认的。 */
    const parsed = approvalsModule.parseApprovalText(row.text);
    //G 认出来了，或不具备问决策模型的条件：直接用程序认的。
    if (
      parsed
      || pending.length !== 1
      || !this.ai.hasDecision()
      || row.text.length > approvalsModule.MAX_REPLY_CHARS
      || row.text.includes('@')
    ) {
      return parsed;
    }

    //M ② 问决策模型，超时、出错都当没回答。
    /** 给决策模型看的现状。 */
    const state = {
      待确认的命令: pending[0]!.command,
      它做什么: pending[0]!.review.what,
      用户刚说的话: row.text,
    };
    /** 问决策模型的参数。 */
    const decideArgs = {
      state,
      questions: { reply: APPROVAL_QUESTION },
      purpose: 'approval',
      bot: row.bot,
    };
    /** 决策模型的回答；超时、出错都当没回答。 */
    const output = await Promise.race([
      this.ai.decide(decideArgs).catch(() => undefined),
      Bun.sleep(APPROVAL_TIMEOUT_MS).then(() => undefined),
    ]);

    //M ③ 概率够高才算。
    /** 这道题的回答。 */
    const answer = output?.answers.reply;
    if (answer?.type !== 'choice') {
      return undefined;
    }
    if ((answer.probabilities.approve ?? 0) >= APPROVAL_SURE) {
      return { kind: 'decide', approve: true };
    }
    if ((answer.probabilities.reject ?? 0) >= APPROVAL_SURE) {
      return { kind: 'decide', approve: false };
    }
    return (answer.probabilities.resend ?? 0) >= APPROVAL_SURE ? { kind: 'resend' } : undefined;
  }


  /**
   * 照用户的回答做：决定待确认，或者把卡片再发一次；回一句话，这条消息不再分派。
   * @param row 这句话。
   * @param answer 认出来的回答。
   * @param pending 还在等的。
   * @returns 这条处理了没有；false 是不算回答（点名的号不存在），照常分派。
   * 副作用：决定待确认；发卡片、发文字；写库、写文件。
   */
  private async applyApprovalReply(
    row: storeModule.MessageRow,
    answer: approvalsModule.ApprovalText,
    pending: approvalsModule.PendingApproval[],
  ): Promise<boolean> {
    /** 回用户的话。 */
    let text: string;
    if (answer.kind === 'resend') {
      //M ① 再发一次卡片；这个渠道发不了的，把内容写在文字里。
      /** 这个渠道发不了卡片的那些。 */
      const unsent: approvalsModule.PendingApproval[] = [];
      for (const item of pending) {
        /** 发出去的卡片。 */
        const sent = await this.out
          .sendApproval(row.channel, row.address, item, true)
          .catch(() => []);
        if (sent.length === 0) {
          unsent.push(item);
        }
      }
      if (pending.length === 0) {
        text = '现在没有待审核的命令。';
      } else {
        /** 发不了卡片的，每条一段文字。 */
        const unsentLines = unsent.map(
          (item) => `#${item.id}：${item.command}\n${item.review.what}`,
        );
        text = [
          `现在有 ${pending.length} 条待审核。`,
          ...unsentLines,
          '回复“同意 号”或“拒绝 号”。',
        ].join('\n');
      }
    } else {
      //M ② 同意或拒绝：先找出这句话说的是哪几条。
      /** 这句话可能说的那些：点名时是全部，没点名时只算卡着会话的（更新版本的卡片要点名或点按钮）。 */
      const candidates =
        answer.id === undefined ? pending.filter(approvalsModule.holdsSession) : pending;
      //G 没有可说的：“不行”“取消”这些就是普通的话，照常分派，不能吞掉。
      if (candidates.length === 0) {
        return false;
      }
      /** 这句话说的是哪几条：点名的那条；说全部、或者只有一条时是全部；否则不知道是哪条。 */
      let targets = answer.all || candidates.length === 1 ? candidates : [];
      if (answer.id !== undefined) {
        targets = candidates.filter((item) => item.id === answer.id);
        if (targets.length === 0) {
          return false;
        }
      }
      if (targets.length === 0) {
        /** 候选的每条一行。 */
        const candidateLines = candidates.map((item) => `#${item.id}：${item.command}`);
        text = [
          `现在有 ${candidates.length} 条待审核，要说是哪一条：`,
          ...candidateLines,
          '回复“同意 号”“拒绝 号”，或者“全部同意”“全部拒绝”。',
        ].join('\n');
      } else {
        //M ③ 决定。
        /** 从哪决定的。 */
        const by = `${row.channel.split(':')[0] ?? row.channel} 文字回复`;
        /** 决定了的号。 */
        const decided = targets
          .filter((item) => this.approvals.decide(item.id, answer.approve, by))
          .map((item) => `#${item.id}`);
        text = answer.approve
          ? `已同意待确认 ${decided.join('、')}，开始执行。`
          : `已拒绝待确认 ${decided.join('、')}，不执行。`;
      }
    }

    //M ④ 这条消息关掉，回一句话。
    this.store.closeMessage(row.id);
    /** 审批已经生效；通知失败单独记录，不撤回审批或伪造成功回复。 */
    const notice: storeModule.Reply = {
      at: Date.now(),
      session: {
        id: '',
        title: '',
        file: '',
      },
      text,
      generation: replyEvidence.programGeneration('approval-notice'),
      association: replyEvidence.association([row.id], 'target', '文字审批通知所回复的原消息'),
    };
    await this.deliverNotice(row, row.address, notice);
    return true;
  }


  /**
   * 挑出这一批里在回答待确认的（用户 11-05：卡片之外，打字也能放行）。
   * 别的消息一条都不挡，照常分派。
   * @param bot 机器人名。
   * @param batch 这一批。
   * @returns 还要分派的。
   * 副作用：同 applyApprovalReply。
   */
  private async takeApprovalReplies(
    bot: string,
    batch: storeModule.MessageRow[],
  ): Promise<storeModule.MessageRow[]> {
    /** 还要分派的。 */
    const rest: storeModule.MessageRow[] = [];
    for (const row of batch) {
      //M 每条：看这个机器人还在等什么，认它是不是回答，是就照回答做。
      /** 这个机器人还在等的。 */
      const pending = this.approvals.list().filter((item) => item.bot === bot);
      /** 用户的回答。 */
      /** 卡着会话的那些：问用户回答的是不是它们。 */
      const holding = pending.filter(approvalsModule.holdsSession);
      const answer = await this.readApprovalReply(row, holding);
      if (!answer || !(await this.applyApprovalReply(row, answer, pending))) {
        rest.push(row);
      }
    }
    return rest;
  }


  /**
   * 这批要等一条待确认有结果才能做：先不做，回复用户那条消息说明在等什么；
   * 用户决定后重新分派（AgentLoop.ts 的 SessionRun.afterDecision）。
   * @param batch 这一批。
   * @param record 分派记录。
   * @param id 要等的待确认。
   * @returns 无。
   * 副作用：写库、写文件；发一句回复。
   */
  private async holdForApproval(
    batch: storeModule.MessageRow[],
    record: dispatchModule.DispatchRecord,
    id: number,
  ): Promise<void> {
    /** 消息号。 */
    const ids = batch.map((row) => row.id);
    /** 要等的那条。 */
    const approval = this.approvals.list().find((item) => item.id === id);
    //G 分派的这一会儿用户已经决定了：不用等，重新分派。
    if (!approval || !this.approvals.hold(id, ids)) {
      this.store.holdMessages(ids, record);
      this.store.releaseMessages(ids);
      return;
    }

    //M 先不做：记下分派记录，回复这批最后一条。
    this.store.holdMessages(ids, record);
    /** 这批最后一条：回复它。 */
    const last = batch.at(-1)!;
    /** 要等的命令，截短。 */
    const commandText = utils.truncate(approval.command, 80);
    /** 回用户的话。 */
    const text = `这条先不做：它要等待审核 #${id}（${commandText}）有结果。你审核后我重新看这条。`;
    /** 引用它的回复地址。 */
    const quoteAddress = { ...last.address, quote: true };
    /** 等待状态已经落库；通知投递独立记录结果。 */
    const notice: storeModule.Reply = {
      at: Date.now(),
      session: {
        id: '',
        title: '',
        file: '',
      },
      text,
      generation: replyEvidence.programGeneration('approval-held'),
      association: replyEvidence.association(ids, 'batch', '等待审核的明确分派批次'),
    };
    await this.deliverNotice(last, quoteAddress, notice);
  }

  /**
   * 投递程序通知：发送成功才登记回复，失败写日志和事件，不回滚已经完成的审批或分派。
   * @param row 被回复的收件。
   * @param address 已确定的渠道回复地址。
   * @param reply 要发送并登记的完整回复。
   * @returns 无；失败在 reply.failed 事件中区分发送与记录阶段。
   */
  private async deliverNotice(
    row: storeModule.MessageRow,
    address: Record<string, unknown>,
    reply: storeModule.Reply,
  ): Promise<void> {
    /** 失败发生在哪一步，避免把发送失败与记录失败混为一谈。 */
    let stage: 'send' | 'persist' = 'send';
    try {
      await this.out.send(row.channel, address, reply.text);
      stage = 'persist';
      this.store.addReply(row.id, reply);
      /** 数据库里已登记成功回复，文件镜像失败不能抹掉这次事实。 */
      const message = this.store.getMessage(row.id)!;
      await this.files.writeMessage(message);
    } catch (error) {
      /** 明确记录失败原因；内容由事件总线统一脱敏。 */
      const reason = utils.errorText(error);
      const data = {
        stage,
        purpose: reply.generation?.purpose,
        error: reason,
      };
      const eventOptions = {
        source: 'BotLoop',
        bot: row.bot,
        messageId: row.id,
      };
      console.error('程序通知失败（' + stage + '，消息 #' + row.id + '）：' + reason);
      this.events.emit('reply.failed', data, eventOptions);
    }
  }

}
