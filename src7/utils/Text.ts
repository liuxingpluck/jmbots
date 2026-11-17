/**
 * 小工具：没有状态、和谁都没有强关联的函数。
 * messageOf 把错收成一句话；fieldOf、textOf 读回话地址里的一项；eachEntry 逐个处理一组“名字: 值”；
 * duration、clock 把时长、时刻写成字；clip 截字；numberOf 读网址里的整数参数。
 */


/** clock 写成什么样：time 时:分:秒；ms 时:分:秒.毫秒；date 年-月-日 时:分:秒。 */
export type ClockShape = 'time' | 'ms' | 'date';


/**
 * 把抛出来的错收成一句话。
 * @param error catch 到的值。
 * @returns 出错的原因。
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * 对象里的一项。读渠道的回话地址用：地址的形状归各渠道，插件只读约定好的几项（customer、openId、listenOnly 这类）。
 * @param value 一般是回话地址；不是对象（null、数组、字符串）当空对象。
 * @param key 哪一项。
 * @returns 那一项；没有是 undefined。
 */
export function fieldOf(value: unknown, key: string): unknown {
  const where = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return where[key];
}


/**
 * 对象里的一项文字。
 * @param value 同 fieldOf。
 * @param key 哪一项。
 * @returns 不是字符串是 ''。
 */
export function textOf(value: unknown, key: string): string {
  const field = fieldOf(value, key);
  return typeof field === 'string' ? field : '';
}


/**
 * 逐个处理一组“名字: 值”（Record：配置里的 providers、models，内嵌文件表这类）。
 * 用它代替 `for (const [name, value] of Object.entries(record))`，读的人一眼看出是在逐个处理哪一样。
 * 只用于同步的处理：each 里不能 await，也不能 break；要提前停或要等的，照旧写 for 循环。
 * @param record 要遍历的对象。和 Object.entries 一样，只走它自己的、可枚举的字符串键，按写进去的先后。
 * @param each 每一项调一次。name 是键（比如供应商名），value 是值（比如这家供应商的配置）。
 * 副作用：本身没有；each 做什么由调用方定。
 */
export function eachEntry<T>(
  record: Readonly<Record<string, T>>,
  each: (name: string, value: T) => void,
): void {
  for (const [name, value] of Object.entries(record)) {
    each(name, value);
  }
}


/**
 * 毫秒写成“12.3 秒”“2 分 5 秒”“1 小时 3 分”。进度、复盘、飞书卡片共用。
 * @param ms 毫秒；负的当 0。
 * @returns 一句话。
 */
export function duration(ms: number): string {
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
export function clock(at: number, shape: ClockShape = 'time'): string {
  const date = new Date(at);
  /** 补零到固定位数。 */
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

  //M 时:分:秒，三种都有。
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  //M 按要的样子补上毫秒或日期。
  switch (shape) {
    case 'time': return time;
    case 'ms': return `${time}.${pad(date.getMilliseconds(), 3)}`;
    case 'date': return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  }
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
 * 网址里的整数参数（limit、after 这类）：写错、比下限小按默认，超上限按上限。
 * @param value 网址里的值，可能没给。
 * @param fallback 默认值。
 * @param min 下限。
 * @param max 上限（不限写 Infinity）。
 * @returns 能直接用的整数。
 */
export function numberOf(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = Number(value);

  //G 没给、不是整数、比下限小 → 默认。
  if (value === undefined || value === '' || !Number.isInteger(number) || number < min) return fallback;

  return Math.min(number, max);
}
