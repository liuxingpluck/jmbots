/**
 * 校验：外面进来的东西只在这里查，一处一次。查过以后，骨架里面直接用，不再查、不再补默认值。
 * 骨架有两样外面进来的东西：命令行参数、config.yaml 里骨架自己用到的那几项。
 * 插件的 HTTP 接口收到的正文、网址参数也放这里查（checkRating：POST /api/model-notes/rate 的会话打分；checkCount：网址里的非负整数；
 * checkAgentHello、checkTaskResult：外部 AI 打招呼报的能力、交回的结果，见 plugins/relay/AgentTasks.ts）。
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

/**
 * 不写 plugins 段时挂的插件。前台和系统提示词在 bots 里（11-17 并进原 bot-front-desk、prompt）；base-tools 已并入 file-tools；summary 已并入 context-fit。
 * workspaces 排在 bots 前面：bots 依赖它（11-17）。
 */
const DEFAULT_PLUGINS = ['workspaces', 'bots', 'cli', 'file-tools', 'context-fit'];

/** config.yaml 里没手写的模型用的保守值。Resources.getModel 也用它。 */
export const MODEL_DEFAULTS = { contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ['text' as const] };


/** 一条会话打分请求，校验后。checkRating 交回，model-notes 插件的 ModelNotes.rate 收。 */
export interface RatingInput {
  /** 被打分的会话号（如 20 位数字时刻号或旧的短会话号）。 */
  session: string;
  /** 谁打的分：用户、Claude、Codex、Grok、Antigravity……写什么记什么。 */
  by: string;
  /** 分数，1 到 5 的整数。 */
  score: number;
  /** 一句话评价；没写是空串。 */
  note: string;
}


/** 模型 ID 里用 / 隔开的每一段：字母或数字开头，后面只能是字母、数字、点、下划线、横杠（要当文件名用）。 */
const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** 会话号允许的字符：字母、数字、下划线、横杠（防路径穿越与换行）。 */
const SESSION_ID = /^[A-Za-z0-9_-]+$/u;

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
 * 要一张清单，每项都是非空的文字。
 * @param value 原始值。
 * @param label 是哪一项，写进错误信息。
 */
function texts(value: unknown, label: string): string[] {
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
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  //G 仅接受枚举清单里出现的固定值，其余抛错提示合法范围。
  const found = allowed.find((item) => item === value);
  if (found === undefined) {
    throw new Error(`${label} 只能是 ${allowed.join('、')}`);
  }
  return found;
}


/**
 * 校验模型 ID（由会话记录读出，要用来拼 models/ 下的文件名）：
 * 用 / 隔开的每一段字母或数字开头，只有字母、数字、点、下划线、横杠；不能有 __（文件名里 __ 代表 /）。
 * @param model 模型 ID。
 * @returns 去掉两头空白的模型 ID。
 * @throws 格式不对时抛错。
 */
export function checkModelId(model: string): string {
  //G 校验模型 ID 为非空字符串且各斜杠分段符合安全文件名字符要求。
  const trimmed = text(model, 'model').trim();
  const segments = trimmed.split('/');
  const goodModel = segments.every((segment) => MODEL_SEGMENT.test(segment) && !segment.includes('__'));
  if (!goodModel) {
    const shape = '比如 magpie/workbuddy/deepseek-v4.1-flash：只用字母、数字、点、下划线、横杠和 /，不能有 __';
    throw new Error(`model 要写成模型 ID，${shape}`);
  }
  return trimmed;
}


/**
 * 校验一条会话打分（POST /api/model-notes/rate 的正文）。model-notes 插件的接口调，查过以后 ModelNotes.rate 直接用。
 * 一条评价写成 MD 里的一行，字段之间用“ · ”隔开，所以哪一项都不能换行，评价者里不能有“·”。
 * @param body 请求正文，原样。
 * @returns 去掉两头空白的 session、by、score、note；note 没写是空串。
 * @throws 哪一项不对就抛错，说清是哪一项、该怎么写。
 */
