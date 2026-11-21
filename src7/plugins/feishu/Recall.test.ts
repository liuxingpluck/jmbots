/**
 * Recall.ts 的 recall：只撤日志里本应用发的、最近 N 条或指定消息号；入口参数不对要拒；已删除算撤成。
 * 用桩代替飞书渠道和 SDK 客户端，不连真飞书。
 */
import { describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import type { FeishuChatLogEntry } from './ChatLog.ts';
import { Feishu } from './index.ts';
import { recall, recallBotMessage } from './Recall.ts';

/** 造一条日志记录。 */
function entry(nativeId: string, direction: 'user' | 'bot'): FeishuChatLogEntry {
  return {
    messageId: nativeId, nativeId, appId: 'app', chatId: 'oc_1', direction, createdAt: 1,
    sender: { id: 'x' }, text: '', mentions: [], attachments: [],
  };
}

/** 造桩：日志、被调用撤回的号、哪些号让飞书回“已删除”。 */
function makeFeishu(entries: FeishuChatLogEntry[], deletedIds: string[]) {
  const called: string[] = [];
  const feishu = {
    history: {
      readChatLog: () => entries,
      markRecalled: (_app: string, _chat: string, messageId: string) => {
        const found = entries.find((item) => item.messageId === messageId);
        if (found !== undefined) found.recalled = true;
      },
    },
    client: () => ({
      im: {
        v1: {
          message: {
            delete: (args: { path: { message_id: string } }) => {
              const id = args.path.message_id;
              called.push(id);
              if (deletedIds.includes(id)) return Promise.resolve({ code: 230110, msg: 'deleted' });
              return Promise.resolve({ code: 0 });
            },
          },
        },
      },
    }),
  } as unknown as Feishu;
  return { feishu, called };
}

const session = { row: { channel: 'feishu', address: { appId: 'app', chatId: 'oc_1' } } } as unknown as Session;

describe('feishu_recall', () => {
  test('count 撤最近 N 条机器人发的，不碰用户的消息，撤成功标 recalled', async () => {
    const entries = [entry('om_1', 'bot'), entry('om_u', 'user'), entry('om_2', 'bot'), entry('om_3', 'bot')];
    const { feishu, called } = makeFeishu(entries, []);
    const text = await recall(feishu, session, 2, undefined);
    expect(called).toEqual(['om_2', 'om_3']);
    expect(text).toContain('已撤回 2 条');
    expect(entries[2]!.recalled).toBe(true);

    //M 再撤一次最近 1 条，不会再数已撤回的 om_2、om_3。
    await recall(feishu, session, 1, undefined);
    expect(called[2]).toBe('om_1');
  });

  test('messageIds 只撤日志里机器人发的，用户的和没见过的记进失败；飞书说已删除算撤成', async () => {
    const entries = [entry('om_1', 'bot'), entry('om_u', 'user'), entry('om_2', 'bot')];
    const { feishu, called } = makeFeishu(entries, ['om_2']);
    const text = await recall(feishu, session, undefined, ['om_1', 'om_u', 'om_x', 'om_2']);
    expect(called).toEqual(['om_1', 'om_2']);
    expect(text).toContain('已撤回 2 条');
    expect(text).toContain('没撤成 2 条');
  });

  test('入口拒绝：两个参数都给或都不给、不是飞书会话', async () => {
    const { feishu } = makeFeishu([], []);
    await expect(recall(feishu, session, 1, ['om_1'])).rejects.toThrow('二选一');
    await expect(recall(feishu, session, undefined, undefined)).rejects.toThrow('二选一');
    const web = { row: { channel: 'http', address: {} } } as unknown as Session;
    await expect(recall(feishu, web, 1, undefined)).rejects.toThrow('不是飞书会话');
  });

  test('recallBotMessage 温和撤回占位消息：成功标 recalled，无权限或超时静默回 ok: false 绝不抛错', async () => {
    const entries = [entry('om_ack', 'bot'), entry('om_user', 'user')];
    const { feishu, called } = makeFeishu(entries, []);
    const okRes = await recallBotMessage(feishu, 'app', 'oc_1', 'om_ack');
    expect(okRes).toEqual({ ok: true });
    expect(called).toEqual(['om_ack']);
    expect(entries[0]!.recalled).toBe(true);

    //M 拒绝撤回用户消息。
    const userRes = await recallBotMessage(feishu, 'app', 'oc_1', 'om_user');
    expect(userRes.ok).toBe(false);

    //M 严格白名单：缺少 chatId 或日志里查不到该消息号时，一律温和拒绝且不调用飞书删除接口。
    const noChatRes = await recallBotMessage(feishu, 'app', '', 'om_ack');
    expect(noChatRes.ok).toBe(false);
    const missingChatRes = await recallBotMessage(feishu, 'app', undefined, 'om_ack');
    expect(missingChatRes.ok).toBe(false);
    const unknownRes = await recallBotMessage(feishu, 'app', 'oc_1', 'om_not_in_log');
    expect(unknownRes.ok).toBe(false);
    expect(called).toEqual(['om_ack']);

    //M 模拟未开撤回权限或超过撤回时限抛错 -> 静默返回 ok: false，不向外抛异常。
    const failingFeishu = {
      history: { readChatLog: () => [entry('om_expired', 'bot')], markRecalled: () => undefined },
      client: () => ({
        im: {
          v1: {
            message: {
              delete: () => Promise.reject(new Error('99991672 permission denied im:message:recall')),
            },
          },
        },
      }),
    } as unknown as Feishu;
    const failRes = await recallBotMessage(failingFeishu, 'app', 'oc_1', 'om_expired');
    expect(failRes.ok).toBe(false);
    expect(failRes.error).toContain('im:message:recall');
  });

  test('onRecallMessage 即使请求显式传入 appId，也必须校验该 appId 归属目标 bot', async () => {
    const ctx = new cordis.Context();
    const deleteCalls: string[] = [];
    const fakeInstance = Object.create(Feishu.prototype) as {
      apps: Map<string, { config: { appId: string; bot: string; bots?: string[] } }>;
      history: { readChatLog: () => FeishuChatLogEntry[]; markRecalled: () => void };
      client: () => unknown;
      onRecallMessage: (req: {
        bot: string;
        appId?: string;
        chatId?: string;
        messageId: string;
      }) => Promise<{ ok: boolean; error?: string }>;
    };
    fakeInstance.apps = new Map([
      ['cli_a', { config: { appId: 'cli_a', bot: 'BotA' } }],
      ['cli_b', { config: { appId: 'cli_b', bot: 'BotB' } }],
    ]);
    fakeInstance.history = {
      readChatLog: () => [entry('om_bot_a', 'bot')],
      markRecalled: () => undefined,
    };
    fakeInstance.client = () => ({
      im: {
        v1: {
          message: {
            delete: (args: { path: { message_id: string } }) => {
              deleteCalls.push(args.path.message_id);
              return Promise.resolve({ code: 0 });
            },
          },
        },
      },
    });

    requestEventModule.onRequestEvent(ctx, 'feishu/recall-message', 'feishu/recall-message-result', (req) => {
      return fakeInstance.onRecallMessage(req);
    });

    //M 传错归属（BotA 传了 BotB 的 cli_b）→ 拒绝，绝不调用飞书删除接口。
    const wrongApp = await requestEventModule.requestEvent(
      ctx,
      'feishu/recall-message',
      'feishu/recall-message-result',
      { bot: 'BotA', appId: 'cli_b', chatId: 'oc_1', messageId: 'om_bot_a' },
    );
    expect(wrongApp.why).toBeUndefined();
    expect(wrongApp.reply?.ok).toBe(false);
    expect(wrongApp.reply?.error).toContain('BotA');
    expect(deleteCalls).toEqual([]);

    //M 传入正确归属（BotA 传 cli_a）→ 放行并成功撤回。
    const rightApp = await requestEventModule.requestEvent(
      ctx,
      'feishu/recall-message',
      'feishu/recall-message-result',
      { bot: 'BotA', appId: 'cli_a', chatId: 'oc_1', messageId: 'om_bot_a' },
    );
    expect(rightApp.why).toBeUndefined();
    expect(rightApp.reply?.ok).toBe(true);
    expect(deleteCalls).toEqual(['om_bot_a']);

    await ctx.fiber.dispose();
  });
});
