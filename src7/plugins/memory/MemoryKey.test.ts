/** 用合成消息与内存库验证归属写入和旧段落统计。 */
import * as bunTest from 'bun:test';
import * as sqlite from 'bun:sqlite';
import type { SessionMeta } from '../../Sessions.ts';
import * as backfill from './ChannelBackfill.ts';
import * as migrate from '../../../ztools/memory/Backfill_Memory_Keys.ts';
import * as channel from './ChannelIndex.ts';
import * as stats from '../../../ztools/memory/Count_Memory_Keys.ts';
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


/** 建立可随 Rust 库一同提交或回滚的合成主库。 */
function attachIndex(store: sqlite.Database): void {
  //M 只保留归属和队列需要的字段，不连接正式库。
  store.exec("ATTACH DATABASE ':memory:' AS app_index");
  const sql = 'CREATE TABLE app_index.memory_channel_messages (msg_key TEXT PRIMARY KEY, channel TEXT,'
    + ' account TEXT, chat TEXT, chat_type TEXT, direction TEXT, sender_id TEXT, memory_key TEXT, rust_state INTEGER)';
  store.exec(sql);
}


/** 建立测试迁移事务所需的段落和关系表。 */
function createDocuments(store: sqlite.Database): void {
  //M 测试只写合成段落的来源、归属和关系编号。
  store.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, source TEXT, scope TEXT, customer TEXT, graph INTEGER)');
  store.exec('CREATE TABLE rel_docs (doc INTEGER, relation INTEGER)');
  store.exec('CREATE TABLE relations (id INTEGER, subj INTEGER, obj INTEGER)');
  store.exec('CREATE TABLE entities (id INTEGER)');
}


