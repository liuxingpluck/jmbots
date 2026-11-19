/** 从资源快照取机器人配置与目录。 */
import * as path from 'node:path';
import type { Resources } from '../Resources.ts';
import type { Session } from '../Sessions.ts';
import * as workspace from './Workspace.ts';

/** 机器人名及插件各自读取的配置项。 */
export interface BotConfig {
  name: string;
  [key: string]: unknown;
}

const DEFAULT_BOTS: readonly BotConfig[] = [{ name: '助手' }];

/** 机器人名单按配置顺序返回，空名单保持为空。 */
export function getBotConfigs(raw: Record<string, unknown>): readonly Readonly<BotConfig>[] {
  const configs = raw['bots'];
  if (configs === undefined || configs === null) return DEFAULT_BOTS;
  if (!Array.isArray(configs)) throw new Error('bots 要写成一张清单');

  return configs as BotConfig[];
}

/** 找已配置的机器人，调用方负责处理找不到时的业务结果。 */
export function getBotConfig(raw: Record<string, unknown>, name: string): Readonly<BotConfig> | undefined {
  const configs = getBotConfigs(raw);
  return configs.find((item) => item?.name === name);
}

/** 返回配置顺序里的第一位机器人。 */
export function getDefaultBot(raw: Record<string, unknown>): string | undefined {
  const configs = getBotConfigs(raw);
  return configs[0]?.name;
}

/** 提示词沿用机器人配置里的语言，缺省为中文。 */
export function getBotLanguage(raw: Record<string, unknown>, name: string): string {
  const config = getBotConfig(raw, name);
  const language = config?.['language'];
  if (typeof language === 'string') return language;

  return 'zh';
}

/** 机器人工作区和记忆目录沿用运行时目录的固定位置。 */
export function getBotDir(
  resources: Pick<Resources, 'root'>,
  name: string,
  kind: 'workspace' | 'memory',
): string {
  return path.join(resources.root, 'bots', name, kind);
}

/** 使用这一轮的回话地址选择工作区，未指定时用机器人工作区。 */
export function getSessionWorkspace(resources: Pick<Resources, 'root' | 'raw'>, session: Session): string {
  const row = session.row;
  //G 历史会话所属机器人已移除时，保持工具的原错误。
  if (getBotConfig(resources.raw, row.bot) === undefined) throw new Error(`没有这个机器人：${row.bot}`);

  const base = getBotDir(resources, row.bot, 'workspace');
  //M 地址上的工作区保留 Builder、Guest 和派出的会话各自的目录。
  return workspace.getWorkspace(base, row.address);
}
