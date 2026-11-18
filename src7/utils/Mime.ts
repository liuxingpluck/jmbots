/**
 * 文件类型：按扩展名认出一个文件是哪一类附件、回给浏览器时用什么 Content-Type。
 * 插件 web（托管网页）和 files-api（上传、看文件）共用这一张表，表照 0.4 的 src/channels/HttpUi.ts 抄来。
 * 没有状态的纯函数，所以放骨架的 utils/（用户 11-14 同意公用小函数放这里）。
 */
import * as path from 'node:path';


/** 附件类别：网页按它决定显示成图片、播放器还是一个文件。 */
export type FileKind = 'image' | 'audio' | 'video' | 'file';


/** 扩展名（小写、带点）→ [附件类别, Content-Type]。 */
const TYPES: Record<string, [FileKind, string]> = {
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.bmp': ['image', 'image/bmp'],
  '.svg': ['image', 'image/svg+xml'],
  '.ico': ['image', 'image/x-icon'],
  '.avif': ['image', 'image/avif'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.wav': ['audio', 'audio/wav'],
  '.ogg': ['audio', 'audio/ogg'],
  '.opus': ['audio', 'audio/ogg'],
  '.m4a': ['audio', 'audio/mp4'],
  '.aac': ['audio', 'audio/aac'],
  '.flac': ['audio', 'audio/flac'],
  '.amr': ['audio', 'audio/amr'],
  '.mp4': ['video', 'video/mp4'],
  '.m4v': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
  '.mov': ['video', 'video/quicktime'],
  '.mkv': ['video', 'video/x-matroska'],
  '.avi': ['video', 'video/x-msvideo'],
  '.pdf': ['file', 'application/pdf'],
  '.md': ['file', 'text/markdown; charset=utf-8'],
  '.txt': ['file', 'text/plain; charset=utf-8'],
  '.log': ['file', 'text/plain; charset=utf-8'],
  '.json': ['file', 'application/json; charset=utf-8'],
  '.yaml': ['file', 'text/yaml; charset=utf-8'],
  '.yml': ['file', 'text/yaml; charset=utf-8'],
  '.csv': ['file', 'text/csv; charset=utf-8'],
  '.html': ['file', 'text/html; charset=utf-8'],
  '.css': ['file', 'text/css; charset=utf-8'],
  '.js': ['file', 'text/javascript; charset=utf-8'],
  '.mjs': ['file', 'text/javascript; charset=utf-8'],
  '.map': ['file', 'application/json; charset=utf-8'],
  '.woff2': ['file', 'font/woff2'],
  '.woff': ['file', 'font/woff'],
  '.ttf': ['file', 'font/ttf'],
};

/** 当纯文字给的代码文件：网页预览时等宽显示，不让浏览器下载或执行。 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.toml', '.xml', '.ini', '.sh',
  '.ps1', '.bat', '.cmd', '.sql', '.java', '.c', '.h', '.cpp', '.cs',
]);


/**
 * 文件是哪一类附件。
 * @param name 文件名或路径。
 * @returns image、audio、video；认不出的都是 file。
 */
export function getKind(name: string): FileKind {
  const extension = path.extname(name).toLowerCase();
  return TYPES[extension]?.[0] ?? 'file';
}


/**
 * 回这个文件时用的 Content-Type。
 * @param name 文件名或路径。
 * @returns 表里有的照表；代码文件当纯文字；别的当二进制 application/octet-stream。
 */
export function getType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return 'text/plain; charset=utf-8';

  return TYPES[extension]?.[1] ?? 'application/octet-stream';
}
