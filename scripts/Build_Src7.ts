/**
 * 把 src7 编译成单个 Windows/本机二进制（jmbots-server），给基地壳子托管。
 * 网页、出厂提示词和 src7 源码原文（给 /flow/“看启动”取注释）打进程序里。必须用 --out 指定输出目录。
 * --out 可以是运行时的 updates/：只放带版本号的那一个，基地扫到后由 POST :30085/update/apply 换版；
 * 运行时目录本身、jmbotsDataS4（旧正式版）、dist/release* 不许写。
 *
 * 运行：bun scripts/Build_Src7.ts --out <输出目录> [--skip_checks yes]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as serveProcess from '../scripts6/Serve_Process.ts';


/** 这个平台可执行文件的后缀。 */
const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * 从某个时刻到现在过了几秒，留一位小数。
 * @param startedAt 开始时间，毫秒。
 * @returns 秒数文字。
 */
function seconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}


/**
 * 跑一步，失败就退出。
 * @param name 步骤名。
 * @param args 传给 bun 的参数。
 * @param env 额外的环境变量。
 * 副作用：跑子进程、打印。
 */
function step(name: string, args: string[], env?: Record<string, string>): void {
  const startedAt = Date.now();
  const command = [process.execPath, ...args];
  const options = {
    cwd: serveProcess.ROOT,
    env: env === undefined ? undefined : { ...process.env, ...env },
    stdout: 'inherit' as const,
    stderr: 'inherit' as const,
  };
  const result = Bun.spawnSync(command, options);
  if (result.exitCode !== 0) {
    console.error(`${name} 没过，退出码 ${String(result.exitCode)}`);
    process.exit(1);
  }
  console.log(`${name} 通过（${seconds(startedAt)} 秒）`);
}


/**
 * 一个目录下全部文件，相对路径用 /。
 * @param dir 目录。
 * @returns 相对路径。
 */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });
  return entries.map((item) => item.replaceAll('\\', '/')).filter((item) => fs.statSync(path.join(dir, item)).isFile());
}


/**
 * 路径写成 import 里能用的样子。
 * @param file 路径。
 * @returns 带引号的导入路径。
 */
function importPath(file: string): string {
  return JSON.stringify(file.replaceAll('\\', '/'));
}


/**
 * 生成编译入口：先登记内嵌文件，再跑 Main.ts。
 * @param webDir 打包好的网页。
 * @returns 入口文件路径。
 * 副作用：写 Register.ts 和 Entry.ts。
 */
function writeEntry(workDir: string, webDir: string): string {
  //M src7 的源码原文（不含测试）：boot-trail 照“文件:行号”取 JSDoc 给 /flow/ 的“看启动”，编译版磁盘上没有源码。
  //M   拷成 workDir/src7-text/<路径>.ts.txt 再嵌：.ts 原文件直接 with { type: 'file' }，Bun 会把同一个模块当成文件资源，
  //M   Main.ts 那边的命名导出就没了（0.7.6 编包时踩到）。登记名仍是 src7/<路径>。
  const textDir = path.join(workDir, 'src7-text');
  const sources = walk(path.join(serveProcess.ROOT, 'src7'))
    .filter((item) => item.endsWith('.ts') && !item.endsWith('.test.ts'))
    .map((item): [string, string] => {
      const copy = path.join(textDir, `${item}.txt`);
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(path.join(serveProcess.ROOT, 'src7', item), copy);
      return [`src7/${item}`, copy];
    });
  const files: [string, string][] = [
    ...walk(webDir).map((item): [string, string] => [`web/${item}`, path.join(webDir, item)]),
    ...walk(path.join(serveProcess.ROOT, 'prompts'))
      .filter((item) => item.endsWith('.md') && path.basename(item) !== 'README.md')
      .map((item): [string, string] => [`prompts/${item}`, path.join(serveProcess.ROOT, 'prompts', item)]),
    ...sources,
  ];
  const registrations = files.map(([name], index) => `  ${JSON.stringify(name)}: f${String(index)},`);
  const register = [
    `import * as embedded from ${importPath(path.join(serveProcess.ROOT, 'src7', 'utils', 'Embedded.ts'))};`,
    ...files.map(([, file], index) => `import f${String(index)} from ${importPath(file)} with { type: 'file' };`),
    `embedded.register({\n${registrations.join('\n')}\n}, ${String(Date.now())});`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(workDir, 'Register.ts'), register);
  const entry = path.join(workDir, 'Entry.ts');
  fs.writeFileSync(entry, `import './Register.ts';\nimport ${importPath(path.join(serveProcess.ROOT, 'src7', 'Main.ts'))};\n`);
  return entry;
}


