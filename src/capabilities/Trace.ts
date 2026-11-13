/**
 * 一句回复的只读证据：UiRoutes 调 ReplyTracer.read，合并已有消息、事件及用量。
 * 精确边界来自成功回复保存的 trace；旧消息只有来源关联，绝不以整个会话补齐因果链。
 * 不请求模型、不执行工具、不改变状态；输出短片段过密钥替身，系统提示词不进入此接口。
 */
import type * as secretsModule from './Secrets.ts';
import type * as storeModule from './Store.ts';
import * as checks from '../utils/Checks.ts';
import * as replyEvidence from './ReplyEvidence.ts';


/** 关联的原消息；原文过替身并限制大小，完整文件仍可由现有预览打开。 */
export interface TraceSource {
  /** 收件表的消息号。 */
  id: number;
  /** 原始渠道。 */
  channel: string;
  /** 渠道来源，用于合批。 */
  source: string;
  /** 原文短片段，最多 2000 字。 */
  text: string;
  /** 原消息字符数；超过片段上限时可经文件读取完整内容。 */
  textChars: number;
  /** 真正收到的时间，毫秒。 */
  createdAt: number;
  /** 消息文件绝对路径。 */
  file: string;
}


/** 分派证据的安全投影；不返回 state、system 或完整模型思考。 */
export interface TraceDispatch {
  /** 本次分派的来源消息号。 */
  messageIds: number[];
  /** 分派开始的时间，毫秒；缺记录是 null。 */
  startedAt: number | null;
  /** 分派实际耗时，毫秒；缺记录是 null。 */
  ms: number | null;
  /** 保存的结论，不含额外状态。 */
  result: Record<string, unknown>;
  /** 核对失败、超时等明确记录的依据。 */
  checks: string[];
  /** 决策模型的简要记录，历史没有就为 null。 */
  decisionModel: Record<string, unknown> | null;
  /** 常规模型小循环的简要记录，没走这一档为 null。 */
  llm: Record<string, unknown> | null;
  /** 只有历史记录或事件明确保存时才有，不拿当前配置倒推。 */
  defaultModel: string | null;
  /** 当时实际选择的会话模型；追加且没记模型时为空。 */
  actualModel: string | null;
  /** 真正接收这批消息的机器人，来自收件归属。 */
  targetBot: string;
  /** 真正入队的会话号，不用字面值 new 代替。 */
  targetSessionId: string | null;
  /** 当时保存的目标工作区，没有可靠分派记录时为空。 */
  workspace: string | null;
  /** 按原分派顺序排列的已记录决策、常规调用或兜底。 */
  stages: TraceStage[];
}


/** 决策模型曾考虑的去向；不包含题面、完整会话现状。 */
export interface TraceOption {
  /** 当时保存的选项标签，限制为短片段。 */
  label: string;
  /** 选项去向；new 表示提议新开，不是实际会话号。 */
  session: string | null;
  /** 已记录概率，范围 0～1；未记录不以零代替。 */
  probability: number | null;
}


/** 常规模型小循环的一步安全投影，不返回 thinking、system、state。 */
export interface TraceDispatchStep {
  /** 这一步准备调用的时刻，毫秒；未知为空。 */
  at: number | null;
  /** 保存的模型调用耗时，毫秒；不包含未记录的工具/排队间隔。 */
  ms: number | null;
  /** 保存的实际思考档位名称，不是思考正文。 */
  effort: string | null;
  /** 结构化结论中的理由/去向摘要，不从内部思考生成。 */
  summary: string | null;
  /** 实际调过的只读工具名称。 */
  tools: string[];
  /** 当时核对失败或调用错误的记录。 */
  error: string | null;
}


