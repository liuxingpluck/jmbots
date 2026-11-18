/**
 * 模型清单与运行兜底（已并入原 model-fallback）：
 * 1. 清单：起来就向 providers 里每一家拉 <base_url>/models，和手写的合成一张模型表，给网页看、给别的插件查；
 *    一家拉不到不挡别家、不挡起服务：先用它手写的模型，每 60 秒再试，连上就换。
 * 2. 回退（Fallback.ts / Queue.ts）：在 session/request 里排最后调 ctx.sessions.chat，限流记冷却、超长换大窗口，带并发排队。
 * 3. 模型介绍和评价（Notes.ts，11-18 并进原 model-notes）：运行时目录 models/ 下一个模型一份 MD；接口 /api/model-notes* 路径照旧；
 *    事件 model-catalog/request 的 action: 'prompt' 一次交回模型介绍评价和能用的思考档，前台派活时带上。
 * 只是一张表加回退层：正常调模型仍走骨架的 ctx.resources.getModel。
 * 设计：docs/src7插件设计/model-catalog.md、docs/src7插件设计/model-fallback.md。
 */
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as text from '../../utils/Text.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as fallback from './Fallback.ts';
import * as notesModule from './Notes.ts';
import * as pull from './Pull.ts';

export type { ModelInfo } from './Pull.ts';
export type { ModelNote, Rating } from './Notes.ts';
export type { FallbackInfo, FallbackConfig } from './Fallback.ts';
export { isRateLimited, isOverflow, getResetTime } from './Fallback.ts';


/** 插件名。 */
export const name = 'model-catalog';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.2.0：并进 model-notes（Notes.ts，接口路径照旧）；model-catalog/request 加 action: 'prompt'。
export const version = '1.2.0';

/** 用到的服务：resources 读 providers/engine/concurrency、运行时目录；sessions 调模型兜底、打分时查会话。http 是可选的（就绪才挂五个接口）。 */
export const inject = ['resources', 'sessions'];


/** model-catalog 插件配置（plugins[model-catalog].config）。 */
export interface ModelCatalogConfig {
  /** 换模型与并发回退配置（原 model-fallback）；写 false 或 enabled: false 可关闭；缺省沿用顶层 engine / concurrency。 */
  fallback?: fallback.FallbackConfig | false;
  /** 模型介绍和评价（原插件 model-notes 的 config）：dir 放 MD 的目录（默认 models，相对运行时目录），time_zone 评价时间的时区（默认 America/New_York）。 */
  notes?: { dir?: string; time_zone?: string };
}


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
    /** 问模型清单（serial 发、等 model-catalog/result）：find 查一个模型，prompt 取派活用的模型介绍评价和思考档。本插件听。 */
    'model-catalog/request'(request: CatalogRequest): void | Promise<void>;
    /** model-catalog/request 的回执（emit），按 requestId 配对。 */
    'model-catalog/result'(result: CatalogResult): void;
  }
}

/** 模型清单查询：action 分两种。 */
type CatalogRequest = requestEventModule.RequestEnvelope & ({
  /** 查询一个模型。 */
  action: 'find';
  /** 供应商名/模型 ID。 */
  model: string;
} | {
  /** 取派活提示词用的两段：模型介绍和评价、有介绍的模型能用的思考档。 */
  action: 'prompt';
});

