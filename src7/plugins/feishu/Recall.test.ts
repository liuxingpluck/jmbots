/**
 * Recall.ts 的 recall：只撤日志里本应用发的、最近 N 条或指定消息号；入口参数不对要拒；已删除算撤成。
 * 用桩代替飞书渠道和 SDK 客户端，不连真飞书。
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '../../Sessions.ts';
import type { FeishuChatLogEntry } from './ChatLog.ts';
import type { Feishu } from './index.ts';
import { recall } from './Recall.ts';

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
});
