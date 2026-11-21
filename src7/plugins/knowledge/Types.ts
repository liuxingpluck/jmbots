/**
 * 积木知识库（knowledge）领域模型、查询参数与 REST API 契约定义。
 * 三大原子：虚拟目录树（kb_dirs）、统一知识文档（kb_docs，可挂载工作决策 topicId）、多对多标签（kb_tags / kb_doc_tags）。
 */


//==========================================================
// 基础枚举与核心实体
//==========================================================

/** 知识文档来源分类：纯笔记、本地文件、网页摘录、音视频转写稿。 */
export type KnowledgeSourceType = 'note' | 'file' | 'url' | 'transcript';

/** 合法文档来源分类列表。 */
export const KNOWLEDGE_SOURCE_TYPES: readonly KnowledgeSourceType[] = [
  'note',
  'file',
  'url',
  'transcript',
];

/** 虚拟目录表（kb_dirs）单行结构。 */
export interface KnowledgeDir {
  /** 目录唯一标识。 */
  id: string;
  /** 父目录 ID；顶层根目录为 null。 */
  parentId: string | null;
  /** 目录显示名称。 */
  name: string;
  /** 同级排序权重（越小越靠前）。 */
  sortOrder: number;
  /** 创建毫秒时间戳。 */
  createdAt: number;
  /** 最近修改毫秒时间戳。 */
  updatedAt: number;
}

/** 目录树节点（带直接挂载文档计数与递归子节点）。 */
export interface KnowledgeDirNode extends KnowledgeDir {
  /** 直接归属该目录的文档数量。 */
  docCount: number;
  /** 已排序的子目录列表。 */
  children: KnowledgeDirNode[];
}

/** 知识文档列表摘要项（不含长正文，遵循「简介索引 → 按需读正文」）。 */
export interface KnowledgeDocSummary {
  /** 文档统一 ID（默认 YYYYMMDDHHmmssSSS + 3 小写字母）。 */
  id: string;
  /** 所在虚拟目录 ID；未归入目录为 null。 */
  dirId: string | null;
  /** 关联的工作决策台（/work-decision/）专题节点 ID；未关联为 null。 */
  topicId: string | null;
  /** 文档标题。 */
  title: string;
  /** 精简摘要（为空时创建阶段自动从正文提取）。 */
  summary: string;
  /** 原始文件或外部 URL 路径。 */
  sourcePath: string;
  /** 来源类型。 */
  sourceType: KnowledgeSourceType;
  /** 已绑定的标签名称列表（按字母序稳定排列）。 */
  tags: string[];
  /** 创建毫秒时间戳。 */
  createdAt: number;
  /** 最近修改毫秒时间戳。 */
  updatedAt: number;
}

/** 完整知识文档（含 Markdown 正文）。 */
export interface KnowledgeDoc extends KnowledgeDocSummary {
  /** 文档完整正文。 */
  content: string;
}


//==========================================================
// 写入入参、筛选与检索返回契约
//==========================================================

/** 新建目录入参。 */
export interface CreateDirInput {
  /** 可选自定义 ID；缺省自动生成。 */
  id?: string;
  /** 父目录 ID；顶层传 null 或省略。 */
  parentId?: string | null;
  /** 目录名称（非空）。 */
  name: string;
  /** 同级排序值（默认 0）。 */
  sortOrder?: number;
}

/** 更新目录入参。 */
export interface UpdateDirInput {
  /** 新父目录 ID（传 null 移回顶层）。 */
  parentId?: string | null;
  /** 新目录名称。 */
  name?: string;
  /** 新排序权重。 */
  sortOrder?: number;
}

/** 新建文档入参。 */
export interface CreateDocInput {
  /** 可选自定义 ID；缺省按统一格式生成。 */
  id?: string;
  /** 虚拟目录 ID。 */
  dirId?: string | null;
  /** 关联 /work-decision/ 专题节点 ID。 */
  topicId?: string | null;
  /** 文档标题（必填）。 */
  title: string;
  /** 摘要；省略时从正文自动生成简要导读。 */
  summary?: string;
  /** 正文内容。 */
  content?: string;
  /** 外部文件路径或链接。 */
  sourcePath?: string;
  /** 来源分类（默认 note）。 */
  sourceType?: KnowledgeSourceType;
  /** 标签数组（自动剥离前导 # 并去重）。 */
  tags?: string[];
}

