/**
 * relay 文件收发通道、附件路径提取、回信附件沙箱边界校验与配置解析。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as botUtils from '../../utils/Bots.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as imageModule from '../../utils/Image.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import type {
  ExclusiveBotRule,
  Helper,
  OwnerGroupDirectRule,
  OwnerP2pDirectRule,
  RelayConfig,
  RelayWritten,
} from './index.ts';


/**
 * 确保一个机器人的文件收发目录 integrations/relay/<机器人>/ 及空 inbox.jsonl、replies.jsonl 存在。
 */
export function ensureBotRelayDir(resources: cordis.Context['resources'], bot: string): string {
  const dir = resources.ensureRuntimeDir('integrations', 'relay', bot);
  for (const file of ['inbox.jsonl', 'replies.jsonl']) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) fs.writeFileSync(full, '');
  }
  return dir;
}


/**
 * 从收件正文提取落在运行时目录内的 @绝对路径 附件，转成相对运行时根的正斜杠路径。
 */
export function extractRelativeFiles(root: string, text: string): string[] {
  const files: string[] = [];
  for (const file of imageModule.getAtPaths(text)) {
    if (!path.isAbsolute(file)) continue;

    const relative = path.relative(root, file);
    const up = relative === '..' || relative.startsWith(`..${path.sep}`);
    if (relative === '' || up || path.isAbsolute(relative)) continue;

    files.push(relative.split(path.sep).join('/'));
  }
  return files;
}


/**
 * 校验回信附带的文件路径必须落在该机器人的工作区或 integrations/relay/<bot>/ 内且真实存在。
 */
export function resolveAllowedReplyFile(
  resources: cordis.Context['resources'],
  bot: string,
  file: string,
): string {
  const root = resources.root;
  const full = path.resolve(root, file);

  const dirs: string[] = [];
  const config = botUtils.getBotConfig(resources.raw, bot);
  if (config !== undefined) {
    dirs.push(botUtils.getBotDir(resources, bot, 'workspace'));
  }
  dirs.push(path.join(root, 'bots', bot, 'workspaces'));
  dirs.push(path.join(root, 'integrations', 'relay', bot));

  let real: string | undefined;
  for (const dir of dirs) {
    try {
      real = workspaceModule.resolveWorkspacePath(dir, full, []);
      break;
    } catch {
      continue;
    }
  }
  if (real === undefined) {
    throw new failureModule.Failure(
      400,
      `回信带的文件只能在机器人 ${bot} 的工作区或 integrations/relay/${bot}/ 里：${file}`,
    );
  }
  if (!fs.existsSync(real) || !fs.statSync(real).isFile()) {
    throw new failureModule.Failure(400, `回信带的文件不在：${file}`);
  }
  return real;
}


/**
 * 按游标增量读取单个机器人的 replies.jsonl，坏行记入 replies.err.jsonl 不阻断后续行。
 */
export function pollBotReplyFile(
  dir: string,
  bot: string,
  acceptLine: (parsed: unknown, botName: string) => void,
): void {
  const file = path.join(dir, 'replies.jsonl');
  const posFile = path.join(dir, 'replies.pos');
  const size = fs.statSync(file).size;
  let pos = 0;
  if (fs.existsSync(posFile)) {
    pos = Number(fs.readFileSync(posFile, 'utf8').trim());
  }
  if (!Number.isInteger(pos) || pos < 0 || pos > size) {
    pos = 0;
  }
  if (pos === size) return;

  const data = Buffer.alloc(size - pos);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, data, 0, data.length, pos);
  } finally {
    fs.closeSync(fd);
  }
  const end = data.lastIndexOf(0x0a);
  if (end < 0) return;

  for (const line of data.subarray(0, end + 1).toString('utf8').split('\n')) {
    if (line.trim() === '') continue;

    try {
      acceptLine(JSON.parse(line) as unknown, bot);
    } catch (error) {
      const at = textModule.formatLocalTime(Date.now(), 'date');
      const failed = { line, reason: textModule.getErrorMessage(error), at };
      fs.appendFileSync(path.join(dir, 'replies.err.jsonl'), `${JSON.stringify(failed)}\n`, 'utf8');
    }
  }
  fs.writeFileSync(posFile, String(pos + end + 1));
}


/**
 * 校验并归一化 plugins.relay 的转话配置。
 */
