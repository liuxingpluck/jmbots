/** 用同一份内存库核对过渡期前台归档的编号、翻页、语义合并检索与外人/群聊隐私隔离。 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Session, Sessions } from '../../Sessions.ts';
import * as channelIndexModule from './ChannelIndex.ts';
import * as archiveModule from './FrontArchive.ts';
import type { MemoryService } from './index.ts';


test('往前翻页跨越新归档和 bot_log，排除已迁移的重复行和范围外记录', () => {
  const db = new Database(':memory:');
  try {
    //M 模拟停写后仍留在旧表的往来，以及一条不属于当前会话的记录。
    const legacy = `
      CREATE TABLE bot_log (
        id INTEGER PRIMARY KEY, bot TEXT, channel TEXT, who TEXT, sessionId TEXT, text TEXT, time INTEGER
      );
      INSERT INTO bot_log VALUES (31, '助手', 'http', 'user', '本场', '旧表开头', 1);
      INSERT INTO bot_log VALUES (32, '助手', 'http', 'bot', '本场', '已迁移的旧回话', 2);
      INSERT INTO bot_log VALUES (33, '助手', 'http', 'user', '本场', '旧表最后一条', 3);
      INSERT INTO bot_log VALUES (34, '助手', 'http', 'user', '另一场', '无权读取', 4);
    `;
    db.exec(legacy);
    const index = new channelIndexModule.ChannelIndex(db);
    const archive = new archiveModule.FrontArchive(db, index);

    //M 保留迁移那条的编号，再写一条新往来。
    const migrated: archiveModule.FrontMessage = {
      bot: '助手', channel: 'http', who: 'bot', sessionId: '本场', text: '已迁移的旧回话', time: 2,
    };
    archive.record(migrated, 32);
    const latest: archiveModule.FrontMessage = { ...migrated, text: '新归档', time: 5 };
    archive.record(latest);

    //M 第一页混合新旧记录，第二页用末条的编号向前翻。
    const query: archiveModule.FrontQuery = { bot: '助手', sessionIds: ['本场'], order: 'last', limit: 2 };
    const first = archive.read(query);
    expect(first.map(({ id, text }) => [id, text])).toEqual([[35, '新归档'], [33, '旧表最后一条']]);
    const before = first.at(-1)?.id;
    const next = archive.read({ ...query, before });
    expect(next.map(({ id, text }) => [id, text])).toEqual([[32, '已迁移的旧回话'], [31, '旧表开头']]);
  } finally {
    db.close();
  }
});


test('checkFrontAccess 拦截外人、非受信群聊与后台会话；searchFront 合并字面和语义命中并限制会话范围', async () => {
  const db = new Database(':memory:');
  try {
    const index = new channelIndexModule.ChannelIndex(db);
    const archive = new archiveModule.FrontArchive(db, index);
    const base: archiveModule.FrontMessage = {
      bot: '助手', channel: 'feishu', who: 'user', sessionId: 's1', text: '发票抬头用星河科技', time: 10,
    };
    archive.record(base, 1);
    archive.record({ ...base, who: 'bot', text: '周五前打款到账', time: 20 }, 2);
    archive.record({ ...base, sessionId: 'other', text: '别人前台的发票机密', time: 30 }, 3);

    const makeSession = (role: string, chatType: string, kind: 'front' | 'work', trusted = false): Session => {
      const address = { role, chatType, trusted };
      const snapshot = {
        channel: 'feishu', accountId: 'cli_a', chatId: 'oc_1', chatType, role, senderId: 'ou_1',
        origin: { channel: 'feishu', address },
      };
      const row = {
        id: 's1', bot: '助手', kind, messages: [], address, activeSourceSnapshot: snapshot,
      };
      return { id: 's1', row } as unknown as Session;
    };

    //G 外人、未受信群聊本人、后台会话均不可读前台归档编号；受信群本人与私聊本人可读。
    expect(() => archiveModule.checkFrontAccess(makeSession('guest', 'p2p', 'front'))).toThrow('当前渠道聊天');
    expect(() => archiveModule.checkFrontAccess(makeSession('owner', 'group', 'front', false))).toThrow('当前渠道聊天');
    expect(() => archiveModule.checkFrontAccess(makeSession('owner', 'p2p', 'work'))).toThrow('当前渠道聊天');
    const owner = makeSession('owner', 'p2p', 'front');
    expect(() => archiveModule.checkFrontAccess(owner)).not.toThrow();
    expect(() => archiveModule.checkFrontAccess(makeSession('owner', 'group', 'front', true))).not.toThrow();

    const sessions = { find: () => [] } as unknown as Sessions;
    const service = {
      embed: async (texts: string[]) => texts.map((item) => {
        if (item.includes('打款') || item.includes('汇款')) return [1, 0];

        return [0, 1];
      }),
    } as unknown as MemoryService;

    //M 关键词“发票”命中 #1，假向量使“发票汇款”在语义上也命中 #2，同时排除另一场会话的 #3。
    const page = await archive.searchFront(sessions, service, owner, { keyword: '发票' });
    expect(page).toContain('#1');
    expect(page).not.toContain('#3');
    const semanticPage = await archive.searchFront(sessions, service, owner, { keyword: '汇款' });
    expect(semanticPage).toContain('按相关程度');
    expect(semanticPage).toContain('#2');
    expect(semanticPage).not.toContain('#3');
    expect(archive.getFront(sessions, owner, 2)).toContain('周五前打款到账');
    expect(archive.getFront(sessions, owner, 3)).toContain('不属于这场对话');
  } finally {
    db.close();
  }
});
