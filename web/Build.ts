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
  //M 第二个入口 graph.html：记忆关系图谱页（memory-graph 插件在 /graph/ 托管）。
  //M 第三个入口 memory.html（2026-11-14 jm开发）：记忆检索页，web 插件把 dist/web/<名字>.html 挂在 /<名字>/，即 /memory/。
  //M 第四个入口 wechat-kefu.html（2026-11-14 jm开发）：积木客服页 /wechat-kefu/（React，替换 wechat 插件里的字符串页面 Page.ts）。
  //M 第五个入口 flow.html（2026-11-16）：插件预览图 /flow/，flow 插件托管。
  entrypoints: [path.join(root, 'web', 'index.html'), path.join(root, 'web', 'graph.html'), path.join(root, 'web', 'memory.html'), path.join(root, 'web', 'wechat-kefu.html'), path.join(root, 'web', 'flow.html')],
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
