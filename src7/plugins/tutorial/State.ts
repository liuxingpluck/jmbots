/**
 * 运行时的快照：只给带关键词（tutorial 配置 snapshot_keyword，默认 #调试）的那条消息拍。
 * 属于它的每个事件、每个跟踪点（和 journal 记的跟踪行一一对应）拍一份运行时变量（plugins/tutorial/Snapshot.ts 的 snapshotOf），
 * 只放内存，留最近 SHOTS_MAX 份，重启就没（停拍时已写成文件）。还没写成文件的消息点中一步时，按 journal 的行对回这里的快照。
 * 怎么认“属于它”：
 *   web-api 收下的那条（web-api/received 的原文带关键词）→ 记下消息号，带这个消息号的行都拍，回话写回收件表（web-api/replied）就撤；
 *   机器人收到的那条（bot/receive 的原文带关键词，这里先把关键词去掉再往下传）→ 分到会话之前什么都拍（这时的行还没有会话号），
 *   分到会话后只拍这场会话、和这一轮里冒出来的子会话（row.parent 是它的），各自这一轮结束（状态不再是 running）就撤；
 *   web-api 接着已有会话发（走 Bot.hand，不发 bot/receive）→ web-api 调 ctx.flow.mark：去掉关键词、直接记下那场会话。
 *   三处认关键词共用 strip。留最近 SHOTS_MAX 份，加起来不超过 snapshot_max_mb。
 * 停拍：web-api 收下的那条回话写回了、而且没有别的要拍了（isIdle），交给 Files.ts 写成 data/flow/<消息号>.json。
 * 没有要拍的消息时，两个监听第一步就回，不拼行、不遍历。
 * 拍在 internal/dispatch 那一刻：Cordis 先发它、再挨个调听的人，所以一份快照是“这个事件发出时”的样子。
 */
import type * as cordis from 'cordis';
import * as snapshotModule from './Snapshot.ts';
import * as traceUtils from '../../utils/Trace.ts';
import type { FlowFiles } from './Files.ts';
import { NOISE, type TrailLine } from './Trail.ts';


/** 运行时留最近几份。 */
export const SHOTS_MAX = 500;

/** 快照和 journal 的行对时刻，差多少毫秒以内算同一下（两边各自取 Date.now()）。 */
const MATCH_MS = 50;

/** 带关键词的 bot/receive 等分会话最多等多久，毫秒：没人分（出错、被别的插件吞了）就不再“什么都拍”。 */
const PENDING_MS = 10_000;


/** bot/receive 的 event 里这里用到的（不 import bots 插件）。 */
interface ReceiveLike {
  /** 管分派的插件填的会话。 */
  session?: { id: string };
  /** 前面的插件已经处理掉了。 */
  handled?: boolean;
}


/** 拍下的一份。 */
export interface Shot {
  /** 什么时刻，毫秒时间戳。 */
  at: number;
  /** 和 journal 的行一样：函数（跟踪点）还是事件。 */
  kind: string;
  /** 跟踪点是“模块.函数”，事件是事件名。 */
  name: string;
  /** 哪场会话；认法和 journal 一样。 */
  session: string | null;
  /** 收件表消息号；认法和 journal 一样（跟踪点的“消息号”、事件参数里的 messageId）。 */
  message: number | null;
  /** 这一刻的运行时变量（全量原样）。 */
  groups: snapshotModule.StateGroup[];
  /** 这一份新占的字节数（沿用上一份的组不算），拍的时候算一次（snapshotModule.bytesOf）。 */
  bytes: number;
}


/** 运行时的快照，最近 SHOTS_MAX 份，加起来不超过 maxBytes。 */
export class Shots {
  /** 按先后排的快照。 */
  private readonly list: Shot[] = [];

  /** list 里各份 bytes 的和。 */
  private total = 0;

  /** 要拍的会话：带关键词的消息进的那场，和这一轮里冒出来的子会话；各自这一轮结束就撤。 */
  private readonly sessions = new Set<string>();

  /** 要拍的收件表消息号：web-api 收下的带关键词的那条；回话写回就撤。 */
  private readonly messages = new Set<number>();

  /** 带关键词、还没分到会话的 bot/receive，和收到的时刻。 */
  private pending: { event: ReceiveLike; at: number }[] = [];

  /** 回话已写回、等停拍后写文件的消息号。 */
  private done: number[] = [];

