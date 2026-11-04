/** 飞书云文档：Markdown 解析、建文档/插图/表格/权限的接口顺序；不连接真实飞书。 */
import * as test from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as doc from '../src/channels/FeishuDoc.ts';
import type * as media from '../src/channels/FeishuMedia.ts';
import * as events from '../src/events/Events.ts';
import * as tools from '../src/capabilities/tools/Tools.ts';

test.test('Markdown 拆成标题、段落、列表、引用、代码块和表格', () => {
  const nodes = doc.parseMarkdown([
    '## 小标题',
    '',
    '一段话，',
    '接着一行。',
    '',
    '- 无序一',
    '  - 无序二',
    '1. 有序一',
    '2. 有序二',
    '',
    '> 引用一行',
    '> 引用两行',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '| 甲 | 乙 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '| 3 | 4 |',
  ].join('\n'));
  test.expect(nodes.map((node) => node.kind)).toEqual([
    'heading', 'paragraph', 'bullet', 'bullet', 'ordered', 'ordered', 'quote', 'code', 'table',
  ]);
  test.expect(nodes[0]).toEqual({ kind: 'heading', level: 2, text: '小标题' });
  test.expect(nodes[1]).toEqual({ kind: 'paragraph', text: '一段话，\n接着一行。' });
  test.expect(nodes[6]).toEqual({ kind: 'quote', text: '引用一行\n引用两行' });
  test.expect(nodes[7]).toEqual({ kind: 'code', text: 'const a = 1;', language: 'ts' });
  test.expect(nodes[8]).toEqual({ kind: 'table', rows: [['甲', '乙'], ['1', '2'], ['3', '4']] });
});

test.test('行内标记拆成粗体、代码、链接片段', () => {
  const runs = doc.textRuns('用 `read` 读，**注意**看 [链接](https://example.com) 结束');
  test.expect(runs).toEqual([
    { content: '用 ', style: {} },
    { content: 'read', style: { inline_code: true } },
    { content: ' 读，', style: {} },
    { content: '注意', style: { bold: true } },
    { content: '看 ', style: {} },
    { content: '链接', style: { link: { url: 'https://example.com' } } },
    { content: ' 结束', style: {} },
  ]);
});

test.test('代码块的内容原样发出，不解析行内标记', async () => {
  const code = 'const s = `a ${b}`; const m = a * b * c; // **x** [y](z)';
  const sent: unknown[] = [];
  const api: media.OpenApi = {
    json: (method, route, body) => {
      if (route === '/docx/v1/documents') { return Promise.resolve({ document: { document_id: 'doccn_code' } }); }
      if (route.endsWith('/children')) { sent.push(body); return Promise.resolve({ children: [] }); }
      if (route.startsWith('/im/v1/chats/')) { return Promise.resolve({ items: [{ member_id: 'ou_user' }] }); }
      return Promise.resolve({});
    },
    download: () => Promise.reject(new Error('unexpected')),
  };
  await doc.createDocPublisher(api).publish({ title: '代码', markdown: ['```ts', code, '```'].join('\n'), images: [] }, 'oc_x');
  test.expect(sent).toHaveLength(1);
  const block = (sent[0] as { children: { code: { elements: { text_run: Record<string, unknown> }[] } }[] }).children[0]!;
  test.expect(block.code.elements).toEqual([{ text_run: { content: code } }]);
});

