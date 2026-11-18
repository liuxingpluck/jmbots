/**
 * 会话打分（POST /api/model-notes/rate）的校验：正文、模型 ID。只有 Notes.ts 用，所以放在 model-catalog 里；
 * 字段怎么查借骨架 utils/Checks.ts 的 record、text。
 */
import * as checks from '../../utils/Checks.ts';


/** 一条会话打分请求，校验后。checkRating 交回，model-catalog 插件 Notes.ts 的 ModelNotes.rate 收。 */
export interface RatingInput {
  /** 被打分的会话号（如 20 位数字时刻号或旧的短会话号）。 */
  session: string;
  /** 谁打的分：用户、Claude、Codex、Grok、Antigravity……写什么记什么。 */
  by: string;
  /** 分数，1 到 5 的整数。 */
  score: number;
  /** 一句话评价；没写是空串。 */
  note: string;
}


/** 模型 ID 里用 / 隔开的每一段：字母或数字开头，后面只能是字母、数字、点、下划线、横杠（要当文件名用）。 */
const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** 会话号允许的字符：字母、数字、下划线、横杠（防路径穿越与换行）。 */
const SESSION_ID = /^[A-Za-z0-9_-]+$/u;


/**
 * 校验模型 ID（由会话记录读出，要用来拼 models/ 下的文件名）：
 * 用 / 隔开的每一段字母或数字开头，只有字母、数字、点、下划线、横杠；不能有 __（文件名里 __ 代表 /）。
 * @param model 模型 ID。
 * @returns 去掉两头空白的模型 ID。
 * @throws 格式不对时抛错。
 */
export function checkModelId(model: string): string {
  //G 校验模型 ID 为非空字符串且各斜杠分段符合安全文件名字符要求。
  const trimmed = checks.text(model, 'model').trim();
  const segments = trimmed.split('/');
  const goodModel = segments.every((segment) => MODEL_SEGMENT.test(segment) && !segment.includes('__'));
  if (!goodModel) {
    const shape = '比如 magpie/workbuddy/deepseek-v4.1-flash：只用字母、数字、点、下划线、横杠和 /，不能有 __';
    throw new Error(`model 要写成模型 ID，${shape}`);
  }
  return trimmed;
}


/**
 * 校验一条会话打分（POST /api/model-notes/rate 的正文）。model-catalog 插件（Notes.ts）的接口调，查过以后 ModelNotes.rate 直接用。
 * 一条评价写成 MD 里的一行，字段之间用“ · ”隔开，所以哪一项都不能换行，评价者里不能有“·”。
 * @param body 请求正文，原样。
 * @returns 去掉两头空白的 session、by、score、note；note 没写是空串。
 * @throws 哪一项不对就抛错，说清是哪一项、该怎么写。
 */
export function checkRating(body: unknown): RatingInput {
  //M 先把请求正文确认成键值对象，再逐项校验会话号、打分人和评语。
  const item = checks.record(body, '评价');

  //M session：非空合法会话号（只含字母、数字、下划线、横杠）。
  const session = checks.text(item['session'], 'session').trim();
  if (!SESSION_ID.test(session)) {
    throw new Error('session 要写成合法的会话号（只含字母、数字、下划线、横杠）');
  }

  //M by：谁打的分，非空；score：1 到 5 的整数。
  const by = checks.text(item['by'], 'by').trim();
  const score = item['score'];
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error('score 要写成 1 到 5 的整数');
  }

  //M note：可以不写，写了要是文字。
  const noteWritten = item['note'] ?? '';
  if (typeof noteWritten !== 'string') {
    throw new Error('note 要写成文字（可以不写）');
  }

  //G 一条评价是一行：哪一项都不能换行；评价者里的“·”会和分隔符混在一起。
  const fields = [session, by, noteWritten];
  if (fields.some((field) => /[\r\n]/u.test(field))) {
    throw new Error('session、by、note 都不能换行');
  }
  if (by === '' || by.includes('·')) {
    throw new Error('by 要写成非空的文字，且不能有“·”（它是评价行的分隔符）');
  }

  return { session, by, score, note: noteWritten.trim() };
}
