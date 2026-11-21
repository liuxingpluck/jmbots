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
//M 1.0.2：迁移每段 SQL 交给 SQLite 原生 exec 执行，一段里写了几条语句就执行几条（原来走 Drizzle 的预编译，
//M   只执行第一条，漏写 --> statement-breakpoint 的建表悄悄丢表，knowledge 第 1 版就中过）。
export const version = '1.0.2';

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
  /** 接管已用旧代码加过的一列；列已存在时只登记该版本。SQL 只包含对应的加列语句。 */
  adoptColumn?: {
    /** 旧表名。 */
    table: string;
    /** 可以接管的现有列名。 */
    name: string;
  };
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
        const column = migration.adoptColumn;
        let fingerprint = source;
        if (column !== undefined) {
          fingerprint = JSON.stringify([source, column.table, column.name]);
        }
        const hash = crypto.createHash('sha256').update(fingerprint).digest('hex');
        const known = applied[index];
        if (known !== undefined) {
          if (known.version !== version || known.hash !== hash) {
            throw new Error(`db：${plugin} 已应用的迁移 ${String(version)} 与当前不符`);
          }
          continue;
        }

        //M 接管旧版已经加过的列，避免在已有数据上重复加列。
        let adopted = false;
        if (column !== undefined) {
          const existing = drizzle.sql`SELECT name FROM pragma_table_info(${column.table}) WHERE name = ${column.name}`;
          adopted = tx.get(existing) !== undefined;
        }

        if (!adopted) {
          //M Drizzle Kit 以此注释分隔语句；每段交给 SQLite 原生 exec，同一连接、同一事务里执行。
          //M   exec 由 SQLite 自己解析：一段里有几条语句执行几条，字符串、注释、触发器 BEGIN…END 里的分号都不会切错。
          //M   不能用 tx.run：它走预编译，只执行第一条，后面的悄悄丢掉。
          const statements = source.split('--> statement-breakpoint');
          for (const part of statements) {
            const text = part.trim();
            if (text === '') {
              continue;
            }

            this.orm.$client.exec(text);
          }
        }

        //M 只有迁移完成或接管已存在的列才登记版本，重启只核对摘要。
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
