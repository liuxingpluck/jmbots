/**
 * 校验：外面进来的东西只在这里查，一处一次。查过以后，骨架里面直接用，不再查、不再补默认值。
 * 骨架有两样外面进来的东西：命令行参数、config.yaml 里骨架自己用到的那几项。
 * 另外两样不在这里：插件要的配置（它自己那一段、顶层的 bots 这些）由插件自己查；
 * 模型给工具的参数在 Tools.execute 里照工具的定义查。
 */
import * as path from 'node:path';
import * as process from 'node:process';
import type { JmbotsConfig, PluginEntry, ProviderConfig } from '../Resources.ts';
import * as embedded from './Embedded.ts';
import * as textModule from './Text.ts';


/** 命令行参数，校验后。 */
export interface MainArgs {
  /** 运行时目录的绝对路径；不写 --data / --runtime 时：编译版是程序旁边的 jmbotsData/，源码版是入口旁边的 jmbotsData/。 */
  dataDir: string;
  /** 是不是基地的试运行（--mode candidate）：只挂 http 做健康检查，不开渠道。 */
  candidate: boolean;
  /** 剩下的参数，原样交给要它的插件（命令行渠道、http 的 --port）。 */
  rest: string[];
}


/** 三种请求协议。 */
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;

/** 思考档，从不思考到最深。 */
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 不写 plugins 段时挂的插件。 */
const DEFAULT_PLUGINS = ['bots', 'cli', 'prompt', 'base-tools', 'bot-front-desk', 'summary'];

/** config.yaml 里没手写的模型用的保守值。Resources.modelOf 也用它。 */
export const MODEL_DEFAULTS = { contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ['text' as const] };


/**
 * 解析并校验命令行。Main.ts 调。已经去掉了 version / serve 子命令。
 * @param argv 去掉 bun、脚本路径、以及 version/serve 之后的参数。
 * @returns 运行时目录、是不是试运行，和剩下的参数（里面还可以有 --port）。
 * @throws --data / --runtime 后面没有值，或 --mode 不是 candidate 时抛错。
 */
export function checkArgs(argv: string[]): MainArgs {
  /** 剩下的参数。 */
  const rest = [...argv];
  /** 运行时目录；先看参数，没有再用默认。 */
  let dataDir: string | undefined;
  /** 是不是试运行。 */
  let candidate = false;

  //M --mode candidate：基地的试运行。认出来就从参数里删掉，别的值不认。
  const modeAt = rest.indexOf('--mode');
  if (modeAt >= 0) {
    const value = rest[modeAt + 1];
    if (value !== 'candidate') {
      throw new Error('--mode 只认 candidate');
    }
    rest.splice(modeAt, 2);
    candidate = true;
  }

  //M 运行时目录：先认 --data，再认 --runtime（基地用这个名字），都没写用默认的。
  dataDir = takePath(rest, '--data');
  if (dataDir === undefined) {
    dataDir = takePath(rest, '--runtime');
  }
  if (dataDir === undefined) {
    dataDir = defaultDataDir();
  }

  return { dataDir: path.resolve(dataDir), candidate, rest };
}


/**
 * 取出一个带值的旗标，并从参数里删掉。
 * @param rest 还没认完的参数，会被改。
 * @param flag 旗标，如 --data。
 * @returns 旗标后面的值；没有这个旗标是 undefined。
 * @throws 写了旗标却没有值时抛错。
 */
function takePath(rest: string[], flag: string): string | undefined {
  const at = rest.indexOf(flag);
  if (at < 0) return undefined;
  const value = rest[at + 1];
  if (value === undefined) {
    throw new Error(`${flag} 后面要写运行时目录`);
  }
  rest.splice(at, 2);
  return value;
}


/**
 * 没写 --data / --runtime 时的运行时目录。
 * @returns 绝对或相对路径，调用方再 resolve。
 */
function defaultDataDir(): string {
  if (embedded.isCompiled()) {
    return path.join(path.dirname(process.execPath), 'jmbotsData');
  }
  return path.join(path.dirname(process.argv[1] ?? ''), 'jmbotsData');
}


/**
 * 校验 config.yaml 里骨架用到的那几项，没写的补上默认值。Resources 的构造函数调。
 * @param raw YAML 解析出来的原始值。
 * @returns 校验后的配置。
 * @throws 哪一项不对就抛错；错误信息只说是哪一项、该写成什么样，不带配置原文（里面有密钥）。
 */
