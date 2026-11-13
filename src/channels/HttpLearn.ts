/**
 * learnjmbots（docs/界面/07_消息流转学习界面.md 第 9 节）：托管学习界面、回放一条真实消息。Http.ts 的 HttpApp.build 调 LearnRoutes.register 注册：
 *   GET /learnjmbots、/learnjmbots/   学习界面（单文件：从源码跑时读 dist/learn/index.html，编译好的程序里打包着）
 *   GET /api/learn/trace/:id          一条消息的全过程，拼成学习界面的场景（只读：不发消息、不动会话）
 * 场景只用已有记录拼：收件行、分派记录、会话行、会话消息。步骤只带 ref（tests/trace-anchors.json 的键），源码位置由学习界面打包时对上。
 * 文字都先过密钥替身再截短；图片只给路径。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as fastify from 'fastify';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as embedded from '../resources/Embedded.ts';
import type * as learnTypes from './LearnTypes.ts';
import type * as secretsModule from '../capabilities/Secrets.ts';
import type * as storeModule from '../capabilities/Store.ts';
import type * as dispatchModule from '../dispatch/Dispatch.ts';
import type * as execReview from '../executors/ExecReview.ts';


/** 学习界面的单文件（本文件在 src/channels/ 下，代码目录下的 dist/learn/index.html）。 */
const PAGE = path.resolve(import.meta.dir, '..', '..', 'dist', 'learn', 'index.html');

/** 每段文字最多几个字。 */
const TEXT_MAX = 2000;

/** 工具结果最多几个字。 */
const RESULT_MAX = 1000;

/** 最多列几步模型调用：一次运行跑了上百步时，后面的只说一句还有多少。 */
const MAX_MODEL_STEPS = 60;

/** 流向图：渠道 → 收件表 → 分派 → 会话 → 模型 → 工具 → 回复。下面的 FLOW 是它们的序号。 */
const FLOWS: learnTypes.FlowNode[] = [
  { label: '渠道', layer: '网络' },
  { label: '收件表', layer: '存储' },
  { label: '分派', layer: '后端' },
  { label: '会话', layer: '后端' },
  { label: '模型', layer: '网络' },
  { label: '工具', layer: '后端' },
  { label: '回复', layer: '前端' },
];

/** 流向图节点的序号。 */
const FLOW = { channel: 0, inbox: 1, dispatch: 2, session: 3, model: 4, tool: 5, reply: 6 };

/** exec 审核结论的说法（老记录里认不出的值原样显示）。 */
const VERDICT_LABELS: Record<string, string> = { run: '执行', reject: '不执行', pending: '等用户决定' };

/** 分派结论里 session 的两个特殊值的说法；别的值是会话 ID，就是追加。 */
const SESSION_LABELS: Record<string, string> = { new: '新开会话', none: '不进会话' };


/** 跟着步骤往下走的变量（每步存一份快照，界面比较前后两步亮出变了的）。 */
interface TraceVars {
  /** 收件的状态。 */
  status: string;
  /** 进了哪个会话。 */
  sessionId: string | null;
  /** 第几步模型调用。 */
  第几步: number;
  /** 这一步用了多少 token。 */
  token: number;
  /** 收件上记了几条回复。 */
  replies: number;
}


/**
 * 先换掉密钥再截短（先截再换，截断处的半截密钥就换不掉了）。
 * @param deps 依赖（secrets）。
 * @param text 文字。
 * @param max 最多几个字。
 */
function show(deps: Pick<TraceDeps, 'secrets'>, text: string, max: number): string {
  /** 换过密钥的。 */
  const masked = deps.secrets.mask(text);
  return masked.length > max ? `${masked.slice(0, max)}…（共 ${String(masked.length)} 字）` : masked;
}


/**
 * 消息内容里的文字（图片只记一句有几张）。
 * @param content 用户消息或工具结果的内容。
 */
