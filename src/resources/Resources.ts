/**
 * 资源：程序启动时读进来、运行中只读的东西（docs/10 6.1）：config.yaml、提示词、机器人清单、模型评价。
 * 只回答“有什么”，不负责执行；写的事只有 load 时复制出厂提示词这一件。
 *
 * 运行时目录（基地传给后端的 --runtime；从源码跑时看环境变量 JMBOTS_RUNTIME，再不写是仓库旁边的 jmbotsData/）里和资源有关的：
 *   config.yaml                 主配置（有密钥：只在这里读，别处要什么用下面的函数拿，不许整份端出去）
 *   prompts/00_base_dsh.md      DSH 的系统提示词，永远排第一段
 *   prompts/zh/、prompts/en/     各语言的机器人、分派、审核提示词
 *   bots/<名字>/                 机器人的文件夹（文件由文件库管）
 *   knowledge/模型评价.md        分派挑模型时看
 *   skills/                      技能（由文件库读）
 */
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'yaml';
import * as checks from '../utils/Checks.ts';
import * as embedded from './Embedded.ts';


/** engine 里没写的项用的默认值（默认值只写在这里）。 */
const ENGINE_DEFAULTS = {
  poll_ms: 300,
  merge_ms: 2000,
  overtime_minutes: 10,
  max_rounds: 300,
  compress_at: 200_000,
  exec_pass: 0.2,
  fallback_max_tries: 5,
  retry_delays_ms: [2000, 5000],
  fallback_include_siblings: true,
  rate_limit_cooldown_minutes: 5,
  limit_default_minutes: 20,
  limit_remind_before_minutes: 10,
  limit_extend_minutes: 5,
  limit_extend_times: 2,
};

/** 启动时补进 config.yaml 的项：路径 → 默认值。 */
/**
 * config.yaml 的 events 段（docs/11 第 6.8 节、docs/11_附 第 3.3 节）：事件留多久、事件链几层、拦处理器等多久，
 * 观察处理器 EventWatch 的几个阈值。限时（超过 10 分钟介入、最长 20 分钟）在 engine 段的 limit_*。
 */
const EVENTS_DEFAULTS = {
  keep_days: 30,
  max_depth: 5,
  gate_timeout_ms: 10_000,
  watch_think_slow_seconds: 120,
  watch_think_max_steps: 40,
  watch_tool_fail_run: 3,
  watch_rag_slow_ms: 3000,
  watch_rag_repeat: 3,
};

const CONFIG_DEFAULTS: [string[], unknown][] = [
  ...Object.entries(ENGINE_DEFAULTS).map(([key, value]): [string[], unknown] => [['engine', key], value]),
  ...Object.entries(EVENTS_DEFAULTS).map(([key, value]): [string[], unknown] => [['events', key], value]),
  [['concurrency', 'default'], 3],
  [['http', 'port'], 30086],
  [['local', 'port'], 30090],
  //M 和基地 local/src/config.rs 的 DEFAULT_LIBS_DIR、DEFAULT_RAG_DIR 一样（搬进 jmbotsData 后的位置）；两边不一样时基地会去空目录里找库。
  [['local', 'libs'], 'data/index/libs'],
  [['local', 'rag'], 'data/index/rag'],
];

/** config.yaml 里手写的一个模型（providers.<名字>.models 下的一项）：清单没给全，或者没有清单接口时用；写了的优先。 */
export interface ProviderModel {
  /** 显示名。 */
  name?: string;

  /** 上下文长度（token）。 */
  context_window?: number;

  /** 最大输出（token）。 */
  max_output_tokens?: number;

  /** 能不能看图。 */
  vision?: boolean;

  /** 支持的思考档位，如 [off, low, high]。 */
  thinking?: string[];

  /** 价格，美元每百万 token。 */
  price?: {
    /** 输入价格，美元每百万 token。 */
    input?: number;
    /** 输出价格，美元每百万 token。 */
    output?: number;
  };
}


/** 一个模型供应商（config.yaml 的 providers 下的一项）。想接几家接几家，地址、密钥、协议都在这里。 */
export interface ProviderConfig {
  /** 接口地址，如 https://api.deepseek.com/v1。 */
  base_url: string;

  /** 密钥，直接写在 config.yaml 里（用户定的）；本地不要密钥的服务可以不写。 */
  api_key?: string;

  /** 接口协议：openai-completions（默认）、openai-responses、anthropic-messages。 */
  api?: string;

  /** 启动时向 <base_url>/models 拉不拉清单；没有清单接口的写 false，只用 models 手写的。默认拉。 */
  list_models?: boolean;

  /** 手写的模型：键是模型 ID。 */
  models?: Record<string, ProviderModel>;

  /** 其余兼容设置原样交给 Pi。 */
  [key: string]: unknown;
}


/** 一个用途用哪个模型（config.yaml 的 models 下的一项：dispatch 分派、decision 决策模型）。 */
export interface ModelChoice {
  /** 供应商/模型 ID（供应商是 providers 下的名字）。 */
  model?: string;

  /** 思考强度：off、minimal、low、medium、high、xhigh、max。 */
  thinking?: string;
}


/** 一个机器人：config.yaml 的 bots 里的一项。 */
export interface BotInfo {
  /** 名字，就是 bots/ 下的文件夹名，可以是中文。 */
  name: string;

