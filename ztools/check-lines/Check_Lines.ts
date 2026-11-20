/**
 * 教程行号检查：骨架逐行 JSON、教程 Markdown 里写的源码行号和代码原文，是否还对得上现在的源码。
 * 查这几样：
 *   1. 骨架逐行 JSON：分块从第 1 行连续盖到最后一行；代码原文逐行等于源码；解释里的行号在本块里；
 *      `#lines=X.json&line=N` 落在 X.json 的某一块里，链接前面反引号里的名字就在那一行。
 *   2. Markdown 代码块：头一行写 `// 路径`，下面「行号 + 制表符或两个空格 + 原文」逐行等于源码。
 *   3. 行内引用：`Sessions.ts:531`、`src7/Main.ts:78–80`、同一行前面写了文件的「第 194–213 行」不越界；
 *      旁边有反引号标出的名字，或同一份文档的代码块挪过位置时，再查它有没有漂。
 *   4. 归档文档（docs/云端/、docs/任务/、文件名带 8 位日期的）是当时的快照，只查越界。
 * 加 --fix：原文或名字能在源码里唯一定位的，改成新行号；定位不到的列出来人工处理。
 *
 * 用法：
 *   bun ztools/check-lines/Check_Lines.ts [--fix] [--all] [文件或目录…]
 * 不给文件时查 src7/docs、src7/plugins/<插件>/说明.md 和 src7/README.md；--all 连「提示」也打印。
 * 退出码：0 没有问题；1 有问题（--fix 时指改完还剩的）；2 参数不对。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';


/** 代码库根目录：本工具在 ztools/check-lines/，往上两层。 */
const CODE_ROOT = path.resolve(import.meta.dirname, '../..');

/** 骨架逐行 JSON 所在目录，相对代码库根目录。 */
const SKELETON_DIR = 'src7/docs/骨架逐行';

/** 不给参数时查的范围。插件说明在 main 里按目录补上。 */
const DEFAULT_TARGETS = ['src7/docs', 'src7/README.md'];

/** 按时间记下来的流水和问答，和归档快照一样只查越界。 */
const ARCHIVE_FILES = new Set(['src7/docs/进度.md', 'src7/docs/jm开发_问Claude.md', 'src7/docs/claude_指导意见.md']);

/** 自动生成段的起止标记：段里的内容归别的工具管，这里跳过。 */
const AUTO_START = '<!-- 自动生成 开始 -->';
const AUTO_END = '<!-- 自动生成 结束 -->';

/** 行内源码引用：文件名（可带目录）、冒号、行号，可带「–终止行」。 */
const FILE_REF = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|m?js)):(\d+)(?:[–-](\d+))?(?![\w.])/gu;

/** 紧跟在引用后面、沿用同一文件的行号，比如「`Sessions.ts:556`、`588`」「`index.ts:477、498`」里的 588、498。 */
const MORE_REF = /^`?、`?(\d+)(?:[–-](\d+))?(?![\w.:])`?/u;

/** 「第 N 行」「第 N–M 行」，文件取同一行里前面最近提到的那个。 */
const NTH_REF = /第 ?(\d+)(?:[–-](\d+))? ?行/gu;

/** 一行里提到的文件路径，给「第 N 行」找文件。 */
const PATH_MENTION = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|m?js|md|json|yaml))(?![\w])/gu;

/** 教程页内部的行号链接：[文字](#lines=X.json&line=N)。 */
const LINES_LINK = /\[([^\]\r\n]*)\]\(#lines=([^&)\s]+\.json)&line=(\d+)\)/gu;

/** ztools/doc-links 管的 `[文字](路径.ts#L行号)` 链接，这里整段跳过。 */
const DOC_LINK = /\[[^\]\r\n]*\]\([^()\s]*#L\d+\)/gu;

/** 行内代码 `…`。 */
const CODE_SPAN = /(?<!`)(`+)(.*?)\1(?!`)/gu;

/** 能拿来定位的名字：标识符，或用点连起来的类名.方法名。 */
const SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;

/** 能拿来定位的事件名：带斜杠的，比如 session/after-model。 */
const EVENT = /^[\w-]+(?:\/[\w.-]+)+$/u;

/** 代码原文的一行：前导空格、行号、制表符或两个空格、原文。 */
const EXCERPT_LINE = /^( *)(\d+)(\t|  |$)(.*)$/u;

/** 代码原文里表示「中间省略」的行。 */
const GAP_LINE = /^\s*(?:\/\/\s*)?(?:…+|\.{3}|⋯)\s*$/u;

/** 代码块头一行的源码路径注释，比如 `// node_modules/cordis/lib/index.js（cordis 4.0.0-rc.12）`。 */
const EXCERPT_HEADER = /^\/\/ ((?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|m?js))(?:（.*）)?\s*$/u;

/** 骨架逐行正文里的「L 行号」。 */
const L_TOKEN = /(?<![\w.])L(\d+)/gu;

/** 「L 行号」前面紧挨着别的文件名时，它指的是那个文件。 */
const L_FILE_PREFIX = /([A-Za-z][\w.-]*)\s*(?:的\s*)?(?:L\d+[–-])?$/u;

/**
 * 去掉后缀的文件名，「Host.ts」和「Host」算同一个文件。
 * @param file 路径或文件名。
 * @returns 不带后缀的文件名。
 */
function getStem(file: string): string {
  return path.basename(file).replace(/\.(?:tsx?|m?js)$/u, '');
}


/** 一条问题或提示。 */
export interface Problem {
  /** 相对代码库根目录的文件。 */
  file: string;
  /** 「文件:行号」或「文件#块 id」。 */
  site: string;
  /** 说明。 */
  message: string;
}

/** 一段代码原文从旧行号挪到新行号。 */
interface Shift {
  /** 源码文件，相对代码库根目录。 */
  file: string;
  /** 旧的起始行。 */
  start: number;
  /** 旧的终止行。 */
  end: number;
  /** 新行号减旧行号。 */
  delta: number;
  /** 这次已经把文档改成新行号了。 */
  applied: boolean;
}

/** 代码原文的一行。 */
interface ExcerptLine {
  /** 在代码块里的下标。 */
  index: number;
  /** 行号前的空格，有就说明行号是右对齐补齐的。 */
  pad: string;
  /** 行号和前导空格一共几个字。 */
  width: number;
  /** 行号。 */
  no: number;
  /** 行号和原文之间的分隔：制表符或两个空格。 */
  sep: string;
  /** 原文。 */
  text: string;
}

/** 骨架逐行 JSON 里的一块。 */
interface SkeletonNode {
  /** 块 id。 */
  id: string;
  /** 上级块 id，根是 null。 */
  parent: string | null;
  /** 标题，叶子块以「La–Lb」开头。 */
  title: string;
  /** 一句话概括。 */
  summary: string;
  /** 正文 Markdown。 */
  body: string;
  /** 涉及的源码文件。 */
  sources: string[];
}

/** 读进来的一份骨架逐行 JSON。 */
interface SkeletonFile {
  /** 相对代码库根目录的路径。 */
  rel: string;
  /** 原始文本，写回前对比用。 */
  raw: string;
  /** 换行符。 */
  eol: string;
  /** 重排后和原文一字不差的缩进（空格数或制表符）；找不到时为空，不敢写回。 */
  indent: number | string | undefined;
  /** 所有块。 */
  nodes: SkeletonNode[];
  /** 同名的骨架源码，比如 Sessions.json 对 src7/Sessions.ts；没有同名源码时为空。 */
  source: string | undefined;
}

/** 一块叶子的行号范围。 */
interface LeafRange {
  /** 块 id。 */
  id: string;
  /** 上级块 id。 */
  parent: string | null;
  /** 起始行。 */
  start: number;
  /** 终止行。 */
  end: number;
}

/** 一份源码里能定位的名字和它们所在的行。 */
interface SourceIndex {
  /** 类名.方法名、接口名.属性名、文件级的函数、类、类型和常量。 */
  declarations: Map<string, number[]>;
  /** 调用里作参数的事件名，比如 serial('session/request', …)。 */
  calls: Map<string, number[]>;
  /** Events 接口里声明的事件。 */
  events: Map<string, number[]>;
  /** 声明从哪行到哪行，引用指到函数体里面也算对。 */
  spans: Map<string, [number, number][]>;
}


/**
 * 往名字表里加一个位置。
 * @param table 名字表。
 * @param name 名字。
 * @param line 行号，从 1 数。
 */
function addLine(table: Map<string, number[]>, name: string, line: number): void {
  let lines = table.get(name);
  if (lines === undefined) {
    lines = [];
    table.set(name, lines);
  }
  //M 同一个名字的每处都记下，查的时候才知道是不是唯一。
  lines.push(line);
}

/**
 * 取声明的名字。
 * @param node 名字节点。
 * @returns 标识符或字符串的文字，别的返回 undefined。
 */
function getName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;

  return undefined;
}

/**
 * 算一个节点作为声明时的限定名。
 * @param node 语法节点。
 * @returns 类名.成员、接口名.成员或文件级名字；不是声明时返回 undefined。
 */
function getDeclaration(node: ts.Node): string | undefined {
  const parent = node.parent;
  const isMember = ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessor(node);
  if (isMember && ts.isClassLike(parent) && parent.name !== undefined) {
    //M 类成员用「类名.成员」记。
    const member = getName(node.name);
    if (member === undefined) return undefined;

    return parent.name.text + '.' + member;
  }
  if (ts.isConstructorDeclaration(node) && ts.isClassLike(parent) && parent.name !== undefined) {
    return parent.name.text + '.constructor';
  }
  const isSignature = ts.isPropertySignature(node) || ts.isMethodSignature(node);
  if (isSignature && ts.isInterfaceDeclaration(parent)) {
    //M 接口属性用「接口名.属性」记，事件声明另记一份。
    const member = getName(node.name);
    if (member === undefined) return undefined;

    return parent.name.text + '.' + member;
  }
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(parent)) {
    const statement = parent.parent;
    if (ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)) return getName(node.name);
  }
  if (parent === undefined || !ts.isSourceFile(parent)) return undefined;

  const isTop = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)
    || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
  if (isTop) return node.name?.text;

  return undefined;
}

