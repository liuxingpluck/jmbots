/**
 * 积木知识库的本地文件夹只读同步（1.2.0）：把配置的 localWatchDirs（或请求里临时给的目录）下的 .md、.txt 导进知识库。
 * 只读源目录：只用 readdir、stat、readFile，绝不改、删、挪用户的文件。
 * 按规范化的 source_path 认文档、按 sha256 的 content_hash 判断变没变：没变跳过，新文件新建，变了原位更新正文；
 * 硬性系统规则的文档一律不覆盖。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as storeModule from './Store.ts';
import type * as types from './Types.ts';


/** 同步导入的文档默认放进的分类（虚拟目录名）。 */
export const DEFAULT_SYNC_CATEGORY = '外部学习';

/** 同步导入的文档自动带的标签。 */
export const SYNC_TAG = '本地导入';

/** 单个文件最多多大（字节）。 */
export const MAX_SYNC_FILE_BYTES = 256 * 1024;

/** 每个目录最多扫几个文件。 */
export const MAX_SYNC_FILES_PER_DIR = 200;

/** 只收这几种扩展名（小写比）。 */
const SYNC_EXTENSIONS = new Set(['.md', '.txt']);

/** 不进去的目录名（以 . 开头的另外整个跳过）。 */
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist']);

/** 盘符或根下这些一级目录是系统目录，不许当同步目录（Windows 按小写比）。 */
const SYSTEM_DIR_NAMES = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'bin',
  'boot',
  'dev',
  'etc',
  'lib',
  'lib64',
  'proc',
  'sbin',
  'sys',
  'usr',
]);


/**
 * 查一个同步目录是不是系统根目录或系统目录：根（/、C:\）本身，或根下的 Windows、Program Files、/etc、/usr 这类。
 * @param dir checkDirs 规范化过的绝对路径。
 * @returns 是系统目录时的原因；不是返回 undefined。
 */
function getSystemDirReason(dir: string): string | undefined {
  const root = path.parse(dir).root;
  if (path.resolve(dir) === path.resolve(root)) return '不能同步系统根目录';

  const first = path.relative(root, dir).split(path.sep)[0] ?? '';
  if (SYSTEM_DIR_NAMES.has(first.toLowerCase())) return '不能同步系统目录';

  return undefined;
}


/**
 * 从正文取标题：第一行 `# 标题`；没有就用文件名去掉扩展名。
 * @param content 文件正文。
 * @param file 文件路径。
 * @returns 标题。
 */
function getSyncTitle(content: string, file: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/mu.exec(content);
  const fromHeading = heading?.[1]?.trim() ?? '';
  if (fromHeading !== '') return fromHeading;

  return path.basename(file, path.extname(file));
}


/** 本地文件夹只读同步：记着配置的目录和最近一次结果。 */
export class FolderSync {
  /** 这次启动以来最近一次同步的结果；还没同步过是 null。 */
  private lastSync: types.KnowledgeSyncResult | null = null;

  /**
   * @param store 知识库存储。
   * @param watchDirs 插件配置 localWatchDirs（index.ts 用 checkDirs 规范化过）。
   * @param mirrorDir 知识库自己的磁盘镜像目录：在它里面的不扫，免得把镜像又导回来。
   */
  constructor(
    private readonly store: storeModule.KnowledgeStore,
    private readonly watchDirs: string[],
    private readonly mirrorDir: string,
  ) {}

  /** 配置的目录和最近一次结果，给 GET /api/knowledge/sync-status。 */
  getStatus(): Omit<types.KnowledgeSyncStatusResponse, 'ok'> {
    return { localWatchDirs: this.watchDirs, lastSync: this.lastSync };
  }

