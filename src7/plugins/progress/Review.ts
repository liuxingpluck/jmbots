/**
 * 超时复盘（原 plugins/review，已并入 progress）：
 * 空闲时从 data/overtime.jsonl（progress 写的“做太久、被限时、被终止”的登记）挑一件还没复盘的，
 * 开一场小会话写“慢在哪、以后同类事怎么做”，用 approval 问用户要不要记进公共记忆；同意了写进运行时目录 memory/复盘/。
 * 启动 5 分钟后看第一次，以后每 10 分钟一次；有进度在转、或有复盘在等用户时不打扰。
 * 挑中就先在那场会话记录上记 reviewedAt，模型出错、重启都不会反复问同一件。
 * 照 0.4 src/capabilities/Review.ts。设计：docs/src7插件设计/review.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { AskInput } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import type { Progress, ProgressItem } from './index.ts';


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 复盘挑过的最后一行登记的 at（一场会话可能有好几行，一行一行往后挑）。 */
    reviewedAt?: number;
    /** 复盘送审获得登记回执后，记录待确认编号供重启后核对。 */
    reviewApprovalId?: number;
  }
}


/** 复盘子配置：放进 plugins[progress].config.review，测试时可改小时间或传 false 关闭。 */
export interface ReviewConfig {
  /** 是否开启自动复盘，默认 true。 */
  enabled?: boolean;
  /** 启动后首次检查延迟（毫秒），默认 300000（5 分钟）。 */
  first_ms?: number;
  /** 后续检查间隔（毫秒），默认 600000（10 分钟）。 */
  every_ms?: number;
}

/** 校验后的复盘配置。 */
export interface ReviewSettings {
  /** 是否启用复盘。 */
  enabled: boolean;
  /** 首次检查延迟（毫秒）。 */
  first: number;
  /** 后续检查间隔（毫秒）。 */
  every: number;
}

/** overtime.jsonl 里的一行（progress 写的）。 */
interface Entry {
  at: number;
  bot: string;
  sessionId: string;
  sessionTitle?: string;
  text: string;
  stage: string;
  usedMs: number;
  timings?: unknown;
  timingsText?: string;
}

/** 启动后多久第一次看（5 分钟）。 */
const FIRST_MS = 5 * 60_000;

/** 以后多久看一次（10 分钟）。 */
const EVERY_MS = 10 * 60_000;

/** 会话记录最多读末尾多少字。 */
const LOG_CHARS = 8000;

/** 复盘提示词（照 0.4 Review.ts:30）。 */
const PROMPT = '你在给一件做得太久的事写复盘。下面是这件事的原话、各段耗时和工作过程。'
  + '找出慢在哪里（比如同一个东西搜了好几遍、读了一堆没用上的文件、一步想了很久、本可以先看记忆却没看），'
  + '给出以后遇到同类事的做法，最多 3 条，每条一句话，后面写预计能快多少。'
  + '只写工作过程里看得出来的，看不出来就写“看不出明显的问题”。用中文，写成 Markdown 列表。';

/**
 * 取复盘显示标题：优先用会话总结标题，否则取用户原话前 20 字。
 * @param entry overtime.jsonl 里的一条登记。
 */
function getEntryTitle(entry: Entry): string {
  if (entry.sessionTitle !== undefined && entry.sessionTitle !== '') return entry.sessionTitle;

  return [...entry.text].slice(0, 20).join('');
}


/**
 * 读取并校验 progress.review 子配置（入口校验一次，内部直接使用）。
 * @param rawConfig plugins[progress].config 原值；可省略、为对象，或写 { review: false }。
 * @returns 校验后的复盘开关与定时设置。
 * @throws 配置形状或 first_ms / every_ms 不合法时抛错。
 */
