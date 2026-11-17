/**
 * 盯基地的新版本：全部挂完 10 秒后问一次基地 GET /update，以后每 60 秒一次。有新版本、没被拒过、也没在等，就 approval.ask 登记一条
 * （kind: 'update'，网页待确认列表、飞书卡片都能看到、能点）。用户同意 → 叫基地 POST /update/apply；拒绝 → 记下这个版本不再问。
 * 来了更新的版本、或新版本已经被换掉：还在等的旧条目自动拒掉。换完或换失败，下一次问到时说给第一个机器人的前台会话。
 * 换文件、重启全归基地。没配 engine.index_url、基地没在守护（managed 不是 true）：什么也不做。
 * 照 0.4 src/capabilities/UpdateWatch.ts。设计：docs/src7插件设计/update-watch.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { Pending } from '../approval/index.ts';


/** 插件名。 */
export const name = 'update-watch';

/** 用到的服务：resources 读配置、存状态；bots 找机器人、说话；approval 登记和定；sessions 找前台会话。 */
export const inject = ['resources', 'bots', 'approval', 'sessions'];


/** 基地 GET /update 回的（照 web/src/Api.ts UpdateInfo）。 */
interface UpdateInfo {
  managed?: boolean;
  current?: { version: string } | null;
  available?: { version: string; changes?: { version: string; changes: string[] }[] } | null;
  applying?: boolean;
  message?: string;
}

/** data/update_watch.json。 */
interface WatchState { declined?: string; swapping?: { version: string; bot?: string } }


/** 照 0.4：启动后第一次、以后每次、超时、更新内容最多几个字。 */
const FIRST_MS = 10_000;
const EVERY_MS = 60_000;
const TIMEOUT_MS = 5_000;
const CHANGES_MAX = 600;
/** 自己拒掉旧条目时写的两句：听到这两句的拒绝不记成用户拒的。 */
const NEWER = '有更新的版本了';
const GONE = '新版本已经换上或撤掉了';
/** 风险和建议（并进 detail）。 */
const ADVICE = '后端会重启，正在跑的会话会被打断。基地先试运行新版本，通过才替换，失败退回旧版本。不急的话等手上的活干完再同意。';


/** 盯更新。 */
class UpdateWatch {
  /** 状态文件。 */
  private readonly file: string;
  /** 下一次问的定时器。 */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param ctx Cordis 给这个插件的 ctx。
   * @param everyMs 多久问一次。
   */
  constructor(private readonly ctx: cordis.Context, private readonly everyMs: number) {
    this.file = path.join(ctx.resources.dir('data'), 'update_watch.json');
  }

