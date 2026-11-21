/**
 * 管理积木知识库的目录、文档、标签、磁盘镜像与检索工具。
 * 1. 管理 SQLite 三组表（虚拟目录 kb_dirs、知识文档 kb_docs、标签与关联 kb_tags / kb_doc_tags）；
 * 2. 自动维护 <runtimeRoot>/knowledge/YYYYMMDD/<id>_<标题>/{content.md, meta.json} 磁盘镜像；
 * 3. 挂载 /api/knowledge/* 全套 REST 接口（写操作强制 isVerified 核验，搜索时按需附查 memory）；
 * 4. 注册模型只读检索工具 kb_search，供前台与后台机器人按关键词、专题或标签查阅资料；
 * 5. 注册写工具 kb_save（新建、追加、带乐观锁的替换），标签改名合并删除与相关文档推荐接口。
 */
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as checksModule from '../../utils/Checks.ts';
import * as mirrorModule from './DiskMirror.ts';
import * as routesModule from './Routes.ts';
import * as storeModule from './Store.ts';
import * as toolsModule from './Tools.ts';

export * from './Types.ts';
export { DiskMirror, formatDateFolder, generateAtomId, sanitizeTitleSlug } from './DiskMirror.ts';
export { KnowledgeStore, SCHEMA_SQL, deriveAutoSummary, normalizeTags } from './Store.ts';


/** 插件名。 */
export const name = 'knowledge';

//M 1.0.0：积木知识库三原子 SQLite 存储、磁盘镜像导出、REST API、memory 搜索附查与 kb_search 工具。
//M 1.0.2：kb_save 写工具（新建、追加、乐观锁替换）；标签改名、合并、删除接口；相关文档推荐接口。
//M 1.0.3：记忆桥接不再传 requestEvent 的 timeoutMs，改传 AbortSignal.timeout(4 秒)（云端 31 第 2 条）。
//M 1.0.4：建表只走 db 迁移账本（云端 36 第 1 条）：db 成了必需依赖，KnowledgeStore 不再自己建表；
//M   第 2 版按语句拆开补齐第 1 版只执行了第一句的那几张表。
/** 插件版本号。 */
export const version = '1.0.4';

/** 依赖资源主库、主 HTTP 服务、模型工具注册表，以及建表用的 db 迁移账本。 */
export const inject = ['resources', 'http', 'tools', 'db'];

/** 知识库在 db 迁移账本里的版本。 */
export const knowledgeMigrations = {
  plugin: name,
  migrations: [
    { version: 1, sql: storeModule.SCHEMA_SQL },
    { version: 2, sql: storeModule.SCHEMA_SPLIT_SQL },
  ],
};


/** 解析可选插件配置。 */
function parseKnowledgeConfig(
  runtimeRoot: string,
  raw: unknown,
): { mirrorDir: string } {
  const defaultDir = path.join(runtimeRoot, 'knowledge');
  if (raw === undefined || raw === true) {
    return { mirrorDir: defaultDir };
  }

  const rec = checksModule.checkRecord(raw, 'plugins.knowledge');
  if (rec['mirror_dir'] !== undefined) {
    const custom = checksModule.checkNonEmptyText(rec['mirror_dir'], 'plugins.knowledge.mirror_dir');
    return { mirrorDir: path.resolve(runtimeRoot, custom) };
  }
  return { mirrorDir: defaultDir };
}


/**
 * 挂载积木知识库插件。
 * @param ctx Cordis 插件上下文。
 * @param config 可选插件配置（mirror_dir）。
 */
export function apply(ctx: cordis.Context, config?: unknown): void {
  const settings = parseKnowledgeConfig(ctx.resources.root, config);

  //M 建表交给 db 的迁移账本：旧库里表已经在，账本只登记；新库照两版建齐。
  ctx.db.migrate(knowledgeMigrations);
  const mirror = new mirrorModule.DiskMirror(settings.mirrorDir);
  const store = new storeModule.KnowledgeStore(ctx.resources.db, mirror);
  routesModule.mountKnowledgeRoutes(ctx, store);
  toolsModule.registerKbSearchTool(ctx, store);
  toolsModule.registerKbSaveTool(ctx, store);
}