export function readReviewSettings(rawConfig: unknown): ReviewSettings {
  if (rawConfig === undefined || rawConfig === null) {
    return { enabled: true, first: FIRST_MS, every: EVERY_MS };
  }
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('progress 的 config 要写成对象');
  }

  const record = rawConfig as Record<string, unknown>;
  const rawReview = record['review'];
  if (rawReview === undefined || rawReview === null) {
    return { enabled: true, first: FIRST_MS, every: EVERY_MS };
  }
  if (rawReview === false) {
    return { enabled: false, first: FIRST_MS, every: EVERY_MS };
  }
  if (typeof rawReview !== 'object' || Array.isArray(rawReview)) {
    throw new Error('progress.review 要写成 { enabled, first_ms, every_ms } 或 false');
  }

  const review = rawReview as Record<string, unknown>;
  let enabled = true;
  if (review['enabled'] !== undefined) {
    if (typeof review['enabled'] !== 'boolean') {
      throw new Error('progress.review.enabled 要写 true 或 false');
    }
    enabled = review['enabled'];
  }

  const first = review['first_ms'] ?? FIRST_MS;
  const every = review['every_ms'] ?? EVERY_MS;
  if (typeof first !== 'number' || !Number.isFinite(first) || first <= 0) {
    throw new Error('progress.review.first_ms 要是正数');
  }
  if (typeof every !== 'number' || !Number.isFinite(every) || every <= 0) {
    throw new Error('progress.review.every_ms 要是正数');
  }
  return { enabled, first, every };
}


