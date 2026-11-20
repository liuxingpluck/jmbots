/**
 * 飞书拉群聊历史：用 SDK 的 im/v1/messages（container_id_type=chat，翻页）把一个群的历史拉回来，
 * 交给 Inbound.onHistory 拼成标准消息（附件下载、聊天日志照实时消息的规矩），再按时间从旧到新发 channel/history。
 * 只给记录类插件（memory）补记：不触发会话、不回话。机器人进群以前、服务停着时漏掉的话靠它补。
 * 触发有两个：HTTP 接口 POST /api/feishu/history（index.ts 的 apply 挂）和机器人新进群（index.ts 的 start 听 im.chat.member.bot.added_v1，
 * 拉最近 historyOnJoin 条，配置里写 0 就不拉）。
 * 去重：聊天日志里已有的消息号（实时收到过的）直接跳过，不重复下载附件；没在日志里的再由 memory 按消息号挡一道。
 * 机器人自己发的话（sender_type 是 app）不拉：它们已经由 channel/replied 记进记忆，回复键和飞书消息号对不上，拉回来会记两份。
 * 权限不够：api.call 的报错会写明要开 im:message.group_msg、im:message:readonly，并要再发布一次版本；本文件不吞错。
 */
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import type { ChannelMessage } from '../channels/index.ts';
import * as api from './Api.ts';
import type { AppState, Feishu } from './index.ts';
import type { ReceiveData } from './Inbound.ts';


/** 一页拉多少条（飞书 page_size 最大 50）。 */
const PAGE_SIZE = 50;


/** message.list 交回的一条里用到的几项（SDK 的 im.v1.message.list，types/index.d.ts）。 */
interface HistoryItem {
  /** 飞书消息号。 */
  message_id?: string;
  /** 回复的上一条（引用）。 */
  parent_id?: string;
  /** 话题的根消息。 */
  root_id?: string;
  /** 消息类型：text、image、file、post…… */
  msg_type?: string;
  /** 创建时间，毫秒的字符串。 */
  create_time?: string;
  /** 已被撤回删除。 */
  deleted?: boolean;
  /** 发的人：id 是 open_id，sender_type 是 user（人）或 app（机器人）。 */
  sender?: { id: string; id_type: string; sender_type: string };
  /** 正文，格式和收到的消息一样（JSON 字符串）。 */
  body?: { content: string };
  /** @ 清单：id 是 open_id。 */
  mentions?: { key: string; id: string; id_type: string; name: string }[];
}


/** 一次拉取的结果。 */
export interface PullResult {
  /** 哪个应用拉的。 */
  appId: string;
  /** 拉的哪个群。 */
  chatId: string;
  /** 新交给记忆的条数。 */
  pulled: number;
  /** 跳过的条数：本地聊天日志里已有、机器人自己发的、已撤回的。 */
  skipped: number;
  /** 没处理成（比如拼消息出错）的条数。 */
  failed: number;
}


/** 飞书拉群历史：Feishu 构造时建一个，挂在 feishu.historyPull 上。 */
export class FeishuHistoryPull {
  constructor(private readonly ctx: cordis.Context, private readonly feishu: Feishu) {}

