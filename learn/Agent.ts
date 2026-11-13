/**
 * 最小骨架：组装上下文、跑模型循环。
 * 本身不读配置、不执行工具；调模型前后和工具前后都发 Cordis 事件，工具由插件响应。
 * 只依赖 Cordis 和 pi-ai，不引用 src6。
 *
 * 事件怎么派发（两种用法，原因不同）：
 *
 * - agent/before-model、agent/before-tool、agent/after-tool、agent/done 用
 *   `await ctx.parallel(...)`。vendored Cordis（src6/cordis，与 import 'cordis' 同一套）
 *   的 parallel 会用 Promise.allSettled 同时启动所有监听者，等到全部结束（可以是 async）。
 *   它本身不收集返回值（签名是 Promise<void>），一个监听者抛错也不会打断别人，
 *   全部结束后若有失败再抛 AggregateError。所以要拿结果，事件载荷里带 `votes` 数组，
 *   每个插件把自己的意见 push 进去；全部结束后由骨架合并判断。
 *   完成顺序不保证（同时跑），不要让后一个插件依赖前一个已经写完的字段。
 *   若插件之间有先后依赖，不要用 parallel：改成按注册顺序逐个 `await` 监听者，
 *   同样把意见都收进 votes，再合并（不要用 serial，serial 是「谁先返回非空就停」）。
 *
 * - agent/tool 用 `await ctx.serial(...)`：按注册顺序逐个 await，第一个返回非 undefined
 *   （也不是 null/false）的结果生效，后面不再跑。只需要一个人执行工具，避免重复执行。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as piAnthropic from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import * as piCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as piResponses from '@earendil-works/pi-ai/api/openai-responses.lazy';
import * as cordis from 'cordis';


declare module 'cordis' {
  interface Context {
    /** 最小骨架服务，实现在 learn/Agent.ts，通过 ctx.agent.run 启动循环。 */
    agent: Agent;
  }
  interface Events {
    /**
     * 每次向模型发请求之前触发（await parallel，所有插件都跑完再继续）。
     * 载荷是 system、messages、step、votes。监听者可以是异步的，可以改 event 上的字段，
     * 也可以把说明 push 进 event.votes。parallel 不收集返回值，不要靠 return 覆盖上下文。
     * 全部结束后，骨架采用 event 上（可能被改过的）system 和 messages。
     * 多个插件同时改同一字段没有先后保证；有依赖时见文件头注释。
     */
    'agent/before-model'(event: BeforeModelEvent): void | Promise<void>;
    /**
     * 执行每一个工具之前触发（await parallel，所有插件都跑完再合并）。
     * 载荷是这次的工具调用和 votes。监听者可以是异步的，把意见 push 进 event.votes：
     * `{ plugin, skip: 理由 }` 表示主张不执行，`{ plugin, note }` 表示放行并留下说明。
     * 全部结束后，骨架合并：只要有一条带 skip，就不跑工具，把各条理由用「；」拼起来，
     * 写成「未执行：理由」作为工具结果回给模型。
     */
    'agent/before-tool'(event: BeforeToolEvent): void | Promise<void>;
    /**
     * 请工具插件真正执行这次调用（await serial）。
     * 第一个交回 ToolOutcome 的监听者生效，其余不再跑（避免同一个工具被执行两次）。
     * 没人响应时，骨架把「没有执行者」当作出错结果回给模型。
     */
    'agent/tool'(event: ToolEvent): ToolOutcome | void | Promise<ToolOutcome | void>;
    /**
     * 一个工具跑完之后触发（await parallel，包括被 skip、没人执行、执行出错）。
     * 载荷是调用、给模型看的文字、是否出错、votes。监听者可以是异步的，可以把说明
     * push 进 event.votes；只是通知，骨架不靠返回值改结果。所有插件都跑完再往下走。
     */
    'agent/after-tool'(event: AfterToolEvent): void | Promise<void>;
    /**
     * 模型不再调工具、循环正常结束时触发（await parallel），载荷是最终文字和 votes。
     * 监听者可以是异步的，全部跑完再返回给调用方。
     * 模型出错或步数用完还在调工具时不发这个事件，结果写在 AgentResult.error 里。
     */
    'agent/done'(event: DoneEvent): void | Promise<void>;
  }
}


/** 请求协议：和常见 OpenAI / Anthropic 兼容接口对应，pi-ai 用它选实现。 */
export type ChatApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';


