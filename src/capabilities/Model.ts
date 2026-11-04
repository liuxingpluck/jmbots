/**
 * 调模型的地方（经 Pi AI 1.4.0）：常规模型对话（chat）、决策模型分类（decide）、列出可用模型（listModels）。
 *
 * 用法：
 *   const ai = await model.connect(resources);                 // 向每个供应商拉一次模型清单
 *   const out = await ai.chat({ model: 'magpie/xxx', system: 积木, messages: 上下文, tools: 工具 });
 *   const verdict = await ai.decide({ state: 情况, questions: 问题 });
 *
 * 模型清单是 magpie 的格式（/models，带上 X-Magpie-Deciders 头就会列出决策模型）：上下文长度、最大输出、思考档位、价格都用清单里的。
 * 常规模型走 OpenAI Chat Completions，决策模型走 System One（magpie 的 /v1/systemone），协议都由 Pi 处理。
 * 出错不抛（Pi 的约定），原因放进 error，由调用方决定怎么办。
 *
 * 来源：旧 zbots 模块的 Model（11-02 真实调用通过，2026-11-04 已删），改成按模型 ID 调用（原来按用途名）。
 * TODO：Codex、MiniMax、ZCode 的原生接口（responses、anthropic-messages）还没接，见 docs/03_进度与待办.md。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as piCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as piSystemOne from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import * as checks from '../utils/Checks.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 一次对话要传的东西。 */
export interface ChatInput {
  /** 供应商/模型 ID。 */
  model: string;

  /** 思考强度：off、minimal、low、medium、high、xhigh、max；不写用 config.yaml 里这个模型那一项的，都没写就是 off。 */
  thinking?: string;

  /** 系统提示词积木：积木名 → 正文，按书写顺序拼，空的跳过。只给模型、不用智能体时是空的。 */
  system: Record<string, string>;

  /** 上下文：之前的消息加这次要说的（Pi 的消息格式，不含系统消息）。 */
  messages: piAi.Message[];

  /** 这次能用的工具；空数组就是纯对话。 */
  tools: piAi.Tool[];
}


/** 实际发给模型的请求（不含密钥），原样记进数据库，日志从这里生成。 */
export interface ChatRequest {
  /** 供应商/模型 ID。 */
  model: string;

  /** 要的思考强度。 */
  thinkingAsked: string;

  /** 实际用的思考强度：模型不支持要的档位时，换成最近的支持档。 */
  thinking: string;

  /** 拼好的系统提示词全文。 */
  system: string;

  /** 给模型的工具：名字、说明、参数格式。 */
  tools: { name: string; description: string; parameters: unknown }[];

  /** 上下文消息。 */
  messages: piAi.Message[];
}


/** 一次对话的结果。 */
export interface ChatOutput {
  /** 模型回复原样（Pi 的格式，含用量 usage）；接着对话时把它放回上下文。 */
  message: piAi.AssistantMessage;

  /** 回复里的文字。 */
  text: string;

  /** 回复里的思考（模型给了才有）。 */
  thinking: string;

  /** 模型要调的工具和参数；不调工具时是空数组。 */
  toolCalls: piAi.ToolCall[];

  /** 出错或被取消时的原因；正常时没有。 */
  error?: string;

  /** 用时，毫秒。 */
  ms: number;

  /** 实际发出的请求。 */
  request: ChatRequest;
}


/** 一次决策要传的东西。 */
export interface DecideInput {
  /** 给决策模型看的情况，越短越快、越便宜。 */
  state: piAi.JsonObject;

  /** 问题：问题名 → 题型（bool、choice、score）、说明和标准，来自 config.yaml 的 decision.questions。 */
  questions: Record<string, piAi.ClassifierQuestion>;

  /** 用哪个决策模型；不写用 config.yaml 的 models.decision（评测时逐个换）。 */
  model?: string;
}


/** 一次决策的结果。 */
export interface DecideOutput {
  /** 每个问题的回答；出错时是空对象。 */
  answers: Record<string, piAi.ClassifierAnswer>;

  /** 出错时的原因；正常时没有。 */
  error?: string;

  /** 用时，毫秒。 */
  ms: number;

