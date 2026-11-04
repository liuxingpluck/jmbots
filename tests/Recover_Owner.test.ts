/**
 * 收拾残局只收拾自己领的：验证"服务一启动就把别的进程正在跑的执行收走重跑"这个老毛病已经修了。
 * 老毛病的现场：命令行 `run` 正在跑着，这时 serve 启动，旧的 recoverInterrupted 不分进程，
 * 把那条 running 的执行改回 pending，于是同一件事被重跑一遍。
 */
import * as bunTest from 'bun:test';
import * as events from '../src/events/Events.ts';


/**
 * 建一个测试会话。
 * @param store 数据库。
 * @returns 会话 ID。
 */
function newSession(store: events.EventStore): string {
  return store.createSession({ title: '测试会话', kind: 'task', bot: null, agent: null, model: null, workspace: '', source: '命令行' }).id;
}


bunTest.test('收拾残局：只收自己领的，别的进程正在跑的一条都不碰', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 服务那条会话。 */
  const mine = newSession(store);
  /** 命令行那条会话。 */
  const others = newSession(store);
  store.createEvent({ sessionId: mine, type: 'execution', payload: { input: '服务在跑的' } });
  store.createEvent({ sessionId: others, type: 'execution', payload: { input: '命令行在跑的' } });

  //M 两个进程各领走自己那条：领取时会盖上"谁领走的"章。
  //G 命令行那条**必须用一个真实活着的进程号**（就用本进程的），否则"进程没了就收下来"
  //  这条规则会正当地把它也收走，测不到"不抢别人活"这件事。
  /** 服务领走的。 */
  const claimedByServe = store.claimNextExecution(mine, 'serve@30086');
  /** 命令行领走的（活着的进程）。 */
  const claimedByCli = store.claimNextExecution(others, `cli#${process.pid}`);
  bunTest.expect(claimedByServe?.sessionId).toBe(mine);
  bunTest.expect(claimedByCli?.sessionId).toBe(others);
  bunTest.expect(claimedByServe?.claimedBy).toBe('serve@30086');
  bunTest.expect(claimedByCli?.claimedBy).toBe(`cli#${process.pid}`);

  //M 服务重启，收拾残局。
  /** 收拾结果。 */
  const recovered = store.recoverInterrupted('serve@30086');
  bunTest.expect(recovered.resumed).toBe(1);

  //G 自己那条改回 pending 等着重做。
  bunTest.expect(store.getEvent(claimedByServe?.id ?? 0)?.status).toBe('pending');
  //G 命令行那条必须还是 running——这就是修的那个毛病。
  bunTest.expect(store.getEvent(claimedByCli?.id ?? 0)?.status).toBe('running');
  store.close();
});


bunTest.test('收拾残局：升级前留下的没盖章的事件也收（claimedBy 是空的）', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话。 */
  const sessionId = newSession(store);
  store.createEvent({ sessionId, type: 'execution', payload: { input: '老版本留下的' } });
  //G 不传领取人去领，模拟升级前的旧数据：claimedBy 是空的。
  /** 领走的。 */
  const claimed = store.claimNextExecution(sessionId);
  bunTest.expect(claimed?.claimedBy).toBeNull();

  bunTest.expect(store.recoverInterrupted('serve@30086').resumed).toBe(1);
  bunTest.expect(store.getEvent(claimed?.id ?? 0)?.status).toBe('pending');
  store.close();
});


bunTest.test('收拾残局：领它的进程已经不在了，也要收（换版本后新服务进程号变了）', () => {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话。 */
  const sessionId = newSession(store);
  store.createEvent({ sessionId, type: 'execution', payload: { input: '旧服务在跑的' } });
  //G 用一个肯定不存在的进程号冒充"上一个服务"：换版本后旧进程已经被杀了。
  /** 领走的。 */
  const claimed = store.claimNextExecution(sessionId, 'cli#999999');
  bunTest.expect(claimed?.claimedBy).toBe('cli#999999');

  //M 新服务叫别的名字，但旧的那个进程已经不在，所以这条该收下来重做。
  bunTest.expect(store.recoverInterrupted('serve@30086').resumed).toBe(1);
  bunTest.expect(store.getEvent(claimed?.id ?? 0)?.status).toBe('pending');
  store.close();
});


bunTest.test('判活：带进程号的能判，按端口记的一律当还在', () => {
  //G 自己这个进程肯定活着。
  bunTest.expect(events.ownerAlive(`cli#${process.pid}`)).toBe(true);
  //G 不存在的进程号。
  bunTest.expect(events.ownerAlive('cli#999999')).toBe(false);
  //G serve@端口 里没有进程号，判不了，按"还在"算——宁可不收，也不要把别人正在跑的活抢走。
  bunTest.expect(events.ownerAlive('serve@30086')).toBe(true);
  bunTest.expect(events.ownerAlive(null)).toBe(true);
  //G 写坏的领取人也按"还在"算。
  bunTest.expect(events.ownerAlive('cli#不是数字')).toBe(true);
});


bunTest.test('该不该收：自己的、没盖章的、进程没了的都收；别人活着的不碰', () => {
  bunTest.expect(events.claimable(null, 'serve@30086')).toBe(true);
  bunTest.expect(events.claimable('serve@30086', 'serve@30086')).toBe(true);
  bunTest.expect(events.claimable('cli#999999', 'serve@30086')).toBe(true);
  //G 另一个还活着的进程（就用自己的进程号冒充）领的，一条都不许碰。
  bunTest.expect(events.claimable(`cli#${process.pid}`, 'serve@30086')).toBe(false);
  //G 另一个端口上的服务也不碰：判不了活，按还在算。
  bunTest.expect(events.claimable('serve@30087', 'serve@30086')).toBe(false);
});
