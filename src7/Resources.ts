/**
 * 资源：文件夹和数据都归它管。
 * 建目录、每个机器人的工作区和记忆、数据库、读 config.yaml、把 pi 的供应商建好、出系统提示词。
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
import type { PromptEvent } from './Sessions.ts';
import * as checks from './utils/Checks.ts';


declare module 'cordis' {
  interface Context {
    /** 资源服务，实现在 src7/Resources.ts。 */
    resources: Resources;
  }
}


/** 思考档。默认对话最高只给 low。 */
export type Thinking = 'off' | 'low' | 'medium' | 'high';


/** 入口校验好以后传进来的。 */
export interface ResourcesConfig {
  /** 运行时目录的绝对路径。 */
  dir: string;
}


/** 运行时目录里的路径，都是绝对路径。 */
export interface RuntimePaths {
  /** 运行时目录。 */
  root: string;
  /** config.yaml。 */
  config: string;
  /** 数据库文件 data/jmbots7.db。 */
  db: string;
  /** 各机器人的文件夹 bots/。 */
  bots: string;
  /** 提示词 prompts/。 */
  prompts: string;
  /** 用户级的记忆 memory/。 */
  memory: string;
  /** 各渠道自己的存储 channels/。 */
  channels: string;
}


/** 一个机器人的文件夹。 */
export interface BotDir {
  /** 工作区 bots/<机器人>/workspace/。 */
  workspace: string;
  /** 这个机器人的记忆 bots/<机器人>/memory/。 */
  memory: string;
}


/** bots 名单里的一项。 */
export interface BotConfig {
  /** 机器人名，也是 bots/ 下的文件夹名。 */
  name: string;
  /** 用哪种语言的提示词。 */
  language: 'zh' | 'en';
}


/** config.yaml 里的一家供应商，校验后。 */
export interface ProviderConfig {
  /** 请求地址。 */
  baseUrl: string;
  /** 请求密钥；空串表示本地服务不要密钥。 */
  apiKey: string;
  /** 请求协议。 */
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  /** 手写的模型：模型 ID → 上下文长度、最大输出。没写的模型用默认的长度。 */
  models: Record<string, { contextWindow: number; maxTokens: number }>;
}


/** config.yaml 的 plugins 段里的一项，校验后。写了 disabled: true 的已经去掉了。 */
export interface PluginEntry {
  /**
   * 自带插件的名字（就是 plugins/ 下的文件夹名），或者别人写的插件的文件夹路径。
   * 以 . 开头的是相对路径，从 config.yaml 所在的目录算；也可以写绝对路径。
   */
  name: string;
  /** 给这个插件的配置；没写是空对象。插件自己校验。 */
  config: unknown;
}


/** config.yaml 里骨架用到的那几项，校验后。由 utils/Checks.ts 的 checkConfig 交回。 */
export interface JmbotsConfig {
  /** 默认模型，供应商名/模型 ID。 */
  defaultModel: string;
  /** 各家供应商：名字 → 地址、密钥、协议、模型。 */
  providers: Record<string, ProviderConfig>;
  /** 启用的机器人名单。 */
  bots: BotConfig[];
  /** 一轮最多走几步。 */
  maxSteps: number;
  /** 模型请求出错怎么重试。 */
  retry: RetryConfig;
  /** 要挂哪些插件，照写的先后挂。 */
  plugins: PluginEntry[];
}


/** 建好的一个 pi 模型，chat() 直接拿去用。 */
export interface ModelHandle {
  /** 建好供应商的 pi 集合。 */
  registry: piAi.MutableModels;
  /** 这个模型在 pi 里的对象。 */
  piModel: piAi.Model<piAi.Api>;
  /** 这家的密钥，只用来把错误信息里回显的密钥抹掉。 */
  apiKey: string;
}


/** 模型请求出错怎么重试。 */
export interface RetryConfig {
  /** 连续出错几次才算出错。默认 5。 */
  times: number;
  /** 两次之间等多久，毫秒。 */
  waitMs: number;
  /** 一次请求最多等多久，毫秒。 */
  timeoutMs: number;
}


/** 三种协议对应的 pi 实现，和 learn/Agent.ts 同一套懒加载入口。 */
const CHAT_APIS: Record<ProviderConfig['api'], () => ReturnType<typeof piCompletions.openAICompletionsApi>> = {
  'openai-completions': piCompletions.openAICompletionsApi,
  'openai-responses': piResponses.openAIResponsesApi,
  'anthropic-messages': piAnthropic.anthropicMessagesApi,
};


/** 默认对话用的系统提示词（没有提示词文件时用）。 */
const PROMPT_DEFAULT = '你只回答简单的问题和分派，绝对不自己干活。需要知道现在几点时调用 time 工具，用中文简短回答。更复杂的事交给干活的会话，调用 hand_session。';

/** 干活的会话用的系统提示词（没有提示词文件时用）。 */
const PROMPT_WORK = '你是一个助手，在机器人的工作区里干活。做完用一两句话告诉用户结果；结束前调用 summary 工具写下总结。';

