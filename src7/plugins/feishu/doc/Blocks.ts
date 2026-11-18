/**
 * Markdown 换成飞书云文档（docx）的块。纯函数，离线测试直接 import。
 * 照 0.4 的 src/channels/FeishuDoc.ts（parseMarkdown、toBlocks、textRuns）。
 * 不做嵌套列表（缩进的子项按平级），不认 Markdown 里的图片语法（图片走工具的 images 参数）。
 */


/** 块类型号（0.4 FeishuDoc.ts:26）：字 2、标题 3 起（1 到 9 级）、无序 12、有序 13、代码 14、引用 15、图片 27、表格 31。 */
export const BLOCK = { text: 2, heading: 3, bullet: 12, ordered: 13, code: 14, quote: 15, image: 27, table: 31 } as const;


/** Markdown 拆出来的一个节点。 */
export type DocNode =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'ordered'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'table'; rows: string[][] };


/** 行内的一个片段。 */
export interface TextRun {
  /** 文字。 */
  content: string;
  /** 样式：粗体、斜体、行内代码、链接。 */
  style: { bold?: boolean; italic?: boolean; inline_code?: boolean; link?: { url: string } };
}


/** 发给飞书的块：字段名随块类型变（text、heading1、bullet……）。 */
export interface Block {
  block_type: number;
  [field: string]: unknown;
}


/**
 * 把行内匹配到的单个 Markdown 标记片断转换成 TextRun。
 * @param token 匹配到的行内片段（`代码`、**粗体**、[文字](链接) 或 *斜体*）。
 * @returns 对应的片段结构；非 http(s) 链接退为纯文字。
 */
function parseRunToken(token: string): TextRun {
  if (token.startsWith('`')) return { content: token.slice(1, -1), style: { inline_code: true } };

  if (token.startsWith('**')) return { content: token.slice(2, -2), style: { bold: true } };

  if (token.startsWith('[')) {
    const middle = token.indexOf('](');
    const url = token.slice(middle + 2, -1);
    let style: TextRun['style'] = {};
    if (/^https?:\/\//iu.test(url)) {
      style = { link: { url } };
    }
    return { content: token.slice(1, middle), style };
  }

  return { content: token.slice(1, -1), style: { italic: true } };
}


/**
 * 行内拆片段：`代码`、**粗体**、*斜体*、[文字](链接)。链接不是 http(s) 的退成纯文字（飞书只认 http(s)，相对路径会报 1770006）。
 * @param text 一行文字。
 * @returns 片段；空的去掉。
 */
export function runs(text: string): TextRun[] {
  const result: TextRun[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > last) {
      result.push({ content: text.slice(last, start), style: {} });
    }
    const token = match[0];
    //M 按行内语法前缀转成对应的 TextRun 片段并收进结果列表。
    const parsed = parseRunToken(token);
    result.push(parsed);
    last = start + token.length;
  }
  if (last < text.length) {
    result.push({ content: text.slice(last), style: {} });
  }
  return result.filter((item) => item.content.length > 0);
}


/**
 * 片段换成飞书的 elements。飞书要求链接地址 URL 编码。
 * @param text 一行文字。
 * @returns elements。
 */
function elements(text: string): unknown[] {
  //M 先拆出行内样式片段，再按飞书要求对 http(s) 链接做 URL 编码后组装为 text_run 数组。
  return runs(text).map((run) => {
    let style: TextRun['style'] = run.style;
    if (run.style.link !== undefined) {
      style = { ...run.style, link: { url: encodeURIComponent(run.style.link.url) } };
    }

    const textRun: Record<string, unknown> = { content: run.content };
    if (Object.keys(style).length > 0) {
      textRun['text_element_style'] = style;
    }
    return { text_run: textRun };
  });
}


/**
 * 表格的一行拆成格子。
 * @param line 一行，比如 |a|b|。
 * @returns 每格的文字。
 */
function cells(line: string): string[] {
  return line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map((cell) => cell.trim());
}


