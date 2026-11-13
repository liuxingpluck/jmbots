/**
 * 模型客户端：把会话拼好的请求发给模型，等它回话。
 *
 * 只认 OpenAI 的 chat completions 协议（项目里叫 openai-completions）：
 * POST <base_url>/chat/completions，不用流式，一次拿到整个回话。
 * 会话里的消息（user、assistant、tool）换成协议的格式发出去；回话里的文字、工具调用、思考再换回来。
 * 地址和密钥按模型的 provider 从 config.yaml 的 providers 里取：Main.ts 用 Resources 读出来传进来，这里不读文件。
 * 不打印密钥和请求头。
 */
import * as checks from '../utils/Checks.ts';
import type * as resourcesModule from '../resources/Resources.ts';
import type * as sessionModule from './Session.ts';


/** 认得的接口协议：OpenAI 的 chat completions，和 config.yaml 里 providers 的 api 用同一个名字。 */
const CHAT_COMPLETIONS = 'openai-completions';

/** 出错时带上回应的前多少个字，看得出原因又不刷屏。 */
const ERROR_TEXT_LIMIT = 300;


/** 模型的上下文：用哪家的哪个模型、走什么协议、它能做什么。 */
export interface ModelConfig {
  /** 供应商：config.yaml 的 providers 下的键，如 magpie。地址和密钥按它去找。 */
  provider: string;
  /** 模型 ID：供应商那边的叫法，如 workbuddy/hy4free。请求里的 model 就写它。 */
  modelId: string;
  /** 接口协议：现在只认 openai-completions。 */
  api: string;
  /** 会不会思考（回话里带思考过程）。只记下、打印，不改请求。 */
  reasoning: boolean;
  /** 上下文长度（token）；不知道写 null。只记下、打印，不改请求。 */
  contextWindow: number | null;
  /** 最多输出多少 token；不知道写 null，请求里就不带，用模型自己的默认。 */
  maxOutputTokens: number | null;
  /** 能收哪些输入，如 text、image。只记下、打印；这一步只发文字。 */
  inputTypes: string[];
}

/** 一次请求：会话拼好，交给客户端。 */
export interface ModelRequest {
  /** 用哪个模型。 */
  model: ModelConfig;
  /** 系统提示词。 */
  systemPrompt: string;
  /** 对话，按发生顺序。拼请求时复制的一份，之后会话再加消息不影响它。 */
  messages: sessionModule.Message[];
  /** 模型能调用的工具。 */
  tools: sessionModule.Tool[];
}

/** 模型的一次回话。 */
export interface ModelReply {
  /** 回的话；只调工具时可能是空字符串。 */
  text: string;
  /** 要调的工具；不调工具时是空数组。 */
  toolCalls: sessionModule.ToolCall[];
  /** 思考过程（有的模型会给，在 reasoning_content 里）；没有是空字符串。 */
  thinking: string;
}


/** 模型客户端：按 OpenAI chat completions 协议请求模型。 */
export class ModelClient {
  /** 各家供应商的地址和密钥，键是供应商名（config.yaml 的 providers 下的键）。 */
  private readonly providers: Record<string, resourcesModule.ProviderConfig>;

  /** 一次请求最多等多少毫秒，超过算出错。 */
  private readonly timeoutMs: number;

  /**
   * 建客户端。只是记下，不联网。
   * @param providers 各家供应商的地址和密钥（Main.ts 从 Resources.getProviders() 拿到传进来）。
   * @param timeoutMs 一次请求最多等多少毫秒。
   */
  constructor(providers: Record<string, resourcesModule.ProviderConfig>, timeoutMs: number) {
    this.providers = providers;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 请求模型，等它回话。
   * @param request 会话拼好的请求。
   * @returns 回话：文字、工具调用、思考。
   * @throws 协议不认识、没有这家供应商、连不上、超时、HTTP 不是 2xx、回的不是 chat completions 的样子时抛错。
   * 副作用：发一次 HTTP 请求，真实调用模型。
   */
  async complete(request: ModelRequest): Promise<ModelReply> {
    /** 用哪个模型。 */
    const model = request.model;
    //G 只认 chat completions 协议。
    if (model.api !== CHAT_COMPLETIONS) {
      throw new Error(`模型 ${model.provider}/${model.modelId} 的协议是 ${model.api}，现在只认 ${CHAT_COMPLETIONS}`);
    }
    /** 这家供应商在 config.yaml 里写的地址和密钥。 */
    const provider = this.providers[model.provider];
    //G config.yaml 的 providers 里没有这家。
    if (!provider) {
      throw new Error(`config.yaml 的 providers 里没有 ${model.provider}`);
    }

    //M 1. 地址和请求头。config.yaml 是外部输入，用到时检查。
    /** 供应商的地址，去掉末尾斜杠。 */
    const baseUrl = checks.requireString(provider.base_url, `providers.${model.provider}.base_url`);
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    /** 密钥；本地不要密钥的服务可以不写。不打印。 */
    const apiKey = checks.optionalString(provider.api_key, `providers.${model.provider}.api_key`);
    /** 请求头，不打印。 */
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    //M 2. 请求体换成协议的格式，发出去。超时就取消。
    const body = this.toRequestBody(request);
    const bodyText = JSON.stringify(body);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      body: bodyText,
      signal,
    };

    const response = await fetch(url, requestInit);

    //M 3. 读回应。HTTP 不是 2xx 时带上回应的开头一段，看得出原因。
    if (!response.ok) {
      const errorText = await response.text();
      const errorStart = errorText.slice(0, ERROR_TEXT_LIMIT);
      throw new Error(`HTTP ${response.status}：${errorStart}`);
    }
    /** 回应的 JSON：外部输入，readReply 逐项检查。 */
    const data: unknown = await response.json();
    return this.readReply(data);
  }

