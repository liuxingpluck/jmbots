/**
 * 从源码里取注释：按“文件 + 一段代码”找到行号，取它正上方那段注释，拆成干什么、输入、输出、出错、副作用。
 * 说明不另写一份：页面上显示的就是代码自己的注释，代码改了说明跟着变；取不到的标“缺注释”，方便以后补。
 * 源码从哪读：编译版从打进程序里的 src7/…（scripts/Build_Src7.ts 登记进 utils/Embedded.ts）；源码跑时读代码目录。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as embedded from '../../utils/Embedded.ts';
import * as sourceDirModule from '../../utils/SourceDir.ts';


/** 源码跑时的代码目录：本文件在 src7/plugins/tutorial/，往上三层。 */
const CODE_ROOT = path.resolve(import.meta.dir, '../../..');


/** 在哪个文件里找哪段代码。 */
export interface CodeRef {
  /** 相对代码目录的文件，如 src7/Main.ts。 */
  file: string;
  /** 那一行里一定有的一段代码，如 checks.checkArgs(；取第一处。 */
  find: string;
}


/** 要取注释的一个函数。 */
export interface DocRef extends CodeRef {
  /** 页面上显示的名字，如 checkArgs。 */
  name: string;
  /** 重要的（会改数据、会影响后面走向）展开显示；不重要的只显示一句。 */
  important: boolean;
}


/** 注释拆开的几块。 */
export interface ParsedDoc {
  /** 开头那几句：它干什么。 */
  summary: string;
  /** @param：参数名和说明。 */
  params: { name: string; text: string }[];
  /** @returns 的说明。 */
  returns: string;
  /** @throws 的说明。 */
  throws: string;
  /** “副作用：”那几句：它改了什么。 */
  effects: string;
}


/** 一个函数的完整源码，GET /api/tutorial/source 原样交给页面的“看实现”。 */
export interface FunctionSource {
  /** 相对代码目录的文件，如 src7/utils/Embedded.ts。 */
  file: string;
  /** 从第几行起，源文件里的真实行号（从 1 起）。 */
  start: number;
  /** 到第几行止（含这一行）。 */
  end: number;
  /** 没找到函数结尾（或这一行不在函数里），只给了 SOURCE_MAX_LINES 行时是 true。 */
  cut: boolean;
  /** start 到 end 那几行原文。 */
  lines: string[];
  /** 源码里调到的、在本文件或它 import 的本地文件里找得到定义的函数：名字和“文件:行号”。 */
  calls: { name: string; site: string }[];
  /** 这个函数的名字（定义那一行取的；构造函数是类名）；这一行不在函数里是空串。 */
  name: string;
  /** 谁调它：src7 里每一处调用（getCallers），照文件、行号排；name 是空串时没有。 */
  callers: Caller[];
}


/** 一处调用：在哪、那一行代码、为什么调。 */
export interface Caller {
  /** 调用处：文件:行号。 */
  site: string;
  /** 那一行源码，去掉首尾空白。 */
  code: string;
  /** 调用处上方最近的 //M（或 //G、//T）注释，去掉前缀；中间隔了空行就不算，没有是空串。 */
  why: string;
}


/** 找不到函数结尾时最多给几行。 */
export const SOURCE_MAX_LINES = 80;

/** 像函数定义开头的一行：function、const x = () =>、类方法、对象里的 x: () =>。真不真还要 getBlockEnd 配得上括号。 */
const DEFINITION = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/u,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|[\w$]+\s*=>|function\b)/u,
  /^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*[\w$]+\s*(?:<[^>]*>)?\(/u,
  /^\s*(?:(?:public|private|protected|static|readonly)\s+)*[\w$]+\s*[:=]\s*(?:async\s*)?\(.*=>/u,
];

/** 以这些词开头的不是定义（if (…) {、return foo(…) 也长得像方法）。 */
const NOT_DEFINITION = /^\s*(?:if|for|while|switch|catch|with|return|await|new|typeof|else|do|try|throw|yield|void|delete|super)\b/u;

/** 调用里出现、但不是函数名的词。 */
export const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'await', 'super', 'import']);


