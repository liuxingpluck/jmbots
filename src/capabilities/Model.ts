/**
 * 调模型的地方（经 Pi AI 1.4.0）：常规模型对话（chat）、决策模型分类（decide）、列出可用模型（listModels）。
 *
 * 用法：
 *   const ai = await model.Ai.connect(resources);              // 向每个供应商拉一次模型清单
 *   const out = await ai.chat({ model: '供应商/模型 ID', system: 积木, messages: 上下文, tools: 工具 });
 *   const verdict = await ai.decide({ state: 情况, questions: 问题 });
 *
 * 供应商全在 config.yaml 的 providers 里，地址、密钥、协议都写在那儿，想接几家接几家（模型 ID 写成“供应商/模型”）。
 * 模型清单向每家的 <base_url>/models 拉，再和手写的 providers.<名字>.models 合起来：上下文长度、最大输出、思考档位、价格优先用手写的，
 * 其次用清单给的，都没有用保守值（见 fetchProvider）。一家连不上不挡别家，也不挡服务起来，每分钟再试（见 Ai.connect）。
 * 常规模型的协议看 providers.<名字>.api（默认 OpenAI Chat Completions），决策模型走 System One 协议（/v1/systemone，Magpie 网关提供；别家没有就不配决策模型），协议都由 Pi 处理。
 * 出错不抛（Pi 的约定），原因放进 error，由调用方决定怎么办。
 *
 * 来源：jmbots 早期版本的模型模块（11-02 真实调用通过，旧代码在 git 提交 3d34bc2），改成按模型 ID 调用（原来按用途名）。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as piAnthropic from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import * as piCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as piResponses from '@earendil-works/pi-ai/api/openai-responses.lazy';
import * as piSystemOne from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import type * as eventsModule from './Events.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 调用方交给模型库的只读关联；不参与选模型、并发或回退。 */
export interface CallTrace {
  /** 会话的第几次运行；分派等没有运行号时省略。 */
  run?: number;
  /** 这次运行的第几步；不是会话步骤时省略。 */
  step?: number;
  /** 这次请求实际关联的收件号；没有可靠关联时省略。 */
  messageIds?: number[];
}


/** 一次对话要传的东西。 */
export interface ChatInput {
  /** 供应商/模型 ID。 */
  model: string;

  /** 这个角色自己的备用模型：被限流时先试它们，再试全局的 engine.fallback_chain；没有就不写。 */
  fallbacks?: string[];

  /** 思考强度：off、minimal、low、medium、high、xhigh、max；不写用 config.yaml 里这个模型那一项的，都没写就是 off。 */
  thinking?: string;

  /** 系统提示词积木：积木名 → 正文，按书写顺序拼，空的跳过。只给模型、不用智能体时是空的。 */
  system: Record<string, string>;

  /** 上下文：之前的消息加这次要说的（Pi 的消息格式，不含系统消息）。 */
  messages: piAi.Message[];

  /** 这次能用的工具；空数组就是纯对话。 */
  tools: piAi.Tool[];

  /** 记用量用（docs/15）：谁调的，如 session、compact；不写记成 other。 */
  purpose?: string;

  /** 记用量用：哪个机器人。 */
  bot?: string;

  /** 记用量用：哪个会话。 */
  sessionId?: string;

  /** 只读事件关联；由会话循环或分派交来，不改变模型调用。 */
  trace?: CallTrace;
}


/** 实际发给模型的请求（不含密钥），原样记进数据库，日志从这里生成。 */
export interface ChatRequest {
  /** 供应商/模型 ID。 */
  model: string;

  /** 原来要的模型被限流、换成备用模型时，原来那个的 ID；没换是 undefined。 */
  fallbackFrom?: string;

  /** 被限流后依次真调过的模型，按顺序（最先要的那个还在冷却、这次没调时不含它）；没换过是 undefined。 */
  tried?: string[];

  /** 要的思考强度。 */
  thinkingAsked: string;

  /** 实际用的思考强度：模型不支持要的档位时，换成最近的支持档。 */
  thinking: string;
  /** 请求档位的本地来源；旧存根或历史未记录时省略。 */
  thinkingSource?: 'caller' | 'configured-model' | 'default-off';

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

  /** 记用量用（docs/15）：谁调的；不写记成 other。 */
  purpose?: string;

  /** 记用量用：哪个机器人。 */
  bot?: string;

  /** 记用量用：哪个会话。 */
  sessionId?: string;

  /** 只读事件关联；没有可靠运行或消息信息时省略。 */
  trace?: CallTrace;
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

  /** 最大输出（token）；网页的设置页把它写进 config.yaml 用（docs/界面/01_界面设计.md 第 10 节）。决策模型没有，不写。 */
  maxOutputTokens?: number;

  /** 能要的思考强度（off、minimal……max 里这个模型支持的）；决策模型是空数组。 */
  thinking: string[];

  /** 看不看得懂图（清单的 modalities.input 里有 image）；不写按看不懂算。 */
  vision?: boolean;

  /** 价格，美元每百万 token；0 是没标价或标了 0，不等于一定不花钱。 */
  price: { input: number; output: number };

  /** 被限流、冷却到什么时候（毫秒）；没在冷却是 undefined。分派看它，先别选（docs/10 6.5）。 */
  limitedUntil?: number;
}


/** 重新连接一家供应商的结果（POST /api/models/reconnect 原样交给网页）。 */
export interface ReconnectResult {
  /** 供应商名（config.yaml 的 providers 下的键）。 */
  provider: string;

  /** 连上了：清单拉到了，或者这家写了 list_models: false、不用拉。 */
  ok: boolean;

  /** 这家现在能用的模型个数（常规加决策）；没连上时是原来的个数。 */
  models: number;

  /** 没连上的原因；连上了是 undefined。 */
  error?: string;
}


