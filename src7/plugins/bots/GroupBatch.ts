/**
 * 群攒批：飞书登记了 listen: judge 的群里没叫机器人的话，每个（机器人，群）攒一批，满足两个触发之一才问一次决策模型要不要接话。
 *   - 触发一：这一批最后一句之后，群里安静满 quiet_seconds 秒；触发二：攒满 max_lines 句。到点时前台正在转，等这一轮停下再看。
 *   - 每群每天最多看 daily_limit 次（0 不限）：按群算，同群几个机器人共用，本地日期换天清零；看满了不问，话记成背景。
 *   - 问决策模型发请求事件 decision/judge；接话就照最后一句排进前台的单队列（DispatchClaim.enqueueBatch），这一批当这一轮的话；
 *     群登记了 judge_helper（地址带 judgeHelper）的，接话时这一批记成前台背景，再转给那个外部助手（DispatchClaim.relayBatch）；
 *     不接就把这一批记进前台对话当背景（FrontDesk.listen）。一批发一次 bot/judged（飞书补记一行来往流水）。
 *   - 有人叫了机器人（私聊、@、引用）：DispatchClaim 认领时调 take 拿走这一批，拼在叫它的那句前面，缓冲清空。
 *   - 渠道撤回（DispatchRecall 调 cancelRecall）：本人或原发信人撤回的话从缓冲里拿掉。
 * 配置：bots 的 group_batch（readGroupBatch 在入口校验）；没写或缺键就不攒，listen: judge 的群只记不判断。
 * 缓冲只在内存里，重启丢掉（话照旧在记忆的渠道索引里）。
 */
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import type * as protocol from '../channels/index.ts';
import type * as decisionModule from '../decision/index.ts';
import type { DispatchClaim } from './DispatchClaim.ts';
import * as frontDeskModule from './FrontDesk.ts';


/** 问决策模型等这么久还没回就报警（decision 每个模型自己限时，到点回拿不准）。 */
const JUDGE_WARN_MS = 60_000;

/** 没等到决策模型回执的原因，写进 bot/judged 的结果。 */
const FALLBACK_TEXT: Record<requestEventModule.FallbackReason, string> = {
  unhandled: '没有决策模型',
  timeout: '决策模型超时',
  aborted: '判断被取消',
  error: '决策模型出错',
};


/** bots 的 config.group_batch：三个数都从 config.yaml 读，代码里不写默认值。 */
export interface GroupBatchConfig {
  /** 这一批最后一句之后，群里安静满几秒就看这一批。 */
  quiet_seconds: number;
  /** 攒满几句就马上看。 */
  max_lines: number;
  /** 每群每天最多看几次；0 不限。 */
  daily_limit: number;
}


/** 缓冲里的一句。 */
export interface Heard {
  /** 说的话（已物化附件）。 */
  text: string;
  /** 标准消息：撤回按消息号找；接话时最后一句的拿来拼来源快照、回到这个群。 */
  message: protocol.ChannelMessage;
  /** 这个机器人的地址副本：说话人、judgeThreshold、回话地址。 */
  botOrigin: { channel: string; address: Record<string, unknown> };
  /** 这一句的认领键：接话那一项的键由最后一句的拼出。 */
  claimKey: string;
}


/** 一个（机器人，群）正攒着的一批：键是这个机器人在这个群的前台会话号。 */
interface Batch {
  /** 攒着的话，按先后。 */
  heard: Heard[];
  /** 安静计时器：每来一句重新数。 */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** 到点时前台正在转：这一轮停下（session/change）再看。 */
  waiting: boolean;
}


/** 一个群今天看了几次。 */
interface Looks {
  /** 本地日期（年-月-日）：换天清零。 */
  day: string;
  /** 看了几次。 */
  count: number;
}


/**
 * 读 bots 的 group_batch（config.yaml 进来的，在 bots 的 apply 里校验一次）。
 * @param written group_batch 原样。
 * @returns 三个数都写对了是配置；没写或缺键是一句原因（bots 的 apply 打进启动日志，不开攒批）。
 * @throws 写了但不是一节、某个数写错时抛错。
 */