/**
 * 这一行像不像函数定义的开头。
 * @param line 一行源码。
 */
export function isDefinition(line: string): boolean {
  if (NOT_DEFINITION.test(line)) return false;

  return DEFINITION.some((pattern) => pattern.test(line));
}


/**
 * 定义那一行定义的名字：function x、const x =、方法 x(。
 * @param line 已经认过是定义开头的一行。
 */
export function getDefinedName(line: string): string {
  const named = /function\s*\*?\s*([\w$]+)/u.exec(line)
    ?? /(?:const|let|var)\s+([\w$]+)/u.exec(line)
    ?? /^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([\w$]+)/u.exec(line);
  return named?.[1] ?? '';
}


/**
 * 正则字面量在哪结束：跳过 \ 转义和 [...] 里的 /。
 * @param line 这一行。
 * @param index 开头那个 / 的下标。
 * @returns 正则最后一个字符（含 flags）的下标；这一行里没结束就是行尾。
 */
function getRegexEnd(line: string, index: number): number {
  let inClass = false;
  for (let at = index + 1; at < line.length; at++) {
    const ch = line[at];
    if (ch === '\\') {
      at++;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      continue;
    }
    if (ch === '/' && !inClass) {
      while (/[a-z]/u.test(line[at + 1] ?? '')) at++;
      return at;
    }
  }
  return line.length;
}


/**
 * 函数在哪一行结束：从定义那一行起按花括号配对，跳过字符串、模板字符串（${} 里照常配）、注释、正则里的括号。
 * 函数体是圆括号外的第一对 {}；配平后同一行后面紧跟 { 或 > 的，那一对是返回类型（如 ): { a: X } {），接着往下配。
 * 函数体开始前在括号外碰到 ;：前面有 => 是一句话的箭头函数，到这行为止；没有就不是定义（是一句调用或声明）。
 * @param lines 整个文件，一行一项。
 * @param index 定义那一行的下标（从 0 起）。
 * @returns 结束那一行的下标；配不上是 -1。
 */
export function getBlockEnd(lines: string[], index: number): number {
  let parens = 0;
  let braces = 0;
  /** 函数体（括号外第一对 {}）开始了没有。 */
  let opened = false;
  /** 括号外见过 =>。 */
  let arrow = false;
  /** 正在哪种字符串里：' " `；空串是不在。 */
  let quote = '';
  /** 正在 /* *\/ 注释里。 */
  let comment = false;
  /** 上一个不是空白的字符：认 / 是除号还是正则开头。 */
  let prev = '';
  /** 模板字符串里每个还没配完的 ${：记下它开之前的 braces，配回这层就回到模板字符串里。 */
  const templates: number[] = [];

  for (let at = index; at < lines.length; at++) {
    const line = lines[at] ?? '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i] ?? '';
      const next = line[i + 1] ?? '';

      //M 注释、字符串里的字符不算括号。
      if (comment) {
        if (ch === '*' && next === '/') {
          comment = false;
          i++;
        }
        continue;
      }
      if (quote !== '') {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === quote) {
          quote = '';
          prev = ch;
          continue;
        }
        if (quote === '`' && ch === '$' && next === '{') {
          templates.push(braces);
          braces++;
          quote = '';
          prev = '{';
          i++;
        }
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        comment = true;
        i++;
        continue;
      }
      if (ch === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]/u.test(prev)) {
        //M 遇到正则字面量开头时整段跳过，避免把正则里的括号算进花括号层级。
        i = getRegexEnd(line, i);
        prev = '/';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === ' ' || ch === '\t') continue;

      //M 括号配对。
      prev = ch;
      if (ch === '(') {
        parens++;
        continue;
      }
      if (ch === ')') {
        parens--;
        continue;
      }
      if (ch === '=' && next === '>' && parens === 0 && braces === 0) {
        arrow = true;
        continue;
      }
      if (ch === '{') {
        if (parens === 0 && braces === 0) opened = true;
        braces++;
        continue;
      }
      if (ch === '}' && templates.at(-1) === braces - 1) {
        //M 模板字符串里 ${…} 的那个 }：回到模板字符串里。
        templates.pop();
        braces--;
        quote = '`';
        continue;
      }
      if (ch === '}') {
        braces--;
        const typeBrace = /^\s*[{>]/u.test(line.slice(i + 1));
        if (opened && braces === 0 && parens === 0 && !typeBrace) return at;

        continue;
      }
      if (ch === ';' && parens === 0 && braces === 0 && !opened) {
        if (arrow) return at;

        return -1;
      }
    }
  }
  return -1;
}