/** 供应商 /models 清单里的一项（只列用到的字段）。各家给的不一样：magpie 给得全，OpenRouter 字段名不同，大多数 OpenAI 兼容接口只给 id。 */
interface ModelEntry {
  /** 模型 ID（清单里原样的，可以带斜杠，如 分组/模型）。 */
  id: string;
  /** 上下文长度（OpenRouter 的写法）。 */
  context_length?: number;
  /** 最大输出（OpenRouter 的写法）。 */
  top_provider?: { max_completion_tokens?: number };
  /** 能收什么（OpenRouter 的写法）。 */
  architecture?: { input_modalities?: string[] };
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


/** 支持的接口协议：config.yaml 的 providers.<名字>.api 写哪个走哪个；不写是 openai-completions。 */
const CHAT_APIS: Record<string, () => ReturnType<typeof piCompletions.openAICompletionsApi>> = {
  'openai-completions': piCompletions.openAICompletionsApi,
  'openai-responses': piResponses.openAIResponsesApi,
  'anthropic-messages': piAnthropic.anthropicMessagesApi,
};


/** 拉模型清单最多等多久，毫秒：一家连不上不能把启动拖住。 */
const LIST_TIMEOUT_MS = 15_000;


/** 连不上的供应商多久再试一次，毫秒。 */
const RECONNECT_MS = 60_000;


/** 模型不在清单里时错误末尾的提示：聊天里只提醒，用户重新测试后自己重发（用户 11-07）。不写具体哪家，供应商是配置。 */
const RECONNECT_HINT = '这家后来连上了的话，到设置的“重连”里点“重新测试模型连接”，再重新发一次';


/** 清单和 config 都没给时的保守值：够常规对话用，又不至于被供应商拒绝。想准确就写进 providers.<名字>.models。 */
const UNKNOWN_CONTEXT_WINDOW = 128_000;
const UNKNOWN_MAX_OUTPUT = 8_192;


/** 清单只给 ID 时，靠名字认出不是对话模型的。 */
const NON_CHAT_MODEL = /embed|whisper|tts|transcri|dall-e|moderation|rerank|image/i;


/**
 * 美元每 token 的价格字符串换成 Pi 用的美元每百万 token；没有价格记 0（价格未知，不等于免费）。
 * @param price 如 "0.000002"。
 */
function perMillion(price: string | undefined): number {
  return price ? Number(price) * 1_000_000 : 0;
}


/**
 * 向一个供应商拉模型清单，和 config.yaml 手写的 models 合起来，建成 Pi 的供应商。任何 OpenAI、Anthropic 协议的地址都能接。
 * 手写的优先。清单带参数时（magpie、OpenRouter），没给上下文长度或最大输出的不是常规对话模型，不收；
 * 清单只给 ID 时（大多数 OpenAI 兼容接口）全收，用保守值，打一行日志说怎么写准。
 * @param providerId 供应商名（config.yaml 的 providers 下的键）。
 * @param provider 地址、密钥、协议、手写的模型和兼容设置。
 * @param listRequired 清单一定要拉到：拉不到就抛错，不退回手写的（Ai.reconnect 用）。
 * @throws 协议写错；或者清单拉不到、又没手写模型（或 listRequired）时抛错（connect 接住，过一会儿再试）。
 */
async function fetchProvider(
  providerId: string,
  provider: resourcesModule.ProviderConfig,
  listRequired = false,
): Promise<piAi.Provider> {
  /** 地址去掉末尾斜杠。 */
  const baseUrl = checks.requireString(provider.base_url, `providers.${providerId}.base_url`).replace(/\/+$/, '');
  /** 密钥；本地不要密钥的服务可以不写。 */
  const apiKey = checks.optionalString(provider.api_key, `providers.${providerId}.api_key`) ?? 'no-key';
  /** 接口协议。 */
  const apiName = checks.optionalString(provider.api, `providers.${providerId}.api`) ?? 'openai-completions';
  /** 这种协议的实现。 */
  const streams = CHAT_APIS[apiName];
  if (!streams) {
    throw new Error(`providers.${providerId}.api 写的 ${apiName} 不认识，现在支持：${Object.keys(CHAT_APIS).join('、')}`);
  }
  /** 手写的模型。 */
  const written = checks.asRecord(provider.models ?? {}, `providers.${providerId}.models`) as Record<string, resourcesModule.ProviderModel>;

  //M 1. 拉清单。拉不到时，手写了模型就用手写的；都没有才算连不上。
  /** 清单里的全部模型。 */
  let entries: ModelEntry[] = [];
  if (provider.list_models !== false) {
    try {
      /** 清单接口的回应。x-magpie-deciders 是 magpie 列出决策模型用的，别家不认会忽略。 */
      const headers = {
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'x-magpie-deciders': '1',
      };
      /** 清单请求的超时只约束本次外部请求。 */
      const signal = AbortSignal.timeout(LIST_TIMEOUT_MS);
      const requestOptions = { headers, signal };
      const modelsUrl = `${baseUrl}/models`;

      const response = await fetch(modelsUrl, requestOptions);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      entries = ((await response.json()) as { data?: ModelEntry[] }).data ?? [];
    } catch (error) {
      if (Object.keys(written).length === 0 || listRequired) {
        throw new Error(`拉供应商 ${providerId}（${baseUrl}）的模型清单失败：${String(error)}`, { cause: error });
      }
      console.error(`供应商 ${providerId} 的模型清单没拉到（${String(error)}），先用 config.yaml 手写的 ${Object.keys(written).length} 个模型`);
    }
  }

  //M 2. 建成 Pi 格式：常规模型和决策模型混在一个列表里，Pi 按 type 区分。
  /** 兼容设置（整个供应商的、单个模型的）。 */
  const compat = checks.asRecord(provider.compat ?? {}, `providers.${providerId}.compat`);
  /** 单个模型的兼容设置。 */
  const modelCompat = checks.asRecord(provider.model_compat ?? {}, `providers.${providerId}.model_compat`);
  /** Pi 的模型。 */
  const models: (piAi.Model<piAi.Api> | piAi.ClassifierModel<piAi.ClassifierApi>)[] = [];
  /** 这份清单带不带参数。 */
  const detailed = entries.some((entry) => entry.context_window ?? entry.context_length);
  /** 用了保守值的模型个数。 */
  let guessed = 0;
  for (const entry of [...entries, ...Object.keys(written).filter((id) => !entries.some((item) => item.id === id)).map((id): ModelEntry => ({ id }))]) {
    /** 两种模型共用的字段。 */
    const base = { id: entry.id, name: written[entry.id]?.name ?? entry.display_name ?? entry.id, provider: providerId, baseUrl };
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
    /** 手写的。 */
    const own = written[entry.id];
    /** 清单给的上下文长度和最大输出。 */
    const listedWindow = entry.context_window ?? entry.context_length;
    const listedOutput = entry.max_output_tokens ?? entry.top_provider?.max_completion_tokens;
    //G 不是常规对话模型的不收：清单带参数时看缺没缺参数；只给 ID 时看名字（嵌入、语音、画图……）。
    if (!own && (detailed ? !listedWindow || !listedOutput : NON_CHAT_MODEL.test(entry.id))) {
      continue;
    }
    if (!(own?.context_window ?? listedWindow) || !(own?.max_output_tokens ?? listedOutput)) {
      guessed += 1;
    }
    /** 支持的思考档位。 */
    const efforts = own?.thinking ?? (entry.supported_reasoning_levels ?? []).map((level) => level.effort);
    /** OpenAI 协议的模型覆盖项；其他协议不读取这部分配置。 */
    let completionOptions = {};
    if (apiName === 'openai-completions') {
      const compatPath = `model_compat.${entry.id}`;
      const entryCompat = checks.asRecord(modelCompat[entry.id] ?? {}, compatPath);
      completionOptions = {
        compat: {
          ...compat,
          ...entryCompat,
        } as piAi.OpenAICompletionsCompat,
      };
    }
    models.push({
      ...base,
      api: apiName,
      reasoning: own?.thinking ? own.thinking.some((level) => level !== 'none' && level !== 'off') : entry.reasoning === true,
      thinkingLevelMap: toThinkingLevelMap(efforts),
      input: (own?.vision ?? (entry.modalities?.input ?? entry.architecture?.input_modalities ?? []).includes('image')) ? ['text', 'image'] : ['text'],
      cost: {
        input: own?.price?.input ?? perMillion(entry.pricing?.prompt),
        output: own?.price?.output ?? perMillion(entry.pricing?.completion),
        cacheRead: perMillion(entry.pricing?.input_cache_read),
        cacheWrite: perMillion(entry.pricing?.input_cache_write),
      },
      contextWindow: own?.context_window ?? listedWindow ?? UNKNOWN_CONTEXT_WINDOW,
      maxTokens: own?.max_output_tokens ?? listedOutput ?? UNKNOWN_MAX_OUTPUT,
      ...completionOptions,
    });
  }
  if (guessed > 0) {
    console.log(`供应商 ${providerId}：${guessed} 个模型清单没给全参数，用保守值（上下文 ${UNKNOWN_CONTEXT_WINDOW}、最大输出 ${UNKNOWN_MAX_OUTPUT}）；要准确就写进 config.yaml 的 providers.${providerId}.models`);
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
    api: streams(),
    classifiers: { 'typesafe-system-one': piSystemOne.typesafeSystemOneApi() },
  });
}


/**
 * 一家供应商的模型清单（常规和决策）。
 * @param models Pi 的模型集合。
 * @param providerId 供应商。
 * @returns 模型清单。
 */
