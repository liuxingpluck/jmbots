/**
 * codegraph 工具的实现：用 TypeScript 自带的语言服务查代码关系（和编辑器里“查找所有引用”“调用层级”是同一套），
 * 不另外建图文件，也不用装别的东西。
 * 来由（用户 11-02）：要一个类似 graphify 的工具加快检索。Go、Rust、Python 三个 graphify 实测都会漏边
 * （比如 Python 版查不到 Feishu.ts 对 Engine.ts 里嵌套函数 handleMessage 的调用），所以自己做。
 * 能查：
 *   find     按名字找声明在哪
 *   callers  谁用到它（直接调用、当回调传、经对象属性转出去再被调用的都算）
 *   callees  它调用了谁
 *   deps     一个文件导入了哪些文件和包
 *   users    哪些文件导入了这个文件
 *   path     两个文件之间的导入路径
 * 项目范围：从给的位置往上找最近的 tsconfig.json，按它的文件清单；找不到就收那个目录下的 .ts/.tsx/.js 等（跳过 node_modules、dist、.git）。
 * 语言服务按项目根目录缓存，文件版本用修改时间，文件改过下次查询会自动重新分析。只认 TypeScript、JavaScript；文档正文用 grep 工具搜。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';


/** 一次查询。 */
export interface GraphQuery {
  /** 查什么。 */
  action: 'find' | 'callers' | 'callees' | 'deps' | 'users' | 'path';
  /** 从哪里往上找项目（tsconfig.json）：目录或文件的绝对路径。 */
  start: string;
  /** 函数、方法、类等的名字（find、callers、callees 用）；可写成“外层.名字”，如 createEngine.handleMessage。 */
  name?: string;
  /** 文件的绝对路径：deps、users、path 的起点；find、callers、callees 用它限定只看这个文件里的声明。 */
  file?: string;
  /** path 的终点文件，绝对路径。 */
  to?: string;
}


/** 一个项目：根目录、编译选项、文件清单和它的语言服务。 */
interface Project {
  /** 根目录（tsconfig.json 所在目录，或没有 tsconfig 时给的目录）。 */
  root: string;
  /** 编译选项。 */
  options: ts.CompilerOptions;
  /** 项目里的文件（绝对路径，用 /）。每次查询都重新读，新加的文件能被看到。 */
  files: string[];
  /** 语言服务。 */
  service: ts.LanguageService;
}


/** 输出最多几行，超了截掉并说明。 */
const MAX_LINES = 200;

/** 没有 tsconfig 时最多收多少个文件，超了让模型给更小的目录。 */
const MAX_FILES = 3000;

/** 没有 tsconfig 时收这些扩展名。 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** 已经建好的项目：根目录 → 项目。 */
const projects = new Map<string, Project>();


/**
 * 统一成 TypeScript 用的写法（/ 分隔）。
 * @param file 路径。
 */
function slash(file: string): string {
  return file.replace(/\\/g, '/');
}


/**
 * 读编译选项和文件清单。
 * @param root 根目录。
 * @param configFile tsconfig.json；没有时是 undefined。
 * @throws tsconfig 读不了，或没有 tsconfig 时文件太多。
 */
