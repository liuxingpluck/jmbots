/**
 * 网页打包：以 web/*.html 为入口，用 Bun 把 TSX 和 CSS 按需分包打进 dist/web（Static.ts 与 Embedded.ts 托管）。
 * 由 `bun run build:web` 调用。先清空 dist/web，免得旧文件混在里面；
 * 开启 splitting + antd / @ant-design/icons 子路径直连重写，避免桶文件把未用重组件打入首屏包。
 */
import type { BunPlugin } from 'bun';
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 代码目录（本文件在 web/ 下）。 */
const root = path.resolve(import.meta.dir, '..');

/** 打包输出目录：发布时（scripts/Build_Release.ts）放别处，不动正在被托管的 dist/web。 */
const outDir = process.env.JMBOTS_WEB_OUT ?? path.join(root, 'dist', 'web');


/**
 * 从包入口 ES 模块源码中提取 `export { default as Name } from './subpath'` 映射表。
 * @param entryPath node_modules 内 ES 入口文件绝对路径。
 * @param targetPrefix 子路径导入前缀（如 `antd/es/`）。
 */
function loadSubpathMap(entryPath: string, targetPrefix: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(entryPath)) return map;

  //M 逐条匹配生成的默认重导出语句，保持与当前安装版本完全一致。
  const content = fs.readFileSync(entryPath, 'utf8');
  const pattern = /export\s+\{\s*default\s+as\s+(\w+)\s*\}\s+from\s+['"]\.\/([^'"]+)['"]/gu;
  for (const match of content.matchAll(pattern)) {
    const exportedName = match[1];
    const subPath = match[2];
    if (exportedName !== undefined && subPath !== undefined) {
      map.set(exportedName, `${targetPrefix}${subPath}`);
    }
  }
  return map;
}


/**
 * 把单个命名导入项（如 `Button` 或 `theme as antdThemeAlg`）拆成导出名与本地绑定名。
 */
function parseNamedSpec(rawSpec: string): { imported: string; local: string } {
  const parts = rawSpec.split(/\s+as\s+/u);
  const imported = (parts[0] ?? '').trim();
  const local = (parts[1] ?? imported).trim();
  return { imported, local };
}


/** 去注释、去类型用的转译器：真正的解析器，比手写正则可靠。 */
const transpiler = new Bun.Transpiler();

/** 单引号、双引号字符串（含转义），整段换成空格；模板字符串不动，宁可多跳过。 */
const QUOTED = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/gu;


/**
 * 只留真正会跑的代码，给“命名空间有没有被整体用到、用到了哪些成员”的判断用：
 * 注释、纯类型写法由转译器去掉（JSX 里的文字转成字符串），再把普通字符串换成空格。
 * 注释里写“antd Tree”、导入路径 'antd/locale/zh_CN' 这类就不会再被当成整体用到（云端 26 M2）。
 * @param file 源文件路径，按扩展名选 ts 或 tsx 解析（.ts 里的 `<T>x` 断言按 tsx 解析会报错）。
 * @param source 去掉了这条命名空间导入的源码。
 * @returns 用来判断的文本，不拿来输出。
 */
function getRuntimeText(file: string, source: string): string {
  let loader: 'ts' | 'tsx' = 'ts';
  if (file.endsWith('.tsx')) {
    loader = 'tsx';
  }
  const code = transpiler.transformSync(source, loader);
  return code.replace(QUOTED, (literal) => ' '.repeat(literal.length));
}


/**
 * 将 `import * as ns from '<pkg>'` 按实际用到的 `ns.Name` 重写为子路径直连导入。
 * @param file 源文件路径，跳过重写时打在警告里。
 */
