/**
 * 将一条轨迹（Trail）提炼为端到端「数据流转与状态变化」视图（TrailDataFlow）。
 * 同时兼容历史已落库轨迹（仅含基础 facts）与新增强轨迹（含提示词段数、工具数、前后状态等实测字段）：
 * 有真实 facts 时标记 source: 'real'，历史缺失字段按源码结构补齐说明并标记 source: 'schema'。
 */
import type {
  DataChange,
  DataField,
  StepDataFlow,
  Trail,
  TrailDataFlow,
  TrailRow,
  TrailStep,
} from '../../utils/Trail.ts';


//==========================================================
//M 常量映射表与跨步追踪上下文
//==========================================================

/** 骨架模块名集合。 */
const SKELETON_NODES = new Set(['main', 'resources', 'tools', 'sessions']);

/** 纯事件步骤对应的源码主函数名映射（当该步没有显式函数跟踪点时兜底定位）。 */
const EVENT_FN_NAMES: Record<string, string> = {
  'web-api/received': 'Timeline.insert',
  'web-api/replied': 'Timeline.reply',
  'channel/direct': 'emitInbound',
  'channel/mention': 'emitInbound',
  'channel/listen': 'emitInbound',
  'channel/reply': 'requestTextReply',
  'channel/replied': 'registerTextReply',
  'bot/receive': 'Bots.onChannelMessage',
  'memory/front-message': 'FrontDesk.onMessage',
  'session/before-model': 'Session.getStepAnswer',
  'session/after-model': 'Session.getStepAnswer',
  'session/before-tool': 'Tools.execute',
  'session/after-tool': 'Session.loop',
  'session/new-message': 'Session.append',
  'session/change': 'Session.change',
  'session/model-failed': 'Sessions.chat',
};

/** 实测变量英文键的人话解释。 */
const FACT_NOTES: Record<string, string> = {
  messageId: '收件表消息号或渠道标准消息号',
  bot: '处理本条消息的目标机器人',
  channel: '消息来源渠道标识',
  length: '文本字数（不暴露正文）',
  textLength: '输入文本字数',
  replyLength: '回话文本字数',
  replyCount: '该收件行累计回话条数',
  step: '该会话累计走过的模型步数（row.steps）',
  model: '本步请求的目标模型（供应商/模型）',
  thinking: '模型思考深度档位',
  sessionKind: '会话种类（front 前台 / work 后台等）',
  role: '新增对话消息角色（user / assistant / toolResult）',
  toolCalls: '模型在本步请求调用的工具清单',
  tool: '当前执行的工具名',
  failed: '该步或工具执行是否报错',
  stateBefore: '状态变更前的 Session.row.state',
  state: '当前状态值',
  status: 'web_messages 收件行状态（taken / replied）',
  table: '读写的数据表名',
  autoFinal: '一对一渠道零次调工具时是否自动兜底回话',
  targetSession: '请求显式指定的会话（未指定为没有）',
  turnMessages: '本轮新进入请求的消息条数',
  contextMessages: '从记忆归档拼入的最近往来条数',
  messageCount: '当前消息数组总条数',
  systemBefore: '进关口一前 system 提示词段数',
  systemAfter: '过关口一后 system 提示词段数',
  toolsCount: '本步提供给模型的可用工具个数',
  answeredByPlugin: '是否已由插件在关口一代调模型填好回答',
  answeredBy: '实际产出回答的模型标识',
  attachmentCount: '随消息上传并落入工作区的附件个数',
};

/** 跨步骤累积的上下文，让后续步骤知道前序收件号、会话状态与消息条数。 */
interface FlowTracker {
  messageId: number;
  bot: string;
  channel: string;
  session: string | null;
  sessionState: string;
  messageCount: number | undefined;
  replyCount: number;
  lastModel: string;
  lastTool: string;
  touchedWebTable: boolean;
  touchedSessions: boolean;
  touchedFrontArchive: boolean;
  touchedChatRequest: boolean;
  touchedTools: boolean;
  touchedChannelReply: boolean;
}

/** 单步解析出的中间结果（尚未连入下一步边之前）。 */
interface StepDraft {
  stage: string;
  summary: string;
  inVia: string;
  inType: string;
  outVia: string;
  outType: string;
  inputs: DataField[];
  changes: DataChange[];
}


//==========================================================
//M 对外主入口
//==========================================================

/**
 * 根据一条轨迹生成完整的端到端数据流转结构（兼容启动画布 boot 与消息画布）。
 * @param trail journal 收整后的轨迹对象。
 * @returns 供前端思维导图、总表与右栏详情直接渲染的数据流转结果。
 */
export function buildTrailDataFlow(trail: Trail): TrailDataFlow {
  if (trail.message === 0 || trail.channel === '启动') {
    return buildBootDataFlow(trail);
  }
  return buildMessageDataFlow(trail);
}


//==========================================================
//M 启动画布（boot）数据流转构建
//==========================================================

