/**
 * 复盘：空闲时从 data/overtime.jsonl（progress 写的“做太久、被限时、被终止”的登记）挑一件还没复盘的，
 * 开一场小会话写“慢在哪、以后同类事怎么做”，用 approval 问用户要不要记进公共记忆；同意了写进运行时目录 memory/复盘/。
 * 启动 5 分钟后看第一次，以后每 10 分钟一次；有进度在转、或有复盘在等用户时不打扰。
 * 挑中就先在那场会话记录上记 reviewedAt，模型出错、重启都不会反复问同一件。
 * 照 0.4 src/capabilities/Review.ts。设计：docs/src7插件设计/review.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { Thinking } from '../../Chat.ts';
import type { AskInput } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import type { Pending } from '../approval/index.ts';
import type { ProgressItem } from '../progress/index.ts';


/** 插件名。 */
export const name = 'review';

/** 用到的服务：resources 拿目录和配置；bots 看机器人在不在；sessions 开小会话、记 reviewedAt；progress、approval 看忙不忙、问用户。 */
export const inject = ['resources', 'bots', 'sessions', 'progress', 'approval'];


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 复盘挑过的最后一行登记的 at（一场会话可能有好几行，一行一行往后挑）。 */
    reviewedAt?: number;
  }
}


/** 插件配置：只给测试用，把 5 分钟、10 分钟改小。 */
interface Config {
  first_ms?: number;
  every_ms?: number;
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

/** files-mirror 服务这里用到的样子，不 import 它（没挂 files-mirror 时 ctx.get 交回 undefined）。 */
interface FilesMirrorLike {
  dirOf(row: { bot: string; id: string }): string;
}

/** model-catalog 里用到的：模型的思考档。 */
interface CatalogLike {
  find(id: string): { thinking: string[] } | undefined;
}

/** 启动后多久第一次看。 */
const FIRST_MS = 5 * 60_000;
/** 以后多久看一次。 */
const EVERY_MS = 10 * 60_000;
/** 会话记录最多读末尾多少字。 */
const LOG_CHARS = 8000;
/** 复盘怎么写（照 0.4 Review.ts:30）。 */
const PROMPT = '你在给一件做得太久的事写复盘。下面是这件事的原话、各段耗时和工作过程。找出慢在哪里（比如同一个东西搜了好几遍、读了一堆没用上的文件、一步想了很久、本可以先看记忆却没看），给出以后遇到同类事的做法，最多 3 条，每条一句话，后面写预计能快多少。只写工作过程里看得出来的，看不出来就写“看不出明显的问题”。用中文，写成 Markdown 列表。';
/** 思考档从低到高。 */
const LEVELS: Thinking[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];


/** 复盘。 */
class Review {
  /**
   * 挂 approval/decided，排第一次检查。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param timing 第一次、以后每次隔多久。
   */
  constructor(private readonly ctx: cordis.Context, timing: { first: number; every: number }) {
    //M approval/decided（通知）：复盘那件同意了就写文件；拒绝就算了，这件不再问（reviewedAt 已经记了）。
    ctx.on('approval/decided', (pending: Pending) => {
      if (pending.kind !== 'review' || pending.state !== 'approved') return;
      const payload = pending.payload as { entry?: Entry; advice?: string } | undefined;
      if (payload?.entry === undefined || typeof payload.advice !== 'string') return;
      const file = this.write(payload.entry, payload.advice);
      //T 跟踪：复盘写好了。
      ctx.emit('trace', 'Review.write', '复盘写进公共记忆', 'fs.writeFileSync(memory/复盘/…)', { 文件: file });
    });

    //M 定时器用普通 setTimeout，在 ctx.effect 里登记清理：插件被拔掉时 Cordis 调交回的函数，清掉定时器。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      void this.check().catch((error: unknown) => console.error(`复盘出错：${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { timer = setTimeout(tick, timing.every); });
    };
    ctx.effect(() => {
      timer = setTimeout(tick, timing.first);
      return () => clearTimeout(timer);
    });
  }