  /**
   * 同步一次。
   * @param dirs 请求里临时给的目录（Routes 用 checkDirs 规范化过）；空数组用配置的 localWatchDirs。
   * @param category 放进哪个分类（虚拟目录名，Routes 已去空白、缺省时给 DEFAULT_SYNC_CATEGORY）。
   * @returns 扫了几个、新建、更新、跳过几篇，没处理的文件和原因。
   * @throws Failure(400) 没有可同步的目录，或给了系统根目录、系统目录。
   */
  sync(dirs: string[], category: string): types.KnowledgeSyncResult {
    //==========================================================
    //M 定下这次扫哪些目录：请求给了用请求的，没给用配置的；系统目录整个拒绝
    //==========================================================
    let targets = dirs;
    if (targets.length === 0) {
      targets = this.watchDirs;
    }
    if (targets.length === 0) {
      throw new failureModule.Failure(400, '没有要同步的目录：在插件配置写 localWatchDirs，或请求里带 dirs');
    }
    for (const dir of targets) {
      const reason = getSystemDirReason(dir);
      if (reason !== undefined) {
        throw new failureModule.Failure(400, `${reason}：${dir}`);
      }
    }

    //==========================================================
    //M 逐个目录收文件：只读遍历，跳过隐藏目录、node_modules、dist、镜像目录，每个目录最多 200 个
    //==========================================================
    const result: types.KnowledgeSyncResult = {
      scanned: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      lastSyncedAt: 0,
    };
    const files: string[] = [];
    for (const dir of targets) {
      files.push(...this.collectFiles(dir, result.errors));
    }

    //==========================================================
    //M 逐个文件比对：按 source_path 认出导过的那篇，按 content_hash 判断变没变
    //==========================================================
    const imported = new Map<string, ReturnType<storeModule.KnowledgeStore['listImported']>[number]>();
    for (const row of this.store.listImported()) {
      imported.set(workspaceModule.getPathKey(row.sourcePath), row);
    }
    let dirId: string | undefined;
    for (const file of files) {
      result.scanned += 1;
      try {
        //G 太大的不读。
        const size = fs.statSync(file).size;
        if (size > MAX_SYNC_FILE_BYTES) {
          result.errors.push({ path: file, reason: `超过 ${String(MAX_SYNC_FILE_BYTES / 1024)} KB，没导入` });
          continue;
        }

        const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');
        const fileKey = workspaceModule.getPathKey(file);
        const known = imported.get(fileKey);

        //M 导过、内容没变：跳过。
        if (known !== undefined && known.contentHash === contentHash) {
          result.skipped += 1;
          continue;
        }

        //G 导过、但那篇已被本人标成硬性系统规则：不覆盖。
        if (known !== undefined && known.isSystemRule) {
          result.errors.push({ path: file, reason: '对应文档是硬性系统规则，不覆盖' });
          continue;
        }

        //M 导过、内容变了：原位更新正文和哈希，标题、标签、目录这些本人可能改过，不动。
        if (known !== undefined) {
          this.store.updateDoc(known.id, { content, contentHash });
          imported.set(fileKey, { ...known, contentHash });
          result.updated += 1;
          continue;
        }

        //M 新文件：放进分类目录（第一次用到时才找或建），带 #本地导入 标签。
        dirId ??= this.store.getOrCreateDirByName(category);
        const input: types.CreateDocInput = {
          dirId,
          title: getSyncTitle(content, file),
          content,
          sourcePath: file,
          sourceType: 'file',
          tags: [SYNC_TAG],
          contentHash,
        };
        //M 记进已导入的表：几个同步目录有重叠时，同一个文件第二次碰到就是没变、跳过。
        const created = this.store.createDoc(input);
        imported.set(fileKey, { id: created.id, sourcePath: file, contentHash, isSystemRule: false });
        result.created += 1;
      } catch (error) {
        result.errors.push({ path: file, reason: textModule.getErrorMessage(error) });
      }
    }

    result.lastSyncedAt = Date.now();
    this.lastSync = result;
    return result;
  }

  /**
   * 收一个同步目录下的 .md、.txt（广度优先，只读）。不在的、不是目录的、读不了的记进 errors。
   * @param dir 同步目录。
   * @param errors 本次同步的问题清单，往里追加。
   * @returns 文件的绝对路径，最多 MAX_SYNC_FILES_PER_DIR 个。
   */
  private collectFiles(dir: string, errors: types.KnowledgeSyncError[]): string[] {
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      errors.push({ path: dir, reason: '目录不存在' });
      return [];
    }

    const mirrorKey = workspaceModule.getPathKey(this.mirrorDir);
    const files: string[] = [];
    const queue = [dir];
    while (queue.length > 0) {
      const current = queue.shift()!;

      //G 知识库自己的镜像目录不扫。
      const key = workspaceModule.getPathKey(current);
      if (key === mirrorKey || key.startsWith(`${mirrorKey}${path.sep}`)) continue;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        errors.push({ path: current, reason: textModule.getErrorMessage(error) });
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        //G 隐藏的（.git 等）、node_modules、dist 都不进；链接不跟（isDirectory、isFile 对链接都是 false）。
        if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;

        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
          continue;
        }
        if (!entry.isFile() || !SYNC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

        //G 一个目录最多 200 个，多的不扫并记一条。
        if (files.length >= MAX_SYNC_FILES_PER_DIR) {
          errors.push({ path: dir, reason: `超过 ${String(MAX_SYNC_FILES_PER_DIR)} 个文件，后面的没扫` });
          return files;
        }
        files.push(full);
      }
    }
    return files;
  }
}