test.test('发布：先建文档，图片在最前，再插正文和表格，最后给权限', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-doc-'));
  try {
    const image = path.join(dir, 'flow.png');
    await fs.writeFile(image, 'png-bytes');
    const calls: { method: string; route: string; body: unknown }[] = [];
    let created = 0;
    let tableId = '';
    const api: media.OpenApi = {
      json: (method, route, body) => {
        calls.push({ method, route, body });
        if (route === '/docx/v1/documents') { return Promise.resolve({ document: { document_id: 'doccn_test' } }); }
        if (route.endsWith('/children')) {
          const children = (body as { children: { block_type: number }[] }).children;
          return Promise.resolve({ children: children.map((child) => {
            const blockId = `b${++created}`;
            if (child.block_type === 31) { tableId = blockId; }
            return { block_id: blockId };
          }) });
        }
        if (route === '/drive/v1/medias/upload_all') { return Promise.resolve({ file_token: 'ft_test' }); }
        if (method === 'GET' && route === `/docx/v1/documents/doccn_test/blocks/${tableId}?document_revision_id=-1`) {
          return Promise.resolve({ block: { block_id: tableId, children: ['c1', 'c2', 'c3', 'c4'] } });
        }
        if (route.startsWith('/im/v1/chats/')) { return Promise.resolve({ items: [{ member_id: 'ou_user' }, { member_id: 'cli_bot' }] }); }
        return Promise.resolve({});
      },
      download: () => Promise.reject(new Error('unexpected')),
    };
    const publisher = doc.createDocPublisher(api);
    const markdown = ['# 标题', '', '## 第一节', '', '一句话。', '', '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const result = await publisher.publish({ title: '测试文档', markdown, images: [image] }, 'oc_chat');

    test.expect(result).toEqual({ documentId: 'doccn_test', url: 'https://feishu.cn/docx/doccn_test', grantedTo: 'ou_user' });
    // 建文档
    test.expect(calls[0]).toEqual({ method: 'POST', route: '/docx/v1/documents', body: { title: '测试文档' } });
    // 图片块在最前面：index 0，类型 27
    test.expect(calls[1]!.route).toBe('/docx/v1/documents/doccn_test/blocks/doccn_test/children');
    test.expect(calls[1]!.body).toEqual({ children: [{ block_type: 27, image: {} }], index: 0 });
    const upload = calls[2]!;
    test.expect(upload.route).toBe('/drive/v1/medias/upload_all');
    const form = upload.body as FormData;
    test.expect(form.get('parent_type')).toBe('docx_image');
    test.expect(form.get('parent_node')).toBe('b1');
    test.expect(form.get('size')).toBe(String(Buffer.byteLength('png-bytes')));
    test.expect(calls[3]!.method).toBe('PATCH');
    test.expect(calls[3]!.body).toEqual({ replace_image: { token: 'ft_test' } });
    // 正文在图片后面（index 1 开始），标题是 heading，表格块单独插
    test.expect((calls[4]!.body as { index: number }).index).toBe(1);
    test.expect((calls[4]!.body as { children: { block_type: number }[] }).children.map((block) => block.block_type)).toEqual([3, 4, 2]);
    const table = calls.find((call) => (call.body as { children?: { block_type: number }[] }).children?.[0]?.block_type === 31);
    test.expect(table?.body).toMatchObject({ index: 4, children: [{ block_type: 31, table: { property: { row_size: 2, column_size: 2, header_row: true } } }] });
    // 单元格按行逐列填
    const cells = calls.filter((call) => /\/blocks\/c\d\/children$/.test(call.route));
    test.expect(cells.map((call) => call.route.split('/').at(-2))).toEqual(['c1', 'c2', 'c3', 'c4']);
    // 权限
    const permission = calls.find((call) => call.route.includes('/permissions/'));
    test.expect(permission?.route).toBe('/drive/v1/permissions/doccn_test/members?type=docx&need_notification=false');
    test.expect(permission?.body).toEqual({ member_type: 'openid', member_id: 'ou_user', perm: 'full_access' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test.test('超过 9 行或 9 列的表格：先建 9×9，再逐行逐列追加，单元格全部填上', async () => {
  /** 12 行（含表头）× 10 列；只有表头和最后一格有字（空格不填，免得测试被限速拖慢）。 */
  const rows = Array.from({ length: 12 }, (_, r) => Array.from({ length: 10 }, (_, c) => (r === 0 || (r === 11 && c === 9) ? `r${r}c${c}` : '')));
  const markdown = [
    `| ${rows[0]!.join(' | ')} |`,
    `| ${rows[0]!.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
  const calls: { method: string; route: string; body: unknown }[] = [];
  /** 模拟服务端：表格当前的行数、列数。 */
  let size = { rows: 0, columns: 0 };
  const api: media.OpenApi = {
    json: (method, route, body) => {
      calls.push({ method, route, body });
      if (route === '/docx/v1/documents') { return Promise.resolve({ document: { document_id: 'doccn_big' } }); }
      if (route === '/docx/v1/documents/doccn_big/blocks/doccn_big/children') {
        const property = (body as { children: { table: { property: { row_size: number; column_size: number } } }[] }).children[0]!.table.property;
        size = { rows: property.row_size, columns: property.column_size };
        return Promise.resolve({ children: [{ block_id: 'tbl' }] });
      }
      if (route === '/docx/v1/documents/doccn_big/blocks/tbl?document_revision_id=-1') {
        if (method === 'PATCH') {
          const patch = body as { insert_table_row?: unknown; insert_table_column?: unknown };
          size = { rows: size.rows + (patch.insert_table_row ? 1 : 0), columns: size.columns + (patch.insert_table_column ? 1 : 0) };
          return Promise.resolve({});
        }
        return Promise.resolve({ block: { block_id: 'tbl', children: Array.from({ length: size.rows * size.columns }, (_, i) => `cell${i}`) } });
      }
      if (route.endsWith('/children')) { return Promise.resolve({ children: [{ block_id: 'p' }] }); }
      if (route.startsWith('/im/v1/chats/')) { return Promise.resolve({ items: [{ member_id: 'ou_user' }] }); }
      return Promise.resolve({});
    },
    download: () => Promise.reject(new Error('unexpected')),
  };
  await doc.createDocPublisher(api).publish({ title: '大表格', markdown, images: [] }, 'oc_x');

  const created = calls.find((call) => call.route === '/docx/v1/documents/doccn_big/blocks/doccn_big/children');
  test.expect(created?.body).toMatchObject({ children: [{ table: { property: { row_size: 9, column_size: 9 } } }] });
  const patches = calls.filter((call) => call.method === 'PATCH' && call.route.includes('/blocks/tbl?'));
  test.expect(patches.filter((call) => (call.body as { insert_table_row?: unknown }).insert_table_row)).toHaveLength(3);
  test.expect(patches.filter((call) => (call.body as { insert_table_column?: unknown }).insert_table_column)).toHaveLength(1);
  test.expect(size).toEqual({ rows: 12, columns: 10 });
  const cells = calls.filter((call) => /\/blocks\/cell\d+\/children$/.test(call.route));
  test.expect(cells).toHaveLength(11);
  test.expect(cells.at(-1)!.route).toContain('/blocks/cell119/children');
}, 20_000);

test.test('查不到用户 open_id 时退回组织内可编辑，并说明原因', async () => {
  const calls: { method: string; route: string }[] = [];
  const api: media.OpenApi = {
    json: (method, route) => {
      calls.push({ method, route });
      if (route === '/docx/v1/documents') { return Promise.resolve({ document: { document_id: 'doccn_2' } }); }
      if (route.endsWith('/children')) { return Promise.resolve({ children: [] }); }
      if (route.startsWith('/im/v1/chats/')) { return Promise.reject(new Error('飞书接口 /im/v1/chats/oc_x/members：Access denied（code 99991672）')); }
      return Promise.resolve({});
    },
    download: () => Promise.reject(new Error('unexpected')),
  };
  const result = await doc.createDocPublisher(api).publish({ title: '空文档', markdown: '', images: [] }, 'oc_x');
  test.expect(result.note).toContain('组织内可编辑');
  test.expect(calls.some((call) => call.method === 'PATCH' && call.route.includes('/public?type=docx'))).toBe(true);
});

test.test('缺 docx 权限时的报错说明要开哪些权限', async () => {
  const api: media.OpenApi = {
    json: (method, route) => {
      if (route.startsWith('/docx/')) { return Promise.reject(new Error('飞书接口 /docx/v1/documents：Access denied（code 99991672）')); }
      return Promise.resolve({});
    },
    download: () => Promise.reject(new Error('unexpected')),
  };
  let message = '';
  try { await doc.createDocPublisher(api).publish({ title: '标题', markdown: '', images: [] }, 'oc_x'); } catch (error) { message = (error as Error).message; }
  test.expect(message).toContain('docx:document');
  test.expect(message).toContain('drive:drive');
});

test.test('工具层：读 Markdown 文件、按工作区解析图片，飞书没开时报错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-doctool-'));
  try {
    await fs.writeFile(path.join(dir, 'a.md'), '# 标题\n\n内容');
    await fs.writeFile(path.join(dir, 'a.png'), 'png');
    const seen: doc.DocRequest[] = [];
    const store = events.openEventStore(':memory:');
    const context = {
      workDir: dir, sessionId: 's1', store, execTimeoutMs: 1000, runtimeDir: dir,
      chatPublishDoc: (_sessionId: string, request: doc.DocRequest) => { seen.push(request); return Promise.resolve('ok'); },
    } as unknown as tools.ToolContext;
    const entry = tools.toolDefinitions(tools.CHAT_DOC_TOOLS)[0]!;
    await tools.runTool('feishu_doc', { title: '标题', markdown: 'a.md', images: ['a.png'] }, context);
    test.expect(seen[0]?.markdown).toContain('# 标题');
    test.expect(seen[0]?.images[0]).toBe(path.join(dir, 'a.png'));
    test.expect(entry.name).toBe('feishu_doc');
    test.expect(tools.CHAT_DOC_TOOLS).toEqual(['feishu_doc', 'feishu_doc_delete']);
    store.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test.test('链接只有 http(s) 才发成链接，仓库相对路径退化成纯文字', () => {
  test.expect(doc.textRuns('见 [说明](https://feishu.cn/docx/abc) 和 [源码](../src/resources/Resources.ts)')).toEqual([
    { content: '见 ', style: {} },
    { content: '说明', style: { link: { url: 'https://feishu.cn/docx/abc' } } },
    { content: ' 和 ', style: {} },
    { content: '源码', style: {} },
  ]);
});

test.test('多行引用和多行段落拆成一行一个块（飞书不收带换行的 text_run）', async () => {
  const sent: unknown[] = [];
  const api: media.OpenApi = {
    json: (_method, route, body) => {
      if (route === '/docx/v1/documents') { return Promise.resolve({ document: { document_id: 'doccn_wrap' } }); }
      if (route.endsWith('/children')) { sent.push(body); return Promise.resolve({ children: [] }); }
      if (route.startsWith('/im/v1/chats/')) { return Promise.resolve({ items: [{ member_id: 'ou_user' }] }); }
      return Promise.resolve({});
    },
    download: () => Promise.reject(new Error('unexpected')),
  };
  const markdown = ['> 引用一行', '>', '> 引用三行', '', '段落一行', '段落两行'].join('\n');
  await doc.createDocPublisher(api).publish({ title: '换行', markdown, images: [] }, 'oc_x');
  const children = (sent[0] as { children: Record<string, { elements: { text_run: { content: string } }[] }>[] }).children;
  //G 两个引用块 + 两个段落块，每块一行，没有任何一块的文字里带换行。
  test.expect(children).toHaveLength(4);
  const texts = children.map((block) => Object.values(block).find((value) => typeof value === 'object')?.elements[0]?.text_run.content);
  test.expect(texts).toEqual(['引用一行', '引用三行', '段落一行', '段落两行']);
  test.expect(texts.some((text) => (text ?? '').includes('\n'))).toBe(false);
});

test.test('删文档：一篇一篇放进回收站，删不掉的单独报出来', async () => {
  const deleted: string[] = [];
  const api: media.OpenApi = {
    json: (method, route) => {
      if (method === 'DELETE' && route.startsWith('/drive/v1/files/')) {
        const id = route.slice('/drive/v1/files/'.length).split('?')[0] ?? '';
        if (id === 'doc_bad') { return Promise.reject(new Error('没有权限')); }
        deleted.push(id);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    download: () => Promise.reject(new Error('unexpected')),
  };
  const remove = doc.createDocRemover(doc.createDocPublisher(api));
  const report = await remove(['doc_a', 'doc_bad', 'doc_b']);
  test.expect(deleted).toEqual(['doc_a', 'doc_b']);
  test.expect(report).toContain('已放进回收站 2 篇');
  test.expect(report).toContain('删不掉 1 篇');
  test.expect(report).toContain('doc_bad');
});

test.test('工具层：feishu_doc_delete 把文档 ID 原样交下去，空列表报错', async () => {
  const seen: string[][] = [];
  const store = events.openEventStore(':memory:');
  const context = {
    workDir: '.', sessionId: 's1', store, execTimeoutMs: 1000, runtimeDir: '.',
    chatDeleteDoc: (ids: string[]) => { seen.push(ids); return Promise.resolve('ok'); },
  } as unknown as tools.ToolContext;
  await tools.runTool('feishu_doc_delete', { documents: [' doc_a ', 'doc_b'] }, context);
  test.expect(seen[0]).toEqual(['doc_a', 'doc_b']);
  //G 空列表要挡住：不能一调就去删一堆东西。
  let refused = '';
  try { await tools.runTool('feishu_doc_delete', { documents: [] }, context); } catch (error) { refused = error instanceof Error ? error.message : String(error); }
  test.expect(refused).toContain('documents');
  store.close();
});