/** 构建启动录像（boot）的简洁数据流转链路。 */
function buildBootDataFlow(trail: Trail): TrailDataFlow {
  const steps: StepDataFlow[] = [];
  const total = trail.steps.length;

  for (let index = 0; index < total; index += 1) {
    const item = trail.steps[index]!;
    const prev = trail.steps[index - 1];
    const next = trail.steps[index + 1];
    const layer = getStepLayer(item.node);
    const skeletonFile = getSkeletonFile(item);
    const { fnName, fnSite } = pickPrimaryFn(item);
    const facts = mergeStepFacts(item.rows);
    const inputs = buildFactInputs(facts, trail.notes);
    const changes: DataChange[] = [];

    const newServices = asString(facts['newServices']);
    const newTools = asString(facts['newTools']);
    const mountState = asString(facts['state']);

    if (newServices !== '') {
      changes.push({
        target: 'cordis.Context 服务表',
        field: 'services',
        before: '已有服务',
        after: `+${newServices}`,
        note: `${item.node} 挂载并向全局上下文注册服务`,
        source: 'real',
      });
    }
    if (newTools !== '') {
      changes.push({
        target: 'Tools 工具登记表',
        field: 'specs',
        before: '已有工具',
        after: `+${newTools}`,
        note: `${item.node} 注册可供模型调用的工具定义`,
        source: 'real',
      });
    }
    if (mountState !== '') {
      changes.push({
        target: `pluginStatus[${item.node}]`,
        field: 'state',
        before: 'mounting',
        after: mountState,
        note: '记录插件启动阶段状态供 /api/health 与教程页查询',
        source: 'real',
      });
    }
    if (changes.length === 0) {
      let targetName = `插件 · ${item.node}`;
      if (layer === 'skeleton') {
        targetName = `骨架 · ${item.node}`;
      }
      changes.push({
        target: targetName,
        field: 'lifecycle',
        before: '待初始化',
        after: item.title || '初始化完成',
        note: '按配置顺序完成启动步骤',
        source: 'schema',
      });
    }

    let stage = '插件挂载';
    if (layer === 'skeleton') {
      stage = '骨架初始化';
    }
    if (hasRowNamed(item.rows, 'ready')) {
      stage = '广播 ready 开工';
    }
    if (hasRowNamed(item.rows, 'Http.listen')) {
      stage = 'HTTP 监听就绪';
    }

    const firstChange = changes[0]!;
    const summary = `${firstChange.target}: ${firstChange.before} → ${firstChange.after}`;
    let fromStep: number | null = null;
    let bootInVia = '进程入口';
    if (prev !== undefined) {
      fromStep = prev.no;
      bootInVia = '启动顺序装配';
    }
    let toStep: number | null = null;
    let toNode = '';
    let outVia = '';
    let outType = '';
    let outLabel = '';
    if (next !== undefined) {
      toStep = next.no;
      toNode = next.node;
      outVia = 'app.plugin / ready';
      outType = 'cordis.Context';
      outLabel = 'Context 继续挂载';
    }

    steps.push({
      step: item.no,
      node: item.node,
      layer,
      stage,
      fnName,
      fnSite,
      skeletonFile,
      summary,
      incoming: { fromStep, via: bootInVia, dataType: 'JmbotsConfig' },
      inputs,
      changes,
      outgoing: { toStep, toNode, via: outVia, dataType: outType, label: outLabel },
    });
  }

  return {
    steps,
    objects: [
      { name: 'JmbotsConfig', kind: 'memory', role: '启动入口校验后的全局只读配置快照' },
      { name: 'jmbots7.db', kind: 'table', role: 'Resources 打开的主 SQLite 数据库连接' },
      { name: 'cordis.Context', kind: 'memory', role: '承载骨架与各插件注册服务的依赖注入容器' },
      { name: 'Tools.specs', kind: 'memory', role: '各插件向骨架登记的模型工具定义表' },
      { name: 'ready', kind: 'event', role: '全部配置插件发起挂载后触发的开工信号' },
    ],
  };
}


//==========================================================
//M 消息画布（#1 → #N）数据流转构建
//==========================================================

/** 构建单条消息从入站、认领、骨架四道关口到回话落库的完整数据流转图。 */
function buildMessageDataFlow(trail: Trail): TrailDataFlow {
  const tracker: FlowTracker = {
    messageId: trail.message,
    bot: trail.bot,
    channel: trail.channel || 'http',
    session: trail.session,
    sessionState: 'idle',
    messageCount: undefined,
    replyCount: 0,
    lastModel: '',
    lastTool: '',
    touchedWebTable: false,
    touchedSessions: false,
    touchedFrontArchive: false,
    touchedChatRequest: false,
    touchedTools: false,
    touchedChannelReply: false,
  };

  const drafts: StepDraft[] = [];
  for (const step of trail.steps) {
    drafts.push(analyzeMessageStep(step, trail, tracker));
  }

  const steps: StepDataFlow[] = [];
  const total = trail.steps.length;
  for (let index = 0; index < total; index += 1) {
    const step = trail.steps[index]!;
    const draft = drafts[index]!;
    const prevDraft = drafts[index - 1];
    const prevStep = trail.steps[index - 1];
    const nextStep = trail.steps[index + 1];
    const nextDraft = drafts[index + 1];

    const layer = getStepLayer(step.node);
    const skeletonFile = getSkeletonFile(step);
    const { fnName, fnSite } = pickPrimaryFn(step);

    //M 入边优先衔接上一步算出的出边协议与数据类型，首步保留自身入口来源。
    let fromStep: number | null = null;
    let inVia = draft.inVia;
    let inType = draft.inType;
    if (prevStep !== undefined && prevDraft !== undefined) {
      fromStep = prevStep.no;
      if (inVia === '') {
        inVia = prevDraft.outVia;
      }
      if (inType === '') {
        inType = prevDraft.outType;
      }
    }

    //M 出边指向紧邻下一步；若下一步显式声明了触发入口（如 session/before-model 回调），优先对齐。
    let toStep: number | null = null;
    let toNode = '';
    let outVia = draft.outVia;
    let outType = draft.outType;
    let outLabel = formatEdgeLabel(outVia, outType);
    if (nextStep !== undefined && nextDraft !== undefined) {
      toStep = nextStep.no;
      toNode = nextStep.node;
      if (outVia === '') {
        outVia = nextDraft.inVia || '内部调用';
      }
      if (outType === '') {
        outType = nextDraft.inType || '上下文传递';
      }
      outLabel = formatEdgeLabel(outVia, outType);
    }

    steps.push({
      step: step.no,
      node: step.node,
      layer,
      stage: draft.stage,
      fnName,
      fnSite,
      skeletonFile,
      summary: draft.summary,
      incoming: { fromStep, via: inVia, dataType: inType },
      inputs: draft.inputs,
      changes: draft.changes,
      outgoing: { toStep, toNode, via: outVia, dataType: outType, label: outLabel },
    });
  }

  return {
    steps,
    objects: collectTouchedObjects(tracker),
  };
}


//==========================================================
//M 各节点类型的步骤剖析器
//==========================================================

