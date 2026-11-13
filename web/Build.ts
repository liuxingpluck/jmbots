/**
 * 网页打包：以 web/index.html 为入口，用 Bun 把 TSX 和 CSS 打包进代码目录的 dist/web（src/channels/HttpUi.ts 托管它）。
 * 由 `bun run build:web` 调用。先清空 dist/web，免得旧文件混在里面；脚本和样式放进 dist/web/assets/，文件名带哈希，可以长期缓存。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 代码目录（本文件在 web/ 下）。 */
const root = path.resolve(import.meta.dir, '..');
/** 打包输出目录：发布时（scripts/Build_Release.ts）放别处，不动正在被托管的 dist/web。 */
const outDir = process.env.JMBOTS_WEB_OUT ?? path.join(root, 'dist', 'web');

//M 清空旧产物，再从 HTML 入口打包。
fs.rmSync(outDir, { recursive: true, force: true });
/** 打包结果；success 为 false 时 logs 里是原因。 */
const result = await Bun.build({
  entrypoints: [path.join(root, 'web', 'index.html')],
  outdir: outDir,
  target: 'browser',
  minify: true,
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

//M 列出产物和大小，方便核对。
for (const output of result.outputs) {
  console.log(`${path.relative(root, output.path)}  ${(output.size / 1024).toFixed(1)} KiB`);
}