  /** 实际发出的请求：模型、情况、问题。 */
  request: { model: string; state: piAi.JsonObject; questions: Record<string, piAi.ClassifierQuestion> };
}


/** 列模型时每个模型给出的信息。 */
export interface ModelSummary {
  /** 供应商/模型 ID。 */
  id: string;

  /** 显示名。 */
  name: string;

  /** chat 是常规模型，decision 是决策模型。 */
  kind: 'chat' | 'decision';

  /** 上下文长度。 */
  contextWindow: number;

  /** 能要的思考强度（off、minimal……max 里这个模型支持的）；决策模型是空数组。 */
  thinking: string[];

  /** 价格，美元每百万 token；0 是没标价或标了 0，不等于一定不花钱。 */
  price: { input: number; output: number };
}


/** 连上模型后拿到的东西。 */
export interface Ai {
  /** 调常规模型。请求出错不抛，原因在 error；模型 ID 写错、不在清单里时抛错。 */
  chat(input: ChatInput): Promise<ChatOutput>;

  /** 调决策模型（config.yaml 的 models.decision）。出错不抛，原因在 error；没配决策模型时抛错。 */
  decide(input: DecideInput): Promise<DecideOutput>;

  /** 有没有配决策模型。 */
  hasDecision(): boolean;

  /** 全部可用的模型。 */
  listModels(): ModelSummary[];
}


/** magpie 的 /models 清单里的一项（只列用到的字段）。 */
interface ModelEntry {
  /** 模型 ID，如 workbuddy/deepseek-v4.1-flash、openrouter/typesafe/jev-1.14。 */
  id: string;
  /** 显示名。 */
  display_name?: string;
  /** decision 是决策模型；其他都当常规模型。 */
  kind?: string;
  /** 会不会思考。 */
  reasoning?: boolean;
  /** 支持的思考档位，如 [{ effort: 'none' }, { effort: 'low' }]；none 是不思考。 */
  supported_reasoning_levels?: { effort: string }[];
  /** 上下文长度（token）。 */
  context_window?: number;
  /** 最大输出（token）。 */
  max_output_tokens?: number;
  /** 能收什么：input 里有 image 就能看图。 */
  modalities?: { input?: string[] };
  /** 价格，美元每 token，写成字符串。 */
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}


/** Pi 的思考档位，从低到高（off 单独处理）。 */
const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;


/** 能写的思考强度。 */
const allowedThinking: readonly string[] = ['off', ...thinkingLevels];


/**
 * magpie 的思考档位换成 Pi 的档位表：支持的照原名发，不支持的标 null（Pi 会换成最近的支持档）。
 * 不思考在 magpie 里写 none（也有写 off 的），对应 Pi 的 off。
 * @param efforts 这个模型支持的档位名。
 */
function toThinkingLevelMap(efforts: string[]): piAi.ThinkingLevelMap {
  /** 档位 → 发给 magpie 的值；null 是不支持。 */
  const levelMap: piAi.ThinkingLevelMap = { off: null };
  for (const level of thinkingLevels) {
    levelMap[level] = efforts.includes(level) ? level : null;
  }
  for (const offName of ['none', 'off']) {
    if (efforts.includes(offName)) {
      levelMap.off = offName;
    }
  }
  return levelMap;
}


/**
 * 美元每 token 的价格字符串换成 Pi 用的美元每百万 token；没有价格记 0（价格未知，不等于免费）。
 * @param price 如 "0.000002"。
 */
function perMillion(price: string | undefined): number {
  return price ? Number(price) * 1_000_000 : 0;
}


/**
 * 向一个供应商拉模型清单，建成 Pi 的供应商。没给上下文长度或最大输出的常规模型不收：Pi 按最大输出发请求，填错了回复会被截断。
 * @param providerId 供应商名（config.yaml 的 providers 下的键）。
 * @param provider 地址、密钥和兼容设置。
 * @throws 连不上，或清单接口返回的不是 2xx 时抛错。
 */
