/**
 * 会话用的纯数据小工具：从 src7/Sessions.ts 搬出来，只拼数据，不读写库、不发事件、不改会话状态。
 * 事件发射点、四个关口和会话循环都留在 Sessions.ts；这里只是那几步里拼对象、拼 SQL 的那一截。
 * 调用方只有 src7/Sessions.ts。
 */
import * as piAi from '@earendil-works/pi-ai';
import type { JmbotsConfig } from '../Resources.ts';
import type { ChatRequest, NewSession, SessionMeta, SessionRow } from '../Sessions.ts';
import type { ToolOutcome } from '../Tools.ts';
import * as utils from './index.ts';


/** getChatParts 交回的三样，Sessions.chat 拿去发请求。 */
export interface ChatParts {
  /**
   * pi-ai `Context` 是发给模型前的提示词、历史和工具。
   * - `systemPrompt` 可选，是系统提示词。
   * - `messages` 是对话消息，`Message` 见 src7/Sessions.ts 的 `session/new-message`。
   * - `tools` 可选，是工具定义数组，`Tool` 见 src7/Sessions.ts 的 `ChatRequest.tools`。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:543。
   */
  context: piAi.Context;
  /**
   * pi-ai `SimpleStreamOptions` 是发起模型请求时的选项。
   * - `signal` 可选，用来取消请求。
   * - `timeoutMs` 可选，是接口支持时的毫秒超时。
   * - `maxRetries` 可选，是 SDK 支持时的内部重试上限。
   * - `reasoning` 可选，取 `'minimal'`、`'low'`、`'medium'`、`'high'`、`'xhigh'` 或 `'max'`。
   * - `toolChoice` 可选，取 `'auto'` 或 `'none'`。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:233，继承字段见同文件 48、107 行。
   */
  options: piAi.SimpleStreamOptions;
  /**
   * pi-ai `RetryPolicy` 是整次调用失败后的重试策略。
   * - `enabled` 决定是否启用重试。
   * - `maxRetries` 是最多重试几次，首次调用单独计算。
   * - `baseDelayMs` 是指数退避的起始毫秒数，pi-ai 会加随机偏移。
   * - `maxAgentDelayMs` 可选，限制这层等待的最长毫秒数。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/utils/retry.d.ts:9。
   */
  policy: piAi.RetryPolicy;
}


/**
 * 照一步的请求和重试配置，拼出发给 pi 的上下文、请求选项和重试策略。
 * @param request 这一步的请求（Sessions.chat 收到的那份）；只读模型以外的提示词、对话、工具、思考档、取消信号。
 * @param retry 配置里的重试规矩（config.yaml 的 models.retry，见 src7/Resources.ts 的 JmbotsConfig.retry）。
 * @returns 上下文、请求选项、重试策略。
 */
export function getChatParts(request: ChatRequest, retry: JmbotsConfig['retry']): ChatParts {
  //M 拼 pi 要的上下文：提示词的段落用空行连成一段。
  const systemPrompt = request.system.join('\n\n');
  const context: piAi.Context = {
    systemPrompt,
    messages: request.messages,
    tools: request.tools,
  };

  //M 请求选项：pi 自己不重试（maxRetries 0），重试交给 Sessions.chat 里的 retryAssistantCall。
  const options: piAi.SimpleStreamOptions = {
    signal: request.signal,
    timeoutMs: retry.timeoutMs,
    maxRetries: 0,
  };

  //M 思考档不是 off 才传 reasoning；off 就不传，模型不思考。
  if (request.thinking !== 'off') {
    options.reasoning = request.thinking;
  }

  //M 重试的规矩：临时的错（断网、限流、超时）隔一会儿再试，最多再试 retry.times 次；喊停了不再试。
  //M   重试、判断哪种错值得再试，都是 pi 的 retryAssistantCall 做的。
  const policy: piAi.RetryPolicy = {
    enabled: true,
    maxRetries: retry.times,
    baseDelayMs: retry.waitMs,
  };
  return { context, options, policy };
}


/**
 * 从模型的回答里挑出工具调用。
 * @param answer 这一步的回答（插件可能改过、换过，以最后那份为准）。
 * @returns pi-ai `ToolCall` 列表，没要工具就是空的。
 *   - `type: 'toolCall'` 用来从回答的其他内容块里认出调用。
 *   - `id` 用来配对调用与结果。
 *   - `name` 是工具名。
 *   - `arguments` 是要交给工具校验的 `JsonObject`。
 *   全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:271。
 */
export function getToolCalls(answer: piAi.AssistantMessage): piAi.ToolCall[] {
  return answer.content.filter((block): block is piAi.ToolCall => {
    return block.type === 'toolCall';
  });
}