/**
 * 解析一份源码，记下能定位的名字。
 * @param file 源码路径，只用来给解析器认后缀。
 * @param text 源码全文。
 * @returns 名字表。
 */
export function readIndex(file: string, text: string): SourceIndex {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const index: SourceIndex = { declarations: new Map(), calls: new Map(), events: new Map(), spans: new Map() };

  const visit = (node: ts.Node): void => {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    //M 先看它是不是声明。
    const name = getDeclaration(node);
    if (name !== undefined) {
      //M 记声明所在的行。
      addLine(index.declarations, name, line);
      const last = ast.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const spans = index.spans.get(name) ?? [];
      spans.push([line, last]);
      index.spans.set(name, spans);
    }
    if (name !== undefined && name.startsWith('Events.')) {
      //M Events 接口里的成员同时按事件名记。
      addLine(index.events, name.slice('Events.'.length), line);
    }

    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments.slice(0, 3)) {
        if (!ts.isStringLiteralLike(arg) || !EVENT.test(arg.text)) continue;

        //M 发事件、听事件、请求事件的地方按事件名记。
        addLine(index.calls, arg.text, line);
      }
    }

    ts.forEachChild(node, visit);
  };

  //M 从文件根开始走一遍语法树。
  visit(ast);
  return index;
}

/**
 * 把文本拆成行，去掉文件末尾换行留下的空行。
 * @param text 全文。
 * @returns 每行一个元素，不带换行符。
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * 在源码里找一段连续原文。
 * @param source 源码各行。
 * @param texts 要找的原文各行。
 * @returns 所有能对上的起始行（从 1 数）。
 */
export function findRun(source: string[], texts: string[]): number[] {
  const starts: number[] = [];
  if (texts.length === 0) return starts;

  for (let start = 0; start + texts.length <= source.length; start += 1) {
    const same = texts.every((text, offset) => source[start + offset] === text);
    if (!same) continue;

    //M 记下能对上的起始行。
    starts.push(start + 1);
  }
  return starts;
}

/**
 * 按挪动记录换算一个旧行号。
 * @param no 旧行号。
 * @param shifts 挪动记录。
 * @returns 新行号；不在任何一段里，或几段说法不一时返回 undefined。
 */
export function mapLine(no: number, shifts: Shift[]): number | undefined {
  const deltas = new Set<number>();
  for (const shift of shifts) {
    if (no < shift.start || no > shift.end) continue;

    deltas.add(shift.delta);
  }
  if (deltas.size !== 1) return undefined;

  const [delta] = deltas;
  return no + delta;
}

/**
 * 没有名字可查的行号，按前后最近两段代码原文的挪动推算。
 * @param no 旧行号。
 * @param shifts 同一文件的挪动记录。
 * @returns 推得出的挪动量；推不出时返回 undefined。
 */
export function inferDelta(no: number, shifts: Shift[]): number | undefined {
  //M 落在某段原文里就用那段的挪动量。
  const inside = mapLine(no, shifts);
  if (inside !== undefined) return inside - no;

  let below: Shift | undefined;
  let above: Shift | undefined;
  for (const shift of shifts) {
    if (shift.end < no && (below === undefined || shift.end > below.end)) {
      below = shift;
    }
    if (shift.start > no && (above === undefined || shift.start < above.start)) {
      above = shift;
    }
  }
  if (below === undefined || above === undefined) return undefined;
  if (below.delta !== above.delta) return undefined;

  return below.delta;
}

/**
 * 判断一份文档是不是归档快照。
 * @param rel 相对代码库根目录的路径。
 * @returns 是归档就返回 true。
 */
export function isArchive(rel: string): boolean {
  if (rel.startsWith('src7/docs/云端/')) return true;
  if (rel.startsWith('src7/docs/任务/')) return true;
  if (ARCHIVE_FILES.has(rel)) return true;

  return /\d{8}/u.test(path.basename(rel));
}

/**
 * 按原来的对齐方式写一个行号。
 * @param line 原来那一行。
 * @param no 新行号。
 * @returns 写好的行。
 */
function formatExcerptLine(line: ExcerptLine, no: number): string {
  let label = String(no);
  if (line.pad !== '') {
    label = label.padStart(line.width);
  }
  return label + line.sep + line.text;
}

/** 引用旁边能拿来定位、核对的名字。 */
export interface Hints {
  /** 紧挨着引用的那个名字，--fix 只按它找新位置。 */
  primary: string | undefined;
  /** 同一对全角括号里的其他名字，只用来确认那一行对不对。 */
  extra: string[];
}

/**
 * 把反引号里的文字整理成名字；不像名字的返回 undefined。
 * @param raw 反引号里的文字。
 * @returns 名字。
 */
function getHintName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;

  const name = raw.trim().replace(/\(\)$/u, '');
  if (name.includes('.ts') || name.includes('.js')) return undefined;
  if (SYMBOL.test(name) || EVENT.test(name)) return name;

  return undefined;
}

/**
 * 取一个引用旁边反引号里的名字。
 * @param line 引用所在的那行。
 * @param start 引用在行里的起点。
 * @param end 引用在行里的终点。
 * @returns 紧挨着的名字和同一对括号里的其他名字。
 */
