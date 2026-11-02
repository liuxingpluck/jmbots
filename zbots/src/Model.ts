/**
 * zbots 调模型的地方：常规模型（对话、调工具、带思考强度）和决策模型（只回选择、真假、评分和概率）。
 *
 * 业务代码只管传参数、拿结果：
 *   const ai = await model.connect(runtime.config);
 *   const reply = await ai.chat({ role: 'work', system: 积木, messages: 上下文, tools: 工具 });
 *   const verdict = await ai.decide({ state: 情况, questions: 问题 });
 * 里面做的事：按角色找模型；把思考强度换成模型支持的档位；积木交给 Pi 拼成系统提示词；计时；
 * 出错不抛（Pi 的约定），原因放进 error；整理出这次请求里 AI 用到的部分（模型、系统提示词、工具、上下文），交给日志写文件。
 *
 * 模型清单：connect 时向每个供应商的 /models 拉一次（magpie 的格式，带决策模型），
 * 上下文长度、最大输出、支持的思考档位、价格都用清单里的。常规模型走 OpenAI Chat Completions，
 * 决策模型走 System One（magpie 的 /v1/systemone），协议都由 Pi 处理。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as piCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as piSystemOne from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import type * as runtime from './Runtime.ts';


/** 一次常规模型调用要传的东西。 */
export interface ChatInput {
  /** 用哪个角色的模型：config.yaml 的 models 下的名字，如 dispatch、work、evaluate。 */
  role: string;

  /** 系统提示词积木：积木名 → 正文，按书写顺序拼，块之间空一行，空的跳过。 */
  system: Record<string, string>;

  /** 上下文：之前的消息加这次要说的（Pi 的消息格式，不含系统消息）。 */
  messages: piAi.Message[];

  /** 这次能用的工具；不给就是纯对话。 */
  tools?: piAi.Tool[];

  /** 思考强度：off、minimal、low、medium、high、xhigh、max；不写用角色配置里的，配置也没写就是 off。 */
  thinking?: string;

  /** 取消这次请求用。 */
  signal?: AbortSignal;
}


/** 一次常规模型请求里 AI 用到的部分（不是原始报文），日志原样写进文件。 */
export interface ChatRequest {
  /** 角色名。 */
  role: string;

  /** 供应商/模型 ID。 */
  model: string;

  /** 要的思考强度（调用方或配置里写的）。 */
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


/** 一次常规模型调用的结果。 */
export interface ChatOutput {
  /** 模型的回复原样（Pi 的格式）；要接着对话，就把它加进上下文。用量在 message.usage。 */
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

  /** 这次请求里 AI 用到的部分。 */
  request: ChatRequest;
}


/** 一次决策模型调用要传的东西。 */
export interface DecideInput {
  /** 给决策模型看的情况，如任务、最近几步、要调的工具和参数；越短越快、越便宜。 */
  state: piAi.JsonObject;

  /** 要问的问题：问题名 → 题型（bool、choice、score）、说明和标准，原样来自 config.yaml。 */
  questions: Record<string, piAi.ClassifierQuestion>;

  /** 取消这次请求用。 */
  signal?: AbortSignal;
}


/** 一次决策模型调用的结果。 */
export interface DecideOutput {
  /** 每个问题的回答：真假题是“真”的概率，选择题是选项和各选项的概率，评分题是分数。出错时是空对象。 */
  answers: Record<string, piAi.ClassifierAnswer>;

  /** 出错或被取消时的原因；正常时没有。 */
  error?: string;

  /** 用量；服务没报时没有，不代表没花钱。 */
  usage?: piAi.Usage;

  /** 用时，毫秒。 */
  ms: number;

  /** 这次请求里 AI 用到的部分：模型、情况、问题。 */
  request: { model: string; state: piAi.JsonObject; questions: Record<string, piAi.ClassifierQuestion> };
}


/** 连上模型后拿到的东西：两种调用。 */
export interface Ai {
  /** 调常规模型。不抛错：请求出错或被取消时，原因在 error。 */
  chat(input: ChatInput): Promise<ChatOutput>;

  /** 调决策模型（config.yaml 的 models.decision）。不抛错：出错时原因在 error，answers 为空。 */
  decide(input: DecideInput): Promise<DecideOutput>;
}


/** magpie 的 /models 清单里的一项（只列用到的字段）。 */
interface ModelEntry {
  /** 模型 ID，如 auto/deepseek-v4.1-flash、openrouter/typesafe/jev-1.14。 */
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

