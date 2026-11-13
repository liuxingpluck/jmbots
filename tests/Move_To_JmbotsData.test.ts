/**
 * 搬进 jmbotsData（scripts/Move_To_JmbotsData.ts）的离线测试：在临时目录造一个小运行时，
 * 用子进程跑脚本（脚本顶层 await main()，不好直接 import 测主要函数）。
 * 覆盖：不带 --run yes 什么也不动；平铺文件收进带说明的文件夹、没说明的文件夹加说明、已有说明的不动；
 * 四种写法的路径都改对；jmbots.exe、bak\ 的路径不改；已经搬过时拒绝；真搬完再跑也拒绝。
 * --old_root 故意和 --from 不同（模拟在复制品上演练）：脚本的 real 判断为假，不会去写项目根的 .env。
 * 路径分两种：真正建文件、查文件用 node:path（跟着系统走）；写进数据库／paths.txt／config.yaml 的“文字路径”
 * 一律用反斜杠写法——脚本会把 --old_root/--new_root 都转成反斜杠再改文字，Linux 上这样写才对得上；Windows 本来就是反斜杠，不受影响。
 */
import * as bunTest from 'bun:test';
import * as bunSqlite from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as serveProcess from '../scripts/Serve_Process.ts';


/** 单个测试的超时，毫秒：要起子进程跑脚本。 */
const TEST_TIMEOUT_MS = 60_000;

/** 平铺消息的主干：小写字母_加 17 位时间。 */
const STEM_FLAT = 'http_20250101000000001';
/** 没说明的消息文件夹主干。 */
const STEM_DIR = 'http_20250101000000002';
/** 已有说明的消息文件夹名。 */
const STEM_NOTED = 'http_20250101000000003_已有说明';
/** 平铺消息老位置的 tail（相对运行时，用 /）。 */
const OLD_TAIL = `bots/小测/message/${STEM_FLAT}.md`;
/** 平铺消息新位置的 tail（收进带说明的文件夹以后）。 */
const NEW_TAIL = `bots/小测/message/${STEM_FLAT}_你好世界/${STEM_FLAT}.md`;


/** 跑一次脚本的结果。 */
interface RunResult {
  /** 退出码。 */
  code: number;
  /** stdout 加 stderr。 */
  output: string;
}


/** 测试用的小运行时。 */
interface Harness {
  /** 临时目录的根，收尾时删掉。 */
  base: string;
  /** 实际的小运行时目录（--from）。 */
  from: string;
  /** 文字里写的老路径（--old_root，故意和 from 不同；系统写法，交给脚本自己转成反斜杠）。 */
  oldRoot: string;
  /** 文字里要写成的新路径（--new_root，就是 from 下的 jmbotsData；系统写法）。 */
  newRoot: string;
  /** 写进文字里的老路径：反斜杠写法，脚本改文字时认这个。 */
  oldRootText: string;
  /** 写进文字里的新路径：反斜杠写法，同上。 */
  newRootText: string;
  /** 保证连不上的端口（--port）。 */
  port: number;
}


/**
 * 在 15000 以上找一个能监听的空闲端口（按项目习惯避开带 4 的）。
 * @returns 端口。
 */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    /** 候选端口。 */
    const port = 15_000 + Math.floor(Math.random() * 50_000);
    if (String(port).includes('4')) {
      continue;
    }
    try {
      /** 试一下能不能监听。 */
      const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') });
      await probe.stop(true);
      return port;
    } catch {
      //G 被别的程序占了：换一个。
    }
  }
  throw new Error('找不到空闲端口');
}


/**
 * 把一段相对路径按某种分隔写法拼到根后面（只用来造“文字路径”，不用来查文件）。
 * @param root 根路径（反斜杠写法，见 makeHarness 里的 oldRootText/newRootText）。
 * @param sep 分隔符写法：\、\\、\\\\ 或 /。
 * @param tail 相对路径（用 /）。
 * @returns 拼好的路径字面文本。
 */
function joinStyle(root: string, sep: string, tail: string): string {
  return `${root.replaceAll('\\', sep)}${sep}${tail.replaceAll('/', sep)}`;
}


/**
 * 造一个小运行时：两条平铺消息、一个没说明的文件夹、一个已有说明的文件夹、带原话的数据库、
 * 四种写法的路径文本、不该改的 jmbots.exe 与 bak\ 路径、一份假配置（不含密钥）。
 * @param alreadyMoved 要不要预先在 jmbotsData/ 放个 config.yaml，模拟已经搬过。
 * @returns 小运行时。
 * 副作用：在临时目录造文件，并把根目录记进 bases 供收尾删除。
 */
