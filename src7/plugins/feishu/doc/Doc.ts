/**
 * 飞书云文档工具：feishu_doc 把工作区里的 Markdown 连同几张图发成飞书 docx，编辑权限给聊天里的用户，交回链接；
 * feishu_doc_delete 把文档放进回收站。照 0.4 的 src/channels/FeishuDoc.ts 和 src/capabilities/tools/Tools.ts。
 * 每个开放接口调用都过 Api.call（429 退让重试、错误码换中文）。这两个工具都很快结束，不用骨架的停止信号。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as lark from '@larksuiteoapi/node-sdk';
import type * as cordis from 'cordis';
import type { Session } from '../../../Sessions.ts';
import * as textModule from '../../../utils/Text.ts';
import * as workspaceModule from '../../../utils/Workspace.ts';
import * as api from '../Api.ts';
import type { Feishu, FeishuAddress } from '../index.ts';
import * as blocks from './Blocks.ts';


/** 一批最多插多少块（0.4 FeishuDoc.ts:262-268）。 */
const BATCH = 40;

/** 两批之间等多久，毫秒：飞书写接口有频率限制。 */
const PACE_MS = 250;

/** 建表格时最多几行几列；多的建好以后一行一列地追加。 */
const TABLE_CREATE_MAX = 9;

/** 文档链接的前缀。 */
const DOC_URL = 'https://feishu.cn/docx/';


/** SDK 插块接口要的 children 类型。 */
type Children = NonNullable<
  NonNullable<Parameters<lark.Client['docx']['v1']['documentBlockChildren']['create']>[0]>['data']
>['children'];


/** 发文档用哪个应用、权限给谁。 */
interface Target {
  /** 应用号。 */
  appId: string;
  /** SDK 客户端。 */
  client: lark.Client;
  /** 给谁编辑权限；没人就改成组织内可编辑。 */
  openId?: string;
}


/**
 * 登记两个工具。工具随本插件拔掉自动撤掉（Tools.register 挂在调用方 ctx 上）。
 * @param feishu 飞书渠道。
 * @param ctx 本插件的 ctx。
 */
export function setup(feishu: Feishu, ctx: cordis.Context): void {
  //M 向骨架注册发布飞书云文档模型工具，将 Markdown 与图片转为在线 docx 并授予会话方编辑权限。
  ctx.tools.register({
    definition: {
      name: 'feishu_doc',
      description: '把工作区里的一个 Markdown 文件发布成飞书云文档（支持标题、段落、列表、引用、代码块、表格），'
        + '可以带几张图片放在最前面。发布后可编辑权限给聊天里的用户，交回文档链接。',
      parameters: piAi.Type.Object({
        title: piAi.Type.String({ description: '文档标题' }),
        markdown: piAi.Type.String({ description: 'Markdown 文件路径，相对工作区' }),
        images: piAi.Type.Optional(piAi.Type.Array(piAi.Type.String(), { description: '放在文档最前面的图片路径，相对工作区' })),
      }),
    },
    sessionKinds: ['work'],
    run: (args, session) => publish(feishu, ctx, session, {
      title: args['title'] as string,
      markdown: args['markdown'] as string,
      images: (args['images'] as string[] | undefined) ?? [],
    }),
  });

  //M 向骨架注册删除飞书云文档模型工具，把指定 docToken 移入回收站。
  ctx.tools.register({
    definition: {
      name: 'feishu_doc_delete',
      description: '把应用自己建的飞书云文档放进回收站。参数是文档 ID（链接 /docx/ 后面那串）。',
      parameters: piAi.Type.Object({
        documents: piAi.Type.Array(piAi.Type.String(), { description: '文档 ID 列表' }),
      }),
    },
    sessionKinds: ['work'],
    run: (args, session) => remove(feishu, session, args['documents'] as string[]),
  });
}


/**
 * 发文档用哪个应用、权限给谁：飞书来的会话用它的应用、给发消息的人；别的用这个机器人第一个飞书应用、给最近私聊的人。
 * @param feishu 飞书渠道。
 * @param session 哪场会话调的工具。
 * @returns 应用、客户端、给谁权限。
 * @throws 这个机器人没配飞书应用时抛错。
 */
