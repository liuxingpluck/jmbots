/**
 * 教程页左栏「骨架」分组与静态代码提取：把系统自带的 main、resources、tools、sessions 列在左栏最上方，
 * 直接从骨架源码的注释、事件声明与导出的类/函数提取说明与「代码」索引（不额外新建 说明.md）。
 */
import * as path from 'node:path';
import * as sourceDirModule from '../../utils/SourceDir.ts';
import * as versionsModule from '../../utils/Versions.ts';
import type { FunctionItem } from './Code.ts';
import * as sourceModule from './Source.ts';


/** 一个骨架模块的描述规格。 */
export interface SkeletonSpec {
  /** 左栏与画布泳道图上的名字（main / resources / tools / sessions）。 */
  name: string;
  /** 主入口源码文件路径（相对仓库根目录）。 */
  file: string;
  /** 它依赖的骨架服务名（在教程页「概要 → 依赖」显示可点标签）。 */
  inject: string[];
  /** 是否把 src7/utils/*.ts 的导出函数/类也并入它的对外清单（main 归总工具层）。 */
  includeUtils: boolean;
}


/** 骨架插件条目结构，对齐 GET /api/tutorial/plugins 的 list 单项。 */
export interface SkeletonPluginItem {
  /** 骨架模块名。 */
  name: string;
  /** 版本号（来自 src7/utils/Versions.ts 的 VERSION）。 */
  version: string;
  /** 状态固定为 ok（骨架随进程常驻）。 */
  state: string;
  /** 错误信息（骨架常驻为空串）。 */
  error: string;
  /** 依赖的骨架服务。 */
  inject: string[];
  /** 固定为 true：从源码注释实时生成说明。 */
  hasReadme: boolean;
  /** 条目分类：skeleton 骨架，plugin 普通插件。 */
  kind: 'skeleton';
}


/** 解析出来的源码函数或类方法元数据（区分公开与私有）。 */
interface ExtractedSymbol {
  /** 展示名称（顶层符号为名，类方法为 类名.方法名）。 */
  name: string;
  /** 类型：function 或 class。 */
  kind: 'function' | 'class';
  /** 定义位置：文件:行号。 */
  site: string;
  /** 上方 JSDoc 第一句；没写是空串。 */
  summary: string;
  /** 是否对外公开（export 或公有方法）。 */
  isPublic: boolean;
}


/** 源码里提取到的发送事件调用点。 */
interface EmittedEventInfo {
  /** 事件名（如 session/before-model）。 */
  name: string;
  /** 触发方法（ctx.emit / ctx.serial / ctx.parallel）。 */
  way: string;
  /** 代码位置：文件:行号。 */
  site: string;
  /** 说明（来自 declare module 'cordis' 的事件 JSDoc 或调用上方 //M）。 */
  summary: string;
}


/** 源码里提取到的配置字段说明。 */
interface ConfigFieldInfo {
  /** 接口名.字段名。 */
  name: string;
  /** 定义位置：文件:行号。 */
  site: string;
  /** 上方 JSDoc 第一句。 */
  summary: string;
}


/** 源码根目录前缀（src7/utils/SourceDir.ts），骨架文件路径都从它拼。 */
const ROOT = sourceDirModule.SOURCE_PREFIX;

/** 骨架工具层目录前缀，如 src7/utils/。 */
const UTILS = `${ROOT}utils/`;

/** 源码根目录下的目录说明（每个文件干什么）。 */
const README = `${ROOT}README.md`;

/** 四个系统骨架模块（顺序对齐启动流程泳道与依赖层级）。 */
export const SKELETON_SPECS: readonly SkeletonSpec[] = [
  { name: 'main', file: `${ROOT}Main.ts`, inject: ['resources', 'tools', 'sessions'], includeUtils: true },
  { name: 'resources', file: `${ROOT}Resources.ts`, inject: [], includeUtils: false },
  { name: 'tools', file: `${ROOT}Tools.ts`, inject: [], includeUtils: false },
  { name: 'sessions', file: `${ROOT}Sessions.ts`, inject: ['resources', 'tools'], includeUtils: false },
];

/** 快速查询表：模块名 → 骨架规格。 */
const SPEC_BY_NAME = new Map<string, SkeletonSpec>(SKELETON_SPECS.map((spec) => [spec.name, spec]));

