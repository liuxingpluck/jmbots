/**
 * zbots 的运行时：读命令行参数 --config 和 config.yaml，算出各个目录并建好，列出工作区和 bot。
 * 入口（Main.ts）调一次 loadRuntime，拿到的 Runtime 当参数传给别的模块；别处不再自己读 config.yaml。
 * 配置里每一段的含义写在 config.example.yaml 的注释里，这里只放代码用到的字段。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import type * as feishu from './Feishu.ts';
import * as utils from './Utils.ts';


/** 一个模型供应商（config.yaml 的 providers 下的一项），和旧版 JMAI 一样地址和密钥写在一起。 */
export interface ProviderConfig {
  /** 接口地址，写到 /v1 为止，如 http://127.0.0.1:3425/v1。 */
  base_url: string;

  /** 密钥，请求时放进 Authorization: Bearer。 */
  api_key: string;

  /** 所有模型共用的兼容设置，原样交给 Pi。 */
  compat?: piAi.OpenAICompletionsCompat;

  /** 个别模型再加的兼容设置：模型 ID → 设置，覆盖 compat 里的同名项。 */
  model_compat?: Record<string, piAi.OpenAICompletionsCompat>;
}


/** 一个模型角色用哪个模型、多大思考强度（config.yaml 的 models 下的一项）。 */
export interface RoleConfig {
  /** 写成“供应商/模型 ID”，按第一个斜杠拆开，如 magpie/auto/deepseek-v4.1-flash。 */
  model: string;

  /** 思考强度：off、minimal、low、medium、high、xhigh、max；不写就不指定，由模型自己定。决策模型不用。 */
  thinking?: string;
}


/** 一个工作区的设置（config.yaml 的 workspaces 下的一项）。 */
export interface WorkspaceConfig {
  /** 这个工作区装什么样的对话；分派模型据此挑工作区。 */
  description: string;

  /** 工具默认干活的文件夹；空着就用这个工作区自己的 files/。相对路径以 config.yaml 所在目录为准。 */
  work_dir?: string;
}


/** 执行的设置（config.yaml 的 agent）。 */
export interface AgentConfig {
  /** 一轮最多调几次执行模型，到了就停下回复。 */
  max_steps: number;
}


/** 决策模型的用法（config.yaml 的 decision）：在哪里问、问什么。 */
export interface DecisionConfig {
  /** 调这些工具之前问“安全吗”（tool_safe）。 */
  check_tools: string[];

  /** “安全”的概率低于这个数，这次工具调用就不执行。 */
  pass_probability: number;

  /** 一轮里被拦超过这么多次，就停下把情况回给用户。 */
  max_blocks: number;

  /** 问题：名字 → 问法，原样交给决策模型。代码用到 tool_safe（安全吗）和 next_step（每走完一步问下一步怎么走）。 */
  questions: Record<string, piAi.ClassifierQuestion>;
}


/** config.yaml 的内容（只列代码已经用到的字段）。 */
export interface Config {
  /** 运行时目录：共享区、角色区、工作区、模型评估都在这下面。 */
  runtime_dir: string;

  /** 模型供应商：名字 → 地址、密钥、兼容设置。 */
  providers: Record<string, ProviderConfig>;

  /** 模型角色：dispatch（分派）、work（执行）、evaluate（评估）、decision（决策）→ 模型和思考强度。 */
  models: Record<string, RoleConfig>;

  /** 工作区：名字 → 说明和工作目录。 */
  workspaces: Record<string, WorkspaceConfig>;

  /** 执行的设置；要执行时才检查，见 Agent.ts 的 readSettings。 */
  agent?: AgentConfig;

  /** 决策门的设置；要执行时才检查，见 Agent.ts 的 readSettings。 */
  decision?: DecisionConfig;

  /** 聊天渠道：飞书（微信还没接）。 */
  channels?: { feishu?: feishu.FeishuConfig };
}


/** 运行时：配置加上算好的目录，目录都是绝对路径。 */
export interface Runtime {
  /** config.yaml 的路径。 */
  configFile: string;

  /** 配置内容。 */
  config: Config;

  /** 运行时目录。 */
  dir: string;

  /** 公共共享区：所有 bot 都能读写的记忆。 */
  sharedDir: string;

  /** 角色区的上级目录：每个 bot 一个子文件夹，放它的经历、对话列表和自己的记忆。 */
  rolesDir: string;

  /** 工作区的上级目录：每个工作区一个子文件夹，里面一个对话一个文件夹。 */
  workspacesDir: string;

  /** 模型评估：每轮结束后的质量、速度、花费记录和汇总。 */
  evaluationsDir: string;
}


/** 列工作区时每个工作区的信息。 */
export interface WorkspaceInfo {
  /** 工作区名字，也是它在运行时目录里的文件夹名。 */
  name: string;

  /** 这个工作区装什么样的对话。 */
  description: string;

  /** 工作区文件夹：索引文件和各个对话文件夹在这里。 */
  dir: string;

  /** 工具默认干活的文件夹。 */
  workDir: string;
}