/** 分析消息轨迹中的单步，提取阶段名、输入字段、前后数据变化与进出边类型。 */
function analyzeMessageStep(step: TrailStep, trail: Trail, tracker: FlowTracker): StepDraft {
  const facts = mergeStepFacts(step.rows);
  if (typeof facts['bot'] === 'string' && facts['bot'] !== '') {
    tracker.bot = facts['bot'];
  }
  if (typeof facts['channel'] === 'string' && facts['channel'] !== '') {
    tracker.channel = facts['channel'];
  }
  if (typeof facts['model'] === 'string' && facts['model'] !== '') {
    tracker.lastModel = facts['model'];
  }
  if (typeof facts['tool'] === 'string' && facts['tool'] !== '') {
    tracker.lastTool = facts['tool'];
  }

  const baseInputs = buildFactInputs(facts, trail.notes);

  if (step.node === 'web-api') {
    return analyzeWebApiStep(step, facts, baseInputs, tracker);
  }
  if (step.node === 'sessions') {
    return analyzeSessionsStep(step, facts, baseInputs, tracker);
  }
  if (step.node === 'tools') {
    return analyzeToolsStep(step, facts, baseInputs, tracker);
  }
  if (step.node === 'bots') {
    return analyzeBotsStep(step, facts, baseInputs, tracker);
  }
  if (step.node === 'channels') {
    return analyzeChannelsStep(step, baseInputs);
  }
  return analyzePluginStep(step, facts, baseInputs, tracker);
}


/** 解析 web-api 的三种步骤：收件入库、绑定会话号、写回回话。 */
function analyzeWebApiStep(
  step: TrailStep,
  facts: Record<string, string | number | boolean>,
  inputs: DataField[],
  tracker: FlowTracker,
): StepDraft {
  tracker.touchedWebTable = true;
  const msgTarget = formatWebMessageTarget(tracker.messageId);
  const hasAccept = hasRowNamed(step.rows, 'WebApi.accept');
  const hasInsert = hasRowNamed(step.rows, 'Timeline.insert') || hasRowNamed(step.rows, 'web-api/received');
  const hasBind = hasRowNamed(step.rows, 'Timeline.bindSession');
  const hasReply = hasRowNamed(step.rows, 'Timeline.reply') || hasRowNamed(step.rows, 'web-api/replied');

  //M 情况 1：写回网页收件表（Timeline.reply + web-api/replied）。
  if (hasReply) {
    tracker.touchedChannelReply = true;
    const prevCount = tracker.replyCount;
    const realCount = asNumber(facts['replyCount']);
    let nextCount = prevCount + 1;
    if (realCount !== undefined) {
      nextCount = realCount;
    }
    tracker.replyCount = nextCount;

    const len = asNumber(facts['replyLength']) ?? asNumber(facts['length']);
    const rawStatus = asString(facts['status']) || asString(facts['state']);
    const nextStatus = rawStatus || 'replied';
    let lenText = '1 条回话';
    if (len !== undefined) {
      lenText = `+1 条回话（${String(len)} 字，共 ${String(nextCount)} 条）`;
    }
    let statusNote = '会话已收尾，状态置为 replied，供网页 1.5s 轮询拉走展示气泡';
    if (nextStatus === 'taken') {
      statusNote = '模型在运行中途调工具先回一句，收件行保持 taken 等本轮彻底收尾';
    }

    const changes: DataChange[] = [
      {
        target: msgTarget,
        field: 'replies',
        before: `${String(prevCount)} 条`,
        after: lenText,
        note: 'Timeline.reply 把回复与模型生成依据写入 web_messages.replies JSON',
        source: pickSource(len !== undefined),
      },
      {
        target: msgTarget,
        field: 'status',
        before: 'taken',
        after: nextStatus,
        note: statusNote,
        source: pickSource(rawStatus !== ''),
      },
    ];
    let shortLen = '';
    if (len !== undefined) {
      shortLen = `(${String(len)}字)`;
    }
    return {
      stage: '写回网页收件表',
      summary: `${msgTarget}: 追加回话${shortLen} · status → ${nextStatus}`,
      inVia: 'channel/reply',
      inType: 'ChannelReplyRequest',
      outVia: 'GET /api/messages?after=游标',
      outType: 'StoredReply[]',
      inputs,
      changes,
    };
  }

  //M 情况 2：仅绑定会话号（emitInbound 返回后异步回写 session_id）。
  if (hasBind && !hasInsert && !hasAccept) {
    const shortSes = formatShortSession(tracker.session);
    addSchemaInputIfEmpty(inputs, 'session', shortSes, '认领这句消息的前台会话号', tracker.session !== null);
    const changes: DataChange[] = [{
      target: msgTarget,
      field: 'session_id',
      before: 'NULL',
      after: shortSes,
      note: '认领返回后把前台会话号绑定到收件行，后续回话凭它挂回原消息',
      source: pickSource(tracker.session !== null),
    }];
    return {
      stage: '绑定会话号',
      summary: `${msgTarget}.session_id: NULL → ${shortSes}`,
      inVia: 'emitInbound 返回',
      inType: 'ChannelClaimRecord',
      outVia: '等待模型返回',
      outType: 'AssistantMessage',
      inputs,
      changes,
    };
  }

  //M 情况 3：网页直接收件入库（WebApi.accept）或跨渠道同步入收件表（Timeline.insert + bindSession）。
  const statusVal = asString(facts['status']) || 'taken';
  const botVal = tracker.bot || '默认机器人';
  const changes: DataChange[] = [{
    target: msgTarget,
    field: 'status',
    before: '(新建)',
    after: `${statusVal} (待回话)`,
    note: `写入 web_messages 收件表并分配消息号 #${String(tracker.messageId)}，目标机器人：${botVal}`,
    source: pickSource(tracker.messageId > 0),
  }];

  if (hasAccept) {
    const realAutoFinal = facts['autoFinal'];
    let autoText = 'true';
    if (typeof realAutoFinal === 'boolean') {
      autoText = String(realAutoFinal);
    }
    changes.push({
      target: 'ChannelRouting',
      field: 'autoFinal',
      before: 'undefined',
      after: autoText,
      note: '网页属一对一私聊渠道，零次调回复工具时允许拿最终回答自动兜底',
      source: pickSource(typeof realAutoFinal === 'boolean'),
    });
  }
  if (hasBind) {
    const shortSes = formatShortSession(tracker.session);
    changes.push({
      target: msgTarget,
      field: 'session_id',
      before: 'NULL',
      after: shortSes,
      note: '同步将已认领的会话号绑定到该收件记录',
      source: pickSource(tracker.session !== null),
    });
  }

  let stage = '同步收件表';
  let inVia = 'bot/receive';
  let inType = 'ReceiveEvent';
  let outVia = 'Session.run';
  let outType = 'Session.row';
  if (hasAccept) {
    stage = '收件入库与分派';
    inVia = 'POST /api/message';
    inType = 'MessageBody';
    outVia = 'channel/direct';
    outType = 'ChannelMessage';
  }
  return {
    stage,
    summary: `${msgTarget}: 新建 → ${statusVal}（分派 ${botVal}）`,
    inVia,
    inType,
    outVia,
    outType,
    inputs,
    changes,
  };
}