function readSettings(root: string, configFile: string | undefined): { options: ts.CompilerOptions; files: string[] } {
  if (configFile) {
    /** tsconfig 原文解析结果。 */
    const read = ts.readConfigFile(configFile, (file) => ts.sys.readFile(file));
    if (read.error) {
      throw new Error(`读不了 ${configFile}：${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
    }
    /** 展开 include、exclude 后的结果。 */
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configFile);
    return { options: { ...parsed.options, noEmit: true }, files: parsed.fileNames.map(slash) };
  }
  /** 目录下的源文件。 */
  const files = ts.sys.readDirectory(root, SOURCE_EXTENSIONS, ['**/node_modules', '**/dist', '**/.git'], ['**/*']).map(slash);
  if (files.length > MAX_FILES) {
    throw new Error(`${root} 下有 ${files.length} 个源文件又没有 tsconfig.json，太多了；给一个更小的目录`);
  }
  return {
    options: {
      allowJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
    },
    files,
  };
}


/**
 * 找到（或建好）start 所在的项目，并刷新文件清单。
 * @param start 目录或文件的绝对路径。
 */
function loadProject(start: string): Project {
  /** 起点目录。 */
  const startDir = ts.sys.directoryExists(start) ? start : path.dirname(start);
  /** 最近的 tsconfig.json。 */
  const configFile = ts.findConfigFile(slash(startDir), (file) => ts.sys.fileExists(file), 'tsconfig.json');
  /** 根目录。 */
  const root = slash(configFile ? path.dirname(configFile) : startDir);
  /** 选项和文件。 */
  const settings = readSettings(root, configFile);
  /** 缓存里的项目。 */
  const cached = projects.get(root);
  if (cached) {
    cached.options = settings.options;
    cached.files = settings.files;
    return cached;
  }
  /** 新项目；service 下面马上补上。 */
  const project = { root, ...settings } as Project;
  /** 语言服务向我们要文件、选项的地方。 */
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => project.files,
    getScriptVersion: (file) => String(fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0),
    getScriptSnapshot: (file) => {
      /** 文件内容。 */
      const text = ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => project.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (file) => ts.sys.fileExists(file),
    readFile: (file) => ts.sys.readFile(file),
    readDirectory: (dir, extensions, exclude, include, depth) => ts.sys.readDirectory(dir, extensions, exclude, include, depth),
    directoryExists: (dir) => ts.sys.directoryExists(dir),
    getDirectories: (dir) => ts.sys.getDirectories(dir),
  };
  project.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  projects.set(root, project);
  return project;
}


/**
 * 给人看的位置：相对根目录的路径加行号；项目外（依赖、标准库）的标成“外部”。
 * @param project 项目。
 * @param file 文件。
 * @param position 字符位置。
 */
function placeOf(project: Project, file: string, position: number): string {
  /** 相对路径。 */
  const relative = slash(path.relative(project.root, file));
  if (relative.includes('node_modules/')) {
    return `外部 ${relative.slice(relative.lastIndexOf('node_modules/') + 'node_modules/'.length)}`;
  }
  /** 源文件（取行号用）。 */
  const source = project.service.getProgram()?.getSourceFile(file);
  if (!source) {
    return relative;
  }
  return `${relative}:${source.getLineAndCharacterOfPosition(position).line + 1}`;
}


/**
 * 某个位置所在那一行的内容（去掉首尾空白，太长截断）。
 * @param source 源文件。
 * @param position 字符位置。
 */
function lineText(source: ts.SourceFile, position: number): string {
  /** 行号（从 0 数）。 */
  const line = source.getLineAndCharacterOfPosition(position).line;
  /** 这一行。 */
  const text = source.text.slice(source.getPositionOfLineAndCharacter(line, 0), source.getLineEndOfPosition(position)).trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}


/**
 * 找某个位置上最小的节点。
 * @param source 源文件。
 * @param node 从哪个节点往下找。
 * @param position 字符位置。
 */
function nodeAt(source: ts.SourceFile, node: ts.Node, position: number): ts.Node {
  /** 包住这个位置的子节点。 */
  const child = node.forEachChild((item) => (item.getStart(source) <= position && position < item.getEnd() ? item : undefined));
  return child ? nodeAt(source, child, position) : node;
}


/**
 * 函数类节点的名字：有名字用名字，匿名函数看它赋给了哪个变量或属性。
 * @param source 源文件。
 * @param node 函数类节点。
 * @returns 名字；真匿名（如直接当参数传的箭头函数）时是 undefined。
 */
function functionName(source: ts.SourceFile, node: ts.SignatureDeclaration): string | undefined {
  if (node.name) {
    return node.name.getText(source);
  }
  /** 父节点。 */
  const parent = node.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === node) {
    return parent.name.getText(source);
  }
  return undefined;
}


/**
 * 某个位置在哪个函数里（最近的有名字的那层；中间隔着匿名函数时注明）。
 * @param source 源文件。
 * @param position 字符位置。
 */
function enclosingName(source: ts.SourceFile, position: number): string {
  /** 中间隔了几层匿名函数。 */
  let anonymous = 0;
  for (let node: ts.Node | undefined = nodeAt(source, source, position).parent; node; node = node.parent) {
    if (!ts.isFunctionLike(node)) {
      continue;
    }
    /** 这一层的名字。 */
    const name = functionName(source, node);
    if (name) {
      return anonymous > 0 ? `${name} 里的匿名函数` : name;
    }
    anonymous += 1;
  }
  return anonymous > 0 ? '文件顶层的匿名函数' : '文件顶层';
}


/**
 * 声明的名字所在位置。navigateTo 给的位置是整个声明的开头，带 async、export 等修饰时落在修饰词上，
 * 调用层级在那里认不出函数，所以换到名字上。
 * @param project 项目。
 * @param item 声明。
 */
function namePosition(project: Project, item: ts.NavigateToItem): number {
  /** 声明所在源文件。 */
  const source = project.service.getProgram()?.getSourceFile(item.fileName);
  if (!source) {
    return item.textSpan.start;
  }
  for (let node: ts.Node | undefined = nodeAt(source, source, item.textSpan.start); node && !ts.isSourceFile(node); node = node.parent) {
    /** 这一层的名字（不是声明时是 undefined）。 */
    const name = ts.getNameOfDeclaration(node as ts.Declaration);
    if (name && node.getStart(source) === item.textSpan.start) {
      return name.getStart(source);
    }
  }
  return item.textSpan.start;
}


/**
 * 按名字找声明。
 * @param project 项目。
 * @param name 名字，可写成“外层.名字”。
 * @param file 只看这个文件；不限定时 undefined。
 */
function findDeclarations(project: Project, name: string, file: string | undefined): ts.NavigateToItem[] {
  /** “外层.名字”拆开。 */
  const dot = name.lastIndexOf('.');
  /** 外层名字；没写时是空串。 */
  const container = dot > 0 ? name.slice(0, dot) : '';
  /** 名字本身。 */
  const short = dot > 0 ? name.slice(dot + 1) : name;
  return project.service
    .getNavigateToItems(short, 500, file === undefined ? undefined : slash(file), true)
    .filter((item) => item.name === short && (container === '' || item.containerName === container) && !item.fileName.includes('/node_modules/'));
}


/**
 * 找不到声明时的说法，顺带列出名字相近的。
 * @param project 项目。
 * @param name 名字。
 */
function notFound(project: Project, name: string): string {
  /** 名字相近的声明。 */
  const similar = project.service.getNavigateToItems(name.slice(name.lastIndexOf('.') + 1), 20, undefined, true)
    .filter((item) => !item.fileName.includes('/node_modules/'))
    .map((item) => `  ${item.containerName ? `${item.containerName}.` : ''}${item.name}（${item.kind}） ${placeOf(project, item.fileName, item.textSpan.start)}`);
  return `在 ${project.root} 里没找到叫 ${name} 的声明${similar.length > 0 ? `；名字相近的：\n${similar.join('\n')}` : ''}`;
}


/**
 * 声明的一行介绍。
 * @param project 项目。
 * @param item 声明。
 */
function describeDeclaration(project: Project, item: ts.NavigateToItem): string {
  return `${item.containerName ? `${item.containerName}.` : ''}${item.name}（${item.kind}） ${placeOf(project, item.fileName, item.textSpan.start)}`;
}


/**
 * 谁用到了这个声明。从声明出发查引用；引用落在对象的简写属性上（如 return { handleMessage }）时，
 * 再从那个属性查一层，这样 engine.handleMessage(...) 这种经返回对象转出去的调用也能查到。
 * @param project 项目。
 * @param item 声明。
 * @returns 每处引用一行：位置、在哪个函数里、那一行代码。
 */
function callersOf(project: Project, item: ts.NavigateToItem): string[] {
  /** 程序。 */
  const program = project.service.getProgram();
  /** 已经查过的起点（文件:位置）。 */
  const searched = new Set<string>();
  /** 声明本身的名字位置。 */
  const start = namePosition(project, item);
  /** 已经记下的引用（文件:位置）；声明本身不算引用，先放进去。 */
  const seen = new Set<string>([`${item.fileName}:${start}`]);
  /** 结果。 */
  const lines: string[] = [];
  /** 待查的起点。 */
  const queue: { file: string; position: number }[] = [{ file: item.fileName, position: start }];
  for (let next = queue.shift(); next; next = queue.shift()) {
    /** 起点的键。 */
    const key = `${next.file}:${next.position}`;
    if (searched.has(key)) {
      continue;
    }
    searched.add(key);
    for (const symbol of project.service.findReferences(next.file, next.position) ?? []) {
      for (const reference of symbol.references) {
        /** 引用所在源文件。 */
        const source = program?.getSourceFile(reference.fileName);
        /** 引用的键。 */
        const referenceKey = `${reference.fileName}:${reference.textSpan.start}`;
        if (!source || reference.isDefinition || seen.has(referenceKey)) {
          continue;
        }
        seen.add(referenceKey);
        if (ts.isShorthandPropertyAssignment(nodeAt(source, source, reference.textSpan.start).parent)) {
          queue.push({ file: reference.fileName, position: reference.textSpan.start });
        }
        lines.push(`  ${placeOf(project, reference.fileName, reference.textSpan.start)}（位于 ${enclosingName(source, reference.textSpan.start)}）  ${lineText(source, reference.textSpan.start)}`);
      }
    }
  }
  return lines;
}


/**
 * 这个声明调用了谁（按调用层级的“向外调用”）。
 * @param project 项目。
 * @param item 声明。
 * @returns 每个被调用的函数一行：名字、位置、调了几处。
 */
function calleesOf(project: Project, item: ts.NavigateToItem): string[] {
  /** 调用层级里的这一项（可能有多个，如函数重载）。 */
  const prepared = project.service.prepareCallHierarchy(item.fileName, namePosition(project, item));
  /** 统一成数组。 */
  const roots = prepared === undefined ? [] : [prepared].flat();
  return roots.flatMap((root) => project.service.provideCallHierarchyOutgoingCalls(root.file, root.selectionSpan.start).map((call) => {
    /** 被调用的函数。 */
    const target = call.to;
    return `  ${target.containerName ? `${target.containerName}.` : ''}${target.name}（${target.kind}） ${placeOf(project, target.file, target.selectionSpan.start)}，调了 ${call.fromSpans.length} 处`;
  }));
}


/**
 * 一个文件导入了哪些项目内文件和外部包（含只导入类型的）。
 * @param project 项目。
 * @param file 文件。
 */
function importsOf(project: Project, file: string): { files: string[]; packages: string[] } {
  /** 导入语句里的模块名。 */
  const imported = ts.preProcessFile(ts.sys.readFile(file) ?? '', true, true).importedFiles;
  /** 项目内文件。 */
  const files = new Set<string>();
  /** 外部包（含 node: 内置模块）。 */
  const packages = new Set<string>();
  for (const module of imported) {
    /** 解析结果。 */
    const resolved = ts.resolveModuleName(module.fileName, file, project.options, ts.sys).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) {
      packages.add(module.fileName);
      continue;
    }
    files.add(slash(resolved.resolvedFileName));
  }
  return { files: [...files], packages: [...packages] };
}


/**
 * 沿导入关系找 from 到 to 的最短路径。
 * @param project 项目。
 * @param from 起点文件。
 * @param to 终点文件。
 * @returns 路径上的文件；没有路径时是 undefined。
 */
function importPath(project: Project, from: string, to: string): string[] | undefined {
  /** 每个文件是从哪个文件走过来的。 */
  const cameFrom = new Map<string, string>([[from, '']]);
  /** 待走的文件。 */
  const queue = [from];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    if (current === to) {
      /** 倒着拼回去的路径。 */
      const chain = [current];
      for (let back = cameFrom.get(current); back; back = cameFrom.get(back)) {
        chain.unshift(back);
      }
      return chain;
    }
    for (const next of importsOf(project, current).files) {
      if (!cameFrom.has(next)) {
        cameFrom.set(next, current);
        queue.push(next);
      }
    }
  }
  return undefined;
}


/**
 * 要求给了文件且存在。
 * @param file 文件。
 * @param name 参数名（报错用）。
 * @throws 没给或不存在。
 */
function requireFile(file: string | undefined, name: string): string {
  if (file === undefined) {
    throw new Error(`这个查询要给 ${name}`);
  }
  if (!ts.sys.fileExists(file)) {
    throw new Error(`${file} 不存在`);
  }
  return slash(file);
}


/**
 * 按名字查声明，再对每个声明做 each。
 * @param project 项目。
 * @param query 查询。
 * @param title 每个声明前的标题（如“谁用到了”）。
 * @param each 对一个声明要列的行。
 */
function forEachDeclaration(project: Project, query: GraphQuery, title: string, each: (item: ts.NavigateToItem) => string[]): string[] {
  if (!query.name) {
    throw new Error(`${query.action} 要给 name`);
  }
  /** 找到的声明。 */
  const declarations = findDeclarations(project, query.name, query.file);
  if (declarations.length === 0) {
    return [notFound(project, query.name)];
  }
  return declarations.flatMap((item) => {
    /** 这个声明的结果。 */
    const lines = each(item);
    return [`${title} ${describeDeclaration(project, item)}：`, ...(lines.length > 0 ? lines : ['  （没有）']), ''];
  });
}


/**
 * 查一次代码关系。
 * @param query 查询。
 * @returns 给模型看的文字：路径相对项目根目录，带行号。
 * @throws 参数不全、文件不存在、tsconfig 读不了时抛错。
 */
export function queryGraph(query: GraphQuery): string {
  /** 项目。 */
  const project = loadProject(query.start);
  /** 结果行。 */
  let lines: string[];
  switch (query.action) {
    case 'find':
      if (!query.name) {
        throw new Error('find 要给 name');
      }
      lines = findDeclarations(project, query.name, query.file).map((item) => describeDeclaration(project, item));
      if (lines.length === 0) {
        lines = [notFound(project, query.name)];
      }
      break;
    case 'callers':
      lines = forEachDeclaration(project, query, '谁用到了', (item) => callersOf(project, item));
      break;
    case 'callees':
      lines = forEachDeclaration(project, query, '调用了谁：', (item) => calleesOf(project, item));
      break;
    case 'deps': {
      /** 导入。 */
      const imports = importsOf(project, requireFile(query.file, 'file'));
      lines = ['项目内文件：', ...imports.files.map((file) => `  ${placeOf(project, file, 0).replace(/:1$/, '')}`), '外部包：', ...imports.packages.map((name) => `  ${name}`)];
      break;
    }
    case 'users': {
      /** 目标文件。 */
      const target = requireFile(query.file, 'file');
      lines = project.files.filter((file) => importsOf(project, file).files.includes(target)).map((file) => slash(path.relative(project.root, file)));
      if (lines.length === 0) {
        lines = ['项目里没有文件导入它'];
      }
      break;
    }
    case 'path': {
      /** 起点。 */
      const from = requireFile(query.file, 'file');
      /** 终点。 */
      const to = requireFile(query.to, 'to');
      /** 正向的路径。 */
      const forward = importPath(project, from, to);
      /** 正向找不到就反过来找。 */
      const chain = forward ?? importPath(project, to, from);
      lines = chain
        ? [`${forward ? '' : '（反方向）'}${chain.map((file) => slash(path.relative(project.root, file))).join(' → ')}`]
        : ['两个文件之间没有导入关系（两个方向都查过）'];
      break;
    }
    default:
      throw new Error(`不认识的 action ${String(query.action)}；可用 find、callers、callees、deps、users、path`);
  }
  /** 头一行：项目在哪、多少文件。 */
  const header = `项目 ${project.root}（${project.files.length} 个文件）`;
  if (lines.length > MAX_LINES) {
    return [header, ...lines.slice(0, MAX_LINES), `[只列了前 ${MAX_LINES} 行，共 ${lines.length} 行；用 file 限定范围]`].join('\n');
  }
  return [header, ...lines].join('\n');
}
