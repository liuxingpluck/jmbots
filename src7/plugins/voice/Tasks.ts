/** 语音转写的有序判断、收尾与任务派发。只处理已经转成文字的当前连接。 */

import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as channel from '../channels/index.ts';
import * as requests from '../../utils/RequestEvent.ts';
import type * as models from './Models.ts';
import type * as routes from './Routes.ts';

const CHANNEL = 'voice';
const LOCAL = 'local';
const CUSTOMER = 'voice:本机';
const WINDOW_MS = 60_000;
const RECENT_MAX = 5;
const TRANSCRIBED = '【语音转写，可能有错字】';
const SUPPLEMENT = '【补充】';

const question = {
  instructions: '下面是用户正在对着麦克风说的话，转写可能有错字或断句不全。'
    + '判断这段话是不是已经把一件可以交给机器人办的事说清楚了，现在开后台任务会不会白做。'
    + '只是闲聊、问候、自言自语、念叨、没说完、在跟旁边的人说话或念别的内容，都不算。'
    + '已经开过的事不要重复开。用户补充或修改上一件事时也可判断为已说清楚。',
  yes: '是，已经说清楚了一件可以现在就开任务去办的事',
  no: '不是，还是闲聊、没说完，或者不是对机器人说的',
};

export interface TaskSettings {
  /** 一次判断需要的最少字符数。 */
  minChars: number;
  /** 累积多少新字提前判断。 */
  stepChars: number;
  /** 有新字时最多等多久就判断。 */
  stepMs: number;
  /** 判断为通过的概率线。 */
  allowAt: number;
  /** 判断为拒绝的概率线。 */
  denyAt: number;
  /** 等决策回执的时长。 */
  timeoutMs: number;
  /** 每分钟允许的常规判断次数。 */
  maxPerMinute: number;
  /** 已开任务仍在运行时，补充可并入的时间。 */
  mergeWindowMs: number;
}

export interface Transcript {
  /** 从 1 开始的同连接句号。 */
  seq: number;
  /** 此刻整句文字。 */
  text: string;
  /** ASR 是否已确认句尾。 */
  final: boolean;
  /** 收到转写的时刻。 */
  at: number;
}

export interface VoiceTask {
  /** 本次派发的唯一识别号。 */
  taskId: string;
  /** 原始被接受的语音文字。 */
  text: string;
  /** 认领的机器人。 */
  bot: string;
  /** 是否继续仍在运行的任务。 */
  merged: boolean;
  /** 认领时回传的会话号。 */
  sessionId: string;
}

interface Sentence extends Transcript {
  /** 同一句的半句派发、最终入档和回话共享此编号。 */
  id: string;
  /** 半句得到认领后留下的后台会话。 */
  started?: Recent;
}

interface Snapshot {
  /** 当前一句。 */
  sentence: Sentence;
  /** 模型收到的文本快照，回执后核对是否仍是同一版。 */
  text: string;
  /** 判断时的字数。 */
  length: number;
  /** 取快照时，识别器是否已经确认这句。 */
  final: boolean;
}

/** 只在语音入档中使用的路由说明。 */
interface VoiceRouting extends channel.ChannelRouting {
  /** 提前开工对应的任务号（网页时间线记进地址的 voiceTaskId）。 */
  taskId?: string;
}

interface Flight {
  /** 正在发出的标准消息号。 */
  messageId: string;
  /** 由接收关口创建或选中的会话号。 */
  sessionId?: string;
  /** 消息协调完成前是否已收到收尾事件。 */
  settled: boolean;
}

interface Recent extends Flight {
  /** 此会话号供下一项复用。 */
  sessionId: string;
  /** 认领时刻的单调时间。 */
  at: number;
}