  /** 约下一次。 */
  schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** 停掉定时器。 */
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 问一次，出错打一行，再约下一次。 */
  private async tick(): Promise<void> {
    try {
      await this.check();
    } catch (error) {
      console.error(`盯更新：${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.timer !== undefined) this.schedule(this.everyMs);
  }

  /** 问基地、报结果、拒掉旧条目、登记新版本。 */
  async check(): Promise<void> {
    //M 用时现取可选服务，插件挂载顺序不影响下一轮；没配或基地离线都静默跳过。
    const base = this.ctx.get('base');
    if (base === undefined) return;
    let status: UpdateInfo;
    try {
      const response = await base.getJson('/update', TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) return;
      status = response.body as UpdateInfo;
      if (typeof status !== 'object' || status === null) return;
    } catch {
      return;
    }
    if (status.managed !== true || status.applying === true) return;
    const state = this.load();

    //G 同意过、基地开始换了，现在换完了：报结果。
    if (state.swapping !== undefined) {
      const version = state.swapping.version;
      const message = status.message ?? '';
      const words = message === '换好了' ? `已更新到 ${version}。`
        : message.startsWith('没换成') ? `没更新到 ${version}：${message}`
          : `更新到 ${version} 的结果不清楚：基地说“${message || '（没说）'}”`;
      const bot = state.swapping.bot;
      const { swapping, ...rest } = state;
      void swapping;
      this.save(rest);
      //T 跟踪：报结果。
      this.ctx.emit('trace', 'UpdateWatch.check', '报更新结果', 'tell(bot, words)', { 版本: version, 基地说: message });
      if (bot !== undefined) this.tell(bot, words);
      return;
    }

    const available = status.available ?? undefined;
    const waiting = this.ctx.approval.list().filter((item) => item.kind === 'update');
    for (const item of waiting) {
      const version = (item.payload as { version?: string } | null)?.version;
      if (version !== available?.version) this.ctx.approval.decide(item.id, false, available === undefined ? GONE : NEWER);
    }
    if (available === undefined || state.declined === available.version) return;
    if (waiting.some((item) => (item.payload as { version?: string } | null)?.version === available.version)) return;
    const bot = this.ctx.bots.list()[0]?.name;
    if (bot === undefined) return;

    const changes = (available.changes ?? []).map((item) => `${item.version}：${item.changes.join('、')}`).join('；').slice(0, CHANGES_MAX);
    //M approval.ask：登记一条没有会话的待确认，approval 发 approval/asked，网页和飞书卡片去推。
    const pending = this.ctx.approval.ask({
      kind: 'update', bot,
      title: `有新版本 ${available.version}`,
      detail: `${changes}\n${ADVICE}`,
      payload: { version: available.version, command: `更新到 ${available.version}（现在是 ${status.current?.version ?? '未知'}）` },
    });
    //T 跟踪：登记新版本。
    this.ctx.emit('trace', 'UpdateWatch.check', '登记新版本', 'approval.ask', { 版本: available.version, 待确认: pending.id });
  }

  /** 用户定了：拒绝记版本；同意叫基地换。 */
  async onDecided(pending: Pending): Promise<void> {
    if (pending.kind !== 'update') return;
    const version = (pending.payload as { version?: string } | null)?.version ?? '';
    const state = this.load();
    if (pending.state !== 'approved') {
      if (pending.by === NEWER || pending.by === GONE) return;
      this.save({ ...state, declined: version });
      return;
    }
    try {
      //M 用户已经同意才发更新请求；失败要告知，和后台探测的静默跳过区分开。
      const base = this.ctx.get('base');
      if (base === undefined) throw new Error('没配 engine.index_url');
      const response = await base.postJson('/update/apply', {}, TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`基地回 ${String(response.status)}：${(JSON.stringify(response.body) ?? '').slice(0, 200)}`);
      }
      this.save({ ...state, swapping: { version, bot: pending.bot } });
      //T 跟踪：叫基地换。
      this.ctx.emit('trace', 'UpdateWatch.onDecided', '叫基地换', "base.postJson('/update/apply')", { 版本: version });
    } catch (error) {
      this.tell(pending.bot, `没开始更新到 ${version}：${error instanceof Error ? error.message : String(error)}。可以在网页左下角手动更新。`);
    }
  }

  /** 说给这个机器人的前台会话；没有只打跟踪点。 */
  private tell(bot: string, text: string): void {
    //M sessions.find 照记录的项找（bot、kind 是插件加的项）；新的在前。
    const front = this.ctx.sessions.find({ bot, kind: 'front' })[0];
    if (front === undefined) {
      this.ctx.emit('trace', 'UpdateWatch.tell', '没有前台会话，说不了', 'sessions.find', { 机器人: bot, 话: text });
      return;
    }
    this.ctx.bots.say(this.ctx.sessions.open(front.id), text);
  }

  /** 读状态；读不出当空的。 */
  private load(): WatchState {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as WatchState;
    } catch {
      return {};
    }
  }

  /** 写状态：先 .tmp 再改名。 */
  private save(state: WatchState): void {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}


/**
 * 挂上盯更新。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。基地服务在每次检查时现取；
 * config 的 first_ms、every_ms 只给测试用（不写照 0.4 的 10 秒、60 秒）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins 段里写给它的。
 */
export function apply(ctx: cordis.Context, config?: { first_ms?: number; every_ms?: number }): void {
  //M 不把 base 写进必需依赖，基地没挂时也能正常启动和清理本插件。
  const watch = new UpdateWatch(ctx, config?.every_ms ?? EVERY_MS);
  //M ready：全部插件挂完才发；这时再约第一次。
  ctx.on('ready', () => watch.schedule(config?.first_ms ?? FIRST_MS));
  //M approval/decided（通知）：只认 kind 是 update 的。
  ctx.on('approval/decided', (pending: Pending) => void watch.onDecided(pending));
  //M ctx.effect：插件被拔掉时清定时器。
  ctx.effect(() => () => watch.stop());
}
