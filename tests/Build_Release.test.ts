/**
 * 发布脚本 `byStamp` 的离线测试（docs/界面/任务书/发0.3.0_DSH.md 第 1 步）：
 * 0.2.10 的文件名不能因为版本号字面排在 0.2.9 前面；要按文件名末尾的时间戳排。
 * `Build_Release.ts` 是直接执行 main() 的脚本，不能在测试里 import（会触发发布），所以从源码里取 byStamp 函数来跑；
 * 只读源码，不写文件、不跑发布。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import * as serveProcess from '../scripts/Serve_Process.ts';


/**
 * 从 Build_Release.ts 源码里取 byStamp，转成 JS 后用 data URL 模块加载。
 * @returns 比较函数。
 */
async function loadByStamp(): Promise<(left: string, right: string) => number> {
  /** 发布脚本源码。 */
  const source = fs.readFileSync(path.join(serveProcess.ROOT, 'scripts', 'Build_Release.ts'), 'utf8');
  /** 函数文本（到函数末尾的那个单独一行的右括号）。 */
  const match = /function byStamp\([\s\S]*?\n\}/.exec(source);
  if (!match) {
    throw new Error('Build_Release.ts 里找不到 byStamp');
  }
  /** 转成 JS（去掉类型标注），导出 byStamp。 */
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${match[0]}\nexport { byStamp };`);
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-bystamp-'));
  /** 临时模块文件。 */
  const file = path.join(dir, 'by-stamp.mjs');
  try {
    fs.writeFileSync(file, js);
    /** 加载出来的模块。 */
    const module = (await import(url.pathToFileURL(file).href)) as { byStamp: (left: string, right: string) => number };
    return module.byStamp;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


bunTest.test('byStamp：0.2.10 新时间排在 0.2.9 旧时间后面', async () => {
  /** 比较函数。 */
  const byStamp = await loadByStamp();
  /** 旧版本文件。 */
  const oldFile = 'jmbots-server-0.2.9-20261106085354307274.exe';
  /** 新版本文件（版本号字面更小，但时间更新）。 */
  const newFile = 'jmbots-server-0.2.10-20261106090228856457.exe';
  //M 旧时间在前：sort 以后是 [旧, 新]。
  bunTest.expect(byStamp(oldFile, newFile)).toBeLessThan(0);
  bunTest.expect([newFile, oldFile].sort(byStamp)).toEqual([oldFile, newFile]);
  //M 同一版本重新编译，也按时间排。
  bunTest.expect(byStamp('jmbots-server-0.3.0-20261106090000000000.exe', 'jmbots-server-0.3.0-20261106091000000000.exe')).toBeLessThan(0);
});
