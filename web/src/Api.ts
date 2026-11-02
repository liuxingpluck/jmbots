/**
 * 网页取数据的唯一入口：目录、文档摘要、文档全文。
 * 第 1 步先返回写死的假数据，只用来看布局。第 2 步换成请求后端（接口见 docs/重写/01_知识库骨架方案.md 第 5 节），
 * 函数的参数和返回值不变，组件不用改。
 */
import type { DocumentDetail, DocumentSummary, KnowledgeBase } from './Types.ts';


/** 假数据的时间基准：2026-10-29 10:00（北京时间），各篇文档在它前后错开。 */
const BASE_TIME = Date.parse('2026-10-29T10:00:00+08:00');
/** 一小时的毫秒数，用来错开假文档的时间。 */
const HOUR = 60 * 60 * 1000;

/** 假目录：两个顶层目录，“理解 JMAI”下面带一个子目录。 */
const FAKE_BASES: KnowledgeBase[] = [
  { id: 1, parentId: null, name: '理解 JMAI', position: 0, tags: ['JMAI 指南'], memberIds: [1, 2, 3] },
  { id: 2, parentId: 1, name: '服务端', position: 0, tags: ['服务端'], memberIds: [3] },
  { id: 3, parentId: null, name: '任务产出', position: 1, tags: [], memberIds: [4] },
];

/** 假文档：每篇带好摘要和正文。 */
const FAKE_DOCUMENTS: DocumentDetail[] = [
  {
    id: 1,
    title: '一页看懂 JMAI',
    summary: 'JMAI 是一个单用户的 Agent 系统：在对话里提出要求，结果和依据都留在知识库里。',
    tags: ['JMAI', '指南'],
    createdAt: BASE_TIME,
    content:
      '（这是第 1 步骨架用的假数据。）\n\nJMAI 是一个单用户的 Agent 系统。你在对话里提出要求，它在后台完成任务，产出的文件核实过后进入知识库。\n\n知识库按目录整理：目录只列你保存进去的文档；目录上的标签条件只用来“获取一下”找候选，不会自动改动目录。',
  },
  {
    id: 2,
    title: '怎么用',
    summary: '左边选目录，中间看这个目录里的文档，点一篇在右边看正文。',
    tags: ['JMAI', '指南'],
    createdAt: BASE_TIME - 2 * HOUR,
    content:
      '（假数据）\n\n1. 左边选目录，中间列出这个目录保存的文档。\n2. 点一篇文档，右边显示正文。\n3. 顶栏的搜索框按标题过滤文档。',
  },
  {
    id: 3,
    title: '服务端怎么组织',
    summary: '服务端用 Bun + Fastify + SQLite；第 1 步只托管网页和 /api/health。',
    tags: ['服务端'],
    createdAt: BASE_TIME - 26 * HOUR,
    content:
      '（假数据）\n\n服务端用 Bun + Fastify + SQLite。第 1 步只托管网页和 /api/health，知识库接口在第 2 步加，每个模块在 Main.ts 里一句注册。',
  },
  {
    id: 4,
    title: '任务产出：周报草稿',
    summary: '本周完成知识库骨架和旧代码备份，下周接入真数据。',
    tags: ['任务产出'],
    createdAt: BASE_TIME + 3 * HOUR,
    content: '（假数据）\n\n本周完成：知识库骨架、旧代码备份。\n下周计划：接入真数据。',
  },
];


/** 取全部目录。第 1 步返回假数据。 */
export function loadBases(): Promise<KnowledgeBase[]> {
  return Promise.resolve(FAKE_BASES);
}


/** 取全部文档的摘要（不含正文）。第 1 步返回假数据。 */
export function loadDocuments(): Promise<DocumentSummary[]> {
  // m: 列表只要摘要，不带正文，和第 2 步后端返回的形状一致。
  return Promise.resolve(
    FAKE_DOCUMENTS.map((detail) => ({
      id: detail.id,
      title: detail.title,
      summary: detail.summary,
      tags: detail.tags,
      createdAt: detail.createdAt,
    })),
  );
}


/** 取一篇文档的全文；没有这篇时返回 null。第 1 步返回假数据。 */
export function loadDocument(documentId: number): Promise<DocumentDetail | null> {
  return Promise.resolve(FAKE_DOCUMENTS.find((detail) => detail.id === documentId) ?? null);
}
