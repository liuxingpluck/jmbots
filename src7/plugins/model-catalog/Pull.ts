/**
 * 拉一家供应商的模型清单（GET <base_url>/models），和 config.yaml 里手写的合成一张表。
 * 只有函数，不建 class；index.ts 调它们。
 * 密钥只放进请求头，不进返回、不进报错。
 */


/** 一个模型交出去的样子。照网页 web/src/Api.ts:653-670，多两项缓存价和 limitedUntil。 */
export interface ModelInfo {
  /** 供应商名/模型 ID。 */
  id: string;
  /** 显示名：手写的 name > 清单的 display_name > ID。 */
  name: string;
  /** 常规对话模型是 chat，决策模型是 decision。 */
  kind: 'chat' | 'decision';
  /** 上下文多长（token）。 */
  contextWindow: number;
  /** 缺少登记值时，contextWindow 是目录给出的估算值。 */
  contextWindowEstimated?: true;
  /** 最多输出多少（token）；决策模型没有。 */
  maxOutputTokens?: number;
  /** 支持的思考档，从低到高；一个都没有是 ['off']；决策模型是 []。 */
  thinking: string[];
  /** 能不能看图。 */
  vision?: boolean;
  /** 价格，美元每百万 token；0 是没标价，不等于免费。 */
  price: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** 冷却到几点（毫秒）；没在冷却没有这项。 */
  limitedUntil?: number;
}


/** config.yaml 里手写的一个模型（apply 校验过）。键照 config.example.yaml:19。 */
export interface WrittenModel {
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  vision?: boolean;
  thinking?: string[];
  price?: { input?: number; output?: number };
}


/** 清单里的一项：各家字段不一样，都可能没有。 */
interface ListEntry {
  id: string;
  kind?: string;
  display_name?: string;
  context_window?: number;
  context_length?: number;
  max_output_tokens?: number;
  top_provider?: { max_completion_tokens?: number };
  supported_reasoning_levels?: { effort: string }[];
  modalities?: { input?: string[] };
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}


/** 思考档，从低到高。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 拉清单最多等多久，毫秒。 */
const LIST_TIMEOUT_MS = 15_000;

/** 清单没给、也没手写时的保守值。 */
const UNKNOWN_CONTEXT_WINDOW = 128_000;
const UNKNOWN_MAX_OUTPUT = 8192;

/** 只给 ID 的清单里，名字像这些的不是对话模型，不收。 */
const NON_CHAT_MODEL = /embed|whisper|tts|transcri|dall-e|moderation|rerank|image/iu;


/**
 * GET <baseUrl>/models，交回 data 数组。
 * @param baseUrl 地址，末尾不带斜杠。
 * @param apiKey 密钥；空串时请求头写 no-key。
 * @returns 清单里的每一项（没有 id 的丢掉）。
 * @throws 不是 200 抛 `HTTP <码>`；超时、连不上抛网络错误（不带请求头）；回的不是清单形状也抛。
 * 副作用：发一个请求。
 */
export async function fetchList(baseUrl: string, apiKey: string): Promise<ListEntry[]> {
  let key = apiKey;
  if (key === '') {
    key = 'no-key';
  }
  //M x-magpie-deciders 是 magpie 列出决策模型用的，别家不认会忽略。
  const headers = { authorization: `Bearer ${key}`, 'x-api-key': key, 'x-magpie-deciders': '1' };
  const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);

  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error('回的不是模型清单（没有 data 数组）');
  return (body.data as ListEntry[]).filter((entry) => typeof entry?.id === 'string' && entry.id !== '');
}


/**
 * 美元每 token 的价格字符串换成美元每百万 token；没有价格记 0。
 * @param price 如 "0.000002"。
 */
function perMillion(price: string | undefined): number {
  const value = Number(price);
  if (price !== undefined && Number.isFinite(value)) return value * 1_000_000;

  return 0;
}


