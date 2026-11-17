/**
 * 会话步骤、回话追溯、回话的生成依据（generation）。都是只读的：从会话记录、收件表、流水、用量现拼，不另存。
 * 本文件不 import 同目录的 Timeline.ts（只 import type），免得两个文件互相 import 绕成一圈。
 * 设计：docs/src7插件设计/web-api.md 第 2 节“步骤”“追溯”、第 4 节 generationOf。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { SessionRow } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import type { MessageRecord } from './Timeline.ts';


/** 带状态码的错误：处理函数里抛它，index.ts 作用域的错误处理照状态码回 { error }。 */
export class Failure extends Error {
  /**
   * @param status HTTP 状态码。
   * @param message 回给网页的一句话。
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}


/** 一句回话的生成依据，形状照网页的 ReplyGeneration（web/src/Types.ts:149-172）。 */
export interface Generation {
  kind: 'model' | 'program';
  model: string | null;
  thinkingRequested: string | null;
  thinkingSent: null;
  thinkingReported: null;
  source: 'stored-assistant';
  purpose: string | null;
  run: null;
  step: number | null;
  assistantAt: number | null;
  callId: string | null;
}


/** 会话的一步，形状照网页的 SessionStep（web/src/Types.ts:614-633）。 */
export interface SessionStep {
  seq: number;
  at: number;
  row: string;
  eventType: string;
  event: Record<string, unknown>;
  stateBefore: string;
  stateAfter: string;
  stored: Record<string, unknown>;
  triggered: Record<string, unknown>;
}


/** 流水服务 journal 的样子（journal.md 第 12 节）：一条请求的跟踪行，和 flow 用的是同一个 request。只按约定写结构，不 import 它。 */
interface JournalLike {
  request(message: number, limit: number): {
    id: number; at: number; kind: string; name: string; mode: string; listeners: string[]; text: string; code: string; site: string;
    bot: string | null; sessionId: string | null; messageId: number | null; vars: Record<string, unknown>;
  }[] | undefined;
}

/** 用量服务 usage 的样子（usage.md 第 2 节），同上只按约定写结构。行的形状就是网页的 TraceUsage。 */
interface UsageLike {
  list(query: { sessions: string[]; from: number; to: number; limit: number }): { rows: Record<string, unknown>[]; truncated: boolean };
}


/** 追溯里事件最多几条、用量最多几行。 */
const EVENT_LIMIT = 500;
const USAGE_LIMIT = 200;

/** 追溯里原话、回话最多给多少字。 */
const TRACE_TEXT_MAX = 2000;

/** 步骤里一段文字最多给多少字。 */
const STEP_TEXT_MAX = 4000;


/**
 * 一句回话的生成依据：只看这场会话自己的对话，不猜。
 * 中途说的（reply 工具）：最后一条模型回答里有 name 是 reply、参数 text 就是这句话的工具调用；
 * 一轮结束的：会话做完了（done），而且最后一条模型回答的文字就是这句话。
 * 两样都不是（前台的“已交给会话”、出错、停下，或者对话里还没有模型回答）就是程序说的。
 * @param row 会话记录（回话时的样子）。
 * @param text 这句回话。
 * @returns 生成依据。
 */
export function generationOf(row: SessionRow, text: string): Generation {
  const program: Generation = {
    kind: 'program', model: null, thinkingRequested: null, thinkingSent: null, thinkingReported: null,
    source: 'stored-assistant', purpose: null, run: null, step: null, assistantAt: null, callId: null,
  };
  const assistants = row.messages.filter((item): item is piAi.AssistantMessage => item.role === 'assistant');
  const last = assistants.at(-1);
  if (last === undefined) return program;

  const call = last.content.find((block) => block.type === 'toolCall' && block.name === 'reply' && block.arguments['text'] === text);
  const finished = row.state === 'done' && piAi.contentText(last.content) === text;
  if (call === undefined && !finished) return program;

  return {
    kind: 'model',
    model: `${last.provider}/${last.model}`,
    thinkingRequested: row.thinking,
    thinkingSent: null,
    thinkingReported: null,
    source: 'stored-assistant',
    purpose: row.kind,
    run: null,
    step: assistants.length,
    assistantAt: last.timestamp,
    callId: call?.type === 'toolCall' ? call.id : null,
  };
}


/**
 * 会话的步骤：src7 的会话记录里只有对话，所以一条消息一步，seq 是它在对话里的序号（从 1 起）；
 * 会话不在转时最后多一步“运行结束”（E7）。row 的名字照网页 Panel/Steps.ts 认的那几个。
 * @param row 会话记录。
 * @param after 只要 seq 比它大的。
 * @param limit 最多几步。
 * @returns 步骤，seq 从小到大。
 */
export function steps(row: SessionRow, after: number, limit: number): SessionStep[] {
  const all: SessionStep[] = [];
  const empty = { stored: {}, triggered: {} };
  let previousAt = 0;
  row.messages.forEach((message, index) => {
    const seq = index + 1;
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : piAi.contentText(message.content);
      all.push({
        seq, at: message.timestamp, row: '用户', eventType: 'session/message（user）',
        event: { text: textModule.clip(text, STEP_TEXT_MAX), chars: text.length },
        stateBefore: 'idle', stateAfter: 'wait_response', ...empty,
      });
    } else if (message.role === 'assistant') {
      const calls = message.content.flatMap((block) => (block.type === 'toolCall' ? [{ id: block.id, name: block.name, args: block.arguments }] : []));
      const event = {
        model: `${message.provider}/${message.model}`,
        text: textModule.clip(piAi.contentText(message.content), STEP_TEXT_MAX),
        calls,
        stopReason: message.stopReason,
        input: message.usage.input,
        output: message.usage.output,
        //M 骨架不记每次请求用了多久，拿上一条消息到这条回答的时间差当耗时。
        ms: previousAt > 0 ? Math.max(0, message.timestamp - previousAt) : null,
      };
      all.push({
        seq, at: message.timestamp, row: 'E2', eventType: 'session/message（assistant）', event,
        stateBefore: 'wait_response', stateAfter: calls.length > 0 ? 'run_tools' : 'idle', ...empty,
      });
    } else if (message.role === 'toolResult') {
      const result = piAi.contentText(message.content);
      all.push({
        seq, at: message.timestamp, row: message.isError ? 'E4' : 'E3', eventType: 'session/message（toolResult）',
        event: { name: message.toolName, ok: !message.isError, resultChars: result.length, result: textModule.clip(result, STEP_TEXT_MAX) },
        stateBefore: 'run_tools', stateAfter: 'wait_response', ...empty,
      });
    }
    //M 系统消息（role 是 system）不算一步，也不带时间。
    if (message.role !== 'system') previousAt = message.timestamp;
  });

