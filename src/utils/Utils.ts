/**
 * 不存状态的小工具：会话 ID、本地时间、截断长文本、错误转文字。不读配置，也不依赖别的 jmbots 文件。
 */


/**
 * 补零到指定位数，如 pad(7) 得到 07。
 * @param value 数字。
 * @param width 位数，默认 2。
 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}


/**
 * 生成会话 ID：本地时间的年月日时分秒毫秒（17 位）加 3 位随机数字，共 20 位纯数字，如 20261102143005123456。
 * 按字符串排序就是按时间排序；会话目录也用它当文件夹名。用户 11-02 定的格式。
 * 同一毫秒撞上的概率很小，真撞上了由数据库主键拦下，调用方换一个再试。
 * @param date 用哪个时间，默认现在。
 */
export function createSessionId(date = new Date()): string {
  /** 3 位随机数字。 */
  const random = pad(Math.floor(Math.random() * 1000), 3);
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}` +
    random
  );
}


/**
 * 本地时间写成 2026-11-02 14:30:05，日志里给人看。
 * @param time 毫秒时间戳或 Date，默认现在。
 */
export function formatTime(time: number | Date = new Date()): string {
  /** 换成 Date。 */
  const date = typeof time === 'number' ? new Date(time) : time;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}


/**
 * 长文本截短：超过 maxChars 就只留开头，末尾注明一共多少字。
 * @param text 原文。
 * @param maxChars 最多留几个字符。
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n……（共 ${text.length} 字，后面省略）`;
}


/**
 * 错误转成一句话。
 * @param error catch 到的任何东西。
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * 把值里出现的密钥换成 ***（工具结果进数据库、进模型之前用）。按 JSON 文本替换，对象、数组里的字符串都能换到。
 * @param value 工具结果等。
 * @param secrets 要藏的密钥原文（太短的不算，免得误伤）。
 * @returns 换过的值；没有密钥出现时原样返回。
 */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  if (value === undefined || value === null || secrets.length === 0) {
    return value;
  }
  /** JSON 文本。 */
  let text = JSON.stringify(value);
  /** 换前。 */
  const before = text;
  for (const secret of secrets) {
    /** 密钥在 JSON 里的写法（引号、反斜杠会被转义）。 */
    const escaped = JSON.stringify(secret).slice(1, -1);
    text = text.split(escaped).join('***');
  }
  return text === before ? value : (JSON.parse(text) as T);
}


/**
 * 任意值转成给模型看的文字：字符串原样，别的转成缩进的 JSON。
 * @param value 工具结果等。
 */
export function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value ?? null, null, 2);
}


/**
 * 文字改成能当文件夹名的样子：去掉 Windows 不许用的字符（\ / : * ? " < > | 和控制字符），空白换成下划线，
 * 截到 maxChars 个字，去掉结尾的点和下划线。全去光了就是“未命名”。
 * 用户 11-02：会话文件夹是“会话ID_AI 起的标题”，“通过工具自动过滤掉一些特殊字符即可”。
 * @param text 标题等。
 * @param maxChars 最多几个字，默认 40。
 */
export function safeFolderName(text: string, maxChars = 40): string {
  /** 清理后的名字。 */
  const cleaned = [...text]
    .filter((char) => char.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(char))
    .join('')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, maxChars)
    .replace(/[._]+$/, '');
  return cleaned || '未命名';
}
