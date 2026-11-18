/**
 * 校验：外面进来的东西只在这里查，一处一次。查过以后，骨架里面直接用，不再查、不再补默认值。
 * 骨架有两样外面进来的东西：命令行参数、config.yaml 里骨架自己用到的那几项。
 * 几个插件共用的校验也放这里（checkCount：网址里的非负整数；checkDirs、checkGrants：approval 的可信目录配置、POST /api/message 的授权目录）；
 * 只有一个插件用的校验在那个插件里（relay/Checks.ts：外部 AI 打招呼、交回结果；model-catalog/Checks.ts：会话打分），
 * 它们借这里的 record、list、text、texts、oneOf 查字段。
 * 另外两样不在这里：插件要的配置（它自己那一段、顶层的 bots 这些）由插件自己查；
 * 模型给工具的参数在 Tools.execute 里照工具的定义查。
 */
import * as path from 'node:path';
import * as process from 'node:process';
import type { JmbotsConfig, PluginEntry, ProviderConfig } from '../Resources.ts';
import * as embedded from './Embedded.ts';
import * as textModule from './Text.ts';
import * as workspaceModule from './Workspace.ts';


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

/**
 * 不写 plugins 段时挂的插件。前台和系统提示词在 bots 里（11-17 并进原 bot-front-desk、prompt）；base-tools 已并入 file-tools；summary 已并入 context-fit。
 * workspaces 排在 bots 前面：bots 依赖它（11-17）。
 */
const DEFAULT_PLUGINS = ['workspaces', 'bots', 'cli', 'file-tools', 'context-fit'];

