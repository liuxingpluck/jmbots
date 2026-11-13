/**
 * 后端接口给的东西长什么样（和 src/channels/Http.ts、src/channels/HttpUi.ts 一一对应；那边改了这边跟着改）。
 * 网页只用相对地址和后端说话，不认识任何地址和端口。
 */


/** 后端算好的机器人状态；off（连不上后端）由网页自己显示。 */
export type BotStatus = 'waiting' | 'working' | 'idle';


/** GET /api/bots 的一项。 */
export interface BotView {
  /** 名字。 */
  name: string;
  /** 提示词语言：zh、en。 */
  language: string;
  /** 状态。 */
  status: BotStatus;
  /** 运行中的会话有几个。 */
  running: number;
  /** 还没进会话的消息有几条。 */
  queued: number;
  /** 待确认有几条。 */
  approvals: number;
}


/** GET /api/approvals 的一项：还在等用户点的命令。 */
/** 一件正在做（或刚做完）的事的进度（后端 src/capabilities/Progress.ts 的 ProgressView）。 */
export interface ProgressView {
  /** 卡片号。 */
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
  stage: string;
  /** 现在在做什么。 */
  action: string;
  /** 开始的时间，毫秒。 */
  startedAt: number;
  /** 结束的时间，毫秒；还在做是 undefined。 */
  endedAt?: number;
  /** 限时，分钟。 */
  limitMinutes?: number;
  /** 结束时的结果或收尾总结。 */
  result?: string;
}


/** 重新连接一家供应商的结果（POST /api/models/reconnect；后端是 src/capabilities/Model.ts 的 ReconnectResult）。 */
export interface ReconnectResult {
  /** 供应商名（config.yaml 的 providers 下的键）。 */
  provider: string;
  /** 连上了：清单拉到了。 */
  ok: boolean;
  /** 这家现在能用的模型个数；没连上时是原来的个数。 */
  models: number;
  /** 没连上的原因。 */
  error?: string;
}


export interface ApprovalView {
  /** 号。 */
  id: number;
  /** 哪个机器人的。 */
  bot: string;
  /** 哪个会话在等；空字符串是没有会话在等（更新版本的卡片）。 */
  sessionId: string;
  /** 卡片标题；不写就是“要执行一条命令”。 */
  title?: string;
  /** 要执行的命令；更新版本时是一句说明。 */
  command: string;
  /** 在哪个目录执行。 */
  workDir: string;
  /** 做什么、风险、建议。 */
  review: { what: string; risk: string; advice: string };
  /** 记下的时间，毫秒。 */
  createdAt: number;
}


/** 附件的四种。 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';


/** 文字里认出来的附件。 */
export interface Attachment {
  /** 绝对路径。 */
  path: string;
  /** 文件名。 */
  name: string;
  /** 哪一种。 */
  kind: AttachmentKind;
  /** 大小，字节；文件不在了是 null。 */
  size: number | null;
}


/** 分派简要：时间线上的事件行。 */
export interface DispatchBrief {
  /** 新开还是追加。 */
  action: 'new' | 'append';
  /** 进了哪个会话。 */
  sessionId: string;
  /** 会话标题。 */
  title: string;
  /** 会话 md 的路径。 */
  file: string;
  /** 分派定的模型；追加又没换模型时是空。 */
  model: string;
  /** 工作区。 */
  workspace: string;
  /** 谁定的：decision、llm、fallback、direct。 */
  by: string;
  /** 一句话理由。 */
  reason: string;
}


/** 一条回复。 */
export interface ReplyView {
  /** 发出的时间，毫秒。 */
  at: number;
  /** 哪个会话回的。 */
  session: { id: string; title: string; file: string };
  /** 回了什么（Markdown）。 */
  text: string;
  /** 回复里带的附件。 */
  attachments: Attachment[];
  /** 生成此句文本的调用证据，不能以分派或当前配置代替。 */
  generation: ReplyGeneration;
  /** 此句明确关联的来源消息及历史范围。 */
  association: ReplyAssociation;
}


