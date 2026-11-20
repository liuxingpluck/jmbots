/**
 * 换模型与限流回退（原 plugins/model-fallback，已并入 model-catalog）：
 * 在 session/before-model 里排最后，自己调骨架的 ctx.sessions.chat(request)，把回答填进 request.answer（骨架看到有回答就不再发）。
 * 出错时：限流 → 记冷却、换备用模型；上下文超长 → 换窗口更大的；上游明确找不到服务 → 走备用链。
 * 被限流的模型记冷却（报错里读几点恢复，读不出按分钟数，最长一天），冷却里先不撞它；每个模型、每家供应商有并发名额（Queue.ts）。
 * 同一个模型的重试在 Sessions.chat() 里（pi 按 models.retry）；限流时这里只让它再试 1 次就掐断、换下一个。
 * 前面已经有人填了回答（假模型）就不管。plugins 里要排在所有改写请求和 fake-model 后面（一般放最后）。
 * 设计：docs/src7插件设计/model-fallback.md。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import type { ModelCatalog } from './index.ts';
import * as queueModule from './Queue.ts';


/** 可换备用模型的三种故障。 */
type RetryableReason = 'rate-limit' | 'context-overflow' | 'upstream-unavailable';

/** model-catalog/fallback 的参数。 */
export interface FallbackInfo {
  /** 发生切换的会话实例。 */
  session: Session;
  /** 上一次尝试的模型，或首试前仍在冷却的模型。 */
  from: string;
  /** 这次去试的模型。 */
  to: string;
  /** 切换原因。 */
  reason: RetryableReason | 'cooldown' | 'fallback-failed' | 'no-available-fallback';
}

/** 回退子配置：写在 plugins[model-catalog].config.fallback 下，写 false 或 enabled: false 可关闭；并发仍可沿用顶层 concurrency。 */
export interface FallbackConfig {
  /** 是否开启换模型与排队，默认 true。 */
  enabled?: boolean;
  /** 备选模型链（供应商名/模型 ID 列表），默认 [default_model]。 */
  chain?: string[];
  /** 最多尝试备选个数（不含原模型），默认 5。 */
  max_tries?: number;
  /** 是否自动补充同供应商标价为 0 的对话模型，默认 true。 */
  include_siblings?: boolean;
  /** 未从报错读出恢复时刻时的冷却分钟数，默认 5。 */
  cooldown_minutes?: number;
  /** 并发上限覆盖；缺省读顶层 concurrency 段。 */
  concurrency?: {
    default?: number;
    models?: Record<string, number>;
    providers?: Record<string, number>;
  };
}

/** 校验后的回退配置。 */
export interface FallbackSettings {
  /** 是否启用。 */
  enabled: boolean;
  /** 生效后的备选模型链。 */
  chain: string[];
  /** 最多候选数。 */
  maxTries: number;
  /** 是否补同供应商零价对话模型。 */
  siblings: boolean;
  /** 冷却毫秒。 */
  cooldownMs: number;
  /** 队列并发配置。 */
  limits: queueModule.Limits;
}


declare module 'cordis' {
  interface Events {
    /**
     * 每换一个模型去试之前发（journal 记成 model.fallback）。
     * 谁发：src7/plugins/model-catalog/Fallback.ts 的 ModelFallback.onRequest
     * 谁接：暂无
     */
    'model-catalog/fallback'(info: FallbackInfo): void;
  }
}


/** 限流时同一个模型最多再试几次就换下一个（用户 11-14）。 */
const RATE_LIMIT_RETRIES = 1;

/** 冷却最长一天。 */
const COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;


/**
 * 判断报错是不是限流、额度用完。
 * @param error 报错原文。
 * @returns 属于限流或额度耗尽错误时返回 true，否则返回 false。
 */
export function isRateLimited(error: string): boolean {
  return /\b429\b|rate.?limit|频率限制|使用量已超出|额度.*(用完|不足)|quota/iu.test(error);
}

/**
 * 判断报错是不是上下文超长。
 * @param error 报错原文。
 * @returns 属于上下文超限错误时返回 true，否则返回 false。
 */
