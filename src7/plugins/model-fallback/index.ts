/**
 * 换模型：在 session/request 里排最后，自己调骨架的 chat(ctx, request)，把回答填进 request.answer（骨架看到有回答就不再发）。
 * 出错时：限流 → 记冷却、换备选链里下一个；上下文超长 → 换窗口更大的；别的（鉴权、参数错）→ 不换，原样抛。
 * 被限流的模型记冷却（报错里读几点恢复，读不出按分钟数，最长一天），冷却里先不撞它；每个模型、每家供应商有并发名额（Queue.ts）。
 * 同一个模型的重试在 chat() 里（pi 按 engine.retry）；限流时这里只让它再试 1 次就掐断、换下一个。
 * 前面已经有人填了回答（假模型）就不管。plugins 里要写在最后。
 * 设计：docs/src7插件设计/model-fallback.md。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as chatModule from '../../Chat.ts';
import type { ChatRequest } from '../../Chat.ts';
import type { Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as queueModule from './Queue.ts';


/** 插件名。 */
export const name = 'model-fallback';

/** 用到的服务：resources 拿配置和模型的上限。modelCatalog 是可选的（同供应商免费模型、各模型的真上限）。 */
export const inject = ['resources'];


/** model/fallback 的参数（总览第 3 节待补约定第 9 条）。reason 四种：rate-limit、cooldown、context-overflow、no-available-fallback。 */
export interface FallbackInfo {
  session: Session;
  /** 会话要的模型。 */
  from: string;
  /** 这次去试的。 */
  to: string;
  reason: string;
}


declare module 'cordis' {
  interface Events {
    /** 每换一个模型去试之前发（journal 记成 model.fallback）。 */
    'model/fallback'(info: FallbackInfo): void;
  }
}


/** 校验后的配置。 */
interface Settings {
  chain: string[];
  maxTries: number;
  siblings: boolean;
  cooldownMs: number;
  limits: queueModule.Limits;
}

/** model-catalog 里用到的。 */
interface CatalogLike {
  list(): { id: string; kind: string; contextWindow: number; price: { input: number; output: number } }[];
}

/** 限流时同一个模型最多再试几次就换下一个（用户 11-14）。 */
const RATE_LIMIT_RETRIES = 1;

/** 冷却最长一天。 */
const COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;


/** 限流、额度用完（照 0.4 Model.ts:586-588）。 */
export function isRateLimited(error: string): boolean {
  return /\b429\b|rate.?limit|频率限制|使用量已超出|额度.*(用完|不足)|quota/iu.test(error);
}

/** 上下文超长（照 0.4 Model.ts:552-554）。 */
export function isOverflow(error: string): boolean {
  return /context.?window|context.?length|maximum context|too many tokens|prompt is too long|上下文.{0,6}(超|过长|太长)/iu.test(error);
}

/** 时间单位 → 毫秒：ms/mil 毫秒，m 开头分，h 开头时，别的按秒。 */
function unitMs(unit: string): number {
  if (unit.startsWith('ms') || unit.startsWith('mil')) return 1;
  if (unit.startsWith('m')) return 60_000;
  return unit.startsWith('h') ? 3_600_000 : 1000;
}

/**
 * 报错里读几点恢复：带时区的日期时间（2026-11-07 02:20:26 UTC+8、ISO 带 +08:00），或 retry after N / try again in N 加单位。
 * @returns 毫秒；读不出是 undefined。
 */
export function resetTimeOf(error: string, now: number): number | undefined {
  const stamp = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?/iu.exec(error);
  if (stamp !== null) {
    const clock = (stamp[2] ?? '').length === 5 ? `${stamp[2] ?? ''}:00` : stamp[2] ?? '';
    const at = Date.parse(`${stamp[1] ?? ''}T${clock}${stamp[3] ?? '+'}${(stamp[4] ?? '0').padStart(2, '0')}:${stamp[5] ?? '00'}`);
    return Number.isNaN(at) ? undefined : at;
  }
  const after = /(?:retry.?after|try again in)\W{0,3}(\d+(?:\.\d+)?)\s*([a-z]*)/iu.exec(error);
  return after === null ? undefined : now + Number(after[1]) * unitMs((after[2] ?? '').toLowerCase());
}


/** 换模型。 */
class ModelFallback {
  /** 冷却表：模型 → 冷却到几点、那次的错。只在内存，重启就清（同 0.4）。 */
  private readonly cooldowns = new Map<string, { until: number; error: string }>();

  private readonly queue: queueModule.Queue;

  /**
   * @param ctx Cordis 给这个插件的 ctx。
   * @param settings 校验后的配置。
   */
  constructor(private readonly ctx: cordis.Context, private readonly settings: Settings) {
    this.queue = new queueModule.Queue(settings.limits);
    //M 听 session/request：骨架挨个问插件，这里排最后，自己调模型填 answer。
    ctx.on('session/request', (request) => this.onRequest(request));
  }

