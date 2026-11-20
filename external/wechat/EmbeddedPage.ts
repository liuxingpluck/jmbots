/**
 * 单文件编译版内嵌客服页 HTML 的注册槽位。
 * 源码模式下为空（按需现场编译前端或读取 `--page`）；`Build.ts` 单文件编译时在构建期注入内联 HTML。
 */


let embeddedHtml: string | undefined;


/**
 * 注册单文件二进制内嵌的客服页单页 HTML。
 * @param html 已内联脚本与样式的完整 HTML 文本。
 */
export function setEmbeddedKefuHtml(html: string): void {
  embeddedHtml = html;
}


/**
 * 读取已内嵌的客服页单页 HTML；未注入（源码直接运行）时返回 undefined。
 */
export function getEmbeddedKefuHtml(): string | undefined {
  return embeddedHtml;
}
