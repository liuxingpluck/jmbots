/**
 * 复盘（docs/界面/03_进度事件和复盘设计.md 第 4 节；用户 11-06 拍板：超时登记门槛 10 分钟，复盘建议写进公共记忆前先问用户）。
 * 没有会话在跑、空闲下来以后，从超时登记（data/overtime.jsonl，Progress.ts 写的）挑一件还没复盘的，
 * 让收尾模型读它的工作过程，写出慢在哪、以后同类事怎么做、预计能快多少；发一张审核卡片问用户，
 * 同意了才写进公共记忆 memory/复盘/，不同意就跳过。一次只问一件，有一张卡在等就不再出新的。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as utils from '../utils/Utils.ts';
import type * as aiModule from './Model.ts';
import type * as approvalsModule from './Approvals.ts';
import type * as depsModule from './Deps.ts';
import type * as filesModule from './Files.ts';
import * as progressModule from './Progress.ts';
import type * as resourcesModule from '../resources/Resources.ts';
import type * as storeModule from './Store.ts';


/** 多久看一次，毫秒。 */
const CHECK_MS = 10 * 60_000;

/** 启动后等多久才第一次看，毫秒。 */
const FIRST_CHECK_MS = 5 * 60_000;

/** 会话记录最多读末尾多少字给模型。 */
const LOG_CHARS = 8000;

/** 怎么写复盘。 */
const REVIEW_PROMPT = '你在给一件做得太久的事写复盘。下面是这件事的原话、各段耗时和工作过程。找出慢在哪里（比如同一个东西搜了好几遍、读了一堆没用上的文件、一步想了很久、本可以先看记忆却没看），给出以后遇到同类事的做法，最多 3 条，每条一句话，后面写预计能快多少。只写工作过程里看得出来的，看不出来就写“看不出明显的问题”。用中文，写成 Markdown 列表。';


/** 超时登记里的一行（Progress.ts 写的）。 */
interface OvertimeEntry {
  /** 结束的时间，毫秒。 */
  at: number;
  /** 哪个机器人。 */
  bot: string;
  /** 会话。 */
  sessionId?: string;
  /** 会话标题。 */
  sessionTitle?: string;
  /** 用户的话（截短）。 */
  text: string;
  /** 结局。 */
  stage: string;
  /** 用了多久，毫秒。 */
  usedMs: number;
  /** 各段耗时。 */
  timings: progressModule.ProgressTimings;
}


/**
 * 定时复盘：空闲时挑一件做太久的事写复盘，问用户要不要写进公共记忆。
 * 入口 src/entries/App.ts 建一个，调 start()。
 */
export class RunReview {
  /** 正在等用户决定的复盘卡片号；这个进程记着的。 */
  private pendingId: number | undefined;

  /** 是否已经停了：stop() 之后不再约下一次。 */
  private stopped = false;

