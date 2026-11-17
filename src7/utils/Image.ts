/**
 * 图片给看图模型：从用户的话里找出 @图片路径，把图片读成 pi 的图片块。
 * 渠道把附件写成 @绝对路径（有空白时 @"路径"，见 web-api、feishu），base-tools、bot-front-desk 和 relay 共用这里。
 * 没有状态的纯函数，所以放 utils/。
 */
import * as fs from 'node:fs';
import type * as piAi from '@earendil-works/pi-ai';
import * as mimeModule from './Mime.ts';


/** 一张图最大多少字节；再大就不发给模型（请求太大，供应商会拒）。 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 看图模型认得的图片类型；svg、ico 这类不发。 */
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);


/**
 * 从一段话里找出 @ 后面写的路径：@"带空白的路径" 或 @不带空白的路径。base-tools、bot-front-desk（经 imagePaths）、relay 共用。
 * @param text 用户的话。
 * @returns 路径，按出现先后，去重；不看文件在不在，也不管是不是绝对路径（@人 也会在里面，调用方自己筛）。
 */
export function atPaths(text: string): string[] {
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
export function imagePaths(text: string): string[] {
  return atPaths(text).filter((file) => SENDABLE.has(mimeModule.typeOf(file)));
}


/**
 * 把一个图片文件读成图片块。
 * @param file 绝对路径。
 * @returns 图片块；不是能发的图片、文件不在或太大时是 undefined。
 */
export function imageBlock(file: string): piAi.ImageContent | undefined {
  //G 不是能发的图片类型、文件不在、太大 → 不发。
  const mimeType = mimeModule.typeOf(file);
  if (!SENDABLE.has(mimeType) || !fs.existsSync(file)) return undefined;
  if (fs.statSync(file).size > MAX_BYTES) return undefined;

  //M 读成 base64，装进 pi 的图片块。
  const data = fs.readFileSync(file).toString('base64');
  return { type: 'image', data, mimeType };
}