  /**
   * 请求换成 chat completions 的请求体：系统提示词放最前面，后面是对话，再带上工具。
   * @param request 会话拼好的请求。
   * @returns 请求体。
   */
  private toRequestBody(request: ModelRequest): Record<string, unknown> {
    /** 系统提示词，协议里是 role 为 system 的第一条消息。 */
    const systemMessage = {
      role: 'system',
      content: request.systemPrompt,
    };
    /** 协议格式的消息。 */
    const apiMessages: Record<string, unknown>[] = [systemMessage];
    for (const message of request.messages) {
      const apiMessage = this.toApiMessage(message);
      apiMessages.push(apiMessage);
    }

    /** 协议格式的工具。 */
    const apiTools: Record<string, unknown>[] = [];
    for (const tool of request.tools) {
      const apiFunction = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
      const apiTool = {
        type: 'function',
        function: apiFunction,
      };
      apiTools.push(apiTool);
    }

    const body: Record<string, unknown> = {
      model: request.model.modelId,
      messages: apiMessages,
      stream: false,
    };
    if (apiTools.length > 0) {
      body.tools = apiTools;
    }
    if (request.model.maxOutputTokens !== null) {
      body.max_tokens = request.model.maxOutputTokens;
    }
    return body;
  }

  /**
   * 会话里的一条消息换成协议的格式。
   * @param message 会话里的消息。
   * @returns 协议格式的消息。
   */
  private toApiMessage(message: sessionModule.Message): Record<string, unknown> {
    //M 用户说的话。
    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.text,
      };
    }

    //M 工具的结果：带上是哪次调用的。
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.callId,
        content: message.text,
      };
    }

    //M 模型的回话：调了工具就带上 tool_calls；有思考就原样带回去（DeepSeek 这类模型思考着调工具时要求带回）。
    const apiMessage: Record<string, unknown> = {
      role: 'assistant',
      content: message.text,
    };
    if (message.toolCalls.length > 0) {
      const apiCalls: Record<string, unknown>[] = [];
      for (const call of message.toolCalls) {
        const apiFunction = {
          name: call.name,
          arguments: call.argumentsText,
        };
        const apiCall = {
          id: call.id,
          type: 'function',
          function: apiFunction,
        };
        apiCalls.push(apiCall);
      }
      apiMessage.tool_calls = apiCalls;
    }
    if (message.thinking) {
      apiMessage.reasoning_content = message.thinking;
    }
    return apiMessage;
  }

  /**
   * 读回应：取第一个 choice 的 message，换回会话用的回话。回应是外部输入，在这里逐项检查。
   * @param data 回应的 JSON。
   * @returns 回话。
   * @throws 不是 chat completions 回应的样子时抛错。
   */
  private readReply(data: unknown): ModelReply {
    const body = checks.asRecord(data, '模型的回应');
    const choices = body.choices;
    //G 没有 choices：不是 chat completions 的回应（网关报错时常常这样）。
    if (!Array.isArray(choices) || choices.length === 0) {
      const dataText = JSON.stringify(data);
      const dataStart = dataText.slice(0, ERROR_TEXT_LIMIT);
      throw new Error(`模型的回应里没有 choices：${dataStart}`);
    }

    const firstChoice = checks.asRecord(choices[0], '模型回应的 choices[0]');
    const message = checks.asRecord(firstChoice.message, '模型回应的 choices[0].message');
    /** 回的话：只调工具时常常没有 content。 */
    const text = checks.optionalString(message.content, '模型回应的 message.content') ?? '';
    /** 思考过程：多数模型没有。 */
    const thinking = checks.optionalString(message.reasoning_content, '模型回应的 message.reasoning_content') ?? '';
    const toolCalls = this.readToolCalls(message.tool_calls);

    const reply: ModelReply = {
      text,
      toolCalls,
      thinking,
    };
    return reply;
  }

  /**
   * 读回应里的工具调用。
   * @param value 回应里 message.tool_calls 的原样。
   * @returns 工具调用；没调工具时是空数组。
   * @throws 写了但不是工具调用列表的样子时抛错。
   */
  private readToolCalls(value: unknown): sessionModule.ToolCall[] {
    //M 没调工具：没有 tool_calls，或者是 null。
    if (value === undefined || value === null) {
      return [];
    }
    //G 写了但不是列表。
    if (!Array.isArray(value)) {
      throw new Error('模型回应的 message.tool_calls 应该是列表');
    }

    const calls: sessionModule.ToolCall[] = [];
    for (const [index, item] of value.entries()) {
      /** 出错时报的位置。 */
      const where = `模型回应的 tool_calls[${index}]`;
      const rawCall = checks.asRecord(item, where);
      const rawFunction = checks.asRecord(rawCall.function, `${where}.function`);
      const id = checks.requireString(rawCall.id, `${where}.id`);
      const name = checks.requireString(rawFunction.name, `${where}.function.name`);
      /** 参数：模型没写时当作没有参数。 */
      const argumentsText = checks.optionalString(rawFunction.arguments, `${where}.function.arguments`) ?? '{}';

      const call: sessionModule.ToolCall = {
        id,
        name,
        argumentsText,
      };
      calls.push(call);
    }
    return calls;
  }
}