export function readGroupBatch(written: unknown): GroupBatchConfig | string {
  if (written === undefined) return '没写 group_batch';

  //G 写了就要是一节。
  if (typeof written !== 'object' || written === null || Array.isArray(written)) {
    throw new Error('bots 的 group_batch 要写成一节（quiet_seconds、max_lines、daily_limit）');
  }

  //M 缺了哪个键记下来：缺了就不开攒批。
  const keys = ['quiet_seconds', 'max_lines', 'daily_limit'];
  const missing = keys.filter((key) => !Object.hasOwn(written, key));
  if (missing.length > 0) return `group_batch 缺 ${missing.join('、')}`;

  //M quiet_seconds 是正数（秒，可以带小数）。
  const quiet = utils.getField(written, 'quiet_seconds');
  if (typeof quiet !== 'number' || !(quiet > 0)) {
    throw new Error('bots 的 group_batch.quiet_seconds 要写正数（秒）');
  }

  //M max_lines 是正整数（句）。
  const maxLines = utils.getField(written, 'max_lines');
  if (typeof maxLines !== 'number' || !Number.isInteger(maxLines) || maxLines <= 0) {
    throw new Error('bots 的 group_batch.max_lines 要写正整数（句）');
  }

  //M daily_limit 是非负整数（次），0 不限。
  const dailyLimit = utils.getField(written, 'daily_limit');
  if (typeof dailyLimit !== 'number' || !Number.isInteger(dailyLimit) || dailyLimit < 0) {
    throw new Error('bots 的 group_batch.daily_limit 要写非负整数（次，0 是不限）');
  }

  return { quiet_seconds: quiet, max_lines: maxLines, daily_limit: dailyLimit };
}


/**
 * 一批话写成给模型看的几行“说话人：话”。
 * @param heard 这一批。
 * @returns 一行一句。
 */
function getLines(heard: Heard[]): string[] {
  return heard.map((one) => `${frontDeskModule.getSpeaker(one.botOrigin.address)}：${one.text}`);
}


/** 群攒批：缓冲、两个触发、每天上限、问决策模型、接话排队。DispatchClaim 建它、用它。 */
export class GroupBatch {
  /** 前台会话号 → 这个（机器人，群）正攒着的一批。 */
  private readonly batches = new Map<string, Batch>();
  /** 前台会话号 → 正在判断的各批原话：被叫到时一起带进当前轮，并使迟到的回执失效。 */
  private readonly looking = new Map<string, Set<Batch>>();
  /** 群（渠道:账号:聊天）→ 今天看了几次。 */
  private readonly looks = new Map<string, Looks>();

  /**
   * 听 session/change（前台停下，看等着的那一批）；拔插件时清掉安静计时器。
   * @param ctx bots 插件的 ctx。
   * @param desk 前台：不接的一批记成背景（FrontDesk.listen）。
   * @param claims 认领：接话的一批排进前台（DispatchClaim.enqueueBatch），或转给外部助手（DispatchClaim.relayBatch）。
   * @param config 入口校验过的 group_batch；undefined 是没开攒批。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly desk: frontDeskModule.FrontDesk,
    private readonly claims: DispatchClaim,
    private readonly config: GroupBatchConfig | undefined,
  ) {
    //M 前台一轮停下：到点时它在转、标了 waiting 的那一批，现在看。
    ctx.on('session/change', (session) => {
      this.onChange(session);
    });

    //M 拔插件时清掉所有安静计时器。ctx.effect：先执行一次，交回的函数在插件被拔掉时 Cordis 来调。
    ctx.effect(() => () => {
      for (const batch of this.batches.values()) {
        clearTimeout(batch.timer);
      }
    });
  }

  /**
   * 只听的一句进这个（机器人，群）的缓冲：攒满 max_lines 句马上看，没满就从这句起重新数安静的秒数。
   * 没开攒批、不是 listen: judge 的群不收，调用方照旧记成背景。
   * @param front 这个机器人在这个群的前台。
   * @param heard 这一句。
   * @returns 收进缓冲了没有。
   */
  add(front: Session, heard: Heard): boolean {
    const config = this.config;
    if (config === undefined) return false;

    //G 不是 listen: judge 的群（地址上没 judge）：不攒。
    if (utils.getField(heard.botOrigin.address, 'judge') !== true) return false;

    //M 取这个前台的缓冲，没有就开一个；这句排进去，安静计时从头数。
    let batch = this.batches.get(front.id);
    if (batch === undefined) {
      batch = { heard: [], timer: undefined, waiting: false };
      this.batches.set(front.id, batch);
    }
    batch.heard.push(heard);
    clearTimeout(batch.timer);

    //M 触发二：攒满 max_lines 句，马上看。
    if (batch.heard.length >= config.max_lines) {
      void this.look(front.id);
      return true;
    }

    //M 触发一：从这句起安静满 quiet_seconds 秒再看；再来一句就重新数。
    const waitMs = config.quiet_seconds * 1000;
    batch.timer = setTimeout(() => {
      void this.look(front.id);
    }, waitMs);
    return true;
  }

