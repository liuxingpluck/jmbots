/** 文字处理工具：错误转述、字串裁剪、日期和单位格式化、整数参数解析。 */


/** getClock 写成什么样：time 时:分:秒；ms 时:分:秒.毫秒；date 年-月-日 时:分:秒。 */
export type ClockShape = 'time' | 'ms' | 'date';


/**
 * 把抛出来的错收成一句话。
 * @param error catch 到的值。
 * @returns 出错的原因。
 */
export function getMessage(error: unknown): string {
  //M 是 Error 取它的 message，别的值（字符串、对象）转成字。
  if (error instanceof Error) return error.message;

  return String(error);
}


/**
 * 毫秒写成“12.3 秒”“2 分 5 秒”“1 小时 3 分”。进度、复盘、飞书卡片共用。
 * @param ms 毫秒；负的当 0。
 * @returns 一句话。
 */
export function getDuration(ms: number): string {
  //M 不到一分钟：秒带一位小数。
  const positive = Math.max(0, ms);
  if (positive < 60_000) return `${(positive / 1000).toFixed(1)} 秒`;

  //M 一小时以内：分、秒。
  const seconds = Math.round(positive / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} 分 ${String(seconds % 60)} 秒`;

  //M 再长：小时、分。
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`;
}


/**
 * 时刻写成本地时间的字。对话.md、打印插件共用。
 * @param at 毫秒时间戳。
 * @param shape 写成什么样，默认时:分:秒。
 * @returns 比如 13:05:02、13:05:02.123、2026-11-17 13:05:02。
 */
export function getClock(at: number, shape: ClockShape = 'time'): string {
  const date = new Date(at);
  /** 补零到固定位数。 */
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

  //M 时:分:秒，三种都有。
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  //M time：只要时:分:秒。
  if (shape === 'time') return time;

  //M ms：后面补毫秒。
  if (shape === 'ms') return `${time}.${pad(date.getMilliseconds(), 3)}`;

  //M date：前面补年-月-日（剩下的就是这一种）。
  const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${time}`;
}


/**
 * 截到 max 个字（按字，不按 UTF-16 单元），截了加“…”。
 * @param text 一段字。
 * @param max 最多几个字。
 * @returns 不超就是原文。
 */
export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;

  return `${chars.slice(0, max).join('')}…`;
}


/**
 * 字节数写成 12 B、3.4 KB、1.2 MB（照 0.4 formatSize）。生图、写记忆交回给模型的话里用。
 * @param bytes 字节数。
 * @returns 一段字。
 */
export function getSizeText(bytes: number): string {
  //M 不到 1 KB：原样写字节数。
  if (bytes < 1024) return `${String(bytes)} B`;

  //M 不到 1 MB：KB 带一位小数。
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;

  //M 再大：MB 带一位小数。
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}


/**
 * 网址里的整数参数（limit、after 这类）：写错、比下限小按默认，超上限按上限。
 * @param value 网址里的值，可能没给。
 * @param fallback 默认值。
 * @param min 下限。
 * @param max 上限（不限写 Infinity）。
 * @returns 能直接用的整数。
 */
export function getNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = Number(value);

  //G 没给、不是整数、比下限小 → 默认。
  if (value === undefined || value === '' || !Number.isInteger(number) || number < min) return fallback;

  return Math.min(number, max);
}