async function fetchProvider(providerId: string, provider: resourcesModule.ProviderConfig): Promise<piAi.Provider> {
  /** 地址去掉末尾斜杠。 */
  const baseUrl = checks.requireString(provider.base_url, `providers.${providerId}.base_url`).replace(/\/+$/, '');
  /** 密钥。 */
  const apiKey = checks.requireString(provider.api_key, `providers.${providerId}.api_key`);

  //M 1. 拉清单。
  /** 清单接口的回应。 */
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, 'x-magpie-deciders': '1' },
  }).catch((error: unknown) => {
    throw new Error(`连不上供应商 ${providerId}（${baseUrl}）：${String(error)}。magpie 的话，桌面程序开着吗？`);
  });
  if (!response.ok) {
    throw new Error(`拉供应商 ${providerId} 的模型清单失败：HTTP ${response.status}`);
  }
  /** 清单里的全部模型。 */
  const entries = ((await response.json()) as { data?: ModelEntry[] }).data ?? [];

  //M 2. 建成 Pi 格式：常规模型和决策模型混在一个列表里，Pi 按 type 区分。
  /** 兼容设置（整个供应商的、单个模型的）。 */
  const compat = checks.asRecord(provider.compat ?? {}, `providers.${providerId}.compat`);
  /** 单个模型的兼容设置。 */
  const modelCompat = checks.asRecord(provider.model_compat ?? {}, `providers.${providerId}.model_compat`);
  /** Pi 的模型。 */
  const models: (piAi.Model<piAi.Api> | piAi.ClassifierModel<piAi.ClassifierApi>)[] = [];
  for (const entry of entries) {
    /** 两种模型共用的字段。 */
    const base = { id: entry.id, name: entry.display_name ?? entry.id, provider: providerId, baseUrl };
    if (entry.kind === 'decision') {
      models.push({
        ...base,
        type: 'classifier',
        api: 'typesafe-system-one',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.context_window ?? 0,
      });
      continue;
    }
    if (!entry.context_window || !entry.max_output_tokens) {
      continue;
    }
    models.push({
      ...base,
      api: 'openai-completions',
      reasoning: entry.reasoning === true,
      thinkingLevelMap: toThinkingLevelMap((entry.supported_reasoning_levels ?? []).map((level) => level.effort)),
      input: entry.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'],
      cost: {
        input: perMillion(entry.pricing?.prompt),
        output: perMillion(entry.pricing?.completion),
        cacheRead: perMillion(entry.pricing?.input_cache_read),
        cacheWrite: perMillion(entry.pricing?.input_cache_write),
      },
      contextWindow: entry.context_window,
      maxTokens: entry.max_output_tokens,
      compat: { ...compat, ...checks.asRecord(modelCompat[entry.id] ?? {}, `model_compat.${entry.id}`) } as piAi.OpenAICompletionsCompat,
    });
  }

  //M 3. 密钥直接来自 config.yaml。
  /** Pi 取密钥的方式。 */
  const apiKeyAuth: piAi.ApiKeyAuth = {
    name: `${providerId} 的密钥（config.yaml）`,
    resolve: () => Promise.resolve({ auth: { apiKey }, source: 'config.yaml' }),
  };
  return piAi.createProvider({
    id: providerId,
    baseUrl,
    auth: { apiKey: apiKeyAuth },
    models,
    api: piCompletions.openAICompletionsApi(),
    classifiers: { 'typesafe-system-one': piSystemOne.typesafeSystemOneApi() },
  });
}


/**
 * 调一次常规模型。
 * @param models Pi 的模型集合。
 * @param resources 资源（取 config.yaml 里这个模型的默认思考强度）。
 * @param input 模型、积木、上下文、工具、思考强度。
 * @throws 模型 ID 写错、不在清单里、思考强度写错时抛错；请求本身出错不抛，原因在 error。
 */
