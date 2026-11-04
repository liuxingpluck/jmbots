/**
 * 资源：启动时第一个创建的对象，只负责“检查”和“列资源”，不负责执行（执行在 Engine.ts）。
 *
 * 运行时目录（默认 F:\aidata\AIJMBots，可用 --runtime 指定）里放除代码外的全部东西。
 * 用户 11-02 定的结构：bots、agents、workspaces、知识库只放配置和最终结果，对话相关的全在 logs，数据库在 data。
 *   config.yaml                      主配置：模型供应商、默认模型、各用途的模型、工作区、执行设置、渠道（不存在就自动建一份模板）
 *   bots/<名字>/config.yaml          机器人（有状态）：模型、思考强度、工具、判断方式、系统提示词积木
 *   bots/<名字>/system.md            可选：系统提示词写成单独的文件时用它，优先于 config.yaml 里的 system
 *   bots/<名字>/记忆.md               可选：机器人的长期记忆，每次执行拼进系统提示词
 *   agents/<名字>/config.yaml        智能体（无状态）：同样的字段，只是没有记忆
 *   workspaces/<名字>/工作区.yaml     AI 自己登记的工作区（config.yaml 里写的工作区不用再登记）
 *   workspaces/<名字>/files/         工作区默认的干活目录
 *   知识库/                           最终结果；知识库/模型评价.md 是模型能力评价，分派时用
 *   logs/bots/<机器人>/<会话ID>_<标题>/  机器人的会话日志：分派对话的标题以“分派_”开头，执行对话是 AI 起的标题
 *   logs/常规/<会话ID>_<标题>/         不走机器人的会话日志（智能体、直接调接口）
 *   data/jmbots.db                   SQLite 数据库：会话、事件、每步记录、工具结果、待确认的命令；服务的输出日志也放这里
 *   integrations/feishu/<机器人>/连接记录.md  飞书长连接什么时候连上、断线、重连（用户 11-02：外接的东西放 integrations，每个机器人一份）
 *   integrations/feishu/发件箱/       Claude 放 .md 文件，机器人发给最近私聊的人
 *   integrations/claude/给Claude/     机器人用 note_claude 工具给 Claude 留的话（Claude 定时看）；Claude 给机器人派活走 HTTP 接口
 *
 * 用户 11-02 的原话：“runtime 这个 class 类存在……用于去检测我刚刚所说的这些东西，以及提供对应的一个接口，但它本身不提供对应的执行能力。”
 */
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';


/** 不写 --runtime 时用的运行时目录（用户 11-02 定：除代码外全部放这里）。 */
export const DEFAULT_RUNTIME_DIR = 'F:/aidata/AIJMBots';


/** 全局分派智能体的默认名字；config.yaml 的 engine.dispatcher 可以改成别的智能体。 */
export const DEFAULT_DISPATCHER = '分派';


/** 一个模型供应商（config.yaml 的 providers 下的一项）。 */
export interface ProviderConfig {
  /** 接口地址，如 http://127.0.0.1:3425/v1（magpie）。 */
  base_url: string;

  /** 密钥，直接写在 config.yaml 里（用户定的）。 */
  api_key: string;

  /** 其余兼容设置原样交给 Pi。 */
  [key: string]: unknown;
}


/** 一个用途用哪个模型（config.yaml 的 models 下的一项，如 dispatch、decision、work）。 */
export interface ModelChoice {
  /** 供应商/模型 ID，如 magpie/workbuddy/deepseek-v4.1-flash。 */
  model?: string;

  /** 思考强度：off、minimal、low、medium、high、xhigh、max。 */
  thinking?: string;
}


/** 一个工作区：只是登记，真正的文件可以在运行时目录外面。 */
export interface WorkspaceInfo {
  /** 名字。 */
  name: string;

  /** 一句话说明，分派智能体靠它选工作区。 */
  description: string;

  /** 工具（read、edit、find、exec）干活的目录；没写就是 workspaces/<名字>/files。 */
  dir: string;

  /** 登记在哪：config.yaml，还是 AI 自己登记的 工作区.yaml。 */
  from: 'config' | 'registered';
}


/** 一个机器人或智能体（两者字段一样，区别是机器人有记忆和自己的会话目录）。 */
export interface RoleInfo {
  /** bot 是机器人，agent 是智能体。 */
  kind: 'bot' | 'agent';

  /** 名字，就是文件夹名。 */
  name: string;