export function getTarget(feishu: Feishu, session: Session): Target {
  const row = session.row;
  const address = row.address as FeishuAddress | undefined;
  if (row.channel === 'feishu' && address !== undefined && typeof address.appId === 'string') {
    //M 当前会话来自飞书渠道时，沿用收信应用对应的 SDK 客户端并将文档权限授给发信本人。
    return { appId: address.appId, client: feishu.client(address.appId), openId: address.openId || undefined };
  }
  //M 非飞书会话（如网页或定时器）改取该机器人名下第一个飞书应用，并找最近私聊者授权。
  const appId = feishu.getApps(row.bot)[0];
  if (appId === undefined) {
    throw new Error('这个机器人没配飞书应用，发不了云文档');
  }
  //M 封装默认飞书应用客户端及最近私聊联系人 openId 作为授权目标。
  return { appId, client: feishu.client(appId), openId: feishu.lastPrivate(appId)?.openId };
}


/**
 * 工具参数里的路径落成绝对路径：去开头的 @ 和引号，相对这一轮的工作区（builder 说话时是他的目录，见 utils/Workspace.ts 的 getWorkspace）。
 * @param ctx 取机器人工作区和运行时目录。
 * @param session 哪场会话。
 * @param value 模型给的路径。
 * @returns 绝对路径。
 * @throws 指向运行时目录的 config.yaml（有密钥）时抛错。
 */
