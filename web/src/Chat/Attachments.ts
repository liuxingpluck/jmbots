/**
 * 附件的纯函数（docs/界面/01_界面设计.md 第 7 节）：认出文字里的 @绝对路径、分类、写大小。
 * 认法和后端 src/channels/HttpUi.ts 的 parseAttachments 一样（那边改了这边跟着改）：
 * @"路径"（带空格时）或 @路径（到空白或中文标点为止，去掉结尾的英文标点和点）；只认绝对路径，@某人不算。
 */
import type * as types from '../Types.ts';


/** 一段文字：普通文字，或者一个附件。 */
export type Segment = { type: 'text'; text: string } | { type: 'attachment'; path: string; name: string; kind: types.AttachmentKind };


/** 扩展名 → 类别。 */
const KINDS: Record<string, types.AttachmentKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image', avif: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', opus: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', amr: 'audio',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
};

/** 认附件的正则：和后端一样。 */
const ATTACHMENT = /@"([^"]+)"|@([^\s，。、；：！？（）【】《》「」"'<>|]+)/gu;

/** 链接里给附件用的协议名（Markdown 渲染时换成附件卡片）。 */
export const FILE_SCHEME = 'jmfile:';


/**
 * 文件名是哪一类。
 * @param name 文件名或路径。
 */
export function attachmentKind(name: string): types.AttachmentKind {
  /** 扩展名。 */
  const extension = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return KINDS[extension] ?? 'file';
}


/**
 * 路径里的文件名。
 * @param path 绝对路径（Windows 的反斜杠也认）。
 */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}


/**
 * 一个 @ 后面的东西是不是附件，是的话给出路径。
 * @param quoted 引号里的。
 * @param bare 没引号的。
 * @returns 路径；不是附件是 undefined。
 */
function pathOf(quoted: string | undefined, bare: string | undefined): string | undefined {
  /** 路径。 */
  const raw = quoted ?? (bare ?? '').replace(/[.,;!?)\]>`]+$/, '');
  return /^([A-Za-z]:[\\/]|\/)/.test(raw) ? raw : undefined;
}


/**
 * 把文字切成普通文字和附件。
 * @param text 原话或回复。
 * @returns 一段一段；附件那段前后的文字原样保留（去掉 @ 记号和被吃掉的标点除外）。
 */
export function splitAttachments(text: string): Segment[] {
  /** 结果。 */
  const segments: Segment[] = [];
  /** 上一段结束在哪。 */
  let last = 0;
  for (const match of text.matchAll(ATTACHMENT)) {
    /** 路径。 */
    const path = pathOf(match[1], match[2]);
    if (!path) {
      continue;
    }
    /** 这一个从哪开始、到哪（没引号时被去掉的结尾标点还给后面的文字）。 */
    const start = match.index;
    const end = match[1] === undefined ? start + 1 + path.length : start + match[0].length;
    if (start > last) {
      segments.push({ type: 'text', text: text.slice(last, start) });
    }
    segments.push({ type: 'attachment', path, name: baseName(path), kind: attachmentKind(path) });
    last = end;
  }
  if (last < text.length) {
    segments.push({ type: 'text', text: text.slice(last) });
  }
  return segments;
}


/**
 * 把文字里的附件换成 Markdown 链接 [名字](jmfile:路径)，渲染时再换成附件卡片。
 * 附件和有字的文字之间留空行，附件就排在文字下面；连着的几个附件在同一段，图片、播放器靠样式单独占一行。
 * @param text 原话或回复。
 */
export function withAttachmentLinks(text: string): string {
  /** 拆开的几段。 */
  const segments = splitAttachments(text);
  /** 这一段是有字的文字。 */
  const hasWords = (segment: Segment | undefined): boolean => segment?.type === 'text' && segment.text.trim() !== '';
  return segments
    .map((segment, index) => {
      if (segment.type === 'text') {
        return segment.text;
      }
      return `${hasWords(segments[index - 1]) ? '\n\n' : ' '}[${segment.name.replace(/[[\]]/g, '')}](${FILE_SCHEME}${encodeURIComponent(segment.path)})${hasWords(segments[index + 1]) ? '\n\n' : ' '}`;
    })
    .join('');
}


/**
 * jmfile: 链接里的路径。
 * @param href 链接。
 * @returns 路径；不是 jmfile: 链接是 undefined。
 */
export function pathFromLink(href: string | undefined): string | undefined {
  if (!href?.startsWith(FILE_SCHEME)) {
    return undefined;
  }
  try {
    return decodeURIComponent(href.slice(FILE_SCHEME.length));
  } catch {
    return undefined;
  }
}


/**
 * 文件大小写成给人看的样子。
 * @param bytes 字节；不知道是 null。
 */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  /** 单位。 */
  const units = ['KB', 'MB', 'GB'];
  /** 换算后的数。 */
  let value = bytes / 1024;
  /** 用到第几个单位。 */
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}


/**
 * 把工作区标签拼到正文后面（G批设计 7.4）：带空格/制表符的路径写成 @"…"，其余写 @路径，
 * 多个按插入顺序用空格连接；和本文件 ATTACHMENT 正则的认法是一对。
 * @param text 用户输入的 Markdown 正文（可以是空串）。
 * @param paths 标签的绝对路径，按插入顺序（Windows 的反斜杠原样，不转义）。
 * @returns 接好 @路径 的正文；没有路径时原样返回；正文为空就只有 @路径 串。
 */
export function withWorkspaceTags(text: string, paths: string[]): string {
  //G 没有标签就不动正文。
  if (paths.length === 0) {
    return text;
  }
  /** 每个标签的写法：含空格/制表符的包上引号。 */
  const tags = paths.map((path) => (/[ \t]/.test(path) ? `@"${path}"` : `@${path}`));
  /** 拼好的尾巴。 */
  const suffix = tags.join(' ');
  return text === '' ? suffix : `${text} ${suffix}`;
}
