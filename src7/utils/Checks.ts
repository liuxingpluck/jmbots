/**
 * 校验：外面进来的东西只在这里查，一处一次。查过以后，骨架里面直接用，不再查、不再补默认值。
 * 现在有三样外面进来的东西：命令行参数、config.yaml、别人写的插件。
 * 审核、安全这类非写不可的检查，以后也加在 utils/ 里；骨架的模块里只留主线。
 */
import * as path from 'node:path';
import * as process from 'node:process';
import type { PluginModule } from '../plugins/Index.ts';
import type { BotConfig, JmbotsConfig, PluginEntry, ProviderConfig, RetryConfig } from '../Resources.ts';


/** 命令行参数，校验后。 */
export interface MainArgs {
  /** 运行时目录的绝对路径；不写 --data 就是程序旁边的 jmbotsData/。 */
  dataDir: string;
  /** 剩下的参数，原样交给命令行渠道。 */
  rest: string[];
}


/**
 * 解析并校验命令行。Main.ts 调。
 * @param argv 去掉 bun 和脚本路径之后的参数。
 * @returns 校验后的参数。
 * @throws --data 后面没有值时抛错。
 */
export function checkArgs(argv: string[]): MainArgs {
  /** 剩下交给命令行渠道的参数。 */
  const rest: string[] = [];
  /** 运行时目录；不写就用默认。 */
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--data') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        throw new Error('--data 后面要写运行时目录');
      }
      dataDir = path.resolve(value);
      i += 1;
      continue;
    }
    if (token !== undefined) {
      rest.push(token);
    }
  }
  // 默认：Main.ts 所在目录旁边的 jmbotsData/（开发时是 src7/jmbotsData）。
  if (dataDir === undefined) {
    const script = process.argv[1];
    const here = script === undefined ? process.cwd() : path.dirname(path.resolve(script));
    dataDir = path.resolve(here, 'jmbotsData');
  }
  return { dataDir, rest };
}


/**
 * 校验 config.yaml 里骨架用到的那几项，没写的补上默认值。Resources 的构造函数调。
 * @param raw YAML 解析出来的原始值。
 * @returns 校验后的配置。
 * @throws 哪一项不对就抛错；错误信息只说是哪一项、该写成什么样，不带配置原文（里面有密钥）。
 */
export function checkConfig(raw: unknown): JmbotsConfig {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.yaml 顶层必须是一个对象');
  }
  /** 原始对象，按键取；取值时不把原文拼进错误。 */
  const obj = raw as Record<string, unknown>;

  //M providers：每家要有 http 或 https 的 base_url；api_key 不写是空串；api 不写是 openai-completions。
  //  供应商名叫 fake，或地址是 fake:// 的，是离线假模型，不要求真的 http 地址。
  const providers = readProviders(obj['providers']);

  //M default_model：必须是“供应商名/模型 ID”，供应商要在 providers 里。
  const defaultModel = readDefaultModel(obj['default_model'], providers);

  //M bots：名单；不写就是一个叫“助手”的中文机器人。
  const bots = readBots(obj['bots']);

  //M engine.max_rounds：正整数，不写用 30。engine.retry：次数不写用 5，间隔不写用 3000 毫秒，超时不写用 120000 毫秒。
  const engine = isRecord(obj['engine']) ? obj['engine'] : {};
  const maxSteps = readPositiveInt(engine['max_rounds'], 30, 'engine.max_rounds');
  const retryRaw = isRecord(engine['retry']) ? engine['retry'] : {};
  const retry: RetryConfig = {
    times: readPositiveInt(retryRaw['times'], 5, 'engine.retry.times'),
    waitMs: readPositiveInt(retryRaw['wait_ms'] ?? retryRaw['waitMs'], 3000, 'engine.retry.wait_ms'),
    timeoutMs: readPositiveInt(retryRaw['timeout_ms'] ?? retryRaw['timeoutMs'], 120000, 'engine.retry.timeout_ms'),
  };

  //M plugins：一张清单，每项 { name, config?, disabled? }。name 必须是非空字符串；config 不写是空对象；
  //M   disabled 是 true 的那几项去掉。整段不写就是 cli、base-tools、default-dialog 三个。
  const plugins = readPlugins(obj['plugins']);

  return { defaultModel, providers, bots, maxSteps, retry, plugins };
}


/**
 * 校验照路径加载进来的插件：别人写的东西，导出的不一定对。Main.ts 调。
 * @param loaded import 进来的模块。
 * @param from 是从哪加载的，只用来写进错误信息。
 * @returns 能交给 Cordis 挂的插件。
 * @throws 没有字符串的 name、没有函数 apply、inject 不是字符串数组时抛错。
 */
export function checkPlugin(loaded: unknown, from: string): PluginModule {
  const mod = unwrapDefault(loaded);
  if (!isRecord(mod)) {
    throw new Error(`插件 ${from} 导出的不是一个对象`);
  }
  const name = mod['name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error(`插件 ${from} 要导出非空字符串 name`);
  }
  const apply = mod['apply'];
  if (typeof apply !== 'function') {
    throw new Error(`插件 ${from} 要导出函数 apply`);
  }
  const inject = mod['inject'];
  if (inject !== undefined) {
    if (!Array.isArray(inject) || inject.some((item) => typeof item !== 'string')) {
      throw new Error(`插件 ${from} 的 inject 必须是字符串数组`);
    }
  }
  return mod as unknown as PluginModule;
}


/** 是不是普通对象（不是数组、不是 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


/**
 * 模块有 default 导出就用 default（和 DSH 的加载器一样）。
 * @param loaded import 进来的值。
 */
