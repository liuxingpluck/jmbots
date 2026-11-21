/**
 * 模型介绍和评价（11-18 由插件 model-notes 并进 model-catalog）：派活的 AI 要知道“什么模型干什么事曾经干得好、被认可”。
 * 数据是运行时目录 models/ 下的 MD，一个模型一份，文件名是模型 ID 把 / 换成 __（magpie__workbuddy__deepseek-v4.1-flash.md）：
 *   # <模型 ID>
 *   （人写的介绍：擅长什么、价钱、速度、建议思考档。原样读，不解析）
 *   ## 评价
 *   - 2026-11-17 13:50 EST · 用户 · 4/5 · 会话 20261117123456789012（high） · 一句话
 * ModelNotes：getList 列每个模型的介绍和评价，getPrompt 拼一段给派活提示词用的中文，rate 按会话查出模型后写入或修改评价，routes 登记两个接口。
 * 接口（路径照旧，网页不用改）：
 *   GET  /api/model-notes        列表 { list }
 *   POST /api/model-notes/rate   会话打分 { session, by, score, note }，正文由 Checks.ts 的 checkRating 查一次
 * 页面 /model-notes/ 是 web 打包的 model-notes.html（web/src/ModelNotes/），web 插件的兜底路由按文件名托管，这里不登记。
 * 配置（plugins[model-catalog].config.notes，都可不写）：dir（默认 models，相对运行时目录）、
 *   time_zone（评价时间按哪个时区写，默认 America/New_York，写出来是 EST/EDT）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import type { } from '../../Sessions.ts';
import * as checks from './Checks.ts';
import { Failure } from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';


/** 一条评价：从 MD 的“## 评价”下面一行解析出来。 */
export interface Rating {
  /** 什么时候打的，原样，比如 2026-11-17 13:50 EST。 */
  at: string;
  /** 谁打的。 */
  by: string;
  /** 分数，1 到 5。 */
  score: number;
  /** 被评价的会话号。 */
  session: string;
  /** 那场会话当时的思考档，未知时是空串。 */
  thinking: string;
  /** 供现有接口调用方读取，会话评价固定为空串。 */
  task: string;
  /** 一句话评语；没写是空串。 */
  note: string;
}


/** 一个模型的介绍和评价。 */
export interface ModelNote {
  /** 模型 ID：文件名去掉 .md，__ 换回 /。 */
  model: string;
  /** 介绍：标题行和“## 评价”之间的全部文字，原样（去掉两头空行）。 */
  intro: string;
  /** 评价，照文件里的先后（旧的在前；同人同会话只留最新一条）。 */
  ratings: Rating[];
  /** 打过分的会话数 N，按会话号去重。 */
  sessionCount: number;
  /** 平均分，按 N 场会话算术平均并保留一位小数；没有评价是 0。 */
  average: number;
}


/** 模型介绍和评价的配置，校验后。 */
export interface NotesSettings {
  /** 放 MD 的目录，绝对路径。 */
  dir: string;
  /** 评价时间按哪个时区写（IANA 名）。 */
  timeZone: string;
}


/** 评价那一节的标题行。 */
const RATINGS_HEADING = '## 评价';

/** 新建的 MD 里介绍先写这一句，等人补。 */
const NO_INTRO = '（待补介绍）';

/**
 * 会话评价行：- 时间 · 评价者 · 分数/5 · 会话 会话号（可选思考档） · 可选一句话。
 */
const SESSION_RATING_LINE = /^- (.+?) · (.+?) · ([1-5])\/5 · 会话 ([A-Za-z0-9_-]+)(?:（([^（）\r\n]*)）)?(?: ·(?: (.*))?)?$/u;

/** getPrompt 每个模型带最近几条评价。 */
const RECENT = 3;


/**
 * 读模型介绍和评价的配置，入口（model-catalog 的 apply）查一次。
 * @param root 运行时目录（ctx.resources.root）。
 * @param config plugins[model-catalog].config.notes；没写是 {}。
 * @returns 绝对路径的目录和时区。
 * @throws 哪一项写得不对就抛错。
 */
