/**
 * 把外置微信客服页（`Kefu.html` + `KefuPage.tsx` + `Kefu.css`）打包成自包含单页 HTML 字符串。
 * 全程引用 `external/wechat/` 内部模块，零跨目录依赖，不在工作区落构建垃圾。
 */
import * as path from 'node:path';


/**
 * 构建并返回内联了全部脚本与样式的客服页单页 HTML。
 */
export async function buildPage(): Promise<string> {
  const entry = path.join(import.meta.dir, 'Kefu.html');
  const options: Bun.BuildConfig = {
    entrypoints: [entry],
    target: 'browser',
    compile: true,
  };

  //M 由 Bun HTML bundler 将脚本与样式内联进同一份 HTML。
  const result = await Bun.build(options);
  const built = result.outputs[0];
  if (!result.success || built === undefined) {
    throw new AggregateError(result.logs, '独立微信客服页构建失败');
  }

  //M 外置 HTTP 服务直接从内存返回这份 HTML 文本。
  return await built.text();
}