/** 匹配顶层导出函数或类声明。 */
const TOP_EXPORT = /^export\s+(?:async\s+)?(function|class)\s*\*?\s*([\w$]+)/u;

/** 匹配非导出的顶层函数声明（如 Main.ts 的 main、loadPlugin）。 */
const TOP_INTERNAL_FN = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/u;

/** 匹配类体内 2 空格缩进的方法声明。 */
const CLASS_METHOD = /^  (?:(private|protected|public|static|readonly|override|async)\s+)*([\w$]+)\s*(?:<[^>()]*>)?\(/u;

/** 匹配 emit/serial/parallel 事件触发。 */
const EMIT_CALL = /\b(this\.ctx|ctx|app)\.(emit|serial|parallel)\(\s*['"`]([^'"`]+)['"`]/u;

/** 匹配事件监听登记。 */
const LISTEN_CALL = /\b(?:this\.ctx|ctx|app)\.(on|once)\(\s*['"`]([^'"`]+)['"`]/u;


/**
 * 判断给定名字是不是系统自带的骨架模块。
 * @param name 左栏选中或请求查询的模块名。
 * @returns 是骨架模块返回 true。
 */
export function isSkeleton(name: string): boolean {
  return SPEC_BY_NAME.has(name);
}


/**
 * 取骨架模块主源码文件的相对路径。
 * @param name 骨架模块名。
 * @returns 源码路径（如 src7/Sessions.ts）；不存在返回空串。
 */
export function getSkeletonFile(name: string): string {
  return SPEC_BY_NAME.get(name)?.file ?? '';
}


/**
 * 生成左栏「骨架」分组的列表条目（版本号统一取 src7/utils/Versions.ts 的 VERSION）。
 * @returns 四个骨架模块的左栏元数据。
 */
export function getSkeletonItems(): SkeletonPluginItem[] {
  return SKELETON_SPECS.map((spec) => ({
    name: spec.name,
    version: versionsModule.VERSION,
    state: 'ok',
    error: '',
    inject: [...spec.inject],
    hasReadme: true,
    kind: 'skeleton',
  }));
}


/**
 * 转义 Markdown 表格单元格里的竖线与换行，防止破坏 GFM 表格列结构。
 * @param text 原始说明文字。
 * @returns 安全单行单元格文本。
 */
function escapeCell(text: string): string {
  return text.replaceAll('\r', '').replaceAll('\n', ' ').replaceAll('|', '\\|').trim();
}


/**
 * 截取定义行正上方的 JSDoc 第一句说明；没写注释返回空串。
 * @param lines 源码按行数组。
 * @param index 定义行下标（从 0 起）。
 * @returns 首句简介文本。
 */
function readSummaryAbove(lines: string[], index: number): string {
  //M 提取紧贴定义行上方的 JSDoc 注释块。
  const block = sourceModule.getBlockAbove(lines, index);
  if (block === undefined) return '';

  //M 拆解 JSDoc 字段并按句号截出第一句短简介。
  const parsed = sourceModule.splitDoc(block);
  return sourceModule.getFirstSentence(parsed.summary);
}


/**
 * 从单个源码文件抽出顶层函数/类以及导出类里的公开或私有方法。
 * @param file 相对仓库根目录的源码文件路径。
 * @param lines 文件行数组。
 * @param scanClassMethods 是否继续抽出类体内的成员方法。
 * @returns 按出现顺序排列的符号清单。
 */
function extractFileSymbols(file: string, lines: string[], scanClassMethods: boolean): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const exported = TOP_EXPORT.exec(line);
    if (exported !== null) {
      const kind = exported[1] as 'function' | 'class';
      const symbolName = exported[2] ?? '';
      //M 取顶层导出符号上方注释首句并记录精确位置。
      const summary = readSummaryAbove(lines, index);
      symbols.push({
        name: symbolName,
        kind,
        site: `${file}:${String(index + 1)}`,
        summary,
        isPublic: true,
      });
      if (kind === 'class' && scanClassMethods) {
        //M 对导出的类继续抽出成员方法，归入对外或内部函数列表。
        extractClassMethods(file, lines, index, symbolName, symbols);
      }
      continue;
    }

    const internal = TOP_INTERNAL_FN.exec(line);
    if (internal !== null) {
      const symbolName = internal[1] ?? '';
      //M 取非导出顶层函数上方注释，归入模块内部函数表。
      const summary = readSummaryAbove(lines, index);
      symbols.push({
        name: symbolName,
        kind: 'function',
        site: `${file}:${String(index + 1)}`,
        summary,
        isPublic: false,
      });
    }
  }
  return symbols;
}


/**
 * 扫描类声明大括号范围，提取类里的成员方法（跳过 constructor）。
 * @param file 源码路径。
 * @param lines 源码行数组。
 * @param classIndex class 声明所在行下标。
 * @param className 类名。
 * @param out 追加提取结果的数组。
 */
function extractClassMethods(
  file: string,
  lines: string[],
  classIndex: number,
  className: string,
  out: ExtractedSymbol[],
): void {
  //M 用配对花括号计算类体边界，避免误扫出类外的顶层函数。
  const classEnd = sourceModule.getBlockEnd(lines, classIndex);
  if (classEnd <= classIndex) return;

  for (let index = classIndex + 1; index < classEnd; index += 1) {
    const line = lines[index] ?? '';
    const match = CLASS_METHOD.exec(line);
    if (match === null) continue;

    //M 先过滤掉关键字与非函数调用，再确认方法体配对花括号有效。
    if (!sourceModule.isDefinition(line)) continue;
    const methodEnd = sourceModule.getBlockEnd(lines, index);
    if (methodEnd < index) continue;

    const modifier = match[1] ?? '';
    const methodName = match[2] ?? '';
    if (methodName === '' || methodName === 'constructor') continue;

    //M 抽该方法上方 JSDoc 简介，按 private/protected 判断是否对外。
    const summary = readSummaryAbove(lines, index);
    const isPrivate = /^\s*(?:private|protected)\b/u.test(line) || modifier === 'private' || modifier === 'protected';
    out.push({
      name: `${className}.${methodName}`,
      kind: 'function',
      site: `${file}:${String(index + 1)}`,
      summary,
      isPublic: !isPrivate,
    });
  }
}


/**
 * 读取某个骨架模块在「代码」页签展示的对外函数/类/核心方法清单。
 * main 除了 src7/Main.ts 外，同时汇总 src7/utils/*.ts 的全部顶层导出工具函数和类。
 * @param name 骨架模块名。
 * @param source 共用源码缓存实例。
 * @returns 函数与类条目数组。
 */
export async function getSkeletonFunctions(name: string, source: sourceModule.SourceDocs): Promise<FunctionItem[]> {
  const spec = SPEC_BY_NAME.get(name);
  if (spec === undefined) return [];

  const items: FunctionItem[] = [];
  //M 读取骨架主文件源码并提取顶层函数、类及成员方法。
  const mainLines = await source.read(spec.file);
  if (mainLines !== undefined) {
    //M 解析主文件符号；main 的顶层入口函数即使未 export 也收进代码目录便于查阅。
    const symbols = extractFileSymbols(spec.file, mainLines, true);
    for (const sym of symbols) {
      if (!sym.isPublic && name !== 'main') continue;

      items.push({
        name: sym.name,
        kind: sym.kind,
        site: sym.site,
        summary: sym.summary,
      });
    }
  }

  if (!spec.includeUtils) return items;

  //M main 一并汇总骨架 utils/ 下各工具模块顶层导出的函数与类。
  const allFiles = await source.getSourceFiles();
  for (const file of allFiles) {
    if (!file.startsWith(UTILS)) continue;

    //M 逐个读取 utils 模块，抽出顶层 export function / class 附入清单。
    const utilLines = await source.read(file);
    if (utilLines === undefined) continue;

    //M 工具模块只扫顶层导出定义，避免把局部辅助函数塞满主表。
    const utilSymbols = extractFileSymbols(file, utilLines, false);
    for (const sym of utilSymbols) {
      if (!sym.isPublic) continue;

      items.push({
        name: sym.name,
        kind: sym.kind,
        site: sym.site,
        summary: sym.summary,
      });
    }
  }
  return items;
}


/**
 * 从源码里的 declare module 'cordis' Events 声明段收集每个事件对应的 JSDoc 首句说明。
 * @param lines 源码行数组。
 * @returns 事件名 → 说明文字映射。
 */
function extractDeclaredEventDocs(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  let inEvents = false;
  let braces = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (!inEvents && /^\s*interface\s+Events\s*\{/u.test(raw)) {
      inEvents = true;
      braces = 1;
      continue;
    }
    if (!inEvents) continue;

    //M 统计花括号深度，离开 interface Events { ... } 后立即结束收集。
    for (const ch of raw) {
      if (ch === '{') braces += 1;
      if (ch === '}') braces -= 1;
    }
    if (braces <= 0) break;

    const eventMatch = /^\s*['"`]([^'"`]+)['"`]\s*\(/u.exec(raw);
    if (eventMatch === null) continue;

    const eventName = eventMatch[1] ?? '';
    if (eventName === '') continue;

    //M 提取该事件声明上方的 JSDoc 首句说明备用。
    const summary = readSummaryAbove(lines, index);
    if (summary !== '') {
      map.set(eventName, summary);
    }
  }
  return map;
}


/**
 * 扫描骨架文件源码里发出的 Cordis 事件（emit / serial / parallel，排除 debug trace 点）。
 * @param file 源码路径。
 * @param lines 源码行数组。
 * @returns 去重后的发出事件列表。
 */
function extractEmittedEvents(file: string, lines: string[]): EmittedEventInfo[] {
  //M 先读一遍 declare module 'cordis' Events 里的事件说明作为兜底注释。
  const eventDocs = extractDeclaredEventDocs(lines);
  const emitted: EmittedEventInfo[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    //M 去掉注释和字符串噪声之外的整行代码，检查是否有 emit/serial/parallel。
    const codeOnly = sourceModule.getCodeOnly(lines[index] ?? '');
    if (codeOnly.trim() === '') continue;

    const raw = lines[index] ?? '';
    const match = EMIT_CALL.exec(raw);
    if (match === null) continue;

    const receiver = match[1] ?? 'ctx';
    const method = match[2] ?? 'emit';
    const eventName = match[3] ?? '';
    if (eventName === '' || eventName === 'trace') continue;

    const site = `${file}:${String(index + 1)}`;
    if (seen.has(eventName)) continue;
    seen.add(eventName);

    //M 优先采用 Cordis Events 接口处的官方 JSDoc，其次回退调用行上方的 //M 注释。
    let summary = eventDocs.get(eventName) ?? '';
    if (summary === '') {
      summary = sourceModule.getWhyAbove(lines, index);
    }
    emitted.push({
      name: eventName,
      way: `${receiver}.${method}`,
      site,
      summary,
    });
  }
  return emitted;
}


/**
 * 扫描骨架文件源码里监听的 Cordis 事件（on / once）。
 * @param file 源码路径。
 * @param lines 源码行数组。
 * @returns 监听列表。
 */
function extractListenedEvents(file: string, lines: string[]): { name: string; site: string; summary: string }[] {
  const listened: { name: string; site: string; summary: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    //M 忽略注释行，仅识别实际代码里的 ctx.on/once 事件监听登记。
    const codeOnly = sourceModule.getCodeOnly(raw);
    if (codeOnly.trim() === '') continue;

    const match = LISTEN_CALL.exec(raw);
    if (match === null) continue;

    const eventName = match[2] ?? '';
    if (eventName === '') continue;

    //M 取出监听注册语句上方的 //M 原因说明供「事件」表展示。
    const summary = sourceModule.getWhyAbove(lines, index);
    listened.push({
      name: eventName,
      site: `${file}:${String(index + 1)}`,
      summary,
    });
  }
  return listened;
}


/**
 * 扫描骨架源码里的数据表或 SQLite 库打开语句。
 * @param file 源码路径。
 * @param lines 源码行数组。
 * @returns Markdown 正文或“无。”。
 */
function extractDataSection(file: string, lines: string[]): string {
  const rows: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const tableMatch = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/iu.exec(line);
    if (tableMatch !== null) {
      const tableName = tableMatch[1] ?? '';
      rows.push(`- 数据表 \`${tableName}\`：建表位置 \`${file}:${String(index + 1)}\``);
    }
    if (/new\s+Database\(/u.test(line)) {
      rows.push(`- 打开数据库 \`data/jmbots7.db\`（SQLite WAL 模式）：位置 \`${file}:${String(index + 1)}\``);
    }
  }
  if (rows.length === 0) return '无。';

  return rows.join('\n');
}


/**
 * 扫描骨架源码里导出的 *Config 接口及其字段注释。
 * @param file 源码路径。
 * @param lines 源码行数组。
 * @returns 提取到的配置字段列表。
 */
function extractConfigFields(file: string, lines: string[]): ConfigFieldInfo[] {
  const fields: ConfigFieldInfo[] = [];
  let currentConfig = '';
  let braces = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (currentConfig === '') {
      const head = /^export\s+interface\s+(\w*Config)\s*\{/u.exec(raw);
      if (head !== null) {
        currentConfig = head[1] ?? '';
        braces = 1;
      }
      continue;
    }

    //M 计算花括号深度，interface 结束时退出当前配置接口扫描。
    for (const ch of raw) {
      if (ch === '{') braces += 1;
      if (ch === '}') braces -= 1;
    }
    if (braces <= 0) {
      currentConfig = '';
      continue;
    }

    const prop = /^  ([A-Za-z0-9_]+)\??\s*:/u.exec(raw);
    if (prop === null) continue;

    const fieldName = prop[1] ?? '';
    //M 读取紧贴该配置属性上方的 JSDoc 首句作为配置说明。
    const summary = readSummaryAbove(lines, index);
    fields.push({
      name: `${currentConfig}.${fieldName}`,
      site: `${file}:${String(index + 1)}`,
      summary,
    });
  }
  return fields;
}


/**
 * 从 src7/README.md 的架构文件树节选对应文件的一句话角色说明，以及 utils/ 目录说明（供 main 使用）。
 * @param source 共用源码缓存实例。
 * @param basename 源码文件名（如 Main.ts、Sessions.ts）。
 * @returns 结构化摘要文本。
 */
async function readArchNote(
  source: sourceModule.SourceDocs,
  basename: string,
): Promise<{ fileNote: string; utilNotes: string[] }> {
  //M 按缓存读取 src7/README.md 并切出目录说明段落。
  const readmeLines = await source.read(README);
  if (readmeLines === undefined) return { fileNote: '', utilNotes: [] };

  let fileNote = '';
  const utilNotes: string[] = [];
  let inUtils = false;
  const targetPrefix = `  ${basename} `;

  for (const line of readmeLines) {
    if (line.startsWith(targetPrefix)) {
      fileNote = line.trim();
    }
    if (/^\s{2}utils\/\s*$/u.test(line)) {
      inUtils = true;
      continue;
    }
    if (inUtils) {
      if (!line.startsWith('    ')) {
        inUtils = false;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed !== '') {
        utilNotes.push(trimmed);
      }
    }
  }
  return { fileNote, utilNotes };
}


/**
 * 读取某个骨架模块动态组装出来的 Markdown 说明文本（对齐 说明.md 各二级标题，无需在磁盘写入 说明.md）。
 * @param name 骨架模块名（main / resources / tools / sessions）。
 * @param source 共用源码缓存实例。
 * @returns 对齐 GET /api/tutorial/readme 的响应体。
 */
export async function getSkeletonReadme(
  name: string,
  source: sourceModule.SourceDocs,
): Promise<{ name: string; file: string; text: string }> {
  const spec = SPEC_BY_NAME.get(name);
  if (spec === undefined) return { name, file: '', text: '' };

  //M 读骨架主源码并抽文件头职责注释与 src7/README.md 中的定位描述。
  const lines = await source.read(spec.file);
  if (lines === undefined) return { name, file: spec.file, text: '' };

  //M 解析文件头 JSDoc 注释段落作为「概要」主说明。
  const headBlock = sourceModule.getHeadBlock(lines);
  let introBody = '';
  if (headBlock !== undefined) {
    //M 拆解文件头 JSDoc 注释并去掉尾随多余空行。
    introBody = sourceModule.splitDoc(headBlock).summary.trim();
  }

  //M 从 src7/README.md 提取一句定位说明和 utils 模块列表以丰富骨架文档。
  const basename = path.posix.basename(spec.file);
  const arch = await readArchNote(source, basename);
  const introParts: string[] = [];
  if (introBody !== '') {
    introParts.push(introBody);
  }
  if (arch.fileNote !== '') {
    introParts.push(`架构角色（\`${README}\`）：\`${arch.fileNote}\``);
  }
  introParts.push(`源码位置：\`${spec.file}:1\`（系统自带骨架模块，本说明从源码注释实时提取）。`);
  if (spec.includeUtils && arch.utilNotes.length > 0) {
    introParts.push(`包含基础设施工具层（\`${UTILS}\`）：\n${arch.utilNotes.map((row) => `- \`${row}\``).join('\n')}`);
  }

  //M 组装「依赖」段落正文（标签胶囊由前端 OverviewTab 按 plugin.inject 自动渲染）。
  let depsBody = '无。';
  if (spec.inject.length > 0) {
    depsBody = spec.inject.map((dep) => `- inject \`${dep}\`：骨架基础服务。`).join('\n');
  }
  if (name === 'main') {
    depsBody += '\n- 启动顺序：按固定先后挂 `resources` → `tools` → `sessions`，再按 `config.yaml` 挂各插件。';
  }

  //M 提取「听的事件」并格式化成表格或“无。”。
  const listened = extractListenedEvents(spec.file, lines);
  let listenedBody = '无。';
  if (listened.length > 0) {
    //M 将监听登记列表渲染为标准 GFM 表格供前端高亮事件与定位源码。
    const listenedRows = listened.map(
      (item) => `| \`${item.name}\` | ${item.site} | ${escapeCell(item.summary)} |`,
    );
    listenedBody = ['| 事件 | 位置 | 说明 |', '|---|---|---|', ...listenedRows].join('\n');
  }

  //M 提取「发的事件」并格式化成表格（首列“事件”自动带事件高亮胶囊，位置列自动带 VS Code 与看实现）。
  const emitted = extractEmittedEvents(spec.file, lines);
  let emittedBody = '无。';
  if (emitted.length > 0) {
    //M 将触发点列表渲染为带方式、精确行号与 JSDoc 的 GFM 表格。
    const emittedRows = emitted.map(
      (item) => `| \`${item.name}\` | \`${item.way}\` | ${item.site} | ${escapeCell(item.summary)} |`,
    );
    emittedBody = ['| 事件 | 方式 | 位置 | 说明 |', '|---|---|---|---|', ...emittedRows].join('\n');
  }

  //M 提取「对外函数」与「内部函数」符号表（main 同步收入 src7/utils/*.ts 的顶层导出）。
  const allSymbols = extractFileSymbols(spec.file, lines, true);
  if (spec.includeUtils) {
    //M 对 main 额外扫描 src7/utils/*.ts，把共用导出工具收进「对外函数」分栏。
    const allFiles = await source.getSourceFiles();
    for (const file of allFiles) {
      if (!file.startsWith(UTILS)) continue;

      //M 读取单个工具文件并追加其顶层 export 符号。
      const utilLines = await source.read(file);
      if (utilLines === undefined) continue;

      //M 提取工具文件顶层符号并仅保留公开 export 项。
      const utilSymbols = extractFileSymbols(file, utilLines, false);
      for (const sym of utilSymbols) {
        if (sym.isPublic) {
          allSymbols.push(sym);
        }
      }
    }
  }

  const publicSyms = allSymbols.filter((sym) => sym.isPublic);
  const internalSyms = allSymbols.filter((sym) => !sym.isPublic);

  let publicBody = '无。';
  if (publicSyms.length > 0) {
    //M 将导出函数、类与公开方法渲染成含源码行号的 GFM 表格。
    const rows = publicSyms.map((sym) => `| \`${sym.name}\` | ${sym.site} | ${escapeCell(sym.summary)} |`);
    publicBody = ['| 名字 | 位置 | 说明 |', '|---|---|---|', ...rows].join('\n');
  }

  let internalBody = '无。';
  if (internalSyms.length > 0) {
    //M 将非导出辅助函数与类私有方法渲染成「内部函数」表。
    const rows = internalSyms.map((sym) => `| \`${sym.name}\` | ${sym.site} | ${escapeCell(sym.summary)} |`);
    internalBody = ['| 名字 | 位置 | 说明 |', '|---|---|---|', ...rows].join('\n');
  }

  //M 提取建表与数据库打开点作为「数据」分栏内容。
  const dataBody = extractDataSection(spec.file, lines);

  //M 提取配置接口字段（或 main 的命令行与 config.yaml 校验说明）作为「配置」分栏。
  const configFields = extractConfigFields(spec.file, lines);
  let configBody = '无。';
  if (configFields.length > 0) {
    //M 将配置接口各字段名、定义位置和注释组成配置表。
    const rows = configFields.map((item) => `| \`${item.name}\` | ${item.site} | ${escapeCell(item.summary)} |`);
    configBody = ['| 字段 | 位置 | 说明 |', '|---|---|---|', ...rows].join('\n');
  }
  if (name === 'main') {
    //M 入口参数和 config.yaml 的校验都在骨架工具层的 Checks.ts。
    const checks = `${UTILS}Checks.ts`;
    const argsCell = '`--data` / `--runtime` / `--mode candidate` / `--port`';
    configBody = [
      '| 入口参数 / 配置校验 | 位置 | 说明 |',
      '|---|---|---|',
      `| CLI ${argsCell} | ${checks}:51 | 启动参数由 \`checkArgs\` 一次校验并交由 \`Main.ts\` 分发 |`,
      `| \`config.yaml\` 顶层字段 | ${checks}:121 | \`config.yaml\` 骨架用到的那几项由 \`checkConfig\` 一次校验，插件自己的配置段由插件校验 |`,
    ].join('\n');
  }

  const text = [
    `# ${spec.name} v${versionsModule.VERSION}`,
    '',
    introParts.join('\n\n'),
    '',
    '## 依赖',
    '',
    depsBody,
    '',
    '## 听的事件',
    '',
    listenedBody,
    '',
    '## 发的事件',
    '',
    emittedBody,
    '',
    '## 对外函数',
    '',
    publicBody,
    '',
    '## 内部函数',
    '',
    internalBody,
    '',
    '## 数据',
    '',
    dataBody,
    '',
    '## 配置',
    '',
    configBody,
    '',
  ].join('\n');
  return { name: spec.name, file: spec.file, text };
}


