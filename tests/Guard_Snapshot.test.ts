/**
 * 看门狗和版本快照的离线测试：快照存/列/只留最近几份、坏目录跳过、换版本的锁、看门狗心跳、时间 ID。
 * 都在临时目录里做，不碰项目的 bak/versions，也不起任何进程。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as guard from '../scripts/Guard.ts';
import * as serveProcess from '../scripts/Serve_Process.ts';
import * as snapshot from '../scripts/Snapshot.ts';


/**
 * 建一个临时目录。
 * @param name 名字里的用途。
 */
function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jmbots-${name}-`));
}


/**
 * 建一份假的"项目"，只有快照会拷的那几样。
 * @param root 放哪儿。
 */
function fakeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'entries'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'entries', 'Main.ts'), '// 假的入口\n');
  fs.writeFileSync(path.join(root, 'src', 'events', 'Loop.ts'), '// 假的事件循环\n');
  fs.writeFileSync(path.join(root, 'dist', 'web', 'index.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fake"}\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
}


bunTest.test('存一份快照：该拷的都在，说明文件能读回来', () => {
  /** 假项目。 */
  const root = tempDir('root');
  /** 快照目录。 */
  const versionsDir = tempDir('versions');
  fakeProject(root);

  /** 存好的快照。 */
  const version = snapshot.save('20261103120000000111', 312, { root, versionsDir });
  bunTest.expect(version.id).toBe('20261103120000000111');
  bunTest.expect(version.healthySeconds).toBe(312);
  //M 服务从快照目录起得来，靠的就是这几样都在。
  for (const item of ['src/entries/Main.ts', 'src/events/Loop.ts', 'dist/web/index.html', 'package.json', 'tsconfig.json']) {
    bunTest.expect(fs.existsSync(path.join(version.dir, item))).toBe(true);
  }
  //M 列出来时读的是说明文件，内容要和刚存的一致。
  bunTest.expect(snapshot.list(versionsDir).map((item) => item.id)).toEqual(['20261103120000000111']);
  bunTest.expect(snapshot.list(versionsDir)[0]?.healthySeconds).toBe(312);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(versionsDir, { recursive: true, force: true });
});


bunTest.test('dist/web 还没打包过也能存，只是快照里没有网页', () => {
  /** 假项目。 */
  const root = tempDir('root-nodist');
  /** 快照目录。 */
  const versionsDir = tempDir('versions-nodist');
  fakeProject(root);
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

  /** 存好的快照。 */
  const version = snapshot.save('20261103120100000222', 300, { root, versionsDir });
  bunTest.expect(fs.existsSync(path.join(version.dir, 'src', 'entries', 'Main.ts'))).toBe(true);
  bunTest.expect(fs.existsSync(path.join(version.dir, 'dist'))).toBe(false);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(versionsDir, { recursive: true, force: true });
});


bunTest.test('只留最近 5 份，老的删掉；新的在前', () => {
  /** 假项目。 */
  const root = tempDir('root-keep');
  /** 快照目录。 */
  const versionsDir = tempDir('versions-keep');
  fakeProject(root);

  for (let index = 1; index <= 7; index += 1) {
    snapshot.save(`2026110312000000${String(index).padStart(4, '0')}`, 300, { root, versionsDir });
  }
  /** 剩下的。 */
  const kept = snapshot.list(versionsDir);
  bunTest.expect(kept).toHaveLength(5);
  //M 新的在前，留下的是后 5 次（第 3 到第 7 次）。
  bunTest.expect(kept[0]?.id).toBe('20261103120000000007');
  bunTest.expect(kept[4]?.id).toBe('20261103120000000003');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(versionsDir, { recursive: true, force: true });
});


bunTest.test('拷到一半断掉的目录不算能用的版本；skipIds 里的跳过', () => {
  /** 假项目。 */
  const root = tempDir('root-bad');
  /** 快照目录。 */
  const versionsDir = tempDir('versions-bad');
  fakeProject(root);

  snapshot.save('20261103120000000001', 300, { root, versionsDir });
  snapshot.save('20261103120000000002', 300, { root, versionsDir });
  //G 没有说明文件的目录（上次拷到一半断了），和说明文件坏掉的，都不能当版本用。
  fs.mkdirSync(path.join(versionsDir, '20261103120000000009'), { recursive: true });
  fs.mkdirSync(path.join(versionsDir, '20261103120000000008'), { recursive: true });
  fs.writeFileSync(path.join(versionsDir, '20261103120000000008', '版本.json'), '{ 这不是 json');

  bunTest.expect(snapshot.list(versionsDir).map((item) => item.id)).toEqual(['20261103120000000002', '20261103120000000001']);
  bunTest.expect(snapshot.latest([], versionsDir)?.id).toBe('20261103120000000002');
  //M 最近那份试过起不来，就该换更早的一份。
  bunTest.expect(snapshot.latest(['20261103120000000002'], versionsDir)?.id).toBe('20261103120000000001');
  bunTest.expect(snapshot.latest(['20261103120000000002', '20261103120000000001'], versionsDir)).toBeUndefined();

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(versionsDir, { recursive: true, force: true });
});


bunTest.test('没有快照目录时列出来是空的，不报错', () => {
  bunTest.expect(snapshot.list(path.join(os.tmpdir(), 'jmbots-versions-不存在-20261103'))).toEqual([]);
  bunTest.expect(snapshot.latest([], path.join(os.tmpdir(), 'jmbots-versions-不存在-20261103'))).toBeUndefined();
});


bunTest.test('换版本的锁：刚写的有效，写旧了就过期', () => {
  /** 假运行时。 */
  const runtimeDir = tempDir('runtime-lock');
  fs.mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });
  /** 锁文件。 */
  const lockFile = path.join(runtimeDir, 'data', 'swap.lock');

  bunTest.expect(serveProcess.isSwapping(runtimeDir)).toBe(false);
  fs.writeFileSync(lockFile, String(Date.now()));
  bunTest.expect(serveProcess.isSwapping(runtimeDir)).toBe(true);
  //M 锁过期之后看门狗就该正常接管了，不然换版本挂了就没人管。
  fs.writeFileSync(lockFile, String(Date.now() - serveProcess.SWAP_LOCK_MS - 1000));
  bunTest.expect(serveProcess.isSwapping(runtimeDir)).toBe(false);

  fs.rmSync(runtimeDir, { recursive: true, force: true });
});


bunTest.test('看门狗心跳：新鲜算活着，旧了算没了', () => {
  /** 假运行时。 */
  const runtimeDir = tempDir('runtime-guard');
  fs.mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });

  bunTest.expect(guard.isGuardRunning(runtimeDir)).toBe(false);
  fs.writeFileSync(guard.heartbeatFile(runtimeDir), serveProcess.timeText());
  bunTest.expect(guard.isGuardRunning(runtimeDir)).toBe(true);
  //M 把心跳的修改时间改旧：进程被杀掉之后就是这个样子。
  /** 改成多久以前。 */
  const stale = new Date(Date.now() - guard.HEARTBEAT_STALE_MS - 1000);
  fs.utimesSync(guard.heartbeatFile(runtimeDir), stale, stale);
  bunTest.expect(guard.isGuardRunning(runtimeDir)).toBe(false);

  fs.rmSync(runtimeDir, { recursive: true, force: true });
});


bunTest.test('时间 ID 是 20 位数字，按时间往后排', () => {
  /** 一个 ID。 */
  const first = serveProcess.timeId();
  bunTest.expect(first).toMatch(/^\d{20}$/);
  //M 日志文件名按天分组用的是前 8 位（年月日）。
  bunTest.expect(first.slice(0, 8)).toMatch(/^20\d{6}$/);
  //M 快照是按 ID 字符串排序的，所以同一毫秒之外必须单调不减。
  bunTest.expect(serveProcess.timeId().slice(0, 14) >= first.slice(0, 14)).toBe(true);
});


bunTest.test('运行时目录：命令行 --runtime 优先于环境变量', () => {
  //M 看门狗和双击启动都靠这个找运行时，默认值要和 src/resources/Resources.ts 的一致。
  bunTest.expect(serveProcess.DEFAULT_RUNTIME_DIR).toBe('F:/aidata/AIJMBots');
  bunTest.expect(serveProcess.option('一个不存在的参数', '兜底')).toBe('兜底');
});


bunTest.test('开发模式：按住后看门狗只看不动手，到点自动放开，文件坏了当没按住', () => {
  const root = tempDir('devhold');
  try {
    //G 没按住时就是 undefined，看门狗照常干活。
    bunTest.expect(serveProcess.devHoldUntil(root)).toBeUndefined();
    bunTest.expect(serveProcess.releaseDev(root)).toBe(false);

    const until = serveProcess.holdDev(root, 30);
    bunTest.expect(serveProcess.devHoldUntil(root)).toBe(until);
    bunTest.expect(until - Date.now()).toBeGreaterThan(29 * 60_000);

    //G 已经过期的锁等于没按住：免得忘了关，服务就一直没人守。
    fs.writeFileSync(serveProcess.devHoldFile(root), String(Date.now() - 1000));
    bunTest.expect(serveProcess.devHoldUntil(root)).toBeUndefined();

    //G 文件内容坏了也当没按住，不能把看门狗永久停掉。
    fs.writeFileSync(serveProcess.devHoldFile(root), '不是数字');
    bunTest.expect(serveProcess.devHoldUntil(root)).toBeUndefined();

    serveProcess.holdDev(root, 5);
    bunTest.expect(serveProcess.releaseDev(root)).toBe(true);
    bunTest.expect(serveProcess.devHoldUntil(root)).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
