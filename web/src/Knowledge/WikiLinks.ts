/**
 * 知识库网页的 [[双链]] 小工具：预览前把 [[标题]]、[[标题|别名]] 换成指向页内锚点的 Markdown 链接（跳过代码），
 * 点链接时认出是哪个标题；编辑时找光标前没写完的 [[、选中候选后插入；标题索引按小写标题查文档号。
 * 跳过代码块和行内代码的规矩和后端 src7/plugins/knowledge/Links.ts 的 parseWikiLinks 一样。
 */
import type * as api from './KnowledgeApi.ts';

/** 预览里双链的地址前缀：#kb-wiki/<1 已有 | 0 没有>/<编码后的标题>。用页内锚点，Markdown 的地址过滤不会删掉它。 */
const WIKI_HREF = '#kb-wiki/';

/** [[目标]] 或 [[目标|别名]]。 */
const WIKI_LINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/gu;

/** 围栏代码块的开头、结尾行。 */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/u;

/** 行内代码。 */
const INLINE_CODE = /(`+)[^`]*?\1/gu;

/** 光标前没写完的 [[：从 [[ 到光标，中间没有方括号、竖线、换行。 */
const OPEN_LINK = /\[\[([^[\]|\n]*)$/u;

/** 链接文字里要转义的 Markdown 符号。 */
const MD_SPECIAL = /[\\[\]*_`<>]/gu;


/** 标题索引：小写标题 → 文档号和原写法。由 KnowledgePage 用整库图谱的节点建。 */
export type TitleIndex = ReadonlyMap<string, { id: string; title: string }>;


/**
 * 用整库图谱的节点建标题索引；同名的留第一篇。
 * @param nodes 图谱节点。
 */
export function getTitleIndex(nodes: readonly api.KnowledgeGraphNode[]): TitleIndex {
  const index = new Map<string, { id: string; title: string }>();
  for (const node of nodes) {
    const key = node.title.trim().toLowerCase();
    if (index.has(key)) continue;

    index.set(key, { id: node.id, title: node.title });
  }
  return index;
}


/**
 * 一段不在代码里的文字：[[ ]] 换成 Markdown 链接，地址里带上这个标题有没有文档。
 * @param text 一段文字。
 * @param titles 标题索引。
 */
function replaceLinks(text: string, titles: TitleIndex): string {
  return text.replace(WIKI_LINK, (_whole, rawTitle: string, rawAlias: string | undefined) => {
    const title = rawTitle.trim();
    if (title === '') return _whole;

    let label = title;
    if (rawAlias !== undefined && rawAlias.trim() !== '') {
      label = rawAlias.trim();
    }
    let flag = '0';
    if (titles.has(title.toLowerCase())) {
      flag = '1';
    }
    const safeLabel = label.replace(MD_SPECIAL, '\\$&');
    return `[${safeLabel}](<${WIKI_HREF}${flag}/${encodeURIComponent(title)}>)`;
  });
}


/**
 * 预览用：把正文里的 [[双链]] 换成 Markdown 链接，围栏代码块和行内代码原样不动。
 * @param content Markdown 正文。
 * @param titles 标题索引，决定显示成“已有”还是“未创建”。
 * @returns 换好的正文。
 */
export function toWikiMarkdown(content: string, titles: TitleIndex): string {
  let fence = '';
  const lines = content.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    //M 围栏代码块里的行原样留着。
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch !== null && fence === '') {
      fence = fenceMatch[1]!.slice(0, 3);
      out.push(line);
      continue;
    }
    if (fenceMatch !== null && fenceMatch[1]!.startsWith(fence)) {
      fence = '';
      out.push(line);
      continue;
    }
    if (fence !== '' || !line.includes('[[')) {
      out.push(line);
      continue;
    }

    //M 行内代码原样留着，代码之间的文字换链接。
    let cursor = 0;
    let built = '';
    for (const code of line.matchAll(INLINE_CODE)) {
      const start = code.index;
      built += replaceLinks(line.slice(cursor, start), titles) + code[0];
      cursor = start + code[0].length;
    }
    built += replaceLinks(line.slice(cursor), titles);
    out.push(built);
  }
  return out.join('\n');
}


/**
 * 认预览里点到的链接是不是双链。
 * @param href 链接地址。
 * @returns 是双链时交回标题；不是交回 undefined。
 */
export function getWikiTitle(href: string): string | undefined {
  if (!href.startsWith(WIKI_HREF)) return undefined;

  //M 地址是 #kb-wiki/<0|1>/<编码后的标题>：去掉前缀和标记位再解码。
  const encoded = href.slice(WIKI_HREF.length + 2);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}


/** 光标前没写完的 [[：从哪里开始、已经敲了什么。 */
export interface OpenLink {
  /** [[ 的第一个 [ 在正文里的位置。 */
  start: number;
  /** [[ 后面已经敲的字。 */
  query: string;
}


/**
 * 找光标前没写完的 [[。
 * @param text 正文。
 * @param caret 光标位置。
 * @returns 有就交回起点和已敲的字；没有是 undefined。
 */
export function getOpenLink(text: string, caret: number): OpenLink | undefined {
  const before = text.slice(0, caret);
  const match = OPEN_LINK.exec(before);
  if (match === null) return undefined;

  return { start: match.index, query: match[1]! };
}


/**
 * 把没写完的 [[查询 换成 [[标题]]；光标后面本来就有 ]] 的，吃掉它免得多出一对。
 * @param text 正文。
 * @param open 没写完的 [[。
 * @param caret 光标位置。
 * @param title 选中的标题。
 * @returns 新正文和插入后光标该在的位置。
 */
export function insertWikiLink(
  text: string,
  open: OpenLink,
  caret: number,
  title: string,
): { text: string; caret: number } {
  let after = text.slice(caret);
  if (after.startsWith(']]')) {
    after = after.slice(2);
  }
  const link = `[[${title}]]`;
  const next = `${text.slice(0, open.start)}${link}${after}`;
  return { text: next, caret: open.start + link.length };
}


/**
 * 候选标题：包含已敲的字（不分大小写），开头就对上的排前面，再按短的在前；最多 limit 个。
 * @param titles 标题索引。
 * @param query 已敲的字。
 * @param limit 最多几个。
 */
export function getSuggestions(titles: TitleIndex, query: string, limit: number): string[] {
  const lower = query.trim().toLowerCase();
  const found: { title: string; rank: number }[] = [];
  for (const [key, entry] of titles) {
    const at = key.indexOf(lower);
    if (at < 0) continue;

    let rank = 1;
    if (at === 0) {
      rank = 0;
    }
    found.push({ title: entry.title, rank });
  }
  found.sort((a, b) => a.rank - b.rank || a.title.length - b.title.length);
  return found.slice(0, limit).map((item) => item.title);
}