/** 一段已记录的分派过程；阶段时间与模型调用合计分开标注。 */
export interface TraceStage {
  /** 原有分派顺序中的类型。 */
  kind: 'decision' | 'llm' | 'fallback';
  /** 阶段调用的模型；程序兜底只在当时记录了目标模型时显示。 */
  model: string | null;
  /** 明确保存的阶段起点，毫秒；不从总起点或耗时倒算。 */
  startedAt: number | null;
  /** 实际阶段耗时或调用记录合计，见 msSource；未知为空。 */
  ms: number | null;
  /** stage 是记录的阶段时间，calls-sum 仅是模型调用耗时合计。 */
  msSource: 'stage' | 'calls-sum' | null;
  /** 明确记录为最终采用与否；没有依据时为空。 */
  used: boolean | null;
  /** 保存的 why、最终 reason 或结构化输出白名单摘要。 */
  summary: string | null;
  /** 已记录的失败/超时；不把下一阶段本身推断为出错。 */
  error: string | null;
  /** 分类模型的原选项概率，未记录为空数组。 */
  options: TraceOption[];
  /** 常规模型小循环的逐次调用，未记录为空数组。 */
  steps: TraceDispatchStep[];
}


/** 回复事件接口的目标，使用 messageId + replyIndex 定位，不猜正文或时间。 */
export interface TraceTarget {
  /** 所回复的收件号。 */
  messageId: number;
  /** replies 数组的下标，从 0 数。 */
  replyIndex: number;
  /** 机器人名。 */
  bot: string;
  /** 回复会话；强制报告可能没有，为空字符串。 */
  sessionId: string;
  /** 回复存储的时间，毫秒。 */
  at: number;
  /** 回复短片段。 */
  text: string;
  /** 原回复字符数，用于明确短片段与完整消息文件的边界。 */
  textChars: number;
  /** 回复发出时保存的会话标题；不取现在可能已改名的标题。 */
  sessionTitle: string | null;
  /** 当时分派记录明确的工作区；没有记录时为空。 */
  workspace: string | null;
  /** 含这句回复的完整消息文件路径，沿用原预览访问边界。 */
  messageFile: string;
  /** 第几次运行；历史未记录时是 null。 */
  run: number | null;
  /** 生成时的模型步数；历史未记录时是 null。 */
  step: number | null;
  /** 与聊天 ReplyView 相同的生成安全投影。 */
  generation: storeModule.ReplyGeneration;
  /** 与聊天高亮相同的明确来源范围，不包含整段会话其他输入。 */
  association: storeModule.ReplyAssociation;
}


/** 右侧追踪面板的数据；所有“未知”均显式保留。 */
export interface ReplyTraceView {
  /** 精确定位的回复。 */
  target: TraceTarget;
  /** exact 有运行和回复事件边界；message-only 只有消息关联。 */
  scope: 'exact' | 'message-only';
  /** 缺失、保存期限和截断说明，不能当作模型的解释。 */
  notes: string[];
  /** 明确读过或被回复的来源消息。 */
  sources: TraceSource[];
  /** 按持久 ID 向下排序的事件；最多 2000 条。 */
  events: storeModule.EventRow[];
  /** 各批来源消息保存的分派简要。 */
  dispatches: TraceDispatch[];
  /** 旧用量表同会话时间窗的记录，独立于精确事件。 */
  usage: storeModule.UsageRow[];
  /** 用量表没有回复号，始终不能精确归属。 */
  usageScope: 'session-window';
  /** 是否因上限裁剪了事件或用量；不能静默当成完整。 */
  truncated: boolean;
  /** 最早明确来源的收到时间，毫秒。 */
  startedAt: number | null;
  /** 成功发送事件的时间；历史降级为回复记录时间。 */
  endedAt: number;
  /** 结束时间的证据来源；事件过期时即使保留精确关联号，也只能使用回复记录时间。 */
  endSource: 'receipt' | 'reply-record';
  /** 真实起止相减的毫秒；来源不明或时钟倒退则为 null。 */
  elapsedMs: number | null;
}


/** 单次接口最多显示多少事件；查询多取一条确认截断。 */
const EVENT_LIMIT = 2000;


/** 只读聚合器；生命周期随一次 HTTP 查询，不保存执行状态。 */
export class ReplyTracer {
  /**
   * @param store 已打开的同一数据库，只调用读方法。
   * @param secrets 现有密钥替身；旧记录在输出前再过一遍。
   */
  constructor(
    private readonly store: storeModule.Store,
    private readonly secrets: secretsModule.Secrets,
  ) {}