export function readNotesSettings(root: string, config: unknown): NotesSettings {
  //G config.notes 要是一组“名字: 值”。
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('model-catalog 的 notes 要写成一组“名字: 值”（dir、time_zone）');
  }
  const own = config as Record<string, unknown>;

  //M dir：放 MD 的目录，相对运行时目录算，默认 models。
  const dir = own['dir'] ?? 'models';
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('model-catalog 的 notes.dir 要写成非空的文字');
  }

  //M time_zone：评价时间按哪个时区写，默认美东（用户在 EST）；Intl 认不得的时区会抛 RangeError。
  const timeZone = own['time_zone'] ?? 'America/New_York';
  if (typeof timeZone !== 'string') {
    throw new Error('model-catalog 的 notes.time_zone 要写成时区名，比如 America/New_York');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`model-catalog 的 notes.time_zone 认不得：${timeZone}，要写成 IANA 时区名，比如 America/New_York`);
  }

  return { dir: path.resolve(root, dir), timeZone };
}


/**
 * 解析带会话号的一行评价。
 * @param line MD 里的一行。
 * @returns 解析不了是 undefined（调用方跳过这一行）。
 */
function getRating(line: string): Rating | undefined {
  const trimmed = line.trim();

  //G 跳过缺会话号或格式不合法的行。
  const found = SESSION_RATING_LINE.exec(trimmed);
  if (found === null) return undefined;

  return {
    at: found[1] ?? '',
    by: found[2] ?? '',
    score: Number(found[3]),
    session: found[4] ?? '',
    thinking: (found[5] ?? '').trim(),
    task: '',
    note: (found[6] ?? '').trim(),
  };
}


/**
 * 同一个人对同一场会话的多次评价只留最后一条（兼容手改文件里可能残余的重复行）。
 * @param rawRatings 按文件顺序解析出来的原始评价。
 * @returns 去重后的评价列表，新的在后。
 */
function deduplicateRatings(rawRatings: Rating[]): Rating[] {
  const result: Rating[] = [];
  for (const rating of rawRatings) {
    //M 用同一评价者在同一场会话里的最后一条评分。
    const prevIndex = result.findIndex((item) => item.session === rating.session && item.by === rating.by);
    if (prevIndex >= 0) {
      result.splice(prevIndex, 1);
    }
    result.push(rating);
  }
  return result;
}


/**
 * 按会话统计场数 N 和平均分：同一场会话多人打分先算该场均分，再求 N 场算术平均。
 * @param ratings 已去重的评价列表。
 * @returns 会话数 N 和保留一位小数的平均分。
 */
function getSessionStats(ratings: Rating[]): { sessionCount: number; average: number } {
  const bySession = new Map<string, number[]>();
  const unitScores: number[] = [];

  for (const rating of ratings) {
    const list = bySession.get(rating.session) ?? [];
    list.push(rating.score);
    bySession.set(rating.session, list);
  }

  for (const scores of bySession.values()) {
    const sum = scores.reduce((total, score) => total + score, 0);
    unitScores.push(sum / scores.length);
  }

  if (unitScores.length === 0) return { sessionCount: 0, average: 0 };

  const total = unitScores.reduce((acc, score) => acc + score, 0);
  const average = Math.round((total / unitScores.length) * 10) / 10;
  return { sessionCount: unitScores.length, average };
}


/**
 * 找“## 评价”这一节在哪：标题行的下标，和这一节到哪为止（下一个 # 开头的标题，或文末）。
 * 读评价、删旧评价、写新评价三处共用。
 * @param lines MD 按行拆开。
 * @returns heading 是“## 评价”那一行，end 是这一节后面第一行（不含）；没有这一节是 undefined。
 */
function getRatingsSection(lines: string[]): { heading: number; end: number } | undefined {
  const heading = lines.findIndex((line) => line.trim() === RATINGS_HEADING);
  if (heading < 0) return undefined;

  //M 这一节到下一个 # 开头的标题为止；没有下一个标题就到文末。
  let end = lines.findIndex((line, index) => index > heading && line.startsWith('#'));
  if (end < 0) {
    end = lines.length;
  }
  return { heading, end };
}

/**
 * 在评价节里删掉同一评价者对同一场会话的旧评价行（原地改 lines）。删旧评价、写新评价两处共用。
 * @param lines MD 按行拆开；删掉的行直接从里面拿走。
 * @param section getRatingsSection 找到的这一节。
 * @param session 会话号。
 * @param by 评价者。
 * @returns 删了几行。
 */
