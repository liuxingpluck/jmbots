/**
 * 命令行历史响应器：监听标准事件 channel/history，读取运行时目录下 channels/cli/*.jsonl 原件，
 * 按统一分页与游标协议回传 channel/history-result（供 Cli 插件挂载）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as utils from '../../utils/index.ts';
import * as protocol from '../../Channels.ts';


/** channels/cli/*.jsonl 单行原始记录结构。 */
interface CliRawEntry {
  /** 渠道名称。 */
  channel?: unknown;
  /** 目标机器人名称。 */
  bot?: unknown;
  /** 用户输入的命令行正文。 */
  text?: unknown;
  /** 记录毫秒时间戳。 */
  time?: unknown;
  /** 回话地址对象（包含 customer 标识）。 */
  address?: unknown;
}


/** 命令行历史查询处理器：供 Cli 插件在构造阶段挂载。 */
export class CliHistory {
  /** 渠道名称。 */
  readonly name = 'cli';

  /**
   * 登记 channel/history 事件监听。
   * @param ctx Cli 插件的 Cordis 上下文（随插件卸载自动注销监听）。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 响应渠道历史查询事件，仅处理 channel 为 cli 的请求。
    this.ctx.on('channel/history', (request) => this.onChannelHistory(request));
  }

  /**
   * 处理命令行历史查询请求：校验权限与游标后读取 channels/cli/*.jsonl 分页返回。
   * @param request 渠道历史查询请求。
   */
  private onChannelHistory(request: protocol.ChannelHistoryRequest): void {
    if (request.channel !== this.name) return;

    request.handled = true;
    const emitResult = (result: protocol.ChannelHistoryResult): void => {
      this.ctx.emit('channel/history-result', { ...result, requestId: request.requestId });
    };

    //M 把命令行聊天别名归一，供权限判断和记录筛选共用。
    const snapshot = request.sourceSnapshot;
    const targetChatId = this.resolveChatId(request.chatId);

    //G 二次核对权限：外人不能越过当前命令行聊天，本人允许跨渠道查询本机命令行记录。
    const isOwner = protocol.isHistoryOwner(snapshot);
    const isSameChat = snapshot.channel === this.name && targetChatId === snapshot.chatId;
    if (!isOwner && !isSameChat) {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'forbidden', message: `无权访问命令行聊天 ${targetChatId}` },
      });
      return;
    }

    //G 命令行渠道不支持平台 @ 提及过滤，明确返回 identity_unresolved。
    if (request.mode === 'mentions') {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: `${this.name}:local:${targetChatId}`,
        completeness: 'local_only',
        error: { code: 'identity_unresolved', message: '命令行渠道没有平台 @ 提及标识' },
      });
      return;
    }

    //M 读取目标聊天的记录，按照统一游标分页并发回查询结果。
    const entries = this.readEntries(targetChatId, snapshot.botName);
    const result = protocol.paginateChannelHistory({
      request,
      channel: this.name,
      accountId: 'local',
      chatId: targetChatId,
      entries,
    });

    //M 分页结果带回原请求号，供发起方对应到这次查询。
    emitResult(result);
  }

  /**
   * 规范化目标命令行聊天标识：缺省或别名 local / cli 统一归为 cli:本机。
   * @param requestedChatId 请求中传入的可选聊天标识。
   * @returns 目标聊天标识。
   */
  private resolveChatId(requestedChatId?: string): string {
    if (requestedChatId === undefined) return 'cli:本机';

    const trimmed = requestedChatId.trim();
    if (trimmed === '' || trimmed === 'local' || trimmed === 'cli') return 'cli:本机';

    return trimmed;
  }

  /**
   * 扫描并读取 channels/cli/*.jsonl 中匹配的命令行历史记录。
   * @param targetChatId 目标聊天标识（通常为 cli:本机）。
   * @param botName 当前机器人名称。
   * @returns 标准历史摘要项列表。
   */
  private readEntries(targetChatId: string, botName: string): protocol.ChannelHistoryItem[] {
    const cliDir = path.join(this.ctx.resources.root, 'channels', this.name);
    if (!fs.existsSync(cliDir)) return [];

    const files = fs.readdirSync(cliDir)
      .filter((fileName) => fileName.endsWith('.jsonl'))
      .sort();

    const entries: protocol.ChannelHistoryItem[] = [];
    for (const fileName of files) {
      const fullPath = path.join(cliDir, fileName);
      const rawContent = fs.readFileSync(fullPath, 'utf8');
      const lines = rawContent.split('\n');

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const rawLine = lines[lineIndex] ?? '';
        if (rawLine.trim() === '') continue;

        let parsed: CliRawEntry;
        try {
          parsed = JSON.parse(rawLine) as CliRawEntry;
        } catch {
          continue;
        }

        if (typeof parsed.text !== 'string' || typeof parsed.time !== 'number') continue;
        if (typeof parsed.bot === 'string' && parsed.bot !== '' && botName !== '' && parsed.bot !== botName) continue;

        //G 按本机聊天标识筛选原件，兼容旧记录缺少来源的情况。
        const customer = utils.getStringField(parsed.address, 'customer') || 'cli:本机';
        if (customer !== targetChatId) continue;

        //M 用原件文件名和行号生成历史项标识，保证翻页时可重复定位。
        const nativeId = `${fileName}:${String(lineIndex + 1)}`;
        const messageId = protocol.makeChannelMessageId(this.name, 'local', nativeId);

        entries.push({
          messageId,
          nativeId,
          direction: 'user',
          createdAt: parsed.time,
          sender: { id: customer, name: '本机' },
          text: parsed.text,
          mentions: [],
          attachments: [],
        });
      }
    }
    return entries;
  }
}