/**
 * 骨架工具层（src7/utils/）一个文件的说明：文件头注释、src7/README.md 里那一句、导出和内部函数表。
 * 和骨架模块一样从源码实时提取，不另写 说明.md。
 * @param file 已按清单校验过的文件路径，如 src7/utils/Checks.ts。
 * @param source 共用源码缓存实例。
 * @returns 对齐 GET /api/tutorial/readme 的响应体；读不到文件 text 是空串。
 */
export async function getUtilReadme(
  file: string,
  source: sourceModule.SourceDocs,
): Promise<{ name: string; file: string; text: string }> {
  const name = path.posix.basename(file);
  //M 现读源码，读不到就交回空说明，由网页显示“读不到”。
  const lines = await source.read(file);
  if (lines === undefined) return { name, file, text: '' };

  //M 文件头 JSDoc 是这一份工具的主说明。
  const headBlock = sourceModule.getHeadBlock(lines);
  let introBody = '文件头没写说明。';
  if (headBlock !== undefined) introBody = sourceModule.splitDoc(headBlock).summary.trim() || introBody;

  //M src7/README.md 的 utils/ 一段里找这个文件那一行。
  const arch = await readArchNote(source, name);
  const archRow = arch.utilNotes.find((row) => row.startsWith(`${name} `));
  const introParts = [introBody];
  if (archRow !== undefined) introParts.push(`目录说明（\`${README}\`）：\`${archRow}\``);
  introParts.push(`源码位置：\`${file}:1\`（骨架工具层，本说明从源码注释实时提取）。`);

  //M 只扫顶层：导出的进「对外函数」，没导出的进「内部函数」。
  const symbols = extractFileSymbols(file, lines, false);
  const publicRows = symbols
    .filter((sym) => sym.isPublic)
    .map((sym) => `| \`${sym.name}\` | ${sym.site} | ${escapeCell(sym.summary)} |`);
  const internalRows = symbols
    .filter((sym) => !sym.isPublic)
    .map((sym) => `| \`${sym.name}\` | ${sym.site} | ${escapeCell(sym.summary)} |`);
  const head = ['| 名字 | 位置 | 说明 |', '|---|---|---|'];
  let publicBody = '无。';
  if (publicRows.length > 0) publicBody = [...head, ...publicRows].join('\n');
  let internalBody = '无。';
  if (internalRows.length > 0) internalBody = [...head, ...internalRows].join('\n');

  const text = [
    `# ${name}`,
    '',
    introParts.join('\n\n'),
    '',
    '## 对外函数',
    '',
    publicBody,
    '',
    '## 内部函数',
    '',
    internalBody,
    '',
  ].join('\n');
  return { name, file, text };
}