  /**
   * 挂上三个监听：bot/receive（排最前，认关键词、去掉它）、跟踪点 trace、Cordis 的 internal/dispatch（后两个和 journal 记行的是同两个）。
   * @param ctx tutorial 的 ctx。
   * @param keyword 带它的消息才拍；tutorial 的 apply 校验过，不是空串。
   * @param maxBytes 快照加起来最多占多少字节（tutorial 配置 snapshot_max_mb 换算的），apply 校验过。
   * @param files 停拍时把这条消息写成文件。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly keyword: string,
    private readonly maxBytes: number,
    private readonly files: FlowFiles,
  ) {
    //M prepend：排在管分派的插件前面，它们拿到的已经是去掉关键词的话，模型看不到。
    this.ctx.on('bot/receive', (event) => {
      const stripped = this.strip(event.message.text);
      if (stripped === undefined) return;

      event.message.text = stripped;
      this.pending.push({ event, at: Date.now() });
    }, true);

    this.ctx.on('trace', (where, _text, _code, vars) => {
      //G 没有要拍的消息：第一步就回。
      if (this.isIdle()) return;

      const rawSession = vars['会话'] ?? vars['session'];
      const rawMessage = vars['消息号'];
      let session: string | null = null;
      if (typeof rawSession === 'string') {
        session = rawSession;
      }
      let message: number | undefined;
      if (typeof rawMessage === 'number') {
        message = rawMessage;
      }
      const shotArgs = {
        kind: '函数',
        name: where,
        session,
        message,
        state: undefined,
      };
      //M 汇总跟踪点所属会话与消息号后，交由快照筛选器决定是否拍下此刻状态。
      this.consider(shotArgs);
    });

    this.ctx.on('internal/dispatch', (mode, event, args) => {
      //M 收到入口消息事件时立即检查关键词，避免后续异步调度时遗漏登记。
      if (event === 'web-api/received') this.onReceived(args[0]);
      //G 没有要拍的消息：第一步就回，不拼行、不遍历。
      if (this.isIdle()) return;
      //G 和 journal 一样不记跟踪点自己、Cordis 内部的；轨迹里不要的杂事件（NOISE）也不拍。
      if (typeof event !== 'string' || event === 'trace' || event.startsWith('internal/') || NOISE.has(event)) return;

      //M 按跟踪日志同款规则提取事件里的会话号与消息号，供后续命中判断。
      const line = traceUtils.dispatchLine(this.ctx, mode, event, args, 1);
      let rawState: unknown;
      if (event === 'session/change') {
        rawState = line.vars['状态'];
      }
      let state: string | undefined;
      if (typeof rawState === 'string') {
        state = rawState;
      }
      const shotArgs = {
        kind: '事件',
        name: event,
        session: line.session ?? null,
        message: line.messageId,
        state,
      };
      //M 把事件行上下文送入筛选器判断是否抓拍及何时停拍。
      this.consider(shotArgs);
    });
  }

  /**
   * 认关键词，三处共用：bot/receive、web-api/received、web-api 接着已有会话发（mark）。
   * @param text 用户的话。
   * @returns 带关键词：去掉它（再去掉两头空白）的话；不带是 undefined。
   */
  private strip(text: string): string | undefined {
    if (!text.includes(this.keyword)) return undefined;

    return text.replaceAll(this.keyword, '').trim();
  }

  /**
   * web-api 接着已有会话发（走 Bot.hand，不发 bot/receive）时调（ctx.flow.mark）：带关键词就记下这场会话要拍。
   * @param text 用户的话。
   * @param sessionId 交给哪一场。
   * @returns 去掉关键词的话；不带原样交回。
   */
  mark(text: string, sessionId: string): string {
    //M 先剔除消息中的快照关键词，未命中则原样放行。
    const stripped = this.strip(text);
    if (stripped === undefined) return text;

    //M 命中关键词后把对应会话号加入监控集合，确保本轮事件都被拍下。
    this.sessions.add(sessionId);
    return stripped;
  }

  /**
   * 这条消息现在内存里有没有快照（正在拍，或已拍还没被挤掉）。
   * @param message 收件表消息号。
   */
  hasMessage(message: number): boolean {
    if (this.messages.has(message)) return true;

    return this.list.some((item) => item.message === message);
  }

  /** 没有要拍的消息。 */
  private isIdle(): boolean {
    return this.sessions.size === 0 && this.messages.size === 0 && this.pending.length === 0;
  }

  /**
   * web-api 收下一条：原文带关键词就记下消息号。
   * @param payload web-api/received 的参数（Timeline.insert 发的 { id, text, … }）。
   */
  private onReceived(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;

    const { id, text } = payload as { id?: unknown; text?: unknown };
    //M 校验负载里的消息号和正文合法且命中关键词，命中后记入待抓拍消息集合。
    if (typeof id === 'number' && typeof text === 'string' && this.strip(text) !== undefined) this.messages.add(id);
  }