  /** 下一次看的定时器。 */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param resources 运行时资源：运行时目录、机器人列表、设置、默认模型；入口建。
   * @param store 数据库：查有没有会话在跑、查那件事的会话；入口建。
   * @param files 文件库：读会话记录；入口建。
   * @param ai 模型：写复盘调一次；入口建。
   * @param approvals 待确认登记表：复盘建议挂一条待确认；入口建。
   * @param out 往渠道发东西的出口：渠道中心 ChannelHub（src/channels/index.ts），入口 src/entries/App.ts 最先建它，
   *   渠道开起来以前发会报“渠道没开”。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly store: storeModule.Store,
    private readonly files: filesModule.Files,
    private readonly ai: aiModule.Ai,
    private readonly approvals: approvalsModule.Approvals,
    private readonly out: depsModule.Outlet,
  ) {}

  /**
   * 开始定时复盘。
   * 副作用：起一个一直跑的定时器（每 10 分钟看一次，启动后 5 分钟第一次看）。
   */
  start(): void {
    this.stopped = false;
    this.timer = setTimeout(() => this.tick(), FIRST_CHECK_MS);
  }

  /** 停下：清掉定时器，不再看。 */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * 看一次：空闲、没有卡片在等时，挑一件没复盘的事写复盘、发卡片问用户。
   * 副作用：读写 data/ 里的登记；调一次模型；发审核卡片；用户同意后写公共记忆。
   */
  async check(): Promise<void> {
    //G 有卡片在等、有会话在跑：不打扰。
    if (this.pendingId !== undefined
      && this.approvals.list().some((item) => item.id === this.pendingId)) {
      return;
    }
    if (this.resources.listBots()
      .some((bot) => this.store.listSessions(bot.name, { status: 'running' }).length > 0)) {
      return;
    }
    /** 超时登记的全部文字。 */
    const overtimeText = await fs
      .readFile(path.join(this.resources.dir, 'data', 'overtime.jsonl'), 'utf8')
      .catch(() => '');
    /** 登记的每一行。 */
    const lines = overtimeText.split('\n').filter(Boolean);
    /** 复盘进度文件里的文字。 */
    const reviewedText = await fs.readFile(this.reviewedFile(), 'utf8').catch(() => '{}');
    /** 已经复盘过几行。 */
    const done = Number(reviewedText.match(/\d+/)?.[0] ?? 0);
    if (done >= lines.length) {
      return;
    }
    //M 先记下这一行看过了，模型出错、程序重启都不会反复问同一件事。
    await fs.writeFile(this.reviewedFile(), JSON.stringify({ lines: done + 1 }), 'utf8');
    /** 这件事。 */
    let entry: OvertimeEntry;
    try {
      entry = JSON.parse(lines[done]!) as OvertimeEntry;
    } catch {
      return;
    }
    //G 历史超时登记可以保留，停用机器人不能因此继续调用模型或发卡片。
    if (!this.resources.listBots().some((bot) => bot.name === entry.bot)) {
      return;
    }
    /** 会话。 */
    const session = entry.sessionId ? this.store.getSession(entry.sessionId) : undefined;
    /** 会话记录的末尾。 */
    let log = '';
    if (session) {
      /** 会话记录文件。 */
      const mdFile = this.files.sessionFiles(session).md;
      const sessionMd = await fs.readFile(mdFile, 'utf8').catch(() => '');
      log = sessionMd.slice(-LOG_CHARS);
    }
    /** 模型。 */
    const model = this.resources.getSetting('wrapupModel')
      ?? session?.model
      ?? this.resources.getDefaultModel();
    if (!model) {
      return;
    }
    /** 最低的思考档。 */
    const thinking = this.ai.listModels()
      .find((item) => item.id === model)?.thinking.find((level) => level !== 'off');
    /** 用了多久。 */
    const usedText = progressModule.formatDuration(entry.usedMs);
    /** 给模型的话。 */
    const message: piAi.Message = {
      role: 'user',
      content: [
        `用户的话：${entry.text}`,
        `结局：${entry.stage}，用了 ${usedText}`,
        `各段耗时：${JSON.stringify(entry.timings)}`,
        '',
        `工作过程（会话记录末尾）：\n${log || '（没有记录）'}`,
      ].join('\n'),
      timestamp: Date.now(),
    };
    /** 调模型的参数。 */
    const chatArgs = {
      model,
      thinking,
      system: { prompt: REVIEW_PROMPT },
      purpose: 'review',
      bot: entry.bot,
      sessionId: entry.sessionId,
      messages: [message],
      tools: [],
    };
    /** 复盘建议。 */
    const output = await this.ai.chat(chatArgs);
    if (output.error || !output.text.trim()) {
      console.error(`${utils.formatTime()} 复盘没写成：${output.error ?? '模型没回话'}`);
      return;
    }
    //M 问用户：同意了才写进公共记忆（用户 11-06：写进公共记忆这一步要先问）。
    /** 待确认。 */
    const asked = this.approvals.ask({
      bot: entry.bot,
      sessionId: '',
      title: `复盘建议：写进公共记忆？（${entry.sessionTitle || utils.truncate(entry.text, 20)}）`,
      command: output.text.trim(),
      workDir: '',
      review: {
        what: `这件事做了 ${usedText}（${entry.stage}），上面是收尾模型看了工作过程写的建议`,
        risk: '同意后写进公共记忆 memory/复盘/，所有机器人以后做同类事会参考它',
        advice: '建议对就同意；不对或没用就拒绝，这件事不再问',
      },
    });
    this.pendingId = asked.id;
    /** 那条待确认。 */
    const pending = this.approvals.list().find((item) => item.id === asked.id)!;
    await this.out.sendApproval('http', {}, pending).catch(() => [] as string[]);
    void asked.wait
      .then(async (decision) => {
        if (decision.approve) {
          const written = await this.writeReview(entry, output.text);
          console.log(`${utils.formatTime()} 复盘已写进公共记忆：${written}`);
        }
      })
      .catch((error: unknown) => {
        console.error(`${utils.formatTime()} 复盘没写进公共记忆：${utils.errorText(error)}`);
      });
  }

  /** 看一次，再约下一次；出错不能让它停下。 */
  private tick(): void {
    void this.check()
      .catch((error: unknown) => {
        console.error(`${utils.formatTime()} 复盘出错：${utils.errorText(error)}`);
      })
      .finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(() => this.tick(), CHECK_MS);
        }
      });
  }

  /** 已经复盘过几行的记录文件（data/overtime_reviewed.json）。 */
  private reviewedFile(): string {
    return path.join(this.resources.dir, 'data', 'overtime_reviewed.json');
  }

  /**
   * 写一份复盘进公共记忆。
   * @param entry 那件事。
   * @param advice 复盘建议。
   * @returns 写到的文件。
   */
  private async writeReview(entry: OvertimeEntry, advice: string): Promise<string> {
    /** 文件名里的时间（年月日时分）。 */
    const stamp = utils.formatTime(entry.at).replace(/\D/g, '').slice(0, 12);
    /** 文件名里的标题。 */
    const title = utils.safeFolderName(entry.sessionTitle || entry.text.slice(0, 20));
    /** 文件。 */
    const file = path.join(this.resources.dir, 'memory', '复盘', `${stamp}_${title}.md`);
    /** 套成一张已结束的卡片，借 describeTimings 说各段耗时。 */
    const view: progressModule.ProgressView = {
      id: 0,
      bot: entry.bot,
      messageIds: [],
      text: entry.text,
      stage: 'done',
      action: '',
      startedAt: entry.at - entry.usedMs,
      endedAt: entry.at,
      timings: entry.timings,
    };
    /** 用了多久。 */
    const usedText = progressModule.formatDuration(entry.usedMs);
    /** 正文。 */
    const text = [
      `# 复盘：${entry.sessionTitle || entry.text}`,
      '',
      `- 机器人：${entry.bot}；会话：${entry.sessionId ?? '（无）'}；结局：${entry.stage}；用了 ${usedText}`,
      `- 用户的话：${entry.text}`,
      `- 各段耗时：${progressModule.describeTimings(view)}`,
      '',
      '## 以后同类事怎么做',
      '',
      advice.trim(),
      '',
      '## 效果',
      '',
      '（下次同类事再记一笔：照这个做了没有、快了多少；没快也写上。）',
      '',
    ].join('\n');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    return file;
  }
}
