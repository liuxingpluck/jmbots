/** db 插件用同一份内存 SQLite 验证迁移记录和事务回滚。 */
import { expect, test } from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import * as dbPlugin from './index.ts';
import * as schema from './Schema.ts';


/** 写入能重复出现的值，借行数验证迁移没有重复执行。 */
const sample = sqliteCore.sqliteTable('migration_sample', {
  item: sqliteCore.text('item').notNull(),
});
const plan: dbPlugin.MigrationPlan = {
  plugin: 'sample',
  migrations: [
    { version: 1, sql: 'CREATE TABLE migration_sample (item TEXT NOT NULL);' },
    { version: 2, sql: "INSERT INTO migration_sample VALUES ('基线');" },
  ],
};


/** 仅给 db 插件提供 Resources 的同一份连接。 */
async function world(client = new sqlite.Database(':memory:')): Promise<{ ctx: cordis.Context; client: sqlite.Database }> {
  const ctx = new cordis.Context();

  //M 同时用原生与 Drizzle 接口访问，核对服务没有另开一份库。
  ctx.provide('resources', { db: client });
  await ctx.plugin(dbPlugin);
  return { ctx, client };
}


test('按序应用各版本，重新挂载后沿用同一连接和迁移记录', async () => {
  const { ctx, client } = await world();
  try {
    expect(ctx.db.orm.$client).toBe(client);
    ctx.db.migrate(plan);

    //M 另挂一个 db 实例，复用原连接，确认幂等由账本保证。
    const restarted = await world(client);
    try {
      const db = restarted.ctx.db;
      db.migrate(plan);
      const rows = db.orm.select().from(sample).all();
      expect(rows).toEqual([{ item: '基线' }]);
      const table = schema.dbMigrations;
      const applied = db.orm.select().from(table).orderBy(table.version).all();
      expect(applied).toMatchObject([
        { plugin: 'sample', version: 1 },
        { plugin: 'sample', version: 2 },
      ]);
    } finally {
      await restarted.ctx.fiber.dispose();
    }
  } finally {
    await ctx.fiber.dispose();
    client.close();
  }
});


test('事务回调抛错后回滚，原连接仍可继续写入', async () => {
  const { ctx, client } = await world();
  try {
    ctx.db.migrate(plan);
    const expected = new Error('合成事务失败');
    const aborted = (): void => ctx.db.transaction((tx) => {
      const entry = { item: '应回滚' };
      tx.insert(sample).values(entry).run();
      throw expected;
    });
    expect(aborted).toThrow(expected);
    const after = ctx.db.orm.select().from(sample).all();
    expect(after).toEqual([{ item: '基线' }]);

    //M 回滚后仍能用原连接提交新事务。
    const keep = { item: '已提交' };
    ctx.db.transaction((tx) => {
      tx.insert(sample).values(keep).run();
    });
    const seen = ctx.db.orm.select().from(sample).all();
    expect(seen).toEqual([{ item: '基线' }, keep]);
  } finally {
    await ctx.fiber.dispose();
    client.close();
  }
});
