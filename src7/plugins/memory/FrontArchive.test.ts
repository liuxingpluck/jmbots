/** 用同一份内存库核对过渡期前台归档的编号和翻页。 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as channelIndexModule from './ChannelIndex.ts';
import * as archiveModule from './FrontArchive.ts';


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