  //M 不在转的会话多一步“运行结束”：结局是现在的状态，出错时带原因。
  if (row.state !== 'running' && row.messages.length > 0) {
    all.push({
      seq: row.messages.length + 1, at: row.updatedAt, row: 'E7', eventType: 'session/change',
      event: { ending: row.state, error: row.state === 'failed' ? row.reply : null },
      stateBefore: 'wait_response', stateAfter: 'idle', ...empty,
    });
  }
  return all.filter((step) => step.seq > after).slice(0, limit);
}


/** trace() 要的东西：消息、哪一句回话，加上 index.ts 现算好的会话标题。 */
export interface TraceInput {
  message: MessageRecord;
  replyIndex: number;
  sessionTitle: string | null;
  association: { messageIds: number[]; scope: 'target'; source: string };
}


/**
 * 回话追溯：这句回话从收到原话起，到追加进收件表为止，流水里记了哪些事、调了几次模型。
 * journal、usage 是可选的服务：用到的这一刻 ctx.get 现取（Cordis 的 get：没挂就是 undefined），没挂就如实写进 notes。
 * @param ctx web-api 的 ctx。
 * @param input 消息、回话下标、会话标题、来源。
 * @returns 形状照网页的 ReplyTraceView（web/src/Types.ts:317-388）。
 * @throws Failure(404)：回话下标越界。
 */