/** 超时复盘管理器：空闲时挑一条慢任务总结建议，经 approval 同意后写入 memory/复盘/。 */
export class Review {
  /**
   * 挂 approval/decided 监听并排第一次定时检查。
   * @param ctx 复盘所在的 Cordis 上下文。
   * @param progress 同插件内的进度服务实例。
   * @param timing 首次与后续检查间隔（毫秒）。
   * 副作用：注册 approval/decided 事件监听并启动定时复盘检查任务。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly progress: Progress,
    timing: { first: number; every: number },
  ) {
    //M approval/decided（通知）：复盘那件同意了就写文件；拒绝就算了，这件不再问（reviewedAt 已经记了）。
    ctx.on('approval/decided', (pending) => {
      if (pending.kind !== 'review' || pending.state !== 'approved') return;

      const payload = pending.payload as { entry?: Entry; advice?: string; requiresReceipt?: boolean } | undefined;
      if (payload?.entry === undefined || typeof payload.advice !== 'string') return;

      //G 新送的复盘必须有登记回执，旧卡片仍按原流程处理。
      if (payload.requiresReceipt === true) {
        const query = { id: payload.entry.sessionId };

        //M 从原会话读取已确认的待审编号，重启后也能核对。
        const session = ctx.sessions.find(query)[0];
        if (session?.reviewApprovalId !== pending.id) return;
      }

      //M 用户批准写入公共记忆，将复盘建议落盘到 memory/复盘/ 供后续复用。
      const file = this.write(payload.entry, payload.advice);
      //T 跟踪：复盘写好了。
      ctx.emit('trace', 'Review.write', '复盘写进公共记忆', 'fs.writeFileSync(memory/复盘/…)', { 文件: file });
    });

    //M 定时器用普通 setTimeout，在 ctx.effect 里登记清理：插件被拔掉时清掉定时器且不再重排。
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const tick = (): void => {
      void this.check().catch((error: unknown) => {
        let message = String(error);
        if (error instanceof Error) {
          message = error.message;
        }
        console.error(`复盘出错：${message}`);
      }).finally(() => {
        if (!disposed) {
          timer = setTimeout(tick, timing.every);
        }
      });
    };
    ctx.effect(() => {
      timer = setTimeout(tick, timing.first);
      return () => {
        disposed = true;
        clearTimeout(timer);
      };
    });
  }

  /**
   * 看一次：空闲且没有等用户的复盘时，按序挑一条未复盘超时记录开小会话写建议并送审。
   * @returns 无返回值；选中项后在内部推进会话标记并送出待确认卡片。
   * 副作用：写入选中会话的 reviewedAt、发起小会话分析、向 approval 提交卡片并发送 trace 事件。
   */
  async check(): Promise<void> {
    //G 有任意任务仍在运行中时不打扰，直接跳过本轮复盘检查。
    const progress = this.progress.list() as ProgressItem[];
    if (progress.some((item) => item.endedAt === undefined)) return this.skip('有进度在转');

    const list = { action: 'list', kind: 'review' } as const;
    const listOptions = { timeoutMs: 3000, onFallback: () => ({ requestId: '', items: [] }) };

    //M 查询仍待确认的复盘，审核插件无人应答时按空列表继续。
    const listed = await requestEventModule.requestEvent(
      this.ctx, 'approval/request', 'approval/result', list, listOptions,
    );

    //G 已有待用户确认的复盘卡片时不重复打扰。
    if (listed.items !== undefined && listed.items.length > 0) return this.skip('有复盘在等用户');

    //G 尚未产生 overtime.jsonl 超时登记文件时说明无可复盘记录，直接跳过。
    const file = path.join(this.ctx.resources.dir('data'), 'overtime.jsonl');
    if (!fs.existsSync(file)) return this.skip('还没有超时登记');

    //M 按先后挑第一行：机器人还在、会话还在、它的 reviewedAt 比这一行早（或没有）。坏的行跳过。
    let entry: Entry | undefined;
    const rawLines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of rawLines) {
      if (line.trim() === '') {
        continue;
      }
      let parsed: Entry;
      try {
        parsed = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      //G 确认登记所属机器人仍存在，已移除则跳过该条记录。
      if (this.ctx.bots.get(parsed.bot) === undefined) {
        continue;
      }
      //G 核对会话是否存在且尚未复盘过本时间点记录，只选最早一条未复盘项。
      const meta = this.ctx.sessions.find({ id: parsed.sessionId })[0];
      if (meta === undefined || (meta.reviewedAt ?? 0) >= parsed.at) {
        continue;
      }
      entry = parsed;
      break;
    }
    //G 登记文件全部遍历完均已复盘或失效，记录跳过原因后退出。
    if (entry === undefined) return this.skip('登记的都复盘过了');

    //M 先记 reviewedAt 再做：模型出错、重启都不会反复问同一件。
    const session = this.ctx.sessions.open(entry.sessionId);
    session.row.reviewedAt = entry.at;
    session.save();

    //T 跟踪：挑中一件。
    const checkVars = { 会话: entry.sessionId, 结局: entry.stage, 用时: textModule.getDuration(entry.usedMs) };
    this.ctx.emit('trace', 'Review.check', '挑中一件做太久的事', 'sessions.open(entry.sessionId)', checkVars);

    const request = { action: 'mirror-dir', bot: session.row.bot, sessionId: session.id } as const;
    const options = {
      timeoutMs: 3000,
      onFallback: () => ({ requestId: '' }),
    };

    //M 向流水插件询问镜像路径，没有回应就按没有记录继续复盘。
    const mirror = await requestEventModule.requestEvent(
      this.ctx,
      'journal/request',
      'journal/result',
      request,
      options,
    );
    let log = '（没有记录：未获取到镜像）';
    if (mirror.dir !== undefined) {
      const md = path.join(mirror.dir, '对话.md');
      if (fs.existsSync(md)) {
        const content = fs.readFileSync(md, 'utf8');
        log = content.slice(-LOG_CHARS);
      }
    }

    const engine = (this.ctx.resources.raw['engine'] ?? {}) as Record<string, unknown>;
    let model = session.row.model;
    if (typeof engine['wrapup_model'] === 'string' && engine['wrapup_model'] !== '') {
      model = engine['wrapup_model'];
    }

    //M 开复盘小会话问一次。
    const text = [
      PROMPT,
      '',
      `用户的话：${entry.text}`,
      `结局：${entry.stage}，用了 ${textModule.getDuration(entry.usedMs)}`,
      `各段耗时：${entry.timingsText ?? JSON.stringify(entry.timings ?? {})}`,
      '',
      `工作过程（会话记录末尾）：\n${log}`,
    ].join('\n');
    //M 复盘沿用同插件的最低思考档查询和退路。
    const thinking = await this.progress.getThinking(model, 'low');
    const askInput: AskInput = {
      bot: entry.bot,
      kind: 'review',
      parent: entry.sessionId,
      model,
      thinking,
      text,
    };
    //M 发起复盘小会话并等待模型给出慢原因与改进建议，后续供组装送审卡片使用。
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 没做完或没写出东西 → 记一笔，不问用户。
    const advice = reply.trim();
    if (!ok || advice === '') {
      console.error(`复盘没写成：${reply}`);
      return;
    }

    //M 取任务标题拼装待审详情，准备交由 approval 让用户确认是否写入公共记忆。
    const title = getEntryTitle(entry);
    const detail = [
      advice,
      '',
      `这件事做了 ${textModule.getDuration(entry.usedMs)}（${entry.stage}），上面是看了工作过程写的建议`,
      '同意后写进公共记忆 memory/复盘/，所有机器人以后做同类事会参考它',
      '建议对就同意；不对或没用就拒绝，这件事不再问',
    ].join('\n');
    const askParams = {
      kind: 'review',
      bot: entry.bot,
      title: `复盘建议：写进公共记忆？（${title}）`,
      detail,
      payload: { entry, advice, requiresReceipt: true },
    };
    const ask = { action: 'ask', input: askParams } as const;
    const askOptions = {
      timeoutMs: 5000,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => ({
        requestId: '', error: detail ?? `审核未获回执（${reason}）`,
      }),
    };

    //M 送审成功仍需等待用户批准，才由 approval/decided 写入公共记忆。
    const asked = await requestEventModule.requestEvent(
      this.ctx, 'approval/request', 'approval/result', ask, askOptions,
    );

    //G 无人应答或登记失败按拒绝处理，记录原因供排查。
    if (asked.pending === undefined || asked.error !== undefined) {
      const rejected = `审核未确认登记，复盘按拒绝处理：${asked.error ?? '未返回待确认项'}`;
      this.skip(rejected);
      return;
    }

    //M 记住确认登记的卡片号，只有这一项获批时可以把建议写入公共记忆。
    session.row.reviewApprovalId = asked.pending.id;
    session.save();
  }

