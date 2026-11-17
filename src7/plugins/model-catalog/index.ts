/**
 * 模型清单：起来就向 providers 里每一家拉 <base_url>/models，和手写的合成一张模型表，给网页看、给别的插件查。
 * 一家拉不到不挡别家、不挡起服务：先用它手写的模型，每 60 秒再试，连上就换。
 * 只是一张表：src7 调模型用骨架的 ctx.resources.modelOf，不看这张表，所以“重连”只刷新表。
 * 设计：docs/src7插件设计/model-catalog.md。
 */
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as text from '../../utils/Text.ts';
import * as pull from './Pull.ts';

export type { ModelInfo } from './Pull.ts';


/** 插件名。 */
export const name = 'model-catalog';

/** 用到的服务：resources 读 providers；http 的 app 登记三个接口。 */
export const inject = ['resources', 'http'];


/** 一家重连的结果。照网页 web/src/Types.ts:61-71。 */
export interface ReconnectResult {
  provider: string;
  ok: boolean;
  /** 现在这家表里几个模型（没连上时是原来的个数）。 */
  models: number;
  /** 没连上的原因。 */
  error?: string;
}

/** probe 要的：表单里还没保存的一家。 */
export interface ProbeInput {
  provider: string;
  baseUrl: string;
  apiKey: string;
  api: string;
}

/** model/cooldown 的参数：model-fallback 发（总览第 3 节待补约定）。 */
export interface CooldownInfo {
  /** 供应商名/模型 ID。 */
  model: string;
  /** 冷却到几点，毫秒。 */
  until: number;
  /** 那次报错的前 200 字。 */
  reason: string;
}


declare module 'cordis' {
  interface Context {
    /** 模型清单服务，实现在 src7/plugins/model-catalog/index.ts。别的插件当可选依赖，用 ctx.get('modelCatalog') 现取。 */
    modelCatalog: ModelCatalog;
  }
  interface Events {
    /** 一个模型新记进冷却（model-fallback 发）。这里听它，给列表里那一项带上 limitedUntil。 */
    'model/cooldown'(info: CooldownInfo): void;
  }
}


/** 一家供应商在这个插件里要用的：apply 从 raw.providers 校验后交过来。 */
interface ProviderPlan {
  /** false 就不拉清单，只用手写的。 */
  listModels: boolean;
  /** 手写的模型。 */
  written: Record<string, pull.WrittenModel>;
}

/** 认得的协议，和骨架 utils/Checks.ts 的一样。 */
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

/** 没连上的隔多久再试，毫秒（同 0.4 Model.ts:1021-1052）。 */
const RETRY_MS = 60_000;


/** 模型清单服务。 */
export class ModelCatalog extends cordis.Service {
  /** 每家现在的表；起来先放手写的。键的先后就是 providers 的先后。 */
  private readonly tables = new Map<string, pull.ModelInfo[]>();

  /** 还没拉到清单的；定时器每 60 秒把它们再试一遍。 */
  private readonly pending = new Set<string>();

  /** 第一次失败已经打过日志的，免得每分钟刷一行。 */
  private readonly warned = new Set<string>();

  /** model/cooldown 记下的：模型 → 冷却到几点。 */
  private readonly cooling = new Map<string, number>();

