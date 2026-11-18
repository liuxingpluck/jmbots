/** 用合成消息与内存库验证归属写入和旧段落统计。 */
import * as bunTest from 'bun:test';
import * as sqlite from 'bun:sqlite';
import type { SessionMeta } from '../../Sessions.ts';
import * as backfill from './ChannelBackfill.ts';
import * as migrate from './Backfill_Memory_Keys.ts';
import * as channel from './ChannelIndex.ts';
import * as stats from './Count_Memory_Keys.ts';
import * as keys from './MemoryKey.ts';


bunTest.test.each([
  { name: '本人在受信群', role: 'owner', trusted: true, full: true },
  { name: '本人在普通群', role: 'owner', trusted: false, full: false },
  { name: 'guest 在受信群', role: 'guest', trusted: true, full: false },
] as const)('$name 按来源判断私人记忆权限', ({ role, trusted, full }) => {
  const chatId = 'group-fixture';
  const address = { chatType: 'group', chatId, role, trusted, appId: 'app-fixture' };
  const row = { channel: 'feishu', address } as unknown as SessionMeta;
  const activeSourceSnapshot = {
    channel: 'feishu', chatType: 'group', chatId, accountId: 'app-fixture',
    senderId: 'sender-fixture', role, origin: { channel: 'feishu', address },
  };
  const withSnapshot = { ...row, activeSourceSnapshot } as unknown as SessionMeta;

  //M 存量地址和实时快照都遵守相同的受信群例外。
  const legacy = keys.getMemoryAccess(row);
  const current = keys.getMemoryAccess(withSnapshot);
  let expected: string | undefined;
  if (!full) {
    expected = `group:feishu:${chatId}`;
  }
  bunTest.expect(legacy).toMatchObject({ full });
  bunTest.expect(legacy.key).toBe(expected);
  bunTest.expect(current).toMatchObject({ full });
  bunTest.expect(current.key).toBe(expected);
});


bunTest.test('私聊、群聊和本机写入不同客户分区；群聊保留发言人', () => {
  const base = { key: 'test', channel: 'feishu', chat: 'chat-a', chatType: 'p2p', person: 'user-a' };
  const group = { ...base, chatType: 'group' };
  const local = { ...base, channel: 'http', chatType: 'local' };
  const personalKey = keys.getMemoryKey(base);
  const groupKey = keys.getMemoryKey(group);
  const ownerKey = keys.getMemoryKey(local);
  bunTest.expect(personalKey).toBe('person:feishu:user-a');
  bunTest.expect(groupKey).toBe('group:feishu:chat-a');
  bunTest.expect(ownerKey).toBe('owner');

  const row: channel.ChannelRow = {
    key: base.key, channel: base.channel, account: 'app-a', chat: base.chat, chatType: 'group',
    direction: 'user', senderId: base.person, senderName: '测试人', bot: '测试助手', text: '公开的话', at: 10,
    memoryKey: groupKey,
  };
  const doc = backfill.getChannelDoc(row);
  bunTest.expect(doc).toMatchObject({ customer: groupKey, session: personalKey, graph: false });
  const other = { ...row, senderId: 'user-b' };
  const second = backfill.getChannelDoc(other);
  bunTest.expect(second).toMatchObject({ customer: groupKey, session: 'person:feishu:user-b' });

  //M 旧行的重发分区保持一致，等待后续单独迁移。
  const legacy = { ...row, memoryKey: '' };
  const old = backfill.getChannelDoc(legacy);
  bunTest.expect(old.customer).toStartWith('jmbots-channel:group:');
  bunTest.expect(old.session).toBe(old.customer);
});


