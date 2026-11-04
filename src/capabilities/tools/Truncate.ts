/**
 * 截断工具输出：行数、字节数哪个先到就在哪截，交给模型的内容不会太长。
 *   truncateHead  留开头（read 用：从前往后读，告诉模型从哪行接着读）
 *   truncateTail  留结尾（exec 用：报错和最终结果通常在最后）
 *
 * 来源：Pi（F:\aidata\source\Pi\packages\coding-agent\src\core\tools\truncate.ts，2026-10-22 的 8c03fef），
 * 只留了这两个函数和 formatSize，返回值去掉了用不上的字段。
 */


/** 默认最多多少行。 */
export const DEFAULT_MAX_LINES = 2000;


/** 默认最多多少字节（50KB）。 */
export const DEFAULT_MAX_BYTES = 50 * 1024;


/** 截断的结果。 */
export interface Truncated {
  /** 截完的内容。 */
  content: string;

  /** 截掉了东西没有。 */
  truncated: boolean;

  /** 按什么截的：lines 行数到了、bytes 字节数到了；没截时是 undefined。 */
  truncatedBy?: 'lines' | 'bytes';

  /** 原来一共几行。 */
  totalLines: number;

  /** 留下了几行。 */
  outputLines: number;

  /** truncateHead：第一行就超过字节上限，一行都留不下。 */
  firstLineTooLong: boolean;

  /** truncateTail：最后一行太长，只留了它的后半截。 */
  lastLinePartial: boolean;
}


/** 截断的上限；不写用默认值。 */
export interface TruncateLimits {
  /** 最多几行。 */
  maxLines?: number;

  /** 最多几字节。 */
  maxBytes?: number;
}


/**
 * 字节数写成好读的样子，如 512B、3.2KB、1.5MB。
 * @param bytes 字节数。
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}


/**
 * 分行计数：以换行结尾的文本，最后那个空“行”不算。
 * @param content 文本。
 */
function splitLines(content: string): string[] {
  /** 按换行切开。 */
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}


/**
 * 没超限时的结果。
 * @param content 原文。
 * @param totalLines 行数。
 */
function untouched(content: string, totalLines: number): Truncated {
  return { content, truncated: false, totalLines, outputLines: totalLines, firstLineTooLong: false, lastLinePartial: false };
}


/**
 * 留开头：从第一行往后收整行，收到行数或字节数上限为止（不会留半行）。
 * @param content 文本。
 * @param limits 上限。
 */
export function truncateHead(content: string, limits: TruncateLimits = {}): Truncated {
  /** 行数上限。 */
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  /** 字节上限。 */
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  /** 全部行。 */
  const lines = splitLines(content);
  //G 没超限，原样返回。
  if (lines.length <= maxLines && Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return untouched(content, lines.length);
  }
  //G 第一行就超字节上限：一行都不留，由调用方另外提示。
  if (Buffer.byteLength(lines[0] ?? '', 'utf8') > maxBytes) {
    return { content: '', truncated: true, truncatedBy: 'bytes', totalLines: lines.length, outputLines: 0, firstLineTooLong: true, lastLinePartial: false };
  }

  //M 一行一行收，加上换行符的 1 字节。
  /** 留下的行。 */
  const kept: string[] = [];
  /** 留下的字节数。 */
  let bytes = 0;
  /** 按什么截的。 */
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (const [index, line] of lines.entries()) {
    if (index >= maxLines) {
      break;
    }
    /** 这一行占的字节。 */
    const lineBytes = Buffer.byteLength(line, 'utf8') + (index > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }
  return { content: kept.join('\n'), truncated: true, truncatedBy, totalLines: lines.length, outputLines: kept.length, firstLineTooLong: false, lastLinePartial: false };
}


/**
 * 留结尾：从最后一行往前收整行；最后一行本身就超字节上限时，只留它的后半截。
 * @param content 文本。
 * @param limits 上限。
 */
export function truncateTail(content: string, limits: TruncateLimits = {}): Truncated {
  /** 行数上限。 */
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  /** 字节上限。 */
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  /** 全部行。 */
  const lines = splitLines(content);
  //G 没超限，原样返回。
  if (lines.length <= maxLines && Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return untouched(content, lines.length);
  }

  //M 从后往前收。
  /** 留下的行。 */
  const kept: string[] = [];
  /** 留下的字节数。 */
  let bytes = 0;
  /** 按什么截的。 */
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  /** 最后一行只留了后半截。 */
  let lastLinePartial = false;
  for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index--) {
    /** 这一行。 */
    const line = lines[index] ?? '';
    /** 这一行占的字节。 */
    const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      //G 一行都还没收就超了：留这一行的结尾。
      if (kept.length === 0) {
        kept.unshift(tailBytes(line, maxBytes));
        lastLinePartial = true;
      }
      break;
    }
    kept.unshift(line);
    bytes += lineBytes;
  }
  return { content: kept.join('\n'), truncated: true, truncatedBy, totalLines: lines.length, outputLines: kept.length, firstLineTooLong: false, lastLinePartial };
}


/**
 * 取一个字符串的最后 maxBytes 字节，不切坏多字节字符（跳过 UTF-8 的后续字节）。
 * @param text 字符串。
 * @param maxBytes 最多几字节。
 */
function tailBytes(text: string, maxBytes: number): string {
  /** 字节。 */
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }
  /** 从哪个字节开始留。 */
  let start = buffer.length - maxBytes;
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) {
    start++;
  }
  return buffer.subarray(start).toString('utf8');
}