function textOf(content: string | (piAi.TextContent | piAi.ImageContent)[]): string {
  if (typeof content === 'string') {
    return content;
  }
  /** 图片几张。 */
  const images = content.filter((part) => part.type === 'image').length;
  /** 文字。 */
  const text = content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  return images ? `${text}（另有 ${String(images)} 张图）` : text;
}


/**
 * 分派那一步的子步骤：决策模型、常规模型小循环每一步、核对。
 * @param deps 依赖（secrets）。
 * @param record 分派记录。
 * @param vars 当前变量。
 */
function dispatchChildren(
  deps: Pick<TraceDeps, 'secrets'>,
  record: dispatchModule.DispatchRecord,
  vars: TraceVars,
): learnTypes.Step[] {
  /** 子步骤。 */
  const children: learnTypes.Step[] = [];
  /** 决策模型那一档。 */
  const decision = record.decisionModel;
  if (decision) {
    /** 决策选项和已经脱敏的题面。 */
    const options = decision.options.map((option) => ({
      选项: option.label,
      会话: option.session,
      概率: option.probability,
    }));
    const question = show(deps, decision.question, TEXT_MAX);
    children.push({
      title: `决策模型：${decision.used ? '它定了' : '没用它的'}`,
      phase: '后端',
      flow: FLOW.dispatch,
      func: 'Dispatcher.askDecisionModel',
      file: '',
      ref: 'decisionModel',
      desc: '先问小的决策模型：把现状写成一道选择题，看每个选项的概率；够确定就直接用它的，不够再交给常规模型。',
      input: {
        模型: decision.model,
        题面: question,
      },
      output: {
        选项: options,
        用没用: decision.used,
        为什么: decision.why,
        出错: decision.error,
        用时毫秒: decision.ms,
      },
      vars: { ...vars },
    });
  }
  /** 常规模型那一档。 */
  const llm = record.llm;
  if (llm) {
    children.push({
      title: `常规模型小循环：${llm.error ? '没成' : '给了结论'}`,
      phase: '后端',
      flow: FLOW.dispatch,
      func: 'MiniLoop.askJson',
      file: '',
      ref: 'miniLoop',
      desc: '决策模型拿不准时，常规模型可以先用只读工具看看会话和记忆，再回一个 JSON 结论；核对不过就带着原因重问。',
      input: {
        模型: llm.request.model,
        思考档: llm.request.thinking,
        工具: llm.request.tools,
        输入: show(deps, llm.request.input, TEXT_MAX),
      },
      output: { 结论: llm.value, 重跑: llm.reruns, 出错: llm.error },
      vars: { ...vars },
      children: llm.steps.map((step, index) => ({
        title: `小循环第 ${String(index + 1)} 步${step.calls.length ? `：调 ${step.calls.map((call) => call.name).join('、')}` : ''}`,
        phase: '后端',
        flow: FLOW.dispatch,
        func: 'MiniLoop.askJson',
        file: '',
        ref: 'miniLoop',
        desc: step.error ? `这一步出错：${step.error}` : '模型回一次：要么调只读工具，要么给 JSON。',
        input: { 思考档: step.effort },
        output: {
          文字: show(deps, step.text, TEXT_MAX),
          工具: step.calls.map((call) => {
            /** 工具参数先序列化，再脱敏截短。 */
            const argumentsText = JSON.stringify(call.args);
            const args = show(deps, argumentsText, TEXT_MAX);
            const result = show(deps, call.result, RESULT_MAX);
            return {
              名字: call.name,
              参数: args,
              结果: result,
              出错: call.isError,
            };
          }),
          用时毫秒: step.ms,
        },
        vars: { ...vars },
      })),
    });
  }
  if (record.checks.length) {
    children.push({
      title: `核对没过 ${String(record.checks.length)} 次`,
      phase: '后端',
      flow: FLOW.dispatch,
      func: 'Dispatcher.check',
      file: '',
      ref: 'check',
      desc: '模型的结论要过程序核对（会话在不在、模型能不能用、在跑的会话能不能追加），没过就带着原因重问。',
      output: { 原因: record.checks.map((reason) => show(deps, reason, RESULT_MAX)) },
      vars: { ...vars },
    });
  }
  return children;
}