/** 每句回复的生成证据；请求/发送档位不是供应商实际执行质量。 */
export interface ReplyGeneration {
  /** 模型直出、模型结果经程序包装、程序通知，或无法确认。 */
  kind: 'model' | 'model-wrapped' | 'program' | 'unknown';
  /** 成功生成调用的实际模型路径，包括真实回退；未知为空。 */
  model: string | null;
  /** 调用方请求的档位；未记录为空。 */
  thinkingRequested: string | null;
  /** SDK 归一化后发送的档位；未记录为空。 */
  thinkingSent: string | null;
  /** 供应商明确回报的执行档位；没有回报就为空。 */
  thinkingReported: string | null;
  /** 快照、唯一助手匹配、明确事件或未知。 */
  source: 'snapshot' | 'stored-assistant' | 'recorded-event' | 'unknown';
  /** 保存的调用用途；未记录为空。 */
  purpose: string | null;
  /** 当时的运行号；未记录为空。 */
  run: number | null;
  /** 当时的模型步骤；未记录为空。 */
  step: number | null;
  /** 对应助手消息的保存时刻，Unix 毫秒；未记录为空。 */
  assistantAt: number | null;
  /** 直接 reply 工具的调用号；非工具回复或未知为空。 */
  callId: string | null;
}


/** 明确关联的消息范围；旧运行/批次/单目标不能冒充新快照的一轮输入。 */
export interface ReplyAssociation {
  /** 由保存证据确认的消息号，不包括仅在同会话出现的其他消息。 */
  messageIds: number[];
  /** 新生成快照的一轮输入，或历史运行、批次、单消息。 */
  scope: 'turn' | 'run' | 'batch' | 'target';
  /** 后端简短说明此关联的记录来源。 */
  source: string;
}


/** 按明确消息号补取；不受当前分页的 before/after 游标影响。 */
export interface MessageResolution {
  /** 确实存在且归属于指定机器人的消息。 */
  messages: MessageView[];
  /** 未找到或不属于指定机器人的消息号。 */
  missingIds: number[];
}


/** 已脱敏的持久事件；网页只依赖数据结构，不引入 Bun 数据库模块。 */
export interface TraceEvent {
  /** 自增持久号，是时间线的排序依据。 */
  id: number;
  /** 原始事件名。 */
  type: string;
  /** 记录时间，Unix 毫秒。 */
  at: number;
  /** 报告事件的模块。 */
  source: string;
  /** 所属机器人；历史可能未记录。 */
  bot: string | null;
  /** 所属会话；分派前可能没有。 */
  sessionId: string | null;
  /** 所属消息；批次的全部消息号在 data 中。 */
  messageId: number | null;
  /** 原有去重键；普通执行事件没有。 */
  key: string | null;
  /** 已脱敏、截短的证据字段。 */
  data: Record<string, unknown>;
  /** 原有父事件号，未关联时为空。 */
  parent: number | null;
  /** 原有事件链深度。 */
  depth: number;
}


/** 回复追踪中的历史调用记录；只有会话和时间，不能当作这句回复的精确调用。 */
export interface TraceUsage {
  /** 调用完成记录时间，Unix 毫秒。 */
  at: number;
  /** 供应商。 */
  provider: string;
  /** 实际调用模型。 */
  model: string;
  /** 常规调用或分类决策。 */
  kind: string;
  /** 调用用途。 */
  purpose: string;
  /** 所属机器人；历史可能未记录。 */
  bot?: string;
  /** 所属会话；历史可能未记录。 */
  sessionId?: string;
  /** 输入 token。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** 缓存读取 token。 */
  cacheRead: number;
  /** 缓存写入 token。 */
  cacheWrite: number;
  /** 原有记录的费用，美元。 */
  cost: number;
  /** 实际调用耗时，毫秒。 */
  ms: number;
  /** 是否成功。 */
  ok: boolean;
  /** 原有错误片段；成功时没有。 */
  error?: string;
}


/** 分派记录中的一个实际阶段：决策模型、低思考模型、程序兜底，按走过的顺序各一档。 */
export interface TraceStage {
  /** 决策模型、低思考模型或程序兜底。 */
  kind: 'decision' | 'quick' | 'fallback';
  /** 模型身份；程序兜底或历史未保存时为空。 */
  model: string | null;
  /** 阶段开始时间，Unix 毫秒；未保存为空。 */
  startedAt: number | null;
  /** 阶段实测或完整调用记录合计，毫秒；来源见 msSource。 */
  ms: number | null;
  /** stage 是阶段实测；calls-sum 仅调用合计，不含工具与排队等间隔。 */
  msSource: 'stage' | 'calls-sum' | null;
  /** 是否采用该阶段的结论；历史不明确时为空。 */
  used: boolean | null;
  /** 保存的 why 或已核对结论，绝不使用思考全文。 */
  summary: string | null;
  /** 保存的错误片段；未出错或未保存为空。 */
  error: string | null;
  /** 分类选项的安全投影，不含题面或现状。 */
  options: {
    /** 保存的选项标签。 */
    label: string;
    /** 保存的目标会话；未明确为空。 */
    session: string | null;
    /** 保存的概率，0 到 1；未保存为空。 */
    probability: number | null;
  }[];
}


