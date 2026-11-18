/**
 * 网页历史响应器：监听标准事件 channel/history，读取运行时库 web_messages 中的网页收发记录（用户入站与 replies 回话），
 * 对正文中的本机附件绝对路径做脱敏与元数据提取后，按统一分页与游标协议回传 channel/history-result（供 WebApi 插件挂载）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { Database } from 'bun:sqlite';
import * as mimeModule from '../../utils/Mime.ts';
import * as protocol from '../../Channels.ts';


/** web_messages 表查询行结构。 */
interface WebMessageRow {
  /** 消息自增编号。 */
  id: number;
  /** 所属机器人名。 */
  bot: string;
  /** 来源标记（通常为 web 或 http）。 */
  source: string;
  /** 用户发言正文（可能含 @绝对路径 附件标记）。 */
  text: string;
  /** 回复清单 JSON 字符串。 */
  replies: string;
  /** 用户消息收到毫秒时刻。 */
  created_at: number;
  /** 最近更新时间毫秒时刻。 */
  updated_at: number;
}


/** web_messages.replies JSON 单项结构。 */
interface StoredWebReply {
  /** 回复追加毫秒时刻。 */
  at?: unknown;
  /** 回复正文（可能含 @绝对路径 附件标记）。 */
  text?: unknown;
}


/** 提取脱敏附件后的正文与元数据结果。 */
interface SanitizedContent {
  /** 剥离纯 @绝对路径 后的安全展示文本。 */
  text: string;
  /** 脱敏后的附件元数据列表（不含本机路径）。 */
  attachments: protocol.ChannelHistoryItem['attachments'];
}


/** 识别消息文本中的 @绝对路径（带引号或不带引号）正则，与 Timeline.ts 保持一致。 */
const ABS_ATTACHMENT_PATTERN = /@"([^"]+)"|@([^\s，。、；：！？（）【】《》「」"'<>|]+)/gu;


/**
 * 从网页消息正文或回复正文中提取 @绝对路径 并转换为脱敏附件元数据，同时从展示文本中剥离本机路径。
 * @param rawText 原始文本。
 * @param idPrefix 附件 ID 前缀（如消息号或回复号）。
 * @returns 脱敏文本与附件元数据数组。
 */
