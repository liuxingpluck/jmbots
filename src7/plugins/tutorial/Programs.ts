/**
 * 教程里的「进程插件」：按 config.yaml 里 programs 登记的程序，找到它的程序目录，读目录下的 说明.md。
 * 程序目录只从配置推出来（file 所在的目录），外面传进来的只有程序名，拿名字去配置里找，找不到就没有，不拼外部路径。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as utils from '../../utils/index.ts';

/** 程序目录下说明文件的固定名字，和插件目录的 说明.md 一样。 */
const README = '说明.md';

/**
 * 找 config 里 programs 插件登记的某个程序的目录。
 * @param raw 整份 config.yaml 的解析结果（ctx.resources.raw）。
 * @param root 运行时目录（ctx.resources.root），程序文件的相对路径以它为根。
 * @param name 程序名，入口已校验过只含小写字母、数字、横线。
 * @returns 程序文件所在的目录；没登记这个程序，或登记里没写 file，是 undefined。
 */
export function getProgramDir(raw: Record<string, unknown>, root: string, name: string): string | undefined {
  const plugins = raw['plugins'];
  if (!Array.isArray(plugins)) return undefined;

  //M 在 plugins 段里找 name 为 programs 的那一项。
  const entry = plugins.find((item: unknown) => utils.getField(item, 'name') === 'programs');
  const config = utils.getField(entry, 'config');
  const programs = utils.getField(config, 'programs');
  if (!Array.isArray(programs)) return undefined;

  //M 按程序名找登记项，名字只用来选，不拼进路径。
  const item = programs.find((program: unknown) => utils.getField(program, 'name') === name);
  const file = utils.getField(item, 'file');
  if (typeof file !== 'string' || file === '') return undefined;

  //M 和 programs 拉起时一样换掉 {runtime}、{data}，相对路径以运行时目录为根。
  const data = path.join(root, 'data');
  const filled = file.replaceAll('{runtime}', root).replaceAll('{data}', data);
  const command = path.resolve(root, filled);
  return path.dirname(command);
}

/**
 * 读登记程序目录下的 说明.md。
 * @param dir getProgramDir 给的目录。
 * @returns 说明文件的路径和全文；还没写说明时全文是空串。
 */
export async function readProgramReadme(dir: string): Promise<{ file: string; text: string }> {
  const file = path.join(dir, README);
  //G 程序目录下还没放说明，回空串，由网页提示。
  if (!fs.existsSync(file)) return { file, text: '' };

  const text = await fs.promises.readFile(file, 'utf8');
  return { file, text };
}