/**
 * 一次工具调用那一步；exec 多一个审核子步骤。
 * @param deps 依赖（secrets）。
 * @param call 模型发起的调用。
 * @param result 对应的工具结果；还没结果时没有。
 * @param vars 当前变量。
 */
function toolStep(
  deps: Pick<TraceDeps, 'secrets'>,
  call: piAi.ToolCall,
  result: piAi.ToolResultMessage | undefined,
  vars: TraceVars,
): learnTypes.Step {
  /** exec 的审核记录（在工具结果的 details 里）。 */
  const review = call.name === 'exec' ? (result?.details as execReview.ExecReviewRecord | undefined) : undefined;
  /** 参数和结果各自先准备好，回放对象只负责组合。 */
  const argumentsText = JSON.stringify(call.arguments);
  const args = show(deps, argumentsText, TEXT_MAX);
  const resultText = result ? textOf(result.content) : '';
  const output = result
    ? {
      结果: show(deps, resultText, RESULT_MAX),
      出错: result.isError,
      用时毫秒: result.durationMs,
    }
    : { 结果: '（没有结果：运行在这里停了）' };

  return {
    title: `工具 ${call.name}${result?.isError ? '（出错）' : ''}`,
    phase: '后端',
    flow: FLOW.tool,
    func: `ToolBox.run('${call.name}')`,
    file: '',
    ref: call.name === 'reply' ? 'reply' : 'tool',
    desc: call.name === 'reply' ? '模型用 reply 工具回话：回复发回消息来的渠道，并记进收件行。' : '会话循环按名字找到工具执行，结果作为一条工具消息放回对话，下一步模型能看到。',
    input: { 参数: args },
    output,
    vars: { ...vars },
    children: review?.verdict
      ? [{
        title: `审核：${VERDICT_LABELS[review.verdict] ?? review.verdict}`,
        phase: '后端',
        flow: FLOW.tool,
        func: 'ExecReviewer.review',
        file: '',
        ref: 'review',
        desc: '命令执行前先审核：程序的硬规矩、决策模型、常规模型小循环，拿不准就发审核卡片等用户。',
        output: {
          结论: review.verdict,
          谁定的: review.by,
          规矩: review.rule,
          理由: show(deps, review.reason, RESULT_MAX),
          决策模型: review.decision,
          待确认: review.approval,
          用时毫秒: review.ms,
        },
        vars: { ...vars },
      }]
      : undefined,
  };
}


/**
 * 会话里处理这条消息的那次运行：从带着这条消息号的用户消息开始，到这次运行结束。
 * @param deps 依赖（secrets）。
 * @param session 会话。
 * @param id 消息号。
 * @param vars 当前变量（会改：第几步、token）。
 * @returns 步骤；会话记录里找不到这条时是一步说明。
 */