function sanitizeWebText(rawText: string, idPrefix: string): SanitizedContent {
  const absFiles: string[] = [];
  const cleanedLines: string[] = [];

  //M 先提取绝对路径生成附件元数据，同时把正文中对应片段移除以免暴露本机路径。
  const stripped = rawText.replace(ABS_ATTACHMENT_PATTERN, (fullMatch, quoted: string | undefined, bare: string | undefined) => {
    const candidate = quoted ?? (bare ?? '').replace(/[.,;!?)\]>`]+$/u, '');
    if (!/^([A-Za-z]:[\\/]|\/)/u.test(candidate)) return fullMatch;

    if (!absFiles.includes(candidate)) {
      absFiles.push(candidate);
    }
    return '';
  });

  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      cleanedLines.push(trimmed);
    }
  }

  const attachments: protocol.ChannelHistoryItem['attachments'] = [];
  for (let index = 0; index < absFiles.length; index += 1) {
    const filePath = absFiles[index] ?? '';
    //M 取得附件的展示名称和类型，供历史结果渲染文件元数据。
    const fileName = path.basename(filePath.replace(/\\/gu, '/')) || '未命名';
    const mime = mimeModule.getType(filePath);
    let state: 'available' | 'unavailable' = 'unavailable';
    let size: number | undefined;
    try {
      const stat = fs.statSync(filePath);
      state = 'available';
      size = stat.size;
    } catch {
      state = 'unavailable';
    }

    const meta: protocol.ChannelHistoryItem['attachments'][number] = {
      id: `${idPrefix}:att:${String(index + 1)}`,
      name: fileName,
      mime,
      state,
    };
    if (size !== undefined) {
      meta.size = size;
    }
    attachments.push(meta);
  }

  let finalText = cleanedLines.join('\n');
  if (finalText === '' && attachments.length > 0) {
    finalText = '[附件]';
  }
  return { text: finalText, attachments };
}


/** 网页历史查询处理器：供 WebApi 插件在构造阶段挂载。 */
export class WebHistory {
  /** 渠道名称（与 WebApi.name 一致，固定为 http）。 */
  readonly name = 'http';

  /**
   * 登记 channel/history 事件监听。
   * @param ctx WebApi 插件的 Cordis 上下文（随插件卸载自动注销监听）。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 响应渠道历史查询事件，仅处理 channel 为 http 的请求。
    this.ctx.on('channel/history', (request) => this.onChannelHistory(request));
  }

  /**
   * 处理网页历史查询请求：校验权限与游标后从 web_messages 读取用户消息与回复并分页返回。
   * @param request 渠道历史查询请求。
   */
  private onChannelHistory(request: protocol.ChannelHistoryRequest): void {
    if (request.channel !== this.name) return;

    request.handled = true;
    const emitResult = (result: protocol.ChannelHistoryResult): void => {
      this.ctx.emit('channel/history-result', { ...result, requestId: request.requestId });
    };

    //M 解析请求指向的聊天与机器人，供权限判断和历史查询使用。
    const snapshot = request.sourceSnapshot;
    const target = this.resolveTarget(snapshot, request.chatId);

    //G 二次核对访问权限：外人只能看当前网页聊天，本人可跨渠道、跨聊天查询网页历史。
    const isOwner = protocol.isHistoryOwner(snapshot);
    const isSameChat = snapshot.channel === this.name && target.chatId === snapshot.chatId;
    if (!isOwner && !isSameChat) {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'forbidden', message: `无权访问网页聊天 ${target.chatId}` },
      });
      return;
    }

    //G 网页渠道不支持平台 @ 提及清单，明确返回 identity_unresolved。
    if (request.mode === 'mentions') {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: `${this.name}:local:${target.chatId}`,
        completeness: 'local_only',
        error: { code: 'identity_unresolved', message: '网页渠道没有平台 @ 提及标识' },
      });
      return;
    }

    //M 从目标聊天读取历史，按统一游标分页后回传查询结果。
    const entries = this.readEntries(this.ctx.resources.db, target.bot, target.chatId);
    const result = protocol.paginateChannelHistory({
      request,
      channel: this.name,
      accountId: 'local',
      chatId: target.chatId,
      entries,
    });

    //M 带上原请求号返回分页结果，供发起方对应到本次查询。
    emitResult(result);
  }

  /**
   * 解析目标网页聊天标识与所属机器人名称（兼容缺省、web / http / local 别名与 http:<机器人名>）。
   * @param snapshot 当前来源快照。
   * @param requestedChatId 请求中传入的可选聊天标识。
   * @returns 目标聊天标识与机器人名。
   */
  private resolveTarget(
    snapshot: protocol.SourceSnapshot,
    requestedChatId?: string,
  ): { chatId: string; bot: string } {
    let targetChatId = 'http:本机';
    let targetBot = snapshot.botName;

    if (requestedChatId !== undefined && requestedChatId.trim() !== '') {
      const raw = requestedChatId.trim();
      if (raw !== 'http:本机' && raw !== 'local' && raw !== 'web' && raw !== 'http') {
        targetChatId = raw;
        if (raw.startsWith('http:')) {
          const maybeBot = raw.slice(5);
          //G 只有已注册的机器人才能通过聊天标识切换查询目标。
          if (maybeBot !== '' && this.ctx.bots.get(maybeBot) !== undefined) {
            targetBot = maybeBot;
          }
        }
      }
    }

    return { chatId: targetChatId, bot: targetBot };
  }

  /**
   * 从 web_messages 表读取指定机器人的网页消息及 replies，展开为标准入站/出站历史项列表。
   * @param db 运行时 SQLite 数据库实例。
   * @param bot 机器人名称。
   * @param chatId 目标聊天标识。
   * @returns 标准历史摘要项数组。
   */
  private readEntries(db: Database, bot: string, chatId: string): protocol.ChannelHistoryItem[] {
    if (chatId !== 'http:本机' && chatId !== `http:${bot}`) return [];

    //G 历史表尚未初始化时直接交回空历史。
    const hasTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'web_messages'").get();
    if (hasTable === null || hasTable === undefined) return [];

    //M 取出目标机器人的网页消息及其回复，为展开历史项准备原件。
    const rows = db.query(
      "SELECT id, bot, source, text, replies, created_at, updated_at FROM web_messages WHERE channel = 'http' AND bot = ? ORDER BY id ASC",
    ).all(bot) as WebMessageRow[];

    const entries: protocol.ChannelHistoryItem[] = [];
    for (const row of rows) {
      //M 以收件编号生成入站历史标识，并将附件路径从展示正文中移除。
      const userNativeId = String(row.id);
      const userMessageId = protocol.makeChannelMessageId(this.name, 'local', userNativeId);
      const userContent = sanitizeWebText(row.text, userNativeId);

      //M 网页入站 sender：默认网页本地入口标为 http:本机 / 网页，其余来源保留 source 名称。
      let senderId = 'http:本机';
      let senderName = '网页';
      if (row.source !== 'web' && row.source !== 'http' && row.source !== '') {
        senderId = row.source;
        senderName = row.source;
      }

      entries.push({
        messageId: userMessageId,
        nativeId: userNativeId,
        direction: 'user',
        createdAt: row.created_at,
        sender: { id: senderId, name: senderName },
        text: userContent.text,
        mentions: [],
        attachments: userContent.attachments,
      });

      //M 将该条网页消息的 replies 数组按顺序展开为出站机器人历史项。
      let parsedReplies: StoredWebReply[] = [];
      try {
        const rawReplies = JSON.parse(row.replies) as unknown;
        if (Array.isArray(rawReplies)) {
          parsedReplies = rawReplies as StoredWebReply[];
        }
      } catch {
        parsedReplies = [];
      }

      for (let replyIndex = 0; replyIndex < parsedReplies.length; replyIndex += 1) {
        const replyItem = parsedReplies[replyIndex];
        if (replyItem === undefined || typeof replyItem.text !== 'string' || replyItem.text === '') continue;

        //M 将回复下标编入历史标识，并整理回话正文与附件元数据。
        const replyNativeId = `${userNativeId}:reply:${String(replyIndex)}`;
        const replyMessageId = protocol.makeChannelMessageId(this.name, 'local', replyNativeId);
        const replyContent = sanitizeWebText(replyItem.text, replyNativeId);
        let replyAt = row.updated_at;
        if (typeof replyItem.at === 'number' && Number.isFinite(replyItem.at)) {
          replyAt = Math.max(row.created_at, replyItem.at);
        }

        entries.push({
          messageId: replyMessageId,
          nativeId: replyNativeId,
          direction: 'bot',
          createdAt: replyAt,
          sender: { id: row.bot, name: row.bot },
          text: replyContent.text,
          mentions: [],
          attachments: replyContent.attachments,
        });
      }
    }
    return entries;
  }
}