export function getFile(ctx: cordis.Context, session: Session, value: string): string {
  const cleaned = value.trim().replace(/^@/u, '').replace(/^["']|["']$/gu, '');
  //M 读取所属机器人配置工作区（缺失则回落默认 bots 工作区），再按角色地址收窄目录。
  const botWorkspace = ctx.bots.get(session.row.bot)?.workspace
    ?? ctx.resources.dir('bots', session.row.bot, 'workspace');
  const workspace = workspaceModule.getWorkspace(botWorkspace, session.row.address);
  const full = path.resolve(workspace, cleaned);
  if (full === path.join(ctx.resources.root, 'config.yaml')) {
    throw new Error('不能读 config.yaml');
  }
  return full;
}


/**
 * 发布一篇文档。
 * @param feishu 飞书渠道。
 * @param ctx 本插件的 ctx。
 * @param session 哪场会话调的。
 * @param args 标题、Markdown 路径、图片路径。
 * @returns 给模型看的一句话：标题、链接、权限给了谁。
 * @throws 标题空、文件读不到、接口出错时抛错（骨架交给模型看）。
 */
export async function publish(
  feishu: Feishu,
  ctx: cordis.Context,
  session: Session,
  args: { title: string; markdown: string; images: string[] },
): Promise<string> {
  const title = args.title.trim();
  if (title === '') {
    throw new Error('标题不能是空的');
  }
  //M 解析目标飞书客户端并换算会话对应的授权用户 openId。
  const { client, openId } = getTarget(feishu, session);
  //M 解析工作区 Markdown 路径并读取正文内容。
  const markdownPath = getFile(ctx, session, args.markdown);
  const text = fs.readFileSync(markdownPath, 'utf8');
  //M 逐个解析前置图片在工作区中的绝对路径并检查全部存在。
  const images = args.images.map((item) => {
    //M 解析单张前置图片在工作区中的路径。
    return getFile(ctx, session, item);
  });
  for (const image of images) {
    if (!fs.existsSync(image)) throw new Error(`图片不存在：${image}`);
  }

  //T 跟踪：发布飞书云文档。
  const vars = { 会话: session.id, 标题: title, 图片几张: images.length, 字数: text.length };
  ctx.emit('trace', 'Doc.publish', '把 Markdown 发布成飞书云文档', 'client.docx.v1.document.create(...)', vars);

  //M 带限流重试创建空白飞书云文档并拿到新文档 ID。
  const created = await api.call('云文档建文档', () => client.docx.v1.document.create({ data: { title } }));
  const docId = created.data?.document?.document_id;
  if (docId === undefined || docId === '') {
    throw new Error('飞书建文档成功但没有交回文档号');
  }

  //M 图片放最前面，一张一块。
  let index = 0;
  for (const image of images) {
    await insertImage(client, docId, image, index);
    index++;
    await Bun.sleep(PACE_MS);
  }

  //M 别的块攒着，满 40 个插一批；遇到表格先把攒着的插完，再单独建表格。
  let pending: blocks.Block[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await insert(client, docId, docId, pending, index);
    index += pending.length;
    pending = [];
    await Bun.sleep(PACE_MS);
  };
  //M 把 Markdown 拆解为抽象节点流：表格节点单独冲刷建表，其余节点批量转块并按 40 块上限提交。
  for (const node of blocks.parse(text)) {
    if (node.kind === 'table') {
      await flush();
      await insertTable(client, docId, node.rows, index);
      index++;
      continue;
    }
    //M 将非表格节点展开为飞书块结构追加进缓冲队列，满批立即提交。
    pending.push(...blocks.toBlocks(node));
    if (pending.length >= BATCH) await flush();
  }
  //M 冲刷末尾未满一批的剩余文档块，确保全文落盘。
  await flush();

  //M 权限：有人给这个人编辑权限；没人改成组织内可编辑。没给成写进结果，不算失败。
  let granted: string;
  try {
    //M 为刚建成的云文档授个人或组织内可编辑权限。
    granted = await grantAccess(client, docId, openId);
  } catch (error) {
    granted = `权限没给成：${textModule.getMessage(error)}`;
  }
  return `已发布飞书文档《${title}》：${DOC_URL}${docId}（${granted}）`;
}


/**
 * 给刚发布的云文档赋编辑权限：能认出具体聊过天的用户给个人可编辑，否则改组织内可编辑。
 * @param client SDK 客户端。
 * @param docId 文档号。
 * @param openId 授权用户的 open_id；没有则是 undefined。
 * @returns 给模型看的权限结果说明。
 */
async function grantAccess(client: lark.Client, docId: string, openId: string | undefined): Promise<string> {
  if (openId !== undefined) {
    //M 聊天里有明确用户时，直接授予该用户云文档可编辑权限（full_access）。
    await api.call('云文档给权限', () => client.drive.v1.permissionMember.create({
      params: { type: 'docx', need_notification: false },
      path: { token: docId },
      data: { member_type: 'openid', member_id: openId, perm: 'full_access' },
    }));
    return '可编辑权限已给聊天里的用户';
  }

  //M 无具体对话人可授时回退设置组织内获得链接可编辑，避免文档无人打得开。
  await api.call('云文档改公开范围', () => client.drive.v1.permissionPublic.patch({
    params: { type: 'docx' },
    path: { token: docId },
    data: { link_share_entity: 'tenant_editable' },
  }));
  return '还没人私聊过机器人，改成了组织内可编辑';
}


/**
 * 插一批块。
 * @param client SDK 客户端。
 * @param docId 文档号。
 * @param parentId 插在哪个块下面（文档根块号就是文档号；表格单元格号）。
 * @param list 块。
 * @param index 插在第几个位置。
 * @returns 新块的块号，照先后。
 */
async function insert(
  client: lark.Client,
  docId: string,
  parentId: string,
  list: blocks.Block[],
  index: number,
): Promise<string[]> {
  //M 带限流重试往文档根或表格单元格下的指定索引插入一批块，并提取新生成块 ID。
  const inserted = await api.call('云文档插块', () => client.docx.v1.documentBlockChildren.create({
    path: { document_id: docId, block_id: parentId },
    data: { children: list as unknown as Children, index },
  }));
  return (inserted.data?.children ?? []).map((item) => item.block_id ?? '');
}


/**
 * 插一张图：先插空图片块，传图到这个块，再把图换上去（replace_image）。
 * @param client SDK 客户端。
 * @param docId 文档号。
 * @param image 图片的绝对路径。
 * @param index 插在第几个位置。
 */
async function insertImage(client: lark.Client, docId: string, image: string, index: number): Promise<void> {
  //M 先占位插入一个空图片块，以拿回供素材上传绑定的 blockId。
  const [blockId = ''] = await insert(client, docId, docId, [{ block_type: blocks.BLOCK.image, image: {} }], index);
  if (blockId === '') {
    throw new Error('飞书建图片块成功但没有交回块号');
  }
  const data = fs.readFileSync(image);
  //M 将本地图片流绑定该图片块 ID 上传至云文档媒体库，换回 file_token。
  const uploaded = await api.call('云文档传图', () => client.drive.v1.media.uploadAll({
    data: {
      file_name: path.basename(image),
      parent_type: 'docx_image',
      parent_node: blockId,
      size: data.length,
      file: data,
    },
  }));
  const token = uploaded?.file_token;
  if (token === undefined || token === '') {
    throw new Error('飞书传图成功但没有交回 file_token');
  }
  //M 调用块更新接口执行 replace_image，将刚上传的素材正式挂进该空图片块。
  await api.call('云文档换图', () => client.docx.v1.documentBlock.patch({
    path: { document_id: docId, block_id: blockId },
    params: { document_revision_id: -1 },
    data: { replace_image: { token } },
  }));
}


/**
 * 插一个表格：最多 9×9 建，多的一行一列追加；取回表格块拿单元格号，逐格填字。
 * @param client SDK 客户端。
 * @param docId 文档号。
 * @param rows 表格内容，第一行是表头。
 * @param index 插在第几个位置。
 */
async function insertTable(client: lark.Client, docId: string, rows: string[][], index: number): Promise<void> {
  const columns = Math.max(...rows.map((row) => row.length));
  const grid = rows.map((row) => Array.from({ length: columns }, (_, column) => row[column] ?? ''));
  const createRows = Math.min(grid.length, TABLE_CREATE_MAX);
  const createColumns = Math.min(columns, TABLE_CREATE_MAX);
  const table: blocks.Block = {
    block_type: blocks.BLOCK.table,
    table: {
      property: {
        row_size: createRows,
        column_size: createColumns,
        column_width: Array.from({ length: createColumns }, () => Math.floor(700 / columns)),
        header_row: true,
      },
    },
  };
  //M 在限定 9×9 上限内创建初始表格骨架块，取回 tableId 供后续扩充行列与填格。
  const [tableId = ''] = await insert(client, docId, docId, [table], index);
  if (tableId === '') {
    throw new Error('飞书建表格成功但没有交回块号');
  }

  //M 多的行列一次追加一个到末尾（-1 是末尾）。
  const where = { path: { document_id: docId, block_id: tableId }, params: { document_revision_id: -1 } };
  for (let added = createRows; added < grid.length; added++) {
    const rowPatch = { ...where, data: { insert_table_row: { row_index: -1 } } };
    await api.call('云文档加行', () => client.docx.v1.documentBlock.patch(rowPatch));
    await Bun.sleep(PACE_MS);
  }
  for (let added = createColumns; added < columns; added++) {
    const columnPatch = { ...where, data: { insert_table_column: { column_index: -1 } } };
    await api.call('云文档加列', () => client.docx.v1.documentBlock.patch(columnPatch));
    await Bun.sleep(PACE_MS);
  }

  //M 单元格飞书自己建好；只取这个表格块，按 children 的先后（逐行逐列）填字。
  const fetched = await api.call('云文档取表格', () => client.docx.v1.documentBlock.get(where));
  const block = fetched.data?.block;
  const cellValues = block?.children ?? block?.table?.cells ?? [];
  const cells = cellValues.filter((value): value is string => typeof value === 'string');
  if (cells.length < grid.length * columns) {
    throw new Error(`飞书表格只交回了 ${String(cells.length)} 个单元格，少于 ${String(grid.length)}×${String(columns)}`);
  }
  for (const [row, line] of grid.entries()) {
    for (const [column, text] of line.entries()) {
      const cellId = cells[row * columns + column];
      if (text === '' || cellId === undefined) continue;
      await insert(client, docId, cellId, blocks.toBlocks({ kind: 'paragraph', text }), 0);
      await Bun.sleep(PACE_MS);
    }
  }
}


/**
 * 删文档（进回收站）：逐篇删，成功、失败分开记，拼一句。
 * @param feishu 飞书渠道。
 * @param session 哪场会话调的。
 * @param documents 文档号。
 * @returns 给模型看的一句话。
 * @throws 没给文档号、这个机器人没配飞书应用时抛错。
 */
export async function remove(feishu: Feishu, session: Session, documents: string[]): Promise<string> {
  const ids = documents.map((item) => item.trim().replace(/^.*\/docx\//u, '')).filter((item) => item !== '');
  if (ids.length === 0) {
    throw new Error('要给至少一个文档 ID');
  }
  //M 从当前会话解析飞书 SDK 客户端，逐个调用删除接口把云文档移入回收站。
  const { client } = getTarget(feishu, session);
  const done: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      //M 通过 drive 删除接口软删云文档（进回收站），分流收集成功与失败清单。
      const deleteArgs = { path: { file_token: id }, params: { type: 'docx' } } as const;
      await api.call('云文档删除', () => client.drive.v1.file.delete(deleteArgs));
      done.push(id);
    } catch (error) {
      failed.push(`${id}（${textModule.getMessage(error)}）`);
    }
  }
  const parts: string[] = [];
  if (done.length > 0) parts.push(`已放进回收站 ${String(done.length)} 篇：${done.join('、')}`);
  if (failed.length > 0) parts.push(`删不掉 ${String(failed.length)} 篇：${failed.join('、')}`);
  return parts.join('；');
}