/**
 * 输出目录是不是正式产物目录（不许写）。运行时的 updates/ 本身放行，那是基地换版的入口。
 * @param outDir 输出目录，main 已经转成绝对路径。
 * @returns 禁止的话给出原因。
 */
function forbiddenReason(outDir: string): string | undefined {
  const root = path.resolve(serveProcess.ROOT);
  const aidata = path.resolve(root, '..', '..');
  /** 正在用的运行时目录：它们的 updates/ 可以写，别处不许写。 */
  const runtimes = [path.join(aidata, 'AIJMBots', 'jmbotsData'), path.join(root, 'jmbotsData')];
  if (runtimes.some((dir) => outDir === path.join(dir, 'updates'))) return undefined;

  const official = [
    ...runtimes,
    path.join(aidata, 'AIJMBots', 'jmbotsDataS4'),
    path.join(root, 'dist', 'release'),
    path.join(root, 'dist', 'release6'),
  ];
  for (const dir of official) {
    if (outDir === dir || outDir.startsWith(dir + path.sep)) {
      return `不能写到正式目录 ${dir}（运行时只许写它的 updates/）`;
    }
  }
  return undefined;
}


/**
 * 编译 src7。
 * 副作用：写中间产物和 --out 目录。
 */
async function main(): Promise<void> {
  const outOption = serveProcess.option('out', '');
  if (outOption === '') {
    console.error('必须写 --out <输出目录>：测试写到 cache/ 下，换版写到 <运行时>/updates');
    process.exit(1);
  }

  //M 在入口转成绝对路径。Register.ts 里的 import 照这个路径写，写成相对路径的话 bun 会把它当包名去找（11-16 经 /api/run 传相对路径时踩到）。
  const outDir = path.resolve(outOption);
  const blocked = forbiddenReason(outDir);
  if (blocked !== undefined) {
    console.error(blocked);
    process.exit(1);
  }
  if (serveProcess.option('skip_checks', 'yes') !== 'yes') {
    const startedAt = Date.now();
    step('类型检查', ['x', 'tsc', '-p', 'tsconfig.src7.json']);
    console.log(`检查一共 ${seconds(startedAt)} 秒`);
  }
  //M 中间产物放项目自己的 cache/，不落在 --out 里，免得基地扫 updates/ 时看到。
  const workDir = path.join(serveProcess.ROOT, 'cache', 'build-src7-work');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const webDir = path.join(workDir, 'web');
  step('打包网页', [path.join(serveProcess.ROOT, 'web', 'Build.ts')], { JMBOTS_WEB_OUT: webDir });
  const built = path.join(workDir, `jmbots-server${EXE}`);
  const entryFile = writeEntry(workDir, webDir);
  // 2026-11-14 19:30（Claude 4.5）：--sourcemap 把源码映射编进 exe，trace 打的“文件:行”才对得上 plugins/xxx/index.ts。
  step('编译', ['build', '--compile', '--sourcemap', entryFile, '--outfile', built]);
  const check = Bun.spawnSync([built, 'version'], { stdout: 'pipe', stderr: 'pipe' });
  if (check.exitCode !== 0) {
    console.error(`编译出来的程序跑不起来：${check.stderr.toString().slice(-2000)}`);
    process.exit(1);
  }
  const printed = check.stdout.toString();
  const { version } = JSON.parse(printed) as { version: string };
  fs.mkdirSync(outDir, { recursive: true });
  const stamped = path.join(outDir, `jmbots-server-${version}-${serveProcess.timeId()}${EXE}`);
  //M 先写 .tmp 再改名，基地扫 updates/ 时跳过 .tmp，拿不到写了一半的文件。
  fs.copyFileSync(built, `${stamped}.tmp`);
  fs.renameSync(`${stamped}.tmp`, stamped);
  console.log(`版本 ${version}`);
  console.log(printed.trim());
  console.log(`产物：${stamped}`);

  //M 编进 updates/ 只放带版本号的那个，由基地换版；编进测试目录时再复制一个固定名字，直接拿来跑。
  if (path.basename(outDir) === 'updates') return;

  const latest = path.join(outDir, `jmbots-server${EXE}`);
  fs.copyFileSync(stamped, latest);
  console.log(`同时复制为：${latest}`);
}


await main();
