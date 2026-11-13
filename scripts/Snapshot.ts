/**
 * 版本快照：把当前这份能跑的源码留一份副本，看门狗发现新代码起不来时拿它顶上。
 *
 * 为什么不用 git 回退（用户 11-03 说 git 那边他自己管）：看门狗可能在半夜动手，而工作区同时有
 * Claude、周小灵和用户在改文件；自动 checkout 会和正在进行的编辑打架。所以这里只往 `bak/versions/`
 * 里拷副本，一个字节都不碰工作区；每份快照记下它对应的 git 提交号，用户要用 git 回退时有准确依据。
 *
 * 快照只装服务跑起来要的东西（约 1.8 MB 一份）：src、
 * package.json、tsconfig.json。依赖不拷：快照在 `bak/versions/` 下，
 * 往上找 node_modules 正好找到项目根的那份（bak 下面没有 node_modules，已核实）。
 * `bak/` 不进 git、不进 typecheck 和 lint，所以快照不会污染检查。
 */
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as serveProcess from './Serve_Process.ts';


/** 快照都放这儿。 */
export const VERSIONS_DIR = path.join(serveProcess.ROOT, 'bak', 'versions');

/** 留最近几份，多的删掉。 */
const KEEP = 5;

/** 每份快照里要拷的东西（相对项目根；不存在的跳过）。 */
const CONTENTS = ['src', 'package.json', 'tsconfig.json'];

/** 快照自己的说明文件名。 */
const INFO_FILE = '版本.json';


/** 一份快照。 */
export interface Version {
  /** 快照 ID，就是目录名（17 位时间加 3 位随机数字）。 */
  id: string;
  /** 快照目录的绝对路径，可以直接当起服务的代码目录。 */
  dir: string;
  /** 存下来的时间，北京时间的可读写法。 */
  savedAt: string;
  /** 对应的 git 提交号（短号）；拿不到时是空字符串。 */
  commit: string;
  /** 存的时候工作区有没有没提交的改动：有的话这份快照和那个提交号并不完全一样。 */
  dirty: boolean;
  /** 这一版在正式端口上健康跑了多久才被存下来，秒。 */
  healthySeconds: number;
}


/** 从哪儿拷、存到哪儿；平时都用默认值，测试用临时目录。 */
export interface Places {
  /** 快照目录；默认 VERSIONS_DIR。 */
  versionsDir?: string;
  /** 从哪份代码拷；默认项目根。 */
  root?: string;
}


/**
 * 问 git 当前的提交号和工作区干不干净。
 * @param root 在哪个目录下问。
 * @returns 提交号（拿不到时空字符串）和是否有未提交改动。
 */
function readGitState(root: string): { commit: string; dirty: boolean } {
  /**
   * 跑一条 git 命令取输出。
   * @param args git 的参数。
   */
  const git = (args: string[]): string => {
    /** 结果。 */
    const result = child.spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
  };
  return { commit: git(['rev-parse', '--short', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 };
}


/**
 * 列出已有的快照，新的在前。
 * @param versionsDir 快照目录；默认 VERSIONS_DIR。
 * @returns 每份快照的说明；读不出说明的目录跳过。
 */
export function list(versionsDir: string = VERSIONS_DIR): Version[] {
  if (!fs.existsSync(versionsDir)) {
    return [];
  }
  /** 所有快照。 */
  const versions: Version[] = [];
  for (const name of fs.readdirSync(versionsDir)) {
    /** 说明文件。 */
    const infoFile = path.join(versionsDir, name, INFO_FILE);
    if (!fs.existsSync(infoFile)) {
      //G 没有说明文件的目录可能是上次拷到一半断掉的，不当成能用的版本。
      continue;
    }
    try {
      versions.push(JSON.parse(fs.readFileSync(infoFile, 'utf8')) as Version);
    } catch {
      //G 说明文件坏了，当它不存在。
    }
  }
  return versions.sort((left, right) => right.id.localeCompare(left.id));
}


/**
 * 取最近一份快照。
 * @param skipIds 跳过这些 ID（已经试过、起不来的那几份）。
 * @param versionsDir 快照目录；默认 VERSIONS_DIR。
 * @returns 最近的一份；没有可用的就是 undefined。
 */
export function latest(skipIds: string[] = [], versionsDir: string = VERSIONS_DIR): Version | undefined {
  return list(versionsDir).find((version) => !skipIds.includes(version.id));
}


/**
 * 把当前工作区的源码存成一份快照，并把超出 KEEP 份的老快照删掉。
 * @param id 快照 ID，调用方给（和服务日志用同一套时间 ID）。
 * @param healthySeconds 这一版在正式端口上已经健康跑了多少秒，写进说明备查。
 * @param places 从哪儿拷、存到哪儿；平时不用传。
 * @returns 存好的那份快照。
 * @throws 拷贝失败时抛出；调用方自己决定要不要只记一条日志继续。
 */
export function save(id: string, healthySeconds: number, places: Places = {}): Version {
  /** 快照目录。 */
  const versionsDir = places.versionsDir ?? VERSIONS_DIR;
  /** 从哪份代码拷。 */
  const root = places.root ?? serveProcess.ROOT;
  /** 这份快照的目录。 */
  const dir = path.join(versionsDir, id);
  //M 先拷到带 .tmp 的目录，拷完再改名，免得看门狗读到拷了一半的版本。
  /** 拷贝中的临时目录。 */
  const tempDir = `${dir}.tmp`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  for (const item of CONTENTS) {
    /** 源路径。 */
    const from = path.join(root, item);
    if (!fs.existsSync(from)) {
      //G 不存在的跳过，不让整份快照失败。
      continue;
    }
    /** 目标路径。 */
    const to = path.join(tempDir, item);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
  /** git 状态。 */
  const gitState = readGitState(root);
  /** 这份快照的说明。 */
  const version: Version = {
    id,
    dir,
    savedAt: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }),
    commit: gitState.commit,
    dirty: gitState.dirty,
    healthySeconds,
  };
  fs.writeFileSync(path.join(tempDir, INFO_FILE), `${JSON.stringify(version, undefined, 2)}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tempDir, dir);

  //M 清掉多余的老快照（只删快照目录下自己建的目录）。
  for (const old of list(versionsDir).slice(KEEP)) {
    fs.rmSync(path.join(versionsDir, old.id), { recursive: true, force: true });
  }
  return version;
}
