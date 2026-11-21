/**
 * 积木知识库的模型工具：
 *   kb_search（只读）：按关键词、专题节点 topicId、标签或目录查索引摘要，按 docId 取完整正文；
 *   kb_save（写，1.0.2）：新建文档，或往已有文档追加、替换正文（替换要带 baseUpdatedAt 走乐观锁）。
 * 两个都给前台（front）与后台（work）；外人那一轮由 approval 的只读白名单挡掉，kb_save 执行时再核一次本人。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as channelProtocol from '../channels/index.ts';
import * as routesModule from './Routes.ts';
import * as storeModule from './Store.ts';
import type * as types from './Types.ts';


const KB_SEARCH_PARAMETERS = piAi.Type.Object({
  query: piAi.Type.Optional(piAi.Type.String({ description: '检索关键词（匹配标题、摘要、正文与标签）' })),
  topicId: piAi.Type.Optional(piAi.Type.String({ description: '按工作决策台专题节点 ID 查挂载资料' })),
  tag: piAi.Type.Optional(piAi.Type.String({ description: '按标签名筛选（如 AOBB）' })),
  dirId: piAi.Type.Optional(piAi.Type.String({ description: '按虚拟目录 ID 筛选' })),
  docId: piAi.Type.Optional(piAi.Type.String({ description: '按文档 ID 读取单篇完整正文' })),
  limit: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, maximum: 20, description: '返回条数上限（默认 8）' })),
});


/** 读取参数中的去空白字符串。 */
function readArgText(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val === 'string') return val.trim();

  return '';
}


/** 格式化知识库总览（无筛选参数时返回目录、标签与专题概览）。 */
function formatTreeOverview(store: storeModule.KnowledgeStore): string {
  const tree = store.getTree();
  const lines = [`积木知识库共 ${String(tree.totalDocs)} 篇文档（未归目录 ${String(tree.unassignedDocs)} 篇）。`];

  if (tree.flatDirs.length > 0) {
    const dirsText = tree.flatDirs.slice(0, 15).map((d) => `${d.name}(${d.id})`).join('、');
    lines.push(`虚拟目录：${dirsText}`);
  }
  if (tree.tags.length > 0) {
    const tagsText = tree.tags.slice(0, 15).map((t) => `#${t.name}(${String(t.docCount)})`).join(' ');
    lines.push(`常用标签：${tagsText}`);
  }
  if (tree.topics.length > 0) {
    const topicsText = tree.topics.slice(0, 15).map((tp) => `${tp.topicId}(${String(tp.docCount)}篇)`).join('、');
    lines.push(`已挂资料专题：${topicsText}`);
  }
  lines.push('请传 query、topicId、tag 或 dirId 检索文档摘要，拿到 ID 后传 docId 读取正文。');
  return lines.join('\n');
}


/**
 * 注册只读工具 kb_search。
 * @param ctx 插件上下文。
 * @param store 知识库存储实例。
 */
