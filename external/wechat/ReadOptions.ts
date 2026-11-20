/** 外置微信读取参数，启动时校验后交给 Reader 和后台轮询。 */
import * as serviceModule from './ReaderService.ts';

/** 供独立进程的 parseArgs 合并读取端参数。 */
export const READ_FLAGS = {
  'interval-ms': { type: 'string' },
  'chat-limit': { type: 'string' },
  'at-names': { type: 'string' },
  'archive-all': { type: 'boolean' },
} as const;

/** 仅消费 parseArgs 已认出的读取端参数。 */
interface WrittenReads {
  /** 轮询节拍，字符串表示的毫秒。 */
  'interval-ms'?: string;
  /** 每个账号的最近会话上限。 */
  'chat-limit'?: string;
  /** 群中用于识别提及本账号的额外昵称，以逗号隔开。 */
  'at-names'?: string;
  /** 是否在后台归档未监听会话。 */
  'archive-all'?: boolean;
}

/**
 * 读启动参数并返回 Reader 和轮询所用配置。
 * @param values parseArgs 已解析的参数。
 * @returns 昵称列表字符串与校验后的读取配置。
 */
export function getReadOptions(values: WrittenReads): { atNames: string; config: serviceModule.ReaderSettings } {
  const defaults = serviceModule.DEFAULT_READ_SETTINGS;
  const rawInterval = values['interval-ms'] ?? String(defaults.intervalMs);
  const rawLimit = values['chat-limit'] ?? String(defaults.chatLimit);
  const intervalMs = Number(rawInterval);
  const chatLimit = Number(rawLimit);

  //G 0 轮询表示禁用；禁止会被定时器重置为极短间隔的超长数值。
  if (!/^\d+$/u.test(rawInterval) || !Number.isInteger(intervalMs) || intervalMs > 2_147_483_647) {
    throw new Error('--interval-ms 要是 0 至 2147483647 的整数');
  }
  if (!/^\d+$/u.test(rawLimit) || !Number.isSafeInteger(chatLimit) || chatLimit < 1) {
    throw new Error('--chat-limit 要是正整数');
  }

  const atNames = values['at-names'] ?? '';
  const archiveAll = values['archive-all'] ?? defaults.archiveAll;
  return { atNames, config: { intervalMs, chatLimit, archiveAll } };
}
