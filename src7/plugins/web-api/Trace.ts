/**
 * 会话步骤、回话追溯、回话的生成依据（generation）。都是只读的：从会话记录、收件表、流水、用量现拼，不另存。
 * 本文件不 import 同目录的 Timeline.ts（只 import type），免得两个文件互相 import 绕成一圈。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { SessionRow } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import type { MessageRecord } from './Timeline.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';


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


/** 流水和用量查询共用事件契约里的 5 秒等待上限。 */
const TRACE_QUERY_TIMEOUT_MS = 5_000;


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
export function getGeneration(row: SessionRow, text: string): Generation {
  const program: Generation = {
    kind: 'program', model: null, thinkingRequested: null, thinkingSent: null, thinkingReported: null,
    source: 'stored-assistant', purpose: null, run: null, step: null, assistantAt: null, callId: null,
  };
  const assistants = row.messages.filter((item): item is piAi.AssistantMessage => item.role === 'assistant');
  const last = assistants.at(-1);
  if (last === undefined) return program;

  //M 对照末条模型消息的回复工具参数和最终正文，识别这句回话的生成方式。
  const call = last.content.find((block) => block.type === 'toolCall' && block.name === 'reply' && block.arguments['text'] === text);
  const finished = row.state === 'done' && piAi.contentText(last.content) === text;
  if (call === undefined && !finished) return program;

  let callId: string | null = null;
  if (call?.type === 'toolCall') {
    callId = call.id;
  }
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
    callId,
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
    //G 系统消息不生成步骤，也不占用相邻步骤的时间。
    if (message.role === 'system') return;

    const startedAt = previousAt;
    previousAt = message.timestamp;
    if (message.role === 'user') {
      let text = message.content;
      if (typeof text !== 'string') {
        text = piAi.contentText(text);
      }
      //M 保留输入字数，将正文缩成网页步骤可展示的预览。
      all.push({
        seq, at: message.timestamp, row: '用户', eventType: 'session/message（user）',
        event: { text: textModule.clip(text, STEP_TEXT_MAX), chars: text.length },
        stateBefore: 'idle', stateAfter: 'wait_response', ...empty,
      });
      return;
    }

    if (message.role === 'assistant') {
      //M 提取模型的工具调用，按有无调用标记下一状态。
      const calls = message.content
        .filter((block) => block.type === 'toolCall')
        .map((block) => ({ id: block.id, name: block.name, args: block.arguments }));
      let stateAfter = 'idle';
      if (calls.length > 0) {
        stateAfter = 'run_tools';
      }

      //M 骨架没有请求耗时，使用与上一条消息的时间差。
      let ms: number | null = null;
      if (startedAt > 0) {
        ms = Math.max(0, message.timestamp - startedAt);
      }

      //M 为模型步骤记录模型名、正文预览、工具调用和用量。
      const event = {
        model: `${message.provider}/${message.model}`,
        text: textModule.clip(piAi.contentText(message.content), STEP_TEXT_MAX),
        calls,
        stopReason: message.stopReason,
        input: message.usage.input,
        output: message.usage.output,
        ms,
      };
      all.push({
        seq, at: message.timestamp, row: 'E2', eventType: 'session/message（assistant）', event,
        stateBefore: 'wait_response', stateAfter, ...empty,
      });
      return;
    }

    if (message.role === 'toolResult') {
      //M 工具结果按成功或失败分配步骤行，供网页显示状态。
      const result = piAi.contentText(message.content);
      let stepRow = 'E3';
      if (message.isError) {
        stepRow = 'E4';
      }
      all.push({
        seq, at: message.timestamp, row: stepRow, eventType: 'session/message（toolResult）',
        event: { name: message.toolName, ok: !message.isError, resultChars: result.length, result: textModule.clip(result, STEP_TEXT_MAX) },
        stateBefore: 'run_tools', stateAfter: 'wait_response', ...empty,
      });
    }
  });

  //M 不在转的会话多一步“运行结束”：结局是现在的状态，出错时带原因。
  if (row.state !== 'running' && row.messages.length > 0) {
    let error: string | null = null;
    if (row.state === 'failed') {
      error = row.reply;
    }
    all.push({
      seq: row.messages.length + 1, at: row.updatedAt, row: 'E7', eventType: 'session/change',
      event: { ending: row.state, error },
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
 * 流水和用量分别通过事件查询，未取得结果时保留消息本身并在 notes 写明缺项。
 * @param ctx web-api 的 ctx。
 * @param input 消息、回话下标、会话标题、来源。
 * @returns 形状照网页的 ReplyTraceView（web/src/Types.ts:317-388）。
 * @throws Failure(404)：回话下标越界。
 */
export async function trace(ctx: cordis.Context, input: TraceInput): Promise<Record<string, unknown>> {
  const { message, replyIndex } = input;
  const reply = message.replies[replyIndex];
  //G 指定回复下标找不到时交回 404，结束追溯查询。
  if (reply === undefined) throw new failureModule.Failure(404, `消息 ${String(message.id)} 没有第 ${String(replyIndex)} 句回话`);

  //M 涉及的会话：这条消息从第一句到这一句回话出现过的会话号（去重）；时间窗：收到 → 这句回话。
  const sessions = [...new Set(message.replies.slice(0, replyIndex + 1).map((item) => item.sessionId))];
  const from = message.createdAt;
  const to = reply.at;
  const notes = ['只读：按收件表、流水、用量表现有的记录拼成，不重新执行'];

  const journalQuery = { action: 'message-lines', message: message.id, limit: EVENT_LIMIT } as const;
  const journalOptions = {
    timeoutMs: TRACE_QUERY_TIMEOUT_MS,
    onFallback: () => ({ requestId: '', lines: undefined }),
  };
  const usageQuery = { sessions, from, to, limit: USAGE_LIMIT };
  const usageOptions = {
    timeoutMs: TRACE_QUERY_TIMEOUT_MS,
    onFallback: () => ({ requestId: '', rows: [], truncated: false }),
  };

  //M 按消息取流水、按会话和时段取用量，两份明细可同时查询。
  const pendingJournal = requestEventModule.requestEvent(
    ctx,
    'journal/request',
    'journal/result',
    journalQuery,
    journalOptions,
  );
  const pendingUsage = requestEventModule.requestEvent(
    ctx,
    'usage/list',
    'usage/list-result',
    usageQuery,
    usageOptions,
  );
  const [journal, used] = await Promise.all([pendingJournal, pendingUsage]);

  //M 流水只保留目标消息和涉及会话中截至本句回话的记录。
  const lines = journal.lines ?? [];
  const mine = (line: (typeof lines)[number]): boolean => line.messageId === message.id || sessions.includes(line.sessionId ?? '');
  const events = lines.filter((line) => line.at <= to && mine(line));
  //M 取满了、最后一行还没到这句回话：后面的没取到。
  const lastAt = lines.at(-1)?.at ?? to;
  const cut = lines.length >= EVENT_LIMIT && lastAt < to;

  //M 缺流水时仅展示消息本身，缺用量时保留已有事件。
  let scope = 'exact';
  if (journal.lines === undefined) {
    scope = 'message-only';
    notes.push('没有流水明细或查询超时');
  }
  if (used.requestId === '') {
    notes.push('没有用量或查询超时');
  }
  if (cut) {
    notes.push(`事件超过 ${String(EVENT_LIMIT)} 条，只给前 ${String(EVENT_LIMIT)} 条`);
  }
  if (used.truncated) {
    notes.push(`用量超过 ${String(USAGE_LIMIT)} 行，只给前 ${String(USAGE_LIMIT)} 行`);
  }

  let elapsedMs: number | null = null;
  if (to >= from) {
    elapsedMs = to - from;
  }

  return {
    target: {
      messageId: message.id,
      replyIndex,
      bot: message.bot,
      sessionId: reply.sessionId,
      at: reply.at,
      //M 限制目标回话预览长度，保留完整字数供网页显示。
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
    scope,
    notes,
    sources: [{
      id: message.id,
      channel: message.channel,
      source: message.source,
      //M 限制原消息预览长度，保留完整字数供网页显示。
      text: textModule.clip(message.text, TRACE_TEXT_MAX),
      textChars: message.text.length,
      createdAt: message.createdAt,
      file: '',
    }],
    //M 跟踪行换成网页 TraceEvent 的外壳：type 是事件名或“模块.函数”，source 是听的人（函数行是发它的文件:行号），
    //M   data 里放跟踪行本身（kind、发法、听的人、人话、代码、位置、变量），网页按 data.kind 认出这是新格式。
    events: events.map((event) => {
      let source = event.site;
      const data: Record<string, unknown> = { kind: event.kind };
      if (event.mode !== '') {
        data['mode'] = event.mode;
      }
      if (event.kind === '事件') {
        source = event.listeners.join('、');
        data['listeners'] = event.listeners;
      }
      if (event.text !== '') {
        data['text'] = event.text;
      }
      if (event.code !== '') {
        data['code'] = event.code;
      }
      return {
        id: event.id, type: event.name, at: event.at, source,
        bot: event.bot, sessionId: event.sessionId, messageId: event.messageId, key: null, parent: null, depth: 0,
        data: { ...data, site: event.site, ...event.vars },
      };
    }),
    dispatches: [],
    usage: used.rows,
    usageScope: 'session-window',
    truncated: cut || used.truncated,
    startedAt: from,
    endedAt: to,
    endSource: 'reply-record',
    elapsedMs,
  };
}