  /** 提示词用哪种语言：zh 或 en。 */
  language: 'zh' | 'en';
}


/** 拼好的系统提示词。 */
export interface Prompt {
  /** 全文：00_base_dsh.md 和对应语言那一篇，用空行连起来。 */
  text: string;

  /** 用到的提示词文件（绝对路径，按拼接顺序）；会话 md 里只写这些路径。 */
  files: string[];
}


/** 程序的设置（config.yaml 的 engine；没写的项用这里的默认值）。 */
export interface Settings {
  /** 机器人循环多久看一次新消息，毫秒（engine.poll_ms，默认 300）。 */
  pollMs: number;

  /** 合批：同一来源最后一条到了以后，等这么久没有新的才分派，毫秒（engine.merge_ms，默认 2000）。机器人.yaml 可以另设。 */
  mergeMs: number;

  /** 一次运行最多多少步（engine.max_rounds，默认 300）。 */
  maxRounds: number;

  /** 上下文到多少 token 就考虑压缩（engine.compress_at，默认 200000）。 */
  compressAt: number;

  /** exec 审核：决策模型给的“安全”概率不低于它就直接执行（engine.exec_pass，默认 0.2）。 */
  execPass: number;

  /** 看图的模型（engine.vision_model）：看不了图的模型读到图片时，先交给它转成文字；不写就不转。 */
  visionModel?: string;

  /** 基地的接口地址（engine.index_url），记忆搜索、RAG 用；不写就只搜自己的记忆、公共记忆和技能。 */
  indexUrl?: string;
  /** memory 工具的 search 还用 RAG 搜哪些记忆库，逗号连着写（engine.memory_libs），每半小时让基地增量更新它们的索引；不写就只搜自己的记忆、公共记忆和技能。 */
  memoryLibs?: string;
  /** 限时到点时写收尾总结的模型（engine.wrapup_model，不带工具、思考档用最低的）；不写就用会话自己的模型。 */
  wrapupModel?: string;
  /** 生图模型（engine.image_model），写成“供应商/模型 ID”；不写就没有生图。 */
  imageModel?: string;
  /** 一件事做了这么多分钟还没完，记进超时登记（engine.overtime_minutes，用户 11-06 定 10 分钟），复盘时看。 */
  overtimeMinutes: number;

  /** 模型被限流时依次换着试的备用链（engine.fallback_chain）；模型库用。 */
  fallbackChain: string[];

  /** 被限流后最多再试几个模型（engine.fallback_max_tries，默认 5）；模型库用。 */
  fallbackMaxTries: number;

  /** 连接出错时同一个模型隔多久重试，毫秒（engine.retry_delays_ms，默认 [2000, 5000]）；模型库用。 */
  retryDelaysMs: number[];

  /** 备用链用完后，要不要接着试同一个供应商里不收费的其他模型（engine.fallback_include_siblings，默认要）；模型库用。 */
  fallbackSiblings: boolean;

  /** 模型被限流、报错里没写几点恢复时，冷却多久不再找它，毫秒（engine.rate_limit_cooldown_minutes，默认 5 分钟）；模型库用。 */
  rateLimitCooldownMs: number;

  /** 事件留多少天（events.keep_days，默认 30）；记过的键不删。事件总线用。 */
  eventsKeepDays: number;

  /** 事件链最多几层（events.max_depth，默认 5）；再往下不传，免得互相引着转圈。事件总线用。 */
  eventsMaxDepth: number;

  /** 拦处理器最多等多久，毫秒（events.gate_timeout_ms，默认 10 秒）；超时按放行。事件总线用。 */
  gateTimeoutMs: number;

  /** 不选限时的时候最长做多少分钟（engine.limit_default_minutes，默认 20，用户 11-06 定）；进度卡片用。 */
  limitDefaultMinutes: number;

  /** 不选限时的时候，到点前多少分钟开始介入、报时（engine.limit_remind_before_minutes，默认 10：第 10 分钟）；进度卡片用。 */
  limitRemindBeforeMinutes: number;

  /** 到点判断快做完了，一次延长几分钟（engine.limit_extend_minutes，默认 5）；进度卡片用。 */
  limitExtendMinutes: number;

  /** 最多延长几次（engine.limit_extend_times，默认 2）；进度卡片用。 */
  limitExtendTimes: number;

  /** 到点判断用的决策模型（engine.limit_judge_model）；不写用 models.decision。进度卡片用。 */
  limitJudgeModel?: string;
  /** 限时延了两次还没做完时的审核模型（engine.limit_review_model）；不写用会话自己的模型、思考最强档。进度卡片用。 */
  limitReviewModel?: string;

  /** 一步想了多少秒算太慢（events.watch_think_slow_seconds，默认 120）；观察处理器用。 */
  watchThinkSlowSeconds: number;

  /** 一次运行走了多少步算太多（events.watch_think_max_steps，默认 40）；观察处理器用。 */
  watchThinkMaxSteps: number;

  /** 同一个工具连着出错几次要报（events.watch_tool_fail_run，默认 3）；观察处理器用。 */
  watchToolFailRun: number;

  /** 一次搜索（记忆库、记忆）多少毫秒算太慢（events.watch_rag_slow_ms，默认 3000）；观察处理器用。 */
  watchRagSlowMs: number;

  /** 同一个会话里同一句搜了几次要报（events.watch_rag_repeat，默认 3）；观察处理器用。 */
  watchRagRepeat: number;
}


