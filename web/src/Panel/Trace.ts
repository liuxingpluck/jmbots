/**
 * 事件追踪的展示规则：Events.tsx 把后端证据交给 TracePresenter，得到可读的标题、时间和事实。
 * 这里只整理已有记录，不补造事件、不推测额度，也不请求模型或改执行状态。
 */
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 类别描述事件的依据；没有明确证据时使用 record，不强行归为模型决策。 */
export type TraceCategory = 'program' | 'model' | 'receipt' | 'record';


/** 一个可展开的数据字段。 */
export interface TraceFact {
  /** 后端原始字段名，便于在事件原文中定位。 */
  key: string;
  /** 给读者看的中文或译文。 */
  label: string;
  /** 只来自记录本身；缺值显示未记录。 */
  value: string;
}


/** 一条事件在时间线中的样子。 */
export interface TraceItem {
  /** 后端持久事件，按 id 排列，不因时钟变化重排。 */
  record: types.TraceEvent;
  /** 由事件类型及明确的 by 字段判断的类别。 */
  category: TraceCategory;
  /** 不仅用颜色表示类别，便于阅读和辅助技术识别。 */
  symbol: string;
  /** 类别文字。 */
  categoryText: string;
  /** 事件含义，未知事件保留原类型。 */
  title: string;
  /** 模型、工具、用时或错误的短概览。 */
  summary: string;
  /** 记录时钟的时分秒和毫秒。 */
  time: string;
  /** 带年月日的本地记录时间。 */
  fullTime: string;
  /** 与上一个持久事件的时间戳差，不代表某项操作的耗时。 */
  delta: string;
  /** 每个已记录字段的可读投影。 */
  facts: TraceFact[];
  /** 已明确记录失败；只影响提示样式，不改类别或执行结论。 */
  failed: boolean;
}


/** 某条消息最近一次明确入队的证据；仅在整理当前事件列表时使用。 */
interface QueuedMessage {
  /** 写入排队事件的持久号，用于显示推导依据。 */
  eventId: number;
  /** 真实 queueMessages 完成时间，Unix 毫秒。 */
  queuedAt: number;
}


/** 概览时间标签，只取决于现存的结束证据，不以关联范围代替回执。 */
export interface TraceTimingLabels {
  /** 完整回执用实测；只剩入库时间时明确称记录间隔。 */
  elapsedLabel: string;
  /** 结束时间点是真实回执还是回复记录。 */
  endLabel: string;
}


/** 长文本首屏摘要与可继续阅读的片段边界。 */
export interface TraceTextPreview {
  /** 压平空白后的短摘要，不包含自动生成的内容。 */
  summary: string;
  /** 是否需要展开当前片段或打开完整消息文件。 */
  expandable: boolean;
  /** 后端只返回原文片段时的提示；完整时为空。 */
  fragmentNotice: string | null;
}


/** 一个分派阶段的首屏信息，原有阶段顺序保持不变。 */
export interface TraceStageView {
  /** 对应的安全证据，用于展开概率和各调用。 */
  stage: types.TraceStage;
  /** 读者可见的阶段名。 */
  title: string;
  /** 模型或明确的未知标签。 */
  model: string;
  /** 已采用、未采用或未记录。 */
  used: string;
  /** 阶段实测或模型调用记录合计，不能混称。 */
  elapsedLabel: string;
  /** 以秒/分展示的保存耗时。 */
  elapsed: string;
  /** 精确毫秒供标题或展开核对。 */
  exactElapsed: string;
}


/**
 * 一次渲染共用一个展示器；转换结果无副作用，原始事件保持不变。
 * 翻译来自 I18n.useT；离线测试省略参数时使用中文原文。
 */
export class TracePresenter {
  /** @param t 界面当前语言的翻译函数，不执行任何外部请求。 */
  constructor(private readonly t: i18n.Translate = i18n.source) {}