bunTest.test('补空键渠道索引与旧段落，Rust 已有副本只协调一次，重跑没有新改动', () => {
  const store = new sqlite.Database(':memory:');
  try {
    attachIndex(store);
    createDocuments(store);

    //M 带 Rust 副本的空键、仅在主库的空键和已补键各用独立的消息键。
    const rowSql = 'INSERT INTO app_index.memory_channel_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const row = store.query(rowSql);
    row.run('dm', 'feishu', 'app-a', 'dm-a', 'p2p', 'user', 'a', '', 1);
    row.run('reply', 'feishu', 'app-a', 'dm-a', 'p2p', 'bot', 'bot-a', '', 0);
    row.run('other-app', 'feishu', 'app-b', 'dm-a', 'p2p', 'user', 'b', 'person:feishu:b', 2);
    row.run('group', 'feishu', 'app-a', 'g', 'group', 'user', 'b', '', 2);
    row.run('wechat', 'wechat', 'wx-a', 'wx-peer', 'p2p', 'bot', 'self', '', 0);
    row.run('local', 'http', 'local', 'http:local', 'local', 'bot', '', '', 1);
    row.run('unknown', 'feishu', 'app-a', 'unknown', '', 'user', 'a', '', 0);
    row.run('missing', 'feishu', 'app-c', 'dm-a', 'p2p', 'bot', 'bot-a', '', 0);
    row.run('ambiguous', 'feishu', 'app-a', 'dm-b', 'p2p', 'bot', 'bot-a', '', 0);
    row.run('peer-a', 'feishu', 'app-a', 'dm-b', 'p2p', 'user', 'a', 'person:feishu:a', 2);
    row.run('peer-b', 'feishu', 'app-a', 'dm-b', 'p2p', 'user', 'b', 'person:feishu:b', 2);
    row.run('tagged-copy', 'feishu', 'app-a', 'g', 'group', 'user', 'a', '', 0);
    row.run('duplicate', 'feishu', 'app-a', 'g', 'group', 'user', 'a', '', 0);
    row.run('conflict', 'feishu', 'app-a', 'g', 'group', 'user', 'a', '', 0);
    row.run('prior-index', 'feishu', 'app-a', 'g', 'group', 'bot', 'bot-a', 'group:feishu:g', 0);

    //M 会话来源继续走原有归属补写和关系解绑。
    store.exec('CREATE TABLE app_index.sessions (id TEXT, meta TEXT)');
    const put = store.query('INSERT INTO app_index.sessions VALUES (?, ?)');
    const known = JSON.stringify({ channel: 'feishu', address: { chatType: 'group', chatId: 'g' } });
    const unknown = JSON.stringify({ channel: 'feishu', address: { openId: 'last-speaker' } });
    put.run('known', known);
    put.run('unknown', unknown);
    const doc = store.query('INSERT INTO docs VALUES (?, ?, ?, ?, ?)');
    const prefix = channel.CHANNEL_PARTITION;
    doc.run(1, `${prefix}dm`, 'history', 'legacy-a', 3);
    doc.run(2, 'bot-log:known', 'history', 'feishu:group:g', 1);
    doc.run(3, 'session:unknown', 'history', 'legacy-unknown', 1);
    doc.run(4, `${prefix}tagged-copy`, 'history', 'group:feishu:g', 3);
    doc.run(5, `${prefix}duplicate`, 'history', 'legacy-g', 3);
    doc.run(6, `${prefix}duplicate`, 'history', 'group:feishu:g', 3);
    doc.run(7, `${prefix}conflict`, 'history', 'group:feishu:other', 3);
    doc.run(8, `${prefix}prior-index`, 'history', 'legacy-g', 3);
    store.exec('INSERT INTO rel_docs VALUES (2, 8), (3, 9)');
    store.exec('INSERT INTO relations VALUES (8, 1, 2), (9, 2, 3)');
    store.exec('INSERT INTO entities VALUES (1), (2), (3)');

    //M 预览只收候选和原因，原有空键和状态仍可读到。
    const candidates = new Map<string, string>();
    const collect = (messageKey: string, key: string): void => {
      candidates.set(messageKey, key);
    };
    const preview = stats.countChannelKeys(store, collect, 'app_index');
    bunTest.expect(preview).toEqual({
      empty: 11,
      recoverable: 8,
      reasons: { ambiguousPerson: 1, missingPerson: 1, missingChat: 0, missingChannel: 0, unknownChatType: 1 },
    });
    bunTest.expect(candidates.get('reply')).toBe('person:feishu:a');
    const indexSql = 'SELECT memory_key, rust_state FROM app_index.memory_channel_messages WHERE msg_key = ?';
    const index = store.query(indexSql);
    bunTest.expect(index.get('dm')).toEqual({ memory_key: '', rust_state: 1 });

    //M 核对实际补键、原有队列状态，以及无需重送的 Rust 副本。
    const applied = migrate.applyMemoryKeys(store);
    bunTest.expect(applied).toEqual({
      moved: 3, indexed: 6, confirmedCopies: 3, conflicts: 0,
      channelConflicts: { duplicateCopies: 1, differentScope: 0, differentOwner: 1, changedIndex: 0 },
    });
    bunTest.expect(index.get('dm')).toEqual({ memory_key: 'person:feishu:a', rust_state: 2 });
    bunTest.expect(index.get('reply')).toEqual({ memory_key: 'person:feishu:a', rust_state: 0 });
    bunTest.expect(index.get('group')).toEqual({ memory_key: 'group:feishu:g', rust_state: 2 });
    bunTest.expect(index.get('wechat')).toEqual({ memory_key: 'person:wechat:wx-peer', rust_state: 0 });
    bunTest.expect(index.get('local')).toEqual({ memory_key: 'owner', rust_state: 1 });
    bunTest.expect(index.get('tagged-copy')).toEqual({ memory_key: 'group:feishu:g', rust_state: 2 });
    bunTest.expect(index.get('prior-index')).toEqual({ memory_key: 'group:feishu:g', rust_state: 2 });
    bunTest.expect(index.get('other-app')).toEqual({ memory_key: 'person:feishu:b', rust_state: 2 });
    for (const messageKey of ['unknown', 'missing', 'ambiguous', 'duplicate', 'conflict']) {
      bunTest.expect(index.get(messageKey)).toEqual({ memory_key: '', rust_state: 0 });
    }
    const docSql = 'SELECT customer, graph FROM docs WHERE id = ?';
    const saved = store.query(docSql);
    bunTest.expect(saved.get(1)).toEqual({ customer: 'person:feishu:a', graph: 3 });
    bunTest.expect(saved.get(2)).toEqual({ customer: 'group:feishu:g', graph: 0 });
    bunTest.expect(saved.get(3)).toEqual({ customer: 'legacy-unknown', graph: 1 });
    bunTest.expect(saved.get(5)).toEqual({ customer: 'legacy-g', graph: 3 });
    bunTest.expect(saved.get(7)).toEqual({ customer: 'group:feishu:other', graph: 3 });
    bunTest.expect(store.query('SELECT COUNT(*) AS n FROM docs').get()).toEqual({ n: 8 });
    const queuedSql = 'SELECT COUNT(*) AS n FROM app_index.memory_channel_messages WHERE msg_key = ? AND rust_state < 2';
    bunTest.expect(store.query(queuedSql).get('dm')).toEqual({ n: 0 });
    bunTest.expect(store.query('SELECT * FROM rel_docs').all()).toEqual([{ doc: 3, relation: 9 }]);
    bunTest.expect(store.query('SELECT id FROM entities ORDER BY id').all()).toEqual([{ id: 2 }, { id: 3 }]);

    //M 重跑仅报告原来保留的冲突，新旧库均无再次改动。
    const next = migrate.applyMemoryKeys(store);
    bunTest.expect(next).toEqual({ ...applied, moved: 0, indexed: 0, confirmedCopies: 0 });
  } finally {
    store.close();
  }
});