  /**
   * 有人叫了机器人（私聊、@、引用）：拿走这个前台仍在判断及攒着的话，按先后拼成“说话人：话”。
   * 已交给当前轮的批次收到判断回执时只记流水。
   * @param frontId 前台会话号。
   * @returns 攒着的几行；没有是空数组。
   */
  take(frontId: string): string[] {
    //M 带上正在判断的各批原话，并让这几批的迟到回执只记流水。
    const pending = this.looking.get(frontId) ?? [];
    this.looking.delete(frontId);
    const pendingBatches = Array.from(pending);
    const lines = pendingBatches.flatMap((one) => getLines(one.heard));

    //M 把仍在攒着的话接在判断中的原话后面。
    const batch = this.batches.get(frontId);
    if (batch === undefined) return lines;

    //M 停掉计时器，缓冲清空，话交给叫它的这一轮。
    clearTimeout(batch.timer);
    this.batches.delete(frontId);
    const buffered = getLines(batch.heard);
    return [...lines, ...buffered];
  }

  /**
   * 渠道撤回：本人或原发信人撤回的话从缓冲里拿掉；拿空了的缓冲连计时器一起清掉。
   * @param event 渠道撤回事件。
   */
  cancelRecall(event: protocol.ChannelRecallEvent): void {
    //M 等回执的批次仍可能被当前轮取走，先去掉已撤回的消息。
    for (const pending of this.looking.values()) {
      for (const batch of pending) {
        batch.heard = batch.heard.filter((one) => !canRecall(event, one.message));
      }
    }

    for (const [frontId, batch] of this.batches.entries()) {
      //M 留下不是这条的、或撤回的人没权撤的。
      const kept = batch.heard.filter((one) => !canRecall(event, one.message));
      batch.heard = kept;
      if (kept.length > 0) continue;

      clearTimeout(batch.timer);
      this.batches.delete(frontId);
    }
  }

  /**
   * session/change：前台停下了，等着的那一批现在看。
   * @param session 状态变了的会话。
   */
  private onChange(session: Session): void {
    if (session.row.state === 'running') return;

    const batch = this.batches.get(session.id);
    if (batch?.waiting !== true) return;

    void this.look(session.id);
  }

  /**
   * 看一次这一批：前台在转就等这一轮停下；今天看满了不问；否则问决策模型，接就排进前台，不接就记成背景。
   * 一批发一次 bot/judged（地址是最后一句的，正文是这一批）。
   * @param frontId 前台会话号。
   */
  private async look(frontId: string): Promise<void> {
    const config = this.config;
    const batch = this.batches.get(frontId);
    if (config === undefined || batch === undefined) return;

    //M 前台正在转：计时器停掉，标上等，这一轮停下（session/change）再看。
    clearTimeout(batch.timer);
    const front = this.ctx.sessions.open(frontId);
    if (front.row.state === 'running') {
      batch.waiting = true;
      return;
    }

    //M 这一批拿出来，缓冲清空：再来的话攒下一批。
    this.batches.delete(frontId);
    const last = batch.heard[batch.heard.length - 1];
    if (last === undefined) return;

    const lines = getLines(batch.heard);
    const text = lines.join('\n');
    const address = last.botOrigin.address;

    //G 这个群今天看满了：不问决策模型，这一批记成背景。
    const group = `${last.message.channel}:${last.message.accountId}:${last.message.chatId}`;
    if (!this.takeLook(group, config.daily_limit)) {
      this.keep(front, batch.heard);
      const full = `judge:不看(今天看满 ${String(config.daily_limit)} 次)`;
      this.ctx.emit('bot/judged', address, text, full);
      return;
    }

    //M 等候回执时仍留住原话，以便被叫到时按先后交给当前这轮。
    let pending = this.looking.get(frontId);
    if (pending === undefined) {
      pending = new Set();
      this.looking.set(frontId, pending);
    }
    pending.add(batch);

    //M 登记批次后再发决策请求，等待期间被叫到也能取到原话。
    const judged = await this.judge(front, lines, address);
    this.ctx.emit('bot/judged', address, text, judged.outcome);

    //G 被叫到后这批已交给当前轮。迟到的回执不再排队或记背景。
    const current = this.looking.get(frontId);
    if (current?.delete(batch) !== true) return;

    if (current.size === 0) {
      this.looking.delete(frontId);
    }

    //M 不接：这一批记进前台对话当背景。
    if (!judged.reply) {
      this.keep(front, batch.heard);
      return;
    }

    //G 等判断时可能有撤回，接话只使用仍有效的话和最后一句的来源。
    const source = batch.heard.at(-1);
    if (source === undefined) return;

    //M 用剩余消息重新组成接话正文。
    const remaining = getLines(batch.heard);
    const replyText = remaining.join('\n');

    //M 群登记了 judge_helper：这一批记进前台当背景，再转给那个外部助手，不由机器人自答。
    const judgeHelper = utils.getStringField(source.botOrigin.address, 'judgeHelper');
    if (judgeHelper !== '') {
      this.keep(front, batch.heard);
      await this.claims.relayBatch(front, source, replyText, judgeHelper);
      return;
    }

    //M 其余消息仍以整批排入前台。
    this.claims.enqueueBatch(front, source, replyText);
  }