  /**
   * 登记 model-catalog 插件：把 ModelCatalog 作为服务挂到 Cordis 上（super(ctx, 'modelCatalog') 做的；
   * 以后用 ctx.modelCatalog 或 ctx.get('modelCatalog') 取）。然后先放手写的、登记接口、听冷却、开始拉、开重试定时器。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param plans 每家要不要拉、手写了什么，apply 校验过。
   * 副作用：联网拉清单；在 ctx.http.app 上登记三条路径；被拔掉时停定时器。
   */
  constructor(ctx: cordis.Context, private readonly plans: Record<string, ProviderPlan>) {
    super(ctx, 'modelCatalog');

    for (const [provider, plan] of Object.entries(plans)) {
      this.tables.set(provider, pull.merge(provider, [], plan.written).models);
      if (plan.listModels) this.pending.add(provider);
    }
    this.routes();

    //M ctx.on 听一个事件：model-fallback 每新记一次冷却就 ctx.emit('model/cooldown', …)，这里记下来。
    //M 用 ctx.on 登记的监听，插件被拔掉时 Cordis 自己撤掉。
    this.ctx.on('model/cooldown', (info) => {
      this.cooling.set(info.model, info.until);
    });

    //M 起来就拉（不等 ready）；没拉到的每 60 秒再试，都拉到了这一轮就什么都不做。
    void this.retryPending();
    const timer = setInterval(() => {
      void this.retryPending();
    }, RETRY_MS);
    //M ctx.effect 登记“被拔掉时做什么”：Cordis 拔这个插件时调返回的函数，这里停掉定时器。
    this.ctx.effect(() => {
      return () => {
        clearInterval(timer);
      };
    });
  }

  /**
   * 查一个模型。
   * @param id 供应商名/模型 ID。
   * @returns 不在表里是 undefined。
   */
  find(id: string): pull.ModelInfo | undefined {
    return this.list().find((model) => model.id === id);
  }

  /**
   * 全部模型：照 providers 的先后，每家里照清单的先后、手写多出来的排后面；冷却中的带 limitedUntil。
   * @returns 新数组，改了不影响表。
   */
  list(): pull.ModelInfo[] {
    const now = Date.now();
    return [...this.tables.values()].flat().map((model) => {
      const until = this.cooling.get(model.id);
      if (until === undefined) return { ...model };
      //M 过了时间的冷却顺手删掉，不带。
      if (until <= now) {
        this.cooling.delete(model.id);
        return { ...model };
      }
      return { ...model, limitedUntil: until };
    });
  }

  /**
   * 重拉一家或每一家：这次清单一定要拉到，拉到了换掉，拉不到保持原样、原因写进 error。
   * @param provider 只重连这一家；不给就每一家。
   * @returns 每家一条结果。
   * @throws 给的供应商不在配置里。
   */
  async reconnect(provider?: string): Promise<ReconnectResult[]> {
    if (provider !== undefined && this.plans[provider] === undefined) {
      throw new Error(`config.yaml 的 providers 里没有 ${provider}`);
    }
    const names = provider === undefined ? Object.keys(this.plans) : [provider];
    const results: ReconnectResult[] = [];
    for (const one of names) {
      try {
        await this.pull(one, true);
        results.push({ provider: one, ok: true, models: this.tables.get(one)?.length ?? 0 });
      } catch (error) {
        results.push({ provider: one, ok: false, models: this.tables.get(one)?.length ?? 0, error: text.messageOf(error) });
      }
    }
    return results;
  }

  /**
   * 用表单里还没保存的地址、密钥、协议问一家有哪些模型，不进表。密钥用完就丢。
   * @param input 供应商名、地址、密钥、协议（空串当默认 openai-completions）。
   * @returns 这家的模型。
   * @throws 协议不认识、拉不到。
   * 副作用：发一个请求。
   */
  async probe(input: ProbeInput): Promise<pull.ModelInfo[]> {
    const api = input.api === '' ? 'openai-completions' : input.api;
    if (!APIS.includes(api)) throw new Error(`协议 ${api} 不认识，现在支持：${APIS.join('、')}`);
    const provider = input.provider === '' ? 'provider' : input.provider;
    const baseUrl = input.baseUrl.replace(/\/+$/u, '');
    try {
      const entries = await pull.fetchList(baseUrl, input.apiKey);
      return pull.merge(provider, entries, {}).models;
    } catch (error) {
      throw new Error(`拉供应商 ${provider}（${baseUrl}）的模型清单失败：${text.messageOf(error)}`, { cause: error });
    }
  }

