/**
 * Rules.ts 的 isProjectCheck：项目自己的检查、编译直接放行；接了别的命令、不认识的脚本、带引号空格的参数不放行。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type { ChannelMessage } from '../../Channels.ts';
import type { Session } from '../../Sessions.ts';
import * as channel from '../memory/ChannelIndex.ts';
import * as searchModule from '../memory/Search.ts';
import type { MemoryService } from '../memory/index.ts';
import { isProjectCheck, toolsFor } from './Rules.ts';

describe('isProjectCheck', () => {
  test('src7 的检查、测试、编译放行', () => {
    const passed = [
      'bun run typecheck:src7',
      'bun.cmd run test:src7',
      'bun run typecheck',
      'bun test src7/plugins/relay',
      String.raw`cd /d jmbots && bun scripts/Build_Src7.ts --out cache\打包测试\20261116-1500EST`,
      'bun scripts/Build_Src7.ts --out cache/build --skip_checks yes 2>&1',
      String.raw`bun scripts/Build_Src7.ts --out ..\..\AIJMBots\jmbotsData\updates`,
    ];
    for (const command of passed) {
      expect(isProjectCheck(command)).toBe(true);
    }
  });

  test('接了别的命令、不认识的脚本、怪参数不放行', () => {
    const rejected = [
      'bun run typecheck:src7 & del x',
      'bun run build',
      'bun run release',
      'bun scripts/Swap_Serve.ts',
      'bun scripts/Build_Release.ts',
      'bun scripts/Other.ts',
      'bun scripts/Build_Src7.ts --out "a b"',
      'bun scripts/Build_Src7.ts --out x | more',
    ];
    for (const command of rejected) {
      expect(isProjectCheck(command)).toBe(false);
    }
  });

  test('AOBB 只在源码根自动放行，允许完整引号里的查询和安全编码', () => {
    //M 对照实际命令的执行目录，其他目录里同名相对脚本一律走正常审核。
    const root = path.resolve(import.meta.dir, '..', '..', '..');
    const other = path.dirname(root);
    const tool = 'bun ztools/aobb-shot/Aobb_Shot.ts';
    const dest = '--out docs/开发进度/截屏.png';
    const url = 'http://localhost:30086/decision-map/?focus=one&lang=zh-CN';
    const command = `${tool} --url "${url}" ${dest} --width 390 --click .mode --click #panel --text`;
    expect(isProjectCheck(command, root)).toBe(true);
    expect(isProjectCheck(command, other)).toBe(false);
    expect(isProjectCheck(command)).toBe(false);

    //M cmd 不会解释 Base64url 字符，解码后的百分号和查询仍按 URL 原样交给 AOBB。
    const coded = Buffer.from('http://127.0.0.1:30086/?q=%E6%B5%8B&view=map').toString('base64url');
    const encoded = `${tool} --url-b64 ${coded} ${dest} --mask off`;
    expect(isProjectCheck(encoded, root)).toBe(true);
  });

  test('AOBB 的项目白名单拒绝命令拼接、外部 URL 和越界输出', () => {
    const root = path.resolve(import.meta.dir, '..', '..', '..');
    const tool = 'bun ztools/aobb-shot/Aobb_Shot.ts';
    const dest = '--out docs/开发进度/截屏.png';
    const url = 'http://127.0.0.1:30086/';
    const base = `${tool} --url ${url} ${dest}`;
    const rejected = [
      `${base} & echo nope`,
      `${base} | echo nope`,
      `${base}; echo nope`,
      `${base}\necho nope`,
      `${base} 2>&1`,
      `cd . && ${base}`,
      `${tool} --url ${url}?x=1&y=2 ${dest}`,
      `${tool} --url "${url}?x=%PATH%" ${dest}`,
      `${tool} --url "${url}"&echo ${dest}`,
      `${tool} --url http://example.test:30086 ${dest}`,
      `${tool} --url ${url} --out docs/开发进度/../../x.png`,
      `${tool} --url ${url} --out F:/aidata/cache/aobb-shot-sibling/x.png`,
      `${base} --click ".first & echo"`,
      `${base} --width 99999`,
      `${base} --url ${url}`,
    ];
    for (const command of rejected) {
      //G 每个例子都只测白名单解析，不送进系统 shell。
      expect(isProjectCheck(command, root)).toBe(false);
    }
  });
});

for (const role of ['guest', 'builder'] as const) {
  test(`${role} 能用统一记忆工具，只搜到当前账号和聊天`, async () => {
    const allowed = toolsFor(role);
    expect(allowed?.has('memory_search')).toBe(true);
    expect(allowed?.has('memory_get')).toBe(true);
    expect(allowed?.has('channel_search')).toBe(true);

    const db = new Database(':memory:');
    try {
      const index = new channel.ChannelIndex(db);
      //M 用正式渠道消息入口打标，跨聊天和跨账号的样本也使用相同写入路径。
      const address = { role, chatType: 'group' };
      const message: Omit<ChannelMessage, 'messageId'> = {
        v: 1, nativeId: null, channel: 'feishu', accountId: 'app1', chatId: 'current', chatType: 'group',
        sender: { id: 'person' }, role, targetBots: ['bot'], mentions: [],
        rawText: '退款通知', text: '退款通知', attachments: [], createdAt: 100, receivedAt: 100,
        timeSource: 'provider', replyTo: null, origin: { channel: 'feishu', address },
        visibility: { scope: 'feishu:app1:current', trusted: false, publicSourceIds: [] },
        routing: { listenOnly: false },
      };
      for (const sample of [
        { ...message, messageId: 'mine' },
        { ...message, messageId: 'other-chat', chatId: 'other' },
        { ...message, messageId: 'other-account', accountId: 'app2' },
      ]) {
        const row = channel.getMessageRow(sample);
        index.add(row!);
      }

      const source = { role, channel: 'feishu', accountId: 'app1', chatId: 'current', chatType: 'group', origin: { address } };
      const session = { row: { address, bot: 'bot', activeSourceSnapshot: source } } as unknown as Session;
      const ctx = new cordis.Context();
      const rustQueries: Record<string, unknown>[] = [];
      const otherCopy = {
        id: 8, scope: 'history', source: channel.CHANNEL_PARTITION + 'other-account',
        title: '他人退款', snippet: '退款通知', at: 100, via: ['keyword'], customer: 'group:feishu:current', bot: 'bot',
      };
      const backend = {
        search: async (body: Record<string, unknown>) => {
          rustQueries.push(body);
          return { ok: true, json: { hits: [otherCopy] } };
        },
        readSearchData: async () => ({ passage: otherCopy }),
      } as unknown as MemoryService;
      const search = new searchModule.Search(ctx, backend, index);
      const result = await search.find({ q: '退款' }, session);
      expect(result.hits.map((hit) => hit.id)).toEqual(['mine']);
      expect(result.skipped).toEqual(['knowledge', 'card']);
      expect(rustQueries).toEqual([expect.objectContaining({ customer: 'group:feishu:current' })]);
      await expect(search.find({ q: '退款', chat: 'other' }, session)).rejects.toThrow('这个聊天');
      const ref = result.hits[0]!.ref.replace('id=mine', 'id=other-account');
      await expect(search.get({ ref }, session)).rejects.toThrow('找不到');

      //G 仅选 Rust 往来或直接猜 Rust 原文编号也不能绕开账号隔离。
      const history = await search.find({ q: '退款', sources: 'history' }, session);
      expect(history.hits).toEqual([]);
      await expect(search.get({ ref: '/api/memory-graph/passage/8' }, session)).rejects.toThrow('当前归属');

      //M 空键模拟升级前的原记录；本轮渠道、账号、聊天三项都匹配时才能搜和取原文。
      const anchor = index.context('mine', { words: [], limit: 1 }).anchor;
      const old = { ...anchor, memoryKey: '', at: 80 };
      index.add({ ...old, key: 'old-mine' });
      index.add({ ...old, key: 'old-other-chat', chat: 'other' });
      index.add({ ...old, key: 'old-other-account', account: 'app2' });
      const fromOld = await search.find({ q: '退款' }, session);
      expect(fromOld.hits.map((hit) => hit.id)).toEqual(['mine', 'old-mine']);
      const refOf = (key: string): string => result.hits[0]!.ref.replace('id=mine', 'id=' + key);
      const oldRead = await search.get({ ref: refOf('old-mine') }, session);
      expect(oldRead).toMatchObject({ anchor: { key: 'old-mine' }, after: [{ key: 'mine' }] });
      await expect(search.get({ ref: refOf('old-other-chat') }, session)).rejects.toThrow('找不到');
      await expect(search.get({ ref: refOf('old-other-account') }, session)).rejects.toThrow('找不到');

      //G 网页按人筛选即使指定了聊天，也没有锁定账号，空键的旧记录不会混进结果。
      const person = 'person:feishu:person';
      const dm = { ...anchor, chat: 'dm', chatType: 'p2p' };
      index.add({ ...dm, key: 'person-tagged', memoryKey: person });
      index.add({ ...dm, key: 'person-legacy', memoryKey: '' });
      const filtered = await search.find({ q: '退款', person, source: 'channel', channel: 'feishu', chat: 'dm' });
      expect(filtered.hits.map((hit) => hit.id)).toEqual(['person-tagged']);

      const request = { args: {}, session, signal: new AbortController().signal, callId: 'read' };
      await expect(search.readHistory({ ...request, route: 'front-search' })).rejects.toThrow('当前渠道聊天');
      await expect(search.readHistory({ ...request, route: 'wechat-archive' })).rejects.toThrow('当前渠道聊天');
    } finally {
      db.close();
    }
  });
}
