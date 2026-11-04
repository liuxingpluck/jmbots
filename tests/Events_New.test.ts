/**
 * 事件表四个新函数的离线测试（内存数据库）：数事件链步数、按领取人恢复中断、按渠道领下一条待办、
 * 同渠道同来源合批领取。另外验一下老库（没有 claimed_by 列）打开时能自动补列。
 */
import * as sqlite from 'bun:sqlite';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as events from '../src/events/Events.ts';


/**
 * 建一个测试会话。
 * @param store 数据库。
 */
function newSession(store: events.EventStore): string {
  return store.createSession({ title: '测试会话', kind: 'task', bot: null, agent: null, model: null, workspace: '', source: '命令行' }).id;
}


/**
 * 加一个事件（status 是 pending）。
 * @param store 数据库。
 * @param sessionId 会话 ID。
 * @param type 事件类型。
 * @param payload 事件内容。
 * @returns 事件 ID。
 */
function addEvent(store: events.EventStore, sessionId: string, type: string, payload: unknown): number {
  return store.createEvent({ sessionId, type, payload }).id;
}


bunTest.test('countSteps 只数 execution，别的类型和别的会话不算', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话 A。 */
  const sessionA = newSession(store);
  addEvent(store, sessionA, 'execution', { input: '第一步' });
  addEvent(store, sessionA, 'execution', { input: '第二步' });
  addEvent(store, sessionA, 'message', { text: '你好' });
  addEvent(store, sessionA, 'dispatch', { bot: '小灵' });
  /** 会话 B：它的 execution 不能算进 A。 */
  const sessionB = newSession(store);
  addEvent(store, sessionB, 'execution', { input: '别的会话' });
  bunTest.expect(store.countSteps(sessionA)).toBe(2);
  bunTest.expect(store.countSteps(sessionB)).toBe(1);
  bunTest.expect(store.countSteps('查无此会话')).toBe(0);
  store.close();
});


bunTest.test('recoverOwned 只把自己领的改回 pending，别人领的还是 running', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话。 */
  const sessionId = newSession(store);
  /** A 进程要领的那条。 */
  const first = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_1', text: '一' });
  /** B 进程要领的那条。 */
  const second = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_2', text: '二' });
  bunTest.expect(store.claimNext('飞书', '进程A')?.id).toBe(first);
  bunTest.expect(store.claimNext('飞书', '进程B')?.id).toBe(second);
  // 只收 A 的：B 领的那条一条不许碰。
  bunTest.expect(store.recoverOwned('进程A')).toBe(1);
  bunTest.expect(store.getEvent(first)?.status).toBe('pending');
  bunTest.expect(store.getEvent(second)?.status).toBe('running');
  bunTest.expect(store.getEvent(second)?.claimedBy).toBe('进程B');
  // A 已经收完了，再收一次是 0。
  bunTest.expect(store.recoverOwned('进程A')).toBe(0);
  // 没人领的 running（老数据、别的进程没收）也不碰。
  const orphan = addEvent(store, sessionId, 'execution', { input: '孤儿' });
  store.setEventStatus(orphan, 'running');
  bunTest.expect(store.recoverOwned('进程A')).toBe(0);
  bunTest.expect(store.getEvent(orphan)?.status).toBe('running');
  // 收回 pending 的那条能被重新领到。
  bunTest.expect(store.claimNext('飞书', '进程A')?.id).toBe(first);
  bunTest.expect(store.getEvent(first)?.status).toBe('running');
  bunTest.expect(store.getEvent(first)?.claimedBy).toBe('进程A');
  store.close();
});


bunTest.test('claimNext 按时间领最早的，领过的不再领，没写渠道的不领，不同渠道各领各的', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话。 */
  const sessionId = newSession(store);
  // 先建别的渠道：证明不是全局按 ID 取最老的。
  const httpEvent = addEvent(store, sessionId, 'message', { channel: 'http', sourceId: 'web_1', text: '网页' });
  // 没写 channel 的：任何渠道都不领。
  const noChannel = addEvent(store, sessionId, 'message', { sourceId: '未知', text: '没写渠道' });
  /** 飞书第一条。 */
  const feishuFirst = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_1', text: '一' });
  /** 飞书第二条。 */
  const feishuSecond = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_2', text: '二' });
  bunTest.expect(store.claimNext('飞书', '进程A')?.id).toBe(feishuFirst);
  bunTest.expect(store.getEvent(feishuFirst)?.status).toBe('running');
  bunTest.expect(store.getEvent(feishuFirst)?.claimedBy).toBe('进程A');
  bunTest.expect(store.claimNext('飞书', '进程A')?.id).toBe(feishuSecond);
  bunTest.expect(store.claimNext('飞书', '进程A')).toBeUndefined();
  // 没写 channel 的那条谁都领不到。
  bunTest.expect(store.claimNext('命令行', '进程A')).toBeUndefined();
  bunTest.expect(store.getEvent(noChannel)?.status).toBe('pending');
  // 别的渠道领自己的。
  bunTest.expect(store.claimNext('http', '进程A')?.id).toBe(httpEvent);
  store.close();
});