  /**
   * 按持久化发送顺序整理事件，不按可能漂移的墙钟排序。
   * @param events 后端已关联、已脱敏的事件。
   * @returns 新的展示数组，不改变接口返回的数组。
   */
  items(events: types.TraceEvent[]): TraceItem[] {
    /** id 是 events 表自增号；时间仅用于显示和解释相邻差值。 */
    const ordered = events.toSorted((left, right) => left.id - right.id);
    const result: TraceItem[] = [];
    /** 每条消息可能被审核重新排队，只保留当前已读到的最后一次入队。 */
    const queuedMessages = new Map<number, QueuedMessage>();
    let previousAt: number | undefined;

    for (const record of ordered) {
      const category = this.category(record);
      const facts = this.facts(record.data, record.type);
      const queueWait = this.queueWait(record, queuedMessages);
      if (queueWait) {
        facts.push(queueWait);
      }
      const item: TraceItem = {
        record,
        category,
        symbol: this.symbol(category),
        categoryText: this.categoryText(category),
        title: this.title(record),
        summary: this.summary(record),
        time: this.timestamp(record.at, false),
        fullTime: this.timestamp(record.at, true, true),
        delta: this.delta(record.at, previousAt),
        facts,
        failed: record.data.ok === false || record.data.isError === true,
      };

      result.push(item);
      previousAt = record.at;
    }
    return result;
  }


  /**
   * 时间点按浏览器本地时区显示；首屏到秒，精确毫秒按需展开。
   * @param at Unix 毫秒，来自数据库记录。
   * @param withDate 是否显示年月日。
   * @param precise 是否保留精确毫秒，供原始证据核对。
   */
  timestamp(at: number | null, withDate = true, precise = false): string {
    const t = this.t;
    if (at === null || !Number.isFinite(at)) {
      return t('未记录');
    }

    const date = new Date(at);
    const two = (value: number): string => String(value).padStart(2, '0');
    const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
    const clock = [date.getHours(), date.getMinutes(), date.getSeconds()];
    const seconds = clock.map(two).join(':');
    const time = precise ? `${seconds}.${milliseconds}` : seconds;
    if (!withDate) {
      return time;
    }

    const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
    return `${day} ${time}`;
  }