/** 调模型要用的参数，由外面的插件（比如 CLI）拼好传进来，骨架不读配置文件。 */
export interface AgentModel {
  /** 请求地址。 */
  baseUrl: string;
  /** 供应商内的模型 ID。 */
  id: string;
  /** 请求密钥；空串表示本地服务不要密钥。 */
  apiKey: string;
  /** 上下文 token 数。 */
  contextWindow: number;
  /** 最大输出 token 数。 */
  maxTokens: number;
  /** 请求协议；不写按 OpenAI Chat Completions。 */
  api?: ChatApi;
  /** 供应商名，写进 pi-ai 的 provider；不写用 learn。 */
  provider?: string;
}


/** 跑一轮循环要给的东西。 */
export interface AgentRequest {
  /** 用哪个模型（地址、密钥、协议都在里面）。 */
  model: AgentModel;
  /** 系统提示词。 */
  system: string;
  /** 对话（含用户消息）；骨架会复制一份再改，不改调用方的数组。 */
  messages: piAi.Message[];
  /** 工具定义（只有名字、说明、参数形状）；真正执行交给 agent/tool 事件。 */
  tools: piAi.Tool[];
  /** 最多调几步模型；最后一步还在调工具就结束并带上原因。 */
  maxSteps: number;
}


/** 循环的结果。 */
export interface AgentResult {
  /** 最后的文字回复；出错时可能是空串。 */
  text: string;
  /** 没成的原因（模型出错、步数用完还在调工具）；成了就没有。 */
  error?: string;
}


/**
 * 插件对一次事件的意见。parallel 不收集返回值，所以每个监听者把意见 push 进 event.votes，
 * 等全部跑完后由骨架合并（before-tool：任一条带 skip 就跳过工具，理由拼在一起回给模型）。
 */
export interface PluginVote {
  /** 哪个插件投的；可选，合并和打印时用来看来源。 */
  plugin?: string;
  /** 若有：这个插件主张跳过（不执行工具），理由会汇总后回给模型。 */
  skip?: string;
  /** 额外说明，不单独构成跳过。 */
  note?: string;
}


/** 调模型之前：监听者可以改 system 和 messages，并把说明 push 进 votes。 */
export interface BeforeModelEvent {
  /** 当前系统提示词；监听者可以换成压缩或改写后的。 */
  system: string;
  /** 当前对话；监听者可以改内容，也可以整份换成新数组。 */
  messages: piAi.Message[];
  /** 已经走到第几步，从 1 数。 */
  step: number;
  /** 所有插件把意见 push 到这里；parallel 结束后骨架可以查看。 */
  votes: PluginVote[];
}


/** 执行工具之前：只带这次调用和 votes；要不要执行由全部插件的 votes 合并决定。 */
export interface BeforeToolEvent {
  /** 模型要调的这个工具（名字、参数、调用号）。 */
  call: piAi.ToolCall;
  /** 所有插件把意见 push 到这里；有 skip 就跳过，理由合并后回给模型。 */
  votes: PluginVote[];
}


/** 请工具插件执行。 */
export interface ToolEvent {
  /** 模型要调的这个工具。 */
  call: piAi.ToolCall;
}


/** 工具插件交回来的结果。 */
export interface ToolOutcome {
  /** 给模型看的文字，会接到对话后面。 */
  text: string;
  /** 是不是出错了；出错时模型下一圈会看到 isError。 */
  isError: boolean;
}


/** 一个工具跑完了（通知用）。 */
export interface AfterToolEvent {
  /** 刚才调的工具。 */
  call: piAi.ToolCall;
  /** 给模型看的文字。 */
  text: string;
  /** 是不是出错了（含被 skip、没人执行）。 */
  isError: boolean;
  /** 所有插件可以把说明 push 到这里。 */
  votes: PluginVote[];
}


/** 循环正常结束。 */
export interface DoneEvent {
  /** 模型最后回的文字。 */
  text: string;
  /** 所有插件可以把说明 push 到这里。 */
  votes: PluginVote[];
}


/** 这次 run 建好的 pi-ai 集合和模型，completeSimple 用。 */
interface Session {
  /** 只登记了这一家供应商的模型集合。 */
  registry: piAi.MutableModels;
  /** 和请求对应的那一个 pi-ai 模型。 */
  piModel: piAi.Model<piAi.Api>;
}


/** 模型请求最多等多久，毫秒。超时后按模型出错处理。 */
const TIMEOUT_MS = 120_000;

/** 没人响应 agent/tool 时给模型的说明。 */
const NO_HANDLER = '没有执行者';

