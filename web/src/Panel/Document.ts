/**
 * 当前文字片段的结构阅读：识别现有会话的运行、步骤、角色和普通 Markdown 标题。
 * 围栏里的伪标题不进入目录；相邻片段只保存围栏边界，不缓存任何旧片段正文。
 */


/** 一块已确认的文档结构。 */
export type DocumentKind = 'section' | 'run' | 'step' | 'user' | 'assistant'
  | 'tool-call' | 'tool-result' | 'thinking' | 'program' | 'review' | 'fragment';


/** 一个独立阅读块，key 来自文件片段起点和行号。 */
export interface DocumentBlock {
  /** 当前文件内稳定的块标识。 */
  key: string;
  /** 结构或角色，不推断未记录的身份。 */
  kind: DocumentKind;
  /** 标题原文或角色原文，尚无标题时为空。 */
  title: string;
  /** Markdown 标题层级；角色使用 0。 */
  level: number;
  /** 原记录中的时分秒文本，不能据此推断日期或时区。 */
  time: string | null;
  /** 去掉结构头后的正文，仍保留 Markdown。 */
  body: string;
  /** 原文片段，不改变原文件。 */
  raw: string;
  /** 用于收起状态的短摘要。 */
  summary: string;
  /** 长结果和思考默认收起，普通章节默认展开。 */
  collapsed: boolean;
}


/** 当前一个分段的结构结果，不宣称是整份文件的目录。 */
export interface DocumentPage {
  /** 按当前片段的原顺序排列。 */
  blocks: DocumentBlock[];
  /** 按标题层级包含子步骤与角色；收起运行会连同子内容一起隐藏。 */
  nodes: DocumentNode[];
  /** 只有已确认的章节、运行和步骤进入目录。 */
  outline: DocumentBlock[];
  /** false 表示直接跳到中段，缺少上文围栏状态，只能保守显示原文接续。 */
  structureKnown: boolean;
  /** 片段结尾尚未结束的围栏；null 表示不在代码块，undefined 表示上文未知。 */
  endingFence: string | null | undefined;
}


/** 轻量结构树；正文仍引用原 block，不复制全部子内容。 */
export interface DocumentNode {
  /** 这层的标题、角色或接续片段。 */
  block: DocumentBlock;
  /** 这层章节中的步骤、角色与下级章节。 */
  children: DocumentNode[];
}


/** 现有会话文件中的角色文字；这是文件证据，不是界面翻译表。 */
const ROLES: Record<string, DocumentKind> = {
  用户: 'user',
  助手: 'assistant',
  调用: 'tool-call',
  结果: 'tool-result',
  思考: 'thinking',
  程序: 'program',
  审核: 'review',
};


/** 解析当前段，并仅保留读过的分段边界供后续段识别围栏。 */
export class DocumentReader {
  /** 偏移量到围栏状态；没有旧正文，重新挂载到未知中段时不会假装知道上文。 */
  private readonly boundaries = new Map<number, string | null>([[0, null]]);

  /**
   * 解析本段并记录下一段开始时的围栏状态。
   * @param text 最多 1MB 的当前文字。
   * @param offset 本段真实字节起点。
   * @param nextOffset API 返回的后续完整字符位置，读完为 null。
   * @returns 本段的结构；未知中段保留原文，不误把代码当标题。
   */
  read(text: string, offset = 0, nextOffset: number | null = null): DocumentPage {
    const fence = this.boundaries.get(offset);
    const page = this.parse(text, offset, fence);
    if (nextOffset !== null && page.endingFence !== undefined && text.endsWith('\n')) {
      this.boundaries.set(nextOffset, page.endingFence);
    }
    return page;
  }

