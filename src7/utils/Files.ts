/**
 * 写文件的小工具：没有状态。令牌、config.yaml、更新状态、对话.md 这几处共用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';


/**
 * 原子写文本：先写同目录的临时文件，再改名盖过去。写到一半断电，也不会留下半份文件。
 * 只管写；要写的字（JSON、YAML、Markdown）由调用方先拼好。
 * @param file 目标文件，所在的文件夹没有就建。
 * @param text 全文，按 UTF-8 写。
 * @param fallback 改名失败时是不是退回直接写目标：Windows 上目标被别的程序打开着（编辑器开着对话.md）会改名失败。
 *   只给人看的文件才开；令牌、配置这类不许写坏的别开，改名失败就照常抛错。
 * @throws 写不进去；不许退回时改名失败也抛。
 * 副作用：建文件夹、写文件；改名失败时删掉临时文件。
 */
export function writeTextAtomic(file: string, text: string, fallback = false): void {
  //M 先写到同目录的临时文件。文件名带进程号：换版试运行时两个进程同时写同一个文件，也不会抢同一个临时文件。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');

  //M 改名盖过去：同一个盘里改名是一下完成的，读的人要么看到旧的，要么看到新的。
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    //G 改名没成 → 临时文件删掉；不许退回的照旧抛出去。
    fs.rmSync(temp, { force: true });
    if (!fallback) throw error;

    //M 许退回的：直接写目标文件。
    fs.writeFileSync(file, text, 'utf8');
  }
}