/** 分派记录的安全投影，保存的结论与各阶段证据分别展示。 */
export interface TraceDispatch {
  /** 原消息号。 */
  messageIds: number[];
  /** 实际开始时间，Unix 毫秒；缺失为空。 */
  startedAt: number | null;
  /** 分派总耗时，毫秒；缺失为空。 */
  ms: number | null;
  /** 当时保存的默认模型；不能用现在的配置倒推。 */
  defaultModel: string | null;
  /** 当时保存的实际选定模型；缺失为空。 */
  actualModel: string | null;
  /** 原始收件所属的机器人。 */
  targetBot: string;
  /** 真实入队会话或明确保存的目标；缺失为空。 */
  targetSessionId: string | null;
  /** 分派当时保存的工作区；缺失为空。 */
  workspace: string | null;
  /** 保存的分派结论。 */
  result: Record<string, unknown>;
  /** 程序检查与超时依据。 */
  checks: string[];
  /** 分类决策简要记录；未使用或未记录为空。 */
  decisionModel: Record<string, unknown> | null;
  /** 按实际保存顺序排列的阶段。 */
  stages: TraceStage[];
}


/** 后端 ReplyTraceView 的网页投影；离线测试检查两侧类型兼容。 */
export interface ReplyTraceView {
  /** 精确定位的回复，历史的运行号和步数可能为空。 */
  target: {
    /** 收件号。 */
    messageId: number;
    /** replies 数组真实下标，从 0 开始。 */
    replyIndex: number;
    /** 机器人。 */
    bot: string;
    /** 会话号，强制报告可能为空字符串。 */
    sessionId: string;
    /** 回复存储时间，Unix 毫秒。 */
    at: number;
    /** 回复短片段。 */
    text: string;
    /** 原回答总字符数，用于标识返回片段是否完整。 */
    textChars: number;
    /** 回复发送时保存的会话标题；未保存为空。 */
    sessionTitle: string | null;
    /** 当时分派记录中的工作区；未保存为空。 */
    workspace: string | null;
    /** 原收件文件路径，可由现有预览继续阅读。 */
    messageFile: string;
    /** 与聊天旁元信息使用相同的生成依据。 */
    generation: ReplyGeneration;
    /** 与聊天高亮使用相同的来源集合及范围。 */
    association: ReplyAssociation;
    /** 运行次数；历史未记录为空。 */
    run: number | null;
    /** 生成步数；历史未记录为空。 */
    step: number | null;
  };
  /** 新记录有运行及回复边界；历史仅按消息关联。 */
  scope: 'exact' | 'message-only';
  /** 后端明确说明的缺失或裁剪。 */
  notes: string[];
  /** 与回复明确关联的来源片段。 */
  sources: {
    /** 收件号。 */
    id: number;
    /** 原始渠道。 */
    channel: string;
    /** 渠道来源。 */
    source: string;
    /** 已脱敏短片段。 */
    text: string;
    /** 原消息总字符数，用于提示片段边界。 */
    textChars: number;
    /** 收到的时间，Unix 毫秒。 */
    createdAt: number;
    /** 可交给原有预览的消息文件路径。 */
    file: string;
  }[];
  /** 按持久号排列的已脱敏事件。 */
  events: TraceEvent[];
  /** 已保存分派的安全投影，不含完整提示词或模型思考。 */
  dispatches: TraceDispatch[];
  /** 同会话时间窗记录，不能精确归属回复。 */
  usage: TraceUsage[];
  /** 用量范围固定为会话时间窗。 */
  usageScope: 'session-window';
  /** 是否达到显示上限，详见 notes。 */
  truncated: boolean;
  /** 最早明确来源的接收时间，Unix 毫秒；缺失为空。 */
  startedAt: number | null;
  /** 成功回执时间，历史降级为回复存储时间，Unix 毫秒。 */
  endedAt: number;
  /** 结束时间来自保留的成功回执，还是仅来自回复入库记录。 */
  endSource: 'receipt' | 'reply-record';
  /** 真实起止差，毫秒；缺失或时钟倒退为空。 */
  elapsedMs: number | null;
}