/**
 * 清单和手写的合成一张表：手写的优先，清单的其次，都没有用保守值。
 * @param provider 供应商名（拼进 id）。
 * @param entries 清单；没拉到就是 []。
 * @param written 手写的模型：模型 ID → 参数。
 * @returns 这家的模型，照清单的先后，手写多出来的排后面；还有用了保守值的个数（给跟踪）。
 */
export function merge(
  provider: string,
  entries: ListEntry[],
  written: Record<string, WrittenModel>,
): { models: ModelInfo[]; guessed: number } {
  //M 清单带不带参数：带参数的（magpie、OpenRouter）缺参数就不是对话模型；只给 ID 的按名字筛。
  const detailed = entries.some((entry) => (entry.context_window ?? entry.context_length) !== undefined);
  const listed = new Set(entries.map((entry) => entry.id));
  const extra = Object.keys(written).filter((id) => !listed.has(id)).map((id): ListEntry => ({ id }));
  const models: ModelInfo[] = [];
  let guessed = 0;

  for (const entry of [...entries, ...extra]) {
    const own = written[entry.id];
    const name = own?.name ?? entry.display_name ?? entry.id;
    const id = `${provider}/${entry.id}`;
    if (entry.kind === 'decision') {
      models.push({ id, name, kind: 'decision', contextWindow: entry.context_window ?? 0, thinking: [], vision: false, price: { input: 0, output: 0 } });
      continue;
    }

    const listedWindow = entry.context_window ?? entry.context_length;
    const declaredWindow = own?.context_window ?? listedWindow;
    const listedOutput = entry.max_output_tokens ?? entry.top_provider?.max_completion_tokens;
    let listedMissing = NON_CHAT_MODEL.test(entry.id);
    if (detailed) {
      listedMissing = !listedWindow || !listedOutput;
    }
    if (own === undefined && listedMissing) continue;
    if (!declaredWindow || !(own?.max_output_tokens ?? listedOutput)) guessed += 1;

    //M 思考档：none、off 都算 off；按 off…max 的顺序留支持的；一个都没有就只列 off（用模型自己的默认）。
    const efforts = (own?.thinking ?? (entry.supported_reasoning_levels ?? []).map((level) => level.effort))
      .map((level) => {
        if (level === 'none') return 'off';

        return level;
      });
    const thinking = THINKING_LEVELS.filter((level) => efforts.includes(level));
    const inputs = entry.modalities?.input ?? entry.architecture?.input_modalities ?? [];

    //M 整理价格（手写价已是美元每百万 token，清单里的字符串是每 token 需折算）：先取输入输出价。
    const price: ModelInfo['price'] = {
      input: own?.price?.input ?? perMillion(entry.pricing?.prompt),
      output: own?.price?.output ?? perMillion(entry.pricing?.completion),
    };
    //M 清单附带缓存读写报价时一并折算补进 price，供计费与展示使用。
    if (entry.pricing?.input_cache_read !== undefined) price.cacheRead = perMillion(entry.pricing.input_cache_read);
    if (entry.pricing?.input_cache_write !== undefined) price.cacheWrite = perMillion(entry.pricing.input_cache_write);

    let resolvedThinking = thinking;
    if (resolvedThinking.length === 0) {
      resolvedThinking = ['off'];
    }
    const model: ModelInfo = {
      id,
      name,
      kind: 'chat',
      contextWindow: declaredWindow ?? UNKNOWN_CONTEXT_WINDOW,
      maxOutputTokens: own?.max_output_tokens ?? listedOutput ?? UNKNOWN_MAX_OUTPUT,
      thinking: resolvedThinking,
      vision: own?.vision ?? inputs.includes('image'),
      price,
    };
    //M 保留估算值供裁剪使用，同时让依赖真实窗口的功能识别缺少登记。
    if (declaredWindow === undefined) {
      model.contextWindowEstimated = true;
    }
    models.push(model);
  }
  return { models, guessed };
}
