/**
 * 截断：工具输出、事件数据太长时只留一段。exec、file-tools、web-search、journal 共用（照 0.4 的 src/capabilities/tools/Truncate.ts）。
 * 都是纯函数，没有状态。
 */


/** 工具输出最多几行。 */
export const MAX_LINES = 2000;

/** 工具输出最多多少字节（50KB）。 */
export const MAX_BYTES = 50 * 1024;


/** 截完的结果。 */
export interface Cut {
  /** 留下的文字。 */
  text: string;
  /** 留了几行。 */
  kept: number;
  /** 原来一共几行。 */
  total: number;
  /** 有没有截。 */
  cut: boolean;
}


/**
 * 从前往后收整行，到 MAX_LINES 行或 MAX_BYTES 字节就停（find 的结果用它：前面的最要紧）。
 * @param text 原文。
 * @returns 留下的开头一段。
 */
export function head(text: string): Cut {
  return take(text.split('\n'), false);
}


/**
 * 从后往前收整行，到 MAX_LINES 行或 MAX_BYTES 字节就停（命令输出用它：结尾的报错最要紧）。
 * @param text 原文。
 * @returns 留下的结尾一段。
 */
export function tail(text: string): Cut {
  return take(text.split('\n'), true);
}


/**
 * head、tail 共用：照方向一行行收。
 * @param lines 原文切好的行。
 * @param fromEnd true 从结尾往前收。
 */
function take(lines: string[], fromEnd: boolean): Cut {
  const order = fromEnd ? [...lines].reverse() : lines;
  const kept: string[] = [];
  let bytes = 0;
  for (const line of order) {
    //M 一行的字节数按 UTF-8 算，加 1 是换行符。
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (kept.length >= MAX_LINES || bytes + size > MAX_BYTES) break;
    kept.push(line);
    bytes += size;
  }
  const text = (fromEnd ? kept.reverse() : kept).join('\n');
  return { text, kept: kept.length, total: lines.length, cut: kept.length < lines.length };
}


/**
 * 一段字太长就截到 max 个字，末尾写明一共多少字。
 * @param text 原文。
 * @param max 最多几个字。
 * @returns 没超就是原文。
 */
export function chars(text: string, max: number): string {
  if (text.length <= max) return text;

  return `${text.slice(0, max)}……（共 ${String(text.length)} 字，后面省略）`;
}
