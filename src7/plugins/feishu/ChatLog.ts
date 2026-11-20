/** 飞书聊天日志，供收发记录、回复目标定位和撤回身份核验。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as namesModule from '../../utils/Names.ts';
import * as protocol from '../channels/index.ts';


/** 飞书聊天本地原始日志的一行（存于 channels/feishu/chats/<appId>/<chatId>.jsonl）。 */
export interface FeishuChatLogEntry {
  /** 标准消息 ID。 */
  messageId: string;
  /** 飞书原始消息 ID。 */
  nativeId: string | null;
  /** 所属应用 ID。 */
  appId: string;
  /** 聊天 ID。 */
  chatId: string;
  /** 方向：user 入站 / bot 出站。 */
  direction: 'user' | 'bot';
  /** UTC 毫秒时间戳。 */
  createdAt: number;
  /** 发送者信息。 */
  sender: { id: string; name?: string };
  /** 展示文本。 */
  text: string;
  /** @ 提及清单。 */
  mentions: protocol.ChannelMention[];
  /** 附件元数据（含脱敏字段）。 */
  attachments: Array<{ id: string; name: string; mime?: string; size?: number; state: 'available' | 'unavailable' }>;
}


export class FeishuChatLog {
  constructor(private readonly ctx: cordis.Context) {}

  /**
   * 能用的应用里，第一个本地存着这个聊天日志的（只看文件在不在，不新建目录）。
   * 跨聊天发话认目标（Reply.ts）时调。
   * @param candidateApps 能用的应用号，按先后。
   * @param chatId 聊天号。
   * @returns 应用号；都没有是 undefined。
   */
  getAppWithLog(candidateApps: string[], chatId: string): string | undefined {
    for (const candidateApp of candidateApps) {
      //M 用写聊天日志时的命名规则找文件，查询时只看已有的文件。
      const accountName = namesModule.getSafeName(candidateApp, Infinity);
      const chatName = namesModule.getSafeName(chatId, Infinity);
      const logName = `${chatName}.jsonl`;
      const logFile = path.join(this.ctx.resources.root, 'channels', 'feishu', 'chats', accountName, logName);
      if (fs.existsSync(logFile)) return candidateApp;
    }
    return undefined;
  }

  /** 飞书聊天本地日志文件（channels/feishu/chats/<app>/<chat>.jsonl）。 */
  private chatLogFile(appId: string, chatId: string): string {
    //M 将 appId 安全转义为目录名，生成对应的聊天历史文件夹并拼出聊天日志文件。
    const dir = this.ctx.resources.ensureRuntimeDir('channels', 'feishu', 'chats', namesModule.getSafeName(appId, Infinity));
    return path.join(dir, `${namesModule.getSafeName(chatId, Infinity)}.jsonl`);
  }

  /**
   * 追加写入一条聊天原始记录（同 messageId 去重，防重启或重放双写）。
   * 收消息、回话、主动发件发出去以后调。
   */
  appendChatLog(appId: string, chatId: string, entry: FeishuChatLogEntry): void {
    //M 定位日志文件并扫现有记录，同一 messageId 已存在则跳过，防重放双写。
    const file = this.chatLogFile(appId, chatId);
    const existing = this.readChatLog(appId, chatId);
    if (existing.some((item) => item.messageId === entry.messageId)) return;

    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 读取某个聊天的全部已保存原始消息。撤回时认原发信人用。 */
  readChatLog(appId: string, chatId: string): FeishuChatLogEntry[] {
    //M 按应用号和聊天 ID 解析 jsonl 路径，不存在即视为空历史。
    const file = this.chatLogFile(appId, chatId);
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const items: FeishuChatLogEntry[] = [];
    for (const line of lines) {
      try {
        //M 单条日志解析成功就加入历史，损坏的行由下面的 catch 跳过。
        const entry = JSON.parse(line) as FeishuChatLogEntry;
        items.push(entry);
      } catch {
        continue;
      }
    }
    return items;
  }
}