  /** 文件夹。 */
  dir: string;

  /** 一句话说明，分派智能体靠它选。 */
  description: string;

  /** 系统提示词积木：积木名 → 正文，按书写顺序拼。 */
  system: Record<string, string>;

  /** 自己的模型；没写时是 undefined，执行时用全局默认模型。 */
  model?: string;

  /** 自己的思考强度；没写时用模型那一项的设置。 */
  thinking?: string;

  /** 能用的工具名；没写就是全部默认工具。 */
  tools?: string[];

  /** 每走完一步由谁判断下一步：rule（简单规则）、decision（决策模型）或某个智能体的名字。 */
  judge: string;

  /** 可以把任务转交给哪些机器人或智能体（名字）。 */
  routes: string[];
}


/** 执行设置（config.yaml 的 engine；旧写法 agent.max_steps 也认）。 */
export interface EngineSettings {
  /** 一次执行最多调几次模型，防止死循环。 */
  maxSteps: number;

  /** 全局分派智能体的名字（agents 下的文件夹）。 */
  dispatcher: string;

  /** exec 命令怎么审核：decision（先问决策模型，不放心再问人）、human（每次都问人）、off（不审核，直接执行）。 */
  execReview: 'decision' | 'human' | 'off';

  /** 决策模型认为“安全”的概率不低于它，就直接执行。 */
  passProbability: number;

  /** 给决策模型的问题（config.yaml 的 decision.questions），原样交给 Pi 的 classify。 */
  questions: Record<string, unknown>;

  /** 分派对话用的模型（engine.route_model）；模型清单里没有时用机器人自己的模型。分派要快，默认评测里最快的 DeepSeek-V4.1-Flash。 */
  routeModel: string;

  /** 分派对话的思考强度（engine.route_thinking），默认 off。 */
  routeThinking: string;

  /** 看门狗：执行多少分钟没有新步骤就提醒（engine.watchdog_minutes），0 表示不看。 */
  watchdogMinutes: number;

  /** jmindex 的地址（如 http://127.0.0.1:30090）；不写就不挑上下文。 */
  indexUrl?: string;

  /** 挑上下文时，决策模型给出多大概率算"有帮助"。 */
  indexKeepAbove: number;
}


/** 并发配额（config.yaml 的 concurrency）：同一时间最多几个调用，超了排队（Model.ts）。用户 11-02：放配置里，默认 3，模型和供应商可以各有各的。 */
export interface ConcurrencySettings {
  /** 每个模型默认最多几个（concurrency.default，默认 3）。 */
  perModel: number;

  /** 单独设的模型：“供应商/模型 ID” → 上限（concurrency.models）。 */
  models: Record<string, number>;

  /** 供应商合计上限：供应商名 → 它所有模型加起来最多几个（concurrency.providers）；没写的供应商不限。 */
  providers: Record<string, number>;
}


/**
 * 读一组“名字 → 正整数”的配额。
 * @param value config.yaml 里的值。
 * @param name 配置项名字（报错用）。
 * @throws 不是正整数时抛错。
 */
function readQuota(value: unknown, name: string): Record<string, number> {
  /** 结果。 */
  const quota: Record<string, number> = {};
  for (const [key, raw] of Object.entries(checks.asRecord(value ?? {}, name))) {
    /** 数字。 */
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`config.yaml 的 ${name}.${key} 要是正整数，现在是 ${JSON.stringify(raw)}`);
    }
    quota[key] = number;
  }
  return quota;
}


/** 第一次启动时写的 config.yaml 模板；用户照着填供应商和模型。 */
const CONFIG_TEMPLATE = `# jmbots 主配置。除了代码，所有东西都放在这个文件所在的文件夹（运行时目录）里。
# 模型供应商：地址和密钥写在一起。magpie 是本机的模型网关（桌面程序要开着）。
providers: {}
#  magpie:
#    base_url: http://127.0.0.1:3425/v1
#    api_key: 你的密钥

# 全局默认模型：机器人和智能体没写模型时用它。写成“供应商/模型 ID”。
# default_model: magpie/workbuddy/deepseek-v4.1-flash

# 各用途的模型：dispatch 分派、decision 决策模型（审核 exec、判断下一步）。
models: {}

# 工作区：只是登记。dir 是工具干活的目录，可以在运行时目录外面。
workspaces: {}

# 执行设置。
engine:
  max_steps: 30
  dispatcher: 分派
  exec_review: decision
`;


