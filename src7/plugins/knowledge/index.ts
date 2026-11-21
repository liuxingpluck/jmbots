/**
 * 积木知识库插件（knowledge）：
 * 1. 管理 SQLite 三组核心表（虚拟目录 kb_dirs、知识文档 kb_docs、标签与关联 kb_tags / kb_doc_tags）；
 * 2. 自动维护 <runtimeRoot>/knowledge/YYYYMMDD/<id>_<标题>/{content.md, meta.json} 磁盘镜像；
 * 3. 挂载 /api/knowledge/* 全套 REST 接口（写操作强制 isVerified 核验，搜索温和桥接 memory）；
 * 4. 注册模型只读检索工具 kb_search，供前台与后台机器人按关键词、专题或标签查阅资料。
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

//M 1.0.0：积木知识库三原子 SQLite 存储、磁盘镜像导出、REST API、memory 搜索温和桥接与 kb_search 工具。
/** 插件版本号。 */
export const version = '1.0.1';

/** 依赖资源主库、主 HTTP 服务与模型工具注册表。 */
export const inject = ['resources', 'http', 'tools'];


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

  //M 若已挂载 db 迁移服务则纳入统一版本账本，否则由 KnowledgeStore 直接幂等建表。
  const dbService = ctx.get('db');
  dbService?.migrate({
    plugin: name,
    migrations: [{ version: 1, sql: storeModule.SCHEMA_SQL }],
  });

  const mirror = new mirrorModule.DiskMirror(settings.mirrorDir);
  const store = new storeModule.KnowledgeStore(ctx.resources.db, mirror);
  routesModule.mountKnowledgeRoutes(ctx, store);
  toolsModule.registerKbSearchTool(ctx, store);
}