function removeOldRatings(
  lines: string[],
  section: { heading: number; end: number },
  session: string,
  by: string,
): number {
  //M 倒序逐行解析，删的时候后面的下标不会乱。
  let removed = 0;
  for (let index = section.end - 1; index > section.heading; index -= 1) {
    const parsed = getRating(lines[index] ?? '');
    if (parsed !== undefined && parsed.session === session && parsed.by === by) {
      lines.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}


/**
 * 解析一份 MD：标题行之后、“## 评价”之前是介绍；“## 评价”下面到下一个标题之间的行是评价，解析不了的跳过。
 * @param model 模型 ID。
 * @param text MD 全文。
 * @returns 介绍、去重后的评价、打过分的会话数 N 和平均分。
 */
function getNote(model: string, text: string): ModelNote {
  const lines = text.split(/\r?\n/u);

  //M 第一行是“# 标题”就跳过它；介绍从标题下一行开始，到“## 评价”或文末。
  let introStart = 0;
  if (lines[0]?.startsWith('# ') === true) {
    introStart = 1;
  }
  const section = getRatingsSection(lines);
  let introEnd = lines.length;
  if (section !== undefined) {
    introEnd = section.heading;
  }
  const intro = lines.slice(introStart, introEnd).join('\n').trim();

  //M 没有“## 评价”这一节：还没人打过分。
  if (section === undefined) return { model, intro, ratings: [], sessionCount: 0, average: 0 };

  //M 评价这一节里的每一行，解析得了的才算一条评价。
  const rawRatings: Rating[] = [];
  for (const line of lines.slice(section.heading + 1, section.end)) {
    const rating = getRating(line);
    if (rating !== undefined) {
      rawRatings.push(rating);
    }
  }

  //M 对同人同会话评价去重后，按会话计算场数与平均分返回。
  const ratings = deduplicateRatings(rawRatings);
  const stats = getSessionStats(ratings);
  return { model, intro, ratings, sessionCount: stats.sessionCount, average: stats.average };
}


/**
 * 找文件原来用的换行符：Windows 上手改过的文件可能是 \r\n。
 * @param text MD 全文。
 */
function getEol(text: string): string {
  if (text.includes('\r\n')) return '\r\n';

  return '\n';
}


/**
 * 从“## 评价”一节里去掉同一评价者对同一场会话的旧记录。
 * @param text MD 全文。
 * @param session 会话号。
 * @param by 评价者。
 * @returns 清理后的全文；没有可删的行时原样返回。
 */
function removeRatingLine(text: string, session: string, by: string): string {
  //M 先识别原文件的行尾符，写回时保持 LF 或 CRLF 一致。
  const eol = getEol(text);
  const lines = text.split(/\r?\n/u);
  const section = getRatingsSection(lines);
  if (section === undefined) return text;

  //M 删掉同评价者对同一场会话的所有旧记录；一行都没删就原样交回。
  const removed = removeOldRatings(lines, section, session, by);
  if (removed === 0) return text;

  return lines.join(eol);
}


/**
 * 在 MD 里写入或替换一条评价：若同一个人给同一场会话打过分就删掉旧行，再把新行插在“## 评价”最后一行有字的后面；没有这一节就在文末补上。
 * @param text MD 全文。
 * @param session 会话号。
 * @param by 评价者。
 * @param line 写好的评价行。
 * @returns 更新后的全文；原来用 \r\n 换行的照旧用 \r\n。
 */
function upsertRatingLine(text: string, session: string, by: string, line: string): string {
  //M 先识别原文件的行尾符，拼接写回时保持原行尾风格不变。
  const eol = getEol(text);
  const lines = text.split(/\r?\n/u);

  //M 没有“## 评价”：文末空一行补上这一节。
  const section = getRatingsSection(lines);
  if (section === undefined) return `${text.trimEnd()}${eol}${eol}${RATINGS_HEADING}${eol}${line}${eol}`;

  //M 先删掉同 (session, by) 的旧评价，这一节的结尾跟着往前挪。
  const removed = removeOldRatings(lines, section, session, by);
  const sectionEnd = section.end - removed;

  //M 往回跳过空行，插在最后一行有字的后面。
  let at = sectionEnd;
  while (at > section.heading + 1 && lines[at - 1]?.trim() === '') {
    at -= 1;
  }
  lines.splice(at, 0, line);
  return lines.join(eol);
}


/** 模型介绍和评价：model-catalog 的 apply 建一个，交给 ModelCatalog（拼 prompt）和 http（两个接口）。 */
export class ModelNotes {
  /** 写评价时间用的格式器：按配置的时区，带时区缩写（EST/EDT）。 */
  private readonly clock: Intl.DateTimeFormat;

  /**
   * 建好放 MD 的目录和时间格式器。
   * @param ctx model-catalog 插件的 ctx：rate 用它的 sessions 查会话、发跟踪点。
   * @param settings readNotesSettings 查过的目录和时区。
   * 副作用：评价目录不存在就递归创建。
   */
  constructor(
    private readonly ctx: cordis.Context,
    readonly settings: NotesSettings,
  ) {
    //M 后续按模型读写评价时使用同一个目录。
    filesModule.ensureDir(settings.dir);
    this.clock = new Intl.DateTimeFormat('en-US', {
      timeZone: settings.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
  }

  /**
   * 每个模型的介绍和评价，按文件名排。
   * @returns 目录里每个 .md 一项。
   */
  getList(): ModelNote[] {
    const files = fs.readdirSync(this.settings.dir, { withFileTypes: true });
    //M 只要 .md 文件，按文件名排。
    const mdFiles = files.filter((file) => file.isFile() && file.name.endsWith('.md'));
    const names = mdFiles.map((file) => file.name).sort();
    const list: ModelNote[] = [];
    for (const fileName of names) {
      //M 文件名去掉 .md，__ 换回 /，就是模型 ID。
      const model = fileName.slice(0, -'.md'.length).replaceAll('__', '/');
      const text = fs.readFileSync(path.join(this.settings.dir, fileName), 'utf8');
      list.push(getNote(model, text));
    }
    return list;
  }

  /**
   * 拼一段给派活提示词用的中文：每个模型写介绍的第一段、平均分和会话数、最近 3 条评价。
   * @param list getList 读出来的（ModelCatalog.getPrompt 读一次，拼思考档时接着用）。
   * @returns 一段文字；一个模型都没有是空串。
   */
  getPrompt(list: ModelNote[]): string {
    //G 一个模型都没有：交回空串，不污染派活提示词。
    if (list.length === 0) return '';

    const lines = ['# 模型介绍和评价', '派活时参考：每个模型擅长什么、以前干得怎么样（1 到 5 分，每条评价写了谁打的和哪场会话）。'];
    for (const item of list) {
      //M 介绍只取第一段（第一个空行之前），几行并成一行。
      const first = item.intro.split(/\n\s*\n/u)[0] ?? '';
      let intro = first.split('\n').map((line) => line.trim()).join(' ');
      if (intro === '') {
        intro = '（没写介绍）';
      }
      lines.push(`- ${item.model}：${intro}`);

      //M 没有评价就写一句；有就写平均分、会话数和最近 3 条（新的在前）。
      if (item.ratings.length === 0) {
        lines.push('  还没有评价。');
        continue;
      }
      //M 取最近几条评价并格式化为单行文本，按新到旧顺序拼进提示词。
      const newest = item.ratings.slice(-RECENT).reverse();
      const recent = newest.map((rating) => getRatingText(rating));
      const count = `平均 ${String(item.average)} 分，${String(item.sessionCount)} 场会话`;
      lines.push(`  ${count}。最近：${recent.join('；')}`);
    }
    return lines.join('\n');
  }

  /**
   * 按会话号写入或修改一条评价：服务端从会话读出实际模型与思考档，MD 不在就新建（标题加一行“（待补介绍）”）。
   * 同一个人对同一场会话再次打分算改分（覆盖旧记录）；会话换过模型时也会清理其它模型文件里的同人同会话旧行。
   * @param input 查过的评价（Checks.ts 的 checkRating 交回的）。
   * @returns 这个模型更新后的介绍和评价。
   * @throws 找不到会话或模型 ID 非法时抛 Failure。
   * 副作用：写 models/<模型 ID 的 / 换成 __>.md（若换过模型也会更新旧模型 MD）；发一个跟踪点。
   */
  rate(input: checks.RatingInput): ModelNote {
    //M 按会话号打开会话，取出实际用的模型和思考档；没有这场会话回 404。
    let sessionRow: { model: string; thinking?: string };
    try {
      sessionRow = this.ctx.sessions.open(input.session).row;
    } catch {
      throw new Failure(404, `没有这场会话：${input.session}`);
    }

    //M 校验会话记录里的模型 ID 合法性，再把斜杠替换为双下划线作为安全文件名。
    const model = checks.checkModelId(sessionRow.model);
    const thinking = String(sessionRow.thinking ?? '').trim();
    const file = path.join(this.settings.dir, `${model.replaceAll('/', '__')}.md`);

    //M 如果这场会话中途换过模型，把其它模型文件里同人同会话的旧行清掉。
    this.removeSessionByFromOtherFiles(file, input.session, input.by);

    //M 文件在就读，不在就从标题和“（待补介绍）”起头。
    let text = `# ${model}\n\n${NO_INTRO}\n`;
    if (fs.existsSync(file)) {
      text = fs.readFileSync(file, 'utf8');
    }

    //M 写成一行：时间按配置的时区带缩写，记录会话号和思考档；一句话没写时去掉末尾多余分隔符。
    const rating: Rating = {
      at: this.getNow(),
      by: input.by,
      score: input.score,
      session: input.session,
      thinking,
      task: '',
      note: input.note,
    };
    //M 将评价拼成列表项并按会话和评价者就地写入或替换，随后写回模型 MD。
    const line = `- ${getRatingText(rating)}`.trimEnd();
    const updated = upsertRatingLine(text, input.session, input.by, line);
    fs.writeFileSync(file, updated, 'utf8');

    //T 跟踪：记下或修改了一条会话评价。
    const vars = {
      model: model,
      session: input.session,
      thinking: thinking,
      reviewer: input.by,
      score: input.score,
      file: file,
    };
    const code = 'fs.writeFileSync(file, upsertRatingLine(text, input.session, input.by, line))';
    this.ctx.emit('trace', 'ModelNotes.rate', 'trace.modelCatalog.rateSession', code, vars);
    return getNote(model, updated);
  }

  /**
   * 登记两个接口（http 就绪时 model-catalog 的 apply 调）。外面来的要带令牌由 http 的钩子管。
   * @param app Fastify 服务实例。
   * 副作用：登记 GET /api/model-notes、POST /api/model-notes/rate。
   */
  routes(app: fastify.FastifyInstance): void {
    //M GET /api/model-notes：每个模型的介绍、评价、会话数、平均分。
    app.get('/api/model-notes', () => {
      const list = this.getList();
      return { list };
    });

    //M POST /api/model-notes/rate：正文查一次，不对回 400；按会话号查模型写入评价，查不到会话回 404，对了交回这个模型的最新内容。
    app.post<{ Body: unknown }>('/api/model-notes/rate', (request, reply) => {
      let input: checks.RatingInput;
      try {
        input = checks.checkRating(request.body);
      } catch (error) {
        const message = textModule.getErrorMessage(error);
        return reply.code(400).send({ error: message });
      }

      //M 写入或覆盖该会话对应模型的评价记录，并将最新模型详情回给前端。
      const note = this.rate(input);
      return { ok: true, note };
    });
  }

  /**
   * 清理其它模型 MD 文件里同一个人对同一场会话的旧评价（防会话换模型后重复计分）。
   * @param keepFile 当前要写入的模型文件绝对路径。
   * @param session 会话号。
   * @param by 评价者。
   */
  private removeSessionByFromOtherFiles(keepFile: string, session: string, by: string): void {
    const entries = fs.readdirSync(this.settings.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const candidate = path.join(this.settings.dir, entry.name);
      if (candidate === keepFile) continue;

      //M 读出其它模型的 MD 文件，剔除同人同会话旧评价并仅在内容变化时写回。
      const content = fs.readFileSync(candidate, 'utf8');
      const cleaned = removeRatingLine(content, session, by);
      if (cleaned !== content) {
        fs.writeFileSync(candidate, cleaned, 'utf8');
      }
    }
  }

  /**
   * 现在的时刻，写成 2026-11-17 10:20 EST。
   * @returns 按配置的时区，带时区缩写。
   */
  private getNow(): string {
    const parts = this.clock.formatToParts(new Date());
    /** 取 formatToParts 里的一段，比如 year、timeZoneName。 */
    const getPart = (type: Intl.DateTimeFormatPartTypes): string => {
      //M 从格式化拆分片段中取出对应的时间字段文本。
      const found = parts.find((part) => part.type === type);
      return found?.value ?? '';
    };
    const date = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
    const time = `${getPart('hour')}:${getPart('minute')}`;
    return `${date} ${time} ${getPart('timeZoneName')}`;
  }
}


/**
 * 将一条会话评价写成文字，供 MD 的评价行和 getPrompt 共用。
 * @param rating 一条评价。
 * @returns 一行字，不带“- ”。
 */
function getRatingText(rating: Rating): string {
  let sessionPart = `会话 ${rating.session}`;
  if (rating.thinking !== '') {
    sessionPart = `会话 ${rating.session}（${rating.thinking}）`;
  }
  if (rating.note === '') {
    return `${rating.at} · ${rating.by} · ${String(rating.score)}/5 · ${sessionPart}`;
  }
  return `${rating.at} · ${rating.by} · ${String(rating.score)}/5 · ${sessionPart} · ${rating.note}`;
}
