/**
 * 测试用的假模型：不联网、不花钱。chat 按顺序回放写好的回复，decide 由测试给的函数回答。
 * 文件名不是 *.test.ts，bun test 不会把它当测试跑。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as model from '../src/Model.ts';


/** 写好的一次常规模型回复。 */
export interface ScriptedReply {
  /** 回复文字。 */
  text: string;

  /** 要调的工具：名字和参数；ID 由这里编。 */
  toolCalls?: { name: string; arguments: piAi.JsonObject }[];

  /** 出错时的原因。 */
  error?: string;
}


/** 假的模型调用入口，连同它收到的请求。 */
export interface FakeAi {
  /** 交给被测代码的入口。 */
  ai: model.Ai;

  /** chat 收到的请求，按先后；上下文是当时的副本。 */
  chats: model.ChatInput[];

  /** decide 收到的请求，按先后。 */
  decisions: model.DecideInput[];
}


/**
 * 造一个假的模型调用入口。
 * @param replies 常规模型按顺序给的回复；用完了再调就报错，测试会失败。
 * @param answer 决策模型怎么回答：拿到请求，返回问题名 → 回答。
 */
export function createFakeAi(replies: ScriptedReply[], answer: (input: model.DecideInput) => Record<string, piAi.ClassifierAnswer>): FakeAi {
  /** chat 收到的请求。 */
  const chats: model.ChatInput[] = [];
  /** decide 收到的请求。 */
  const decisions: model.DecideInput[] = [];
  /** 还没用的回复。 */
  const queue = [...replies];
  /** 已经编到第几个工具调用 ID。 */
  let callCount = 0;
  const ai: model.Ai = {
    chat: (input) => {
      chats.push({ ...input, messages: [...input.messages] });
      /** 这次的回复。 */
      const reply = queue.shift();
      if (!reply) {
        return Promise.reject(new Error('写好的回复用完了'));
      }
      /** 工具调用，补上 ID。 */
      const toolCalls = (reply.toolCalls ?? []).map((call): piAi.ToolCall => {
        callCount += 1;
        return { type: 'toolCall', id: `call_${callCount}`, name: call.name, arguments: call.arguments };
      });
      return Promise.resolve(chatOutput(input, reply.text, toolCalls, reply.error));
    },
    decide: (input) => {
      decisions.push(input);
      return Promise.resolve({
        answers: answer(input),
        ms: 5,
        request: { model: 'magpie/openrouter/typesafe/jev-1.14', state: input.state, questions: input.questions },
      });
    },
  };
  return { ai, chats, decisions };
}


/**
 * 造一次常规模型调用的结果，像 Model.ts 的 chat() 返回的那样。
 * @param input 这次的请求。
 * @param text 回复文字。
 * @param toolCalls 工具调用。
 * @param error 出错原因；没出错时不写。
 */
function chatOutput(input: model.ChatInput, text: string, toolCalls: piAi.ToolCall[], error?: string): model.ChatOutput {
  /** 用量。 */
  const usage: piAi.Usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  /** 结束原因。 */
  let stopReason: piAi.StopReason = toolCalls.length > 0 ? 'toolUse' : 'stop';
  if (error) {
    stopReason = 'error';
  }
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }, ...toolCalls],
      api: 'openai-completions',
      provider: 'magpie',
      model: 'workbuddy/deepseek-v4.1-flash',
      usage,
      stopReason,
      timestamp: Date.now(),
    },
    text,
    thinking: '',
    toolCalls,
    error,
    ms: 1000,
    request: {
      role: input.role,
      model: 'magpie/workbuddy/deepseek-v4.1-flash',
      thinkingAsked: 'off',
      thinking: 'off',
      system: Object.values(input.system).join('\n\n'),
      tools: (input.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      messages: [...input.messages],
    },
  };
}