async function makeHarness(alreadyMoved = false): Promise<Harness> {
  /** 临时目录的根。 */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-move-'));
  bases.push(base);
  /** 实际小运行时。 */
  const from = path.join(base, 'runtime');
  /** 文字里的老路径：故意是另一个目录，免得脚本把项目根 .env 改了。 */
  const oldRoot = path.join(base, 'OLDROOT');
  /** 文字里的新路径。 */
  const newRoot = path.join(from, 'jmbotsData');
  /** 写进文字里的老路径：反斜杠写法，和脚本转完的 --old_root 一致（Windows 上本来就是反斜杠）。 */
  const oldRootText = oldRoot.replaceAll('/', '\\');
  /** 写进文字里的新路径：反斜杠写法，同上。 */
  const newRootText = newRoot.replaceAll('/', '\\');
  /** 保证连不上的端口。 */
  const port = await freePort();

  /** 消息目录。 */
  const messageDir = path.join(from, 'bots', '小测', 'message');
  fs.mkdirSync(messageDir, { recursive: true });
  //M 两个平铺文件共用一个主干，会被收进同一个带说明的文件夹。
  fs.writeFileSync(path.join(messageDir, `${STEM_FLAT}.md`), '原话');
  fs.writeFileSync(path.join(messageDir, `${STEM_FLAT}.json`), '{}');
  //M 没说明的文件夹、已有说明的文件夹各一个。
  fs.mkdirSync(path.join(messageDir, STEM_DIR), { recursive: true });
  fs.writeFileSync(path.join(messageDir, STEM_DIR, `${STEM_DIR}.md`), '原话');
  fs.mkdirSync(path.join(messageDir, STEM_NOTED), { recursive: true });
  fs.writeFileSync(path.join(messageDir, STEM_NOTED, `${STEM_NOTED}.md`), '原话');

  //M 数据库：三条消息的原话，文件夹说明靠它生成。
  const dataDir = path.join(from, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  /** 数据库。 */
  const db = new bunSqlite.Database(path.join(dataDir, 'jmbots.db'));
  db.run('CREATE TABLE messages (id INTEGER PRIMARY KEY, file TEXT, text TEXT)');
  /** 一条消息。 */
  const insert = db.prepare('INSERT INTO messages (id, file, text) VALUES (?, ?, ?)');
  insert.run(1, `${oldRootText}\\bots\\小测\\message\\${STEM_FLAT}.md`, '你好世界');
  insert.run(2, `${oldRootText}\\bots\\小测\\message\\${STEM_DIR}`, '第二条消息');
  insert.run(3, `${oldRootText}\\bots\\小测\\message\\${STEM_NOTED}`, '已有说明的不动');
  db.close();

  //M 四种写法的路径，还有 jmbots.exe、bak\ 两处不该改的。
  const integrations = path.join(from, 'integrations', 'x');
  fs.mkdirSync(integrations, { recursive: true });
  /** 四种分隔符写法，和脚本的 SEPARATORS 一样。 */
  const seps: [string, string][] = [['\\', 'plain'], ['\\\\', 'json1'], ['\\\\\\\\', 'json2'], ['/', 'slash']];
  /** 每一行。 */
  const lines: string[] = [];
  for (const [sep, label] of seps) {
    lines.push(`${label}=${joinStyle(oldRootText, sep, OLD_TAIL)}`);
  }
  lines.push(`exe=${oldRootText}\\jmbots.exe`);
  lines.push(`bak=${oldRootText}\\bak\\keep\\x.md`);
  fs.writeFileSync(path.join(integrations, 'paths.txt'), `${lines.join('\n')}\n`);

  //M 假配置（不含密钥）：里面写死的索引目录也要改到新位置。
  fs.writeFileSync(path.join(from, 'config.yaml'), `local:\n  libs: ${oldRootText}\\memorycli\\\n  rag: ${oldRootText}\\rag\\\n`);
  //M 不该搬的：jmbots.exe、bak\。
  fs.writeFileSync(path.join(from, 'jmbots.exe'), 'fake exe');
  fs.mkdirSync(path.join(from, 'bak', 'keep'), { recursive: true });
  fs.writeFileSync(path.join(from, 'bak', 'keep', 'x.md'), '备份里的东西');

  //G 已经搬过：目标目录里放一份 config.yaml，脚本该在这里就拒绝。
  if (alreadyMoved) {
    fs.mkdirSync(path.join(from, 'jmbotsData'), { recursive: true });
    fs.writeFileSync(path.join(from, 'jmbotsData', 'config.yaml'), 'local: {}\n');
  }

  return { base, from, oldRoot, newRoot, oldRootText, newRootText, port };
}


/**
 * 跑一次搬家脚本（子进程，限时 30 秒）。
 * @param harness 小运行时。
 * @param extra 额外的命令行参数。
 * @returns 退出码和输出。
 * 副作用：起子进程；超时就杀掉。
 */
async function runMove(harness: Harness, extra: string[] = []): Promise<RunResult> {
  /** 子进程。 */
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(serveProcess.ROOT, 'scripts', 'Move_To_JmbotsData.ts'), '--from', harness.from, '--old_root', harness.oldRoot, '--new_root', harness.newRoot, '--port', String(harness.port), ...extra],
    cwd: serveProcess.ROOT,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  /** 输出（先开始读，免得管道满了卡住）。 */
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  /** 有没有超时。 */
  let timedOut = false;
  /** 计时器。 */
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 30_000);
  /** 退出码。 */
  const code = await child.exited;
  clearTimeout(timer);
  /** 拼起来的输出。 */
  const output = `${await stdout}${await stderr}`;
  if (timedOut) {
    throw new Error(`搬家脚本超时：${output}`);
  }
  return { code, output };
}