export function isOverflow(error: string): boolean {
  return /context.?window|context.?length|maximum context|too many tokens|prompt is too long|上下文.{0,6}(超|过长|太长)/iu.test(error);
}

/** 取 SDK 错误开头的 HTTP 4xx 状态码。 */
function getClientErrorStatus(error: string): string | undefined {
  return /^(?:HTTP\s+)?(4\d{2})\b/iu.exec(error.trimStart())?.[1];
}

/** 从错误原文识别可换模的故障。上游路由错误只认 400 与网关的服务缺失文案。 */
function getFallbackReason(error: string): RetryableReason | undefined {
  const status = getClientErrorStatus(error);

  //G 鉴权响应即使带额度或服务名，也按原错返回。
  if (status === '401' || status === '403') return undefined;

  const serviceMissing = /服务信息找不到|\bservice info(?:rmation)? (?:was )?not found\b/iu.test(error);
  if (status === '400' && serviceMissing) return 'upstream-unavailable';

  if (isOverflow(error)) return 'context-overflow';
  if (isRateLimited(error)) return 'rate-limit';

  return undefined;
}

/** 时间单位 → 毫秒：ms/mil 毫秒，m 开头分，h 开头时，别的按秒。 */
function unitMs(unit: string): number {
  if (unit.startsWith('ms') || unit.startsWith('mil')) return 1;

  if (unit.startsWith('m')) return 60_000;

  if (unit.startsWith('h')) return 3_600_000;

  return 1000;
}

/**
 * 从报错里读几点恢复：带时区的日期时间（2026-11-07 02:20:26 UTC+8、ISO 带 +08:00），或 retry after N / try again in N 加单位。
 * @param error 报错原文。
 * @param now 当前毫秒时间戳。
 * @returns 恢复时刻毫秒；读不出是 undefined。
 */
export function getResetTime(error: string, now: number): number | undefined {
  const stamp = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?/iu.exec(error);
  if (stamp !== null) {
    let clock = stamp[2] ?? '';
    if (clock.length === 5) {
      clock = `${clock}:00`;
    }
    const at = Date.parse(`${stamp[1] ?? ''}T${clock}${stamp[3] ?? '+'}${(stamp[4] ?? '0').padStart(2, '0')}:${stamp[5] ?? '00'}`);
    if (Number.isNaN(at)) return undefined;

    return at;
  }

  const after = /(?:retry.?after|try again in)\W{0,3}(\d+(?:\.\d+)?)\s*([a-z]*)/iu.exec(error);
  if (after === null) return undefined;

  //M 将匹配出的等待数值按时间单位换算成毫秒，加上当前时间得出恢复时间戳。
  return now + Number(after[1]) * unitMs((after[2] ?? '').toLowerCase());
}


/** 换模型处理器：挂载 session/before-model，并按失败原因与冷却状态选择备用模型。 */
export class ModelFallback {
  /** 冷却表：模型 → 冷却到几点、那次的错。只在内存，重启就清。 */
  private readonly cooldowns = new Map<string, { until: number; error: string }>();

  private readonly queue: queueModule.Queue;

