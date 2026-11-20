/**
 * 将外置微信纯 Bun 插件打包编译为单个独立可执行文件（Windows 为 `jmbots-wechat.exe`）。
 * 自动内联客服工作台单页 HTML 并将 `silk-wasm` 的 `.wasm` 资产嵌进同一可执行文件，运行时零外部源码或模块依赖。
 *
 * 用法：bun external/wechat/Build.ts [--out <输出目录，默认 external/wechat/dist>]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import * as mainModule from './Main.ts';
import * as web from './Web.ts';


/** 当前平台编译后可执行文件扩展名。 */
function getExeSuffix(): string {
  if (process.platform === 'win32') return '.exe';

  return '';
}


/**
 * 将磁盘绝对路径转换为可安全写入生成 TS 源码的正斜杠字符串字面量。
 * @param filePath 目标绝对路径。
 */
function toImportLiteral(filePath: string): string {
  return JSON.stringify(filePath.replaceAll('\\', '/'));
}


/**
 * 构建 `silk-wasm` 的内嵌 WASM 虚拟源码，使 `bun build --compile` 将 `silk.wasm` 打包进二进制内部。
 * @param silkMjsPath `node_modules/silk-wasm/lib/index.mjs` 绝对路径。
 */
function buildEmbeddedSilkModule(silkMjsPath: string): string {
  const original = fs.readFileSync(silkMjsPath, 'utf8');
  const marker = 'silk_default=Module;';
  if (original.split(marker).length !== 2) {
    throw new Error('silk-wasm 入口结构不符合预期，请核对 WASM 内嵌注入标记');
  }

  const assetImport = 'import silkAsset from "./silk.wasm" with { type: "file" };';
  const locator = 'silk_default=()=>Module({locateFile:()=>silkAsset});';
  const adapted = original.replace(marker, locator);
  return `${assetImport}\n${adapted}`;
}


/**
 * 执行前端单页构建、单文件二进制编译与 `--version` 启动自检。
 */
async function buildStandaloneBinary(): Promise<void> {
  const startedAt = Date.now();
  const { values } = util.parseArgs({
    options: {
      out: { type: 'string' },
    },
  });

  const defaultOut = path.join(import.meta.dir, 'dist');
  const outDir = path.resolve(values.out ?? defaultOut);
  const exeName = `jmbots-wechat${getExeSuffix()}`;
  const finalExePath = path.join(outDir, exeName);

  //M 第一步：把 React 客服工作台编译为自包含内联 HTML。
  const html = await web.buildPage();

  //M 第二步：在系统临时目录生成一次性编译入口，注入内嵌客服页 HTML 后调用 runCli。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-wechat-compile-'));
  try {
    const embeddedFile = path.join(import.meta.dir, 'EmbeddedPage.ts');
    const mainFile = path.join(import.meta.dir, 'Main.ts');
    const entryFile = path.join(workDir, 'CompileEntry.ts');
    const entryCode = [
      `import * as embedded from ${toImportLiteral(embeddedFile)};`,
      `import * as mainModule from ${toImportLiteral(mainFile)};`,
      `embedded.setEmbeddedKefuHtml(${JSON.stringify(html)});`,
      'await mainModule.runCli(process.argv.slice(2));',
      '',
    ].join('\n');
    fs.writeFileSync(entryFile, entryCode, 'utf8');

    const repoRoot = path.resolve(import.meta.dir, '..', '..');
    const silkLibrary = path.join(repoRoot, 'node_modules', 'silk-wasm', 'lib', 'index.mjs');
    //M 构造内嵌 `silk.wasm` 的适配模块源码。
    const silkContents = buildEmbeddedSilkModule(silkLibrary);

    const tempOutExe = path.join(workDir, exeName);
    //M 第三步：调用 Bun.build compile 生成真正的单文件可执行程序。
    const buildRes = await Bun.build({
      entrypoints: [entryFile],
      target: 'bun',
      compile: { outfile: tempOutExe },
      files: { [silkLibrary]: silkContents },
    });
    if (!buildRes.success) {
      throw new AggregateError(buildRes.logs, 'jmbots-wechat 单文件二进制编译失败');
    }

    //M 第四步：当场运行 `--version` 核验编译产物可独立启动且协议身份正确。
    const smoke = Bun.spawnSync([tempOutExe, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    if (smoke.exitCode !== 0) {
      const errText = smoke.stderr.toString('utf8').slice(-1000);
      throw new Error(`单文件产物自检失败（退出码 ${String(smoke.exitCode)}）：${errText}`);
    }
    const versionJson = JSON.parse(smoke.stdout.toString('utf8')) as { name?: string; version?: string };
    if (versionJson.name !== 'wechat' || versionJson.version !== mainModule.PLUGIN_VERSION) {
      throw new Error('单文件产物自检返回的版本身份不匹配');
    }

    fs.mkdirSync(outDir, { recursive: true });
    const stagedTmp = `${finalExePath}.tmp`;
    fs.copyFileSync(tempOutExe, stagedTmp);
    fs.renameSync(stagedTmp, finalExePath);

    const sizeBytes = fs.statSync(finalExePath).size;
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(JSON.stringify({
      ok: true,
      output: finalExePath,
      version: mainModule.PLUGIN_VERSION,
      sizeBytes,
      sizeMb: Number(sizeMb),
      elapsedSec: Number(elapsedSec),
    }));
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows 杀软短时占用临时编译目录时交由系统 Temp 回收，不影响已落盘的目标可执行文件。
    }
  }
}


await buildStandaloneBinary();
