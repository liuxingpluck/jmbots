/**
 * 记忆库索引的定时刷新：跟着库目录里的文件改动，让基地重新摄取、重建 RAG 索引。照 0.4 IndexRefresher（src/capabilities/Context.ts:491-648）。
 * 启动 1 分钟后整轮刷一次，之后每 30 分钟一次；平时每 5 秒看一次库目录的“指纹”，变了又稳住一轮、离上次刷新过了 1 分钟，就只刷这个库。
 * 基地没开、没配都跳过，不挡会话。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import * as recall from './Recall.ts';


/** 启动后多久第一次整轮刷新。 */
const FIRST_REFRESH_MS = 60_000;

/** 整轮刷新的间隔。 */
const REFRESH_MS = 30 * 60_000;

/** 平时看指纹的间隔（最小值；扫得慢就拉长）。 */
const SCAN_MS = 5000;

/** 同一个库两次刷新至少隔多久。 */
const GAP_MS = 60_000;

/** 扫一遍用时的几倍当下次间隔。 */
const SCAN_SLOWDOWN = 10;

/** 库里文件比这多就不扫指纹（只等整轮刷新）。 */
const SCAN_MAX_FILES = 10_000;

/** 扫指纹时跳过的文件夹（还跳过点开头的）。 */
const SCAN_SKIP = new Set(['node_modules', 'target', 'dist', '__pycache__']);

/** 等摄取做完时多久问一次。 */
const POLL_MS = 5000;

/** 等摄取最多多久。 */
const INGEST_WAIT_MS = 30 * 60_000;


/** 一个库的观察记录。 */
interface Watch {
  root?: string;
  refreshed?: string;
  last?: string;
  refreshedAt: number;
}


/**
 * 一个文件夹的指纹：文件数、最晚修改时间、修改时间和、大小和。
 * @param root 文件夹。
 * @returns 文件太多、读不了是 undefined。
 */
async function stamp(root: string): Promise<string | undefined> {
  const dirs = [root];
  let [count, mtimes, sizes, latest] = [0, 0, 0, 0];
  try {
    for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SCAN_SKIP.has(entry.name)) dirs.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        count += 1;
        if (count > SCAN_MAX_FILES) return undefined;
        const info = await fs.stat(full).catch(() => undefined);
        mtimes += info?.mtimeMs ?? 0;
        sizes += info?.size ?? 0;
        latest = Math.max(latest, info?.mtimeMs ?? 0);
      }
    }
  } catch {
    return undefined;
  }
  return `${String(count)}:${String(latest)}:${String(mtimes)}:${String(sizes)}`;
}


/** 记忆库索引刷新器。 */
export class Libs {
  private readonly watches = new Map<string, Watch>();
  private roundAt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param ctx 插件的 ctx（发跟踪用）。
   * @param base 基地地址和库。
   * @param pollMs 等摄取时多久问一次（测试可调小）。
   */
  constructor(private readonly ctx: cordis.Context, private readonly base: recall.Base, private readonly pollMs = POLL_MS) {}

  /** 开始：1 分钟后第一次整轮刷新。 */
  start(firstMs = FIRST_REFRESH_MS): void {
    this.stopped = false;
    this.timer = setTimeout(() => this.loop(), firstMs);
  }

  /** 停：拔插件时调。 */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** 一轮：做完按用时排下一轮。 */
  private loop(): void {
    void this.tick()
      .catch((error: unknown) => {
        this.report([`刷新出错：${textModule.getMessage(error)}`]);
        return 0;
      })
      .then((cost) => {
        if (!this.stopped) this.timer = setTimeout(() => this.loop(), Math.max(SCAN_MS, cost * SCAN_SLOWDOWN));
      });
  }

