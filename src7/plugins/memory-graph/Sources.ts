/**
 * 命中原文的出处（2026-11-14 23:15 EST，用户 23:05：/memory/ 每条命中要显示来源文件的实际路径，方便核对）。
 * 记忆库里 source 字段三种写法（2026-11-14 23:12 EST 在正式库上只读查过）：
 *   - 文档导入（ztools/doc-import）：`doc-import:<客户>:<文件名>`，例如 doc-import:demo:出版ERP:03-印务功能清单.xlsx。
 *     老数据只存了文件名、没存目录，所以按文件名到数据目录的 memory/ 下找；23:15 以后导入的写成相对数据目录的路径（memory/ainit/xxx.xlsx），直接拼。
 *     start/end 是“转成文字后”的行号，不是原文件的行；表格每行带【标题 · 工作表 第N行】，从原文里取 Sheet 行范围。
 *   - 聊天记录：`session:<会话号>`，没有文件，只给会话来源（页面会打码）。
 *   - 知识库文件（memory 插件）：绝对路径，原样给。
 * 不写死任何绝对路径：都用服务端的数据目录（resources.root）拼。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 检索命中里用到的字段（jmbots-memory 的 Citation）。 */
export interface CitedHit { id?: number; source?: string; scope?: string; bot?: string; customer?: string; session?: string; title?: string; start?: number; end?: number }

/** 给页面看的出处。 */
export interface HitSource {
  /** 原文件完整路径；聊天记录、找不到时是 ''。 */
  file: string;
  /** 在哪一段：表格的工作表和行、文档的转换后行号。 */
  where: string;
  /** 不是文件时的来源（会话号等），以及找不到文件时的说明。 */
  origin: string;
}

/** 按文件名找文件时最多往下几层。 */
const DEPTH = 4;
/** 文件名表多久重扫一次（找不到时才扫）。 */
const RESCAN_MS = 60_000;


export class Sources {
  /** 文件名 → 完整路径（memory/ 下）。 */
  private names = new Map<string, string>();
  /** 上次扫的时间。 */
  private scannedAt = 0;

  /**
   * @param root 数据目录（resources.root）。
   * @param text 按片段号取原文（表格取 Sheet 行用）；取不到返回 ''。
   */
  constructor(readonly root: string, private readonly text: (id: number) => string) {}

  /**
   * 一条命中的出处。
   * @param hit 检索命中。
   */
  describe(hit: CitedHit): HitSource {
    const source = hit.source ?? '';
    if (source.startsWith('session:')) return { file: '', where: '', origin: `聊天记录 · 客户 ${hit.customer ?? ''} · 会话 ${source.slice('session:'.length)}` };
    if (source.startsWith('doc-import:')) {
      /** 去掉 doc-import:<客户>: 以后的部分（客户号自己可能带冒号，比如 demo:出版ERP）。 */
      const owner = `doc-import:${hit.customer || hit.bot || ''}:`;
      const rest = source.startsWith(owner) ? source.slice(owner.length) : source.slice(source.lastIndexOf(':') + 1);
      const where = this.where(hit, rest);
      if (rest.includes('/')) {
        const file = path.resolve(this.root, rest);
        return fs.existsSync(file) ? { file, where, origin: '' } : { file: '', where, origin: `导入时的文件 ${rest} 现在不在数据目录里` };
      }
      const file = this.find(rest);
      return file !== '' ? { file, where, origin: '' } : { file: '', where, origin: `库里只记了文件名 ${rest}，数据目录 memory/ 下没找到` };
    }
    if (path.isAbsolute(source)) return { file: source, where: this.lines(hit), origin: '' };
    return { file: '', where: this.lines(hit), origin: source };
  }

  /** 表格给“工作表 第a–b行”，别的给转换后行号。 */
  private where(hit: CitedHit, name: string): string {
    if (/\.(xlsx|xls)$/iu.test(name) && hit.id !== undefined) {
      /** 原文里的【标题 · 工作表 第N行】。 */
      const marks = [...this.text(hit.id).matchAll(/【[^】]*? · ([^】]+?) 第(\d+)行】/gu)];
      if (marks.length > 0) {
        const sheets = [...new Set(marks.map((m) => m[1] ?? ''))];
        const rows = marks.map((m) => Number(m[2]));
        const from = Math.min(...rows), to = Math.max(...rows);
        return `${sheets.join('、')} 第 ${String(from)}${to === from ? '' : `–${String(to)}`} 行`;
      }
    }
    return this.lines(hit);
  }

  /** 转换后行号（从 1 数）。 */
  private lines(hit: CitedHit): string {
    if (typeof hit.start !== 'number' || typeof hit.end !== 'number') return '';
    const from = hit.start + 1, to = hit.end + 1;
    return `转成文字后第 ${String(from)}${to === from ? '' : `–${String(to)}`} 行`;
  }

  /** 按文件名在 memory/ 下找；没找到且离上次扫过了一分钟就重扫。 */
  private find(name: string): string {
    if (!this.names.has(name) && Date.now() - this.scannedAt > RESCAN_MS) this.scan();
    return this.names.get(name) ?? '';
  }

  /** 扫 memory/ 下的文件（最多 DEPTH 层），同名的留第一个。 */
  private scan(): void {
    this.scannedAt = Date.now();
    const names = new Map<string, string>();
    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile()) { if (!names.has(entry.name)) names.set(entry.name, full); }
        else if (entry.isDirectory() && depth < DEPTH) walk(full, depth + 1);
      }
    };
    walk(path.join(this.root, 'memory'), 1);
    this.names = names;
  }
}