/** 压缩小会话用的系统提示词（没有提示词文件时用）。 */
const PROMPT_COMPRESS = '把下面的对话压缩成更短的摘要，保留关键事实、约定和未完成的事。只输出摘要，不要解释。';


/** 资源服务。 */
export class Resources extends cordis.Service {
  /** 运行时目录里的路径。 */
  readonly paths: RuntimePaths;

  /** 数据库连接；会话、机器人的往来记录都存在里面。插件拔掉时关。 */
  readonly db: Database;

  /** 校验后的配置。后面的函数直接用，不再检查。 */
  private readonly config: JmbotsConfig;

  /** 各家建好的 pi 集合：供应商名 → 集合。假模型不建。 */
  private readonly registries = new Map<string, piAi.MutableModels>();

  /**
   * 算路径、建目录、读配置并校验一次、开数据库、把 pi 的供应商建好。
   * @param ctx Cordis 给的 ctx。
   * @param config 运行时目录。
   * @throws 找不到 config.yaml、不是合法 YAML、哪一项不对时抛错；错误信息不带配置原文。
   */
  constructor(ctx: cordis.Context, config: ResourcesConfig) {
    super(ctx, 'resources');
    //M paths = 由 config.dir 拼出来；目录没有就建。
    const root = path.resolve(config.dir);
    this.paths = {
      root,
      config: path.join(root, 'config.yaml'),
      db: path.join(root, 'data', 'jmbots7.db'),
      bots: path.join(root, 'bots'),
      prompts: path.join(root, 'prompts'),
      memory: path.join(root, 'memory'),
      channels: path.join(root, 'channels'),
    };
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(this.paths.bots, { recursive: true });
    fs.mkdirSync(this.paths.prompts, { recursive: true });
    fs.mkdirSync(this.paths.memory, { recursive: true });
    fs.mkdirSync(this.paths.channels, { recursive: true });

    //M 读 paths.config：解析 YAML，交给 utils/Checks.ts 的 checkConfig 校验一次，得到 JmbotsConfig，存到私有字段。
    this.config = loadConfig(this.paths.config);
    //G 后面的函数直接用这份配置，不再检查。

    //M 照 providers 里的每一家，用 pi 的 createProvider 建好，放进一个 pi 集合。只建这一次。
    for (const [name, provider] of Object.entries(this.config.providers)) {
      if (name === 'fake' || provider.baseUrl.startsWith('fake:')) {
        continue;
      }
      this.registries.set(name, buildRegistry(name, provider));
    }

    //M 开数据库 paths.db；登记“拔掉时关库”。
    this.db = new Database(this.paths.db, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.ctx.effect(() => {
      return () => {
        this.db.close();
      };
    });

    //M ctx.on('session/prompt', (event) => this.onPrompt(event))。
    this.ctx.on('session/prompt', (event) => {
      this.onPrompt(event);
    });
  }

  /**
   * 一个机器人的文件夹，没有就建。
   * @param bot 机器人名。
   * @returns 工作区和记忆两个目录。
   * 副作用：可能建目录。
   */
  botDir(bot: string): BotDir {
    const workspace = path.join(this.paths.bots, bot, 'workspace');
    const memory = path.join(this.paths.bots, bot, 'memory');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(memory, { recursive: true });
    return { workspace, memory };
  }

  /**
   * 照“供应商名/模型 ID”交回建好的 pi 模型。
   * @param name 供应商名/模型 ID。
   * @returns chat() 要的那个模型。
   * @throws 引用了没配置的供应商时抛错。
   */
  modelOf(name: string): ModelHandle {
    const slash = name.indexOf('/');
    if (slash <= 0 || slash === name.length - 1) {
      throw new Error('模型名必须是“供应商名/模型 ID”');
    }
    const providerName = name.slice(0, slash);
    const modelId = name.slice(slash + 1);
    const provider = this.config.providers[providerName];
    if (provider === undefined) {
      throw new Error(`没有配置供应商 ${providerName}`);
    }
    const written = provider.models[modelId];
    const piModel = makePiModel(providerName, modelId, provider, written);
    if (providerName === 'fake' || provider.baseUrl.startsWith('fake:')) {
      return { registry: piAi.createModels(), piModel, apiKey: provider.apiKey };
    }
    const registry = this.registries.get(providerName);
    if (registry === undefined) {
      throw new Error(`没有配置供应商 ${providerName}`);
    }
    return { registry, piModel, apiKey: provider.apiKey };
  }

  /** @returns 新会话默认用哪个模型，“供应商名/模型 ID”。 */
  getDefaultModel(): string {
    return this.config.defaultModel;
  }

  /** @returns 启用的机器人名单。 */
  getBots(): BotConfig[] {
    return this.config.bots;
  }

  /** @returns 一轮最多走几步（engine.max_rounds）。 */
  getMaxSteps(): number {
    return this.config.maxSteps;
  }

  /** @returns 模型请求出错怎么重试。 */
  getRetry(): RetryConfig {
    return this.config.retry;
  }

  /**
   * config.yaml 的 plugins 段：要挂哪些插件，各自的配置是什么。
   * @returns 一项一个插件，照写的先后。不写 plugins 段时是 cli、base-tools、default-dialog 三个，配置都是空的。
   */
  getPlugins(): PluginEntry[] {
    return this.config.plugins;
  }

  /**
   * 响应 session/prompt：往事件里写系统提示词的前两段。
   * @param event 会话和分段的数组。
   * 副作用：读提示词文件和记忆文件，每次现读。
   */
  private onPrompt(event: PromptEvent): void {
    const kind = event.session.row.kind;
    const language = languageOf(this.config.bots, event.session.row.bot);
    //M 第一段看会话的种类：
    //M   default  → “你只回答简单的问题和分派，绝对不自己干活”那一套；
    //M   work     → 基础规则（DSH 那一套）；
    //M   compress → 压缩用的那一套。
    const first = readPrompt(this.paths.prompts, kind, language);
    //M 第二段：这个机器人的记忆（botDir(bot).memory 下的）加上用户级的记忆（paths.memory 下的）。
    const second = [
      readMemoryDir(this.botDir(event.session.row.bot).memory),
      readMemoryDir(this.paths.memory),
    ].filter((part) => part !== '').join('\n\n');
    //M event.parts.push(第一段, 第二段)。
    event.parts.push(first);
    if (second !== '') {
      event.parts.push(second);
    }
  }
}


/**
 * 读并校验 config.yaml。错误信息不带原文（里面有密钥）。
 * @param file 配置文件的绝对路径。
 * @throws 找不到、不是合法 YAML、哪一项不对。
 */
function loadConfig(file: string): JmbotsConfig {
  if (!fs.existsSync(file)) {
    throw new Error('找不到 config.yaml（应放在运行时目录里）');
  }
  /** 文件内容只在这里用，不往外传、不打印。 */
  const text = fs.readFileSync(file, 'utf8');
  /** YAML 文档；错误收在 errors 里，不带原文片段。 */
  const document = yaml.parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error('config.yaml 不是合法的 YAML');
  }
  return checks.checkConfig(document.toJSON());
}