export function registerKbSearchTool(
  ctx: cordis.Context,
  store: storeModule.KnowledgeStore,
): void {
  ctx.tools.register({
    definition: {
      name: 'kb_search',
      description: '检索积木知识库资料：支持按关键词 query、工作决策专题 topicId、标签 tag 或虚拟目录 dirId 查文档摘要索引，或传 docId 读取单篇完整正文。',
      parameters: KB_SEARCH_PARAMETERS,
    },
    sessionKinds: ['front', 'work'],
    async run(args) {
      const docId = readArgText(args, 'docId');
      if (docId !== '') {
        const doc = store.getDoc(docId);
        if (doc === undefined) return `未找到知识库文档：${docId}`;

        const metaLines = [
          `# ${doc.title}`,
          `- ID: ${doc.id}`,
          `- 来源类型: ${doc.sourceType}`,
        ];
        if (doc.dirId !== null) {
          metaLines.push(`- 目录: ${doc.dirId}`);
        }
        if (doc.topicId !== null) {
          metaLines.push(`- 关联专题: ${doc.topicId}`);
        }
        if (doc.tags.length > 0) {
          metaLines.push(`- 标签: ${doc.tags.map((t) => `#${t}`).join(' ')}`);
        }
        if (doc.sourcePath !== '') {
          metaLines.push(`- 来源路径: ${doc.sourcePath}`);
        }
        if (doc.summary !== '') {
          metaLines.push(`- 摘要: ${doc.summary}`);
        }
        return `${metaLines.join('\n')}\n\n${doc.content}`;
      }

      const query = readArgText(args, 'query');
      const topicId = readArgText(args, 'topicId');
      const tag = readArgText(args, 'tag');
      const dirId = readArgText(args, 'dirId');
      if (query === '' && topicId === '' && tag === '' && dirId === '') {
        return formatTreeOverview(store);
      }

      let limit = 8;
      if (typeof args['limit'] === 'number' && Number.isFinite(args['limit'])) {
        limit = Math.min(20, Math.max(1, Math.trunc(args['limit'])));
      }

      let optDir: string | undefined;
      if (dirId !== '') {
        optDir = dirId;
      }
      let optTopic: string | undefined;
      if (topicId !== '') {
        optTopic = topicId;
      }
      let optTag: string | undefined;
      if (tag !== '') {
        optTag = tag;
      }

      const hits = store.searchLocal(query, {
        dirId: optDir,
        topicId: optTopic,
        tag: optTag,
        limit,
      });

      let memHitsCount = 0;
      const outLines: string[] = [];
      for (let i = 0; i < hits.length; i += 1) {
        const hit = hits[i]!;
        let badges = `[${hit.sourceType}]`;
        if (hit.topicId !== null) {
          badges += ` [专题:${hit.topicId}]`;
        }
        if (hit.tags.length > 0) {
          badges += ` ${hit.tags.map((t) => `#${t}`).join(' ')}`;
        }
        const preview = hit.summary || hit.snippet;
        outLines.push(`${String(i + 1)}. [docId=${hit.id}] ${hit.title} ${badges}\n   ${preview}`);
      }

      //M 有关键词时温和询问记忆服务的公共知识库通道，未挂载时零报错跳过。
      if (query !== '') {
        const mem = await routesModule.searchMemoryBridge(ctx, query, Math.min(4, limit), 'knowledge');
        for (const mHit of mem.hits) {
          memHitsCount += 1;
          outLines.push(`M${String(memHitsCount)}. [memory:${mHit.ref}] ${mHit.title}\n   ${mHit.snippet}`);
        }
      }

      if (outLines.length === 0) return '未在知识库中找到匹配的资料。';

      const header = `命中知识库文档 ${String(hits.length)} 篇（需看全文请传 docId 再调 kb_search）：`;
      return `${header}\n${outLines.join('\n')}`;
    },
  });
}


//==========================================================
// kb_save：模型写入知识库（1.0.2）
//==========================================================

/** kb_save 一次最多带几个标签。 */
const SAVE_MAX_TAGS = 20;

const KB_SAVE_PARAMETERS = piAi.Type.Object({
  docId: piAi.Type.Optional(piAi.Type.String({ description: '要更新的文档 ID；不传就新建一篇' })),
  title: piAi.Type.Optional(piAi.Type.String({ description: '标题；新建时必填' })),
  content: piAi.Type.Optional(piAi.Type.String({ description: '正文 Markdown；新建时必填，更新时按 mode 追加或替换' })),
  mode: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('append'), piAi.Type.Literal('replace')], {
    description: '更新时：append 接在原正文后面（默认，不会盖掉原文）；replace 整篇替换，必须带 baseUpdatedAt',
  })),
  baseUpdatedAt: piAi.Type.Optional(piAi.Type.Integer({ description: 'replace 时必填：读文档时看到的 updatedAt' })),
  summary: piAi.Type.Optional(piAi.Type.String({ description: '摘要；不传按正文自动生成' })),
  tags: piAi.Type.Optional(piAi.Type.Array(piAi.Type.String(), { description: '标签（不能带逗号，最多 20 个）' })),
  dirId: piAi.Type.Optional(piAi.Type.String({ description: '虚拟目录 ID' })),
  topicId: piAi.Type.Optional(piAi.Type.String({ description: '工作决策台专题节点 ID' })),
  sourceType: piAi.Type.Optional(piAi.Type.String({ description: '来源：note（默认）、file、url、transcript' })),
});


/**
 * 查标签：照 normalizeTags 的规矩（去 #、去重、不能带逗号），再限最多 SAVE_MAX_TAGS 个。
 * @param raw 模型给的标签。
 * @returns 规范后的标签；没给是 undefined（更新时不动标签）。
 */
function readSaveTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;

  const tags = storeModule.normalizeTags(raw as string[]);
  if (tags.length > SAVE_MAX_TAGS) {
    throw new Error(`标签最多 ${String(SAVE_MAX_TAGS)} 个`);
  }
  return tags;
}


/**
 * 写好以后交给模型的一段话：ID、标题、摘要、目录、专题、标签、updatedAt（下次 replace 要用）。
 * @param action 新建还是更新。
 * @param doc 写好的文档。
 * @returns 文字。
 */