function summariesOf(models: piAi.Models, providerId: string): ModelSummary[] {
  /** 结果。 */
  const list: ModelSummary[] = [];
  for (const item of models.getModels(providerId)) {
    /** 档位表：值是字符串的档位才支持。 */
    const levelMap: piAi.ThinkingLevelMap = item.thinkingLevelMap ?? {};
    /** 支持的档位；一个都没有（不能选档的模型）就只列 off，表示“用它自己的默认”。 */
    const levels = allowedThinking.filter((level) => typeof levelMap[level as keyof piAi.ThinkingLevelMap] === 'string');
    list.push({
      id: `${providerId}/${item.id}`,
      name: item.name,
      kind: 'chat',
      contextWindow: item.contextWindow,
      maxOutputTokens: item.maxTokens,
      thinking: levels.length > 0 ? levels : ['off'],
      vision: (item.input ?? []).includes('image'),
      price: { input: item.cost.input, output: item.cost.output },
    });
  }
  for (const item of models.getModelsOfType('classifier', providerId)) {
    list.push({ id: `${providerId}/${item.id}`, name: item.name, kind: 'decision', contextWindow: item.contextWindow, thinking: [], vision: false, price: { input: 0, output: 0 } });
  }
  return list;
}


/**
 * 直接问一家供应商有哪些模型（设置页“获取可用模型”）：用给的地址、密钥、协议，不用写进 config.yaml、不用重启。
 * @param providerId 供应商名。
 * @param provider 地址、密钥、协议。
 * @returns 模型清单。
 * @throws 连不上、协议不认识时抛错。
 * 副作用：发一个请求。
 */
export async function probeProvider(providerId: string, provider: resourcesModule.ProviderConfig): Promise<ModelSummary[]> {
  /** 临时的集合。 */
  const models = piAi.createModels();
  models.setProvider(await fetchProvider(providerId, provider));
  return summariesOf(models, providerId);
}


/**
 * 被限流后依次要试的模型：角色自己的备用 → 全局备用链（engine.fallback_chain）→ 同供应商**不收费**的其他常规模型；
 * 去掉重复的和最先要的那个，最多 engine.fallback_max_tries 个。同供应商的只挑价格为 0 的：按量收费的（如 OpenRouter）
 * 自动去试会花用户的钱（记忆库「订阅额度使用边界」）。
 * @param asked 最先要的模型。
 * @param own 角色自己的备用模型。
 * @param resources 资源（备用链、最多几个、要不要试同供应商的）。
 * @param models 模型清单。
 * @returns 有序的模型 ID。
 * 无副作用。
 */
export function fallbackCandidates(asked: string, own: string[], resources: resourcesModule.Resources, models: ModelSummary[]): string[] {
  /** 全局备用链；空的表示关掉兜底（角色自己的也不试）。 */
  const chain = resources.getSetting('fallbackChain');
  if (chain.length === 0) {
    return [];
  }
  /** 同一个供应商里不收费的常规模型。 */
  const siblings = resources.getSetting('fallbackSiblings')
    ? models.filter((item) => item.kind === 'chat' && item.id.split('/')[0] === asked.split('/')[0] && item.price.input === 0 && item.price.output === 0).map((item) => item.id)
    : [];
  /** 去重后的结果。 */
  const result: string[] = [];
  for (const model of [...own, ...chain, ...siblings]) {
    if (model !== asked && !result.includes(model)) {
      result.push(model);
    }
  }
  return result.slice(0, Math.max(0, resources.getSetting('fallbackMaxTries')));
}


/**
 * 这个错误是不是一时的（连不上、超时、网关 5xx）：隔一会儿重试同一个模型多半就好了。
 * @param error ChatOutput.error。
 * @returns 是就是 true。
 */
export function isTransient(error: string): boolean {
  return /connection error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|timed? ?out|\b50[234]\b/i.test(error);
}


/**
 * 这个错误是不是"上下文超长"（发的内容超出模型一次能读的上限）。
 * @param error ChatOutput.error。
 * @returns 是就是 true。
 */
export function isContextOverflow(error: string): boolean {
  return /context.?window|context.?length|maximum context|too many tokens|prompt is too long|上下文.{0,6}(超|过长|太长)/i.test(error);
}


/**
 * 上下文超长时要试的模型：能读得比它多的常规模型，要么在备用链（角色自己的 + 全局的）里，要么是同供应商里不收费的；
 * 上限大的先试，最多 engine.fallback_max_tries 个。
 * @param asked 原来的模型。
 * @param own 角色自己的备用模型。
 * @param resources 资源。
 * @param models 模型清单。
 * @returns 有序的模型 ID。
 * 无副作用。
 */
export function largerWindowCandidates(asked: string, own: string[], resources: resourcesModule.Resources, models: ModelSummary[]): string[] {
  /** 原来那个能读多少。 */
  const current = models.find((item) => item.id === asked)?.contextWindow ?? 0;
  /** 备用链。 */
  const chain = new Set([...own, ...resources.getSetting('fallbackChain')]);
  return models
    .filter((item) => item.kind === 'chat' && item.id !== asked && item.contextWindow > current)
    .filter((item) => chain.has(item.id) || (item.id.split('/')[0] === asked.split('/')[0] && item.price.input === 0 && item.price.output === 0))
    .sort((a, b) => b.contextWindow - a.contextWindow)
    .map((item) => item.id)
    .slice(0, Math.max(0, resources.getSetting('fallbackMaxTries')));
}


/**
 * 这个错误是不是被限流了（额度用完、频率超限）：只有这种才值得换个模型再试，别的错误换了也没用。
 * @param error ChatOutput.error。
 * @returns 是限流就是 true。
 */
export function isRateLimited(error: string): boolean {
  return /\b429\b|rate.?limit|频率限制|使用量已超出|额度.*(用完|不足)|quota/i.test(error);
}


/** 冷却最长多久：报错里的恢复时间读错了，也不至于一直不用这个模型。 */
const COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;


/**
 * “过多久再试”的单位换成毫秒：ms、milliseconds 是毫秒，m、min、minutes 是分，h、hours 是时，别的（s、seconds、没写）按秒。
 * @param unit 数字后面跟的那个词，小写。
 * @returns 一个单位多少毫秒。
 */
function unitMs(unit: string): number {
  if (unit.startsWith('ms') || unit.startsWith('mil')) {
    return 1;
  }
  if (unit.startsWith('m')) {
    return 60_000;
  }
  if (unit.startsWith('h')) {
    return 3_600_000;
  }
  return 1000;
}


/**
 * 从限流报错里读出什么时候恢复（docs/10 6.5）。认这几种写法：
 *   “将在 2026-11-07 02:20:26 UTC+8 重置”（WorkBuddy）、带时区的 ISO 时间（2026-11-07T02:20:26+08:00）、
 *   “retry after 30 seconds”“try again in 20s”。
 * @param error ChatOutput.error。
 * @param now 现在，毫秒（“过多久再试”从这里算）。
 * @returns 恢复的时间，毫秒；读不出来是 undefined。
 * 无副作用。
 */
export function resetTimeOf(error: string, now: number): number | undefined {
  /** 带时区的日期时间：日期、时刻、正负号、时、分。 */
  const stamp = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?/i.exec(error);
  if (stamp) {
    /** 时刻；秒没写就补 00。 */
    const time = stamp[2]!.length === 5 ? `${stamp[2]!}:00` : stamp[2]!;
    /** 解析出来的时间。 */
    const at = Date.parse(`${stamp[1]!}T${time}${stamp[3]!}${stamp[4]!.padStart(2, '0')}:${stamp[5] ?? '00'}`);
    return Number.isNaN(at) ? undefined : at;
  }
  /** “过多久再试”：数字和后面跟的词。 */
  const after = /(?:retry.?after|try again in)\W{0,3}(\d+(?:\.\d+)?)\s*([a-z]*)/i.exec(error);
  return after ? now + Number(after[1]) * unitMs(after[2]!.toLowerCase()) : undefined;
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
    throw new Error(`供应商 ${providerId} 的模型清单里没有 ${modelId}：模型 ID 写对了吗？这家连上了吗？${RECONNECT_HINT}`);
  }

  //M 1. 思考强度：调用方写的 > config.yaml 里用这个模型的那一项写的 > off。写错的档位直接报错，免得悄悄变成最低档。
  /** config.yaml 里用这个模型的那一项。 */
  const configured = Object.values(resources.listModelChoices()).find((item) => item.model === input.model);
  /** 要的思考强度。 */
  const thinkingAsked = input.thinking ?? configured?.thinking ?? 'off';
  /** 设置来源与实际档位分开，不能把默认值称为供应商报告。 */
  let thinkingSource: ChatRequest['thinkingSource'] = 'default-off';
  if (input.thinking !== undefined) {
    thinkingSource = 'caller';
  } else if (configured?.thinking) {
    thinkingSource = 'configured-model';
  }
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
      thinkingSource,
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
    throw new Error(`供应商 ${providerId} 的清单里没有决策模型 ${modelId}：模型 ID 写对了吗？这家连上了吗？${RECONNECT_HINT}`);
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
 * 谁建：Ai 的构造函数建一个，所有模型调用共用；测试可以单独建。
 */