/**
 * 老的中文结构目录 → 新的 ASCII 名字。只管程序自己建的那些；
 * 用户起名的 bots/<机器人>、workspaces/<工作区> 保持中文不动（框架文档 4.2）。
 */
/** 分派时最多把《模型能力评价》的前多少字塞进提示词：它每句话都要带一次，整篇太长。 */
const MODEL_REVIEW_MAX_CHARS = 1200;


/** 基础系统提示词放在运行时目录的哪个文件夹。 */
const PROMPTS_DIR = 'prompts';


const LEGACY_FOLDERS: [string, string][] = [
  ['知识库', 'knowledge'],
  ['logs/常规', 'logs/general'],
  ['logs/评测', 'logs/eval'],
  ['integrations/feishu/发件箱/已发', 'integrations/feishu/sent'],
  ['integrations/feishu/发件箱', 'integrations/feishu/outbox'],
  ['integrations/feishu/收件箱', 'integrations/feishu/inbox'],
  ['integrations/claude/给Claude', 'integrations/claude/inbox'],
];


/**
 * 把运行时目录准备好：老目录改名、建目录骨架、写模板文件。**这是资源里仅有的写操作**
 * （框架文档第 10 步：资源只回答"有什么"，写的事单独拿出来，只在真要用这个目录时做一次）。
 * @param root 运行时目录（绝对路径）。
 * @returns 无。
 * 副作用：改目录名、建目录、写 config.yaml 和分派智能体的模板（都不覆盖已有的）。
 */
export async function setupRuntimeDir(root: string): Promise<void> {
  //M 1. 老目录改名：结构目录一律 ASCII（中文路径进了 .cmd 和 exec 命令行会乱码，见框架文档 4.2）。
  await renameLegacyFolders(root);

  //M 2. 建目录骨架和模板文件（已存在的不覆盖：flag wx 只在文件不存在时写）。
  for (const folder of ['bots', 'agents', 'workspaces', 'knowledge', 'logs', 'data', 'integrations/feishu/outbox', 'integrations/claude/inbox']) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'config.yaml'), CONFIG_TEMPLATE, { flag: 'wx' }).catch(checks.ignoreExists);

  //M 3. 分派智能体的文件夹（用 config.yaml 里写的名字）。
  /** 刚读到的 config.yaml。 */
  const config = checks.asRecord(Bun.YAML.parse(await fs.readFile(path.join(root, 'config.yaml'), 'utf8')) ?? {}, 'config.yaml');
  /** 分派智能体的名字。 */
  const dispatcher = checks.optionalString(checks.asRecord(config.engine ?? {}, 'engine').dispatcher, 'engine.dispatcher') ?? DEFAULT_DISPATCHER;
  await fs.mkdir(path.join(root, 'agents', dispatcher), { recursive: true });
  await fs.writeFile(path.join(root, 'agents', dispatcher, 'config.yaml'), DISPATCHER_TEMPLATE, { flag: 'wx' }).catch(checks.ignoreExists);

  //M 4. 基础系统提示词：把仓库里的出厂默认复制进运行时目录（已有的不覆盖，用户改过的要留住）。
  await copyDefaultPrompts(root);
}


/**
 * 把仓库 prompts/ 里的出厂默认提示词复制进运行时目录的 prompts/。
 * 已经有同名文件就不动——用户改过的那份才是准。
 * @param root 运行时目录。
 * @returns 无。
 * 副作用：建 prompts/ 目录、复制文件。
 */
async function copyDefaultPrompts(root: string): Promise<void> {
  /** 仓库里的出厂默认在哪（src/resources/ 往上两层就是项目根）。 */
  const from = path.resolve(import.meta.dir, '..', '..', 'prompts');
  /** 运行时目录里的。 */
  const to = path.join(root, PROMPTS_DIR);
  await fs.mkdir(to, { recursive: true });
  if (!fsSync.existsSync(from)) {
    return;
  }
  for (const name of await fs.readdir(from)) {
    if (!name.endsWith('.md') || name === 'README.md') {
      continue;
    }
    await fs.copyFile(path.join(from, name), path.join(to, name), fsSync.constants.COPYFILE_EXCL).catch(checks.ignoreExists);
  }
}


/**
 * 把老的中文结构目录改成 ASCII 名字（带着里面的东西一起搬）。
 * 新名字已经存在就不动，免得把两边的内容搅在一起；改不动（被占用等）也只是打一行日志，不挡启动。
 * @param root 运行时目录。
 * @returns 无。
 * 副作用：重命名目录，可能往控制台打日志。
 */