/** 三种协议对应的 pi-ai 实现，和 ModelPull.ts 同一套懒加载入口。 */
const CHAT_APIS: Record<ChatApi, () => ReturnType<typeof piCompletions.openAICompletionsApi>> = {
  'openai-completions': piCompletions.openAICompletionsApi,
  'openai-responses': piResponses.openAIResponsesApi,
  'anthropic-messages': piAnthropic.anthropicMessagesApi,
};


/** 最小骨架：一个 Cordis 服务，对外只有 run。 */
export class Agent extends cordis.Service {
  /**
   * 登记成 ctx.agent。
   * @param ctx Cordis 给这个插件的 ctx，发事件（parallel / serial）都走它。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'agent');
  }

  /**
   * 跑一轮：调模型 → 有工具就发事件执行再来 → 没工具就发 agent/done 返回。
   * before-model / done 用 await parallel，等所有异步插件都跑完；工具执行见 runTools。
   * @param request 模型、上下文、工具定义、最多几步。骨架不读配置。
   * @returns 结果；模型出错不抛，写成 error。
   * 副作用：发模型请求；发 agent/* 事件。
   */
  async run(request: AgentRequest): Promise<AgentResult> {
    /** 对话副本；before-model 的监听者可能整份换掉。 */
    let messages = [...request.messages];
    /** 系统提示词；before-model 的监听者可能改。 */
    let system = request.system;
    /** 按这次请求建的 pi-ai 集合，整轮循环共用。 */
    const session = this.sessionOf(request.model);
    for (let step = 1; step <= request.maxSteps; step += 1) {
      //M 先 await parallel before-model，让所有异步插件都有机会改上下文（压缩、注入记忆），再用改过的去调模型。
      /** 调模型前的事件；监听者改这个对象、把意见推进 votes，不用 return。 */
      const before: BeforeModelEvent = { system, messages, step, votes: [] };
      await this.ctx.parallel('agent/before-model', before);
      system = before.system;
      messages = before.messages;
      /** 模型这一次的结果：成功带 message，失败带 error。 */
      const outcome = await this.chat(session, system, messages, request.tools, request.model.apiKey);
      //G 模型没成：记下来就结束，不发 done（没拿到可交给用户的回复）。
      if (outcome.message === undefined) {
        return { text: '', error: outcome.error };
      }
      /** 模型回的整条（文字、工具调用都在 content 里）。 */
      const message = outcome.message;
      /** 文字块拼起来的回复；工具调用块不算文字。 */
      const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      messages.push(message);
      /** 这一步要调的工具。 */
      const calls = message.content.filter((block): block is piAi.ToolCall => block.type === 'toolCall');
      //M 不调工具了：任务做完，await parallel done（让所有异步监听者收尾），把最终文字交回去。
      if (calls.length === 0) {
        await this.ctx.parallel('agent/done', { text, votes: [] });
        return { text };
      }
      //G 最后一步还在调工具：再执行也没有下一圈把结果送给模型，所以停并带上原因。
      if (step === request.maxSteps) {
        return { text, error: `走了 ${String(request.maxSteps)} 步还在调工具` };
      }
      //M 步数还没用完：执行工具，把结果接到对话后面，再进入下一圈。
      await this.runTools(calls, messages);
    }
    return { text: '', error: `走了 ${String(request.maxSteps)} 步还没结束` };
  }