/**
 * 为一家真的供应商建一个 pi 集合。写法跟 learn/Agent.ts 一样。
 * @param name 供应商名。
 * @param provider 校验后的这一家。
 */
function buildRegistry(name: string, provider: ProviderConfig): piAi.MutableModels {
  const baseUrl = provider.baseUrl.replace(/\/+$/u, '');
  const apiKey = provider.apiKey === '' ? 'no-key' : provider.apiKey;
  const models: piAi.Model<piAi.Api>[] = Object.entries(provider.models).map(([id, size]) => {
    return makePiModel(name, id, provider, size);
  });
  if (models.length === 0) {
    // 没有手写模型时先放一个占位，真正用时 modelOf 会再建这条。
    models.push(makePiModel(name, '_', provider, undefined));
  }
  const registry = piAi.createModels();
  registry.setProvider(piAi.createProvider({
    id: name,
    baseUrl,
    auth: {
      apiKey: {
        name: '配置里的密钥',
        resolve: () => Promise.resolve({ auth: { apiKey }, source: 'request' }),
      },
    },
    models,
    api: CHAT_APIS[provider.api](),
  }));
  return registry;
}


/**
 * 拼一个 pi 的模型对象。
 * @param provider 供应商名。
 * @param id 模型 ID。
 * @param config 这一家的配置。
 * @param size 手写的长度；没写用默认。
 */
function makePiModel(
  provider: string,
  id: string,
  config: ProviderConfig,
  size: { contextWindow: number; maxTokens: number } | undefined,
): piAi.Model<piAi.Api> {
  return {
    id,
    name: id,
    provider,
    baseUrl: config.baseUrl.replace(/\/+$/u, ''),
    api: config.api,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: size?.contextWindow ?? 128000,
    maxTokens: size?.maxTokens ?? 8192,
  };
}


/**
 * 这个机器人用哪种语言的提示词。
 * @param bots 名单。
 * @param bot 机器人名。
 */
function languageOf(bots: BotConfig[], bot: string): 'zh' | 'en' {
  const found = bots.find((item) => item.name === bot);
  return found?.language ?? 'zh';
}


/**
 * 读一类会话的提示词文件；没有就用内置的那一套。
 * 文件名：prompts/<种类>.<语言>.md，比如 default.zh.md。
 * @param dir 提示词目录。
 * @param kind 会话种类。
 * @param language 语言。
 */
function readPrompt(dir: string, kind: string, language: 'zh' | 'en'): string {
  const file = path.join(dir, `${kind}.${language}.md`);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').trim();
  }
  if (kind === 'default') {
    return PROMPT_DEFAULT;
  }
  if (kind === 'compress') {
    return PROMPT_COMPRESS;
  }
  return PROMPT_WORK;
}


/**
 * 读一个记忆目录下所有文本文件，按文件名拼起来。
 * @param dir 记忆目录。
 */
function readMemoryDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    return '';
  }
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.md') || name.endsWith('.txt')).sort();
  /** 各文件的内容。 */
  const parts: string[] = [];
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8').trim();
    if (text !== '') {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}
