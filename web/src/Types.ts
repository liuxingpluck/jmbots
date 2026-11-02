/**
 * 网页用的数据类型：知识库目录、文档摘要和文档全文。
 * 第 2 步接后端时，接口返回的数据也按这里的形状来。
 */


/** 知识库目录（对应数据库的 knowledge_bases 表）。 */
export interface KnowledgeBase {
  /** 目录 ID。 */
  id: number;
  /** 上级目录 ID；顶层目录为 null。 */
  parentId: number | null;
  /** 目录名。 */
  name: string;
  /** 在同一上级下的排列顺序，小的在前。 */
  position: number;
  /** 标签条件：只给“获取一下”找候选用，不决定目录里有哪些文档。 */
  tags: string[];
  /** 目录里保存的文档 ID（成员）；目录只列这些文档。 */
  memberIds: number[];
}


/** 文档列表里的一项，不含正文。 */
export interface DocumentSummary {
  /** 文档 ID。 */
  id: number;
  /** 标题。 */
  title: string;
  /** 第一段的纯文本摘要。 */
  summary: string;
  /** 文档标签，按保存时的顺序。 */
  tags: string[];
  /** 创建时间，毫秒时间戳。 */
  createdAt: number;
}


/** 一篇文档的全文。 */
export interface DocumentDetail extends DocumentSummary {
  /** 正文原文（Markdown）；骨架阶段按纯文本显示。 */
  content: string;
}
