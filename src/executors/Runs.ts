/**
 * 命令窗口（docs/界面/08_命令窗口.md 第 1 节）：外面的 AI（Claude、grokbots）把命令发给 jmbots，在这台机器上直接跑，不开会话、不经过大模型。
 * 用户 11-06：“给 jmbots 增加一个能够动态执行 exe 命令的窗口……这种风险级别的操作一定是要有一个拦截和判断审核的”。
 * 审核走 ExecReviewer.reviewCommand（程序的规矩、决策模型）；执行走 Tools.startShell（和 exec 工具同一套）。
 * 每条一个记录文件和一个输出文件，放在运行时 data/runs/，只留最近 RUNS_KEEP 条；程序重启时没跑完的记成 failed。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tools from '../capabilities/tools/Tools.ts';
import * as truncate from '../capabilities/tools/Truncate.ts';
import * as utils from '../utils/Utils.ts';
import * as checks from '../utils/Checks.ts';
import * as execReview from './ExecReview.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 一条命令到了哪一步：pending 审核中或等用户决定、running 在跑、done 退出码 0、failed 退出码不是 0 或超时或出错、rejected 没让跑、stopped 被停下。 */
export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'stopped';


/** 一条命令的记录（存成 data/runs/<号>.json）。 */
export interface RunRecord {
  /** 号：时间加随机数（和会话号同样的写法），按字面排就是按时间排。 */
  id: string;
  /** 命令。 */
  command: string;
  /** 在哪个目录跑。 */
  cwd: string;
  /** 为什么跑（发命令的写的）。 */
  why: string;
  /** 谁发的。 */
  from: string;
  /** 超时，秒。 */
  timeoutSec: number;
  /** 到了哪一步。 */
  status: RunStatus;
  /** 审核：谁定的（rule、decision、user）、哪条规矩、决策模型和“安全”的概率、为什么、审了多久（毫秒）。 */
  review: {
    /** 决策来源。 */
    by: string;
    /** 命中的程序规则。 */
    rule?: string;
    /** 参与审核的模型。 */
    model?: string;
    /** 模型给出的安全概率。 */
    probability?: number;
    /** 审核理由。 */
    reason: string;
    /** 审核耗时，毫秒。 */
    ms: number;
  };
  /** 等用户决定时的待确认号。 */
  approvalId?: number;
  /** 发来的时间，毫秒。 */
  createdAt: number;
  /** 开始跑的时间，毫秒。 */
  startedAt?: number;
  /** 结束的时间（跑完、被拒、被停下），毫秒。 */
  endedAt?: number;
  /** 退出码；被杀时是 null。 */
  code?: number | null;
  /** 是不是超时被杀的。 */
  timedOut?: boolean;
  /** 出错原因（起不来、目录不存在、用户拒绝、程序重启）。 */
  error?: string;
  /** 输出文件（stdout、stderr 合在一起）的绝对路径。 */
  log: string;
}


/** 发来的一条命令。 */
export interface RunInput {
  /** 命令。 */
  command: string;
  /** 入口已经确定的运行目录。 */
  cwd: string;
  /** 入口已经确定的超时秒数，范围 1–RUN_TIMEOUT_MAX_SEC。 */
  timeoutSec: number;
  /** 为什么跑：给决策模型看，也记下来。 */
  why: string;
  /** 入口已经确定的来源。 */
  from: string;
  /** 决策模型说不安全时，发审核卡片等用户决定（默认不发，直接把结论交回去）。 */
  askUser: boolean;
}


/** 默认超时，秒。 */
export const RUN_TIMEOUT_SEC = checks.RUN_TIMEOUT_SEC;

/** 最长超时，秒。 */
export const RUN_TIMEOUT_MAX_SEC = checks.RUN_TIMEOUT_MAX_SEC;

/** 只留最近多少条。 */
const RUNS_KEEP = 300;

/** 输出结尾留多少行。 */
const TAIL_LINES = 200;

/** 输出结尾留多少字节。 */
const TAIL_BYTES = 20_000;

/** 读输出结尾时从文件末尾读多少字节（再按行截）。 */
const TAIL_READ_BYTES = 64 * 1024;

/** 等用户决定、等跑完时多久看一次，毫秒。 */
const WAIT_POLL_MS = 500;

/** 结束了的状态。 */
const ENDED: RunStatus[] = ['done', 'failed', 'rejected', 'stopped'];