declare module 'cordis' {
  interface Events {
    /**
     * 仅在机器人认领语音任务后通知。
     * 谁发：src7/plugins/voice/Tasks.ts 的 VoiceTasks.dispatch
     * 谁接：暂无
     */
    'voice/task'(task: VoiceTask): void;
    /**
     * 语音最终句先进入网页的持久时间线，随后才发标准渠道事件。
     * sessionId 是这句接进的后台会话（半句已开工、或合并进上一句的）；waiting 是这句等不等机器人回话（只入档、没开工的不等）。
     * 谁发：src7/plugins/voice/Tasks.ts 的 VoiceTasks.dispatch、VoiceTasks.record
     * 谁接：src7/plugins/voice/Replies.ts 的 VoiceReplies.constructor；src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'voice/record'(message: channel.ChannelMessage, sessionId: string | undefined, waiting: boolean): void;
    /**
     * 没有最终字幕就失效的半句，取消关联回复等待。
     * 谁发：src7/plugins/voice/Tasks.ts 的 VoiceTasks.dispose
     * 谁接：src7/plugins/voice/Replies.ts 的 VoiceReplies.constructor
     */
    'voice/abandon'(messageId: string): void;
  }
}

/** 一次开始听到收尾之间的任务处理，确保同一时间只判断或派发一项。 */
export class VoiceTasks {
  private readonly sentences: Sentence[] = [];
  private readonly previousTasks: string[] = [];
  private readonly controller = new AbortController();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastJudgeAt = performance.now();
  private lastJudgeLength = 0;
  private rateStart = this.lastJudgeAt;
  private calls = 0;
  private sending?: Flight;
  private previous?: Recent;
  /** 网页浏览器对应的语音客户号；客户端未提供设备号时使用本机客户号。 */
  readonly customer: string;

  /**
   * 绑定当前机器人和已校验的判断配置，收取字幕并回传它创建的任务。
   * @param ctx 用于向决策、渠道和其他监听者发事件。
   * @param bot 这次听写选择的机器人名。
   * @param settings 判断触发、限速和合并参数。
   * @param onTask 将认领回执交给当前连接。
   * @param onFailure 通知当前连接本轮派发失败。
   * @param understand 用户可单独配置的语音理解模型。
   * @param report 回报实际使用的本地或云端理解线路。
   * @param device 网页保留的浏览器标识，缺省兼容旧网页。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly bot: string,
    private readonly settings: TaskSettings,
    private readonly onTask: (task: VoiceTask, messageId: string) => void,
    private readonly onFailure: () => void,
    private readonly understand?: models.Predict,
    private readonly report: (place?: routes.Place, reason?: string) => void = () => {},
    private readonly device?: string,
  ) {
    this.customer = CUSTOMER;
    if (device !== undefined) {
      this.customer = CHANNEL + ':' + device;
    }
  }

  /** 更新句子全文；pending 时先积累，等已有判断返回再读。 */
  push(event: Transcript): void {
    if (this.controller.signal.aborted) return;

    //M partial 和 final 共用一个 seq，final 只封住该句，继续保留后续的话。
    const last = this.sentences.at(-1);
    if (last?.seq === event.seq) {
      last.text = event.text;
      last.final = event.final;
    }
    if (last?.seq !== event.seq) {
      //M 在首个字幕到达时分配整句的消息号，最终版本沿用它。
      const id = 'voice_' + crypto.randomUUID();
      this.sentences.push({ ...event, id });
      if (this.sentences.length === 1 && this.pending === undefined) {
        this.lastJudgeAt = performance.now();
      }
    }

    //M 根据累计字数、间隔或强制收尾判断。
    this.schedule();
  }

  /** 换转写线路时撤掉尚未确认的旧字幕，保留已成功派发的前缀。 */
  invalidate(seq: number): void {
    const last = this.sentences.at(-1);
    if (last === undefined || last.final || last.seq !== seq) return;

    last.text = '';
    this.lastJudgeLength = 0;
    //G 正在判断的旧快照会在尝试派发前重新核对前缀。
    this.schedule();
  }

  /** 判断一条正在派发的标准消息是否属于此连接。 */
  isSending(messageId: string): boolean {
    return this.sending?.messageId === messageId;
  }