export function trace(ctx: cordis.Context, input: TraceInput): Record<string, unknown> {
  const { message, replyIndex } = input;
  const reply = message.replies[replyIndex];
  if (reply === undefined) throw new Failure(404, `消息 ${String(message.id)} 没有第 ${String(replyIndex)} 句回话`);

  //M 涉及的会话：这条消息从第一句到这一句回话出现过的会话号（去重）；时间窗：收到 → 这句回话。
  const sessions = [...new Set(message.replies.slice(0, replyIndex + 1).map((item) => item.sessionId))];
  const from = message.createdAt;
  const to = reply.at;
  const notes = ['只读：按收件表、流水、用量表现有的记录拼成，不重新执行'];

  const journal = ctx.get('journal') as JournalLike | undefined;
  const usage = ctx.get('usage') as UsageLike | undefined;

  //M 一条请求的行（journal.request，和 /flow/ 同一个取法），这里只挑涉及的会话、这条消息自己的，到这句回话为止。
  const lines = journal?.request(message.id, EVENT_LIMIT) ?? [];
  const mine = (line: (typeof lines)[number]): boolean => line.messageId === message.id || sessions.includes(line.sessionId ?? '');
  const events = lines.filter((line) => line.at <= to && mine(line));
  //M 取满了、最后一行还没到这句回话：后面的没取到。
  const lastAt = lines.at(-1)?.at ?? to;
  const cut = lines.length >= EVENT_LIMIT && lastAt < to;

  const used = usage?.list({ sessions, from, to, limit: USAGE_LIMIT });
  if (journal === undefined) notes.push('没挂 journal，没有事件');
  if (usage === undefined) notes.push('没挂 usage，没有用量');
  if (cut) notes.push(`事件超过 ${String(EVENT_LIMIT)} 条，只给前 ${String(EVENT_LIMIT)} 条`);
  if (used?.truncated === true) notes.push(`用量超过 ${String(USAGE_LIMIT)} 行，只给前 ${String(USAGE_LIMIT)} 行`);

  return {
    target: {
      messageId: message.id,
      replyIndex,
      bot: message.bot,
      sessionId: reply.sessionId,
      at: reply.at,
      text: textModule.clip(reply.text, TRACE_TEXT_MAX),
      textChars: reply.text.length,
      sessionTitle: input.sessionTitle,
      workspace: 'workspace',
      messageFile: '',
      generation: reply.generation,
      association: input.association,
      run: null,
      step: reply.generation.step,
    },
    scope: journal === undefined ? 'message-only' : 'exact',
    notes,
    sources: [{
      id: message.id,
      channel: message.channel,
      source: message.source,
      text: textModule.clip(message.text, TRACE_TEXT_MAX),
      textChars: message.text.length,
      createdAt: message.createdAt,
      file: '',
    }],
    //M 跟踪行换成网页 TraceEvent 的外壳：type 是事件名或“模块.函数”，source 是听的人（函数行是发它的文件:行号），
    //M   data 里放跟踪行本身（kind、发法、听的人、人话、代码、位置、变量），网页按 data.kind 认出这是新格式。
    events: events.map((event) => ({
      id: event.id, type: event.name, at: event.at, source: event.kind === '事件' ? event.listeners.join('、') : event.site,
      bot: event.bot, sessionId: event.sessionId, messageId: event.messageId, key: null, parent: null, depth: 0,
      data: {
        kind: event.kind, ...(event.mode === '' ? {} : { mode: event.mode }), ...(event.kind === '事件' ? { listeners: event.listeners } : {}),
        ...(event.text === '' ? {} : { text: event.text }), ...(event.code === '' ? {} : { code: event.code }), site: event.site, ...event.vars,
      },
    })),
    dispatches: [],
    usage: used?.rows ?? [],
    usageScope: 'session-window',
    truncated: cut || used?.truncated === true,
    startedAt: from,
    endedAt: to,
    endSource: 'reply-record',
    elapsedMs: to >= from ? to - from : null,
  };
}