  /**
   * 执行这一步要调的工具：先 await parallel before-tool 并合并 votes（有 skip 就不跑），
   * 再 await serial agent/tool（第一个接手的执行），再 await parallel after-tool，结果接到对话后面。
   * @param calls 模型要调的工具，按模型给出的顺序逐个执行。
   * @param messages 当前对话；每个工具的结果会追加一条 toolResult。
   * @returns 全部工具处理完以后完成。
   */
  private async runTools(calls: piAi.ToolCall[], messages: piAi.Message[]): Promise<void> {
    for (const call of calls) {
      //M 先 await parallel before-tool：所有插件都跑，意见推进 votes；有人 skip 就合并理由、不跑工具。
      /** 给所有插件投意见的事件。 */
      const before: BeforeToolEvent = { call, votes: [] };
      await this.ctx.parallel('agent/before-tool', before);
      /** 主张跳过的理由；空数组表示没人反对，继续执行。 */
      const reasons = skippedReasons(before.votes);
      /** 最终给模型看的结果。 */
      let outcome: ToolOutcome;
      if (reasons.length > 0) {
        outcome = { text: `未执行：${reasons.join('；')}`, isError: true };
      } else {
        //M agent/tool 用 serial：只要一个人执行，第一个交回结果的生效。
        /** 插件交回来的；没人响应是 undefined。 */
        const handed = await this.ctx.serial('agent/tool', { call });
        if (isOutcome(handed)) {
          outcome = handed;
        } else {
          outcome = { text: NO_HANDLER, isError: true };
        }
      }
      /** 跑完后的通知；所有插件都 await 完再往下。 */
      const after: AfterToolEvent = { call, text: outcome.text, isError: outcome.isError, votes: [] };
      await this.ctx.parallel('agent/after-tool', after);
      //M 工具结果必须进对话（包括「未执行」和「没有执行者」），模型下一圈才能根据结果继续。
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: outcome.text }],
        isError: outcome.isError,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 调一次模型：跟 ModelCall.run 同一条 completeSimple。
   * @param session 这次 run 建好的集合和模型。
   * @param system 系统提示词（可能已经被 before-model 改过）。
   * @param messages 当前对话。
   * @param tools 工具定义。
   * @param apiKey 用来抹掉错误里回显的密钥，不另发请求。
   * @returns 成功带 message，失败带 error；不抛。
   */
  private async chat(
    session: Session,
    system: string,
    messages: piAi.Message[],
    tools: piAi.Tool[],
    apiKey: string,
  ): Promise<{ message?: piAi.AssistantMessage; error?: string }> {
    try {
      /** 模型回的整条。 */
      const message = await session.registry.completeSimple(
        session.piModel,
        { systemPrompt: system, messages, tools },
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      //G 供应商把失败写在 stopReason 里，不一定抛错，这里要自己判。
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        return { error: mask(message.errorMessage ?? `模型出错了（${message.stopReason}）`, apiKey) };
      }
      return { message };
    } catch (error) {
      return { error: mask(error instanceof Error ? error.message : String(error), apiKey) };
    }
  }

  /**
   * 按请求里的地址、密钥、协议建一个只用这一家的 pi-ai 集合。写法跟 ModelPull.buildProvider 一样。
   * @param model 请求里的模型参数。
   * @returns 集合和 pi-ai 模型，completeSimple 用。
   */
  private sessionOf(model: AgentModel): Session {
    /** 协议；不写按 OpenAI Chat Completions。 */
    const api: ChatApi = model.api ?? 'openai-completions';
    /** 去掉末尾斜杠的地址。 */
    const baseUrl = model.baseUrl.replace(/\/+$/u, '');
    /** 本地服务可以不要密钥；pi-ai 约定空密钥用 no-key。 */
    const apiKey = model.apiKey === '' ? 'no-key' : model.apiKey;
    /** 供应商名，同时是 pi-ai provider 的 id。 */
    const provider = model.provider ?? 'learn';
    /** pi-ai 的常规模型。 */
    const piModel: piAi.Model<piAi.Api> = {
      id: model.id,
      name: model.id,
      provider,
      baseUrl,
      api,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    };
    /** 只用这一家的集合。 */
    const registry = piAi.createModels();
    registry.setProvider(piAi.createProvider({
      id: provider,
      baseUrl,
      auth: {
        apiKey: {
          name: '请求里的密钥',
          resolve: () => Promise.resolve({ auth: { apiKey }, source: 'request' }),
        },
      },
      models: [piModel],
      api: CHAT_APIS[api](),
    }));
    return { registry, piModel };
  }
}


/**
 * 从 votes 里取出所有主张跳过的理由（有内容的 skip 字符串）。
 * @param votes 全部插件 push 进去的意见。
 * @returns 理由列表；空表示没人要求跳过。
 */
function skippedReasons(votes: PluginVote[]): string[] {
  /** 主张跳过的那些票。 */
  const reasons: string[] = [];
  for (const vote of votes) {
    if (typeof vote.skip === 'string' && vote.skip !== '') {
      reasons.push(vote.skip);
    }
  }
  return reasons;
}


/**
 * 是不是工具插件交回来的结果（有 text 和 isError）。
 * @param value serial 的返回值，没人响应时是 undefined。
 * @returns 是结果就是 true。
 */
function isOutcome(value: unknown): value is ToolOutcome {
  return value !== null && typeof value === 'object'
    && typeof (value as ToolOutcome).text === 'string'
    && typeof (value as ToolOutcome).isError === 'boolean';
}


/**
 * 出错原因里如果回显了密钥，换成星号。
 * @param value 原来的原因。
 * @param apiKey 请求里的密钥。
 * @returns 抹过密钥的文字。
 */
function mask(value: string, apiKey: string): string {
  //G 空密钥或占位 no-key 不用替，避免把无关文字误伤。
  if (apiKey === '' || apiKey === 'no-key' || !value.includes(apiKey)) {
    return value;
  }
  return value.split(apiKey).join('***');
}