function rewriteNamespaceImport(
  file: string,
  source: string,
  pkgName: string,
  subpaths: ReadonlyMap<string, string>,
  aliasPrefix: string,
): string {
  const escapedPkg = pkgName.replaceAll('/', '\\/');
  const nsRegex = new RegExp(`^import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['"]${escapedPkg}['"]\\s*;?`, 'mu');
  const nsMatch = nsRegex.exec(source);
  if (nsMatch === null) return source;

  const ns = nsMatch[1];
  if (ns === undefined) return source;

  //M 只看会跑的代码：注释、类型、字符串里的字样不算用到。
  const withoutImport = source.replace(nsRegex, '');
  const runtime = getRuntimeText(file, withoutImport);

  //G 若文件把命名空间对象当作整体传递或动态下标访问，保守跳过重写以确保语义零偏差；跳过要说出来，不静默回退到桶文件。
  const bareUseRegex = new RegExp(`(?<![.\\w$])${ns}(?!\\s*\\.)\\b`, 'u');
  const bare = bareUseRegex.exec(runtime);
  if (bare !== null) {
    const shortName = path.relative(root, file);
    const around = runtime.slice(Math.max(0, bare.index - 30), bare.index + 30).replace(/\s+/gu, ' ');
    console.warn(`web/Build.ts：${shortName} 把 ${pkgName} 命名空间整体用到了（…${around}…），这个文件跳过子路径重写`);
    return source;
  }

  //M 扫描会跑的代码里所有 `ns.Name` 访问，仅拉入真正使用到的运行时子模块，同时保留 type 命名空间。
  const memberRegex = new RegExp(`(?<![.\\w$])${ns}\\.(\\w+)\\b`, 'gu');
  const usedNames = new Set<string>();
  for (const hit of runtime.matchAll(memberRegex)) {
    const prop = hit[1];
    if (prop !== undefined && subpaths.has(prop)) {
      usedNames.add(prop);
    }
  }

  const headerLines = [`import type * as ${ns} from '${pkgName}';`];
  for (const prop of usedNames) {
    const target = subpaths.get(prop);
    if (target !== undefined) {
      headerLines.push(`import ${aliasPrefix}${prop} from '${target}';`);
    }
  }

  let body = source.replace(nsRegex, headerLines.join('\n'));
  for (const prop of usedNames) {
    const propUseRegex = new RegExp(`(?<![.\\w$])${ns}\\.${prop}\\b`, 'gu');
    body = body.replace(propUseRegex, `${aliasPrefix}${prop}`);
  }
  return body;
}


/**
 * 将 `import { A, B as C, type T } from '<pkg>'` 重写为子路径直连导入，保留纯类型导入。
 */
function rewriteNamedImports(
  source: string,
  pkgName: string,
  subpaths: ReadonlyMap<string, string>,
): string {
  const escapedPkg = pkgName.replaceAll('/', '\\/');
  const namedRegex = new RegExp(`^import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escapedPkg}['"]\\s*;?`, 'gmu');
  return source.replace(namedRegex, (_full, rawList: string) => {
    const lines: string[] = [];
    const typeSpecs: string[] = [];
    for (const rawItem of rawList.split(',')) {
      const item = rawItem.trim();
      if (item === '') continue;
      if (item.startsWith('type ')) {
        typeSpecs.push(item.slice(5).trim());
        continue;
      }
      const { imported, local } = parseNamedSpec(item);
      const target = subpaths.get(imported);
      if (target !== undefined) {
        lines.push(`import ${local} from '${target}';`);
        continue;
      }
      typeSpecs.push(item);
    }
    if (typeSpecs.length > 0) {
      lines.push(`import type { ${typeSpecs.join(', ')} } from '${pkgName}';`);
    }
    return lines.join('\n');
  });
}


/**
 * 构建期将 `web/src/` 对 `antd` 与 `@ant-design/icons` 桶文件的导入精确拆成子路径导入。
 */
function createSubpathTreeShakePlugin(repoRoot: string): BunPlugin {
  const antdEntry = path.join(repoRoot, 'node_modules', 'antd', 'es', 'index.js');
  const iconsEntry = path.join(repoRoot, 'node_modules', '@ant-design', 'icons', 'es', 'icons', 'index.js');
  const antdMap = loadSubpathMap(antdEntry, 'antd/es/');
  const iconsMap = loadSubpathMap(iconsEntry, '@ant-design/icons/es/icons/');

  return {
    name: 'jmbots-antd-subpath',
    setup(build) {
      build.onLoad({ filter: /[\\/]web[\\/]src[\\/].*\.(?:ts|tsx)$/u }, (args) => {
        const raw = fs.readFileSync(args.path, 'utf8');
        let loader: 'ts' | 'tsx' = 'ts';
        if (args.path.endsWith('.tsx')) {
          loader = 'tsx';
        }
        if (!raw.includes('antd') && !raw.includes('@ant-design/icons')) {
          return { contents: raw, loader };
        }
        //M 先拆命名空间导入，再拆具名导入，彻底绕开 antd 桶文件的副作用全量拉取。
        let transformed = rewriteNamespaceImport(args.path, raw, 'antd', antdMap, '__antd_');
        transformed = rewriteNamedImports(transformed, 'antd', antdMap);
        transformed = rewriteNamespaceImport(args.path, transformed, '@ant-design/icons', iconsMap, '__icon_');
        transformed = rewriteNamedImports(transformed, '@ant-design/icons', iconsMap);
        return { contents: transformed, loader };
      });
    },
  };
}