function runSteps(
  deps: Pick<TraceDeps, 'secrets'>,
  session: storeModule.SessionRow,
  id: number,
  vars: TraceVars,
): learnTypes.Step[] {
  /** 会话消息。 */
  const messages = session.messages;
  /** 这条消息进对话的位置。 */
  const start = messages.findIndex((item) => item.message.role === 'user' && item.messageIds?.includes(id) === true);
  if (start < 0) {
    return [{
      title: '会话记录里找不到这条',
      phase: '后端',
      flow: FLOW.session,
      func: 'SessionRunner.runSession',
      file: '',
      ref: 'runSession',
      desc: '可能还在排队没轮到，或者会话压缩过，这一段已经换成了摘要。',
      vars: { ...vars },
    }];
  }
  /** 第几次运行。 */
  const run = messages[start]!.run;
  /** 这次运行的消息。 */
  const slice = messages.slice(start).filter((item) => item.run === run);
  /** 工具结果：调用号 → 结果。 */
  const results = new Map<string, piAi.ToolResultMessage>();
  for (const item of slice) {
    if (item.message.role === 'toolResult') {
      results.set(item.message.toolCallId, item.message);
    }
  }
  /** 这次运行的记录。 */
  const info = session.runs.find((item) => item.n === run);
  /** 步骤。 */
  const steps: learnTypes.Step[] = [{
    title: `会话第 ${String(run)} 次运行`,
    phase: '后端',
    flow: FLOW.session,
    func: 'SessionRunner.runSession',
    file: '',
    ref: 'runSession',
    desc: '会话循环：把对话交给模型，模型调工具就执行、结果放回去再问，直到模型不再调工具。',
    input: { 会话: session.id, 模型: session.model, 思考档: session.thinking },
    output: { 结束: info?.ending, 步数: info?.steps },
    vars: { ...vars },
  }];
  /** 模型调用的步数。 */
  let count = 0;
  for (const [index, item] of slice.entries()) {
    /** 这一条。 */
    const message = item.message;
    //M 中途又排进来的消息：记一步，说明这次运行也接着处理它。
    if (message.role === 'user' && index > 0) {
      steps.push({
        title: `中途来了消息 #${(item.messageIds ?? []).join('、#')}`,
        phase: '存储',
        flow: FLOW.inbox,
        func: 'Store.takeQueued',
        file: '',
        desc: '运行中又有消息排给这个会话：下一步之前取出来放进对话。',
        input: { 原话: show(deps, textOf(message.content), TEXT_MAX) },
        vars: { ...vars },
      });
      continue;
    }
    if (message.role !== 'assistant') {
      continue;
    }
    count += 1;
    if (count > MAX_MODEL_STEPS) {
      continue;
    }
    /** 调了哪些工具。 */
    const calls = message.content.filter((part): part is piAi.ToolCall => part.type === 'toolCall');
    /** 回的文字。 */
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    vars.第几步 = count;
    vars.token = message.usage.totalTokens;
    steps.push({
      title: `第 ${String(count)} 步：${calls.length ? `调 ${calls.map((call) => call.name).join('、')}` : '回文字'}`,
      phase: '网络',
      flow: FLOW.model,
      func: 'SessionRun.callModel',
      file: '',
      ref: 'callModel',
      desc: '把整段对话（系统提示词、历史、工具说明）发给模型，等它回文字或工具调用。',
      input: { 模型: message.model, 上下文token: message.usage.input + message.usage.cacheRead },
      output: {
        文字: show(deps, text, TEXT_MAX),
        工具: calls.map((call) => call.name),
        停止原因: message.stopReason,
        出错: message.errorMessage,
        用时毫秒: message.durationMs,
      },
      vars: { ...vars },
      children: calls.length ? calls.map((call) => toolStep(deps, call, results.get(call.id), vars)) : undefined,
    });
  }
  if (count > MAX_MODEL_STEPS) {
    steps.push({
      title: `后面还有 ${String(count - MAX_MODEL_STEPS)} 步`,
      phase: '后端',
      flow: FLOW.session,
      func: 'SessionRunner.runSession',
      file: '',
      ref: 'runSession',
      desc: `一次运行列到第 ${String(MAX_MODEL_STEPS)} 步为止，全过程看会话记录。`,
      vars: { ...vars },
    });
  }
  return steps;
}


/** buildTrace 真用到的依赖：store 只用两个读方法（测试可以给假的）。 */
export interface TraceDeps {
  /** 数据库：取收件和会话。 */
  store: Pick<storeModule.Store, 'getMessage' | 'getSession'>;
  /** 密钥替身表。 */
  secrets: secretsModule.Secrets;
}