  /**
   * 构造并发队列与请求监听。
   * @param ctx Cordis 给 model-catalog 的上下文。
   * @param settings 校验后的回退配置。
   * @param catalog 同插件的模型清单服务实例（可选，便于单测单独构造 ModelFallback）。
   * 副作用：向 ctx 挂载 session/before-model 事件监听。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly settings: FallbackSettings,
    private readonly catalog?: ModelCatalog,
  ) {
    //M 按校验后的并发上限建队列，限制各模型及供应商的同时在途请求数。
    this.queue = new queueModule.Queue(settings.limits);
    //M 听 session/before-model：骨架挨个问插件，这里排最后，自己调模型填 answer。
    ctx.on('session/before-model', (request) => this.onRequest(request));
  }

  /**
   * 主流程：原模型未冷却就先试它，再按失败原因决定是否尝试备用模型。
   * @param request 这一步的请求。
   * @throws 取消或无法回退的错原样抛。备选用完时汇总尝试记录。
   */
  private async onRequest(request: ChatRequest): Promise<void> {
    if (request.answer !== undefined) return;

    const asked = request.model;
    const tried: { model: string; error: string; reason?: RetryableReason }[] = [];
    let from = asked;
    let reason: FallbackInfo['reason'] = 'cooldown';
    //M 先查请求指定的模型是否不在冷却期，不在则优先直接试它。
    if (this.cooling(asked) === undefined) {
      try {
        //M 占并发名额并带着单次限流熔断信号发起请求，成功即填回 request.answer。
        request.answer = await this.attempt(request, asked);
        return;
      } catch (error) {
        if (request.signal.aborted) {
          throw error;
        }
        //G 只对明确可回退的错误继续尝试。
        const detail = textModule.getErrorMessage(error);
        const failure = getFallbackReason(detail);
        if (failure === undefined) {
          throw error;
        }
        reason = failure;
        tried.push({ model: asked, error: detail, reason: failure });
      }
    }

    //M 排要试的：超长时只要窗口更大的；否则备选链 + 同供应商免费的，不在冷却的优先（全在冷却就照原顺序都试）。
    const bigger = reason === 'context-overflow';
    const list = this.candidates(asked, bigger);
    const fresh = list.filter((model) => this.cooling(model) === undefined);
    let order = fresh;
    if (bigger || fresh.length === 0) {
      order = list;
    }

    for (const model of order) {
      const change: FallbackInfo = { session: request.session, from, to: model, reason };

      //M 每次切换记录实际离开的模型，让连续换模的顺序能串起来。
      this.ctx.emit('model-catalog/fallback', change);
      try {
        //M 依次尝试排序后的备选模型，拿到结果立即回填 request.answer 并结束本轮。
        request.answer = await this.attempt(request, model);
        return;
      } catch (error) {
        if (request.signal.aborted) {
          throw error;
        }
        //G 备用模型遇到参数或鉴权错误也直接停，避免继续发送会话。
        const detail = textModule.getErrorMessage(error);
        const failure = getFallbackReason(detail);
        const status = getClientErrorStatus(detail);
        if (failure === undefined && (status === '400' || status === '401' || status === '403')) {
          throw error;
        }
        tried.push({ model, error: detail, reason: failure });
        from = model;
        reason = failure ?? 'fallback-failed';
      }
    }

    //M 要的在冷却、备选一个都没有：还是调它（冷却记错了也不至于一个不用）。
    if (tried.length === 0) {
      this.ctx.emit('model-catalog/fallback', { session: request.session, from: asked, to: asked, reason: 'no-available-fallback' });
      request.answer = await this.attempt(request, asked);
      return;
    }
    //G 所有备选模型都尝试失败，汇总失败原因与仍在冷却的模型信息抛出。
    throw new Error(this.giveUp(asked, list, tried));
  }

  /**
   * 占名额调一次模型；抛错时是限流就记冷却，再原样抛。
   * @param request 原请求。
   * @param model 这次用哪个。
   * @returns 重发后得到的 AssistantMessage，content 是回答内容块，usage 是用量，stopReason 说明如何结束。
   */
  private async attempt(request: ChatRequest, model: string): Promise<piAi.AssistantMessage> {
    //M 限流时 pi 的重试只留 RATE_LIMIT_RETRIES 次（用户 11-14：429 最多再试 1 次就换下一个）：听 session/model-failed 数这一次的限流，
    //M   数够了就掐断自己这次（另起的取消信号，跟着会话的一起断），按限流的错往外抛，onRequest 就去试下一个。别的错照 models.retry 重试。
    const controller = new AbortController();
    const follow = (): void => controller.abort();
    request.signal.addEventListener('abort', follow, { once: true });
    let limited = 0;
    let limitError = '';
    const stopListening = this.ctx.on('session/model-failed', (info) => {
      if (info.session !== request.session || info.model !== model) return;

      const failure = getFallbackReason(info.error);
      if (failure !== 'rate-limit') return;

      limited += 1;
      limitError = info.error;
      if (limited > RATE_LIMIT_RETRIES) {
        controller.abort();
      }
    });

    try {
      //M 调模型只有这一种写法：骨架的 ctx.sessions.chat(请求)，换模型只换 model 和取消信号，别的照原样（pi 的重试、session/model-failed 通知都在里面）。
      const asked: ChatRequest = {
        ...request,
        model,
        signal: controller.signal,
      };

      //M 占上这个模型的并发名额再发（Queue.ts）；名额等不到、或者被掐断，都跟着 controller 的信号停。
      const send = (): Promise<piAi.AssistantMessage> => this.ctx.sessions.chat(asked);
      return await this.queue.run(model, send, controller.signal);
    } catch (error) {
      const cut = limited > RATE_LIMIT_RETRIES && !request.signal.aborted;
      let text = textModule.getErrorMessage(error);
      if (cut) {
        text = limitError;
      }
      //M 报错若是限流则登记该模型冷却期并通知外部，随后按是否熔断决定向外抛哪个错误。
      this.noteLimit(model, text);
      if (cut) {
        //G 保留熔断前的原异常，外层仍按限流原因回退。
        const options = { cause: error };
        throw new Error(text, options);
      }
      throw error;
    } finally {
      stopListening();
      request.signal.removeEventListener('abort', follow);
    }
  }

