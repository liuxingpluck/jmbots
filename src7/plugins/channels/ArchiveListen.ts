/** 把渠道的五个事件（direct、mention、listen、replied、recall）写进聊天 Markdown，附件复制进聊天目录的 附件/。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import * as archiveModule from './Archive.ts';
import type * as messageModule from './Message.ts';
import type * as replyModule from './Reply.ts';


/** 聊天目录里放附件的文件夹名。 */
const ATTACHMENT_DIR = '附件';


/**
 * 挂上聊天归档：用户的话、机器人的话、撤回都写进同一聊天的 Markdown。
 * 写不进只打日志，不往外抛，别挡别人认领和收回执。
 * @param ctx 调用方插件的 ctx，监听随它卸载。
 * @param root 运行时根目录，聊天落在 root/chats/渠道/私聊或群聊/名字_ID。
 * @returns 归档对象。
 */
export function applyChatArchive(ctx: cordis.Context, root: string): archiveModule.ChatArchive {
  const archive = new archiveModule.ChatArchive(root);

  //M 用户的话：渠道先落盘再发；语音半句等整句再记。
  const onInbound = (message: messageModule.ChannelMessage): void => {
    if (message.routing.partial === true) return;

    try {
      const chat = getChat(message.channel, message.chatType, message.chatId, message.origin, message.sender.name);
      const directory = archive.getDirectory(chat);
      archive.record(chat, {
        key: `in:${message.messageId}`,
        at: message.createdAt,
        senderId: message.sender.id,
        senderName: message.sender.name ?? '',
        text: message.text,
        attachments: copyAttachments(directory, message.attachments),
      });
    } catch (error) {
      console.error(`channels：聊天归档记不下用户的话：${textModule.getErrorMessage(error)}`);
    }
  };
  ctx.on('channel/direct', onInbound, { prepend: true });
  ctx.on('channel/mention', onInbound, { prepend: true });
  ctx.on('channel/listen', onInbound, { prepend: true });

  //M 机器人的话：回执说发成了才记；没有来源快照的发话认不全聊天，先不记。
  ctx.on('channel/replied', (event) => {
    const status = event.receipt.status;
    if (status !== 'sent' && status !== 'partial') return;

    const request = event.request;
    const snapshot = request.sourceSnapshot;
    if (snapshot === undefined) return;

    try {
      const chat = getChat(snapshot.channel, snapshot.chatType, snapshot.chatId, snapshot.origin, snapshot.senderName);
      archive.record(chat, {
        key: `out:${request.replyRequestKey}`,
        at: event.receipt.at,
        senderId: request.bot,
        senderName: request.bot,
        text: getReplyText(request),
        attachments: [],
      });
    } catch (error) {
      console.error(`channels：聊天归档记不下机器人的回复：${textModule.getErrorMessage(error)}`);
    }
  });

  //M 撤回：原话已在文件里不改，另记一条撤回备注；这个聊天没归档过就不新建。
  ctx.on('channel/recall', (event) => {
    try {
      const chat = archive.findChat(event.channel, event.chatId);
      if (chat === undefined) return;

      archive.record(chat, {
        key: `recall:${event.messageId}`,
        at: event.recalledAt,
        senderId: event.recalledBy.id,
        senderName: event.recalledBy.kind,
        text: `【撤回】${event.messageId}\n${event.originalText}`,
        attachments: [],
      });
    } catch (error) {
      console.error(`channels：聊天归档记不下撤回：${textModule.getErrorMessage(error)}`);
    }
  });

  return archive;
}


/**
 * 聊天目录身份：群聊用地址里的群名，私聊、本机聊天用对面发话人的名字，都没有时目录只用 ID。
 * @param channel 渠道名。
 * @param chatType 聊天种类。
 * @param id 聊天稳定 ID。
 * @param origin 来源兼容地址，飞书把群名放在 chatName。
 * @param senderName 发话人昵称。
 */
function getChat(
  channel: string,
  chatType: messageModule.ChannelChatType,
  id: string,
  origin: messageModule.ChannelOrigin,
  senderName: string | undefined,
): archiveModule.ArchiveChat {
  const chatName = origin.address['chatName'];
  if (chatType === 'group' && typeof chatName === 'string') return { channel, chatType, id, name: chatName };

  return { channel, chatType, id, name: senderName ?? '' };
}


/** 机器人这条的文字片段连起来；只有附件时写附件号。 */
function getReplyText(request: replyModule.ChannelReplyRequest): string {
  const lines = request.parts.map((part) => {
    if (part.kind === 'text') return part.text ?? '';

    return `[附件 ${part.artifactId ?? part.partId}]`;
  });
  return lines.join('\n');
}


/**
 * 下载好的附件原件复制到聊天目录的 附件/，原件留在渠道目录。
 * @param directory 聊天目录。
 * @param attachments 消息带的附件。
 * @returns 相对聊天目录的路径；没下载下来的（正文里已有原因）跳过。
 */
function copyAttachments(directory: string, attachments: messageModule.ChannelAttachment[]): string[] {
  const paths: string[] = [];
  for (const attachment of attachments) {
    if (attachment.state !== 'available') {
      continue;
    }
    const name = path.basename(attachment.sourceRef);
    const folder = path.join(directory, ATTACHMENT_DIR);
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(attachment.sourceRef, path.join(folder, name));
    paths.push(`${ATTACHMENT_DIR}/${name}`);
  }
  return paths;
}