export class ModelQueue {
  /** 每个名额键（“模型:ID”“供应商:名字”）正在用几个。 */
  private readonly running = new Map<string, number>();

  /** 每个名额键在等的调用（叫醒函数）。 */
  private readonly waiting = new Map<string, (() => void)[]>();

  /**
   * @param settings 配额（config.yaml 的 concurrency）：perModel 每个模型默认几个，
   *   models 个别模型自己的，providers 每个供应商合计几个（没写不限）。
   */
  constructor(private readonly settings: resourcesModule.ConcurrencySettings) {}

  /**
   * 排队做一个调用：占名额、做、还名额。
   * @param model 模型 ID“供应商/模型”。
   * @param task 要做的调用。
   * @returns 调用的结果。
   * 副作用：改名额计数；名额满了就等。
   */
  async run<T>(model: string, task: () => Promise<T>): Promise<T> {
    //M 1. 算这次要占的名额：模型的，加上有配额的供应商的。
    /** 供应商名。 */
    const provider = model.split('/')[0] ?? '';
    /** 这个供应商的合计上限；没写不限。 */
    const providerLimit = this.settings.providers[provider];
    /** 这个模型的上限。 */
    const modelLimit = this.settings.models[model] ?? this.settings.perModel;

    //M 2. 先占模型的，再占供应商的（顺序固定）。
    await this.acquire(`模型:${model}`, modelLimit);
    if (providerLimit !== undefined) {
      await this.acquire(`供应商:${provider}`, providerLimit);
    }

    //M 3. 做调用；不管成败，都按相反顺序还名额。
    try {
      return await task();
    } finally {
      if (providerLimit !== undefined) {
        this.release(`供应商:${provider}`);
      }
      this.release(`模型:${model}`);
    }
  }

  /**
   * 占一个名额，满了就等。
   * @param key 名额键。
   * @param limit 上限。
   */
  private async acquire(key: string, limit: number): Promise<void> {
    while ((this.running.get(key) ?? 0) >= limit) {
      await new Promise<void>((resolve) => {
        this.waiting.set(key, [...(this.waiting.get(key) ?? []), resolve]);
      });
    }
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
  }

  /**
   * 还一个名额，叫醒等着的第一个。
   * @param key 名额键。
   */
  private release(key: string): void {
    this.running.set(key, (this.running.get(key) ?? 1) - 1);
    this.waiting.get(key)?.shift()?.();
  }
}


/** 调一次模型用了多少：用量表的一行（docs/15_用量表.md 第 1 节）。 */
export interface UsageRecord {
  /** 时间，毫秒。 */
  at: number;
  /** 供应商（模型 ID 第一段）。 */
  provider: string;
  /** 模型 ID。 */
  model: string;
  /** chat 常规模型，decide 决策模型。 */
  kind: 'chat' | 'decide';
  /** 谁调的：session、compact、other…… */
  purpose: string;
  /** 哪个机器人。 */
  bot?: string;
  /** 哪个会话。 */
  sessionId?: string;
  /** 输入 token（不含缓存读）。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** 缓存读 token。 */
  cacheRead: number;
  /** 缓存写 token。 */
  cacheWrite: number;
  /** 钱，美元。 */
  cost: number;
  /** 用时，毫秒。 */
  ms: number;
  /** 成没成。 */
  ok: boolean;
  /** 出错原因（前 300 字）。 */
  error?: string;
}


/** 一次逻辑请求的观察状态；重试和备用模型沿用同一个 requestId。 */
interface CallObservation {
  /** 本次逻辑请求的唯一标识，不使用供应商凭据。 */
  requestId: string;
  /** 调用方最先指定的模型；实际尝试模型另记在事件的 model。 */
  askedModel: string;
  /** 常规对话或决策分类。 */
  kind: UsageRecord['kind'];
  /** 调用用途，和既有用量表保持一致。 */
  purpose: string;
  /** 机器人归属；没有时省略。 */
  bot?: string;
  /** 会话归属；分派阶段通常没有。 */
  sessionId?: string;
  /** 来自调用方的运行、步骤和消息号，仅用于观察。 */
  trace?: CallTrace;
  /** 本请求已进入并发队列的尝试次数，用来产生 attemptId。 */
  attempts: number;
  /** 排队当时明确的调用方档位；未指定或决策调用时为空。 */
  thinkingRequested: string | null;
}


/** 一次模型尝试的实测时间，队列等待与调用耗时各自计算。 */
interface AttemptTiming {
  /** 所属逻辑请求内唯一的尝试标识。 */
  attemptId: string;
  /** 这次真正排队的模型；与 askedModel 分开。 */
  model: string;
  /** 进入现有并发队列前的时间，Unix 毫秒。 */
  queuedAt: number;
  /** 拿到全部并发名额后、开始调用的时间，Unix 毫秒。 */
  startedAt?: number;
  /** 调用返回或抛错时的时间，Unix 毫秒；不包含后续用量监听。 */
  endedAt?: number;
}


/** 一次尝试可交给事件记录的安全结果，不包含系统提示或上下文正文。 */
interface AttemptResult {
  /** SDK 调用实测耗时，毫秒；本地校验就抛错时没有。 */
  apiMs?: number;
  /** SDK 返回的用量；供应商没有报告时省略，不用零冒充。 */
  usage?: piAi.Usage;
  /** SDK 返回的错误或本地异常；未经改写的依据交给事件总线脱敏。 */
  error?: string;
  /** 模型实际使用的思考档；决策分类没有。 */
  thinking?: string;
  /** 调用方要求的思考档；决策分类没有。 */
  thinkingAsked?: string;
  /** 实际请求档位从调用方、该模型配置或默认 off 得来。 */
  thinkingSource?: ChatRequest['thinkingSource'];
  /** 正文字符数；不记录正文或思考全文。 */
  outputChars?: number;
  /** 正文 UTF-8 字节数；不含附件。 */
  outputBytes?: number;
  /** 工具调用数量；决策分类没有。 */
  toolCalls?: number;
  /** 分类模型返回的回答数量；常规对话没有。 */
  answers?: number;
}


/**
 * 只给事件标注错误性质；不参与既有的重试或回退判断。
 * @param error SDK 错误原文。
 * @returns 无错误时为空；429 本身只说明限流，不推断额度用尽。
 */
function observedErrorKind(error: string | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  /** 只有明确说配额不足/耗尽的文本才给额度标签；分类不影响回退行为。 */
  const englishQuota =
    /insufficient[_ -]?quota|quota.{0,40}(exceed|exhaust|insufficient)|(?:exceed|exhaust).{0,40}quota/i;
  const chineseQuota = /额度.{0,12}(不足|用完|耗尽)|配额.{0,12}(不足|用完|耗尽|超出)/i;
  if (englishQuota.test(error) || chineseQuota.test(error)) {
    return 'quota';
  }
  if (isContextOverflow(error)) {
    return 'context-overflow';
  }
  if (isRateLimited(error)) {
    return 'rate-limit';
  }
  if (/timed? ?out|ETIMEDOUT|超时/i.test(error)) {
    return 'timeout';
  }
  if (isTransient(error)) {
    return 'transient';
  }
  return 'other';
}