/**
 * 一条消息的全过程拼成学习界面的场景。
 * @param deps 依赖（store 取记录、secrets 换密钥）。
 * @param id 消息号。
 * @returns 场景；没有这条消息时是 undefined。无副作用（只读）。
 */
export function buildTrace(
  deps: TraceDeps,
  id: number,
): learnTypes.Scene | undefined {
  /** 收件行。 */
  const message = deps.store.getMessage(id);
  if (!message) {
    return undefined;
  }
  /** 跟着走的变量。 */
  const vars: TraceVars = { status: 'new', sessionId: null, 第几步: 0, token: 0, replies: 0 };
  /** 步骤。 */
  const steps: learnTypes.Step[] = [{
    title: `收到 #${String(id)}（${message.channel}）`,
    phase: '网络',
    flow: FLOW.channel,
    func: message.channel === 'http' ? 'POST /api/message' : 'BotLoop.receive',
    file: '',
    ref: message.channel === 'http' ? 'http' : 'receive',
    desc: `${message.source} 从 ${message.channel} 发来一条消息：存进收件表，写好消息文件（图片、附件写成 @路径）。`,
    input: { 渠道: message.channel, 来源: message.source, 原话: show(deps, message.text, TEXT_MAX) },
    output: { 消息号: message.id, 消息文件: message.file, 时间: new Date(message.createdAt).toLocaleString() },
    vars: { ...vars },
  }];
  /** 分派记录（强制分派、等待审核时形状一样；老记录可能缺字段，缺了就原样给）。 */
  const record = message.dispatch as dispatchModule.DispatchRecord | null;
  if (record && typeof record === 'object') {
    /** 结论。 */
    const result = (record as Partial<dispatchModule.DispatchRecord>).result;
    vars.status = message.sessionId ? 'queued' : message.status;
    vars.sessionId = message.sessionId;
    steps.push({
      title: result ? `分派：${SESSION_LABELS[result.session] ?? '追加到会话'}（${result.by}）` : '分派',
      phase: '后端',
      flow: FLOW.dispatch,
      func: 'Dispatcher.dispatch',
      file: '',
      ref: 'dispatch',
      desc: '看现状（在跑的会话、工作区、模型）决定这条消息去哪：先问决策模型，拿不准再问常规模型，都不行程序兜底。',
      input: { 这一批: record.messageIds, 开始: new Date(record.startedAt).toLocaleString() },
      output: result
        ? {
          会话: result.session,
          标题: result.title,
          工作区: result.workspace,
          模型: result.model,
          思考档: result.thinking,
          打断: result.interrupt,
          谁定的: result.by,
          理由: show(deps, result.reason, TEXT_MAX),
          用时毫秒: record.ms,
        }
        : { 记录: show(deps, JSON.stringify(record), TEXT_MAX) },
      vars: { ...vars },
      children: result ? dispatchChildren(deps, record, vars) : undefined,
    });
  }
  /** 会话。 */
  const session = message.sessionId ? deps.store.getSession(message.sessionId) : undefined;
  if (session) {
    //M 直接指定会话发的消息（ask --session）没有分派记录，会话号在这里补上，不然回放里一直是 null。
    vars.sessionId = session.id;
    steps.push({
      title: `进会话「${session.title}」`,
      phase: '后端',
      flow: FLOW.session,
      func: 'BotLoop.place',
      file: '',
      ref: 'place',
      desc: '按分派结论新开或找到会话，消息排给它，写分派记录；会话没在跑就启动一次运行。',
      output: { 会话: session.id, 标题: session.title, 工作区: session.workspace, 模型: session.model },
      vars: { ...vars },
    });
    vars.status = 'taken';
    steps.push(...runSteps(deps, session, id, vars));
  }
  for (const [index, reply] of message.replies.entries()) {
    vars.replies = index + 1;
    steps.push({
      title: `回复 ${String(index + 1)}`,
      phase: '前端',
      flow: FLOW.reply,
      func: 'Store.addReply',
      file: '',
      ref: 'addReply',
      desc: '回复发回渠道以后记进收件行，网页时间线和消息文件都从这里读。',
      input: { 会话: reply.session.title, 时间: new Date(reply.at).toLocaleString() },
      output: { 回复: show(deps, reply.text, TEXT_MAX) },
      vars: { ...vars },
    });
  }
  /** 场景。 */
  const scene: learnTypes.Scene = {
    id: `trace-${String(id)}`,
    name: `#${String(id)} ${show(deps, message.text.replace(/\s+/g, ' '), 16)}`,
    desc: `回放 ${message.bot} 收到的第 ${String(id)} 条消息（${message.channel}，${new Date(message.createdAt).toLocaleString()}）`,
    flows: FLOWS,
    steps,
  };
  //G 最后整个再过一遍密钥替身：标题、工作区名这些没走 show 的也不会漏。
  const serialized = JSON.stringify(scene);
  const masked = deps.secrets.mask(serialized);

  return JSON.parse(masked) as learnTypes.Scene;
}


