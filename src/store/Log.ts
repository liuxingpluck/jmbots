/**
 * 日志文件：从数据库生成（用户 11-02 选的方案 A：数据库为准，JSON 和 Markdown 都从它生成），坏了随时可以重新生成。
 *
 * 位置：会话目录（Runtime.sessionDir：logs/bots/<机器人>/<会话ID>_<标题>/，不走机器人的放 logs/常规/<会话ID>_<标题>/）。
 *   <事件ID>_<第几步>.json   给 AI 和程序看：这一步实际发给模型的请求、模型的回复、工具调用和结果
 *   <事件ID>_<第几步>.md     给人看：模型、用时、用量、回复、思考、每个工具的参数和结果
 *   <事件ID>_<第几步>_决策_审核[_N].json/.md   这一步问决策模型“命令安不安全”的那次对话（一步里审了几条命令就有几份）
 *   <事件ID>_<第几步>_决策_判断.json/.md       这一步之后问决策模型“下一步怎么走”的那次对话
 *   会话.md                  会话总览：每次执行的输入、结局，每一步一行，分派、判断、审核的结论
 * 用户 11-02：“决策模型肯定也是要有对应的对话的，它应该也是个单独的……它可能放在某一个轮次里面。”
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as utils from '../utils/Utils.ts';
import type * as runtimeModule from '../core/Runtime.ts';
import type * as eventsModule from './Events.ts';


/** 生成日志要给的东西。 */
export interface ExportInput {
  /** 数据库。 */
  store: eventsModule.EventStore;

  /** 运行时（算会话目录）。 */
  runtime: runtimeModule.Runtime;

  /** 会话 ID。 */
  sessionId: string;

  /** 只生成这一次执行的步骤文件；不写就生成整个会话的。会话.md 每次都整篇重写。 */
  eventId?: number;
}


/**
 * 写文件：先写同目录下的临时文件，写完再改名，中途出错不会留下半个文件。
 * @param file 目标文件。
 * @param content 内容。
 */
async function atomicWrite(file: string, content: string): Promise<void> {
  /** 临时文件。 */
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}


/**
 * 包成代码块：围栏的反引号比正文里最长的一串还多一个，正文里的反引号不会把它提前关掉。
 * @param value 要放进代码块的东西；不是字符串就转成缩进的 JSON。
 * @param language 代码块语言，如 json。
 */
function fence(value: unknown, language = ''): string {
  /** 正文。 */
  const text = utils.toText(value);
  /** 正文里的反引号串。 */
  const runs = text.match(/`+/g) ?? [];
  /** 围栏。 */
  const mark = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${mark}${language}\n${text}\n${mark}`;
}


/**
 * 一段文字写成引用块（思考用）。
 * @param text 正文。
 */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}


/**
 * 一步写成给人看的 Markdown。
 * @param step 模型调用记录。
 * @param toolRows 这一步的工具调用记录。
 * @param fileName 同名 JSON 的文件名（不含扩展名）。
 */