/**
 * 把一次工具执行的结果写成一条 toolResult：先是文字，后面跟着图片（有的话）。
 * @param call 模型要的这次调用，用它的 id、name 和结果配对。
 * @param outcome 执行的结果（关口四 session/after-tool 里插件可能改过，以改过的为准）。
 * @returns 给模型看的工具结果，属于 `role: 'toolResult'` 的 `Message`，见 src7/Sessions.ts 的 `session/new-message`。
 */
export function getToolResultMessage(call: piAi.ToolCall, outcome: ToolOutcome): piAi.Message {
  /**
   * pi-ai `TextContent` 是纯文字内容块。
   * - `type: 'text'` 用来区分文字与图片等内容块。
   * - `text` 是工具结果正文。
   * - `textSignature` 可选，留给带签名的内容块。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:252。
   */
  const textBlock: piAi.TextContent = { type: 'text', text: outcome.text };
  const images = outcome.images ?? [];
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [textBlock, ...images],
    isError: outcome.isError,
    timestamp: Date.now(),
  };
}


/** getModelTrace 交回的两样，Session.getStepAnswer 拿去发 trace。 */
export interface ModelTrace {
  /** 这一步在做什么的文字键：调模型，或者插件已经给了回答。 */
  doing: string;
  /** 跟踪带的关键变量。 */
  vars: Record<string, unknown>;
}


/**
 * 关口一走完、调模型之前，拼跟踪要的文字键和变量；插件已经给了回答就写明没有调。
 * @param request 关口一插件改完的请求。
 * @param systemBefore 关口一之前提示词有几段。
 * @returns 文字键和变量。
 */
export function getModelTrace(request: ChatRequest, systemBefore: number): ModelTrace {
  //M 插件给了回答，记下是哪家哪个模型给的。
  const answer = request.answer;
  let answeredBy = '';
  if (answer !== undefined) {
    answeredBy = `${answer.provider}/${answer.model}`;
  }

  const row = request.session.row;
  const vars = {
    session: request.session.id, sessionKind: row.kind, step: row.steps,
    model: request.model, thinking: request.thinking, systemBefore,
    systemAfter: request.system.length, toolsCount: request.tools.length,
    messageCount: request.messages.length, answeredByPlugin: answer !== undefined, answeredBy,
  };
  if (answer !== undefined) return { doing: 'trace.sessions.answerProvided', vars };

  return { doing: 'trace.sessions.callModel', vars };
}


/**
 * 照新开会话给的东西拼一份新记录：模型、思考档没给就用配置里的；状态 done，对话是空的。
 * @param input Sessions.create 收到的入参，原样带进记录。
 * @param id 已查过没人用的会话号。
 * @param config 全局配置，取 defaultModel、thinking。
 * @returns 新记录。
 */
export function getNewSessionRow(input: NewSession, id: string, config: JmbotsConfig): SessionRow {
  return {
    ...input,
    id,
    model: input.model ?? config.defaultModel,
    thinking: input.thinking ?? config.thinking,
    state: 'done',
    reply: '',
    messages: [],
    steps: 0,
    updatedAt: Date.now(),
  };
}


/**
 * 把库里 meta 那一列解析回记录（不带对话）。Sessions.open、Sessions.find 读库都走这里。
 * @param json 库里 meta 列的原文。
 * @returns 记录。早先存的会话没有 steps（后加的一项），在这里补 0，往后内部直接用。
 */
export function parseSessionMeta(json: string): SessionMeta {
  const meta = JSON.parse(json) as Omit<SessionMeta, 'steps'>
    & Partial<Pick<SessionMeta, 'steps'>>;
  const steps = meta.steps ?? 0;
  return { ...meta, steps };
}


/** getFindQuery 交回的 SQL 和要填进问号的值。 */
export interface FindQuery {
  /** 查 meta 列的 SQL，最近动过的在前。 */
  sql: string;
  /** 填进 SQL 里问号的值：每一项两个，先是 JSON 路径（$.state），再是要等于的值。 */
  values: (string | number)[];
}


/**
 * 拼 Sessions.find 的 SQL：每一项都用 json_extract 从 meta 里取出来比，所以插件加的项不用改表也能拿来找。
 * @param where 照哪几项找，比如 { state: 'running' }。
 * @returns SQL 和要填进问号的值。
 */
export function getFindQuery(where: Partial<SessionMeta>): FindQuery {
  //M 逐条追加过滤键到 WHERE 子句与绑定参数，最后按更新时间倒序。
  let sql = 'SELECT meta FROM sessions WHERE 1 = 1';
  const values: (string | number)[] = [];
  utils.eachEntry(where, (key, value) => {
    sql += ' AND json_extract(meta, ?) = ?';
    values.push(`$.${key}`, value as string | number);
  });
  sql += " ORDER BY json_extract(meta, '$.updatedAt') DESC";
  return { sql, values };
}
