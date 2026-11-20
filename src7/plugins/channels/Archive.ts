/** 按聊天写 Markdown 往来，负责目录定位、去重和每 200 条分卷。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as filesModule from '../../utils/Files.ts';
import * as namesModule from '../../utils/Names.ts';
import type * as messages from './Message.ts';


/** 聊天目录的身份和首次创建时的展示名。 */
export interface ArchiveChat {
  /** 渠道名，区分各平台的聊天 ID。 */
  channel: string;
  /** 群聊和私聊分开存，本机渠道归私聊。 */
  chatType: messages.ChannelChatType;
  /** 机器人（账号）名：飞书 appId、本机渠道 'local'，和 feishu/ChatLog.ts 的账号目录同一个。 */
  accountId: string;
  /** 机器人（账号）的展示名，有就把账号目录叫“名字_ID”；回复、撤回没带，沿用已建好的目录。 */
  accountName?: string;
  /** 平台聊天的稳定 ID。 */
  id: string;
  /** 当前的聊天名称，已有目录时沿用其路径。 */
  name: string;
}


/** 一条待归档的收件、发件或撤回备注。 */
export interface ArchiveEntry {
  /** 此聊天内的稳定记录键，收件用平台消息号，回执与撤回用各自键。 */
  key: string;
  /** 此条消息或撤回发生的毫秒时间戳。 */
  at: number;
  /** 发话人或撤回人的平台 ID。 */
  senderId: string;
  /** 当时的昵称，取不到时可留空。 */
  senderName: string;
  /** 可读的原话，多行原样写入。 */
  text: string;
  /** 相对聊天目录的附件路径。 */
  attachments: readonly string[];
}


/** 一天里目前最后一卷的编号及条数。 */
interface ArchivePage {
  /** 从 1 开始的编号。 */
  number: number;
  /** 已写入这卷的消息数。 */
  count: number;
}


/** 从该聊天的 Markdown 卷恢复出来的写入位置。 */
interface ArchiveState {
  /** 此聊天所有已经落盘的记录键，编码后可安全写进 Markdown 注释。 */
  keys: Set<string>;
  /** 日期到当天最后一卷的定位。 */
  days: Map<string, ArchivePage>;
}


/** 与目录名分开存原始 ID，改昵称时仍能定位原目录。 */
const CHAT_ID_FILE = '.chat-id';
/** 隐藏头部的前缀，后面跟记录键和正文长度。 */
const ENTRY_PREFIX = 'jmbots-entry';
/** 一卷的最大消息数。 */
const PAGE_SIZE = 200;
/** 模块生成的卷名，日期按系统时区取，卷号从 001 开始。 */
const PAGE_NAME = /^(\d{8})_(\d{3,})\.md$/u;


/** 把归档记录写进运行时的 channels 目录，不读取渠道 JSONL 或记忆库。 */
export class ChatArchive {
  /** 此进程已定位的聊天目录。 */
  private readonly directories = new Map<string, string>();
  /** 按目录记住已核对的写入位置，免得每条都扫所有卷。 */
  private readonly states = new Map<string, ArchiveState>();
  /** 渠道和账号 ID 对应的账号目录名，收到带名字的消息时记下。 */
  private readonly accounts = new Map<string, string>();

  /** @param root 运行时根目录。 */
  constructor(private readonly root: string) {}