/** 用户 11-02 定：除代码外全部放运行时目录；命令行没写 --config 时使用这里的配置。 */
const defaultConfigFile = 'F:\\aidata\\AIZbots\\config.yaml';


/**
 * 检查 config.yaml 的内容，缺了必需的段就停下，说清楚缺什么。
 * @param raw 解析出的原始内容。
 * @param configFile 配置文件路径，写进报错里。
 * @returns 检查过的配置；runtime_dir 没写时补为 .，即 config.yaml 所在文件夹。
 * @throws 缺 providers、models 的 dispatch/work/evaluate/decision、workspaces，或模型写法不对时抛错。
 */
function checkConfig(raw: unknown, configFile: string): Config {
  /** 原始内容按配置的样子看；字段在下面逐个检查。 */
  const config = (raw ?? {}) as Partial<Config>;
  if (!config.providers || Object.keys(config.providers).length === 0) {
    throw new Error(`${configFile} 里没有 providers（模型供应商）。`);
  }
  for (const role of ['dispatch', 'work', 'evaluate', 'decision']) {
    /** 这个角色的设置。 */
    const roleConfig = config.models?.[role];
    if (!roleConfig?.model?.includes('/')) {
      throw new Error(`${configFile} 的 models.${role}.model 要写成“供应商/模型 ID”。`);
    }
  }
  if (!config.workspaces || Object.keys(config.workspaces).length === 0) {
    throw new Error(`${configFile} 里没有 workspaces（工作区），至少要有一个。`);
  }
  return { ...config, runtime_dir: config.runtime_dir ?? '.' } as Config;
}


/**
 * 读配置、算目录、建目录骨架（运行时目录和它下面的 shared、roles、workspaces、evaluations）。
 * @param argv 命令行参数（不含 bun 和脚本路径）；只认 --config，不写就用 F:\aidata\AIZbots\config.yaml。
 * @returns 运行时对象，传给别的模块用。
 * @throws 配置文件读不到、不是合法 YAML、缺必需的段时抛错。
 * 副作用：建上面那几个目录（已有就不动）。
 */
export async function loadRuntime(argv: readonly string[]): Promise<Runtime> {
  /** 配置文件的绝对路径。 */
  const configFile = path.resolve(utils.getArg(argv, 'config') ?? defaultConfigFile);
  /** 配置里的相对路径都以配置文件所在目录为准。 */
  const configDir = path.dirname(configFile);
  const config = checkConfig(await utils.readYaml(configFile), configFile);

  /** 运行时目录。 */
  const dir = path.resolve(configDir, config.runtime_dir);
  const runtime: Runtime = {
    configFile,
    config,
    dir,
    sharedDir: path.join(dir, 'shared'),
    rolesDir: path.join(dir, 'roles'),
    workspacesDir: path.join(dir, 'workspaces'),
    evaluationsDir: path.join(dir, 'evaluations'),
  };
  for (const folder of [runtime.sharedDir, runtime.rolesDir, runtime.workspacesDir, runtime.evaluationsDir]) {
    await fs.mkdir(folder, { recursive: true });
  }
  return runtime;
}


/**
 * 列出配置里的全部工作区，按 config.yaml 的书写顺序。
 * @param runtime 运行时。
 * @returns 每个工作区的名字、说明、文件夹和工作目录。不建文件夹。
 */
export function listWorkspaces(runtime: Runtime): WorkspaceInfo[] {
  /** 配置文件所在目录，work_dir 的相对路径以它为准。 */
  const configDir = path.dirname(runtime.configFile);
  return Object.entries(runtime.config.workspaces).map(([name, workspace]) => {
    /** 工作区文件夹。 */
    const dir = path.join(runtime.workspacesDir, name);
    return {
      name,
      description: workspace.description,
      dir,
      workDir: workspace.work_dir ? path.resolve(configDir, workspace.work_dir) : path.join(dir, 'files'),
    };
  });
}


/**
 * 列出全部 bot：rolesDir 下每个含设定.yaml 文件的文件夹是一个角色，文件夹名就是名字。
 * @param runtime 运行时。
 * @returns 按名字排序的角色列表；角色目录不存在时为空数组。不写文件。
 * @throws 读取目录或检查设定文件失败（不存在除外）时抛错。
 */
export async function listBots(runtime: Runtime): Promise<string[]> {
  /** 角色工作区里的目录项；忽略不存在，其他读取错误交给调用方。 */
  const entries = await fs.readdir(runtime.rolesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  /** 实际含设定文件的角色名，不把只有历史记录的目录当作角色。 */
  const names: string[] = [];
  for (const entry of entries) {
    // g: 只检查角色目录，不把普通文件或设定.yaml 同名目录当作角色。
    if (!entry.isDirectory()) {
      continue;
    }
    /** 这个角色的设定文件是否存在且为普通文件。 */
    const settings = await fs.stat(path.join(runtime.rolesDir, entry.name, '设定.yaml')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (settings?.isFile()) {
      names.push(entry.name);
    }
  }
  return names.sort();
}
