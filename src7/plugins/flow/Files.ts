/**
 * 快照写成文件，重启后也看得到（0.7.15）。目录是 <运行时目录>/data/flow/：
 *   启动：boot-trail 记完最后一步（HTTP 开始监听）、发 boot-trail/done 后写 boot.json，每次启动覆盖；
 *   带快照关键词的消息：State.ts 的 Shots 停拍时交来，写 <消息号>.json，同一条再写就覆盖；
 *   消息文件只留最近 keep 个（flow 配置 snapshot_files），多了删最旧的；boot.json 不算在内。
 * 内容是 /api/flow/trail（启动是 /api/flow/boot）的轨迹，加每步 /api/flow/snapshot 交的那份（快照、和上一步的 diff），notes 在轨迹里。
 * 写放后台：setTimeout 推到这一轮事件之后（journal 先把这一行记完），异步写，出错只打一行日志，不挡回复。
 */
import type * as cordis from 'cordis';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as snapshotModule from '../../utils/Snapshot.ts';
import * as textModule from '../../utils/Text.ts';
import type { Shots } from './State.ts';
import { TRAIL_MAX_LINES, bootTrailOf, pick, trailOf, type Trail, type TrailLine, type TrailStep } from './Trail.ts';


/** journal 服务这里用到的样子，不 import journal 插件。 */
export interface JournalLike {
  /** GET /api/events 那个查法：flow 用它找最近收下的消息。 */
  query(params: Record<string, string | undefined>): TrailLine[];
  /** 一条请求的行（从 web-api/received 那行起往后，还没挑），web-api 的回话追溯也调它；没有这条是 undefined。 */
  request(message: number, limit: number): TrailLine[] | undefined;
}


/** boot-trail 服务的样子，不 import boot-trail 插件。 */
export interface BootTrailLike {
  lines(): Promise<TrailLine[]>;
  /** 每个插件挂上时多出的服务、工具（boot-trail 的 provided()），总览图画边用。 */
  provided?(): { name: string; services: string[]; tools: string[] }[];
  /** 关键变量的说明表：英文键 → 中文解释。 */
  notes?: Record<string, string>;
  /** lines() 里第 id 行那一步拍的快照；只有快照要用，测试里可以不给。 */
  snapshot?(id: number): Taken | undefined;
  /** 读源码的那一套（boot-trail/Source.ts 的 SourceDocs）：/api/flow/source 用它的 sourceOf 取函数源码，原样交给页面。 */
  source?: { sourceOf(file: string, line: number): Promise<object | undefined> };
}


/** 一行拍下的那份：什么时刻、运行时变量。 */
export interface Taken {
  /** 毫秒时间戳。 */
  at: number;
  /** 这一刻的运行时变量。 */
  groups: snapshotModule.StateGroup[];
}


/** 一步的快照：/api/flow/snapshot 交的样子。 */
export interface StepShot {
  /** 这一步最后一行拍的时刻。 */
  at: number;
  /** 第几步，从 1 起。 */
  no: number;
  /** 图上的点。 */
  node: string;
  /** 这一刻的运行时变量。 */
  groups: snapshotModule.StateGroup[];
  /** 比上一步变了的路径；前面没有可比的是 null。 */
  changed: string[][] | null;
}


/** 启动那份的文件名；不算在消息文件的个数里。 */
const BOOT_FILE = 'boot.json';

/** 消息文件：消息号.json。 */
const MESSAGE_FILE = /^\d+\.json$/;


/**
 * 第 no 步的快照：这一步最后一行拍的那份，和上一步最后一行拍的那份比。每步几行照 steps 的先后数。
 * @param steps stepsOf 收好的步。
 * @param taken 和这些步的行按先后一一对应的快照。
 * @param no 第几步，从 1 起。
 * @returns 没有这一步、这一步一份都没拍到是 undefined。
 */
export function stepShot(steps: TrailStep[], taken: (Taken | undefined)[], no: number): StepShot | undefined {
  const step = steps[no - 1];
  if (step === undefined) return undefined;

  const first = steps.slice(0, no - 1).reduce((sum, item) => sum + item.rows.length, 0);
  const after = taken.slice(first, first + step.rows.length).filter((shot) => shot !== undefined).at(-1);
  const before = taken.slice(0, first).filter((shot) => shot !== undefined).at(-1);
  if (after === undefined) return undefined;

  const record = (groups: snapshotModule.StateGroup[]) => Object.fromEntries(groups.map((item) => [item.name, item.value]));
  const changed = before === undefined ? null : snapshotModule.diffOf(record(before.groups), record(after.groups));
  return { at: after.at, no, node: step.node, groups: after.groups, changed };
}


