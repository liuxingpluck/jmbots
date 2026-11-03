/**
 * 飞书云文档：把一份 Markdown 和几张图片发布成一篇 docx 文档，并把可编辑权限给聊天里的用户。
 * 只用开放接口，不碰消息层；核心不知道飞书，工具在这里落地。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as media from './FeishuMedia.ts';
import * as feishu from './Feishu.ts';
import type * as eventsModule from '../store/Events.ts';

/** 发布一篇文档要的东西；路径已经由工具按工作区解析成绝对路径。 */
export interface DocRequest {
  /** 文档标题。 */
  title: string;
  /** Markdown 正文（已读出的文本）。 */
  markdown: string;
  /** 放在最前面的图片，按给的顺序；没有就是空数组。 */
  images: string[];
}

/** 发布结果。 */
export interface DocResult {
  /** 文档 ID（URL 里的那段）。 */
  documentId: string;
  /** 文档链接。 */
  url: string;
  /** 拿到可编辑权限的人；没给出去时没有。 */
  grantedTo?: string;
  /** 建好了但权限没给全时的说明；一切正常时没有。 */
  note?: string;
}

/** 飞书 docx 里用到的块类型编号。 */
const BLOCK = { text: 2, heading: 3, bullet: 12, ordered: 13, code: 14, quote: 15, image: 27, table: 31 } as const;

/** Markdown 解析出来的一个块。 */
export type DocNode =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'ordered'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'table'; rows: string[][] };

/** 飞书文本片段。 */
interface TextRun {
  content: string;
  style: { bold?: boolean; italic?: boolean; inline_code?: boolean; link?: { url: string } };
}

/** 发给飞书的块（字段名随块类型变）。 */
interface Block {
  block_type: number;
  [field: string]: unknown;
}

/**
 * 把一行里的行内标记拆成飞书文本片段：`代码`、**粗体**、*斜体*、[文字](链接)。
 * @param text 一行或一段文字。
 * @returns 文本片段。
 */
export function textRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) { runs.push({ content: text.slice(last, start), style: {} }); }
    const token = match[0];
    if (token.startsWith('`')) {
      runs.push({ content: token.slice(1, -1), style: { inline_code: true } });
    } else if (token.startsWith('**')) {
      runs.push({ content: token.slice(2, -2), style: { bold: true } });
    } else if (token.startsWith('[')) {
      const cut = token.indexOf('](');
      runs.push({ content: token.slice(1, cut), style: { link: { url: token.slice(cut + 2, -1) } } });
    } else {
      runs.push({ content: token.slice(1, -1), style: { italic: true } });
    }
    last = start + token.length;
  }
  if (last < text.length) { runs.push({ content: text.slice(last), style: {} }); }
  return runs.filter((run) => run.content.length > 0);
}

/**
 * 文本片段转成飞书 elements。
 * @param text 一段文字（可以带换行）。
 * @returns 飞书 elements。
 */
function elements(text: string): unknown[] {
  return textRuns(text).map((run) => ({
    text_run: { content: run.content, ...(Object.keys(run.style).length ? { text_element_style: run.style } : {}) },
  }));
}

/**
 * 把一段 Markdown 拆成块：标题、段落、无序/有序列表、引用、代码块、表格。
 * 缩进的子项按平级处理（文档里看起来仍然是一组，只是不嵌套）。
 * @param markdown Markdown 正文。
 * @returns 块列表。
 */
export function parseMarkdown(markdown: string): DocNode[] {
  /** 结果。 */
  const nodes: DocNode[] = [];
  /** 按行读。 */
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  /** 段落缓冲区。 */
  let paragraph: string[] = [];
  /** 把段落缓冲区收成一个块。 */
  const flush = (): void => {
    const text = paragraph.join('\n').trim();
    if (text) { nodes.push({ kind: 'paragraph', text }); }
    paragraph = [];
  };
  /** 去掉表格单元格两边的竖线和空格。 */
  const cells = (line: string): string[] => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    //G 空行：段落断开。
    if (!trimmed) { flush(); index++; continue; }
    //G 代码块。
    if (trimmed.startsWith('```')) {
      flush();
      const language = trimmed.slice(3).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) { body.push(lines[index] ?? ''); index++; }
      index++;
      nodes.push({ kind: 'code', text: body.join('\n'), language });
      continue;
    }
    //G 表格：表头 + 分隔行。
    if (trimmed.startsWith('|') && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1] ?? '') && (lines[index + 1] ?? '').includes('-')) {
      flush();
      const rows: string[][] = [cells(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) { rows.push(cells(lines[index] ?? '')); index++; }
      nodes.push({ kind: 'table', rows });
      continue;
    }
    //G 标题。
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      nodes.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: (heading[2] ?? '').trim() });
      index++;
      continue;
    }
    //G 引用。
    if (trimmed.startsWith('>')) {
      flush();
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        body.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index++;
      }
      nodes.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    //G 列表项（缩进不算层级，扁平处理）。
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      nodes.push({ kind: 'bullet', text: (bullet[1] ?? '').trim() });
      index++;
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flush();
      nodes.push({ kind: 'ordered', text: (ordered[1] ?? '').trim() });
      index++;
      continue;
    }
    //G 分界线当作空段落下的一句说明，不用分割块（避免编辑器里多一条横线）。
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { flush(); index++; continue; }
    paragraph.push(trimmed);
    index++;
  }
  flush();
  return nodes;
}

