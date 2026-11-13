/**
 * 开会话时程序先替模型搜一次记忆（docs/界面/03_进度事件和复盘设计.md 第 5 节）。
 * 调研数过：22 个会话里 memory 只搜了 9 次、6 次没搜到，模型很少想起来搜，搜也是拿整句话硬匹配。
 * 所以开会话时程序拿用户的原话，在自己的记忆、公共记忆、个人技能、全局技能里按“相邻两个字一组”打分，
 * 挑最像的几个文件，给出路径和最相关的几行，放进开场那条消息。不调模型、不占工具调用；找不到就什么也不放。
 * memory 工具的 search 搜这几处也用这里（多给几个文件、短话也算），整句话也能搜到，不用按关键字硬匹配。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';


/** 最多给几个文件。 */
const MAX_FILES = 3;

/** 每个文件最多给几行。 */
const MAX_LINES = 3;

/** 每行最多多少字。 */
const LINE_CHARS = 160;

/** 一个文件至少对上几分才算相关（太少多半是碰巧）：两个字一组算 1 分，英文和数字的整词算 2 分（更有区分度）。 */
const MIN_HITS = 3;

/** 比这大的文件不看，字节。 */
const MAX_FILE_BYTES = 256 * 1024;

/** 不用再给的文件：记忆概要已经在开场消息里了。 */
const SKIP_NAMES = new Set(['索引.md', 'index.md']);


/** 怎么搜（不写就是开会话时先搜的那种）。 */
export interface RecallOptions {
  /** 最多给几个文件，默认 3。 */
  maxFiles?: number;
  /** 短话也算：问的话字组总分不到门槛时，字组全对上就算相关（memory 工具用；开会话时先搜的不用，短话容易碰巧对上）。 */
  loose?: boolean;
}


/** 搜到的一个文件。 */
export interface RecallHit {
  /** 文件的绝对路径。 */
  file: string;
  /** 分数：对上的字组越多、文件越短越高。 */
  score: number;
  /** 最相关的几行。 */
  lines: string[];
}


/**
 * 把一段话拆成“相邻两个字一组”的集合，英文和数字按整词算。中文不用分词也能大致比出像不像。
 * @param text 一段话。
 * @returns 字组。
 */
export function grams(text: string): Set<string> {
  /** 结果。 */
  const found = new Set<string>();
  //M 英文和数字单独成段（“给Claude留话”要拆成“给”“claude”“留话”），别的字母和汉字连成一段。
  for (const run of text.toLowerCase().match(/[a-z0-9]+|(?:(?![a-z0-9])[\p{L}\p{N}])+/gu) ?? []) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 3) {
        found.add(run);
      }
      continue;
    }
    /** 一个个字。 */
    const chars = [...run];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      found.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return found;
}


/**
 * 一组字算几分：英文和数字的整词 2 分，两个字一组 1 分。
 * @param gram 一组字。
 */
function weight(gram: string): number {
  return /^[a-z0-9]+$/.test(gram) ? 2 : 1;
}


/**
 * 一段字和问的话对上了几分：对上的字组按 weight 加起来。
 * @param wanted 问的话的字组（grams 的结果）。
 * @param text 一段字（一个文件、一个片段）。
 */
export function matchScore(wanted: Set<string>, text: string): number {
  return [...grams(text)].filter((gram) => wanted.has(gram)).reduce((sum, gram) => sum + weight(gram), 0);
}


/**
 * 一个文件夹下的 Markdown 文件（文件夹不存在就是空的）。
 * @param root 文件夹。
 */
async function markdownFiles(root: string): Promise<string[]> {
  try {
    /** 相对路径。 */
    const names = await Array.fromAsync(new Bun.Glob('**/*.md').scan({ cwd: root, onlyFiles: true }));
    return names.filter((name) => !SKIP_NAMES.has(path.basename(name))).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}


/**
 * 在几个文件夹里找和这段话最像的文件。
 * @param roots 文件夹：自己的记忆、公共记忆、个人技能、全局技能。
 * @param query 用户的原话。
 * @param options 最多几个文件、短话算不算。
 * @returns 最像的几个，分数从高到低；没有像的就是空的。
 */
export async function recall(roots: string[], query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
  /** 问的话的字组。 */
  const wanted = grams(query);
  if (wanted.size === 0) {
    return [];
  }
  /** 至少对上几分：短话也算时，最多要求字组全对上。 */
  const need = options.loose ? Math.min(MIN_HITS, [...wanted].reduce((sum, gram) => sum + weight(gram), 0)) : MIN_HITS;
  /** 打过分的。 */
  const hits: RecallHit[] = [];
  for (const root of roots) {
    for (const file of await markdownFiles(root)) {
      /** 全文。 */
      const text = await fs.stat(file).then((stat) => (stat.size <= MAX_FILE_BYTES ? fs.readFile(file, 'utf8') : ''), () => '');
      /** 对上了几分。 */
      const matched = matchScore(wanted, text);
      if (matched < need) {
        continue;
      }
      /** 对上最多的几行。 */
      const lines = text
        .split(/\r?\n/)
        .map((line) => ({ line: line.trim(), hits: [...grams(line)].filter((gram) => wanted.has(gram)).length }))
        .filter((item) => item.line && item.hits > 0)
        .sort((left, right) => right.hits - left.hits)
        .slice(0, MAX_LINES)
        .map((item) => ([...item.line].length > LINE_CHARS ? `${[...item.line].slice(0, LINE_CHARS).join('')}…` : item.line));
      hits.push({ file, score: matched / Math.sqrt(text.length + 100), lines });
    }
  }
  return hits.sort((left, right) => right.score - left.score).slice(0, options.maxFiles ?? MAX_FILES);
}


/**
 * 搜到的写成开场消息里的一段。
 * @param hits 搜到的。
 * @param language 机器人的语言。
 * @returns 一段话；没搜到是空字符串。
 */
export function describeRecall(hits: RecallHit[], language: 'zh' | 'en'): string {
  if (hits.length === 0) {
    return '';
  }
  /** 标题。 */
  const head = language === 'en'
    ? '# Possibly relevant memory (found by the program from this message; read the file if it helps, ignore it if not)'
    : '# 可能相关的记忆（程序按这次的话先搜的；有用就读那个文件，没用就不管）';
  return [head, '', ...hits.map((hit) => [`@${hit.file}`, ...hit.lines.map((line) => `  …${line}`)].join('\n'))].join('\n');
}
