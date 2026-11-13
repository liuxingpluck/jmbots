/**
 * 打包进单文件的东西：网页（web/...）和出厂提示词（prompts/...）。scripts/Build_Release.ts 编译时生成一段代码把它们登记进来。
 * 从源码跑时这张表是空的，照旧读磁盘；表不空就是编译好的程序。
 */


/** 相对路径 → 程序里能读到它的路径（Bun.file 能开）。 */
const files = new Map<string, string>();

/** 编译的时间，毫秒；从源码跑时是 0。 */
let builtAt = 0;


/**
 * 登记打包进来的文件（只有编译时生成的代码调）。
 * @param entries 相对路径 → 程序里的路径。
 * @param time 编译的时间，毫秒。
 * 副作用：写这个模块的表。
 */
export function register(entries: Record<string, string>, time: number): void {
  for (const [name, file] of Object.entries(entries)) {
    files.set(name, file);
  }
  builtAt = time;
}


/** 是不是编译好的程序。 */
export function isCompiled(): boolean {
  return files.size > 0;
}


/** 编译的时间，毫秒；从源码跑时是 0。 */
export function builtTime(): number {
  return builtAt;
}


/**
 * 取一个打包进来的文件。
 * @param name 相对路径。
 * @returns 程序里的路径；没有是 undefined。
 */
export function find(name: string): string | undefined {
  return files.get(name);
}


/**
 * 列出某个前缀下打包进来的文件。
 * @param prefix 前缀，如 prompts/。
 * @returns 相对路径和程序里的路径。
 */
export function list(prefix: string): { name: string; file: string }[] {
  return [...files].filter(([name]) => name.startsWith(prefix)).map(([name, file]) => ({ name, file }));
}