/** 解析骨架 sessions 步骤（可由启动会话、关口一、模型代答/直调、关口二、关口四、收尾任意组合而成）。 */
function analyzeSessionsStep(
  step: TrailStep,
  facts: Record<string, string | number | boolean>,
  inputs: DataField[],
  tracker: FlowTracker,
): StepDraft {
  //G 特例：历史流水中 utils/RequestEvent.ts 发出的 channel/reply 会归在 sessions 道，单独识别为渠道回复请求。
  const onlyChannelReply = step.rows.length > 0 && step.rows.every((row) => row.name === 'channel/reply');
  if (onlyChannelReply) {
    tracker.touchedChannelReply = true;
    const listeners = collectStepListeners(step.rows);
    addSchemaInputIfEmpty(inputs, 'listeners', listeners.join('、') || '目标渠道', '接单的渠道适配器', true);
    return {
      stage: '请求渠道发出回复',
      summary: 'requestEvent: 发 channel/reply 等待渠道写出回执',
      inVia: 'requestTextReply',
      inType: 'ChannelReplyRequest',
      outVia: 'channel/reply',
      outType: 'ChannelReplyRequest',
      inputs,
      changes: [{
        target: 'ChannelReplyRequest',
        field: 'receipt',
        before: '待发送',
        after: '交目标渠道写出并等待 channel/replied',
        note: '经一问一答事件把纯文字回复交给对应渠道适配器',
        source: 'schema',
      }],
    };
  }

  tracker.touchedSessions = true;
  const changes: DataChange[] = [];
  let hasRunningStart = false;
  let hasUserMsg = false;
  let hasAfterTool = false;
  let hasBeforeModel = false;
  let hasModelAnswer = false;
  let hasToolCallAnswer = false;
  let terminalState = '';
  let beforeModelListeners: string[] = [];

  for (const row of step.rows) {
    const rFacts = row.facts;
    if (row.name === 'session/change' && rFacts['state'] === 'running') {
      hasRunningStart = true;
      const before = asString(rFacts['stateBefore']) || tracker.sessionState;
      tracker.sessionState = 'running';
      changes.push({
        target: 'Session.row',
        field: 'state',
        before,
        after: 'running',
        note: 'Session.run() 启动主循环，先落盘 running 并广播 session/change',
        source: 'real',
      });
    }

    if (row.name === 'session/new-message' && rFacts['role'] === 'user') {
      hasUserMsg = true;
      const prevCount = formatCountBefore(tracker.messageCount);
      const realCount = asNumber(rFacts['messageCount']);
      if (realCount !== undefined) {
        tracker.messageCount = realCount;
      }
      if (realCount === undefined && tracker.messageCount !== undefined) {
        tracker.messageCount += 1;
      }
      let afterText = '+1 条 user 消息';
      if (tracker.messageCount !== undefined) {
        afterText = `共 ${String(tracker.messageCount)} 条（+1 user）`;
      }
      changes.push({
        target: 'Session.row',
        field: 'messages',
        before: prevCount,
        after: afterText,
        note: '主循环开头把待接收箱 inbox 中的用户消息 append 进历史并存库',
        source: pickSource(tracker.messageCount !== undefined),
      });
    }

    if (row.name === 'session/after-tool') {
      hasAfterTool = true;
    }

    if (row.name === 'session/new-message' && rFacts['role'] === 'toolResult') {
      const toolName = asString(rFacts['tool']) || tracker.lastTool || '工具';
      const isErr = rFacts['failed'] === true;
      let statusWord = '成功';
      if (isErr) {
        statusWord = '报错 isError=true';
      }
      changes.push({
        target: 'Session.row',
        field: 'messages',
        before: `等待 ${toolName} 结果`,
        after: `+1 条 toolResult（${toolName} · ${statusWord}）`,
        note: '过关口四 session/after-tool 后将工具输出拼成 toolResult 消息存库，继续下一步循环',
        source: 'real',
      });
    }

    if (row.name === 'session/before-model') {
      hasBeforeModel = true;
      tracker.touchedChatRequest = true;
      beforeModelListeners = row.listeners;
      const sysBefore = asNumber(rFacts['systemBefore']);
      const toolsCount = asNumber(rFacts['toolsCount']);
      const kind = asString(rFacts['sessionKind']) || 'front';
      let toolsAfterText = '当前会话可用工具清单';
      if (toolsCount !== undefined) {
        toolsAfterText = `${String(toolsCount)} 个可用工具`;
      }
      let sysBeforeText = 'system: 0 段（初始空数组）';
      if (sysBefore !== undefined) {
        sysBeforeText = `system: ${String(sysBefore)} 段`;
      }

      changes.push({
        target: 'ChatRequest',
        field: 'tools',
        before: `按 kind="${kind}" 筛选`,
        after: toolsAfterText,
        note: '骨架调 Tools.listToolsForSessionKind 备好初始工具列表',
        source: pickSource(toolsCount !== undefined),
      });
      changes.push({
        target: 'ChatRequest',
        field: 'system[] / messages[]',
        before: sysBeforeText,
        after: `串行交给 ${String(row.listeners.length)} 个插件补提示词、记忆与上下文`,
        note: `关口一监听链：${row.listeners.join(' → ') || '无'}`,
        source: pickSource(sysBefore !== undefined),
      });
    }

    if (row.name === 'Session.loop') {
      tracker.touchedChatRequest = true;
      const modelName = asString(rFacts['model']) || tracker.lastModel || '默认模型';
      const msgCount = asNumber(rFacts['messageCount']);
      if (msgCount !== undefined) {
        tracker.messageCount = msgCount;
      }
      const sysAfter = asNumber(rFacts['systemAfter']);
      const toolsAfter = asNumber(rFacts['toolsCount']);
      if (sysAfter !== undefined) {
        let sysAfterText = `${String(sysAfter)} 段提示词`;
        if (toolsAfter !== undefined) {
          sysAfterText = `${sysAfterText} · ${String(toolsAfter)} 个工具`;
        }
        changes.push({
          target: 'ChatRequest',
          field: 'system[]',
          before: `${String(asNumber(rFacts['systemBefore']) ?? 0)} 段`,
          after: sysAfterText,
          note: '关口一各插件加工完毕后的最终请求规模',
          source: 'real',
        });
      }

      const provided = row.text === 'trace.sessions.answerProvided' || rFacts['answeredByPlugin'] === true;
      const answeredBy = asString(rFacts['answeredBy']) || modelName;
      if (provided) {
        changes.push({
          target: 'ChatRequest',
          field: 'answer',
          before: 'undefined',
          after: `插件已代调填好回答（${answeredBy}）`,
          note: '关口一末尾插件（如 model-catalog / relay / fake-model）已完成调用，骨架不再调第二次',
          source: 'real',
        });
      }
      if (!provided) {
        changes.push({
          target: 'ChatRequest',
          field: 'answer',
          before: 'undefined',
          after: `Sessions.chat 直调模型（${modelName}）`,
          note: '骨架经 Resources.getModel 与 pi-ai 发起对话请求（含指数退避重试）',
          source: 'real',
        });
      }
    }

    if (row.name === 'session/new-message' && rFacts['role'] === 'assistant') {
      hasModelAnswer = true;
      const toolCalls = asString(rFacts['toolCalls']);
      const modelUsed = asString(rFacts['model']) || tracker.lastModel;
      if (toolCalls !== '') {
        hasToolCallAnswer = true;
        tracker.lastTool = toolCalls;
        changes.push({
          target: 'Session.row',
          field: 'messages',
          before: '过关口二 session/after-model',
          after: `+1 条 assistant（请求工具：${toolCalls}）`,
          note: `模型（${modelUsed}）要求调用工具，存入历史后进入关口三执行工具`,
          source: 'real',
        });
      }
      if (toolCalls === '') {
        changes.push({
          target: 'Session.row',
          field: 'messages',
          before: '过关口二 session/after-model',
          after: `+1 条 assistant 最终回答（${modelUsed || '模型'}）`,
          note: '模型未请求工具，回答正式写入 Session.row.messages 并存库',
          source: 'real',
        });
      }
    }

    if (row.name === 'session/change' && rFacts['state'] !== 'running') {
      const endState = asString(rFacts['state']) || 'done';
      terminalState = endState;
      const before = asString(rFacts['stateBefore']) || tracker.sessionState;
      tracker.sessionState = endState;
      const replyLen = asNumber(rFacts['replyLength']);

      let replyAfterText = '模型最终回复文本';
      if (replyLen !== undefined) {
        replyAfterText = `最终回复（${String(replyLen)} 字）`;
      }
      changes.push({
        target: 'Session.row',
        field: 'state',
        before,
        after: endState,
        note: '本轮循环结束，状态与最终回复写入 jmbots7.db 的 sessions 表并广播 session/change',
        source: 'real',
      });
      changes.push({
        target: 'Session.row',
        field: 'reply',
        before: '""',
        after: replyAfterText,
        note: '供渠道监听方或零次回复兜底逻辑取走发回用户',
        source: pickSource(replyLen !== undefined),
      });
    }
  }

  //M 为纯关口一步骤补充直观输入说明，避免历史无 facts 时入口栏空白。
  if (hasBeforeModel && beforeModelListeners.length > 0) {
    addSchemaInputIfEmpty(inputs, 'listeners', beforeModelListeners.join('、'), '关口一串行询问的插件链', true);
  }
  if (tracker.session !== null) {
    addSchemaInputIfEmpty(inputs, 'session', formatShortSession(tracker.session), '当前运行的会话号', true);
  }

  return summarizeSessionsDraft({
    hasRunningStart,
    hasUserMsg,
    hasAfterTool,
    hasBeforeModel,
    hasModelAnswer,
    hasToolCallAnswer,
    terminalState,
    lastTool: tracker.lastTool,
    inputs,
    changes,
  });
}