function formatSaved(action: string, doc: types.KnowledgeDoc): string {
  const lines = [
    `已${action}知识库文档：docId=${doc.id}`,
    `- 标题: ${doc.title}`,
    `- 摘要: ${doc.summary}`,
    `- updatedAt: ${String(doc.updatedAt)}（下次整篇替换时作 baseUpdatedAt）`,
  ];
  if (doc.dirId !== null) {
    lines.push(`- 目录: ${doc.dirId}`);
  }
  if (doc.topicId !== null) {
    lines.push(`- 关联专题: ${doc.topicId}`);
  }
  if (doc.tags.length > 0) {
    lines.push(`- 标签: ${doc.tags.map((tag) => `#${tag}`).join(' ')}`);
  }
  return lines.join('\n');
}


/**
 * 执行 kb_save。
 * @param store 知识库存储。
 * @param args 模型给的参数（Tools.ts 已按定义校验过形状）。
 * @param session 调用的会话。
 * @returns 给模型看的话。
 * @throws 不是本人、参数不对、文档不存在、目录不存在、乐观锁冲突时抛错，原因给模型看。
 */
function runKbSave(store: storeModule.KnowledgeStore, args: Record<string, unknown>, session: Session): string {
  //G approval 已经按只读白名单把外人挡在外面；没挂 approval 时这里再核一次：只有本人能写知识库。
  if (!channelProtocol.isOwnerTurn(session.row.channel, session.row.address)) {
    throw new Error('只有本人能写知识库');
  }

  const docId = readArgText(args, 'docId');
  const content = readArgText(args, 'content');
  const tags = readSaveTags(args['tags']);
  const patch: types.UpdateDocInput = {};
  const title = readArgText(args, 'title');
  if (title !== '') {
    patch.title = title;
  }
  if (typeof args['summary'] === 'string') {
    patch.summary = args['summary'];
  }
  if (tags !== undefined) {
    patch.tags = tags;
  }
  if (typeof args['dirId'] === 'string') {
    patch.dirId = args['dirId'];
  }
  if (typeof args['topicId'] === 'string') {
    patch.topicId = args['topicId'];
  }
  if (typeof args['sourceType'] === 'string') {
    patch.sourceType = args['sourceType'] as types.KnowledgeSourceType;
  }

  //M 没给 docId：新建，标题和正文都要有。
  if (docId === '') {
    if (title === '' || content === '') {
      throw new Error('新建文档要写 title 和 content');
    }
    const created = store.createDoc({ ...patch, title, content });
    return formatSaved('新建', created);
  }

  const existing = store.getDoc(docId);
  if (existing === undefined) {
    throw new Error(`知识库里没有这篇：${docId}`);
  }

  //M replace：整篇替换，必须带读文档时看到的 updatedAt，过期就不覆盖。
  if (args['mode'] === 'replace') {
    if (typeof args['baseUpdatedAt'] !== 'number') {
      throw new Error(`整篇替换要带 baseUpdatedAt（这篇现在的 updatedAt 是 ${String(existing.updatedAt)}）`);
    }
    try {
      const replaced = store.updateDoc(docId, { ...patch, content, baseUpdatedAt: args['baseUpdatedAt'] });
      return formatSaved('替换', replaced);
    } catch (error) {
      if (!(error instanceof storeModule.KnowledgeConflictError)) throw error;

      const latest = String(error.doc.updatedAt);
      throw new Error(`这篇在别处改过了，没有覆盖（最新 updatedAt 是 ${latest}）。先用 kb_search 读最新正文再决定。`);
    }
  }

  //M append（默认）：新内容用空行接在原正文后面，原文一个字不动；顺带用读到的 updatedAt 防和别处同时写。
  let merged = existing.content;
  if (content !== '' && merged.trim() !== '') {
    merged = `${merged}\n\n${content}`;
  }
  if (content !== '' && existing.content.trim() === '') {
    merged = content;
  }
  try {
    const appended = store.updateDoc(docId, { ...patch, content: merged, baseUpdatedAt: existing.updatedAt });
    return formatSaved('追加到', appended);
  } catch (error) {
    if (!(error instanceof storeModule.KnowledgeConflictError)) throw error;

    throw new Error(`这篇刚被别处改过（最新 updatedAt 是 ${String(error.doc.updatedAt)}），请重试。`);
  }
}


/**
 * 注册写工具 kb_save。
 * @param ctx 插件上下文。
 * @param store 知识库存储实例。
 */
export function registerKbSaveTool(
  ctx: cordis.Context,
  store: storeModule.KnowledgeStore,
): void {
  ctx.tools.register({
    definition: {
      name: 'kb_save',
      description: '往积木知识库写资料：不传 docId 新建一篇（要 title、content）；传 docId 默认把 content 追加到原文后面，'
        + 'mode=replace 才整篇替换（要带 baseUpdatedAt）。可同时改标题、摘要、标签、目录、专题。',
      parameters: KB_SAVE_PARAMETERS,
    },
    sessionKinds: ['front', 'work'],
    run(args, session) {
      return runKbSave(store, args, session);
    },
  });
}