function renderStep(step: eventsModule.ModelRequestRow, toolRows: eventsModule.ToolResultRow[], fileName: string): string {
  /** 请求。 */
  const request = step.request as { model?: string; thinking?: string; note?: string };
  /** 回复。 */
  const response = (step.response ?? {}) as { text?: string; thinking?: string; ms?: number; message?: { usage?: { input?: number; output?: number; cost?: { total?: number } }; stopReason?: string } };
  /** 用量。 */
  const usage = response.message?.usage;
  /** 状态。 */
  const status = step.status === 'in_progress' ? '结果未知（调用没回来）' : step.status;

  //M 头部：谁、什么模型、用时、用量、状态。
  /** 各段。 */
  const parts = [
    `# 第 ${step.step} 步 · ${step.actor} · ${utils.formatTime(step.createdAt)}`,
    [
      `- 模型：${request.model ?? '未知'}，思考强度 ${request.thinking ?? '未知'}`,
      `- 状态：${status}${response.message?.stopReason ? `（${response.message.stopReason}）` : ''}`,
      `- 用时：${response.ms === undefined ? '未知' : `${response.ms} 毫秒`}`,
      `- 用量：${usage ? `输入 ${usage.input ?? '?'}、输出 ${usage.output ?? '?'} token，费用 ${usage.cost?.total ?? '未知'}` : '供应商没报'}`,
      `- 完整请求和回复：${fileName}.json`,
      ...(step.error ? [`- 出错：${step.error}`] : []),
    ].join('\n'),
  ];
  if (request.note) {
    parts.push(`## 这一步之前留下的话\n\n${request.note}`);
  }
  if (response.thinking) {
    parts.push(`## 思考\n\n${quote(response.thinking)}`);
  }
  parts.push(`## 回复\n\n${response.text || '（没有文字）'}`);

  //M 每个工具一段：参数、状态、结果。
  for (const [index, tool] of toolRows.entries()) {
    /** 状态。 */
    const toolStatus = tool.status === 'in_progress' ? '结果未知（程序中断或在等确认）' : tool.status;
    parts.push(
      `## 工具 ${index + 1}：${tool.toolName}（${toolStatus}，${tool.updatedAt - tool.createdAt} 毫秒）\n\n参数：\n\n${fence(tool.input, 'json')}\n\n` +
        `结果：\n\n${fence(tool.status === 'failed' ? tool.error : tool.output)}`,
    );
  }
  return `${parts.join('\n\n')}\n`;
}


/**
 * 会话的执行者写成一句话：机器人、智能体或模型。
 * @param session 会话。
 */
function describeActor(session: eventsModule.SessionRow): string {
  if (session.bot) {
    return `机器人 ${session.bot}`;
  }
  if (session.agent) {
    return `智能体 ${session.agent}`;
  }
  return `模型 ${session.model ?? '未定'}`;
}


/**
 * 一次决策模型对话写成 Markdown：问了什么情况、什么问题，回答和概率。
 * @param title 标题，如“第 2 步 · 命令审核”。
 * @param decision 记在事件里的决策模型请求和回答。
 */
function renderDecision(title: string, decision: { request?: unknown; answers?: unknown; error?: unknown; ms?: unknown }): string {
  /** 请求。 */
  const request = (decision.request ?? {}) as { model?: string; state?: unknown; questions?: unknown };
  return [
    `# ${title}`,
    '',
    `- 决策模型：${request.model ?? '?'}`,
    `- 用时：${utils.toText(decision.ms ?? '?')} 毫秒`,
    decision.error ? `- 出错：${utils.toText(decision.error)}` : '',
    '',
    '## 情况',
    '',
    fence(request.state ?? {}, 'json'),
    '',
    '## 问题',
    '',
    fence(request.questions ?? {}, 'json'),
    '',
    '## 回答',
    '',
    fence(decision.answers ?? {}, 'json'),
    '',
  ].join('\n');
}


/**
 * 一次执行里的决策模型对话：命令审核（exec_review，by decision）和下一步判断（judge 带 decision）。
 * @param store 数据库。
 * @param execution execution 事件。
 * @returns 文件名（不含扩展名）、标题、内容。
 */
