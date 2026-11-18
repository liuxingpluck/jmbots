/**
 * 渠道消息索引（ChannelIndex.ts）：听 channel/message、channel/reply 记进表（同键不重复）；按渠道、聊天、时间、关键词查；
 * 本人能查别的聊天，外人、群里的本人只查得到这一轮这个聊天，写了别的被拒。
 * 假 ctx：内存库、记下监听和工具；不起 Cordis、不起 HTTP。
 * 跑法：bun test ./src7/plugins/memory/ChannelIndex.test.ts
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import type * as toolsModule from '../../Tools.ts';
import type * as protocolModule from '../../Channels.ts';
import * as channelIndexModule from './ChannelIndex.ts';
import * as searchModule from './Search.ts';
import type { MemoryService } from './index.ts';


/** 一个用例的摆设。 */
interface Bench {
  /** 索引。 */
  index: channelIndexModule.ChannelIndex;
  /** 登记的 channel_search。 */
  tool: toolsModule.ToolSpec;
  /** 照骨架发一个事件给登记的监听。 */
  emit: (name: string, payload: unknown) => void;
}


/** 摆一个用例：内存库、假 ctx（记下监听和工具），挂上索引。 */
function makeBench(): Bench {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const tools: toolsModule.ToolSpec[] = [];
  const ctx = {
    on: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    emit: () => undefined,
    tools: {
      register: (spec: toolsModule.ToolSpec) => {
        tools.push(spec);
      },
    },
    inject: () => Promise.resolve(),
  } as unknown as cordis.Context;

  const index = new channelIndexModule.ChannelIndex(new Database(':memory:'));
  const unified = new searchModule.Search(ctx, {} as MemoryService, index);
  channelIndexModule.applyChannelIndex(ctx, index, unified);
  const emit = (name: string, payload: unknown): void => {
    for (const handler of handlers.get(name) ?? []) {
      handler(payload);
    }
  };
  return { index, tool: tools[0]!, emit };
}


/**
 * 一条渠道消息（只填索引用到的字段）。
 * @param nativeId 原始号。
 * @param chatId 聊天号。
 * @param text 正文。
 * @param at 时间，本地时间文字。
 */
function getMessage(nativeId: string, chatId: string, text: string, at: string): protocolModule.ChannelMessage {
  const message = {
    messageId: JSON.stringify(['feishu', 'cli_a', nativeId]),
    channel: 'feishu',
    accountId: 'cli_a',
    chatId,
    chatType: 'p2p',
    sender: { id: 'ou_1', name: '小王' },
    targetBots: ['助手'],
    mentions: [],
    text,
    createdAt: Date.parse(at),
  };
  return message as unknown as protocolModule.ChannelMessage;
}


/**
 * 一场会话：这一轮的来源快照照给的写。
 * @param chatId 快照的聊天号。
 * @param role 快照的身份档位。
 * @param chatType 快照的聊天种类。
 */
function getSession(chatId: string, role: string, chatType: string): Session {
  const address = { chatId, role };
  const snapshot = {
    channel: 'feishu', accountId: 'cli_a', chatId, chatType, role, senderId: 'ou_1',
    origin: { channel: 'feishu', address },
  };
  return { id: 's1', row: { id: 's1', address, activeSourceSnapshot: snapshot } } as unknown as Session;
}


/**
 * 调一次 channel_search。
 * @param bench 用例的摆设。
 * @param args 参数。
 * @param session 会话。
 * @returns 工具交回的话；抛错时交回“错：原因”。
 */
async function search(bench: Bench, args: Record<string, unknown>, session: Session): Promise<string> {
  try {
    const result = await bench.tool.run(args, session, new AbortController().signal, 'call-1');
    return String(result);
  } catch (error) {
    return `错：${String(error)}`;
  }
}