/**
 * 模型库：调常规模型（chat）、调决策模型（decide）、列出可用模型（listModels）；
 * 内部管配额排队、限流冷却、连接出错重试、换备用模型。
 * 谁建：入口 src/entries/App.ts 用 Ai.connect 建一个，所有模块共用；测试传假的 Pi 模型集合。
 */
export class Ai {
  /** 决策模型 ID；没配时是 undefined。 */
  private readonly decisionModel: string | undefined;

  /** 按配额排队（config.yaml 的 concurrency）。 */
  private readonly queue: ModelQueue;

  /** 并发队列构造时的规则快照，事件用它说明限制，不能临时重新读取冒充实际规则。 */
  private readonly concurrency: resourcesModule.ConcurrencySettings;

  /** 被限流的模型 → 冷却到什么时候（毫秒）；只在内存里，重启就清掉（docs/10 6.5）。 */
  private readonly cooldowns = new Map<string, number>();

  /** 冷却依据：对应模型最近一次真实限流错误，只用于解释跳过，随冷却过期清理。 */
  private readonly cooldownErrors = new Map<string, string>();

  /** 用量的监听：每真调一次模型叫一遍（入口登记成写进用量表，docs/15）。 */
  private readonly usageListeners: ((row: UsageRecord) => void)[] = [];

  /** 入口接入的事件总线；没有时不写观察记录，调用行为照旧。 */
  private events: eventsModule.EventBus | undefined;

  /**
   * @param resources 资源（供应商、模型选择、配额、重试间隔、冷却时间）；src/entries/App.ts 建的那个。
   * @param models Pi 的模型集合，已经向各家供应商拉过清单（Ai.connect 建的，测试传假的）；
   *   要能换掉一家供应商（MutableModels），reconnect 拉到新清单时用。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly models: piAi.MutableModels,
  ) {
    this.decisionModel = resources.getModelChoice('decision')?.model;
    this.concurrency = resources.getConcurrency();
    this.queue = new ModelQueue(this.concurrency);
  }

  /**
   * 连上模型：向 config.yaml 里每个供应商拉一次清单，建好 Ai。
   * 一家连不上不挡别家，也不挡服务起来：打一行日志，每分钟再试，连上就能用。
   * @param resources 资源。
   * @param piModels 现成的 Pi 模型集合；测试传替身，传了就不联网。
   * @returns 模型库。
   * 副作用：联网；有没连上的供应商时留一个定时器。
   */
  static async connect(resources: resourcesModule.Resources, piModels?: piAi.MutableModels): Promise<Ai> {
    //M 传了现成的集合（测试）就不联网。
    if (piModels) {
      return new Ai(resources, piModels);
    }

    //M 新建集合，向每家拉清单；没连上的留着重试。
    /** 新建的集合。 */
    const created = piAi.createModels();
    /** 还没连上的供应商。 */
    const pending = new Map(Object.entries(resources.getProviders()));
    /** 报过错的，重试时不再重复打日志。 */
    const reported = new Set<string>();
    /**
     * 把还没连上的都试一遍。
     * @returns 无。
     */
    const tryPending = async (): Promise<void> => {
      for (const [providerId, provider] of pending) {
        try {
          created.setProvider(await fetchProvider(providerId, provider));
          pending.delete(providerId);
          if (reported.has(providerId)) {
            console.log(`供应商 ${providerId} 连上了`);
          }
        } catch (error) {
          if (!reported.has(providerId)) {
            reported.add(providerId);
            /** 错误原因。 */
            const reason = error instanceof Error ? error.message : String(error);
            /** 日志里的重试间隔（秒）。 */
            const seconds = RECONNECT_MS / 1000;
            console.error(`供应商 ${providerId} 没连上，先跳过，每 ${seconds} 秒再试一次：${reason}`);
          }
        }
      }
    };
    await tryPending();
    if (pending.size > 0) {
      /** 定时重试；全连上就停。 */
      const timer = setInterval(() => {
        void tryPending().then(() => {
          if (pending.size === 0) {
            clearInterval(timer);
          }
        });
      }, RECONNECT_MS);
      timer.unref();
    }
    return new Ai(resources, created);
  }


  /**
   * 接入只读事件记录：由 App 在建好事件总线后调用。
   * @param events 现有事件总线；负责脱敏、截短和记录失败时放行。
   * @returns 无；不改模型配置、不发模型请求。
   */
  setEvents(events: eventsModule.EventBus): void {
    this.events = events;
  }


  /**
   * 调常规模型。请求出错不抛，原因在 error；模型 ID 写错、不在清单里时抛错。
   * 被限流或上下文超长时自动换模型（见 retryWithBigger、retryWithFallbacks）。
   * @param input 模型、积木、上下文、工具、思考强度、备用模型。
   * @returns 结果。
   */
  async chat(input: ChatInput): Promise<ChatOutput> {
    /** 本请求的观察关联；复制消息号，避免等待期间被调用方改成下一批。 */
    const observation = this.observeCall(input.model, 'chat', input);

    //M 1. 先用要的模型；它被限流过、还在冷却，就不再先撞一次，直接去换备用的
    //  （docs/10 6.5：11-06 deepseek 当天额度用完后每一步都先失败一次）。
    /** 原有冷却判断的结果；拿来解释这次为什么没先请求指定模型。 */
    const coolingUntil = this.coolingUntil(input.model);
    /** 要的模型这次的结果；在冷却、没调时是 undefined。 */
    const first = coolingUntil === undefined
      ? await this.chatWithRetry(input, observation)
      : undefined;
    if (coolingUntil !== undefined) {
      this.report('model.skipped', observation, {
        model: input.model,
        reason: 'cooldown',
        coolingUntil,
        error: this.cooldownErrors.get(input.model),
        errorKind: observedErrorKind(this.cooldownErrors.get(input.model)),
      });
    }

    //G 没出错，或者错的既不是限流也不是上下文超长（参数错、鉴权错）：换模型也没用，原样返回。
    /** 这次的错误；没出错或没调是空串。 */
    const error = first?.error ?? '';
    /** 错的是限流或上下文超长，换模型才有用。 */
    const switchable = error !== '' && (isRateLimited(error) || isContextOverflow(error));
    if (first && !switchable) {
      return first;
    }

    //M 2. 上下文超长：换能读得更多的模型。
    if (first?.error && isContextOverflow(first.error)) {
      return this.retryWithBigger(input, first, observation);
    }

    //M 3. 被限流（或还在冷却）：换备用模型。
    return this.retryWithFallbacks(input, first, observation);
  }

  /**
   * 调决策模型（config.yaml 的 models.decision）。出错不抛，原因在 error；没配决策模型时抛错。
   * @param input 情况和问题；model 可以指定别的决策模型。
   * @returns 结果。
   */
  decide(input: DecideInput): Promise<DecideOutput> {
    /** 这次用的决策模型。 */
    const chosen = input.model ?? this.decisionModel;
    if (!chosen) {
      throw new Error('config.yaml 的 models.decision 没配决策模型');
    }
    /** 决策请求也独立编号；不记录题面或 state 全文。 */
    const observation = this.observeCall(chosen, 'decide', input);
    return this.decideOnce(chosen, input, observation);
  }

  /**
   * 登记用量的监听（docs/15）：以后每真调一次模型（重试、换备用的每一次都算）就叫它一遍。
   * @param listener 收一行用量；它出错只打日志，不挡调模型。
   */
  onUsage(listener: (row: UsageRecord) => void): void {
    this.usageListeners.push(listener);
  }

