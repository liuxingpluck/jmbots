/**
 * 飞书插件端到端测试的入口（test:src7 里跑）：
 *   bun src7/tests/Feishu_Test.ts [步骤名...]
 * 起假飞书（127.0.0.1:15703）和测试服务（cache/test-src7-feishu，127.0.0.1:15694，假模型），跑 feishu/e2e.ts 的 22 项，
 * 跑完只按自己起的 PID 关进程。起来 10 秒内健康检查不通就关掉、记下原因、退出码 1。
 * 2026-11-14 17:50 加（Claude 17:34 第 6 节：把飞书 e2e 挪进 src7/tests 并加进 test:src7）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '../..');
const HERE = path.join(ROOT, 'cache/test-src7-feishu');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const started: number[] = [];

function kill(pid: number): void {
  if (pid <= 0) return;
  if (process.platform === 'win32') childProcess.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(pid); } catch { /* 已经退了 */ } }
}
function spawn(args: string[], label: string): childProcess.ChildProcess {
  const log = fs.openSync(path.join(HERE, `${label}.log`), 'w');
  const child = childProcess.spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true });
  started.push(child.pid ?? 0);
  return child;
}
async function healthy(url: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}
function finish(code: number, why = ''): never {
  if (why !== '') console.log(why);
  for (const pid of started) kill(pid);
  process.exit(code);
}

//M 上次的库清掉：事件号每次从 1 数，旧库里记着“处理过”会被当成重复。
fs.rmSync(path.join(HERE, 'data'), { recursive: true, force: true });
//M 上次下载的图片也清掉：e2e 按“收件箱里正好 1 张”验。
fs.rmSync(path.join(HERE, 'bots', '助手', 'workspace', 'inbox'), { recursive: true, force: true });

spawn(['src7/tests/feishu/fake-feishu.ts'], 'fake');
if (!(await healthy('http://127.0.0.1:15703/test/log'))) finish(1, '假飞书 10 秒内没起来，见 cache/test-src7-feishu/fake.log');
spawn(['src7/Main.ts', '--data', HERE], 'serve');
if (!(await healthy('http://127.0.0.1:15694/test/status'))) finish(1, '测试服务 10 秒内没起来，见 cache/test-src7-feishu/serve.log');

const e2e = childProcess.spawnSync(process.execPath, ['src7/tests/feishu/e2e.ts', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 20 * 60_000 });
finish(e2e.status ?? 1);
