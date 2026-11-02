/**
 * zbots 的 bot（智能体）：角色工作区 roles/<名字>/设定.yaml 定义一个角色，文件夹名就是它的名字。
 * YAML 里写的是“它是谁、能做什么、走完一步由谁判断下一步”：说明、系统提示词积木、可用工具、判断者、可以转交的 bot。
 * 用哪个模型不在这里写，由运行时 config.yaml 的 models 统一定；角色设定和对话.md、经历.md 放在同一文件夹。
 */
import * as path from 'node:path';
import * as runtime from './Runtime.ts';
import * as utils from './Utils.ts';


/** 一个 bot 的定义。 */
export interface BotDefinition {
  /** 名字：roles 下含设定.yaml 的角色文件夹名。 */
  name: string;

  /** 一句话：这个 bot 做什么。别的 bot 要转交时，判断者据此挑人。 */
  description: string;

  /** 系统提示词积木：名字 → 正文，按书写顺序拼起来，块之间空一行，空的跳过。 */
  system: Record<string, string>;

  /** 能用的工具名；不写就是没有工具。 */
  tools: string[];

  /** 每走完一步由谁判断下一步：decision 是分类模型（config.yaml 的 models.decision）；写别的就是那个 bot 的名字，由它判断。 */
  judge: string;

  /** 判断时可以转交给哪些 bot；不写就不能转交。 */
  routes: string[];
}


/** YAML 里的写法：除了 system 都可以不写；空着的积木读出来是 null。 */
interface BotYaml {
  /** 说明。 */
  description?: string;

  /** 系统提示词积木。 */
  system?: Record<string, string | null>;

  /** 能用的工具名。 */
  tools?: string[];

  /** 判断者，不写就是 decision。 */
  judge?: string;

  /** 可以转交的 bot。 */
  routes?: string[];
}


/**
 * 读全部 bot，并检查它们之间的引用：判断者和转交对象都得是存在的 bot（判断者也可以是 decision）。
 * @param zbots 运行时。
 * @returns bot 名字 → 定义。
 * @throws 某个 YAML 没写 system，或引用了不存在的 bot 时抛错。
 */
export async function loadBots(zbots: runtime.Runtime): Promise<Record<string, BotDefinition>> {
  // m: 每个含设定.yaml 的角色工作区是一个 bot，目录名就是角色名。
  /** 读到的 bot。 */
  const bots: Record<string, BotDefinition> = {};
  /** 运行时角色工作区里实际有设定文件的角色名。 */
  const names = await runtime.listBots(zbots);
  for (const name of names) {
    /** 角色工作区中的设定文件路径。 */
    const file = path.join(zbots.rolesDir, name, '设定.yaml');
    /** 文件内容，字段在下面检查、补默认值。 */
    const raw = ((await utils.readYaml(file)) ?? {}) as BotYaml;
    if (!raw.system || Object.keys(raw.system).length === 0) {
      throw new Error(`${file} 里没有 system（系统提示词积木）。`);
    }
    /** 系统提示词积木；空着的块换成空字符串。 */
    const system: Record<string, string> = {};
    for (const [blockName, blockText] of Object.entries(raw.system)) {
      system[blockName] = blockText ?? '';
    }
    bots[name] = { name, description: raw.description ?? '', system, tools: raw.tools ?? [], judge: raw.judge ?? 'decision', routes: raw.routes ?? [] };
  }

  // g: 判断者和转交对象都得是存在的 bot，写错了启动时就报出来。
  for (const bot of Object.values(bots)) {
    if (bot.judge !== 'decision' && !bots[bot.judge]) {
      throw new Error(`bot ${bot.name} 的 judge 写的是 ${bot.judge}，但没有这个 bot（要么写 decision）。`);
    }
    for (const route of bot.routes) {
      if (!bots[route]) {
        throw new Error(`bot ${bot.name} 的 routes 里有 ${route}，但没有这个 bot。`);
      }
    }
  }
  return bots;
}