  /**
   * 写复盘文件：memory/复盘/<年月日时分>_<标题>.md，同名覆盖。
   * @param entry 超时登记项。
   * @param advice 复盘小会话给出的建议全文。
   * @returns 写出的文件绝对路径。
   */
  private write(entry: Entry, advice: string): string {
    //M 按登记时间生成时间戳，并提取且清洗任务标题作为安全文件名。
    const date = new Date(entry.at);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const year = String(date.getFullYear());
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const stamp = `${year}${month}${day}${hours}${minutes}`;
    const rawTitle = getEntryTitle(entry);
    let title = rawTitle.replace(/[\\/:*?"<>|\s\p{Cc}]+/gu, '_').replace(/^[._]+|[._]+$/gu, '');
    if (title === '') {
      title = '复盘';
    }
    //M 结合运行期公共记忆复盘目录拼出最终 Markdown 文件绝对路径并写入。
    const file = path.join(this.ctx.resources.dir('memory', '复盘'), `${stamp}_${title}.md`);
    const lines = [
      `# 复盘：${rawTitle}`,
      '',
      `- 机器人：${entry.bot}；会话：${entry.sessionId}；结局：${entry.stage}；用了 ${textModule.getDuration(entry.usedMs)}`,
      `- 用户的话：${entry.text}`,
      `- 各段耗时：${entry.timingsText ?? ''}`,
      '',
      '## 以后同类事怎么做',
      '',
      advice.trim(),
      '',
      '## 效果',
      '',
      '（下次同类事再记一笔：照这个做了没有、快了多少；没快也写上。）',
      '',
    ];
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return file;
  }

  /** 跳过这次：发跟踪事件说明原因。 */
  private skip(why: string): void {
    //T 跟踪：这次不复盘。
    this.ctx.emit('trace', 'Review.check', '这次不复盘', 'check()', { 原因: why });
  }
}