export function checkRating(body: unknown): RatingInput {
  //M 先把请求正文确认成键值对象，再逐项校验会话号、打分人和评语。
  const item = record(body, '评价');

  //M session：非空合法会话号（只含字母、数字、下划线、横杠）。
  const session = text(item['session'], 'session').trim();
  if (!SESSION_ID.test(session)) {
    throw new Error('session 要写成合法的会话号（只含字母、数字、下划线、横杠）');
  }

  //M by：谁打的分，非空；score：1 到 5 的整数。
  const by = text(item['by'], 'by').trim();
  const score = item['score'];
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error('score 要写成 1 到 5 的整数');
  }

  //M note：可以不写，写了要是文字。
  const noteWritten = item['note'] ?? '';
  if (typeof noteWritten !== 'string') {
    throw new Error('note 要写成文字（可以不写）');
  }

  //G 一条评价是一行：哪一项都不能换行；评价者里的“·”会和分隔符混在一起。
  const fields = [session, by, noteWritten];
  if (fields.some((field) => /[\r\n]/u.test(field))) {
    throw new Error('session、by、note 都不能换行');
  }
  if (by === '' || by.includes('·')) {
    throw new Error('by 要写成非空的文字，且不能有“·”（它是评价行的分隔符）');
  }

  return { session, by, score, note: noteWritten.trim() };
}


/** 外部 AI 交回结果的两种办法：http 调 result 接口；file 写任务文件夹里的 result/result.json，jmbots 定时扫。 */
export const RETURN_MODES = ['http', 'file'] as const;
export type ReturnMode = typeof RETURN_MODES[number];

/** 外部 AI 会用的一个模型。 */
export interface AgentModel {
  /** 模型 ID，照它自己客户端里的写法。 */
  id: string;
  /** 这个模型在它那边能设的思考档，从低到高；次高档是去掉 off 以后的倒数第二个。 */
  efforts: string[];
}

/** 外部 AI 打招呼时报的能力。派活时照它定模型、思考档，查能不能开子代理。 */
export interface AgentAbilities {
  /** 会用的模型，第一个是它默认用的。 */
  models: AgentModel[];
  /** 能不能真的开子代理。 */
  subagents: boolean;
  /** 结果怎么交回。 */
  returnMode: ReturnMode;
}

/** POST /api/agents/:name/hello 的正文，校验后。 */
export interface AgentHello {
  /** 一句话说会做什么；空串是没写，留旧的。 */
  description: string;
  /** 报的能力；没写 models 是没报，留旧的。 */
  abilities?: AgentAbilities;
}


/**
 * 校验外部 AI 打招呼的正文。relay 任务通道的 hello 接口（relay/TaskRoutes.ts）调，查过以后 AgentTasks.hello 直接用。
 * @param body 请求正文，原样；没有正文当空的。
 * @returns 说明和能力；没写 models 就不带 abilities。
 * @throws 哪一项不对就抛错，说清是哪一项、该怎么写。
 */
export function checkAgentHello(body: unknown): AgentHello {
  //M 允许空请求体兜底为对象，校验描述文字和可选的模型能力列表。
  const item = record(body ?? {}, 'hello 的正文');

  //M description：可以不写，写了要是文字。
  const description = item['description'] ?? '';
  if (typeof description !== 'string') {
    throw new Error('description 要写成文字（可以不写）');
  }

  //M 没写 models：只是打招呼，能力留旧的。
  if (item['models'] === undefined) return { description };

  //M models：每项 { id, efforts }，efforts 从低到高写。
  const models: AgentModel[] = [];
  const written = list(item['models'], 'models');
  for (const [index, raw] of written.entries()) {
    const label = `models[${String(index)}]`;
    const model = record(raw, label);
    const id = text(model['id'], `${label}.id`);
    const efforts = texts(model['efforts'], `${label}.efforts`);
    models.push({ id, efforts });
  }

  //M subagents：能不能开子代理，不写当不能；returnMode：不写是 http。
  const subagents = item['subagents'] ?? false;
  if (typeof subagents !== 'boolean') {
    throw new Error('subagents 要写成 true 或 false');
  }
  //G 限制结果交回方式只取已知枚举值（默认 http）。
  const returnMode = oneOf(item['returnMode'] ?? 'http', RETURN_MODES, 'returnMode');

  return { description, abilities: { models, subagents, returnMode } };
}