test('听 channel/message、channel/reply 记进表，同一条不重复；按渠道、聊天、时间、关键词查，新的在前', () => {
  const bench = makeBench();

  //M 两个聊天各几句；同一条发两次只记一次；空话不记。
  bench.emit('channel/message', getMessage('m1', 'oc_1', '明天开会讨论预算', '2026-11-16T09:00:00'));
  bench.emit('channel/message', getMessage('m1', 'oc_1', '明天开会讨论预算', '2026-11-16T09:00:00'));
  bench.emit('channel/message', getMessage('m2', 'oc_1', '预算 100% 定了', '2026-11-17T09:00:00'));
  bench.emit('channel/message', getMessage('m3', 'oc_2', '另一个群也说预算', '2026-11-17T10:00:00'));
  bench.emit('channel/message', getMessage('m4', 'oc_1', '   ', '2026-11-17T11:00:00'));

  //M 机器人的回复：文字片段连起来，聊天照来源快照。
  const reply = {
    bot: '助手',
    replyRequestKey: 'reply-1',
    parts: [{ partId: 'p1', kind: 'text', text: '好的，预算我记下了' }],
    sourceSnapshot: { channel: 'feishu', accountId: 'cli_a', chatId: 'oc_1', chatType: 'p2p' },
  };
  bench.emit('channel/reply', reply);
  bench.emit('channel/reply', reply);

  //M 全部：4 条（m1 一次、m2、m3、回复一次；空话没记），新的在前。
  const all = bench.index.search({ words: [], limit: 50 });
  expect(all.length).toBe(4);
  expect(all[0]?.direction).toBe('bot');

  //M 按聊天 + 关键词：oc_1 里有“预算”的三条。
  const inChat = bench.index.search({ channel: 'feishu', chat: 'oc_1', words: ['预算'], limit: 50 });
  expect(inChat.map((row) => row.key)).toEqual(['reply-1', JSON.stringify(['feishu', 'cli_a', 'm2']), JSON.stringify(['feishu', 'cli_a', 'm1'])]);

  //M 按时间：17 号零点以后的 oc_1。
  const since = bench.index.search({ chat: 'oc_1', since: Date.parse('2026-11-17T00:00:00'), words: [], limit: 50 });
  expect(since.map((row) => row.text)).toEqual(['好的，预算我记下了', '预算 100% 定了']);

  //M 关键词里的 % 照字面找；几个词都要有。
  expect(bench.index.search({ words: ['100%'], limit: 50 }).length).toBe(1);
  expect(bench.index.search({ words: ['%'], limit: 50 }).length).toBe(1);
  expect(bench.index.search({ words: ['预算', '群'], limit: 50 }).map((row) => row.chat)).toEqual(['oc_2']);
});


test('channel_search：本人能查别的聊天；外人、群里的本人只查这个聊天，写了别的被拒', async () => {
  const bench = makeBench();
  bench.emit('channel/message', getMessage('m1', 'oc_1', '我的私事', '2026-11-16T09:00:00'));
  const shared = getMessage('m2', 'oc_2', '群里的事', '2026-11-17T09:00:00');
  bench.emit('channel/message', { ...shared, chatType: 'group' });
  bench.emit('channel/message', getMessage('m3', 'oc_2', '他的私聊', '2026-11-17T09:00:00'));

  //M 本人在私聊：不写聊天查全部，也能指定别的聊天。
  const owner = getSession('oc_1', 'owner', 'p2p');
  const ownerAll = await search(bench, {}, owner);
  expect(ownerAll).toContain('我的私事');
  expect(ownerAll).toContain('群里的事');
  expect(await search(bench, { chat: 'oc_2' }, owner)).toContain('群里的事');

  //M 外人在 oc_2：不写聊天只查到 oc_2；写 oc_1 被拒，看不到“我的私事”。
  const guest = getSession('oc_2', 'guest', 'p2p');
  const guestOwn = await search(bench, {}, guest);
  expect(guestOwn).toContain('他的私聊');
  expect(guestOwn).not.toContain('群里的事');
  expect(guestOwn).not.toContain('我的私事');
  const guestOther = await search(bench, { chat: 'oc_1' }, guest);
  expect(guestOther).toContain('只能查这个聊天');
  expect(guestOther).not.toContain('我的私事');

  //M 本人在群里：同样只查这个群（查到的会回到群里，群里的人看得到）。
  const ownerInGroup = getSession('oc_2', 'owner', 'group');
  expect(await search(bench, { chat: 'oc_1' }, ownerInGroup)).toContain('只能查这个聊天');
  const groupResult = await search(bench, { person: 'person:feishu:ou_1' }, ownerInGroup);
  expect(groupResult).toContain('群里的事');
  expect(groupResult).not.toContain('他的私聊');
  expect(groupResult).not.toContain('我的私事');

  //M 时间写错：说清怎么写。
  expect(await search(bench, { since: '昨天' }, owner)).toContain('2026-11-17');
});