  /** 记录 bot/receive 选定的会话，捕获协调完成前的收尾。 */
  bind(messageId: string, sessionId: string): void {
    const current = this.sending;
    if (current?.messageId === messageId) {
      current.sessionId = sessionId;
    }
  }

  /** 收到本渠道的消息级结束或后台会话实际收尾，不再把新语音并入它。 */
  settle(messageId: string | undefined, sessionId: string | undefined): void {
    const current = this.sending;
    if (current !== undefined
      && (current.messageId === messageId || (sessionId !== undefined && current.sessionId === sessionId))) {
      current.settled = true;
    }
    const last = this.previous;
    if (last !== undefined && (last.messageId === messageId || last.sessionId === sessionId)) {
      last.settled = true;
    }
  }

  /** 停麦时等待现有判断和最终句收尾，之后释放本轮的文字。 */
  async finish(): Promise<void> {
    while (this.pending !== undefined) {
      await this.pending;
    }
    //M 最终判断和派发都处理完后清掉未用字幕及定时器。
    this.dispose();
  }

  /** 断开或替换时终止本轮判断等待，并清掉文字和定时器。 */
  dispose(): void {
    this.controller.abort();
    clearTimeout(this.timer);
    for (const sentence of this.sentences) {
      //G 不让丢失最终字幕的提前任务留下无主回复等待。
      const id = channel.makeChannelMessageId(CHANNEL, LOCAL, sentence.id);
      this.ctx.emit('voice/abandon', id);
    }
    this.sentences.length = 0;
    this.previousTasks.length = 0;
  }

  /** 按转写顺序处理各句，最终短句也会独立入档。 */
  private getSnapshot(): Snapshot | undefined {
    const sentence = this.sentences[0];
    if (sentence === undefined || (sentence.started !== undefined && !sentence.final)) return undefined;

    const text = sentence.text.trim();
    const length = [...text].length;
    if (length < this.settings.minChars && !sentence.final) return undefined;

    return { sentence, text, length, final: sentence.final };
  }

