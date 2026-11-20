/** 渠道索引的版本迁移；实时插件和离线索引共用 db 的迁移账本。 */
import type * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import * as dbModule from '../db/index.ts';
import initialSql from './migrations/0000_channel_index.sql' with { type: 'text' };
import metadataSql from './migrations/0001_channel_metadata.sql' with { type: 'text' };
import visibilitySql from './migrations/0002_channel_visibility.sql' with { type: 'text' };


/** 接管已有渠道表，增加附件和撤回，并登记过去由旧代码补过的可见性列。 */
export const channelMigrations: dbModule.MigrationPlan = {
  plugin: 'memory-channel',
  migrations: [
    { version: 1, sql: initialSql },
    { version: 2, sql: metadataSql },
    {
      version: 3,
      sql: visibilitySql,
      adoptColumn: { table: 'memory_channel_messages', name: 'front_only' },
    },
  ],
};


/**
 * 在开始查询前迁移渠道索引，事务和版本校验全部交给 db。
 * @param client 调用方持有的 SQLite 连接，不接管关闭。
 * @param service 正式插件注入的 db；离线索引和内存测试可不给。
 */
export function migrateChannelIndex(client: sqlite.Database, service?: dbModule.Db): void {
  if (service !== undefined) {
    //M 正式插件复用主库已注册的迁移服务。
    service.migrate(channelMigrations);
    return;
  }

  //M 离线补旧脚本也沿用同一账本，不自行查列或执行 ALTER。
  const context = new cordis.Context();
  const standalone = new dbModule.Db(context, client);
  standalone.migrate(channelMigrations);
}
