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


/**
 * 一段里写了多条语句（不写 --> statement-breakpoint），交给迁移后建出了哪些表。
 * @param sql 迁移第 1 版的 SQL。
 * @returns 连接、建出的表名（按名字排）。
 */
async function migrateOne(sql: string): Promise<{ client: sqlite.Database; tables: string[]; close: () => Promise<void> }> {
  const { ctx, client } = await world();
  ctx.db.migrate({ plugin: 'multi', migrations: [{ version: 1, sql }] });
  const query = "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'm\\_%' ESCAPE '\\' ORDER BY name";
  const tables = client.query<{ name: string }, []>(query).all().map((row) => row.name);
  const close = async (): Promise<void> => {
    await ctx.fiber.dispose();
    client.close();
  };
  return { client, tables, close };
}


test('一段多条语句、不写分隔符：每条都执行（1.0.2 以前只执行第一条，后面的表悄悄丢掉）', async () => {
  const sql = 'CREATE TABLE m_a (x TEXT);\nCREATE TABLE m_b (x TEXT);\nCREATE INDEX m_b_x ON m_b (x);\nCREATE TABLE m_c (x TEXT);';
  const world = await migrateOne(sql);
  try {
    expect(world.tables).toEqual(['m_a', 'm_b', 'm_c']);
  } finally {
    await world.close();
  }
});


test('字符串、行注释、块注释里的分号不切错', async () => {
  const sql = [
    'CREATE TABLE m_text (v TEXT); -- 行注释里的分号; 不算',
    "INSERT INTO m_text VALUES ('a;b');",
    '/* 块注释; 里的; 分号 */',
    "INSERT INTO m_text VALUES ('c'';d');",
  ].join('\n');
  const world = await migrateOne(sql);
  try {
    const rows = world.client.query<{ v: string }, []>('SELECT v FROM m_text ORDER BY rowid').all();
    expect(rows.map((row) => row.v)).toEqual(['a;b', "c';d"]);
  } finally {
    await world.close();
  }
});


test('触发器 BEGIN…END 里的分号照样配对，触发器能用', async () => {
  const sql = [
    'CREATE TABLE m_src (v TEXT);',
    'CREATE TABLE m_log (v TEXT);',
    'CREATE TRIGGER m_copy AFTER INSERT ON m_src BEGIN',
    '  INSERT INTO m_log VALUES (NEW.v);',
    "  INSERT INTO m_log VALUES (NEW.v || ';2');",
    'END;',
  ].join('\n');
  const world = await migrateOne(sql);
  try {
    world.client.exec("INSERT INTO m_src VALUES ('x')");
    const rows = world.client.query<{ v: string }, []>('SELECT v FROM m_log ORDER BY rowid').all();
    expect(rows.map((row) => row.v)).toEqual(['x', 'x;2']);
  } finally {
    await world.close();
  }
});


test('一段里后面的语句出错：整版回滚，前面建的表和账本都不留', async () => {
  const { ctx, client } = await world();
  try {
    const broken = { plugin: 'broken', migrations: [{ version: 1, sql: 'CREATE TABLE m_half (x TEXT);\nCREATE TABLE ;' }] };
    expect(() => ctx.db.migrate(broken)).toThrow();
    const half = client.query("SELECT name FROM sqlite_master WHERE name = 'm_half'").all();
    expect(half).toEqual([]);
    const ledger = client.query("SELECT version FROM db_migrations WHERE plugin = 'broken'").all();
    expect(ledger).toEqual([]);

    //M 回滚后连接照常能用，修好再迁一次就成。
    ctx.db.migrate({ plugin: 'broken', migrations: [{ version: 1, sql: 'CREATE TABLE m_half (x TEXT);' }] });
    const fixed = client.query("SELECT name FROM sqlite_master WHERE name = 'm_half'").all();
    expect(fixed).toEqual([{ name: 'm_half' }]);
  } finally {
    await ctx.fiber.dispose();
    client.close();
  }
});