/**
 * 命令窗口：一个进程一个，入口 src/entries/App.ts 建，传给 HTTP 渠道的 /api/run*。
 * 记录表和在跑的命令表是它的私有字段；构造时读出以前的记录，没跑完的记成 failed。
 */
export class Runs {
  /** 记录和输出放哪（运行时 data/runs/）。 */
  private readonly dir: string;

  /** 号 → 记录（启动时从文件读，之后以内存为准）。 */
  private readonly records = new Map<string, RunRecord>();

  /** 在跑的：号 → 停下用的函数、跑完时兑现的 Promise。 */
  private readonly active = new Map<string, { stop: () => void; done: Promise<void> }>();

  /**
   * 建命令窗口：读出以前的记录，没跑完的记成 failed。
   * @param resources 资源（src/resources/Resources.ts）：运行时目录、工具目录。入口建的。
   * @param approvals 待确认（src/capabilities/Approvals.ts）：停下时作废等用户的卡片。入口建的。
   * @param reviewer 命令审核器（src/executors/ExecReview.ts 的 ExecReviewer）：入口建的，
   *   会话里的 exec 和这里共用；审核结果的出口它自己用的时候取。
   * 副作用：建 data/runs/；改没跑完的记录。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly approvals: approvalsModule.Approvals,
    private readonly reviewer: execReview.ExecReviewer,
  ) {
    this.dir = path.join(resources.dir, 'data', 'runs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadRecords();
    this.prune();
  }

  /**
   * 发来一条：审核，过了就开始跑。输出这条的记录，不等跑完。
   * @param input 发来的命令。
   * @returns 这条的记录（发出去那一刻的样子）。
   * 副作用：写文件、可能调决策模型、发卡片、起子进程。
   */
  async start(input: RunInput): Promise<RunRecord> {
    //M 建记录：目录和超时由入口确定，这里只生成记录号并保存。
    /** 号。 */
    const id = utils.createSessionId();
    /** 记录。 */
    const record: RunRecord = {
      id,
      command: input.command,
      cwd: input.cwd,
      why: input.why,
      from: input.from,
      timeoutSec: input.timeoutSec,
      status: 'pending',
      review: {
        by: 'rule',
        reason: '审核中',
        ms: 0,
      },
      createdAt: Date.now(),
      log: path.join(this.dir, `${id}.log`),
    };
    this.records.set(id, record);
    this.save(record);
    this.prune();

    //M 审核：规矩、决策模型；不安全就不跑，结论交回去（写了 askUser 才发卡片等用户）。
    /** 要审的东西。 */
    const reviewInput: execReview.CommandReviewInput = {
      command: record.command,
      workDir: record.cwd,
      task: `${record.from} 通过命令窗口要跑这条命令：${record.why || '（没写为什么）'}`,
      askUser: input.askUser,
    };
    /** 审核结果。 */
    const reviewed = await this.reviewer.reviewCommand(reviewInput);
    /** 审核记录。 */
    const verdict = reviewed.record;
    record.review = {
      by: verdict.by,
      rule: verdict.rule,
      model: verdict.decision?.model,
      probability: verdict.decision?.probability,
      reason: verdict.reason,
      ms: verdict.ms,
    };
    //G 审核期间被停下了：不跑，卡片（如果发了）作废。
    if (record.status !== 'pending') {
      if (verdict.approval) {
        this.approvals.decide(verdict.approval.id, false, '命令窗口：发命令的停下了');
      }
      this.save(record);
      return { ...record };
    }
    if (verdict.verdict === 'reject') {
      record.status = 'rejected';
      this.close(record);
      return { ...record };
    }
    if (verdict.verdict === 'pending' && reviewed.wait) {
      record.approvalId = verdict.approval?.id;
      this.save(record);
      //M 用户决定了：同意就跑，拒绝就记成 rejected；这期间被停下了就不管了。
      void reviewed.wait.then((decision) => {
        if (record.status !== 'pending') {
          return;
        }
        if (decision.approve) {
          record.review = { ...record.review, by: 'user', reason: `用户同意（${decision.by}）` };
          this.launch(record);
          return;
        }
        record.status = 'rejected';
        record.error = `用户拒绝（${decision.by}）`;
        this.close(record);
      });
      return { ...record };
    }
    //M 审核过了：开始跑。
    this.launch(record);
    return { ...record };
  }