  /**
   * 这个群今天还能看吗：能就记一次。换天清零；上限 0 不限。
   * @param group 群（渠道:账号:聊天）。
   * @param limit 每天上限。
   * @returns 能看是 true（已记一次）；看满了是 false。
   */
  private takeLook(group: string, limit: number): boolean {
    //M 今天的本地日期（年-月-日）。
    const day = textModule.formatLocalTime(Date.now(), 'date').slice(0, 10);
    let looks = this.looks.get(group);
    if (looks?.day !== day) {
      looks = { day, count: 0 };
      this.looks.set(group, looks);
    }

    //G 看满了：上限不是 0、今天的次数到了。
    if (limit > 0 && looks.count >= limit) return false;

    looks.count += 1;
    return true;
  }

  /**
   * 一批话记进前台对话当背景（不接、看满了）。
   * @param front 前台。
   * @param heard 这一批。
   */
  private keep(front: Session, heard: Heard[]): void {
    for (const one of heard) {
      this.desk.listen(front, one.text, one.botOrigin.address);
    }
  }

  /**
   * 问决策模型（请求事件 decision/judge）：这一批里有没有要这个机器人接的话。没挂决策插件、超时、出错都按不接。
   * @param front 前台：机器人名。
   * @param lines 这一批（说话人：话）。
   * @param address 最后一句的地址：读 judgeThreshold。
   * @returns reply 接不接；outcome 写进 bot/judged（judge:回 / judge:不回(0.32) / judge:不回(没有决策模型)）。
   */
  private async judge(
    front: Session,
    lines: string[],
    address: Record<string, unknown>,
  ): Promise<{ reply: boolean; outcome: string }> {
    //M 题目：只有是、否两个选项；现状给这一批群聊。
    const bot = front.row.bot;
    const question = {
      instructions: `你是群里的助手 ${bot}。下面是群里最近一批没叫你的话。`
        + '这一批里有需要你接话的吗？有人在问你能回答的问题、在找你、或者明显需要帮忙时才接；闲聊、别人之间的对话、已经有人答了的，不接。',
      yes: '这一批里有需要你接话的',
      no: '这一批都不需要你接话（闲聊、别人之间的对话、已经有人答了）',
    };
    const input: decisionModule.JudgeInput = {
      kind: 'group-batch',
      bot,
      question,
      state: { 这一批群聊: lines },
    };

    //M 群登记了 judge_threshold：把握 ≥ 它才接。
    const threshold = utils.getField(address, 'judgeThreshold');
    if (typeof threshold === 'number') {
      input.allowAt = threshold;
    }

    //T 跟踪：问决策模型这一批要不要接。
    const vars = { session: front.id, lineCount: lines.length };
    this.ctx.emit('trace', 'GroupBatch.judge', 'trace.bots.judgeGroupReply', "requestEvent('decision/judge')", vars);

    //M 发 decision/judge 等回执，不掐表：decision 自己限时。
    const options = {
      prefix: 'group-batch',
      warnAfterMs: JUDGE_WARN_MS,
    };
    const asked = await requestEventModule.requestEvent(this.ctx, 'decision/judge', 'decision/judge-result', input, options);

    //G 没等到回执（没挂 decision、出错）：不接，结果写明原因。
    if (asked.why !== undefined) return { reply: false, outcome: `judge:不回(${FALLBACK_TEXT[asked.why]})` };

    const result = asked.reply;
    if (result.verdict === 'allow') return { reply: true, outcome: 'judge:回' };

    if (result.score === undefined) return { reply: false, outcome: 'judge:不回' };

    return { reply: false, outcome: `judge:不回(${result.score.toFixed(2)})` };
  }
}


/**
 * 这次撤回能不能拿掉缓冲里的这一句：消息号对得上，撤回的是本人或原发信人（渠道没给发信人号的也算）。
 * @param event 渠道撤回事件。
 * @param message 缓冲里那一句的标准消息。
 * @returns 能拿掉是 true。
 */
function canRecall(event: protocol.ChannelRecallEvent, message: protocol.ChannelMessage): boolean {
  if (message.messageId !== event.messageId) return false;

  if (event.recalledBy.isOwner) return true;

  if (event.recalledBy.kind !== 'sender') return false;

  return event.recalledBy.id === '' || event.recalledBy.id === message.sender.id;
}
