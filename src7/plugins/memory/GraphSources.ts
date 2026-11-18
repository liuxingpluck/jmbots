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
export interface CitedHit {
  id?: number;
  source?: string;
  scope?: string;
  bot?: string;
  customer?: string;
  session?: string;
  title?: string;
  start?: number;
  end?: number;
}

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


/**
 * 命中出处解析器：将记忆库里的 source 和起止行号映射成磁盘完整路径、表格 Sheet 行号或会话来源说明。
 */
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
   * @returns 出处：找得到文件的给完整路径和段落；聊天记录、找不到文件的给来源说明。
   */
  describe(hit: CitedHit): HitSource {
    //G 聊天记录（session:）没有文件可找，直接把客户和会话号当来源返回。
    const source = hit.source ?? '';
    if (source.startsWith('session:')) return { file: '', where: '', origin: `聊天记录 · 客户 ${hit.customer ?? ''} · 会话 ${source.slice('session:'.length)}` };

    //M 文档导入的：从 source 里剥出文件名或相对路径，再到数据目录里找原文件。
    if (source.startsWith('doc-import:')) {
      //M 去掉 doc-import:<客户>: 以后的部分（客户号自己可能带冒号，比如 demo:出版ERP）。
      const owner = `doc-import:${hit.customer || hit.bot || ''}:`;
      let rest = source.slice(source.lastIndexOf(':') + 1);
      if (source.startsWith(owner)) {
        rest = source.slice(owner.length);
      }

      //M 先算好在哪一段（表格的工作表行或转换后行号），下面不管找没找到文件都带上。
      const where = this.where(hit, rest);

      //M 带 / 的是新导入写的相对数据目录路径，拼上数据目录看文件还在不在。
      if (rest.includes('/')) {
        const file = path.resolve(this.root, rest);
        if (fs.existsSync(file)) return { file, where, origin: '' };

        return { file: '', where, origin: `导入时的文件 ${rest} 现在不在数据目录里` };
      }

      //M 老数据只存了文件名，到数据目录的 memory/ 下按文件名找。
      const file = this.find(rest);
      if (file !== '') return { file, where, origin: '' };

      return { file: '', where, origin: `库里只记了文件名 ${rest}，数据目录 memory/ 下没找到` };
    }

    //M 知识库文件存的是绝对路径，原样给出，段落按转换后行号算。
    if (path.isAbsolute(source)) return { file: source, where: this.lines(hit), origin: '' };

    //M 不认识的写法没有文件，把 source 原样当来源说明给页面，行号照给。
    return { file: '', where: this.lines(hit), origin: source };
  }

  /** 表格给“工作表 第a–b行”，别的给转换后行号。 */
  private where(hit: CitedHit, fileName: string): string {
    //M 只有表格文件、而且知道片段号，才取原文找工作表和行号标记。
    if (/\.(xlsx|xls)$/iu.test(fileName) && hit.id !== undefined) {
      //M 原文里的【标题 · 工作表 第N行】。
      const marks = [...this.text(hit.id).matchAll(/【[^】]*? · ([^】]+?) 第(\d+)行】/gu)];
      if (marks.length > 0) {
        //M 收拢出涉及的工作表（去重）和最小、最大行号，拼成 a–b（只有一行就只写一个数）。
        const sheets = [...new Set(marks.map((match) => match[1] ?? ''))];
        const rows = marks.map((match) => Number(match[2]));
        const from = Math.min(...rows);
        const to = Math.max(...rows);
        let range = String(from);
        if (to !== from) {
          range = `${String(from)}–${String(to)}`;
        }

        //M 几个工作表用顿号连起来，后面接行范围，给页面显示。
        return `${sheets.join('、')} 第 ${range} 行`;
      }
    }

    //M 不是表格、或原文里没有工作表标记的，退回转换后行号。
    return this.lines(hit);
  }

  /** 转换后行号（从 1 数）。 */
  private lines(hit: CitedHit): string {
    if (typeof hit.start !== 'number' || typeof hit.end !== 'number') return '';

    //M 库里存的是从 0 数的行号，给人看要 +1；起止相同就只写一个数。
    const from = hit.start + 1;
    const to = hit.end + 1;
    let range = String(from);
    if (to !== from) {
      range = `${String(from)}–${String(to)}`;
    }
    return `转成文字后第 ${range} 行`;
  }

  /** 按文件名在 memory/ 下找；没找到且离上次扫过了一分钟就重扫。 */
  private find(fileName: string): string {
    //M 名字表里没有、且离上次扫已过一分钟，才重扫一遍目录（免得每次找不到都扫盘）。
    if (!this.names.has(fileName) && Date.now() - this.scannedAt > RESCAN_MS) {
      this.scan();
    }

    //M 重扫后还没有就给空串，由 describe 写“没找到”。
    return this.names.get(fileName) ?? '';
  }

  /** 扫 memory/ 下的文件（最多 DEPTH 层），同名的留第一个。 */
  private scan(): void {
    //M 先记下扫的时刻（find 拿它算一分钟），新表扫完再整个换上，扫的中途不动旧表。
    this.scannedAt = Date.now();
    const names = new Map<string, string>();
    const walk = (dir: string, depth: number): void => {
      //G 目录读不了（没权限、被删了）就跳过这一层，不让整次扫描失败。
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      //M 文件记进名字表（同名的留先扫到的那个）。
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
          if (!names.has(entry.name)) {
            names.set(entry.name, full);
          }
          continue;
        }

        //M 子目录没到 DEPTH 层就往下钻一层。
        if (entry.isDirectory() && depth < DEPTH) {
          walk(full, depth + 1);
        }
      }
    };

    //M 从数据目录的 memory/ 算第 1 层开始扫，扫完换上新表。
    walk(path.join(this.root, 'memory'), 1);
    this.names = names;
  }
}