bunTest.test('补标先识别渠道和旧会话，写入同步索引、解绑旧图，反复运行无新改动', () => {
  const index = new sqlite.Database(':memory:');
  const store = new sqlite.Database(':memory:');
  try {
    const indexColumns = '(msg_key TEXT, channel TEXT, account TEXT, chat TEXT, chat_type TEXT,'
      + ' direction TEXT, sender_id TEXT, memory_key TEXT NOT NULL DEFAULT \'\')';
    index.exec(`CREATE TABLE memory_channel_messages ${indexColumns}`);
    index.exec("INSERT INTO memory_channel_messages VALUES ('msg-a', 'feishu', 'app-a', 'dm-a', 'p2p', 'user', 'a', '')");
    index.exec('CREATE TABLE sessions (id TEXT, meta TEXT)');
    const put = index.query('INSERT INTO sessions VALUES (?, ?)');
    put.run('known', JSON.stringify({ channel: 'feishu', address: { chatType: 'group', chatId: 'g' } }));
    put.run('unknown', JSON.stringify({ channel: 'feishu', address: { openId: 'last-speaker' } }));

    store.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, source TEXT, scope TEXT, customer TEXT, graph INTEGER)');
    store.exec('CREATE TABLE rel_docs (doc INTEGER, relation INTEGER)');
    store.exec('CREATE TABLE relations (id INTEGER, subj INTEGER, obj INTEGER)');
    store.exec('CREATE TABLE entities (id INTEGER)');
    const doc = store.query('INSERT INTO docs VALUES (?, ?, ?, ?, ?)');
    doc.run(1, `${channel.CHANNEL_PARTITION}msg-a`, 'history', 'legacy-a', 3);
    doc.run(2, 'bot-log:known', 'history', 'feishu:group:g', 1);
    doc.run(3, 'session:unknown', 'history', 'legacy-unknown', 1);
    store.exec('INSERT INTO rel_docs VALUES (2, 8), (3, 9)');
    store.exec('INSERT INTO relations VALUES (8, 1, 2), (9, 2, 3)');
    store.exec('INSERT INTO entities VALUES (1), (2), (3)');

    const plans: stats.KeyCandidate[] = [];
    const report = stats.countMemoryKeys(store, index, (item) => plans.push(item));
    bunTest.expect(report.recoverable).toBe(2);
    bunTest.expect(report.reasons.outsideChannelIndex).toBe(1);
    bunTest.expect(plans.map((item) => item.key)).toEqual(['person:feishu:a', 'group:feishu:g']);
    const sql = 'SELECT customer, graph FROM docs ORDER BY id';
    bunTest.expect(store.query(sql).all()).toContainEqual({ customer: 'feishu:group:g', graph: 1 });

    //M 给写入连接附一个合成主库；没有正式文件参与读写。
    store.exec("ATTACH DATABASE ':memory:' AS app_index");
    store.exec('CREATE TABLE app_index.memory_channel_messages (msg_key TEXT, memory_key TEXT)');
    store.exec("INSERT INTO app_index.memory_channel_messages VALUES ('msg-a', '')");
    const applied = migrate.applyMemoryKeys(store, plans);
    bunTest.expect(applied).toEqual({ moved: 2, conflicts: 0 });
    bunTest.expect(store.query(sql).all()).toEqual([
      { customer: 'person:feishu:a', graph: 3 },
      { customer: 'group:feishu:g', graph: 0 },
      { customer: 'legacy-unknown', graph: 1 },
    ]);
    bunTest.expect(store.query('SELECT memory_key FROM app_index.memory_channel_messages').get())
      .toEqual({ memory_key: 'person:feishu:a' });
    bunTest.expect(store.query('SELECT * FROM rel_docs').all()).toEqual([{ doc: 3, relation: 9 }]);
    bunTest.expect(store.query('SELECT id FROM entities ORDER BY id').all()).toEqual([{ id: 2 }, { id: 3 }]);

    const next: stats.KeyCandidate[] = [];
    stats.countMemoryKeys(store, index, (item) => next.push(item));
    bunTest.expect(next).toEqual([]);
  } finally {
    store.close();
    index.close();
  }
});


bunTest.test('只读统计能恢复旧归属，缺少或歧义的来源只计原因', () => {
  const index = new sqlite.Database(':memory:');
  const store = new sqlite.Database(':memory:');
  try {
    //M 主库模拟未升级的表，Rust 模拟存量段落；两边都没有正文。
    const indexTable = 'CREATE TABLE memory_channel_messages (msg_key TEXT, channel TEXT, account TEXT, chat TEXT,'
      + ' chat_type TEXT, direction TEXT, sender_id TEXT)';
    index.exec(indexTable);
    const insertRow = index.query('INSERT INTO memory_channel_messages VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertRow.run('dm', 'feishu', 'app-a', 'dm-a', 'p2p', 'user', 'user-a');
    insertRow.run('reply', 'feishu', 'app-a', 'dm-a', 'p2p', 'bot', 'test-bot');
    insertRow.run('unclear-reply', 'feishu', 'app-a', 'dm-b', 'p2p', 'bot', 'test-bot');
    insertRow.run('u1', 'feishu', 'app-a', 'dm-b', 'p2p', 'user', 'user-a');
    insertRow.run('u2', 'feishu', 'app-a', 'dm-b', 'p2p', 'user', 'user-b');
    insertRow.run('unknown', 'feishu', 'app-a', 'unknown', '', 'user', '');
    store.exec('CREATE TABLE docs (source TEXT, scope TEXT, customer TEXT)');
    const insertDoc = store.query('INSERT INTO docs VALUES (?, ?, ?)');
    const prefix = channel.CHANNEL_PARTITION;
    insertDoc.run(`${prefix}dm`, 'history', 'old-private');
    insertDoc.run(`${prefix}reply`, 'history', 'old-private');
    insertDoc.run(`${prefix}unclear-reply`, 'history', 'old-private');
    insertDoc.run(`${prefix}unknown`, 'history', 'old-unknown');
    insertDoc.run(`${prefix}missing`, 'history', 'old-unknown');
    insertDoc.run(`${prefix}fresh`, 'history', 'group:feishu:group-a');
    insertDoc.run('session:other', 'history', 'old-unbounded');
    insertDoc.run('sample.md', 'knowledge', '');

    const result = stats.countMemoryKeys(store, index);
    bunTest.expect(result).toEqual({
      total: 8,
      tagged: 1,
      recoverable: 2,
      reasons: {
        unowned: 1, outsideChannelIndex: 1, missingIndexRow: 1, ambiguousPerson: 1,
        missingPerson: 0, missingChat: 0, missingChannel: 0, unknownChatType: 1,
      },
    });
  } finally {
    index.close();
    store.close();
  }
});