  /** 把还没拉到的每家试一遍；失败的留在 pending。 */
  private async retryPending(): Promise<void> {
    await Promise.all([...this.pending].map((provider) => this.pull(provider, false).catch(() => undefined)));
  }

  /**
   * 拉一家：成功换掉 tables 里那家、从 pending 删；失败时第一次打一行日志，留在 pending。
   * @param provider 供应商名。
   * @param required 为真（重连用）时失败要抛；list_models: false 的这家只重放手写的、不联网。
   * @throws required 为真且没拉到。
   * 副作用：联网；发跟踪点 model-catalog.pull（不带密钥）。
   */
  private async pull(provider: string, required: boolean): Promise<void> {
    const plan = this.plans[provider]!;
    const config = this.ctx.resources.config.providers[provider]!;
    if (!plan.listModels) {
      this.tables.set(provider, pull.merge(provider, [], plan.written).models);
      return;
    }
    try {
      const entries = await pull.fetchList(config.baseUrl, config.apiKey);
      const merged = pull.merge(provider, entries, plan.written);
      this.tables.set(provider, merged.models);
      this.pending.delete(provider);
      if (this.warned.delete(provider)) console.log(`供应商 ${provider} 的模型清单拉到了，${String(merged.models.length)} 个模型`);

      //T 跟踪：拉到了一家的清单。
      const vars = { 供应商: provider, 模型: merged.models.length, 用了保守值: merged.guessed };
      this.ctx.emit('trace', 'model-catalog.pull', '拉到一家的模型清单，和手写的合并', 'merge(provider, fetchList(baseUrl, apiKey), written)', vars);
    } catch (error) {
      const reason = text.messageOf(error);
      //T 跟踪：没拉到。
      const vars = { 供应商: provider, 原因: reason, 现在几个模型: this.tables.get(provider)?.length ?? 0 };
      this.ctx.emit('trace', 'model-catalog.pull', '没拉到这家的模型清单，先用手写的', 'fetchList(baseUrl, apiKey)', vars);
      if (required) throw new Error(`拉供应商 ${provider}（${config.baseUrl}）的模型清单失败：${reason}`, { cause: error });
      if (!this.warned.has(provider)) {
        this.warned.add(provider);
        const count = Object.keys(plan.written).length;
        console.error(`供应商 ${provider} 的模型清单没拉到（${reason}），先用 config.yaml 手写的 ${String(count)} 个模型，每 60 秒再试`);
      }
    }
  }

  /** 登记三条路径。外面来的要带令牌由 http 的钩子管，本机免令牌；路由里只做入参校验。 */
  private routes(): void {
    const app = this.ctx.http.app;

    app.get('/api/models', () => this.list());

    app.post<{ Body: unknown }>('/api/models/reconnect', (request, reply) => {
      return answer(reply, async () => {
        const body = (request.body ?? {}) as { provider?: unknown };
        if (body.provider !== undefined && typeof body.provider !== 'string') throw new Error('provider 要是字符串');
        //M 空串当没给，重连每一家（同 0.4 HttpUi.ts:1395-1412）。
        const provider = body.provider === '' ? undefined : body.provider;
        return { results: await this.reconnect(provider) };
      });
    });

    app.post<{ Body: unknown }>('/api/ui/provider-models', (request, reply) => {
      return answer(reply, async () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (typeof body['base_url'] !== 'string' || body['base_url'].trim() === '') throw new Error('先填 API 地址');
        const field = (key: string): string => {
          const value = body[key] ?? '';
          if (typeof value !== 'string') throw new Error(`${key} 要是字符串`);
          return value;
        };
        const input = { provider: field('provider'), baseUrl: body['base_url'].trim(), apiKey: field('api_key'), api: field('api') };
        return { models: await this.probe(input) };
      });
    });
  }
}


