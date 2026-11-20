/**
 * 快照写成文件，重启后也看得到；教程页左栏「画布」就是这里的文件，一个文件一项。目录是 <运行时目录>/data/flow/：
 *   启动：Boot.ts 记完最后一步（HTTP 开始监听）后写 boot.json，每次启动覆盖；
 *   带快照关键词的消息：State.ts 的 Shots 停拍时交来，写 <消息号>.json，同一条再写就覆盖；
 *   消息文件只留最近 keep 个（tutorial 配置 snapshot_files），多了删最旧的；boot.json 不算在内。
 * 内容是轨迹（journal/Trail.ts 收好的），加每步的快照（和上一步的 diff），notes 在轨迹里。
 * 写放后台：setTimeout 推到这一轮事件之后（journal 先把这一行记完），异步写，出错只打一行日志，不挡回复。
 */
import type * as cordis from 'cordis';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as snapshotModule from './Snapshot.ts';
import * as textModule from '../../utils/Text.ts';
import type * as bootModule from './Boot.ts';
import type * as stateModule from './State.ts';
import type * as trailModule from '../../utils/Trail.ts';


/** 向 journal 要一条消息的轨迹时，筛完消息和相关会话后最多取几行。 */
export const TRAIL_MAX_LINES = 800;

/** 一行拍下的那份：什么时刻、运行时变量。 */
export interface Taken {
  /** 毫秒时间戳。 */
  at: number;
  /** 这一刻的运行时变量。 */
  groups: snapshotModule.StateGroup[];
}


/** 一步的快照：页面点中一步时拿到的样子。 */
export interface StepShot {
  /** 这一步最后一行拍的时刻。 */
  at: number;
  /** 第几步，从 1 起。 */
  no: number;
  /** 泳道图上的道。 */
  node: string;
  /** 这一刻的运行时变量。 */
  groups: snapshotModule.StateGroup[];
  /** 比上一步变了的路径；前面没有可比的是 null。 */
  changed: string[][] | null;
}


/** 写进文件的：轨迹，加每步的快照（和 steps 一一对应，没拍到的是 null）。 */
export interface FlowFile extends trailModule.Trail {
  /** 每步的快照。 */
  snapshots: (StepShot | null)[];
}


/** 左栏「画布」的一项：一个文件。 */
export interface CanvasItem {
  /** boot，或消息号。 */
  name: string;
  /** 文件最后写的时刻，毫秒时间戳。 */
  at: number;
  /** 用户那句话（从文件开头读出来的）；启动是空串。 */
  preview: string;
  /** 渠道名（从文件开头顺带提取，便于左栏显示渠道徽标与搜索）。 */
  channel?: string;
  /** 机器人名（从文件开头顺带提取）。 */
  bot?: string;
}


/** 启动那份的文件名；不算在消息文件的个数里。 */
const BOOT_FILE = 'boot.json';

/** 消息文件：消息号.json。 */
const MESSAGE_FILE = /^\d+\.json$/u;

/** 读文件开头多少字节找 preview：轨迹的键是 message、session、bot、channel、preview 这个先后，preview 在很前面。 */
const HEAD_BYTES = 8192;


/**
 * 第 no 步的快照：这一步最后一行拍的那份，和上一步最后一行拍的那份比。每步几行照 steps 的先后数。
 * @param steps getSteps 收好的步。
 * @param taken 和这些步的行按先后一一对应的快照。
 * @param no 第几步，从 1 起。
 * @returns 没有这一步、这一步一份都没拍到是 undefined。
 */
export function getStepShot(steps: trailModule.TrailStep[], taken: (Taken | undefined)[], no: number): StepShot | undefined {
  const step = steps[no - 1];
  if (step === undefined) return undefined;

  //M 这一步的行在 taken 里从哪起：前面各步的行数加起来。
  const first = steps.slice(0, no - 1).reduce((sum, item) => sum + item.rows.length, 0);
  const mine = taken.slice(first, first + step.rows.length).filter((shot) => shot !== undefined);
  const after = mine.at(-1);
  if (after === undefined) return undefined;

  //M 和上一步最后一份比；前面一份都没有就是 null。
  const earlier = taken.slice(0, first).filter((shot) => shot !== undefined);
  const before = earlier.at(-1);
  let changed: string[][] | null = null;
  if (before !== undefined) {
    const beforeRecord = getRecord(before.groups);
    const afterRecord = getRecord(after.groups);
    changed = snapshotModule.getDiff(beforeRecord, afterRecord);
  }
  return { at: after.at, no, node: step.node, groups: after.groups, changed };
}


/**
 * 一份快照摆成“组名 → 值”，比差异用。
 * @param groups 各组。
 */
function getRecord(groups: snapshotModule.StateGroup[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const item of groups) {
    record[item.name] = item.value;
  }
  return record;
}


/**
 * 轨迹加每步快照。
 * @param trail getTrail 或 getBootTrail 收好的轨迹。
 * @param taken 和轨迹的行按先后一一对应的快照。
 */