/**
 * 修正并校验每个产物 HTML 的主入口脚本：
 * Bun 在多 HTML + splitting 模式下，会把大量共享块以 entrypoints[0]（index）命名，
 * 偶发将 dist/web/index.html 的 <script> 错指到同名共享块导致首页白屏；
 * 这里自动回指到真正含 `index.html 里缺少 #root` 与 `createRoot` 的主入口脚本，并全量断言所有 HTML 入口有效。
 */
function fixAndVerifyHtmlEntries(dir: string): void {
  const indexHtmlPath = path.join(dir, 'index.html');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const indexMatch = /<script[^>]+src="\.\/(assets\/[^"]+\.js)"/u.exec(indexHtml);
  if (indexMatch !== null && indexMatch[1] !== undefined) {
    const pointedPath = path.join(dir, indexMatch[1]);
    let pointedText = '';
    if (fs.existsSync(pointedPath)) {
      pointedText = fs.readFileSync(pointedPath, 'utf8');
    }
    if (!pointedText.includes('createRoot')) {
      const assetsDir = path.join(dir, 'assets');
      const candidates = fs.readdirSync(assetsDir).filter((file) => {
        if (!file.endsWith('.js')) return false;
        const body = fs.readFileSync(path.join(assetsDir, file), 'utf8');
        return body.includes('index.html 里缺少 #root') && body.includes('createRoot');
      });
      if (candidates.length !== 1 || candidates[0] === undefined) {
        throw new Error(`web/Build.ts：找不到唯一的首页入口脚本（命中 ${candidates.length} 个）`);
      }
      const fixedHtml = indexHtml.replace(`./${indexMatch[1]}`, `./assets/${candidates[0]}`);
      fs.writeFileSync(indexHtmlPath, fixedHtml, 'utf8');
      console.log(`web/Build.ts：已修正 index.html 入口脚本 → ./assets/${candidates[0]}`);
    }
  }

  const htmlFiles = fs.readdirSync(dir).filter((name) => name.endsWith('.html'));
  for (const name of htmlFiles) {
    const html = fs.readFileSync(path.join(dir, name), 'utf8');
    const match = /<script[^>]+src="\.\/(assets\/[^"]+\.js)"/u.exec(html);
    if (match === null || match[1] === undefined) {
      throw new Error(`web/Build.ts：${name} 缺少主入口 script 标签`);
    }
    const jsPath = path.join(dir, match[1]);
    if (!fs.existsSync(jsPath)) {
      throw new Error(`web/Build.ts：${name} 引用的脚本不存在：${match[1]}`);
    }
    const js = fs.readFileSync(jsPath, 'utf8');
    if (!js.includes('createRoot')) {
      throw new Error(`web/Build.ts：${name} 指向了错误分块 ${match[1]}（不含 createRoot）`);
    }
  }
}


//M 清空旧产物，再从 HTML 入口按需分包构建。
fs.rmSync(outDir, { recursive: true, force: true });

/** 打包结果；success 为 false 时 logs 里是原因。 */
const result = await Bun.build({
  entrypoints: [
    path.join(root, 'web', 'index.html'),
    path.join(root, 'web', 'graph.html'),
    path.join(root, 'web', 'memory.html'),
    path.join(root, 'web', 'wechat-kefu.html'),
    path.join(root, 'web', 'tutorial.html'),
    path.join(root, 'web', 'model-notes.html'),
    path.join(root, 'web', 'work-decision.html'),
    path.join(root, 'web', 'frpc.html'),
    path.join(root, 'web', 'knowledge.html'),
  ],
  outdir: outDir,
  //M 产物路径照 web/ 算：不写时 Bun 按参与打包的文件算公共根，图里一旦有 web 外面的文件，html 就多套一层 web/。
  root: path.join(root, 'web'),
  target: 'browser',
  splitting: true,
  minify: true,
  plugins: [createSubpathTreeShakePlugin(root)],
  naming: { entry: '[dir]/[name].[ext]', chunk: 'assets/[name]-[hash].[ext]', asset: 'assets/[name]-[hash].[ext]' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

//G 打包失败：打印原因，退出码 1。
if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

//M 修正并校验全部 HTML 入口脚本，防止 Bun splitting 撞名导致白屏。
fixAndVerifyHtmlEntries(outDir);

//M 列出产物和大小，方便核对。
for (const output of result.outputs) {
  console.log(`${path.relative(root, output.path)}  ${(output.size / 1024).toFixed(1)} KiB`);
}
