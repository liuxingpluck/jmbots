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


/**
 * 这一轮工具给的路径落成绝对路径：相对的照这一轮的工作区解开，只许落在工作区或这一轮的授权目录里（用户 #301）。
 * file-tools 的读写、飞书发文件共用。
 * @param resources 运行时目录、机器人名单。
 * @param session 哪场会话：工作区、授权目录都看它现在记的回话地址。
 * @param relative 模型给的路径。
 * @returns 解开符号链接后的绝对路径。
 * @throws 没有这个机器人、出了工作区和授权目录时抛错。
 */
export function resolveSessionPath(
  resources: Pick<Resources, 'root' | 'raw'>,
  session: Session,
  relative: string,
): string {
  //M 先定这一轮的工作区，再取地址里的授权目录。
  const workspaceDir = getSessionWorkspace(resources, session);
  const grantDirs = workspace.getGrantDirs(session.row.address);

  //M 照工作区解开路径，落在工作区或授权目录里才交回。
  return workspace.resolveWorkspacePath(workspaceDir, relative, grantDirs);
}
