/**
 * 资源：运行时目录里的东西都归它管。
 * 读 config.yaml、开数据库、向 pi 注册供应商、给出运行时目录下的文件夹。
 * 配置改动通过校验后更新供应商和密钥。config.yaml 只读，不打印配置原文。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as piAnthropic from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import * as piCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as piResponses from '@earendil-works/pi-ai/api/openai-responses.lazy';
import * as cordis from 'cordis';
import * as yaml from 'yaml';
import type { Thinking } from './Sessions.ts';
import * as checks from './utils/Checks.ts';
import * as filesModule from './utils/Files.ts';
import * as textModule from './utils/Text.ts';
import * as utils from './utils/index.ts';


declare module 'cordis' {
  interface Context {
    /** 资源服务，实现在 src7/Resources.ts。 */
    resources: Resources;
  }
  interface Events {
    /**
     * Resources 成功应用 config.yaml 更新后发出。当前无内置监听者。
     * @param keys 新增、删除或内容有变化的顶层键名。
     */
    'config/changed'(keys: string[]): void;
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
  /** 开工前最多等待单个插件挂载的毫秒数。 */
  pluginMountTimeoutMs: number;
  /** 新会话默认的思考档（models.thinking）。 */
  thinking: Thinking;
  /** 模型请求出错怎么重试（models.retry）。 */
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


/** 校验后的骨架配置和来自同一份 YAML 的原始对象。 */
interface ConfigSnapshot {
  /** 骨架直接使用的配置。 */
  config: JmbotsConfig;
  /** 插件读取的配置原文对象，包含密钥。 */
  raw: Record<string, unknown>;
}

const CONFIG_FILE = 'config.yaml';
const CONFIG_RELOAD_DELAY_MS = 500;

/** 从磁盘读取并校验配置，错误信息不含 YAML 原文。 */
function readConfig(file: string): ConfigSnapshot {
  //M 启动和重读共用同一份入口校验。
  const yamlText = fs.readFileSync(file, 'utf8');
  const document = yaml.parseDocument(yamlText);

  //G YAML 解析错误会带出原文，错误里只保留行号。
  const broken = document.errors[0];
  if (broken !== undefined) {
    const line = String(broken.linePos?.[0].line ?? '?');
    throw new Error(`config.yaml 不是合法的 YAML（第 ${line} 行附近）`);
  }

  const written: unknown = document.toJSON();
  //M 交给 checkConfig 校验一次。顶层确认是对象后，插件仍可读取原始值。
  const config = checks.checkConfig(written);
  const raw = written as Record<string, unknown>;
  return { config, raw };
}


/** 资源服务。 */
export class Resources extends cordis.Service {
  /** 运行时目录的绝对路径。 */
  readonly root: string;

  /** 最近一次通过校验的配置快照。 */
  private current: ConfigSnapshot;

  /** 校验后的配置，骨架调用方可以直接读。 */
  get config(): JmbotsConfig {
    return this.current.config;
  }

  /** 整份 config.yaml 的对象，插件读自己那一段并校验。包含密钥。 */
  get raw(): Record<string, unknown> {
    return this.current.raw;
  }

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

    //M 首次读入校验后的快照，供数据库和插件初始化使用。
    const file = path.join(this.root, CONFIG_FILE);
    this.current = readConfig(file);

    //M 开数据库 data/jmbots7.db（没有就建）；这个服务被拔掉时关。
    const dbFile = path.join(this.dir('data'), 'jmbots7.db');
    this.db = new Database(dbFile, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.ctx.effect(() => {
      return () => {
        this.db.close();
      };
    });

    //M 用同一集合接入配置里的供应商，供 Sessions 后续请求复用。
    this.models = piAi.createModels();
    this.updateProviders(this.config.providers, {});

    //M 监听父目录，设置页用临时文件原子替换后仍能继续监听。
    this.watchConfig(file);
  }

  /** 按 ID 更新 pi 集合。密钥变动由请求时的解析回调处理。 */
  private updateProviders(providers: JmbotsConfig['providers'], previous: JmbotsConfig['providers']): void {
    const created: piAi.Provider[] = [];
    utils.eachEntry(providers, (name, provider) => {
      const old = previous[name];
      if (old?.baseUrl === provider.baseUrl && old.api === provider.api) return;

      //M 先建好新增或连接参数变动的供应商，再更新现有集合。
      const getApi = CHAT_APIS[provider.api];
      const api = getApi();
      const auth = this.getAuth(provider, name);
      const options = {
        id: name, baseUrl: provider.baseUrl, auth, models: [], api,
      };
      const item = piAi.createProvider(options);
      created.push(item);
    });

    //M 移除配置里删掉的供应商，再登记准备好的新实现。
    const configured = Object.keys(previous);
    for (const name of configured) {
      if (Object.hasOwn(providers, name)) continue;
      this.models.deleteProvider(name);
    }
    for (const item of created) {
      this.models.setProvider(item);
    }
  }

  /** 监听 config.yaml，合并保存动作产生的多次文件通知。 */
  private watchConfig(file: string): void {
    this.ctx.effect(() => {
      let pending: ReturnType<typeof setTimeout> | undefined;
      //M 非持久监听与定时器让命令行模式能照常退出。
      const watcher = fs.watch(this.root, { persistent: false }, (_event, name) => {
        if (name !== null && name.toLowerCase() !== CONFIG_FILE) return;

        clearTimeout(pending);
        pending = setTimeout(() => this.reloadConfig(file), CONFIG_RELOAD_DELAY_MS);
        pending.unref();
      });
      watcher.on('error', (error) => {
        console.error(`config.yaml 监听失败：${error.message}`);
      });
      return () => {
        clearTimeout(pending);
        watcher.close();
      };
    });
  }

  /** 校验并应用新快照，失败时继续使用原配置。 */
  private reloadConfig(file: string): void {
    let changed: string[];
    try {
      const next = readConfig(file);
      const names = new Set([...Object.keys(this.raw), ...Object.keys(next.raw)]);
      changed = Array.from(names).filter((name) => !util.isDeepStrictEqual(this.raw[name], next.raw[name]));
      if (changed.length === 0) return;

      //M 同步更新 pi 集合与配置快照，再向监听者通知新状态。
      this.updateProviders(next.config.providers, this.config.providers);
      this.current = next;
    } catch (error) {
      const reason = textModule.getMessage(error);
      console.error(`config.yaml 重读失败，继续使用原配置：${reason}`);
      return;
    }

    //M 只通知变动的顶层键，供需要刷新配置的插件监听。
    this.ctx.emit('config/changed', changed);
  }

  /**
   * 交给 pi 的供应商鉴权。对话模型和 decision 的分类器都用它。
   * @param provider 配置中的供应商对象，用于兼容调用方按对象登记。
   * @param name 调用方已知道的供应商名。
   * @returns 每次请求前按供应商名从当前配置解析密钥和地址。
   */
  getAuth(provider: ProviderConfig, name?: string): piAi.ProviderAuth {
    const providers = this.config.providers;
    const providerName = name ?? Object.keys(providers).find((key) => providers[key] === provider);
    return {
      apiKey: {
        name: '配置里的密钥',
        resolve: async () => {
          const providers = this.config.providers;
          //G 删除供应商后，旧的鉴权回调不再交回密钥。
          if (providerName === undefined || !Object.hasOwn(providers, providerName)) return undefined;

          //M 在同一快照取地址和密钥，缓存过模型的调用方也会向当前地址请求。
          const current = providers[providerName]!;
          const apiKey = current.apiKey || 'no-key';
          return { auth: { apiKey, baseUrl: current.baseUrl }, source: CONFIG_FILE };
        },
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
    //M 确保运行时目录下的目标路径可供调用方使用。
    return filesModule.ensureDir(full);
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
