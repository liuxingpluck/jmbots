/** 对话压缩摘要沿用已有的 compress_log 表。 */
import * as sqliteCore from 'drizzle-orm/sqlite-core';


/** 会话号、已压缩的消息边界及摘要正文。 */
export const compressLog = sqliteCore.sqliteTable('compress_log', {
  session: sqliteCore.text('session').primaryKey(),
  upto: sqliteCore.integer('upto').notNull(),
  summary: sqliteCore.text('summary').notNull(),
});
