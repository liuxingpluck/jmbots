/**
 * 飞书撤回工具：feishu_recall 撤回机器人自己在当前聊天里发过的消息。
 * 只撤聊天日志（ChatLog.ts）里 direction=bot 的记录，也就是这个应用自己发的；别人的消息不碰。
 * 谁能用在 approval/Rules.ts：guest、builder 的工具表里没有它，只有本人那一轮的工具列表里有。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as api from './Api.ts';
import type { Feishu, FeishuAddress } from './index.ts';


/** “最近 N 条”一次最多撤几条。 */
const RECALL_MAX = 50;

/** 飞书说“这条已经被删除”的错误码：当成已经撤回。 */
const ALREADY_DELETED = '230110';


/**
 * 登记 feishu_recall。工具随本插件拔掉自动撤掉。
 * @param feishu 飞书渠道。
 * @param ctx 本插件的 ctx。
 */
export function setup(feishu: Feishu, ctx: cordis.Context): void {
  //M 向骨架注册撤回工具：参数二选一，最近 N 条或消息号清单。
  ctx.tools.register({
    definition: {
      name: 'feishu_recall',
      description: '撤回你自己在当前飞书聊天里发过的消息（群里那一轮就撤这个群里的）。'
        + `参数二选一：count 撤最近 N 条（最多 ${String(RECALL_MAX)}），messageIds 撤指定的消息号（om_ 开头）。`
        + '只撤你自己发的；超过管理员设的撤回时限的撤不掉。非飞书会话不可用。',
      parameters: piAi.Type.Object({
        count: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, maximum: RECALL_MAX, description: '撤最近几条' })),
        messageIds: piAi.Type.Optional(piAi.Type.Array(piAi.Type.String(), { description: '要撤的飞书消息号' })),
      }),
    },
    sessionKinds: ['work'],
    run: (args, session) => {
      const count = args['count'] as number | undefined;
      const ids = args['messageIds'] as string[] | undefined;
      return recall(feishu, session, count, ids);
    },
  });
}


/**
 * 撤回：逐条调 im.v1.message.delete，成功、失败分开记，拼一句。
 * @param feishu 飞书渠道。
 * @param session 哪场会话调的（取应用号、聊天号）。
 * @param count 撤最近几条；和 messageIds 二选一。
 * @param messageIds 要撤的飞书消息号；和 count 二选一。
 * @returns 给模型看的一句话。
 * @throws 不是飞书会话、两个参数没有恰好给一个时抛错。
 */
export async function recall(
  feishu: Feishu,
  session: Session,
  count: number | undefined,
  messageIds: string[] | undefined,
): Promise<string> {
  //G 工具参数的入口校验：飞书会话才有应用号和聊天号；count、messageIds 恰好给一个。
  const address = session.row.address as FeishuAddress | undefined;
  if (session.row.channel !== 'feishu' || !address?.appId || !address.chatId) {
    throw new Error('当前不是飞书会话，无法确定撤回哪个聊天的消息');
  }
  const hasIds = messageIds !== undefined && messageIds.length > 0;
  const hasCount = count !== undefined;
  if (hasIds === hasCount) throw new Error('count 和 messageIds 要二选一，只给一个');

  const { appId, chatId } = address;

  //M 这个应用在这个聊天里发的、还没撤的：聊天日志里 direction=bot 且有飞书消息号的，先后顺序同发出顺序。
  const sentByBot = feishu.history.readChatLog(appId, chatId).filter((entry) => {
    return entry.direction === 'bot' && entry.nativeId !== null && entry.recalled !== true;
  });

  //M 挑出要撤的：count 取最后 N 条；messageIds 逐个在日志里找，找不到的记进失败。
  const failed: string[] = [];
  let picked: typeof sentByBot = [];
  if (hasCount) {
    picked = sentByBot.slice(-count);
  }
  if (hasIds) {
    for (const id of messageIds) {
      const found = sentByBot.find((entry) => entry.nativeId === id.trim());
      if (found === undefined) {
        failed.push(`${id}（日志里没有这个应用在本聊天发的这条，或已撤回）`);
        continue;
      }
      picked.push(found);
    }
  }

  //M 逐条撤：成功或飞书说已删除都标进日志；别的错记进失败，不影响后面的。
  const client = feishu.client(appId);
  const done: string[] = [];
  for (const entry of picked) {
    const nativeId = entry.nativeId as string;
    let deleted = true;
    try {
      const deleteArgs = { path: { message_id: nativeId } };
      await api.call('撤回消息', () => client.im.v1.message.delete(deleteArgs));
    } catch (error) {
      const reason = textModule.getErrorMessage(error);
      deleted = reason.includes(ALREADY_DELETED);
      if (!deleted) {
        failed.push(`${nativeId}（${reason}）`);
      }
    }
    if (deleted) {
      feishu.history.markRecalled(appId, chatId, entry.messageId);
      done.push(nativeId);
    }
  }

  const parts: string[] = [];
  if (done.length > 0) parts.push(`已撤回 ${String(done.length)} 条：${done.join('、')}`);
  if (failed.length > 0) parts.push(`没撤成 ${String(failed.length)} 条：${failed.join('、')}`);
  if (parts.length === 0) return '聊天日志里没有可撤的消息';

  return parts.join('；');
}


/**
 * 温和撤回单条机器人占位消息（供 feishu/recall-message 事件调用）。
 * 严格白名单：必须提供非空 chatId，且聊天日志中明确查到 direction === 'bot' 的记录才执行撤回；
 * 查不到、非机器人消息、未开撤回权限或超过撤回时限，一律温和返回 ok: false，绝不抛错阻断主流程。
 * @param feishu 飞书渠道实例。
 * @param appId 发出该消息的应用号。
 * @param chatId 所属聊天号（必填，用于白名单核对聊天日志与标记 recalled）。
 * @param messageId 飞书原生消息号（如 om_xxx）。
 * @returns 撤回结果。
 */
export async function recallBotMessage(
  feishu: Feishu,
  appId: string,
  chatId: string | undefined,
  messageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const nativeId = messageId.trim();
  if (nativeId === '') return { ok: false, error: '缺少待撤回的飞书消息号' };

  const normalizedChatId = (chatId ?? '').trim();
  if (normalizedChatId === '') return { ok: false, error: '缺少待撤回消息所属的聊天号' };

  //G 严格白名单：只允许撤回聊天日志中明确记录为 direction === 'bot' 的机器人消息。
  const logs = feishu.history.readChatLog(appId, normalizedChatId);
  const entry = logs.find((item) => item.nativeId === nativeId);
  if (entry === undefined || entry.direction !== 'bot') {
    return { ok: false, error: '聊天日志中未找到机器人发出的对应消息，拒绝撤回' };
  }

  try {
    const client = feishu.client(appId);
    await api.call('撤回占位消息', () => client.im.v1.message.delete({ path: { message_id: nativeId } }));
  } catch (error) {
    const reason = textModule.getErrorMessage(error);
    if (!reason.includes(ALREADY_DELETED)) {
      const logTime = textModule.formatLocalTime(Date.now(), 'date');
      console.error(`${logTime} 飞书：撤回占位消息 ${nativeId} 跳过（不影响真回复）：${reason}`);
      return { ok: false, error: reason };
    }
  }

  feishu.history.markRecalled(appId, normalizedChatId, entry.messageId);
  return { ok: true };
}
