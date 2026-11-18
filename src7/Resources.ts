/**
 * 资源：运行时目录里的东西都归它管。
 * 读 config.yaml、开数据库、把 pi 的供应商建好、给出运行时目录下的文件夹。
 * 最底下一层，不依赖别的模块。config.yaml 只读不改写，不打印原文（里面有密钥）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as piAnthropic from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import * as piCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as piResponses from '@earendil-works/pi-ai/api/openai-responses.lazy';
import * as cordis from 'cordis';
import * as yaml from 'yaml';
import type { Thinking } from './Sessions.ts';
import * as checks from './utils/Checks.ts';
import * as textModule from './utils/Text.ts';


declare module 'cordis' {
  interface Context {
    /** 资源服务，实现在 src7/Resources.ts。 */
    resources: Resources;
  }
}


/** 入口校验好以后传进来的。 */
export interface ResourcesConfig {
  /** 运行时目录的绝对路径。 */
  dir: string;
}


/** config.yaml 里的一家供应商，校验后。 */
export interface ProviderConfig {
  /** 请求地址，末尾不带斜杠。 */
  baseUrl: string;
  /** 请求密钥；空的表示本地服务不要密钥。 */
  apiKey: string;
  /** 请求协议。 */
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  /** 手写的模型：模型 ID → 上下文多长、最多输出多少、会不会思考、收不收图片（vision: true 收）。没写的模型用保守值。 */
  models: Record<string, { contextWindow: number; maxTokens: number; reasoning: boolean; input: ('text' | 'image')[] }>;
  /** 发请求时的兼容设置（compat 段），所有模型共用；原样交给 pi。 */
  compat: Record<string, unknown>;
  /** 个别模型再加的兼容设置（model_compat 段）：模型 ID → 设置，盖在 compat 上面。 */
  modelCompat: Record<string, Record<string, unknown>>;
}


/** config.yaml 的 plugins 段里的一项，校验后。写了 disabled: true 的已经去掉了。 */
export interface PluginEntry {
  /** 自带插件的名字（plugins/ 下的文件夹名），或者别人写的插件的文件夹路径（相对路径从运行时目录算）。 */
  name: string;
  /** 给这个插件的配置；没写是空对象。插件自己校验。 */
  config: unknown;
}


/** 一个插件这次启动的挂载结果。Main.ts 写，健康检查和 /flow/ 读。没尝试挂的不在里面。 */
export interface PluginStatus {
  /** 配置里的插件名。 */
  name: string;
  /** apply 有没有成功跑完。 */
  mounted: boolean;
  /** inject 的服务是不是都有了（没人提供就会一直等着，等于没开工）。 */
  started: boolean;
  /** 还缺哪些服务。 */
  missing: string[];
  /** 没挂上时的原因；挂上了是空串。 */
  error: string;
  /** 它声明要的服务。 */
  inject: string[];
}


/**
 * 没挂上、没开工的说明，给 /api/health 的 problems。
 * @param status 这次启动实际尝试挂过的插件。
 */
export function getPluginProblems(status: PluginStatus[]): string[] {
  const problems: string[] = [];
  for (const item of status) {
    //M 没挂上：有原因就带上原因。
    if (!item.mounted) {
      let problem = `插件 ${item.name} 没挂上`;
      if (item.error !== '') {
        problem += `：${item.error}`;
      }
      problems.push(problem);
      continue;
    }

    //M 挂上了却没开工：写明缺哪些服务。
    if (!item.started) {
      const names = item.missing.join('、');
      problems.push(`插件 ${item.name} 没开工：它要用的 ${names} 没人提供`);
    }
  }
  return problems;
}


/** config.yaml 里骨架用到的那几项，校验后。由 utils/Checks.ts 的 checkConfig 交回。 */
export interface JmbotsConfig {
  /** 新会话默认用的模型，供应商名/模型 ID。 */
  defaultModel: string;
  /** 各家供应商：名字 → 地址、密钥、协议、模型。 */
  providers: Record<string, ProviderConfig>;
  /** 要挂哪些插件，照写的先后挂。 */
  plugins: PluginEntry[];
  /** 新会话默认的思考档（engine.thinking）。 */
  thinking: Thinking;
  /** 模型请求出错怎么重试（engine.retry）。 */
  retry: {
    /** 出错以后最多再试几次。 */
    times: number;
    /** 第一次重试前等多久，毫秒；以后每次翻倍。 */
    waitMs: number;
    /** 一次请求最多等多久，毫秒。 */
    timeoutMs: number;
  };
}


/** 三种协议对应的 pi 实现，和 learn/Agent.ts 同一套懒加载入口。 */
const CHAT_APIS: Record<ProviderConfig['api'], () => ReturnType<typeof piCompletions.openAICompletionsApi>> = {
  'openai-completions': piCompletions.openAICompletionsApi,
  'openai-responses': piResponses.openAIResponsesApi,
  'anthropic-messages': piAnthropic.anthropicMessagesApi,
};


/** 资源服务。 */
export class Resources extends cordis.Service {
  /** 运行时目录的绝对路径。 */
  readonly root: string;

  /** 校验后的配置：骨架自己用到的那几项。谁要用直接读，不再检查。 */
  readonly config: JmbotsConfig;

  /** 整份 config.yaml 解析出来的对象，原样。插件读自己那一段（bots、channels、server……），自己校验。里面有密钥，不许打印。 */
  readonly raw: Record<string, unknown>;

  /** 数据库连接 data/jmbots7.db；会话存在里面，插件也在里面建自己的表。 */
  readonly db: Database;

  /** 建好了各家供应商的 pi 集合；Sessions.chat() 用它发请求。 */
  readonly models: piAi.MutableModels;

