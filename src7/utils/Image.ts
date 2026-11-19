/**
 * 图片给看图模型：从用户的话里找出 @图片路径，认出图片路径（读成图片块的 getImageBlock 在 file-tools/BaseTools.ts）。
 * 渠道把附件写成 @绝对路径（有空白时 @"路径"，见 web-api、feishu），file-tools、bots（前台）和 relay 共用这里。
 * 没有状态的纯函数，所以放 utils/。
 */
import * as mimeModule from './Mime.ts';


/** 看图模型认得的图片类型；svg、ico 这类不发。 */
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);


/**
 * 从一段话里找出 @ 后面写的路径：@"带空白的路径" 或 @不带空白的路径。base-tools、bots 的前台（经 getImagePaths）、relay 共用。
 * @param text 用户的话。
 * @returns 路径，按出现先后，去重；不看文件在不在，也不管是不是绝对路径（@人 也会在里面，调用方自己筛）。
 */
export function getAtPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/@"([^"]+)"|@([^\s"]+)/gu)) {
    const file = match[1] ?? match[2] ?? '';
    if (!found.includes(file)) found.push(file);
  }
  return found;
}


/**
 * 从一段话里找出 @ 后面写的、扩展名是图片的路径。
 * @param text 用户的话。
 * @returns 路径，按出现先后，去重；不看文件在不在。
 */
export function getImagePaths(text: string): string[] {
  //M 先摘出消息里所有 @路径，再按扩展名对应的 MIME 过滤出看图模型支持发送的图片类型。
  return getAtPaths(text).filter((file) => SENDABLE.has(mimeModule.getMimeType(file)));
}
