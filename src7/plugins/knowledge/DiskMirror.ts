/**
 * 积木知识库文档磁盘镜像导出器与统一原子 ID 生成器。
 * SQLite 作为唯一事务真源；每次文档新增、更新或删除后同步维护
 * <mirrorRoot>/YYYYMMDD/<id>_<安全标题>/content.md + meta.json，供外部算力机只读协同与灾难恢复。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as filesModule from '../../utils/Files.ts';
import * as namesModule from '../../utils/Names.ts';
import type * as types from './Types.ts';


//==========================================================
// 统一时间序原子 ID 与安全文件名工具
//==========================================================

/**
 * 生成 3 位随机小写英文字母后缀。
 * @returns 长度为 3 的 [a-z] 字符串。
 */
function randomLetters3(): string {
  const bytes = crypto.randomBytes(3);
  const a = 97 + ((bytes[0] ?? 0) % 26);
  const b = 97 + ((bytes[1] ?? 0) % 26);
  const c = 97 + ((bytes[2] ?? 0) % 26);
  return String.fromCharCode(a, b, c);
}


/**
 * 生成统一原子 ID：YYYYMMDDHHmmssSSS + 3 小写字母（可加前缀）。
 * @param prefix 可选前缀（文档留空，目录传 dir_，标签传 tag_）。
 * @param now 基准时间。
 * @returns 全局唯一且按时间字典序递增的 ID。
 */
export function generateAtomId(prefix = '', now = new Date()): string {
  //M 时刻取 utils 的时刻号前 17 位（本地年月日时分秒毫秒），后面接 3 个小写字母。
  const stamp = namesModule.createTimestampId(now).slice(0, 17);
  return `${prefix}${stamp}${randomLetters3()}`;
}


/**
 * 根据时间戳拼出 YYYYMMDD 日期归档目录名。
 * @param timestampMs Unix 毫秒时间戳。
 * @returns 8 位日期字符串。
 */
export function formatDateFolder(timestampMs: number): string {
  //M 日期目录就是时刻号的前 8 位。
  const at = new Date(timestampMs);
  return namesModule.createTimestampId(at).slice(0, 8);
}


/**
 * 将文档标题清洗为兼容 Windows 与 Linux 的安全文件夹后缀。
 * @param title 原始标题。
 * @returns 不含非法路径字符且截断在 40 字以内的短标题。
 */
export function sanitizeTitleSlug(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, ' ')
    .replace(/\s+/gu, '-')
    .replace(/^[.-]+|[.\s-]+$/gu, '');
  const chars = [...cleaned];
  if (chars.length === 0) return 'doc';

  return chars.slice(0, 40).join('');
}


//==========================================================
// 磁盘镜像同步类
//==========================================================

/** 维护 YYYYMMDD/<id>_<标题>/{content.md, meta.json} 的落盘导出器。 */
export class DiskMirror {
  /**
   * @param rootDir 知识库镜像根目录（默认 <runtimeRoot>/knowledge）。
   */
  constructor(readonly rootDir: string) {
    filesModule.ensureDir(rootDir);
  }

  /**
   * 核实候选目录内的 meta.json 是否真属于指定 docId，彻底防止 kb_ 误删 kb_2_ 等前缀碰撞。
   */
  private isFolderOwnedByDoc(folderPath: string, docId: string): boolean {
    const metaFile = path.join(folderPath, 'meta.json');
    const stat = fs.statSync(metaFile, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) return false;

    try {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { id?: unknown } | null;
      return parsed?.id === docId;
    } catch {
      return false;
    }
  }

  /**
   * 清理同一日期目录下属于该文档 ID 的旧文件夹（处理标题改名或文档删除）。
   * @param dayDir 日期子目录绝对路径。
   * @param docId 文档 ID。
   * @param keepFolderName 当前应保留的目标目录名；全删时传空串。
   */
  private cleanupDocFolders(dayDir: string, docId: string, keepFolderName: string): void {
    const stat = fs.statSync(dayDir, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) return;

    const prefix = `${docId}_`;
    for (const entry of fs.readdirSync(dayDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(prefix)) continue;
      if (entry.name === keepFolderName) continue;

      const candidate = path.join(dayDir, entry.name);
      if (!this.isFolderOwnedByDoc(candidate, docId)) continue;

      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  /**
   * 将最新文档正文与元数据原子落盘至 YYYYMMDD/<id>_<标题>/（先写 meta.json 确保归属可验）。
   * @param doc 完整文档对象。
   */
  writeDoc(doc: types.KnowledgeDoc): void {
    const dayName = formatDateFolder(doc.createdAt);
    const dayDir = path.join(this.rootDir, dayName);
    const folderName = `${doc.id}_${sanitizeTitleSlug(doc.title)}`;
    this.cleanupDocFolders(dayDir, doc.id, folderName);

    const docDir = filesModule.ensureDir(path.join(dayDir, folderName));
    const meta = {
      id: doc.id,
      dirId: doc.dirId,
      topicId: doc.topicId,
      title: doc.title,
      summary: doc.summary,
      sourcePath: doc.sourcePath,
      sourceType: doc.sourceType,
      tags: doc.tags,
      isSystemRule: doc.isSystemRule,
      aliases: doc.aliases,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    filesModule.writeTextAtomic(path.join(docDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\r\n`, true);
    filesModule.writeTextAtomic(path.join(docDir, 'content.md'), doc.content, true);
  }

  /**
   * 删除文档对应的磁盘镜像目录。
   * @param id 文档 ID。
   * @param createdAt 文档创建毫秒时间。
   */
  removeDoc(id: string, createdAt: number): void {
    const dayName = formatDateFolder(createdAt);
    const dayDir = path.join(this.rootDir, dayName);
    this.cleanupDocFolders(dayDir, id, '');
  }
}
