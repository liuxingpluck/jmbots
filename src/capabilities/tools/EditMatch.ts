/**
 * edit 工具的核心：在文件内容里找到每段 oldText，换成 newText。
 *   1. 先精确找；找不到再“宽松”找（去掉行尾空白，中文引号、各种破折号、特殊空格都当成普通的）。
 *   2. 每段 oldText 必须只出现一次，几段之间不能重叠；都对照同一份原文找，从后往前换。
 *   3. 用了宽松匹配时，只有被改到的那几行用规整后的文字，其余行原样保留。
 *   4. 文件开头的 BOM 和换行符（\r\n 还是 \n）改完照原样还回去。
 *
 * 来源：Pi（F:\aidata\source\Pi\packages\coding-agent\src\core\tools\edit-diff.ts 和 edit.ts，2026-10-22 的 8c03fef），
 * 只留了匹配和替换，没要差异预览。
 */


/** 一处修改。 */
export interface Edit {
  /** 要替换的原文：必须在文件里只出现一次。 */
  oldText: string;

  /** 换成什么。 */
  newText: string;
}


/** 找到的一处修改：在（规整后的）内容里的位置。 */
interface Matched {
  /** 第几处修改（从 0 数），报错时用。 */
  index: number;

  /** 从哪个字符开始。 */
  start: number;

  /** 原文多长。 */
  length: number;

  /** 换成什么。 */
  newText: string;
}


/**
 * 宽松匹配用的规整：Unicode 兼容规整（NFKC），去掉每行行尾空白，引号、破折号、特殊空格换成 ASCII 的。
 * @param text 文本。
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}


/**
 * 把模型给的参数整理成修改列表。模型常见的几种写法都认：
 *   edits 是数组（标准写法）、edits 是 JSON 字符串、edits 是单个对象、
 *   顶层直接写 oldText/newText 或 old_text/new_text（旧写法）。
 * @param args 模型给的参数。
 * @throws 一处修改都读不出来时抛错。
 */
export function readEdits(args: Record<string, unknown>): Edit[] {
  /** edits 字段。 */
  let raw: unknown = args.edits;
  //G 模型把数组写成了 JSON 字符串。
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('edits 要是数组：[{ "oldText": "...", "newText": "..." }]');
    }
  }
  //G 只写了一处，没包成数组。
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = [raw];
  }
  //G 旧写法：顶层直接写原文和新文。
  if (raw === undefined) {
    raw = [{ oldText: args.oldText ?? args.old_text, newText: args.newText ?? args.new_text }];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('edits 要是非空数组：[{ "oldText": "...", "newText": "..." }]');
  }

  //M 每一项都要有字符串的 oldText 和 newText（也认 old_text、new_text）。
  return raw.map((item: unknown, index) => {
    /** 这一项。 */
    const entry = (item ?? {}) as Record<string, unknown>;
    /** 原文。 */
    const oldText = entry.oldText ?? entry.old_text;
    /** 新文。 */
    const newText = entry.newText ?? entry.new_text;
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      throw new Error(`edits[${index}] 要有字符串的 oldText 和 newText`);
    }
    return { oldText, newText };
  });
}


/**
 * 改文件内容。
 * @param content 文件现在的内容（原样，可能带 BOM、\r\n）。
 * @param edits 修改列表。
 * @param file 文件路径（只用在报错里）。
 * @returns 改好的内容，BOM 和换行符照原样。
 * @throws 原文为空、找不到、不唯一、几处重叠、改完和原来一样时抛错，文件不动。
 */
export function applyEdits(content: string, edits: Edit[], file: string): string {
  //M 1. 拿掉 BOM，换行统一成 \n，记下原来用的是哪种。
  /** 有没有 BOM。 */
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  /** 去掉 BOM 的内容。 */
  const body = content.slice(bom.length);
  /** 原来的换行符：第一个换行是 \r\n 就算 \r\n。 */
  const lineEnding = body.indexOf('\n') > 0 && body[body.indexOf('\n') - 1] === '\r' ? '\r\n' : '\n';
  /** 统一成 \n 的内容。 */
  const normalized = toLF(body);
  /** 修改也统一成 \n。 */
  const list = edits.map((edit) => ({ oldText: toLF(edit.oldText), newText: toLF(edit.newText) }));
  /** 报错时怎么称呼第几处。 */
  const label = (index: number) => (list.length === 1 ? '原文' : `edits[${index}]`);

  //G 2. 原文不能为空（新建文件请用整篇写入，见 Tools.ts 的 edit）。
  for (const [index, edit] of list.entries()) {
    if (edit.oldText.length === 0) {
      throw new Error(`${label(index)} 的 oldText 不能为空：${file}`);
    }
  }

  //M 3. 有一处精确找不到，就整份改在规整后的内容上找。
  /** 要不要宽松匹配。 */
  const fuzzy = list.some((edit) => !normalized.includes(edit.oldText));
  /** 在哪份内容上找。 */
  const base = fuzzy ? normalizeForFuzzyMatch(normalized) : normalized;
  /** 找到的每处修改。 */
  const matches: Matched[] = list.map((edit, index) => {
    /** 要找的原文（宽松匹配时也规整）。 */
    const needle = fuzzy ? normalizeForFuzzyMatch(edit.oldText) : edit.oldText;
    /** 位置。 */
    const start = base.indexOf(needle);
    if (start < 0) {
      throw new Error(`${file} 里找不到${label(index)}：原文要和文件一字不差（包括空白和换行），先用 read 看一下`);
    }
    /** 出现了几次。 */
    const count = base.split(needle).length - 1;
    if (count > 1) {
      throw new Error(`${file} 里${label(index)}出现了 ${count} 次，要唯一：多带几行上下文`);
    }
    return { index, start, length: needle.length, newText: edit.newText };
  });

  //G 4. 几处修改不能重叠。
  matches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i++) {
    /** 前一处。 */
    const previous = matches[i - 1] as Matched;
    /** 这一处。 */
    const current = matches[i] as Matched;
    if (previous.start + previous.length > current.start) {
      throw new Error(`edits[${previous.index}] 和 edits[${current.index}] 在 ${file} 里重叠了：合成一处，或改不重叠的地方`);
    }
  }

  //M 5. 换。宽松匹配时只有被改到的行用规整后的文字。
  /** 改好的内容（\n 换行）。 */
  const changed = fuzzy ? replaceKeepingOtherLines(normalized, base, matches) : replaceAll(base, matches, 0);
  if (changed === normalized) {
    throw new Error(`${file} 没有变化：替换后和原来一样`);
  }

  //M 6. 还原换行符和 BOM。
  return bom + (lineEnding === '\r\n' ? changed.replace(/\n/g, '\r\n') : changed);
}


