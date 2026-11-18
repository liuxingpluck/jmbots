/**
 * 盯基地的新版本（由原 update-watch 并入 base-bridge）：
 * 全部挂完 first_ms（默认 10 秒）后问一次基地 GET /update，以后每 every_ms（默认 60 秒）一次。
 * 有新版本、没被拒过、也没在等，就 approval.ask 登记一条（kind: 'update'）。
 * 用户同意 → 叫基地 POST /update/apply；拒绝 → 记下这个版本不再问；卸载时清理定时器。
 * 默认关闭：需在 plugins[base-bridge].config.update_watch 显式传 true 或对象才开启。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import type { Pending } from '../approval/index.ts';


/** `plugins[base-bridge].config.update_watch` 校验后配置。 */
export interface UpdateWatchSettings {
  /** 是否开启更新监听（未传或 `false` 时默认关闭）。 */
  enabled: boolean;
  /** `ready` 后首次检查延迟，毫秒，默认 10000。 */
  firstMs: number;
  /** 后续检查间隔，毫秒，默认 60000。 */
  everyMs: number;
}

/** 基地 GET /update 回的（照 web/src/Api.ts UpdateInfo）。 */
interface UpdateInfo {
  managed?: boolean;
  current?: { version: string } | null;
  available?: { version: string; changes?: { version: string; changes: string[] }[] } | null;
  applying?: boolean;
  message?: string;
}

/** data/update_watch.json。 */
interface WatchState {
  declined?: string;
  swapping?: { version: string; bot?: string };
}


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


/**
 * 校验并读取 `plugins[base-bridge].config.update_watch`（默认关闭）。
 * @param raw `config.update_watch`；`undefined` 或 `false` 关闭，`true` 或 `{ enabled?, first_ms?, every_ms? }` 开启并校验间隔。
 * @returns 校验并填充默认间隔后的更新监听配置。
 * @throws 类型或数字范围不合法时抛错。
 */
export function readUpdateWatchSettings(raw: unknown): UpdateWatchSettings {
  if (raw === undefined || raw === false) return { enabled: false, firstMs: FIRST_MS, everyMs: EVERY_MS };

  if (raw === true) return { enabled: true, firstMs: FIRST_MS, everyMs: EVERY_MS };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('base-bridge.update_watch 要是 true、false 或对象');
  }
  const own = raw as { enabled?: unknown; first_ms?: unknown; every_ms?: unknown };
  if (own.enabled !== undefined && typeof own.enabled !== 'boolean') {
    throw new Error('base-bridge.update_watch.enabled 要是 true 或 false');
  }
  const firstMs = own.first_ms ?? FIRST_MS;
  if (typeof firstMs !== 'number' || !Number.isFinite(firstMs) || firstMs < 0) {
    throw new Error('base-bridge.update_watch.first_ms 要是不小于 0 的数字');
  }
  const everyMs = own.every_ms ?? EVERY_MS;
  if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error('base-bridge.update_watch.every_ms 要是正数');
  }
  return { enabled: own.enabled !== false, firstMs, everyMs };
}


/** 盯更新：定时查基地 GET /update，结合 approval 与 sessions 完成提醒及触发换版。 */
export class UpdateWatch {
  /** 状态文件。 */
  private readonly file: string;
  /** 下一次问的定时器。 */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 构造更新监听器并定位本地状态文件。
   * @param ctx Cordis 给的 ctx。
   * @param everyMs 多久问一次。
   */
  constructor(private readonly ctx: cordis.Context, private readonly everyMs: number) {
    //M 拼接数据目录下的 update_watch.json 路径，供后续读写已拒版本与换版状态。
    this.file = path.join(ctx.resources.dir('data'), 'update_watch.json');
  }

