/**
 * 发一次模型请求。就这一个函数，不是插件，不存状态。
 * 它不管会话怎么走；给它什么请求它发什么。只依赖 pi（PI agent SDK，@earendil-works/pi-ai）。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from './Sessions.ts';


declare module 'cordis' {
  interface Events {
    /** 模型调用失败了一次（含会重试的那几次；被喊停的不算）。通知，用量、追溯这类插件听它。 */
    'model/failed'(info: ModelFailed): void;
  }
}


/** 事件 model/failed 带的东西。 */
export interface ModelFailed {
  /** 是哪场会话的请求。 */
  session: Session;
  /** 哪个模型，供应商名/模型 ID。 */
  model: string;
  /** pi 给的错误文字。 */
  error: string;
  /** 这一次从发出到失败用了多少毫秒。 */
  ms: number;
}


/** 思考档：off 不思考，往后越来越深。模型不支持的档位，pi 自动换成最近的。 */
export type Thinking = piAi.ModelThinkingLevel;


/**
 * 一步的请求。会话备好，先交给插件挨个改（事件 session/request），再交给 chat() 发出去。
 */
export interface ChatRequest {
  /** 是哪场会话的。chat() 不看它；插件靠它知道种类、机器人、整场对话。 */
  session: Session;
  /** 用哪个模型，供应商名/模型 ID。 */
  model: string;
  /** 思考档。 */
  thinking: Thinking;
  /** 系统提示词的段落；发请求时用空行拼起来。 */
  system: string[];
  /** 这一步给模型看的工具定义。 */
  tools: piAi.Tool[];
  /** 这一步要发给模型的对话，是副本：改它不会改库里存的原文。 */
  messages: piAi.Message[];
  /** 取消信号：喊停时触发，正在等的请求马上断开。 */
  signal: AbortSignal;
  /** 插件直接给的回答（比如假模型）。有了它，会话就不调 chat()。 */
  answer?: piAi.AssistantMessage;
}


/**
 * 用 pi 发一次请求。
 * @param ctx 取 ctx.resources（建好的供应商、模型、重试的配置），发 model/failed 用。
 * @param request 模型、思考档、提示词、对话、工具、取消信号。
 * @returns 模型回的整条（文字、工具调用都在里面）。
 * @throws 试够了次数还是不成、或者被喊停掐断时抛错；Session.run 接住。
 * 副作用：发 HTTP 请求。
 */
export async function chat(ctx: cordis.Context, request: ChatRequest): Promise<piAi.AssistantMessage> {
  const resources = ctx.resources;
  const retry = resources.config.retry;
  const model = resources.modelOf(request.model);

  //M 拼 pi 要的上下文：提示词的段落用空行连成一段。
  const systemPrompt = request.system.join('\n\n');
  const context: piAi.Context = {
    systemPrompt,
    messages: request.messages,
    tools: request.tools,
  };

  //M 请求选项：思考档 off 就不传 reasoning；pi 自己不重试（maxRetries 0），重试交给下面的 retryAssistantCall。
  const reasoning = request.thinking === 'off' ? undefined : request.thinking;
  const options = {
    signal: request.signal,
    reasoning,
    timeoutMs: retry.timeoutMs,
    maxRetries: 0,
  };

  //M 发请求。临时的错（断网、限流、超时）隔一会儿再试，最多再试 retry.times 次；喊停了不再试。
  //M   重试、判断哪种错值得再试，都是 pi 的 retryAssistantCall 做的。
  const policy: piAi.RetryPolicy = {
    enabled: true,
    maxRetries: retry.times,
    baseDelayMs: retry.waitMs,
  };

  //M 发一次：每次失败（stopReason 是 error）发一次通知 model/failed，重试的那几次插件也看得到；被喊停的 aborted 不发。
  const send = async (): Promise<piAi.AssistantMessage> => {
    const start = Date.now();
    const answer = await resources.models.completeSimple(model, context, options);
    if (answer.stopReason === 'error') {
      const failed: ModelFailed = {
        session: request.session,
        model: request.model,
        error: answer.errorMessage ?? '',
        ms: Date.now() - start,
      };
      ctx.emit('model/failed', failed);
    }
    return answer;
  };
  const answer = await piAi.retryAssistantCall(send, policy, request.signal);

  //G pi 把失败写在回答的 stopReason 里，不抛错。这里统一抛出去。
  if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
    const reason = answer.errorMessage ?? `模型请求没成（${answer.stopReason}）`;
    throw new Error(reason);
  }
  return answer;
}