function addShots(trail: trailModule.Trail, taken: (Taken | undefined)[]): FlowFile {
  const snapshots: (StepShot | null)[] = [];
  //M 按轨迹步数逐一配对每步最后一次快照与前一步变化路径，没拍到则记 null。
  for (const step of trail.steps) {
    const shot = getStepShot(trail.steps, taken, step.no);
    snapshots.push(shot ?? null);
  }
  return { ...trail, snapshots };
}


/** 把启动、带关键词的消息的快照写进 <运行时目录>/data/flow/，也给教程页读回来。 */
export class FlowFiles {
  /** 写到哪个目录。 */
  readonly dir: string;

  /** 最近读过的一个文件：点同一张画布的不同步时不用每次重读。 */
  private cached: { name: string; mtime: number; file: FlowFile } | undefined;

  /**
   * @param ctx tutorial 的 ctx：现取 journal，按 resources.root 算目录。
   * @param keep 消息文件留几个（tutorial 配置 snapshot_files），apply 校验过是正整数。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly keep: number,
  ) {
    this.dir = path.join(ctx.resources.root, 'data', 'flow');
  }

  /**
   * 启动走完（Boot.ts 记完 HTTP 监听那步）后调：后台写 boot.json。
   * @param boot 录下这次启动的 BootTrail。
   */
  writeBoot(boot: bootModule.BootTrail): void {
    //M 推迟到当前事件循环之后后台整理并写盘，避免阻塞启动流程。
    this.later(BOOT_FILE, () => this.getBootFile(boot));
  }

  /**
   * 一条带关键词的消息停拍时调（State.ts 的 Shots）：后台写 <消息号>.json，再删多出来的旧文件。
   * @param message 消息号。
   * @param shots 拍下这条的 Shots，对行用。
   */
  writeMessage(message: number, shots: stateModule.Shots): void {
    //M 按消息号命名文件并在下一轮事件循环异步写出快照。
    const file = `${String(message)}.json`;
    this.later(file, () => this.getMessageFile(message, shots));
  }

  /**
   * 左栏「画布」：目录里的 boot.json 和消息文件，启动在最前，消息新的在前。
   * @returns 目录还没有是空的。
   */
  async getList(): Promise<CanvasItem[]> {
    //G 还没写过任何文件：目录不在。
    if (!fs.existsSync(this.dir)) return [];

    const names = await fs.promises.readdir(this.dir);
    const items: CanvasItem[] = [];
    for (const name of names) {
      const isBoot = name === BOOT_FILE;
      if (!isBoot && !MESSAGE_FILE.test(name)) continue;

      const full = path.join(this.dir, name);
      const stat = await fs.promises.stat(full);
      const item: CanvasItem = { name: name.replace(/\.json$/u, ''), at: stat.mtimeMs, preview: '' };
      if (!isBoot) {
        //M 消息快照只读文件头部摘出用户预览话术、渠道与机器人名，避免整文件反序列化。
        const meta = await this.getHeadMeta(full);
        item.preview = meta.preview;
        if (meta.channel !== '') {
          item.channel = meta.channel;
        }
        if (meta.bot !== '') {
          item.bot = meta.bot;
        }
      }
      items.push(item);
    }

    //M 排：boot 最前，消息按写的时刻新的在前。
    items.sort((a, b) => {
      if (a.name === 'boot') return -1;
      if (b.name === 'boot') return 1;
      return b.at - a.at;
    });
    return items;
  }

  /**
   * 读一张画布的文件。
   * @param name boot 或消息号；调用方校验过只有这两种样子。
   * @returns 没有这个文件是 undefined。
   */
  async getFile(name: string): Promise<FlowFile | undefined> {
    const full = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(full)) return undefined;

    //M 文件没改过就用上次读的。
    const stat = await fs.promises.stat(full);
    const cached = this.cached;
    if (cached !== undefined && cached.name === name && cached.mtime === stat.mtimeMs) return cached.file;