/** 根据骨架 sessions 本步包含的子阶段合成阶段短名、一句话摘要与进出边。 */
function summarizeSessionsDraft(ctx: {
  hasRunningStart: boolean;
  hasUserMsg: boolean;
  hasAfterTool: boolean;
  hasBeforeModel: boolean;
  hasModelAnswer: boolean;
  hasToolCallAnswer: boolean;
  terminalState: string;
  lastTool: string;
  inputs: DataField[];
  changes: DataChange[];
}): StepDraft {
  //M 组合型阶段命名与摘要：按本步最重要的状态跃迁给出清晰标题。
  if (ctx.hasRunningStart && !ctx.hasBeforeModel && !ctx.hasModelAnswer) {
    return {
      stage: '骨架启动会话',
      summary: 'Session.row: idle → running · +1 条 user 消息入库',
      inVia: 'queueUserMessage + run()',
      inType: 'Session.row',
      outVia: 'session/new-message',
      outType: 'UserMessage',
      inputs: ctx.inputs,
      changes: ctx.changes,
    };
  }

  if (ctx.hasAfterTool && ctx.hasBeforeModel && !ctx.hasModelAnswer) {
    return {
      stage: '骨架关口四 → 下一轮关口一',
      summary: `Session.row: +toolResult(${ctx.lastTool || '工具'}) → 进入下一轮 before-model`,
      inVia: 'Tools.execute 返回',
      inType: 'ToolOutcome',
      outVia: 'session/before-model',
      outType: 'ChatRequest',
      inputs: ctx.inputs,
      changes: ctx.changes,
    };
  }

  if (ctx.hasBeforeModel && !ctx.hasModelAnswer && ctx.terminalState === '') {
    return {
      stage: '骨架关口一 · 备请求问插件',
      summary: 'ChatRequest: 备好工具清单与历史，串行交各插件补 system 与上下文',
      inVia: 'Session.loop',
      inType: 'Session.row',
      outVia: 'session/before-model',
      outType: 'ChatRequest',
      inputs: ctx.inputs,
      changes: ctx.changes,
    };
  }

  if (ctx.hasToolCallAnswer && ctx.terminalState === '') {
    return {
      stage: '骨架关口二 · 模型要求调工具',
      summary: `Session.row: 记下 assistant 回答 → 转调工具 ${ctx.lastTool}`,
      inVia: '模型返回 AssistantMessage',
      inType: 'ChatRequest',
      outVia: 'Tools.execute',
      outType: 'ToolCall',
      inputs: ctx.inputs,
      changes: ctx.changes,
    };
  }

  if (ctx.terminalState !== '') {
    return {
      stage: '骨架关口二 · 记回答收工',
      summary: `Session.row: running → ${ctx.terminalState} · 写入最终回答并广播收尾`,
      inVia: '模型返回 AssistantMessage',
      inType: 'AnsweredRequest',
      outVia: 'session/change',
      outType: 'Session (done)',
      inputs: ctx.inputs,
      changes: ctx.changes,
    };
  }

  const first = ctx.changes[0];
  let fallbackSummary = 'Session.row 状态更新';
  if (first !== undefined) {
    fallbackSummary = `${first.target}.${first.field}: ${first.before} → ${first.after}`;
  }
  return {
    stage: '骨架会话推进',
    summary: fallbackSummary,
    inVia: 'Session.loop',
    inType: 'Session.row',
    outVia: 'session/*',
    outType: 'Session',
    inputs: ctx.inputs,
    changes: ctx.changes,
  };
}