export function getHints(line: string, start: number, end: number): Hints {
  let left = start;
  let right = end;
  for (const span of line.matchAll(CODE_SPAN)) {
    const spanEnd = span.index + span[0].length;
    if (span.index > start || spanEnd < end) continue;

    left = span.index;
    right = spanEnd;
  }
  const before = /`([^`]+)`[ \t，,：:（(]*$/u.exec(line.slice(0, left));
  const after = /^[ \t（(]*`([^`]+)`/u.exec(line.slice(right));
  //M 左边紧挨着的优先，没有再看右边。
  const primary = getHintName(before?.[1]) ?? getHintName(after?.[1]);

  const extra: string[] = [];
  const open = line.lastIndexOf('（', left);
  const close = line.indexOf('）', right);
  if (open < 0 || close < 0 || line.lastIndexOf('）', left) > open) return { primary, extra };

  for (const span of line.slice(open, close).matchAll(CODE_SPAN)) {
    //M 括号里别的反引号名字，比如「（`ChannelTools.ts:356` 调 `requestChannelReply`）」。
    const name = getHintName(span[2]);
    if (name === undefined || name === primary) continue;

    //M 记进只用来核对的名字。
    extra.push(name);
  }
  return { primary, extra };
}

/** 太常见的方法名：名字以它结尾时，再看前一段。 */
const GENERIC_METHODS = new Set(['push', 'get', 'set', 'has', 'add', 'delete', 'map', 'filter', 'forEach', 'call']);

/**
 * 取一个名字在源码行里要能看到的部分。
 * @param hint 名字。
 * @returns 事件名原样；类名.方法名取最后一段，最后一段太常见时连前一段也算。
 */
function getHintKeys(hint: string): string[] {
  if (EVENT.test(hint)) return [hint];

  const parts = hint.split('.');
  const keys = [parts[parts.length - 1]];
  if (parts.length > 1 && GENERIC_METHODS.has(keys[0])) {
    //M 前一段也拿来核对。
    keys.push(parts[parts.length - 2]);
  }
  return keys;
}


/** 一次检查：读源码、查文档，--fix 时把能定位的改掉。 */
export class LineChecker {
  /** 问题：会让退出码变成 1。 */
  readonly errors: Problem[] = [];

  /** 提示：定位不到但不一定错的，只在 --all 时打印。 */
  readonly warnings: Problem[] = [];

  /** --fix 改了的地方，一处一行。 */
  readonly changes: string[] = [];

  /** --fix 没能写回的文件，退出码算问题。 */
  readonly writeErrors: string[] = [];

  /** 读过的源码，读不到记 null。 */
  private readonly sources = new Map<string, string[] | null>();

  /** 解析过的源码名字表。 */
  private readonly indexes = new Map<string, SourceIndex>();

  /** 骨架逐行 JSON 里的代码原文按源码文件记下的挪动。 */
  private readonly fileShifts = new Map<string, Shift[]>();

  /** 骨架逐行 JSON 各块的行号范围，按 JSON 文件名记。 */
  private readonly leafRanges = new Map<string, LeafRange[]>();

  /** 代码库里的源码文件，给不带目录的文件名找全路径。 */
  private allFiles: string[] | undefined;

  /** 这次要报告、要写回的文件。 */
  private targets = new Set<string>();

  /**
   * @param root 代码库根目录。
   * @param fix 为 true 时把能定位的行号改掉并写回。
   */
  constructor(private readonly root: string, private readonly fix: boolean) {}

  /**
   * 查一批文件。
   * @param files 相对代码库根目录的 Markdown 和骨架逐行 JSON。
   */
  run(files: string[]): void {
    this.targets = new Set(files);
    //M 骨架逐行 JSON 总是全部读进来：别的文档里的 #lines 链接要靠它们的分块核对。
    const skeletons = this.readSkeletons();
    for (const skeleton of skeletons) {
      //M 先核对代码原文和分块，把挪动记下来给后面的链接和行内引用用。
      this.checkSkeleton(skeleton);
    }
    for (const skeleton of skeletons) {
      //M 再核对正文里的链接和行内引用。
      this.checkSkeletonRefs(skeleton);
      //M 有改动的写回。
      this.writeSkeleton(skeleton);
    }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      //M 一份份查 Markdown。
      this.checkMarkdown(file);
    }
  }

  /**
   * 记一条问题或提示；不在这次范围里的文件不记。
   * @param kind error 或 warning。
   * @param file 文件。
   * @param site 位置。
   * @param message 说明。
   */
  private report(kind: 'error' | 'warning', file: string, site: string, message: string): void {
    if (!this.targets.has(file)) return;

    const problem = { file, site, message };
    if (kind === 'error') {
      //M 记进问题清单。
      this.errors.push(problem);
      return;
    }
    //M 记进提示清单。
    this.warnings.push(problem);
  }

  /**
   * 读源码各行，读过的直接用。
   * @param rel 相对代码库根目录的路径。
   * @returns 各行；文件不在时返回 undefined。
   */
  private getLines(rel: string): string[] | undefined {
    //G 源码路径必须留在仓库内，不读取文档指向的外部文件。
    const relative = path.relative(this.root, path.resolve(this.root, rel));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;

    //M 先看读过没有。
    const cached = this.sources.get(rel);
    if (cached === null) return undefined;
    if (cached !== undefined) return cached;

    const full = path.join(this.root, rel);
    //G Windows 上文件名不分大小写，plugins/index.ts 会读到 plugins/Index.ts，这里按原样比一次文件名。
    const exact = fs.existsSync(full) && fs.readdirSync(path.dirname(full)).includes(path.basename(full));
    if (!exact || !fs.statSync(full).isFile()) {
      this.sources.set(rel, null);
      return undefined;
    }
    //M 读进来拆成行，去掉末尾换行。
    const lines = splitLines(fs.readFileSync(full, 'utf8'));
    this.sources.set(rel, lines);
    return lines;
  }

  /**
   * 取源码的名字表，解析过的直接用。
   * @param rel 源码路径。
   * @returns 名字表；文件不在时返回 undefined。
   */
  private getIndex(rel: string): SourceIndex | undefined {
    //M 先看解析过没有。
    const cached = this.indexes.get(rel);
    if (cached !== undefined) return cached;

    //M 先确认文件在。
    const lines = this.getLines(rel);
    if (lines === undefined) return undefined;

    //M 解析语法树记名字。
    const index = readIndex(rel, lines.join('\n'));
    this.indexes.set(rel, index);
    return index;
  }

  /**
   * 列出 src7、web/src 和 Cordis 的源码文件，给只写了文件名的引用找全路径。
   * @returns 相对代码库根目录的路径。
   */
  private listFiles(): string[] {
    if (this.allFiles !== undefined) return this.allFiles;

    const found: string[] = [];
    const walk = (dir: string): void => {
      const full = path.join(this.root, dir);
      if (!fs.existsSync(full)) return;

      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

        const rel = dir + '/' + entry.name;
        if (entry.isDirectory()) {
          //M 子目录接着往下找。
          walk(rel);
          continue;
        }
        if (!/\.(?:tsx?|m?js)$/u.test(entry.name)) continue;

        //M 记下这个源码文件。
        found.push(rel);
      }
    };
    //M 只找项目自己的源码目录。
    walk('src7');
    //M 网页的源码也在文档里引用。
    walk('web/src');
    this.allFiles = found;
    return found;
  }

  /**
   * 把文档里写的文件名换成相对代码库根目录的路径。
   * @param ref 文档里写的，比如 Sessions.ts、bots/index.ts、src7/Main.ts。
   * @param doc 文档路径，插件说明里的 index.ts 先找本插件。
   * @param shifts 同一文档代码原文的挪动，代码块头写过的文件优先。
   * @returns 找到的路径；找不到或有多个时返回 undefined。
   */
  private resolveFile(ref: string, doc: string, shifts: Shift[]): string | undefined {
    const tops = ['src7/', 'web/', 'ztools/', 'node_modules/', 'scripts/', 'external/'];
    if (tops.some((top) => ref.startsWith(top))) {
      //G 带了顶层目录的就是全路径。
      if (this.getLines(ref) === undefined) return undefined;

      return ref;
    }
    //M 同一文档的代码块头写过的文件，文件名对得上且唯一就用它，比如讲 approval 的一块里写的 index.ts。
    const shown = [...new Set(shifts.map((shift) => shift.file))].filter((file) => file.endsWith('/' + ref));
    if (shown.length === 1) return shown[0];

    const plugin = /^src7\/plugins\/([^/]+)\//u.exec(doc);
    const guesses: string[] = [];
    if (plugin !== null) {
      //M 插件说明里的文件名先找本插件。
      guesses.push('src7/plugins/' + plugin[1] + '/' + ref);
    }
    if (ref.includes('/')) {
      //M 带了插件目录的，比如 bots/index.ts。
      guesses.push('src7/' + ref, 'src7/plugins/' + ref);
    }
    for (const guess of guesses) {
      //M 先按常见位置猜。
      if (this.getLines(guess) !== undefined) return guess;
    }
    //M 猜不中再按文件名结尾找，唯一才算。
    const matches = this.listFiles().filter((file) => file.endsWith('/' + ref));
    if (matches.length !== 1) return undefined;

    return matches[0];
  }

  /**
   * 在源码里定位一个名字。
   * @param file 源码路径。
   * @param hint 名字。
   * @returns 唯一的行号；找不到或有多处时返回 undefined。
   */
  private locate(file: string, hint: string): number | undefined {
    //M 只有 TS、JS 能解析。
    const index = this.getIndex(file);
    if (index === undefined) return undefined;

    const keys = [...index.declarations.keys()];
    const lower = hint.toLowerCase();
    //M 先按声明找。
    const declared = index.declarations.get(hint);
    //M 再按发事件、听事件的调用找。
    const called = index.calls.get(hint);
    //M 最后按 Events 接口里的事件声明找。
    const event = index.events.get(hint);
    const tries: (number[] | undefined)[] = [declared, called, event];
    if (hint.includes('.')) {
      //M 「sessions.find」这种实例名，按不分大小写配「Sessions.find」。
      tries.push(keys.filter((key) => key.toLowerCase() === lower).flatMap((key) => index.declarations.get(key) ?? []));
    }
    const parts = hint.split('.');
    const generic = parts.length > 1 && GENERIC_METHODS.has(parts[parts.length - 1]);
    if (generic) {
      //M 写的是「属性.push」这种，按属性名去配声明。
      const part = parts[parts.length - 2];
      const lines = keys.filter((key) => key === part || key.endsWith('.' + part));
      tries.push(lines.flatMap((key) => index.declarations.get(key) ?? []));
    }
    for (const lines of tries) {
      if (lines === undefined || lines.length === 0) continue;
      if (lines.length !== 1) return undefined;

      return lines[0];
    }
    return undefined;
  }

  /**
   * 判断几行源码里看不看得到这些名字；类名指到它的构造函数也算。
   * @param file 源码路径。
   * @param from 起始行。
   * @param to 终止行。
   * @param hints 名字。
   * @returns 看得到就返回 true。
   */
  private isShown(file: string, from: number, to: number, hints: string[]): boolean {
    //M 取这份源码的各行。
    const code = this.getLines(file) ?? [];
    const shown = code.slice(from - 1, to);
    for (const hint of hints) {
      //M 每个名字要看到的那几段。
      const keys = getHintKeys(hint);
      if (shown.some((text) => keys.some((key) => text.includes(key)))) return true;

      const index = this.getIndex(file);
      const ctor = index?.declarations.get(hint + '.constructor') ?? [];
      if (ctor.some((line) => line >= from && line <= to)) return true;

      //M 指到这个函数（或类）里面的某一行也对。
      const lower = hint.toLowerCase();
      const spans = [...(index?.spans.entries() ?? [])].filter(([name]) => name.toLowerCase() === lower);
      const inside = spans.some(([, list]) => list.some(([first, last]) => from >= first && to <= last));
      if (inside) return true;
    }
    return false;
  }

  /**
   * 核对一个代码块里的代码原文，--fix 时把能唯一定位的改成新行号。
   * @param lines 代码块里各行（不含围栏），--fix 时原地改。
   * @param fallback 代码块没写 `// 路径` 时用的源码。
   * @param file 文档路径。
   * @param site 报告用的位置。
   * @returns 每段原文的挪动记录。
   */
  private checkExcerpt(lines: string[], fallback: string | undefined, file: string, site: string): Shift[] {
    const shifts: Shift[] = [];
    if (lines.length === 0) return shifts;

    let source = fallback;
    let first = 0;
    const header = EXCERPT_HEADER.exec(lines[0]);
    if (header !== null) {
      source = header[1];
      first = 1;
    }
    if (source === undefined) return shifts;

    //M 按省略行把代码块切成几段连续的原文；有一行不像原文就整块不当代码原文看。
    const runs: ExcerptLine[][] = [[]];
    for (let index = first; index < lines.length; index += 1) {
      if (GAP_LINE.test(lines[index])) {
        runs.push([]);
        continue;
      }
      const match = EXCERPT_LINE.exec(lines[index]);
      if (match === null) return shifts;

      const width = match[1].length + match[2].length;
      const line = { index, pad: match[1], width, no: Number(match[2]), sep: match[3], text: match[4] };
      const run = runs[runs.length - 1];
      const previous = run[run.length - 1];
      if (previous !== undefined && previous.no + 1 !== line.no) {
        //M 行号跳了就是另一段原文，比如「L600–L611、L345–L355」写在一个代码块里。
        runs.push([line]);
        continue;
      }
      //M 接在同一段原文后面。
      run.push(line);
    }

    //M 读这段原文对应的源码。
    const code = this.getLines(source);
    if (code === undefined) {
      //M 源码不在这台机器上时没法核对。
      this.report('warning', file, site, '找不到源码 ' + source + '，没核对代码原文');
      return shifts;
    }

    for (const run of runs) {
      if (run.length === 0) continue;

      const start = run[0].no;
      const end = run[run.length - 1].no;
      const texts = run.map((line) => line.text);
      const same = texts.every((text, offset) => code[start - 1 + offset] === text);
      if (same) {
        //M 原文对得上，挪动量记 0。
        shifts.push({ file: source, start, end, delta: 0, applied: false });
        continue;
      }

      //M 原文对不上：到源码里找这段原文现在在哪。
      const found = findRun(code, texts);
      const range = 'L' + String(start) + '–L' + String(end);
      if (found.length === 0) {
        this.report('error', file, site, source + ' ' + range + ' 的代码原文在源码里找不到，要人工重写');
        continue;
      }
      if (found.length > 1) {
        const where = found.map((no) => 'L' + String(no)).join('、');
        this.report('error', file, site, source + ' ' + range + ' 的代码原文在源码里有多处：' + where);
        continue;
      }

      const delta = found[0] - start;
      const moved = 'L' + String(start + delta) + '–L' + String(end + delta);
      if (!this.fix) {
        //M 记一条问题，交给人工处理。
        this.report('error', file, site, source + ' ' + range + ' 的代码原文现在在 ' + moved);
        //M 只记挪动量，没改文档（校验模式）。
        shifts.push({ file: source, start, end, delta, applied: false });
        continue;
      }
      for (const line of run) {
        //M 按原来的对齐方式换成新行号。
        lines[line.index] = formatExcerptLine(line, line.no + delta);
      }
      //M 记下这处改动，最后打印出来。
      this.changes.push(site + '  ' + source + ' 代码原文 ' + range + ' → ' + moved);
      //M 记下已改好的挪动。
      shifts.push({ file: source, start, end, delta, applied: true });
    }
    return shifts;
  }

  /**
   * 读骨架逐行目录下所有 JSON。
   * @returns 读到的文件。
   */
  private readSkeletons(): SkeletonFile[] {
    const dir = path.join(this.root, SKELETON_DIR);
    if (!fs.existsSync(dir)) return [];

    const skeletons: SkeletonFile[] = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;

      const rel = SKELETON_DIR + '/' + name;
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      let eol = '\n';
      if (raw.includes('\r\n')) {
        eol = '\r\n';
      }
      const nodes = JSON.parse(raw) as SkeletonNode[];
      //G 只有重排后一字不差的才写回，免得改掉别人的排版；缩进有用 2 格的，也有 1 格的。
      const indent = [2, 1, 4, '\t'].find((item) => this.serialize(nodes, item, eol, raw.endsWith('\n')) === raw);
      let source: string | undefined = 'src7/' + name.replace(/\.json$/u, '.ts');
      //M 有同名骨架源码的才查分块覆盖。
      if (this.getLines(source) === undefined) {
        source = undefined;
      }
      //M 记下这份 JSON。
      skeletons.push({ rel, raw, eol, indent, nodes, source });
    }
    return skeletons;
  }

  /**
   * 按骨架逐行 JSON 的写法排版：不转义中文。
   * @param nodes 所有块。
   * @param indent 缩进。
   * @param eol 换行符。
   * @param trailing 末尾要不要换行。
   * @returns 文本。
   */
  private serialize(nodes: SkeletonNode[], indent: number | string, eol: string, trailing: boolean): string {
    let text = JSON.stringify(nodes, null, indent).split('\n').join(eol);
    if (trailing) {
      text += eol;
    }
    return text;
  }

  /**
   * 把一段文字里的「L 行号」按挪动记录换掉。
   * @param text 文字。
   * @param shifts 已改好的挪动记录。
   * @returns 换好的文字。
   */
  private shiftTokens(text: string, shifts: Shift[]): string {
    //M 只用已经改好、真挪了的。
    const applied = shifts.filter((shift) => shift.applied && shift.delta !== 0);
    if (applied.length === 0) return text;

    return text.replace(L_TOKEN, (token: string, digits: string, offset: number) => {
      let candidates = applied;
      const prefix = L_FILE_PREFIX.exec(text.slice(0, offset));
      if (prefix !== null) {
        //G 前面写了文件名的，只认那个文件的挪动。
        candidates = applied.filter((shift) => getStem(shift.file) === getStem(prefix[1]));
      }
      //M 换算成新行号，换算不了的原样留着。
      const next = mapLine(Number(digits), candidates);
      if (next === undefined) return token;

      return 'L' + String(next);
    });
  }

  /**
   * 核对一份骨架逐行 JSON 的代码原文、行号和分块覆盖。
   * @param skeleton 读进来的 JSON。
   */
  private checkSkeleton(skeleton: SkeletonFile): void {
    const leaves: LeafRange[] = [];
    const fileLevel: Shift[] = [];
    for (const node of skeleton.nodes) {
      //M 一块一块查代码原文和本块的行号。
      const leaf = this.checkSkeletonNode(skeleton, node, fileLevel);
      if (leaf !== undefined) {
        leaves.push(leaf);
      }
    }
    const name = path.basename(skeleton.rel);
    this.leafRanges.set(name, leaves);
    if (skeleton.source === undefined) return;

    this.fileShifts.set(skeleton.source, fileLevel);
    //M 分组和根的标题、目录里的行号跟着各块挪。
    this.shiftGroups(skeleton, fileLevel);
    //M 查分块有没有连续盖住整个文件。
    this.checkCoverage(skeleton, leaves);
  }

  /**
   * 核对一块：代码原文、标题和「行号：」、解释里的行号。
   * @param skeleton 所在 JSON。
   * @param node 这一块。
   * @param fileLevel 收集同名源码的挪动记录。
   * @returns 简单叶子块（同名源码、一段原文）的范围，别的返回 undefined。
   */
  private checkSkeletonNode(skeleton: SkeletonFile, node: SkeletonNode, fileLevel: Shift[]): LeafRange | undefined {
    const site = skeleton.rel + '#' + node.id;
    const lines = node.body.split('\n');
    const shifts: Shift[] = [];
    let open = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith('```')) continue;
      if (open < 0) {
        open = index;
        continue;
      }
      const block = lines.slice(open + 1, index);
      //M 核对这个代码块的原文。
      const found = this.checkExcerpt(block, skeleton.source, skeleton.rel, site);
      lines.splice(open + 1, block.length, ...block);
      shifts.push(...found);
      open = -1;
    }
    if (shifts.length === 0) return undefined;

    //M 行号和解释跟着原文挪。
    this.shiftNodeText(lines, shifts);
    node.body = lines.join('\n');
    node.title = this.shiftTokens(node.title, shifts);

    const current = shifts.map((shift) => {
      let delta = 0;
      if (shift.applied) {
        delta = shift.delta;
      }
      return { file: shift.file, start: shift.start + delta, end: shift.end + delta };
    });
    //M 解释里的行号要落在本块的原文里。
    this.checkExplain(lines, current, skeleton.rel, site);

    //M 本块里属于同名源码的那几段。
    const own = current.filter((range) => range.file === skeleton.source);
    if (skeleton.source === undefined || own.length !== 1 || own.length !== current.length) return undefined;

    //M 这一块的挪动也算进整份源码的挪动。
    fileLevel.push(...shifts);
    const leaf = { id: node.id, parent: node.parent, start: own[0].start, end: own[0].end };
    const label = /\*\*行号：L(\d+)(?:–L(\d+))?\*\*/u.exec(node.body);
    const title = /^L(\d+)(?:–L(\d+))?/u.exec(node.title);
    const rangeText = 'L' + String(leaf.start) + '–L' + String(leaf.end);
    if (label === null || Number(label[1]) !== leaf.start || Number(label[2] ?? label[1]) !== leaf.end) {
      //M 记一条问题，交给人工处理。
      this.report('error', skeleton.rel, site, '「行号：」和代码原文的 ' + rangeText + ' 不符');
    }
    if (title === null || Number(title[1]) !== leaf.start || Number(title[2] ?? title[1]) !== leaf.end) {
      //M 记一条问题，交给人工处理。
      this.report('error', skeleton.rel, site, '标题的行号和代码原文的 ' + rangeText + ' 不符');
    }
    return leaf;
  }

  /**
   * 把一块正文里「行号：」那行和「解释」一节的行号按挪动换掉。
   * @param lines 正文各行，原地改。
   * @param shifts 这一块的挪动记录。
   */
  private shiftNodeText(lines: string[], shifts: Shift[]): void {
    let explain = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith('### ')) {
        explain = line === '### 解释';
        continue;
      }
      if (!explain && !line.startsWith('**行号：')) continue;

      //M 只换行号那行和解释里的。
      lines[index] = this.shiftTokens(line, shifts);
    }
  }

  /**
   * 查「解释」一节里没写别的文件的行号，是否都在本块的原文里。
   * @param lines 正文各行。
   * @param ranges 本块各段原文现在的范围。
   * @param file JSON 路径。
   * @param site 报告用的位置。
   */
  private checkExplain(
    lines: string[],
    ranges: { file: string; start: number; end: number }[],
    file: string,
    site: string,
  ): void {
    let explain = false;
    for (const line of lines) {
      if (line.startsWith('### ')) {
        explain = line === '### 解释';
        continue;
      }
      if (!explain) continue;

      for (const token of line.matchAll(L_TOKEN)) {
        const prefix = L_FILE_PREFIX.exec(line.slice(0, token.index));
        let candidates = ranges;
        if (prefix !== null) {
          //M 只看那个文件的原文。
          candidates = ranges.filter((range) => getStem(range.file) === getStem(prefix[1]));
        }
        //G 写的是别的文件的行号，不归本块管。
        if (prefix !== null && candidates.length === 0) continue;

        const no = Number(token[1]);
        if (candidates.some((range) => no >= range.start && no <= range.end)) continue;

        //M 条目开头「- Lx–Ly：」这种是在讲本块的行，必须在块里；句子中间顺带提的别处只给提示。
        const before = line.slice(0, token.index);
        const after = line.slice(token.index + token[0].length);
        const leading = /^\s*-\s*(?:L\d+[–-])?$/u.test(before) || /^(?:[–-]L\d+)?：/u.test(after);
        if (leading) {
          this.report('error', file, site, '解释里的 L' + token[1] + ' 不在本块的代码原文里');
          continue;
        }
        //M 记一条提示，不影响退出码。
        this.report('warning', file, site, '解释里顺带提到的 L' + token[1] + ' 不在本块里，确认指的是别处');
      }
    }
  }

  /**
   * 分组块和根块的标题、正文里的行号跟着各叶子块挪；根块的「共 N 行」改成现在的行数。
   * @param skeleton 所在 JSON。
   * @param shifts 同名源码所有叶子块的挪动记录。
   */
  private shiftGroups(skeleton: SkeletonFile, shifts: Shift[]): void {
    //M 同名源码现在的行数。
    const total = this.getLines(skeleton.source ?? '')?.length ?? 0;
    for (const node of skeleton.nodes) {
      if (node.body.includes('**行号：')) continue;

      //M 分组的标题和目录。
      node.title = this.shiftTokens(node.title, shifts);
      node.body = this.shiftTokens(node.body, shifts);
      if (!this.fix) continue;

      const site = skeleton.rel + '#' + node.id;
      const counted = (text: string): string => text.replace(/共 (\d+) 行/gu, (all: string, digits: string) => {
        if (Number(digits) === total) return all;

        //M 记下这处改动，最后打印出来。
        this.changes.push(site + '  共 ' + digits + ' 行 → 共 ' + String(total) + ' 行');
        return '共 ' + String(total) + ' 行';
      });
      //M 根块写的总行数。
      node.title = counted(node.title);
      node.body = counted(node.body);
    }
  }

  /**
   * 查分块覆盖：顶层叶子从第 1 行连续盖到最后一行，子块连续盖住上级块，分组标题等于它下面各块的范围。
   * @param skeleton 所在 JSON。
   * @param leaves 简单叶子块。
   */
  private checkCoverage(skeleton: SkeletonFile, leaves: LeafRange[]): void {
    //M 同名源码现在的行数。
    const total = this.getLines(skeleton.source ?? '')?.length ?? 0;
    const ids = new Set(leaves.map((leaf) => leaf.id));
    //M 上级不是叶子的就是顶层叶子。
    const top = leaves.filter((leaf) => leaf.parent === null || !ids.has(leaf.parent));
    //M 顶层叶子盖住整个文件。
    this.checkTiling(skeleton.rel, skeleton.rel, top, 1, total);
    for (const leaf of leaves) {
      const children = leaves.filter((child) => child.parent === leaf.id);
      if (children.length === 0) continue;

      //M 有子块的，子块盖住它。
      this.checkTiling(skeleton.rel, skeleton.rel + '#' + leaf.id, children, leaf.start, leaf.end);
    }

    for (const node of skeleton.nodes) {
      if (node.body.includes('**行号：')) continue;

      const site = skeleton.rel + '#' + node.id;
      const counted = /共 (\d+) 行/u.exec(node.title + node.body);
      if (counted !== null && Number(counted[1]) !== total) {
        //M 记一条问题，交给人工处理。
        this.report('error', skeleton.rel, site, '写的共 ' + counted[1] + ' 行，源码现在 ' + String(total) + ' 行');
      }
      const title = /^L(\d+)–L(\d+)/u.exec(node.title);
      if (title === null) continue;

      //M 分组下面的顶层叶子，算出它们盖住的范围。
      const inside = top.filter((leaf) => this.isUnder(skeleton.nodes, leaf.id, node.id));
      if (inside.length === 0) continue;

      const start = Math.min(...inside.map((leaf) => leaf.start));
      const end = Math.max(...inside.map((leaf) => leaf.end));
      if (Number(title[1]) === start && Number(title[2]) === end) continue;

      const range = 'L' + String(start) + '–L' + String(end);
      //M 记一条问题，交给人工处理。
      this.report('error', skeleton.rel, site, '分组标题 ' + title[0] + ' 和下面各块的 ' + range + ' 不符');
    }
  }

  /**
   * 判断一块是不是在某个分组下面。
   * @param nodes 所有块。
   * @param id 要判断的块。
   * @param group 分组块。
   * @returns 在下面就返回 true。
   */
  private isUnder(nodes: SkeletonNode[], id: string, group: string): boolean {
    //M 往上找上级块。
    let current = nodes.find((node) => node.id === id)?.parent ?? null;
    while (current !== null) {
      if (current === group) return true;

      const parent = current;
      //M 往上找上级块。
      current = nodes.find((node) => node.id === parent)?.parent ?? null;
    }
    return false;
  }

  /**
   * 查一组块是否从 start 连续盖到 end，不重叠、不留空。
   * @param file JSON 路径。
   * @param site 报告用的位置。
   * @param leaves 这组块。
   * @param start 要盖住的起始行。
   * @param end 要盖住的终止行。
   */
  private checkTiling(file: string, site: string, leaves: LeafRange[], start: number, end: number): void {
    const sorted = [...leaves].sort((a, b) => a.start - b.start);
    let expected = start;
    for (const leaf of sorted) {
      if (leaf.start > expected) {
        const gap = 'L' + String(expected) + '–L' + String(leaf.start - 1);
        //M 记一条问题，交给人工处理。
        this.report('error', file, site, gap + ' 没有块盖住');
      }
      if (leaf.start < expected) {
        //M 记一条问题，交给人工处理。
        this.report('error', file, site + '#' + leaf.id, 'L' + String(leaf.start) + ' 起和前一块重叠');
      }
      expected = Math.max(expected, leaf.end + 1);
    }
    if (expected - 1 === end) return;

    const tail = 'L' + String(expected) + '–L' + String(end);
    if (expected - 1 < end) {
      //M 记一条问题，交给人工处理。
      this.report('error', file, site, tail + ' 没有块盖住（源码共 ' + String(end) + ' 行）');
      return;
    }
    //M 记一条问题，交给人工处理。
    this.report('error', file, site, '分块盖到 L' + String(expected - 1) + '，超出了 L' + String(end));
  }

  /**
   * 核对一份骨架逐行 JSON 正文里的 #lines 链接和行内引用。
   * @param skeleton 所在 JSON。
   */
  private checkSkeletonRefs(skeleton: SkeletonFile): void {
    for (const node of skeleton.nodes) {
      const site = skeleton.rel + '#' + node.id;
      const lines = node.body.split('\n');
      let fenced = false;
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].startsWith('```')) {
          fenced = !fenced;
          continue;
        }
        if (fenced) continue;

        //M 代码块外的每一行查链接和引用。
        lines[index] = this.checkRefLine(lines[index], skeleton.rel, site, [], false);
      }
      node.body = lines.join('\n');
    }
  }

  /**
   * 有改动的骨架逐行 JSON 写回。
   * @param skeleton 所在 JSON。
   */
  private writeSkeleton(skeleton: SkeletonFile): void {
    if (!this.fix || !this.targets.has(skeleton.rel)) return;

    //M 内容没变就不用写。
    const original = JSON.stringify(JSON.parse(skeleton.raw));
    if (JSON.stringify(skeleton.nodes) === original) return;
    if (skeleton.indent === undefined) {
      //G 排版认不出就不写，免得改掉别人的排版。
      this.writeErrors.push(skeleton.rel + '  排版认不出（缩进或转义和标准写法不同），改动没写回，要人工处理');
      return;
    }
    //M 按原来的缩进、换行和末尾写法重排。
    const text = this.serialize(skeleton.nodes, skeleton.indent, skeleton.eol, skeleton.raw.endsWith('\n'));
    if (text === skeleton.raw) return;

    //M 写回前再读一次，别盖掉并行的改动。
    this.writeFile(skeleton.rel, skeleton.raw, text);
  }

  /**
   * 写回一个文件；读到的已经不是开头那份时不写，记一条问题。
   * @param rel 相对代码库根目录的路径。
   * @param before 开头读到的内容。
   * @param after 要写的内容。
   */
  private writeFile(rel: string, before: string, after: string): void {
    const full = path.join(this.root, rel);
    if (fs.readFileSync(full, 'utf8') !== before) {
      //M 记下没写回的文件，改完重查时也要打印。
      this.writeErrors.push(rel + '  文件被别人同时改了，没写回，请重跑');
      return;
    }
    fs.writeFileSync(full, after, 'utf8');
  }

  /**
   * 核对一份 Markdown：代码块原文、#lines 链接、行内引用，--fix 时改好写回。
   * @param rel 相对代码库根目录的路径。
   */
  private checkMarkdown(rel: string): void {
    const raw = fs.readFileSync(path.join(this.root, rel), 'utf8');
    const parts = raw.split(/(\r?\n)/u);
    const live = !isArchive(rel);
    const docShifts: Shift[] = [];
    const prose: number[] = [];
    let auto = false;
    let open = -1;
    for (let index = 0; index < parts.length; index += 2) {
      const trimmed = parts[index].trim();
      if (open >= 0 && /^ {0,3}```\s*$/u.test(parts[index])) {
        //M 一个代码块收齐了，归档文档的不核对原文。
        if (live) {
          docShifts.push(...this.checkMarkdownBlock(parts, open, index, rel));
        }
        open = -1;
        continue;
      }
      if (open >= 0) continue;
      if (/^ {0,3}```/u.test(parts[index])) {
        open = index;
        continue;
      }
      if (trimmed === AUTO_START) {
        auto = true;
        continue;
      }
      if (trimmed === AUTO_END) {
        auto = false;
        continue;
      }
      if (auto) continue;

      //M 记下这行，代码块都看完后再查行内引用。
      prose.push(index);
    }
    for (const index of prose) {
      const site = rel + ':' + String(index / 2 + 1);
      //M 代码块外的每一行查链接和引用。
      parts[index] = this.checkRefLine(parts[index], rel, site, docShifts, live);
    }

    const text = parts.join('');
    if (!this.fix || text === raw) return;

    //M 写回前再读一次，别盖掉并行的改动。
    this.writeFile(rel, raw, text);
  }

  /**
   * 核对 Markdown 里一个代码块的原文。
   * @param parts 按换行拆开的文档（偶数下标是行），原地改。
   * @param open 开围栏所在下标。
   * @param close 关围栏所在下标。
   * @param rel 文档路径。
   * @returns 这块原文的挪动记录。
   */
  private checkMarkdownBlock(parts: string[], open: number, close: number, rel: string): Shift[] {
    const block: string[] = [];
    for (let index = open + 2; index < close; index += 2) {
      //M 取出代码块里的一行。
      block.push(parts[index]);
    }
    const site = rel + ':' + String(open / 2 + 1);
    //M Markdown 的代码块必须自己写 `// 路径` 才当代码原文。
    const shifts = this.checkExcerpt(block, undefined, rel, site);
    for (let offset = 0; offset < block.length; offset += 1) {
      parts[open + 2 + offset * 2] = block[offset];
    }
    return shifts;
  }

  /**
   * 核对一行文字里的 #lines 链接和行内引用，--fix 时返回改好的行。
   * @param line 这一行。
   * @param doc 文档路径。
   * @param site 报告用的位置。
   * @param docShifts 同一文档里代码原文的挪动，给没有名字的引用推算。
   * @param live 不是归档文档时才查漂移。
   * @returns 这一行（--fix 时是改好的）。
   */
  private checkRefLine(line: string, doc: string, site: string, docShifts: Shift[], live: boolean): string {
    //M 先换 #lines 链接。
    let next = line.replace(LINES_LINK, (all: string, label: string, json: string, digits: string, offset: number) => {
      const fixed = this.checkLinesLink(line, offset, json, Number(digits), doc, site);
      if (fixed === undefined) return all;

      const nextLabel = label.replace(new RegExp('(?<=L|:)' + digits + '(?!\\d)', 'u'), String(fixed));
      //M 记下这处改动，最后打印出来。
      this.changes.push(site + '  ' + json + ' line=' + digits + ' → ' + String(fixed));
      return '[' + nextLabel + '](#lines=' + json + '&line=' + String(fixed) + ')';
    });

    //M 再找行内引用：先记下要换的位置，最后从后往前换，免得位置错开。
    const skip: [number, number][] = [];
    for (const link of next.matchAll(DOC_LINK)) {
      skip.push([link.index, link.index + link[0].length]);
    }
    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (file: string, start: number, digits: string, endDigits: string | undefined, hints: Hints): void => {
      const no = Number(digits);
      let last: number | undefined;
      if (endDigits !== undefined) {
        last = Number(endDigits);
      }
      //M 核对一个引用，能改的给出新行号。
      const fixed = this.checkRef(file, no, last, hints, doc, site, docShifts, live);
      if (fixed === undefined) return;

      const delta = fixed - no;
      let text = String(fixed);
      if (endDigits !== undefined && last !== undefined) {
        text += next.slice(start + digits.length, start + digits.length + 1) + String(last + delta);
      }
      let length = digits.length;
      if (endDigits !== undefined) {
        length += 1 + endDigits.length;
      }
      //M 记下要换的位置，最后统一换。
      edits.push({ start, end: start + length, text });
      let range = String(no);
      if (last !== undefined) {
        range += '–' + String(last);
      }
      //M 记下这处改动，最后打印出来。
      this.changes.push(site + '  ' + file + ' ' + range + ' → ' + text);
    };

    for (const ref of next.matchAll(FILE_REF)) {
      if (skip.some(([from, to]) => ref.index >= from && ref.index < to)) continue;

      const file = this.resolveFile(ref[1], doc, docShifts);
      if (file === undefined) {
        //M 记一条提示，不影响退出码。
        this.report('warning', doc, site, '找不到 ' + ref[1] + ' 是哪个文件');
        continue;
      }
      const numberAt = ref.index + ref[1].length + 1;
      const refEnd = ref.index + ref[0].length;
      //M 引用旁边的名字。
      const hints = getHints(next, ref.index, refEnd);
      //M 核对这个引用。
      visit(file, numberAt, ref[2], ref[3], hints);

      let tail = refEnd;
      for (;;) {
        const more = MORE_REF.exec(next.slice(tail));
        if (more === null) break;

        const moreAt = tail + more[0].indexOf(more[1]);
        const moreEnd = tail + more[0].length;
        //M 接在后面的「、`588`」沿用同一个文件。
        const moreHints = getHints(next, moreAt, moreEnd - 1);
        //M 核对这个接着写的行号。
        visit(file, moreAt, more[1], more[2], moreHints);
        tail = moreEnd;
      }
    }

    for (const ref of next.matchAll(NTH_REF)) {
      let mention: string | undefined;
      for (const found of next.slice(0, ref.index).matchAll(PATH_MENTION)) {
        mention = found[1];
      }
      if (mention === undefined || !/\.(?:tsx?|m?js)$/u.test(mention)) continue;

      const file = this.resolveFile(mention, doc, docShifts);
      if (file === undefined) {
        //M 记一条提示，不影响退出码。
        this.report('warning', doc, site, '找不到 ' + mention + ' 是哪个文件');
        continue;
      }
      const numberAt = ref.index + ref[0].indexOf(ref[1]);
      //M 「第 N 行」后面括号里的名字。
      const hints = getHints(next, ref.index, ref.index + ref[0].length);
      //M 核对这个「第 N 行」。
      visit(file, numberAt, ref[1], ref[2], hints);
    }

    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    }
    return next;
  }

  /**
   * 核对一个 #lines 链接。
   * @param line 链接所在的行。
   * @param offset 链接在行里的起点。
   * @param json 指向的骨架逐行 JSON。
   * @param no 行号。
   * @param doc 文档路径。
   * @param site 报告用的位置。
   * @returns --fix 时要换成的行号；不用改或改不了时返回 undefined。
   */
  private checkLinesLink(
    line: string,
    offset: number,
    json: string,
    no: number,
    doc: string,
    site: string,
  ): number | undefined {
    //M 取那份 JSON 各块的范围。
    const ranges = this.leafRanges.get(json);
    if (ranges === undefined) {
      //M 记一条问题，交给人工处理。
      this.report('error', doc, site, '#lines 指向的 ' + json + ' 不存在');
      return undefined;
    }
    const source = 'src7/' + json.replace(/\.json$/u, '.ts');
    //M 没有同名源码的（Cordis.json 这类）不按行号核对。
    const code = this.getLines(source);
    if (code === undefined) return undefined;

    const hintMatch = /`([^`]+)`（$/u.exec(line.slice(0, offset));
    let hint: string | undefined;
    if (hintMatch !== null && (SYMBOL.test(hintMatch[1]) || EVENT.test(hintMatch[1]))) {
      hint = hintMatch[1];
    }
    const inBlock = ranges.some((range) => no >= range.start && no <= range.end);
    //M 链接前面的名字要在那一行，或者那行是它的构造函数。
    const onLine = hint === undefined || this.isShown(source, no, no, [hint]);
    if (inBlock && onLine) return undefined;

    //M 先按骨架逐行这次的挪动换算，再按名字到源码里找。
    let fixed = mapLine(no, (this.fileShifts.get(source) ?? []).filter((shift) => shift.applied));
    if (hint !== undefined && (fixed === undefined || !this.isShown(source, fixed, fixed, [hint]))) {
      fixed = this.locate(source, hint);
    }
    let problem = json + ' 没有哪一块包含 L' + String(no);
    if (inBlock) {
      problem = '`' + (hint ?? '') + '` 不在 ' + source + ' 第 ' + String(no) + ' 行';
    }
    if (fixed === undefined || fixed === no) {
      this.report('error', doc, site, problem + '，定位不到新位置，要人工处理');
      return undefined;
    }
    if (!this.fix) {
      this.report('error', doc, site, problem + '，应为 ' + String(fixed));
      return undefined;
    }
    return fixed;
  }

  /**
   * 核对一个行内引用：不越界；查漂移时看旁边的名字在不在那行，或按同文档代码原文的挪动推算。
   * @param file 源码路径。
   * @param no 起始行。
   * @param last 终止行，没有时为 undefined。
   * @param hints 旁边的名字。
   * @param doc 文档路径。
   * @param site 报告用的位置。
   * @param docShifts 同文档代码原文的挪动。
   * @param live 为 true 时查漂移。
   * @returns --fix 时要换成的起始行；不用改或改不了时返回 undefined。
   */
  private checkRef(
    file: string,
    no: number,
    last: number | undefined,
    hints: Hints,
    doc: string,
    site: string,
    docShifts: Shift[],
    live: boolean,
  ): number | undefined {
    //M 读源码，读不到就没法核对。
    const code = this.getLines(file);
    if (code === undefined) return undefined;

    const end = last ?? no;
    const ref = file + ':' + String(no);
    const outside = no < 1 || end < no || end > code.length;
    let fixed: number | undefined;
    let reason = '';
    const hint = hints.primary;
    const wholeFile = no === 1 && last === undefined;
    if (live && hint !== undefined && !wholeFile) {
      //M 旁边的名字在那几行里就对。
      const shown = this.isShown(file, no, end, [hint, ...hints.extra]);
      if (shown && !outside) return undefined;
      if (end !== no && !outside) {
        //G 一段范围里看不到名字，多半是讲那段干了什么，不按名字硬挪。
        this.report('warning', doc, site, ref + '–' + String(end) + ' 里看不到 `' + hint + '`，要人工核对');
        return undefined;
      }

      //M 旁边的名字不在那一行：到源码里找它。
      fixed = this.locate(file, hint);
      reason = '旁边的 `' + hint + '` 在第 ' + String(fixed) + ' 行';
      if (fixed === undefined) {
        this.report('warning', doc, site, ref + ' 旁边的 `' + hint + '` 不在那一行，也没法唯一定位');
      }
    }
    if (live && hint === undefined) {
      //M 同一文档里这个文件的代码原文挪动。
      const own = docShifts.filter((shift) => shift.file === file);
      //M 骨架逐行这次记下的挪动。
      const global = this.fileShifts.get(file) ?? [];
      //M 没有名字：按同一文档代码原文的挪动推算，推不出再看骨架逐行的。
      let delta = inferDelta(no, own);
      if (delta === undefined && own.every((shift) => shift.delta === 0)) {
        delta = inferDelta(no, global.filter((shift) => shift.applied));
      }
      if (delta !== undefined && delta !== 0) {
        fixed = no + delta;
        reason = '附近的代码原文挪了 ' + String(delta) + ' 行';
      }
      if (delta === undefined && own.some((shift) => shift.delta !== 0)) {
        this.report('warning', doc, site, ref + ' 附近的代码原文挪过，这里推不出新行号，要人工核对');
      }
    }
    if (fixed !== undefined && fixed !== no) {
      if (this.fix) return fixed;

      //M 记一条问题，交给人工处理。
      this.report('error', doc, site, ref + ' 漂了：' + reason + '，应为 ' + String(fixed));
      return undefined;
    }
    if (!outside) return undefined;
    if (!live) {
      //G 归档文档是当时的快照，越界只提示。
      this.report('warning', doc, site, ref + ' 越界：文件现在共 ' + String(code.length) + ' 行（归档文档）');
      return undefined;
    }
    //M 记一条问题，交给人工处理。
    this.report('error', doc, site, ref + ' 越界：文件共 ' + String(code.length) + ' 行');
    return undefined;
  }
}


/**
 * 把命令行给的文件和目录展开成要查的 Markdown 和骨架逐行 JSON。
 * @param root 代码库根目录。
 * @param wanted 命令行给的路径，相对根目录。
 * @returns 相对根目录的正斜杠路径。
 */
export function expandTargets(root: string, wanted: string[]): string[] {
  const found = new Set<string>();
  const walk = (rel: string): void => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isFile()) {
      found.add(rel);
      return;
    }
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const child = rel + '/' + entry.name;
      if (entry.isDirectory()) {
        //M 子目录接着往下找。
        walk(child);
        continue;
      }
      const isMarkdown = entry.name.endsWith('.md');
      const isSkeleton = entry.name.endsWith('.json') && rel === SKELETON_DIR;
      if (isMarkdown || isSkeleton) {
        found.add(child);
      }
    }
  };
  for (const item of wanted) {
    const rel = path.relative(root, path.resolve(root, item)).split(path.sep).join('/');
    //M 每个参数展开成文件。
    walk(rel);
  }
  return [...found].sort();
}

/**
 * 不给参数时查的范围：docs、README 和每个插件的说明。
 * @param root 代码库根目录。
 * @returns 相对根目录的路径。
 */
function getDefaultTargets(root: string): string[] {
  const targets = [...DEFAULT_TARGETS];
  const plugins = path.join(root, 'src7/plugins');
  for (const name of fs.readdirSync(plugins).sort()) {
    const rel = 'src7/plugins/' + name + '/说明.md';
    if (!fs.existsSync(path.join(root, rel))) continue;

    //M 加上这个插件的说明。
    targets.push(rel);
  }
  return targets;
}

/**
 * 命令行入口。
 * @param args 命令行参数。
 * @returns 退出码：0 没有问题，1 有问题，2 参数不对。
 */
function main(args: string[]): number {
  const fix = args.includes('--fix');
  const all = args.includes('--all');
  //M 其余参数是要查的文件或目录。
  const wanted = args.filter((arg) => arg !== '--fix' && arg !== '--all');
  if (wanted.some((arg) => arg.startsWith('--'))) {
    console.error('用法：bun ztools/check-lines/Check_Lines.ts [--fix] [--all] [文件或目录…]');
    return 2;
  }
  let given = wanted;
  if (given.length === 0) {
    //M 没给范围就查默认的几处。
    given = getDefaultTargets(CODE_ROOT);
  }
  //M 展开成文件。
  const files = expandTargets(CODE_ROOT, given);
  if (files.length === 0) {
    console.error('没有要查的文件：' + given.join(' '));
    return 2;
  }

  let result = new LineChecker(CODE_ROOT, fix);
  //M 查（--fix 时顺手改）。
  result.run(files);
  for (const change of result.changes) {
    console.log('改  ' + change);
  }
  const changed = result.changes.length;
  const unwritten = result.writeErrors;
  if (fix) {
    //M 改完重新查一遍，剩下的才是要人工处理的。
    result = new LineChecker(CODE_ROOT, false);
    result.run(files);
  }
  for (const problem of unwritten) {
    console.log(problem);
  }
  for (const problem of result.errors) {
    console.log(problem.site + '  ' + problem.message);
  }
  if (all) {
    for (const problem of result.warnings) {
      console.log('提示  ' + problem.site + '  ' + problem.message);
    }
  }
  const summary = [
    '文件 ' + String(files.length) + ' 份',
    '问题 ' + String(result.errors.length + unwritten.length) + ' 处',
    '提示 ' + String(result.warnings.length) + ' 处',
  ];
  if (fix) {
    //M 加上改了几处。
    summary.push('已改 ' + String(changed) + ' 处');
  }
  console.log(summary.join('，') + '。');
  if (result.errors.length > 0 || unwritten.length > 0) return 1;

  return 0;
}

if (import.meta.main) {
  //M 有问题时退出码为 1，换版流程靠它拦。
  process.exitCode = main(process.argv.slice(2));
}