/** GET /api/messages 的一条。 */
export interface MessageView {
  /** 消息号。 */
  id: number;
  /** 哪个机器人的。 */
  bot: string;
  /** 渠道：http，或 feishu:<应用 ID>。 */
  channel: string;
  /** 来源。 */
  source: string;
  /** 原话（附件是 @路径）。 */
  text: string;
  /** 状态：new、dispatching、queued、taken。 */
  status: string;
  /** 进了哪个会话。 */
  sessionId: string | null;
  /** 消息文件。 */
  file: string;
  /** 收到的时间，毫秒。 */
  createdAt: number;
  /** 最后改动的时间，毫秒。 */
  updatedAt: number;
  /** 原话里的附件。 */
  attachments: Attachment[];
  /** 回复。 */
  replies: ReplyView[];
  /** 分派简要；还没分派是 null。 */
  dispatch: DispatchBrief | null;
}


/** 取哪些消息：web 只要网页发的，other 只要别的渠道的。 */
export type MessageOrigin = 'web' | 'other';


/** GET /api/messages 的回答。 */
export interface MessagePage {
  /** 消息，按号从小到大。 */
  messages: MessageView[];
  /** 往前还有没有更早的。 */
  hasMore: boolean;
  /** 下次取变化用的游标（updatedAt，毫秒）。 */
  cursor: number;
}


/** 搜聊天命中的一条消息（GET /api/search，docs/界面/01_界面设计.md 6.1）。 */
export interface MessageHit {
  /** 消息号。 */
  id: number;
  /** 机器人。 */
  bot: string;
  /** 渠道。 */
  channel: string;
  /** 来源。 */
  source: string;
  /** 收到的时间，毫秒。 */
  createdAt: number;
  /** 消息文件（右栏打开它）。 */
  file: string;
  /** 进了哪个会话；没进是 null。 */
  sessionId: string | null;
  /** 命中的是原话还是某条回复。 */
  hit: 'text' | 'reply';
  /** 命中的那段。 */
  snippet: string;
}


/** 搜聊天命中的一个会话。 */
export interface SessionHit {
  /** 会话号。 */
  id: string;
  /** 机器人。 */
  bot: string;
  /** 工作区。 */
  workspace: string;
  /** 标题。 */
  title: string;
  /** 摘要里命中的那段（只有标题命中时是摘要开头）。 */
  snippet: string;
  /** 最后更新的时间，毫秒。 */
  updatedAt: number;
  /** 会话 md（右栏打开它）。 */
  file: string;
}


/** 搜聊天的结果。 */
export interface SearchResult {
  /** 命中的消息，新的在前。 */
  messages: MessageHit[];
  /** 命中的会话，最近更新的在前。 */
  sessions: SessionHit[];
}


/** 新建机器人填的东西（POST /api/bots，6.2）。 */
export interface NewBotInput {
  /** 名字（bots/ 下的文件夹名）。 */
  name: string;
  /** 一句话身份。 */
  identity: string;
  /** 语言。 */
  language: 'zh' | 'en';
  /** 默认模型；不选不写。 */
  model?: string;
  /** 飞书应用；不绑不写。 */
  feishu?: { app_id: string; app_secret: string };
}


/** 新建机器人的结果。 */
export interface NewBotResult {
  /** 建好了没有。 */
  ok: boolean;
  /** 建好的机器人。 */
  bot: { name: string; language: string };
  /** 飞书：“已连上”或“没连上：原因”；没填飞书时没有。 */
  feishu?: string;
}


/** 用量按什么切时间段：每小时、每天、每周、每月（按服务器本地时间）。 */
export type UsageBy = 'hour' | 'day' | 'week' | 'month';

/** 用量按什么分组：供应商、模型、用途（谁调的）、机器人。 */
export type UsageGroup = 'provider' | 'model' | 'purpose' | 'bot';