/**
 * Markdown 拆成节点：空行断段、``` 代码块、表头加分隔行是表格、# 标题、> 引用、-*+ 无序、1. 有序、--- 丢掉、别的并进段落。
 * @param markdown Markdown 正文。
 * @returns 节点，照原文先后。
 */
export function parse(markdown: string): DocNode[] {
  const nodes: DocNode[] = [];
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = (): void => {
    const text = paragraph.join('\n').trim();
    if (text !== '') nodes.push({ kind: 'paragraph', text });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    //G 空行：段落断开。
    if (trimmed === '') {
      flush();
      index++;
      continue;
    }

    //G 代码块：到下一个 ``` 为止，换行留着。
    if (trimmed.startsWith('```')) {
      flush();
      const language = trimmed.slice(3).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        body.push(lines[index] ?? '');
        index++;
      }
      index++;
      nodes.push({ kind: 'code', text: body.join('\n'), language });
      continue;
    }

    //G 表格：这一行以 | 开头，下一行是 |-|-| 这样的分隔行。
    const separator = lines[index + 1] ?? '';
    if (trimmed.startsWith('|') && /^\s*\|?[\s:|-]+\|?\s*$/u.test(separator) && separator.includes('-')) {
      flush();
      const rows = [cells(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(cells(lines[index] ?? ''));
        index++;
      }
      nodes.push({ kind: 'table', rows });
      continue;
    }

    //G 标题。
    const heading = /^(#{1,9})\s+(.*)$/u.exec(trimmed);
    if (heading !== null) {
      flush();
      nodes.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: (heading[2] ?? '').trim() });
      index++;
      continue;
    }

    //G 引用：连着的几行 > 并成一个节点。
    if (trimmed.startsWith('>')) {
      flush();
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        body.push((lines[index] ?? '').trim().replace(/^>\s?/u, ''));
        index++;
      }
      nodes.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    //G 分隔线：丢掉。要放在无序列表前面，不然 --- 会被当成列表。
    if (/^(-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) {
      flush();
      index++;
      continue;
    }

    //G 列表项：缩进不算层级，一项一个节点。
    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line);
    if (bullet !== null) {
      flush();
      nodes.push({ kind: 'bullet', text: (bullet[1] ?? '').trim() });
      index++;
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    if (ordered !== null) {
      flush();
      nodes.push({ kind: 'ordered', text: (ordered[1] ?? '').trim() });
      index++;
      continue;
    }

    paragraph.push(trimmed);
    index++;
  }
  //M 文档扫描结束时把末尾尚未提交的连续普通行冲刷为最后一个段落节点。
  flush();
  return nodes;
}


/**
 * 一个节点（表格除外）换成飞书的块：代码块整段一个块（换行留着、不解析行内标记）；别的一行一块（块里带换行飞书报 1770006）。
 * @param node 节点。
 * @returns 块。
 */
export function toBlocks(node: Exclude<DocNode, { kind: 'table' }>): Block[] {
  if (node.kind === 'code') {
    return [{ block_type: BLOCK.code, code: { elements: [{ text_run: { content: node.text } }], style: { language: 1, wrap: true } } }];
  }
  const lines = node.text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.map((line): Block => {
    if (node.kind === 'heading') {
      const level = Math.min(9, Math.max(1, node.level));
      //M 将标题级别映射到飞书 block_type 与对应 headingN 字段并渲染行内文本元素。
      return { block_type: BLOCK.heading + level - 1, [`heading${String(level)}`]: { elements: elements(line), style: {} } };
    }
    const kinds = {
      paragraph: { type: BLOCK.text, field: 'text' },
      bullet: { type: BLOCK.bullet, field: 'bullet' },
      ordered: { type: BLOCK.ordered, field: 'ordered' },
      quote: { type: BLOCK.quote, field: 'quote' },
    } as const;
    const kind = kinds[node.kind];
    //M 按段落、无序列表、有序列表或引用类型查表生成对应飞书块及行内文本元素。
    return { block_type: kind.type, [kind.field]: { elements: elements(line), style: {} } };
  });
}
