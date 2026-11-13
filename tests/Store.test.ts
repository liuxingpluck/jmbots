/**
 * 数据库（src/capabilities/Store.ts）的离线测试，用内存数据库：
 * 合批领消息的时机、排队和收走、开始和结束一次运行（刚要结束时正好来了一条）、打断、重启收拾。
 */
import * as bunTest from 'bun:test';
import * as store from '../src/capabilities/Store.ts';


/**
 * 记一条收件。
 * @param db 数据库。
 * @param source 来源。
 * @param text 原话。
 * @returns 新的一行。
 */
function add(db: store.Store, source: string, text: string): store.MessageRow {
  return db.addMessage({ bot: '周小灵', channel: 'http', source, address: {}, file: `F:/x/${text}.md`, text });
}


bunTest.describe('合批领消息', () => {
  bunTest.test('最后一条到了以后静够 mergeMs 才领，同一来源的一起领走', () => {
    const db = new store.Store(':memory:');
    const first = add(db, '甲', '一');
    const second = add(db, '甲', '二');
    const now = second.createdAt;
    bunTest.expect(db.takeNewBatch('周小灵', 2000, now + 1000)).toEqual([]);
    const batch = db.takeNewBatch('周小灵', 2000, now + 2000);
    bunTest.expect(batch.map((row) => row.id)).toEqual([first.id, second.id]);
    bunTest.expect(batch.every((row) => row.status === 'dispatching')).toBe(true);
    bunTest.expect(db.takeNewBatch('周小灵', 2000, now + 5000)).toEqual([]);
  });

  bunTest.test('一直在来，最早那条最多等 10 秒；别的来源不受影响', () => {
    const db = new store.Store(':memory:');
    const first = add(db, '甲', '一');
    add(db, '乙', '二');
    const batch = db.takeNewBatch('周小灵', 60_000, first.createdAt + 10_000);
    bunTest.expect(batch.map((row) => row.source)).toEqual(['甲']);
    bunTest.expect(db.takeNewBatch('周小灵', 60_000, first.createdAt + 11_000).map((row) => row.source)).toEqual(['乙']);
  });

  bunTest.test('merge_ms 为 0 时马上领；别的机器人的不领', () => {
    const db = new store.Store(':memory:');
    add(db, '甲', '一');
    db.addMessage({ bot: '别的', channel: 'http', source: '甲', address: {}, file: 'F:/x/y.md', text: '别的' });
    bunTest.expect(db.takeNewBatch('周小灵', 0).map((row) => row.text)).toEqual(['一']);
  });
});


bunTest.describe('会话：排队、收走、一次运行', () => {
  bunTest.test('queueMessages 后 takeQueued 按先后收走，只收一次', () => {
    const db = new store.Store(':memory:');
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '测试', model: 'm/a', thinking: null });
    const one = add(db, '甲', '一');
    const two = add(db, '甲', '二');
    db.queueMessages([one.id, two.id], session.id, { by: 'fallback' });
    bunTest.expect(db.getMessage(one.id)?.status).toBe('queued');
    bunTest.expect(db.getMessage(one.id)?.dispatch).toEqual({ by: 'fallback' });
    bunTest.expect(db.takeQueued(session.id).map((row) => row.text)).toEqual(['一', '二']);
    bunTest.expect(db.takeQueued(session.id)).toEqual([]);
    bunTest.expect(db.getMessage(two.id)?.status).toBe('taken');
  });

  bunTest.test('beginRun 同一时刻只让一个跑；endRun 遇到排队的话不结束', () => {
    const db = new store.Store(':memory:');
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '测试', model: 'm/a', thinking: null });
    bunTest.expect(db.beginRun(session.id)).toBe(true);
    bunTest.expect(db.beginRun(session.id)).toBe(false);
    const late = add(db, '甲', '刚要结束时来的');
    db.queueMessages([late.id], session.id, null);
    bunTest.expect(db.endRun(session.id, 'done')).toBe(false);
    bunTest.expect(db.getSession(session.id)?.status).toBe('running');
    db.takeQueued(session.id);
    bunTest.expect(db.endRun(session.id, 'done')).toBe(true);
    const ended = db.getSession(session.id)!;
    bunTest.expect(ended.status).toBe('idle');
    bunTest.expect(ended.runs).toHaveLength(1);
    bunTest.expect(ended.runs[0]!.ending).toBe('done');
    bunTest.expect(db.beginRun(session.id)).toBe(true);
    bunTest.expect(db.endRun(session.id, 'error')).toBe(true);
    bunTest.expect(db.getSession(session.id)?.status).toBe('error');
    bunTest.expect(db.beginRun(session.id)).toBe(true);
  });

  bunTest.test('takeInterrupt 读出来就清空', () => {
    const db = new store.Store(':memory:');
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '测试', model: 'm/a', thinking: null });
    db.updateSession(session.id, { interrupt: 12 });
    bunTest.expect(db.takeInterrupt(session.id)).toBe(12);
    bunTest.expect(db.takeInterrupt(session.id)).toBeNull();
  });

  bunTest.test('listSessions 按工作区、状态、关键字筛，最近的在前', async () => {
    const db = new store.Store(':memory:');
    const a = db.createSession({ bot: '周小灵', workspace: '日常', title: '看截图', model: 'm/a', thinking: null });
    await Bun.sleep(2);
    db.createSession({ bot: '周小灵', workspace: '代码', title: '改登录页', model: 'm/a', thinking: null });
    await Bun.sleep(2);
    db.updateSession(a.id, { summary: '登录页按钮被挡住' });
    bunTest.expect(db.listSessions('周小灵').map((row) => row.title)).toEqual(['看截图', '改登录页']);
    bunTest.expect(db.listSessions('周小灵', { workspace: '代码' }).map((row) => row.title)).toEqual(['改登录页']);
    bunTest.expect(db.listSessions('周小灵', { keyword: '登录' }).length).toBe(2);
    bunTest.expect(db.listSessions('别的')).toEqual([]);
  });
});


bunTest.describe('重启收拾', () => {
  bunTest.test('分派中和等审核的改回新到；运行中的会话改回空闲、那次运行记成出错；有排队消息的会话也要接着跑', () => {
    const db = new store.Store(':memory:');
    const message = add(db, '甲', '一');
    db.takeNewBatch('周小灵', 0);
    const running = db.createSession({ bot: '周小灵', workspace: '日常', title: '跑着的', model: 'm/a', thinking: null });
    db.beginRun(running.id);
    const waiting = db.createSession({ bot: '周小灵', workspace: '日常', title: '有排队的', model: 'm/a', thinking: null });
    const queued = add(db, '乙', '二');
    db.queueMessages([queued.id], waiting.id, null);
    //M 重启时等待审核的消息也要改回新到：待确认只在内存里，重启就没了，要重新分派。
    const held = add(db, '丙', '三');
    db.holdMessages([held.id], { by: 'llm' });
    const ids = db.recover();
    bunTest.expect(ids.sort()).toEqual([running.id, waiting.id].sort());
    bunTest.expect(db.getMessage(message.id)?.status).toBe('new');
    bunTest.expect(db.getMessage(held.id)?.status).toBe('new');
    const after = db.getSession(running.id)!;
    bunTest.expect(after.status).toBe('idle');
    bunTest.expect(after.runs[0]!.ending).toBe('error');
  });
});
