/** 真实启动本地无副作用 Node 子进程，验收超时、输出限额和回收；不访问 DSH/配置。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as bounded from '../src/BoundedProcess.ts';


/** 所有执行夹具在项目内，删除前核对精确父目录。 */
const testRoot = path.resolve(import.meta.dir, '../../runtime/scratch/bounded-tests');
let fixture = '';


test.beforeEach(async () => {
  await fs.mkdir(testRoot, { recursive: true });
  fixture = await fs.mkdtemp(path.join(testRoot, 'case-'));
});


test.afterEach(async () => {
  assert.equal(path.dirname(path.resolve(fixture)), testRoot);
  assert.ok(path.basename(fixture).startsWith('case-'));
  await fs.rm(fixture, { recursive: true, force: true });
});


/** 将夹具写成普通脚本，避免 shell 和 -e 的引号转义。 */
async function script(text: string): Promise<string> {
  const file = path.join(fixture, 'child.mjs');
  await fs.writeFile(file, text);
  return file;
}


/** 发信号 0 只查询自己的子进程，不结束其他进程。 */
function assertGone(pid: number | null): void {
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0));
}


test.test('正常退出返回预算内 stdout，stderr 不向调用方回显', async () => {
  const file = await script('console.log(JSON.stringify(process.argv.slice(2))); console.error("FAKE_SECRET");');
  const result = await bounded.runBounded('node', [file, 'x & y | $(z)'], { timeoutMs: 2000 });
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.reaped, true);
  assert.deepEqual(JSON.parse(result.stdout) as unknown, ['x & y | $(z)']);
  assert.ok(!JSON.stringify(result).includes('FAKE_SECRET'));
  assertGone(result.pid);
});


test.test('非零退出不伪装成功，调用方获得退出码', async () => {
  const result = await bounded.runBounded('node', [await script('process.exit(7);')], { timeoutMs: 2000 });
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 7);
  assertGone(result.pid);
});


test.test('超时 TERM/KILL 回收，不留永远 pending 的底层进程', async () => {
  const file = await script('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const started = performance.now();
  const result = await bounded.runBounded('node', [file], { timeoutMs: 150, graceMs: 50, reapMs: 500 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.reaped, true);
  assert.ok(performance.now() - started < 2000);
  assertGone(result.pid);
});


for (const stream of ['stdout', 'stderr']) {
  test.test(`${stream} 输出超限立即停止缓存并回收`, async () => {
    const file = await script(`setInterval(() => process.${stream}.write("x".repeat(4096)), 1);`);
    const result = await bounded.runBounded('node', [file], { timeoutMs: 2000, maxOutputBytes: 1024 });
    assert.equal(result.status, 'output_limit');
    assert.equal(result.stdout, '');
    assert.equal(result.reaped, true);
    assertGone(result.pid);
  });
}


test.test('stdout/stderr 合并预算，不能各占一份限额', async () => {
  const file = await script('process.stdout.write("a".repeat(700)); process.stderr.write("b".repeat(700));');
  const result = await bounded.runBounded('node', [file], { timeoutMs: 2000, maxOutputBytes: 1024 });
  assert.equal(result.status, 'output_limit');
  assertGone(result.pid);
});


test.test('启动失败只返回稳定错误，不泄露环境或路径异常原文', async () => {
  const result = await bounded.runBounded(path.join(fixture, 'does-not-exist.exe'), [], { timeoutMs: 2000 });
  assert.equal(result.status, 'spawn_error');
  assert.equal(result.stdout, '');
  assert.equal(result.pid, null);
});


test.test('非法预算拒绝启动', () => {
  for (const timeoutMs of [0, -1, Infinity, 1.5]) {
    assert.throws(() => bounded.runBounded('node', [], { timeoutMs }));
  }
});