/**
 * 一个块节点转成飞书块。
 * @param node 节点。
 * @returns 飞书块。
 */
function toBlock(node: Exclude<DocNode, { kind: 'table' }>): Block {
  if (node.kind === 'heading') {
    const level = Math.min(9, Math.max(1, node.level));
    return { block_type: BLOCK.heading + level - 1, [`heading${level}`]: { elements: elements(node.text), style: {} } };
  }
  const kinds = {
    paragraph: { type: BLOCK.text, field: 'text', style: {} },
    bullet: { type: BLOCK.bullet, field: 'bullet', style: {} },
    ordered: { type: BLOCK.ordered, field: 'ordered', style: {} },
    quote: { type: BLOCK.quote, field: 'quote', style: {} },
    code: { type: BLOCK.code, field: 'code', style: { language: 1, wrap: true } },
  } as const;
  const kind = kinds[node.kind];
  //G 代码块的内容原样放进一个文本片段：不解析行内标记，否则代码里的反引号、星号会被吃掉。
  const content = node.kind === 'code' ? [{ text_run: { content: node.text } }] : elements(node.text);
  return { block_type: kind.type, [kind.field]: { elements: content, style: kind.style } };
}

/** 飞书云文档的发布器；传输层注入，便于离线测试。 */
export interface DocPublisher {
  /** 建文档 → 插图片 → 写正文 → 给权限。 */
  publish(request: DocRequest, chatId: string): Promise<DocResult>;
}

/** 每次插块的最大个数（飞书限制 50）。 */
const BATCH = 40;

/** 写入接口的 QPS 限制：一个接一个写时每步之间停一下。 */
const PACE_MS = 250;

/** 建表格块时行数、列数的上限（超过报 1770001 invalid param，2026-11-03 实测 9 行成功、10 行失败）；多的建好后再逐行逐列追加。 */
const TABLE_CREATE_MAX = 9;

/**
 * 等一会儿（飞书写入接口有 QPS 限制）。
 * @param ms 毫秒。
 */
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给权限相关的报错补一句该开哪些权限。
 * @param error 原始错误。
 * @param apiPath 出错的接口。
 * @returns 补过说明的错误。
 */
function withScopeHint(error: unknown, apiPath: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!/99991672|99991663|permission|scope|access denied|权限/i.test(message)) {
    return new Error(`飞书接口 ${apiPath}：${message}`);
  }
  return new Error(`飞书接口 ${apiPath}：${message}；请到开发者后台给应用开通 docx:document（创建、编辑云文档）、drive:drive（云空间文件读写），发布版本后重试`);
}

/**
 * 建一个发布器。
 * @param api 开放接口客户端（与消息层共用，自动带 tenant_access_token）。
 * @returns 发布器。
 */
