/**
 * 右栏预览按什么样子显示（docs/界面/01_界面设计.md 第 9 节），纯函数好测。
 */


/** 预览的几种样子。 */
export type PreviewKind = 'image' | 'markdown' | 'text' | 'pdf' | 'audio' | 'video' | 'other';


/** 每个文字片段最多读多少字节；后续继续按 Range 读取，不累积正文。 */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** 会话 md 多久刷新一次，毫秒（运行中的会话一直在写）。 */
export const LIVE_REFRESH_MS = 2000;


/** 扩展名 → 样子。 */
const KINDS: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image', avif: 'image',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', log: 'text', json: 'text', yaml: 'text', yml: 'text', csv: 'text', toml: 'text', ini: 'text', xml: 'text', html: 'text', css: 'text',
  js: 'text', mjs: 'text', ts: 'text', tsx: 'text', jsx: 'text', py: 'text', rs: 'text', go: 'text', sh: 'text', ps1: 'text', bat: 'text', cmd: 'text', sql: 'text', java: 'text', c: 'text', h: 'text', cpp: 'text', cs: 'text',
  pdf: 'pdf',
  mp3: 'audio', wav: 'audio', ogg: 'audio', opus: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', amr: 'audio',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
};


/**
 * 根据文件名或路径的扩展名判断一个文件按什么样子预览。
 * @param name 文件名或路径。
 * @returns 对应的预览分类；未收录的扩展名返回 `'other'`。
 * 副作用：无。
 */
export function getPreviewKind(name: string): PreviewKind {
  /** 扩展名。 */
  const extension = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return KINDS[extension] ?? 'other';
}


/**
 * 判断文件是否需要持续轮询刷新：工作区目录里的会话 `.md` 在运行期间会一直写入。
 * @param path 文件绝对路径。
 * @returns 位于工作区且为 `.md` 文件时返回 `true`，否则返回 `false`。
 * 副作用：无。
 */
export function isLive(path: string): boolean {
  return /[\\/]workspace[\\/]/.test(path) && /\.md$/i.test(path);
}


/**
 * 文档链接转换成现有预览目标；相对路径以当前文件所在目录解析。
 * @param currentPath 当前文件绝对路径。
 * @param href Markdown 链接或附件给出的路径。
 * @returns 文件路径；网络、邮件和纯锚点返回 null，访问范围仍由后端检查。
 * 副作用：无。
 */
export function getDocumentLink(currentPath: string, href: string): string | null {
  if (!href || href.startsWith('#')) {
    return null;
  }
  const normalized = href.replaceAll('\\', '/');
  const windowsPath = /^[A-Za-z]:\//.test(normalized);
  if (!windowsPath && /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized)
    && !normalized.startsWith('file:')) {
    return null;
  }
  try {
    const base = currentPath.replaceAll('\\', '/');
    let baseUrl = `file:///${base.replace(/^\//, '')}`;
    if (base.startsWith('//')) {
      baseUrl = `file:${base}`;
    }
    let rawTarget = normalized;
    if (windowsPath) {
      rawTarget = `file:///${normalized}`;
    }
    const target = new URL(rawTarget, baseUrl);
    if (target.protocol !== 'file:') {
      return null;
    }
    let path = decodeURIComponent(target.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    }
    if (target.host) return `//${target.host}${path}`;

    return path;
  } catch {
    return null;
  }
}