/**
 * 某一行所在的函数：从这一行往上找像定义开头、且 getBlockEnd 配到这一行或更后面的，取最近的那个（最里层）。
 * 给定义那一行就是它自己；给函数里面的一行（请求轨迹的跟踪点）就是包着它的函数。
 * @param lines 整个文件，一行一项。
 * @param index 那一行的下标（从 0 起）。
 * @returns 起止下标（从 0 起，含 end）；不在函数里是 undefined。
 */
export function getFunctionAt(lines: string[], index: number): { start: number; end: number } | undefined {
  for (let at = index; at >= 0; at--) {
    //M 逐行向上认像函数定义的起点，定位可能包裹目标行的函数。
    if (!isDefinition(lines[at] ?? '')) continue;

    //M 匹配配对花括号找该函数体结尾，确认包住目标行即锁定最内层定义。
    const end = getBlockEnd(lines, at);
    if (end >= index) return { start: at, end };
  }
  return undefined;
}


/** 一段函数注释，交给页面（journal/Trail.ts 的 TrailLine.docs 里放的就是它）。 */
export interface CodeDoc extends ParsedDoc {
  /** 名字。 */
  name: string;
  /** 定义在哪：文件:行号；找不到这段代码时只有文件名。 */
  site: string;
  /** 重要的展开显示，不重要的只显示 summary。 */
  important: boolean;
  /** 空串是取到了；不然是原因：缺注释、读不到源码、找不到这段代码。 */
  missing: string;
  /** 函数原型，一行，如 apply(ctx: cordis.Context): void；文件开头的注释、找不到代码时是空串。 */
  signature: string;
}


/**
 * 函数原型：从定义那一行往下拼，到括号配平、行尾是 { 或 ; 为止（最多 12 行），拼成一行。
 * 去掉 export、private 这类修饰和 function 关键字，去掉结尾的 { 和 ;。
 * @param lines 整个文件，一行一项。
 * @param index 定义那一行的下标（从 0 起）。
 * @returns 一行签名，如 async main(): Promise<void>。
 */