  /**
   * 预约下一次更新检查。
   * @param ms 延迟毫秒数。
   * 副作用：重置内部定时器。
   */
  schedule(ms: number): void {
    //M 先清掉旧定时器再重新定时，防止重复挂载起多个轮询。
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /**
   * 停掉定时器（卸载时清理）。
   * 副作用：清除并置空内部定时器句柄。
   */
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 问一次，出错打一行，再约下一次。 */
  private async tick(): Promise<void> {
    try {
      //M 发起一轮更新检查，异常就地记日志以保证周期轮询不中断。
      await this.check();
    } catch (error) {
      console.error(`盯更新：${textModule.getMessage(error)}`);
    }
    //M 只要未被 stop 清空定时器，就继续按固定周期预约下一轮检查。
    if (this.timer !== undefined) {
      this.schedule(this.everyMs);
    }
  }

  /**
   * 问基地、报结果、拒掉旧条目、登记新版本。
   * 副作用：可能读写 `update_watch.json`、变更或新增 `approval` 待确认条目、向前台会话发通知并发送 trace。
   */
  async check(): Promise<void> {
    //M 用时现取可选服务，插件挂载顺序不影响下一轮；没配或基地离线都静默跳过。
    const base = this.ctx.get('base');
    if (base === undefined) return;

    let status: UpdateInfo;
    try {
      //M 询问基地当前更新状态；网络失败或非 2xx 时本轮静默跳过。
      const response = await base.getJson('/update', TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) return;

      status = response.body as UpdateInfo;
      if (typeof status !== 'object' || status === null) return;
    } catch {
      return;
    }
    if (status.managed !== true || status.applying === true) return;

    //M 读出本地持久化的换版中与已拒绝记录，供下面决定是报结果还是推新版本。
    const state = this.load();

    //G 同意过、基地开始换了，现在换完了：报结果。
    if (state.swapping !== undefined) {
      const version = state.swapping.version;
      const message = status.message ?? '';
      let said = message;
      if (said === '') {
        said = '（没说）';
      }
      let words = `更新到 ${version} 的结果不清楚：基地说“${said}”`;
      if (message === '换好了') {
        words = `已更新到 ${version}。`;
      }
      if (message.startsWith('没换成')) {
        words = `没更新到 ${version}：${message}`;
      }
      const bot = state.swapping.bot;
      const { swapping, ...rest } = state;
      void swapping;
      //M 换版已有明确结论，先把 swapping 状态清除落盘以免下一轮重复播报。
      this.save(rest);
      //T 跟踪：报结果。
      this.ctx.emit('trace', 'UpdateWatch.check', '报更新结果', 'tell(bot, words)', { 版本: version, 基地说: message });
      if (bot !== undefined) {
        this.tell(bot, words);
      }
      return;
    }

    //M 取出当前所有仍在等待审批的更新条目，用于清理过期版本或防止重复弹出。
    const available = status.available ?? undefined;
    const waiting = this.ctx.approval.list().filter((item) => item.kind === 'update');
    let expireReason = NEWER;
    if (available === undefined) {
      expireReason = GONE;
    }
    for (const item of waiting) {
      const ver = (item.payload as { version?: string } | null)?.version;
      if (ver !== available?.version) {
        //M 新版本已替换或撤回时，把过期的旧更新待确认自动驳回。
        this.ctx.approval.decide(item.id, false, expireReason);
      }
    }
    if (available === undefined || state.declined === available.version) return;

    if (waiting.some((item) => (item.payload as { version?: string } | null)?.version === available.version)) return;

    //M 选第一个在线配置的机器人作为审批条目与结果播报的归属。
    const bot = this.ctx.bots.list()[0]?.name;
    if (bot === undefined) return;

    const changes = (available.changes ?? []).map((item) => `${item.version}：${item.changes.join('、')}`).join('；').slice(0, CHANGES_MAX);
    //M approval.ask：登记一条没有会话的待确认，approval 发 approval/asked，网页和飞书卡片去推。
    const pending = this.ctx.approval.ask({
      kind: 'update',
      bot,
      title: `有新版本 ${available.version}`,
      detail: `${changes}\n${ADVICE}`,
      payload: { version: available.version, command: `更新到 ${available.version}（现在是 ${status.current?.version ?? '未知'}）` },
    });
    //T 跟踪：登记新版本。
    this.ctx.emit('trace', 'UpdateWatch.check', '登记新版本', 'approval.ask', { 版本: available.version, 待确认: pending.id });
  }

  /**
   * 处理用户对更新待确认的决定：拒绝时记下版本不再提醒，同意时通知基地开始换版。
   * @param pending 已决定的待确认条目。
   * 副作用：可能写 `update_watch.json`、调用基地 `/update/apply`、向前台会话发失败提示并发送 trace。
   */
  async onDecided(pending: Pending): Promise<void> {
    if (pending.kind !== 'update') return;

    const version = (pending.payload as { version?: string } | null)?.version ?? '';
    //M 读取本地更新状态，供后续持久化拒绝版本或换版中标记。
    const state = this.load();
    if (pending.state !== 'approved') {
      if (pending.by === NEWER || pending.by === GONE) return;

      //M 用户亲自拒绝该版本时记盘留存，避免后续轮询反复弹窗。
      this.save({ ...state, declined: version });
      return;
    }
    try {
      //M 用户已经同意才发更新请求；失败要告知，和后台探测的静默跳过区分开。
      const base = this.ctx.get('base');
      if (base === undefined) throw new Error('没配 engine.index_url');

      //M 通知基地执行换版，非 2xx 响应转作异常以便提示用户。
      const response = await base.postJson('/update/apply', {}, TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`基地回 ${String(response.status)}：${(JSON.stringify(response.body) ?? '').slice(0, 200)}`);
      }
      //M 基地已接受换版请求，记下 swapping 状态待下一轮检查向用户播报结果。
      this.save({ ...state, swapping: { version, bot: pending.bot } });
      //T 跟踪：叫基地换。
      this.ctx.emit('trace', 'UpdateWatch.onDecided', '叫基地换', "base.postJson('/update/apply')", { 版本: version });
    } catch (error) {
      //M 发起换版失败时把原因发到前台会话，提示用户去网页手动更新。
      this.tell(pending.bot, `没开始更新到 ${version}：${textModule.getMessage(error)}。可以在网页左下角手动更新。`);
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
    //M 打开该机器人的最新前台会话，把更新结果或提示直接发给用户。
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

  /** 写状态：先写临时文件再改名（utils/Files.ts 的 writeTextAtomic）。 */
  private save(state: WatchState): void {
    const text = JSON.stringify(state, null, 2);
    //M 原子覆盖写入状态文件，防止中途异常写坏 JSON。
    filesModule.writeTextAtomic(this.file, text);
  }
}


/**
 * 挂上更新监听模块：监听 `ready` 排首次检查、`approval/decided` 响应审批，卸载时清理定时器。
 * @param ctx 含 `resources`、`bots`、`approval`、`sessions` 的 Cordis 上下文。
 * @param settings `readUpdateWatchSettings` 返回的已校验配置。
 * 副作用：注册 `ready`、`approval/decided` 监听以及卸载时停用定时器的清理效果。
 */
export function mountUpdateWatch(ctx: cordis.Context, settings: UpdateWatchSettings): void {
  if (!settings.enabled) return;

  //M 创建更新监听器并挂接启动首次调度、审批决定回调与插件卸载清理钩子。
  const watch = new UpdateWatch(ctx, settings.everyMs);
  ctx.on('ready', () => watch.schedule(settings.firstMs));
  ctx.on('approval/decided', (pending: Pending) => void watch.onDecided(pending));
  ctx.effect(() => () => watch.stop());
}
