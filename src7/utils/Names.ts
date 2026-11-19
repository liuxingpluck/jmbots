/**
 * 安全文件名和 20 位时刻号。会话、执行记录、渠道附件与图片生成共用（照 0.4 src/utils/Utils.ts:22-30、111-121）。
 */


/**
 * 安全的文件名（照 0.4 safeFolderName）：去掉控制字符和 \/:*?"<>|，去头尾空白，空白换 _，最多 max 字，去掉末尾的 . 和 _。
 * 生图起名用默认的 40 字；渠道收到的附件（bots 的 saveFile）不限字数，免得把扩展名截掉。
 * @param text 原来的名字（标题、提示词、附件名……）。
 * @param max 最多几个字，默认 40；不限写 Infinity。
 * @returns 能当文件名的一段；空了是“未命名”。
 */
export function getSafeName(text: string, max = 40): string {
  //M 去掉控制字符和文件名不许有的字，去头尾空白，中间的空白换成 _。
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/gu, '')
    .trim()
    .replace(/\s+/gu, '_');

  //M 按字（不是按 UTF-16 单元）截到 max 个，再去掉末尾的 . 和 _（Windows 会把文件名末尾的 . 吞掉）。
  const kept = [...cleaned].slice(0, max).join('');
  const cut = kept.replace(/[._]+$/u, '');

  //G 全被去掉了 → 叫“未命名”。
  if (cut === '') return '未命名';

  return cut;
}

/**
 * 20 位时刻号（照 0.4 src/utils/Utils.ts 的 createSessionId）：本地时间 yyyyMMddHHmmssSSS（17 位）加 3 位随机数字，共 20 位纯数字。
 * 用 getFullYear / getHours 等本地时区，不用 UTC；按字面排就是按时间排。会话号也走这里。
 * @param date 用哪个时间，默认现在。
 * @returns 比如 20261114051503123456。
 */
export function createTimestampId(date = new Date()): string {
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