  /**
   * 记一次调用的用量：补上供应商、时间，截短出错原因，交给监听。
   * @param call 模型、种类、谁调的、用量、用时、出错原因。
   */
  private recordUsage(call: {
    model: string;
    kind: UsageRecord['kind'];
    purpose?: string;
    bot?: string;
    sessionId?: string;
    usage?: piAi.Usage;
    ms: number;
    error?: string;
  }): void {
    /** 一行。 */
    const row: UsageRecord = {
      at: Date.now(),
      provider: call.model.split('/')[0] ?? '',
      model: call.model,
      kind: call.kind,
      purpose: call.purpose ?? 'other',
      bot: call.bot,
      sessionId: call.sessionId,
      input: call.usage?.input ?? 0,
      output: call.usage?.output ?? 0,
      cacheRead: call.usage?.cacheRead ?? 0,
      cacheWrite: call.usage?.cacheWrite ?? 0,
      cost: call.usage?.cost.total ?? 0,
      ms: call.ms,
      ok: !call.error,
      error: call.error?.slice(0, 300),
    };
    for (const listener of this.usageListeners) {
      try {
        listener(row);
      } catch (error) {
        console.error(`${utils.formatTime()} 用量没记上：${utils.errorText(error)}`);
      }
    }
  }

  /**
   * 固定一次逻辑请求的观察身份；备用模型与重试复用返回值。
   * @param model 调用方指定的模型。
   * @param kind 对话或决策。
   * @param input 用途、机器人、会话及调用方已知的关联。
   * @returns 只属于本请求的新对象；复制消息号，不持有外部可变数组。
   */
  private observeCall(
    model: string,
    kind: UsageRecord['kind'],
    input: Pick<ChatInput, 'purpose' | 'bot' | 'sessionId' | 'trace' | 'thinking'>,
  ): CallObservation {
    /** 调用方的关联快照；排队和异步备用不会读到后来一批的消息号。 */
    const trace = input.trace === undefined
      ? undefined
      : {
        run: input.trace.run,
        step: input.trace.step,
        messageIds: input.trace.messageIds?.slice(),
      };

    return {
      requestId: utils.createSessionId(),
      askedModel: model,
      kind,
      purpose: input.purpose ?? 'other',
      bot: input.bot,
      sessionId: input.sessionId,
      trace,
      attempts: 0,
      thinkingRequested: input.thinking ?? null,
    };
  }


  /**
   * 把模型观察交给既有事件总线，所有正文/错误在总线统一脱敏截短。
   * @param type 事件类型。
   * @param observation 本请求固定的身份与关联。
   * @param details 安全字段；不能传系统提示、state、上下文或附件正文。
   * @returns 无；事件写不成不影响调用。
   */
  private report(
    type: string,
    observation: CallObservation,
    details: Record<string, unknown>,
  ): void {
    /** 顶层关联供 Store 的只读追踪查询匹配，不依赖时间猜测。 */
    const data = {
      requestId: observation.requestId,
      askedModel: observation.askedModel,
      kind: observation.kind,
      purpose: observation.purpose,
      run: observation.trace?.run,
      step: observation.trace?.step,
      messageIds: observation.trace?.messageIds,
      thinkingRequested: observation.thinkingRequested,
      thinkingSent: null,
      thinkingReported: null,
      ...details,
    };
    /** 事件的机器人、会话与最后一条明确关联收件。 */
    const options = {
      source: 'Ai',
      bot: observation.bot,
      sessionId: observation.sessionId,
      messageId: observation.trace?.messageIds?.at(-1),
    };

    this.events?.emit(type, data, options);
  }


  /**
   * 在进入现有并发队列前记一次尝试；不另设队列或等待。
   * @param observation 所属请求。
   * @param model 这次实际尝试的模型。
   * @returns 本次独占的时间对象，之后仅由对应队列回调更新。
   */
  private queueAttempt(observation: CallObservation, model: string): AttemptTiming {
    observation.attempts += 1;
    /** 尝试身份与进队时间；不能拿规则间隔替代实测时间。 */
    const timing: AttemptTiming = {
      attemptId: `${observation.requestId}:${String(observation.attempts)}`,
      model,
      queuedAt: Date.now(),
    };
    /** 实际使用的并发规则，与 ModelQueue 构造时读的是同一份配置。 */
    const concurrency = this.concurrency;
    const provider = model.split('/')[0] ?? '';
    const modelLimit = concurrency.models[model] ?? concurrency.perModel;

    this.report('model.queued', observation, {
      ...timing,
      modelLimit,
      providerLimit: concurrency.providers[provider],
    });
    return timing;
  }


  /**
   * 并发队列真正交出名额时记录开始；调用处紧接着执行 SDK 请求准备。
   * @param observation 所属请求。
   * @param timing 本次尝试时间。
   * @returns 无；只补 startedAt 并报事件。
   */
  private startAttempt(observation: CallObservation, timing: AttemptTiming): void {
    timing.startedAt = Date.now();
    /** 排队耗时来自拿到名额的时刻减去进队时刻，包含模型与供应商两层等待。 */
    const waitMs = timing.startedAt - timing.queuedAt;

    this.report('model.started', observation, { ...timing, waitMs });
  }


  /**
   * 一次尝试完成后记录回执；用量和既有用量表来自同一个 SDK 返回对象。
   * @param observation 所属请求。
   * @param timing 进队、开始、结束的实测时间。
   * @param result 安全的用量、计数、错误依据，不含全文请求。
   * @returns 无；没有供应商用量时留空，不能以零冒充真实报告。
   */
  private completeAttempt(
    observation: CallObservation,
    timing: AttemptTiming,
    result: AttemptResult,
  ): void {
    /** 队列实际等待；未拿到名额就失败时不能计算。 */
    const waitMs = timing.startedAt === undefined
      ? undefined
      : timing.startedAt - timing.queuedAt;
    /** 拿到名额到调用结束的实际差值；不包括后续用量入库监听。 */
    const ms = timing.startedAt === undefined || timing.endedAt === undefined
      ? undefined
      : timing.endedAt - timing.startedAt;

    this.report('model.completed', observation, {
      ...timing,
      waitMs,
      ms,
      apiMs: result.apiMs,
      ok: !result.error,
      error: result.error,
      errorKind: observedErrorKind(result.error),
      input: result.usage?.input,
      output: result.usage?.output,
      cacheRead: result.usage?.cacheRead,
      cacheWrite: result.usage?.cacheWrite,
      totalTokens: result.usage?.totalTokens,
      cost: result.usage?.cost.total,
      thinkingAsked: result.thinkingAsked,
      thinking: result.thinking,
      thinkingRequested: result.thinkingAsked ?? observation.thinkingRequested,
      thinkingSent: result.thinking ?? null,
      thinkingReported: null,
      thinkingSource: result.thinkingSource ?? null,
      outputChars: result.outputChars,
      outputBytes: result.outputBytes,
      toolCalls: result.toolCalls,
      answers: result.answers,
    });
  }


  /**
   * 跑一次真实常规调用：排队 → 得到名额 → 调用 → 原有用量登记。
   * @param input 这次实际要用的模型与上下文。
   * @param observation 逻辑请求的观察关联。
   * @returns 原来的 SDK 结果；异常原样抛出，不新增回退。
   * 副作用：沿用 ModelQueue 调模型、登记用量，额外只写观察事件。
   */
  private async chatOnce(
    input: ChatInput,
    observation: CallObservation,
  ): Promise<ChatOutput> {
    const timing = this.queueAttempt(observation, input.model);
    try {
      /** 队列回调只在拿到两层名额后执行；finally 在还名额前固定结束时间。 */
      const output = await this.queue.run(input.model, async () => {
        this.startAttempt(observation, timing);
        try {
          return await chat(this.models, this.resources, input);
        } finally {
          timing.endedAt = Date.now();
        }
      });
      this.recordUsage({
        model: input.model,
        kind: 'chat',
        purpose: input.purpose,
        bot: input.bot,
        sessionId: input.sessionId,
        usage: output.message.usage,
        ms: output.ms,
        error: output.error,
      });
      this.completeAttempt(observation, timing, {
        apiMs: output.ms,
        usage: output.message.usage,
        error: output.error,
        thinkingAsked: output.request.thinkingAsked,
        thinking: output.request.thinking,
        thinkingSource: output.request.thinkingSource,
        outputChars: output.text.length,
        outputBytes: Buffer.byteLength(output.text, 'utf8'),
        toolCalls: output.toolCalls.length,
      });
      return output;
    } catch (error) {
      //G 原来会抛出的本地校验/SDK异常继续抛出；只补失败观察，不伪造用量。
      timing.endedAt ??= Date.now();
      this.completeAttempt(observation, timing, { error: utils.errorText(error) });
      throw error;
    }
  }


