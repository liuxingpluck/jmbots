/**
 * 飞书聊天历史：每个聊天的原始记录落盘到 channels/feishu/chats/<应用>/<聊天>.jsonl（收的、发的都记），
 * 响应标准事件 channel/history，在授权范围内把落盘的记录分页交回（游标、分页用骨架的 paginateChannelHistory）。
 * 收消息（Inbound.ts）、回话（Reply.ts）、撤回都从这里读写聊天日志。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as namesModule from '../../utils/Names.ts';
import * as protocol from '../../Channels.ts';
import type { Feishu } from './index.ts';


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


/** 飞书聊天历史：Feishu 构造时建一个，挂在 feishu.history 上。 */
export class FeishuHistory {
  /** 渠道名。 */
  readonly name = 'feishu';

  /**
   * 登记 channel/history 监听。构造时不碰运行时目录（目录在第一次读写时才建）。
   * @param ctx 飞书插件的 Cordis 上下文（随插件卸载自动注销监听）。
   * @param feishu 飞书渠道：查应用、机器人绑定的应用、最近私聊的人。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly feishu: Feishu,
  ) {
    //M 统一渠道历史入口（接口 A）：监听 channel/history，在授权范围内返回已落盘记录。
    this.ctx.on('channel/history', (request) => this.onChannelHistory(request));
  }

  /**
   * 响应 channel/history（接口 A）：在当前账号/聊天与授权交集内返回已落盘记录。
   * 这里只认应用和聊天、挑 @我 的条目；mentions 缺 botOpenId 时报错 identity_unresolved（不把 @任何人 当 @自己）。
   * 游标、分页交给骨架的 paginateChannelHistory。
   * @param request 历史查询请求。
   */
  private onChannelHistory(request: protocol.ChannelHistoryRequest): void {
    if (request.channel !== this.name) return;

    request.handled = true;
    const emitResult = (result: protocol.ChannelHistoryResult): void => {
      this.ctx.emit('channel/history-result', { ...result, requestId: request.requestId });
    };

    //M 按统一协议判断当前发起者是否为拥有跨聊天查询权限的 owner 账号。
    const snapshot = request.sourceSnapshot;
    const isOwner = protocol.isHistoryOwner(snapshot);
    let rawChat = '';
    if (request.chatId !== undefined && request.chatId.trim() !== '') {
      rawChat = request.chatId.trim();
    }
    if (rawChat === '' && snapshot.channel === this.name) {
      rawChat = snapshot.chatId;
    }

    //G 再核聊天范围权限：guest / builder 仅当前飞书聊天，owner 可跨渠道、跨聊天查询任意飞书应用聊天。
    const isSameChat = snapshot.channel === this.name && rawChat !== '' && rawChat === snapshot.chatId;
    if (!isOwner && !isSameChat) {
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'forbidden', message: `无权访问聊天 ${rawChat}` },
      });
      return;
    }

    //M 解析目标应用号与聊天 ID：支持传入 appId:chatId，跨渠道时优先挑选存在聊天记录的机器人应用。
    let appId = '';
    let targetChatId = rawChat;
    if (rawChat.includes(':')) {
      const sep = rawChat.indexOf(':');
      const maybeApp = rawChat.slice(0, sep);
      const maybeChat = rawChat.slice(sep + 1);
      if (this.feishu.apps.has(maybeApp) && maybeChat !== '') {
        appId = maybeApp;
        targetChatId = maybeChat;
      }
    }
    if (appId === '' && snapshot.channel === this.name && this.feishu.apps.has(snapshot.accountId)) {
      appId = snapshot.accountId;
    }
    if (appId === '') {
      //M 查该机器人配置的全部飞书应用列表作为备选，没有则兜底枚举所有已配置飞书应用。
      let candidates = this.feishu.getApps(snapshot.botName);
      if (candidates.length === 0) {
        candidates = [...this.feishu.apps.keys()];
      }
      if (targetChatId !== '') {
        appId = this.getAppWithLog(candidates, targetChatId) ?? '';
      }
      if (appId === '' && candidates[0] !== undefined) {
        appId = candidates[0];
      }
    }

    if (targetChatId === '' && appId !== '') {
      //M 跨渠道仅指定应用而未指明 chatId 时，默认回落到该应用最近私聊过的聊天。
      targetChatId = this.feishu.lastPrivate(appId)?.chatId ?? '';
    }
    if (targetChatId === '') {
      //M 目标聊天仍为空时返回参数错误结果并提前终止查询。
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'invalid_argument', message: '跨渠道查询飞书历史需要指定 chat' },
      });
      return;
    }

    //M 校验解析出的应用 ID 已注册，不存在则返回渠道不可用错误。
    const app = this.feishu.apps.get(appId);
    if (app === undefined) {
      //M 找不到对应飞书应用配置时通过结果事件回报错误码。
      emitResult({
        ok: false,
        items: [],
        nextCursor: null,
        scope: snapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'channel_unavailable', message: `未知飞书应用 ${appId}` },
      });
      return;
    }

    if (request.mode === 'mentions') {
      if (app.botOpenId === undefined) {
        //M 尚未拿到机器人自身 open_id 时拒绝精确 mentions 过滤并返回 identity_unresolved。
        emitResult({
          ok: false,
          items: [],
          nextCursor: null,
          scope: `${this.name}:${appId}:${targetChatId}`,
          completeness: 'local_only',
          error: { code: 'identity_unresolved', message: `应用 ${appId} 尚未取得机器人自己的 open_id，无法精确识别 @ 提及` },
        });
        return;
      }
    }

    //M 从本地 jsonl 日志读出这个聊天全部已落盘的消息，换成标准历史条目（落盘的 appId、chatId 不往外带）。
    const rawEntries = this.readChatLog(appId, targetChatId);
    let entries: protocol.ChannelHistoryItem[] = rawEntries.map((entry) => ({
      messageId: entry.messageId,
      nativeId: entry.nativeId,
      direction: entry.direction,
      createdAt: entry.createdAt,
      sender: entry.sender,
      text: entry.text,
      mentions: entry.mentions,
      attachments: entry.attachments,
    }));

    //M @我 模式先在这里挑出 @ 了本机器人的条目（按名字或 open_id 认）；骨架的分页只管 visible 的发送人过滤。
    if (request.mode === 'mentions') {
      entries = entries.filter((entry) => {
        return entry.mentions.some((m) => m.botNames.includes(snapshot.botName) || m.id === app.botOpenId);
      });
    }

    //M 游标校验、发送人过滤、排序、分页和下一页游标，和命令行、网页、微信用同一套。
    const paginateInput = {
      request,
      channel: this.name,
      accountId: appId,
      chatId: targetChatId,
      entries,
    };
    const result = protocol.paginateChannelHistory(paginateInput);

    //M 带上请求号送回分页结果。
    emitResult(result);
  }

  /**
   * 能用的应用里，第一个本地存着这个聊天日志的（只看文件在不在，不新建目录）。
   * 查历史挑应用、跨聊天发话认目标（Reply.ts）时调。
   * @param candidateApps 能用的应用号，按先后。
   * @param chatId 聊天号。
   * @returns 应用号；都没有是 undefined。
   */
  getAppWithLog(candidateApps: string[], chatId: string): string | undefined {
    for (const candidateApp of candidateApps) {
      const logFile = path.join(
        this.ctx.resources.root,
        'channels',
        'feishu',
        'chats',
        namesModule.getSafeName(candidateApp, Infinity),
        `${namesModule.getSafeName(chatId, Infinity)}.jsonl`,
      );
      if (fs.existsSync(logFile)) return candidateApp;
    }
    return undefined;
  }

  /** 飞书聊天本地日志文件（channels/feishu/chats/<app>/<chat>.jsonl）。 */
  private chatLogFile(appId: string, chatId: string): string {
    //M 将 appId 安全转义为目录名，生成对应的聊天历史文件夹并拼出聊天日志文件。
    const dir = this.ctx.resources.dir('channels', 'feishu', 'chats', namesModule.getSafeName(appId, Infinity));
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

  /** 读取某个聊天的全部已保存原始消息。查历史、撤回时认原发信人用。 */
  readChatLog(appId: string, chatId: string): FeishuChatLogEntry[] {
    //M 按应用号和聊天 ID 解析 jsonl 路径，不存在即视为空历史。
    const file = this.chatLogFile(appId, chatId);
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const items: FeishuChatLogEntry[] = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line) as FeishuChatLogEntry);
      } catch {
        continue;
      }
    }
    return items;
  }
}
