/**
 * 打包后的网页资源地址测试（docs/界面/任务书/发0.2.7_DSH.md 第 1 步）：
 * 打包出来的 index.html 引用的脚本、样式在 assets/ 下；JS 里鲸鱼娘的 40 张 webp 都打进了 assets/，
 * 地址在运行时由 Images.ts 统一拼成 /assets/文件名（打包给的相对地址浏览器会按网页地址去找，0.2.6 裂图就是这个）。
 * 这里真跑一遍 web/Build.ts，产物放临时目录，看完删掉；不碰仓库里的 dist/web。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as serveProcess from '../scripts/Serve_Process.ts';


bunTest.describe('打包后的网页资源', () => {
  bunTest.test(
    'index.html 的脚本、样式在 assets/ 下，40 张鲸鱼娘图都打进了 assets/',
    () => {
      /** 这次打包的产物目录。 */
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-web-'));
      try {
        //M 用正式打包脚本打一份到临时目录，和发布时走同一条路。
        /** 打包结果。 */
        const build = Bun.spawnSync([process.execPath, path.join(serveProcess.ROOT, 'web', 'Build.ts')], { cwd: serveProcess.ROOT, env: { ...process.env, JMBOTS_WEB_OUT: outDir }, stdout: 'pipe', stderr: 'pipe' });
        //G 打包失败就把输出贴上，方便看原因。
        bunTest.expect(build.exitCode, `${build.stdout.toString()}${build.stderr.toString()}`).toBe(0);
        /** index.html 的正文。 */
        const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
        /** 脚本和样式的地址。 */
        const links = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? '');
        bunTest.expect(links.length).toBeGreaterThan(0);
        for (const url of links) {
          bunTest.expect(/^\.?\/assets\//.test(url), `index.html 引用的地址不在 assets/ 下：${url}`).toBe(true);
        }
        /** 打包出来的 JS。 */
        const scripts = fs.readdirSync(path.join(outDir, 'assets')).filter((name) => name.endsWith('.js'));
        bunTest.expect(scripts.length).toBeGreaterThan(0);
        /** JS 里引用到的 webp。 */
        const webps: string[] = [];
        for (const script of scripts) {
          /** 这份 JS 的正文。 */
          const text = fs.readFileSync(path.join(outDir, 'assets', script), 'utf8');
          webps.push(...[...text.matchAll(/"([^"]+\.webp)"/g)].map((match) => match[1] ?? ''));
        }
        //M 40 张鲸鱼娘图都在，文件真的在 assets/ 里（运行时 Images.ts 按文件名拼成 /assets/文件名）。
        bunTest.expect(webps.length).toBe(40);
        for (const url of webps) {
          bunTest.expect(fs.existsSync(path.join(outDir, 'assets', path.basename(url))), `鲸鱼娘图片没打进 assets/：${url}`).toBe(true);
        }
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