/** 模型清单的回执。 */
interface CatalogResult extends requestEventModule.ResultEnvelope {
  /** find：没找到时为空。 */
  info?: pull.ModelInfo;
  /** prompt：模型介绍和评价那一段；一个模型都没写介绍是空串。 */
  prompt?: string;
  /** prompt：有介绍的模型各自能用的思考档那一段；没有是空串。 */
  levelsText?: string;
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
   * @param notes 模型介绍和评价（Notes.ts），apply 建的；prompt 请求拼提示词用。
   * 副作用：联网拉清单；被拔掉时停定时器。
   */
  constructor(
    ctx: cordis.Context,
    private readonly plans: Record<string, ProviderPlan>,
    private readonly notes: notesModule.ModelNotes,
  ) {
    super(ctx, 'modelCatalog');

    //M 按各供应商的手写配置先填好初始模型表，并将需要在线拉清单的加入待重试集合。
    text.eachEntry(plans, (provider, plan) => {
      this.tables.set(provider, pull.merge(provider, [], plan.written).models);
      if (plan.listModels) {
        this.pending.add(provider);
      }
    });

    //M ctx.on 听一个事件：Fallback 每新记一次冷却就 ctx.emit('model/cooldown', …)，这里记下来。
    //M 用 ctx.on 登记的监听，插件被拔掉时 Cordis 自己撤掉。
    this.ctx.on('model/cooldown', (info) => {
      this.cooling.set(info.model, info.until);
    });

    //M 让其他插件通过事件查询模型清单（契约 3.2 第 7 条）：find 沿用 find 的冷却状态处理，prompt 一次交回两段提示词。
    //M   出错（比如 models/ 读不了）打一行日志、回空回执，调用方当没查到，不干等超时。
    const options = {
      onError: (error: unknown) => {
        console.error(`model-catalog 回答查询出错：${text.getMessage(error)}`);
        return {};
      },
    };
    requestEventModule.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (request) => {
      //M prompt：模型介绍评价和能用的思考档，前台派活时带上（bots/Dispatch.ts 的 onRequest 发）。
      if (request.action === 'prompt') return this.getPrompt();

      //M find：按模型 ID 查清单并回执，查不到时 info 为空。
      const info = this.find(request.model);
      return { info };
    }, options);

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
    //M 从附带最新冷却截止状态的模型全集里按 ID 查找对应项。
    return this.list().find((model) => model.id === id);
  }

  /**
   * 派活提示词用的两段（原来在 bots/Dispatch.ts 拼，11-18 挪到这里）：模型介绍和评价；有介绍、又在清单里的模型各自能用的思考档。
   * @returns prompt 没有介绍是空串，这时 levelsText 也是空串；有介绍但都不在清单里，levelsText 是空串。
   * 副作用：读 models/ 下的 MD。
   */
  getPrompt(): { prompt: string; levelsText: string } {
    //M 读一次全部介绍：拼介绍那段，再拿同一份对着清单拼思考档。
    const list = this.notes.getList();
    const prompt = this.notes.getPrompt(list);
    if (prompt === '') return { prompt, levelsText: '' };

    //M 有介绍的模型逐个查清单，查得到的写一行它能用的思考档。
    const lines: string[] = [];
    for (const note of list) {
      const info = this.find(note.model);
      if (info === undefined) continue;

      lines.push(`- ${note.model}：${info.thinking.join('、')}`);
    }
    if (lines.length === 0) return { prompt, levelsText: '' };

    const levelsText = ['能用的思考档（写 thinking 只能从里面挑）：', ...lines].join('\n');
    return { prompt, levelsText };
  }

  /**
   * 全部模型：照 providers 的先后，每家里照清单的先后、手写多出来的排后面；冷却中的带 limitedUntil。
   * @returns 新数组，改了不影响表。
   */
  list(): pull.ModelInfo[] {
    const now = Date.now();
    return [...this.tables.values()].flat().map((model) => {
      //M 查该模型是否仍在限流冷却期内，未过期时拼上 limitedUntil 给外部展示。
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
   * 副作用：联网重新拉取模型清单并更新内存表。
   */
  async reconnect(provider?: string): Promise<ReconnectResult[]> {
    if (provider !== undefined && this.plans[provider] === undefined) {
      throw new Error(`config.yaml 的 providers 里没有 ${provider}`);
    }
    const pickNames = (): string[] => {
      if (provider === undefined) return Object.keys(this.plans);

      return [provider];
    };
    //M 按指定或全部已配置供应商汇总本次要强制重连的名单，逐一拉取并记录成败结果。
    const names = pickNames();
    const results: ReconnectResult[] = [];
    for (const one of names) {
      try {
        //M 强制重拉该家模型清单替换内存表，成功后记录当前模型数。
        await this.pull(one, true);
        results.push({ provider: one, ok: true, models: this.tables.get(one)?.length ?? 0 });
      } catch (error) {
        //G 单家重拉失败时不中断循环，保留原表数量并记下错误原因返回给调用方。
        results.push({ provider: one, ok: false, models: this.tables.get(one)?.length ?? 0, error: text.getMessage(error) });
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
    let api = input.api;
    if (api === '') {
      api = 'openai-completions';
    }
    if (!APIS.includes(api)) throw new Error(`协议 ${api} 不认识，现在支持：${APIS.join('、')}`);

    let provider = input.provider;
    if (provider === '') {
      provider = 'provider';
    }
    const baseUrl = input.baseUrl.replace(/\/+$/u, '');
    try {
      //M 使用临时填写的地址与密钥拉取原始模型清单，并合并成标准模型结构返回给表单预览（不存表）。
      const entries = await pull.fetchList(baseUrl, input.apiKey);
      return pull.merge(provider, entries, {}).models;
    } catch (error) {
      throw new Error(`拉供应商 ${provider}（${baseUrl}）的模型清单失败：${text.getMessage(error)}`, { cause: error });
    }
  }

  /** 把还没拉到的每家试一遍；失败的留在 pending。 */
  private async retryPending(): Promise<void> {
    //M 并发重拉全部仍在等待队列中的供应商，单家失败时吞掉异常留到下个周期继续试。
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
    //G 该供应商关闭了自动拉取（list_models: false），直接重放手写模型入表后返回。
    if (!plan.listModels) {
      this.tables.set(provider, pull.merge(provider, [], plan.written).models);
      return;
    }
    try {
      //M 请求供应商模型清单并与手写项合并，成功后更新内存表并移出待拉取及告警记录。
      const entries = await pull.fetchList(config.baseUrl, config.apiKey);
      const merged = pull.merge(provider, entries, plan.written);
      this.tables.set(provider, merged.models);
      this.pending.delete(provider);
      if (this.warned.delete(provider)) console.log(`供应商 ${provider} 的模型清单拉到了，${String(merged.models.length)} 个模型`);

      //T 跟踪：拉到了一家的清单。
      const vars = { 供应商: provider, 模型: merged.models.length, 用了保守值: merged.guessed };
      this.ctx.emit('trace', 'model-catalog.pull', '拉到一家的模型清单，和手写的合并', 'merge(provider, fetchList(baseUrl, apiKey), written)', vars);
    } catch (error) {
      const reason = text.getMessage(error);
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

  /**
   * 登记模型清单的三条路径（模型介绍和评价的两条由 Notes.ts 的 routes 登记）。外面来的要带令牌由 http 的钩子管，本机免令牌；路由里只做入参校验。
   * @param app Fastify 服务实例。
   * 副作用：向 app 注册模型列表、重连刷新和探测三条 HTTP 路由。
   */
  routes(app: fastify.FastifyInstance): void {
    //M 挂载查询全部模型与实时冷却状态的只读接口。
    app.get('/api/models', () => this.list());

    //M 挂载重连接口：用统一错误包装校验 provider 后触发在线拉取。
    app.post<{ Body: unknown }>('/api/models/reconnect', (request, reply) => {
      return answer(reply, async () => {
        const body = (request.body ?? {}) as { provider?: unknown };
        if (body.provider !== undefined && typeof body.provider !== 'string') {
          throw new Error('provider 要是字符串');
        }
        //M 空串当没给，重连每一家（同 0.4 HttpUi.ts:1395-1412）。
        let provider = body.provider;
        if (provider === '') {
          provider = undefined;
        }
        //M 执行重连并将各供应商刷新结果返回给调用方。
        return { results: await this.reconnect(provider) };
      });
    });

    //M 挂载表单探测接口：用统一错误包装校验未保存的供应商连接信息并探测模型。
    app.post<{ Body: unknown }>('/api/ui/provider-models', (request, reply) => {
      return answer(reply, async () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (typeof body['base_url'] !== 'string' || body['base_url'].trim() === '') {
          throw new Error('先填 API 地址');
        }
        const field = (key: string): string => {
          const value = body[key] ?? '';
          if (typeof value !== 'string') {
            throw new Error(`${key} 要是字符串`);
          }
          return value;
        };
        //M 从表单字段拼出探测参数并直接拉取清单返回，不改动当前内存模型表。
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
    //G 接口校验或执行抛错时提取可读提示文本，统一按 HTTP 400 返回给前端展示。
    return reply.code(400).send({ error: text.getMessage(error) });
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
    //G 校验手写价格对象的输入与输出单价为非负数，否则拒绝配置加载。
    if (typeof price !== 'object' || price === null || !ok(price['input']) || !ok(price['output'])) {
      throw new Error(`${label}.price 要写成 { input, output }，美元每百万 token，不小于 0`);
    }
    result.price = { input: price['input'] as number | undefined, output: price['output'] as number | undefined };
  }
  return result;
}


/**
 * 挂上模型清单与运行兜底（model-fallback 已并入）。
 * apply 是 Cordis 插件的入口：Cordis 等 inject 里的 resources、sessions 都就绪后调一次。
 * 先校验 providers、config.fallback 与 config.notes，再建模型介绍（Notes.ts）、ModelCatalog（服务 + 冷却监听）→ 可选 http 路由 → 再建 ModelFallback（听 session/request 兜底调模型）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins[model-catalog].config（可选：{ fallback?: FallbackConfig | false; notes?: { dir?, time_zone? } }）。
 * @throws providers、fallback 或 notes 配置写得不对时抛错。
 * 副作用：注册 modelCatalog 服务并拉取模型清单；没有 models/ 目录就建；可选挂载 HTTP 接口、定时重试任务及 session/request 回退处理器。
 */
export function apply(ctx: cordis.Context, config?: ModelCatalogConfig): void {
  const raw = (ctx.resources.raw['providers'] ?? {}) as Record<string, Record<string, unknown> | null>;
  const plans: Record<string, ProviderPlan> = {};
  //M 照骨架校验过的 providers 的先后走（骨架已查过 raw.providers 和 models 都是“名字: 值”）。
  for (const provider of Object.keys(ctx.resources.config.providers)) {
    const item = raw[provider] ?? {};
    const listModels = item['list_models'] ?? true;
    if (typeof listModels !== 'boolean') {
      throw new Error(`providers.${provider}.list_models 要写 true 或 false`);
    }
    const written: Record<string, pull.WrittenModel> = {};
    //M 逐条校验该供应商 config.yaml 手写的模型属性，生成供合并使用的手写表。
    text.eachEntry((item['models'] ?? {}) as Record<string, unknown>, (id, value) => {
      written[id] = checkWritten(value, `providers.${provider}.models.${id}`);
    });
    plans[provider] = { listModels, written };
  }

  //M 读取并校验回退配置；模型介绍和评价的配置（原 model-notes 的 config）也在入口查一次，建好放 MD 的目录。
  const fallbackSettings = fallback.readFallbackSettings(ctx, config);
  const notesSettings = notesModule.readNotesSettings(ctx.resources.root, config?.notes ?? {});
  const notes = new notesModule.ModelNotes(ctx, notesSettings);

  //M 启动 ModelCatalog 服务实例，初始化模型表与定时器；prompt 请求从 notes 读介绍。
  const catalog = new ModelCatalog(ctx, plans, notes);

  //M http 是可选的：http 就绪后再挂模型管理三个接口、模型介绍和评价两个接口，不挡纯会话回退或命令行启动。
  void ctx.inject(['http'], (sub) => {
    catalog.routes(sub.http.app);
    notes.routes(sub.http.app);

    //T 跟踪：模型介绍和评价的接口挂好了。
    const vars = { 目录: notesSettings.dir, 时区: notesSettings.timeZone };
    const code = "app.get('/api/model-notes'); app.post('/api/model-notes/rate')";
    sub.emit('trace', 'model-catalog.notes', '模型介绍和评价挂好了', code, vars);
  });

  if (fallbackSettings.enabled) {
    //M 启用回退时挂载换模型处理器，接管 session/request 兜底调用与限流冷却。
    new fallback.ModelFallback(ctx, fallbackSettings, catalog);
  }
}