  /** 看一次：空闲才挑一件，写复盘，问用户。 */
  async check(): Promise<void> {
    const progress = this.ctx.progress.list() as ProgressItem[];
    if (progress.some((item) => item.endedAt === undefined)) return this.skip('有进度在转');
    if (this.ctx.approval.list().some((item) => item.kind === 'review')) return this.skip('有复盘在等用户');

    const file = path.join(this.ctx.resources.dir('data'), 'overtime.jsonl');
    if (!fs.existsSync(file)) return this.skip('还没有超时登记');

    //M 按先后挑第一行：机器人还在、会话还在、它的 reviewedAt 比这一行早（或没有）。坏的行跳过。
    let entry: Entry | undefined;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let parsed: Entry;
      try {
        parsed = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (this.ctx.bots.get(parsed.bot) === undefined) continue;
      const meta = this.ctx.sessions.find({ id: parsed.sessionId })[0];
      if (meta === undefined || (meta.reviewedAt ?? 0) >= parsed.at) continue;
      entry = parsed;
      break;
    }
    if (entry === undefined) return this.skip('登记的都复盘过了');

    //M 先记 reviewedAt 再做：模型出错、重启都不会反复问同一件。
    const session = this.ctx.sessions.open(entry.sessionId);
    session.row.reviewedAt = entry.at;
    session.save();

    //T 跟踪：挑中一件。
    this.ctx.emit('trace', 'Review.check', '挑中一件做太久的事', 'sessions.open(entry.sessionId)', { 会话: entry.sessionId, 结局: entry.stage, 用时: textModule.duration(entry.usedMs) });

    //M 对话.md：files-mirror 写的那份，目录问它（dirOf），不自己拼路径；没挂它就当没有记录。
    const mirror = this.ctx.get('filesMirror') as FilesMirrorLike | undefined;
    const md = mirror === undefined ? '' : path.join(mirror.dirOf(session.row), '对话.md');
    const log = md !== '' && fs.existsSync(md) ? fs.readFileSync(md, 'utf8').slice(-LOG_CHARS) : '（没有记录：没挂 files-mirror 或 journal）';
    const engine = (this.ctx.resources.raw['engine'] ?? {}) as Record<string, unknown>;
    const model = typeof engine['wrapup_model'] === 'string' && engine['wrapup_model'] !== '' ? engine['wrapup_model'] : session.row.model;
    //M 开复盘小会话问一次。
    const text = [
      PROMPT, '',
      `用户的话：${entry.text}`,
      `结局：${entry.stage}，用了 ${textModule.duration(entry.usedMs)}`,
      `各段耗时：${entry.timingsText ?? JSON.stringify(entry.timings ?? {})}`,
      '',
      `工作过程（会话记录末尾）：\n${log}`,
    ].join('\n');
    const askInput: AskInput = {
      bot: entry.bot,
      kind: 'review',
      parent: entry.sessionId,
      model,
      thinking: this.lowest(model),
      text,
    };
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 没做完或没写出东西 → 记一笔，不问用户。
    const advice = reply.trim();
    if (!ok || advice === '') {
      console.error(`复盘没写成：${reply}`);
      return;
    }

    const title = entry.sessionTitle !== undefined && entry.sessionTitle !== '' ? entry.sessionTitle : [...entry.text].slice(0, 20).join('');
    const detail = [
      advice, '',
      `这件事做了 ${textModule.duration(entry.usedMs)}（${entry.stage}），上面是看了工作过程写的建议`,
      '同意后写进公共记忆 memory/复盘/，所有机器人以后做同类事会参考它',
      '建议对就同意；不对或没用就拒绝，这件事不再问',
    ].join('\n');
    this.ctx.approval.ask({ kind: 'review', bot: entry.bot, title: `复盘建议：写进公共记忆？（${title}）`, detail, payload: { entry, advice } });
  }

  /**
   * 写复盘文件：memory/复盘/<年月日时分>_<标题>.md，同名覆盖。
   * @returns 文件路径。
   */
  private write(entry: Entry, advice: string): string {
    const date = new Date(entry.at);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const stamp = `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
    const rawTitle = entry.sessionTitle !== undefined && entry.sessionTitle !== '' ? entry.sessionTitle : [...entry.text].slice(0, 20).join('');
    const title = rawTitle.replace(/[\\/:*?"<>|\s\p{Cc}]+/gu, '_').replace(/^[._]+|[._]+$/gu, '') || '复盘';
    const file = path.join(this.ctx.resources.dir('memory', '复盘'), `${stamp}_${title}.md`);
    const text = [
      `# 复盘：${rawTitle}`, '',
      `- 机器人：${entry.bot}；会话：${entry.sessionId}；结局：${entry.stage}；用了 ${textModule.duration(entry.usedMs)}`,
      `- 用户的话：${entry.text}`,
      `- 各段耗时：${entry.timingsText ?? ''}`, '',
      '## 以后同类事怎么做', '', advice.trim(), '',
      '## 效果', '', '（下次同类事再记一笔：照这个做了没有、快了多少；没快也写上。）', '',
    ].join('\n');
    fs.writeFileSync(file, text, 'utf8');
    return file;
  }

  /** 跳过这次：进跟踪。 */
  private skip(why: string): void {
    //T 跟踪：这次不复盘。
    this.ctx.emit('trace', 'Review.check', '这次不复盘', 'check()', { 原因: why });
  }

  /** 这个模型最低的非 off 思考档；没有 modelCatalog 用 minimal。 */
  private lowest(model: string): Thinking {
    const catalog = this.ctx.get('modelCatalog') as CatalogLike | undefined;
    const levels = (catalog?.find(model)?.thinking ?? []).filter((level): level is Thinking => LEVELS.includes(level as Thinking));
    return levels.sort((left, right) => LEVELS.indexOf(left) - LEVELS.indexOf(right))[0] ?? 'minimal';
  }
}


/**
 * 挂上复盘。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后 Cordis 调一次，第二个参数是 plugins 段里它的 config（只给测试改时间）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config { first_ms?, every_ms? }。
 * @throws 不是正数时抛错。
 */
export function apply(ctx: cordis.Context, config: Config | undefined): void {
  const first = config?.first_ms ?? FIRST_MS;
  const every = config?.every_ms ?? EVERY_MS;
  if (typeof first !== 'number' || first <= 0 || typeof every !== 'number' || every <= 0) throw new Error('review 的 first_ms、every_ms 要是正数');
  new Review(ctx, { first, every });
}
