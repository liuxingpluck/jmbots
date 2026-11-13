/**
 * 发布（用户 11-05：jmbots 要能自己改自己）：正在跑的是编译好的程序，源码随便改都影响不到它。改好了跑这个脚本：
 *   检查（typecheck、lint、测试三块同时跑）→ 打包网页 → 把网页和出厂提示词一起编译成单个可执行文件 → 放进运行时 updates/。
 * 基地定时扫 updates/，发现新版本就提醒用户，用户点更新才换：先试运行，通过才替换，失败退回（local/src/supervisor.rs）。
 * 发新版本前在 src/Versions.ts 最前面加一项，写清做了什么。
 *
 * 运行：bun scripts/Build_Release.ts [--skip_checks yes] [--runtime 运行时目录]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as serveProcess from './Serve_Process.ts';


/** updates/ 里留几个版本。 */
const KEEP_RELEASES = 3;


/**
 * 按文件名末尾的时间戳排（jmbots-server-<版本>-<时间>.exe），旧的在前。不能按整个文件名排：
 * “0.2.10” 按字母排在 “0.2.9” 前面，11-06 就这样把刚编好的 0.2.10 当成旧的删了。
 * @param left 文件名。
 * @param right 文件名。
 */
function byStamp(left: string, right: string): number {
  /** 取时间戳。 */
  const stamp = (name: string): string => /-(\d{14,})\.exe$/.exec(name)?.[1] ?? '';
  return stamp(left).localeCompare(stamp(right));
}

/** 打包的中间产物放哪（不动正在被托管的 dist/web）。 */
const WORK_DIR = path.join(serveProcess.ROOT, 'dist', 'release');

/** 这个平台可执行文件的后缀。 */
const EXE = process.platform === 'win32' ? '.exe' : '';


/**
 * 跑一步：失败就打印结尾的输出，退出。
 * @param name 这一步叫什么。
 * @param args bun 的参数。
 * @param env 多加的环境变量。
 * 副作用：跑子进程；失败时结束程序。
 */
function step(
  name: string,
  args: string[],
  env: Record<string, string> = {},
): void {
  /** 开始时间。 */
  const startedAt = Date.now();
  /** 结果。 */
  const command = [process.execPath, ...args];
  /** 子进程环境只在本次构建内生效。 */
  const options = {
    cwd: serveProcess.ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };
  const result = Bun.spawnSync(command, options);
  if (result.exitCode !== 0) {
    console.error(`${name} 没过，不发布。输出的结尾：\n${(result.stdout.toString() + result.stderr.toString()).slice(-6000)}`);
    process.exit(1);
  }
  console.log(`${name} 通过（${seconds(startedAt)} 秒）`);
}


/**
 * 从某个时刻到现在过了几秒，留一位小数。
 * @param startedAt 开始时间，毫秒。
 */
function seconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}


/**
 * 同时跑几步检查（用户 11-06：“把这件事情分成 N 块”）：各起一个进程，都跑完再看结果，每步打出用时。
 * @param steps 每步的名字和 bun 的参数。
 * @returns 没过的那几步：名字、参数、输出。
 * 副作用：跑子进程。
 */
interface BuildStep {
  /** 检查步骤名称。 */
  name: string;
  /** 传给 Bun 的参数。 */
  args: string[];
}

interface FailedStep extends BuildStep {
  /** 标准输出与错误输出。 */
  output: string;
}

async function parallelSteps(steps: BuildStep[]): Promise<FailedStep[]> {
  /** 各步的结果。 */
  const results = await Promise.all(
    steps.map(async (item) => {
      /** 这一步开始的时间。 */
      const startedAt = Date.now();
      /** 进程。 */
      const command = [process.execPath, ...item.args];
      const options = {
        cwd: serveProcess.ROOT,
        env: process.env,
        stdout: 'pipe' as const,
        stderr: 'pipe' as const,
      };
      const proc = Bun.spawn(command, options);
      /** 输出和退出码（两路输出同时读完，免得管道塞满卡住）。 */
      const stdoutTask = new Response(proc.stdout).text();
      const stderrTask = new Response(proc.stderr).text();
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutTask,
        stderrTask,
        proc.exited,
      ]);
      console.log(`${item.name} ${exitCode === 0 ? '通过' : '没过'}（${seconds(startedAt)} 秒）`);
      return {
        ...item,
        ok: exitCode === 0,
        output: stdout + stderr,
      };
    }),
  );
  return results.filter((result) => !result.ok);
}


/**
 * 一个目录下全部文件，相对路径用 /。
 * @param dir 目录。
 * @returns 相对路径。
 */
function walk(dir: string): string[] {
  const readOptions = {
    recursive: true,
    encoding: 'utf8' as const,
  };
  const entries = fs.readdirSync(dir, readOptions);
  const normalized = entries.map((item) => item.replaceAll('\\', '/'));
  return normalized.filter((item) => {
    const fullPath = path.join(dir, item);
    return fs.statSync(fullPath).isFile();
  });
}


/**
 * 路径写成 import 里能用的样子（反斜杠换成 /）。
 * @param file 路径。
 */
function importPath(file: string): string {
  return JSON.stringify(file.replaceAll('\\', '/'));
}