  /**
   * 定位或创建聊天目录。附件和 Markdown 用同一路径。
   * @param chat 稳定聊天号和当前显示名。
   * @returns 当前聊天的绝对目录。
   */
  getDirectory(chat: ArchiveChat): string {
    //M 群聊和私聊各用一个目录，语音、网页等本机聊天也有自己的渠道。
    let kind = '私聊';
    if (chat.chatType === 'group') {
      kind = '群聊';
    }
    const channel = namesModule.getSafeName(chat.channel);
    const account = this.getAccountDirectory(chat.channel, chat.accountId, chat.accountName);
    const parent = path.join(this.root, 'channels', channel, account, kind);
    const key = JSON.stringify([parent, chat.id]);
    const cached = this.directories.get(key);
    if (cached !== undefined) return cached;

    //M 别名可能改变；先按目录中的原始 ID 找已有路径。
    const id = namesModule.getSafeName(chat.id, 80);
    filesModule.ensureDir(parent);
    const existing = this.findDirectory(parent, id, chat.id);
    if (existing !== undefined) {
      this.directories.set(key, existing);
      return existing;
    }

    //G 清理后的文件名偶尔相同，保留原目录，另建同名编号。
    const name = namesModule.getSafeName(chat.name || chat.id);
    let directory = path.join(parent, `${name}_${id}`);
    for (let serial = 2; fs.existsSync(directory); serial += 1) {
      directory = path.join(parent, `${name}-${String(serial)}_${id}`);
    }
    const identity = path.join(directory, CHAT_ID_FILE);
    //M 原始 ID 随目录持久化，重启后按它找到同一聊天。
    filesModule.writeTextAtomic(identity, chat.id);
    this.directories.set(key, directory);
    return directory;
  }

  /**
   * 账号目录名：有名字是“名字_ID”，没有是 ID。回复、撤回不带名字，先用收消息时记下的，
   * 重启后没记下就在渠道目录里找已有的“名字_ID”，都没有才用 ID。
   * @param channel 渠道名。
   * @param accountId 平台账号 ID。
   * @param accountName 账号展示名，可没有。
   * @returns 渠道目录下的账号目录名。
   */
  private getAccountDirectory(channel: string, accountId: string, accountName?: string): string {
    const safeId = namesModule.getSafeName(accountId, Infinity);
    const key = JSON.stringify([channel, accountId]);
    if (accountName !== undefined) {
      const named = `${namesModule.getSafeName(accountName, Infinity)}_${safeId}`;
      this.accounts.set(key, named);
      return named;
    }

    const known = this.accounts.get(key);
    if (known !== undefined) return known;

    const channelDir = path.join(this.root, 'channels', namesModule.getSafeName(channel));
    if (!fs.existsSync(channelDir)) return safeId;

    const found = fs.readdirSync(channelDir).find((name) => name.endsWith(`_${safeId}`));
    return found ?? safeId;
  }

  /**
   * 按聊天号找已有目录所属的聊天（撤回事件不带聊天种类），不新建目录。
   * @param channel 渠道名。
   * @param accountId 机器人（账号）名。
   * @param id 平台聊天稳定 ID。
   * @returns 群聊或私聊里先找到的那个；都没有是 undefined。
   */
  findChat(channel: string, accountId: string, id: string): ArchiveChat | undefined {
    const safeId = namesModule.getSafeName(id, 80);
    for (const chatType of ['group', 'p2p'] as const) {
      const kind = chatType === 'group' ? '群聊' : '私聊';
      const parent = path.join(this.root, 'channels', namesModule.getSafeName(channel), this.getAccountDirectory(channel, accountId), kind);
      if (!fs.existsSync(parent)) {
        continue;
      }
      if (this.findDirectory(parent, safeId, id) !== undefined) return { channel, accountId, chatType, id, name: id };
    }
    return undefined;
  }

  /**
   * 将一条记录写进对应日期最后一卷。成功替换文件后才更新进程内索引。
   * @param chat 该消息的聊天目录身份。
   * @param entry 已准备好的归档记录。
   * @returns 新记录写入为 true，重放时为 false。
   */
  record(chat: ArchiveChat, entry: ArchiveEntry): boolean {
    //M 先从已有卷恢复键，再按平台消息号（或回执键）处理重放。
    const directory = this.getDirectory(chat);
    const state = this.getState(directory);
    const key = Buffer.from(entry.key, 'utf8').toString('base64url');
    if (state.keys.has(key)) return false;

    //M 日期和行头时刻共用系统时区（如 2026-11-20 00:52:02 EST），满 200 条后用新卷顺延。
    const { day, time } = formatLocalTime(entry.at);
    let page = state.days.get(day) ?? { number: 1, count: 0 };
    if (page.count >= PAGE_SIZE) {
      page = { number: page.number + 1, count: 0 };
    }
    const number = String(page.number).padStart(3, '0');
    const file = path.join(directory, `${day}_${number}.md`);