function decisionsOf(
  store: eventsModule.EventStore,
  execution: eventsModule.EventRow,
): { name: string; title: string; data: { request?: unknown; answers?: unknown; error?: unknown; ms?: unknown } }[] {
  /** 结果。 */
  const found: { name: string; title: string; data: { request?: unknown; answers?: unknown; error?: unknown; ms?: unknown } }[] = [];
  /** 每一步已经有几份审核（同一步审了几条命令时编号）。 */
  const reviewCount = new Map<number, number>();
  for (const child of store.listEvents(execution.sessionId).filter((event) => event.parentId === execution.id)) {
    /** 内容。 */
    const payload = (child.payload ?? {}) as Record<string, unknown>;
    /** 第几步。 */
    const step = typeof payload.step === 'number' ? payload.step : 0;
    if (child.type === 'exec_review' && payload.by === 'decision') {
      /** 这一步第几份。 */
      const count = (reviewCount.get(step) ?? 0) + 1;
      reviewCount.set(step, count);
      found.push({
        name: `${execution.id}_${step}_决策_审核${count > 1 ? `_${count}` : ''}`,
        title: `第 ${step} 步 · 命令审核：${utils.toText(payload.command)}`,
        data: payload,
      });
    }
    if (child.type === 'judge' && payload.decision && typeof payload.decision === 'object') {
      found.push({ name: `${execution.id}_${step}_决策_判断`, title: `第 ${step} 步 · 下一步判断`, data: payload.decision });
    }
  }
  return found;
}


/**
 * 挂在执行下面的事件写成一行：分派相关的写成人话，其他的照原样截一段 JSON。
 * @param child 事件。
 */
function describeChild(child: eventsModule.EventRow): string {
  /** 内容。 */
  const payload = (child.payload ?? {}) as Record<string, unknown>;
  if (child.type === 'route_result') {
    /** 动作。 */
    const actions = Array.isArray(payload.actions) ? (payload.actions as Record<string, unknown>[]) : [];
    /** 动作写成人话。 */
    const described = actions.map((action) => {
      if (action.type === 'continue') {
        return `接着会话 ${utils.toText(action.sessionId)}`;
      }
      if (action.type === 'new') {
        return `开新会话「${utils.toText(action.title)}」${action.model ? `（${utils.toText(action.model)} ${utils.toText(action.thinking ?? '')}）` : ''}`;
      }
      if (action.type === 'ask_user') {
        return `问用户：${utils.toText(action.text)}`;
      }
      return `${action.type === 'approve' ? '放行' : '拒绝'}待确认 ${utils.toText(action.approvalId)}`;
    });
    /** 引出的执行对话。 */
    const sessions = Array.isArray(payload.sessions) ? payload.sessions.map((id) => utils.toText(id)).join('、') : '';
    return `- 分派结论${payload.fallback === true ? '（按老办法）' : ''}：${described.join('；')}——${utils.toText(payload.reason ?? '')}；执行对话：${sessions || '无'}`;
  }
  if (child.type === 'route') {
    if (!payload.routeSessionId) {
      return `- 程序直接派来（没开分派对话）——${utils.toText(payload.reason ?? '')}`;
    }
    return `- 由分派对话 ${utils.toText(payload.routeSessionId)} 派来——${utils.toText(payload.reason ?? '')}`;
  }
  if (child.type === 'sent') {
    return `- 回复已发到${utils.toText(payload.channel ?? '渠道')}（消息 ${utils.toText(payload.messageId)}）`;
  }
  if (child.type === 'watchdog') {
    return `- 看门狗：已经 ${utils.toText(payload.minutes)} 分钟没有新步骤`;
  }
  if (child.type === 'approval_decided') {
    return `- 待确认 ${utils.toText(payload.approvalId)} ${payload.decision === 'approved' ? '已放行' : '已拒绝'}（${utils.toText(payload.by)}）`;
  }
  return `- ${child.type}：${utils.truncate(JSON.stringify(payload), 300)}`;
}


/**
 * 会话总览写成 Markdown。
 * @param store 数据库。
 * @param session 会话。
 */
