/** 从聊天 Markdown 的实际归档目录解析附件相对运行时根的路径。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as archiveModule from '../channels/Archive.ts';
import type * as protocol from '../channels/index.ts';


/** 与 Markdown 归档共用的定位信息，不复制附件、不另建目录。 */
export interface IndexArchive {
  /** 运行时根目录。 */
  root: string;
  /** 已先执行归档监听的聊天归档。 */
  chats: archiveModule.ChatArchive;
}


/**
 * 只收录已归档成功的附件，不把下载源路径误记成 Markdown 路径。
 * @param message 渠道消息。
 * @param archive 正式运行时的 Markdown 归档，独立索引测试可不给。
 * @returns 相对运行时根的路径，统一使用正斜线。
 */
export function getAttachments(
  message: protocol.ChannelMessage, archive?: IndexArchive,
): string[] {
  if (archive === undefined || message.routing.partial === true) return [];
  if (!message.attachments?.some((item) => item.state === 'available')) return [];

  //M 按稳定聊天身份沿用已归档目录，改昵称后也不推测新路径。
  const chat = archive.chats.findChat(message.channel, message.accountId, message.chatId);
  if (chat === undefined) return [];

  //M 归档监听已经创建目录并复制附件，这里只确认目标文件存在。
  const directory = archive.chats.getDirectory(chat);
  const paths: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.state !== 'available') continue;

    const name = path.basename(attachment.sourceRef);
    const target = path.join(directory, '附件', name);
    if (!fs.existsSync(target)) continue;

    const relative = path.relative(archive.root, target);
    paths.push(relative.split(path.sep).join('/'));
  }
  return paths;
}