/** 并发配额（config.yaml 的 concurrency）：同一时间最多几个调用，超了排队（Model.ts）。 */
export interface ConcurrencySettings {
  /** 每个模型默认最多几个（concurrency.default，默认 3）。 */
  perModel: number;

  /** 单独设的模型：“供应商/模型 ID” → 上限（concurrency.models）。 */
  models: Record<string, number>;

  /** 供应商合计上限：供应商名 → 它所有模型加起来最多几个（concurrency.providers）；没写的供应商不限。 */
  providers: Record<string, number>;
}


/** 提示词文件名：用途 → 语言 → 文件（在 prompts/<语言>/ 下）。 */
const PROMPT_FILES: Record<'bot' | 'dispatch' | 'review', Record<BotInfo['language'], string>> = {
  bot: { zh: '10_机器人.md', en: '10_bot.md' },
  dispatch: { zh: '20_分派.md', en: '20_dispatch.md' },
  review: { zh: '30_审核.md', en: '30_review.md' },
};


/** 第一段提示词的文件名（DSH 的系统提示词原文，一字不改）。 */
const BASE_PROMPT = '00_base_dsh.md';


/** 分派时最多把《模型评价》的前多少字塞进现状：整篇太长，分派只需要知道各模型大致擅长什么。 */
const MODEL_REVIEW_MAX_CHARS = 1200;


/** 第一次启动、还没有 config.yaml 时写的模板；用户照着填供应商和模型。 */
const CONFIG_TEMPLATE = `# jmbots 主配置（docs/10 3.4）。除了代码，所有东西都放在这个文件所在的文件夹（运行时目录）里。
providers: {}
#  my_provider:                       # 供应商名自己起，模型 ID 都以它开头
#    base_url: https://api.example.com/v1
#    api_key: 你的密钥

# 程序默认的模型：分派没挑出来、程序兜底时用。写成“供应商/模型 ID”。
# default_model: my_provider/模型 ID

# 分派的常规模型（低思考）和决策模型（可以不配）。
models: {}

# 唯一启用名单：一项一条机器人循环；[] 表示不启用，历史目录不自动启用。
bots:
  - name: 助手
    language: zh

engine:
  merge_ms: 2000
  max_rounds: 300
  index_url: http://127.0.0.1:30090   # 基地的接口（记忆搜索、RAG）；基地没开时只搜自己的记忆、公共记忆和技能
  # memory_libs: memory,aiskills      # memory 工具还用 RAG 搜基地里的哪些库，逗号连着写；每半小时让基地增量更新这些库的索引；不写就不搜
  # wrapup_model: 供应商/模型         # 限时到点时写收尾总结的模型（不带工具、最低思考档）；不写用会话自己的模型
  # image_model: 供应商/模型          # 生图模型（image_generate 工具用）；不写就没有生图

http: { host: 0.0.0.0, port: 30086 }
`;


/**
 * 读一组“名字 → 正整数”的配额。
 * @param value config.yaml 里的值。
 * @param name 配置项名字（报错用）。
 * @returns 名字 → 上限。
 * @throws 不是正整数时抛错。
 */
function readQuota(value: unknown, name: string): Record<string, number> {
  /** 结果。 */
  const quota: Record<string, number> = {};
  for (const [key, raw] of Object.entries(checks.asRecord(value ?? {}, name))) {
    /** 数字。 */
    const number = checks.requirePositiveInteger(raw, `config.yaml 的 ${name}.${key}`);
    quota[key] = number;
  }
  return quota;
}


/**
 * 读备用链：engine.fallback_chain（列表）优先，其次旧写法 engine.fallback_model（一个）；都没写就退到程序默认的模型。
 * @param engine config.yaml 的 engine 段。
 * @param defaultModel 程序默认的模型。
 * @returns 有序的模型 ID；关掉兜底时是空数组。
 */
function readFallbackChain(engine: Record<string, unknown>, defaultModel: string | undefined): string[] {
  /** 新写法。 */
  const chain = checks.optionalStringList(engine.fallback_chain, 'engine.fallback_chain');
  if (chain) {
    return chain.filter((model) => model !== 'off');
  }
  /** 旧写法。 */
  const single = checks.optionalString(engine.fallback_model, 'engine.fallback_model');
  if (single === 'off') {
    return [];
  }
  /** 退到哪个模型。 */
  const fallback = single ?? defaultModel;
  return fallback ? [fallback] : [];
}


/**
 * 读并检查 config.yaml；还没有就先写一份模板。
 * @param dir 运行时目录（绝对路径）。
 * @returns 主配置原样（含密钥）。
 * @throws 不是合法的 YAML 映射时抛错。
 * 副作用：没有 config.yaml 时写模板（flag wx，不覆盖）。
 */
async function readConfig(dir: string): Promise<Record<string, unknown>> {
  /** 文件。 */
  const file = path.join(dir, 'config.yaml');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, CONFIG_TEMPLATE, { flag: 'wx' }).catch(checks.ignoreExists);
  /** 原文（记事本这些工具存的 UTF-8 开头可能带 BOM，去掉）。 */
  const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, '');
  /** 补上默认值的原文；不用补是 undefined。 */
  const filled = fillDefaults(text);
  if (filled !== undefined) {
    //M 先写临时文件再改名：读的人（设置页、基地）不会读到半截。
    await fs.writeFile(`${file}.tmp`, filled, 'utf8');
    await fs.rename(`${file}.tmp`, file);
  }
  return checks.asRecord(Bun.YAML.parse(filled ?? text) ?? {}, 'config.yaml');
}


