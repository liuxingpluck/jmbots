/**
 * 起名用的两个小函数：安全文件名、20 位时刻号。image-gen、note-claude、runs 共用（照 0.4 src/utils/Utils.ts:22-30、111-121）。
 */


/**
 * 安全的文件名（照 0.4 safeFolderName）：去掉控制字符和 \/:*?"<>|，去头尾空白，空白换 _，最多 40 字，去掉末尾的 . 和 _。
 * @param text 原来的名字（标题、提示词……）。
 * @returns 能当文件名的一段；空了是“未命名”。
 */
export function safeName(text: string): string {
  //M 去掉控制字符和文件名不许有的字，去头尾空白，中间的空白换成 _。
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/gu, '')
    .trim()
    .replace(/\s+/gu, '_');

  //M 按字（不是按 UTF-16 单元）截到 40 个，再去掉末尾的 . 和 _。
  const first40 = [...cleaned].slice(0, 40).join('');
  const cut = first40.replace(/[._]+$/u, '');
  return cut === '' ? '未命名' : cut;
}

/**
 * 20 位时刻号（照 0.4 src/utils/Utils.ts 的 createSessionId）：本地时间 yyyyMMddHHmmssSSS（17 位）加 3 位随机数字，共 20 位纯数字。
 * 用 getFullYear / getHours 等本地时区，不用 UTC；按字面排就是按时间排。会话号也走这里。
 * @param date 用哪个时间，默认现在。
 * @returns 比如 20261114051503123456。
 */
export function stampId(date = new Date()): string {
  /** 补零到固定位数。 */
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

  //M 年月日、时分秒、毫秒，都按本地时间，一段段补零。
  const day = `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const ms = pad(date.getMilliseconds(), 3);

  //M 末尾 3 位随机数字，同一毫秒开两个也不容易撞上。
  const random = pad(Math.floor(Math.random() * 1000), 3);
  return `${day}${time}${ms}${random}`;
}