  /**
   * 跑一次决策调用，保留公开 decide 在没配置模型时同步报错的行为。
   * @param model 已选定的决策模型。
   * @param input 分类题与情况；这些正文不会进入事件。
   * @param observation 固定的观察身份。
   * @returns 原有分类结果；异常原样抛出。
   * 副作用：沿用并发队列调模型、登记用量，额外只写观察事件。
   */
  private async decideOnce(
    model: string,
    input: DecideInput,
    observation: CallObservation,
  ): Promise<DecideOutput> {
    const timing = this.queueAttempt(observation, model);
    try {
      /** 得到名额后才开始计调用耗时；分类没有供应商 token 报告。 */
      const output = await this.queue.run(model, async () => {
        this.startAttempt(observation, timing);
        try {
          return await decide(this.models, model, input);
        } finally {
          timing.endedAt = Date.now();
        }
      });
      this.recordUsage({
        model,
        kind: 'decide',
        purpose: input.purpose,
        bot: input.bot,
        sessionId: input.sessionId,
        ms: output.ms,
        error: output.error,
      });
      this.completeAttempt(observation, timing, {
        apiMs: output.ms,
        error: output.error,
        answers: Object.keys(output.answers).length,
      });
      return output;
    } catch (error) {
      timing.endedAt ??= Date.now();
      this.completeAttempt(observation, timing, { error: utils.errorText(error) });
      throw error;
    }
  }


  /**
   * 有没有配决策模型。
   * @returns 配了是 true。
   */
  hasDecision(): boolean {
    return this.decisionModel !== undefined;
  }

  /**
   * 列出全部模型（常规和决策），供分派挑、供兜底找同供应商的模型；在冷却的带上 limitedUntil。
   * @returns 模型清单。
   */
  listModels(): ModelSummary[] {
    return Object.keys(this.resources.getProviders())
      .flatMap((providerId) => summariesOf(this.models, providerId))
      .map((item) => {
        /** 冷却到什么时候。 */
        const until = this.coolingUntil(item.id);
        return until === undefined ? item : { ...item, limitedUntil: until };
      });
  }

  /**
   * 重新连接：向供应商重拉模型清单，拉到了就原地换掉这家，不用重启。
   * 启动时清单没拉到、先用了手写模型的那家，之后连上了也不会自己重拉，靠这个
   * （网页设置“重连”里的“重新测试模型连接”，POST /api/models/reconnect）。
   * 拉不到时这家保持原样（手写的模型照旧能用），原因写在结果里。
   * @param providerId 只重连这一家；不给就重连 config.yaml 里的每一家。
   * @returns 每家一条结果。
   * @throws 给的供应商不在 config.yaml 里时抛错。
   * 副作用：联网；连上的那家在模型集合里换成新拉的。
   */
  async reconnect(providerId?: string): Promise<ReconnectResult[]> {
    /** config.yaml 里的供应商。 */
    const providers = this.resources.getProviders();
    if (providerId !== undefined && providers[providerId] === undefined) {
      throw new Error(`config.yaml 的 providers 里没有 ${providerId}`);
    }
    /** 这次要重连的供应商名。 */
    const names = providerId === undefined
      ? Object.keys(providers)
      : [providerId];
    /** 每家的结果。 */
    const results: ReconnectResult[] = [];
    for (const name of names) {
      /** 这家的结果。 */
      const result = await this.reconnectOne(name, providers[name]!);
      results.push(result);
    }
    return results;
  }