  /** 冷却到几点；过了的顺手删掉；不在冷却是 undefined。 */
  private cooling(model: string): number | undefined {
    //M 从冷却表查询该模型截止时间，尚未过期则返回时间戳，过期就清理掉。
    const entry = this.cooldowns.get(model);
    if (entry === undefined) return undefined;

    if (entry.until > Date.now()) return entry.until;

    this.cooldowns.delete(model);
    return undefined;
  }

  /** 是限流才记冷却；原来不在冷却就发 model-catalog/cooldown（ModelCatalog、journal 听）。 */
  private noteLimit(model: string, error: string): void {
    //G 仅限流或额度耗尽错误才记入冷却，其余异常直接跳过。
    if (getFallbackReason(error) !== 'rate-limit') return;

    //M 从报错里解析重置时刻，读不出时采用默认冷却时长，并限制最长不超过一天。
    const now = Date.now();
    const reset = getResetTime(error, now);
    let targetUntil = now + this.settings.cooldownMs;
    if (reset !== undefined && reset > now) {
      targetUntil = reset;
    }
    const until = Math.min(targetUntil, now + COOLDOWN_MAX_MS);
    //M 判断模型此前是否已在冷却中并写入新截止时刻，首次进入冷却才广播事件。
    const wasCooling = this.cooling(model) !== undefined;
    this.cooldowns.set(model, { until, error });
    if (wasCooling) return;

    this.ctx.emit('model-catalog/cooldown', { model, until, reason: error.slice(0, 200) });
    //T 跟踪：记了冷却。
    const traceVars = { model: model, until: new Date(until).toLocaleString() };
    this.ctx.emit('trace', 'ModelFallback.noteLimit', 'trace.modelCatalog.rateLimited', 'cooldowns.set(model, until)', traceVars);
  }

  /**
   * 要试的模型：bigger 为假时是备选链 + 同供应商价格为 0 的；为真时只要上限比要的大的，大的在前。都去重、去掉要的、最多 maxTries 个。
   * @param asked 会话要的。
   * @param bigger 要不要大窗口的。
   */
  private candidates(asked: string, bigger: boolean): string[] {
    const { chain, maxTries, siblings } = this.settings;
    if (chain.length === 0) return [];

    //M ModelCatalog 同插件优先直接读，也支持外部注入或未挂载时只用备选链和手写上限。
    const activeCatalog = this.catalog ?? (this.ctx.get('modelCatalog') as ModelCatalog | undefined);
    const models = activeCatalog?.list() ?? [];
    const provider = asked.split('/')[0];
    let free: string[] = [];
    if (siblings) {
      free = models
        .filter((item) => item.kind === 'chat' && item.id.split('/')[0] === provider && item.price.input === 0 && item.price.output === 0)
        .map((item) => item.id);
    }
    const unique = [...new Set([...chain, ...free])].filter((model) => model !== asked);
    if (!bigger) return unique.slice(0, Math.max(0, maxTries));

    const getWindow = (model: string): number => {
      //M 优先读模型清单缓存里的上下文窗口大小，能省掉查骨架配置。
      const listed = models.find((item) => item.id === model)?.contextWindow;
      if (listed !== undefined && listed > 0) return listed;

      try {
        //M 清单中缺省或为 0 时，回退向骨架资源表查询该模型配置的上下文窗口大小。
        return this.ctx.resources.getModel(model).contextWindow;
      } catch {
        return 0;
      }
    };
    //M 以当前模型窗口为门槛筛选更大窗口的备选模型，按窗口从大到小排序并截断。
    const current = getWindow(asked);
    return unique
      .filter((model) => getWindow(model) > current)
      .sort((left, right) => getWindow(right) - getWindow(left))
      .slice(0, Math.max(0, maxTries));
  }