  /** 给读取后的段提供结构；不读文件、不执行工具，也不改原文。 */
  private parse(text: string, offset: number, initialFence: string | null | undefined): DocumentPage {
    if (initialFence === undefined) {
      const fragment = this.block('fragment', '', 0, text, text, offset, 0);
      return {
        blocks: [fragment],
        nodes: [{ block: fragment, children: [] }],
        outline: [],
        structureKnown: false,
        endingFence: undefined,
      };
    }

    const blocks: DocumentBlock[] = [];
    let fence = initialFence;
    let heading = '';
    let kind: DocumentKind = initialFence ? 'fragment' : 'section';
    let level = 0;
    let firstLine = 0;
    let rawLines: string[] = [];
    let bodyLines: string[] = [];

    /** 当前块结束时才拼接正文；保留行顺序，不把各段压在一起。 */
    const flush = (): void => {
      if (rawLines.length === 0) {
        return;
      }
      const raw = rawLines.join('\n');
      const body = bodyLines.join('\n');
      blocks.push(this.block(kind, heading, level, body, raw, offset, firstLine));
      rawLines = [];
      bodyLines = [];
    };

    for (const [lineNumber, line] of text.split('\n').entries()) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence !== null) {
        rawLines.push(line);
        bodyLines.push(line);
        if (delimiter && delimiter[1]![0] === fence[0]
          && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) {
          fence = null;
        }
        continue;
      }
      if (delimiter) {
        fence = delimiter[1]!;
        rawLines.push(line);
        bodyLines.push(line);
        continue;
      }

      const title = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      const role = /^【(用户|助手|调用|结果|思考|程序|审核)([^】]*)】(.*)$/.exec(line);
      if (title || role) {
        flush();
        firstLine = lineNumber;
        heading = title ? title[2]! : `${role![1]!}${role![2]!}`;
        level = title ? title[1]!.length : 0;
        kind = role ? ROLES[role[1]!]! : this.headingKind(heading);
        rawLines.push(line);
        if (role?.[3]) {
          bodyLines.push(role[3]);
        }
      } else {
        rawLines.push(line);
        bodyLines.push(line);
      }
    }
    flush();

    return {
      blocks,
      nodes: this.tree(blocks),
      outline: blocks.filter((block) => block.level > 0),
      structureKnown: true,
      endingFence: fence,
    };
  }

  /** 标题形成父子关系，角色归于最近章节；不把运行标题与它的步骤拆成平铺卡片。 */
  private tree(blocks: DocumentBlock[]): DocumentNode[] {
    const roots: DocumentNode[] = [];
    const parents: DocumentNode[] = [];
    for (const block of blocks) {
      const node: DocumentNode = { block, children: [] };
      if (block.level > 0) {
        while (parents.length > 0 && parents.at(-1)!.block.level >= block.level) {
          parents.pop();
        }
      }
      const parent = parents.at(-1);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
      if (block.level > 0) {
        parents.push(node);
      }
    }
    return roots;
  }

  /** 会话已有标题用于分类，不根据正文猜阶段或执行结果。 */
  private headingKind(title: string): DocumentKind {
    if (/第\s*\d+\s*次运行/.test(title)) {
      return 'run';
    }
    if (/第\s*\d+\s*步/.test(title)) {
      return 'step';
    }
    return 'section';
  }

  /** 把一个阅读块整理成短摘要与明确收放默认值，不保存图片或系统对象。 */
  private block(
    kind: DocumentKind,
    title: string,
    level: number,
    body: string,
    raw: string,
    offset: number,
    line: number,
  ): DocumentBlock {
    const plain = body.replace(/[`#*>]/g, '').replace(/\s+/g, ' ').trim();
    const summary = plain.length > 180 ? `${plain.slice(0, 180)}…` : plain;
    const time = /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?\b/.exec(title)?.[0] ?? null;
    return {
      key: `doc:${String(offset)}:${String(line)}:${kind}`,
      kind,
      title,
      level,
      time,
      body,
      raw,
      summary,
      collapsed: kind === 'thinking' || kind === 'tool-result' || body.length > 2000,
    };
  }
}
