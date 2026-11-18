/**
 * 编译进单个程序里的文件（网页、出厂提示词）。
 * 打包脚本生成的 Register.ts 先调 register，再跑 Main.ts；源码跑时这张表是空的，isCompiled() 为 false。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as textModule from './Text.ts';


/** 相对路径 → Bun.file 能打开的路径。 */
const files = new Map<string, string>();

/** 是不是编译版。 */
let compiled = false;

/** 编译时刻（毫秒）。源码跑是 0。 */
let built = 0;


/**
 * 登记内嵌文件。只给打包时生成的 Register.ts 调。
 * @param entries 相对路径 → `import f from '…' with { type: 'file' }` 拿到的路径。
 * @param time 编译时刻，毫秒。
 * 副作用：写进 files，标成编译版。
 */
export function register(entries: Record<string, string>, time: number): void {
  compiled = true;
  built = time;
  //M 相对路径统一成正斜杠再登记，find 时同样换过，Windows 上打的包也对得上。
  textModule.eachEntry(entries, (relative, file) => {
    const key = relative.replaceAll('\\', '/');
    files.set(key, file);
  });
}


/** 是不是编译成单个程序以后在跑。 */
export function isCompiled(): boolean {
  return compiled;
}


/** 编译时刻，毫秒；源码跑是 0。 */
export function getBuiltTime(): number {
  return built;
}


/**
 * 取一个内嵌文件的路径，给 Bun.file 用。
 * @param name 登记时的相对路径，如 web/index.html、prompts/00_base_dsh.md。
 * @returns 路径；没有这个文件是 undefined。
 */
export function find(name: string): string | undefined {
  return files.get(name.replaceAll('\\', '/'));
}


/**
 * 登记过的全部相对路径。boot-trail 找“谁调它”时从这里挑出 src7/ 下的源码。
 * @returns 如 src7/Main.ts、web/index.html；源码跑时是空的。
 */
export function getNames(): string[] {
  return [...files.keys()];
}


/**
 * 把一个内嵌文件写到磁盘（已有的不覆盖）。出厂提示词第一次落到运行时目录时用。
 * @param name 登记时的相对路径。
 * @param dest 要写到哪。
 * @returns 写成功了，或本来就有；没有这个内嵌文件是 false。
 * 副作用：可能建目录、写文件。
 */
export async function exportFile(name: string, dest: string): Promise<boolean> {
  if (fs.existsSync(dest)) return true;
  //M 查找内嵌文件真实句柄；源码模式或未收录时退出不建空文件。
  const file = find(name);
  if (file === undefined) return false;
  //M 建好上层目录，读出内嵌文件的字节，写下去。
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const content = await Bun.file(file).arrayBuffer();
  const bytes = Buffer.from(content);
  fs.writeFileSync(dest, bytes);
  return true;
}


/** 源码跑时网页在哪：本文件在 src7/utils/，往上两层是代码目录，下面的 dist/web。 */
const WEB_DIR = path.resolve(import.meta.dir, '../../dist/web');


/**
 * 读一个网页文件（聊天页、图谱页、记忆页等都从这里取）。
 * 源码跑时读代码目录下的 dist/web；编译成单个程序以后从打包时登记进本文件的表里取。
 * @param relative 相对 dist/web 的路径，比如 index.html、graph.html、assets/index-xxx.js。
 * @returns 文件内容；没有这个文件、是文件夹、跳出了 dist/web，都是 undefined。
 */
export async function readAsset(relative: string): Promise<Buffer | undefined> {
  //M 编译版：登记时路径是 web/…，也认不带前缀的（兼容旧入口）。
  const file = find(`web/${relative}`) ?? find(relative);
  if (file !== undefined) {
    const content = await Bun.file(file).arrayBuffer();
    return Buffer.from(content);
  }

  //G 编译版表里没有 → 就是没有，不去磁盘上找。
  if (isCompiled()) return undefined;

  //G 空路径、跳出 dist/web 的不给：网页不查令牌，没有这一行，别的机器能读代码目录下任何文件。
  const full = path.resolve(WEB_DIR, relative);
  const inside = path.relative(WEB_DIR, full);
  if (relative === '' || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;

  //M 源码版：是文件才读。
  const stat = await fs.promises.stat(full).catch(() => undefined);
  if (stat?.isFile() !== true) return undefined;
  return fs.promises.readFile(full);
}