/**
 * 把没写的项按默认值补进 config.yaml（用户 11-05：这些都要在 config.yaml 里看得到、设置页显示的就是它），注释和没见过的键都留着。
 * @param text config.yaml 原文。
 * @returns 补过的原文；不用补，或者原文不是合法 YAML（交给后面报错）时是 undefined。
 */
function fillDefaults(text: string): string | undefined {
  /** 文档。 */
  const document = yaml.parseDocument(text);
  if (document.errors.length > 0) {
    return undefined;
  }
  /** 补过没有。 */
  let changed = false;
  for (const [keys, value] of CONFIG_DEFAULTS) {
    //G 上一层写成了别的东西（不是对象）：不动它。
    try {
      if (!document.hasIn(keys)) {
        document.setIn(keys, value);
        changed = true;
      }
    } catch {
      //M 下面读配置时会按原样报出来。
    }
  }
  return changed ? document.toString({ lineWidth: 0 }) : undefined;
}


/**
 * 把仓库 prompts/ 里的出厂提示词（00_base_dsh.md、zh/、en/ 下的 .md）复制进运行时目录的 prompts/，已有的不覆盖。
 * @param dir 运行时目录。
 * @returns 无。
 * 副作用：建目录、复制文件。
 */
async function copyPrompts(dir: string): Promise<void> {
  //M 编译好的程序：提示词打包在程序里。
  if (embedded.isCompiled()) {
    for (const { name, file } of embedded.list('prompts/')) {
      /** 复制到哪。 */
      const target = path.join(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      /** 打包资源的内容，在写文件之前准备好。 */
      const buffer = await Bun.file(file).arrayBuffer();
      const contents = new Uint8Array(buffer);

      await fs.writeFile(target, contents, { flag: 'wx' }).catch(checks.ignoreExists);
    }
    return;
  }
  /** 仓库里的出厂默认（src/resources/ 往上两层就是项目根）。 */
  const from = path.resolve(import.meta.dir, '..', '..', 'prompts');
  if (!fsSync.existsSync(from)) {
    return;
  }
  for (const relative of await Array.fromAsync(new Bun.Glob('**/*.md').scan({ cwd: from }))) {
    if (path.basename(relative) === 'README.md') {
      continue;
    }
    /** 复制到哪。 */
    const target = path.join(dir, 'prompts', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(from, relative), target, fsSync.constants.COPYFILE_EXCL).catch(checks.ignoreExists);
  }
}


/**
 * 读唯一启用名单：只认 config.yaml 的 bots；历史文件夹不参与启用。
 * @param config 主配置。
 * @returns 机器人列表；缺名单和显式空名单都返回空数组。
 * @throws bots 写错（不是列表、没有名字、语言不是 zh/en、重名）时抛错。
 */
function readBots(config: Record<string, unknown>): BotInfo[] {
  if (config.bots === undefined || config.bots === null) {
    return [];
  }
  if (!Array.isArray(config.bots)) {
    throw new Error('config.yaml 的 bots 要写成列表，每项有 name 和 language');
  }
  /** 结果。 */
  const bots: BotInfo[] = [];
  for (const [index, raw] of (config.bots as unknown[]).entries()) {
    /** 这一项。 */
    const item = checks.asRecord(raw, `bots[${index}]`);
    /** 名字。 */
    const fieldName = `bots[${index}].name`;
    const rawName = checks.requireString(item.name, fieldName);
    const name = checks.safeName(rawName, fieldName);
    /** 语言。 */
    const language = checks.optionalString(item.language, `bots[${index}].language`) ?? 'zh';
    if (language !== 'zh' && language !== 'en') {
      throw new Error(`config.yaml 的 bots[${index}].language 只能是 zh 或 en，现在是 ${language}`);
    }
    if (bots.some((bot) => bot.name === name)) {
      throw new Error(`config.yaml 的 bots 里 ${name} 写了两次`);
    }
    bots.push({ name, language });
  }
  return bots;
}


/** 加载边界已经确定的渠道设置。 */
export interface ChannelConfig {
  /** 渠道类型，与登记表的键一致。 */
  name: string;
  /** 渠道原有字段和已归一化的机器人；空名单可能尚未指定机器人。 */
  settings: Record<string, unknown> & {
    /** 配置明确指定或由启用名单补齐的机器人名。 */
    bot?: string;
  };
}


/** 加载边界已经确定的 HTTP 配置。 */
export interface HttpSettings {
  /** 对局域网开放的监听地址。 */
  host: string;
  /** HTTP 端口；启动入口会结合命令行确定最终值。 */
  port: number;
  /** 本地 API 访问令牌，空字符串表示未设置。 */
  token: string;
}


/** 程序和语言运行环境的绝对目录。 */
export interface ToolPaths {
  /** Python、Node、Bun 等语言运行环境。 */
  runtimes: string;
  /** ffmpeg 等工具。 */
  program: string;
}


/** 资源：配置和资源清单。用 Resources.load 创建。 */
export class Resources {
  /** 运行时目录（绝对路径）。 */
  readonly dir: string;

  /** 主配置原样（含密钥）。私有：外面要什么用下面的函数拿。 */
  private readonly config: Record<string, unknown>;

  /** 机器人清单。 */
  private readonly bots: BotInfo[];

  /** 加载时归一化的模型用途，读取时不再检查原始 YAML。 */
  private readonly modelChoices: Record<string, ModelChoice>;
  /** 加载时选定的程序默认模型。 */
  private readonly defaultModel: string | undefined;
  /** 供应商配置映射；每家连接的外部协议校验仍由模型入口负责。 */
  private readonly providers: Record<string, ProviderConfig>;
  /** 加载时确定的并发配额。 */
  private readonly concurrency: ConcurrencySettings;
  /** 加载时确定的渠道设置；首次添加机器人时补齐原未指定的默认目标。 */
  private readonly channelConfigs: ChannelConfig[];
  /** 加载时确定的 HTTP 配置。 */
  private readonly http: HttpSettings;
  /** 加载时确定的工具目录。 */
  private readonly toolPaths: ToolPaths;
  /** 加载时确定的引擎和事件设置。 */
  private readonly engineSettings: Settings;


  /**
   * 只在 load 里调用。
   * @param dir 运行时目录。
   * @param config 主配置。
   * @param bots 机器人清单。
   */
  private constructor(
    dir: string,
    config: Record<string, unknown>,
    bots: BotInfo[],
  ) {
    this.dir = dir;
    this.config = config;
    this.bots = bots;
    this.modelChoices = this.readModelChoices();
    this.defaultModel = checks.optionalString(config.default_model, 'default_model')
      ?? this.modelChoices.work?.model;
    this.providers = checks.asRecord(config.providers, 'providers') as Record<string, ProviderConfig>;
    this.concurrency = this.readConcurrency();
    this.channelConfigs = this.readChannels();
    this.http = this.readHttp();
    this.toolPaths = this.readPaths();
    this.engineSettings = this.readSettings();
  }


  /**
   * 打开运行时目录：读 config.yaml（没有就写模板），把出厂提示词复制过去（已有的不覆盖）。
   * 没有模型也能打开，由 problems() 报出来。
   * @param dir 入口已经确定的运行时目录，必传；本层不补默认值。
   * @returns 资源。
   * @throws config.yaml 不是合法 YAML 映射、bots 写错时抛错。
   * 副作用：建运行时目录和 data/、skills/，写 config.yaml 模板，复制提示词。
   */
  static async load(dir: string): Promise<Resources> {
    /** 绝对路径。 */
    const root = path.resolve(dir);
    /** 主配置。 */
    const config = await readConfig(root);
    await copyPrompts(root);
    for (const folder of ['data', 'skills', 'bots']) {
      await fs.mkdir(path.join(root, folder), { recursive: true });
    }
    /** 配置是外部输入：机器人及各设置在资源创建时一次归一化。 */
    const bots = readBots(config);
    return new Resources(root, config, bots);
  }


  /**
   * 配置有哪些毛病，一条一句话（健康检查给出去）。
   * @returns 没问题时是空数组。
   */
  problems(): string[] {
    /** 发现的问题。 */
    const found: string[] = [];
    /** 主配置文件。 */
    const file = path.join(this.dir, 'config.yaml');
    if (Object.keys(this.getProviders()).length === 0) {
      found.push(`${file} 里没有模型供应商（providers），无法执行。`);
    }
    if (!this.getDefaultModel()) {
      found.push(`${file} 里没有默认模型（default_model），分派没挑出模型时无法执行。`);
    }
    if (this.bots.length === 0) {
      found.push(`${file} 的 bots 没有启用机器人；请在 bots 列表中明确添加，历史目录不会自动启用。`);
    }
    for (const channel of this.listChannels()) {
      /** 渠道明确指定的、或从启用名单取到的默认机器人。 */
      const bot = channel.settings.bot;
      if (!bot || !this.bots.some((item) => item.name === bot)) {
        found.push(`渠道 ${channel.name} 的机器人 ${bot || '（未指定）'} 未启用，该渠道不会启动。`);
      }
    }
    return found;
  }


  /**
   * 要起的机器人（config.yaml 的 bots）。
   * @returns 机器人列表的副本；允许为空。
   */
  listBots(): BotInfo[] {
    return this.bots.map((bot) => ({ ...bot }));
  }


  /**
   * 运行时加一个机器人（网页新建机器人，docs/界面/01_界面设计.md 6.2）；config.yaml 由调用的人写。
   * @param info 机器人。
   * @throws 已经有这个名字时抛错。
   * 副作用：改这个对象里的机器人列表。
   */
  addBot(info: BotInfo): void {
    if (this.bots.some((bot) => bot.name === info.name)) {
      throw new Error(`已经有机器人 ${info.name} 了`);
    }
    this.bots.push({ ...info });
    //M 原来没有机器人时，旧式渠道的默认目标随首次添加的机器人一起确定。
    if (this.bots.length === 1) {
      for (const channel of this.channelConfigs) {
        if (channel.settings.bot === undefined) {
          channel.settings.bot = info.name;
        }
      }
    }
  }


  /**
   * 按名字找机器人。
   * @param name 名字。
   * @returns 机器人。
   * @throws 没有这个机器人时抛错，报出现有的名字。
   */
  getBot(name: string): BotInfo {
    /** 找到的。 */
    const bot = this.bots.find((item) => item.name === name);
    if (!bot) {
      throw new Error(`机器人 ${name} 未启用；已启用：${this.bots.map((item) => item.name).join('、') || '无'}`);
    }
    return { ...bot };
  }


  /**
   * 拼好的系统提示词：00_base_dsh.md + 对应语言的那一篇。按文件名取，读运行时目录那份（用户改的是那份）。
   * @param kind bot 机器人、dispatch 分派、review 审核。
   * @param language zh 或 en。
   * @returns 全文和用到的文件；某个文件读不了就跳过它（少一段也能干活）。
   */
  prompt(kind: 'bot' | 'dispatch' | 'review', language: BotInfo['language']): Prompt {
    /** 按顺序的两个文件。 */
    const files = [
      path.join(this.dir, 'prompts', BASE_PROMPT),
      path.join(this.dir, 'prompts', language, PROMPT_FILES[kind][language]),
    ];
    /** 读到的各段。 */
    const parts: string[] = [];
    /** 真读到的文件。 */
    const used: string[] = [];
    for (const file of files) {
      try {
        /** 这一段。 */
        const text = fsSync.readFileSync(file, 'utf8').trim();
        if (text) {
          parts.push(text);
          used.push(file);
        }
      } catch {
        // 读不了就跳过，problems() 不管提示词。
      }
    }
    return { text: parts.join('\n\n'), files: used };
  }


  /**
   * 某一项设置。
   * @param name 设置名。
   * @returns 没写的项返回默认值。
   */
  getSetting<K extends keyof Settings>(name: K): Settings[K] {
    return this.engineSettings[name];
  }


  /**
   * 某个用途配的模型（config.yaml 的 models.<用途>）。分派没配时用默认模型、低思考。
   * @param use dispatch 或 decision。
   * @returns 没配就是 undefined（dispatch 没配时给默认模型）。
   */
  getModelChoice(use: 'dispatch' | 'decision'): ModelChoice | undefined {
    /** 配的。 */
    const choice = this.listModelChoices()[use];
    if (choice?.model) {
      return { ...choice };
    }
    if (use === 'dispatch' && this.getDefaultModel()) {
      return { model: this.getDefaultModel(), thinking: 'low' };
    }
    return undefined;
  }


  /**
   * 全部用途配的模型（config.yaml 的 models）；模型库按模型 ID 反查思考强度时用。
   * @returns 用途名 → 模型设置。
   */
  listModelChoices(): Record<string, ModelChoice> {
    return this.modelChoices;
  }


  /**
   * 程序默认的模型：default_model；没写时兼容旧写法 models.work.model。
   * @returns 都没有时是 undefined。
   */
  getDefaultModel(): string | undefined {
    return this.defaultModel;
  }


  /**
   * 模型供应商（config.yaml 的 providers）。
   * @returns 供应商 ID → 设置。
   */
  getProviders(): Record<string, ProviderConfig> {
    return this.providers;
  }


  /** 已归一化的并发配额。 */
  getConcurrency(): ConcurrencySettings {
    return this.concurrency;
  }


  /** 已归一化的启用渠道；返回副本，调用方不会改变资源快照。 */
  listChannels(): ChannelConfig[] {
    return this.channelConfigs.map((channel) => ({
      name: channel.name,
      settings: { ...channel.settings },
    }));
  }


  /** 已归一化的 HTTP 配置。 */
  getHttp(): HttpSettings {
    return this.http;
  }


  /** 已归一化的工具目录。 */
  getPaths(): ToolPaths {
    return this.toolPaths;
  }


  /** 在加载边界读取用途模型，内部只保存明确的字符串字段。 */
  private readModelChoices(): Record<string, ModelChoice> {
    /** 外部配置中的用途映射。 */
    const rawChoices = checks.asRecord(this.config.models, 'models');
    /** 供分派、审核等内部模块直接使用的结果。 */
    const choices: Record<string, ModelChoice> = {};
    for (const [name, value] of Object.entries(rawChoices)) {
      /** 当前用途的配置对象。 */
      const choice = checks.asRecord(value, `models.${name}`);
      choices[name] = {
        model: checks.optionalString(choice.model, `models.${name}.model`),
        thinking: checks.optionalString(choice.thinking, `models.${name}.thinking`),
      };
    }
    return choices;
  }


  /**
   * 并发配额；没写的项用默认值（每个模型 3 个，供应商不限）。
   * @returns 配额设置。
   * @throws concurrency.default 不是正整数时抛错。
   */
  private readConcurrency(): ConcurrencySettings {
    /** config.yaml 的 concurrency。 */
    const concurrency = checks.asRecord(this.config.concurrency ?? {}, 'concurrency');
    /** 每个模型的默认上限。 */
    const perModel = checks.requirePositiveInteger(concurrency.default ?? 3, 'concurrency.default');
    /** 逐模型和逐供应商的配额，只在加载时读取一次。 */
    const models = readQuota(concurrency.models, 'concurrency.models');
    const providers = readQuota(concurrency.providers, 'concurrency.providers');
    return {
      perModel,
      models,
      providers,
    };
  }


  /**
   * 开了哪些渠道（config.yaml 的 channels，不含 HTTP，HTTP 见 getHttp）。
   * 飞书写成列表，一个应用一项，每项带 bot；也认旧写法（一个对象、enabled: true、没写 bot 时给第一个机器人）。
   * @returns 渠道名 + 它那一份设置；空名单时默认 bot 为空，由建渠道的入口明确拒绝。
   */
  private readChannels(): ChannelConfig[] {
    /** config.yaml 的 channels。 */
    const channels = checks.asRecord(this.config.channels ?? {}, 'channels');
    /** 结果。 */
    const found: ChannelConfig[] = [];
    for (const [name, raw] of Object.entries(channels)) {
      if (name === 'http' || name === 'filebridge') {
        continue;
      }
      /** 一种渠道可以配置一个对象，也可以配置应用列表。 */
      const entries = Array.isArray(raw) ? raw : [raw];
      for (const [index, item] of entries.entries()) {
        /** 配置字段路径只供首次校验报错定位。 */
        const suffix = Array.isArray(raw) ? `[${String(index)}]` : '';
        const fieldName = `channels.${name}${suffix}`;
        const rawSettings = checks.asRecord(item, fieldName);
        /** 渠道对象独立保存，不修改原始配置。 */
        const settings = { ...rawSettings };
        if (settings.enabled === false) {
          continue;
        }
        /** 对应的机器人。 */
        const bot = checks.optionalString(settings.bot, `channels.${name}.bot`) ?? this.bots[0]?.name;
        found.push({
          name,
          settings: {
            ...settings,
            bot,
          },
        });
      }
    }
    return found;
  }


  /**
   * HTTP 设置（config.yaml 的 http）：host 一律 0.0.0.0（docs/10 规矩 3），port、token。
   * @returns 没写就是 { host: '0.0.0.0', port: 30086 }。
   */
  private readHttp(): HttpSettings {
    /** config.yaml 的 http。 */
    const http = checks.asRecord(this.config.http ?? {}, 'http');
    /** 端口数值和令牌形状在配置边界确定，端口范围由启动入口处理。 */
    const port = checks.requireFiniteNumber(http.port ?? 30086, 'http.port');
    const token = checks.optionalString(http.token, 'http.token') ?? '';
    return {
      host: '0.0.0.0',
      port,
      token,
    };
  }


  /**
   * 工具放哪（config.yaml 的 paths；docs/界面/02_一个程序跑起来的规划.md 的目录约定，用户 11-05 同意、11-06 再提）：
   * runtimes 放 Python、Node、Bun 这些语言运行环境，program 放 ffmpeg 这类开源程序，一个工具一个文件夹。exec 把它们放到 PATH 最前面。
   * @returns 绝对路径；没写就是运行时目录下的 runtimes/、program/（用到才建，这里不建）。
   */
  private readPaths(): ToolPaths {
    /** config.yaml 的 paths。 */
    const paths = checks.asRecord(this.config.paths ?? {}, 'paths');
    /** 没指定时使用运行时目录下的标准子目录。 */
    const runtimesName = checks.optionalString(paths.runtimes, 'paths.runtimes') ?? 'runtimes';
    const programName = checks.optionalString(paths.program, 'paths.program') ?? 'program';
    const runtimes = path.resolve(this.dir, runtimesName);
    const program = path.resolve(this.dir, programName);
    return {
      runtimes,
      program,
    };
  }


  /**
   * 搜索设置（config.yaml 的 search），web_search 用。
   * @returns 没写就是 undefined。
   */
  getSearch(): unknown {
    return this.config.search;
  }


  /**
   * config.yaml 里所有像密钥的值（键名带 secret、key、token、password，8 个字以上）：只给密钥替身用。
   * 几个飞书应用的密钥都在 channels 下，一起算上。
   * @returns 密钥值列表（不要往别处传）。
   */
  getSecretValues(): string[] {
    /** 找到的。 */
    const found = new Set<string>();
    /**
     * 递归找。
     * @param value 某一层的值。
     * @param key 它的键名。
     */
    const walk = (value: unknown, key: string): void => {
      if (typeof value === 'string') {
        if (/secret|key|token|password/i.test(key) && value.length >= 8) {
          found.add(value);
        }
        return;
      }
      if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) {
          walk(child, Array.isArray(value) ? key : childKey);
        }
      }
    };
    walk(this.config, '');
    return [...found];
  }


  /**
   * 模型评价（公共记忆 memory/模型评价.md，还没搬的在 knowledge/）：分派挑模型时看；太长截前 1200 字并写明去哪看全文。
   * @returns 还没有时是空字符串。
   */
  async readModelReview(): Promise<string> {
    /** 公共记忆里的文件。 */
    const shared = path.join(this.dir, 'memory', '模型评价.md');
    /** 还没搬的文件。 */
    const old = path.join(this.dir, 'knowledge', '模型评价.md');
    /** 公共记忆里的全文。 */
    const sharedText = await fs.readFile(shared, 'utf8').catch(() => '');
    /** 用的是哪个文件。 */
    const file = sharedText ? shared : old;
    /** 全文。 */
    const text = sharedText || (await fs.readFile(old, 'utf8').catch(() => ''));
    if (text.length <= MODEL_REVIEW_MAX_CHARS) {
      return text;
    }
    return `${text.slice(0, MODEL_REVIEW_MAX_CHARS)}\n……（模型评价共 ${String(text.length)} 字，这里只给前 ${String(MODEL_REVIEW_MAX_CHARS)} 字；要看全文读 ${file}）`;
  }


  /** 只在加载时归一化引擎与事件设置；getSetting 直接读已经确定的快照。 */
  private readSettings(): Settings {
    /** config.yaml 的 engine。 */
    const engine = checks.asRecord(this.config.engine ?? {}, 'engine');
    /** config.yaml 的 events。 */
    const events = checks.asRecord(this.config.events ?? {}, 'events');
    return {
      pollMs: checks.requireFiniteNumber(
        engine.poll_ms ?? ENGINE_DEFAULTS.poll_ms,
        'engine.poll_ms',
      ),
      mergeMs: checks.requireFiniteNumber(
        engine.merge_ms ?? ENGINE_DEFAULTS.merge_ms,
        'engine.merge_ms',
      ),
      maxRounds: checks.requireFiniteNumber(
        engine.max_rounds ?? ENGINE_DEFAULTS.max_rounds,
        'engine.max_rounds',
      ),
      compressAt: checks.requireFiniteNumber(
        engine.compress_at ?? ENGINE_DEFAULTS.compress_at,
        'engine.compress_at',
      ),
      execPass: checks.requireFiniteNumber(
        engine.exec_pass ?? ENGINE_DEFAULTS.exec_pass,
        'engine.exec_pass',
      ),
      visionModel: checks.optionalString(engine.vision_model, 'engine.vision_model'),
      indexUrl: checks.optionalString(engine.index_url, 'engine.index_url'),
      memoryLibs: checks.optionalString(engine.memory_libs, 'engine.memory_libs'),
      wrapupModel: checks.optionalString(engine.wrapup_model, 'engine.wrapup_model'),
      imageModel: checks.optionalString(engine.image_model, 'engine.image_model'),
      overtimeMinutes: checks.requireFiniteNumber(
        engine.overtime_minutes ?? ENGINE_DEFAULTS.overtime_minutes,
        'engine.overtime_minutes',
      ),
      fallbackChain: readFallbackChain(engine, this.getDefaultModel()),
      fallbackMaxTries: checks.requireFiniteNumber(
        engine.fallback_max_tries ?? ENGINE_DEFAULTS.fallback_max_tries,
        'engine.fallback_max_tries',
      ),
      retryDelaysMs: checks.requireFiniteNumberList(
        engine.retry_delays_ms ?? ENGINE_DEFAULTS.retry_delays_ms,
        'engine.retry_delays_ms',
      ),
      fallbackSiblings: engine.fallback_include_siblings !== false,
      rateLimitCooldownMs: checks.requireFiniteNumber(
        engine.rate_limit_cooldown_minutes ?? ENGINE_DEFAULTS.rate_limit_cooldown_minutes,
        'engine.rate_limit_cooldown_minutes',
      ) * 60_000,
      eventsKeepDays: checks.requireFiniteNumber(
        events.keep_days ?? EVENTS_DEFAULTS.keep_days,
        'events.keep_days',
      ),
      eventsMaxDepth: checks.requireFiniteNumber(
        events.max_depth ?? EVENTS_DEFAULTS.max_depth,
        'events.max_depth',
      ),
      gateTimeoutMs: checks.requireFiniteNumber(
        events.gate_timeout_ms ?? EVENTS_DEFAULTS.gate_timeout_ms,
        'events.gate_timeout_ms',
      ),
      limitDefaultMinutes: checks.requireFiniteNumber(
        engine.limit_default_minutes ?? ENGINE_DEFAULTS.limit_default_minutes,
        'engine.limit_default_minutes',
      ),
      limitRemindBeforeMinutes: checks.requireFiniteNumber(
        engine.limit_remind_before_minutes ?? ENGINE_DEFAULTS.limit_remind_before_minutes,
        'engine.limit_remind_before_minutes',
      ),
      limitExtendMinutes: checks.requireFiniteNumber(
        engine.limit_extend_minutes ?? ENGINE_DEFAULTS.limit_extend_minutes,
        'engine.limit_extend_minutes',
      ),
      limitExtendTimes: checks.requireFiniteNumber(
        engine.limit_extend_times ?? ENGINE_DEFAULTS.limit_extend_times,
        'engine.limit_extend_times',
      ),
      limitJudgeModel: checks.optionalString(engine.limit_judge_model, 'engine.limit_judge_model'),
      limitReviewModel: checks.optionalString(engine.limit_review_model, 'engine.limit_review_model'),
      watchThinkSlowSeconds: checks.requireFiniteNumber(
        events.watch_think_slow_seconds ?? EVENTS_DEFAULTS.watch_think_slow_seconds,
        'events.watch_think_slow_seconds',
      ),
      watchThinkMaxSteps: checks.requireFiniteNumber(
        events.watch_think_max_steps ?? EVENTS_DEFAULTS.watch_think_max_steps,
        'events.watch_think_max_steps',
      ),
      watchToolFailRun: checks.requireFiniteNumber(
        events.watch_tool_fail_run ?? EVENTS_DEFAULTS.watch_tool_fail_run,
        'events.watch_tool_fail_run',
      ),
      watchRagSlowMs: checks.requireFiniteNumber(
        events.watch_rag_slow_ms ?? EVENTS_DEFAULTS.watch_rag_slow_ms,
        'events.watch_rag_slow_ms',
      ),
      watchRagRepeat: checks.requireFiniteNumber(
        events.watch_rag_repeat ?? EVENTS_DEFAULTS.watch_rag_repeat,
        'events.watch_rag_repeat',
      ),
    };
  }
}