/**
 * 换行统一成 \n。
 * @param text 文本。
 */
function toLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}


/**
 * 按位置从后往前替换（前面的位置不受影响）。
 * @param content 内容。
 * @param matches 修改，已按位置排好。
 * @param offset 位置要先减去多少（content 是从这个位置截出来的一段时用）。
 */
function replaceAll(content: string, matches: Matched[], offset: number): string {
  /** 结果。 */
  let result = content;
  for (const match of [...matches].reverse()) {
    /** 在 content 里的位置。 */
    const start = match.start - offset;
    result = result.slice(0, start) + match.newText + result.slice(start + match.length);
  }
  return result;
}


/**
 * 切成行，每行带着自己的换行符（最后一行可能没有）。
 * @param content 内容。
 */
function splitKeepingNewlines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}


/**
 * 宽松匹配时的替换：修改是对照规整后的内容找的，被改到的行用规整后的文字替换，其余行从原文照抄。
 * 规整不会增减行（只改行内字符），所以两份内容的行一一对应。
 * @param original 原文（\n 换行）。
 * @param base 规整后的内容。
 * @param matches 修改，已按位置排好。
 * @throws 两份内容行数对不上时抛错。
 */
function replaceKeepingOtherLines(original: string, base: string, matches: Matched[]): string {
  /** 原文的行。 */
  const originalLines = splitKeepingNewlines(original);
  /** 规整后每行的起止位置。 */
  const spans: Array<{ start: number; end: number }> = [];
  /** 算位置用的游标。 */
  let cursor = 0;
  for (const line of splitKeepingNewlines(base)) {
    spans.push({ start: cursor, end: cursor + line.length });
    cursor += line.length;
  }
  if (spans.length !== originalLines.length) {
    throw new Error('宽松匹配后行数对不上，没法只改被改到的行；请照文件原文精确给出 oldText');
  }

  //M 每处修改扩成它碰到的整行；行范围挨着重叠的并成一组。
  /** 各组：从第几行到第几行（不含），组里有哪些修改。 */
  const groups: Array<{ first: number; end: number; items: Matched[] }> = [];
  for (const match of matches) {
    /** 修改结束的位置。 */
    const matchEnd = match.start + match.length;
    /** 开头所在的行。 */
    const first = spans.findIndex((span) => match.start >= span.start && match.start < span.end);
    /** 结尾所在的行。 */
    let last = first;
    while (last >= 0 && last < spans.length && (spans[last] as { end: number }).end < matchEnd) {
      last++;
    }
    if (first < 0 || last >= spans.length) {
      throw new Error('修改的位置超出了文件内容');
    }
    /** 上一组。 */
    const previous = groups[groups.length - 1];
    if (previous && first < previous.end) {
      previous.end = Math.max(previous.end, last + 1);
      previous.items.push(match);
      continue;
    }
    groups.push({ first, end: last + 1, items: [match] });
  }

  //M 拼起来：组之间的行照抄原文，组内用规整后的文字替换。
  /** 结果。 */
  let result = '';
  /** 原文抄到第几行了。 */
  let copied = 0;
  for (const group of groups) {
    result += originalLines.slice(copied, group.first).join('');
    /** 这一组在规整后内容里的起点。 */
    const groupStart = (spans[group.first] as { start: number }).start;
    /** 这一组在规整后内容里的终点。 */
    const groupEnd = (spans[group.end - 1] as { end: number }).end;
    result += replaceAll(base.slice(groupStart, groupEnd), group.items, groupStart);
    copied = group.end;
  }
  return result + originalLines.slice(copied).join('');
}