export function checkConfig(raw: unknown): JmbotsConfig {
  const root = record(raw, 'config.yaml');

  //M providers：每家要有 base_url；api_key 不写是空的（本地服务不要密钥）；api 不写是 openai-completions。
  //M   models 是手写的模型：上下文多长、最多输出多少、thinking 里有 off 以外的档就是会思考、vision: true 就收图片。
  //M   compat、model_compat 是发请求时的兼容设置，原样交给 pi（不认的项 pi 不管）。
  const providers: Record<string, ProviderConfig> = {};
  const providersWritten = record(root['providers'], 'providers');
  textModule.eachEntry(providersWritten, (name, value) => {
    /** 错误信息里说是哪一家，比如 providers.openrouter。 */
    const label = `providers.${name}`;
    const item = record(value, label);

    //M 这家手写的模型：一个个查，没写的项用保守值。
    const models: ProviderConfig['models'] = {};
    const modelsWritten = record(item['models'] ?? {}, `${label}.models`);
    textModule.eachEntry(modelsWritten, (id, written) => {
      const model = record(written ?? {}, `${label}.models.${id}`);
      const contextWindow = model['context_window'] ?? MODEL_DEFAULTS.contextWindow;
      const maxTokens = model['max_output_tokens'] ?? MODEL_DEFAULTS.maxTokens;
      /** 手写的思考档；里面有 off 以外的档，就算会思考。 */
      const levels = model['thinking'];
      const reasoning = Array.isArray(levels) && levels.some((level) => level !== 'off');
      models[id] = {
        contextWindow: int(contextWindow, `${label} 的 context_window`),
        maxTokens: int(maxTokens, `${label} 的 max_output_tokens`),
        reasoning,
        input: model['vision'] === true ? ['text', 'image'] : ['text'],
      };
    });

    //M 地址去掉末尾的斜杠；api_key 不写是空的；api 不写是 openai-completions。
    const baseUrl = text(item['base_url'], `${label}.base_url`);
    const apiWritten = item['api'] ?? 'openai-completions';
    const api = oneOf(apiWritten, APIS, `${label}.api`);
    const compat = record(item['compat'] ?? {}, `${label}.compat`);

    //M 个别模型的兼容设置：模型 ID → 一组“名字: 值”。
    const modelCompat: ProviderConfig['modelCompat'] = {};
    const modelCompatWritten = record(item['model_compat'] ?? {}, `${label}.model_compat`);
    textModule.eachEntry(modelCompatWritten, (id, written) => {
      modelCompat[id] = record(written, `${label}.model_compat.${id}`);
    });

    providers[name] = {
      baseUrl: baseUrl.replace(/\/+$/u, ''),
      apiKey: String(item['api_key'] ?? ''),
      api,
      models,
      compat,
      modelCompat,
    };
  });

  //M default_model：写成“供应商名/模型 ID”，供应商要在 providers 里。
  const defaultModel = text(root['default_model'], 'default_model');
  const providerName = defaultModel.slice(0, defaultModel.indexOf('/'));
  if (providers[providerName] === undefined) {
    throw new Error('default_model 要写成“供应商名/模型 ID”，供应商要在 providers 里');
  }

  //M plugins：一张清单，每项 { name, config?, disabled? }；disabled 是 true 的去掉。整段不写就挂默认的那几个。
  const plugins: PluginEntry[] = [];
  const pluginsWritten = root['plugins'] ?? DEFAULT_PLUGINS.map((name) => ({ name }));
  for (const value of list(pluginsWritten, 'plugins')) {
    const item = record(value, 'plugins 里的每一项');
    if (item['disabled'] === true) continue;

    const name = text(item['name'], 'plugins 里每一项的 name');
    const config = item['config'] ?? {};
    plugins.push({ name, config });
  }

  //M engine：一轮最多几步、新会话的思考档、模型请求出错怎么重试。都可以不写。
  //M   不写的默认：30 步、思考档 low、重试 5 次、第一次等 3 秒、一次请求最多等 120 秒。
  const engine = record(root['engine'] ?? {}, 'engine');
  const retry = record(engine['retry'] ?? {}, 'engine.retry');
  const maxSteps = int(engine['max_rounds'] ?? 30, 'engine.max_rounds');
  const thinking = oneOf(engine['thinking'] ?? 'low', THINKING, 'engine.thinking');
  return {
    defaultModel,
    providers,
    plugins,
    maxSteps,
    thinking,
    retry: {
      times: int(retry['times'] ?? 5, 'engine.retry.times'),
      waitMs: int(retry['wait_ms'] ?? 3000, 'engine.retry.wait_ms'),
      timeoutMs: int(retry['timeout_ms'] ?? 120000, 'engine.retry.timeout_ms'),
    },
  };
}


/**
 * 要一组“名字: 值”。
 * @param value 原始值。
 * @param label 是配置里的哪一项，写进错误信息。
 */
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 没写，或者写得不对：要写成一组“名字: 值”`);
  }
  return value as Record<string, unknown>;
}


/**
 * 要一张清单。
 * @param value 原始值。
 * @param label 是配置里的哪一项，写进错误信息。
 */
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 要写成一张清单`);
  }
  return value as unknown[];
}


/**
 * 要非空的文字。
 * @param value 原始值。
 * @param label 是配置里的哪一项，写进错误信息。
 */
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} 要写成非空的文字`);
  }
  return value;
}


/**
 * 要正整数。
 * @param value 原始值。
 * @param label 是配置里的哪一项，写进错误信息。
 */
function int(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 要写成正整数`);
  }
  return value;
}


/**
 * 要几个固定写法里的一个。
 * @param value 原始值。
 * @param allowed 允许的写法。
 * @param label 是配置里的哪一项，写进错误信息。
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const found = allowed.find((item) => item === value);
  if (found === undefined) {
    throw new Error(`${label} 只能是 ${allowed.join('、')}`);
  }
  return found;
}