async function chat(models: piAi.Models, resources: resourcesModule.Resources, input: ChatInput): Promise<ChatOutput> {
  const { providerId, modelId } = checks.splitModel(input.model);
  /** 清单里的模型。 */
  const model = models.getModel(providerId, modelId);
  if (!model) {
    throw new Error(`供应商 ${providerId} 的模型清单里没有 ${modelId}；magpie 里打开了吗？`);
  }

  //M 1. 思考强度：调用方写的 > config.yaml 里用这个模型的那一项写的 > off。写错的档位直接报错，免得悄悄变成最低档。
  /** config.yaml 里用这个模型的那一项。 */
  const configured = Object.values(resources.listModelChoices()).find((item) => item.model === input.model);
  /** 要的思考强度。 */
  const thinkingAsked = input.thinking ?? configured?.thinking ?? 'off';
  if (!allowedThinking.includes(thinkingAsked)) {
    throw new Error(`思考强度 ${thinkingAsked} 写错了，只能是 ${allowedThinking.join('、')}`);
  }
  /** 实际用的思考强度。 */
  const thinking = piAi.clampThinkingLevel(model, thinkingAsked as piAi.ModelThinkingLevel);

  //M 2. 积木作为系统消息的命名片段，Pi 按书写顺序用空行连接、跳过空的。
  /** 积木名 → 正文。 */
  const sections: Record<string, string> = {};
  for (const [name, text] of Object.entries(input.system)) {
    sections[name] = text.trim();
  }
  /** 系统消息；没有积木时不发。 */
  const systemMessages: piAi.Message[] = Object.keys(sections).length > 0 ? [{ role: 'system', content: '', sections, timestamp: Date.now() }] : [];

  //M 3. 调模型。出错或被取消时不抛错，原因在 stopReason 和 errorMessage。
  /** 开始时间。 */
  const startedAt = performance.now();
  /** 模型的回复。 */
  const message = await models.completeSimple(
    model,
    { messages: [...systemMessages, ...input.messages], tools: input.tools },
    { reasoning: thinking === 'off' ? undefined : thinking },
  );
  /** 回复里的工具调用。 */
  const toolCalls = message.content.filter((block): block is piAi.ToolCall => block.type === 'toolCall');
  /** 回复里的思考。 */
  const thinkingText = message.content
    .filter((block): block is piAi.ThinkingContent => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('\n');
  /** 出错或被取消。 */
  const failed = message.stopReason === 'error' || message.stopReason === 'aborted';

  return {
    message,
    text: piAi.contentText(message.content),
    thinking: thinkingText,
    toolCalls,
    error: failed ? `${message.stopReason}：${message.errorMessage ?? ''}` : undefined,
    ms: Math.round(performance.now() - startedAt),
    request: {
      model: input.model,
      thinkingAsked,
      thinking,
      system: Object.values(sections).filter(Boolean).join('\n\n'),
      tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      messages: input.messages,
    },
  };
}


/**
 * 调一次决策模型（config.yaml 的 models.decision）。
 * @param models Pi 的模型集合。
 * @param decisionModel 决策模型 ID。
 * @param input 情况和问题。
 * @throws 决策模型不在清单里时抛错；请求本身出错不抛，原因在 error。
 */
async function decide(models: piAi.Models, decisionModel: string, input: DecideInput): Promise<DecideOutput> {
  const { providerId, modelId } = checks.splitModel(decisionModel);
  /** 清单里的决策模型。 */
  const model = models.getModelOfType('classifier', providerId, modelId);
  if (!model) {
    throw new Error(`供应商 ${providerId} 的清单里没有决策模型 ${modelId}；magpie 里打开了吗？`);
  }
  /** 开始时间。 */
  const startedAt = performance.now();
  /** 决策结果。 */
  const result = await models.classify(model, { state: input.state, questions: input.questions });
  return {
    answers: result.answers,
    error: result.stopReason === 'stop' ? undefined : `${result.stopReason}：${result.errorMessage ?? ''}`,
    ms: Math.round(performance.now() - startedAt),
    request: { model: decisionModel, state: input.state, questions: input.questions },
  };
}


/**
 * 按配额排队：每个模型、每个供应商同时最多几个调用，多出来的等前面的做完（先来先做）。
 * 先占模型的名额，再占供应商的名额（顺序固定，不会互相卡死）。
 * 用户 11-02：“还要考虑 API 的并发上限问题，比如同一时间段同一个模型最多只能 3 个调用”；
 * “这个要放在配置文件中，默认是 3 而已，将来还应该各种模型或供应商有自己的配额”。
 * @param settings 配额（config.yaml 的 concurrency）。
 * @returns (模型 ID“供应商/模型”, 要做的调用) → 调用的结果。
 */
export function createModelQueue(settings: resourcesModule.ConcurrencySettings): <T>(model: string, task: () => Promise<T>) => Promise<T> {
  /** 每个名额键（“模型:ID”“供应商:名字”）正在用几个。 */
  const running = new Map<string, number>();
  /** 每个名额键在等的调用（叫醒函数）。 */
  const waiting = new Map<string, (() => void)[]>();

  /**
   * 占一个名额，满了就等。
   * @param key 名额键。
   * @param limit 上限。
   */
  async function acquire(key: string, limit: number): Promise<void> {
    while ((running.get(key) ?? 0) >= limit) {
      await new Promise<void>((resolve) => {
        waiting.set(key, [...(waiting.get(key) ?? []), resolve]);
      });
    }
    running.set(key, (running.get(key) ?? 0) + 1);
  }

  /**
   * 还一个名额，叫醒等着的第一个。
   * @param key 名额键。
   */
  function release(key: string): void {
    running.set(key, (running.get(key) ?? 1) - 1);
    waiting.get(key)?.shift()?.();
  }

  return async (model, task) => {
    /** 供应商名。 */
    const provider = model.split('/')[0] ?? '';
    /** 这个供应商的合计上限；没写不限。 */
    const providerLimit = settings.providers[provider];
    await acquire(`模型:${model}`, settings.models[model] ?? settings.perModel);
    if (providerLimit !== undefined) {
      await acquire(`供应商:${provider}`, providerLimit);
    }
    try {
      return await task();
    } finally {
      if (providerLimit !== undefined) {
        release(`供应商:${provider}`);
      }
      release(`模型:${model}`);
    }
  };
}


/**
 * 连上模型：向 config.yaml 里每个供应商拉一次清单。
 * @param resources 资源。
 * @param piModels 现成的 Pi 模型集合；测试传替身，传了就不联网。
 * @throws 拉清单失败时抛错（连不上、HTTP 出错）。
 */
export async function connect(resources: resourcesModule.Resources, piModels?: piAi.Models): Promise<Ai> {
  /** Pi 的模型集合。 */
  let models = piModels;
  if (!models) {
    /** 新建的集合。 */
    const created = piAi.createModels();
    for (const [providerId, provider] of Object.entries(resources.getProviders())) {
      created.setProvider(await fetchProvider(providerId, provider));
    }
    models = created;
  }
  /** 定下来的集合。 */
  const ready = models;
  /** 决策模型 ID；没配时是 undefined。 */
  const decisionModel = resources.getModelChoice('decision')?.model;
  /** 按配额排队（config.yaml 的 concurrency）。 */
  const queue = createModelQueue(resources.getConcurrency());

  return {
    chat: (input) => queue(input.model, () => chat(ready, resources, input)),
    decide: (input) => {
      /** 这次用的决策模型。 */
      const chosen = input.model ?? decisionModel;
      if (!chosen) {
        throw new Error('config.yaml 的 models.decision 没配决策模型');
      }
      return queue(chosen, () => decide(ready, chosen, input));
    },
    hasDecision: () => decisionModel !== undefined,
    listModels: () => {
      /** 结果。 */
      const list: ModelSummary[] = [];
      for (const providerId of Object.keys(resources.getProviders())) {
        for (const item of ready.getModels(providerId)) {
          /** 档位表：值是字符串的档位才支持。 */
          const levelMap: piAi.ThinkingLevelMap = item.thinkingLevelMap ?? {};
          /** 支持的档位；一个都没有（不能选档的模型）就只列 off，表示“用它自己的默认”。 */
          const levels = allowedThinking.filter((level) => typeof levelMap[level as keyof piAi.ThinkingLevelMap] === 'string');
          list.push({
            id: `${providerId}/${item.id}`,
            name: item.name,
            kind: 'chat',
            contextWindow: item.contextWindow,
            thinking: levels.length > 0 ? levels : ['off'],
            price: { input: item.cost.input, output: item.cost.output },
          });
        }
        for (const item of ready.getModelsOfType('classifier', providerId)) {
          list.push({ id: `${providerId}/${item.id}`, name: item.name, kind: 'decision', contextWindow: item.contextWindow, thinking: [], price: { input: 0, output: 0 } });
        }
      }
      return list;
    },
  };
}
