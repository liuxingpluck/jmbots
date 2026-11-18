/** 渠道消息进 Rust 的持久化队列。实时记录优先，历史批次须经资源守卫批准。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as files from '../../utils/Files.ts';
import * as requestEvent from '../../utils/RequestEvent.ts';
import * as text from '../../utils/Text.ts';
import * as archives from './Backfill_Channel_Index.ts';
import * as channel from './ChannelIndex.ts';
import type { ChannelIndex, ChannelRow } from './ChannelIndex.ts';
import type { MemoryService } from './index.ts';

/** 单条渠道消息的 Rust 文档。群聊、私聊和缺少类型的旧记录各占一个分区。 */
export function getChannelDoc(row: ChannelRow) {
  const chatType = row.chatType || 'unknown';
  const scopeKey = JSON.stringify([row.channel, row.account, row.chat]);

  //G 隔离同名聊天和不同账号，发布的客户号不含聊天原始标识。
  const hash = crypto.createHash('sha256');
  hash.update(scopeKey);
  const digest = hash.digest('hex');
  const customer = `${channel.CHANNEL_PARTITION}${chatType}:${digest}`;

  //M 同一渠道键重试时保持 Rust 唯一键一致。渠道不触发客服关系图抽取。
  return {
    source: `${channel.CHANNEL_PARTITION}${row.key}`,
    scope: 'history',
    customer,
    session: customer,
    bot: row.bot,
    title: row.senderName || row.senderId,
    text: row.text,
    at: row.at,
    start: 0,
    end: 0,
    graph: false,
  };
}

/** 历史回填配置，实时消息始终排队。 */
interface Settings {
  /** 第一次挂载是否自动开始。 */
  enabled: boolean;
  /** 每批最多读取归档和发送的消息数。 */
  batch: number;
  /** 两个历史批次的最小间隔，毫秒。 */
  interval: number;
}

/** 状态记录在 memory 目录，逐行确认标记由渠道索引事务保存。 */
interface Checkpoint {
  /** 本轮回填是否仍应运行。 */
  running: boolean;
  /** 四种渠道归档是否已扫描完。 */
  archiveDone: boolean;
}

/** 读 memory.backfill 小节，缺省手动开始。 */
export function getBackfillSettings(raw: unknown): Settings {
  let settings: Record<string, unknown> = {};
  if (raw !== undefined) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('memory.backfill 要写成配置对象');
    }
    settings = raw as Record<string, unknown>;
  }
  const enabled = settings['enabled'] ?? false;
  if (typeof enabled !== 'boolean') throw new Error('memory.backfill.enabled 要写 true 或 false');

  const batch = settings['batch_size'] ?? 25;
  if (typeof batch !== 'number' || !Number.isInteger(batch) || batch < 1 || batch > 100) {
    throw new Error('memory.backfill.batch_size 要写 1 到 100 的整数');
  }
  const interval = settings['interval_ms'] ?? 2000;
  if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1 || interval > 600_000) {
    throw new Error('memory.backfill.interval_ms 要写 1 到 600000 的整数');
  }
  return { enabled, batch, interval };
}

/** 每次只运行一个同步循环，保证实时消息和回填不会争抢同一行。 */
export class ChannelBackfill {
  private readonly file: string;
  private readonly lifecycle = new AbortController();
  private state: Checkpoint;
  private pressure = '';
  private reason = '';
  private active = false;
  private busy = false;
  private nextHistory = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reader?: AsyncGenerator<archives.Candidate>;