/** 更新文档局部补丁入参。 */
export interface UpdateDocInput {
  /** 更新虚拟目录（传 null 清空目录归属）。 */
  dirId?: string | null;
  /** 更新关联专题节点 ID（传 null 取消专题挂载）。 */
  topicId?: string | null;
  /** 新标题。 */
  title?: string;
  /** 新摘要。 */
  summary?: string;
  /** 新正文。 */
  content?: string;
  /** 新来源路径。 */
  sourcePath?: string;
  /** 新来源分类。 */
  sourceType?: KnowledgeSourceType;
  /** 全量替换文档标签列表。 */
  tags?: string[];
  /** 编辑时看到的 updatedAt；传了且和库里的不一样，说明别处改过，回 409 不覆盖。不传不查。 */
  baseUpdatedAt?: number;
}

/** 文档分页与多维筛选条件。 */
export interface DocListFilter {
  /** 限定目录 ID（传 '__unassigned__' 只查未归目录文档）。 */
  dirId?: string;
  /** 限定关联专题节点 ID。 */
  topicId?: string;
  /** 限定包含指定标签名。 */
  tag?: string;
  /** 限定同时包含这些标签（交集；和 tag 合并去重，大小写不敏感）。 */
  tags?: string[];
  /** 标题/摘要/正文/标签关键词。 */
  q?: string;
  /** 每页上限（1..200，默认 50）。 */
  limit?: number;
  /** 分页偏移量（默认 0）。 */
  offset?: number;
  /** 列表项是否附带完整 content（默认 false）。 */
  includeContent?: boolean;
}

/** 标签聚合统计项。 */
export interface KnowledgeTagStat {
  /** 标签 ID。 */
  id: string;
  /** 标签名。 */
  name: string;
  /** 绑定该标签的文档总数。 */
  docCount: number;
}

/** 工作台专题挂载资料统计项。 */
export interface KnowledgeTopicStat {
  /** /work-decision/ 专题节点 ID。 */
  topicId: string;
  /** 挂载到该专题下的文档数量。 */
  docCount: number;
}

/** GET /api/knowledge/tree 响应结构。 */
export interface KnowledgeTreeResponse {
  /** 是否成功。 */
  ok: true;
  /** 树状目录列表。 */
  dirs: KnowledgeDirNode[];
  /** 扁平目录列表。 */
  flatDirs: KnowledgeDir[];
  /** 标签计数统计。 */
  tags: KnowledgeTagStat[];
  /** 各专题挂载资料统计。 */
  topics: KnowledgeTopicStat[];
  /** 库内文档总数。 */
  totalDocs: number;
  /** 未归入任何目录的文档数。 */
  unassignedDocs: number;
}

/** 本地知识库命中项。 */
export interface KnowledgeSearchHit extends KnowledgeDocSummary {
  /** 命中上下文片段。 */
  snippet: string;
  /** 相关性综合得分。 */
  score: number;
  /** 命中的字段列表。 */
  matchedIn: ('title' | 'summary' | 'content' | 'tag')[];
}

/** 从 memory 服务桥接融合的记忆命中片段。 */
export interface KnowledgeMemoryHit {
  /** 记忆来源（如 knowledge、card、channel）。 */
  source: string;
  /** 记忆条目编号。 */
  id: string;
  /** 片段标题。 */
  title: string;
  /** 命中文本摘要。 */
  snippet: string;
  /** 归一化得分。 */
  score: number;
  /** 时间戳（毫秒）。 */
  at: number;
  /** 原文引用定位符。 */
  ref: string;
}

/** GET /api/knowledge/search 响应结构。 */
export interface KnowledgeSearchResponse {
  /** 是否成功。 */
  ok: true;
  /** 查询词。 */
  query: string;
  /** 本地知识库命中列表。 */
  hits: KnowledgeSearchHit[];
  /** memory 插件与服务本次是否成功响应。 */
  memoryAvailable: boolean;
  /** 来自 memory 桥接的相关记忆命中（未挂载时为空数组）。 */
  memoryHits: KnowledgeMemoryHit[];
  /** memory 部分不可用时的温和说明（不阻塞主响应）。 */
  memoryWarning?: string;
}