  /**
   * 重连一家：清单一定要拉到，拉到了换掉，拉不到保持原样。
   * @param providerId 供应商名。
   * @param provider 这家的配置。
   * @returns 这家的结果。
   */
  private async reconnectOne(
    providerId: string,
    provider: resourcesModule.ProviderConfig,
  ): Promise<ReconnectResult> {
    try {
      /** 新拉的这家。 */
      const fetched = await fetchProvider(providerId, provider, true);
      this.models.setProvider(fetched);
      /** 现在能用的模型个数。 */
      const count = summariesOf(this.models, providerId).length;
      console.log(`供应商 ${providerId} 重新连上了，${count} 个模型`);
      return { provider: providerId, ok: true, models: count };
    } catch (error) {
      /** 没连上的原因。 */
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`供应商 ${providerId} 重新连接没成：${reason}`);
      /** 原来能用的模型个数。 */
      const count = summariesOf(this.models, providerId).length;
      return { provider: providerId, ok: false, models: count, error: reason };
    }
  }

  /**
   * 这个模型还在冷却吗；过了时间的顺手删掉。
   * @param model 模型 ID。
   * @returns 冷却到什么时候；没在冷却是 undefined。
   */
  private coolingUntil(model: string): number | undefined {
    /** 冷却到什么时候。 */
    const until = this.cooldowns.get(model);
    if (until !== undefined && until <= Date.now()) {
      this.cooldowns.delete(model);
      this.cooldownErrors.delete(model);
      return undefined;
    }
    return until;
  }

  /**
   * 这次被限流了就记进冷却表：恢复时间从报错里读，读不出来或已经过了就冷却
   * engine.rate_limit_cooldown_minutes，最长一天。
   * @param model 模型 ID。
   * @param error 这次的错误；不是限流就什么都不做。
   * 副作用：改冷却表；新记下时打一行日志。
   */
  private noteLimit(model: string, error: string | undefined): void {
    if (!error || !isRateLimited(error)) {
      return;
    }
    /** 现在。 */
    const now = Date.now();
    /** 报错里写的恢复时间。 */
    const reset = resetTimeOf(error, now);
    /** 默认冷却多久（毫秒）。 */
    const defaultMs = this.resources.getSetting('rateLimitCooldownMs');
    /** 冷却到什么时候。 */
    const resetOrDefault = reset !== undefined && reset > now ? reset : now + defaultMs;
    /** 冷却到什么时候。 */
    const until = Math.min(resetOrDefault, now + COOLDOWN_MAX_MS);
    if (this.coolingUntil(model) === undefined) {
      console.log(`${utils.formatTime()} ${model} 被限流，冷却到 ${utils.formatTime(until)}，这段时间换备用模型`);
    }
    this.cooldowns.set(model, until);
    this.cooldownErrors.set(model, error);
  }

  /**
   * 调一个模型；连接出错（多半是一时连不上 Magpie）就隔一会儿重试同一个，不急着换模型——
   * 2026-11-04 一次抖动里 5 个备用模型全报 Connection error，整串备用一下子都“用掉”了。
   * @param input 这次调用（model 是要用的模型）。
   * @param observation 同一次逻辑请求的观察快照，重试时不更换身份。
   * @returns 结果。
   */
  private async chatWithRetry(
    input: ChatInput,
    observation: CallObservation,
  ): Promise<ChatOutput> {
    /** 这一次的结果。 */
    let output = await this.chatOnce(input, observation);
    for (const delay of this.resources.getSetting('retryDelaysMs')) {
      if (!output.error || !isTransient(output.error)) {
        break;
      }
      /** 既有退避等待的起点；delay 是规则值，实测耗时另算。 */
      const startedAt = Date.now();
      this.report('model.retry', observation, {
        model: input.model,
        startedAt,
        delayMs: delay,
        error: output.error,
        errorKind: observedErrorKind(output.error),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));

      /** 退避结束时刻；只记录，不改变下次调用顺序。 */
      const endedAt = Date.now();
      this.report('model.retry.done', observation, {
        model: input.model,
        startedAt,
        endedAt,
        delayMs: delay,
        ms: endedAt - startedAt,
      });
      output = await this.chatOnce(input, observation);
    }
    this.noteLimit(input.model, output.error);
    return output;
  }

  /**
   * 上下文超长：换能读得更多的模型（2026-11-04：一个会话 180 万字超出 gpt-6.1-sol 的 51 万 token）。
   * @param input 原来的调用。
   * @param first 要的模型这次的结果（出错，原因是上下文超长）。
   * @param observation 原请求的观察身份，所有备用尝试沿用。
   * @returns 换模型后成功的结果；都装不下就是带人话说明的出错结果。
   */
  private async retryWithBigger(
    input: ChatInput,
    first: ChatOutput,
    observation: CallObservation,
  ): Promise<ChatOutput> {
    /** 上限比它大的模型，大的先试。 */
    const bigger = largerWindowCandidates(
      input.model,
      input.fallbacks ?? [],
      this.resources,
      this.listModels(),
    );
    /** 试过的。 */
    const triedBig: string[] = [input.model];
    for (const model of bigger) {
      this.report('model.fallback', observation, {
        from: input.model,
        to: model,
        reason: 'context-overflow',
        error: first.error,
        errorKind: observedErrorKind(first.error),
      });
      /** 只换实际模型，原请求身份和关联沿用。 */
      const nextInput = { ...input, model };
      /** 这一个的结果；不在清单里就跳过。 */
      const output = await this.chatWithRetry(nextInput, observation).catch((error: unknown) => {
        this.report('model.skipped', observation, {
          model,
          reason: 'unavailable',
          error: utils.errorText(error),
        });
        return undefined;
      });
      if (!output) {
        continue;
      }
      triedBig.push(model);
      if (!output.error) {
        /** 回话用的请求记录：补上从哪个模型换来的、试过哪些。 */
        const request = { ...output.request, fallbackFrom: input.model, tried: triedBig };
        return { ...output, request };
      }
    }
    return {
      ...first,
      error: `上下文太长：依次试了 ${triedBig.length} 个模型（${triedBig.join('、')}），都装不下。这个会话聊得太久了，开个新会话再说。`,
      request: { ...first.request, tried: triedBig },
    };
  }

  /**
   * 被限流（或还在冷却）：按“角色自己的备用 → 全局备用链 → 同供应商不收费的模型”依次换着试，
   * 任一成功就接着干（用户 2026-11-04：“任务就应该尝试去换别的模型，而不是直接中断；
   * 一直换到不能用为止”）。在冷却的跳过。
   * @param input 原来的调用。
   * @param first 要的模型这次的结果；它在冷却、没调时是 undefined。
   * @param observation 原请求的观察身份，所有备用尝试沿用。
   * @returns 换模型后成功的结果；全都不行就是带人话说明的出错结果。
   */
  private async retryWithFallbacks(
    input: ChatInput,
    first: ChatOutput | undefined,
    observation: CallObservation,
  ): Promise<ChatOutput> {
    //M 1. 排出依次要试的模型，跳过在冷却的。
    /** 依次要试的模型。 */
    const candidates = fallbackCandidates(
      input.model,
      input.fallbacks ?? [],
      this.resources,
      this.listModels(),
    );
    /** 这次真要调的：没在冷却的。 */
    let order = candidates.filter((model) => this.coolingUntil(model) === undefined);
    //G 全都在冷却：照旧按顺序都试一遍（冷却表记错了也不至于一个都不用），要的那个没调过就排最前。
    if (order.length === 0) {
      order = first ? candidates : [input.model, ...candidates];
    }

    //M 记录真正排除的冷却模型；“全在冷却仍试”的既有兜底不标成跳过。
    for (const model of candidates) {
      if (!order.includes(model)) {
        this.report('model.skipped', observation, {
          model,
          reason: 'cooldown',
          coolingUntil: this.coolingUntil(model),
          error: this.cooldownErrors.get(model),
          errorKind: observedErrorKind(this.cooldownErrors.get(model)),
        });
      }
    }

    //M 2. 依次试，任一成功就返回。
    /** 真调过的模型和各自的结果（要的那个调过才在第一个）。 */
    const tried: { model: string; error: string }[] = first?.error
      ? [{ model: input.model, error: first.error }]
      : [];
    /** 最后一个出错的结果：要的那个没调过时，全都不行就拿它回话。 */
    let last = first;
    for (const model of order) {
      /** 回退依据来自原错误或此前的冷却记录；不把 429 推断为额度用完。 */
      const error = first?.error ?? this.cooldownErrors.get(input.model);
      this.report('model.fallback', observation, {
        from: input.model,
        to: model,
        reason: first ? 'rate-limit' : 'cooldown',
        error,
        errorKind: observedErrorKind(error),
        coolingUntil: this.coolingUntil(input.model),
      });
      /** 实际模型换成这个候选，其他调用参数和顺序不变。 */
      const nextInput = { ...input, model };
      /** 这一个的结果；不在清单里（那一家没连上）就跳过。 */
      const output = await this.chatWithRetry(nextInput, observation).catch((error: unknown) => {
        this.report('model.skipped', observation, {
          model,
          reason: 'unavailable',
          error: utils.errorText(error),
        });
        return undefined;
      });
      if (!output) {
        continue;
      }
      if (!output.error) {
        /** 试过的模型 ID，加上这一个。 */
        const triedModels = [...tried.map((item) => item.model), model];
        const request = { ...output.request, fallbackFrom: input.model, tried: triedModels };
        return { ...output, request };
      }
      tried.push({ model, error: output.error });
      last = output;
    }
    //G 要的那个在冷却，备用的一个都没调成（都不在清单里）：只好还是调它。
    if (!last) {
      this.report('model.fallback', observation, {
        from: input.model,
        to: input.model,
        reason: 'no-available-fallback',
        coolingUntil: this.coolingUntil(input.model),
        error: this.cooldownErrors.get(input.model),
      });
      return this.chatWithRetry(input, observation);
    }

    //M 3. 全都不行：给一句人话，说清试了几个、哪些（用户要求“告知尝试过多少个模型”），
    //  还在冷却没再试的也写上。
    /** 是不是全都被限流了。 */
    const allLimited = tried.every((item) => isRateLimited(item.error));
    /** 试过的模型，一个一行。 */
    const list = tried.map((item) => item.model).join('、');
    /** 还在冷却、这次没再试的。 */
    const cooling = [input.model, ...candidates].filter((model) => {
      return !tried.some((item) => item.model === model) && this.coolingUntil(model) !== undefined;
    });
    /** 补一句冷却的。 */
    const coolingNote = cooling.length > 0 ? `；${cooling.join('、')} 还在限流冷却，没再试` : '';
    /** 回话用的格式：要的那个调过就用它的。 */
    const base = first ?? last;
    /** 每个试过的模型一句错误（截前 80 字）。 */
    const reasons = tried.map((item) => `${item.model}：${item.error.slice(0, 80)}`).join('；');
    /** 全被限流时的说明。 */
    const limitedText = `模型额度不够：依次试了 ${tried.length} 个模型（${list}），都被限流或额度用完了${coolingNote}。`
      + '等额度恢复，或在 config.yaml 的 engine.fallback_chain 里加能用的模型。';
    return {
      ...base,
      error: allLimited ? limitedText : `换了 ${tried.length} 个模型都没成功（${reasons}）${coolingNote}`,
      request: { ...base.request, tried: tried.map((item) => item.model) },
    };
  }
}