export function getSignature(lines: string[], index: number): string {
  const parts: string[] = [];
  let depth = 0;
  for (let at = index; at < Math.min(lines.length, index + 12); at++) {
    const line = (lines[at] ?? '').trim();
    parts.push(line);
    depth += line.split('(').length - line.split(')').length;
    if (depth <= 0 && /(?:[{;]|=>)$/u.test(line)) break;
  }
  return parts.join(' ')
    .replace(/\s*[{;]$/u, '')
    .replace(/^(?:(?:export|default|private|public|protected|static)\s+)+/u, '')
    .replace(/^(async\s+)?function\s+/u, '$1')
    .replace(/\(\s+/gu, '(')
    .replace(/,?\s+\)/gu, ')')
    .replace(/\s+/gu, ' ');
}


/**
 * 拆一段注释。
 * @param block 注释那几行原文（从开头那行到结尾那行）。
 * @returns 拆好的几块。
 */
export function splitDoc(block: string[]): ParsedDoc {
  const doc: ParsedDoc = { summary: '', params: [], returns: '', throws: '', effects: '' };
  /** 正在接哪一块：没写标签的行接在它后面。 */
  let current: 'summary' | 'param' | 'returns' | 'throws' | 'effects' | 'other' = 'summary';
  const add = (old: string, text: string): string => {
    if (old === '') return text;

    return `${old}\n${text}`;
  };

  for (const raw of block) {
    const text = raw.replace(/^\s*\/\*\*/u, '').replace(/\*\/\s*$/u, '').replace(/^\s*\*\s?/u, '').trim();
    if (text === '') continue;

    const param = /^@param\s+(\S+)\s*(.*)$/u.exec(text);
    const tag = /^@(returns?|throws)\s*(.*)$/u.exec(text);
    const effect = /^副作用[：:]\s*(.*)$/u.exec(text);
    if (param !== null) {
      doc.params.push({ name: param[1] ?? '', text: param[2] ?? '' });
      current = 'param';
      continue;
    }
    if (tag !== null) {
      current = 'returns';
      if (tag[1] === 'throws') {
        current = 'throws';
      }
      //M 把 @returns/@throws 后紧跟的文字并入对应分段。
      doc[current] = add(doc[current], tag[2] ?? '');
      continue;
    }
    if (effect !== null) {
      current = 'effects';
      //M 收集“副作用：”后面的说明文本，支持多行续写。
      doc.effects = add(doc.effects, effect[1] ?? '');
      continue;
    }
    if (text.startsWith('@')) {
      current = 'other';
      continue;
    }
    if (current === 'param') {
      const last = doc.params[doc.params.length - 1];
      //M 参数说明换行续写时追加到最近一个 @param 项末尾。
      if (last !== undefined) last.text = add(last.text, text);
      continue;
    }
    if (current !== 'other') {
      //M 普通注释行按当前状态追加入摘要、返回值或异常说明分段。
      doc[current] = add(doc[current], text);
    }
  }
  return doc;
}


/**
 * 某一行正上方的那段注释（中间不隔空行）。
 * @param lines 整个文件，一行一项。
 * @param index 那一行的下标（从 0 起）。
 * @returns 注释那几行；上面不是注释是 undefined。
 */
export function getBlockAbove(lines: string[], index: number): string[] | undefined {
  const end = index - 1;
  if (!(lines[end] ?? '').trim().endsWith('*/')) return undefined;
  for (let start = end; start >= 0; start--) {
    if ((lines[start] ?? '').includes('/**')) return lines.slice(start, end + 1);
  }
  return undefined;
}


/**
 * 文件开头那段注释（文件的职责）。
 * @param lines 整个文件。
 * @returns 注释那几行；文件不是以注释开头是 undefined。
 */
export function getHeadBlock(lines: string[]): string[] | undefined {
  if (!(lines[0] ?? '').trim().startsWith('/**')) return undefined;

  const end = lines.findIndex((line) => line.includes('*/'));
  if (end < 0) return undefined;

  return lines.slice(0, end + 1);
}


/**
 * 一句话：summary 的第一句，太长截短。步骤的标题用它。
 * @param summary 注释开头那几句。
 */
export function getFirstSentence(summary: string): string {
  //M 只取首行中句号或分号前的短句，避免超长注释撑爆步骤标题。
  const line = summary.split('\n')[0] ?? '';
  const stop = line.search(/[。；]/u);
  let sentence = line;
  if (stop >= 0) {
    sentence = line.slice(0, stop);
  }
  if (sentence.length > 50) return `${sentence.slice(0, 50)}…`;

  return sentence;
}


/** 读源码、找行号、取注释。读过的文件记在这里，同一次启动只读一次。 */
export class SourceDocs {
  /** 文件 → 按行切好的内容；读不到是 undefined。 */
  private readonly cache = new Map<string, Promise<string[] | undefined>>();

  /** src7 下的源码文件列表（getSourceFiles 第一次列出来的），找调用处用；还没列是 undefined。 */
  private files: string[] | undefined;

  /**
   * 读一个源码文件。
   * @param file 相对代码目录的文件：本插件写死的骨架文件、plugins/<名字>/index.ts，
   *   或 /api/tutorial/source 校验过的 src7/ 下的 .ts、插件的 说明.md。读过的一直缓存，源码跑时改了文件要重启才看得到。
   * @returns 一行一项；读不到是 undefined。
   */
  read(file: string): Promise<string[] | undefined> {
    //M 先查询已读源码缓存表，命中则直接复用同一份 Promise 避免重复 IO。
    let found = this.cache.get(file);
    if (found === undefined) {
      //M 缓存未命中时按源码或内嵌资源读入并存入内存表，防止重复读盘。
      found = readLines(file);
      this.cache.set(file, found);
    }
    return found;
  }

  /**
   * 这段代码在哪：“文件:行号”。
   * @param ref 文件和一段代码。
   * @returns 找不到时只有文件名。
   */
  async getSite(ref: CodeRef): Promise<string> {
    //M 读取目标文件行数组并定位特征代码所在行号。
    const lines = await this.read(ref.file);
    if (lines === undefined) return ref.file;

    //M 在源码中匹配目标片段位置并格式化成“文件:行号”。
    const index = getLineIndex(lines, ref.find);
    if (index < 0) return ref.file;

    return `${ref.file}:${String(index + 1)}`;
  }

  /**
   * 取一个函数的注释：找到定义那一行，取它正上方的注释。
   * @param ref 函数名、定义所在的文件和那一行里的一段代码、重不重要。
   */
  async getDoc(ref: DocRef): Promise<CodeDoc> {
    //M 构造空注释骨架并读取目标文件行数组，读不到时标明原因。
    const doc = getEmptyDoc(ref.name, ref.file, ref.important);
    const lines = await this.read(ref.file);
    if (lines === undefined) return { ...doc, missing: '读不到源码' };

    //M 定位函数定义起始行索引。
    const index = getLineIndex(lines, ref.find);
    if (index < 0) return { ...doc, missing: '找不到这段代码' };

    //M 取定义正上方紧邻的 JSDoc 注释块及完整函数签名。
    const block = getBlockAbove(lines, index);
    const site = `${ref.file}:${String(index + 1)}`;
    const signature = getSignature(lines, index);
    if (block === undefined) return { ...doc, site, signature, missing: '缺注释' };
    //M 拆解 JSDoc 段落并与签名、行号组装成前端展示结构。
    return { ...doc, ...splitDoc(block), site, signature };
  }

  /**
   * 取一个文件开头的注释（插件的职责）。
   * @param name 页面上显示的名字。
   * @param file 相对代码目录的文件。
   */
  async getHead(name: string, file: string): Promise<CodeDoc> {
    //M 初始化文件头注释占位并读取源文件，准备抽取开头职责说明。
    const doc = getEmptyDoc(name, file, true);
    const lines = await this.read(file);
    if (lines === undefined) return { ...doc, missing: '读不到源码' };

    //M 从文件首行提取职责 JSDoc 块并拆分段落返回。
    const block = getHeadBlock(lines);
    const site = `${file}:1`;
    if (block === undefined) return { ...doc, site, missing: '缺注释' };
    //M 解析文件头注释各分段，供画布或文档面板直接展示。
    return { ...doc, ...splitDoc(block), site };
  }

  /**
   * 一个函数的完整源码：这一行所在的函数（getFunctionAt），从定义那一行到结束；不在函数里就从这一行起给 SOURCE_MAX_LINES 行。
   * 再列出里面调到的函数：本文件和它 import 的本地文件里找得到定义的，页面上做成能点的。
   * 还有谁调它（getCallers）：src7 里每一处调用、为什么调，给页面的“谁调它”。
   * @param file 相对代码目录的文件，/api/tutorial/source 已经校验过是 src7/ 下的 .ts。
   * @param line 第几行（从 1 起）：定义那一行或函数里面任意一行。
   * @returns 读不到文件、行号超出是 undefined。
   */
  async getSource(file: string, line: number): Promise<FunctionSource | undefined> {
    //M 读入源码全文并校验请求行号是否落在合法范围内。
    const lines = await this.read(file);
    if (lines === undefined || line < 1 || line > lines.length) return undefined;

    //M 查找包住目标行的函数起止范围并截取源码切片，随后解析内部调用点。
    const found = getFunctionAt(lines, line - 1);
    const start = found?.start ?? line - 1;
    const end = found?.end ?? Math.min(lines.length, start + SOURCE_MAX_LINES) - 1;
    const body = lines.slice(start, end + 1);
    const calls = await this.getCalls(file, lines, body, start);

    //M 谁调它：函数名取定义那一行；构造函数要找的是 new 类名(。不在函数里就不找。
    let name = '';
    if (found !== undefined) {
      name = getNameAt(lines, found.start);
    }
    let callers: Caller[] = [];
    if (name !== '' && found !== undefined) {
      callers = await this.getCallers(name, file, found.start);
    }
    return { file, start: start + 1, end: end + 1, cut: found === undefined, lines: body, calls, name, callers };
  }

  /**
   * src7 里谁调了这个函数：每个文件每一行，去掉字符串和注释后有 name( 或 .name( 的都算一处，跳过定义行本身。
   * 别的文件自己也定义了同名的顶层函数（插件各自的 checkConfig），那个文件里不带点的 name( 算它自己的，不列；
   * 带点的（.name(）分不清是谁的，同名方法（不同类里都叫 read）一起列出来。
   * @param name 函数名（构造函数传类名，找 new 类名(）。
   * @param file 定义所在的文件。
   * @param defined 定义那一行的下标：这一行不算调用。
   * @returns 每处调用的位置、代码、为什么调（getWhyAbove）。
   */
  private async getCallers(name: string, file: string, defined: number): Promise<Caller[]> {
    const escaped = name.replaceAll('$', '\\$');
    const bare = new RegExp(`(?<![\\w$.])${escaped}\\s*(?:<[^<>()]*>)?\\(`, 'u');
    const dotted = new RegExp(`\\.\\s*${escaped}\\s*(?:<[^<>()]*>)?\\(`, 'u');
    const callers: Caller[] = [];
    //M 遍历全部源码文件搜索当前函数的调用点。
    for (const other of await this.getSourceFiles()) {
      const lines = await this.read(other);
      if (lines === undefined) continue;

      //M 这个文件自己有没有同名的顶层函数：有就说明它里面不带点的调用是调它自己的。
      const ownOne = other !== file && lines.some((text) => /^\s*(?:export\s+)?(?:async\s+)?function\b/u.test(text)
        && getDefinedName(text) === name);

      lines.forEach((text, index) => {
        //G 定义行本身、别处同名的定义（接口里的方法签名、另一个类的同名方法）不是调用。
        if (other === file && index === defined) return;
        if (isDefinition(text) && getDefinedName(text) === name) return;

        //G 去掉字符串和注释后，带点的算；不带点的，本文件有同名函数时不算。
        const code = getCodeOnly(text);
        const called = dotted.test(code) || (!ownOne && bare.test(code));
        if (!called) return;

        //M 提取调用处上方的 //M/G/T 原因说明一并收进返回列表。
        const site = `${other}:${String(index + 1)}`;
        callers.push({ site, code: text.trim(), why: getWhyAbove(lines, index) });
      });
    }
    return callers;
  }

  /**
   * src7 下要找调用的源码文件（不含测试）：编译版取打进程序里登记的，源码跑时列代码目录。
   * @returns 相对代码目录的路径，如 src7/Resources.ts，排好序。
   * 副作用：第一次列出来以后记在 files 上，同一次启动不再列。
   */
  async getSourceFiles(): Promise<string[]> {
    if (this.files !== undefined) return this.files;

    //M 编译版磁盘上没有源码，只能从登记表里挑；源码跑时递归列 src7/，换成正斜杠和登记名一个样子。
    let all: string[] = [];
    if (embedded.isCompiled()) {
      all = embedded.getNames();
    }
    //M 非单文件编译模式时再改走文件系统递归枚举。
    if (!embedded.isCompiled()) {
      //M 源码运行模式下递归扫 src7 目录列出全量源码路径，并按代码目录规范统一转成正斜杠。
      const sourceDir = path.join(CODE_ROOT, sourceDirModule.SOURCE_DIR);
      const listed = await fs.promises.readdir(sourceDir, { recursive: true });
      all = listed.map((item) => `${sourceDirModule.SOURCE_PREFIX}${item.replaceAll('\\', '/')}`);
    }
    this.files = all
      .filter((item) => item.startsWith(sourceDirModule.SOURCE_PREFIX) && item.endsWith('.ts'))
      .filter((item) => !item.endsWith('.test.ts') && !item.includes('/tests/'))
      .sort();
    return this.files;
  }

  /**
   * 一段源码里调到的函数，在哪定义：先找本文件，再找本文件 import 的本地文件（./、../ 开头的）。
   * @param file 这段源码所在的文件。
   * @param lines 这个文件的全部行。
   * @param body 这段源码。
   * @param start 这段源码第一行的下标：定义在这一行的是它自己，不列。
   * @returns 名字和“文件:行号”，照第一次出现的先后，一个名字一项。
   */
  private async getCalls(file: string, lines: string[], body: string[], start: number): Promise<FunctionSource['calls']> {
    //M 要找的文件：本文件在前，再是 import 的本地文件（只认值导入，import type 里没有函数）。
    const files: { file: string; lines: string[] }[] = [{ file, lines }];
    for (const text of lines) {
      const spec = /^\s*import\s+(?!type\b)[^'"]*from\s+['"](\.{1,2}\/[^'"]+)['"]/u.exec(text)?.[1];
      if (spec === undefined) continue;

      //M 解析相对路径并读取被导入模块的行数组，纳入定义查找范围。
      const other = path.posix.join(path.posix.dirname(file), spec);
      const otherLines = await this.read(other);
      if (otherLines !== undefined) files.push({ file: other, lines: otherLines });
    }

    //M 名字后面跟 ( 的都算调用（含 obj.name(），去掉关键字，再挨个找定义。
    const names = new Set<string>();
    for (const match of body.join('\n').matchAll(/([\w$]+)\s*(?:<[^<>()]*>)?\(/gu)) {
      const name = match[1] ?? '';
      if (!KEYWORDS.has(name) && !/^\d/u.test(name)) names.add(name);
    }

    const calls: FunctionSource['calls'] = [];
    for (const name of names) {
      for (const item of files) {
        //M 在当前文件逐行判定哪一行既是对应函数定义又具备合法函数体结束位置。
        const at = item.lines.findIndex((text, index) => isDefinition(text)
          && getDefinedName(text) === name
          && getBlockEnd(item.lines, index) >= 0);
        if (at < 0) continue;
        //G 定义就是这段源码自己（递归、或名字就是它）：不列。
        if (item.file === file && at === start) break;

        calls.push({ name, site: `${item.file}:${String(at + 1)}` });
        break;
      }
    }
    return calls;
  }
}


/**
 * 这段代码在第几行：取第一处，但紧跟在引号后面的不算（那是字符串里提到它，不是它本身，
 * 比如 Boot.ts 自己写的 fn(file, 'function apply(', …)）。
 * @param lines 整个文件，一行一项。
 * @param find 那一行里一定有的一段代码。
 * @returns 下标（从 0 起）；找不到是 -1。
 */
export function getLineIndex(lines: string[], find: string): number {
  return lines.findIndex((line) => {
    const at = line.indexOf(find);
    return at >= 0 && !/['"`]$/u.test(line.slice(0, at));
  });
}


/**
 * 定义那一行定义的函数名；是 constructor 就往上找它所在的类，换成类名（别人写的是 new 类名(）。
 * @param lines 整个文件。
 * @param index 定义那一行的下标。
 * @returns 名字；构造函数找不到类名是空串。
 */
export function getNameAt(lines: string[], index: number): string {
  //M 提取定义行中的符号名，遇构造函数时再回溯所属类名以便搜索 new 类名(。
  const name = getDefinedName(lines[index] ?? '');
  if (name !== 'constructor') return name;

  for (let at = index - 1; at >= 0; at--) {
    const owner = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/u.exec(lines[at] ?? '')?.[1];
    if (owner !== undefined) return owner;
  }
  return '';
}


/**
 * 一行里只留代码：引号里的内容换成空格，// 后面整段去掉；/** 和 * 开头的注释行整行去掉。
 * 跨行的模板字符串、行中间的 /* *\/ 不处理（项目代码里少见，误报了也只是多列一处）。
 * @param line 一行源码。
 * @returns 去掉字符串和注释的那一行。
 */
export function getCodeOnly(line: string): string {
  if (/^\s*(?:\/\*|\*)/u.test(line)) return '';

  let out = '';
  /** 正在哪种引号里；不在字符串里是空串。 */
  let quote = '';
  for (let at = 0; at < line.length; at++) {
    const char = line[at] ?? '';
    //M 字符串里：转义跳过下一个字，碰到同样的引号结束，其余换成空格。
    if (quote !== '') {
      if (char === '\\') at++;
      if (char === quote) quote = '';
      let added = ' ';
      if (quote === '') {
        added = char;
      }
      out += added;
      continue;
    }

    //M 字符串外：// 起是注释，后面不要了；碰到引号进字符串。
    if (char === '/' && line[at + 1] === '/') break;
    if (char === '\'' || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}


/**
 * 一处调用为什么调：从它往上找最近的 //M、//G、//T 注释，连着的几行注释拼成一句。
 * 碰到空行、JSDoc 结尾（*\/）、和调用同一层缩进的 }（前面是另一个 if、for 块）就停：那是别的语句块，不算。
 * @param lines 整个文件。
 * @param index 调用那一行的下标。
 * @returns 注释去掉前缀；找不到是空串。
 */
export function getWhyAbove(lines: string[], index: number): string {
  /** 调用那一行的缩进：往上碰到同样缩进的 } 说明隔了一个块。 */
  const indent = /^\s*/u.exec(lines[index] ?? '')?.[0].length ?? 0;
  for (let at = index; at >= 0; at--) {
    const line = lines[at] ?? '';
    const text = line.trim();
    if (text === '' || text.endsWith('*/')) return '';

    const closed = at < index && text.startsWith('}') && line.length - line.trimStart().length === indent;
    if (closed) return '';

    //G 不是 //M、//G、//T 开头的（代码、普通注释）接着往上找。
    const mark = /^\/\/[MGT]\s?(.*)$/u.exec(text);
    if (mark === null) continue;

    //M 找到一行就把它上面连着的 // 注释一起拼上（一段 //M 常写成好几行）。
    const parts = [mark[1] ?? ''];
    for (let up = at - 1; up >= 0; up--) {
      const above = /^\s*\/\/[MGT]?\s?(.*)$/u.exec(lines[up] ?? '');
      if (above === null) break;
      parts.unshift(above[1] ?? '');
    }
    return parts.map((part) => part.trim()).join(' ');
  }
  return '';
}


/** 一段还没取到内容的注释。 */
function getEmptyDoc(name: string, file: string, important: boolean): CodeDoc {
  return { name, site: file, important, missing: '', signature: '', summary: '', params: [], returns: '', throws: '', effects: '' };
}


/**
 * 读文件，按行切开，不缓存（SourceDocs.read 缓存的就是它的结果；说明.md 别的 AI 随时在写，教程页直接调它，每次现读）。
 * 先找打进程序里的，再找代码目录。
 * @param file 相对代码目录的文件。
 * @returns 读不到是 undefined。
 */
export async function readLines(file: string): Promise<string[] | undefined> {
  //M 优先查找单文件编译时嵌入包内的只读副本，未命中再回退读取代码目录磁盘文件。
  const inside = embedded.find(file);
  try {
    let text = '';
    if (inside !== undefined) {
      text = await Bun.file(inside).text();
    }
    if (inside === undefined) {
      text = await fs.promises.readFile(path.join(CODE_ROOT, file), 'utf8');
    }
    return text.split(/\r?\n/u);
  } catch {
    return undefined;
  }
}