  /**
   * 主流程：先试要的（不在冷却时）；限流、超长就按顺序换着试；全都不行抛一句人话（骨架把会话记成 failed，原因就是这句）。
   * @param request 这一步的请求。
   * @throws 不是限流、不是超长的错原样抛；喊停了原样抛；全都不行抛人话。
   */
  private async onRequest(request: ChatRequest): Promise<void> {
    if (request.answer !== undefined) return;

    const asked = request.model;
    const tried: { model: string; error: string }[] = [];
    let first: string | undefined;
    if (this.cooling(asked) === undefined) {
      try {
        request.answer = await this.attempt(request, asked);
        return;
      } catch (error) {
        if (request.signal.aborted) throw error;
        first = textModule.messageOf(error);
        if (!isRateLimited(first) && !isOverflow(first)) throw error;
        tried.push({ model: asked, error: first });
      }
    }

    //M 排要试的：超长时只要窗口更大的；否则备选链 + 同供应商免费的，不在冷却的优先（全在冷却就照原顺序都试）。
    const bigger = first !== undefined && isOverflow(first);
    const list = this.candidates(asked, bigger);
    const fresh = list.filter((model) => this.cooling(model) === undefined);
    const order = bigger || fresh.length === 0 ? list : fresh;
    const reason = bigger ? 'context-overflow' : first === undefined ? 'cooldown' : 'rate-limit';
    for (const model of order) {
      this.ctx.emit('model/fallback', { session: request.session, from: asked, to: model, reason });
      try {
        request.answer = await this.attempt(request, model);
        return;
      } catch (error) {
        if (request.signal.aborted) throw error;
        tried.push({ model, error: textModule.messageOf(error) });
      }
    }

    //M 要的在冷却、备选一个都没有：还是调它（冷却记错了也不至于一个不用）。
    if (tried.length === 0) {
      this.ctx.emit('model/fallback', { session: request.session, from: asked, to: asked, reason: 'no-available-fallback' });
      request.answer = await this.attempt(request, asked);
      return;
    }
    throw new Error(this.giveUp(asked, list, tried, bigger));
  }

  /**
   * 占名额调一次模型；抛错时是限流就记冷却，再原样抛。
   * @param request 原请求。
   * @param model 这次用哪个。
   */
  private async attempt(request: ChatRequest, model: string): Promise<piAi.AssistantMessage> {
    //M 限流时 pi 的重试只留 RATE_LIMIT_RETRIES 次（用户 11-14：429 最多再试 1 次就换下一个）：听 model/failed 数这一次的限流，
    //M   数够了就掐断自己这次（另起的取消信号，跟着会话的一起断），按限流的错往外抛，onRequest 就去试下一个。别的错照 engine.retry 重试。
    const controller = new AbortController();
    const follow = (): void => controller.abort();
    request.signal.addEventListener('abort', follow, { once: true });
    let limited = 0;
    let limitError = '';
    const stopListening = this.ctx.on('model/failed', (info) => {
      if (info.session !== request.session || info.model !== model || !isRateLimited(info.error)) return;
      limited += 1;
      limitError = info.error;
      if (limited > RATE_LIMIT_RETRIES) controller.abort();
    });
    try {
      //M 调模型只有这一种写法：骨架的 chat(ctx, 请求)，换模型只换 model 和取消信号，别的照原样（pi 的重试、model/failed 通知都在里面）。
      return await this.queue.run(model, () => chatModule.chat(this.ctx, { ...request, model, signal: controller.signal }), controller.signal);
    } catch (error) {
      const cut = limited > RATE_LIMIT_RETRIES && !request.signal.aborted;
      const text = cut ? limitError : textModule.messageOf(error);
      this.noteLimit(model, text);
      throw cut ? new Error(text) : error;
    } finally {
      stopListening();
      request.signal.removeEventListener('abort', follow);
    }
  }

  /** 冷却到几点；过了的顺手删掉；不在冷却是 undefined。 */
  private cooling(model: string): number | undefined {
    const entry = this.cooldowns.get(model);
    if (entry === undefined) return undefined;
    if (entry.until > Date.now()) return entry.until;
    this.cooldowns.delete(model);
    return undefined;
  }

  /** 是限流才记冷却；原来不在冷却就发 model/cooldown（model-catalog、journal 听）。 */
  private noteLimit(model: string, error: string): void {
    if (!isRateLimited(error)) return;

    const now = Date.now();
    const reset = resetTimeOf(error, now);
    const until = Math.min(reset !== undefined && reset > now ? reset : now + this.settings.cooldownMs, now + COOLDOWN_MAX_MS);
    const wasCooling = this.cooling(model) !== undefined;
    this.cooldowns.set(model, { until, error });
    if (wasCooling) return;

    this.ctx.emit('model/cooldown', { model, until, reason: error.slice(0, 200) });
    //T 跟踪：记了冷却。
    this.ctx.emit('trace', 'ModelFallback.noteLimit', '模型被限流，记冷却', 'cooldowns.set(model, until)', { 模型: model, 到几点: new Date(until).toLocaleString() });
  }