/** 外部 AI 交回的结论。completed 做完了；failed 没做成；capability_missing 缺能力（设不了模型、思考档，开不了子代理），没动手。 */
export const RESULT_STATUSES = ['completed', 'failed', 'capability_missing'] as const;

/** 一项检查跑出来怎样。 */
export const CHECK_OUTCOMES = ['passed', 'failed', 'not_run'] as const;

/** 实际开的一个子代理。核实不了的项写 unknown，不拿要求的值冒充。 */
export interface ActualSubagent {
  /** 子代理在执行端的真实 ID。 */
  id: string;
  /** 它负责什么。 */
  responsibility: string;
  /** 它实际用的模型。 */
  model: string;
  /** 它实际用的思考档。 */
  thinking: string;
}

/** 实际怎么执行的。核实不了的项写 unknown。 */
export interface ActualExecution {
  /** 哪个客户端执行的（Claude Code、Codex、DSH……）。 */
  host: string;
  /** 主会话 ID。 */
  sessionId: string;
  /** 任务要求的模型。 */
  requestedModel: string;
  /** 任务要求的思考档。 */
  requestedThinking: string;
  /** 实际用的模型。 */
  actualModel: string;
  /** 实际用的思考档。 */
  actualThinking: string;
  /** 实际开的子代理。 */
  subagents: ActualSubagent[];
}

/** 交回的一个文件。 */
export interface ResultArtifact {
  /** 相对任务文件夹 result/artifacts/ 的路径。 */
  path: string;
  /** 文件内容的 SHA-256，64 位小写十六进制。 */
  sha256: string;
  /** 这是什么。 */
  description: string;
}

/** 做过的一项检查。 */
export interface ResultCheck {
  /** 查的什么（命令、步骤）。 */
  check: string;
  /** 结果。 */
  outcome: typeof CHECK_OUTCOMES[number];
}

/** 外部 AI 交回的结果（result/result.json，或 POST result 正文里的 protocolResult），校验后。 */
export interface TaskResult {
  /** 协议版本，固定 1。 */
  version: 1;
  /** 固定 result。 */
  kind: 'result';
  /** 任务号。 */
  taskId: string;
  /** 领取时的 claimKey。 */
  claimKey: string;
  /** 结果键：<任务号>/<claimKey>/result。 */
  resultKey: string;
  /** 结论。 */
  status: typeof RESULT_STATUSES[number];
  /** 具体结论：做了什么、结果怎样，或为什么没做成。 */
  summary: string;
  /** 实际怎么执行的。 */
  actualExecution: ActualExecution;
  /** 交回的文件。 */
  artifacts: ResultArtifact[];
  /** 做过的检查。 */
  verification: ResultCheck[];
  /** 还没做完的事。 */
  remaining: string[];
  /** 缺的能力（status 是 capability_missing 时写）。 */
  capabilityMissing: string[];
}

/** SHA-256 的写法：64 位小写十六进制。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;


/**
 * 校验外部 AI 交回的结果。relay 任务通道的 result 接口、定时扫 result.json 时调（relay/AgentTasks.ts），查过以后 AgentTasks.finish 直接用。
 * 只查形状和路径安全；任务号、claimKey 对不对得上，文件在不在、SHA-256 对不对，由 finish 对着任务查。
 * @param body result.json 的内容，或 protocolResult，原样。
 * @returns 结果；artifacts、verification、remaining、capabilityMissing 没写是空的，resultKey 没写照规则补。
 * @throws 哪一项不对就抛错，说清是哪一项、该怎么写。
 */
