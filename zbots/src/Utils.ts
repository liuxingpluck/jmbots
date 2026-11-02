/**
 * zbots 的底层小工具：时间 ID、本地时间、读写 YAML、截断长文本、读命令行参数。
 * 都是不存状态的小函数，只碰调用方给的文件；不读配置，也不依赖别的 zbots 文件。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';


/**
 * 补零到指定位数，如 pad(7) 得到 07。
 * @param value 数字。
 * @param width 位数，默认 2。
 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}


/**
 * 生成时间 ID：本地时间的年月日时分秒毫秒（17 位）加 3 个随机小写字母，如 20261101213005123abc。
 * 按字符串排序就是按时间排序；同一毫秒里也几乎不会重复。对话文件夹、步骤文件都用它起名。
 * @param date 用哪个时间，默认现在。
 * @returns 20 个字符的 ID。
 */
export function createTimeId(date = new Date()): string {
  /** 3 个随机小写字母。 */
  let randomPart = '';
  for (let i = 0; i < 3; i++) {
    randomPart += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  }
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}` +
    randomPart
  );
}


/**
 * 本地时间写成 2026-11-01 21:30:05，日志和索引里给人看。
 * @param date 用哪个时间，默认现在。
 */
export function formatTime(date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}


/**
 * 读一个 YAML 文件。
 * @param file 文件路径。
 * @returns 解析出的内容，原样返回，不检查字段；调用方按自己的类型断言。
 * @throws 文件读不到或不是合法 YAML 时抛错。
 */
export async function readYaml(file: string): Promise<unknown> {
  return Bun.YAML.parse(await fs.readFile(file, 'utf8'));
}


/**
 * 写一个 YAML 文件（多行块格式，缩进 2 格）；所在文件夹没有就建。
 * @param file 文件路径。
 * @param data 要写的内容。
 * 副作用：整篇覆盖这个文件。
 */
export async function writeYaml(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Bun.YAML.stringify(data, null, 2));
}


/**
 * 长文本截短：超过 maxChars 就只留开头，末尾注明一共多少字、省略了多少。
 * @param text 原文。
 * @param maxChars 最多留几个字符。
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n……（共 ${text.length} 字，后面 ${text.length - maxChars} 字省略）`;
}


/**
 * 读命令行参数 --名字 的值，如 getArg(['--config', 'a.yaml'], 'config') 得到 a.yaml。
 * @param argv 命令行参数（不含 bun 和脚本路径）。
 * @param name 参数名，不带 --。
 * @returns 参数值；没写这个参数，或它后面没有值时是 undefined。
 */
export function getArg(argv: readonly string[], name: string): string | undefined {
  /** --名字 在参数里的位置。 */
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}
