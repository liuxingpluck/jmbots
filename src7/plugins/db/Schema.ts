/** db 插件的迁移记录。业务表由拥有数据的插件自行声明。 */
import * as sqliteCore from 'drizzle-orm/sqlite-core';


/** 已提交的插件迁移，迁移版本号在各插件内独立递增。 */
export const dbMigrations = sqliteCore.sqliteTable('db_migrations', {
  plugin: sqliteCore.text('plugin').notNull(),
  version: sqliteCore.integer('version').notNull(),
  hash: sqliteCore.text('hash').notNull(),
  appliedAt: sqliteCore.integer('applied_at').notNull(),
}, (row) => [
  sqliteCore.primaryKey({ columns: [row.plugin, row.version] }),
]);