/** 用量表的一格：一个时间段里、一个分组的合计（docs/15_用量表.md 第 3 节）。 */
export interface UsageRow {
  /** 时间段：2026-11-07 10:00、2026-11-07、2026-W45、2026-11；按分组加起来的行是空的。 */
  period: string;
  /** 分组的值：供应商、模型、用途或机器人；按时间段加起来的行是空的。 */
  key: string;
  /** 调用次数（重试、换备用模型的每一次都算）。 */
  calls: number;
  /** 失败次数。 */
  failures: number;
  /** 输入 token。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** 缓存读 token。 */
  cacheRead: number;
  /** 缓存写 token。 */
  cacheWrite: number;
  /** 钱，美元。 */
  cost: number;
  /** 用时合计，毫秒。 */
  ms: number;
  /** 缓存命中率：缓存读 / (输入 + 缓存读)，0～1。 */
  hitRate: number;
}


/** GET /api/usage 的回答。 */
export interface UsageReport {
  /** 按什么切时间段。 */
  by: UsageBy;
  /** 按什么分组。 */
  group: UsageGroup;
  /** 从哪个时刻起，毫秒。 */
  from: number;
  /** 到哪个时刻（不含），毫秒。 */
  to: number;
  /** 每个时间段、每个分组一行，按时间段、分组排好。 */
  rows: UsageRow[];
  /** 全部加起来。 */
  totals: Omit<UsageRow, 'period' | 'key'>;
}


/** 一个会话的详情（GET /api/sessions/:id 的返回，src6/channels/HttpSessions.ts 的 getSession）。 */
export interface SessionDetail {
  /** 会话号。 */
  id: string;
  /** 哪个机器人的。 */
  bot: string;
  /** 工作区名。 */
  workspace: string;
  /** 标题。 */
  title: string;
  /** 摘要；还没写摘要时是空串。 */
  summary: string;
  /** 现在用的模型，完整 ID「供应商/模型」。 */
  model: string;
  /** 思考档；null 是用这个模型的最高档。 */
  thinking: string | null;
  /** 状态：idle、running、error。 */
  status: string;
  /** 上一次调模型时上下文多少 token。 */
  tokens: number;
  /** 每次运行一项。 */
  runs: SessionRunView[];
  /** 创建时间，毫秒。 */
  createdAt: number;
  /** 最后改动的时间，毫秒。 */
  updatedAt: number;
  /** 会话两个文件的路径。 */
  files: { md: string; json: string };
  /** 给人看的 md 全文；读不到是空串。 */
  md: string;
}


/** 会话详情里的一次运行（src6/services/SessionTypes.ts 的 SessionRun）。 */
export interface SessionRunView {
  /** 第几次，从 1 数。 */
  n: number;
  /** 开始时间，毫秒。 */
  startedAt: number;
  /** 结束时间，毫秒；还在跑时没有。 */
  endedAt?: number;
  /** 结局：done、interrupted、limit、error；还在跑时没有。 */
  ending?: string;
  /** 这次调了几次模型。 */
  steps: number;
}


/** 会话步骤的一项（GET /api/sessions/:id/steps，src6/services/SessionTypes.ts 的 StepRow）。 */
export interface SessionStep {
  /** 这个块里的第几步，从 1 数；顶层分派记录也占一个号。 */
  seq: number;
  /** 什么时候，毫秒。 */
  at: number;
  /** 状态表的哪一行：分派、E1…E12、恢复。 */
  row: string;
  /** 处理了什么事件。 */
  eventType: string;
  /** 事件带来的数据；不同行有不同键，展示时“有就显示、没有不崩”。 */
  event: Record<string, unknown>;
  /** 处理前会话的状态：idle、wait_response、run_tools、error。 */
  stateBefore: string;
  /** 处理后会话的状态。 */
  stateAfter: string;
  /** 存了什么；分派步是整份分派记录（src6/services/Dispatch.ts 的 DispatchRecord）。 */
  stored: Record<string, unknown>;
  /** 触发了什么。 */
  triggered: Record<string, unknown>;
}


/** 输入框上方的一个工作区标签；发送时变成 @绝对路径（docs/src6开发/G批_网页_设计.md 7.3）。 */
export interface WorkspaceTag {
  /** 绝对路径（文件或目录）。 */
  path: string;
  /** 显示的名字：文件名、文件夹名，或「<工作区名> 工作区」。 */
  label: string;
  /** 文件还是文件夹，决定图标。 */
  kind: 'file' | 'dir';
}