  /**
   * 一条的记录。只读。
   * @param id 号。
   * @returns 记录的副本；没有是 undefined。
   */
  get(id: string): RunRecord | undefined {
    /** 记录。 */
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  /**
   * 最近的几条，新的在前。只读。
   * @param limit 最多几条。
   * @returns 记录的副本。
   */
  list(limit: number): RunRecord[] {
    return [...this.records.values()]
      .sort((left, right) => right.id.localeCompare(left.id))
      .slice(0, Math.max(0, limit))
      .map((record) => ({ ...record }));
  }

  /**
   * 等一条结束，最多等 ms 毫秒。只读。
   * @param id 号。
   * @param ms 最多等多久，毫秒。
   * @returns 那时的记录；没有这条是 undefined。
   */
  async wait(id: string, ms: number): Promise<RunRecord | undefined> {
    /** 等到什么时候。 */
    const deadline = Date.now() + ms;
    for (;;) {
      /** 记录。 */
      const record = this.records.get(id);
      /** 还剩多久。 */
      const left = deadline - Date.now();
      //G 停下的状态先记上、进程还没退：接着等它退。
      if (
        !record ||
        (ENDED.includes(record.status) && !this.active.has(id)) ||
        left <= 0
      ) {
        return record ? { ...record } : undefined;
      }
      /** 在跑的：等它跑完或等到点；还在审核、等用户时隔一会儿再看。 */
      const running = this.active.get(id);
      /** 到点。 */
      const timer = new Promise((resolve) => {
        setTimeout(resolve, running ? left : Math.min(left, WAIT_POLL_MS));
      });
      await (running ? Promise.race([running.done, timer]) : timer);
    }
  }

  /**
   * 输出的结尾（最后 TAIL_LINES 行、TAIL_BYTES 字节）。只读。
   * @param id 号。
   * @returns 结尾；还没有输出是空字符串。
   */
  tail(id: string): string {
    /** 输出文件。 */
    const file = this.records.get(id)?.log;
    if (!file || !fs.existsSync(file)) {
      return '';
    }
    /** 文件多大。 */
    const size = fs.statSync(file).size;
    /** 从哪读起。 */
    const from = Math.max(0, size - TAIL_READ_BYTES);
    /** 读出来的结尾。 */
    const buffer = Buffer.alloc(size - from);
    /** 文件句柄。 */
    const handle = fs.openSync(file, 'r');
    try {
      fs.readSync(handle, buffer, 0, buffer.length, from);
    } finally {
      fs.closeSync(handle);
    }
    /** 文字；不是从头读的，第一行可能只有半截，扔掉。 */
    const text = from > 0
      ? buffer.toString('utf8').replace(/^[^\n]*\n/, '')
      : buffer.toString('utf8');
    /** 截好的结尾。 */
    const result = truncate.truncateTail(text, { maxLines: TAIL_LINES, maxBytes: TAIL_BYTES });
    /** 开头的提示：只留了一段时告诉怎么看全部。 */
    const note = result.truncated || from > 0
      ? `[只留了最后一段，全部输出用 /api/runs/${id}/log 看]\n`
      : '';
    return `${note}${result.content}`;
  }

  /**
   * 输出文件的路径。只读。
   * @param id 号。
   * @returns 路径；没有这条或还没有输出是 undefined。
   */
  logFile(id: string): string | undefined {
    /** 输出文件。 */
    const file = this.records.get(id)?.log;
    return file && fs.existsSync(file) ? file : undefined;
  }

  /**
   * 停下一条：在跑的连子进程一起杀，在等用户的作废那张卡片。
   * @param id 号。
   * @returns 记录；没有这条是 undefined。
   * 副作用：写文件、杀进程。
   */
  stop(id: string): RunRecord | undefined {
    /** 记录。 */
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    if (ENDED.includes(record.status)) {
      return { ...record };
    }
    //M 先记成 stopped，再杀进程、作废卡片：跑完和用户决定的回调看到 stopped 就不改了。
    /** 原来的状态。 */
    const was = record.status;
    record.status = 'stopped';
    record.error = '被停下了';
    if (was === 'running') {
      this.save(record);
      this.active.get(id)?.stop();
      return { ...record };
    }
    if (record.approvalId !== undefined) {
      this.approvals.decide(record.approvalId, false, '命令窗口：发命令的停下了');
    }
    this.close(record);
    return { ...record };
  }

  /**
   * 读以前的记录：没跑完的（程序重启了）记成 failed，在等的待确认也随进程没了。
   * 副作用：填 records；改没跑完的记录文件。
   */
  private loadRecords(): void {
    //M 一个文件一条记录。
    for (const name of fs.readdirSync(this.dir).filter((file) => file.endsWith('.json'))) {
      try {
        /** 记录。 */
        const record = JSON.parse(
          fs.readFileSync(path.join(this.dir, name), 'utf8'),
        ) as RunRecord;
        if (!ENDED.includes(record.status)) {
          record.status = 'failed';
          record.error = '程序重启了，没跑完（在等的审核卡片也作废了）';
          record.endedAt ??= Date.now();
          this.save(record);
        }
        this.records.set(record.id, record);
      } catch (error) {
        //G 坏文件跳过，不挡命令窗口起来。
        console.error(
          `${utils.formatTime()} 命令窗口的记录 ${name} 读不了，跳过：${utils.errorText(error)}`,
        );
      }
    }
  }

  /**
   * 存一条记录；写不进去只打日志（跑完的回调里抛错没人接，会把整个后端带崩）。
   * @param record 记录。
   * 副作用：写 data/runs/<号>.json。
   */
  private save(record: RunRecord): void {
    try {
      fs.writeFileSync(
        path.join(this.dir, `${record.id}.json`),
        JSON.stringify(record, null, 2),
        'utf8',
      );
    } catch (error) {
      console.error(
        `${utils.formatTime()} 命令窗口 #${record.id} 的记录没存上：${utils.errorText(error)}`,
      );
    }
  }

  /**
   * 只留最近 RUNS_KEEP 条，旧的连输出一起删；在跑的不删。
   * 副作用：删文件、改内存。
   */
  private prune(): void {
    /** 从新到旧。 */
    const ids = [...this.records.keys()].sort().reverse();
    for (const id of ids.slice(RUNS_KEEP)) {
      if (this.active.has(id)) {
        continue;
      }
      this.records.delete(id);
      fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
      fs.rmSync(path.join(this.dir, `${id}.log`), { force: true });
    }
  }

  /**
   * 收尾一条：记下结束时间、存起来、打一行日志。
   * @param record 记录。
   * 副作用：写文件、打日志。
   */
  private close(record: RunRecord): void {
    record.endedAt = Date.now();
    this.save(record);
    /** 用时。 */
    const seconds = record.startedAt
      ? `，用时 ${String(Math.round((record.endedAt - record.startedAt) / 100) / 10)} 秒`
      : '';
    /** 退出码（被杀时没有）。 */
    const code = record.code === undefined ? '' : `，退出码 ${String(record.code ?? '无')}`;
    /** 日志里的命令（截短）。 */
    const command = utils.truncate(record.command, 120);
    /** 日志的开头：时间、号、谁发的、最后的状态。 */
    const prefix = `${utils.formatTime()} 命令窗口 #${record.id}（${record.from}）${record.status}`;
    console.log(`${prefix}${code}${seconds}：${command}`);
  }

  /**
   * 开始跑一条（审核已经过了）：输出边跑边写进文件。
   * @param record 记录。
   * 副作用：起子进程、写文件。
   */
  private launch(record: RunRecord): void {
    //G 目录不存在：直接说清楚，不让 shell 报看不懂的 ENOENT。
    if (!fs.existsSync(record.cwd)) {
      record.status = 'failed';
      record.error = `目录不存在：${record.cwd}`;
      this.close(record);
      return;
    }
    //M 记成 running，开输出文件，起子进程。
    record.status = 'running';
    record.startedAt = Date.now();
    this.save(record);
    /** 输出文件；写不进去只打日志，不挡命令跑完。 */
    const out = fs.createWriteStream(record.log, { flags: 'a' });
    out.on('error', (error) => {
      console.error(
        `${utils.formatTime()} 命令窗口 #${record.id} 的输出没写进文件：${utils.errorText(error)}`,
      );
    });
    /** 正在跑的命令。 */
    const shell = tools.startShell(this.resources.getPaths(), {
      command: record.command,
      workDir: record.cwd,
      timeoutMs: record.timeoutSec * 1000,
      onOutput: (chunk) => out.write(chunk),
      keepOutput: false,
    });
    //M 跑完以后：被停下的保持 stopped；别的按退出码定。
    /** 跑完以后。 */
    const done = shell.done.then((result) => {
      out.end();
      if (record.status === 'running') {
        record.status = result.code === 0 && !result.timedOut && !result.error ? 'done' : 'failed';
      }
      record.code = result.code;
      record.timedOut = result.timedOut;
      record.error = result.error
        ?? (result.timedOut ? `超过 ${String(record.timeoutSec)} 秒，已结束` : record.error);
      this.active.delete(record.id);
      this.close(record);
    });
    this.active.set(record.id, { stop: shell.stop, done });
  }
}