  /**
   * 读取一条确定回复；无记录返回 undefined，HTTP 层据此回 404。
   * @param messageId 收件号。
   * @param replyIndex replies 下标。
   * @returns 真实证据和明确的缺失说明；不写库、不请求模型。
   */
  read(messageId: number, replyIndex: number): ReplyTraceView | undefined {
    /** 回复归属的原始收件；这里只读，数组下标保持存储时顺序。 */
    const message = this.store.getMessage(messageId);
    const reply = message?.replies[replyIndex];
    if (!message || !reply) {
      return undefined;
    }

    //M 1. 先确定关联能力；必须同时有运行起点和成功发送的持久边界。
    /** 回复发送时保存的不可变观察快照；旧版本没有。 */
    const trace = reply.trace;
    /** 两端都是持久事件号才有精确范围，单有会话号/运行号不够。 */
    const exact = trace?.runEventId !== undefined && trace.eventId !== undefined;
    /** 优先采用运行实际收走的消息；历史只能退到保存的批次引用。 */
    const evidence = new replyEvidence.ReplyEvidenceReader(this.store).read(message, reply);
    const sourceIds = evidence.association.messageIds;
    const sourceRows = sourceIds.map((id) => this.store.getMessage(id));
    const sources = sourceRows.filter((row): row is storeModule.MessageRow => {
      return row !== undefined && row.bot === message.bot;
    });

    //M 2. 只查这些消息，以及确定的运行；历史不纳入整段会话。
    /** 起点只约束会话运行；终点约束全部事件，防止混入同次运行的后一句回复。 */
    const query: storeModule.TraceEventQuery = {
      bot: message.bot,
      messageIds: sourceIds,
      sessionId: exact ? reply.session.id : undefined,
      run: exact ? trace.run : undefined,
      firstEventId: exact ? trace.turnEventId ?? trace.runEventId : undefined,
      rootEventId: exact ? trace.runEventId : undefined,
      lastEventId: exact ? trace.eventId : undefined,
      beforeAt: exact ? undefined : reply.at,
      limit: EVENT_LIMIT + 1,
    };
    /** 多取一条识别“最近 N 条”的裁剪，不能把局部窗口当作完整链条。 */
    let recordedEvents = this.store.traceEvents(query);
    /** 外部任务只有明确 taskId 才扩展上游，不能按相似标题或时间猜。 */
    const taskIds = this.taskIds(recordedEvents);
    if (taskIds.length > 0) {
      recordedEvents = this.store.traceEvents({ ...query, taskIds });
    }
    const events = recordedEvents.slice(-EVENT_LIMIT);
    const notes = this.notes(exact, trace, events, sourceIds.length - sources.length);

    //M 3. 耗时来自来源接收与回复回执；缺少来源或墙钟倒退都不猜。
    const startedAt = sources.length > 0 ? Math.min(...sources.map((row) => row.createdAt)) : null;
    /** 回复成功回执的记录时刻；事件被清理后只能退到原回复的存储时间。 */
    const sentEvent = trace?.eventId === undefined ? undefined : this.store.getEvent(trace.eventId);
    const receiptRecorded = sentEvent?.type === 'reply.sent' && sentEvent.data.ok === true;
    const endedAt = receiptRecorded ? sentEvent.at : reply.at;
    if (exact && !receiptRecorded) {
      notes.push('成功发送回执已缺失；结束时间只采用回复记录时间，不能确认渠道发送实测。');
    }
    const elapsedMs = startedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null;
    /** 旧用量只取同会话真实运行起点到回执的时间窗，仍不宣称精确归属。 */
    const usageFrom = this.usageFrom(reply, startedAt);
    const usage = reply.session.id ? this.store.listUsage(reply.session.id, usageFrom, endedAt) : [];
    const truncated = recordedEvents.length > EVENT_LIMIT || usage.length > 100;
    if (truncated) {
      notes.push('记录超过显示上限：最多保留最近 2000 条事件和 100 条同会话调用。');
    }
    if (elapsedMs === null) {
      notes.push('端到端耗时未确认：来源时间缺失或时钟发生倒退。');
    }

    const view: ReplyTraceView = {
      target: {
        messageId,
        replyIndex,
        bot: message.bot,
        sessionId: reply.session.id,
        at: reply.at,
        text: this.clip(reply.text),
        textChars: reply.text.length,
        sessionTitle: textOrNull(reply.session.title),
        workspace: this.replyWorkspace(message, reply),
        messageFile: message.file,
        run: trace?.run ?? null,
        step: trace?.step ?? null,
        generation: evidence.generation,
        association: evidence.association,
      },
      scope: exact ? 'exact' : 'message-only',
      notes,
      sources: sources.map((row) => this.sourceView(row)),
      events,
      dispatches: this.dispatches(sources, events),
      usage: usage.slice(-100),
      usageScope: 'session-window',
      truncated,
      startedAt,
      endedAt,
      endSource: receiptRecorded ? 'receipt' : 'reply-record',
      elapsedMs,
    };

    //G 旧数据可能在事件系统上线之前写入，整个安全投影最后再过替身。
    return JSON.parse(this.secrets.mask(JSON.stringify(view))) as ReplyTraceView;
  }