function unwrapDefault(loaded: unknown): unknown {
  if (isRecord(loaded) && 'default' in loaded && loaded['default'] !== undefined) {
    const inner = loaded['default'];
    if (isRecord(inner) && (typeof inner['apply'] === 'function' || typeof inner['name'] === 'string')) {
      return inner;
    }
  }
  return loaded;
}


/**
 * 读 providers 段。
 * @param raw 原始值。
 * @throws 不是对象、某家缺地址或地址不像 http(s)（假模型除外）时抛错。
 */
function readProviders(raw: unknown): Record<string, ProviderConfig> {
  if (raw === undefined) {
    throw new Error('config.yaml 要有 providers 段');
  }
  if (!isRecord(raw)) {
    throw new Error('providers 必须是一个对象：名字 → 这一家的配置');
  }
  /** 校验后的各家。 */
  const result: Record<string, ProviderConfig> = {};
  for (const name of Object.keys(raw)) {
    if (name === '') {
      throw new Error('providers 里的供应商名不能是空的');
    }
    const item = raw[name];
    if (!isRecord(item)) {
      throw new Error(`providers.${name} 必须是一个对象`);
    }
    const baseUrl = item['base_url'] ?? item['baseUrl'];
    if (typeof baseUrl !== 'string' || baseUrl === '') {
      throw new Error(`providers.${name} 要有 base_url`);
    }
    const fake = name === 'fake' || baseUrl.startsWith('fake:');
    if (!fake && !/^https?:\/\//u.test(baseUrl)) {
      throw new Error(`providers.${name} 的 base_url 要以 http:// 或 https:// 开头（离线假模型用 fake://）`);
    }
    const apiKeyRaw = item['api_key'] ?? item['apiKey'];
    const apiKey = apiKeyRaw === undefined ? '' : String(apiKeyRaw);
    const apiRaw = item['api'];
    const api = readApi(apiRaw, name);
    const models = readProviderModels(item['models'], name);
    result[name] = { baseUrl, apiKey, api, models };
  }
  if (Object.keys(result).length === 0) {
    throw new Error('providers 里至少要有一家供应商');
  }
  return result;
}


/**
 * 读一家的协议。
 * @param raw 原始值。
 * @param name 供应商名，只用于错误信息。
 */
function readApi(raw: unknown, name: string): ProviderConfig['api'] {
  if (raw === undefined) {
    return 'openai-completions';
  }
  if (raw === 'openai-completions' || raw === 'openai-responses' || raw === 'anthropic-messages') {
    return raw;
  }
  throw new Error(`providers.${name} 的 api 只能是 openai-completions、openai-responses 或 anthropic-messages`);
}


/**
 * 读一家手写的模型清单。
 * @param raw 原始值。
 * @param name 供应商名，只用于错误信息。
 */
function readProviderModels(raw: unknown, name: string): ProviderConfig['models'] {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new Error(`providers.${name}.models 必须是一个对象`);
  }
  /** 模型 ID → 长度。 */
  const models: ProviderConfig['models'] = {};
  for (const id of Object.keys(raw)) {
    const item = raw[id];
    if (!isRecord(item)) {
      throw new Error(`providers.${name}.models 里每个模型要是一个对象`);
    }
    const contextWindow = readPositiveInt(item['context_window'] ?? item['contextWindow'], 128000, `providers.${name}.models 的 context_window`);
    const maxTokens = readPositiveInt(item['max_tokens'] ?? item['maxTokens'], 8192, `providers.${name}.models 的 max_tokens`);
    models[id] = { contextWindow, maxTokens };
  }
  return models;
}


/**
 * 读 default_model。
 * @param raw 原始值。
 * @param providers 已经校验过的供应商。
 */
function readDefaultModel(raw: unknown, providers: Record<string, ProviderConfig>): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error('default_model 必须是“供应商名/模型 ID”');
  }
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error('default_model 必须是“供应商名/模型 ID”');
  }
  const provider = raw.slice(0, slash);
  if (providers[provider] === undefined) {
    throw new Error('default_model 里的供应商不在 providers 里');
  }
  return raw;
}


/**
 * 读 bots 名单。
 * @param raw 原始值。
 */
function readBots(raw: unknown): BotConfig[] {
  if (raw === undefined) {
    return [{ name: '助手', language: 'zh' }];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('bots 必须是非空的名单；不写这一段时会默认一个叫“助手”的机器人');
  }
  /** 校验后的名单。 */
  const bots: BotConfig[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || item['name'] === '') {
      throw new Error('bots 里每一项要有非空的 name');
    }
    const language = item['language'] === undefined ? 'zh' : item['language'];
    if (language !== 'zh' && language !== 'en') {
      throw new Error('bots 里的 language 只能是 zh 或 en');
    }
    bots.push({ name: item['name'], language });
  }
  return bots;
}


/**
 * 读正整数，没写用默认。
 * @param raw 原始值。
 * @param fallback 默认值。
 * @param label 错误信息里说的字段名。
 */
function readPositiveInt(raw: unknown, fallback: number, label: string): number {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return raw;
}


/**
 * 读 plugins 段。
 * @param raw 原始值。
 */
function readPlugins(raw: unknown): PluginEntry[] {
  if (raw === undefined) {
    return [
      { name: 'cli', config: {} },
      { name: 'base-tools', config: {} },
      { name: 'default-dialog', config: {} },
    ];
  }
  if (!Array.isArray(raw)) {
    throw new Error('plugins 必须是一个清单，一项一个插件');
  }
  /** 校验后、去掉 disabled 的。 */
  const plugins: PluginEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || item['name'] === '') {
      throw new Error('plugins 里每一项要有非空的 name');
    }
    if (item['disabled'] === true) {
      continue;
    }
    const config = item['config'] === undefined ? {} : item['config'];
    plugins.push({ name: item['name'], config });
  }
  return plugins;
}
