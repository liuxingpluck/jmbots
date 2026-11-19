/**
 * 包装 Resources 已打开的连接，给业务插件 Drizzle、启动迁移和事务。
 * 插件自行声明表和生成迁移，本插件只登记迁移及管理事务。
 */
import * as crypto from 'node:crypto';
import type * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import * as drizzle from 'drizzle-orm';
import * as sqliteDrizzle from 'drizzle-orm/bun-sqlite';
import * as checksModule from '../../utils/Checks.ts';
import * as schema from './Schema.ts';
import ledgerSql from './migrations/0000_db_migrations.sql' with { type: 'text' };


/** 自带插件名及版本。 */
export const name = 'db';
export const version = '1.0.0';

/** Resources 持有原生连接，db 随它启动。 */
export const inject = ['resources'];


/** SQLite 的 Drizzle 实例。 */
export type SqliteOrm = sqliteDrizzle.BunSQLiteDatabase & { $client: sqlite.Database };

/** SQLite 事务内使用的 Drizzle 实例。 */
export type SqliteTx = Parameters<Parameters<SqliteOrm['transaction']>[0]>[0];


/** 业务插件交给 db 的一条已发布迁移。 */
export interface Migration {
  /** 插件内的正整数版本，从 1 连续增加。 */
  version: number;
  /** 由表定义生成的迁移文件内容。 */
  sql: string;
}

/** 同一个业务插件按版本提交的方言迁移。 */
export interface MigrationPlan {
  /** 拥有这些表的插件名。 */
  plugin: string;
  /** 按版本从小到大，包含已发布的迁移。 */
  migrations: readonly Migration[];
}

/** 配置和适配边界识别的数据库方言。 */
export type DatabaseEngine = 'sqlite' | 'postgresql' | 'mysql';

/** 数据库实现的薄接口，业务表与查询可直接使用具体 Drizzle 类型。 */
export interface DbEngine<TOrm, TTx> {
  /** 所使用的数据库方言。 */
  readonly engine: DatabaseEngine;
  /** 对应方言的 Drizzle 实例。 */
  readonly orm: TOrm;
  /** 在业务插件开始读写之前应用它的迁移。 */
  migrate(plan: MigrationPlan): void | Promise<void>;
  /** 在同一个事务里运行回调。 */
  transaction<T>(work: (tx: TTx) => T): T | Promise<Awaited<T>>;
}

declare module 'cordis' {
  interface Context {
    /** 主库的 Drizzle、迁移与事务服务。 */
    db: Db;
  }
}


/** 现阶段的 SQLite 实现，连接的生命周期由 Resources 管理。 */
export class Db extends cordis.Service implements DbEngine<SqliteOrm, SqliteTx> {
  readonly engine = 'sqlite';
  readonly orm: SqliteOrm;

  /**
   * 用同一个原生连接构建 Drizzle，并准备迁移记录表。
   * @param ctx db 插件的上下文。
   * @param client Resources 打开的 SQLite 连接。
   */
  constructor(ctx: cordis.Context, client: sqlite.Database) {
    super(ctx, 'db');
    //M 继续使用原库，Drizzle 与仍使用原生接口的插件共用同一个连接。
    this.orm = sqliteDrizzle.drizzle({ client });

    //M db 只有自己的迁移账本，启动时先建好供后续插件登记。
    const statement = drizzle.sql.raw(ledgerSql);
    this.orm.run(statement);
  }

  /**
   * 在插件开始读写前应用它的迁移，已应用的版本只核对摘要。
   * @param plan 业务插件的名称和顺序发布的迁移。
   * 副作用：同一事务提交迁移及其版本记录，失败时回滚。
   */
  migrate(plan: MigrationPlan): void {
    const { plugin, migrations } = plan;
    this.transaction((tx) => {
      //M 按插件隔离版本，同版本重启只校验已有记录。
      const table = schema.dbMigrations;
      const byPlugin = drizzle.eq(table.plugin, plugin);
      const applied = tx.select().from(table).where(byPlugin).orderBy(table.version).all();
      if (applied.length > migrations.length) {
        throw new Error(`db：${plugin} 的已应用迁移比当前版本多`);
      }

      for (const [index, migration] of migrations.entries()) {
        const version = index + 1;
        if (migration.version !== version) {
          throw new Error(`db：${plugin} 的迁移版本应为 ${String(version)}`);
        }

        //M 换行符跨平台归一化，避免同一份 SQL 在 Windows 上改变摘要。
        const source = migration.sql.replaceAll('\r\n', '\n');
        const hash = crypto.createHash('sha256').update(source).digest('hex');
        const known = applied[index];
        if (known !== undefined) {
          if (known.version !== version || known.hash !== hash) {
            throw new Error(`db：${plugin} 已应用的迁移 ${String(version)} 与当前不符`);
          }
          continue;
        }

        //M Drizzle Kit 以此注释分隔语句，每条在同一事务连接执行。
        const statements = source.split('--> statement-breakpoint');
        for (const part of statements) {
          const text = part.trim();
          if (text === '') continue;

          const statement = drizzle.sql.raw(text);
          tx.run(statement);
        }

        //M 只有迁移执行成功才登记版本，重启可以安全重跑。
        const entry = { plugin, version, hash, appliedAt: Date.now() };
        tx.insert(table).values(entry).run();
      }
    });
  }

  /**
   * 以同一连接运行同步的 SQLite 事务。
   * @param work 使用传入 Drizzle 事务的同步回调。
   * @returns 回调返回值。
   * @throws 回调失败或返回未执行的异步结果时回滚并抛错。
   */
  transaction<T>(work: (tx: SqliteTx) => T): T {
    const options = { behavior: 'immediate' as const };
    const run = (tx: SqliteTx): T => {
      const result = work(tx);
      //G 同步事务内必须完成读写，拦截 Promise 和未执行的 Drizzle 查询。
      const canWait = (typeof result === 'object' && result !== null) || typeof result === 'function';
      if (canWait && 'then' in result && typeof result.then === 'function') {
        throw new Error('db：SQLite 事务回调需要同步完成');
      }

      return result;
    };
    //M Drizzle 调用原生连接提交事务，异常由驱动回滚。
    return this.orm.transaction(run, options);
  }
}


/**
 * 检查引擎配置并提供数据库服务。第一步支持已有 SQLite 连接。
 * @param ctx Cordis 插件上下文。
 * @param raw db 配置，engine 省略时取 sqlite。
 */
export function apply(ctx: cordis.Context, raw: unknown): void {
  const config = checksModule.checkRecord(raw ?? {}, 'db');
  const engine = config['engine'] ?? 'sqlite';
  if (engine !== 'sqlite') throw new Error('db.engine 当前只支持 sqlite');

  //M Resources 管连接的创建与关闭，插件只持有封装。
  const client = ctx.resources.db;
  new Db(ctx, client);
}
