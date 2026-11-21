/**
 * 积木知识库模型只读检索工具（kb_search）。
 * 供前台（front）与后台干活会话（work）按关键词、专题节点 topicId、标签或目录查索引摘要，并支持按 docId 按需取完整正文。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as routesModule from './Routes.ts';
import type * as storeModule from './Store.ts';


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