/** 解析骨架 tools 步骤（关口三 session/before-tool + Tools.execute）。 */
function analyzeToolsStep(
  step: TrailStep,
  facts: Record<string, string | number | boolean>,
  inputs: DataField[],
  tracker: FlowTracker,
): StepDraft {
  tracker.touchedTools = true;
  const toolName = asString(facts['tool']) || tracker.lastTool || '工具';
  tracker.lastTool = toolName;
  const listeners = collectStepListeners(step.rows);
  let resultAfter = `${toolName} 执行完毕，交回 ToolOutcome`;
  if (step.error || facts['failed'] === true) {
    resultAfter = `${toolName} 执行报错（isError: true）`;
  }

  const changes: DataChange[] = [
    {
      target: 'ToolCallGate',
      field: 'deny / stop',
      before: `待审工具 ${toolName}`,
      after: `通过关口三（${listeners.join('、') || '无拦截'}）`,
      note: 'Tools.execute 先发 session/before-tool 由 approval 与 bots 校验权限',
      source: 'real',
    },
    {
      target: 'ToolOutcome',
      field: 'text / isError',
      before: `调用 ${toolName}(arguments)`,
      after: resultAfter,
      note: '按工具 JSON Schema 校验参数后运行工具实现，不抛异常统一包成 ToolOutcome',
      source: 'real',
    },
  ];

  let outVia = '返回 ToolOutcome';
  let outType = 'ToolOutcome';
  if (toolName === 'channel_reply') {
    outVia = 'channel/reply';
    outType = 'ChannelReplyRequest';
  }
  return {
    stage: `骨架关口三 · 执行 ${toolName}`,
    summary: `Tools.execute: 过关口三并执行 ${toolName}`,
    inVia: 'Tools.execute(call)',
    inType: 'ToolCall',
    outVia,
    outType,
    inputs,
    changes,
  };
}


/** 解析 bots 插件步骤：前台认领、归档往来、拼最近上下文、零次回复兜底发送。 */
function analyzeBotsStep(
  step: TrailStep,
  facts: Record<string, string | number | boolean>,
  inputs: DataField[],
  tracker: FlowTracker,
): StepDraft {
  //M 情况 1：零次回复自动兜底（Dispatch.sendLastWords）。
  if (hasRowNamed(step.rows, 'Dispatch.sendLastWords')) {
    tracker.touchedChannelReply = true;
    const len = asNumber(facts['replyLength']) ?? asNumber(facts['length']);
    let lenDesc = 'Session.row.reply';
    if (len !== undefined) {
      lenDesc = `Session.row.reply（${String(len)} 字）`;
    }
    return {
      stage: '自动兜底回话',
      summary: `autoFinal 兜底: 取 ${lenDesc} 发 channel/reply`,
      inVia: 'session/change (done)',
      inType: 'Session',
      outVia: 'channel/reply',
      outType: 'ChannelReplyRequest',
      inputs,
      changes: [{
        target: 'ReplyControl',
        field: 'outcome',
        before: 'calledIds: []（本轮未调回复工具）',
        after: 'auto_final → 发出 channel/reply',
        note: '一对一私聊渠道开启了 autoFinal，直接将模型最终话语作为回话发出',
        source: 'real',
      }],
    };
  }

  //M 情况 2：关口一拼装前台最近往来（FrontDesk.onRequest）。
  if (hasRowNamed(step.rows, 'FrontDesk.onRequest')) {
    tracker.touchedFrontArchive = true;
    tracker.touchedChatRequest = true;
    const ctxCount = asNumber(facts['contextMessages']);
    const turnCount = asNumber(facts['turnMessages']);
    const hasCounts = ctxCount !== undefined && turnCount !== undefined;
    let afterMsg = '拼入最近往来背景 + 本轮消息';
    if (hasCounts) {
      afterMsg = `背景(${String(ctxCount)}条往来) + 本轮 ${String(turnCount)} 条`;
    }
    return {
      stage: '拼装前台上下文',
      summary: `ChatRequest.messages: ${afterMsg}`,
      inVia: 'session/before-model',
      inType: 'ChatRequest',
      outVia: '继续关口一插件链',
      outType: 'ChatRequest',
      inputs,
      changes: [
        {
          target: 'ChatRequest',
          field: 'messages',
          before: '会话原始消息副本',
          after: afterMsg,
          note: 'FrontDesk 从记忆归档取最近往来压成一条背景 system 消息放在本轮对话前',
          source: pickSource(hasCounts),
        },
        {
          target: 'ChatRequest',
          field: 'system[]',
          before: '已有提示词',
          after: '+机器人人设 persona.md 与渠道回复规范',
          note: 'bots 在关口一同步注入人设、派活说明与 channel_reply 提示',
          source: 'schema',
        },
      ],
    };
  }

  //M 情况 3：前台消息归档通知（memory/front-message）。
  if (step.rows.every((row) => row.name === 'memory/front-message')) {
    tracker.touchedFrontArchive = true;
    addSchemaInputIfEmpty(inputs, 'listeners', 'memory', '接收归档的记忆插件', true);
    return {
      stage: '归档前台往来',
      summary: '发 memory/front-message → 记入前台对话归档',
      inVia: 'session/new-message',
      inType: 'Message',
      outVia: 'memory/front-message',
      outType: 'FrontArchiveEntry',
      inputs,
      changes: [{
        target: 'front_archive',
        field: 'entries',
        before: '已有归档往来',
        after: '+1 条本轮往来记录',
        note: '通知 memory 插件持久化前台往来，供后续轮次拼最近背景与检索',
        source: 'schema',
      }],
    };
  }

  //M 情况 4：渠道认领与排入前台队列（Bots.receive / bot/receive / claimChannelMessage）。
  const shortSes = formatShortSession(tracker.session);
  return {
    stage: '机器人认领入队',
    summary: `bots 认领 → 排入 ${tracker.bot || '机器人'} 前台 ${shortSes}`,
    inVia: 'channel/direct',
    inType: 'ChannelMessage',
    outVia: 'queueUserMessage + run()',
    outType: 'Session.row',
    inputs,
    changes: [{
      target: 'Session.row.resultQueue',
      field: 'activeKey',
      before: 'idle（空闲）',
      after: `认领入队并唤醒前台 ${shortSes}`,
      note: '先问 bot/receive 确认无外部插件截走，再写入来源快照并调 Session.run()',
      source: pickSource(tracker.session !== null),
    }],
  };
}