  /** 保存的毫秒换成秒/分，首屏更易读；精确原值由 exactDuration 保留。 */
  duration(ms: number | null | undefined): string {
    const t = this.t;
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
      return t('未记录');
    }
    /** 一秒以下保留毫秒精度；更长的时间以十分之一秒阅读，原值不变。 */
    const seconds = ms < 1000 ? ms / 1000 : Math.round(ms / 100) / 10;
    if (seconds < 60) {
      return t('{seconds} 秒', { seconds });
    }

    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round((seconds - minutes * 60) * 10) / 10;
    return t('{minutes} 分 {seconds} 秒', { minutes, seconds: remainder });
  }


  /** 精确毫秒仅用于标题、证据详情和核对，不代替首屏的秒/分阅读单位。 */
  exactDuration(ms: number | null | undefined): string {
    const t = this.t;
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
      return t('未记录');
    }
    return t('{ms} 毫秒', { ms });
  }


  /** 将实际保存文本缩成摘要；是否片段由原始字符数判断，不假装当前片段是全文。 */
  textPreview(text: string, totalChars: number, max = 160): TraceTextPreview {
    const t = this.t;
    const flattened = text.replace(/\s+/g, ' ').trim();
    const summary = flattened.length > max ? `${flattened.slice(0, max)}…` : flattened;
    const fragment = totalChars > text.length;
    const fragmentNotice = fragment
      ? t('当前显示已保存片段；原文共 {count} 字，可在预览中继续阅读。', { count: totalChars })
      : null;

    return {
      summary: summary || t('没有文本内容'),
      expandable: fragment || flattened.length > max || text.includes('\n'),
      fragmentNotice,
    };
  }


  /** 只显示分派当时保存的 reason，不依据现有配置或后来的模型回答补写理由。 */
  dispatchReason(dispatch: types.TraceDispatch): string {
    const t = this.t;
    const reason = dispatch.result.reason;
    return typeof reason === 'string' && reason.trim()
      ? reason
      : t('当时的分派理由未记录。');
  }


  /** 阶段首屏保留采用状态与真实耗时来源，不把各次调用相加叫作阶段墙钟时间。 */
  stages(stages: types.TraceStage[]): TraceStageView[] {
    const t = this.t;
    return stages.map((stage) => {
      let title = t('程序兜底');
      if (stage.kind === 'decision') {
        title = t('决策模型阶段');
      } else if (stage.kind === 'quick') {
        title = t('低思考模型阶段');
      }

      let used = t('是否采用未记录');
      if (stage.used === true) {
        used = t('已采用');
      } else if (stage.used === false) {
        used = t('未采用');
      }

      let elapsedLabel = t('耗时来源未记录');
      if (stage.msSource === 'stage') {
        elapsedLabel = t('阶段实测');
      } else if (stage.msSource === 'calls-sum') {
        elapsedLabel = t('模型调用记录合计');
      }

      return {
        stage,
        title,
        model: stage.model || (stage.kind === 'fallback' ? t('程序规则') : t('模型未记录')),
        used,
        elapsedLabel,
        elapsed: this.duration(stage.ms),
        exactElapsed: this.exactDuration(stage.ms),
      };
    });
  }


  /** 分类概率只做显示换算；原始数值由控件 title 保留，未知不补零。 */
  probability(value: number | null): string {
    const t = this.t;
    if (value === null || !Number.isFinite(value)) {
      return t('未记录');
    }
    return `${Math.round(value * 1000) / 10}%`;
  }


  /** 合并首屏的历史缺口说明；完整 notes 留在单个折叠区。 */
  noteSummary(trace: Pick<types.ReplyTraceView, 'scope' | 'endSource' | 'events' | 'notes'>): string {
    const t = this.t;
    if (trace.scope === 'message-only') {
      return t('记录不完整，仅展示已保存部分。');
    }
    /** 后端第一条是统一只读说明，其后均为实际缺失或裁剪说明。 */
    const hasRecordedGaps = trace.notes.length > 1;
    if (trace.endSource === 'reply-record' || trace.events.length === 0 || hasRecordedGaps) {
      return t('部分事件缺失，按现存记录查看。');
    }
    return t('只读记录');
  }


  /**
   * 按真实结束证据选择标签；即使 scope=exact，回执过期后也只能称回复记录。
   * @param trace 后端给出的结束时间来源。
   * @returns 概览标签；不推测被清理的事件内容。
   */
  timingLabels(trace: Pick<types.ReplyTraceView, 'endSource'>): TraceTimingLabels {
    const t = this.t;
    if (trace.endSource === 'receipt') {
      return {
        elapsedLabel: t('端到端实测'),
        endLabel: t('回复回执'),
      };
    }
    return {
      elapsedLabel: t('接收到回复记录的间隔'),
      endLabel: t('回复记录'),
    };
  }


  /** 原始数据另行折叠，保留层次便于查看关联依据。 */
  raw(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }


  /** 只有明确证据才标模型决策；程序选择备用模型仍属程序规则。 */
  private category(record: types.TraceEvent): TraceCategory {
    const type = record.type;
    if (type === 'dispatch.decided') {
      const by = record.data.by;
      if (by === 'decision' || by === 'quick' || by === 'llm') {
        return 'model';
      }
      return by === 'fallback' ? 'program' : 'record';
    }
    if (type === 'review.decided') {
      const by = record.data.by;
      if (by === 'decision' || by === 'llm') {
        return 'model';
      }
      if (by === 'rule') {
        return 'program';
      }
      return by === 'user' ? 'receipt' : 'record';
    }
    if (type === 'tool.before') {
      return 'model';
    }
    if (type === 'message.received') {
      const source = record.data.source;
      return source === 'handoff' || source === 'review' ? 'program' : 'receipt';
    }
    if (type === 'search.done') {
      return record.data.kind === 'local' ? 'program' : 'receipt';
    }
    if (type === 'model.completed') {
      //G 只有 SDK 结果带 apiMs；本地校验异常也有完成事件，但不能冒充外部回执。
      return typeof record.data.apiMs === 'number' ? 'receipt' : 'program';
    }
    const receiptTypes = ['step.after', 'tool.after', 'reply.sent', 'agent.taken', 'agent.result'];
    if (receiptTypes.includes(type)) {
      return 'receipt';
    }
    const programTypes = [
      'step.before',
      'message.queued',
      'message.taken',
      'search.started',
      'reply.before',
      'dispatch.started',
      'dispatch.context',
      'limit.reached',
      'agent.queued',
      'agent.delivered',
      'turn.started',
    ];
    const programPrefixes = ['batch.', 'context.', 'run.', 'model.', 'compact.', 'gate.'];
    const programFamily = programPrefixes.some((prefix) => type.startsWith(prefix));
    if (programTypes.includes(type) || programFamily) {
      return 'program';
    }
    return 'record';
  }


  /** 形状和文字一起呈现，颜色仅作辅助。 */
  private symbol(category: TraceCategory): string {
    const symbols: Record<TraceCategory, string> = {
      program: '□',
      model: '◇',
      receipt: '○',
      record: '·',
    };
    return symbols[category];
  }


  /** 类别是程序对记录的说明，未知事件不会被悄悄当成某类决定。 */
  private categoryText(category: TraceCategory): string {
    const t = this.t;
    switch (category) {
      case 'program':
        return t('程序规则');
      case 'model':
        return t('模型决策');
      case 'receipt':
        return t('外部回执');
      case 'record':
        return t('事件记录');
    }
  }


  /** 事件名仅做翻译；默认保留新类型，避免界面漏掉后台新增的记录。 */
  private title(record: types.TraceEvent): string {
    const t = this.t;
    switch (record.type) {
      case 'message.received':
        return t('收到来源消息');
      case 'batch.taken':
        return t('结束合批等待，领走消息');
      case 'dispatch.started':
        return t('开始分派');
      case 'dispatch.context':
        return t('分派读取上下文');
      case 'dispatch.decided':
        return t('分派得出结论');
      case 'message.queued':
        return t('消息进入会话队列');
      case 'message.taken':
        return t('会话收走排队消息');
      case 'turn.started':
        return t('开始本轮用户输入');
      case 'run.started':
        return t('开始执行本次运行');
      case 'run.ended':
        return t('本次运行结束');
      case 'search.started':
        return t('开始检索');
      case 'search.done':
        return t('检索返回结果');
      case 'context.built':
        return t('准备本次模型上下文');
      case 'step.before':
        return t('准备下一步模型请求');
      case 'step.after':
        return t('收到本步模型结果');
      case 'model.queued':
        return t('模型请求排队');
      case 'model.started':
        return t('取得名额，开始调用模型');
      case 'model.completed':
        return t('模型调用结束');
      case 'model.retry':
        return t('连接重试等待');
      case 'model.retry.done':
        return t('连接重试等待结束');
      case 'model.fallback':
        return t('程序选择备用模型');
      case 'model.skipped':
        return t('跳过当前模型');
      case 'model.switched':
        return t('实际模型发生切换');
      case 'tool.before':
        return t('开始执行模型选择的工具');
      case 'tool.after':
        return t('工具返回结果');
      case 'reply.before':
        return t('向渠道发送回复');
      case 'reply.sent':
        return t('收到回复发送回执');
      case 'compact.done':
        return t('上下文压缩完成');
      case 'review.pending':
        return t('命令等待审核');
      case 'review.decided':
        return t('命令审核得到结论');
      case 'limit.reached':
        return t('运行达到时间上限');
      case 'gate.decided':
        return t('程序拦点得到结论');
      case 'agent.queued':
        return t('排入外部 AI 队列');
      case 'agent.taken':
        return t('外部 AI 认领（不等于开工）');
      case 'agent.result':
        return t('收到外部结果');
      case 'agent.delivered':
        return t('结果送回会话');
      default: return record.type;
    }
  }


  /** 相邻事件差值只是记录间隔；负值明确提示时钟倒退，仍保留 id 顺序。 */
  private delta(at: number, previousAt: number | undefined): string {
    const t = this.t;
    if (previousAt === undefined) {
      return t('起点');
    }

    const elapsed = at - previousAt;
    if (elapsed < 0) {
      return t('时钟回退 {ms} 毫秒', { ms: Math.abs(elapsed) });
    }
    return `+${this.duration(elapsed)}`;
  }


  /**
   * 记录实际入队证据，并在收走时按同一消息号相减，不能使用合批阈值。
   * @param record 当前按 id 顺序读到的事件。
   * @param queuedMessages 此前事件中明确写出的最后入队时刻。
   * @returns 只读推导事实；非入队/收走事件不增加事实。
   */
  private queueWait(
    record: types.TraceEvent,
    queuedMessages: Map<number, QueuedMessage>,
  ): TraceFact | undefined {
    const t = this.t;
    const fields = record.data;
    const messageIds = Array.isArray(fields.messageIds)
      ? fields.messageIds.filter((id): id is number => typeof id === 'number')
      : [];

    if (record.type === 'message.queued' && typeof fields.queuedAt === 'number') {
      for (const id of messageIds) {
        queuedMessages.set(id, { eventId: record.id, queuedAt: fields.queuedAt });
      }
      return undefined;
    }
    if (record.type !== 'message.taken') {
      return undefined;
    }

    /** 不用 record.at 冒充真正的收走时刻；旧事件缺 takenAt 就显示缺口。 */
    const takenAt = fields.takenAt;
    const lines: string[] = [];
    for (const id of messageIds) {
      const queued = queuedMessages.get(id);
      if (!queued || typeof takenAt !== 'number') {
        lines.push(t('消息 #{id}：入队或收走时间未记录', { id }));
        continue;
      }

      const elapsed = takenAt - queued.queuedAt;
      const duration = `${this.duration(elapsed)}（${this.exactDuration(elapsed)}）`;
      const start = this.timestamp(queued.queuedAt, true, true);
      const end = this.timestamp(takenAt, true, true);
      lines.push(t('消息 #{id}：{duration}', { id, duration }));
      lines.push(t('依据：#{queueEvent}.queuedAt {start} → #{takeEvent}.takenAt {end}', {
        queueEvent: queued.eventId,
        takeEvent: record.id,
        start,
        end,
      }));
    }

    const explanation = t('按同一消息的收走时间减去最新入队时间计算；不使用规则阈值。');
    return {
      key: 'derived.queueWait',
      label: t('会话队列实测等待'),
      value: [...lines, explanation].join('\n'),
    };
  }


  /** 概览只提取已记录的模型、工具、命中数、实际耗时和原因，不由错误码猜额度。 */
  private summary(record: types.TraceEvent): string {
    const t = this.t;
    const fields = record.data;
    const parts: string[] = [];
    /** 集合条数来自实际消息号；缺集合就不拿单条 messageId 猜批次大小。 */
    const ids = Array.isArray(fields.messageIds)
      ? fields.messageIds.filter((id): id is number => typeof id === 'number')
      : [];
    if (record.type === 'turn.started') {
      parts.push(t('本轮开始读取 {count} 条输入：{ids}', { count: ids.length, ids: ids.join('、') }));
    }
    if (record.type === 'message.received') {
      const channel = typeof fields.channel === 'string' ? fields.channel : t('渠道未记录');
      const source = typeof fields.source === 'string' ? fields.source : t('来源未记录');
      parts.push(t('{channel} · {source}', { channel, source }));
    }
    if (record.type === 'batch.taken' || record.type === 'message.taken') {
      const actor = record.bot || record.source;
      const session = record.sessionId || t('机器人收件队列');
      parts.push(t('{actor} 在 {session} 取走 {count} 条消息', { actor, session, count: ids.length }));
    }
    if (record.type === 'batch.taken' && typeof fields.startedAt === 'number' && typeof fields.endedAt === 'number') {
      const waited = this.duration(fields.endedAt - fields.startedAt);
      parts.push(t('最早消息已等待 {duration}', { duration: waited }));
    }
    if (record.type === 'message.queued') {
      const session = typeof fields.targetSession === 'string' ? fields.targetSession : record.sessionId;
      parts.push(t('{count} 条消息排入会话 {session}', { count: ids.length, session: session || t('未记录') }));
    }
    if (record.type === 'context.built' && typeof fields.contextCount === 'number') {
      parts.push(t('实际上下文 {count} 条', { count: fields.contextCount }));
    }
    if (typeof fields.chars === 'number') {
      parts.push(t('{count} 字符', { count: fields.chars }));
    }
    if (typeof fields.bytes === 'number') {
      parts.push(t('{count} 字节', { count: fields.bytes }));
    }
    if (typeof fields.model === 'string') {
      parts.push(fields.model);
    }
    if (typeof fields.tool === 'string') {
      parts.push(fields.tool);
    }
    if (typeof fields.ms === 'number') {
      parts.push(this.duration(fields.ms));
    }
    if (typeof fields.waitMs === 'number') {
      parts.push(t('模型排队 {duration}', { duration: this.duration(fields.waitMs) }));
    }
    /** 只有模型调用记录的设置才称请求/发送；分派目标配置不会被拿来当生成设置。 */
    if (record.type.startsWith('model.')) {
      const requested = fields.thinkingRequested ?? fields.thinkingAsked;
      const sent = fields.thinkingSent ?? fields.thinking;
      if (typeof requested === 'string') {
        parts.push(t('请求档位 {level}', { level: requested }));
      }
      if (typeof sent === 'string') {
        parts.push(t('发送档位 {level}', { level: sent }));
      }
    } else if (record.type === 'message.queued' && typeof fields.thinking === 'string') {
      parts.push(t('会话设置 {level}', { level: fields.thinking }));
    }
    if (typeof fields.hits === 'number') {
      parts.push(t('命中 {count} 条', { count: fields.hits }));
    }
    if (typeof fields.reason === 'string') {
      parts.push(fields.reason);
    }
    if (typeof fields.error === 'string') {
      parts.push(fields.error);
    }
    return parts.join(' · ');
  }


  /** 将保存的分派解释归回同一批、同一起点的真实事件，无法确认时留在历史入口。 */
  dispatchFor(record: types.TraceEvent, dispatches: types.TraceDispatch[]): types.TraceDispatch | undefined {
    if (record.type !== 'dispatch.decided' || !Array.isArray(record.data.messageIds)) {
      return undefined;
    }
    const ids = record.data.messageIds.filter((id): id is number => typeof id === 'number');
    const key = ids.toSorted((left, right) => left - right).join(',');
    return dispatches.find((dispatch) => {
      const dispatchKey = dispatch.messageIds.toSorted((left, right) => left - right).join(',');
      const startedAt = record.data.startedAt;
      const sameStart = typeof startedAt !== 'number' || dispatch.startedAt === null || startedAt === dispatch.startedAt;
      return key !== '' && key === dispatchKey && sameStart;
    });
  }


  /** 每个字段保留原名；复杂上下文独立成多行，避免挤成一行长 JSON。 */
  private facts(fields: Record<string, unknown>, eventType: string): TraceFact[] {
    const result: TraceFact[] = [];
    for (const [key, value] of Object.entries(fields)) {
      const fact: TraceFact = {
        key,
        label: this.fieldLabel(key, eventType),
        value: this.fieldValue(key, value),
      };

      result.push(fact);
    }
    return result;
  }


  /** 常见字段加业务含义，其余字段继续用原名，保持可核查。 */
  private fieldLabel(key: string, eventType: string): string {
    const t = this.t;
    switch (key) {
      case 'messageIds':
        return t('来源消息号');
      case 'run':
        return t('运行次数');
      case 'step':
        return t('模型步数');
      case 'model':
        return t('本次模型');
      case 'defaultModel':
        return t('配置默认模型');
      case 'requestedModel':
        return t('最初请求模型');
      case 'askedModel':
        return t('最初请求模型');
      case 'from':
        return t('原模型');
      case 'to':
        return t('目标模型');
      case 'tried':
        return t('实际尝试顺序');
      case 'by':
        return t('决定来自');
      case 'reason':
        return t('依据');
      case 'error':
        return t('记录的错误');
      case 'errorKind':
        return t('错误类别');
      case 'thinkingRequested':
      case 'thinkingAsked':
        return t('请求思考档位');
      case 'thinkingSent':
      case 'thinking':
        return t('发送／保存的思考设置');
      case 'thinkingReported':
        return t('供应商明确回报档位');
      case 'mergeMs':
        return t('合批静默规则（毫秒）');
      case 'maxWaitMs':
        return t('最早消息等待上限（毫秒）');
      case 'waits':
        return t('各消息实际等待');
      case 'ms':
        return t('实际耗时');
      case 'queueMs':
        return t('模型队列实际等待');
      case 'waitMs':
        return t('模型队列实际等待');
      case 'apiMs':
        return t('API 调用耗时');
      case 'delayMs':
        return t('重试间隔规则（毫秒）');
      case 'startedAt':
        return t('操作开始');
      case 'endedAt':
        return t('操作结束');
      case 'queuedAt':
        return t('实际入队');
      case 'until':
        return t('冷却截止');
      case 'coolingUntil':
        return t('冷却截止');
      case 'requestId':
        return t('请求编号');
      case 'attemptId':
        return t('尝试编号');
      case 'callId':
        return t('工具调用编号');
      case 'context':
        return t('实际上下文清单');
      case 'messages':
        return t('实际上下文消息');
      case 'promptFiles':
        return t('提示词文件');
      case 'promptChars':
        return t('提示词字符数');
      case 'systemChars':
        return t('系统提示词字符数');
      case 'contextCount':
        return t('实际上下文条数');
      case 'omitted':
        return t('清单未展开的条数');
      case 'fitted':
        return t('上下文是否裁剪');
      case 'chars':
        return t('文本字符数');
      case 'bytes':
        return t('文本字节数');
      case 'resultChars':
        return t('返回文本字符数');
      case 'outputChars':
        return t('返回文本字符数');
      case 'resultBytes':
        return t('返回文本字节数');
      case 'outputBytes':
        return t('返回文本字节数');
      case 'images':
        return t('图片数量');
      case 'input':
        return t('输入 token');
      case 'output':
        return t('输出 token');
      case 'cacheRead':
        return t('缓存读 token');
      case 'cacheWrite':
        return t('缓存写 token');
      case 'checks':
        return t('程序核对依据');
      case 'sessionId':
        return t('目标会话');
      case 'targetSession':
        return t('目标会话');
      case 'targetBot':
        return t('目标机器人');
      case 'via':
        return t('入队途径');
      case 'takenAt':
        return eventType.startsWith('agent.') ? t('外部认领时刻') : t('实际收走');
      case 'receivedAt':
        return t('外部结果接收');
      case 'executionStartedAt':
        return t('实际开始执行');
      case 'queuedToClaimMs':
        return t('排队到认领间隔');
      case 'claimedToResultMs':
        return t('认领到结果间隔');
      case 'lastReceivedAt':
        return t('批次最后接收');
      case 'tool':
        return t('工具');
      case 'args':
        return t('读取或执行参数');
      case 'result':
        return t('返回内容片段');
      case 'hits':
        return t('命中条数');
      case 'files':
        return t('涉及文件');
      case 'agent':
        return t('外部 AI');
      case 'taskId':
        return t('外部任务号');
      default: return key;
    }
  }


  /** 按字段含义处理时间和耗时；对象和数组保留结构，不显示 [object Object]。 */
  private fieldValue(key: string, value: unknown): string {
    const t = this.t;
    if (value === null || value === undefined) {
      return t('未记录');
    }
    if (typeof value === 'number') {
      const timestampFields = [
        'startedAt', 'endedAt', 'queuedAt', 'takenAt', 'lastReceivedAt', 'until', 'coolingUntil',
        'receivedAt', 'executionStartedAt',
      ];
      if (timestampFields.includes(key)) {
        return this.timestamp(value, true, true);
      }
      const durationFields = ['ms', 'queueMs', 'waitMs', 'apiMs', 'queuedToClaimMs', 'claimedToResultMs'];
      if (durationFields.includes(key)) {
        const readable = this.duration(value);
        const exact = this.exactDuration(value);
        return `${readable}（${exact}）`;
      }
    }
    if (typeof value === 'object') {
      return this.raw(value);
    }
    if (typeof value === 'boolean') {
      return value ? t('是') : t('否');
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    return t('未记录');
  }
}