  /** 任务关联只认已记录的 agent.* 事件，不使用工具正文里的近似任务号。 */
  private taskIds(events: storeModule.EventRow[]): string[] {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.type.startsWith('agent.') && typeof event.data.taskId === 'string') {
        ids.add(event.data.taskId);
      }
    }
    return [...ids];
  }

  /** 缺失记录的说明不会补造规则、模型原因或历史因果。 */
  private notes(
    exact: boolean,
    trace: storeModule.ReplyTrace | undefined,
    events: storeModule.EventRow[],
    missingSources: number,
  ): string[] {
    const notes = ['只读历史记录，不触发重新执行。事件按持久化发送序号排列；时间差使用记录时钟。'];
    if (!exact) {
      notes.push('这条回复未保存完整运行/回执关联；只显示可关联的消息事件，不能确认完整事件链。');
    }
    if (events.length === 0) {
      notes.push('没有找到事件：可能是历史版本未记录、记录失败或已超过事件保留期限。');
    }
    const startEventId = trace?.turnEventId ?? trace?.runEventId;
    if (exact && !events.some((event) => event.id === startEventId)) {
      notes.push('运行起点事件已缺失；当前只能显示仍保留的记录。');
    }
    if (!trace?.contextEventId || !events.some((event) => event.id === trace.contextEventId)) {
      notes.push('实际送出的上下文清单未记录或已缺失；不能据会话当前内容倒推。');
    }
    if (missingSources > 0) {
      notes.push(`有 ${missingSources} 条来源消息已经不可读取。`);
    }
    return notes;
  }

  /** 原文仅投影允许显示的字段，不带渠道凭据和地址对象。 */
  private sourceView(row: storeModule.MessageRow): TraceSource {
    return {
      id: row.id,
      channel: row.channel,
      source: row.source,
      text: this.clip(row.text),
      textChars: row.text.length,
      createdAt: row.createdAt,
      file: row.file,
    };
  }

  /** 同会话用量只用真实运行起点和发送时间限定，仍不能当作回复精确关联。 */
  private usageFrom(reply: storeModule.Reply, fallback: number | null): number {
    const session = this.store.getSession(reply.session.id);
    const run = session?.runs.find((item) => item.n === reply.trace?.run);
    return run?.startedAt ?? fallback ?? reply.at;
  }

  /** 回复身份只使用发送时保存的标题和分派，不能用会话当前值倒推历史。 */
  private replyWorkspace(message: storeModule.MessageRow, reply: storeModule.Reply): string | null {
    if (message.sessionId !== reply.session.id) {
      return null;
    }
    const record = objectOf(message.dispatch);
    return textOrNull(objectOf(record.result).workspace);
  }

  /** 分派记录按原批次去重，白名单投影保证不会暴露提示词和完整状态。 */
  private dispatches(messages: storeModule.MessageRow[], events: storeModule.EventRow[]): TraceDispatch[] {
    const found = new Map<string, TraceDispatch>();
    for (const message of messages) {
      const record = objectOf(message.dispatch);
      const result = objectOf(record.result);
      if (Object.keys(result).length === 0) {
        continue;
      }
      const messageIds = numbersOf(record.messageIds);
      const decision = objectOf(record.decisionModel);
      const llm = objectOf(record.llm);
      const llmRequest = objectOf(llm.request);
      /** 默认/实际模型只认同一批保存的记录和事件，当前配置不会参与。 */
      const associated = this.dispatchEvents(events, messageIds);
      const startEvent = associated.find((event) => {
        return event.type === 'dispatch.started' && event.data.startedAt === record.startedAt;
      });
      const queuedEvent = associated.findLast((event) => {
        return event.type === 'message.queued' && event.sessionId === message.sessionId;
      });
      /** 历史核对记录只接受字符串，畸形字段不能进入界面的安全投影。 */
      const checks = Array.isArray(record.checks)
        ? record.checks.filter((value): value is string => typeof value === 'string')
        : [];
      /** 决策/常规模型都只投影身份、耗时和结论依据，不带输入正文。 */
      const decisionModel = Object.keys(decision).length > 0
        ? pick(decision, ['model', 'ms', 'error', 'used', 'why'])
        : null;
      const llmBrief = Object.keys(llm).length > 0 ? {
        model: llmRequest.model,
        error: llm.error,
        steps: Array.isArray(llm.steps) ? llm.steps.length : 0,
      } : null;
      const brief: TraceDispatch = {
        messageIds,
        startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
        ms: typeof record.ms === 'number' ? record.ms : null,
        result: pick(result, ['session', 'title', 'workspace', 'model', 'thinking', 'by', 'reason', 'waitFor']),
        checks,
        decisionModel,
        llm: llmBrief,
        defaultModel: textOrNull(record.defaultModel) ?? textOrNull(startEvent?.data.defaultModel),
        actualModel: textOrNull(result.model) ?? textOrNull(queuedEvent?.data.model),
        targetBot: message.bot,
        targetSessionId: this.targetSession(message, result),
        workspace: textOrNull(result.workspace),
        stages: this.dispatchStages(record, result),
      };
      const key = `${String(record.startedAt)}:${messageIds.join(',')}`;
      found.set(key, brief);
    }
    return [...found.values()];
  }

  /** 与原批次关联的事件；不以相邻时间或同会话猜测模型路径。 */
  private dispatchEvents(events: storeModule.EventRow[], ids: number[]): storeModule.EventRow[] {
    return events.filter((event) => {
      const eventIds = numbersOf(event.data.messageIds);
      return eventIds.some((id) => ids.includes(id)) || (event.messageId !== null && ids.includes(event.messageId));
    });
  }

  /** new 是提议，收件上保存的 sessionId 才是已入队的真实目标。 */
  private targetSession(message: storeModule.MessageRow, result: Record<string, unknown>): string | null {
    if (message.sessionId) {
      return message.sessionId;
    }
    const proposed = textOrNull(result.session);
    return proposed === 'new' ? null : proposed;
  }

  /** 阶段只按原调用顺序组织，不因模型响应文字而创造新的执行步骤。 */
  private dispatchStages(record: Record<string, unknown>, result: Record<string, unknown>): TraceStage[] {
    const stages: TraceStage[] = [];
    const decision = objectOf(record.decisionModel);
    if (Object.keys(decision).length > 0) {
      stages.push(this.decisionStage(decision));
    }
    const llm = objectOf(record.llm);
    if (Object.keys(llm).length > 0) {
      stages.push(this.llmStage(llm, result));
    }
    if (result.by === 'fallback') {
      stages.push({
        kind: 'fallback',
        model: textOrNull(result.model),
        startedAt: null,
        ms: null,
        msSource: null,
        used: true,
        summary: textOrNull(result.reason),
        error: null,
        options: [],
        steps: [],
      });
    }
    return stages;
  }

  /** 分类阶段保存了总体实测耗时、采用依据和概率，题面与 state 不参与输出。 */
  private decisionStage(decision: Record<string, unknown>): TraceStage {
    const rawOptions = Array.isArray(decision.options) ? decision.options : [];
    const options = rawOptions.map((value): TraceOption => {
      const option = objectOf(value);
      const probability = finiteOrNull(option.probability);
      return {
        label: this.shortText(option.label, 240) ?? '未记录',
        session: textOrNull(option.session),
        probability: probability !== null && probability <= 1 ? probability : null,
      };
    });
    const ms = finiteOrNull(decision.ms);
    return {
      kind: 'decision',
      model: textOrNull(decision.model),
      startedAt: finiteOrNull(decision.startedAt),
      ms,
      msSource: ms === null ? null : 'stage',
      used: typeof decision.used === 'boolean' ? decision.used : null,
      summary: this.shortText(decision.why, 1200),
      error: this.shortText(decision.error, 1200),
      options,
      steps: [],
    };
  }

  /** 小循环只保存每次模型 ms；其合计不冒充包含排队/工具的墙钟阶段耗时。 */
  private llmStage(llm: Record<string, unknown>, result: Record<string, unknown>): TraceStage {
    const rawSteps = Array.isArray(llm.steps) ? llm.steps : [];
    const steps = rawSteps.map((value) => this.dispatchStep(objectOf(value)));
    const allTimed = steps.length > 0 && steps.every((step) => step.ms !== null);
    const ms = allTimed ? steps.reduce((total, step) => total + (step.ms ?? 0), 0) : null;
    /** value 是程序核对通过的 JSON，保留的 reason 与去向可作为已记录结论。 */
    const accepted = objectOf(llm.value);
    const summary = this.resultSummary(accepted)
      ?? (result.by === 'llm' ? this.resultSummary(result) : null);
    return {
      kind: 'llm',
      model: textOrNull(objectOf(llm.request).model),
      startedAt: steps[0]?.at ?? null,
      ms,
      msSource: ms === null ? null : 'calls-sum',
      used: typeof result.by === 'string' ? result.by === 'llm' : null,
      summary,
      error: this.shortText(llm.error, 1200),
      options: [],
      steps,
    };
  }

  /** 逐步输出只解析可核查的结构化结论；自然语言/思考不被当成程序采用的决策。 */
  private dispatchStep(step: Record<string, unknown>): TraceDispatchStep {
    const rawText = textOrNull(step.text);
    const parsed = rawText && rawText.length <= 20_000 ? checks.extractJson(rawText) : undefined;
    const calls = Array.isArray(step.calls) ? step.calls : [];
    const tools = calls.map((call) => textOrNull(objectOf(call).name));
    return {
      at: finiteOrNull(step.at),
      ms: finiteOrNull(step.ms),
      effort: textOrNull(step.effort),
      summary: parsed ? this.resultSummary(parsed) : null,
      tools: tools.filter((tool): tool is string => tool !== null),
      error: this.shortText(step.error, 1200),
    };
  }

  /** 只选最终结构的理由与目标字段，不复制 thinking/system/state 或其他自由字段。 */
  private resultSummary(value: Record<string, unknown>): string | null {
    const reason = this.shortText(value.reason, 1000);
    const parts = reason ? [reason] : [];
    const fields: [string, string][] = [['workspace', '工作区'], ['session', '去向'], ['model', '模型']];
    for (const [key, label] of fields) {
      const text = this.shortText(value[key], 200);
      if (text) {
        parts.push(`${label}：${text}`);
      }
    }
    return parts.length > 0 ? parts.join('；') : null;
  }

  /** 输出片段保留原长提示，无法解析的历史字段保持为空。 */
  private shortText(value: unknown, limit: number): string | null {
    const text = textOrNull(value);
    if (text === null || text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}…（共 ${text.length} 字）`;
  }

  /** 短片段仍保留原长说明，不把截短内容当完整原文。 */
  private clip(text: string): string {
    const masked = this.secrets.mask(text);
    if (masked.length <= 2000) {
      return masked;
    }
    return `${masked.slice(0, 2000)}…（共 ${masked.length} 字）`;
  }
}


/** 历史 JSON 的对象边界；异常形状只当缺记录，不转成执行输入。 */
function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}


/** 缺失/空白文字保持未知，不拿空串冒充已记录的身份或模型。 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}


/** 数值记录只接受有限非负值；省略字段不以零代替。 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}


/** 只接受持久消息号，不把字符串或其他数据猜成关联。 */
function numbersOf(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is number => Number.isSafeInteger(item) && item > 0);
}


/** 安全投影只选择允许的字段；不递归展开历史记录中的请求。 */
function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      result[key] = value[key];
    }
  }
  return result;
}