/** 解析 channels 协议分拣步骤（channel/direct、channel/mention、channel/listen）。 */
function analyzeChannelsStep(step: TrailStep, inputs: DataField[]): StepDraft {
  const firstEvent = step.rows[0]?.name ?? 'channel/direct';
  const listeners = collectStepListeners(step.rows);
  addSchemaInputIfEmpty(inputs, 'listeners', listeners.join(' → '), '依次串行接棒的监听插件', listeners.length > 0);

  return {
    stage: '渠道协议分拣',
    summary: `emitInbound → 串行发出 ${firstEvent}`,
    inVia: 'emitInbound',
    inType: 'ChannelMessage',
    outVia: firstEvent,
    outType: 'ChannelMessage',
    inputs,
    changes: [{
      target: 'ChannelMessageControl',
      field: 'claims',
      before: 'claims: []',
      after: `经 ${firstEvent} 交 approval 查批复、bots 认领`,
      note: '按私聊、群内提及或群内只听分拣成对应渠道事件挨个询问',
      source: 'real',
    }],
  };
}


/** 解析其他业务插件步骤（如 feishu 入站、file-tools 挂图、context-fit 裁剪、memory 检索、relay 转交）。 */
function analyzePluginStep(
  step: TrailStep,
  facts: Record<string, string | number | boolean>,
  inputs: DataField[],
  tracker: FlowTracker,
): StepDraft {
  if (step.node === 'feishu' || step.node === 'wechat-kefu' || step.node === 'cli' || step.node === 'voice') {
    const srcId = asString(facts['messageId']);
    const afterEnvelope = srcId || '标准渠道消息信封';
    return {
      stage: `${step.node} 渠道收件`,
      summary: `${step.node} 收到平台消息 → 封装标准 ChannelMessage`,
      inVia: `${step.node} 平台事件`,
      inType: '平台原始消息',
      outVia: 'emitInbound',
      outType: 'ChannelMessage',
      inputs,
      changes: [{
        target: 'ChannelMessage',
        field: 'messageId',
        before: '平台原生回调包',
        after: afterEnvelope,
        note: '完成入站去重、识别提及与目标机器人，转为统一 ChannelMessage',
        source: pickSource(srcId !== ''),
      }],
    };
  }

  if (step.node === 'file-tools') {
    tracker.touchedChatRequest = true;
    return {
      stage: '挂载工作区图片',
      summary: `ChatRequest.messages: 解析 @路径 附入 ${String(step.rows.length)} 处图片内容`,
      inVia: 'session/before-model',
      inType: 'ChatRequest',
      outVia: '继续关口一插件链',
      outType: 'ChatRequest',
      inputs,
      changes: [{
        target: 'ChatRequest',
        field: 'messages',
        before: '含 @图片路径 的纯文本消息',
        after: `+${String(step.rows.length)} 处 ImageContent 图像块（仅改请求副本）`,
        note: '当前看图模型支持视觉输入时，把工作区图片读入本次模型请求',
        source: 'real',
      }],
    };
  }

  if (step.node === 'context-fit') {
    tracker.touchedChatRequest = true;
    return {
      stage: '上下文窗口裁剪',
      summary: 'ChatRequest.messages: 按模型窗口预算裁剪或压缩历史',
      inVia: 'session/before-model',
      inType: 'ChatRequest',
      outVia: '继续关口一插件链',
      outType: 'ChatRequest',
      inputs,
      changes: [{
        target: 'ChatRequest',
        field: 'messages',
        before: '超长历史副本',
        after: '裁剪旧工具输出/压缩摘要以装入模型上下文窗口',
        note: '只裁剪本次发往模型的请求副本，数据库完整历史原样保留',
        source: 'real',
      }],
    };
  }

  const label = step.title || `${step.node} 处理`;
  return {
    stage: `${step.node} 协同处理`,
    summary: `${step.node}: ${label}`,
    inVia: step.rows[0]?.name ?? '事件回调',
    inType: '插件上下文',
    outVia: '继续后续步骤',
    outType: '插件上下文',
    inputs,
    changes: [{
      target: `插件 · ${step.node}`,
      field: 'state',
      before: '收到事件',
      after: label,
      note: '插件在当前阶段完成扩展处理',
      source: 'schema',
    }],
  };
}


//==========================================================
//M 辅助工具函数
//==========================================================

/** 判断节点属于骨架还是插件。 */
function getStepLayer(node: string): 'skeleton' | 'plugin' {
  if (SKELETON_NODES.has(node)) return 'skeleton';
  return 'plugin';
}


/** 识别骨架步骤对应的「骨架逐行」文档名（Main / Resources / Tools / Sessions）；插件或纯工具层返回空串。 */
function getSkeletonFile(step: TrailStep): string {
  if (!SKELETON_NODES.has(step.node)) return '';

  if (step.node === 'main') return 'Main';
  if (step.node === 'resources') return 'Resources';
  if (step.node === 'tools') return 'Tools';

  //G sessions 道：核对行位置确实来自 Sessions.ts 或 Main.ts，排除仅含 utils/RequestEvent.ts 的情况。
  if (step.rows.some((row) => /(?:^|\/)Sessions\.ts:/u.test(row.site))) return 'Sessions';
  if (step.rows.some((row) => /(?:^|\/)Main\.ts:/u.test(row.site))) return 'Main';
  return '';
}