/** config.yaml 里没手写的模型用的保守值。Resources.getModel 也用它。 */
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
  //M 编译版以可执行文件所在目录为基准，源码跑时以入口脚本目录为基准。
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
  //M 先校验顶层是否为配置对象，再分别解析供应商、默认模型、插件与引擎段。
  const root = record(raw, 'config.yaml');

  //M providers：每家要有 base_url；api_key 不写是空的（本地服务不要密钥）；api 不写是 openai-completions。
  //M   models 是手写的模型：上下文多长、最多输出多少、thinking 里有 off 以外的档就是会思考、vision: true 就收图片。
  //M   compat、model_compat 是发请求时的兼容设置，原样交给 pi（不认的项 pi 不管）。
  const providers: Record<string, ProviderConfig> = {};
  const providersWritten = record(root['providers'], 'providers');
  textModule.eachEntry(providersWritten, (name, value) => {
    /** 错误信息里说是哪一家，比如 providers.openrouter。 */
    const label = `providers.${name}`;
    //M 校验这家供应商配置是否为对象，再逐个校验它手写的模型条目。
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
      let input: ('text' | 'image')[] = ['text'];
      if (model['vision'] === true) {
        input = ['text', 'image'];
      }

      //M 校验上下文窗与输出上限均为正整数，连同推理与图片能力登记进该供应商模型表。
      models[id] = {
        contextWindow: int(contextWindow, `${label} 的 context_window`),
        maxTokens: int(maxTokens, `${label} 的 max_output_tokens`),
        reasoning,
        input,
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

    //M 跳过已禁用的插件后，校验插件名并把配置原文透传给各插件自检。
    const name = text(item['name'], 'plugins 里每一项的 name');
    const config = item['config'] ?? {};
    plugins.push({ name, config });
  }

  //M engine：新会话的思考档、模型请求出错怎么重试。都可以不写。一轮不限步数，没有这一项。
  //M   不写的默认：思考档 low、重试 5 次、第一次等 3 秒、一次请求最多等 120 秒。
  const engine = record(root['engine'] ?? {}, 'engine');
  const retry = record(engine['retry'] ?? {}, 'engine.retry');
  const thinking = oneOf(engine['thinking'] ?? 'low', THINKING, 'engine.thinking');
  return {
    defaultModel,
    providers,
    plugins,
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
export function record(value: unknown, label: string): Record<string, unknown> {
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
export function list(value: unknown, label: string): unknown[] {
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
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} 要写成非空的文字`);
  }
  return value;
}


/**
 * 要一张清单，每项都是非空的文字。
 * @param value 原始值。
 * @param label 是哪一项，写进错误信息。
 */
export function texts(value: unknown, label: string): string[] {
  //M 先校验外层为数组，再逐项检查每个元素均为非空文字。
  const items = list(value, label);
  return items.map((item, index) => text(item, `${label}[${String(index)}]`));
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
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  //G 仅接受枚举清单里出现的固定值，其余抛错提示合法范围。
  const found = allowed.find((item) => item === value);
  if (found === undefined) {
    throw new Error(`${label} 只能是 ${allowed.join('、')}`);
  }
  return found;
}


/** 网址里非负整数的写法：只有数字（不认 1e3、0x10、+5、2.0、带空白的）。 */
const COUNT_PATTERN = /^\d+$/u;


/**
 * 查网址里的一个可选非负整数（before、after、since、limit、message 这类）。journal、web-api 的 GET 接口调。
 * 和 Text.ts 的 getNumber 不一样：写错了不按默认值，而是回 400，让调的人知道写错了。
 * @param value 网址里的值，可能没给。
 * @param key 参数名，报错用。
 * @returns 那个整数；没给、给了空串是 undefined。
 * @throws 带 statusCode 400 的错：不是只有数字的非负整数。Fastify 自己的错误处理、web-api 的 setErrorHandler 都照 statusCode 回 400。
 */
export function checkCount(value: string | undefined, key: string): number | undefined {
  //M 没给、给了空串：当没写。
  if (value === undefined || value === '') return undefined;

  //G 不是只有数字 → 抛带 400 的错。
  if (!COUNT_PATTERN.test(value)) {
    const failure = new Error(`${key} 要是非负整数`);
    throw Object.assign(failure, { statusCode: 400 });
  }

  return Number(value);
}


/**
 * 查一组可信目录：approval 的 trusted_dirs 配置、POST /api/message 的 grants.dirs 调（用户 11-18 #169）。
 * 这里规范化一次（Workspace.ts 的 getPathKey：解开 ..、去掉末尾分隔符、Windows 上转小写），以后 approval 直接拿来比。
 * @param raw 外面给的：绝对路径的数组；不给是没有。
 * @param key 报错用的名字，如 approval.trusted_dirs。
 * @returns 规范化后的绝对路径；不给是空数组。
 * @throws 带 statusCode 400 的错：不是数组、有一项不是非空字符串、不是绝对路径。插件配置写错时插件挂不上，HTTP 正文写错时回 400。
 */
export function checkDirs(raw: unknown, key: string): string[] {
  //M 没给：没有可信目录。
  if (raw === undefined) return [];

  //G 不是数组 → 抛带 400 的错。
  if (!Array.isArray(raw)) {
    const failure = new Error(`${key} 要是绝对路径的数组`);
    throw Object.assign(failure, { statusCode: 400 });
  }

  const dirs: string[] = [];
  for (const item of raw) {
    //G 每一项都要是绝对路径：相对路径不知道相对谁，不认。
    if (typeof item !== 'string' || item.trim() === '' || !path.isAbsolute(item.trim())) {
      const failure = new Error(`${key} 的每一项都要是绝对路径：${String(item)}`);
      throw Object.assign(failure, { statusCode: 400 });
    }

    //M 规范化后收下。
    const dir = workspaceModule.getPathKey(item.trim());
    dirs.push(dir);
  }
  return dirs;
}


/** POST /api/message 的授权范围，校验后（用户 11-18 #169）。 */
export interface Grants {
  /** 这场会话里 exec 不用再问的目录：checkDirs 规范化过的绝对路径。 */
  dirs: string[];
}


/**
 * 查 POST /api/message 的 grants：本人、中控交代任务时写明哪些目录可信，这场会话里 exec 在这些目录里的命令直接放行（approval 读）。
 * @param raw 请求体里的 grants；不给是没有。
 * @returns 校验、规范化后的授权范围；不给是 undefined。
 * @throws 带 statusCode 400 的错：不是对象，或 dirs 不对（见 checkDirs）。
 */
export function checkGrants(raw: unknown): Grants | undefined {
  //M 没给：这场会话不带授权。
  if (raw === undefined) return undefined;

  //G 不是对象 → 抛带 400 的错。
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const failure = new Error('grants 要写成 { dirs: [绝对路径…] }');
    throw Object.assign(failure, { statusCode: 400 });
  }

  //M 目录照 checkDirs 查一次、规范化一次。
  const written = raw as Record<string, unknown>;
  const dirs = checkDirs(written['dirs'], 'grants.dirs');
  return { dirs };
}


/** 插件版本号的写法：x.y.z，三段都是数字。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;


/**
 * 查一个插件的版本号：每个插件的 index.ts 都要导出 version，写成 x.y.z。plugins/Index.ts 登记自带插件时调。
 * @param name 插件名（自带名单里的名字）。
 * @param version 它的 index.ts 导出的 version。
 * @throws 没写，或不是 x.y.z 时抛错，写明是哪个插件。
 */
export function checkVersion(name: string, version: unknown): void {
  //M 没写版本号：报错，写明插件。
  if (version === undefined) throw new Error(`插件 ${name} 没写版本号：它的 index.ts 要导出 version，写成 x.y.z，比如 '1.0.0'`);

  //M 不是 x.y.z：报错，写明插件和写错的值。
  const written = String(version);
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error(`插件 ${name} 的版本号 ${written} 不对：要写成 x.y.z，比如 '1.0.0'`);
}