async function renameLegacyFolders(root: string): Promise<void> {
  for (const [from, to] of LEGACY_FOLDERS) {
    /** 老目录。 */
    const oldDir = path.join(root, from);
    /** 新目录。 */
    const newDir = path.join(root, to);
    //G 老的不在、或者新的已经在了，都不动。
    if (!fsSync.existsSync(oldDir) || fsSync.existsSync(newDir)) {
      continue;
    }
    try {
      await fs.mkdir(path.dirname(newDir), { recursive: true });
      await fs.rename(oldDir, newDir);
      console.log(`运行时目录改名：${from} → ${to}`);
    } catch (error) {
      console.error(`运行时目录 ${from} 改名失败（不影响启动，下次再试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}


/** 第一次启动时写的分派智能体；用户和 AI 都可以改它。 */
const DISPATCHER_TEMPLATE = `description: 全局分派：判断一条任务交给哪个机器人、哪个智能体，还是直接用模型做
judge: rule
tools: []
system:
  身份: |
    你是 jmbots 的分派员。你不做任务本身，只决定这条任务交给谁做、放在哪个工作区。
  规矩: |
    下面会列出可选的机器人（有记忆）、智能体（专家角色）、模型和工作区。
    - 任务明显属于某个机器人或智能体的专长，就交给它；
    - 都不合适，就直接交给默认模型；
    - 工作区选最贴近的；都不合适时，可以起一个新的工作区名字，并写上它的目录（没有目录就留空）。
    只回一个 JSON 对象，不要别的文字：
    {"kind": "bot 或 agent 或 model", "name": "名字或模型 ID", "workspace": "工作区名字", "workspace_dir": "新工作区的目录，可空", "reason": "一句话理由"}
`;


/**
 * 读一个可选的文本文件：不存在时返回 undefined，别的错误照常抛出。
 * @param file 文件路径。
 */
async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}


/**
 * 列出一个目录下的子文件夹名；目录不存在时是空数组。
 * @param dir 目录。
 */
async function listFolders(dir: string): Promise<string[]> {
  /** 目录里的条目；目录不存在时当作空。 */
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}


/**
 * 系统提示词写法统一成积木：字符串当成一块“系统”，映射按书写顺序保留，空块去掉。
 * @param value config.yaml 里 system 的原样。
 */
function toBlocks(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    return value.trim() ? { 系统: value } : {};
  }
  /** 积木名 → 正文。 */
  const blocks: Record<string, string> = {};
  for (const [name, text] of Object.entries(checks.asRecord(value ?? {}, 'system'))) {
    if (typeof text === 'string' && text.trim()) {
      blocks[name] = text;
    }
  }
  return blocks;
}


/**
 * 读 bots 或 agents 下的全部角色：每个含 config.yaml 的子文件夹是一个。
 * @param root bots 或 agents 目录。
 * @param kind bot 或 agent。
 */
async function readRoles(root: string, kind: 'bot' | 'agent'): Promise<RoleInfo[]> {
  /** 读到的角色。 */
  const roles: RoleInfo[] = [];
  for (const name of await listFolders(root)) {
    /** 这个角色的文件夹。 */
    const dir = path.join(root, name);
    /** 角色配置原文；没有 config.yaml 的文件夹不是角色。 */
    const text = await readOptional(path.join(dir, 'config.yaml'));
    if (text === undefined) {
      continue;
    }
    /** 角色配置。 */
    const config = checks.asRecord(Bun.YAML.parse(text), `${dir}/config.yaml`);

    //M 系统提示词：有 system.md 就用它，否则用 config.yaml 里的 system 积木。
    /** 单独文件里的系统提示词。 */
    const systemFile = await readOptional(path.join(dir, 'system.md'));
    /** 积木。 */
    const system = systemFile === undefined ? toBlocks(config.system) : toBlocks(systemFile);

    roles.push({
      kind,
      name,
      dir,
      description: checks.optionalString(config.description, `${name} 的 description`) ?? '',
      system,
      model: checks.optionalString(config.model, `${name} 的 model`),
      thinking: checks.optionalString(config.thinking, `${name} 的 thinking`),
      tools: checks.optionalStringList(config.tools, `${name} 的 tools`),
      judge: checks.optionalString(config.judge, `${name} 的 judge`) ?? 'rule',
      routes: checks.optionalStringList(config.routes, `${name} 的 routes`) ?? [],
    });
  }
  return roles;
}


/** 资源：配置和资源清单。用 Resources.load 创建。 */
export class Resources {
  /** 运行时目录（绝对路径）。 */
  readonly dir: string;

  /** 主配置文件路径。 */
  readonly configFile: string;

  /** 主配置原样（含密钥）。**私有**：外面要什么用下面的函数拿，不许整个端出去。 */
  private readonly config: Record<string, unknown>;

  /** 机器人；外面用 listRoles('bot')。 */
  private readonly bots: RoleInfo[];

  /** 智能体；外面用 listRoles('agent')。 */
  private readonly agents: RoleInfo[];


  /**
   * 只在 load 里调用。
   * @param dir 运行时目录。
   * @param config 主配置。
   * @param bots 机器人。
   * @param agents 智能体。
   */
  private constructor(dir: string, config: Record<string, unknown>, bots: RoleInfo[], agents: RoleInfo[]) {
    this.dir = dir;
    this.configFile = path.join(dir, 'config.yaml');
    this.config = config;
    this.bots = bots;
    this.agents = agents;
  }


  /**
   * 打开运行时目录：没有就建；没有 config.yaml 就写一份模板；没有分派智能体就写一份默认的。
   * 没有模型也能打开，由 problems() 报出来，执行时再拒绝。
   * @param dir 运行时目录；不写用 DEFAULT_RUNTIME_DIR。
   * @throws config.yaml 不是合法 YAML 映射、某个角色配置写错时抛错。
   */
  static async load(dir: string = DEFAULT_RUNTIME_DIR, options: { setup?: boolean } = {}): Promise<Resources> {
    /** 绝对路径。 */
    const root = path.resolve(dir);
    //M 要写的那几下（建目录、写模板、老目录改名）都在 setupRuntimeDir 里，默认做一次；
    //  框架文档第 10 步要求资源只回答"有什么"，所以写操作单独成函数、可以关掉（只读打开）。
    if (options.setup !== false) {
      await setupRuntimeDir(root);
    }

    //M 读配置、机器人和智能体——到这里为止只读。
    /** config.yaml。 */
    const config = checks.asRecord(Bun.YAML.parse(await fs.readFile(path.join(root, 'config.yaml'), 'utf8').catch(() => '')) ?? {}, 'config.yaml');
    /** 机器人。 */
    const bots = await readRoles(path.join(root, 'bots'), 'bot');
    /** 智能体。 */
    const agents = await readRoles(path.join(root, 'agents'), 'agent');
    return new Resources(root, config, bots, agents);
  }


  /**
   * 某一类角色的全部。
   * @param kind 机器人还是智能体。
   * @returns 角色列表（原数组的副本，外面改不坏）。
   */
  listRoles(kind: 'bot' | 'agent'): RoleInfo[] {
    return [...(kind === 'bot' ? this.bots : this.agents)];
  }


  /**
   * 模型供应商（config.yaml 的 providers）。
   * @returns 供应商 ID → 设置。
   */
  getProviders(): Record<string, ProviderConfig> {
    return checks.asRecord(this.config.providers ?? {}, 'providers') as Record<string, ProviderConfig>;
  }


  /**
   * 全部用途配的模型（config.yaml 的 models）。按模型 ID 反查设置时用。
   * @returns 用途名 → 模型设置。
   */
  listModelChoices(): Record<string, ModelChoice> {
    return checks.asRecord(this.config.models ?? {}, 'models') as Record<string, ModelChoice>;
  }


  /**
   * 某个用途配的模型（config.yaml 的 models.<用途>）。
   * @param use 用途名，如 dispatch、decision、work。
   * @returns 没配就是 undefined。
   */
  getModelChoice(use: string): ModelChoice | undefined {
    return (checks.asRecord(this.config.models ?? {}, 'models') as Record<string, ModelChoice>)[use];
  }


  /**
   * 全局默认模型：default_model；没写时兼容旧写法 models.work.model。
   * @returns 都没有时是 undefined。
   */
  getDefaultModel(): string | undefined {
    return checks.optionalString(this.config.default_model, 'default_model') ?? this.getModelChoice('work')?.model;
  }


  /**
   * 某一项执行设置。
   * @param name 设置名。
   * @returns 没写的项返回默认值（默认值都在 engineSettings 里，方便和用户核对）。
   */
  getSetting<K extends keyof EngineSettings>(name: K): EngineSettings[K] {
    return this.engineSettings()[name];
  }


  /**
   * 决策用的某一道选择题（config.yaml 的 decision.questions.<名字>）。
   * @param name 题目名，如 next_step、tool_safe。
   * @returns 没写就是 undefined。
   */
  getQuestion(name: string): unknown {
    return this.engineSettings().questions[name];
  }


  /**
   * 某个渠道的设置（config.yaml 的 channels.<名字>）。
   * @param name 渠道名，如 feishu。
   * @returns 没开或没配就是 undefined。
   */
  getChannel(name: string): Record<string, unknown> | undefined {
    /** config.yaml 的 channels。 */
    const channels = checks.asRecord(this.config.channels ?? {}, 'channels');
    return channels[name] === undefined ? undefined : checks.asRecord(channels[name], `channels.${name}`);
  }


  /**
   * 基础系统提示词：所有角色共用，拼在各自提示词**前面**（用户 2026-11-04 定，为了让各种模型
   * 拿到它们习惯的那套开头）。运行时目录 prompts/ 下的 .md，按文件名排序依次拼。
   * @returns 每份一段；目录空的或读不了时是空数组（少这一块不影响干活）。
   */
  async readBasePrompts(): Promise<string[]> {
    /** 提示词目录。 */
    const dir = path.join(this.dir, PROMPTS_DIR);
    /** 目录里的文件。 */
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    /** 读出来的内容，按文件名排序。 */
    const parts: string[] = [];
    for (const name of names.filter((item) => item.endsWith('.md') && item !== 'README.md').sort()) {
      /** 这一份。 */
      const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
      if (text.trim()) {
        parts.push(text.trim());
      }
    }
    return parts;
  }


  /**
   * 开了哪些聊天渠道（config.yaml 的 channels）。
   *
   * 每一项可以写成一个对象，也可以写成对象数组——同一种渠道接好几个号就写数组
   * （比如两个飞书机器人，将来微信也一样）。`enabled: false` 的不返回。
   * @returns 渠道名 + 它那一份设置；同名多份会按顺序各出现一次。
   */
  listChannels(): { name: string; settings: Record<string, unknown> }[] {
    /** config.yaml 的 channels。 */
    const channels = checks.asRecord(this.config.channels ?? {}, 'channels');
    /** 结果。 */
    const found: { name: string; settings: Record<string, unknown> }[] = [];
    for (const [name, raw] of Object.entries(channels)) {
      //M 一个对象或一组对象都收，统一按数组处理。
      for (const [index, item] of (Array.isArray(raw) ? raw : [raw]).entries()) {
        /** 这一份设置。 */
        const settings = checks.asRecord(item, `channels.${name}${Array.isArray(raw) ? `[${String(index)}]` : ''}`);
        if (settings.enabled !== true) {
          continue;
        }
        found.push({ name, settings });
      }
    }
    return found;
  }


  /**
   * HTTP 设置（config.yaml 的 http）。
   * @returns 没写就是空对象。
   */
  getHttp(): Record<string, unknown> {
    return checks.asRecord(this.config.http ?? {}, 'http');
  }


  /**
   * 搜索设置（config.yaml 的 search），web_search 工具用。
   * @returns 没写就是 undefined。
   */
  getSearch(): unknown {
    return this.config.search;
  }


  /** 执行设置；没写的项用默认值（默认值都在这里，方便和用户核对）。外面用 getSetting。 */
  private engineSettings(): EngineSettings {
    /** config.yaml 的 engine。 */
    const engine = checks.asRecord(this.config.engine ?? {}, 'engine');
    /** 旧写法 agent（zbots 时期的 config.yaml）。 */
    const legacy = checks.asRecord(this.config.agent ?? {}, 'agent');
    /** config.yaml 的 decision：通过概率和问题。 */
    const decision = checks.asRecord(this.config.decision ?? {}, 'decision');
    /** 审核方式原文。 */
    const review = engine.exec_review ?? 'decision';
    if (review !== 'decision' && review !== 'human' && review !== 'off') {
      throw new Error(`config.yaml 的 engine.exec_review 只能是 decision、human、off，现在是 ${JSON.stringify(review)}`);
    }
    return {
      maxSteps: Number(engine.max_steps ?? legacy.max_steps ?? 100),
      dispatcher: checks.optionalString(engine.dispatcher, 'engine.dispatcher') ?? DEFAULT_DISPATCHER,
      execReview: review,
      passProbability: Number(decision.pass_probability ?? 0.2),
      questions: checks.asRecord(decision.questions ?? {}, 'decision.questions'),
      routeModel: checks.optionalString(engine.route_model, 'engine.route_model') ?? 'magpie/workbuddy/deepseek-v4.1-flash',
      routeThinking: checks.optionalString(engine.route_thinking, 'engine.route_thinking') ?? 'off',
      watchdogMinutes: Number(engine.watchdog_minutes ?? 15),
      //M 挑上下文（jmindex）：不写 index_url 就整块不启用，干活照旧。
      indexUrl: checks.optionalString(engine.index_url, 'engine.index_url'),
      indexKeepAbove: Number(engine.index_keep_above ?? 0.6),
    };
  }


  /**
   * config.yaml 里所有像密钥的值（键名带 secret、key、token、password，8 个字以上）：工具结果里出现就换成 ***。
   * @returns 密钥值列表（只给后端抹字用，不要往别处传）。
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
   * 并发配额；没写的项用默认值（每个模型 3 个，供应商不限）。
   * @returns 配额设置。
   */
  getConcurrency(): ConcurrencySettings {
    /** config.yaml 的 concurrency。 */
    const concurrency = checks.asRecord(this.config.concurrency ?? {}, 'concurrency');
    /** 每个模型的默认上限。 */
    const perModel = Number(concurrency.default ?? 3);
    if (!Number.isInteger(perModel) || perModel < 1) {
      throw new Error(`config.yaml 的 concurrency.default 要是正整数，现在是 ${JSON.stringify(concurrency.default)}`);
    }
    return { perModel, models: readQuota(concurrency.models, 'concurrency.models'), providers: readQuota(concurrency.providers, 'concurrency.providers') };
  }


  /**
   * 列出全部工作区：config.yaml 里写的，加上 AI 在 workspaces/<名字>/工作区.yaml 登记的（同名以 config.yaml 为准）。
   */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    /** 结果，按名字去重。 */
    const result = new Map<string, WorkspaceInfo>();

    //M 1. config.yaml 里写的工作区（work_dir 是旧写法，dir 是新写法）。
    for (const [name, raw] of Object.entries(checks.asRecord(this.config.workspaces ?? {}, 'workspaces'))) {
      /** 这一项的设置；只写了名字时是空映射。 */
      const item = checks.asRecord(raw ?? {}, `workspaces.${name}`);
      /** 目录原文。 */
      const dir = checks.optionalString(item.dir ?? item.work_dir, `workspaces.${name}.dir`);
      result.set(name, {
        name,
        description: checks.optionalString(item.description, `workspaces.${name}.description`) ?? '',
        dir: dir ? path.resolve(this.dir, dir) : this.defaultWorkspaceDir(name),
        from: 'config',
      });
    }

    //M 2. AI 登记的工作区。
    for (const name of await listFolders(path.join(this.dir, 'workspaces'))) {
      /** 登记文件原文；没有就不是登记过的工作区（可能只是会话目录）。 */
      const text = await readOptional(path.join(this.dir, 'workspaces', name, '工作区.yaml'));
      if (text === undefined || result.has(name)) {
        continue;
      }
      /** 登记内容。 */
      const item = checks.asRecord(Bun.YAML.parse(text) ?? {}, `workspaces/${name}/工作区.yaml`);
      /** 目录原文。 */
      const dir = checks.optionalString(item.dir, `${name} 的 dir`);
      result.set(name, {
        name,
        description: checks.optionalString(item.description, `${name} 的 description`) ?? '',
        dir: dir ? path.resolve(dir) : this.defaultWorkspaceDir(name),
        from: 'registered',
      });
    }
    return [...result.values()];
  }


  /**
   * 找一个工作区；没有就登记一个新的（分派智能体可以起新名字）。
   * @param name 工作区名字。
   * @param dir 新工作区的目录；不写就是 workspaces/<名字>/files。
   * @param description 新工作区的说明。
   * @returns 工作区；它的目录保证存在。
   * 副作用：新工作区会写 workspaces/<名字>/工作区.yaml，并建好目录。
   */
  async ensureWorkspace(name: string, dir?: string, description = ''): Promise<WorkspaceInfo> {
    checks.safeName(name, '工作区名字');
    /** 已有的工作区。 */
    let workspace = (await this.listWorkspaces()).find((item) => item.name === name);
    if (!workspace) {
      //M 登记新工作区。
      workspace = { name, description, dir: dir ? path.resolve(dir) : this.defaultWorkspaceDir(name), from: 'registered' };
      await fs.mkdir(path.join(this.dir, 'workspaces', name), { recursive: true });
      await fs.writeFile(
        path.join(this.dir, 'workspaces', name, '工作区.yaml'),
        Bun.YAML.stringify({ description, dir: workspace.dir }, null, 2),
      );
    }
    await fs.mkdir(workspace.dir, { recursive: true });
    return workspace;
  }


  /**
   * 工作区的默认目录：workspaces/<名字>/files。
   * @param name 工作区名字。
   */
  defaultWorkspaceDir(name: string): string {
    return path.join(this.dir, 'workspaces', name, 'files');
  }


  /**
   * 按种类和名字找机器人或智能体。
   * @param kind bot 或 agent。
   * @param name 名字。
   * @throws 找不到时抛错，报出现有的名字。
   */
  getRole(kind: 'bot' | 'agent', name: string): RoleInfo {
    /** 同种类的全部角色。 */
    const roles = kind === 'bot' ? this.bots : this.agents;
    /** 找到的角色。 */
    const role = roles.find((item) => item.name === name);
    if (!role) {
      throw new Error(`没有${kind === 'bot' ? '机器人' : '智能体'} ${name}；现有：${roles.map((item) => item.name).join('、') || '无'}`);
    }
    return role;
  }


  /**
   * 会话日志的目录：logs/bots/<机器人>/<会话ID>_<标题>/，不走机器人的放 logs/general/<会话ID>_<标题>/。
   * 标题在会话建好时就定了（分派对话在第一次写日志前定），之后不改，目录不会变。
   * @param session 会话 ID、机器人、标题。
   */
  sessionDir(session: { id: string; bot: string | null; title: string }): string {
    /** 文件夹名。 */
    const folder = `${session.id}_${utils.safeFolderName(session.title)}`;
    if (session.bot) {
      return path.join(this.dir, 'logs', 'bots', session.bot, folder);
    }
    return path.join(this.dir, 'logs', 'general', folder);
  }


  /**
   * 读机器人的长期记忆（bots/<名字>/记忆.md）；没有时是空字符串。
   * @param bot 机器人。
   */
  async readMemory(bot: RoleInfo): Promise<string> {
    return (await readOptional(path.join(bot.dir, '记忆.md'))) ?? '';
  }


  /** 模型能力评价（自然语言，scripts/Eval_Models.ts 评测后写，也可以手改）：分派时拼进提示词。 */
  get modelReviewFile(): string {
    return path.join(this.dir, 'knowledge', '模型评价.md');
  }


  /** 读模型能力评价；还没有时是空字符串。 */
  async readModelReview(): Promise<string> {
    /** 全文。 */
    const text = (await readOptional(this.modelReviewFile)) ?? '';
    //G 太长就截断：分派对话每来一句话都要把它塞进系统提示词，整篇三千字会把分派拖慢、也烧钱
    //  （周小灵 11-04 追数据流向时发现）。分派只需要知道各模型大致擅长什么，不用看完整评测。
    if (text.length <= MODEL_REVIEW_MAX_CHARS) {
      return text;
    }
    return `${text.slice(0, MODEL_REVIEW_MAX_CHARS)}\n……（模型评价共 ${String(text.length)} 字，这里只给前 ${String(MODEL_REVIEW_MAX_CHARS)} 字；要看全文读 ${this.modelReviewFile}）`;
  }


  /** 数据库文件。 */
  get dbFile(): string {
    return path.join(this.dir, 'data', 'jmbots.db');
  }


  /**
   * 检查能不能执行：列出问题（没有供应商、没有默认模型……），没问题时是空数组。
   * 用户原话：“如果里面没有模型，启动之后就会提示没有模型，无法执行。”
   */
  problems(): string[] {
    /** 发现的问题。 */
    const found: string[] = [];
    if (Object.keys(this.getProviders()).length === 0) {
      found.push(`${this.configFile} 里没有模型供应商（providers），无法执行。`);
    }
    if (!this.getDefaultModel()) {
      found.push(`${this.configFile} 里没有默认模型（default_model），机器人和智能体没写模型时无法执行。`);
    }
    return found;
  }
}