  /** 价格，美元每 token，写成字符串（OpenRouter 的格式）。 */
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}


/** Pi 的思考档位，从低到高（off 单独处理）。 */
const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;


/** 配置和调用方能写的思考强度。 */
const allowedThinking: readonly string[] = ['off', ...thinkingLevels];


/**
 * 把 magpie 写的思考档位换成 Pi 的档位表：支持的档位照原名发，不支持的标 null（Pi 会换成最近的支持档）。
 * 不思考在 magpie 里写 none（也有写 off 的），对应 Pi 的 off。
 * @param efforts magpie 清单里这个模型支持的档位名。
 */
function toThinkingLevelMap(efforts: string[]): piAi.ThinkingLevelMap {
  /** Pi 的档位表：档位 → 发给 magpie 的值；null 是不支持。 */
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
 * @param price 清单里的价格，如 "0.000002"。
 */
function perMillion(price: string | undefined): number {
  return price ? Number(price) * 1_000_000 : 0;
}


/**
 * 向一个供应商拉模型清单，建成 Pi 的供应商：常规模型走 OpenAI Chat Completions，决策模型走 System One。
 * 没给上下文长度或最大输出的常规模型不收：Pi 会按最大输出发请求，填错了回复会被截断。
 * @param providerId 供应商名（config.yaml 的 providers 下的键）。
 * @param provider 地址、密钥和兼容设置。
 * @throws 连不上，或清单接口返回的不是 2xx 时抛错。
 */
async function fetchProvider(providerId: string, provider: runtime.ProviderConfig): Promise<piAi.Provider> {
  /** 清单接口的回应；带上 X-Magpie-Deciders，决策模型也列出来。 */
  const response = await fetch(`${provider.base_url}/models`, {
    headers: { authorization: `Bearer ${provider.api_key}`, 'x-magpie-deciders': '1' },
  }).catch((error: unknown) => {
    throw new Error(`连不上供应商 ${providerId}（${provider.base_url}）：${String(error)}。magpie 的话，桌面程序开着吗？`);
  });
  if (!response.ok) {
    throw new Error(`拉供应商 ${providerId} 的模型清单失败：HTTP ${response.status} ${await response.text()}`);
  }
  /** 清单里的全部模型。 */
  const entries = ((await response.json()) as { data?: ModelEntry[] }).data ?? [];

  /** 建成 Pi 格式的模型：常规模型和决策模型混在一个列表里，Pi 按 type 区分。 */
  const models: (piAi.Model<piAi.Api> | piAi.ClassifierModel<piAi.ClassifierApi>)[] = [];
  for (const entry of entries) {
    /** 两种模型共用的字段。 */
    const base = { id: entry.id, name: entry.display_name ?? entry.id, provider: providerId, baseUrl: provider.base_url };
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
      compat: { ...provider.compat, ...provider.model_compat?.[entry.id] },
    });
  }

  /** 密钥直接来自 config.yaml。 */
  const apiKeyAuth: piAi.ApiKeyAuth = {
    name: `${providerId} 的密钥（config.yaml）`,
    resolve: () => Promise.resolve({ auth: { apiKey: provider.api_key }, source: 'config.yaml' }),
  };
  return piAi.createProvider({
    id: providerId,
    baseUrl: provider.base_url,
    auth: { apiKey: apiKeyAuth },
    models,
    api: piCompletions.openAICompletionsApi(),
    classifiers: { 'typesafe-system-one': piSystemOne.typesafeSystemOneApi() },
  });
}


/**
 * 按角色名找配置：config.yaml 的 models 下要有这个角色。
 * @param roles config.yaml 的 models。
 * @param role 角色名。
 * @returns 供应商名、模型 ID 和角色配置。
 * @throws 没有这个角色时抛错。
 */
function findRole(
  roles: Record<string, runtime.RoleConfig>,
  role: string,
): { providerId: string; modelId: string; roleConfig: runtime.RoleConfig } {
  /** 这个角色的配置。 */
  const roleConfig = roles[role];
  if (!roleConfig) {
    throw new Error(`config.yaml 的 models 里没有角色 ${role}。`);
  }
  /** 按第一个斜杠拆开：模型 ID 本身还可能带斜杠。 */
  const [providerId = '', ...modelIdParts] = roleConfig.model.split('/');
  return { providerId, modelId: modelIdParts.join('/'), roleConfig };
}


/**
 * 调一次常规模型。
 * @param models Pi 的模型集合。
 * @param roles config.yaml 的 models。
 * @param input 角色、积木、上下文、工具、思考强度。
 * @throws 角色不存在，或模型不在清单里时抛错；请求本身出错不抛，原因在 error。
 */