  /** 挂压力监听和管理接口。只在 ready 之后开始送消息。 */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly index: ChannelIndex,
    private readonly memory: MemoryService,
    private readonly settings: Settings,
  ) {
    const root = ctx.resources.root;
    this.file = path.join(root, 'memory', 'channel-backfill.json');
    //M 从 memory 目录恢复上次的手动选择，首次才使用配置默认值。
    this.state = this.getCheckpoint();

    //M high 直到收到 ok 才解除。busy 时仍由每个批次的准入回执决定。
    ctx.on('resource/pressure', (event) => {
      if (event.level === 'high') {
        this.pressure = event.reason || '资源占用过高';
        return;
      }
      if (event.level !== 'ok') return;

      this.pressure = '';
      this.reason = '';
      //M 解除压力后恢复调度；手动暂停状态仍由断点控制。
      this.wake();
    });

    //M 插件生命周期结束后不再发送新批次。
    ctx.on('ready', () => {
      this.active = true;
      this.wake();
    });
    //M 把定时器、归档读取和准入等待绑定到插件生命周期。
    ctx.effect(() => () => this.stop());
    this.mount();
  }

  /** 新消息、启动或解除压力时唤醒后台，渠道事件无需等待网络。 */
  wake(): void {
    if (!this.active || this.busy || this.timer !== undefined) return;

    //M 当前调用结束后再同步，使事件处理只承担 SQLite 写入。
    this.schedule(0);
  }

  /** 网页轮询状态和开始/暂停指令，沿用 HTTP 插件的访问控制。 */
  private mount(): void {
    void this.ctx.inject(['http'], (ctx) => {
      const app = ctx.http.app;
      //M 用同一路径读状态和提交手动操作，复用 HTTP 插件的鉴权。
      app.get('/api/memory/backfill', () => this.getStatus());
      app.post<{ Body: { running?: unknown } }>('/api/memory/backfill', (request, reply) => {
        const running = request.body?.running;
        //G 只接受显式布尔状态，避免请求体写错却开始扫历史。
        if (typeof running !== 'boolean') return reply.code(400).send({ error: '要给 running 布尔值' });

        //M 先持久化手动选择。重启后仍按用户上次选择运行。
        if (running !== this.state.running) {
          let archiveDone = this.state.archiveDone;
          if (running && this.getStatus().reason === '回填完成') {
            archiveDone = false;
          }
          const checkpoint = { running, archiveDone };
          //M 重启也要遵守这次选择，先落文件再开始下一批。
          this.writeCheckpoint(checkpoint);
        }
        this.reason = '';
        //M 立即返回本次操作后的状态，写入留给后台。
        this.wake();
        return this.getStatus();
      });
    });
  }

  /** 推进暂停原因和当前已发现总条数供网页显示。 */
  private getStatus() {
    //M 每条是否完成由 Rust 回执后的事务决定，扫描进度只是总量提示。
    const progress = this.index.getRustProgress();
    let reason = this.pressure || this.reason;
    if (!this.state.running) {
      reason = '手动暂停';
    }
    if (!this.state.running && this.state.archiveDone && progress.done === progress.total) {
      reason = '回填完成';
    }
    const scanning = this.state.running && !this.state.archiveDone;
    return { ...progress, running: this.state.running, scanning, reason };
  }

  /** 读取运行状态；没有状态文件才用首次挂载默认值。 */
  private getCheckpoint(): Checkpoint {
    const initial = { running: this.settings.enabled, archiveDone: false };
    if (!fs.existsSync(this.file)) return initial;

    //G 文件无法解释时停住回填，防止意外开始扫描用户归档。
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const state = JSON.parse(raw) as Partial<Checkpoint>;
      if (typeof state?.running !== 'boolean' || typeof state.archiveDone !== 'boolean') {
        return { ...initial, running: false };
      }
      return { running: state.running, archiveDone: state.archiveDone };
    } catch {
      return { ...initial, running: false };
    }
  }

  /** 原子保存 memory 的扫描断点和用户选择，成功后才更新内存。 */
  private writeCheckpoint(state: Checkpoint): void {
    const raw = JSON.stringify(state);
    //M 同目录原子替换，进程中断时保留上一份有效状态。
    files.writeTextAtomic(this.file, raw);
    this.state = state;
  }

  /** 安排下一次同步，不重叠执行。 */
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      //M 定时器先释放槽位，当前循环结束后再决定是否继续。
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  /** 实时记录先送，历史入库最多按配置的频率送一批。 */
  private async tick(): Promise<void> {
    this.busy = true;
    try {
      //M 先同步新收到的消息，暂停历史回填也不影响实时索引。
      const live = this.index.getRustBatch(true, this.settings.batch);
      await this.ingest(live);
      //G 实时事件唤醒循环时不能缩短两次历史批次的间隔。
      if (this.canRun() && Date.now() >= this.nextHistory) {
        //M 每轮只准入一批，即使实时事件更频繁也遵守历史批间隔。
        await this.backfill();
        this.nextHistory = Date.now() + this.settings.interval;
      }
    } catch (error) {
      //G 归档、守卫或 Rust 未确认时保留未完成记录，下次重试。
      const message = text.getMessage(error);
      if (this.reason !== '记忆服务或历史归档暂不可用，稍后重试') {
        console.error(`memory：渠道同步失败：${message}`);
      }
      this.reason = '记忆服务或历史归档暂不可用，稍后重试';
    } finally {
      this.busy = false;
      //G 卸载后不再读 SQLite。暂停历史后仅在有实时待发消息时重试。
      if (this.active) {
        const pending = this.index.getRustBatch(true, 1).length > 0;
        if (this.canRun() || pending) {
          this.schedule(this.settings.interval);
        }
      }
    }
  }

  /** 手动暂停及压力锁都解除，才可以发下一批。 */
  private canRun(): boolean {
    return this.active && this.state.running && this.pressure === '';
  }

  /** 先获得资源守卫准入，再扫描一批旧档并写一批 Rust 文档。 */
  private async backfill(): Promise<void> {
    const request = { action: 'can-start' as const, heavy: true, who: 'memory-backfill' };
    const options = {
      prefix: 'memory-backfill',
      timeoutMs: 3000,
      signal: this.lifecycle.signal,
      onFallback: (reason: string) => ({ requestId: '', ok: false, reason: `资源守卫未放行（${reason}）` }),
    };
    //M 守卫无人监听或超时也按拒绝处理，下个间隔再问。
    const access = await requestEvent.requestEvent(this.ctx, 'resource/request', 'resource/result', request, options);

    //G 等准入期间可能收到 high 或手动暂停。即便准入返回 ok，也要重新验。
    if (!this.canRun()) return;

    if (!access.ok) {
      this.reason = access.reason;
      return;
    }
    this.reason = '';

    //M 从索引里继续上次已发现的旧消息，再逐批读尚未索引的归档。
    let rows = this.index.getRustBatch(false, this.settings.batch);
    if (rows.length === 0 && !this.state.archiveDone) {
      await this.scan();
      if (!this.canRun()) return;

      //M 本轮从历史源发现的条目刚落索引，现在才进入可发送队列。
      rows = this.index.getRustBatch(false, this.settings.batch);
    }
    //M 归档扫完且无待发历史消息，保存完成状态并停止回填定时器。
    if (rows.length === 0 && this.state.archiveDone) {
      this.writeCheckpoint({ running: false, archiveDone: true });
      return;
    }
    //M 整批等待 Rust 的事务回执，不提前移动断点。
    await this.ingest(rows);
  }

  /** 每次最多处理 batch 条归档。压力变化时保留迭代位置，解除后继续。 */
  private async scan(): Promise<void> {
    const { root, db } = this.ctx.resources;
    //M 正常批次之间复用迭代位置，避免每个批次重读已扫描的归档。
    const reader = this.reader ?? archives.getArchives(root, db);
    this.reader = reader;
    try {
      //G 每条之间观察暂停状态，不开启更多归档工作。
      for (let count = 0; count < this.settings.batch && this.canRun(); count += 1) {
        const next = await reader.next();
        if (!this.active) return;

        if (next.done) {
          this.reader = undefined;
          const checkpoint = { ...this.state, archiveDone: true };
          //M 记录扫描结束，重启后可直接处理索引里剩余的待发送消息。
          this.writeCheckpoint(checkpoint);
          return;
        }

        //M 保留刚读出的这一条。若此时收到暂停，循环退出且本批不发 Rust。
        archives.addCandidate(this.index, next.value);
      }
    } catch (error) {
      //G 读档或落索引失败后重新打开归档，已落索引的记录用稳定键跳过。
      this.reader = undefined;
      await reader.return(undefined).catch(() => undefined);
      throw error;
    }
  }

  /** Rust 确认收到整批后才标为已入库。 */
  private async ingest(rows: ChannelRow[]): Promise<void> {
    if (rows.length === 0) return;

    //M 使用稳定来源键和聊天分区，跨进程重复提交也只覆盖同一文档。
    const docs = rows.map(getChannelDoc);
    await this.memory.ingestChannel(docs);
    if (!this.active) return;

    //M 收到 Rust 的完整回执后标记完成，部分失败则原批重试。
    this.index.confirmRustBatch(rows);
  }

  /** 卸载插件时撤销等待中的准入请求，关闭归档读取句柄。 */
  private stop(): void {
    this.active = false;
    clearTimeout(this.timer);
    this.lifecycle.abort();
    void this.reader?.return(undefined).catch(() => undefined);
  }
}
