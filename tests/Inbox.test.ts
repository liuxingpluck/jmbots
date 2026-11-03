/**
 * 收件表和重启收拾的离线测试（内存数据库）：同一来源连发的话合成一批领走、正在分派的来源不再领、
 * 要问用户的话只记在一批第一句上；重启时分派到一半的话改回未分派、被打断的执行重新排队、第 3 次打断和分派对话标成中断。
 */
import * as bunTest from 'bun:test';
import * as events from '../src/store/Events.ts';


/**
 * 建一个会话和它的一次执行，并把执行改成 running（模拟正在跑时被打断）。
 * @param store 数据库。
 * @param kind 会话种类。
 */
function runningExecution(store: events.EventStore, kind: 'task' | 'route'): { sessionId: string; eventId: number } {
  /** 会话 ID。 */
  const sessionId = store.createSession({ title: kind, kind, bot: null, agent: null, model: null, workspace: '', source: '飞书私聊 oc_a' }).id;
  /** 执行。 */
  const event = store.createEvent({ sessionId, type: 'execution', payload: { input: '做事' } });
  store.setEventStatus(event.id, 'running');
  return { sessionId, eventId: event.id };
}


bunTest.test('同一来源连发合成一批，正在分派的来源不再领', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  store.addInbox({ source: 'A', text: '一', idleHours: 6 });
  store.addInbox({ source: 'B', text: '乙', idleHours: 6 });
  store.addInbox({ source: 'A', text: '二', idleHours: 6 });
  /** 第一批：A 的两句。 */
  const first = store.claimInboxBatch();
  bunTest.expect(first.map((row) => row.text)).toEqual(['一', '二']);
  bunTest.expect(first.every((row) => row.batchId === first[0]?.id)).toBe(true);
  // A 正在分派，又来一句：先不领 A 的，领 B 的。
  store.addInbox({ source: 'A', text: '三', idleHours: 6 });
  bunTest.expect(store.claimInboxBatch().map((row) => row.text)).toEqual(['乙']);
  bunTest.expect(store.claimInboxBatch()).toEqual([]);
  // A 分派完，第三句才能领；要问用户的话只记在第一句上。
  store.finishInbox(first.map((row) => row.id), { result: { sessionIds: ['s1'], replies: ['问一句'], reason: '理由' } });
  bunTest.expect(store.getInbox(first[0]!.id)?.result?.replies).toEqual(['问一句']);
  bunTest.expect(store.getInbox(first[1]!.id)?.result?.replies).toEqual([]);
  bunTest.expect(store.claimInboxBatch().map((row) => row.text)).toEqual(['三']);
  store.close();
});


bunTest.test('写明交给谁的直接记成已分派，不会被领去分派', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  store.addInbox({ source: 'HTTP', text: '直接做', idleHours: 0, done: { sessionIds: ['s9'], replies: [], reason: '直接提交' } });
  bunTest.expect(store.claimInboxBatch()).toEqual([]);
  bunTest.expect(store.listInbox({ status: 'done' }).length).toBe(1);
  store.close();
});


bunTest.test('重启收拾：分派到一半的话重新分派，执行重新排队，第 3 次打断和分派对话标成中断', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  store.addInbox({ source: 'A', text: '一', idleHours: 6 });
  store.claimInboxBatch();
  /** 执行对话里被打断的。 */
  const task = runningExecution(store, 'task');
  /** 分派对话里被打断的。 */
  const route = runningExecution(store, 'route');
  bunTest.expect(store.recoverInterrupted()).toEqual({ resumed: 1, failed: 1, inbox: 1 });
  bunTest.expect(store.claimInboxBatch().length).toBe(1);
  bunTest.expect(store.listEvents(task.sessionId, 'execution')[0]?.status).toBe('pending');
  bunTest.expect(store.listEvents(route.sessionId, 'execution')[0]?.status).toBe('failed');
  // 同一个执行再被打断两次：第 3 次不再接着。
  store.setEventStatus(task.eventId, 'running');
  bunTest.expect(store.recoverInterrupted().resumed).toBe(1);
  store.setEventStatus(task.eventId, 'running');
  bunTest.expect(store.recoverInterrupted().failed).toBe(1);
  bunTest.expect(store.getSession(task.sessionId)?.status).toBe('出错');
  store.close();
});