/**
 * 一个目录下所有文件的相对路径和内容，用来对比“什么也没动”。
 * @param dir 目录。
 * @returns 相对路径 → 内容（二进制按 utf8 读，两次读同样的字节结果一样）。
 */
function snapshot(dir: string): Map<string, string> {
  /** 结果。 */
  const out = new Map<string, string>();
  /**
   * 递归走。
   * @param current 当前目录。
   */
  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      /** 完整路径。 */
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.set(path.relative(dir, full).replaceAll('\\', '/'), fs.readFileSync(full, 'utf8'));
      }
    }
  }
  walk(dir);
  return out;
}


/** 所有造过的临时目录，收尾时删掉。 */
const bases: string[] = [];

/** 小运行时（第一次用时建，几个测试共用）。 */
let harnessPromise: Promise<Harness> | undefined;


/**
 * 取共用的小运行时。
 * @returns 小运行时。
 * 副作用：第一次调用时在临时目录造一遍。
 */
function runtime(): Promise<Harness> {
  harnessPromise ??= makeHarness();
  return harnessPromise;
}


bunTest.describe('Move_To_JmbotsData（临时小运行时）', () => {
  bunTest.afterAll(() => {
    for (const base of bases) {
      //G Windows 上子进程刚退出时目录可能还被占着：多重试几次，实在删不掉也不把测试判失败。
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        //G 删不掉就留在系统临时目录里，不影响断言。
      }
    }
  });

  bunTest.test(
    '不带 --run yes 什么也不动',
    async () => {
      /** 小运行时。 */
      const harness = await runtime();
      /** 跑之前的全量快照。 */
      const before = snapshot(harness.from);
      /** 先看。 */
      const result = await runMove(harness);
      bunTest.expect(result.code).toBe(0);
      bunTest.expect(result.output).toContain('这次只是看，什么也没动');
      bunTest.expect(result.output).toContain('要改路径');
      bunTest.expect(fs.existsSync(path.join(harness.from, 'jmbotsData'))).toBe(false);
      /** 跑之后的全量快照。 */
      const after = snapshot(harness.from);
      bunTest.expect(after).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '--run yes 真搬：消息整理、四种写法改路径、jmbots.exe 和 bak 不动',
    async () => {
      /** 小运行时。 */
      const harness = await runtime();
      /** 真搬。 */
      const result = await runMove(harness, ['--run', 'yes']);
      bunTest.expect({ code: result.code, out: result.code === 0 ? '' : result.output }).toEqual({ code: 0, out: '' });
      bunTest.expect(result.output).toContain('# 搬进 jmbotsData');
      /** 新运行时。 */
      const target = path.join(harness.from, 'jmbotsData');
      bunTest.expect(fs.existsSync(target)).toBe(true);
      /** 新消息目录。 */
      const messageDir = path.join(target, 'bots', '小测', 'message');
      //M 平铺的两个文件收进带说明的文件夹，原地不再有平铺文件。
      bunTest.expect(fs.existsSync(path.join(messageDir, `${STEM_FLAT}_你好世界`, `${STEM_FLAT}.md`))).toBe(true);
      bunTest.expect(fs.existsSync(path.join(messageDir, `${STEM_FLAT}_你好世界`, `${STEM_FLAT}.json`))).toBe(true);
      bunTest.expect(fs.existsSync(path.join(messageDir, `${STEM_FLAT}.md`))).toBe(false);
      bunTest.expect(fs.existsSync(path.join(messageDir, `${STEM_FLAT}.json`))).toBe(false);
      //M 没说明的文件夹加上说明；已有说明的文件夹名字不变。
      bunTest.expect(fs.existsSync(path.join(messageDir, `${STEM_DIR}_第二条消息`))).toBe(true);
      bunTest.expect(fs.existsSync(path.join(messageDir, STEM_DIR))).toBe(false);
      bunTest.expect(fs.existsSync(path.join(messageDir, STEM_NOTED))).toBe(true);
      //M message/ 下没有平铺文件了（全是文件夹）。
      for (const entry of fs.readdirSync(messageDir, { withFileTypes: true })) {
        bunTest.expect(entry.isDirectory()).toBe(true);
      }
      //M 四种写法的路径都改对了。
      /** 改完的 paths.txt。 */
      const text = fs.readFileSync(path.join(target, 'integrations', 'x', 'paths.txt'), 'utf8');
      /** 四种分隔符写法。 */
      const seps: [string, string][] = [['\\', 'plain'], ['\\\\', 'json1'], ['\\\\\\\\', 'json2'], ['/', 'slash']];
      for (const [sep, label] of seps) {
        /** 这一行该有的新路径。 */
        const expected = `${label}=${joinStyle(harness.newRootText, sep, NEW_TAIL)}`;
        bunTest.expect(text).toContain(expected);
      }
      //M 新路径里的文件真的在：查文件要用系统路径（path.join），不能用反斜杠写法的文字路径，Linux 上它不是有效路径。
      bunTest.expect(fs.existsSync(path.join(harness.newRoot, ...NEW_TAIL.split('/')))).toBe(true);
      //M jmbots.exe、bak\ 的路径没改；这两个东西也没搬进 jmbotsData。
      bunTest.expect(text).toContain(`exe=${harness.oldRootText}\\jmbots.exe`);
      bunTest.expect(text).toContain(`bak=${harness.oldRootText}\\bak\\keep\\x.md`);
      bunTest.expect(fs.existsSync(path.join(harness.from, 'jmbots.exe'))).toBe(true);
      bunTest.expect(fs.existsSync(path.join(target, 'jmbots.exe'))).toBe(false);
      bunTest.expect(fs.existsSync(path.join(harness.from, 'bak', 'keep', 'x.md'))).toBe(true);
      bunTest.expect(fs.existsSync(path.join(target, 'bak'))).toBe(false);
      //M 假配置里写死的索引目录也改到新位置了。
      /** 搬过去的假配置。 */
      const config = fs.readFileSync(path.join(target, 'config.yaml'), 'utf8');
      bunTest.expect(config).toContain(`${harness.newRootText}\\data\\index\\libs\\`);
      bunTest.expect(config).toContain(`${harness.newRootText}\\data\\index\\rag\\`);
      bunTest.expect(config).not.toContain('OLDROOT');
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '已经搬过时拒绝',
    async () => {
      /** 独立的小运行时：目标目录里已有 config.yaml，模拟已经搬过。 */
      const harness = await makeHarness(true);
      /** 跑一次（带 --run yes 也一样先被守卫拦住）。 */
      const result = await runMove(harness, ['--run', 'yes']);
      bunTest.expect(result.code).toBe(1);
      bunTest.expect(result.output).toContain('里已经有东西了，不再搬');
    },
    TEST_TIMEOUT_MS,
  );

  bunTest.test(
    '真搬完再跑也被拒绝',
    async () => {
      /** 共享的小运行时：前面的测试已经搬过了。 */
      const harness = await runtime();
      /** 再跑一次。 */
      const result = await runMove(harness, ['--run', 'yes']);
      bunTest.expect(result.code).not.toBe(0);
      //G 搬完以后 bots/ 已进 jmbotsData，脚本先在“目录下要有 bots/”这一步拒绝；两种拒绝都算拒绝。
      const refused = result.output.includes('用法') || result.output.includes('里已经有东西了，不再搬');
      bunTest.expect(refused).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