  /**
   * 要试的模型：bigger 为假时是备选链 + 同供应商价格为 0 的；为真时只要上限比要的大的，大的在前。都去重、去掉要的、最多 maxTries 个。
   * @param asked 会话要的。
   * @param bigger 要不要大窗口的。
   */
  private candidates(asked: string, bigger: boolean): string[] {
    const { chain, maxTries, siblings } = this.settings;
    if (chain.length === 0) return [];

    //M model-catalog 是可选的（ctx.get 现取）：有就能找同供应商免费的、比上限；没有就只看备选链，上限用 providers 里手写的。
    const catalog = this.ctx.get('modelCatalog') as CatalogLike | undefined;
    const models = catalog?.list() ?? [];
    const provider = asked.split('/')[0];
    const free = siblings
      ? models.filter((item) => item.kind === 'chat' && item.id.split('/')[0] === provider && item.price.input === 0 && item.price.output === 0).map((item) => item.id)
      : [];
    const unique = [...new Set([...chain, ...free])].filter((model) => model !== asked);
    if (!bigger) return unique.slice(0, Math.max(0, maxTries));

    const windowOf = (model: string): number => {
      const listed = models.find((item) => item.id === model)?.contextWindow;
      if (listed !== undefined && listed > 0) return listed;
      try {
        return this.ctx.resources.modelOf(model).contextWindow;
      } catch {
        return 0;
      }
    };
    const current = windowOf(asked);
    return unique.filter((model) => windowOf(model) > current).sort((left, right) => windowOf(right) - windowOf(left)).slice(0, Math.max(0, maxTries));
  }

  /** 全都不行的人话（照抄 0.4 原文，Model.ts:1661-1665、:1765-1786）。 */
  private giveUp(asked: string, list: string[], tried: { model: string; error: string }[], bigger: boolean): string {
    const names = tried.map((item) => item.model).join('、');
    if (bigger) return `上下文太长：依次试了 ${String(tried.length)} 个模型（${names}），都装不下。这个会话聊得太久了，开个新会话再说。`;

    const cooling = [asked, ...list].filter((model) => !tried.some((item) => item.model === model) && this.cooling(model) !== undefined);
    const coolingNote = cooling.length > 0 ? `；${cooling.join('、')} 还在限流冷却，没再试` : '';
    if (tried.every((item) => isRateLimited(item.error))) {
      return `模型额度不够：依次试了 ${String(tried.length)} 个模型（${names}），都被限流或额度用完了${coolingNote}。`
        + '等额度恢复，或在 config.yaml 的 engine.fallback_chain 里加能用的模型。';
    }
    const reasons = tried.map((item) => `${item.model}：${item.error.slice(0, 80)}`).join('；');
    return `换了 ${String(tried.length)} 个模型都没成功（${reasons}）${coolingNote}`;
  }
}


/**
 * 读顶层 engine、concurrency 段（键照 config.example.yaml），校验一次。
 * @throws 写错了抛错（插件不挂，打一行原因）。
 */
function readSettings(ctx: cordis.Context): Settings {
  const engine = (ctx.resources.raw['engine'] ?? {}) as Record<string, unknown>;
  const concurrency = (ctx.resources.raw['concurrency'] ?? {}) as Record<string, unknown>;
  const positive = (value: unknown, label: string, fallback: number, allowZero = false): number => {
    const result = value ?? fallback;
    if (typeof result !== 'number' || !Number.isInteger(result) || result < (allowZero ? 0 : 1)) throw new Error(`${label} 要是${allowZero ? '不小于 0' : '正'}整数`);
    return result;
  };
  const table = (value: unknown, label: string): Record<string, number> => {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 要写成 { 名字: 正整数 }`);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, positive(item, `${label}.${key}`, 1)]));
  };

  const rawChain = engine['fallback_chain'] ?? [ctx.resources.config.defaultModel];
  if (!Array.isArray(rawChain) || rawChain.some((item) => typeof item !== 'string')) throw new Error('engine.fallback_chain 要是模型名的列表');
  const siblings = engine['fallback_include_siblings'] ?? true;
  if (typeof siblings !== 'boolean') throw new Error('engine.fallback_include_siblings 要是 true 或 false');
  const minutes = engine['rate_limit_cooldown_minutes'] ?? 5;
  if (typeof minutes !== 'number' || minutes < 0) throw new Error('engine.rate_limit_cooldown_minutes 要是不小于 0 的数');

  return {
    chain: (rawChain as string[]).filter((item) => item !== 'off' && item !== ''),
    maxTries: positive(engine['fallback_max_tries'], 'engine.fallback_max_tries', 5, true),
    siblings,
    cooldownMs: minutes * 60_000,
    limits: {
      perModel: positive(concurrency['default'], 'concurrency.default', 3),
      models: table(concurrency['models'], 'concurrency.models'),
      providers: table(concurrency['providers'], 'concurrency.providers'),
    },
  };
}


/**
 * 挂上换模型。
 * apply 是 Cordis 插件的入口：inject 里的 resources 就绪后 Cordis 调一次。插件自己没有配置段。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new ModelFallback(ctx, readSettings(ctx));
}