function renderSession(store: eventsModule.EventStore, session: eventsModule.SessionRow): string {
  /** 各段。 */
  const parts = [
    `# ${session.title}`,
    [
      `- 会话 ID：${session.id}`,
      `- 执行者：${describeActor(session)}`,
      `- 工作区：${session.workspace}`,
      `- 来源：${session.source}`,
      `- 状态：${session.status}`,
      `- 创建：${utils.formatTime(session.createdAt)}，最近活动：${utils.formatTime(session.updatedAt)}`,
    ].join('\n'),
  ];
  /** 全部事件；分派、判断、审核挂在 execution 下面。 */
  const events = store.listEvents(session.id);
  for (const execution of events.filter((event) => event.type === 'execution')) {
    /** 这次执行的输入。 */
    const input = (execution.payload as { input?: string }).input ?? '';
    /** 这次执行的每一行。 */
    const lines = [`## 执行 ${execution.id}（${execution.status}，${utils.formatTime(execution.createdAt)}）`, '', `输入：${input}`, ''];
    for (const step of store.listModelRequests(execution.id)) {
      /** 回复的开头。 */
      const text = ((step.response as { text?: string } | null)?.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
      lines.push(`- 第 ${step.step} 步（${step.actor}，${step.status}）：${text} → [详情](${execution.id}_${step.step}.md)`);
    }
    for (const child of events.filter((event) => event.parentId === execution.id)) {
      lines.push(describeChild(child));
    }
    for (const decision of decisionsOf(store, execution)) {
      lines.push(`- 决策模型对话：${decision.title} → [详情](${decision.name}.md)`);
    }
    if (execution.error) {
      lines.push(`- 出错：${execution.error}`);
    }
    parts.push(lines.join('\n'));
  }
  if (session.lastReply) {
    parts.push(`## 最后回复\n\n${session.lastReply}`);
  }
  return `${parts.join('\n\n')}\n`;
}


/**
 * 从数据库生成日志文件。
 * @param input 数据库、运行时、会话、可选的事件。
 * @returns 写了哪些文件。
 * @throws 会话不存在、写文件失败时抛错（数据库不受影响，可以重新生成）。
 */
export async function exportExecution(input: ExportInput): Promise<string[]> {
  const { store, runtime, sessionId } = input;
  /** 会话。 */
  const session = store.getSession(sessionId);
  if (!session) {
    throw new Error(`没有会话 ${sessionId}`);
  }
  //G 会话还没定工作区和执行者（还没开始执行）时，先不写。
  if (!session.workspace && !session.bot) {
    return [];
  }
  /** 会话目录。 */
  const dir = runtime.sessionDir(session);
  await fs.mkdir(dir, { recursive: true });
  /** 写了的文件。 */
  const written: string[] = [];

  //M 每次执行的每一步：一个 JSON、一个 Markdown。
  /** 要生成的执行。 */
  const executions = store.listEvents(sessionId, 'execution').filter((event) => input.eventId === undefined || event.id === input.eventId);
  for (const execution of executions) {
    /** 这次执行的工具调用。 */
    const toolRows = store.listToolResults(execution.id);
    for (const step of store.listModelRequests(execution.id)) {
      /** 文件名（不含扩展名）。 */
      const name = `${execution.id}_${step.step}`;
      /** 这一步的工具调用。 */
      const stepTools = toolRows.filter((row) => row.step === step.step);
      await atomicWrite(path.join(dir, `${name}.json`), `${JSON.stringify({ step, tools: stepTools }, null, 2)}\n`);
      await atomicWrite(path.join(dir, `${name}.md`), renderStep(step, stepTools, name));
      written.push(path.join(dir, `${name}.json`), path.join(dir, `${name}.md`));
    }
    //M 决策模型的对话：每次一份 JSON、一份 Markdown。
    for (const decision of decisionsOf(store, execution)) {
      await atomicWrite(path.join(dir, `${decision.name}.json`), `${JSON.stringify(decision.data, null, 2)}\n`);
      await atomicWrite(path.join(dir, `${decision.name}.md`), renderDecision(decision.title, decision.data));
      written.push(path.join(dir, `${decision.name}.json`), path.join(dir, `${decision.name}.md`));
    }
  }

  //M 会话总览。
  await atomicWrite(path.join(dir, '会话.md'), renderSession(store, session));
  written.push(path.join(dir, '会话.md'));
  return written;
}