bunTest.test('渠道索引写入途中出错时，两库和关系挂接一起回滚', () => {
  const store = new sqlite.Database(':memory:');
  try {
    attachIndex(store);
    createDocuments(store);

    //M 两条渠道索引各有一个待补归属的 Rust 段落。
    const rowSql = 'INSERT INTO app_index.memory_channel_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const row = store.query(rowSql);
    row.run('first', 'feishu', 'app-a', 'g', 'group', 'user', 'a', '', 0);
    row.run('second', 'feishu', 'app-a', 'g', 'group', 'user', 'a', '', 1);
    const doc = store.query('INSERT INTO docs VALUES (?, ?, ?, ?, ?)');
    const prefix = channel.CHANNEL_PARTITION;
    doc.run(1, `${prefix}first`, 'history', 'legacy', 1);
    doc.run(2, `${prefix}second`, 'history', 'legacy', 1);
    store.exec('INSERT INTO rel_docs VALUES (1, 8), (2, 8)');
    store.exec('INSERT INTO relations VALUES (8, 1, 2)');
    store.exec('INSERT INTO entities VALUES (1), (2)');
    const fail = 'CREATE TRIGGER app_index.fail_second BEFORE UPDATE ON memory_channel_messages'
      + ' WHEN EXISTS'
      + ' (SELECT 1 FROM memory_channel_messages WHERE msg_key <> OLD.msg_key AND rust_state = 2)'
      + " BEGIN SELECT RAISE(ABORT, '合成约束错误'); END";
    store.exec(fail);

    //M 触发器仅在第一条索引确已写入时抛错，验证此前的所有改动都撤销。
    bunTest.expect(() => migrate.applyMemoryKeys(store)).toThrow('合成约束错误');
    const indexSql = 'SELECT memory_key, rust_state FROM app_index.memory_channel_messages ORDER BY msg_key';
    bunTest.expect(store.query(indexSql).all()).toEqual([
      { memory_key: '', rust_state: 0 },
      { memory_key: '', rust_state: 1 },
    ]);
    const docSql = 'SELECT customer, graph FROM docs ORDER BY id';
    bunTest.expect(store.query(docSql).all()).toEqual([
      { customer: 'legacy', graph: 1 },
      { customer: 'legacy', graph: 1 },
    ]);
    bunTest.expect(store.query('SELECT * FROM rel_docs ORDER BY doc').all())
      .toEqual([{ doc: 1, relation: 8 }, { doc: 2, relation: 8 }]);
    bunTest.expect(store.query('SELECT * FROM relations').all()).toEqual([{ id: 8, subj: 1, obj: 2 }]);
  } finally {
    store.close();
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


bunTest.test.each([
  { name: '本人私聊', role: 'owner', chatType: 'p2p', trusted: false, senderId: 'user-fixture', allowed: true },
  { name: '本人在受信群', role: 'owner', chatType: 'group', trusted: true, senderId: 'user-fixture', allowed: true },
  { name: '本人在普通群', role: 'owner', chatType: 'group', trusted: false, senderId: 'user-fixture', allowed: true },
  { name: '外人私聊', role: 'guest', chatType: 'p2p', trusted: false, senderId: 'user-fixture', allowed: true },
  { name: '外人私聊缺发话人', role: 'guest', chatType: 'p2p', trusted: false, senderId: '', allowed: false },
] as const)('$name：能不能查渠道消息只看 canQueryChannel', ({ role, chatType, trusted, senderId, allowed }) => {
  const chatId = 'chat-fixture';
  const address = { chatType, chatId, role, trusted, appId: 'app-fixture' };
  const activeSourceSnapshot = {
    channel: 'feishu', chatType, chatId, accountId: 'app-fixture',
    senderId, role, origin: { channel: 'feishu', address },
  };
  const row = { channel: 'feishu', address, activeSourceSnapshot } as unknown as SessionMeta;

  //M 召回、旧 memory 工具、统一检索和 getScope 共用这一个口径。
  const access = keys.getMemoryAccess(row);
  bunTest.expect(keys.canQueryChannel(access)).toBe(allowed);
});


bunTest.test('本机来源不是本人：快照带范围不带键，老会话什么都不给；本人老会话补本机聊天号', () => {
  const address = { role: 'guest' };
  const snapshot = {
    channel: 'http', chatType: 'local', chatId: 'http:本机', accountId: 'local',
    senderId: 'http:本机', role: 'guest', origin: { channel: 'http', address },
  };
  const withSnapshot = { channel: 'http', address, activeSourceSnapshot: snapshot } as unknown as SessionMeta;
  const legacy = { channel: 'http', address } as unknown as SessionMeta;
  const ownerLegacy = { channel: 'http', address: {} } as unknown as SessionMeta;

  //M 两种来源的交回形状原样保留，读不到 owner 记忆，也查不了渠道消息。
  const current = keys.getMemoryAccess(withSnapshot);
  bunTest.expect(current).toEqual({ full: false, channel: 'http', chat: 'http:本机', account: 'local' });
  bunTest.expect(keys.canQueryChannel(current)).toBe(false);
  bunTest.expect(keys.getMemoryAccess(legacy)).toEqual({ full: false });

  //M 没写档位的本机网页算本人：账号记 local，聊天号补成 http:本机。
  const owner = keys.getMemoryAccess(ownerLegacy);
  bunTest.expect(owner).toEqual({ full: true, channel: 'http', chat: 'http:本机', account: 'local' });
});