/**
 * 三个接口共用的出错处理：出错都回 400 { error: 一句话 }（多是表单填错，设计第 2 节）。
 * @param reply 回应。
 * @param work 这个接口真正要做的事。
 * @returns work 的结果；出错时是已经发出去的 reply。
 */
async function answer(reply: fastify.FastifyReply, work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    return reply.code(400).send({ error: text.messageOf(error) });
  }
}


/**
 * 校验一家手写的一个模型里骨架不收的那几项（name、vision、thinking、price）；context_window、max_output_tokens 骨架已查过。
 * @param value 原样的那一段。
 * @param label 报错用的位置，如 providers.mock.models.b。
 * @returns 校验后的。
 * @throws 哪一项不对。
 */
function checkWritten(value: unknown, label: string): pull.WrittenModel {
  const model = (value ?? {}) as Record<string, unknown>;
  const result: pull.WrittenModel = {};
  if (typeof model['context_window'] === 'number') result.context_window = model['context_window'];
  if (typeof model['max_output_tokens'] === 'number') result.max_output_tokens = model['max_output_tokens'];
  if (model['name'] !== undefined) {
    if (typeof model['name'] !== 'string') throw new Error(`${label}.name 要是字符串`);
    result.name = model['name'];
  }
  if (model['vision'] !== undefined) {
    if (typeof model['vision'] !== 'boolean') throw new Error(`${label}.vision 要写 true 或 false`);
    result.vision = model['vision'];
  }
  if (model['thinking'] !== undefined) {
    const levels = model['thinking'];
    const known = [...pull.THINKING_LEVELS, 'none'];
    if (!Array.isArray(levels) || !levels.every((level) => typeof level === 'string' && known.includes(level))) {
      throw new Error(`${label}.thinking 要写成档位列表，档位只能是 ${pull.THINKING_LEVELS.join('、')}`);
    }
    result.thinking = levels as string[];
  }
  if (model['price'] !== undefined) {
    const price = model['price'] as Record<string, unknown> | null;
    const ok = (item: unknown): boolean => item === undefined || (typeof item === 'number' && item >= 0);
    if (typeof price !== 'object' || price === null || !ok(price['input']) || !ok(price['output'])) {
      throw new Error(`${label}.price 要写成 { input, output }，美元每百万 token，不小于 0`);
    }
    result.price = { input: price['input'] as number | undefined, output: price['output'] as number | undefined };
  }
  return result;
}


/**
 * 挂上模型清单。
 * apply 是 Cordis 插件的入口：Cordis 等 inject 里的 resources、http 都就绪后调一次（详见 plugins/Index.ts 的 PluginModule）。
 * 这里 new 出来的 ModelCatalog 继承 cordis.Service，构造时作为服务挂到 Cordis 上（以后用 ctx.modelCatalog 取）。
 * 插件自己没有配置段；读 raw.providers 里骨架不收的 list_models 和手写模型的 name、vision、thinking、price，在这里校验一次。
 * @param ctx Cordis 给这个插件的 ctx。
 * @throws providers 里这几项写得不对。
 */
export function apply(ctx: cordis.Context): void {
  const raw = (ctx.resources.raw['providers'] ?? {}) as Record<string, Record<string, unknown> | null>;
  const plans: Record<string, ProviderPlan> = {};
  //M 照骨架校验过的 providers 的先后走（骨架已查过 raw.providers 和 models 都是“名字: 值”）。
  for (const provider of Object.keys(ctx.resources.config.providers)) {
    const item = raw[provider] ?? {};
    const listModels = item['list_models'] ?? true;
    if (typeof listModels !== 'boolean') throw new Error(`providers.${provider}.list_models 要写 true 或 false`);
    const written: Record<string, pull.WrittenModel> = {};
    for (const [id, value] of Object.entries((item['models'] ?? {}) as Record<string, unknown>)) {
      written[id] = checkWritten(value, `providers.${provider}.models.${id}`);
    }
    plans[provider] = { listModels, written };
  }
  new ModelCatalog(ctx, plans);
}
