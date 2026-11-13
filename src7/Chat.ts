/**
 * 发一次模型请求。就这一个函数，不是插件，不存状态。
 * 它不知道会话、机器人、第几步；给它什么它发什么。
 * 只依赖 pi（PI agent SDK，@earendil-works/pi-ai）。
 *
 * 离线假模型：供应商名叫 fake，或地址以 fake: 开头，或环境变量 JMBOTS_FAKE=1。
 * 第一步返回调用 time 工具，第二步根据工具结果回一句中文。开发机连不到模型 API 时用它跑通链路。
 */
import * as process from 'node:process';
import type * as piAi from '@earendil-works/pi-ai';
import type { ModelHandle, Thinking } from './Resources.ts';


/** chat() 要的东西。全部由会话备好传进来。 */
export interface ChatRequest {
  /** 资源模块建好的 pi 模型，见 Resources.modelOf。 */
  model: ModelHandle;
  /** 系统提示词（几段已经拼成一个字符串）。 */
  system: string;
  /** 这一步要发给模型的对话。 */
  messages: piAi.Message[];
  /** 这一步给模型看的工具定义。 */
  tools: piAi.Tool[];
  /** 思考档。 */
  thinking: Thinking;
  /** 取消信号：喊停时触发，正在等的请求马上断开。 */
  signal: AbortSignal;
  /** 最多等多久，毫秒。 */
  timeoutMs: number;
}


/** chat() 交回的东西：成了带 message，没成带 error。 */
export interface ChatResult {
  /** 模型回的整条（文字、工具调用都在里面）。 */
  message?: piAi.AssistantMessage;
  /** 没成的原因；里面的密钥已经换成 ***。 */
  error?: string;
}


/** 假模型用量，全是 0。 */
const EMPTY_USAGE: piAi.Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};


/**
 * 用 pi 发一次请求。
 * @param request 模型、提示词、对话、工具清单、取消信号、超时。
 * @returns 成了带 message，没成带 error。不抛错。
 * 副作用：发一个 HTTP 请求（假模型不发）。
 */
export async function chat(request: ChatRequest): Promise<ChatResult> {
  // 离线假模型：不发 HTTP，按对话走到哪一步交回固定的回答。
  if (isFake(request.model)) {
    return fakeChat(request);
  }
  try {
    //M 把 request.signal 和超时合成一个信号：谁先触发都断开。
    const signal = combineSignals(request.signal, request.timeoutMs);
    //M 调 request.model.registry.completeSimple(request.model.piModel, { systemPrompt, messages, tools }, { signal, 思考档 })。
    const message = await request.model.registry.completeSimple(
      request.model.piModel,
      { systemPrompt: request.system, messages: request.messages, tools: request.tools },
      { signal, reasoning: request.thinking === 'off' ? undefined : request.thinking },
    );
    //G 供应商把失败写在 stopReason 里（error、aborted），不一定抛错：自己判，交回 { error }。
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return { error: mask(message.errorMessage ?? `模型出错了（${message.stopReason}）`, request.model.apiKey) };
    }
    //M 成了：交回 { message }。
    return { message };
  } catch (error) {
    //G 抛出来的错也接住，交回 { error }。
    //M 错误原因里如果回显了密钥，换成 ***。
    const text = error instanceof Error ? error.message : String(error);
    return { error: mask(text, request.model.apiKey) };
  }
}


/**
 * 是不是走离线假模型。
 * @param model 资源模块交来的模型。
 */
function isFake(model: ModelHandle): boolean {
  if (process.env['JMBOTS_FAKE'] === '1') {
    return true;
  }
  const provider = model.piModel.provider;
  const baseUrl = model.piModel.baseUrl ?? '';
  return provider === 'fake' || baseUrl.startsWith('fake:');
}


/**
 * 把喊停信号和超时合成一个：谁先触发都断开。
 * @param signal 喊停用的信号。
 * @param timeoutMs 超时毫秒。
 */
function combineSignals(signal: AbortSignal, timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  }
  const merged = new AbortController();
  const onAbort = (): void => {
    merged.abort();
  };
  if (signal.aborted) {
    merged.abort();
    return merged.signal;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  merged.signal.addEventListener('abort', () => {
    clearTimeout(timer);
  }, { once: true });
  return merged.signal;
}


/**
 * 出错原因里如果回显了密钥，换成星号。
 * @param value 原来的原因。
 * @param apiKey 这家的密钥。
 */
function mask(value: string, apiKey: string): string {
  if (apiKey === '' || apiKey === 'no-key' || !value.includes(apiKey)) {
    return value;
  }
  return value.split(apiKey).join('***');
}


/**
 * 离线假模型：对话里还没有 time 的结果就“要调用 time”；已经有结果就回一句中文。
 * @param request 这一步的请求（只用 messages）。
 */
function fakeChat(request: ChatRequest): ChatResult {
  /** 对话里最后一条工具结果的文字。 */
  const lastToolText = lastToolResultText(request.messages);
  const now = Date.now();
  if (lastToolText !== undefined) {
    return {
      message: fakeAssistant(
        [{ type: 'text', text: `现在是 ${lastToolText}` }],
        'stop',
        request.model,
        now,
      ),
    };
  }
  return {
    message: fakeAssistant(
      [
        { type: 'text', text: '我来查一下现在的时间。' },
        { type: 'toolCall', id: 'fake_time_1', name: 'time', arguments: {} },
      ],
      'toolUse',
      request.model,
      now,
    ),
  };
}


/**
 * 从后往前找最后一条工具结果的文字。
 * @param messages 这一步的对话。
 */
function lastToolResultText(messages: piAi.Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item === undefined) {
      continue;
    }
    if (item.role === 'toolResult') {
      return item.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    }
    if (item.role === 'user' || item.role === 'assistant') {
      return undefined;
    }
  }
  return undefined;
}


/**
 * 拼一条假的助手消息，字段按 pi 的 AssistantMessage 填齐。
 * @param content 文字块和工具调用。
 * @param stopReason 结束原因。
 * @param model 用哪家、哪个模型。
 * @param timestamp 毫秒时间戳。
 */
function fakeAssistant(
  content: piAi.AssistantMessage['content'],
  stopReason: piAi.StopReason,
  model: ModelHandle,
  timestamp: number,
): piAi.AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.piModel.api,
    provider: model.piModel.provider,
    model: model.piModel.id,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp,
  };
}