  /** @returns 这一轮扫指纹用了多久。 */
  private async tick(): Promise<number> {
    const names = this.names();
    if (this.roundAt === 0 || Date.now() - this.roundAt >= REFRESH_MS) {
      await this.round(names);
      return 0;
    }

    let cost = 0;
    for (const name of names) {
      const watch = this.watches.get(name);
      if (watch?.root === undefined) continue;

      const began = Date.now();
      const now = await stamp(watch.root);
      cost += Date.now() - began;

      //M 指纹变了、而且和上一轮一样（稳住了），离上次刷新过了 1 分钟 → 只刷这个库。
      const settled = now !== undefined && now !== watch.refreshed && now === watch.last;
      if (settled && Date.now() - watch.refreshedAt >= GAP_MS) {
        watch.refreshed = now;
        watch.refreshedAt = Date.now();
        this.report(await this.refresh([name]));
      }
      watch.last = now;
    }
    return cost;
  }

  /** 整轮：问基地 /health 拿各库的根目录，记下指纹，全部刷一遍。 */
  private async round(names: string[]): Promise<void> {
    this.roundAt = Date.now();
    //M 基地不可用就结束本轮，不继续摄取、不写错误日志；本地记忆不受影响。
    const health = await recall.getJson(this.base, '/health');
    if (health === undefined) return;
    const libs = Array.isArray(health?.['libs']) ? health['libs'] as Record<string, unknown>[] : [];
    for (const name of names) {
      const info = libs.find((lib) => lib['name'] === name);
      const totals = info?.['totals'] as Record<string, unknown> | undefined;
      const files = typeof totals?.['files'] === 'number' ? totals['files'] : 0;
      const root = typeof info?.['root'] === 'string' && files <= SCAN_MAX_FILES ? info['root'] : undefined;
      const now = root === undefined ? undefined : await stamp(root);
      const watch: Watch = { refreshedAt: Date.now() };
      if (root !== undefined) watch.root = root;
      if (now !== undefined) { watch.refreshed = now; watch.last = now; }
      this.watches.set(name, watch);
    }
    this.report(await this.refresh(names));
  }

  /**
   * 刷几个库：POST /ingest（200、409 就等它做完；400 是老库，跳过摄取），再 POST /rag/index。
   * @returns 出的问题。
   */
  async refresh(names: string[]): Promise<string[]> {
    const problems: string[] = [];
    for (const name of names) {
      //M 网络不可用静默跳过；基地明确回的业务错误仍然报告。
      const ingest = await recall.postJson(this.base, '/ingest', { lib: name, ai: false });
      if (ingest === undefined) break;
      if (ingest === 200 || ingest === 409) {
        await this.waitIngest(name);
      } else if (ingest !== 400) {
        problems.push(`${name}：摄取没开始（${String(ingest)}）`);
      }
      const rag = await recall.postJson(this.base, '/rag/index', { lib: name });
      if (rag === undefined) break;
      if (rag !== 200) problems.push(`${name}：RAG 索引没开始建（${String(rag)}）`);
    }
    return problems;
  }

  /** 每隔一会儿问 GET /ingest?lib=，不在跑了、问不到、等太久都返回。 */
  private async waitIngest(name: string): Promise<void> {
    const deadline = Date.now() + INGEST_WAIT_MS;
    while (Date.now() < deadline && !this.stopped) {
      await Bun.sleep(this.pollMs);
      const body = await recall.getJson(this.base, `/ingest?lib=${encodeURIComponent(name)}`);
      const job = body?.['job'] as Record<string, unknown> | null | undefined;
      if (job?.['running'] !== true) return;
    }
  }

  /** engine.memory_libs 拆成库名。 */
  private names(): string[] {
    return this.base.libs.split(',').map((part) => part.trim()).filter((part) => part !== '');
  }

  /** 出了问题：进跟踪 memory.refresh，再打一行日志。 */
  private report(problems: string[]): void {
    if (problems.length === 0) return;

    //T 跟踪：记忆库索引没刷新好。
    this.ctx.emit('trace', 'Memory.refresh', '记忆库索引没刷新好', 'libs.refresh(names)', { 问题: problems.join('；') });
    console.error(`记忆库索引没刷新好：${problems.join('；')}`);
  }
}
