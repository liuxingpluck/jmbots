/**
 * 对本地记忆和技能文件按字组评分，保留命中行号和文件时间。
 * 设计：docs/src7插件设计/memory.md 第 4 节。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';


/** 本地搜最多给几个文件（开场先搜用）。 */
const MAX_FILES = 3;

/** 每个文件最多给几行。 */
const MAX_LINES = 3;

/** 每行最多多少字。 */
const LINE_CHARS = 160;

/** 一个文件至少对上几分才算相关：两个字一组 1 分，英文和数字的整词 2 分。 */
const MIN_HITS = 3;

/** 比这大的文件不看，字节。 */
const MAX_FILE_BYTES = 256 * 1024;

/** 不用再给的文件：记忆概要 prompt 插件已经整篇拼进去了。 */
const SKIP_NAMES = new Set(['索引.md', 'index.md']);

/** 本地文件命中，lines 是摘要中的片段。 */
export interface RecallHit {
  file: string;
  score: number;
  lines: string[];
}

/** 本地命中的原文位置和时间。 */
interface LocalHit extends RecallHit {
  /** 搜索时序列中的所属根目录。 */
  root: string;
  /** 匹配最好的行号，从 1 开始。 */
  line: number;
  /** 文件修改时间，毫秒。 */
  at: number;
}

/**
 * 一段话拆成“相邻两个字一组”的集合，英文和数字按整词（3 个字母以上）。
 * @param text 一段话。
 */
export function grams(text: string): Set<string> {
  const found = new Set<string>();
  //M 英文和数字单独成段（“给Claude留话”拆成“给”“claude”“留话”），别的字母和汉字连成一段。
  for (const run of text.toLowerCase().match(/[a-z0-9]+|(?:(?![a-z0-9])[\p{L}\p{N}])+/gu) ?? []) {
    if (/^[a-z0-9]+$/u.test(run)) {
      if (run.length >= 3) found.add(run);
      continue;
    }
    const chars = [...run];
    for (let index = 0; index + 1 < chars.length; index += 1) found.add(`${chars[index]}${chars[index + 1]}`);
  }
  return found;
}

/**
 * 截到 max 个字，截了加“…”（记忆的片段只是提示，不用写共多少字）。
 * @param text 一段字。
 * @param max 最多几个字。
 */
export function short(text: string, max: number): string {
  return [...text].length > max ? `${[...text].slice(0, max).join('')}…` : text;
}

/** 一组字算几分：整词 2 分，两个字一组 1 分。 */
function weight(gram: string): number {
  return /^[a-z0-9]+$/u.test(gram) ? 2 : 1;
}

/**
 * 一段字和问的话对上了几分。
 * @param wanted 问的话的字组。
 * @param text 一段字。
 */
export function matchScore(wanted: Set<string>, text: string): number {
  //M 把这段字拆成字组，对上问的话里的字组就按 weight 加分（整词 2 分、两个字 1 分）。
  return [...grams(text)].filter((gram) => wanted.has(gram)).reduce((sum, gram) => sum + weight(gram), 0);
}

/**
 * 一个文件夹下的 Markdown 文件（跳过记忆概要）；文件夹不存在就是空的。
 * @param root 文件夹。
 */
async function markdownFiles(root: string, withText = false): Promise<string[]> {
  try {
    let pattern = '**/*.md';
    if (withText) pattern = '**/*.{md,txt}';

    const names = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true }));
    return names.filter((name) => !SKIP_NAMES.has(path.basename(name))).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

/**
 * 在几个文件夹里找和这段话最像的文件。
 * @param roots 文件夹。
 * @param query 原话。
 * @param options maxFiles 最多几个；loose 短话也算；literalFallback 在没有字组时按字面找 .md 和 .txt。
 * @returns 最像的几个，分数从高到低。
 */
export async function local(roots: string[], query: string, options: {
  maxFiles?: number; loose?: boolean; literalFallback?: boolean; since?: number; until?: number;
} = {}): Promise<LocalHit[]> {
  //G 问的话切不出字组（比如只有两个字母）就没法搜，直接交回空。
  const wanted = grams(query);
  const literal = wanted.size === 0 && options.literalFallback === true;
  if (wanted.size === 0 && !literal) return [];

  //M 够格的最低分：loose 时短话字组全对上也算（最多只要到 MIN_HITS），否则固定 MIN_HITS 分。
  let need = MIN_HITS;
  if (options.loose === true) {
    const score = [...wanted].reduce((sum, gram) => sum + weight(gram), 0);
    need = Math.min(MIN_HITS, score);
  }

  //M 逐个文件夹、逐个 Markdown 文件打分，分数不到 need 的丢掉。
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const hits: LocalHit[] = [];
  for (const root of roots) {
    const files = await markdownFiles(root, literal);
    for (const file of files) {
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat === undefined || stat.size > MAX_FILE_BYTES) continue;
      const at = stat.mtimeMs;
      if (at < (options.since ?? 0) || at > (options.until ?? Infinity)) continue;

      //M 从文件的全文得分，短问题在没有字组时按字面词搜索。
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      let matched = matchScore(wanted, text);
      if (literal) matched = words.filter((word) => text.toLowerCase().includes(word)).length;
      if (matched === 0) continue;
      if (matched < need) continue;

      //M 对上字组最多的几行，每行截到 160 字。
      const matching = text.split(/\r?\n/u)
        .map((line, index) => {
          let hits = [...grams(line)].filter((gram) => wanted.has(gram)).length;
          if (literal) hits = words.filter((word) => line.toLowerCase().includes(word)).length;
          return { line: line.trim(), hits, index };
        })
        .filter((item) => item.line !== '' && item.hits > 0)
        .sort((left, right) => right.hits - left.hits)
        .slice(0, MAX_LINES);
      const first = matching[0];
      if (first === undefined) continue;

      //M 保留原始行号和短摘要，供查询结果定位原文。
      const lines = matching.map((item) => short(item.line, LINE_CHARS));
      hits.push({ root, file, score: matched / Math.sqrt(text.length + 100), lines, at, line: first.index + 1 });
    }
  }
  return hits.sort((left, right) => right.score - left.score).slice(0, options.maxFiles ?? MAX_FILES);
}

/**
 * 搜到的写成一段（开场先搜放进系统提示词）。
 * @param hits 搜到的。
 * @param language 机器人的语言。
 * @returns 没搜到是 ''。
 */
export function describe(hits: RecallHit[], language: string): string {
  if (hits.length === 0) return '';

  const head = language === 'en'
    ? '# Possibly relevant memory (found by the program from this message; read the file if it helps, ignore it if not)'
    : '# 可能相关的记忆（程序按这次的话先搜的；有用就读那个文件，没用就不管）';
  return [head, '', ...hits.map((hit) => [`@${hit.file}`, ...hit.lines.map((line) => `  …${line}`)].join('\n'))].join('\n');
}