export function createDocPublisher(api: media.OpenApi): DocPublisher {
  /**
   * 调接口，出错时补上权限说明。
   * @param method HTTP 方法。
   * @param apiPath 路径。
   * @param body 请求体。
   * @returns 返回的 data。
   */
  async function call(method: string, apiPath: string, body?: unknown): Promise<Record<string, unknown>> {
    try {
      return await api.json(method, apiPath, body);
    } catch (error) {
      throw withScopeHint(error, apiPath);
    }
  }

  /**
   * 往某个父块末尾插一批块。
   * @param documentId 文档 ID。
   * @param parentId 父块 ID。
   * @param children 块。
   * @param index 插入位置。
   * @returns 插进去的块 ID，按顺序。
   */
  async function insert(documentId: string, parentId: string, children: Block[], index: number): Promise<string[]> {
    /** 返回的块。 */
    const data = await call('POST', `/docx/v1/documents/${documentId}/blocks/${parentId}/children`, { children, index });
    const created = data.children as { block_id?: unknown }[] | undefined;
    return (created ?? []).map((item) => (typeof item.block_id === 'string' ? item.block_id : ''));
  }

  /**
   * 上传一张图片并填进一个空图片块。
   * @param documentId 文档 ID。
   * @param blockId 图片块的 ID。
   * @param file 图片路径。
   */
  async function fillImage(documentId: string, blockId: string, file: string): Promise<void> {
    /** 文件内容。 */
    const content = await fs.readFile(file);
    /** 上传表单。 */
    const form = new FormData();
    form.set('file_name', path.basename(file));
    form.set('parent_type', 'docx_image');
    form.set('parent_node', blockId);
    form.set('size', String(content.length));
    form.set('file', new Blob([content]), path.basename(file));
    /** 上传结果。 */
    const uploaded = await call('POST', '/drive/v1/medias/upload_all', form);
    const token = uploaded.file_token;
    if (typeof token !== 'string' || !token) { throw new Error('飞书上传图片成功但没有返回 file_token'); }
    await call('PATCH', `/docx/v1/documents/${documentId}/blocks/${blockId}`, { replace_image: { token } });
  }

  /**
   * 建一个表格块，并把每个单元格填上文字。
   * @param documentId 文档 ID。
   * @param parentId 父块 ID。
   * @param rows 表格内容（第一行是表头）。
   * @param index 插入位置。
   * @returns 表格块 ID。
   */
  async function insertTable(documentId: string, parentId: string, rows: string[][], index: number): Promise<string> {
    /** 列数。 */
    const columns = Math.max(...rows.map((row) => row.length));
    /** 规整成矩形。 */
    const grid = rows.map((row) => Array.from({ length: columns }, (_, i) => row[i] ?? ''));
    /** 建块时的行数、列数（不超过上限）。 */
    const createRows = Math.min(grid.length, TABLE_CREATE_MAX);
    const createColumns = Math.min(columns, TABLE_CREATE_MAX);
    /** 建好的表格块。 */
    const [tableId = ''] = await insert(documentId, parentId, [{
      block_type: BLOCK.table,
      table: { property: { row_size: createRows, column_size: createColumns, column_width: Array.from({ length: createColumns }, () => Math.floor(700 / columns)), header_row: true } },
    }], index);
    if (!tableId) { throw new Error('飞书建表格块成功但没有返回块 ID'); }
    //M 超出上限的行和列，一次追加一行（列）到末尾（-1 表示末尾）。
    /** 表格块的更新接口。 */
    const tablePath = `/docx/v1/documents/${documentId}/blocks/${tableId}?document_revision_id=-1`;
    for (let added = createRows; added < grid.length; added++) {
      await call('PATCH', tablePath, { insert_table_row: { row_index: -1 } });
      await pause(PACE_MS);
    }
    for (let added = createColumns; added < columns; added++) {
      await call('PATCH', tablePath, { insert_table_column: { column_index: -1 } });
      await pause(PACE_MS);
    }
    //M 单元格由服务端自动建好；只取这个表格块（不列全文，长文档超过一页 500 块时会找不到），按 children 顺序（逐行逐列）填文字。
    /** 表格块。 */
    const fetched = await call('GET', tablePath);
    const table = fetched.block as { children?: unknown; table?: { cells?: unknown } } | undefined;
    /** 单元格 ID：一般在 children，退路是 table.cells。 */
    const rawCells = Array.isArray(table?.children) ? table.children : table?.table?.cells;
    const cellIds = Array.isArray(rawCells) ? (rawCells as unknown[]).filter((value): value is string => typeof value === 'string') : [];
    if (cellIds.length < grid.length * columns) {
      throw new Error(`飞书表格只返回了 ${cellIds.length} 个单元格，少于 ${grid.length}×${columns}`);
    }
    for (let row = 0; row < grid.length; row++) {
      for (let column = 0; column < columns; column++) {
        /** 单元格里的文字。 */
        const text = grid[row]?.[column] ?? '';
        if (!text) { continue; }
        /** 单元格块。 */
        const cellId = cellIds[row * columns + column];
        if (!cellId) { continue; }
        await insert(documentId, cellId, [toBlock({ kind: 'paragraph', text })], 0);
        await pause(PACE_MS);
      }
    }
    return tableId;
  }

  /**
   * 找出聊天里的用户 open ID（一对一聊天里除机器人外就是这个用户）。
   * @param chatId 聊天 ID。
   * @returns open ID；查不到时没有。
   */
  async function memberOpenId(chatId: string): Promise<string | undefined> {
    try {
      /** 成员列表。 */
      const data = await call('GET', `/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=open_id&page_size=20`);
      const items = (data.items as { member_id?: unknown; member_id_type?: unknown }[] | undefined) ?? [];
      /** 只要 open_id 形式的成员。 */
      const ids = items.map((item) => item.member_id).filter((id): id is string => typeof id === 'string' && id.startsWith('ou_'));
      return ids[0];
    } catch {
      return undefined;
    }
  }

  return {
    async publish(request, chatId) {
      if (!request.title.trim()) { throw new Error('文档标题不能为空'); }
      //M 1. 建文档。
      /** 建好的文档。 */
      const created = await call('POST', '/docx/v1/documents', { title: request.title.trim() });
      const document = created.document as { document_id?: unknown } | undefined;
      const documentId = typeof document?.document_id === 'string' ? document.document_id : '';
      if (!documentId) { throw new Error('飞书建文档成功但没有返回 document_id'); }

      //M 2. 图片放最前面。
      let index = 0;
      for (const file of request.images) {
        const [blockId = ''] = await insert(documentId, documentId, [{ block_type: BLOCK.image, image: {} }], index);
        if (!blockId) { throw new Error('飞书建图片块成功但没有返回块 ID'); }
        await fillImage(documentId, blockId, file);
        index++;
        await pause(PACE_MS);
      }

      //M 3. 正文：普通块攒一批一起插，表格单独插。
      /** 待插的普通块。 */
      let pending: Block[] = [];
      /** 把攒着的普通块插进去。 */
      const flush = async (): Promise<void> => {
        for (let start = 0; start < pending.length; start += BATCH) {
          /** 这一批。 */
          const chunk = pending.slice(start, start + BATCH);
          await insert(documentId, documentId, chunk, index);
          index += chunk.length;
          await pause(PACE_MS);
        }
        pending = [];
      };
      for (const node of parseMarkdown(request.markdown)) {
        if (node.kind === 'table') {
          await flush();
          await insertTable(documentId, documentId, node.rows, index);
          index++;
          continue;
        }
        pending.push(toBlock(node));
        if (pending.length >= BATCH) { await flush(); }
      }
      await flush();

      //M 4. 可编辑权限给聊天里的用户；查不到人就把链接设成组织内可编辑，并在结果里说明。
      const openId = await memberOpenId(chatId);
      if (openId) {
        await call('POST', `/drive/v1/permissions/${encodeURIComponent(documentId)}/members?type=docx&need_notification=false`, {
          member_type: 'openid', member_id: openId, perm: 'full_access',
        });
        return { documentId, url: `https://feishu.cn/docx/${documentId}`, grantedTo: openId };
      }
      /** 退路：链接分享给本组织的人可编辑。 */
      await call('PATCH', `/drive/v1/permissions/${encodeURIComponent(documentId)}/public?type=docx`, { link_share_entity: 'tenant_editable' });
      return {
        documentId, url: `https://feishu.cn/docx/${documentId}`,
        note: '没查到聊天里的用户 open_id（可能要 im:chat:readonly 权限），改成把链接设成组织内可编辑',
      };
    },
  };
}

/**
 * 给工具用的发布函数：按会话找到飞书聊天，再把结果写成一句话。
 * @param publisher 发布器。
 * @param store 数据库（查会话来源，找该发给谁）。
 * @returns (会话 ID, 请求) → 结果说明。
 */
export function createDocSender(publisher: DocPublisher, store: eventsModule.EventStore): (sessionId: string, request: DocRequest) => Promise<string> {
  return async (sessionId, request) => {
    /** 聊天 ID：来自飞书就是那个聊天，否则是最近私聊过机器人的人。 */
    const chatId = feishu.chatOf(store, sessionId);
    /** 发布结果。 */
    const result = await publisher.publish(request, chatId);
    /** 权限说明。 */
    const permission = result.grantedTo ? '可编辑权限已给聊天里的用户' : (result.note ?? '');
    return `已发布飞书文档《${request.title}》：${result.url}${permission ? `（${permission}）` : ''}`;
  };
}