    const text = await fs.promises.readFile(full, 'utf8');
    const file = JSON.parse(text) as FlowFile;
    this.cached = { name, mtime: stat.mtimeMs, file };
    return file;
  }

  /**
   * 问 journal 要一条消息的轨迹（journal/Trail.ts 收好的），供画布、预览和文件快照共用。
   * @param message 收件表的消息号。
   * @param maxLines 筛出这条消息和相关会话后最多取几行。
   * @returns 轨迹和挑出的行（对快照用）；跟踪行里没有、journal 没挂或没应答是 undefined。
   */
  async getMessageTrail(
    message: number,
    maxLines: number,
  ): Promise<{ trail: trailModule.Trail; picked: trailModule.TrailLine[] } | undefined> {
    const request = { action: 'trail', message, maxLines } as const;
    //M 通过事件请求轨迹，未收到轨迹时继续用磁盘或空摘要。
    const result = await requestEventModule.requestEvent(this.ctx, 'journal/request', 'journal/result', request);
    const reply = result.reply;
    if (reply?.trail === undefined || reply.picked === undefined) return undefined;

    return { trail: reply.trail, picked: reply.picked };
  }

  /**
   * 问 journal 把启动行收成启动轨迹（消息号 0，和请求轨迹同一个格式）。
   * @param lines 启动录下的行（boot.getLines()）。
   * @param notes 关键变量的说明表（boot.notes）。
   * @returns 启动轨迹。
   * @throws journal 没有交回启动轨迹时抛。
   */
  async getBootTrail(lines: trailModule.TrailLine[], notes: Record<string, string>): Promise<trailModule.Trail> {
    const request = { action: 'boot-trail', lines, notes } as const;
    //M 启动文件和画布都用 journal 整理好的轨迹。
    const result = await requestEventModule.requestEvent(this.ctx, 'journal/request', 'journal/result', request);
    const trail = result.reply?.trail;
    if (trail === undefined) throw new Error('journal 没有交回启动轨迹');

    return trail;
  }

  /**
   * 文件里用户那句话、渠道、机器人：只读开头 HEAD_BYTES 字节，不把整份（可能几十 MB 的快照）读进来。
   * @param full 文件的完整路径。
   * @returns preview/channel/bot；找不到是空串。
   */
  private async getHeadMeta(full: string): Promise<{ preview: string; channel: string; bot: string }> {
    const handle = await fs.promises.open(full, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    //M 只读文件前 HEAD_BYTES 字节后立即关闭句柄，提取元信息不占用整份大文件内存。
    const read = await handle.read(buffer, 0, HEAD_BYTES, 0);
    await handle.close();

    //M 找到的是一段 JSON 字符串（带引号和转义），交给 JSON.parse 还原。
    const head = buffer.subarray(0, read.bytesRead).toString('utf8');
    return {
      preview: this.readHeadString(head, 'preview'),
      channel: this.readHeadString(head, 'channel'),
      bot: this.readHeadString(head, 'bot'),
    };
  }

  /**
   * 从文件头部片段里按 `"key":"..."` 摘出 JSON 字符串字段。
   * @param head 开头字符串片段。
   * @param key 字段名。
   */
  private readHeadString(head: string, key: string): string {
    const found = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`, 'u').exec(head);
    const quoted = found?.[1];
    if (quoted === undefined) return '';

    return JSON.parse(quoted) as string;
  }

  /**
   * 推到这一轮事件之后再写；出错只打一行日志。
   * @param file 文件名。
   * @param build 拼内容：getBootFile 或 getMessageFile。
   */
  private later(file: string, build: () => Promise<FlowFile>): void {
    setTimeout(() => {
      //M 后台落盘失败时用 textModule 收束出错原因，只记日志不向上抛。
      this.write(file, build).catch((error: unknown) => {
        const reason = textModule.getErrorMessage(error);
        console.error(`tutorial 写 ${file} 没写成：${reason}`);
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
    const json = JSON.stringify(content);
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(path.join(this.dir, file), json, 'utf8');
    if (file === BOOT_FILE) return;

    //M 消息快照受保留数量限制，写完新文件后顺手清理最旧的消息快照。
    await this.prune();
  }

  /**
   * 启动的轨迹加每步快照。
   * @param boot 录下这次启动的 BootTrail。
   */
  private async getBootFile(boot: bootModule.BootTrail): Promise<FlowFile> {
    //M 读取全部启动轨迹行并对齐各行快照，合并成可独立回看的启动文件。
    const lines = await boot.getLines();
    const taken = lines.map((line) => boot.getSnapshot(line.id));
    const trail = await this.getBootTrail(lines, boot.notes);
    return addShots(trail, taken);
  }

  /**
   * 一条消息的轨迹加每步快照。取不到时直接抛：调它的 write 是 async，抛出来算 write 的失败，later 打日志。
   * @param message 消息号。
   * @param shots 拍下这条的 Shots。
   */
  private async getMessageFile(message: number, shots: stateModule.Shots): Promise<FlowFile> {
    //M 只有取得轨迹才生成新快照，查不到就保留已有文件。
    const got = await this.getMessageTrail(message, TRAIL_MAX_LINES);
    if (got === undefined) throw new Error(`跟踪行里没有消息 ${String(message)}`);

    //M journal 挑出的行逐行对回内存快照，再与轨迹的步配对打包。
    const taken = shots.getMatched(got.picked);
    return addShots(got.trail, taken);
  }

  /** 消息文件多于 keep 个：按改动时刻删最旧的（同一时刻按消息号小的先删）。 */
  private async prune(): Promise<void> {
    const all = await fs.promises.readdir(this.dir);
    const names = all.filter((name) => MESSAGE_FILE.test(name));
    if (names.length <= this.keep) return;

    //M 每个文件的改动时刻和消息号，旧的排前面。
    const dated: { name: string; at: number; no: number }[] = [];
    for (const name of names) {
      const stat = await fs.promises.stat(path.join(this.dir, name));
      dated.push({ name, at: stat.mtimeMs, no: Number.parseInt(name, 10) });
    }
    dated.sort((a, b) => a.at - b.at || a.no - b.no);

    //M 删掉多出来的那几个。
    const extra = dated.slice(0, dated.length - this.keep);
    for (const item of extra) {
      await fs.promises.rm(path.join(this.dir, item.name), { force: true });
    }
  }
}