bunTest.test('claimSameSource 同渠道同来源的 message 一起领走，别的来源渠道类型不混进来', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话。 */
  const sessionId = newSession(store);
  /** 要合批的第一条。 */
  const first = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_1', text: '一' });
  // 下面这些都不该被这一批领走。
  const otherChannel = addEvent(store, sessionId, 'message', { channel: 'http', sourceId: 'ou_1', text: '别的渠道' });
  const otherSource = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_2', text: '别的来源' });
  const execution = addEvent(store, sessionId, 'execution', { channel: '飞书', sourceId: 'ou_1', input: '干活' });
  const noChannel = addEvent(store, sessionId, 'message', { sourceId: 'ou_1', text: '没写渠道' });
  /** 要合批的第二条。 */
  const second = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_1', text: '二' });
  /** 领到的一批。 */
  const batch = store.claimSameSource('飞书', 'ou_1', '接话执行器');
  bunTest.expect(batch.map((row) => row.id)).toEqual([first, second]);
  bunTest.expect(batch.every((row) => row.type === 'message' && row.status === 'running' && row.claimedBy === '接话执行器')).toBe(true);
  // 领过一次的不再领。
  bunTest.expect(store.claimSameSource('飞书', 'ou_1', '接话执行器')).toEqual([]);
  // 别的来源、别的渠道、别的类型、没写渠道的都还在 pending。
  bunTest.expect(store.getEvent(otherChannel)?.status).toBe('pending');
  bunTest.expect(store.getEvent(otherSource)?.status).toBe('pending');
  bunTest.expect(store.getEvent(execution)?.status).toBe('pending');
  bunTest.expect(store.getEvent(noChannel)?.status).toBe('pending');
  store.close();
});


bunTest.test('老库没有 claimed_by 列时，打开会自动补列，领事件正常', () => {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-events-'));
  /** 老库文件路径。 */
  const dbFile = path.join(dir, 'old.db');
  try {
    // 照改造前的建表方式建一个没有 claimed_by 列的事件表。
    const old = new sqlite.Database(dbFile, { create: true });
    old.exec(`
      CREATE TABLE jmbot_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        parent_id INTEGER, type TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    old.close();
    /** 在老库上打开的数据库。 */
    const store = events.openEventStore(dbFile);
    try {
      /** 会话。 */
      const sessionId = newSession(store);
      /** 要领的那条。 */
      const eventId = addEvent(store, sessionId, 'message', { channel: '飞书', sourceId: 'ou_1', text: '老库来的' });
      bunTest.expect(store.claimNext('飞书', '进程A')?.id).toBe(eventId);
      bunTest.expect(store.getEvent(eventId)?.claimedBy).toBe('进程A');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('finishStep：先插下一步再标完，会话在步与步之间不会被当成做完了', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话。 */
  const sessionId = newSession(store);
  /** 第一步。 */
  const first = store.createEvent({ sessionId, type: 'execution', payload: { step: 1 } });
  store.claimNextExecution(sessionId, 'serve@30086');
  bunTest.expect(store.hasUnfinished(sessionId)).toBe(true);

  //M 这一步做完、接着下一步：中间不能出现"这个会话没有没做完的事"。
  /** 插好的下一步。 */
  const created = store.finishStep(first.id, 'completed', [{ sessionId, type: 'execution', payload: { step: 2 } }]);
  bunTest.expect(created).toHaveLength(1);
  bunTest.expect(created[0]?.status).toBe('pending');
  //G 下一步的 parentId 要指回这一步，事件链才连得起来。
  bunTest.expect(created[0]?.parentId).toBe(first.id);
  bunTest.expect(store.getEvent(first.id)?.status).toBe('completed');
  //G 关键：做完第一步之后这个会话仍然"有没做完的事"，waitIdle 不会提前返回。
  bunTest.expect(store.hasUnfinished(sessionId)).toBe(true);

  //M 整条链到此为止：不给下一步，这时才算做完。
  store.finishStep(created[0]?.id ?? 0, 'completed');
  bunTest.expect(store.hasUnfinished(sessionId)).toBe(false);
  //G 事件链走了两步。
  bunTest.expect(store.countSteps(sessionId)).toBe(2);
  store.close();
});