async function chat(models: piAi.Models, roles: Record<string, runtime.RoleConfig>, input: ChatInput): Promise<ChatOutput> {
  const { providerId, modelId, roleConfig } = findRole(roles, input.role);
  /** 清单里的模型，带着真实的上下文长度、最大输出、思考档位和价格。 */
  const model = models.getModel(providerId, modelId);
  if (!model) {
    throw new Error(`供应商 ${providerId} 的模型清单里没有 ${modelId}（角色 ${input.role}）；magpie 里打开了吗？`);
  }

  // m: 思考强度换成模型支持的档位；off 就不传，Pi 会按模型的写法关掉思考。写错的档位直接报错，免得悄悄变成最低档。
  /** 要的思考强度。 */
  const thinkingAsked = input.thinking ?? roleConfig.thinking ?? 'off';
  if (!allowedThinking.includes(thinkingAsked)) {
    throw new Error(`思考强度 ${thinkingAsked} 写错了（角色 ${input.role}），只能是 ${allowedThinking.join('、')}。`);
  }
  /** 实际用的思考强度。 */
  const thinking = piAi.clampThinkingLevel(model, thinkingAsked as piAi.ModelThinkingLevel);

  // m: 积木作为系统消息的命名片段，Pi 按书写顺序用空行连接、跳过空的；先去掉每块首尾空白。
  /** 积木名 → 正文。 */
  const sections: Record<string, string> = {};
  for (const [blockName, blockText] of Object.entries(input.system)) {
    sections[blockName] = blockText.trim();
  }
  /** 这次请求的系统消息。 */
  const systemMessage: piAi.SystemMessage = { role: 'system', content: '', sections, timestamp: Date.now() };

  /** 开始时间，算用时。 */
  const startedAt = performance.now();
  /** 模型的回复；出错或被取消时不抛错，原因在 stopReason 和 errorMessage。 */
  const message = await models.completeSimple(
    model,
    { messages: [systemMessage, ...input.messages], tools: input.tools },
    { reasoning: thinking === 'off' ? undefined : thinking, signal: input.signal },
  );
  /** 回复里的工具调用。 */
  const toolCalls = message.content.filter((block): block is piAi.ToolCall => block.type === 'toolCall');
  /** 回复里的思考。 */
  const thinkingText = message.content
    .filter((block): block is piAi.ThinkingContent => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('\n');

  /** 出错或被取消时的原因。 */
  const failed = message.stopReason === 'error' || message.stopReason === 'aborted';

  // r: 结果和这次请求里 AI 用到的部分。
  return {
    message,
    text: piAi.contentText(message.content),
    thinking: thinkingText,
    toolCalls,
    error: failed ? `${message.stopReason}：${message.errorMessage ?? ''}` : undefined,
    ms: Math.round(performance.now() - startedAt),
    request: {
      role: input.role,
      model: `${providerId}/${modelId}`,
      thinkingAsked,
      thinking,
      system: piAi.getSystemMessageText(systemMessage),
      tools: (input.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      messages: input.messages,
    },
  };
}


/**
 * 调一次决策模型（config.yaml 的 models.decision）。
 * @param models Pi 的模型集合。
 * @param roles config.yaml 的 models。
 * @param input 情况和问题。
 * @throws 决策模型不在清单里时抛错；请求本身出错不抛，原因在 error。
 */
async function decide(models: piAi.Models, roles: Record<string, runtime.RoleConfig>, input: DecideInput): Promise<DecideOutput> {
  const { providerId, modelId } = findRole(roles, 'decision');
  /** 清单里的决策模型。 */
  const model = models.getModelOfType('classifier', providerId, modelId);
  if (!model) {
    throw new Error(`供应商 ${providerId} 的决策模型清单里没有 ${modelId}；magpie 里打开了吗？`);
  }
  /** 开始时间，算用时。 */
  const startedAt = performance.now();
  /** 决策结果；出错时不抛错，原因在 stopReason 和 errorMessage。 */
  const result = await models.classify(model, { state: input.state, questions: input.questions }, { signal: input.signal });
  return {
    answers: result.answers,
    error: result.stopReason === 'stop' ? undefined : `${result.stopReason}：${result.errorMessage ?? ''}`,
    usage: result.usage,
    ms: Math.round(performance.now() - startedAt),
    request: { model: `${providerId}/${modelId}`, state: input.state, questions: input.questions },
  };
}


/**
 * 连上模型：向 config.yaml 里每个供应商拉一次模型清单，建好 Pi 的模型集合。
 * @param config 配置（用 providers 和 models 两段）。
 * @param piModels 现成的 Pi 模型集合；测试传替身，传了就不联网拉清单。
 * @returns chat 和 decide 两种调用。
 * @throws 拉清单失败时抛错（连不上、HTTP 出错）。
 */
export async function connect(config: runtime.Config, piModels?: piAi.Models): Promise<Ai> {
  /** Pi 的模型集合。 */
  let models = piModels;
  if (!models) {
    /** 新建的模型集合，挨个放进供应商。 */
    const created = piAi.createModels();
    for (const [providerId, provider] of Object.entries(config.providers)) {
      created.setProvider(await fetchProvider(providerId, provider));
    }
    models = created;
  }
  /** 定下来的模型集合，给下面两个调用用。 */
  const readyModels = models;
  return {
    chat: (input) => chat(readyModels, config.models, input),
    decide: (input) => decide(readyModels, config.models, input),
  };
}