  /** 把所有候选模型均调用失败的原因写成提示。 */
  private giveUp(asked: string, list: string[], tried: { model: string; error: string; reason?: RetryableReason }[]): string {
    const names = tried.map((item) => item.model).join('、');
    if (tried.every((item) => item.reason === 'context-overflow')) {
      return `上下文太长：依次试了 ${String(tried.length)} 个模型（${names}），都装不下。这个会话聊得太久了，开个新会话再说。`;
    }

    //M 收集因仍在冷却期而跳过的模型名，附进最终报错提示里方便排查。
    const cooling = [asked, ...list].filter((model) => !tried.some((item) => item.model === model) && this.cooling(model) !== undefined);
    let coolingNote = '';
    if (cooling.length > 0) {
      coolingNote = `；${cooling.join('、')} 还在限流冷却，没再试`;
    }
    //G 检查已尝试的模型是否全因限流失败，若是则返回明确的额度不足提示。
    if (tried.every((item) => item.reason === 'rate-limit')) {
      return `模型额度不够：依次试了 ${String(tried.length)} 个模型（${names}），都被限流或额度用完了${coolingNote}。`
        + '等额度恢复，或在模型库插件的 fallback.chain 里加能用的模型。';
    }
    const reasons = tried.map((item) => `${item.model}：${item.error.slice(0, 80)}`).join('；');
    return `换了 ${String(tried.length)} 个模型都没成功（${reasons}）${coolingNote}`;
  }
}


/** 读整数开关/正数，错误带上清晰配置路径。 */
function readPositiveInt(value: unknown, label: string, fallback: number, allowZero = false): number {
  const result = value ?? fallback;
  let minAllowed = 1;
  let minLabel = '正';
  if (allowZero) {
    minAllowed = 0;
    minLabel = '不小于 0 ';
  }
  if (typeof result !== 'number' || !Number.isInteger(result) || result < minAllowed) {
    throw new Error(`${label} 要是${minLabel}整数`);
  }
  return result;
}

