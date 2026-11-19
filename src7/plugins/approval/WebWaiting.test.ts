/** 网页待审核批次和溢出数量的 HTTP 回归。全程使用内存库和注入请求。 */
import * as bunTest from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as approvalModule from './index.ts';

bunTest.test('网页只取最早 200 条，仍显示最近提醒，处理后后续卡片补位', async () => {
  const ctx = new cordis.Context();
  const app = fastify.default();
  const db = new sqlite.Database(':memory:');
  ctx.provide('resources', { db, root: import.meta.dir, raw: {}, config: { providers: {} } });
  ctx.provide('bots', { list: () => [] });
  ctx.provide('sessions', { find: () => [] });
  ctx.provide('http', { app });
  try {
    await ctx.plugin(approvalModule, {});
    const addSql = `INSERT INTO approval_pending
      (kind, title, detail, payload, bot, asked_at, state, card, decided_at)
      VALUES ('exec', '样本', '', '{}', 'fixture', 0, ?, ?, ?)`;
    const add = db.query(addSql);
    for (let index = 0; index < 203; index += 1) {
      add.run('waiting', null, null);
    }
    const recent = JSON.stringify({ kind: 'long-run', state: 'approved' });
    add.run('approved', recent, Date.now());

    //M 轮询不改变数组契约，卡片按号保序并保留结束的长跑提醒。
    const first = await app.inject('/api/approvals');
    const visible = first.json<{ id: number }[]>();
    const ids = visible.map((item) => item.id);
    const expected = Array.from({ length: 200 }, (_, index) => index + 1);
    bunTest.expect(first.statusCode).toBe(200);
    bunTest.expect(ids).toEqual([...expected, 204]);
    bunTest.expect(ctx.approval.list()).toHaveLength(203);

    const overflow = await app.inject('/api/approvals/overflow');
    const count = overflow.json<{ count: number }>();
    bunTest.expect(count).toEqual({ count: 3 });

    //M 在内存中模拟前排三项已经处理，下一批含全部余下卡片。
    db.run("UPDATE approval_pending SET state = 'approved' WHERE id <= 3");
    const second = await app.inject('/api/approvals');
    const remaining = second.json<{ id: number }[]>();
    bunTest.expect(remaining).toHaveLength(201);
    bunTest.expect(remaining[0]?.id).toBe(4);
    bunTest.expect(remaining[199]?.id).toBe(203);
    const done = await app.inject('/api/approvals/overflow');
    bunTest.expect(done.json<{ count: number }>()).toEqual({ count: 0 });
  } finally {
    await ctx.fiber.dispose();
    await app.close();
    db.close();
  }
});
