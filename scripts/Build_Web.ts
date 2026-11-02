/**
 * 网页打包：以 web/index.html 为入口，用 Bun 把 TSX 和 CSS 打包进 dist/web。
 * 由 `bun run build:web` 调用。会先删掉整个 dist/web，免得旧的打包文件混在里面。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 仓库根目录；按本文件的位置推出，从哪个目录运行都一样。 */
const projectRoot = path.resolve(import.meta.dirname, '..');
/** 打包输出目录；服务端 src/server/Main.ts 从这里托管网页。 */
const outDir = path.join(projectRoot, 'dist', 'web');

// m: 清空旧产物，再从 HTML 入口打包；HTML 里引用的脚本和样式会被换成带哈希的文件名。
fs.rmSync(outDir, { recursive: true, force: true });
/** Bun 的打包结果；success 为 false 时，logs 里是出错的原因。 */
const result = await Bun.build({
  entrypoints: [path.join(projectRoot, 'web', 'index.html')],
  outdir: outDir,
  target: 'browser',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

// g: 打包失败时打印原因，以退出码 1 结束，让调用方知道失败了。
if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// r: 列出产物和大小，方便核对。
for (const output of result.outputs) {
  console.log(`${path.relative(projectRoot, output.path)}  ${(output.size / 1024).toFixed(1)} KiB`);
}