  /**
   * 一行该不该拍：该拍就拍；这一轮结束的会话、写回的消息撤掉。
   * @param line 种类、名字、会话、消息号；session/change 带状态。
   */
  private consider(line: { kind: string; name: string; session: string | null; message: number | undefined; state: string | undefined }): void {
    //M 带关键词的 bot/receive 分到会话了：记下这场会话。
    const now = Date.now();
    this.pending = this.pending.filter(({ event, at }) => {
      if (event.session !== undefined) this.sessions.add(event.session.id);
      return event.session === undefined && event.handled !== true && now - at < PENDING_MS;
    });

    //M 判断当前行是否属于仍在监控中的请求、带词消息或已布防会话（含子会话）。
    const mine = line.message !== undefined && this.messages.has(line.message);
    const wanted = this.pending.length > 0 || mine || (line.session !== null && this.isArmed(line.session));
    if (!wanted) return;

    //M 立即抓拍此刻运行时变量快照，若本轮结束或已回写则撤除监控。
    this.take(line.kind, line.name, line.session, line.message ?? null);
    if (line.session !== null && line.state !== undefined && line.state !== 'running') this.sessions.delete(line.session);
    if (line.name === 'web-api/replied' && line.message !== undefined && this.messages.delete(line.message)) this.done.push(line.message);

    //M 停拍：回话写回了、也没有别的要拍了（会话这一轮也结束了），写成文件。
    if (this.done.length === 0 || !this.isIdle()) return;

    for (const message of this.done) {
      //M 逐条把抓拍结果落盘写入 data/flow/<消息号>.json 供画布长期查看。
      this.files.writeMessage(message, this);
    }
    this.done = [];
  }

  /**
   * 这场会话要不要拍：记下的，或者它的上一级（row.parent）要拍——子会话第一次露面时记下。
   * @param id 会话号。
   */
  private isArmed(id: string): boolean {
    if (this.sessions.has(id)) return true;

    //M 当前会话不在集合中时向上查父会话是否被监控，借此连带捕捉派生子会话。
    const parent = this.ctx.get('sessions')?.['live'].get(id)?.row.parent;
    if (parent === undefined || !this.isArmed(parent)) return false;

    //M 确认父会话处于监控态后把当前子会话一并登记，免去后续重复回溯。
    this.sessions.add(id);
    return true;
  }

  /**
   * 拍一份，放到最后；超过 SHOTS_MAX 份、或加起来超过 maxBytes，从最老的扔（最新这份总留着）。
   * 大小是估的：沿用上一份的组不重复计；扔掉一份时，后一份沿用它的组不补算，所以实际占的会比 total 略多。
   * @param kind 函数还是事件。
   * @param name 跟踪点名或事件名。
   * @param session 哪场会话。
   * @param message 收件表消息号。
   */
  private take(kind: string, name: string, session: string | null, message: number | null): void {
    //M 以上一份快照作基线收集本刻运行时变量并估算新增内存占用。
    const previous = this.list.at(-1)?.groups ?? [];
    const groups = snapshotModule.getSnapshot(this.ctx, previous);
    const bytes = snapshotModule.getBytes(groups, previous);
    this.list.push({ at: Date.now(), kind, name, session, message, groups, bytes });
    this.total += bytes;

    while (this.list.length > 1 && (this.list.length > SHOTS_MAX || this.total > this.maxBytes)) {
      this.total -= this.list.shift()?.bytes ?? 0;
    }
  }

  /**
   * 一串 journal 的行各自对应的那份：按先后一一往后对，种类、名字、会话、消息号一样、时刻差在 MATCH_MS 内。
   * @param lines 按先后排的行（一条请求挑出来的）。
   * @returns 和 lines 一一对应；早就被挤掉的、flow 挂上之前的是 undefined。
   */
  getMatched(lines: TrailLine[]): (Shot | undefined)[] {
    let from = 0;
    return lines.map((line) => {
      for (let index = from; index < this.list.length; index += 1) {
        const shot = this.list[index];
        if (shot === undefined || shot.at > line.at + MATCH_MS) break;

        const same = shot.kind === line.kind
          && shot.name === line.name
          && shot.session === line.sessionId
          && shot.message === line.messageId
          && shot.at >= line.at - MATCH_MS;
        if (!same) continue;

        from = index + 1;
        return shot;
      }
      return undefined;
    });
  }
}