/**
 * 生成编译入口：先登记打包进去的文件，再跑 Main.ts（import 按顺序执行，所以分成两个文件）。
 * @param webDir 打包好的网页。
 * @returns 入口文件。
 * 副作用：写 dist/release/ 下两个文件。
 */
function writeEntry(webDir: string): string {
  /** 要打包进去的文件：相对路径 → 实际路径。 */
  const files: [string, string][] = [
    ...walk(webDir).map((item): [string, string] => [`web/${item}`, path.join(webDir, item)]),
    ...walk(path.join(serveProcess.ROOT, 'prompts'))
      .filter((item) => item.endsWith('.md') && path.basename(item) !== 'README.md')
      .map((item): [string, string] => [`prompts/${item}`, path.join(serveProcess.ROOT, 'prompts', item)]),
  ];
  /** 每项资源独立一行，便于检查生成的编译入口。 */
  const registrations = files.map(([name], index) => {
    return `  ${JSON.stringify(name)}: f${index},`;
  });
  const registrationText = registrations.join('\n');
  /** 登记的代码。 */
  const register = [
    `import * as embedded from ${importPath(path.join(serveProcess.ROOT, 'src', 'resources', 'Embedded.ts'))};`,
    ...files.map(([, file], index) => `import f${index} from ${importPath(file)} with { type: 'file' };`),
    `embedded.register({\n${registrationText}\n}, ${Date.now()});`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(WORK_DIR, 'Register.ts'), register);
  /** 入口。 */
  const entry = path.join(WORK_DIR, 'Entry.ts');
  fs.writeFileSync(entry, `import './Register.ts';\nimport ${importPath(path.join(serveProcess.ROOT, 'src', 'entries', 'Main.ts'))};\n`);
  return entry;
}


/** 发布。 */
async function main(): Promise<void> {
  /** 运行时目录。 */
  const runtime = serveProcess.runtimeDir();
  //M 1. 检查：三块同时跑。
  if (serveProcess.option('skip_checks', 'no') !== 'yes') {
    /** 检查开始的时间。 */
    const startedAt = Date.now();
    /** 本轮同时运行的三个检查。 */
    const checks = [
      {
        name: 'typecheck',
        args: ['run', 'typecheck'],
      },
      {
        name: 'lint',
        args: ['run', 'lint'],
      },
      {
        name: '测试',
        args: ['test', './tests'],
      },
    ];
    /** 没过的。 */
    const failed = await parallelSteps(checks);
    /** 测试以外没过的：照实报，不发布。 */
    const hard = failed.filter((item) => item.name !== '测试');
    for (const item of hard) {
      console.error(`${item.name} 没过，不发布。输出的结尾：\n${item.output.slice(-6000)}`);
    }
    if (hard.length > 0) {
      process.exit(1);
    }
    //G 只有测试没过：同时跑时机器忙，卡时间的几条可能超时，单独再跑一次，还不过才算没过（step 没过就结束程序）。
    if (failed.length > 0) {
      console.log('测试和别的检查同时跑时没过，单独再跑一次……');
      step('测试（单独重跑）', ['test', './tests']);
    }
    console.log(`检查一共 ${seconds(startedAt)} 秒`);
  }
  //M 2. 打包网页、生成入口、编译。
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  /** 打包好的网页。 */
  const webDir = path.join(WORK_DIR, 'web');
  const webArgs = [path.join(serveProcess.ROOT, 'web', 'Build.ts')];
  const webEnvironment = {
    JMBOTS_WEB_OUT: webDir,
  };
  step('打包网页', webArgs, webEnvironment);
  /** 编译出来的程序。 */
  const built = path.join(WORK_DIR, `jmbots-server${EXE}`);
  const entryFile = writeEntry(webDir);
  const buildArgs = ['build', '--compile', entryFile, '--outfile', built];
  step('编译', buildArgs);
  //M 3. 编译出来的能跑，才放进去：打印版本认得出来才算。
  /** 版本。 */
  const versionArgs = [built, 'version'];
  const versionOptions = {
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };
  const check = Bun.spawnSync(versionArgs, versionOptions);
  if (check.exitCode !== 0) {
    console.error(`编译出来的程序跑不起来，不发布：${check.stderr.toString().slice(-2000)}`);
    process.exit(1);
  }
  /** 版本号。 */
  const { version } = JSON.parse(check.stdout.toString()) as { version: string };
  /** updates/ 文件夹。 */
  const updates = path.join(runtime, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  /** 放进去的文件。 */
  const target = path.join(updates, `jmbots-server-${version}-${serveProcess.timeId()}${EXE}`);
  //M 先写临时文件再改名：基地不会扫到半截的。
  fs.copyFileSync(built, `${target}.tmp`);
  fs.renameSync(`${target}.tmp`, target);
  //M 4. 只留最近几个。
  /** 只清理已完成的旧更新包，临时写入文件不参与排序。 */
  const updateFiles = fs.readdirSync(updates);
  const completed = updateFiles.filter((name) => {
    return name.startsWith('jmbots-server-') && !name.endsWith('.tmp');
  });
  const oldest = completed.sort(byStamp).slice(0, -KEEP_RELEASES);
  for (const old of oldest) {
    fs.rmSync(path.join(updates, old), { force: true });
  }
  console.log(`已发布 ${version}：${target}\n基地发现后会提醒用户，用户点更新才换。`);
}


await main();