/**
 * 给学习界面的单文件。
 * @param reply 回复。
 */
async function servePage(reply: fastify.FastifyReply): Promise<fastify.FastifyReply> {
  reply.header('Cache-Control', 'no-cache');
  if (embedded.isCompiled()) {
    /** 程序里打包的。 */
    const packed = embedded.find('learn/index.html');
    if (!packed) {
      return reply.code(404).type('text/plain; charset=utf-8').send('这个程序里没有打包学习界面');
    }
    const contents = await Bun.file(packed).arrayBuffer();
    const body = Buffer.from(contents);

    return reply.type('text/html; charset=utf-8').send(body);
  }
  if (!fsSync.existsSync(PAGE)) {
    return reply.code(404).type('text/plain; charset=utf-8').send('学习界面已经不再打包（0.6 的学习页已去掉；0.4 这页如果 dist/learn/index.html 还在就能打开）');
  }
  const body = await fs.readFile(PAGE);

  return reply.type('text/html; charset=utf-8').send(body);
}


/**
 * 学习界面和回放接口的路由。建它的地方：src/channels/Http.ts 的 HttpApp.build。
 */
export class LearnRoutes {
  /**
   * @param deps 回放要用的：store 取记录、secrets 换密钥（HttpParts 里的这两样，
   *   入口 src/entries/App.ts 建的，经 Http.ts 的 HttpApp.build 传进来）。
   */
  constructor(private readonly deps: TraceDeps) {}

  /**
   * 注册学习界面和回放接口。
   * @param app Fastify 实例（Http.ts 的 HttpApp.build 建的）。
   * 副作用：给 app 加路由。
   */
  register(app: fastify.FastifyInstance): void {
    app.get('/learnjmbots', (_request, reply) => this.getPage(reply));
    app.get('/learnjmbots/', (_request, reply) => this.getPage(reply));
    app.get<{ Params: { id: string } }>(
      '/api/learn/trace/:id',
      (request, reply) => this.getTrace(request, reply),
    );
  }

  /** GET /learnjmbots、/learnjmbots/：学习界面（单文件）。 */
  private getPage(reply: fastify.FastifyReply) {
    return servePage(reply);
  }

  /** GET /api/learn/trace/:id：一条消息的全过程，拼成学习界面的场景。 */
  private getTrace(
    request: fastify.FastifyRequest<{ Params: { id: string } }>,
    reply: fastify.FastifyReply,
  ) {
    /** 消息号。 */
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return reply.code(400).send({ error: '消息号要是正整数' });
    }
    /** 场景。 */
    const scene = buildTrace(this.deps, id);
    return scene ?? reply.code(404).send({ error: `没有消息 #${String(id)}` });
  }
}
