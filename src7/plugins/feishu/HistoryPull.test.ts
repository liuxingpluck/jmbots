/**
 * 飞书拉群聊历史（HistoryPull.ts）：假 SDK，不连飞书。
 * 跑法：bun test ./src7/plugins/feishu/HistoryPull.test.ts
 * 真的 Feishu 类（不 apply、不连长连接），im.v1.message.list、messageResource.get 换成假的；群名和成员预先填进缓存，不发请求。
 * 查的是：翻页从新到旧拉、发 channel/history 时从旧到新；机器人自己发的、聊天日志里已有的、已撤回的跳过；
 * 历史里的文件照实时消息的规矩下载；标准消息 targetBots 空、时间用飞书给的；limit 截断；
 * 权限不够时报错写明要开的权限；机器人进群的自动拉只在 history_on_join 非 0 时做、失败打日志不抛。
 */
import { afterAll, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type { ChannelMessage } from '../channels/index.ts';
import * as feishuModule from './index.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-feishu-history-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const BOT = '测试机器人';
const APP_ID = 'cli_0123456789abcdef';
const CHAT = 'oc_history';
const OWNER = 'ou_owner';
const FRIEND = 'ou_friend';

/** 一套假环境：真 Feishu、收到的 channel/history 批次、假的 SDK 调用。 */
function createWorld(historyOnJoin: number) {
  const ctx = new cordis.Context();
  const db = new Database(':memory:');
  const resources = {
    db,
    root,
    ensureRuntimeDir: (...parts: string[]) => {
      const dir = path.join(root, ...parts);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
  ctx.provide('resources', resources);
  ctx.provide('bots', { channel: () => () => undefined });
  ctx.effect(() => () => db.close());

  const people = new Map<string, feishuModule.FeishuPerson>([
    [OWNER, { openId: OWNER, name: 'leon', role: 'owner', dir: '' }],
  ]);
  const config = {
    domain: 'http://127.0.0.1:9',
    apps: [{ appId: APP_ID, appSecret: 'x', bot: BOT }],
    people,
    groups: new Map<string, feishuModule.FeishuGroup>(),
    historyOnJoin,
  };
  const feishu = new feishuModule.Feishu(ctx, config);
  const members = new Map([[FRIEND, '周周']]);
  feishu.chats.set(CHAT, { name: '历史群', members, at: Date.now() });

  //M 收 channel/history：每批记下来。
  const batches: ChannelMessage[][] = [];
  ctx.on('channel/history', (messages) => {
    batches.push(messages);
  });

  const app = feishu.apps.get(APP_ID);
  if (app === undefined) throw new Error('应用没建起来');
  return { ctx, feishu, app, batches, sdk: feishu.client(APP_ID) };
}

/** 一条 message.list 的历史消息。 */
function getItem(id: string, sender: string, text: string, time: number, type = 'sender') {
  const senderType = type === 'sender' ? 'user' : 'app';
  return {
    message_id: id,
    msg_type: 'text',
    create_time: String(time),
    chat_id: CHAT,
    sender: { id: sender, id_type: 'open_id', sender_type: senderType },
    body: { content: JSON.stringify({ text }) },
  };
}

test('翻页拉历史：从旧到新发 channel/history，机器人自己发的、日志里已有的、撤回的跳过，文件照实时规矩下载', async () => {
  const world = createWorld(0);
  try {
    //M 日志里已有一条（实时收到过）。
    const known = JSON.stringify(['feishu', APP_ID, 'om_known']);
    world.feishu.history.appendChatLog(APP_ID, CHAT, {
      messageId: known, nativeId: 'om_known', appId: APP_ID, chatId: CHAT, direction: 'user', createdAt: 1,
      sender: { id: FRIEND }, text: '早就收到的', mentions: [], attachments: [],
    });

    const fileItem = {
      ...getItem('om_file', FRIEND, '', 1000),
      msg_type: 'file',
      body: { content: JSON.stringify({ file_key: 'file_k1', file_name: '报告.txt' }) },
    };
    const page1 = { data: { has_more: true, page_token: 'tk2', items: [
      getItem('om_new', OWNER, '最新的话', 3000),
      getItem('om_bot', 'ou_bot', '机器人说的', 2900, 'app'),
      getItem('om_known', FRIEND, '早就收到的', 2800),
    ] } };
    const page2 = { data: { has_more: false, items: [
      { ...getItem('om_deleted', FRIEND, '撤了', 1500), deleted: true },
      fileItem,
    ] } };
    const list = spyOn(world.sdk.im.v1.message, 'list');
    list.mockResolvedValueOnce(page1 as never);
    list.mockResolvedValueOnce(page2 as never);
    const stream = async function* () { yield Buffer.from('文件内容'); };
    const download = spyOn(world.sdk.im.v1.messageResource, 'get');
    download.mockResolvedValue({ headers: {}, getReadableStream: stream } as never);

    const result = await world.feishu.historyPull.pull(world.app, CHAT, 100);

    expect(result).toEqual({ appId: APP_ID, chatId: CHAT, pulled: 2, skipped: 3, failed: 0 });
    expect(list).toHaveBeenCalledTimes(2);
    const first = list.mock.calls[0]?.[0] as { params: Record<string, unknown> };
    expect(first.params).toMatchObject({ container_id_type: 'chat', container_id: CHAT, sort_type: 'ByCreateTimeDesc' });
    const second = list.mock.calls[1]?.[0] as { params: Record<string, unknown> };
    expect(second.params['page_token']).toBe('tk2');

    //M 一批，从旧到新：先文件那条，后最新的话。
    expect(world.batches.length).toBe(1);
    const messages = world.batches[0] ?? [];
    expect(messages.map((message) => message.nativeId)).toEqual(['om_file', 'om_new']);
    const latest = messages[1];
    expect(latest?.messageId).toBe(JSON.stringify(['feishu', APP_ID, 'om_new']));
    expect(latest?.text).toBe('最新的话');
    expect(latest?.createdAt).toBe(3000);
    expect(latest?.timeSource).toBe('provider');
    expect(latest?.targetBots).toEqual([]);
    expect(latest?.chatType).toBe('group');
    expect(latest?.sender).toEqual({ id: OWNER, name: 'leon' });

    //M 文件下到了渠道附件目录，标准消息里是可用附件。
    const attachment = messages[0]?.attachments[0];
    expect(attachment?.state).toBe('available');
    expect(fs.readFileSync(attachment?.sourceRef ?? '', 'utf8')).toBe('文件内容');

    //M 聊天日志追加了新的两条（已有的没重复）。
    const logged = world.feishu.history.readChatLog(APP_ID, CHAT).map((entry) => entry.nativeId);
    expect(logged).toEqual(['om_known', 'om_file', 'om_new']);
  } finally {
    await world.ctx.fiber.dispose();
  }
});

test('limit 只要最新的几条', async () => {
  const world = createWorld(0);
  try {
    const page = { data: { has_more: true, page_token: 'more', items: [
      getItem('om_3', FRIEND, '三', 3000),
      getItem('om_2', FRIEND, '二', 2000),
      getItem('om_1', FRIEND, '一', 1000),
    ] } };
    const list = spyOn(world.sdk.im.v1.message, 'list');
    list.mockResolvedValue(page as never);

    const result = await world.feishu.historyPull.pull(world.app, CHAT, 2);

    //M 攒够 2 条就不再翻页；只发最新两条，从旧到新。
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.pulled).toBe(2);
    const ids = (world.batches[0] ?? []).map((message) => message.nativeId);
    expect(ids).toEqual(['om_2', 'om_3']);
  } finally {
    await world.ctx.fiber.dispose();
  }
});

/** 飞书“应用没有权限”的错：HTTP 400，body 里带 code、msg。 */
function getPermissionError(): Error {
  const error = new Error('Request failed with status code 400');
  Object.assign(error, { response: { status: 400, data: { code: 99991672, msg: 'Access denied' } } });
  return error;
}

test('权限不够：报错写明要开 im:message.group_msg 和 im:message:readonly，不发任何事件', async () => {
  const world = createWorld(0);
  try {
    spyOn(world.sdk.im.v1.message, 'list').mockRejectedValue(getPermissionError());

    const pulled = world.feishu.historyPull.pull(world.app, CHAT, 10);

    await expect(pulled).rejects.toThrow(/im:message\.group_msg.*im:message:readonly.*发布/u);
    expect(world.batches.length).toBe(0);
  } finally {
    await world.ctx.fiber.dispose();
  }
});

test('机器人进群：history_on_join 是 0 不拉；非 0 拉最近这么多条；失败只打日志不抛', async () => {
  const silent = createWorld(0);
  try {
    const list = spyOn(silent.sdk.im.v1.message, 'list');
    await silent.feishu.historyPull.onJoin(silent.app, CHAT);
    expect(list).not.toHaveBeenCalled();
  } finally {
    await silent.ctx.fiber.dispose();
  }

  const joined = createWorld(2);
  const logged = spyOn(console, 'log').mockImplementation(() => undefined);
  const failed = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const page = { data: { has_more: false, items: [
      getItem('om_b', FRIEND, 'b', 2000),
      getItem('om_a', FRIEND, 'a', 1000),
    ] } };
    const list = spyOn(joined.sdk.im.v1.message, 'list');
    list.mockResolvedValueOnce(page as never);
    await joined.feishu.historyPull.onJoin(joined.app, CHAT);
    expect(joined.batches[0]?.map((message) => message.nativeId)).toEqual(['om_a', 'om_b']);

    list.mockRejectedValueOnce(getPermissionError());
    await joined.feishu.historyPull.onJoin(joined.app, 'oc_other');
    const said = String(failed.mock.calls[0]?.[0]);
    expect(said).toContain('im:message.group_msg');
  } finally {
    logged.mockRestore();
    failed.mockRestore();
    await joined.ctx.fiber.dispose();
  }
});