  /** 决定立刻判断还是安排单个定时回看；滚动语音不会积攒等待队列。 */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.controller.signal.aborted || this.pending !== undefined) return;

    //M 重新从最新字幕取候选，避免模型忙时每个 partial 都排一份。
    const snapshot = this.getSnapshot();
    if (snapshot === undefined) return;

    const now = performance.now();
    if (now - this.rateStart >= WINDOW_MS) {
      this.calls = 0;
      this.rateStart = now;
    }
    if (!snapshot.final) {
      const growth = snapshot.length - this.lastJudgeLength;
      if (growth <= 0 || this.calls >= this.settings.maxPerMinute) return;

      const wait = this.settings.stepMs - (now - this.lastJudgeAt);
      if (growth < this.settings.stepChars && wait > 0) {
        //M 新字较少时只安排一次定时回看，避免重复等待队列。
        this.timer = setTimeout(() => this.schedule(), wait);
        return;
      }
    }

    //M 字数、时间或句尾已满足条件，锁住直到回执和派发都处理完。
    this.calls += 1;
    this.lastJudgeAt = now;
    this.lastJudgeLength = snapshot.length;
    this.pending = Promise.resolve().then(() => this.handle(snapshot)).catch(() => {
      if (!this.controller.signal.aborted) {
        this.consume(snapshot.sentence);
        this.onFailure();
      }
    }).finally(() => {
      this.pending = undefined;

      //M 一次请求完成后立即看等待期间新收到的文字。
      this.schedule();
    });
  }

  /** 已开工和字数不足的最终字幕直接入档，其余保持原有判断。 */
  private async handle(snapshot: Snapshot): Promise<void> {
    const sentence = snapshot.sentence;
    if (snapshot.final && (sentence.started !== undefined || snapshot.length < this.settings.minChars)) {
      //M 历史记录保留整句，即使它短到没有达到开任务的条件。
      await this.record(sentence);
      return;
    }

    //M 只有一条判断在途，事件顺序与转写顺序一致。
    await this.judge(snapshot);
  }

  /** 依据当前快照请求决策，允许时派发；不确定只在句末放行。 */
  private async judge(snapshot: Snapshot): Promise<void> {
    let kind = 'voice';
    if (snapshot.final) {
      kind = 'voice-final';
    }
    let sinceLast: number | null = null;
    if (this.previous !== undefined) {
      sinceLast = (performance.now() - this.previous.at) / 1000;
    }
    const payload = {
      kind,
      question,
      state: {
        这段话: snapshot.text,
        是否一句话已说完: snapshot.final,
        已开过的任务: [...this.previousTasks],
        距上次开任务的秒数: sinceLast,
      },
      bot: this.bot,
      allowAt: this.settings.allowAt,
      denyAt: this.settings.denyAt,
    };
    const options = {
      prefix: 'voice',
      timeoutMs: this.settings.timeoutMs,
      signal: this.controller.signal,
      onFallback: () => ({ requestId: '', verdict: 'unsure' as const, reason: '没有决策插件或超时' }),
    };

    //M 配置专用理解模型时只判断这次字幕；原有部署继续使用决策事件。
    let verdict: 'allow' | 'deny' | 'unsure' = 'unsure';
    if (this.understand !== undefined) {
      const input = JSON.stringify(payload.state);
      const answer = await this.understand(question.instructions, input, options.signal, this.report);
      if (answer === true) {
        verdict = 'allow';
      }
      if (answer === false) {
        verdict = 'deny';
      }
    }
    if (this.understand === undefined) {
      //M 保持原有 decision 插件的置信度阈值和回执协议。
      const result = await requests.requestEvent(this.ctx, 'decision/judge', 'decision/judge-result', payload, options);
      verdict = result.verdict;
    }
    if (this.controller.signal.aborted) return;

    const sentence = snapshot.sentence;
    //G 识别器改写过半句时抛开旧判断，改用当前字幕。
    if (!sentence.text.startsWith(snapshot.text)) {
      this.lastJudgeLength = 0;
      return;
    }
    const allowed = verdict === 'allow' || (snapshot.final && verdict === 'unsure');
    if (allowed) {
      //M 等待判断期间可能已经说完，按当前状态选择提前派发或直接入档派发。
      await this.dispatch(sentence, snapshot.text);
      return;
    }
    if (snapshot.final) {
      //M 明确拒绝开工仍保留最终的用户发言。
      await this.record(sentence);
    }
  }

  /** 处理完一句才移除它，新到字幕还在有序队列里。 */
  private consume(sentence: Sentence): void {
    if (this.sentences[0] === sentence) {
      this.sentences.shift();
    }
    this.lastJudgeLength = 0;
  }

  /** 构造完整的标准消息，设备号和整句引用在提前派发时已确定。 */
  private getMessage(sentence: Sentence, text: string, routing: VoiceRouting): channel.ChannelMessage {
    const taskId = sentence.id;
    //M 半句派发和句尾入档共用同一个标准来源号。
    const messageId = channel.makeChannelMessageId(CHANNEL, LOCAL, taskId);
    const chatId = this.device ?? LOCAL;
    const address: channel.ChannelOrigin['address'] = {
      customer: this.customer,
      owner: true,
      voiceMessageId: messageId,
    };
    if (this.device !== undefined) {
      address['chatId'] = chatId;
    }
    return {
      v: 1,
      messageId,
      nativeId: taskId,
      channel: CHANNEL,
      accountId: LOCAL,
      chatId,
      chatType: 'local',
      sender: { id: 'owner', name: '语音' },
      role: 'owner',
      targetBots: [this.bot],
      mentions: [],
      rawText: sentence.text,
      text,
      attachments: [],
      createdAt: sentence.at,
      receivedAt: Date.now(),
      timeSource: 'received',
      replyTo: null,
      origin: { channel: CHANNEL, address },
      visibility: { scope: this.customer, trusted: true, publicSourceIds: [] },
      routing,
    };
  }

  /** 保留最终记录并告知历史索引，既有任务接收者无需再次处理。 */
  private async record(sentence: Sentence): Promise<void> {
    const started = sentence.started;
    const routing: VoiceRouting = { autoFinal: false };
    if (started !== undefined) {
      routing.taskId = sentence.id;
    }
    //M 将 ASR 修订后的整句作为入档和索引正文。
    const message = this.getMessage(sentence, sentence.text, routing);

    //M 先写网页时间线：开工了的接回原任务等回话，没开工的不等。
    const waiting = started !== undefined;
    this.ctx.emit('voice/record', message, started?.sessionId, waiting);

    //M 只入档的整句是“没叫机器人”的话，发 channel/listen：approval 不看；targetBots 置空，bots 不再收（开工的半句已经交过）。
    const heard: channel.ChannelMessage = { ...message, targetBots: [] };
    const control: channel.ChannelMessageControl = { claims: [] };
    await channel.emitInbound(this.ctx, heard, false, control);
    this.consume(sentence);
  }

  /** 已确定的整句走标准渠道，半句提早走相同的机器人认领入口。 */
  private async dispatch(sentence: Sentence, candidate: string): Promise<void> {
    const last = this.previous;
    const now = performance.now();
    const routing: VoiceRouting = { autoFinal: true };
    let prefix = TRANSCRIBED;
    if (last !== undefined && !last.settled && now - last.at <= this.settings.mergeWindowMs) {
      routing.sessionId = last.sessionId;
      prefix = SUPPLEMENT;
    }

    const final = sentence.final;
    let text = prefix + candidate;
    if (final) {
      text = sentence.text;
    }

    //M 半句：话还没说完先开工，标 partial，memory 等整句再记。
    if (!final) {
      routing.partial = true;
    }
    //M 保留句号与聊天号，供后台回话关联最终档案。
    const message = this.getMessage(sentence, text, routing);
    const { messageId } = message;
    const taskId = sentence.id;

    const control: channel.ChannelMessageControl = { claims: [] };

    //M 通知渠道认领，并允许接收关口把首次语音任务直接交给后台会话。
    const flight: Flight = { messageId, sessionId: routing.sessionId, settled: false };
    this.sending = flight;
    try {
      //M 整句：先写时间线（等回话），再发 channel/direct，approval 看批复、bots 认领。
      if (final) {
        this.ctx.emit('voice/record', message, routing.sessionId, true);
      }

      //M 整句、半句都发 channel/direct（语音是私聊）；半句带 partial，VoiceReplies 登记等整句入档，记忆不记。
      await channel.emitInbound(this.ctx, message, true, control);

      //M 整句处理完才移出队列；半句留着，等最终字幕再入档。
      if (final) {
        this.consume(sentence);
      }
    } finally {
      this.sending = undefined;
    }
    if (this.controller.signal.aborted) return;

    //G 审批已消费的语音不是新任务；没收到认领也不能显示已开。
    if (control.approvalHandled === true) return;

    //M 只从选定机器人的认领回执取会话号，供后续合并。
    const claimed = control.claims.find((entry) => entry.bot === this.bot && entry.sessionId !== undefined);
    const sessionId = claimed?.sessionId;
    if (sessionId === undefined) {
      this.onFailure();
      return;
    }

    //M 只有真正进入同一会话才标为合并。
    const merged = routing.sessionId === sessionId;
    const started = { messageId, sessionId, at: now, settled: flight.settled };
    this.previous = started;
    sentence.started = started;
    this.previousTasks.push(candidate);
    if (this.previousTasks.length > RECENT_MAX) {
      this.previousTasks.shift();
    }
    const task: VoiceTask = { taskId, text: candidate, bot: this.bot, merged, sessionId };
    //M 网页只展示机器人已认领的任务。
    this.onTask(task, messageId);
    this.ctx.emit('voice/task', task);
  }
}
