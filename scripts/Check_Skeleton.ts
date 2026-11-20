/** 统计骨架代码行与静态依赖，超过约定行数时只提示。 */
import * as path from 'node:path';
import * as ts from 'typescript';

/** 主线行数只计这四份源码。 */
const main = new Set(['Main.ts', 'Resources.ts', 'Sessions.ts', 'Tools.ts']);
const budget = 820;
const root = path.resolve(import.meta.dir, '..');
const src = path.join(root, 'src7');

/**
 * 一行只要有语法 token 就算一行；忽略注释、空行和多行字面量中纯空白的行。
 * @param node 要统计的源码节点。
 * @param source 节点所在文件，用于定位行号。
 * @returns 该节点覆盖的代码行数。
 */
function countCode(node: ts.Node, source: ts.SourceFile): number {
  const lines = source.text.split(/\r?\n/u);
  const used = new Set<number>();
  const visit = (part: ts.Node): void => {
    if (ts.isJSDoc(part)) return;

    const children = part.getChildren(source);
    for (const child of children) {
      visit(child);
    }
    if (!ts.isToken(part)) return;

    const start = part.getStart(source);
    if (part.end <= start) return;

    const first = source.getLineAndCharacterOfPosition(start).line;
    const last = source.getLineAndCharacterOfPosition(part.end - 1).line;
    for (let line = first; line <= last; line += 1) {
      if (lines[line]?.trim()) {
        used.add(line);
      }
    }
  };
  visit(node);
  return used.size;
}

/** 在 src7 下统一路径分隔符，后面的分类只看相对路径。 */
function getRelative(file: string): string {
  return path.relative(src, file).replaceAll(path.sep, '/');
}

/** 归属插件根目录，同一个插件内的子目录不算跨插件。 */
function getPlugin(file: string): string | undefined {
  return /^plugins\/([^/]+)\//u.exec(file)?.[1];
}

/** 按 import 声明区分运行时依赖和纯类型依赖。 */
function readsValues(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return false;

  const bindings = clause?.namedBindings;
  if (clause?.name || !bindings || !ts.isNamedImports(bindings)) return true;

  return bindings.elements.length === 0 || bindings.elements.some((item) => !item.isTypeOnly);
}

//M 复用后端 TypeScript 配置解析导入及符号，排除测试入口和测试目录。
const config = path.join(root, 'tsconfig.json');
const settings = ts.getParsedCommandLineOfConfigFile(config, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (problem) => {
    throw new Error(ts.flattenDiagnosticMessageText(problem.messageText, '\n'));
  },
})!;
const inputs = settings.fileNames.filter((file) => {
  const relative = getRelative(file);
  return !relative.startsWith('../') && !relative.startsWith('tests/')
    && relative.endsWith('.ts') && !/\.(test|spec|d)\.ts$/u.test(relative);
});

/**
 * 单独检查服务和工具层。Main.ts 负责载入整个插件登记表，由全局类型检查覆盖。
 * @returns 检查通过为 0，有诊断为 1。
 */
function checkTypes(): number {
  //M 只替换入口，沿用后端 tsconfig 的所有编译选项。
  const entries = inputs.filter((file) => {
    const relative = getRelative(file);
    return (main.has(relative) && relative !== 'Main.ts') || relative.startsWith('utils/');
  });
  const skeleton = ts.createProgram(entries, settings.options);
  const diagnostics = ts.getPreEmitDiagnostics(skeleton);
  if (diagnostics.length === 0) {
    console.log(`骨架类型检查通过（${String(entries.length)} 个入口）`);
    return 0;
  }

  const format = {
    getCanonicalFileName: (file: string) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => ts.sys.newLine,
  };
  const message = ts.formatDiagnosticsWithColorAndContext(diagnostics, format);
  console.error(message);
  return 1;
}

//M 独立类型检查走自己的入口，统计命令仍然只报告。
if (process.argv.includes('--typecheck')) {
  const status = checkTypes();
  process.exit(status);
}

const program = ts.createProgram(inputs, settings.options);
const checker = program.getTypeChecker();
const totals = { main: 0, utils: 0, channels: 0 };
const uses = new Map<ts.Symbol, Set<string>>();

//M 先计行并登记 utils 的导出函数，过滤三行及以下的小函数。
for (const input of inputs) {
  const file = getRelative(input);
  const source = program.getSourceFile(input)!;
  if (main.has(file)) {
    totals.main += countCode(source, source);
  }
  if (getPlugin(file) === 'channels') {
    totals.channels += countCode(source, source);
  }
  if (!file.startsWith('utils/')) {
    continue;
  }

  totals.utils += countCode(source, source);
  const module = checker.getSymbolAtLocation(source);
  if (!module) {
    continue;
  }

  for (const symbol of checker.getExportsOfModule(module)) {
    const value = symbol.valueDeclaration;
    if (!value || !ts.isFunctionDeclaration(value) || value.getSourceFile() !== source) {
      continue;
    }
    if (countCode(value, source) <= 3) {
      continue;
    }

    uses.set(symbol, new Set());
  }
}

//M 按符号统计实际引用；静态导入按起点和目标归属列出位置。
const cross: string[] = [];
for (const input of inputs) {
  const file = getRelative(input);
  const source = program.getSourceFile(input)!;
  const owner = getPlugin(file);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const targetFile = path.resolve(path.dirname(input), node.moduleSpecifier.text);
      const target = getPlugin(getRelative(targetFile));
      const crossesPlugins = owner && target && owner !== target && owner !== 'channels' && target !== 'channels';
      if (crossesPlugins && readsValues(node)) {
        const start = node.getStart(source);
        const line = source.getLineAndCharacterOfPosition(start).line + 1;
        const relative = getRelative(targetFile);
        cross.push(`src7/${file}:${String(line)} → src7/${relative}`);
      }
      return;
    }
    if (ts.isExportDeclaration(node)) return;

    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      if (symbol && symbol.valueDeclaration !== node.parent) {
        uses.get(symbol)?.add(owner ?? '骨架');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

console.log(`骨架主线 ${String(totals.main)} 行；utils ${String(totals.utils)} 行；plugins/channels ${String(totals.channels)} 行`);
if (totals.main > budget) {
  console.log(`提醒：骨架主线超过 ${String(budget)} 行预算`);
}

console.log('只有一个插件使用的 utils 导出函数');
for (const [symbol, owners] of uses) {
  if (owners.size !== 1 || owners.has('骨架')) {
    continue;
  }

  const decl = symbol.valueDeclaration!;
  const file = getRelative(decl.getSourceFile().fileName);
  const owner = [...owners][0];
  console.log(`src7/${file} ${symbol.name} → ${owner}`);
}
console.log(`插件间按值导入 ${String(cross.length)} 处（共用渠道协议除外）`);
for (const item of cross) {
  console.log(item);
}