/** 写进文件的：轨迹，加每步的快照（和 steps 一一对应，没拍到的是 null）。 */
export interface FlowFile extends Trail {
  /** 每步 /api/flow/snapshot 交的那份。 */
  snapshots: (StepShot | null)[];
}


/** 把启动、带关键词的消息的快照写进 <运行时目录>/data/flow/。 */
export class FlowFiles {
  /** 写到哪个目录。 */
  readonly dir: string;

  /**
   * @param ctx flow 的 ctx：现取 journal、bootTrail，按 resources.root 算目录。
   * @param keep 消息文件留几个（flow 配置 snapshot_files），apply 校验过是正整数。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly keep: number,
  ) {
    this.dir = path.join(ctx.resources.root, 'data', 'flow');
  }

  /** 启动走完（boot-trail/done）后调：后台写 boot.json。 */
  boot(): void {
    this.later(BOOT_FILE, () => this.bootFile());
  }

  /**
   * 一条带关键词的消息停拍时调（State.ts 的 Shots）：后台写 <消息号>.json，再删多出来的旧文件。
   * @param message 消息号。
   * @param shots 拍下这条的 Shots，对行用。
   */
  message(message: number, shots: Shots): void {
    this.later(`${String(message)}.json`, () => this.messageFile(message, shots));
  }

  /**
   * 推到这一轮事件之后再写；出错只打一行日志。
   * @param file 文件名。
   * @param build 拼内容：bootFile 或 messageFile。
   */
  private later(file: string, build: () => Promise<FlowFile>): void {
    setTimeout(() => {
      this.write(file, build).catch((error: unknown) => {
        console.error(`flow 写 ${file} 没写成：${textModule.messageOf(error)}`);
      });
    }, 0);
  }

  /**
   * 拼好、写下；写的是消息文件就删多出来的旧的。
   * @param file 文件名。
   * @param build 拼内容。
   */
  private async write(file: string, build: () => Promise<FlowFile>): Promise<void> {
    const content = await build();
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(path.join(this.dir, file), JSON.stringify(content), 'utf8');
    if (file !== BOOT_FILE) await this.prune();
  }

  /** 启动的轨迹加每步快照：和 /api/flow/boot 加每步 /api/flow/snapshot?message=0 一样。 */
  private async bootFile(): Promise<FlowFile> {
    const boot = this.ctx.get('bootTrail') as BootTrailLike | undefined;
    if (boot?.snapshot === undefined) throw new Error('没挂 boot-trail 插件（或版本太旧），没有启动的快照');

    const lines = await boot.lines();
    const taken = lines.map((line) => boot.snapshot?.(line.id));
    return withShots(bootTrailOf(lines, boot.notes), taken);
  }

  /**
   * 一条消息的轨迹加每步快照：和 /api/flow/trail 加每步 /api/flow/snapshot 一样。
   * 取不到时直接抛：调它的 write 是 async，抛出来算 write 的失败，later 打日志。
   * @param message 消息号。
   * @param shots 拍下这条的 Shots。
   */
  private messageFile(message: number, shots: Shots): Promise<FlowFile> {
    const journal = this.ctx.get('journal') as JournalLike | undefined;
    if (journal === undefined) throw new Error('没挂 journal 插件，对不上请求轨迹');

    const raw = journal.request(message, TRAIL_MAX_LINES);
    if (raw === undefined) throw new Error(`跟踪行里没有消息 ${String(message)}`);

    const taken = shots.match(pick(message, raw).picked);
    return Promise.resolve(withShots(trailOf(message, raw), taken));
  }

  /** 消息文件多于 keep 个：按改动时刻删最旧的（同一时刻按消息号小的先删）。 */
  private async prune(): Promise<void> {
    const names = (await fs.promises.readdir(this.dir)).filter((name) => MESSAGE_FILE.test(name));
    if (names.length <= this.keep) return;

    const dated = await Promise.all(names.map(async (name) => {
      const stat = await fs.promises.stat(path.join(this.dir, name));
      return { name, at: stat.mtimeMs, no: Number.parseInt(name, 10) };
    }));
    dated.sort((a, b) => a.at - b.at || a.no - b.no);
    for (const item of dated.slice(0, dated.length - this.keep)) {
      await fs.promises.rm(path.join(this.dir, item.name), { force: true });
    }
  }
}


/**
 * 轨迹加每步快照。
 * @param trail trailOf 或 bootTrailOf 收好的轨迹。
 * @param taken 和轨迹的行按先后一一对应的快照。
 */
function withShots(trail: Trail, taken: (Taken | undefined)[]): FlowFile {
  const snapshots = trail.steps.map((_step, index) => stepShot(trail.steps, taken, index + 1) ?? null);
  return { ...trail, snapshots };
}