  /**
   * 拉一个群最近 limit 条历史，发 channel/history。
   * @param app 用哪个应用拉（机器人要在这个群里）。
   * @param chatId 群号。
   * @param limit 最多拉几条（已经校验过的正整数）。
   * @returns 拉了多少、跳过多少、几条没处理成。
   * @throws 权限不够、飞书出错时抛中文的错（api.call 写明该开的权限）。
   * 副作用：附件下载到渠道附件目录，聊天日志追加，发 channel/history。
   */
  async pull(app: AppState, chatId: string, limit: number): Promise<PullResult> {
    const appId = app.config.appId;
    const items: HistoryItem[] = [];

    //==========================================================
    //M 第一块：从新到旧翻页，攒够 limit 条或翻完为止
    //==========================================================
    let pageToken: string | undefined;
    while (items.length < limit) {
      const params: {
        container_id_type: string;
        container_id: string;
        sort_type: 'ByCreateTimeDesc';
        page_size: number;
        page_token?: string;
      } = { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: PAGE_SIZE };
      if (pageToken !== undefined) {
        params.page_token = pageToken;
      }

      const page = await api.call('拉群历史', () => app.client.im.v1.message.list({ params }));
      items.push(...((page.data?.items ?? []) as HistoryItem[]));
      if (page.data?.has_more !== true) break;

      pageToken = page.data.page_token;
      if (pageToken === undefined) break;
    }

    //==========================================================
    //M 第二块：从旧到新逐条拼成标准消息，一页一批发出去
    //==========================================================
    const known = new Set(this.feishu.history.readChatLog(appId, chatId).map((entry) => entry.messageId));
    const result: PullResult = { appId, chatId, pulled: 0, skipped: 0, failed: 0 };
    let batch: ChannelMessage[] = [];
    const oldestFirst = items.slice(0, limit).reverse();
    for (const item of oldestFirst) {
      const nativeId = item.message_id ?? '';
      const standardId = JSON.stringify([this.feishu.name, appId, nativeId]);

      //G 没消息号、已撤回、机器人自己发的、本地日志里已有的，都不拉。
      const skip = nativeId === '' || item.deleted === true || item.sender?.sender_type === 'app' || known.has(standardId);
      if (skip) {
        result.skipped += 1;
        continue;
      }

      try {
        const data = this.getReceiveData(chatId, nativeId, item);
        const createdAt = Number(item.create_time ?? 0);
        const message = await this.feishu.inbound.onHistory(appId, app, data, createdAt);
        batch.push(message);
        result.pulled += 1;
      } catch (error) {
        //G 一条拼不出来不挡后面的，数一下、打一行日志。
        result.failed += 1;
        const when = textModule.formatLocalTime(Date.now(), 'date');
        console.error(`${when} 飞书 ${appId} 拉群 ${chatId} 的历史，消息 ${nativeId} 没处理成：${textModule.getErrorMessage(error)}`);
      }

      //M 攒满一页就发，别一次压一大堆。
      if (batch.length >= PAGE_SIZE) {
        await this.ctx.serial('channel/history', batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.ctx.serial('channel/history', batch);
    }
    return result;
  }

  /**
   * 机器人新进群：自动拉最近 historyOnJoin 条；配置写 0 不拉。失败只打日志（带该开的权限），不往群里说。
   * @param app 收到进群事件的应用。
   * @param chatId 新进的群。
   */
  async onJoin(app: AppState, chatId: string): Promise<void> {
    const limit = this.feishu.config.historyOnJoin;
    if (limit === 0) return;

    try {
      const result = await this.pull(app, chatId, limit);
      const summary = `拉了 ${String(result.pulled)} 条，跳过 ${String(result.skipped)} 条，失败 ${String(result.failed)} 条`;
      console.log(`飞书 ${app.config.appId} 进群 ${chatId}，历史${summary}`);
    } catch (error) {
      //G 权限不够等报错照实打出来（api.call 已写明要开的权限），不悄悄失败。
      const when = textModule.formatLocalTime(Date.now(), 'date');
      console.error(`${when} 飞书 ${app.config.appId} 进群 ${chatId} 后拉历史失败：${textModule.getErrorMessage(error)}`);
    }
  }

  /**
   * 一条历史拼成实时消息事件的样子，好走同一套 getFacts。群历史一律按 group。
   * @param chatId 群号。
   * @param nativeId 飞书消息号。
   * @param item message.list 的一条。
   * @returns 实时消息事件的数据。
   */
  private getReceiveData(chatId: string, nativeId: string, item: HistoryItem): ReceiveData {
    //M 发的人：id_type 是 open_id 才算 open_id，认不出就不写（后面当 unknown）。
    const senderId: { open_id?: string } = {};
    if (item.sender?.id_type === 'open_id') {
      senderId.open_id = item.sender.id;
    }

    //M @ 清单：历史里 id 是字符串，实时消息里是 { open_id }。
    const mentions = (item.mentions ?? []).map((mention) => {
      const id: { open_id?: string } = {};
      if (mention.id_type === 'open_id') {
        id.open_id = mention.id;
      }
      return { key: mention.key, id, name: mention.name };
    });

    const data: ReceiveData = {
      sender: { sender_id: senderId, sender_type: item.sender?.sender_type ?? 'user' },
      message: {
        message_id: nativeId,
        chat_id: chatId,
        chat_type: 'group',
        message_type: item.msg_type ?? 'text',
        content: item.body?.content ?? '{}',
        mentions,
      },
    };
    if (item.parent_id !== undefined) {
      data.message.parent_id = item.parent_id;
    }
    if (item.root_id !== undefined) {
      data.message.root_id = item.root_id;
    }
    return data;
  }
}