/** 读模型/供应商并发字典，缺失/null 交回 {}。 */
function readLimitTable(value: unknown, label: string): Record<string, number> {
  if (value === undefined || value === null) return {};

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 要写成 { 名字: 正整数 }`);
  }
  const table: Record<string, number> = {};
  //M 逐条校验字典里的模型或供应商并发上限为正整数，存入最终映射表。
  utils.eachEntry(value as Record<string, unknown>, (key, item) => {
    table[key] = readPositiveInt(item, `${label}.${key}`, 1);
  });
  return table;
}


/**
 * 读取并校验 plugins[model-catalog].config.fallback，并发可沿用顶层 concurrency。
 * @param ctx Cordis 上下文（含 resources）。
 * @param rawConfig plugins[model-catalog].config 原值。
 * @returns 校验并合并默认值后的回退与并发上限配置。
 * @throws 配置形状、类型或正整数不合法时抛错。
 */
export function readFallbackSettings(ctx: cordis.Context, rawConfig: unknown): FallbackSettings {
  if (rawConfig !== undefined && rawConfig !== null && (typeof rawConfig !== 'object' || Array.isArray(rawConfig))) {
    throw new Error('model-catalog 的 config 要写成对象');
  }

  const configRecord = (rawConfig ?? {}) as Record<string, unknown>;
  const rawFallback = configRecord['fallback'];
  if (rawFallback === false) {
    return {
      enabled: false,
      chain: [],
      maxTries: 0,
      siblings: false,
      cooldownMs: 0,
      limits: { perModel: 1, models: {}, providers: {} },
    };
  }
  if (rawFallback !== undefined && rawFallback !== null && (typeof rawFallback !== 'object' || Array.isArray(rawFallback))) {
    throw new Error('model-catalog.fallback 要写成对象或 false');
  }

  const sub = (rawFallback ?? {}) as Record<string, unknown>;
  let enabled = true;
  if (sub['enabled'] !== undefined) {
    if (typeof sub['enabled'] !== 'boolean') {
      throw new Error('model-catalog.fallback.enabled 要写 true 或 false');
    }
    enabled = sub['enabled'];
  }

  const concurrency = (ctx.resources.raw['concurrency'] ?? {}) as Record<string, unknown>;

  //M 未配回退链时用默认模型，保留显式空链。
  const chainLabel = 'plugins[model-catalog].config.fallback.chain';
  let chain = sub['chain'];
  if (chain === undefined) {
    chain = [ctx.resources.config.defaultModel];
  }
  if (!Array.isArray(chain) || chain.some((item) => typeof item !== 'string')) {
    throw new Error(`${chainLabel} 要是模型名的列表`);
  }

  //M 同供应商的免费候选默认启用，必须能保留显式 false。
  const siblingsLabel = 'plugins[model-catalog].config.fallback.include_siblings';
  const siblingValue = sub['include_siblings'];
  let siblings = true;
  if (siblingValue !== undefined) {
    if (typeof siblingValue !== 'boolean') throw new Error(`${siblingsLabel} 要是 true 或 false`);

    siblings = siblingValue;
  }

  //M 默认只把限流模型冷却五分钟，显式 0 则不用默认冷却。
  const minutesLabel = 'plugins[model-catalog].config.fallback.cooldown_minutes';
  const cooldown = sub['cooldown_minutes'];
  let minutes = 5;
  if (cooldown !== undefined) {
    if (typeof cooldown !== 'number' || !Number.isFinite(cooldown) || cooldown < 0) {
      throw new Error(`${minutesLabel} 要是不小于 0 的数`);
    }
    minutes = cooldown;
  }

  //M 回退尝试上限只算备选，和同一模型的重试次数分开。
  const maxTriesLabel = 'plugins[model-catalog].config.fallback.max_tries';
  const rawMaxTries = sub['max_tries'];

  const rawSubConcurrency = sub['concurrency'];
  if (rawSubConcurrency !== undefined && rawSubConcurrency !== null && (typeof rawSubConcurrency !== 'object' || Array.isArray(rawSubConcurrency))) {
    throw new Error('model-catalog.fallback.concurrency 要写成对象');
  }
  const subConcurrency = (rawSubConcurrency ?? {}) as Record<string, unknown>;

  const rawPerModel = subConcurrency['default'] ?? concurrency['default'];
  let perModelLabel = 'concurrency.default';
  if (subConcurrency['default'] !== undefined) {
    perModelLabel = 'model-catalog.fallback.concurrency.default';
  }

  const rawModelsLimit = subConcurrency['models'] ?? concurrency['models'];
  let modelsLimitLabel = 'concurrency.models';
  if (subConcurrency['models'] !== undefined) {
    modelsLimitLabel = 'model-catalog.fallback.concurrency.models';
  }

  const rawProvidersLimit = subConcurrency['providers'] ?? concurrency['providers'];
  let providersLimitLabel = 'concurrency.providers';
  if (subConcurrency['providers'] !== undefined) {
    providersLimitLabel = 'model-catalog.fallback.concurrency.providers';
  }

  //M 过滤无效备选名并校验尝试次数与各项并发上限，组装最终回退配置对象。
  return {
    enabled,
    chain: (chain as string[]).filter((item) => item !== 'off' && item !== ''),
    maxTries: readPositiveInt(rawMaxTries, maxTriesLabel, 5, true),
    siblings,
    cooldownMs: minutes * 60_000,
    limits: {
      perModel: readPositiveInt(rawPerModel, perModelLabel, 3),
      models: readLimitTable(rawModelsLimit, modelsLimitLabel),
      providers: readLimitTable(rawProvidersLimit, providersLimitLabel),
    },
  };
}