export function parseRelayWrittenConfig(
  rawAppConfig: Record<string, unknown>,
  written: RelayWritten,
): RelayConfig {
  const positive = (value: unknown, fallback: number, key: string): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) throw new Error(`relay 的 ${key} 要写成正数`);
    return value;
  };
  const nonNegative = (value: unknown, fallback: number, key: string): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`relay 的 ${key} 要写成非负数（0 表示禁用）`);
    }
    return value;
  };
  const list = (value: unknown, fallback: string[], key: string): string[] => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) {
      throw new Error(`relay 的 ${key} 要写成字符串列表`);
    }
    return value as string[];
  };
  const str = (value: unknown, key: string): string => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error(`relay 的 ${key} 要写成字符串`);
    return value.trim();
  };

  if (!Array.isArray(written.helpers) || written.helpers.length === 0) {
    throw new Error('relay 要在 helpers 里写至少一个外部助手（每项 name、prefixes，可写 webhook_url、webhook_header）');
  }
  const helpers: Helper[] = [];
  for (const entry of written.helpers as unknown[]) {
    let one: Record<string, unknown> = {};
    if (typeof entry === 'object' && entry !== null) {
      one = entry as Record<string, unknown>;
    }
    const name = one['name'];
    if (
      typeof name !== 'string'
      || name.trim() === ''
      || name !== name.trim()
      || helpers.some((known) => known.name === name)
    ) {
      throw new Error('relay 的 helpers 每项要写无首尾空白的非空 name，且名字不能重复');
    }
    const prefixes = list(one['prefixes'], [], `${name} 的 prefixes`);
    if (prefixes.some((prefix) => prefix.trim() === '')) {
      throw new Error(`relay 里 ${name} 的 prefixes 不能有空串`);
    }
    const title = str(one['title'], `${name} 的 title`) || name;
    helpers.push({
      name,
      title,
      prefixes,
      webhookUrl: str(one['webhook_url'], `${name} 的 webhook_url`),
      webhookHeader: str(one['webhook_header'], `${name} 的 webhook_header`),
    });
  }

  for (const bot of botUtils.getBotConfigs(rawAppConfig)) {
    const mode = bot['relay'];
    if (mode !== undefined && mode !== 'direct' && mode !== 'model') {
      throw new Error(`机器人 ${bot.name} 的 relay 只能写 direct 或 model（按群分的写在 feishu 插件配置的 groups 里）`);
    }
  }

  const ownerP2pDirect = parseBotHelperRules(written.owner_p2p_direct, 'owner_p2p_direct', helpers);
  const exclusiveBots = parseBotHelperRules(written.exclusive_bots, 'exclusive_bots', helpers);
  const ownerGroupDirect = parseOwnerGroupDirect(written.owner_group_direct, helpers);

  return {
    remindMinutes: nonNegative(written.remind_minutes, 0, 'remind_minutes'),
    expireMinutes: nonNegative(written.expire_minutes, 0, 'expire_minutes'),
    pollSeconds: positive(written.poll_seconds, 2, 'poll_seconds'),
    helpers: helpers as [Helper, ...Helper[]],
    bots: list(written.bots, [], 'bots'),
    ownerP2pDirect,
    exclusiveBots,
    ownerGroupDirect,
  };
}


/**
 * 校验对象中的字符串字段为无首尾空白的非空文本。
 */
function checkTrimmedField(
  item: Record<string, unknown>,
  field: string,
  label: string,
  kindName: string,
): string {
  const fieldLabel = `${label}.${field}`;
  const value = checksModule.checkNonEmptyText(item[field], fieldLabel);
  if (value.trim() === '' || value !== value.trim()) {
    throw new Error(`${fieldLabel} 要写成无首尾空白的非空${kindName}`);
  }
  return value;
}


/**
 * 校验可选的 { bot, helper } 规则列表（owner_p2p_direct / exclusive_bots 共用）：
 * 须为数组，每项为对象，含无首尾空白的非空 bot 与 helper，bot 不可重复，helper 必须在 helpers 中登记。
 */
function parseBotHelperRules(
  raw: unknown,
  key: string,
  helpers: readonly Helper[],
): Array<OwnerP2pDirectRule & ExclusiveBotRule> {
  if (raw === undefined) return [];

  const entries = checksModule.checkArray(raw, `relay.${key}`);
  const rules: Array<OwnerP2pDirectRule & ExclusiveBotRule> = [];
  const seenBots = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const label = `relay.${key}[${String(index)}]`;
    const item = checksModule.checkRecord(entry, label);
    const bot = checkTrimmedField(item, 'bot', label, '机器人名字');
    const helper = checkTrimmedField(item, 'helper', label, '助手名字');

    //G bot 不能重复，避免同一机器人绑定冲突。
    if (seenBots.has(bot)) {
      throw new Error(`relay 的 ${key} 中 bot 不能重复：${bot}`);
    }
    //G helper 必须已在 helpers 中登记。
    if (!helpers.some((known) => known.name === helper)) {
      throw new Error(`relay 的 ${key} 中机器人 ${bot} 指定的 helper 不在 helpers 里：${helper}`);
    }

    seenBots.add(bot);
    rules.push({ bot, helper });
  }
  return rules;
}


/**
 * 校验可选的 owner_group_direct 配置：
 * 须为数组，每项为对象，含无首尾空白的非空 chat_id、bot、helper，(chat_id, bot) 不可重复，helper 必须在 helpers 中登记。
 */
function parseOwnerGroupDirect(raw: unknown, helpers: readonly Helper[]): OwnerGroupDirectRule[] {
  if (raw === undefined) return [];

  const entries = checksModule.checkArray(raw, 'relay.owner_group_direct');
  const rules: OwnerGroupDirectRule[] = [];
  const seenPairs = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const label = `relay.owner_group_direct[${String(index)}]`;
    const item = checksModule.checkRecord(entry, label);
    const chatId = checkTrimmedField(item, 'chat_id', label, '群号');
    const bot = checkTrimmedField(item, 'bot', label, '机器人名字');
    const helper = checkTrimmedField(item, 'helper', label, '助手名字');

    //G 同群同机器人组合不能重复。
    const pairKey = `${chatId}\u0000${bot}`;
    if (seenPairs.has(pairKey)) {
      throw new Error(`relay 的 owner_group_direct 中 (chat_id, bot) 组合不能重复：${chatId} / ${bot}`);
    }
    //G helper 必须已在 helpers 中登记。
    if (!helpers.some((known) => known.name === helper)) {
      throw new Error(`relay 的 owner_group_direct 中群 ${chatId} 机器人 ${bot} 指定的 helper 不在 helpers 里：${helper}`);
    }

    seenPairs.add(pairKey);
    rules.push({ chatId, bot, helper });
  }
  return rules;
}