    //M 原话保留所有换行。注释里的长度让原话中的 Markdown 或相同注释不影响重新计数。
    const content = formatEntry(entry, time);
    const marker = `<!-- ${ENTRY_PREFIX}:${key}:${String(content.length)} -->\n`;
    let previous = '';
    if (page.count > 0) {
      previous = fs.readFileSync(file, 'utf8');
    }
    const text = previous + marker + content;
    filesModule.writeTextAtomic(file, text);

    //M 原子替换成功后才记住本条，失败重试不会误判成已写入。
    state.days.set(day, { number: page.number, count: page.count + 1 });
    state.keys.add(key);
    return true;
  }

  /** 在已有目录里按原始聊天号查找，文件名只用来缩小范围。 */
  private findDirectory(parent: string, safeId: string, id: string): string | undefined {
    const dirs = fs.readdirSync(parent, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory() || !dir.name.endsWith(`_${safeId}`)) {
        continue;
      }
      const identity = path.join(parent, dir.name, CHAT_ID_FILE);
      if (!fs.existsSync(identity)) {
        continue;
      }
      const saved = fs.readFileSync(identity, 'utf8');
      if (saved === id) return path.join(parent, dir.name);
    }
    return undefined;
  }

  /** 首次打开聊天时重读 Markdown 中的记录键，保证检查跨进程重启。 */
  private getState(directory: string): ArchiveState {
    const cached = this.states.get(directory);
    if (cached !== undefined) return cached;

    const state: ArchiveState = { keys: new Set(), days: new Map() };
    const files = fs.readdirSync(directory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) {
        continue;
      }
      const match = PAGE_NAME.exec(file.name);
      if (match === null) {
        continue;
      }
      const day = match[1]!;
      const number = Number(match[2]);
      const full = path.join(directory, file.name);
      //M 收集每卷记录键，新消息写到同日编号最大的一卷。
      const text = fs.readFileSync(full, 'utf8');
      const count = readEntryKeys(text, state.keys);
      const current = state.days.get(day);
      if (current === undefined || current.number < number) {
        state.days.set(day, { number, count });
      }
    }
    this.states.set(directory, state);
    return state;
  }
}


/** 按系统时区拆出文件名用的日期（20261120）和行头用的时刻（2026-11-20 00:52:02 EST）。 */
function formatLocalTime(at: number): { day: string; time: string } {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  };
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)!.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return {
    day: day.replaceAll('-', ''),
    time: `${day} ${get('hour')}:${get('minute')}:${get('second')} ${get('timeZoneName')}`,
  };
}


/** 读隐藏头部后跳过对应长度的原话，返回这卷真实记录数。 */
function readEntryKeys(text: string, keys: Set<string>): number {
  const marker = /<!-- jmbots-entry:([\w-]+):(\d+) -->\n/uy;
  let offset = 0;
  let count = 0;
  while (offset < text.length) {
    marker.lastIndex = offset;
    const found = marker.exec(text);
    if (found === null) throw new Error('聊天归档的记录边界损坏');

    const end = marker.lastIndex + Number(found[2]);
    if (end > text.length) throw new Error('聊天归档的末条记录不完整');

    //M 跳过整段消息，原话中粘贴的注释不算新的记录头。
    keys.add(found[1]!);
    offset = end;
    count += 1;
  }
  return count;
}


/** 拼显示行、原话和附件列表，发送者身份字段只占一行。 */
function formatEntry(entry: ArchiveEntry, time: string): string {
  const senderId = entry.senderId.replace(/[\r\n]+/gu, ' ');
  const senderName = entry.senderName.replace(/[\r\n]+/gu, ' ');
  const heading = `**${senderId} · ${senderName} · ${time}**`;
  if (entry.attachments.length === 0) return `${heading}\n\n${entry.text}\n\n`;

  const attachments = entry.attachments.map((file) => `- ${file}`).join('\n');
  return `${heading}\n\n${entry.text}\n\n${attachments}\n\n`;
}