  /**
   * 这次启动各插件的挂载结果；Main.ts 在挂插件时写入。
   * 试运行（只挂 http）也只记实际尝试过的，不会把没挂的都报成失败。
   */
  pluginStatus: PluginStatus[] = [];

  /**
   * 登记 resources 插件：把 Resources 作为服务挂到 Cordis 上，名字叫 resources（以后用 ctx.resources 取）；
   * 再读配置并校验一次、开数据库、把 pi 的供应商建好。
   * @param ctx Cordis 给的 ctx。
   * @param config 运行时目录。
   * @throws 找不到 config.yaml、不是合法 YAML、哪一项不对时抛错；错误信息不带配置原文。
   */
  constructor(ctx: cordis.Context, config: ResourcesConfig) {
    super(ctx, 'resources');
    this.root = path.resolve(config.dir);

    //M 读 config.yaml，先按 YAML 解析。
    const file = path.join(this.root, 'config.yaml');
    const yamlText = fs.readFileSync(file, 'utf8');
    const document = yaml.parseDocument(yamlText);

    //G YAML 自己的报错会带上出错那一行的原文（可能是密钥），所以只说第几行。
    const broken = document.errors[0];
    if (broken !== undefined) {
      const line = String(broken.linePos?.[0].line ?? '?');
      throw new Error(`config.yaml 不是合法的 YAML（第 ${line} 行附近）`);
    }

    //M 交给 checkConfig 校验一次，内部以后只用校验过的 this.config。
    const raw: unknown = document.toJSON();
    this.config = checks.checkConfig(raw);

    //M checkConfig 已经查过顶层是一组“名字: 值”，这里原样留一份给插件读。
    this.raw = raw as Record<string, unknown>;

    //M 开数据库 data/jmbots7.db（没有就建）；这个服务被拔掉时关。
    const dbFile = path.join(this.dir('data'), 'jmbots7.db');
    this.db = new Database(dbFile, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.ctx.effect(() => {
      return () => {
        this.db.close();
      };
    });

    //M 照 providers 里的每一家，用 pi 的 createProvider 建好，放进同一个 pi 集合。只建这一次。
    this.models = piAi.createModels();
    textModule.eachEntry(this.config.providers, (name, provider) => {
      /** 这家用的协议在 pi 里的实现。 */
      const api = CHAT_APIS[provider.api]();
      //M 构造带配置密钥回调的 pi 供应商并注册进模型集合，供后续发模型请求复用。
      const created = piAi.createProvider({
        id: name,
        baseUrl: provider.baseUrl,
        auth: this.getAuth(provider),
        models: [],
        api,
      });
      this.models.setProvider(created);
    });
  }

  /**
   * 交给 pi 的一家供应商的密钥（createProvider 的 auth）。骨架建对话模型、decision 插件建分类器都用这一份。
   * 真正的密钥是 apiKey：来自 config.yaml 的 providers.<名>.api_key（utils/Checks.ts 的 checkConfig 读进 config.providers）。
   * pi 的密钥是回调，因为它支持“发请求时现取”：读环境变量、OAuth 过期了先刷新再给；
   * 我们的密钥固定写在配置里，所以回调只是把闭包里的 apiKey 原样交回。
   * @param provider config.providers 里的一家（校验过的）。
   * @returns pi 的 ProviderAuth：
   *   name 只是 pi 在状态、报错里显示的名字，不是密钥；
   *   resolve 是 pi 每次发请求前调的回调（pi 的 auth/resolve.js 的 resolveApiKey），交回密钥；
   *   source 是给人看的来源标签（pi 自己的例子是 "ANTHROPIC_API_KEY"、"OAuth"），写 config.yaml。
   */
  getAuth(provider: ProviderConfig): piAi.ProviderAuth {
    //M 本地服务可以不要密钥；pi 约定空密钥用 no-key。
    let apiKey = provider.apiKey;
    if (apiKey === '') {
      apiKey = 'no-key';
    }
    return {
      apiKey: {
        name: '配置里的密钥',
        resolve: () => Promise.resolve({ auth: { apiKey }, source: 'config.yaml' }),
      },
    };
  }

  /**
   * 运行时目录下的一个文件夹，没有就建。
   * @param parts 一层层的文件夹名，比如 dir('bots', '助手', 'workspace')。
   * @returns 绝对路径。
   * 副作用：可能建目录。
   */
  dir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  /**
   * 照“供应商名/模型 ID”拼出 pi 的模型对象。
   * @param name 供应商名/模型 ID。
   * @returns Sessions.chat() 要的那个模型。
   * @throws 供应商不在配置里时抛错。
   */
  getModel(name: string): piAi.Model<piAi.Api> {
    //M 第一个斜杠前是供应商名，后面是模型 ID（模型 ID 自己也可以带斜杠）。
    const slash = name.indexOf('/');
    const providerName = name.slice(0, slash);
    const id = name.slice(slash + 1);

    //G 供应商不在配置里 → 抛错。
    const provider = this.config.providers[providerName];
    if (provider === undefined) {
      throw new Error(`模型 ${name} 的供应商不在 config.yaml 的 providers 里`);
    }

    /** 手写的四项：contextWindow、maxTokens、reasoning、input；没写用保守值。 */
    const written = provider.models[id] ?? checks.MODEL_DEFAULTS;
    //M 兼容设置：供应商的 compat，再盖上这个模型自己的 model_compat。
    const compat = { ...provider.compat, ...provider.modelCompat[id] };

    //M 拼成 pi 的模型对象；骨架不算费用，cost 都写 0。
    return {
      id,
      name: id,
      provider: providerName,
      baseUrl: provider.baseUrl,
      api: provider.api,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat,
      ...written,
    } as piAi.Model<piAi.Api>;
  }
}