export function checkTaskResult(body: unknown): TaskResult {
  //M 先确认回传正文是键值对象，再核对协议版本、任务号与附件字段。
  const item = record(body, '结果');

  //G 版本和种类：只认 v1 的 result。
  if (item['version'] !== 1 || item['kind'] !== 'result') {
    throw new Error('结果要写 version: 1、kind: "result"');
  }

  //M 任务号、领取键、结论、具体结论。
  const taskId = text(item['taskId'], 'taskId');
  const claimKey = text(item['claimKey'], 'claimKey');
  const status = oneOf(item['status'], RESULT_STATUSES, 'status');
  const summary = text(item['summary'], 'summary');

  //G resultKey 只有一种写法；没写就补上。
  const resultKey = `${taskId}/${claimKey}/result`;
  const writtenKey = item['resultKey'] ?? resultKey;
  if (writtenKey !== resultKey) {
    throw new Error(`resultKey 要写成 ${resultKey}（任务号/claimKey/result）`);
  }

  //M actualExecution：每项都要写，核实不了写 unknown。
  const actual = record(item['actualExecution'], 'actualExecution');
  const subagents: ActualSubagent[] = [];
  for (const [index, raw] of list(actual['subagents'] ?? [], 'actualExecution.subagents').entries()) {
    const label = `actualExecution.subagents[${String(index)}]`;
    const subagent = record(raw, label);
    subagents.push({
      id: text(subagent['id'], `${label}.id`),
      responsibility: text(subagent['responsibility'], `${label}.responsibility`),
      model: text(subagent['model'], `${label}.model`),
      thinking: text(subagent['thinking'], `${label}.thinking`),
    });
  }
  //M 逐项校验执行端实际记录的主机、会话及请求/实际模型档字段是否为非空文字。
  const actualExecution: ActualExecution = {
    host: text(actual['host'], 'actualExecution.host'),
    sessionId: text(actual['sessionId'], 'actualExecution.sessionId'),
    requestedModel: text(actual['requestedModel'], 'actualExecution.requestedModel'),
    requestedThinking: text(actual['requestedThinking'], 'actualExecution.requestedThinking'),
    actualModel: text(actual['actualModel'], 'actualExecution.actualModel'),
    actualThinking: text(actual['actualThinking'], 'actualExecution.actualThinking'),
    subagents,
  };

  //M artifacts：路径只能是 result/artifacts/ 里的相对路径（不许绝对路径、不许 ..），SHA-256 写对格式。
  const artifacts: ResultArtifact[] = [];
  for (const [index, raw] of list(item['artifacts'] ?? [], 'artifacts').entries()) {
    const label = `artifacts[${String(index)}]`;
    const artifact = record(raw, label);
    const file = text(artifact['path'], `${label}.path`);
    const parts = file.split(/[\\/]/u);
    if (path.isAbsolute(file) || path.win32.isAbsolute(file) || parts.includes('..')) {
      throw new Error(`${label}.path 要写相对 result/artifacts/ 的路径，不能是绝对路径、不能有 ..`);
    }
    //G 校核交付物的校验和格式及一句话描述，随后登记到结果列表。
    const sha256 = text(artifact['sha256'], `${label}.sha256`);
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`${label}.sha256 要写成 64 位小写十六进制`);
    }
    //M 校验交付物的一句话描述为非空文字，再写入结果数组。
    const description = text(artifact['description'], `${label}.description`);
    artifacts.push({ path: file, sha256, description });
  }

  //M verification：每项 { check, outcome }。
  const verification: ResultCheck[] = [];
  for (const [index, raw] of list(item['verification'] ?? [], 'verification').entries()) {
    const label = `verification[${String(index)}]`;
    const check = record(raw, label);
    verification.push({
      check: text(check['check'], `${label}.check`),
      outcome: oneOf(check['outcome'], CHECK_OUTCOMES, `${label}.outcome`),
    });
  }

  //M remaining、capabilityMissing：文字清单，可以不写。
  const remaining = texts(item['remaining'] ?? [], 'remaining');
  const capabilityMissing = texts(item['capabilityMissing'] ?? [], 'capabilityMissing');

  return {
    version: 1,
    kind: 'result',
    taskId,
    claimKey,
    resultKey,
    status,
    summary,
    actualExecution,
    artifacts,
    verification,
    remaining,
    capabilityMissing,
  };
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