/** 从步骤行中挑出最具代表性的主函数名与源码位置。 */
function pickPrimaryFn(step: TrailStep): { fnName: string; fnSite: string } {
  const fnRow = step.rows.find((row) => row.kind === '函数' && row.name !== '');
  if (fnRow !== undefined) {
    let fnName = fnRow.name;
    //M Sessions.ts:getStepAnswer 内发出的跟踪点历史名字叫 Session.loop，保留原名或清晰映射均可定位。
    if (fnName === 'Session.loop' && fnRow.text.startsWith('trace.sessions.')) {
      fnName = 'Session.getStepAnswer';
    }
    return { fnName, fnSite: fnRow.site };
  }

  const first = step.rows[0];
  if (first === undefined) return { fnName: '', fnSite: '' };

  const mapped = EVENT_FN_NAMES[first.name] ?? first.name;
  return { fnName: mapped, fnSite: first.site };
}


/** 合并一步内各行的实测 facts（保留首个 systemBefore，其余同名键取最新实测值）。 */
function mergeStepFacts(rows: TrailRow[]): Record<string, string | number | boolean> {
  const merged: Record<string, string | number | boolean> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.facts)) {
      if (key === 'systemBefore' && merged['systemBefore'] !== undefined) continue;
      merged[key] = value;
    }
  }
  return merged;
}


/** 仅读取对象自身属性，防止 constructor / toString 等原型链键污染说明文本。 */
function lookupOwnNote(notes: Record<string, string>, key: string): string | undefined {
  if (Object.hasOwn(notes, key)) return notes[key];

  return undefined;
}


/** 将合并后的实测 facts 转为带中文说明的 DataField 数组。 */
function buildFactInputs(
  facts: Record<string, string | number | boolean>,
  trailNotes: Record<string, string>,
): DataField[] {
  const fields: DataField[] = [];
  for (const [key, value] of Object.entries(facts)) {
    const note = lookupOwnNote(FACT_NOTES, key) ?? lookupOwnNote(trailNotes, key) ?? key;
    fields.push({
      key,
      value: String(value),
      note,
      source: 'real',
    });
  }
  return fields;
}


/** 当 inputs 中尚无指定键且值非空时，补入一条辅助字段说明。 */
function addSchemaInputIfEmpty(
  inputs: DataField[],
  key: string,
  value: string,
  note: string,
  isReal: boolean,
): void {
  if (value === '' || inputs.some((item) => item.key === key)) return;

  let source: 'real' | 'schema' = 'schema';
  if (isReal) {
    source = 'real';
  }
  inputs.push({ key, value, note, source });
}


/** 汇总本条轨迹实际触碰的核心数据表、内存对象与关键事件清单。 */
function collectTouchedObjects(
  tracker: FlowTracker,
): { name: string; kind: 'table' | 'memory' | 'event'; role: string }[] {
  const list: { name: string; kind: 'table' | 'memory' | 'event'; role: string }[] = [];
  if (tracker.touchedWebTable) {
    list.push({
      name: 'web_messages',
      kind: 'table',
      role: '网页收件与回话时间线表（存原话、绑定 session_id、追加 replies 供前端轮询）',
    });
  }
  list.push({
    name: 'ChannelMessage',
    kind: 'memory',
    role: '跨渠道统一入站消息信封与路由策略（承载 autoFinal、targetBots 等）',
  });
  if (tracker.touchedSessions) {
    list.push({
      name: 'sessions / Session.row',
      kind: 'table',
      role: '骨架会话主记录（维护 state、messages、steps、reply 并落库 jmbots7.db）',
    });
  }
  if (tracker.touchedFrontArchive) {
    list.push({
      name: 'front_archive',
      kind: 'table',
      role: '机器人前台对话历史归档表（供关口一拼入最近往来背景）',
    });
  }
  if (tracker.touchedChatRequest) {
    list.push({
      name: 'ChatRequest',
      kind: 'memory',
      role: '骨架关口一请求载体（聚合 tools 清单、system[] 提示词、messages 历史与 answer）',
    });
  }
  if (tracker.touchedTools) {
    list.push({
      name: 'Tools / ToolOutcome',
      kind: 'memory',
      role: '骨架工具登记表、关口三权限校验与工具执行结果信封',
    });
  }
  if (tracker.touchedChannelReply) {
    list.push({
      name: 'channel/reply',
      kind: 'event',
      role: '统一出站回话一问一答事件（将模型回答交目标渠道写出并返回回执）',
    });
  }
  return list;
}


/** 判断行数组中是否包含指定名字的行。 */
function hasRowNamed(rows: TrailRow[], target: string): boolean {
  return rows.some((row) => row.name === target);
}


/** 去重提取一步内所有事件行的监听插件名单。 */
function collectStepListeners(rows: TrailRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const listener of row.listeners) {
      seen.add(listener);
    }
  }
  return [...seen];
}


/** 格式化收件表行标题。 */
function formatWebMessageTarget(messageId: number): string {
  if (messageId > 0) return `web_messages #${String(messageId)}`;
  return 'web_messages';
}


/** 格式化会话短标识，避免超长时间戳淹没卡片。 */
function formatShortSession(session: string | null): string {
  if (session === null || session === '') return '(当前会话)';
  if (session.length <= 12) return session;
  return `${session.slice(0, 8)}…${session.slice(-4)}`;
}


/** 格式化变更前的消息条数。 */
function formatCountBefore(count: number | undefined): string {
  if (count === undefined) return '原历史消息';
  return `${String(count)} 条`;
}


/** 拼装有向边上的紧凑标签。 */
function formatEdgeLabel(via: string, dataType: string): string {
  if (via === '' && dataType === '') return '';
  if (dataType === '' || via === dataType) return via;
  if (via === '') return dataType;
  return `${via} · ${dataType}`;
}


/** 安全提取字符串值。 */
function asString(value: string | number | boolean | undefined): string {
  if (typeof value === 'string') return value;
  return '';
}


/** 判断字段值来自真实采集还是结构约定。 */
function pickSource(isReal: boolean): 'real' | 'schema' {
  if (isReal) return 'real';
  return 'schema';
}


/** 安全提取有限数值。 */
function asNumber(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}
