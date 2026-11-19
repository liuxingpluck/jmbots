/**
 * 盯基地的新版本（由原 update-watch 并入 base-bridge）：
 * 全部挂完 first_ms（默认 10 秒）后问一次基地 GET /update，以后每 every_ms（默认 60 秒）一次。
 * 有新版本、没被拒过、也没在等，就发 approval/request（action: ask）登记一条（kind: 'update'）。
 * 用户同意 → 叫基地 POST /update/apply；拒绝 → 记下这个版本不再问；卸载时清理定时器。
 * 和 approval、bots 说话都走事件（契约第五节第一份 #10–#12、#27）：没挂 approval 时当没有待确认、登记不上就记一行跳过。
 * 默认关闭：需在 plugins[base-bridge].config.update_watch 显式传 true 或对象才开启。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';


/** 一件待确认：照 approval 声明的 approval/decided 事件取，不 import approval 目录。 */
type Pending = requestEventModule.EventArg<'approval/decided'>;

/** approval/result 回执：照 approval 声明的事件取。 */
type ApprovalReply = requestEventModule.EventArg<'approval/result'>;


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
/** 问 approval 还有哪些在等最多等多久（契约 3.1：list 3 秒）。 */
const LIST_WAIT_MS = 3_000;
/** 请 approval 登记一条最多等多久（契约 3.1：ask 5 秒）。 */
const ASK_WAIT_MS = 5_000;
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
  /** 已发出换版且仍在等待回执。 */
  private swapping = false;
  /** 发出换版后未收到结果的版本。保存在本进程内存中。 */
  private uncertainSwap: { version: string } | undefined;
  /** 送审已发出，但未收到回执的版本。 */
  private uncertainApproval: string | undefined;

  /**
   * 构造更新监听器并定位本地状态文件。
   * @param ctx Cordis 给的 ctx。
   * @param everyMs 多久问一次。
   */
  constructor(private readonly ctx: cordis.Context, private readonly everyMs: number) {
    //M 拼接数据目录下的 update_watch.json 路径，供后续读写已拒版本与换版状态。
    this.file = path.join(ctx.resources.ensureRuntimeDir('data'), 'update_watch.json');
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
      console.error(`盯更新：${textModule.getErrorMessage(error)}`);
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
    const observedSwap = this.uncertainSwap;
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

    //G 对账只能读取状态。基地确认为目标版本后解除占用，不发送换版请求。
    const uncertainSwap = this.uncertainSwap;
    if (uncertainSwap !== undefined) {
      const matches = uncertainSwap === observedSwap && status.current?.version === uncertainSwap.version;
      if (status.applying === false && matches) {
        this.clearUncertainSwap(uncertainSwap.version, 'applied');
      }
      return;
    }

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
      this.ctx.emit('trace', 'UpdateWatch.check', 'trace.base.reportUpdate', 'tell(bot, words)', { version: version, desktopMessage: message });
      if (bot !== undefined) {
        this.tell(bot, words);
      }
      return;
    }

    //M 问 approval 还在等的更新条目（approval/request，action: list），用于清理过期版本或防止重复弹出。
    //M   没挂 approval、超时都当没有在等的（契约 3.1：查询类退回空清单）。
    const available = status.available ?? undefined;
    const listRequest = { action: 'list', kind: 'update' } as const;
    const listOptions = { prefix: 'apr', timeoutMs: LIST_WAIT_MS, onFallback: getEmptyReply };
    const listed = await requestEventModule.requestEvent(this.ctx, 'approval/request', 'approval/result', listRequest, listOptions);
    const waiting = listed.items ?? [];

    let expireReason = NEWER;
    if (available === undefined) {
      expireReason = GONE;
    }
    for (const item of waiting) {
      const ver = (item.payload as { version?: string } | null)?.version;
      if (ver !== available?.version) {
        //M 新版本已替换或撤回时，把过期的旧更新待确认自动驳回：不带 requestId，发完就走（契约 3.1：清理类不等回执）。
        const decideRequest = { action: 'decide', id: item.id, approve: false, by: expireReason } as const;
        void this.ctx.serial('approval/request', decideRequest).catch(() => undefined);
      }
    }

    //G 没有新版本、用户拒过这个版本：不再登记。
    if (available === undefined || state.declined === available.version) return;
    if (this.swapping || this.uncertainApproval === available.version) return;

    //G 这个版本已经在等用户了：不重复登记。
    if (waiting.some((item) => (item.payload as { version?: string } | null)?.version === available.version)) return;

    //M 选第一个在线配置的机器人作为审批条目与结果播报的归属。
    const bot = botUtils.getDefaultBot(this.ctx.resources.raw);
    if (bot === undefined) return;

    //M 把各版本的更新内容拼成一段（最多 600 字），连同风险建议写进待确认的细节。
    const changes =(available.changes ?? []).map((item) => `${item.version}：${item.changes.join('、')}`).join('；').slice(0, CHANGES_MAX);
    const input = {
      kind: 'update',
      bot,
      title: `有新版本 ${available.version}`,
      detail: `${changes}\n${ADVICE}`,
      payload: { version: available.version, command: `更新到 ${available.version}（现在是 ${status.current?.version ?? '未知'}）` },
    };
    const askRequest = { action: 'ask', input } as const;
    const uncertain = '更新送审结果不确定';
    const askOptions = { prefix: 'apr', timeoutMs: ASK_WAIT_MS, onFallback: getEmptyReply };

    //M 发 approval/request（action: ask）：登记一条没有会话的待确认，approval 发 approval/asked，网页和飞书卡片去推。
    const asked = await requestEventModule.requestEvent(this.ctx, 'approval/request', 'approval/result', askRequest, askOptions);

    //G 未获回执时可能已经登记，保留同版本的占用并让中控核对。
    if (requestEventModule.isUnsure(asked)) {
      this.uncertainApproval = available.version;
      console.error(`盯更新：新版本 ${available.version} 的${uncertain}`);
      return;
    }

    //G 没接单或明确登记失败时，记录原因并等下一轮。
    if (asked.pending === undefined) {
      console.error(`盯更新：新版本 ${available.version} 没登记上待确认（${asked.error ?? '审核插件没回'}），下一轮再试`);
      return;
    }

    //T 跟踪：登记新版本。
    this.ctx.emit('trace', 'UpdateWatch.check', 'trace.base.registerUpdate', "requestEvent('approval/request', ask)", { version: available.version, approvalId: asked.pending.id });
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
    //G 已经在发或之前没有确认结果时，不重复请求换版。
    if (this.swapping || this.uncertainSwap !== undefined || state.swapping !== undefined) return;

    this.swapping = true;
    try {
      //M 用户已经同意才发更新请求；失败要告知，和后台探测的静默跳过区分开。
      const base = this.ctx.get('base');
      if (base === undefined) throw new Error('没配 plugins[base-bridge].config.index_url');

      //M 通知基地执行换版，非 2xx 响应转作异常以便提示用户。
      const response = await base.postJson('/update/apply', {}, TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`基地回 ${String(response.status)}：${(JSON.stringify(response.body) ?? '').slice(0, 200)}`);
      }
      //M 基地已接受换版请求，记下 swapping 状态待下一轮检查向用户播报结果。
      this.save({ ...state, swapping: { version, bot: pending.bot } });
      //T 跟踪：叫基地换。
      this.ctx.emit('trace', 'UpdateWatch.onDecided', 'trace.base.applyUpdate', "base.postJson('/update/apply')", { version: version });
    } catch (error) {
      const reason = textModule.getErrorMessage(error);
      //G 基地可能已经收到 POST。只记原因，保留占用给中控核对。
      if (reason === '基地没响应') {
        this.uncertainSwap = { version };
        const vars = { version: version, reason: reason };
        this.ctx.emit('trace', 'UpdateWatch.onDecided', 'trace.base.updateUncertain', 'base.postJson', vars);
        console.error(`盯更新：换版到 ${version} 结果不确定（${reason}）`);
        return;
      }

      //M 明确失败的原因交给前台会话。
      this.tell(pending.bot, `没开始更新到 ${version}：${reason}。可以在网页左下角手动更新。`);
    } finally {
      this.swapping = false;
    }
  }

  /**
   * 根据中控确认的结果并核对基地状态，解除指定版本的换版占用。
   * @param version 等待核对的目标版本。
   * @param outcome 中控已确认的结果。
   * @throws 无对应占用、基地仍在换版或基地状态与确认结果矛盾时拒绝解除。
   */
  async reconcile(version: string, outcome: 'applied' | 'not-applied'): Promise<void> {
    //G 防止清掉另一版本或仍在等待回执的请求。
    const uncertainSwap = this.uncertainSwap;
    if (uncertainSwap?.version !== version) throw new failureModule.Failure(409, '没有这个版本的待核对换版');

    const base = this.ctx.get('base');
    if (base === undefined) throw new failureModule.Failure(503, '缺少基地连接');

    //M 只读基地状态作为二次核对，解锁不提交换版。
    let status: UpdateInfo;
    try {
      const response = await base.getJson('/update', TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) throw new Error('基地状态不可用');

      status = response.body as UpdateInfo;
    } catch {
      throw new failureModule.Failure(503, '无法核对基地更新状态');
    }

    //G 核对要和中控确认一致。状态缺失或仍在换版时保留占用。
    if (status?.managed !== true || status.applying !== false || !status.current?.version) {
      throw new failureModule.Failure(409, '基地还未给出可核对的空闲版本');
    }
    const applied = status.current.version === version;
    if (applied !== (outcome === 'applied')) throw new failureModule.Failure(409, '基地当前版本与确认结果不一致');

    //G 查询期间可能已核对完成或开始了另一次换版。只处理本次占用。
    if (this.uncertainSwap === undefined) return;
    if (this.uncertainSwap !== uncertainSwap) throw new failureModule.Failure(409, '待核对的换版请求已改变');

    this.clearUncertainSwap(version, outcome);
  }

  /** 解除换版与同版本送审占用，并记录核对结论。 */
  private clearUncertainSwap(version: string, outcome: 'applied' | 'not-applied'): void {
    this.uncertainSwap = undefined;
    if (this.uncertainApproval === version) this.uncertainApproval = undefined;

    const vars = { version: version, reconciledOutcome: outcome };
    this.ctx.emit('trace', 'UpdateWatch.reconcile', 'trace.base.reconcileUpdate', 'GET /update', vars);
  }

  /** 说给这个机器人的前台会话；没有只打跟踪点。 */
  private tell(bot: string, text: string): void {
    //M sessions.find 照记录的项找（bot、kind 是插件加的项）；新的在前。
    const front = this.ctx.sessions.find({ bot, kind: 'front' })[0];
    if (front === undefined) {
      this.ctx.emit('trace', 'UpdateWatch.tell', 'trace.base.noFrontSession', 'sessions.find', { bot: bot, spoken: text });
      return;
    }
    //M 打开该机器人的最新前台会话，发通知 bot/say 把更新结果或提示告诉用户（bots 听它，按会话的渠道发出去）。
    const session = this.ctx.sessions.open(front.id);
    this.ctx.emit('bot/say', session, text);
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
 * 问 approval 没回（没挂、超时、出错）时的退回：没有在等的、也没登记上。requestId 留空。
 * 写明返回类型，交给 requestEvent 的 onFallback。
 * @param reason requestEvent 给的退回原因。
 * @param detail 出错时的原话。
 */
function getEmptyReply(reason: requestEventModule.FallbackReason, detail?: string): ApprovalReply {
  let error = `审核插件没回（${reason}）`;
  if (detail !== undefined) {
    error = `审核插件出错：${detail}`;
  }
  return { requestId: '', items: [], error };
}


/**
 * 挂上更新监听模块：监听 `ready` 排首次检查、`approval/decided` 响应审批，卸载时清理定时器。
 * @param ctx 含 `resources`、`bots`、`sessions` 的 Cordis 上下文（approval 经事件找，不用挂着）。
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

  //M 已核验的中控可提交核对结论。未核验的远程请求不能改变占用。
  void ctx.inject(['http'], (sub) => {
    sub.http.app.post<{ Body: unknown }>('/api/update/watch/reconcile', async (request, reply) => {
      if (!sub.http.isVerified(request)) return reply.code(403).send({ error: '需要核验的中控访问' });

      const body = request.body as { version?: unknown; outcome?: unknown } | undefined;
      const version = body?.version;
      const outcome = body?.outcome;
      if (typeof version !== 'string' || version === '' || (outcome !== 'applied' && outcome !== 'not-applied')) {
        return reply.code(400).send({ error: '请提供 version 和 applied 或 not-applied 的 outcome' });
      }

      //M 已核验的结论交给换版监听器，错误由 HTTP 插件返回。
      await watch.reconcile(version, outcome);
      return { ok: true };
    });
  });
}
